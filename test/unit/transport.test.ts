import type { INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import {
	buildHttpOptions,
	dutifyErrorOf,
	dutifyRequest,
	encodePath,
	toNodeError,
} from '../../shared/transport';

const node: INode = {
	id: 'n1',
	name: 'Dutify',
	type: '@dutifyai/n8n-nodes-dutify.dutify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

describe('encodePath', () => {
	it('percent-encodes every interpolated segment, including & and /', () => {
		expect(encodePath`/a/${'q&a/notes'}/b`).toBe('/a/q%26a%2Fnotes/b');
	});

	it('encodes numbers and leaves the literal parts alone', () => {
		expect(encodePath`/mp/api/v1/tasks/${42}/comments`).toBe('/mp/api/v1/tasks/42/comments');
	});
});

describe('buildHttpOptions', () => {
	const spec = {
		method: 'GET' as const,
		path: '/mp/api/v1/tasks/lite/search',
		qs: { q: 'x', status: undefined, tag: '' },
	};

	it('joins base URL and path without a double slash, drops empty qs values, sends the workspace', () => {
		const opts = buildHttpOptions('https://dutify.ai/', spec, 'ws-1');
		expect(opts.url).toBe('https://dutify.ai/mp/api/v1/tasks/lite/search');
		expect(opts.method).toBe('GET');
		expect(opts.qs).toEqual({ q: 'x' });
		expect(opts.headers).toMatchObject({ 'X-Dutify-Workspace': 'ws-1' });
		expect(opts.json).toBe(true);
	});

	it('repeats array query keys (status=a&status=b) and leaves arrayFormat unset otherwise', () => {
		const withArray = buildHttpOptions(
			'https://dutify.ai',
			{ method: 'GET', path: '/x', qs: { status: ['a', 'b'] } },
			'ws-1',
		);
		expect(withArray.qs).toEqual({ status: ['a', 'b'] });
		expect(withArray.arrayFormat).toBe('repeat');
		expect(buildHttpOptions('https://dutify.ai', spec, 'ws-1').arrayFormat).toBeUndefined();
	});

	it('sends no X-Dutify-Workspace header when no workspace is selected', () => {
		const opts = buildHttpOptions('https://dutify.ai', spec, '');
		expect(opts.headers ?? {}).not.toHaveProperty('X-Dutify-Workspace');
	});

	it('passes the body through', () => {
		const opts = buildHttpOptions(
			'https://dutify.ai',
			{ method: 'POST', path: '/mp/api/v1/tasks', body: { title: 'T' } },
			'ws-1',
		);
		expect(opts.body).toEqual({ title: 'T' });
	});
});

describe('buildHttpOptions raw text body', () => {
	it('sends a string body verbatim with its content type (Hub reads a bare @RequestBody String)', () => {
		const opts = buildHttpOptions(
			'https://dutify.ai',
			{ method: 'PUT', path: '/p', body: 'Summarise in bullets', contentType: 'text/plain' },
			'ws-1',
		);
		expect(opts.body).toBe('Summarise in bullets');
		expect(opts.headers).toMatchObject({ 'Content-Type': 'text/plain' });
	});

	it('keeps an empty string body (it clears the setting) rather than dropping it', () => {
		const opts = buildHttpOptions(
			'https://dutify.ai',
			{ method: 'PUT', path: '/p', body: '', contentType: 'text/plain' },
			'',
		);
		expect(opts.body).toBe('');
		expect(opts.headers).toMatchObject({ 'Content-Type': 'text/plain' });
	});

	it('sets no Content-Type of its own for an object body', () => {
		const opts = buildHttpOptions(
			'https://dutify.ai',
			{ method: 'POST', path: '/p', body: {} },
			'',
		);
		expect(opts.headers ?? {}).not.toHaveProperty('Content-Type');
	});
});

describe('buildHttpOptions timeout', () => {
	it('passes spec.timeout through, and sets none otherwise', () => {
		const base = { method: 'POST' as const, path: '/api/lens/chat' };
		expect(buildHttpOptions('https://dutify.ai', { ...base, timeout: 120000 }, '').timeout).toBe(120000);
		expect(buildHttpOptions('https://dutify.ai', base, '')).not.toHaveProperty('timeout');
	});
});

describe('toNodeError', () => {
	it('shows the Dutify message as message, and code + field + validOptions in the description', () => {
		const err = toNodeError(node, {
			httpCode: '400',
			response: {
				body: {
					code: 'INVALID_STATUS',
					message: 'Unknown status',
					field: 'status',
					validOptions: ['To Do', 'Done'],
				},
			},
		});
		expect(err).toBeInstanceOf(NodeApiError);
		expect(err.message).toContain('Unknown status');
		expect(err.description).toContain('INVALID_STATUS');
		expect(err.description).toContain('To Do, Done');
		expect(err.description).toContain('status');
		expect(err.httpCode).toBe('400');
	});

	it('reads errorCode and details.field / details.validOptions (the shape production answers)', () => {
		// Verbatim from POST /mp/api/v1/tasks/lite with a misspelled status, 2026-10-25.
		const err = toNodeError(node, {
			httpCode: '400',
			response: {
				body: {
					message:
						"Unknown status 'Not A Real Status zz'. Valid options: Open, In Progress, Completed, Closed",
					errorCode: 'VALIDATION_ERROR',
					details: {
						field: 'status',
						providedName: 'Not A Real Status zz',
						validOptions: ['Open', 'In Progress', 'Completed', 'Closed'],
					},
				},
			},
		});
		expect(err.message).toContain("Unknown status 'Not A Real Status zz'");
		expect(err.description).toBe(
			'Code: VALIDATION_ERROR. Field: status. Valid options: Open, In Progress, Completed, Closed',
		);
	});

	it('shows a numeric code and field in the description', () => {
		const err = toNodeError(node, {
			httpCode: '422',
			response: { body: { code: 4001, message: 'Bad value', field: 7 } },
		});
		expect(err.description).toContain('Code: 4001');
		expect(err.description).toContain('Field: 7');
	});

	it('keeps a 403 message instead of the generic "Forbidden" text', () => {
		const err = toNodeError(node, {
			httpCode: '403',
			response: { body: { message: 'Missing scope recordings:read' } },
		});
		expect(err.message).toContain('recordings:read');
	});

	it('finds the body on an axios-shaped error (response.status + response.data)', () => {
		const axiosLike = Object.assign(new Error('Request failed with status code 404'), {
			response: { status: 404, data: { code: 'NOT_FOUND', message: 'Task DUT-9 not found' } },
		});
		const err = toNodeError(node, axiosLike);
		expect(err.message).toContain('Task DUT-9 not found');
		expect(err.description).toContain('NOT_FOUND');
		expect(err.httpCode).toBe('404');
	});

	it('still shows a plain-text error body as the message (older Hub and Roadmarq versions)', () => {
		const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
			response: {
				status: 400,
				data: 'URL must start with https:// (the payload contains meeting content)',
			},
		});
		const err = toNodeError(node, axiosLike);
		expect(err.message).toBe('URL must start with https:// (the payload contains meeting content)');
		expect(err.httpCode).toBe('400');
		const wrapped = toNodeError(node, new NodeApiError(node, axiosLike as never));
		expect(wrapped.message).toBe(
			'URL must start with https:// (the payload contains meeting content)',
		);
		expect(wrapped.httpCode).toBe('400');
	});

	it('does not show an HTML error page as the message', () => {
		const axiosLike = Object.assign(new Error('Request failed with status code 502'), {
			response: { status: 502, data: '<!DOCTYPE html><html><body>Bad gateway</body></html>' },
		});
		const err = toNodeError(node, axiosLike);
		expect(err.message).not.toContain('<');
		expect(err.httpCode).toBe('502');
	});

	it('finds the body inside an error n8n already wrapped in a NodeApiError', () => {
		const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
			response: {
				status: 400,
				data: { code: 'INVALID_STATUS', message: 'Unknown status', validOptions: ['Open'] },
			},
		});
		const wrapped = new NodeApiError(node, axiosLike as never);
		const err = toNodeError(node, wrapped);
		expect(err.message).toContain('Unknown status');
		expect(err.description).toContain('Open');
	});
});

describe('buildHttpOptions full response', () => {
	it('asks for the full response (headers) only when the spec says so', () => {
		const base = { method: 'GET' as const, path: '/api/wiki/v1/x' };
		expect(
			buildHttpOptions('https://dutify.ai', { ...base, fullResponse: true }, '').returnFullResponse,
		).toBe(true);
		expect(buildHttpOptions('https://dutify.ai', base, '')).not.toHaveProperty('returnFullResponse');
	});
});

/*
 * The JSON error shape Hub (PR #393) and Roadmarq (PR #33) answer: {message, errorCode}, plus
 * `code` (the same value) and `details` on some answers. Taken from the PRs' contract tests.
 */
describe('toNodeError with the Hub and Roadmarq JSON errors', () => {
	const axiosError = (status: number, data: unknown) =>
		Object.assign(new Error(`Request failed with status code ${status}`), {
			response: { status, data },
		});

	it('shows a Hub {message, errorCode} body: the message, and the code in the description', () => {
		const err = toNodeError(
			node,
			axiosError(404, { message: 'No such webhook', errorCode: 'NOT_FOUND' }),
		);
		expect(err.message).toBe('No such webhook');
		expect(err.description).toBe('Code: NOT_FOUND');
		expect(err.httpCode).toBe('404');
		expect(dutifyErrorOf(err)).toEqual({
			httpCode: '404',
			message: 'No such webhook',
			code: 'NOT_FOUND',
		});
	});

	it('shows the AI Coworker 402 with its errorCode', () => {
		const err = toNodeError(
			node,
			axiosError(402, {
				message:
					'This workspace has used up its AI Coworker usage. A workspace owner can add more at https://dutify.ai/workspace-settings',
				errorCode: 'AI_COWORKER_USAGE_EXHAUSTED',
			}),
		);
		expect(err.message).toMatch(/^This workspace has used up its AI Coworker usage\./);
		expect(err.description).toBe('Code: AI_COWORKER_USAGE_EXHAUSTED');
		expect(dutifyErrorOf(err).code).toBe('AI_COWORKER_USAGE_EXHAUSTED');
	});

	it('reads errorCode before code, and the message of an RFC 7807 problem', () => {
		// Hub's problem answers keep title/status/detail, add message and a string errorCode, and
		// move the old integer errorCode to internalErrorCode.
		const err = toNodeError(
			node,
			axiosError(404, {
				title: 'Not Found',
				status: 404,
				detail: 'HTTP 404 Not Found',
				message: 'HTTP 404 Not Found',
				errorCode: 'NOT_FOUND',
				internalErrorCode: 4004,
			}),
		);
		expect(err.message).toBe('HTTP 404 Not Found');
		expect(err.description).toBe('Code: NOT_FOUND');
		const both = dutifyErrorOf(
			axiosError(409, { code: 'LEGACY', errorCode: 'WORKFLOW_IN_PROGRESS', message: 'Busy' }),
		);
		expect(both.code).toBe('WORKFLOW_IN_PROGRESS');
	});

	it('still reads the older shapes: code only, error only, and an integer errorCode', () => {
		expect(
			dutifyErrorOf(axiosError(403, { code: 'WORKSPACE_OUT_OF_SCOPE', error: 'Not yours' })),
		).toEqual({ httpCode: '403', message: 'Not yours', code: 'WORKSPACE_OUT_OF_SCOPE' });
		const problem = toNodeError(
			node,
			axiosError(404, { title: 'Not Found', status: 404, detail: 'Gone', errorCode: 4004 }),
		);
		expect(problem.message).toBe('Gone');
		expect(problem.description).toBe('Code: 4004');
	});

	it('shows a Roadmarq 402 PLAN_LIMIT_REACHED and a 400 with details.field', () => {
		const limit = toNodeError(
			node,
			axiosError(402, {
				message: 'FREE plan limit reached: feedback boards (1/1)',
				errorCode: 'PLAN_LIMIT_REACHED',
				code: 'PLAN_LIMIT_REACHED',
			}),
		);
		expect(limit.message).toBe('FREE plan limit reached: feedback boards (1/1)');
		expect(limit.description).toBe('Code: PLAN_LIMIT_REACHED');
		const bad = toNodeError(
			node,
			axiosError(400, {
				message: 'Wrong type',
				errorCode: 'BAD_REQUEST',
				code: 'BAD_REQUEST',
				details: { field: 'settings.bugReportsEnabled' },
			}),
		);
		expect(bad.description).toBe('Code: BAD_REQUEST. Field: settings.bugReportsEnabled');
	});
});

describe('dutifyRequest', () => {
	it('authenticates with dutifyApi against the credential base URL', async () => {
		const httpRequestWithAuthentication = vi.fn().mockResolvedValue({ ok: true });
		const ctx = {
			getNode: () => node,
			getCredentials: vi
				.fn()
				.mockResolvedValue({ apiKey: 'k', baseUrl: 'https://tenant.dutify.ai/' }),
			helpers: { httpRequestWithAuthentication },
		};
		const result = await dutifyRequest.call(
			ctx as never,
			{ method: 'GET', path: '/mp/api/v1/api-keys/current' },
			'ws-1',
		);
		expect(result).toEqual({ ok: true });
		expect(ctx.getCredentials).toHaveBeenCalledWith('dutifyApi');
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		const [credName, opts] = httpRequestWithAuthentication.mock.calls[0];
		expect(credName).toBe('dutifyApi');
		expect(opts.url).toBe('https://tenant.dutify.ai/mp/api/v1/api-keys/current');
		expect(opts.headers['X-Dutify-Workspace']).toBe('ws-1');
	});

	it('rethrows failures as NodeApiError carrying the Dutify message', async () => {
		const ctx = {
			getNode: () => node,
			getCredentials: vi.fn().mockResolvedValue({ apiKey: 'k', baseUrl: 'https://dutify.ai' }),
			helpers: {
				httpRequestWithAuthentication: vi.fn().mockRejectedValue({
					httpCode: '403',
					response: { body: { message: 'Missing scope recordings:read' } },
				}),
			},
		};
		const promise = dutifyRequest.call(ctx as never, { method: 'GET', path: '/api/x' }, '');
		await expect(promise).rejects.toBeInstanceOf(NodeApiError);
		await expect(promise).rejects.toThrow(/recordings:read/);
	});
});
