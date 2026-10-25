import { describe, expect, it } from 'vitest';
import {
	automationOptions,
	automationsSpec,
	notificationOptions,
	notificationsSpec,
	savedFilterOptions,
	savedFiltersSpec,
	timeEntriesSpec,
	timeEntryOptions,
} from '../../nodes/Dutify/loaders';

describe('automation picker', () => {
	it('lists the automations of the chosen scope, 100 at a time', () => {
		expect(automationsSpec('list', 'lst_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/automations/list/lst_1',
			qs: { size: 100 },
		});
		expect(automationsSpec('folder', 'fld_1').path).toBe('/mp/api/v1/automations/folder/fld_1');
		expect(automationsSpec('space', 'sp_1').path).toBe('/mp/api/v1/automations/space/sp_1');
	});

	it('options are {name, value: identifier}; a disabled one is marked', () => {
		expect(
			automationOptions([
				{ identifier: 'aut_1', name: 'Auto close', active: true },
				{ identifier: 'aut_2', name: 'Notify', active: false },
				{ name: 'no id' },
			]),
		).toEqual([
			{ name: 'Auto close', value: 'aut_1' },
			{ name: 'Notify (disabled)', value: 'aut_2' },
		]);
		expect(automationOptions(null)).toEqual([]);
	});
});

describe('saved filter picker', () => {
	it('lists the filters of a list', () => {
		expect(savedFiltersSpec('lst_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/lists/lst_1/filters',
		});
	});

	it('options are {name, value: id as text}', () => {
		expect(savedFilterOptions([{ id: 12, name: 'Open bugs' }, { name: 'no id' }])).toEqual([
			{ name: 'Open bugs', value: '12' },
		]);
		expect(savedFilterOptions(undefined)).toEqual([]);
	});
});

describe('notification picker', () => {
	it('lists the unread notifications of the workspace', () => {
		expect(notificationsSpec('ws_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/notifications/workspace/ws_1',
			qs: { unreadOnly: true, size: 100 },
		});
	});

	it('options are {name: type and date, value: identifier}', () => {
		expect(
			notificationOptions([
				{ identifier: 'ntf_1', type: 'COMMENT_MENTION', createdAt: '2026-10-20T09:00:00Z' },
				{ identifier: 'ntf_2' },
				{ type: 'x' },
			]),
		).toEqual([
			{ name: 'COMMENT_MENTION (2026-10-20T09:00:00Z)', value: 'ntf_1' },
			{ name: 'ntf_2', value: 'ntf_2' },
		]);
	});
});

describe('time entry picker', () => {
	it('lists the entries of a task, 100 at a time', () => {
		expect(timeEntriesSpec('tsk_1')).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tasks/tsk_1/time-entries',
			qs: { size: 100 },
		});
	});

	it('options show minutes, start day and notes; the value is the entry id as text', () => {
		expect(
			timeEntryOptions([
				{ id: 7, timeSpent: 90, startedAt: '2026-10-20T09:00:00Z', notes: 'Login form' },
				{ id: 8, timeSpent: 15 },
				{ timeSpent: 5 },
			]),
		).toEqual([
			{ name: '90 min on 2026-10-20 - Login form', value: '7' },
			{ name: '15 min', value: '8' },
		]);
	});
});
