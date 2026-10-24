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

	it('tests against the current api-key endpoint on a slash-trimmed baseUrl', () => {
		const req = (cred.test as { request: { url: string; baseURL: string } }).request;
		expect(req.url).toBe('/mp/api/v1/api-keys/current');
		expect(req.baseURL).toBe('={{$credentials.baseUrl.replace(/\\/$/, "")}}');
	});
});
