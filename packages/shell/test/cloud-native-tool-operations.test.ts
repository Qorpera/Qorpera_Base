import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperation,
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import type { BeginCloudRunnerOperationInput } from "@qorpera/runtime/cloud-runner-broker";
import {
	CloudRuntimeDiagnosticError,
	CloudRuntimeObservability,
	type CloudRuntimeObservation,
} from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

type ExecuteOptions = Parameters<CloudNativeToolOperations["execute"]>[0];
interface Receipt {
	input: BeginCloudRunnerOperationInput;
	state: "executing" | "completed" | "ambiguous" | "cancelled";
	result: JsonValue | null;
	outputSnapshotId: string | null;
	proposalId: string | null;
}
const runs: CloudNativeToolRun[] = [];
const observations: CloudRuntimeObservability[] = [];
afterEach(async () => {
	for (const run of runs.splice(0)) run.close();
	vi.useRealTimers();
	await Promise.all(observations.splice(0).map((observation) => observation.close()));
});

function observe(assignmentId: string) {
	const rows: CloudRuntimeObservation[] = [];
	const publish = vi.fn(async (row: CloudRuntimeObservation) => {
		rows.push(structuredClone(row));
	});
	const observability = new CloudRuntimeObservability({ assignmentId, publish });
	observations.push(observability);
	return { rows, publish, observability };
}

async function fixture() {
	const authority = nativeToolAuthorityFixture();
	const reader = { describeToolAuthority: vi.fn(async () => structuredClone(authority.authority)) };
	const abort = new AbortController();
	const run = await CloudNativeToolRun.open(authority.binding, reader, abort.signal);
	runs.push(run);
	const ledger = new Map<string, Receipt>();
	const control = {
		beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async (binding, input) => {
			expect(binding.runId).toBe(authority.binding.runId);
			let receipt = ledger.get(input.logicalOperationKey);
			if (
				receipt &&
				(receipt.input.inputSha256 !== input.inputSha256 ||
					receipt.input.downstreamIdempotencyKey !== input.downstreamIdempotencyKey ||
					receipt.input.requiresCompanyRevision !== input.requiresCompanyRevision)
			)
				throw new Error("other work");
			if (!receipt) {
				if ([...ledger.values()].some((entry) => entry.state === "executing" || entry.state === "ambiguous"))
					throw new Error("unresolved operation");
				receipt = {
					input: structuredClone(input),
					state: "executing",
					result: null,
					outputSnapshotId: null,
					proposalId: null,
				};
				ledger.set(input.logicalOperationKey, receipt);
			}
			return structuredClone({
				run_id: binding.runId,
				receipt_id: receipt.input.receiptId,
				state: receipt.state,
				result: receipt.result,
				output_snapshot_id: receipt.outputSnapshotId,
				proposal_id: receipt.proposalId,
			});
		}),
		completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(
			async (binding, input) => {
				const receipt = [...ledger.values()].find((entry) => entry.input.receiptId === input.receiptId);
				if (!receipt || receipt.input.inputSha256 !== input.inputSha256 || receipt.state !== "executing")
					throw new Error("invalid completion");
				receipt.state = "completed";
				receipt.result = structuredClone(input.result);
				receipt.outputSnapshotId = input.outputSnapshotId ?? null;
				receipt.proposalId = input.proposalId ?? null;
				return structuredClone({
					run_id: binding.runId,
					receipt_id: input.receiptId,
					state: "completed",
					result: input.result,
				});
			},
		),
	};
	const operations = new CloudNativeToolOperations(run, control);
	const operation: CloudNativeToolOperation = {
		tool: "write_document",
		toolVersion: "1",
		logicalOperationKey: "job-document-1",
		arguments: { text: "A reviewed decision" },
		target: { path: "decisions/example.md", expectedVersion: 3, audience: "company", policyVersion: 2 },
		requiresCompanyRevision: false,
	};
	const authorize = vi.fn<ExecuteOptions["authorize"]>(async () => undefined);
	const perform = vi.fn<ExecuteOptions["perform"]>(async () => ({
		content: { kind: "json", value: { changed: true } },
	}));
	const execute = (patch: Partial<ExecuteOptions> = {}, executor = operations) =>
		executor.execute({
			operation,
			authorize,
			perform,
			signal: abort.signal,
			...patch,
		});
	return { ...authority, reader, run, abort, control, operations, ledger, operation, authorize, perform, execute };
}

it("binds the exact plan and cloud principals to one durable attempt", async () => {
	const f = await fixture();
	await expect(f.execute()).resolves.toEqual({ kind: "json", value: { changed: true } });
	expect(f.authorize).toHaveBeenCalledTimes(3);
	expect(f.control.beginToolOperation).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
	const input = f.control.beginToolOperation.mock.calls[0][1];
	expect(input).toMatchObject({
		logicalOperationKey: "write_document:job-document-1",
		operationKind: "cloud_tool",
		inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	const [plan, context] = f.perform.mock.calls[0];
	expect(plan).toEqual(f.operation);
	expect(Object.isFrozen(plan)).toBe(true);
	expect(Object.isFrozen(plan.arguments)).toBe(true);
	expect(Object.isFrozen(plan.target)).toBe(true);
	expect(context).toMatchObject({
		identity: f.authority.identity,
		receiptId: input.receiptId,
		inputSha256: input.inputSha256,
		idempotencyKey: input.downstreamIdempotencyKey,
	});
	expect(JSON.stringify(context.identity)).not.toContain(f.binding.credentialCapsuleId);
});

it("deduplicates concurrent callers before any asynchronous admission", async () => {
	const f = await fixture();
	const results = await Promise.all([f.execute(), f.execute(), f.execute()]);
	expect(results[0]).toEqual(results[1]);
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.beginToolOperation).toHaveBeenCalledTimes(1);
});

it("snapshots mutable arguments before asynchronous authorization", async () => {
	const f = await fixture();
	const argumentsValue = { text: "Original bytes" };
	const target = { path: "decisions/original.md", expectedVersion: 3 };
	const result = f.execute({ operation: { ...f.operation, arguments: argumentsValue, target } });
	argumentsValue.text = "Changed bytes";
	target.path = "identity/admin.md";
	await result;
	expect(f.perform.mock.calls[0][0].arguments).toEqual({ text: "Original bytes" });
	expect(f.perform.mock.calls[0][0].target).toEqual({ path: "decisions/original.md", expectedVersion: 3 });
});

it("releases cached content only after fresh run and target authorization", async () => {
	const f = await fixture();
	const first = await f.execute();
	if (first.kind === "json" && first.value && typeof first.value === "object" && !Array.isArray(first.value))
		first.value.changed = false;
	const checks = f.reader.describeToolAuthority.mock.calls.length;
	await expect(f.execute()).resolves.toEqual({ kind: "json", value: { changed: true } });
	expect(f.reader.describeToolAuthority).toHaveBeenCalledTimes(checks + 1);
	expect(f.authorize).toHaveBeenCalledTimes(4);
	f.authorize.mockRejectedValueOnce(new Error("PRIVATE_PATH_REVOKED"));
	await expect(f.execute()).rejects.toThrow("Cloud tool operation outcome unconfirmed");
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("replays a completed durable receipt after process-local state is lost", async () => {
	const f = await fixture();
	await f.execute();
	await expect(f.execute({}, new CloudNativeToolOperations(f.run, f.control))).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(f.control.beginToolOperation).toHaveBeenCalledTimes(2);
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
});

it.each([
	{ arguments: { text: "Different bytes" } },
	{ target: { path: "identity/admin.md", expectedVersion: 3, audience: "company", policyVersion: 2 } },
	{ target: { path: "decisions/example.md", expectedVersion: 4, audience: "company", policyVersion: 2 } },
	{ target: { path: "decisions/example.md", expectedVersion: 3, audience: "external", policyVersion: 2 } },
	{ toolVersion: "2" },
	{ requiresCompanyRevision: true },
])("does not reuse a logical key for a changed plan: %j", async (patch) => {
	const f = await fixture();
	await f.execute();
	await expect(f.execute({ operation: { ...f.operation, ...patch } })).rejects.toThrow("bound to other work");
	await expect(
		f.execute({ operation: { ...f.operation, ...patch } }, new CloudNativeToolOperations(f.run, f.control)),
	).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("replays completed intent across a fresh assignment and same-principal sponsor handoff", async () => {
	const f = await fixture();
	await f.execute();
	f.run.close();
	const binding = { ...f.binding, runnerId: randomUUID(), assignmentId: randomUUID(), leaseId: randomUUID() };
	const authority = {
		...f.authority,
		identity: {
			...f.authority.identity,
			runnerId: binding.runnerId,
			assignmentId: binding.assignmentId,
			leaseId: binding.leaseId,
			sponsorVersion: f.authority.identity.sponsorVersion + 1,
			providerConnectionId: randomUUID(),
			providerConnectionVersion: f.authority.identity.providerConnectionVersion + 1,
		},
	};
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	runs.push(run);
	await expect(f.execute({}, new CloudNativeToolOperations(run, f.control))).resolves.toMatchObject({ kind: "json" });
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.beginToolOperation.mock.calls[1][1].inputSha256).toBe(
		f.control.beginToolOperation.mock.calls[0][1].inputSha256,
	);
	await expect(
		f.execute(
			{ operation: { ...f.operation, arguments: { text: "Different work" } } },
			new CloudNativeToolOperations(run, f.control),
		),
	).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it.each(["executing", "ambiguous", "cancelled"] as const)("does not rerun a retained %s operation", async (state) => {
	const f = await fixture();
	f.perform.mockRejectedValueOnce(new Error("PRIVATE_EFFECT_UNKNOWN"));
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	const receipt = [...f.ledger.values()][0];
	receipt.state = state;
	await expect(f.execute({}, new CloudNativeToolOperations(f.run, f.control))).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).not.toHaveBeenCalled();
});

it("does not bypass an uncertain effect by changing the native call ID or logical key", async () => {
	const f = await fixture();
	f.perform.mockRejectedValue(new Error("PRIVATE_EFFECT_UNKNOWN"));
	const boundary = new CloudNativeToolBoundary({
		companyId: f.authority.identity.companyId,
		runId: f.run.identity.runId,
		identity: f.run.identity,
		signal: f.run.signal,
		assertActive: (signal) => f.run.assertActive(signal),
		tools: [
			{
				name: "write_document",
				description: "Test a durable operation",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => f.execute(),
			},
		],
	});
	try {
		for (const callId of ["call_one", "call_two"]) {
			const result = await boundary.invoke(callId, "qorpera", "write_document", {});
			expect(result.success).toBe(false);
			expect(result.contentItems[0].text).toContain("TOOL_OUTCOME_UNCONFIRMED");
			expect(result.contentItems[0].text).not.toContain("PRIVATE_EFFECT_UNKNOWN");
		}
		await expect(
			f.execute(
				{ operation: { ...f.operation, logicalOperationKey: "changed-key" } },
				new CloudNativeToolOperations(f.run, f.control),
			),
		).rejects.toThrow("outcome unconfirmed");
		expect(f.perform).toHaveBeenCalledTimes(1);
	} finally {
		boundary.close();
	}
});

it("does not execute when the begin receipt response is lost", async () => {
	const f = await fixture();
	const begin = f.control.beginToolOperation.getMockImplementation();
	if (!begin) throw new Error("Missing test implementation");
	f.control.beginToolOperation.mockImplementationOnce(async (...args) => {
		await begin(...args);
		throw new Error("PRIVATE_LOST_RESPONSE");
	});
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	await expect(f.execute({}, new CloudNativeToolOperations(f.run, f.control))).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).not.toHaveBeenCalled();
	expect([...f.ledger.values()][0].state).toBe("executing");
});

it("recovers a recorded completion without repeating its effect after a lost response", async () => {
	const f = await fixture();
	const complete = f.control.completeToolOperation.getMockImplementation();
	if (!complete) throw new Error("Missing test implementation");
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => {
		await complete(...args);
		throw new Error("PRIVATE_LOST_COMPLETION");
	});
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	await expect(f.execute({}, new CloudNativeToolOperations(f.run, f.control))).resolves.toMatchObject({
		kind: "json",
	});
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("leaves no operation or effect when target authorization denies admission", async () => {
	const f = await fixture();
	f.authorize.mockRejectedValueOnce(new Error("PRIVATE_DENIED"));
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	expect(f.perform).not.toHaveBeenCalled();
});

it("retains the fence when authority is revoked after reservation but before the effect", async () => {
	const f = await fixture();
	f.authorize.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error("PRIVATE_REVOKED"));
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).not.toHaveBeenCalled();
	expect([...f.ledger.values()][0].state).toBe("executing");
});

it("withholds a finished effect's result if cloud authority has been revoked", async () => {
	const f = await fixture();
	f.perform.mockImplementationOnce(async () => {
		f.reader.describeToolAuthority.mockRejectedValueOnce(new Error("PRIVATE_RUN_REVOKED"));
		return { content: { kind: "text", value: "PRIVATE_EFFECT_RESULT" } };
	});
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	expect(f.run.signal.aborted).toBe(true);
	expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	expect([...f.ledger.values()][0].state).toBe("executing");
});

it("bounds an uncooperative effect and keeps its outcome uncertain", async () => {
	vi.useFakeTimers();
	const f = await fixture();
	f.perform.mockImplementationOnce(async () => new Promise<never>(() => undefined));
	const result = expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	await vi.advanceTimersByTimeAsync(30_000);
	await result;
	expect(f.perform.mock.calls[0][1].signal.aborted).toBe(true);
	expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	expect([...f.ledger.values()][0].state).toBe("executing");
});

it.each([
	{ tool: 7 },
	{ toolVersion: 1 },
	{ logicalOperationKey: 1 },
	{ tool: "a".repeat(64), logicalOperationKey: "b".repeat(192) },
	{ approved: true },
	{ target: {} },
	{ target: "company" },
	{ requiresCompanyRevision: "false" },
])("rejects invalid operation plans before any ledger call: %j", async (patch) => {
	const f = await fixture();
	await expect(
		f.execute({ operation: { ...f.operation, ...patch } as unknown as CloudNativeToolOperation }),
	).rejects.toThrow();
	expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	expect(f.perform).not.toHaveBeenCalled();
});

it.each([
	{ run_id: randomUUID() },
	{ receipt_id: "not-a-receipt" },
	{ state: "completed", result: {} },
	{ state: "executing", receipt_id: randomUUID() },
	{ authority: "fake" },
])("rejects inconsistent receipts before performing an effect: %j", async (patch) => {
	const f = await fixture();
	const begin = f.control.beginToolOperation.getMockImplementation();
	if (!begin) throw new Error("Missing test implementation");
	f.control.beginToolOperation.mockImplementationOnce(async (...args) => ({
		...((await begin(...args)) as object),
		...patch,
	}));
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).not.toHaveBeenCalled();
});

it("requires a durable Company revision when the operation declares one", async () => {
	const f = await fixture();
	await expect(f.execute({ operation: { ...f.operation, requiresCompanyRevision: true } })).rejects.toThrow(
		"outcome unconfirmed",
	);
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).not.toHaveBeenCalled();
});

it("binds a durable revision on completion and on restart replay", async () => {
	const f = await fixture();
	const outputSnapshotId = randomUUID();
	f.perform.mockResolvedValueOnce({ content: { kind: "text", value: "changed" }, outputSnapshotId });
	const operation = { ...f.operation, requiresCompanyRevision: true };
	await expect(f.execute({ operation })).resolves.toEqual({ kind: "text", value: "changed" });
	expect(f.control.completeToolOperation.mock.calls[0][1].outputSnapshotId).toBe(outputSnapshotId);
	await expect(f.execute({ operation }, new CloudNativeToolOperations(f.run, f.control))).resolves.toMatchObject({
		value: "changed",
	});
	[...f.ledger.values()][0].outputSnapshotId = null;
	await expect(f.execute({ operation }, new CloudNativeToolOperations(f.run, f.control))).rejects.toThrow(
		"outcome unconfirmed",
	);
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("rejects a completion response with different stored content", async () => {
	const f = await fixture();
	const complete = f.control.completeToolOperation.getMockImplementation();
	if (!complete) throw new Error("Missing test implementation");
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => ({
		...((await complete(...args)) as object),
		result: { injected: "PRIVATE" },
	}));
	await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("links effect timing and a new-call replay to the same canonical receipt without exporting business data", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const first = observed.observability.start("connector");
	await f.execute({ observation: first });
	const receiptId = f.control.beginToolOperation.mock.calls[0][1].receiptId;
	expect(first.result).toMatchObject({ status: "succeeded", receiptId, outputBytes: 16, errorCategory: null });
	const replay = observed.observability.start("connector");
	await f.execute({ observation: replay });
	expect(replay.result).toMatchObject({ status: "replayed", receiptId, outputBytes: 16, errorCategory: null });
	expect(replay.attemptId).not.toBe(first.attemptId);
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.beginToolOperation).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
	expect(f.authorize).toHaveBeenCalledTimes(4);
	expect(Object.keys(f.perform.mock.calls[0][1]).sort()).toEqual([
		"idempotencyKey",
		"identity",
		"inputSha256",
		"receiptId",
		"signal",
	]);
	await observed.observability.close();
	for (const span of [first, replay]) {
		const finish = observed.rows.findIndex((row) => row.attemptId === span.attemptId && row.phase === "finish");
		const release = observed.rows.reduce(
			(last, row, index) => (row.parentAttemptId === span.attemptId && row.phase === "start" ? index : last),
			-1,
		);
		expect(release).toBeGreaterThan(finish);
		expect(observed.rows[release]).toMatchObject({ operation: "context_authority" });
	}
	// The first call's own permission check, before its receipt, is its own child too.
	const checks = observed.rows.filter(
		(row) =>
			row.parentAttemptId === first.attemptId && row.operation === "context_authority" && row.phase === "finish",
	);
	expect(checks.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
	expect(JSON.stringify(observed.rows)).not.toMatch(/reviewed decision|decisions\/example|changed|job-document/);
});

it.each([false, true])(
	"observes a canonical replay when the original call had no observer (restart=%s)",
	async (restart) => {
		const f = await fixture();
		await f.execute();
		const observed = observe(f.binding.assignmentId);
		const replay = observed.observability.start("connector");
		await f.execute(
			{ observation: replay },
			restart ? new CloudNativeToolOperations(f.run, f.control) : f.operations,
		);
		expect(replay.result).toMatchObject({
			status: "replayed",
			receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
		});
		expect(f.perform).toHaveBeenCalledTimes(1);
		expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
	},
);

it("counts a concurrently joined operation as replays, not additional effects", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const spans = Array.from({ length: 3 }, () => observed.observability.start("connector"));
	await Promise.all(spans.map((observation) => f.execute({ observation })));
	expect(spans.map((span) => span.result?.status)).toEqual(["succeeded", "replayed", "replayed"]);
	expect(new Set(spans.map((span) => span.result?.receiptId))).toEqual(
		new Set([f.control.beginToolOperation.mock.calls[0][1].receiptId]),
	);
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("keeps a canonical proposal proposed on cached and durable replay regardless of payload claims", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const operation = { ...f.operation, requiresCompanyRevision: true };
	const proposalId = randomUUID();
	f.perform.mockResolvedValueOnce({
		content: { kind: "json", value: { state: "succeeded", receiptId: randomUUID() } },
		proposalId,
	});
	for (const executor of [f.operations, f.operations, new CloudNativeToolOperations(f.run, f.control)]) {
		const span = observed.observability.start("connector");
		await f.execute({ operation, observation: span }, executor);
		expect(span.result).toMatchObject({
			status: "proposed",
			receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
		});
	}
	expect(f.control.completeToolOperation.mock.calls[0][1].proposalId).toBe(proposalId);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it.each(["succeeded", "proposed"] as const)("preserves %s when subsequent grant release is denied", async (outcome) => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	if (outcome === "proposed")
		f.perform.mockResolvedValueOnce({
			content: { kind: "text", value: "PRIVATE_RESULT" },
			proposalId: randomUUID(),
		});
	f.authorize
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce(undefined)
		.mockRejectedValue(new Error("PRIVATE_GRANT_REVOKED"));
	const first = observed.observability.start("connector");
	await expect(f.execute({ observation: first })).rejects.toThrow("Cloud tool operation outcome unconfirmed");
	expect(first.result).toMatchObject({ status: outcome, errorCategory: null });
	const replay = observed.observability.start("connector");
	await expect(f.execute({ observation: replay })).rejects.toThrow("Cloud tool operation outcome unconfirmed");
	expect(replay.result).toMatchObject({
		status: outcome === "succeeded" ? "replayed" : "proposed",
		receiptId: first.result?.receiptId,
		errorCategory: null,
	});
	await observed.observability.close();
	for (const span of [first, replay])
		expect(observed.rows).toContainEqual(
			expect.objectContaining({
				parentAttemptId: span.attemptId,
				operation: "context_authority",
				phase: "finish",
				status: "denied",
				errorCategory: "authority_unavailable",
			}),
		);
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(observed.rows)).not.toContain("PRIVATE");
});

it("retains canonical completion when the run is revoked only at result release", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const complete = f.control.completeToolOperation.getMockImplementation()!;
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => {
		const result = await complete(...args);
		f.reader.describeToolAuthority.mockRejectedValueOnce(new Error("PRIVATE_RUN_REVOKED"));
		return result;
	});
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({
		status: "succeeded",
		receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
	});
	expect(f.run.signal.aborted).toBe(true);
	await observed.observability.close();
	expect(observed.rows).toContainEqual(
		expect.objectContaining({
			parentAttemptId: span.attemptId,
			operation: "context_authority",
			phase: "finish",
			status: "denied",
		}),
	);
});

it("retains a receipt for lost completion and ambiguous cache hits until canonical durable replay", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const complete = f.control.completeToolOperation.getMockImplementation()!;
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => {
		await complete(...args);
		throw new Error("PRIVATE_LOST_COMPLETION");
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		const span = observed.observability.start("connector");
		await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
		expect(span.result).toMatchObject({
			status: "unconfirmed",
			errorCategory: "ambiguous_effect",
			outputBytes: null,
			receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
		});
	}
	const recovered = observed.observability.start("connector");
	await f.execute({ observation: recovered }, new CloudNativeToolOperations(f.run, f.control));
	expect(recovered.result).toMatchObject({
		status: "replayed",
		receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
	});
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.control.beginToolOperation).toHaveBeenCalledTimes(2);
	expect(f.control.completeToolOperation).toHaveBeenCalledTimes(1);
});

it.each(["executing", "ambiguous", "cancelled"] as const)(
	"links a retained %s receipt without performing or releasing it",
	async (state) => {
		const f = await fixture();
		f.perform.mockRejectedValueOnce(new Error("PRIVATE_EFFECT_UNKNOWN"));
		await expect(f.execute()).rejects.toThrow("outcome unconfirmed");
		const receipt = [...f.ledger.values()][0];
		receipt.state = state;
		const observed = observe(f.binding.assignmentId);
		const span = observed.observability.start("connector");
		await expect(f.execute({ observation: span }, new CloudNativeToolOperations(f.run, f.control))).rejects.toThrow(
			"outcome unconfirmed",
		);
		expect(span.result).toMatchObject({
			status: "unconfirmed",
			receiptId: receipt.input.receiptId,
			errorCategory: "ambiguous_effect",
		});
		await observed.observability.close();
		// Only the permission check before the receipt; nothing is released.
		expect(
			observed.rows
				.filter((row) => row.operation === "context_authority" && row.phase === "finish")
				.map((row) => row.status),
		).toEqual(["succeeded"]);
		expect(f.perform).toHaveBeenCalledTimes(1);
		expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	},
);

it("names a timeout in the permission check before the receipt as its own child observation", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	f.authorize.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("timeout"));
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({ status: "unconfirmed", receiptId: null, errorCategory: "timeout" });
	expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	await observed.observability.close();
	expect(observed.rows).toContainEqual(
		expect.objectContaining({
			parentAttemptId: span.attemptId,
			operation: "context_authority",
			phase: "finish",
			status: "unconfirmed",
			errorCategory: "timeout",
		}),
	);
});

it("names a timeout in the run's own recheck before the receipt, although the run then closes", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	f.reader.describeToolAuthority.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("timeout"));
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow();
	expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	await observed.observability.close();
	expect(
		observed.rows
			.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
			.map((row) => [row.operation, row.status, row.errorCategory]),
	).toEqual([["context_authority", "unconfirmed", "timeout"]]);
});

it("tells a timeout at the receipt apart: the permission check before it succeeded", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	f.control.beginToolOperation.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("timeout"));
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({ status: "unconfirmed", receiptId: null, errorCategory: "timeout" });
	await observed.observability.close();
	expect(
		observed.rows
			.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
			.map((row) => [row.operation, row.status, row.errorCategory]),
	).toEqual([["context_authority", "succeeded", null]]);
});

it("does not link a locally proposed receipt when the canonical begin response is lost", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const begin = f.control.beginToolOperation.getMockImplementation()!;
	f.control.beginToolOperation.mockImplementationOnce(async (...args) => {
		await begin(...args);
		throw new Error("PRIVATE_LOST_BEGIN");
	});
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({ status: "unconfirmed", receiptId: null });
	expect(f.perform).not.toHaveBeenCalled();
	expect(f.ledger.size).toBe(1);
});

it.each([
	{ run_id: randomUUID() },
	{ receipt_id: "PRIVATE_NOT_A_UUID" },
	{ state: "unknown" },
	{ authority: "PRIVATE_EXTRA" },
	{ state: "completed", result: {} },
	{ result: { state: "completed" } },
	{ output_snapshot_id: randomUUID() },
])("never observes an invalid canonical begin as a known effect: %j", async (patch) => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const begin = f.control.beginToolOperation.getMockImplementation()!;
	f.control.beginToolOperation.mockImplementationOnce(async (...args) => ({
		...((await begin(...args)) as object),
		...patch,
	}));
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({ status: "unconfirmed", receiptId: null, outputBytes: null });
	expect(f.perform).not.toHaveBeenCalled();
});

it.each([
	{ run_id: randomUUID() },
	{ receipt_id: randomUUID() },
	{ state: "executing" },
	{ result: { injected: "PRIVATE" } },
	{ authority: "PRIVATE_EXTRA" },
])("does not promote a tampered completion, retaining only the validated begin link: %j", async (patch) => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	const complete = f.control.completeToolOperation.getMockImplementation()!;
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => ({
		...((await complete(...args)) as object),
		...patch,
	}));
	const span = observed.observability.start("connector");
	await expect(f.execute({ observation: span })).rejects.toThrow("outcome unconfirmed");
	expect(span.result).toMatchObject({
		status: "unconfirmed",
		errorCategory: "ambiguous_effect",
		outputBytes: null,
		receiptId: f.control.beginToolOperation.mock.calls[0][1].receiptId,
	});
	expect(f.perform).toHaveBeenCalledTimes(1);
});

it("keeps effects and canonical replay independent of diagnostic exporter failure", async () => {
	const f = await fixture();
	const observed = observe(f.binding.assignmentId);
	observed.publish.mockRejectedValue(new Error("PRIVATE_EXPORT_DOWN"));
	const first = observed.observability.start("connector");
	await f.execute({ observation: first });
	const replay = observed.observability.start("connector");
	await f.execute({ observation: replay });
	expect(first.result?.status).toBe("succeeded");
	expect(replay.result).toMatchObject({ status: "replayed", receiptId: first.result?.receiptId });
	expect(observed.observability.state.status).toBe("unavailable");
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.authorize).toHaveBeenCalledTimes(4);
});

it("never refuses a run's operations by count; a forgotten one replays through its receipt", async () => {
	// Runtime v92: the run used to fail after 65,536 operations. Past that the
	// oldest are forgotten locally and the kernel receipt stays the authority.
	const f = await fixture();
	const receipts = new Map<string, Receipt>();
	const control: CloudNativeToolOperationControlPlane = {
		beginToolOperation: async (binding, input) => {
			let receipt = receipts.get(input.logicalOperationKey);
			if (receipt && receipt.input.inputSha256 !== input.inputSha256) throw new Error("other work");
			if (!receipt) {
				receipt = { input, state: "executing", result: null, outputSnapshotId: null, proposalId: null };
				receipts.set(input.logicalOperationKey, receipt);
			}
			return {
				run_id: binding.runId,
				receipt_id: receipt.input.receiptId,
				state: receipt.state,
				result: receipt.result,
				output_snapshot_id: null,
				proposal_id: null,
			};
		},
		completeToolOperation: async (binding, input) => {
			const receipt = [...receipts.values()].at(-1)!;
			expect(receipt.input.receiptId).toBe(input.receiptId);
			receipt.state = "completed";
			receipt.result = input.result;
			return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
		},
	};
	const operations = new CloudNativeToolOperations(f.run, control);
	const keyed = (index: number) => ({ ...f.operation, logicalOperationKey: `job-document-${index}` });
	const total = 65_536 + 2;
	for (let index = 0; index < total; index++)
		await expect(f.execute({ operation: keyed(index) }, operations)).resolves.toEqual({
			kind: "json",
			value: { changed: true },
		});
	expect(f.perform).toHaveBeenCalledTimes(total);
	// The first operation is no longer remembered locally: its replay reads the
	// completed receipt and never performs the effect again.
	await expect(f.execute({ operation: keyed(0) }, operations)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(f.perform).toHaveBeenCalledTimes(total);
	expect(receipts.size).toBe(total);
}, 300_000);
