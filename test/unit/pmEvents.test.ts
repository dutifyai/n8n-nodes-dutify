import { describe, expect, it } from 'vitest';
import { PM_EVENT_OPTIONS, PM_EVENT_TYPES, pmEventLabel } from '../../shared/pmEvents';

describe('PM_EVENT_TYPES', () => {
	it('holds dash-cased names without duplicates', () => {
		expect(PM_EVENT_TYPES.length).toBeGreaterThan(40);
		expect(new Set(PM_EVENT_TYPES).size).toBe(PM_EVENT_TYPES.length);
		for (const type of PM_EVENT_TYPES) {
			expect(type).toMatch(/^[a-z]+(-[a-z]+)+$/);
		}
	});

	it('includes the events the docs promise', () => {
		expect(PM_EVENT_TYPES).toEqual(
			expect.arrayContaining([
				'task-created',
				'task-deleted',
				'task-status-changed',
				'comment-added',
				'custom-field-value-updated',
			]),
		);
	});

	it('leaves out events a subscription is accepted for but never delivered', () => {
		// Internal broker signals and the wiki/feedback modules fail the delivery access filter.
		for (const type of [
			'websocket-notification',
			'email-notification',
			'storage-files-cleanup',
			'wiki.page.created',
			'feedback.request.created',
		]) {
			expect(PM_EVENT_TYPES).not.toContain(type);
		}
	});
});

describe('PM_EVENT_OPTIONS', () => {
	it('has one readable option per event type, in the same order', () => {
		expect(PM_EVENT_OPTIONS.map((o) => o.value)).toEqual(PM_EVENT_TYPES);
		expect(PM_EVENT_OPTIONS[0]).toEqual({
			name: pmEventLabel(PM_EVENT_TYPES[0]),
			value: PM_EVENT_TYPES[0],
		});
	});

	it('labels an event in title case', () => {
		expect(pmEventLabel('task-created')).toBe('Task Created');
		expect(pmEventLabel('task-moved-to-parent-task')).toBe('Task Moved to Parent Task');
		expect(pmEventLabel('custom-field-value-updated')).toBe('Custom Field Value Updated');
	});
});
