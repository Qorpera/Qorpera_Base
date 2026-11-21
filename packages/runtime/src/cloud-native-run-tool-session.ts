import type { JsonValue } from "@qorpera/contracts";
import { CloudActionReviewChannel, type CloudActionReviewer } from "./cloud-action-review.ts";
import { type CloudCodexHome, type CloudCodexHomeReview, cloudHomeActionReview } from "./cloud-codex-home.ts";
import {
	type CloudChatGptPlanAuth,
	type CloudCodexContextComposer,
	type CloudCodexLightAsk,
	type CloudCodexOpening,
	type CloudCodexToolSessionResult,
	runCloudCodexToolSession,
} from "./cloud-codex-tool-session.ts";
import {
	type GeminiToolSessionUsage,
	type GeminiUsageReceipt,
	runCloudGeminiToolSession,
} from "./cloud-gemini-tool-session.ts";
import type { CloudNativeCaptureImages } from "./cloud-native-capture-images.ts";
import { tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import type { CloudNativeFenceRequest } from "./cloud-native-result-fence.ts";
import {
	CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS,
	CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
	CLOUD_RUN_ROW_LONG_READ_MS,
	CLOUD_RUN_ROW_READ_MS,
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	CloudNativeToolRun,
	cloudToolRequest,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeActionReview,
	type CloudNativeFencedResult,
	type CloudNativeFolderReports,
	type CloudNativeTool,
	CloudNativeToolBoundary,
} from "./cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "./cloud-native-tool-operations.ts";
import type { CloudPictureChannel } from "./cloud-picture-channel.ts";
import { type CloudRunLog, CloudRunLogGone } from "./cloud-run-log.ts";
import { NATIVE_AUTHORITY_LEASE_SECONDS } from "./cloud-runner-broker.ts";
import { type CloudRuntimeObservability, cloudRuntimeErrorCategory } from "./cloud-runtime-observability.ts";
import type {
	CloudRuntimeGeminiEffort,
	CloudRuntimeGeminiModel,
	CloudRuntimeServiceTier,
} from "./cloud-runtime-policy.ts";
import type { CloudVoiceChannel } from "./cloud-voice-channel.ts";
import type { MemoryCompactChannel } from "./memory-tree/compact.ts";
import type { CloudRunStepLines } from "./memory-tree/step-lines.ts";

export interface CloudNativeRunToolAdapters {
	tools: readonly CloudNativeTool[];
	/** Tools among `tools` that the run opens through more_tools instead of its catalog (T3-6, cloudToolsOnDemand). */
	deferred?: ReadonlySet<string>;
	captures?: CloudNativeCaptureImages;
	/** The run's desktop folder reports (F3 4f-2b): its tool results show them. */
	folderReports?: CloudNativeFolderReports;
	/** Revalidate the context's path/audience read set, not only run admission. `timeoutMs` is the caller's
	 * budget for the read, all the way to the transport. */
	assertContext: (signal: AbortSignal, timeoutMs?: number) => Promise<void>;
	/**
	 * `assertContext` and run admission in one database call (qorpera_check_native_run): returns the run's authority as
	 * that call read it, or undefined when the database does not have the call yet.
	 */
	checkRun?: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>;
	recordContextView: (
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<void>;
	/**
	 * One database call that makes every check before a model request and records the
	 * view (qorpera_fence_native_context): returns the run's authority as that call read
	 * it, or undefined when the database does not have the call yet.
	 */
	fenceContextView?: (
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<unknown>;
	/** Release exact resource leases after generation and tool admission have stopped. */
	close?: (signal: AbortSignal) => Promise<void>;
	/**
	 * The run's work log and its step lines (RUNTIME-AGENT-MEMORY-TREE.md §4.5, §7.5): the boundary steps every call
	 * into the log. At closing the log commits its last steps, then the lines build what is left (§7.1). A log whose
	 * folder was deleted ends the run with that error (§4.5).
	 */
	runLog?: { readonly log: CloudRunLog; readonly lines: Pick<CloudRunStepLines, "finish"> };
}

/**
 * Experimental native-host entrypoint. Uses the cloud's admitted identity and
 * current authority; never accepts a Company File mount or provider override.
 * Production selection additionally requires the Company File and containment acceptance gates.
 */
export async function runCloudNativeRunToolSession(options: {
	binding: CloudNativeToolBinding;
	/** The run's admitted tier, from its company context; absent runs at standard speed. */
	serviceTier?: CloudRuntimeServiceTier;
	controlPlane: CloudNativeToolAuthorityReader & CloudNativeToolOperationControlPlane;
	/** Durable cloud admission, once per run. A lost response must not be retried. */
	beginExecution: (specification: JsonValue, signal: AbortSignal) => Promise<void>;
	/** Trusted cloud adapters only. No tool gets the control-plane client or runner credentials as arguments. */
	tools: (
		identity: CloudNativeToolIdentity,
		operations: CloudNativeToolOperations,
		run: CloudNativeToolRun,
	) => CloudNativeRunToolAdapters | Promise<CloudNativeRunToolAdapters>;
	command: readonly [string, ...string[]];
	binarySha256: string;
	prompt?: string;
	runtimeInstructions?: string;
	/** Composes each model request's input; absent sends it as Codex built it (cloudNativeContextIdentity). */
	composeContext?: CloudCodexContextComposer;
	/** The run's opening (RUNTIME-AGENT-MEMORY-TREE.md §5.4): after the admission and before the agent's thread, it
	 * gives the agent's input in place of prompt, runtimeInstructions and composeContext. */
	opening?: (signal: AbortSignal) => Promise<CloudCodexOpening>;
	/** The memory compactor and closing (§7.1), as runCloudCodexToolSession takes them. */
	compactor?: MemoryCompactChannel;
	/** A voice call's lane, as runCloudCodexToolSession takes it. */
	voice?: CloudVoiceChannel;
	/** The picture lane, as runCloudCodexToolSession takes it. */
	pictures?: CloudPictureChannel;
	closing?: (signal: AbortSignal) => Promise<void>;
	/** What the agent is told in one more turn when its turn left undone what the run has to end with, as
	 * runCloudCodexToolSession takes it. */
	turnCorrection?: (signal: AbortSignal) => Promise<string | undefined>;
	/** A light ask's run, as runCloudCodexToolSession takes it: in place of the agent's thread. */
	light?: (ask: CloudCodexLightAsk, signal: AbortSignal) => Promise<void>;
	identityRoot?: string;
	/** Warm conversations: the identity root was kept from an earlier run on this host. */
	reusedIdentityRoot?: boolean;
	isolation?: NativeIsolationConfiguration;
	/**
	 * The agent's home (lanes/agent-box-20261113, slice 1), for a run whose company has the switch on: the channel
	 * from this run's sealed slot to its own machine, where Codex's own shell and file tools run. It is given the
	 * run's review (slice 4) and its work log (slice 2) here, where both are built. Absent: the run is as today.
	 */
	home?: (input: {
		readonly review: CloudCodexHomeReview;
		readonly log: CloudRunLog | undefined;
		readonly signal: AbortSignal;
	}) => CloudCodexHome | undefined;
	/** How a ChatGPT plan run's Codex gets the plan's token (the host's setting). */
	chatGptPlanAuth?: CloudChatGptPlanAuth;
	signal: AbortSignal;
	timeoutMs?: number;
	observability?: CloudRuntimeObservability;
	/** Auto-review (v130): the review step for acting calls, given the reviewer this run's Codex session answers. */
	actionReview?: (reviewer: CloudActionReviewer) => CloudNativeActionReview;
	gemini?: {
		readonly model: CloudRuntimeGeminiModel;
		readonly effort: CloudRuntimeGeminiEffort;
		readonly apiKey: string;
		readonly apiBaseUrl?: string;
		readonly allowLoopback?: boolean;
		readonly fetch?: typeof fetch;
		readonly initialSpendMicrodollars: number;
		readonly monthlyCapCents: number | null;
		readonly onUsage?: (
			usage: GeminiToolSessionUsage,
			signal: AbortSignal,
		) => Promise<GeminiUsageReceipt | undefined>;
	};
}): Promise<CloudCodexToolSessionResult> {
	const admission = options.observability?.start("run_authority");
	let run: CloudNativeToolRun;
	try {
		// A short control-plane outage does not close the run (WB-001, 28 Oct 2026): it holds for the native lease's
		// length. The run's worker renews that lease and stops the run when the lease ends.
		run = await CloudNativeToolRun.open(
			options.binding,
			options.controlPlane,
			options.signal,
			NATIVE_AUTHORITY_LEASE_SECONDS * 1000,
		);
		admission?.finish("succeeded");
	} catch (error) {
		admission?.finish("denied", {
			errorCategory: options.signal.aborted
				? cloudRuntimeErrorCategory(error, options.signal)
				: "authority_unavailable",
		});
		throw error;
	}
	let boundary: CloudNativeToolBoundary | undefined;
	let home: CloudCodexHome | undefined;
	let adapters: CloudNativeRunToolAdapters | undefined;
	let executionFailed = false;
	let closingStarted = false;
	let cleanupError: Error | undefined;
	let result: Awaited<ReturnType<typeof runCloudCodexToolSession>>;
	try {
		const activeAdapters = await options.tools(
			run.identity,
			new CloudNativeToolOperations(run, options.controlPlane),
			run,
		);
		adapters = activeAdapters;
		const assertActive = async (signal: AbortSignal): Promise<void> => {
			const observation = options.observability?.start("context_authority");
			try {
				// Two reads, both required, one after the other (R1, 28 Oct 2026): the run's admission, then its context
				// read set. The context read takes the run's budget row (the run mutex), and each attempt waits as long
				// as the database may run it, so a cut one has ended before the next is sent; the admission reads plain
				// (20260930487000). Each is asked again while its answer is lost or late, until the run's authority
				// would lapse; a refusal stops the run. Both go in one call when the database has it (20260930618000):
				// the same two reads, the read set first so the run's row comes before a wake run's connection, one round
				// trip instead of two (7 Nov 2026).
				const { checkRun } = activeAdapters;
				if (
					!checkRun ||
					!(await run.assertActiveWith(
						(requestSignal) => checkRun(requestSignal, CLOUD_RUN_ROW_READ_MS),
						signal,
						CLOUD_RUN_ROW_READ_MS,
						CLOUD_RUN_ROW_READ_MS,
					))
				) {
					await run.assertActive(signal, CLOUD_PAIRED_REQUEST_TIMEOUT_MS);
					await run.retry(
						(requestSignal) => activeAdapters.assertContext(requestSignal, CLOUD_RUN_ROW_READ_MS),
						signal,
						CLOUD_RUN_ROW_READ_MS,
						CLOUD_RUN_ROW_READ_MS,
					);
				}
				observation?.finish("succeeded");
			} catch (error) {
				observation?.finish("denied", {
					errorCategory: signal.aborted ? cloudRuntimeErrorCategory(error, signal) : "authority_unavailable",
				});
				run.close();
				throw new Error("Cloud context authority unavailable");
			}
		};
		let fenceUnavailable = false;
		/** One round trip before a model request: false when the database lacks the call. */
		const fenceContext = async (
			fence: NonNullable<CloudNativeRunToolAdapters["fenceContextView"]>,
			frame: CloudNativeFenceRequest,
			outputs: readonly CloudNativeFencedResult[],
			signal: AbortSignal,
		): Promise<boolean> => {
			const observation = options.observability?.start("context_authority");
			try {
				// Through the run's own check: refused before sending once the run is closed or its
				// authority lapsed, cancelled if the run closes meanwhile, and the authority it read
				// is held to what assertActive holds its own read to. A lost or late answer is asked again
				// for as long as the run's authority holds, which its refresh keeps renewing meanwhile (the call replays
				// its view by request id): a slow database is not a stopped run (5 Oct 2026).
				if (
					!(await run.assertActiveWith(
						(requestSignal) => fence(frame, outputs, requestSignal),
						signal,
						CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS,
						CLOUD_RUN_ROW_LONG_READ_MS,
					))
				) {
					observation?.finish("failed", { errorCategory: "unavailable_tool" });
					return false;
				}
				observation?.finish("succeeded");
				return true;
			} catch (error) {
				// A timeout may follow a committed view; nothing was released either way, and the run stops.
				observation?.finish("denied", {
					errorCategory: signal.aborted ? cloudRuntimeErrorCategory(error, signal) : "authority_unavailable",
				});
				run.close();
				throw new Error("Cloud context authority unavailable");
			}
		};
		await assertActive(run.signal);
		const reviewer = options.actionReview ? new CloudActionReviewChannel() : undefined;
		// The run's home, if its company has one: every command and change on it is reviewed by the same gate as a
		// machine command (slice 4), and what it did becomes the run's own steps (slice 2).
		const review = reviewer && options.actionReview ? options.actionReview(reviewer) : undefined;
		home = options.home?.({
			review: cloudHomeActionReview(review),
			log: adapters.runLog?.log,
			signal: run.signal,
		});
		boundary = new CloudNativeToolBoundary({
			observability: options.observability,
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: adapters.tools,
			...(adapters.deferred ? { deferred: adapters.deferred } : {}),
			captures: adapters.captures,
			...(adapters.folderReports ? { folderReports: adapters.folderReports } : {}),
			assertActive,
			signal: run.signal,
			...(review ? { review } : {}),
			...(adapters.runLog ? { runLog: adapters.runLog.log } : {}),
			...(home ? { home } : {}),
		});
		const runLog = adapters.runLog;
		const beforeModelStart = async (startSignal: AbortSignal) => {
			await assertActive(startSignal);
			await cloudToolRequest(
				(requestSignal) => options.beginExecution(boundary!.specification, requestSignal),
				startSignal,
				CLOUD_RUN_ROW_READ_MS,
			);
			await assertActive(startSignal);
		};
		const recordContextView = async (
			frame: CloudNativeFenceRequest,
			outputs: readonly CloudNativeFencedResult[],
			recordSignal: AbortSignal,
		) => {
			if (activeAdapters.fenceContextView) {
				if (
					!fenceUnavailable &&
					(await fenceContext(activeAdapters.fenceContextView, frame, outputs, recordSignal))
				)
					return;
				fenceUnavailable = true;
				await assertActive(recordSignal);
			}
			await assertActive(recordSignal);
			await cloudToolRequest(
				(requestSignal) => activeAdapters.recordContextView(frame, outputs, requestSignal),
				recordSignal,
			);
			await assertActive(recordSignal);
		};
		const closing =
			runLog || options.closing
				? async (closeSignal: AbortSignal) => {
						closingStarted = true;
						try {
							if (runLog)
								try {
									await runLog.log.close(closeSignal);
								} finally {
									await runLog.lines.finish(closeSignal);
								}
						} finally {
							await options.closing?.(closeSignal);
						}
					}
				: undefined;
		if (options.gemini) {
			result = await runCloudGeminiToolSession({
				boundary,
				model: options.gemini.model,
				effort: options.gemini.effort,
				apiKey: options.gemini.apiKey,
				...(options.gemini.apiBaseUrl ? { apiBaseUrl: options.gemini.apiBaseUrl } : {}),
				...(options.gemini.allowLoopback ? { allowLoopback: true } : {}),
				...(options.gemini.fetch ? { fetch: options.gemini.fetch } : {}),
				initialSpendMicrodollars: options.gemini.initialSpendMicrodollars,
				monthlyCapCents: options.gemini.monthlyCapCents,
				...(options.gemini.onUsage ? { onUsage: options.gemini.onUsage } : {}),
				prompt: options.prompt,
				runtimeInstructions: options.runtimeInstructions,
				...(options.opening ? { opening: options.opening } : {}),
				...(options.turnCorrection ? { turnCorrection: options.turnCorrection } : {}),
				...(closing ? { closing } : {}),
				...(reviewer ? { reviewer } : {}),
				beforeModelStart,
				...(activeAdapters.fenceContextView ? { recordChecksAuthority: true } : {}),
				recordContextView,
				observability: options.observability,
				signal: run.signal,
				timeoutMs: options.timeoutMs,
			});
		} else {
			result = await runCloudCodexToolSession({
				observability: options.observability,
				command: options.command,
				binarySha256: options.binarySha256,
				boundary,
				model: run.identity.model,
				reasoningEffort: run.identity.reasoningEffort,
				serviceTier: options.serviceTier,
				prompt: options.prompt,
				runtimeInstructions: options.runtimeInstructions,
				...(options.composeContext ? { composeContext: options.composeContext } : {}),
				...(options.opening ? { opening: options.opening } : {}),
				...(options.compactor ? { compactor: options.compactor } : {}),
				...(options.voice ? { voice: options.voice } : {}),
				...(options.pictures ? { pictures: options.pictures } : {}),
				...(options.turnCorrection ? { turnCorrection: options.turnCorrection } : {}),
				...(options.light ? { light: options.light } : {}),
				...(closing ? { closing } : {}),
				...(home ? { home } : {}),
				identityRoot: options.identityRoot,
				...(options.reusedIdentityRoot ? { reusedIdentityRoot: true } : {}),
				isolation: options.isolation,
				...(options.chatGptPlanAuth ? { chatGptPlanAuth: options.chatGptPlanAuth } : {}),
				signal: run.signal,
				timeoutMs: options.timeoutMs,
				...(reviewer ? { reviewer } : {}),
				beforeModelStart,
				...(activeAdapters.fenceContextView ? { recordChecksAuthority: true } : {}),
				recordContextView,
			});
		}
		// The log's folder was deleted: the run's acting calls since could not run, and it ends with that error (§4.5). A
		// usage limit the provider met after the run's answer stays the login's to record (the 2026-11-13 amendment).
		if (runLog?.log.gone)
			throw tagNativeRuntimeFailure(
				new CloudRunLogGone(),
				"codex-turn-completion",
				"authority_unavailable",
				result.usageSignal ?? null,
			);
	} catch (error) {
		executionFailed = true;
		throw error;
	} finally {
		boundary?.close();
		// The home's socket and its session go with the run, whatever ended it (review round 1, F10).
		if (home) await home.close(run.signal.aborted ? "stopped" : "ended").catch(() => undefined);
		// A run that failed on its own commits the steps it finished, as closing would have, within 10 s: a timed batch
		// still running stops then too. A stopped run does not: its authority is gone, and a later attempt may already be
		// writing the log.
		if (executionFailed && !closingStarted && !run.signal.aborted && adapters?.runLog)
			await adapters.runLog.log.close(AbortSignal.timeout(10_000)).catch(() => undefined);
		run.close();
		if (adapters?.close) {
			try {
				await cloudToolRequest(adapters.close, AbortSignal.timeout(10_000));
			} catch {
				// Keep the original execution failure, but never report success with unknown cleanup.
				if (!executionFailed) cleanupError = new Error("Native resource cleanup was not confirmed");
				else console.error("Native resource cleanup was not confirmed after execution failed");
			}
		}
	}
	// A usage limit the provider met after the run's answer stays the login's to record, also when cleanup failed after
	// it (the 2026-11-13 amendment).
	if (cleanupError)
		throw result?.usageSignal
			? tagNativeRuntimeFailure(cleanupError, "native-tools", "unknown", result.usageSignal)
			: cleanupError;
	return result;
}
