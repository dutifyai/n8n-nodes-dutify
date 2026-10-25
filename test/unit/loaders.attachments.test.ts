import { describe, expect, it } from 'vitest';
import {
	loadOptions,
	wikiAttachmentOptions,
	wikiAttachmentsSpec,
	wikiPageIdOptions,
} from '../../nodes/Dutify/loaders';

describe('wiki attachment pickers', () => {
	it('the page id picker lists the same pages as the slug picker, valued by page id', () => {
		const rows = [
			{ id: 'p1', slug: 'handbook', title: 'Handbook', type: 'folder', parentId: null },
			{ id: 'p2', slug: 'onboarding', title: 'Onboarding', type: 'page', parentId: 'p1' },
			{ title: 'No id', slug: 'no-id' },
		];
		expect(wikiPageIdOptions(rows)).toEqual([
			{ name: 'Handbook (folder)', value: 'p1' },
			{ name: 'Handbook / Onboarding', value: 'p2' },
		]);
		expect(wikiPageIdOptions(null)).toEqual([]);
	});

	it('lists the attachments of a page, with the page id encoded', () => {
		expect(wikiAttachmentsSpec('3f2b')).toEqual({
			method: 'GET',
			path: '/api/wiki/v1/pages/3f2b/attachments',
		});
	});

	it('attachment options are {name: filename, value: id}; unconfirmed ones are marked', () => {
		expect(
			wikiAttachmentOptions([
				{ id: 'a1', filename: 'diagram.png', status: 'confirmed' },
				{ id: 'a2', filename: 'draft.pdf', status: 'pending' },
				{ filename: 'no id' },
			]),
		).toEqual([
			{ name: 'diagram.png', value: 'a1' },
			{ name: 'draft.pdf (pending)', value: 'a2' },
		]);
		expect(wikiAttachmentOptions(undefined)).toEqual([]);
	});

	it('registers the two loadOptions methods', () => {
		expect(loadOptions.getWikiPageIds).toBeTypeOf('function');
		expect(loadOptions.getWikiAttachments).toBeTypeOf('function');
	});
});
