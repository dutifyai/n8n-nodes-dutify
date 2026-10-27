import type { IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import {
	loadOptions,
	pmEventTypeOptions,
	pmWebhookDeliveriesSpec,
	pmWebhookDeliveryOptions,
	pmWebhookOptions,
	pmWebhooksSpec,
	webhookEventTypeOptions,
	webhookEventTypesSpec,
} from '../../nodes/Dutify/loaders';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';
/** PM's live GET /webhooks/event-types answer (2026-10-27, PM master a488825c). */
import eventTypesFixture from './fixtures/event-types.json';

describe('PM event type picker', () => {
	it('serves the shared static list, there being no catalog endpoint for it', () => {
		expect(pmEventTypeOptions()).toEqual(PM_EVENT_OPTIONS);
		expect(typeof loadOptions.getPmEventTypes).toBe('function');
	});
});

describe('webhook event types from /event-types', () => {
	const rows = [
		{ type: 'task-created', product: 'pm', description: 'A task was created.', scopes: ['SPACE'] },
		{
			type: 'wiki.page.published',
			product: 'codexum',
			description: 'A wiki page was published.',
			scopes: ['WIKI_SPACE', 'WIKI_PAGE'],
		},
		{
			type: 'wiki.comment.added',
			product: 'codexum',
			description: 'A comment was added to a wiki page.',
			scopes: ['WIKI_SPACE', 'WIKI_PAGE'],
		},
		{
			type: 'feedback.request.created',
			product: 'roadmarq',
			description: 'A feature request was created.',
			scopes: ['FEEDBACK_BOARD'],
		},
		{ product: 'codexum', description: 'no type' },
	];

	it('asks GET /mp/api/v1/workspaces/{ws}/webhooks/event-types', () => {
		expect(webhookEventTypesSpec('ws 1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws%201/webhooks/event-types',
		});
	});

	it('eventTypeOptionsFilteredByProduct: options of one product, valued with the API name, sorted', () => {
		expect(webhookEventTypeOptions(rows, 'codexum')).toEqual([
			{
				name: 'wiki.comment.added',
				value: 'wiki.comment.added',
				description: 'A comment was added to a wiki page.',
			},
			{
				name: 'wiki.page.published',
				value: 'wiki.page.published',
				description: 'A wiki page was published.',
			},
		]);
		expect(webhookEventTypeOptions(rows, 'roadmarq').map((o) => o.value)).toEqual([
			'feedback.request.created',
		]);
		expect(webhookEventTypeOptions(rows, 'nope')).toEqual([]);
		expect(webhookEventTypeOptions(null, 'codexum')).toEqual([]);
	});

	const ctxWith = (params: Record<string, unknown>, answer: () => Promise<unknown>) => {
		const requests: IHttpRequestOptions[] = [];
		const ctx = {
			getNodeParameter: (name: string, fallback?: unknown) =>
				Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
			getCurrentNodeParameter: (name: string) => params[name],
			getCredentials: async () => ({ apiKey: 'dk_live_x', baseUrl: 'https://dutify.test' }),
			getNode: () => ({
				name: 'Dutify Trigger',
				type: '@dutifyai/n8n-nodes-dutify.dutifyTrigger',
				typeVersion: 1,
			}),
			helpers: {
				httpRequestWithAuthentication: async (_cred: string, options: IHttpRequestOptions) => {
					requests.push(options);

					return await answer();
				},
			},
		} as unknown as ILoadOptionsFunctions;

		return { ctx, requests };
	};

	it('getWebhookEventTypes serves the events of the trigger source chosen', async () => {
		const wiki = ctxWith({ source: 'codexum', workspace: 'ws-1' }, async () => rows);
		expect((await loadOptions.getWebhookEventTypes.call(wiki.ctx)).map((o) => o.value)).toEqual([
			'wiki.comment.added',
			'wiki.page.published',
		]);
		expect(wiki.requests[0].url).toBe(
			'https://dutify.test/mp/api/v1/workspaces/ws-1/webhooks/event-types',
		);

		const fr = ctxWith({ source: 'roadmarq', workspace: 'ws-1' }, async () => rows);
		expect((await loadOptions.getWebhookEventTypes.call(fr.ctx)).map((o) => o.value)).toEqual([
			'feedback.request.created',
		]);
	});

	it('getWebhookEventTypes offers only the events the chosen scope can narrow (the scope field of the source)', async () => {
		const wikiRows = [
			...rows,
			{ type: 'wiki.space.updated', product: 'codexum', scopes: ['WIKI_SPACE'] },
		];
		const page = ctxWith(
			{ source: 'codexum', workspace: 'ws-1', wikiScopeType: 'WIKI_PAGE' },
			async () => wikiRows,
		);
		expect((await loadOptions.getWebhookEventTypes.call(page.ctx)).map((o) => o.value)).toEqual([
			'wiki.comment.added',
			'wiki.page.published',
		]);
		const space = ctxWith(
			{ source: 'codexum', workspace: 'ws-1', wikiScopeType: 'WIKI_SPACE' },
			async () => wikiRows,
		);
		expect((await loadOptions.getWebhookEventTypes.call(space.ctx)).map((o) => o.value)).toEqual([
			'wiki.comment.added',
			'wiki.page.published',
			'wiki.space.updated',
		]);
		const request = ctxWith(
			{ source: 'roadmarq', workspace: 'ws-1', feedbackScopeType: 'FEEDBACK_REQUEST' },
			async () => rows,
		);
		expect(await loadOptions.getWebhookEventTypes.call(request.ctx)).toEqual([]);
	});

	it('eventTypeOptionsFilteredByScope: no scope or the whole workspace keeps every event; a row without scopes is kept', () => {
		const all = webhookEventTypeOptions(rows, 'codexum').map((o) => o.value);
		expect(webhookEventTypeOptions(rows, 'codexum', 'WORKSPACE').map((o) => o.value)).toEqual(all);
		expect(webhookEventTypeOptions(rows, 'codexum', '').map((o) => o.value)).toEqual(all);
		expect(
			webhookEventTypeOptions(
				[{ type: 'wiki.page.created', product: 'codexum' }],
				'codexum',
				'WIKI_PAGE',
			).map((o) => o.value),
		).toEqual(['wiki.page.created']);
	});

	/*
	 * PM's own rules (dutify-pm ProductEventScopes): page, comment, reaction and attachment events
	 * take a space or a page; space, settings and public-wiki events take a space only. Board,
	 * changelog, taxonomy and settings events take a board only; request and vote events a board
	 * or a request; bug events a board or a bug; comment events any of the three.
	 */
	it('scopeFilterMatchesPmRules over the /event-types answer of PM (fixture)', () => {
		const types = (product: string, scope: string) =>
			webhookEventTypeOptions(eventTypesFixture, product, scope).map((o) => String(o.value));
		const pageLevel = /^wiki\.(page|comment|reaction|attachment)\./;
		const wiki = types('codexum', 'WORKSPACE');
		expect(wiki.length).toBeGreaterThan(10);
		expect(types('codexum', 'WIKI_PAGE')).toEqual(wiki.filter((t) => pageLevel.test(t)));
		expect(types('codexum', 'WIKI_SPACE')).toEqual(wiki);
		expect(types('codexum', 'WIKI_PAGE')).not.toContain('wiki.space.updated');

		const feedback = types('roadmarq', 'WORKSPACE');
		expect(types('roadmarq', 'FEEDBACK_BOARD')).toEqual(feedback);
		expect(types('roadmarq', 'FEEDBACK_REQUEST')).toEqual(
			feedback.filter((t) => /^feedback\.(request|vote|comment)\./.test(t)),
		);
		expect(types('roadmarq', 'FEEDBACK_BUG')).toEqual(
			feedback.filter((t) => /^feedback\.(bug|comment)\./.test(t)),
		);
	});

	it('the wiki and Roadmarq event fields reload when their scope changes', async () => {
		const { DutifyTrigger } = await import('../../nodes/DutifyTrigger/DutifyTrigger.node');
		const props = new DutifyTrigger().description.properties;
		for (const [events, scope] of [
			['wikiEvents', 'wikiScopeType'],
			['feedbackEvents', 'feedbackScopeType'],
		]) {
			const field = props.find((p) => p.name === events);
			expect(field?.typeOptions?.loadOptionsDependsOn).toEqual(
				expect.arrayContaining(['source', 'workspace.value', scope]),
			);
		}
	});

	it('getWebhookEventTypes answers [] without a workspace (no call) or on a 403', async () => {
		const none = ctxWith({ source: 'codexum', workspace: '' }, async () => {
			throw new Error('must not be called');
		});
		expect(await loadOptions.getWebhookEventTypes.call(none.ctx)).toEqual([]);
		expect(none.requests).toEqual([]);
		const forbidden = Object.assign(new Error('Forbidden'), { httpCode: '403' });
		const denied = ctxWith({ source: 'codexum', workspace: 'ws-1' }, async () => {
			throw forbidden;
		});
		expect(await loadOptions.getWebhookEventTypes.call(denied.ctx)).toEqual([]);
	});
});

describe('PM webhook picker', () => {
	it('lists the webhooks of the workspace', () => {
		expect(pmWebhooksSpec('ws_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws_1/webhooks',
		});
	});

	it('options are {name, value: identifier}; the URL disambiguates, a paused one is marked', () => {
		expect(
			pmWebhookOptions([
				{ identifier: 'whk_1', name: 'CI', url: 'https://a.test/hook', active: true },
				{ identifier: 'whk_2', url: 'https://b.test/hook', active: false },
				{ name: 'no id' },
			]),
		).toEqual([
			{ name: 'CI (https://a.test/hook)', value: 'whk_1' },
			{ name: 'https://b.test/hook (paused)', value: 'whk_2' },
		]);
		expect(pmWebhookOptions(null)).toEqual([]);
	});
});

describe('PM webhook delivery picker', () => {
	it('lists the latest deliveries of one webhook, 100 at most', () => {
		expect(pmWebhookDeliveriesSpec('ws_1', 'whk_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws_1/webhooks/whk_1/deliveries',
			qs: { size: 100 },
		});
	});

	it('options show the event, the outcome and the time', () => {
		expect(
			pmWebhookDeliveryOptions([
				{
					identifier: 'whd_1',
					eventType: 'task-created',
					status: 'FAILED',
					createdAt: '2026-10-25T10:00:00Z',
				},
				{ identifier: 'whd_2' },
				{ eventType: 'no id' },
			]),
		).toEqual([
			{ name: 'task-created - FAILED - 2026-10-25T10:00:00Z', value: 'whd_1' },
			{ name: 'whd_2', value: 'whd_2' },
		]);
		expect(pmWebhookDeliveryOptions(undefined)).toEqual([]);
	});
});
