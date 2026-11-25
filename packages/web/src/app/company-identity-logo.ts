import {
	CloudMemberFolderError,
	type CloudMemberFolderFile,
	type CloudMemberFolderRead,
} from "@qorpera/cloud-client/cloud-member-folder";
import {
	readSurfaceLayout,
	type StudioBinaryRef,
	SURFACE_LAYOUT_PATH,
	type SurfaceBrandMarkBlock,
	type SurfaceReadNode,
	surfaceCompanyPath,
} from "@qorpera/contracts";
import { COMPANY_IDENTITY_LOGO_PATH, COMPANY_LOGO_PATH } from "../cloud/company-logos.ts";
import { presentationTheme } from "../ui/appearance.ts";
import type { CompanyIdentityFiles } from "./surfaces-store.ts";

export type CompanyIdentityLogoAsset =
	| { readonly kind: "svg"; readonly path: string; readonly src: string }
	| { readonly kind: "binary"; readonly path: string; readonly ref: StudioBinaryRef };

export interface ResolvedCompanyIdentityLogos {
	readonly light?: CompanyIdentityLogoAsset;
	readonly dark?: CompanyIdentityLogoAsset;
	readonly baseLight?: CompanyIdentityLogoAsset;
	readonly baseDark?: CompanyIdentityLogoAsset;
	readonly baseHasLogo: boolean;
	readonly baseSignature: string;
	readonly folderRoot: string;
	readonly writePath: string;
	readonly darkClearPaths: readonly string[];
	readonly removePaths: readonly string[];
}

export interface CachedCompanyIdentityLogos {
	readonly light?: string;
	readonly dark?: string;
	readonly cachedAt?: number;
}

export interface LogoFolderReader {
	read?(path: string, signal: AbortSignal): Promise<CloudMemberFolderRead>;
	readMany?(paths: readonly string[], signal: AbortSignal): Promise<CloudMemberFolderRead[]>;
	readFile(
		file: CloudMemberFolderFile,
		signal: AbortSignal,
		maximumBytes?: number,
		options?: { readonly cached?: boolean },
	): Promise<Uint8Array>;
}

const SVG_FILE_RE = /\.svg$/i;
const WORDMARK_RE = /wordmark|\bordmærke\b/i;
const LOGO_RE = /\blogo\b|brand[_ -]?mark|\bmark\b|\bicon\b|\bsymbol\b|\bemblem\b|\bmonogram\b|\bmærke\b/i;
const PICTURE_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;
const MAX_LOGO_TEXT_BYTES = 512 * 1024;
// WHY: Larger SVGs stay cached in memory for this session; localStorage persists URLs up to this cap and binaries derive from it so cached rasters survive reload.
const MAX_STORED_URL_CHARS = 64 * 1024;
const MAX_CACHED_BINARY_BYTES = Math.floor(((MAX_STORED_URL_CHARS - 32) * 3) / 4);
const MAX_STORED_TOTAL_CHARS = 512 * 1024;
const MAX_MEMORY_COMPANIES = 32;
const MAX_STORED_COMPANIES = 16;
const MAX_PREFETCH_BATCH = 8;
const PREFETCH_CONCURRENCY = 3;
const MAX_CUSTOM_PATHS = 16;
const STORAGE_KEY_PREFIX = "qorpera.web.company-identity-logos.v1";
const SAFE_DATA_URL_RE = /^data:image\/(?:svg\+xml;charset=utf-8,|png;base64,|webp;base64,|jpeg;base64,)/;
const resolvedByIdentity = new WeakMap<CompanyIdentityFiles, ResolvedCompanyIdentityLogos>();

type CacheEntry =
	| { readonly kind: "logos"; readonly logos: CachedCompanyIdentityLogos; readonly cachedAt: number }
	| { readonly kind: "none" };

export interface LogoCandidatePaths {
	readonly lightPaths: readonly string[];
	readonly darkPaths: readonly string[];
	readonly writePath: string;
	readonly darkClearPaths: readonly string[];
	readonly removePaths: readonly string[];
}

function uniquePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const trimmed = path.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function resolveIdentityPath(folderRoot: string, bindingPath: string): string | undefined {
	const cleaned = bindingPath.trim();
	if (!cleaned) return undefined;
	try {
		if (folderRoot) return surfaceCompanyPath(folderRoot, cleaned);
		const body = cleaned.replace(/^\/+/, "");
		return body || undefined;
	} catch {
		return undefined;
	}
}

function collectBrandMarks(nodes: readonly SurfaceReadNode[], out: SurfaceBrandMarkBlock[]): void {
	for (const node of nodes) {
		if (node.type === "row") {
			collectBrandMarks(node.blocks, out);
			continue;
		}
		if (node.type === "brand_mark") out.push(node);
	}
}

function matchesPattern(block: SurfaceBrandMarkBlock, pattern: RegExp): boolean {
	return (
		(block.id !== undefined && pattern.test(block.id)) ||
		(block.heading !== undefined && pattern.test(block.heading)) ||
		pattern.test(block.from)
	);
}

function layoutLogoBlocks(layoutText: string | undefined): readonly SurfaceBrandMarkBlock[] {
	if (!layoutText) return [];
	const read = readSurfaceLayout(layoutText);
	if (!("layout" in read)) return [];
	const marks: SurfaceBrandMarkBlock[] = [];
	for (const tab of read.layout.tabs) collectBrandMarks(tab.blocks, marks);
	const nonWordmarks = marks.filter((block) => !matchesPattern(block, WORDMARK_RE));
	const explicitLogos = nonWordmarks.filter((block) => matchesPattern(block, LOGO_RE));
	return explicitLogos.length > 0 ? explicitLogos : nonWordmarks;
}

function canonicalPaths(roots: readonly string[], stem: string): string[] {
	const paths: string[] = [];
	for (const root of roots) {
		for (const ext of PICTURE_EXTENSIONS) {
			paths.push(root ? `${root}/${stem}${ext}` : `${stem}${ext}`);
		}
	}
	return paths;
}

const FAST_PROBE_PATHS = [
	`identity/${SURFACE_LAYOUT_PATH}`,
	...canonicalPaths(["identity"], "logo"),
	...canonicalPaths(["identity"], "logo-dark"),
	...canonicalPaths(["identity"], "logo-light"),
];

export function logoCandidatePaths(layoutText: string | undefined, folderRoot: string): LogoCandidatePaths {
	const cleanRoot = folderRoot.replace(/^\/+|\/+$/g, "");
	const roots = !cleanRoot ? ["identity", ""] : cleanRoot === "identity" ? ["identity"] : [cleanRoot, "identity"];
	const blocks = layoutLogoBlocks(layoutText);
	const lightPaths: string[] = [];
	const darkDedicatedPaths: string[] = [];
	const darkFallbackPaths: string[] = [];
	for (const block of blocks) {
		const hasLight = block.grounds.includes("light");
		const hasDark = block.grounds.includes("dark");
		const fromPath = resolveIdentityPath(cleanRoot, block.from);
		if (hasLight && fromPath) lightPaths.push(fromPath);
		if (hasDark && fromPath) {
			if (!hasLight) darkDedicatedPaths.push(fromPath);
			else darkFallbackPaths.push(fromPath);
		}
	}
	if (darkDedicatedPaths.length === 0) darkDedicatedPaths.push(...canonicalPaths(roots, "logo-dark"));
	if (blocks.length === 0) {
		lightPaths.push(...canonicalPaths(roots, "logo"), ...canonicalPaths(roots, "logo-light"));
		darkFallbackPaths.push(...canonicalPaths(roots, "logo"));
	}
	const uniqueLight = uniquePaths(lightPaths);
	const uniqueDarkDedicated = uniquePaths(darkDedicatedPaths);
	const uniqueDark = uniquePaths([...uniqueDarkDedicated, ...darkFallbackPaths]);
	const defaultWritePath = cleanRoot ? `${cleanRoot}/logo.svg` : COMPANY_IDENTITY_LOGO_PATH;
	const blockSvgTarget = blocks.length > 0 ? uniqueLight.find((path) => SVG_FILE_RE.test(path)) : undefined;
	const writePath = blockSvgTarget ?? defaultWritePath;
	const darkClearPaths = uniqueDarkDedicated.filter((path) => path.toLowerCase() !== writePath.toLowerCase());
	const removePaths = uniquePaths([
		writePath,
		...uniqueLight,
		...uniqueDark,
		...canonicalPaths(roots, "logo"),
		...canonicalPaths(roots, "logo-dark"),
		...canonicalPaths(roots, "logo-light"),
		COMPANY_IDENTITY_LOGO_PATH,
		COMPANY_LOGO_PATH,
	]);
	return { lightPaths: uniqueLight, darkPaths: uniqueDark, writePath, darkClearPaths, removePaths };
}

export function logoSourceCandidates(extraRoot?: string): readonly string[] {
	const cleaned = extraRoot?.replace(/^\/+|\/+$/g, "") ?? "";
	const roots = cleaned && cleaned.toLowerCase() !== "identity" ? [cleaned, "identity"] : ["identity"];
	const paths: string[] = [];
	for (const root of roots) {
		paths.push(...canonicalPaths([root], "logo"), ...canonicalPaths([root], "logo-light"));
	}
	paths.push(COMPANY_LOGO_PATH);
	return uniquePaths(paths);
}

export function logoSvgToDataUrl(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed || !/<svg[\s>]/i.test(trimmed)) return undefined;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
}

export function logoRasterMediaType(path: string, mediaType: string): string | undefined {
	const normalized = mediaType.trim().toLowerCase();
	if (normalized === "image/png" || normalized === "image/webp" || normalized === "image/jpeg") return normalized;
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	return undefined;
}

export function logoBytesToDataUrl(bytes: Uint8Array, mediaType: string): string | undefined {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_CACHED_BINARY_BYTES) return undefined;
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return `data:${mediaType};base64,${btoa(binary)}`;
}

function isValidCachedUrl(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_STORED_URL_CHARS && SAFE_DATA_URL_RE.test(value);
}

function readAssetFromMap(
	path: string | undefined,
	files: Readonly<Record<string, string>>,
	binaries: Readonly<Record<string, StudioBinaryRef>>,
): CompanyIdentityLogoAsset | undefined {
	if (!path) return undefined;
	if (SVG_FILE_RE.test(path)) {
		const src = files[path] ? logoSvgToDataUrl(files[path]) : undefined;
		if (src) return { kind: "svg", path, src };
	}
	const binary = binaries[path];
	return binary ? { kind: "binary", path, ref: binary } : undefined;
}

function firstAssetFromMap(
	paths: readonly string[],
	files: Readonly<Record<string, string>>,
	binaries: Readonly<Record<string, StudioBinaryRef>>,
): CompanyIdentityLogoAsset | undefined {
	for (const path of paths) {
		const asset = readAssetFromMap(path, files, binaries);
		if (asset) return asset;
	}
	return undefined;
}

function assetSignature(asset: CompanyIdentityLogoAsset | undefined): string {
	if (!asset) return "";
	return asset.kind === "svg" ? `svg:${asset.path}:${asset.src}` : `bin:${asset.path}:${asset.ref.fileSha256}`;
}

const EMPTY_RESOLVED: ResolvedCompanyIdentityLogos = {
	baseHasLogo: false,
	baseSignature: "|",
	folderRoot: "identity",
	writePath: COMPANY_IDENTITY_LOGO_PATH,
	darkClearPaths: canonicalPaths(["identity"], "logo-dark"),
	removePaths: uniquePaths([
		...canonicalPaths(["identity"], "logo"),
		...canonicalPaths(["identity"], "logo-dark"),
		...canonicalPaths(["identity"], "logo-light"),
		COMPANY_LOGO_PATH,
	]),
};

export function resolveCompanyIdentityLogos(identity: CompanyIdentityFiles | null): ResolvedCompanyIdentityLogos {
	if (!identity) return EMPTY_RESOLVED;
	const cached = resolvedByIdentity.get(identity);
	if (cached) return cached;
	const folderRoot = identity.folderRoot.replace(/^\/+|\/+$/g, "");
	const layoutKey = folderRoot ? `${folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH;
	const layoutText =
		identity.files[layoutKey] ?? (!folderRoot ? identity.files[`identity/${SURFACE_LAYOUT_PATH}`] : undefined);
	const baseLayoutText =
		identity.baseFiles[layoutKey] ??
		(!folderRoot ? identity.baseFiles[`identity/${SURFACE_LAYOUT_PATH}`] : undefined);
	const activePaths = logoCandidatePaths(layoutText, folderRoot);
	const basePaths = baseLayoutText === layoutText ? activePaths : logoCandidatePaths(baseLayoutText, folderRoot);
	const light = firstAssetFromMap(activePaths.lightPaths, identity.files, identity.binaries);
	const dark = firstAssetFromMap(activePaths.darkPaths, identity.files, identity.binaries);
	const baseLight = firstAssetFromMap(basePaths.lightPaths, identity.baseFiles, identity.baseBinaries);
	const baseDark = firstAssetFromMap(basePaths.darkPaths, identity.baseFiles, identity.baseBinaries);
	const result: ResolvedCompanyIdentityLogos = {
		...(light ? { light } : {}),
		...(dark ? { dark } : {}),
		...(baseLight ? { baseLight } : {}),
		...(baseDark ? { baseDark } : {}),
		baseHasLogo: Boolean(baseLight || baseDark),
		baseSignature: `${assetSignature(baseLight)}|${assetSignature(baseDark)}`,
		folderRoot: folderRoot || "identity",
		writePath: basePaths.writePath,
		darkClearPaths: basePaths.darkClearPaths,
		removePaths: basePaths.removePaths,
	};
	resolvedByIdentity.set(identity, result);
	return result;
}

export function activeLogoTheme(): "light" | "dark" {
	const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
	if (theme === "dark") return "dark";
	if (theme === "light") return "light";
	return typeof window !== "undefined" && typeof window.matchMedia === "function" ? presentationTheme() : "light";
}

export function logoForTheme<T>(
	logos: { readonly light?: T; readonly dark?: T },
	theme: "light" | "dark",
): T | undefined {
	return theme === "dark" ? logos.dark : logos.light;
}

export async function readFolderEntries(
	folder: LogoFolderReader,
	paths: readonly string[],
	signal: AbortSignal,
): Promise<CloudMemberFolderRead[] | undefined> {
	if (paths.length === 0) return [];
	if (typeof folder.readMany === "function") {
		try {
			return await folder.readMany(paths, signal);
		} catch (error) {
			if (error instanceof CloudMemberFolderError && error.status === 404 && typeof folder.read === "function") {
				return await Promise.all(paths.map((path) => folder.read!(path, signal)));
			}
			throw error;
		}
	}
	if (typeof folder.read === "function") {
		return await Promise.all(paths.map((path) => folder.read!(path, signal)));
	}
	return undefined;
}

export async function readFolderIdentityLogos(
	folder: LogoFolderReader,
	signal: AbortSignal,
): Promise<CachedCompanyIdentityLogos | null | undefined> {
	const initial = await readFolderEntries(folder, FAST_PROBE_PATHS, signal);
	if (!initial || signal.aborted) return undefined;
	const probed = new Set<string>(FAST_PROBE_PATHS);
	const filesByPath = new Map<string, CloudMemberFolderFile>();
	for (let index = 0; index < FAST_PROBE_PATHS.length; index++) {
		const entry = initial[index]?.entry;
		if (entry?.kind === "file" && entry.file) filesByPath.set(FAST_PROBE_PATHS[index]!, entry.file);
	}
	const layoutPath = `identity/${SURFACE_LAYOUT_PATH}`;
	const layoutFile = filesByPath.get(layoutPath);
	let layoutText: string | undefined;
	if (layoutFile && layoutFile.bytes > 0 && layoutFile.bytes <= MAX_LOGO_TEXT_BYTES) {
		try {
			const bytes = await folder.readFile(layoutFile, signal, MAX_LOGO_TEXT_BYTES, { cached: true });
			if (signal.aborted) return undefined;
			layoutText = new TextDecoder().decode(bytes);
		} catch {
			if (signal.aborted) return undefined;
		}
	}
	const { lightPaths, darkPaths } = logoCandidatePaths(layoutText, "identity");
	const missingPaths: string[] = [];
	for (const path of [...lightPaths, ...darkPaths]) {
		if (probed.has(path)) continue;
		probed.add(path);
		missingPaths.push(path);
		if (missingPaths.length >= MAX_CUSTOM_PATHS) break;
	}
	if (missingPaths.length > 0) {
		const extra = await readFolderEntries(folder, missingPaths, signal);
		if (!extra || signal.aborted) return undefined;
		for (let index = 0; index < missingPaths.length; index++) {
			const entry = extra[index]?.entry;
			if (entry?.kind === "file" && entry.file) filesByPath.set(missingPaths[index]!, entry.file);
		}
	}
	const decodedBySha = new Map<string, string | null>();
	const loadDataUrl = async (path: string): Promise<string | undefined> => {
		const file = filesByPath.get(path);
		if (!file || file.bytes <= 0) return undefined;
		const cached = decodedBySha.get(file.fileSha256);
		if (cached !== undefined) return cached ?? undefined;
		if (SVG_FILE_RE.test(path)) {
			if (file.bytes > MAX_LOGO_TEXT_BYTES) {
				decodedBySha.set(file.fileSha256, null);
				return undefined;
			}
			try {
				const bytes = await folder.readFile(file, signal, MAX_LOGO_TEXT_BYTES, { cached: true });
				if (signal.aborted) return undefined;
				const src = logoSvgToDataUrl(new TextDecoder().decode(bytes));
				decodedBySha.set(file.fileSha256, src ?? null);
				return src;
			} catch {
				return undefined;
			}
		}
		const mime = logoRasterMediaType(path, file.mediaType);
		if (!mime || file.bytes > MAX_CACHED_BINARY_BYTES) {
			decodedBySha.set(file.fileSha256, null);
			return undefined;
		}
		try {
			const bytes = await folder.readFile(file, signal, MAX_CACHED_BINARY_BYTES, { cached: true });
			if (signal.aborted) return undefined;
			const src = logoBytesToDataUrl(bytes, mime);
			decodedBySha.set(file.fileSha256, src ?? null);
			return src;
		} catch {
			return undefined;
		}
	};
	const pickFirst = async (paths: readonly string[]): Promise<string | undefined> => {
		for (const path of paths) {
			const src = await loadDataUrl(path);
			if (signal.aborted) return undefined;
			if (src) return src;
		}
		return undefined;
	};
	const light = await pickFirst(lightPaths);
	const dark = await pickFirst(darkPaths);
	if (signal.aborted) return undefined;
	return light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : null;
}

export class CompanyIdentityLogoCache {
	readonly #scope: string;
	readonly #now: () => number;
	readonly #entries = new Map<string, CacheEntry>();
	readonly #liveRevisions = new Map<string, number>();
	readonly #inFlight = new Map<string, Promise<void>>();
	readonly #listeners = new Map<string, Set<() => void>>();
	#userId: string | undefined;
	#generation = 0;
	#prefetchAbort = new AbortController();

	constructor(scope = "", now: () => number = Date.now) {
		this.#scope = scope;
		this.#now = now;
	}

	#storageKey(userId: string): string {
		return this.#scope ? `${STORAGE_KEY_PREFIX}:${this.#scope}:${userId}` : `${STORAGE_KEY_PREFIX}:${userId}`;
	}

	setAccount(userId: string | undefined, clearPreviousStorage = false): void {
		if (userId === this.#userId) return;
		const previous = this.#userId;
		if (previous && clearPreviousStorage) {
			try {
				localStorage.removeItem(this.#storageKey(previous));
			} catch {
				// WHY: Storage can be unavailable in restricted contexts; in-memory state still clears below.
			}
		}
		this.#generation++;
		this.#prefetchAbort.abort();
		this.#prefetchAbort = new AbortController();
		this.#entries.clear();
		this.#liveRevisions.clear();
		this.#inFlight.clear();
		this.#userId = userId;
		if (userId) this.#hydrate(userId);
		for (const profileId of [...this.#listeners.keys()]) this.#notify(profileId);
	}

	clearEntries(): void {
		this.#generation++;
		this.#prefetchAbort.abort();
		this.#prefetchAbort = new AbortController();
		this.#entries.clear();
		this.#liveRevisions.clear();
		this.#inFlight.clear();
	}

	get(profileId: string): CachedCompanyIdentityLogos | undefined {
		const id = profileId.toLowerCase();
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		this.#entries.delete(id);
		this.#entries.set(id, entry);
		return entry.kind === "logos" ? { ...entry.logos, cachedAt: entry.cachedAt } : undefined;
	}

	has(profileId: string): boolean {
		return this.#entries.has(profileId.toLowerCase());
	}

	subscribe(profileId: string, listener: () => void): () => void {
		const id = profileId.toLowerCase();
		let listeners = this.#listeners.get(id);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(id, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.#listeners.delete(id);
		};
	}

	set(profileId: string, logos: CachedCompanyIdentityLogos, source: "live" | "prefetch", startLiveRev?: number): void {
		const id = profileId.toLowerCase();
		if (source === "prefetch") {
			if (startLiveRev !== undefined && (this.#liveRevisions.get(id) ?? 0) !== startLiveRev) return;
		} else {
			this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		}
		const cleaned: CachedCompanyIdentityLogos = {
			...(logos.light ? { light: logos.light } : {}),
			...(logos.dark ? { dark: logos.dark } : {}),
		};
		if (!cleaned.light && !cleaned.dark) {
			this.setNone(id, source, startLiveRev);
			return;
		}
		const prev = this.#entries.get(id);
		const unchanged =
			prev?.kind === "logos" && prev.logos.light === cleaned.light && prev.logos.dark === cleaned.dark;
		this.#put(id, { kind: "logos", logos: cleaned, cachedAt: this.#now() });
		if (unchanged) return;
		this.#persist();
		this.#notify(id);
	}

	setNone(profileId: string, source: "live" | "prefetch", startLiveRev?: number): void {
		const id = profileId.toLowerCase();
		if (source === "prefetch") {
			if (startLiveRev !== undefined && (this.#liveRevisions.get(id) ?? 0) !== startLiveRev) return;
			// WHY: A fast identity/ probe may miss custom folder roots; never evict a warmer entry.
			if (this.#entries.has(id)) return;
			this.#put(id, { kind: "none" });
			return;
		}
		this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		const prev = this.#entries.get(id);
		const hadLogos = prev?.kind === "logos";
		this.#put(id, { kind: "none" });
		if (hadLogos) {
			this.#persist();
			this.#notify(id);
		}
	}

	forget(profileId: string): void {
		const id = profileId.toLowerCase();
		this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		const prev = this.#entries.get(id);
		this.#entries.delete(id);
		if (prev?.kind === "logos") {
			this.#persist();
			this.#notify(id);
		}
	}

	prefetch(
		profileId: string,
		createFolder: (signal: AbortSignal) => LogoFolderReader,
		signal?: AbortSignal,
	): Promise<void> {
		const id = profileId.toLowerCase();
		if (this.#entries.has(id)) return Promise.resolve();
		const running = this.#inFlight.get(id);
		if (running) return running;
		const generation = this.#generation;
		const startLiveRev = this.#liveRevisions.get(id) ?? 0;
		const requestSignal = signal ? AbortSignal.any([this.#prefetchAbort.signal, signal]) : this.#prefetchAbort.signal;
		if (requestSignal.aborted) return Promise.resolve();
		const run = async (): Promise<void> => {
			try {
				const folder = createFolder(requestSignal);
				const found = await readFolderIdentityLogos(folder, requestSignal);
				if (generation !== this.#generation || requestSignal.aborted || found === undefined) return;
				if (found === null) this.setNone(id, "prefetch", startLiveRev);
				else this.set(id, found, "prefetch", startLiveRev);
			} catch {
				// WHY: Prefetch is best-effort; full SurfacesStore loading remains authoritative.
			}
		};
		const work = run().finally(() => {
			if (this.#inFlight.get(id) === work) this.#inFlight.delete(id);
		});
		this.#inFlight.set(id, work);
		return work;
	}

	async prefetchMany(
		targets: readonly {
			readonly profileId: string;
			readonly createFolder: (signal: AbortSignal) => LogoFolderReader;
		}[],
		signal?: AbortSignal,
	): Promise<void> {
		const queued: {
			readonly profileId: string;
			readonly createFolder: (signal: AbortSignal) => LogoFolderReader;
		}[] = [];
		const seen = new Set<string>();
		for (const target of targets) {
			const id = target.profileId.toLowerCase();
			if (seen.has(id) || this.#entries.has(id) || this.#inFlight.has(id)) continue;
			seen.add(id);
			queued.push(target);
			if (queued.length >= MAX_PREFETCH_BATCH) break;
		}
		if (queued.length === 0) return;
		let next = 0;
		const worker = async (): Promise<void> => {
			while (!this.#prefetchAbort.signal.aborted && !signal?.aborted) {
				const index = next++;
				if (index >= queued.length) return;
				const target = queued[index]!;
				await this.prefetch(target.profileId, target.createFolder, signal);
			}
		};
		await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queued.length) }, () => worker()));
	}

	dispose(): void {
		this.clearEntries();
		this.#listeners.clear();
		this.#userId = undefined;
	}

	#put(id: string, entry: CacheEntry): void {
		this.#entries.delete(id);
		this.#entries.set(id, entry);
		while (this.#entries.size > MAX_MEMORY_COMPANIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	#notify(id: string): void {
		const listeners = this.#listeners.get(id);
		if (!listeners) return;
		for (const listener of [...listeners]) listener();
	}

	#hydrate(userId: string): void {
		let raw: string | null = null;
		try {
			raw = localStorage.getItem(this.#storageKey(userId));
		} catch {
			return;
		}
		if (!raw) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		let count = 0;
		for (const [key, value] of Object.entries(parsed)) {
			if (count >= MAX_STORED_COMPANIES) break;
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const record = value as Record<string, unknown>;
			const light = isValidCachedUrl(record.light) ? record.light : undefined;
			const dark = isValidCachedUrl(record.dark) ? record.dark : undefined;
			if (!light && !dark) continue;
			const cachedAt = typeof record.cachedAt === "number" && Number.isFinite(record.cachedAt) ? record.cachedAt : 0;
			this.#entries.set(key.toLowerCase(), {
				kind: "logos",
				logos: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) },
				cachedAt,
			});
			count++;
		}
	}

	#persist(): void {
		const userId = this.#userId;
		if (!userId) return;
		const key = this.#storageKey(userId);
		const candidates: [string, CachedCompanyIdentityLogos][] = [];
		for (const [id, entry] of this.#entries) {
			if (entry.kind !== "logos") continue;
			const light = isValidCachedUrl(entry.logos.light) ? entry.logos.light : undefined;
			const dark = isValidCachedUrl(entry.logos.dark) ? entry.logos.dark : undefined;
			if (!light && !dark) continue;
			candidates.push([id, { ...(light ? { light } : {}), ...(dark ? { dark } : {}), cachedAt: entry.cachedAt }]);
		}
		const recent = candidates.slice(-MAX_STORED_COMPANIES);
		if (recent.length === 0) {
			try {
				localStorage.removeItem(key);
			} catch {
				// WHY: Ignore blocked storage; memory cache still reflects the cleared state.
			}
			return;
		}
		const kept: [string, CachedCompanyIdentityLogos][] = [];
		let totalChars = 2;
		for (let index = recent.length - 1; index >= 0; index--) {
			const [id, logos] = recent[index]!;
			const cost = id.length + (logos.light?.length ?? 0) + (logos.dark?.length ?? 0) + 48;
			if (totalChars + cost > MAX_STORED_TOTAL_CHARS) continue;
			kept.push([id, logos]);
			totalChars += cost;
		}
		const payload: Record<string, CachedCompanyIdentityLogos> = {};
		for (let index = kept.length - 1; index >= 0; index--) {
			const [id, logos] = kept[index]!;
			payload[id] = logos;
		}
		try {
			if (Object.keys(payload).length === 0) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(payload));
		} catch {
			// WHY: Ignore quota or privacy-mode storage errors; in-memory cache still works for this session.
		}
	}
}
