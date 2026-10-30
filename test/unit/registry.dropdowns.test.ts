import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { buildProperties, resources } from '../../nodes/Dutify/registry';

// n8n caches a dropdown's options until a parameter named in loadOptionsDependsOn changes.
// A dropdown that lists the workspace's spaces, lists or members therefore has to name the
// workspace, or it keeps the empty list it loaded before a workspace was chosen.
function dropdowns(props: INodeProperties[]): INodeProperties[] {
	return props.flatMap((p) => {
		const own = p.typeOptions?.loadOptionsMethod ? [p] : [];
		const nested = (p.options ?? []).flatMap((o) =>
			'values' in o
				? dropdowns(o.values as INodeProperties[])
				: 'type' in o
					? dropdowns([o as INodeProperties])
					: [],
		);

		return [...own, ...nested];
	});
}

describe('dropdowns that load from a workspace', () => {
	const scoped = new Set(resources.filter((r) => r.workspaceScoped).map((r) => r.value));
	const props = buildProperties(resources).filter((p) =>
		(p.displayOptions?.show?.resource as string[] | undefined)?.some((r) => scoped.has(r)),
	);
	const loaders = dropdowns(props);

	it('finds the workspace-scoped dropdowns', () => {
		expect(loaders.length).toBeGreaterThan(10);
	});

	it.each(loaders.map((p) => [`${p.name} (${String(p.typeOptions?.loadOptionsMethod)})`, p]))(
		'%s reloads when the workspace changes',
		(_label, p) => {
			expect(p.typeOptions?.loadOptionsDependsOn ?? []).toContain('workspace.value');
		},
	);

	it('keeps the dependencies a dropdown already had', () => {
		const statuses = loaders.find((p) => p.typeOptions?.loadOptionsMethod === 'getStatuses');
		expect(statuses?.typeOptions?.loadOptionsDependsOn).toEqual(
			expect.arrayContaining(['space', 'list', 'workspace.value']),
		);
	});
});
