import { ApplicationError } from 'n8n-workflow';
import type { IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import {
	collection,
	idPicker,
	isSet,
	jsonField,
	oneItem,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import type {
	OperationContext,
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

/*
 * Hub (the meeting-recording product). Contracts: https://dutify.ai/api/v1/api-catalog/{Calls,
 * Recordings,Lens}; the catalog has no response schemas or examples for these, so
 * response shapes come from the Hub backend source (origin/master).
 *
 * Every Hub resource is workspaceScoped: a personal API key must name its workspace in
 * X-Dutify-Workspace (without it Hub answers 400 WORKSPACE_REQUIRED), which the registry sends.
 */

/* ---------- calls ---------- */

/** Pages are zero-based. The backend takes any size; 100 keeps a page of full call DTOs bearable. */
const CALL_PAGING: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

const CALLS = '/api/usercall';

const callField = (): INodeProperties =>
	idPicker('Call Name or ID', 'call', 'getHubCalls', undefined);

const queryField = (description: string): INodeProperties => ({
	displayName: 'Query',
	name: 'query',
	type: 'string',
	default: '',
	description,
});

const SEARCH_DESCRIPTION =
	'Text to look for in the call name, description, attendees and transcript. Leave empty to match every call.';

const callOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'List',
		action: 'List calls',
		description: 'List your calls, most recent first',
		fields: [],
		list: true,
		build: () => ({ method: 'GET', path: `${CALLS}/all`, paginate: CALL_PAGING }),
	},
	{
		operation: 'count',
		name: 'Count',
		action: 'Count calls',
		description: 'Get the total number of your calls',
		fields: [],
		build: () => ({ method: 'GET', path: `${CALLS}/all/count` }),
	},
	{
		operation: 'search',
		name: 'Search',
		action: 'Search calls',
		description: 'Search calls by name, description, attendees and transcript',
		fields: [
			queryField(SEARCH_DESCRIPTION),
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'Light Rows',
					name: 'lite',
					type: 'boolean',
					default: false,
					description:
						'Whether to return only the fields a list row shows. The full response carries every transcript and AI output and can be hundreds of times larger.',
				},
			]),
		],
		list: true,
		build: (p) => ({
			method: 'GET',
			path: `${CALLS}/search`,
			qs: {
				query: p.get<string>('query', ''),
				view: p.get<IDataObject>('additionalFields', {}).lite === true ? 'lite' : undefined,
			},
			paginate: CALL_PAGING,
		}),
	},
	{
		operation: 'countSearch',
		name: 'Count Search Results',
		action: 'Count calls matching a search',
		description: 'Get the number of calls matching a search',
		fields: [queryField(SEARCH_DESCRIPTION)],
		build: (p) => ({
			method: 'GET',
			path: `${CALLS}/search/count`,
			qs: { query: p.get<string>('query', '') },
		}),
	},
	{
		operation: 'get',
		name: 'Get',
		action: 'Get a call',
		description: 'Get one call with its summary, attendees, recordings and action items',
		fields: [callField()],
		build: (p) => ({ method: 'GET', path: `${CALLS}/${encodeURIComponent(p.get<string>('call'))}` }),
	},
];

/** Hub calls (the metadata wrapper around a recording). Scope: recordings:read. */
export const call: ResourceDef = {
	value: 'call',
	name: 'Call',
	workspaceScoped: true,
	operations: callOperations,
};

/* ---------- recordings ---------- */

const recordingPath = (p: ParamReader) =>
	encodePath`/api/recording/${p.get<string>('recording')}`;

const recordingField = (): INodeProperties =>
	idPicker('Recording Name or ID', 'recording', 'getHubRecordings', undefined);

/** A signed-URL response is the URL itself (a bare or JSON-quoted string); accept an object too. */
function signedUrl(response: unknown): string {
	const value =
		response !== null && typeof response === 'object'
			? (response as IDataObject).url
			: response;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ApplicationError('Hub returned no signed URL for this recording');
	}

	return value.trim().replace(/^"|"$/g, '');
}

function urlOperation(
	operation: string,
	segment: string,
	kind: string,
	name: string,
	action: string,
	description: string,
): OperationDef {
	return {
		operation,
		name,
		action,
		description,
		fields: [
			recordingField(),
			{
				displayName: 'Download File',
				name: 'download',
				type: 'boolean',
				default: false,
				description:
					'Whether to download the file into the binary property "data" instead of only returning the short-lived URL',
			},
			collection('Additional Fields', 'additionalFields', [
				{
					displayName: 'URL Expiry (Minutes)',
					name: 'expiryMinutes',
					type: 'number',
					default: 30,
					typeOptions: { minValue: 1 },
					description: 'How long the signed URL stays valid',
				},
			]),
		],
		run: async (ctx: OperationContext, p: ParamReader): Promise<INodeExecutionData[]> => {
			const { expiryMinutes } = p.get<IDataObject>('additionalFields', {});
			const id = p.get<string>('recording');
			const url = signedUrl(
				await ctx.request({
					method: 'GET',
					path: `${recordingPath(p)}/${segment}`,
					...(isSet(expiryMinutes) ? { qs: { expiryMinutes } } : {}),
				}),
			);
			const item: INodeExecutionData = { json: { url } };
			if (p.get<boolean>('download', false)) {
				item.binary = { data: await ctx.downloadToBinary(url, `recording-${id}-${kind}`) };
			}

			return [item];
		},
	};
}

const reprocessOptions: INodeProperties[] = [
	{
		displayName: 'Apply Corrections',
		name: 'applyCorrections',
		type: 'boolean',
		default: false,
		description: 'Whether to apply corrections to the transcript',
	},
	{
		displayName: 'Processing Model',
		name: 'callProcessingMethod',
		type: 'options',
		options: [
			{ name: 'GPT 6 Luna', value: 'GPT_6_LUNA' },
			{ name: 'GPT 6 Luna Extended', value: 'GPT_6_LUNA_EXTENDED' },
			{ name: 'GPT 6 Luna Streaming', value: 'GPT_6_LUNA_STREAMING' },
			{ name: 'Qwen3 Coder', value: 'QWEN3_CODER' },
			{ name: 'Qwen3 Coder Streaming', value: 'QWEN3_CODER_STREAMING' },
		],
		default: 'GPT_6_LUNA',
		description: 'The model that runs the summary, key points and action items',
	},
	{
		displayName: 'Reasoning Effort',
		name: 'callReasoningEffort',
		type: 'options',
		options: [
			{ name: 'High', value: 'HIGH' },
			{ name: 'Low', value: 'LOW' },
			{ name: 'Medium', value: 'MEDIUM' },
		],
		default: 'MEDIUM',
		description: 'How much reasoning the model spends',
	},
];

const recordingOperations: OperationDef[] = [
	urlOperation(
		'getMediaUrl',
		'media-url',
		'media',
		'Get Media URL',
		'Get a signed URL for the recording',
		'Get a short-lived signed URL for the full recording (video and audio), optionally downloading it',
	),
	urlOperation(
		'getAudioUrl',
		'audio-url',
		'audio',
		'Get Audio URL',
		'Get a signed URL for the recording audio',
		"Get a short-lived signed URL for the recording's audio, optionally downloading it",
	),
	urlOperation(
		'getPreviewUrl',
		'preview-url',
		'preview',
		'Get Preview URL',
		'Get a signed URL for the recording preview',
		"Get a short-lived signed URL for the recording's preview thumbnail, optionally downloading it",
	),
	{
		operation: 'getProcessingStatus',
		name: 'Get Processing Status',
		action: 'Get the processing status of a recording',
		description: 'Get whether a recording is processed, its progress and its media state',
		fields: [recordingField()],
		build: (p) => ({ method: 'GET', path: `${recordingPath(p)}/processing-status` }),
	},
	{
		operation: 'getProgress',
		name: 'Get Progress',
		action: 'Get the processing progress of a recording',
		description: 'Get the processing progress of a recording as a number from 0 to 100',
		fields: [recordingField()],
		build: (p) => ({ method: 'GET', path: `${recordingPath(p)}/progress` }),
	},
	{
		operation: 'regenerateSummary',
		name: 'Regenerate Summary',
		action: 'Regenerate the summary of a recording',
		description:
			'Re-generate your own summary, key points and action items from the existing transcript. This uses AI compute.',
		fields: [
			recordingField(),
			{
				displayName: 'Save Result',
				name: 'saveToDb',
				type: 'boolean',
				default: true,
				description: 'Whether to store the new version. When off, the new summary is only returned.',
			},
		],
		run: async (ctx, p) => {
			const response = await ctx.request({
				method: 'POST',
				path: `${recordingPath(p)}/regenerate-summary`,
				body: { saveToDb: p.get<boolean>('saveToDb', true) },
			});

			return typeof response === 'string' ? [{ json: { summary: response } }] : oneItem(response);
		},
	},
	{
		operation: 'reprocess',
		name: 'Reprocess',
		action: 'Reprocess a recording',
		description:
			'Re-run the whole pipeline: transcription, summary, key points and action items. Slow and expensive; prefer Regenerate Summary.',
		fields: [recordingField(), collection('Additional Fields', 'additionalFields', reprocessOptions)],
		build: (p) => {
			const { callProcessingMethod, callReasoningEffort, applyCorrections } = p.get<IDataObject>(
				'additionalFields',
				{},
			);
			const body: IDataObject = {};
			if (isSet(callProcessingMethod)) {
				body.callProcessingMethod = callProcessingMethod;
			}
			if (isSet(callReasoningEffort)) {
				body.callReasoningEffort = callReasoningEffort;
			}
			if (applyCorrections !== undefined) {
				body.isCallApplyCorrections = applyCorrections;
			}

			return { method: 'POST', path: `${recordingPath(p)}/reprocess`, body };
		},
	},
];

/** Hub recordings. Scopes: recordings:read, recordings:write. */
export const recording: ResourceDef = {
	value: 'recording',
	name: 'Recording',
	workspaceScoped: true,
	operations: recordingOperations,
};

/* ---------- Lens ---------- */

/** The backend rejects a longer history (`@Size(max = 20)`). */
const MAX_LENS_HISTORY = 20;

/** A synthesis-heavy question takes 15 to 30 s; leave room well beyond that. */
export const LENS_TIMEOUT_MS = 120_000;

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function lensHistory(value: unknown): IDataObject[] | undefined {
	if (!isSet(value)) {
		return undefined;
	}
	const parsed: unknown = typeof value === 'string' ? parseJson(value) : value;
	if (!Array.isArray(parsed)) {
		throw new ApplicationError('History must be a JSON array of {user, content} messages');
	}
	if (parsed.length > MAX_LENS_HISTORY) {
		throw new ApplicationError(`History can hold at most ${MAX_LENS_HISTORY} messages`);
	}

	return parsed as IDataObject[];
}

const lensOperations: OperationDef[] = [
	{
		operation: 'ask',
		name: 'Ask',
		action: 'Ask Lens a question',
		description:
			"Ask Lens, which answers from the workspace's recordings, calls and transcripts. It can take 15 to 30 seconds and uses credits.",
		fields: [
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				description: 'Your question',
			},
			collection('Additional Fields', 'additionalFields', [
				jsonField(
					'History',
					'history',
					'Earlier turns of the conversation as a JSON array of {"user": "user" or "assistant", "content": "..."}, at most 20. Leave empty to start a conversation.',
				),
			]),
		],
		run: async (ctx, p) => {
			const history = lensHistory(p.get<IDataObject>('additionalFields', {}).history);
			const response = await ctx.request({
				method: 'POST',
				path: '/api/lens/chat',
				timeout: LENS_TIMEOUT_MS,
				body: {
					lastMessage: { content: p.get<string>('message') },
					...(history ? { history } : {}),
				},
			});

			return typeof response === 'string' ? [{ json: { answer: response } }] : oneItem(response);
		},
	},
];

/** Programmatic Lens chat. Scope: lens:chat. The response is a single answer, not a stream. */
export const lens: ResourceDef = {
	value: 'lens',
	name: 'Lens',
	workspaceScoped: true,
	operations: lensOperations,
};
