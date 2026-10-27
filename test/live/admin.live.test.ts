import { sleep } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
import { afterAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	live,
	loadOptionsOf,
	rawMultipart,
	run,
	runError,
	runOne,
	runId,
} from './harness';

/**
 * Resend's documented test inbox: Dutify's production mail goes through Resend, which accepts
 * mail to delivered@resend.dev (with any +label) as delivered without passing it to anyone.
 */
const UNREAD_INBOX = `delivered+n8n-live-${runId}@resend.dev`;

/**
 * Team round-trip; member list, invitation and import job operations.
 *
 * The node has no member writes (change role, remove, leave, transfer ownership): Dutify keeps
 * member administration for signed-in sessions and refuses it for every API key, the node's only
 * credential.
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

	// `imports:read` exists since dutify-pm #234 (prod-0.1.793). The test workspace has no import
	// jobs (none is started here: confirming one creates tasks from a CSV), so get is checked
	// against an unknown job.
	it('import job list, picker and get answer with imports:read', async () => {
		const jobs = await run('importJob', 'list', { returnAll: true });
		expect(Array.isArray(jobs)).toBe(true);
		const options = await loadOptionsOf('getImportJobs');
		expect(options).toHaveLength(jobs.length);
		const unknown = await runError('importJob', 'get', {
			job: '00000000-0000-0000-0000-000000000000',
		});
		expect(unknown.httpCode).toBe('404');
	});

	/* ---------- invitations ---------- */

	it('invitation send to an inbox nobody reads, list shows it, cancel revokes it', async () => {
		const levels = await loadOptionsOf('getAccessLevels');
		const guest = levels.find((l) => l.name === 'Guest') ?? levels[0];
		cleanup.add('invitations of this run', async () => {
			for (const row of await run('invitation', 'list')) {
				if (row.invitedEmail === UNREAD_INBOX) {
					await runOne('invitation', 'cancel', { invitation: String(row.identifier) });
				}
			}
		});
		// 201 "Invitation sent", with no body.
		expect(
			await runOne('invitation', 'send', {
				email: UNREAD_INBOX,
				accessLevel: guest.value,
				additionalFields: { suiteAccess: true, hubAccess: false },
			}),
		).toEqual({ success: true });
		const listed = await run('invitation', 'list');
		const row = listed.find((i) => i.invitedEmail === UNREAD_INBOX);
		expect(row).toMatchObject({
			status: 'PENDING',
			workspaceAccessLevelId: guest.value,
			suiteAccess: true,
			hubAccess: false,
		});
		const invitation = String(row?.identifier);
		expect((await loadOptionsOf('getInvitations')).map((o) => String(o.value))).toContain(
			invitation,
		);

		expect(await runOne('invitation', 'cancel', { invitation })).toEqual({ success: true });
		const after = await run('invitation', 'list');
		expect(JSON.stringify(after)).not.toContain(UNREAD_INBOX);
		const again = await runError('invitation', 'cancel', { invitation });
		expect(again.message).toMatch(/Only pending invitations can be cancelled/);
		cancelledInvitation = invitation;
	});

	let cancelledInvitation = '';

	// Backend gap: PM answers 400 OPERATION_NOT_ALLOWED, a code the catalog does not list for
	// this endpoint (204, 401, 403, 404, 409, 500); the conflict it describes is the 409.
	it.fails('backend gap: cancelling a cancelled invitation answers 409 as the catalog lists', async () => {
		expect(cancelledInvitation).not.toBe('');
		const again = await runError('invitation', 'cancel', { invitation: cancelledInvitation });
		expect(again.httpCode).toBe('409');
	});

	it('invitation send to someone who is already a member is refused (no mail)', async () => {
		const levels = await loadOptionsOf('getAccessLevels');
		const error = await runError('invitation', 'send', {
			email: live.userEmail,
			accessLevel: levels[0].value,
		});
		// The catalog lists 400 and 409 for a refused invitation.
		expect(['400', '409']).toContain(error.httpCode);
		expect(JSON.stringify(await run('invitation', 'list'))).not.toContain(live.userEmail);
	});

	/* ---------- import: preview a 2-row CSV, confirm the mapping, the tasks appear ---------- */

	it(
		'importJob confirmMappings imports a previewed CSV into a list',
		async () => {
			const space = await createTestSpace(cleanup, 'import');
			const listName = `Import ${runId}`;
			const list = await runOne('list', 'create', { space: space.name, name: listName });
			const csv = `Title,Notes\nImported one ${runId},a\nImported two ${runId},b\n`;
			const preview = (await rawMultipart(
				`/mp/api/v1/workspaces/${encodeURIComponent(live.workspace)}/import/csv/preview`,
				{
					file: { data: Buffer.from(csv), fileName: `n8n-live-${runId}.csv`, mimeType: 'text/csv' },
					taskListIdentifier: String(list.identifier),
				},
			)) as IDataObject;
			const job = String(preview.jobIdentifier);
			expect(preview.csvHeaders).toEqual(['Title', 'Notes']);
			expect((await runOne('importJob', 'get', { job })).status).toBe('PREVIEW');

			const confirmed = await runOne('importJob', 'confirmMappings', {
				job,
				columnMappings: {
					mapping: [{ csvHeader: 'Title', targetField: 'title', targetType: 'builtin' }],
				},
			});
			expect(confirmed).toMatchObject({ identifier: job });
			expect(confirmed.status).not.toBe('PREVIEW');

			let status: IDataObject = confirmed;
			for (let i = 0; i < 30 && !/COMPLETED|FAILED/.test(String(status.status)); i++) {
				await sleep(2000);
				status = await runOne('importJob', 'get', { job });
			}
			expect(status).toMatchObject({ status: 'COMPLETED', totalRows: 2, processedRows: 2 });
			const found = await run('task', 'search', {
				additionalFields: { list: listName },
				returnAll: true,
			});
			expect(found.map((t) => t.title).sort()).toEqual([
				`Imported one ${runId}`,
				`Imported two ${runId}`,
			]);
			expect((await run('importJob', 'list', { returnAll: true })).map((j) => j.identifier)).toContain(
				job,
			);
		},
		120_000,
	);
});
