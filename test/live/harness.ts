/**
 * Live-test harness: runs the real Dutify node (and its loaders) against production
 * https://dutify.ai with the test workspace's key from `.dutify-test.env`.
 *
 * Only the n8n runtime is emulated here: `getNodeParameter` (with node defaults and
 * resource-locator unwrapping), the binary helpers, and the HTTP helpers. HTTP failures
 * are thrown the way n8n-core does: an axios-style error wrapped in a real NodeApiError.
 * Everything else (registry, operations, transport, error mapping) is the shipped code.
 *
 * When `.dutify-test.env` is missing, `liveDescribe` skips the whole suite.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals --
   test-only code (not published): the harness must read .dutify-test.env from disk. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe } from 'vitest';
import { Dutify } from '../../nodes/Dutify/Dutify.node';
import { listSearch, loadOptions } from '../../nodes/Dutify/loaders';
import { dutifyRequest } from '../../shared/transport';
import type { RequestSpec } from '../../shared/types';

const ENV_FILE = resolve(__dirname, '../../.dutify-test.env');

function readEnv(): Record<string, string> | undefined {
	if (!existsSync(ENV_FILE)) {
		return undefined;
	}
	const env: Record<string, string> = {};
	for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match) {
			env[match[1]] = match[2];
		}
	}

	return env.DUTIFY_API_KEY && env.DUTIFY_TEST_WORKSPACE ? env : undefined;
}

const env = readEnv();

/** `describe` that skips the suite when `.dutify-test.env` is missing. */
export const liveDescribe = env ? describe : describe.skip;

export const live = {
	baseUrl: env?.DUTIFY_BASE_URL || 'https://dutify.ai',
	workspace: env?.DUTIFY_TEST_WORKSPACE ?? '',
	userEmail: env?.DUTIFY_TEST_USER_EMAIL ?? '',
	userId: env?.DUTIFY_TEST_USER_ID ?? '',
	/** An audio file to upload when the workspace has no test recording yet (optional). */
	audioFile: env?.DUTIFY_TEST_AUDIO ?? '',
	/** `1` runs the operations that cost AI credits (regenerate summary, reprocess, Lens). */
	paidOps: env?.DUTIFY_TEST_PAID_OPS === '1',
};

/** The bytes of `live.audioFile`, or undefined when it is not set or missing. */
export function readAudioFile(): Buffer | undefined {
	return live.audioFile && existsSync(live.audioFile) ? readFileSync(live.audioFile) : undefined;
}

/** A short unique suffix so parallel or repeated runs never collide on names. */
export const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A wiki space key for this run: 2 to 20 uppercase letters and digits, starting with a letter. */
export const wikiKey = (prefix: string) => `${prefix}${runId.toUpperCase()}`.slice(0, 20);

/** The workspace parameter as n8n stores a resource-locator value picked from the list. */
export function workspaceLocator(value = live.workspace) {
	return { __rl: true, mode: 'list', value };
}

const node: INode = {
	id: 'live-test-node',
	name: 'Dutify',
	type: '@dutifyai/n8n-nodes-dutify.dutify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const properties: INodeProperties[] = new Dutify().description.properties;

function shown(property: INodeProperties, params: IDataObject): boolean {
	const show = property.displayOptions?.show ?? {};

	return Object.entries(show).every(([key, allowed]) => {
		if (!Array.isArray(allowed)) {
			return true;
		}
		const value = params[key];

		return value === undefined
			? allowed.includes(defaultOf(key, params) as never)
			: allowed.includes(value as never);
	});
}

/** The default n8n would have stored for a parameter visible with these settings. */
function defaultOf(name: string, params: IDataObject): unknown {
	const property = properties.find((p) => p.name === name && shown(p, params));
	if (!property) {
		return undefined;
	}
	if (property.type === 'collection' || property.type === 'fixedCollection') {
		return property.default ?? {};
	}

	return property.default;
}

function unwrap(value: unknown, extractValue: boolean): unknown {
	if (
		extractValue &&
		value !== null &&
		typeof value === 'object' &&
		(value as IDataObject).__rl === true
	) {
		return (value as IDataObject).value;
	}

	return value;
}

function parameterReader(params: IDataObject) {
	return (name: string, fallback?: unknown, options?: { extractValue?: boolean }) => {
		const extract = options?.extractValue === true;
		if (Object.prototype.hasOwnProperty.call(params, name)) {
			return unwrap(params[name], extract);
		}
		const fromDefault = defaultOf(name, params);
		if (fromDefault !== undefined) {
			return unwrap(fromDefault, extract);
		}
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`Could not get parameter "${name}"`);
	};
}

function credentials(): IDataObject {
	if (!env) {
		throw new Error('live harness used without .dutify-test.env');
	}

	return { apiKey: env.DUTIFY_API_KEY, baseUrl: env.DUTIFY_BASE_URL || 'https://dutify.ai' };
}

/**
 * While active, PUTs to anything but Dutify (the presigned storage URLs) fail with 503, the way
 * an unreachable storage bucket would. Used to check the upload failure path.
 */
export const storageOutage = { active: false };

/** n8n-core style HTTP: axios semantics (qs, json, arrayFormat, returnFullResponse). */
async function httpRequest(options: IHttpRequestOptions): Promise<unknown> {
	const url = new URL(options.url);
	for (const [key, value] of Object.entries((options.qs ?? {}) as IDataObject)) {
		if (Array.isArray(value)) {
			for (const v of value) {
				url.searchParams.append(key, String(v));
			}
		} else if (value !== undefined && value !== null) {
			url.searchParams.append(key, String(value));
		}
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries((options.headers ?? {}) as IDataObject)) {
		headers[key] = String(value);
	}
	let body: BodyInit | undefined;
	if (options.body !== undefined) {
		if (Buffer.isBuffer(options.body)) {
			body = new Uint8Array(options.body as Buffer);
		} else if (typeof options.body === 'string') {
			body = options.body;
		} else {
			body = JSON.stringify(options.body);
			headers['Content-Type'] ??= 'application/json';
		}
	}
	if (storageOutage.active && options.method === 'PUT' && !url.href.startsWith(live.baseUrl)) {
		throw Object.assign(new Error('Request failed with status code 503'), {
			name: 'AxiosError',
			isAxiosError: true,
			status: 503,
			response: { status: 503, statusText: 'Service Unavailable', data: 'simulated', headers: {} },
		});
	}
	const response = await fetch(url, {
		method: options.method ?? 'GET',
		headers,
		body,
		signal: AbortSignal.timeout(options.timeout ?? 120_000),
	});
	const raw = Buffer.from(await response.arrayBuffer());
	const text = raw.toString('utf8');
	let parsed: unknown = text;
	if (options.encoding !== 'arraybuffer' && text !== '') {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
	}
	const responseHeaders = Object.fromEntries(response.headers.entries());
	if (!response.ok) {
		// The shape axios rejects with; n8n-core wraps it in NodeApiError.
		const error = Object.assign(new Error(`Request failed with status code ${response.status}`), {
			name: 'AxiosError',
			isAxiosError: true,
			status: response.status,
			response: {
				status: response.status,
				statusText: response.statusText,
				data: parsed,
				headers: responseHeaders,
			},
		});
		throw error;
	}
	const responseBody = options.encoding === 'arraybuffer' ? raw : parsed;

	return options.returnFullResponse
		? { body: responseBody, headers: responseHeaders, statusCode: response.status }
		: responseBody;
}

async function httpRequestWithAuthentication(
	this: unknown,
	_credentialType: string,
	options: IHttpRequestOptions,
): Promise<unknown> {
	const creds = credentials();
	try {
		return await httpRequest({
			...options,
			headers: { ...(options.headers ?? {}), 'X-API-Key': creds.apiKey as string },
		});
	} catch (error) {
		throw new NodeApiError(node, error as JsonObject);
	}
}

export interface BinaryInput {
	property: string;
	data: Buffer;
	mimeType: string;
	fileName: string;
}

function executeContext(params: IDataObject, binary?: BinaryInput): IExecuteFunctions {
	const item: INodeExecutionData = { json: {} };
	if (binary) {
		item.binary = {
			[binary.property]: {
				data: binary.data.toString('base64'),
				mimeType: binary.mimeType,
				fileName: binary.fileName,
			},
		};
	}
	const read = parameterReader(params);
	const ctx = {
		getInputData: () => [item],
		getNode: () => node,
		continueOnFail: () => false,
		getNodeParameter: (
			name: string,
			_itemIndex: number,
			fallback?: unknown,
			options?: { extractValue?: boolean },
		) => read(name, fallback, options),
		getCredentials: async () => credentials(),
		helpers: {
			httpRequestWithAuthentication,
			httpRequest,
			assertBinaryData: (_i: number, property: string) => {
				const data = item.binary?.[property];
				if (!data) {
					throw new Error(`No binary data property "${property}"`);
				}

				return data;
			},
			getBinaryDataBuffer: async (_i: number, property: string) =>
				Buffer.from(item.binary?.[property]?.data ?? '', 'base64'),
			prepareBinaryData: async (
				data: Buffer,
				fileName?: string,
				mimeType?: string,
			): Promise<IBinaryData> => ({
				data: data.toString('base64'),
				fileName,
				mimeType: mimeType ?? 'application/octet-stream',
				fileSize: String(data.length),
			}),
		},
	};

	return ctx as unknown as IExecuteFunctions;
}

/** Runs one Dutify operation with a single input item and returns its output items. */
export async function runOperation(
	resource: string,
	operation: string,
	params: IDataObject = {},
	binary?: BinaryInput,
): Promise<INodeExecutionData[]> {
	const all: IDataObject = { resource, operation, workspace: workspaceLocator(), ...params };
	const output = await new Dutify().execute.call(executeContext(all, binary));

	return output[0];
}

/** `runOperation` returning just the JSON of each item. */
export async function run(
	resource: string,
	operation: string,
	params: IDataObject = {},
): Promise<IDataObject[]> {
	return (await runOperation(resource, operation, params)).map((i) => i.json);
}

/** The first output item's JSON. */
export async function runOne(
	resource: string,
	operation: string,
	params: IDataObject = {},
): Promise<IDataObject> {
	const [first] = await run(resource, operation, params);

	return first;
}

/** Runs and returns the thrown error (fails if the operation succeeds). */
export async function runError(
	resource: string,
	operation: string,
	params: IDataObject = {},
): Promise<NodeApiError> {
	try {
		await runOperation(resource, operation, params);
	} catch (error) {
		return error as NodeApiError;
	}
	throw new Error(`${resource}.${operation} was expected to fail but succeeded`);
}

function loadContext(params: IDataObject): ILoadOptionsFunctions {
	const read = parameterReader({ workspace: workspaceLocator(), ...params });
	const ctx = {
		getNode: () => node,
		getNodeParameter: (name: string, fallback?: unknown, options?: { extractValue?: boolean }) =>
			read(name, fallback, options),
		getCurrentNodeParameter: (name: string, options?: { extractValue?: boolean }) =>
			read(name, undefined, options),
		getCredentials: async () => credentials(),
		helpers: { httpRequestWithAuthentication, httpRequest },
	};

	return ctx as unknown as ILoadOptionsFunctions;
}

/**
 * A Dutify Trigger hook context (checkExists / create / delete) over the live credential. Pass
 * every trigger parameter: defaults are read from the action node, not the trigger.
 */
export function hookContextOf(
	params: IDataObject,
	webhookUrl: string,
	staticData: IDataObject,
): IHookFunctions {
	const ctx = Object.assign(loadContext(params), {
		getNodeWebhookUrl: (name: string) => (name === 'default' ? webhookUrl : undefined),
		getWorkflowStaticData: () => staticData,
	});

	return ctx as unknown as IHookFunctions;
}

/** Runs a `loadOptions` method with the given (current) node parameters. */
export async function loadOptionsOf(
	method: keyof typeof loadOptions,
	params: IDataObject = {},
): Promise<INodePropertyOptions[]> {
	return await loadOptions[method].call(loadContext(params));
}

/** Runs a `listSearch` method. */
export async function searchList(
	method: keyof typeof listSearch,
	filter?: string,
): Promise<INodeListSearchResult> {
	return await listSearch[method].call(loadContext({}), filter);
}

/** A raw authenticated call through the node's own transport, for setup and cleanup. */
export async function rawRequest(spec: RequestSpec, workspace = live.workspace): Promise<unknown> {
	return await dutifyRequest.call(
		loadContext({}) as unknown as ILoadOptionsFunctions,
		spec,
		workspace,
	);
}

/**
 * Cleanup registry: `afterAll(cleanup.run)` undoes everything registered, newest first,
 * and reports (without failing) anything that could not be deleted.
 */
export function cleanupStack() {
	const steps: Array<{ label: string; undo: () => Promise<unknown> }> = [];

	return {
		add(label: string, undo: () => Promise<unknown>) {
			steps.push({ label, undo });
		},
		async run() {
			const failures: string[] = [];
			while (steps.length > 0) {
				const step = steps.pop();
				if (!step) {
					break;
				}
				try {
					await step.undo();
				} catch (error) {
					// 404: already gone (the test deleted it, which is the point of the test). A step
					// whose API answers a missing object differently handles that in its own undo.
					if ((error as NodeApiError).httpCode !== '404') {
						failures.push(`${step.label}: ${(error as Error).message}`);
					}
				}
			}
			if (failures.length > 0) {
				// Fails the suite: a leftover in the production test workspace must be noticed.
				throw new Error(`[live cleanup] could not undo:\n  ${failures.join('\n  ')}`);
			}
		},
	};
}

export type Cleanup = ReturnType<typeof cleanupStack>;

/**
 * Creates a fresh space through the node (Space > Create) and registers its deletion.
 * The node has no Space > Delete, so cleanup calls the catalog's DELETE /v1/spaces/{id},
 * which removes the space with every folder, list and task inside it.
 */
export async function createTestSpace(
	cleanup: Cleanup,
	label: string,
): Promise<{ identifier: string; name: string }> {
	const name = `n8n-live ${label} ${runId}`;
	const created = await runOne('space', 'create', { name });
	const identifier = String(created.identifier);
	cleanup.add(`space ${identifier}`, async () => {
		await rawRequest({
			method: 'DELETE',
			path: `/mp/api/v1/spaces/${encodeURIComponent(identifier)}`,
		});
	});

	return { identifier, name };
}
