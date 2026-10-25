import type { NodeApiError } from 'n8n-workflow';
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
/** Cleanup for one request or bug; a 404 means a test already deleted it. */
const deleteItem = (resource: 'featureRequest' | 'bug', shortId: string) => async () => {
	await runOne(resource, 'delete', { shortId }).catch(async (error: unknown) => {
		if ((error as NodeApiError).httpCode === '404') {
			return undefined;
		}

		return await Promise.reject(error);
	});
};

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
		const values = async (loader: Parameters<typeof loadOptionsOf>[0]) =>
			(await loadOptionsOf(loader, { board })).map((o) => o.value);
		// A new board's default names; it has no categories, milestones or product areas yet.
		expect(await values('getRequestStatuses')).toEqual([
			'Under Review',
			'Planned',
			'In Progress',
			'Complete',
		]);
		expect(await values('getBugStatuses')).toEqual([
			'New',
			'Triaged',
			'In Progress',
			'Fixed',
			'Released',
			'Closed',
		]);
		expect(await values('getSeverityLevels')).toEqual(['Critical', 'High', 'Medium', 'Low']);
		expect(await values('getRequestCategories')).toEqual([]);
		expect(await values('getMilestones')).toEqual([]);
		expect(await values('getProductAreas')).toEqual([]);
	});

	it('feature request: create, get, list, search, picker', async () => {
		const created = await runOne('featureRequest', 'create', {
			board,
			title: `Live request ${runId}`,
			additionalFields: { description: 'Created by the n8n live tests' },
		});
		request = String(created.shortId);
		expect(request).toMatch(/^NFR-\d+$/);
		cleanup.add(`request ${request}`, deleteItem('featureRequest', request));

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
		const detail = async () => await runOne('featureRequest', 'get', { shortId: request });
		const before = await detail();
		await runOne('featureRequest', 'vote', { shortId: request });
		expect(await detail()).toMatchObject({
			voteCount: Number(before.voteCount) + 1,
			userVoted: true,
		});
		await runOne('featureRequest', 'vote', { shortId: request });
		expect(await detail()).toMatchObject({ voteCount: Number(before.voteCount), userVoted: false });
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
		cleanup.add(`bug ${bugId}`, deleteItem('bug', bugId));

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
		cleanup.add(`bug ${shortId}`, deleteItem('bug', shortId));
		expect(created).toMatchObject({ security: true, public: false, severity: 'Critical' });
	});

	it('delete removes the request and the bug (get then answers 404)', async () => {
		await runOne('bug', 'delete', { shortId: bugId });
		expect((await runError('bug', 'get', { shortId: bugId })).httpCode).toBe('404');
		await runOne('featureRequest', 'delete', { shortId: request });
		expect((await runError('featureRequest', 'get', { shortId: request })).httpCode).toBe('404');
	});

	it('an unknown short ID answers 404 as the catalog says', async () => {
		expect((await runError('featureRequest', 'get', { shortId: 'NFR-999999' })).httpCode).toBe('404');
	});
});
