import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	createTestSpace,
	liveDescribe,
	loadOptionsOf,
	run,
	runError,
	runOne,
	runId,
} from './harness';

liveDescribe('view and dashboard widgets — live', () => {
	const cleanup = cleanupStack();
	let space: { identifier: string; name: string };
	let listId = '';
	let otherListId = '';
	const atList = () => ({ scope: 'list', scopeListId: listId });
	const atSpace = () => ({ scope: 'space', scopeSpaceId: space.identifier });

	beforeAll(async () => {
		space = await createTestSpace(cleanup, 'view');
		listId = String(
			(await runOne('list', 'create', { space: space.name, name: `Views ${runId}` })).identifier,
		);
		otherListId = String(
			(await runOne('list', 'create', { space: space.name, name: `Views copy ${runId}` }))
				.identifier,
		);
	});
	afterAll(async () => await cleanup.run());

	function track(view: string) {
		cleanup.add(`view ${view}`, async () => await runOne('view', 'delete', { ...atList(), view }));
	}

	it('list view: create, list, picker, get, update, clone, delete', async () => {
		const created = await runOne('view', 'create', {
			...atList(),
			name: `Board ${runId}`,
			type: 'board',
			additionalFields: { groupBy: 'status' },
		});
		expect(created).toMatchObject({ name: `Board ${runId}` });
		const view = String(created.identifier);
		track(view);

		const listed = await run('view', 'list', { ...atList(), returnAll: true });
		expect(listed.map((v) => v.identifier)).toContain(view);
		const options = await loadOptionsOf('getViews', atList());
		expect(options.map((o) => o.value)).toContain(view);

		expect(await runOne('view', 'get', { ...atList(), view })).toMatchObject({ identifier: view });
		const updated = await runOne('view', 'update', {
			...atList(),
			view,
			updateFields: { name: `Board renamed ${runId}` },
		});
		expect(updated).toMatchObject({ name: `Board renamed ${runId}` });

		const copy = await runOne('view', 'clone', {
			...atList(),
			view,
			targetScope: 'list',
			targetListId: otherListId,
			additionalFields: { name: `Board copy ${runId}` },
		});
		expect(copy).toMatchObject({ name: `Board copy ${runId}` });
		cleanup.add(
			`view ${String(copy.identifier)}`,
			async () =>
				await runOne('view', 'delete', {
					scope: 'list',
					scopeListId: otherListId,
					view: String(copy.identifier),
				}),
		);

		expect(await runOne('view', 'delete', { ...atList(), view })).toEqual({ success: true });
		const gone = await runError('view', 'get', { ...atList(), view });
		expect(gone.httpCode).toBe('404');
	});

	it("dashboard widgets on the test space's own dashboard: preset, add, update, list, remove", async () => {
		// A FREE workspace may hold one extra dashboard at most, but every space comes with a
		// mandatory one. That dashboard belongs to the test space, which cleanup deletes.
		const views = await run('view', 'list', { ...atSpace(), returnAll: true });
		const dashboard = views.find((v) => v.type === 'dashboard');
		expect(dashboard).toBeDefined();
		const view = String(dashboard?.identifier);

		const preset = await runOne('view', 'addWidgetFromPreset', {
			...atSpace(),
			view,
			preset: 'activity-feed', // status-distribution is a PRO distribution chart
			additionalFields: { title: `Statuses ${runId}` },
		});
		expect(preset).toMatchObject({ title: `Statuses ${runId}` });

		const widget = await runOne('view', 'addWidget', {
			...atSpace(),
			view,
			widgetType: 'progress-overview', // distribution-chart needs PRO
			additionalFields: { title: `Custom ${runId}`, w: 6, h: 4 },
		});
		const widgetId = String(widget.id); // WidgetConfig carries `id`

		const widgetOptions = await loadOptionsOf('getWidgets', { ...atSpace(), view });
		expect(widgetOptions.map((o) => o.value)).toContain(widgetId);

		const updated = await runOne('view', 'updateWidget', {
			...atSpace(),
			view,
			widget: widgetId,
			updateFields: { title: `Custom renamed ${runId}` },
		});
		expect(updated).toMatchObject({ title: `Custom renamed ${runId}` });

		const widgets = await run('view', 'listWidgets', { ...atSpace(), view });
		expect(widgets.map((w) => w.id)).toEqual(
			expect.arrayContaining([String(preset.id), widgetId]),
		);

		expect(
			await runOne('view', 'removeWidget', { ...atSpace(), view, widget: widgetId }),
		).toEqual({ success: true });
		const after = await run('view', 'listWidgets', { ...atSpace(), view });
		expect(after.map((w) => w.id)).not.toContain(widgetId);
	});
});
