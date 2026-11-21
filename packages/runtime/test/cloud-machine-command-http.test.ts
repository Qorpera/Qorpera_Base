import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { CloudMachineCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_CONTROL_METHODS } from "../../../deploy/coding-worker/control.ts";
import {
	authorizeMachineAccountFill,
	authorizeMachineCodingValue,
	authorizeMachineCommand,
	authorizeMachineScreen,
	authorizeMemberMachineAct,
	authorizeMemberMachinePointer,
	authorizeMemberMachineScreen,
} from "../../../deploy/coding-worker/machine-command-authority.ts";
import {
	localMachineAccountFill,
	localMachineCodingValue,
	localMachineCodingValueClear,
	localMachineScreen,
	localMachineWake,
	localMemberMachineAct,
	localMemberMachinePointer,
	localMemberMachineScreen,
	localMemberMachineStart,
	localMemberMachineStream,
	MachineCommandRouter,
	MEMBER_POINTER_MOVES_PER_SECOND,
	MEMBER_TOUCHED_TOLD_MS,
	machineCommandRoutes,
} from "../../../deploy/coding-worker/machine-command-routing.ts";
import type {
	CompanyMachineMemberActOutcome,
	CompanyMachineMemberLookOutcome,
	CompanyMachineMemberPointerOutcome,
	CompanyMachineMemberStartOutcome,
	CompanyMachineMemberStream,
} from "../../runner-orchestrator/src/company-machine-host.ts";
import { HttpCloudCodingCommandService } from "../src/cloud-coding-command-http.ts";
import { CloudCommandPages } from "../src/cloud-command-pages.ts";
import {
	CloudHomeChannelRefused,
	type CloudHomeChannelSide,
	type CloudHomeSessionAuthorized,
} from "../src/cloud-home-channel.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	type CloudMachineAccountFillHttpRequest,
	CloudMachineAccountFillRefusal,
	type CloudMachineCodingValueHttpRequest,
	CloudMachineCodingValueRefusal,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	CloudMachineCommandUnanswered,
	type CloudMachineScreenHttpRequest,
	CloudMachineScreenRefusal,
	type CloudMachineWakeHttpRequest,
	CloudMemberMachineActRefusal,
	CloudMemberMachinePointerRefusal,
	CloudMemberMachineScreenRefusal,
	cloudMemberMachineActRecord,
	createHttpCloudMachineCommandGateway,
	createHttpMemberMachineScreenPeer,
	parseCloudMachineAccountFillHttpRequest,
	parseCloudMachineCodingValueHttpRequest,
	parseCloudMachineScreenAnswer,
	parseCloudMachineScreenHttpRequest,
	parseCloudMemberMachineActAnswer,
	parseCloudMemberMachineAction,
	parseCloudMemberMachineActPeerRequest,
	parseCloudMemberMachinePointerAnswer,
	parseCloudMemberMachinePointerPeerRequest,
	parseCloudMemberMachineScreenAnswer,
	parseCloudMemberMachineScreenPeerRequest,
	parseCloudMemberMachineStartAnswer,
	parseCloudMemberMachineStartPeerRequest,
} from "../src/cloud-machine-command-http.ts";
import type { CloudNativeToolBinding } from "../src/cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
function receiptFor(machineId: string, commandId: string, inputSha256: string) {
	return {
		schema: "qorpera.machine-command-result/v1",
		machineId,
		commandId,
		inputSha256,
		state: "running",
		exitCode: null,
		output: "building",
		truncated: false,
		log: { offset: 0, nextOffset: 8, totalBytes: 8, limitBytes: 67108864, limitReached: false },
	};
}
async function service(
	authorize: (request: CloudMachineCommandHttpRequest) => Promise<{ inputSha256: string }>,
	execute: (request: CloudMachineCommandHttpRequest) => Promise<unknown>,
	wake?: (request: CloudMachineWakeHttpRequest) => Promise<boolean>,
) {
	const token = randomBytes(32).toString("base64url");
	// G2-6b: the database's lease proof stands in here (its own test is 986): only the run's own lease token, as
	// `job.<the binding's job>.<lease token>`, proves a request's binding.
	const lease = randomBytes(32).toString("base64url");
	const holderOf = (binding: CloudNativeToolBinding) => `job.${binding.jobId.toLowerCase()}.${lease}`;
	const proveBinding = vi.fn(async (binding: CloudNativeToolBinding, holder: string) => {
		if (holder !== holderOf(binding)) throw new Error("native binding proof is refused");
	});
	const http = new HttpCloudCodingCommandService({
		token,
		proveBinding,
		authorize: async () => {
			throw new Error("not a coding command");
		},
		execute: async () => {
			throw new Error("not a coding command");
		},
		machines: {
			authorize: (request) => authorize(request),
			execute: (request) => execute(request),
			...(wake ? { wake: (request: CloudMachineWakeHttpRequest) => wake(request) } : {}),
		},
	});
	const port = await http.start();
	cleanups.push(() => http.close());
	return { token, url: `http://127.0.0.1:${port}`, lease, holderOf, proveBinding };
}

/** The executor's control as production has it (F33 of #1661): a closed method set (CodingExecutorHttpControl), so a
 * route that calls a method outside it fails here as it would there. */
function closed<
	T extends { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
>(control: T): T {
	return {
		...control,
		call: async (method: string, args: Record<string, unknown>, signal: AbortSignal) => {
			if (!CODING_CONTROL_METHODS.has(method)) throw new Error("CODING_CONTROL_METHOD_INVALID");
			return control.call(method, args, signal);
		},
	};
}

describe("machine command gateway", () => {
	it("round-trips a command on the coding executor's ingress, authorized before and after it runs", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID(),
			commandId = randomUUID(),
			inputSha256 = "a".repeat(64);
		const authorize = vi.fn(async () => ({ inputSha256 }));
		const execute = vi.fn(async (_request: CloudMachineCommandHttpRequest) =>
			receiptFor(machineId, commandId, inputSha256),
		);
		const { token, url, holderOf, proveBinding } = await service(authorize, execute);
		const gateway = createHttpCloudMachineCommandGateway({
			url,
			token,
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
		});
		const input = { commandId, inputSha256, command: "docker compose up -d", timeoutMs: null, notify: true };
		expect(await gateway.start({ machineId }, input, new AbortController().signal)).toEqual(
			receiptFor(machineId, commandId, inputSha256),
		);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(proveBinding).toHaveBeenCalledWith(binding, holderOf(binding), expect.any(AbortSignal));
		expect(execute.mock.calls[0]?.[0]).toEqual({
			schema: "qorpera.machine-command-http/v1",
			binding,
			scope: { machineId },
			action: "start",
			input,
		});
		// The machine stopped just after the guest started the command: the start still stands.
		authorize
			.mockResolvedValueOnce({ inputSha256 })
			.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_NOT_RUNNING"));
		expect(await gateway.start({ machineId }, input, new AbortController().signal)).toEqual(
			receiptFor(machineId, commandId, inputSha256),
		);
	});

	it("asks for no more of a page than the executor said it takes, the legacy 16,384 until it says (keyholes S1)", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID(),
			commandId = randomUUID(),
			inputSha256 = "a".repeat(64);
		const execute = vi.fn(async (_request: CloudMachineCommandHttpRequest) =>
			receiptFor(machineId, commandId, inputSha256),
		);
		const { token, url, holderOf } = await service(async () => ({ inputSha256 }), execute);
		const pages = new CloudCommandPages();
		const gateway = createHttpCloudMachineCommandGateway({
			url,
			token,
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
			pages,
		});
		const signal = new AbortController().signal;
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		expect(execute.mock.calls.map(([request]) => (request.action === "read" ? request.input.limit : null))).toEqual([
			16384, 31968,
		]);
		// An executor's own gateway to a peer learns the same way (MachineCommandRouter keeps one memory for its peers).
		expect(pages.of(url)).toBe(65536);
	});

	it("asks a read once more, for what the executor takes, when it stopped saying so under this process", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID(),
			commandId = randomUUID(),
			inputSha256 = "a".repeat(64),
			stopped = randomUUID(),
			proxied = randomUUID();
		const limits: unknown[] = [];
		// This tree's executor first; then one from before keyholes S1 behind the same origin (rolled back): it refuses a
		// page past 16,384 (403) and answers without the header. A refusal of a machine that stopped (409) stands.
		let rolledBack = false;
		const token = randomBytes(32).toString("base64url");
		const executor = createServer(async (request, reply) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			limits.push(body.input.limit);
			const said = rolledBack ? {} : { "x-qorpera-command-page-bytes": "65536" };
			// A proxy in front of the executor that answers for it (502), without the header.
			if (body.scope.machineId === proxied) {
				reply.writeHead(502, { "content-type": "text/html" });
				reply.end("<html>Bad Gateway</html>");
				return;
			}
			const [status, answer] =
				body.scope.machineId === stopped
					? [409, { code: "MACHINE_NOT_RUNNING" }]
					: rolledBack && body.input.limit > 16384
						? [403, { error: "coding_command_unavailable" }]
						: [200, receiptFor(machineId, commandId, inputSha256)];
			reply.writeHead(status, { "content-type": "application/json", ...said });
			reply.end(JSON.stringify(answer));
		});
		await new Promise<void>((resolve) => executor.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise((resolve) => executor.close(() => resolve())));
		const address = executor.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const gateway = createHttpCloudMachineCommandGateway({
			url: `http://127.0.0.1:${address.port}`,
			token,
			binding,
			holder: null,
			allowLoopback: true,
			pages: new CloudCommandPages(),
		});
		const signal = new AbortController().signal;
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		rolledBack = true;
		await expect(
			gateway.read({ machineId: stopped }, { commandId, offset: 0, limit: 31968 }, signal),
		).rejects.toThrow("MACHINE_NOT_RUNNING");
		// The 409 above said nothing: the executor takes the legacy page from now on, and is asked for it.
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		expect(limits).toEqual([16384, 31968, 16384]);
		rolledBack = false;
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		rolledBack = true;
		await expect(gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal)).resolves.toMatchObject({
			commandId,
		});
		expect(limits).toEqual([16384, 31968, 16384, 16384, 31968, 16384]);
		// A proxy's failure without the header is unanswered, and never asked again.
		rolledBack = false;
		await gateway.read({ machineId }, { commandId, offset: 0, limit: 31968 }, signal);
		await expect(
			gateway.read({ machineId: proxied }, { commandId, offset: 0, limit: 31968 }, signal),
		).rejects.toThrow(CloudMachineCommandUnanswered);
		expect(limits.slice(6)).toEqual([16384, 31968]);
	});

	it("tells the agent a machine is not running by its code, and hides every other failure", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		let refusal: Error = new CloudMachineCommandRefusal("MACHINE_NOT_RUNNING");
		const { token, url, holderOf } = await service(
			async () => {
				throw refusal;
			},
			async () => ({}),
		);
		const gateway = createHttpCloudMachineCommandGateway({
			url,
			token,
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
		});
		const read = () =>
			gateway.read({ machineId }, { commandId: randomUUID(), offset: 0, limit: 4096 }, new AbortController().signal);
		await expect(read()).rejects.toThrow("MACHINE_NOT_RUNNING");
		refusal = new Error("MACHINE_COMMAND_AUTHORITY_INVALID");
		await expect(read()).rejects.toThrow("Machine command gateway unavailable");
		// A wrong token is refused before any authority is asked.
		const other = createHttpCloudMachineCommandGateway({
			url,
			token: randomBytes(32).toString("base64url"),
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
		});
		await expect(other.cancel({ machineId }, randomUUID(), new AbortController().signal)).rejects.toThrow(
			"Machine command gateway unavailable",
		);
	});

	it("tells a request the executor did not answer from one it answered", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		const read = (fetch: typeof globalThis.fetch) =>
			createHttpCloudMachineCommandGateway({
				url: "https://executor.example/",
				token: randomBytes(32).toString("base64url"),
				binding,
				holder: () => "holder",
				fetch,
			}).read({ machineId }, { commandId: randomUUID(), offset: 0, limit: 4096 }, new AbortController().signal);
		// Its connection failed, or a proxy in front of it answered: nothing is known of the request.
		await expect(
			read((async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch),
		).rejects.toBeInstanceOf(CloudMachineCommandUnanswered);
		for (const status of [502, 503, 504, 524])
			await expect(read((async () => new Response("", { status })) as typeof fetch)).rejects.toBeInstanceOf(
				CloudMachineCommandUnanswered,
			);
		// The executor's own answers.
		for (const status of [403, 404]) {
			const answered = read((async () => new Response("{}", { status })) as typeof fetch);
			await expect(answered).rejects.toThrow("Machine command gateway unavailable");
			await expect(answered).rejects.not.toBeInstanceOf(CloudMachineCommandUnanswered);
		}
		const refused = read(
			(async () => new Response(JSON.stringify({ code: "MACHINE_NOT_RUNNING" }), { status: 409 })) as typeof fetch,
		);
		await expect(refused).rejects.toBeInstanceOf(CloudMachineCommandRefusal);
		// No answer within the request's 30 s.
		vi.useFakeTimers();
		try {
			const late = read(
				((_input: string | URL | Request, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
					})) as typeof fetch,
			);
			const expected = expect(late).rejects.toBeInstanceOf(CloudMachineCommandUnanswered);
			await vi.advanceTimersByTimeAsync(30_000);
			await expected;
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries why the machine lost a command that already ended, and drops a cause it does not know (6e-2a)", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		let refusal: Error = new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED", "moved_unreadable");
		const { token, url, holderOf } = await service(
			async () => {
				throw refusal;
			},
			async () => ({}),
		);
		const gateway = createHttpCloudMachineCommandGateway({
			url,
			token,
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
		});
		const refused = () =>
			gateway
				.read({ machineId }, { commandId: randomUUID(), offset: 0, limit: 4096 }, new AbortController().signal)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
		const ended = await refused();
		expect(ended).toBeInstanceOf(CloudMachineCommandRefusal);
		expect(ended).toMatchObject({ code: "MACHINE_COMMAND_ENDED", folderLost: "moved_unreadable" });
		refusal = new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED");
		const plain = await refused();
		expect(plain).toMatchObject({ code: "MACHINE_COMMAND_ENDED" });
		expect(plain).not.toHaveProperty("folderLost");
		// A peer's cause outside the six is not the folder's: the refusal stands without it.
		refusal = new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED", "moved_elsewhere");
		const unknown = await refused();
		expect(unknown).toMatchObject({ code: "MACHINE_COMMAND_ENDED" });
		expect(unknown).not.toHaveProperty("folderLost");
	});

	it("refuses a receipt for another machine or command", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID(),
			commandId = randomUUID();
		const { token, url, holderOf } = await service(
			async () => ({ inputSha256: "a".repeat(64) }),
			async () => receiptFor(randomUUID(), commandId, "a".repeat(64)),
		);
		const gateway = createHttpCloudMachineCommandGateway({
			url,
			token,
			binding,
			holder: () => holderOf(binding),
			allowLoopback: true,
		});
		await expect(gateway.cancel({ machineId }, commandId, new AbortController().signal)).rejects.toThrow(
			"Machine command gateway unavailable",
		);
	});

	it("asks nothing about a command without the run's own lease, not even a start's record (G2-6b)", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID(),
			commandId = randomUUID(),
			inputSha256 = "a".repeat(64);
		const authorize = vi.fn(async () => ({ inputSha256 }));
		const execute = vi.fn(async () => receiptFor(machineId, commandId, inputSha256));
		const { token, url, lease, holderOf, proveBinding } = await service(authorize, execute);
		const input = { commandId, inputSha256, command: "docker compose up -d", timeoutMs: null, notify: true };
		// A malformed holder, another run's, or another lease token for this run's job.
		for (const holder of [
			"",
			lease,
			`identity.${lease}`,
			`${holderOf(binding)}x`,
			`job.${randomUUID()}.${lease}`,
			`job.${binding.jobId.toLowerCase()}.${"W".repeat(43)}`,
		]) {
			const gateway = createHttpCloudMachineCommandGateway({
				url,
				token,
				binding,
				holder: () => holder,
				allowLoopback: true,
			});
			await expect(gateway.start({ machineId }, input, new AbortController().signal)).rejects.toThrow(
				"Machine command gateway unavailable",
			);
		}
		expect(authorize).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		// Only the two well-formed holders reached the proof.
		expect(proveBinding).toHaveBeenCalledTimes(2);
		// A gateway without a holder (an executor's, for its peer) is refused on this guest-facing listener too.
		const peer = createHttpCloudMachineCommandGateway({ url, token, binding, holder: null, allowLoopback: true });
		await expect(peer.start({ machineId }, input, new AbortController().signal)).rejects.toThrow(
			"Machine command gateway unavailable",
		);
		expect(authorize).not.toHaveBeenCalled();
	});
});

describe("a machine wake", () => {
	const nothing = async () => {
		throw new Error("not a command");
	};
	const wakeFixture = async (wake: (request: CloudMachineWakeHttpRequest) => Promise<boolean>) => {
		const { binding } = nativeToolAuthorityFixture();
		const started = await service(nothing, nothing, wake);
		return {
			...started,
			binding,
			gateway: createHttpCloudMachineCommandGateway({
				url: started.url,
				token: started.token,
				binding,
				holder: () => started.holderOf(binding),
				allowLoopback: true,
			}),
		};
	};
	const scope = { machineId: randomUUID() };

	it("reaches the machines' executors with the run's own lease and answers what they said", async () => {
		const wake = vi.fn(async (request: CloudMachineWakeHttpRequest) => request.input.wait);
		const f = await wakeFixture(wake);
		const signal = new AbortController().signal;
		expect(await f.gateway.wake?.(scope, true, signal)).toBe(true);
		expect(await f.gateway.wake?.(scope, false, signal)).toBe(false);
		expect(wake.mock.calls.map(([request]) => [request.scope, request.input])).toEqual([
			[scope, { wait: true }],
			[scope, { wait: false }],
		]);
		expect(f.proveBinding).toHaveBeenCalledTimes(2);
	});

	it("asks nothing without the run's own lease, and a wrong token or shape is refused", async () => {
		const wake = vi.fn(async () => true);
		const f = await wakeFixture(wake);
		const signal = new AbortController().signal;
		const stranger = createHttpCloudMachineCommandGateway({
			url: f.url,
			token: f.token,
			binding: f.binding,
			holder: () => `job.${f.binding.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`,
			allowLoopback: true,
		});
		await expect(stranger.wake?.(scope, true, signal)).rejects.toThrow();
		const wrongToken = createHttpCloudMachineCommandGateway({
			url: f.url,
			token: randomBytes(32).toString("base64url"),
			binding: f.binding,
			holder: () => f.holderOf(f.binding),
			allowLoopback: true,
		});
		await expect(wrongToken.wake?.(scope, true, signal)).rejects.toThrow();
		await expect(f.gateway.wake?.({ machineId: "not-a-machine" }, true, signal)).rejects.toThrow();
		const raw = await fetch(`${f.url}/v1/machine-commands/wake`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${f.token}`,
				"content-type": "application/json",
				"x-qorpera-identity": f.holderOf(f.binding),
			},
			body: JSON.stringify({
				schema: "qorpera.machine-command-http/v1",
				binding: f.binding,
				scope,
				action: "wake",
				input: { wait: true, machine: "other" },
			}),
		});
		expect(raw.status).toBe(403);
		expect(wake).not.toHaveBeenCalled();
	});

	it("an executor without the route refuses it, as a run's tool takes it", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const started = await service(nothing, nothing);
		const gateway = createHttpCloudMachineCommandGateway({
			url: started.url,
			token: started.token,
			binding,
			holder: () => started.holderOf(binding),
			allowLoopback: true,
		});
		await expect(gateway.wake?.(scope, true, new AbortController().signal)).rejects.toThrow();
	});
});

describe("a machine wake's route", () => {
	const peers = [
		{
			owner: "mx-b",
			providerId: "machine-node",
			origin: "https://node-b.example",
			tokenCredential: "qorpera-coding-peer-b",
		},
	];
	const request = (): CloudMachineWakeHttpRequest => ({
		schema: "qorpera.machine-command-http/v1",
		binding: nativeToolAuthorityFixture().binding,
		scope: { machineId: randomUUID() },
		action: "wake",
		input: { wait: true },
	});
	const router = (options: {
		wakeLocal?: (machineId: string, wait: boolean, signal: AbortSignal) => Promise<boolean>;
		told?: boolean;
		fails?: boolean;
		urls?: string[];
	}) =>
		new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers,
			control: closed({ call: vi.fn() }),
			credential: async () => randomBytes(32).toString("base64url"),
			...(options.wakeLocal ? { wakeLocal: options.wakeLocal } : {}),
			fetch: (async (input: string | URL | Request) => {
				options.urls?.push(String(input));
				if (options.fails) throw new Error("unreachable");
				return new Response(JSON.stringify({ schema: "qorpera.machine-wake/v1", told: options.told ?? false }));
			}) as typeof fetch,
		});
	const signal = new AbortController().signal;

	it("goes to this node's machines and to every peer, and this node's answer stands", async () => {
		const urls: string[] = [];
		const wakeLocal = vi.fn(async () => true);
		expect(await router({ wakeLocal, urls }).wake(request(), signal)).toBe(true);
		expect(wakeLocal).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(urls).toEqual(["https://node-b.example/v1/machine-commands/wake"]));
	});

	it("a peer never forwards it", async () => {
		const urls: string[] = [];
		const wakeLocal = vi.fn(async () => false);
		expect(await router({ wakeLocal, urls }).wake(request(), signal, true)).toBe(false);
		expect(urls).toEqual([]);
	});

	it("a peer's word counts beside this node's, when the machine is on the peer (review F3)", async () => {
		expect(await router({ wakeLocal: async () => false, told: true }).wake(request(), signal)).toBe(true);
	});

	it("an executor's ingress and peer listener route a wake to the router, the peer listener never forwarding", async () => {
		const urls: string[] = [];
		const routed = router({ wakeLocal: async () => true, urls });
		expect(await machineCommandRoutes(routed, { call: vi.fn() }, true).wake(request(), signal)).toBe(true);
		expect(urls).toEqual([]);
		expect(await machineCommandRoutes(routed, { call: vi.fn() }, false).wake(request(), signal)).toBe(true);
		await vi.waitFor(() => expect(urls).toEqual(["https://node-b.example/v1/machine-commands/wake"]));
	});

	it("reaches this node's machines: a word to wait on, or only a pass", async () => {
		const host = { wake: vi.fn(), changed: vi.fn(async () => true) };
		const reach = localMachineWake(host);
		const machineId = randomUUID();
		expect(await reach(machineId, true, signal)).toBe(true);
		expect(host.changed).toHaveBeenCalledWith(machineId, signal);
		expect(await reach(machineId, false, signal)).toBe(false);
		expect(host.wake).toHaveBeenCalledOnce();
	});

	it("without machines here, a peer's word answers, and one out of reach is no error", async () => {
		expect(await router({ told: true }).wake(request(), signal)).toBe(true);
		expect(await router({ told: false }).wake(request(), signal)).toBe(false);
		expect(await router({ fails: true }).wake(request(), signal)).toBe(false);
		expect(await router({}).wake(request(), signal, true)).toBe(false);
	});

	it("catches local wake failures without unhandled rejections and still honors peer answers", async () => {
		const failingLocal = async () => {
			throw new Error("local wake boom");
		};
		expect(await router({ wakeLocal: failingLocal, told: true }).wake(request(), signal)).toBe(true);
		expect(await router({ wakeLocal: failingLocal, told: false }).wake(request(), signal)).toBe(false);
		expect(
			await router({ wakeLocal: failingLocal, told: false }).wake({ ...request(), input: { wait: false } }, signal),
		).toBe(false);
	});
});

describe("machine command authority", () => {
	function fixture(timeoutMs: number | null = null, notify = true) {
		const { authority, binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		const command = "npm ci && npm run test:hosted-db € 😀";
		const inputSha256 = createHash("sha256")
			.update(
				cloudNativeToolOperationEnvelope(authority.identity, {
					tool: "machine_run",
					toolVersion: CLOUD_MACHINE_TOOL_VERSION,
					logicalOperationKey: "suite:1",
					arguments: {
						operationKey: "suite:1",
						machine: "build-a",
						command,
						notify,
						...(timeoutMs === null ? {} : { timeoutMs }),
					},
					target: { realm: "company_machine", machineId },
					requiresCompanyRevision: false,
				}),
			)
			.digest("hex");
		const request: CloudMachineCommandHttpRequest = {
			schema: "qorpera.machine-command-http/v1",
			binding,
			scope: { machineId },
			action: "start",
			input: { commandId: randomUUID(), inputSha256, command, timeoutMs, notify },
		};
		const answer = {
			schema: "qorpera.machine-command-authority/v1",
			state: "authorized",
			machineId,
			machine: "build-a",
			placementId: "00000000-0000-4000-8000-000000000066",
			commandId: request.input.commandId,
			inputSha256,
			operationKey: "suite:1",
			runId: binding.runId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			instanceSha256: "b".repeat(64),
			bootId: randomUUID(),
			identity: authority.identity,
		};
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>) => answer as unknown);
		return { request, call, answer, inputSha256, signal: new AbortController().signal };
	}
	it("rebuilds the machine_run receipt's exact operation from the request", async () => {
		const f = fixture(90000);
		expect(await authorizeMachineCommand(f, f.request, f.signal)).toEqual({
			inputSha256: f.inputSha256,
			machineId: f.request.scope.machineId,
			placementId: "00000000-0000-4000-8000-000000000066",
			machine: "build-a",
			executorOwner: "mx-a",
			providerId: "machine-node",
			// The boot a start waits for, and who its folder window credits (F3 6d).
			bootId: f.answer.bootId,
			runId: f.answer.identity.runId,
			staffAgentId: f.answer.identity.staffAgentId,
			requestedByUserId: f.answer.identity.requesterUserId,
			folderLost: null,
		});
		// Before the machine's first boot, there is none.
		f.call.mockResolvedValueOnce({ ...f.answer, bootId: null });
		expect(await authorizeMachineCommand(f, f.request, f.signal)).toMatchObject({ bootId: null });
		// A command its machine lost for its folder: why, in SQL's word (F3 6e-2a).
		for (const folderLost of [null, "restart_unproven", "moved_unreadable"]) {
			f.call.mockResolvedValueOnce({ ...f.answer, folderLost });
			expect(await authorizeMachineCommand(f, f.request, f.signal)).toMatchObject({ folderLost });
		}
		expect(f.call.mock.calls[0]?.[1]).toMatchObject({
			p_action: "start",
			p_detail: { commandHead: "npm ci && npm run test:hosted-db € 😀", notify: true },
		});
	});
	it.each([{ command: "rm -rf /" }, { timeoutMs: 1000 }, { notify: false }])(
		"refuses a start that differs from its receipt: %o",
		async (change) => {
			const f = fixture();
			if (f.request.action !== "start") throw new Error("fixture");
			await expect(
				authorizeMachineCommand(
					f,
					{ ...f.request, input: { ...f.request.input, ...change } } as CloudMachineCommandHttpRequest,
					f.signal,
				),
			).rejects.toThrow("MACHINE_COMMAND_INPUT_DIFFERS");
		},
	);
	it("turns SQL's not-running answer into the agent's refusal", async () => {
		const f = fixture();
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-command-authority/v1",
			state: "refused",
			reason: "MACHINE_NOT_RUNNING",
		});
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toBeInstanceOf(CloudMachineCommandRefusal);
		// A start SQL gave up (lost before it reached the guest) is never started late.
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-command-authority/v1",
			state: "refused",
			reason: "MACHINE_COMMAND_ENDED",
		});
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toMatchObject({
			code: "MACHINE_COMMAND_ENDED",
		});
		// A command its machine lost when it moved to a new disk says why (6e-2a); a cause SQL never sends is no answer.
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-command-authority/v1",
			state: "refused",
			reason: "MACHINE_COMMAND_ENDED",
			folderLost: "moved_starter",
		});
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toMatchObject({
			code: "MACHINE_COMMAND_ENDED",
			folderLost: "moved_starter",
		});
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-command-authority/v1",
			state: "refused",
			reason: "MACHINE_COMMAND_ENDED",
			folderLost: "moved",
		});
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
			"MACHINE_COMMAND_AUTHORITY_INVALID",
		);
		// An answer without the placement it runs on is no authority.
		f.call.mockResolvedValueOnce({ ...f.answer, placementId: undefined });
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
			"MACHINE_COMMAND_AUTHORITY_INVALID",
		);
		// Nor is one whose boot is not a boot id, or that loses a command for a cause the executor does not know.
		for (const bootId of [undefined, "boot-1", 7]) {
			f.call.mockResolvedValueOnce({ ...f.answer, bootId });
			await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
				"MACHINE_COMMAND_AUTHORITY_INVALID",
			);
		}
		for (const folderLost of ["restart", "x", 7, ""]) {
			f.call.mockResolvedValueOnce({ ...f.answer, folderLost });
			await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
				"MACHINE_COMMAND_AUTHORITY_INVALID",
			);
		}
	});
	it("passes a peer's refusal on as the same refusal", async () => {
		const f = fixture();
		const forwarded: Headers[] = [];
		let answer: Record<string, string> = { code: "MACHINE_NOT_RUNNING" };
		const router = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers: [
				{
					owner: "mx-a",
					providerId: "machine-node",
					origin: "https://node-a.example",
					tokenCredential: "qorpera-coding-peer-a",
				},
			],
			control: f,
			credential: async () => randomBytes(32).toString("base64url"),
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				forwarded.push(new Headers(init?.headers));
				return new Response(JSON.stringify(answer), { status: 409 });
			}) as typeof fetch,
		});
		await expect(router.execute(f.request, f.signal)).rejects.toMatchObject({ code: "MACHINE_NOT_RUNNING" });
		// The peer listener takes no holder: this executor proved the guest's at its own ingress (G2-6b).
		expect(forwarded.map((headers) => headers.has("x-qorpera-identity"))).toEqual([false]);
		// Why the peer's machine lost the command reaches the agent too (6e-2a).
		answer = { code: "MACHINE_COMMAND_ENDED", folderLost: "moved_unchecked" };
		await expect(router.execute(f.request, f.signal)).rejects.toMatchObject({
			code: "MACHINE_COMMAND_ENDED",
			folderLost: "moved_unchecked",
		});
	});
	it("routes to this node, or only to a peer in the allowlist, and a peer never forwards", async () => {
		const f = fixture();
		const executeLocal = vi.fn(
			async (): Promise<CloudMachineCommandReceipt> =>
				receiptFor(
					f.request.scope.machineId,
					f.request.input.commandId,
					f.inputSha256,
				) as CloudMachineCommandReceipt,
		);
		const peers = [
			{
				owner: "mx-b",
				providerId: "machine-node",
				origin: "https://node-b.example",
				tokenCredential: "qorpera-coding-peer-b",
			},
		];
		const local = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers,
			control: f,
			credential: async () => "",
			executeLocal,
		});
		await local.execute(f.request, f.signal);
		expect(executeLocal).toHaveBeenCalledTimes(1);
		const other = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers,
			control: f,
			credential: async () => "",
		});
		await expect(other.execute(f.request, f.signal)).rejects.toThrow("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		await expect(other.execute(f.request, f.signal, true)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		const noMachines = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers,
			control: f,
			credential: async () => "",
		});
		await expect(noMachines.execute(f.request, f.signal)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
	});
});

// The agent's home: the router opens a session's channel on its own node's machine. The one failure the run is told
// in words of its own (the machine's Codex is not the pinned build) leaves as a refusal with its reason, so the
// ingress passes it on and the model reads HOME_OUTDATED, not "could not be reached"; any other failure stays as it
// is (review r1 of #1817, F2).
describe("a home session's channel through the router", () => {
	const authority = (): CloudHomeSessionAuthorized => ({
		state: "authorized",
		sessionId: randomUUID(),
		machineId: randomUUID(),
		machine: "machine",
		placementId: randomUUID(),
		bootId: randomUUID(),
		executorOwner: "mx-a",
		providerId: "machine-node",
	});
	const request = (kind: "exec" | "sftp" = "exec") => ({
		binding: nativeToolAuthorityFixture().binding,
		holder: undefined,
		kind,
	});
	const router = (
		execServerLocal?: (
			authority: { sessionId: string; placementId: string; bootId: string; kind: "exec" | "sftp" },
			signal: AbortSignal,
		) => Promise<CloudHomeChannelSide>,
	) =>
		new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: {
				call: async () => {
					throw new Error("no SQL in this test");
				},
			},
			credential: async () => "",
			...(execServerLocal ? { execServerLocal } : {}),
		});

	it("opens the channel on its own node's machine with what SQL authorized", async () => {
		const side: CloudHomeChannelSide = {
			write: () => undefined,
			lines: (async function* () {})(),
			close: async () => undefined,
		};
		const execServerLocal = vi.fn(async () => side);
		const session = authority();
		const signal = AbortSignal.timeout(5_000);
		expect(await router(execServerLocal).execServer(session, request(), signal)).toBe(side);
		expect(execServerLocal).toHaveBeenCalledTimes(1);
		expect(execServerLocal).toHaveBeenCalledWith({ ...session, kind: "exec" }, signal);
		// The file channel (slice C1): the same session, its kind carried to the machine's side.
		const files = authority();
		expect(await router(execServerLocal).execServer(files, request("sftp"), signal)).toBe(side);
		expect(execServerLocal).toHaveBeenLastCalledWith({ ...files, kind: "sftp" }, signal);
	});

	it("passes on that the machine's Codex is not the pinned build, as a refusal with its reason", async () => {
		const failed = await router(async () => {
			throw new Error("HOME_CODEX_NOT_PINNED");
		})
			.execServer(authority(), request(), AbortSignal.timeout(5_000))
			.catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(CloudHomeChannelRefused);
		expect((failed as CloudHomeChannelRefused).reason).toBe("HOME_CODEX_NOT_PINNED");
		// A file channel on a machine whose image has no sftp-server (slice C1): the same, with its own reason.
		const missing = await router(async () => {
			throw new Error("HOME_SFTP_MISSING");
		})
			.execServer(authority(), request("sftp"), AbortSignal.timeout(5_000))
			.catch((error: unknown) => error);
		expect(missing).toBeInstanceOf(CloudHomeChannelRefused);
		expect((missing as CloudHomeChannelRefused).reason).toBe("HOME_SFTP_MISSING");
	});

	it("leaves any other failure of the machine's side as it is, and refuses a machine it does not hold", async () => {
		const failure = new Error("COMPANY_MACHINE_COMMAND_INVALID");
		await expect(
			router(async () => {
				throw failure;
			}).execServer(authority(), request(), AbortSignal.timeout(5_000)),
		).rejects.toBe(failure);
		const refusal = new CloudHomeChannelRefused("HOME_SESSION_ENDED");
		await expect(
			router(async () => {
				throw refusal;
			}).execServer(authority(), request(), AbortSignal.timeout(5_000)),
		).rejects.toBe(refusal);
		await expect(router().execServer(authority(), request(), AbortSignal.timeout(5_000))).rejects.toThrow(
			"MACHINE_COMMAND_WRONG_EXECUTOR",
		);
		await expect(
			router(async () => {
				throw failure;
			}).execServer({ ...authority(), executorOwner: "mx-b" }, request(), AbortSignal.timeout(5_000)),
		).rejects.toThrow("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
	});
});

// 20260930705000: save_coding_value's route on the executor's ingress: SQL's read for the call's own receipt, the
// clipboard helper on the machine's node (or its peer), and the box back, or a refusal by its code.
describe("a machine's coding value", () => {
	const box = {
		schema: "qorpera.coding-value-machine-box/v1",
		ephemeralPublicKey: "ZXBo",
		iv: "aXY",
		tag: "dGFn",
		ciphertext: "Y2lwaGVy",
	};
	function fixture() {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		const commandId = randomUUID();
		const placementId = randomUUID();
		const bootId = randomUUID();
		const request: CloudMachineCodingValueHttpRequest = {
			schema: "qorpera.machine-command-http/v1",
			binding,
			scope: { machineId },
			action: "coding_value",
			input: { commandId, envelope: JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2" }) },
		};
		const target = {
			schema: "qorpera.coding-value-machine-target/v1",
			service: "npm",
			valuePattern: "^npm_[A-Za-z0-9]{36}$",
			variable: "npm_token",
			companyId: randomUUID(),
			companyMachineId: machineId,
			placementId,
			bootId,
			receiptId: commandId,
			capturePublicKey: "k".repeat(43),
		};
		const answer = {
			schema: "qorpera.machine-coding-value-authority/v1",
			state: "authorized",
			machineId,
			placementId,
			bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			receiptId: commandId,
			target,
			desktopGeneration: 4,
		};
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>) => answer as unknown);
		const host = {
			codingValue: vi.fn(async () => ({ box }) as { box: Record<string, string> } | { refused: string }),
			clearClipboard: vi.fn(
				async () =>
					({ cleared: true }) as
						| { cleared: boolean }
						| { refused: "MACHINE_BOOT_CHANGED" | "MACHINE_IMAGE_WITHOUT_CODING_VALUES" },
			),
		};
		const router = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call }),
			credential: async () => "",
			codingValueLocal: localMachineCodingValue(host),
			codingValueClearLocal: localMachineCodingValueClear(host),
		});
		return { binding, request, target, answer, call, host, router, signal: new AbortController().signal };
	}

	it("asks SQL for the call's own receipt, runs the helper on this node with SQL's target, and answers the box", async () => {
		const f = fixture();
		expect(await f.router.codingValue(f.request, f.signal)).toEqual({
			schema: "qorpera.machine-coding-value/v1",
			commandId: f.request.input.commandId,
			box,
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_authorize_machine_coding_value",
			{
				p_binding: f.binding,
				p_scope: f.request.scope,
				p_receipt_id: f.request.input.commandId,
				p_envelope: f.request.input.envelope,
			},
			f.signal,
		);
		// The lease generation SQL's read saw goes to the host's fence (v233 release review r1, F29 of #1661).
		expect(f.host.codingValue).toHaveBeenCalledWith(
			{
				placementId: f.answer.placementId,
				bootId: f.answer.bootId,
				receiptId: f.request.input.commandId,
				target: f.target,
				desktopGeneration: 4,
			},
			f.signal,
		);
	});

	it("clears the clipboard instead of reading it when SQL says a member held the desktop since, and refuses the agent either way (v233 release review r1, F32 of #1661)", async () => {
		const f = fixture();
		const clear = {
			schema: "qorpera.machine-coding-value-authority/v1",
			state: "clear",
			machineId: f.answer.machineId,
			placementId: f.answer.placementId,
			bootId: f.answer.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			receiptId: f.answer.receiptId,
			desktopGeneration: 6,
		};
		// Cleared and recorded, or not: nothing is read, and the agent hears what is true then, CLIPBOARD_EMPTY (copy the
		// key on the site and call again); DESKTOP_MEMBER_IN_CONTROL stays for a member who holds the desktop.
		for (const outcome of [{ cleared: true }, { cleared: false }]) {
			f.call.mockResolvedValueOnce(clear);
			f.host.clearClipboard.mockResolvedValueOnce(outcome);
			const error = await f.router.codingValue(f.request, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMachineCodingValueRefusal);
			expect(error).toMatchObject({ code: "CLIPBOARD_EMPTY" });
		}
		expect(f.host.clearClipboard).toHaveBeenCalledWith(
			{ placementId: f.answer.placementId, bootId: f.answer.bootId, desktopGeneration: 6 },
			f.signal,
		);
		expect(f.host.codingValue).not.toHaveBeenCalled();
		// Another boot, or an image without the helper: the agent's refusal by that code, as a read's would be.
		for (const refused of ["MACHINE_BOOT_CHANGED", "MACHINE_IMAGE_WITHOUT_CODING_VALUES"] as const) {
			f.call.mockResolvedValueOnce(clear);
			f.host.clearClipboard.mockResolvedValueOnce({ refused });
			await expect(f.router.codingValue(f.request, f.signal)).rejects.toMatchObject({ code: refused });
		}
		// A `clear` answer of another shape is no authority: nothing is cleared.
		for (const other of [
			{ machineId: randomUUID() },
			{ receiptId: randomUUID() },
			{ placementId: "placement" },
			{ desktopGeneration: -1 },
			{ desktopGeneration: "6" },
			{ target: f.target },
		]) {
			f.call.mockResolvedValueOnce({ ...clear, ...other });
			await expect(f.router.codingValue(f.request, f.signal), JSON.stringify(other)).rejects.toThrow(
				"MACHINE_CODING_VALUE_AUTHORITY_INVALID",
			);
		}
		expect(f.host.clearClipboard).toHaveBeenCalledTimes(4);
		// A machine no member held since its last clear: read as before.
		expect(await f.router.codingValue(f.request, f.signal)).toMatchObject({ box });
	});

	it("turns a stopped machine and the helper's codes into the agent's refusals, and anything else into a failure", async () => {
		const f = fixture();
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-coding-value-authority/v1",
			state: "refused",
			reason: "MACHINE_NOT_RUNNING",
			machine: "build-a",
		});
		await expect(f.router.codingValue(f.request, f.signal)).rejects.toMatchObject({ code: "MACHINE_NOT_RUNNING" });
		expect(f.host.codingValue).not.toHaveBeenCalled();
		for (const code of [
			"CLIPBOARD_EMPTY",
			"CLIPBOARD_MORE_THAN_ONE_KEY",
			"MACHINE_IMAGE_WITHOUT_CODING_VALUES",
			// The host's fence dropped the box: a member took the desktop over since the read (F29).
			"DESKTOP_MEMBER_IN_CONTROL",
		]) {
			f.host.codingValue.mockResolvedValueOnce({ refused: code });
			const error = await f.router.codingValue(f.request, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMachineCodingValueRefusal);
			expect(error).toMatchObject({ code });
		}
		f.host.codingValue.mockResolvedValueOnce({ refused: "SOMETHING_ELSE" });
		await expect(f.router.codingValue(f.request, f.signal)).rejects.toThrow("MACHINE_CODING_VALUE_FAILED");
		// SQL's read for another machine, receipt, placement or boot is no authority.
		for (const other of [
			{ machineId: randomUUID() },
			{ receiptId: randomUUID() },
			{ target: { ...f.target, placementId: randomUUID() } },
			{ target: { ...f.target, bootId: randomUUID() } },
			{ target: { ...f.target, schema: "qorpera.coding-value-capture-target/v1" } },
			{ target: null },
			{ executorOwner: "" },
			// F29: a read without the lease generation it saw is no authority.
			{ desktopGeneration: undefined },
			{ desktopGeneration: -1 },
			{ desktopGeneration: "4" },
			{ desktopGeneration: 1.5 },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer, ...other });
			await expect(
				authorizeMachineCodingValue({ call: f.call }, f.request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
		}
	});

	it("crosses the ingress with the run's own lease: the box back, a refusal as 409 with its code", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const lease = randomBytes(32).toString("base64url");
		const http = new HttpCloudCodingCommandService({
			token,
			proveBinding: async (binding, holder) => {
				if (holder !== `job.${binding.jobId.toLowerCase()}.${lease}`)
					throw new Error("native binding proof is refused");
			},
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(f.router, { call: f.call }, false) },
		});
		const port = await http.start();
		cleanups.push(() => http.close());
		const gateway = (holder: string) =>
			createHttpCloudMachineCommandGateway({
				url: `http://127.0.0.1:${port}`,
				token,
				binding: f.binding,
				holder: () => holder,
				allowLoopback: true,
			});
		const own = gateway(`job.${f.binding.jobId.toLowerCase()}.${lease}`);
		expect(await own.codingValue!(f.request.scope, f.request.input, f.signal)).toEqual({
			schema: "qorpera.machine-coding-value/v1",
			commandId: f.request.input.commandId,
			box,
		});
		f.host.codingValue.mockResolvedValueOnce({ refused: "CLIPBOARD_NOT_A_KEY" });
		await expect(own.codingValue!(f.request.scope, f.request.input, f.signal)).rejects.toMatchObject({
			code: "CLIPBOARD_NOT_A_KEY",
		});
		// Without the run's lease nothing is asked of SQL, and the machine is never reached.
		const calls = f.call.mock.calls.length;
		await expect(
			gateway(`job.${f.binding.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`).codingValue!(
				f.request.scope,
				f.request.input,
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
		expect(f.host.codingValue).toHaveBeenCalledTimes(2);
	});

	it("goes once to the peer whose node runs the machine, which never forwards, and its refusal stays the agent's", async () => {
		const f = fixture();
		const sent: string[] = [];
		const router = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
			],
			control: closed({ call: f.call }),
			credential: async () => randomBytes(32).toString("base64url"),
			fetch: (async (input: string | URL | Request) => {
				sent.push(String(input));
				return new Response(JSON.stringify({ code: "DESKTOP_NOT_RUNNING" }), { status: 409 });
			}) as typeof fetch,
		});
		await expect(router.codingValue(f.request, f.signal)).rejects.toMatchObject({ code: "DESKTOP_NOT_RUNNING" });
		expect(sent).toEqual(["https://node-a.example/v1/machine-commands/coding-value"]);
		await expect(router.codingValue(f.request, f.signal, true)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(sent).toHaveLength(1);
	});

	it("reads only its own request shape", () => {
		const f = fixture();
		expect(parseCloudMachineCodingValueHttpRequest(f.request)).toEqual(f.request);
		for (const bad of [
			{ ...f.request, action: "start" },
			{ ...f.request, input: { ...f.request.input, value: "npm_x" } },
			{ ...f.request, input: { ...f.request.input, commandId: "x" } },
			{ ...f.request, input: { ...f.request.input, envelope: "" } },
			{ ...f.request, input: { ...f.request.input, envelope: "x".repeat(65537) } },
			{ ...f.request, scope: { machineId: f.request.scope.machineId, placementId: randomUUID() } },
		])
			expect(() => parseCloudMachineCodingValueHttpRequest(bad)).toThrow("Machine command gateway unavailable");
	});
});

describe("a machine's account fill", () => {
	const box = {
		schema: "qorpera.company-account-fill-box/v1",
		ephemeralPublicKey: "ZXBo",
		iv: "aXY",
		tag: "dGFn",
		ciphertext: "Y2lw",
	};
	function fixture() {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		const commandId = randomUUID();
		const placementId = randomUUID();
		const bootId = randomUUID();
		const companyId = randomUUID();
		const request: CloudMachineAccountFillHttpRequest = {
			schema: "qorpera.machine-command-http/v1",
			binding,
			scope: { machineId },
			action: "account_fill",
			input: {
				commandId,
				envelope: JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2" }),
				idempotencyKey: "b".repeat(64),
			},
		};
		const target = {
			schema: "qorpera.machine-account-fill-target/v1",
			companyId,
			companyMachineId: machineId,
			placementId,
			bootId,
			receiptId: commandId,
			accountId: randomUUID(),
			field: "password",
			hosts: ["npmjs.com", "www.npmjs.com"],
		};
		const answer = {
			schema: "qorpera.machine-account-fill-authority/v1",
			state: "authorized",
			machineId,
			placementId,
			bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			receiptId: commandId,
			companyId,
			desktopGeneration: 4,
			target,
		};
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>) => answer as unknown);
		const vault = {
			seal: vi.fn(
				async () =>
					({ box }) as { box: Readonly<Record<string, string>> } | { refused: { code: string; message: string } },
			),
		};
		// The host runs the helper: it gets the helper's key, asks the vault through `seal`, and answers typed.
		const host = {
			accountFill: vi.fn(
				async (
					_run: unknown,
					seal: (publicKey: string, signal: AbortSignal) => ReturnType<typeof vault.seal>,
					signal: AbortSignal,
				) => {
					const sealed = await seal("k".repeat(43), signal);
					if ("refused" in sealed) return { vaultRefused: sealed.refused };
					return { filled: true as const } as
						| { filled: true }
						| { refused: string }
						| { vaultRefused: { code: string; message: string } };
				},
			),
		};
		const router = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call }),
			credential: async () => "",
			accountFillLocal: localMachineAccountFill(host, vault),
		});
		return {
			binding,
			request,
			target,
			answer,
			call,
			vault,
			host,
			router,
			companyId,
			signal: new AbortController().signal,
		};
	}

	it("asks SQL for the call's own receipt, runs the helper with SQL's target and has the vault seal to its key", async () => {
		const f = fixture();
		expect(await f.router.accountFill(f.request, f.signal)).toEqual({
			schema: "qorpera.machine-account-fill/v1",
			commandId: f.request.input.commandId,
			filled: true,
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_authorize_machine_account_fill",
			{
				p_binding: f.binding,
				p_scope: f.request.scope,
				p_receipt_id: f.request.input.commandId,
				p_envelope: f.request.input.envelope,
			},
			f.signal,
		);
		expect(f.host.accountFill).toHaveBeenCalledWith(
			{
				placementId: f.answer.placementId,
				bootId: f.answer.bootId,
				receiptId: f.request.input.commandId,
				desktopGeneration: 4,
				target: f.target,
			},
			expect.any(Function),
			f.signal,
		);
		// The vault gets the run's call, where the helper runs, and the helper's key: never a value.
		expect(f.vault.seal).toHaveBeenCalledWith(
			{
				companyId: f.companyId,
				binding: f.binding,
				receiptId: f.request.input.commandId,
				idempotencyKey: "b".repeat(64),
				envelope: f.request.input.envelope,
				placementId: f.answer.placementId,
				bootId: f.answer.bootId,
				fillPublicKey: "k".repeat(43),
			},
			f.signal,
		);
	});

	it("turns SQL's answers, the helper's codes and the vault's refusal into the agent's refusals, anything else a failure", async () => {
		const f = fixture();
		for (const reason of [
			"MACHINE_NOT_RUNNING",
			"ACCOUNTS_SWITCHED_OFF",
			"ACCOUNT_NOT_OPEN",
			"DESKTOP_MEMBER_IN_CONTROL",
		]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.machine-account-fill-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.accountFill(f.request, f.signal)).rejects.toMatchObject({ code: reason });
		}
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-account-fill-authority/v1",
			state: "refused",
			reason: "ELSE",
		});
		await expect(f.router.accountFill(f.request, f.signal)).rejects.toThrow("MACHINE_ACCOUNT_FILL_AUTHORITY_INVALID");
		expect(f.host.accountFill).not.toHaveBeenCalled();
		for (const code of ["FILL_WRONG_SITE", "SITE_STOP_CAPTCHA", "MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS", "FILL_LOST"]) {
			f.host.accountFill.mockResolvedValueOnce({ refused: code });
			const error = await f.router.accountFill(f.request, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMachineAccountFillRefusal);
			expect(error).toMatchObject({ code });
		}
		f.vault.seal.mockResolvedValueOnce({
			refused: { code: "22023", message: "The company has no such open account" },
		});
		await expect(f.router.accountFill(f.request, f.signal)).rejects.toMatchObject({
			code: "VAULT_REFUSED",
			vault: "The company has no such open account",
		});
		f.host.accountFill.mockResolvedValueOnce({ refused: "SOMETHING_ELSE" });
		await expect(f.router.accountFill(f.request, f.signal)).rejects.toThrow("MACHINE_ACCOUNT_FILL_FAILED");
		// SQL's read for another machine, receipt, company, placement or boot is no authority.
		for (const other of [
			{ machineId: randomUUID() },
			{ receiptId: randomUUID() },
			{ companyId: randomUUID() },
			{ target: { ...f.target, placementId: randomUUID() } },
			{ target: { ...f.target, bootId: randomUUID() } },
			{ target: { ...f.target, companyId: randomUUID() } },
			{ target: { ...f.target, schema: "qorpera.coding-value-machine-target/v1" } },
			{ target: null },
			{ executorOwner: "" },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer, ...other });
			await expect(
				authorizeMachineAccountFill({ call: f.call }, f.request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow("MACHINE_ACCOUNT_FILL_AUTHORITY_INVALID");
		}
	});

	it("crosses the ingress with the run's own lease: typed back, a refusal as 409 with its code and the vault's words", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const lease = randomBytes(32).toString("base64url");
		const http = new HttpCloudCodingCommandService({
			token,
			proveBinding: async (binding, holder) => {
				if (holder !== `job.${binding.jobId.toLowerCase()}.${lease}`)
					throw new Error("native binding proof is refused");
			},
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(f.router, { call: f.call }, false) },
		});
		const port = await http.start();
		cleanups.push(() => http.close());
		const gateway = (holder: string) =>
			createHttpCloudMachineCommandGateway({
				url: `http://127.0.0.1:${port}`,
				token,
				binding: f.binding,
				holder: () => holder,
				allowLoopback: true,
			});
		const own = gateway(`job.${f.binding.jobId.toLowerCase()}.${lease}`);
		expect(await own.accountFill!(f.request.scope, f.request.input, f.signal)).toEqual({
			schema: "qorpera.machine-account-fill/v1",
			commandId: f.request.input.commandId,
			filled: true,
		});
		f.host.accountFill.mockResolvedValueOnce({ refused: "FILL_IN_FRAME" });
		await expect(own.accountFill!(f.request.scope, f.request.input, f.signal)).rejects.toMatchObject({
			code: "FILL_IN_FRAME",
		});
		f.vault.seal.mockResolvedValueOnce({ refused: { code: "0A000", message: "Company accounts are switched off" } });
		const refused = await own.accountFill!(f.request.scope, f.request.input, f.signal).catch(
			(caught: unknown) => caught,
		);
		expect(refused).toBeInstanceOf(CloudMachineAccountFillRefusal);
		expect(refused).toMatchObject({ code: "VAULT_REFUSED", vault: "Company accounts are switched off" });
		// Without the run's lease nothing is asked of SQL, and the machine is never reached.
		const calls = f.call.mock.calls.length;
		await expect(
			gateway(`job.${f.binding.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`).accountFill!(
				f.request.scope,
				f.request.input,
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
		expect(f.host.accountFill).toHaveBeenCalledTimes(3);
	});

	it("goes once to the peer whose node runs the machine, which never forwards, and its refusal stays the agent's", async () => {
		const f = fixture();
		const sent: string[] = [];
		const router = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
			],
			control: closed({ call: f.call }),
			credential: async () => randomBytes(32).toString("base64url"),
			fetch: (async (input: string | URL | Request) => {
				sent.push(String(input));
				return new Response(JSON.stringify({ code: "NO_FOCUSED_PAGE" }), { status: 409 });
			}) as typeof fetch,
		});
		await expect(router.accountFill(f.request, f.signal)).rejects.toMatchObject({ code: "NO_FOCUSED_PAGE" });
		expect(sent).toEqual(["https://node-a.example/v1/machine-commands/account-fill"]);
		await expect(router.accountFill(f.request, f.signal, true)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(sent).toHaveLength(1);
		// An executor without a broker (or machines) runs no helper.
		const bare = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call: f.call }),
			credential: async () => "",
		});
		await expect(bare.accountFill(f.request, f.signal)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
	});

	it("reads only its own request shape", () => {
		const f = fixture();
		expect(parseCloudMachineAccountFillHttpRequest(f.request)).toEqual(f.request);
		for (const bad of [
			{ ...f.request, action: "coding_value" },
			{ ...f.request, input: { ...f.request.input, value: "hunter2" } },
			{ ...f.request, input: { ...f.request.input, commandId: "x" } },
			{ ...f.request, input: { ...f.request.input, envelope: "" } },
			{ ...f.request, input: { ...f.request.input, idempotencyKey: "short" } },
			{ ...f.request, scope: { machineId: f.request.scope.machineId, placementId: randomUUID() } },
		])
			expect(() => parseCloudMachineAccountFillHttpRequest(bad)).toThrow("Machine command gateway unavailable");
	});
});

describe("a machine's screen", () => {
	const header = (png: number) => ({
		schema: "qorpera.machine-screen/v1",
		started: false,
		action: { type: "click", exitCode: 0 },
		activeWindow: "Sign in - Chromium",
		windows: ["Sign in - Chromium"],
		moreWindows: 0,
		png,
	});
	const picture = Buffer.from("89504e470d0a1a0a0000000d4948445200000640000003e8", "hex");
	function fixture() {
		const { binding } = nativeToolAuthorityFixture();
		const machineId = randomUUID();
		const commandId = randomUUID();
		const placementId = randomUUID();
		const bootId = randomUUID();
		const runId = randomUUID();
		const action = { type: "click", x: 812, y: 443 };
		const request: CloudMachineScreenHttpRequest = {
			schema: "qorpera.machine-command-http/v1",
			binding,
			scope: { machineId },
			action: "screen",
			input: {
				commandId,
				envelope: JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2" }),
				settleMs: 500,
				look: true,
			},
		};
		const look: CloudMachineScreenHttpRequest = {
			...request,
			input: { commandId: null, envelope: null, settleMs: 0, look: true },
		};
		const answer = {
			schema: "qorpera.machine-screen-authority/v1",
			state: "authorized",
			machineId,
			placementId,
			bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			runId,
			staffAgentId: randomUUID(),
			requesterUserId: randomUUID(),
			receiptId: commandId,
			action,
			settleMs: 500,
			look: true,
			// The lease generation the read saw (20260930713000).
			desktopGeneration: 7,
			// F35 of #1661: no member held the desktop since its clipboard was last confirmed clear.
			clipboardClear: false,
		};
		const lookAnswer = { ...answer, receiptId: null, action: null, settleMs: null, look: null };
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) =>
			args.p_receipt_id === null ? lookAnswer : (answer as unknown),
		);
		const host = {
			screen: vi.fn(
				async () =>
					({ header: header(picture.length), png: picture }) as
						| { header: Record<string, unknown>; png: Buffer | null; heldBack?: string }
						| { refused: string },
			),
		};
		const router = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call }),
			credential: async () => "",
			screenLocal: localMachineScreen(host),
		});
		return { binding, request, look, answer, call, host, router, action, signal: new AbortController().signal };
	}

	it("asks SQL for the action its receipt holds, runs the helper on this node with it, and answers the screen", async () => {
		const f = fixture();
		expect(await f.router.screen(f.request, f.signal)).toEqual({
			schema: "qorpera.machine-screen-answer/v1",
			commandId: f.request.input.commandId,
			header: header(picture.length),
			png: picture.toString("base64"),
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_authorize_machine_screen",
			{
				p_binding: f.binding,
				p_scope: f.request.scope,
				p_receipt_id: f.request.input.commandId,
				p_envelope: f.request.input.envelope,
			},
			f.signal,
		);
		// The helper's request: SQL's action, never one the caller sent; the run that sees the screen takes in its reads.
		expect(f.host.screen).toHaveBeenCalledWith(
			{
				placementId: f.answer.placementId,
				bootId: f.answer.bootId,
				runId: f.answer.runId,
				request: {
					schema: "qorpera.machine-screen-request/v1",
					receiptId: f.request.input.commandId,
					action: f.action,
					settleMs: 500,
					look: true,
				},
				// The host's fence after the capture checks it (review r1 F1).
				desktopGeneration: 7,
				clearClipboard: false,
			},
			f.signal,
		);
		// A clear owed (F35): the host is told, and clears under the call's hold before it looks or acts.
		f.call.mockResolvedValueOnce({ ...f.answer, clipboardClear: true });
		await f.router.screen(f.request, f.signal);
		expect(f.host.screen).toHaveBeenLastCalledWith(expect.objectContaining({ clearClipboard: true }), f.signal);
		// A look: no receipt, no action, and the request's own settle and look.
		expect(await f.router.screen(f.look, f.signal)).toMatchObject({ commandId: null });
		expect(f.host.screen).toHaveBeenLastCalledWith(
			expect.objectContaining({
				request: {
					schema: "qorpera.machine-screen-request/v1",
					receiptId: null,
					action: null,
					settleMs: 0,
					look: true,
				},
			}),
			f.signal,
		);
		// A held picture comes back without it, with why.
		f.host.screen.mockResolvedValueOnce({
			header: { ...header(0), activeWindow: null, windows: [] },
			png: null,
			heldBack: "the company folder did not release what the machine read; read again",
		});
		expect(await f.router.screen(f.request, f.signal)).toMatchObject({
			png: null,
			heldBack: "the company folder did not release what the machine read; read again",
		});
	});

	it("turns a stopped machine and the helper's codes into the agent's refusals, and anything else into a failure", async () => {
		const f = fixture();
		f.call.mockResolvedValueOnce({
			schema: "qorpera.machine-screen-authority/v1",
			state: "refused",
			reason: "MACHINE_NOT_RUNNING",
			machine: "build-a",
		});
		await expect(f.router.screen(f.request, f.signal)).rejects.toMatchObject({ code: "MACHINE_NOT_RUNNING" });
		// A disk that has had a company folder view its caller may not see (review r1 F1): a look as much as an action.
		for (const request of [f.request, f.look]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.machine-screen-authority/v1",
				state: "refused",
				reason: "MACHINE_NEEDS_COMPANY_VIEW",
				machine: "build-a",
			});
			const error = await f.router.screen(request, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMachineScreenRefusal);
			expect(error).toMatchObject({ code: "MACHINE_NEEDS_COMPANY_VIEW" });
		}
		expect(f.host.screen).not.toHaveBeenCalled();
		for (const code of [
			"DESKTOP_BUSY",
			"SCREEN_ACTION_TAKEN",
			"MACHINE_BOOT_CHANGED",
			"MACHINE_IMAGE_WITHOUT_SCREEN",
			"DESKTOP_NOT_RUNNING",
			"DESKTOP_MACHINE_TOO_SMALL",
		]) {
			f.host.screen.mockResolvedValueOnce({ refused: code });
			const error = await f.router.screen(f.request, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMachineScreenRefusal);
			expect(error).toMatchObject({ code });
		}
		f.host.screen.mockResolvedValueOnce({ refused: "SOMETHING_ELSE" });
		await expect(f.router.screen(f.request, f.signal)).rejects.toThrow("MACHINE_SCREEN_FAILED");
		// SQL's read for another machine, receipt, placement, boot, run or action, or a look's with an action, is no
		// authority; nor an action whose settle or look is not the request's.
		for (const [request, other] of [
			[f.request, { machineId: randomUUID() }],
			[f.request, { receiptId: randomUUID() }],
			[f.request, { placementId: "x" }],
			[f.request, { bootId: null }],
			[f.request, { runId: "run" }],
			[f.request, { executorOwner: "" }],
			[f.request, { action: { type: "click", x: 4000, y: 1 } }],
			[f.request, { action: { type: "click", x: 1, y: 1, extra: true } }],
			[f.request, { action: null }],
			[f.request, { settleMs: 2500 }],
			[f.request, { look: false }],
			[f.request, { desktopGeneration: undefined }],
			[f.request, { desktopGeneration: -1 }],
			[f.request, { desktopGeneration: "7" }],
			[f.request, { clipboardClear: undefined }],
			[f.request, { clipboardClear: "true" }],
			[f.look, { receiptId: null, action: f.action, settleMs: null, look: null }],
			[f.look, { receiptId: null, action: null, settleMs: 500, look: null }],
		] as const) {
			f.call.mockResolvedValueOnce({ ...f.answer, ...other });
			await expect(
				authorizeMachineScreen({ call: f.call }, request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow("MACHINE_SCREEN_AUTHORITY_INVALID");
		}
	});

	it("crosses the ingress with the run's own lease: the screen back, a refusal as 409 with its code", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const lease = randomBytes(32).toString("base64url");
		const http = new HttpCloudCodingCommandService({
			token,
			proveBinding: async (binding, holder) => {
				if (holder !== `job.${binding.jobId.toLowerCase()}.${lease}`)
					throw new Error("native binding proof is refused");
			},
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(f.router, { call: f.call }, false) },
		});
		const port = await http.start();
		cleanups.push(() => http.close());
		const gateway = (holder: string) =>
			createHttpCloudMachineCommandGateway({
				url: `http://127.0.0.1:${port}`,
				token,
				binding: f.binding,
				holder: () => holder,
				allowLoopback: true,
			});
		const own = gateway(`job.${f.binding.jobId.toLowerCase()}.${lease}`);
		expect(await own.screen!(f.request.scope, f.request.input, f.signal)).toEqual({
			schema: "qorpera.machine-screen-answer/v1",
			commandId: f.request.input.commandId,
			header: header(picture.length),
			png: picture.toString("base64"),
		});
		// A real screenshot is far past a receipt's 128 KiB: the screen's own bound carries it.
		const large = Buffer.concat([picture, Buffer.alloc(3 * 1024 * 1024, 7)]);
		f.host.screen.mockResolvedValueOnce({ header: header(large.length), png: large });
		expect(await own.screen!(f.request.scope, f.request.input, f.signal)).toMatchObject({
			header: { png: large.length },
			png: large.toString("base64"),
		});
		f.host.screen.mockResolvedValueOnce({ refused: "SCREEN_ACTION_TAKEN" });
		const refused = await own.screen!(f.request.scope, f.request.input, f.signal).catch((caught: unknown) => caught);
		expect(refused).toBeInstanceOf(CloudMachineScreenRefusal);
		expect(refused).toMatchObject({ code: "SCREEN_ACTION_TAKEN" });
		// Without the run's lease nothing is asked of SQL, and the machine is never reached.
		const calls = f.call.mock.calls.length;
		await expect(
			gateway(`job.${f.binding.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`).screen!(
				f.request.scope,
				f.request.input,
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
		expect(f.host.screen).toHaveBeenCalledTimes(3);
	});

	it("goes once to the peer whose node runs the machine, which never forwards, and its refusal stays the agent's", async () => {
		const f = fixture();
		const sent: string[] = [];
		const router = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
			],
			control: closed({ call: f.call }),
			credential: async () => randomBytes(32).toString("base64url"),
			fetch: (async (input: string | URL | Request) => {
				sent.push(String(input));
				return new Response(JSON.stringify({ code: "DESKTOP_NOT_RUNNING" }), { status: 409 });
			}) as typeof fetch,
		});
		await expect(router.screen(f.request, f.signal)).rejects.toMatchObject({ code: "DESKTOP_NOT_RUNNING" });
		expect(sent).toEqual(["https://node-a.example/v1/machine-commands/screen"]);
		await expect(router.screen(f.request, f.signal, true)).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(sent).toHaveLength(1);
	});

	it("tells the agent who touched the shared screen until an answer that says so is ready: a busy call leaves it for the next (20260930734000, review r1 F4 of #1701)", async () => {
		const f = fixture();
		const at = "2026-11-12T15:16:59.123456+00:00";
		const touched = { name: "Dora Danske", secondsAgo: 12, at };
		const lookAnswer = { ...f.answer, receiptId: null, action: null, settleMs: null, look: null };
		// As SQL: every read says it until the executor's word for that action's time; a word may fail.
		let told: unknown = null;
		let wordFails = false;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_machine_desktop_shared_told") {
				if (wordFails) throw new Error("SQL unavailable");
				told = args.p_at;
				return { schema: "qorpera.machine-desktop-shared-told/v1", state: "ok" };
			}
			const read = args.p_receipt_id === null ? lookAnswer : f.answer;
			return (told === at ? read : { ...read, memberTouched: touched }) as unknown;
		});
		const words = () => f.call.mock.calls.filter(([method]) => method === "qorpera_machine_desktop_shared_told");
		// The desktop is busy with another step: refused, and SQL hears nothing.
		f.host.screen.mockResolvedValueOnce({ refused: "DESKTOP_BUSY" });
		await expect(f.router.screen(f.request, f.signal)).rejects.toMatchObject({ code: "DESKTOP_BUSY" });
		expect(words()).toEqual([]);
		// The next call is answered and says it: who and how long ago (never the time, never what); then SQL hears it.
		expect(await f.router.screen(f.look, f.signal)).toEqual({
			schema: "qorpera.machine-screen-answer/v1",
			commandId: null,
			header: header(picture.length),
			png: picture.toString("base64"),
			memberTouched: { name: "Dora Danske", secondsAgo: 12 },
		});
		// Beside the answer, with a bound of its own (review r2 F2 of #1701).
		expect(words()).toEqual([
			[
				"qorpera_machine_desktop_shared_told",
				{ p_machine_id: f.answer.machineId, p_at: at },
				expect.any(AbortSignal),
			],
		]);
		expect((words()[0] as unknown[])[2]).not.toBe(f.signal);
		expect(await f.router.screen(f.look, f.signal)).not.toHaveProperty("memberTouched");
		// A word SQL did not take fails nothing: the answer goes, and the next read says it again (twice, never lost).
		told = null;
		wordFails = true;
		expect(await f.router.screen(f.look, f.signal)).toMatchObject({ memberTouched: { name: "Dora Danske" } });
		wordFails = false;
		expect(await f.router.screen(f.look, f.signal)).toMatchObject({ memberTouched: { name: "Dora Danske" } });
		expect(await f.router.screen(f.look, f.signal)).not.toHaveProperty("memberTouched");
		// SQL's member names are 1 to 256 characters (code points, not UTF-16 units; review r1 F2 of #1701).
		const longest = "😀".repeat(256);
		f.call.mockResolvedValueOnce({ ...f.answer, memberTouched: { ...touched, name: longest } });
		expect(await authorizeMachineScreen({ call: f.call }, f.request, f.signal)).toMatchObject({
			memberTouched: { name: longest, secondsAgo: 12, at },
		});
		// SQL's word of any other shape is no authority.
		for (const other of [
			{ ...touched, name: "" },
			{ ...touched, name: "   " },
			{ ...touched, name: "😀".repeat(257) },
			{ ...touched, secondsAgo: -1 },
			{ ...touched, secondsAgo: 1.5 },
			{ name: "Dora", secondsAgo: 1 },
			{ ...touched, at: "yesterday" },
			{ ...touched, at: 1731424619 },
			{ ...touched, typed: "hunter2" },
			"Dora",
			null,
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer, memberTouched: other });
			await expect(
				authorizeMachineScreen({ call: f.call }, f.request, f.signal),
				JSON.stringify(other).slice(0, 80),
			).rejects.toThrow("MACHINE_SCREEN_AUTHORITY_INVALID");
		}
		// Forwarded: the peer's answer says it (its own read did), or, from a peer before, the forwarding read's is put in;
		// either way this executor tells SQL too.
		const peerAnswer = (memberTouched?: { name: string; secondsAgo: number }) =>
			new Response(
				JSON.stringify({
					schema: "qorpera.machine-screen-answer/v1",
					commandId: f.request.input.commandId,
					header: header(picture.length),
					png: picture.toString("base64"),
					...(memberTouched ? { memberTouched } : {}),
				}),
				{ status: 200 },
			);
		let peerSays: { name: string; secondsAgo: number } | undefined = { name: "Bob", secondsAgo: 0 };
		const forwarding = new MachineCommandRouter({
			owner: "mx-c",
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
			],
			control: closed({ call: f.call }),
			credential: async () => randomBytes(32).toString("base64url"),
			fetch: (async () => peerAnswer(peerSays)) as typeof fetch,
		});
		told = null;
		const before = words().length;
		expect(await forwarding.screen(f.request, f.signal)).toMatchObject({
			memberTouched: { name: "Bob", secondsAgo: 0 },
		});
		expect(words()).toHaveLength(before + 1);
		told = null;
		peerSays = undefined;
		expect(await forwarding.screen(f.request, f.signal)).toMatchObject({
			memberTouched: { name: "Dora Danske", secondsAgo: 12 },
		});
		expect(await forwarding.screen(f.request, f.signal)).not.toHaveProperty("memberTouched");
	});

	it("answers the agent at once while SQL's word that it was told stalls; the word has a bound of its own (review r2 F2 of #1701)", async () => {
		const f = fixture();
		const at = "2026-11-12T15:16:59.123456+00:00";
		const lookAnswer = { ...f.answer, receiptId: null, action: null, settleMs: null, look: null };
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			// The word never answers.
			if (method === "qorpera_machine_desktop_shared_told") return new Promise<never>(() => {});
			const read = args.p_receipt_id === null ? lookAnswer : f.answer;
			return { ...read, memberTouched: { name: "Dora Danske", secondsAgo: 2, at } } as unknown;
		});
		const began = Date.now();
		// The look, and an action, are answered with the picture and the line at once.
		for (const request of [f.look, f.request])
			expect(await f.router.screen(request, f.signal)).toMatchObject({
				png: picture.toString("base64"),
				memberTouched: { name: "Dora Danske", secondsAgo: 2 },
			});
		expect(Date.now() - began).toBeLessThan(1000);
		const word = f.call.mock.calls.find(
			([method]) => method === "qorpera_machine_desktop_shared_told",
		) as unknown as [string, Record<string, unknown>, AbortSignal];
		expect(word[1]).toEqual({ p_machine_id: f.answer.machineId, p_at: at });
		// Not the caller's signal: the word is bounded alone, and gives up within its bound.
		expect(word[2]).not.toBe(f.signal);
		expect(word[2].aborted).toBe(false);
		await new Promise((resolve) => word[2].addEventListener("abort", resolve, { once: true }));
		expect(Date.now() - began).toBeLessThan(MEMBER_TOUCHED_TOLD_MS + 1000);
		expect(f.signal.aborted).toBe(false);
	}, 15_000);

	it("sends a request once and gives up on no answer, never sending it again", async () => {
		const f = fixture();
		const sent: string[] = [];
		const gateway = createHttpCloudMachineCommandGateway({
			url: "https://node-a.example",
			token: randomBytes(32).toString("base64url"),
			binding: f.binding,
			holder: null,
			fetch: (async (input: string | URL | Request) => {
				sent.push(String(input));
				return new Response("bad gateway", { status: 502 });
			}) as typeof fetch,
		});
		await expect(gateway.screen!(f.request.scope, f.request.input, f.signal)).rejects.toBeInstanceOf(
			CloudMachineCommandUnanswered,
		);
		expect(sent).toHaveLength(1);
	});

	it("reads only its own request shape, and an answer of exactly that request within its bounds", () => {
		const f = fixture();
		expect(parseCloudMachineScreenHttpRequest(f.request)).toEqual(f.request);
		expect(parseCloudMachineScreenHttpRequest(f.look)).toEqual(f.look);
		for (const bad of [
			{ ...f.request, action: "coding_value" },
			{ ...f.request, input: { ...f.request.input, action: f.action } },
			{ ...f.request, input: { ...f.request.input, commandId: "x" } },
			{ ...f.request, input: { ...f.request.input, envelope: null } },
			{ ...f.request, input: { ...f.request.input, envelope: "x".repeat(65537) } },
			{ ...f.request, input: { ...f.request.input, settleMs: 5001 } },
			{ ...f.request, input: { ...f.request.input, settleMs: 1.5 } },
			{ ...f.request, input: { ...f.request.input, look: "yes" } },
			{ ...f.look, input: { ...f.look.input, commandId: randomUUID() } },
			{ ...f.request, scope: { machineId: f.request.scope.machineId, placementId: randomUUID() } },
		])
			expect(() => parseCloudMachineScreenHttpRequest(bad)).toThrow("Machine command gateway unavailable");
		const good = {
			schema: "qorpera.machine-screen-answer/v1",
			commandId: f.request.input.commandId,
			header: header(picture.length),
			png: picture.toString("base64"),
		};
		expect(parseCloudMachineScreenAnswer(f.request, good)).toEqual(good);
		for (const bad of [
			{ ...good, commandId: randomUUID() },
			{ ...good, png: Buffer.from("other").toString("base64") },
			{ ...good, png: null },
			{ ...good, header: { ...good.header, windows: ["a\u0007"] } },
			{ ...good, header: { ...good.header, extra: 1 } },
			{ ...good, heldBack: "held" },
			{ ...good, png: null, header: { ...header(0), activeWindow: "kept" }, heldBack: "held" },
			{ ...good, png: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) },
		])
			expect(() => parseCloudMachineScreenAnswer(f.request, bad), JSON.stringify(bad).slice(0, 200)).toThrow(
				"Machine command gateway unavailable",
			);
		expect(
			parseCloudMachineScreenAnswer(f.request, {
				...good,
				png: null,
				header: { ...header(0), activeWindow: null, windows: [] },
				heldBack: "held",
			}),
		).toMatchObject({ png: null, heldBack: "held" });
		// A member touched the shared screen (20260930734000): who and when, exactly.
		const touched = { ...good, memberTouched: { name: "Dora", secondsAgo: 3 } };
		expect(parseCloudMachineScreenAnswer(f.request, touched)).toEqual(touched);
		const longest = { ...good, memberTouched: { name: "😀".repeat(256), secondsAgo: 3 } };
		expect(parseCloudMachineScreenAnswer(f.request, longest)).toEqual(longest);
		for (const memberTouched of [
			{ name: "Dora", secondsAgo: 3, text: "hunter2" },
			{ name: " ", secondsAgo: 3 },
			// SQL's names are up to 256 characters (code points: review r1 F2 of #1701).
			{ name: "😀".repeat(257), secondsAgo: 3 },
			{ name: "Dora", secondsAgo: "3" },
			{ name: "Dora", secondsAgo: -3 },
			[],
			null,
		])
			expect(
				() => parseCloudMachineScreenAnswer(f.request, { ...good, memberTouched }),
				JSON.stringify(memberTouched),
			).toThrow("Machine command gateway unavailable");
	});
});

describe("a member's look at a desktop (20260930712000)", () => {
	const picture = Buffer.from("89504e470d0a1a0a0000000d4948445200000640000003e8", "hex");
	const etag = createHash("sha256").update(picture).digest("hex");
	function fixture(owner = "mx-a") {
		const ids = {
			useId: randomUUID(),
			companyId: randomUUID(),
			machineId: randomUUID(),
			placementId: randomUUID(),
			bootId: randomUUID(),
			userId: randomUUID(),
		};
		/** SQL's read, for the machine of node A: served only to A's executor. */
		const answer = (requestOwner: string) => ({
			schema: "qorpera.member-machine-screen-authority/v1",
			state: "authorized",
			useId: ids.useId,
			machineId: ids.machineId,
			placementId: ids.placementId,
			bootId: ids.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			userId: ids.userId,
			served: requestOwner === "mx-a",
			keepDesktop: true,
			desktopGeneration: 3,
		});
		const call = vi.fn(
			async (_method: string, args: Record<string, unknown>) => answer(args.p_owner as string) as unknown,
		);
		const host = {
			memberLook: vi.fn(async (): Promise<CompanyMachineMemberLookOutcome> => ({ png: picture, etag })),
		};
		const memberBegin = vi.fn(async () => ids.useId);
		const sent: { url: string; body: unknown }[] = [];
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: closed({ call }),
			credential: async () => randomBytes(32).toString("base64url"),
			memberBegin,
			memberScreenLocal: localMemberMachineScreen(host),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ code: "SCREEN_HIDDEN" }), { status: 409 });
			}) as typeof fetch,
		});
		const look = {
			companyId: ids.companyId,
			machineId: ids.machineId,
			token: "eyJh.eyJz.c2ln",
			confirmed: true,
			etag: null,
		};
		return { ...ids, answer, call, host, memberBegin, router, look, sent, signal: new AbortController().signal };
	}

	it("begins the look as the member, reads it as the machine's own executor and looks on this node", async () => {
		const f = fixture();
		expect(await f.router.memberScreen(f.look, f.signal)).toEqual({ etag, png: picture });
		// The member's own token goes to the begin, and nowhere else.
		expect(f.memberBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			{ companyId: f.companyId, machineId: f.machineId, confirmed: true },
			f.signal,
		);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_member_machine_screen_authority",
			{ p_use_id: f.useId, p_owner: "mx-a", p_provider_id: "machine-node" },
			f.signal,
		);
		expect(JSON.stringify(f.call.mock.calls)).not.toContain("eyJh");
		expect(f.host.memberLook).toHaveBeenCalledWith(
			{ placementId: f.placementId, bootId: f.bootId, userId: f.userId, keepDesktop: true, desktopGeneration: 3 },
			f.signal,
		);
		// The member has this picture: its etag alone.
		expect(await f.router.memberScreen({ ...f.look, etag }, f.signal)).toEqual({ etag, png: null });
		expect(f.sent).toEqual([]);
		// An executor that takes no member's request never begins one.
		const plain = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call: f.call }),
			credential: async () => "",
		});
		await expect(plain.memberScreen(f.look, f.signal)).rejects.toThrow("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
	});

	it("tells the member why there is no picture: the screen off, a restarted machine, an earlier image, hidden or held", async () => {
		const f = fixture();
		for (const [outcome, code] of [
			[{ refused: "DESKTOP_NOT_RUNNING" }, "DESKTOP_NOT_RUNNING"],
			// The fence after the capture: another member took the desktop over since the read (20260930713000).
			[{ refused: "DESKTOP_MEMBER_IN_CONTROL" }, "DESKTOP_MEMBER_IN_CONTROL"],
			[{ refused: "MACHINE_BOOT_CHANGED" }, "MACHINE_BOOT_CHANGED"],
			[{ refused: "MACHINE_IMAGE_WITHOUT_SCREEN" }, "MACHINE_IMAGE_WITHOUT_SCREEN"],
			[{ held: "hidden" }, "SCREEN_HIDDEN"],
			[{ held: "pending" }, "SCREEN_HELD"],
		] as const) {
			f.host.memberLook.mockResolvedValueOnce(outcome);
			const error = await f.router.memberScreen(f.look, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachineScreenRefusal);
			expect(error).toMatchObject({ code });
		}
		// SQL's refusals: a machine that is not running, a disk the member may not see; the begin's own as it gave them.
		for (const reason of ["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW"]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.member-machine-screen-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.memberScreen(f.look, f.signal)).rejects.toMatchObject({ code: reason });
		}
		f.memberBegin.mockRejectedValueOnce(new CloudMemberMachineScreenRefusal("SCREEN_TOO_SOON"));
		await expect(f.router.memberScreen(f.look, f.signal)).rejects.toMatchObject({ code: "SCREEN_TOO_SOON" });
		expect(f.host.memberLook).toHaveBeenCalledTimes(6);
	});

	it("reads SQL's answer strictly: the use asked, exactly its fields, served only to the machine's own executor", async () => {
		const f = fixture();
		const request = { useId: f.useId, owner: "mx-a", providerId: "machine-node" };
		expect(await authorizeMemberMachineScreen({ call: f.call }, request, f.signal)).toMatchObject({ served: true });
		for (const other of [
			{ useId: randomUUID() },
			{ machineId: "m" },
			{ placementId: null },
			{ bootId: "boot" },
			{ userId: 1 },
			{ executorOwner: "mx a" },
			{ providerId: "Node" },
			{ keepDesktop: "yes" },
			{ desktopGeneration: -1 },
			{ desktopGeneration: undefined },
			{ served: false },
			{ node: "node-01" },
			{ state: "refused", reason: "SCREEN_TOO_SOON" },
			{ schema: "qorpera.machine-screen-authority/v1" },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), ...other });
			await expect(
				authorizeMemberMachineScreen({ call: f.call }, request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow("MEMBER_SCREEN_AUTHORITY_INVALID");
		}
		// Served to another executor than this one: not this one's to serve.
		f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), executorOwner: "mx-c", served: true });
		await expect(authorizeMemberMachineScreen({ call: f.call }, request, f.signal)).rejects.toThrow(
			"MEMBER_SCREEN_AUTHORITY_INVALID",
		);
		await expect(
			authorizeMemberMachineScreen({ call: f.call }, { ...request, useId: "use" }, f.signal),
		).rejects.toThrow("MEMBER_SCREEN_AUTHORITY_INVALID");
	});

	it("sends a look once to the node that runs the machine, which never sends it on, and its refusal stays the member's", async () => {
		const f = fixture("mx-c");
		await expect(f.router.memberScreen({ ...f.look, etag }, f.signal)).rejects.toMatchObject({
			code: "SCREEN_HIDDEN",
		});
		expect(f.sent).toEqual([
			{
				url: "https://node-a.example/v1/machine-commands/member-screen",
				body: { schema: "qorpera.member-machine-screen-http/v1", useId: f.useId, etag },
			},
		]);
		// Neither the member's token nor anything of the begin goes to the peer.
		expect(JSON.stringify(f.sent)).not.toContain("eyJh");
		expect(f.host.memberLook).not.toHaveBeenCalled();
		// A look sent here by a peer is read again and served here only: this node is not the machine's.
		await expect(
			f.router.memberScreenPeer(
				{ schema: "qorpera.member-machine-screen-http/v1", useId: f.useId, etag: null },
				f.signal,
			),
		).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(f.sent).toHaveLength(1);
	});

	it("crosses the peer listener only, with the peer token: the picture, the same picture, a refusal as 409", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const start = async (
			proveBinding: ConstructorParameters<typeof HttpCloudCodingCommandService>[0]["proveBinding"],
		) => {
			const http = new HttpCloudCodingCommandService({
				token,
				proveBinding,
				authorize: async () => {
					throw new Error("not a coding command");
				},
				execute: async () => {
					throw new Error("not a coding command");
				},
				machines: machineCommandRoutes(f.router, { call: f.call }, proveBinding === null),
			});
			const port = await http.start();
			cleanups.push(() => http.close());
			return `http://127.0.0.1:${port}`;
		};
		const peerUrl = await start(null);
		const peer = createHttpMemberMachineScreenPeer({ url: peerUrl, token, allowLoopback: true });
		expect(await peer.memberScreen({ useId: f.useId, etag: null }, f.signal)).toEqual({ etag, png: picture });
		expect(await peer.memberScreen({ useId: f.useId, etag }, f.signal)).toEqual({ etag, png: null });
		f.host.memberLook.mockResolvedValueOnce({ held: "pending" });
		await expect(peer.memberScreen({ useId: f.useId, etag: null }, f.signal)).rejects.toMatchObject({
			code: "SCREEN_HELD",
		});
		// Another token: nothing is asked of SQL.
		const calls = f.call.mock.calls.length;
		await expect(
			createHttpMemberMachineScreenPeer({
				url: peerUrl,
				token: randomBytes(32).toString("base64url"),
				allowLoopback: true,
			}).memberScreen({ useId: f.useId, etag: null }, f.signal),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
		// The guests' ingress has no member route, whatever the token.
		const ingressUrl = await start(async () => {});
		await expect(
			createHttpMemberMachineScreenPeer({ url: ingressUrl, token, allowLoopback: true }).memberScreen(
				{ useId: f.useId, etag: null },
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
	});

	it("reads only its own request and an answer of exactly that request, a PNG whose sha-256 is its etag", () => {
		const useId = randomUUID();
		const request = { schema: "qorpera.member-machine-screen-http/v1", useId, etag } as const;
		expect(parseCloudMemberMachineScreenPeerRequest(request)).toEqual(request);
		expect(parseCloudMemberMachineScreenPeerRequest({ ...request, etag: null })).toEqual({ ...request, etag: null });
		for (const bad of [
			{ ...request, useId: "use" },
			{ ...request, etag: etag.toUpperCase() },
			{ ...request, etag: `"${etag}"` },
			{ ...request, token: "eyJ" },
			{ ...request, schema: "qorpera.machine-command-http/v1" },
		])
			expect(() => parseCloudMemberMachineScreenPeerRequest(bad)).toThrow("Machine command gateway unavailable");
		const good = { schema: "qorpera.member-machine-screen-answer/v1", useId, etag, png: picture.toString("base64") };
		expect(parseCloudMemberMachineScreenAnswer({ ...request, etag: null }, good)).toEqual({ etag, png: picture });
		expect(parseCloudMemberMachineScreenAnswer(request, { ...good, png: null })).toEqual({ etag, png: null });
		for (const bad of [
			{ ...good, useId: randomUUID() },
			{ ...good, etag: "e".repeat(64) },
			{ ...good, png: Buffer.from("other").toString("base64") },
			{ ...good, png: "" },
			{ ...good, png: null, etag: "e".repeat(64) },
			{ ...good, png: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4) },
			{ ...good, size: picture.length },
		])
			expect(() => parseCloudMemberMachineScreenAnswer(request, bad), JSON.stringify(bad).slice(0, 120)).toThrow(
				"Machine command gateway unavailable",
			);
	});
});

describe("a member's action on a desktop they hold (20260930713000)", () => {
	const typed = { type: "type", text: "hunter2 Åse" } as const;
	function fixture(owner = "mx-a") {
		const ids = {
			actionId: randomUUID(),
			companyId: randomUUID(),
			machineId: randomUUID(),
			placementId: randomUUID(),
			bootId: randomUUID(),
			userId: randomUUID(),
		};
		/** SQL's read, for the machine of node A: served only to A's executor; the action as SQL recorded it. */
		const answer = (requestOwner: string, action: Record<string, unknown> = cloudMemberMachineActRecord(typed)) => ({
			schema: "qorpera.member-machine-desktop-act-authority/v1",
			state: "authorized",
			actionId: ids.actionId,
			machineId: ids.machineId,
			placementId: ids.placementId,
			bootId: ids.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			userId: ids.userId,
			// The seat it was begun in (round 23 of #1661).
			seat: 9,
			action,
			served: requestOwner === "mx-a",
		});
		const call = vi.fn(
			async (_method: string, args: Record<string, unknown>) => answer(args.p_owner as string) as unknown,
		);
		const host = {
			memberAct: vi.fn(async (): Promise<CompanyMachineMemberActOutcome> => ({ done: { exitCode: 0 } })),
		};
		const memberActBegin = vi.fn(async () => ids.actionId);
		const memberShareBegin = vi.fn(async () => ids.actionId);
		const sent: { url: string; body: unknown }[] = [];
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: closed({ call }),
			credential: async () => randomBytes(32).toString("base64url"),
			memberActBegin,
			memberShareBegin,
			memberActLocal: localMemberMachineAct(host),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ code: "DESKTOP_BUSY" }), { status: 409 });
			}) as typeof fetch,
		});
		const act = {
			companyId: ids.companyId,
			machineId: ids.machineId,
			token: "eyJh.eyJz.c2ln",
			action: typed,
			epoch: 4,
			seat: 9,
		};
		return {
			...ids,
			answer,
			call,
			host,
			memberActBegin,
			memberShareBegin,
			router,
			act,
			sent,
			signal: new AbortController().signal,
		};
	}

	it("begins a shared action as the member with no hold, and runs it with the fence naming no member (20260930734000)", async () => {
		const f = fixture();
		// SQL's read of a shared action: its seat the lease generation it was begun at (0 on a desktop no one held).
		f.call.mockImplementation(
			async (_method: string, args: Record<string, unknown>) =>
				({ ...f.answer(args.p_owner as string), seat: 0, shared: true }) as unknown,
		);
		const shared = {
			companyId: f.companyId,
			machineId: f.machineId,
			token: "eyJh.eyJz.c2ln",
			action: typed,
			shared: true,
		} as const;
		expect(await f.router.memberAct(shared, f.signal)).toEqual({ exitCode: 0 });
		expect(f.memberShareBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			{ companyId: f.companyId, machineId: f.machineId, action: typed },
			f.signal,
		);
		expect(f.memberActBegin).not.toHaveBeenCalled();
		expect(f.host.memberAct).toHaveBeenCalledWith(
			{
				placementId: f.placementId,
				bootId: f.bootId,
				actionId: f.actionId,
				action: typed,
				seat: 0,
				userId: f.userId,
				shared: true,
			},
			f.signal,
		);
		expect(JSON.stringify(f.call.mock.calls)).not.toContain("hunter2");
		// A private hold that began since: the member's refusal, by SQL's read or the host's fence.
		f.call.mockResolvedValueOnce({
			schema: "qorpera.member-machine-desktop-act-authority/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		});
		await expect(f.router.memberAct(shared, f.signal)).rejects.toMatchObject({ code: "DESKTOP_MEMBER_IN_CONTROL" });
		f.host.memberAct.mockResolvedValueOnce({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		await expect(f.router.memberAct(shared, f.signal)).rejects.toMatchObject({ code: "DESKTOP_MEMBER_IN_CONTROL" });
		// The shared begin's own refusals, as it gave them.
		for (const code of [
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_ACTIONS_TOO_FAST",
			"DESKTOP_MACHINE_TOO_SMALL",
			"DESKTOP_HELD_SINCE",
		] as const) {
			f.memberShareBegin.mockRejectedValueOnce(new CloudMemberMachineActRefusal(code));
			await expect(f.router.memberAct(shared, f.signal)).rejects.toMatchObject({ code });
		}
		// The lease generation the input was made under goes to the begin (20260930738000), 0 too; none without one.
		for (const generation of [9, 0]) {
			f.memberShareBegin.mockClear();
			expect(await f.router.memberAct({ ...shared, generation }, f.signal)).toEqual({ exitCode: 0 });
			expect(f.memberShareBegin).toHaveBeenCalledWith(
				"eyJh.eyJz.c2ln",
				{ companyId: f.companyId, machineId: f.machineId, action: typed, generation },
				f.signal,
			);
		}
		// A private action is begun under its hold as before, and its read names its member.
		f.call.mockImplementation(
			async (_method: string, args: Record<string, unknown>) => f.answer(args.p_owner as string) as unknown,
		);
		f.host.memberAct.mockClear();
		expect(await f.router.memberAct(f.act, f.signal)).toEqual({ exitCode: 0 });
		expect((f.host.memberAct.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("shared");
		// An executor that takes no member's shared request never begins one.
		const plain = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call: f.call }),
			credential: async () => "",
			memberActBegin: f.memberActBegin,
		});
		await expect(plain.memberAct(shared, f.signal)).rejects.toThrow("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
	});

	it("reads a shared action only as SQL says it: `shared` exactly true, a seat of 0 or more", async () => {
		const f = fixture();
		const request = { actionId: f.actionId, action: typed, owner: "mx-a", providerId: "machine-node" };
		f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), seat: 0, shared: true });
		expect(await authorizeMemberMachineAct({ call: f.call }, request, f.signal)).toMatchObject({
			served: true,
			shared: true,
			seat: 0,
		});
		// A private one is not shared.
		expect(await authorizeMemberMachineAct({ call: f.call }, request, f.signal)).toMatchObject({
			shared: false,
			seat: 9,
		});
		for (const other of [
			{ shared: false },
			{ shared: "true" },
			{ shared: null },
			{ shared: true, seat: -1 },
			{ shared: true, seat: 1.5 },
			{ shared: true, held: true },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), ...other });
			await expect(
				authorizeMemberMachineAct({ call: f.call }, request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow("MEMBER_ACT_AUTHORITY_INVALID");
		}
	});

	it("begins the action as the member, reads it as the machine's own executor and runs it on this node", async () => {
		const f = fixture();
		expect(await f.router.memberAct(f.act, f.signal)).toEqual({ exitCode: 0 });
		expect(f.memberActBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			// With the epoch and the seat of the hold its input was captured under (F24, F26).
			{ companyId: f.companyId, machineId: f.machineId, action: typed, epoch: 4, seat: 9 },
			f.signal,
		);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_member_machine_desktop_act_authority",
			{ p_action_id: f.actionId, p_owner: "mx-a", p_provider_id: "machine-node" },
			f.signal,
		);
		// SQL is asked nothing with the member's token or the text in it.
		expect(JSON.stringify(f.call.mock.calls)).not.toContain("eyJh");
		expect(JSON.stringify(f.call.mock.calls)).not.toContain("hunter2");
		// The host gets the text: it alone takes it to the machine.
		// With the seat and the member, which the host's fence asks again once it holds the desktop (round 23).
		expect(f.host.memberAct).toHaveBeenCalledWith(
			{
				placementId: f.placementId,
				bootId: f.bootId,
				actionId: f.actionId,
				action: typed,
				seat: 9,
				userId: f.userId,
			},
			f.signal,
		);
		expect(f.sent).toEqual([]);
		// The host's refusals are the member's; anything else fails.
		for (const refused of ["DESKTOP_BUSY", "DESKTOP_NOT_RUNNING", "MACHINE_BOOT_CHANGED", "SCREEN_ACTION_TAKEN"]) {
			f.host.memberAct.mockResolvedValueOnce({ refused });
			const error = await f.router.memberAct(f.act, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberMachineActRefusal);
			expect(error).toMatchObject({ code: refused });
		}
		f.host.memberAct.mockResolvedValueOnce({ refused: "SOMETHING_ELSE" });
		await expect(f.router.memberAct(f.act, f.signal)).rejects.toThrow("MEMBER_MACHINE_ACT_FAILED");
		// SQL's refusals: a machine that is not running, a disk the member may not see, a hold that ended.
		for (const reason of ["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW", "DESKTOP_CONTROL_ENDED"]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.member-machine-desktop-act-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.memberAct(f.act, f.signal)).rejects.toMatchObject({ code: reason });
		}
		// The begin's own, as it gave them.
		f.memberActBegin.mockRejectedValueOnce(new CloudMemberMachineActRefusal("DESKTOP_MEMBER_IN_CONTROL"));
		await expect(f.router.memberAct(f.act, f.signal)).rejects.toMatchObject({ code: "DESKTOP_MEMBER_IN_CONTROL" });
		// An executor that takes no member's request never begins one.
		const plain = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: closed({ call: f.call }),
			credential: async () => "",
		});
		await expect(plain.memberAct(f.act, f.signal)).rejects.toThrow("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
	});

	it("runs only the action SQL let in: its record must be this one's, a text by its length", async () => {
		const f = fixture();
		const request = { actionId: f.actionId, action: typed, owner: "mx-a", providerId: "machine-node" };
		expect(await authorizeMemberMachineAct({ call: f.call }, request, f.signal)).toMatchObject({ served: true });
		expect(cloudMemberMachineActRecord(typed)).toEqual({ type: "type", length: 11 });
		expect(cloudMemberMachineActRecord({ type: "click", x: 1, y: 2 })).toEqual({ type: "click", x: 1, y: 2 });
		for (const other of [
			{ action: { type: "type", length: 12 } },
			{ action: { type: "click", x: 1, y: 2 } },
			{ action: { type: "type", text: "hunter2 Åse" } },
			{ actionId: randomUUID() },
			{ placementId: null },
			{ executorOwner: "mx a" },
			{ served: false },
			{ node: "node-01" },
			{ seat: 0 },
			{ seat: "9" },
			{ seat: undefined },
			{ state: "refused", reason: "DESKTOP_BUSY" },
			{ schema: "qorpera.member-machine-screen-authority/v1" },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), ...other });
			await expect(
				authorizeMemberMachineAct({ call: f.call }, request, f.signal),
				JSON.stringify(other),
			).rejects.toThrow(/MEMBER_ACT_(AUTHORITY_INVALID|DIFFERS)/);
		}
		expect(f.host.memberAct).not.toHaveBeenCalled();
	});

	it("sends an action once to the node that runs the machine, which never sends it on, and its refusal stays the member's", async () => {
		const f = fixture("mx-c");
		await expect(f.router.memberAct(f.act, f.signal)).rejects.toMatchObject({ code: "DESKTOP_BUSY" });
		expect(f.sent).toEqual([
			{
				url: "https://node-a.example/v1/machine-commands/member-act",
				body: { schema: "qorpera.member-machine-act-http/v1", actionId: f.actionId, action: typed },
			},
		]);
		// The member's token never goes to the peer.
		expect(JSON.stringify(f.sent)).not.toContain("eyJh");
		expect(f.host.memberAct).not.toHaveBeenCalled();
		await expect(
			f.router.memberActPeer(
				{ schema: "qorpera.member-machine-act-http/v1", actionId: f.actionId, action: typed },
				f.signal,
			),
		).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(f.sent).toHaveLength(1);
	});

	it("crosses the peer listener only, with the peer token: the exit, a refusal as 409, the guests' ingress never", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const start = async (
			proveBinding: ConstructorParameters<typeof HttpCloudCodingCommandService>[0]["proveBinding"],
		) => {
			const http = new HttpCloudCodingCommandService({
				token,
				proveBinding,
				authorize: async () => {
					throw new Error("not a coding command");
				},
				execute: async () => {
					throw new Error("not a coding command");
				},
				machines: machineCommandRoutes(f.router, { call: f.call }, proveBinding === null),
			});
			const port = await http.start();
			cleanups.push(() => http.close());
			return `http://127.0.0.1:${port}`;
		};
		const peerUrl = await start(null);
		const peer = createHttpMemberMachineScreenPeer({ url: peerUrl, token, allowLoopback: true });
		expect(await peer.memberAct({ actionId: f.actionId, action: typed }, f.signal)).toEqual({ exitCode: 0 });
		expect(f.host.memberAct).toHaveBeenLastCalledWith(expect.objectContaining({ action: typed }), expect.anything());
		f.host.memberAct.mockResolvedValueOnce({ refused: "DESKTOP_BUSY" });
		await expect(peer.memberAct({ actionId: f.actionId, action: typed }, f.signal)).rejects.toMatchObject({
			code: "DESKTOP_BUSY",
		});
		// Another token: nothing is asked of SQL.
		const calls = f.call.mock.calls.length;
		await expect(
			createHttpMemberMachineScreenPeer({
				url: peerUrl,
				token: randomBytes(32).toString("base64url"),
				allowLoopback: true,
			}).memberAct({ actionId: f.actionId, action: typed }, f.signal),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
		// The guests' ingress has no member route, whatever the token.
		const ingressUrl = await start(async () => {});
		await expect(
			createHttpMemberMachineScreenPeer({ url: ingressUrl, token, allowLoopback: true }).memberAct(
				{ actionId: f.actionId, action: typed },
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
	});

	it("reads only its own request (never open, never a malformed action, with no word of it in the error) and its answer", () => {
		const actionId = randomUUID();
		const request = { schema: "qorpera.member-machine-act-http/v1", actionId, action: typed } as const;
		expect(parseCloudMemberMachineActPeerRequest(request)).toEqual(request);
		for (const bad of [
			{ ...request, actionId: "action" },
			{ ...request, action: { type: "open", target: "https://bank.example.test" } },
			{ ...request, action: { type: "type", text: "secret\u0007" } },
			{ ...request, action: { type: "key", keys: ["exec", "id"] } },
			{ ...request, action: { type: "type", text: "x".repeat(501) } },
			{ ...request, token: "eyJ" },
			{ ...request, schema: "qorpera.member-machine-screen-http/v1" },
		]) {
			let error: unknown;
			try {
				parseCloudMemberMachineActPeerRequest(bad);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("Machine command gateway unavailable");
		}
		expect(() => parseCloudMemberMachineAction({ type: "type", text: "secret\u0007" })).toThrow(
			/^MEMBER_ACTION_INVALID$/,
		);
		expect(parseCloudMemberMachineAction({ type: "scroll", direction: "down", steps: 3, x: 1, y: 2 })).toEqual({
			type: "scroll",
			direction: "down",
			steps: 3,
			x: 1,
			y: 2,
		});
		const good = { schema: "qorpera.member-machine-act-answer/v1", actionId, exitCode: 0 };
		expect(parseCloudMemberMachineActAnswer(request, good)).toEqual({ exitCode: 0 });
		expect(parseCloudMemberMachineActAnswer(request, { ...good, exitCode: null })).toEqual({ exitCode: null });
		for (const bad of [
			{ ...good, actionId: randomUUID() },
			{ ...good, exitCode: 256 },
			{ ...good, exitCode: "0" },
			{ ...good, png: "" },
		])
			expect(() => parseCloudMemberMachineActAnswer(request, bad)).toThrow("Machine command gateway unavailable");
	});
});

describe("a member's pointer on a desktop (20260930744000)", () => {
	function fixture(owner = "mx-a") {
		const ids = {
			passId: randomUUID(),
			companyId: randomUUID(),
			machineId: randomUUID(),
			placementId: randomUUID(),
			bootId: randomUUID(),
			userId: randomUUID(),
		};
		/** SQL's read of the pass, for the machine of node A: served only to A's executor. */
		const answer = (requestOwner: string, change: Record<string, unknown> = {}) => ({
			schema: "qorpera.member-machine-desktop-pointer-authority/v1",
			state: "authorized",
			passId: ids.passId,
			machineId: ids.machineId,
			placementId: ids.placementId,
			bootId: ids.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			userId: ids.userId,
			generation: 4,
			private: false,
			milliseconds: 10000,
			served: requestOwner === "mx-a",
			...change,
		});
		const call = vi.fn(
			async (_method: string, args: Record<string, unknown>) => answer(args.p_owner as string) as unknown,
		);
		const host = {
			memberPointer: vi.fn((): CompanyMachineMemberPointerOutcome => ({ moved: true })),
		};
		const memberPointerBegin = vi.fn(async () => ids.passId);
		const sent: { url: string; body: unknown }[] = [];
		let peerAnswer: () => Response = () =>
			Response.json({ schema: "qorpera.member-machine-pointer-answer/v1", passId: ids.passId, moved: true });
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: closed({ call }),
			credential: async () => randomBytes(32).toString("base64url"),
			memberPointerBegin,
			memberPointerLocal: localMemberMachinePointer(host),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return peerAnswer();
			}) as typeof fetch,
		});
		const token = "eyJh.eyJz.c2ln";
		const where = { companyId: ids.companyId, machineId: ids.machineId, token };
		return {
			...ids,
			answer,
			call,
			host,
			memberPointerBegin,
			router,
			where,
			sent,
			peer: (next: () => Response) => {
				peerAnswer = next;
			},
			signal: new AbortController().signal,
		};
	}

	it("begins a pass as the member, reads it once as the executor, and moves on it with no SQL per move", async () => {
		const f = fixture();
		// What is left of its 10 s once SQL's answer came (v242 release review r1 F2).
		const begun = (await f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal)) as {
			pass: string;
			milliseconds: number;
		};
		expect(begun.pass).toBe(f.passId);
		expect(begun.milliseconds).toBeGreaterThan(9900);
		expect(begun.milliseconds).toBeLessThanOrEqual(10000);
		expect(f.memberPointerBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			{ companyId: f.companyId, machineId: f.machineId, hold: { generation: 4 } },
			f.signal,
		);
		expect(f.call.mock.calls.map((call) => [call[0], call[1]])).toEqual([
			[
				"qorpera_member_machine_desktop_pointer_authority",
				{ p_pass_id: f.passId, p_owner: "mx-a", p_provider_id: "machine-node" },
			],
		]);
		for (let n = 0; n < 5; n++)
			expect(await f.router.memberPointer({ ...f.where, pass: f.passId, x: 100 + n, y: 200 }, f.signal)).toEqual({
				moved: true,
			});
		expect(f.call).toHaveBeenCalledTimes(1);
		expect(f.host.memberPointer).toHaveBeenLastCalledWith({
			placementId: f.placementId,
			bootId: f.bootId,
			userId: f.userId,
			generation: 4,
			private: false,
			x: 104,
			y: 200,
		});
	});

	it("bounds begins, the one pointer request that calls out: one per token at a time, 16 at once, 40 a second, refused before any call (20260930745000)", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.parse("2026-11-13T10:00:00.250Z"));
			const f = fixture();
			const waiting: (() => void)[] = [];
			f.memberPointerBegin.mockImplementation(
				() =>
					new Promise<typeof f.passId>((resolve) => {
						waiting.push(() => resolve(f.passId));
					}),
			);
			const begin = (token: string) =>
				f.router.memberPointer({ ...f.where, token, begin: { generation: 4 } }, f.signal);
			// One token: a second begin while its first is on its way is refused at once, with no call.
			const first = begin("eyJh.eyJz.dG9rZW4tMA");
			await expect(begin("eyJh.eyJz.dG9rZW4tMA")).rejects.toThrow("MEMBER_POINTER_BUSY");
			expect(f.memberPointerBegin).toHaveBeenCalledTimes(1);
			// Sixteen tokens on their way at once; the seventeenth is refused before any call.
			const going = [first];
			for (let n = 1; n < 16; n++) going.push(begin(`eyJh.eyJz.dG9rZW4t${n}`));
			await expect(begin("eyJh.eyJz.c2V2ZW50ZWVu")).rejects.toThrow("MEMBER_POINTER_BUSY");
			expect(f.memberPointerBegin).toHaveBeenCalledTimes(16);
			for (const done of waiting.splice(0)) done();
			await Promise.all(going);
			// Forty begins in one second, whatever their tokens; the forty-first waits for the next second.
			f.memberPointerBegin.mockImplementation(async () => f.passId);
			for (let n = 16; n < 40; n++) await begin(`eyJh.eyJz.dG9rZW4t${n}`);
			await expect(begin("eyJh.eyJz.Zm9ydHktb25l")).rejects.toThrow("MEMBER_POINTER_BUSY");
			expect(f.memberPointerBegin).toHaveBeenCalledTimes(40);
			vi.setSystemTime(Date.parse("2026-11-13T10:00:01.000Z"));
			await expect(begin("eyJh.eyJz.Zm9ydHktb25l")).resolves.toEqual({ pass: f.passId, milliseconds: 10000 });
			// A begin that failed gives its token's place back.
			f.memberPointerBegin.mockImplementationOnce(async () => {
				throw new Error("MEMBER_POINTER_BEGIN_UNCONFIRMED");
			});
			await expect(begin("eyJh.eyJz.ZmFpbHM")).rejects.toThrow("MEMBER_POINTER_BEGIN_UNCONFIRMED");
			await expect(begin("eyJh.eyJz.ZmFpbHM")).resolves.toEqual({ pass: f.passId, milliseconds: 10000 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("moves only on the pass's own token, company and machine, while it lasts, at most 30 a second", async () => {
		const f = fixture();
		await f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal);
		const ended = async (request: Record<string, unknown>) =>
			expect(
				f.router.memberPointer({ ...f.where, pass: f.passId, x: 1, y: 1, ...request } as never, f.signal),
				JSON.stringify(request),
			).rejects.toMatchObject({ code: "POINTER_PASS_ENDED" });
		await ended({ token: "eyJh.eyJz.b3RoZXI" });
		await ended({ companyId: randomUUID() });
		await ended({ machineId: randomUUID() });
		await ended({ pass: randomUUID() });
		expect(f.host.memberPointer).not.toHaveBeenCalled();
		const moves = [];
		for (let n = 0; n < MEMBER_POINTER_MOVES_PER_SECOND + 5; n++)
			moves.push(
				(await f.router.memberPointer({ ...f.where, pass: f.passId, x: n, y: 1 }, f.signal)) as { moved: boolean },
			);
		// Past the bound in one second: dropped, never queued.
		expect(moves.filter((move) => move.moved)).toHaveLength(MEMBER_POINTER_MOVES_PER_SECOND);
		expect(f.host.memberPointer).toHaveBeenCalledTimes(MEMBER_POINTER_MOVES_PER_SECOND);
		// A pass that ran out moves nothing: refused at its begin (v242 release review r1 F2), never kept.
		const short = fixture();
		short.call.mockImplementation(async (_method: string, args: Record<string, unknown>) =>
			short.answer(args.p_owner as string, { milliseconds: 0 }),
		);
		await expect(
			short.router.memberPointer({ ...short.where, begin: { generation: 4 } }, short.signal),
		).rejects.toMatchObject({ code: "POINTER_PASS_ENDED" });
		await expect(
			short.router.memberPointer({ ...short.where, pass: short.passId, x: 1, y: 1 }, short.signal),
		).rejects.toMatchObject({ code: "POINTER_PASS_ENDED" });
		expect(short.host.memberPointer).not.toHaveBeenCalled();
	});

	it("counts a pass's time from when SQL was asked, not from its answer, and refuses one with nothing left before its first move, here and on the machine's node (v242 release review r1 F2)", async () => {
		vi.useFakeTimers();
		try {
			/** SQL answers after `delay` ms, with `left` ms of the pass. */
			const slow = (f: ReturnType<typeof fixture>, delay: number, left: number) =>
				f.call.mockImplementation(
					(_method: string, args: Record<string, unknown>) =>
						new Promise((resolve) =>
							setTimeout(() => resolve(f.answer(args.p_owner as string, { milliseconds: left })), delay),
						),
				);
			// 600 ms left when SQL was asked, its answer 500 ms on the way: 100 ms of it are left, and said so.
			const f = fixture();
			slow(f, 500, 600);
			const begun = f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal);
			await vi.advanceTimersByTimeAsync(500);
			expect(await begun).toEqual({ pass: f.passId, milliseconds: 100 });
			await vi.advanceTimersByTimeAsync(50);
			expect(await f.router.memberPointer({ ...f.where, pass: f.passId, x: 1, y: 1 }, f.signal)).toEqual({
				moved: true,
			});
			await vi.advanceTimersByTimeAsync(60);
			await expect(
				f.router.memberPointer({ ...f.where, pass: f.passId, x: 2, y: 1 }, f.signal),
			).rejects.toMatchObject({
				code: "POINTER_PASS_ENDED",
			});
			expect(f.host.memberPointer).toHaveBeenCalledTimes(1);
			// 400 ms left, 500 ms on the way: nothing left, refused at the begin, never kept.
			const late = fixture();
			slow(late, 500, 400);
			const refused = expect(
				late.router.memberPointer({ ...late.where, begin: { generation: 4 } }, late.signal),
			).rejects.toMatchObject({ code: "POINTER_PASS_ENDED" });
			await vi.advanceTimersByTimeAsync(500);
			await refused;
			// The machine's node, on the first move it is sent: none left, or all of it gone on the way, moves nothing.
			for (const [delay, left] of [
				[0, 0],
				[500, 300],
			] as const) {
				const node = fixture("mx-a");
				slow(node, delay, left);
				const request = parseCloudMemberMachinePointerPeerRequest({
					schema: "qorpera.member-machine-pointer-http/v1",
					passId: node.passId,
					x: 9,
					y: 10,
				});
				const moved = expect(node.router.memberPointerPeer(request, node.signal)).rejects.toMatchObject({
					code: "POINTER_PASS_ENDED",
				});
				await vi.advanceTimersByTimeAsync(delay);
				await moved;
				expect(node.host.memberPointer).not.toHaveBeenCalled();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("tells SQL's refusals and a pass SQL no longer holds, and forgets a pass the host refused", async () => {
		const f = fixture();
		for (const reason of [
			"DESKTOP_MEMBER_IN_CONTROL",
			"DESKTOP_HELD_SINCE",
			"DESKTOP_CONTROL_ENDED",
			"MACHINE_NOT_RUNNING",
		]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.member-machine-desktop-pointer-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal)).rejects.toMatchObject(
				{
					code: reason,
				},
			);
		}
		// The host saw a newer generation: refused, and the pass is forgotten here.
		await f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal);
		f.host.memberPointer.mockReturnValueOnce({ refused: "DESKTOP_HELD_SINCE" });
		await expect(f.router.memberPointer({ ...f.where, pass: f.passId, x: 1, y: 1 }, f.signal)).rejects.toMatchObject({
			code: "DESKTOP_HELD_SINCE",
		});
		await expect(f.router.memberPointer({ ...f.where, pass: f.passId, x: 1, y: 1 }, f.signal)).rejects.toMatchObject({
			code: "POINTER_PASS_ENDED",
		});
		// An answer of another shape fails.
		f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), milliseconds: 60000 });
		await expect(f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal)).rejects.toThrow(
			"MEMBER_POINTER_AUTHORITY_INVALID",
		);
	});

	it("sends each move to the machine's node, which reads the pass once and keeps it", async () => {
		const front = fixture("mx-b");
		await front.router.memberPointer({ ...front.where, begin: { generation: 4 } }, front.signal);
		expect(
			await front.router.memberPointer({ ...front.where, pass: front.passId, x: 7, y: 8 }, front.signal),
		).toEqual({
			moved: true,
		});
		expect(front.sent).toEqual([
			{
				url: "https://node-a.example/v1/machine-commands/member-pointer",
				body: { schema: "qorpera.member-machine-pointer-http/v1", passId: front.passId, x: 7, y: 8 },
			},
		]);
		expect(front.host.memberPointer).not.toHaveBeenCalled();
		// The machine's node refuses for good: forgotten at the front too.
		front.peer(() => Response.json({ code: "DESKTOP_HELD_SINCE" }, { status: 409 }));
		await expect(
			front.router.memberPointer({ ...front.where, pass: front.passId, x: 7, y: 8 }, front.signal),
		).rejects.toMatchObject({ code: "DESKTOP_HELD_SINCE" });
		await expect(
			front.router.memberPointer({ ...front.where, pass: front.passId, x: 7, y: 8 }, front.signal),
		).rejects.toMatchObject({ code: "POINTER_PASS_ENDED" });
		// The machine's own node: the pass read once, its moves on this node.
		const node = fixture("mx-a");
		const request = parseCloudMemberMachinePointerPeerRequest({
			schema: "qorpera.member-machine-pointer-http/v1",
			passId: node.passId,
			x: 9,
			y: 10,
		});
		expect(await node.router.memberPointerPeer(request, node.signal)).toEqual({ moved: true });
		expect(await node.router.memberPointerPeer({ ...request, x: 11 }, node.signal)).toEqual({ moved: true });
		expect(node.call).toHaveBeenCalledTimes(1);
		expect(node.host.memberPointer).toHaveBeenLastCalledWith(expect.objectContaining({ x: 11, y: 10 }));
		// Another node's pass is never moved here.
		const wrong = fixture("mx-c");
		await expect(wrong.router.memberPointerPeer({ ...request, passId: wrong.passId }, wrong.signal)).rejects.toThrow(
			"MACHINE_COMMAND_WRONG_EXECUTOR",
		);
	});

	it("parses the peer's request and answer strictly, and reads SQL's answer strictly", async () => {
		const passId = randomUUID();
		const request = parseCloudMemberMachinePointerPeerRequest({
			schema: "qorpera.member-machine-pointer-http/v1",
			passId,
			x: 3839,
			y: 2159,
		});
		for (const wrong of [{ x: 3840 }, { y: -1 }, { x: 1.5 }, { passId: "pass" }, { text: "hunter2" }])
			expect(
				() => parseCloudMemberMachinePointerPeerRequest({ ...request, ...wrong }),
				JSON.stringify(wrong),
			).toThrow();
		expect(
			parseCloudMemberMachinePointerAnswer(request, {
				schema: "qorpera.member-machine-pointer-answer/v1",
				passId,
				moved: false,
			}),
		).toEqual({ moved: false });
		expect(() =>
			parseCloudMemberMachinePointerAnswer(request, {
				schema: "qorpera.member-machine-pointer-answer/v1",
				passId: randomUUID(),
				moved: true,
			}),
		).toThrow();
		const f = fixture();
		for (const change of [
			{ served: false },
			{ generation: -1 },
			{ private: "no" },
			{ extra: 1 },
			{ passId: randomUUID() },
		]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), ...change });
			await expect(
				authorizeMemberMachinePointer(
					closed({ call: f.call }),
					{ passId: f.passId, owner: "mx-a", providerId: "machine-node" },
					f.signal,
				),
				JSON.stringify(change),
			).rejects.toThrow("MEMBER_POINTER_AUTHORITY_INVALID");
		}
	});
});

describe("a member's start of a desktop (20260930714000)", () => {
	function fixture(owner = "mx-a") {
		const ids = {
			startId: randomUUID(),
			companyId: randomUUID(),
			machineId: randomUUID(),
			placementId: randomUUID(),
			bootId: randomUUID(),
			userId: randomUUID(),
		};
		/** SQL's read, for the machine of node A: served only to A's executor. */
		const answer = (requestOwner: string) => ({
			schema: "qorpera.member-machine-desktop-start-authority/v1",
			state: "authorized",
			startId: ids.startId,
			machineId: ids.machineId,
			placementId: ids.placementId,
			bootId: ids.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			userId: ids.userId,
			served: requestOwner === "mx-a",
		});
		const call = vi.fn(
			async (_method: string, args: Record<string, unknown>) => answer(args.p_owner as string) as unknown,
		);
		const host = {
			memberStart: vi.fn(async (): Promise<CompanyMachineMemberStartOutcome> => ({ outcome: "started" })),
		};
		const memberStartBegin = vi.fn(async (): Promise<{ startId: string }> => ({ startId: ids.startId }));
		const sent: { url: string; body: unknown }[] = [];
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: closed({ call }),
			credential: async () => randomBytes(32).toString("base64url"),
			memberStartBegin,
			memberStartLocal: localMemberMachineStart(host),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ code: "DESKTOP_MACHINE_TOO_SMALL" }), { status: 409 });
			}) as typeof fetch,
		});
		const start = { companyId: ids.companyId, machineId: ids.machineId, token: "eyJh.eyJz.c2ln" };
		return {
			...ids,
			answer,
			call,
			host,
			memberStartBegin,
			router,
			start,
			sent,
			signal: new AbortController().signal,
		};
	}

	it("begins the start as the member, reads it as the machine's own executor and runs it on this node", async () => {
		const f = fixture();
		expect(await f.router.memberStart(f.start, f.signal)).toEqual({ outcome: "started" });
		expect(f.memberStartBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			{ companyId: f.companyId, machineId: f.machineId },
			f.signal,
		);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_member_machine_desktop_start_authority",
			{ p_start_id: f.startId, p_owner: "mx-a", p_provider_id: "machine-node" },
			f.signal,
		);
		expect(f.host.memberStart).toHaveBeenCalledWith(
			{ placementId: f.placementId, bootId: f.bootId, startId: f.startId },
			f.signal,
		);
		// Running already, too small, a restarted machine, a desktop that did not start: the member's; anything else fails.
		f.host.memberStart.mockResolvedValueOnce({ outcome: "running" });
		expect(await f.router.memberStart(f.start, f.signal)).toEqual({ outcome: "running" });
		for (const refused of ["DESKTOP_MACHINE_TOO_SMALL", "MACHINE_BOOT_CHANGED", "DESKTOP_DID_NOT_START"]) {
			f.host.memberStart.mockResolvedValueOnce({ refused });
			await expect(f.router.memberStart(f.start, f.signal)).rejects.toMatchObject({ code: refused });
		}
		f.host.memberStart.mockResolvedValueOnce({ refused: "SOMETHING_ELSE" });
		await expect(f.router.memberStart(f.start, f.signal)).rejects.toThrow("MEMBER_MACHINE_START_FAILED");
	});

	it("opens what SQL kept on the start: the begin takes the path, the host gets SQL's own (20260930758000)", async () => {
		const f = fixture();
		const open = "Møder/æble og grød ø.md";
		f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), open });
		f.host.memberStart.mockResolvedValueOnce({ outcome: "opened" });
		expect(await f.router.memberStart({ ...f.start, open }, f.signal)).toEqual({ outcome: "opened" });
		expect(f.memberStartBegin).toHaveBeenLastCalledWith(
			"eyJh.eyJz.c2ln",
			{ companyId: f.companyId, machineId: f.machineId, open },
			f.signal,
		);
		expect(f.host.memberStart).toHaveBeenLastCalledWith(
			{ placementId: f.placementId, bootId: f.bootId, startId: f.startId, open },
			f.signal,
		);
		// The open's refusals are the member's; SQL's read refuses a path no longer theirs, or another's private typing.
		for (const refused of ["DESKTOP_OPEN_NOT_FOUND", "DESKTOP_OPEN_NO_FOLDER", "DESKTOP_DID_NOT_OPEN"]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), open });
			f.host.memberStart.mockResolvedValueOnce({ refused });
			await expect(f.router.memberStart({ ...f.start, open }, f.signal)).rejects.toMatchObject({ code: refused });
		}
		for (const reason of ["DESKTOP_OPEN_NOT_FOUND", "DESKTOP_MEMBER_IN_CONTROL"]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.member-machine-desktop-start-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.memberStart({ ...f.start, open }, f.signal)).rejects.toMatchObject({ code: reason });
		}
		// A path SQL could never have kept is no authority.
		for (const bad of ["", "/etc/passwd", "a/../b", "a\nb", 5]) {
			f.call.mockResolvedValueOnce({ ...f.answer("mx-a"), open: bad });
			await expect(f.router.memberStart({ ...f.start, open }, f.signal)).rejects.toThrow(
				"MEMBER_START_AUTHORITY_INVALID",
			);
		}
		// A plain start's read carries no path, and the host gets none.
		await f.router.memberStart(f.start, f.signal);
		expect(f.host.memberStart).toHaveBeenLastCalledWith(
			{ placementId: f.placementId, bootId: f.bootId, startId: f.startId },
			f.signal,
		);
	});

	it("reads SQL's answer strictly: the start asked, exactly its fields, served only to the machine's own executor", async () => {
		const f = fixture();
		for (const [name, value] of [
			["another start", { ...f.answer("mx-a"), startId: randomUUID() }],
			["an extra field", { ...f.answer("mx-a"), more: 1 }],
			["served to another", { ...f.answer("mx-a"), executorOwner: "mx-b" }],
			["another schema", { ...f.answer("mx-a"), schema: "qorpera.member-machine-desktop-act-authority/v1" }],
		] as const) {
			f.call.mockResolvedValueOnce(value);
			await expect(f.router.memberStart(f.start, f.signal), name).rejects.toThrow("MEMBER_START_AUTHORITY_INVALID");
		}
		for (const reason of ["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW", "DESKTOP_MACHINE_TOO_SMALL"]) {
			f.call.mockResolvedValueOnce({
				schema: "qorpera.member-machine-desktop-start-authority/v1",
				state: "refused",
				reason,
			});
			await expect(f.router.memberStart(f.start, f.signal)).rejects.toMatchObject({ code: reason });
		}
		expect(f.host.memberStart).not.toHaveBeenCalled();
	});

	it("sends a start once to the node that runs the machine, which never sends it on, and its refusal stays the member's", async () => {
		const f = fixture("mx-c");
		await expect(f.router.memberStart(f.start, f.signal)).rejects.toMatchObject({
			code: "DESKTOP_MACHINE_TOO_SMALL",
		});
		expect(f.sent).toEqual([
			{
				url: "https://node-a.example/v1/machine-commands/member-start",
				body: { schema: "qorpera.member-machine-start-http/v1", startId: f.startId },
			},
		]);
		expect(JSON.stringify(f.sent)).not.toContain("eyJh");
		await expect(
			f.router.memberStartPeer({ schema: "qorpera.member-machine-start-http/v1", startId: f.startId }, f.signal),
		).rejects.toThrow("MACHINE_COMMAND_WRONG_EXECUTOR");
		expect(f.sent).toHaveLength(1);
	});

	it("crosses the peer listener only, with the peer token: the outcome, a refusal as 409, the guests' ingress never", async () => {
		const f = fixture();
		const token = randomBytes(32).toString("base64url");
		const start = async (
			proveBinding: ConstructorParameters<typeof HttpCloudCodingCommandService>[0]["proveBinding"],
		) => {
			const http = new HttpCloudCodingCommandService({
				token,
				proveBinding,
				authorize: async () => {
					throw new Error("not a coding command");
				},
				execute: async () => {
					throw new Error("not a coding command");
				},
				machines: machineCommandRoutes(f.router, { call: f.call }, proveBinding === null),
			});
			const port = await http.start();
			cleanups.push(() => http.close());
			return `http://127.0.0.1:${port}`;
		};
		const peerUrl = await start(null);
		const peer = createHttpMemberMachineScreenPeer({ url: peerUrl, token, allowLoopback: true });
		expect(await peer.memberStart({ startId: f.startId }, f.signal)).toEqual({ outcome: "started" });
		f.host.memberStart.mockResolvedValueOnce({ refused: "DESKTOP_DID_NOT_START" });
		await expect(peer.memberStart({ startId: f.startId }, f.signal)).rejects.toMatchObject({
			code: "DESKTOP_DID_NOT_START",
		});
		const calls = f.call.mock.calls.length;
		await expect(
			createHttpMemberMachineScreenPeer({
				url: peerUrl,
				token: randomBytes(32).toString("base64url"),
				allowLoopback: true,
			}).memberStart({ startId: f.startId }, f.signal),
		).rejects.toThrow("Machine command gateway unavailable");
		const ingressUrl = await start(async () => {});
		await expect(
			createHttpMemberMachineScreenPeer({ url: ingressUrl, token, allowLoopback: true }).memberStart(
				{ startId: f.startId },
				f.signal,
			),
		).rejects.toThrow("Machine command gateway unavailable");
		expect(f.call.mock.calls.length).toBe(calls);
	});

	it("reads only its own request and an answer of exactly that request", () => {
		const startId = randomUUID();
		const request = parseCloudMemberMachineStartPeerRequest({
			schema: "qorpera.member-machine-start-http/v1",
			startId,
		});
		for (const bad of [
			{ schema: "qorpera.member-machine-start-http/v1", startId: "x" },
			{ schema: "qorpera.member-machine-act-http/v1", startId },
			{ schema: "qorpera.member-machine-start-http/v1", startId, open: "/company" },
		])
			expect(() => parseCloudMemberMachineStartPeerRequest(bad)).toThrow();
		expect(
			parseCloudMemberMachineStartAnswer(request, {
				schema: "qorpera.member-machine-start-answer/v1",
				startId,
				outcome: "running",
			}),
		).toEqual({ outcome: "running" });
		// A start that opened what SQL kept on it (20260930758000): the path itself never crosses this route.
		expect(
			parseCloudMemberMachineStartAnswer(request, {
				schema: "qorpera.member-machine-start-answer/v1",
				startId,
				outcome: "opened",
			}),
		).toEqual({ outcome: "opened" });
		for (const bad of [
			{ schema: "qorpera.member-machine-start-answer/v1", startId: randomUUID(), outcome: "started" },
			{ schema: "qorpera.member-machine-start-answer/v1", startId, outcome: "maybe" },
			{ schema: "qorpera.member-machine-start-answer/v1", startId, outcome: "started", more: 1 },
		])
			expect(() => parseCloudMemberMachineStartAnswer(request, bad)).toThrow();
	});
});

describe("a member's live picture of a desktop (20260930745000)", () => {
	function fixture(owner = "mx-a") {
		const ids = {
			passId: randomUUID(),
			companyId: randomUUID(),
			machineId: randomUUID(),
			placementId: randomUUID(),
			bootId: randomUUID(),
			userId: randomUUID(),
		};
		const answer = (requestOwner: string, change: Record<string, unknown> = {}) => ({
			schema: "qorpera.member-machine-desktop-pointer-authority/v1",
			state: "authorized",
			passId: ids.passId,
			machineId: ids.machineId,
			placementId: ids.placementId,
			bootId: ids.bootId,
			executorOwner: "mx-a",
			providerId: "machine-node",
			userId: ids.userId,
			generation: 4,
			private: false,
			milliseconds: 10000,
			served: requestOwner === "mx-a",
			...change,
		});
		let read: (owner: string) => unknown = (requestOwner) => answer(requestOwner);
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => read(args.p_owner as string));
		/** This node's desktop: sends what the test gives it, until the stream's signal aborts. */
		const streamed: { stream: CompanyMachineMemberStream; signal: AbortSignal }[] = [];
		const host = {
			memberStream: vi.fn(
				async (
					stream: CompanyMachineMemberStream,
					sink: { send(message: Buffer): Promise<void> },
					signal: AbortSignal,
				) => {
					streamed.push({ stream, signal });
					await sink.send(Buffer.from([1, 0, 64, 0, 40]));
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					return "closed";
				},
			),
		};
		let peerAnswer: (body: unknown) => Response = () => new Response(null, { status: 500 });
		const sent: { url: string; body: unknown }[] = [];
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: closed({ call }),
			credential: async () => randomBytes(32).toString("base64url"),
			memberPointerBegin: vi.fn(async () => ids.passId),
			memberStreamLocal: localMemberMachineStream(host),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				sent.push({ url: String(input), body });
				return peerAnswer(body);
			}) as typeof fetch,
		});
		const token = "eyJh.eyJz.c2ln";
		const where = { companyId: ids.companyId, machineId: ids.machineId, token };
		const origin = "https://app.qorpera.com";
		return {
			...ids,
			answer,
			call,
			host,
			router,
			where,
			origin,
			streamed,
			sent,
			reads: (next: (owner: string) => unknown) => {
				read = next;
			},
			peer: (next: (body: unknown) => Response) => {
				peerAnswer = next;
			},
			/** A pass of the member's, then a ticket for it. */
			ticket: async (hold: { generation: number } | { epoch: number; seat: number } = { generation: 4 }) => {
				await router.memberPointer(
					{ ...where, begin: "epoch" in hold ? hold : { generation: hold.generation } },
					new AbortController().signal,
				);
				return router.memberPointer(
					{ ...where, stream: { pass: ids.passId, hold }, origin },
					new AbortController().signal,
				);
			},
			signal: new AbortController().signal,
		};
	}
	const sinkOf = () => {
		const messages: Buffer[] = [];
		return {
			messages,
			send: vi.fn(async (message: Buffer) => void messages.push(message)),
		};
	};

	it("sells a ticket only on the member's own live pass, of its company, machine and hold: 32 random bytes, used once", async () => {
		const f = fixture();
		const sold = (await f.ticket()) as { ticket: string; seconds: number };
		expect(sold.seconds).toBe(30);
		expect(sold.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect((await f.ticket()) as { ticket: string }).not.toEqual(sold);
		for (const wrong of [
			{
				...f.where,
				token: "eyJh.eyJz.b3RoZXI",
				stream: { pass: f.passId, hold: { generation: 4 } },
				origin: f.origin,
			},
			{ ...f.where, companyId: randomUUID(), stream: { pass: f.passId, hold: { generation: 4 } }, origin: f.origin },
			{ ...f.where, machineId: randomUUID(), stream: { pass: f.passId, hold: { generation: 4 } }, origin: f.origin },
			{ ...f.where, stream: { pass: randomUUID(), hold: { generation: 4 } }, origin: f.origin },
			// Another hold than the pass's: another generation, or a private one on a shared pass.
			{ ...f.where, stream: { pass: f.passId, hold: { generation: 5 } }, origin: f.origin },
			{ ...f.where, stream: { pass: f.passId, hold: { epoch: 1, seat: 4 } }, origin: f.origin },
		])
			await expect(f.router.memberPointer(wrong, f.signal), JSON.stringify(wrong)).rejects.toEqual(
				new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED"),
			);
		// The admission uses it up, whatever comes of it: another Origin, then the right one.
		const again = (await f.ticket()) as { ticket: string };
		expect(f.router.admitMemberStream(again.ticket, "https://elsewhere.example")).toBeNull();
		expect(f.router.admitMemberStream(again.ticket, f.origin)).toBeNull();
		expect(f.router.admitMemberStream("x".repeat(43), f.origin)).toBeNull();
	});

	it("admits a ticket within its 30 s, at most two streams of a member and eight of a machine", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			const late = (await f.ticket()) as { ticket: string };
			vi.advanceTimersByTime(30_001);
			expect(f.router.admitMemberStream(late.ticket, f.origin)).toBeNull();
			const runs = [];
			for (let n = 0; n < 2; n++) {
				const run = f.router.admitMemberStream(((await f.ticket()) as { ticket: string }).ticket, f.origin);
				expect(run).not.toBeNull();
				runs.push(run);
			}
			// A third of the same member: refused (404 at the listener), the ticket used up.
			expect(f.router.admitMemberStream(((await f.ticket()) as { ticket: string }).ticket, f.origin)).toBeNull();
			// An admitted ticket never run gives its place back after a moment.
			vi.advanceTimersByTime(10_001);
			expect(f.router.admitMemberStream(((await f.ticket()) as { ticket: string }).ticket, f.origin)).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("streams this node's desktop for the member's hold while a live pass of that hold is held, and ends POINTER_PASS_ENDED once none is", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			const sold = (await f.ticket()) as { ticket: string };
			const run = f.router.admitMemberStream(sold.ticket, f.origin);
			const sink = sinkOf();
			const ended = run!(sink, f.signal);
			await vi.advanceTimersByTimeAsync(0);
			expect(f.streamed.map((one) => one.stream)).toEqual([
				{ placementId: f.placementId, bootId: f.bootId, userId: f.userId, generation: 4, epoch: null },
			]);
			expect(sink.messages).toHaveLength(1);
			// The window renews the pass while it watches: the stream goes on past the first pass's 10 s.
			vi.advanceTimersByTime(8000);
			await f.router.memberPointer({ ...f.where, begin: { generation: 4 } }, f.signal);
			await vi.advanceTimersByTimeAsync(4000);
			expect(f.streamed[0]!.signal.aborted).toBe(false);
			// No renewal: within a second of the last pass's end the stream ends.
			await vi.advanceTimersByTimeAsync(7000);
			expect(f.streamed[0]!.signal.aborted).toBe(true);
			expect(await ended).toBe("POINTER_PASS_ENDED");
		} finally {
			vi.useRealTimers();
		}
	});

	it("relays a desktop of another node through that node's peer listener, which reads the newest pass itself; a private hold names its epoch", async () => {
		const f = fixture("mx-c");
		const frames = (...parts: [1 | 2, Buffer][]) =>
			Buffer.concat(
				parts.map(([kind, payload]) => {
					const head = Buffer.alloc(5);
					head[0] = kind;
					head.writeUInt32BE(payload.byteLength, 1);
					return Buffer.concat([head, payload]);
				}),
			);
		f.peer(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							const bytes = frames(
								[1, Buffer.from("first")],
								[1, Buffer.from("second")],
								[2, Buffer.from("DESKTOP_HELD_SINCE")],
							);
							// In uneven pieces, as a network gives them.
							controller.enqueue(bytes.subarray(0, 7));
							controller.enqueue(bytes.subarray(7, 20));
							controller.enqueue(bytes.subarray(20));
							controller.close();
						},
					}),
					{ status: 200 },
				),
		);
		f.reads((requestOwner) => f.answer(requestOwner, { private: true, generation: 9 }));
		const sold = (await f.ticket({ epoch: 3, seat: 9 })) as { ticket: string };
		const sink = sinkOf();
		expect(await f.router.admitMemberStream(sold.ticket, f.origin)!(sink, f.signal)).toBe("DESKTOP_HELD_SINCE");
		expect(sink.messages.map(String)).toEqual(["first", "second"]);
		expect(f.sent.at(-1)).toEqual({
			url: "https://node-a.example/v1/machine-commands/member-stream",
			body: { schema: "qorpera.member-machine-stream-http/v1", passId: f.passId, epoch: 3 },
		});
		expect(f.host.memberStream).not.toHaveBeenCalled();
	});

	it("joins a peer's large frame from its small pieces once, never a growing buffer copied again for every piece (v245 release review)", async () => {
		const f = fixture("mx-c");
		// A whole 8 MiB picture, then the end, in 1 KiB pieces, with the frames' heads split across pieces too.
		const picture = Buffer.alloc(8 * 1024 * 1024);
		for (let i = 0; i < picture.length; i += 997) picture[i] = i & 0xff;
		const head = (kind: number, length: number) => {
			const out = Buffer.alloc(5);
			out[0] = kind;
			out.writeUInt32BE(length, 1);
			return out;
		};
		const reason = Buffer.from("DESKTOP_ENDED");
		const bytes = Buffer.concat([
			head(1, picture.length),
			picture,
			head(1, 3),
			Buffer.from("abc"),
			head(2, reason.length),
			reason,
		]);
		f.peer(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (let at = 0; at < bytes.length; at += 1024) controller.enqueue(bytes.subarray(at, at + 1024));
							controller.close();
						},
					}),
					{ status: 200 },
				),
		);
		f.reads((requestOwner) => f.answer(requestOwner, { private: true, generation: 9 }));
		const sold = (await f.ticket({ epoch: 3, seat: 9 })) as { ticket: string };
		const sink = sinkOf();
		const began = performance.now();
		expect(await f.router.admitMemberStream(sold.ticket, f.origin)!(sink, f.signal)).toBe("DESKTOP_ENDED");
		// Before: 8,192 pieces each copying all that came before them, about 34 GB of copying on node 1's event loop.
		expect(performance.now() - began).toBeLessThan(3000);
		expect(sink.messages).toHaveLength(2);
		expect(Buffer.from(sink.messages[0]!).equals(picture)).toBe(true);
		expect(String(sink.messages[1])).toBe("abc");
	});

	it("gives up a peer's send the moment the stream is cancelled, and sends nothing after it (review r2 F3 of #1746)", async () => {
		const f = fixture("mx-c");
		// The machine's node keeps sending; the member's browser answers pings but never reads.
		f.peer(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							const frame = (payload: Buffer) => {
								const head = Buffer.alloc(5);
								head[0] = 1;
								head.writeUInt32BE(payload.byteLength, 1);
								return Buffer.concat([head, payload]);
							};
							for (let n = 0; n < 5; n++) controller.enqueue(frame(Buffer.from(`picture ${n}`)));
							// The request stays open, as a real one does while the desktop is watched.
						},
					}),
					{ headers: { "content-type": "application/octet-stream" } },
				),
		);
		let blocked = 0;
		const sink = {
			send: vi.fn(async () => {
				blocked++;
				await new Promise<void>(() => {});
			}),
		};
		const stop = new AbortController();
		const sold = (await f.ticket()) as { ticket: string };
		const run = f.router.admitMemberStream(sold.ticket, f.origin);
		const ending = run!(sink, stop.signal);
		await vi.waitFor(() => expect(blocked).toBe(1));
		// The pass ends (or the member closes it): the peer's own await is let go at once, and nothing more is sent.
		stop.abort();
		expect(await ending).toBe("closed");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sink.send).toHaveBeenCalledTimes(1);
	});

	it("serves a peer's stream from the pass it reads itself, of the hold named, over the peer listener, until the asking executor closes it", async () => {
		const a = fixture("mx-a");
		const token = randomBytes(32).toString("base64url");
		const http = new HttpCloudCodingCommandService({
			token,
			proveBinding: null,
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(a.router, { call: a.call }, true) },
		});
		const port = await http.start();
		cleanups.push(() => http.close());
		const peer = createHttpMemberMachineScreenPeer({ url: `http://127.0.0.1:${port}`, token, allowLoopback: true });
		const stop = new AbortController();
		const sink = sinkOf();
		const ending = peer.memberStream({ passId: a.passId, epoch: null }, sink, stop.signal);
		await vi.waitFor(() => expect(sink.messages).toHaveLength(1));
		expect(a.streamed[0]!.stream).toEqual({
			placementId: a.placementId,
			bootId: a.bootId,
			userId: a.userId,
			generation: 4,
			epoch: null,
		});
		// The asking executor closes it: the desktop's stream here ends with it.
		stop.abort();
		expect(await ending).toBe("closed");
		await vi.waitFor(() => expect(a.streamed[0]!.signal.aborted).toBe(true));
		// A hold that is not the pass's (an epoch for a shared pass): refused before anything, its code back.
		expect(await peer.memberStream({ passId: a.passId, epoch: 2 }, sinkOf(), new AbortController().signal)).toBe(
			"POINTER_PASS_ENDED",
		);
		// A pass SQL no longer holds.
		a.reads(() => {
			throw new Error("gone");
		});
		expect(await peer.memberStream({ passId: a.passId, epoch: null }, sinkOf(), new AbortController().signal)).toBe(
			"STREAM_UNAVAILABLE",
		);
		// A pass with nothing left once SQL answered: refused before anything is shown (v242 release review r1 F2).
		a.reads((owner) => a.answer(owner, { milliseconds: 0 }));
		expect(await peer.memberStream({ passId: a.passId, epoch: null }, sinkOf(), new AbortController().signal)).toBe(
			"POINTER_PASS_ENDED",
		);
		expect(a.streamed).toHaveLength(1);
		// On the ingress (not the peer listener): no such route.
		const ingress = new HttpCloudCodingCommandService({
			token,
			proveBinding: async () => {},
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(a.router, { call: a.call }, false) },
		});
		const ingressPort = await ingress.start();
		cleanups.push(() => ingress.close());
		expect(
			await createHttpMemberMachineScreenPeer({
				url: `http://127.0.0.1:${ingressPort}`,
				token,
				allowLoopback: true,
			}).memberStream({ passId: a.passId, epoch: null }, sinkOf(), new AbortController().signal),
		).toBe("STREAM_UNAVAILABLE");

		let fetchAborted = false;
		const stalledPeer = createHttpMemberMachineScreenPeer({
			url: "https://node-stalled.example",
			token,
			streamConnectTimeoutMs: 50,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						fetchAborted = true;
						reject(init.signal?.reason ?? new Error("aborted"));
					});
				}),
		});
		const startedAt = performance.now();
		expect(
			await stalledPeer.memberStream({ passId: a.passId, epoch: null }, sinkOf(), new AbortController().signal),
		).toBe("STREAM_UNAVAILABLE");
		expect(fetchAborted).toBe(true);
		expect(performance.now() - startedAt).toBeLessThan(2_000);

		const delayed = fixture("mx-a");
		delayed.host.memberStream.mockImplementationOnce(async (_stream, sink, signal) => {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 750);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			if (signal.aborted) return "closed";
			await sink.send(Buffer.from("late-first-frame"));
			return "DESKTOP_ENDED";
		});
		const delayedHttp = new HttpCloudCodingCommandService({
			token,
			proveBinding: null,
			authorize: async () => {
				throw new Error("not a coding command");
			},
			execute: async () => {
				throw new Error("not a coding command");
			},
			machines: { ...machineCommandRoutes(delayed.router, { call: delayed.call }, true) },
		});
		const delayedPort = await delayedHttp.start();
		cleanups.push(() => delayedHttp.close());
		const delayedSink = sinkOf();
		const delayedReason = await createHttpMemberMachineScreenPeer({
			url: `http://127.0.0.1:${delayedPort}`,
			token,
			allowLoopback: true,
			streamConnectTimeoutMs: 400,
		}).memberStream({ passId: delayed.passId, epoch: null }, delayedSink, new AbortController().signal);
		expect(delayedReason).toBe("DESKTOP_ENDED");
		expect(delayedSink.messages.map(String)).toEqual(["late-first-frame"]);
	});
});
