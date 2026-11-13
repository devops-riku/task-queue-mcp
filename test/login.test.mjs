import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadSettings } from '../src/api.mjs';
import { login } from '../src/login.mjs';

const START = {
  device_code: 'd'.repeat(43),
  user_code: 'BCDF-GHJK',
  verification_url: 'https://tasks.example.com/connect/cli',
  verification_url_complete: 'https://tasks.example.com/connect/cli?code=BCDF-GHJK',
  expires_in: 600,
  interval: 3,
};
const APPROVED = {
  status: 'approved',
  api_key: 'tqk_new',
  key_name: 'Task Queue MCP on LAPTOP',
  workspace: { id: '11111111-1111-1111-1111-111111111111', name: 'Engineering' },
  user: { id: 'u', full_name: 'Ada Admin', email: 'ada@example.com' },
};

/** A fake Task Queue: the sign-in starts, stays pending `waits` polls, then answers `final`. */
function fakeServer(final, waits = 1) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const json = (status, data) => ({ ok: status < 400, status, statusText: '', json: async () => data });
    if (url.endsWith('/auth/cli/start')) return json(201, START);
    if (url.endsWith('/auth/cli/token')) return json(200, calls.filter((c) => c.url.endsWith('/token')).length <= waits ? { status: 'pending' } : final);
    return json(404, { code: 'NOT_FOUND', message: 'Not Found' });
  };
  return { calls, fetchImpl };
}

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tq-mcp-login-'));
}

test('login: approved in the browser, the key is saved where the server reads it', async () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabled: true, category: 'FEATURE', workspace: 'old' }));
  const env = { TASK_QUEUE_HOME: dir };
  const { calls, fetchImpl } = fakeServer(APPROVED);
  const opened = [];
  const printed = [];
  await login(['--url', 'https://tasks.example.com'], { env, fetchImpl, sleep: async () => {}, open: (u) => opened.push(u), print: (t) => printed.push(t) });

  assert.equal(calls[0].url, 'https://tasks.example.com/api/v1/auth/cli/start');
  assert.match(calls[0].body.client, /^Task Queue MCP on /);
  assert.deepEqual(opened, [START.verification_url_complete]);
  assert.match(printed[0], /BCDF-GHJK/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  // Other settings stay; a category picked for another workspace goes.
  assert.deepEqual(saved, { enabled: true, url: 'https://tasks.example.com/api/v1', key: 'tqk_new', workspace: APPROVED.workspace.id });
  const settings = loadSettings(env);
  assert.deepEqual([settings.url, settings.key, settings.from], ['https://tasks.example.com/api/v1', 'tqk_new', 'tracker settings']);
});

test('login: --no-browser only prints the link', async () => {
  const opened = [];
  const { fetchImpl } = fakeServer(APPROVED, 0);
  await login(['--url=https://tasks.example.com', '--no-browser'], { env: { TASK_QUEUE_HOME: home() }, fetchImpl, sleep: async () => {}, open: (u) => opened.push(u), print: () => {} });
  assert.deepEqual(opened, []);
});

test('login: denied or expired saves nothing', async () => {
  for (const status of ['denied', 'expired']) {
    const dir = home();
    const { fetchImpl } = fakeServer({ status });
    await assert.rejects(login(['--url', 'https://tasks.example.com'], { env: { TASK_QUEUE_HOME: dir }, fetchImpl, sleep: async () => {}, open: () => {}, print: () => {} }), status === 'denied' ? /denied/ : /expired/);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  }
});

test('login: an older Task Queue without browser sign-in says so', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ code: 'NOT_FOUND', message: 'Not Found' }) });
  await assert.rejects(login(['--url', 'https://tasks.example.com'], { env: { TASK_QUEUE_HOME: home() }, fetchImpl, sleep: async () => {}, open: () => {}, print: () => {} }), /can’t sign in from a terminal yet/);
  await assert.rejects(login([], { env: {}, fetchImpl, print: () => {} }), /Give your Task Queue address/);
});
