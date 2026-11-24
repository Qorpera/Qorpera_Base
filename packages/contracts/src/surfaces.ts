import {
	isUuid,
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
export const SURFACE_ORDER_SCHEMA_VERSION = "qorpera.surface-order/v1";
export const AUTOMATION_SCHEMA_VERSION = "qorpera.automation/v1";

export const SURFACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SURFACE_MAX_TITLE_CHARS = 80;
export const SURFACE_MAX_PROMPT_CHARS = 16_000;
export const SURFACE_MAX_CHANGE_TITLE_CHARS = 160;
export const SURFACE_MAX_CHANGE_SUMMARY_CHARS = 2_000;
export const SURFACE_MAX_COMPARE_VARIANTS = 3;
// WHY: Each coding VM stays responsive around 6 concurrent turns; overflow spins up another machine rather than capping total sessions.
export const SURFACE_DEFAULT_MACHINE_TURN_DENSITY = 6;

export const SURFACE_GROUPS = ["products", "operations"] as const;
export type SurfaceGroup = (typeof SURFACE_GROUPS)[number];

export const SURFACE_ARCHETYPES = ["live_build", "studio", "ops"] as const;
export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

export const SURFACE_KINDS = [
	"identity",
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

export const SURFACE_SESSION_MESSAGE_AUTHORS = ["member", "session", "system", "note"] as const;
export type SurfaceSessionMessageAuthor = (typeof SURFACE_SESSION_MESSAGE_AUTHORS)[number];

export const SURFACE_INSPECTOR_MODE_MESSAGE = "qorpera-inspector-mode";
export const SURFACE_INSPECTOR_PICK_MESSAGE = "qorpera-inspector-pick";
export const SURFACE_SITE_DOOR_ACTION_PATTERN =
	/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*(?:--p[a-z0-9]{8})?\.qorpera\.com\/__qorpera\/member$/;

export interface SurfaceSessionMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly authorKind: SurfaceSessionMessageAuthor;
	readonly authorUserId?: string | null;
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

export interface SurfacePreviewFrameState {
	readonly previewId: string | null;
	readonly status: SurfacePreviewStatus;
	readonly doorActionUrl: string | null;
	readonly memberPass: string | null;
	readonly activeRoute: string;
	readonly toggledChangeIds: readonly string[];
	readonly conflictReport: SurfacePreviewConflict | null;
	readonly errorDetail: string | null;
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

export function isSurfaceSlug(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 64 && SURFACE_SLUG_PATTERN.test(value);
}

export function parseSurfaceSlug(value: unknown, label = "surface.slug"): string {
	if (!isSurfaceSlug(value)) throw new WireValueError(label);
	return value;
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
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		seq: parseInteger(raw.seq, `${label}.seq`, 1, 10_000),
		title: parseBoundedText(raw.title, `${label}.title`, SURFACE_MAX_CHANGE_TITLE_CHARS),
		summary: parseBoundedText(raw.summary, `${label}.summary`, SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0),
		kind: parseEnum(raw.kind, SURFACE_CHANGE_KINDS, `${label}.kind`),
		status: parseEnum(raw.status, SURFACE_CHANGE_STATUSES, `${label}.status`),
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
	const noteTo =
		raw.noteTo === undefined || raw.noteTo === null ? undefined : parseUuidArray(raw.noteTo, `${label}.noteTo`, 16);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		authorKind: parseEnum(raw.authorKind, SURFACE_SESSION_MESSAGE_AUTHORS, `${label}.authorKind`),
		...(authorUserId !== undefined ? { authorUserId } : {}),
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
	return {
		previewId: parseOptionalUuid(raw.previewId, `${label}.previewId`),
		status: parseEnum(raw.status, SURFACE_PREVIEW_STATUSES, `${label}.status`),
		doorActionUrl: parseOptionalText(raw.doorActionUrl, `${label}.doorActionUrl`, 512),
		memberPass: parseOptionalText(raw.memberPass, `${label}.memberPass`, 128),
		activeRoute: parseBoundedText(raw.activeRoute ?? "/", `${label}.activeRoute`, 512),
		toggledChangeIds: parseUuidArray(raw.toggledChangeIds ?? [], `${label}.toggledChangeIds`, 128),
		conflictReport,
		errorDetail: parseOptionalText(raw.errorDetail, `${label}.errorDetail`, 1000),
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

export function isValidSurfaceId(value: unknown): value is string {
	return isUuid(value);
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
