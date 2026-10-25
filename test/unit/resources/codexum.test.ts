import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { codexumPage, codexumSpace } from '../../../nodes/Dutify/resources/codexum';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

const find = (resource: ResourceDef, name: string): OperationDef => {
	const found = resource.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
};
const page = (name: string) => find(codexumPage, name);
const space = (name: string) => find(codexumSpace, name);
const buildPage = (name: string, params: Record<string, unknown>) =>
	page(name).build!(reader(params));
const buildSpace = (name: string, params: Record<string, unknown>) =>
	space(name).build!(reader(params));

const PAGES = '/api/wiki/v1/workspaces/ws-1/wiki/spaces/DOCS/pages';
const LITE = `${PAGES}/lite`;
const SPACES = '/api/wiki/v1/workspaces/ws-1/wiki/spaces';

describe('registration', () => {
	it('registers codexumPage and codexumSpace as workspace-scoped resources', () => {
		expect(resources).toContain(codexumPage);
		expect(resources).toContain(codexumSpace);
		expect(codexumPage.value).toBe('codexumPage');
		expect(codexumSpace.value).toBe('codexumSpace');
		expect(codexumPage.workspaceScoped).toBe(true);
		expect(codexumSpace.workspaceScoped).toBe(true);
	});

	it('page operations', () => {
		expect(codexumPage.operations.map((o) => o.operation)).toEqual([
			'search',
			'retrieve',
			'list',
			'get',
			'create',
			'update',
			'move',
			'delete',
			'getShare',
			'enableShare',
			'disableShare',
		]);
	});

	it('space operations', () => {
		expect(codexumSpace.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'getWithPages',
			'create',
			'update',
			'delete',
			'getPublicSettings',
			'checkPublicSlug',
			'setPublicSettings',
		]);
	});

	it('space and page fields are pickers, never typed IDs', () => {
		for (const op of codexumPage.operations) {
			const f = op.fields.find((x) => x.name === 'space');
			if (f) {
				expect(f.typeOptions?.loadOptionsMethod).toBe('getWikiSpaces');
			}
			const pg = op.fields.find((x) => x.name === 'page');
			if (pg) {
				expect(pg.typeOptions?.loadOptionsMethod).toBe('getWikiPages');
				expect(pg.typeOptions?.loadOptionsDependsOn).toEqual(['space']);
			}
		}
		for (const op of codexumSpace.operations.filter(
			(o) => o.operation !== 'list' && o.operation !== 'create',
		)) {
			expect(op.fields.find((x) => x.name === 'space')?.typeOptions?.loadOptionsMethod).toBe(
				'getWikiSpaces',
			);
		}
	});

	it('the optional parent pickers use the loader with a top-level choice', () => {
		for (const [op, field] of [
			['create', 'parent'],
			['list', 'parent'],
			['move', 'newParent'],
			['move', 'afterPage'],
		] as const) {
			const f = page(op).fields.find((x) => x.name === field);
			expect(f?.typeOptions?.loadOptionsMethod).toBe('getWikiParentPages');
			expect(f?.typeOptions?.loadOptionsDependsOn).toEqual(['space']);
		}
	});
});

describe('page search and retrieve', () => {
	it('search sends q, and the optional space, mode and limit', () => {
		expect(buildPage('search', { query: 'onboarding', options: {} })).toEqual({
			method: 'GET',
			path: '/api/wiki/v1/workspaces/ws-1/wiki/search/lite',
			qs: { q: 'onboarding' },
		});
		expect(
			buildPage('search', {
				query: 'onboarding',
				options: { spaceKey: 'DOCS', mode: 'keyword', limit: 5 },
			}).qs,
		).toEqual({ q: 'onboarding', spaceKey: 'DOCS', mode: 'keyword', limit: 5 });
	});

	it('retrieve posts query, spaceKey and limit', () => {
		expect(buildPage('retrieve', { query: 'how do I deploy', options: {} })).toEqual({
			method: 'POST',
			path: '/api/wiki/v1/workspaces/ws-1/wiki/search/retrieve/lite',
			body: { query: 'how do I deploy' },
		});
		expect(
			buildPage('retrieve', { query: 'q', options: { spaceKey: 'DOCS', limit: 3 } }).body,
		).toEqual({ query: 'q', spaceKey: 'DOCS', limit: 3 });
	});
});

describe('page list', () => {
	it('lists root pages at the server maximum of 500, not paginated', () => {
		const spec = buildPage('list', { space: 'DOCS', parent: '' });
		expect(spec).toEqual({ method: 'GET', path: LITE, qs: { limit: 500 } });
		expect(spec.paginate).toBeUndefined();
		expect(page('list').list).toBe(true);
	});

	it('lists the children of a parent slug', () => {
		expect(buildPage('list', { space: 'DOCS', parent: 'handbook' }).qs).toEqual({
			limit: 500,
			parent: 'handbook',
		});
	});
});

describe('page get', () => {
	it('sends format=markdown and encodes a slug containing a slash', async () => {
		const ctx = fakeContext([{ slug: 'a/b', markdown: '# Hi' }]);
		const out = await page('get').run!(ctx, reader({ space: 'DOCS', page: 'a/b' }));
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: `${LITE}/a%2Fb`, qs: { format: 'markdown' } },
		]);
		expect(out).toEqual([{ json: { slug: 'a/b', markdown: '# Hi' } }]);
	});

	it('a page with no body (markdown null) comes back with an empty string, no error', async () => {
		const ctx = fakeContext([{ slug: 'empty', markdown: null, content: null }]);
		const out = await page('get').run!(ctx, reader({ space: 'DOCS', page: 'empty' }));
		expect(out).toEqual([{ json: { slug: 'empty', markdown: '', content: null } }]);
	});

	it('a response without a markdown key gets an empty one', async () => {
		const ctx = fakeContext([{ slug: 'x' }]);
		const out = await page('get').run!(ctx, reader({ space: 'DOCS', page: 'x' }));
		expect(out).toEqual([{ json: { slug: 'x', markdown: '' } }]);
	});
});

describe('page create', () => {
	it('sends the Markdown body in the "markdown" field, with the parent slug and options', () => {
		expect(
			buildPage('create', {
				space: 'DOCS',
				title: 'Quick start',
				parent: 'handbook',
				markdown: '# Quick start\n\nWelcome.',
				additionalFields: { type: 'page', isPublic: false, icon: 'rocket', template: 'Runbook' },
			}),
		).toEqual({
			method: 'POST',
			path: LITE,
			body: {
				title: 'Quick start',
				parent: 'handbook',
				markdown: '# Quick start\n\nWelcome.',
				type: 'page',
				isPublic: false,
				icon: 'rocket',
				template: 'Runbook',
			},
		});
	});

	it('a page with no body and no parent sends only the title (never markdown: "")', () => {
		expect(
			buildPage('create', {
				space: 'DOCS',
				title: 'Blank',
				parent: '',
				markdown: '',
				additionalFields: {},
			}).body,
		).toEqual({ title: 'Blank' });
	});

	it('encodes the space key', () => {
		expect(
			buildPage('create', {
				space: 'A/B',
				title: 't',
				parent: '',
				markdown: '',
				additionalFields: {},
			}).path,
		).toBe('/api/wiki/v1/workspaces/ws-1/wiki/spaces/A%2FB/pages/lite');
	});
});

describe('page update', () => {
	it('sends the Markdown body in the "markdown" field and encodes the slug', () => {
		expect(
			buildPage('update', {
				space: 'DOCS',
				page: 'a/b',
				updateFields: {
					markdown: '# Quick start\n\nUpdated body.',
					title: 'Renamed',
					isEditPublic: false,
				},
			}),
		).toEqual({
			method: 'PUT',
			path: `${LITE}/a%2Fb`,
			body: { markdown: '# Quick start\n\nUpdated body.', title: 'Renamed', isEditPublic: false },
		});
	});

	it('passes the cover options through', () => {
		expect(
			buildPage('update', {
				space: 'DOCS',
				page: 'p',
				updateFields: {
					coverImageType: 'url',
					coverUrl: 'https://cdn.dutify.ai/covers/api-reference.png',
					coverPositionY: 50,
					coverHeight: 'medium',
					coverAsDefault: false,
				},
			}).body,
		).toEqual({
			coverImageType: 'url',
			coverUrl: 'https://cdn.dutify.ai/covers/api-reference.png',
			coverPositionY: 50,
			coverHeight: 'medium',
			coverAsDefault: false,
		});
	});

	it('refuses an update with nothing to change, before any request', () => {
		expect(() => buildPage('update', { space: 'DOCS', page: 'p', updateFields: {} })).toThrow(
			/at least one field/i,
		);
	});

	it('a blank Markdown body does not count as a change (the server ignores it)', () => {
		expect(() =>
			buildPage('update', { space: 'DOCS', page: 'p', updateFields: { markdown: '' } }),
		).toThrow(/at least one field/i);
	});
});

describe('page move', () => {
	it('moves under a parent slug, after a sibling, optionally into another space', () => {
		expect(
			buildPage('move', {
				space: 'DOCS',
				page: 'a/b',
				newParent: 'handbook',
				afterPage: 'intro',
				options: { targetSpaceKey: 'ENG' },
			}),
		).toEqual({
			method: 'POST',
			path: `${LITE}/a%2Fb/move`,
			body: { newParent: 'handbook', afterPage: 'intro', targetSpaceKey: 'ENG' },
		});
	});

	it('with no parent and no sibling it moves to the top level (empty body)', () => {
		expect(
			buildPage('move', { space: 'DOCS', page: 'p', newParent: '', afterPage: '', options: {} })
				.body,
		).toEqual({});
	});
});

describe('page delete and sharing', () => {
	it('delete archives by default', () => {
		expect(buildPage('delete', { space: 'DOCS', page: 'a/b', permanent: false })).toEqual({
			method: 'DELETE',
			path: `${PAGES}/a%2Fb`,
			qs: { permanent: false },
		});
	});

	it('delete can be permanent', () => {
		expect(buildPage('delete', { space: 'DOCS', page: 'p', permanent: true }).qs).toEqual({
			permanent: true,
		});
	});

	it('getShare, disableShare', () => {
		expect(buildPage('getShare', { space: 'DOCS', page: 'a/b' })).toEqual({
			method: 'GET',
			path: `${PAGES}/a%2Fb/share`,
		});
		expect(buildPage('disableShare', { space: 'DOCS', page: 'a/b' })).toEqual({
			method: 'DELETE',
			path: `${PAGES}/a%2Fb/share`,
		});
	});

	it('enableShare posts an empty body by default, or the custom token and showAuthor', () => {
		expect(buildPage('enableShare', { space: 'DOCS', page: 'p', options: {} })).toEqual({
			method: 'POST',
			path: `${PAGES}/p/share`,
			body: {},
		});
		expect(
			buildPage('enableShare', {
				space: 'DOCS',
				page: 'p',
				options: { token: 'my-custom-slug', showAuthor: false },
			}).body,
		).toEqual({ token: 'my-custom-slug', showAuthor: false });
	});
});

describe('space operations', () => {
	it('list, get, getWithPages', () => {
		expect(buildSpace('list', {})).toEqual({ method: 'GET', path: SPACES });
		expect(buildSpace('get', { space: 'DOCS' })).toEqual({
			method: 'GET',
			path: `${SPACES}/DOCS`,
		});
		expect(buildSpace('getWithPages', { space: 'DOCS' })).toEqual({
			method: 'GET',
			path: `${SPACES}/DOCS/full`,
		});
	});

	it('create sends key and name plus the options', () => {
		expect(
			buildSpace('create', {
				key: 'DOCS',
				name: 'Documentation',
				additionalFields: {
					description: 'Product docs',
					isPublic: true,
					isEditPublic: false,
					icon: 'book',
					projectId: 7,
				},
			}),
		).toEqual({
			method: 'POST',
			path: SPACES,
			body: {
				key: 'DOCS',
				name: 'Documentation',
				description: 'Product docs',
				isPublic: true,
				isEditPublic: false,
				icon: 'book',
				projectId: 7,
			},
		});
	});

	it('update sends only the set fields and refuses an empty update', () => {
		expect(
			buildSpace('update', { space: 'DOCS', updateFields: { name: 'Docs', iconColor: '#8280FF' } }),
		).toEqual({
			method: 'PUT',
			path: `${SPACES}/DOCS`,
			body: { name: 'Docs', iconColor: '#8280FF' },
		});
		expect(() => buildSpace('update', { space: 'DOCS', updateFields: {} })).toThrow(
			/at least one field/i,
		);
	});

	it('delete', () => {
		expect(buildSpace('delete', { space: 'DOCS' })).toEqual({
			method: 'DELETE',
			path: `${SPACES}/DOCS`,
		});
	});

	it('getPublicSettings and checkPublicSlug', () => {
		expect(buildSpace('getPublicSettings', { space: 'DOCS' })).toEqual({
			method: 'GET',
			path: `${SPACES}/DOCS/public-settings`,
		});
		expect(buildSpace('checkPublicSlug', { space: 'DOCS', slug: 'my-docs' })).toEqual({
			method: 'GET',
			path: `${SPACES}/DOCS/public-settings/check-slug`,
			qs: { slug: 'my-docs' },
		});
	});
});

describe('space setPublicSettings', () => {
	const current = {
		isEnabled: true,
		allowedEmojis: ['like'],
		showReactions: true,
		showPageViews: true,
		showLastUpdated: true,
		showAuthor: false,
		customSlug: 'my-docs',
		viewMode: 'space',
		heroTitle: null,
		heroSubtitle: null,
	};

	it('reads the current settings and writes them back with only the changes applied (the PUT replaces the booleans and the slug)', async () => {
		const ctx = fakeContext([current, { ...current, showAuthor: true }]);
		const out = await space('setPublicSettings').run!(
			ctx,
			reader({ space: 'DOCS', settings: { showAuthor: true, viewMode: 'helpcenter' } }),
		);
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: `${SPACES}/DOCS/public-settings` },
			{
				method: 'PUT',
				path: `${SPACES}/DOCS/public-settings`,
				body: { ...current, showAuthor: true, viewMode: 'helpcenter' },
			},
		]);
		expect(out).toEqual([{ json: { ...current, showAuthor: true } }]);
	});

	it('can enable the public wiki and set a list of emojis', async () => {
		const ctx = fakeContext([{ ...current, isEnabled: false }, current]);
		await space('setPublicSettings').run!(
			ctx,
			reader({ space: 'DOCS', settings: { isEnabled: true, allowedEmojis: 'a, b' } }),
		);
		expect(ctx.calls[1].body).toMatchObject({ isEnabled: true, allowedEmojis: ['a', 'b'] });
	});

	it('an empty custom slug clears the slug', async () => {
		const ctx = fakeContext([current, current]);
		await space('setPublicSettings').run!(
			ctx,
			reader({ space: 'DOCS', settings: { customSlug: '' } }),
		);
		expect(ctx.calls[1].body).toMatchObject({ customSlug: '' });
	});

	it('refuses to run with nothing set, before any request', async () => {
		const ctx = fakeContext([]);
		await expect(
			space('setPublicSettings').run!(ctx, reader({ space: 'DOCS', settings: {} })),
		).rejects.toThrow(/at least one field/i);
		expect(ctx.calls).toEqual([]);
	});
});
