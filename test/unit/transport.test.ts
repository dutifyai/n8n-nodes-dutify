import type { INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { buildHttpOptions, dutifyRequest, encodePath, toNodeError } from '../../shared/transport';

const node: INode = {
	id: 'n1',
	name: 'Dutify',
	type: 'n8n-nodes-dutify.dutify',
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

	it('shows a plain-text error body as the message (Hub answers "No such webhook", not JSON)', () => {
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
