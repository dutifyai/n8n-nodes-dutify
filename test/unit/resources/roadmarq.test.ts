import { describe, expect, it } from 'vitest';
import { resources } from '../../../nodes/Dutify/registry';
import { bug, featureRequest, roadmarqBoard } from '../../../nodes/Dutify/resources/roadmarq';
import type { OperationDef, ResourceDef } from '../../../shared/types';
import { fakeContext, reader } from '../helpers';

const WS = 'ws-1';
const FR = '/api/roadmarq/v1/requests/lite/FR-42';
const BG = '/api/roadmarq/v1/bugs/lite/BG-99';
const wsQs = { workspaceIdentifier: WS };

const find =
	(def: ResourceDef) =>
	(name: string): OperationDef => {
		const found = def.operations.find((o) => o.operation === name);
		if (!found) {
			throw new Error(`no operation ${name}`);
		}

		return found;
	};
const fr = find(featureRequest);
const bg = find(bug);

describe('registration', () => {
	it('registers featureRequest and bug as workspace-scoped resources', () => {
		expect(resources).toContain(featureRequest);
		expect(resources).toContain(bug);
		expect(featureRequest.value).toBe('featureRequest');
		expect(bug.value).toBe('bug');
		expect(featureRequest.workspaceScoped).toBe(true);
		expect(bug.workspaceScoped).toBe(true);
	});

	it('featureRequest has the eight operations, bug has the ten', () => {
		expect(featureRequest.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'create',
			'setStatus',
			'comment',
			'vote',
			'moderate',
			'delete',
		]);
		expect(bug.operations.map((o) => o.operation)).toEqual([
			'list',
			'get',
			'create',
			'setStatus',
			'setAssignee',
			'setVisibility',
			'toggleAffected',
			'comment',
			'moderate',
			'delete',
		]);
	});

	it('the board field is a required getBoards picker on list and create', () => {
		for (const o of [fr('list'), fr('create'), bg('list'), bg('create')]) {
			const board = o.fields.find((f) => f.name === 'board');
			expect(board?.typeOptions?.loadOptionsMethod).toBe('getBoards');
			expect(board?.required).toBe(true);
		}
	});

	it('single-item operations pick the short id from a list that depends on the board', () => {
		const check = (def: ResourceDef, loader: string) => {
			const singles = def.operations.filter((x) => !['list', 'create'].includes(x.operation));
			expect(singles.length).toBeGreaterThan(0);
			for (const o of singles) {
				const board = o.fields.find((f) => f.name === 'board');
				expect(board?.typeOptions?.loadOptionsMethod).toBe('getBoards');
				expect(board?.required).toBeFalsy();
				const id = o.fields.find((f) => f.name === 'shortId');
				expect(id?.typeOptions?.loadOptionsMethod).toBe(loader);
				expect(id?.typeOptions?.loadOptionsDependsOn).toEqual(['board']);
				expect(id?.required).toBe(true);
			}
		};
		check(featureRequest, 'getRequestShortIds');
		check(bug, 'getBugShortIds');
	});
});

describe('featureRequest', () => {
	it('list GETs the board requests with page/size paging, zero based, max 200', () => {
		const spec = fr('list').build!(reader({ board: 'feedback' }));
		expect(spec).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/feedback/requests/lite',
			qs: wsQs,
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'size',
				itemsPath: 'content',
				// The envelope's page count ends the walk without an extra empty request.
				totalPagesPath: 'totalPages',
				zeroBased: true,
				maxPageSize: 200,
			},
		});
		expect(fr('list').list).toBe(true);
	});

	it('list passes status, category and milestone names as query params', () => {
		const spec = fr('list').build!(
			reader({
				board: 'feedback',
				filters: { status: 'In Progress', category: 'UI', milestone: 'v2' },
			}),
		);
		expect(spec.qs).toEqual({
			...wsQs,
			status: 'In Progress',
			category: 'UI',
			milestone: 'v2',
		});
		expect(spec.paginate?.kind).toBe('page');
	});

	it('list with a search query is a single unpaged request that ignores the other filters', () => {
		const spec = fr('list').build!(
			reader({ board: 'feedback', filters: { q: 'dark', status: 'Open' } }),
		);
		expect(spec).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/feedback/requests/lite',
			qs: { ...wsQs, q: 'dark' },
		});
		expect(spec.paginate).toBeUndefined();
	});

	it('list encodes the board slug', () => {
		expect(fr('list').build!(reader({ board: 'a/b' })).path).toBe(
			'/api/roadmarq/v1/boards/a%2Fb/requests/lite',
		);
	});

	it('get puts the short id in the path and workspaceIdentifier in the query', () => {
		expect(fr('get').build!(reader({ shortId: 'FR-42' }))).toEqual({
			method: 'GET',
			path: FR,
			qs: wsQs,
		});
	});

	it('create POSTs title, description and category by name', () => {
		expect(
			fr('create').build!(
				reader({
					board: 'feedback',
					title: 'Dark mode toggle',
					additionalFields: { description: 'Add a dark theme.', category: 'UI' },
				}),
			),
		).toEqual({
			method: 'POST',
			path: '/api/roadmarq/v1/boards/feedback/requests/lite',
			qs: wsQs,
			body: { title: 'Dark mode toggle', description: 'Add a dark theme.', category: 'UI' },
		});
	});

	it('create with only a title sends only the title', () => {
		expect(
			fr('create').build!(reader({ board: 'feedback', title: 'T', additionalFields: {} })).body,
		).toEqual({ title: 'T' });
	});

	it('setStatus PATCHes the status name', () => {
		expect(fr('setStatus').build!(reader({ shortId: 'FR-42', status: 'In Progress' }))).toEqual({
			method: 'PATCH',
			path: `${FR}/status`,
			qs: wsQs,
			body: { status: 'In Progress' },
		});
	});

	it('comment POSTs content, the internal flag only when set', () => {
		expect(
			fr('comment').build!(reader({ shortId: 'FR-42', content: 'Hi', additionalFields: {} })),
		).toEqual({
			method: 'POST',
			path: `${FR}/comments`,
			qs: wsQs,
			body: { content: 'Hi' },
		});
		expect(
			fr('comment').build!(
				reader({ shortId: 'FR-42', content: 'Hi', additionalFields: { isInternal: true } }),
			).body,
		).toEqual({ content: 'Hi', isInternal: true, internal: true });
	});

	it('vote POSTs an empty body for a plain upvote and the emoji for a reaction', () => {
		expect(fr('vote').build!(reader({ shortId: 'FR-42', additionalFields: {} }))).toEqual({
			method: 'POST',
			path: `${FR}/votes`,
			qs: wsQs,
			body: {},
		});
		expect(
			fr('vote').build!(reader({ shortId: 'FR-42', additionalFields: { emoji: '\u{1F44D}' } }))
				.body,
		).toEqual({ emoji: '\u{1F44D}' });
	});

	it('moderate PATCHes the action', () => {
		expect(fr('moderate').build!(reader({ shortId: 'FR-42', action: 'approve' }))).toEqual({
			method: 'PATCH',
			path: `${FR}/moderation`,
			qs: wsQs,
			body: { action: 'approve' },
		});
	});

	it('moderate offers exactly approve, reject and spam', () => {
		const action = fr('moderate').fields.find((f) => f.name === 'action');
		expect(action?.options?.map((o) => ('value' in o ? o.value : undefined))).toEqual([
			'approve',
			'reject',
			'spam',
		]);
	});

	it('delete DELETEs the request', () => {
		expect(fr('delete').build!(reader({ shortId: 'FR-42' }))).toEqual({
			method: 'DELETE',
			path: FR,
			qs: wsQs,
		});
	});

	it('a short id typed with unusual characters is encoded in the path', () => {
		expect(fr('get').build!(reader({ shortId: 'FR/4 2' })).path).toBe(
			'/api/roadmarq/v1/requests/lite/FR%2F4%202',
		);
	});
});

describe('bug', () => {
	// Roadmarq PR #33: page (zero-based) and size (max 200) turn on the requests/lite envelope.
	it('list GETs the board bugs page by page: page/size, content envelope, totalPages', () => {
		const spec = bg('list').build!(reader({ board: 'feedback' }));
		expect(spec).toEqual({
			method: 'GET',
			path: '/api/roadmarq/v1/boards/feedback/bugs/lite',
			qs: wsQs,
			paginate: {
				kind: 'page',
				pageParam: 'page',
				sizeParam: 'size',
				itemsPath: 'content',
				totalPagesPath: 'totalPages',
				zeroBased: true,
				maxPageSize: 200,
			},
		});
		expect(bg('list').list).toBe(true);
	});

	it('list with Return All walks every page; with Limit it stops at the limit', async () => {
		const spec = bg('list').build!(reader({ board: 'feedback' }));
		const bugs = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({ shortId: `BG-${from + i}` }));
		const all = fakeContext([
			{ content: bugs(0, 200), pageNumber: 0, pageSize: 200, totalElements: 250, totalPages: 2 },
			{ content: bugs(200, 50), pageNumber: 1, pageSize: 200, totalElements: 250, totalPages: 2 },
		]);
		expect(await all.requestAll(spec)).toHaveLength(250);
		expect(all.calls.map((c) => c.qs)).toEqual([
			{ ...wsQs, page: 0, size: 200 },
			{ ...wsQs, page: 1, size: 200 },
		]);
		const limited = fakeContext([
			{ content: bugs(0, 200), pageNumber: 0, pageSize: 200, totalElements: 250, totalPages: 2 },
		]);
		expect(await limited.requestAll(spec, 5)).toEqual(bugs(0, 5));
		expect(limited.calls).toHaveLength(1);
	});

	it('list filters by severity and status name', () => {
		expect(
			bg('list').build!(
				reader({ board: 'feedback', filters: { severity: 'High', status: 'Triaged' } }),
			).qs,
		).toEqual({ ...wsQs, severity: 'High', status: 'Triaged' });
	});

	it('get puts the short id in the path', () => {
		expect(bg('get').build!(reader({ shortId: 'BG-99' }))).toEqual({
			method: 'GET',
			path: BG,
			qs: wsQs,
		});
	});

	it('create POSTs title plus the optional detail fields', () => {
		expect(
			bg('create').build!(
				reader({
					board: 'feedback',
					title: 'Login broken on Firefox',
					additionalFields: {
						severity: 'High',
						productArea: 'Auth',
						stepsToReproduce: 'Open login',
						expectedResult: 'Logs in',
						actualResult: 'Spinner',
						environment: '{"browser":"Firefox"}',
						isSecurity: true,
					},
				}),
			),
		).toEqual({
			method: 'POST',
			path: '/api/roadmarq/v1/boards/feedback/bugs/lite',
			qs: wsQs,
			body: {
				title: 'Login broken on Firefox',
				severity: 'High',
				productArea: 'Auth',
				stepsToReproduce: 'Open login',
				expectedResult: 'Logs in',
				actualResult: 'Spinner',
				environment: { browser: 'Firefox' },
				isSecurity: true,
				security: true,
			},
		});
	});

	/*
	 * Production (Jackson) binds the boolean flags of these lite requests by their bean names
	 * (security, internal, public) and silently ignores isSecurity/isInternal/isPublic. The catalog
	 * lists both names, so both are sent.
	 */
	it('create sends the security flag under both catalog names', () => {
		expect(
			bg('create').build!(reader({ board: 'b', title: 'T', additionalFields: { isSecurity: false } }))
				.body,
		).toEqual({ title: 'T', isSecurity: false, security: false });
	});

	it('create accepts the environment as an object and rejects invalid JSON', () => {
		const build = (environment: unknown) =>
			bg('create').build!(reader({ board: 'b', title: 'T', additionalFields: { environment } }));
		expect(build({ os: 'win' }).body).toEqual({ title: 'T', environment: { os: 'win' } });
		expect(() => build('{nope')).toThrow(/Environment/);
	});

	it('setStatus PATCHes the status name', () => {
		expect(bg('setStatus').build!(reader({ shortId: 'BG-99', status: 'Triaged' }))).toEqual({
			method: 'PATCH',
			path: `${BG}/status`,
			qs: wsQs,
			body: { status: 'Triaged' },
		});
	});

	it('setAssignee sends assigneeEmail for a picked member', () => {
		expect(
			bg('setAssignee').build!(
				reader({ shortId: 'BG-99', assigneeEmail: 'alice@dutify.ai', assigneeId: '' }),
			),
		).toEqual({
			method: 'PATCH',
			path: `${BG}/assignee`,
			qs: wsQs,
			body: { assigneeEmail: 'alice@dutify.ai' },
		});
	});

	it('setAssignee sends assigneeId for a UUID', () => {
		const id = '11111111-2222-3333-4444-555555555555';
		expect(
			bg('setAssignee').build!(reader({ shortId: 'BG-99', assigneeEmail: '', assigneeId: id }))
				.body,
		).toEqual({ assigneeId: id });
	});

	it('setAssignee with neither unassigns (empty body)', () => {
		expect(
			bg('setAssignee').build!(reader({ shortId: 'BG-99', assigneeEmail: '', assigneeId: '' }))
				.body,
		).toEqual({});
	});

	it('setAssignee refuses both an email and a UUID before any request', () => {
		expect(() =>
			bg('setAssignee').build!(
				reader({ shortId: 'BG-99', assigneeEmail: 'a@b.c', assigneeId: 'x' }),
			),
		).toThrow(/either/i);
	});

	it('setAssignee picks the email from workspace members', () => {
		const f = bg('setAssignee').fields.find((x) => x.name === 'assigneeEmail');
		expect(f?.typeOptions?.loadOptionsMethod).toBe('getMembers');
		expect(f?.required).toBeFalsy();
	});

	it('setVisibility PATCHes isPublic and public (production binds only public)', () => {
		expect(bg('setVisibility').build!(reader({ shortId: 'BG-99', isPublic: false }))).toEqual({
			method: 'PATCH',
			path: `${BG}/visibility`,
			qs: wsQs,
			body: { isPublic: false, public: false },
		});
	});

	it('toggleAffected POSTs with no body', () => {
		expect(bg('toggleAffected').build!(reader({ shortId: 'BG-99' }))).toEqual({
			method: 'POST',
			path: `${BG}/affected`,
			qs: wsQs,
		});
	});

	it('comment POSTs content and the internal flag', () => {
		expect(
			bg('comment').build!(
				reader({ shortId: 'BG-99', content: 'Seen too', additionalFields: { isInternal: true } }),
			),
		).toEqual({
			method: 'POST',
			path: `${BG}/comments`,
			qs: wsQs,
			body: { content: 'Seen too', isInternal: true, internal: true },
		});
	});

	it('moderate PATCHes the action', () => {
		expect(bg('moderate').build!(reader({ shortId: 'BG-99', action: 'spam' }))).toEqual({
			method: 'PATCH',
			path: `${BG}/moderation`,
			qs: wsQs,
			body: { action: 'spam' },
		});
	});

	it('delete DELETEs the bug', () => {
		expect(bg('delete').build!(reader({ shortId: 'BG-99' }))).toEqual({
			method: 'DELETE',
			path: BG,
			qs: wsQs,
		});
	});
});

describe('name pickers', () => {
	const loaderOf = (o: OperationDef, field: string, inCollection?: string) => {
		const top = o.fields.find((f) => f.name === (inCollection ?? field));
		const f = inCollection
			? (top?.options as Array<{ name: string; typeOptions?: Record<string, unknown> }>).find(
					(x) => x.name === field,
				)
			: top;

		return {
			loader: f?.typeOptions?.loadOptionsMethod,
			deps: f?.typeOptions?.loadOptionsDependsOn,
		};
	};

	it.each([
		[fr('list'), 'status', 'filters', 'getRequestStatuses'],
		[fr('list'), 'category', 'filters', 'getRequestCategories'],
		[fr('list'), 'milestone', 'filters', 'getMilestones'],
		[fr('create'), 'category', 'additionalFields', 'getRequestCategories'],
		[fr('setStatus'), 'status', undefined, 'getRequestStatuses'],
		[bg('list'), 'status', 'filters', 'getBugStatuses'],
		[bg('list'), 'severity', 'filters', 'getSeverityLevels'],
		[bg('create'), 'severity', 'additionalFields', 'getSeverityLevels'],
		[bg('create'), 'productArea', 'additionalFields', 'getProductAreas'],
		[bg('setStatus'), 'status', undefined, 'getBugStatuses'],
	])('%# is a board-dependent picker', (o, field, collectionName, loader) => {
		expect(loaderOf(o, field, collectionName)).toEqual({ loader, deps: ['board'] });
	});

	it('a typed status name still reaches the request', () => {
		expect(
			fr('setStatus').build!(reader({ shortId: 'FR-42', status: 'Some Custom Status' })).body,
		).toEqual({ status: 'Some Custom Status' });
	});
});

/*
 * Roadmarq Board > Update (PR #33): PUT /api/roadmarq/v1/boards/{boardId} changes only what the
 * body carries, and `settings` is merged field by field. So the node sends only the fields the
 * user set, and a switch set to off is sent as false.
 */
describe('Roadmarq Board update', () => {
	const update = roadmarqBoard.operations.find((o) => o.operation === 'update')!;
	const BOARD_ID = '57f6a1d2-0000-4000-8000-000000000001';
	const boards = [
		{ id: '11111111-0000-4000-8000-000000000000', slug: 'other' },
		{ id: BOARD_ID, slug: 'feedback' },
	];
	const updated = { id: BOARD_ID, slug: 'feedback', settings: { bugApprovalMode: 'none' } };
	const runUpdate = async (updateFields: Record<string, unknown>) => {
		const ctx = fakeContext([boards, updated]);
		const out = await update.run!(ctx, reader({ board: 'feedback', updateFields }));

		return { ctx, out };
	};

	it('is a workspace-scoped resource with Update, named Roadmarq Board', () => {
		expect(resources).toContain(roadmarqBoard);
		expect(roadmarqBoard.workspaceScoped).toBe(true);
		expect(roadmarqBoard.name).toBe('Roadmarq Board');
		expect(roadmarqBoard.operations.map((o) => o.operation)).toEqual(['update']);
		const board = update.fields.find((f) => f.name === 'board');
		expect(board?.typeOptions?.loadOptionsMethod).toBe('getBoards');
		expect(board?.required).toBe(true);
	});

	it("finds the board's UUID by slug, then PUTs only the one setting that was set", async () => {
		const { ctx, out } = await runUpdate({ bugApprovalMode: 'none' });
		expect(ctx.calls).toEqual([
			{ method: 'GET', path: '/api/roadmarq/v1/boards', qs: wsQs },
			{
				method: 'PUT',
				path: `/api/roadmarq/v1/boards/${BOARD_ID}`,
				qs: wsQs,
				body: { settings: { bugApprovalMode: 'none' } },
			},
		]);
		expect(out).toEqual([{ json: updated }]);
	});

	it('sends a switch turned off as false, and leaves the other switches out', async () => {
		const { ctx } = await runUpdate({ bugReports: false, requireApproval: false });
		expect(ctx.calls[1].body).toEqual({
			settings: { bugReportsEnabled: false, requireApproval: false },
		});
	});

	it('maps every switch to its board setting', async () => {
		const { ctx } = await runUpdate({
			featureRequests: true,
			bugReports: true,
			roadmap: false,
			changelog: true,
			requireApproval: true,
			bugApprovalMode: 'anonymous_only',
		});
		expect(ctx.calls[1].body).toEqual({
			settings: {
				featureRequestsEnabled: true,
				bugReportsEnabled: true,
				roadmapEnabled: false,
				changelogEnabled: true,
				requireApproval: true,
				bugApprovalMode: 'anonymous_only',
			},
		});
	});

	it('sends name, description and public at the top level, and no settings when none were set', async () => {
		const { ctx } = await runUpdate({ name: 'Ideas', description: 'All ideas', isPublic: false });
		expect(ctx.calls[1].body).toEqual({ name: 'Ideas', description: 'All ideas', isPublic: false });
	});

	it('refuses an update that sets nothing, before any request', async () => {
		const ctx = fakeContext([]);
		await expect(
			update.run!(ctx, reader({ board: 'feedback', updateFields: {} })),
		).rejects.toThrow(/at least one field/);
		expect(ctx.calls).toEqual([]);
	});

	it('refuses a slug the board list does not have', async () => {
		const ctx = fakeContext([boards]);
		await expect(
			update.run!(ctx, reader({ board: 'nope', updateFields: { bugReports: true } })),
		).rejects.toThrow(/nope/);
		expect(ctx.calls).toHaveLength(1);
	});

	it('offers the three bug approval modes', () => {
		const fields = update.fields.find((f) => f.name === 'updateFields')?.options as Array<{
			name: string;
			options?: Array<{ value: string }>;
		}>;
		const mode = fields.find((f) => f.name === 'bugApprovalMode');
		expect(mode?.options?.map((o) => o.value)).toEqual(['all', 'anonymous_only', 'none']);
	});
});
