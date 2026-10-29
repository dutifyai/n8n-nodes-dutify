import { randomBytes } from 'node:crypto';
import {
	ApplicationError,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';
import type {
	IDataObject,
	IHookFunctions,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';
import { idPicker } from '../../shared/fieldHelpers';
import { workspaceField } from '../../shared/fields';
import { dutifyErrorOf, dutifyRequest } from '../../shared/transport';
import type { ParamReader, RequestSpec } from '../../shared/types';
import { listSearch, loadOptions } from '../Dutify/loaders';
import { DEFAULT_MEETING_SECTIONS, sectionsField } from '../Dutify/resources/meetingWebhook';
import { scopeBody, scopeFields } from '../Dutify/resources/pmWebhook';
import { isWebhookPing, sources, verifySignature } from './sources';
import type { ListedWebhook, WebhookSource } from './sources';

/**
 * Static data of the node: the registered webhook, the secret that signs its deliveries and the
 * workspace it lives in (so a later change of the workspace parameter cannot orphan it).
 */
interface StoredWebhook extends IDataObject {
	webhookId?: string;
	secret?: string;
	workspace?: string;
	/** The trigger source that made it, so a later change of Source cannot orphan it. */
	source?: string;
}

function forget(stored: StoredWebhook): void {
	delete stored.webhookId;
	delete stored.secret;
	delete stored.workspace;
	delete stored.source;
}

const sourceNameOf = (ctx: IHookFunctions | IWebhookFunctions) =>
	String(ctx.getNodeParameter('source', 'pm'));

/** The source that made the stored webhook; the current one for data stored before it was kept. */
function storedSourceOf(ctx: IHookFunctions, stored: StoredWebhook): WebhookSource {
	return (stored.source && sources[stored.source]) || sourceOf(ctx);
}

const forSources =
	(...source: string[]) =>
	(field: INodeProperties): INodeProperties => ({
		...field,
		displayOptions: { show: { source, ...(field.displayOptions?.show ?? {}) } },
	});

const forPm = forSources('pm');
const forMeeting = forSources('meeting');
const forCodexum = forSources('codexum');
const forRoadmarq = forSources('roadmarq');

const WORKSPACE_SCOPE = 'WORKSPACE';

/**
 * The trigger fields of a product source (wiki or feature requests): its events and its scope
 * selector, and the field holding the target of each scope type.
 */
interface ProductSourceFields {
	events: string;
	scopeType: string;
	targets: Record<string, string>;
}

const PRODUCT_SOURCES: Record<string, ProductSourceFields> = {
	codexum: {
		events: 'wikiEvents',
		scopeType: 'wikiScopeType',
		targets: { WIKI_SPACE: 'wikiScopeSpace', WIKI_PAGE: 'wikiScopePage' },
	},
	roadmarq: {
		events: 'feedbackEvents',
		scopeType: 'feedbackScopeType',
		targets: {
			FEEDBACK_BOARD: 'feedbackScopeBoard',
			FEEDBACK_REQUEST: 'feedbackScopeRequest',
			FEEDBACK_BUG: 'feedbackScopeBug',
		},
	},
};

/**
 * Event types of a product source, loaded from PM's `/webhooks/event-types` for that product and
 * narrowed to the ones the chosen scope (`scopeField`) can take, as PM refuses the others.
 */
const productEventsField = (name: string, scopeField: string): INodeProperties => ({
	displayName: 'Event Names or IDs',
	name,
	type: 'multiOptions',
	typeOptions: {
		loadOptionsMethod: 'getWebhookEventTypes',
		loadOptionsDependsOn: ['source', 'workspace.value', scopeField],
	},
	default: [],
	required: true,
	description:
		'The events that start the workflow; the list shows only the events the chosen scope can take. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const SCOPE_HINT =
	'Dutify delivers an event only while the person who owns the API key can see the item';

const FEEDBACK_SCOPE_HINT = `${SCOPE_HINT}. A board, feature request or bug report scope needs a personal API key: Dutify refuses it for workspace and integration keys.`;

const wikiFields: INodeProperties[] = [
	productEventsField('wikiEvents', 'wikiScopeType'),
	{
		displayName: 'Scope',
		name: 'wikiScopeType',
		type: 'options',
		options: [
			{ name: 'Page', value: 'WIKI_PAGE', description: 'A page and the pages below it' },
			{ name: 'Space', value: 'WIKI_SPACE' },
			{ name: 'Whole Workspace', value: WORKSPACE_SCOPE },
		],
		default: WORKSPACE_SCOPE,
		description: 'Where the events must happen to be delivered',
		hint: SCOPE_HINT,
	},
	idPicker(
		'Space Name or ID',
		'wikiScopeSpace',
		'getWikiSpaces',
		{ field: 'wikiScopeType', value: 'WIKI_SPACE' },
		['workspace.value'],
	),
	{
		displayName: 'Page ID',
		name: 'wikiScopePage',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { wikiScopeType: ['WIKI_PAGE'] } },
		description: 'The ID of the wiki page; its sub-pages are included',
	},
];

const feedbackFields: INodeProperties[] = [
	productEventsField('feedbackEvents', 'feedbackScopeType'),
	{
		displayName: 'Scope',
		name: 'feedbackScopeType',
		type: 'options',
		options: [
			{ name: 'Board', value: 'FEEDBACK_BOARD' },
			{ name: 'Bug Report', value: 'FEEDBACK_BUG' },
			{ name: 'Feature Request', value: 'FEEDBACK_REQUEST' },
			{ name: 'Whole Workspace', value: WORKSPACE_SCOPE },
		],
		default: WORKSPACE_SCOPE,
		description:
			'Where the events must happen to be delivered. Security bug reports are never delivered to a trigger.',
		hint: FEEDBACK_SCOPE_HINT,
	},
	idPicker(
		'Board Name or ID',
		'feedbackScopeBoard',
		'getBoards',
		{ field: 'feedbackScopeType', value: 'FEEDBACK_BOARD' },
		['workspace.value'],
	),
	{
		displayName: 'Feature Request',
		name: 'feedbackScopeRequest',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'FR-12',
		displayOptions: { show: { feedbackScopeType: ['FEEDBACK_REQUEST'] } },
		description: 'Short key such as FR-12, or the request ID',
	},
	{
		displayName: 'Bug Report',
		name: 'feedbackScopeBug',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'BG-3',
		displayOptions: { show: { feedbackScopeType: ['FEEDBACK_BUG'] } },
		description: 'Short key such as BG-3, or the bug ID',
	},
];

/** The events and scope of a wiki or feature-request trigger, as a PM subscription body. */
function productSourceConfig(ctx: IHookFunctions, fields: ProductSourceFields): IDataObject {
	const eventTypes = ctx.getNodeParameter(fields.events, []) as string[];
	if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
		throw new ApplicationError('Choose at least one event to trigger on');
	}
	const scopeType = String(ctx.getNodeParameter(fields.scopeType, WORKSPACE_SCOPE));
	if (scopeType === WORKSPACE_SCOPE) {
		return { eventTypes };
	}
	const targetField = fields.targets[scopeType];
	if (!targetField) {
		throw new ApplicationError(`"${scopeType}" is not a webhook scope`);
	}
	const typed = String(ctx.getNodeParameter(targetField, '', { extractValue: true }) ?? '').trim();
	if (!typed) {
		throw new ApplicationError('Choose what the webhook scope applies to');
	}
	// Roadmarq matches short keys (FR-12, BG-3) in uppercase only.
	const target =
		SHORT_KEY_SCOPES.has(scopeType) && SHORT_KEY.test(typed) ? typed.toUpperCase() : typed;

	return { eventTypes, scopeType, scopeEntityIdentifier: target };
}

/** Scope types whose target may be typed as a short key; a short key, in any case. */
const SHORT_KEY_SCOPES = new Set(['FEEDBACK_REQUEST', 'FEEDBACK_BUG']);
const SHORT_KEY = /^[a-z0-9]{2,10}-\d{1,9}$/i;

/** What a scope type narrows to, for messages. */
const SCOPE_LABEL: Record<string, string> = {
	SPACE: 'space',
	FOLDER: 'folder',
	TASK_LIST: 'list',
	TASK: 'task',
	WIKI_SPACE: 'wiki space',
	WIKI_PAGE: 'wiki page',
	FEEDBACK_BOARD: 'board',
	FEEDBACK_REQUEST: 'feature request',
	FEEDBACK_BUG: 'bug report',
};

/** PM's pause reason for a webhook whose scoped item or container was deleted. */
const SCOPE_ENTITY_GONE = 'SCOPE_ENTITY_GONE';

function scopeLabelOf(cfg: IDataObject, fallbackType?: string): string {
	const label = SCOPE_LABEL[String(cfg.scopeType ?? fallbackType ?? '')] ?? 'item';

	return cfg.scopeEntityIdentifier ? `${label} "${String(cfg.scopeEntityIdentifier)}"` : label;
}

const goneMessage = (cfg: IDataObject, hook: ListedWebhook) =>
	`The scoped ${scopeLabelOf(cfg, hook.scopeType)} was deleted, or the API key's owner can no longer see it. Choose another scope, or the whole workspace.`;

/** Whether the trigger asks for the scope `hook` already has (a typed key may differ in case). */
function sameScope(hook: ListedWebhook, cfg: IDataObject): boolean {
	return (
		Boolean(cfg.scopeType) &&
		cfg.scopeType === hook.scopeType &&
		String(cfg.scopeEntityIdentifier ?? '').toUpperCase() ===
			String(hook.scopeEntityIdentifier ?? '').toUpperCase()
	);
}

/** How to fix a refusal, by PM's error code. */
function refusalHint(httpCode: string | undefined, code: string | undefined): string {
	if (code === 'WEBHOOK_SCOPE_REQUIRES_USER') {
		return 'Use a personal API key in the Dutify credential, or set Scope to Whole Workspace.';
	}
	if (httpCode === '400') {
		return 'Check the events and the scope: every event must be one the chosen scope can take.';
	}

	return "Check the API key's scopes and the permissions of its owner.";
}

/**
 * The activation error for a refused create or update: PM's own message, with how to fix it. A
 * scope PM cannot find (404) says so; 400 and 403 name PM's reason and code. Anything else is the
 * error as `dutifyRequest` made it.
 */
function activationError(
	ctx: IHookFunctions,
	error: unknown,
	cfg: IDataObject,
	reused: ListedWebhook | undefined,
): unknown {
	const { httpCode, message, code } = dutifyErrorOf(error);
	const body: JsonObject = { message: message ?? null, errorCode: code ?? null };
	if (
		httpCode === '404' &&
		(code === 'WEBHOOK_SCOPE_ENTITY_NOT_FOUND' || /scope entity not found/i.test(message ?? ''))
	) {
		const text = reused?.scoped
			? goneMessage(cfg, reused)
			: `The ${scopeLabelOf(cfg)} was not found, or the API key's owner cannot see it. Choose another scope.`;

		return new NodeApiError(ctx.getNode(), body, { httpCode, message: text });
	}
	if ((httpCode === '400' || httpCode === '403') && message) {
		const hint = refusalHint(httpCode, code);

		return new NodeApiError(ctx.getNode(), body, {
			httpCode,
			message: `Dutify refused the trigger's webhook: ${message}`,
			description: code ? `Code: ${code}. ${hint}` : hint,
		});
	}

	return error;
}

function sourceOf(ctx: IHookFunctions | IWebhookFunctions): WebhookSource {
	const name = sourceNameOf(ctx);
	const source = sources[name];
	if (!source) {
		throw new ApplicationError(`"${name}" is not a Dutify Trigger source`);
	}

	return source;
}

function webhookUrlOf(ctx: IHookFunctions): string {
	const url = ctx.getNodeWebhookUrl('default');
	if (!url) {
		throw new ApplicationError('n8n has no URL for this trigger');
	}

	return url;
}

function workspaceOf(ctx: IHookFunctions): string {
	const workspace = String(ctx.getNodeParameter('workspace', '', { extractValue: true }) ?? '');
	if (!workspace) {
		throw new ApplicationError('Choose the workspace to watch');
	}

	return workspace;
}

function paramReader(ctx: IHookFunctions, workspace: string): ParamReader {
	return {
		workspace,
		get: <T>(name: string, fallback?: T) =>
			ctx.getNodeParameter(name, fallback, { extractValue: true }) as T,
	};
}

const httpCodeOf = (error: unknown) => String((error as { httpCode?: unknown } | null)?.httpCode);

/**
 * Deletes a webhook; one that is already gone counts as deleted. PM refuses to delete a webhook
 * that ever delivered (409 ENTITY_IN_USE); that one is paused (active: false) instead, so it
 * stops delivering and the trigger can move on. Any other failure is the NodeApiError
 * `dutifyRequest` already made, passed on as it is.
 */
async function removeWebhook(
	ctx: IHookFunctions,
	source: WebhookSource,
	id: string,
	workspace: string,
): Promise<void> {
	await dutifyRequest
		.call(ctx, source.remove(id, { workspace }), workspace)
		.catch(async (error: unknown) => {
			const code = httpCodeOf(error);
			if (code === '404') {
				return undefined;
			}
			if (code !== '409' || !source.deactivate) {
				return await Promise.reject(error);
			}
			ctx.logger?.warn(`Dutify kept webhook ${id} (it has deliveries); pausing it instead`);

			return await dutifyRequest.call(ctx, source.deactivate(id, { workspace }), workspace);
		});
}

async function listWebhooks(
	ctx: IHookFunctions,
	source: WebhookSource,
	workspace: string,
): Promise<unknown> {
	return await dutifyRequest.call(
		ctx,
		source.list({ workspace, url: webhookUrlOf(ctx) }),
		workspace,
	);
}

/**
 * The webhook at the trigger URL to reuse: an active one before a paused one, then the newest.
 * Undefined when there is none.
 */
function pickReusable(atUrl: ListedWebhook[]): ListedWebhook | undefined {
	const newestFirst = (a: ListedWebhook, b: ListedWebhook) =>
		(b.createdAt ?? '').localeCompare(a.createdAt ?? '');

	return [...atUrl].sort((a, b) => Number(b.active) - Number(a.active) || newestFirst(a, b))[0];
}

/**
 * The source settings of the create request: the sections for a meeting webhook; the events and
 * scope for PM, where a task key scope is resolved to its task ID.
 */
async function sourceConfig(ctx: IHookFunctions, workspace: string): Promise<IDataObject> {
	const sourceName = String(ctx.getNodeParameter('source', 'pm'));
	if (sourceName === 'meeting') {
		const sections = ctx.getNodeParameter('sections', DEFAULT_MEETING_SECTIONS) as string[];

		return { workspace, sections: Array.isArray(sections) ? sections : DEFAULT_MEETING_SECTIONS };
	}
	const product = PRODUCT_SOURCES[sourceName];
	if (product) {
		return { workspace, ...productSourceConfig(ctx, product) };
	}
	const eventTypes = ctx.getNodeParameter('events', []) as string[];
	if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
		throw new ApplicationError('Choose at least one event to trigger on');
	}
	const request = async (spec: RequestSpec) => await dutifyRequest.call(ctx, spec, workspace);
	const scope = await scopeBody(request, paramReader(ctx, workspace), false);

	return { workspace, eventTypes, ...scope };
}

export class DutifyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dutify Trigger',
		name: 'dutifyTrigger',
		icon: { light: 'file:../../icons/dutify.svg', dark: 'file:../../icons/dutify.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["source"]}}',
		description: 'Starts the workflow when something happens in Dutify',
		defaults: {
			name: 'Dutify Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dutifyApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Codexum (Wiki)',
						value: 'codexum',
						description: 'Wiki page, space, comment, reaction and attachment events',
					},
					{
						name: 'Dutify Cloud',
						value: 'pm',
						description: 'Task, comment, list, space and workspace events',
					},
					{
						name: 'Meeting Processed',
						value: 'meeting',
						description:
							'A Dutify Hub meeting of the workspace finished processing (summary, action items and more)',
					},
					{
						name: 'Roadmarq (Feature Requests)',
						value: 'roadmarq',
						description: 'Feature request, vote, bug report, comment and changelog events',
					},
				],
				default: 'pm',
				description: 'The Dutify service whose events start the workflow',
			},
			forSources('pm', 'meeting', 'codexum', 'roadmarq')(workspaceField),
			forMeeting(sectionsField),
			...wikiFields.map(forCodexum),
			...feedbackFields.map(forRoadmarq),
			forPm({
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: PM_EVENT_OPTIONS,
				default: [],
				required: true,
				description: 'The events that start the workflow',
			}),
			...scopeFields(false).map(forPm),
		],
	};

	methods = { listSearch, loadOptions };

	webhookMethods = {
		default: {
			/**
			 * True while the stored webhook is still registered, and switched on, at this URL; a restart
			 * then reuses it. One that Dutify paused (e.g. after failed deliveries) counts as missing,
			 * so n8n calls create, which switches it back on.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				if (!stored.webhookId || !stored.secret) {
					return false;
				}
				const source = sourceOf(this);
				const workspace = workspaceOf(this);
				// Registered for another workspace or by another source: create re-registers it.
				if (
					(stored.workspace && stored.workspace !== workspace) ||
					(stored.source && stored.source !== sourceNameOf(this))
				) {
					return false;
				}
				const listed = await listWebhooks(this, source, workspace);

				return source
					.listAtUrl(listed, webhookUrlOf(this))
					.some((hook) => hook.id === stored.webhookId && hook.active);
			},

			/**
			 * Registers this URL with a fresh secret. A webhook already at this URL in the workspace
			 * (the stored one, or a leftover whose secret is lost; paused or not) is updated and
			 * switched on instead of creating another, so paused rows do not pile up against the plan
			 * quota. Only when there is none is a new one created. Other active webhooks at this URL
			 * are removed, so no duplicate keeps delivering, and so is the stored webhook of a previous
			 * workspace. Webhooks at any other URL are left alone: n8n's test and production URLs
			 * differ, and listening for a test event must not touch the production webhook.
			 */
			async create(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				const source = sourceOf(this);
				const workspace = workspaceOf(this);
				const url = webhookUrlOf(this);
				const cfg = await sourceConfig(this, workspace);

				const atUrl = source.listAtUrl(await listWebhooks(this, source, workspace), url);
				const reuse = pickReusable(atUrl);
				if (
					reuse &&
					!reuse.active &&
					reuse.pauseReason === SCOPE_ENTITY_GONE &&
					sameScope(reuse, cfg)
				) {
					// Resuming it would only fail again: the scoped item no longer exists.
					throw new NodeOperationError(this.getNode(), goneMessage(cfg, reuse), {
						description:
							"Dutify paused this trigger's webhook when the item it was scoped to was deleted.",
					});
				}
				const stale: Array<{ id: string; workspace: string; source: WebhookSource }> = atUrl
					.filter((hook) => hook !== reuse && hook.active)
					.map((hook) => ({ id: hook.id, workspace, source }));
				const storedWorkspace = stored.workspace || workspace;
				const storedSource = storedSourceOf(this, stored);
				if (stored.webhookId && storedSource !== source) {
					// Made by the source this node used before Source was changed.
					stale.push({ id: stored.webhookId, workspace: storedWorkspace, source: storedSource });
				} else if (stored.webhookId && storedWorkspace !== workspace) {
					const storedAtUrl = source.listAtUrl(
						await listWebhooks(this, source, storedWorkspace),
						url,
					);
					if (storedAtUrl.some((hook) => hook.id === stored.webhookId)) {
						stale.push({ id: stored.webhookId, workspace: storedWorkspace, source });
					}
				}
				for (const hook of stale) {
					await removeWebhook(this, hook.source, hook.id, hook.workspace);
				}
				forget(stored);

				const secret = randomBytes(32).toString('hex');
				let id: string;
				try {
					if (reuse) {
						await dutifyRequest.call(this, source.update(reuse, secret, cfg), workspace);
						id = reuse.id;
					} else {
						const created = await dutifyRequest.call(
							this,
							source.create(url, secret, cfg),
							workspace,
						);
						id = source.parseCreated(created, secret).id;
					}
				} catch (error) {
					throw activationError(this, error, cfg, reuse);
				}
				stored.webhookId = id;
				stored.secret = secret;
				stored.workspace = workspace;
				stored.source = sourceNameOf(this);

				return true;
			},

			/** Deletes the stored webhook in the workspace it was registered in. */
			async delete(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				if (!stored.webhookId) {
					return true;
				}
				const source = storedSourceOf(this, stored);
				const workspace = stored.workspace || workspaceOf(this);
				try {
					await removeWebhook(this, source, stored.webhookId, workspace);
				} catch (error) {
					this.logger?.warn(`Could not delete Dutify webhook ${stored.webhookId}`, { error });

					return false;
				}
				forget(stored);

				return true;
			},
		},
	};

	/**
	 * A delivery without a valid signature gets a 401 and does not start the workflow. A signed
	 * `webhook-ping` (Dutify Cloud checking a paused webhook before it resumes it) gets a 200 and
	 * does not start the workflow either.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const source = sourceOf(this);
		const stored = this.getWorkflowStaticData('node') as StoredWebhook;
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const header = headers[source.signatureHeader];
		const signature = Array.isArray(header) ? header[0] : header;
		const req = this.getRequestObject();
		if (req.rawBody === undefined) {
			await req.readRawBody();
		}

		if (!verifySignature(stored.secret ?? '', req.rawBody, signature)) {
			this.getResponseObject().status(401).json({ message: 'Invalid or missing signature' });

			return { noWebhookResponse: true };
		}

		const body = this.getBodyData();
		if (isWebhookPing(headers, body)) {
			this.getResponseObject().status(200).json({ ok: true });

			return { noWebhookResponse: true };
		}

		return { workflowData: [[{ json: body }]] };
	}
}
