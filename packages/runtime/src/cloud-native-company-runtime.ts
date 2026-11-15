import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { cloudAgentFolder } from "@qorpera/cloud-client/cloud-agent-folder";
import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_ACTION_REVIEW_HOLD_MS,
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
import { cloudCodeTools } from "./cloud-code-tools.ts";
import {
	CLOUD_HOME_CLOSE_MS,
	CloudCodexHome,
	type CloudCodexHomeChannel,
	type CloudCodexHomeReview,
	CloudCodexHomeSteps,
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
import type { CloudCompanyComputerSessionFactory } from "./cloud-company-computer-control.ts";
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
import { CloudControlRpcEnded, cloudControlRetryable, cloudControlTransientCode } from "./cloud-control-errors.ts";
import { type CloudCompanyDataDoor, cloudDataTools } from "./cloud-data-tools.ts";
import { cloudEventTools } from "./cloud-event-tools.ts";
import { cloudAppGroupsTool } from "./cloud-folder-app-groups.ts";
import { cloudAppTools } from "./cloud-folder-app-tools.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import { CloudFolderGroupChats } from "./cloud-folder-group-chats.ts";
import { CloudFolderHiring } from "./cloud-folder-hiring.ts";
import { cloudInterfaceTools } from "./cloud-folder-interface-tools.ts";
import { cloudInterfaceWriteTools } from "./cloud-folder-interface-writes.ts";
import { CloudFolderNotebooks } from "./cloud-folder-notebooks.ts";
import { cloudPictureTool } from "./cloud-folder-picture-tool.ts";
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
	cloudAgentFolderPlace,
	cloudCompanyContextTool,
	cloudNativeStableInstructions,
	cloudNativeTurnCorrection,
	compileCloudNativeCompanyInstructions,
	composeCloudContinuation,
	composeCloudNativeCompanyPrompt,
	composeCloudRoomRequest,
	parseCloudNativeCompanyContext,
} from "./cloud-native-company-context.ts";
import { cloudNativeContextIdentity } from "./cloud-native-context-composition.ts";
import { type NativeRuntimeFailureStage, tagNativeRuntimeFailure } from "./cloud-native-failure.ts";
import { CHATGPT_PLAN_DIRECTORY, type NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
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
	type CloudNativeToolRun,
	cloudRunRowWrite,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CLOUD_NATIVE_TOOL_CATALOG_BYTES,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	cloudToolJsonText,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperationControlPlane } from "./cloud-native-tool-operations.ts";
import { cloudToolsOnDemand } from "./cloud-native-tools-on-demand.ts";
import { CloudPictureChannel } from "./cloud-picture-channel.ts";
import { cloudRecordReflectionTool, readCloudPlatformUpdates } from "./cloud-platform-updates.ts";
import { cloudReviewRuleTools } from "./cloud-review-rule-tools.ts";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "./cloud-routine-tools.ts";
import { type CloudRunLog, CloudRunLogGone } from "./cloud-run-log.ts";
import { CloudRunLogCompanyFolder } from "./cloud-run-log-folder.ts";
import { openCloudRunLog } from "./cloud-run-log-open.ts";
import { CloudRunLogRpcProtection } from "./cloud-run-log-protection.ts";
import { CloudRunResumeRpc } from "./cloud-run-resume.ts";
import { assertCloudRuntimeBundle } from "./cloud-runtime-bundle.ts";
import {
	assertCloudRuntimeObservationBatchReceipt,
	CloudRuntimeObservability,
	type CloudRuntimeToolOperation,
	cloudRuntimeErrorCategory,
} from "./cloud-runtime-observability.ts";
import {
	type CloudRuntimeReasoningEffort,
	type CloudRuntimeServiceTier,
	isCloudRuntimeServiceTier,
} from "./cloud-runtime-policy.ts";
import { type CloudSecretOperationClient, cloudSecretTools, describeCloudSecretTools } from "./cloud-secret-tools.ts";
import { cloudSidebarTools } from "./cloud-sidebar-tools.ts";
import { cloudSiteTools } from "./cloud-site-tools.ts";
import { cloudSkillTools, composeCloudAgentSkills, unavailableCloudAgentSkills } from "./cloud-skill-tools.ts";
import {
	CLOUD_ASK_MEMBER_INPUT_SCHEMA,
	cloudAskMemberFinalKey,
	cloudAskMemberInstructions,
	cloudInteractionEventId,
	parseCloudAskMemberInput,
} from "./cloud-thread-interactions.ts";
import {
	type CloudWakeControl,
	type CloudWakeEnvelope,
	cloudCoworkerMessageTool,
	cloudWakeIsConversationPost,
	cloudWakeIsOwnThread,
	parseCloudWakeEnvelope,
} from "./cloud-wake-bus.ts";
import { cloudWorkerToolFilter, cloudWorkerTools, describeCloudAgentOpenWork } from "./cloud-worker-tools.ts";
import { MemoryCompactChannel, MemoryCompactLane, MemoryCompactStop } from "./memory-tree/compact.ts";
import { memoryCacheKeyComposer, memoryCommitView, memoryComposeView } from "./memory-tree/compose.ts";
import { CloudConversationLines, memoryCompactionRecorder } from "./memory-tree/conversation-lines.ts";
import { memoryPromptCacheKey } from "./memory-tree/view.ts";
import { memoryZoomTool } from "./memory-tree/zoom.ts";

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

/** Whether an identity root is a ChatGPT plan run's: its host wrote the plan's token directory there. Anything but a
 * clear absence counts as one, so a run is never offered pictures it cannot make. */
async function chatGptPlanRun(identityRoot: string): Promise<boolean> {
	try {
		await lstat(join(identityRoot, CHATGPT_PLAN_DIRECTORY));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
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
	readonly #computerSession: CloudCompanyComputerSessionFactory | undefined;
	readonly #coding: CloudNativeCodingDriver | undefined;
	readonly #machines: ((binding: CloudNativeToolBinding) => CloudMachineCommandGateway) | undefined;
	readonly #homeChannel: ((binding: CloudNativeToolBinding) => CloudCodexHomeChannel) | undefined;
	readonly #codingValues: CloudMachineCodingValues | undefined;
	readonly #folderSearch: { readonly socketPath: string } | undefined;
	readonly #companyData: CloudCompanyDataDoor | undefined;
	readonly #folderBytes: (
		binding: CloudNativeToolBinding,
		identity: CloudNativeToolIdentity,
	) => CloudCompanyFolderBytes;

	constructor(options: {
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
		/** Explicit cloud-office adapter; no local execution or inferred resource grant. */
		computerSession?: CloudCompanyComputerSessionFactory;
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
	}) {
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
		this.#computerSession = options.computerSession;
		this.#homeChannel = options.homeChannel;
		this.#coding = options.coding;
		this.#machines = options.machines;
		this.#codingValues = options.codingValues;
		this.#folderBytes = options.folderBytes;
		this.#folderSearch = options.folderSearch ? Object.freeze({ ...options.folderSearch }) : undefined;
		this.#companyData = options.companyData;
	}

	/** The effort and tier of the last successful run per identity root: a spare starts with them. */
	readonly #spareEfforts = new Map<
		string,
		{ reasoningEffort: CloudRuntimeReasoningEffort; serviceTier: CloudRuntimeServiceTier }
	>();

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
				composition.finish("succeeded", { outputBytes: 0 });
				return await this.#coding.execute(request, identityRoot, signal, {
					binding,
					identity: context.identity,
					wake,
					observability,
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
			// A post in a conversation is the run's request (21 October 2026, item 3): the post the wake names, or a card
			// answer with its card, read whole from the history alongside the reads below. It never fails the run.
			const roomRequest = composeCloudRoomRequest(context, wake, this.#paths, binding, signal);
			roomRequest.catch(() => undefined);
			// A continuation past the context's excerpt is shown to 32 KiB, the pages after it read alongside the reads below, as
			// the run would read it first (perf sprint T7). It never fails the run.
			const continuationShown = composeCloudContinuation(context, this.#paths, binding, signal);
			continuationShown.catch(() => undefined);
			let requestSources: readonly CloudCompanyContextSource[] = [];
			const machinesAvailable = await machinesRequest;
			stage = "codex-home";
			const home = await homeRequest;
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
			stage = "prompt-composition";
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
			// Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §5.3, M1b-4a, M4c): an agent's run on a post in a conversation,
			// its own thread or a group chat it is in, may see the primary view of that conversation, with the branches
			// (§5.5, its other conversations), instead of the history before it. The host call answers whether it does
			// (only a run recorded in the Shared context beta has one, 20260930508000); a run that has the view has zoom
			// and the conversation's prompt cache key (§6.2). A worker is not one; it gets its parent's view (W4).
			const memoryTree =
				context.identity.audienceKind === "company" &&
				context.identity.sessionId !== null &&
				cloudWakeIsConversationPost(wake) &&
				!cloudWorkerToolFilter(wake).isWorker;
			// Such a run writes its conversation's tree too (§5.4, §7.1, M1b-4b-3), through the compactor its Codex session
			// answers: the writer reads the conversation and its tree now, alongside the reads below, so the catalog offers
			// zoom to a run that has the view; it settles the tree at the opening and closes it after the agent's turn.
			// The tree shares the run's compactor lane with the run's log (below).
			const compactor = new MemoryCompactChannel();
			const lane = new MemoryCompactLane();
			const lines = memoryTree
				? new CloudConversationLines({
						control: this.#paths,
						binding,
						folder: folder.client,
						call: compactor.call,
						lane,
						record: memoryCompactionRecorder(this.#paths, binding),
					})
				: undefined;
			const viewedRequest = lines ? lines.open(signal) : Promise.resolve(false);
			viewedRequest.catch(() => undefined);
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
				const initialPresence =
					typeof firstChange?.path === "string"
						? await observeCloudCompanyPathPresence(presence, firstChange.path, "object", "reading", signal)
						: undefined;
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
					readCloudAgentHeadReading(notebooks.composition, signal),
				]);
				return {
					initialPresence,
					gateway,
					memory,
					skills,
					vision,
					reading,
					openWork: await openWorkRequest,
					senses: await sensesRequest,
					proposals: await proposalsRequest,
					platformUpdates: await updatesRequest,
				};
			};
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
			} = await composeContext().catch(async (error) => {
				await connectorTools();
				throw error;
			});
			const connectorDescriptors = await connectorTools();
			const viewed = await viewedRequest;
			signal.throwIfAborted();
			// The run's work log (RUNTIME-AGENT-MEMORY-TREE.md §4.5, W1c-3), opened with its tools: its step lines build
			// in the run's compactor lane, on threads this run's Codex session answers (§7.1), and its work composer
			// serves the agent's requests from then on (§5.7). A run without a log sends each request as Codex built it,
			// with only its receipts' work message added on a resumed attempt (20260930539000).
			let runWork: CloudCodexContextComposer | undefined;
			const composeRun: CloudCodexContextComposer = (request, composeSignal) =>
				runWork ? runWork(request, composeSignal) : cloudNativeContextIdentity(request);
			const connectorEffects = cloudConnectorEffects(connectorDescriptors);
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
					const wait = lines && viewed ? await lines.settle(openingSignal) : { waitMs: 0, waitedLines: 0 };
					// A failed view keeps the history. Zoom stays: the catalog was admitted with it.
					const view = viewed
						? await memoryComposeView(this.#paths, binding, openingSignal).catch((error) => {
								if (!openingSignal.aborted)
									console.error(
										`Memory view was not composed (${cloudRuntimeErrorCategory(error, openingSignal)})`,
									);
								return null;
							})
						: null;
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
					// The primary view (§5.3) goes after the head; the context message keeps the history after it.
					const views = redactCloudWebhookSecrets(view?.views ?? "");
					// What the instructions are composed for: the run's tools and whether the vision is agreed (T3-2).
					if (!offeredTools) throw new Error("The run's tools were not made before its opening");
					const parts = { head: head.text, views, tools: offeredTools, visionAgreed: cloudVisionAgreed(vision) };
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
						view?.tree,
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
					// What composition read from the folder is released under the composed context before any model request,
					// with the paths of the proposals it shows (P40b).
					await notebooks.releaseComposition(contextSha256, openingSignal, [
						...(proposals?.reads ?? []),
						...(updates ? (platformUpdates?.reads ?? []) : []),
					]);
					// So are the summary lines the view and the branches show, and the run's first request is recorded with
					// the settle's wait (§13). A failed release fails the run. A failed record leaves it without the answer,
					// the view reference (W4a-1), which is for the workers the run dispatches (W4b).
					if (view)
						await memoryCommitView(
							this.#paths,
							binding,
							view,
							{
								contextSha256,
								headBytes: Buffer.byteLength(head.text),
								stablePrefixSha256: createHash("sha256")
									.update(cloudNativeStableInstructions(context, parts, cloudWorkerToolFilter(wake).isWorker))
									.digest("hex"),
							},
							wait,
							openingSignal,
						);
					composed = {
						prompt,
						runtimeInstructions: compileCloudNativeCompanyInstructions(context, wake, parts),
						// The tool-result rules stand inside them, after the company's files (track 3, T3-3).
						resultRulesInside: true,
						// Every request of a run with the view shares its conversation's cache key (§6.2).
						composeContext:
							view && context.identity.sessionId !== null
								? memoryCacheKeyComposer(
										memoryPromptCacheKey({
											payerLoginConnectionId: context.identity.providerConnectionId,
											agentId: context.identity.staffAgentId,
											conversationId: context.identity.sessionId,
										}),
										composeRun,
									)
								: composeRun,
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
			): Promise<T> => cloudRunRowWrite(toolRun, write, toolSignal ? AbortSignal.any([signal, toolSignal]) : signal);
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
					const card = await publicWrite(
						(requestSignal) => append.call(control, request, { eventId, data: input.data }, requestSignal),
						toolContext.signal,
					);
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
			try {
				stage = "native-tools";
				// Whether the run had a machine, whose changes are noted after it (Interfaces I10, below).
				let machine = false;
				// The run's own offline commands (F3 4d): its computer tools add each one it starts, and its action review
				// lets input to them through as it lets their start through.
				const offlineShells = new Set<string>();
				// A worker's report, once the folder saved it: its run's closing act (turnCorrection, below).
				let workerReported = false;
				// Pictures are made on the run's own Codex sign-in (cloud-picture-channel.ts), which a run on a member's
				// ChatGPT plan has not: it gets no picture lane and is not offered make_picture. Its identity root says so, as
				// the session reads it.
				const pictures = (await chatGptPlanRun(identityRoot)) ? undefined : new CloudPictureChannel();
				const result = await runCloudNativeRunToolSession({
					observability,
					binding,
					serviceTier,
					controlPlane: this.#control,
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
					...(pictures ? { pictures } : {}),
					...(lines && viewed ? { closing: (closingSignal) => lines.close(closingSignal) } : {}),
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
					...(home && this.#homeChannel
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
											const closing = AbortSignal.timeout(CLOUD_HOME_CLOSE_MS);
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
							request: cloudActionReviewRequest(context, wake),
							// What the agent works for, from its files as this run read them: a run no member started is
							// judged by it (2026-10-22 amendment, item 2). A vision too large to read as text is left out.
							mandate: cloudActionReviewMandate(context, wake, vision && "text" in vision ? vision.text : null),
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
						const opened = await openCloudRunLog({
							resume: new CloudRunResumeRpc({ run, control: this.#paths }),
							folder: new CloudRunLogCompanyFolder({
								environmentId: identity.environmentId,
								runId: binding.runId,
								folder: folder.client,
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
								effectful: (tool, parsed) =>
									cloudActionEffect(tool, parsed, connectorEffects, offlineShells) !== "read",
							},
							lines: { call: compactor.call, lane },
						}).catch((error: unknown) => {
							throw error instanceof CloudRunLogGone
								? tagNativeRuntimeFailure(error, "native-tools", "authority_unavailable")
								: error;
						});
						runWork = opened?.composeContext;
						const computer = await this.#computerSession?.(run, operations, { offlineShells });
						if (computer) machine = true;
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
						const runTools: CloudNativeTool[] = [
							...(computer?.tools ?? []),
							// A run's file tools act through the folder core with its own authority (P19), and so do the
							// tools that read and write its interfaces and tables (Interfaces I8a, I8b).
							...[
								...cloudFolderFileTools({ folder: folder.client, operations, identity }),
								...cloudInterfaceTools({
									folder: folder.client,
									identity,
									timeZone: wake.time.timeZone,
								}),
								...cloudInterfaceWriteTools({ folder: folder.client, operations, identity }),
								// Interface apps: pages the agent makes to show members its work (5 November 2026).
								...cloudAppTools({ folder: folder.client, operations, identity }),
								// A picture the agent makes, saved in the folder as a write is (20260930746000).
								...(pictures
									? [cloudPictureTool({ folder: folder.client, operations, identity, pictures })]
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
								? cloudDataTools({ folder: folder.client, door: this.#companyData, apply: !work.isWorker })
								: []),
							cloudCompanyContextTool(context, binding, this.#paths, () => requestSources),
							...(viewed ? [memoryZoomTool(binding, identity, this.#paths)] : []),
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
										...cloudSidebarTools(binding, identity, {
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
										}),
										// The apps drawer's groups, the twin of the sidebar's sections (APP-GROUPS-SPEC §3).
										cloudAppGroupsTool({ folder: folder.client, operations, identity }),
										...cloudReviewRuleTools(binding, identity, this.#paths),
										// Good will (20260930566000): last month's payments and sorting them, the Co-Founder's until
										// an agent owns the company's money.
										...cloudGoodWillTools(binding, identity, this.#paths),
										// The Co-Founder deals the team out between the members (20260930702000).
										...(context.agentKind === "cofounder"
											? cloudMemberOfferTools(binding, identity, this.#paths)
											: []),
										...(context.agentKind === "cofounder" && identity.audienceKind === "company"
											? [cloudRecordReflectionTool({ folder: folder.client, operations, identity })]
											: []),
										// The company's reading of itself (20260930766000): the Co-Founder keeps it, in its company runs.
										...(context.agentKind === "cofounder" && identity.audienceKind === "company"
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
										...(work.isWorker
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
							captures: computer?.captures,
							folderReports: computer?.folderReports,
							tools: offered.tools,
							deferred: offered.deferred,
							assertContext: (requestSignal, timeoutMs) =>
								gateway.assertReadableContext(requestSignal, timeoutMs),
							checkRun: (requestSignal, timeoutMs) => gateway.checkRun(requestSignal, timeoutMs),
							recordContextView: (frame, outputs, requestSignal) =>
								gateway.recordContextView(frame, outputs, requestSignal),
							fenceContextView: (frame, outputs, requestSignal) =>
								gateway.fenceContextView(frame, outputs, requestSignal),
							...(computer || folderSearch
								? {
										close: async () => {
											folderSearch?.close();
											await computer?.close();
										},
									}
								: {}),
							...(opened?.log ? { runLog: { log: opened.log, lines: opened.lines } } : {}),
						};
					},
				}).finally(async () => {
					// What the run's machine saved under QorperaOS/interfaces/ or QorperaOS/tables/ (its shell, its screen)
					// shows in its conversation with Undo, as a tool's change does (Interfaces I10): SQL notes each of the run's
					// commits there once, now that the machine is closed. A note that fails leaves the change without its line;
					// the run's outcome stands.
					if (machine && context.identity.sessionId !== null)
						await folder.client.noteInterfaceChanges(signal).catch((error: unknown) => {
							console.error(
								`The run's interface changes were not noted (${cloudRuntimeErrorCategory(error, signal)})`,
							);
						});
				});
				// The provider failed the turn after the run's answer: the run is delivered, and what it met is still the
				// login's to know, as for a failed run (contract 17; the 2026-11-13 amendment). Recorded first, so nothing
				// after it can lose it.
				if (result.usageSignal) await this.#recordUsageSignalKind(binding, result.usageSignal);
				stage = "public-completion";
				const delivery = await mouth.finish(wake.policy.final === "required");
				this.#spareEfforts.set(identityRoot, { reasoningEffort: context.identity.reasoningEffort, serviceTier });
				return { providerSessionId: result.providerSessionId, delivery };
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
		this.#spareEfforts.set(identityRoot, { reasoningEffort: identity.reasoningEffort, serviceTier });
		return { providerSessionId: result.providerSessionId, delivery: { messageCount: 0, finalMessageId: null } };
	}

	/**
	 * Contract section 17: quota exhaustion, rate limiting and provider outage
	 * are typed signals recorded against the run's exact sponsor and connection
	 * version before the job fails. Recording never retries the provider, never
	 * masks the failure, and carries no provider text.
	 */
	async #recordUsageSignal(binding: CloudNativeToolBinding, error: unknown): Promise<void> {
		const kind = nativeProviderUsageSignal(error);
		if (kind) await this.#recordUsageSignalKind(binding, kind);
	}

	async #recordUsageSignalKind(binding: CloudNativeToolBinding, kind: NativeProviderUsageSignal): Promise<void> {
		try {
			// The 10 s is the call's own budget, so the transport waits that long too.
			await this.#paths.call(
				"qorpera_record_provider_usage_signal",
				{ p_binding: binding, p_signal_kind: kind },
				AbortSignal.timeout(10_000),
				10_000,
			);
		} catch {
			console.error(`Provider usage signal was not recorded (${kind})`);
		}
	}
}
