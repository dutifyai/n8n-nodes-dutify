import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import {
	DEFAULT_MEETING_SECTIONS,
	MEETING_SECTION_OPTIONS,
	meetingWebhook,
} from '../../../nodes/Dutify/resources/meetingWebhook';
import type { OperationDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

/*
 * Contract: https://dutify.ai/api/v1/api-catalog/User%20Webhooks (7 operations, UserWebhookDTO)
 * and Hub origin/master UserWebhookService / WebhookSection (the catalog has no examples).
 */

const HOOKS = '/api/user/webhooks';

function opOf(name: string): OperationDef {
	const found = meetingWebhook.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation meetingWebhook.${name}`);
	}

	return found;
}

const field = (operation: string, name: string): INodeProperties | undefined =>
	opOf(operation).fields.find((f) => f.name === name);

const optionOf = (operation: string, collection: string, name: string) =>
	(field(operation, collection)?.options as INodeProperties[] | undefined)?.find(
		(o) => o.name === name,
	);

describe('registration', () => {
	it('is registered, workspace scoped (a key only sees the webhooks bound to its workspace)', () => {
		expect(resources).toContain(meetingWebhook);
		expect(meetingWebhook.value).toBe('meetingWebhook');
		expect(meetingWebhook.name).toBe('Meeting Webhook');
		expect(meetingWebhook.workspaceScoped).toBe(true);
	});

	it('exposes every catalog operation', () => {
		expect(meetingWebhook.operations.map((o) => o.operation)).toEqual([
			'create',
			'list',
			'get',
			'update',
			'delete',
			'test',
			'listDeliveries',
		]);
	});
});

describe('sections', () => {
	it('offers every WebhookSection key', () => {
		expect(MEETING_SECTION_OPTIONS.map((o) => o.value)).toEqual([
			'summary',
			'keyPoints',
			'actionItems',
			'enhancedNotes',
			'transcript',
			'notes',
			'insights',
			'themes',
			'scores',
			'speakers',
			'tags',
			'tasks',
		]);
	});

	it('defaults to the four sections Hub uses when none are given', () => {
		expect(DEFAULT_MEETING_SECTIONS).toEqual(['summary', 'keyPoints', 'actionItems', 'tasks']);
		const sections = field('create', 'sections');
		expect(sections?.type).toBe('multiOptions');
		expect(sections?.default).toEqual(DEFAULT_MEETING_SECTIONS);
	});
});

describe('webhook picker', () => {
	it('every operation on one webhook picks it from getMeetingWebhooks (no ID pasting)', () => {
		for (const operation of ['get', 'update', 'delete', 'test', 'listDeliveries']) {
			const picker = field(operation, 'webhook');
			expect(picker?.type).toBe('options');
			expect(picker?.required).toBe(true);
			expect(picker?.typeOptions?.loadOptionsMethod).toBe('getMeetingWebhooks');
		}
	});
});

describe('create', () => {
	it('POSTs url, secret and sections', () => {
		expect(
			opOf('create').build!(
				reader({
					url: 'https://hooks.example.com/meeting',
					secret: 's3cret',
					sections: ['summary', 'transcript'],
					additionalFields: {},
				}),
			),
		).toEqual({
			method: 'POST',
			path: HOOKS,
			body: {
				url: 'https://hooks.example.com/meeting',
				secret: 's3cret',
				sections: ['summary', 'transcript'],
			},
		});
	});

	it('sends the name and the paused state when set; leaves out an empty secret', () => {
		const spec = opOf('create').build!(
			reader({
				url: 'https://hooks.example.com/meeting',
				secret: '',
				sections: ['summary'],
				additionalFields: { name: 'CRM', active: false },
			}),
		);
		expect(spec.body).toEqual({
			url: 'https://hooks.example.com/meeting',
			sections: ['summary'],
			name: 'CRM',
			// UserWebhookDTO's on/off flag
			enabled: false,
		});
	});

	it('an empty section list is sent as [] (metadata only), not dropped to the defaults', () => {
		const spec = opOf('create').build!(
			reader({ url: 'https://h.example.com', secret: 'x', sections: [], additionalFields: {} }),
		);
		expect((spec.body as Record<string, unknown>).sections).toEqual([]);
	});

	it('the secret is a password field and the URL is required', () => {
		expect(field('create', 'secret')?.typeOptions?.password).toBe(true);
		expect(field('create', 'url')?.required).toBe(true);
	});
});

describe('list, get, delete, test', () => {
	it('list: GET /api/user/webhooks', () => {
		expect(opOf('list').build!(reader({}))).toEqual({ method: 'GET', path: HOOKS });
	});

	it('get: GET /api/user/webhooks/{id}', () => {
		expect(opOf('get').build!(reader({ webhook: '42' }))).toEqual({
			method: 'GET',
			path: `${HOOKS}/42`,
		});
	});

	it('delete: DELETE /api/user/webhooks/{id}', () => {
		expect(opOf('delete').build!(reader({ webhook: '42' }))).toEqual({
			method: 'DELETE',
			path: `${HOOKS}/42`,
		});
	});

	it('test: POST /api/user/webhooks/{id}/test', () => {
		expect(opOf('test').build!(reader({ webhook: '42' }))).toEqual({
			method: 'POST',
			path: `${HOOKS}/42/test`,
		});
	});

	it('encodes the id', () => {
		expect(opOf('get').build!(reader({ webhook: '4/2' })).path).toBe(`${HOOKS}/4%2F2`);
	});
});

describe('listDeliveries', () => {
	it('GET /api/user/webhooks/{id}/deliveries with limit (Hub keeps at most 25)', () => {
		expect(opOf('listDeliveries').build!(reader({ webhook: '42', deliveries: 10 }))).toEqual({
			method: 'GET',
			path: `${HOOKS}/42/deliveries`,
			qs: { limit: 10 },
		});
		const limit = field('listDeliveries', 'deliveries');
		expect(limit?.default).toBe(25);
		expect(limit?.typeOptions).toMatchObject({ minValue: 1, maxValue: 25 });
	});
});

describe('update', () => {
	const current = {
		id: 42,
		name: 'CRM',
		url: 'https://old.example.com/hook',
		hasSecret: true,
		sections: ['summary'],
	};

	it('PUTs only the changed fields, plus the current URL (Hub requires the URL on every update)', async () => {
		const ctx = fakeContext([current, { ...current, name: 'Sales' }]);
		const out = await opOf('update').run!(
			ctx,
			reader({ webhook: '42', updateFields: { name: 'Sales' } }),
		);
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: `${HOOKS}/42` },
			{
				method: 'PUT',
				path: `${HOOKS}/42`,
				body: { url: 'https://old.example.com/hook', name: 'Sales' },
			},
		]);
		expect(out).toEqual([{ json: { ...current, name: 'Sales' } }]);
	});

	it('a new URL replaces the current one without reading it first', async () => {
		const ctx = fakeContext([{ ...current, url: 'https://new.example.com/hook' }]);
		await opOf('update').run!(
			ctx,
			reader({
				webhook: '42',
				updateFields: {
					url: 'https://new.example.com/hook',
					secret: 'n3w',
					sections: ['summary', 'tasks'],
					active: false,
				},
			}),
		);
		expect(ctx.calls).toEqual([
			{
				method: 'PUT',
				path: `${HOOKS}/42`,
				body: {
					url: 'https://new.example.com/hook',
					secret: 'n3w',
					sections: ['summary', 'tasks'],
					enabled: false,
				},
			},
		]);
	});

	it('empty sections keep the current sections (they are not cleared)', async () => {
		const ctx = fakeContext([current, current]);
		await opOf('update').run!(
			ctx,
			reader({ webhook: '42', updateFields: { name: 'X', sections: [] } }),
		);
		expect(ctx.calls[1].body).toEqual({ url: current.url, name: 'X' });
	});

	it('refuses an update with no field set, before any request', async () => {
		const ctx = fakeContext([]);
		await expect(
			opOf('update').run!(ctx, reader({ webhook: '42', updateFields: {} })),
		).rejects.toThrow();
		expect(ctx.calls).toEqual([]);
	});

	it('offers Active (the on/off flag) and a password Secret in Update Fields', () => {
		expect(optionOf('update', 'updateFields', 'active')?.type).toBe('boolean');
		expect(optionOf('update', 'updateFields', 'secret')?.typeOptions?.password).toBe(true);
	});
});
