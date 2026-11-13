#!/usr/bin/env node
/**
 * Task Queue MCP server, over stdio. Run by an MCP client (Claude Code, Codex, Gemini CLI, Cursor, ...) with
 * TASK_QUEUE_URL and TASK_QUEUE_API_KEY set, or on a machine signed in with `task-queue-mcp login --url <address>`
 * (or where the Task Queue tracker is set up).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSettings } from './api.mjs';
import { createServer } from './server.mjs';

if (process.argv[2] === 'login') {
  const { login } = await import('./login.mjs');
  try {
    await login(process.argv.slice(3));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
} else {
  const settings = loadSettings();
  if (!settings.url || !settings.key) {
    // It still starts, so the client lists the tools; each call says what to set.
    console.error('Task Queue MCP: not signed in (run task-queue-mcp login --url <address>, or set TASK_QUEUE_URL and TASK_QUEUE_API_KEY); tool calls will say so.');
  }
  await createServer(settings).connect(new StdioServerTransport());
}
