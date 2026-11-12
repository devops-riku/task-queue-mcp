import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadSettings, normalizeUrl } from '../src/api.mjs';
import { createServer } from '../src/server.mjs';

const BASE = 'https://tq.example.com/api/v1';
const ID = '11111111-2222-3333-4444-555555555555';
const doc = (over = {}) => ({ link: { url: `${BASE}/my/tasks/${ID}` }, task: { task_number: 'TASK-7', title: 'Fix login', status: 'IN_PROGRESS', ...over } });

/** A fake Task Queue: records each request and answers from `routes` ("METHOD /path" -> [status, body]). */
function fakeApi(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const route = `${init.method} ${url.replace(BASE, '')}`;
    seen.push({ route, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const [status, body] = routes[route] ?? [404, { code: 'NOT_FOUND', message: 'Not found.' }];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return { seen, fetchImpl };
}

async function connect(routes, settings = { url: BASE, key: 'tqk_test', category: 'FEATURE', workspace: null }) {
  const api = fakeApi(routes);
  const server = createServer(settings, { fetchImpl: api.fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const callTool = (name, args) => client.callTool({ name, arguments: args });
  return { client, callTool, seen: api.seen };
}

test('every tool is listed, with hints for what reads and what deletes', async () => {
  const { client } = await connect({});
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'add_comment', 'assign_task', 'attach_files', 'complete_task', 'create_task', 'delete_task', 'get_task', 'list_my_tasks',
    'move_task', 'pause_task', 'resume_task', 'start_task', 'update_task',
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.list_my_tasks.annotations.readOnlyHint, true);
  assert.equal(by.delete_task.annotations.destructiveHint, true);
  assert.equal(by.move_task.annotations.destructiveHint, false);
});

test('tasks are named by number, looked up once, then changed by id', async () => {
  const { callTool, seen } = await connect({
    [`GET /my/tasks/by-number/TASK-7`]: [200, doc()],
    [`PATCH /my/tasks/${ID}`]: [200, { ...doc({ status: 'IN_PROGRESS' }), applied: ['column'] }],
  });
  const r = await callTool('move_task', { task: 'TASK-7', column: 'For QA' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Moved TASK-7 "Fix login"\. It's in progress now\./);
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [
    ['GET /my/tasks/by-number/TASK-7', null],
    [`PATCH /my/tasks/${ID}`, { column: 'For QA' }],
  ]);
  assert.equal(seen[0].auth, 'Bearer tqk_test');
});

test('assigning: an email, me, or none for the pool', async () => {
  const { callTool, seen } = await connect({ [`PATCH /my/tasks/${ID}`]: [200, doc({ assigned_to: 'Bob Dev' })] });
  assert.match((await callTool('assign_task', { task: ID, assignee: 'bob@example.com', reason: 'He knows it' })).content[0].text, /^Assigned TASK-7 "Fix login" to Bob Dev\./);
  assert.match((await callTool('assign_task', { task: ID, assignee: 'none' })).content[0].text, /back in the Task Pool/);
  assert.deepEqual(seen.map((s) => s.body), [{ assignee: 'bob@example.com', reason: 'He knows it' }, { assignee: null }]);
});

test('reporting work: start, pause, resume, note, complete', async () => {
  const { callTool, seen } = await connect({ [`POST /my/tasks/${ID}`]: [200, doc()] });
  await callTool('start_task', { task: ID, estimate_minutes: 30, started_at: '2026-11-13T09:00:00+08:00' });
  await callTool('pause_task', { task: ID });
  await callTool('resume_task', { task: ID });
  await callTool('add_comment', { task: ID, text: 'Halfway' });
  await callTool('complete_task', { task: ID, note: 'Shipped', ended_at: '2026-11-13T10:00:00+08:00' });
  assert.deepEqual(seen.map((s) => s.body), [
    { started_at: '2026-11-13T09:00:00+08:00', estimate_minutes: 30 },
    { paused: true },
    { paused: false },
    { comment: 'Halfway' },
    { ended_at: '2026-11-13T10:00:00+08:00', completion_note: 'Shipped' },
  ]);
});

test('creating a task: the configured category, and started at once when asked', async () => {
  const created = { ...doc({ status: 'QUEUED', queue_entered_at: '2026-11-13T01:00:00Z' }) };
  const { callTool, seen } = await connect({ ['POST /my/tasks']: [201, created], [`POST /my/tasks/${ID}`]: [200, doc()] });
  const r = await callTool('create_task', { title: 'Fix login', estimate_minutes: 45, folder: 'Website / Checkout', start: true });
  assert.match(r.content[0].text, /^Created TASK-7 "Fix login", started\./);
  assert.deepEqual(seen[0].body, { title: 'Fix login', estimate_minutes: 45, folder: 'Website / Checkout', category: 'FEATURE' });
  assert.deepEqual(seen[1].body, { started_at: '2026-11-13T01:00:00Z' });
});

test("Task Queue's refusals come back as tool errors, with their code", async () => {
  const { callTool } = await connect({
    [`PATCH /my/tasks/${ID}`]: [422, { code: 'UNKNOWN_COLUMN', message: 'No column "Nope". Its columns: In Queue, In Progress.' }],
  });
  const r = await callTool('move_task', { task: ID, column: 'Nope' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'UNKNOWN_COLUMN: No column "Nope". Its columns: In Queue, In Progress.');
  const none = await callTool('move_task', { task: ID });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /^NOTHING_TO_MOVE/);
});

test('attaching files sends them base64-encoded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-mcp-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, '# Done');
  const { callTool, seen } = await connect({ [`POST /my/tasks/${ID}`]: [200, doc()] });
  const r = await callTool('attach_files', { task: ID, paths: [file], comment: 'The report' });
  assert.match(r.content[0].text, /^Attached 1 file to TASK-7/);
  assert.deepEqual(seen[0].body, { attachments: [{ filename: 'report.md', data_base64: Buffer.from('# Done').toString('base64') }], comment: 'The report' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('not set up: every call says what to set', async () => {
  const { callTool } = await connect({}, { url: null, key: null });
  const r = await callTool('list_my_tasks', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^NOT_SET_UP: .*TASK_QUEUE_URL and TASK_QUEUE_API_KEY/);
});

test('settings: environment first, else the tracker plugin settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-home-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'https://saved.example.com/api/v1', key: 'tqk_saved', category: 'BUG' }));
  assert.deepEqual(loadSettings({ TASK_QUEUE_HOME: home }), { url: 'https://saved.example.com/api/v1', key: 'tqk_saved', workspace: null, category: 'BUG', from: 'tracker settings' });
  const env = loadSettings({ TASK_QUEUE_HOME: home, TASK_QUEUE_URL: 'https://tq.example.com', TASK_QUEUE_API_KEY: 'tqk_env' });
  assert.equal(env.url, 'https://tq.example.com/api/v1');
  assert.equal(env.key, 'tqk_env');
  assert.equal(normalizeUrl('https://tq.example.com/api/v1/my/tasks/abc'), 'https://tq.example.com/api/v1');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the stdio server starts and lists its tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
    env: { ...process.env, TASK_QUEUE_URL: BASE, TASK_QUEUE_API_KEY: 'tqk_test' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.equal(client.getServerVersion().name, 'task-queue');
  await client.close();
});
