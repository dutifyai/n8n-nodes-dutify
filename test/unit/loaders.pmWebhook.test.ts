import { describe, expect, it } from 'vitest';
import {
	loadOptions,
	pmEventTypeOptions,
	pmWebhookDeliveriesSpec,
	pmWebhookDeliveryOptions,
	pmWebhookOptions,
	pmWebhooksSpec,
} from '../../nodes/Dutify/loaders';
import { PM_EVENT_OPTIONS } from '../../shared/pmEvents';

describe('PM event type picker', () => {
	it('serves the shared static list, there being no catalog endpoint for it', () => {
		expect(pmEventTypeOptions()).toEqual(PM_EVENT_OPTIONS);
		expect(typeof loadOptions.getPmEventTypes).toBe('function');
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
