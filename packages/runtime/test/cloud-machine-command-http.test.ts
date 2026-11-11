import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudMachineCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authorizeMachineCodingValue,
	authorizeMachineCommand,
	authorizeMachineScreen,
	authorizeMemberMachineAct,
	authorizeMemberMachineScreen,
} from "../../../deploy/coding-worker/machine-command-authority.ts";
import {
	localMachineCodingValue,
	localMachineScreen,
	localMachineWake,
	localMemberMachineAct,
	localMemberMachineScreen,
	MachineCommandRouter,
	machineCommandRoutes,
} from "../../../deploy/coding-worker/machine-command-routing.ts";
import type {
	CompanyMachineMemberActOutcome,
	CompanyMachineMemberLookOutcome,
} from "../../runner-orchestrator/src/company-machine-host.ts";
import { HttpCloudCodingCommandService } from "../src/cloud-coding-command-http.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	type CloudMachineCodingValueHttpRequest,
	CloudMachineCodingValueRefusal,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	CloudMachineCommandUnanswered,
	type CloudMachineScreenHttpRequest,
	CloudMachineScreenRefusal,
	type CloudMachineWakeHttpRequest,
	CloudMemberMachineActRefusal,
	CloudMemberMachineScreenRefusal,
	cloudMemberMachineActRecord,
	createHttpCloudMachineCommandGateway,
	createHttpMemberMachineScreenPeer,
	parseCloudMachineCodingValueHttpRequest,
	parseCloudMachineScreenAnswer,
	parseCloudMachineScreenHttpRequest,
	parseCloudMemberMachineActAnswer,
	parseCloudMemberMachineAction,
	parseCloudMemberMachineActPeerRequest,
	parseCloudMemberMachineScreenAnswer,
	parseCloudMemberMachineScreenPeerRequest,
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
			control: { call: vi.fn() },
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
		const wake = vi.fn(async (_request: unknown, _signal: AbortSignal, _localOnly?: boolean) => true);
		const execute = vi.fn();
		const fake = { wake, execute } as unknown as MachineCommandRouter;
		const asked = request();
		expect(await machineCommandRoutes(fake, { call: vi.fn() }, false).wake(asked, signal)).toBe(true);
		expect(await machineCommandRoutes(fake, { call: vi.fn() }, true).wake(asked, signal)).toBe(true);
		expect(wake.mock.calls.map((call) => call[2])).toEqual([false, true]);
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
		};
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>) => answer as unknown);
		const host = {
			codingValue: vi.fn(async () => ({ box }) as { box: Record<string, string> } | { refused: string }),
		};
		const router = new MachineCommandRouter({
			owner: "mx-a",
			providerId: "machine-node",
			peers: [],
			control: { call },
			credential: async () => "",
			codingValueLocal: localMachineCodingValue(host),
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
		expect(f.host.codingValue).toHaveBeenCalledWith(
			{
				placementId: f.answer.placementId,
				bootId: f.answer.bootId,
				receiptId: f.request.input.commandId,
				target: f.target,
			},
			f.signal,
		);
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
		for (const code of ["CLIPBOARD_EMPTY", "CLIPBOARD_MORE_THAN_ONE_KEY", "MACHINE_IMAGE_WITHOUT_CODING_VALUES"]) {
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
			control: { call: f.call },
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
			control: { call },
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
			},
			f.signal,
		);
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
			control: { call: f.call },
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
			control: { call },
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
			control: { call: f.call },
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
		const sent: { url: string; body: unknown }[] = [];
		const router = new MachineCommandRouter({
			owner,
			providerId: "machine-node",
			peers: [
				{ owner: "mx-a", providerId: "machine-node", origin: "https://node-a.example", tokenCredential: "peer-a" },
				{ owner: "mx-c", providerId: "machine-node", origin: "https://node-c.example", tokenCredential: "peer-c" },
			].filter((peer) => peer.owner !== owner),
			control: { call },
			credential: async () => randomBytes(32).toString("base64url"),
			memberActBegin,
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
		};
		return { ...ids, answer, call, host, memberActBegin, router, act, sent, signal: new AbortController().signal };
	}

	it("begins the action as the member, reads it as the machine's own executor and runs it on this node", async () => {
		const f = fixture();
		expect(await f.router.memberAct(f.act, f.signal)).toEqual({ exitCode: 0 });
		expect(f.memberActBegin).toHaveBeenCalledWith(
			"eyJh.eyJz.c2ln",
			// With the epoch of the hold its input was captured under (F24).
			{ companyId: f.companyId, machineId: f.machineId, action: typed, epoch: 4 },
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
		expect(f.host.memberAct).toHaveBeenCalledWith(
			{ placementId: f.placementId, bootId: f.bootId, actionId: f.actionId, action: typed },
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
			control: { call: f.call },
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
