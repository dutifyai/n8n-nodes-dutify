import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import type { RequestSpec } from './types';

const DEFAULT_BASE_URL = 'https://dutify.ai';

/**
 * Tagged template for request paths: every interpolated value is percent-encoded with
 * encodeURIComponent, so a slug like `q&a/notes` stays one path segment.
 */
export function encodePath(
	strings: TemplateStringsArray,
	...values: Array<string | number>
): string {
	return strings.reduce(
		(path, literal, i) =>
			path + literal + (i < values.length ? encodeURIComponent(String(values[i])) : ''),
		'',
	);
}

function compactQs(qs: IDataObject | undefined): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(qs ?? {})) {
		if (value !== undefined && value !== null && value !== '') {
			out[key] = value;
		}
	}

	return out;
}

export function buildHttpOptions(
	baseUrl: string,
	spec: RequestSpec,
	workspace: string,
): IHttpRequestOptions {
	const headers: IDataObject = { Accept: 'application/json' };
	if (workspace) {
		headers['X-Dutify-Workspace'] = workspace;
	}
	const options: IHttpRequestOptions = {
		method: spec.method,
		url: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + spec.path,
		headers,
		json: true,
	};
	const qs = compactQs(spec.qs);
	if (Object.keys(qs).length > 0) {
		options.qs = qs;
		// Quarkus binds List<String> query params from repeated keys (a=1&a=2), not a[0]=1.
		if (Object.values(qs).some((v) => Array.isArray(v))) {
			options.arrayFormat = 'repeat';
		}
	}
	if (spec.body !== undefined) {
		options.body = spec.body;
	}
	if (spec.timeout !== undefined) {
		options.timeout = spec.timeout;
	}

	return options;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);

			return asObject(parsed);
		} catch {
			return undefined;
		}
	}

	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Longest plain-text error body shown as the message; anything longer is not a message. */
const MAX_TEXT_MESSAGE = 500;

/**
 * A plain-text error body (Hub answers `No such webhook`, not JSON) as `{ message }`. HTML pages
 * (a proxy's 502) and long dumps are left out.
 */
function plainText(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const message = value.trim();
	if (message === '' || message.length > MAX_TEXT_MESSAGE || message.startsWith('<')) {
		return undefined;
	}

	return { message };
}

/**
 * Digs the Dutify error body and HTTP status out of whatever the HTTP helper threw:
 * a plain `{ httpCode, response: { body } }`, an axios error (`response.status/data`),
 * a request-library error (`statusCode`, `error`), or any of these already wrapped by
 * n8n in a NodeApiError (`cause` / `errorResponse` / `context.data`).
 */
function inspect(error: unknown, depth = 0): { body?: Record<string, unknown>; httpCode?: string } {
	const err = asObject(error);
	if (!err || depth > 4) {
		return {};
	}
	const response = asObject(err.response);
	const context = asObject(err.context);

	const body =
		asObject(response?.body) ??
		asObject(response?.data) ??
		asObject(err.error) ??
		asObject(context?.data) ??
		plainText(response?.body ?? response?.data);
	const status = err.httpCode ?? response?.status ?? response?.statusCode ?? err.statusCode;
	const httpCode = status !== undefined && status !== null ? String(status) : undefined;

	const nested = [err.cause, err.errorResponse]
		.filter((n) => n !== undefined && n !== error)
		.map((n) => inspect(n, depth + 1));

	return {
		body: body ?? nested.find((n) => n.body)?.body,
		httpCode: httpCode ?? nested.find((n) => n.httpCode)?.httpCode,
	};
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Wraps any request failure as a NodeApiError that shows Dutify's own `message`, with
 * `code`, `field` and `validOptions` in the description so the user can fix the input.
 */
export function toNodeError(node: INode, error: unknown): NodeApiError {
	const { body, httpCode } = inspect(error);
	if (!body) {
		if (error instanceof NodeApiError) {
			return error;
		}

		return new NodeApiError(node, (asObject(error) ?? { message: String(error) }) as JsonObject, {
			httpCode,
		});
	}

	const message = text(body.message) ?? text(body.error) ?? text(body.detail) ?? text(body.title);
	// PM answers `{message, errorCode, details: {field, validOptions}}`; other services put
	// `code`, `field` and `validOptions` at the top level.
	const details = asObject(body.details) ?? {};
	const code = body.code ?? body.errorCode;
	const field = body.field ?? details.field;
	const validOptions = body.validOptions ?? details.validOptions;
	const parts: string[] = [];
	if (code !== undefined && code !== null && code !== '') {
		parts.push(`Code: ${String(code)}`);
	}
	if (field !== undefined && field !== null && field !== '') {
		parts.push(`Field: ${String(field)}`);
	}
	if (Array.isArray(validOptions) && validOptions.length > 0) {
		parts.push(`Valid options: ${validOptions.map(String).join(', ')}`);
	}

	return new NodeApiError(node, body as JsonObject, {
		httpCode,
		message,
		description: parts.length > 0 ? parts.join('. ') : undefined,
	});
}

export async function dutifyRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions,
	spec: RequestSpec,
	workspace: string,
): Promise<unknown> {
	const credentials = await this.getCredentials('dutifyApi');
	const options = buildHttpOptions(credentials.baseUrl as string, spec, workspace);
	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'dutifyApi', options);
	} catch (error) {
		throw toNodeError(this.getNode(), error);
	}
}
