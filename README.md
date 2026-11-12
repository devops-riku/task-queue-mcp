# Task Queue MCP

An [MCP](https://modelcontextprotocol.io) server for **Task Queue**. Any MCP client (Claude Code, Codex, Gemini CLI, Cursor, Claude Desktop, ...) can list, create, report on, move and assign your tasks, with your **personal API key** and your rights in Task Queue. Everything it does shows in Task Queue as done by you, through the API.

## Tools

| Tool | What it does |
|------|--------------|
| `list_my_tasks` | Your tasks across your workspaces (active, done or all), with each workspace's category and priority values |
| `get_task` | A task with its notes, files, parent and subtasks, and the rules for changing it. Finds any task you may see by its number |
| `create_task` | A new task in your own queue, optionally filed in a project (`Website / Checkout`) or under a parent task, and started at once |
| `start_task` | Starts a queued task (with your estimate when it has none) |
| `complete_task` | Completes a task in progress, with a completion note |
| `add_comment` | Adds a note to a task |
| `attach_files` | Attaches files from your computer to a task |
| `pause_task` / `resume_task` | Stops and restarts a task's worked time while nobody is on it |
| `move_task` | Moves a task to a board column by name, as dragging it on the board does (In Progress, Blocked, Done, or a project's own columns such as "For QA"), and/or files it in another project |
| `assign_task` | Assigns a task to a member by email, to you (`me`), or back to the Task Pool (`none`) |
| `update_task` | Changes a task's title, description, category, priority, dates, or gives your estimate |
| `delete_task` | Deletes a task. It can't be undone |

Tasks are named by their number, e.g. `TASK-000123`, or their id. Each tool needs what the same action needs in the app: assigning needs *Assign tasks*, deleting needs *Delete tasks*, and so on. When Task Queue refuses something, the tool answers with its reason (an unknown board column lists the board's columns).

## Setup

You need Node.js 20 or later, and a **personal API key**: in Task Queue, open **Profile → API keys** and generate one.

Every client runs the server with the same command, `npx -y github:devops-riku/task-queue-mcp`, and two settings:

- `TASK_QUEUE_URL`: your Task Queue address, e.g. `https://tasks.example.com` (the API path is added for you)
- `TASK_QUEUE_API_KEY`: your personal API key (`tqk_...`)

Optional: `TASK_QUEUE_CATEGORY` (the category value `create_task` uses when none is given) and `TASK_QUEUE_WORKSPACE` (a workspace id, when you belong to several).

**Already using the Task Queue tracker plugin?** Then this machine is set up: the server reads the tracker's settings from `~/.task-queue/config.json` and needs no environment variables.

### Claude Code

```sh
claude mcp add task-queue -e TASK_QUEUE_URL=https://tasks.example.com -e TASK_QUEUE_API_KEY=tqk_your_key -- npx -y github:devops-riku/task-queue-mcp
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.task-queue]
command = "npx"
args = ["-y", "github:devops-riku/task-queue-mcp"]
env = { TASK_QUEUE_URL = "https://tasks.example.com", TASK_QUEUE_API_KEY = "tqk_your_key" }
```

### Gemini CLI, Cursor, Claude Desktop

In `~/.gemini/settings.json`, `~/.cursor/mcp.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "task-queue": {
      "command": "npx",
      "args": ["-y", "github:devops-riku/task-queue-mcp"],
      "env": { "TASK_QUEUE_URL": "https://tasks.example.com", "TASK_QUEUE_API_KEY": "tqk_your_key" }
    }
  }
}
```

On Windows, if the client can't start `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "github:devops-riku/task-queue-mcp"]`.

Your API key works like your password for your tasks: keep it in the client's settings only, and revoke it in Task Queue (Profile → API keys) if it leaks.

## Develop

```sh
npm install
npm test
```

The tests run the tools against a fake Task Queue, and start the real server over stdio.

## License

MIT
