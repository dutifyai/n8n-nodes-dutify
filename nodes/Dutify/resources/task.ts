import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { ApplicationError } from 'n8n-workflow';
import { dateTime, oneItem, splitList, toInstant } from '../../../shared/fieldHelpers';
import { resolveTaskId } from '../../../shared/taskRefs';
import { encodePath } from '../../../shared/transport';
import type {
	OperationContext,
	OperationDef,
	PaginationStyle,
	ParamReader,
	RequestSpec,
	ResourceDef,
} from '../../../shared/types';
import { contextSpec } from '../loaders';

/* ---------- shared helpers ---------- */

const CURSOR_PAGING: PaginationStyle = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'limit',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 200,
};

/** Reactions use zero-based page/size; the backend rejects a size above 100. */
const REACTION_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

function parseCustomFields(value: unknown): IDataObject {
	if (value !== null && typeof value === 'object') {
		return value as IDataObject;
	}
	try {
		const parsed: unknown = JSON.parse(String(value));
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as IDataObject;
		}
	} catch {
		// reported below
	}
	throw new ApplicationError('Custom Fields must be a JSON object such as {"Severity":"High"}');
}

const isSet = (value: unknown) => value !== undefined && value !== null && value !== '';

function wsQs(p: ParamReader, extra: IDataObject = {}): IDataObject {
	return { workspace: p.workspace, ...extra };
}

/** A copy of the reader where `additionalFields`-style collections or plain params are replaced. */
function withParams(p: ParamReader, overrides: Record<string, unknown>): ParamReader {
	return {
		workspace: p.workspace,
		get: <T>(name: string, fallback?: T) =>
			(Object.prototype.hasOwnProperty.call(overrides, name)
				? overrides[name]
				: p.get(name, fallback)) as T,
	};
}

/* ---------- list name -> identifier ---------- */

interface ContextWithIds {
	spaces?: Array<{
		lists?: Array<{ identifier?: string; name: string }> | null;
		folders?: Array<{ lists?: Array<{ identifier?: string; name: string }> | null }> | null;
	}> | null;
}

/**
 * The lite write and search endpoints take a list IDENTIFIER, but the pickers show list names.
 * Resolves a name through the workspace context. A value that is not a known list name is
 * returned untouched, so a pasted list ID keeps working. Two lists with one name are refused.
 */
async function resolveListId(
	ctx: OperationContext,
	workspace: string,
	space: string,
	value: string,
): Promise<string> {
	if (!value) {
		return '';
	}
	const context = (await ctx.request(
		contextSpec(workspace, { shallow: true, ...(space ? { space } : {}) }),
	)) as ContextWithIds | undefined;
	const lists = (context?.spaces ?? []).flatMap((s) => [
		...(s.lists ?? []),
		...(s.folders ?? []).flatMap((f) => f.lists ?? []),
	]);
	if (lists.some((l) => l.identifier === value)) {
		return value;
	}
	const matches = lists.filter((l) => l.name === value && l.identifier);
	if (matches.length > 1) {
		throw new ApplicationError(
			`There is more than one list named "${value}". Pick a Space as well, or enter the list ID.`,
		);
	}

	return matches[0]?.identifier ?? value;
}

/* ---------- fields ---------- */

const taskRef = (description = 'Task key such as PROJ-123, or the task ID'): INodeProperties => ({
	displayName: 'Task',
	name: 'task',
	type: 'string',
	default: '',
	required: true,
	description,
});

const additionalFields = (options: INodeProperties[]): INodeProperties => ({
	displayName: 'Additional Fields',
	name: 'additionalFields',
	type: 'collection',
	placeholder: 'Add Field',
	default: {},
	options,
});

const spaceOption: INodeProperties = {
	displayName: 'Space Name or ID',
	name: 'space',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getSpaces' },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const listOption: INodeProperties = {
	displayName: 'List Name or ID',
	name: 'list',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getLists', loadOptionsDependsOn: ['space'] },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const statusOption: INodeProperties = {
	displayName: 'Status Name or ID',
	name: 'status',
	type: 'options',
	// Space too: two spaces can hold lists of the same name, with different statuses.
	typeOptions: { loadOptionsMethod: 'getStatuses', loadOptionsDependsOn: ['space', 'list'] },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const taskTypeOption: INodeProperties = {
	displayName: 'Task Type Name or ID',
	name: 'taskType',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getTaskTypes' },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const assigneesOption: INodeProperties = {
	displayName: 'Assignees Names or IDs',
	name: 'assignees',
	type: 'multiOptions',
	typeOptions: { loadOptionsMethod: 'getMembers' },
	default: [],
	description:
		'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

const text = (displayName: string, name: string, description: string): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	default: '',
	description,
});

const mentionsOption: INodeProperties = {
	displayName: 'Mentions Names or IDs',
	name: 'mentions',
	type: 'multiOptions',
	typeOptions: { loadOptionsMethod: 'getMembers' },
	default: [],
	description:
		'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

/** Fields shared by create and update, as collection options. */
function commonTaskOptions(): INodeProperties[] {
	return [
		text('Description', 'description', 'Task description'),
		text('Priority', 'priority', 'Priority name, for example High'),
		text('Level', 'level', 'Task level name, for example L2'),
		text('Tags', 'tags', 'Comma-separated tag names. Missing tags are created.'),
		text('Parent', 'parent', 'Parent task key or ID. Makes the task a subtask.'),
		text('Next To', 'nextTo', 'Key or ID of a sibling task to position this one after'),
		{
			displayName: 'Custom Fields',
			name: 'customFields',
			type: 'json',
			default: '',
			description: 'Custom field values as a JSON object keyed by field name',
		},
		dateTime('Start Date', 'startDate', 'Start date'),
		dateTime('Due Date', 'dueDate', 'Due date'),
		{
			displayName: 'Estimated Time (Minutes)',
			name: 'estimatedTime',
			type: 'number',
			default: 0,
			typeOptions: { minValue: 0 },
			description: 'Estimated time in minutes',
		},
		{
			displayName: 'Private',
			name: 'isPrivate',
			type: 'boolean',
			default: false,
			description: 'Whether only explicitly granted users can see the task',
		},
	];
}

/* ---------- body builders ---------- */

/** Copies the fields shared by create and update from a collection into a task body. */
function commonBody(fields: IDataObject, body: IDataObject, replaceLists: boolean): void {
	for (const key of ['description', 'priority', 'level', 'parent', 'nextTo', 'taskType'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	// An update replaces the whole list, so an emptied field is meaningful there ([] clears it).
	if (replaceLists ? 'tags' in fields : isSet(fields.tags)) {
		body.tags = splitList(fields.tags);
	}
	if (replaceLists ? 'assignees' in fields : splitList(fields.assignees).length > 0) {
		body.assignees = splitList(fields.assignees);
	}
	if (isSet(fields.customFields)) {
		body.customFields = parseCustomFields(fields.customFields);
	}
	for (const key of ['startDate', 'dueDate'] as const) {
		if (isSet(fields[key])) {
			body[key] = toInstant(fields[key]);
		}
	}
	for (const key of ['estimatedTime', 'timeSpent', 'isPrivate'] as const) {
		if (fields[key] !== undefined && fields[key] !== null) {
			body[key] = fields[key];
		}
	}
	if (isSet(fields.recurrenceRule)) {
		body.recurrenceRule = fields.recurrenceRule;
	}
}

function createSpec(p: ParamReader): RequestSpec {
	const fields = p.get<IDataObject>('additionalFields', {});
	const body: IDataObject = { title: p.get<string>('title') };
	// `space` only narrows the list picker; the API has no such body field.
	for (const key of ['list', 'status'] as const) {
		const value = p.get<string>(key, '');
		if (value) {
			body[key] = value;
		}
	}
	commonBody(fields, body, false);

	// No query string: the catalog gives this endpoint none and the backend rejects unknown
	// parameters. The workspace travels in the X-Dutify-Workspace header.
	return { method: 'POST', path: '/mp/api/v1/tasks/lite', body };
}

function updateSpec(p: ParamReader): RequestSpec {
	const fields = p.get<IDataObject>('updateFields', {});
	const body: IDataObject = {};
	for (const key of ['title', 'list', 'status'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	commonBody(fields, body, true);

	return {
		method: 'PATCH',
		path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}`,
		qs: wsQs(p),
		body,
	};
}

function searchSpec(p: ParamReader): RequestSpec {
	const f = p.get<IDataObject>('additionalFields', {});
	const qs: IDataObject = wsQs(p);
	if (isSet(f.query)) {
		qs.q = f.query;
	}
	for (const key of ['space', 'list', 'parent'] as const) {
		if (isSet(f[key])) {
			qs[key] = f[key];
		}
	}
	for (const key of ['status', 'priority', 'tag', 'assignee', 'taskType'] as const) {
		const values = splitList(f[key]);
		if (values.length > 0) {
			qs[key] = values;
		}
	}
	for (const key of ['includeClosed', 'includeArchived', 'includeSubtasks'] as const) {
		if (typeof f[key] === 'boolean') {
			qs[key] = f[key];
		}
	}

	return { method: 'GET', path: '/mp/api/v1/tasks/lite/search', qs, paginate: CURSOR_PAGING };
}

/* ---------- task ---------- */

const taskTypesPath = (workspace: string) =>
	encodePath`/mp/api/v1/workspaces/${workspace}/task-types`;

interface TaskTypeRow {
	identifier: string;
	name?: string;
	singularName?: string;
}

const searchOp: OperationDef = {
	operation: 'search',
	name: 'Search',
	action: 'Search tasks',
	description: 'Find tasks with name-based filters and free text',
	list: true,
	fields: [
		additionalFields([
			text('Search Text', 'query', 'Free text matched against title and description'),
			spaceOption,
			listOption,
			text('Parent', 'parent', 'Only direct children of this task (key or ID)'),
			text('Status', 'status', 'Comma-separated status names (any of them)'),
			text('Priority', 'priority', 'Comma-separated priority names (any of them)'),
			text('Tags', 'tag', 'Comma-separated tag names (any of them)'),
			{
				displayName: 'Assignees Names or IDs',
				name: 'assignee',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getMembers' },
				default: [],
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Task Types Names or IDs',
				name: 'taskType',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTaskTypes' },
				default: [],
				description:
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Include Closed',
				name: 'includeClosed',
				type: 'boolean',
				default: false,
				description: 'Whether closed tasks are included',
			},
			{
				displayName: 'Include Archived',
				name: 'includeArchived',
				type: 'boolean',
				default: false,
				description: 'Whether archived tasks are included (same as Include Closed)',
			},
			{
				displayName: 'Include Subtasks',
				name: 'includeSubtasks',
				type: 'boolean',
				default: true,
				description: 'Whether subtasks are included',
			},
		]),
	],
	build: searchSpec,
	run: async (ctx, p) => {
		const f = p.get<IDataObject>('additionalFields', {});
		const list = await resolveListId(ctx, p.workspace, String(f.space ?? ''), String(f.list ?? ''));
		const resolved = list ? withParams(p, { additionalFields: { ...f, list } }) : p;
		const returnAll = p.get<boolean>('returnAll', false);
		const limit = returnAll ? undefined : p.get<number>('limit', 50);
		const items = await ctx.requestAll(searchSpec(resolved), limit);

		return items.map((json) => ({ json }));
	},
};

const createOp: OperationDef = {
	operation: 'create',
	name: 'Create',
	action: 'Create a task',
	description: 'Create a task in a list, or as a subtask of another task',
	fields: [
		{
			displayName: 'Title',
			name: 'title',
			type: 'string',
			default: '',
			required: true,
			description: 'Title of the task',
		},
		spaceOption,
		listOption,
		statusOption,
		additionalFields([
			assigneesOption,
			taskTypeOption,
			...commonTaskOptions(),
			text('Recurrence Rule', 'recurrenceRule', 'Recurrence in RRULE format, e.g. FREQ=WEEKLY'),
		]),
	],
	build: createSpec,
	run: async (ctx, p) => {
		const list = await resolveListId(
			ctx,
			p.workspace,
			p.get<string>('space', ''),
			p.get<string>('list', ''),
		);

		return oneItem(await ctx.request(createSpec(list ? withParams(p, { list }) : p)));
	},
};

const updateOp: OperationDef = {
	operation: 'update',
	name: 'Update',
	action: 'Update a task',
	description: 'Change only the fields you set on a task',
	fields: [
		taskRef(),
		{
			displayName: 'Update Fields',
			name: 'updateFields',
			type: 'collection',
			placeholder: 'Add Field',
			default: {},
			options: [
				text('Title', 'title', 'New title'),
				{ ...listOption, typeOptions: { loadOptionsMethod: 'getLists' } },
				text('Status', 'status', 'Status name, for example In Progress'),
				assigneesOption,
				taskTypeOption,
				...commonTaskOptions(),
				{
					displayName: 'Time Spent (Minutes)',
					name: 'timeSpent',
					type: 'number',
					default: 0,
					typeOptions: { minValue: 0 },
					description: 'Time spent in minutes',
				},
			],
		},
	],
	build: updateSpec,
	run: async (ctx, p) => {
		const f = p.get<IDataObject>('updateFields', {});
		const list = await resolveListId(ctx, p.workspace, '', String(f.list ?? ''));
		const resolved = list ? withParams(p, { updateFields: { ...f, list } }) : p;

		return oneItem(await ctx.request(updateSpec(resolved)));
	},
};

const includeClosedFields = additionalFields([
	{
		displayName: 'Include Closed',
		name: 'includeClosed',
		type: 'boolean',
		default: false,
		description: 'Whether closed subtasks are included',
	},
	{
		displayName: 'Include Archived',
		name: 'includeArchived',
		type: 'boolean',
		default: false,
		description: 'Whether archived subtasks are included (same as Include Closed)',
	},
]);

export const task: ResourceDef = {
	value: 'task',
	name: 'Task',
	workspaceScoped: true,
	operations: [
		searchOp,
		{
			operation: 'get',
			name: 'Get',
			action: 'Get a task',
			description: 'Fetch a task by key or ID',
			fields: [taskRef()],
			build: (p) => ({
				method: 'GET',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}`,
				qs: wsQs(p),
			}),
		},
		{
			operation: 'getSubtasks',
			name: 'Get Subtasks',
			action: 'Get the subtasks of a task',
			description: 'List the direct children of a task',
			list: true,
			fields: [taskRef(), includeClosedFields],
			build: (p) => {
				const f = p.get<IDataObject>('additionalFields', {});
				const flags: IDataObject = {};
				for (const key of ['includeClosed', 'includeArchived'] as const) {
					if (typeof f[key] === 'boolean') {
						flags[key] = f[key];
					}
				}

				return {
					method: 'GET',
					path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/subtasks`,
					qs: wsQs(p, flags),
					paginate: CURSOR_PAGING,
				};
			},
		},
		createOp,
		updateOp,
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a task',
			description: 'Delete a task and its subtasks',
			fields: [taskRef()],
			build: (p) => ({
				method: 'DELETE',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}`,
				qs: wsQs(p),
			}),
		},
		{
			operation: 'listTypes',
			name: 'Get Many Types',
			action: 'Get many task types',
			description: 'List the task types of the workspace',
			list: true,
			fields: [],
			build: (p) => ({ method: 'GET', path: taskTypesPath(p.workspace) }),
		},
		{
			operation: 'bulkChangeType',
			name: 'Bulk Change Type',
			action: 'Change the type of many tasks',
			description: 'Set, or clear, the task type of up to 5000 tasks at once',
			fields: [
				{
					displayName: 'Task IDs',
					name: 'taskIds',
					type: 'string',
					default: '',
					required: true,
					description:
						'Comma-separated task IDs (the Identifier field of each task). Task keys are not accepted here; use Search to get the IDs.',
				},
				taskTypeOption,
			],
			run: async (ctx, p) => {
				const taskIdentifiers = splitList(p.get<string>('taskIds'));
				if (taskIdentifiers.length === 0) {
					throw new ApplicationError('Enter at least one task ID');
				}
				const wanted = p.get<string>('taskType', '').trim();
				let targetTaskTypeIdentifier: string | null = null;
				if (wanted) {
					const types = (await ctx.request({
						method: 'GET',
						path: taskTypesPath(p.workspace),
					})) as TaskTypeRow[];
					const match = (types ?? []).find((t) =>
						[t.name, t.singularName].some((n) => n?.toLowerCase() === wanted.toLowerCase()),
					);
					if (!match) {
						const valid = (types ?? []).map((t) => t.name ?? t.singularName).join(', ');
						throw new ApplicationError(`Unknown task type "${wanted}". Valid task types: ${valid}`);
					}
					targetTaskTypeIdentifier = match.identifier;
				}

				return oneItem(
					await ctx.request({
						method: 'POST',
						path: '/mp/api/v1/tasks/bulk/change-type',
						body: { taskIdentifiers, targetTaskTypeIdentifier, workspaceIdentifier: p.workspace },
					}),
				);
			},
		},
	],
};

/* ---------- task comments ---------- */

const commentRef: INodeProperties = {
	displayName: 'Comment ID',
	name: 'comment',
	type: 'string',
	default: '',
	required: true,
	description: 'Identifier of the comment (cmt_...)',
};

/** The reaction endpoints take task IDs only, so a task key is looked up first. */
const reactionsPath = async (ctx: OperationContext, p: ParamReader) => {
	const taskId = await resolveTaskId(
		async (spec) => await ctx.request(spec),
		p.get<string>('task'),
		p.workspace,
	);

	return encodePath`/mp/api/v1/tasks/${taskId}/comments/${p.get<string>('comment')}/reactions`;
};

function commentBody(p: ParamReader): IDataObject {
	const f = p.get<IDataObject>('additionalFields', {});
	const body: IDataObject = { text: p.get<string>('text') };
	const mentions = splitList(f.mentions);
	if (mentions.length > 0) {
		body.mentions = mentions;
	}
	if (isSet(f.replyTo)) {
		body.replyTo = f.replyTo;
	}

	return body;
}

const commentText: INodeProperties = {
	displayName: 'Text',
	name: 'text',
	type: 'string',
	typeOptions: { rows: 4 },
	default: '',
	required: true,
	description: 'Plain-text comment. Use @email for a mention and add the same email to Mentions.',
};

export const taskComment: ResourceDef = {
	value: 'taskComment',
	name: 'Task Comment',
	workspaceScoped: true,
	operations: [
		{
			operation: 'list',
			name: 'Get Many',
			action: 'Get many comments on a task',
			description: 'List the comments of a task',
			list: true,
			fields: [taskRef()],
			build: (p) => ({
				method: 'GET',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/comments`,
				qs: wsQs(p),
				paginate: CURSOR_PAGING,
			}),
		},
		{
			operation: 'create',
			name: 'Create',
			action: 'Comment on a task',
			description: 'Post a comment, optionally mentioning people or replying to a comment',
			fields: [
				taskRef(),
				commentText,
				additionalFields([
					mentionsOption,
					text('Reply To', 'replyTo', 'Comment ID (cmt_...) this comment replies to'),
				]),
			],
			build: (p) => ({
				method: 'POST',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/comments`,
				qs: wsQs(p),
				body: commentBody(p),
			}),
		},
		{
			operation: 'update',
			name: 'Update',
			action: 'Update a comment',
			description: 'Replace the text of your own comment',
			fields: [taskRef(), commentRef, commentText, additionalFields([mentionsOption])],
			build: (p) => {
				const body = commentBody(p);

				return {
					method: 'PUT',
					path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/comments/${p.get<string>('comment')}`,
					qs: wsQs(p),
					body,
				};
			},
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Delete a comment',
			description: 'Delete your own comment',
			fields: [taskRef(), commentRef],
			build: (p) => ({
				method: 'DELETE',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/comments/${p.get<string>('comment')}`,
				qs: wsQs(p),
			}),
		},
		{
			operation: 'addReaction',
			name: 'Add Reaction',
			action: 'Add a reaction to a comment',
			description: 'React to a comment with an emoji code',
			fields: [
				taskRef(),
				commentRef,
				{
					displayName: 'Reaction',
					name: 'reactionType',
					type: 'string',
					default: 'thumbs_up',
					required: true,
					description: 'Emoji code, for example thumbs_up or heart',
				},
			],
			run: async (ctx, p) =>
				oneItem(
					await ctx.request({
						method: 'POST',
						path: await reactionsPath(ctx, p),
						body: { reactionType: p.get<string>('reactionType') },
					}),
				),
		},
		{
			operation: 'listReactions',
			name: 'Get Many Reactions',
			action: 'Get many reactions on a comment',
			description: 'List the reactions of a comment',
			list: true,
			fields: [taskRef(), commentRef],
			run: async (ctx, p) => {
				const spec = {
					method: 'GET' as const,
					path: await reactionsPath(ctx, p),
					paginate: REACTION_PAGING,
				};
				const limit = p.get<boolean>('returnAll', false) ? undefined : p.get<number>('limit', 50);

				return (await ctx.requestAll(spec, limit)).map((json) => ({ json }));
			},
		},
		{
			operation: 'removeReaction',
			name: 'Remove Reaction',
			action: 'Remove a reaction from a comment',
			description: 'Remove your own reaction from a comment',
			fields: [
				taskRef(),
				commentRef,
				{
					displayName: 'Reaction ID',
					name: 'reaction',
					type: 'string',
					default: '',
					required: true,
					description: 'Identifier of the reaction (react_...), from Get Many Reactions',
				},
			],
			run: async (ctx, p) =>
				oneItem(
					await ctx.request({
						method: 'DELETE',
						path: `${await reactionsPath(ctx, p)}/${encodeURIComponent(p.get<string>('reaction'))}`,
					}),
				),
		},
	],
};

/* ---------- task relationships ---------- */

export const taskRelationship: ResourceDef = {
	value: 'taskRelationship',
	name: 'Task Relationship',
	workspaceScoped: true,
	operations: [
		{
			operation: 'list',
			name: 'Get Many',
			action: 'Get many relationships of a task',
			description: 'List the links where the task is the owner or the target',
			list: true,
			fields: [taskRef()],
			build: (p) => ({
				method: 'GET',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/relationships`,
				qs: wsQs(p),
				paginate: CURSOR_PAGING,
			}),
		},
		{
			operation: 'create',
			name: 'Create',
			action: 'Link two tasks',
			description: 'Link a task to another task with a relationship type',
			fields: [
				taskRef('Owner task: key such as PROJ-42, or the task ID'),
				{
					displayName: 'Relationship Type',
					name: 'type',
					type: 'string',
					default: '',
					required: true,
					description: 'Relationship type name as used in the workspace, for example Blocking',
				},
				{
					displayName: 'Target Task',
					name: 'target',
					type: 'string',
					default: '',
					required: true,
					description: 'Key or ID of the task to link to',
				},
			],
			build: (p) => ({
				method: 'POST',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/relationships`,
				qs: wsQs(p),
				body: { type: p.get<string>('type'), target: p.get<string>('target') },
			}),
		},
		{
			operation: 'delete',
			name: 'Delete',
			action: 'Unlink two tasks',
			description: 'Delete a relationship',
			fields: [
				taskRef('Either task of the relationship: key such as PROJ-42, or the task ID'),
				{
					displayName: 'Relationship ID',
					name: 'relationship',
					type: 'string',
					default: '',
					required: true,
					description: 'Identifier of the relationship (rel_...), from Get Many',
				},
			],
			build: (p) => ({
				method: 'DELETE',
				path: encodePath`/mp/api/v1/tasks/lite/${p.get<string>('task')}/relationships/${p.get<string>('relationship')}`,
				qs: wsQs(p),
			}),
		},
	],
};
