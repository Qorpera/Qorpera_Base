import {
	isSurfaceSlug,
	isUuid,
	type JsonValue,
	parseBoundedText,
	parseClosedRecord,
	SURFACE_ARCHETYPES,
	SURFACE_GROUPS,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_PROMPT_CHARS,
	SURFACE_MAX_TITLE_CHARS,
	SURFACE_PREVIEW_MODES,
	SURFACE_SOURCE_KINDS,
	type SurfaceArchetype,
	type SurfaceGroup,
	type SurfacePreviewMode,
	type SurfaceSourceKind,
} from "@qorpera/contracts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";

const GIT_SHA = /^[0-9a-f]{40}$/;

export interface CodingRecordChangeRequest {
	readonly title: string;
	readonly summary: string;
	readonly commitSha: string;
	readonly dependsOnChangeIds: readonly string[];
}

export interface ProposeSurfaceRequest {
	readonly slug: string;
	readonly title: string;
	readonly group: SurfaceGroup;
	readonly archetype: SurfaceArchetype;
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
}

export interface CloudSurfaceToolsPort {
	recordChange(
		sessionId: string,
		request: CodingRecordChangeRequest,
		context: CloudToolContext,
	): Promise<{ readonly changeId: string; readonly seq: number; readonly openChangeCount: number }>;
	proposeSurface(
		companyId: string,
		request: ProposeSurfaceRequest,
		context: CloudToolContext,
	): Promise<{ readonly id: string; readonly slug: string; readonly status: "proposed" | "active" }>;
	startSurfaceSession(
		request: StartSurfaceSessionToolRequest,
		context: CloudToolContext,
	): Promise<{ readonly sessionId: string; readonly explorationId: string | null }>;
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
		return parseBoundedText(value, field, maxLength);
	} catch {
		throw new CloudToolArgumentRefusal(`${field} must be a non-empty string up to ${maxLength} characters`);
	}
}

export function createCodingRecordChangeTool(
	sessionId: string,
	port: Pick<CloudSurfaceToolsPort, "recordChange">,
): CloudNativeTool {
	return {
		name: "coding_record_change",
		source: "worker",
		description:
			"Stage one cohesive committed ChangeUnit on this Surface session branch without landing main. Members toggle and approve each recorded change individually; call once per distinct deliverable before coding_finish.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["title", "summary", "commitSha"],
			properties: {
				title: { type: "string", description: "Short plain founder-facing title for this change." },
				summary: { type: "string", description: "1-2 sentences describing what the user will notice." },
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
					["dependsOnChangeIds"],
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
			const depsRaw = raw.dependsOnChangeIds ?? [];
			if (!Array.isArray(depsRaw) || depsRaw.length > 32 || depsRaw.some((item) => !isUuid(item))) {
				throw new CloudToolArgumentRefusal("dependsOnChangeIds must be an array of change UUIDs");
			}
			return {
				title,
				summary,
				commitSha: raw.commitSha,
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
			"Propose a new primary Surface for the company sidebar. New surfaces start in proposed state until a founder approves them, keeping primary navigation focused and clutter-free.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["slug", "title", "group", "archetype", "sourceKind"],
			properties: {
				slug: { type: "string" },
				title: { type: "string" },
				group: { type: "string", enum: [...SURFACE_GROUPS] },
				archetype: { type: "string", enum: [...SURFACE_ARCHETYPES] },
				sourceKind: { type: "string", enum: [...SURFACE_SOURCE_KINDS] },
				icon: { type: "string" },
				repositoryKey: { type: "string" },
				folderRoot: { type: "string" },
				previewMode: { type: "string", enum: [...SURFACE_PREVIEW_MODES] },
				briefSummary: { type: "string" },
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"propose_surface",
					["slug", "title", "group", "archetype", "sourceKind"],
					["icon", "repositoryKey", "folderRoot", "previewMode", "briefSummary"],
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
			const icon = parseOptionalBounded(raw.icon, "icon", 40) ?? "page";
			const repositoryKey = parseOptionalBounded(raw.repositoryKey, "repositoryKey", 200);
			const folderRoot = parseOptionalBounded(raw.folderRoot, "folderRoot", 256);
			const previewMode =
				raw.previewMode === undefined
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
			"Launch a parallel scoped Session directly on a Surface. Optionally set explorationCount (2 or 3) to spawn side-by-side comparable variants.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["surfaceId", "prompt"],
			properties: {
				surfaceId: { type: "string" },
				prompt: { type: "string" },
				title: { type: "string" },
				explorationCount: { type: "integer", enum: [2, 3] },
				explorationTitle: { type: "string" },
			},
		},
		parseArguments(value: JsonValue): JsonValue {
			let raw: Record<string, unknown>;
			try {
				raw = parseClosedRecord(
					value,
					"start_surface_session",
					["surfaceId", "prompt"],
					["title", "explorationCount", "explorationTitle"],
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
			let explorationCount: 2 | 3 | null = null;
			if (raw.explorationCount !== undefined && raw.explorationCount !== null) {
				if (raw.explorationCount !== 2 && raw.explorationCount !== 3) {
					throw new CloudToolArgumentRefusal("explorationCount must be 2 or 3");
				}
				explorationCount = raw.explorationCount;
			}
			return {
				surfaceId: raw.surfaceId,
				prompt,
				title,
				explorationCount,
				explorationTitle,
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
