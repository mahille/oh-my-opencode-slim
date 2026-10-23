# Preset Switching

Switch agent model presets at runtime using the `/preset` TUI slash command.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete an existing preset, or create a new one |
| 2. Agent arrangement | Choose a Base preset, add / remove / edit local agents, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> `/preset` is a TUI-only slash command (like `/models`). On v1 hosts invoke
> it via autocomplete selection or a keybind — typing `/preset` + Enter does
> not open the manager (same design as `/models`), and it takes no name
> argument.
>
> On v2 hosts, typing `/preset` + Enter opens the same three-level manager,
> and the sidebar's active-preset row opens it on click. `/preset <name>`
> stays the fast path: it persists the named preset and requests the live
> refresh directly, no dialogs needed.

## Per-session model state (opt-in)

On OpenCode v2, enable conversation-owned model state explicitly:

```jsonc
{
  "sessionModelState": true
}
```

The default is `false`. When disabled or omitted, `/preset` and config edits
refresh global inference defaults: new children across conversations use the
latest preset, existing children retain their captured profiles, and the
sidebar follows global models. No per-conversation markers or bindings are
created or consumed, and stale bindings from a previous enabled run are ignored.

When enabled, the conversation isolation described below applies. The global
config watcher runs in **both** modes; this flag does not disable live refresh.
The mode is captured at startup: restart the background service and all TUIs
after changing it. On v1 hosts, this flag does not change preset behavior.

## How It Works When Enabled

1. Define named presets in `oh-my-opencode-slim.jsonc` under the `presets`
   field, or create them interactively from the manager
2. **Save** writes the preset definition without changing a conversation's
   selection. **Apply** and **Save & Apply** also select the preset and publish
   a request for the conversation where the manager was opened
3. On v2 hosts each conversation owns an inference snapshot: per-agent
   `model`, `variant`, `temperature`, `options`, full fallback chains, and its
   sidebar projection. The TUI captures its initial selection, and attaching
   initializes an unbound conversation. Later prompts and navigation reuse
   that snapshot; they do **not** reread the shared active preset
4. An explicit Apply updates only the targeted conversation's snapshot for
   **future child sessions**. The request carries its selected configuration,
   so another TUI's subsequent config write cannot retarget it. Prompt
   admission consumes pending requests before child capture; correctness does
   not depend on the filesystem watcher's debounce
5. New children capture their parent's snapshot before their first request.
   Existing and resumed children keep their captured inference fields and
   fallback chains; their own descendants inherit that same snapshot. The
   root's running model is not switched. All non-inference fields (`prompt`,
   `tools`, `permission`, `skills`, `mcps`, `description`, `displayName`) remain
   frozen until a full reload
6. The config watcher updates global defaults for unbound conversations, not
   snapshots already owned by other conversations. Manual config edits do not
   silently switch those conversations: explicitly Apply the preset there.

Two TUIs viewing the **same session ID** share one conversation and therefore
one selection. Use separate conversations for independent model lineups.

### Known startup limitation

With `"sessionModelState": true`, isolation is verified for conversations already
bound to their TUI selection.
If TUI B remains on Home without a conversation while TUI A applies a preset,
B's first conversation can still inherit A's persisted selection. This startup
case remains unfixed; merely starting B before A switches is not sufficient.

The TUI reports `Saved … Live refresh requested` on success — it never claims
the refresh was applied. If the config file is malformed (invalid JSON,
schema rejection, read error), the refresh is rejected **before anything is
swapped**: the last-known-good profiles and sidebar stay in place and the
server logs the failure with its cause. A refresh request that fails in the
TUI process degrades to the actionable **reload OpenCode to apply**
fallback; if new child dispatches still use the old inference fields after a
malformed edit, fix the config and apply the preset again. A rejected refresh never
swaps profiles, never rewrites the sidebar, and never claims success.

`/preset` writes the selected preset name to the user config file as the default
for future TUIs. On v1 hosts, **reload OpenCode** after applying a preset. On v2,
the flag determines whether updates target one conversation or global future
child dispatches; neither mode replaces the host agent registry or switches the
running root's model.

## Editing inherited presets

At Level 2, select **Base preset** to choose one parent preset or **(none)**.
The manager prevents self-references and inheritance cycles. Inherited agents
are shown for context but are read-only. To change one, use **+ Add agent** to
create a local override, then edit it at Level 3.

Saving an inherited preset preserves its `extends` value and writes only its
local agent overrides; it does not flatten or copy inherited agents into the
child. With per-session state enabled, apply the selected preset again to use a
base preset edit in an already-bound v2 conversation; other conversations retain
their captured definitions. With the flag disabled, edits refresh global defaults
for new children automatically.
A base preset with dependents cannot be
deleted until those children choose another base or clear inheritance.

### Level 3 — model and variant selection

The model picker lists every model from all connected providers (fetched from
the server's provider registry). If the chosen model exposes variants (e.g.
`thinking`, `high`, `low`), a variant picker follows — this is the "thinking
strength" selector. Temperature is a numeric prompt (0–2 or blank). Options is
a raw JSON prompt for provider-specific settings (e.g.
`{"thinking":{"type":"enabled","budgetTokens":10000}}`).

## Example Configuration

```jsonc
{
  "presets": {
    "cheap": {
      "orchestrator": { "model": "anthropic/claude-3.5-haiku" },
      "explorer": { "model": "openai/gpt-6-luna" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "orchestrator": { "model": "openai/gpt-6" },
      "oracle": { "model": "anthropic/claude-opus-4-6" }
    },
    "thinking": {
      "oracle": {
        "model": "anthropic/claude-sonnet-4-6",
        "variant": "thinking",
        "options": { "thinking": { "type": "enabled", "budgetTokens": 10000 } }
      }
    }
  }
}
```

## Supported Fields

On v2 hosts the global watcher resolves the fields below in both modes. With
`"sessionModelState": true`, explicit Apply also updates the targeted
conversation's snapshot without replacing other bound snapshots. When disabled,
new children use the latest globally refreshed state. Only inference fields apply
to **new child sessions** (captured before their first request) plus the sidebar;
every other preset field applies after a full OpenCode reload. A
malformed config keeps the last-known-good profiles and sidebar (the refresh
is rejected, not applied):

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format. Array form captures both the first entry and the full fallback chain with the conversation snapshot. Existing children keep their captured chains. Removing a marketplace agent's override reverts new children to the package's own chain |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

The `extends` field is resolved when the preset is applied. Presets support
one parent only; multi-parent inheritance is not supported.

Frozen for the session lifetime — new child dispatches do **not** receive
these until a full OpenCode reload: `prompt`, `tools`, `permission`,
`skills`, `mcps`, `description`, `displayName`.

## Startup Preset vs Runtime Switching

There are two ways to activate a preset:

| Method | How | Persists? |
|--------|-----|-----------|
| Config file | Set `"preset": "cheap"` in `oh-my-opencode-slim.jsonc` | Yes, across restarts |
| `/preset` TUI command | Open the manager and apply a preset (v2: or the sidebar's preset row, or `/preset <name>`) | Yes — writes the future default; v2 updates the targeted conversation when `sessionModelState` is enabled, otherwise global state for new children. v1 hosts need a reload |

With `"sessionModelState": true`, the persisted selection is a default, not a
broadcast. A bound conversation's next prompt, sidebar poll, or navigation does
not adopt a preset selected elsewhere. Explicit Apply updates its future children
and sidebar projection. With the flag disabled or omitted, the persisted
selection refreshes global defaults used by new children across conversations.
Existing children retain their captured profiles and fallback chains in both
modes. Invalid configuration keeps last-known-good state; fix it and apply again.
On v1 hosts, **reload OpenCode** for the new preset to take effect on the registry.

## Offline isolation smoke test

With Bun, OpenCode v2 (`opencode2` on PATH), and tmux installed:

```sh
bun run build
OPENCODE_SMOKE_SESSION_MODEL_STATE=true bun scripts/verify-preset-session-isolation.ts
OPENCODE_SMOKE_SESSION_MODEL_STATE=false bun scripts/verify-preset-session-isolation.ts
OPENCODE_SMOKE_SESSION_MODEL_STATE=default bun scripts/verify-preset-session-isolation.ts
OPENCODE_SMOKE_ATTACH_ONLY=true bun scripts/verify-preset-session-isolation.ts
```

The smoke launches a private server and two actual TUI clients with isolated
HOME/XDG/config directories. A loopback provider records outbound model IDs;
no real provider credentials or paid requests are used. With the feature enabled,
it verifies that B's new children stay isolated after A switches. With the flag
false or omitted (`default`), it verifies that B's new children adopt the global
switch instead. Both modes check that an existing B child retains its model (or
B's first prompt in attach-only mode). The smoke explicitly opts in by default;
the plugin itself does not. `OPENCODE_SMOKE_BIN` overrides the host executable.
Artifacts are retained under `/tmp/opencode`; the shared service is untouched.
These smoke modes attach to existing conversations and, when enabled, wait for
their initial bindings. They do not cover the Home-screen startup limitation.

> See [Configuration](configuration.md) for the full preset option reference.
