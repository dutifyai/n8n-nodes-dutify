import type { IDataObject, INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import {
	collection,
	idPicker,
	isSet,
	oneItem,
	requireChange,
	text,
} from '../../../shared/fieldHelpers';
import type { OperationDef, ParamReader, ResourceDef } from '../../../shared/types';

/*
 * Hub personal webhooks ("User Webhooks"): Hub POSTs the processed meeting to the URL each time a
 * meeting finishes processing. Contract: https://dutify.ai/api/v1/api-catalog/User%20Webhooks;
 * the catalog has no examples, so request/response details come from Hub origin/master
 * (UserWebhookResource, UserWebhookService, UserWebhookDTO, WebhookSection).
 *
 * - Scopes: webhooks:read (list, get, deliveries) or webhooks:write (create, update, delete,
 *   test), each together with recordings:read. Personal keys only.
 * - A webhook created through a key is bound to the key's workspace (the X-Dutify-Workspace
 *   header the registry sends): it only receives that workspace's meetings, and a key only sees
 *   webhooks bound to its own workspace.
 * - At most 10 webhooks per user, across all workspaces. The URL must be public https.
 * - Deliveries carry X-Dutify-Signature: sha256=<hex HMAC-SHA256 of the raw body> when a
 *   secret is set.
 */

const HOOKS = '/api/user/webhooks';

const hookPath = (p: ParamReader) => `${HOOKS}/${encodeURIComponent(p.get<string>('webhook'))}`;

/** WebhookSection keys, in Hub's canonical order. */
export const MEETING_SECTION_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Summary', value: 'summary' },
	{ name: 'Key Points', value: 'keyPoints' },
	{ name: 'Action Items', value: 'actionItems' },
	{ name: 'Enhanced Notes', value: 'enhancedNotes' },
	{ name: 'Transcript', value: 'transcript', description: 'The full transcript; can be large' },
	{ name: 'Notes', value: 'notes', description: 'Your own notes on the meeting' },
	{ name: 'Insights', value: 'insights' },
	{ name: 'Themes', value: 'themes' },
	{ name: 'Scores', value: 'scores', description: 'Productivity, sentiment and timing' },
	{ name: 'Speakers', value: 'speakers' },
	{ name: 'Tags', value: 'tags' },
	{ name: 'Tasks', value: 'tasks', description: 'Tasks the meeting created or proposed' },
];

/** What Hub sends when a webhook names no sections. */
export const DEFAULT_MEETING_SECTIONS = ['summary', 'keyPoints', 'actionItems', 'tasks'];

/** The sections of a new webhook (and of the trigger), preset to Hub's defaults. */
export const sectionsField: INodeProperties = {
	displayName: 'Sections',
	name: 'sections',
	type: 'multiOptions',
	options: MEETING_SECTION_OPTIONS,
	// DEFAULT_MEETING_SECTIONS, spelled out: the lint rule wants a literal array.
	default: ['summary', 'keyPoints', 'actionItems', 'tasks'],
	description:
		'The parts of the processed meeting each delivery carries. The meeting metadata (IDs, title, time, duration) is always sent.',
};

const updateSectionsField: INodeProperties = {
	displayName: 'Sections',
	name: 'sections',
	type: 'multiOptions',
	options: MEETING_SECTION_OPTIONS,
	default: [],
	description:
		'The complete list of sections to send. It replaces the current list, so leave it empty to keep the sections as they are.',
};

const webhookField = (): INodeProperties =>
	idPicker('Webhook Name or ID', 'webhook', 'getMeetingWebhooks', undefined);

const secretField = (description: string): INodeProperties => ({
	displayName: 'Secret',
	name: 'secret',
	type: 'string',
	typeOptions: { password: true },
	default: '',
	description,
});

const activeOption = (description: string): INodeProperties => ({
	displayName: 'Active',
	name: 'active',
	type: 'boolean',
	default: true,
	description,
});

/** The fields both create and update send, from n8n values to UserWebhookDTO. */
function hookBody(fields: IDataObject): IDataObject {
	const body: IDataObject = {};
	for (const key of ['url', 'secret', 'name'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}
	if (typeof fields.active === 'boolean') {
		body.enabled = fields.active;
	}

	return body;
}

const operations: OperationDef[] = [
	{
		operation: 'create',
		name: 'Create',
		action: 'Create a meeting webhook',
		description:
			'Send each processed meeting of this workspace to a URL. Dutify signs each delivery with the secret (HMAC-SHA256, X-Dutify-Signature header). At most 10 webhooks per user',
		fields: [
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/meeting-hook',
				description: 'The public https:// endpoint that receives the processed meetings',
			},
			secretField(
				'The key that signs every delivery. Keep it: Dutify never returns it, so a receiver needs this value to verify signatures. Without one, deliveries are not signed.',
			),
			sectionsField,
			collection('Additional Fields', 'additionalFields', [
				text('Name', 'name', 'A label for the webhook (up to 100 characters)'),
				activeOption('Whether the webhook delivers meetings. Turn it off to create it paused.'),
			]),
		],
		build: (p) => {
			const fields = p.get<IDataObject>('additionalFields', {});
			const body = hookBody({
				url: p.get<string>('url'),
				secret: p.get<string>('secret', ''),
				...fields,
			});
			body.sections = p.get<string[]>('sections', DEFAULT_MEETING_SECTIONS);

			return { method: 'POST', path: HOOKS, body };
		},
	},
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many meeting webhooks',
		description:
			'List your meeting webhooks of this workspace, oldest first, each with its last delivery. The secret is never included',
		fields: [],
		build: () => ({ method: 'GET', path: HOOKS }),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a meeting webhook',
		description: 'Fetch a meeting webhook. The secret is never included, only whether one is set',
		fields: [webhookField()],
		build: (p) => ({ method: 'GET', path: hookPath(p) }),
	},
	{
		operation: 'update',
		name: 'Update',
		action: 'Update a meeting webhook',
		description: 'Change the URL, secret, name, sections or state of a meeting webhook',
		fields: [
			webhookField(),
			collection('Update Fields', 'updateFields', [
				text('URL', 'url', 'The new public https:// endpoint'),
				secretField(
					'The new signing key. Leave it empty to keep the current one; a secret cannot be removed here, so deliveries stay signed.',
				),
				text('Name', 'name', 'A new label (up to 100 characters)'),
				updateSectionsField,
				activeOption('Whether the webhook delivers meetings. Turn it off to pause it.'),
			]),
		],
		run: async (ctx, p) => {
			const fields = p.get<IDataObject>('updateFields', {});
			const changes = hookBody(fields);
			if (Array.isArray(fields.sections) && fields.sections.length > 0) {
				changes.sections = fields.sections;
			}
			requireChange(changes);
			// Hub validates the URL on every update, so an update that keeps it must send it again.
			if (!changes.url) {
				const current = (await ctx.request({ method: 'GET', path: hookPath(p) })) as IDataObject;
				changes.url = current?.url;
			}

			return oneItem(await ctx.request({ method: 'PUT', path: hookPath(p), body: changes }));
		},
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a meeting webhook',
		description: 'Delete a meeting webhook and its delivery log',
		fields: [webhookField()],
		build: (p) => ({ method: 'DELETE', path: hookPath(p) }),
	},
	{
		operation: 'test',
		name: 'Send Test Delivery',
		action: 'Send a test delivery to a meeting webhook',
		description:
			'Send your latest processed meeting of this workspace (or a sample meeting when there is none) to the URL now, marked test: true. The result is the delivery record',
		fields: [webhookField()],
		build: (p) => ({ method: 'POST', path: `${hookPath(p)}/test` }),
	},
	{
		operation: 'listDeliveries',
		name: 'Get Delivery Log',
		action: 'Get the delivery log of a meeting webhook',
		description:
			'List the latest delivery attempts of a meeting webhook with their payloads, newest first',
		fields: [
			webhookField(),
			{
				displayName: 'Number of Deliveries',
				name: 'deliveries',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 25 },
				default: 25,
				description: 'How many of the latest deliveries to return. Dutify keeps the latest 25.',
			},
		],
		build: (p) => ({
			method: 'GET',
			path: `${hookPath(p)}/deliveries`,
			qs: { limit: p.get<number>('deliveries', 25) },
		}),
	},
];

/** Hub personal webhooks for processed meetings ("User Webhooks"). */
export const meetingWebhook: ResourceDef = {
	value: 'meetingWebhook',
	name: 'Meeting Webhook',
	workspaceScoped: true,
	operations,
};
