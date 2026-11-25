import {
	type StudioBinaryRef,
	SURFACE_LAYOUT_PATH,
	SURFACE_LAYOUT_SCHEMA,
	surfaceCompanyPath,
} from "@qorpera/contracts";
import { presentationTheme } from "../ui/appearance.ts";
import { companyDisplayName, showCompanyName } from "../ui/company-name.ts";
import type { CompanyIdentityFiles, SurfacesStore } from "./surfaces-store.ts";

export type CompanyWordmarkAsset =
	| { readonly kind: "svg"; readonly src: string }
	| { readonly kind: "binary"; readonly ref: StudioBinaryRef };

export interface CompanyWordmarks {
	readonly light?: CompanyWordmarkAsset;
	readonly dark?: CompanyWordmarkAsset;
}

interface LayoutBrandMark {
	readonly id: string;
	readonly heading: string;
	readonly from: string;
	readonly dark?: string;
	readonly grounds: readonly ("light" | "dark")[];
}

const SVG_FILE_RE = /\.svg$/i;
const WORDMARK_RE = /wordmark|\bordmærke\b/i;
const PICTURE_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;
const EMPTY_WORDMARKS: CompanyWordmarks = {};
const resolvedByIdentity = new WeakMap<CompanyIdentityFiles, CompanyWordmarks>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseGrounds(value: unknown): readonly ("light" | "dark")[] {
	if (!Array.isArray(value)) return ["light", "dark"];
	const grounds: ("light" | "dark")[] = [];
	for (const entry of value) {
		if ((entry === "light" || entry === "dark") && !grounds.includes(entry)) grounds.push(entry);
	}
	return grounds.length > 0 ? grounds : ["light", "dark"];
}

function collectBrandMarks(nodes: readonly unknown[], out: LayoutBrandMark[]): void {
	for (const node of nodes) {
		if (!isPlainRecord(node)) continue;
		if (node.type === "row" && Array.isArray(node.blocks)) {
			collectBrandMarks(node.blocks, out);
			continue;
		}
		if (node.type !== "brand_mark" || typeof node.from !== "string") continue;
		out.push({
			id: typeof node.id === "string" ? node.id : "",
			heading: typeof node.heading === "string" ? node.heading : "",
			from: node.from,
			...(typeof node.dark === "string" ? { dark: node.dark } : {}),
			grounds: parseGrounds(node.grounds),
		});
	}
}

function layoutWordmarkBlocks(identity: CompanyIdentityFiles, folderRoot: string): readonly LayoutBrandMark[] {
	const layoutText =
		identity.files[folderRoot ? `${folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH] ??
		(!folderRoot ? identity.files[`identity/${SURFACE_LAYOUT_PATH}`] : undefined);
	if (!layoutText) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(layoutText);
	} catch {
		return [];
	}
	if (!isPlainRecord(parsed) || parsed.schema !== SURFACE_LAYOUT_SCHEMA || !Array.isArray(parsed.tabs)) return [];
	const marks: LayoutBrandMark[] = [];
	for (const tab of parsed.tabs) {
		if (isPlainRecord(tab) && Array.isArray(tab.blocks)) collectBrandMarks(tab.blocks, marks);
	}
	return marks.filter(
		(block) =>
			WORDMARK_RE.test(block.id) ||
			WORDMARK_RE.test(block.heading) ||
			WORDMARK_RE.test(block.from) ||
			(block.dark !== undefined && WORDMARK_RE.test(block.dark)),
	);
}

function readAsset(path: string | undefined, identity: CompanyIdentityFiles): CompanyWordmarkAsset | undefined {
	if (!path) return undefined;
	if (SVG_FILE_RE.test(path)) {
		const trimmed = identity.files[path]?.trim();
		if (trimmed && /<svg[\s>]/i.test(trimmed)) {
			return { kind: "svg", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}` };
		}
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

function canonicalPaths(roots: readonly string[], stem: string): string[] {
	const paths: string[] = [];
	for (const root of roots) {
		for (const ext of PICTURE_EXTENSIONS) {
			paths.push(root ? `${root}/${stem}${ext}` : `${stem}${ext}`);
		}
	}
	return paths;
}

export function resolveCompanyWordmarks(identity: CompanyIdentityFiles | null): CompanyWordmarks {
	if (!identity) return EMPTY_WORDMARKS;
	const cached = resolvedByIdentity.get(identity);
	if (cached) return cached;
	const folderRoot = identity.folderRoot.replace(/^\/+|\/+$/g, "");
	const roots = !folderRoot ? ["identity", ""] : folderRoot === "identity" ? ["identity"] : [folderRoot, "identity"];
	const blocks = layoutWordmarkBlocks(identity, folderRoot);
	const lightPaths: string[] = [];
	const darkDedicatedPaths: string[] = [];
	const darkFallbackPaths: string[] = [];
	for (const block of blocks) {
		const hasLight = block.grounds.includes("light");
		const hasDark = block.grounds.includes("dark");
		const fromPath = resolveIdentityPath(folderRoot, block.from);
		const darkPath = block.dark ? resolveIdentityPath(folderRoot, block.dark) : undefined;
		if (hasLight && fromPath) lightPaths.push(fromPath);
		if (hasDark) {
			if (darkPath) darkDedicatedPaths.push(darkPath);
			if (!hasLight && fromPath) darkDedicatedPaths.push(fromPath);
			else if (fromPath) darkFallbackPaths.push(fromPath);
		}
	}
	if (darkDedicatedPaths.length === 0) darkDedicatedPaths.push(...canonicalPaths(roots, "wordmark-dark"));
	if (blocks.length === 0) {
		lightPaths.push(...canonicalPaths(roots, "wordmark"), ...canonicalPaths(roots, "wordmark-light"));
		darkFallbackPaths.push(...canonicalPaths(roots, "wordmark"));
	}
	const light = firstAsset(lightPaths, identity);
	const dark = firstAsset([...darkDedicatedPaths, ...darkFallbackPaths], identity);
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
	readonly #button: HTMLButtonElement;
	readonly #name: HTMLElement;
	readonly #image: HTMLImageElement;
	readonly #signal: AbortSignal;
	readonly #blobUrls = new Map<string, string>();
	readonly #pendingReads = new Set<string>();
	readonly #failedReads = new Set<string>();
	readonly #failedUrls = new Set<string>();
	#wordmarks: CompanyWordmarks = EMPTY_WORDMARKS;
	#store: SurfacesStore | undefined;
	#displayName = "";
	#shownSrc: string | undefined;

	constructor(button: HTMLButtonElement, name: HTMLElement, image: HTMLImageElement, signal: AbortSignal) {
		this.#button = button;
		this.#name = name;
		this.#image = image;
		this.#signal = signal;
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

	update(companyName: string, store: SurfacesStore | undefined): void {
		showCompanyName(this.#name, companyName);
		this.#displayName = companyDisplayName(companyName);
		this.#store = store;
		const next = resolveCompanyWordmarks(store?.companyIdentityFiles() ?? null);
		if (next !== this.#wordmarks) {
			this.#wordmarks = next;
			this.#failedUrls.clear();
			this.#pruneBinaries(next);
			if (next.light?.kind === "binary") this.#ensureBinary(next.light.ref);
			if (next.dark?.kind === "binary") this.#ensureBinary(next.dark.ref);
		}
		this.#paint();
	}

	#ensureBinary(ref: StudioBinaryRef): void {
		const store = this.#store;
		const sha = ref.fileSha256;
		if (!store || this.#blobUrls.has(sha) || this.#pendingReads.has(sha) || this.#failedReads.has(sha)) return;
		this.#pendingReads.add(sha);
		store
			.readStudioBinary(ref, this.#signal)
			.then(
				(bytes) => {
					if (this.#signal.aborted) return;
					if (!activeBinaryShas(this.#wordmarks).has(sha)) return;
					const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mediaType }));
					this.#blobUrls.set(sha, url);
					this.#paint();
				},
				() => {
					if (!this.#signal.aborted) this.#failedReads.add(sha);
				},
			)
			.finally(() => {
				this.#pendingReads.delete(sha);
			});
	}

	#pruneBinaries(wordmarks: CompanyWordmarks): void {
		const keep = activeBinaryShas(wordmarks);
		for (const [sha, url] of this.#blobUrls) {
			if (keep.has(sha)) continue;
			URL.revokeObjectURL(url);
			this.#blobUrls.delete(sha);
		}
		for (const sha of this.#failedReads) {
			if (!keep.has(sha)) this.#failedReads.delete(sha);
		}
	}

	#paint(): void {
		const asset = wordmarkForTheme(this.#wordmarks, activeTheme());
		const candidate =
			asset?.kind === "svg"
				? asset.src
				: asset?.kind === "binary"
					? this.#blobUrls.get(asset.ref.fileSha256)
					: undefined;
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
		for (const url of this.#blobUrls.values()) URL.revokeObjectURL(url);
		this.#blobUrls.clear();
		this.#pendingReads.clear();
		this.#failedReads.clear();
		this.#failedUrls.clear();
		this.#shownSrc = undefined;
	}
}
