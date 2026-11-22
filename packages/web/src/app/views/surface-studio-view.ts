import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import {
	type CompiledIdentityTokens,
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfacePreviewConflict,
	type SurfaceSummary,
	sharedAssetsConsumedBy,
	sharedAssetsProducedBy,
} from "@qorpera/contracts";
import { AppFrame } from "../../ui/app-frame.ts";
import { h } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { framePage } from "../../ui/page-frame.ts";
import { t } from "../../ui/preferences.ts";
import {
	effectiveStudioBaseFiles,
	formatConflictPaths,
	isLocalSurfaceId,
	isOpenChange,
	normalizeStudioPatchOps,
	type SurfacesStore,
	type SurfaceUpdatePhase,
} from "../surfaces-store.ts";
import { surfaceTile } from "./surface-rail.ts";
import { SurfaceReportView } from "./surface-report-view.ts";
import { type Studio3DConfig, Studio3DViewer } from "./surface-studio-3d.ts";

export interface SurfaceStudioOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles?: Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly loadFiles?: (surface: SurfaceSummary, signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
}

interface ColorToken {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly changed: boolean;
}

interface TypeToken {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly changed: boolean;
}

interface SpecTable {
	readonly title: string;
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, string>[];
}

interface SpecEntry {
	readonly key: string;
	readonly value: string;
	readonly prev?: string;
	readonly changed: boolean;
}

interface SpecSection {
	readonly path: string;
	readonly title: string;
	readonly changed: boolean;
	readonly entries: readonly SpecEntry[];
	readonly tables: readonly SpecTable[];
}

interface VendorCard {
	readonly vendor: string;
	readonly component: string;
	readonly region?: string;
	readonly moq?: string;
	readonly leadTime?: string;
	readonly unitPrice?: string;
	readonly status?: string;
	readonly certifications?: string;
	readonly changed: boolean;
}

interface StudioDoc {
	readonly path: string;
	readonly title: string;
	readonly content: string;
	readonly baseContent?: string;
	readonly isMarkdown: boolean;
	readonly changed: boolean;
}

interface StudioHtmlPage {
	readonly path: string;
	readonly title: string;
	readonly html: string;
	readonly baseHtml?: string;
	readonly changed: boolean;
}

interface StudioSvgAsset {
	readonly path: string;
	readonly title: string;
	readonly svg: string;
	readonly baseSvg?: string;
	readonly changed: boolean;
}

type StudioTab = "overview" | "specs" | "vendors" | "analysis" | "files" | "pages";

const COLOR_VALUE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^)]+\)|oklch\([^)]+\))$/i;
const COLOR_GROUPS = new Set(["colors", "color", "palette", "swatches", "colorways"]);
const TYPE_GROUPS = new Set(["font", "fonts", "typography", "type", "typeface"]);
const MODEL_GROUPS = new Set(["model", "3d", "geometry"]);
const VENDOR_GROUPS = new Set(["vendors", "suppliers"]);
const HTML_FILE_RE = /\.html?$/i;
const SVG_FILE_RE = /\.svg$/i;
const MARKDOWN_FILE_RE = /\.(?:md|markdown)$/i;
const PROSE_TEXT_FILE_RE = /\.txt$/i;
const TOKEN_STYLESHEET_RE = /(?:^|\/)(?:tokens|qorpera-identity)\.css$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function readableName(raw: string): string {
	const base =
		raw
			.split("/")
			.at(-1)
			?.replace(/\.[a-z0-9]+$/i, "") ?? raw;
	const spaced = base
		.replace(/[-_]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	if (!spaced) return raw;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "–";
	if (Array.isArray(value)) return value.map(formatScalar).join(", ");
	return JSON.stringify(value);
}

function lookupPath(root: Record<string, unknown> | undefined, segments: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function collectColors(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	segments: readonly string[],
	out: ColorToken[],
): void {
	if (typeof value === "string" && COLOR_VALUE.test(value.trim())) {
		const prev = lookupPath(baseRoot, segments);
		const label = segments.slice(-1)[0] ?? "";
		out.push({
			key: segments.join("."),
			label: readableName(label),
			value: value.trim(),
			changed: prev !== value,
		});
		return;
	}
	if (Array.isArray(value)) {
		const prevList = lookupPath(baseRoot, segments);
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (!isPlainRecord(item)) continue;
			const color = [item.hex, item.color, item.value].find(
				(candidate): candidate is string => typeof candidate === "string" && COLOR_VALUE.test(candidate.trim()),
			);
			if (!color) continue;
			const name =
				typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : `#${index + 1}`;
			const prevItem = Array.isArray(prevList) ? prevList[index] : undefined;
			const prevColor = isPlainRecord(prevItem) ? (prevItem.hex ?? prevItem.color ?? prevItem.value) : undefined;
			out.push({
				key: `${segments.join(".")}[${index}]`,
				label: name,
				value: color.trim(),
				changed: prevColor !== color,
			});
		}
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) collectColors(child, baseRoot, [...segments, key], out);
}

function collectTypography(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	segments: readonly string[],
	out: TypeToken[],
): void {
	if (typeof value === "string" && value.trim()) {
		const prev = lookupPath(baseRoot, segments);
		out.push({
			key: segments.join("."),
			label: readableName(segments.at(-1) ?? ""),
			value: value.trim(),
			changed: prev !== value,
		});
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) collectTypography(child, baseRoot, [...segments, key], out);
}

function collectSpecs(
	obj: Record<string, unknown>,
	baseObj: Record<string, unknown> | undefined,
	prefix: readonly string[],
	entries: SpecEntry[],
	tables: SpecTable[],
): void {
	for (const [key, value] of Object.entries(obj)) {
		const segments = [...prefix, key];
		const lower = key.toLowerCase();
		if (
			prefix.length === 0 &&
			(COLOR_GROUPS.has(lower) || TYPE_GROUPS.has(lower) || MODEL_GROUPS.has(lower) || VENDOR_GROUPS.has(lower))
		)
			continue;
		if (typeof value === "string" && COLOR_VALUE.test(value.trim())) continue;
		if (Array.isArray(value) && value.length > 0 && value.every(isPlainRecord)) {
			const columns: string[] = [];
			for (const row of value) for (const col of Object.keys(row)) if (!columns.includes(col)) columns.push(col);
			tables.push({
				title: readableName(key),
				columns,
				rows: value.map((row) =>
					Object.fromEntries(columns.map((col) => [col, formatScalar((row as Record<string, unknown>)[col])])),
				),
			});
			continue;
		}
		if (isPlainRecord(value)) {
			collectSpecs(value, baseObj, segments, entries, tables);
			continue;
		}
		const prev = lookupPath(baseObj, segments);
		const changed = JSON.stringify(prev) !== JSON.stringify(value);
		entries.push({
			key: segments.map(readableName).join(" · "),
			value: formatScalar(value),
			...(changed && prev !== undefined ? { prev: formatScalar(prev) } : {}),
			changed,
		});
	}
}

function collectVendors(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	key: string,
	out: VendorCard[],
): void {
	if (!Array.isArray(value)) return;
	const baseList = baseRoot?.[key];
	for (let index = 0; index < value.length; index++) {
		const row = value[index];
		if (!isPlainRecord(row)) continue;
		const vendor = formatScalar(row.vendor ?? row.supplier ?? row.name);
		const component = formatScalar(row.component ?? row.part ?? row.role ?? "");
		const prevRow = Array.isArray(baseList) ? baseList[index] : undefined;
		out.push({
			vendor,
			component,
			...(row.region ? { region: formatScalar(row.region) } : {}),
			...(row.moq ? { moq: formatScalar(row.moq) } : {}),
			...(row.leadTime ? { leadTime: formatScalar(row.leadTime) } : {}),
			...((row.unitPrice ?? row.unitCost) ? { unitPrice: formatScalar(row.unitPrice ?? row.unitCost) } : {}),
			...(row.status ? { status: formatScalar(row.status) } : {}),
			...(row.certifications ? { certifications: formatScalar(row.certifications) } : {}),
			changed: JSON.stringify(prevRow) !== JSON.stringify(row),
		});
	}
}

function extractModelConfig(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	key: string,
	title: string,
	colors: readonly ColorToken[],
): Studio3DConfig | undefined {
	if (!isPlainRecord(value)) return undefined;
	const kind = value.kind === "headband" ? "headband" : "device";
	const dimensions = typeof value.dimensions === "string" ? value.dimensions : "";
	const layers = Array.isArray(value.layers) ? value.layers.map(formatScalar) : [];
	const colorways = colors.length
		? colors.map((c) => ({ name: c.label, hex: c.value }))
		: [{ name: "Sandstone", hex: "#e6dfd3" }];
	return {
		kind,
		title,
		dimensions,
		colorways,
		layers,
		changed: JSON.stringify(baseRoot?.[key]) !== JSON.stringify(value),
	};
}

function docPriority(path: string): number {
	const lower = path.toLowerCase();
	if (lower.includes("voice") || lower.includes("brief") || lower.includes("readme")) return 0;
	if (lower.includes("spec") || lower.includes("guide")) return 1;
	return 2;
}

function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function htmlDocumentTitle(html: string, fallbackPath: string): string {
	const match = html.match(/<title\b[^>]*>([\s\S]{1,200}?)<\/title>/i);
	if (!match) return readableName(fallbackPath);
	const title = new DOMParser()
		.parseFromString(`<title>${match[1]}</title>`, "text/html")
		.title.trim()
		.replace(/\s+/g, " ");
	return title && title.length <= 80 ? title : readableName(fallbackPath);
}

function resolveRelativeStudioPath(fromFilePath: string, href: string): string | null {
	const trimmed = href.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;
	const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
	if (!withoutQuery) return null;
	const fromParts = fromFilePath.includes("/") ? fromFilePath.slice(0, fromFilePath.lastIndexOf("/")).split("/") : [];
	const minDepth = fromParts.length > 0 ? 1 : 0;
	const baseParts = withoutQuery.startsWith("/") ? [] : [...fromParts];
	for (const part of withoutQuery.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (baseParts.length <= (withoutQuery.startsWith("/") ? 0 : minDepth)) return null;
			baseParts.pop();
			continue;
		}
		baseParts.push(part);
	}
	const resolved = baseParts.join("/");
	if (!resolved) return null;
	if (withoutQuery.startsWith("/") && minDepth > 0 && !TOKEN_STYLESHEET_RE.test(resolved)) {
		if (resolved !== fromParts[0] && !resolved.startsWith(`${fromParts[0]}/`)) return null;
	}
	return resolved;
}

function compiledTokensCssFrom(
	files: Readonly<Record<string, string>>,
	folderRoot: string | null | undefined,
	fallbackCss: string,
): string {
	const cleanRoot = folderRoot?.replace(/^\/+|\/+$/g, "");
	const tokensJson =
		files[IDENTITY_TOKENS_JSON_PATH] ??
		(cleanRoot ? files[`${cleanRoot}/tokens.json`] : undefined) ??
		files["tokens.json"];
	if (tokensJson?.trim()) {
		const compiled = compileIdentityTokensCss(tokensJson);
		if (compiled) return compiled;
	}
	return files[IDENTITY_TOKENS_CSS_PATH] ?? (cleanRoot ? files[`${cleanRoot}/tokens.css`] : undefined) ?? fallbackCss;
}

function studioHtmlDependencyChanged(
	html: string,
	htmlPath: string,
	files: Readonly<Record<string, string>>,
	baseFiles: Readonly<Record<string, string>>,
	previewTokensCss: string,
	baseTokensCss: string,
): boolean {
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		if (!/\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)/i.test(tag)) continue;
		const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rawHref = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
		const resolved = resolveRelativeStudioPath(htmlPath, rawHref);
		if (!resolved) continue;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			const nextCss = previewTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH] || "";
			const prevCss = baseTokensCss || baseFiles[resolved] || baseFiles[IDENTITY_TOKENS_CSS_PATH] || "";
			if (nextCss !== prevCss) return true;
		} else if (/\.css$/i.test(resolved)) {
			if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
		}
	}
	for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
		const src = match[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rawSrc = src?.[1] ?? src?.[2] ?? src?.[3] ?? "";
		const resolved = resolveRelativeStudioPath(htmlPath, rawSrc);
		if (!resolved || !SVG_FILE_RE.test(resolved)) continue;
		if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
	}
	return false;
}

export function prepareStudioHtmlPreview(
	html: string,
	htmlPath: string,
	files: Readonly<Record<string, string>>,
	compiledTokensCss: string,
): string | null {
	const doc = new DOMParser().parseFromString(html, "text/html");
	let modified = false;
	for (const link of [...doc.querySelectorAll("link[href]")]) {
		const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
		if (!rel.includes("stylesheet")) continue;
		const resolved = resolveRelativeStudioPath(htmlPath, link.getAttribute("href") ?? "");
		if (!resolved) continue;
		let css: string | undefined;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			css = compiledTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH];
		} else if (/\.css$/i.test(resolved)) {
			css = files[resolved];
		}
		if (!css) continue;
		const style = doc.createElement("style");
		style.textContent = css.replace(/<\/style/gi, "<\\/style");
		link.replaceWith(style);
		modified = true;
	}
	for (const img of [...doc.querySelectorAll("img[src]")]) {
		const resolved = resolveRelativeStudioPath(htmlPath, img.getAttribute("src") ?? "");
		if (!resolved || !SVG_FILE_RE.test(resolved)) continue;
		const svg = files[resolved]?.trim();
		if (!svg || !/<svg[\s>]/i.test(svg)) continue;
		img.setAttribute("src", svgDataUrl(svg));
		modified = true;
	}
	if (!modified) return framePage(html);
	const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "<!doctype html>";
	return framePage(`${doctype}${doc.documentElement.outerHTML}`);
}

function updatingLabel(phase: SurfaceUpdatePhase): string {
	if (phase === "publishing") return t("Publishing…");
	if (phase === "merging") return t("Applying…");
	return t("Updating…");
}

function sameDeps(prev: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
	if (!prev || prev.length !== next.length) return false;
	for (let i = 0; i < next.length; i++) {
		if (!Object.is(prev[i], next[i])) return false;
	}
	return true;
}

function sameOrderedChanges(
	prev: readonly StudioPatchChange[] | undefined,
	next: readonly StudioPatchChange[],
): boolean {
	if (!prev || prev.length !== next.length) return false;
	for (let i = 0; i < next.length; i++) {
		if (prev[i]!.changeId !== next[i]!.changeId || prev[i]!.ops !== next[i]!.ops) return false;
	}
	return true;
}

export class SurfaceStudioView {
	readonly el = h("div", { class: "surface-studio" });
	readonly #options: SurfaceStudioOptions;
	readonly #lifetime = new AbortController();
	#baseFiles: Readonly<Record<string, string>>;
	#loading = false;
	#lastConflict: SurfacePreviewConflict | null = null;
	#viewer3d: Studio3DViewer | undefined;
	#reportView: SurfaceReportView | undefined;
	readonly #htmlFrames: AppFrame[] = [];
	#tab: StudioTab = "overview";
	#shownDeps: readonly unknown[] | undefined;
	#shownOrdered: readonly StudioPatchChange[] | undefined;
	#appliedIdentityVars: string[] = [];
	#wasUpdating = false;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: SurfaceStudioOptions) {
		this.#options = options;
		this.#baseFiles = options.baseFiles ? { ...options.baseFiles } : {};
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.el.addEventListener("click", (event) => this.#click(event), { signal: this.#lifetime.signal });
		if (!options.baseFiles) {
			const cloudManaged =
				options.store.canLoadCloudFiles &&
				!isLocalSurfaceId(options.surface.id) &&
				options.store.state.source === "cloud";
			if (cloudManaged) {
				if (!options.store.state.cloudSurfaceFiles[options.surface.id]) {
					void options.store.refreshCloudFiles(options.surface);
				}
			} else if (options.loadFiles) {
				void this.#load();
			}
		}
		this.update();
	}

	dispose(): void {
		this.#disposeHtmlFrames();
		if (this.#settleTimer) {
			clearTimeout(this.#settleTimer);
			this.#settleTimer = undefined;
		}
		this.#reportView?.dispose();
		this.#lifetime.abort();
	}

	#disposeHtmlFrames(): void {
		for (const frame of this.#htmlFrames) frame.dispose();
		this.#htmlFrames.length = 0;
	}

	#createHtmlFrame(
		html: string,
		htmlPath: string,
		title: string,
		files: Readonly<Record<string, string>>,
		compiledTokensCss: string,
		className: string,
	): HTMLElement {
		const live = prepareStudioHtmlPreview(html, htmlPath, files, compiledTokensCss);
		if (live === null) {
			return h("p", { class: "studio-html-fallback" }, t("This page can't be shown live."));
		}
		const frame = new AppFrame(
			{ html: live },
			t("Page: {name}", { name: title }),
			className,
			async () => ({ ok: false, error: t("This page can't be shown here.") }),
			() => undefined,
			{ again: true },
		);
		this.#htmlFrames.push(frame);
		return frame.frame;
	}

	async #load(): Promise<void> {
		const loadFiles = this.#options.loadFiles;
		if (!loadFiles) return;
		this.#loading = true;
		this.update();
		try {
			const loaded = await loadFiles(this.#options.surface, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#baseFiles = { ...loaded };
		} catch {
			/* WHY: An empty or unreadable studio folder renders the calm starter baseline instead of blocking the surface. */
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.update();
			}
		}
	}

	#orderedChanges(folderRoot: string | null | undefined): StudioPatchChange[] {
		const store = this.#options.store;
		const state = store.state;
		if (state.mode === "live") return [];
		const ordered: StudioPatchChange[] = [];
		for (const session of store.activePreviewSessions(this.#options.surface.id)) {
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isOpenChange(change) || !store.isChangeShown(change.id)) continue;
				const ops = this.#options.patches?.[change.id] ?? state.studioPatches[change.id];
				if (ops?.length) ordered.push({ changeId: change.id, ops: normalizeStudioPatchOps(ops, folderRoot) });
			}
		}
		return ordered;
	}

	#effectiveBaseFiles(surfaceId: string): Readonly<Record<string, string>> {
		const state = this.#options.store.state;
		const storeBase = effectiveStudioBaseFiles(state, surfaceId);
		if (!storeBase) return this.#baseFiles;
		return this.#options.baseFiles ? { ...this.#baseFiles, ...storeBase } : storeBase;
	}

	#applyIdentityVars(isIdentity: boolean, tokens: CompiledIdentityTokens | null): void {
		const nextVars = !isIdentity && tokens ? tokens.vars : {};
		const nextKeys = Object.keys(nextVars);
		const nextSet = new Set(nextKeys);
		for (const prop of this.#appliedIdentityVars) {
			if (!nextSet.has(prop)) this.el.style.removeProperty(prop);
		}
		for (const prop of nextKeys) {
			const value = nextVars[prop];
			if (value) this.el.style.setProperty(prop, value);
		}
		this.#appliedIdentityVars = nextKeys;
		this.el.classList.toggle("has-identity-tokens", nextKeys.length > 0);
	}

	update(): void {
		const store = this.#options.store;
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === this.#options.surface.id) ?? this.#options.surface;
		const baseFiles = this.#effectiveBaseFiles(surface.id);
		const lookKind = store.lookOf(surface).kind;
		const isIdentitySurface =
			surface.isGlobal === true ||
			lookKind === "identity" ||
			surface.slug === "identity" ||
			Object.keys(baseFiles).some((path) => path.startsWith("identity/"));
		const identityTokens = store.companyIdentityTokens();
		this.#applyIdentityVars(isIdentitySurface, identityTokens);
		const workspace = store.workspace(surface.id);
		const ordered = this.#orderedChanges(surface.folderRoot);
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const updatingPhase = store.surfaceUpdatePhase(surface.id);
		const updating = updatingPhase !== null;
		const initialLoading =
			this.#loading || (!state.cloudSurfaceFiles[surface.id] && store.isCloudFilesLoading(surface.id));
		this.el.classList.toggle("is-updating", updating);
		this.el.setAttribute("aria-busy", String(updating));
		if (updating) {
			if (this.#settleTimer) {
				clearTimeout(this.#settleTimer);
				this.#settleTimer = undefined;
			}
			this.el.classList.remove("is-settled");
		} else if (this.#wasUpdating) {
			this.el.classList.add("is-settled");
			if (this.#settleTimer) clearTimeout(this.#settleTimer);
			this.#settleTimer = setTimeout(() => {
				this.#settleTimer = undefined;
				this.el.classList.remove("is-settled");
			}, 600);
		}
		this.#wasUpdating = updating;
		const activeOtherSurfaces = state.surfaces.filter((item) => item.status === "active" && item.id !== surface.id);
		const downstreamSurfaces = activeOtherSurfaces.filter((item) => item.group === "products");
		const deps: readonly unknown[] = [
			initialLoading,
			updatingPhase,
			state.mode,
			this.#tab,
			this.#baseFiles,
			state.cloudSurfaceFiles[surface.id],
			state.pendingStudioPatches[surface.id],
			state.localStudioBase[surface.id],
			surface,
			lookKind,
			identityTokens?.css ?? "",
			workspace?.briefSummary,
			state.surfaces,
			state.surfaceLooks,
			busyReconcile,
		];
		if (sameDeps(this.#shownDeps, deps) && sameOrderedChanges(this.#shownOrdered, ordered)) return;
		this.#shownDeps = deps;
		this.#shownOrdered = ordered;
		this.#disposeHtmlFrames();

		const composition = composeStudioPreview(baseFiles, ordered, surface.folderRoot);
		this.#lastConflict = composition.status === "conflicted" ? composition.conflictReport : null;
		const files = composition.files;
		const filePaths = Object.keys(files).sort();
		const previewTokensCss = compiledTokensCssFrom(files, surface.folderRoot, identityTokens?.css ?? "");
		const baseTokensCss = compiledTokensCssFrom(baseFiles, surface.folderRoot, identityTokens?.css ?? "");

		const colors: ColorToken[] = [];
		const typography: TypeToken[] = [];
		const specs: SpecSection[] = [];
		const vendors: VendorCard[] = [];
		const docs: StudioDoc[] = [];
		const htmlPages: StudioHtmlPage[] = [];
		const svgs: StudioSvgAsset[] = [];
		const reportPaths: string[] = [];
		let rawModel:
			| { readonly value: unknown; readonly base: Record<string, unknown> | undefined; readonly key: string }
			| undefined;

		for (const path of filePaths) {
			const content = files[path] ?? "";
			const baseContent = baseFiles[path];
			const changed = baseContent !== content;
			if (/\.report\.json$/i.test(path)) {
				reportPaths.push(path);
				continue;
			}
			if (path.toLowerCase().endsWith(".json")) {
				const parsed = parseJsonObject(content);
				if (parsed) {
					const baseParsed = parseJsonObject(baseContent);
					for (const [k, v] of Object.entries(parsed)) {
						const lower = k.toLowerCase();
						if (COLOR_GROUPS.has(lower)) collectColors(v, baseParsed, [k], colors);
						else if (TYPE_GROUPS.has(lower)) collectTypography(v, baseParsed, [k], typography);
						else if (VENDOR_GROUPS.has(lower)) collectVendors(v, baseParsed, k, vendors);
						else if (MODEL_GROUPS.has(lower) && !rawModel) rawModel = { value: v, base: baseParsed, key: k };
						else if (typeof v === "string" && COLOR_VALUE.test(v.trim()))
							collectColors(v, baseParsed, [k], colors);
					}
					const entries: SpecEntry[] = [];
					const tables: SpecTable[] = [];
					collectSpecs(parsed, baseParsed, [], entries, tables);
					if (entries.length || tables.length)
						specs.push({ path, title: readableName(path), changed, entries, tables });
				}
				continue;
			}
			if (HTML_FILE_RE.test(path)) {
				const dependencyChanged = studioHtmlDependencyChanged(
					content,
					path,
					files,
					baseFiles,
					previewTokensCss,
					baseTokensCss,
				);
				htmlPages.push({
					path,
					title: htmlDocumentTitle(content, path),
					html: content,
					...(baseContent !== undefined ? { baseHtml: baseContent } : {}),
					changed: changed || dependencyChanged,
				});
				continue;
			}
			if (SVG_FILE_RE.test(path)) {
				const trimmed = content.trim();
				if (/<svg[\s>]/i.test(trimmed)) {
					const baseTrimmed = baseContent?.trim();
					svgs.push({
						path,
						title: readableName(path),
						svg: trimmed,
						...(baseTrimmed && /<svg[\s>]/i.test(baseTrimmed) ? { baseSvg: baseTrimmed } : {}),
						changed,
					});
				}
				continue;
			}
			if (MARKDOWN_FILE_RE.test(path) || PROSE_TEXT_FILE_RE.test(path)) {
				docs.push({
					path,
					title: readableName(path),
					content,
					...(baseContent !== undefined ? { baseContent } : {}),
					isMarkdown: MARKDOWN_FILE_RE.test(path),
					changed,
				});
			}
		}
		docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));
		const modelConfig = rawModel
			? extractModelConfig(rawModel.value, rawModel.base, rawModel.key, surface.title, colors)
			: undefined;

		const badgeText =
			composition.status === "conflicted"
				? t("Conflict")
				: composition.appliedChangeIds.length === 1
					? t("1 live change applied")
					: composition.appliedChangeIds.length > 1
						? t("{count} live changes applied", { count: composition.appliedChangeIds.length })
						: t("Base");
		const badgeClass =
			composition.status === "conflicted"
				? "studio-badge is-conflict"
				: composition.appliedChangeIds.length > 0
					? "studio-badge is-live"
					: "studio-badge";

		const children: HTMLElement[] = [
			h(
				"div",
				{ class: "studio-head" },
				h(
					"div",
					{ class: "studio-head-meta" },
					surface.folderRoot ? h("span", { class: "studio-path" }, surface.folderRoot) : null,
					h("span", { class: badgeClass }, badgeText),
				),
				updatingPhase
					? h(
							"span",
							{
								class: "studio-updating-pill",
								role: "status",
								"aria-live": "polite",
								"data-updating-phase": updatingPhase,
							},
							h("span", { class: "surface-state is-running", "aria-hidden": "true" }),
							h("span", null, updatingLabel(updatingPhase)),
						)
					: null,
			),
		];

		if (composition.status === "conflicted") {
			const paths = formatConflictPaths(composition.conflictReport.paths);
			children.push(
				h(
					"div",
					{ class: "studio-conflict", role: "alert" },
					h("span", { class: "surface-state is-conflicted", "aria-hidden": "true" }),
					h(
						"span",
						{ title: composition.conflictReport.paths.join(", ") },
						t("Studio changes conflict in {paths}", { paths }),
					),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary btn-small",
							"data-act": "studio-reconcile",
							disabled: busyReconcile || composition.conflictReport.changeIds.length === 0,
						},
						t("Reconcile"),
					),
				),
			);
		}

		const allChangedPaths = [...new Set([...Object.keys(baseFiles), ...filePaths])]
			.sort()
			.filter((path) => baseFiles[path] !== files[path]);

		if (filePaths.length === 0 && (state.mode !== "compare" || allChangedPaths.length === 0)) {
			children.push(
				h(
					"div",
					{ class: "studio-empty" },
					initialLoading
						? [h("span", { class: "surface-state is-running" }), h("p", null, t("Opening studio…"))]
						: [
								surfaceTile(surface, this.#options.store.lookOf(surface), "is-hero"),
								h("h2", null, surface.title),
								workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
								h(
									"p",
									null,
									t("No studio files yet. Describe a change below to create tokens, specs, or guidelines."),
								),
							],
				),
			);
			this.el.replaceChildren(...children);
			return;
		}

		const sections: HTMLElement[] = [];

		if (state.mode === "compare") {
			const changedSpecs = specs.filter((spec) => spec.changed);
			const changedDocs = docs.filter((doc) => doc.changed);
			const changedSvgs = svgs.filter((asset) => asset.changed);
			const changedHtmlPages = htmlPages.filter((page) => page.changed);
			const renderedPaths = new Set<string>();
			for (const spec of changedSpecs) {
				const diffs = spec.entries.filter((entry) => entry.changed);
				if (!diffs.length) continue;
				renderedPaths.add(spec.path);
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-card", "data-compare-file": spec.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, spec.title),
							h("code", { class: "studio-file-tag" }, spec.path),
						),
						h(
							"div",
							{ class: "studio-compare-grid" },
							h("div", { class: "studio-compare-col-head" }, t("Base")),
							h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
							...diffs.flatMap((entry) => [
								h(
									"div",
									{ class: "studio-compare-cell is-base" },
									h("small", null, entry.key),
									h("span", null, entry.prev ?? t("Not set")),
								),
								h(
									"div",
									{ class: "studio-compare-cell is-preview" },
									h("small", null, entry.key),
									h("strong", null, entry.value),
								),
							]),
						),
					),
				);
			}
			for (const asset of changedSvgs) {
				renderedPaths.add(asset.path);
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-card", "data-compare-file": asset.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, asset.title),
							h("code", { class: "studio-file-tag" }, asset.path),
						),
						h(
							"div",
							{ class: "studio-compare-grid" },
							h("div", { class: "studio-compare-col-head" }, t("Base")),
							h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
							h(
								"div",
								{ class: "studio-compare-cell is-base studio-svg-stage" },
								asset.baseSvg
									? h("img", { class: "studio-svg-img", src: svgDataUrl(asset.baseSvg), alt: asset.title })
									: h("em", null, t("Not in Base")),
							),
							h(
								"div",
								{ class: "studio-compare-cell is-preview studio-svg-stage" },
								h("img", { class: "studio-svg-img", src: svgDataUrl(asset.svg), alt: asset.title }),
							),
						),
					),
				);
			}
			for (const doc of changedDocs) {
				renderedPaths.add(doc.path);
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-card", "data-compare-file": doc.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, doc.title),
							h("code", { class: "studio-file-tag" }, doc.path),
						),
						h(
							"div",
							{ class: "studio-compare-grid" },
							h("div", { class: "studio-compare-col-head" }, t("Base")),
							h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
							h(
								"div",
								{ class: "studio-compare-cell is-base studio-doc-body" },
								doc.baseContent
									? doc.isMarkdown
										? markdown(doc.baseContent)
										: h("div", { class: "studio-plain-text" }, doc.baseContent)
									: h("em", null, t("Not in Base")),
							),
							h(
								"div",
								{ class: "studio-compare-cell is-preview studio-doc-body" },
								doc.isMarkdown ? markdown(doc.content) : h("div", { class: "studio-plain-text" }, doc.content),
							),
						),
					),
				);
			}
			for (const page of changedHtmlPages) {
				renderedPaths.add(page.path);
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-card", "data-compare-file": page.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, page.title),
							h("code", { class: "studio-file-tag" }, page.path),
						),
						h(
							"div",
							{ class: "studio-compare-grid" },
							h("div", { class: "studio-compare-col-head" }, t("Base")),
							h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
							h(
								"div",
								{ class: "studio-compare-cell is-base" },
								page.baseHtml
									? this.#createHtmlFrame(
											page.baseHtml,
											page.path,
											page.title,
											baseFiles,
											baseTokensCss,
											"studio-html-frame is-compare",
										)
									: h("em", null, t("Not in Base")),
							),
							h(
								"div",
								{ class: "studio-compare-cell is-preview" },
								this.#createHtmlFrame(
									page.html,
									page.path,
									page.title,
									files,
									previewTokensCss,
									"studio-html-frame is-compare",
								),
							),
						),
					),
				);
			}
			const otherChangedPaths = allChangedPaths.filter((path) => !renderedPaths.has(path));
			if (otherChangedPaths.length > 0) {
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-card", "data-compare-other": "true" },
						h("div", { class: "studio-section-head" }, h("h2", null, t("Other changed files"))),
						h(
							"ul",
							{ class: "studio-changed-paths" },
							otherChangedPaths.map((path) =>
								h(
									"li",
									{ "data-compare-file": path },
									h("code", { class: "studio-file-tag" }, path),
									h(
										"span",
										{ class: "studio-changed-pill" },
										files[path] === undefined ? t("Removed") : t("Updated"),
									),
								),
							),
						),
					),
				);
			}
			if (sections.length === 0) {
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-compare-empty" },
						h("p", null, t("No open changes to compare against Base.")),
					),
				);
			}
			children.push(h("div", { class: "studio-grid" }, sections));
			this.el.replaceChildren(...children);
			return;
		}

		const isIdentity = isIdentitySurface || filePaths.some((path) => path.startsWith("identity/"));
		this.#applyIdentityVars(isIdentity, identityTokens);
		const isVendorSpec = (spec: SpecSection) => /vendor|supplier/i.test(spec.path);
		const primarySpec = specs.find((spec) => !isVendorSpec(spec));
		const vendorSpecs = specs.filter(isVendorSpec);
		const detailSpecs = specs.filter((spec) => !isVendorSpec(spec));
		const hasSpecsTab =
			detailSpecs.some((spec) => spec.tables.length > 0 || spec.entries.length > 0) || typography.length > 0;
		const hasVendorsTab = vendors.length > 0 || vendorSpecs.length > 0;
		const hasAnalysisTab = reportPaths.length > 0;
		const hasFilesTab = docs.length > 0;
		const hasPagesTab = htmlPages.length > 0;
		const hasNonIdentitySharedLinks =
			!isIdentity &&
			(sharedAssetsConsumedBy(lookKind).some((link) =>
				activeOtherSurfaces.some((item) => {
					const targetKind = store.lookOf(item).kind;
					return (
						link.producedBy.includes(targetKind) ||
						(link.producedBy.includes("identity") && item.isGlobal === true)
					);
				}),
			) ||
				sharedAssetsProducedBy(lookKind).some((link) =>
					activeOtherSurfaces.some((item) => link.consumedBy.includes(store.lookOf(item).kind)),
				));
		const hasOverviewContent = Boolean(
			(isIdentity && downstreamSurfaces.length > 0) ||
				hasNonIdentitySharedLinks ||
				modelConfig ||
				svgs.length ||
				colors.length ||
				(isIdentity && typography.length) ||
				(!isIdentity && primarySpec && primarySpec.entries.length > 0),
		);
		const tabbed = Boolean(modelConfig || vendors.length || reportPaths.length || isIdentity);
		const availableTabs: { readonly id: StudioTab; readonly label: string }[] = [];
		if (tabbed) {
			if (hasOverviewContent || (!hasSpecsTab && !hasVendorsTab && !hasAnalysisTab && !hasFilesTab && !hasPagesTab))
				availableTabs.push({ id: "overview", label: t("Overview") });
			if (hasSpecsTab)
				availableTabs.push({ id: "specs", label: isIdentity ? t("Design System") : t("Specs & BOM") });
			if (hasVendorsTab) availableTabs.push({ id: "vendors", label: t("Production & Vendors") });
			if (hasAnalysisTab)
				availableTabs.push({ id: "analysis", label: isIdentity ? t("Philosophy") : t("Analysis") });
			if (hasFilesTab)
				availableTabs.push({ id: "files", label: isIdentity ? t("Voice & Files") : t("Brief & Files") });
			if (hasPagesTab) availableTabs.push({ id: "pages", label: htmlPages.length === 1 ? t("Page") : t("Pages") });
			if (!availableTabs.some((tab) => tab.id === this.#tab)) this.#tab = availableTabs[0]!.id;
			children.push(
				h(
					"div",
					{ class: "studio-tabs", role: "tablist", "aria-label": t("Studio views") },
					...availableTabs.map((tab) =>
						h(
							"button",
							{
								type: "button",
								role: "tab",
								class: `studio-tab${this.#tab === tab.id ? " is-on" : ""}`,
								"aria-selected": String(this.#tab === tab.id),
								"data-act": "studio-tab",
								"data-tab": tab.id,
							},
							tab.label,
						),
					),
				),
			);
		}

		const renderSpecEntries = (entries: readonly SpecEntry[]) =>
			h(
				"dl",
				{ class: "studio-kv" },
				entries.flatMap((entry) => [
					h("dt", { class: entry.changed ? "is-changed" : "" }, entry.key),
					entry.changed && entry.prev !== undefined
						? h(
								"dd",
								{ class: "is-changed studio-diff-dd" },
								h("span", { class: "studio-diff-prev" }, entry.prev),
								h("span", { class: "studio-diff-arrow", "aria-hidden": "true" }, "→"),
								h("span", { class: "studio-diff-next" }, entry.value),
							)
						: h("dd", { class: entry.changed ? "is-changed" : "" }, entry.value),
				]),
			);

		const renderSpecTables = (tables: readonly SpecTable[]) =>
			tables.map((table) =>
				h(
					"div",
					{ class: "studio-table-wrap" },
					h("h3", { class: "studio-subhead" }, table.title),
					h(
						"table",
						{ class: "studio-table" },
						h(
							"thead",
							null,
							h(
								"tr",
								null,
								table.columns.map((col) => h("th", null, readableName(col))),
							),
						),
						h(
							"tbody",
							null,
							table.rows.map((row) =>
								h(
									"tr",
									null,
									table.columns.map((col) => h("td", null, row[col] ?? "–")),
								),
							),
						),
					),
				),
			);

		const showOverview = !tabbed || this.#tab === "overview";
		const showSpecs = !tabbed || this.#tab === "specs";
		const showVendors = !tabbed || this.#tab === "vendors";
		const showAnalysis = tabbed && this.#tab === "analysis";
		const showFiles = !tabbed || this.#tab === "files";
		const showPages = !tabbed || this.#tab === "pages";

		const identityVarCount = identityTokens ? Object.keys(identityTokens.vars).length : 0;

		if (isIdentity && showOverview && downstreamSurfaces.length > 0) {
			sections.push(
				h(
					"section",
					{ class: "studio-reach", "data-identity-reach": "true", "data-live-linked": "true" },
					h(
						"div",
						{ class: "studio-reach-head" },
						h("h2", null, t("Shapes these interfaces")),
						h("span", { class: "studio-file-tag" }, t("Live-linked via Company Files")),
					),
					h(
						"div",
						{ class: "studio-link-flow" },
						h("span", { class: "studio-live-dot", "aria-hidden": "true" }),
						h("code", { class: "studio-link-path" }, IDENTITY_TOKENS_JSON_PATH),
						h("span", { class: "studio-link-arrow", "aria-hidden": "true" }, "→"),
						h("code", { class: "studio-link-path" }, IDENTITY_TOKENS_CSS_PATH),
						identityVarCount > 0
							? h("span", { class: "studio-link-count" }, t("{count} CSS vars", { count: identityVarCount }))
							: null,
					),
					h(
						"p",
						{ class: "studio-reach-sub" },
						t("Design tokens, voice rules, and philosophy live here and flow into every surface below."),
					),
					h(
						"div",
						{ class: "studio-reach-chips" },
						downstreamSurfaces.map((target) =>
							h(
								"button",
								{
									type: "button",
									class: "studio-reach-chip",
									"data-act": "studio-open-surface",
									"data-slug": target.slug,
								},
								surfaceTile(target, store.lookOf(target), "is-tiny"),
								h("span", null, target.title),
							),
						),
					),
				),
			);
		} else if (!isIdentity && showOverview) {
			const consumed = sharedAssetsConsumedBy(lookKind);
			const produced = sharedAssetsProducedBy(lookKind);
			const linkRows: HTMLElement[] = [];
			const seenIncomingProducers = new Set<string>();
			for (const link of consumed) {
				if (link.liveSyncMode === "prompt_context" && link.producedBy.every((k) => seenIncomingProducers.has(k))) {
					continue;
				}
				const producers = activeOtherSurfaces.filter((item) => {
					const targetKind = store.lookOf(item).kind;
					return (
						link.producedBy.includes(targetKind) ||
						(link.producedBy.includes("identity") && item.isGlobal === true)
					);
				});
				if (!producers.length) continue;
				for (const k of link.producedBy) seenIncomingProducers.add(k);
				const primaryPath =
					link.liveSyncMode === "css_variables" && link.sourcePaths.includes(IDENTITY_TOKENS_CSS_PATH)
						? IDENTITY_TOKENS_CSS_PATH
						: (link.sourcePaths[0] ?? "");
				linkRows.push(
					h(
						"div",
						{ class: "studio-shared-link-row", "data-link-dir": "in", "data-link-id": link.id },
						h("span", { class: "studio-shared-link-dir" }, t("Inherits")),
						h("code", { class: "studio-link-path" }, primaryPath),
						h(
							"div",
							{ class: "studio-reach-chips" },
							producers.map((target) =>
								h(
									"button",
									{
										type: "button",
										class: "studio-reach-chip is-compact",
										"data-act": "studio-open-surface",
										"data-slug": target.slug,
									},
									surfaceTile(target, store.lookOf(target), "is-tiny"),
									h("span", null, target.title),
								),
							),
						),
					),
				);
			}
			for (const link of produced) {
				const consumers = activeOtherSurfaces
					.filter((item) => link.consumedBy.includes(store.lookOf(item).kind))
					.sort((a, b) => (a.group === "products" ? 0 : 1) - (b.group === "products" ? 0 : 1));
				if (!consumers.length) continue;
				const primaryPath = link.sourcePaths[0] ?? "";
				linkRows.push(
					h(
						"div",
						{ class: "studio-shared-link-row", "data-link-dir": "out", "data-link-id": link.id },
						h("span", { class: "studio-shared-link-dir" }, t("Feeds")),
						h("code", { class: "studio-link-path" }, primaryPath),
						h("span", { class: "studio-link-arrow", "aria-hidden": "true" }, "→"),
						h(
							"div",
							{ class: "studio-reach-chips" },
							consumers.map((target) =>
								h(
									"button",
									{
										type: "button",
										class: "studio-reach-chip is-compact",
										"data-act": "studio-open-surface",
										"data-slug": target.slug,
									},
									surfaceTile(target, store.lookOf(target), "is-tiny"),
									h("span", null, target.title),
								),
							),
						),
					),
				);
			}
			if (linkRows.length > 0) {
				sections.push(
					h(
						"section",
						{ class: "studio-shared-links", "data-live-linked": "true" },
						h(
							"div",
							{ class: "studio-shared-links-head" },
							h("span", { class: "studio-live-dot", "aria-hidden": "true" }),
							h("span", { class: "studio-shared-links-title" }, t("Live-linked via Company Files")),
							identityVarCount > 0
								? h("span", { class: "studio-link-count" }, t("{count} CSS vars", { count: identityVarCount }))
								: null,
						),
						h("div", { class: "studio-shared-links-list" }, ...linkRows),
					),
				);
			}
		}

		if (modelConfig && showOverview) {
			if (!this.#viewer3d) this.#viewer3d = new Studio3DViewer(modelConfig, this.#lifetime.signal);
			else this.#viewer3d.update(modelConfig);
			sections.push(this.#viewer3d.el);
		}

		if (svgs.length && showOverview) {
			sections.push(
				h(
					"section",
					{ class: "studio-section" },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, isIdentity ? t("Brand mark") : t("Vector assets")),
					),
					h(
						"div",
						{ class: "studio-svg-grid" },
						svgs.map((asset) =>
							h(
								"figure",
								{ class: `studio-svg-card${asset.changed ? " is-changed" : ""}`, "data-file": asset.path },
								h(
									"div",
									{ class: "studio-svg-stage" },
									h("img", {
										class: "studio-svg-img",
										src: svgDataUrl(asset.svg),
										alt: asset.title,
									}),
								),
								h(
									"figcaption",
									{ class: "studio-svg-meta" },
									h("strong", null, asset.title),
									h("code", { class: "studio-file-tag" }, asset.path),
									asset.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
								),
							),
						),
					),
				),
			);
		}

		if (colors.length && showOverview) {
			sections.push(
				h(
					"section",
					{ class: "studio-section" },
					h("div", { class: "studio-section-head" }, h("h2", null, t("Palette"))),
					h(
						"div",
						{ class: "studio-swatches" },
						colors.map((swatch) => {
							const chip = h("span", { class: "studio-swatch-chip", "aria-hidden": "true" });
							chip.style.backgroundColor = swatch.value;
							return h(
								"div",
								{
									class: `studio-swatch${swatch.changed ? " is-changed" : ""}`,
									"data-token": swatch.key,
								},
								chip,
								h(
									"div",
									{ class: "studio-swatch-meta" },
									h("strong", null, swatch.label),
									h("code", null, swatch.value),
								),
							);
						}),
					),
				),
			);
		}

		if (tabbed && showOverview && primarySpec && primarySpec.entries.length > 0 && !isIdentity) {
			sections.push(
				h(
					"section",
					{ class: `studio-section${primarySpec.changed ? " is-changed" : ""}`, "data-file": primarySpec.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, t("Key specs")),
						h("code", { class: "studio-file-tag" }, primarySpec.path),
						primarySpec.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
					),
					renderSpecEntries(primarySpec.entries),
				),
			);
		}

		if (typography.length && (showSpecs || (isIdentity && showOverview))) {
			sections.push(
				h(
					"section",
					{ class: "studio-section" },
					h("div", { class: "studio-section-head" }, h("h2", null, t("Typography"))),
					h(
						"div",
						{ class: "studio-type-list" },
						typography.map((item) => {
							const sample = h("p", { class: "studio-type-sample" }, t("Aa Bb Cc · 123"));
							sample.style.fontFamily = item.value;
							return h(
								"div",
								{ class: `studio-type-row${item.changed ? " is-changed" : ""}`, "data-token": item.key },
								h(
									"div",
									{ class: "studio-type-meta" },
									h("strong", null, item.label),
									h("code", null, item.value),
								),
								sample,
							);
						}),
					),
				),
			);
		}

		if (showVendors && (vendors.length || vendorSpecs.length)) {
			for (const spec of vendorSpecs) {
				if (!spec.entries.length) continue;
				sections.push(
					h(
						"section",
						{ class: `studio-section${spec.changed ? " is-changed" : ""}`, "data-file": spec.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, t("Production plan")),
							h("code", { class: "studio-file-tag" }, spec.path),
							spec.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						),
						renderSpecEntries(spec.entries),
					),
				);
			}
			if (vendors.length) {
				sections.push(
					h(
						"section",
						{ class: "studio-section studio-vendors" },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, t("Production & Vendors")),
							h("span", { class: "studio-file-tag" }, t("{count} suppliers", { count: vendors.length })),
						),
						h(
							"div",
							{ class: "studio-vendor-grid" },
							vendors.map((item) =>
								h(
									"article",
									{ class: `studio-vendor-card${item.changed ? " is-changed" : ""}` },
									h(
										"div",
										{ class: "studio-vendor-top" },
										h("strong", null, item.vendor),
										item.status ? h("span", { class: "studio-vendor-status" }, item.status) : null,
									),
									item.component ? h("p", { class: "studio-vendor-comp" }, item.component) : null,
									h(
										"div",
										{ class: "studio-vendor-meta" },
										item.unitPrice ? h("span", null, item.unitPrice) : null,
										item.moq ? h("span", null, t("MOQ {moq}", { moq: item.moq })) : null,
										item.leadTime ? h("span", null, item.leadTime) : null,
										item.region ? h("span", null, item.region) : null,
									),
									item.certifications ? h("div", { class: "studio-vendor-certs" }, item.certifications) : null,
								),
							),
						),
					),
				);
			}
			if (reportPaths.length > 0) {
				sections.push(
					h(
						"div",
						{ class: "studio-report-link" },
						h(
							"div",
							{ class: "studio-report-link-copy" },
							h("strong", null, t("Deep-dive vendor analysis")),
							h(
								"p",
								null,
								t("Read the full rationale, score comparison, and cost curves right here in {surface}.", {
									surface: surface.title,
								}),
							),
						),
						h(
							"button",
							{
								type: "button",
								class: "btn btn-small",
								"data-act": "studio-tab",
								"data-tab": "analysis",
							},
							t("Read analysis"),
						),
					),
				);
			}
		}

		if (showAnalysis && reportPaths.length > 0) {
			if (!this.#reportView) {
				this.#reportView = new SurfaceReportView({
					store,
					surface,
					signal: this.#lifetime.signal,
					baseFiles: this.#baseFiles,
					patches: this.#options.patches,
					embedded: true,
				});
			} else {
				this.#reportView.setBaseFiles(this.#baseFiles);
			}
			this.#reportView.update();
			sections.push(this.#reportView.el);
		}

		if (showSpecs) {
			for (const spec of detailSpecs) {
				sections.push(
					h(
						"section",
						{ class: `studio-section${spec.changed ? " is-changed" : ""}`, "data-file": spec.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, spec.title),
							h("code", { class: "studio-file-tag" }, spec.path),
							spec.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						),
						spec.entries.length ? renderSpecEntries(spec.entries) : null,
						...renderSpecTables(spec.tables),
					),
				);
			}
		}

		if (showFiles) {
			for (const doc of docs) {
				sections.push(
					h(
						"section",
						{ class: `studio-section studio-doc${doc.changed ? " is-changed" : ""}`, "data-file": doc.path },
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, doc.title),
							h("code", { class: "studio-file-tag" }, doc.path),
							doc.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						),
						doc.isMarkdown
							? h("div", { class: "studio-doc-body" }, markdown(doc.content))
							: h("div", { class: "studio-doc-body studio-plain-text" }, doc.content),
					),
				);
			}
		}

		if (showPages) {
			for (const page of htmlPages) {
				sections.push(
					h(
						"section",
						{
							class: `studio-section studio-html-card${page.changed ? " is-changed" : ""}`,
							"data-file": page.path,
						},
						h(
							"div",
							{ class: "studio-section-head" },
							h("h2", null, page.title),
							h("code", { class: "studio-file-tag" }, page.path),
							page.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						),
						this.#createHtmlFrame(page.html, page.path, page.title, files, previewTokensCss, "studio-html-frame"),
					),
				);
			}
		}

		if (sections.length === 0) {
			children.push(
				h(
					"div",
					{ class: "studio-empty" },
					surfaceTile(surface, store.lookOf(surface), "is-hero"),
					h("h2", null, surface.title),
					workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
					h("p", null, t("No studio files yet. Describe a change below to create tokens, specs, or guidelines.")),
				),
			);
			this.el.replaceChildren(...children);
			return;
		}

		children.push(h("div", { class: "studio-grid" }, sections));
		this.el.replaceChildren(...children);
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const { act } = target.dataset;
		if (act === "studio-tab") {
			const next = target.dataset.tab as StudioTab | undefined;
			if (next && next !== this.#tab) {
				this.#tab = next;
				this.update();
			}
			return;
		}
		if (act === "studio-open-surface" && target.dataset.slug) {
			this.#options.store.navigateSurface(target.dataset.slug);
			return;
		}
		if (act === "studio-reconcile") {
			const ids = this.#lastConflict?.changeIds ?? [];
			if (ids.length) void this.#options.store.reconcileChanges(this.#options.surface.id, ids);
			return;
		}
	}
}
