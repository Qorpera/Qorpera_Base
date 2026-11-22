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
import {
	CLAUDE_NO_PICTURES,
	CLAUDE_PICTURE_MAX_BYTES,
	CLAUDE_PICTURE_USAGE,
} from "@qorpera/runtime/cloud-claude-picture-command";
import type { CloudCodexHomeAction } from "@qorpera/runtime/cloud-codex-home";
import { afterEach, expect, it, vi } from "vitest";

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

async function shellWith(
	channel: CloudClaudeHomeChannel,
	more: Pick<ConstructorParameters<typeof CloudClaudeHomeShell>[0], "review" | "hook" | "pictures"> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "claude-shell-"));
	roots.push(root);
	const controller = new AbortController();
	const shell = new CloudClaudeHomeShell({
		channel,
		sessionId: SESSION,
		machineId: MACHINE,
		signal: controller.signal,
		...more,
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

const exited = (message: Record<string, unknown>, send: (line: Record<string, unknown>) => void): void => {
	if (message.method !== "process/start") return;
	const processId = (message.params as { processId: string }).processId;
	send({ id: message.id, result: {} });
	send({ method: "process/exited", params: { processId, exitCode: 0 } });
	send({ method: "process/closed", params: { processId } });
};
const claudeInvocation = (word: string) =>
	`source /slot/config/shell-snapshots/snapshot-bash-1-a.sh 2>/dev/null || true && eval ${word} < /dev/null && pwd -P >| /tmp/claude-abcd-cwd`;

it("reviews each command before anything of it reaches the home, and a refused one never opens a channel", async () => {
	const home = fakeHome(exited);
	const check = vi.fn(async (action: CloudCodexHomeAction) =>
		action.summary === "rm -rf /company/old"
			? { run: false as const, text: "APPROVAL_PENDING: The action waits for approval." }
			: { run: true as const },
	);
	const { shell } = await shellWith(home.channel, {
		review: { gate: { check }, machine: { id: MACHINE, name: "claude-review" } },
	});
	const refused = await command(shell.socketPath, {
		cmd: claudeInvocation("'rm -rf /company/old'"),
		cwd: "/company",
		env: {},
	});
	expect(refused).toEqual({ out: "", err: "APPROVAL_PENDING: The action waits for approval.\n", code: 126 });
	expect(home.opened).toEqual([]);
	const allowed = await command(shell.socketPath, { cmd: claudeInvocation("'ls'"), cwd: "/company", env: {} });
	expect(allowed.code).toBe(0);
	expect(home.opened).toHaveLength(1);
	const search = await command(shell.socketPath, { cmd: "exec rg '-n' 'x' '/company'", cwd: "/company", env: {} });
	expect(search.code).toBe(0);
	expect(check.mock.calls.map(([action]) => [action.tool, action.summary])).toEqual([
		["home_command", "rm -rf /company/old"],
		["home_command", "ls"],
	]);
	expect(shell.counts).toMatchObject({ reviewed: 2, declined: 1, commands: 2, searches: 1 });
	await shell.close();
});

it("answers the file tools' hook on the host: on with 0, stopped with 2 and the words, nothing run on the home", async () => {
	const home = fakeHome(exited);
	const hook = vi.fn(async (text: string) =>
		text.includes("secret.md") ? "REVIEW_DENIED: not that file." : undefined,
	);
	const { shell } = await shellWith(home.channel, { hook });
	const hookRequest = (path: string) => ({
		cmd: "/opt/qorpera/review-hook",
		cwd: "/company",
		env: {},
		hook: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path, content: "x" } }),
	});
	expect(await command(shell.socketPath, hookRequest("/company/a.md"))).toEqual({ out: "", err: "", code: 0 });
	expect(await command(shell.socketPath, hookRequest("/company/secret.md"))).toEqual({
		out: "",
		err: "REVIEW_DENIED: not that file.\n",
		code: 2,
	});
	expect(await command(shell.socketPath, { cmd: "--hook", cwd: "/company", env: {} })).toEqual({
		out: "",
		err: "",
		code: 0,
	});
	expect(hook).toHaveBeenCalledTimes(2);
	expect(home.opened).toEqual([]);
	expect(shell.counts).toMatchObject({ hooks: 3, commands: 0 });
	await shell.close();
});

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);
const asClaudeCode = (command: string) =>
	`source /slot/config/shell-snapshots/snapshot-bash-1700000000000-abc123.sh && eval '${command.replaceAll("'", "'\\''")}' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd`;

function pictureHome(place = 0, real?: string) {
	return fakeHome((message, send) => {
		if (message.method === "process/start") {
			const { processId, argv } = message.params as { processId: string; argv: string[] };
			send({ id: message.id, result: {} });
			if (place === 0)
				send({
					method: "process/output",
					params: { processId, stream: "stdout", chunk: Buffer.from(`- ${real ?? argv[4]}`).toString("base64") },
				});
			send({ method: "process/exited", params: { processId, exitCode: place } });
			send({ method: "process/closed", params: { processId } });
		} else if (message.method === "fs/writeFile") send({ id: message.id, result: {} });
	});
}

it("answers a picture command itself: checked as make_picture, made, written on the home, never run there", async () => {
	const home = pictureHome();
	const reviewed: CloudCodexHomeAction[] = [];
	const asked: string[] = [];
	const { shell } = await shellWith(home.channel, {
		review: {
			gate: {
				check: async (action) => {
					reviewed.push(action);
					return { run: true };
				},
			},
			machine: { id: MACHINE, name: "studio" },
		},
		pictures: {
			make: async (input) => {
				asked.push(input.prompt);
				return { png: PNG };
			},
		},
	});
	const result = await command(shell.socketPath, {
		cmd: asClaudeCode(`picture designs/chair.png "a red chair, it's walnut"`),
		cwd: "/company",
		env: {},
	});
	expect(result.code).toBe(0);
	expect(result.out).toContain("Saved a new picture to /company/designs/chair.png");
	expect(asked).toEqual(["a red chair, it's walnut"]);
	expect(reviewed.map((action) => action.tool)).toEqual(["make_picture"]);
	const started = home.sent.filter((message) => message.method === "process/start");
	expect(started).toHaveLength(2);
	expect((started[0]?.params as { argv: string[] }).argv[2]).toContain("realpath -m");
	expect((started[0]?.params as { argv: string[] }).argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
	expect((started[0]?.params as { argv: string[] }).argv.slice(3)).toEqual(["picture", "/company/designs/chair.png"]);
	expect(JSON.stringify(home.sent)).not.toContain("a red chair");
	const written = home.sent.filter((message) => message.method === "fs/writeFile");
	expect(written.map((message) => message.params)).toEqual([
		{ path: "file:///company/designs/chair.png", dataBase64: PNG.toString("base64") },
	]);
	expect(shell.counts).toMatchObject({ pictures: 1, picturesSaved: 1, commands: 0, reviewed: 0 });
	await shell.close();
});

it("answers a malformed picture command with its usage and a member without pictures with the words", async () => {
	const home = pictureHome();
	const { shell } = await shellWith(home.channel, { pictures: { make: undefined } });
	const usage = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/a.png $(cat words.txt)"),
		cwd: "/company",
		env: {},
	});
	expect(usage).toEqual({ out: "", err: `${CLAUDE_PICTURE_USAGE}\n`, code: 2 });
	expect(home.opened).toEqual([]);
	const none = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/a.png red"),
		cwd: "/company",
		env: {},
	});
	expect(none).toEqual({ out: "", err: `${CLAUDE_NO_PICTURES}\n`, code: 1 });
	expect(home.sent.filter((message) => message.method === "fs/writeFile")).toEqual([]);
	await shell.close();
});

it("says the picture's folder is missing on the home before any picture is made", async () => {
	const home = pictureHome(3);
	let made = 0;
	const { shell } = await shellWith(home.channel, {
		pictures: {
			make: async () => {
				made += 1;
				return { png: PNG };
			},
		},
	});
	const result = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/new/a.png red"),
		cwd: "/company",
		env: {},
	});
	expect(result.code).toBe(1);
	expect(result.err).toContain("PICTURE_FOLDER_MISSING: nothing was made; the folder /company/new does not exist");
	expect(made).toBe(0);
	await shell.close();
});

it("writes a picture where a link leads on the home, never through the link", async () => {
	const home = pictureHome(0, "/company/real/chair.png");
	const { shell } = await shellWith(home.channel, { pictures: { make: async () => ({ png: PNG }) } });
	const result = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/linked/chair.png red"),
		cwd: "/company",
		env: {},
	});
	expect(result.code).toBe(0);
	expect(result.out).toContain("Saved a new picture to /company/real/chair.png");
	expect(
		home.sent
			.filter((message) => message.method === "fs/writeFile")
			.map((message) => (message.params as { path: string }).path),
	).toEqual(["file:///company/real/chair.png"]);
	await shell.close();
});

it("hashes only a readable file of a picture's size at the place, and answers anything else there as taken", async () => {
	const home = fakeHome((message, send) => {
		if (message.method !== "process/start") return;
		const { processId, argv } = message.params as { processId: string; argv: string[] };
		send({ id: message.id, result: {} });
		send({
			method: "process/output",
			params: { processId, stream: "stdout", chunk: Buffer.from(`x ${argv[4]}`).toString("base64") },
		});
		send({ method: "process/exited", params: { processId, exitCode: 0 } });
		send({ method: "process/closed", params: { processId } });
	});
	let made = 0;
	const { shell } = await shellWith(home.channel, {
		pictures: {
			make: async () => {
				made += 1;
				return { png: PNG };
			},
		},
	});
	const result = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/fifo.png red"),
		cwd: "/company",
		env: {},
	});
	expect(result.code).toBe(1);
	expect(result.err).toContain("PICTURE_EXISTS: nothing was made; /company/fifo.png is there already");
	const script = (home.sent.find((message) => message.method === "process/start")?.params as { argv: string[] })
		.argv[2];
	expect(script).toContain('[ -f "$t" ] && [ -r "$t" ]');
	expect(script).toContain(`-le ${CLAUDE_PICTURE_MAX_BYTES} ]`);
	expect(made).toBe(0);
	await shell.close();
});

it("releases socket slots after abrupt client disconnects before newline and rejects oversized single-chunk requests", async () => {
	const home = fakeHome(exited);
	const { shell } = await shellWith(home.channel);
	for (let i = 0; i < 40; i += 1) {
		await new Promise<void>((resolve) => {
			const sock = createConnection(shell.socketPath);
			sock.on("error", () => undefined);
			sock.on("connect", () => {
				sock.write('{"cmd":"partial"');
				sock.destroy();
			});
			sock.on("close", () => resolve());
		});
	}
	await new Promise((resolve) => setTimeout(resolve, 40));
	const ok = await command(shell.socketPath, { cmd: "true", cwd: "/company", env: {} });
	expect(ok.code).toBe(0);

	const oversized = await new Promise<{ out: string; err: string; code?: number }>((resolve) => {
		const sock = createConnection(shell.socketPath);
		let rest = "";
		const result: { out: string; err: string; code?: number } = { out: "", err: "" };
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ cmd: "a".repeat(4 * 1024 * 1024 + 64), cwd: "/company", env: {} })}\n`);
		});
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => {
			rest += chunk;
			for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
				const line = JSON.parse(rest.slice(0, end)) as { o?: string; e?: string; x?: number };
				rest = rest.slice(end + 1);
				if (line.o) result.out += Buffer.from(line.o, "base64").toString();
				if (line.e) result.err += Buffer.from(line.e, "base64").toString();
				if (line.x !== undefined) result.code = line.x;
			}
		});
		sock.on("close", () => resolve(result));
	});
	expect(oversized.code).toBe(126);
	expect(oversized.err).toContain("HOME_REQUEST_INVALID");
	await shell.close();
});

it("cancels a hung process/start when the client disconnects and releases its connection slot", async () => {
	const terminated: string[] = [];
	const home = fakeHome((message, send) => {
		if (message.method === "process/start") return;
		if (message.method === "process/terminate") {
			terminated.push((message.params as { processId: string }).processId);
			send({ id: message.id, result: {} });
		}
	});
	const { shell } = await shellWith(home.channel);
	const sock = createConnection(shell.socketPath);
	await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
	sock.write(`${JSON.stringify({ cmd: "echo slow", cwd: "/company", env: {} })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 40));
	sock.destroy();
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(terminated).toHaveLength(1);
	await shell.close();
});

it("closes silent clients when firstLine times out and terminates quiet picture probes that overflow 1 MiB", async () => {
	const terminated: string[] = [];
	const home = fakeHome((message, send) => {
		if (message.method === "process/start") {
			const { processId } = message.params as { processId: string };
			send({ id: message.id, result: {} });
			const chunk = Buffer.alloc(600 * 1024, 65).toString("base64");
			send({ method: "process/output", params: { processId, stream: "stdout", chunk } });
			send({ method: "process/output", params: { processId, stream: "stdout", chunk } });
		} else if (message.method === "process/terminate") {
			terminated.push((message.params as { processId: string }).processId);
			send({ id: message.id, result: {} });
		}
	});
	const { shell } = await shellWith(home.channel, { pictures: { make: async () => ({ png: PNG }) } });
	const overflowResult = await command(shell.socketPath, {
		cmd: asClaudeCode("picture /company/big.png red"),
		cwd: "/company",
		env: {},
	});
	expect(overflowResult.code).toBe(255);
	expect(terminated).toHaveLength(1);

	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const silent = createConnection(shell.socketPath);
		silent.resume();
		await new Promise<void>((resolve) => silent.once("connect", () => resolve()));
		let closed = false;
		silent.once("close", () => {
			closed = true;
		});
		for (let step = 0; step < 10 && !closed; step += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(2_000);
		}
		expect(closed).toBe(true);
	} finally {
		vi.useRealTimers();
	}
	await shell.close();
});

it("terminates commands that exceed the 16 MiB shell event queue cap with HOME_OUTPUT_LIMIT", async () => {
	const terminated: string[] = [];
	let markTerminated!: () => void;
	const terminatedDone = new Promise<void>((resolve) => {
		markTerminated = resolve;
	});
	const oneMiB = "A".repeat(1024 * 1024);
	const home = fakeHome((message, send) => {
		if (message.method === "process/start") {
			const { processId } = message.params as { processId: string };
			send({ id: message.id, result: {} });
			for (let i = 0; i < 20; i += 1) {
				send({ method: "process/output", params: { processId, stream: "stdout", chunk: oneMiB } });
			}
		} else if (message.method === "process/terminate") {
			terminated.push((message.params as { processId: string }).processId);
			send({ id: message.id, result: {} });
			markTerminated();
		}
	});
	const { shell } = await shellWith(home.channel);
	const sock = createConnection(shell.socketPath);
	sock.pause();
	await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
	sock.write(`${JSON.stringify({ cmd: "echo flood", cwd: "/company", env: {} })}\n`);
	await terminatedDone;

	let raw = "";
	sock.setEncoding("utf8");
	sock.on("data", (chunk: string) => {
		raw += chunk;
	});
	sock.resume();
	await new Promise<void>((resolve) => sock.once("close", () => resolve()));

	let err = "";
	let code: number | undefined;
	for (const line of raw.split("\n").filter(Boolean)) {
		const record = JSON.parse(line) as { e?: string; x?: number };
		if (record.e) err += Buffer.from(record.e, "base64").toString("utf8");
		if (typeof record.x === "number") code = record.x;
	}
	expect(code).toBe(126);
	expect(err).toContain("HOME_OUTPUT_LIMIT");
	expect(terminated).toHaveLength(1);
	await shell.close();
});

it("delivers all output chunks in order when a slow client triggers socket backpressure", async () => {
	const terminated: string[] = [];
	const totalChunks = 64;
	const pad = "x".repeat(32 * 1024);
	const expectedChunks = Array.from({ length: totalChunks }, (_, i) => `[${String(i).padStart(3, "0")}:${pad}]`);
	let markSent!: () => void;
	const sentDone = new Promise<void>((resolve) => {
		markSent = resolve;
	});
	const home = fakeHome((message, send) => {
		if (message.method === "process/start") {
			const { processId } = message.params as { processId: string };
			send({ id: message.id, result: {} });
			for (const text of expectedChunks) {
				send({
					method: "process/output",
					params: { processId, stream: "stdout", chunk: Buffer.from(text).toString("base64") },
				});
			}
			send({ method: "process/exited", params: { processId, exitCode: 0 } });
			send({ method: "process/closed", params: { processId } });
			markSent();
		} else if (message.method === "process/terminate") {
			terminated.push((message.params as { processId: string }).processId);
			send({ id: message.id, result: {} });
		}
	});
	const { shell } = await shellWith(home.channel);
	const sock = createConnection(shell.socketPath);
	sock.pause();
	await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
	sock.write(`${JSON.stringify({ cmd: "echo steady", cwd: "/company", env: {} })}\n`);
	await sentDone;
	await new Promise((resolve) => setTimeout(resolve, 40));

	let raw = "";
	sock.setEncoding("utf8");
	sock.on("data", (chunk: string) => {
		raw += chunk;
	});
	sock.resume();
	await new Promise<void>((resolve) => sock.once("close", () => resolve()));

	let out = "";
	let code: number | undefined;
	for (const line of raw.split("\n").filter(Boolean)) {
		const record = JSON.parse(line) as { o?: string; x?: number };
		if (record.o) out += Buffer.from(record.o, "base64").toString("utf8");
		if (typeof record.x === "number") code = record.x;
	}
	expect(code).toBe(0);
	expect(terminated).toHaveLength(0);
	expect(out).toBe(expectedChunks.join(""));
	await shell.close();
});
