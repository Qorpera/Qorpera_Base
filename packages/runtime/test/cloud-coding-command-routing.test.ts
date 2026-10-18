import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingCommandRouter } from "../../../deploy/coding-worker/command-routing.ts";
import {
	type CloudCodingCommandHttpRequest,
	type CloudCodingCommandServiceOptions,
	createHttpCloudCodingCommandGateway,
	HttpCloudCodingCommandService,
} from "../src/cloud-coding-command-http.ts";
import { cloudNativeToolOperationEnvelope } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture() {
	const { authority, binding } = nativeToolAuthorityFixture();
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
	const operationKey = "build:1",
		command = "printf test",
		timeoutMs = 1000;
	const inputSha256 = createHash("sha256")
		.update(
			cloudNativeToolOperationEnvelope(authority.identity, {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: operationKey,
				arguments: { operationKey, command, timeoutMs },
				target: { schema: "qorpera.coding-command-target/v1", ...scope },
				requiresCompanyRevision: false,
			}),
		)
		.digest("hex");
	const request: CloudCodingCommandHttpRequest = {
		schema: "qorpera.coding-command-http/v1",
		binding,
		scope,
		action: "start",
		input: { commandId: randomUUID(), inputSha256, command, timeoutMs },
	};
	const route = {
		schema: "qorpera.coding-command-route/v1",
		executorOwner: "node-two",
		providerId: "coding-two",
		machineId: scope.vmId,
	};
	const call = vi.fn(async (method: string) =>
		method === "qorpera_route_coding_command"
			? route
			: {
					authority: {
						...authority,
						coding: { workerId: scope.workerId, vmId: scope.vmId, turnId: scope.requestId, sequence: scope.turn },
					},
					operationKey,
					inputSha256,
				},
	);
	const receipt = {
		schema: "qorpera.coding-command-result/v2",
		workerId: scope.workerId,
		commandId: request.input.commandId,
		inputSha256,
		state: "running",
		exitCode: null,
		truncated: false,
		output: "",
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 1048576, limitReached: false },
	};
	const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(receipt)));
	const executeLocal = vi.fn(async () => ({ receipt, hidden: async () => undefined }));
	const credential = vi.fn(async () => Buffer.alloc(32, 3).toString("base64url"));
	const router = new CodingCommandRouter({
		owner: "node-one",
		providerId: "coding-one",
		control: { call },
		executeLocal,
		credential,
		fetch: fetcher,
		peers: [
			{
				owner: "node-two",
				providerId: "coding-two",
				origin: "https://peer-two.qorpera.test",
				tokenCredential: "qorpera-coding-peer-two",
			},
		],
	});
	return {
		router,
		route,
		request,
		call,
		receipt,
		fetcher,
		executeLocal,
		credential,
		signal: new AbortController().signal,
	};
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
/** This executor's ingress, as the guest's gateway calls it: the command service over the router. */
async function ingress(f: ReturnType<typeof fixture>, authorize?: CloudCodingCommandServiceOptions["authorize"]) {
	const token = randomBytes(32).toString("base64url");
	const service = new HttpCloudCodingCommandService({
		token,
		proveBinding: null,
		authorize: authorize ?? (async () => ({ inputSha256: f.receipt.inputSha256 })),
		execute: (request, signal) => f.router.execute(request, signal),
	});
	const url = `http://127.0.0.1:${await service.start()}`;
	cleanups.push(() => service.close());
	const gateway = createHttpCloudCodingCommandGateway({
		url,
		token,
		binding: f.request.binding,
		holder: null,
		authorize: async () => undefined,
		allowLoopback: true,
	});
	return { url, token, gateway };
}

describe("coding commands follow SQL machine placement", () => {
	it("forwards exact admitted request once to the configured peer with its own credential", async () => {
		const f = fixture();
		const executed = await f.router.execute(f.request, f.signal);
		expect(executed.receipt).toEqual(f.receipt);
		// The peer's own service decided what of the command its receipt shows (F3 5g-5).
		await expect(executed.hidden(f.signal)).resolves.toBeUndefined();
		expect(f.credential).toHaveBeenCalledWith("qorpera-coding-peer-two");
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(f.fetcher).toHaveBeenCalledWith(
			"https://peer-two.qorpera.test/v1/coding-commands/start",
			expect.objectContaining({
				redirect: "error",
				body: JSON.stringify(f.request),
				headers: expect.objectContaining({ authorization: `Bearer ${Buffer.alloc(32, 3).toString("base64url")}` }),
			}),
		);
		// The peer listener takes no holder: this executor proved the guest's at its own ingress (G2-6b).
		expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("x-qorpera-identity")).toBe(false);
		expect(f.executeLocal).not.toHaveBeenCalled();
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_route_coding_command",
			{
				p_binding: f.request.binding,
				p_scope: f.request.scope,
				p_action: "start",
				p_command_id: f.request.input.commandId,
				p_input_sha256: f.receipt.inputSha256,
			},
			f.signal,
		);
	});
	it("executes locally only for exact owner/provider placement", async () => {
		const f = fixture();
		Object.assign(f.route, { executorOwner: "node-one", providerId: "coding-one" });
		expect((await f.router.execute(f.request, f.signal, true)).receipt).toEqual(f.receipt);
		expect(f.executeLocal).toHaveBeenCalledOnce();
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.credential).not.toHaveBeenCalled();
	});
	it("never forwards requests received on the peer listener", async () => {
		const f = fixture();
		await expect(f.router.execute(f.request, f.signal, true)).rejects.toThrow("WRONG_EXECUTOR");
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.executeLocal).not.toHaveBeenCalled();
	});
	it.each([
		{ machineId: randomUUID() },
		{ executorOwner: "unknown" },
		{ providerId: "coding-one" },
		{ origin: "https://attacker.test" },
		{ schema: "wrong" },
	])("refuses an unrecognized or mismatched placement %j before releasing peer credentials", async (change) => {
		const f = fixture();
		Object.assign(f.route, change);
		await expect(f.router.execute(f.request, f.signal)).rejects.toThrow("CODING_COMMAND_ROUTE");
		expect(f.credential).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.executeLocal).not.toHaveBeenCalled();
	});
	it("verifies exact admitted command bytes before looking up placement", async () => {
		const f = fixture();
		if (f.request.action !== "start") throw new Error("fixture");
		await expect(
			f.router.execute({ ...f.request, input: { ...f.request.input, command: "different" } }, f.signal),
		).rejects.toThrow("INPUT_DIFFERS");
		expect(f.call).toHaveBeenCalledOnce();
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("does not retry uncertain remote effects or expose transport secrets", async () => {
		const f = fixture();
		f.fetcher.mockRejectedValue(new Error("secret token"));
		await expect(f.router.execute(f.request, f.signal)).rejects.toThrow(/^Coding command gateway unavailable$/);
		expect(f.fetcher).toHaveBeenCalledOnce();
	});
	it.each(["read", "cancel"] as const)("routes %s using the same authoritative placement", async (action) => {
		const f = fixture();
		const request: CloudCodingCommandHttpRequest = {
			...f.request,
			action,
			input: { commandId: f.request.input.commandId },
		};
		expect((await f.router.execute(request, f.signal)).receipt).toEqual(f.receipt);
		expect(f.fetcher).toHaveBeenCalledWith(
			`https://peer-two.qorpera.test/v1/coding-commands/${action}`,
			expect.objectContaining({ method: "POST", redirect: "error" }),
		);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_route_coding_command",
			expect.objectContaining({ p_action: action, p_input_sha256: null }),
			f.signal,
		);
	});
	it.each([{ workerId: randomUUID() }, { commandId: randomUUID() }, { inputSha256: "0".repeat(64) }])(
		"rejects a peer receipt for a different command %j",
		async (change) => {
			const f = fixture();
			f.fetcher.mockResolvedValue(new Response(JSON.stringify({ ...f.receipt, ...change })));
			await expect(f.router.execute(f.request, f.signal)).rejects.toThrow(/^Coding command gateway unavailable$/);
			expect(f.fetcher).toHaveBeenCalledOnce();
		},
	);
	it("passes a peer's receipt that shows nothing of its command at any page, through both gateways (F3 5g-5)", async () => {
		const f = fixture();
		const nothing = { ...f.receipt, state: "machine_stopped" };
		f.fetcher.mockImplementation(async () => new Response(JSON.stringify(nothing)));
		const { gateway } = await ingress(f);
		const page = { commandId: f.request.input.commandId, offset: 5, limit: 64 };
		expect(await gateway.read(f.request.scope, page, f.signal)).toStrictEqual(nothing);
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "read", input: page });
		// One that shows how much it printed is still another page's.
		f.fetcher.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ ...nothing, log: { ...nothing.log, offset: 13, nextOffset: 13, totalBytes: 13 } }),
				),
		);
		await expect(gateway.read(f.request.scope, page, f.signal)).rejects.toThrow(
			/^Coding command gateway unavailable$/,
		);
	});
	it("drops a peer's shown answer when the ingress's final authorization refuses it (F3 5g-5)", async () => {
		const f = fixture();
		f.fetcher.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						...f.receipt,
						output: "secret",
						log: { ...f.receipt.log, nextOffset: 6, totalBytes: 6 },
					}),
				),
		);
		const authorize = vi
			.fn<CloudCodingCommandServiceOptions["authorize"]>()
			.mockResolvedValueOnce({ inputSha256: f.receipt.inputSha256 })
			.mockRejectedValueOnce(new Error("revoked"));
		const { url, token } = await ingress(f, authorize);
		const refused = await fetch(`${url}/v1/coding-commands/read`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ ...f.request, action: "read", input: { commandId: f.request.input.commandId } }),
		});
		expect(refused.status).toBe(403);
		const body = await refused.text();
		expect(JSON.parse(body)).toEqual({ error: "coding_command_unavailable" });
		expect(body).not.toContain("secret");
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(authorize).toHaveBeenCalledTimes(2);
	});
});
