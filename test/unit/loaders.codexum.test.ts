import { describe, expect, it } from 'vitest';
import { wikiPageOptions, wikiPagesSpec, wikiParentPageOptions } from '../../nodes/Dutify/loaders';

describe('wiki page picker', () => {
	it('lists every page of the space, with the space key encoded in the path', () => {
		expect(wikiPagesSpec('ws_abc', 'DOCS')).toEqual({
			method: 'GET',
			path: '/api/wiki/v1/workspaces/ws_abc/wiki/spaces/DOCS/pages',
		});
		expect(wikiPagesSpec('ws_abc', 'A/B').path).toBe(
			'/api/wiki/v1/workspaces/ws_abc/wiki/spaces/A%2FB/pages',
		);
	});

	it('options are {name: title path, value: slug}; folders are marked, rows without a slug are dropped', () => {
		const rows = [
			{ id: 'p1', slug: 'handbook', title: 'Handbook', type: 'folder', parentId: null },
			{ id: 'p2', slug: 'onboarding', title: 'Onboarding', type: 'page', parentId: 'p1' },
			{ id: 'p3', slug: 'a/b', title: 'Slash', type: 'page', parentId: null },
			{ id: 'p4', title: 'No slug' },
		];
		expect(wikiPageOptions(rows)).toEqual([
			{ name: 'Handbook (folder)', value: 'handbook' },
			{ name: 'Handbook / Onboarding', value: 'onboarding' },
			{ name: 'Slash', value: 'a/b' },
		]);
		expect(wikiPageOptions(null)).toEqual([]);
	});

	it('a page whose parent is not in the list is labelled by its own title', () => {
		expect(
			wikiPageOptions([{ id: 'p2', slug: 'orphan', title: 'Orphan', parentId: 'gone' }]),
		).toEqual([{ name: 'Orphan', value: 'orphan' }]);
	});

	it('the parent picker starts with a "top level" choice whose value is empty', () => {
		expect(wikiParentPageOptions([{ id: 'p1', slug: 'home', title: 'Home' }])).toEqual([
			{ name: '- Top Level -', value: '' },
			{ name: 'Home', value: 'home' },
		]);
	});
});
