import { expect, it } from 'vitest';
import { liveDescribe, loadOptionsOf, run, runError, runOne, runId } from './harness';

/*
 * The test user has no calls, and an API key cannot create one: Hub's ApiKeyScopeFilter
 * (origin/master) does not expose /api/videos to API keys, so POST /api/videos/upload-session
 * answers 403 "Endpoint is not exposed to API keys". Per the Task 16 rulings the recording and
 * Lens live tests are skipped; the call operations are checked against the empty account.
 */
liveDescribe('Hub call — live', () => {
	it('list (light and full rows), count, search and countSearch agree on an empty account', async () => {
		const lite = await run('call', 'list', { returnAll: true });
		const full = await run('call', 'list', { returnAll: true, additionalFields: { lite: false } });
		const count = await runOne('call', 'count');
		expect(lite).toEqual([]);
		expect(full).toEqual([]);
		expect(JSON.stringify(count)).toMatch(/\b0\b/);

		const found = await run('call', 'search', { query: `n8n live ${runId}`, limit: 5 });
		expect(found).toEqual([]);
		const counted = await runOne('call', 'countSearch', { query: `n8n live ${runId}` });
		expect(JSON.stringify(counted)).toMatch(/\b0\b/);
	});

	it('the call and recording pickers answer with empty lists', async () => {
		expect(await loadOptionsOf('getHubCalls')).toEqual([]);
		expect(await loadOptionsOf('getHubRecordings')).toEqual([]);
	});

	it('get of an unknown call and the status of an unknown recording answer 404', async () => {
		const call = await runError('call', 'get', { call: '00000000-0000-0000-0000-000000000000' });
		expect(call.httpCode).toBe('404');
		const recording = await runError('recording', 'getProcessingStatus', {
			recording: '00000000-0000-0000-0000-000000000000',
		});
		expect(recording.httpCode).toBe('404');
	});
});
