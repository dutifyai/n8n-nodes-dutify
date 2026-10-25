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
import { dutifyRequest, toNodeError } from '../../shared/transport';
import type { ParamReader, RequestSpec } from '../../shared/types';
import { listSearch, loadOptions } from '../Dutify/loaders';
import { scopeBody, scopeFields } from '../Dutify/resources/pmWebhook';
import { sources, verifySignature } from './sources';
import type { WebhookSource } from './sources';

/** Static data of the node: the registered webhook and the secret that signs its deliveries. */
interface StoredWebhook extends IDataObject {
	webhookId?: string;
	secret?: string;
}

const forPm = (field: INodeProperties): INodeProperties => ({
	...field,
	displayOptions: { show: { source: ['pm'], ...(field.displayOptions?.show ?? {}) } },
});

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

const isNotFound = (error: unknown) =>
	String((error as { httpCode?: unknown } | null)?.httpCode) === '404';

/** Deletes a webhook; one that is already gone counts as deleted. */
async function removeWebhook(
	ctx: IHookFunctions,
	source: WebhookSource,
	id: string,
	workspace: string,
): Promise<void> {
	try {
		await dutifyRequest.call(ctx, source.remove(id, { workspace }), workspace);
	} catch (error) {
		if (!isNotFound(error)) {
			throw toNodeError(ctx.getNode(), error);
		}
	}
}

/** The source settings of the create request. A task key scope is resolved to its `tsk_` ID. */
async function sourceConfig(ctx: IHookFunctions, workspace: string): Promise<IDataObject> {
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
				// Can grow `codexum` (wiki), `roadmarq` (feature requests) and `meeting` (Hub) later.
				options: [
					{
						name: 'Project Management',
						value: 'pm',
						description: 'Task, comment, list, space and workspace events',
					},
				],
				default: 'pm',
				description: 'The Dutify service whose events start the workflow',
			},
			forPm(workspaceField),
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
			/** True while the stored webhook is still registered at this URL; a restart then reuses it. */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				if (!stored.webhookId || !stored.secret) {
					return false;
				}
				const source = sourceOf(this);
				const workspace = workspaceOf(this);
				const listed = await dutifyRequest.call(this, source.list({ workspace }), workspace);

				return source.findExisting(listed, webhookUrlOf(this), stored.webhookId) !== null;
			},

			/**
			 * Registers this URL with a fresh secret. A leftover webhook at this URL (its secret is
			 * lost) and the previously stored one are removed first, so no duplicate keeps delivering.
			 */
			async create(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				const source = sourceOf(this);
				const workspace = workspaceOf(this);
				const url = webhookUrlOf(this);
				const cfg = await sourceConfig(this, workspace);

				const listed = await dutifyRequest.call(this, source.list({ workspace }), workspace);
				const stale = new Set<string>();
				const leftover = source.findExisting(listed, url);
				if (leftover) {
					stale.add(leftover);
				}
				if (stored.webhookId) {
					stale.add(stored.webhookId);
				}
				for (const id of stale) {
					await removeWebhook(this, source, id, workspace);
				}
				delete stored.webhookId;
				delete stored.secret;

				const secret = randomBytes(32).toString('hex');
				const created = await dutifyRequest.call(
					this,
					source.create(url, secret, cfg),
					workspace,
				);
				const { id } = source.parseCreated(created, secret);
				stored.webhookId = id;
				stored.secret = secret;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const stored = this.getWorkflowStaticData('node') as StoredWebhook;
				if (!stored.webhookId) {
					return true;
				}
				const source = sourceOf(this);
				const workspace = workspaceOf(this);
				try {
					await removeWebhook(this, source, stored.webhookId, workspace);
				} catch (error) {
					this.logger?.warn(`Could not delete Dutify webhook ${stored.webhookId}`, { error });

					return false;
				}
				delete stored.webhookId;
				delete stored.secret;

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
		const { rawBody } = this.getRequestObject();

		if (!verifySignature(stored.secret ?? '', rawBody, signature)) {
			this.getResponseObject().status(401).json({ message: 'Invalid or missing signature' });

			return { noWebhookResponse: true };
		}

		return { workflowData: [[{ json: this.getBodyData() }]] };
	}
}
