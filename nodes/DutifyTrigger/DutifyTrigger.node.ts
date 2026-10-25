import { randomBytes } from 'node:crypto';
import { ApplicationError, NodeConnectionTypes } from 'n8n-workflow';
import type {
	IDataObject,
	IHookFunctions,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';
import { workspaceField } from '../../shared/fields';
import { dutifyRequest } from '../../shared/transport';
import type { ParamReader, RequestSpec } from '../../shared/types';
import { listSearch, loadOptions } from '../Dutify/loaders';
import { DEFAULT_MEETING_SECTIONS, sectionsField } from '../Dutify/resources/meetingWebhook';
import { scopeBody, scopeFields } from '../Dutify/resources/pmWebhook';
import { sources, verifySignature } from './sources';
import type { ListedWebhook, WebhookSource } from './sources';

/**
 * Static data of the node: the registered webhook, the secret that signs its deliveries and the
 * workspace it lives in (so a later change of the workspace parameter cannot orphan it).
 */
interface StoredWebhook extends IDataObject {
	webhookId?: string;
	secret?: string;
	workspace?: string;
}

function forget(stored: StoredWebhook): void {
	delete stored.webhookId;
	delete stored.secret;
	delete stored.workspace;
}

const forSources =
	(...source: string[]) =>
	(field: INodeProperties): INodeProperties => ({
		...field,
		displayOptions: { show: { source, ...(field.displayOptions?.show ?? {}) } },
	});

const forPm = forSources('pm');
const forMeeting = forSources('meeting');

function sourceOf(ctx: IHookFunctions | IWebhookFunctions): WebhookSource {
	const name = String(ctx.getNodeParameter('source', 'pm'));
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
	return await dutifyRequest.call(ctx, source.list({ workspace }), workspace);
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
	if (ctx.getNodeParameter('source', 'pm') === 'meeting') {
		const sections = ctx.getNodeParameter('sections', DEFAULT_MEETING_SECTIONS) as string[];

		return { workspace, sections: Array.isArray(sections) ? sections : DEFAULT_MEETING_SECTIONS };
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
				// Can grow `codexum` (wiki) and `roadmarq` (feature requests) later.
				options: [
					{
						name: 'Meeting Processed',
						value: 'meeting',
						description:
							'A Hub meeting of the workspace finished processing (summary, action items and more)',
					},
					{
						name: 'Project Management',
						value: 'pm',
						description: 'Task, comment, list, space and workspace events',
					},
				],
				default: 'pm',
				description: 'The Dutify service whose events start the workflow',
			},
			forSources('pm', 'meeting')(workspaceField),
			forMeeting(sectionsField),
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
				// Registered for another workspace: create re-registers it for the current one.
				if (stored.workspace && stored.workspace !== workspace) {
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
				const stale: Array<{ id: string; workspace: string }> = atUrl
					.filter((hook) => hook !== reuse && hook.active)
					.map((hook) => ({ id: hook.id, workspace }));
				const storedWorkspace = stored.workspace || workspace;
				if (stored.webhookId && storedWorkspace !== workspace) {
					const storedAtUrl = source.listAtUrl(
						await listWebhooks(this, source, storedWorkspace),
						url,
					);
					if (storedAtUrl.some((hook) => hook.id === stored.webhookId)) {
						stale.push({ id: stored.webhookId, workspace: storedWorkspace });
					}
				}
				for (const hook of stale) {
					await removeWebhook(this, source, hook.id, hook.workspace);
				}
				forget(stored);

				const secret = randomBytes(32).toString('hex');
				let id: string;
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
				stored.webhookId = id;
				stored.secret = secret;
				stored.workspace = workspace;

				return true;
			},

			/** Deletes the stored webhook in the workspace it was registered in. */
			async delete(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				if (!stored.webhookId) {
					return true;
				}
				const source = sourceOf(this);
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

	/** A delivery without a valid signature gets a 401 and does not start the workflow. */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const source = sourceOf(this);
		const stored = this.getWorkflowStaticData('node') as StoredWebhook;
		const header = this.getHeaderData()[source.signatureHeader];
		const signature = Array.isArray(header) ? header[0] : header;
		const req = this.getRequestObject();
		if (req.rawBody === undefined) {
			await req.readRawBody();
		}

		if (!verifySignature(stored.secret ?? '', req.rawBody, signature)) {
			this.getResponseObject().status(401).json({ message: 'Invalid or missing signature' });

			return { noWebhookResponse: true };
		}

		return { workflowData: [[{ json: this.getBodyData() }]] };
	}
}
