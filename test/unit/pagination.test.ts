import type { IDataObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { collectAll, requestAllPages } from '../../shared/pagination';
import type { PaginationStyle } from '../../shared/types';
import { fakeContext } from './helpers';

const cursor: PaginationStyle = {
	kind: 'cursor',
	cursorParam: 'cursor',
	limitParam: 'limit',
	itemsPath: 'items',
	nextCursorPath: 'nextCursor',
	maxPageSize: 100,
};

const page: PaginationStyle = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	itemsPath: 'content',
	zeroBased: true,
	maxPageSize: 2,
};

/** Serves `pages` in order and fails the test if more pages are fetched than exist. */
function pager(pages: unknown[]) {
	const calls: IDataObject[] = [];
	const fetchPage = async (qs: IDataObject) => {
		calls.push(qs);
		if (calls.length > pages.length) {
			throw new Error(`fetched page ${calls.length}, only ${pages.length} defined`);
		}

		return pages[calls.length - 1];
	};

	return { calls, fetchPage };
}

describe('collectAll, cursor style', () => {
	it('follows nextCursor to the end', async () => {
		const { calls, fetchPage } = pager([
			{ items: [1, 2], nextCursor: 'c2' },
			{ items: [3], nextCursor: null },
		]);
		expect(await collectAll(fetchPage, cursor)).toEqual([1, 2, 3]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).not.toHaveProperty('cursor');
		expect(calls[0].limit).toBe(100);
		expect(calls[1].cursor).toBe('c2');
	});

	it('stops after one call once limit is reached', async () => {
		const { calls, fetchPage } = pager([
			{ items: [1, 2], nextCursor: 'c2' },
			{ items: [3], nextCursor: null },
		]);
		expect(await collectAll(fetchPage, cursor, 2)).toEqual([1, 2]);
		expect(calls).toHaveLength(1);
		expect(calls[0].limit).toBe(2);
	});

	it('truncates a page larger than the limit', async () => {
		const { fetchPage } = pager([{ items: [1, 2, 3], nextCursor: 'c2' }]);
		expect(await collectAll(fetchPage, cursor, 2)).toEqual([1, 2]);
	});

	it('returns [] after one call on an empty page', async () => {
		const { calls, fetchPage } = pager([{ items: [], nextCursor: 'c2' }]);
		expect(await collectAll(fetchPage, cursor)).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it('stops on a repeated cursor instead of looping', async () => {
		const { calls, fetchPage } = pager([
			{ items: [1], nextCursor: 'c1' },
			{ items: [2], nextCursor: 'c1' },
			{ items: [3], nextCursor: 'c1' },
		]);
		expect(await collectAll(fetchPage, cursor)).toEqual([1, 2]);
		expect(calls).toHaveLength(2);
	});

	it('reads dotted items/nextCursor paths', async () => {
		const nested: PaginationStyle = {
			...cursor,
			itemsPath: 'data.items',
			nextCursorPath: 'data.page.next',
		};
		const { fetchPage } = pager([
			{ data: { items: [{ id: 'a' }], page: { next: 'n' } } },
			{ data: { items: [{ id: 'b' }], page: { next: '' } } },
		]);
		expect(await collectAll(fetchPage, nested)).toEqual([{ id: 'a' }, { id: 'b' }]);
	});
});

describe('collectAll, page style', () => {
	it('starts at page 0 and stops on the first short page', async () => {
		const { calls, fetchPage } = pager([{ content: [1, 2] }, { content: [3] }]);
		expect(await collectAll(fetchPage, page)).toEqual([1, 2, 3]);
		expect(calls).toEqual([
			{ page: 0, size: 2 },
			{ page: 1, size: 2 },
		]);
	});

	it('starts at page 1 when not zero-based', async () => {
		const { calls, fetchPage } = pager([{ content: [1] }]);
		await collectAll(fetchPage, { ...page, zeroBased: false });
		expect(calls[0].page).toBe(1);
	});

	it('returns [] after one call on an empty page', async () => {
		const { calls, fetchPage } = pager([{ content: [] }]);
		expect(await collectAll(fetchPage, page)).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it('uses the response itself as the items when itemsPath is absent', async () => {
		const bare: PaginationStyle = {
			kind: 'page',
			pageParam: 'p',
			sizeParam: 's',
			zeroBased: true,
			maxPageSize: 2,
		};
		const { fetchPage } = pager([[1, 2], []]);
		expect(await collectAll(fetchPage, bare)).toEqual([1, 2]);
	});

	it('stops when the server ignores the page param and repeats the same page', async () => {
		const { calls, fetchPage } = pager([
			{ content: [1, 2] },
			{ content: [1, 2] },
			{ content: [1, 2] },
		]);
		expect(await collectAll(fetchPage, page)).toEqual([1, 2]);
		expect(calls).toHaveLength(2);
	});

	it('honours limit across pages', async () => {
		const { calls, fetchPage } = pager([{ content: [1, 2] }, { content: [3, 4] }]);
		expect(await collectAll(fetchPage, page, 3)).toEqual([1, 2, 3]);
		expect(calls).toHaveLength(2);
	});
});

describe('requestAllPages', () => {
	it('merges paging params into the spec qs', async () => {
		const ctx = fakeContext([{ items: [1], nextCursor: null }]);
		await ctx.requestAll({ method: 'GET', path: '/x', qs: { q: 'a' }, paginate: cursor });
		expect(ctx.calls[0].qs).toEqual({ q: 'a', limit: 100 });
	});

	it('sends a single request for a spec without paginate and applies the limit', async () => {
		const ctx = fakeContext([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
		expect(await requestAllPages((s) => ctx.request(s), { method: 'GET', path: '/x' }, 2)).toEqual([
			{ id: 1 },
			{ id: 2 },
		]);
		expect(ctx.calls).toHaveLength(1);
	});
});
