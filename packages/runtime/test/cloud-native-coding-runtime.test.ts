import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCodingCommandGateway } from "../src/cloud-coding-command-tools.ts";
import {
	type CloudCodingNativeControl,
	CloudNativeCodingRuntime,
	type CloudNativeCodingTurnContext,
	parseCloudCodingTurnContext,
} from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "../src/cloud-native-run-tool-session.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { type CloudToolContext, cloudToolJsonText } from "../src/cloud-native-tool-boundary.ts";
import { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "../src/cloud-runtime-observability.ts";
import type { CloudWakeEnvelope } from "../src/cloud-wake-bus.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

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
	// What qorpera_read_coding_turn_context says started this turn and what came before it.
	const turnContext = {
		input: { from: "dispatch", text: null, answers: null } as Record<string, unknown>,
		earlierTurns: [] as unknown[],
		omittedEarlierTurns: 0,
		commands: { running: [], stopped: [], omitted: 0 } as Record<string, unknown>,
	};
	const call = vi.fn<CloudCodingNativeControl["call"]>(async (method, args) => {
		if (method === "qorpera_authorize_coding_turn") return { ...authority, coding };
		if (method === "qorpera_read_coding_turn_context")
			return {
				schema: "qorpera.coding-turn-context/v2",
				workerId: coding.workerId,
				sequence: coding.sequence,
				...turnContext,
			};
		if (method === "qorpera_submit_coding_turn") {
			const input = args.p_submission as Record<string, unknown>;
			coding.submission = {
				schema: "qorpera.coding-submission/v1",
				workerId,
				sequence: coding.sequence,
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
		turnContext,
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
				// The turn check before the submission is its own child observation.
				const rows: CloudRuntimeObservation[] = [];
				const observability = new CloudRuntimeObservability({
					assignmentId: f.binding.assignmentId,
					publish: async (batch) => {
						rows.push(...structuredClone(batch));
					},
				});
				const span = observability.start("coding_finish");
				// The model gets the receipt without the summary it wrote; the turn row keeps it.
				expect(await finish.execute(finish.parseArguments(input), { ...f.context, observation: span })).toEqual({
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.coding-submission/v1",
						workerId: f.coding.workerId,
						sequence: 1,
						kind: "finish",
						state: "submitted",
						headSha: "b".repeat(40),
						operationKey: "done",
					}),
				});
				expect(f.coding.submission).toMatchObject({ kind: "finish", summary: "Changes committed; checks passed" });
				span.finish("succeeded");
				await observability.close();
				expect(
					rows
						.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
						.map((row) => [row.operation, row.status]),
				).toEqual([["context_authority", "succeeded"]]);
				await adapters.assertContext(options.signal);
				// After the submission nothing else may run in the VM.
				await expect(
					adapters.tools[0].execute({ operationKey: "later", command: "true", timeoutMs: 1000 }, f.context),
				).rejects.toThrow("CODING_COMMAND_AFTER_SUBMISSION");
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
				// The question and its choices reach the turn row; the model's receipt holds none of the words.
				expect(f.coding.submission).toMatchObject({
					kind: "ask",
					summary: "Composer fixed; the poll interval is your call.",
					question: "Keep 250 ms, or raise to 500 ms?",
					options: ["Keep 250 ms", "Raise to 500 ms"],
				});
				expect(receipt).toEqual({
					schema: "qorpera.coding-submission/v1",
					workerId: f.coding.workerId,
					sequence: 1,
					kind: "ask",
					state: "submitted",
					headSha: null,
					operationKey: "poll",
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
			/^CODING_TURN_WAKE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("requires no conversation recipient on the admitted native run", async () => {
		const f = fixture();
		f.authority.identity.sessionId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_SCOPE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("refuses another worker's scope before launching the harness", async () => {
		const f = fixture();
		f.coding.workerId = randomUUID();
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_SCOPE_DIFFERS$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("names a timed-out turn check as a timeout, not a refusal, and submits nothing", async () => {
		const f = fixture();
		const rows: CloudRuntimeObservation[] = [];
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
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
				// The coding control's own request deadline (AbortSignal.timeout) ran out.
				const original = f.call.getMockImplementation()!;
				f.call.mockImplementation((method, args, signal) =>
					method === "qorpera_authorize_coding_turn"
						? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
						: original(method, args, signal),
				);
				const observability = new CloudRuntimeObservability({
					assignmentId: f.binding.assignmentId,
					publish: async (batch) => {
						rows.push(...structuredClone(batch));
					},
				});
				const span = observability.start("coding_finish");
				const finish = adapters.tools[3];
				const input = { operationKey: "done", summary: "Changes committed", headSha: "b".repeat(40) };
				await expect(
					finish.execute(finish.parseArguments(input), { ...f.context, observation: span }),
				).rejects.toThrow();
				span.finish("failed");
				await observability.close();
				expect(
					rows
						.filter((row) => row.parentAttemptId === span.attemptId && row.phase === "finish")
						.map((row) => [row.operation, row.status, row.errorCategory]),
				).toEqual([["context_authority", "unconfirmed", "timeout"]]);
				throw new Error("session checked");
			} finally {
				run.close();
			}
		});
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			"session checked",
		);
		expect(f.call).not.toHaveBeenCalledWith("qorpera_submit_coding_turn", expect.anything(), expect.anything());
	});
	it("leaves an already-submitted turn to the executor instead of generating again", async () => {
		const f = fixture();
		f.coding.submission = { kind: "finish", headSha: "a".repeat(40) };
		await expect(f.runtime.execute(f.request, "/private", f.context.signal, f.turn)).rejects.toThrow(
			/^CODING_TURN_ALREADY_SUBMITTED$/,
		);
		expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
	});
	it("a one-letter answer is read against the exact question and choices of the turn before", async () => {
		const f = fixture();
		// The kernel side of two turns, as qorpera_read_coding_turn_context returns them: the
		// submission of turn 1 is what the harness really submitted through coding_ask.
		const question = "Should I use approach A or B?";
		const choices = ["A: keep the in-memory cache", "B: drop the cache and read through"];
		const prompts: Record<string, unknown>[] = [];
		const decisions: string[] = [];
		// A stand-in model that can only act on its prompt: turn 1 asks, turn 2 acts on the answer.
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			const run = await CloudNativeToolRun.open(f.binding, f.control, options.signal);
			try {
				const adapters = await options.tools(
					f.authority.identity,
					new CloudNativeToolOperations(run, f.control),
					run,
				);
				const context = JSON.parse(options.prompt ?? "") as Record<string, unknown>;
				prompts.push(context);
				const [, , , finish, ask] = adapters.tools;
				const current = context.input as { text: string | null; answers: { options: string[] } | null } | undefined;
				if (!current?.answers) {
					await ask.execute(
						ask.parseArguments({
							operationKey: "approach",
							summary: "Two ways to go.",
							question,
							options: choices,
						}),
						f.context,
					);
				} else {
					const chosen = current.answers.options.find((option) => option.startsWith(`${current.text}:`));
					if (!chosen) throw new Error("The answer does not name a choice");
					decisions.push(chosen);
					await finish.execute(
						finish.parseArguments({
							operationKey: "done",
							summary: `Went with ${chosen}.`,
							headSha: "c".repeat(40),
						}),
						f.context,
					);
				}
				return { providerSessionId: "native-thread", toolCalls: 1, codexVersion: "pinned", fencedRequests: 1 };
			} finally {
				run.close();
			}
		});
		await f.runtime.execute(f.request, "/private", f.context.signal, f.turn);
		const asked = f.coding.submission as Record<string, unknown>;
		expect(asked).toMatchObject({ kind: "ask", question, options: choices });

		// The executor reported the question; the owner answered "B"; the kernel opened turn 2.
		f.turnContext.earlierTurns.push({
			sequence: 1,
			input: { from: "dispatch", text: null },
			submitted: { kind: "ask", summary: asked.summary, question, options: choices, headSha: null },
			outcome: {
				state: "blocked",
				summary: asked.summary,
				reason: null,
				needs: question,
				options: choices,
				pullRequest: null,
			},
		});
		f.turnContext.input = { from: "member", text: "B", answers: { question, options: choices } };
		Object.assign(f.coding, { sequence: 2, turnId: randomUUID(), followUp: "B", submission: null });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 2;
		await f.runtime.execute(f.request, "/private", f.context.signal, {
			...f.turn,
			wake: wake as unknown as CloudWakeEnvelope,
		});

		expect(prompts[1]).toMatchObject({
			schema: "qorpera.coding-context/v2",
			sequence: 2,
			input: { from: "member", text: "B", answers: { question, options: choices } },
			earlierTurns: [{ sequence: 1, submitted: { kind: "ask", question, options: choices } }],
		});
		expect(decisions).toEqual(["B: drop the cache and read through"]);
		// A letter counts by position, and an undecided question is asked again rather than guessed.
		const instructions = vi.mocked(runCloudNativeRunToolSession).mock.calls[1][0].runtimeInstructions;
		expect(instructions).toContain("a single letter selects the choice at that position (A is the first)");
		expect(instructions).toContain("the only choice that starts with that letter");
		expect(instructions).toContain("a turn marked shortened had its long texts cut to fit");
		expect(instructions).toContain("When no reply decides it");
		expect(instructions).toContain("call coding_ask again");
		expect(instructions).toContain("MACHINE_STOPPED: the machine stopped from outside");
		expect(instructions).toContain("FOLDER_RESTART: the machine restarted because the company folder");
		expect(f.gateway.start).not.toHaveBeenCalled();
		expect(f.coding.submission).toMatchObject({
			kind: "finish",
			summary: "Went with B: drop the cache and read through.",
		});
	});
	it("refuses a turn context that belongs to another turn or claims a question it cannot hold", async () => {
		// Turn 2 answering turn 1's question; each case breaks one rule of it.
		const earlier = {
			sequence: 1,
			input: { from: "dispatch", text: null },
			submitted: { kind: "ask", summary: "Two ways.", question: "A or B?", options: ["A", "B"], headSha: null },
			outcome: {
				state: "blocked",
				summary: "Two ways.",
				reason: null,
				needs: "A or B?",
				options: ["A", "B"],
				pullRequest: null,
			},
		};
		const valid = {
			schema: "qorpera.coding-turn-context/v2",
			sequence: 2,
			input: { from: "member", text: "B", answers: { question: "A or B?", options: ["A", "B"] } },
			earlierTurns: [earlier],
			omittedEarlierTurns: 0,
			commands: { running: [], stopped: [], omitted: 0 },
		};
		const run = async (drift: Record<string, unknown>) => {
			const f = fixture();
			Object.assign(f.coding, { sequence: 2 });
			const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
			wake.payload.sequence = 2;
			const original = f.call.getMockImplementation()!;
			f.call.mockImplementation(async (method, args, signal) =>
				method === "qorpera_read_coding_turn_context"
					? { ...valid, workerId: f.coding.workerId, ...drift }
					: original(method, args, signal),
			);
			vi.mocked(runCloudNativeRunToolSession).mockReset();
			vi.mocked(runCloudNativeRunToolSession).mockResolvedValue({
				providerSessionId: "native-thread",
				toolCalls: 0,
				codexVersion: "pinned",
				fencedRequests: 1,
			});
			return f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			});
		};
		// The unbroken context is accepted: the turn runs and then ends without a submission.
		await expect(run({})).rejects.toThrow(/^CODING_TURN_ENDED_WITHOUT_SUBMISSION$/);
		for (const drift of [
			{ sequence: 3 },
			{ workerId: randomUUID() },
			{ omittedEarlierTurns: 1 },
			{ input: { from: "stranger", text: "B", answers: null } },
			{ input: { from: "dispatch", text: null, answers: null } },
			{ input: { from: "member", text: "", answers: null } },
			{ input: { from: "member", text: "B", answers: { question: "", options: [] } } },
			{
				input: {
					from: "member",
					text: "B",
					answers: { question: "A or B?", options: ["1", "2", "3", "4", "5", "6", "7"] },
				},
			},
			{ earlierTurns: [{ ...earlier, sequence: 2 }] },
			{ earlierTurns: [{ ...earlier, submitted: { ...earlier.submitted, kind: "finish", headSha: "short" } }] },
			{
				earlierTurns: [
					{
						...earlier,
						outcome: {
							...earlier.outcome,
							pullRequest: { url: "https://github.com/Other/repo/pull/1", number: 1, headSha: "c".repeat(40) },
						},
					},
				],
			},
		]) {
			await expect(run(drift)).rejects.toThrow(/^CODING_TURN_CONTEXT_INVALID$/);
			expect(runCloudNativeRunToolSession).not.toHaveBeenCalled();
		}
	});
	it("accepts the context the kernel really returns for a session stuck before the fix", () => {
		// Captured from qorpera_read_coding_turn_context by scripts/test-coding-turn-backfill.mjs, which C1c-3i removed with
		// the snapshot-v1 coding path; the sample stays as a shape the parser must keep accepting.
		const sample: unknown = JSON.parse(
			readFileSync(new URL("./fixtures/coding-turn-context-backfilled.json", import.meta.url), "utf8"),
		);
		const context = parseCloudCodingTurnContext(
			sample,
			{ workerId: "00000000-0000-4000-8000-000000000000", sequence: 4 },
			{ host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		);
		expect(context.input).toEqual({
			from: "member",
			text: "Yes, back off.",
			answers: { question: "Should the poll also back off after errors?", options: ["Yes", "No"] },
		});
		expect(
			context.earlierTurns.map((turn) => [turn.sequence, turn.submitted?.kind ?? null, turn.outcome?.state]),
		).toEqual([
			[1, null, "succeeded"],
			[2, null, "blocked"],
			[3, "ask", "failed"],
		]);
		expect(context.earlierTurns[1].outcome?.needs).toBe("Keep 250 ms, or raise to 500 ms?");
	});
	it("takes a command the machine's stop from outside or its restart for the folder ended, and refuses a reason it does not know", () => {
		const workerId = randomUUID(),
			repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } as const;
		const stopped = { commandId: randomUUID(), turn: 1, command: "npm run dev", reason: "MACHINE_STOPPED" };
		const context = (reason: string) => ({
			schema: "qorpera.coding-turn-context/v2",
			workerId,
			sequence: 2,
			input: { from: "agent", text: "Go on.", answers: null },
			earlierTurns: [],
			omittedEarlierTurns: 1,
			commands: { running: [], stopped: [{ ...stopped, reason }], omitted: 0 },
		});
		expect(
			parseCloudCodingTurnContext(context("MACHINE_STOPPED"), { workerId, sequence: 2 }, repository).commands,
		).toEqual({ running: [], stopped: [stopped], omitted: 0 });
		expect(
			parseCloudCodingTurnContext(context("FOLDER_RESTART"), { workerId, sequence: 2 }, repository).commands,
		).toEqual({ running: [], stopped: [{ ...stopped, reason: "FOLDER_RESTART" }], omitted: 0 });
		expect(() => parseCloudCodingTurnContext(context("UNPLUGGED"), { workerId, sequence: 2 }, repository)).toThrow(
			/^CODING_TURN_CONTEXT_INVALID$/,
		);
	});
	it("keeps the newest earlier turns when the whole history does not fit the prompt", async () => {
		const f = fixture();
		// Turn 43: the kernel already left turns 1-3 out of its answer; 4-42 still exceed the prompt.
		Object.assign(f.coding, { sequence: 43 });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 43;
		const long = "x".repeat(3900);
		f.turnContext.earlierTurns = Array.from({ length: 39 }, (_, index) => ({
			sequence: index + 4,
			input: { from: "member", text: long },
			submitted: null,
			outcome: { state: "failed", summary: long, reason: null, needs: null, options: [], pullRequest: null },
		}));
		f.turnContext.input = { from: "member", text: "Go on.", answers: null };
		f.turnContext.omittedEarlierTurns = 3;
		let prompt = "";
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			prompt = options.prompt ?? "";
			throw new Error("stop after composing");
		});
		await expect(
			f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			}),
		).rejects.toThrow("stop after composing");
		const context = JSON.parse(prompt) as { earlierTurns: { sequence: number }[]; omittedEarlierTurns: number };
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
		expect(context.earlierTurns.at(-1)?.sequence).toBe(42);
		expect(context.earlierTurns.length).toBeGreaterThan(0);
		expect(context.earlierTurns.length).toBeLessThan(39);
		expect(context.omittedEarlierTurns).toBe(3 + 39 - context.earlierTurns.length);
		expect(context.earlierTurns.map((turn) => turn.sequence)).toEqual(
			Array.from({ length: context.earlierTurns.length }, (_, index) => 43 - context.earlierTurns.length + index),
		);
	});
	it("keeps the previous turn, shortened, when it alone does not fit the prompt", async () => {
		const f = fixture();
		Object.assign(f.coding, { sequence: 3 });
		const wake = structuredClone(f.turn.wake) as unknown as { payload: { sequence: number } };
		wake.payload.sequence = 3;
		// Control characters escape to six bytes each: turn 2 alone is about 90 KB of prompt.
		const wide = "\u0001".repeat(4000);
		const question = `Keep the raw log?${"\u0001".repeat(900)}`;
		f.turnContext.earlierTurns = [
			{ sequence: 1, input: { from: "dispatch", text: null }, submitted: null, outcome: null },
			{
				sequence: 2,
				input: { from: "member", text: wide },
				submitted: { kind: "ask", summary: wide, question, options: ["Yes", "No"], headSha: null },
				outcome: {
					state: "blocked",
					summary: wide,
					reason: null,
					needs: question,
					options: ["Yes", "No"],
					pullRequest: null,
				},
			},
		];
		f.turnContext.input = { from: "member", text: "Yes", answers: { question, options: ["Yes", "No"] } };
		let prompt = "";
		vi.mocked(runCloudNativeRunToolSession).mockImplementation(async (options) => {
			prompt = options.prompt ?? "";
			throw new Error("stop after composing");
		});
		await expect(
			f.runtime.execute(f.request, "/private", f.context.signal, {
				...f.turn,
				wake: wake as unknown as CloudWakeEnvelope,
			}),
		).rejects.toThrow("stop after composing");
		const context = JSON.parse(prompt) as {
			earlierTurns: { sequence: number; shortened?: boolean; submitted: { question: string } }[];
			omittedEarlierTurns: number;
		};
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
		expect(context.earlierTurns.map((turn) => [turn.sequence, turn.shortened])).toEqual([[2, true]]);
		expect(context.earlierTurns[0].submitted.question.startsWith("Keep the raw log?")).toBe(true);
		expect(context.omittedEarlierTurns).toBe(1);
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
			/^CODING_TURN_ENDED_WITHOUT_SUBMISSION$/,
		);
	});
});
