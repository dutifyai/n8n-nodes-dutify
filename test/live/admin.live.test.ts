import { afterAll, expect, it } from 'vitest';
import { cleanupStack, liveDescribe, live, loadOptionsOf, run, runError, runOne, runId } from './harness';

/**
 * Team round-trip; member, invitation and import job reads only. Invitations would send real
 * mail and member writes would change the test account's own membership, so those
 * operations are covered by the unit tests alone (Task 16 rulings).
 */
liveDescribe('team, member, invitation, import job — live', () => {
	const cleanup = cleanupStack();
	afterAll(async () => await cleanup.run());

	it('member list includes the test user; the member and access level pickers populate', async () => {
		const members = await run('member', 'list', { returnAll: true });
		expect(JSON.stringify(members)).toContain(live.userEmail);
		const filtered = await run('member', 'list', {
			additionalFields: { search: live.userEmail.slice(0, 8) },
			returnAll: true,
		});
		expect(JSON.stringify(filtered)).toContain(live.userEmail);
		const memberIds = await loadOptionsOf('getMemberIds');
		expect(memberIds.map((o) => o.value)).toContain(live.userId);
		const levels = await loadOptionsOf('getAccessLevels');
		expect(levels.length).toBeGreaterThan(0);
	});

	it('team: create with a member, get, update, remove and re-add the member, list, delete', async () => {
		const created = await runOne('team', 'create', {
			name: `Team ${runId}`,
			alias: `team-${runId}`,
			additionalFields: { description: 'live test', memberUuids: [live.userId] },
		});
		expect(created).toMatchObject({ name: `Team ${runId}`, alias: `team-${runId}` });
		const team = String(created.identifier);
		cleanup.add(`team ${team}`, async () => await runOne('team', 'delete', { team }));

		const options = await loadOptionsOf('getTeams');
		expect(options.map((o) => o.value)).toContain(team);

		const fetched = await runOne('team', 'get', { team });
		expect(JSON.stringify(fetched)).toContain(live.userId);

		const updated = await runOne('team', 'update', {
			team,
			updateFields: { name: `Team renamed ${runId}` },
		});
		expect(updated).toMatchObject({ name: `Team renamed ${runId}` });

		await runOne('team', 'removeMember', { team, user: live.userId });
		expect(JSON.stringify(await runOne('team', 'get', { team }))).not.toContain(live.userId);
		await runOne('team', 'addMember', { team, user: live.userId });
		expect(JSON.stringify(await runOne('team', 'get', { team }))).toContain(live.userId);

		const teams = await run('team', 'list', { returnAll: true });
		expect(teams.map((t) => t.identifier)).toContain(team);

		expect(await runOne('team', 'delete', { team })).toEqual({ success: true });
		const gone = await runError('team', 'get', { team });
		expect(gone.httpCode).toBe('404');
	});

	it('invitation list and the invitation picker answer (no invitation is sent)', async () => {
		const invitations = await run('invitation', 'list');
		expect(Array.isArray(invitations)).toBe(true);
		expect(Array.isArray(await loadOptionsOf('getInvitations'))).toBe(true);
	});

	// BACKEND BUG (PM ApiKeyScopeFilter + ApiKeyScope, origin/master 946745b2): GET .../import
	// needs `imports:read`, but ApiKeyScope only defines `imports:write`, so not even a
	// `suite:*` key can read import jobs. The node shows the 403 as a NodeApiError.
	it('import job list is refused with a 403 that names the missing scope', async () => {
		const error = await runError('importJob', 'list', { returnAll: true });
		expect(error.httpCode).toBe('403');
		expect(error.message).toContain('imports:read');
	});

	it.fails('import job list answers (fails in production, see above)', async () => {
		const jobs = await run('importJob', 'list', { returnAll: true });
		expect(Array.isArray(jobs)).toBe(true);
	});
});
