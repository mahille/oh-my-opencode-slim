import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearTuiAgentActivities,
  clearTuiSessionAlias,
  getTuiAttachDir,
  getTuiAttachMarkerPath,
  getTuiStatePath,
  readTuiAttachMarker,
  readTuiSnapshot,
  readTuiSnapshotAsync,
  recordSessionAgentModels,
  recordTuiAgentActivity,
  recordTuiAgentModel,
  recordTuiAgentModels,
  recordTuiSessionParent,
  resolveTuiSnapshotRoot,
  snapshotSectionsEqual,
  TUI_SESSION_AGENT_MODELS_MAX,
  TUI_SESSION_PARENTS_MAX,
  updateSnapshot,
  updateTuiSessionDetails,
  writeTuiAttachMarker,
} from './tui-state';
import {
  readTuiAttachMarkersForSession,
  watchTuiAttachMarkers,
} from './v2/tui-attach';

let previousXdgDataHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-state-'));
  process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

const LUNA = { agentName: 'explorer', model: 'openai/gpt-6-luna' } as const;
const GPT = { agentName: 'explorer', model: 'openai/gpt-6' } as const;

function recordLuna(): void {
  recordTuiAgentModel(LUNA, tempDir);
}

describe('tui-state persistence', () => {
  test('readTuiSnapshotAsync caches by stat and invalidates on write', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.agentModels.explorer).toBe(LUNA.model);

    // Same stat (dev:ino:mtimeMs:size) → cached snapshot object identity.
    const second = await readTuiSnapshotAsync(tempDir);
    expect(second).toBe(first);

    // A real write publishes via tmp+rename (new inode) → cache miss and
    // the updated content is observed by the next poll.
    recordTuiAgentModel(GPT, tempDir);
    const third = await readTuiSnapshotAsync(tempDir);
    expect(third).not.toBe(first);
    expect(third.agentModels.explorer).toBe(GPT.model);
  });

  test('readTuiSnapshotAsync cache is bounded (LRU eviction)', async () => {
    recordTuiAgentModel(LUNA, tempDir);
    const first = await readTuiSnapshotAsync(tempDir);
    expect(first.agentModels.explorer).toBe(LUNA.model);

    // Poll 8 other projects: the first entry must be evicted even though
    // its file is unchanged (a fresh read returns a new object identity).
    for (let i = 0; i < 8; i += 1) {
      const dir = path.join(tempDir, `project-${i}`);
      recordTuiAgentModel(GPT, dir);
      await readTuiSnapshotAsync(dir);
    }

    const reRead = await readTuiSnapshotAsync(tempDir);
    expect(reRead.agentModels.explorer).toBe(LUNA.model);
    expect(reRead).not.toBe(first);
  });

  test('persists enabled agent models', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          explorer: 'openai/gpt-6-luna',
          fixer: 'openai/gpt-6-luna',
        },
        agentVariants: {
          explorer: 'low',
          fixer: 'high',
        },
      },
      tempDir,
    );

    const snapshot = readTuiSnapshot(tempDir);

    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
      fixer: 'openai/gpt-6-luna',
    });
    expect(snapshot.agentVariants).toEqual({
      explorer: 'low',
      fixer: 'high',
    });
  });

  test('persists canonical-to-display names and keeps them on model-only writes', () => {
    recordTuiAgentModels(
      {
        agentModels: { arbiter: 'openai/gpt-6' },
        agentDisplayNames: { arbiter: 'reviewer' },
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentDisplayNames).toEqual({
      arbiter: 'reviewer',
    });

    // A writer that only carries models must not wipe the label map.
    recordTuiAgentModels(
      {
        agentModels: { arbiter: 'openai/gpt-6', paladin: 'openai/gpt-6' },
      },
      tempDir,
    );
    expect(readTuiSnapshot(tempDir).agentDisplayNames).toEqual({
      arbiter: 'reviewer',
    });
  });

  test('updates a single live agent model without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-6-luna',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'openai/gpt-6',
      explorer: 'openai/gpt-6-luna',
    });
  });

  test('updates a single live agent variant without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-6-luna',
        },
        agentVariants: {
          explorer: 'low',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-6',
        variant: 'high',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentVariants).toEqual({
      orchestrator: 'high',
      explorer: 'low',
    });
  });

  test('tracks concurrent activity by session without clearing the agent early', () => {
    recordTuiAgentActivity(
      { sessionID: 'fixer-a', agentName: 'fixer', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'fixer-b', agentName: 'fixer', active: true },
      tempDir,
    );

    recordTuiAgentActivity({ sessionID: 'fixer-a', active: false }, tempDir);

    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
      'fixer-b': 'fixer',
    });
  });

  test('does not restore stale activity during concurrent process cleanup', async () => {
    recordTuiAgentActivity(
      { sessionID: 'oracle-a', agentName: 'oracle', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'explorer-b', agentName: 'explorer', active: true },
      tempDir,
    );

    const barrierDir = path.join(tempDir, 'cleanup-barrier');
    const readReleasePath = path.join(barrierDir, 'read-release');
    const startReleasePath = path.join(barrierDir, 'start-release');
    fs.mkdirSync(barrierDir, { recursive: true });
    const statePath = getTuiStatePath(tempDir);
    const moduleUrl = new URL('./tui-state.ts', import.meta.url).href;
    const workerSource = `
      import { mock } from 'bun:test';
      import fs from 'node:fs';

      const originalReadFileSync = fs.readFileSync.bind(fs);
      let paused = false;
      mock.module('node:fs', () => ({
        ...fs,
        readFileSync: (...args) => {
          const value = originalReadFileSync(...args);
          if (
            !paused &&
            String(args[0]) === process.env.TUI_STATE_PATH &&
            !fs.existsSync(process.env.TUI_STATE_LOCK_PATH)
          ) {
            paused = true;
            fs.writeFileSync(process.env.READ_MARKER, 'ready');
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(process.env.READ_RELEASE)) {
              Atomics.wait(sleeper, 0, 0, 10);
            }
          }
          return value;
        },
      }));

      const { recordTuiAgentActivity } = await import(
        process.env.TUI_STATE_MODULE_URL
      );
      fs.writeFileSync(process.env.START_MARKER, 'ready');
      const starter = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.env.START_RELEASE)) {
        Atomics.wait(starter, 0, 0, 10);
      }
      recordTuiAgentActivity(
        { sessionID: process.env.SESSION_ID, active: false },
        process.env.PROJECT_DIR,
      );
    `;
    const sessions = ['oracle-a', 'explorer-b'];
    const workers = sessions.map((sessionID, index) =>
      Bun.spawn([process.execPath, '-e', workerSource], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          PROJECT_DIR: tempDir,
          READ_MARKER: path.join(barrierDir, `read-${index}`),
          READ_RELEASE: readReleasePath,
          SESSION_ID: sessionID,
          START_MARKER: path.join(barrierDir, `start-${index}`),
          START_RELEASE: startReleasePath,
          TUI_STATE_MODULE_URL: moduleUrl,
          TUI_STATE_LOCK_PATH: `${statePath}.lock`,
          TUI_STATE_PATH: statePath,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    );

    const deadline = Date.now() + 5_000;
    while (
      !workers.every((_, index) =>
        fs.existsSync(path.join(barrierDir, `start-${index}`)),
      )
    ) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for cleanup workers to start');
      }
      await Bun.sleep(10);
    }
    fs.writeFileSync(startReleasePath, 'release');

    while (workers.some((worker) => worker.exitCode === null)) {
      const allReadsPaused = workers.every((_, index) =>
        fs.existsSync(path.join(barrierDir, `read-${index}`)),
      );
      if (allReadsPaused) {
        fs.writeFileSync(readReleasePath, 'release');
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for concurrent cleanup');
      }
      await Bun.sleep(10);
    }

    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    for (const [index, exitCode] of exitCodes.entries()) {
      if (exitCode !== 0) {
        const stderr = await new Response(workers[index]?.stderr).text();
        throw new Error(`Cleanup worker ${index} failed: ${stderr}`);
      }
    }

    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({});
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  test('recovers an abandoned state lock', () => {
    const statePath = getTuiStatePath(tempDir);
    const lockPath = `${statePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{}');
    const staleTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(lockPath, staleTime, staleTime);

    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(
      'openai/gpt-6-luna',
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('recovers an aged state lock whose recorded PID is alive', () => {
    const lockPath = `${getTuiStatePath(tempDir)}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    const staleTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(lockPath, staleTime, staleTime);

    recordLuna();

    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(LUNA.model);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('scopes recorded activity to the owning conversation tree', () => {
    recordTuiSessionParent('child-a', 'conv-1', tempDir);
    recordTuiSessionParent('child-b', 'conv-2', tempDir);
    recordTuiAgentActivity(
      { sessionID: 'child-a', agentName: 'oracle', active: true },
      tempDir,
    );
    recordTuiAgentActivity(
      { sessionID: 'child-b', agentName: 'fixer', active: true },
      tempDir,
    );

    // Roots resolve through the persistent index; render compares both
    // sides against it, so conv-2's subagents stay out of conv-1 (#1147).
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'conv-1',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-b')).toBe(
      'conv-2',
    );
    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
      'child-a': 'oracle',
      'child-b': 'fixer',
    });
  });

  function seedSessionParents(count: number): void {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        ...readTuiSnapshot(tempDir),
        sessionParents: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `ses_${i}`,
            i ? `ses_${i - 1}` : 'root',
          ]),
        ),
      }),
    );
  }

  test('caps session parents on any write, refreshing re-registered links', () => {
    seedSessionParents(TUI_SESSION_PARENTS_MAX + 2);

    recordLuna();
    expect(readTuiSnapshot(tempDir).sessionParents.ses_1).toBeUndefined();
    recordTuiSessionParent('ses_2', 'root', tempDir);
    recordTuiSessionParent('ses_new', 'root', tempDir);

    const { sessionParents } = readTuiSnapshot(tempDir);
    expect(Object.keys(sessionParents)).toHaveLength(TUI_SESSION_PARENTS_MAX);
    expect(sessionParents.ses_2).toBe('root');
    expect(sessionParents.ses_3).toBeUndefined();
    expect(sessionParents.ses_new).toBe('root');
  });

  test('keeps the ancestry of an active session past the cap', () => {
    seedSessionParents(TUI_SESSION_PARENTS_MAX + 1);
    recordTuiAgentActivity(
      { sessionID: 'ses_1', agentName: 'explorer', active: true },
      tempDir,
    );

    recordTuiSessionParent('ses_new', 'root', tempDir);

    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'ses_1')).toBe(
      'root',
    );
  });

  test('resolves multi-level ancestry through the index', () => {
    recordTuiSessionParent('grandchild', 'child', tempDir);
    recordTuiSessionParent('child', 'root', tempDir);

    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'grandchild')).toBe(
      'root',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child')).toBe(
      'root',
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'root')).toBe(
      'root',
    );
  });

  test('re-roots a live activity when ancestry is discovered late', () => {
    // Revived/restarted session recorded before its parent was known.
    recordTuiAgentActivity(
      { sessionID: 'child-a', agentName: 'oracle', active: true },
      tempDir,
    );
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'child-a',
    );

    recordTuiSessionParent('child-a', 'root-a', tempDir);

    expect(readTuiSnapshot(tempDir).sessionParents['child-a']).toBe('root-a');
    expect(resolveTuiSnapshotRoot(readTuiSnapshot(tempDir), 'child-a')).toBe(
      'root-a',
    );
  });

  test('startup sweep keeps live foreign activities and drops dead residue', async () => {
    const dead = Bun.spawn(['true']);
    await dead.exited;
    const live = Bun.spawn(['sleep', '30']);
    try {
      const statePath = getTuiStatePath(tempDir);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        `${JSON.stringify({
          version: 1,
          updatedAt: Date.now(),
          agentModels: {},
          agentVariants: {},
          activeSessions: {
            'dead-a': 'oracle',
            'live-b': 'fixer',
            'legacy-c': 'explorer',
          },
          activityPids: {
            'dead-a': dead.pid,
            'live-b': live.pid,
          },
        })}\n`,
      );

      clearTuiAgentActivities(tempDir);

      expect(readTuiSnapshot(tempDir).activeSessions).toEqual({
        'live-b': 'fixer',
      });
    } finally {
      live.kill();
    }
  });

  test('startup sweep keeps live own-PID activity and still drops dead residue', () => {
    recordTuiAgentModels(
      { agentModels: { explorer: 'openai/gpt-6-luna' } },
      tempDir,
    );
    recordTuiAgentActivity(
      {
        sessionID: 'explorer-a',
        agentName: 'explorer',
        active: true,
        details: { alias: 'exp-1' },
      },
      tempDir,
    );

    clearTuiAgentActivities(tempDir);

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.activeSessions).toEqual({ 'explorer-a': 'explorer' });
    expect(snapshot.sessionDetails['explorer-a']?.alias).toBe('exp-1');
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });
  });

  test('ignores legacy config status fields in old snapshots', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-6-luna' },
        configInvalid: true,
        configInvalidByProject: { old: true },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });
    expect(snapshot.agentVariants).toEqual({});
    expect(snapshot.activeSessions).toEqual({});
  });

  test('parseSnapshot tolerates a snapshot without reusableByAgent (defaults {})', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-6-luna' },
        // Pre-dot snapshot: no reusableByAgent key at all.
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent).toEqual({});
    // Sibling sections still parse.
    expect(snapshot.agentModels.explorer).toBe('openai/gpt-6-luna');
  });

  test('parseSnapshot restores a well-formed reusableByAgent section', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        reusableByAgent: {
          'parent-1': {
            oracle: [
              {
                taskID: 'ses_1',
                alias: 'ora-1',
                terminalState: 'completed',
                completedAt: 200,
                lastUsedAt: 300,
              },
              {
                taskID: 'ses_2',
                alias: 'ora-2',
                terminalState: 'stopped',
                lastUsedAt: 400,
              },
              {
                taskID: 'ses_invalid',
                alias: 'ora-3',
                terminalState: 'unknown',
                lastUsedAt: 500,
              },
              {
                taskID: 'ses_no_timestamp',
                alias: 'ora-4',
                terminalState: 'stopped',
              },
            ],
          },
        },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent['parent-1']?.oracle).toEqual([
      {
        taskID: 'ses_1',
        alias: 'ora-1',
        terminalState: 'completed',
        completedAt: 200,
        lastUsedAt: 300,
      },
      {
        taskID: 'ses_2',
        alias: 'ora-2',
        terminalState: 'stopped',
        lastUsedAt: 400,
      },
    ]);
  });

  test('parseSnapshot drops malformed reusableByAgent entries', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        reusableByAgent: {
          'parent-1': {
            oracle: { taskID: 'ses_1' }, // missing alias/lastUsedAt
            fixer: null,
          },
          'parent-2': 'not-an-object',
        },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.reusableByAgent).toEqual({});
  });

  test('snapshotSectionsEqual includes reusableByAgent', () => {
    const base = readTuiSnapshot(tempDir);
    const sameAgentModels = readTuiSnapshot(tempDir);
    sameAgentModels.reusableByAgent['parent-1'] = {
      oracle: [
        {
          taskID: 'ses_1',
          alias: 'ora-1',
          terminalState: 'completed',
          lastUsedAt: 300,
        },
      ],
    };
    // A reusableByAgent-only difference must break equality…
    expect(snapshotSectionsEqual(base, sameAgentModels)).toBe(false);

    // …and identical sections (both empty) stay equal.
    const alsoEmpty = readTuiSnapshot(tempDir);
    expect(snapshotSectionsEqual(base, alsoEmpty)).toBe(true);
  });

  test('memoized updates deep-clone nested reusableByAgent arrays', () => {
    const entry = (taskID: string) => ({
      taskID,
      alias: taskID,
      terminalState: 'completed' as const,
      lastUsedAt: 1,
    });
    // First write seeds the in-memory memo with a nested entry array.
    expect(
      updateSnapshot(tempDir, (snapshot) => {
        snapshot.reusableByAgent['parent-1'] = { oracle: [entry('ses_1')] };
      }),
    ).toBe(true);
    // An in-place push on the memo-backed candidate must not leak into the
    // memo: a shared array would make the update look like a no-op and
    // silently skip the disk write.
    expect(
      updateSnapshot(tempDir, (snapshot) => {
        snapshot.reusableByAgent['parent-1']?.oracle?.push(entry('ses_2'));
      }),
    ).toBe(true);

    const onDisk = JSON.parse(
      fs.readFileSync(getTuiStatePath(tempDir), 'utf8'),
    ) as { reusableByAgent: Record<string, Record<string, unknown[]>> };
    expect(
      onDisk.reusableByAgent['parent-1']?.oracle?.map(
        (item) => (item as { taskID: string }).taskID,
      ),
    ).toEqual(['ses_1', 'ses_2']);
  });

  test('cross-project isolation — different directories write independent state files', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-b-'));
    try {
      recordTuiAgentModels({ agentModels: { explorer: 'model-a' } }, dirA);
      recordTuiAgentModels({ agentModels: { explorer: 'model-b' } }, dirB);

      expect(readTuiSnapshot(dirA).agentModels.explorer).toBe('model-a');
      expect(readTuiSnapshot(dirB).agentModels.explorer).toBe('model-b');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('skips the disk write when the recorded value is unchanged', () => {
    recordLuna();
    const filePath = getTuiStatePath(tempDir);
    const oldMtime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, oldMtime, oldMtime);
    const baselineMtime = fs.statSync(filePath).mtimeMs;
    recordLuna();
    expect(fs.statSync(filePath).mtimeMs).toBe(baselineMtime);
  });

  test('repeated no-op updates do not touch the lock or the filesystem', async () => {
    recordLuna();
    const fsModule = await import('node:fs');
    let openCalls = 0;
    let readCalls = 0;
    const lockCreateSpy = spyOn(fsModule, 'openSync').mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        openCalls += 1;
        return fs.openSync(...args);
      },
    );
    const readSpy = spyOn(fsModule, 'readFileSync').mockImplementation(
      (...args: Parameters<typeof fs.readFileSync>) => {
        readCalls += 1;
        return fs.readFileSync(...args);
      },
    );
    try {
      recordLuna();
      recordLuna();
      expect(openCalls).toBe(0);
      expect(readCalls).toBe(0);
    } finally {
      lockCreateSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test('a real change after a no-op still reaches the disk', () => {
    recordLuna();
    recordLuna();
    recordTuiAgentModel(GPT, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(GPT.model);
  });

  test('external snapshot changes are not masked by the memo', () => {
    recordLuna();
    const external = readTuiSnapshot(tempDir);
    external.agentModels.builder = GPT.model;
    fs.writeFileSync(getTuiStatePath(tempDir), `${JSON.stringify(external)}\n`);
    recordTuiAgentModel(
      { agentName: 'build', model: 'anthropic/claude-x' },
      tempDir,
    );
    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels.builder).toBe(GPT.model);
    expect(snapshot.agentModels.build).toBe('anthropic/claude-x');
  });

  test('a failed persistence is retried, not swallowed by the memo', async () => {
    recordLuna();
    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      recordTuiAgentModel(GPT, tempDir);
    } finally {
      renameSpy.mockRestore();
    }
    recordTuiAgentModel(GPT, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe(GPT.model);
  });

  test('external atomic replacement invalidates the memo even with identical mtime and size', () => {
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const filePath = getTuiStatePath(tempDir);
    const external = readTuiSnapshot(tempDir);
    external.agentModels.explorer = 'model-y';
    const tmpPath = `${filePath}.external.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(external)}\n`);
    const stat = fs.statSync(filePath);
    fs.renameSync(tmpPath, filePath);
    fs.utimesSync(filePath, stat.atime, stat.mtime);
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe('model-x');
  });

  test('in-place rewrite preserving mtime is caught by ctime', () => {
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const filePath = getTuiStatePath(tempDir);

    // Pin mtime to a whole-millisecond date (utimes cannot restore
    // sub-millisecond precision), then re-prime the memo so it holds a
    // stat snapshot of this exact state.
    const pinned = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, pinned, pinned);
    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    const statBefore = fs.statSync(filePath);

    // In-place rewrite (same inode, same length): mtime restored via
    // utimes. ctime cannot be restored by userspace, so the memo must
    // invalidate and re-record the value from the real file.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleeper, 0, 0, 10);
    const external = readTuiSnapshot(tempDir);
    external.agentModels.explorer = 'model-y';
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, `${JSON.stringify(external)}\n`);
    fs.closeSync(fd);
    fs.utimesSync(filePath, statBefore.atime, statBefore.mtime);
    const statAfter = fs.statSync(filePath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

    recordTuiAgentModel({ agentName: 'explorer', model: 'model-x' }, tempDir);
    expect(readTuiSnapshot(tempDir).agentModels.explorer).toBe('model-x');
  });

  test('a transient read failure does not seed the memo with an empty snapshot', async () => {
    recordTuiAgentActivity(
      { sessionID: 's1', agentName: 'oracle', active: true },
      tempDir,
    );
    const filePath = getTuiStatePath(tempDir);
    const fsModule = await import('node:fs');
    const originalRead = fsModule.readFileSync;
    const readSpy = spyOn(fsModule, 'readFileSync').mockImplementation(
      (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(path) === filePath) {
          const err = new Error('transient') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return originalRead(path as fs.PathOrFileDescriptor, ...(args as []));
      },
    );
    try {
      recordTuiAgentActivity({ sessionID: 's1', active: false }, tempDir);
    } finally {
      readSpy.mockRestore();
    }
    recordTuiAgentActivity({ sessionID: 's1', active: false }, tempDir);
    expect(readTuiSnapshot(tempDir).activeSessions).toEqual({});
  });

  test('keeps the final file intact when the atomic rename fails', async () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      recordTuiAgentModel(
        { agentName: 'explorer', model: 'openai/gpt-6' },
        tempDir,
      );
    } finally {
      renameSpy.mockRestore();
    }

    // The previously written state must still be readable in full.
    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      explorer: 'openai/gpt-6-luna',
    });

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('leaves no temp files behind on the happy path', () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-6-luna' },
      tempDir,
    );

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('sessionDetails (clickable sidebar projection)', () => {
  test('activation with details round-trips alias/status', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'ora-1-ses',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1', status: 'busy' },
      },
      tempDir,
    );
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      'ora-1-ses': { alias: 'ora-1', status: 'busy' },
    });
  });

  test('deactivation removes details together with the activity', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'ora-1-ses',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1' },
      },
      tempDir,
    );
    recordTuiAgentActivity({ sessionID: 'ora-1-ses', active: false }, tempDir);
    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.activeSessions).toEqual({});
    expect(snapshot.sessionDetails).toEqual({});
  });

  test('detail updates only apply to active sessions (no resurrection)', () => {
    // Idle first: a late detail update must not recreate the entry.
    recordTuiAgentActivity({ sessionID: 'gone', active: false }, tempDir);
    updateTuiSessionDetails('gone', { alias: 'ora-9' }, tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({});

    // Active session: updates merge into existing details.
    recordTuiAgentActivity(
      { sessionID: 'live', agentName: 'oracle', active: true },
      tempDir,
    );
    updateTuiSessionDetails('live', { alias: 'ora-1' }, tempDir);
    updateTuiSessionDetails('live', { status: 'retry' }, tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      live: { alias: 'ora-1', status: 'retry' },
    });
  });

  test('clearTuiSessionAlias retracts only the alias, keeping status', () => {
    recordTuiAgentActivity(
      {
        sessionID: 'live',
        agentName: 'oracle',
        active: true,
        details: { alias: 'ora-1', status: 'busy' },
      },
      tempDir,
    );
    clearTuiSessionAlias('live', tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails).toEqual({
      live: { status: 'busy' },
    });
    // Alias-less entry with no other fields is removed entirely.
    recordTuiAgentActivity(
      {
        sessionID: 'bare',
        agentName: 'fixer',
        active: true,
        details: { alias: 'fix-1' },
      },
      tempDir,
    );
    clearTuiSessionAlias('bare', tempDir);
    expect(readTuiSnapshot(tempDir).sessionDetails.bare).toBeUndefined();
  });

  test('orphaned details are swept by clearTuiAgentActivities', () => {
    // Simulate a live foreign recorder (PID 1 is always running and is
    // never this process) plus an orphaned details entry with no activity.
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        activeSessions: { 'live-foreign': 'oracle' },
        activityPids: { 'live-foreign': 1 },
        sessionDetails: {
          'live-foreign': { alias: 'ora-7' },
          orphan: { alias: 'ora-8' },
        },
      })}\n`,
    );

    clearTuiAgentActivities(tempDir);
    const after = readTuiSnapshot(tempDir);
    expect(after.activeSessions).toEqual({ 'live-foreign': 'oracle' });
    expect(after.sessionDetails).toEqual({
      'live-foreign': { alias: 'ora-7' },
    });
  });

  test('parser drops malformed detail entries without losing valid ones', () => {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        sessionDetails: {
          good: { alias: 'ora-1', model: 'openai/gpt-6', status: 'busy' },
          oldModelOnly: { model: 'openai/gpt-6' },
          badStatus: { alias: 'ora-2', status: 'weird' },
          nonObject: 'nope',
          nullEntry: null,
          empty: {},
        },
      })}\n`,
    );
    const parsed = readTuiSnapshot(tempDir);
    expect(parsed.sessionDetails).toEqual({
      good: { alias: 'ora-1', status: 'busy' },
      badStatus: { alias: 'ora-2' },
    });
  });

  test('legacy snapshot without sessionDetails parses with an empty section', () => {
    const statePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: 1,
        agentModels: { oracle: 'openai/gpt-6' },
      })}\n`,
    );
    const parsed = readTuiSnapshot(tempDir);
    expect(parsed.sessionDetails).toEqual({});
    expect(parsed.agentModels).toEqual({ oracle: 'openai/gpt-6' });
  });
});

describe('sessionAgentModels (per-conversation sidebar projection)', () => {
  test('round-trips a conversation projection without touching the global rows', () => {
    recordTuiAgentModels(
      {
        agentModels: { explorer: 'openai/gpt-6-global' },
        agentVariants: { explorer: 'low' },
      },
      tempDir,
    );

    recordSessionAgentModels(tempDir, 'root-a', {
      agentModels: { explorer: 'openai/gpt-6-session' },
      agentVariants: { explorer: 'high' },
    });

    const snapshot = readTuiSnapshot(tempDir);
    // The global projection is untouched by the per-session writer.
    expect(snapshot.agentModels).toEqual({ explorer: 'openai/gpt-6-global' });
    expect(snapshot.agentVariants).toEqual({ explorer: 'low' });
    expect(snapshot.sessionAgentModels['root-a']).toEqual({
      agentModels: { explorer: 'openai/gpt-6-session' },
      agentVariants: { explorer: 'high' },
      updatedAt: expect.any(Number),
    });
  });

  test('re-recording a session refreshes its record, and empty agentVariants default', () => {
    recordSessionAgentModels(tempDir, 'root-a', {
      agentModels: { explorer: 'openai/gpt-6-a' },
      agentVariants: { explorer: 'low' },
    });
    recordSessionAgentModels(tempDir, 'root-a', {
      agentModels: { explorer: 'openai/gpt-6-b' },
    });

    const snapshot = readTuiSnapshot(tempDir);
    expect(Object.keys(snapshot.sessionAgentModels)).toEqual(['root-a']);
    expect(snapshot.sessionAgentModels['root-a']).toEqual({
      agentModels: { explorer: 'openai/gpt-6-b' },
      agentVariants: {},
      updatedAt: expect.any(Number),
    });
  });

  test('caps the projection map at the TUI_SESSION_AGENT_MODELS_MAX most recent', () => {
    for (let i = 0; i <= TUI_SESSION_AGENT_MODELS_MAX + 1; i += 1) {
      recordSessionAgentModels(tempDir, `root-${i}`, {
        agentModels: { explorer: `openai/model-${i}` },
      });
    }

    const { sessionAgentModels } = readTuiSnapshot(tempDir);
    expect(Object.keys(sessionAgentModels)).toHaveLength(
      TUI_SESSION_AGENT_MODELS_MAX,
    );
    // The two oldest records were evicted, the newest is kept.
    expect(sessionAgentModels['root-0']).toBeUndefined();
    expect(sessionAgentModels['root-1']).toBeUndefined();
    expect(
      sessionAgentModels[`root-${TUI_SESSION_AGENT_MODELS_MAX - 1}`],
    ).toBeDefined();
    expect(
      sessionAgentModels[`root-${TUI_SESSION_AGENT_MODELS_MAX + 1}`],
    ).toBeDefined();
  });

  test('snapshotSectionsEqual detects sessionAgentModels changes', () => {
    recordSessionAgentModels(tempDir, 'root-a', {
      agentModels: { explorer: 'openai/gpt-6' },
    });
    const base = readTuiSnapshot(tempDir);
    const changed = readTuiSnapshot(tempDir);
    changed.sessionAgentModels['root-a'].agentModels.explorer = 'openai/other';
    expect(snapshotSectionsEqual(base, changed)).toBe(false);

    const identical = readTuiSnapshot(tempDir);
    expect(snapshotSectionsEqual(base, identical)).toBe(true);
  });

  test('parseSnapshot reads legacy files without the section and drops malformed entries', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Legacy file: no sessionAgentModels key at all.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        agentModels: { explorer: 'openai/gpt-6' },
      }),
    );
    const legacy = readTuiSnapshot(tempDir);
    expect(legacy.sessionAgentModels).toEqual({});
    expect(legacy.agentModels).toEqual({ explorer: 'openai/gpt-6' });

    // Malformed entries are dropped without touching the valid ones.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        sessionAgentModels: {
          'good-root': {
            agentModels: { explorer: 'openai/gpt-6' },
            agentVariants: { explorer: 'low' },
            updatedAt: 5,
          },
          'missing-models': {
            agentVariants: { explorer: 'low' },
            updatedAt: 6,
          },
          'string-models': { agentModels: 'nope', updatedAt: 7 },
          nonObject: 'nope',
          nullEntry: null,
        },
      }),
    );
    expect(readTuiSnapshot(tempDir).sessionAgentModels).toEqual({
      'good-root': {
        agentModels: { explorer: 'openai/gpt-6' },
        agentVariants: { explorer: 'low' },
        updatedAt: 5,
      },
    });
  });
});

describe('tui attach markers', () => {
  test('immutable operations distinguish equal timestamps and predate watcher registration', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
    const config = { preset: 'A', agents: { explorer: { model: 'openai/a' } } };
    try {
      expect(
        writeTuiAttachMarker(tempDir, 'ses_a', { kind: 'initialize', config }),
      ).toBe(true);
      config.preset = 'B';
      expect(
        writeTuiAttachMarker(tempDir, 'ses_a', { kind: 'switch', config }),
      ).toBe(true);
      const pending = readTuiAttachMarkersForSession(tempDir, 'ses_a');
      expect(pending.map((marker) => marker.kind)).toEqual([
        'initialize',
        'switch',
      ]);
      expect(pending.map((marker) => marker.config?.preset)).toEqual([
        'A',
        'B',
      ]);
      expect(pending[0].timestamp).toBe(pending[1].timestamp);
      expect(pending[0].revision).not.toBe(pending[1].revision);
      expect(readTuiAttachMarkersForSession(tempDir, 'ses_b')).toEqual([]);
      const seen: string[] = [];
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const handle = watchTuiAttachMarkers({
        directory: tempDir,
        watchImpl: () => ({ close() {} }),
        onAttach: (sessionID, marker) => {
          expect(sessionID).toBe('ses_a');
          seen.push(marker.config?.preset ?? 'missing');
          if (seen.length === 2) complete();
        },
      });
      await done;
      await handle.dispose();
      expect(seen).toEqual(['A', 'B']);
    } finally {
      clock.mockRestore();
    }
  });

  test('later initialize retains a pending switch and pinned preset labels roundtrip', () => {
    writeTuiAttachMarker(tempDir, 'ses_a', {
      kind: 'switch',
      config: { preset: 'B' },
    });
    writeTuiAttachMarker(tempDir, 'ses_a', {
      kind: 'initialize',
      config: { preset: 'A' },
    });
    expect(
      readTuiAttachMarkersForSession(tempDir, 'ses_a').map(
        (marker) => marker.kind,
      ),
    ).toEqual(['switch', 'initialize']);
    recordSessionAgentModels(tempDir, 'ses_a', {
      agentModels: {},
      preset: 'B',
    });
    expect(readTuiSnapshot(tempDir).sessionAgentModels.ses_a.preset).toBe('B');
  });

  test('writeTuiAttachMarker creates the marker directory and roundtrips', () => {
    const attachDir = getTuiAttachDir(tempDir);
    expect(fs.existsSync(attachDir)).toBe(false);

    expect(writeTuiAttachMarker(tempDir, 'ses_boot')).toBe(true);
    expect(fs.existsSync(attachDir)).toBe(true);

    const markerPath = getTuiAttachMarkerPath(tempDir, 'ses_boot');
    const marker = readTuiAttachMarker(markerPath);
    expect(marker).toEqual({
      sessionID: 'ses_boot',
      tuiBootID: expect.any(String),
      timestamp: expect.any(Number),
      revision: expect.any(String),
    });
    expect(marker?.tuiBootID).toHaveLength(36);
    expect(marker?.timestamp).toBeGreaterThan(0);
  });

  test('rewriting a marker overwrites the previous one with a newer timestamp', () => {
    expect(writeTuiAttachMarker(tempDir, 'ses_nav')).toBe(true);
    const first = readTuiAttachMarker(
      getTuiAttachMarkerPath(tempDir, 'ses_nav'),
    );
    expect(first).not.toBeNull();

    // Same TUI process boot id across rewrites of the same session.
    expect(writeTuiAttachMarker(tempDir, 'ses_nav')).toBe(true);
    const second = readTuiAttachMarker(
      getTuiAttachMarkerPath(tempDir, 'ses_nav'),
    );
    expect(second).not.toBeNull();
    expect(second?.tuiBootID).toBe(first?.tuiBootID);
    expect(second?.timestamp).toBeGreaterThanOrEqual(first?.timestamp ?? 0);
  });

  test('markers are scoped per project directory', () => {
    const otherProject = path.join(tempDir, 'other-project');
    expect(writeTuiAttachMarker(tempDir, 'ses_x')).toBe(true);
    expect(fs.existsSync(getTuiAttachMarkerPath(otherProject, 'ses_x'))).toBe(
      false,
    );
    expect(
      readTuiAttachMarker(getTuiAttachMarkerPath(otherProject, 'ses_x')),
    ).toBeNull();
  });

  test('empty sessionID is not written', () => {
    expect(writeTuiAttachMarker(tempDir, '')).toBe(false);
    expect(fs.existsSync(getTuiAttachDir(tempDir))).toBe(false);
  });

  test('readTuiAttachMarker ignores malformed and missing markers', () => {
    const attachDir = getTuiAttachDir(tempDir);
    fs.mkdirSync(attachDir, { recursive: true });

    // Missing file.
    expect(readTuiAttachMarker(path.join(attachDir, 'nope.json'))).toBeNull();

    // Invalid JSON.
    fs.writeFileSync(path.join(attachDir, 'bad-1.json'), '{not json');
    expect(readTuiAttachMarker(path.join(attachDir, 'bad-1.json'))).toBeNull();

    // Valid JSON, wrong shape.
    fs.writeFileSync(
      path.join(attachDir, 'bad-2.json'),
      JSON.stringify({ sessionID: 42, tuiBootID: 'x', timestamp: 1 }),
    );
    expect(readTuiAttachMarker(path.join(attachDir, 'bad-2.json'))).toBeNull();
    fs.writeFileSync(
      path.join(attachDir, 'bad-3.json'),
      JSON.stringify({ sessionID: 'ses_y', timestamp: 1 }),
    );
    expect(readTuiAttachMarker(path.join(attachDir, 'bad-3.json'))).toBeNull();
    fs.writeFileSync(path.join(attachDir, 'bad-4.json'), JSON.stringify(null));
    expect(readTuiAttachMarker(path.join(attachDir, 'bad-4.json'))).toBeNull();

    // A valid marker next to the malformed ones still parses.
    expect(writeTuiAttachMarker(tempDir, 'ses_y')).toBe(true);
    expect(
      readTuiAttachMarker(getTuiAttachMarkerPath(tempDir, 'ses_y')),
    ).toEqual(expect.objectContaining({ sessionID: 'ses_y' }));
  });
});
