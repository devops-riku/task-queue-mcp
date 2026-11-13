/**
 * The tools: Task Queue's personal API, one tool per thing a person does with their tasks. Every call is made as
 * the API key's owner, with their rights in the task's workspace, and marked in Task Queue as coming through the
 * API. A task is named by its number (e.g. TASK-000123) or its id.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const task = z.string().min(1).describe('The task: its number, e.g. TASK-000123, or its id.');
const time = (what) => z.string().datetime({ offset: true }).describe(`${what}, ISO 8601 with a UTC offset, e.g. 2026-11-13T09:30:00+08:00. Default: now.`);
const reason = z.string().min(1).max(1000);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** What a tool sends back: one line saying what happened, then Task Queue's answer as JSON. */
const reply = (summary, data) => ({ content: [{ type: 'text', text: data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 1)}` }] });
const failure = (err) => ({ isError: true, content: [{ type: 'text', text: `${err.code ?? 'ERROR'}: ${err.message}` }] });

function guard(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return failure(err);
    }
  };
}

const label = (doc) => `${doc.task.task_number} "${doc.task.title}"`;
/** A task that reached its holder from someone else's queue: what was said before the hand-off is in its comments. */
const handoff = (doc) => (doc.reassigned ? ` ${doc.reassigned.note}` : '');
const handedOver = (tasks) =>
  tasks
    .filter((t) => t.reassigned)
    .map((t) => {
      const from = t.reassigned.from_user ? ` from ${t.reassigned.from_user}` : '';
      const n = t.reassigned.comment_count;
      return `\n${t.task_number} "${t.title}" was reassigned to you${from}: ${n ? `read its ${n === 1 ? 'comment' : `${n} comments`} with get_task before working on it` : 'it has no comments yet'}.`;
    })
    .join('');
const now = () => new Date().toISOString();
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** Registers every tool on `server`, calling Task Queue through `client` (see api.mjs). */
export function registerTools(server, client) {
  const { call, taskId, settings } = client;
  const report = async (ref, body) => {
    const id = await taskId(ref);
    return call('POST', `/my/tasks/${id}`, body);
  };
  const change = async (ref, body) => {
    const id = await taskId(ref);
    return call('PATCH', `/my/tasks/${id}`, body);
  };

  server.registerTool(
    'list_my_tasks',
    {
      title: 'List my tasks',
      description:
        'The tasks assigned to you, across your workspaces, with each workspace and its category and priority values (needed to create a task). active: queued, in progress or on hold; done: completed or cancelled. A task with reassigned set reached you from someone else’s queue: read it with get_task, comments included, before you work on it.',
      inputSchema: {
        status: z.enum(['active', 'done', 'all']).default('active'),
        workspace_id: z.string().uuid().optional().describe('Only this workspace.'),
      },
      annotations: READ,
    },
    guard(async ({ status, workspace_id }) => {
      const query = new URLSearchParams({ status, ...(workspace_id ? { workspace_id } : {}) });
      const data = await call('GET', `/my/tasks?${query}`);
      return reply(`${data.tasks.length} ${status} task${data.tasks.length === 1 ? '' : 's'}.${handedOver(data.tasks)}`, data);
    }),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Read a task',
      description:
        'A task with its description, notes (comments), files, parent and subtasks, and how_to_update: the rules for changing it in its current state. reassigned is set when it reached its assignee from someone else’s queue: then read its comments before working on it, since they say what was done and found before the hand-off. Finds any task you may see by its number (pool tasks too, with View all tasks).',
      inputSchema: { task },
      annotations: READ,
    },
    guard(async (args) => {
      const doc = await call('GET', `/my/tasks/${await taskId(args.task)}`);
      return reply(`${label(doc)} is ${doc.task.status.toLowerCase().replace('_', ' ')}.${handoff(doc)}`, doc);
    }),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'A new task in your own queue (needs Take tasks or Create tasks). category and priority are values (e.g. BUG, HIGH), listed per workspace by list_my_tasks. With start: true it starts at once, which needs an estimate.',
      inputSchema: {
        title: z.string().min(1).max(200),
        category: z.string().optional().describe('A category value; defaults to the configured TASK_QUEUE_CATEGORY.'),
        description: z.string().max(20000).optional(),
        acceptance_criteria: z.string().max(20000).optional(),
        priority: z.string().optional(),
        estimate_minutes: z.number().int().min(1).optional().describe('How long the work takes, in whole minutes.'),
        folder: z.string().max(400).optional().describe('The project to file it in, or a path like "Website / Checkout". Made if missing.'),
        parent: z.string().optional().describe('Make it a subtask of this task (number or id). Needs Edit tasks.'),
        workspace_id: z.string().uuid().optional().describe('Needed when you belong to several workspaces; defaults to TASK_QUEUE_WORKSPACE.'),
        planned_start_at: time('When work is planned to start').optional(),
        due_at: time('When it is due').optional(),
        start: z.boolean().default(false).describe('Start it now.'),
      },
      annotations: WRITE,
    },
    guard(async ({ start, ...fields }) => {
      const body = { ...fields };
      body.category ??= settings.category ?? undefined;
      body.workspace_id ??= settings.workspace ?? undefined;
      if (!body.category) throw Object.assign(new Error('Give a category value (list_my_tasks lists each workspace’s), or set TASK_QUEUE_CATEGORY.'), { code: 'CATEGORY_REQUIRED' });
      let doc = await call('POST', '/my/tasks', body);
      if (start) doc = await call('POST', `/my/tasks/${doc.link.url.split('/').pop()}`, { started_at: doc.task.queue_entered_at ?? now() });
      return reply(`Created ${label(doc)}${start ? ', started' : ''}.`, doc);
    }),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Start a task',
      description: 'Starts a queued task (or corrects the start time of one already started). A task without an estimate needs estimate_minutes. A reassigned task: read its comments (get_task) first.',
      inputSchema: { task, estimate_minutes: z.number().int().min(1).optional(), started_at: time('When work started').optional() },
      annotations: WRITE,
    },
    guard(async (args) => {
      const doc = await report(args.task, { started_at: args.started_at ?? now(), ...(args.estimate_minutes ? { estimate_minutes: args.estimate_minutes } : {}) });
      return reply(`Started ${label(doc)}.${handoff(doc)}`, doc);
    }),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete a task',
      description: 'Completes a task in progress (a paused one is resumed first). A task blocked for a reason must be resumed in Task Queue.',
      inputSchema: { task, note: z.string().max(20000).optional().describe('The completion note: what was done.'), ended_at: time('When work ended').optional() },
      annotations: WRITE,
    },
    guard(async (args) => {
      const doc = await report(args.task, { ended_at: args.ended_at ?? now(), ...(args.note ? { completion_note: args.note } : {}) });
      return reply(`Completed ${label(doc)}.`, doc);
    }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a note',
      description: 'Adds a note to a task’s conversation.',
      inputSchema: { task, text: z.string().min(1).max(5000) },
      annotations: WRITE,
    },
    guard(async (args) => reply('Noted.', await report(args.task, { comment: args.text }))),
  );

  server.registerTool(
    'attach_files',
    {
      title: 'Attach files',
      description: 'Attaches files from this computer to a task, with an optional note.',
      inputSchema: { task, paths: z.array(z.string().min(1)).min(1).max(10).describe('Paths of the files to attach.'), comment: z.string().max(5000).optional() },
      annotations: WRITE,
    },
    guard(async (args) => {
      const attachments = [];
      for (const file of args.paths) {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error(`${file} is over 25 MB.`), { code: 'FILE_TOO_LARGE' });
        attachments.push({ filename: path.basename(file), data_base64: (await fs.readFile(file)).toString('base64') });
      }
      const doc = await report(args.task, { attachments, ...(args.comment ? { comment: args.comment } : {}) });
      return reply(`Attached ${attachments.length} file${attachments.length === 1 ? '' : 's'} to ${label(doc)}.`, doc);
    }),
  );

  for (const [name, paused, title, description] of [
    ['pause_task', true, 'Pause a task', 'Pauses a task in progress so its worked time stops while nobody works on it (no reason needed).'],
    ['resume_task', false, 'Resume a task', 'Resumes a paused task. A task blocked for a reason is resumed with move_task to In Progress.'],
  ]) {
    server.registerTool(
      name,
      { title, description, inputSchema: { task }, annotations: WRITE },
      guard(async (args) => {
        const doc = await report(args.task, { paused });
        return reply(`${paused ? 'Paused' : 'Resumed'} ${label(doc)}.`, doc);
      }),
    );
  }

  server.registerTool(
    'move_task',
    {
      title: 'Move a task',
      description:
        'Moves a task to a board column by name, as dragging it on the board does: In Queue, In Progress (starts or resumes it), Blocked (needs reason), Done (completes it; reason is the completion note), or one of its project board’s own columns. It also moves back a step: from In Progress, Blocked or a later column to In Queue (back in the assignee’s queue, not started; the time worked so far stays), or to the pool (needs reason, and Return any task for work in progress). An unknown column lists the board’s columns. With folder, files it in another project (needs Manage projects). Reopening is done in Task Queue.',
      inputSchema: {
        task,
        column: z.string().min(1).max(80).optional(),
        folder: z.string().min(1).max(400).optional().describe('A project, or a path like "Website / Checkout".'),
        reason: reason.optional().describe('Why: for Blocked and handing back. With Done, the completion note.'),
      },
      annotations: WRITE,
    },
    guard(async ({ task: ref, ...body }) => {
      if (!body.column && !body.folder) throw Object.assign(new Error('Give a column, a folder, or both.'), { code: 'NOTHING_TO_MOVE' });
      const doc = await change(ref, body);
      return reply(`Moved ${label(doc)}. It's ${doc.task.status.toLowerCase().replace('_', ' ')} now.`, doc);
    }),
  );

  server.registerTool(
    'assign_task',
    {
      title: 'Assign a task',
      description:
        'Assigns a task to a member of its workspace by email, to you ("me"), or back to the Task Pool ("none"). Needs Assign tasks, except handing back your own task.',
      inputSchema: { task, assignee: z.string().min(1).max(320).describe('An email, "me", or "none".'), reason: reason.optional().describe('Why, when reassigning or handing it back.') },
      annotations: WRITE,
    },
    guard(async (args) => {
      const assignee = ['none', 'pool', 'nobody'].includes(args.assignee.trim().toLowerCase()) ? null : args.assignee.trim();
      const doc = await change(args.task, { assignee, ...(args.reason ? { reason: args.reason } : {}) });
      return reply(assignee === null ? `${label(doc)} is back in the Task Pool.` : `Assigned ${label(doc)} to ${doc.task.assigned_to ?? assignee}.`, doc);
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Edit a task',
      description:
        'Changes a task’s details (needs Edit tasks), or gives your estimate as its assignee (once). Send only what changes; null clears description, acceptance criteria and dates.',
      inputSchema: {
        task,
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(20000).nullable().optional(),
        acceptance_criteria: z.string().max(20000).nullable().optional(),
        category: z.string().optional(),
        priority: z.string().optional(),
        planned_start_at: time('When work is planned to start').nullable().optional(),
        due_at: time('When it is due').nullable().optional(),
        estimate_minutes: z.number().int().min(1).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async ({ task: ref, ...body }) => {
      if (!Object.keys(body).length) throw Object.assign(new Error('Send at least one field to change.'), { code: 'NOTHING_TO_CHANGE' });
      const doc = await change(ref, body);
      return reply(`Updated ${label(doc)}: ${(doc.applied ?? Object.keys(body)).join(', ')}.`, doc);
    }),
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description: 'Deletes a task with its notes and files. It can’t be undone. Needs Delete tasks. Only when the person asks for it.',
      inputSchema: { task },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const id = await taskId(args.task);
      await call('DELETE', `/my/tasks/${id}`);
      return reply(`Deleted ${args.task}.`);
    }),
  );
}
