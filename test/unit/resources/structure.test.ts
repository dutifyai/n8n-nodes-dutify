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
		expect(names(space)).toEqual(['create']);
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

	it('create turns comma-separated options into {value} objects with emoji and color', () => {
		const spec = build(customField, 'create', {
			scope: 'space',
			scopeName: 'Engineering',
			name: 'Severity',
			type: 'select',
			additionalFields: { emoji: 'Flag', color: '#4A90D9', options: 'High, Low,,Medium' },
		});
		expect(spec.body).toEqual({
			scope: 'space',
			workspace: 'ws-1',
			scopeName: 'Engineering',
			name: 'Severity',
			type: 'select',
			emoji: 'Flag',
			color: '#4A90D9',
			options: [{ value: 'High' }, { value: 'Low' }, { value: 'Medium' }],
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
});
