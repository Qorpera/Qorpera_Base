import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { cloudConnectorCatalogRows } from "@qorpera/runtime/cloud-connector-catalog";
import { type CloudNativeToolBinding, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolResult,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import type { BeginCloudRunnerOperationInput } from "@qorpera/runtime/cloud-runner-broker";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import {
	type CloudConnectorInputSchema,
	type CloudSecretOperationClient,
	cloudSecretTools,
	describeCloudSecretTools,
	validateCloudConnectorInput,
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
	const title = "input.title must be a string of 1 to 256 characters matching ^[A-Za-z][A-Za-z0-9 _-]{0,255}$";
	expect(() => tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "", priority: 2 } })).toThrow(
		title,
	);
	expect(() =>
		tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "1 invalid title", priority: 2 } }),
	).toThrow(title);
	expect(() =>
		tool.parseArguments({ idempotencyKey: "issue-login", input: { title: "Login is broken", extra: true } }),
	).toThrow("input has no field extra; its fields are priority, title");
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

it("refuses each malformed connector call with the rule it broke and none of its values", async () => {
	const fixture = await setup();
	const observed = observedBoundary(fixture);
	const call = 'Send the tool\'s fields on their own, or as {"idempotencyKey": "<key>", "input": {...}}';
	const envelope = 'With input, the call must be exactly {"idempotencyKey": "<key>", "input": {...}}';
	const key =
		"idempotencyKey must be 1 to 128 letters, digits or . _ : -, starting with a letter or digit (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$)";
	const fields = "its fields are priority, title";
	const title = "input.title must be a string of 1 to 256 characters matching ^[A-Za-z][A-Za-z0-9 _-]{0,255}$";
	const priority = "input.priority must be a whole number from 0 to 4";
	const issue = { idempotencyKey: "issue-login" };
	const writeKey =
		"idempotencyKey is required for this write: a new key for each new write, the same key when retrying the same write";
	const cases: [string, unknown, string][] = [
		["list", ["PRIVATE_VALUE"], call],
		["text", "PRIVATE_VALUE", call],
		// The tool's fields on their own beside a key are a call (below); here they still break the schema's rules.
		["flat_pattern", { ...issue, title: "1 PRIVATE_VALUE", priority: 2 }, title],
		["flat_field", { ...issue, title: "Ok", labels: ["PRIVATE_VALUE"] }, `input has no field labels; ${fields}`],
		// A write always needs the model's own key, in either shape (review F1: a key made from its fields answered a
		// later identical write from the first one's receipt).
		["flat_no_key", { title: "PRIVATE_VALUE", priority: 2 }, writeKey],
		["no_key", { input: { title: "PRIVATE_VALUE" } }, writeKey],
		["flat_required", { idempotencyKey: "PRIVATE-VALUE" }, "input is missing the required field title"],
		["flat_bad_key", { idempotencyKey: "PRIVATE VALUE", title: "Ok" }, key],
		["beside", { ...issue, input: {}, title: "PRIVATE_VALUE" }, `${envelope}; title goes inside input`],
		["beside_no_key", { input: {}, priority: 2 }, `${envelope}; priority goes inside input`],
		["named_key", { ...issue, input: { title: "Ok" }, note: "PRIVATE_VALUE" }, `${envelope}, without note`],
		["unnamed_key", { ...issue, input: { title: "Ok" }, "PRIVATE KEY": 1 }, `${envelope}, without other fields`],
		["bad_key", { idempotencyKey: "PRIVATE VALUE", input: { title: "Ok" } }, key],
		["number_key", { idempotencyKey: 4242, input: { title: "Ok" } }, key],
		["text_input", { ...issue, input: "PRIVATE_VALUE" }, "input must be an object"],
		[
			"named_field",
			{ ...issue, input: { title: "Ok", labels: ["PRIVATE_VALUE"] } },
			`input has no field labels; ${fields}`,
		],
		[
			"unnamed_field",
			{ ...issue, input: { title: "Ok", "PRIVATE KEY": 1 } },
			`input has a field the tool does not take; ${fields}`,
		],
		["required", { ...issue, input: { priority: 2 } }, "input is missing the required field title"],
		["pattern", { ...issue, input: { title: "1 PRIVATE_VALUE" } }, title],
		["length", { ...issue, input: { title: "" } }, title],
		["string_type", { ...issue, input: { title: ["PRIVATE_VALUE"] } }, title],
		["range", { ...issue, input: { title: "Ok", priority: 9 } }, priority],
		["fraction", { ...issue, input: { title: "Ok", priority: 2.5 } }, priority],
		["number_type", { ...issue, input: { title: "Ok", priority: "PRIVATE_VALUE" } }, priority],
	];
	try {
		for (const [callId, args, reason] of cases) {
			const reply = await observed.boundary.invoke(`call_${callId}`, "qorpera", "linear_issue_create", args);
			expect(reply.success, callId).toBe(false);
			expect(reply.contentItems[0].text, callId).not.toContain("PRIVATE");
			const envelope = JSON.parse(reply.contentItems[0].text) as CloudToolResult;
			expect([envelope.status, envelope.content.text], callId).toEqual(["denied", `INVALID_ARGUMENTS: ${reason}`]);
		}
		// Arguments over the boundary's bound are never read, so their refusal stays bare.
		const oversized = await observed.boundary.invoke("call_oversized", "qorpera", "linear_issue_create", {
			...issue,
			input: { title: `A${"PRIVATE".repeat(10_000)}` },
		});
		expect(JSON.parse(oversized.contentItems[0].text)).toMatchObject({
			status: "denied",
			content: { text: "INVALID_ARGUMENTS" },
		});
		expect(fixture.operationControl.beginToolOperation).not.toHaveBeenCalled();
		expect(fixture.broker.execute).not.toHaveBeenCalled();
		expect(fixture.pathControl.call.mock.calls.map(([method]) => method)).not.toContain(
			"qorpera_assert_native_connector_operation",
		);
		// A well-formed call after them is untouched: one receipt, one broker call with its own arguments.
		const valid = await observed.invoke("call_valid");
		expect(valid.success).toBe(true);
		expect(JSON.parse(valid.contentItems[0].text)).toMatchObject({ status: "ok" });
		expect(fixture.operationControl.beginToolOperation).toHaveBeenCalledTimes(1);
		expect(fixture.broker.execute).toHaveBeenCalledTimes(1);
		await observed.observability.close();
		const finished = observed.rows.filter((row) => row.operation === "connector" && row.phase === "finish");
		expect(finished.map((row) => [row.status, row.errorCategory])).toEqual([
			...[...cases, "oversized"].map(() => ["denied", "invalid_arguments"]),
			["succeeded", null],
		]);
		expect(JSON.stringify(observed.rows)).not.toContain("PRIVATE");
	} finally {
		observed.boundary.close();
	}
});

/** A connector tool over a ledger that keys receipts by their logical operation, as the kernel does, and a broker that
 * answers with the arguments it got. */
async function keyedFixture(descriptor: Record<string, unknown>) {
	const native = nativeToolAuthorityFixture();
	const pathControl = {
		call: vi.fn<CloudCompanyPathControl["call"]>(async (method) => {
			if (method === "qorpera_list_native_connector_tools") return [descriptor] as unknown as JsonValue;
			if (method === "qorpera_assert_native_connector_operation") return null;
			throw new Error("Unexpected synthetic connector RPC");
		}),
	};
	const reader = { describeToolAuthority: vi.fn(async () => structuredClone(native.authority)) };
	const run = await CloudNativeToolRun.open(native.binding, reader, new AbortController().signal);
	runs.push(run);
	const receipts = new Map<string, { receiptId: string; result: JsonValue | null }>();
	const operationControl: CloudNativeToolOperationControlPlane = {
		beginToolOperation: vi.fn(async (binding, input) => {
			const prior = receipts.get(input.logicalOperationKey);
			if (prior?.result)
				return {
					run_id: binding.runId,
					receipt_id: prior.receiptId,
					state: "completed",
					result: prior.result,
					output_snapshot_id: null,
					proposal_id: null,
				};
			receipts.set(input.logicalOperationKey, { receiptId: input.receiptId, result: null });
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
			for (const receipt of receipts.values())
				if (receipt.receiptId === input.receiptId) receipt.result = structuredClone(input.result);
			return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
		}),
	};
	const broker = {
		execute: vi.fn<CloudSecretOperationClient["execute"]>(async (request) => ({
			kind: "json",
			value: { arguments: request.arguments },
		})),
	};
	const descriptors = await describeCloudSecretTools(pathControl, native.binding, new AbortController().signal);
	const tools = cloudSecretTools({
		descriptors,
		binding: native.binding,
		control: pathControl,
		operations: new CloudNativeToolOperations(run, operationControl),
		broker,
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: native.authority.identity.companyId,
		runId: native.binding.runId,
		identity: native.authority.identity,
		tools,
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	const invoke = async (callId: string, args: JsonValue) => {
		const reply = await boundary.invoke(callId, "qorpera", descriptor.toolName as string, args);
		expect(reply.success, callId).toBe(true);
		return (JSON.parse(reply.contentItems[0].text) as CloudToolResult).content;
	};
	return { operationControl, broker, tools, boundary, invoke };
}

it("takes a write's fields on their own beside its key, and runs each write that has a new key", async () => {
	const fixture = await setup();
	const keyed = await keyedFixture(fixture.descriptor);
	try {
		// The schema shows the envelope with its required key, and says what the key is for.
		expect(keyed.tools[0].inputSchema).toMatchObject({
			required: ["idempotencyKey", "input"],
			properties: {
				idempotencyKey: {
					description: expect.stringContaining("a new key for each new write, the same key when retrying"),
				},
			},
		});
		const login = { title: "Login is broken", priority: 2 };
		const first = await keyed.invoke("call_flat", { idempotencyKey: "issue-1", ...login });
		expect(first.text).toContain('"Login is broken"');
		expect(keyed.broker.execute.mock.calls[0][0].arguments).toEqual(login);
		// The same key again, flat or in input, is the retry of that write: answered from it, not repeated.
		expect((await keyed.invoke("call_retry", { idempotencyKey: "issue-1", input: login })).text).toBe(first.text);
		expect(keyed.broker.execute).toHaveBeenCalledTimes(1);
		// A, then B, then A again under three keys: three writes, the last one too (undoing a change runs).
		await keyed.invoke("call_b", { idempotencyKey: "issue-2", title: "Login is slow" });
		await keyed.invoke("call_a_again", { idempotencyKey: "issue-3", ...login });
		expect(keyed.broker.execute).toHaveBeenCalledTimes(3);
		expect(keyed.broker.execute.mock.calls.map(([request]) => request.arguments)).toEqual([
			login,
			{ title: "Login is slow" },
			login,
		]);
		expect(
			vi.mocked(keyed.operationControl.beginToolOperation).mock.calls.map(([, input]) => input.logicalOperationKey),
		).toEqual(
			["issue-1", "issue-2", "issue-3"].map((key) => `linear_issue_create:${fixture.descriptor.grantId}:${key}`),
		);
		// Without a key a write does not run, in either shape, and says why.
		for (const [callId, args] of [
			["call_flat_no_key", login],
			["call_input_no_key", { input: login }],
		] as const) {
			const refused = await keyed.boundary.invoke(callId, "qorpera", "linear_issue_create", args);
			expect(JSON.parse(refused.contentItems[0].text), callId).toMatchObject({
				status: "denied",
				content: {
					text: "INVALID_ARGUMENTS: idempotencyKey is required for this write: a new key for each new write, the same key when retrying the same write",
				},
			});
		}
		expect(keyed.broker.execute).toHaveBeenCalledTimes(3);
		expect(keyed.operationControl.beginToolOperation).toHaveBeenCalledTimes(3);
	} finally {
		keyed.boundary.close();
	}
});

it("shows a read its own fields and asks again on each call, in either shape (30 October 2026)", async () => {
	const row = cloudConnectorCatalogRows().find(
		(item) => item.connectorId === "github" && item.operationId === "list_repositories",
	);
	if (!row) throw new Error("github list_repositories is missing");
	const grantId = randomUUID();
	const keyed = await keyedFixture({
		schema: "qorpera.native-connector-tool/v1",
		grantId,
		toolName: row.toolName,
		description: row.description,
		inputSchema: row.inputSchema,
		connectorId: row.connectorId,
		operationId: row.operationId,
		operationVersion: row.version,
		adapterSha256: row.adapterSha256,
		destinationOrigin: row.destinationOrigin,
	});
	try {
		// The natural schema: the tool's own fields, no key.
		expect(keyed.tools[0].inputSchema).toMatchObject({
			type: "object",
			properties: { limit: { type: "integer" }, query: { type: "string" } },
			additionalProperties: false,
		});
		expect(JSON.stringify(keyed.tools[0].inputSchema)).not.toContain("idempotencyKey");
		// The call that was refused on 30 October, the one that then worked, and the plain ones: each asks GitHub.
		await keyed.invoke("call_bare", {});
		await keyed.invoke("call_bare_again", {});
		await keyed.invoke("call_limit", { limit: 50 });
		await keyed.invoke("call_envelope", { idempotencyKey: "list-1", input: { limit: 50 } });
		await keyed.invoke("call_input", { input: { limit: 50 } });
		expect(keyed.broker.execute).toHaveBeenCalledTimes(5);
		expect(keyed.broker.execute.mock.calls.map(([request]) => request.arguments)).toEqual([
			{},
			{},
			{ limit: 50 },
			{ limit: 50 },
			{ limit: 50 },
		]);
		expect(vi.mocked(keyed.operationControl.beginToolOperation).mock.calls[0][1].logicalOperationKey).toMatch(
			new RegExp(`^github_list_repositories:${grantId}:read-[0-9a-f]{48}$`),
		);
		// A read still refuses what its schema does not take.
		const refused = await keyed.boundary.invoke("call_bad", "qorpera", row.toolName, { limit: 500 });
		expect(JSON.parse(refused.contentItems[0].text)).toMatchObject({
			status: "denied",
			content: { text: "INVALID_ARGUMENTS: input.limit must be a whole number from 1 to 50" },
		});
	} finally {
		keyed.boundary.close();
	}
});

it("words a nested or listed rule from the schema alone and keeps each reason within 1 KiB", () => {
	const schema: CloudConnectorInputSchema = {
		type: "object",
		properties: {
			labels: { type: "array", items: { type: "string", minLength: 1, maxLength: 50 }, maxItems: 10 },
			filter: {
				type: "object",
				properties: { state: { type: "string", enum: ["open", "closed"] } },
				required: ["state"],
				additionalProperties: false,
			},
			kind: { type: "string", enum: ["x".repeat(600)] },
			none: { type: "object", properties: {}, additionalProperties: false },
		},
		additionalProperties: false,
	};
	const wide: CloudConnectorInputSchema = {
		type: "object",
		properties: Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`field_${index}_${"x".repeat(50)}`, { type: "boolean" as const }]),
		),
		additionalProperties: false,
	};
	const refusal = (value: JsonValue, against = schema) => {
		try {
			validateCloudConnectorInput(value, against);
		} catch (error) {
			expect(error).toBeInstanceOf(CloudToolArgumentRefusal);
			return (error as Error).message;
		}
		throw new Error("The input was accepted");
	};
	expect(refusal({ labels: ["bug", ""] })).toBe("each item of input.labels must be a string of 1 to 50 characters");
	expect(refusal({ labels: "PRIVATE" })).toBe(
		"input.labels must be a list of at most 10 items, each a string of 1 to 50 characters",
	);
	expect(refusal({ filter: { state: "PRIVATE" } })).toBe(
		'input.filter.state must be a string, one of "open", "closed"',
	);
	expect(refusal({ filter: {} })).toBe("input.filter is missing the required field state");
	expect(refusal({ kind: "PRIVATE" })).toBe("input.kind must be a string, one of the values the tool's schema lists");
	expect(refusal({ none: { PRIVATE: 1 } })).toBe("input.none must be {}: it has no fields");
	expect(refusal({ other: true }, wide)).toBe("input has a field the tool does not take");
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
