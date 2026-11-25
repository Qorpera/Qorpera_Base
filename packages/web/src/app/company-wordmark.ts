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
import { presentationTheme } from "../ui/appearance.ts";
import { companyDisplayName, showCompanyName } from "../ui/company-name.ts";
import {
	type CompanyIdentityFiles,
	type IdentityWordmarkStatus,
	identityWordmarkStatus,
	type SurfacesStore,
} from "./surfaces-store.ts";

export type CompanyWordmarkAsset =
	| { readonly kind: "svg"; readonly src: string }
	| { readonly kind: "binary"; readonly ref: StudioBinaryRef };

export interface CompanyWordmarks {
	readonly light?: CompanyWordmarkAsset;
	readonly dark?: CompanyWordmarkAsset;
}

export interface CachedCompanyWordmarks {
	readonly light?: string;
	readonly dark?: string;
}

export interface WordmarkFolderReader {
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
const PICTURE_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;
const BINARY_RETRY_MS = 60_000;
const MAX_WORDMARK_TEXT_BYTES = 256 * 1024;
// WHY: Larger SVGs stay cached in memory for this session; localStorage persists URLs up to this cap and binaries derive from it so every cached raster survives reload.
const MAX_STORED_URL_CHARS = 64 * 1024;
const MAX_CACHED_BINARY_BYTES = Math.floor(((MAX_STORED_URL_CHARS - 32) * 3) / 4);
const MAX_STORED_TOTAL_CHARS = 512 * 1024;
const MAX_MEMORY_COMPANIES = 32;
const MAX_STORED_COMPANIES = 16;
const MAX_PREFETCH_BATCH = 8;
const PREFETCH_CONCURRENCY = 3;
const MAX_CUSTOM_PATHS = 16;
const STORAGE_KEY_PREFIX = "qorpera.web.company-wordmarks.v1";
const SAFE_DATA_URL_RE = /^data:image\/(?:svg\+xml;charset=utf-8,|png;base64,|webp;base64,|jpeg;base64,)/;
const EMPTY_WORDMARKS: CompanyWordmarks = {};
const resolvedByIdentity = new WeakMap<CompanyIdentityFiles, CompanyWordmarks>();

type CacheEntry = { readonly kind: "marks"; readonly marks: CachedCompanyWordmarks } | { readonly kind: "none" };

interface WordmarkCandidatePaths {
	readonly lightPaths: readonly string[];
	readonly darkPaths: readonly string[];
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

function layoutWordmarkBlocks(layoutText: string | undefined): readonly SurfaceBrandMarkBlock[] {
	if (!layoutText) return [];
	const read = readSurfaceLayout(layoutText);
	if (!("layout" in read)) return [];
	const marks: SurfaceBrandMarkBlock[] = [];
	for (const tab of read.layout.tabs) collectBrandMarks(tab.blocks, marks);
	return marks.filter(
		(block) =>
			(block.id !== undefined && WORDMARK_RE.test(block.id)) ||
			(block.heading !== undefined && WORDMARK_RE.test(block.heading)) ||
			WORDMARK_RE.test(block.from),
	);
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
	...canonicalPaths(["identity"], "wordmark"),
	...canonicalPaths(["identity"], "wordmark-dark"),
	...canonicalPaths(["identity"], "wordmark-light"),
];

function wordmarkCandidatePaths(layoutText: string | undefined, folderRoot: string): WordmarkCandidatePaths {
	const roots = !folderRoot ? ["identity", ""] : folderRoot === "identity" ? ["identity"] : [folderRoot, "identity"];
	const blocks = layoutWordmarkBlocks(layoutText);
	const lightPaths: string[] = [];
	const darkDedicatedPaths: string[] = [];
	const darkFallbackPaths: string[] = [];
	for (const block of blocks) {
		const hasLight = block.grounds.includes("light");
		const hasDark = block.grounds.includes("dark");
		const fromPath = resolveIdentityPath(folderRoot, block.from);
		if (hasLight && fromPath) lightPaths.push(fromPath);
		if (hasDark && fromPath) {
			if (!hasLight) darkDedicatedPaths.push(fromPath);
			else darkFallbackPaths.push(fromPath);
		}
	}
	if (darkDedicatedPaths.length === 0) darkDedicatedPaths.push(...canonicalPaths(roots, "wordmark-dark"));
	if (blocks.length === 0) {
		lightPaths.push(...canonicalPaths(roots, "wordmark"), ...canonicalPaths(roots, "wordmark-light"));
		darkFallbackPaths.push(...canonicalPaths(roots, "wordmark"));
	}
	return { lightPaths, darkPaths: [...darkDedicatedPaths, ...darkFallbackPaths] };
}

function svgToDataUrl(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed || !/<svg[\s>]/i.test(trimmed)) return undefined;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
}

function rasterMediaType(path: string, mediaType: string): string | undefined {
	const normalized = mediaType.trim().toLowerCase();
	if (normalized === "image/png" || normalized === "image/webp" || normalized === "image/jpeg") return normalized;
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	return undefined;
}

function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string | undefined {
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

function readAsset(path: string | undefined, identity: CompanyIdentityFiles): CompanyWordmarkAsset | undefined {
	if (!path) return undefined;
	if (SVG_FILE_RE.test(path)) {
		const src = identity.files[path] ? svgToDataUrl(identity.files[path]) : undefined;
		if (src) return { kind: "svg", src };
	}
	const binary = identity.binaries[path];
	return binary ? { kind: "binary", ref: binary } : undefined;
}

function firstAsset(paths: readonly string[], identity: CompanyIdentityFiles): CompanyWordmarkAsset | undefined {
	for (const path of paths) {
		const asset = readAsset(path, identity);
		if (asset) return asset;
	}
	return undefined;
}

export function resolveCompanyWordmarks(identity: CompanyIdentityFiles | null): CompanyWordmarks {
	if (!identity) return EMPTY_WORDMARKS;
	const cached = resolvedByIdentity.get(identity);
	if (cached) return cached;
	const folderRoot = identity.folderRoot.replace(/^\/+|\/+$/g, "");
	const layoutText =
		identity.files[folderRoot ? `${folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH] ??
		(!folderRoot ? identity.files[`identity/${SURFACE_LAYOUT_PATH}`] : undefined);
	const { lightPaths, darkPaths } = wordmarkCandidatePaths(layoutText, folderRoot);
	const light = firstAsset(lightPaths, identity);
	const dark = firstAsset(darkPaths, identity);
	const result: CompanyWordmarks =
		light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : EMPTY_WORDMARKS;
	resolvedByIdentity.set(identity, result);
	return result;
}

export function wordmarkForTheme(
	wordmarks: CompanyWordmarks,
	theme: "light" | "dark",
): CompanyWordmarkAsset | undefined {
	return theme === "dark" ? wordmarks.dark : wordmarks.light;
}

async function readFolderEntries(
	folder: WordmarkFolderReader,
	paths: readonly string[],
	signal: AbortSignal,
): Promise<CloudMemberFolderRead[] | undefined> {
	if (paths.length === 0 || typeof folder.readMany !== "function") return undefined;
	try {
		return await folder.readMany(paths, signal);
	} catch (error) {
		if (error instanceof CloudMemberFolderError && error.status === 404 && typeof folder.read === "function") {
			return await Promise.all(paths.map((path) => folder.read!(path, signal)));
		}
		throw error;
	}
}

async function readFolderWordmarks(
	folder: WordmarkFolderReader,
	signal: AbortSignal,
): Promise<CachedCompanyWordmarks | null | undefined> {
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
	if (layoutFile && layoutFile.bytes > 0 && layoutFile.bytes <= MAX_WORDMARK_TEXT_BYTES) {
		try {
			const bytes = await folder.readFile(layoutFile, signal, MAX_WORDMARK_TEXT_BYTES, { cached: true });
			if (signal.aborted) return undefined;
			layoutText = new TextDecoder().decode(bytes);
		} catch {
			if (signal.aborted) return undefined;
		}
	}
	const { lightPaths, darkPaths } = wordmarkCandidatePaths(layoutText, "identity");
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
			if (file.bytes > MAX_WORDMARK_TEXT_BYTES) {
				decodedBySha.set(file.fileSha256, null);
				return undefined;
			}
			try {
				const bytes = await folder.readFile(file, signal, MAX_WORDMARK_TEXT_BYTES, { cached: true });
				if (signal.aborted) return undefined;
				const src = svgToDataUrl(new TextDecoder().decode(bytes));
				decodedBySha.set(file.fileSha256, src ?? null);
				return src;
			} catch {
				return undefined;
			}
		}
		const mime = rasterMediaType(path, file.mediaType);
		if (!mime || file.bytes > MAX_CACHED_BINARY_BYTES) {
			decodedBySha.set(file.fileSha256, null);
			return undefined;
		}
		try {
			const bytes = await folder.readFile(file, signal, MAX_CACHED_BINARY_BYTES, { cached: true });
			if (signal.aborted) return undefined;
			const src = bytesToDataUrl(bytes, mime);
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

export class CompanyWordmarkCache {
	readonly #scope: string;
	readonly #entries = new Map<string, CacheEntry>();
	readonly #liveRevisions = new Map<string, number>();
	readonly #inFlight = new Map<string, Promise<void>>();
	readonly #listeners = new Map<string, Set<() => void>>();
	#userId: string | undefined;
	#generation = 0;
	#prefetchAbort = new AbortController();

	constructor(scope = "") {
		this.#scope = scope;
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

	get(profileId: string): CachedCompanyWordmarks | undefined {
		const id = profileId.toLowerCase();
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		this.#entries.delete(id);
		this.#entries.set(id, entry);
		return entry.kind === "marks" ? entry.marks : undefined;
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

	set(profileId: string, marks: CachedCompanyWordmarks, source: "live" | "prefetch", startLiveRev?: number): void {
		const id = profileId.toLowerCase();
		if (source === "prefetch") {
			if (startLiveRev !== undefined && (this.#liveRevisions.get(id) ?? 0) !== startLiveRev) return;
		} else {
			this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		}
		const cleaned: CachedCompanyWordmarks = {
			...(marks.light ? { light: marks.light } : {}),
			...(marks.dark ? { dark: marks.dark } : {}),
		};
		if (!cleaned.light && !cleaned.dark) {
			this.setNone(id, source, startLiveRev);
			return;
		}
		const prev = this.#entries.get(id);
		const unchanged =
			prev?.kind === "marks" && prev.marks.light === cleaned.light && prev.marks.dark === cleaned.dark;
		this.#put(id, { kind: "marks", marks: cleaned });
		if (unchanged) return;
		this.#persist();
		this.#notify(id);
	}

	setNone(profileId: string, source: "live" | "prefetch", startLiveRev?: number): void {
		const id = profileId.toLowerCase();
		if (source === "prefetch") {
			if (startLiveRev !== undefined && (this.#liveRevisions.get(id) ?? 0) !== startLiveRev) return;
			// WHY: A fast identity/ probe may miss custom folder roots or staged preview marks; never evict a warmer entry.
			if (this.#entries.has(id)) return;
			this.#put(id, { kind: "none" });
			return;
		}
		this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		const prev = this.#entries.get(id);
		const hadMarks = prev?.kind === "marks";
		this.#put(id, { kind: "none" });
		if (hadMarks) {
			this.#persist();
			this.#notify(id);
		}
	}

	forget(profileId: string): void {
		const id = profileId.toLowerCase();
		this.#liveRevisions.set(id, (this.#liveRevisions.get(id) ?? 0) + 1);
		const prev = this.#entries.get(id);
		this.#entries.delete(id);
		if (prev?.kind === "marks") {
			this.#persist();
			this.#notify(id);
		}
	}

	prefetch(
		profileId: string,
		createFolder: (signal: AbortSignal) => WordmarkFolderReader,
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
				const found = await readFolderWordmarks(folder, requestSignal);
				if (generation !== this.#generation || requestSignal.aborted || found === undefined) return;
				if (found === null) this.setNone(id, "prefetch", startLiveRev);
				else this.set(id, found, "prefetch", startLiveRev);
			} catch {
				// WHY: Prefetch is best-effort; full SurfacesStore loading remains the authoritative path.
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
			readonly createFolder: (signal: AbortSignal) => WordmarkFolderReader;
		}[],
		signal?: AbortSignal,
	): Promise<void> {
		const queued: {
			readonly profileId: string;
			readonly createFolder: (signal: AbortSignal) => WordmarkFolderReader;
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
		this.#generation++;
		this.#prefetchAbort.abort();
		this.#entries.clear();
		this.#liveRevisions.clear();
		this.#inFlight.clear();
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
			this.#entries.set(key.toLowerCase(), {
				kind: "marks",
				marks: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) },
			});
			count++;
		}
	}

	#persist(): void {
		const userId = this.#userId;
		if (!userId) return;
		const key = this.#storageKey(userId);
		const candidates: [string, CachedCompanyWordmarks][] = [];
		for (const [id, entry] of this.#entries) {
			if (entry.kind !== "marks") continue;
			const light = isValidCachedUrl(entry.marks.light) ? entry.marks.light : undefined;
			const dark = isValidCachedUrl(entry.marks.dark) ? entry.marks.dark : undefined;
			if (!light && !dark) continue;
			candidates.push([id, { ...(light ? { light } : {}), ...(dark ? { dark } : {}) }]);
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
		const kept: [string, CachedCompanyWordmarks][] = [];
		let totalChars = 2;
		for (let index = recent.length - 1; index >= 0; index--) {
			const [id, marks] = recent[index]!;
			const cost = id.length + (marks.light?.length ?? 0) + (marks.dark?.length ?? 0) + 32;
			if (totalChars + cost > MAX_STORED_TOTAL_CHARS) continue;
			kept.push([id, marks]);
			totalChars += cost;
		}
		const payload: Record<string, CachedCompanyWordmarks> = {};
		for (let index = kept.length - 1; index >= 0; index--) {
			const [id, marks] = kept[index]!;
			payload[id] = marks;
		}
		try {
			if (Object.keys(payload).length === 0) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(payload));
		} catch {
			// WHY: Ignore quota or privacy-mode storage errors; in-memory cache still works for this session.
		}
	}
}

let activeCache: CompanyWordmarkCache | undefined;

export function setCompanyWordmarks(next: CompanyWordmarkCache | undefined): void {
	activeCache = next;
}

export function companyWordmarks(): CompanyWordmarkCache | undefined {
	return activeCache;
}

function activeTheme(): "light" | "dark" {
	const theme = document.documentElement.dataset.theme;
	if (theme === "dark") return "dark";
	if (theme === "light") return "light";
	return typeof window !== "undefined" && typeof window.matchMedia === "function" ? presentationTheme() : "light";
}

function activeBinaryShas(wordmarks: CompanyWordmarks): Set<string> {
	const shas = new Set<string>();
	if (wordmarks.light?.kind === "binary") shas.add(wordmarks.light.ref.fileSha256);
	if (wordmarks.dark?.kind === "binary") shas.add(wordmarks.dark.ref.fileSha256);
	return shas;
}

export class CompanyWordmarkSlot {
	readonly #profileId: string;
	readonly #button: HTMLButtonElement;
	readonly #name: HTMLElement;
	readonly #image: HTMLImageElement;
	readonly #signal: AbortSignal;
	readonly #cache: CompanyWordmarkCache | undefined;
	readonly #blobUrls = new Map<string, string>();
	readonly #binaryDataUrls = new Map<string, string>();
	readonly #pendingReads = new Set<string>();
	readonly #failedReads = new Map<string, number>();
	readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #failedUrls = new Set<string>();
	#unsubscribeCache: (() => void) | undefined;
	#wordmarks: CompanyWordmarks = EMPTY_WORDMARKS;
	#identityStatus: IdentityWordmarkStatus = "loading";
	#store: SurfacesStore | undefined;
	#displayName = "";
	#shownSrc: string | undefined;
	#syncingCache = false;

	constructor(
		profileId: string,
		button: HTMLButtonElement,
		name: HTMLElement,
		image: HTMLImageElement,
		signal: AbortSignal,
		cache: CompanyWordmarkCache | undefined = activeCache,
	) {
		this.#profileId = profileId;
		this.#button = button;
		this.#name = name;
		this.#image = image;
		this.#signal = signal;
		this.#cache = cache;
		this.#unsubscribeCache = cache?.subscribe(profileId, () => {
			if (!this.#syncingCache && !this.#signal.aborted) this.#paint();
		});
		image.addEventListener(
			"error",
			() => {
				if (!this.#shownSrc) return;
				this.#failedUrls.add(this.#shownSrc);
				this.#paint();
			},
			{ signal },
		);
		window.addEventListener("qorpera-theme-change", () => this.#paint(), { signal });
		signal.addEventListener("abort", () => this.#dispose(), { once: true });
	}

	update(companyName: string, store: SurfacesStore | undefined, surfacesDisabled = false): void {
		showCompanyName(this.#name, companyName);
		this.#displayName = companyDisplayName(companyName);
		this.#store = store;
		this.#identityStatus = identityWordmarkStatus(store, surfacesDisabled);
		const next = resolveCompanyWordmarks(store?.companyIdentityFiles() ?? null);
		if (next !== this.#wordmarks) {
			this.#wordmarks = next;
			this.#failedUrls.clear();
			this.#failedReads.clear();
			this.#clearRetries();
			this.#pruneBinaries(next);
		}
		if (next.light?.kind === "binary") this.#ensureBinary(next.light.ref);
		if (next.dark?.kind === "binary") this.#ensureBinary(next.dark.ref);
		this.#syncCache();
		this.#paint();
	}

	#syncCache(): void {
		if (!this.#cache || this.#identityStatus !== "settled") return;
		const { light, dark } = this.#wordmarks;
		if (
			(light?.kind === "binary" &&
				(this.#pendingReads.has(light.ref.fileSha256) || this.#failedReads.has(light.ref.fileSha256))) ||
			(dark?.kind === "binary" &&
				(this.#pendingReads.has(dark.ref.fileSha256) || this.#failedReads.has(dark.ref.fileSha256)))
		) {
			return;
		}
		const lightUrl =
			light?.kind === "svg"
				? light.src
				: light?.kind === "binary"
					? this.#binaryDataUrls.get(light.ref.fileSha256)
					: undefined;
		const darkUrl =
			dark?.kind === "svg"
				? dark.src
				: dark?.kind === "binary"
					? this.#binaryDataUrls.get(dark.ref.fileSha256)
					: undefined;
		this.#syncingCache = true;
		try {
			if (lightUrl || darkUrl) {
				this.#cache.set(
					this.#profileId,
					{ ...(lightUrl ? { light: lightUrl } : {}), ...(darkUrl ? { dark: darkUrl } : {}) },
					"live",
				);
			} else if (!light && !dark) {
				this.#cache.setNone(this.#profileId, "live");
			}
		} finally {
			this.#syncingCache = false;
		}
	}

	#ensureBinary(ref: StudioBinaryRef): void {
		const store = this.#store;
		const sha = ref.fileSha256;
		const retryAt = this.#failedReads.get(sha);
		if (
			!store ||
			this.#blobUrls.has(sha) ||
			this.#pendingReads.has(sha) ||
			(retryAt !== undefined && Date.now() < retryAt)
		) {
			return;
		}
		this.#failedReads.delete(sha);
		this.#pendingReads.add(sha);
		store
			.readStudioBinary(ref, this.#signal)
			.then(
				(bytes) => {
					if (this.#signal.aborted) return;
					if (!activeBinaryShas(this.#wordmarks).has(sha)) return;
					const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mediaType }));
					this.#blobUrls.set(sha, url);
					const mime = rasterMediaType("", ref.mediaType);
					const dataUrl = mime ? bytesToDataUrl(bytes, mime) : undefined;
					if (dataUrl) this.#binaryDataUrls.set(sha, dataUrl);
					this.#pendingReads.delete(sha);
					this.#syncCache();
					this.#paint();
				},
				() => {
					if (this.#signal.aborted) return;
					this.#pendingReads.delete(sha);
					this.#failedReads.set(sha, Date.now() + BINARY_RETRY_MS);
					if (activeBinaryShas(this.#wordmarks).has(sha)) this.#scheduleRetry(ref);
					this.#paint();
				},
			)
			.finally(() => {
				this.#pendingReads.delete(sha);
			});
	}

	#scheduleRetry(ref: StudioBinaryRef): void {
		const sha = ref.fileSha256;
		const existing = this.#retryTimers.get(sha);
		if (existing !== undefined) clearTimeout(existing);
		this.#retryTimers.set(
			sha,
			setTimeout(() => {
				this.#retryTimers.delete(sha);
				if (this.#signal.aborted || !activeBinaryShas(this.#wordmarks).has(sha)) return;
				this.#ensureBinary(ref);
			}, BINARY_RETRY_MS),
		);
	}

	#clearRetries(): void {
		for (const timer of this.#retryTimers.values()) clearTimeout(timer);
		this.#retryTimers.clear();
	}

	#pruneBinaries(wordmarks: CompanyWordmarks): void {
		const keep = activeBinaryShas(wordmarks);
		for (const [sha, url] of this.#blobUrls) {
			if (keep.has(sha)) continue;
			URL.revokeObjectURL(url);
			this.#blobUrls.delete(sha);
		}
		for (const sha of this.#binaryDataUrls.keys()) {
			if (!keep.has(sha)) this.#binaryDataUrls.delete(sha);
		}
	}

	#paint(): void {
		const theme = activeTheme();
		const cached = this.#cache?.get(this.#profileId);
		const cachedSrc = cached ? (theme === "dark" ? cached.dark : cached.light) : undefined;
		const asset = wordmarkForTheme(this.#wordmarks, theme);
		if (asset?.kind === "binary" && !this.#blobUrls.has(asset.ref.fileSha256)) {
			this.#ensureBinary(asset.ref);
		}
		const liveCandidate =
			asset?.kind === "svg"
				? asset.src
				: asset?.kind === "binary"
					? this.#blobUrls.get(asset.ref.fileSha256)
					: undefined;
		const binaryPending =
			asset?.kind === "binary" &&
			!this.#blobUrls.has(asset.ref.fileSha256) &&
			!this.#failedReads.has(asset.ref.fileSha256);
		const candidate =
			this.#identityStatus === "loading"
				? cachedSrc
				: this.#identityStatus === "preview-loading"
					? cached
						? cachedSrc
						: liveCandidate
					: (liveCandidate ?? (binaryPending ? cachedSrc : undefined));
		const src = candidate && !this.#failedUrls.has(candidate) ? candidate : undefined;
		if (src) {
			if (this.#image.alt !== this.#displayName) this.#image.alt = this.#displayName;
			if (this.#shownSrc !== src) {
				this.#shownSrc = src;
				this.#image.src = src;
			}
			this.#image.hidden = false;
			this.#name.hidden = true;
			this.#button.classList.add("has-wordmark");
			return;
		}
		if (this.#shownSrc !== undefined) {
			this.#shownSrc = undefined;
			this.#image.removeAttribute("src");
		}
		this.#image.hidden = true;
		this.#name.hidden = false;
		this.#button.classList.remove("has-wordmark");
	}

	#dispose(): void {
		this.#unsubscribeCache?.();
		this.#unsubscribeCache = undefined;
		this.#clearRetries();
		for (const url of this.#blobUrls.values()) URL.revokeObjectURL(url);
		this.#blobUrls.clear();
		this.#binaryDataUrls.clear();
		this.#pendingReads.clear();
		this.#failedReads.clear();
		this.#failedUrls.clear();
		this.#shownSrc = undefined;
	}
}
