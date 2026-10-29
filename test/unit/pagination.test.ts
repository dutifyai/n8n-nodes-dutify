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

/*
 * Codexum's page list (PR #44): a bare array body, `X-Total-Count`, and `X-Next-Offset` while
 * more pages remain; the header is absent on the last request.
 */
describe('requestAllPages, offset style with a next-offset header', () => {
	const offset: PaginationStyle = {
		kind: 'offset',
		offsetParam: 'offset',
		limitParam: 'limit',
		nextOffsetHeader: 'X-Next-Offset',
		maxPageSize: 500,
	};
	const spec = {
		method: 'GET' as const,
		path: '/pages/lite',
		qs: { parent: 'p' },
		paginate: offset,
	};
	const rows = (from: number, count: number) =>
		Array.from({ length: count }, (_, i) => ({ slug: `p-${from + i}` }));
	/** n8n lower-cases response header names. */
	const answer = (items: unknown[], next?: number) => ({
		body: items,
		headers: next === undefined ? { 'x-total-count': '1100' } : { 'x-next-offset': String(next) },
		statusCode: 200,
	});

	it('follows X-Next-Offset until it is gone, asking for the full response', async () => {
		const ctx = fakeContext([
			answer(rows(0, 500), 500),
			answer(rows(500, 500), 1000),
			answer(rows(1000, 100)),
		]);
		const all = await ctx.requestAll(spec);
		expect(all).toHaveLength(1100);
		expect(all[1099]).toEqual({ slug: 'p-1099' });
		expect(ctx.calls.map((c) => c.qs)).toEqual([
			{ parent: 'p', limit: 500 },
			{ parent: 'p', limit: 500, offset: 500 },
			{ parent: 'p', limit: 500, offset: 1000 },
		]);
		expect(ctx.calls.every((c) => c.fullResponse === true)).toBe(true);
	});

	it('respects Limit: asks for no more than is left and stops there', async () => {
		const ctx = fakeContext([answer(rows(0, 30), 30)]);
		expect(await ctx.requestAll(spec, 30)).toHaveLength(30);
		expect(ctx.calls.map((c) => c.qs)).toEqual([{ parent: 'p', limit: 30 }]);

		const twoPages = fakeContext([answer(rows(0, 500), 500), answer(rows(500, 200), 700)]);
		expect(await twoPages.requestAll(spec, 700)).toHaveLength(700);
		expect(twoPages.calls.map((c) => c.qs)).toEqual([
			{ parent: 'p', limit: 500 },
			{ parent: 'p', limit: 200, offset: 500 },
		]);
	});

	it('stops after one request when the header is absent (a Codexum without paging)', async () => {
		const ctx = fakeContext([{ body: rows(0, 500), headers: {}, statusCode: 200 }]);
		expect(await ctx.requestAll(spec)).toHaveLength(500);
		expect(ctx.calls).toHaveLength(1);
	});

	it('reads the header in any case, and stops on a header that does not move forward', async () => {
		const ctx = fakeContext([
			{ body: rows(0, 2), headers: { 'X-Next-Offset': '2' } },
			{ body: rows(2, 2), headers: { 'X-Next-Offset': '2' } },
		]);
		expect(await ctx.requestAll(spec)).toHaveLength(4);
		expect(ctx.calls).toHaveLength(2);
	});

	it('stops on an empty page even when a header is sent', async () => {
		const ctx = fakeContext([answer([], 500)]);
		expect(await ctx.requestAll(spec)).toEqual([]);
		expect(ctx.calls).toHaveLength(1);
	});
});

/*
 * Roadmarq's bug list (PR #33): with page/size it answers the {content, pageNumber, totalPages}
 * envelope; without paging support it answers the plain array of every bug.
 */
describe('collectAll, page style with an envelope and a plain-array fallback', () => {
	const enveloped: PaginationStyle = {
		kind: 'page',
		pageParam: 'page',
		sizeParam: 'size',
		itemsPath: 'content',
		totalPagesPath: 'totalPages',
		zeroBased: true,
		maxPageSize: 2,
	};

	it('stops at the last page by totalPages, without an extra empty request', async () => {
		const { calls, fetchPage } = pager([
			{ content: [1, 2], pageNumber: 0, totalPages: 2 },
			{ content: [3, 4], pageNumber: 1, totalPages: 2 },
		]);
		expect(await collectAll(fetchPage, enveloped)).toEqual([1, 2, 3, 4]);
		expect(calls).toEqual([
			{ page: 0, size: 2 },
			{ page: 1, size: 2 },
		]);
	});

	it('takes a plain array answer as the items (a backend that ignores page and size)', async () => {
		const { calls, fetchPage } = pager([
			[1, 2, 3],
			[1, 2, 3],
		]);
		expect(await collectAll(fetchPage, enveloped)).toEqual([1, 2, 3]);
		expect(calls).toHaveLength(2);
	});
});
