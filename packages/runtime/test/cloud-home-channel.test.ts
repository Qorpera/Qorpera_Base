import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_HOME_OUTDATED, CLOUD_HOME_UNAVAILABLE, cloudHomeRefusalWords } from "../src/cloud-codex-home.ts";
import { HttpCloudCodingCommandService } from "../src/cloud-coding-command-http.ts";
import {
	CLOUD_HOME_CHANNEL_KEEPALIVE,
	CloudHomeChannelRefused,
	type CloudHomeChannelSide,
	cloudHomeChannelKeepAlive,
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

async function fixture(open: () => Promise<CloudHomeChannelSide>) {
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
			open: async () => await open(),
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
	return { open: () => channel.open({ sessionId: randomUUID(), machineId }, AbortSignal.timeout(5000)) };
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
