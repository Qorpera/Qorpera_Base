import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { type CloudNativeToolBinding, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import type { BeginCloudRunnerOperationInput } from "@qorpera/runtime/cloud-runner-broker";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import {
	type CloudSecretOperationClient,
	cloudSecretTools,
	describeCloudSecretTools,
} from "@qorpera/runtime/cloud-secret-tools";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
const observations: CloudRuntimeObservability[] = [];
afterEach(async () => {
	for (const run of runs.splice(0)) run.close();
	await Promise.all(observations.splice(0).map((observation) => observation.close()));
});

async function setup() {
	const native = nativeToolAuthorityFixture();
	const grantId = randomUUID();
	let revoked = false;
	const descriptor = {
		schema: "qorpera.native-connector-tool/v1",
		grantId,
		toolName: "linear_issue_create",
		description: "Create one Linear issue with the company-authorized connection.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					minLength: 1,
					maxLength: 256,
					pattern: "^[A-Za-z][A-Za-z0-9 _-]{0,255}$",
				},
				priority: { type: "integer", minimum: 0, maximum: 4 },
			},
			required: ["title"],
			additionalProperties: false,
		},
		connectorId: "linear",
		operationId: "issue_create",
		operationVersion: 1,
		adapterSha256: "a".repeat(64),
		destinationOrigin: "https://api.linear.app",
	};
	const pathControl = {
		call: vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
			expect(args.p_binding).toEqual(native.binding);
			if (method === "qorpera_list_native_connector_tools") return [descriptor];
			if (method === "qorpera_assert_native_connector_operation") {
				if (revoked) throw new Error("PRIVATE_GRANT_REVOKED");
				expect(args).toMatchObject({
					p_grant_id: grantId,
					p_connector_id: "linear",
					p_operation_id: "issue_create",
					p_operation_version: 1,
					p_adapter_sha256: "a".repeat(64),
					p_destination_origin: "https://api.linear.app",
				});
				return null;
			}
			throw new Error("Unexpected synthetic connector RPC");
		}),
	};
	const reader = { describeToolAuthority: vi.fn(async () => structuredClone(native.authority)) };
	const run = await CloudNativeToolRun.open(native.binding, reader, new AbortController().signal);
	runs.push(run);
	let receipt: BeginCloudRunnerOperationInput | undefined;
	let storedResult: JsonValue | null = null;
	const operationControl: CloudNativeToolOperationControlPlane = {
		beginToolOperation: vi.fn(async (binding, input) => {
			expect(binding).toEqual(native.binding);
			if (!receipt) receipt = structuredClone(input);
			if (storedResult) {
				if (!receipt) throw new Error("Synthetic completed receipt is missing");
				return {
					run_id: binding.runId,
					receipt_id: receipt.receiptId,
					state: "completed",
					result: storedResult,
					output_snapshot_id: null,
					proposal_id: null,
				};
			}
			return {
				run_id: binding.runId,
				receipt_id: input.receiptId,
				state: "executing",
				result: null,
				output_snapshot_id: null,
				proposal_id: null,
			};
		}),
		completeToolOperation: vi.fn(async (binding, input) => {
			storedResult = structuredClone(input.result);
			return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
		}),
	};
	const broker = {
		execute: vi.fn<CloudSecretOperationClient["execute"]>(async (request) => {
			expect(request.receiptId).toBe(receipt?.receiptId);
			expect(request.inputSha256).toBe(receipt?.inputSha256);
			expect(request.binding).toEqual(native.binding);
			expect(request.grantId).toBe(grantId);
			expect(request.arguments).toEqual({ title: "Login is broken", priority: 2 });
			return { kind: "json", value: { created: true, issueId: "ISS-41" } };
		}),
	};
	const descriptors = await describeCloudSecretTools(pathControl, native.binding, new AbortController().signal);
	const tools = cloudSecretTools({
		descriptors,
		binding: native.binding,
		control: pathControl,
		operations: new CloudNativeToolOperations(run, operationControl),
		broker,
	});
	return {
		...native,
		grantId,
		descriptor,
		pathControl,
		reader,
		run,
		operationControl,
		broker,
		descriptors,
		tools,
		revoke: () => {
			revoked = true;
		},
	};
}

function observedBoundary(fixture: Awaited<ReturnType<typeof setup>>) {
	const rows: CloudRuntimeObservation[] = [];
	const observability = new CloudRuntimeObservability({
		assignmentId: fixture.binding.assignmentId,
		publish: async (batch) => {
			rows.push(...structuredClone(batch));
		},
	});
	observations.push(observability);
	const boundary = new CloudNativeToolBoundary({
		companyId: fixture.authority.identity.companyId,
		runId: fixture.binding.runId,
		identity: fixture.authority.identity,
		tools: fixture.tools,
		assertActive: (signal) => fixture.run.assertActive(signal),
		signal: fixture.run.signal,
		observability,
	});
	const invoke = (callId: string) =>
		boundary.invoke(callId, "qorpera", "linear_issue_create", {
			idempotencyKey: "issue-login",
			input: { title: "Login is broken", priority: 2 },
		});
	return { rows, observability, boundary, invoke };
}

it("exposes only a typed operation while keeping the credential and grant out of the model schema", async () => {
	const fixture = await setup();
	expect(fixture.tools).toHaveLength(1);
	const boundary = new CloudNativeToolBoundary({
		companyId: fixture.authority.identity.companyId,
		runId: fixture.binding.runId,
		identity: fixture.authority.identity,
		tools: fixture.tools,
		assertActive: (signal) => fixture.run.assertActive(signal),
		signal: fixture.run.signal,
	});
	try {
		const specification = JSON.stringify(boundary.specification);
		expect(specification).toContain("linear_issue_create");
		expect(specification).toContain("idempotencyKey");
		expect(specification).toContain("^[A-Za-z][A-Za-z0-9 _-]{0,255}$");
		expect(specification).not.toContain(fixture.grantId);
		expect(specification).not.toMatch(/token|secretId|credentialName/);
	} finally {
		boundary.close();
	}
});

it("validates business arguments, reserves one receipt and calls the separate broker", async () => {
	const fixture = await setup();
	const tool = fixture.tools[0];
	expect(() => tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "", priority: 2 } })).toThrow(
		"Connector string input is invalid",
	);
	expect(() =>
		tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "1 invalid title", priority: 2 } }),
	).toThrow("Connector string input is invalid");
	expect(() =>
		tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "Login is broken", extra: true } }),
	).toThrow("extra fields");
	const output = await tool.execute(
		{ idempotencyKey: "issue-login", input: { title: "Login is broken", priority: 2 } },
		{
			companyId: fixture.authority.identity.companyId,
			runId: fixture.binding.runId,
			callId: "call_linear",
			argumentSha256: "c".repeat(64),
			signal: fixture.run.signal,
			identity: fixture.authority.identity,
		},
	);
	expect(output).toEqual({ kind: "json", value: { created: true, issueId: "ISS-41" } });
	expect(fixture.operationControl.beginToolOperation).toHaveBeenCalledTimes(1);
	expect(fixture.operationControl.completeToolOperation).toHaveBeenCalledTimes(1);
	expect(fixture.broker.execute).toHaveBeenCalledTimes(1);
	expect(
		fixture.pathControl.call.mock.calls.filter(([method]) => method === "qorpera_assert_native_connector_operation"),
	).toHaveLength(3);
});

it("rechecks a revoked grant before effect and leaves the broker untouched", async () => {
	const fixture = await setup();
	fixture.revoke();
	await expect(
		fixture.tools[0].execute(
			{ idempotencyKey: "issue-login", input: { title: "Login is broken" } },
			{
				companyId: fixture.authority.identity.companyId,
				runId: fixture.binding.runId,
				callId: "call_linear",
				argumentSha256: "c".repeat(64),
				signal: fixture.run.signal,
				identity: fixture.authority.identity,
			},
		),
	).rejects.toThrow("outcome unconfirmed");
	expect(fixture.operationControl.beginToolOperation).not.toHaveBeenCalled();
	expect(fixture.broker.execute).not.toHaveBeenCalled();
});

it("rejects an open or malformed server-supplied connector schema", async () => {
	const fixture = nativeToolAuthorityFixture();
	const control: CloudCompanyPathControl = {
		call: async () => [
			{
				schema: "qorpera.native-connector-tool/v1",
				grantId: randomUUID(),
				toolName: "linear_issue_create",
				description: "Unsafe schema",
				inputSchema: { type: "object", properties: {}, additionalProperties: true },
				connectorId: "linear",
				operationId: "issue_create",
				operationVersion: 1,
				adapterSha256: "a".repeat(64),
				destinationOrigin: "https://api.linear.app",
			},
		],
	};
	await expect(
		describeCloudSecretTools(control, fixture.binding as CloudNativeToolBinding, new AbortController().signal),
	).rejects.toThrow("must be closed");
});

it("rejects unbounded or branching server-supplied string patterns", async () => {
	const fixture = nativeToolAuthorityFixture();
	const control: CloudCompanyPathControl = {
		call: async () => [
			{
				schema: "qorpera.native-connector-tool/v1",
				grantId: randomUUID(),
				toolName: "linear_issue_create",
				description: "Unsafe pattern",
				inputSchema: {
					type: "object",
					properties: { title: { type: "string", pattern: "^(a+)+$" } },
					additionalProperties: false,
				},
				connectorId: "linear",
				operationId: "issue_create",
				operationVersion: 1,
				adapterSha256: "a".repeat(64),
				destinationOrigin: "https://api.linear.app",
			},
		],
	};
	await expect(
		describeCloudSecretTools(control, fixture.binding as CloudNativeToolBinding, new AbortController().signal),
	).rejects.toThrow("Connector string pattern is invalid");
});

it("privately links connector effects and changed-call-ID replays without changing model or broker contracts", async () => {
	const fixture = await setup();
	const observed = observedBoundary(fixture);
	try {
		const replies = [];
		for (const callId of ["call_first", "call_retry", "call_first"]) replies.push(await observed.invoke(callId));
		await observed.observability.close();
		const effects = observed.rows.filter((row) => row.operation === "connector" && row.phase === "finish");
		const receiptId = vi.mocked(fixture.operationControl.beginToolOperation).mock.calls[0][1].receiptId;
		expect(effects.map((row) => row.status)).toEqual(["succeeded", "replayed", "replayed"]);
		expect(effects.map((row) => row.receiptId)).toEqual([receiptId, receiptId, receiptId]);
		expect(new Set(effects.map((row) => row.attemptId)).size).toBe(3);
		for (const reply of replies) {
			expect(reply.success).toBe(true);
			expect(reply.contentItems[0].text).not.toMatch(/runtime-observation|attemptId|receiptId|durationMs/);
			expect(reply.contentItems[0].text).not.toContain(receiptId);
		}
		expect(fixture.broker.execute).toHaveBeenCalledTimes(1);
		expect(fixture.operationControl.beginToolOperation).toHaveBeenCalledTimes(1);
		expect(fixture.operationControl.completeToolOperation).toHaveBeenCalledTimes(1);
		expect(
			fixture.pathControl.call.mock.calls.filter(
				([method]) => method === "qorpera_assert_native_connector_operation",
			),
		).toHaveLength(4);
		expect(Object.keys(fixture.broker.execute.mock.calls[0][0]).sort()).toEqual([
			"adapterSha256",
			"arguments",
			"binding",
			"connectorId",
			"destinationOrigin",
			"grantId",
			"idempotencyKey",
			"inputSha256",
			"operationId",
			"operationVersion",
			"receiptId",
		]);
		expect(JSON.stringify(observed.rows)).not.toMatch(/Login is broken|ISS-41|api\.linear|issue-login/);
		expect(JSON.stringify(observed.rows)).not.toContain(fixture.grantId);
	} finally {
		observed.boundary.close();
	}
});

it.each([false, true])("ignores broker-claimed receipt/outcome metadata (completion lost=%s)", async (lost) => {
	const fixture = await setup();
	const forgedReceiptId = randomUUID();
	fixture.broker.execute.mockResolvedValueOnce({
		kind: "json",
		value: { receiptId: forgedReceiptId, status: "proposed", proposalId: randomUUID() },
	});
	if (lost)
		vi.mocked(fixture.operationControl.completeToolOperation).mockRejectedValueOnce(
			new Error("PRIVATE_LOST_COMPLETION"),
		);
	const observed = observedBoundary(fixture);
	try {
		for (const callId of ["call_first", "call_retry"]) {
			const reply = await observed.invoke(callId);
			expect(reply.success).toBe(!lost);
			if (lost) expect(reply.contentItems[0].text).not.toContain("PRIVATE");
		}
		await observed.observability.close();
		const effects = observed.rows.filter((row) => row.operation === "connector" && row.phase === "finish");
		const receiptId = vi.mocked(fixture.operationControl.beginToolOperation).mock.calls[0][1].receiptId;
		expect(effects.map((row) => row.status)).toEqual(
			lost ? ["unconfirmed", "unconfirmed"] : ["succeeded", "replayed"],
		);
		for (const row of effects) expect(row.receiptId).toBe(receiptId);
		expect(JSON.stringify(observed.rows)).not.toContain(forgedReceiptId);
		expect(fixture.broker.execute).toHaveBeenCalledTimes(1);
		expect(fixture.operationControl.completeToolOperation).toHaveBeenCalledTimes(1);
	} finally {
		observed.boundary.close();
	}
});

it("records completed and replayed effects separately from a late grant-release denial", async () => {
	const fixture = await setup();
	const complete = vi.mocked(fixture.operationControl.completeToolOperation).getMockImplementation()!;
	vi.mocked(fixture.operationControl.completeToolOperation).mockImplementationOnce(async (...args) => {
		const result = await complete(...args);
		fixture.revoke();
		return result;
	});
	const observed = observedBoundary(fixture);
	try {
		for (const callId of ["call_first", "call_retry"]) {
			const reply = await observed.invoke(callId);
			expect(reply.success).toBe(false);
			expect(reply.contentItems[0].text).toContain("TOOL_OUTCOME_UNCONFIRMED");
			expect(reply.contentItems[0].text).not.toMatch(/ISS-41|PRIVATE_GRANT_REVOKED/);
		}
		await observed.observability.close();
		const effects = observed.rows.filter((row) => row.operation === "connector" && row.phase === "finish");
		expect(effects.map((row) => row.status)).toEqual(["succeeded", "replayed"]);
		for (const effect of effects)
			expect(observed.rows).toContainEqual(
				expect.objectContaining({
					operation: "context_authority",
					phase: "finish",
					parentAttemptId: effect.attemptId,
					status: "denied",
					errorCategory: "authority_unavailable",
				}),
			);
		expect(fixture.broker.execute).toHaveBeenCalledTimes(1);
		expect(fixture.operationControl.completeToolOperation).toHaveBeenCalledTimes(1);
	} finally {
		observed.boundary.close();
	}
});
