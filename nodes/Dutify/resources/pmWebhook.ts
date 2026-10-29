import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	collection,
	idPicker,
	isSet,
	oneItem,
	requireChange,
	text,
} from '../../../shared/fieldHelpers';
import { resolveTaskId } from '../../../shared/taskRefs';
import { encodePath } from '../../../shared/transport';
import type {
	OperationDef,
	PaginationStyle,
	ParamReader,
	RequestSpec,
	ResourceDef,
} from '../../../shared/types';

/* ---------- helpers ---------- */

/** The delivery log pages from zero and the backend rejects a size above 100. */
const DELIVERY_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

const webhooksPath = (p: ParamReader) => encodePath`/mp/api/v1/workspaces/${p.workspace}/webhooks`;

const webhookPath = (p: ParamReader) =>
	`${webhooksPath(p)}/${encodeURIComponent(p.get<string>('webhook'))}`;

const webhookField = (): INodeProperties =>
	idPicker('Webhook Name or ID', 'webhook', 'getPmWebhooks', undefined);

const eventTypesField = (required: boolean): INodeProperties => ({
	displayName: 'Event Type Names or IDs',
	name: 'eventTypes',
	type: 'multiOptions',
	typeOptions: { loadOptionsMethod: 'getPmEventTypes' },
	default: [],
	required,
	description:
		'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	hint: required
		? 'The events that trigger a delivery'
		: 'The complete list of events. It replaces the current list, so leave it empty to keep the events as they are',
});

/* ---------- scope ---------- */

/** The webhook scope narrows deliveries to one space, folder, list or task. */
type ScopeType = 'SPACE' | 'FOLDER' | 'TASK_LIST' | 'TASK';

const SCOPE_PARAM: Record<ScopeType, string> = {
	SPACE: 'scopeSpace',
	FOLDER: 'scopeFolder',
	TASK_LIST: 'scopeList',
	TASK: 'scopeTask',
};

/** Scope choices that name no entity. `KEEP` exists on update only. */
const KEEP_SCOPE = 'KEEP';
const WORKSPACE_SCOPE = 'WORKSPACE';

const SCOPE_DESCRIPTION =
	'Where the events must happen to be delivered. Workspace-level events (members, invitations, teams) are only delivered by a whole-workspace webhook.';

/** Create has no current scope to keep; update starts on keeping it. */
const scopeSelector = (forUpdate: boolean): INodeProperties =>
	forUpdate
		? {
				displayName: 'Scope',
				name: 'scopeType',
				type: 'options',
				options: [
					{ name: 'Folder', value: 'FOLDER' },
					{ name: 'Keep Current', value: 'KEEP' },
					{ name: 'List', value: 'TASK_LIST' },
					{ name: 'Space', value: 'SPACE' },
					{ name: 'Task', value: 'TASK' },
					{ name: 'Whole Workspace', value: 'WORKSPACE' },
				],
				default: 'KEEP',
				description: SCOPE_DESCRIPTION,
			}
		: {
				displayName: 'Scope',
				name: 'scopeType',
				type: 'options',
				options: [
					{ name: 'Folder', value: 'FOLDER' },
					{ name: 'List', value: 'TASK_LIST' },
					{ name: 'Space', value: 'SPACE' },
					{ name: 'Task', value: 'TASK' },
					{ name: 'Whole Workspace', value: 'WORKSPACE' },
				],
				default: 'WORKSPACE',
				description: SCOPE_DESCRIPTION,
			};

export const scopeFields = (forUpdate: boolean): INodeProperties[] => [
	scopeSelector(forUpdate),
	idPicker('Space Name or ID', 'scopeSpace', 'getSpaceIds', { field: 'scopeType', value: 'SPACE' }),
	idPicker('Folder Name or ID', 'scopeFolder', 'getFolderIds', {
		field: 'scopeType',
		value: 'FOLDER',
	}),
	idPicker('List Name or ID', 'scopeList', 'getListIds', {
		field: 'scopeType',
		value: 'TASK_LIST',
	}),
	{
		displayName: 'Task',
		name: 'scopeTask',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { scopeType: ['TASK'] } },
		description: "Task key such as PROJ-42, or the task ID (the task's Identifier field)",
	},
];

/** The scope part of a create or update body. A task key is resolved to its task ID. */
export async function scopeBody(
	request: (spec: RequestSpec) => Promise<unknown>,
	p: ParamReader,
	forUpdate: boolean,
): Promise<IDataObject> {
	const scopeType = p.get<string>('scopeType', forUpdate ? KEEP_SCOPE : WORKSPACE_SCOPE);
	if (scopeType === KEEP_SCOPE || (scopeType === WORKSPACE_SCOPE && !forUpdate)) {
		return {};
	}
	if (scopeType === WORKSPACE_SCOPE) {
		return { clearScope: true };
	}
	if (!(scopeType in SCOPE_PARAM)) {
		throw new ApplicationError(`"${scopeType}" is not a webhook scope`);
	}
	const target = p.get<string>(SCOPE_PARAM[scopeType as ScopeType], '').trim();
	if (!target) {
		throw new ApplicationError('Choose what the webhook scope applies to');
	}
	const scopeEntityIdentifier =
		scopeType === 'TASK'
			? await resolveTaskId(request, target, p.workspace)
			: target;

	return { scopeType, scopeEntityIdentifier };
}

/* ---------- operations ---------- */

const operations: OperationDef[] = [
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a webhook',
		description:
			'Subscribe a URL to Dutify Cloud, Codexum or Roadmarq events. Dutify signs each delivery with the secret you set (HMAC-SHA256, X-Webhook-Signature-256 header). Needs the Manage Webhooks permission',
		fields: [
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/dutify-hook',
				description: 'The http(s) endpoint that receives the deliveries (up to 2000 characters)',
			},
			{
				displayName: 'Secret',
				name: 'secret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				description:
					'The key that signs every delivery. Keep it: Dutify never returns it, so a receiver needs this value to verify signatures (up to 500 characters).',
			},
			eventTypesField(true),
			...scopeFields(false),
			collection('Additional Fields', 'additionalFields', [
				text('Name', 'name', 'A label for the webhook (up to 500 characters)'),
			]),
		],
		run: async (ctx, p) => {
			const eventTypes = p.get<string[]>('eventTypes', []);
			if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
				throw new ApplicationError('Choose at least one event type for the webhook');
			}
			const fields = p.get<IDataObject>('additionalFields', {});
			const body: IDataObject = {
				url: p.get<string>('url'),
				secret: p.get<string>('secret'),
				eventTypes,
				...(isSet(fields.name) ? { name: fields.name } : {}),
				...(await scopeBody(async (spec) => await ctx.request(spec), p, false)),
			};

			return oneItem(await ctx.request({ method: 'POST', path: webhooksPath(p), body }));
		},
	},
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many webhooks',
		description: 'List your webhooks in the workspace. The secret is never included',
		fields: [
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Include Webhooks of Other Users',
					name: 'all',
					type: 'boolean',
					default: false,
					description:
						'Whether to list every webhook of the workspace, not just your own. Needs the Manage Webhooks permission.',
				},
			]),
		],
		build: (p) => {
			const fields = p.get<IDataObject>('additionalFields', {});

			return {
				method: 'GET',
				path: webhooksPath(p),
				...(fields.all === true ? { qs: { all: true } } : {}),
			};
		},
	},
	{
		operation: 'getUsage',
		name: 'Get Usage',
		action: 'Get the webhook usage of the workspace',
		description: 'Count the webhooks in use against the plan limit of the workspace',
		fields: [],
		build: (p) => ({ method: 'GET', path: `${webhooksPath(p)}/usage` }),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a webhook',
		description:
			'Fetch a webhook with its URL, events, scope and state. The secret is never included',
		fields: [webhookField()],
		build: (p) => ({ method: 'GET', path: webhookPath(p) }),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a webhook',
		description:
			'Change a webhook. Resuming it or changing its URL or secret cancels its pending deliveries',
		fields: [
			webhookField(),
			...scopeFields(true),
			collection('Update Fields', 'updateFields', [
				text('URL', 'url', 'The new http(s) endpoint (up to 2000 characters)'),
				{
					displayName: 'Secret',
					name: 'secret',
					type: 'string',
					typeOptions: { password: true },
					default: '',
					description: 'The new signing key (up to 500 characters)',
				},
				text('Name', 'name', 'A new label (up to 500 characters)'),
				eventTypesField(false),
				{
					displayName: 'Active',
					name: 'active',
					type: 'boolean',
					default: true,
					description: 'Whether the webhook delivers events. Turn it off to pause it.',
				},
			]),
		],
		run: async (ctx, p) => {
			const fields = p.get<IDataObject>('updateFields', {});
			const body: IDataObject = {};
			for (const key of ['url', 'secret', 'name', 'active'] as const) {
				if (isSet(fields[key])) {
					body[key] = fields[key];
				}
			}
			const eventTypes = fields.eventTypes;
			if (Array.isArray(eventTypes) && eventTypes.length > 0) {
				body.eventTypes = eventTypes;
			}
			Object.assign(body, await scopeBody(async (spec) => await ctx.request(spec), p, true));

			return oneItem(
				await ctx.request({ method: 'PUT', path: webhookPath(p), body: requireChange(body) }),
			);
		},
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a webhook',
		description: 'Delete a webhook for good. Its signing secret cannot be recovered',
		fields: [webhookField()],
		build: (p) => ({ method: 'DELETE', path: webhookPath(p) }),
	},
	{
		operation: 'test',
		name: 'Send Test Event',
		action: 'Send a test event to a webhook',
		description:
			'Deliver a synthetic webhook-test event to the URL, signed like a real delivery. The result is the delivery record',
		fields: [webhookField()],
		build: (p) => ({ method: 'POST', path: `${webhookPath(p)}/test` }),
	},
	{
		operation: 'listDeliveries',
		name: 'Get Delivery Log',
		action: 'Get the delivery log of a webhook',
		description: 'List the delivery attempts of a webhook, newest first',
		fields: [webhookField()],
		list: true,
		build: (p) => ({
			method: 'GET',
			path: `${webhookPath(p)}/deliveries`,
			paginate: DELIVERY_PAGING,
		}),
	},
	{
		operation: 'replayDelivery',
		name: 'Replay Delivery',
		action: 'Replay a delivery of a webhook',
		description:
			'Send a past delivery again with the same payload and delivery ID, so the receiver must treat it as a possible duplicate',
		fields: [
			webhookField(),
			idPicker('Delivery Name or ID', 'delivery', 'getPmWebhookDeliveries', undefined, ['webhook']),
		],
		build: (p) => ({
			method: 'POST',
			path: `${webhookPath(p)}/deliveries/${encodeURIComponent(p.get<string>('delivery'))}/replay`,
		}),
	},
	{
		operation: 'listEventTypes',
		name: 'Get Event Types',
		action: 'Get the event types a webhook can subscribe to',
		description:
			'List every event type a webhook can subscribe to, across Dutify Cloud, Codexum and Roadmarq, each with its product (pm for Dutify Cloud, codexum or roadmarq), a description and the scope types that can narrow it',
		fields: [],
		build: (p) => ({ method: 'GET', path: `${webhooksPath(p)}/event-types` }),
	},
];

/** Outgoing PM webhooks (PM "Webhook Resource"). */
export const pmWebhook: ResourceDef = {
	value: 'pmWebhook',
	name: 'Dutify Cloud Webhook',
	workspaceScoped: true,
	operations,
};
