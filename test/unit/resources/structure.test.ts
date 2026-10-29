import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { customField, folder, list, space, tag } from '../../../nodes/Dutify/resources/structure';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

function op(def: ResourceDef, name: string): OperationDef {
	const found = def.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${name}`);
	}

	return found;
}

function build(def: ResourceDef, name: string, params: Record<string, unknown>) {
	const o = op(def, name);
	if (!o.build) {
		throw new Error(`${name} has no build`);
	}

	return o.build(reader(params));
}

describe('registration', () => {
	it('registers space, folder, list, customField and tag', () => {
		for (const value of ['space', 'folder', 'list', 'customField', 'tag']) {
			expect(resources.map((r) => r.value)).toContain(value);
		}
	});

	it('exposes exactly the catalog operations', () => {
		const names = (d: ResourceDef) => d.operations.map((o) => o.operation).sort();
		expect(names(space)).toEqual(['create', 'delete', 'get', 'update']);
		expect(names(folder)).toEqual(['create', 'delete', 'update']);
		expect(names(list)).toEqual(['create', 'delete', 'update']);
		expect(names(customField)).toEqual(['create', 'delete', 'update']);
		expect(names(tag)).toEqual(['create', 'delete', 'get', 'update']);
	});
});

describe('space', () => {
	it('create posts workspace and name in the body', () => {
		expect(build(space, 'create', { name: 'Engineering' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/spaces/lite',
			body: { workspace: 'ws-1', name: 'Engineering' },
		});
	});

	it('create adds the optional fields that are set', () => {
		const spec = build(space, 'create', {
			name: 'Engineering',
			additionalFields: {
				description: 'All engineering projects',
				icon: 'rocket',
				color: '#4A90D9',
				isPrivate: false,
				ignored: '',
			},
		});
		expect(spec.body).toEqual({
			workspace: 'ws-1',
			name: 'Engineering',
			description: 'All engineering projects',
			icon: 'rocket',
			color: '#4A90D9',
			isPrivate: false,
		});
	});
});

describe('space get, update, delete (catalog: Spaces, /mp/api/v1/spaces/{identifier})', () => {
	it('get sends GET for the identifier, encoded', () => {
		expect(build(space, 'get', { space: 'sp/1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/spaces/sp%2F1',
		});
	});

	it('delete sends DELETE for the identifier, encoded', () => {
		expect(build(space, 'delete', { space: 'sp/1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/spaces/sp%2F1',
		});
	});

	it('update turns subtasks and sprints on with a PUT of only those fields', () => {
		expect(
			build(space, 'update', {
				space: 'sp_1',
				updateFields: { isSubtasksEnabled: true, isSprintsEnabled: true },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/spaces/sp_1',
			body: { isSubtasksEnabled: true, isSprintsEnabled: true },
		});
	});

	it('update keeps false: switching subtasks or sprints off is a change', () => {
		expect(
			build(space, 'update', {
				space: 'sp_1',
				updateFields: { isSubtasksEnabled: false, isSprintsEnabled: false },
			}).body,
		).toEqual({ isSubtasksEnabled: false, isSprintsEnabled: false });
	});

	it('update sends every scalar field of SpaceUpdateRequest that is set, and skips empty ones', () => {
		expect(
			build(space, 'update', {
				space: 'sp_1',
				updateFields: {
					name: 'Engineering',
					description: 'All engineering projects',
					icon: 'rocket',
					color: '#4A90D9',
					isPrivate: true,
					isStatusesInherited: false,
					isPrioritiesInherited: true,
					isTaskKeyUsed: true,
					taskKeyPrefix: 'ENG',
					statuses: '',
				},
			}).body,
		).toEqual({
			name: 'Engineering',
			description: 'All engineering projects',
			icon: 'rocket',
			color: '#4A90D9',
			isPrivate: true,
			isStatusesInherited: false,
			isPrioritiesInherited: true,
			isTaskKeyUsed: true,
			taskKeyPrefix: 'ENG',
		});
	});

	it('update sends the list fields as JSON arrays, typed as text or given by an expression', () => {
		const statuses = [{ name: 'In Progress', type: 'ACTIVE' }];
		const priorities = [{ name: 'High' }];
		const statusReassignments = [
			{ sourceStatusIdentifier: 'sts_old', targetStatusIdentifier: 'sts_new' },
		];
		const priorityReassignments = [
			{ sourcePriorityIdentifier: 'pri_old', targetPriorityIdentifier: 'pri_new' },
		];
		const userAccess = [{ userUuid: '550e8400-e29b-41d4-a716-446655440000', accessLevelId: 1 }];
		const teamAccess = [{ teamIdentifier: 'team_abc', accessLevelId: 1 }];
		expect(
			build(space, 'update', {
				space: 'sp_1',
				updateFields: {
					statuses: JSON.stringify(statuses),
					priorities,
					statusReassignments: JSON.stringify(statusReassignments),
					priorityReassignments,
					userAccess: JSON.stringify(userAccess),
					teamAccess,
				},
			}).body,
		).toEqual({
			statuses,
			priorities,
			statusReassignments,
			priorityReassignments,
			userAccess,
			teamAccess,
		});
	});

	it.each([
		'statuses',
		'priorities',
		'statusReassignments',
		'priorityReassignments',
		'userAccess',
		'teamAccess',
	])('update refuses %s that is not a JSON array, before sending anything', (field) => {
		for (const value of ['{"name":"x"}', 'not json']) {
			expect(() =>
				build(space, 'update', { space: 'sp_1', updateFields: { [field]: value } }),
			).toThrow(/JSON array/);
		}
	});

	it('update with nothing set throws instead of sending PUT {}', () => {
		expect(() => build(space, 'update', { space: 'sp_1', updateFields: {} })).toThrow(
			/at least one/i,
		);
	});

	it('get, update and delete pick the space by identifier', () => {
		for (const operation of ['get', 'update', 'delete']) {
			const field = op(space, operation).fields.find((f) => f.name === 'space');
			expect(
				(field?.typeOptions as { loadOptionsMethod?: string } | undefined)?.loadOptionsMethod,
			).toBe('getSpaceIds');
		}
	});

	it('update offers the subtasks and sprints toggles as booleans', () => {
		const updateFields = op(space, 'update').fields.find((f) => f.name === 'updateFields');
		const options = (updateFields?.options ?? []) as Array<{ name: string; type: string }>;
		for (const name of ['isSubtasksEnabled', 'isSprintsEnabled']) {
			expect(options.find((o) => o.name === name)?.type).toBe('boolean');
		}
	});
});

describe('folder', () => {
	it('create posts workspace, space name and name', () => {
		expect(build(folder, 'create', { space: 'Engineering', name: 'Q2 Roadmap' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/folders/lite',
			body: { workspace: 'ws-1', space: 'Engineering', name: 'Q2 Roadmap' },
		});
	});

	it('update PUTs only the fields that are set, with no query', () => {
		expect(
			build(folder, 'update', {
				folder: 'fld_abc',
				updateFields: { name: 'Sprint 2', isPrivate: true, color: '' },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/folders/lite/fld_abc',
			body: { name: 'Sprint 2', isPrivate: true },
		});
	});

	it('delete sends DELETE for the identifier, encoded', () => {
		expect(build(folder, 'delete', { folder: 'fld/abc' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/folders/lite/fld%2Fabc',
		});
	});
});

describe('list', () => {
	it('create without a folder puts the list directly in the space', () => {
		expect(build(list, 'create', { space: 'Engineering', name: 'Backlog' })).toEqual({
			method: 'POST',
			path: '/mp/api/v1/lists/lite',
			body: { workspace: 'ws-1', space: 'Engineering', name: 'Backlog' },
		});
	});

	it('create with folder, icon and color', () => {
		const spec = build(list, 'create', {
			space: 'Engineering',
			name: 'Backlog',
			additionalFields: { folder: 'Q2 Roadmap', icon: 'list', color: '#4A90D9' },
		});
		expect(spec.body).toEqual({
			workspace: 'ws-1',
			space: 'Engineering',
			folder: 'Q2 Roadmap',
			name: 'Backlog',
			icon: 'list',
			color: '#4A90D9',
		});
	});

	it('update PUTs the changed metadata', () => {
		expect(
			build(list, 'update', {
				list: 'lst_abc',
				updateFields: { name: 'Backlog', description: 'Revised scope', isPrivate: false },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/lists/lite/lst_abc',
			body: { name: 'Backlog', description: 'Revised scope', isPrivate: false },
		});
	});

	it('delete sends DELETE', () => {
		expect(build(list, 'delete', { list: 'lst_abc' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/lists/lite/lst_abc',
		});
	});
});

describe('customField', () => {
	it('create at list scope sends scopeName', () => {
		expect(
			build(customField, 'create', {
				scope: 'list',
				scopeName: 'Backlog',
				name: 'Severity',
				type: 'text',
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/custom-fields/lite',
			body: {
				scope: 'list',
				workspace: 'ws-1',
				scopeName: 'Backlog',
				name: 'Severity',
				type: 'text',
			},
		});
	});

	it('create at workspace scope drops scopeName, which the API ignores', () => {
		const spec = build(customField, 'create', {
			scope: 'workspace',
			scopeName: 'stale',
			name: 'Severity',
			type: 'text',
		});
		expect(spec.body).toEqual({
			scope: 'workspace',
			workspace: 'ws-1',
			name: 'Severity',
			type: 'text',
		});
	});

	it('create turns comma-separated options into {value, orderIndex} objects with emoji and color', () => {
		const spec = build(customField, 'create', {
			scope: 'space',
			scopeName: 'Engineering',
			name: 'Severity',
			type: 'dropdown',
			additionalFields: { emoji: 'Flag', color: '#4A90D9', options: 'High, Low,,Medium' },
		});
		expect(spec.body).toEqual({
			scope: 'space',
			workspace: 'ws-1',
			scopeName: 'Engineering',
			name: 'Severity',
			type: 'dropdown',
			emoji: 'Flag',
			color: '#4A90D9',
			// The backend answers 500 for an option without orderIndex (seen live 2026-10-25).
			options: [
				{ value: 'High', orderIndex: 0 },
				{ value: 'Low', orderIndex: 1 },
				{ value: 'Medium', orderIndex: 2 },
			],
		});
	});

	it('update PUTs name, description, emoji, color and isPrivate', () => {
		expect(
			build(customField, 'update', {
				customField: 'cf_abc',
				updateFields: {
					name: 'Severity',
					description: 'How urgent',
					emoji: 'rocket',
					isPrivate: false,
				},
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/custom-fields/lite/cf_abc',
			body: { name: 'Severity', description: 'How urgent', emoji: 'rocket', isPrivate: false },
		});
	});

	it('delete sends DELETE', () => {
		expect(build(customField, 'delete', { customField: 'cf_abc' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/custom-fields/lite/cf_abc',
		});
	});
});

describe('tag', () => {
	it('create posts a TagDTO under the space identifier', () => {
		expect(
			build(tag, 'create', {
				space: 'sp_abc123',
				name: 'Bug',
				additionalFields: { textColor: '#FFFFFF', backgroundColor: '#3B82F6' },
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/tags/space/sp_abc123',
			body: { name: 'Bug', textColor: '#FFFFFF', backgroundColor: '#3B82F6' },
		});
	});

	it('get fetches by identifier', () => {
		expect(build(tag, 'get', { tag: 'tag_abc123' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/tags/tag_abc123',
		});
	});

	it('delete sends DELETE', () => {
		expect(build(tag, 'delete', { tag: 'tag_abc123' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/tags/tag_abc123',
		});
	});

	it('update merges the change into the current tag, because the backend overwrites omitted fields', async () => {
		const current = {
			identifier: 'tag_abc123',
			name: 'Bug',
			textColor: '#FFFFFF',
			backgroundColor: '#3B82F6',
		};
		const ctx = fakeContext([current, { ...current, name: 'Defect' }]);
		const items = await op(tag, 'update').run!(
			ctx,
			reader({ tag: 'tag_abc123', updateFields: { name: 'Defect' } }),
		);
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/mp/api/v1/tags/tag_abc123' },
			{
				method: 'PUT',
				path: '/mp/api/v1/tags/tag_abc123',
				body: { name: 'Defect', textColor: '#FFFFFF', backgroundColor: '#3B82F6' },
			},
		]);
		expect(items).toEqual([{ json: { ...current, name: 'Defect' } }]);
	});

	it('update with nothing to change throws before any request', async () => {
		const ctx = fakeContext([]);
		await expect(
			op(tag, 'update').run!(ctx, reader({ tag: 'tag_abc123', updateFields: {} })),
		).rejects.toThrow(/at least one/i);
		expect(ctx.calls).toEqual([]);
	});

	it('update merges colours too and never drops a writable TagDTO field', async () => {
		const current = {
			identifier: 't',
			name: 'Bug',
			textColor: '#FFFFFF',
			backgroundColor: '#3B82F6',
		};
		const ctx = fakeContext([current, current]);
		await op(tag, 'update').run!(
			ctx,
			reader({ tag: 't', updateFields: { backgroundColor: '#000000' } }),
		);
		expect(ctx.calls[1].body).toEqual({
			name: 'Bug',
			textColor: '#FFFFFF',
			backgroundColor: '#000000',
		});
	});
});

describe('update with no fields set', () => {
	it.each([
		[folder, { folder: 'fld_abc', updateFields: {} }],
		[list, { list: 'lst_abc', updateFields: { name: '' } }],
		[customField, { customField: 'cf_abc', updateFields: {} }],
	] as const)('%# throws instead of sending PUT {}', (def, params) => {
		expect(() => op(def, 'update').build!(reader({ ...params }))).toThrow(/at least one/i);
	});
});

describe('identifier pickers', () => {
	const methodOf = (def: ResourceDef, operation: string, field: string) =>
		(
			op(def, operation).fields.find((f) => f.name === field)?.typeOptions as
				| { loadOptionsMethod?: string }
				| undefined
		)?.loadOptionsMethod;

	it('every id field except tag offers a picker', () => {
		expect(methodOf(tag, 'create', 'space')).toBe('getSpaceIds');
		expect(methodOf(folder, 'update', 'folder')).toBe('getFolderIds');
		expect(methodOf(folder, 'delete', 'folder')).toBe('getFolderIds');
		expect(methodOf(list, 'update', 'list')).toBe('getListIds');
		expect(methodOf(list, 'delete', 'list')).toBe('getListIds');
		expect(methodOf(customField, 'update', 'customField')).toBe('getCustomFieldIds');
		expect(methodOf(customField, 'delete', 'customField')).toBe('getCustomFieldIds');
	});

	it('tag id stays free text: the context carries tag names only, no identifiers', () => {
		const field = op(tag, 'get').fields.find((f) => f.name === 'tag');
		expect(field?.type).toBe('string');
	});
});
