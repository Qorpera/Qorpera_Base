import type { JsonValue } from "@qorpera/contracts";
import { CloudActionReviewChannel, type CloudActionReviewer } from "./cloud-action-review.ts";
import { type CloudChatGptPlanAuth, runCloudCodexToolSession } from "./cloud-codex-tool-session.ts";
import type { CloudNativeCaptureImages } from "./cloud-native-capture-images.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import type { CloudNativeFenceRequest } from "./cloud-native-result-fence.ts";
import {
	CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	CloudNativeToolRun,
	cloudToolRequest,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeActionReview,
	type CloudNativeFencedResult,
	type CloudNativeTool,
	CloudNativeToolBoundary,
} from "./cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "./cloud-native-tool-operations.ts";
import { type CloudRuntimeObservability, cloudRuntimeErrorCategory } from "./cloud-runtime-observability.ts";
import type { CloudRuntimeServiceTier } from "./cloud-runtime-policy.ts";

export interface CloudNativeRunToolAdapters {
	tools: readonly CloudNativeTool[];
	captures?: CloudNativeCaptureImages;
	/** Revalidate the context's path/audience read set, not only run admission. */
	assertContext: (signal: AbortSignal) => Promise<void>;
	recordContextView: (
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<void>;
	/** Release exact resource leases after generation and tool admission have stopped. */
	close?: (signal: AbortSignal) => Promise<void>;
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
	prompt: string;
	runtimeInstructions?: string;
	identityRoot?: string;
	/** Warm conversations: the identity root was kept from an earlier run on this host. */
	reusedIdentityRoot?: boolean;
	isolation?: NativeIsolationConfiguration;
	/** How a ChatGPT plan run's Codex gets the plan's token (the host's setting). */
	chatGptPlanAuth?: CloudChatGptPlanAuth;
	signal: AbortSignal;
	timeoutMs?: number;
	observability?: CloudRuntimeObservability;
	/** Auto-review (v130): the review step for acting calls, given the reviewer this run's Codex session answers. */
	actionReview?: (reviewer: CloudActionReviewer) => CloudNativeActionReview;
}): Promise<{ providerSessionId: string; toolCalls: number; codexVersion: string; fencedRequests: number }> {
	const admission = options.observability?.start("run_authority");
	let run: CloudNativeToolRun;
	try {
		run = await CloudNativeToolRun.open(options.binding, options.controlPlane, options.signal);
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
	let adapters: CloudNativeRunToolAdapters | undefined;
	let executionFailed = false;
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
				// Two independent reads, both required: the run's admission and its context read set.
				// Both lock the run's job row, so each gets the pair's budget, not one read's.
				const admission = run.assertActive(signal, CLOUD_PAIRED_REQUEST_TIMEOUT_MS);
				const context = cloudToolRequest(
					(requestSignal) => activeAdapters.assertContext(requestSignal),
					signal,
					CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
				);
				await Promise.all([admission, context]);
				observation?.finish("succeeded");
			} catch (error) {
				observation?.finish("denied", {
					errorCategory: signal.aborted ? cloudRuntimeErrorCategory(error, signal) : "authority_unavailable",
				});
				run.close();
				throw new Error("Cloud context authority unavailable");
			}
		};
		await assertActive(run.signal);
		const reviewer = options.actionReview ? new CloudActionReviewChannel() : undefined;
		boundary = new CloudNativeToolBoundary({
			observability: options.observability,
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: adapters.tools,
			captures: adapters.captures,
			assertActive,
			signal: run.signal,
			...(reviewer && options.actionReview ? { review: options.actionReview(reviewer) } : {}),
		});
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
			identityRoot: options.identityRoot,
			...(options.reusedIdentityRoot ? { reusedIdentityRoot: true } : {}),
			isolation: options.isolation,
			...(options.chatGptPlanAuth ? { chatGptPlanAuth: options.chatGptPlanAuth } : {}),
			signal: run.signal,
			timeoutMs: options.timeoutMs,
			...(reviewer ? { reviewer } : {}),
			beforeModelStart: async (signal) => {
				await assertActive(signal);
				await cloudToolRequest(
					(requestSignal) => options.beginExecution(boundary!.specification, requestSignal),
					signal,
				);
				await assertActive(signal);
			},
			recordContextView: async (frame, outputs, signal) => {
				await assertActive(signal);
				await cloudToolRequest(
					(requestSignal) => activeAdapters.recordContextView(frame, outputs, requestSignal),
					signal,
				);
				await assertActive(signal);
			},
		});
	} catch (error) {
		executionFailed = true;
		throw error;
	} finally {
		boundary?.close();
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
	if (cleanupError) throw cleanupError;
	return result;
}
