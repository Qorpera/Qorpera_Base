import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_HOME_OUTDATED, CLOUD_HOME_UNAVAILABLE, cloudHomeRefusalWords } from "../src/cloud-codex-home.ts";
import { HttpCloudCodingCommandService } from "../src/cloud-coding-command-http.ts";
import {
	CLOUD_HOME_CHANNEL_KEEPALIVE,
	CLOUD_HOME_CHANNEL_LINE_BYTES,
	CLOUD_HOME_SFTP_PIECE_BYTES,
	type CloudHomeChannelKind,
	CloudHomeChannelRefused,
	type CloudHomeChannelRequest,
	type CloudHomeChannelSide,
	cloudHomeChannelHandshake,
	cloudHomeChannelKeepAlive,
	cloudHomeChannelLines,
	cloudHomeSftpBytes,
	cloudHomeSftpLines,
	parseCloudHomeChannelHandshake,
} from "../src/cloud-home-channel.ts";
import { createCloudHomeChannel } from "../src/cloud-home-channel-client.ts";

// The home's channel end to end on loopback: the run's client, the ingress's upgrade route, and a machine side that
// records what reaches it (lanes/agent-box-20261113, home-lxd: a front ends an upgraded connection that is quiet for
// its read timeout, so each end says it is there while the channel is open).

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const until = async (test: () => boolean, ms = 3000): Promise<void> => {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

async function fixture(open: (request: CloudHomeChannelRequest) => Promise<CloudHomeChannelSide>) {
	const token = randomBytes(32).toString("base64url");
	const binding = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
		provider: "openai" as const,
		nativeHarness: "codex-cli" as const,
		model: "gpt-test",
	};
	const machineId = randomUUID();
	const service = new HttpCloudCodingCommandService({
		token,
		port: 0,
		homeKeepAliveMs: 40,
		proveBinding: async () => undefined,
		authorize: async () => {
			throw new Error("not here");
		},
		execute: async () => {
			throw new Error("not here");
		},
		home: {
			authorize: async (request) => ({
				state: "authorized",
				sessionId: request.sessionId,
				machineId,
				machine: "home-machine",
				placementId: randomUUID(),
				bootId: randomUUID(),
				executorOwner: "node-a",
				providerId: "machine-node",
			}),
			open: async (_authority, request) => await open(request),
		},
	});
	const port = await service.start();
	cleanups.push(async () => await service.close());
	const channel = createCloudHomeChannel({
		url: `http://127.0.0.1:${port}`,
		token,
		binding,
		holder: () => `job.${binding.jobId}.${randomBytes(32).toString("base64url")}`,
		allowLoopback: true,
		keepAliveMs: 40,
	});
	return {
		open: (kind?: CloudHomeChannelKind) =>
			channel.open({ sessionId: randomUUID(), machineId, ...(kind ? { kind } : {}) }, AbortSignal.timeout(5000)),
	};
}

/** A machine side whose lines the test pushes, and which records every line it is given. */
function machine() {
	const given: string[] = [];
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	const side: CloudHomeChannelSide = {
		write: (line) => given.push(line),
		lines: (async function* () {
			for (;;) {
				const line = queue.shift();
				if (line !== undefined) {
					yield line;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		})(),
		close: async () => {
			ended = true;
			wake?.();
		},
	};
	return {
		side,
		given,
		push: (line: string) => {
			queue.push(line);
			wake?.();
		},
	};
}

describe("the home's channel keeps itself open while it is quiet", () => {
	it("sends a keep-alive line each way while quiet; neither reaches the machine or the run's Codex", async () => {
		const m = machine();
		const f = await fixture(async () => m.side);
		const stream = await f.open();
		const seen: string[] = [];
		// The read ends with an error once the test closes the socket under it.
		void (async () => {
			for await (const line of stream.lines) seen.push(line);
		})().catch(() => undefined);
		stream.write('{"id":1,"method":"initialize","params":{}}');
		m.push('{"id":1,"result":{}}');
		await until(() => seen.length === 1 && m.given.length === 1);
		// Quiet for many keep-alive periods: still open, and nothing but the real lines arrived on either side.
		await new Promise((resolve) => setTimeout(resolve, 400));
		stream.write('{"id":2,"method":"process/start","params":{}}');
		m.push('{"id":2,"result":{}}');
		await until(() => seen.length === 2 && m.given.length === 2);
		expect(seen).toEqual(['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
		expect(m.given).toEqual([
			'{"id":1,"method":"initialize","params":{}}',
			'{"id":2,"method":"process/start","params":{}}',
		]);
		expect([...seen, ...m.given]).not.toContain(CLOUD_HOME_CHANNEL_KEEPALIVE);
		await stream.close();
	});

	it("each end's timer sends one every period while the socket takes it, and none once stopped", async () => {
		const raw: string[] = [];
		// The timer each end runs: a line every period while the socket takes it, none once stopped or unwritable.
		const socket = { writable: true, write: (line: string) => raw.push(line) };
		const stop = cloudHomeChannelKeepAlive(socket, 20);
		await until(() => raw.length >= 3);
		socket.writable = false;
		const count = raw.length;
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(raw.length).toBe(count);
		socket.writable = true;
		stop();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(raw.length).toBe(count);
		expect(new Set(raw)).toEqual(new Set([`${CLOUD_HOME_CHANNEL_KEEPALIVE}\n`]));
	});

	it("the ingress sends them on an open channel's socket", async () => {
		const m = machine();
		const token = randomBytes(32).toString("base64url");
		const service = new HttpCloudCodingCommandService({
			token,
			port: 0,
			homeKeepAliveMs: 30,
			proveBinding: null,
			authorize: async () => {
				throw new Error("not here");
			},
			execute: async () => {
				throw new Error("not here");
			},
			home: {
				authorize: async (request) => ({
					state: "authorized",
					sessionId: request.sessionId,
					machineId: request.machineId,
					machine: "home-machine",
					placementId: randomUUID(),
					bootId: randomUUID(),
					executorOwner: "node-a",
					providerId: "machine-node",
				}),
				open: async () => m.side,
			},
		});
		const port = await service.start();
		cleanups.push(async () => await service.close());
		const socket = connect(port, "127.0.0.1");
		let received = "";
		socket.on("data", (chunk) => {
			received += chunk.toString("utf8");
		});
		socket.on("error", () => undefined);
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.write(
			`GET /v1/home-session HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: qorpera-home-session/1\r\nauthorization: Bearer ${token}\r\n\r\n`,
		);
		const binding = {
			leaseId: randomUUID(),
			runId: randomUUID(),
			jobId: randomUUID(),
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			credentialCapsuleId: randomUUID(),
			computeIdentityId: randomUUID(),
			provider: "openai",
			nativeHarness: "codex-cli",
			model: "gpt-test",
		};
		socket.write(
			`${JSON.stringify({ schema: "qorpera-home-session/1", binding, machineId: randomUUID(), sessionId: randomUUID() })}\n`,
		);
		await until(() => received.includes('"ok":true'));
		// The run's side sends one keep-alive of its own: it never reaches the machine.
		socket.write(`${CLOUD_HOME_CHANNEL_KEEPALIVE}\n`);
		await until(() => received.split(CLOUD_HOME_CHANNEL_KEEPALIVE).length - 1 >= 3);
		expect(m.given).toEqual([]);
		socket.destroy();
	});
});

describe("a machine whose Codex is not the pinned build", () => {
	it("is refused with its own reason, and the model is told in words it can act on", async () => {
		const f = await fixture(async () => {
			throw new CloudHomeChannelRefused("HOME_CODEX_NOT_PINNED");
		});
		const refused = await f.open().catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CloudHomeChannelRefused);
		expect((refused as CloudHomeChannelRefused).reason).toBe("HOME_CODEX_NOT_PINNED");
		expect(cloudHomeRefusalWords("HOME_CODEX_NOT_PINNED")).toBe(CLOUD_HOME_OUTDATED);
		expect(CLOUD_HOME_OUTDATED).toMatch(/^HOME_OUTDATED: .*unavailable on this machine.*Start a new machine/);
		expect(cloudHomeRefusalWords("HOME_NOT_SHARED")).toBe(CLOUD_HOME_UNAVAILABLE);
	});
});

describe("the file channel's kind (Claude Code on the home, slice C1)", () => {
	const binding = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
		provider: "openai" as const,
		nativeHarness: "codex-cli" as const,
		model: "gpt-test",
	};

	it("is named in the handshake only for sftp, so an exec channel's handshake is today's; anything else is refused", () => {
		const ids = { binding, machineId: randomUUID(), sessionId: randomUUID() };
		const exec = cloudHomeChannelHandshake(ids);
		expect(Object.keys(JSON.parse(exec)).sort()).toEqual(["binding", "machineId", "schema", "sessionId"]);
		expect(cloudHomeChannelHandshake({ ...ids, kind: "exec" })).toBe(exec);
		expect(parseCloudHomeChannelHandshake(exec)?.kind).toBe("exec");
		const sftp = cloudHomeChannelHandshake({ ...ids, kind: "sftp" });
		expect(JSON.parse(sftp).kind).toBe("sftp");
		expect(parseCloudHomeChannelHandshake(sftp)).toMatchObject({ kind: "sftp", sessionId: ids.sessionId });
		expect(parseCloudHomeChannelHandshake(JSON.stringify({ ...JSON.parse(exec), kind: "exec" }))?.kind).toBe("exec");
		for (const kind of ["shell", "", 1, null, "SFTP"])
			expect(parseCloudHomeChannelHandshake(JSON.stringify({ ...JSON.parse(exec), kind }))).toBeUndefined();
		expect(parseCloudHomeChannelHandshake(JSON.stringify({ ...JSON.parse(sftp), extra: 1 }))).toBeUndefined();
		expect(() => cloudHomeChannelHandshake({ ...ids, kind: "shell" as CloudHomeChannelKind })).toThrow();
	});

	it("carries the stream as base64 lines in pieces, and takes nothing but standard base64 back", async () => {
		const large = randomBytes(CLOUD_HOME_SFTP_PIECE_BYTES * 2 + 3);
		const small = Buffer.from([0, 10, 13, 0xff]);
		const lines: string[] = [];
		for await (const line of cloudHomeSftpLines(
			(async function* () {
				yield small;
				yield large;
			})(),
		))
			lines.push(line);
		expect(lines.map((line) => cloudHomeSftpBytes(line).byteLength)).toEqual([4, 786432, 786432, 3]);
		expect(Buffer.concat(lines.map(cloudHomeSftpBytes))).toEqual(Buffer.concat([small, large]));
		expect(lines.every((line) => !line.includes("\n") && line !== CLOUD_HOME_CHANNEL_KEEPALIVE)).toBe(true);
		for (const bad of [
			"",
			"abc",
			"ab=c",
			"a===",
			"YWJj\n",
			"YW Jj",
			"YWJj-_8=",
			CLOUD_HOME_CHANNEL_KEEPALIVE,
			"====",
		])
			expect(() => cloudHomeSftpBytes(bad), bad).toThrow();
		expect(cloudHomeSftpBytes("YQ==")).toEqual(Buffer.from("a"));
	});

	it("reaches the machine's side through the ingress with its kind, and a machine without sftp-server is outdated", async () => {
		const m = machine();
		const asked: CloudHomeChannelRequest[] = [];
		const f = await fixture(async (request) => {
			asked.push(request);
			if (asked.length === 3) throw new CloudHomeChannelRefused("HOME_SFTP_MISSING");
			// Each channel its own machine side: the shell's never sees the file channel's lines.
			return asked.length === 1 ? m.side : machine().side;
		});
		const files = await f.open("sftp");
		const shell = await f.open();
		expect(asked.map((request) => request.kind)).toEqual(["sftp", "exec"]);
		const seen: string[] = [];
		void (async () => {
			for await (const line of files.lines) seen.push(line);
		})().catch(() => undefined);
		const line = Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3]).toString("base64");
		files.write(line);
		m.push(line);
		await until(() => seen.length === 1 && m.given.length === 1);
		expect([seen, m.given]).toEqual([[line], [line]]);
		await files.close();
		await shell.close();
		const refused = await f.open("sftp").catch((error: unknown) => error);
		expect((refused as CloudHomeChannelRefused).reason).toBe("HOME_SFTP_MISSING");
		expect(cloudHomeRefusalWords("HOME_SFTP_MISSING")).toBe(CLOUD_HOME_OUTDATED);
	});
});

describe("home channel framing bounds and keep-alive teardown", () => {
	it("enforces CLOUD_HOME_CHANNEL_LINE_BYTES per line rather than per coalesced chunk", async () => {
		const threeMiB = "a".repeat(3 * 1024 * 1024);
		const burst = Buffer.from(`${threeMiB}\n${threeMiB}\n${threeMiB}\n`, "utf8");
		expect(burst.byteLength).toBeGreaterThan(CLOUD_HOME_CHANNEL_LINE_BYTES);
		const lines: string[] = [];
		for await (const line of cloudHomeChannelLines(
			(async function* () {
				yield burst;
			})(),
		)) {
			lines.push(line);
		}
		expect(lines).toHaveLength(3);
		expect(lines.every((line) => line.length === threeMiB.length)).toBe(true);

		const tooLarge = Buffer.concat([Buffer.alloc(CLOUD_HOME_CHANNEL_LINE_BYTES + 1, 0x61), Buffer.from("\n")]);
		await expect(async () => {
			for await (const _line of cloudHomeChannelLines(
				(async function* () {
					yield tooLarge;
				})(),
			)) {
				expect(_line).toBeDefined();
			}
		}).rejects.toThrow("Home line too large");
	});

	it("stops the client keep-alive interval when the line iterator ends on remote close", async () => {
		const activeTimers = new Set<ReturnType<typeof setInterval>>();
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
			...args: Parameters<typeof setInterval>
		) => {
			const timer = realSetInterval(...args);
			activeTimers.add(timer);
			return timer;
		}) as typeof setInterval);
		const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((
			timer: ReturnType<typeof setInterval>,
		) => {
			activeTimers.delete(timer);
			return realClearInterval(timer);
		}) as typeof clearInterval);
		try {
			const m = machine();
			const f = await fixture(async () => m.side);
			const stream = await f.open();
			m.push('{"id":1,"result":{}}');
			await m.side.close();
			const received: string[] = [];
			for await (const line of stream.lines) received.push(line);
			expect(received).toEqual(['{"id":1,"result":{}}']);
			expect(activeTimers.size).toBe(0);
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});

	it("aborts in-flight home authorization when the client socket closes and flushes 403 refusals cleanly", async () => {
		const token = randomBytes(32).toString("base64url");
		const binding = {
			leaseId: randomUUID(),
			runId: randomUUID(),
			jobId: randomUUID(),
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			credentialCapsuleId: randomUUID(),
			computeIdentityId: randomUUID(),
			provider: "openai" as const,
			nativeHarness: "codex-cli" as const,
			model: "gpt-test",
		};
		let authorizeSignal: AbortSignal | undefined;
		const service = new HttpCloudCodingCommandService({
			token,
			port: 0,
			proveBinding: async () => undefined,
			authorize: async () => {
				throw new Error("not here");
			},
			execute: async () => {
				throw new Error("not here");
			},
			home: {
				authorize: async (_request, signal) => {
					authorizeSignal = signal;
					return await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				},
				open: async () => {
					throw new Error("should not open");
				},
			},
		});
		const port = await service.start();
		cleanups.push(async () => await service.close());

		const badSocket = connect({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			badSocket.once("connect", resolve);
			badSocket.once("error", reject);
		});
		const refusedReply = new Promise<string>((resolve) => {
			const chunks: Buffer[] = [];
			badSocket.on("data", (chunk: Buffer) => chunks.push(chunk));
			badSocket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
		badSocket.write(
			`GET /v1/home-session HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: qorpera-home-session/1\r\nauthorization: Bearer wrong\r\n\r\n`,
		);
		expect(await refusedReply).toContain("HTTP/1.1 403 Forbidden");
		badSocket.destroy();

		const holder = `job.${binding.jobId}.${randomBytes(32).toString("base64url")}`;
		const socket = connect({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(
			`GET /v1/home-session HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: qorpera-home-session/1\r\nauthorization: Bearer ${token}\r\nx-qorpera-identity: ${holder}\r\n\r\n` +
				`${JSON.stringify({ schema: "qorpera-home-session/1", binding, machineId: randomUUID(), sessionId: randomUUID() })}\n`,
		);
		await vi.waitFor(() => expect(authorizeSignal).toBeDefined());
		expect(authorizeSignal!.aborted).toBe(false);
		socket.destroy();
		await vi.waitFor(() => expect(authorizeSignal!.aborted).toBe(true));
	});

	it("applies backpressure on fromMachine and exits cleanly when a paused client disconnects mid-drain", async () => {
		const token = randomBytes(32).toString("base64url");
		const binding = {
			leaseId: randomUUID(),
			runId: randomUUID(),
			jobId: randomUUID(),
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			credentialCapsuleId: randomUUID(),
			computeIdentityId: randomUUID(),
			provider: "openai" as const,
			nativeHarness: "codex-cli" as const,
			model: "gpt-test",
		};
		let yielded = 0;
		let sideClosed = false;
		const totalLines = 256;
		const payload = "x".repeat(256 * 1024);
		const service = new HttpCloudCodingCommandService({
			token,
			port: 0,
			proveBinding: async () => undefined,
			authorize: async () => {
				throw new Error("not here");
			},
			execute: async () => {
				throw new Error("not here");
			},
			home: {
				authorize: async (request) => ({
					state: "authorized",
					sessionId: request.sessionId,
					machineId: request.machineId,
					machine: "dev-box",
					placementId: randomUUID(),
					bootId: randomUUID(),
					executorOwner: "node-a",
					providerId: "machine-node",
				}),
				open: async () => ({
					write: () => undefined,
					lines: (async function* () {
						while (yielded < totalLines && !sideClosed) {
							yielded += 1;
							yield payload;
						}
					})(),
					close: async () => {
						sideClosed = true;
					},
				}),
			},
		});
		const port = await service.start();
		cleanups.push(async () => await service.close());

		const holder = `job.${binding.jobId}.${randomBytes(32).toString("base64url")}`;
		const socket = connect({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const ready = new Promise<void>((resolve, reject) => {
			let buffered = "";
			const onData = (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const sep = buffered.indexOf("\r\n\r\n");
				if (sep >= 0 && buffered.slice(sep + 4).includes("\n")) {
					socket.off("data", onData);
					socket.pause();
					resolve();
				}
			};
			socket.on("data", onData);
			socket.once("error", reject);
		});
		socket.write(
			`GET /v1/home-session HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: qorpera-home-session/1\r\nauthorization: Bearer ${token}\r\nx-qorpera-identity: ${holder}\r\n\r\n` +
				`${JSON.stringify({ schema: "qorpera-home-session/1", binding, machineId: randomUUID(), sessionId: randomUUID() })}\n`,
		);
		await ready;
		await vi.waitFor(() => expect(yielded).toBeGreaterThan(0));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(yielded).toBeLessThan(totalLines);
		socket.destroy();
		await vi.waitFor(() => expect(sideClosed).toBe(true));
	});
});
