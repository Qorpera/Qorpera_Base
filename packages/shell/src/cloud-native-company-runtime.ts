import { CLOUD_AGENT_SEND_INSTRUCTIONS, CloudAgentMouth, parseCloudAgentSendInput } from "./cloud-agent-mouth.ts";
import { type CloudCompanyPathControl, CloudCompanyPathGateway } from "./cloud-company-path-gateway.ts";
import {
	CLOUD_COMPANY_RUNTIME_INSTRUCTIONS,
	cloudCompanyContextTool,
	composeCloudNativeCompanyPrompt,
	parseCloudNativeCompanyContext,
} from "./cloud-native-company-context.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import type {
	NativeCloudExecutionDriver,
	NativeCompanyExecutionRequest,
	NativeProviderControlPlane,
} from "./cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "./cloud-native-run-tool-session.ts";
import {
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperationControlPlane } from "./cloud-native-tool-operations.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";

type NativeCompanyControl = CloudNativeToolAuthorityReader &
	CloudNativeToolOperationControlPlane &
	Pick<NativeProviderControlPlane, "sendMessage">;

/** Cloud-only composition of the native fence, live path gateway and public mouth.
 * Object transport and cloud authority stay in this trusted host. No model tool
 * receives a service key, raw object capability, recipient or canonical mount.
 */
export class CloudNativeCompanyRuntime implements NativeCloudExecutionDriver {
	readonly #control: NativeCompanyControl;
	readonly #paths: CloudCompanyPathControl;
	readonly #store: (
		companyId: string,
		binding: CloudNativeToolBinding,
		signal: AbortSignal,
	) => CloudContentAddressedStore;
	readonly #command: readonly [string, ...string[]];
	readonly #sha256: string;
	readonly #timeoutMs: number;
	readonly #isolation: NativeIsolationConfiguration | undefined;

	constructor(options: {
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
	}) {
		this.#control = options.controlPlane;
		this.#paths = options.pathControl;
		this.#store = options.objectStore;
		this.#command = Object.freeze([...options.command]) as readonly [string, ...string[]];
		this.#sha256 = options.binarySha256;
		this.#timeoutMs = options.timeoutMs ?? 300_000;
		this.#isolation = options.isolation ? Object.freeze({ ...options.isolation }) : undefined;
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
		const context = parseCloudNativeCompanyContext(
			await cloudToolRequest(
				(requestSignal) =>
					this.#paths.call("qorpera_describe_company_run_context", { p_binding: binding }, requestSignal),
				signal,
			),
			binding,
		);
		const gateway = new CloudCompanyPathGateway({
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
			async execute(value) {
				const receipt = await mouth.send(parseCloudAgentSendInput(value));
				return { kind: "text", value: JSON.stringify(receipt) };
			},
		};
		try {
			const result = await runCloudNativeRunToolSession({
				binding,
				controlPlane: this.#control,
				beginExecution: async (requestSignal) => {
					const started = await this.#paths.call(
						"qorpera_begin_native_company_execution",
						{ p_binding: binding, p_binary_sha256: this.#sha256 },
						requestSignal,
					);
					const expected = {
						schema: "qorpera.native-company-execution-start/v1",
						runId: binding.runId,
						jobId: binding.jobId,
						leaseId: binding.leaseId,
						binarySha256: this.#sha256,
					};
					if (
						!started ||
						typeof started !== "object" ||
						Array.isArray(started) ||
						Object.keys(started).length !== Object.keys(expected).length ||
						Object.entries(expected).some(([key, value]) => (started as Record<string, unknown>)[key] !== value)
					)
						throw new Error("Native execution admission was not confirmed");
				},
				command: this.#command,
				binarySha256: this.#sha256,
				identityRoot,
				isolation: this.#isolation,
				prompt: composeCloudNativeCompanyPrompt(context),
				runtimeInstructions: CLOUD_COMPANY_RUNTIME_INSTRUCTIONS,
				signal,
				timeoutMs: this.#timeoutMs,
				tools: (identity) => {
					if (
						Object.entries(context.identity).some(
							([key, value]) => identity[key as keyof typeof identity] !== value,
						)
					)
						throw new Error("Cloud context identity changed before execution");
					return {
						tools: [
							...gateway.tools(),
							cloudCompanyContextTool(context, binding, this.#paths),
							...(identity.sessionId ? [send] : []),
						],
						assertContext: (requestSignal) => gateway.assertReadableContext(requestSignal),
					};
				},
			});
			return {
				providerSessionId: result.providerSessionId,
				delivery: await mouth.finish(context.identity.sessionId !== null),
			};
		} finally {
			await mouth.close();
		}
	}
}
