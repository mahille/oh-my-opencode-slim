#!/usr/bin/env bun
/**
 * Real, offline v2 TUI smoke. Run after building dist:
 * bun scripts/verify-preset-session-isolation.ts
 * OPENCODE_SMOKE_BIN overrides opencode2 on PATH; tmux must be on PATH.
 * OPENCODE_SMOKE_SESSION_MODEL_STATE=true (smoke default) opts into isolation;
 * false writes the disabled flag; default omits it and tests global behavior.
 * Run all three values after building. The global watcher is always enabled.
 * OPENCODE_SMOKE_ATTACH_ONLY=true skips B's warmup/resume to test its first
 * prompt after A switches. Both roots are precreated (Home-first startup is
 * not exercised). Enabled mode requires initial attach-only root snapshots;
 * disabled/default modes require no root records or markers. Artifacts remain in
 * /tmp/opencode on success and failure. No user config/service is accessed.
 * Bounded predicate polling uses platform timers because these are external
 * processes/terminal renders, not unit tests with an injectable scheduler.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dir, '..');
const binary = process.env.OPENCODE_SMOKE_BIN || 'opencode2';
const sessionModelStateMode =
  process.env.OPENCODE_SMOKE_SESSION_MODEL_STATE ?? 'true';
if (!['true', 'false', 'default'].includes(sessionModelStateMode)) {
  throw new Error(
    'OPENCODE_SMOKE_SESSION_MODEL_STATE must be true/false/default',
  );
}
const sessionModelState = sessionModelStateMode === 'true';
const attachOnly = process.env.OPENCODE_SMOKE_ATTACH_ONLY === 'true';
const root = mkdtempSync('/tmp/opencode/preset-isolation-');
const workspace = path.join(root, 'workspace');
const configDir = path.join(root, 'config');
const socket = path.join(root, 'tmux.sock');
const storage = path.join(
  root,
  'data',
  'opencode',
  'storage',
  'oh-my-opencode-slim',
);
const scope = createHash('sha256').update(workspace).digest('hex').slice(0, 12);
const statePath = path.join(storage, scope, 'tui-state.json');
const attachDir = path.join(storage, 'tui-attach', scope);
const requests: Record<string, unknown>[] = [];
const failures: string[] = [];
let host: ReturnType<typeof spawn> | undefined;
let hostLog = '';
let hostError: Error | undefined;
let url = '';
let password = '';
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(OPENCODE_|ANTHROPIC_|OPENAI_|AZURE_|GOOGLE_|GEMINI_|AWS_|TMUX|SLIM_)/.test(
        key,
      ),
  ),
);
for (const name of [
  'home',
  'config',
  'cache',
  'data',
  'state',
  'workspace',
  'plugin',
]) {
  mkdirSync(path.join(root, name), { recursive: true });
}
Object.assign(env, {
  HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: configDir,
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_STATE_HOME: path.join(root, 'state'),
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_TEST_HOME: path.join(root, 'home'),
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  TERM: 'xterm-256color',
});

function command(args: string[]) {
  const result = spawnSync('tmux', ['-S', socket, ...args], {
    env,
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0)
    throw new Error(`tmux ${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout;
}

async function until<T>(
  label: string,
  probe: () => T | Promise<T>,
  timeout = 30_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    if (hostError) throw hostError;
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (host?.exitCode !== null && host?.exitCode !== undefined) {
      throw new Error(`Host exited: ${hostLog}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last})` : ''}`);
}

async function api(route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opencode-directory': workspace,
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function capture(client: string) {
  const screen = command(['capture-pane', '-p', '-t', client, '-S', '-200']);
  writeFileSync(path.join(root, `${client}.txt`), screen);
  return screen;
}

function type(client: string, text: string) {
  command(['send-keys', '-t', client, '-l', text]);
  command(['send-keys', '-t', client, 'Enter']);
}

// Only this loopback stub can be selected by the host provider allowlist.
// It records the actual HTTP model, not the plugin's projected model table.
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    writeFileSync(
      path.join(root, 'requests.json'),
      JSON.stringify(requests, null, 2),
    );
    const messages = body.messages as Array<{
      role: string;
      content?: unknown;
    }>;
    const lastUser = messages?.findLast((message) => message.role === 'user');
    const marker = JSON.stringify(lastUser?.content).match(
      /SMOKE_[A-Z_]+/,
    )?.[0];
    const tools = body.tools as
      | Array<{ function: { name: string; parameters: unknown } }>
      | undefined;
    const task = tools?.find((tool) =>
      /^(task|subagent)$/.test(tool.function.name),
    );
    const last = messages?.at(-1);
    const dispatch =
      marker &&
      task &&
      last?.role !== 'tool' &&
      String(body.model).includes('orchestrator');
    const toolCall = {
      id: `call_${requests.length}`,
      type: 'function',
      function: {
        name: task?.function.name,
        arguments: JSON.stringify({
          description: marker,
          prompt: `${marker} Reply with DONE only.`,
          ...(task?.function.name === 'subagent'
            ? { agent: 'explorer', background: false }
            : { subagent_type: 'explorer', run_in_background: false }),
          ...(marker === 'SMOKE_B_RESUME'
            ? { sessionID: originalChildID() }
            : {}),
        }),
      },
    };
    const message = dispatch
      ? { role: 'assistant', content: null, tool_calls: [toolCall] }
      : { role: 'assistant', content: `DONE ${marker ?? ''}` };
    if (!body.stream)
      return Response.json({
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: dispatch ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    const delta = dispatch
      ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
      : { role: 'assistant', content: message.content };
    const chunk = (d: unknown, finish: string | null) =>
      `data: ${JSON.stringify({
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: d, finish_reason: finish }],
      })}\n\n`;
    return new Response(
      chunk(delta, null) +
        chunk({}, dispatch ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  },
});

async function main() {
  for (const entry of ['dist/server/index.js', 'dist/tui2.js']) {
    if (!existsSync(path.join(repo, entry)))
      throw new Error(`Build first: missing ${entry}`);
  }
  for (const [name, entry] of [
    ['index', 'dist/server/index.js'],
    ['tui', 'dist/tui2.js'],
  ]) {
    writeFileSync(
      path.join(root, 'plugin', `${name}.ts`),
      `export { default } from '${pathToFileURL(path.join(repo, entry))}';\n`,
    );
  }
  const models = ['orchestrator', 'original', 'alternate'];
  writeFileSync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify({
      plugin: [pathToFileURL(path.join(root, 'plugin')).href],
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      model: 'smoke/orchestrator',
      small_model: 'smoke/orchestrator',
      default_agent: 'orchestrator',
      enabled_providers: ['smoke'],
      permission: 'allow',
      provider: {
        smoke: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            apiKey: 'offline-only',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
          },
          models: Object.fromEntries(
            models.map((id) => [
              id,
              {
                name: id,
                tool_call: true,
                limit: { context: 128000, output: 4000 },
              },
            ]),
          ),
        },
      },
    }),
  );
  const pluginConfig = path.join(configDir, 'oh-my-opencode-slim.json');
  writeFileSync(
    pluginConfig,
    JSON.stringify({
      preset: 'original',
      ...(sessionModelStateMode === 'default' ? {} : { sessionModelState }),
      multiplexer: { type: 'none' },
      disabled_mcps: ['websearch', 'context7', 'gh_grep'],
      presets: Object.fromEntries(
        ['original', 'alternate'].map((name) => [
          name,
          Object.fromEntries(
            [
              'orchestrator',
              'explorer',
              'fixer',
              'oracle',
              'designer',
              'librarian',
            ].map((agent) => [
              agent,
              {
                model: `smoke/${agent === 'orchestrator' ? 'orchestrator' : name}`,
              },
            ]),
          ),
        ]),
      ),
    }),
  );
  host = spawn(
    binary,
    ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
    {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  host.on('error', (error) => {
    hostError = error;
  });
  for (const stream of [host.stdout, host.stderr])
    stream?.on('data', (chunk) => {
      hostLog += String(chunk);
      writeFileSync(path.join(root, 'host.log'), hostLog);
    });
  url = await until(
    'private server URL',
    () => hostLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0],
  );
  password = await until(
    'private server password',
    () => hostLog.match(/server password (\S+)/)?.[1],
  );
  const spec = await until('OpenAPI readiness', () => api('/openapi.json'));
  writeFileSync(path.join(root, 'openapi.json'), JSON.stringify(spec, null, 2));
  const create = async (title: string) =>
    (
      await api('/api/session', {
        title,
        location: { directory: workspace },
        agent: 'orchestrator',
        model: { providerID: 'smoke', id: 'orchestrator' },
      })
    ).data;
  const a = await create('Smoke A');
  const b = await create('Smoke B');
  const assertNoSessionState = () => {
    const snapshot = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : {};
    for (const session of [a, b]) {
      if (snapshot.sessionAgentModels?.[session.id]) {
        throw new Error(`Disabled mode wrote root record: ${session.id}`);
      }
    }
    if (existsSync(attachDir) && readdirSync(attachDir).length) {
      throw new Error('Disabled mode wrote TUI attach markers');
    }
  };
  writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify({ a, b }, null, 2),
  );
  for (const [client, session] of [
    ['a', a],
    ['b', b],
  ] as const) {
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    command([
      'new-session',
      '-d',
      '-s',
      client,
      '-x',
      '180',
      '-y',
      '55',
      `OPENCODE_PASSWORD=${quote(password)} ${[binary, '--server', url, '--session', session.id, workspace].map(quote).join(' ')}`,
    ]);
    await until(`TUI ${client} rendered`, () =>
      /orchestrator|Smoke|preset/i.test(capture(client)),
    );
    if (!sessionModelState) {
      assertNoSessionState();
      continue;
    }
    const state = await until(
      `TUI ${client} attach-only original snapshot`,
      () => {
        const snapshot = JSON.parse(readFileSync(statePath, 'utf8'));
        return snapshot.sessionAgentModels?.[session.id]?.agentModels
          ?.explorer === 'smoke/original'
          ? snapshot
          : undefined;
      },
    );
    writeFileSync(
      path.join(root, `${client}-attach-state.json`),
      JSON.stringify(state, null, 2),
    );
    console.log(
      `TUI ${client}: original per-root snapshot recorded before any prompt`,
    );
  }
  console.log(
    `Mode: sessionModelState=${sessionModelStateMode}, attachOnly=${attachOnly}`,
  );
  if (!attachOnly) {
    type('b', 'SMOKE_B_BEFORE');
    await childRequest('SMOKE_B_BEFORE', 'original');
  }
  type('a', '/preset alternate');
  await until(
    'TUI A persisted preset',
    () => JSON.parse(readFileSync(pluginConfig, 'utf8')).preset === 'alternate',
  );
  const refreshedState = await until(
    'global explorer projection refreshed',
    () => {
      const snapshot = JSON.parse(readFileSync(statePath, 'utf8'));
      return snapshot.agentModels?.explorer === 'smoke/alternate'
        ? snapshot
        : undefined;
    },
  );
  writeFileSync(
    path.join(root, 'global-refreshed-state.json'),
    JSON.stringify(refreshedState, null, 2),
  );
  if (!sessionModelState) assertNoSessionState();
  type('b', 'SMOKE_B_AFTER');
  const expectedB = sessionModelState ? 'original' : 'alternate';
  await childRequest('SMOKE_B_AFTER', expectedB);
  type('a', 'SMOKE_A_AFTER');
  await childRequest('SMOKE_A_AFTER', 'alternate');
  if (!attachOnly) {
    type('b', 'SMOKE_B_RESUME');
    await childRequest('SMOKE_B_RESUME', 'original');
  }
  capture('a');
  capture('b');
  if (!sessionModelState) assertNoSessionState();
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(
    `PASS: global watcher refreshed; B new child used ${expectedB}; A new child used alternate.`,
  );
  console.log(
    attachOnly
      ? `PASS: B first prompt after switch used ${expectedB} (precreated root).`
      : 'PASS: B preexisting child resumed on original model.',
  );
  console.log('LIMITATION: sidebar captures are artifacts, not an assertion.');
}

function originalChildID() {
  for (const request of requests) {
    const messages = request.messages as Array<{
      role: string;
      content?: unknown;
    }>;
    for (const message of messages ?? []) {
      const content = String(message.content);
      if (message.role === 'tool' && content.includes('SMOKE_B_BEFORE')) {
        const id = content.match(/sessionID="(ses[^"]+)"/)?.[1];
        if (id) return id;
      }
    }
  }
  throw new Error('No actual preexisting child session ID recorded');
}

async function childRequest(marker: string, expected: string) {
  const body = await until(`${marker} actual child provider request`, () =>
    requests.find(
      (request) =>
        request.model !== 'orchestrator' &&
        JSON.stringify(request.messages).includes(marker),
    ),
  );
  if (body.model !== expected)
    failures.push(
      `${marker}: expected ${expected}, actual outbound model ${body.model}`,
    );
  await until(`${marker} rendered completion`, () =>
    capture(marker.includes('_A_') ? 'a' : 'b').includes(`DONE ${marker}`),
  );
  console.log(
    `${marker}: outbound child model=${body.model}, expected=${expected}`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  for (const client of ['a', 'b']) {
    try {
      capture(client);
    } catch {
      /* Client may not have started. */
    }
  }
  try {
    command(['kill-server']);
  } catch {
    /* Private server may not have started. */
  }
  if (host && host.exitCode === null) {
    host.kill('SIGTERM');
    await until(
      'private server exit',
      () => host?.exitCode !== null || host?.signalCode !== null,
      5000,
    ).catch(() => host?.kill('SIGKILL'));
  }
  provider.stop(true);
  console.log(`Artifacts: ${root}`);
}
