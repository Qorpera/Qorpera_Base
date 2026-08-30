import type { JsonValue } from "@qorpera/contracts";
import { runCloudCodexToolSession } from "./cloud-codex-tool-session.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import type { CloudNativeFenceRequest } from "./cloud-native-result-fence.ts";
import {
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	CloudNativeToolRun,
	cloudToolRequest,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeFencedResult,
	type CloudNativeTool,
	CloudNativeToolBoundary,
} from "./cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "./cloud-native-tool-operations.ts";

/**
 * Experimental native-host entrypoint. Uses the cloud's admitted identity and
 * current authority; never accepts a Company File mount or provider override.
 * Production selection additionally requires the Company File and containment acceptance gates.
 */
export async function runCloudNativeRunToolSession(options: {
	binding: CloudNativeToolBinding;
	controlPlane: CloudNativeToolAuthorityReader & CloudNativeToolOperationControlPlane;
	/** Durable cloud admission, once per run. A lost response must not be retried. */
	beginExecution: (specification: JsonValue, signal: AbortSignal) => Promise<void>;
	/** Trusted cloud adapters only. No tool gets the control-plane client or runner credentials as arguments. */
	tools: (
		identity: CloudNativeToolIdentity,
		operations: CloudNativeToolOperations,
	) => {
		tools: readonly CloudNativeTool[];
		/** Revalidate the context's path/audience read set, not only run admission. */
		assertContext: (signal: AbortSignal) => Promise<void>;
		recordContextView: (
			frame: CloudNativeFenceRequest,
			outputs: readonly CloudNativeFencedResult[],
			signal: AbortSignal,
		) => Promise<void>;
	};
	command: readonly [string, ...string[]];
	binarySha256: string;
	prompt: string;
	runtimeInstructions?: string;
	identityRoot?: string;
	isolation?: NativeIsolationConfiguration;
	signal: AbortSignal;
	timeoutMs?: number;
}): Promise<{ providerSessionId: string; toolCalls: number; codexVersion: string; fencedRequests: number }> {
	const run = await CloudNativeToolRun.open(options.binding, options.controlPlane, options.signal);
	let boundary: CloudNativeToolBoundary | undefined;
	try {
		const adapters = options.tools(run.identity, new CloudNativeToolOperations(run, options.controlPlane));
		const assertActive = async (signal: AbortSignal): Promise<void> => {
			try {
				await run.assertActive(signal);
				await cloudToolRequest((requestSignal) => adapters.assertContext(requestSignal), signal);
			} catch {
				run.close();
				throw new Error("Cloud context authority unavailable");
			}
		};
		await assertActive(run.signal);
		boundary = new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: adapters.tools,
			assertActive,
			signal: run.signal,
		});
		return await runCloudCodexToolSession({
			command: options.command,
			binarySha256: options.binarySha256,
			boundary,
			model: run.identity.model,
			reasoningEffort: run.identity.reasoningEffort,
			prompt: options.prompt,
			runtimeInstructions: options.runtimeInstructions,
			identityRoot: options.identityRoot,
			isolation: options.isolation,
			signal: run.signal,
			timeoutMs: options.timeoutMs,
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
					(requestSignal) => adapters.recordContextView(frame, outputs, requestSignal),
					signal,
				);
				await assertActive(signal);
			},
		});
	} finally {
		boundary?.close();
		run.close();
	}
}
