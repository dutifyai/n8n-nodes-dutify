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
