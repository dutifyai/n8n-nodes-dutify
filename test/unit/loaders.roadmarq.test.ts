import { describe, expect, it } from 'vitest';
import {
	bugShortIdOptions,
	bugsSpec,
	loadOptions,
	requestShortIdOptions,
	requestsSpec,
} from '../../nodes/Dutify/loaders';

describe('roadmarq short-id pickers', () => {
	it('lists one page of requests of the board at the backend maximum page size', () => {
		expect(requestsSpec('ws_1', 'feedback')).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/feedback/requests/lite',
			qs: { workspaceIdentifier: 'ws_1', page: 0, size: 200 },
		});
		expect(requestsSpec('ws_1', 'a/b').path).toBe('/api/roadmarq/v1/boards/a%2Fb/requests/lite');
	});

	it('lists the bugs of the board', () => {
		expect(bugsSpec('ws_1', 'feedback')).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/feedback/bugs/lite',
			qs: { workspaceIdentifier: 'ws_1' },
		});
	});

	it('request options are "FR-1 - title" valued by short id, read from the content array', () => {
		expect(
			requestShortIdOptions({
				content: [{ shortId: 'FR-1', title: 'Dark mode' }, { shortId: 'FR-2' }, { title: 'x' }],
			}),
		).toEqual([
			{ name: 'FR-1 - Dark mode', value: 'FR-1' },
			{ name: 'FR-2', value: 'FR-2' },
		]);
		expect(requestShortIdOptions(null)).toEqual([]);
	});

	it('bug options are read from a plain array', () => {
		expect(bugShortIdOptions([{ shortId: 'BG-9', title: 'Crash' }])).toEqual([
			{ name: 'BG-9 - Crash', value: 'BG-9' },
		]);
		expect(bugShortIdOptions(undefined)).toEqual([]);
	});

	it('registers the loaders', () => {
		expect(loadOptions.getRequestShortIds).toBeTypeOf('function');
		expect(loadOptions.getBugShortIds).toBeTypeOf('function');
	});
});
