import {
	type CrossSurfaceHandoffRequest,
	isSurfaceSlug,
	type PointToChangeTarget,
	parsePointToChangeTarget,
	parseSurfaceAutomationSummary,
	parseSurfaceMigrationChecklist,
	parseSurfacePreviewCompositionState,
	parseSurfaceSession,
	parseSurfaceSessionImages,
	parseSurfaceSummary,
	parseSurfaceUnseenNotes,
	parseSurfaceWorkspace,
	SURFACE_ARCHETYPES,
	SURFACE_GROUPS,
	SURFACE_HEX_COLOR_PATTERN,
	SURFACE_KINDS,
	SURFACE_MAX_TITLE_CHARS,
	SURFACE_PREVIEW_MODES,
	SURFACE_SCHEMA_VERSION,
	SURFACE_SOURCE_KINDS,
	SURFACE_STATUSES,
	type SurfaceArchetype,
	type SurfaceAutomationSummary,
	type SurfaceChangeUnit,
	type SurfaceGroup,
	type SurfaceImageRef,
	type SurfaceKind,
	type SurfaceMigrationChecklist,
	type SurfacePreviewCompositionState,
	type SurfacePreviewMode,
	type SurfaceSession,
	type SurfaceSessionImages,
	type SurfaceSessionMessage,
	type SurfaceSourceKind,
	type SurfaceStatus,
	type SurfaceSummary,
	type SurfaceUnseenNote,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { osPath, osRelative } from "./company-state-shared.ts";
import { parseTomlSubset, TomlSubsetError } from "./toml-subset.ts";

export const SURFACE_ORDER_PATH = osPath("surfaces/order.md");
export const SURFACE_MANIFEST_MAX_BYTES = 16 * 1024;
export const SURFACE_ORDER_MAX_BYTES = 16 * 1024;

export function surfaceManifestPath(slug: string): string {
	return osPath(`surfaces/${slug}/surface.toml`);
}

export function surfaceBriefPath(slug: string): string {
	return osPath(`surfaces/${slug}/brief.md`);
}

export interface SurfaceManifestFile {
	readonly schema: typeof SURFACE_SCHEMA_VERSION;
	readonly slug: string;
	readonly title: string;
	readonly group: SurfaceGroup;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind;
	readonly accentHex?: string | null;
	readonly isGlobal?: boolean;
	readonly icon: string;
	readonly status: SurfaceStatus;
	readonly autoPublish: boolean;
	readonly source: {
		readonly kind: SurfaceSourceKind;
		readonly repository: string | null;
		readonly baseBranch: string | null;
		readonly siteSlug: string | null;
		readonly folderRoot: string | null;
	};
	readonly preview: {
		readonly mode: SurfacePreviewMode;
		readonly defaultRoute: string;
		readonly allowCompare: boolean;
		readonly allowPointToChange: boolean;
	};
}

export interface SurfaceManifestProblem {
	readonly line: number | null;
	readonly key: string | null;
	readonly message: string;
}

export type SurfaceManifestParseResult =
	| { readonly ok: true; readonly file: SurfaceManifestFile }
	| { readonly ok: false; readonly problems: readonly SurfaceManifestProblem[] };

const TOP_KEYS = new Set([
	"schema",
	"slug",
	"title",
	"group",
	"archetype",
	"kind",
	"accent",
	"global",
	"icon",
	"status",
	"auto_publish",
	"source",
	"preview",
]);
const SOURCE_KEYS = new Set(["kind", "repository", "base_branch", "site_slug", "folder_root"]);
const PREVIEW_KEYS = new Set(["mode", "default_route", "allow_compare", "allow_point_to_change"]);
const SURFACE_PATH_PATTERN = /^surfaces\/([a-z0-9]+(?:-[a-z0-9]+)*)\/surface\.toml$/;
const TEXT_ENCODER = new TextEncoder();

function escapeTomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

function readOneOf<T extends string>(
	table: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	lines: ReadonlyMap<string, number>,
	pathPrefix: string,
	problems: SurfaceManifestProblem[],
): T | null {
	const fullKey = pathPrefix ? `${pathPrefix}.${key}` : key;
	const value = table[key];
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		problems.push({
			line: lines.get(fullKey) ?? null,
			key: fullKey,
			message: `${fullKey} must be one of: ${allowed.join(", ")}`,
		});
		return null;
	}
	return value as T;
}

function readOptionalString(
	table: Record<string, unknown>,
	key: string,
	maxLength: number,
	lines: ReadonlyMap<string, number>,
	pathPrefix: string,
	problems: SurfaceManifestProblem[],
): string | null {
	if (!Object.hasOwn(table, key)) return null;
	const fullKey = pathPrefix ? `${pathPrefix}.${key}` : key;
	const value = table[key];
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
		problems.push({
			line: lines.get(fullKey) ?? null,
			key: fullKey,
			message: `${fullKey} must be a non-empty string up to ${maxLength} characters`,
		});
		return null;
	}
	return value;
}

function readOptionalBool(
	table: Record<string, unknown>,
	key: string,
	fallback: boolean,
	lines: ReadonlyMap<string, number>,
	pathPrefix: string,
	problems: SurfaceManifestProblem[],
): boolean {
	if (!Object.hasOwn(table, key)) return fallback;
	const fullKey = pathPrefix ? `${pathPrefix}.${key}` : key;
	const value = table[key];
	if (typeof value !== "boolean") {
		problems.push({
			line: lines.get(fullKey) ?? null,
			key: fullKey,
			message: `${fullKey} must be true or false`,
		});
		return fallback;
	}
	return value;
}

export function parseSurfaceManifestToml(path: string, text: string): SurfaceManifestParseResult {
	const relative = osRelative(path);
	const match = relative ? SURFACE_PATH_PATTERN.exec(relative) : null;
	if (!match) {
		return {
			ok: false,
			problems: [{ line: null, key: null, message: "Path must be QorperaOS/surfaces/<slug>/surface.toml" }],
		};
	}
	const pathSlug = match[1] as string;
	if (TEXT_ENCODER.encode(text).byteLength > SURFACE_MANIFEST_MAX_BYTES) {
		return {
			ok: false,
			problems: [{ line: null, key: null, message: "surface.toml exceeds 16 KiB limit" }],
		};
	}
	let doc: ReturnType<typeof parseTomlSubset>;
	try {
		doc = parseTomlSubset(text);
	} catch (error) {
		const line = error instanceof TomlSubsetError ? error.line : null;
		const message = error instanceof Error ? error.message : "Invalid TOML syntax";
		return { ok: false, problems: [{ line, key: null, message }] };
	}

	const problems: SurfaceManifestProblem[] = [];
	const root = doc.value;
	const lines = doc.lines;

	for (const key of Object.keys(root)) {
		if (!TOP_KEYS.has(key)) {
			problems.push({ line: lines.get(key) ?? null, key, message: `Unknown key "${key}"` });
		}
	}

	if (root.schema !== SURFACE_SCHEMA_VERSION) {
		problems.push({
			line: lines.get("schema") ?? null,
			key: "schema",
			message: `schema must be "${SURFACE_SCHEMA_VERSION}"`,
		});
	}

	const slug = typeof root.slug === "string" && isSurfaceSlug(root.slug) ? root.slug : null;
	if (!slug || slug !== pathSlug) {
		problems.push({
			line: lines.get("slug") ?? null,
			key: "slug",
			message: `slug must match folder slug "${pathSlug}"`,
		});
	}

	const title =
		typeof root.title === "string" && root.title.trim().length > 0 && root.title.length <= SURFACE_MAX_TITLE_CHARS
			? root.title.trim()
			: null;
	if (!title) {
		problems.push({
			line: lines.get("title") ?? null,
			key: "title",
			message: `title must be 1..${SURFACE_MAX_TITLE_CHARS} characters`,
		});
	}

	const group = readOneOf(root, "group", SURFACE_GROUPS, lines, "", problems);
	const archetype = readOneOf(root, "archetype", SURFACE_ARCHETYPES, lines, "", problems);
	const kind = Object.hasOwn(root, "kind") ? readOneOf(root, "kind", SURFACE_KINDS, lines, "", problems) : null;
	const accentHex = readOptionalString(root, "accent", 16, lines, "", problems);
	if (accentHex !== null && !SURFACE_HEX_COLOR_PATTERN.test(accentHex)) {
		problems.push({
			line: lines.get("accent") ?? null,
			key: "accent",
			message: "accent must be a 6-digit hex color like #2a9ae0",
		});
	}
	const isGlobal = Object.hasOwn(root, "global") ? readOptionalBool(root, "global", false, lines, "", problems) : null;
	const status = readOneOf(root, "status", SURFACE_STATUSES, lines, "", problems);
	const icon = readOptionalString(root, "icon", 40, lines, "", problems) ?? "page";
	const autoPublish = readOptionalBool(root, "auto_publish", false, lines, "", problems);

	const sourceRaw = root.source;
	if (!sourceRaw || typeof sourceRaw !== "object" || Array.isArray(sourceRaw)) {
		problems.push({ line: lines.get("source") ?? null, key: "source", message: "[source] table is required" });
	}
	const sourceObj =
		sourceRaw && typeof sourceRaw === "object" && !Array.isArray(sourceRaw)
			? (sourceRaw as Record<string, unknown>)
			: {};
	for (const key of Object.keys(sourceObj)) {
		if (!SOURCE_KEYS.has(key)) {
			problems.push({
				line: lines.get(`source.${key}`) ?? null,
				key: `source.${key}`,
				message: `Unknown key "source.${key}"`,
			});
		}
	}
	const sourceKind = readOneOf(sourceObj, "kind", SURFACE_SOURCE_KINDS, lines, "source", problems);
	const repository = readOptionalString(sourceObj, "repository", 200, lines, "source", problems);
	const baseBranch = readOptionalString(sourceObj, "base_branch", 120, lines, "source", problems);
	const siteSlug = readOptionalString(sourceObj, "site_slug", 64, lines, "source", problems);
	const folderRoot = readOptionalString(sourceObj, "folder_root", 256, lines, "source", problems);

	const previewRaw = root.preview;
	const previewObj =
		previewRaw && typeof previewRaw === "object" && !Array.isArray(previewRaw)
			? (previewRaw as Record<string, unknown>)
			: {};
	if (
		previewRaw !== undefined &&
		(typeof previewRaw !== "object" || previewRaw === null || Array.isArray(previewRaw))
	) {
		problems.push({ line: lines.get("preview") ?? null, key: "preview", message: "[preview] must be a table" });
	}
	for (const key of Object.keys(previewObj)) {
		if (!PREVIEW_KEYS.has(key)) {
			problems.push({
				line: lines.get(`preview.${key}`) ?? null,
				key: `preview.${key}`,
				message: `Unknown key "preview.${key}"`,
			});
		}
	}
	const previewMode = Object.hasOwn(previewObj, "mode")
		? readOneOf(previewObj, "mode", SURFACE_PREVIEW_MODES, lines, "preview", problems)
		: "none";
	const defaultRoute = readOptionalString(previewObj, "default_route", 512, lines, "preview", problems) ?? "/";
	const allowCompare = readOptionalBool(previewObj, "allow_compare", false, lines, "preview", problems);
	const allowPointToChange = readOptionalBool(previewObj, "allow_point_to_change", false, lines, "preview", problems);

	if (problems.length > 0 || !slug || !title || !group || !archetype || !status || !sourceKind || !previewMode) {
		return { ok: false, problems };
	}

	return {
		ok: true,
		file: {
			schema: SURFACE_SCHEMA_VERSION,
			slug,
			title,
			group,
			archetype,
			...(kind ? { kind } : {}),
			...(accentHex !== null ? { accentHex } : {}),
			...(isGlobal !== null ? { isGlobal } : {}),
			icon,
			status,
			autoPublish,
			source: {
				kind: sourceKind,
				repository,
				baseBranch,
				siteSlug,
				folderRoot,
			},
			preview: {
				mode: previewMode,
				defaultRoute,
				allowCompare,
				allowPointToChange,
			},
		},
	};
}

export function renderSurfaceManifestToml(file: SurfaceManifestFile): string {
	const lines: string[] = [
		`schema = ${escapeTomlString(file.schema)}`,
		`slug = ${escapeTomlString(file.slug)}`,
		`title = ${escapeTomlString(file.title)}`,
		`group = ${escapeTomlString(file.group)}`,
		`archetype = ${escapeTomlString(file.archetype)}`,
		...(file.kind ? [`kind = ${escapeTomlString(file.kind)}`] : []),
		...(file.accentHex ? [`accent = ${escapeTomlString(file.accentHex)}`] : []),
		...(file.isGlobal ? ["global = true"] : []),
		`icon = ${escapeTomlString(file.icon)}`,
		`status = ${escapeTomlString(file.status)}`,
		`auto_publish = ${file.autoPublish ? "true" : "false"}`,
		"",
		"[source]",
		`kind = ${escapeTomlString(file.source.kind)}`,
	];
	if (file.source.repository) lines.push(`repository = ${escapeTomlString(file.source.repository)}`);
	if (file.source.baseBranch) lines.push(`base_branch = ${escapeTomlString(file.source.baseBranch)}`);
	if (file.source.siteSlug) lines.push(`site_slug = ${escapeTomlString(file.source.siteSlug)}`);
	if (file.source.folderRoot) lines.push(`folder_root = ${escapeTomlString(file.source.folderRoot)}`);
	lines.push(
		"",
		"[preview]",
		`mode = ${escapeTomlString(file.preview.mode)}`,
		`default_route = ${escapeTomlString(file.preview.defaultRoute)}`,
		`allow_compare = ${file.preview.allowCompare ? "true" : "false"}`,
		`allow_point_to_change = ${file.preview.allowPointToChange ? "true" : "false"}`,
		"",
	);
	return lines.join("\n");
}

export interface SurfaceOrderFile {
	readonly products: readonly string[];
	readonly operations: readonly string[];
}

export function parseSurfaceOrderFile(text: string): SurfaceOrderFile {
	const products: string[] = [];
	const operations: string[] = [];
	const seen = new Set<string>();
	let current: "products" | "operations" = "products";
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("# ")) continue;
		const heading = /^##\s+(products|operations|building|running)\s*$/i.exec(line);
		if (heading) {
			const label = heading[1]?.toLowerCase();
			current = label === "operations" || label === "running" ? "operations" : "products";
			continue;
		}
		const item = /^[-*]\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(line);
		if (item?.[1] && isSurfaceSlug(item[1]) && !seen.has(item[1])) {
			seen.add(item[1]);
			(current === "products" ? products : operations).push(item[1]);
		}
	}
	return { products, operations };
}

export function renderSurfaceOrderFile(order: SurfaceOrderFile): string {
	const lines: string[] = ["## Products"];
	for (const slug of order.products) lines.push(`- ${slug}`);
	lines.push("", "## Operations");
	for (const slug of order.operations) lines.push(`- ${slug}`);
	lines.push("");
	return lines.join("\n");
}

export interface StartSurfaceSessionOptions {
	readonly title?: string;
	readonly target?: PointToChangeTarget;
	readonly explorationCount?: 2 | 3;
	readonly explorationTitle?: string;
	readonly variantLabels?: readonly string[];
	readonly originKind?: "member" | "cofounder" | "automation" | "point_to_change" | "cross_surface";
	readonly originLabel?: string;
	readonly clientInputId?: string;
	readonly images?: readonly SurfaceImageRef[];
}

export interface CreateSurfaceRpcInput {
	readonly title: string;
	readonly slug?: string;
	readonly archetype: SurfaceArchetype;
	readonly kind?: SurfaceKind;
	readonly icon?: string;
	readonly accentHex?: string | null;
	readonly folderRoot?: string | null;
	readonly briefSummary?: string | null;
	readonly isGlobal?: boolean;
}

export interface CreateSurfaceAutomationInput {
	readonly title: string;
	readonly prompt: string;
	readonly scheduleSummary?: string;
	readonly targetSurfaceSlug?: string | null;
}

export interface UpdateSurfaceAutomationInput {
	readonly title?: string;
	readonly prompt?: string;
	readonly scheduleSummary?: string;
	readonly targetSurfaceSlug?: string | null;
}

export interface SetSurfacePreviewSelectionInput {
	readonly toggledChangeIds: readonly string[];
	readonly explorationSessionId?: string | null;
	readonly compareSessionIds?: readonly string[];
	readonly activeRoute?: string;
}

export interface ApplySurfaceMigrationInput {
	readonly activateSurfaceSlugs: readonly string[];
	readonly agentDecisions: readonly {
		readonly agentId: string;
		readonly action: "fold_to_automation" | "fold_to_surface_brief" | "archive_readonly" | "keep";
		readonly targetSurfaceSlug?: string | null;
	}[];
	readonly archiveBoardNames: readonly string[];
}

export class CloudSurfacesError extends Error {
	readonly code: string | null;
	constructor(message: string, code: string | null = null) {
		super(message);
		this.name = "CloudSurfacesError";
		this.code = code;
	}
}

// WHY: Lets packages/web degrade gracefully to synthesized local surfaces when talking to an unmigrated database.
export function isMissingSurfaceRpcError(error: unknown): boolean {
	if (error instanceof CloudSurfacesError) return error.code === "PGRST202" || error.code === "42883";
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return code === "PGRST202" || code === "42883";
	}
	return false;
}

export function isSurfacesDisabledError(error: unknown): boolean {
	if (error instanceof CloudSurfacesError) return error.code === "0A000";
	if (error && typeof error === "object" && "code" in error) {
		return (error as { code?: unknown }).code === "0A000";
	}
	return false;
}

export interface SurfacePreviewPassGrant {
	readonly previewId: string;
	readonly doorActionUrl: string;
	readonly memberPass: string;
}

function surfaceImageRows(
	images: readonly SurfaceImageRef[],
): { objectSha256: string; bytes: number; mediaType: string }[] {
	return images.map((image) => ({ objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType }));
}

function automationOf(data: unknown, name: string): SurfaceAutomationSummary {
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new CloudSurfacesError(`Invalid ${name} payload`);
	return parseSurfaceAutomationSummary((data as Record<string, unknown>).automation, "automation");
}

export class CloudSurfacesClient {
	readonly #supabase: SupabaseClient;

	constructor(supabase: SupabaseClient) {
		this.#supabase = supabase;
	}

	async #rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
		const { data, error } = await this.#supabase.rpc(name, args);
		if (error) {
			throw new CloudSurfacesError(error.message || `${name} failed`, error.code ?? null);
		}
		return data;
	}

	async isSurfacesEnabled(): Promise<boolean> {
		const data = await this.#rpc("qorpera_surfaces_enabled", {});
		return data === true;
	}

	async mintPreviewPass(previewId: string): Promise<SurfacePreviewPassGrant> {
		const data = await this.#rpc("qorpera_mint_surface_preview_pass", { p_preview_id: previewId });
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new CloudSurfacesError("Invalid qorpera_mint_surface_preview_pass payload");
		}
		const record = data as Record<string, unknown>;
		if (
			typeof record.previewId !== "string" ||
			typeof record.doorActionUrl !== "string" ||
			typeof record.memberPass !== "string" ||
			!record.previewId ||
			!record.doorActionUrl ||
			!record.memberPass
		) {
			throw new CloudSurfacesError("Invalid qorpera_mint_surface_preview_pass fields");
		}
		return {
			previewId: record.previewId,
			doorActionUrl: record.doorActionUrl,
			memberPass: record.memberPass,
		};
	}

	async listSurfaces(companyId: string): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_list_surfaces", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_list_surfaces payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}

	async createSurface(companyId: string, input: CreateSurfaceRpcInput): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_create_surface", {
			p_company_id: companyId,
			p_title: input.title,
			p_slug: input.slug ?? null,
			p_archetype: input.archetype,
			p_kind: input.kind ?? "custom",
			p_icon: input.icon ?? "globe",
			p_accent_hex: input.accentHex ?? null,
			p_folder_root: input.folderRoot ?? null,
			p_brief_summary: input.briefSummary ?? null,
			p_is_global: input.isGlobal ?? input.kind === "identity",
		});
		return parseSurfaceSummary(data, "surface");
	}

	async bootstrapCompanySurfaces(companyId: string): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_bootstrap_company_surfaces", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_bootstrap_company_surfaces payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}

	async getSurfaceWorkspace(surfaceId: string): Promise<SurfaceWorkspace> {
		const data = await this.#rpc("qorpera_get_surface_workspace", { p_surface_id: surfaceId });
		return parseSurfaceWorkspace(data, "workspace");
	}

	async approveProposedSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_approve_proposed_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async archiveSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_archive_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async setSurfaceAutoPublish(surfaceId: string, enabled: boolean): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_set_surface_auto_publish", {
			p_surface_id: surfaceId,
			p_auto_publish: enabled,
		});
		return parseSurfaceSummary(data, "surface");
	}

	async setSurfaceFigure(surfaceId: string, figure: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_set_surface_figure", { p_surface_id: surfaceId, p_figure: figure });
		return parseSurfaceSummary(data, "surface");
	}

	async startSurfaceSession(
		surfaceId: string,
		prompt: string,
		options: StartSurfaceSessionOptions = {},
	): Promise<SurfaceSession> {
		const target = options.target ? parsePointToChangeTarget(options.target) : null;
		const images = options.images ?? [];
		if (images.length > 0 && !options.clientInputId)
			throw new CloudSurfacesError("Surface session images need a client input id");
		const args = {
			p_surface_id: surfaceId,
			p_prompt: prompt,
			p_title: options.title ?? null,
			p_origin_kind: options.originKind ?? (target ? "point_to_change" : "member"),
			p_origin_label: options.originLabel ?? null,
			p_origin_ref: target,
			p_exploration_count: options.explorationCount ?? null,
			p_exploration_title: options.explorationTitle ?? null,
			...(options.variantLabels ? { p_variant_labels: [...options.variantLabels] } : {}),
		};
		const data =
			images.length > 0
				? await this.#rpc("qorpera_start_surface_session_with_images", {
						...args,
						p_client_input_id: options.clientInputId,
						p_images: surfaceImageRows(images),
					})
				: await this.#rpc("qorpera_start_surface_session", args);
		return parseSurfaceSession(data, "session");
	}

	async replySurfaceSession(
		sessionId: string,
		message: string,
		keepOpen = true,
		attach?: { clientInputId: string; images: readonly SurfaceImageRef[] },
	): Promise<SurfaceSession> {
		const args = { p_session_id: sessionId, p_message: message, p_keep_open: keepOpen };
		const data =
			attach && attach.images.length > 0
				? await this.#rpc("qorpera_reply_surface_session_with_images", {
						...args,
						p_client_input_id: attach.clientInputId,
						p_images: surfaceImageRows(attach.images),
					})
				: await this.#rpc("qorpera_reply_surface_session", args);
		return parseSurfaceSession(data, "session");
	}

	async noteSurfaceSession(sessionId: string, message: string, to: readonly string[]): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_surface_session_note", {
			p_session_id: sessionId,
			p_message: message,
			p_to: [...to],
		});
		return parseSurfaceSession(data, "session");
	}

	async unseenSurfaceNotes(companyId: string): Promise<SurfaceUnseenNote[]> {
		const data = await this.#rpc("qorpera_surface_unseen_notes", { p_profile_id: companyId });
		return parseSurfaceUnseenNotes(data);
	}

	async markSurfaceNotesSeen(sessionId: string): Promise<void> {
		await this.#rpc("qorpera_surface_notes_seen", { p_session_id: sessionId });
	}

	async surfaceSessionImages(sessionId: string): Promise<SurfaceSessionImages> {
		const data = await this.#rpc("qorpera_surface_session_images", { p_session_id: sessionId });
		return parseSurfaceSessionImages(data);
	}

	async setSessionChatOpen(sessionId: string, open: boolean): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_set_session_chat_open", {
			p_session_id: sessionId,
			p_open: open,
		});
		return parseSurfaceSession(data, "session");
	}

	async approveSurfaceChange(changeId: string, includeDependencies = true): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_approve_surface_change", {
			p_change_id: changeId,
			p_include_dependencies: includeDependencies,
		});
		return parseSurfaceSession(data, "session");
	}

	async approveSessionAll(sessionId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_approve_session_all", { p_session_id: sessionId });
		return parseSurfaceSession(data, "session");
	}

	async discardSurfaceChange(changeId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_discard_surface_change", { p_change_id: changeId });
		return parseSurfaceSession(data, "session");
	}

	async undoSurfaceChange(changeId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_undo_surface_change", { p_change_id: changeId });
		return parseSurfaceSession(data, "session");
	}

	async chooseExploration(explorationId: string, sessionId: string): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_choose_exploration", {
			p_exploration_id: explorationId,
			p_session_id: sessionId,
		});
		return parseSurfaceSession(data, "session");
	}

	async discardExploration(explorationId: string): Promise<void> {
		await this.#rpc("qorpera_discard_exploration", { p_exploration_id: explorationId });
	}

	async reconcileChanges(surfaceId: string, changeIds: readonly string[]): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_reconcile_surface_changes", {
			p_surface_id: surfaceId,
			p_change_ids: [...changeIds],
		});
		return parseSurfaceSession(data, "session");
	}

	async spawnCrossSurfaceSession(request: CrossSurfaceHandoffRequest): Promise<SurfaceSession> {
		const data = await this.#rpc("qorpera_spawn_cross_surface_session", {
			p_source_surface_id: request.sourceSurfaceId,
			p_target_surface_slug: request.targetSurfaceSlug,
			p_prompt: request.prompt,
			p_title: request.title ?? null,
			p_source_ref: request.sourceRef ?? null,
		});
		return parseSurfaceSession(data, "session");
	}

	async setPreviewSelection(
		surfaceId: string,
		selection: SetSurfacePreviewSelectionInput,
	): Promise<SurfacePreviewCompositionState> {
		const data = await this.#rpc("qorpera_set_preview_selection", {
			p_surface_id: surfaceId,
			p_toggled_change_ids: [...selection.toggledChangeIds],
			p_exploration_session_id: selection.explorationSessionId ?? null,
			p_compare_session_ids: selection.compareSessionIds ? [...selection.compareSessionIds] : [],
			p_active_route: selection.activeRoute ?? "/",
		});
		return parseSurfacePreviewCompositionState(data, "previewState");
	}

	async publishSurface(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_publish_surface", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async askSurfacePublish(surfaceId: string, userId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_ask_surface_publish", { p_surface_id: surfaceId, p_user_id: userId });
		return parseSurfaceSummary(data, "surface");
	}

	async declineSurfacePublishAsk(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_decline_surface_publish_ask", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async withdrawSurfacePublishAsk(surfaceId: string): Promise<SurfaceSummary> {
		const data = await this.#rpc("qorpera_withdraw_surface_publish_ask", { p_surface_id: surfaceId });
		return parseSurfaceSummary(data, "surface");
	}

	async listAutomations(companyId: string): Promise<SurfaceAutomationSummary[]> {
		const data = await this.#rpc("qorpera_list_automations", { p_company_id: companyId });
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_list_automations payload");
		return data.map((item, index) => parseSurfaceAutomationSummary(item, `automations[${index}]`));
	}

	async toggleAutomation(automationId: string, enabled: boolean): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_toggle_automation", {
			p_automation_id: automationId,
			p_enabled: enabled,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async createAutomation(companyId: string, input: CreateSurfaceAutomationInput): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_create_surface_automation", {
			p_company_id: companyId,
			p_title: input.title,
			p_prompt: input.prompt,
			p_schedule_summary: input.scheduleSummary ?? "Every day · 09:00",
			p_target_surface_slug: input.targetSurfaceSlug ?? null,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async updateAutomation(
		automationId: string,
		input: UpdateSurfaceAutomationInput,
	): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_update_surface_automation", {
			p_automation_id: automationId,
			p_title: input.title ?? null,
			p_prompt: input.prompt ?? null,
			p_schedule_summary: input.scheduleSummary ?? null,
			p_target_surface_slug: input.targetSurfaceSlug ?? null,
			p_clear_target: input.targetSurfaceSlug === null,
		});
		return parseSurfaceAutomationSummary(data, "automation");
	}

	async offerAutomation(automationId: string, toUserId: string): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_offer_surface_automation", {
			p_automation_id: automationId,
			p_to_user_id: toUserId,
		});
		return automationOf(data, "qorpera_offer_surface_automation");
	}

	async answerAutomationOffer(offerId: string, yes: boolean): Promise<SurfaceAutomationSummary> {
		const data = await this.#rpc("qorpera_answer_surface_automation_offer", { p_offer_id: offerId, p_yes: yes });
		return automationOf(data, "qorpera_answer_surface_automation_offer");
	}

	async deleteAutomation(automationId: string): Promise<boolean> {
		const data = await this.#rpc("qorpera_delete_surface_automation", { p_automation_id: automationId });
		return data === true;
	}

	async getMigrationChecklist(companyId: string): Promise<SurfaceMigrationChecklist> {
		const data = await this.#rpc("qorpera_surface_migration_checklist", { p_company_id: companyId });
		return parseSurfaceMigrationChecklist(data, "migrationChecklist");
	}

	async applyMigrationChecklist(companyId: string, input: ApplySurfaceMigrationInput): Promise<SurfaceSummary[]> {
		const data = await this.#rpc("qorpera_apply_surface_migration", {
			p_company_id: companyId,
			p_activate_surface_slugs: [...input.activateSurfaceSlugs],
			p_agent_decisions: input.agentDecisions,
			p_archive_board_names: [...input.archiveBoardNames],
		});
		if (!Array.isArray(data)) throw new CloudSurfacesError("Invalid qorpera_apply_surface_migration payload");
		return data.map((item, index) => parseSurfaceSummary(item, `surfaces[${index}]`));
	}
}

export type {
	PointToChangeTarget,
	SurfaceAutomationSummary,
	SurfaceChangeUnit,
	SurfaceMigrationChecklist,
	SurfacePreviewCompositionState,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
};
