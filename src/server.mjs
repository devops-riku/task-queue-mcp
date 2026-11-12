import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient, loadSettings } from './api.mjs';
import { registerTools } from './tools.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The Task Queue MCP server, with every tool registered. `options.fetchImpl` is for tests. */
export function createServer(settings = loadSettings(), options = {}) {
  const server = new McpServer(
    { name: 'task-queue', version },
    {
      instructions:
        'Task Queue: the person’s tasks, as their own personal API key sees them. Name tasks by number (e.g. TASK-000123). ' +
        'Moves follow the board: move_task to a column by name. Only delete, assign or move other people’s tasks when the person asks.',
    },
  );
  registerTools(server, createClient(settings, options));
  return server;
}
