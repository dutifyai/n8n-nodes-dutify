import { ApplicationError, sleep } from 'n8n-workflow';
import type { IBinaryData, IDataObject, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import {
	collection,
	dateTime,
	idPicker,
	isSet,
	jsonField,
	oneItem,
	splitList,
	toInstant,
} from '../../../shared/fieldHelpers';
import { encodePath } from '../../../shared/transport';
import { resolveHubWorkspace } from '../../../shared/workspaces';
import type {
	BinaryStream,
	ByteStream,
	OperationContext,
	OperationDef,
	PaginationStyle,
	ParamReader,
	ResourceDef,
} from '../../../shared/types';

/*
 * Dutify Hub (meetings and recordings). Contracts: https://dutify.ai/api/v1/api-catalog/{Calls,
 * Recordings,AI%20Coworker}; the catalog has no response schemas or examples for these, so
 * response shapes come from the Hub backend source (origin/master).
 *
 * Hub answers errors as `{message, errorCode}` (the transport shows both), e.g. 404 NOT_FOUND for
 * a recording the caller may not see, 404 NO_PREVIEW, 409 RECORDING_STILL_PROCESSING.
 *
 * Every Hub resource is workspaceScoped: a personal API key must name its workspace in
 * X-Dutify-Workspace (without it Hub answers 400 WORKSPACE_REQUIRED), which the registry sends.
 */

/* ---------- calls ---------- */

/**
 * Pages are zero-based and the backend takes any size. Light rows (the default) are small, so a
 * page is 100. A full row carries every transcript and AI output (Hub measured 4.2 MB for 20
 * rows), so a full-view page is 20.
 */
const pagingOf = (maxPageSize: number): PaginationStyle => ({
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize,
});
const LITE_PAGING = pagingOf(100);
const FULL_PAGING = pagingOf(20);

const CALLS = '/api/usercall';

const RECENT_ONLY =
	' Only the 100 most recent calls are listed; for an older one, set an expression with its ID.';

const callField = (): INodeProperties => {
	const field = idPicker('Call Name or ID', 'call', 'getHubCalls', undefined);

	return { ...field, description: field.description + RECENT_ONLY };
};

const liteRowsOption: INodeProperties = {
	displayName: 'Light Rows',
	name: 'lite',
	type: 'boolean',
	default: true,
	description:
		'Whether to return only the fields a list row shows. Turn off for the full call with every transcript and AI output, which is hundreds of times larger and fetched 20 at a time.',
};

/** Light rows unless the user turned them off. */
const isLite = (p: ParamReader) => p.get<IDataObject>('additionalFields', {}).lite !== false;

const queryField = (description: string): INodeProperties => ({
	displayName: 'Query',
	name: 'query',
	type: 'string',
	default: '',
	description,
});

const SEARCH_DESCRIPTION =
	'Text to look for in the call name, description, attendees and transcript. Leave empty to match every call.';

const callPath = (p: ParamReader) => `${CALLS}/${encodeURIComponent(p.get<string>('call'))}`;

/** A multi-select value as a list of IDs, refused when empty. */
function nonEmptyList(value: unknown, what: string): string[] {
	const ids = splitList(value);
	if (ids.length === 0) {
		throw new ApplicationError(`Choose at least one ${what}`);
	}

	return ids;
}

function requiredText(value: string, what: string): string {
	if (!isSet(value) || value.trim() === '') {
		throw new ApplicationError(`${what} is empty`);
	}

	return value.trim();
}

/** The call's UUID, which the selection endpoints take instead of its integer ID. */
async function callUuid(ctx: OperationContext, p: ParamReader): Promise<string> {
	const row = (await ctx.request({ method: 'GET', path: callPath(p) })) as {
		call?: { callUuid?: string };
	} | null;
	const uuid = row?.call?.callUuid;
	if (!uuid) {
		throw new ApplicationError(`Hub returned no UUID for call ${p.get<string>('call')}`);
	}

	return uuid;
}

/**
 * Hub's selection endpoints: they store a vendor destination for the call's action items on the
 * caller's participation, and create nothing in the vendor (Hub creates new action items in
 * Dutify Cloud). Hub refuses a bad body (400 INVALID_SELECTION), an unknown call
 * (404 CALL_NOT_FOUND) and a vendor not connected to the caller's default workspace
 * (409 INTEGRATION_NOT_CONNECTED), and stores nothing on a refusal. Its message reaches the user.
 *
 * The operation values keep their original `sendTo…` names so saved workflows keep working.
 */
function selectionOperation(options: {
	operation: string;
	vendor: string;
	segment: string;
	fields: INodeProperties[];
	target: (p: ParamReader) => IDataObject;
}): OperationDef {
	const { operation, vendor, segment, fields, target } = options;

	return {
		operation,
		name: `Select ${vendor} Destination`,
		action: `Select a ${vendor} destination for a call's action items`,
		description: `Stores a ${vendor} destination for the call's action items on your participation in the call. It creates no ${vendor} item: Dutify creates new action items in Dutify Cloud. accepted: true means the destination was stored. Dutify refuses it when ${vendor} is not connected to your default workspace`,
		fields: [callField(), ...fields],
		run: async (ctx, p) => {
			const body = target(p);
			const response = await ctx.request({
				method: 'POST',
				path: `${CALLS}/selection/${segment}`,
				body: { callUUID: await callUuid(ctx, p), ...body },
			});

			return [{ json: { accepted: response === true || response === 'true' } }];
		},
	};
}

const callOperations: OperationDef[] = [
	{
		operation: 'list',
		name: 'Get Many',
		action: 'Get many calls',
		description: 'List your calls, most recent first',
		fields: [collection('Additional Fields', 'additionalFields', [liteRowsOption])],
		list: true,
		// /all has no light view; an empty search is the same list in the same order.
		build: (p) =>
			isLite(p)
				? {
						method: 'GET',
						path: `${CALLS}/search`,
						qs: { query: '', view: 'lite' },
						paginate: LITE_PAGING,
					}
				: { method: 'GET', path: `${CALLS}/all`, paginate: FULL_PAGING },
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
			collection('Additional Fields', 'additionalFields', [liteRowsOption]),
		],
		list: true,
		build: (p) => ({
			method: 'GET',
			path: `${CALLS}/search`,
			qs: {
				query: p.get<string>('query', ''),
				view: isLite(p) ? 'lite' : undefined,
			},
			paginate: isLite(p) ? LITE_PAGING : FULL_PAGING,
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
		build: (p) => ({ method: 'GET', path: callPath(p) }),
	},
	{
		operation: 'delete',
		name: 'Delete',
		action: 'Delete a call',
		description:
			'Permanently delete a call with its recording media, transcript and notes. This cannot be undone',
		fields: [callField()],
		build: (p) => ({ method: 'DELETE', path: callPath(p) }),
	},
	selectionOperation({
		operation: 'sendToJira',
		vendor: 'Jira',
		segment: 'jira',
		fields: [
			{
				...idPicker('Jira Site Name or ID', 'jiraCloud', 'getJiraClouds', undefined),
				description:
					'The Jira site (cloud) of the destination. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Jira Project Names or IDs',
				name: 'jiraProjects',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getJiraProjects', loadOptionsDependsOn: ['jiraCloud'] },
				default: [],
				required: true,
				description:
					'The Jira projects of the destination. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
		target: (p) => ({
			cloudId: p.get<string>('jiraCloud'),
			projectIds: nonEmptyList(p.get<unknown>('jiraProjects', []), 'Jira project'),
		}),
	}),
	selectionOperation({
		operation: 'sendToClickUp',
		vendor: 'ClickUp',
		segment: 'clickup',
		fields: [
			{
				displayName: 'ClickUp List ID',
				name: 'clickUpList',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. 901234567890',
				description:
					'The ClickUp list of the destination: the number after /li/ in the list URL. Dutify does not list ClickUp lists, so it is typed here.',
			},
		],
		target: (p) => ({
			selectedListId: requiredText(p.get<string>('clickUpList', ''), 'ClickUp List ID'),
		}),
	}),
	selectionOperation({
		operation: 'sendToAirtable',
		vendor: 'Airtable',
		segment: 'airtable',
		fields: [
			idPicker('Airtable Base Name or ID', 'airtableBase', 'getAirtableBases', undefined),
			{
				displayName: 'Airtable Table Names or IDs',
				name: 'airtableTables',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getAirtableTables',
					loadOptionsDependsOn: ['airtableBase'],
				},
				default: [],
				required: true,
				description:
					'The Airtable tables of the destination. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
		target: (p) => ({
			baseId: p.get<string>('airtableBase'),
			tableIds: nonEmptyList(p.get<unknown>('airtableTables', []), 'Airtable table'),
		}),
	}),
	{
		operation: 'setCustomPrompt',
		name: 'Set Custom Prompt',
		action: 'Set the custom prompt of a call',
		description:
			'Set your own prompt for this call. It shapes only your version of the notes and is stored only: run Recording > Regenerate Summary to apply it',
		fields: [
			callField(),
			{
				displayName: 'Custom Prompt',
				name: 'customPrompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description:
					'Instructions for the AI when it analyses this call. It replaces your current prompt for the call.',
			},
		],
		build: (p) => {
			const prompt = p.get<string>('customPrompt', '');
			if (prompt.trim() === '') {
				throw new ApplicationError(
					'Custom Prompt is empty. To remove the prompt, use Clear Custom Prompt.',
				);
			}

			return {
				method: 'PUT',
				path: `${callPath(p)}/custom-prompt`,
				body: { customPrompt: prompt },
			};
		},
	},
	{
		operation: 'clearCustomPrompt',
		name: 'Clear Custom Prompt',
		action: 'Clear the custom prompt of a call',
		description:
			'Remove your own prompt for this call. Your next Regenerate Summary runs without it',
		fields: [callField()],
		build: (p) => ({ method: 'DELETE', path: `${callPath(p)}/custom-prompt` }),
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

const recordingPath = (p: ParamReader) => encodePath`/api/recording/${p.get<string>('recording')}`;

const recordingField = (): INodeProperties => {
	const field = idPicker('Recording Name or ID', 'recording', 'getHubRecordings', undefined);

	return {
		...field,
		description:
			field.description +
			' Only recordings of the 100 most recent calls are listed; for an older one, set an expression with its ID.',
	};
};

/** File extension for the content types Hub serves; none for anything else. */
const EXTENSIONS: Record<string, string> = {
	'video/mp4': 'mp4',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/m4a': 'm4a',
	'audio/aac': 'aac',
	'audio/mpeg': 'mp3',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/webm': 'webm',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
};

/** Adds the extension that the content type implies to a downloaded file's name. */
function withExtension(binary: IBinaryData): IBinaryData {
	const extension = EXTENSIONS[(binary.mimeType ?? '').toLowerCase()];
	if (!extension) {
		return binary;
	}

	return {
		...binary,
		fileName: `${binary.fileName ?? 'recording'}.${extension}`,
		fileExtension: extension,
	};
}

/** A signed-URL response is the URL itself (a bare or JSON-quoted string); accept an object too. */
function signedUrl(response: unknown): string {
	const value =
		response !== null && typeof response === 'object' ? (response as IDataObject).url : response;
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
				item.binary = {
					data: withExtension(await ctx.downloadToBinary(url, `recording-${id}-${kind}`)),
				};
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
		'Get a short-lived signed URL for the recording file (audio or video), optionally downloading it',
	),
	urlOperation(
		'getAudioUrl',
		'audio-url',
		'audio',
		'Get Audio URL',
		'Get a signed URL for the recording audio',
		"Get a short-lived signed URL for the recording's audio, optionally downloading it. An uploaded video has no separate audio track, so this is the video file",
	),
	urlOperation(
		'getPreviewUrl',
		'preview-url',
		'preview',
		'Get Preview URL',
		'Get a signed URL for the recording preview',
		"Get a short-lived signed URL for the recording's preview thumbnail, optionally downloading it. Only a video has one: for an audio recording Dutify answers 404 NO_PREVIEW",
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
				description:
					'Whether to store the new version. When off, the new summary is only returned.',
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
			'Queue a re-run of the whole pipeline: transcription, summary, key points and action items. It returns at once; follow the run with Get Processing Status or the Meeting Processed trigger. Slow and expensive; prefer Regenerate Summary.',
		fields: [
			recordingField(),
			collection('Additional Fields', 'additionalFields', reprocessOptions),
		],
		/*
		 * schedule-reprocess, not /reprocess: the immediate route runs the pipeline while the
		 * request waits, which can outlast n8n's HTTP timeout and leaves the workflow without an
		 * answer. Both take the same body and refuse the same way (404 NOT_FOUND, 402
		 * TRANSCRIPTION_QUOTA_EXCEEDED, 409 WORKFLOW_IN_PROGRESS or RECORDING_MEDIA_MISSING).
		 */
		run: async (ctx, p) => {
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
			await ctx.request({ method: 'POST', path: `${recordingPath(p)}/schedule-reprocess`, body });

			return [{ json: { recording: p.get<string>('recording'), scheduled: true } }];
		},
	},
];

/* ---------- upload (Recording Upload: session → PUT → complete) ---------- */

interface UploadSession {
	blobName?: string;
	uploadUrl?: string | null;
	/** Set (16 MiB) for a resumable session on multipart storage; uploadUrl is then null. */
	partSize?: number | null;
}

const NOTE_TEMPLATES = [
	{ name: 'General', value: 'general' },
	{ name: 'Interview', value: 'interview' },
	{ name: 'One on One', value: 'one_on_one' },
	{ name: 'Sales', value: 'sales' },
	{ name: 'Standup', value: 'standup' },
];

/** Hub's per-file limit (VideoService.MAX_DIRECT_UPLOAD_BYTES): 5000 MiB. */
export const MAX_UPLOAD_BYTES = 5000 * 1024 * 1024;

/** Completion answers 503 on a transient storage check; it is retried with the same blob. */
const COMPLETE_ATTEMPTS = 3;
export const uploadTiming = { retryDelayMs: 2000 };

/** Number of parts of `partSize` bytes (the last one shorter) a file of `size` bytes takes. */
export function partCount(size: number, partSize: number): number {
	return Math.ceil(size / partSize);
}

/**
 * Regroups a byte stream into parts of exactly `partSize` bytes (the last one shorter). It holds at
 * most one part plus one incoming chunk, so a file of any size is uploaded in bounded memory.
 */
export async function* partsOf(
	content: ByteStream | Buffer,
	partSize: number,
): AsyncGenerator<Buffer> {
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const chunks: AsyncIterable<unknown> | Iterable<unknown> = Buffer.isBuffer(content)
		? [content]
		: content;
	for await (const chunk of chunks) {
		let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		while (rest.length > 0) {
			const take = Math.min(partSize - pendingBytes, rest.length);
			pending.push(rest.subarray(0, take));
			pendingBytes += take;
			rest = rest.subarray(take);
			if (pendingBytes === partSize) {
				yield Buffer.concat(pending, partSize);
				pending = [];
				pendingBytes = 0;
			}
		}
	}
	if (pendingBytes > 0) {
		yield Buffer.concat(pending, pendingBytes);
	}
}

const uploadSessionPath = (blobName: string) => encodePath`/api/videos/upload-session/${blobName}`;

/** Stops reading the file (a no-op for bytes already in memory). */
function close(file: BinaryStream): void {
	if (!Buffer.isBuffer(file.content)) {
		file.content.destroy();
	}
}

/**
 * Hub's multipart flow: each part is signed (POST .../parts/{n}) and PUT from the stream before the
 * next one is read. A stream that is shorter or longer than the declared size is refused before
 * the offending part is signed.
 */
async function putParts(
	ctx: OperationContext,
	blobName: string,
	file: BinaryStream,
	partSize: number,
	mimeType: string,
): Promise<void> {
	const count = partCount(file.size, partSize);
	let number = 0;
	let sent = 0;
	for await (const part of partsOf(file.content, partSize)) {
		number += 1;
		if (number > count) {
			throw new ApplicationError(
				`The file holds more than the ${file.size} bytes its binary data declares`,
			);
		}
		const expected = Math.min(partSize, file.size - sent);
		if (part.length < expected) {
			throw new ApplicationError(
				`The file ended after ${sent + part.length} of ${file.size} bytes`,
			);
		}
		const signed = (await ctx.request({
			method: 'POST',
			path: `${uploadSessionPath(blobName)}/parts/${number}`,
		})) as { uploadUrl?: string | null } | null;
		if (!signed?.uploadUrl) {
			throw new ApplicationError(`Hub returned no upload URL for part ${number}`);
		}
		await ctx.putBinary(signed.uploadUrl, part, mimeType);
		sent += part.length;
	}
	if (sent < file.size) {
		throw new ApplicationError(`The file ended after ${sent} of ${file.size} bytes`);
	}
}

/** Completes the upload, retrying a 503 (Hub's transient storage check) with the same blob. */
async function completeUpload(ctx: OperationContext, body: IDataObject): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const outcome = await ctx.request({ method: 'POST', path: '/api/videos/complete', body }).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		if (outcome.ok) {
			return outcome.value;
		}
		const code = String((outcome.error as { httpCode?: unknown } | null)?.httpCode ?? '');
		if (code !== '503' || attempt >= COMPLETE_ATTEMPTS) {
			return await Promise.reject(outcome.error);
		}
		await sleep(uploadTiming.retryDelayMs * attempt);
	}
}

/**
 * Streams a file to Hub: opens a resumable session, signs and PUTs it part by part (Hub's part
 * size, 16 MiB) straight from n8n's binary stream, so only one part is in memory at a time, then
 * completes it, which registers the recording in the workspace and starts processing. Storage
 * without multipart gets the stream in one PUT. Files over 5000 MiB are refused before a session
 * starts. A session that fails at any step is released, so it does not hold one of the user's 10
 * upload slots for 6 hours.
 */
async function uploadRecording(ctx: OperationContext, p: ParamReader) {
	const property = p.get<string>('binaryPropertyName', 'data');
	const fields = p.get<IDataObject>('additionalFields', {});
	const file = await ctx.openBinary(property);
	if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
		close(file);
		throw new ApplicationError(
			file.size <= 0
				? `The binary property "${property}" is empty; nothing to upload`
				: `The file is ${file.size} bytes; Hub accepts at most 5000 MiB (${MAX_UPLOAD_BYTES} bytes) per upload`,
		);
	}
	const mimeType = file.mimeType || 'application/octet-stream';
	const session = (await ctx
		.request({
			method: 'POST',
			path: '/api/videos/upload-session',
			body: {
				fileName: isSet(fields.fileName) ? fields.fileName : file.fileName,
				fileSize: file.size,
				resumable: true,
			},
		})
		.catch(async (error: unknown) => {
			close(file);

			return await Promise.reject(error);
		})) as UploadSession | null;
	const blobName = session?.blobName;
	if (!blobName) {
		close(file);
		throw new ApplicationError('Hub returned no upload session');
	}

	const body: IDataObject = { blobName };
	if (isSet(fields.recordedAt)) {
		body.recordedAt = toInstant(fields.recordedAt);
	}
	for (const key of ['userNotes', 'noteTemplate'] as const) {
		if (isSet(fields[key])) {
			body[key] = fields[key];
		}
	}

	let completed: unknown;
	let done = false;
	try {
		if (session.partSize && !session.uploadUrl) {
			await putParts(ctx, blobName, file, session.partSize, mimeType);
		} else if (session.uploadUrl) {
			await ctx.putStream(session.uploadUrl, file.content, file.size, mimeType);
		} else {
			throw new ApplicationError('Hub returned no upload URL for this session');
		}
		completed = await completeUpload(ctx, body);
		done = true;
	} finally {
		if (!done) {
			close(file);
			await ctx
				.request({ method: 'DELETE', path: uploadSessionPath(blobName) })
				.catch(() => undefined);
		}
	}

	return oneItem(completed);
}

const uploadOperation: OperationDef = {
	operation: 'upload',
	name: 'Upload',
	action: 'Upload a recording',
	description:
		'Upload an audio or video file as a new recording of this workspace. Dutify transcribes and summarises it like any upload; the result carries recordingId. Uses transcription quota',
	fields: [
		{
			displayName: 'Input Binary Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			required: true,
			description:
				'Name of the binary property of the input item that holds the file (at most 5000 MiB). When n8n keeps binary data on disk or in S3 (the n8n 2.x default), the file is streamed to Dutify without being loaded into memory.',
		},
		collection('Additional Fields', 'additionalFields', [
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description:
					'The name to store the file under, with its extension. Default: the name of the binary file.',
			},
			{
				displayName: 'Note Template',
				name: 'noteTemplate',
				type: 'options',
				options: NOTE_TEMPLATES,
				default: 'general',
				description: 'The kind of meeting, which shapes the generated notes',
			},
			dateTime('Recorded At', 'recordedAt', 'When the meeting happened. Default: now.'),
			{
				displayName: 'Notes',
				name: 'userNotes',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Your own notes on the meeting',
			},
		]),
	],
	run: uploadRecording,
};

/** Hub recordings. Scopes: recordings:read, recordings:write. */
export const recording: ResourceDef = {
	value: 'recording',
	name: 'Recording',
	workspaceScoped: true,
	operations: [...recordingOperations, uploadOperation],
};

/* ---------- AI Coworker (Hub's API calls it lens) ---------- */

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
		action: 'Ask AI Coworker a question',
		description:
			"Ask AI Coworker, which answers from the workspace's recordings, calls and transcripts. It can take 15 to 30 seconds and counts toward the workspace's AI Coworker usage, which is billed separately.",
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
	{
		operation: 'getUsage',
		name: 'Get Usage',
		action: 'Get the AI Coworker usage of the workspace',
		description:
			'Get what the workspace has left for AI Coworker questions: allowanceRemaining of the monthlyAllowance (renewed at cycleResetsAt), purchasedBalance and total. Each question uses one; at total 0 Ask fails with 402 AI_COWORKER_USAGE_EXHAUSTED.',
		fields: [],
		// getAiCoworkerUsage takes the workspace's Hub UUID; a key may read only its own workspace.
		run: async (ctx, p) => {
			const { id } = await resolveHubWorkspace(
				async (spec) => await ctx.request(spec),
				p.workspace,
			);

			return oneItem(
				await ctx.request({
					method: 'GET',
					path: encodePath`/api/v1/lens/credits/by-workspace/${String(id)}`,
				}),
			);
		},
	},
];

/**
 * The AI Coworker: programmatic chat (the answer is a single response, not a stream) and the
 * workspace's usage balance. Scope: lens:chat. The value stays `lens` so saved workflows keep
 * working.
 */
export const lens: ResourceDef = {
	value: 'lens',
	name: 'AI Coworker',
	workspaceScoped: true,
	operations: lensOperations,
};
