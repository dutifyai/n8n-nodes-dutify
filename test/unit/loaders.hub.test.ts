import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import {
	hubCallOptions,
	hubCallsSpec,
	hubRecordingOptions,
	hubWebhookOptions,
	hubWebhooksSpec,
	loadOptions,
} from '../../nodes/Dutify/loaders';

describe('Hub call and recording pickers', () => {
	it('lists the most recent calls as light rows, page 0', () => {
		expect(hubCallsSpec()).toEqual({
			method: 'GET',
			path: '/api/usercall/search',
			qs: { query: '', view: 'lite', page: 0, size: 100 },
		});
	});

	const rows = [
		{
			id: 12,
			call: {
				name: 'Weekly sync',
				startTime: '2026-10-20T10:00:00Z',
				recordings: [{ id: 101, nameShortTranscription: 'Roadmap' }],
			},
		},
		{
			id: 11,
			call: {
				startTime: '2026-10-19T09:30:00Z',
				recordings: [
					{ id: 99, nameShortTranscription: 'Standup' },
					{ id: 98, nameShortTranscription: 'Standup part 2' },
				],
			},
		},
		{ id: 10, call: { recordings: [] } },
		{ call: { name: 'no id' } },
	];

	it('call options are valued by the integer call ID, dated, and fall back to the recording title', () => {
		expect(hubCallOptions(rows)).toEqual([
			{ name: 'Weekly sync (2026-10-20)', value: '12' },
			{ name: 'Standup (2026-10-19)', value: '11' },
			{ name: 'Call 10', value: '10' },
		]);
		expect(hubCallOptions(null)).toEqual([]);
	});

	it('recording options are valued by the integer recording ID, one per recording', () => {
		expect(hubRecordingOptions(rows)).toEqual([
			{ name: 'Weekly sync - Roadmap (2026-10-20)', value: '101' },
			{ name: 'Standup (2026-10-19)', value: '99' },
			{ name: 'Standup part 2 (2026-10-19)', value: '98' },
		]);
		expect(hubRecordingOptions(undefined)).toEqual([]);
	});

	it('are wired as loadOptions methods', () => {
		expect(typeof loadOptions.getHubCalls).toBe('function');
		expect(typeof loadOptions.getHubRecordings).toBe('function');
	});

	it('return no options, without calling Hub, until a workspace is chosen', async () => {
		const requests: unknown[] = [];
		const ctx = {
			getNodeParameter: (name: string, fallback?: unknown) =>
				name === 'workspace' ? '' : fallback,
			getCredentials: async () => ({ apiKey: 'dk_live_x', baseUrl: 'https://dutify.test' }),
			getNode: () => ({ name: 'Dutify', type: '@dutifyai/n8n-nodes-dutify.dutify', typeVersion: 1 }),
			helpers: {
				httpRequestWithAuthentication: async (_cred: string, options: unknown) => {
					requests.push(options);

					return [];
				},
			},
		} as unknown as ILoadOptionsFunctions;
		expect(await loadOptions.getHubCalls.call(ctx)).toEqual([]);
		expect(await loadOptions.getHubRecordings.call(ctx)).toEqual([]);
		expect(requests).toEqual([]);
	});
});

describe('Hub meeting webhook picker', () => {
	it('lists the webhooks the key may see (Hub filters them to the workspace header)', () => {
		expect(hubWebhooksSpec()).toEqual({ method: 'GET', path: '/api/user/webhooks' });
	});

	it('options are valued by the integer webhook ID; the URL disambiguates, a paused one is marked', () => {
		expect(
			hubWebhookOptions([
				{ id: 7, name: 'CRM', url: 'https://a.test/hook', enabled: true },
				{ id: 8, url: 'https://b.test/hook', enabled: false },
				{ id: 9, name: '', url: 'https://c.test/hook' },
				{ name: 'no id', url: 'https://d.test' },
			]),
		).toEqual([
			{ name: 'CRM (https://a.test/hook)', value: '7' },
			{ name: 'https://b.test/hook (paused)', value: '8' },
			{ name: 'https://c.test/hook', value: '9' },
		]);
		expect(hubWebhookOptions(null)).toEqual([]);
	});

	it('is wired as a loadOptions method that answers [] without a workspace or on a 403', async () => {
		expect(typeof loadOptions.getMeetingWebhooks).toBe('function');
		const ctxWith = (workspace: string, answer: () => Promise<unknown>) =>
			({
				getNodeParameter: (name: string, fallback?: unknown) =>
					name === 'workspace' ? workspace : fallback,
				getCredentials: async () => ({ apiKey: 'dk_live_x', baseUrl: 'https://dutify.test' }),
				getNode: () => ({ name: 'Dutify', type: '@dutifyai/n8n-nodes-dutify.dutify', typeVersion: 1 }),
				helpers: { httpRequestWithAuthentication: answer },
			}) as unknown as ILoadOptionsFunctions;
		expect(
			await loadOptions.getMeetingWebhooks.call(
				ctxWith('', async () => {
					throw new Error('must not be called');
				}),
			),
		).toEqual([]);
		const forbidden = Object.assign(new Error('Forbidden'), { httpCode: '403' });
		expect(
			await loadOptions.getMeetingWebhooks.call(
				ctxWith('ws-1', async () => {
					throw forbidden;
				}),
			),
		).toEqual([]);
		expect(
			await loadOptions.getMeetingWebhooks.call(
				ctxWith('ws-1', async () => [{ id: 3, url: 'https://x.test' }]),
			),
		).toEqual([{ name: 'https://x.test', value: '3' }]);
	});
});
