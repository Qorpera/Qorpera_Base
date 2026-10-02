import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunBoxReply, type RunBoxReply } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RunBoxHost } from "../src/run-box-host.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

interface Box {
	company: string;
	home: string;
	host: RunBoxHost;
	socketPath: string;
}

async function box(): Promise<Box> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-run-box-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const company = join(root, "company");
	const home = join(root, "home");
	await mkdir(join(company, "docs"), { recursive: true });
	await writeFile(join(company, "docs", "plan.md"), "the plan\n");
	const host = new RunBoxHost({
		home,
		company,
		environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", SHELL: "/bin/bash" },
	});
	const server: Server = createServer();
	host.serve(server);
	// Unix socket paths are short on macOS: keep it in the temporary root.
	const socketPath = join(root, "box.sock");
	await new Promise<void>((done) => server.listen(socketPath, done));
	cleanup.push(() => {
		host.close();
		return new Promise<void>((done) => server.close(() => done()));
	});
	return { company, home, host, socketPath };
}

/** A native host's side of one connection: requests in order, every line checked as untrusted. */
class Client {
	readonly #socket: Socket;
	readonly #lines: string[] = [];
	readonly #waiting: ((line: string | undefined) => void)[] = [];
	#closed = false;

	constructor(socketPath: string) {
		this.#socket = connect(socketPath);
		this.#socket.setEncoding("utf8");
		let buffer = "";
		this.#socket.on("data", (text: string) => {
			buffer += text;
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const waiter = this.#waiting.shift();
				if (waiter) waiter(line);
				else this.#lines.push(line);
			}
		});
		this.#socket.on("close", () => {
			this.#closed = true;
			for (const waiter of this.#waiting.splice(0)) waiter(undefined);
		});
		this.#socket.on("error", () => undefined);
		cleanup.push(() => {
			this.#socket.destroy();
		});
	}

	next(): Promise<string | undefined> {
		const line = this.#lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		if (this.#closed) return Promise.resolve(undefined);
		return new Promise((done) => this.#waiting.push(done));
	}

	async ready(): Promise<number[]> {
		const reply = parseRunBoxReply((await this.next()) as string);
		if (reply.t !== "ready") throw new Error("expected ready");
		return reply.sessions;
	}

	send(line: string): void {
		this.#socket.write(`${line}\n`);
	}

	async exec(
		cmd: string,
		options: { workdir?: string | null; tty?: boolean; yieldMs?: number; maxOutputBytes?: number } = {},
	): Promise<RunBoxReply> {
		const maxOutputBytes = options.maxOutputBytes ?? 4096;
		const id = randomUUID();
		this.send(
			JSON.stringify({
				t: "exec",
				id,
				cmd,
				workdir: options.workdir ?? null,
				tty: options.tty ?? false,
				yieldMs: options.yieldMs ?? 5_000,
				maxOutputBytes,
			}),
		);
		const reply = parseRunBoxReply((await this.next()) as string, maxOutputBytes);
		expect(reply.t === "ready" ? undefined : reply.id).toBe(id);
		return reply;
	}

	async write(session: number, chars: string, yieldMs = 1_000, maxOutputBytes = 4096): Promise<RunBoxReply> {
		const id = randomUUID();
		this.send(JSON.stringify({ t: "write", id, session, chars, yieldMs, maxOutputBytes }));
		const reply = parseRunBoxReply((await this.next()) as string, maxOutputBytes);
		expect(reply.t === "ready" ? undefined : reply.id).toBe(id);
		return reply;
	}
}

function ended(reply: RunBoxReply): Extract<RunBoxReply, { t: "result" }> {
	if (reply.t !== "result") throw new Error(`expected a result, got ${JSON.stringify(reply)}`);
	return reply;
}

describe("run box host", () => {
	it("runs a command in the company folder and answers with its output and exit code", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		expect(await client.ready()).toEqual([]);
		const reply = ended(await client.exec("pwd; cat docs/plan.md; echo oops >&2; exit 3"));
		expect(reply.session).toBeNull();
		expect(reply.exitCode).toBe(3);
		expect(reply.output.head).toMatch(/\/company\nthe plan\noops\n$/);
		expect(reply.output.skippedBytes).toBe(0);
		expect(reply.logPath).toBeNull();
	});

	it("keeps a slow command running past its answer and reads on", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const first = ended(await client.exec("echo start; sleep 4; echo done", { yieldMs: 2_000 }));
		expect(first.session).toBe(1);
		expect(first.exitCode).toBeNull();
		expect(first.output.head).toBe("start\n");
		// A second connection (a native host restart) sees the running command.
		const other = new Client(socketPath);
		expect(await other.ready()).toEqual([1]);
		const second = ended(await other.write(1, "", 10_000));
		expect(second).toMatchObject({ session: null, exitCode: 0, signal: null });
		expect(second.output.head).toBe("done\n");
		expect(ended(await client.exec("true")).exitCode).toBe(0);
		expect(await client.write(1, "")).toMatchObject({ t: "error", code: "SESSION_UNKNOWN" });
	});

	it("shows the head and tail of long output and keeps all of it in the home", async () => {
		const { socketPath, home } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const reply = ended(await client.exec("seq 1 200000", { maxOutputBytes: 1024 }));
		expect(reply.exitCode).toBe(0);
		expect(reply.output.head.startsWith("1\n2\n3\n")).toBe(true);
		expect(reply.output.tail.endsWith("199999\n200000\n")).toBe(true);
		expect(Buffer.byteLength(reply.output.head) + Buffer.byteLength(reply.output.tail)).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(reply.output.head)).toBeLessThanOrEqual(256);
		const whole = (await readFile(join(home, "output", "1.log"), "utf8")).length;
		expect(reply.output.totalBytes).toBe(whole);
		expect(reply.output.skippedBytes).toBe(
			whole - Buffer.byteLength(reply.output.head) - Buffer.byteLength(reply.output.tail),
		);
		expect(reply.logPath).toBe(join(home, "output", "1.log"));
	});

	it("never cuts a character in two", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const reply = ended(await client.exec(`printf 'é%.0s' $(seq 1 5000)`, { maxOutputBytes: 1001 }));
		expect(reply.output.head).toMatch(/^é+$/);
		expect(reply.output.tail).toMatch(/^é+$/);
		expect(Buffer.byteLength(reply.output.head) + Buffer.byteLength(reply.output.tail)).toBeLessThanOrEqual(1001);
	});

	it("shows binary output as one ? per byte, in one pass, with exact counts", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const started = Date.now();
		const zeros = ended(await client.exec("head -c 65536 /dev/zero", { maxOutputBytes: 65_536 }));
		expect(zeros.output).toEqual({ head: "?".repeat(65_536), tail: "", skippedBytes: 0, totalBytes: 65_536 });
		const random = ended(await client.exec("head -c 300000 /dev/urandom", { maxOutputBytes: 65_536 }));
		expect(
			Buffer.byteLength(random.output.head) + Buffer.byteLength(random.output.tail) + random.output.skippedBytes,
		).toBe(300_000);
		expect(random.output.head + random.output.tail).not.toMatch(
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/,
		);
		expect(random.logPath).not.toBeNull();
		// A small answer of control bytes, a newline and an escape sequence.
		const control = ended(await client.exec("printf 'a\\001\\033[0mb\\tc\\r\\nd\\0e'"));
		expect(control.output.head).toBe("a??[0mb\tc\r\nd?e");
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("keeps a character a running command wrote half of for its next answer", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		// é is c3 a9: the first byte now, the second after the first answer.
		const first = ended(await client.exec("printf 'x\\303'; sleep 1; printf '\\251y'", { yieldMs: 400 }));
		expect(first.output).toMatchObject({ head: "x", totalBytes: 1 });
		const second = ended(await client.write(first.session as number, "", 5_000));
		expect(second.output).toMatchObject({ head: "éy", totalBytes: 3 });
		// A command that ends on half a character shows it.
		const cut = ended(await client.exec("printf 'z\\303'"));
		expect(cut.output).toMatchObject({ head: "z?", totalBytes: 2, skippedBytes: 0 });
	});

	it("ends a command when it exits, even while a background child holds its output", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const started = Date.now();
		const reply = ended(await client.exec("sleep 30 & echo hi", { yieldMs: 10_000 }));
		expect(reply).toMatchObject({ session: null, exitCode: 0 });
		expect(reply.output.head).toBe("hi\n");
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("reports a command killed by a signal", async () => {
		const { socketPath } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const reply = ended(await client.exec("kill -KILL $$"));
		expect(reply.session).toBeNull();
		expect(reply.signal === "SIGKILL" || reply.exitCode === 137).toBe(true);
	});

	it("refuses input to a command without a terminal, a missing directory, and a bad line", async () => {
		const { socketPath, company } = await box();
		const client = new Client(socketPath);
		await client.ready();
		const running = ended(await client.exec("sleep 5", { yieldMs: 0 }));
		expect(running.session).toBe(1);
		expect(await client.write(1, "hello\n")).toMatchObject({ t: "error", code: "STDIN_CLOSED" });
		expect(await client.exec("ls", { workdir: "nowhere" })).toMatchObject({
			t: "error",
			code: "WORKDIR_UNAVAILABLE",
		});
		expect(ended(await client.exec("pwd", { workdir: "docs" })).output.head).toBe(
			`${await realpath(join(company, "docs"))}\n`,
		);
		expect(ended(await client.exec("pwd", { workdir: "/" })).output.head).toBe("/\n");
		client.send('{"t":"exec"}');
		expect(await client.next()).toBeUndefined();
	});

	it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/script"))(
		"gives a command a terminal it can be written to",
		async () => {
			const { socketPath } = await box();
			const client = new Client(socketPath);
			await client.ready();
			const started = ended(
				await client.exec("read -r name; echo hello $name; tty -s && echo has-tty", {
					tty: true,
					yieldMs: 300,
				}),
			);
			expect(started.session).toBe(1);
			const answered = ended(await client.write(1, "box\n", 5_000));
			expect(answered).toMatchObject({ session: null, exitCode: 0 });
			expect(answered.output.head).toContain("hello box");
			expect(answered.output.head).toContain("has-tty");
		},
	);
});
