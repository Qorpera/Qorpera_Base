import {
	isSurfaceSlug,
	isUuid,
	type JsonValue,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseStudioPatchOps,
	parseSurfaceLayoutText,
	parseSurfaceSlug,
	parseUuid,
	resolveStudioFolderPath,
	type StudioPatchOp,
	SURFACE_ARCHETYPES,
	SURFACE_AUTOMATION_STATUSES,
	SURFACE_FIGURES,
	SURFACE_GROUPS,
	SURFACE_KINDS,
	SURFACE_LAYOUT_PATH,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_COMPARE_VARIANTS,
	SURFACE_MAX_PROMPT_CHARS,
	SURFACE_MAX_TITLE_CHARS,
	SURFACE_PREVIEW_MODES,
	SURFACE_PUBLISH_STATUSES,
	SURFACE_SESSION_STATES,
	SURFACE_SOURCE_KINDS,
	SURFACE_STATUSES,
	type SurfaceArchetype,
	type SurfaceAutomationStatus,
	type SurfaceGroup,
	type SurfaceKind,
	type SurfacePreviewMode,
	type SurfacePublishStatus,
	type SurfaceSessionState,
	type SurfaceSourceKind,
	type SurfaceStatus,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";

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
	readonly dependsOnChangeIds: readonly string[];
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
}

export interface StageSurfacePatchRequest {
	readonly title: string;
	readonly summary: string;
	readonly ops: readonly StudioPatchOp[];
	readonly baseFiles?: Readonly<Record<string, string | null>>;
	readonly notePaths: readonly string[];
	readonly finishSession: boolean;
}

export interface StageSurfaceOpsActionRequest {
	readonly title: string;
	readonly summary: string;
	readonly actionKind: string;
	readonly actionPayload: Readonly<Record<string, JsonValue>>;
	readonly finishSession: boolean;
}

export interface SurfaceChangeStagedResult {
	readonly changeId: string;
	readonly seq: number;
	readonly openChangeCount: number;
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
	proposeSurface(
		companyId: string,
		request: ProposeSurfaceRequest,
		context: CloudToolContext,
	): Promise<{ readonly id: string; readonly slug: string; readonly status: "proposed" | "active" }>;
	startSurfaceSession(
		request: StartSurfaceSessionToolRequest,
		context: CloudToolContext,
	): Promise<{ readonly sessionId: string; readonly explorationId: string | null }>;
	stageSurfacePatch?: SurfacePatchToolPort["stageSurfacePatch"];
	stageSurfaceOpsAction?: SurfaceOpsActionToolPort["stageSurfaceOpsAction"];
	listSurfaceSenses?(companyId: string, signal?: AbortSignal): Promise<SurfaceCompanySenses>;
	manageAutomation?: SurfaceAutomationToolPort["manageAutomation"];
}

export type SurfaceControlPlaneRpc =
	| "qorpera_native_surface_propose"
	| "qorpera_native_surface_start_session"
	| "qorpera_native_surface_record_change"
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
	};
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
					p_depends_on_change_ids: [...request.dependsOnChangeIds],
					p_affected_paths: [],
					p_diff_stats: null,
					p_patch_manifest: null,
					p_finish_session: false,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
				},
				context.signal,
			);
			return parseRecordChangeResult(response, "recordChange");
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

		async stageSurfacePatch(sessionId, request, context) {
			const affectedPaths = [...new Set(request.ops.map((op) => op.path))];
			const hasBaseFiles = request.baseFiles !== undefined && Object.keys(request.baseFiles).length > 0;
			const patchManifest = hasBaseFiles
				? { ops: [...request.ops], baseFiles: request.baseFiles }
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
					p_depends_on_change_ids: [],
					p_affected_paths: affectedPaths,
					p_diff_stats: null,
					p_patch_manifest: patchManifest,
					p_finish_session: options.deferSessionCompletion ? false : request.finishSession,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
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
					p_depends_on_change_ids: [],
					p_affected_paths: [],
					p_diff_stats: null,
					p_patch_manifest: {
						actionKind: request.actionKind,
						actionPayload: request.actionPayload,
					},
					p_finish_session: options.deferSessionCompletion ? false : request.finishSession,
					...(options.leaseToken !== undefined ? { p_lease_token: options.leaseToken } : {}),
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

export function createCodingRecordChangeTool(
	sessionId: string,
	port: Pick<CloudSurfaceToolsPort, "recordChange">,
): CloudNativeTool {
	return {
		name: "coding_record_change",
		source: "worker",
		description:
			"Stage one cohesive committed ChangeUnit on this Surface session branch without landing main. Members toggle and approve each recorded change individually; pass parentSha (the base commit before this change unit, e.g. git rev-parse HEAD~1) and commitSha, calling once per distinct deliverable before coding_finish.",
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
						"Optional 40-hex Git parent commit SHA before this change unit (e.g. git rev-parse <commitSha>~1); defaults to the previous recorded change head or session base SHA.",
				},
				commitSha: { type: "string", description: "40-hex Git commit SHA on the session branch." },
				dependsOnChangeIds: {
					type: "array",
					items: { type: "string" },
					description: "Optional IDs of earlier ChangeUnits in this session that must merge before this one.",
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
					["parentSha", "dependsOnChangeIds"],
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
			const depsRaw = raw.dependsOnChangeIds ?? [];
			if (!Array.isArray(depsRaw) || depsRaw.length > 32 || depsRaw.some((item) => !isUuid(item))) {
				throw new CloudToolArgumentRefusal("dependsOnChangeIds must be an array of change UUIDs");
			}
			return {
				title,
				summary,
				commitSha: raw.commitSha,
				...(parentSha !== undefined ? { parentSha } : {}),
				dependsOnChangeIds: [...(depsRaw as string[])],
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as CodingRecordChangeRequest;
			const result = await port.recordChange(sessionId, parsed, context);
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.surface-change-recorded/v1",
					sessionId,
					changeId: result.changeId,
					seq: result.seq,
					openChangeCount: result.openChangeCount,
					staged: true,
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
			'Create or propose a primary Surface for the company sidebar. Use archetype "studio" + sourceKind "folder" for Strategy, Identity, Product Studio, or Custom Studio workspaces (planning rooms, economics labs, GTM boards, sketching spaces), and archetype "live_build" + sourceKind "code_repo" for customer-facing websites and software products. New surfaces start in proposed state until a founder approves them unless activateImmediately is true for Day-0 founding.',
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
						"Semantic kind of surface (identity, strategy, custom, website, web_app, mobile_app, desktop_app, product, report, etc.).",
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
				repositoryKey: { type: "string", maxLength: 200 },
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
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"start_surface_session",
					["surfaceId", "prompt"],
					["title", "explorationCount", "explorationTitle", "ownerLabel", "variantLabels"],
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

export interface SurfaceLayoutStaging {
	readonly folderRoot: string;
	readonly waitingOps: readonly StudioPatchOp[] | null;
	readLayout(signal: AbortSignal): Promise<string | null>;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
		if (REPORT_FILE_RE.test(op.path)) {
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
			} else if (op.op === "merge_json") {
				const patch = op.patch;
				if (patch.headline !== undefined && !nonEmptyString(patch.headline)) {
					throw reportRefusal(op.path, "headline must be a non-empty string");
				}
				if (patch.keyMetrics !== undefined) validateReportMetrics(patch.keyMetrics, op.path);
				if (patch.sections !== undefined) validateReportSections(patch.sections, op.path);
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

export interface StageSurfacePatchToolOptions {
	readonly deferSessionCompletion?: boolean;
	readonly allowMultipleDeliverables?: boolean;
}

export function createStageSurfacePatchTool(
	sessionId: string,
	port: SurfacePatchToolPort,
	layout?: SurfaceLayoutStaging,
	options: StageSurfacePatchToolOptions = {},
): CloudNativeTool {
	const stagedThisTurn: StudioPatchOp[] = [];
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
			: "Stage one cohesive folder_patch ChangeUnit on a Studio, Report, or Identity Surface session. Call this tool once per independent deliverable (for example, one call per report, article, blog post, or page section) so members can toggle, preview, and approve each piece individually; never bundle multiple reports or standalone HTML documents into one call. Write reports and blog posts as *.report.json articles (or self-contained .html when bespoke layout is needed) rather than raw .md files.",
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
					["notePaths", "finishSession"],
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
			return {
				title,
				summary,
				ops: normalizedOps as unknown as JsonValue,
				notePaths,
				finishSession,
			};
		},
		async prepare(parsed: JsonValue, context: CloudToolContext): Promise<JsonValue> {
			const ops = (parsed as unknown as StageSurfacePatchRequest).ops;
			checkStagedSurfaceDeliverables(ops, { allowMultipleDeliverables: options.allowMultipleDeliverables });
			if (!layout) return parsed;
			const check = await checkStagedSurfaceLayout(
				ops,
				{
					...layout,
					waitingOps: layout.waitingOps === null ? null : [...layout.waitingOps, ...stagedThisTurn],
				},
				context.signal,
			);
			return check === "unchecked" ? { ...(parsed as Record<string, JsonValue>), layoutUnchecked: true } : parsed;
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as StageSurfacePatchRequest & { readonly layoutUnchecked?: boolean };
			const result = await port.stageSurfacePatch(sessionId, parsed, context);
			stagedThisTurn.push(...parsed.ops);
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
					...(parsed.layoutUnchecked === true ? { note: LAYOUT_UNCHECKED_NOTE } : {}),
				}),
			};
		},
	};
}

export function createStageSurfaceOpsActionTool(sessionId: string, port: SurfaceOpsActionToolPort): CloudNativeTool {
	return {
		name: "stage_surface_ops_action",
		source: "worker",
		description:
			"Stage a structured ops_action ChangeUnit on an operational Surface session (inbox, money, data, files, members) so members can review and approve or send it cleanly from the Action card.",
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
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"stage_surface_ops_action",
					["title", "summary", "actionKind", "actionPayload"],
					["finishSession"],
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
			return {
				title,
				summary,
				actionKind,
				actionPayload: actionPayload as JsonValue,
				finishSession,
			};
		},
		async execute(argumentsValue: JsonValue, context: CloudToolContext) {
			const parsed = argumentsValue as unknown as StageSurfaceOpsActionRequest;
			const result = await port.stageSurfaceOpsAction(sessionId, parsed, context);
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
