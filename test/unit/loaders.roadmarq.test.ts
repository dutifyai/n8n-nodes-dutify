import { describe, expect, it, vi } from 'vitest';
import {
	boardIdsSpec,
	boardNamesSpec,
	bugShortIdOptions,
	bugsSpec,
	loadBoardNames,
	loadOptions,
	nameOptions,
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

describe('roadmarq name pickers', () => {
	const boards = [
		{ id: 'b-1', slug: 'feedback', name: 'Feedback' },
		{ id: 'b-2', slug: 'ideas', name: 'Ideas' },
	];

	it('lists the boards with their UUIDs from the non-lite endpoint', () => {
		expect(boardIdsSpec('ws_1')).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards',
			qs: { workspaceIdentifier: 'ws_1' },
		});
	});

	it('every name list is a board-scoped GET on the board UUID', () => {
		const paths = {
			statuses: '/api/roadmarq/v1/boards/b-1/statuses',
			categories: '/api/roadmarq/v1/boards/b-1/categories',
			milestones: '/api/roadmarq/v1/boards/b-1/milestones',
			severityLevels: '/api/roadmarq/v1/boards/b-1/severity-levels',
			productAreas: '/api/roadmarq/v1/boards/b-1/product-areas',
			bugStatuses: '/api/roadmarq/v1/boards/b-1/bug-status-levels',
		} as const;
		for (const [kind, path] of Object.entries(paths)) {
			expect(boardNamesSpec('b-1', kind as keyof typeof paths)).toEqual({ method: 'GET', path });
		}
		expect(boardNamesSpec('a/b', 'statuses').path).toBe('/api/roadmarq/v1/boards/a%2Fb/statuses');
	});

	it('options are {name, value: name}; rows without a name are dropped; null is empty', () => {
		expect(nameOptions([{ name: 'Open' }, { name: 'In Progress', id: 'x' }, { id: 'y' }])).toEqual([
			{ name: 'Open', value: 'Open' },
			{ name: 'In Progress', value: 'In Progress' },
		]);
		expect(nameOptions(null)).toEqual([]);
		expect(nameOptions(undefined)).toEqual([]);
	});

	it('resolves the slug to the UUID, lists the names, and maps them', async () => {
		const calls: string[] = [];
		const fetch = async (spec: { path: string }) => {
			calls.push(spec.path);

			return spec.path.endsWith('/boards') ? boards : [{ name: 'Open' }, { name: 'Done' }];
		};
		expect(await loadBoardNames(fetch, 'ws_1', 'ideas', 'statuses')).toEqual([
			{ name: 'Open', value: 'Open' },
			{ name: 'Done', value: 'Done' },
		]);
		expect(calls).toEqual(['/api/roadmarq/v1/boards', '/api/roadmarq/v1/boards/b-2/statuses']);
	});

	it('no board selected, or an unknown slug, is an empty list without a name request', async () => {
		const fetch = vi.fn(async () => boards);
		expect(await loadBoardNames(fetch, 'ws_1', '', 'statuses')).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(await loadBoardNames(fetch, 'ws_1', 'nope', 'statuses')).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('a 403 (key without the settings or boards scope) is an empty list, other errors propagate', async () => {
		const forbidden = Object.assign(new Error('forbidden'), { httpCode: '403' });
		const denyNames = async (spec: { path: string }) => {
			if (spec.path.endsWith('/boards')) {
				return boards;
			}
			throw forbidden;
		};
		expect(await loadBoardNames(denyNames, 'ws_1', 'feedback', 'milestones')).toEqual([]);
		const denyBoards = async () => {
			throw forbidden;
		};
		expect(await loadBoardNames(denyBoards, 'ws_1', 'feedback', 'milestones')).toEqual([]);
		const broken = async () => {
			throw Object.assign(new Error('boom'), { httpCode: '500' });
		};
		await expect(loadBoardNames(broken, 'ws_1', 'feedback', 'milestones')).rejects.toThrow('boom');
	});

	it('registers the six loaders', () => {
		for (const name of [
			'getRequestStatuses',
			'getRequestCategories',
			'getMilestones',
			'getSeverityLevels',
			'getProductAreas',
			'getBugStatuses',
		]) {
			expect(loadOptions[name]).toBeTypeOf('function');
		}
	});
});
