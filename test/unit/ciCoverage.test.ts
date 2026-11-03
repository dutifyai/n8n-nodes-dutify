/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals --
   test-only code (not published): the workflows and the test tree are read from disk. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// No test may sit where CI does not run it: the unit tests run on every pull
// request and before every release; the live tests write to production and
// stay manual, by decision.
const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function testFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
		if (statSync(path).isDirectory()) return testFiles(path);
		return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? [relative(root, path)] : [];
	});
}

describe('CI coverage', () => {
	it('runs the unit tests on every pull request and push to main', () => {
		const ci = read('.github/workflows/ci.yml');
		expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
		expect(ci).toMatch(/^ {6}- run: npm test$/m);
		expect(JSON.parse(read('package.json')).scripts.test).toBe('vitest run test/unit');
	});

	it('runs the unit tests before every release', () => {
		expect(read('.github/workflows/publish.yml')).toMatch(/run: 'npm test'/);
	});

	it('keeps every test file in test/unit or test/live', () => {
		const stray = testFiles(root).filter((f) => !/^test\/(unit|live)\//.test(f.split('\\').join('/')));
		expect(stray).toEqual([]);
	});
});
