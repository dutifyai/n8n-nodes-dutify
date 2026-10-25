import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { importJob, invitation, member, team } from '../../../nodes/Dutify/resources/admin';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { reader } from '../helpers';

function opOf(resource: ResourceDef, name: string): OperationDef {
	const found = resource.operations.find((o) => o.operation === name);
	if (!found) {
		throw new Error(`no operation ${resource.value}.${name}`);
	}

	return found;
}

const build = (resource: ResourceDef, name: string, params: Record<string, unknown>) =>
	opOf(resource, name).build!(reader(params));

const loaderOf = (resource: ResourceDef, operation: string, field: string) =>
	(
		opOf(resource, operation).fields.find((f) => f.name === field)?.typeOptions as
			| { loadOptionsMethod?: string }
			| undefined
	)?.loadOptionsMethod;

const PAGE_100 = {
	kind: 'page',
	pageParam: 'page',
	sizeParam: 'size',
	zeroBased: true,
	maxPageSize: 100,
};

describe('registration', () => {
	it('registers team, member, invitation and importJob, all workspace scoped', () => {
		for (const r of [team, member, invitation, importJob]) {
			expect(resources).toContain(r);
			expect(r.workspaceScoped).toBe(true);
		}
		expect([team.value, member.value, invitation.value, importJob.value]).toEqual([
			'team',
			'member',
			'invitation',
			'importJob',
		]);
	});

	it('exposes the operations of the brief', () => {
		expect(team.operations.map((o) => o.operation)).toEqual([
			'list',
			'create',
			'get',
			'update',
			'delete',
			'addMember',
			'removeMember',
		]);
		expect(member.operations.map((o) => o.operation)).toEqual([
			'list',
			'changeRole',
			'remove',
			'transferOwnership',
			'leave',
		]);
		expect(invitation.operations.map((o) => o.operation)).toEqual(['list', 'send', 'cancel']);
		expect(importJob.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'confirmMappings',
		]);
	});
});

describe('team', () => {
	it('list: GET workspaces/{ws}/teams, zero-based page/size capped at 100, plain array', () => {
		expect(build(team, 'list', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/teams',
			paginate: PAGE_100,
		});
		expect(opOf(team, 'list').list).toBe(true);
	});

	it('create: POST workspaces/{ws}/teams with name and alias (the backend rejects a blank alias)', () => {
		expect(
			build(team, 'create', { name: 'Backend Engineers', alias: 'backend', additionalFields: {} }),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/teams',
			body: { name: 'Backend Engineers', alias: 'backend' },
		});
		const alias = opOf(team, 'create').fields.find((f) => f.name === 'alias');
		expect(alias?.required).toBe(true);
	});

	it('create: optional description, icon, color and initial members', () => {
		expect(
			build(team, 'create', {
				name: 'Backend Engineers',
				alias: 'backend',
				additionalFields: {
					description: 'APIs',
					icon: 'users',
					color: '#9B59B6',
					memberUuids: ['u-1', 'u-2'],
				},
			}).body,
		).toEqual({
			name: 'Backend Engineers',
			alias: 'backend',
			description: 'APIs',
			icon: 'users',
			color: '#9B59B6',
			memberUuids: ['u-1', 'u-2'],
		});
	});

	it('get: GET teams/{team}', () => {
		expect(build(team, 'get', { team: 'team_abc123' })).toEqual({
			method: 'GET',
			path: '/mp/api/teams/team_abc123',
		});
	});

	it('update: PUT teams/{team} with only the fields set; memberUuids replaces the membership', () => {
		expect(
			build(team, 'update', {
				team: 'team_abc123',
				updateFields: { name: 'Platform', alias: 'platform', memberUuids: ['u-1'] },
			}),
		).toEqual({
			method: 'PUT',
			path: '/mp/api/teams/team_abc123',
			body: { name: 'Platform', alias: 'platform', memberUuids: ['u-1'] },
		});
	});

	it('update: refuses to send an empty body', () => {
		expect(() => build(team, 'update', { team: 'team_abc123', updateFields: {} })).toThrow(
			/at least one field/i,
		);
	});

	it('delete: DELETE teams/{team}', () => {
		expect(build(team, 'delete', { team: 'team_abc123' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/teams/team_abc123',
		});
	});

	it('addMember: POST teams/{team}/members with userUuid as a query parameter', () => {
		expect(build(team, 'addMember', { team: 'team_abc123', user: 'u-1' })).toEqual({
			method: 'POST',
			path: '/mp/api/teams/team_abc123/members',
			qs: { userUuid: 'u-1' },
		});
	});

	it('removeMember: DELETE teams/{team}/members/{userUuid}', () => {
		expect(build(team, 'removeMember', { team: 'team_abc123', user: 'u-1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/teams/team_abc123/members/u-1',
		});
	});

	it('encodes path values', () => {
		expect(build(team, 'get', { team: 'a/b' }).path).toBe('/mp/api/teams/a%2Fb');
	});

	it('picks teams and members from lists, never asks for an ID', () => {
		for (const op of ['get', 'update', 'delete', 'addMember', 'removeMember']) {
			expect(loaderOf(team, op, 'team')).toBe('getTeams');
		}
		expect(loaderOf(team, 'addMember', 'user')).toBe('getMemberIds');
		expect(loaderOf(team, 'removeMember', 'user')).toBe('getMemberIds');
		const memberUuids = (op: string, collectionName: string) =>
			(
				opOf(team, op).fields.find((f) => f.name === collectionName)?.options as Array<{
					name: string;
					typeOptions?: { loadOptionsMethod?: string };
				}>
			).find((f) => f.name === 'memberUuids')?.typeOptions?.loadOptionsMethod;
		expect(memberUuids('create', 'additionalFields')).toBe('getMemberIds');
		expect(memberUuids('update', 'updateFields')).toBe('getMemberIds');
	});
});

describe('member', () => {
	it('list: GET workspaces/{ws}/users, page/size capped at 100, rows under "users"', () => {
		expect(build(member, 'list', { additionalFields: {} })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/users',
			paginate: { ...PAGE_100, itemsPath: 'users' },
		});
		expect(opOf(member, 'list').list).toBe(true);
	});

	it('list: optional search term', () => {
		expect(build(member, 'list', { additionalFields: { search: 'jane' } }).qs).toEqual({
			search: 'jane',
		});
	});

	it('changeRole: PUT workspaces/{ws}/users with userUuid and workspaceAccessLevelId', () => {
		expect(build(member, 'changeRole', { user: 'u-1', accessLevel: 2 })).toEqual({
			method: 'PUT',
			path: '/mp/api/v1/workspaces/ws-1/users',
			body: { userUuid: 'u-1', workspaceAccessLevelId: 2 },
		});
	});

	it('changeRole: an access level given as text (an expression) is sent as a number', () => {
		expect(build(member, 'changeRole', { user: 'u-1', accessLevel: '2' }).body).toEqual({
			userUuid: 'u-1',
			workspaceAccessLevelId: 2,
		});
	});

	it('remove: DELETE workspaces/{ws}/users with deletionUserUuid as a query parameter', () => {
		expect(build(member, 'remove', { user: 'u-1' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/workspaces/ws-1/users',
			qs: { deletionUserUuid: 'u-1' },
		});
	});

	it('transferOwnership: POST users/transfer-ownership with the new owner and the previous owner level', () => {
		expect(
			build(member, 'transferOwnership', { user: 'u-2', resultingOwnerAccessLevel: 1 }),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/users/transfer-ownership',
			body: { transferToUserUuid: 'u-2', resultingOwnerAccessLevelId: 1 },
		});
	});

	it('leave: POST users/leave without a body', () => {
		expect(build(member, 'leave', {})).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/users/leave',
		});
	});

	it('picks members and access levels from lists', () => {
		expect(loaderOf(member, 'changeRole', 'user')).toBe('getMemberIds');
		expect(loaderOf(member, 'changeRole', 'accessLevel')).toBe('getAccessLevels');
		expect(loaderOf(member, 'remove', 'user')).toBe('getMemberIds');
		expect(loaderOf(member, 'transferOwnership', 'user')).toBe('getMemberIds');
		expect(loaderOf(member, 'transferOwnership', 'resultingOwnerAccessLevel')).toBe(
			'getAccessLevels',
		);
	});
});

describe('invitation', () => {
	it('list: GET workspaces/{ws}/invitations (a plain array, no paging)', () => {
		expect(build(invitation, 'list', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/invitations',
		});
		expect(opOf(invitation, 'list').list).toBeUndefined();
	});

	it('send: POST workspaces/{ws}/invitations with email and workspaceAccessLevelId', () => {
		expect(
			build(invitation, 'send', {
				email: 'jane.smith@example.com',
				accessLevel: 2,
				additionalFields: {},
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/invitations',
			body: { email: 'jane.smith@example.com', workspaceAccessLevelId: 2 },
		});
	});

	it('send: optional suiteAccess and hubAccess, false is kept', () => {
		expect(
			build(invitation, 'send', {
				email: 'jane.smith@example.com',
				accessLevel: '3',
				additionalFields: { suiteAccess: false, hubAccess: true },
			}).body,
		).toEqual({
			email: 'jane.smith@example.com',
			workspaceAccessLevelId: 3,
			suiteAccess: false,
			hubAccess: true,
		});
	});

	it('cancel: DELETE workspaces/{ws}/invitations/{invitation}', () => {
		expect(build(invitation, 'cancel', { invitation: 'inv-abc123' })).toEqual({
			method: 'DELETE',
			path: '/mp/api/v1/workspaces/ws-1/invitations/inv-abc123',
		});
	});

	it('picks the invitation and access level from lists', () => {
		expect(loaderOf(invitation, 'cancel', 'invitation')).toBe('getInvitations');
		expect(loaderOf(invitation, 'send', 'accessLevel')).toBe('getAccessLevels');
	});
});

describe('importJob', () => {
	it('list: GET workspaces/{ws}/import, zero-based page/pageSize, plain array', () => {
		expect(build(importJob, 'list', {})).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/import',
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'pageSize',
				zeroBased: true,
				maxPageSize: 100,
			},
		});
		expect(opOf(importJob, 'list').list).toBe(true);
	});

	it('get: GET workspaces/{ws}/import/{job}', () => {
		expect(build(importJob, 'get', { job: 'imp_1' })).toEqual({
			method: 'GET',
			path: '/mp/api/v1/workspaces/ws-1/import/imp_1',
		});
	});

	it('confirmMappings: POST import/{job}/confirm with columnMappings from the mapping rows', () => {
		expect(
			build(importJob, 'confirmMappings', {
				job: 'imp_1',
				columnMappings: {
					mapping: [
						{ csvHeader: 'Title', targetField: 'title', targetType: 'builtin' },
						{ csvHeader: 'Points', targetField: 'cf_1', targetType: 'custom_field' },
					],
				},
			}),
		).toEqual({
			method: 'POST',
			path: '/mp/api/v1/workspaces/ws-1/import/imp_1/confirm',
			body: {
				columnMappings: [
					{ csvHeader: 'Title', targetField: 'title', targetType: 'builtin' },
					{ csvHeader: 'Points', targetField: 'cf_1', targetType: 'custom_field' },
				],
			},
		});
	});

	it('confirmMappings: needs at least one mapping (the backend requires minItems 1)', () => {
		expect(() => build(importJob, 'confirmMappings', { job: 'imp_1', columnMappings: {} })).toThrow(
			/at least one/i,
		);
		expect(() =>
			build(importJob, 'confirmMappings', { job: 'imp_1', columnMappings: { mapping: [] } }),
		).toThrow(/at least one/i);
	});

	it('picks the job from a list', () => {
		expect(loaderOf(importJob, 'get', 'job')).toBe('getImportJobs');
		expect(loaderOf(importJob, 'confirmMappings', 'job')).toBe('getImportJobs');
	});
});
