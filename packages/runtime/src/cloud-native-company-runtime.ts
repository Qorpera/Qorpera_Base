import { createHash, randomUUID } from "node:crypto";
import { cloudAgentFolder } from "@qorpera/cloud-client/cloud-agent-folder";
import type { JsonValue, StudioPatchOp, SurfaceSessionQuestion, SurfaceSourceKind } from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import {
	CLOUD_ACTION_REVIEW_HOLD_MS,
	CloudActionReviewChannel,
	CloudActionReviewGate,
	cloudActionEffect,
	cloudActionReviewMandate,
	cloudActionReviewRequest,
	cloudConnectorEffects,
} from "./cloud-action-review.ts";
import {
	cloudVisionAgreed,
	composeCloudAgentHead,
	readCloudAgentHeadReading,
	readCloudAgentHeadVision,
} from "./cloud-agent-head.ts";
import { CLOUD_AGENT_SEND_INSTRUCTIONS, CloudAgentMouth, parseCloudAgentSendInput } from "./cloud-agent-mouth.ts";
import { cloudNarrateAppTool } from "./cloud-app-narrate-tool.ts";
import { hasChatGptPlanDirectory, hasChatGptPlanToken } from "./cloud-chatgpt-plan-image.ts";
import {
	CLAUDE_ACTION_REVIEW_MODEL,
	CLAUDE_CODE_PIN,
	type ClaudeBoxConfiguration,
	type ClaudeCodeBoxOptions,
	launchClaudeCodeBox,
} from "./cloud-claude-box.ts";
import type { CloudClaudeHomeChannel } from "./cloud-claude-home-shell.ts";
import type { ClaudeLoginUsage } from "./cloud-claude-login-usage.ts";
import type { CloudClaudePictures } from "./cloud-claude-picture-command.ts";
import {
	type CloudClaudePictureLane,
	claudeWorkerPictures,
	cloudClaudePictureLaneFor,
	cloudClaudePictureSessionStart,
} from "./cloud-claude-picture-lane.ts";
import {
	CLAUDE_WORKER_CATALOG,
	CLAUDE_WORKER_SYSTEM_NOTE,
	type ClaudeWorkerOutcome,
	claudeWorkerBlocked,
	claudeWorkerBrief,
	claudeWorkerLogins,
	claudeWorkerPrompt,
	claudeWorkerReportedOutputs,
	claudeWorkerSessionId,
	claudeWorkerSettledOutputs,
	runClaudeWorker,
} from "./cloud-claude-worker.ts";
import { cloudCodeTools } from "./cloud-code-tools.ts";
import {
	CLOUD_HOME_CLOSE_MS,
	CloudCodexHome,
	type CloudCodexHomeChannel,
	type CloudCodexHomeReview,
	CloudCodexHomeSteps,
	type CloudCompanyHome,
	cloudHomeActionReview,
	cloudHomeRefusalWords,
	parseCloudCompanyHome,
} from "./cloud-codex-home.ts";
import {
	type CloudChatGptPlanAuth,
	type CloudCodexContextComposer,
	type CloudCodexOpening,
	disposeCloudCodexSpares,
	prefetchCloudCodexArtifact,
	prepareCloudCodexSpare,
} from "./cloud-codex-tool-session.ts";
import { type CloudCompanyAccountClient, cloudCompanyAccountTool } from "./cloud-company-account-tools.ts";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	type CloudCompanyFolderSignedHooks,
} from "./cloud-company-folder-client.ts";
import { type CloudCompanyPathControl, CloudCompanyPathGateway } from "./cloud-company-path-gateway.ts";
import {
	type CloudCompanyPathPresence,
	type CloudCompanyPathPresenceFactory,
	observeCloudCompanyPathPresence,
} from "./cloud-company-path-presence.ts";
import {
	CloudControlRpcEnded,
	cloudControlPause,
	cloudControlRetryable,
	cloudControlTransientCode,
} from "./cloud-control-errors.ts";
import { type CloudCompanyDataDoor, cloudDataTools } from "./cloud-data-tools.ts";
import { cloudEventTools } from "./cloud-event-tools.ts";
import { cloudAppGroupsTool } from "./cloud-folder-app-groups.ts";
import { cloudAppTools } from "./cloud-folder-app-tools.ts";
import { cloudFolderFileTools, type SurfaceFilePolicy } from "./cloud-folder-file-tools.ts";
import { CloudFolderGroupChats } from "./cloud-folder-group-chats.ts";
import { CloudFolderHiring } from "./cloud-folder-hiring.ts";
import { cloudInterfaceTools } from "./cloud-folder-interface-tools.ts";
import { cloudInterfaceWriteTools } from "./cloud-folder-interface-writes.ts";
import { CloudFolderNotebooks } from "./cloud-folder-notebooks.ts";
import { cloudPictureForeignOwner, cloudPictureTool } from "./cloud-folder-picture-tool.ts";
import { CloudFolderProposals } from "./cloud-folder-proposals.ts";
import {
	CloudFolderReading,
	cloudCompanyMembers,
	cloudReadingTool,
	describeCloudCompanySenses,
} from "./cloud-folder-reading.ts";
import { CloudFolderRoutineDecision } from "./cloud-folder-routine-decision.ts";
import { CloudFolderRoutines } from "./cloud-folder-routines.ts";
import { CloudFolderSearch, cloudFolderSearchTool } from "./cloud-folder-search-tool.ts";
import { CloudFolderSidebar } from "./cloud-folder-sidebar.ts";
import { CloudFolderTodos } from "./cloud-folder-todos.ts";
import { CloudFolderWorkers } from "./cloud-folder-workers.ts";
import {
	GEMINI_ACTION_REVIEW_MODEL,
	GeminiCapReachedError,
	GeminiKeyRevokedError,
	GeminiProviderError,
	type GeminiProviderErrorCode,
	type GeminiUsageReceipt,
	geminiProviderErrorCode,
} from "./cloud-gemini-tool-session.ts";
import { synthesizeGeminiSpeech } from "./cloud-gemini-tts.ts";
import { cloudGoodWillTools } from "./cloud-good-will-tools.ts";
import { cloudHiringTools } from "./cloud-hiring-tools.ts";
import { composeCloudLightAsk } from "./cloud-light-ask.ts";
import type { CloudMachineCommandGateway } from "./cloud-machine-command-http.ts";
import { type CloudMachineCodingValues, cloudMachineTools } from "./cloud-machine-tools.ts";
import { cloudMemberOfferTools } from "./cloud-member-offer-tools.ts";
import { cloudMemoryTools, composeCloudAgentMemory, unavailableCloudAgentMemory } from "./cloud-memory-tools.ts";
import type { CloudNativeCodingDriver } from "./cloud-native-coding-runtime.ts";
import {
	type CloudCompanyContextSource,
	type CloudNativeCompanyContext,
	cloudAgentFolderPlace,
	cloudCompanyContextTool,
	cloudNativeTurnCorrection,
	compileCloudNativeCompanyInstructions,
	composeCloudContinuation,
	composeCloudNativeCompanyPrompt,
	composeCloudRoomRequest,
	parseCloudNativeCompanyContext,
} from "./cloud-native-company-context.ts";
import {
	cloudNativeContextIdentity,
	cloudNativeContextWithPromptCacheKey,
	cloudNativePromptCacheKey,
} from "./cloud-native-context-composition.ts";
import { type NativeRuntimeFailureStage, tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import {
	type NativeCloudExecutionDriver,
	type NativeCompanyExecutionRequest,
	type NativeProviderControlPlane,
	type NativeProviderUsageSignal,
	nativeProviderUsageSignal,
} from "./cloud-native-provider-host.ts";
import { runCloudNativeRunToolSession } from "./cloud-native-run-tool-session.ts";
import {
	CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
	CLOUD_RUN_ROW_READ_MS,
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	CloudNativeToolRun,
	cloudRunRowWrite,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CLOUD_NATIVE_TOOL_CATALOG_BYTES,
	CloudControlRefusalRelay,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	cloudToolJsonText,
	isCloudParallelReadCall,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "./cloud-native-tool-operations.ts";
import { cloudToolsOnDemand } from "./cloud-native-tools-on-demand.ts";
import { cloudRecordReflectionTool, readCloudPlatformUpdates } from "./cloud-platform-updates.ts";
import { cloudReviewRuleTools } from "./cloud-review-rule-tools.ts";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "./cloud-routine-tools.ts";
import { type CloudRunLog, CloudRunLogGone } from "./cloud-run-log.ts";
import { CloudRunLogCompanyFolder } from "./cloud-run-log-folder.ts";
import { openCloudRunLog } from "./cloud-run-log-open.ts";
import { CloudRunLogRpcProtection } from "./cloud-run-log-protection.ts";
import {
	createChatGptPlanImageLane,
	createGeminiImageLane,
	type ResolvedRunPictureLane,
	resolveRunPictureLane,
} from "./cloud-run-picture-lane.ts";
import { CloudRunResumeRpc } from "./cloud-run-resume.ts";
import { NATIVE_AUTHORITY_LEASE_SECONDS } from "./cloud-runner-broker.ts";
import { assertCloudRuntimeBundle } from "./cloud-runtime-bundle.ts";
import {
	assertCloudRuntimeObservationBatchReceipt,
	CloudRuntimeObservability,
	type CloudRuntimeToolOperation,
	cloudRuntimeErrorCategory,
} from "./cloud-runtime-observability.ts";
import {
	type CloudRuntimeImageModel,
	type CloudRuntimeReasoningEffort,
	type CloudRuntimeServiceTier,
	isCloudRuntimeImageModel,
	isCloudRuntimeServiceTier,
} from "./cloud-runtime-policy.ts";
import { type ClaudeLoginRunClient, type GeminiKeyRunClient, openGeminiKeyForRun } from "./cloud-secret-broker-http.ts";
import { type CloudSecretOperationClient, cloudSecretTools, describeCloudSecretTools } from "./cloud-secret-tools.ts";
import { cloudSidebarTools } from "./cloud-sidebar-tools.ts";
import { cloudSiteTools } from "./cloud-site-tools.ts";
import {
	cloudReadOnlySkillTools,
	cloudSkillTools,
	composeCloudAgentSkills,
	unavailableCloudAgentSkills,
} from "./cloud-skill-tools.ts";
import {
	parseNativeSurfaceSessionImages,
	readSurfaceMemberImage,
	type SurfaceMemberImage,
	surfaceMemberImagesSection,
} from "./cloud-surface-images.ts";
import {
	parseSurfaceOmittedBaseChanges,
	parseSurfacePreviewContext,
	parseSurfaceSessionOpenChanges,
} from "./cloud-surface-preview-overlay.ts";
import {
	cloudStudioFileReader,
	createControlPlaneSessionCompletionPort,
	createControlPlaneSessionLeaseRenewalPort,
	extractPointToChangeTarget,
	loadSurfaceSharedAssets,
	openSurfaceLayoutOps,
	runSurfaceSessionTurn,
	type SurfaceSessionTurnExecutionOutcome,
	type SurfaceSessionTurnInput,
	surfaceArchetypeOf,
} from "./cloud-surface-session-runner.ts";
import {
	type CloudSurfaceToolsPort,
	type ControlPlaneSurfaceToolsPortOptions,
	createControlPlaneSurfaceToolsPort,
	createManageSurfaceAutomationTool,
	createProposeSurfaceTool,
	createStartSurfaceSessionTool,
	type SurfaceCompanySenses,
	type SurfaceToolsRpcClient,
} from "./cloud-surface-tools.ts";
import {
	type CompanyInterfacesContext,
	extractStrategyInterfaceSummary,
	parseCompanyInterfacesResponse,
	parseSurfaceConflictDetails,
	parseSurfaceTurnOpenChanges,
	parseSurfaceTurnResolvedChanges,
	type SurfaceCodingTurnBinding,
} from "./cloud-surface-turn-context.ts";
import {
	CLOUD_ASK_MEMBER_INPUT_SCHEMA,
	cloudAskMemberFinalKey,
	cloudAskMemberInstructions,
	cloudInteractionEventId,
	parseCloudAskMemberInput,
} from "./cloud-thread-interactions.ts";
import { CloudVoiceChannel } from "./cloud-voice-channel.ts";
import {
	type CloudWakeControl,
	type CloudWakeEnvelope,
	cloudCoworkerMessageTool,
	cloudWakeIsOwnThread,
	parseCloudWakeEnvelope,
} from "./cloud-wake-bus.ts";
import { cloudWorkerToolFilter, cloudWorkerTools, describeCloudAgentOpenWork } from "./cloud-worker-tools.ts";
import { MemoryCompactChannel, MemoryCompactLane, MemoryCompactStop } from "./memory-tree/compact.ts";

const CLOUD_CLAUDE_USAGE_MS = 10_000;
const CLOUD_CLAUDE_USAGE_EVERY_MS = 60_000;

/** A plain worker Claude Code does (20260930770000) on a node without its composition (no vault route for Claude
 * sign-ins, or no home channel): refused, never run on Codex. */
export const CLAUDE_WORKER_NOT_CARRIED =
	"Claude Code workers run in their own composition, which this node does not carry; nothing ran on Codex";

const CLAUDE_WORKER_FALLBACK_ATTEMPTS = 3;

/** What a host that carries the Claude Code worker's composition gives it (slice C4c). */
export interface CloudClaudeWorkerHost {
	/** The vault's Claude sign-in routes, under this host's runtime token (C4b). */
	readonly logins: ClaudeLoginRunClient;
	/** Where the box's parts are (the execution host image installs them); default CLAUDE_BOX_CONFIGURATION. */
	readonly configuration?: ClaudeBoxConfiguration;
	/** Proofs only: the box's egress transport and CA for a stub model. No production host sets it. */
	readonly proof?: ClaudeCodeBoxOptions["proof"];
	readonly pictures?: (identityRoot: string) => NonNullable<CloudClaudePictures["make"]>;
}

// The company runtime's control plane completes folder receipts: a folder-v2 run's writers commit under them.
type NativeCompanyControl = CloudNativeToolAuthorityReader &
	CloudNativeToolOperationControlPlane &
	Required<Pick<CloudNativeToolOperationControlPlane, "completeFolderToolOperation">> &
	Pick<NativeProviderControlPlane, "sendMessage" | "appendInteractionRequest">;

/** An admission's answer (the run's, or its start once the context is bound) is exactly `expected`, or the run stops. */
function confirmNativeAdmission(answer: unknown, expected: Readonly<Record<string, unknown>>): void {
	if (
		!answer ||
		typeof answer !== "object" ||
		Array.isArray(answer) ||
		Object.keys(answer).length !== Object.keys(expected).length ||
		Object.entries(expected).some(([key, value]) => (answer as Record<string, unknown>)[key] !== value)
	)
		throw new Error("Native execution admission was not confirmed");
}

export { type ControlPlaneSurfaceToolsPortOptions, createControlPlaneSurfaceToolsPort, type SurfaceToolsRpcClient };

type CloudRuntimeSurfaceToolsPort = Pick<CloudSurfaceToolsPort, "proposeSurface" | "startSurfaceSession"> &
	Partial<Pick<CloudSurfaceToolsPort, "listSurfaceSenses" | "manageAutomation">>;

const EXPLICIT_MEMBER_DOC_PATTERN =
	/\b(?:write|create|draft|save|export|generate|make|put|prepare)\s+(?:a|an|me|us|the)?\s*(?:markdown|md|doc|document|memo|report|plan|brief|pdf|csv|spreadsheet|file)\b|\b(?:as\s+a\s+(?:markdown|md|doc|document|file|pdf|csv|memo|report))\b|\.(?:md|pdf|csv|docx|xlsx)\b/i;

function memberExplicitlyRequestedDocument(context: CloudNativeCompanyContext, wake: CloudWakeEnvelope): boolean {
	const texts: string[] = [];
	for (const source of context.currentInputs) {
		if (source.kind === "current_human_request") texts.push(source.content.text);
	}
	if (wake.kind === "room" && Array.isArray(wake.payload.inputIds)) {
		const ids = new Set(wake.payload.inputIds.filter((id): id is string => typeof id === "string"));
		for (const source of context.history) {
			if (source.kind === "historical_human_message" && ids.has(source.id)) {
				texts.push(source.content.text);
			}
		}
	}
	return texts.some((text) => EXPLICIT_MEMBER_DOC_PATTERN.test(text));
}

function mergeSurfaceSenses(
	baseSenses: JsonValue | null | undefined,
	surfaceSenses: SurfaceCompanySenses | undefined,
): JsonValue | null | undefined {
	if (!surfaceSenses) return baseSenses;
	const surfaceFields = {
		surfaces: surfaceSenses.surfaces,
		automations: surfaceSenses.automations,
	} as unknown as Record<string, JsonValue>;
	if (baseSenses && typeof baseSenses === "object" && !Array.isArray(baseSenses)) {
		return { ...baseSenses, ...surfaceFields };
	}
	return surfaceFields;
}

export interface CloudNativeCompanyRuntimeOptions {
	presence?: CloudCompanyPathPresenceFactory;
	controlPlane: NativeCompanyControl;
	pathControl: CloudCompanyPathControl;
	command: readonly [string, ...string[]];
	binarySha256: string;
	timeoutMs?: number;
	isolation?: NativeIsolationConfiguration;
	/** How a ChatGPT plan run's Codex gets the plan's token; `command` unless the host chose the fallback. */
	chatGptPlanAuth?: CloudChatGptPlanAuth;
	secretBroker?: CloudSecretOperationClient;
	/** The vault's company accounts route (A1-4): without it no run is offered company_account. */
	companyAccounts?: CloudCompanyAccountClient;
	/** The vault's event hooks route (E3b-2): without it a run's GitHub or HMAC hook is refused as unavailable. */
	eventHooks?: CloudCompanyFolderSignedHooks;
	/** The coding composition (Order 9): only a node with the coding command
	 * gateway installed carries it. A coding wake on a node without it fails visibly. */
	coding?: CloudNativeCodingDriver;
	/** Company machines' command gateway (the coding executor's ingress, 2026-09-28).
	 * Without it no run is offered the machine tools. */
	machines?: (binding: CloudNativeToolBinding) => CloudMachineCommandGateway;
	/**
	 * The agent's home (lanes/agent-box-20261113, slice 1): the channel from this run's slot to its own machine, for
	 * Codex's own shell and file tools. Given only where the host is configured for it; used only for a run whose
	 * company has the switch on (`qorpera_company_home_available`). Without either, every run is exactly as today.
	 */
	homeChannel?: (binding: CloudNativeToolBinding) => CloudCodexHomeChannel;
	/** The Claude Code worker's composition (slice C4c): with the home channel, a plain worker the agent handed to
	 * Claude Code runs here, on the agent's machine and its member's Claude sign-in. Without it such a run is refused. */
	claudeWorker?: CloudClaudeWorkerHost;
	geminiKeys?: GeminiKeyRunClient;
	geminiApiBaseUrl?: string;
	geminiAllowLoopback?: boolean;
	geminiFetch?: typeof fetch;
	chatGptPlanApiBaseUrl?: string;
	chatGptPlanAllowLoopback?: boolean;
	chatGptPlanFetch?: typeof fetch;
	/** The vault's coding value route (20260930705000): with machines, a company agent's own run is offered
	 * save_coding_value. */
	codingValues?: CloudMachineCodingValues;
	/** A company run's file bytes (core C1d: the object gateway's folder route). Every company run is a folder-v2
	 * run (legacy sweep step C, C-P1). */
	folderBytes: (binding: CloudNativeToolBinding, identity: CloudNativeToolIdentity) => CloudCompanyFolderBytes;
	/** The slot's relay to the node's folder search (F3, the shared execution host only): a folder-v2 run gets
	 * company_search over it. */
	folderSearch?: { readonly socketPath: string };
	/** The data gateway's run door (company databases, slices 5 and 7): with it a run is offered data_describe,
	 * data_query and, unless it is a worker, data_apply and data_change; without it none of them. */
	companyData?: CloudCompanyDataDoor;
	surfaceTools?: CloudRuntimeSurfaceToolsPort;
	surfaceFirst?: boolean;
}

/** Cloud-only composition of the native fence, live path gateway and public mouth.
 * Object transport and cloud authority stay in this trusted host. No model tool
 * receives a service key, raw object capability, recipient or canonical mount.
 */
export class CloudNativeCompanyRuntime implements NativeCloudExecutionDriver {
	readonly #presenceFactory: CloudCompanyPathPresenceFactory | undefined;
	readonly #control: NativeCompanyControl;
	readonly #paths: CloudCompanyPathControl;
	readonly #command: readonly [string, ...string[]];
	readonly #sha256: string;
	readonly #timeoutMs: number | undefined;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #chatGptPlanAuth: CloudChatGptPlanAuth | undefined;
	readonly #secretBroker: CloudSecretOperationClient | undefined;
	readonly #companyAccounts: CloudCompanyAccountClient | undefined;
	readonly #eventHooks: CloudCompanyFolderSignedHooks | undefined;
	readonly #coding: CloudNativeCodingDriver | undefined;
	readonly #machines: ((binding: CloudNativeToolBinding) => CloudMachineCommandGateway) | undefined;
	readonly #homeChannel: ((binding: CloudNativeToolBinding) => CloudCodexHomeChannel) | undefined;
	readonly #claudeWorker: CloudClaudeWorkerHost | undefined;
	readonly #geminiKeys: GeminiKeyRunClient | undefined;
	readonly #geminiApiBaseUrl: string | undefined;
	readonly #geminiAllowLoopback: boolean | undefined;
	readonly #geminiFetch: typeof fetch | undefined;
	readonly #chatGptPlanApiBaseUrl: string | undefined;
	readonly #chatGptPlanAllowLoopback: boolean | undefined;
	readonly #chatGptPlanFetch: typeof fetch | undefined;
	readonly #codingValues: CloudMachineCodingValues | undefined;
	readonly #folderSearch: { readonly socketPath: string } | undefined;
	readonly #companyData: CloudCompanyDataDoor | undefined;
	readonly #surfaceTools: CloudRuntimeSurfaceToolsPort | undefined;
	readonly #surfaceFirst: boolean;
	readonly #folderBytes: (
		binding: CloudNativeToolBinding,
		identity: CloudNativeToolIdentity,
	) => CloudCompanyFolderBytes;

	constructor(options: CloudNativeCompanyRuntimeOptions) {
		this.#control = options.controlPlane;
		this.#presenceFactory = options.presence;
		this.#paths = options.pathControl;
		this.#command = Object.freeze([...options.command]) as readonly [string, ...string[]];
		this.#sha256 = options.binarySha256;
		// Hash the Codex binary once per service process, while it waits for its run.
		void prefetchCloudCodexArtifact(this.#command[0]);
		this.#timeoutMs = options.timeoutMs;
		this.#isolation = options.isolation ? Object.freeze({ ...options.isolation }) : undefined;
		this.#chatGptPlanAuth = options.chatGptPlanAuth;
		this.#secretBroker = options.secretBroker;
		this.#companyAccounts = options.companyAccounts;
		this.#eventHooks = options.eventHooks;
		this.#homeChannel = options.homeChannel;
		this.#claudeWorker = options.claudeWorker;
		this.#geminiKeys = options.geminiKeys;
		this.#geminiApiBaseUrl = options.geminiApiBaseUrl;
		this.#geminiAllowLoopback = options.geminiAllowLoopback;
		this.#geminiFetch = options.geminiFetch;
		this.#chatGptPlanApiBaseUrl = options.chatGptPlanApiBaseUrl;
		this.#chatGptPlanAllowLoopback = options.chatGptPlanAllowLoopback;
		this.#chatGptPlanFetch = options.chatGptPlanFetch;
		this.#coding = options.coding;
		this.#machines = options.machines;
		this.#codingValues = options.codingValues;
		this.#folderBytes = options.folderBytes;
		this.#folderSearch = options.folderSearch ? Object.freeze({ ...options.folderSearch }) : undefined;
		this.#companyData = options.companyData;
		this.#surfaceFirst = options.surfaceFirst ?? Boolean(options.surfaceTools);
		this.#surfaceTools =
			options.surfaceTools ?? (this.#surfaceFirst ? createControlPlaneSurfaceToolsPort(this.#paths) : undefined);
	}

	/** The effort and tier of the last successful run per identity root: a spare starts with them. */
	readonly #spareEfforts = new Map<
		string,
		{ reasoningEffort: CloudRuntimeReasoningEffort; serviceTier: CloudRuntimeServiceTier; home: boolean }
	>();

	#rememberSpareEffort(
		identityRoot: string,
		settings: { reasoningEffort: CloudRuntimeReasoningEffort; serviceTier: CloudRuntimeServiceTier; home: boolean },
	): void {
		this.#spareEfforts.delete(identityRoot);
		this.#spareEfforts.set(identityRoot, settings);
		if (this.#spareEfforts.size > 64) {
			const oldest = this.#spareEfforts.keys().next().value;
			if (oldest !== undefined) this.#spareEfforts.delete(oldest);
		}
	}

	/** Warm conversations: starts a spare Codex process for the next run on this identity root. */
	prepareSpare(identityRoot: string, idleMs: number): void {
		const settings = this.#spareEfforts.get(identityRoot);
		if (!settings) return;
		prepareCloudCodexSpare(
			{
				command: this.#command,
				binarySha256: this.#sha256,
				reasoningEffort: settings.reasoningEffort,
				serviceTier: settings.serviceTier,
				identityRoot,
				...(settings.home ? { home: true } : {}),
				...(this.#isolation ? { isolation: this.#isolation } : {}),
				...(this.#chatGptPlanAuth ? { chatGptPlanAuth: this.#chatGptPlanAuth } : {}),
			},
			idleMs,
		);
	}

	async disposeSpares(identityRoot: string): Promise<void> {
		this.#spareEfforts.delete(identityRoot);
		await disposeCloudCodexSpares(identityRoot);
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
			// One call per batch of up to 50 rows (20260929370000); each row still passes the single-row checks.
			publish: async (observations, requestSignal) =>
				assertCloudRuntimeObservationBatchReceipt(
					await this.#paths.call(
						"qorpera_record_runtime_observation_batch",
						{ p_run_id: binding.runId, p_observations: observations },
						requestSignal,
					),
					binding.runId,
					observations,
				),
		});
		const composition = observability.start("company_context");
		let stage: NativeRuntimeFailureStage = "company-context";
		let presence: CloudCompanyPathPresence | undefined;
		let isGeminiRun = false;
		let prefetchAbort: AbortController | undefined;
		let prefetchedRunHandle: CloudNativeToolRun | undefined;
		let prefetchedRunAdopted = false;
		try {
			// Both reads need only the binding: ask for them together and check them in
			// the original order, so a failure still names its stage. Since 20260930499000 only the
			// wake read takes the run mutex, so the database no longer runs them one after the other;
			// each keeps the pair's budget, down to the transport.
			const contextRequest = cloudToolRequest(
				(requestSignal) =>
					this.#paths.call(
						"qorpera_describe_company_run_context",
						{ p_binding: binding },
						requestSignal,
						CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
					),
				signal,
				CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
			);
			const wakeRequest = cloudToolRequest(
				(requestSignal) =>
					this.#paths.call(
						"qorpera_read_native_wake",
						{ p_binding: binding },
						requestSignal,
						CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
					),
				signal,
				CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
			);
			wakeRequest.catch(() => undefined);
			// Machines are offered only once a node can serve them (an enabled machine executor):
			// until then every call would only be refused. Anything but a clear yes keeps them away.
			const machinesRequest = this.#machines
				? cloudToolRequest(
						(requestSignal) => this.#paths.call("qorpera_company_machines_available", {}, requestSignal),
						signal,
					).then(
						(value) => value === true,
						() => false,
					)
				: Promise.resolve(false);
			// The agent's home, by the company's switch (20260930752000). SQL's "no home" leaves this run exactly as it is
			// today: no environment, no channel, the same tools and the same provider request. An ask that cannot work (a
			// call this host's lists or the entry point do not know, a refusal, an answer of another shape) fails the run in
			// the home's own stage: every run would meet it alike, and taken for "no home" it would switch the home off for
			// every company unseen. Only a lost answer leaves this attempt without a home, said in the host's journal: no
			// answer or a late one, a 5xx that is not PostgREST's, or PostgREST's word that the statement ended on a
			// transient SQLSTATE (a lock or statement timeout, a serialization failure, a lost connection, its pool wait).
			// Any other SQLSTATE PostgREST answers (an internal error, a missing function or relation, a violated key) fails
			// the run like a refusal: asking again changes nothing. The switch is off for most companies, so failing their
			// runs for a lost answer buys nothing, and the next attempt asks again.
			const homeRequest = this.#homeChannel
				? cloudToolRequest(
						(requestSignal) =>
							this.#paths.call("qorpera_company_home_available", { p_binding: binding }, requestSignal),
						signal,
					).then(parseCloudCompanyHome, (error: unknown) => {
						const lost =
							error instanceof CloudControlRpcEnded
								? error.sqlstate !== undefined && cloudControlTransientCode(error.sqlstate)
								: cloudControlRetryable(error);
						if (signal.aborted || !lost) throw error;
						console.error(`The agent's home was not asked (${cloudRuntimeErrorCategory(error, signal)})`);
						return undefined;
					})
				: Promise.resolve(undefined);
			homeRequest.catch(() => undefined);
			const context = parseCloudNativeCompanyContext(await contextRequest, binding);
			isGeminiRun = context.gemini !== undefined;
			// Where the agent's folder is: its folder name.
			const agentFolders = cloudAgentFolderPlace(context);
			stage = "bundle-compatibility";
			assertCloudRuntimeBundle(context.identity, this.#sha256);
			// This host's policy declares fast mode, so every run admitted under it names its tier.
			const serviceTier = context.serviceTier;
			if (!isCloudRuntimeServiceTier(serviceTier))
				throw new Error("Admitted runtime bundle is not supported by this host");
			// Every activation enters through the wake bus (contract 8): the admitted
			// occurrence's typed envelope and kernel-owned reply policy, never a job flag.
			stage = "wake-envelope";
			const wake = parseCloudWakeEnvelope(await wakeRequest, context.identity);
			// A coding session's turn is its own composition: three command tools in
			// the credential-free repository VM and two ways to end the turn. Its failures name their own stage, so a
			// timeout in a turn is never taken for one in composing a run's prompt, which the runner retries.
			if (wake.kind === "agent" && wake.source.kind === "worker-dispatch" && wake.payload.species === "coding") {
				if (!this.#coding)
					throw new Error("Coding sessions run in the coding composition, which this node does not carry");
				stage = "coding-session";
				let folder: CloudCompanyFolderClient | undefined;
				const getFolder = (): CloudCompanyFolderClient => {
					folder ??= new CloudCompanyFolderClient({
						binding,
						identity: context.identity,
						control: this.#paths,
						bytes: this.#folderBytes(binding, context.identity),
						...(this.#eventHooks ? { signedHooks: this.#eventHooks } : {}),
					});
					return folder;
				};
				const usesPrimaryCodexCoding = !isGeminiRun && wake.payload.harness !== "claude-code";
				const codingStudioVoice =
					usesPrimaryCodexCoding && !(await hasChatGptPlanDirectory(identityRoot))
						? new CloudVoiceChannel()
						: undefined;
				const [companyInterfaces, rawSurfaceSession] = await Promise.all([
					this.#loadCompanyInterfacesContext(binding, getFolder, signal),
					this.#loadSurfaceCodingBinding(binding, context, wake.payload, getFolder, signal, codingStudioVoice),
				]);
				const surfaceSession = rawSurfaceSession
					? {
							...rawSurfaceSession,
							...(companyInterfaces ? { companyInterfaces } : {}),
						}
					: undefined;
				if (this.#coding.supportsFolderWrites) getFolder();
				const codingFolderSearch = this.#folderSearch
					? new CloudFolderSearch({
							socketPath: this.#folderSearch.socketPath,
							folder: getFolder(),
							environmentId: context.identity.environmentId,
						})
					: undefined;
				const wantsCodingPictures =
					(this.#coding.supportsFolderWrites || surfaceSession?.sourceKind === "folder") &&
					!surfaceSession?.isInternalReconciliation &&
					surfaceSession?.sourceKind !== "native_ops";
				const preferredCodingImageModel: CloudRuntimeImageModel | undefined = isCloudRuntimeImageModel(
					surfaceSession?.imageModel,
				)
					? surfaceSession.imageModel
					: context.imageModel;
				const codingPictureLane = wantsCodingPictures
					? await this.#pictureLane({
							binding,
							identity: context.identity,
							identityRoot,
							preferredModel: preferredCodingImageModel,
							usesPrimaryCodexSession: usesPrimaryCodexCoding,
							signal,
						})
					: undefined;
				const attachCodingVoice =
					codingStudioVoice && surfaceSession?.sourceKind === "folder" && !surfaceSession.isInternalReconciliation
						? codingStudioVoice
						: undefined;
				composition.finish("succeeded", { outputBytes: 0 });
				try {
					return await this.#coding.execute(request, identityRoot, signal, {
						binding,
						identity: context.identity,
						wake,
						observability,
						...(folder ? { folder } : {}),
						...(companyInterfaces ? { companyInterfaces } : {}),
						...(codingFolderSearch ? { folderSearch: codingFolderSearch } : {}),
						...(this.#companyData ? { companyData: this.#companyData } : {}),
						...(surfaceSession ? { surfaceSession } : {}),
						...(attachCodingVoice ? { voice: attachCodingVoice } : {}),
						...(codingPictureLane?.channel
							? {
									pictures: codingPictureLane.channel,
									attachPicturesToCodex: codingPictureLane.attachToCodex,
								}
							: {}),
					});
				} finally {
					codingFolderSearch?.close();
					await codingPictureLane?.close();
				}
			}
			// A plain worker Claude Code does (20260930770000) is never a Codex turn: its run is the Claude Code worker's own
			// composition (slice C4c), in its own stage. A node without it refuses the run, and nothing runs on Codex.
			if (
				wake.kind === "agent" &&
				wake.source.kind === "worker-dispatch" &&
				wake.payload.species === "in-house" &&
				wake.payload.harness === "claude-code"
			) {
				stage = "claude-worker";
				if (!this.#claudeWorker || !this.#homeChannel) {
					if (!(await this.#claudeWorkerFellBack(binding, "could_not_start", [], signal)))
						throw new Error(CLAUDE_WORKER_NOT_CARRIED);
					composition.finish("succeeded", { outputBytes: 0 });
					return {
						providerSessionId: claudeWorkerSessionId({ boxFailure: "not-carried" }),
						delivery: { messageCount: 0, finalMessageId: null },
					};
				}
				const outputFolder = wake.payload.outputFolder;
				if (typeof outputFolder !== "string") throw new Error("Invalid worker dispatch wake");
				return await this.#claudeCodeWorker(identityRoot, signal, {
					binding,
					context,
					identity: context.identity,
					handle: context.folder.agent,
					wake,
					outputFolder,
					home: homeRequest,
					composition,
				});
			}
			// A light ask is its own composition too (deploy/first-node/RUNTIME-LIGHT-ASK.md §3): no tools, nothing of the
			// company read, one call to the small model, the answer stored, nothing said.
			if (wake.kind === "agent" && wake.source.kind === "light-ask") {
				stage = "native-tools";
				composition.finish("succeeded", { outputBytes: 0 });
				return await this.#lightAsk(identityRoot, signal, {
					binding,
					identity: context.identity,
					wake,
					observability,
					serviceTier,
				});
			}
			if (wake.kind === "agent" && wake.source.kind === "surface-session") {
				stage = "native-tools";
				composition.finish("succeeded", { outputBytes: 0 });
				return await this.#surfaceSessionTurn(identityRoot, signal, {
					binding,
					context,
					wake,
					observability,
					serviceTier,
				});
			}
			// A post in a conversation is the run's request (21 October 2026, item 3): the post the wake names, or a card
			// answer with its card, read whole from the history alongside the reads below. It never fails the run.
			const roomRequest = composeCloudRoomRequest(context, wake, this.#paths, binding, signal);
			roomRequest.catch(() => undefined);
			// A continuation past the context's excerpt is shown to 32 KiB, the pages after it read alongside the reads below, as
			// the run would read it first (perf sprint T7). It never fails the run.
			const continuationShown = composeCloudContinuation(context, this.#paths, binding, signal);
			continuationShown.catch(() => undefined);
			let requestSources: readonly CloudCompanyContextSource[] = [];
			const wakeControl: CloudWakeControl = {
				call: (method, argumentsValue, requestSignal) => this.#paths.call(method, argumentsValue, requestSignal),
			};
			// The connector catalog is a read that needs only the binding: it is asked for
			// alongside the context reads below instead of before them. Its failure is still
			// reported first and as its own stage, as when it was read alone.
			const connectorRequest = this.#secretBroker
				? describeCloudSecretTools(this.#paths, binding, signal)
				: Promise.resolve([]);
			connectorRequest.catch(() => undefined);
			const connectorTools = async () => {
				stage = "connector-tools";
				const descriptors = await connectorRequest;
				stage = "prompt-composition";
				return descriptors;
			};
			// Every company run is a folder-v2 run: its context names the agent's folder, and it reads and writes the
			// company's files and its state files through the folder core (core C3's thin writers,
			// RUNTIME-COMPANY-STATE-FILES.md §5). The context parser refuses a context without one (legacy sweep
			// step C, C-P9).
			const folder = {
				client: new CloudCompanyFolderClient({
					binding,
					identity: context.identity,
					control: this.#paths,
					bytes: this.#folderBytes(binding, context.identity),
					...(this.#eventHooks ? { signedHooks: this.#eventHooks } : {}),
				}),
				handle: context.folder.agent,
			};
			// Its notebook and skills, through the folder core too (P20): the same composition and tools.
			const notebooks = new CloudFolderNotebooks({
				folder: folder.client,
				runId: binding.runId,
				agentFolder: cloudAgentFolder(context.identity.companyId, context.identity.staffAgentId, agentFolders),
			});
			const compactor = new MemoryCompactChannel();
			const lane = new MemoryCompactLane();
			let connectorEffects: ReturnType<typeof cloudConnectorEffects> = new Map();
			const offlineShells = new Set<string>();
			// WHY: Overlap vault key fetch with Wave 2 folder/context reads.
			const geminiKeyRequest =
				context.gemini && this.#geminiKeys
					? openGeminiKeyForRun(
							this.#geminiKeys,
							{
								leaseId: binding.leaseId,
								runId: binding.runId,
								jobId: binding.jobId,
								runnerId: binding.runnerId,
								assignmentId: binding.assignmentId,
								credentialCapsuleId: binding.credentialCapsuleId,
								computeIdentityId: binding.computeIdentityId,
							},
							signal,
						)
					: undefined;
			geminiKeyRequest?.catch(() => undefined);
			const composeContext = async () => {
				presence = this.#presenceFactory?.(binding, context.identity, signal);
				// Only a typed, cloud-authorized file event selects an initial path.
				// Other paths become relevant through live file tools; do not guess them
				// from untrusted message text or enumerate the whole company.
				const changes =
					wake.kind === "routine" && wake.source.kind === "company-file" ? wake.payload.changes : undefined;
				const firstChange = Array.isArray(changes)
					? (changes[0] as Record<string, unknown> | undefined)
					: undefined;
				// WHY: Presence observation does not gate Wave 2 reads; run it concurrently and collect with the rest.
				const initialPresenceRequest =
					typeof firstChange?.path === "string"
						? observeCloudCompanyPathPresence(presence, firstChange.path, "object", "reading", signal)
						: Promise.resolve(undefined);
				initialPresenceRequest.catch(() => undefined);
				const gateway = new CloudCompanyPathGateway({
					binding,
					identity: context.identity,
					control: this.#paths,
				});
				// How much open work the agent has (counts only), where it keeps todos and workers:
				// a company run that is not itself a worker. Asked alongside the notebook; like
				// memory, it never blocks the run.
				const openWorkRequest =
					context.identity.audienceKind === "company" && !cloudWorkerToolFilter(wake).isWorker
						? describeCloudAgentOpenWork(binding, this.#paths, signal).catch(() => undefined)
						: Promise.resolve(undefined);
				// The platform's facts about the whole company (the company's reading of itself, 20260930765000): the
				// Co-Founder's company runs only, asked beside its open work. A failed read is null and the run goes on.
				const sensesRequest =
					context.identity.audienceKind === "company" &&
					context.agentKind === "cofounder" &&
					!cloudWorkerToolFilter(wake).isWorker
						? describeCloudCompanySenses(binding, this.#paths, signal).catch((error) => {
								if (!signal.aborted)
									console.error(
										`The company's senses were not read (${cloudRuntimeErrorCategory(error, signal)})`,
									);
								return null;
							})
						: Promise.resolve(undefined);
				const surfaceSensesRequest =
					this.#surfaceFirst &&
					this.#surfaceTools?.listSurfaceSenses &&
					context.identity.audienceKind === "company" &&
					!cloudWorkerToolFilter(wake).isWorker
						? this.#surfaceTools.listSurfaceSenses(context.identity.companyId, signal).catch((error) => {
								if (!signal.aborted)
									console.error(
										`The company's surface senses were not read (${cloudRuntimeErrorCategory(error, signal)})`,
									);
								return undefined;
							})
						: Promise.resolve(undefined);
				// Changes the agent saved from a computer that wait for review (P40): listed only where it can
				// raise a card (its own conversation or thread, not a worker), the same rule the folder core keeps.
				const proposalsRequest =
					context.identity.audienceKind === "company" &&
					context.identity.sessionId !== null &&
					!cloudWorkerToolFilter(wake).isWorker &&
					(wake.kind !== "room" || cloudWakeIsOwnThread(wake))
						? CloudFolderProposals.list(folder.client, signal)
						: Promise.resolve(undefined);
				const updatesRequest =
					context.identity.audienceKind === "company" &&
					context.agentKind === "cofounder" &&
					wake.kind === "routine" &&
					!cloudWorkerToolFilter(wake).isWorker
						? readCloudPlatformUpdates(folder.client, new Date(), signal).catch((error: unknown) => {
								if (!signal.aborted)
									console.error(
										`Platform updates were not read (${cloudRuntimeErrorCategory(error, signal)})`,
									);
								return undefined;
							})
						: Promise.resolve(undefined);
				// The agent's own notebook (contract 15.1) and its skill catalog (15.2) are
				// composed side by side through the trusted read lane; an unreadable one
				// degrades to "unavailable" and the run still starts, because neither is a
				// precondition of company work. The vision, for the head (RUNTIME-AGENT-MEMORY-TREE.md
				// §5.6), is read beside them, and so is the company's reading of itself, the head's fourth part; a failed read
				// fails the composition, as the head is never cut.
				const [memory, skills, vision, reading] = await Promise.all([
					Promise.resolve()
						.then(() =>
							composeCloudAgentMemory(
								notebooks.composition,
								cloudAgentFolder(context.identity.companyId, context.identity.staffAgentId, agentFolders),
								new Date(),
								signal,
							),
						)
						.catch((error) => {
							signal.throwIfAborted();
							return unavailableCloudAgentMemory(cloudRuntimeErrorCategory(error, signal));
						}),
					composeCloudAgentSkills(notebooks.composition, context.identity, signal, agentFolders).catch((error) => {
						signal.throwIfAborted();
						return unavailableCloudAgentSkills(cloudRuntimeErrorCategory(error, signal));
					}),
					readCloudAgentHeadVision(notebooks.composition, signal),
					this.#surfaceFirst ? Promise.resolve(null) : readCloudAgentHeadReading(notebooks.composition, signal),
				]);
				return {
					initialPresence: await initialPresenceRequest,
					gateway,
					memory,
					skills,
					vision,
					reading,
					openWork: await openWorkRequest,
					senses: mergeSurfaceSenses(await sensesRequest, await surfaceSensesRequest),
					proposals: await proposalsRequest,
					platformUpdates: await updatesRequest,
				};
			};
			const contextPromise = composeContext();
			contextPromise.catch(() => undefined);
			// WHY: Overlap tool-authority open and run-log open with Wave 2 folder/context reads.
			prefetchAbort = new AbortController();
			const runSignal = AbortSignal.any([signal, prefetchAbort.signal]);
			const prefetchedRun = CloudNativeToolRun.open(
				binding,
				this.#control,
				runSignal,
				NATIVE_AUTHORITY_LEASE_SECONDS * 1000,
			);
			prefetchedRun.then(
				(openedRun) => {
					if (prefetchAbort?.signal.aborted) openedRun.close();
					else prefetchedRunHandle = openedRun;
				},
				() => undefined,
			);
			const prefetchedLog = prefetchedRun.then((openedRun) => {
				if (
					Object.entries(context.identity).some(
						([key, value]) => openedRun.identity[key as keyof typeof openedRun.identity] !== value,
					)
				)
					throw new Error("Cloud context identity changed before execution");
				return openCloudRunLog({
					resume: new CloudRunResumeRpc({ run: openedRun, control: this.#paths }),
					folder: new CloudRunLogCompanyFolder({
						environmentId: openedRun.identity.environmentId,
						runId: binding.runId,
						folder: folder.client,
						control: this.#paths,
					}),
					log: {
						runId: binding.runId,
						protection: new CloudRunLogRpcProtection({
							environmentId: openedRun.identity.environmentId,
							jobId: binding.jobId,
							runId: binding.runId,
							call: (method, argumentsValue, requestSignal) =>
								this.#paths.call(method, argumentsValue, requestSignal),
						}),
						signal: openedRun.signal,
						// WHY: Strictly read-only parallelRead actions never mutate state and skip run-log precommit barriers.
						effectful: (tool, parsed) =>
							!isCloudParallelReadCall(tool, parsed) &&
							cloudActionEffect(tool, parsed, connectorEffects, offlineShells) !== "read",
					},
					lines: { call: compactor.call, lane },
				});
			});
			prefetchedLog.catch(() => undefined);
			const machinesAvailable = await machinesRequest;
			stage = "codex-home";
			const home = await homeRequest;
			stage = "prompt-composition";
			const {
				initialPresence,
				gateway,
				memory,
				skills,
				vision,
				reading,
				openWork,
				senses,
				proposals,
				platformUpdates,
			} = await contextPromise.catch(async (error) => {
				await connectorTools();
				throw error;
			});
			const connectorDescriptors = await connectorTools();
			signal.throwIfAborted();
			// The run's work log (RUNTIME-AGENT-MEMORY-TREE.md §4.5, W1c-3), opened with its tools: its step lines build
			// in the run's compactor lane, on threads this run's Codex session answers (§7.1), and its work composer
			// serves the agent's requests from then on (§5.7). A run without a log sends each request as Codex built it,
			// with only its receipts' work message added on a resumed attempt (20260930539000).
			const promptCacheRole = cloudWorkerToolFilter(wake).isWorker ? "worker" : context.agentKind;
			const promptCacheKeyFor = (model: string): string =>
				cloudNativePromptCacheKey(
					"company",
					context.identity.companyId,
					context.identity.staffAgentId,
					context.identity.audienceKind,
					context.identity.audienceUserId ?? "",
					promptCacheRole,
					model,
				);
			let runWork: CloudCodexContextComposer | undefined;
			const composeRun: CloudCodexContextComposer = async (request, composeSignal) => {
				const composed = runWork ? await runWork(request, composeSignal) : cloudNativeContextIdentity(request);
				return composed.promptCacheKey === undefined
					? { ...composed, promptCacheKey: promptCacheKeyFor(request.model) }
					: composed;
			};
			connectorEffects = cloudConnectorEffects(connectorDescriptors);
			// The run's admission (contract §6, M1b-4b-3), before any provider work: its binary, bundle, reasoning policy
			// and exact tool catalog. The opening binds its context to it once composed.
			let admitted: Record<string, unknown> | undefined;
			// The run's opening (§5.4), once it is admitted and before the agent's thread starts. The settle builds the lines
			// `[0, T)` is missing; the primary view and branches are then composed from the tree as stored. The context is
			// hashed, released and bound to the admission, and becomes the agent's input and developer instructions.
			// The run's tools by name, once its catalog is made (below), before its opening: its instructions fit them.
			let offeredTools: ReadonlySet<string> | undefined;
			const opening = async (openingSignal: AbortSignal): Promise<CloudCodexOpening> => {
				stage = "prompt-composition";
				let composed: CloudCodexOpening & { contextSha256: string; contextBytes: number };
				try {
					openingSignal.throwIfAborted();
					// The head (vision, job description, notebook facts) and the views hold text members and agents wrote: a
					// webhook signing secret is cut out of them before they are hashed, recorded or shown, as the tool boundary
					// cuts one out of every tool result and the composer out of the context message (E3c-2). The session cuts
					// all it sends Codex again, for any source added later.
					const composedHead = composeCloudAgentHead(context, vision, memory, reading);
					const head = { ...composedHead, text: redactCloudWebhookSecrets(composedHead.text) };
					const request = await roomRequest;
					// read_context admits the request's sources the context did not list.
					requestSources = request.flatMap((entry) => [entry.input, ...(entry.question ? [entry.question] : [])]);
					// The same source, shown further: read_context admits it by its id and hash, as before.
					const continuation = await continuationShown;
					const views = "";
					// What the instructions are composed for: the run's tools and whether the vision is agreed (T3-2).
					if (!offeredTools) throw new Error("The run's tools were not made before its opening");
					const parts = {
						head: head.text,
						views,
						tools: offeredTools,
						visionAgreed: cloudVisionAgreed(vision),
						...(this.#surfaceFirst ? { surfaceFirst: true } : {}),
					};
					const updates = offeredTools.has("record_reflection") ? platformUpdates?.context : undefined;
					const prompt = composeCloudNativeCompanyPrompt(
						{ ...context, continuation },
						wake,
						initialPresence,
						memory,
						openWork,
						skills,
						proposals?.context,
						head,
						undefined,
						request,
						updates,
						senses,
					);
					// The run's context is its head and views (in the developer instructions) and its context message, hashed
					// together.
					const text = `${head.text}\n${views}\n${prompt}`;
					const contextBytes = Buffer.byteLength(text);
					composition.finish("succeeded", { outputBytes: contextBytes });
					const contextSha256 = createHash("sha256").update(text).digest("hex");
					await notebooks.releaseComposition(contextSha256, openingSignal, [
						...(proposals?.reads ?? []),
						...(updates ? (platformUpdates?.reads ?? []) : []),
					]);
					composed = {
						prompt,
						runtimeInstructions: compileCloudNativeCompanyInstructions(context, wake, parts),
						// The tool-result rules stand inside them, after the company's files (track 3, T3-3).
						resultRulesInside: true,
						composeContext: composeRun,
						contextSha256,
						contextBytes,
					};
				} catch (error) {
					throw tagNativeRuntimeFailure(error, stage, cloudRuntimeErrorCategory(error, openingSignal));
				}
				stage = "native-tools";
				const { contextSha256, contextBytes, ...input } = composed;
				// The context is bound once, and the call writes the run's start: a lost answer is not asked again. Sent once,
				// it waits as long as the database may run it (CLOUD_RUN_ROW_READ_MS), not the 3 s and 5 s defaults: on 3 Nov
				// 2026 a run failed its admission while the database answered every caller in 3 to 6.6 s for 8 s.
				const admission = admitted;
				if (!admission) throw new Error("Native execution admission was not confirmed");
				const started = await cloudToolRequest(
					(requestSignal) =>
						this.#paths.call(
							"qorpera_bind_native_company_context",
							{ p_binding: binding, p_context_sha256: contextSha256, p_context_bytes: contextBytes },
							requestSignal,
							CLOUD_RUN_ROW_READ_MS,
						),
					openingSignal,
					CLOUD_RUN_ROW_READ_MS,
				);
				confirmNativeAdmission(started, {
					...admission,
					schema: "qorpera.native-company-execution-start/v1",
					contextSha256,
					contextBytes,
				});
				return input;
			};
			// The run, once its tools are made: a send and a card are asked again through it (below).
			let toolRun: CloudNativeToolRun | undefined;
			/* A write of the run's public voice: a send, or a card's append. Both are safe to repeat (a send replays by
			 * its idempotency key, a card by its event id), and both take the run's row. So each try waits as long as the
			 * database may run it, and a lost or late answer is asked again while the run's authority holds
			 * (cloudRunRowWrite). One try of 5 s used to stand here: a database slower than that left the model with
			 * "outcome unconfirmed" for a message that may have been stored, and a model that did not repeat the call
			 * failed its run as one that never answered (reliability audit, 10 November 2026, A5). `toolSignal` is the
			 * tool call's own: once the boundary has closed, nothing more is asked, though the run is still being closed. */
			const publicWrite = <T>(
				write: (requestSignal: AbortSignal) => Promise<T>,
				toolSignal: AbortSignal | undefined,
			): Promise<T> =>
				toolSignal
					? withAbortScopes([signal, toolSignal], (combined) => cloudRunRowWrite(toolRun, write, combined))
					: cloudRunRowWrite(toolRun, write, signal);
			const mouth = new CloudAgentMouth(
				binding.runId,
				async (input, toolSignal) => {
					if (context.identity.sessionId === null) throw new Error("This run has no conversation recipient");
					const receipt = await publicWrite(
						(requestSignal) => this.#control.sendMessage(request, input, requestSignal),
						toolSignal,
					);
					if (receipt.sessionId !== context.identity.sessionId) throw new Error("Cloud send audience changed");
					return receipt;
				},
				signal,
			);
			// Diagnostic deduplication uses only validated public receipts, never a model key.
			const deliveredMessageIds = new Set<string>();
			// A dynamic routine's run decides its next run (or concludes the routine) before
			// its final message. The kernel refuses both the final send and the completion
			// otherwise; this shows the model the reason instead of an unconfirmed outcome.
			const dynamicRoutine = wake.kind === "routine" && wake.routine?.dynamic === true;
			let routineDecisionOwed = dynamicRoutine;
			const assertRoutineDecided = (): void => {
				if (routineDecisionOwed)
					throw new CloudToolArgumentRefusal(
						"decide this dynamic routine first: call decide_routine with next or conclude (it answers settled if the routine already changed elsewhere), then send your final message",
					);
			};
			const send: CloudNativeTool = {
				name: "send_message" satisfies CloudRuntimeToolOperation,
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
					if (input.phase === "final") assertRoutineDecided();
					return { idempotencyKey: input.idempotencyKey, text: input.text, phase: input.phase };
				},
				async execute(value, context) {
					const input = parseCloudAgentSendInput(value);
					const receipt = await mouth.send(input, context.signal);
					const replayed = deliveredMessageIds.has(receipt.messageId);
					deliveredMessageIds.add(receipt.messageId);
					const text = JSON.stringify(receipt);
					context.observation?.finish(replayed ? "replayed" : "succeeded", {
						outputBytes: Buffer.byteLength(text),
					});
					// Contract 7.1: the final send is the member's answer. Nothing after it reaches them; only the run's
					// bookkeeping still runs (the tool boundary, the 2026-11-13 amendment).
					return { kind: "text", value: text, completesTurn: input.phase === "final" };
				},
			};
			// A typed card for the member: appended under the run's lease authority, then
			// the final send of its sentence. The card precedes the sentence so a failed
			// send leaves a retryable tool call, never a turn that ended without its card.
			const control = this.#control;
			const askAgainRefusals = new CloudControlRefusalRelay();
			const ask: CloudNativeTool = {
				name: "ask_member" satisfies CloudRuntimeToolOperation,
				source: "runtime",
				// The Gmail draft's steps only where the run has Gmail's tools (a connection made before 10 November 2026).
				description: cloudAskMemberInstructions(
					connectorDescriptors.some((descriptor) => descriptor.toolName === "gmail_get_profile"),
				),
				inputSchema: CLOUD_ASK_MEMBER_INPUT_SCHEMA,
				parseArguments(value) {
					const input = parseCloudAskMemberInput(value);
					// A card ends with its final sentence, so it waits for the decision too.
					assertRoutineDecided();
					return { idempotencyKey: input.idempotencyKey, text: input.text, ...input.data } as JsonValue;
				},
				async execute(value, toolContext) {
					const input = parseCloudAskMemberInput(value);
					const eventId = cloudInteractionEventId(binding.runId, input.idempotencyKey);
					// The sentence's send is derived and checked before the card exists: every accepted
					// key can finish its turn, and a retry replays both the card and the same send.
					const sentence = parseCloudAgentSendInput({
						idempotencyKey: cloudAskMemberFinalKey(input.idempotencyKey),
						text: input.text,
						phase: "final",
					});
					const append = control.appendInteractionRequest;
					if (!append) throw new Error("Cloud cards are unavailable on this control plane");
					const write = () =>
						publicWrite(
							(requestSignal) => append.call(control, request, { eventId, data: input.data }, requestSignal),
							toolContext.signal,
						);
					// WHY: the kernel refuses an asksAgain it cannot link, in words the agent must read to raise the card
					// without it; the append is the tool's first effect, so its refusal proves no card was written.
					const card =
						"asksAgain" in input.data.payload
							? await askAgainRefusals.call(input.idempotencyKey, write)
							: await write();
					if (card.sessionId !== context.identity.sessionId) throw new Error("Cloud card audience changed");
					const receipt = await mouth.send(sentence, toolContext.signal);
					const replayed = deliveredMessageIds.has(receipt.messageId);
					deliveredMessageIds.add(receipt.messageId);
					const text = JSON.stringify({
						schema: "qorpera.interaction-receipt/v1",
						interactionId: card.interactionId,
						surface: input.data.surface,
						sequence: card.sequence,
						messageId: receipt.messageId,
					});
					toolContext.observation?.finish(replayed ? "replayed" : "succeeded", {
						outputBytes: Buffer.byteLength(text),
					});
					return { kind: "text", value: text, completesTurn: true };
				},
			};
			let pictureLane: ResolvedRunPictureLane | undefined;
			try {
				stage = "native-tools";
				// A worker's report, once the folder saved it: its run's closing act (turnCorrection, below).
				let workerReported = false;
				let geminiSession:
					| {
							readonly model: NonNullable<CloudNativeCompanyContext["gemini"]>["model"];
							readonly effort: NonNullable<CloudNativeCompanyContext["gemini"]>["effort"];
							readonly apiKey: string;
							readonly apiBaseUrl?: string;
							readonly allowLoopback?: boolean;
							readonly fetch?: typeof fetch;
							readonly initialSpendMicrodollars: number;
							readonly monthlyCapCents: number | null;
							readonly onUsage: (
								usage: {
									readonly inputTokens: number;
									readonly cachedTokens: number;
									readonly outputTokens: number;
								},
								requestSignal: AbortSignal,
							) => Promise<GeminiUsageReceipt | undefined>;
					  }
					| undefined;
				if (context.gemini) {
					if (!geminiKeyRequest)
						throw new Error(
							"Gemini 4 Neon conversations require the company vault, which this host does not carry; nothing ran on Codex",
						);
					const openedKey = await geminiKeyRequest;
					if (openedKey.state === "refused") {
						if (openedKey.reason === "CAP_REACHED") {
							throw tagNativeRuntimeFailure(
								new GeminiCapReachedError(openedKey.monthlyCapCents, openedKey.monthSpendMicrodollars),
								"native-tools",
								"budget_exhausted",
							);
						}
						throw tagNativeRuntimeFailure(new GeminiKeyRevokedError(), "native-tools", "authority_unavailable");
					}
					geminiSession = {
						model: context.gemini.model,
						effort: context.gemini.effort,
						apiKey: openedKey.apiKey,
						...(this.#geminiApiBaseUrl ? { apiBaseUrl: this.#geminiApiBaseUrl } : {}),
						...(this.#geminiAllowLoopback ? { allowLoopback: true } : {}),
						...(this.#geminiFetch ? { fetch: this.#geminiFetch } : {}),
						initialSpendMicrodollars: openedKey.monthSpendMicrodollars,
						monthlyCapCents: openedKey.monthlyCapCents,
						onUsage: async (usage, requestSignal) => {
							const recorded = (await this.#paths.call(
								"qorpera_record_gemini_run_usage",
								{ p_binding: binding, p_usage: usage },
								requestSignal,
							)) as {
								monthSpendMicrodollars?: unknown;
								monthlyCapCents?: unknown;
								capReached?: unknown;
							} | null;
							if (
								!recorded ||
								typeof recorded.monthSpendMicrodollars !== "number" ||
								(recorded.monthlyCapCents !== null && typeof recorded.monthlyCapCents !== "number") ||
								typeof recorded.capReached !== "boolean"
							)
								return undefined;
							return {
								monthSpendMicrodollars: recorded.monthSpendMicrodollars,
								monthlyCapCents: recorded.monthlyCapCents,
								capReached: recorded.capReached,
							};
						},
					};
				}
				pictureLane = await this.#pictureLane({
					binding,
					identity: context.identity,
					identityRoot,
					preferredModel: context.imageModel,
					usesPrimaryCodexSession: !isGeminiRun,
					...(geminiSession ? { existingGeminiApiKey: geminiSession.apiKey } : {}),
					geminiFallbackAllowed: isGeminiRun,
					signal,
				});
				const pictures = pictureLane.channel;
				const voice =
					!isGeminiRun && !(await hasChatGptPlanDirectory(identityRoot)) ? new CloudVoiceChannel() : undefined;
				prefetchedRunAdopted = true;
				const result = await runCloudNativeRunToolSession({
					observability,
					binding,
					serviceTier,
					controlPlane: this.#control,
					prefetchedRun,
					...(geminiSession ? { gemini: geminiSession } : {}),
					beginExecution: async (specification, requestSignal) => {
						const toolCatalogText = cloudToolJsonText(specification, CLOUD_NATIVE_TOOL_CATALOG_BYTES);
						// Sent once, it waits as long as the database may run it, as the bind below does.
						const answer = await this.#paths.call(
							"qorpera_begin_native_company_execution_v3",
							{
								p_binding: binding,
								p_binary_sha256: this.#sha256,
								p_runtime_bundle_sha256: context.identity.runtimeBundleSha256,
								p_reasoning_policy_sha256: context.identity.reasoningPolicySha256,
								p_tool_catalog_text: toolCatalogText,
							},
							requestSignal,
							CLOUD_RUN_ROW_READ_MS,
						);
						const admission = {
							runId: binding.runId,
							jobId: binding.jobId,
							leaseId: binding.leaseId,
							binarySha256: this.#sha256,
							runtimeBundleSha256: context.identity.runtimeBundleSha256,
							reasoningEffort: context.identity.reasoningEffort,
							reasoningPolicySha256: context.identity.reasoningPolicySha256,
							toolCatalogSha256: createHash("sha256").update(toolCatalogText).digest("hex"),
						};
						confirmNativeAdmission(answer, {
							schema: "qorpera.native-company-execution-admission/v1",
							...admission,
						});
						admitted = admission;
					},
					opening,
					// The compactor serves the run's log too; the conversation's lines close after the agent's turn.
					compactor,
					...(pictures && pictureLane.attachToCodex ? { pictures } : {}),
					...(voice ? { voice } : {}),
					// The turn completed: when it left the run's closing act undone (its final send, a worker's report, a
					// dynamic routine's decision), the model is told so in one more turn, once. What that turn leaves undone
					// fails the run as before (mouth.finish below; the kernel, for a report or a decision).
					turnCorrection: async () => {
						const sent = await mouth.settled();
						const worker = cloudWorkerToolFilter(wake).isWorker;
						const canSend = context.identity.sessionId !== null && wake.policy.final !== "forbidden";
						return cloudNativeTurnCorrection({
							worker,
							reported: workerReported,
							canSend,
							finalRequired: wake.policy.final === "required",
							sent: sent.messageCount,
							final: sent.final,
							// As the tools below offer it.
							askOffered: canSend && !worker && (wake.kind !== "room" || cloudWakeIsOwnThread(wake)),
							routineDecisionOwed,
						});
					},
					command: this.#command,
					binarySha256: this.#sha256,
					identityRoot,
					...(this.#spareEfforts.has(identityRoot) ? { reusedIdentityRoot: true } : {}),
					isolation: this.#isolation,
					// The agent's home (slice 1): built only when this company's switch is on AND this agent has a
					// machine running. The review and the work log are handed to it where they are built, below.
					...(home && this.#homeChannel && !isGeminiRun
						? {
								home: (input: {
									review: CloudCodexHomeReview;
									log: CloudRunLog | undefined;
									signal: AbortSignal;
								}) =>
									new CloudCodexHome({
										channel: this.#homeChannel!(binding),
										sessionId: randomUUID(),
										machine: { id: home.machineId, name: home.machine },
										review: input.review,
										...(input.log ? { steps: new CloudCodexHomeSteps(input.log) } : {}),
										// The run's session is ended in SQL when the run ends, however it ended, so its
										// next attempt opens its own instead of meeting this one (review round 1, F10).
										// A close that fails does not fail the run, whose work is done (F10), but it is said
										// in the host's journal, so a close no call reaches is never silent.
										endSession: async (sessionId, reason) => {
											await withAbortScopes(
												[],
												async (closing) => {
													try {
														await this.#paths.call(
															"qorpera_close_home_session",
															{ p_binding: binding, p_session_id: sessionId, p_reason: reason },
															closing,
														);
													} catch (error) {
														console.error(
															`The agent's home session was not closed (${cloudRuntimeErrorCategory(error, closing)})`,
														);
														throw error;
													}
												},
												CLOUD_HOME_CLOSE_MS,
											);
										},
										signal: input.signal,
									}),
							}
						: {}),
					...(this.#chatGptPlanAuth ? { chatGptPlanAuth: this.#chatGptPlanAuth } : {}),
					signal,
					timeoutMs: this.#timeoutMs,
					// Auto-review (v130): acting calls wait for the reviewer, or for a member's approval.
					// A call a member is likely watching (their message, their post in the thread, a
					// first run) holds on its card for a while; routines and coworker wakes park at once.
					actionReview: (reviewer) =>
						new CloudActionReviewGate({
							binding,
							control: {
								call: (method, argumentsValue, requestSignal) =>
									this.#paths.call(method, argumentsValue, requestSignal),
							},
							reviewer,
							...(isGeminiRun ? { reviewerModel: GEMINI_ACTION_REVIEW_MODEL } : {}),
							request: cloudActionReviewRequest(context, wake),
							// What the agent works for, from its files as this run read them: a run no member started is
							// judged by it (2026-10-22 amendment, item 2). A vision too large to read as text is left out.
							mandate: cloudActionReviewMandate(context, wake, vision && "text" in vision ? vision.text : null, {
								surfaceFirst: this.#surfaceFirst,
							}),
							holdMs: ["human", "room", "first-run"].includes(wake.kind) ? CLOUD_ACTION_REVIEW_HOLD_MS : 0,
							connectorEffects,
							offlineShells,
							facts: {
								coworkers: new Map(context.coworkers.map((coworker) => [coworker.id, coworker.name])),
								timeZone: wake.time.timeZone,
							},
							observability,
						}),
					tools: async (identity, operations, run) => {
						if (
							Object.entries(context.identity).some(
								([key, value]) => identity[key as keyof typeof identity] !== value,
							)
						)
							throw new Error("Cloud context identity changed before execution");
						// Before any provider request: a resumed attempt reads its earlier work first (W5b-2), or, in Agent
						// notebooks, the run's receipts (20260930539000). The log steps a call as auto-review classifies
						// it. A log made once and no longer there ends the run, as it does mid-run.
						const opened = await prefetchedLog.catch((error: unknown) => {
							throw error instanceof CloudRunLogGone
								? tagNativeRuntimeFailure(error, "native-tools", "authority_unavailable")
								: error;
						});
						runWork = opened?.composeContext;
						// The node's folder search (F3, "Light threads"): a run on a host that has it. A worker gets it
						// too: it only reads.
						const folderSearch = this.#folderSearch
							? new CloudFolderSearch({
									socketPath: this.#folderSearch.socketPath,
									folder: folder.client,
									environmentId: identity.environmentId,
								})
							: undefined;
						// Contract 13: a worker reads, works and reports to its parent. It has no mouth, no
						// coworker channel and no delegation; an ordinary company run is the dispatcher.
						const work = cloudWorkerToolFilter(wake);
						// From here a send and a card are asked again through the run (publicWrite).
						toolRun = run;
						// Machines are the company's: one gateway for the run's machine tools and for share_app, which starts
						// its link program on the machine itself (v195).
						const machineGateway =
							this.#machines && machinesAvailable && identity.audienceKind === "company"
								? this.#machines(binding)
								: undefined;
						const surfaceFilePolicy: SurfaceFilePolicy | undefined =
							this.#surfaceFirst && identity.audienceKind === "company"
								? work.isWorker
									? { mode: "worker" }
									: {
											mode: "cofounder",
											allowExplicitMemberDoc: memberExplicitlyRequestedDocument(context, wake),
										}
								: undefined;
						const runTools: CloudNativeTool[] = [
							// A run's file tools act through the folder core with its own authority (P19), and so do the
							// tools that read and write its interfaces and tables (Interfaces I8a, I8b).
							...[
								...cloudFolderFileTools({
									folder: folder.client,
									operations,
									identity,
									...(surfaceFilePolicy ? { surfaceFilePolicy } : {}),
								}),
								...cloudInterfaceTools({
									folder: folder.client,
									identity,
									timeZone: wake.time.timeZone,
								}),
								...cloudInterfaceWriteTools({ folder: folder.client, operations, identity }),
								// Interface apps: pages the agent makes to show members its work (5 November 2026).
								...(this.#surfaceFirst ? [] : cloudAppTools({ folder: folder.client, operations, identity })),
								// A picture the agent makes, saved in the folder as a write is (20260930746000).
								...(pictures
									? [cloudPictureTool({ folder: folder.client, operations, identity, pictures })]
									: []),
								...(voice && machineGateway
									? [
											cloudNarrateAppTool({
												binding,
												identity,
												control: this.#paths,
												folder: folder.client,
												operations,
												machines: { gateway: machineGateway, operations },
												voice,
											}),
										]
									: []),
								// No wall (the founder, 14 November 2026: "rather drop the wall - it's the wrong medium for
								// activity"): update_wall is offered to no run; a member learns work has started from the
								// run's short first message, and what waits on a member is a card.
							].filter(work.companyFile),
							...(folderSearch
								? [
										cloudFolderSearchTool({
											search: folderSearch,
											folder: folder.client,
											runId: identity.runId,
										}),
									]
								: []),
							// The company's databases (slice 5), on a host that names the data gateway's run door: every
							// run describes and asks them; a worker does not apply steps.
							...(this.#companyData
								? cloudDataTools({
										folder: folder.client,
										door: this.#companyData,
										apply: !work.isWorker,
										onDataChanged: async (event, requestSignal) => {
											await this.#paths.call(
												"qorpera_folder_emit_data_change_wakes",
												{
													p_binding: binding,
													p_database: event.database,
													p_event: event.payload,
												},
												requestSignal,
											);
										},
									})
								: []),
							cloudCompanyContextTool(context, binding, this.#paths, () => requestSources),
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
							// The company's own website accounts (A1-4): not a worker's. They serve companies on the
							// company folder (A1-7, migration 20260930072000), whose vault writes their connection files.
							...(this.#companyAccounts && !work.isWorker
								? [
										cloudCompanyAccountTool({
											binding,
											identity,
											control: this.#paths,
											operations,
											accounts: this.#companyAccounts,
										}),
									]
								: []),
							...(work.isWorker
								? []
								: [
										cloudCoworkerMessageTool(binding, identity, wakeControl),
										...cloudRoutineTools(
											binding,
											identity,
											dynamicRoutine && wake.routine?.routineKey
												? {
														routineKey: wake.routine.routineKey,
														decisionOwed: () => routineDecisionOwed,
														settled: () => {
															routineDecisionOwed = false;
														},
													}
												: undefined,
											new CloudFolderRoutines({
												folder: folder.client,
												operations,
												identity,
												handle: folder.handle,
												// The routine that woke this run, which it may not pause or remove.
												...(wake.kind === "routine" && wake.routine
													? { ownRoutineId: wake.routine.id }
													: {}),
											}),
										),
										// The wake bus gives a routine its key exactly when it is dynamic, so every dynamic
										// routine's run is offered the decision.
										...(dynamicRoutine && wake.routine?.routineKey
											? [
													cloudRoutineDecisionTool(binding, identity, {
														decisionOwed: () => routineDecisionOwed,
														decided: () => {
															routineDecisionOwed = false;
														},
														folderDecision: new CloudFolderRoutineDecision({
															folder: folder.client,
															operations,
															identity,
															handle: folder.handle,
															routineKey: wake.routine.routineKey,
															routineId: wake.routine.id,
														}),
													}),
												]
											: []),
										...(this.#surfaceFirst
											? []
											: cloudSidebarTools(binding, identity, {
													folderSidebar: new CloudFolderSidebar({
														folder: folder.client,
														operations,
														identity,
														// The Co-Founder stays on top, outside the sections.
														people: new Map(
															[
																...(context.agentKind === "cofounder" ? [] : [context.agent]),
																...context.coworkers,
															].map((agent) => [agent.id, agent.name]),
														),
														peopleComplete: !context.coworkersTruncated,
													}),
												})),
										// The apps drawer's groups, the twin of the sidebar's sections (APP-GROUPS-SPEC §3).
										...(this.#surfaceFirst
											? []
											: [cloudAppGroupsTool({ folder: folder.client, operations, identity })]),
										...cloudReviewRuleTools(binding, identity, this.#paths),
										// Good will (20260930566000): last month's payments and sorting them, the Co-Founder's until
										// an agent owns the company's money.
										...cloudGoodWillTools(binding, identity, this.#paths),
										// The Co-Founder deals the team out between the members (20260930702000).
										...(context.agentKind === "cofounder" && !this.#surfaceFirst
											? cloudMemberOfferTools(binding, identity, this.#paths)
											: []),
										...(context.agentKind === "cofounder" && identity.audienceKind === "company"
											? [cloudRecordReflectionTool({ folder: folder.client, operations, identity })]
											: []),
										...(context.agentKind === "cofounder" &&
										identity.audienceKind === "company" &&
										!this.#surfaceFirst
											? [
													cloudReadingTool(
														identity,
														new CloudFolderReading({
															folder: folder.client,
															operations,
															identity,
															members: cloudCompanyMembers(binding, this.#paths),
														}),
													),
												]
											: []),
										// The agent changes the company's hooks through its folder client (E3a).
										...cloudEventTools(binding, identity, this.#paths, folder.client),
										// Company sites (20260930550000): a static website from the company folder at a
										// private, password-protected link, and taking one offline; private app links (v195): one
										// port of an always-on machine at such a link (share_app).
										...cloudSiteTools({
											binding,
											identity,
											control: this.#paths,
											folder: folder.client,
											...(machineGateway ? { machines: { gateway: machineGateway, operations } } : {}),
										}),
									]),
							// Machines are the company's: any agent run in a company conversation may start and
							// use them and hears about them in that conversation; a worker uses them like its agent
							// but waits for its own commands in its run (Jonas, 2026-09-28).
							...(machineGateway
								? cloudMachineTools({
										binding,
										identity,
										control: this.#paths,
										operations,
										gateway: machineGateway,
										worker: work.isWorker,
										...(this.#codingValues ? { codingValues: this.#codingValues } : {}),
										...(this.#companyAccounts ? { accountFills: true } : {}),
									})
								: []),
							// The notebook is the agent's own: a worker of the same agent recalls it,
							// and writes to it only when its dispatch allows Company File writes.
							...notebooks
								.tools((files) => cloudMemoryTools(files, identity, agentFolders), operations)
								.filter(
									(tool) =>
										tool.name === "recall_memory" || work.companyFile({ ...tool, name: "company_write" }),
								),
							// Skills the same way: every run reads and searches them. Only a company run saves one
							// (a member's private conversation never feeds a shared library), and a worker only
							// when its dispatch allows Company File writes.
							...notebooks
								.tools((files) => cloudSkillTools(files, identity, agentFolders), operations)
								.filter(
									(tool) =>
										tool.name !== "update_skill" ||
										(identity.audienceKind === "company" &&
											work.companyFile({ ...tool, name: "company_write" })),
								),
							...(identity.audienceKind === "company"
								? [
										...(work.isWorker || this.#surfaceFirst
											? []
											: cloudHiringTools(identity, {
													folderHiring: new CloudFolderHiring({
														folder: folder.client,
														operations,
														identity,
													}),
													folderGroupChats: new CloudFolderGroupChats({
														folder: folder.client,
														operations,
														identity,
													}),
												})),
										...cloudWorkerTools(binding, identity, wake, {
											machines: Boolean(this.#machines) && machinesAvailable,
											folderTodos: new CloudFolderTodos({
												folder: folder.client,
												operations,
												identity,
												handle: folder.handle,
											}),
											folderWorkers: new CloudFolderWorkers({
												folder: folder.client,
												operations,
												identity,
												handle: folder.handle,
												// A worker run's own folder, where it reports.
												...(work.isWorker && typeof wake.payload.outputFolder === "string"
													? { outputFolder: wake.payload.outputFolder }
													: {}),
											}),
										}).map(
											(tool): CloudNativeTool =>
												tool.source === "worker" && tool.name === "report_work"
													? {
															...tool,
															// The worker's saved report is noted: a turn that ends without one is asked for it.
															execute: async (value, toolContext) => {
																const content = await tool.execute(value, toolContext);
																if (content.completesTurn === true) workerReported = true;
																return content;
															},
														}
													: tool,
										),
										// The company's code kept in Qorpera (20260930720000): an agent's own run takes a change
										// out of main again and describes one; a worker reports to its agent instead.
										...(work.isWorker ? [] : cloudCodeTools({ folder: folder.client, identity })),
										...(work.isWorker || !this.#surfaceTools
											? []
											: [
													createProposeSurfaceTool(this.#surfaceTools),
													createStartSurfaceSessionTool({
														startSurfaceSession: (sessionRequest, toolContext) =>
															this.#surfaceTools!.startSurfaceSession(
																{
																	...sessionRequest,
																	ownerLabel:
																		sessionRequest.ownerLabel ??
																		(context.agentKind === "cofounder"
																			? "Co-Founder"
																			: context.agent.name),
																},
																toolContext,
															),
													}),
													...(this.#surfaceTools.manageAutomation
														? [
																createManageSurfaceAutomationTool(identity.companyId, {
																	manageAutomation: (companyId, automationRequest, toolContext) =>
																		this.#surfaceTools!.manageAutomation!(
																			companyId,
																			automationRequest,
																			toolContext,
																		),
																}),
															]
														: []),
												]),
									]
								: []),
							...(identity.sessionId && wake.policy.final !== "forbidden" ? [send] : []),
							// Cards belong to a member's own conversation or the agent's own thread:
							// never a group chat, never a worker. The kernel refuses the rest too.
							...(identity.sessionId &&
							wake.policy.final !== "forbidden" &&
							(wake.kind !== "room" || cloudWakeIsOwnThread(wake)) &&
							!work.isWorker
								? [ask]
								: []),
							// Listed only for a run that may raise their cards (composeContext).
							...(proposals ? proposals.tools(operations) : []),
						];
						// Every tool stays the run's; its catalog describes in full those its kind uses most, and more_tools
						// lists and opens the rest (T3-6).
						const offered = cloudToolsOnDemand(
							runTools,
							work.isWorker ? "worker" : context.agentKind === "cofounder" ? "cofounder" : "employee",
						);
						// Its instructions say only what fits these tools (track 3, T3-2): every one it has, also those it opens
						// on demand, and more_tools, which tells it where those are.
						offeredTools = new Set(offered.tools.map((tool) => tool.name));
						return {
							tools: offered.tools,
							deferred: offered.deferred,
							assertContext: (requestSignal, timeoutMs) =>
								gateway.assertReadableContext(requestSignal, timeoutMs),
							checkRun: (requestSignal, timeoutMs) => gateway.checkRun(requestSignal, timeoutMs),
							recordContextView: (frame, outputs, requestSignal) =>
								gateway.recordContextView(frame, outputs, requestSignal),
							fenceContextView: (frame, outputs, requestSignal) =>
								gateway.fenceContextView(frame, outputs, requestSignal),
							...(folderSearch
								? {
										close: async () => {
											folderSearch.close();
										},
									}
								: {}),
							...(opened?.log ? { runLog: { log: opened.log, lines: opened.lines } } : {}),
						};
					},
				});
				// The provider failed the turn after the run's answer: the run is delivered, and what it met is still the
				// login's to know, as for a failed run (contract 17; the 2026-11-13 amendment). Recorded first, so nothing
				// after it can lose it.
				if (result.usageSignal && !isGeminiRun) await this.#recordUsageSignalKind(binding, result.usageSignal);
				stage = "public-completion";
				const delivery = await mouth.finish(wake.policy.final === "required");
				if (!isGeminiRun)
					this.#rememberSpareEffort(identityRoot, {
						reasoningEffort: context.identity.reasoningEffort,
						serviceTier,
						home: Boolean(home && this.#homeChannel),
					});
				return { providerSessionId: result.providerSessionId, delivery };
			} finally {
				await pictureLane?.close();
				await mouth.close();
			}
		} catch (error) {
			composition.finish("failed", { errorCategory: cloudRuntimeErrorCategory(error, signal) });
			if (isGeminiRun) {
				if (error instanceof GeminiCapReachedError) {
					await this.#recordGeminiCapReached(binding);
				} else {
					const geminiError = geminiProviderErrorCode(error);
					if (geminiError) await this.#recordGeminiKeyError(binding, geminiError);
				}
			} else {
				await this.#recordUsageSignal(binding, error);
			}
			throw tagNativeRuntimeFailure(error, stage, cloudRuntimeErrorCategory(error, signal));
		} finally {
			if (!prefetchedRunAdopted) {
				prefetchAbort?.abort();
				prefetchedRunHandle?.close();
			}
			await presence?.close().catch(() => undefined);
			await observability.close();
		}
	}

	/**
	 * A light ask's run (deploy/first-node/RUNTIME-LIGHT-ASK.md §3; migration 20260930761000). The wake carries a kind
	 * and that kind's input. The run is admitted with an empty tool catalog (the cloud takes no other for it), binds its
	 * one question as its context, asks the small model once on a tool-less side thread, and stores the answer. It reads
	 * nothing of the company and sends nothing: the wake's policy forbids a send, and the run has no conversation.
	 * - No answer is stored as none, and the run still ends: a kind or an input this bundle does not answer, an ask past
	 *   its time, a reply that is no answer, or no reply. The run never asks twice.
	 * - The payer's usage limit or a rate limit, met by the one call, is the login's to know (contract 17), recorded
	 *   after the answer is stored. What stops the run itself (its lease, its authority, a stop) fails it as any run.
	 */
	async #lightAsk(
		identityRoot: string,
		signal: AbortSignal,
		run: {
			binding: CloudNativeToolBinding;
			identity: CloudNativeToolIdentity;
			wake: CloudWakeEnvelope;
			observability: CloudRuntimeObservability;
			serviceTier: CloudRuntimeServiceTier;
		},
	): Promise<{ providerSessionId: string; delivery: { messageCount: number; finalMessageId: string | null } }> {
		const { binding, identity, wake, observability, serviceTier } = run;
		const gateway = new CloudCompanyPathGateway({ binding, identity, control: this.#paths });
		const call = composeCloudLightAsk(wake.payload.kind, wake.payload.input);
		const expiresAt = typeof wake.payload.expiresAt === "string" ? Date.parse(wake.payload.expiresAt) : Number.NaN;
		// The run's context is its one question, or the fact that there is none to ask.
		const question = call ? `${call.instructions}\n${call.text}` : "A light ask this runtime does not answer.";
		const contextSha256 = createHash("sha256").update(question).digest("hex");
		const contextBytes = Buffer.byteLength(question);
		let admitted: Record<string, unknown> | undefined;
		let usageSignal: NativeProviderUsageSignal | undefined;
		let toolRun: CloudNativeToolRun | undefined;
		const result = await runCloudNativeRunToolSession({
			observability,
			binding,
			serviceTier,
			controlPlane: this.#control,
			beginExecution: async (specification, requestSignal) => {
				const toolCatalogText = cloudToolJsonText(specification, CLOUD_NATIVE_TOOL_CATALOG_BYTES);
				const answer = await this.#paths.call(
					"qorpera_begin_native_company_execution_v3",
					{
						p_binding: binding,
						p_binary_sha256: this.#sha256,
						p_runtime_bundle_sha256: identity.runtimeBundleSha256,
						p_reasoning_policy_sha256: identity.reasoningPolicySha256,
						p_tool_catalog_text: toolCatalogText,
					},
					requestSignal,
					CLOUD_RUN_ROW_READ_MS,
				);
				const admission = {
					runId: binding.runId,
					jobId: binding.jobId,
					leaseId: binding.leaseId,
					binarySha256: this.#sha256,
					runtimeBundleSha256: identity.runtimeBundleSha256,
					reasoningEffort: identity.reasoningEffort,
					reasoningPolicySha256: identity.reasoningPolicySha256,
					toolCatalogSha256: createHash("sha256").update(toolCatalogText).digest("hex"),
				};
				confirmNativeAdmission(answer, { schema: "qorpera.native-company-execution-admission/v1", ...admission });
				admitted = admission;
			},
			// No tool: a light ask acts on nothing.
			tools: (_identity, _operations, opened) => {
				toolRun = opened;
				return {
					tools: [],
					assertContext: (requestSignal, timeoutMs) => gateway.assertReadableContext(requestSignal, timeoutMs),
					checkRun: (requestSignal, timeoutMs) => gateway.checkRun(requestSignal, timeoutMs),
					recordContextView: (frame, outputs, requestSignal) =>
						gateway.recordContextView(frame, outputs, requestSignal),
					fenceContextView: (frame, outputs, requestSignal) =>
						gateway.fenceContextView(frame, outputs, requestSignal),
				};
			},
			light: async (ask, lightSignal) => {
				// The context is bound once, and the call writes the run's start: a lost answer is not asked again.
				const admission = admitted;
				if (!admission) throw new Error("Native execution admission was not confirmed");
				const started = await cloudToolRequest(
					(requestSignal) =>
						this.#paths.call(
							"qorpera_bind_native_company_context",
							{ p_binding: binding, p_context_sha256: contextSha256, p_context_bytes: contextBytes },
							requestSignal,
							CLOUD_RUN_ROW_READ_MS,
						),
					lightSignal,
					CLOUD_RUN_ROW_READ_MS,
				);
				confirmNativeAdmission(started, {
					...admission,
					schema: "qorpera.native-company-execution-start/v1",
					contextSha256,
					contextBytes,
				});
				let answer: string | null = null;
				// Past its time nothing is asked: the member no longer waits for it.
				if (call && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
					try {
						answer = call.answer(await ask(call.instructions, call.text, lightSignal));
					} catch (error) {
						// The run was stopped, or its process is gone: that is the run's failure, not the ask's.
						if (lightSignal.aborted) throw error;
						if (error instanceof MemoryCompactStop) {
							if (error.reason === "usage-limit") usageSignal = "usage_limit";
							else if (error.reason === "rate-limit") usageSignal = "rate_limited";
						}
					}
				}
				// Stored once (the first call decides, a repeat answers what stands), so a lost answer is asked again while
				// the run's authority holds.
				await cloudRunRowWrite(
					toolRun,
					(requestSignal) =>
						this.#paths.call(
							"qorpera_native_light_ask_answer",
							{ p_binding: binding, p_answer: answer },
							requestSignal,
						),
					lightSignal,
				);
			},
			command: this.#command,
			binarySha256: this.#sha256,
			identityRoot,
			...(this.#spareEfforts.has(identityRoot) ? { reusedIdentityRoot: true } : {}),
			isolation: this.#isolation,
			...(this.#chatGptPlanAuth ? { chatGptPlanAuth: this.#chatGptPlanAuth } : {}),
			signal,
			timeoutMs: this.#timeoutMs,
		});
		if (usageSignal) await this.#recordUsageSignalKind(binding, usageSignal);
		this.#rememberSpareEffort(identityRoot, {
			reasoningEffort: identity.reasoningEffort,
			serviceTier,
			home: false,
		});
		return { providerSessionId: result.providerSessionId, delivery: { messageCount: 0, finalMessageId: null } };
	}

	#studioNarratePort(
		binding: CloudNativeToolBinding,
		folderClient: CloudCompanyFolderClient,
		signal: AbortSignal,
		existingGeminiApiKey?: string,
		studioVoice?: CloudVoiceChannel,
	) {
		let cachedVoiceKey: Promise<string> | null = null;
		let voiceCapReached: { readonly monthlyCapCents: number | null; readonly monthSpendMicrodollars: number } | null =
			null;
		const openVoiceApiKey = async (): Promise<string> => {
			if (voiceCapReached) {
				throw new GeminiCapReachedError(
					voiceCapReached.monthlyCapCents ?? 0,
					voiceCapReached.monthSpendMicrodollars,
				);
			}
			if (existingGeminiApiKey) return existingGeminiApiKey;
			if (!cachedVoiceKey) {
				const geminiKeys = this.#geminiKeys;
				if (!geminiKeys) throw new GeminiKeyRevokedError();
				cachedVoiceKey = openGeminiKeyForRun(
					geminiKeys,
					{
						leaseId: binding.leaseId,
						runId: binding.runId,
						jobId: binding.jobId,
						runnerId: binding.runnerId,
						assignmentId: binding.assignmentId,
						credentialCapsuleId: binding.credentialCapsuleId,
						computeIdentityId: binding.computeIdentityId,
					},
					signal,
				).then(
					(opened) => {
						if (opened.state === "refused") {
							cachedVoiceKey = null;
							if (opened.reason === "CAP_REACHED") {
								voiceCapReached = {
									monthlyCapCents: opened.monthlyCapCents,
									monthSpendMicrodollars: opened.monthSpendMicrodollars,
								};
								throw new GeminiCapReachedError(opened.monthlyCapCents, opened.monthSpendMicrodollars);
							}
							throw new GeminiKeyRevokedError();
						}
						return opened.apiKey;
					},
					(error) => {
						cachedVoiceKey = null;
						if (signal.aborted) throw error;
						if (error instanceof Error && /refused the Gemini key/i.test(error.message)) {
							throw new GeminiKeyRevokedError();
						}
						throw error;
					},
				);
			}
			return cachedVoiceKey;
		};
		return {
			stageBytes: async (bytes: Uint8Array, mediaType: string, reqSignal: AbortSignal) => {
				const ref = await folderClient.stageBytes(bytes, mediaType, reqSignal);
				return {
					manifestSha256: ref.manifestSha256,
					fileSha256: ref.fileSha256,
					bytes: ref.bytes,
					mediaType: ref.mediaType,
				};
			},
			synthesizeGemini: async ({
				model,
				voiceName: ttsVoice,
				text,
				signal: reqSignal,
			}: {
				readonly model: Parameters<typeof synthesizeGeminiSpeech>[0]["model"];
				readonly voiceName: Parameters<typeof synthesizeGeminiSpeech>[0]["voiceName"];
				readonly text: string;
				readonly signal: AbortSignal;
			}) => {
				if (voiceCapReached) {
					throw new GeminiCapReachedError(
						voiceCapReached.monthlyCapCents ?? 0,
						voiceCapReached.monthSpendMicrodollars,
					);
				}
				const apiKey = await openVoiceApiKey();
				reqSignal.throwIfAborted();
				let speech: Awaited<ReturnType<typeof synthesizeGeminiSpeech>>;
				try {
					speech = await synthesizeGeminiSpeech({
						apiKey,
						model,
						voiceName: ttsVoice,
						text,
						...(this.#geminiApiBaseUrl ? { apiBaseUrl: this.#geminiApiBaseUrl } : {}),
						...(this.#geminiAllowLoopback ? { allowLoopback: true } : {}),
						...(this.#geminiFetch ? { fetcher: this.#geminiFetch } : {}),
						signal: reqSignal,
					});
				} catch (error) {
					if (error instanceof GeminiProviderError && error.code === "key_rejected") {
						throw new GeminiKeyRevokedError();
					}
					throw error;
				}
				const recorded = (await this.#paths.call(
					"qorpera_record_gemini_voice_usage",
					{ p_binding: binding, p_model: model, p_usage: speech.usage },
					signal,
				)) as {
					monthSpendMicrodollars?: unknown;
					monthlyCapCents?: unknown;
					capReached?: unknown;
				} | null;
				if (recorded?.capReached === true) {
					voiceCapReached = {
						monthlyCapCents: typeof recorded.monthlyCapCents === "number" ? recorded.monthlyCapCents : null,
						monthSpendMicrodollars:
							typeof recorded.monthSpendMicrodollars === "number" ? recorded.monthSpendMicrodollars : 0,
					};
				}
				return speech;
			},
			...(studioVoice ? { voiceChannel: studioVoice } : {}),
		};
	}

	async #loadCompanyInterfacesContext(
		binding: CloudNativeToolBinding,
		getFolder: () => CloudCompanyFolderClient,
		signal: AbortSignal,
	): Promise<CompanyInterfacesContext | null> {
		let raw: unknown;
		try {
			raw = await this.#paths.call("qorpera_native_list_company_interfaces", { p_binding: binding }, signal);
		} catch (error) {
			if (signal.aborted) throw error;
			return null;
		}
		const interfaces = parseCompanyInterfacesResponse(raw);
		if (interfaces.length === 0) return null;
		const strategyInterface = interfaces.find((item) => item.slug === "strategy" || item.kind === "strategy");
		const identityInterface = interfaces.find((item) => item.slug === "identity" || item.kind === "identity");
		const strategyRoot = strategyInterface?.folderRoot?.replace(/^\/+|\/+$/g, "") || null;
		const identityRoot = identityInterface?.folderRoot?.replace(/^\/+|\/+$/g, "") || null;
		const folderRoots = [
			...new Set(
				interfaces
					.filter((item) => item.sourceKind === "folder" && item.folderRoot)
					.map((item) => item.folderRoot!.replace(/^\/+|\/+$/g, ""))
					.filter(Boolean),
			),
		].slice(0, 16);
		if (!strategyRoot && !identityRoot && folderRoots.length === 0) {
			return { interfaces, strategySummary: null, identitySummary: null };
		}
		let folderClient: CloudCompanyFolderClient;
		try {
			folderClient = getFolder();
		} catch (error) {
			if (signal.aborted) throw error;
			return { interfaces, strategySummary: null, identitySummary: null };
		}
		const readOptionalText = async (path: string, maxBytes: number): Promise<string | null> => {
			try {
				const found = await folderClient.readText(path, maxBytes, signal);
				const text = found?.text.trim();
				return text ? text : null;
			} catch (error) {
				if (signal.aborted) throw error;
				return null;
			}
		};
		const checkFolderExists = async (root: string): Promise<boolean | undefined> => {
			if (typeof folderClient.list !== "function") return undefined;
			try {
				const page = await folderClient.list(root, { limit: 1 }, signal);
				return page.entries.length > 0;
			} catch (error) {
				if (signal.aborted) throw error;
				return undefined;
			}
		};
		const [strategyPlays, strategyBrief, identityBrief, existenceResults] = await Promise.all([
			strategyRoot ? readOptionalText(`${strategyRoot}/plays.json`, 16_384) : Promise.resolve(null),
			strategyRoot ? readOptionalText(`${strategyRoot}/brief.md`, 12_288) : Promise.resolve(null),
			identityRoot ? readOptionalText(`${identityRoot}/brief.md`, 12_288) : Promise.resolve(null),
			Promise.all(folderRoots.map(async (root) => [root, await checkFolderExists(root)] as const)),
		]);
		const existsByRoot = new Map<string, boolean>();
		for (const [root, exists] of existenceResults) {
			if (exists !== undefined) existsByRoot.set(root, exists);
		}
		const annotatedInterfaces = interfaces.map((item) => {
			if (item.sourceKind !== "folder" || !item.folderRoot) return item;
			const root = item.folderRoot.replace(/^\/+|\/+$/g, "");
			const exists = existsByRoot.get(root);
			return exists === undefined ? item : { ...item, folderExists: exists };
		});
		return {
			interfaces: annotatedInterfaces,
			strategySummary: extractStrategyInterfaceSummary(strategyPlays, strategyBrief),
			identitySummary: identityBrief,
		};
	}

	async #loadSurfaceCodingBinding(
		binding: CloudNativeToolBinding,
		context: CloudNativeCompanyContext,
		payload: Record<string, unknown>,
		getFolder: () => CloudCompanyFolderClient,
		signal: AbortSignal,
		studioVoice?: CloudVoiceChannel,
	): Promise<SurfaceCodingTurnBinding | undefined> {
		const identity = context.identity;
		const rawSurface = payload.surfaceSession;
		if (!rawSurface || typeof rawSurface !== "object" || Array.isArray(rawSurface)) return undefined;
		const surfaceRef = rawSurface as Record<string, unknown>;
		const sessionId = String(surfaceRef.sessionId);
		const surfaceSlug = String(surfaceRef.surfaceSlug);
		const leaseToken = String(surfaceRef.leaseToken);
		const sessionTurnRaw = (await this.#paths.call(
			"qorpera_native_surface_read_session_turn",
			{
				p_profile_id: identity.companyId,
				p_session_id: sessionId,
				p_lease_token: leaseToken,
			},
			signal,
		)) as Record<string, unknown> | null;
		if (!sessionTurnRaw || typeof sessionTurnRaw !== "object" || typeof sessionTurnRaw.prompt !== "string") {
			throw new Error("Surface coding turn payload could not be loaded");
		}
		const surfaceTitle =
			typeof sessionTurnRaw.surfaceTitle === "string" && sessionTurnRaw.surfaceTitle.trim()
				? sessionTurnRaw.surfaceTitle.trim()
				: surfaceSlug;
		const rawSourceKind = sessionTurnRaw.sourceKind ?? surfaceRef.sourceKind;
		const sourceKind: SurfaceSourceKind =
			rawSourceKind === "folder" || rawSourceKind === "native_ops" || rawSourceKind === "code_repo"
				? rawSourceKind
				: typeof sessionTurnRaw.repositoryKey === "string" && sessionTurnRaw.repositoryKey.trim()
					? "code_repo"
					: sessionTurnRaw.surfaceArchetype === "ops"
						? "native_ops"
						: "folder";
		const conflictPaths = Array.isArray(sessionTurnRaw.conflictPaths)
			? sessionTurnRaw.conflictPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		const productFolderRoots = Array.isArray(sessionTurnRaw.productFolderRoots)
			? sessionTurnRaw.productFolderRoots.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		const conflictDetails = parseSurfaceConflictDetails(sessionTurnRaw.conflictDetails);
		const openChanges = parseSurfaceTurnOpenChanges(sessionTurnRaw.openChanges);
		const resolvedChanges = parseSurfaceTurnResolvedChanges(sessionTurnRaw.resolvedChanges);
		const previewContext = parseSurfacePreviewContext(sessionTurnRaw.previewContext);
		const sessionOpenChanges = parseSurfaceSessionOpenChanges(sessionTurnRaw.sessionOpenChanges);
		const replyChangeId =
			typeof sessionTurnRaw.replyChangeId === "string" && sessionTurnRaw.replyChangeId.trim()
				? sessionTurnRaw.replyChangeId.trim()
				: null;
		const originRefRec =
			sessionTurnRaw.originRef &&
			typeof sessionTurnRaw.originRef === "object" &&
			!Array.isArray(sessionTurnRaw.originRef)
				? (sessionTurnRaw.originRef as Record<string, unknown>)
				: null;
		const chainMode = originRefRec?.chainMode === true;
		const omittedBaseChanges = parseSurfaceOmittedBaseChanges(originRefRec?.omittedBaseChanges);
		const surfaceArchetype = surfaceArchetypeOf(sessionTurnRaw.surfaceArchetype);
		const openLayoutOps = openSurfaceLayoutOps(sessionTurnRaw.openLayoutOps);
		const mainSha = typeof sessionTurnRaw.mainSha === "string" ? sessionTurnRaw.mainSha : null;
		const branchHeadSha = typeof sessionTurnRaw.branchHeadSha === "string" ? sessionTurnRaw.branchHeadSha : null;
		const voiceModel =
			typeof sessionTurnRaw.voiceModel === "string" && sessionTurnRaw.voiceModel.trim()
				? sessionTurnRaw.voiceModel.trim()
				: null;
		const voiceName =
			typeof sessionTurnRaw.voiceName === "string" && sessionTurnRaw.voiceName.trim()
				? sessionTurnRaw.voiceName.trim()
				: null;
		const imageModel =
			typeof sessionTurnRaw.imageModel === "string" && sessionTurnRaw.imageModel.trim()
				? sessionTurnRaw.imageModel.trim()
				: null;
		const openScenesOps: StudioPatchOp[] = [];
		if (Array.isArray(sessionTurnRaw.openScenesOps)) {
			for (const entry of sessionTurnRaw.openScenesOps) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const rec = entry as Record<string, unknown>;
				if (rec.op === "write_text" && typeof rec.path === "string" && typeof rec.content === "string") {
					openScenesOps.push({ op: "write_text", path: rec.path, content: rec.content });
				} else if (rec.op === "delete" && typeof rec.path === "string") {
					openScenesOps.push({ op: "delete", path: rec.path });
				}
			}
		}
		const folderClient = getFolder();
		const readOptionalText = async (path: string): Promise<string | null> => {
			try {
				const found = await folderClient.readText(path, 16_384, signal);
				const text = found?.text.trim();
				return text ? text : null;
			} catch (error) {
				if (signal.aborted) throw error;
				return null;
			}
		};
		// WHY: loadSurfaceSharedAssets already reads brief.md, voice.md, and tokens.json; derive identityContext instead of reading them twice.
		const [briefMarkdown, sharedSnapshot, memberImages] = await Promise.all([
			readOptionalText(`QorperaOS/surfaces/${surfaceSlug}/brief.md`),
			loadSurfaceSharedAssets(folderClient, signal, productFolderRoots).catch((error) => {
				if (signal.aborted) throw error;
				return null;
			}),
			this.#surfaceMemberImages(identity.companyId, sessionId, leaseToken, signal),
		]);
		const identityContext =
			surfaceSlug !== "identity" &&
			sharedSnapshot &&
			(sharedSnapshot.briefMarkdown || sharedSnapshot.voiceSummary || sharedSnapshot.tokensJson)
				? {
						briefMarkdown: sharedSnapshot.briefMarkdown,
						voiceSummary: sharedSnapshot.voiceSummary,
						tokensJson: sharedSnapshot.tokensJson,
					}
				: null;
		const stagedNotePaths = new Set<string>();
		const surfaceTools = createControlPlaneSurfaceToolsPort(this.#paths, {
			leaseToken,
			deferSessionCompletion: true,
			onNotePaths: (paths) => {
				for (const path of paths) stagedNotePaths.add(path);
			},
		});
		const pointToChangeTarget = extractPointToChangeTarget(sessionTurnRaw.originRef ?? null);
		const agentFolders = cloudAgentFolderPlace(context);
		const notebooks = new CloudFolderNotebooks({
			folder: folderClient,
			runId: binding.runId,
			agentFolder: cloudAgentFolder(identity.companyId, identity.staffAgentId, agentFolders),
		});
		const narratePort =
			sourceKind === "folder"
				? this.#studioNarratePort(binding, folderClient, signal, undefined, studioVoice)
				: undefined;
		return {
			sessionId,
			surfaceSlug,
			surfaceTitle,
			sourceKind,
			...(typeof sessionTurnRaw.surfaceKind === "string" ? { surfaceKind: sessionTurnRaw.surfaceKind } : {}),
			...(typeof sessionTurnRaw.surfaceIcon === "string" ? { surfaceIcon: sessionTurnRaw.surfaceIcon } : {}),
			...(typeof sessionTurnRaw.surfaceIsGlobal === "boolean"
				? { surfaceIsGlobal: sessionTurnRaw.surfaceIsGlobal }
				: {}),
			...(surfaceArchetype ? { surfaceArchetype } : {}),
			...(openLayoutOps ? { openLayoutOps } : {}),
			...(openScenesOps.length > 0 ? { openScenesOps } : {}),
			...(previewContext.previewReconciliations.length > 0
				? { previewReconciliations: previewContext.previewReconciliations }
				: {}),
			isInternalReconciliation: sessionTurnRaw.isInternal === true && sessionTurnRaw.state === "reconciling",
			briefMarkdown:
				briefMarkdown ?? (typeof sessionTurnRaw.briefSummary === "string" ? sessionTurnRaw.briefSummary : null),
			fullPrompt: sessionTurnRaw.prompt,
			repositoryKey: typeof sessionTurnRaw.repositoryKey === "string" ? sessionTurnRaw.repositoryKey : null,
			folderRoot: typeof sessionTurnRaw.folderRoot === "string" ? sessionTurnRaw.folderRoot : null,
			explorationVariantLabel:
				typeof sessionTurnRaw.explorationVariantLabel === "string" ? sessionTurnRaw.explorationVariantLabel : null,
			identityContext,
			sharedAssets: sharedSnapshot,
			pointToChangeTarget,
			conflictPaths,
			conflictDetails,
			previewBaseChanges: previewContext.previewBaseChanges,
			...(sessionOpenChanges.length > 0 ? { sessionOpenChanges } : {}),
			...(replyChangeId ? { replyChangeId } : {}),
			chainMode,
			omittedBaseChanges,
			mainSha,
			branchHeadSha,
			openChanges,
			resolvedChanges,
			...(voiceModel ? { voiceModel } : {}),
			...(voiceName ? { voiceName } : {}),
			...(imageModel ? { imageModel } : {}),
			recordChange: surfaceTools.recordChange,
			stageSurfacePatch: surfaceTools.stageSurfacePatch,
			stageSurfaceOpsAction: surfaceTools.stageSurfaceOpsAction,
			...(narratePort ? { narrateExplainer: narratePort, stageBytes: narratePort.stageBytes } : {}),
			...(sourceKind === "folder"
				? {
						readSkillTools: (operations: CloudNativeToolOperations, runIdentity: CloudNativeToolIdentity) =>
							notebooks.tools((files) => cloudReadOnlySkillTools(files, runIdentity, agentFolders), operations),
						getStagedNotePaths: () => [...stagedNotePaths],
					}
				: {}),
			memberImages,
			viewAttachment: (image, readSignal) => readSurfaceMemberImage(folderClient, image, readSignal),
		};
	}

	async #surfaceMemberImages(
		companyId: string,
		sessionId: string,
		leaseToken: string,
		signal: AbortSignal,
	): Promise<SurfaceMemberImage[]> {
		return parseNativeSurfaceSessionImages(
			await this.#paths.call(
				"qorpera_native_surface_session_images",
				{ p_profile_id: companyId, p_session_id: sessionId, p_lease_token: leaseToken },
				signal,
			),
			sessionId,
		);
	}

	async #surfaceSessionTurn(
		identityRoot: string,
		signal: AbortSignal,
		input: {
			binding: CloudNativeToolBinding;
			context: CloudNativeCompanyContext;
			wake: CloudWakeEnvelope;
			observability: CloudRuntimeObservability;
			serviceTier: CloudRuntimeServiceTier;
		},
	): Promise<{ providerSessionId: string; delivery: { messageCount: number; finalMessageId: string | null } }> {
		const { binding, context, wake, observability, serviceTier } = input;
		const identity = context.identity;
		const payload = wake.payload as Record<string, unknown>;
		const sessionId = String(payload.surfaceSessionId);
		const surfaceId = String(payload.surfaceId);
		const surfaceSlug = String(payload.surfaceSlug);
		const sourceKind = payload.sourceKind as SurfaceSourceKind;
		const leaseToken = String(payload.leaseToken);
		// WHY: Read the full prompt, briefSummary, originRef, and conflictPaths via native host call so wake payloads remain well under Postgres's 8192-byte check.
		// WHY: Start member-images and vault Gemini key fetches concurrently since both depend only on wake/binding fields.
		const memberImagesRequest = this.#surfaceMemberImages(identity.companyId, sessionId, leaseToken, signal);
		memberImagesRequest.catch(() => undefined);
		const geminiKeyRequest =
			context.gemini && this.#geminiKeys
				? openGeminiKeyForRun(
						this.#geminiKeys,
						{
							leaseId: binding.leaseId,
							runId: binding.runId,
							jobId: binding.jobId,
							runnerId: binding.runnerId,
							assignmentId: binding.assignmentId,
							credentialCapsuleId: binding.credentialCapsuleId,
							computeIdentityId: binding.computeIdentityId,
						},
						signal,
					)
				: undefined;
		geminiKeyRequest?.catch(() => undefined);
		const sessionTurnRaw = (await this.#paths.call(
			"qorpera_native_surface_read_session_turn",
			{
				p_profile_id: identity.companyId,
				p_session_id: sessionId,
				p_lease_token: leaseToken,
			},
			signal,
		)) as Record<string, unknown> | null;
		if (!sessionTurnRaw || typeof sessionTurnRaw !== "object" || typeof sessionTurnRaw.prompt !== "string") {
			throw new Error("Surface session turn payload could not be loaded");
		}
		const surfaceTitle =
			typeof sessionTurnRaw.surfaceTitle === "string" && sessionTurnRaw.surfaceTitle.trim()
				? sessionTurnRaw.surfaceTitle.trim()
				: surfaceSlug;
		const conflictPaths = Array.isArray(sessionTurnRaw.conflictPaths)
			? sessionTurnRaw.conflictPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		const productFolderRoots = Array.isArray(sessionTurnRaw.productFolderRoots)
			? sessionTurnRaw.productFolderRoots.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		const conflictDetails = parseSurfaceConflictDetails(sessionTurnRaw.conflictDetails);
		const openChanges = parseSurfaceTurnOpenChanges(sessionTurnRaw.openChanges);
		const resolvedChanges = parseSurfaceTurnResolvedChanges(sessionTurnRaw.resolvedChanges);
		const previewContext = parseSurfacePreviewContext(sessionTurnRaw.previewContext);
		const sessionOpenChanges = parseSurfaceSessionOpenChanges(sessionTurnRaw.sessionOpenChanges);
		const replyChangeId =
			typeof sessionTurnRaw.replyChangeId === "string" && sessionTurnRaw.replyChangeId.trim()
				? sessionTurnRaw.replyChangeId.trim()
				: null;
		const originRefRec =
			sessionTurnRaw.originRef &&
			typeof sessionTurnRaw.originRef === "object" &&
			!Array.isArray(sessionTurnRaw.originRef)
				? (sessionTurnRaw.originRef as Record<string, unknown>)
				: null;
		const chainMode = originRefRec?.chainMode === true;
		const omittedBaseChanges = parseSurfaceOmittedBaseChanges(originRefRec?.omittedBaseChanges);
		const surfaceArchetype = surfaceArchetypeOf(sessionTurnRaw.surfaceArchetype);
		const openLayoutOps = openSurfaceLayoutOps(sessionTurnRaw.openLayoutOps);
		const mainSha = typeof sessionTurnRaw.mainSha === "string" ? sessionTurnRaw.mainSha : null;
		const branchHeadSha = typeof sessionTurnRaw.branchHeadSha === "string" ? sessionTurnRaw.branchHeadSha : null;
		const voiceModel =
			typeof sessionTurnRaw.voiceModel === "string" && sessionTurnRaw.voiceModel.trim()
				? sessionTurnRaw.voiceModel.trim()
				: null;
		const voiceName =
			typeof sessionTurnRaw.voiceName === "string" && sessionTurnRaw.voiceName.trim()
				? sessionTurnRaw.voiceName.trim()
				: null;
		const imageModel: CloudRuntimeImageModel | undefined = isCloudRuntimeImageModel(sessionTurnRaw.imageModel)
			? sessionTurnRaw.imageModel
			: context.imageModel;
		const openScenesOps: StudioPatchOp[] = [];
		if (Array.isArray(sessionTurnRaw.openScenesOps)) {
			for (const entry of sessionTurnRaw.openScenesOps) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const rec = entry as Record<string, unknown>;
				if (rec.op === "write_text" && typeof rec.path === "string" && typeof rec.content === "string") {
					openScenesOps.push({ op: "write_text", path: rec.path, content: rec.content });
				} else if (rec.op === "delete" && typeof rec.path === "string") {
					openScenesOps.push({ op: "delete", path: rec.path });
				}
			}
		}
		const memberImagesSection = surfaceMemberImagesSection(await memberImagesRequest, "company_read");
		const turnInput: SurfaceSessionTurnInput = {
			sessionId,
			surfaceId,
			companyId: identity.companyId,
			surfaceSlug,
			surfaceTitle,
			...(typeof sessionTurnRaw.surfaceKind === "string" ? { surfaceKind: sessionTurnRaw.surfaceKind } : {}),
			...(typeof sessionTurnRaw.surfaceIcon === "string" ? { surfaceIcon: sessionTurnRaw.surfaceIcon } : {}),
			...(typeof sessionTurnRaw.surfaceIsGlobal === "boolean"
				? { surfaceIsGlobal: sessionTurnRaw.surfaceIsGlobal }
				: {}),
			...(surfaceArchetype ? { surfaceArchetype } : {}),
			...(openLayoutOps ? { openLayoutOps } : {}),
			sourceKind,
			prompt: sessionTurnRaw.prompt,
			state: sessionTurnRaw.state === "reconciling" ? "reconciling" : "queued",
			...(sessionTurnRaw.isInternal === true ? { isInternal: true } : {}),
			repositoryKey: typeof sessionTurnRaw.repositoryKey === "string" ? sessionTurnRaw.repositoryKey : null,
			folderRoot: typeof sessionTurnRaw.folderRoot === "string" ? sessionTurnRaw.folderRoot : null,
			...(productFolderRoots.length > 0 ? { productFolderRoots } : {}),
			briefSummary: typeof sessionTurnRaw.briefSummary === "string" ? sessionTurnRaw.briefSummary : null,
			explorationVariantLabel:
				typeof sessionTurnRaw.explorationVariantLabel === "string" ? sessionTurnRaw.explorationVariantLabel : null,
			originKind:
				typeof sessionTurnRaw.originKind === "string" ? sessionTurnRaw.originKind : String(payload.originKind),
			originRef: sessionTurnRaw.originRef ?? null,
			...(conflictPaths.length > 0 ? { conflictPaths } : {}),
			...(conflictDetails.length > 0 ? { conflictDetails } : {}),
			...(previewContext.previewBaseChanges.length > 0
				? { previewBaseChanges: previewContext.previewBaseChanges }
				: {}),
			...(previewContext.previewReconciliations.length > 0
				? { previewReconciliations: previewContext.previewReconciliations }
				: {}),
			...(sessionOpenChanges.length > 0 ? { sessionOpenChanges } : {}),
			...(replyChangeId ? { replyChangeId } : {}),
			...(chainMode ? { chainMode: true } : {}),
			...(omittedBaseChanges.length > 0 ? { omittedBaseChanges } : {}),
			...(mainSha ? { mainSha } : {}),
			...(branchHeadSha ? { branchHeadSha } : {}),
			...(openChanges.length > 0 ? { openChanges } : {}),
			...(resolvedChanges.length > 0 ? { resolvedChanges } : {}),
			...(voiceModel ? { voiceModel } : {}),
			...(voiceName ? { voiceName } : {}),
			...(imageModel ? { imageModel } : {}),
			...(openScenesOps.length > 0 ? { openScenesOps } : {}),
			leaseToken,
		};

		const folderClient = new CloudCompanyFolderClient({
			binding,
			identity,
			control: this.#paths,
			bytes: this.#folderBytes(binding, identity),
			...(this.#eventHooks ? { signedHooks: this.#eventHooks } : {}),
		});
		const companyInterfacesRequest = this.#loadCompanyInterfacesContext(binding, () => folderClient, signal);
		companyInterfacesRequest.catch(() => undefined);
		const stagedNotePaths = new Set<string>();
		const surfaceTools = createControlPlaneSurfaceToolsPort(this.#paths, {
			leaseToken,
			deferSessionCompletion: true,
			onNotePaths: (paths) => {
				for (const path of paths) stagedNotePaths.add(path);
			},
		});
		const completionPort = createControlPlaneSessionCompletionPort(this.#paths, identity.companyId);
		const leaseRenewalPort = createControlPlaneSessionLeaseRenewalPort(this.#paths, identity.companyId);
		const gateway = new CloudCompanyPathGateway({ binding, identity, control: this.#paths });
		const agentFolders = cloudAgentFolderPlace(context);
		const notebooks = new CloudFolderNotebooks({
			folder: folderClient,
			runId: binding.runId,
			agentFolder: cloudAgentFolder(identity.companyId, identity.staffAgentId, agentFolders),
		});
		const isGeminiRun = context.gemini !== undefined;
		let geminiSession:
			| {
					readonly model: NonNullable<CloudNativeCompanyContext["gemini"]>["model"];
					readonly effort: NonNullable<CloudNativeCompanyContext["gemini"]>["effort"];
					readonly apiKey: string;
					readonly apiBaseUrl?: string;
					readonly allowLoopback?: boolean;
					readonly fetch?: typeof fetch;
					readonly initialSpendMicrodollars: number;
					readonly monthlyCapCents: number | null;
					readonly onUsage: (
						usage: {
							readonly inputTokens: number;
							readonly cachedTokens: number;
							readonly outputTokens: number;
						},
						requestSignal: AbortSignal,
					) => Promise<GeminiUsageReceipt | undefined>;
			  }
			| undefined;
		if (context.gemini) {
			if (!geminiKeyRequest) {
				throw new Error(
					"Gemini 4 Neon conversations require the company vault, which this host does not carry; nothing ran on Codex",
				);
			}
			const openedKey = await geminiKeyRequest;
			if (openedKey.state === "refused") {
				if (openedKey.reason === "CAP_REACHED") {
					throw tagNativeRuntimeFailure(
						new GeminiCapReachedError(openedKey.monthlyCapCents, openedKey.monthSpendMicrodollars),
						"native-tools",
						"budget_exhausted",
					);
				}
				throw tagNativeRuntimeFailure(new GeminiKeyRevokedError(), "native-tools", "authority_unavailable");
			}
			geminiSession = {
				model: context.gemini.model,
				effort: context.gemini.effort,
				apiKey: openedKey.apiKey,
				...(this.#geminiApiBaseUrl ? { apiBaseUrl: this.#geminiApiBaseUrl } : {}),
				...(this.#geminiAllowLoopback ? { allowLoopback: true } : {}),
				...(this.#geminiFetch ? { fetch: this.#geminiFetch } : {}),
				initialSpendMicrodollars: openedKey.monthSpendMicrodollars,
				monthlyCapCents: openedKey.monthlyCapCents,
				onUsage: async (usage, requestSignal) => {
					const recorded = (await this.#paths.call(
						"qorpera_record_gemini_run_usage",
						{ p_binding: binding, p_usage: usage },
						requestSignal,
					)) as {
						monthSpendMicrodollars?: unknown;
						monthlyCapCents?: unknown;
						capReached?: unknown;
					} | null;
					if (
						!recorded ||
						typeof recorded.monthSpendMicrodollars !== "number" ||
						(recorded.monthlyCapCents !== null && typeof recorded.monthlyCapCents !== "number") ||
						typeof recorded.capReached !== "boolean"
					) {
						return undefined;
					}
					return {
						monthSpendMicrodollars: recorded.monthSpendMicrodollars,
						monthlyCapCents: recorded.monthlyCapCents,
						capReached: recorded.capReached,
					};
				},
			};
		}

		const studioVoice =
			!isGeminiRun && !(await hasChatGptPlanDirectory(identityRoot)) ? new CloudVoiceChannel() : undefined;
		const studioPictureLane =
			sourceKind === "folder" && !(turnInput.isInternal === true && turnInput.state === "reconciling")
				? await this.#pictureLane({
						binding,
						identity,
						identityRoot,
						preferredModel: imageModel,
						usesPrimaryCodexSession: !isGeminiRun,
						...(geminiSession ? { existingGeminiApiKey: geminiSession.apiKey } : {}),
						geminiFallbackAllowed: isGeminiRun,
						signal,
					})
				: undefined;
		let lastProviderSessionId = `surface-session:${sessionId}`;
		const runModelTurn = async (spec: {
			instructions: string;
			turnBrief: string;
			prompt: string;
			isInternal?: boolean;
			buildTools: (runIdentity: CloudNativeToolIdentity, operations: CloudNativeToolOperations) => CloudNativeTool[];
			turnSignal: AbortSignal;
		}): Promise<SurfaceSessionTurnExecutionOutcome> => {
			let captured: SurfaceSessionTurnExecutionOutcome | null = null;
			const surfaceReplyTool: CloudNativeTool = {
				name: "surface_reply",
				source: "runtime",
				description:
					"Complete this Surface session turn and deliver a concise founder-facing reply summarizing what you staged or verified.",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					required: ["replyText"],
					properties: {
						replyText: { type: "string", minLength: 1, maxLength: 4000 },
						notePaths: { type: "array", items: { type: "string" }, maxItems: 12 },
						branchHeadSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
					},
				},
				parseArguments(value) {
					if (!value || typeof value !== "object" || Array.isArray(value)) {
						throw new CloudToolArgumentRefusal("surface_reply arguments must be an object");
					}
					const rec = value as Record<string, unknown>;
					const replyText = typeof rec.replyText === "string" ? rec.replyText.trim() : "";
					if (!replyText || replyText.length > 4000) {
						throw new CloudToolArgumentRefusal("replyText must be 1..4000 characters");
					}
					const notePaths =
						rec.notePaths === undefined
							? undefined
							: Array.isArray(rec.notePaths) &&
									rec.notePaths.every((p) => typeof p === "string" && p.trim().length > 0)
								? rec.notePaths.map((p) => (p as string).trim())
								: null;
					if (notePaths === null) {
						throw new CloudToolArgumentRefusal("notePaths must be an array of non-empty paths");
					}
					const branchHeadSha =
						rec.branchHeadSha === undefined
							? undefined
							: typeof rec.branchHeadSha === "string" && /^[0-9a-f]{40}$/.test(rec.branchHeadSha)
								? rec.branchHeadSha
								: null;
					if (branchHeadSha === null) {
						throw new CloudToolArgumentRefusal("branchHeadSha must be a 40-hex commit SHA");
					}
					return {
						replyText,
						...(notePaths ? { notePaths } : {}),
						...(branchHeadSha ? { branchHeadSha } : {}),
					};
				},
				async execute(value) {
					const args = surfaceReplyTool.parseArguments(value) as {
						replyText: string;
						notePaths?: string[];
						branchHeadSha?: string;
					};
					captured = {
						state: "ready",
						replyText: args.replyText,
						notePaths: args.notePaths ?? null,
						branchHeadSha: args.branchHeadSha ?? null,
					};
					return { kind: "text", value: JSON.stringify({ ok: true }), completesTurn: true };
				},
			};
			const surfaceAskTool: CloudNativeTool = {
				name: "surface_ask",
				source: "runtime",
				description:
					"Pause this Surface session turn and ask the founder one concrete clarifying question before staging changes.",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					required: ["text"],
					properties: {
						text: { type: "string", minLength: 1, maxLength: 1000 },
						replyText: { type: "string", minLength: 1, maxLength: 2000 },
						options: {
							type: "array",
							maxItems: 6,
							items: { type: "string", minLength: 1, maxLength: 160 },
						},
					},
				},
				parseArguments(value) {
					if (!value || typeof value !== "object" || Array.isArray(value)) {
						throw new CloudToolArgumentRefusal("surface_ask arguments must be an object");
					}
					const rec = value as Record<string, unknown>;
					const questionText = typeof rec.text === "string" ? rec.text.trim() : "";
					if (!questionText || questionText.length > 1000) {
						throw new CloudToolArgumentRefusal("text must be 1..1000 characters");
					}
					const replyText =
						rec.replyText === undefined
							? undefined
							: typeof rec.replyText === "string" &&
									rec.replyText.trim().length > 0 &&
									rec.replyText.trim().length <= 2000
								? rec.replyText.trim()
								: null;
					if (replyText === null) {
						throw new CloudToolArgumentRefusal("replyText must be 1..2000 characters when supplied");
					}
					let options: string[] = [];
					if (rec.options !== undefined) {
						if (!Array.isArray(rec.options) || rec.options.length > 6) {
							throw new CloudToolArgumentRefusal("options must be an array of at most 6 strings");
						}
						options = rec.options.map((entry) => {
							const label = typeof entry === "string" ? entry.trim() : "";
							if (!label || label.length > 160) {
								throw new CloudToolArgumentRefusal("Each option must be a string of 1..160 characters");
							}
							return label;
						});
					}
					return {
						text: questionText,
						options,
						...(replyText ? { replyText } : {}),
					};
				},
				async execute(value) {
					const args = surfaceAskTool.parseArguments(value) as unknown as {
						text: string;
						replyText?: string;
						options: string[];
					};
					const question: SurfaceSessionQuestion = {
						text: args.text,
						options: args.options,
					};
					captured = {
						state: "needs_input",
						replyText: args.replyText ?? args.text,
						question,
					};
					return { kind: "text", value: JSON.stringify({ ok: true }), completesTurn: true };
				},
			};

			const isInternalTurn = spec.isInternal === true;
			const runtimeInstructions = isInternalTurn
				? `${spec.instructions}\n\nWhen finished staging the combined resolution via stage_surface_patch, call surface_reply with a concise summary. Do not ask questions.`
				: `${spec.instructions}\n\nWhen finished staging changes or inspecting the surface, call surface_reply with a concise founder-facing summary. If a concrete founder decision is required first, call surface_ask.`;
			const fullPrompt = `${spec.turnBrief}${memberImagesSection ? `\n\n${memberImagesSection}` : ""}\n\n${isInternalTurn ? "Task" : "Founder request"}:\n${spec.prompt}`;
			const contextText = `${runtimeInstructions}\n${fullPrompt}`;
			const contextSha256 = createHash("sha256").update(contextText).digest("hex");
			const contextBytes = Buffer.byteLength(contextText);
			let admitted: Record<string, unknown> | undefined;

			const sessionResult = await runCloudNativeRunToolSession({
				observability,
				binding,
				serviceTier,
				controlPlane: this.#control,
				...(geminiSession ? { gemini: geminiSession } : {}),
				...(studioVoice ? { voice: studioVoice } : {}),
				...(studioPictureLane?.channel && studioPictureLane.attachToCodex
					? { pictures: studioPictureLane.channel }
					: {}),
				beginExecution: async (specification, requestSignal) => {
					const toolCatalogText = cloudToolJsonText(specification, CLOUD_NATIVE_TOOL_CATALOG_BYTES);
					const answer = await this.#paths.call(
						"qorpera_begin_native_company_execution_v3",
						{
							p_binding: binding,
							p_binary_sha256: this.#sha256,
							p_runtime_bundle_sha256: identity.runtimeBundleSha256,
							p_reasoning_policy_sha256: identity.reasoningPolicySha256,
							p_tool_catalog_text: toolCatalogText,
						},
						requestSignal,
						CLOUD_RUN_ROW_READ_MS,
					);
					const admission = {
						runId: binding.runId,
						jobId: binding.jobId,
						leaseId: binding.leaseId,
						binarySha256: this.#sha256,
						runtimeBundleSha256: identity.runtimeBundleSha256,
						reasoningEffort: identity.reasoningEffort,
						reasoningPolicySha256: identity.reasoningPolicySha256,
						toolCatalogSha256: createHash("sha256").update(toolCatalogText).digest("hex"),
					};
					confirmNativeAdmission(answer, {
						schema: "qorpera.native-company-execution-admission/v1",
						...admission,
					});
					admitted = admission;
				},
				opening: async (openingSignal) => {
					const admission = admitted;
					if (!admission) throw new Error("Native execution admission was not confirmed");
					const started = await cloudToolRequest(
						(requestSignal) =>
							this.#paths.call(
								"qorpera_bind_native_company_context",
								{ p_binding: binding, p_context_sha256: contextSha256, p_context_bytes: contextBytes },
								requestSignal,
								CLOUD_RUN_ROW_READ_MS,
							),
						openingSignal,
						CLOUD_RUN_ROW_READ_MS,
					);
					confirmNativeAdmission(started, {
						...admission,
						schema: "qorpera.native-company-execution-start/v1",
						contextSha256,
						contextBytes,
					});
					return {
						prompt: fullPrompt,
						runtimeInstructions,
						composeContext: (request) =>
							cloudNativeContextWithPromptCacheKey(
								cloudNativeContextIdentity(request),
								cloudNativePromptCacheKey(
									"surface",
									identity.companyId,
									identity.staffAgentId,
									surfaceSlug,
									sourceKind,
									isInternalTurn ? "internal" : "turn",
									request.model,
								),
							),
					};
				},
				turnCorrection: async () =>
					captured
						? undefined
						: isInternalTurn
							? "Your turn ended without calling surface_reply. Make sure you called stage_surface_patch with the combined resolution, then call surface_reply now."
							: "Your turn ended without calling surface_reply or surface_ask. Call surface_reply now with a brief summary of what you staged, or call surface_ask if founder input is needed.",
				tools: (runIdentity, operations) => ({
					tools: isInternalTurn
						? [...spec.buildTools(runIdentity, operations), surfaceReplyTool]
						: [...spec.buildTools(runIdentity, operations), surfaceReplyTool, surfaceAskTool],
					assertContext: (requestSignal, timeoutMs) => gateway.assertReadableContext(requestSignal, timeoutMs),
					checkRun: (requestSignal, timeoutMs) => gateway.checkRun(requestSignal, timeoutMs),
					recordContextView: (frame, outputs, requestSignal) =>
						gateway.recordContextView(frame, outputs, requestSignal),
					fenceContextView: (frame, outputs, requestSignal) =>
						gateway.fenceContextView(frame, outputs, requestSignal),
				}),
				command: this.#command,
				binarySha256: this.#sha256,
				identityRoot,
				...(this.#spareEfforts.has(identityRoot) ? { reusedIdentityRoot: true } : {}),
				isolation: this.#isolation,
				...(this.#chatGptPlanAuth ? { chatGptPlanAuth: this.#chatGptPlanAuth } : {}),
				signal: spec.turnSignal,
				timeoutMs: this.#timeoutMs,
			});

			lastProviderSessionId = sessionResult.providerSessionId;
			if (sessionResult.usageSignal && !isGeminiRun) {
				await this.#recordUsageSignalKind(binding, sessionResult.usageSignal);
			}
			if (!isGeminiRun) {
				this.#rememberSpareEffort(identityRoot, {
					reasoningEffort: identity.reasoningEffort,
					serviceTier,
					home: false,
				});
			}
			const outcome = captured as SurfaceSessionTurnExecutionOutcome | null;
			const mergedNotes = [...new Set([...stagedNotePaths, ...(outcome?.notePaths ?? [])])];
			const finalOutcome: SurfaceSessionTurnExecutionOutcome = outcome
				? {
						...outcome,
						...(mergedNotes.length > 0 ? { notePaths: mergedNotes } : {}),
					}
				: {
						state: "ready",
						replyText: "Surface turn completed.",
						...(mergedNotes.length > 0 ? { notePaths: mergedNotes } : {}),
					};
			return finalOutcome;
		};

		const readOnlyNames = new Set(["company_read", "company_list"]);
		const readOnlyDataNames = new Set(["data_describe", "data_query"]);
		const surfaceFolderSearch = this.#folderSearch
			? new CloudFolderSearch({
					socketPath: this.#folderSearch.socketPath,
					folder: folderClient,
					environmentId: identity.environmentId,
				})
			: undefined;
		const narratePort = this.#studioNarratePort(binding, folderClient, signal, geminiSession?.apiKey, studioVoice);
		const companyInterfaces = await companyInterfacesRequest;

		let turnResult: Awaited<ReturnType<typeof runSurfaceSessionTurn>>;
		try {
			turnResult = await runSurfaceSessionTurn(
				{
					...turnInput,
					...(companyInterfaces ? { companyInterfaces } : {}),
				},
				{
					folder: folderClient,
					readStudioFiles: cloudStudioFileReader(folderClient),
					surfaceTools,
					narrateExplainer: narratePort,
					...(studioPictureLane?.channel
						? {
								makePicture: {
									stageBytes: async (bytes, mediaType, reqSignal) => {
										const ref = await folderClient.stageBytes(bytes, mediaType, reqSignal);
										return {
											manifestSha256: ref.manifestSha256,
											fileSha256: ref.fileSha256,
											bytes: ref.bytes,
											mediaType: ref.mediaType,
										};
									},
									pictures: studioPictureLane.channel,
								},
							}
						: {}),
					executeTurn: async (turnReq) =>
						runModelTurn({
							instructions: turnReq.instructions,
							turnBrief: turnReq.turnBrief,
							prompt: turnReq.input.prompt,
							isInternal: turnReq.input.isInternal === true,
							turnSignal: turnReq.signal,
							buildTools: (runIdentity, operations) => {
								const folderTools =
									turnReq.mode === "folder"
										? [
												...cloudFolderFileTools({
													folder: folderClient,
													operations,
													identity: runIdentity,
													surfaceFilePolicy: {
														mode: "surface_worker",
														writableRoots: turnReq.writableRoots,
														stagedRoots: turnReq.stagedRoots,
													},
												}),
												...notebooks.tools(
													(files) => cloudReadOnlySkillTools(files, runIdentity, agentFolders),
													operations,
												),
											]
										: cloudFolderFileTools({
												folder: folderClient,
												operations,
												identity: runIdentity,
											}).filter((tool) => readOnlyNames.has(tool.name));
								const searchTools = surfaceFolderSearch
									? [
											cloudFolderSearchTool({
												search: surfaceFolderSearch,
												folder: folderClient,
												runId: runIdentity.runId,
											}),
										]
									: [];
								const dataTools = this.#companyData
									? cloudDataTools({
											folder: folderClient,
											door: this.#companyData,
											apply: false,
										}).filter((tool) => readOnlyDataNames.has(tool.name))
									: [];
								return [...turnReq.tools, ...folderTools, ...searchTools, ...dataTools];
							},
						}),
					executeCodeRepoTurn: async () => {
						throw new Error(
							"Code repository surface sessions run through the coding executor; retry this session.",
						);
					},
					completeSessionTurn: completionPort.completeSessionTurn,
					renewSessionLease: leaseRenewalPort.renewSessionLease,
					signal,
				},
			);
		} finally {
			surfaceFolderSearch?.close();
			await studioPictureLane?.close();
		}

		if (turnResult.cause !== undefined) {
			throw turnResult.cause;
		}
		return { providerSessionId: lastProviderSessionId, delivery: { messageCount: 0, finalMessageId: null } };
	}

	async #claudeCodeWorker(
		identityRoot: string,
		signal: AbortSignal,
		input: {
			binding: CloudNativeToolBinding;
			context: CloudNativeCompanyContext;
			identity: CloudNativeToolIdentity;
			handle: string;
			wake: CloudWakeEnvelope;
			outputFolder: string;
			home: Promise<CloudCompanyHome | undefined>;
			composition: ReturnType<CloudRuntimeObservability["start"]>;
		},
	): Promise<{ providerSessionId: string; delivery: { messageCount: number; finalMessageId: string | null } }> {
		const { binding, identity, wake } = input;
		const host = this.#claudeWorker;
		const channelOf = this.#homeChannel;
		if (!host || !channelOf) throw new Error(CLAUDE_WORKER_NOT_CARRIED);
		const brief = claudeWorkerBrief(wake.payload as Record<string, unknown>);
		const run = await CloudNativeToolRun.open(binding, this.#control, signal, NATIVE_AUTHORITY_LEASE_SECONDS * 1000);
		let pictureLane: CloudClaudePictureLane | undefined;
		try {
			return await withAbortScopes([signal, run.signal], async (runSignal) => {
				const operations = new CloudNativeToolOperations(run, this.#control);
				const folder = new CloudCompanyFolderClient({
					binding,
					identity,
					control: this.#paths,
					bytes: this.#folderBytes(binding, identity),
				});
				// The admission, as a light ask's: the run's executable policy, and Claude Code's own tools as its catalog.
				const toolCatalogText = cloudToolJsonText(CLAUDE_WORKER_CATALOG, CLOUD_NATIVE_TOOL_CATALOG_BYTES);
				const admission = {
					runId: binding.runId,
					jobId: binding.jobId,
					leaseId: binding.leaseId,
					binarySha256: this.#sha256,
					runtimeBundleSha256: identity.runtimeBundleSha256,
					reasoningEffort: identity.reasoningEffort,
					reasoningPolicySha256: identity.reasoningPolicySha256,
					toolCatalogSha256: createHash("sha256").update(toolCatalogText).digest("hex"),
				};
				confirmNativeAdmission(
					await this.#paths.call(
						"qorpera_begin_native_company_execution_v3",
						{
							p_binding: binding,
							p_binary_sha256: this.#sha256,
							p_runtime_bundle_sha256: identity.runtimeBundleSha256,
							p_reasoning_policy_sha256: identity.reasoningPolicySha256,
							p_tool_catalog_text: toolCatalogText,
						},
						runSignal,
						CLOUD_RUN_ROW_READ_MS,
					),
					{ schema: "qorpera.native-company-execution-admission/v1", ...admission },
				);
				// The context is what Claude Code is told: its system note and the brief.
				const prompt = claudeWorkerPrompt(brief);
				const contextText = `${CLAUDE_WORKER_SYSTEM_NOTE}\n${prompt}`;
				const contextSha256 = createHash("sha256").update(contextText).digest("hex");
				const contextBytes = Buffer.byteLength(contextText);
				confirmNativeAdmission(
					await cloudToolRequest(
						(requestSignal) =>
							this.#paths.call(
								"qorpera_bind_native_company_context",
								{ p_binding: binding, p_context_sha256: contextSha256, p_context_bytes: contextBytes },
								requestSignal,
								CLOUD_RUN_ROW_READ_MS,
							),
						runSignal,
						CLOUD_RUN_ROW_READ_MS,
					),
					{ ...admission, schema: "qorpera.native-company-execution-start/v1", contextSha256, contextBytes },
				);
				input.composition.finish("succeeded", { outputBytes: contextBytes });
				const home = await input.home;
				const sessionId = randomUUID();
				const reviewer = new CloudActionReviewChannel();
				const notebooks = new CloudFolderNotebooks({
					folder,
					runId: binding.runId,
					agentFolder: cloudAgentFolder(
						identity.companyId,
						identity.staffAgentId,
						cloudAgentFolderPlace(input.context),
					),
				});
				// The run's own work log, where the run keeps one: one step per tool call of Claude Code's. No compactor serves
				// it (no Codex), so its step lines are left for a later run to build (§7.2).
				// The member's name for the words, and on a follow-up the worker's earlier report. A read that fails is no reason to
				// end the worker: it says "the member who asked" and goes on without the earlier report.
				const [opened, facts, vision] = await Promise.all([
					openCloudRunLog({
						resume: new CloudRunResumeRpc({ run, control: this.#paths }),
						folder: new CloudRunLogCompanyFolder({
							environmentId: identity.environmentId,
							runId: binding.runId,
							folder,
							control: this.#paths,
						}),
						log: {
							runId: binding.runId,
							protection: new CloudRunLogRpcProtection({
								environmentId: identity.environmentId,
								jobId: binding.jobId,
								runId: binding.runId,
								call: (method, argumentsValue, requestSignal) =>
									this.#paths.call(method, argumentsValue, requestSignal),
							}),
							signal: run.signal,
							effectful: (tool) =>
								!["claude_code", "claude_code_read", "claude_code_grep", "claude_code_glob"].includes(
									tool.name,
								),
						},
						lines: { call: new MemoryCompactChannel().call, lane: new MemoryCompactLane() },
					}),
					this.#paths.call("qorpera_claude_worker_run_facts", { p_binding: binding }, runSignal).catch(() => {
						runSignal.throwIfAborted();
						return null;
					}) as Promise<{ member?: unknown; earlier?: unknown; ownCodexLogin?: unknown } | null>,
					home
						? readCloudAgentHeadVision(notebooks.composition, runSignal).catch(() => {
								runSignal.throwIfAborted();
								return null;
							})
						: Promise.resolve(null),
				]);
				const log = opened?.log ?? undefined;
				const member = typeof facts?.member === "string" && facts.member ? facts.member : "the member who asked";
				const earlier = typeof facts?.earlier === "string" && facts.earlier ? facts.earlier : null;
				const review = new CloudActionReviewGate({
					binding,
					control: {
						call: (method, argumentsValue, requestSignal) =>
							this.#paths.call(method, argumentsValue, requestSignal),
					},
					reviewer,
					reviewerModel: CLAUDE_ACTION_REVIEW_MODEL,
					request: cloudActionReviewRequest(input.context, wake),
					mandate: cloudActionReviewMandate(input.context, wake, vision && "text" in vision ? vision.text : null, {
						surfaceFirst: this.#surfaceFirst,
					}),
					holdMs: ["human", "room", "first-run"].includes(wake.kind) ? CLOUD_ACTION_REVIEW_HOLD_MS : 0,
					facts: {
						coworkers: new Map(input.context.coworkers.map((coworker) => [coworker.id, coworker.name])),
						timeZone: wake.time.timeZone,
					},
				});
				const geminiWorkerLane = createGeminiImageLane({
					binding,
					paths: this.#paths,
					...(this.#geminiKeys ? { geminiKeys: this.#geminiKeys } : {}),
					...(this.#geminiApiBaseUrl ? { apiBaseUrl: this.#geminiApiBaseUrl } : {}),
					...(this.#geminiAllowLoopback ? { allowLoopback: true } : {}),
					...(this.#geminiFetch ? { fetcher: this.#geminiFetch } : {}),
					signal: runSignal,
				});
				const chatGptPlanWorkerLane =
					home !== undefined && (await hasChatGptPlanToken(identityRoot))
						? createChatGptPlanImageLane({
								identityRoot,
								model: binding.model,
								...(this.#chatGptPlanApiBaseUrl ? { apiBaseUrl: this.#chatGptPlanApiBaseUrl } : {}),
								...(this.#chatGptPlanAllowLoopback ? { allowLoopback: true } : {}),
								...(this.#chatGptPlanFetch ? { fetcher: this.#chatGptPlanFetch } : {}),
							})
						: undefined;
				const chosen = await claudeWorkerPictures({
					facts,
					home: home !== undefined,
					...(input.context.imageModel ? { preferredModel: input.context.imageModel } : {}),
					...(host.pictures ? { given: host.pictures(identityRoot) } : {}),
					...(geminiWorkerLane ? { gemini: geminiWorkerLane } : {}),
					...(chatGptPlanWorkerLane ? { chatGptPlan: chatGptPlanWorkerLane } : {}),
					lane: () => this.#claudePictureLane(identityRoot, binding, identity, runSignal),
					foreignOwner: (path, ownerSignal) =>
						cloudPictureForeignOwner(folder, path, identity.staffAgentId, ownerSignal),
				});
				pictureLane = chosen.lane;
				const pictures = chosen.pictures;
				const usageMark: { at: number; owed: ClaudeLoginUsage | null } = { at: 0, owed: null };
				const recordUsage = (usage: ClaudeLoginUsage) =>
					withAbortScopes(
						[],
						(usageSignal) =>
							this.#paths.call(
								"qorpera_record_claude_run_usage",
								{ p_binding: binding, p_usage: usage },
								usageSignal,
							),
						CLOUD_CLAUDE_USAGE_MS,
					).catch(() => undefined);
				let outcome: ClaudeWorkerOutcome;
				if (!home) outcome = claudeWorkerBlocked(cloudHomeRefusalWords(undefined));
				else
					outcome = await runClaudeWorker({
						brief: { ...brief, earlier },
						member,
						logins: claudeWorkerLogins(host.logins, {
							leaseId: binding.leaseId,
							runId: binding.runId,
							jobId: binding.jobId,
							runnerId: binding.runnerId,
							assignmentId: binding.assignmentId,
							credentialCapsuleId: binding.credentialCapsuleId,
							computeIdentityId: binding.computeIdentityId,
						}),
						launch: (box) =>
							launchClaudeCodeBox({
								...box,
								...(host.configuration ? { configuration: host.configuration } : {}),
								...(host.proof ? { proof: host.proof } : {}),
								channel: channelOf(binding) as CloudClaudeHomeChannel,
								sessionId,
								machineId: home.machineId,
								review: {
									gate: cloudHomeActionReview(review),
									machine: { id: home.machineId, name: home.machine },
									attach: (made) => reviewer.attach(made),
								},
								pictures,
								// The run's one home session (both channels) is ended in SQL once both are closed.
								endSession: async (id, reason) => {
									await withAbortScopes(
										[],
										(closeSignal) =>
											this.#paths.call(
												"qorpera_close_home_session",
												{ p_binding: binding, p_session_id: id, p_reason: reason },
												closeSignal,
											),
										CLOUD_HOME_CLOSE_MS,
									);
								},
							}),
						root: identityRoot,
						usage: (usage) => {
							usageMark.owed = usage;
							if (Date.now() - usageMark.at < CLOUD_CLAUDE_USAGE_EVERY_MS) return;
							usageMark.at = Date.now();
							usageMark.owed = null;
							void recordUsage(usage);
						},
						step: (step) => {
							if (!log) return;
							try {
								const call = "start" in step ? `claude-code-start-${binding.runId}` : step.id;
								const argumentsText =
									"start" in step
										? JSON.stringify({
												claudeCode: CLAUDE_CODE_PIN.version,
												model: step.start.model,
												session: step.start.sessionId,
											})
										: JSON.stringify({ what: step.what });
								const j = log.step({
									call,
									tool:
										"start" in step
											? "claude_code"
											: `claude_code_${step.tool
													.toLowerCase()
													.replace(/[^a-z0-9_]/g, "_")
													.slice(0, 40)}`,
									argumentsText,
									argumentSha256: createHash("sha256").update(argumentsText).digest("hex"),
								});
								log.finish(
									j,
									JSON.stringify("start" in step ? { ok: true } : { ok: step.ok, ms: step.ms }),
									[],
								);
							} catch {
								// A step the log cannot take leaves the run's record thinner, never the work.
							}
						},
						signal: runSignal,
					});
				if (usageMark.owed) await recordUsage(usageMark.owed);
				runSignal.throwIfAborted();
				if (log) await withAbortScopes([], (closeSignal) => log.close(closeSignal), 10_000).catch(() => undefined);
				// What the run changed on the machine's folder, as its home's window credited it (at most four in the report), once
				// the view's last boundary is in: read after a short wait and again until it stands still (bounded).
				const outputs = home
					? (
							await claudeWorkerSettledOutputs(async (readSignal) => {
								const after = (await this.#paths.call(
									"qorpera_claude_worker_run_facts",
									{ p_binding: binding },
									readSignal,
								)) as { outputs?: unknown };
								return claudeWorkerReportedOutputs(after?.outputs, `${input.outputFolder}/results.md`);
							}, runSignal)
						).slice(0, 4)
					: [];
				if (
					outcome.claudeSide &&
					(await this.#claudeWorkerFellBack(binding, outcome.claudeSide, outputs, runSignal))
				)
					return {
						providerSessionId: claudeWorkerSessionId(outcome),
						delivery: { messageCount: 0, finalMessageId: null },
					};
				const workers = new CloudFolderWorkers({
					folder,
					operations,
					identity,
					handle: input.handle,
					outputFolder: input.outputFolder,
				});
				const report = {
					operationKey: "claude-code-report",
					outcome: outcome.outcome,
					summary: outcome.summary,
					...(outcome.needs === undefined ? {} : { needs: outcome.needs }),
					...(outputs.length ? { outputs } : {}),
				};
				const reportText = JSON.stringify(report);
				const saved = await workers.report(report, {
					companyId: identity.companyId,
					runId: binding.runId,
					callId: `claude-code-report-${binding.runId}`,
					argumentSha256: createHash("sha256").update(reportText).digest("hex"),
					signal: runSignal,
				});
				const answer =
					saved.kind === "text"
						? (JSON.parse(saved.value) as { outcome?: unknown; reason?: unknown; problems?: unknown })
						: {};
				// The folder core's own reason and problems name rules and paths, never the report's text.
				if (answer.outcome !== "saved")
					throw new Error(
						`The Claude Code worker's report was not saved (${String(answer.outcome)}: ${String(answer.reason)} ${JSON.stringify(answer.problems ?? []).slice(0, 600)})`,
					);
				return {
					providerSessionId: claudeWorkerSessionId(outcome),
					delivery: { messageCount: 0, finalMessageId: null },
				};
			});
		} finally {
			try {
				if (pictureLane) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							pictureLane.close().catch(() => undefined),
							new Promise<void>((resolve) => {
								timer = setTimeout(resolve, 30_000);
								timer.unref?.();
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
				}
			} finally {
				run.close();
			}
		}
	}

	#pictureLane(options: {
		readonly binding: CloudNativeToolBinding;
		readonly identity: CloudNativeToolIdentity;
		readonly identityRoot: string;
		readonly preferredModel?: CloudRuntimeImageModel;
		readonly usesPrimaryCodexSession: boolean;
		readonly allowChatGptSubscription?: boolean;
		readonly existingGeminiApiKey?: string;
		readonly geminiFallbackAllowed?: boolean;
		readonly signal: AbortSignal;
	}): Promise<ResolvedRunPictureLane> {
		const geminiLane = createGeminiImageLane({
			binding: options.binding,
			paths: this.#paths,
			...(this.#geminiKeys ? { geminiKeys: this.#geminiKeys } : {}),
			...(options.existingGeminiApiKey ? { existingApiKey: options.existingGeminiApiKey } : {}),
			...(this.#geminiApiBaseUrl ? { apiBaseUrl: this.#geminiApiBaseUrl } : {}),
			...(this.#geminiAllowLoopback ? { allowLoopback: true } : {}),
			...(this.#geminiFetch ? { fetcher: this.#geminiFetch } : {}),
			signal: options.signal,
		});
		return resolveRunPictureLane({
			...(options.preferredModel ? { preferredModel: options.preferredModel } : {}),
			identityRoot: options.identityRoot,
			usesPrimaryCodexSession: options.usesPrimaryCodexSession,
			...(options.allowChatGptSubscription === undefined
				? {}
				: { allowChatGptSubscription: options.allowChatGptSubscription }),
			...(geminiLane ? { geminiLane } : {}),
			...(options.geminiFallbackAllowed ? { geminiFallbackAllowed: true } : {}),
			startCodexSideLane: () =>
				this.#claudePictureLane(options.identityRoot, options.binding, options.identity, options.signal),
			chatGptPlanModel: options.binding.model,
			...(this.#chatGptPlanApiBaseUrl ? { chatGptPlanApiBaseUrl: this.#chatGptPlanApiBaseUrl } : {}),
			...(this.#chatGptPlanAllowLoopback ? { chatGptPlanAllowLoopback: true } : {}),
			...(this.#chatGptPlanFetch ? { chatGptPlanFetch: this.#chatGptPlanFetch } : {}),
		});
	}

	#claudePictureLane(
		identityRoot: string,
		binding: CloudNativeToolBinding,
		identity: CloudNativeToolIdentity,
		signal: AbortSignal,
	): Promise<CloudClaudePictureLane | undefined> {
		const gateway = new CloudCompanyPathGateway({ binding, identity, control: this.#paths });
		return cloudClaudePictureLaneFor({
			identityRoot,
			signal,
			start: cloudClaudePictureSessionStart({
				binding,
				controlPlane: this.#control,
				adapters: () => ({
					tools: [],
					assertContext: (requestSignal, timeoutMs) => gateway.assertReadableContext(requestSignal, timeoutMs),
					checkRun: (requestSignal, timeoutMs) => gateway.checkRun(requestSignal, timeoutMs),
					recordContextView: (frame, outputs, requestSignal) =>
						gateway.recordContextView(frame, outputs, requestSignal),
					fenceContextView: (frame, outputs, requestSignal) =>
						gateway.fenceContextView(frame, outputs, requestSignal),
				}),
				command: this.#command,
				binarySha256: this.#sha256,
				identityRoot,
				...(this.#isolation ? { isolation: this.#isolation } : {}),
				...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
			}),
		});
	}

	async #claudeWorkerFellBack(
		binding: CloudNativeToolBinding,
		reason: NonNullable<ClaudeWorkerOutcome["claudeSide"]>,
		changed: readonly string[],
		signal: AbortSignal,
	): Promise<boolean> {
		for (let attempt = 1; ; attempt++) {
			try {
				const answer = (await this.#paths.call(
					"qorpera_claude_worker_fall_back",
					{ p_binding: binding, p_reason: reason, p_changed: [...changed] },
					signal,
				)) as { state?: unknown } | null;
				return answer?.state === "fell_back";
			} catch {
				signal.throwIfAborted();
				if (attempt >= CLAUDE_WORKER_FALLBACK_ATTEMPTS) {
					console.error("The Claude Code worker's fallback to Codex was not saved");
					return false;
				}
				await cloudControlPause(1000 * attempt, signal);
			}
		}
	}

	/**
	 * Contract section 17: quota exhaustion, rate limiting and provider outage
	 * are typed signals recorded against the run's exact sponsor and connection
	 * version before the job fails. Recording never retries the provider, never
	 * masks the failure, and carries no provider text.
	 */
	async #recordGeminiCapReached(binding: CloudNativeToolBinding): Promise<void> {
		try {
			await withAbortScopes(
				[],
				(recordSignal) =>
					this.#paths.call("qorpera_record_gemini_cap_reached", { p_binding: binding }, recordSignal, 10_000),
				10_000,
			);
		} catch {
			console.error("Gemini spend cap notice was not recorded");
		}
	}

	async #recordGeminiKeyError(binding: CloudNativeToolBinding, errorCode: GeminiProviderErrorCode): Promise<void> {
		try {
			await withAbortScopes(
				[],
				(recordSignal) =>
					this.#paths.call(
						"qorpera_record_gemini_key_error",
						{ p_binding: binding, p_error_code: errorCode },
						recordSignal,
						10_000,
					),
				10_000,
			);
		} catch {
			console.error(`Gemini key error notice was not recorded (${errorCode})`);
		}
	}

	async #recordUsageSignal(binding: CloudNativeToolBinding, error: unknown): Promise<void> {
		const kind = nativeProviderUsageSignal(error);
		if (kind) await this.#recordUsageSignalKind(binding, kind);
	}

	async #recordUsageSignalKind(binding: CloudNativeToolBinding, kind: NativeProviderUsageSignal): Promise<void> {
		try {
			// The 10 s is the call's own budget, so the transport waits that long too.
			await withAbortScopes(
				[],
				(recordSignal) =>
					this.#paths.call(
						"qorpera_record_provider_usage_signal",
						{ p_binding: binding, p_signal_kind: kind },
						recordSignal,
						10_000,
					),
				10_000,
			);
		} catch {
			console.error(`Provider usage signal was not recorded (${kind})`);
		}
	}
}
