import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** The broker relay's socket inside a shell or desktop namespace. */
export const COMPANY_COMPUTER_SHELL_RELAY_PATH = "/run/qorpera-network/egress.sock";
/** Loopback proxy port inside the namespace's own, otherwise empty, network. */
export const COMPANY_COMPUTER_SHELL_PROXY_PORT = 3128;
/** The office code's copy of this module inside the image (the browser child entry). */
export const COMPANY_COMPUTER_NAMESPACE_CHILD = "/usr/local/lib/qorpera/office-browser-child.mjs";
/** One control line in either direction; an output line carries at most 64 KiB of bytes. */
export const COMPANY_COMPUTER_SHELL_LINE_LIMIT = 262144;

/** Proxy settings for programs in a shell or desktop namespace. Local names bypass the proxy. */
export function companyComputerShellProxyEnvironment(): Record<string, string> {
	const proxy = `http://127.0.0.1:${COMPANY_COMPUTER_SHELL_PROXY_PORT}`;
	const local = "localhost,127.0.0.1,::1";
	return {
		http_proxy: proxy,
		https_proxy: proxy,
		HTTP_PROXY: proxy,
		HTTPS_PROXY: proxy,
		no_proxy: local,
		NO_PROXY: local,
		// Node's own fetch ignores the variables above unless asked.
		NODE_USE_ENV_PROXY: "1",
	};
}

/** Service to shell namespace. `data` is base64. */
export type CompanyComputerShellHostRequest =
	| { t: "start"; id: string; command: string }
	| { t: "write"; id: string; data: string; end: boolean }
	| { t: "stop"; id: string };

/** Shell namespace to service. Untrusted: anything in the namespace can write these. */
export type CompanyComputerShellHostEvent =
	| { t: "ready" }
	| { t: "started"; id: string }
	| { t: "failed"; id: string }
	| { t: "out"; id: string; data: string }
	| { t: "exit"; id: string; code: number | null; signal: string | null }
	| { t: "procs"; count: number };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fields(value: unknown, expected: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected)
		throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
	return value as Record<string, unknown>;
}

export function parseCompanyComputerShellHostEvent(line: string): CompanyComputerShellHostEvent {
	if (line.length > COMPANY_COMPUTER_SHELL_LINE_LIMIT) throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
	const value: unknown = JSON.parse(line);
	const type = (value as { t?: unknown } | null)?.t;
	const id = (input: Record<string, unknown>): string => {
		if (typeof input.id !== "string" || !ID.test(input.id)) throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
		return input.id;
	};
	if (type === "ready") {
		fields(value, "t");
		return { t: "ready" };
	}
	if (type === "started" || type === "failed") return { t: type, id: id(fields(value, "id,t")) };
	if (type === "out") {
		const input = fields(value, "data,id,t");
		if (typeof input.data !== "string" || input.data.length > 90000 || !BASE64.test(input.data))
			throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
		return { t: "out", id: id(input), data: input.data };
	}
	if (type === "exit") {
		const input = fields(value, "code,id,signal,t");
		if (
			(input.code !== null &&
				(!Number.isSafeInteger(input.code) || (input.code as number) < 0 || (input.code as number) > 255)) ||
			(input.signal !== null && (typeof input.signal !== "string" || !/^SIG[A-Z0-9]{1,12}$/.test(input.signal)))
		)
			throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
		return { t: "exit", id: id(input), code: input.code as number | null, signal: input.signal as string | null };
	}
	if (type === "procs") {
		const input = fields(value, "count,t");
		if (!Number.isSafeInteger(input.count) || (input.count as number) < 0 || (input.count as number) > 1_000_000)
			throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
		return { t: "procs", count: input.count as number };
	}
	throw new Error("INVALID_OFFICE_SHELL_MESSAGE");
}

function parseRequest(line: string): CompanyComputerShellHostRequest | undefined {
	try {
		const value: unknown = JSON.parse(line);
		const type = (value as { t?: unknown } | null)?.t;
		if (type === "start") {
			const input = fields(value, "command,id,t");
			if (typeof input.id === "string" && ID.test(input.id) && typeof input.command === "string")
				return { t: "start", id: input.id, command: input.command };
		} else if (type === "write") {
			const input = fields(value, "data,end,id,t");
			if (
				typeof input.id === "string" &&
				ID.test(input.id) &&
				typeof input.data === "string" &&
				BASE64.test(input.data) &&
				typeof input.end === "boolean"
			)
				return { t: "write", id: input.id, data: input.data, end: input.end };
		} else if (type === "stop") {
			const input = fields(value, "id,t");
			if (typeof input.id === "string" && ID.test(input.id)) return { t: "stop", id: input.id };
		}
	} catch {
		/* A malformed line is dropped; the service only ever sends well-formed ones. */
	}
	return undefined;
}

/** Split a byte stream into lines, refusing any line past the limit. */
function lines(stream: Readable, onLine: (line: string) => void, onOverflow: () => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (text: string) => {
		buffer += text;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
			newline = buffer.indexOf("\n");
		}
		if (buffer.length > COMPANY_COMPUTER_SHELL_LINE_LIMIT) {
			buffer = "";
			onOverflow();
		}
	});
}

/**
 * Loopback HTTP proxy port inside a namespace whose only way out is the Unix
 * relay: each connection is piped to it unchanged. The relay decides where a
 * connection may go; this listener holds no authority.
 */
export async function listenCompanyComputerShellProxy(relayPath: string, port: number): Promise<Server> {
	const server = createServer((peer) => {
		const upstream = createConnection(relayPath);
		const close = (): void => {
			peer.destroy();
			upstream.destroy();
		};
		for (const socket of [peer, upstream]) {
			socket.on("error", close);
			socket.once("close", close);
		}
		peer.pipe(upstream);
		upstream.pipe(peer);
	});
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			ready();
		});
	});
	return server;
}

/** Processes in this PID namespace other than its init and this host. */
async function countNamespaceProcesses(): Promise<number> {
	const entries = await readdir("/proc");
	return entries.filter((name) => /^[0-9]+$/.test(name) && name !== "1" && name !== String(process.pid)).length;
}

/**
 * The shell namespace's own init process (under Tini). It keeps the loopback
 * proxy, starts each command in a process group of its own, and streams its
 * output. It runs as the same account as every command, so it holds nothing a
 * command may not see: the service treats all it reports as untrusted data.
 */
export async function runCompanyComputerShellHost(options: {
	input: Readable;
	output: Writable;
	relayPath?: string;
	port?: number;
	countProcesses?: () => Promise<number>;
	processIntervalMs?: number;
	/** The image's Bash; a local proof on another system names its own. */
	bash?: string;
}): Promise<void> {
	const bash = options.bash ?? "/usr/bin/bash";
	const proxy = await listenCompanyComputerShellProxy(
		options.relayPath ?? COMPANY_COMPUTER_SHELL_RELAY_PATH,
		options.port ?? COMPANY_COMPUTER_SHELL_PROXY_PORT,
	).catch(() => undefined);
	const children = new Map<string, ChildProcess>();
	const count = options.countProcesses ?? countNamespaceProcesses;
	let blocked = false;
	const paused = new Set<Readable>();
	const send = (event: CompanyComputerShellHostEvent): void => {
		if (!options.output.write(`${JSON.stringify(event)}\n`) && !blocked) {
			blocked = true;
			for (const child of children.values())
				for (const stream of [child.stdout, child.stderr])
					if (stream && !stream.isPaused()) {
						stream.pause();
						paused.add(stream);
					}
		}
	};
	options.output.on("drain", () => {
		blocked = false;
		for (const stream of paused) stream.resume();
		paused.clear();
	});
	options.output.on("error", () => undefined);
	const start = (id: string, command: string): void => {
		if (children.has(id)) return;
		// The control descriptors 3 and 4 stay with this host: the command's own
		// shell closes them before it runs anything.
		const child = spawn(
			bash,
			[
				"--noprofile",
				"--norc",
				"-c",
				'exec 3<&- 4>&-; exec "$1" --noprofile --norc -c "$2"',
				"qorpera-shell",
				bash,
				command,
			],
			{ cwd: process.cwd(), env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
		);
		children.set(id, child);
		let spawned = false;
		child.once("spawn", () => {
			spawned = true;
			send({ t: "started", id });
		});
		child.stdin!.on("error", () => undefined);
		for (const stream of [child.stdout!, child.stderr!]) {
			stream.on("data", (bytes: Buffer) => {
				for (let offset = 0; offset < bytes.length; offset += 65536)
					send({ t: "out", id, data: bytes.subarray(offset, offset + 65536).toString("base64") });
				if (blocked && !stream.isPaused()) {
					stream.pause();
					paused.add(stream);
				}
			});
		}
		child.once("error", () => {
			if (!spawned) {
				children.delete(id);
				send({ t: "failed", id });
			}
		});
		child.once("close", (code, signal) => {
			children.delete(id);
			if (spawned) send({ t: "exit", id, code, signal });
		});
	};
	const stop = (id: string): void => {
		const child = children.get(id);
		if (!child?.pid) return;
		// The whole process group: the command and what it started without leaving it.
		const signal = (name: NodeJS.Signals): void => {
			try {
				process.kill(-child.pid!, name);
			} catch {
				/* Already gone. */
			}
		};
		signal("SIGTERM");
		setTimeout(() => signal("SIGKILL"), 2000).unref();
	};
	let last = -1;
	let lastSent = 0;
	const report = async (): Promise<void> => {
		const current = await count().catch(() => last);
		if (current !== last || Date.now() - lastSent > 20000) {
			last = current;
			lastSent = Date.now();
			send({ t: "procs", count: current });
		}
	};
	const timer = setInterval(() => void report(), options.processIntervalMs ?? 2000);
	send({ t: "ready" });
	await report();
	await new Promise<void>((finished) => {
		lines(
			options.input,
			(line) => {
				const request = parseRequest(line);
				if (!request) return;
				if (request.t === "start") start(request.id, request.command);
				else if (request.t === "stop") stop(request.id);
				else {
					const stdin = children.get(request.id)?.stdin;
					if (!stdin || stdin.writableEnded) return;
					const data = Buffer.from(request.data, "base64");
					if (data.length) stdin.write(data);
					if (request.end) stdin.end();
				}
			},
			() => undefined,
		);
		options.input.once("end", finished);
		options.input.once("close", finished);
		options.input.once("error", finished);
	});
	clearInterval(timer);
	for (const id of children.keys()) stop(id);
	proxy?.close();
}

/** Desktop namespace: only the loopback proxy, for the Terminal and what it starts. */
export async function runCompanyComputerNetworkProxy(): Promise<void> {
	const server = await listenCompanyComputerShellProxy(
		COMPANY_COMPUTER_SHELL_RELAY_PATH,
		COMPANY_COMPUTER_SHELL_PROXY_PORT,
	);
	await new Promise<void>((closed) => server.once("close", () => closed()));
}

/** SSH `ProxyCommand`: one CONNECT through the relay, then the raw stream on stdin/stdout. */
export async function runCompanyComputerShellConnect(host: string, port: string): Promise<void> {
	if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !/^[0-9]{1,5}$/.test(port))
		throw new Error("INVALID_OFFICE_SHELL_TARGET");
	const socket: Socket = createConnection(COMPANY_COMPUTER_SHELL_RELAY_PATH);
	await new Promise<void>((ready, reject) => {
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
			let head = Buffer.alloc(0);
			const receive = (bytes: Buffer): void => {
				head = Buffer.concat([head, bytes]);
				const separator = head.indexOf("\r\n\r\n");
				if (separator < 0) {
					if (head.length > 65536) reject(new Error("OFFICE_SHELL_PROXY_REFUSED"));
					return;
				}
				socket.removeListener("data", receive);
				if (!/^HTTP\/1\.[01] 200 /.test(head.toString("latin1"))) {
					process.stderr.write(head.subarray(separator + 4));
					reject(new Error("OFFICE_SHELL_PROXY_REFUSED"));
					return;
				}
				const rest = head.subarray(separator + 4);
				if (rest.length) process.stdout.write(rest);
				ready();
			};
			socket.on("data", receive);
		});
	});
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((closed) => socket.once("close", () => closed()));
}
