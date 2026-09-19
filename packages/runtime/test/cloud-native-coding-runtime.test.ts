import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import type { CloudCodingCommandGateway } from "../src/cloud-coding-command-tools.ts";
import { type CloudCodingNativeControl, CloudNativeCodingRuntime } from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "../src/cloud-native-run-tool-session.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { type CloudToolContext, cloudToolJsonText } from "../src/cloud-native-tool-boundary.ts";
import { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";

vi.mock("../src/cloud-native-run-tool-session.ts", () => ({ runCloudNativeRunToolSession: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

function fixture() {
	const { binding, authority: base } = nativeToolAuthorityFixture();
	const authority = { ...base, identity: { ...base.identity, sessionId: null as string | null } };
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
	const repository = { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" };
	const dispatch = {
		operationKey: "build",
		repository,
		goal: "Build it",
		definitionOfDone: "Tests pass",
		context: "Bounded parent context",
		sourceReadIds: [],
		todoPath: "projects/test/todo.json",
		cancellationPolicy: "retain-workspace",
		completionPolicy: "notify-parent",
		publication: "draft-pr",
	};
	const coding = {
		...scope,
		repository,
		branch: `qorpera/coding/${scope.workerId}`,
		parentRunId: randomUUID(),
		dispatch,
		goal: "Build it",
		finish: null as unknown,
	};
	const call = vi.fn<CloudCodingNativeControl["call"]>(async (method, args) => {
		if (method === "qorpera_authorize_native_coding_execution") return { ...authority, coding };
		if (method === "qorpera_finish_native_coding_execution") {
			const input = args.p_finish as { summary: string; headSha: string };
			coding.finish = {
				schema: "qorpera.coding-finish/v1",
				requestId: scope.requestId,
				workerId: scope.workerId,
				turn: scope.turn,
				state: "ready-to-publish",
				summary: input.summary,
				headSha: input.headSha,
			};
			return coding.finish;
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
	const runtime = new CloudNativeCodingRuntime({
		scope,
		control,
		gateway,
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
			payload: { schema: "qorpera.coding-run/v1", occurrenceId: randomUUID(), requestId: scope.requestId },
		},
	};
	const context: CloudToolContext = {
		companyId: authority.identity.companyId,
		runId: binding.runId,
		identity: authority.identity,
		callId: "finish",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
	return { binding, authority, scope, coding, call, control, gateway, runtime, request, context };
}

describe("native Codex coding composition", () => {
	it("aborts a streaming native session when the coding lease is revoked between tools", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let activeRun: CloudNativeToolRun | undefined;
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			activeRun = await CloudNativeToolRun.open(f.binding, options.controlPlane, options.signal);
			const original = f.call.getMockImplementation()!;
			f.call.mockImplementation((method, args, signal) =>
				method === "qorpera_authorize_native_coding_execution"
					? Promise.reject(new Error("cancelled"))
					: original(method, args, signal),
			);
			await new Promise<void>((resolve) =>
				activeRun!.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("native session stopped");
		});
		const execution = f.runtime.execute(f.request, "/private", f.context.signal);
		const outcome = expect(execution).rejects.toThrow("native session stopped");
		await vi.advanceTimersByTimeAsync(10001);
		await outcome;
		expect(activeRun?.signal.aborted).toBe(true);
		expect(f.control.describeToolAuthority).not.toHaveBeenCalled();
	});
	it("uses exactly four coding tools, durable submission and no human delivery", async () => {
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
				]);
				expect(options.prompt).toContain("Bounded parent context");
				expect(options.prompt).not.toContain(f.binding.credentialCapsuleId);
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
					headSha: "a".repeat(40),
				};
				expect(await finish.execute(finish.parseArguments(input), f.context)).toEqual({
					kind: "text",
					value: cloudToolJsonText(f.coding.finish),
				});
				await adapters.assertContext(options.signal);
				await expect(
					adapters.tools[0].execute({ operationKey: "later", command: "true", timeoutMs: 1000 }, f.context),
				).rejects.toThrow("already submitted");
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 2 };
			} finally {
				run.close();
			}
		});
		expect(await f.runtime.execute(f.request, "/private/native-identity", f.context.signal)).toEqual({
			providerSessionId: "native-thread",
			delivery: { messageCount: 0, finalMessageId: null },
		});
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_finish_native_coding_execution",
			expect.objectContaining({
				p_worker_id: f.scope.workerId,
				p_request_id: f.scope.requestId,
				p_binding: f.binding,
			}),
			expect.any(AbortSignal),
		);
	});
	it("does not run a normal company job through the coding composition", async () => {
		const f = fixture();
		f.request.job.payload = { schema: "qorpera.wake-run/v1", occurrenceId: randomUUID() };
		await expect(f.runtime.execute(f.request, "/private", f.context.signal)).rejects.toThrow("job differs");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("requires no conversation recipient on the admitted native run", async () => {
		const f = fixture();
		f.authority.identity.sessionId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal)).rejects.toThrow("scope differs");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("refuses another worker's cloud scope before launching Codex", async () => {
		const f = fixture();
		f.coding.workerId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal)).rejects.toThrow("scope differs");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("reconciles an already-submitted turn instead of generating again", async () => {
		const f = fixture();
		f.coding.finish = { headSha: "a".repeat(40) };
		await expect(f.runtime.execute(f.request, "/private", f.context.signal)).rejects.toThrow("reconcile publication");
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("does not claim completion when Codex ends without a submission", async () => {
		const f = fixture();
		vi.mocked(runCloudNativeRunToolSession).mockResolvedValue({
			providerSessionId: "native-thread",
			toolCalls: 0,
			codexVersion: "pinned",
			fencedRequests: 1,
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal)).rejects.toThrow(
			"without a durable submission",
		);
	});
});
