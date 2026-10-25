import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	loadOptionsOf,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('structure (space, folder, list, custom field, tag) — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'structure');
	});
	afterAll(async () => await cleanup.run());

	it('space create answers the lite space shape', () => {
		expect(space.identifier).toMatch(/\S/);
	});

	it('the space dropdowns list the new space (by name and by ID)', async () => {
		const byName = await loadOptionsOf('getSpaces');
		expect(byName.map((o) => o.value)).toContain(space.name);
		const byId = await loadOptionsOf('getSpaceIds');
		expect(byId.map((o) => o.value)).toContain(space.identifier);
	});

	it('folder: create, update, delete', async () => {
		const created = await runOne('folder', 'create', {
			space: space.name,
			name: `Folder ${runId}`,
		});
		// The lite responses name the workspace and space by their display names.
		expect(created).toMatchObject({ name: `Folder ${runId}`, space: space.name });
		const folder = String(created.identifier);
		cleanup.add(`folder ${folder}`, async () => await runOne('folder', 'delete', { folder }));

		const options = await loadOptionsOf('getFolderIds');
		expect(options.map((o) => o.value)).toContain(folder);

		const updated = await runOne('folder', 'update', {
			folder,
			updateFields: { name: `Folder renamed ${runId}`, description: 'live test' },
		});
		expect(updated).toMatchObject({
			identifier: folder,
			name: `Folder renamed ${runId}`,
			description: 'live test',
		});

		expect(await runOne('folder', 'delete', { folder })).toEqual({ success: true });
	});

	it('list: create in the space and in a folder, update, delete', async () => {
		const folderName = `List folder ${runId}`;
		const folder = await runOne('folder', 'create', { space: space.name, name: folderName });

		const inSpace = await runOne('list', 'create', { space: space.name, name: `List ${runId}` });
		expect(inSpace).toMatchObject({ name: `List ${runId}`, space: space.name });
		const inFolder = await runOne('list', 'create', {
			space: space.name,
			name: `Nested list ${runId}`,
			additionalFields: { folder: folderName },
		});
		expect(inFolder).toMatchObject({ name: `Nested list ${runId}`, folder: folderName });

		const listIds = (await loadOptionsOf('getListIds')).map((o) => o.value);
		expect(listIds).toEqual(
			expect.arrayContaining([String(inSpace.identifier), String(inFolder.identifier)]),
		);

		const updated = await runOne('list', 'update', {
			list: String(inSpace.identifier),
			updateFields: { name: `List renamed ${runId}` },
		});
		expect(updated).toMatchObject({ name: `List renamed ${runId}` });

		expect(await runOne('list', 'delete', { list: String(inSpace.identifier) })).toEqual({
			success: true,
		});
		expect(await runOne('list', 'delete', { list: String(inFolder.identifier) })).toEqual({
			success: true,
		});
		await runOne('folder', 'delete', { folder: String(folder.identifier) });
	});

	it('custom field: create on a list with options, update, delete', async () => {
		const listName = `CF list ${runId}`;
		const list = await runOne('list', 'create', { space: space.name, name: listName });
		cleanup.add(
			`list ${String(list.identifier)}`,
			async () => await runOne('list', 'delete', { list: String(list.identifier) }),
		);

		const created = await runOne('customField', 'create', {
			scope: 'list',
			scopeName: listName,
			name: `Stage ${runId}`,
			type: 'dropdown',
			additionalFields: { options: 'One, Two' },
		});
		expect(created).toMatchObject({ name: `Stage ${runId}`, scope: 'list', scopeName: listName });
		const customField = String(created.identifier);
		cleanup.add(
			`custom field ${customField}`,
			async () => await runOne('customField', 'delete', { customField }),
		);

		const options = await loadOptionsOf('getCustomFieldIds');
		expect(options.map((o) => o.value)).toContain(customField);

		const updated = await runOne('customField', 'update', {
			customField,
			updateFields: { name: `Stage renamed ${runId}`, description: 'live test' },
		});
		expect(updated).toMatchObject({ name: `Stage renamed ${runId}`, description: 'live test' });

		expect(await runOne('customField', 'delete', { customField })).toEqual({ success: true });
	});

	it('tag: create, get, update keeps unspecified fields, delete', async () => {
		const created = await runOne('tag', 'create', {
			space: space.identifier,
			name: `tag-${runId}`,
			additionalFields: { backgroundColor: '#3B82F6', textColor: '#FFFFFF' },
		});
		expect(created).toMatchObject({ name: `tag-${runId}` });
		const tag = String(created.identifier);
		cleanup.add(`tag ${tag}`, async () => await runOne('tag', 'delete', { tag }));

		expect(await runOne('tag', 'get', { tag })).toMatchObject({
			identifier: tag,
			name: `tag-${runId}`,
		});

		await runOne('tag', 'update', { tag, updateFields: { backgroundColor: '#10B981' } });
		const after = await runOne('tag', 'get', { tag });
		expect(after).toMatchObject({
			name: `tag-${runId}`,
			backgroundColor: '#10B981',
			textColor: '#FFFFFF',
		});

		expect(await runOne('tag', 'delete', { tag })).toEqual({ success: true });
		const gone = await runError('tag', 'get', { tag });
		expect(gone.httpCode).toBe('404');
	});
});
