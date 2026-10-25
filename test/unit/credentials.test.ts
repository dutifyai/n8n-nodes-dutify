import { Expression } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { DutifyApi } from '../../credentials/DutifyApi.credentials';

describe('DutifyApi credential', () => {
	const cred = new DutifyApi();
	const prop = (name: string) => cred.properties.find((p) => p.name === name);

	it('is named dutifyApi', () => {
		expect(cred.name).toBe('dutifyApi');
	});

	it('masks the apiKey', () => {
		expect(prop('apiKey')?.typeOptions?.password).toBe(true);
	});

	it('defaults baseUrl to https://dutify.ai', () => {
		expect(prop('baseUrl')?.default).toBe('https://dutify.ai');
	});

	it('authenticates with the X-API-Key header', () => {
		const auth = cred.authenticate as { properties: { headers: Record<string, string> } };
		expect(auth.properties.headers['X-API-Key']).toBe('={{$credentials.apiKey}}');
	});

	/** Evaluates the test request's baseURL expression with n8n's own expression engine. */
	const testBaseUrl = (baseUrl: unknown): unknown => {
		const req = (cred.test as { request: { baseURL: string } }).request;

		expect(req.baseURL.startsWith('={{')).toBe(true);

		// Without its leading "=", which only marks a parameter value as an expression.
		return Expression.resolveWithoutWorkflow(req.baseURL.slice(1), { $credentials: { baseUrl } });
	};

	it('tests against the current api-key endpoint on a slash-trimmed baseUrl', () => {
		const req = (cred.test as { request: { url: string; baseURL: string } }).request;
		expect(req.url).toBe('/mp/api/v1/api-keys/current');
		expect(testBaseUrl('https://tenant.example.com/')).toBe('https://tenant.example.com');
		expect(testBaseUrl('https://tenant.example.com//')).toBe('https://tenant.example.com');
		expect(testBaseUrl('https://tenant.example.com')).toBe('https://tenant.example.com');
	});

	it('a blank Base URL tests against https://dutify.ai, as every request falls back to it', () => {
		expect(testBaseUrl('')).toBe('https://dutify.ai');
		expect(testBaseUrl(undefined)).toBe('https://dutify.ai');
	});
});
