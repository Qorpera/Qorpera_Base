import {
	parseSurfaceBinding,
	resolveSurfaceSource,
	type StudioBinaryRef,
	type SurfaceSource,
	type SurfaceSourceChoice,
	type SurfaceSummary,
	surfaceCompanyPath,
	surfaceGlobMatches,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { phrase, t } from "../../../ui/preferences.ts";

export interface StudioSectionTask {
	readonly heavy?: boolean;
	readonly build: () => HTMLElement;
}

export type SurfaceHeroRole = "stage" | "title" | "swatch" | "facts";

export interface SurfaceBlockPrepared {
	readonly filled: boolean;
	readonly hero?: SurfaceHeroRole;
	readonly pieces: readonly StudioSectionTask[];
}

export interface SurfaceBlockRead {
	readonly found: boolean;
	readonly value: unknown;
	readonly base: unknown;
	readonly changed: boolean;
	readonly binding?: string;
}

export interface SurfaceFolderFile {
	readonly path: string;
	readonly relative?: string;
}

export interface SurfaceFileLayer {
	readonly files: Readonly<Record<string, string>>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
}

export interface SurfaceBlockContext extends SurfaceFileLayer {
	readonly surface: SurfaceSummary;
	readonly folderRoot: string;
	readonly briefSummary: string;
	readonly signal: AbortSignal;
	readonly words: (text: string) => string;
	readonly read: (source: SurfaceSource | undefined) => SurfaceBlockRead;
	readonly companyPath: (bindingPath: string) => string | undefined;
	readonly text: (path: string) => { readonly value: string | undefined; readonly base: string | undefined };
	readonly binary: (path: string) => {
		readonly value: StudioBinaryRef | undefined;
		readonly base: StudioBinaryRef | undefined;
	};
	readonly matching: (
		globs: readonly string[] | undefined,
		skip?: readonly string[] | undefined,
	) => readonly SurfaceFolderFile[];
}

export interface SurfaceBlockContextInput extends SurfaceFileLayer {
	readonly surface: SurfaceSummary;
	readonly company?: SurfaceFileLayer | undefined;
	readonly briefSummary: string;
	readonly signal: AbortSignal;
	readonly fromStarter: boolean;
}

const STARTER_WORDS: ReadonlySet<string> = new Set([
	phrase("Overview"),
	phrase("Specs"),
	phrase("Vendors"),
	phrase("Reports"),
	phrase("Breakdowns"),
	phrase("Artifacts"),
	phrase("Parts"),
	phrase("Production plan"),
	phrase("Other details"),
	phrase("Logo"),
	phrase("Wordmark"),
	phrase("Mission & Ambition"),
	phrase("Mission"),
	phrase("Ambition"),
	phrase("Palette"),
	phrase("Type"),
	phrase("Strategy"),
	phrase("Philosophy"),
	phrase("Voice"),
	phrase("Design system"),
	phrase("Tokens"),
]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function readableName(raw: string): string {
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

export function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "–";
	if (Array.isArray(value)) return value.map(formatScalar).join(", ");
	return JSON.stringify(value);
}

export function isShownScalar(value: unknown): value is string | number | boolean {
	if (typeof value === "string") return value.trim() !== "";
	return typeof value === "number" || typeof value === "boolean";
}

export function lookupPath(root: Record<string, unknown> | undefined, segments: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function changedPill(changed: boolean): HTMLElement | null {
	return changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null;
}

export function sectionHead(title: string, changed: boolean, action?: HTMLElement | null): HTMLElement {
	return h("div", { class: "studio-section-head" }, h("h2", null, title), changedPill(changed), action ?? null);
}

export function homeEmpty(line: string): HTMLElement {
	return h("p", { class: "studio-home-empty" }, line);
}

function isChoiceList(source: SurfaceSource): source is readonly SurfaceSourceChoice[] {
	return Array.isArray(source);
}

function sourceChoices(source: SurfaceSource): readonly SurfaceSourceChoice[] {
	return isChoiceList(source) ? source : [source];
}

export function sourceFile(binding: string | undefined): string | undefined {
	if (binding === undefined) return undefined;
	try {
		return parseSurfaceBinding(binding).path;
	} catch {
		return undefined;
	}
}

export function sourceKey(binding: string | undefined): string | undefined {
	if (binding === undefined) return undefined;
	try {
		const parsed = parseSurfaceBinding(binding);
		const last = parsed.pointer.split("/").at(-1);
		return last ? last.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
	} catch {
		return undefined;
	}
}

export function cleanFolderRoot(folderRoot: string | null | undefined): string {
	return folderRoot?.replace(/^\/+|\/+$/g, "") ?? "";
}

export function folderRelative(folderRoot: string, path: string): string | undefined {
	if (!folderRoot) return path;
	return path.startsWith(`${folderRoot}/`) ? path.slice(folderRoot.length + 1) : undefined;
}

export function surfaceGlobFinds(glob: string, file: SurfaceFolderFile): boolean {
	if (glob.startsWith("/")) return surfaceGlobMatches(glob, `/${file.path}`);
	return file.relative !== undefined && surfaceGlobMatches(glob, file.relative);
}

function holds(layer: SurfaceFileLayer, path: string): boolean {
	return (
		Object.hasOwn(layer.files, path) ||
		Object.hasOwn(layer.baseFiles, path) ||
		Object.hasOwn(layer.binaries, path) ||
		Object.hasOwn(layer.baseBinaries, path)
	);
}

export function createBlockContext(input: SurfaceBlockContextInput): SurfaceBlockContext {
	const folderRoot = cleanFolderRoot(input.surface.folderRoot);
	const company = input.company;
	const layerOf = (path: string): SurfaceFileLayer =>
		company && !holds(input, path) && holds(company, path) ? company : input;
	const companyPath = (bindingPath: string): string | undefined => {
		try {
			if (folderRoot) return surfaceCompanyPath(folderRoot, bindingPath);
			const body = bindingPath.replace(/^\/+/, "");
			return body || undefined;
		} catch {
			return undefined;
		}
	};
	const reader = (pick: (layer: SurfaceFileLayer) => Readonly<Record<string, string>>) => {
		const parsed = new Map<string, unknown>();
		return (bindingPath: string): unknown => {
			const path = companyPath(bindingPath);
			if (!path) return undefined;
			if (!parsed.has(path)) {
				const text = pick(layerOf(path))[path];
				let value: unknown;
				if (text !== undefined) {
					try {
						value = JSON.parse(text);
					} catch {
						value = undefined;
					}
				}
				parsed.set(path, value);
			}
			return parsed.get(path);
		};
	};
	const readPreview = reader((layer) => layer.files);
	const readBase = reader((layer) => layer.baseFiles);
	const seenPaths = new Set<string>([
		...Object.keys(input.files),
		...Object.keys(input.binaries),
		...(company ? Object.keys(company.files) : []),
		...(company ? Object.keys(company.binaries) : []),
	]);
	const allFiles = [...seenPaths].sort().map((path): SurfaceFolderFile => {
		const relative = folderRelative(folderRoot, path);
		return relative === undefined ? { path } : { path, relative };
	});
	const folderFiles = allFiles.filter((file) => file.relative !== undefined);
	const finds = (globs: readonly string[], file: SurfaceFolderFile) =>
		globs.some((glob) => surfaceGlobFinds(glob, file));
	return {
		surface: input.surface,
		folderRoot,
		files: input.files,
		baseFiles: input.baseFiles,
		binaries: input.binaries,
		baseBinaries: input.baseBinaries,
		briefSummary: input.briefSummary,
		signal: input.signal,
		words: input.fromStarter ? (text) => (STARTER_WORDS.has(text) ? t(text) : text) : (text) => text,
		read: (source) => {
			if (source === undefined) return { found: false, value: undefined, base: undefined, changed: false };
			const choices = sourceChoices(source);
			const found = choices.find((choice) => resolveSurfaceSource(choice, readPreview).found);
			const binding = typeof found === "string" ? found : choices.find((choice) => typeof choice === "string");
			const preview = resolveSurfaceSource(source, readPreview);
			const base = resolveSurfaceSource(source, readBase);
			return {
				found: preview.found,
				value: preview.value,
				base: base.value,
				changed: preview.found !== base.found || !sameValue(preview.value, base.value),
				...(typeof binding === "string" ? { binding } : {}),
			};
		},
		companyPath,
		text: (path) => {
			const layer = layerOf(path);
			return { value: layer.files[path], base: layer.baseFiles[path] };
		},
		binary: (path) => {
			const layer = layerOf(path);
			return { value: layer.binaries[path], base: layer.baseBinaries[path] };
		},
		matching: (globs, skip) =>
			(globs === undefined ? folderFiles : allFiles.filter((file) => finds(globs, file))).filter(
				(file) => !skip || !finds(skip, file),
			),
	};
}
