import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	cleanupStack,
	liveDescribe,
	loadOptionsOf,
	run,
	runOne,
	runOperation,
	runId,
	storageOutage,
	wikiKey,
} from './harness';
import { engineEnabled } from './engine';

/** About 300 KB of random bytes: big enough that a broken body encoding would show. */
const FILE = randomBytes(300 * 1024 + 17);

liveDescribe('Codexum attachment — live', () => {
	const cleanup = cleanupStack();
	const key = wikiKey('NA');
	let pageId = '';
	let attachmentId = '';

	beforeAll(async () => {
		await runOne('codexumSpace', 'create', { key, name: `n8n-live files ${runId}` });
		cleanup.add(
			`wiki space ${key}`,
			async () => await runOne('codexumSpace', 'delete', { space: key }),
		);
		await runOne('codexumPage', 'create', { space: key, title: `Files ${runId}` });
		const ids = await loadOptionsOf('getWikiPageIds', { space: key });
		expect(ids).toHaveLength(1);
		pageId = String(ids[0].value);
	});
	afterAll(async () => await cleanup.run());

	it('upload PUTs a 300 KB binary to storage with its Content-Type and confirms it', async () => {
		const [item] = await runOperation(
			'codexumAttachment',
			'upload',
			{ space: key, pageId, binaryPropertyName: 'data' },
			{ property: 'data', data: FILE, mimeType: 'application/pdf', fileName: `live-${runId}.pdf` },
		);
		const confirmed = item.json as Record<string, unknown>;
		attachmentId = String(confirmed.id ?? confirmed.attachmentId);
		expect(attachmentId).toMatch(/\S/);
		expect(JSON.stringify(confirmed)).toContain(`live-${runId}.pdf`);
		cleanup.add(
			`attachment ${attachmentId}`,
			async () => await runOne('codexumAttachment', 'delete', { space: key, pageId, attachmentId }),
		);
		expect(confirmed).toMatchObject({
			status: 'confirmed',
			contentType: 'application/pdf',
			sizeBytes: FILE.length,
		});
		const download = await fetch(String(confirmed.downloadUrl));
		expect(download.status).toBe(200);
		expect(Buffer.from(await download.arrayBuffer()).equals(FILE)).toBe(true);
	});

	it('list and the attachment picker show it with its size', async () => {
		const rows = await run('codexumAttachment', 'list', { space: key, pageId });
		const row = rows.find((r) => String(r.id ?? r.attachmentId) === attachmentId);
		expect(row).toBeDefined();
		expect(JSON.stringify(row)).toContain(String(FILE.length));
		const options = await loadOptionsOf('getWikiAttachments', { space: key, pageId });
		expect(options.map((o) => String(o.value))).toContain(attachmentId);
	});

	// The outage is simulated inside the emulated runtime, which engine mode does not use.
	it.skipIf(engineEnabled)('a failed storage PUT leaves no pending attachment behind', async () => {
		storageOutage.active = true;
		try {
			await expect(
				runOperation(
					'codexumAttachment',
					'upload',
					{ space: key, pageId },
					{ property: 'data', data: FILE, mimeType: 'text/plain', fileName: `fail-${runId}.txt` },
				),
			).rejects.toThrow();
		} finally {
			storageOutage.active = false;
		}
		const rows = await run('codexumAttachment', 'list', { space: key, pageId });
		expect(JSON.stringify(rows)).not.toContain(`fail-${runId}.txt`);
	});

	it('delete removes it from the list', async () => {
		await runOne('codexumAttachment', 'delete', { space: key, pageId, attachmentId });
		const rows = await run('codexumAttachment', 'list', { space: key, pageId });
		expect(rows.map((r) => String(r.id ?? r.attachmentId))).not.toContain(attachmentId);
	});
});
