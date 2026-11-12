#!/usr/bin/env node
/**
 * Task Queue MCP server, over stdio. Run by an MCP client (Claude Code, Codex, Gemini CLI, Cursor, ...) with
 * TASK_QUEUE_URL and TASK_QUEUE_API_KEY set, or on a machine where the Task Queue tracker is already set up.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSettings } from './api.mjs';
import { createServer } from './server.mjs';

const settings = loadSettings();
if (!settings.url || !settings.key) {
  // It still starts, so the client lists the tools; each call says what to set.
  console.error('Task Queue MCP: TASK_QUEUE_URL and TASK_QUEUE_API_KEY are not set; tool calls will say so.');
}
await createServer(settings).connect(new StdioServerTransport());
