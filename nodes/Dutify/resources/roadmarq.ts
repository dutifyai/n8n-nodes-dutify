import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import {
	collection,
	EXPRESSION_HINT,
	idPicker,
	isSet,
	jsonField,
	text,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type {
	OperationDef,
	PaginationStyle,
	ParamReader,
	RequestSpec,
	ResourceDef,
} from '../../../shared/types';

/* ---------- shared ---------- */

/** The request list pages from zero and the backend caps a page at 200. */
const REQUEST_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	itemsPath: 'content',
	zeroBased: true,
	maxPageSize: 200,
};

/** Required board picker for the operations that address a board (values are board slugs). */
const boardField = (): INodeProperties =>
	idPicker('Board Name or ID', 'board', 'getBoards', undefined);

/** An optional picker; the description is completed with the standard expression hint. */
const optionalPicker = (
	displayName: string,
	name: string,
	loader: string,
	description: string,
): INodeProperties => ({
	displayName,
	name,
	type: 'options',
	typeOptions: { loadOptionsMethod: loader },
	default: '',
	description: `${description}. ${EXPRESSION_HINT}.`,
});

/**
 * On single-item operations the board is not part of any request. It only narrows the short-ID
 * list, so it is optional: a short ID typed through an expression works without it.
 */
const narrowingBoardField = (): INodeProperties =>
	optionalPicker(
		'Board Name or ID',
		'board',
		'getBoards',
		'Narrows the list of items to pick from',
	);

const shortIdField = (displayName: string, loader: string): INodeProperties => ({
	...idPicker(displayName, 'shortId', loader, undefined, ['board']),
	description: `The short ID, for example FR-42. To use a typed or computed short ID, switch to an expression. ${EXPRESSION_HINT}.`,
});

const requestIdField = () => shortIdField('Request Name or ID', 'getRequestShortIds');
const bugIdField = () => shortIdField('Bug Name or ID', 'getBugShortIds');

const wsQs = (p: ParamReader): IDataObject => ({ workspaceIdentifier: p.workspace });

const str = (p: ParamReader, name: string) => p.get<string>(name);

/** Copies the listed keys that the user set (non-blank) from a collection into a body. */
function pick(source: IDataObject, keys: string[]): IDataObject {
	const out: IDataObject = {};
	for (const key of keys) {
		if (isSet(source[key])) {
			out[key] = source[key] as IDataObject[string];
		}
	}

	return out;
}

const collectionOf = (p: ParamReader, name: string) => p.get<IDataObject>(name, {});

const moderationOptions: INodePropertyOptions[] = [
	{ name: 'Approve', value: 'approve' },
	{ name: 'Reject', value: 'reject' },
	{ name: 'Spam', value: 'spam' },
];

const actionField = (): INodeProperties => ({
	displayName: 'Action',
	name: 'action',
	type: 'options',
	options: moderationOptions,
	default: 'approve',
	required: true,
	description: 'Moderation decision for the item',
});

const NAME_NOTE =
	'Matched by name, ignoring case and surrounding spaces. An unknown name is rejected with the valid options.';

const LIST_NOTE =
	'The list needs a board and a key allowed to read board settings; otherwise it is empty and a name can still be set with an expression.';

/** A name field that offers the board's names when they can be listed. */
const namePicker = (
	displayName: string,
	name: string,
	loader: string,
	description: string,
): INodeProperties => ({
	displayName,
	name,
	type: 'options',
	typeOptions: { loadOptionsMethod: loader, loadOptionsDependsOn: ['board'] },
	default: '',
	description: `${description}. ${NAME_NOTE} ${LIST_NOTE} ${EXPRESSION_HINT}.`,
});

const statusField = (loader: string, description: string): INodeProperties => ({
	...namePicker('Status', 'status', loader, description),
	required: true,
});

const contentField = (): INodeProperties => ({
	...text('Content', 'content', 'The comment text'),
	required: true,
});

const commentOptions = (): INodeProperties =>
	collection('Additional Fields', 'additionalFields', [
		{
			displayName: 'Internal',
			name: 'isInternal',
			type: 'boolean',
			default: false,
			description: 'Whether the comment is only visible to people with View Internal Data',
		},
	]);

const titleField = (): INodeProperties => ({
	...text('Title', 'title', 'Title of the new item'),
	required: true,
});

/** Spec for an operation addressed by short ID. */
function byShortId(
	p: ParamReader,
	base: string,
	method: RequestSpec['method'],
	suffix = '',
	body?: IDataObject,
): RequestSpec {
	const spec: RequestSpec = {
		method,
		path: `${base}/${encodeURIComponent(str(p, 'shortId'))}${suffix}`,
		qs: wsQs(p),
	};
	if (body) {
		spec.body = body;
	}

	return spec;
}

const REQUESTS = '/api/roadmarq/v1/requests/lite';
const BUGS = '/api/roadmarq/v1/bugs/lite';
const boardRequests = (p: ParamReader) =>
	encodePath`/api/roadmarq/v1/boards/${str(p, 'board')}/requests/lite`;
const boardBugs = (p: ParamReader) =>
	encodePath`/api/roadmarq/v1/boards/${str(p, 'board')}/bugs/lite`;

/* ---------- feature requests ---------- */

const requestOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'List',
		action: 'List feature requests',
		description: 'List the feature requests of a board, or search them by title',
		list: true,
		fields: [
			boardField(),
			collection('Filters', 'filters', [
				{
					...namePicker('Status', 'status', 'getRequestStatuses', 'Only requests in this status'),
				},
				{
					...namePicker(
						'Category',
						'category',
						'getRequestCategories',
						'Only requests in this category',
					),
				},
				{
					...namePicker(
						'Milestone',
						'milestone',
						'getMilestones',
						'Only requests in this milestone',
					),
				},
				{
					...text(
						'Search',
						'q',
						'Search request titles. When set, the other filters are ignored and only the top matches are returned',
					),
				},
			]),
		],
		build: (p) => {
			const filters = collectionOf(p, 'filters');
			const path = boardRequests(p);
			if (isSet(filters.q)) {
				// Search results are not paginated and the response is a plain list.
				return { method: 'GET', path, qs: { ...wsQs(p), q: filters.q } };
			}

			return {
				method: 'GET',
				path,
				qs: { ...wsQs(p), ...pick(filters, ['status', 'category', 'milestone']) },
				paginate: REQUEST_PAGING,
			};
		},
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a feature request',
		description: 'Get a feature request by its short ID',
		fields: [narrowingBoardField(), requestIdField()],
		build: (p) => byShortId(p, REQUESTS, 'GET'),
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a feature request',
		description: 'Create a feature request on a board',
		fields: [
			boardField(),
			titleField(),
			collection('Additional Fields', 'additionalFields', [
				text('Description', 'description', 'Request body, plain text or Markdown'),
				namePicker('Category', 'category', 'getRequestCategories', 'Category of the request'),
			]),
		],
		build: (p) => ({
			method: 'POST',
			path: boardRequests(p),
			qs: wsQs(p),
			body: {
				title: str(p, 'title'),
				...pick(collectionOf(p, 'additionalFields'), ['description', 'category']),
			},
		}),
	},
	{
		operation: 'setStatus',
		name: 'Set Status',
		action: 'Set the status of a feature request',
		description: "Change a feature request's status by name",
		fields: [
			narrowingBoardField(),
			requestIdField(),
			statusField('getRequestStatuses', 'Name of the status to set, for example In Progress'),
		],
		build: (p) => byShortId(p, REQUESTS, 'PATCH', '/status', { status: str(p, 'status') }),
	},
	{
		operation: 'comment',
		name: 'Comment',
		action: 'Comment on a feature request',
		description: 'Add a comment to a feature request',
		fields: [narrowingBoardField(), requestIdField(), contentField(), commentOptions()],
		build: (p) =>
			byShortId(p, REQUESTS, 'POST', '/comments', {
				content: str(p, 'content'),
				...pick(collectionOf(p, 'additionalFields'), ['isInternal']),
			}),
	},
	{
		operation: 'vote',
		name: 'Vote',
		action: 'Vote on a feature request',
		description: 'Toggle a vote or an emoji reaction on a feature request',
		fields: [
			narrowingBoardField(),
			requestIdField(),
			collection('Additional Fields', 'additionalFields', [
				text(
					'Emoji',
					'emoji',
					'Emoji to toggle as a reaction. Leave empty for a plain upvote. Running it again removes the vote',
				),
			]),
		],
		build: (p) =>
			byShortId(
				p,
				REQUESTS,
				'POST',
				'/votes',
				pick(collectionOf(p, 'additionalFields'), ['emoji']),
			),
	},
	{
		operation: 'moderate',
		name: 'Moderate',
		action: 'Moderate a feature request',
		description: 'Approve, reject or mark a feature request as spam (needs Manage Queue)',
		fields: [narrowingBoardField(), requestIdField(), actionField()],
		build: (p) => byShortId(p, REQUESTS, 'PATCH', '/moderation', { action: str(p, 'action') }),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a feature request',
		description: 'Permanently delete a feature request (needs Manage Queue)',
		fields: [narrowingBoardField(), requestIdField()],
		build: (p) => byShortId(p, REQUESTS, 'DELETE'),
	},
];

/* ---------- bugs ---------- */

/** A JSON field arrives as text (typed) or as the parsed value (expression). */
function parseEnvironment(value: unknown): IDataObject {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = undefined;
		}
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ApplicationError('Environment must be a JSON object');
	}

	return parsed as IDataObject;
}

const bugOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'List',
		action: 'List bugs',
		description: 'List the bug reports of a board',
		list: true,
		fields: [
			boardField(),
			collection('Filters', 'filters', [
				namePicker('Severity', 'severity', 'getSeverityLevels', 'Only bugs of this severity'),
				namePicker('Status', 'status', 'getBugStatuses', 'Only bugs in this status'),
			]),
		],
		build: (p) => ({
			method: 'GET',
			path: boardBugs(p),
			qs: { ...wsQs(p), ...pick(collectionOf(p, 'filters'), ['severity', 'status']) },
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a bug',
		description: 'Get a bug report by its short ID',
		fields: [narrowingBoardField(), bugIdField()],
		build: (p) => byShortId(p, BUGS, 'GET'),
	},
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a bug',
		description: 'Create a bug report on a board',
		fields: [
			boardField(),
			titleField(),
			collection('Additional Fields', 'additionalFields', [
				namePicker('Severity', 'severity', 'getSeverityLevels', 'Severity level'),
				namePicker('Product Area', 'productArea', 'getProductAreas', 'Product area'),
				text('Steps to Reproduce', 'stepsToReproduce', 'How to reproduce the bug'),
				text('Expected Result', 'expectedResult', 'What should happen'),
				text('Actual Result', 'actualResult', 'What happens instead'),
				jsonField(
					'Environment',
					'environment',
					'Free-form JSON object describing the environment, for example {"browser":"Firefox","os":"Windows"}',
				),
				{
					displayName: 'Security Issue',
					name: 'isSecurity',
					type: 'boolean',
					default: false,
					description: 'Whether this is a security issue; it is then always private',
				},
			]),
		],
		build: (p) => {
			const extra = collectionOf(p, 'additionalFields');
			const body: IDataObject = {
				title: str(p, 'title'),
				...pick(extra, [
					'severity',
					'productArea',
					'stepsToReproduce',
					'expectedResult',
					'actualResult',
					'isSecurity',
				]),
			};
			if (isSet(extra.environment)) {
				body.environment = parseEnvironment(extra.environment);
			}

			return { method: 'POST', path: boardBugs(p), qs: wsQs(p), body };
		},
	},
	{
		operation: 'setStatus',
		name: 'Set Status',
		action: 'Set the status of a bug',
		description: "Change a bug's status by name",
		fields: [
			narrowingBoardField(),
			bugIdField(),
			statusField('getBugStatuses', 'Name of the bug status to set, for example Triaged'),
		],
		build: (p) => byShortId(p, BUGS, 'PATCH', '/status', { status: str(p, 'status') }),
	},
	{
		operation: 'setAssignee',
		name: 'Set Assignee',
		action: 'Assign a bug',
		description: 'Assign a bug to a workspace member, or unassign it',
		fields: [
			narrowingBoardField(),
			bugIdField(),
			optionalPicker(
				'Assignee Name or ID',
				'assigneeEmail',
				'getMembers',
				'Workspace member to assign, by email. Leave this and Assignee ID empty to unassign',
			),
			text(
				'Assignee ID',
				'assigneeId',
				'User UUID to assign instead of picking a member. Use either a member or an ID, not both',
			),
		],
		build: (p) => {
			const assigneeEmail = p.get<string>('assigneeEmail', '');
			const assigneeId = p.get<string>('assigneeId', '');
			if (isSet(assigneeEmail) && isSet(assigneeId)) {
				throw new ApplicationError('Set either an assignee or an assignee ID, not both');
			}
			const body: IDataObject = {};
			if (isSet(assigneeEmail)) {
				body.assigneeEmail = assigneeEmail;
			}
			if (isSet(assigneeId)) {
				body.assigneeId = assigneeId;
			}

			return byShortId(p, BUGS, 'PATCH', '/assignee', body);
		},
	},
	{
		operation: 'setVisibility',
		name: 'Set Visibility',
		action: 'Set the visibility of a bug',
		description: 'Make a bug public or private (security bugs stay private)',
		fields: [
			narrowingBoardField(),
			bugIdField(),
			{
				displayName: 'Public',
				name: 'isPublic',
				type: 'boolean',
				default: false,
				required: true,
				description: 'Whether the bug is visible on the public board',
			},
		],
		build: (p) =>
			byShortId(p, BUGS, 'PATCH', '/visibility', { isPublic: p.get<boolean>('isPublic') }),
	},
	{
		operation: 'toggleAffected',
		name: 'Toggle Affected',
		action: 'Toggle affected on a bug',
		description: 'Toggle your "I\'m affected" marker on a bug',
		fields: [narrowingBoardField(), bugIdField()],
		build: (p) => byShortId(p, BUGS, 'POST', '/affected'),
	},
	{
		operation: 'comment',
		name: 'Comment',
		action: 'Comment on a bug',
		description: 'Add a comment to a bug report',
		fields: [narrowingBoardField(), bugIdField(), contentField(), commentOptions()],
		build: (p) =>
			byShortId(p, BUGS, 'POST', '/comments', {
				content: str(p, 'content'),
				...pick(collectionOf(p, 'additionalFields'), ['isInternal']),
			}),
	},
	{
		operation: 'moderate',
		name: 'Moderate',
		action: 'Moderate a bug',
		description: 'Approve, reject or mark a bug report as spam (needs Manage Queue)',
		fields: [narrowingBoardField(), bugIdField(), actionField()],
		build: (p) => byShortId(p, BUGS, 'PATCH', '/moderation', { action: str(p, 'action') }),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a bug',
		description: 'Permanently delete a bug report (needs Manage Queue)',
		fields: [narrowingBoardField(), bugIdField()],
		build: (p) => byShortId(p, BUGS, 'DELETE'),
	},
];

/** Roadmarq feature requests, addressed by board slug and short ID (FR-42). */
export const featureRequest: ResourceDef = {
	value: 'featureRequest',
	name: 'Feature Request',
	workspaceScoped: true,
	operations: requestOperations,
};

/** Roadmarq bug reports, addressed by board slug and short ID (BG-99). */
export const bug: ResourceDef = {
	value: 'bug',
	name: 'Bug',
	workspaceScoped: true,
	operations: bugOperations,
};
