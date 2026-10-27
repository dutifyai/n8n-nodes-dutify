/**
 * A public HTTPS endpoint for live trigger tests: a local HTTP receiver that records every
 * request, exposed through an ngrok tunnel so production Dutify can deliver to it.
 *
 * Only the processes started here are stopped (by their handle), never anything else.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/no-dangerous-functions --
   test-only code (not published): the tunnel needs a local server and the ngrok process. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sleep } from 'n8n-workflow';

export const NGROK_EXE =
	process.env.NGROK_EXE || 'D:\\Program Files\\ngrok-v3-stable-windows-amd64\\ngrok.exe';

/** One request the receiver got, exactly as it arrived. */
export interface ReceivedRequest {
	method: string;
	path: string;
	/** Lowercase names, as Node (and n8n) hand them over. */
	headers: IncomingHttpHeaders;
	rawBody: Buffer;
	receivedAt: number;
}

export interface Receiver {
	port: number;
	requests: ReceivedRequest[];
	/** Waits until a request to `path` matches `accept`, and returns it. */
	waitFor(
		path: string,
		accept: (req: ReceivedRequest) => boolean,
		timeoutMs?: number,
	): Promise<ReceivedRequest>;
	close(): Promise<void>;
}

/** Starts the receiver on 127.0.0.1 at a free port. Every request is answered 200. */
export async function startReceiver(): Promise<Receiver> {
	const requests: ReceivedRequest[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			requests.push({
				method: req.method ?? '',
				path: (req.url ?? '').split('?')[0],
				headers: req.headers,
				rawBody: Buffer.concat(chunks),
				receivedAt: Date.now(),
			});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"received":true}');
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const port = (server.address() as AddressInfo).port;

	return {
		port,
		requests,
		async waitFor(path, accept, timeoutMs = 120_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = requests.find((r) => r.path === path && accept(r));
				if (found) {
					return found;
				}
				if (Date.now() > deadline) {
					const seen = requests
						.filter((r) => r.path === path)
						.map((r) => r.rawBody.toString('utf8').slice(0, 300));
					throw new Error(
						`no matching delivery to ${path} within ${timeoutMs / 1000}s; got ${seen.length}: ${JSON.stringify(seen)}`,
					);
				}
				await sleep(1000);
			}
		},
		async close() {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

export interface Tunnel {
	/** The https:// public URL that forwards to the receiver. */
	publicUrl: string;
	/** The ngrok process this tunnel started. */
	pid: number | undefined;
	stop(): Promise<void>;
}

interface NgrokTunnel {
	public_url?: string;
	proto?: string;
	config?: { addr?: string };
}

/**
 * Starts ngrok for `port` and reads the public URL from ngrok's local API (the address ngrok
 * logs for its web service, http://127.0.0.1:4040 by default).
 */
export async function startTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
	if (!existsSync(NGROK_EXE)) {
		throw new Error(`ngrok not found at ${NGROK_EXE}`);
	}
	const child: ChildProcess = spawn(
		NGROK_EXE,
		['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json'],
		{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
	);
	let webAddr = '';
	let lastError = '';
	let exited = false;
	child.on('exit', () => {
		exited = true;
	});
	const onLine = (line: string) => {
		try {
			const entry = JSON.parse(line) as { msg?: string; addr?: string; err?: string; lvl?: string };
			if (entry.msg === 'starting web service' && entry.addr) {
				webAddr = entry.addr;
			}
			if (entry.lvl === 'eror' || entry.lvl === 'crit') {
				lastError = `${entry.msg ?? ''} ${entry.err ?? ''}`.trim();
			}
		} catch {
			// not a JSON log line
		}
	};
	let buffered = '';
	child.stdout?.on('data', (chunk: Buffer) => {
		buffered += chunk.toString('utf8');
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? '';
		lines.forEach(onLine);
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		lastError = chunk.toString('utf8').trim();
	});

	const stop = async () => {
		if (exited || child.exitCode !== null) {
			return;
		}
		const gone = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
		child.kill();
		await Promise.race([gone, sleep(5000)]);
	};

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(`ngrok exited: ${lastError || 'no output'}`);
		}
		if (webAddr) {
			try {
				const res = await fetch(`http://${webAddr}/api/tunnels`);
				const body = (await res.json()) as { tunnels?: NgrokTunnel[] };
				const tunnel = (body.tunnels ?? []).find(
					(t) =>
						t.proto === 'https' &&
						typeof t.public_url === 'string' &&
						String(t.config?.addr ?? '').endsWith(`:${port}`),
				);
				if (tunnel?.public_url) {
					return { publicUrl: tunnel.public_url, pid: child.pid, stop };
				}
			} catch {
				// the API is not up yet
			}
		}
		await sleep(500);
	}
	await stop();
	throw new Error(`ngrok gave no public URL within ${timeoutMs / 1000}s: ${lastError}`);
}
