import { createHash } from "node:crypto";
import type { CloudContentAddressedStore } from "@qorpera/cloud-client/node/cloud-object-store";
import { CLOUD_AGENT_SEND_INSTRUCTIONS, CloudAgentMouth, parseCloudAgentSendInput } from "./cloud-agent-mouth.ts";
import type { CloudCompanyComputerSessionFactory } from "./cloud-company-computer-control.ts";
import { type CloudCompanyPathControl, CloudCompanyPathGateway } from "./cloud-company-path-gateway.ts";
import {
	type CloudCompanyPathPresence,
	type CloudCompanyPathPresenceFactory,
	observeCloudCompanyPathPresence,
} from "./cloud-company-path-presence.ts";
import { cloudHiringTools } from "./cloud-hiring-tools.ts";
import {
	cloudCompanyContextTool,
	compileCloudNativeCompanyInstructions,
	composeCloudNativeCompanyPrompt,
	parseCloudNativeCompanyContext,
} from "./cloud-native-company-context.ts";
import { type NativeRuntimeFailureStage, tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import {
	type NativeCloudExecutionDriver,
	type NativeCompanyExecutionRequest,
	type NativeProviderControlPlane,
	nativeProviderUsageSignal,
} from "./cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "./cloud-native-run-tool-session.ts";
import {
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperationControlPlane } from "./cloud-native-tool-operations.ts";
import { cloudRoutineTools } from "./cloud-routine-tools.ts";
import { assertCloudRuntimeBundle } from "./cloud-runtime-bundle.ts";
import {
	assertCloudRuntimeObservationReceipt,
	CloudRuntimeObservability,
	cloudRuntimeErrorCategory,
} from "./cloud-runtime-observability.ts";
import { type CloudSecretOperationClient, cloudSecretTools, describeCloudSecretTools } from "./cloud-secret-tools.ts";
import { type CloudWakeControl, cloudCoworkerMessageTool, parseCloudWakeEnvelope } from "./cloud-wake-bus.ts";
import { cloudWorkerToolFilter, cloudWorkerTools } from "./cloud-worker-tools.ts";

type NativeCompanyControl = CloudNativeToolAuthorityReader &
	CloudNativeToolOperationControlPlane &
	Pick<NativeProviderControlPlane, "sendMessage">;

/** Cloud-only composition of the native fence, live path gateway and public mouth.
 * Object transport and cloud authority stay in this trusted host. No model tool
 * receives a service key, raw object capability, recipient or canonical mount.
 */
export class CloudNativeCompanyRuntime implements NativeCloudExecutionDriver {
	readonly #presenceFactory: CloudCompanyPathPresenceFactory | undefined;
	readonly #control: NativeCompanyControl;
	readonly #paths: CloudCompanyPathControl;
	readonly #store: (
		companyId: string,
		binding: CloudNativeToolBinding,
		signal: AbortSignal,
	) => CloudContentAddressedStore;
	readonly #command: readonly [string, ...string[]];
	readonly #sha256: string;
	readonly #timeoutMs: number | undefined;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #secretBroker: CloudSecretOperationClient | undefined;
	readonly #computerSession: CloudCompanyComputerSessionFactory | undefined;

	constructor(options: {
		presence?: CloudCompanyPathPresenceFactory;
		controlPlane: NativeCompanyControl;
		pathControl: CloudCompanyPathControl;
		objectStore: (
			companyId: string,
			binding: CloudNativeToolBinding,
			signal: AbortSignal,
		) => CloudContentAddressedStore;
		command: readonly [string, ...string[]];
		binarySha256: string;
		timeoutMs?: number;
		isolation?: NativeIsolationConfiguration;
		secretBroker?: CloudSecretOperationClient;
		/** Explicit cloud-office adapter; no local execution or inferred resource grant. */
		computerSession?: CloudCompanyComputerSessionFactory;
	}) {
		this.#control = options.controlPlane;
		this.#presenceFactory = options.presence;
		this.#paths = options.pathControl;
		this.#store = options.objectStore;
		this.#command = Object.freeze([...options.command]) as readonly [string, ...string[]];
		this.#sha256 = options.binarySha256;
		this.#timeoutMs = options.timeoutMs;
		this.#isolation = options.isolation ? Object.freeze({ ...options.isolation }) : undefined;
		this.#secretBroker = options.secretBroker;
		this.#computerSession = options.computerSession;
	}

	async execute(request: NativeCompanyExecutionRequest, identityRoot: string, signal: AbortSignal) {
		// The closed binding is subsequently checked by the cloud, not trusted
		// because a runner supplied matching-looking UUIDs or a local JSON file.
		const binding = parseCloudNativeToolBinding({
			leaseId: request.authority.leaseId,
			runId: request.authority.runId,
			jobId: request.job.jobId,
			runnerId: request.authority.runnerId,
			assignmentId: request.authority.assignmentId,
			credentialCapsuleId: request.authority.credentialCapsuleId,
			computeIdentityId: request.authority.computeIdentityId,
			provider: request.authority.provider,
			nativeHarness: request.authority.nativeHarness,
			model: request.authority.model,
		});
		const observability = new CloudRuntimeObservability({
			assignmentId: binding.assignmentId,
			publish: async (observation, requestSignal) => {
				const receipt = await this.#paths.call(
					"qorpera_record_runtime_observation",
					{ p_run_id: binding.runId, p_observation: observation },
					requestSignal,
				);
				assertCloudRuntimeObservationReceipt(receipt, binding.runId, observation);
			},
		});
		const composition = observability.start("company_context");
		let stage: NativeRuntimeFailureStage = "company-context";
		let presence: CloudCompanyPathPresence | undefined;
		try {
			const context = parseCloudNativeCompanyContext(
				await cloudToolRequest(
					(requestSignal) =>
						this.#paths.call("qorpera_describe_company_run_context", { p_binding: binding }, requestSignal),
					signal,
				),
				binding,
			);
			stage = "bundle-compatibility";
			assertCloudRuntimeBundle(context.identity, this.#sha256);
			// Every activation enters through the wake bus (contract 8): the admitted
			// occurrence's typed envelope and kernel-owned reply policy, never a job flag.
			stage = "wake-envelope";
			const wake = parseCloudWakeEnvelope(
				await cloudToolRequest(
					(requestSignal) => this.#paths.call("qorpera_read_native_wake", { p_binding: binding }, requestSignal),
					signal,
				),
				context.identity,
			);
			const wakeControl: CloudWakeControl = {
				call: (method, argumentsValue, requestSignal) => this.#paths.call(method, argumentsValue, requestSignal),
			};
			stage = "connector-tools";
			const connectorDescriptors = this.#secretBroker
				? await describeCloudSecretTools(this.#paths, binding, signal)
				: [];
			stage = "prompt-composition";
			presence = this.#presenceFactory?.(binding, context.identity, signal);
			// Only a typed, cloud-authorized file event selects an initial path.
			// Other paths become relevant through live file tools; do not guess them
			// from untrusted message text or enumerate the whole company.
			const initialPresence =
				wake.kind === "routine" && wake.source.kind === "company-file" && typeof wake.payload.path === "string"
					? await observeCloudCompanyPathPresence(presence, wake.payload.path, "object", "reading", signal)
					: undefined;
			const prompt = composeCloudNativeCompanyPrompt(context, wake, initialPresence);
			composition.finish("succeeded", { outputBytes: Buffer.byteLength(prompt) });
			const contextSha256 = createHash("sha256").update(prompt).digest("hex");
			const gateway = new CloudCompanyPathGateway({
				presence,
				binding,
				identity: context.identity,
				control: this.#paths,
				store: this.#store(context.identity.companyId, binding, signal),
			});
			const mouth = new CloudAgentMouth(
				binding.runId,
				async (input) => {
					if (context.identity.sessionId === null) throw new Error("This run has no conversation recipient");
					const receipt = await cloudToolRequest(
						(requestSignal) => this.#control.sendMessage(request, input, requestSignal),
						signal,
					);
					if (receipt.sessionId !== context.identity.sessionId) throw new Error("Cloud send audience changed");
					return receipt;
				},
				signal,
			);
			// Diagnostic deduplication uses only validated public receipts, never a model key.
			const deliveredMessageIds = new Set<string>();
			const send: CloudNativeTool = {
				name: "send_message",
				source: "runtime",
				description: CLOUD_AGENT_SEND_INSTRUCTIONS,
				inputSchema: {
					type: "object",
					properties: {
						idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
						text: { type: "string", minLength: 1, maxLength: 65536 },
						phase: { type: "string", enum: ["progress", "final"] },
					},
					required: ["idempotencyKey", "text", "phase"],
					additionalProperties: false,
				},
				parseArguments(value) {
					const input = parseCloudAgentSendInput(value);
					return { idempotencyKey: input.idempotencyKey, text: input.text, phase: input.phase };
				},
				async execute(value, context) {
					const input = parseCloudAgentSendInput(value);
					const receipt = await mouth.send(input);
					const replayed = deliveredMessageIds.has(receipt.messageId);
					deliveredMessageIds.add(receipt.messageId);
					const text = JSON.stringify(receipt);
					context.observation?.finish(replayed ? "replayed" : "succeeded", {
						outputBytes: Buffer.byteLength(text),
					});
					// Contract 7.1: the final send closes the turn. Nothing after it reaches the member.
					return { kind: "text", value: text, completesTurn: input.phase === "final" };
				},
			};
			try {
				stage = "native-tools";
				const result = await runCloudNativeRunToolSession({
					observability,
					binding,
					controlPlane: this.#control,
					beginExecution: async (specification, requestSignal) => {
						const toolCatalogText = cloudToolJsonText(specification, 256 * 1024);
						const started = await this.#paths.call(
							"qorpera_begin_native_company_execution_v2",
							{
								p_binding: binding,
								p_binary_sha256: this.#sha256,
								p_runtime_bundle_sha256: context.identity.runtimeBundleSha256,
								p_reasoning_policy_sha256: context.identity.reasoningPolicySha256,
								p_tool_catalog_text: toolCatalogText,
								p_context_sha256: contextSha256,
								p_context_bytes: Buffer.byteLength(prompt),
							},
							requestSignal,
						);
						const expected = {
							schema: "qorpera.native-company-execution-start/v1",
							runId: binding.runId,
							jobId: binding.jobId,
							leaseId: binding.leaseId,
							binarySha256: this.#sha256,
							runtimeBundleSha256: context.identity.runtimeBundleSha256,
							reasoningEffort: context.identity.reasoningEffort,
							reasoningPolicySha256: context.identity.reasoningPolicySha256,
							toolCatalogSha256: createHash("sha256").update(toolCatalogText).digest("hex"),
							contextSha256,
							contextBytes: Buffer.byteLength(prompt),
						};
						if (
							!started ||
							typeof started !== "object" ||
							Array.isArray(started) ||
							Object.keys(started).length !== Object.keys(expected).length ||
							Object.entries(expected).some(
								([key, value]) => (started as Record<string, unknown>)[key] !== value,
							)
						)
							throw new Error("Native execution admission was not confirmed");
					},
					command: this.#command,
					binarySha256: this.#sha256,
					identityRoot,
					isolation: this.#isolation,
					prompt,
					runtimeInstructions: compileCloudNativeCompanyInstructions(context, wake),
					signal,
					timeoutMs: this.#timeoutMs,
					tools: async (identity, operations, run) => {
						if (
							Object.entries(context.identity).some(
								([key, value]) => identity[key as keyof typeof identity] !== value,
							)
						)
							throw new Error("Cloud context identity changed before execution");
						const computer = await this.#computerSession?.(run, operations);
						// Contract 13: a worker reads, works and reports to its parent. It has no mouth, no
						// coworker channel and no delegation; an ordinary company run is the dispatcher.
						const work = cloudWorkerToolFilter(wake);
						return {
							captures: computer?.captures,
							tools: [
								...(computer?.tools ?? []),
								...gateway.tools().filter(work.companyFile),
								cloudCompanyContextTool(context, binding, this.#paths),
								// A worker has no outbound effects: no mouth, no connectors.
								...(this.#secretBroker && !work.isWorker
									? cloudSecretTools({
											descriptors: connectorDescriptors,
											binding,
											control: this.#paths,
											operations,
											broker: this.#secretBroker,
										})
									: []),
								...(work.isWorker
									? []
									: [
											cloudCoworkerMessageTool(binding, identity, wakeControl),
											...cloudRoutineTools(binding, identity, this.#paths),
										]),
								...(identity.audienceKind === "company"
									? [
											...(work.isWorker ? [] : cloudHiringTools(gateway, identity)),
											...cloudWorkerTools(binding, identity, this.#paths, gateway, wake),
										]
									: []),
								...(identity.sessionId && wake.policy.final !== "forbidden" ? [send] : []),
							],
							assertContext: (requestSignal) => gateway.assertReadableContext(requestSignal),
							recordContextView: (frame, outputs, requestSignal) =>
								gateway.recordContextView(frame, outputs, requestSignal),
							...(computer ? { close: () => computer.close() } : {}),
						};
					},
				});
				stage = "public-completion";
				return {
					providerSessionId: result.providerSessionId,
					delivery: await mouth.finish(wake.policy.final === "required"),
				};
			} finally {
				await mouth.close();
			}
		} catch (error) {
			composition.finish("failed", { errorCategory: cloudRuntimeErrorCategory(error, signal) });
			await this.#recordUsageSignal(binding, error);
			throw tagNativeRuntimeFailure(error, stage, cloudRuntimeErrorCategory(error, signal));
		} finally {
			await presence?.close().catch(() => undefined);
			await observability.close();
		}
	}

	/**
	 * Contract section 17: quota exhaustion, rate limiting and provider outage
	 * are typed signals recorded against the run's exact sponsor and connection
	 * version before the job fails. Recording never retries the provider, never
	 * masks the failure, and carries no provider text.
	 */
	async #recordUsageSignal(binding: CloudNativeToolBinding, error: unknown): Promise<void> {
		const kind = nativeProviderUsageSignal(error);
		if (!kind) return;
		try {
			await this.#paths.call(
				"qorpera_record_provider_usage_signal",
				{ p_binding: binding, p_signal_kind: kind },
				AbortSignal.timeout(10_000),
			);
		} catch {
			console.error(`Provider usage signal was not recorded (${kind})`);
		}
	}
}
