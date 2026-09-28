import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { createHttpCompanyComputerSessionFactory } from "@qorpera/runtime/cloud-company-computer-native-client";
import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	cleanups.push(() => run.close());
	const scope = {
		companyId: run.identity.companyId,
		environmentId: run.identity.environmentId,
		companyComputerId: randomUUID(),
		logicalComputerId: randomUUID(),
	};
	const descriptor = {
		state: "available",
		scope,
		computerGeneration: 1,
		resources: { officeGrantId: randomUUID(), officeGrantVersion: 1 },
	};
	const result = {
		schema: "qorpera.office-start-intent/v1",
		companyComputerId: scope.companyComputerId,
		computerGeneration: 1,
		intentId: randomUUID(),
		state: "requested",
	};
	const order: string[] = [];
	let receipt: { receiptId: string; inputSha256: string; downstreamIdempotencyKey: string } | undefined;
	const control = {
		beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async (_binding, input) => {
			order.push("receipt:begin");
			receipt = input;
			return {
				run_id: run.identity.runId,
				receipt_id: input.receiptId,
				state: "executing",
				result: null,
				output_snapshot_id: null,
				proposal_id: null,
			};
		}),
		completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(
			async (_binding, input) => {
				order.push("receipt:complete");
				return {
					run_id: run.identity.runId,
					receipt_id: input.receiptId,
					state: "completed",
					result: input.result,
				};
			},
		),
	};
	const sql = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).split("/").at(-1);
		const args = JSON.parse(String(init?.body));
		expect(args.p_binding).toEqual(run.binding);
		expect(init?.redirect).toBe("error");
		if (method === "qorpera_native_office_descriptor") return Response.json({ state: "unavailable" });
		if (method === "qorpera_native_office_start_descriptor") return Response.json(descriptor);
		if (method !== "qorpera_native_office_start") throw new Error("unexpected office/screen/guest operation");
		order.push(`start:${args.p_action}`);
		const envelope = JSON.parse(args.p_envelope);
		expect(envelope.operation).toEqual({
			tool: "computer_start",
			toolVersion: "qorpera.company-computer-tools/v2",
			logicalOperationKey: "office-start:1",
			arguments: { kind: "start" },
			requiresCompanyRevision: false,
			target: { realm: "company_computer", scope, computerGeneration: 1, resources: descriptor.resources },
		});
		if (args.p_action === "authorize") {
			expect(args.p_receipt_id).toBeUndefined();
			return Response.json({ state: "authorized" });
		}
		expect(args.p_action).toBe("begin");
		expect(args.p_receipt_id).toBe(receipt?.receiptId);
		expect(args.p_idempotency_sha256).toBe(
			createHash("sha256").update(receipt!.downstreamIdempotencyKey).digest("hex"),
		);
		expect(createHash("sha256").update(args.p_envelope).digest("hex")).toBe(receipt?.inputSha256);
		return Response.json(result);
	});
	const registry = new HttpCloudCompanyComputerRegistry({
		supabaseUrl: "https://registry.qorpera.test",
		serviceRoleKey: "synthetic-service-key",
		fetch: sql,
	});
	const guest = vi.fn(async () => {
		throw new Error("A stopped office must not be contacted to request its own start");
	});
	const factory = createHttpCompanyComputerSessionFactory({
		url: `https://office.qorpera.test/office/${scope.companyComputerId}/native`,
		token: randomBytes(32).toString("base64url"),
		registry,
		fetch: guest,
	});
	const operations = new CloudNativeToolOperations(run, control);
	const session = await factory(run, operations);
	if (!session) throw new Error("missing startup session");
	cleanups.push(session.close);
	const tool = session.tools[0];
	const args = { operationKey: "office-start:1" };
	const context = { companyId: run.identity.companyId, runId: run.identity.runId, signal: run.signal };
	return {
		source,
		run,
		descriptor,
		result,
		order,
		control,
		sql,
		guest,
		factory,
		operations,
		session,
		tool,
		args,
		context,
	};
}
describe("native office startup without a running guest", () => {
	it("offers only startup, binds the exact native receipt, and replays without another request", async () => {
		const f = await fixture();
		expect(f.session.tools.map((tool) => tool.name)).toEqual(["computer_start"]);
		await expect(f.tool.execute(f.args, f.context)).resolves.toEqual({ kind: "json", value: f.result });
		await expect(f.tool.execute(f.args, f.context)).resolves.toEqual({ kind: "json", value: f.result });
		expect(f.order.filter((event) => event === "start:begin")).toHaveLength(1);
		expect(f.control.beginToolOperation).toHaveBeenCalledOnce();
		expect(f.control.completeToolOperation).toHaveBeenCalledOnce();
		expect(f.order.indexOf("receipt:begin")).toBeLessThan(f.order.indexOf("start:begin"));
		expect(f.order.indexOf("start:begin")).toBeLessThan(f.order.indexOf("receipt:complete"));
		expect(f.guest).not.toHaveBeenCalled();
		const calls = f.sql.mock.calls.length;
		await f.session.close();
		expect(f.sql).toHaveBeenCalledTimes(calls);
	});
	it.each<JsonValue>([
		{ operationKey: "office-start:1", command: "shell" },
		{ operationKey: "office-start:1", companyComputerId: "other" },
		{ operationKey: "office-start:1", image: "mutable" },
		{ operationKey: "" },
		{ operationKey: "x".repeat(193) },
	])("rejects model-supplied authority and invalid request keys (%#)", async (value) => {
		const f = await fixture();
		expect(() => f.tool.parseArguments(value)).toThrow();
		await expect(f.tool.execute(value, f.context)).rejects.toThrow();
		expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	});
	it("does not replay a request after its response was lost", async () => {
		const f = await fixture();
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (input, init) => {
			const response = await original(input, init);
			if (JSON.parse(String(init?.body)).p_action === "begin") throw new Error("lost after commit");
			return response;
		});
		await expect(f.tool.execute(f.args, f.context)).rejects.toThrow("outcome unconfirmed");
		await expect(f.tool.execute(f.args, f.context)).rejects.toThrow("outcome unconfirmed");
		expect(f.order.filter((event) => event === "start:begin")).toHaveLength(1);
		expect(f.control.beginToolOperation).toHaveBeenCalledOnce();
		expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	});
	it("rechecks authorization after receipt admission and denies changed grants before creating demand", async () => {
		const f = await fixture();
		const begin = f.control.beginToolOperation.getMockImplementation()!;
		f.control.beginToolOperation.mockImplementation(async (binding, input, signal) => {
			const result = await begin(binding, input, signal);
			f.sql.mockResolvedValue(new Response("private SQL detail", { status: 403 }));
			return result;
		});
		await expect(f.tool.execute(f.args, f.context)).rejects.toThrow("outcome unconfirmed");
		expect(f.order).not.toContain("start:begin");
		expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	});
	it.each(["active", "cancelled", "wrong office", "wrong generation", "extra data"])(
		"does not complete an operation on an invalid intent result: %s",
		async (failure) => {
			const f = await fixture();
			if (failure === "active" || failure === "cancelled") f.result.state = failure;
			if (failure === "wrong office") f.result.companyComputerId = randomUUID();
			if (failure === "wrong generation") f.result.computerGeneration = 2;
			if (failure === "extra data") Object.assign(f.result, { url: "https://untrusted.test" });
			await expect(f.tool.execute(f.args, f.context)).rejects.toThrow("outcome unconfirmed");
			expect(f.control.completeToolOperation).not.toHaveBeenCalled();
		},
	);
	it("denies use after session close and rejects another run before admission", async () => {
		const f = await fixture();
		await expect(f.tool.execute(f.args, { ...f.context, runId: randomUUID() })).rejects.toThrow(
			"COMPUTER_RUN_MISMATCH",
		);
		await f.session.close();
		await expect(f.tool.execute(f.args, f.context)).rejects.toThrow("OFFICE_START_SESSION_CLOSED");
		expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	});
	it.each([
		{ providerUrl: "https://untrusted.test" },
		{ computerGeneration: 0 },
		{ resources: { officeGrantId: randomUUID(), officeGrantVersion: 0 } },
	])("rejects untrusted or invalid startup metadata (%#)", async (patch) => {
		const f = await fixture();
		Object.assign(f.descriptor, patch);
		await expect(f.factory(f.run, f.operations)).rejects.toThrow();
		expect(f.guest).not.toHaveBeenCalled();
		expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	});
	it("rejects startup metadata for a different configured office", async () => {
		const f = await fixture();
		f.descriptor.scope.companyComputerId = randomUUID();
		await expect(f.factory(f.run, f.operations)).rejects.toThrow("OFFICE_NATIVE_CONFIGURATION_DIFFERS");
	});
	it("offers startup of any of the company's computers through a company route", async () => {
		const f = await fixture();
		f.descriptor.scope.companyComputerId = randomUUID();
		const factory = createHttpCompanyComputerSessionFactory({
			url: "https://office.qorpera.test/office/{companyComputerId}/native",
			token: randomBytes(32).toString("base64url"),
			registry: new HttpCloudCompanyComputerRegistry({
				supabaseUrl: "https://registry.qorpera.test",
				serviceRoleKey: "synthetic-service-key",
				fetch: f.sql,
			}),
			fetch: f.guest,
		});
		const session = await factory(f.run, f.operations);
		expect(session?.tools.map((tool) => tool.name)).toEqual(["computer_start"]);
		await session?.close();
	});
	it("publishes a closed input schema without model-selectable scope or paths", async () => {
		const f = await fixture();
		expect(f.tool.inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(f.tool.inputSchema.properties as { [key: string]: JsonValue })).toEqual(["operationKey"]);
	});
});
