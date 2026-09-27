import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type {
	CompanyComputerEffectContext,
	CompanyComputerOperation,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CompanyComputerGuestEndpoint } from "@qorpera/runtime/cloud-company-computer-endpoint";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import {
	COMPANY_COMPUTER_NATIVE_SCHEMA,
	createHttpCompanyComputerSessionFactory,
	HttpCompanyComputerNativeEndpoint,
	parseCompanyComputerNativeDescriptor,
	parseCompanyComputerNativeUrl,
} from "@qorpera/runtime/cloud-company-computer-native-client";
import {
	CompanyComputerGuestSessionRefusedError,
	CompanyComputerNativeGateway,
	startCompanyComputerNativeGateway,
} from "@qorpera/runtime/cloud-company-computer-native-gateway";
import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerLease,
	computerOperation,
	computerScope,
} from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

let directory: string;
let cert: Buffer;
let key: Buffer;
let originalCAs: string[];
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "qorpera-native-office-tls-"));
	const generated = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(directory, "key.pem"),
			"-out",
			join(directory, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ timeout: 15000, encoding: "utf8" },
	);
	if (generated.status !== 0) throw new Error("Disposable TLS certificate creation failed");
	cert = await readFile(join(directory, "cert.pem"));
	key = await readFile(join(directory, "key.pem"));
	originalCAs = getCACertificates("default");
	setDefaultCACertificates([...originalCAs, cert]);
});
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
	setDefaultCACertificates(originalCAs);
	await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { unavailable?: boolean; admitWork?: () => void } = {}) {
	const source = nativeToolAuthorityFixture();
	const scope = {
		...computerScope(),
		companyId: source.authority.identity.companyId,
		environmentId: source.authority.identity.environmentId,
	};
	const lease = {
		...computerLease(),
		binding: { ...computerBinding(), ...scope, staffAgentId: source.authority.identity.staffAgentId },
		driver: {
			kind: "agent" as const,
			runId: source.binding.runId,
			staffAgentId: source.authority.identity.staffAgentId,
		},
	};
	const descriptor = {
		state: "available" as const,
		scope,
		capabilities: ["shell" as const],
		resources: { officeGrantId: randomUUID(), officeGrantVersion: 1, officePrivacyVersion: 0 },
	};
	const operation: CompanyComputerOperation = {
		...computerOperation(),
		tool: "computer_shell",
		arguments: { kind: "shell", command: "printf test", timeoutMs: 1000 },
		target: { realm: "company_computer", binding: lease.binding, resources: descriptor.resources },
	};
	const order: string[] = [];
	const consumed = new Map<string, string>();
	let revoked = false;
	let released = false;
	let expectedDrainFailure = false;
	const sql = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const method = String(input).split("/").at(-1);
		const body = JSON.parse(String(init?.body));
		order.push(`${method}:${body.p_action ?? "read"}`);
		if (method === "qorpera_describe_native_tool_authority") return Response.json(revoked ? {} : source.authority);
		if (method === "qorpera_native_office_descriptor")
			return Response.json(options.unavailable ? { state: "unavailable" } : descriptor);
		if (method === "qorpera_native_office_start_descriptor") return Response.json({ state: "unavailable" });
		if (method === "qorpera_native_office_screen" && body.p_action === "release") {
			released = true;
			return Response.json({ state: "released" });
		}
		if (method === "qorpera_native_office_screen") return Response.json({ state: "admitted", lease });
		if (method === "qorpera_native_office_operation") {
			if (body.p_action === "finish") return Response.json({ state: "drained" });
			if (released || revoked) return new Response("private SQL diagnostic", { status: 403 });
			if (body.p_action === "authorize") return Response.json({ state: "authorized" });
			if (body.p_action === "begin") {
				if (consumed.has(body.p_receipt_id)) return new Response("already consumed", { status: 403 });
				consumed.set(body.p_receipt_id, randomUUID());
			}
			return Response.json({
				state: "admitted",
				resourceLeaseId: consumed.get(body.p_receipt_id),
				validForMs: 30000,
			});
		}
		throw new Error(`Unexpected RPC ${method}`);
	});
	const registry = new HttpCloudCompanyComputerRegistry({
		supabaseUrl: "https://registry.qorpera.test",
		serviceRoleKey: "synthetic-service-key",
		fetch: sql,
	});
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => (revoked ? {} : source.authority) },
		new AbortController().signal,
	);
	cleanups.push(async () => run.close());
	const perform = vi.fn(async (_action: unknown, _lease: unknown, _context: CompanyComputerEffectContext) => {
		order.push("guest:perform");
		return { kind: "text" as const, value: "test" };
	});
	const physicalClose = vi.fn(async () => {
		order.push("guest:close");
	});
	const stopBrowser = vi.fn(async () => {
		order.push("guest:stop-browser");
	});
	const gate = new CompanyComputerScreenActionGate();
	/** Whether the guest itself ended each session it handed out, in order. */
	const guests: { ended: boolean }[] = [];
	const createSession = vi.fn(
		async ({
			run: bound,
			descriptor: admitted,
			lease: screen,
			effects,
		}: Parameters<ConstructorParameters<typeof CompanyComputerNativeGateway>[0]["createSession"]>[0]) => {
			expect(bound.identity).toEqual(run.identity);
			const guest = { ended: false };
			guests.push(guest);
			return {
				endpoint: new CompanyComputerGuestEndpoint({
					binding: screen.binding,
					capabilities: admitted.capabilities,
					resourceTarget: admitted.resources,
					effects,
					gate,
					automation: { perform, stopBrowser },
					assertScreenAdmitted: async () => undefined,
					prepareScreen: async () => undefined,
				}),
				close: physicalClose,
				ended: () => guest.ended,
			};
		},
	);
	const token = randomBytes(32).toString("base64url");
	const gateway = new CompanyComputerNativeGateway({
		scope,
		computerGeneration: 1,
		token,
		registry,
		createSession,
		admitWork: options.admitWork,
	});
	const listener = await startCompanyComputerNativeGateway({
		host: "127.0.0.1",
		port: 0,
		tls: { cert, key },
		gateway,
	});
	cleanups.push(async () => {
		if (expectedDrainFailure) await expect(listener.close()).rejects.toThrow("OFFICE_NATIVE_DRAIN_UNCONFIRMED");
		else await listener.close();
	});
	const url = `https://127.0.0.1:${listener.port}/office/${scope.companyComputerId}/native`;
	const endpoint = new HttpCompanyComputerNativeEndpoint({ run, descriptor, url, token, registry });
	const context = {
		identity: run.identity,
		receiptId: randomUUID(),
		idempotencyKey: "a".repeat(64),
		signal: run.signal,
	};
	const body = () => ({
		schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
		nativeBinding: source.binding,
		action: "perform",
		operation,
		lease,
		receipt: { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey },
	});
	const post = (value: unknown, options: { token?: string; origin?: string; suffix?: string } = {}) =>
		fetch(url + (options.suffix ?? ""), {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.token ?? token}`,
				"content-type": "application/json",
				...(options.origin ? { origin: options.origin } : {}),
			},
			body: JSON.stringify(value),
		});
	return {
		source,
		scope,
		lease,
		descriptor,
		operation,
		order,
		sql,
		registry,
		run,
		perform,
		physicalClose,
		stopBrowser,
		createSession,
		guests,
		endpoint,
		context,
		body,
		post,
		url,
		token,
		revoke: () => {
			revoked = true;
		},
		expectDrainFailure: () => {
			expectedDrainFailure = true;
		},
	};
}

describe("native runtime to office transport (real TLS, synthetic SQL and guest effects)", () => {
	it.each(["shell", "transfer"] as const)(
		"connects %s through the service factory, native ledger and TLS guest boundary",
		async (kind) => {
			const f = await fixture();
			const control: CloudNativeToolOperationControlPlane = {
				beginToolOperation: vi.fn(async (binding, input) => ({
					run_id: binding.runId,
					receipt_id: input.receiptId,
					state: "executing",
					result: null,
					output_snapshot_id: null,
					proposal_id: null,
				})),
				completeToolOperation: vi.fn(async (binding, input) => {
					f.order.push("native:complete");
					return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
				}),
			};
			const operations = new CloudNativeToolOperations(f.run, control);
			const factory = createHttpCompanyComputerSessionFactory({ url: f.url, token: f.token, registry: f.registry });
			const session = await factory(f.run, operations);
			if (!session) throw new Error("Missing admitted office session");
			cleanups.push(session.close);
			expect(session.tools.map((tool) => tool.name)).toEqual([
				"computer_screen",
				"computer_shell",
				"computer_transfer",
			]);
			const tool = session.tools.find((tool) => tool.name === `computer_${kind}`)!;
			const context = { companyId: f.run.identity.companyId, runId: f.run.identity.runId, signal: f.run.signal };
			const action =
				kind === "shell"
					? f.operation.arguments
					: {
							kind: "transfer",
							action: "export",
							source: { realm: "company_computer", path: "reports/$(literal).bin" },
							destination: { realm: "object_storage" },
							mediaType: "application/octet-stream",
						};
			const args = { operationKey: "native-office:1", action };
			expect(await tool.execute(args, context)).toEqual({ kind: "text", value: "test" });
			expect(await tool.execute(args, context)).toEqual({ kind: "text", value: "test" });
			expect(f.perform).toHaveBeenCalledOnce();
			expect(f.perform.mock.calls[0][0]).toEqual(action);
			expect(control.beginToolOperation).toHaveBeenCalledOnce();
			expect(control.completeToolOperation).toHaveBeenCalledOnce();
			expect(f.order.indexOf("qorpera_native_office_operation:finish")).toBeLessThan(
				f.order.indexOf("native:complete"),
			);
			f.run.close();
			await session.close();
			expect(f.physicalClose).toHaveBeenCalledOnce();
		},
	);
	it("omits office tools for unavailable offices and never queries office metadata for private runs", async () => {
		const f = await fixture({ unavailable: true });
		const control = { beginToolOperation: vi.fn(), completeToolOperation: vi.fn() };
		const factory = createHttpCompanyComputerSessionFactory({ url: f.url, token: f.token, registry: f.registry });
		expect(await factory(f.run, new CloudNativeToolOperations(f.run, control))).toBeUndefined();
		const source = nativeToolAuthorityFixture();
		const privateAuthority = {
			...source.authority,
			identity: {
				...source.authority.identity,
				audienceKind: "member_private" as const,
				audienceUserId: source.authority.identity.requesterUserId,
			},
		};
		const run = await CloudNativeToolRun.open(
			source.binding,
			{ describeToolAuthority: async () => privateAuthority },
			new AbortController().signal,
		);
		cleanups.push(async () => run.close());
		f.sql.mockClear();
		expect(await factory(run, new CloudNativeToolOperations(run, control))).toBeUndefined();
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("does not exhaust session capacity after repeated pre-guest authority rejection", async () => {
		const f = await fixture();
		for (let index = 0; index < 65; index++) {
			const response = await f.post({
				...f.body(),
				lease: { ...f.lease, leaseId: randomUUID(), binding: { ...f.lease.binding, computerGeneration: 2 } },
			});
			expect(response.status).toBe(503);
		}
		expect(f.createSession).not.toHaveBeenCalled();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		await f.endpoint.close();
		expect(f.perform).toHaveBeenCalledOnce();
	});
	it("re-derives the native principal, consumes the original receipt and physically closes before releasing occupancy", async () => {
		const f = await fixture();
		await f.endpoint.authorize(f.operation, f.run.identity, f.lease, f.run.signal);
		expect(await f.endpoint.perform(f.operation, f.lease, f.context)).toEqual({ kind: "text", value: "test" });
		expect(f.perform).toHaveBeenCalledOnce();
		expect(f.order.indexOf("qorpera_native_office_operation:begin")).toBeLessThan(f.order.indexOf("guest:perform"));
		expect(f.order).toContain("qorpera_native_office_operation:finish");
		const begin = f.sql.mock.calls
			.map(([, init]) => JSON.parse(String(init?.body)))
			.find((body) => body.p_action === "begin");
		expect(begin).toMatchObject({
			p_binding: f.source.binding,
			p_lease: f.lease,
			p_receipt_id: f.context.receiptId,
			p_idempotency_sha256: createHash("sha256").update(f.context.idempotencyKey).digest("hex"),
		});
		expect(JSON.stringify(begin)).not.toContain(f.token);
		await f.endpoint.close();
		await f.endpoint.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order.indexOf("guest:close")).toBeLessThan(f.order.indexOf("qorpera_native_office_screen:release"));
	});
	it("opens a fresh guest session under the same lease after the guest ended the old one", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		// The screen was drained mid-run (for example after a lost authority grace).
		f.guests[0].ended = true;
		const next = { ...f.context, receiptId: randomUUID() };
		expect(await f.endpoint.perform(f.operation, f.lease, next)).toEqual({ kind: "text", value: "test" });
		expect(f.createSession).toHaveBeenCalledTimes(2);
		expect(f.perform).toHaveBeenCalledTimes(2);
		// A changed configuration still takes the old session's place, so the run's
		// close reaps it, but its endpoint refuses what the run was admitted with.
		f.guests[1].ended = true;
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (input, init) =>
			String(input).endsWith("/qorpera_native_office_descriptor")
				? Response.json({ ...f.descriptor, resources: { ...f.descriptor.resources, officeGrantVersion: 2 } })
				: original(input, init),
		);
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		await expect(
			f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() }),
		).rejects.toThrow();
		expect(f.createSession).toHaveBeenCalledTimes(3);
		expect(f.perform).toHaveBeenCalledTimes(2);
		expect(f.physicalClose).not.toHaveBeenCalled();
		await f.endpoint.close();
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("keeps no capacity for a session the guest refused to create", async () => {
		const f = await fixture();
		f.createSession.mockRejectedValueOnce(new CompanyComputerGuestSessionRefusedError("OFFICE_PRIVACY_FENCED"));
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow();
		expect(await f.endpoint.perform(f.operation, f.lease, { ...f.context, receiptId: randomUUID() })).toEqual({
			kind: "text",
			value: "test",
		});
		expect(f.createSession).toHaveBeenCalledTimes(2);
	});
	it("releases only the exact existing session while stale status blocks all new work", async () => {
		let stale = false;
		const admitWork = vi.fn(() => {
			if (stale) throw new Error("OFFICE_SUPERVISOR_STATUS_STALE");
		});
		const f = await fixture({ admitWork });
		await f.endpoint.perform(f.operation, f.lease, f.context);
		stale = true;
		f.sql.mockClear();
		const next = { ...f.body(), receipt: { receiptId: randomUUID(), idempotencyKey: "b".repeat(64) } };
		expect((await f.post(next)).status).toBe(503);
		expect((await f.post({ ...next, lease: { ...f.lease, leaseId: randomUUID() } })).status).toBe(503);
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.perform).toHaveBeenCalledOnce();
		const release = {
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			action: "release",
			nativeBinding: f.source.binding,
			lease: f.lease,
		};
		for (const invalid of [
			{ ...release, lease: { ...f.lease, epoch: f.lease.epoch + 1 } },
			{ ...release, lease: { ...f.lease, leaseId: randomUUID() } },
			{ ...release, operation: f.operation },
		])
			expect((await f.post(invalid)).status).toBe(503);
		expect((await f.post(release, { token: randomBytes(32).toString("base64url") })).status).toBe(403);
		expect(f.physicalClose).not.toHaveBeenCalled();
		expect(f.sql).not.toHaveBeenCalled();
		expect((await f.post(release)).status).toBe(200);
		expect((await f.post(release)).status).toBe(200);
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order.indexOf("guest:close")).toBeLessThan(f.order.indexOf("qorpera_native_office_screen:release"));
		expect(f.sql).toHaveBeenCalledOnce();
		expect(f.createSession).toHaveBeenCalledOnce();
	});
	it("never dispatches a receipt twice and never reopens a released session", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(f.perform).toHaveBeenCalledOnce();
		await f.endpoint.close();
		const response = await f.post({
			...f.body(),
			receipt: { receiptId: randomUUID(), idempotencyKey: "b".repeat(64) },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
		expect(f.createSession).toHaveBeenCalledOnce();
	});
	it("retains cleanup and never retries when the completed HTTP response is lost", async () => {
		const f = await fixture();
		const transport = vi.fn<typeof fetch>(async (url, init) => {
			const response = await fetch(url, init);
			if (JSON.parse(String(init?.body)).action === "perform") {
				expect(response.status).toBe(200);
				await response.arrayBuffer();
				throw new Error("private transport diagnostic");
			}
			return response;
		});
		const endpoint = new HttpCompanyComputerNativeEndpoint({
			run: f.run,
			descriptor: f.descriptor,
			registry: f.registry,
			url: f.url,
			token: f.token,
			fetch: transport,
		});
		await expect(endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(transport).toHaveBeenCalledOnce();
		expect(f.perform).toHaveBeenCalledOnce();
		await endpoint.close();
		expect(transport).toHaveBeenCalledTimes(2);
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("quarantines an uncertain guest factory failure and reports shutdown as unconfirmed", async () => {
		const f = await fixture();
		f.createSession.mockRejectedValueOnce(new Error("unknown guest ownership"));
		f.expectDrainFailure();
		const response = await f.post(f.body());
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
		const retry = await f.post(f.body());
		expect(retry.status).toBe(503);
		expect(f.createSession).toHaveBeenCalledOnce();
		expect(f.perform).not.toHaveBeenCalled();
		expect(f.order).not.toContain("qorpera_native_office_screen:release");
	});
	it("rejects browser origins, incorrect host credentials and query-bearing paths before authority or guest work", async () => {
		const f = await fixture();
		for (const options of [{ token: "wrong" }, { origin: "https://app.qorpera.test" }, { suffix: "?token=secret" }]) {
			const response = await f.post(f.body(), options);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("");
		}
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("rejects changed identity and operation resources locally", async () => {
		const f = await fixture();
		await expect(
			f.endpoint.perform(f.operation, f.lease, {
				...f.context,
				identity: { ...f.context.identity, companyId: randomUUID() },
			}),
		).rejects.toThrow("OFFICE_NATIVE_IDENTITY_CHANGED");
		await expect(
			f.endpoint.perform({ ...f.operation, target: { ...f.operation.target, resources: {} } }, f.lease, f.context),
		).rejects.toThrow("OFFICE_NATIVE_RESOURCES_CHANGED");
		expect(f.createSession).not.toHaveBeenCalled();
	});
	it("rejects changed epochs at the receiver and accepts reordered exact leases on cleanup", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		const changed = await f.post({ ...f.body(), lease: { ...f.lease, epoch: 2 } });
		expect(changed.status).toBe(503);
		const reordered = Object.fromEntries(Object.entries(f.lease).reverse());
		reordered.validForMs = 12000;
		const released = await f.post({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: f.source.binding,
			action: "release",
			lease: reordered,
		});
		expect(released.status).toBe(200);
		expect(f.perform).toHaveBeenCalledOnce();
		await f.endpoint.close();
	});
	it("withholds a result after revocation and permits exact cleanup with a fresh signal", async () => {
		const f = await fixture();
		f.perform.mockImplementationOnce(async () => {
			f.revoke();
			return { kind: "text", value: "must not escape" };
		});
		await expect(f.endpoint.perform(f.operation, f.lease, f.context)).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		f.run.close();
		await f.endpoint.close();
		expect(f.stopBrowser).toHaveBeenCalled();
		expect(f.physicalClose).toHaveBeenCalledOnce();
		expect(f.order).not.toContain("qorpera_native_office_operation:finish");
	});
	it("cancels in-flight guest work and retains remote cleanup after a lost response", async () => {
		const f = await fixture();
		const entered = computerDeferred<void>();
		f.perform.mockImplementationOnce(async (_action, _lease, context) => {
			entered.resolve();
			await new Promise<void>((resolve) =>
				context.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			context.signal.throwIfAborted();
			return { kind: "text", value: "unreachable" };
		});
		const abort = new AbortController();
		const result = f.endpoint.perform(f.operation, f.lease, { ...f.context, signal: abort.signal });
		const assertion = expect(result).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		await entered.promise;
		abort.abort();
		await assertion;
		await f.endpoint.close();
		expect(f.perform).toHaveBeenCalledOnce();
		expect(f.stopBrowser).toHaveBeenCalledOnce();
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("does not release occupancy or acknowledge shutdown when physical cleanup fails", async () => {
		const f = await fixture();
		await f.endpoint.perform(f.operation, f.lease, f.context);
		f.physicalClose.mockRejectedValue(new Error("private guest diagnostic"));
		f.expectDrainFailure();
		await expect(f.endpoint.close()).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		await expect(f.endpoint.close()).rejects.toThrow("OFFICE_NATIVE_UNCONFIRMED");
		expect(f.order).not.toContain("qorpera_native_office_screen:release");
		expect(f.physicalClose).toHaveBeenCalledOnce();
	});
	it("does not claim cleanup of unknown sessions or accept extra wire fields", async () => {
		const f = await fixture();
		const unknown = await f.post({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: f.source.binding,
			action: "release",
			lease: f.lease,
		});
		expect(unknown.status).toBe(503);
		const extra = await f.post({ ...f.body(), command: "ignored bypass" });
		expect(extra.status).toBe(503);
		expect(f.createSession).not.toHaveBeenCalled();
		expect(f.sql).not.toHaveBeenCalled();
	});
	it("parses only scoped descriptors and fixed configured HTTPS routes", async () => {
		const f = await fixture();
		expect(parseCompanyComputerNativeDescriptor(f.descriptor, f.run)).toEqual(f.descriptor);
		expect(parseCompanyComputerNativeDescriptor({ state: "unavailable" }, f.run)).toBeUndefined();
		for (const value of [
			{ ...f.descriptor, url: "https://foreign.test" },
			{ ...f.descriptor, resources: { ...f.descriptor.resources, guestPath: "/private" } },
			{ ...f.descriptor, scope: { ...f.scope, companyId: randomUUID() } },
			{ ...f.descriptor, capabilities: ["browser"] },
		])
			expect(() => parseCompanyComputerNativeDescriptor(value, f.run)).toThrow();
		for (const value of [
			f.url.replace("https:", "http:"),
			`${f.url}?token=bad`,
			`${f.url}#fragment`,
			f.url.replace("/native", "/other"),
		])
			expect(() => parseCompanyComputerNativeUrl(value)).toThrow();
	});
});
