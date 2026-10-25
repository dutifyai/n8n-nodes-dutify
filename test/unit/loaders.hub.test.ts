import { describe, expect, it } from 'vitest';
import {
	hubCallOptions,
	hubCallsSpec,
	hubRecordingOptions,
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
});
