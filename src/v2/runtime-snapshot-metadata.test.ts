import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPluginConfig } from '../config/loader';
import type { ResolvedPluginConfig } from '../config/schema';
import { OhMyOpenCodeLite, type V2ProfileRefreshResult } from '../index';
import { readTuiSnapshot, recordSessionAgentModels } from '../tui-state';
import {
  createSessionProfileBridge,
  type FrozenProfile,
  type V2RuntimeChains,
} from './runtime-profiles';

let directory: string;
let originalEnv: typeof process.env;

beforeEach(() => {
  originalEnv = { ...process.env };
  directory = mkdtempSync(path.join(tmpdir(), 'runtime-snapshot-'));
  const configDir = path.join(directory, 'config');
  mkdirSync(configDir);
  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  process.env.XDG_DATA_HOME = path.join(directory, 'data');
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache');
  process.env.OPENCODE_LOG_DIR = path.join(directory, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  writeConfig('original');
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(directory, { recursive: true, force: true });
});

function writeConfig(preset: string): void {
  writeFileSync(
    path.join(
      process.env.OPENCODE_CONFIG_DIR ?? '',
      'oh-my-opencode-slim.json',
    ),
    JSON.stringify({
      autoUpdate: false,
      preset,
      presets: {
        original: { explorer: { model: 'original/primary' } },
        alternate: { explorer: { model: 'alternate/primary' } },
      },
    }),
  );
}

test('root sidebar metadata carries the exact resolved snapshot preset and clears absent selections', async () => {
  const noop = async () => ({});
  const domain = new Proxy({}, { get: () => noop });
  const hooks = await OhMyOpenCodeLite({
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
    client: new Proxy(
      { app: { log: noop } },
      {
        get: (target, key) => (key === 'app' ? target.app : domain),
      },
    ),
  } as never);
  try {
    const resolve = (
      hooks as unknown as {
        'v2.resolveProfiles': (options?: {
          config?: ResolvedPluginConfig;
        }) => Promise<V2ProfileRefreshResult>;
      }
    )['v2.resolveProfiles'];
    const original = loadPluginConfig(directory);
    writeConfig('alternate');
    const bridge = createSessionProfileBridge({
      sessionModelState: true,
      profiles: () => ({}),
      pluginAgents: new Set(['orchestrator']),
      session: { get: async () => ({ agent: 'orchestrator' }) } as never,
      resolveFreshProfiles: (options) =>
        resolve(
          options as {
            config?: ResolvedPluginConfig;
          },
        ),
      onRootSnapshot: (id, projection) =>
        recordSessionAgentModels(directory, id, projection),
    });
    await bridge.refreshRootSnapshot('root', {
      kind: 'initialize',
      config: original,
    });
    expect(readTuiSnapshot(directory).sessionAgentModels.root?.preset).toBe(
      'original',
    );
    await bridge.refreshRootSnapshot('root', {
      kind: 'switch',
      config: loadPluginConfig(directory),
    });
    expect(readTuiSnapshot(directory).sessionAgentModels.root?.preset).toBe(
      'alternate',
    );
    const noPreset: ResolvedPluginConfig = {
      agents: { explorer: { model: 'plain/primary' } },
    };
    const resolved = await resolve({ config: noPreset });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(Object.hasOwn(resolved.projection, 'preset')).toBe(false);
    await bridge.refreshRootSnapshot('root', {
      kind: 'switch',
      config: noPreset,
    });
    const recorded = readTuiSnapshot(directory).sessionAgentModels.root;
    expect(recorded?.agentModels.explorer).toBe('plain/primary');
    expect(Object.hasOwn(recorded ?? {}, 'preset')).toBe(false);
  } finally {
    await hooks.dispose?.();
  }
});

test('failed capture discards dispatch state and retry inherits the new parent snapshot', async () => {
  const snapshots = new Map<string, Record<string, FrozenProfile>>();
  const dispatchChains = new Map<string, V2RuntimeChains>();
  let failSwitch = true;
  let released = false;
  const bridge = createSessionProfileBridge({
    sessionModelState: true,
    profiles: () => ({}),
    snapshots,
    pluginAgents: new Set(['orchestrator', 'explorer']),
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        sessionID === 'root'
          ? { agent: 'orchestrator' }
          : { agent: 'explorer', parentID: 'root' },
      switchModel: async () => {
        if (failSwitch) throw new Error('switch failed');
      },
    } as never,
    resolveFreshProfiles: async (options) => {
      const preset = options?.config?.preset ?? 'original';
      return {
        ok: true,
        profiles: {
          explorer: {
            model: { providerID: preset, id: 'primary' },
            sidebarModel: `${preset}/primary`,
          },
        },
        chains: { explorer: [{ id: `${preset}/backup` }] },
        projection: { agentModels: {}, agentVariants: {}, preset },
      };
    },
    onSessionCaptured: (id, chains) => {
      if (chains) dispatchChains.set(id, chains);
    },
    onSessionCaptureFailed: (id) => {
      released = true;
      dispatchChains.delete(id);
    },
  });
  await bridge.refreshRootSnapshot('root');
  await expect(bridge.ensureSessionProfile('child')).rejects.toThrow(
    'switch failed',
  );
  expect(released).toBe(true);
  expect(snapshots.has('child')).toBe(false);
  expect(dispatchChains.has('child')).toBe(false);
  expect(bridge.profileForSession('child')).toBeUndefined();
  await bridge.refreshRootSnapshot('root', {
    kind: 'switch',
    config: { preset: 'alternate' },
  });
  failSwitch = false;
  await bridge.ensureSessionProfile('child');
  expect(bridge.profileForSession('child')?.model?.providerID).toBe(
    'alternate',
  );
  expect(dispatchChains.get('child')?.explorer).toEqual([
    { id: 'alternate/backup' },
  ]);
  expect(snapshots.get('child')).toBe(snapshots.get('root'));
});
