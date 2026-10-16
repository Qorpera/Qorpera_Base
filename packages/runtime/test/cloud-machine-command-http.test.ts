import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudMachineCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeMachineCommand } from "../../../deploy/coding-worker/machine-command-authority.ts";
import { MachineCommandRouter } from "../../../deploy/coding-worker/machine-command-routing.ts";
import { HttpCloudCodingCommandService } from "../src/cloud-coding-command-http.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	createHttpCloudMachineCommandGateway,
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
		machines: { authorize: (request) => authorize(request), execute: (request) => execute(request) },
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
		});
		// Before the machine's first boot, there is none.
		f.call.mockResolvedValueOnce({ ...f.answer, bootId: null });
		expect(await authorizeMachineCommand(f, f.request, f.signal)).toMatchObject({ bootId: null });
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
		// An answer without the placement it runs on is no authority.
		f.call.mockResolvedValueOnce({ ...f.answer, placementId: undefined });
		await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
			"MACHINE_COMMAND_AUTHORITY_INVALID",
		);
		// Nor is one whose boot is not a boot id.
		for (const bootId of [undefined, "boot-1", 7]) {
			f.call.mockResolvedValueOnce({ ...f.answer, bootId });
			await expect(authorizeMachineCommand(f, f.request, f.signal)).rejects.toThrow(
				"MACHINE_COMMAND_AUTHORITY_INVALID",
			);
		}
	});
	it("passes a peer's refusal on as the same refusal", async () => {
		const f = fixture();
		const forwarded: Headers[] = [];
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
				return new Response(JSON.stringify({ code: "MACHINE_NOT_RUNNING" }), { status: 409 });
			}) as typeof fetch,
		});
		await expect(router.execute(f.request, f.signal)).rejects.toMatchObject({ code: "MACHINE_NOT_RUNNING" });
		// The peer listener takes no holder: this executor proved the guest's at its own ingress (G2-6b).
		expect(forwarded.map((headers) => headers.has("x-qorpera-identity"))).toEqual([false]);
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
