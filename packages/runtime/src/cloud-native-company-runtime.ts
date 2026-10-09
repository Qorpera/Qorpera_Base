import { createHash } from "node:crypto";
import { cloudAgentFolder } from "@qorpera/cloud-client/cloud-agent-folder";
import type { CloudContentAddressedStore } from "@qorpera/cloud-client/node/cloud-object-store";
import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_ACTION_REVIEW_HOLD_MS,
	CloudActionReviewGate,
	cloudActionReviewRequest,
	cloudConnectorEffects,
} from "./cloud-action-review.ts";
import { composeCloudAgentHead, readCloudAgentHeadVision } from "./cloud-agent-head.ts";
import { CLOUD_AGENT_SEND_INSTRUCTIONS, CloudAgentMouth, parseCloudAgentSendInput } from "./cloud-agent-mouth.ts";
import {
	type CloudChatGptPlanAuth,
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
import { cloudEventTools } from "./cloud-event-tools.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import { CloudFolderGroupChats } from "./cloud-folder-group-chats.ts";
import { CloudFolderHiring } from "./cloud-folder-hiring.ts";
import { cloudInterfaceTools } from "./cloud-folder-interface-tools.ts";
import { cloudInterfaceWriteTools } from "./cloud-folder-interface-writes.ts";
import { CloudFolderNotebooks } from "./cloud-folder-notebooks.ts";
import { CloudFolderProposals } from "./cloud-folder-proposals.ts";
import { CloudFolderRoutineDecision } from "./cloud-folder-routine-decision.ts";
import { CloudFolderRoutines } from "./cloud-folder-routines.ts";
import { CloudFolderSearch, cloudFolderSearchTool } from "./cloud-folder-search-tool.ts";
import { CloudFolderSidebar } from "./cloud-folder-sidebar.ts";
import { CloudFolderTodos } from "./cloud-folder-todos.ts";
import { CloudFolderWorkers } from "./cloud-folder-workers.ts";
import { cloudHiringTools } from "./cloud-hiring-tools.ts";
import type { CloudMachineCommandGateway } from "./cloud-machine-command-http.ts";
import { cloudMachineTools } from "./cloud-machine-tools.ts";
import { cloudMemoryTools, composeCloudAgentMemory, unavailableCloudAgentMemory } from "./cloud-memory-tools.ts";
import type { CloudNativeCodingDriver } from "./cloud-native-coding-runtime.ts";
import {
	cloudAgentFolderPlace,
	cloudCompanyContextTool,
	cloudNativeStableInstructions,
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
	CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
	type CloudNativeToolAuthorityReader,
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CLOUD_NATIVE_TOOL_CATALOG_BYTES,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperationControlPlane } from "./cloud-native-tool-operations.ts";
import { cloudReviewRuleTools } from "./cloud-review-rule-tools.ts";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "./cloud-routine-tools.ts";
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
import { cloudSkillTools, composeCloudAgentSkills, unavailableCloudAgentSkills } from "./cloud-skill-tools.ts";
import {
	CLOUD_ASK_MEMBER_INSTRUCTIONS,
	CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
	CLOUD_ASK_MEMBER_SURFACES,
	cloudAskMemberFinalKey,
	cloudInteractionEventId,
	parseCloudAskMemberInput,
} from "./cloud-thread-interactions.ts";
import {
	type CloudWakeControl,
	cloudCoworkerMessageTool,
	cloudWakeIsOwnThread,
	parseCloudWakeEnvelope,
} from "./cloud-wake-bus.ts";
import { cloudWorkerToolFilter, cloudWorkerTools, describeCloudAgentOpenWork } from "./cloud-worker-tools.ts";
import { memoryCacheKeyComposer, memoryCommitView, memoryComposeView } from "./memory-tree/compose.ts";
import { memoryPromptCacheKey } from "./memory-tree/view.ts";
import { memoryZoomTool } from "./memory-tree/zoom.ts";

// The company runtime's control plane completes folder receipts: a folder-v2 run's writers commit under them.
type NativeCompanyControl = CloudNativeToolAuthorityReader &
	CloudNativeToolOperationControlPlane &
	Required<Pick<CloudNativeToolOperationControlPlane, "completeFolderToolOperation">> &
	Pick<NativeProviderControlPlane, "sendMessage" | "appendInteractionRequest">;

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
	readonly #chatGptPlanAuth: CloudChatGptPlanAuth | undefined;
	readonly #secretBroker: CloudSecretOperationClient | undefined;
	readonly #companyAccounts: CloudCompanyAccountClient | undefined;
	readonly #eventHooks: CloudCompanyFolderSignedHooks | undefined;
	readonly #computerSession: CloudCompanyComputerSessionFactory | undefined;
	readonly #coding: CloudNativeCodingDriver | undefined;
	readonly #machines: ((binding: CloudNativeToolBinding) => CloudMachineCommandGateway) | undefined;
	readonly #folderSearch: { readonly socketPath: string } | undefined;
	readonly #folderBytes: (
		binding: CloudNativeToolBinding,
		identity: CloudNativeToolIdentity,
	) => CloudCompanyFolderBytes;

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
		/** A company run's file bytes (core C1d: the object gateway's folder route). Every company run is a folder-v2
		 * run (legacy sweep step C, C-P1). */
		folderBytes: (binding: CloudNativeToolBinding, identity: CloudNativeToolIdentity) => CloudCompanyFolderBytes;
		/** The slot's relay to the node's folder search (F3, the shared execution host only): a folder-v2 run gets
		 * company_search over it. */
		folderSearch?: { readonly socketPath: string };
	}) {
		this.#control = options.controlPlane;
		this.#presenceFactory = options.presence;
		this.#paths = options.pathControl;
		this.#store = options.objectStore;
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
		this.#coding = options.coding;
		this.#machines = options.machines;
		this.#folderBytes = options.folderBytes;
		this.#folderSearch = options.folderSearch ? Object.freeze({ ...options.folderSearch }) : undefined;
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
			// the original order, so a failure still names its stage. Both lock the run's
			// job row, so each gets the pair's budget (the database serialises them).
			const contextRequest = cloudToolRequest(
				(requestSignal) =>
					this.#paths.call("qorpera_describe_company_run_context", { p_binding: binding }, requestSignal),
				signal,
				CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
			);
			const wakeRequest = cloudToolRequest(
				(requestSignal) => this.#paths.call("qorpera_read_native_wake", { p_binding: binding }, requestSignal),
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
			// the credential-free repository VM and two ways to end the turn.
			if (wake.kind === "agent" && wake.source.kind === "worker-dispatch" && wake.payload.species === "coding") {
				if (!this.#coding)
					throw new Error("Coding sessions run in the coding composition, which this node does not carry");
				stage = "prompt-composition";
				composition.finish("succeeded", { outputBytes: 0 });
				return await this.#coding.execute(request, identityRoot, signal, {
					binding,
					identity: context.identity,
					wake,
					observability,
				});
			}
			const machinesAvailable = await machinesRequest;
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
			// Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §5.3, M1b-4a): an agent's run in its own thread may see the
			// primary view of its conversation, with the branches (§5.5), instead of the history before it. The host call
			// answers whether it does (the company is listed once its trees are written); a run that has the view has zoom
			// and the conversation's prompt cache key (§6.2). A worker is not one; it gets its parent's view (W4).
			const memoryTree =
				context.identity.audienceKind === "company" &&
				context.identity.sessionId !== null &&
				cloudWakeIsOwnThread(wake) &&
				!cloudWorkerToolFilter(wake).isWorker;
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
					presence,
					binding,
					identity: context.identity,
					control: this.#paths,
					store: this.#store(context.identity.companyId, binding, signal),
				});
				// How much open work the agent has (counts only), where it keeps todos and workers:
				// a company run that is not itself a worker. Asked alongside the notebook; like
				// memory, it never blocks the run.
				const openWorkRequest =
					context.identity.audienceKind === "company" && !cloudWorkerToolFilter(wake).isWorker
						? describeCloudAgentOpenWork(binding, this.#paths, signal).catch(() => undefined)
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
				// The primary view and branches, asked alongside the notebook. A failure keeps the history, with no zoom.
				const viewRequest = memoryTree
					? memoryComposeView(this.#paths, binding, signal).catch((error) => {
							if (!signal.aborted)
								console.error(`Memory view was not composed (${cloudRuntimeErrorCategory(error, signal)})`);
							return null;
						})
					: Promise.resolve(null);
				// The agent's own notebook (contract 15.1) and its skill catalog (15.2) are
				// composed side by side through the trusted read lane; an unreadable one
				// degrades to "unavailable" and the run still starts, because neither is a
				// precondition of company work. The vision, for the head (RUNTIME-AGENT-MEMORY-TREE.md
				// §5.6), is read beside them; a failed read fails the composition, as the head is never cut.
				const [memory, skills, vision] = await Promise.all([
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
				]);
				return {
					initialPresence,
					gateway,
					memory,
					skills,
					vision,
					openWork: await openWorkRequest,
					proposals: await proposalsRequest,
					view: await viewRequest,
				};
			};
			const { initialPresence, gateway, memory, skills, vision, openWork, proposals, view } =
				await composeContext().catch(async (error) => {
					await connectorTools();
					throw error;
				});
			const connectorDescriptors = await connectorTools();
			signal.throwIfAborted();
			const head = composeCloudAgentHead(context, vision, memory);
			// The primary view (§5.3) goes after the head; the context message keeps the history after it.
			const views = view?.views ?? "";
			const prompt = composeCloudNativeCompanyPrompt(
				context,
				wake,
				initialPresence,
				memory,
				openWork,
				skills,
				proposals?.context,
				head,
				view?.tree,
			);
			// The run's context is its head and views (in the developer instructions) and its context message, hashed
			// together.
			const composed = `${head.text}\n${views}\n${prompt}`;
			const contextBytes = Buffer.byteLength(composed);
			composition.finish("succeeded", { outputBytes: contextBytes });
			const contextSha256 = createHash("sha256").update(composed).digest("hex");
			// What composition read from the folder is released under the composed context before any model request, with
			// the paths of the proposals it shows (P40b).
			await notebooks.releaseComposition(contextSha256, signal, proposals?.reads);
			// So are the summary lines the view and the branches show, and the run's first request is recorded (§13). A
			// failed release fails the run. A failed record leaves it without the answer, the view reference (W4a-1),
			// which is for the workers the run dispatches (W4b).
			if (view)
				await memoryCommitView(
					this.#paths,
					binding,
					view,
					{
						contextSha256,
						headBytes: Buffer.byteLength(head.text),
						stablePrefixSha256: createHash("sha256")
							.update(cloudNativeStableInstructions(context, { head: head.text, views }))
							.digest("hex"),
					},
					signal,
				);
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
			// A typed card for the member: appended under the run's lease authority, then
			// the final send of its sentence. The card precedes the sentence so a failed
			// send leaves a retryable tool call, never a turn that ended without its card.
			const control = this.#control;
			const ask: CloudNativeTool = {
				name: "ask_member" satisfies CloudRuntimeToolOperation,
				source: "runtime",
				description: CLOUD_ASK_MEMBER_INSTRUCTIONS,
				inputSchema: {
					type: "object",
					properties: {
						idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
						text: { type: "string", minLength: 1, maxLength: 4096 },
						surface: { type: "string", enum: [...CLOUD_ASK_MEMBER_SURFACES] },
						title: { type: "string", minLength: 1, maxLength: 200 },
						body: { type: "string", maxLength: 2000 },
						expiresAt: { type: "string" },
						payload: CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
					},
					required: ["idempotencyKey", "text", "surface", "title", "payload"],
					additionalProperties: false,
				},
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
					const card = await cloudToolRequest(
						(requestSignal) => append.call(control, request, { eventId, data: input.data }, requestSignal),
						signal,
					);
					if (card.sessionId !== context.identity.sessionId) throw new Error("Cloud card audience changed");
					const receipt = await mouth.send(sentence);
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
				const result = await runCloudNativeRunToolSession({
					observability,
					binding,
					serviceTier,
					controlPlane: this.#control,
					beginExecution: async (specification, requestSignal) => {
						const toolCatalogText = cloudToolJsonText(specification, CLOUD_NATIVE_TOOL_CATALOG_BYTES);
						const started = await this.#paths.call(
							"qorpera_begin_native_company_execution_v2",
							{
								p_binding: binding,
								p_binary_sha256: this.#sha256,
								p_runtime_bundle_sha256: context.identity.runtimeBundleSha256,
								p_reasoning_policy_sha256: context.identity.reasoningPolicySha256,
								p_tool_catalog_text: toolCatalogText,
								p_context_sha256: contextSha256,
								p_context_bytes: contextBytes,
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
							contextBytes,
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
					...(this.#spareEfforts.has(identityRoot) ? { reusedIdentityRoot: true } : {}),
					isolation: this.#isolation,
					...(this.#chatGptPlanAuth ? { chatGptPlanAuth: this.#chatGptPlanAuth } : {}),
					prompt,
					runtimeInstructions: compileCloudNativeCompanyInstructions(context, wake, { head: head.text, views }),
					// Every request of a run with the view shares its conversation's cache key (§6.2).
					...(view && context.identity.sessionId !== null
						? {
								composeContext: memoryCacheKeyComposer(
									memoryPromptCacheKey({
										payerLoginConnectionId: context.identity.providerConnectionId,
										agentId: context.identity.staffAgentId,
										conversationId: context.identity.sessionId,
									}),
								),
							}
						: {}),
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
							holdMs: ["human", "room", "first-run"].includes(wake.kind) ? CLOUD_ACTION_REVIEW_HOLD_MS : 0,
							connectorEffects: cloudConnectorEffects(connectorDescriptors),
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
						const computer = await this.#computerSession?.(run, operations);
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
						return {
							captures: computer?.captures,
							tools: [
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
								cloudCompanyContextTool(context, binding, this.#paths),
								...(view ? [memoryZoomTool(binding, identity, this.#paths)] : []),
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
												this.#paths,
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
											...(dynamicRoutine
												? [
														cloudRoutineDecisionTool(binding, identity, this.#paths, {
															decisionOwed: () => routineDecisionOwed,
															decided: () => {
																routineDecisionOwed = false;
															},
															...(wake.routine?.routineKey
																? {
																		folderDecision: new CloudFolderRoutineDecision({
																			folder: folder.client,
																			operations,
																			identity,
																			handle: folder.handle,
																			routineKey: wake.routine.routineKey,
																			routineId: wake.routine.id,
																		}),
																	}
																: {}),
														}),
													]
												: []),
											...cloudSidebarTools(binding, identity, this.#paths, {
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
											...cloudReviewRuleTools(binding, identity, this.#paths),
											// The agent changes the company's hooks through its folder client (E3a).
											// save_attachment, which wrote through the path gateway, is not offered:
											// no company run uses that gateway's files (M2c-1).
											...cloudEventTools(binding, identity, this.#paths, undefined, folder.client),
										]),
								// Machines are the company's: any agent run in a company conversation may start and
								// use them and hears about them in that conversation; a worker uses them like its agent
								// but waits for its own commands in its run (Jonas, 2026-09-28).
								...(this.#machines && machinesAvailable && identity.audienceKind === "company"
									? cloudMachineTools({
											binding,
											identity,
											control: this.#paths,
											operations,
											gateway: this.#machines(binding),
											worker: work.isWorker,
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
												: cloudHiringTools(gateway, identity, undefined, {
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
											}),
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
							],
							assertContext: (requestSignal) => gateway.assertReadableContext(requestSignal),
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
						};
					},
				});
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
