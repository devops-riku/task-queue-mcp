/**
 * `task-queue-mcp login --url <address>`: signs this machine in through the browser, like `gh auth login`.
 *
 * It asks Task Queue for a sign-in, prints a code and opens the approval page. Once the user approves it there
 * (checking the code matches and picking a workspace), Task Queue hands over an API key of its own, which is saved in
 * ~/.task-queue/config.json (TASK_QUEUE_HOME moves the folder): the file the MCP server reads when TASK_QUEUE_URL and
 * TASK_QUEUE_API_KEY aren't set, shared with the Task Queue tracker plugin.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, TIMEOUT_MS, normalizeUrl } from './api.mjs';

const configPath = (env) => path.join(env.TASK_QUEUE_HOME || path.join(os.homedir(), '.task-queue'), 'config.json');

function openBrowser(link) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${link}"`]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
  try {
    // Verbatim on Windows: Node would otherwise escape start's empty "" title into something else.
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser here: the printed link does */
  }
}

async function post(fetchImpl, url, route, body) {
  let res;
  try {
    res = await fetchImpl(url + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(0, 'UNREACHABLE', `Task Queue at ${url} didn’t answer (${err.cause?.code ?? err.name}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? `HTTP_${res.status}`, data?.message ?? res.statusText);
  return data;
}

/** Saves the key where the server (and the tracker plugin) read it, keeping the file's other settings. A category
 *  picked for another workspace is dropped. */
export function saveLogin(env, { url, key, workspace }) {
  const file = configPath(env);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  const next = { ...current, url, key, workspace };
  if (current.workspace && current.workspace !== workspace) delete next.category;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return file;
}

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    flags[name] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return flags;
}

/** Runs the sign-in. `fetchImpl`, `sleep`, `open` and `print` are for tests. Returns the saved settings. */
export async function login(argv, { env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), open = openBrowser, print = console.log } = {}) {
  const flags = parse(argv);
  const raw = typeof flags.url === 'string' ? flags.url : env.TASK_QUEUE_URL;
  if (!raw) throw new Error('Give your Task Queue address: task-queue-mcp login --url https://tasks.example.com');
  const url = normalizeUrl(raw);
  const client = `Task Queue MCP on ${os.hostname()}`.slice(0, 60);
  let started;
  try {
    started = await post(fetchImpl, url, '/auth/cli/start', { client });
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      throw new Error('This Task Queue can’t sign in from a terminal yet. Set TASK_QUEUE_URL and TASK_QUEUE_API_KEY instead, with a key from Profile → API keys.');
    }
    throw new Error(`Could not start signing in: ${err.code}: ${err.message}`);
  }
  print(
    [
      `To connect, open this link and check that it shows the code ${started.user_code}, then approve:`,
      `  ${started.verification_url_complete}`,
      `(Or open ${started.verification_url} on any device where you're signed in and type the code.) Waiting for approval…`,
    ].join('\n'),
  );
  if (flags['no-browser'] !== true) open(started.verification_url_complete);
  const until = Date.now() + started.expires_in * 1000;
  while (Date.now() < until) {
    await sleep(started.interval * 1000);
    let got;
    try {
      got = await post(fetchImpl, url, '/auth/cli/token', { device_code: started.device_code });
    } catch (err) {
      if (err.status === 429 || err.code === 'UNREACHABLE') continue;
      throw new Error(`Signing in failed: ${err.code}: ${err.message}`);
    }
    if (got.status === 'pending') continue;
    if (got.status === 'denied') throw new Error('The sign-in was denied in the browser. Nothing was saved.');
    if (got.status === 'expired') throw new Error('The sign-in expired or was used already. Run login again.');
    const file = saveLogin(env, { url, key: got.api_key, workspace: got.workspace.id });
    print(
      [
        `Signed in as ${got.user.full_name} (${got.user.email}), in ${got.workspace.name}. The key "${got.key_name}" is saved in ${file}.`,
        'Add the server to your agent without a key now, e.g.: claude mcp add task-queue -- npx -y github:devops-riku/task-queue-mcp',
        'Revoke the key any time in Task Queue under Profile → Connect → API keys.',
      ].join('\n'),
    );
    return { url, workspace: got.workspace.id, file };
  }
  throw new Error('Nobody approved the sign-in within 10 minutes. Run login again.');
}
