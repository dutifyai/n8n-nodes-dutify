import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	live,
	liveDescribe,
	loadOptionsOf,
	rawRequest,
	run,
	runError,
	runOne,
	runId,
} from './harness';

/*
 * The node has no board operations, so the board is created and deleted with the Roadmarq board
 * endpoints directly (POST / DELETE /api/roadmarq/v1/boards). Everything else goes through the node.
 */
liveDescribe('Roadmarq feature request and bug — live', () => {
	const cleanup = cleanupStack();
	const board = `n8n-live-${runId}`;
	let request = '';
	let bugId = '';

	beforeAll(async () => {
		const created = (await rawRequest(
			{
				method: 'POST',
				path: '/api/roadmarq/v1/boards',
				body: {
					workspaceIdentifier: live.workspace,
					name: `n8n live ${runId}`,
					slug: board,
					featureRequestKey: 'NFR',
					bugReportKey: 'NBG',
					isPublic: false,
					// Bug reports are off on a new board.
					settings: { featureRequestsEnabled: true, bugReportsEnabled: true },
				},
			},
			live.workspace,
		)) as { id: string };
		cleanup.add(
			`board ${board}`,
			async () =>
				await rawRequest(
					{
						method: 'DELETE',
						path: `/api/roadmarq/v1/boards/${created.id}`,
						qs: { workspaceIdentifier: live.workspace },
					},
					live.workspace,
				),
		);
	});
	afterAll(async () => await cleanup.run());

	it('board pickers list the board and its names', async () => {
		expect((await loadOptionsOf('getBoards')).map((o) => o.value)).toContain(board);
		expect((await run('workspace', 'listFeatureRequestBoards')).map((b) => b.slug)).toContain(board);
		for (const loader of [
			'getRequestStatuses',
			'getRequestCategories',
			'getMilestones',
			'getBugStatuses',
			'getSeverityLevels',
			'getProductAreas',
		]) {
			const options = await loadOptionsOf(loader, { board });
			expect(Array.isArray(options), loader).toBe(true);
			console.log(`[live] ${loader}`, JSON.stringify(options.map((o) => o.value)));
		}
	});

	it('feature request: create, get, list, search, picker', async () => {
		const created = await runOne('featureRequest', 'create', {
			board,
			title: `Live request ${runId}`,
			additionalFields: { description: 'Created by the n8n live tests' },
		});
		request = String(created.shortId);
		expect(request).toMatch(/^NFR-\d+$/);
		cleanup.add(
			`request ${request}`,
			async () => await runOne('featureRequest', 'delete', { shortId: request }),
		);

		expect(await runOne('featureRequest', 'get', { shortId: request })).toMatchObject({
			shortId: request,
			title: `Live request ${runId}`,
		});
		const listed = await run('featureRequest', 'list', { board, returnAll: true });
		expect(listed.map((r) => r.shortId)).toContain(request);
		const found = await run('featureRequest', 'list', {
			board,
			filters: { q: `Live request ${runId}` },
		});
		expect(Array.isArray(found)).toBe(true);
		expect((await loadOptionsOf('getRequestShortIds', { board })).map((o) => o.value)).toContain(
			request,
		);
	});

	it('feature request: setStatus by name, misspelled status lists the valid ones', async () => {
		const statuses = (await loadOptionsOf('getRequestStatuses', { board })).map((o) =>
			String(o.value),
		);
		expect(statuses.length).toBeGreaterThan(1);
		const target = statuses[statuses.length - 1];
		await runOne('featureRequest', 'setStatus', { shortId: request, status: target.toUpperCase() });
		expect(JSON.stringify(await runOne('featureRequest', 'get', { shortId: request }))).toContain(
			target,
		);

		const error = await runError('featureRequest', 'setStatus', {
			shortId: request,
			status: 'No Such Status',
		});
		expect(error.httpCode).toBe('400');
		expect(`${error.message} ${error.description}`).toContain(statuses[0]);
	});

	it('feature request: comment, vote twice (toggles the vote count), moderate', async () => {
		const comment = await runOne('featureRequest', 'comment', {
			shortId: request,
			content: `Live comment ${runId}`,
			additionalFields: { isInternal: true },
		});
		expect(comment).toMatchObject({ content: `Live comment ${runId}`, internal: true });
		// userVoted in the detail stays false for API-key callers, so the count is what is checked.
		const votes = async () =>
			Number((await runOne('featureRequest', 'get', { shortId: request })).voteCount);
		const before = await votes();
		await runOne('featureRequest', 'vote', { shortId: request });
		expect(await votes()).toBe(before + 1);
		await runOne('featureRequest', 'vote', { shortId: request });
		expect(await votes()).toBe(before);
		expect(await runOne('featureRequest', 'moderate', { shortId: request, action: 'approve' })).toMatchObject(
			{ shortId: request },
		);
	});

	it('bug: create with environment JSON, get, approve, then list and picker show it, setStatus', async () => {
		const created = await runOne('bug', 'create', {
			board,
			title: `Live bug ${runId}`,
			additionalFields: {
				stepsToReproduce: '1. Run the live tests',
				expectedResult: 'Green',
				actualResult: 'Also green',
				environment: '{"browser":"n8n","os":"live"}',
			},
		});
		bugId = String(created.shortId);
		expect(bugId).toMatch(/^NBG-\d+$/);
		cleanup.add(`bug ${bugId}`, async () => await runOne('bug', 'delete', { shortId: bugId }));

		const fetched = await runOne('bug', 'get', { shortId: bugId });
		expect(fetched).toMatchObject({ shortId: bugId, title: `Live bug ${runId}` });
		expect(fetched.environment).toEqual({ browser: 'n8n', os: 'live' });

		// A new bug waits in the moderation queue; board lists show approved bugs only.
		expect((await run('bug', 'list', { board, returnAll: true })).map((b) => b.shortId)).not.toContain(
			bugId,
		);
		expect(await runOne('bug', 'moderate', { shortId: bugId, action: 'approve' })).toMatchObject({
			shortId: bugId,
		});
		expect((await run('bug', 'list', { board, returnAll: true })).map((b) => b.shortId)).toContain(
			bugId,
		);
		expect((await loadOptionsOf('getBugShortIds', { board })).map((o) => o.value)).toContain(bugId);

		const statuses = (await loadOptionsOf('getBugStatuses', { board })).map((o) => String(o.value));
		expect(statuses.length).toBeGreaterThan(1);
		await runOne('bug', 'setStatus', { shortId: bugId, status: statuses[1] });
		expect(await runOne('bug', 'get', { shortId: bugId })).toMatchObject({ status: statuses[1] });
		const filtered = await run('bug', 'list', { board, filters: { status: statuses[1] } });
		expect(filtered.map((b) => b.shortId)).toEqual([bugId]);
	});

	it('bug: assign by email and unassign, visibility, affected, comment', async () => {
		const assigned = await runOne('bug', 'setAssignee', {
			shortId: bugId,
			assigneeEmail: live.userEmail,
		});
		expect(assigned.assigneeId).toBe(live.userId);
		const unassigned = await runOne('bug', 'setAssignee', { shortId: bugId });
		expect(unassigned.assigneeId).toBeNull();

		expect(await runOne('bug', 'setVisibility', { shortId: bugId, isPublic: true })).toMatchObject({
			public: true,
		});
		expect(await runOne('bug', 'setVisibility', { shortId: bugId, isPublic: false })).toMatchObject({
			public: false,
		});
		const affected = async () =>
			Number((await runOne('bug', 'get', { shortId: bugId })).affectedCount);
		const before = await affected();
		await runOne('bug', 'toggleAffected', { shortId: bugId });
		expect(await affected()).toBe(before + 1);
		await runOne('bug', 'toggleAffected', { shortId: bugId });
		expect(await affected()).toBe(before);
		const comment = await runOne('bug', 'comment', {
			shortId: bugId,
			content: `Bug note ${runId}`,
			additionalFields: { isInternal: true },
		});
		expect(comment).toMatchObject({ content: `Bug note ${runId}`, internal: true });
	});

	it('bug: a security issue is stored as one', async () => {
		const created = await runOne('bug', 'create', {
			board,
			title: `Live security bug ${runId}`,
			additionalFields: { isSecurity: true, severity: 'Critical' },
		});
		const shortId = String(created.shortId);
		cleanup.add(`bug ${shortId}`, async () => await runOne('bug', 'delete', { shortId }));
		expect(created).toMatchObject({ security: true, public: false, severity: 'Critical' });
	});

	/*
	 * BACKEND BUG (Roadmarq lite short-ID lookup): the catalog promises 404 "No request/bug matches
	 * the short ID", production answers 400 BAD_REQUEST "shortId 'NBG-1' not found." So the
	 * delete check accepts the 400 and a tripwire pins the 404 the contract promises.
	 */
	it('delete removes the request and the bug (get then refuses the short ID)', async () => {
		await runOne('bug', 'delete', { shortId: bugId });
		const bugGone = await runError('bug', 'get', { shortId: bugId });
		expect(bugGone.message).toContain('not found');
		await runOne('featureRequest', 'delete', { shortId: request });
		const requestGone = await runError('featureRequest', 'get', { shortId: request });
		expect(requestGone.message).toContain('not found');
	});

	it.fails('an unknown short ID answers 404 as the catalog says (fails in production, see above)', async () => {
		expect((await runError('featureRequest', 'get', { shortId: 'NFR-999999' })).httpCode).toBe('404');
	});
});
