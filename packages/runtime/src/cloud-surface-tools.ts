import {
	isSurfaceDefaultBranch,
	isSurfaceOptionGroupKey,
	isSurfaceRepositoryKey,
	isSurfaceRepositorySubpath,
	isSurfaceSlug,
	isSurfaceSupersedeKey,
	isUuid,
	type JsonValue,
	normalizeSurfaceRepositorySubpath,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseStudioPatchOps,
	parseSurfaceBinding,
	parseSurfaceLayoutText,
	parseSurfaceReportEvidence,
	parseSurfaceSessionArtifact,
	parseSurfaceSessionChecksSummary,
	parseSurfaceSessionProgressStep,
	parseSurfaceSlug,
	parseUuid,
	readSurfaceLayout,
	readSurfaceTalk,
	resolveStudioFolderPath,
	type StudioPatchOp,
	SURFACE_ARCHETYPES,
	SURFACE_AUTOMATION_STATUSES,
	SURFACE_CHECKS_STATUSES,
	SURFACE_FIGURES,
	SURFACE_GROUPS,
	SURFACE_IMAGE_MAX_TOTAL_BYTES,
	SURFACE_IMAGE_MEDIA_TYPES,
	SURFACE_KINDS,
	SURFACE_LAYOUT_PATH,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_COMPARE_VARIANTS,
	SURFACE_MAX_OPTION_GROUP_KEY_CHARS,
	SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
	SURFACE_MAX_PROMPT_CHARS,
	SURFACE_MAX_SUPERSEDE_KEY_CHARS,
	SURFACE_MAX_TITLE_CHARS,
	SURFACE_PREVIEW_MODES,
	SURFACE_PROGRESS_STEP_STATUSES,
	SURFACE_PUBLISH_STATUSES,
	SURFACE_REPORT_RESEARCH_KEYS,
	SURFACE_SESSION_ARTIFACT_FORMATS,
	SURFACE_SESSION_ARTIFACT_KEY_PATTERN,
	SURFACE_SESSION_ARTIFACT_KINDS,
	SURFACE_SESSION_ARTIFACT_MAX_BYTES,
	SURFACE_SESSION_STATES,
	SURFACE_SOURCE_KINDS,
	SURFACE_STATUSES,
	SURFACE_TALK_FILE,
	type SurfaceArchetype,
	type SurfaceAutomationStatus,
	type SurfaceChangeDiffStats,
	type SurfaceGroup,
	type SurfaceImageRef,
	type SurfaceKind,
	type SurfacePreviewMode,
	type SurfacePublishStatus,
	type SurfaceSessionArtifact,
	type SurfaceSessionArtifactFormat,
	type SurfaceSessionArtifactKind,
	type SurfaceSessionChecksSummary,
	type SurfaceSessionProgressStep,
	type SurfaceSessionState,
	type SurfaceSourceKind,
	type SurfaceStatus,
	type SurfaceTalk,
	surfaceReportMarkedKey,
	surfaceTalkPosts,
	surfaceTalkStarter,
	WireValueError,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	relayControlRefusal,
} from "./cloud-native-tool-boundary.ts";
import { mergeFolderPatchOps, type SurfaceSessionOpenChange } from "./cloud-surface-preview-overlay.ts";

const GIT_SHA = /^[0-9a-f]{40}$/;
const OPS_ACTION_KIND_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const MAX_SURFACE_NOTE_PATHS = 64;
const MAX_SURFACE_PATH_CHARS = 512;
const MAX_OWNER_LABEL_CHARS = 160;
const MAX_VARIANT_LABEL_CHARS = 80;
const MAX_OPS_ACTION_PAYLOAD_BYTES = 256 * 1024;
const MAX_STAGE_SURFACE_PATCH_BYTES = 512 * 1024;
const MAX_MERGE_JSON_DEPTH = 16;
const DISALLOWED_MERGE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_AUTOMATION_TITLE_CHARS = 120;
const MAX_AUTOMATION_SCHEDULE_CHARS = 160;
const MANAGE_SURFACE_AUTOMATION_ACTIONS = ["create", "update", "delete"] as const;

export type ManageSurfaceAutomationAction = (typeof MANAGE_SURFACE_AUTOMATION_ACTIONS)[number];

export interface SurfaceSenseActiveSession {
	readonly id: string;
	readonly title: string;
	readonly state: SurfaceSessionState;
	readonly explorationId: string | null;
	readonly openChangeCount: number;
	readonly hasConflict: boolean;
}

export interface SurfaceSenseEntry {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly kind: SurfaceKind;
	readonly archetype: SurfaceArchetype;
	readonly status: SurfaceStatus;
	readonly isGlobal: boolean;
	readonly sourceKind: SurfaceSourceKind;
	readonly repositoryKey: string | null;
	readonly repositorySubpath?: string | null;
	readonly defaultBranch?: string;
	readonly folderRoot: string | null;
	readonly unpublishedChangeCount: number;
	readonly publishStatus: SurfacePublishStatus;
	readonly activeSessions: readonly SurfaceSenseActiveSession[];
}

export interface SurfaceSenseAutomation {
	readonly id: string;
	readonly key: string;
	readonly title: string;
	readonly scheduleSummary: string;
	readonly targetSurfaceSlug: string | null;
	readonly enabled: boolean;
	readonly status: SurfaceAutomationStatus;
}

export interface SurfaceCompanySenses {
	readonly surfaces: readonly SurfaceSenseEntry[];
	readonly automations: readonly SurfaceSenseAutomation[];
}

export interface ManageSurfaceAutomationRequest {
	readonly action: ManageSurfaceAutomationAction;
	readonly automationId: string | null;
	readonly title: string | null;
	readonly prompt: string | null;
	readonly scheduleSummary: string | null;
	readonly targetSurfaceSlug: string | null;
	readonly enabled: boolean | null;
}

export type ManageSurfaceAutomationResult =
	| {
			readonly deleted: true;
			readonly id: string;
	  }
	| {
			readonly id: string;
			readonly key: string;
			readonly title: string;
			readonly prompt: string;
			readonly scheduleSummary: string;
			readonly targetSurfaceSlug: string | null;
			readonly enabled: boolean;
			readonly status: SurfaceAutomationStatus;
	  };

export interface SurfaceAutomationToolPort {
	manageAutomation(
		companyId: string,
		request: ManageSurfaceAutomationRequest,
		context: CloudToolContext,
	): Promise<ManageSurfaceAutomationResult>;
}

export interface CodingRecordChangeRequest {
	readonly title: string;
	readonly summary: string;
	readonly commitSha: string;
	readonly parentSha?: string | null;
	readonly dependsOnChangeIds?: readonly string[] | null;
	readonly affectedPaths?: readonly string[];
	readonly diffStats?: SurfaceChangeDiffStats | null;
	readonly changeId?: string | null;
	readonly rebase?: boolean;
	readonly optionGroup?: string | null;
	readonly optionGroupTitle?: string | null;
	readonly supersedeKey?: string | null;
}

export interface CodingPublishArtifactRequest {
	readonly kind: SurfaceSessionArtifactKind;
	readonly artifactKey: string;
	readonly title: string;
	readonly summary?: string | null;
	readonly contentFormat: SurfaceSessionArtifactFormat;
	readonly contentText?: string | null;
	readonly imageRef?: SurfaceImageRef | null;
	readonly changeId?: string | null;
}

export interface CodingReportProgressRequest {
	readonly currentActivity?: string | null;
	readonly progressSteps?: readonly SurfaceSessionProgressStep[];
	readonly checksSummary?: SurfaceSessionChecksSummary | null;
}

export interface CodingReportProgressResult {
	readonly sessionId: string;
	readonly currentActivity: string | null;
	readonly progressSteps: readonly SurfaceSessionProgressStep[];
	readonly checksSummary: SurfaceSessionChecksSummary | null;
	readonly updatedAt: string;
}

export interface ProposeSurfaceRequest {
	readonly slug: string;
	readonly title: string;
	readonly group: SurfaceGroup;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind;
	readonly isGlobal?: boolean;
	readonly activateImmediately?: boolean;
	readonly sourceKind: SurfaceSourceKind;
	readonly icon: string;
	readonly repositoryKey: string | null;
	readonly repositorySubpath?: string | null;
	readonly defaultBranch?: string | null;
	readonly folderRoot: string | null;
	readonly previewMode: SurfacePreviewMode;
	readonly briefSummary: string | null;
}

export interface StartSurfaceSessionToolRequest {
	readonly surfaceId: string;
	readonly prompt: string;
	readonly title: string | null;
	readonly explorationCount: 2 | 3 | null;
	readonly explorationTitle: string | null;
	readonly ownerLabel?: string | null;
	readonly variantLabels?: readonly string[] | null;
	readonly supersedeKey?: string | null;
}

export interface SteerSurfaceSessionRequest {
	readonly sessionId: string;
	readonly message: string;
	readonly changeId: string | null;
	readonly originLabel?: string | null;
}

export interface StageSurfacePatchRequest {
	readonly title: string;
	readonly summary: string;
	readonly ops: readonly StudioPatchOp[];
	readonly baseFiles?: Readonly<Record<string, string | null>>;
	readonly notePaths: readonly string[];
	readonly finishSession: boolean;
	readonly changeId?: string | null;
	readonly replaceAll?: boolean;
	readonly optionGroup?: string | null;
	readonly optionGroupTitle?: string | null;
	readonly supersedeKey?: string | null;
}

export interface StageSurfaceOpsActionRequest {
	readonly title: string;
	readonly summary: string;
	readonly actionKind: string;
	readonly actionPayload: Readonly<Record<string, JsonValue>>;
	readonly finishSession: boolean;
	readonly changeId?: string | null;
	readonly supersedeKey?: string | null;
}

export interface SurfaceChangeStagedResult {
	readonly changeId: string;
	readonly seq: number;
	readonly openChangeCount: number;
	readonly updated?: boolean;
}

export interface SurfaceFollowUpChangeOptions {
	readonly openChanges?: readonly SurfaceSessionOpenChange[];
	readonly replyChangeId?: string | null;
	readonly isInternalReconciliation?: boolean;
}

export interface SurfacePatchToolPort {
	stageSurfacePatch(
		sessionId: string,
		request: StageSurfacePatchRequest,
		context: CloudToolContext,
	): Promise<SurfaceChangeStagedResult>;
}

export interface SurfaceOpsActionToolPort {
	stageSurfaceOpsAction(
		sessionId: string,
		request: StageSurfaceOpsActionRequest,
		context: CloudToolContext,
	): Promise<SurfaceChangeStagedResult>;
}

export interface CloudSurfaceToolsPort {
	recordChange(
		sessionId: string,
		request: CodingRecordChangeRequest,
		context: CloudToolContext,
	): Promise<SurfaceChangeStagedResult>;
	publishArtifact?(
		sessionId: string,
		request: CodingPublishArtifactRequest,
		context: CloudToolContext,
	): Promise<SurfaceSessionArtifact>;
	reportProgress?(
		sessionId: string,
		request: CodingReportProgressRequest,
		context: CloudToolContext,
	): Promise<CodingReportProgressResult>;
	proposeSurface(
		companyId: string,
		request: ProposeSurfaceRequest,
		context: CloudToolContext,
	): Promise<{ readonly id: string; readonly slug: string; readonly status: "proposed" | "active" }>;
	startSurfaceSession(
		request: StartSurfaceSessionToolRequest,
		context: CloudToolContext,
	): Promise<{ readonly sessionId: string; readonly explorationId: string | null }>;
	steerSurfaceSession?(
		request: SteerSurfaceSessionRequest,
		context: CloudToolContext,
	): Promise<{ readonly sessionId: string; readonly state: string }>;
	stageSurfacePatch?: SurfacePatchToolPort["stageSurfacePatch"];
	stageSurfaceOpsAction?: SurfaceOpsActionToolPort["stageSurfaceOpsAction"];
	listSurfaceSenses?(companyId: string, signal?: AbortSignal): Promise<SurfaceCompanySenses>;
	manageAutomation?: SurfaceAutomationToolPort["manageAutomation"];
}

export type SurfaceControlPlaneRpc =
	| "qorpera_native_surface_propose"
	| "qorpera_native_surface_start_session"
	| "qorpera_native_surface_steer_session"
	| "qorpera_native_surface_record_change"
	| "qorpera_native_surface_upsert_artifact"
	| "qorpera_native_surface_report_progress"
	| "qorpera_native_surface_read_session_turn"
	| "qorpera_native_surface_renew_lease"
	| "qorpera_native_surface_complete_turn"
	| "qorpera_native_surface_describe_senses"
	| "qorpera_native_surface_manage_automation";

export interface SurfaceToolsRpcClient {
	call(
		method: SurfaceControlPlaneRpc,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown>;
}

export interface ControlPlaneSurfaceToolsPortOptions {
	readonly defaultOriginKind?: "cofounder" | "automation";
	readonly defaultOriginLabel?: string;
	readonly leaseToken?: string | null;
	readonly deferSessionCompletion?: boolean;
	readonly onNotePaths?: (notePaths: readonly string[]) => void;
}

function parseEnumArg<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new CloudToolArgumentRefusal(`${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function parseOptionalBounded(value: unknown, field: string, maxLength: number): string | null {
	if (value === undefined || value === null) return null;
	try {
		return parseBoundedText(value, field, maxLength).trim();
	} catch {
		throw new CloudToolArgumentRefusal(`${field} must be a non-empty string up to ${maxLength} characters`);
	}
}

function parseBooleanArg(value: unknown, field: string, fallback: boolean): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") {
		throw new CloudToolArgumentRefusal(`${field} must be a boolean`);
	}
	return value;
}

function assertSafeRelativePath(path: string, field: string): string {
	const trimmed = path.trim();
	if (
		trimmed.length === 0 ||
		trimmed.startsWith("/") ||
		trimmed.endsWith("/") ||
		trimmed.includes("\\") ||
		trimmed.includes("\0") ||
		trimmed.includes(":") ||
		trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new CloudToolArgumentRefusal(`${field} must be a safe relative path`);
	}
	return trimmed;
}

function validateMergeJsonValue(value: unknown, field: string, depth: number): void {
	if (depth > MAX_MERGE_JSON_DEPTH) {
		throw new CloudToolArgumentRefusal(`${field} exceeds maximum nesting depth of ${MAX_MERGE_JSON_DEPTH}`);
	}
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			validateMergeJsonValue(value[i], `${field}[${i}]`, depth + 1);
		}
		return;
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		if (DISALLOWED_MERGE_JSON_KEYS.has(key)) {
			throw new CloudToolArgumentRefusal(`${field} contains forbidden key "${key}"`);
		}
		validateMergeJsonValue((value as Record<string, unknown>)[key], `${field}.${key}`, depth + 1);
	}
}

function parseOptionalNotePathsArg(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_SURFACE_NOTE_PATHS) {
		throw new CloudToolArgumentRefusal(`notePaths must be an array of at most ${MAX_SURFACE_NOTE_PATHS} paths`);
	}
	return value.map((item, index) => {
		let bounded: string;
		try {
			bounded = parseBoundedText(item, `notePaths[${index}]`, MAX_SURFACE_PATH_CHARS);
		} catch {
			throw new CloudToolArgumentRefusal(
				`notePaths[${index}] must be a non-empty path up to ${MAX_SURFACE_PATH_CHARS} characters`,
			);
		}
		return assertSafeRelativePath(bounded, `notePaths[${index}]`);
	});
}

function parseRecordChangeResult(value: unknown, label: string): SurfaceChangeStagedResult {
	const row = parseRecord(value, label);
	const session =
		row.session && typeof row.session === "object" && !Array.isArray(row.session)
			? (row.session as Record<string, unknown>)
			: null;
	const openRaw = session?.openChangeCount ?? row.openChangeCount ?? 1;
	return {
		changeId: parseUuid(row.changeId, `${label}.changeId`),
		seq: parseInteger(row.seq, `${label}.seq`, 1, 10_000),
		openChangeCount: parseInteger(openRaw, `${label}.openChangeCount`, 0, 10_000),
		...(row.updated === true ? { updated: true } : {}),
	};
}

function sanitizeAsciiRefusal(text: string, maxChars: number): string {
	const clean = text
		.replace(/[^\u0020-\u007e]/g, "?")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
}

function formatOpenChangesRefusalList(openChanges: readonly SurfaceSessionOpenChange[]): string {
	const shown = openChanges.slice(0, 5).map((item) => `${item.changeId} ("${sanitizeAsciiRefusal(item.title, 48)}")`);
	const overflow = openChanges.length - shown.length;
	return overflow > 0 ? `${shown.join(", ")}, +${overflow} more` : shown.join(", ");
}

function resolveFollowUpTargetChangeId(input: {
	readonly explicitChangeId: string | null;
	readonly createNew: boolean;
	readonly optionGroup?: string | null;
	readonly openChanges: readonly SurfaceSessionOpenChange[];
	readonly replyChangeId: string | null;
	readonly updatedInTurn: ReadonlySet<string>;
	readonly isInternalReconciliation: boolean;
	readonly explicitParentSha?: string | null;
	readonly tipOnly?: boolean;
}): string | null {
	const {
		explicitChangeId,
		createNew,
		optionGroup,
		openChanges,
		replyChangeId,
		updatedInTurn,
		isInternalReconciliation,
		explicitParentSha,
		tipOnly,
	} = input;
	if (explicitChangeId && createNew) {
		throw new CloudToolArgumentRefusal(
			"Pass either changeId to update an existing change in place or createNew: true to add a separate new change, not both.",
		);
	}
	if (explicitChangeId) {
		if (openChanges.length > 0 && !openChanges.some((item) => item.changeId === explicitChangeId)) {
			throw new CloudToolArgumentRefusal(
				`changeId ${explicitChangeId} is not an open change in this session. Open changes: ${formatOpenChangesRefusalList(openChanges)}. Pass one of those IDs to update it in place, or omit changeId and pass createNew: true to stage a new change.`,
			);
		}
		if (optionGroup) {
			const existing = openChanges.find((item) => item.changeId === explicitChangeId);
			if (existing && existing.optionGroupKey !== optionGroup) {
				throw new CloudToolArgumentRefusal(
					"Cannot change optionGroup when updating an existing change; omit changeId or pass createNew: true to stage an option in a different group.",
				);
			}
		}
		return explicitChangeId;
	}
	if (createNew || isInternalReconciliation || openChanges.length === 0 || Boolean(optionGroup)) {
		return null;
	}
	if (tipOnly) {
		const tipChange = openChanges[openChanges.length - 1]!;
		if (openChanges.length === 1 && !updatedInTurn.has(tipChange.changeId)) {
			return tipChange.changeId;
		}
		if (replyChangeId === tipChange.changeId && !updatedInTurn.has(tipChange.changeId)) {
			return tipChange.changeId;
		}
		const repliedChange = replyChangeId ? openChanges.find((item) => item.changeId === replyChangeId) : undefined;
		if (repliedChange && repliedChange.changeId !== tipChange.changeId) {
			if (
				repliedChange.optionGroupKey &&
				explicitParentSha &&
				repliedChange.parentSha === explicitParentSha &&
				!updatedInTurn.has(repliedChange.changeId)
			) {
				return repliedChange.changeId;
			}
			throw new CloudToolArgumentRefusal(
				`Change ${replyChangeId} is not the tip change on this branch (tip is ${tipChange.changeId}). Reset the working tree or rebase so commit ranges stay clean, then call coding_record_change with explicit changeId, parentSha, and commitSha (passing rebase: true for shifted downstream changes), or pass createNew: true to stage a separate new change.`,
			);
		}
		if (explicitParentSha && tipChange.parentSha === explicitParentSha && !updatedInTurn.has(tipChange.changeId)) {
			const parentMatches = openChanges.filter((item) => item.parentSha === explicitParentSha);
			if (parentMatches.length === 1) {
				return tipChange.changeId;
			}
		}
		throw new CloudToolArgumentRefusal(
			`This session already has open staged changes (${formatOpenChangesRefusalList(openChanges)}). Pass changeId to update an existing change in place, or pass createNew: true to stage a separate new change.`,
		);
	}
	if (
		replyChangeId &&
		!updatedInTurn.has(replyChangeId) &&
		openChanges.some((item) => item.changeId === replyChangeId)
	) {
		return replyChangeId;
	}
	if (openChanges.length === 1 && !updatedInTurn.has(openChanges[0]!.changeId)) {
		return openChanges[0]!.changeId;
	}
	if (explicitParentSha) {
		const parentMatches = openChanges.filter(
			(item) => item.parentSha === explicitParentSha && !updatedInTurn.has(item.changeId),
		);
		if (parentMatches.length === 1) {
			return parentMatches[0]!.changeId;
		}
	}
	throw new CloudToolArgumentRefusal(
		`This session already has open staged changes (${formatOpenChangesRefusalList(openChanges)}). Pass changeId to update an existing change in place, or pass createNew: true to stage a separate new change.`,
	);
}

function parseWireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${label} is invalid`);
	}
	return value as T;
}

function parseOptionalWireText(value: unknown, label: string, maxLength: number): string | null {
	if (value === null || value === undefined) return null;
	return parseBoundedText(value, label, maxLength, 0);
}

function parseSurfaceCompanySenses(value: unknown, label = "surfaceSenses"): SurfaceCompanySenses {
	const raw = parseRecord(value, label);
	const rawSurfaces = raw.surfaces ?? [];
	const rawAutomations = raw.automations ?? [];
	if (!Array.isArray(rawSurfaces)) throw new Error(`${label}.surfaces must be an array`);
	if (!Array.isArray(rawAutomations)) throw new Error(`${label}.automations must be an array`);
	const surfaces: SurfaceSenseEntry[] = rawSurfaces.map((item, index) => {
		const row = parseRecord(item, `${label}.surfaces[${index}]`);
		const rawSessions = row.activeSessions ?? [];
		if (!Array.isArray(rawSessions)) {
			throw new Error(`${label}.surfaces[${index}].activeSessions must be an array`);
		}
		const activeSessions: SurfaceSenseActiveSession[] = rawSessions.map((sessionItem, sessionIndex) => {
			const s = parseRecord(sessionItem, `${label}.surfaces[${index}].activeSessions[${sessionIndex}]`);
			if (typeof s.hasConflict !== "boolean") {
				throw new Error(`${label}.surfaces[${index}].activeSessions[${sessionIndex}].hasConflict must be boolean`);
			}
			return {
				id: parseUuid(s.id, `${label}.surfaces[${index}].activeSessions[${sessionIndex}].id`),
				title: parseBoundedText(s.title, `${label}.surfaces[${index}].activeSessions[${sessionIndex}].title`, 160),
				state: parseWireEnum(
					s.state,
					SURFACE_SESSION_STATES,
					`${label}.surfaces[${index}].activeSessions[${sessionIndex}].state`,
				),
				explorationId:
					s.explorationId === null || s.explorationId === undefined
						? null
						: parseUuid(
								s.explorationId,
								`${label}.surfaces[${index}].activeSessions[${sessionIndex}].explorationId`,
							),
				openChangeCount: parseInteger(
					s.openChangeCount ?? 0,
					`${label}.surfaces[${index}].activeSessions[${sessionIndex}].openChangeCount`,
					0,
					10_000,
				),
				hasConflict: s.hasConflict,
			};
		});
		if (typeof row.isGlobal !== "boolean") {
			throw new Error(`${label}.surfaces[${index}].isGlobal must be boolean`);
		}
		return {
			id: parseUuid(row.id, `${label}.surfaces[${index}].id`),
			slug: parseSurfaceSlug(row.slug, `${label}.surfaces[${index}].slug`),
			title: parseBoundedText(row.title, `${label}.surfaces[${index}].title`, SURFACE_MAX_TITLE_CHARS),
			kind: parseWireEnum(row.kind ?? "custom", SURFACE_KINDS, `${label}.surfaces[${index}].kind`),
			archetype: parseWireEnum(row.archetype, SURFACE_ARCHETYPES, `${label}.surfaces[${index}].archetype`),
			status: parseWireEnum(row.status, SURFACE_STATUSES, `${label}.surfaces[${index}].status`),
			isGlobal: row.isGlobal,
			sourceKind: parseWireEnum(row.sourceKind, SURFACE_SOURCE_KINDS, `${label}.surfaces[${index}].sourceKind`),
			repositoryKey: parseOptionalWireText(row.repositoryKey, `${label}.surfaces[${index}].repositoryKey`, 200),
			...(row.repositorySubpath !== undefined
				? {
						repositorySubpath: parseOptionalWireText(
							row.repositorySubpath,
							`${label}.surfaces[${index}].repositorySubpath`,
							240,
						),
					}
				: {}),
			...(typeof row.defaultBranch === "string" && row.defaultBranch.trim()
				? { defaultBranch: row.defaultBranch.trim() }
				: {}),
			folderRoot: parseOptionalWireText(row.folderRoot, `${label}.surfaces[${index}].folderRoot`, 256),
			unpublishedChangeCount: parseInteger(
				row.unpublishedChangeCount ?? 0,
				`${label}.surfaces[${index}].unpublishedChangeCount`,
				0,
				10_000,
			),
			publishStatus: parseWireEnum(
				row.publishStatus ?? "idle",
				SURFACE_PUBLISH_STATUSES,
				`${label}.surfaces[${index}].publishStatus`,
			),
			activeSessions,
		};
	});
	const automations: SurfaceSenseAutomation[] = rawAutomations.map((item, index) => {
		const row = parseRecord(item, `${label}.automations[${index}]`);
		if (typeof row.enabled !== "boolean") {
			throw new Error(`${label}.automations[${index}].enabled must be boolean`);
		}
		return {
			id: parseUuid(row.id, `${label}.automations[${index}].id`),
			key: parseBoundedText(row.key, `${label}.automations[${index}].key`, 80),
			title: parseBoundedText(row.title, `${label}.automations[${index}].title`, MAX_AUTOMATION_TITLE_CHARS),
			scheduleSummary: parseBoundedText(
				row.scheduleSummary,
				`${label}.automations[${index}].scheduleSummary`,
				MAX_AUTOMATION_SCHEDULE_CHARS,
			),
			targetSurfaceSlug:
				row.targetSurfaceSlug === null || row.targetSurfaceSlug === undefined
					? null
					: parseSurfaceSlug(row.targetSurfaceSlug, `${label}.automations[${index}].targetSurfaceSlug`),
			enabled: row.enabled,
			status: parseWireEnum(row.status, SURFACE_AUTOMATION_STATUSES, `${label}.automations[${index}].status`),
		};
	});
	return { surfaces, automations };
}

function parseManageSurfaceAutomationResult(value: unknown, label: string): ManageSurfaceAutomationResult {
	const row = parseRecord(value, label);
	if (row.deleted === true) {
		return {
			deleted: true,
			id: parseUuid(row.id, `${label}.id`),
		};
	}
	if (typeof row.enabled !== "boolean") {
		throw new Error(`${label}.enabled must be boolean`);
	}
	return {
		id: parseUuid(row.id, `${label}.id`),
		key: parseBoundedText(row.key, `${label}.key`, 80),
		title: parseBoundedText(row.title, `${label}.title`, MAX_AUTOMATION_TITLE_CHARS),
		prompt: parseBoundedText(row.prompt, `${label}.prompt`, SURFACE_MAX_PROMPT_CHARS, 0),
		scheduleSummary: parseBoundedText(row.scheduleSummary, `${label}.scheduleSummary`, MAX_AUTOMATION_SCHEDULE_CHARS),
		targetSurfaceSlug:
			row.targetSurfaceSlug === null || row.targetSurfaceSlug === undefined
				? null
				: parseSurfaceSlug(row.targetSurfaceSlug, `${label}.targetSurfaceSlug`),
		enabled: row.enabled,
		status: parseWireEnum(row.status, SURFACE_AUTOMATION_STATUSES, `${label}.status`),
	};
}

export type ControlPlaneSurfaceToolsPort = CloudSurfaceToolsPort &
	SurfacePatchToolPort &
	SurfaceOpsActionToolPort &
	SurfaceAutomationToolPort & {
		listSurfaceSenses(companyId: string, signal?: AbortSignal): Promise<SurfaceCompanySenses>;
	};

// WHY: Bridges Surface runtime tools onto the cloud control-plane RPC transport without leaking service credentials to model turns.
export function createControlPlaneSurfaceToolsPort(
	control: SurfaceToolsRpcClient,
	options?: ControlPlaneSurfaceToolsPortOptions,
): ControlPlaneSurfaceToolsPort;
export function createControlPlaneSurfaceToolsPort(
	control: CloudCompanyPathControl,
	options?: ControlPlaneSurfaceToolsPortOptions,
): ControlPlaneSurfaceToolsPort;
export function createControlPlaneSurfaceToolsPort(
	control: SurfaceToolsRpcClient | CloudCompanyPathControl,
	options: ControlPlaneSurfaceToolsPortOptions = {},
): ControlPlaneSurfaceToolsPort {
	const rpc = (method: SurfaceControlPlaneRpc, args: Record<string, unknown>, signal: AbortSignal) =>
		(control as SurfaceToolsRpcClient).call(method, args, signal);

	return {
		async recordChange(sessionId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_record_change",
				{
					p_profile_id: context.companyId,
					p_session_id: sessionId,
					p_title: request.title,
					p_summary: request.summary,
					p_kind: "git_range",
					p_parent_sha: request.parentSha ?? null,
					p_head_sha: request.commitSha,
					p_depends_on_change_ids:
						request.dependsOnChangeIds === undefined || request.dependsOnChangeIds === null
							? request.changeId
								? null
								: []
							: [...request.dependsOnChangeIds],
					p_affected_paths: request.affectedPaths ? [...request.affectedPaths] : [],
					p_diff_stats: request.diffStats ?? null,
					p_patch_manifest: request.rebase === true ? { rebase: true } : null,
					p_finish_session: false,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
					...(request.optionGroup !== undefined ? { p_option_group_key: request.optionGroup } : {}),
					...(request.optionGroupTitle !== undefined ? { p_option_group_title: request.optionGroupTitle } : {}),
					...(request.changeId ? { p_change_id: request.changeId } : {}),
					...(request.supersedeKey !== undefined && request.supersedeKey !== null
						? { p_supersede_key: request.supersedeKey }
						: {}),
				},
				context.signal,
			);
			return parseRecordChangeResult(response, "recordChange");
		},

		async publishArtifact(sessionId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_upsert_artifact",
				{
					p_profile_id: context.companyId,
					p_session_id: sessionId,
					p_lease_token: options.leaseToken ?? null,
					p_kind: request.kind,
					p_artifact_key: request.artifactKey,
					p_title: request.title,
					p_summary: request.summary ?? null,
					p_content_format: request.contentFormat,
					p_content_text: request.contentText ?? null,
					p_image_ref: request.imageRef ?? null,
					p_change_id: request.changeId ?? null,
				},
				context.signal,
			);
			return parseSurfaceSessionArtifact(response, "publishArtifact");
		},

		async reportProgress(sessionId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_report_progress",
				{
					p_profile_id: context.companyId,
					p_session_id: sessionId,
					p_lease_token: options.leaseToken ?? null,
					p_current_activity:
						request.currentActivity === undefined
							? null
							: request.currentActivity === null
								? ""
								: request.currentActivity,
					p_progress_steps: request.progressSteps === undefined ? null : [...request.progressSteps],
					p_checks_summary: request.checksSummary ?? null,
				},
				context.signal,
			);
			const row = parseRecord(response, "reportProgress");
			const rawSteps = row.progressSteps ?? [];
			if (!Array.isArray(rawSteps)) throw new Error("reportProgress.progressSteps must be an array");
			return {
				sessionId: parseUuid(row.sessionId, "reportProgress.sessionId"),
				currentActivity: parseOptionalWireText(row.currentActivity, "reportProgress.currentActivity", 240),
				progressSteps: rawSteps.map((item, index) =>
					parseSurfaceSessionProgressStep(item, `reportProgress.progressSteps[${index}]`),
				),
				checksSummary:
					row.checksSummary === null || row.checksSummary === undefined
						? null
						: parseSurfaceSessionChecksSummary(row.checksSummary, "reportProgress.checksSummary"),
				updatedAt: parseBoundedText(row.updatedAt, "reportProgress.updatedAt", 64),
			};
		},

		async proposeSurface(companyId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_propose",
				{
					p_profile_id: companyId,
					p_slug: request.slug,
					p_title: request.title,
					p_group: request.group,
					p_archetype: request.archetype,
					p_source_kind: request.sourceKind,
					p_icon: request.icon,
					p_repository_key: request.repositoryKey,
					p_folder_root: request.folderRoot,
					p_preview_mode: request.previewMode,
					p_brief_summary: request.briefSummary,
					p_kind: request.kind ?? "custom",
					p_accent_hex: null,
					p_is_global: request.isGlobal ?? false,
					p_activate_immediately: request.activateImmediately ?? false,
					...(request.repositorySubpath !== undefined ? { p_repository_subpath: request.repositorySubpath } : {}),
					...(request.defaultBranch !== undefined ? { p_default_branch: request.defaultBranch } : {}),
				},
				context.signal,
			);
			const row = parseRecord(response, "proposeSurface");
			if (row.status !== "proposed" && row.status !== "active") {
				throw new Error("proposeSurface.status is invalid");
			}
			return {
				id: parseUuid(row.id, "proposeSurface.id"),
				slug: parseSurfaceSlug(row.slug, "proposeSurface.slug"),
				status: row.status,
			};
		},

		async startSurfaceSession(request, context) {
			const response = await rpc(
				"qorpera_native_surface_start_session",
				{
					p_profile_id: context.companyId,
					p_surface_id: request.surfaceId,
					p_prompt: request.prompt,
					p_title: request.title,
					p_origin_kind: options.defaultOriginKind ?? "cofounder",
					p_origin_label: request.ownerLabel ?? options.defaultOriginLabel ?? "Co-Founder",
					p_exploration_count: request.explorationCount,
					p_exploration_title: request.explorationTitle,
					p_variant_labels: request.variantLabels ? [...request.variantLabels] : null,
					...(request.supersedeKey !== undefined && request.supersedeKey !== null
						? { p_supersede_key: request.supersedeKey }
						: {}),
				},
				context.signal,
			);
			const row = parseRecord(response, "startSurfaceSession");
			return {
				sessionId: parseUuid(row.sessionId, "startSurfaceSession.sessionId"),
				explorationId:
					row.explorationId === null || row.explorationId === undefined
						? null
						: parseUuid(row.explorationId, "startSurfaceSession.explorationId"),
			};
		},

		async steerSurfaceSession(request, context) {
			const response = await rpc(
				"qorpera_native_surface_steer_session",
				{
					p_profile_id: context.companyId,
					p_session_id: request.sessionId,
					p_message: request.message,
					p_origin_label: request.originLabel ?? options.defaultOriginLabel ?? "Co-Founder",
					...(request.changeId ? { p_change_id: request.changeId } : {}),
				},
				context.signal,
			);
			const row = parseRecord(response, "steerSurfaceSession");
			return {
				sessionId: parseUuid(row.id ?? row.sessionId ?? request.sessionId, "steerSurfaceSession.sessionId"),
				state: typeof row.state === "string" ? row.state : "queued",
			};
		},

		async stageSurfacePatch(sessionId, request, context) {
			const affectedPaths = [...new Set(request.ops.map((op) => op.path))];
			const hasBaseFiles = request.baseFiles !== undefined && Object.keys(request.baseFiles).length > 0;
			const replaceAll = request.replaceAll === true;
			const patchManifest =
				hasBaseFiles || replaceAll
					? {
							ops: [...request.ops],
							...(hasBaseFiles ? { baseFiles: request.baseFiles } : {}),
							...(replaceAll ? { replaceAll: true } : {}),
						}
					: [...request.ops];
			const response = await rpc(
				"qorpera_native_surface_record_change",
				{
					p_profile_id: context.companyId,
					p_session_id: sessionId,
					p_title: request.title,
					p_summary: request.summary,
					p_kind: "folder_patch",
					p_parent_sha: null,
					p_head_sha: null,
					p_depends_on_change_ids: request.changeId ? null : [],
					p_affected_paths: affectedPaths,
					p_diff_stats: null,
					p_patch_manifest: patchManifest,
					p_finish_session: options.deferSessionCompletion ? false : request.finishSession,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
					...(request.optionGroup !== undefined ? { p_option_group_key: request.optionGroup } : {}),
					...(request.optionGroupTitle !== undefined ? { p_option_group_title: request.optionGroupTitle } : {}),
					...(request.changeId ? { p_change_id: request.changeId } : {}),
					...(request.supersedeKey !== undefined && request.supersedeKey !== null
						? { p_supersede_key: request.supersedeKey }
						: {}),
				},
				context.signal,
			);
			if (request.notePaths.length > 0) {
				options.onNotePaths?.(request.notePaths);
			}
			return parseRecordChangeResult(response, "stageSurfacePatch");
		},

		async stageSurfaceOpsAction(sessionId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_record_change",
				{
					p_profile_id: context.companyId,
					p_session_id: sessionId,
					p_title: request.title,
					p_summary: request.summary,
					p_kind: "ops_action",
					p_parent_sha: null,
					p_head_sha: null,
					p_depends_on_change_ids: request.changeId ? null : [],
					p_affected_paths: [],
					p_diff_stats: null,
					p_patch_manifest: {
						actionKind: request.actionKind,
						actionPayload: request.actionPayload,
					},
					p_finish_session: options.deferSessionCompletion ? false : request.finishSession,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
					...(request.changeId ? { p_change_id: request.changeId } : {}),
					...(request.supersedeKey !== undefined && request.supersedeKey !== null
						? { p_supersede_key: request.supersedeKey }
						: {}),
				},
				context.signal,
			);
			return parseRecordChangeResult(response, "stageSurfaceOpsAction");
		},

		async listSurfaceSenses(companyId, signal) {
			const response = await withAbortScopes(
				signal ? [signal] : [],
				(rpcSignal) => rpc("qorpera_native_surface_describe_senses", { p_profile_id: companyId }, rpcSignal),
				15_000,
			);
			return parseSurfaceCompanySenses(response, "listSurfaceSenses");
		},

		async manageAutomation(companyId, request, context) {
			const response = await rpc(
				"qorpera_native_surface_manage_automation",
				{
					p_profile_id: companyId,
					p_action: request.action,
					p_automation_id: request.automationId,
					p_title: request.title,
					p_prompt: request.prompt,
					p_schedule_summary: request.scheduleSummary,
					p_target_surface_slug: request.targetSurfaceSlug,
					p_enabled: request.enabled,
				},
				context.signal,
			);
			return parseManageSurfaceAutomationResult(response, "manageAutomation");
		},
	};
}

function parseOptionGroupArgs(raw: Record<string, unknown>): {
	readonly optionGroup?: string;
	readonly optionGroupTitle?: string;
} {
	const rawGroup = raw.optionGroup;
	const rawTitle = raw.optionGroupTitle;
	let optionGroup: string | undefined;
	if (rawGroup !== undefined && rawGroup !== null) {
		if (typeof rawGroup !== "string") {
			throw new CloudToolArgumentRefusal("optionGroup must be a lower-case hyphenated string");
		}
		const normalized = rawGroup.trim().toLowerCase();
		if (normalized.length > 0) {
			if (!isSurfaceOptionGroupKey(normalized)) {
				throw new CloudToolArgumentRefusal(
					`optionGroup must be 1..${SURFACE_MAX_OPTION_GROUP_KEY_CHARS} lower-case letters, digits, and single hyphens`,
				);
			}
			optionGroup = normalized;
		}
	}
	let optionGroupTitle: string | undefined;
	if (rawTitle !== undefined && rawTitle !== null) {
		if (typeof rawTitle !== "string") {
			throw new CloudToolArgumentRefusal("optionGroupTitle must be a string");
		}
		const trimmed = rawTitle.trim();
		if (trimmed.length > 0) {
			if (trimmed.length > SURFACE_MAX_OPTION_GROUP_TITLE_CHARS) {
				throw new CloudToolArgumentRefusal(
					`optionGroupTitle must be at most ${SURFACE_MAX_OPTION_GROUP_TITLE_CHARS} characters`,
				);
			}
			optionGroupTitle = trimmed;
		}
	}
	if (optionGroupTitle !== undefined && optionGroup === undefined) {
		throw new CloudToolArgumentRefusal("optionGroupTitle requires optionGroup");
	}
	return {
		...(optionGroup !== undefined ? { optionGroup } : {}),
		...(optionGroupTitle !== undefined ? { optionGroupTitle } : {}),
	};
}

function parseSupersedeKeyArg(raw: Record<string, unknown>): string | undefined {
	const rawKey = raw.supersedeKey;
	if (rawKey === undefined || rawKey === null) return undefined;
	if (typeof rawKey !== "string") {
		throw new CloudToolArgumentRefusal(
			`supersedeKey must be 1..${SURFACE_MAX_SUPERSEDE_KEY_CHARS} lower-case letters, digits, dots, colons, underscores, or hyphens`,
		);
	}
	const normalized = rawKey.trim().toLowerCase();
	if (!normalized) return undefined;
	if (!isSurfaceSupersedeKey(normalized)) {
		throw new CloudToolArgumentRefusal(
			`supersedeKey must be 1..${SURFACE_MAX_SUPERSEDE_KEY_CHARS} lower-case letters, digits, dots, colons, underscores, or hyphens`,
		);
	}
	return normalized;
}

export function createCodingRecordChangeTool(
	sessionId: string,
	port: Pick<CloudSurfaceToolsPort, "recordChange">,
	options: SurfaceFollowUpChangeOptions = {},
): CloudNativeTool {
	const openChanges = (options.openChanges ?? [])
		.filter((item) => item.kind === "git_range")
		.sort((a, b) => a.seq - b.seq || a.changeId.localeCompare(b.changeId));
	const openById = new Map(openChanges.map((item) => [item.changeId, item]));
	const tipChange = openChanges.length > 0 ? openChanges[openChanges.length - 1]! : null;
	const replyChangeId = options.replyChangeId?.trim() || null;
	const isInternalReconciliation = options.isInternalReconciliation === true;
	const updatedInTurn = new Set<string>();
	return {
		name: "coding_record_change",
		source: "worker",
		description:
			"Stage one cohesive committed ChangeUnit on this Surface session branch without landing main, or update an existing open ChangeUnit in place by passing its changeId. Members toggle and approve each recorded change individually; pass parentSha (the base commit before this change unit, e.g. git rev-parse HEAD~1) and commitSha, calling once per distinct deliverable before coding_finish. When revising an existing open change on a follow-up turn, pass its changeId (keeping its original parentSha and passing the new commitSha, or rebase: true when moving its parentSha after rebasing); pass createNew: true only when adding a separate new deliverable alongside existing open changes. To propose 2-4 mutually exclusive design/website options as a sidebar multiple choice inside this single session (never as an in-page switcher), record each standalone option commit with the same optionGroup slug (and optional optionGroupTitle) and the same shared parentSha (resetting the working tree cleanly to that base commit with git read-tree --reset -u <baseSha> between option commits so each option is a clean publishable site).",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["title", "summary", "commitSha"],
			properties: {
				title: { type: "string", description: "Short plain founder-facing title for this change." },
				summary: { type: "string", description: "1-2 sentences describing what the user will notice." },
				parentSha: {
					type: "string",
					description:
						"Optional 40-hex Git parent commit SHA before this change unit (e.g. git rev-parse <commitSha>~1); defaults to the target change's original parentSha on tip updates, or the shared optionGroup parentSha / previous recorded change head / session base SHA on new changes.",
				},
				commitSha: { type: "string", description: "40-hex Git commit SHA on the session branch." },
				dependsOnChangeIds: {
					type: "array",
					items: { type: "string" },
					description: "Optional IDs of earlier ChangeUnits in this session that must merge before this one.",
				},
				changeId: {
					type: "string",
					description:
						"Optional UUID of an existing open ChangeUnit in this session to update in place instead of creating a new change.",
				},
				createNew: {
					type: "boolean",
					description:
						"Set true when intentionally staging an additional separate ChangeUnit alongside existing open changes in this session.",
				},
				rebase: {
					type: "boolean",
					description:
						"Only when updating an existing open ChangeUnit via changeId: set true when intentionally moving its parentSha to a new base commit after rebasing the session branch.",
				},
				optionGroup: {
					type: "string",
					maxLength: SURFACE_MAX_OPTION_GROUP_KEY_CHARS,
					description:
						"Optional lower-case hyphenated key (e.g. 'homepage-direction') grouping mutually exclusive real options into one multiple-choice block in Changes. Every option in the same optionGroup must share the same parentSha.",
				},
				optionGroupTitle: {
					type: "string",
					maxLength: SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
					description: "Optional plain founder-facing heading for the optionGroup multiple-choice block.",
				},
				supersedeKey: {
					type: "string",
					maxLength: SURFACE_MAX_SUPERSEDE_KEY_CHARS,
					description:
						"Optional stable lower-case key (e.g. 'github-sync') for recurring upkeep or sync updates; staging a new change with this key automatically supersedes earlier unapproved changes on the same Surface with the same key.",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"coding_record_change",
					["title", "summary", "commitSha"],
					[
						"parentSha",
						"dependsOnChangeIds",
						"changeId",
						"createNew",
						"rebase",
						"optionGroup",
						"optionGroupTitle",
						"supersedeKey",
					],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			let title: string;
			let summary: string;
			try {
				title = parseBoundedText(raw.title, "title", SURFACE_MAX_CHANGE_TITLE_CHARS).trim();
				summary = parseBoundedText(raw.summary, "summary", SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0).trim();
			} catch {
				throw new CloudToolArgumentRefusal("title and summary must be valid bounded text");
			}
			if (typeof raw.commitSha !== "string" || !GIT_SHA.test(raw.commitSha)) {
				throw new CloudToolArgumentRefusal("commitSha must be a 40-character lower-case hex SHA");
			}
			let parentSha: string | null | undefined;
			if (raw.parentSha !== undefined && raw.parentSha !== null) {
				if (typeof raw.parentSha !== "string" || !GIT_SHA.test(raw.parentSha)) {
					throw new CloudToolArgumentRefusal("parentSha must be a 40-character lower-case hex SHA");
				}
				parentSha = raw.parentSha;
			}
			const hasExplicitDeps = raw.dependsOnChangeIds !== undefined && raw.dependsOnChangeIds !== null;
			const depsRaw = hasExplicitDeps ? raw.dependsOnChangeIds : [];
			if (!Array.isArray(depsRaw) || depsRaw.length > 32 || depsRaw.some((item) => !isUuid(item))) {
				throw new CloudToolArgumentRefusal("dependsOnChangeIds must be an array of change UUIDs");
			}
			const groupArgs = parseOptionGroupArgs(raw);
			const supersedeKey = parseSupersedeKeyArg(raw);
			let explicitChangeId: string | null = null;
			if (raw.changeId !== undefined && raw.changeId !== null) {
				if (!isUuid(raw.changeId)) {
					throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
				}
				explicitChangeId = raw.changeId;
			}
			const createNew = parseBooleanArg(raw.createNew, "createNew", false);
			const rebase = parseBooleanArg(raw.rebase, "rebase", false);
			const targetChangeId = resolveFollowUpTargetChangeId({
				explicitChangeId,
				createNew,
				optionGroup: groupArgs.optionGroup ?? null,
				openChanges,
				replyChangeId,
				updatedInTurn,
				isInternalReconciliation,
				explicitParentSha: parentSha ?? null,
				tipOnly: true,
			});
			if (rebase && !targetChangeId) {
				throw new CloudToolArgumentRefusal("rebase can only be used when updating an existing open change");
			}
			if (targetChangeId) {
				const target = openById.get(targetChangeId);
				const isNonTip = Boolean(tipChange && targetChangeId !== tipChange.changeId);
				if (isNonTip) {
					if (parentSha === undefined) {
						throw new CloudToolArgumentRefusal(
							"Updating a non-tip git_range change requires an explicit parentSha; rebase the branch so commit ranges do not overlap.",
						);
					}
					if (!rebase && target?.parentSha && parentSha !== target.parentSha) {
						throw new CloudToolArgumentRefusal(
							"Updating a non-tip git_range change with a different parentSha requires rebase: true after rebasing the branch.",
						);
					}
				} else if (target?.parentSha && !rebase) {
					if (parentSha === undefined) {
						parentSha = target.parentSha;
					} else if (target.headSha && parentSha === target.headSha && raw.commitSha !== target.headSha) {
						parentSha = target.parentSha;
					} else if (parentSha !== target.parentSha && (!target.headSha || parentSha !== target.headSha)) {
						throw new CloudToolArgumentRefusal(
							"parentSha must match the existing change's parentSha or prior headSha unless rebase: true is set.",
						);
					}
				}
			}
			return {
				title,
				summary,
				commitSha: raw.commitSha,
				...(parentSha !== undefined ? { parentSha } : {}),
				...(hasExplicitDeps || !targetChangeId ? { dependsOnChangeIds: [...(depsRaw as string[])] } : {}),
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(rebase ? { rebase: true } : {}),
				...groupArgs,
				...(supersedeKey !== undefined ? { supersedeKey } : {}),
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as CodingRecordChangeRequest;
			let result: SurfaceChangeStagedResult;
			try {
				result = await port.recordChange(sessionId, parsed, context);
			} catch (error) {
				relayControlRefusal(error);
			}
			if (parsed.changeId) {
				updatedInTurn.add(parsed.changeId);
			}
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-change-recorded/v1",
					sessionId,
					changeId: result.changeId,
					seq: result.seq,
					openChangeCount: result.openChangeCount,
					staged: true,
					...(result.updated === true ? { updated: true } : {}),
				}),
			};
		},
	};
}

export function createProposeSurfaceTool(port: Pick<CloudSurfaceToolsPort, "proposeSurface">): CloudNativeTool {
	return {
		name: "propose_surface",
		source: "runtime",
		description:
			'Create or propose a primary Surface for the company sidebar. Use archetype "studio" + sourceKind "folder" for Strategy, Identity, Product Studio, Analytics (live business numbers, kind "dashboard"), or Custom Studio workspaces (planning rooms, economics labs, GTM boards, sketching spaces), and archetype "live_build" + sourceKind "code_repo" for customer-facing websites and software products. New surfaces start in proposed state until a founder approves them unless activateImmediately is true for Day-0 founding.',
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["slug", "title", "group", "archetype", "sourceKind"],
			properties: {
				slug: { type: "string", description: "Lower-case hyphenated surface slug." },
				title: { type: "string", maxLength: SURFACE_MAX_TITLE_CHARS, description: "Display title in the sidebar." },
				group: { type: "string", enum: [...SURFACE_GROUPS] },
				archetype: { type: "string", enum: [...SURFACE_ARCHETYPES] },
				kind: {
					type: "string",
					enum: [...SURFACE_KINDS],
					description:
						"Semantic kind of surface (identity, strategy, custom, website, web_app, mobile_app, desktop_app, product, report, etc.). Analytics: studio, kind dashboard.",
				},
				figure: {
					type: "string",
					enum: [...SURFACE_FIGURES],
					description:
						"The figure the surface is drawn as in the sidebar, the thing it is: omit for its kind's own (website = browser, money = money, files = folder). Its colours are fixed; there is no colour to choose.",
				},
				isGlobal: {
					type: "boolean",
					description: "True for global cross-surface workspaces like Identity whose assets feed every surface.",
				},
				activateImmediately: {
					type: "boolean",
					description: "Set true during Day-0 founding for 1-2 core product surfaces; omit or false to propose.",
				},
				sourceKind: { type: "string", enum: [...SURFACE_SOURCE_KINDS] },
				repositoryKey: {
					type: "string",
					maxLength: 200,
					description:
						"Qorpera repository owner/name to bind for code_repo surfaces (omit to create surfaces/<slug>, or pass an imported/existing repository key such as org/repo).",
				},
				repositorySubpath: {
					type: "string",
					maxLength: 240,
					description:
						"Optional relative subfolder inside a monorepo for code_repo surfaces (for example packages/web or apps/site).",
				},
				defaultBranch: {
					type: "string",
					maxLength: 128,
					description: "Optional default branch name for code_repo surfaces (defaults to main).",
				},
				folderRoot: {
					type: "string",
					maxLength: 256,
					description:
						"Studio folder root in Company Files. Omit for non-Identity Studio surfaces to default to an isolated surfaces/<slug> folder instead of colliding with top-level company folders (Identity uses identity/).",
				},
				previewMode: { type: "string", enum: [...SURFACE_PREVIEW_MODES] },
				briefSummary: { type: "string", maxLength: 4000 },
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"propose_surface",
					["slug", "title", "group", "archetype", "sourceKind"],
					[
						"kind",
						"figure",
						"isGlobal",
						"activateImmediately",
						"repositoryKey",
						"repositorySubpath",
						"defaultBranch",
						"folderRoot",
						"previewMode",
						"briefSummary",
					],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			if (!isSurfaceSlug(raw.slug)) {
				throw new CloudToolArgumentRefusal("slug must be lower-case letters, digits, and single hyphens");
			}
			let title: string;
			try {
				title = parseBoundedText(raw.title, "title", SURFACE_MAX_TITLE_CHARS).trim();
			} catch {
				throw new CloudToolArgumentRefusal(`title must be 1..${SURFACE_MAX_TITLE_CHARS} characters`);
			}
			const group = parseEnumArg(raw.group, SURFACE_GROUPS, "group");
			const archetype = parseEnumArg(raw.archetype, SURFACE_ARCHETYPES, "archetype");
			const sourceKind = parseEnumArg(raw.sourceKind, SURFACE_SOURCE_KINDS, "sourceKind");
			const kind =
				raw.kind === undefined || raw.kind === null ? "custom" : parseEnumArg(raw.kind, SURFACE_KINDS, "kind");
			const figure =
				raw.figure === undefined || raw.figure === null
					? null
					: parseEnumArg(raw.figure, SURFACE_FIGURES, "figure");
			const isGlobal = parseBooleanArg(raw.isGlobal, "isGlobal", false);
			const activateImmediately = parseBooleanArg(raw.activateImmediately, "activateImmediately", false);
			const icon = figure ? `figure:${figure}` : "page";
			const repositoryKey = parseOptionalBounded(raw.repositoryKey, "repositoryKey", 200);
			if (repositoryKey !== null && !isSurfaceRepositoryKey(repositoryKey)) {
				throw new CloudToolArgumentRefusal("repositoryKey must be a valid owner/name repository key");
			}
			const rawSubpath = parseOptionalBounded(raw.repositorySubpath, "repositorySubpath", 240);
			const repositorySubpath = normalizeSurfaceRepositorySubpath(rawSubpath);
			if (repositorySubpath !== null && !isSurfaceRepositorySubpath(repositorySubpath)) {
				throw new CloudToolArgumentRefusal(
					"repositorySubpath must be a relative subfolder path without leading slashes, dot segments, or hidden folders",
				);
			}
			const defaultBranch = parseOptionalBounded(raw.defaultBranch, "defaultBranch", 128);
			if (defaultBranch !== null && !isSurfaceDefaultBranch(defaultBranch)) {
				throw new CloudToolArgumentRefusal("defaultBranch must be a valid Git branch name");
			}
			const rawFolderRoot = parseOptionalBounded(raw.folderRoot, "folderRoot", 256);
			const folderRoot =
				rawFolderRoot ??
				(sourceKind === "folder" || archetype === "studio"
					? kind === "identity" || raw.slug === "identity"
						? "identity"
						: `surfaces/${raw.slug}`
					: null);
			const previewMode =
				raw.previewMode === undefined || raw.previewMode === null
					? sourceKind === "code_repo"
						? "static_site"
						: sourceKind === "folder"
							? "studio_overlay"
							: "none"
					: parseEnumArg(raw.previewMode, SURFACE_PREVIEW_MODES, "previewMode");
			const briefSummary = parseOptionalBounded(raw.briefSummary, "briefSummary", 4000);
			return {
				slug: raw.slug,
				title,
				group,
				archetype,
				kind,
				isGlobal,
				activateImmediately,
				sourceKind,
				icon,
				repositoryKey,
				...(repositorySubpath !== null ? { repositorySubpath } : {}),
				...(defaultBranch !== null ? { defaultBranch } : {}),
				folderRoot,
				previewMode,
				briefSummary,
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as ProposeSurfaceRequest;
			const result = await port.proposeSurface(context.companyId, parsed, context);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-proposed/v1",
					surfaceId: result.id,
					slug: result.slug,
					status: result.status,
				}),
			};
		},
	};
}

export function createStartSurfaceSessionTool(
	port: Pick<CloudSurfaceToolsPort, "startSurfaceSession">,
): CloudNativeTool {
	return {
		name: "start_surface_session",
		source: "runtime",
		description:
			"Launch a parallel scoped Session directly on a Surface. Optionally set explorationCount (2 or 3) and variantLabels to spawn side-by-side comparable directions.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["surfaceId", "prompt"],
			properties: {
				surfaceId: { type: "string" },
				prompt: { type: "string", maxLength: SURFACE_MAX_PROMPT_CHARS },
				title: { type: "string", maxLength: 160 },
				explorationCount: { type: "integer", enum: [2, 3] },
				explorationTitle: { type: "string", maxLength: 160 },
				ownerLabel: {
					type: "string",
					maxLength: MAX_OWNER_LABEL_CHARS,
					description: "Optional owning agent or role label shown on the session or exploration.",
				},
				variantLabels: {
					type: "array",
					minItems: 2,
					maxItems: SURFACE_MAX_COMPARE_VARIANTS,
					items: { type: "string", minLength: 1, maxLength: MAX_VARIANT_LABEL_CHARS },
					description: "Optional 2 to 3 custom labels for side-by-side exploration variants.",
				},
				supersedeKey: {
					type: "string",
					maxLength: SURFACE_MAX_SUPERSEDE_KEY_CHARS,
					description:
						"Optional stable lower-case key (e.g. 'github-sync') for recurring upkeep or sync sessions; changes staged by this session supersede earlier unapproved changes on the same Surface carrying the same key.",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"start_surface_session",
					["surfaceId", "prompt"],
					["title", "explorationCount", "explorationTitle", "ownerLabel", "variantLabels", "supersedeKey"],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			if (!isUuid(raw.surfaceId)) throw new CloudToolArgumentRefusal("surfaceId must be a valid UUID");
			let prompt: string;
			try {
				prompt = parseBoundedText(raw.prompt, "prompt", SURFACE_MAX_PROMPT_CHARS).trim();
			} catch {
				throw new CloudToolArgumentRefusal(`prompt must be 1..${SURFACE_MAX_PROMPT_CHARS} characters`);
			}
			const title = parseOptionalBounded(raw.title, "title", 160);
			const explorationTitle = parseOptionalBounded(raw.explorationTitle, "explorationTitle", 160);
			const ownerLabel = parseOptionalBounded(raw.ownerLabel, "ownerLabel", MAX_OWNER_LABEL_CHARS);
			const supersedeKey = parseSupersedeKeyArg(raw);
			let explorationCount: 2 | 3 | null = null;
			if (raw.explorationCount !== undefined && raw.explorationCount !== null) {
				if (raw.explorationCount !== 2 && raw.explorationCount !== 3) {
					throw new CloudToolArgumentRefusal("explorationCount must be 2 or 3");
				}
				explorationCount = raw.explorationCount;
			}
			let variantLabels: string[] | null = null;
			if (raw.variantLabels !== undefined && raw.variantLabels !== null) {
				if (
					!Array.isArray(raw.variantLabels) ||
					raw.variantLabels.length < 2 ||
					raw.variantLabels.length > SURFACE_MAX_COMPARE_VARIANTS
				) {
					throw new CloudToolArgumentRefusal("variantLabels must contain 2 or 3 non-empty labels");
				}
				variantLabels = raw.variantLabels.map((item, index) => {
					try {
						return parseBoundedText(item, `variantLabels[${index}]`, MAX_VARIANT_LABEL_CHARS).trim();
					} catch {
						throw new CloudToolArgumentRefusal(
							`variantLabels[${index}] must be a non-empty string up to ${MAX_VARIANT_LABEL_CHARS} characters`,
						);
					}
				});
				if (explorationCount !== null && variantLabels.length !== explorationCount) {
					throw new CloudToolArgumentRefusal("variantLabels length must match explorationCount");
				}
				if (explorationCount === null) {
					explorationCount = variantLabels.length as 2 | 3;
				}
			}
			return {
				surfaceId: raw.surfaceId,
				prompt,
				title,
				explorationCount,
				explorationTitle,
				ownerLabel,
				variantLabels,
				...(supersedeKey !== undefined ? { supersedeKey } : {}),
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as StartSurfaceSessionToolRequest;
			const result = await port.startSurfaceSession(parsed, context);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-session-started/v1",
					sessionId: result.sessionId,
					explorationId: result.explorationId,
				}),
			};
		},
	};
}

export function createSteerSurfaceSessionTool(port: {
	steerSurfaceSession: NonNullable<CloudSurfaceToolsPort["steerSurfaceSession"]>;
}): CloudNativeTool {
	return {
		name: "steer_surface_session",
		source: "runtime",
		description:
			"Send steering direction or unblock a paused, conflicted, or failed Surface session and re-queue its next turn. Use when answering a Surface escalation directly or relaying the founder's decision.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["sessionId", "message"],
			properties: {
				sessionId: { type: "string" },
				message: { type: "string", minLength: 1, maxLength: SURFACE_MAX_PROMPT_CHARS },
				changeId: { type: "string" },
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(value, "steer_surface_session", ["sessionId", "message"], ["changeId"]);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			if (!isUuid(raw.sessionId)) throw new CloudToolArgumentRefusal("sessionId must be a valid UUID");
			let message: string;
			try {
				message = parseBoundedText(raw.message, "message", SURFACE_MAX_PROMPT_CHARS).trim();
			} catch {
				throw new CloudToolArgumentRefusal(`message must be 1..${SURFACE_MAX_PROMPT_CHARS} characters`);
			}
			if (!message) throw new CloudToolArgumentRefusal("message must not be blank");
			let changeId: string | null = null;
			if (raw.changeId !== undefined && raw.changeId !== null) {
				if (!isUuid(raw.changeId)) throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
				changeId = raw.changeId;
			}
			return { sessionId: raw.sessionId, message, changeId };
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as SteerSurfaceSessionRequest;
			const result = await port.steerSurfaceSession(parsed, context);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-session-steered/v1",
					sessionId: result.sessionId,
					state: result.state,
				}),
			};
		},
	};
}

export interface SurfaceLayoutStaging {
	readonly folderRoot: string;
	readonly waitingOps: readonly StudioPatchOp[] | null;
	readLayout(signal: AbortSignal): Promise<string | null>;
	readText?(relativePath: string, signal: AbortSignal): Promise<string | null>;
}

export type StagedLayoutCheck = "checked" | "unchecked";

export const LAYOUT_UNCHECKED_NOTE =
	"The layout was not checked: an earlier change of this session to it may still be waiting, and this turn cannot see it.";

function mergeLayoutJson(base: unknown, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const target: Record<string, unknown> =
		base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (DISALLOWED_MERGE_JSON_KEYS.has(key)) continue;
		const prior = target[key];
		if (value === null) delete target[key];
		else if (
			typeof value === "object" &&
			!Array.isArray(value) &&
			prior &&
			typeof prior === "object" &&
			!Array.isArray(prior)
		)
			target[key] = mergeLayoutJson(prior, value as Record<string, unknown>);
		else target[key] = structuredClone(value);
	}
	return target;
}

const LAYOUT_REFUSAL_PREFIX = `${SURFACE_LAYOUT_PATH} would not draw:`;
const LAYOUT_REFUSAL_FIX = "Fix it and stage the patch again; nothing was staged.";
const REPORT_FILE_RE = /\.report\.json$/i;
const STANDALONE_HTML_FILE_RE = /\.html?$/i;
const TALK_FILE_RE = new RegExp(`(?:^|/)${SURFACE_TALK_FILE.replace(".", "\\.")}$`, "i");
const LANDSCAPE_DEFAULT_FILE = "landscape.json";
const TALK_RIVALS_MAX = 60;
const MODULE_PATH_RE = /(?:^|\/)modules\/[^/]+\//i;
const REPORT_BLOCK_KINDS = new Set(["quote", "bar_chart", "line_chart", "table", "callout", "figure"]);

function layoutRefusal(problem: string): CloudToolRefusal {
	const plain = problem.replace(/[^\u0020-\u007e]/g, "?");
	const room = 1000 - LAYOUT_REFUSAL_PREFIX.length - LAYOUT_REFUSAL_FIX.length - 4;
	return new CloudToolRefusal(
		`${LAYOUT_REFUSAL_PREFIX} ${plain.length > room ? `${plain.slice(0, room)}...` : plain}. ${LAYOUT_REFUSAL_FIX}`,
	);
}

function reportRefusal(path: string, problem: string): CloudToolRefusal {
	const rawPath = path.replace(/[^\u0020-\u007e]/g, "?");
	const safePath = rawPath.length > 160 ? `${rawPath.slice(0, 157)}...` : rawPath;
	const prefix = `${safePath} would not render as a report:`;
	const fix = "Fix it to match the *.report.json format and stage again; nothing was staged.";
	const plain = problem.replace(/[^\u0020-\u007e]/g, "?");
	const room = Math.max(80, 1000 - prefix.length - fix.length - 4);
	return new CloudToolRefusal(`${prefix} ${plain.length > room ? `${plain.slice(0, room)}...` : plain}. ${fix}`);
}

function talkRefusal(path: string, problems: readonly string[]): CloudToolRefusal {
	const rawPath = path.replace(/[^\u0020-\u007e]/g, "?");
	const safePath = rawPath.length > 160 ? `${rawPath.slice(0, 157)}...` : rawPath;
	const prefix = `${safePath} is not a talk the founder can be shown:`;
	const fix = "Fix it and stage the talk whole again; nothing was staged.";
	const plain = problems.join("; ").replace(/[^\u0020-\u007e]/g, "?");
	const room = Math.max(80, 1000 - prefix.length - fix.length - 4);
	return new CloudToolRefusal(`${prefix} ${plain.length > room ? `${plain.slice(0, room)}...` : plain}. ${fix}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stagedTalk(path: string, content: string, rivals: readonly string[] = []): SurfaceTalk {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw talkRefusal(path, ["content is not valid JSON"]);
	}
	const read = readSurfaceTalk(parsed, { rivals });
	if (!read.talk) throw talkRefusal(path, read.problems);
	return read.talk;
}

function nonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function validateReportBlock(block: unknown, path: string, label: string): void {
	if (!isPlainRecord(block)) throw reportRefusal(path, `${label} must be an object`);
	const kind = typeof block.kind === "string" ? block.kind : "";
	if (!REPORT_BLOCK_KINDS.has(kind)) {
		throw reportRefusal(path, `${label}.kind must be one of quote, bar_chart, line_chart, table, callout, figure`);
	}
	if (kind === "quote") {
		if (!nonEmptyString(block.text)) throw reportRefusal(path, `${label} (quote) needs a non-empty text`);
		return;
	}
	if (kind === "bar_chart") {
		if (!Array.isArray(block.items) || !block.items.some(isPlainRecord)) {
			throw reportRefusal(path, `${label} (bar_chart) needs a non-empty items array`);
		}
		return;
	}
	if (kind === "line_chart") {
		const validSeries =
			Array.isArray(block.series) &&
			block.series.some((entry) => isPlainRecord(entry) && Array.isArray(entry.values) && entry.values.length > 1);
		if (!validSeries) {
			throw reportRefusal(path, `${label} (line_chart) needs series entries with at least 2 numeric values`);
		}
		return;
	}
	if (kind === "table") {
		if (!Array.isArray(block.columns) || block.columns.length === 0 || !Array.isArray(block.rows)) {
			throw reportRefusal(path, `${label} (table) needs non-empty columns and rows arrays`);
		}
		return;
	}
	if (kind === "callout") {
		if (!nonEmptyString(block.body) && !nonEmptyString(block.heading) && !nonEmptyString(block.title)) {
			throw reportRefusal(path, `${label} (callout) needs a non-empty heading or body`);
		}
		return;
	}
	if (!Array.isArray(block.panels) || !block.panels.some(isPlainRecord)) {
		throw reportRefusal(path, `${label} (figure) needs a non-empty panels array`);
	}
}

function validateReportSections(sections: unknown, path: string): void {
	if (!Array.isArray(sections) || sections.length === 0) {
		throw reportRefusal(path, "sections must be a non-empty array");
	}
	for (let i = 0; i < sections.length; i += 1) {
		const section = sections[i];
		const label = `sections[${i}]`;
		if (!isPlainRecord(section)) throw reportRefusal(path, `${label} must be an object`);
		if (!nonEmptyString(section.heading) && !nonEmptyString(section.title)) {
			throw reportRefusal(path, `${label} needs a non-empty heading`);
		}
		const hasParagraphs =
			Array.isArray(section.paragraphs) && section.paragraphs.some((item) => nonEmptyString(item));
		if (section.paragraphs !== undefined && !Array.isArray(section.paragraphs)) {
			throw reportRefusal(path, `${label}.paragraphs must be an array of strings`);
		}
		if (section.blocks !== undefined) {
			if (!Array.isArray(section.blocks)) throw reportRefusal(path, `${label}.blocks must be an array`);
			for (let j = 0; j < section.blocks.length; j += 1) {
				validateReportBlock(section.blocks[j], path, `${label}.blocks[${j}]`);
			}
		}
		const hasBlocks = Array.isArray(section.blocks) && section.blocks.length > 0;
		if (!hasParagraphs && !hasBlocks) {
			throw reportRefusal(path, `${label} needs at least one non-empty paragraph or block`);
		}
	}
}

function validateReportMetrics(metrics: unknown, path: string): void {
	if (!Array.isArray(metrics)) throw reportRefusal(path, "keyMetrics must be an array");
	for (let i = 0; i < metrics.length; i += 1) {
		const metric = metrics[i];
		if (!isPlainRecord(metric) || !nonEmptyString(metric.label) || !nonEmptyString(metric.value)) {
			throw reportRefusal(path, `keyMetrics[${i}] needs non-empty string label and value`);
		}
	}
}

function checkReportEvidence(report: Readonly<Record<string, unknown>>, path: string): void {
	try {
		parseSurfaceReportEvidence(report, { path });
	} catch (error) {
		if (error instanceof WireValueError) throw reportRefusal(path, error.message);
		throw error;
	}
}

export function checkStagedSurfaceDeliverables(
	ops: readonly StudioPatchOp[],
	options?: { readonly allowMultipleDeliverables?: boolean },
): void {
	const deliverablePaths = new Set<string>();
	for (const op of ops) {
		if (op.op === "delete") continue;
		const normalized = op.path
			.trim()
			.replace(/^\/+|\/+$/g, "")
			.toLowerCase();
		if (TALK_FILE_RE.test(op.path)) {
			deliverablePaths.add(normalized);
			if (op.op === "merge_json")
				throw talkRefusal(op.path, ["a talk is written whole, with write_text, never merged"]);
			if (op.op === "write_text") stagedTalk(op.path, op.content);
		} else if (REPORT_FILE_RE.test(op.path)) {
			deliverablePaths.add(normalized);
			if (op.op === "write_text") {
				let parsed: unknown;
				try {
					parsed = JSON.parse(op.content);
				} catch {
					throw reportRefusal(op.path, "content is not valid JSON");
				}
				if (!isPlainRecord(parsed)) throw reportRefusal(op.path, "top-level value must be a JSON object");
				if (!nonEmptyString(parsed.headline) && !nonEmptyString(parsed.title)) {
					throw reportRefusal(op.path, "needs a non-empty headline string");
				}
				if (parsed.keyMetrics !== undefined) validateReportMetrics(parsed.keyMetrics, op.path);
				validateReportSections(parsed.sections, op.path);
				checkReportEvidence(parsed, op.path);
			} else if (op.op === "merge_json") {
				const patch = op.patch;
				if (patch.headline !== undefined && !nonEmptyString(patch.headline)) {
					throw reportRefusal(op.path, "headline must be a non-empty string");
				}
				if (patch.keyMetrics !== undefined) validateReportMetrics(patch.keyMetrics, op.path);
				if (patch.sections !== undefined) validateReportSections(patch.sections, op.path);
				const whole = SURFACE_REPORT_RESEARCH_KEYS.filter((key) => patch[key] !== undefined);
				if (whole.length > 0) {
					throw reportRefusal(
						op.path,
						`${whole.join(", ")} cannot be merged: a research post's question, short answer, sources, method and not-found list are written whole, with write_text`,
					);
				}
				if (patch.theme === null) {
					throw reportRefusal(
						op.path,
						"theme cannot be removed by a merge: a research post needs it; write the post whole, with write_text",
					);
				}
				const marked = surfaceReportMarkedKey(patch);
				if (marked !== undefined) {
					throw reportRefusal(
						op.path,
						`${marked} carries a source mark in a merge: a mark is read against the post's sources, so a post with marks is written whole, with write_text`,
					);
				}
				checkReportEvidence(
					Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)),
					op.path,
				);
			}
		} else if (STANDALONE_HTML_FILE_RE.test(op.path) && !MODULE_PATH_RE.test(normalized)) {
			deliverablePaths.add(normalized);
		}
	}
	if (!options?.allowMultipleDeliverables && deliverablePaths.size > 1) {
		throw new CloudToolRefusal(
			"Stage each report (*.report.json) or standalone HTML document in its own stage_surface_patch call so members can preview, toggle, and approve each deliverable independently. Nothing was staged.",
		);
	}
}

async function pageRivals(staging: SurfaceLayoutStaging, signal: AbortSignal): Promise<string[]> {
	const read = staging.readText;
	if (!read) return [];
	const layoutText = await staging.readLayout(signal);
	const layout = layoutText === null ? undefined : readSurfaceLayout(layoutText);
	const files = new Set<string>();
	if (layout && "layout" in layout) {
		for (const tab of layout.layout.tabs)
			for (const node of tab.blocks)
				for (const block of node.type === "row" ? node.blocks : [node]) {
					if (block.type !== "landscape") continue;
					for (const source of [block.from].flat()) {
						if (typeof source !== "string") continue;
						try {
							files.add(parseSurfaceBinding(source).path);
						} catch {}
					}
				}
	} else files.add(LANDSCAPE_DEFAULT_FILE);
	const names: string[] = [];
	for (const file of files) {
		if (file.startsWith("/")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse((await read(file, signal)) ?? "");
		} catch {
			continue;
		}
		const players = isPlainRecord(parsed) && Array.isArray(parsed.players) ? parsed.players : [];
		for (const player of players)
			if (
				isPlainRecord(player) &&
				player.isUs !== true &&
				nonEmptyString(player.name) &&
				names.length < TALK_RIVALS_MAX
			)
				names.push((player.name as string).trim());
	}
	return names;
}

export async function checkStagedSurfaceTalks(
	ops: readonly StudioPatchOp[],
	staging: SurfaceLayoutStaging,
	signal: AbortSignal,
): Promise<void> {
	const read = staging.readText;
	if (!read) return;
	const relative = (path: string): string => {
		const clean = path.trim().replace(/^\/+|\/+$/g, "");
		return clean.startsWith(`${staging.folderRoot}/`) ? clean.slice(staging.folderRoot.length + 1) : clean;
	};
	const written = new Set(ops.filter((op) => op.op !== "delete").map((op) => relative(op.path).toLowerCase()));
	let rivals: readonly string[] | undefined;
	for (const op of ops) {
		if (op.op !== "write_text" || !TALK_FILE_RE.test(op.path)) continue;
		let talk = stagedTalk(op.path, op.content);
		if (surfaceTalkStarter(talk.starter)?.never.includes("rivals")) {
			rivals ??= await pageRivals(staging, signal);
			talk = stagedTalk(op.path, op.content, rivals);
		}
		for (const post of surfaceTalkPosts(talk)) {
			if (post.startsWith("/") || written.has(relative(post).toLowerCase())) continue;
			if ((await read(relative(post), signal)) === null)
				throw talkRefusal(op.path, [
					`a picture rests on ${post}, which is not in this folder: a picture rests on a post that exists, on a bet, on the plan or on the founders' own words`,
				]);
		}
	}
}

export async function checkStagedSurfaceLayout(
	ops: readonly StudioPatchOp[],
	layout: SurfaceLayoutStaging,
	signal: AbortSignal,
): Promise<StagedLayoutCheck> {
	let layoutPath: string;
	try {
		layoutPath = resolveStudioFolderPath(layout.folderRoot, SURFACE_LAYOUT_PATH);
	} catch {
		return "checked";
	}
	const onLayout = (op: StudioPatchOp): boolean => {
		try {
			return resolveStudioFolderPath(layout.folderRoot, op.path) === layoutPath;
		} catch {
			return false;
		}
	};
	const staged = ops.filter(onLayout);
	if (staged.length === 0) return "checked";
	const state: { text: string | null | undefined; known: boolean } = {
		text: undefined,
		known: layout.waitingOps !== null,
	};
	const apply = async (op: StudioPatchOp, waiting: boolean): Promise<void> => {
		if (op.op === "write_text") {
			state.text = op.content;
			state.known = true;
		} else if (op.op === "delete") {
			state.text = null;
			state.known = true;
		} else if (op.op === "write_file") {
			if (!waiting) throw layoutRefusal("it must be written as text with write_text");
			state.known = false;
		} else if (state.known) {
			const prior = state.text === undefined ? await layout.readLayout(signal) : state.text;
			let parsed: unknown = {};
			if (prior !== null && prior.trim().length > 0) {
				try {
					parsed = JSON.parse(prior);
				} catch {
					if (!waiting) throw layoutRefusal("the file it merges into is not JSON; write it whole with write_text");
					state.known = false;
					return;
				}
			}
			state.text = `${JSON.stringify(mergeLayoutJson(parsed, op.patch), null, 2)}\n`;
		}
	};
	for (const op of (layout.waitingOps ?? []).filter(onLayout)) await apply(op, true);
	for (const op of staged) await apply(op, false);
	if (!state.known) return "unchecked";
	if (state.text === undefined || state.text === null) return "checked";
	try {
		parseSurfaceLayoutText(state.text);
	} catch (error) {
		throw layoutRefusal(error instanceof Error ? error.message : "it does not parse");
	}
	return "checked";
}

export interface SurfaceChangeMetadata {
	readonly title: string;
	readonly summary: string;
	readonly optionGroupKey: string | null;
}

export interface SurfacePatchSessionTracker {
	readonly openChanges: readonly SurfaceSessionOpenChange[];
	readonly openById: ReadonlyMap<string, SurfaceSessionOpenChange>;
	readonly currentOpsByChangeId: ReadonlyMap<string, readonly StudioPatchOp[]>;
	readonly stagedEntries: readonly { readonly changeId: string | null; readonly ops: readonly StudioPatchOp[] }[];
	getChangeMeta(changeId: string): SurfaceChangeMetadata | undefined;
	resolveTargetChangeId(input: {
		readonly explicitChangeId: string | null;
		readonly createNew: boolean;
		readonly optionGroup?: string | null;
	}): string | null;
	recordStaged(input: {
		readonly targetChangeId: string | null;
		readonly resultChangeId: string;
		readonly ops: readonly StudioPatchOp[];
		readonly replaceAll?: boolean;
		readonly optionGroup?: string | null;
		readonly title?: string;
		readonly summary?: string;
	}): void;
}

export function createSurfacePatchSessionTracker(
	options: SurfaceFollowUpChangeOptions & { readonly folderRoot?: string } = {},
): SurfacePatchSessionTracker {
	const openChanges = (options.openChanges ?? []).filter((item) => item.kind === "folder_patch");
	const openById = new Map(openChanges.map((item) => [item.changeId, item]));
	const replyChangeId = options.replyChangeId?.trim() || null;
	const isInternalReconciliation = options.isInternalReconciliation === true;
	const updatedInTurn = new Set<string>();
	const stagedInTurnIds = new Set<string>();
	const currentOpsByChangeId = new Map<string, readonly StudioPatchOp[]>();
	const changeMetaById = new Map<string, SurfaceChangeMetadata>();
	for (const item of openChanges) {
		if (item.patchManifest && item.patchManifest.length > 0) {
			currentOpsByChangeId.set(item.changeId, item.patchManifest);
		}
		changeMetaById.set(item.changeId, {
			title: item.title,
			summary: item.summary,
			optionGroupKey: item.optionGroupKey ?? null,
		});
	}
	const stagedEntries: Array<{ readonly changeId: string | null; readonly ops: readonly StudioPatchOp[] }> = [];
	return {
		openChanges,
		openById,
		currentOpsByChangeId,
		stagedEntries,
		getChangeMeta(changeId) {
			return changeMetaById.get(changeId);
		},
		resolveTargetChangeId(input) {
			if (input.explicitChangeId && stagedInTurnIds.has(input.explicitChangeId)) {
				if (input.createNew) {
					throw new CloudToolArgumentRefusal(
						"Pass either changeId to update an existing change in place or createNew: true to add a separate new change, not both.",
					);
				}
				const existingMeta = changeMetaById.get(input.explicitChangeId);
				if (input.optionGroup && existingMeta && existingMeta.optionGroupKey !== input.optionGroup) {
					throw new CloudToolArgumentRefusal(
						"Cannot change optionGroup when updating an existing change; omit changeId or pass createNew: true to stage an option in a different group.",
					);
				}
				return input.explicitChangeId;
			}
			return resolveFollowUpTargetChangeId({
				explicitChangeId: input.explicitChangeId,
				createNew: input.createNew,
				optionGroup: input.optionGroup ?? null,
				openChanges,
				replyChangeId,
				updatedInTurn,
				isInternalReconciliation,
			});
		},
		recordStaged(input) {
			const effectiveId = input.targetChangeId ?? input.resultChangeId;
			const targetOpen = input.targetChangeId ? openById.get(input.targetChangeId) : undefined;
			const prevMeta = changeMetaById.get(effectiveId);
			stagedInTurnIds.add(input.resultChangeId);
			if (input.targetChangeId) {
				updatedInTurn.add(input.targetChangeId);
			}
			const prevOps = input.replaceAll ? [] : (currentOpsByChangeId.get(effectiveId) ?? []);
			const nextOps = input.replaceAll
				? input.ops
				: mergeFolderPatchOps(options.folderRoot, prevOps, input.ops, targetOpen?.baseFiles ?? null);
			currentOpsByChangeId.set(effectiveId, nextOps);
			if (input.replaceAll && input.targetChangeId) {
				for (let i = stagedEntries.length - 1; i >= 0; i -= 1) {
					if (stagedEntries[i]?.changeId === input.targetChangeId) stagedEntries.splice(i, 1);
				}
			}
			const resolvedGroup = input.optionGroup ?? prevMeta?.optionGroupKey ?? targetOpen?.optionGroupKey ?? null;
			const nextTitle = input.title ?? prevMeta?.title ?? targetOpen?.title ?? "";
			const nextSummary = input.summary ?? prevMeta?.summary ?? targetOpen?.summary ?? "";
			if (nextTitle || prevMeta) {
				changeMetaById.set(input.resultChangeId, {
					title: nextTitle,
					summary: nextSummary,
					optionGroupKey: resolvedGroup,
				});
			}
			if (!resolvedGroup) {
				stagedEntries.push({ changeId: input.resultChangeId, ops: input.ops });
			}
		},
	};
}

export interface StageSurfacePatchToolOptions extends SurfaceFollowUpChangeOptions {
	readonly deferSessionCompletion?: boolean;
	readonly allowMultipleDeliverables?: boolean;
	readonly tracker?: SurfacePatchSessionTracker;
}

export function createStageSurfacePatchTool(
	sessionId: string,
	port: SurfacePatchToolPort,
	layout?: SurfaceLayoutStaging,
	options: StageSurfacePatchToolOptions = {},
): CloudNativeTool {
	const tracker =
		options.tracker ??
		createSurfacePatchSessionTracker({
			...options,
			...(layout?.folderRoot ? { folderRoot: layout.folderRoot } : {}),
		});
	const { openChanges, openById, currentOpsByChangeId, stagedEntries } = tracker;
	const schemaProperties: Record<string, JsonValue> = {
		title: {
			type: "string",
			minLength: 1,
			maxLength: SURFACE_MAX_CHANGE_TITLE_CHARS,
			description: "Short plain founder-facing title for this single staged change.",
		},
		summary: {
			type: "string",
			maxLength: SURFACE_MAX_CHANGE_SUMMARY_CHARS,
			description: "1-2 sentences describing what the founder will see in this change.",
		},
		ops: {
			type: "array",
			minItems: 1,
			maxItems: 256,
			description: options.allowMultipleDeliverables
				? "Ordered StudioPatchOp entries (write_text, delete, or merge_json) relative to the surface folder root."
				: "Ordered StudioPatchOp entries (write_text, delete, or merge_json) relative to the surface folder root. Keep each call scoped to one deliverable: stage each *.report.json article or standalone .html document in its own call.",
			items: {
				type: "object",
				additionalProperties: true,
				required: ["op", "path"],
				properties: {
					op: { type: "string", enum: ["write_text", "delete", "merge_json"] },
					path: { type: "string", minLength: 1, maxLength: MAX_SURFACE_PATH_CHARS },
					content: { type: "string" },
					patch: { type: "object", additionalProperties: true },
				},
			},
		},
		notePaths: {
			type: "array",
			maxItems: MAX_SURFACE_NOTE_PATHS,
			items: { type: "string", minLength: 1, maxLength: MAX_SURFACE_PATH_CHARS },
			description: "Optional supporting rationale note paths under the surface notes folder.",
		},
		changeId: {
			type: "string",
			description:
				"Optional UUID of an existing open ChangeUnit in this session to update in place instead of creating a new change.",
		},
		createNew: {
			type: "boolean",
			description:
				"Set true when intentionally staging a separate new ChangeUnit alongside existing open changes in this session.",
		},
		replaceAll: {
			type: "boolean",
			description:
				"Only when updating an existing change via changeId: set true to replace its entire patch manifest from scratch instead of merging with untouched paths from the prior version.",
		},
		optionGroup: {
			type: "string",
			maxLength: SURFACE_MAX_OPTION_GROUP_KEY_CHARS,
			description:
				"Optional lower-case hyphenated key (e.g. 'palette-direction') grouping mutually exclusive real options into one multiple-choice block in Changes.",
		},
		optionGroupTitle: {
			type: "string",
			maxLength: SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
			description: "Optional plain founder-facing heading for the optionGroup multiple-choice block.",
		},
		supersedeKey: {
			type: "string",
			maxLength: SURFACE_MAX_SUPERSEDE_KEY_CHARS,
			description:
				"Optional stable lower-case key (e.g. 'daily-metrics-refresh') for recurring upkeep updates; staging a new change with this key automatically supersedes earlier unapproved changes on the same Surface with the same key.",
		},
	};
	if (!options.deferSessionCompletion) {
		schemaProperties.finishSession = {
			type: "boolean",
			description: "Set true when this patch completes the turn and marks the session ready for review.",
		};
	}
	return {
		name: "stage_surface_patch",
		source: "worker",
		description: options.allowMultipleDeliverables
			? "Stage one cohesive folder_patch ChangeUnit on a Studio, Report, or Identity Surface session covering all requested paths in a single call. Write reports as valid *.report.json articles when updating report deliverables."
			: "Stage one cohesive folder_patch ChangeUnit on a Studio, Report, or Identity Surface session, or update an existing open ChangeUnit in place by passing its changeId. Call this tool once per independent deliverable (for example, one call per report, article, blog post, or page section) so members can toggle, preview, and approve each piece individually; never bundle multiple reports or standalone HTML documents into one call. When a follow-up revises an existing open change, pass its changeId to update it in place (ops merge by path unless replaceAll: true); pass createNew: true only when adding a separate new deliverable. Write reports and blog posts as *.report.json articles (or self-contained .html when bespoke layout is needed) rather than raw .md files. To offer 2-4 mutually exclusive design or content options inside this session as a sidebar multiple choice, pass the same optionGroup slug (and optional optionGroupTitle) on each standalone option patch.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["title", "summary", "ops"],
			properties: schemaProperties,
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"stage_surface_patch",
					["title", "summary", "ops"],
					[
						"notePaths",
						"finishSession",
						"changeId",
						"createNew",
						"replaceAll",
						"optionGroup",
						"optionGroupTitle",
						"supersedeKey",
					],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			let title: string;
			let summary: string;
			try {
				title = parseBoundedText(raw.title, "title", SURFACE_MAX_CHANGE_TITLE_CHARS).trim();
				summary = parseBoundedText(raw.summary, "summary", SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0).trim();
			} catch {
				throw new CloudToolArgumentRefusal("title and summary must be valid bounded text");
			}
			let ops: StudioPatchOp[];
			try {
				ops = parseStudioPatchOps(raw.ops, "ops");
			} catch (error) {
				throw new CloudToolArgumentRefusal(
					error instanceof Error ? error.message : "ops must be valid StudioPatchOp entries",
				);
			}
			if (ops.length === 0) {
				throw new CloudToolArgumentRefusal("ops must contain at least one patch operation");
			}
			const normalizedOps: StudioPatchOp[] = ops.map((op, index) => {
				const safePath = assertSafeRelativePath(op.path, `ops[${index}].path`);
				if (op.op === "write_text") return { op: "write_text", path: safePath, content: op.content };
				if (op.op === "delete") return { op: "delete", path: safePath };
				if (op.op === "write_file") {
					throw new CloudToolArgumentRefusal(
						`ops[${index}].op write_file is not available in stage_surface_patch`,
					);
				}
				validateMergeJsonValue(op.patch, `ops[${index}].patch`, 0);
				return { op: "merge_json", path: safePath, patch: op.patch };
			});
			if (Buffer.byteLength(JSON.stringify(normalizedOps), "utf8") > MAX_STAGE_SURFACE_PATCH_BYTES) {
				throw new CloudToolArgumentRefusal(`ops exceeds ${MAX_STAGE_SURFACE_PATCH_BYTES} bytes`);
			}
			const notePaths = parseOptionalNotePathsArg(raw.notePaths);
			const parsedFinishSession = parseBooleanArg(raw.finishSession, "finishSession", false);
			const finishSession = options.deferSessionCompletion ? false : parsedFinishSession;
			const groupArgs = parseOptionGroupArgs(raw);
			const supersedeKey = parseSupersedeKeyArg(raw);
			let explicitChangeId: string | null = null;
			if (raw.changeId !== undefined && raw.changeId !== null) {
				if (!isUuid(raw.changeId)) {
					throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
				}
				explicitChangeId = raw.changeId;
			}
			const createNew = parseBooleanArg(raw.createNew, "createNew", false);
			const replaceAll = parseBooleanArg(raw.replaceAll, "replaceAll", false);
			const targetChangeId = tracker.resolveTargetChangeId({
				explicitChangeId,
				createNew,
				optionGroup: groupArgs.optionGroup ?? null,
			});
			if (replaceAll && !targetChangeId) {
				throw new CloudToolArgumentRefusal("replaceAll can only be used when updating an existing open change");
			}
			return {
				title,
				summary,
				ops: normalizedOps as unknown as JsonValue,
				notePaths,
				finishSession,
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(replaceAll ? { replaceAll: true } : {}),
				...groupArgs,
				...(supersedeKey !== undefined ? { supersedeKey } : {}),
			};
		},
		async prepare(parsed: JsonValue, context: CloudToolContext): Promise<JsonValue> {
			const req = parsed as unknown as StageSurfacePatchRequest;
			const targetId = req.changeId ?? null;
			const existingOps = targetId && !req.replaceAll ? currentOpsByChangeId.get(targetId) : undefined;
			const existingBaseFiles = targetId ? (openById.get(targetId)?.baseFiles ?? null) : null;
			const deliverableOps = existingOps
				? mergeFolderPatchOps(layout?.folderRoot, existingOps, req.ops, existingBaseFiles)
				: req.ops;
			checkStagedSurfaceDeliverables(deliverableOps, {
				allowMultipleDeliverables: options.allowMultipleDeliverables,
			});
			if (!layout) return parsed;
			await checkStagedSurfaceTalks(deliverableOps, layout, context.signal);
			let waitingOps: readonly StudioPatchOp[] | null;
			if (targetId && req.replaceAll) {
				const allOtherKnown = openChanges.every(
					(item) =>
						item.changeId === targetId ||
						Boolean(item.optionGroupKey) ||
						(item.patchManifest !== null && !item.truncated),
				);
				if (allOtherKnown) {
					const otherOpenOps = openChanges.flatMap((item) =>
						item.changeId === targetId || item.optionGroupKey
							? []
							: [...(currentOpsByChangeId.get(item.changeId) ?? item.patchManifest ?? [])],
					);
					const otherTurnOps = stagedEntries.flatMap((entry) =>
						entry.changeId === targetId ? [] : [...entry.ops],
					);
					waitingOps = [...otherOpenOps, ...otherTurnOps];
				} else {
					waitingOps = null;
				}
			} else if (
				targetId &&
				(openById.get(targetId)?.optionGroupKey || tracker.getChangeMeta(targetId)?.optionGroupKey)
			) {
				const targetPriorOps = currentOpsByChangeId.get(targetId);
				if (targetPriorOps === undefined || layout.waitingOps === null) {
					waitingOps = null;
				} else {
					const turnOps = stagedEntries.flatMap((entry) => [...entry.ops]);
					waitingOps = [...layout.waitingOps, ...targetPriorOps, ...turnOps];
				}
			} else {
				const turnOps = stagedEntries.flatMap((entry) => [...entry.ops]);
				waitingOps = layout.waitingOps === null ? null : [...layout.waitingOps, ...turnOps];
			}
			const check = await checkStagedSurfaceLayout(
				req.ops,
				{
					...layout,
					waitingOps,
				},
				context.signal,
			);
			return check === "unchecked" ? { ...(parsed as Record<string, JsonValue>), layoutUnchecked: true } : parsed;
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as StageSurfacePatchRequest & { readonly layoutUnchecked?: boolean };
			let result: SurfaceChangeStagedResult;
			try {
				result = await port.stageSurfacePatch(sessionId, parsed, context);
			} catch (error) {
				relayControlRefusal(error);
			}
			tracker.recordStaged({
				targetChangeId: parsed.changeId ?? null,
				resultChangeId: result.changeId,
				ops: parsed.ops,
				replaceAll: parsed.replaceAll === true,
				optionGroup: parsed.optionGroup ?? null,
				title: parsed.title,
				summary: parsed.summary,
			});
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-patch-staged/v1",
					sessionId,
					changeId: result.changeId,
					seq: result.seq,
					openChangeCount: result.openChangeCount,
					opCount: parsed.ops.length,
					notePaths: [...parsed.notePaths],
					...(options.deferSessionCompletion ? {} : { finishSession: parsed.finishSession }),
					staged: true,
					...(result.updated === true ? { updated: true } : {}),
					...(parsed.layoutUnchecked === true ? { note: LAYOUT_UNCHECKED_NOTE } : {}),
				}),
			};
		},
	};
}

export function createStageSurfaceOpsActionTool(
	sessionId: string,
	port: SurfaceOpsActionToolPort,
	options: SurfaceFollowUpChangeOptions = {},
): CloudNativeTool {
	const openChanges = (options.openChanges ?? []).filter((item) => item.kind === "ops_action");
	const replyChangeId = options.replyChangeId?.trim() || null;
	const isInternalReconciliation = options.isInternalReconciliation === true;
	const updatedInTurn = new Set<string>();
	return {
		name: "stage_surface_ops_action",
		source: "worker",
		description:
			"Stage a structured ops_action ChangeUnit on an operational Surface session (inbox, money, data, files, members), or update an existing open Action card in place by passing its changeId. Pass createNew: true only when staging an additional separate action alongside existing open actions.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["title", "summary", "actionKind", "actionPayload"],
			properties: {
				title: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_TITLE_CHARS,
					description: "Short plain founder-facing title for this operational action.",
				},
				summary: {
					type: "string",
					maxLength: SURFACE_MAX_CHANGE_SUMMARY_CHARS,
					description: "1-2 sentences describing what this action will do when approved.",
				},
				actionKind: {
					type: "string",
					minLength: 1,
					maxLength: 80,
					pattern: OPS_ACTION_KIND_PATTERN.source,
					description: "Action kind identifier (e.g. inbox.draft_email, money.prepare_payment, data.upsert_row).",
				},
				actionPayload: {
					type: "object",
					additionalProperties: true,
					description: "JSON record holding the structured fields for the staged action or draft.",
				},
				finishSession: {
					type: "boolean",
					description: "Set true when this action completes the turn and marks the session ready for approval.",
				},
				changeId: {
					type: "string",
					description:
						"Optional UUID of an existing open ops_action ChangeUnit in this session to update in place instead of creating a duplicate Action card.",
				},
				createNew: {
					type: "boolean",
					description:
						"Set true when intentionally staging an additional separate action alongside existing open actions in this session.",
				},
				supersedeKey: {
					type: "string",
					maxLength: SURFACE_MAX_SUPERSEDE_KEY_CHARS,
					description:
						"Optional stable lower-case key for recurring upkeep actions; staging a new action with this key automatically supersedes earlier unapproved actions on the same Surface with the same key.",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"stage_surface_ops_action",
					["title", "summary", "actionKind", "actionPayload"],
					["finishSession", "changeId", "createNew", "supersedeKey"],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			let title: string;
			let summary: string;
			let actionKind: string;
			try {
				title = parseBoundedText(raw.title, "title", SURFACE_MAX_CHANGE_TITLE_CHARS).trim();
				summary = parseBoundedText(raw.summary, "summary", SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0).trim();
				actionKind = parseBoundedText(raw.actionKind, "actionKind", 80).trim();
			} catch {
				throw new CloudToolArgumentRefusal("title, summary, and actionKind must be valid bounded text");
			}
			if (!OPS_ACTION_KIND_PATTERN.test(actionKind)) {
				throw new CloudToolArgumentRefusal(
					"actionKind must use letters, digits, dots, colons, underscores, or hyphens",
				);
			}
			let actionPayload: Record<string, unknown>;
			try {
				actionPayload = parseRecord(raw.actionPayload, "actionPayload");
			} catch {
				throw new CloudToolArgumentRefusal("actionPayload must be a JSON object");
			}
			if (Buffer.byteLength(JSON.stringify(actionPayload)) > MAX_OPS_ACTION_PAYLOAD_BYTES) {
				throw new CloudToolArgumentRefusal("actionPayload exceeds maximum size");
			}
			const finishSession = parseBooleanArg(raw.finishSession, "finishSession", false);
			const supersedeKey = parseSupersedeKeyArg(raw);
			let explicitChangeId: string | null = null;
			if (raw.changeId !== undefined && raw.changeId !== null) {
				if (!isUuid(raw.changeId)) {
					throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
				}
				explicitChangeId = raw.changeId;
			}
			const createNew = parseBooleanArg(raw.createNew, "createNew", false);
			const targetChangeId = resolveFollowUpTargetChangeId({
				explicitChangeId,
				createNew,
				openChanges,
				replyChangeId,
				updatedInTurn,
				isInternalReconciliation,
			});
			return {
				title,
				summary,
				actionKind,
				actionPayload: actionPayload as JsonValue,
				finishSession,
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(supersedeKey !== undefined ? { supersedeKey } : {}),
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as StageSurfaceOpsActionRequest;
			let result: SurfaceChangeStagedResult;
			try {
				result = await port.stageSurfaceOpsAction(sessionId, parsed, context);
			} catch (error) {
				relayControlRefusal(error);
			}
			if (parsed.changeId) {
				updatedInTurn.add(parsed.changeId);
			}
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-ops-action-staged/v1",
					sessionId,
					changeId: result.changeId,
					seq: result.seq,
					openChangeCount: result.openChangeCount,
					actionKind: parsed.actionKind,
					finishSession: parsed.finishSession,
					staged: true,
					...(result.updated === true ? { updated: true } : {}),
				}),
			};
		},
	};
}

export function createCodingPublishArtifactTool(
	sessionId: string,
	port: { publishArtifact: NonNullable<CloudSurfaceToolsPort["publishArtifact"]> },
): CloudNativeTool {
	return {
		name: "coding_publish_artifact",
		source: "worker",
		description:
			"Publish or revise a structured visual or written artifact (mockup, plan, report, checklist, or diff summary) directly inside this update track's thread so the member can review, discuss, and iterate on designs and plans alongside code changes. Reusing the same artifactKey updates the artifact in place and increments its revision.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["kind", "artifactKey", "title", "contentFormat"],
			properties: {
				kind: {
					type: "string",
					enum: [...SURFACE_SESSION_ARTIFACT_KINDS],
					description: "Category of artifact shown in the track thread and side inspector.",
				},
				artifactKey: {
					type: "string",
					maxLength: 80,
					description: "Stable lower-case key (e.g. 'checkout-mockup', 'migration-plan') within this track.",
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: 160,
					description: "Plain member-facing title for the artifact card.",
				},
				summary: {
					type: "string",
					maxLength: 2000,
					description: "Optional concise summary shown on the inline card.",
				},
				contentFormat: {
					type: "string",
					enum: [...SURFACE_SESSION_ARTIFACT_FORMATS],
					description: "Payload format: markdown, html (sandboxed preview), json, or image_ref.",
				},
				contentText: {
					type: "string",
					description: "Artifact body for markdown, html, or json formats (up to 256 KiB).",
				},
				imageRef: {
					type: "object",
					additionalProperties: false,
					required: ["sha256", "bytes", "mediaType"],
					properties: {
						sha256: { type: "string" },
						bytes: { type: "integer", minimum: 1, maximum: SURFACE_IMAGE_MAX_TOTAL_BYTES },
						mediaType: { type: "string", enum: [...SURFACE_IMAGE_MEDIA_TYPES] },
					},
					description: "Image reference when contentFormat is image_ref.",
				},
				changeId: {
					type: "string",
					description: "Optional UUID of a staged change in this track linked to the artifact.",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"coding_publish_artifact",
					["kind", "artifactKey", "title", "contentFormat"],
					["summary", "contentText", "imageRef", "changeId"],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			const kind = parseEnumArg(raw.kind, SURFACE_SESSION_ARTIFACT_KINDS, "kind");
			if (typeof raw.artifactKey !== "string") {
				throw new CloudToolArgumentRefusal("artifactKey must be a non-empty string");
			}
			const artifactKey = raw.artifactKey.trim().toLowerCase();
			if (!SURFACE_SESSION_ARTIFACT_KEY_PATTERN.test(artifactKey)) {
				throw new CloudToolArgumentRefusal(
					"artifactKey must be 1..80 lower-case letters, digits, dots, colons, underscores, or hyphens",
				);
			}
			let title: string;
			try {
				title = parseBoundedText(raw.title, "title", 160).trim();
			} catch {
				throw new CloudToolArgumentRefusal("title must be 1..160 characters");
			}
			const summary = parseOptionalBounded(raw.summary, "summary", 2000);
			const contentFormat = parseEnumArg(raw.contentFormat, SURFACE_SESSION_ARTIFACT_FORMATS, "contentFormat");
			let contentText: string | null = null;
			let imageRef: SurfaceImageRef | null = null;
			if (contentFormat === "image_ref") {
				if (raw.contentText !== undefined && raw.contentText !== null) {
					throw new CloudToolArgumentRefusal("contentText must be omitted when contentFormat is image_ref");
				}
				let imageRecord: Record<string, unknown>;
				try {
					imageRecord = parseClosedRecord(raw.imageRef, "imageRef", ["sha256", "bytes", "mediaType"]);
					imageRef = {
						sha256: parseSha256Hex(imageRecord.sha256, "imageRef.sha256"),
						bytes: parseInteger(imageRecord.bytes, "imageRef.bytes", 1, SURFACE_IMAGE_MAX_TOTAL_BYTES),
						mediaType: parseEnumArg(imageRecord.mediaType, SURFACE_IMAGE_MEDIA_TYPES, "imageRef.mediaType"),
					};
				} catch (error) {
					throw new CloudToolArgumentRefusal(
						error instanceof CloudToolArgumentRefusal
							? error.message
							: "imageRef must be a valid { sha256, bytes, mediaType } object",
					);
				}
			} else {
				if (raw.imageRef !== undefined && raw.imageRef !== null) {
					throw new CloudToolArgumentRefusal("imageRef is only allowed when contentFormat is image_ref");
				}
				if (typeof raw.contentText !== "string" || raw.contentText.trim().length === 0) {
					throw new CloudToolArgumentRefusal("contentText must be a non-empty string");
				}
				if (Buffer.byteLength(raw.contentText, "utf8") > SURFACE_SESSION_ARTIFACT_MAX_BYTES) {
					throw new CloudToolArgumentRefusal(`contentText exceeds ${SURFACE_SESSION_ARTIFACT_MAX_BYTES} bytes`);
				}
				contentText = raw.contentText;
			}
			let changeId: string | null = null;
			if (raw.changeId !== undefined && raw.changeId !== null) {
				if (!isUuid(raw.changeId)) {
					throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
				}
				changeId = raw.changeId;
			}
			return {
				kind,
				artifactKey,
				title,
				...(summary !== null ? { summary } : {}),
				contentFormat,
				...(contentText !== null ? { contentText } : {}),
				...(imageRef !== null ? { imageRef } : {}),
				...(changeId !== null ? { changeId } : {}),
			} as unknown as JsonValue;
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as CodingPublishArtifactRequest;
			let artifact: SurfaceSessionArtifact;
			try {
				artifact = await port.publishArtifact(sessionId, parsed, context);
			} catch (error) {
				relayControlRefusal(error);
			}
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-artifact-published/v1",
					sessionId,
					artifactId: artifact.id,
					artifactKey: artifact.artifactKey,
					kind: artifact.kind,
					title: artifact.title,
					revision: artifact.revision,
				}),
			};
		},
	};
}

export function createCodingReportProgressTool(
	sessionId: string,
	port: { reportProgress: NonNullable<CloudSurfaceToolsPort["reportProgress"]> },
): CloudNativeTool {
	return {
		name: "coding_report_progress",
		source: "worker",
		description:
			"Update the live status line, step checklist, and check/test summary shown in this app update track so the member can follow work in real time.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				currentActivity: {
					type: ["string", "null"],
					maxLength: 240,
					description: "Short plain-language description of what you are doing right now, or null to clear.",
				},
				progressSteps: {
					type: "array",
					maxItems: 16,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["id", "label", "status"],
						properties: {
							id: { type: "string", minLength: 1, maxLength: 48 },
							label: { type: "string", minLength: 1, maxLength: 160 },
							status: { type: "string", enum: [...SURFACE_PROGRESS_STEP_STATUSES] },
							detail: { type: ["string", "null"], maxLength: 300 },
						},
					},
					description: "Ordered checklist of up to 16 steps for this update track.",
				},
				checksSummary: {
					type: "object",
					additionalProperties: false,
					required: ["status"],
					properties: {
						status: { type: "string", enum: [...SURFACE_CHECKS_STATUSES] },
						summary: { type: ["string", "null"], maxLength: 500 },
						updatedAt: { type: ["string", "null"], maxLength: 64 },
						commands: {
							type: "array",
							maxItems: 16,
							items: {
								type: "object",
								additionalProperties: false,
								required: ["name", "status"],
								properties: {
									name: { type: "string", minLength: 1, maxLength: 120 },
									status: { type: "string", enum: [...SURFACE_CHECKS_STATUSES] },
									durationMs: { type: ["integer", "null"], minimum: 0, maximum: 999_999_999 },
								},
							},
						},
					},
					description: "Latest build, lint, or test verification summary for this track.",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"coding_report_progress",
					[],
					["currentActivity", "progressSteps", "checksSummary"],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			const hasActivity = raw.currentActivity !== undefined;
			const hasSteps = raw.progressSteps !== undefined;
			const hasChecks = raw.checksSummary !== undefined;
			if (!hasActivity && !hasSteps && !hasChecks) {
				throw new CloudToolArgumentRefusal(
					"Provide at least one of currentActivity, progressSteps, or checksSummary",
				);
			}
			let currentActivity: string | null | undefined;
			if (hasActivity) {
				if (raw.currentActivity === null) {
					currentActivity = null;
				} else if (typeof raw.currentActivity === "string") {
					const trimmed = raw.currentActivity.trim();
					if (trimmed.length > 240) {
						throw new CloudToolArgumentRefusal("currentActivity must be at most 240 characters");
					}
					currentActivity = trimmed.length > 0 ? trimmed : null;
				} else {
					throw new CloudToolArgumentRefusal("currentActivity must be a string or null");
				}
			}
			let progressSteps: SurfaceSessionProgressStep[] | undefined;
			if (hasSteps) {
				if (!Array.isArray(raw.progressSteps) || raw.progressSteps.length > 16) {
					throw new CloudToolArgumentRefusal("progressSteps must be an array of at most 16 steps");
				}
				progressSteps = raw.progressSteps.map((item, index) => {
					try {
						const closed = parseClosedRecord(
							item,
							`progressSteps[${index}]`,
							["id", "label", "status"],
							["detail"],
						);
						return parseSurfaceSessionProgressStep(closed, `progressSteps[${index}]`);
					} catch (error) {
						throw new CloudToolArgumentRefusal(
							error instanceof Error ? error.message : `progressSteps[${index}] is invalid`,
						);
					}
				});
				if (Buffer.byteLength(JSON.stringify(progressSteps), "utf8") > 8192) {
					throw new CloudToolArgumentRefusal("progressSteps exceeds 8192 bytes");
				}
			}
			let checksSummary: SurfaceSessionChecksSummary | undefined;
			if (hasChecks) {
				if (raw.checksSummary === null) {
					throw new CloudToolArgumentRefusal("checksSummary must be an object");
				}
				try {
					const closed = parseClosedRecord(
						raw.checksSummary,
						"checksSummary",
						["status"],
						["summary", "commands", "updatedAt"],
					);
					if (closed.commands !== undefined && closed.commands !== null) {
						if (!Array.isArray(closed.commands) || closed.commands.length > 16) {
							throw new CloudToolArgumentRefusal("checksSummary.commands must be an array of at most 16 items");
						}
						for (let index = 0; index < closed.commands.length; index += 1) {
							parseClosedRecord(
								closed.commands[index],
								`checksSummary.commands[${index}]`,
								["name", "status"],
								["durationMs"],
							);
						}
					}
					checksSummary = parseSurfaceSessionChecksSummary(closed, "checksSummary");
				} catch (error) {
					throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "checksSummary is invalid");
				}
				if (Buffer.byteLength(JSON.stringify(checksSummary), "utf8") > 8192) {
					throw new CloudToolArgumentRefusal("checksSummary exceeds 8192 bytes");
				}
			}
			return {
				...(hasActivity ? { currentActivity: currentActivity ?? null } : {}),
				...(progressSteps !== undefined ? { progressSteps } : {}),
				...(checksSummary !== undefined ? { checksSummary } : {}),
			} as unknown as JsonValue;
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as CodingReportProgressRequest;
			let result: CodingReportProgressResult;
			try {
				result = await port.reportProgress(sessionId, parsed, context);
			} catch (error) {
				relayControlRefusal(error);
			}
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-progress-reported/v1",
					sessionId: result.sessionId,
					currentActivity: result.currentActivity,
					stepCount: result.progressSteps.length,
					checksStatus: result.checksSummary?.status ?? null,
				}),
			};
		},
	};
}

export function createManageSurfaceAutomationTool(companyId: string, port: SurfaceAutomationToolPort): CloudNativeTool {
	return {
		name: "manage_surface_automation",
		source: "runtime",
		description:
			"Create, update, pause/resume, or delete a recurring Surface Automation that schedules repeatable work onto a target Surface (or decision cards) instead of hiring standalone org-chart roles.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: [...MANAGE_SURFACE_AUTOMATION_ACTIONS],
					description: "Whether to create, update, or delete the recurring Surface Automation.",
				},
				automationId: {
					type: "string",
					description: "Automation UUID (required for update and delete; omit for create).",
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: MAX_AUTOMATION_TITLE_CHARS,
					description: "Short plain founder-facing title for the recurring automation (required for create).",
				},
				prompt: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_PROMPT_CHARS,
					description: "Self-contained instructions executed on each recurring run (required for create).",
				},
				scheduleSummary: {
					type: "string",
					minLength: 1,
					maxLength: MAX_AUTOMATION_SCHEDULE_CHARS,
					description: "Plain cadence summary such as 'Every Monday · 09:00' or 'Every day · 09:00'.",
				},
				targetSurfaceSlug: {
					type: "string",
					maxLength: 64,
					description: "Optional lower-case hyphenated slug of the Surface where staged work should land.",
				},
				enabled: {
					type: "boolean",
					description: "Whether the automation is active (true) or paused (false).",
				},
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"manage_surface_automation",
					["action"],
					["automationId", "title", "prompt", "scheduleSummary", "targetSurfaceSlug", "enabled"],
				);
			} catch (error) {
				throw new CloudToolArgumentRefusal(error instanceof Error ? error.message : "Invalid arguments");
			}
			const action = parseEnumArg(raw.action, MANAGE_SURFACE_AUTOMATION_ACTIONS, "action");
			let automationId: string | null = null;
			if (raw.automationId !== undefined && raw.automationId !== null) {
				if (!isUuid(raw.automationId)) {
					throw new CloudToolArgumentRefusal("automationId must be a valid UUID");
				}
				automationId = raw.automationId;
			}
			const title = parseOptionalBounded(raw.title, "title", MAX_AUTOMATION_TITLE_CHARS);
			const prompt = parseOptionalBounded(raw.prompt, "prompt", SURFACE_MAX_PROMPT_CHARS);
			const scheduleSummary = parseOptionalBounded(
				raw.scheduleSummary,
				"scheduleSummary",
				MAX_AUTOMATION_SCHEDULE_CHARS,
			);
			let targetSurfaceSlug: string | null = null;
			if (raw.targetSurfaceSlug !== undefined && raw.targetSurfaceSlug !== null) {
				if (!isSurfaceSlug(raw.targetSurfaceSlug)) {
					throw new CloudToolArgumentRefusal(
						"targetSurfaceSlug must be lower-case letters, digits, and single hyphens",
					);
				}
				targetSurfaceSlug = raw.targetSurfaceSlug;
			}
			let enabled: boolean | null = null;
			if (raw.enabled !== undefined && raw.enabled !== null) {
				if (typeof raw.enabled !== "boolean") {
					throw new CloudToolArgumentRefusal("enabled must be a boolean");
				}
				enabled = raw.enabled;
			}
			if (action === "create") {
				if (automationId !== null) {
					throw new CloudToolArgumentRefusal("automationId must be omitted when action is create");
				}
				if (title === null || title.length === 0) {
					throw new CloudToolArgumentRefusal("title is required when action is create");
				}
				if (prompt === null || prompt.length === 0) {
					throw new CloudToolArgumentRefusal("prompt is required when action is create");
				}
			} else if (action === "update") {
				if (automationId === null) {
					throw new CloudToolArgumentRefusal("automationId is required when action is update");
				}
				if (
					title === null &&
					prompt === null &&
					scheduleSummary === null &&
					targetSurfaceSlug === null &&
					enabled === null
				) {
					throw new CloudToolArgumentRefusal(
						"update requires at least one of title, prompt, scheduleSummary, targetSurfaceSlug, or enabled",
					);
				}
			} else {
				if (automationId === null) {
					throw new CloudToolArgumentRefusal("automationId is required when action is delete");
				}
				if (
					title !== null ||
					prompt !== null ||
					scheduleSummary !== null ||
					targetSurfaceSlug !== null ||
					enabled !== null
				) {
					throw new CloudToolArgumentRefusal("delete accepts only action and automationId");
				}
			}
			return {
				action,
				automationId,
				title,
				prompt,
				scheduleSummary,
				targetSurfaceSlug,
				enabled,
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as ManageSurfaceAutomationRequest;
			const result = await port.manageAutomation(companyId, parsed, context);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-automation-managed/v1",
					action: parsed.action,
					...result,
				}),
			};
		},
	};
}
