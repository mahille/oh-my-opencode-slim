import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import baseTui, { publishTuiPresetSwitch } from '../tui';
import { recordTuiAgentActivity, recordTuiSessionParent } from '../tui-state';
import { registerConfigChangeListener } from './config-change-coordinator';
import tui2Plugin, {
  applyPresetByName,
  runPresetFlow,
  type V2TuiPluginContext,
} from './tui';
import { readTuiAttachMarkersForSession } from './tui-attach';

function makeConfig(): PluginConfig {
  return {
    preset: 'balanced',
    presets: {
      balanced: {
        orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
        explorer: { model: 'openai/gpt-5-mini' },
      },
      cheap: {
        orchestrator: { model: 'openai/gpt-5-mini', temperature: 0.4 },
      },
    },
  } as PluginConfig;
}

function userConfigPath(): string {
  return path.join(
    process.env.OPENCODE_CONFIG_DIR ?? '',
    'oh-my-opencode-slim.json',
  );
}

function writeUserConfig(content: Record<string, unknown>): void {
  fs.writeFileSync(userConfigPath(), JSON.stringify(content, null, 2));
}

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(userConfigPath(), 'utf-8')) as Record<
    string,
    unknown
  >;
}

/** Polls a predicate until it holds; fails loudly on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

describe('v2 tui preset plugin', () => {
  let configHome: string;
  let projectDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui2-cfg-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui2-proj-'));
    process.env.OPENCODE_CONFIG_DIR = configHome;
    process.env.XDG_DATA_HOME = path.join(configHome, 'data');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('applyPresetByName', () => {
    test('malformed config fallback never publishes over the last valid switch', () => {
      const owner = {};
      writeUserConfig({
        sessionModelState: true,
        preset: 'cheap',
        presets: { cheap: { explorer: { model: 'openai/cheap' } } },
      });
      expect(
        publishTuiPresetSwitch(owner, projectDir, 'cheap', 'ses_a').ok,
      ).toBe(true);
      const previous = readTuiAttachMarkersForSession(projectDir, 'ses_a');
      for (const invalid of [
        '{broken',
        JSON.stringify({ agents: 'invalid' }),
      ]) {
        fs.writeFileSync(userConfigPath(), invalid);
        expect(
          publishTuiPresetSwitch(owner, projectDir, 'cheap', 'ses_a').ok,
        ).toBe(false);
        expect(readTuiAttachMarkersForSession(projectDir, 'ses_a')).toEqual(
          previous,
        );
      }
    });

    test('persists the preset name and returns a success message', () => {
      writeUserConfig({
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });

      const result = applyPresetByName(projectDir, makeConfig(), 'cheap');

      expect(result.ok).toBe(true);
      expect(result.presetName).toBe('cheap');
      expect(result.message).toContain('Saved preset "cheap"');
      expect(readUserConfig().preset).toBe('cheap');
    });

    test('reports unknown presets without touching the config file', () => {
      writeUserConfig({ preset: 'balanced' });

      const result = applyPresetByName(projectDir, makeConfig(), 'nope');

      expect(result.ok).toBe(false);
      expect(result.message).toContain('not found');
      expect(result.message).toContain('balanced');
      expect(readUserConfig()).toEqual({ preset: 'balanced' });
    });

    test('fails cleanly when project config explicitly sets a different preset', () => {
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: 'project-preset' }),
      );

      writeUserConfig({
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          'project-preset': { orchestrator: { model: 'openai/gpt-5' } },
        },
      });

      const result = applyPresetByName(projectDir, makeConfig(), 'balanced');

      expect(result.ok).toBe(false);
      expect(result.message).toContain('project config (.opencode)');
      expect(result.message).toContain('"project-preset"');
      expect(readUserConfig().preset).toBeUndefined();
    });
  });

  describe('runPresetFlow', () => {
    interface ScriptedCtx {
      ctx: {
        location: { directory: string };
        agent?: { reload: () => Promise<void> };
        ui: {
          dialog?: {
            select: (args: unknown) => Promise<string | undefined>;
            prompt: (args: unknown) => Promise<string | undefined>;
            confirm: (args: unknown) => Promise<boolean | undefined>;
          };
          toast?: { show: (toast: { message: string }) => void };
        };
      };
      toasts: string[];
      selectCalls: unknown[];
      promptCalls: unknown[];
      selectTitles: () => string[];
      reloadCalls: () => number;
    }

    function makeStubCtx(
      script: {
        selects?: Array<string | undefined>;
        prompts?: Array<string | undefined>;
        confirms?: Array<boolean | undefined>;
      } = {},
      options: {
        withToast?: boolean;
        withDialogs?: boolean;
        withReload?: boolean;
      } = {},
    ): ScriptedCtx {
      const {
        withToast = true,
        withDialogs = true,
        withReload = true,
      } = options;
      const selects = [...(script.selects ?? [])];
      const prompts = [...(script.prompts ?? [])];
      const confirms = [...(script.confirms ?? [])];
      const toasts: string[] = [];
      const selectCalls: unknown[] = [];
      const promptCalls: unknown[] = [];
      let reloadCalls = 0;
      const ctx = {
        location: { directory: projectDir },
        ...(withReload
          ? {
              agent: {
                reload: async () => {
                  reloadCalls += 1;
                },
              },
            }
          : {}),
        ui: {
          ...(withDialogs
            ? {
                dialog: {
                  select: async (args: unknown) => {
                    selectCalls.push(args);
                    return selects.shift();
                  },
                  prompt: async (args: unknown) => {
                    promptCalls.push(args);
                    return prompts.shift();
                  },
                  confirm: async (args: unknown) => {
                    void args;
                    return confirms.shift();
                  },
                },
              }
            : {}),
          ...(withToast
            ? {
                toast: {
                  show: (toast: { message: string }) => {
                    toasts.push(toast.message);
                  },
                },
              }
            : {}),
        },
      };
      return {
        ctx,
        toasts,
        selectCalls,
        promptCalls,
        selectTitles: () =>
          selectCalls.map((call) => (call as { title?: string }).title ?? ''),
        reloadCalls: () => reloadCalls,
      };
    }

    test('opens the manager and applies the selected preset', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx({ selects: ['cheap', 'apply'] });
      const unregister = registerConfigChangeListener(projectDir, () => ({
        ok: true,
      }));

      try {
        await runPresetFlow(stub.ctx);

        expect(stub.toasts).toHaveLength(1);
        expect(stub.toasts[0]).toContain('Saved preset "cheap"');
        expect(readUserConfig().preset).toBe('cheap');
      } finally {
        unregister();
      }
      expect(stub.selectTitles()[0]).toBe('Presets');
      const listArgs = stub.selectCalls[0] as {
        current?: string;
        options?: Array<{ title: string; value: string }>;
      };
      expect(listArgs.current).toBe('balanced');
      expect(listArgs.options?.map((option) => option.value)).toEqual([
        'balanced',
        'cheap',
        '__omo_new_preset__',
      ]);
      expect(listArgs.options?.[0]?.title).toContain('(active)');
      expect(stub.selectTitles()[1]).toBe('Preset: cheap');
    });

    test('applies a named preset directly and reports a requested live refresh', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx({ selects: ['cheap'] });
      const unregister = registerConfigChangeListener(projectDir, () => ({
        ok: true,
      }));

      try {
        await runPresetFlow(stub.ctx, 'cheap');

        expect(stub.selectCalls).toHaveLength(0);
        expect(stub.toasts).toHaveLength(1);
        expect(stub.toasts[0]).toContain('Saved preset "cheap"');
        expect(stub.toasts[0]).toContain('Live refresh requested');
        expect(stub.toasts[0]).not.toContain('Reload OpenCode');
        expect(readUserConfig().preset).toBe('cheap');
      } finally {
        unregister();
      }
    });

    test('publishes a captured config synchronously to only the command target when enabled', async () => {
      writeUserConfig({
        preset: 'balanced',
        sessionModelState: true,
        presets: {
          balanced: { explorer: { model: 'openai/balanced' } },
          cheap: { explorer: { model: 'openai/cheap' } },
        },
      });
      const ctx = {
        location: { directory: projectDir },
        ui: {
          router: { current: () => ({ type: 'session', sessionID: 'ses_a' }) },
        },
      };
      const pending = runPresetFlow(ctx, 'cheap');
      const markers = readTuiAttachMarkersForSession(projectDir, 'ses_a');
      expect(markers).toHaveLength(1);
      expect(markers[0].kind).toBe('switch');
      expect(markers[0].config?.preset).toBe('cheap');
      expect(markers[0].config?.agents?.explorer?.model).toBe('openai/cheap');
      expect(readTuiAttachMarkersForSession(projectDir, 'ses_b')).toEqual([]);
      writeUserConfig({ preset: 'balanced' });
      expect(
        readTuiAttachMarkersForSession(projectDir, 'ses_a')[0].config?.preset,
      ).toBe('cheap');
      await pending;
    });

    test('manager Apply targets the conversation captured when the dialog opened, not the later route', async () => {
      writeUserConfig({
        sessionModelState: true,
        preset: 'balanced',
        presets: {
          balanced: { explorer: { model: 'openai/balanced' } },
          cheap: { explorer: { model: 'openai/cheap' } },
        },
      });
      let route = 'ses_a';
      const choices = ['cheap', 'apply'];
      const ctx = {
        location: { directory: projectDir },
        ui: {
          router: { current: () => ({ type: 'session', sessionID: route }) },
          dialog: {
            select: async () => {
              route = 'ses_b';
              return choices.shift();
            },
            prompt: async () => undefined,
            confirm: async () => undefined,
          },
        },
      };
      await runPresetFlow(ctx);
      expect(
        readTuiAttachMarkersForSession(projectDir, 'ses_a').map(
          (marker) => marker.kind,
        ),
      ).toEqual(['switch']);
      expect(readTuiAttachMarkersForSession(projectDir, 'ses_b')).toEqual([]);
    });

    for (const enabled of [false, undefined]) {
      test(`disabled (${enabled}) Apply persists and notifies without session markers`, async () => {
        const config = {
          sessionModelState: enabled,
          preset: 'balanced',
          presets: {
            balanced: { explorer: { model: 'openai/balanced' } },
            cheap: { explorer: { model: 'openai/cheap' } },
          },
        };
        writeUserConfig(config);
        const stub = makeStubCtx({ selects: ['balanced', 'apply'] });
        Object.assign(stub.ctx.ui, {
          router: { current: () => ({ type: 'session', sessionID: 'ses_a' }) },
        });
        let notifications = 0;
        const unregister = registerConfigChangeListener(projectDir, () => {
          notifications += 1;
          return { ok: true };
        });
        try {
          await runPresetFlow(stub.ctx, 'cheap');
          // Even an Apply after a disk edit cannot enable this TUI owner.
          writeUserConfig({ ...config, sessionModelState: true });
          await runPresetFlow(stub.ctx);
          expect(readUserConfig().preset).toBe('balanced');
          expect(notifications).toBe(2);
          expect(readTuiAttachMarkersForSession(projectDir, 'ses_a')).toEqual(
            [],
          );
          expect(
            stub.toasts.every((text) =>
              text.includes('Live refresh requested'),
            ),
          ).toBe(true);
        } finally {
          unregister();
        }
      });
    }

    test('enabled manager Save never publishes a conversation switch', async () => {
      writeUserConfig({
        sessionModelState: true,
        preset: 'balanced',
        presets: {
          balanced: { explorer: { model: 'openai/balanced' } },
          cheap: { explorer: { model: 'openai/cheap' } },
        },
      });
      const stub = makeStubCtx({
        selects: ['cheap', 'edit', '__omo_save__', undefined],
      });
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'session', sessionID: 'ses_a' }) },
      });
      let notifications = 0;
      const unregister = registerConfigChangeListener(projectDir, () => {
        notifications += 1;
        return { ok: true };
      });
      try {
        await runPresetFlow(stub.ctx);
        expect(notifications).toBe(1);
        expect(readUserConfig().preset).toBe('balanced');
        expect(readTuiAttachMarkersForSession(projectDir, 'ses_a')).toEqual([]);
      } finally {
        unregister();
      }
    });

    test('reports honestly when no live refresh listener is registered', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({ selects: ['cheap'] });

      await runPresetFlow(stub.ctx, 'cheap');

      expect(readUserConfig().preset).toBe('cheap');
      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('live refresh request failed');
      expect(stub.toasts[0]).toContain('Reload OpenCode to apply');
      expect(stub.toasts[0]).not.toContain('Live refresh requested');
    });

    test('a failed switch never notifies the sidebar listener (label unchanged)', async () => {
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: 'locked-by-project' }),
      );
      writeUserConfig({
        preset: 'old',
        presets: {
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
          'locked-by-project': {
            orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
          },
        },
      });
      let notifications = 0;
      const unregister = registerConfigChangeListener(projectDir, () => {
        notifications += 1;
        return { ok: true };
      });
      const stub = makeStubCtx({ selects: ['cheap'] });

      try {
        await runPresetFlow(stub.ctx, 'cheap');
      } finally {
        unregister();
      }

      // Persistence failed, so the sidebar is never asked to re-read: the
      // label keeps showing the old preset.
      expect(notifications).toBe(0);
      expect(readUserConfig().preset).toBe('old');
      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('project config (.opencode)');
    });

    test('cancels silently when the manager is dismissed', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({ selects: [undefined] });

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toEqual([]);
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('opens the create prompt when no presets are configured', async () => {
      // An explicit (preset-less) user config stops the search before the
      // machine's real default config dir.
      writeUserConfig({});
      const stub = makeStubCtx({ prompts: [undefined] });

      await runPresetFlow(stub.ctx);

      expect(stub.selectCalls).toHaveLength(0);
      expect(
        (stub.promptCalls[0] as { title?: string } | undefined)?.title,
      ).toBe('Create new preset');
      // Cancelled create leaves the config untouched and closes the manager.
      expect(readUserConfig()).toEqual({});
    });

    test('applies a named preset without a toast surface', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({ selects: ['cheap'] }, { withToast: false });

      await runPresetFlow(stub.ctx, 'cheap');

      expect(readUserConfig().preset).toBe('cheap');
    });

    test('guides when the host exposes no dialogs', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({}, { withDialogs: false });

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('dialog API');
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('toasts warning and does not persist when project config preset conflicts', async () => {
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: 'locked-by-project' }),
      );

      writeUserConfig({
        preset: 'old',
        presets: {
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
          'locked-by-project': {
            orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
          },
        },
      });

      const stub = makeStubCtx({ selects: ['cheap', 'apply'] });
      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('project config (.opencode)');
      expect(stub.toasts[0]).toContain('"locked-by-project"');
      expect(readUserConfig().preset).toBe('old');
    });
  });

  describe('plugin module', () => {
    interface KeymapCommandStub {
      id?: string;
      title?: string;
      group?: string;
      palette?: boolean;
      slash?: { name: string; aliases?: string[]; arguments?: boolean };
      run: (input?: string) => void | Promise<void>;
    }

    interface SetupStub {
      ctx: Record<string, unknown>;
      slotClaims: Array<{ append?: string; render?: () => unknown }>;
      layers: Array<{ mode?: string; commands: KeymapCommandStub[] }>;
      renderAppSlot: () => void;
      keymapDisposed: () => boolean;
      slotDisposeCalls: () => number;
    }

    function makeSetupCtx(options: { keymap?: boolean } = {}): SetupStub {
      const { keymap = true } = options;
      const slotClaims: Array<{ append?: string; render?: () => unknown }> = [];
      const layers: SetupStub['layers'] = [];
      let slotDisposeCalls = 0;
      let keymapDisposed = false;
      const ctx: Record<string, unknown> = {
        location: { directory: projectDir },
        renderer: { requestRender: () => {} },
        theme: {
          text: { default: '#f0f0f0', subdued: '#8a8a8a' },
          background: { default: '#101010' },
          border: { default: '#3a3a3a' },
        },
        ui: {
          slot: (claim: { append?: string; render?: () => unknown }) => {
            slotClaims.push(claim);
            return () => {
              slotDisposeCalls += 1;
            };
          },
          router: {
            current: () => ({ type: 'home' }),
          },
        },
      };
      if (keymap) {
        ctx.keymap = {
          layer: (thunk: () => SetupStub['layers'][number]) => {
            layers.push(thunk());
            return {
              dispose: () => {
                keymapDisposed = true;
              },
            };
          },
        };
      }
      return {
        ctx,
        slotClaims,
        layers,
        renderAppSlot: () => {
          const claim = slotClaims.find((slot) => slot.append === 'app');
          claim?.render?.();
        },
        keymapDisposed: () => keymapDisposed,
        slotDisposeCalls: () => slotDisposeCalls,
      };
    }

    test('keeps the v1 dual contract and extends the v2 setup', () => {
      expect(tui2Plugin.id).toBe(baseTui.id);
      expect(tui2Plugin.tui).toBe(baseTui.tui);
      expect(typeof tui2Plugin.setup).toBe('function');
    });

    for (const sessionModelState of [false, undefined]) {
      test(`startup (${sessionModelState}) stays disabled after disk enables the feature`, async () => {
        const config = {
          sessionModelState,
          preset: 'balanced',
          presets: {
            balanced: { explorer: { model: 'openai/balanced' } },
            cheap: { explorer: { model: 'openai/cheap' } },
          },
        };
        writeUserConfig(config);
        const stub = makeSetupCtx();
        const ctx = stub.ctx as unknown as V2TuiPluginContext;
        ctx.ui.router.current = () => ({ type: 'session', sessionID: 'ses_a' });
        const cleanup = await tui2Plugin.setup(ctx);
        const unregister = registerConfigChangeListener(projectDir, () => ({
          ok: true,
        }));
        try {
          expect(readTuiAttachMarkersForSession(projectDir, 'ses_a')).toEqual(
            [],
          );
          writeUserConfig({ ...config, sessionModelState: true });
          await runPresetFlow(ctx, 'cheap');
          expect(readUserConfig().preset).toBe('cheap');
          expect(readTuiAttachMarkersForSession(projectDir, 'ses_a')).toEqual(
            [],
          );
        } finally {
          unregister();
          cleanup?.();
        }
      });
    }

    test('setup registers the sidebar slot and the /preset layer in the app slot render', async () => {
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        expect(stub.slotClaims.map((slot) => slot.append)).toEqual([
          'sidebar.content',
          'app',
        ]);
        expect(stub.layers).toHaveLength(0);

        stub.renderAppSlot();

        expect(stub.layers).toHaveLength(1);
        const layer = stub.layers[0];
        expect(layer?.mode).toBe('global');
        const command = layer?.commands[0];
        expect(command?.id).toBe('omo.preset');
        expect(command?.title).toBe('OMO: switch preset');
        expect(command?.group).toBe('System');
        expect(command?.palette).toBe(true);
        expect(command?.slash).toEqual({ name: 'preset', arguments: true });
        expect(stub.keymapDisposed()).toBe(false);

        cleanup?.();
        cleanup = undefined;
        expect(stub.keymapDisposed()).toBe(false);
        expect(stub.slotDisposeCalls()).toBe(2);
      } finally {
        cleanup?.();
      }
    });

    test('re-invokes layer on every app slot render', async () => {
      const stub = makeSetupCtx();
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();
      stub.renderAppSlot();

      expect(stub.layers).toHaveLength(2);
      cleanup?.();
    });

    test('runs the preset flow when the registered command is invoked', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeSetupCtx();
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();
      await stub.layers[0]?.commands[0]?.run('cheap');

      expect(readUserConfig().preset).toBe('cheap');
      cleanup?.();
    });

    test('setup keeps the sidebar when keymap.layer is unavailable', async () => {
      const stub = makeSetupCtx({ keymap: false });
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        expect(stub.slotClaims.map((slot) => slot.append)).toEqual([
          'sidebar.content',
          'app',
        ]);
        stub.renderAppSlot();
        expect(stub.layers).toHaveLength(0);
      } finally {
        cleanup?.();
      }
    });

    test('setup registers nothing when disabled by env', async () => {
      process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';
      const stub = makeSetupCtx();

      const cleanup = await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      );

      expect(stub.slotClaims).toHaveLength(0);
      expect(stub.layers).toHaveLength(0);
      expect(cleanup).toBeUndefined();
    });

    test('layer includes omo.kill_all with alt+w bind', async () => {
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.kill_all',
        );
        expect(command?.title).toBe('OMO: kill all running subagents');
        expect(command?.group).toBe('System');
        expect(command?.palette).toBe(true);
        expect(command?.slash).toEqual({ name: 'killall' });
        expect((command as { bind?: string } | undefined)?.bind).toBe('alt+w');
      } finally {
        cleanup?.();
      }
    });

    test('omo.kill_all run aborts visible-conversation running subagents and toasts', async () => {
      const originalDataHome = process.env.XDG_DATA_HOME;
      const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-kill2-'));
      const aborts: string[] = [];
      const toasts: string[] = [];
      let cleanup: (() => void) | undefined;
      try {
        process.env.XDG_DATA_HOME = dataHome;
        recordTuiSessionParent('ora-live', 'conv-1', projectDir);
        recordTuiAgentActivity(
          {
            sessionID: 'ora-live',
            agentName: 'oracle',
            active: true,
            details: { status: 'busy' },
          },
          projectDir,
        );

        const stub = makeSetupCtx();
        (stub.ctx as { client?: unknown }).client = {
          v2: {},
          session: {
            abort: async (args: { sessionID: string }) => {
              aborts.push(args.sessionID);
            },
          },
        };
        (stub.ctx.ui as { router?: unknown }).router = {
          current: () => ({ type: 'session', sessionID: 'conv-1' }),
        };
        (stub.ctx.ui as { toast?: unknown }).toast = {
          show: (toast: { message: string }) => {
            toasts.push(toast.message);
          },
        };

        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.kill_all',
        );
        await command?.run();
        // run() is fire-and-forget (void runKillAllFlow): the abort call
        // starts synchronously, the toast lands a microtask later.
        await Bun.sleep(50);

        expect(aborts).toEqual(['ora-live']);
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toContain('Kill-all sent to 1 running subagent');
      } finally {
        cleanup?.();
        fs.rmSync(dataHome, { recursive: true, force: true });
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
      }
    });

    test('fallback command opens the latest subagent tab manually', async () => {
      const stub = makeSetupCtx();
      const opened: string[] = [];
      const toasts: string[] = [];
      stub.ctx.data = {
        session: {
          list: () => [
            { id: 'ora-old', parentID: 'conv-1', time: { created: 1 } },
            { id: 'ora-new', parentID: 'conv-1', time: { created: 2 } },
            { id: 'other', parentID: 'conv-2', time: { created: 3 } },
          ],
        },
      };
      (stub.ctx.ui as { router?: unknown }).router = {
        current: () => ({ type: 'session', sessionID: 'conv-1' }),
      };
      (stub.ctx.ui as { tabs?: unknown }).tabs = {
        enabled: () => true,
        open: (sessionID: string) => {
          opened.push(sessionID);
          return true;
        },
      };
      (stub.ctx.ui as { toast?: unknown }).toast = {
        show: (toast: { message: string }) => {
          toasts.push(toast.message);
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.open_subagent',
        );
        expect(command).toBeDefined();
        // Registration alone must never open anything (manual fallback).
        expect(opened).toEqual([]);

        await command?.run();
        await Bun.sleep(10);
        expect(opened).toEqual(['ora-new']);
        expect(toasts[0]).toContain('ora-new');
      } finally {
        cleanup?.();
      }
    });

    test('fallback command toasts when session tabs are disabled', async () => {
      const stub = makeSetupCtx();
      const opened: string[] = [];
      const toasts: string[] = [];
      stub.ctx.data = {
        session: {
          list: () => [
            { id: 'ora-new', parentID: 'conv-1', time: { created: 2 } },
          ],
        },
      };
      (stub.ctx.ui as { router?: unknown }).router = {
        current: () => ({ type: 'session', sessionID: 'conv-1' }),
      };
      (stub.ctx.ui as { tabs?: unknown }).tabs = {
        enabled: () => false,
        open: (sessionID: string) => {
          opened.push(sessionID);
          return false;
        },
      };
      (stub.ctx.ui as { toast?: unknown }).toast = {
        show: (toast: { message: string }) => {
          toasts.push(toast.message);
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.open_subagent',
        );
        await command?.run();
        await Bun.sleep(10);
        expect(opened).toEqual([]);
        expect(toasts[0]).toContain('tabs are disabled');
      } finally {
        cleanup?.();
      }
    });

    test('a standalone host never wires panes even with a multiplexer configured', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--standalone'];

      const subscriptions: string[] = [];
      stub.ctx.data = {
        on: (type: string) => {
          subscriptions.push(type);
          return () => {};
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => ({ urls: ['http://127.0.0.1:9999'] }),
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        // Standalone: no wiring, no subscriptions (diagnostic path instead).
        expect(subscriptions).toEqual([]);
      } finally {
        cleanup?.();
        process.argv = originalArgv;
      }
    });

    test('wires the v2 pane lifecycle in shared mode and disposes it on cleanup', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      // First call resolves the shared-service base URL; every later call is
      // the liveness probe, which fails here so the wiring never reaches the
      // real adapter factory (no tmux commands run during the test).
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        // The wiring subscribes through the host `data.on` feed, proving the
        // lifecycle was established for this v2 process.
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }

      // Disposal must release every host subscription (fire-and-forget in the
      // setup cleanup; the unsubscribe loop runs synchronously).
      expect([...unsubscribed].sort()).toEqual(expectedEvents);
    });

    test('does not wire panes when the v2 server URL cannot be resolved', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions: string[] = [];
      stub.ctx.data = {
        on: (type: string) => {
          subscriptions.push(type);
          return () => {};
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            throw new Error('service down');
          },
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect(subscriptions).toEqual([]);
      } finally {
        cleanup?.();
      }
    });

    test('rebuilds the pane wiring when multiplexer.type is enabled (hot reload)', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'none' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        // Disabled at startup: no wiring and no host subscriptions.
        expect(subscriptions.size).toBe(0);

        // v2 hot-reloads config; enabling panes must rebuild the wiring on the
        // next sidebar poll instead of staying unavailable until restart.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'tmux' } }),
        );
        await waitFor(() => subscriptions.size > 0);
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }
      expect([...unsubscribed].sort()).toEqual(expectedEvents);
    });

    test('disposes the pane wiring when multiplexer.type is disabled (hot reload)', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);

        // Disabling panes must dispose the live wiring instead of leaving it
        // creating panes for the rest of the process lifetime.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'none' } }),
        );
        await waitFor(() => unsubscribed.length >= expectedEvents.length);
        expect([...unsubscribed].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }
    });

    test('does not leave live pane wiring behind when teardown races a rebuild', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'none' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let releaseResolve: ((value: { urls: string[] }) => void) | undefined;
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) {
              return await new Promise<{ urls: string[] }>((resolve) => {
                releaseResolve = resolve;
              });
            }
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect(subscriptions.size).toBe(0);

        // Start a rebuild, let it park on the host probe, then tear down
        // while it is still waiting.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'tmux' } }),
        );
        await waitFor(() => infoCalls >= 1);
        cleanup();
        cleanup = undefined;
        releaseResolve?.({ urls: ['http://127.0.0.1:1'] });

        // The late wiring must dispose itself instead of staying subscribed
        // (and creating panes) for a closed TUI.
        await waitFor(() => unsubscribed.length >= expectedEvents.length);
        expect([...unsubscribed].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
      }
    });
  });
});
