/**
 * TUI attach marker watcher.
 *
 * A TUI process drops a marker file into the project-scoped attach
 * directory (`tui-state.ts` `getTuiAttachDir`) whenever it STARTS viewing
 * a conversation (TUI boot — e.g. `opencode -s <id>` — or navigation to
 * another conversation). When `sessionModelState` is enabled, this watcher
 * debounces the directory events and fires
 * `onAttach(sessionID, marker)` once per operation identity. The captured
 * effective config, never the shared disk selection, binds unbound roots
 * on initialize and replaces only the explicit target on switch.
 *
 * All fs and callback failures are logged and swallowed: the watcher must
 * never throw into plugin setup or disposal.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getTuiAttachDir,
  readTuiAttachMarker,
  type TuiAttachMarker,
} from '../tui-state';
import { log } from '../utils/logger';

/** Debounce window for marker write bursts. */
export const TUI_ATTACH_DEBOUNCE_MS = 100;

/** Also used synchronously at prompt admission: fs.watch is only a prewarm. */
export function readTuiAttachMarkersForSession(
  directory: string,
  sessionID: string,
): TuiAttachMarker[] {
  return readMarkers(directory).filter(
    (marker) => marker.sessionID === sessionID,
  );
}

function readMarkers(directory: string): TuiAttachMarker[] {
  const dir = getTuiAttachDir(directory);
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readTuiAttachMarker(path.join(dir, entry)))
      .filter((marker): marker is TuiAttachMarker => marker !== null)
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          (a.revision ?? a.tuiBootID).localeCompare(b.revision ?? b.tuiBootID),
      );
  } catch {
    return [];
  }
}

export interface TuiAttachWatchHandle {
  /** Stop watching and await in-flight processing. Idempotent. */
  dispose(): Promise<void>;
}

export interface WatchTuiAttachMarkersOptions {
  /** Project directory whose attach directory is watched. */
  directory: string;
  /** Fired once per operation identity. Errors are caught and logged. */
  onAttach: (
    sessionID: string,
    marker: TuiAttachMarker,
  ) => void | Promise<void>;
  /** Test seam: debounce window (defaults to `TUI_ATTACH_DEBOUNCE_MS`). */
  debounceMs?: number;
  /** Test seam: override `fs.watch`. */
  watchImpl?: (
    dir: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => { close: () => void };
  /** Test seam: override the logger. */
  log?: (message: string, meta?: unknown) => void;
}

/**
 * Watch the attach directory of `directory` for marker files. Returns a
 * handle whose `dispose()` stops the watcher and awaits the active scan.
 * A missing directory is created up front; registration failures are
 * logged and degrade to no attach processing.
 */
export function watchTuiAttachMarkers(
  options: WatchTuiAttachMarkersOptions,
): TuiAttachWatchHandle {
  const emitLog = options.log ?? log;
  const debounceMs = options.debounceMs ?? TUI_ATTACH_DEBOUNCE_MS;
  const attachDir = getTuiAttachDir(options.directory);
  /** Operation identity, not wall-clock time, controls deduplication. */
  const processed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void> | undefined;
  /** A marker event landed while a scan was in flight: one trailing scan. */
  let trailingScan = false;
  let watcher: { close: () => void } | undefined;
  let disposed = false;

  /** One directory scan (small: one marker file per session). */
  function scan(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (activeRun) {
      trailingScan = true;
      return activeRun;
    }
    const run = (async () => {
      for (const marker of readMarkers(options.directory)) {
        if (disposed) return;
        const identity = `${marker.sessionID}:${marker.revision ?? `${marker.tuiBootID}:${marker.timestamp}`}`;
        if (processed.has(identity)) continue;
        try {
          await options.onAttach(marker.sessionID, marker);
          processed.add(identity);
        } catch (err) {
          if (!disposed) {
            emitLog('[v2] tui-attach snapshot refresh failed', String(err));
          }
        }
      }
    })();
    activeRun = run;
    run.finally(() => {
      if (activeRun === run) activeRun = undefined;
    });
    return (async () => {
      await run;
      if (!disposed && trailingScan) {
        trailingScan = false;
        await scan();
      }
    })();
  }

  function schedule(): void {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) void scan();
    }, debounceMs);
  }

  try {
    // Create the dir up front: the TUI also creates it on write, but the
    // watch target must exist before `fs.watch` can bind.
    fs.mkdirSync(attachDir, { recursive: true });
    const watchFn =
      options.watchImpl ??
      ((
        dir: string,
        listener: (eventType: string, filename: string | null) => void,
      ) => fs.watch(dir, { persistent: false }, listener));
    watcher = watchFn(attachDir, () => schedule());
    // Startup files may predate registration and generate no watch event.
    void scan();
  } catch (err) {
    emitLog('[v2] tui-attach watcher registration failed', String(err));
  }

  return {
    async dispose() {
      if (disposed) {
        await activeRun?.catch(() => {});
        return;
      }
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch (err) {
          emitLog('[v2] tui-attach watcher close failed', String(err));
        }
        watcher = undefined;
      }
      await activeRun?.catch(() => {});
    },
  };
}
