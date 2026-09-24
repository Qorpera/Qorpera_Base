import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import type { CloudCodingCommandGateway } from "../src/cloud-coding-command-tools.ts";
import {
	type CloudCodingNativeControl,
	CloudNativeCodingRuntime,
	type CloudNativeCodingTurnContext,
} from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "../src/cloud-native-run-tool-session.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { type CloudToolContext, cloudToolJsonText } from "../src/cloud-native-tool-boundary.ts";
import { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";
import type { CloudWakeEnvelope } from "../src/cloud-wake-bus.ts";

vi.mock("../src/cloud-native-run-tool-session.ts", () => ({ runCloudNativeRunToolSession: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

function fixture() {
	const { binding, authority: base } = nativeToolAuthorityFixture();
	const authority = { ...base, identity: { ...base.identity, sessionId: null as string | null } };
	const workerId = randomUUID();
	const vmId = randomUUID();
	const turnId = randomUUID();
	const repository = { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" };
	const coding = {
		workerId,
		sequence: 1,
		turnId,
		vmId,
		harness: "codex",
		model: null,
		repository,
		branch: `qorpera/coding/${workerId}`,
		baseSha: "a".repeat(40),
		harnessSessionRef: null,
		title: "Fix the delay after send",
		goal: "Build it",
		definitionOfDone: "Tests pass",
		context: "Bounded parent context",
		followUp: null,
		pullRequest: null,
		submission: null as unknown,
	};
	const call = vi.fn<CloudCodingNativeControl["call"]>(async (method, args) => {
		if (method === "qorpera_authorize_coding_turn") return { ...authority, coding };
		if (method === "qorpera_submit_coding_turn") {
			const input = args.p_submission as Record<string, unknown>;
			coding.submission = {
				schema: "qorpera.coding-submission/v1",
				workerId,
				sequence: 1,
				kind: input.kind,
				state: "submitted",
				summary: input.summary,
				headSha: input.headSha ?? null,
				question: input.question ?? null,
				options: input.options ?? [],
				operationKey: input.operationKey,
			};
			return coding.submission;
		}
		if (method === "qorpera_begin_native_coding_execution")
			return {
				schema: "qorpera.native-company-execution-start/v1",
				runId: binding.runId,
				jobId: binding.jobId,
				leaseId: binding.leaseId,
				binarySha256: args.p_binary_sha256,
				runtimeBundleSha256: authority.identity.runtimeBundleSha256,
				reasoningEffort: authority.identity.reasoningEffort,
				reasoningPolicySha256: authority.identity.reasoningPolicySha256,
				toolCatalogSha256: createHash("sha256").update(String(args.p_tool_catalog_text)).digest("hex"),
				contextSha256: args.p_context_sha256,
				contextBytes: args.p_context_bytes,
			};
		throw new Error("Unexpected call");
	});
	const control = {
		call,
		describeToolAuthority: vi.fn().mockResolvedValue(authority),
		beginToolOperation: vi.fn(),
		completeToolOperation: vi.fn(),
	};
	const gateway: CloudCodingCommandGateway = {
		authorize: vi.fn().mockResolvedValue(undefined),
		start: vi.fn(),
		read: vi.fn(),
		cancel: vi.fn(),
	};
	const gatewayFactory = vi.fn(() => gateway);
	const runtime = new CloudNativeCodingRuntime({
		control,
		gateway: gatewayFactory,
		command: ["/pinned/codex"],
		binarySha256: CLOUD_RUNTIME_NATIVE_BINARY_SHA256,
	});
	const request: NativeCompanyExecutionRequest = {
		runtime: "company-path-v1",
		authority: {
			...binding,
			encryptedCapsuleReference: "opaque",
			attestationPolicySha256: "a".repeat(64),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
		job: {
			jobId: binding.jobId,
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: { schema: "qorpera.wake-run/v1", occurrenceId: randomUUID() },
		},
	};
	const wake = {
		kind: "agent",
		source: { kind: "worker-dispatch", id: workerId },
		payload: {
			schema: "qorpera.worker-dispatch/v1",
			species: "coding",
			workerId,
			sequence: 1,
			coding: { harness: "codex" },
		},
	} as unknown as CloudWakeEnvelope;
	const turn: CloudNativeCodingTurnContext = { binding, identity: authority.identity, wake };
	const context: CloudToolContext = {
		companyId: authority.identity.companyId,
		runId: binding.runId,
		identity: authority.identity,
		callId: "finish",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
	return {
		binding,
		authority,
		coding,
		call,
		control,
		gateway,
		gatewayFactory,
		runtime,
		request,
		turn,
		context,
		scope: { workerId, vmId, requestId: turnId, turn: 1 },
	};
}

describe("the coding composition of a native turn", () => {
	it("aborts a streaming native session when the session lease is revoked between tools", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let activeRun: CloudNativeToolRun | undefined;
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			activeRun = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal);
			const original = f.call.getMockImplementation()!;
			f.call.mockImplementation((method, args, signal) =>
				method === "qorpera_authorize_coding_turn"
					? Promise.reject(new Error("Coding session lease expired"))
					: original(method, args, signal),
			);
			await new Promise<void>((resolve) =>
				activeRun!.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("native session stopped");
		});
		const execution = f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		const outcome = expect(execution).rejects.toThrow("native session stopped");
		await vi.advanceTimersByTimeAsync(10001);
		await outcome;
		expect(activeRun?.signal.aborted).toBe(true);
		expect(f.control.describeToolAuthority).not.toHaveBeenCalled();
	});
	it("uses the three command tools and two ways to end the turn, a durable submission and no human delivery", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				expect(adapters.tools.map((tool) => tool.name)).toEqual([
					"coding_run_command",
					"coding_read_command",
					"coding_cancel_command",
					"coding_finish",
					"coding_ask",
				]);
				expect(options.prompt).toContain("Bounded parent context");
				expect(options.prompt).toContain("Fix the delay after send");
				expect(options.prompt).not.toContain(f.binding.credentialCapsuleId);
				expect(options.runtimeInstructions).toContain("coding_ask");
				await options.beginExecution(
					{
						type: "namespace",
						name: "qorpera",
						tools: adapters.tools.map((tool) => ({
							type: "function",
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
					options.signal,
				);
				await adapters.assertContext(options.signal);
				const finish = adapters.tools[3];
				const input = {
					operationKey: "done",
					summary: "Changes committed; checks passed",
					headSha: "b".repeat(40),
				};
				expect(await finish.execute(finish.parseArguments(input), f.context)).toEqual({
					kind: "text",
					value: cloudToolJsonText(f.coding.submission),
				});
				await adapters.assertContext(options.signal);
				// After the submission nothing else may run in the VM.
				await expect(
					adapters.tools[0].execute({ operationKey: "later", command: "true", timeoutMs: 1000 }, f.context),
				).rejects.toThrow("already submitted");
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		expect(await f.runtime.execute(f.request, "/private/native-identity", f.context.signal, f.turn)).toEqual({
			providerSessionId: "native-thread",
			delivery: { messageCount: 0, finalMessageId: null },
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_submit_coding_turn",
			expect.objectContaining({
				p_binding: f.binding,
				p_submission: {
					kind: "finish",
					operationKey: "done",
					summary: "Changes committed; checks passed",
					headSha: "b".repeat(40),
				},
			}),
			expect.any(AbortSignal),
		);
		expect(f.gatewayFactory).toHaveBeenCalledWith(f.binding);
	});
	it("records any number of model requests in a coding turn (runtime v92; it was 256)", async () => {
		const f = fixture();
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_record_coding_context_view"
				? {
						schema: "qorpera.native-context-view-receipt/v1",
						viewId: randomUUID(),
						requestId: (args.p_view as { requestId: string }).requestId,
						sha256: "c".repeat(64),
						ordinal: 300,
					}
				: original(method, args, signal),
		);
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				await adapters.recordContextView(
					{
						schema: "qorpera.native-result-fence/v1",
						requestId: "request-300",
						threadId: "thread",
						turnId: "turn",
						purpose: "turn",
						outputs: [],
					},
					[],
					options.signal,
				);
				throw new Error("request 300 recorded");
			} finally {
				run.close();
			}
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"request 300 recorded",
		);
	});
	it("a question ends the turn the same way, with its choices", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				const ask = adapters.tools[4];
				const parsed = ask.parseArguments({
					operationKey: "poll",
					summary: "Composer fixed; the poll interval is your call.",
					question: "Keep 250 ms, or raise to 500 ms?",
					options: ["Keep 250 ms", "Raise to 500 ms"],
				});
				const receipt = JSON.parse((await ask.execute(parsed, f.context)).value as string);
				expect(receipt).toMatchObject({
					kind: "ask",
					question: "Keep 250 ms, or raise to 500 ms?",
					options: ["Keep 250 ms", "Raise to 500 ms"],
				});
				expect(() =>
					ask.parseArguments({
						operationKey: "poll",
						summary: "s",
						question: "q",
						options: ["a", "b", "c", "d", "e", "f", "g"],
					}),
				).toThrow();
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_submit_coding_turn",
			expect.objectContaining({ p_submission: expect.objectContaining({ kind: "ask" }) }),
			expect.any(AbortSignal),
		);
	});
	it("does not run an ordinary wake through the coding composition", async () => {
		const f = fixture();
		const wake = {
			...(f.turn.wake as object),
			payload: { schema: "qorpera.worker-dispatch/v1", species: "in-house" },
		} as unknown as CloudWakeEnvelope;
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, { ...f.turn, wake })).rejects.toThrow(
			"requires a coding worker-dispatch wake",
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("requires no conversation recipient on the admitted native run", async () => {
		const f = fixture();
		f.authority.identity.sessionId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow("scope differs");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("refuses another worker's scope before launching the harness", async () => {
		const f = fixture();
		f.coding.workerId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow("scope differs");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("leaves an already-submitted turn to the executor instead of generating again", async () => {
		const f = fixture();
		f.coding.submission = { kind: "finish", headSha: "a".repeat(40) };
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"already submitted",
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("does not claim completion when the harness ends without a submission", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockResolvedValue({
			providerSessionId: "native-thread",
			toolCalls: 0,
			codexVersion: "pinned",
			fencedRequests: 1,
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"without a submission",
		);
	});
});
