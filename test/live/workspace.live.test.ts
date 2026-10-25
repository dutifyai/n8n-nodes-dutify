import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	live,
	run,
	runOne,
	searchList,
} from './harness';

liveDescribe('account — live', () => {
	it('whoAmI describes the personal test key', async () => {
		const key = await runOne('account', 'whoAmI');
		expect(key.keyType).toBe('PERSONAL');
		expect(Array.isArray(key.scopes)).toBe(true);
	});

	it('listWorkspaces returns the test workspace as {identifier, name}', async () => {
		const rows = await run('account', 'listWorkspaces');
		expect(rows).toContainEqual({ identifier: live.workspace, name: expect.any(String) });
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(['identifier', 'name']);
		}
	});

	it('findMyWorkspace answers PERSONAL with the workspace list', async () => {
		const found = await runOne('account', 'findMyWorkspace');
		expect(found.keyType).toBe('PERSONAL');
		expect(found.workspaces).toContainEqual(expect.objectContaining({ identifier: live.workspace }));
	});

	it('the workspace locator lists the test workspace and filters by name', async () => {
		const all = await searchList('searchWorkspaces');
		expect(all.results).toContainEqual({ name: expect.any(String), value: live.workspace });
		const name = all.results.find((r) => r.value === live.workspace)?.name ?? '';
		const filtered = await searchList('searchWorkspaces', name.slice(0, 5).toUpperCase());
		expect(filtered.results.map((r) => r.value)).toContain(live.workspace);
		const none = await searchList('searchWorkspaces', 'no-such-workspace-zzz');
		expect(none.results).toEqual([]);
	});
});

liveDescribe('workspace — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'workspace');
	});
	afterAll(async () => await cleanup.run());

	it('getContext lists the new space', async () => {
		const context = await runOne('workspace', 'getContext');
		const spaces = context.spaces as Array<{ name: string }>;
		expect(spaces.map((s) => s.name)).toContain(space.name);
	});

	it('getContext narrowed to one space returns only that space', async () => {
		const context = await runOne('workspace', 'getContext', {
			additionalFields: { space: space.name, shallow: true },
		});
		const spaces = context.spaces as Array<{ name: string }>;
		expect(spaces.map((s) => s.name)).toEqual([space.name]);
	});

	it('getDashboard works for the workspace and for a space', async () => {
		const ws = await runOne('workspace', 'getDashboard', { scope: 'workspace' });
		expect(ws).toEqual(expect.any(Object));
		const sp = await runOne('workspace', 'getDashboard', {
			scope: 'space',
			scopeSpaceId: space.identifier,
		});
		expect(sp).toEqual(expect.any(Object));
	});

	it('getReferenceData returns custom field types including dropdown', async () => {
		const rows = await run('workspace', 'getReferenceData', { category: 'custom-field-types' });
		expect(rows.map((r) => r.identifier)).toContain('dropdown');
	});

	it('every reference data category answers', async () => {
		for (const category of [
			'access-levels',
			'activity-types',
			'automation-action-types',
			'automation-condition-types',
			'automation-field-operators',
			'custom-field-icon-options',
			'resource-view-types',
			'status-types',
			'workspace-access-level-permissions',
		]) {
			const rows = await run('workspace', 'getReferenceData', { category });
			expect(rows.length, category).toBeGreaterThan(0);
		}
	});

	it('listFeatureRequestBoards and listWikiSpaces answer arrays', async () => {
		const boards = await run('workspace', 'listFeatureRequestBoards');
		expect(Array.isArray(boards)).toBe(true);
		const wikiSpaces = await run('workspace', 'listWikiSpaces');
		expect(Array.isArray(wikiSpaces)).toBe(true);
	});
});
