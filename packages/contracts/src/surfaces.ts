import type { SurfaceStarterKind } from "./surface-layout.ts";
import {
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseTimestamp,
	parseUuid,
	WireValueError,
} from "./wire-values.ts";

export const SURFACE_SCHEMA_VERSION = "qorpera.surface/v1";

export const SURFACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SURFACE_OPTION_GROUP_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SURFACE_REPOSITORY_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const SURFACE_REPOSITORY_NAME_PATTERN = /^[a-z0-9_](?:[a-z0-9_.-]{0,98}[a-z0-9_-])?$/;
export const SURFACE_REPOSITORY_SUBPATH_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export const SURFACE_DEFAULT_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const SURFACE_MAX_REPOSITORY_SUBPATH_CHARS = 240;
export const SURFACE_MAX_DEFAULT_BRANCH_CHARS = 128;
export const SURFACE_SUPERSEDE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
export const SURFACE_MAX_TITLE_CHARS = 80;
export const SURFACE_MAX_PROMPT_CHARS = 16_000;
export const SURFACE_MAX_CHANGE_TITLE_CHARS = 160;
export const SURFACE_MAX_CHANGE_SUMMARY_CHARS = 2_000;
export const SURFACE_MAX_OPTION_GROUP_KEY_CHARS = 80;
export const SURFACE_MAX_OPTION_GROUP_TITLE_CHARS = 160;
export const SURFACE_MAX_SUPERSEDE_KEY_CHARS = 80;
export const SURFACE_MAX_COMPARE_VARIANTS = 3;

export const SURFACE_GROUPS = ["products", "operations"] as const;
export type SurfaceGroup = (typeof SURFACE_GROUPS)[number];

export const SURFACE_ARCHETYPES = ["live_build", "studio", "ops"] as const;
export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

export const SURFACE_KINDS = [
	"identity",
	"strategy",
	"website",
	"web_app",
	"mobile_app",
	"desktop_app",
	"database",
	"dashboard",
	"brand",
	"product",
	"report",
	"custom",
	"inbox",
	"money",
	"members",
	"data",
	"files",
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const SURFACE_FIGURES = [
	"browser",
	"pointer",
	"phone",
	"monitor",
	"can",
	"bars",
	"seal",
	"palette",
	"parcel",
	"book",
	"envelope",
	"money",
	"people",
	"folder",
	"gem",
	"shop",
	"postbox",
	"piggy",
	"cabinet",
	"house",
	"lighthouse",
	"jar",
	"headband",
	"sofa",
	"mug",
	"lamp",
] as const;
export type SurfaceFigure = (typeof SURFACE_FIGURES)[number];

export const SURFACE_PUBLISH_STATUSES = ["idle", "publishing", "failed"] as const;
export type SurfacePublishStatus = (typeof SURFACE_PUBLISH_STATUSES)[number];

export const SURFACE_PUBLISH_ASK_STATUSES = ["open", "declined"] as const;
export type SurfacePublishAskStatus = (typeof SURFACE_PUBLISH_ASK_STATUSES)[number];

export const SURFACE_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const SURFACE_STATUSES = ["proposed", "active", "archived"] as const;
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];

export const SURFACE_SOURCE_KINDS = ["code_repo", "folder", "native_ops"] as const;
export type SurfaceSourceKind = (typeof SURFACE_SOURCE_KINDS)[number];

export const SURFACE_PREVIEW_MODES = ["static_site", "app_proxy", "studio_overlay", "none"] as const;
export type SurfacePreviewMode = (typeof SURFACE_PREVIEW_MODES)[number];

export const SURFACE_SESSION_STATES = [
	"queued",
	"running",
	"needs_input",
	"ready",
	"reconciling",
	"completed",
	"discarded",
	"failed",
] as const;
export type SurfaceSessionState = (typeof SURFACE_SESSION_STATES)[number];

export const SURFACE_SESSION_ORIGIN_KINDS = [
	"member",
	"cofounder",
	"automation",
	"point_to_change",
	"cross_surface",
] as const;
export type SurfaceSessionOriginKind = (typeof SURFACE_SESSION_ORIGIN_KINDS)[number];

export const SURFACE_CHANGE_KINDS = ["git_range", "folder_patch", "ops_action"] as const;
export type SurfaceChangeKind = (typeof SURFACE_CHANGE_KINDS)[number];

export const SURFACE_CHANGE_STATUSES = ["staged", "merging", "merged", "conflicted", "discarded", "reverted"] as const;
export type SurfaceChangeStatus = (typeof SURFACE_CHANGE_STATUSES)[number];

export const SURFACE_EXPLORATION_STATUSES = ["open", "chosen", "discarded"] as const;
export type SurfaceExplorationStatus = (typeof SURFACE_EXPLORATION_STATUSES)[number];

export const SURFACE_PREVIEW_STATUSES = [
	"live_baseline",
	"composing",
	"reconciling",
	"building",
	"ready",
	"conflicted",
	"failed",
] as const;
export type SurfacePreviewStatus = (typeof SURFACE_PREVIEW_STATUSES)[number];

export const SURFACE_RECONCILIATION_STATUSES = ["queued", "running", "ready", "failed"] as const;
export type SurfaceReconciliationStatus = (typeof SURFACE_RECONCILIATION_STATUSES)[number];

export const SURFACE_AUTOMATION_OUTPUT_MODES = ["surface_session", "decision_card", "silent_note"] as const;
export type SurfaceAutomationOutputMode = (typeof SURFACE_AUTOMATION_OUTPUT_MODES)[number];

export const SURFACE_AUTOMATION_STATUSES = ["idle", "running", "needs_attention", "paused"] as const;
export type SurfaceAutomationStatus = (typeof SURFACE_AUTOMATION_STATUSES)[number];

export const SURFACE_AUTOMATION_OFFER_STATUSES = ["open", "no"] as const;
export type SurfaceAutomationOfferStatus = (typeof SURFACE_AUTOMATION_OFFER_STATUSES)[number];

export const SURFACE_SESSION_MESSAGE_AUTHORS = ["member", "session", "system", "note", "agent"] as const;
export type SurfaceSessionMessageAuthor = (typeof SURFACE_SESSION_MESSAGE_AUTHORS)[number];

export const SURFACE_INSPECTOR_MODE_MESSAGE = "qorpera-inspector-mode";
export const SURFACE_INSPECTOR_PICK_MESSAGE = "qorpera-inspector-pick";

export interface SurfaceSessionMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly authorKind: SurfaceSessionMessageAuthor;
	readonly authorUserId?: string | null;
	readonly authorLabel?: string | null;
	readonly text: string;
	readonly changeId: string | null;
	readonly noteTo?: readonly string[];
	readonly createdAt: string;
}

export interface SurfaceUnseenNote {
	readonly surfaceId: string;
	readonly sessionId: string;
	readonly count: number;
}

export const SURFACE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const SURFACE_IMAGE_MAX_COUNT = 5;
export const SURFACE_IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const SURFACE_SESSION_IMAGES_SCHEMA = "qorpera.surface-session-images/v1";

export interface SurfaceImageRef {
	readonly sha256: string;
	readonly bytes: number;
	readonly mediaType: string;
}

export interface SurfaceMessageImages {
	readonly messageId: string;
	readonly clientInputId: string;
	readonly images: readonly SurfaceImageRef[];
}

export interface SurfaceSessionImages {
	readonly sessionId: string;
	readonly messages: readonly SurfaceMessageImages[];
}

export const STUDIO_BINARY_MEDIA_TYPES = [
	"model/gltf-binary",
	"image/webp",
	"image/png",
	"image/jpeg",
	"audio/wav",
	"audio/mp4",
	"audio/mpeg",
	"audio/webm",
	"application/pdf",
] as const;
export const STUDIO_BINARY_MAX_BYTES = 64 * 1024 * 1024;

export interface StudioBinaryRef {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
}

export type StudioTextPatchOp =
	| { readonly op: "write_text"; readonly path: string; readonly content: string }
	| { readonly op: "delete"; readonly path: string }
	| { readonly op: "merge_json"; readonly path: string; readonly patch: Readonly<Record<string, unknown>> };

export interface StudioWriteFileOp {
	readonly op: "write_file";
	readonly path: string;
	readonly file: StudioBinaryRef;
}

export type StudioPatchOp = StudioTextPatchOp | StudioWriteFileOp;

export interface StudioPatchChange {
	readonly changeId: string;
	readonly ops: readonly StudioPatchOp[];
	readonly baseFiles?: Readonly<Record<string, string | null>> | null;
	readonly previewBaseChangeIds?: readonly string[];
}

export interface SurfaceReconciliation {
	readonly id: string;
	readonly surfaceId: string;
	readonly compositionKey: string;
	readonly baseFingerprint: string;
	readonly selectedChangeIds: readonly string[];
	readonly status: SurfaceReconciliationStatus;
	readonly patchManifest: readonly StudioPatchOp[] | null;
	readonly conflictPaths?: readonly string[];
	readonly commitSha: string | null;
	readonly treeSha: string | null;
	readonly errorDetail: string | null;
	readonly updatedAt: string;
}

export interface CrossSurfaceHandoffRequest {
	readonly sourceSurfaceId: string;
	readonly targetSurfaceSlug: string;
	readonly prompt: string;
	readonly title?: string;
	readonly sourceRef?: Readonly<Record<string, unknown>>;
}

export interface SurfacePublishAsk {
	readonly askedByUserId: string;
	readonly askedUserId: string;
	readonly askedAt: string;
	readonly changeCount: number;
	readonly status: SurfacePublishAskStatus;
	readonly answeredAt: string | null;
}

export interface SurfaceSummary {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly group: SurfaceGroup;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind;
	readonly accentHex?: string | null;
	readonly isGlobal?: boolean;
	readonly status: SurfaceStatus;
	readonly icon: string;
	readonly sourceKind: SurfaceSourceKind;
	readonly repositoryKey: string | null;
	readonly repositorySubpath?: string | null;
	readonly defaultBranch?: string;
	readonly folderRoot: string | null;
	readonly siteSlug: string | null;
	readonly previewMode: SurfacePreviewMode;
	readonly autoPublish: boolean;
	readonly publishStatus?: SurfacePublishStatus;
	readonly lastPublishError?: string | null;
	readonly liveHeadSha?: string | null;
	readonly folderRevision?: number;
	readonly liveUrl: string | null;
	readonly hasUnpublishedChanges: boolean;
	readonly unpublishedChangeCount: number;
	readonly activeSessionCount: number;
	readonly runningSessionCount: number;
	readonly pendingChangeCount: number;
	readonly needsAttentionCount: number;
	readonly sortOrder: number;
	readonly publishAsk?: SurfacePublishAsk | null;
	readonly publishBeingFixed?: boolean;
}

export interface SurfaceChangeDiffStats {
	readonly filesChanged: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface SurfaceChangeUnit {
	readonly id: string;
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly seq: number;
	readonly title: string;
	readonly summary: string;
	readonly kind: SurfaceChangeKind;
	readonly status: SurfaceChangeStatus;
	readonly optionGroupKey?: string | null;
	readonly optionGroupTitle?: string | null;
	readonly supersedeKey?: string | null;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly dependsOnChangeIds: readonly string[];
	readonly previewBaseChangeIds?: readonly string[];
	readonly affectedPaths: readonly string[];
	readonly patchManifest?: readonly StudioPatchOp[] | null;
	readonly baseFiles?: Readonly<Record<string, string | null>> | null;
	readonly diffStats: SurfaceChangeDiffStats | null;
	readonly conflictPaths: readonly string[] | null;
	readonly landedChangeNumber: number | null;
	readonly canUndo: boolean;
	readonly undoBatchSize?: number;
	readonly publishedAt?: string | null;
	readonly approvedByUserId?: string | null;
	readonly createdAt: string;
	readonly resolvedAt: string | null;
}

export interface SurfaceSessionQuestion {
	readonly text: string;
	readonly options: readonly string[];
}

export interface SurfaceSession {
	readonly id: string;
	readonly surfaceId: string;
	readonly workerId: string | null;
	readonly title: string;
	readonly prompt: string;
	readonly state: SurfaceSessionState;
	readonly originKind: SurfaceSessionOriginKind;
	readonly originLabel: string | null;
	readonly createdByUserId?: string | null;
	readonly turnRequestedByUserId?: string | null;
	readonly explorationId: string | null;
	readonly explorationVariantLabel: string | null;
	readonly supersedeKey?: string | null;
	readonly branchHeadSha?: string | null;
	readonly hasActiveChat: boolean;
	readonly question: SurfaceSessionQuestion | null;
	readonly notePaths?: readonly string[];
	readonly changes: readonly SurfaceChangeUnit[];
	readonly messages: readonly SurfaceSessionMessage[];
	readonly openChangeCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
}

export interface SurfaceExplorationSet {
	readonly id: string;
	readonly surfaceId: string;
	readonly title: string;
	readonly status: SurfaceExplorationStatus;
	readonly ownerLabel?: string | null;
	readonly notePaths?: readonly string[];
	readonly chosenSessionId: string | null;
	readonly variantSessionIds: readonly string[];
	readonly createdAt: string;
	readonly resolvedAt: string | null;
}

export interface PointToChangeTarget {
	readonly route: string;
	readonly selector: string;
	readonly textSnippet: string;
	readonly tagName: string;
	readonly componentHint: string | null;
	readonly boundingBox: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	readonly viewport: {
		readonly width: number;
		readonly height: number;
	};
}

export interface SurfacePreviewConflict {
	readonly changeIds: readonly string[];
	readonly paths: readonly string[];
}

export interface SurfacePreviewKeptFrame {
	readonly previewId: string;
	readonly doorActionUrl: string | null;
	readonly memberPass: string | null;
}

export interface SurfacePreviewFrameState {
	readonly previewId: string | null;
	readonly status: SurfacePreviewStatus;
	readonly doorActionUrl: string | null;
	readonly memberPass: string | null;
	readonly activeRoute: string;
	readonly toggledChangeIds: readonly string[];
	readonly conflictReport: SurfacePreviewConflict | null;
	readonly errorDetail: string | null;
	readonly kept?: SurfacePreviewKeptFrame | null;
	readonly fixing?: boolean;
}

export interface SurfacePreviewCompositionState {
	readonly surfaceId: string;
	readonly mode: "single" | "compare";
	readonly primary: SurfacePreviewFrameState;
	readonly compareFrames: readonly {
		readonly sessionId: string;
		readonly label: string;
		readonly frame: SurfacePreviewFrameState;
	}[];
}

export interface SurfaceAutomationSummary {
	readonly id: string;
	readonly key: string;
	readonly title: string;
	readonly prompt?: string | null;
	readonly scheduleSummary: string;
	readonly targetSurfaceSlug: string | null;
	readonly outputMode: SurfaceAutomationOutputMode;
	readonly enabled: boolean;
	readonly status: SurfaceAutomationStatus;
	readonly lastRunAt: string | null;
	readonly lastOutcomeSummary: string | null;
	readonly nextRunAt: string | null;
	readonly ownable: boolean;
	readonly ownerUserId: string | null;
	readonly offer: SurfaceAutomationOffer | null;
}

export interface SurfaceAutomationOffer {
	readonly id: string;
	readonly fromUserId: string | null;
	readonly toUserId: string | null;
	readonly offeredByUserId: string | null;
	readonly status: SurfaceAutomationOfferStatus;
	readonly answeredAt: string | null;
}

export interface SurfaceWorkspace {
	readonly surface: SurfaceSummary;
	readonly briefSummary: string | null;
	readonly activeSessions: readonly SurfaceSession[];
	readonly recentHistory: readonly SurfaceSession[];
	readonly explorations: readonly SurfaceExplorationSet[];
	readonly previewState: SurfacePreviewCompositionState;
	readonly reconciliations?: readonly SurfaceReconciliation[];
}

export interface SurfaceMigrationAgentItem {
	readonly agentId: string;
	readonly handle: string;
	readonly name: string;
	readonly role: string;
	readonly routineCount: number;
	readonly recommendedAction: "fold_to_automation" | "fold_to_surface_brief" | "archive_readonly";
	readonly recommendedTargetSurfaceSlug: string | null;
}

export interface SurfaceMigrationBoardItem {
	readonly appName: string;
	readonly title: string;
	readonly kit: string | null;
	readonly recommendedAction: "promote_surface" | "archive_to_files";
	readonly recommendedSurfaceSlug: string | null;
}

export interface SurfaceMigrationChecklist {
	readonly companyId: string;
	readonly alreadyMigrated: boolean;
	readonly proposedSurfaces: readonly {
		readonly slug: string;
		readonly title: string;
		readonly group: SurfaceGroup;
		readonly archetype: SurfaceArchetype;
		readonly sourceKind: SurfaceSourceKind;
		readonly sourceRef: string | null;
	}[];
	readonly specialistAgents: readonly SurfaceMigrationAgentItem[];
	readonly legacyBoards: readonly SurfaceMigrationBoardItem[];
}

export const OPEN_SURFACE_CHANGE_STATUSES: ReadonlySet<SurfaceChangeStatus> = new Set([
	"staged",
	"merging",
	"conflicted",
]);

export const RUNNING_SURFACE_SESSION_STATES: ReadonlySet<SurfaceSessionState> = new Set([
	"queued",
	"running",
	"reconciling",
	"needs_input",
]);

export function countOpenSurfaceChanges(changes: readonly Pick<SurfaceChangeUnit, "status">[]): number {
	let count = 0;
	for (const change of changes) {
		if (OPEN_SURFACE_CHANGE_STATUSES.has(change.status)) count += 1;
	}
	return count;
}

// WHY: Prevents multi-change sessions from vanishing mid-review until every change is resolved and the member is done chatting.
export function nextSurfaceSessionLifecycleState(input: {
	state: SurfaceSessionState;
	hasActiveChat: boolean;
	changes: readonly Pick<SurfaceChangeUnit, "status">[];
}): SurfaceSessionState {
	if (RUNNING_SURFACE_SESSION_STATES.has(input.state) || input.state === "failed") return input.state;
	const openCount = countOpenSurfaceChanges(input.changes);
	if (openCount > 0 || input.hasActiveChat) return "ready";
	if (input.changes.length === 0) return input.state;
	const anyMerged = input.changes.some((change) => change.status === "merged");
	return anyMerged ? "completed" : "discarded";
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new WireValueError(label);
	return value as T;
}

function parseOptionalText(value: unknown, label: string, maxLength: number): string | null {
	if (value === null || value === undefined) return null;
	return parseBoundedText(value, label, maxLength, 0);
}

function parseOptionalUuid(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	return parseUuid(value, label);
}

function parseOptionalFlag(value: unknown, label: string): boolean | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "boolean") throw new WireValueError(label);
	return value;
}

function parseOptionalTimestamp(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	return parseTimestamp(value, label).text;
}

function parseStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new WireValueError(label);
	return value.map((item, index) => parseBoundedText(item, `${label}[${index}]`, maxLength));
}

function parseUuidArray(value: unknown, label: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new WireValueError(label);
	return value.map((item, index) => parseUuid(item, `${label}[${index}]`));
}

function parseOptionalAccentHex(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !SURFACE_HEX_COLOR_PATTERN.test(value)) throw new WireValueError(label);
	return value;
}

export function parseStudioPatchOps(value: unknown, label = "patchManifest"): StudioPatchOp[] {
	if (!Array.isArray(value) || value.length > 256) throw new WireValueError(label);
	return value.map((item, index) => {
		const raw = parseRecord(item, `${label}[${index}]`);
		const path = parseBoundedText(raw.path, `${label}[${index}].path`, 512);
		if (raw.op === "write_text") {
			if (typeof raw.content !== "string" || raw.content.length > 512_000) {
				throw new WireValueError(`${label}[${index}].content`);
			}
			return { op: "write_text", path, content: raw.content };
		}
		if (raw.op === "delete") {
			return { op: "delete", path };
		}
		if (raw.op === "merge_json") {
			const patch = parseRecord(raw.patch, `${label}[${index}].patch`);
			return { op: "merge_json", path, patch };
		}
		if (raw.op === "write_file") {
			return { op: "write_file", path, file: parseStudioBinaryRef(raw.file, `${label}[${index}].file`) };
		}
		throw new WireValueError(`${label}[${index}].op`);
	});
}

export function parseStudioBinaryRef(value: unknown, label = "file"): StudioBinaryRef {
	const raw = parseClosedRecord(value, label, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
	return {
		manifestSha256: parseSha256Hex(raw.manifestSha256, `${label}.manifestSha256`),
		fileSha256: parseSha256Hex(raw.fileSha256, `${label}.fileSha256`),
		bytes: parseInteger(raw.bytes, `${label}.bytes`, 1, STUDIO_BINARY_MAX_BYTES),
		mediaType: parseEnum(raw.mediaType, STUDIO_BINARY_MEDIA_TYPES, `${label}.mediaType`),
	};
}

export interface CompanyCodeRepositorySummary {
	readonly repositoryKey: string;
	readonly owner: string;
	readonly name: string;
	readonly mainSha: string | null;
	readonly sourceBranch: string;
	readonly sourceUrl: string | null;
	readonly boundSurfaceSlugs: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export function isSurfaceRepositoryKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parts = value.toLowerCase().split("/");
	if (parts.length !== 2) return false;
	const [owner, name] = parts;
	if (!owner || !name) return false;
	if (!SURFACE_REPOSITORY_OWNER_PATTERN.test(owner) || !SURFACE_REPOSITORY_NAME_PATTERN.test(name)) return false;
	return name !== "." && name !== ".." && !name.startsWith(".") && !name.endsWith(".git");
}

export function normalizeSurfaceRepositorySubpath(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const cleaned = value.trim().replace(/^\/+|\/+$/g, "");
	if (!cleaned || cleaned === ".") return null;
	return cleaned;
}

const UTF8_ENCODER = new TextEncoder();

export function isSurfaceRepositorySubpath(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || UTF8_ENCODER.encode(value).byteLength > SURFACE_MAX_REPOSITORY_SUBPATH_CHARS) return false;
	if (
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("//") ||
		value.includes("\\") ||
		value.includes("\0")
	)
		return false;
	const segments = value.split("/");
	return segments.every(
		(segment) =>
			segment.length > 0 &&
			segment !== "." &&
			segment !== ".." &&
			SURFACE_REPOSITORY_SUBPATH_SEGMENT_PATTERN.test(segment),
	);
}

export function isSurfaceDefaultBranch(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || UTF8_ENCODER.encode(value).byteLength > SURFACE_MAX_DEFAULT_BRANCH_CHARS) return false;
	const lower = value.toLowerCase();
	if (lower === "qorpera" || lower.startsWith("qorpera/")) return false;
	if (
		!SURFACE_DEFAULT_BRANCH_PATTERN.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{")
	)
		return false;
	if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
	return value
		.split("/")
		.every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

export function parseCompanyCodeRepositorySummary(
	value: unknown,
	label = "codeRepository",
): CompanyCodeRepositorySummary {
	const raw = parseRecord(value, label);
	const repositoryKey = parseBoundedText(raw.repositoryKey, `${label}.repositoryKey`, 200);
	if (!isSurfaceRepositoryKey(repositoryKey)) throw new WireValueError(`${label}.repositoryKey`);
	const owner = parseBoundedText(raw.owner, `${label}.owner`, 64);
	const name = parseBoundedText(raw.name, `${label}.name`, 128);
	const sourceBranchRaw = parseOptionalText(
		raw.sourceBranch,
		`${label}.sourceBranch`,
		SURFACE_MAX_DEFAULT_BRANCH_CHARS,
	);
	const sourceBranch = sourceBranchRaw && isSurfaceDefaultBranch(sourceBranchRaw) ? sourceBranchRaw : "main";
	return {
		repositoryKey,
		owner,
		name,
		mainSha: parseOptionalText(raw.mainSha, `${label}.mainSha`, 64),
		sourceBranch,
		sourceUrl: parseOptionalText(raw.sourceUrl, `${label}.sourceUrl`, 512),
		boundSurfaceSlugs:
			raw.boundSurfaceSlugs === undefined
				? []
				: parseStringArray(raw.boundSurfaceSlugs, `${label}.boundSurfaceSlugs`, 64, 64),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		updatedAt: parseTimestamp(raw.updatedAt, `${label}.updatedAt`).text,
	};
}

export function isSurfaceSlug(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 64 && SURFACE_SLUG_PATTERN.test(value);
}

export function isSurfaceOptionGroupKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= SURFACE_MAX_OPTION_GROUP_KEY_CHARS &&
		SURFACE_OPTION_GROUP_KEY_PATTERN.test(value)
	);
}

export function isSurfaceSupersedeKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= SURFACE_MAX_SUPERSEDE_KEY_CHARS &&
		SURFACE_SUPERSEDE_KEY_PATTERN.test(value)
	);
}

export function parseSurfaceSlug(value: unknown, label = "surface.slug"): string {
	if (!isSurfaceSlug(value)) throw new WireValueError(label);
	return value;
}

export interface SurfaceLinkTarget {
	readonly slug: string;
	readonly tab?: string;
}

const SURFACE_TAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function surfaceLinkTarget(href: string): SurfaceLinkTarget | undefined {
	const trimmed = href.trim();
	if (!trimmed.toLowerCase().startsWith("surface:")) return undefined;
	const rest = trimmed.slice("surface:".length).trim();
	if (!rest) return undefined;
	const hash = rest.indexOf("#");
	const slug = (hash < 0 ? rest : rest.slice(0, hash)).toLowerCase();
	if (!isSurfaceSlug(slug)) return undefined;
	if (hash < 0) return { slug };
	const tab = rest.slice(hash + 1).toLowerCase();
	if (!tab || tab.length > 40 || !SURFACE_TAB_PATTERN.test(tab)) return undefined;
	return { slug, tab };
}

function parseSurfacePublishAsk(value: unknown, label: string): SurfacePublishAsk {
	const raw = parseRecord(value, label);
	return {
		askedByUserId: parseUuid(raw.askedByUserId, `${label}.askedByUserId`),
		askedUserId: parseUuid(raw.askedUserId, `${label}.askedUserId`),
		askedAt: parseTimestamp(raw.askedAt, `${label}.askedAt`).text,
		changeCount: parseInteger(raw.changeCount, `${label}.changeCount`, 0, 10_000),
		status: parseEnum(raw.status, SURFACE_PUBLISH_ASK_STATUSES, `${label}.status`),
		answeredAt: parseOptionalTimestamp(raw.answeredAt, `${label}.answeredAt`),
	};
}

export function parseSurfaceSummary(value: unknown, label = "surface"): SurfaceSummary {
	const raw = parseRecord(value, label);
	if (typeof raw.autoPublish !== "boolean") throw new WireValueError(`${label}.autoPublish`);
	if (typeof raw.hasUnpublishedChanges !== "boolean") throw new WireValueError(`${label}.hasUnpublishedChanges`);
	const kind =
		raw.kind === undefined || raw.kind === null ? undefined : parseEnum(raw.kind, SURFACE_KINDS, `${label}.kind`);
	const accentHex =
		raw.accentHex === undefined ? undefined : parseOptionalAccentHex(raw.accentHex, `${label}.accentHex`);
	let isGlobal: boolean | undefined;
	if (raw.isGlobal !== undefined && raw.isGlobal !== null) {
		if (typeof raw.isGlobal !== "boolean") throw new WireValueError(`${label}.isGlobal`);
		isGlobal = raw.isGlobal;
	}
	const publishStatus =
		raw.publishStatus === undefined || raw.publishStatus === null
			? undefined
			: parseEnum(raw.publishStatus, SURFACE_PUBLISH_STATUSES, `${label}.publishStatus`);
	const lastPublishError =
		raw.lastPublishError === undefined
			? undefined
			: parseOptionalText(raw.lastPublishError, `${label}.lastPublishError`, 1000);
	const liveHeadSha =
		raw.liveHeadSha === undefined ? undefined : parseOptionalText(raw.liveHeadSha, `${label}.liveHeadSha`, 64);
	const folderRevision =
		raw.folderRevision === undefined || raw.folderRevision === null
			? undefined
			: parseInteger(raw.folderRevision, `${label}.folderRevision`, 0, 1_000_000_000);
	const publishAsk =
		raw.publishAsk === undefined || raw.publishAsk === null
			? raw.publishAsk
			: parseSurfacePublishAsk(raw.publishAsk, `${label}.publishAsk`);
	const publishBeingFixed = parseOptionalFlag(raw.publishBeingFixed, `${label}.publishBeingFixed`);
	const repositorySubpath =
		raw.repositorySubpath === undefined
			? undefined
			: raw.repositorySubpath === null
				? null
				: isSurfaceRepositorySubpath(raw.repositorySubpath)
					? raw.repositorySubpath
					: (() => {
							throw new WireValueError(`${label}.repositorySubpath`);
						})();
	const defaultBranch =
		raw.defaultBranch === undefined || raw.defaultBranch === null
			? undefined
			: isSurfaceDefaultBranch(raw.defaultBranch)
				? raw.defaultBranch
				: (() => {
						throw new WireValueError(`${label}.defaultBranch`);
					})();
	return {
		id: parseUuid(raw.id, `${label}.id`),
		slug: parseSurfaceSlug(raw.slug, `${label}.slug`),
		title: parseBoundedText(raw.title, `${label}.title`, SURFACE_MAX_TITLE_CHARS),
		group: parseEnum(raw.group, SURFACE_GROUPS, `${label}.group`),
		archetype: parseEnum(raw.archetype, SURFACE_ARCHETYPES, `${label}.archetype`),
		...(kind !== undefined ? { kind } : {}),
		...(accentHex !== undefined ? { accentHex } : {}),
		...(isGlobal !== undefined ? { isGlobal } : {}),
		status: parseEnum(raw.status, SURFACE_STATUSES, `${label}.status`),
		icon: parseBoundedText(raw.icon, `${label}.icon`, 40),
		sourceKind: parseEnum(raw.sourceKind, SURFACE_SOURCE_KINDS, `${label}.sourceKind`),
		repositoryKey: parseOptionalText(raw.repositoryKey, `${label}.repositoryKey`, 200),
		...(repositorySubpath !== undefined ? { repositorySubpath } : {}),
		...(defaultBranch !== undefined ? { defaultBranch } : {}),
		folderRoot: parseOptionalText(raw.folderRoot, `${label}.folderRoot`, 256),
		siteSlug: parseOptionalText(raw.siteSlug, `${label}.siteSlug`, 64),
		previewMode: parseEnum(raw.previewMode, SURFACE_PREVIEW_MODES, `${label}.previewMode`),
		autoPublish: raw.autoPublish,
		...(publishStatus !== undefined ? { publishStatus } : {}),
		...(lastPublishError !== undefined ? { lastPublishError } : {}),
		...(liveHeadSha !== undefined ? { liveHeadSha } : {}),
		...(folderRevision !== undefined ? { folderRevision } : {}),
		liveUrl: parseOptionalText(raw.liveUrl, `${label}.liveUrl`, 512),
		hasUnpublishedChanges: raw.hasUnpublishedChanges,
		unpublishedChangeCount: parseInteger(
			raw.unpublishedChangeCount ?? 0,
			`${label}.unpublishedChangeCount`,
			0,
			10_000,
		),
		activeSessionCount: parseInteger(raw.activeSessionCount ?? 0, `${label}.activeSessionCount`, 0, 10_000),
		runningSessionCount: parseInteger(raw.runningSessionCount ?? 0, `${label}.runningSessionCount`, 0, 10_000),
		pendingChangeCount: parseInteger(raw.pendingChangeCount ?? 0, `${label}.pendingChangeCount`, 0, 100_000),
		needsAttentionCount: parseInteger(raw.needsAttentionCount ?? 0, `${label}.needsAttentionCount`, 0, 100_000),
		sortOrder: parseInteger(raw.sortOrder ?? 0, `${label}.sortOrder`, -10_000, 100_000),
		...(publishAsk !== undefined ? { publishAsk } : {}),
		...(publishBeingFixed !== undefined ? { publishBeingFixed } : {}),
	};
}

function parseOptionalBaseFiles(
	value: unknown,
	label: string,
): Readonly<Record<string, string | null>> | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const raw = parseRecord(value, label);
	const keys = Object.keys(raw);
	if (keys.length > 256) throw new WireValueError(label);
	const out: Record<string, string | null> = {};
	for (const key of keys) {
		if (key.length === 0 || key.length > 512) throw new WireValueError(`${label}.${key}`);
		const entry = raw[key];
		if (entry === null) {
			out[key] = null;
		} else if (typeof entry === "string" && entry.length <= 512_000) {
			out[key] = entry;
		} else {
			throw new WireValueError(`${label}.${key}`);
		}
	}
	return out;
}

export function parseSurfaceChangeUnit(value: unknown, label = "change"): SurfaceChangeUnit {
	const raw = parseRecord(value, label);
	if (typeof raw.canUndo !== "boolean") throw new WireValueError(`${label}.canUndo`);
	let diffStats: SurfaceChangeDiffStats | null = null;
	if (raw.diffStats !== null && raw.diffStats !== undefined) {
		const stats = parseRecord(raw.diffStats, `${label}.diffStats`);
		diffStats = {
			filesChanged: parseInteger(stats.filesChanged, `${label}.diffStats.filesChanged`, 0, 100_000),
			additions: parseInteger(stats.additions, `${label}.diffStats.additions`, 0, 10_000_000),
			deletions: parseInteger(stats.deletions, `${label}.diffStats.deletions`, 0, 10_000_000),
		};
	}
	const patchManifest =
		raw.patchManifest === undefined
			? undefined
			: raw.patchManifest === null
				? null
				: Array.isArray(raw.patchManifest)
					? parseStudioPatchOps(raw.patchManifest, `${label}.patchManifest`)
					: null;
	const baseFiles = parseOptionalBaseFiles(raw.baseFiles, `${label}.baseFiles`);
	const previewBaseChangeIds =
		raw.previewBaseChangeIds === undefined || raw.previewBaseChangeIds === null
			? undefined
			: parseUuidArray(raw.previewBaseChangeIds, `${label}.previewBaseChangeIds`, 64);
	const publishedAt =
		raw.publishedAt === undefined ? undefined : parseOptionalTimestamp(raw.publishedAt, `${label}.publishedAt`);
	const approvedByUserId =
		raw.approvedByUserId === undefined
			? undefined
			: parseOptionalUuid(raw.approvedByUserId, `${label}.approvedByUserId`);
	const optionGroupKey =
		raw.optionGroupKey === undefined
			? undefined
			: raw.optionGroupKey === null
				? null
				: isSurfaceOptionGroupKey(raw.optionGroupKey)
					? raw.optionGroupKey
					: (() => {
							throw new WireValueError(`${label}.optionGroupKey`);
						})();
	const optionGroupTitle =
		raw.optionGroupTitle === undefined
			? undefined
			: parseOptionalText(raw.optionGroupTitle, `${label}.optionGroupTitle`, SURFACE_MAX_OPTION_GROUP_TITLE_CHARS);
	const supersedeKey =
		raw.supersedeKey === undefined
			? undefined
			: raw.supersedeKey === null
				? null
				: isSurfaceSupersedeKey(raw.supersedeKey)
					? raw.supersedeKey
					: (() => {
							throw new WireValueError(`${label}.supersedeKey`);
						})();
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		seq: parseInteger(raw.seq, `${label}.seq`, 1, 10_000),
		title: parseBoundedText(raw.title, `${label}.title`, SURFACE_MAX_CHANGE_TITLE_CHARS),
		summary: parseBoundedText(raw.summary, `${label}.summary`, SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0),
		kind: parseEnum(raw.kind, SURFACE_CHANGE_KINDS, `${label}.kind`),
		status: parseEnum(raw.status, SURFACE_CHANGE_STATUSES, `${label}.status`),
		...(optionGroupKey !== undefined ? { optionGroupKey } : {}),
		...(optionGroupTitle !== undefined ? { optionGroupTitle } : {}),
		...(supersedeKey !== undefined ? { supersedeKey } : {}),
		parentSha: parseOptionalText(raw.parentSha, `${label}.parentSha`, 64),
		headSha: parseOptionalText(raw.headSha, `${label}.headSha`, 64),
		dependsOnChangeIds: parseUuidArray(raw.dependsOnChangeIds ?? [], `${label}.dependsOnChangeIds`, 64),
		...(previewBaseChangeIds !== undefined ? { previewBaseChangeIds } : {}),
		affectedPaths: parseStringArray(raw.affectedPaths ?? [], `${label}.affectedPaths`, 500, 512),
		...(patchManifest !== undefined ? { patchManifest } : {}),
		...(baseFiles !== undefined ? { baseFiles } : {}),
		diffStats,
		conflictPaths:
			raw.conflictPaths === null || raw.conflictPaths === undefined
				? null
				: parseStringArray(raw.conflictPaths, `${label}.conflictPaths`, 500, 512),
		landedChangeNumber:
			raw.landedChangeNumber === null || raw.landedChangeNumber === undefined
				? null
				: parseInteger(raw.landedChangeNumber, `${label}.landedChangeNumber`, 1, 10_000_000),
		canUndo: raw.canUndo,
		...(raw.undoBatchSize !== undefined && raw.undoBatchSize !== null
			? { undoBatchSize: parseInteger(raw.undoBatchSize, `${label}.undoBatchSize`, 1, 10_000) }
			: {}),
		...(publishedAt !== undefined ? { publishedAt } : {}),
		...(approvedByUserId !== undefined ? { approvedByUserId } : {}),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		resolvedAt: parseOptionalTimestamp(raw.resolvedAt, `${label}.resolvedAt`),
	};
}

export function parseSurfaceSessionMessage(value: unknown, label = "message"): SurfaceSessionMessage {
	const raw = parseRecord(value, label);
	const authorUserId =
		raw.authorUserId === undefined ? undefined : parseOptionalUuid(raw.authorUserId, `${label}.authorUserId`);
	const authorLabel =
		raw.authorLabel === undefined ? undefined : parseOptionalText(raw.authorLabel, `${label}.authorLabel`, 120);
	const noteTo =
		raw.noteTo === undefined || raw.noteTo === null ? undefined : parseUuidArray(raw.noteTo, `${label}.noteTo`, 16);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		authorKind: parseEnum(raw.authorKind, SURFACE_SESSION_MESSAGE_AUTHORS, `${label}.authorKind`),
		...(authorUserId !== undefined ? { authorUserId } : {}),
		...(authorLabel !== undefined ? { authorLabel } : {}),
		text: parseBoundedText(raw.text, `${label}.text`, SURFACE_MAX_PROMPT_CHARS, 0),
		changeId: parseOptionalUuid(raw.changeId, `${label}.changeId`),
		...(noteTo !== undefined ? { noteTo } : {}),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
	};
}

export function parseSurfaceUnseenNotes(value: unknown, label = "unseenNotes"): SurfaceUnseenNote[] {
	if (!Array.isArray(value)) throw new WireValueError(label);
	return value.map((item, index) => {
		const raw = parseRecord(item, `${label}[${index}]`);
		return {
			surfaceId: parseUuid(raw.surfaceId, `${label}[${index}].surfaceId`),
			sessionId: parseUuid(raw.sessionId, `${label}[${index}].sessionId`),
			count: parseInteger(raw.count, `${label}[${index}].count`, 1, 10_000),
		};
	});
}

export function parseSurfaceSession(value: unknown, label = "session"): SurfaceSession {
	const raw = parseRecord(value, label);
	if (typeof raw.hasActiveChat !== "boolean") throw new WireValueError(`${label}.hasActiveChat`);
	if (!Array.isArray(raw.changes)) throw new WireValueError(`${label}.changes`);
	const changes = raw.changes.map((item, index) => parseSurfaceChangeUnit(item, `${label}.changes[${index}]`));
	const rawMessages = raw.messages === undefined || raw.messages === null ? [] : raw.messages;
	if (!Array.isArray(rawMessages)) throw new WireValueError(`${label}.messages`);
	const messages = rawMessages.map((item, index) => parseSurfaceSessionMessage(item, `${label}.messages[${index}]`));
	let question: SurfaceSessionQuestion | null = null;
	if (raw.question !== null && raw.question !== undefined) {
		const q = parseRecord(raw.question, `${label}.question`);
		question = {
			text: parseBoundedText(q.text, `${label}.question.text`, 4000),
			options: parseStringArray(q.options ?? [], `${label}.question.options`, 12, 240),
		};
	}
	const createdByUserId =
		raw.createdByUserId === undefined
			? undefined
			: parseOptionalUuid(raw.createdByUserId, `${label}.createdByUserId`);
	const turnRequestedByUserId =
		raw.turnRequestedByUserId === undefined
			? undefined
			: parseOptionalUuid(raw.turnRequestedByUserId, `${label}.turnRequestedByUserId`);
	const notePaths =
		raw.notePaths === undefined || raw.notePaths === null
			? undefined
			: parseStringArray(raw.notePaths, `${label}.notePaths`, 64, 512);
	const branchHeadSha =
		raw.branchHeadSha === undefined ? undefined : parseOptionalText(raw.branchHeadSha, `${label}.branchHeadSha`, 64);
	const supersedeKey =
		raw.supersedeKey === undefined
			? undefined
			: raw.supersedeKey === null
				? null
				: isSurfaceSupersedeKey(raw.supersedeKey)
					? raw.supersedeKey
					: (() => {
							throw new WireValueError(`${label}.supersedeKey`);
						})();
	return {
		id: parseUuid(raw.id, `${label}.id`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		workerId: parseOptionalUuid(raw.workerId, `${label}.workerId`),
		title: parseBoundedText(raw.title, `${label}.title`, 160),
		prompt: parseBoundedText(raw.prompt, `${label}.prompt`, SURFACE_MAX_PROMPT_CHARS, 0),
		state: parseEnum(raw.state, SURFACE_SESSION_STATES, `${label}.state`),
		originKind: parseEnum(raw.originKind, SURFACE_SESSION_ORIGIN_KINDS, `${label}.originKind`),
		originLabel: parseOptionalText(raw.originLabel, `${label}.originLabel`, 160),
		...(createdByUserId !== undefined ? { createdByUserId } : {}),
		...(turnRequestedByUserId !== undefined ? { turnRequestedByUserId } : {}),
		explorationId: parseOptionalUuid(raw.explorationId, `${label}.explorationId`),
		explorationVariantLabel: parseOptionalText(raw.explorationVariantLabel, `${label}.explorationVariantLabel`, 80),
		...(supersedeKey !== undefined ? { supersedeKey } : {}),
		...(branchHeadSha !== undefined ? { branchHeadSha } : {}),
		hasActiveChat: raw.hasActiveChat,
		question,
		...(notePaths !== undefined ? { notePaths } : {}),
		changes,
		messages,
		openChangeCount: parseInteger(
			raw.openChangeCount ?? countOpenSurfaceChanges(changes),
			`${label}.openChangeCount`,
			0,
			10_000,
		),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		updatedAt: parseTimestamp(raw.updatedAt, `${label}.updatedAt`).text,
		closedAt: parseOptionalTimestamp(raw.closedAt, `${label}.closedAt`),
	};
}

function parseSurfaceImageRef(value: unknown, label: string): SurfaceImageRef {
	const raw = parseClosedRecord(value, label, ["sha256", "bytes", "mediaType"]);
	return {
		sha256: parseSha256Hex(raw.sha256, `${label}.sha256`),
		bytes: parseInteger(raw.bytes, `${label}.bytes`, 1, SURFACE_IMAGE_MAX_TOTAL_BYTES),
		mediaType: parseEnum(raw.mediaType, SURFACE_IMAGE_MEDIA_TYPES, `${label}.mediaType`),
	};
}

export function parseSurfaceSessionImages(value: unknown): SurfaceSessionImages {
	const label = "sessionImages";
	const raw = parseClosedRecord(value, label, ["schema", "sessionId", "messages"]);
	if (raw.schema !== SURFACE_SESSION_IMAGES_SCHEMA) throw new WireValueError(`${label}.schema`);
	if (!Array.isArray(raw.messages) || raw.messages.length > 10_000) throw new WireValueError(`${label}.messages`);
	return {
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		messages: raw.messages.map((item, index) => {
			const at = `${label}.messages[${index}]`;
			const message = parseClosedRecord(item, at, ["messageId", "clientInputId", "images"]);
			if (
				!Array.isArray(message.images) ||
				message.images.length < 1 ||
				message.images.length > SURFACE_IMAGE_MAX_COUNT
			)
				throw new WireValueError(`${at}.images`);
			return {
				messageId: parseUuid(message.messageId, `${at}.messageId`),
				clientInputId: parseUuid(message.clientInputId, `${at}.clientInputId`),
				images: message.images.map((image, slot) => parseSurfaceImageRef(image, `${at}.images[${slot}]`)),
			};
		}),
	};
}

export function parseSurfaceExplorationSet(value: unknown, label = "exploration"): SurfaceExplorationSet {
	const raw = parseRecord(value, label);
	const ownerLabel =
		raw.ownerLabel === undefined ? undefined : parseOptionalText(raw.ownerLabel, `${label}.ownerLabel`, 160);
	const notePaths =
		raw.notePaths === undefined || raw.notePaths === null
			? undefined
			: parseStringArray(raw.notePaths, `${label}.notePaths`, 64, 512);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		title: parseBoundedText(raw.title, `${label}.title`, 160),
		status: parseEnum(raw.status, SURFACE_EXPLORATION_STATUSES, `${label}.status`),
		...(ownerLabel !== undefined ? { ownerLabel } : {}),
		...(notePaths !== undefined ? { notePaths } : {}),
		chosenSessionId: parseOptionalUuid(raw.chosenSessionId, `${label}.chosenSessionId`),
		variantSessionIds: parseUuidArray(raw.variantSessionIds ?? [], `${label}.variantSessionIds`, 8),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		resolvedAt: parseOptionalTimestamp(raw.resolvedAt, `${label}.resolvedAt`),
	};
}

export function parseSurfacePreviewFrameState(value: unknown, label = "previewFrame"): SurfacePreviewFrameState {
	const raw = parseRecord(value, label);
	let conflictReport: SurfacePreviewConflict | null = null;
	if (raw.conflictReport !== null && raw.conflictReport !== undefined) {
		const conflict = parseRecord(raw.conflictReport, `${label}.conflictReport`);
		conflictReport = {
			changeIds: parseUuidArray(conflict.changeIds ?? [], `${label}.conflictReport.changeIds`, 64),
			paths: parseStringArray(conflict.paths ?? [], `${label}.conflictReport.paths`, 200, 512),
		};
	}
	let kept: SurfacePreviewKeptFrame | null | undefined;
	if (raw.kept === null) kept = null;
	else if (raw.kept !== undefined) {
		const frame = parseRecord(raw.kept, `${label}.kept`);
		kept = {
			previewId: parseUuid(frame.previewId, `${label}.kept.previewId`),
			doorActionUrl: parseOptionalText(frame.doorActionUrl, `${label}.kept.doorActionUrl`, 512),
			memberPass: parseOptionalText(frame.memberPass, `${label}.kept.memberPass`, 128),
		};
	}
	const fixing = parseOptionalFlag(raw.fixing, `${label}.fixing`);
	return {
		previewId: parseOptionalUuid(raw.previewId, `${label}.previewId`),
		status: parseEnum(raw.status, SURFACE_PREVIEW_STATUSES, `${label}.status`),
		doorActionUrl: parseOptionalText(raw.doorActionUrl, `${label}.doorActionUrl`, 512),
		memberPass: parseOptionalText(raw.memberPass, `${label}.memberPass`, 128),
		activeRoute: parseBoundedText(raw.activeRoute ?? "/", `${label}.activeRoute`, 512),
		toggledChangeIds: parseUuidArray(raw.toggledChangeIds ?? [], `${label}.toggledChangeIds`, 128),
		conflictReport,
		errorDetail: parseOptionalText(raw.errorDetail, `${label}.errorDetail`, 1000),
		...(kept !== undefined ? { kept } : {}),
		...(fixing !== undefined ? { fixing } : {}),
	};
}

export function parseSurfacePreviewCompositionState(
	value: unknown,
	label = "previewState",
): SurfacePreviewCompositionState {
	const raw = parseRecord(value, label);
	const mode = parseEnum(raw.mode, ["single", "compare"] as const, `${label}.mode`);
	if (!Array.isArray(raw.compareFrames) || raw.compareFrames.length > SURFACE_MAX_COMPARE_VARIANTS) {
		throw new WireValueError(`${label}.compareFrames`);
	}
	return {
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		mode,
		primary: parseSurfacePreviewFrameState(raw.primary, `${label}.primary`),
		compareFrames: raw.compareFrames.map((item, index) => {
			const entry = parseRecord(item, `${label}.compareFrames[${index}]`);
			return {
				sessionId: parseUuid(entry.sessionId, `${label}.compareFrames[${index}].sessionId`),
				label: parseBoundedText(entry.label, `${label}.compareFrames[${index}].label`, 80),
				frame: parseSurfacePreviewFrameState(entry.frame, `${label}.compareFrames[${index}].frame`),
			};
		}),
	};
}

export function parseSurfaceReconciliation(value: unknown, label = "reconciliation"): SurfaceReconciliation {
	const raw = parseRecord(value, label);
	const patchManifest =
		raw.patchManifest === null || raw.patchManifest === undefined
			? null
			: Array.isArray(raw.patchManifest)
				? parseStudioPatchOps(raw.patchManifest, `${label}.patchManifest`)
				: null;
	const conflictPaths =
		raw.conflictPaths === undefined || raw.conflictPaths === null
			? undefined
			: parseStringArray(raw.conflictPaths, `${label}.conflictPaths`, 500, 512);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		compositionKey: parseBoundedText(raw.compositionKey, `${label}.compositionKey`, 128),
		baseFingerprint: parseBoundedText(raw.baseFingerprint, `${label}.baseFingerprint`, 128),
		selectedChangeIds: parseUuidArray(raw.selectedChangeIds ?? [], `${label}.selectedChangeIds`, 128),
		status: parseEnum(raw.status, SURFACE_RECONCILIATION_STATUSES, `${label}.status`),
		patchManifest,
		...(conflictPaths !== undefined ? { conflictPaths } : {}),
		commitSha: parseOptionalText(raw.commitSha, `${label}.commitSha`, 64),
		treeSha: parseOptionalText(raw.treeSha, `${label}.treeSha`, 64),
		errorDetail: parseOptionalText(raw.errorDetail, `${label}.errorDetail`, 1000),
		updatedAt: parseTimestamp(raw.updatedAt, `${label}.updatedAt`).text,
	};
}

export function parseSurfaceWorkspace(value: unknown, label = "workspace"): SurfaceWorkspace {
	const raw = parseRecord(value, label);
	if (!Array.isArray(raw.activeSessions)) throw new WireValueError(`${label}.activeSessions`);
	if (!Array.isArray(raw.recentHistory)) throw new WireValueError(`${label}.recentHistory`);
	if (!Array.isArray(raw.explorations)) throw new WireValueError(`${label}.explorations`);
	let reconciliations: SurfaceReconciliation[] | undefined;
	if (raw.reconciliations !== undefined && raw.reconciliations !== null) {
		if (!Array.isArray(raw.reconciliations)) throw new WireValueError(`${label}.reconciliations`);
		reconciliations = raw.reconciliations.map((item, index) =>
			parseSurfaceReconciliation(item, `${label}.reconciliations[${index}]`),
		);
	}
	return {
		surface: parseSurfaceSummary(raw.surface, `${label}.surface`),
		briefSummary: parseOptionalText(raw.briefSummary, `${label}.briefSummary`, 4000),
		activeSessions: raw.activeSessions.map((item, index) =>
			parseSurfaceSession(item, `${label}.activeSessions[${index}]`),
		),
		recentHistory: raw.recentHistory.map((item, index) =>
			parseSurfaceSession(item, `${label}.recentHistory[${index}]`),
		),
		explorations: raw.explorations.map((item, index) =>
			parseSurfaceExplorationSet(item, `${label}.explorations[${index}]`),
		),
		previewState: parseSurfacePreviewCompositionState(raw.previewState, `${label}.previewState`),
		...(reconciliations !== undefined ? { reconciliations } : {}),
	};
}

export function parsePointToChangeTarget(value: unknown, label = "target"): PointToChangeTarget {
	const raw = parseRecord(value, label);
	const box = parseRecord(raw.boundingBox, `${label}.boundingBox`);
	const viewport = parseRecord(raw.viewport, `${label}.viewport`);
	const num = (v: unknown, field: string) => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < -100_000 || v > 100_000) {
			throw new WireValueError(field);
		}
		return v;
	};
	return {
		route: parseBoundedText(raw.route, `${label}.route`, 512),
		selector: parseBoundedText(raw.selector, `${label}.selector`, 512),
		textSnippet: parseBoundedText(raw.textSnippet ?? "", `${label}.textSnippet`, 240, 0),
		tagName: parseBoundedText(raw.tagName, `${label}.tagName`, 40),
		componentHint: parseOptionalText(raw.componentHint, `${label}.componentHint`, 160),
		boundingBox: {
			x: num(box.x, `${label}.boundingBox.x`),
			y: num(box.y, `${label}.boundingBox.y`),
			width: num(box.width, `${label}.boundingBox.width`),
			height: num(box.height, `${label}.boundingBox.height`),
		},
		viewport: {
			width: parseInteger(
				Math.round(num(viewport.width, `${label}.viewport.width`)),
				`${label}.viewport.width`,
				1,
				20_000,
			),
			height: parseInteger(
				Math.round(num(viewport.height, `${label}.viewport.height`)),
				`${label}.viewport.height`,
				1,
				20_000,
			),
		},
	};
}

export function parseSurfaceAutomationSummary(value: unknown, label = "automation"): SurfaceAutomationSummary {
	const raw = parseRecord(value, label);
	if (typeof raw.enabled !== "boolean") throw new WireValueError(`${label}.enabled`);
	if (typeof raw.ownable !== "boolean") throw new WireValueError(`${label}.ownable`);
	const prompt =
		raw.prompt === undefined ? undefined : parseOptionalText(raw.prompt, `${label}.prompt`, SURFACE_MAX_PROMPT_CHARS);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		key: parseBoundedText(raw.key, `${label}.key`, 80),
		title: parseBoundedText(raw.title, `${label}.title`, 120),
		...(prompt !== undefined ? { prompt } : {}),
		scheduleSummary: parseBoundedText(raw.scheduleSummary, `${label}.scheduleSummary`, 160),
		targetSurfaceSlug:
			raw.targetSurfaceSlug === null || raw.targetSurfaceSlug === undefined
				? null
				: parseSurfaceSlug(raw.targetSurfaceSlug, `${label}.targetSurfaceSlug`),
		outputMode: parseEnum(raw.outputMode, SURFACE_AUTOMATION_OUTPUT_MODES, `${label}.outputMode`),
		enabled: raw.enabled,
		status: parseEnum(raw.status, SURFACE_AUTOMATION_STATUSES, `${label}.status`),
		lastRunAt: parseOptionalTimestamp(raw.lastRunAt, `${label}.lastRunAt`),
		lastOutcomeSummary: parseOptionalText(raw.lastOutcomeSummary, `${label}.lastOutcomeSummary`, 500),
		nextRunAt: parseOptionalTimestamp(raw.nextRunAt, `${label}.nextRunAt`),
		ownable: raw.ownable,
		ownerUserId: parseOptionalUuid(raw.ownerUserId, `${label}.ownerUserId`),
		offer:
			raw.offer === null || raw.offer === undefined
				? null
				: parseSurfaceAutomationOffer(raw.offer, `${label}.offer`),
	};
}

function parseSurfaceAutomationOffer(value: unknown, label: string): SurfaceAutomationOffer {
	const raw = parseRecord(value, label);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		fromUserId: parseOptionalUuid(raw.fromUserId, `${label}.fromUserId`),
		toUserId: parseOptionalUuid(raw.toUserId, `${label}.toUserId`),
		offeredByUserId: parseOptionalUuid(raw.offeredByUserId, `${label}.offeredByUserId`),
		status: parseEnum(raw.status, SURFACE_AUTOMATION_OFFER_STATUSES, `${label}.status`),
		answeredAt: parseOptionalTimestamp(raw.answeredAt, `${label}.answeredAt`),
	};
}

export function parseSurfaceMigrationChecklist(
	value: unknown,
	label = "migrationChecklist",
): SurfaceMigrationChecklist {
	const raw = parseRecord(value, label);
	if (typeof raw.alreadyMigrated !== "boolean") throw new WireValueError(`${label}.alreadyMigrated`);
	if (!Array.isArray(raw.proposedSurfaces)) throw new WireValueError(`${label}.proposedSurfaces`);
	if (!Array.isArray(raw.specialistAgents)) throw new WireValueError(`${label}.specialistAgents`);
	if (!Array.isArray(raw.legacyBoards)) throw new WireValueError(`${label}.legacyBoards`);
	return {
		companyId: parseUuid(raw.companyId, `${label}.companyId`),
		alreadyMigrated: raw.alreadyMigrated,
		proposedSurfaces: raw.proposedSurfaces.map((item, index) => {
			const entry = parseRecord(item, `${label}.proposedSurfaces[${index}]`);
			return {
				slug: parseSurfaceSlug(entry.slug, `${label}.proposedSurfaces[${index}].slug`),
				title: parseBoundedText(entry.title, `${label}.proposedSurfaces[${index}].title`, SURFACE_MAX_TITLE_CHARS),
				group: parseEnum(entry.group, SURFACE_GROUPS, `${label}.proposedSurfaces[${index}].group`),
				archetype: parseEnum(entry.archetype, SURFACE_ARCHETYPES, `${label}.proposedSurfaces[${index}].archetype`),
				sourceKind: parseEnum(
					entry.sourceKind,
					SURFACE_SOURCE_KINDS,
					`${label}.proposedSurfaces[${index}].sourceKind`,
				),
				sourceRef: parseOptionalText(entry.sourceRef, `${label}.proposedSurfaces[${index}].sourceRef`, 256),
			};
		}),
		specialistAgents: raw.specialistAgents.map((item, index) => {
			const entry = parseRecord(item, `${label}.specialistAgents[${index}]`);
			return {
				agentId: parseUuid(entry.agentId, `${label}.specialistAgents[${index}].agentId`),
				handle: parseBoundedText(entry.handle, `${label}.specialistAgents[${index}].handle`, 80),
				name: parseBoundedText(entry.name, `${label}.specialistAgents[${index}].name`, 120),
				role: parseBoundedText(entry.role ?? "", `${label}.specialistAgents[${index}].role`, 160, 0),
				routineCount: parseInteger(
					entry.routineCount ?? 0,
					`${label}.specialistAgents[${index}].routineCount`,
					0,
					1000,
				),
				recommendedAction: parseEnum(
					entry.recommendedAction,
					["fold_to_automation", "fold_to_surface_brief", "archive_readonly"] as const,
					`${label}.specialistAgents[${index}].recommendedAction`,
				),
				recommendedTargetSurfaceSlug:
					entry.recommendedTargetSurfaceSlug === null || entry.recommendedTargetSurfaceSlug === undefined
						? null
						: parseSurfaceSlug(entry.recommendedTargetSurfaceSlug, `${label}.specialistAgents[${index}].target`),
			};
		}),
		legacyBoards: raw.legacyBoards.map((item, index) => {
			const entry = parseRecord(item, `${label}.legacyBoards[${index}]`);
			return {
				appName: parseBoundedText(entry.appName, `${label}.legacyBoards[${index}].appName`, 80),
				title: parseBoundedText(entry.title, `${label}.legacyBoards[${index}].title`, 120),
				kit: parseOptionalText(entry.kit, `${label}.legacyBoards[${index}].kit`, 40),
				recommendedAction: parseEnum(
					entry.recommendedAction,
					["promote_surface", "archive_to_files"] as const,
					`${label}.legacyBoards[${index}].recommendedAction`,
				),
				recommendedSurfaceSlug:
					entry.recommendedSurfaceSlug === null || entry.recommendedSurfaceSlug === undefined
						? null
						: parseSurfaceSlug(entry.recommendedSurfaceSlug, `${label}.legacyBoards[${index}].surfaceSlug`),
			};
		}),
	};
}

export function normalizeStudioFolderRoot(folderRoot: string | null | undefined): string {
	const cleaned = (folderRoot ?? "").trim().replace(/^\/+|\/+$/g, "");
	if (
		!cleaned ||
		cleaned.includes("\\") ||
		cleaned.includes("\0") ||
		cleaned.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error("Surface folder root is invalid");
	}
	return cleaned;
}

export function resolveStudioFolderPath(folderRoot: string, rawPath: string): string {
	const normalized = rawPath.trim().replace(/^\/+|\/+$/g, "");
	if (!normalized || normalized.includes("\\") || normalized.includes("\0")) {
		throw new Error(`Invalid studio patch path: ${rawPath}`);
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`Unsafe studio patch path: ${rawPath}`);
	}
	const prefixed =
		normalized === folderRoot || normalized.startsWith(`${folderRoot}/`) ? normalized : `${folderRoot}/${normalized}`;
	if (!prefixed.startsWith(`${folderRoot}/`)) {
		throw new Error(`Patch path escapes surface folder root: ${rawPath}`);
	}
	return prefixed;
}

export function surfaceCompanyPath(folderRoot: string, bindingPath: string): string {
	const rooted = bindingPath.startsWith("/");
	const body = rooted ? bindingPath.slice(1) : bindingPath;
	if (
		!body ||
		body.includes("\\") ||
		body.includes("\0") ||
		body.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error(`Unsafe company file path: ${bindingPath}`);
	}
	return rooted ? body : `${normalizeStudioFolderRoot(folderRoot)}/${body}`;
}

export const SURFACE_APP_SECRET_SCOPES = ["build", "test", "runtime"] as const;
export type SurfaceAppSecretScope = (typeof SURFACE_APP_SECRET_SCOPES)[number];

export const SURFACE_APP_TARGET_ENVS = ["dev", "prod"] as const;
export type SurfaceAppTargetEnv = (typeof SURFACE_APP_TARGET_ENVS)[number];

export const SURFACE_DEPLOYMENT_KINDS = ["static", "server", "hybrid"] as const;
export type SurfaceDeploymentKind = (typeof SURFACE_DEPLOYMENT_KINDS)[number];

export const SURFACE_RUNTIME_ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SURFACE_LINKED_DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const SURFACE_RUNTIME_ENV_REFUSED_PREFIX = /^(LC|GIT|LD|DYLD|QORPERA|SSH|XDG|DOCKER|CLAUDE|CODEX)_/;
const SURFACE_RUNTIME_ENV_RESERVED = new Set([
	"HOME",
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
	"COLORTERM",
	"COLUMNS",
	"LINES",
	"LANG",
	"LANGUAGE",
	"TZ",
	"BASH_ENV",
	"ENV",
	"IFS",
	"PS1",
	"PS2",
	"PS4",
	"PROMPT_COMMAND",
	"SHELLOPTS",
	"BASHOPTS",
	"CDPATH",
	"GLOBIGNORE",
	"HOSTNAME",
	"SHLVL",
	"MAIL",
	"MAILPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"FTP_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"PORT",
	"NODE_ENV",
	"DATABASE_URL",
]);

export function isSurfaceRuntimeEnvKey(name: string): boolean {
	return (
		SURFACE_RUNTIME_ENV_KEY_PATTERN.test(name) &&
		!SURFACE_RUNTIME_ENV_REFUSED_PREFIX.test(name) &&
		!SURFACE_RUNTIME_ENV_RESERVED.has(name)
	);
}

export function isSurfaceLinkedDatabaseName(name: string): boolean {
	return (
		SURFACE_LINKED_DATABASE_NAME_PATTERN.test(name) &&
		name !== "qorpera" &&
		!name.startsWith("pg_") &&
		!name.startsWith("qorpera_")
	);
}

export interface SurfaceAppSecretGrantSummary {
	readonly grantId: string;
	readonly secretId: string;
	readonly siteId: string;
	readonly name: string;
	readonly scope: SurfaceAppSecretScope;
	readonly targetEnv: SurfaceAppTargetEnv;
	readonly version: number;
	readonly issuedByUserId: string;
	readonly createdAt: string;
}

export interface SurfaceAvailableSecretSummary {
	readonly secretId: string;
	readonly name: string;
	readonly purpose: string;
	readonly version: number;
}

export interface SurfaceAppRuntimeConfig {
	readonly surfaceId: string;
	readonly profileId: string;
	readonly siteId: string | null;
	readonly slug: string | null;
	readonly deploymentKind: SurfaceDeploymentKind | null;
	readonly runtimeEnvConfig: Readonly<Record<string, string>>;
	readonly linkedDatabaseName: string | null;
	readonly canManage: boolean;
	readonly grants: readonly SurfaceAppSecretGrantSummary[];
	readonly availableSecrets: readonly SurfaceAvailableSecretSummary[];
}

export function parseSurfaceAppRuntimeConfig(value: unknown, label = "runtimeConfig"): SurfaceAppRuntimeConfig {
	const raw = parseRecord(value, label);
	if (raw.schema !== undefined && raw.schema !== "qorpera.surface-app-runtime-config/v1") {
		throw new WireValueError(`${label}.schema`);
	}
	const envRaw = parseRecord(raw.runtimeEnvConfig ?? {}, `${label}.runtimeEnvConfig`);
	const runtimeEnvConfig: Record<string, string> = {};
	for (const [key, entry] of Object.entries(envRaw)) {
		if (!isSurfaceRuntimeEnvKey(key) || typeof entry !== "string" || entry.length > 4096) {
			throw new WireValueError(`${label}.runtimeEnvConfig.${key}`);
		}
		runtimeEnvConfig[key] = entry;
	}
	const linkedDatabaseName = parseOptionalText(raw.linkedDatabaseName, `${label}.linkedDatabaseName`, 40);
	if (linkedDatabaseName !== null && !isSurfaceLinkedDatabaseName(linkedDatabaseName)) {
		throw new WireValueError(`${label}.linkedDatabaseName`);
	}
	if (!Array.isArray(raw.grants)) throw new WireValueError(`${label}.grants`);
	const grants: SurfaceAppSecretGrantSummary[] = raw.grants.map((item, index) => {
		const entry = parseRecord(item, `${label}.grants[${index}]`);
		return {
			grantId: parseUuid(entry.grantId, `${label}.grants[${index}].grantId`),
			secretId: parseUuid(entry.secretId, `${label}.grants[${index}].secretId`),
			siteId: parseUuid(entry.siteId, `${label}.grants[${index}].siteId`),
			name: parseBoundedText(entry.name, `${label}.grants[${index}].name`, 64),
			scope: parseEnum(entry.scope, SURFACE_APP_SECRET_SCOPES, `${label}.grants[${index}].scope`),
			targetEnv: parseEnum(entry.targetEnv, SURFACE_APP_TARGET_ENVS, `${label}.grants[${index}].targetEnv`),
			version: parseInteger(entry.version, `${label}.grants[${index}].version`, 1, 1_000_000),
			issuedByUserId: parseUuid(entry.issuedByUserId, `${label}.grants[${index}].issuedByUserId`),
			createdAt: parseTimestamp(entry.createdAt, `${label}.grants[${index}].createdAt`).text,
		};
	});
	if (!Array.isArray(raw.availableSecrets)) throw new WireValueError(`${label}.availableSecrets`);
	const availableSecrets: SurfaceAvailableSecretSummary[] = raw.availableSecrets.map((item, index) => {
		const entry = parseRecord(item, `${label}.availableSecrets[${index}]`);
		return {
			secretId: parseUuid(entry.secretId, `${label}.availableSecrets[${index}].secretId`),
			name: parseBoundedText(entry.name, `${label}.availableSecrets[${index}].name`, 64),
			purpose: parseBoundedText(entry.purpose, `${label}.availableSecrets[${index}].purpose`, 512),
			version: parseInteger(entry.version, `${label}.availableSecrets[${index}].version`, 1, 1_000_000),
		};
	});
	const deploymentKind =
		raw.deploymentKind === null || raw.deploymentKind === undefined
			? null
			: parseEnum(raw.deploymentKind, SURFACE_DEPLOYMENT_KINDS, `${label}.deploymentKind`);
	return {
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		profileId: parseUuid(raw.profileId, `${label}.profileId`),
		siteId: parseOptionalUuid(raw.siteId, `${label}.siteId`),
		slug: parseOptionalText(raw.slug, `${label}.slug`, 64),
		deploymentKind,
		runtimeEnvConfig,
		linkedDatabaseName,
		canManage: raw.canManage === true,
		grants,
		availableSecrets,
	};
}

export type SurfaceLookKind = Exclude<SurfaceKind, "members">;

export interface SurfaceKindFacts {
	readonly slug: string;
	readonly icon: string;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind | null;
}

export function inferSurfaceKind(surface: Pick<SurfaceKindFacts, "slug" | "icon" | "archetype">): SurfaceLookKind {
	const { slug, icon } = surface;
	if (surface.archetype === "ops") {
		if (slug === "inbox" || slug === "mail" || icon === "mail") return "inbox";
		if (slug === "money" || slug === "bank" || icon === "coin" || icon === "bank") return "money";
		if (slug === "data" || slug === "databases" || icon === "database") return "data";
		if (slug === "files" || icon === "drawers") return "files";
		return "custom";
	}
	if (surface.archetype === "studio") {
		if (/identity|manifesto/.test(slug)) return "identity";
		if (icon === "book" || /report|journal|essay|analysis|blog|research|philosophy/.test(slug)) return "report";
		if (icon === "figure:lighthouse" || /(^|-)(strategy|plan|planning|war-room|roadmap|thesis)(-|$)/.test(slug))
			return "strategy";
		if (icon === "database" || /(^|-)(data|database|tables|crm)(-|$)/.test(slug)) return "database";
		if (icon === "box" || icon === "board" || /product|hardware|spec|headband/.test(slug)) return "product";
		if (icon === "spark" || /brand/.test(slug)) return "brand";
		if (/(^|-)(analytics|dashboard|kpis?|metrics|numbers)(-|$)/.test(slug)) return "dashboard";
		return "custom";
	}
	if (icon === "phone" || /mobile|ios|android/.test(slug)) return "mobile_app";
	if (icon === "window" || /desktop/.test(slug)) return "desktop_app";
	if (icon === "chart" || /dashboard|finance|kpi|metrics/.test(slug)) return "dashboard";
	if (icon === "spark" || /(^|-)(app|portal)(-|$)/.test(slug)) return "web_app";
	if (!icon || icon === "globe" || icon === "page") return "website";
	return "custom";
}

export function surfaceLookKind(surface: SurfaceKindFacts): SurfaceLookKind {
	return surface.kind && surface.kind !== "custom" && surface.kind !== "members"
		? surface.kind
		: inferSurfaceKind(surface);
}

export type SurfacePageKind = "layout" | "report";

export function surfacePageKind(surface: {
	readonly archetype: SurfaceArchetype;
	readonly lookKind: SurfaceLookKind;
}): SurfacePageKind | null {
	if (surface.archetype !== "studio") return null;
	return surface.lookKind === "report" ? "report" : "layout";
}

export interface SurfaceStarterFacts {
	readonly lookKind: SurfaceLookKind;
	readonly slug: string;
	readonly isGlobal: boolean;
	readonly paths: readonly string[];
	readonly hasModel: boolean;
}

export function surfaceStarterKind(facts: SurfaceStarterFacts): SurfaceStarterKind {
	if (
		facts.isGlobal ||
		facts.lookKind === "identity" ||
		facts.slug === "identity" ||
		facts.paths.some((path) => path.startsWith("identity/"))
	) {
		return "identity";
	}
	if (facts.lookKind === "strategy" || facts.slug === "strategy") return "strategy";
	if (facts.lookKind === "dashboard" || facts.slug === "analytics") return "analytics";
	return facts.lookKind === "product" || facts.hasModel ? "product" : "custom";
}

export const SURFACE_MODEL_GROUPS = ["model", "3d", "geometry"] as const;

export function surfaceLegacyModelKey(value: Readonly<Record<string, unknown>>): string | undefined {
	return Object.keys(value).find((name) => (SURFACE_MODEL_GROUPS as readonly string[]).includes(name.toLowerCase()));
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function surfaceFilesHaveModel(
	files: Readonly<Record<string, string>>,
	binaryPaths: readonly string[],
): boolean {
	if (binaryPaths.some((path) => /\.glb$/i.test(path))) return true;
	for (const path of Object.keys(files).sort()) {
		if (/(?:^|\/)object\.json$/i.test(path) || /\.report\.json$/i.test(path) || !path.toLowerCase().endsWith(".json"))
			continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(files[path] ?? "");
		} catch {
			continue;
		}
		if (!isPlainJsonObject(parsed)) continue;
		const key = surfaceLegacyModelKey(parsed);
		if (key !== undefined) return isPlainJsonObject(parsed[key]);
	}
	return false;
}

export interface SurfaceStudioFacts {
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind | null;
	readonly slug: string;
	readonly icon: string;
	readonly isGlobal: boolean;
	readonly paths: readonly string[];
	readonly hasModel: boolean;
}

export type SurfaceStudioPage =
	| { readonly page: "layout"; readonly starter: SurfaceStarterKind }
	| { readonly page: "report" }
	| { readonly page: null };

export function surfaceStudioPage(facts: SurfaceStudioFacts): SurfaceStudioPage {
	const lookKind = surfaceLookKind(facts);
	const page = surfacePageKind({ archetype: facts.archetype, lookKind });
	if (page !== "layout") return { page };
	return { page, starter: surfaceStarterKind({ ...facts, lookKind }) };
}

const SURFACE_STUDIO_ICONS_THAT_DECIDE = ["", "book", "database", "box", "board", "spark", "figure:lighthouse"];

export function surfaceStudioPageWhenKnown(
	facts: Omit<SurfaceStudioFacts, "icon" | "isGlobal"> & {
		readonly icon?: string | null;
		readonly isGlobal?: boolean | null;
		readonly hasOwnLayout: boolean;
	},
): SurfaceStudioPage | undefined {
	const icons = typeof facts.icon === "string" ? [facts.icon] : SURFACE_STUDIO_ICONS_THAT_DECIDE;
	const globals = typeof facts.isGlobal === "boolean" ? [facts.isGlobal] : [false, true];
	let known: SurfaceStudioPage | undefined;
	for (const icon of icons) {
		for (const isGlobal of globals) {
			const page = surfaceStudioPage({ ...facts, icon, isGlobal });
			if (!known) {
				known = page;
				continue;
			}
			if (known.page !== page.page) return undefined;
			if (known.page === "layout" && page.page === "layout" && !facts.hasOwnLayout && known.starter !== page.starter)
				return undefined;
		}
	}
	return known;
}
