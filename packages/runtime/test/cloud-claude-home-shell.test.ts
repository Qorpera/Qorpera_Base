import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUD_CLAUDE_SHELL_ENVIRONMENT,
	CLOUD_CLAUDE_SHELL_LOST,
	type CloudClaudeHomeChannel,
	CloudClaudeHomeShell,
	parseCloudClaudeShellRequest,
} from "@qorpera/runtime/cloud-claude-home-shell";
import { afterEach, expect, it } from "vitest";

const SESSION = "00000000-0000-4000-8000-000000000001";
const MACHINE = "00000000-0000-4000-8000-000000000002";

/** A home that answers like `codex exec-server`: what it was sent, and a hand to answer each line. */
function fakeHome(answer: (message: Record<string, unknown>, send: (line: Record<string, unknown>) => void) => void) {
	const sent: Record<string, unknown>[] = [];
	const opened: { kind?: string; sessionId: string }[] = [];
	let closeAll: (() => void) | undefined;
	const channel: CloudClaudeHomeChannel = {
		open: async (input) => {
			opened.push({ kind: input.kind, sessionId: input.sessionId });
			const queue: string[] = [];
			let wake: (() => void) | undefined;
			let ended = false;
			const send = (line: Record<string, unknown>): void => {
				queue.push(JSON.stringify(line));
				wake?.();
			};
			closeAll = () => {
				ended = true;
				wake?.();
			};
			return {
				write: (line) => {
					const message = JSON.parse(line) as Record<string, unknown>;
					sent.push(message);
					if (message.method === "initialize") send({ id: message.id, result: {} });
					else answer(message, send);
				},
				lines: (async function* () {
					for (;;) {
						const next = queue.shift();
						if (next !== undefined) {
							yield next;
							continue;
						}
						if (ended) return;
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				})(),
				close: async () => closeAll?.(),
			};
		},
	};
	return { channel, sent, opened, drop: () => closeAll?.() };
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function shellWith(channel: CloudClaudeHomeChannel) {
	const root = mkdtempSync(join(tmpdir(), "claude-shell-"));
	roots.push(root);
	const controller = new AbortController();
	const shell = new CloudClaudeHomeShell({
		channel,
		sessionId: SESSION,
		machineId: MACHINE,
		signal: controller.signal,
	});
	await shell.listen(root);
	return { shell, controller };
}

/** Runs one command as the box's prefix would; resolves with what came back once the socket ends. */
function command(path: string, request: Record<string, unknown>, dropAfterMs?: number) {
	return new Promise<{ out: string; err: string; code?: number }>((resolve) => {
		const socket = createConnection(path);
		let rest = "";
		const result: { out: string; err: string; code?: number } = { out: "", err: "" };
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			rest += chunk;
			for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
				const line = JSON.parse(rest.slice(0, end)) as { o?: string; e?: string; x?: number };
				rest = rest.slice(end + 1);
				if (line.o) result.out += Buffer.from(line.o, "base64").toString();
				if (line.e) result.err += Buffer.from(line.e, "base64").toString();
				if (line.x !== undefined) result.code = line.x;
			}
		});
		socket.on("close", () => resolve(result));
		if (dropAfterMs !== undefined) setTimeout(() => socket.destroy(), dropAfterMs);
	});
}

it("keeps only the named variables and an absolute folder", () => {
	expect(
		parseCloudClaudeShellRequest(
			JSON.stringify({
				cmd: "echo hi",
				cwd: "/company",
				env: { TMPDIR: "/tmp", CLAUDE_CONFIG_DIR: "/slot/config", CLAUDE_CODE_OAUTH_TOKEN: "x", COLUMNS: "80" },
			}),
		),
	).toEqual({
		cmd: "echo hi",
		cwd: "/company",
		env: { TMPDIR: "/tmp", COLUMNS: "80" },
		dropped: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
	});
	expect(parseCloudClaudeShellRequest(JSON.stringify({ cmd: "x", cwd: "relative" }))).toBeUndefined();
	expect(parseCloudClaudeShellRequest("not json")).toBeUndefined();
});

it("runs each command on the home as bash -c over one channel, with its output and exit code", async () => {
	const home = fakeHome((message, send) => {
		if (message.method !== "process/start") return;
		const processId = (message.params as { processId: string }).processId;
		send({ id: message.id, result: {} });
		send({
			method: "process/output",
			params: { processId, stream: "stdout", chunk: Buffer.from("out\n").toString("base64") },
		});
		send({
			method: "process/output",
			params: { processId, stream: "stderr", chunk: Buffer.from("err\n").toString("base64") },
		});
		send({ method: "process/exited", params: { processId, exitCode: 7 } });
		send({ method: "process/closed", params: { processId } });
	});
	const { shell } = await shellWith(home.channel);
	const first = await command(shell.socketPath, {
		cmd: "echo out; echo err >&2; exit 7",
		cwd: "/company/a b",
		env: { TMPDIR: "/tmp", CLAUDE_CONFIG_DIR: "/slot/config" },
	});
	const second = await command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} });
	expect(first).toEqual({ out: "out\n", err: "err\n", code: 7 });
	expect(second.code).toBe(7);
	expect(home.opened).toEqual([{ kind: "exec", sessionId: SESSION }]);
	const start = home.sent.find((message) => message.method === "process/start") as { params: Record<string, unknown> };
	expect(start.params).toMatchObject({
		argv: ["/bin/bash", "-c", "echo out; echo err >&2; exit 7"],
		cwd: "file:///company/a%20b",
		env: { ...CLOUD_CLAUDE_SHELL_ENVIRONMENT, TMPDIR: "/tmp" },
		tty: false,
		pipeStdin: false,
	});
	expect(shell.counts.commands).toBe(2);
	await shell.close();
});

it("ends a command on the home when the prefix is dropped", async () => {
	const home = fakeHome((message, send) => {
		if (message.method === "process/start") send({ id: message.id, result: {} });
		if (message.method === "process/terminate") send({ id: message.id, result: {} });
	});
	const { shell } = await shellWith(home.channel);
	await command(shell.socketPath, { cmd: "sleep 600", cwd: "/company", env: {} }, 100);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const terminate = home.sent.find((message) => message.method === "process/terminate") as {
		params: { processId: string };
	};
	const start = home.sent.find((message) => message.method === "process/start") as { params: { processId: string } };
	expect(terminate.params.processId).toBe(start.params.processId);
	expect(shell.counts.terminated).toBe(1);
	await shell.close();
});

it("says the home was lost when the channel ends under a command, and opens a new one for the next", async () => {
	let starts = 0;
	const home = fakeHome((message, send) => {
		if (message.method !== "process/start") return;
		starts += 1;
		send({ id: message.id, result: {} });
		if (starts === 1) setTimeout(() => home.drop(), 20);
		else {
			const processId = (message.params as { processId: string }).processId;
			send({ method: "process/exited", params: { processId, exitCode: 0 } });
			send({ method: "process/closed", params: { processId } });
		}
	});
	const { shell } = await shellWith(home.channel);
	const lost = await command(shell.socketPath, { cmd: "sleep 600", cwd: "/company", env: {} });
	expect(lost.code).toBe(255);
	expect(lost.err).toBe(`${CLOUD_CLAUDE_SHELL_LOST}\n`);
	const next = await command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} });
	expect(next.code).toBe(0);
	expect(home.opened).toHaveLength(2);
	await shell.close();
});

it("opens one new channel for the commands that waited on an opening that failed (review round 1, F2)", async () => {
	let opens = 0;
	const working = fakeHome((message, send) => {
		if (message.method !== "process/start") return;
		const processId = (message.params as { processId: string }).processId;
		send({ id: message.id, result: {} });
		send({ method: "process/exited", params: { processId, exitCode: 0 } });
		send({ method: "process/closed", params: { processId } });
	});
	const channel: CloudClaudeHomeChannel = {
		open: async (input, signal) => {
			opens += 1;
			if (opens === 1) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				throw Object.assign(new Error("refused"), { reason: "MACHINE_NOT_RUNNING" });
			}
			return working.channel.open(input, signal);
		},
	};
	const { shell } = await shellWith(channel);
	const first = command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} });
	await new Promise((resolve) => setTimeout(resolve, 50));
	// Two more arrive while the first opening is still pending, and wait on it.
	const [a, b] = await Promise.all([
		command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} }),
		command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} }),
	]);
	expect((await first).code).toBe(255);
	expect((await first).err).toContain("(MACHINE_NOT_RUNNING)");
	expect([a.code, b.code]).toEqual([0, 0]);
	expect(opens).toBe(2);
	expect(shell.counts.channels).toBe(1);
	await shell.close();
});
