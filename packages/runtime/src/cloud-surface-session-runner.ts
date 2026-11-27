import {
	readSurfaceFolderFiles,
	type SurfaceFolderContents,
	type SurfaceFolderReader,
	surfaceFolderRoots,
} from "@qorpera/cloud-client/surface-folder-files";
import type { StudioPreviewReconciliation } from "@qorpera/cloud-client/surface-studio-patches";
import {
	compileIdentityTokens,
	describeSurfaceBlocks,
	describeSurfaceFormats,
	IDENTITY_BRIEF_PATH,
	IDENTITY_COMPANY_PATH,
	IDENTITY_LOGO_PATH,
	IDENTITY_SHARED_ASSET_PATHS,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	IDENTITY_VOICE_PATH,
	type PointToChangeTarget,
	parsePointToChangeTarget,
	parseStudioPatchOps,
	readSurfaceLayout,
	STUDIO_TOUR_FORMAT,
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_ARCHETYPES,
	SURFACE_FACT_FIGURE_CHARS,
	SURFACE_KINDS,
	SURFACE_LAYOUT_PATH,
	SURFACE_REPORT_FORMAT,
	type SurfaceArchetype,
	type SurfaceKind,
	type SurfaceLayoutRead,
	type SurfaceSessionQuestion,
	type SurfaceSourceKind,
	type SurfaceStarterKind,
	sharedProductAssetCandidates,
	starterSurfaceLayout,
	surfaceFilesHaveModel,
	surfaceStudioPageWhenKnown,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import type { CloudCompanyFolderClient, CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import type { GeminiTtsModel, GeminiTtsSpeechResult, GeminiTtsVoice } from "./cloud-gemini-tts.ts";
import type { CloudNativeCodingDriver, CloudNativeCodingTurnContext } from "./cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "./cloud-native-provider-host.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudPictureChannel } from "./cloud-picture-channel.ts";
import { SURFACE_STARTER_SKILLS } from "./cloud-platform-skills.ts";
import { type CloudStudioSkill, type CloudStudioSkillReader, cloudStudioSkill } from "./cloud-skill-tools.ts";
import type { StudioChatGptVoiceBatchResult } from "./cloud-studio-voice-recorder.ts";
import { createNarrateExplainerTool } from "./cloud-surface-narrate-tool.ts";
import { createStudioPictureTool } from "./cloud-surface-picture-tool.ts";
import {
	chainFolderPreviewOverlays,
	createSurfaceFolderPreviewOverlay,
	createSurfaceSessionOwnOverlay,
	parseSurfaceOmittedBaseChanges,
	type SurfaceOmittedBaseChange,
	type SurfacePreviewBaseChange,
	type SurfaceSessionOpenChange,
} from "./cloud-surface-preview-overlay.ts";
import {
	type CloudSurfaceToolsPort,
	createStageSurfaceOpsActionTool,
	createStageSurfacePatchTool,
	createSurfacePatchSessionTracker,
	type SurfaceLayoutStaging,
	type SurfaceOpsActionToolPort,
	type SurfacePatchToolPort,
	type SurfaceToolsRpcClient,
} from "./cloud-surface-tools.ts";
import {
	buildSurfaceTurnBrief,
	type CompanyInterfacesContext,
	SURFACE_STAGED_CODING_INSTRUCTIONS,
	type SurfaceCodingTurnBinding,
	type SurfaceConflictDetail,
	type SurfaceIdentityContext,
	type SurfaceSharedAssetsContext,
	type SurfaceTurnOpenChange,
	type SurfaceTurnResolvedChange,
} from "./cloud-surface-turn-context.ts";
import type { CloudVoiceName } from "./cloud-voice-channel.ts";

const MAX_IDENTITY_BRIEF_BYTES = 16_384;
const MAX_IDENTITY_VOICE_BYTES = 8_192;
const MAX_IDENTITY_TOKENS_BYTES = 16_384;
const MAX_SHARED_ASSET_BYTES = 32_768;
const MAX_SURFACE_BRIEF_BYTES = 32_768;
const MAX_PATCH_BASE_FILE_BYTES = 128 * 1024;
const MAX_PATCH_BASE_FILES_TOTAL_CHARS = 512_000;
const MAX_STUDIO_TEXT_READ_BYTES = 262_144;
const MAX_STAGED_LAYOUT_READ_BYTES = 1024 * 1024;
const MAX_FAILURE_REPLY_CHARS = 500;
const READ_ONLY_FOLDER_TOOLS = new Set(["company_read", "company_list"]);

const IDENTITY_ASSET_BYTE_LIMITS: Readonly<Record<(typeof IDENTITY_SHARED_ASSET_PATHS)[number], number>> = {
	[IDENTITY_BRIEF_PATH]: MAX_IDENTITY_BRIEF_BYTES,
	[IDENTITY_VOICE_PATH]: MAX_IDENTITY_VOICE_BYTES,
	[IDENTITY_TOKENS_JSON_PATH]: MAX_IDENTITY_TOKENS_BYTES,
	[IDENTITY_TOKENS_CSS_PATH]: MAX_IDENTITY_TOKENS_BYTES,
	[IDENTITY_LOGO_PATH]: MAX_SHARED_ASSET_BYTES,
	[IDENTITY_COMPANY_PATH]: MAX_SHARED_ASSET_BYTES,
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
	readonly surfaceKind?: string;
	readonly surfaceIcon?: string | null;
	readonly surfaceIsGlobal?: boolean | null;
	readonly surfaceArchetype?: SurfaceArchetype | null;
	readonly openLayoutOps?: readonly StudioPatchOp[] | null;
	readonly sourceKind: SurfaceSourceKind;
	readonly prompt: string;
	readonly state?: "queued" | "reconciling";
	readonly isInternal?: boolean;
	readonly repositoryKey?: string | null;
	readonly folderRoot?: string | null;
	readonly productFolderRoots?: readonly string[];
	readonly briefSummary?: string | null;
	readonly briefMarkdown?: string | null;
	readonly explorationVariantLabel?: string | null;
	readonly originKind?: string;
	readonly memberInitiated?: boolean;
	readonly originRef?: unknown;
	readonly conflictPaths?: readonly string[] | null;
	readonly conflictDetails?: readonly SurfaceConflictDetail[] | null;
	readonly previewBaseChanges?: readonly SurfacePreviewBaseChange[] | null;
	readonly previewReconciliations?: readonly StudioPreviewReconciliation[] | null;
	readonly sessionOpenChanges?: readonly SurfaceSessionOpenChange[] | null;
	readonly replyChangeId?: string | null;
	readonly chainMode?: boolean;
	readonly omittedBaseChanges?: readonly SurfaceOmittedBaseChange[] | null;
	readonly mainSha?: string | null;
	readonly branchHeadSha?: string | null;
	readonly openChanges?: readonly SurfaceTurnOpenChange[] | null;
	readonly resolvedChanges?: readonly SurfaceTurnResolvedChange[] | null;
	readonly leaseToken?: string | null;
	readonly voiceModel?: string | null;
	readonly voiceName?: string | null;
	readonly imageModel?: string | null;
	readonly openScenesOps?: readonly StudioPatchOp[];
	readonly companyInterfaces?: CompanyInterfacesContext | null;
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
	readonly writableRoots: readonly string[];
	readonly stagedRoots: readonly string[];
	readonly savesQuestions?: boolean;
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

export interface SurfaceSessionNarratePort {
	readonly stageBytes: (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<StudioBinaryRef>;
	readonly synthesizeGemini?: (input: {
		readonly model: GeminiTtsModel;
		readonly voiceName: GeminiTtsVoice;
		readonly text: string;
		readonly signal: AbortSignal;
	}) => Promise<GeminiTtsSpeechResult>;
	readonly synthesizeChatGptVoice?: (input: {
		readonly voiceName?: CloudVoiceName;
		readonly captions: readonly { readonly hash: string; readonly text: string }[];
		readonly signal: AbortSignal;
	}) => Promise<StudioChatGptVoiceBatchResult>;
}

export interface SurfaceSessionPicturePort {
	readonly stageBytes: (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<StudioBinaryRef>;
	readonly pictures: CloudPictureChannel;
}

export interface SurfaceSessionRunnerPorts {
	readonly folder?: SurfaceFolderTextReader;
	readonly readStudioFiles?: (roots: readonly string[], signal: AbortSignal) => Promise<SurfaceFolderContents>;
	readonly folderToolsContext?: SurfaceSessionFolderToolsContext;
	readonly surfaceTools: Partial<
		Pick<CloudSurfaceToolsPort, "recordChange"> & SurfacePatchToolPort & SurfaceOpsActionToolPort
	>;
	readonly narrateExplainer?: SurfaceSessionNarratePort;
	readonly makePicture?: SurfaceSessionPicturePort;
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
	readonly isInternal?: boolean;
	readonly prompt: string;
	readonly originKind?: string;
	readonly originRef?: unknown;
	readonly repositoryKey?: string | null;
	readonly folderRoot?: string | null;
	readonly productFolderRoots?: readonly string[];
	readonly surfaceSlug?: string;
	readonly surfaceTitle?: string;
	readonly surfaceArchetype?: string;
	readonly surfaceSourceKind?: SurfaceSourceKind;
	readonly surfaceKind?: string;
	readonly surfaceIcon?: string | null;
	readonly surfaceIsGlobal?: boolean | null;
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

type ExactFolderTextRead =
	| { readonly status: "ok"; readonly content: string | null }
	| { readonly status: "unreadable" };

async function readExactOptionalFolderText(
	folder: SurfaceFolderTextReader,
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<ExactFolderTextRead> {
	try {
		const result = await folder.readText(path, maxBytes, signal);
		if (result === null || result === undefined) return { status: "ok", content: null };
		return { status: "ok", content: typeof result === "string" ? result : result.text };
	} catch (error) {
		if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		return { status: "unreadable" };
	}
}

function resolveFolderPatchReadPath(folderRoot: string, opPath: string): string {
	const cleaned = opPath.trim().replace(/^\/+|\/+$/g, "");
	if (!folderRoot || cleaned === folderRoot || cleaned.startsWith(`${folderRoot}/`)) {
		return cleaned;
	}
	return `${folderRoot}/${cleaned}`;
}

export async function collectFolderPatchBaseFiles(
	folder: SurfaceFolderTextReader,
	folderRoot: string,
	ops: readonly StudioPatchOp[],
	signal: AbortSignal,
): Promise<Readonly<Record<string, string | null>> | undefined> {
	const paths = [...new Set(ops.filter((op) => op.op === "write_text" || op.op === "delete").map((op) => op.path))];
	if (paths.length === 0) return undefined;
	const entries = await Promise.all(
		paths.map(async (rawPath) => {
			const fullPath = resolveFolderPatchReadPath(folderRoot, rawPath);
			const read = await readExactOptionalFolderText(folder, fullPath, MAX_PATCH_BASE_FILE_BYTES, signal);
			return [rawPath, read] as const;
		}),
	);
	const out: Record<string, string | null> = {};
	let totalChars = 0;
	for (const [rawPath, read] of entries) {
		if (read.status !== "ok") continue;
		if (read.content !== null) {
			if (totalChars + read.content.length > MAX_PATCH_BASE_FILES_TOTAL_CHARS) continue;
			totalChars += read.content.length;
		}
		out[rawPath] = read.content;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export async function folderText(
	folder: SurfaceFolderTextReader,
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<string | null> {
	const found = await folder.readText(path, maxBytes, signal);
	return found === null || found === undefined ? null : typeof found === "string" ? found : found.text;
}

export async function readRawOptionalFolderText(
	folder: SurfaceFolderTextReader,
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<string | null> {
	try {
		return await folderText(folder, path, maxBytes, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	}
}

export function normalizeStudioRelativePath(raw: string, folderRoot: string): string | null {
	let trimmed = raw.trim().replace(/^\/+/, "");
	const prefix = `${folderRoot.replace(/^\/+|\/+$/g, "")}/`;
	if (prefix.length > 1 && trimmed.startsWith(prefix)) {
		trimmed = trimmed.slice(prefix.length);
	}
	if (!trimmed || trimmed.includes("\\") || trimmed.includes("\0")) return null;
	const parts = trimmed.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return null;
	return trimmed;
}

export function applyStudioTextOps(
	overlay: Map<string, string | null>,
	ops: readonly StudioPatchOp[],
	folderRoot: string,
): void {
	for (const op of ops) {
		const rel = normalizeStudioRelativePath(op.path, folderRoot);
		if (!rel) continue;
		if (op.op === "write_text") {
			overlay.set(rel, op.content);
		} else if (op.op === "delete") {
			overlay.set(rel, null);
		}
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
	productFolderRoots?: readonly string[] | null,
): Promise<SurfaceSharedAssetsSnapshot | null> {
	const { specsPaths, catalogPaths } = sharedProductAssetCandidates(productFolderRoots);
	const [identityEntries, specsEntries, catalogEntries] = await Promise.all([
		Promise.all(
			IDENTITY_SHARED_ASSET_PATHS.map(
				async (path) =>
					[path, await readOptionalFolderText(folder, path, IDENTITY_ASSET_BYTE_LIMITS[path], signal)] as const,
			),
		),
		Promise.all(
			specsPaths.map(
				async (path) => [path, await readOptionalFolderText(folder, path, MAX_SHARED_ASSET_BYTES, signal)] as const,
			),
		),
		Promise.all(
			catalogPaths.map(
				async (path) => [path, await readOptionalFolderText(folder, path, MAX_SHARED_ASSET_BYTES, signal)] as const,
			),
		),
	]);
	const byPath = new Map<string, string | null>(identityEntries);
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
	const productSpecsJson = specsEntries.find(([, text]) => text !== null)?.[1] ?? null;
	const productCatalogJson = catalogEntries.find(([, text]) => text !== null)?.[1] ?? null;
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

export function extractPointToChangeTarget(originRef: unknown): PointToChangeTarget | null {
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

const STUDIO_PAGE_RULES = [
	"Put values in the files the layout binds; the page draws them from there.",
	`Change the page's shape by staging ${SURFACE_LAYOUT_PATH} with stage_surface_patch like any other file: it shows in Changes and is approved like content. A layout that does not parse is refused when it is staged (checked on top of this session's own waiting changes, not other sessions'); deleting ${SURFACE_LAYOUT_PATH} brings back the starter.`,
	`Figures filled from an object show only values of at most ${SURFACE_FACT_FIGURE_CHARS} characters.`,
	"A module is a folder (modules/<name>/) with index.html and its own css and js linked relatively: no network, nothing from outside its folder except tokens.css / qorpera-identity.css, and an auto module must not size itself by the viewport (100vh).",
	"An artifacts block shows only what no other block draws; add one to any tab in layout.json when that tab should show vector art, pictures, notes, pages or extra files.",
	"A company file is bound with a leading slash (/identity/tokens.json).",
];

const STUDIO_EXPLAINER_SCHEMA =
	'`breakdowns/<slug>/scenes.js` (plus optional `breakdowns/<slug>/explainer.json` with `{ "title": "..." }` for 3Blue1Brown-style animated explainer videos rendered natively in the Breakdowns tab, or on any tab via an `explainer` block in `layout.json`): ' +
	"When a founder asks for a video, walkthrough, or animated breakdown of UX, product mechanics, flows, or strategy, NEVER stage an animated SVG or dump a script into `voice.md` or `brief.md`. " +
	'Stage `breakdowns/<slug>/scenes.js` with `stage_surface_patch`, then call `narrate_explainer` with `scenesPath: "breakdowns/<slug>/scenes.js"` to record spoken clips in the member\'s configured Voice model and profile. Whenever you stage `tour.json` or `breakdowns/<slug>/scenes.js`, synthesize `voice/clips.json` via `narrate_explainer` in the same session, and never claim voice narration exists if `narrate_explainer` was not run or failed. ' +
	'The Studio player creates `V` (1600×900 dark stage) and calls `V.start()` automatically — `scenes.js` only adds chapters and scenes (`V.part("Chapter")`, `V.scene((s) => { ... })`), never `new Video(...)` or `V.start()`. ' +
	"Primitives: `s.box({x,y,w,h,label,sub,color,dash})`, `s.text({x,y,str,size,color,font})`, `s.number({x,y,from,size,fmt})`, `s.bar({x,y,w,h,dir,scale})`, `s.icon({name,x,y,label,color})` (`person`, `bot`, `house`, `bus`, `card`, `coin`, `server`, `db`, `cloud`, `lock`, `doc`, `clock`, `shield`, `globe`, `mail`, `bolt`), `s.arrow(from,to,{color,bend,label})`, `s.line({d,head:false})`. " +
	"Animations inside `s.say(caption, ...anims)`: `s.create(m)`, `s.write(t)`, `s.fadeIn(m)`, `s.fadeOut(m)`, `s.dim(m,0.3)`, `s.move(m,x,y)`, `s.scale(m,k)`, `s.indicate(m)`, `s.value(m,to)`, `s.flow(arrow,sec,{count})`, `s.camera(x,y,zoom)`, `s.all(fn,items,sec)`, `{w:true}` to overlap. " +
	'Colors come from `C` (`blue`, `teal`, `yellow`, `green`, `red`, `purple`, `grey`). Keep captions short (~15 words, written for the ear, 15–35 captions total; bilingual `{en:"...",da:"..."}` supported wherever text goes), first scene title frame with `show: true` leaving `y ~ 560` free for Play, 60-unit edge margin, and never put sentences inside boxes.';

export type SurfaceStudioPageView =
	| {
			readonly page: "layout";
			readonly layout: SurfaceLayoutRead;
			readonly own: boolean;
			readonly starter: SurfaceStarterKind;
			readonly problem: string | null;
	  }
	| { readonly page: "report" }
	| { readonly page: "none" }
	| { readonly page: "unknown" };

export function surfaceArchetypeOf(value: unknown): SurfaceArchetype | undefined {
	return (SURFACE_ARCHETYPES as readonly unknown[]).includes(value) ? (value as SurfaceArchetype) : undefined;
}

export function openSurfaceLayoutOps(value: unknown): readonly StudioPatchOp[] | undefined {
	if (!Array.isArray(value)) return undefined;
	try {
		return parseStudioPatchOps(value, "openLayoutOps");
	} catch {
		return undefined;
	}
}

function storedSurfaceKind(kind: string | undefined): SurfaceKind | undefined {
	return (SURFACE_KINDS as readonly string[]).includes(kind ?? "") ? (kind as SurfaceKind) : undefined;
}

export function surfaceStudioPageView(
	input: Pick<
		SurfaceSessionTurnInput,
		"surfaceSlug" | "surfaceKind" | "surfaceIcon" | "surfaceIsGlobal" | "surfaceArchetype"
	>,
	folderRoot: string,
	contents: SurfaceFolderContents | null,
): SurfaceStudioPageView {
	if (!contents) return { page: "unknown" };
	const text = contents.files[`${folderRoot}/${SURFACE_LAYOUT_PATH}`];
	const read = text === undefined ? undefined : readSurfaceLayout(text);
	const own = read && "layout" in read ? read.layout : undefined;
	const known = surfaceStudioPageWhenKnown({
		archetype: input.surfaceArchetype ?? "studio",
		kind: storedSurfaceKind(input.surfaceKind),
		slug: input.surfaceSlug,
		icon: input.surfaceIcon ?? null,
		isGlobal: input.surfaceIsGlobal ?? null,
		paths: Object.keys(contents.files),
		hasModel: surfaceFilesHaveModel(contents.files, Object.keys(contents.binaries)),
		hasOwnLayout: own !== undefined,
	});
	if (!known) return { page: "unknown" };
	if (known.page === null) return { page: "none" };
	if (known.page === "report") return { page: "report" };
	return {
		page: "layout",
		layout: own ?? starterSurfaceLayout(known.starter),
		own: own !== undefined,
		starter: known.starter,
		problem: read && "problem" in read ? read.problem : null,
	};
}

function describeStudioPage(
	view: SurfaceStudioPageView,
	folderRoot: string,
	voiceModel?: string | null,
	voiceName?: string | null,
): string {
	const layoutFile = `${folderRoot}/${SURFACE_LAYOUT_PATH}`;
	const rules = `How the page works:\n${STUDIO_PAGE_RULES.map((rule) => `- ${rule}`).join("\n")}`;
	const blocks = `## Blocks\n${describeSurfaceBlocks()}`;
	const voiceGuidance =
		voiceModel && voiceName
			? `The member's configured Voice preference is ${voiceModel} (${voiceName}); narrate_explainer uses it automatically.`
			: "";
	if (view.page === "none") return "This interface's page is not drawn from a layout.";
	if (view.page === "report") {
		return `## This page\nThis interface is a reading page, not drawn from a layout: it presents every *.report.json article and standalone .html document in ${folderRoot}/. Write each report, essay, or blog post as its own *.report.json article (or self-contained .html when bespoke layout is requested) in its own stage_surface_patch call rather than raw Markdown.\n\n## File formats\n${SURFACE_REPORT_FORMAT}`;
	}
	if (view.page === "unknown") {
		const explainerBlock = voiceGuidance ? `${STUDIO_EXPLAINER_SCHEMA} ${voiceGuidance}` : STUDIO_EXPLAINER_SCHEMA;
		return `${rules}\n\n${blocks}\n\n## This page\nIts layout is not known for this turn; read ${layoutFile} if it exists before you change the page's shape.\n\n## File formats\n${explainerBlock}\n${STUDIO_TOUR_FORMAT}`;
	}
	const source = view.own
		? `Drawn from ${layoutFile}:`
		: view.problem
			? `${layoutFile} does not read (${view.problem}), so the page shows the ${view.starter} starter:`
			: `No ${layoutFile} yet, so the page shows the ${view.starter} starter:`;
	const formats = [
		...describeSurfaceFormats(view.layout),
		voiceGuidance ? `${STUDIO_EXPLAINER_SCHEMA} ${voiceGuidance}` : STUDIO_EXPLAINER_SCHEMA,
		STUDIO_TOUR_FORMAT,
	];
	return (
		`${rules}\n\n${blocks}\n\n## This page\n${source}\n${JSON.stringify(view.layout)}` +
		(formats.length > 0 ? `\n\n## File formats\n${formats.join("\n")}` : "")
	);
}

function describeStudioSkill(view: SurfaceStudioPageView, skill: CloudStudioSkill | null): string {
	if (view.page === "unknown")
		return `\n\n## Skill\nWhich kind of page this is, is not known for this turn. Once you know, read its skill with read_skill before you shape or fill the page: ${SURFACE_STARTER_SKILLS.product} for a product, ${SURFACE_STARTER_SKILLS.identity} for the company's Identity, ${SURFACE_STARTER_SKILLS.strategy} for Strategy, ${SURFACE_STARTER_SKILLS.analytics} for Analytics, ${SURFACE_STARTER_SKILLS.custom} for any other page.`;
	if (!skill) return "";
	const source = skill.path
		? `The company's own ${skill.name} skill (${skill.path}), used in place of the platform's`
		: `The platform's ${skill.name} skill`;
	return `\n\n## Skill: ${skill.name}\n${source}: how this page is worked on and what good looks like. The rules above still hold.\n\n${skill.body}`;
}

export function buildFolderSurfaceInstructions(
	input: SurfaceSessionTurnInput,
	folderRoot: string,
	notesRoot: string,
	view: SurfaceStudioPageView,
	skill: CloudStudioSkill | null,
	options?: { readonly chainMode?: boolean; readonly hasOmittedBases?: boolean; readonly hasMakePicture?: boolean },
): string {
	if (input.isInternal && input.state === "reconciling") {
		if (options?.hasOmittedBases) {
			return (
				`This is an automatic silent reconciliation turn for the Studio/Identity Surface "${input.surfaceTitle}" (${input.surfaceSlug}), projecting ${folderRoot}/ from Company Files. ` +
				"A previous preview change that this change built on was removed or toggled off. " +
				"Your job is to adapt the staged change(s) listed in the Conflict Reconciliation section via stage_surface_patch so they work cleanly on the current published files without relying on the omitted preview changes. " +
				"Inspect current published files read-only via company_read as needed, call stage_surface_patch once with complete, untruncated ops covering every required path, and finish with surface_reply. Never ask the founder questions."
			);
		}
		if (options?.chainMode) {
			return (
				`This is an automatic silent reconciliation turn for the Studio/Identity Surface "${input.surfaceTitle}" (${input.surfaceSlug}), projecting ${folderRoot}/ from Company Files. ` +
				"Your job is to combine the overlapping staged changes listed in the Conflict Reconciliation section into one cohesive set of StudioPatchOp operations via stage_surface_patch covering every overlapping file listed, AND adapt any downstream dependent change files whose tokens, names, or copy must match newer modifications to their base changes. " +
				"Any non-conflicting files you do not emit are preserved automatically. " +
				"If two changes directly contradict on the exact same choice, value, or sentence, prefer the newer change (higher Change number). " +
				"Inspect current published files read-only via company_read as needed, call stage_surface_patch once with complete, untruncated ops, and finish with surface_reply. Never ask the founder questions."
			);
		}
		return (
			`This is an automatic silent reconciliation turn for the Studio/Identity Surface "${input.surfaceTitle}" (${input.surfaceSlug}), projecting ${folderRoot}/ from Company Files. ` +
			"Your job is to combine the overlapping staged changes listed in the Conflict Reconciliation section into a single clean set of StudioPatchOp operations via stage_surface_patch covering every overlapping file listed. " +
			"Non-conflicting files from the staged changes are preserved automatically; preserve every compatible edit, markdown section, SVG markup, and JSON token in the overlapping files. " +
			"If two changes directly contradict on the exact same choice, value, or sentence, prefer the newer change (higher Change number). " +
			"Inspect current published files read-only via company_read as needed, call stage_surface_patch once with complete, untruncated ops covering every overlapping path, and finish with surface_reply. Never ask the founder questions."
		);
	}
	return (
		`This session works on the interface "${input.surfaceTitle}" (${input.surfaceSlug}); its page shows ${folderRoot}/ from Company Files. ` +
		"Members preview staged patches, any of them on or off together, before they approve one. " +
		`Change files in ${folderRoot}/ only with stage_surface_patch (write_text, merge_json, delete; paths relative to ${folderRoot}/), calling stage_surface_patch once per independent deliverable (one change per report, blog post, article, or distinct section update — never bundle multiple deliverables into one change). ` +
		"When a follow-up revises an existing open change in this session, pass its changeId to stage_surface_patch to update it in place instead of creating a duplicate change (use replaceAll: true only when replacing the whole change from scratch, and createNew: true only when adding a separate new deliverable). " +
		"Write reports, analyses, essays, and blog posts as structured *.report.json articles (or self-contained .html files when custom visual presentation is asked for), not raw .md files; keep .md for brief working notes. " +
		"When the founder asks for multiple design, layout, or copy directions to flick through inside this session, stage each complete standalone alternative with stage_surface_patch using the same optionGroup slug (and optional optionGroupTitle) so they appear as a single multiple-choice picker in Changes — never embed a concept switcher or design-question UI into the real page or module. " +
		`Direct file writes are for notes under ${notesRoot}/ only; attach them as notePaths rather than loose files elsewhere.` +
		(options?.hasMakePicture
			? " Use make_picture to generate bespoke PNG visuals (hero scenes, product concepts, illustrations) directly into Preview as staged changes, inspect each image inline, and pass changeId if regenerating to update it in place."
			: "") +
		"\n\n" +
		describeStudioPage(view, folderRoot, input.voiceModel, input.voiceName) +
		describeStudioSkill(view, skill)
	);
}

type CloudStudioFile = CloudCompanyFolderFileEntry["file"] & { readonly entry: CloudCompanyFolderFileEntry };

export function cloudStudioFileReader(
	folder: Pick<CloudCompanyFolderClient, "list" | "readRange">,
): (roots: readonly string[], signal: AbortSignal) => Promise<SurfaceFolderContents> {
	const reader: SurfaceFolderReader<CloudStudioFile> = {
		async list(parent, after, limit, signal) {
			const page = await folder.list(parent ?? "", { ...(after === null ? {} : { after }), limit }, signal);
			return {
				entries: page.entries.map((entry) => ({
					path: entry.path,
					kind: entry.kind,
					file: entry.kind === "file" ? { ...entry.file, entry } : null,
				})),
			};
		},
		async readFile(file, signal, maxBytes) {
			if (maxBytes !== undefined && file.bytes > maxBytes)
				throw new Error("Studio file is larger than it may be read");
			return folder.readRange(file.entry, 0, file.bytes, signal);
		},
	};
	return async (roots, signal) => {
		const unread: string[] = [];
		const contents = await readSurfaceFolderFiles(reader, roots, signal, (path) => unread.push(path));
		if (unread.length > 0) throw new Error(`Studio folder could not be read: ${unread.join(", ")}`);
		return contents;
	};
}

async function readStudioContents(
	read: NonNullable<SurfaceSessionRunnerPorts["readStudioFiles"]>,
	surface: { readonly folderRoot: string; readonly slug: string },
	signal: AbortSignal,
): Promise<SurfaceFolderContents | null> {
	try {
		return await read(surfaceFolderRoots(surface), signal);
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	}
}

export function buildOpsSurfaceInstructions(input: SurfaceSessionTurnInput): string {
	return (
		`This session is scoped to the operational Surface "${input.surfaceTitle}" (${input.surfaceSlug}). ` +
		"Inspect Company Files read-only when helpful, and use stage_surface_ops_action to stage a clear, structured action (draft email, payment preparation, record update, or file organization) that founders can review and approve directly from the Action card. " +
		"When a follow-up revises an existing open action in this session, pass its changeId to update that Action card in place instead of creating a duplicate card."
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
		const normalizedFolderRoot =
			input.sourceKind === "folder"
				? normalizeFolderRoot(
						input.folderRoot ?? (input.surfaceSlug === "identity" ? "identity" : input.surfaceSlug),
					)
				: input.folderRoot
					? normalizeFolderRoot(input.folderRoot)
					: null;
		const isInternalReconciliation = Boolean(input.isInternal && input.state === "reconciling");
		const originRefRecord =
			input.originRef && typeof input.originRef === "object" && !Array.isArray(input.originRef)
				? (input.originRef as Record<string, unknown>)
				: null;
		const chainMode = input.chainMode ?? originRefRecord?.chainMode === true;
		const omittedBaseChanges =
			input.omittedBaseChanges ?? parseSurfaceOmittedBaseChanges(originRefRecord?.omittedBaseChanges);
		const previewBaseChanges = input.previewBaseChanges ?? [];
		const sessionOpenChanges = input.sessionOpenChanges ?? [];
		const replyChangeId = input.replyChangeId?.trim() || null;
		const externalPreviewOverlay =
			!isInternalReconciliation &&
			input.sourceKind === "folder" &&
			normalizedFolderRoot &&
			folderReader &&
			previewBaseChanges.length > 0
				? createSurfaceFolderPreviewOverlay({
						folderRoot: normalizedFolderRoot,
						previewBaseChanges,
						previewReconciliations: input.previewReconciliations ?? [],
						liveReader: folderReader,
					})
				: null;
		const previewOverlayStatus = externalPreviewOverlay ? await externalPreviewOverlay.prepare(signal) : null;
		// WHY: Keep patch baseFiles and layout validation anchored to external preview state so updating an open change never captures this session's own prior draft as its base.
		const baseReaderForPatch =
			externalPreviewOverlay && folderReader ? externalPreviewOverlay.wrapTextReader(folderReader) : folderReader;
		const ownSessionOverlay =
			!isInternalReconciliation &&
			input.sourceKind === "folder" &&
			normalizedFolderRoot &&
			baseReaderForPatch &&
			sessionOpenChanges.some((change) => change.kind === "folder_patch")
				? createSurfaceSessionOwnOverlay({
						folderRoot: normalizedFolderRoot,
						sessionOpenChanges,
						baseReader: baseReaderForPatch,
						replyChangeId,
					})
				: null;
		const ownOverlayStatus = ownSessionOverlay ? await ownSessionOverlay.prepare(signal) : null;
		const turnReadOverlay = chainFolderPreviewOverlays(externalPreviewOverlay, ownSessionOverlay);
		const effectiveFolderReader =
			turnReadOverlay && folderReader ? turnReadOverlay.wrapTextReader(folderReader) : folderReader;

		const explicitBrief = input.briefMarkdown?.trim() || null;
		const [loaded, folderBrief] = effectiveFolderReader
			? await Promise.all([
					loadSurfaceSharedAssets(effectiveFolderReader, signal, input.productFolderRoots),
					explicitBrief === null
						? readOptionalFolderText(
								effectiveFolderReader,
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

		const turnBrief = buildSurfaceTurnBrief({
			sessionId: input.sessionId,
			surfaceSlug: input.surfaceSlug,
			surfaceTitle: input.surfaceTitle,
			sourceKind: input.sourceKind,
			isInternalReconciliation,
			companyInterfaces: input.companyInterfaces ?? null,
			briefMarkdown,
			repositoryKey: input.repositoryKey ?? null,
			folderRoot: normalizedFolderRoot,
			explorationVariantLabel: input.explorationVariantLabel ?? null,
			identityContext,
			sharedAssets,
			pointToChangeTarget,
			conflictPaths: input.conflictPaths ?? null,
			conflictDetails: input.conflictDetails ?? null,
			previewBaseChanges,
			previewOverlayStatus: previewOverlayStatus?.status ?? null,
			previewSkippedPaths: previewOverlayStatus?.skippedPaths ?? null,
			sessionOpenChanges,
			replyChangeId,
			sessionOverlayStatus: ownOverlayStatus?.status ?? null,
			sessionOverlaySkippedPaths: ownOverlayStatus?.skippedPaths ?? null,
			chainMode,
			omittedBaseChanges,
			mainSha: input.mainSha ?? null,
			branchHeadSha: input.branchHeadSha ?? null,
			openChanges: input.openChanges ?? null,
			resolvedChanges: input.resolvedChanges ?? null,
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
			const writableRoots = isInternalReconciliation ? [] : [notesRoot];
			const stagedRoots = [folderRoot];
			const stagedText = new Map<string, string | null>();
			if (input.openScenesOps && input.openScenesOps.length > 0) {
				applyStudioTextOps(stagedText, input.openScenesOps, folderRoot);
			}
			const boundStageSurfacePatch = stageSurfacePatch.bind(ports.surfaceTools);
			const trackedSurfacePatch: SurfacePatchToolPort = {
				async stageSurfacePatch(sessionIdArg, request, context) {
					let effectiveRequest = request;
					if (!input.isInternal && request.baseFiles === undefined && baseReaderForPatch) {
						const baseFiles = await collectFolderPatchBaseFiles(
							baseReaderForPatch,
							folderRoot,
							request.ops,
							context.signal,
						);
						if (baseFiles) {
							effectiveRequest = { ...request, baseFiles };
						}
					}
					const result = await boundStageSurfacePatch(sessionIdArg, effectiveRequest, context);
					const targetOpen = request.changeId
						? sessionOpenChanges.find((ch) => ch.changeId === request.changeId)
						: undefined;
					if (!request.optionGroup && (!targetOpen?.optionGroupKey || targetOpen.changeId === replyChangeId)) {
						applyStudioTextOps(stagedText, request.ops, folderRoot);
					}
					return result;
				},
			};
			const readStudioText = async (relativePath: string, reqSignal: AbortSignal): Promise<string | null> => {
				const rel = normalizeStudioRelativePath(relativePath, folderRoot);
				if (!rel) return null;
				if (stagedText.has(rel)) return stagedText.get(rel) ?? null;
				if (!effectiveFolderReader) return null;
				return readRawOptionalFolderText(
					effectiveFolderReader,
					`${folderRoot}/${rel}`,
					MAX_STUDIO_TEXT_READ_BYTES,
					reqSignal,
				);
			};
			const folderToolsFor = (savesQuestions: boolean) =>
				ports.folderToolsContext
					? cloudFolderFileTools({
							folder: ports.folderToolsContext.folder,
							operations: ports.folderToolsContext.operations,
							identity: ports.folderToolsContext.identity,
							surfaceFilePolicy: { mode: "surface_worker", writableRoots, stagedRoots, savesQuestions },
							...(turnReadOverlay ? { previewOverlay: turnReadOverlay } : {}),
						})
					: [];
			const layoutStaging: SurfaceLayoutStaging | undefined = baseReaderForPatch
				? {
						folderRoot,
						waitingOps: input.openLayoutOps ?? null,
						readLayout: (readSignal) =>
							folderText(
								baseReaderForPatch,
								`${folderRoot}/${SURFACE_LAYOUT_PATH}`,
								MAX_STAGED_LAYOUT_READ_BYTES,
								readSignal,
							),
					}
				: undefined;
			const narrateTool =
				!isInternalReconciliation && ports.narrateExplainer
					? [
							createNarrateExplainerTool({
								sessionId: input.sessionId,
								folderRoot,
								voiceModel: input.voiceModel?.trim() || "chatgpt-voice",
								voiceName: input.voiceName?.trim() || "cove",
								readStudioText,
								stageBytes: ports.narrateExplainer.stageBytes,
								surfacePatch: trackedSurfacePatch,
								...(ports.narrateExplainer.synthesizeGemini
									? { synthesizeGemini: ports.narrateExplainer.synthesizeGemini }
									: {}),
								...(ports.narrateExplainer.synthesizeChatGptVoice
									? { synthesizeChatGptVoice: ports.narrateExplainer.synthesizeChatGptVoice }
									: {}),
								onStagedOps: (ops) => applyStudioTextOps(stagedText, ops, folderRoot),
							}),
						]
					: [];
			const patchTracker = createSurfacePatchSessionTracker({
				openChanges: sessionOpenChanges,
				replyChangeId,
				isInternalReconciliation,
				folderRoot,
			});
			const pictureTool =
				!isInternalReconciliation && ports.makePicture
					? [
							createStudioPictureTool({
								sessionId: input.sessionId,
								folderRoot,
								stageBytes: ports.makePicture.stageBytes,
								surfacePatch: trackedSurfacePatch,
								pictures: ports.makePicture.pictures,
								patchTracker,
							}),
						]
					: [];
			const readStudioFiles =
				ports.readStudioFiles ??
				(ports.folderToolsContext ? cloudStudioFileReader(ports.folderToolsContext.folder) : undefined);
			let contents = readStudioFiles
				? await readStudioContents(readStudioFiles, { folderRoot, slug: input.surfaceSlug }, signal)
				: null;
			if (contents && turnReadOverlay) {
				const layoutPath = `${folderRoot}/${SURFACE_LAYOUT_PATH}`;
				const overlaidLayout = await turnReadOverlay.lookup(layoutPath, signal);
				if (overlaidLayout?.kind === "file") {
					contents = {
						...contents,
						files: { ...contents.files, [layoutPath]: overlaidLayout.content },
					};
				} else if (overlaidLayout?.kind === "deleted") {
					const nextFiles = { ...contents.files };
					delete nextFiles[layoutPath];
					contents = { ...contents, files: nextFiles };
				}
			}
			signal.throwIfAborted();
			const view = surfaceStudioPageView(input, folderRoot, contents);
			const savesQuestions = !isInternalReconciliation && view.page === "layout" && view.starter === "analytics";
			const tools: CloudNativeTool[] = [
				createStageSurfacePatchTool(input.sessionId, trackedSurfacePatch, layoutStaging, {
					deferSessionCompletion: true,
					allowMultipleDeliverables: isInternalReconciliation,
					openChanges: sessionOpenChanges,
					replyChangeId,
					isInternalReconciliation,
					tracker: patchTracker,
				}),
				...narrateTool,
				...pictureTool,
				...folderToolsFor(savesQuestions),
				...(ports.extraTools ?? []),
			];
			const readSkill: CloudStudioSkillReader | undefined = folderReader
				? (path, maxBytes, readSignal) => folderText(folderReader, path, maxBytes, readSignal)
				: undefined;
			const skill =
				view.page === "layout"
					? await cloudStudioSkill(SURFACE_STARTER_SKILLS[view.starter], readSkill, signal)
					: null;
			outcome = await ports.executeTurn({
				input,
				mode: "folder",
				instructions: buildFolderSurfaceInstructions(input, folderRoot, notesRoot, view, skill, {
					chainMode,
					hasOmittedBases: omittedBaseChanges.length > 0,
					hasMakePicture: pictureTool.length > 0,
				}),
				turnBrief,
				tools,
				identityContext,
				sharedAssets,
				writableRoots,
				stagedRoots,
				savesQuestions,
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
				createStageSurfaceOpsActionTool(
					input.sessionId,
					{
						stageSurfaceOpsAction: stageSurfaceOpsAction.bind(ports.surfaceTools),
					},
					{
						openChanges: sessionOpenChanges,
						replyChangeId,
						isInternalReconciliation,
					},
				),
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
				writableRoots: [],
				stagedRoots: [],
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
				sourceKind: input.sourceKind,
				isInternalReconciliation,
				briefMarkdown,
				repositoryKey: input.repositoryKey ?? null,
				folderRoot: normalizedFolderRoot,
				explorationVariantLabel: input.explorationVariantLabel ?? null,
				identityContext,
				sharedAssets,
				pointToChangeTarget,
				conflictPaths: input.conflictPaths ?? null,
				conflictDetails: input.conflictDetails ?? null,
				previewBaseChanges,
				sessionOpenChanges,
				replyChangeId,
				chainMode,
				omittedBaseChanges,
				mainSha: input.mainSha ?? null,
				branchHeadSha: input.branchHeadSha ?? null,
				openChanges: input.openChanges ?? null,
				resolvedChanges: input.resolvedChanges ?? null,
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
	const surfaceArchetype = surfaceArchetypeOf(job.surfaceArchetype);
	return {
		sessionId: job.sessionId,
		surfaceId: job.surfaceId,
		companyId: job.profileId,
		surfaceSlug,
		surfaceTitle,
		...(job.surfaceKind ? { surfaceKind: job.surfaceKind } : {}),
		...(typeof job.surfaceIcon === "string" ? { surfaceIcon: job.surfaceIcon } : {}),
		...(typeof job.surfaceIsGlobal === "boolean" ? { surfaceIsGlobal: job.surfaceIsGlobal } : {}),
		...(surfaceArchetype ? { surfaceArchetype } : {}),
		sourceKind: inferDeliverySourceKind(job),
		prompt: job.prompt,
		state: job.state,
		...(job.isInternal ? { isInternal: true } : {}),
		repositoryKey: job.repositoryKey ?? null,
		folderRoot: job.folderRoot ?? null,
		...(job.productFolderRoots ? { productFolderRoots: job.productFolderRoots } : {}),
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
