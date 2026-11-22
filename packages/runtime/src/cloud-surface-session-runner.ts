import {
	compileIdentityTokens,
	IDENTITY_BRIEF_PATH,
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	IDENTITY_VOICE_PATH,
	type PointToChangeTarget,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	parsePointToChangeTarget,
	SHARED_COMPANY_ASSET_PATHS,
	type SurfaceSessionQuestion,
	type SurfaceSourceKind,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import type { CloudNativeCodingDriver, CloudNativeCodingTurnContext } from "./cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "./cloud-native-provider-host.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import {
	type CloudSurfaceToolsPort,
	createStageSurfaceOpsActionTool,
	createStageSurfacePatchTool,
	type SurfaceOpsActionToolPort,
	type SurfacePatchToolPort,
	type SurfaceToolsRpcClient,
} from "./cloud-surface-tools.ts";
import {
	buildSurfaceTurnBrief,
	SURFACE_STAGED_CODING_INSTRUCTIONS,
	type SurfaceCodingTurnBinding,
	type SurfaceIdentityContext,
	type SurfaceSharedAssetsContext,
} from "./cloud-surface-turn-context.ts";

const MAX_IDENTITY_BRIEF_BYTES = 16_384;
const MAX_IDENTITY_VOICE_BYTES = 8_192;
const MAX_IDENTITY_TOKENS_BYTES = 16_384;
const MAX_SHARED_ASSET_BYTES = 32_768;
const MAX_SURFACE_BRIEF_BYTES = 32_768;
const MAX_FAILURE_REPLY_CHARS = 500;
const READ_ONLY_FOLDER_TOOLS = new Set(["company_read", "company_list"]);

const SHARED_ASSET_BYTE_LIMITS: Readonly<Record<(typeof SHARED_COMPANY_ASSET_PATHS)[number], number>> = {
	[IDENTITY_BRIEF_PATH]: MAX_IDENTITY_BRIEF_BYTES,
	[IDENTITY_VOICE_PATH]: MAX_IDENTITY_VOICE_BYTES,
	[IDENTITY_TOKENS_JSON_PATH]: MAX_IDENTITY_TOKENS_BYTES,
	[IDENTITY_TOKENS_CSS_PATH]: MAX_IDENTITY_TOKENS_BYTES,
	[IDENTITY_LOGO_PATH]: MAX_SHARED_ASSET_BYTES,
	[IDENTITY_COMPANY_PATH]: MAX_SHARED_ASSET_BYTES,
	[PRODUCT_SPECS_PATH]: MAX_SHARED_ASSET_BYTES,
	[PRODUCT_CATALOG_PATH]: MAX_SHARED_ASSET_BYTES,
};

export interface SurfaceSharedAssetsSnapshot extends SurfaceSharedAssetsContext {
	readonly briefMarkdown: string | null;
	readonly voiceSummary: string | null;
	readonly tokensJson: string | null;
	readonly tokensCss: string | null;
	readonly companyProfileJson: string | null;
	readonly productSpecsJson: string | null;
	readonly productCatalogJson: string | null;
	readonly logoSvg: string | null;
	readonly hasLogoSvg: boolean;
}

export interface SurfaceFolderTextReader {
	readText(path: string, maxBytes: number, signal: AbortSignal): Promise<{ readonly text: string } | string | null>;
}

export interface SurfaceSessionTurnInput {
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly companyId: string;
	readonly surfaceSlug: string;
	readonly surfaceTitle: string;
	readonly sourceKind: SurfaceSourceKind;
	readonly prompt: string;
	readonly state?: "queued" | "reconciling";
	readonly repositoryKey?: string | null;
	readonly folderRoot?: string | null;
	readonly briefSummary?: string | null;
	readonly briefMarkdown?: string | null;
	readonly explorationVariantLabel?: string | null;
	readonly originKind?: string;
	readonly originRef?: unknown;
	readonly conflictPaths?: readonly string[] | null;
	readonly leaseToken?: string | null;
}

export interface SurfaceSessionTurnCompletion {
	readonly sessionId: string;
	readonly companyId?: string;
	readonly state: "ready" | "needs_input" | "failed";
	readonly replyText: string | null;
	readonly question: SurfaceSessionQuestion | null;
	readonly notePaths: readonly string[] | null;
	readonly branchHeadSha: string | null;
	readonly leaseToken?: string | null;
}

export interface SurfaceSessionCompletionPort {
	completeSessionTurn(completion: SurfaceSessionTurnCompletion, signal: AbortSignal): Promise<void>;
}

export interface SurfaceSessionLeaseRenewalInput {
	readonly sessionId: string;
	readonly companyId?: string;
	readonly leaseToken: string;
	readonly extendSeconds: number;
}

export interface SurfaceSessionLeaseRenewalPort {
	renewSessionLease(
		input: SurfaceSessionLeaseRenewalInput,
		signal: AbortSignal,
	): Promise<{ readonly renewed: boolean } | undefined>;
}

export interface SurfaceSessionTurnExecutionOutcome {
	readonly state?: "ready" | "needs_input" | "failed";
	readonly replyText?: string | null;
	readonly question?: SurfaceSessionQuestion | null;
	readonly notePaths?: readonly string[] | null;
	readonly branchHeadSha?: string | null;
}

export interface SurfaceFolderOrOpsTurnRequest {
	readonly input: SurfaceSessionTurnInput;
	readonly mode: "folder" | "native_ops";
	readonly instructions: string;
	readonly turnBrief: string;
	readonly tools: readonly CloudNativeTool[];
	readonly identityContext: SurfaceIdentityContext | null;
	readonly sharedAssets?: SurfaceSharedAssetsContext | null;
	readonly allowedRoots: readonly string[];
	readonly signal: AbortSignal;
}

export interface SurfaceCodeRepoTurnRequest {
	readonly input: SurfaceSessionTurnInput;
	readonly binding: SurfaceCodingTurnBinding;
	readonly instructions: string;
	readonly turnBrief: string;
	readonly signal: AbortSignal;
}

export interface SurfaceSessionFolderToolsContext {
	readonly folder: CloudCompanyFolderClient;
	readonly operations: CloudNativeToolOperations;
	readonly identity: CloudNativeToolIdentity;
}

export interface SurfaceCodingDriverPreparedTurn {
	readonly request: NativeCompanyExecutionRequest;
	readonly identityRoot: string;
	readonly context: Omit<CloudNativeCodingTurnContext, "surfaceSession">;
	readonly extractOutcome?: (
		result: Awaited<ReturnType<CloudNativeCodingDriver["execute"]>>,
	) => SurfaceSessionTurnExecutionOutcome;
}

export interface SurfaceCodingDriverBinding {
	readonly driver: CloudNativeCodingDriver;
	prepareRequest(request: SurfaceCodeRepoTurnRequest): Promise<SurfaceCodingDriverPreparedTurn>;
}

export interface SurfaceSessionRunnerPorts {
	readonly folder?: SurfaceFolderTextReader;
	readonly folderToolsContext?: SurfaceSessionFolderToolsContext;
	readonly surfaceTools: Partial<
		Pick<CloudSurfaceToolsPort, "recordChange"> & SurfacePatchToolPort & SurfaceOpsActionToolPort
	>;
	readonly extraTools?: readonly CloudNativeTool[];
	readonly executeTurn?: (request: SurfaceFolderOrOpsTurnRequest) => Promise<SurfaceSessionTurnExecutionOutcome>;
	readonly executeCodeRepoTurn?: (request: SurfaceCodeRepoTurnRequest) => Promise<SurfaceSessionTurnExecutionOutcome>;
	readonly codingDriver?: SurfaceCodingDriverBinding;
	readonly completeSessionTurn: SurfaceSessionCompletionPort["completeSessionTurn"];
	readonly renewSessionLease?: SurfaceSessionLeaseRenewalPort["renewSessionLease"];
	readonly leaseRenewIntervalMs?: number;
	readonly leaseExtendSeconds?: number;
	readonly completionRetryDelaysMs?: readonly number[];
	readonly signal?: AbortSignal;
}

export interface SurfaceSessionTurnRunResult {
	readonly sessionId: string;
	readonly sourceKind: SurfaceSourceKind;
	readonly state: "ready" | "needs_input" | "failed";
	readonly identityLoaded: boolean;
	readonly sharedAssetsLoaded?: boolean;
	readonly replyText: string | null;
	readonly question: SurfaceSessionQuestion | null;
	readonly notePaths: readonly string[] | null;
	readonly branchHeadSha: string | null;
	readonly error: string | null;
	readonly cause?: unknown;
}

export interface SurfaceSessionDeliveryJob {
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly profileId: string;
	readonly state?: "queued" | "reconciling";
	readonly prompt: string;
	readonly originKind?: string;
	readonly originRef?: unknown;
	readonly repositoryKey?: string | null;
	readonly folderRoot?: string | null;
	readonly surfaceSlug?: string;
	readonly surfaceTitle?: string;
	readonly surfaceArchetype?: string;
	readonly surfaceSourceKind?: SurfaceSourceKind;
	readonly surfaceKind?: string;
	readonly briefSummary?: string | null;
	readonly explorationId?: string | null;
	readonly explorationVariantLabel?: string | null;
	readonly siteSlug?: string | null;
	readonly identityFolderRoot?: string | null;
	readonly retryCount?: number;
	readonly sponsor?: { readonly sponsorBindingId: string; readonly sponsorVersion: number } | null;
	readonly leaseToken?: string | null;
}

export interface SurfaceSessionProviderHookFailure {
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly companyId: string;
	readonly machineId: string;
	readonly error: string;
}

export interface SurfaceSessionProviderHookPorts {
	resolveRunnerPorts(
		job: SurfaceSessionDeliveryJob,
		machineId: string,
		signal: AbortSignal,
	): Promise<SurfaceSessionRunnerPorts> | SurfaceSessionRunnerPorts;
	onResult?: (
		result: SurfaceSessionTurnRunResult,
		job: SurfaceSessionDeliveryJob,
		machineId: string,
	) => void | Promise<void>;
	onError?: (failure: SurfaceSessionProviderHookFailure) => void | Promise<void>;
}

export interface SurfaceSessionProviderHook {
	deliverSurfaceSession(job: SurfaceSessionDeliveryJob, machineId: string, signal?: AbortSignal): Promise<void>;
	runDeliveredSession(
		job: SurfaceSessionDeliveryJob,
		machineId: string,
		signal?: AbortSignal,
	): Promise<SurfaceSessionTurnRunResult>;
}

function normalizeFolderRoot(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

async function readOptionalFolderText(
	folder: SurfaceFolderTextReader,
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<string | null> {
	try {
		const result = await folder.readText(path, maxBytes, signal);
		if (result === null || result === undefined) return null;
		const text = typeof result === "string" ? result : result.text;
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	}
}

export async function loadSurfaceIdentityContext(
	folder: SurfaceFolderTextReader,
	signal: AbortSignal,
): Promise<SurfaceIdentityContext | null> {
	const [briefMarkdown, voiceSummary, tokensJson] = await Promise.all([
		readOptionalFolderText(folder, IDENTITY_BRIEF_PATH, MAX_IDENTITY_BRIEF_BYTES, signal),
		readOptionalFolderText(folder, IDENTITY_VOICE_PATH, MAX_IDENTITY_VOICE_BYTES, signal),
		readOptionalFolderText(folder, IDENTITY_TOKENS_JSON_PATH, MAX_IDENTITY_TOKENS_BYTES, signal),
	]);
	if (!briefMarkdown && !voiceSummary && !tokensJson) return null;
	return { briefMarkdown, voiceSummary, tokensJson };
}

export async function loadSurfaceSharedAssets(
	folder: SurfaceFolderTextReader,
	signal: AbortSignal,
): Promise<SurfaceSharedAssetsSnapshot | null> {
	const entries = await Promise.all(
		SHARED_COMPANY_ASSET_PATHS.map(
			async (path) =>
				[path, await readOptionalFolderText(folder, path, SHARED_ASSET_BYTE_LIMITS[path], signal)] as const,
		),
	);
	const byPath = new Map<string, string | null>(entries);
	const briefMarkdown = byPath.get(IDENTITY_BRIEF_PATH) ?? null;
	const voiceSummary = byPath.get(IDENTITY_VOICE_PATH) ?? null;
	const tokensJson = byPath.get(IDENTITY_TOKENS_JSON_PATH) ?? null;
	const existingTokensCss = byPath.get(IDENTITY_TOKENS_CSS_PATH) ?? null;
	let compiledTokensCss: string | null = null;
	if (existingTokensCss === null && tokensJson !== null) {
		const compiled = compileIdentityTokens(tokensJson);
		if (Object.keys(compiled.vars).length > 0) {
			compiledTokensCss = compiled.css;
		}
	}
	const tokensCss = existingTokensCss ?? compiledTokensCss;
	const companyProfileJson = byPath.get(IDENTITY_COMPANY_PATH) ?? null;
	const productSpecsJson = byPath.get(PRODUCT_SPECS_PATH) ?? null;
	const productCatalogJson = byPath.get(PRODUCT_CATALOG_PATH) ?? null;
	const logoSvg = byPath.get(IDENTITY_LOGO_PATH) ?? null;
	const hasLogoSvg = logoSvg !== null;
	if (
		!briefMarkdown &&
		!voiceSummary &&
		!tokensJson &&
		!tokensCss &&
		!companyProfileJson &&
		!productSpecsJson &&
		!productCatalogJson &&
		!hasLogoSvg
	) {
		return null;
	}
	return {
		briefMarkdown,
		voiceSummary,
		tokensJson,
		tokensCss,
		companyProfileJson,
		productSpecsJson,
		productCatalogJson,
		logoSvg,
		hasLogoSvg,
	};
}

function extractPointToChangeTarget(originRef: unknown): PointToChangeTarget | null {
	if (!originRef || typeof originRef !== "object" || Array.isArray(originRef)) return null;
	const rec = originRef as Record<string, unknown>;
	const candidates: unknown[] = [originRef];
	if (rec.target !== undefined) candidates.push(rec.target);
	if (rec.pointToChangeTarget !== undefined) candidates.push(rec.pointToChangeTarget);
	for (const candidate of candidates) {
		try {
			return parsePointToChangeTarget(candidate);
		} catch {}
	}
	return null;
}

function buildFolderSurfaceInstructions(input: SurfaceSessionTurnInput, folderRoot: string, notesRoot: string): string {
	return (
		`This session is scoped to the Studio/Identity Surface "${input.surfaceTitle}" (${input.surfaceSlug}), which projects ${folderRoot}/ directly from Company Files. ` +
		"Founders preview multiple unmerged staged patches toggled on or off simultaneously before approving any change. " +
		`Use stage_surface_patch to stage cohesive folder_patch operations (write_text, merge_json, delete) relative to ${folderRoot}/, keeping each change atomic and conflict-minimizing. ` +
		"Studio renders structured JSON (tokens, specs, *.report.json), Markdown prose (voice.md, brief.md), and SVG marks natively — do not create standalone HTML/CSS code pages inside Studio folders. " +
		`Any file writes are strictly confined to ${folderRoot}/ and ${notesRoot}/; attach concise supporting analyses as notePaths under ${notesRoot}/ rather than creating loose markdown files elsewhere.`
	);
}

function buildOpsSurfaceInstructions(input: SurfaceSessionTurnInput): string {
	return (
		`This session is scoped to the operational Surface "${input.surfaceTitle}" (${input.surfaceSlug}). ` +
		"Inspect Company Files read-only when helpful, and use stage_surface_ops_action to stage a clear, structured action (draft email, payment preparation, record update, or file organization) that founders can review and approve directly from the Action card."
	);
}

function formatSessionFailure(error: unknown): { readonly errorMessage: string; readonly replyText: string } {
	const raw = error instanceof Error ? error.message.trim() : String(error ?? "Unknown error").trim();
	const errorMessage = (raw || "Surface session turn failed").replace(/\s+/g, " ").slice(0, MAX_FAILURE_REPLY_CHARS);
	const replyText = `The surface session could not complete: ${errorMessage}`.slice(0, MAX_FAILURE_REPLY_CHARS);
	return { errorMessage, replyText };
}

export function createControlPlaneSessionCompletionPort(
	control: SurfaceToolsRpcClient,
	profileId?: string,
): SurfaceSessionCompletionPort;
export function createControlPlaneSessionCompletionPort(
	control: CloudCompanyPathControl,
	profileId?: string,
): SurfaceSessionCompletionPort;
export function createControlPlaneSessionCompletionPort(
	control: SurfaceToolsRpcClient | CloudCompanyPathControl,
	profileId?: string,
): SurfaceSessionCompletionPort {
	const rpc = (method: "qorpera_native_surface_complete_turn", args: Record<string, unknown>, signal: AbortSignal) =>
		(control as SurfaceToolsRpcClient).call(method, args, signal);
	return {
		async completeSessionTurn(completion, signal) {
			const resolvedProfileId = completion.companyId ?? profileId;
			if (!resolvedProfileId) {
				throw new Error("Surface session completion requires companyId or profileId");
			}
			await rpc(
				"qorpera_native_surface_complete_turn",
				{
					p_profile_id: resolvedProfileId,
					p_session_id: completion.sessionId,
					p_state: completion.state,
					p_reply_text: completion.replyText,
					p_question: completion.question,
					p_note_paths: completion.notePaths ? [...completion.notePaths] : null,
					p_branch_head_sha: completion.branchHeadSha,
					...(completion.leaseToken !== undefined ? { p_lease_token: completion.leaseToken } : {}),
				},
				signal,
			);
		},
	};
}

export function createControlPlaneSessionLeaseRenewalPort(
	control: SurfaceToolsRpcClient,
	profileId?: string,
): SurfaceSessionLeaseRenewalPort;
export function createControlPlaneSessionLeaseRenewalPort(
	control: CloudCompanyPathControl,
	profileId?: string,
): SurfaceSessionLeaseRenewalPort;
export function createControlPlaneSessionLeaseRenewalPort(
	control: SurfaceToolsRpcClient | CloudCompanyPathControl,
	profileId?: string,
): SurfaceSessionLeaseRenewalPort {
	const rpc = (method: "qorpera_native_surface_renew_lease", args: Record<string, unknown>, signal: AbortSignal) =>
		(control as SurfaceToolsRpcClient).call(method, args, signal);
	return {
		async renewSessionLease(input, signal) {
			const resolvedProfileId = input.companyId ?? profileId;
			if (!resolvedProfileId) {
				throw new Error("Surface session lease renewal requires companyId or profileId");
			}
			const result = await rpc(
				"qorpera_native_surface_renew_lease",
				{
					p_profile_id: resolvedProfileId,
					p_session_id: input.sessionId,
					p_lease_token: input.leaseToken,
					p_extend_seconds: input.extendSeconds,
				},
				signal,
			);
			const renewed =
				typeof result === "boolean"
					? result
					: Boolean(result && typeof result === "object" && (result as { renewed?: unknown }).renewed === true);
			return { renewed };
		},
	};
}

const DEFAULT_SESSION_LEASE_RENEW_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_LEASE_EXTEND_SECONDS = 300;
const DEFAULT_COMPLETION_RETRY_DELAYS_MS = [250, 750] as const;

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isAlreadyCompletedSessionError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const text = error instanceof Error ? error.message : String(error);
	if (/session is not running/i.test(text)) return true;
	const code = (error as { code?: unknown }).code;
	return code === "55000" && /not running/i.test(text);
}

export async function runSurfaceSessionTurn(
	input: SurfaceSessionTurnInput,
	ports: SurfaceSessionRunnerPorts,
): Promise<SurfaceSessionTurnRunResult> {
	const callerSignal = ports.signal ?? new AbortController().signal;
	const turnAbort = new AbortController();
	const signal = turnAbort.signal;
	const folderReader = ports.folder ?? ports.folderToolsContext?.folder;
	let identityContext: SurfaceIdentityContext | null = null;
	let sharedAssets: SurfaceSharedAssetsContext | null = null;

	let initialRenewTimer: ReturnType<typeof setTimeout> | undefined;
	let leaseTimer: ReturnType<typeof setInterval> | undefined;
	let leaseLost = false;
	let outcomeReady = false;
	const leaseAbort = new AbortController();
	const stopLeaseRenewal = (): void => {
		if (initialRenewTimer !== undefined) {
			clearTimeout(initialRenewTimer);
			initialRenewTimer = undefined;
		}
		if (leaseTimer !== undefined) {
			clearInterval(leaseTimer);
			leaseTimer = undefined;
		}
		if (!leaseAbort.signal.aborted) {
			leaseAbort.abort();
		}
	};
	const onCallerAbort = (): void => {
		turnAbort.abort(callerSignal.reason);
		stopLeaseRenewal();
	};
	if (callerSignal.aborted) {
		onCallerAbort();
	} else {
		callerSignal.addEventListener("abort", onCallerAbort, { once: true });
	}
	if (input.leaseToken && ports.renewSessionLease) {
		const renewSessionLease = ports.renewSessionLease;
		const leaseToken = input.leaseToken;
		const intervalMs = Math.max(
			10,
			Math.floor(ports.leaseRenewIntervalMs ?? DEFAULT_SESSION_LEASE_RENEW_INTERVAL_MS),
		);
		const extendSeconds = Math.max(
			30,
			Math.min(900, Math.floor(ports.leaseExtendSeconds ?? DEFAULT_SESSION_LEASE_EXTEND_SECONDS)),
		);
		let inFlight = false;
		const renewOnce = (): void => {
			if (inFlight || leaseAbort.signal.aborted) return;
			inFlight = true;
			void withAbortScopes(
				[leaseAbort.signal],
				(renewSignal) =>
					renewSessionLease(
						{
							sessionId: input.sessionId,
							companyId: input.companyId,
							leaseToken,
							extendSeconds,
						},
						renewSignal,
					),
				15_000,
			)
				.then((result) => {
					if (result && result.renewed === false && !leaseAbort.signal.aborted) {
						leaseLost = true;
						stopLeaseRenewal();
						turnAbort.abort(new Error("Surface session lease lost during execution"));
					}
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		};
		// WHY: Fire an initial renewal on the next tick so wakes queued near the 10-minute lease bound extend immediately without racing synchronous abort-listener registration.
		initialRenewTimer = setTimeout(renewOnce, 0);
		initialRenewTimer.unref?.();
		leaseTimer = setInterval(renewOnce, intervalMs);
		leaseTimer.unref?.();
	}

	try {
		const explicitBrief = input.briefMarkdown?.trim() || null;
		const [loaded, folderBrief] = folderReader
			? await Promise.all([
					loadSurfaceSharedAssets(folderReader, signal),
					explicitBrief === null
						? readOptionalFolderText(
								folderReader,
								`QorperaOS/surfaces/${input.surfaceSlug}/brief.md`,
								MAX_SURFACE_BRIEF_BYTES,
								signal,
							)
						: Promise.resolve(null),
				])
			: [null, null];
		if (loaded) {
			if (input.surfaceSlug !== "identity" && (loaded.briefMarkdown || loaded.voiceSummary || loaded.tokensJson)) {
				identityContext = {
					briefMarkdown: loaded.briefMarkdown,
					voiceSummary: loaded.voiceSummary,
					tokensJson: loaded.tokensJson,
				};
			}
			if (
				loaded.tokensCss ||
				loaded.companyProfileJson ||
				loaded.productSpecsJson ||
				loaded.productCatalogJson ||
				loaded.hasLogoSvg
			) {
				sharedAssets = {
					tokensCss: loaded.tokensCss,
					companyProfileJson: loaded.companyProfileJson,
					productSpecsJson: loaded.productSpecsJson,
					productCatalogJson: loaded.productCatalogJson,
					hasLogoSvg: loaded.hasLogoSvg,
				};
			}
		}
		const briefMarkdown = explicitBrief ?? folderBrief ?? input.briefSummary?.trim() ?? null;
		const pointToChangeTarget = extractPointToChangeTarget(input.originRef);
		const normalizedFolderRoot =
			input.sourceKind === "folder"
				? normalizeFolderRoot(
						input.folderRoot ?? (input.surfaceSlug === "identity" ? "identity" : input.surfaceSlug),
					)
				: input.folderRoot
					? normalizeFolderRoot(input.folderRoot)
					: null;

		const turnBrief = buildSurfaceTurnBrief({
			sessionId: input.sessionId,
			surfaceSlug: input.surfaceSlug,
			surfaceTitle: input.surfaceTitle,
			briefMarkdown,
			repositoryKey: input.repositoryKey ?? null,
			folderRoot: normalizedFolderRoot,
			explorationVariantLabel: input.explorationVariantLabel ?? null,
			identityContext,
			sharedAssets,
			pointToChangeTarget,
			conflictPaths: input.conflictPaths ?? null,
		});

		let outcome: SurfaceSessionTurnExecutionOutcome;
		if (input.sourceKind === "folder") {
			const stageSurfacePatch = ports.surfaceTools.stageSurfacePatch;
			if (!stageSurfacePatch) {
				throw new Error("Surface folder session requires stageSurfacePatch tool port");
			}
			if (!ports.executeTurn) {
				throw new Error("Surface folder session requires executeTurn port");
			}
			const folderRoot = normalizedFolderRoot || input.surfaceSlug;
			const notesRoot = `QorperaOS/surfaces/${input.surfaceSlug}/notes`;
			const allowedRoots = [...new Set([folderRoot, notesRoot])];
			const folderTools = ports.folderToolsContext
				? cloudFolderFileTools({
						folder: ports.folderToolsContext.folder,
						operations: ports.folderToolsContext.operations,
						identity: ports.folderToolsContext.identity,
						surfaceFilePolicy: { mode: "surface_worker", allowedRoots },
					})
				: [];
			const tools: CloudNativeTool[] = [
				createStageSurfacePatchTool(input.sessionId, {
					stageSurfacePatch: stageSurfacePatch.bind(ports.surfaceTools),
				}),
				...folderTools,
				...(ports.extraTools ?? []),
			];
			outcome = await ports.executeTurn({
				input,
				mode: "folder",
				instructions: buildFolderSurfaceInstructions(input, folderRoot, notesRoot),
				turnBrief,
				tools,
				identityContext,
				sharedAssets,
				allowedRoots,
				signal,
			});
		} else if (input.sourceKind === "native_ops") {
			const stageSurfaceOpsAction = ports.surfaceTools.stageSurfaceOpsAction;
			if (!stageSurfaceOpsAction) {
				throw new Error("Surface native_ops session requires stageSurfaceOpsAction tool port");
			}
			if (!ports.executeTurn) {
				throw new Error("Surface native_ops session requires executeTurn port");
			}
			const readOnlyFolderTools = ports.folderToolsContext
				? cloudFolderFileTools({
						folder: ports.folderToolsContext.folder,
						operations: ports.folderToolsContext.operations,
						identity: ports.folderToolsContext.identity,
					}).filter((tool) => READ_ONLY_FOLDER_TOOLS.has(tool.name))
				: [];
			const tools: CloudNativeTool[] = [
				createStageSurfaceOpsActionTool(input.sessionId, {
					stageSurfaceOpsAction: stageSurfaceOpsAction.bind(ports.surfaceTools),
				}),
				...readOnlyFolderTools,
				...(ports.extraTools ?? []),
			];
			outcome = await ports.executeTurn({
				input,
				mode: "native_ops",
				instructions: buildOpsSurfaceInstructions(input),
				turnBrief,
				tools,
				identityContext,
				sharedAssets,
				allowedRoots: [],
				signal,
			});
		} else {
			const recordChange = ports.surfaceTools.recordChange;
			if (!recordChange) {
				throw new Error("Surface code_repo session requires recordChange tool port");
			}
			const binding: SurfaceCodingTurnBinding = {
				sessionId: input.sessionId,
				surfaceSlug: input.surfaceSlug,
				surfaceTitle: input.surfaceTitle,
				briefMarkdown,
				repositoryKey: input.repositoryKey ?? null,
				folderRoot: normalizedFolderRoot,
				explorationVariantLabel: input.explorationVariantLabel ?? null,
				identityContext,
				sharedAssets,
				pointToChangeTarget,
				conflictPaths: input.conflictPaths ?? null,
				recordChange: recordChange.bind(ports.surfaceTools),
			};
			const codeRequest: SurfaceCodeRepoTurnRequest = {
				input,
				binding,
				instructions: SURFACE_STAGED_CODING_INSTRUCTIONS,
				turnBrief,
				signal,
			};
			if (ports.executeCodeRepoTurn) {
				outcome = await ports.executeCodeRepoTurn(codeRequest);
			} else if (ports.codingDriver) {
				const prepared = await ports.codingDriver.prepareRequest(codeRequest);
				const driverResult = await ports.codingDriver.driver.execute(
					prepared.request,
					prepared.identityRoot,
					signal,
					{
						...prepared.context,
						surfaceSession: binding,
					},
				);
				outcome = prepared.extractOutcome ? prepared.extractOutcome(driverResult) : { state: "ready" };
			} else {
				throw new Error("Surface code_repo session requires executeCodeRepoTurn or codingDriver");
			}
		}

		if (leaseLost) {
			throw new Error("Surface session lease lost during execution");
		}
		// WHY: Stop lease renewal before completing the turn so Postgres clearing lease_token never causes a concurrent renewal to abort the in-flight completion response.
		stopLeaseRenewal();
		outcomeReady = true;
		const state = outcome.state ?? (outcome.question ? "needs_input" : "ready");
		const replyText = outcome.replyText?.trim() || null;
		const question = outcome.question ?? null;
		const notePaths = outcome.notePaths ? [...outcome.notePaths] : null;
		const branchHeadSha = outcome.branchHeadSha ?? null;
		const completionPayload: SurfaceSessionTurnCompletion = {
			sessionId: input.sessionId,
			companyId: input.companyId,
			state,
			replyText,
			question,
			notePaths,
			branchHeadSha,
			...(input.leaseToken !== undefined ? { leaseToken: input.leaseToken } : {}),
		};
		const retryDelays = ports.completionRetryDelaysMs ?? DEFAULT_COMPLETION_RETRY_DELAYS_MS;
		let lastCompletionError: unknown;
		for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
			try {
				await withAbortScopes(
					[],
					(completeSignal) => ports.completeSessionTurn(completionPayload, completeSignal),
					15_000,
				);
				lastCompletionError = undefined;
				break;
			} catch (error) {
				if (attempt > 0 && isAlreadyCompletedSessionError(error)) {
					lastCompletionError = undefined;
					break;
				}
				lastCompletionError = error;
				const delayMs = retryDelays[attempt];
				if (delayMs === undefined || callerSignal.aborted) break;
				await delayWithAbort(delayMs, callerSignal);
			}
		}
		if (lastCompletionError !== undefined) {
			throw lastCompletionError;
		}
		return {
			sessionId: input.sessionId,
			sourceKind: input.sourceKind,
			state,
			identityLoaded: identityContext !== null,
			sharedAssetsLoaded: sharedAssets !== null,
			replyText,
			question,
			notePaths,
			branchHeadSha,
			error: null,
		};
	} catch (error) {
		stopLeaseRenewal();
		const { errorMessage, replyText } = formatSessionFailure(error);
		if (!outcomeReady && !leaseLost && !callerSignal.aborted) {
			try {
				await withAbortScopes(
					[callerSignal],
					(failSignal) =>
						ports.completeSessionTurn(
							{
								sessionId: input.sessionId,
								companyId: input.companyId,
								state: "failed",
								replyText,
								question: null,
								notePaths: null,
								branchHeadSha: null,
								...(input.leaseToken !== undefined ? { leaseToken: input.leaseToken } : {}),
							},
							failSignal,
						),
					10_000,
				);
			} catch {}
		}
		return {
			sessionId: input.sessionId,
			sourceKind: input.sourceKind,
			state: "failed",
			identityLoaded: identityContext !== null,
			sharedAssetsLoaded: sharedAssets !== null,
			replyText,
			question: null,
			notePaths: null,
			branchHeadSha: null,
			error: errorMessage,
			cause: error,
		};
	} finally {
		stopLeaseRenewal();
		callerSignal.removeEventListener("abort", onCallerAbort);
	}
}

function inferDeliverySourceKind(job: SurfaceSessionDeliveryJob): SurfaceSourceKind {
	if (job.surfaceSourceKind) return job.surfaceSourceKind;
	if (job.repositoryKey) return "code_repo";
	if (job.surfaceArchetype === "ops") return "native_ops";
	return "folder";
}

function deliveryJobToTurnInput(job: SurfaceSessionDeliveryJob): SurfaceSessionTurnInput {
	const surfaceSlug = job.surfaceSlug?.trim() || "surface";
	const surfaceTitle = job.surfaceTitle?.trim() || surfaceSlug;
	return {
		sessionId: job.sessionId,
		surfaceId: job.surfaceId,
		companyId: job.profileId,
		surfaceSlug,
		surfaceTitle,
		sourceKind: inferDeliverySourceKind(job),
		prompt: job.prompt,
		state: job.state,
		repositoryKey: job.repositoryKey ?? null,
		folderRoot: job.folderRoot ?? null,
		briefSummary: job.briefSummary ?? null,
		explorationVariantLabel: job.explorationVariantLabel ?? null,
		originKind: job.originKind,
		originRef: job.originRef,
		...(job.leaseToken !== undefined ? { leaseToken: job.leaseToken } : {}),
	};
}

export function createSurfaceSessionProviderHook(ports: SurfaceSessionProviderHookPorts): SurfaceSessionProviderHook {
	const reportError = async (failure: SurfaceSessionProviderHookFailure): Promise<void> => {
		if (!ports.onError) return;
		try {
			await ports.onError(failure);
		} catch {}
	};

	const runDeliveredSession = async (
		job: SurfaceSessionDeliveryJob,
		machineId: string,
		signal?: AbortSignal,
	): Promise<SurfaceSessionTurnRunResult> => {
		const turnInput = deliveryJobToTurnInput(job);
		const runSignal = signal ?? new AbortController().signal;
		try {
			const runnerPorts = await ports.resolveRunnerPorts(job, machineId, runSignal);
			if (job.leaseToken && !runnerPorts.renewSessionLease) {
				throw new Error("Surface session provider must wire renewSessionLease for leased turns");
			}
			const result = await runSurfaceSessionTurn(turnInput, {
				...runnerPorts,
				signal: runnerPorts.signal ?? runSignal,
			});
			if (result.state === "failed") {
				await reportError({
					sessionId: job.sessionId,
					surfaceId: job.surfaceId,
					companyId: job.profileId,
					machineId,
					error: result.error ?? result.replyText ?? "Surface session failed",
				});
			}
			if (ports.onResult) {
				try {
					await ports.onResult(result, job, machineId);
				} catch (callbackError) {
					const { errorMessage } = formatSessionFailure(callbackError);
					await reportError({
						sessionId: job.sessionId,
						surfaceId: job.surfaceId,
						companyId: job.profileId,
						machineId,
						error: errorMessage,
					});
				}
			}
			return result;
		} catch (error) {
			const { errorMessage, replyText } = formatSessionFailure(error);
			await reportError({
				sessionId: job.sessionId,
				surfaceId: job.surfaceId,
				companyId: job.profileId,
				machineId,
				error: errorMessage,
			});
			return {
				sessionId: job.sessionId,
				sourceKind: turnInput.sourceKind,
				state: "failed",
				identityLoaded: false,
				sharedAssetsLoaded: false,
				replyText,
				question: null,
				notePaths: null,
				branchHeadSha: null,
				error: errorMessage,
			};
		}
	};

	return {
		runDeliveredSession,
		async deliverSurfaceSession(job, machineId, signal) {
			await runDeliveredSession(job, machineId, signal);
		},
	};
}
