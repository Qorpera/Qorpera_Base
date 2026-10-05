import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	CloudToolAuthorizeRefusal,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_NATIVE_TOOL_REMEMBERED_OPERATIONS,
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
	/** Set for a folder-v2 receipt, whose answers always name the commit (null before completion). */
	folderCommitId?: string | null;
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
	const publish = vi.fn(async (batch: readonly CloudRuntimeObservation[]) => {
		rows.push(...structuredClone(batch));
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
				...(receipt.folderCommitId !== undefined ? { folder_commit_id: receipt.folderCommitId } : {}),
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
		completeFolderToolOperation: vi.fn<
			NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
		>(async (binding, input) => {
			const receipt = [...ledger.values()].find((entry) => entry.input.receiptId === input.receiptId);
			if (!receipt || receipt.input.inputSha256 !== input.inputSha256 || receipt.state !== "executing")
				throw new Error("invalid completion");
			receipt.state = "completed";
			receipt.result = structuredClone(input.result);
			receipt.folderCommitId = input.folderCommitId;
			return structuredClone({
				run_id: binding.runId,
				receipt_id: input.receiptId,
				state: "completed",
				result: input.result,
				folder_commit_id: input.folderCommitId,
			});
		}),
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

it("relays the registry's refusal at the authorize before the receipt, and no other failure", async () => {
	const f = await fixture();
	const message = "Screenshots are not available on this computer yet";
	f.authorize.mockRejectedValueOnce(new CloudToolAuthorizeRefusal(message));
	const refused = f.execute();
	await expect(refused).rejects.toBeInstanceOf(CloudToolAuthorizeRefusal);
	await expect(refused).rejects.toThrow(message);
	// The same key answers the same refusal; nothing began.
	await expect(f.execute()).rejects.toBeInstanceOf(CloudToolAuthorizeRefusal);
	expect(f.control.beginToolOperation).not.toHaveBeenCalled();
	// Any other refusal there stays an unknown outcome, and so does the registry's refusal once the receipt began.
	f.authorize.mockRejectedValueOnce(new CloudToolRefusal(message));
	await expect(f.execute({ operation: { ...f.operation, logicalOperationKey: "job-document-2" } })).rejects.toThrow(
		"outcome unconfirmed",
	);
	f.authorize
		.mockImplementationOnce(async () => undefined)
		.mockRejectedValueOnce(new CloudToolAuthorizeRefusal(message));
	await expect(f.execute({ operation: { ...f.operation, logicalOperationKey: "job-document-3" } })).rejects.toThrow(
		"outcome unconfirmed",
	);
	expect(f.perform).not.toHaveBeenCalled();
	expect([...f.ledger.values()].map((receipt) => receipt.state)).toEqual(["executing"]);
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
	await observed.observability.close();
	expect(observed.observability.state.status).toBe("unavailable");
	expect(f.perform).toHaveBeenCalledTimes(1);
	expect(f.authorize).toHaveBeenCalledTimes(4);
});

it("never refuses a run's operations by count; a forgotten one replays through its receipt", async () => {
	// Runtime v92: the run used to fail after 65,536 operations. Past that the
	// oldest are forgotten locally and the kernel receipt stays the authority.
	// The limit is injected: the same code path at 65,536 took 20-80 s per run.
	expect(CLOUD_NATIVE_TOOL_REMEMBERED_OPERATIONS).toBe(65_536);
	const f = await fixture();
	const receipts = new Map<string, Receipt>();
	// The newest receipt, which the next completion must name.
	let newest: Receipt | undefined;
	const control = {
		beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async (binding, input) => {
			let receipt = receipts.get(input.logicalOperationKey);
			if (receipt && receipt.input.inputSha256 !== input.inputSha256) throw new Error("other work");
			if (!receipt) {
				receipt = { input, state: "executing", result: null, outputSnapshotId: null, proposalId: null };
				receipts.set(input.logicalOperationKey, receipt);
				newest = receipt;
			}
			return {
				run_id: binding.runId,
				receipt_id: receipt.input.receiptId,
				state: receipt.state,
				result: receipt.result,
				output_snapshot_id: null,
				proposal_id: null,
			};
		}),
		completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(
			async (binding, input) => {
				const receipt = newest!;
				expect(receipt.input.receiptId).toBe(input.receiptId);
				receipt.state = "completed";
				receipt.result = input.result;
				return { run_id: binding.runId, receipt_id: input.receiptId, state: "completed", result: input.result };
			},
		),
	};
	const remembered = 4;
	const operations = new CloudNativeToolOperations(f.run, control, { rememberedOperations: remembered });
	const keyed = (index: number) => ({ ...f.operation, logicalOperationKey: `job-document-${index}` });
	const total = remembered + 2;
	for (let index = 0; index < total; index++)
		await expect(f.execute({ operation: keyed(index) }, operations)).resolves.toEqual({
			kind: "json",
			value: { changed: true },
		});
	expect(f.perform).toHaveBeenCalledTimes(total);
	expect(control.beginToolOperation).toHaveBeenCalledTimes(total);
	// The newest operation is still remembered locally: its replay asks no receipt.
	await expect(f.execute({ operation: keyed(total - 1) }, operations)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(control.beginToolOperation).toHaveBeenCalledTimes(total);
	// Exactly the last `remembered` operations are kept: the oldest of them still
	// replays locally (a whole-map clear would lose it) ...
	await expect(f.execute({ operation: keyed(total - remembered) }, operations)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(control.beginToolOperation).toHaveBeenCalledTimes(total);
	// ... and the one just before them is forgotten (keeping one too many would not).
	await expect(f.execute({ operation: keyed(total - remembered - 1) }, operations)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(control.beginToolOperation).toHaveBeenCalledTimes(total + 1);
	// The first operation is no longer remembered locally either: its replay reads
	// the completed receipt and never performs the effect again.
	await expect(f.execute({ operation: keyed(0) }, operations)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(control.beginToolOperation).toHaveBeenCalledTimes(total + 2);
	expect(f.perform).toHaveBeenCalledTimes(total);
	expect(receipts.size).toBe(total);
	expect(control.completeToolOperation).toHaveBeenCalledTimes(total);
	// Without the option the bound is the default: eight operations forget nothing.
	const defaults = new CloudNativeToolOperations(f.run, control);
	const unbounded = (index: number) => ({ ...f.operation, logicalOperationKey: `job-default-${index}` });
	for (let index = 0; index < 8; index++) await f.execute({ operation: unbounded(index) }, defaults);
	const begun = control.beginToolOperation.mock.calls.length;
	await expect(f.execute({ operation: unbounded(0) }, defaults)).resolves.toEqual({
		kind: "json",
		value: { changed: true },
	});
	expect(control.beginToolOperation).toHaveBeenCalledTimes(begun);
});

it("refuses an invalid remembered operation count", async () => {
	const f = await fixture();
	// Only lower than the default: a larger count would switch forgetting off in practice.
	for (const rememberedOperations of [
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		65_537,
		Number.MAX_SAFE_INTEGER,
	])
		expect(() => new CloudNativeToolOperations(f.run, f.control, { rememberedOperations })).toThrow(
			"Invalid remembered operation count",
		);
	expect(() => new CloudNativeToolOperations(f.run, f.control, { rememberedOperations: 65_536 })).not.toThrow();
});

it("completes a folder writer's receipt with its commit, and replays it from the receipt", async () => {
	const f = await fixture();
	const folderCommitId = randomUUID();
	f.perform.mockResolvedValueOnce({ content: { kind: "json", value: { saved: true } }, folderCommitId });
	const operation = { ...f.operation, requiresCompanyRevision: true };
	await expect(f.execute({ operation })).resolves.toEqual({ kind: "json", value: { saved: true } });
	expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	expect(f.control.completeFolderToolOperation.mock.calls[0][1]).toMatchObject({ folderCommitId });
	// A new process replays the stored result from the receipt, which names the commit.
	await expect(f.execute({ operation }, new CloudNativeToolOperations(f.run, f.control))).resolves.toEqual({
		kind: "json",
		value: { saved: true },
	});
	expect(f.perform).toHaveBeenCalledTimes(1);
	// A receipt naming two revisions is not trusted.
	[...f.ledger.values()][0].outputSnapshotId = randomUUID();
	await expect(f.execute({ operation }, new CloudNativeToolOperations(f.run, f.control))).rejects.toThrow(
		"outcome unconfirmed",
	);
});

it("refuses a folder commit it cannot complete, or a completion naming another commit", async () => {
	// Each case on its own ledger: a refused case leaves its receipt executing, which would refuse the next at begin.
	const legacyCase = await fixture();
	const { completeFolderToolOperation: _, ...legacy } = legacyCase.control;
	legacyCase.perform.mockResolvedValueOnce({
		content: { kind: "text", value: "saved" },
		folderCommitId: randomUUID(),
	});
	await expect(
		legacyCase.execute(
			{ operation: { ...legacyCase.operation, requiresCompanyRevision: true } },
			new CloudNativeToolOperations(legacyCase.run, legacy),
		),
	).rejects.toThrow("outcome unconfirmed");
	expect(legacyCase.perform).toHaveBeenCalledTimes(1);
	expect(legacyCase.control.completeToolOperation).not.toHaveBeenCalled();
	const otherCase = await fixture();
	otherCase.perform.mockResolvedValueOnce({ content: { kind: "text", value: "saved" }, folderCommitId: randomUUID() });
	const complete = otherCase.control.completeFolderToolOperation.getMockImplementation();
	if (!complete) throw new Error("Missing test implementation");
	otherCase.control.completeFolderToolOperation.mockImplementationOnce(async (...args) => ({
		...((await complete(...args)) as object),
		folder_commit_id: randomUUID(),
	}));
	await expect(
		otherCase.execute({ operation: { ...otherCase.operation, requiresCompanyRevision: true } }),
	).rejects.toThrow("outcome unconfirmed");
	expect(otherCase.control.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// A folder completion that names no commit at all is not the commit's either.
	const silentCase = await fixture();
	silentCase.perform.mockResolvedValueOnce({
		content: { kind: "text", value: "saved" },
		folderCommitId: randomUUID(),
	});
	const silent = silentCase.control.completeFolderToolOperation.getMockImplementation();
	if (!silent) throw new Error("Missing test implementation");
	silentCase.control.completeFolderToolOperation.mockImplementationOnce(async (...args) => {
		const { folder_commit_id: _commit, ...rest } = (await silent(...args)) as Record<string, unknown>;
		return rest;
	});
	await expect(
		silentCase.execute({ operation: { ...silentCase.operation, requiresCompanyRevision: true } }),
	).rejects.toThrow("outcome unconfirmed");
});

it("accepts a folder-v2 completion that needed no commit", async () => {
	const f = await fixture();
	const complete = f.control.completeToolOperation.getMockImplementation();
	if (!complete) throw new Error("Missing test implementation");
	// SQL's folder completion always names the commit, null when the receipt needed none.
	f.control.completeToolOperation.mockImplementationOnce(async (...args) => ({
		...((await complete(...args)) as object),
		folder_commit_id: null,
	}));
	await expect(f.execute()).resolves.toEqual({ kind: "json", value: { changed: true } });
});

it("refuses a folder commit beside another revision, or on an operation that declared none", async () => {
	const two = await fixture();
	expect(two.operations.completesFolderCommits).toBe(true);
	two.perform.mockResolvedValueOnce({
		content: { kind: "text", value: "saved" },
		outputSnapshotId: randomUUID(),
		folderCommitId: randomUUID(),
	});
	await expect(two.execute({ operation: { ...two.operation, requiresCompanyRevision: true } })).rejects.toThrow(
		"outcome unconfirmed",
	);
	expect(two.perform).toHaveBeenCalledTimes(1);
	const none = await fixture();
	none.perform.mockResolvedValueOnce({ content: { kind: "text", value: "saved" }, folderCommitId: randomUUID() });
	await expect(none.execute()).rejects.toThrow("outcome unconfirmed");
	expect(none.perform).toHaveBeenCalledTimes(1);
	for (const f of [two, none]) {
		expect(f.control.completeFolderToolOperation).not.toHaveBeenCalled();
		expect(f.control.completeToolOperation).not.toHaveBeenCalled();
	}
	const { completeFolderToolOperation: _, ...legacy } = none.control;
	expect(new CloudNativeToolOperations(none.run, legacy).completesFolderCommits).toBe(false);
});

it("sends and compares a folder commit's id in the lower case SQL echoes", async () => {
	const f = await fixture();
	const folderCommitId = randomUUID();
	f.perform.mockResolvedValueOnce({
		content: { kind: "text", value: "saved" },
		folderCommitId: folderCommitId.toUpperCase(),
	});
	await expect(
		f.execute({ operation: { ...f.operation, logicalOperationKey: "upper", requiresCompanyRevision: true } }),
	).resolves.toEqual({ kind: "text", value: "saved" });
	expect(f.control.completeFolderToolOperation.mock.calls[0][1]).toMatchObject({ folderCommitId });
});
