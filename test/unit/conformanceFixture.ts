/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals --
   test-only code (not published): the conformance fixture is read from disk. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PM's webhook signing conformance fixture (a copy of dutify-pm
 * `src/test/resources/webhooks/conformance/`): a fixed envelope, the secret, and the
 * `X-Webhook-Signature-256` header PM computes for it. The envelope is the raw signed bytes.
 */
export function conformanceFixture(): { envelope: Buffer; secret: string; signature: string } {
	const dir = join(__dirname, 'fixtures', 'conformance');

	return {
		envelope: readFileSync(join(dir, 'envelope.json')),
		secret: readFileSync(join(dir, 'secret.txt'), 'utf8').trim(),
		signature: readFileSync(join(dir, 'signature.txt'), 'utf8').trim(),
	};
}
