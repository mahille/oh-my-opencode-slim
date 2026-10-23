/**
 * Session-frozen hot-refresh integration: config changes resolve NEW child
 * profiles and the sidebar projection without rebuilding agent definitions or
 * reloading the host registry (AGENTS.md: system prompts and tool sets stay
 * frozen for a session's lifetime).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTuiAttachDir, readTuiSnapshot } from '../tui-state';
import { createV2Setup } from './setup';
import { makeTestEnv, type TestEnv } from './test-fixtures';
import type { V2Context, V2SessionContextEvent } from './types';

const CHEAP_PLAIN = { explorer: { model: 'openai/gpt-5-mini' } };
const CHEAP_TEMP = {
  explorer: { model: 'openai/gpt-5-mini', temperature: 0.2 },
};
const STRONG_PLAIN = { explorer: { model: 'anthropic/claude-sonnet-4-5' } };
const STRONG_THINKING = {
  explorer: {
    model: 'anthropic/claude-sonnet-4-5',
    options: { thinking: { type: 'enabled' } },
  },
};
/** Both presets present; only the selected `preset` key differs. */
const hot = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_TEMP, strong: STRONG_THINKING },
});
const plain = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_PLAIN, strong: STRONG_PLAIN },
});

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2-hot');
  process.env.XDG_DATA_HOME = path.join(env.configHome, 'data');
  process.env.XDG_CONFIG_HOME = path.join(env.configHome, 'xdg-config');
  process.env.XDG_CACHE_HOME = path.join(env.configHome, 'xdg-cache');
  process.env.OPENCODE_LOG_DIR = path.join(env.configHome, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
});

afterEach(() => {
  env.restore();
});

// Legacy watcher integration checks below exercise real fs.watch delivery,
// which cannot be advanced with an injected scheduler. Prompt-path regressions
// use awaited admission directly and never wait for watcher/debounce timing.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(10);
  }
}

interface Harness {
  cleanup: () => void | Promise<void>;
  pushEvent: (event: unknown) => void;
  invokePrompt: (event: Record<string, unknown>) => Promise<void>;
  switchCalls: Array<{
    sessionID: string;
    model: { id: string; providerID?: string };
  }>;
  contextHandler: ((event: V2SessionContextEvent) => Promise<void>) | undefined;
  agentTransformCalls: () => number;
  agentReloadCalls: () => number;
  flushAgentTransform: () => void;
  parents: Map<string, string>;
}

/** Live sidebar model projection for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

async function bootHarness(deferAgentTransform = false): Promise<Harness> {
  const reg = () => ({ dispose() {} });
  /** Transform stub: apply `draft`, then hand back a disposable. */
  const transformWith =
    (draft: unknown) => async (cb: (draft: unknown) => void) => {
      cb(draft);
      return reg();
    };
  const queue: unknown[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const iterator = {
    next: () =>
      new Promise<IteratorResult<unknown>>((resolve) => {
        if (closed) {
          resolve({ value: undefined, done: true });
          return;
        }
        const deliver = () => {
          if (closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          if (queue.length > 0) {
            resolve({ value: queue.shift(), done: false });
          } else {
            wake = deliver;
          }
        };
        deliver();
      }),
    return: () => {
      closed = true;
      wake?.();
      wake = undefined;
      return Promise.resolve({ value: undefined, done: true }) as Promise<
        IteratorResult<unknown>
      >;
    },
  };

  const switchCalls: Array<{
    sessionID: string;
    model: { id: string; providerID?: string };
  }> = [];
  let agentTransformCalls = 0;
  let agentReloadCalls = 0;
  let deferredAgentTransform: ((draft: unknown) => void) | undefined;
  let contextHandler:
    | ((event: V2SessionContextEvent) => Promise<void>)
    | undefined;
  const promptHandlers: Array<
    (event: Record<string, unknown>) => Promise<void>
  > = [];
  const parents = new Map<string, string>();

  const ctx = {
    app: { name: 'opencode', version: 'v2-hot-refresh-test' },
    options: {},
    location: {
      directory: env.projectDir,
      project: {
        id: 'proj_hot',
        directory: env.projectDir,
        canonical: env.projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        agentTransformCalls += 1;
        const draft = {
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: () => {},
          remove: () => {},
        };
        if (deferAgentTransform) {
          deferredAgentTransform = cb;
        } else {
          cb(draft);
        }
        return reg();
      },
      reload: async () => {
        agentReloadCalls += 1;
      },
      list: async () => [],
    },
    tool: {
      transform: transformWith({ add: () => {} }),
      hook: async () => reg(),
    },
    command: {
      transform: transformWith({ add: () => {} }),
      list: async () => [],
    },
    session: {
      hook: async (
        name: string,
        cb: (event: V2SessionContextEvent) => Promise<void>,
      ) => {
        if (name === 'context') contextHandler = cb;
        if (name === 'prompt') {
          promptHandlers.push(
            cb as unknown as (event: Record<string, unknown>) => Promise<void>,
          );
        }
        return reg();
      },
      // Identity source for the awaited prompt-path capture: children carry
      // a parentID + plugin agent; root/foreign sessions are recognizable.
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        ...(sessionID.startsWith('root') ||
        sessionID === 'parent-1' ||
        sessionID === 'other-root'
          ? {}
          : {
              parentID:
                parents.get(sessionID) ??
                (sessionID === 'unprompted-child' ? 'other-root' : 'parent-1'),
            }),
        agent: sessionID.startsWith('foreign') ? 'build' : 'explorer',
        ...(sessionID === 'per-call-child' && {
          model: { providerID: 'other', id: 'per-call', variant: 'low' },
        }),
      }),
      switchModel: async (input: {
        sessionID: string;
        model: { id: string };
      }) => {
        switchCalls.push(input);
      },
      update: async () => ({}),
    },
    mcp: {
      transform: transformWith({
        list: () => [],
        get: () => undefined,
        set: () => {},
        update: () => {},
        remove: () => {},
      }),
      reload: async () => {},
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
  } as unknown as V2Context;

  const cleanup = await createV2Setup()(ctx);

  return {
    cleanup,
    pushEvent: (event: unknown) => {
      if (closed) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    invokePrompt: async (event: Record<string, unknown>) => {
      for (const handler of promptHandlers) {
        await handler(event);
      }
    },
    switchCalls,
    parents,
    get contextHandler() {
      return contextHandler;
    },
    agentTransformCalls: () => agentTransformCalls,
    agentReloadCalls: () => agentReloadCalls,
    flushAgentTransform: () => {
      deferredAgentTransform?.({
        list: () => [],
        get: () => undefined,
        default: () => {},
        update: () => {},
        remove: () => {},
      });
    },
  };
}

/** Boots the harness, runs `body`, and always cleans it up. */
async function withHarness(
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await bootHarness();
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
}

function createChildEvent(sessionID: string): Record<string, unknown> {
  return {
    type: 'session.created',
    data: { sessionID, parentID: 'parent-1', agent: 'explorer' },
  };
}

/** Immutable TUI operation, consumed synchronously at prompt admission. */
function writeOperation(
  sessionID: string,
  preset: string,
  kind: 'initialize' | 'switch',
  revision: string,
) {
  const attachDir = getTuiAttachDir(env.projectDir);
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(
    path.join(attachDir, `${sessionID}.json`),
    JSON.stringify({
      sessionID,
      tuiBootID: `tui-${sessionID}`,
      timestamp: 1,
      revision,
      kind,
      config: { sessionModelState: true, ...hot(preset) },
    }),
  );
}

/** Push probe children until one captures a seeded profile. */
async function captureFirstChild(
  harness: Harness,
  idPrefix: string,
): Promise<string> {
  for (let index = 0; index < 60; index += 1) {
    const id = `${idPrefix}-${index}`;
    harness.pushEvent(createChildEvent(id));
    await wait(15);
    if (harness.switchCalls.some((call) => call.sessionID === id)) {
      return id;
    }
  }
  throw new Error('no child captured a profile');
}

describe('v2 session-frozen hot refresh', () => {
  test('invalid shared config retains last-good dispatch on admission and after repair', async () => {
    env.writeUserConfig({ sessionModelState: true, ...hot('cheap') });
    await withHarness(async (harness) => {
      const prompt = (sessionID: string) =>
        harness.invokePrompt({ sessionID, prompt: { text: 'test' } });
      await prompt('parent-1');
      fs.writeFileSync(env.userConfigPath, '{ invalid json');
      // An unbound root must pin last-good defaults, not wait for another TUI's write.
      await prompt('root-invalid');
      harness.parents.set('invalid-child', 'root-invalid');
      await prompt('invalid-child');
      env.writeUserConfig({ sessionModelState: true, ...hot('strong') });
      await prompt('root-invalid');
      await prompt('parent-1');
      harness.parents.set('repaired-child', 'root-invalid');
      await prompt('repaired-child');
      await prompt('existing-root-child');
      expect(harness.switchCalls.map(({ model }) => model.id)).toEqual([
        'gpt-5-mini',
        'gpt-5-mini',
        'gpt-5-mini',
      ]);
      expect(
        readTuiSnapshot(env.projectDir).sessionAgentModels['parent-1']
          ?.agentModels.explorer,
      ).toBe('openai/gpt-5-mini');
    });
  });

  test('two initialized conversations remain isolated across disk writes, navigation and targeted Apply', async () => {
    env.writeUserConfig({ sessionModelState: true, ...hot('cheap') });
    await withHarness(async (harness) => {
      const prompt = (sessionID: string) =>
        harness.invokePrompt({
          sessionID,
          messageID: `msg_${sessionID}`,
          prompt: { text: 'test' },
        });
      writeOperation('root-a', 'cheap', 'initialize', 'a-init');
      writeOperation('root-b', 'cheap', 'initialize', 'b-init');
      await prompt('root-a');
      await prompt('root-b');
      harness.parents.set('old-a', 'root-a');
      await prompt('old-a');
      env.writeUserConfig({ sessionModelState: true, ...hot('strong') });
      // Navigation must not rebind B from the new shared selection.
      writeOperation('root-b', 'strong', 'initialize', 'b-navigation');
      await prompt('root-b');
      harness.parents.set('new-b', 'root-b');
      await prompt('new-b');
      // No sleep: admission must consume Apply before the watcher debounce.
      writeOperation('root-a', 'strong', 'switch', 'a-apply');
      harness.parents.set('new-a', 'root-a');
      await prompt('new-a');
      harness.parents.set('per-call-child', 'root-a');
      await prompt('per-call-child');
      harness.parents.set('grandchild', 'old-a');
      await prompt('grandchild');
      harness.parents.set('great-grandchild', 'grandchild');
      await prompt('great-grandchild');
      await prompt('old-a');
      expect(
        harness.switchCalls.map(({ sessionID, model }) => [
          sessionID,
          model.id,
        ]),
      ).toEqual([
        ['old-a', 'gpt-5-mini'],
        ['new-b', 'gpt-5-mini'],
        ['new-a', 'claude-sonnet-4-5'],
        ['grandchild', 'gpt-5-mini'],
        ['great-grandchild', 'gpt-5-mini'],
      ]);
      const records = readTuiSnapshot(env.projectDir).sessionAgentModels;
      expect(records['root-a']?.agentModels.explorer).toBe(
        'anthropic/claude-sonnet-4-5',
      );
      expect(records['root-b']?.agentModels.explorer).toBe('openai/gpt-5-mini');
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );
      // A root first admitted after the edit binds the new defaults; B stays cheap.
      await prompt('root-c');
      harness.parents.set('new-c', 'root-c');
      await prompt('new-c');
      expect(
        harness.switchCalls.find((call) => call.sessionID === 'new-c')?.model
          .id,
      ).toBe('claude-sonnet-4-5');
      expect(
        readTuiSnapshot(env.projectDir).sessionAgentModels['root-c']
          ?.agentModels.explorer,
      ).toBe('anthropic/claude-sonnet-4-5');
      expect(harness.agentTransformCalls()).toBe(1);
      expect(harness.agentReloadCalls()).toBe(0);
    });
  });

  test('root prompts retain their projection while global defaults refresh', async () => {
    env.writeUserConfig({ sessionModelState: true, ...hot('cheap') });
    await withHarness(async (harness) => {
      const prompt = (sessionID: string) =>
        harness.invokePrompt({
          sessionID,
          messageID: `msg_${sessionID}`,
          prompt: { text: 'test' },
        });

      // The startup seed writes the global projection (cheap preset).
      await waitFor(() => sidebarModels().explorer === 'openai/gpt-5-mini');

      // A root prompt resolves its conversation snapshot from disk and
      // records the per-session projection for the sidebar.
      await prompt('parent-1');
      let sessionRecord = readTuiSnapshot(env.projectDir).sessionAgentModels[
        'parent-1'
      ];
      expect(sessionRecord?.agentModels.explorer).toBe('openai/gpt-5-mini');
      expect(sessionRecord?.updatedAt).toBeTypeOf('number');

      // Shared disk changes cannot mutate an already bound conversation.
      env.writeUserConfig({ sessionModelState: true, ...hot('strong') });
      await prompt('parent-1');
      sessionRecord = readTuiSnapshot(env.projectDir).sessionAgentModels[
        'parent-1'
      ];
      expect(sessionRecord?.agentModels.explorer).toBe('openai/gpt-5-mini');
      writeOperation('parent-1', 'strong', 'switch', 'apply-strong');
      await prompt('parent-1');
      sessionRecord = readTuiSnapshot(env.projectDir).sessionAgentModels[
        'parent-1'
      ];
      expect(sessionRecord?.agentModels.explorer).toBe(
        'anthropic/claude-sonnet-4-5',
      );
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );
    });
  }, 20_000);

  test('TUI initialize binds its captured config rather than shared disk before the first prompt', async () => {
    env.writeUserConfig({ sessionModelState: true, ...hot('cheap') });
    await withHarness(async (harness) => {
      // The startup seed writes the global projection (cheap preset).
      await waitFor(() => sidebarModels().explorer === 'openai/gpt-5-mini');

      // Shared disk changes do not replace the immutable operation below.
      env.writeUserConfig({ sessionModelState: true, ...hot('strong') });

      writeOperation('parent-1', 'cheap', 'initialize', 'captured-cheap');
      await harness.invokePrompt({
        sessionID: 'parent-1',
        prompt: { text: 'start' },
      });
      expect(
        readTuiSnapshot(env.projectDir).sessionAgentModels['parent-1']
          ?.agentModels.explorer,
      ).toBe('openai/gpt-5-mini');

      // Global defaults still refresh independently of the captured operation.
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // A new child inherits the immutable operation, not the shared disk.
      await harness.invokePrompt({
        sessionID: 'attach-child',
        prompt: { text: 'start' },
      });
      expect(
        harness.switchCalls.find((call) => call.sessionID === 'attach-child')
          ?.model.id,
      ).toBe('gpt-5-mini');
    });
  }, 20_000);

  test('the attach watcher binds captured config without a prompt', async () => {
    env.writeUserConfig({ sessionModelState: true, ...hot('cheap') });
    await withHarness(async (harness) => {
      writeOperation('parent-1', 'strong', 'initialize', 'watcher-init');
      // This deliberately exercises real fs.watch, not prompt-path consumption.
      await waitFor(
        () =>
          readTuiSnapshot(env.projectDir).sessionAgentModels['parent-1']
            ?.agentModels.explorer === 'anthropic/claude-sonnet-4-5',
      );
      expect(sidebarModels().explorer).toBe('openai/gpt-5-mini');
      await harness.invokePrompt({
        sessionID: 'watcher-child',
        prompt: { text: 'inherit attach snapshot' },
      });
      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'watcher-child',
          model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        },
      ]);
    });
  });

  test('session profile bridge sees plugin agents after deferred agent transform', async () => {
    env.writeUserConfig(hot('cheap'));
    const harness = await bootHarness(true);
    try {
      harness.pushEvent(createChildEvent('early-deferred-child'));
      await wait(50);
      harness.flushAgentTransform();
      await harness.invokePrompt({
        sessionID: 'early-deferred-child',
        messageID: 'msg_deferred_agent',
        prompt: { text: 'capture deferred agent profile' },
      });

      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'early-deferred-child',
          model: { providerID: 'openai', id: 'gpt-5-mini' },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  }, 20_000);

  test('config edit refreshes new-child profiles and sidebar without touching frozen surfaces', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      expect(sidebarModels().explorer).toBe('openai/gpt-5-mini');

      // A child created before the edit captures the initial profile.
      const firstChild = await captureFirstChild(harness, 'first');
      const firstSwitch = harness.switchCalls.find(
        (call) => call.sessionID === firstChild,
      );
      expect(firstSwitch?.model.id).toBe('gpt-5-mini');

      // Root and foreign-agent sessions mixed into the same event stream stay
      // untouched while the first child captures its profile (isolated
      // unit coverage lives in runtime-profiles.test.ts).
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'root-1', agent: 'explorer' },
      });
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'foreign-1', parentID: 'parent-1', agent: 'build' },
      });
      await wait(80);
      expect(
        harness.switchCalls.some(
          (call) =>
            call.sessionID === 'root-1' || call.sessionID === 'foreign-1',
        ),
      ).toBe(false);

      // Manual config edit: the watcher refreshes profiles + sidebar only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // The existing child is NOT re-switched...
      const switchCountBefore = harness.switchCalls.filter(
        (call) => call.sessionID === firstChild,
      ).length;
      harness.pushEvent(createChildEvent(firstChild));
      await wait(60);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === firstChild),
      ).toHaveLength(switchCountBefore);

      // Explicit Apply updates this root's future children, not global edits.
      writeOperation('parent-1', 'strong', 'switch', 'apply-strong');
      // ...while a NEW child gets the fresh profile/options.
      const secondChild = await captureFirstChild(harness, 'second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');

      const contextHandler = harness.contextHandler;
      expect(contextHandler).toBeDefined();
      const options: Record<string, unknown> = {};
      await contextHandler?.({
        sessionID: firstChild,
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      // First child applies its frozen temperature, not the new profile.
      expect(options.temperature).toBe(0.2);
      expect(options.thinking).toBeUndefined();

      await contextHandler?.({
        sessionID: secondChild,
        agent: 'explorer',
        model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect((options as { thinking?: unknown }).thinking).toEqual({
        type: 'enabled',
      });
      expect(options.temperature).toBeUndefined();

      // Frozen surfaces: agents registered ONCE and never reloaded globally.
      expect(harness.agentTransformCalls()).toBe(1);
      expect(harness.agentReloadCalls()).toBe(0);
    });
  }, 20_000);

  test('disposal stops watching: no refresh or child capture afterwards', async () => {
    env.writeUserConfig(plain('cheap'));
    const harness = await bootHarness();
    await captureFirstChild(harness, 'pre');

    await harness.cleanup();
    const switchCount = harness.switchCalls.length;

    env.writeUserConfig(plain('strong'));
    await wait(400);

    harness.pushEvent(createChildEvent('post-dispose-child'));
    await wait(100);

    expect(harness.switchCalls).toHaveLength(switchCount);
  }, 20_000);

  test('first prompt captures and switches before session.created; a refresh keeps the captured profile', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      await harness.invokePrompt({
        sessionID: 'per-call-child',
        messageID: 'msg_per_call',
        prompt: { text: 'keep the per-call model' },
      });
      expect(harness.switchCalls).toEqual([]);
      // The host fires the prompt hook BEFORE any session.created event for
      // the child: the awaited request-path capture must still switch the
      // model and freeze the profile before the first request.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_1',
        prompt: { text: 'start' },
      });
      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'race-child',
          model: { providerID: 'openai', id: 'gpt-5-mini' },
        },
      ]);

      const options: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(options.temperature).toBe(0.2);

      // A config refresh replaces the table for NEW children only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // Replayed prompt + the (delayed) session.created event for the
      // existing child must neither re-switch nor re-freeze it.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_2',
        prompt: { text: 'more' },
      });
      harness.pushEvent(createChildEvent('race-child'));
      await wait(80);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === 'race-child'),
      ).toHaveLength(1);

      const optionsAfter: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options: optionsAfter,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(optionsAfter.temperature).toBe(0.2);
      expect(optionsAfter.thinking).toBeUndefined();

      // A targeted Apply admits the next child on the new profile.
      writeOperation('parent-1', 'strong', 'switch', 'apply-strong');
      const secondChild = await captureFirstChild(harness, 'race-second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');
    });
  }, 20_000);

  for (const sessionModelState of [false, undefined]) {
    test(`global mode (${sessionModelState}) refreshes defaults and ignores stale operations`, async () => {
      env.writeUserConfig({
        ...hot('cheap'),
        ...(sessionModelState === undefined ? {} : { sessionModelState }),
      });

      await withHarness(async (harness) => {
        // The startup seed still runs: the table resolves the cheap preset.
        await waitFor(() => sidebarModels().explorer === 'openai/gpt-5-mini');

        // A child seen before any edit captures the startup profile.
        const pre = await captureFirstChild(harness, 'frozen-pre');
        expect(
          harness.switchCalls.find((call) => call.sessionID === pre)?.model.id,
        ).toBe('gpt-5-mini');

        // Global refresh remains enabled, but a disk flag edit requires restart.
        env.writeUserConfig({ sessionModelState: true, ...hot('strong') });
        writeOperation('parent-1', 'cheap', 'switch', 'stale-on-marker');
        await waitFor(
          () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
        );

        // New siblings and nested children capture the latest global defaults.
        const post = await captureFirstChild(harness, 'frozen-post');
        expect(
          harness.switchCalls.find((call) => call.sessionID === post)?.model.id,
        ).toBe('claude-sonnet-4-5');
        harness.parents.set('new-grandchild', pre);
        await harness.invokePrompt({
          sessionID: 'new-grandchild',
          prompt: { text: 'nested' },
        });
        expect(
          harness.switchCalls.find(
            (call) => call.sessionID === 'new-grandchild',
          )?.model.id,
        ).toBe('claude-sonnet-4-5');
        expect(
          harness.switchCalls.filter((call) => call.sessionID === pre),
        ).toHaveLength(1);
        expect(
          readTuiSnapshot(env.projectDir).sessionAgentModels['parent-1'],
        ).toBeUndefined();
      });
    }, 20_000);
  }
});
