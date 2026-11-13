/**
 * Task Queue's personal API, as the MCP server uses it: your personal API key, your rights.
 *
 * Settings come from the environment (TASK_QUEUE_URL, TASK_QUEUE_API_KEY, TASK_QUEUE_WORKSPACE, TASK_QUEUE_CATEGORY)
 * or, when those aren't set, from the Task Queue tracker plugin's own settings in ~/.task-queue/config.json
 * (TASK_QUEUE_HOME moves that folder), so a machine where the tracker is set up needs nothing more.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Any Task Queue address (the app, the API, a task's personal API link) as its API base, ending in /api/v1. */
export function normalizeUrl(raw) {
  let url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error(`"${raw}" isn't a URL. It should look like https://tasks.example.com/api/v1.`);
  url = url.replace(/\/my\/tasks(\/.*)?$/i, '');
  const at = url.toLowerCase().indexOf('/api/v1');
  return at >= 0 ? url.slice(0, at + '/api/v1'.length) : `${url}/api/v1`;
}

function readTrackerSettings(env) {
  const home = env.TASK_QUEUE_HOME || path.join(os.homedir(), '.task-queue');
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** The URL and key to use, and where they came from. */
export function loadSettings(env = process.env) {
  const file = readTrackerSettings(env);
  const rawUrl = env.TASK_QUEUE_URL || file.url;
  return {
    url: rawUrl ? normalizeUrl(rawUrl) : null,
    key: env.TASK_QUEUE_API_KEY || file.key || null,
    workspace: env.TASK_QUEUE_WORKSPACE || file.workspace || null,
    category: env.TASK_QUEUE_CATEGORY || file.category || null,
    from: env.TASK_QUEUE_API_KEY ? 'environment' : file.key ? 'tracker settings' : null,
  };
}

/** A personal API client. `fetchImpl` is for tests. */
export function createClient(settings, { fetchImpl = fetch, timeout = TIMEOUT_MS } = {}) {
  async function call(method, route, body) {
    if (!settings.url || !settings.key) {
      throw new ApiError(
        0,
        'NOT_SET_UP',
        'Task Queue isn’t set up: run  npx -y github:devops-riku/task-queue-mcp login --url <your Task Queue address>  in a terminal, or set TASK_QUEUE_URL and TASK_QUEUE_API_KEY for this MCP server (a personal API key, from Task Queue under Profile → Connect → API keys).',
      );
    }
    let res;
    try {
      res = await fetchImpl(settings.url + route, {
        method,
        headers: { Authorization: `Bearer ${settings.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new ApiError(0, 'UNREACHABLE', `Task Queue at ${settings.url} didn’t answer (${err.cause?.code ?? err.name}).`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: reported below.
    }
    if (!res.ok) {
      const details = Array.isArray(data?.details)
        ? `: ${data.details.map((d) => `${(d.loc ?? []).slice(-1)[0] ?? 'body'} ${d.msg}`).join('; ')}`
        : '';
      throw new ApiError(res.status, data?.code ?? `HTTP_${res.status}`, `${data?.message ?? data?.detail ?? text.slice(0, 200)}${details}`);
    }
    return data;
  }

  /** A task's id, from its id or its number (e.g. TASK-000123). */
  async function taskId(ref) {
    const text = String(ref ?? '').trim();
    if (!text) throw new ApiError(422, 'TASK_REQUIRED', 'Name the task: its number (e.g. TASK-000123) or its id.');
    if (UUID.test(text)) return text;
    const doc = await call('GET', `/my/tasks/by-number/${encodeURIComponent(text)}`);
    return doc.link.url.split('/').pop();
  }

  return { call, taskId, settings };
}
