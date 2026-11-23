import {
	parseSurfaceBinding,
	resolveSurfaceSource,
	type StudioBinaryRef,
	type SurfaceSource,
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
}

export interface SurfaceFolderFile {
	readonly path: string;
	readonly relative: string;
}

export interface SurfaceBlockContext {
	readonly surface: SurfaceSummary;
	readonly folderRoot: string;
	readonly files: Readonly<Record<string, string>>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly briefSummary: string;
	readonly signal: AbortSignal;
	readonly words: (text: string) => string;
	readonly read: (source: SurfaceSource | undefined) => SurfaceBlockRead;
	readonly companyPath: (bindingPath: string) => string | undefined;
	readonly matching: (globs: readonly string[] | undefined) => readonly SurfaceFolderFile[];
}

export interface SurfaceBlockContextInput {
	readonly surface: SurfaceSummary;
	readonly files: Readonly<Record<string, string>>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly briefSummary: string;
	readonly signal: AbortSignal;
	readonly fromStarter: boolean;
}

const STARTER_WORDS: ReadonlySet<string> = new Set([
	phrase("Overview"),
	phrase("Specs"),
	phrase("Vendors"),
	phrase("Reports"),
	phrase("Files"),
	phrase("Parts"),
	phrase("Production plan"),
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

export function sectionHead(title: string, changed: boolean, tag?: HTMLElement | null): HTMLElement {
	return h("div", { class: "studio-section-head" }, h("h2", null, title), tag ?? null, changedPill(changed));
}

export function homeEmpty(line: string): HTMLElement {
	return h("p", { class: "studio-home-empty" }, line);
}

export function sourceFile(source: SurfaceSource | undefined): string | undefined {
	if (typeof source !== "string") return undefined;
	try {
		return parseSurfaceBinding(source).path;
	} catch {
		return undefined;
	}
}

export function sourceKey(source: SurfaceSource | undefined): string | undefined {
	if (typeof source !== "string") return undefined;
	try {
		const binding = parseSurfaceBinding(source);
		const last = binding.pointer.split("/").at(-1);
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

export function createBlockContext(input: SurfaceBlockContextInput): SurfaceBlockContext {
	const folderRoot = cleanFolderRoot(input.surface.folderRoot);
	const companyPath = (bindingPath: string): string | undefined => {
		try {
			if (folderRoot) return surfaceCompanyPath(folderRoot, bindingPath);
			const body = bindingPath.replace(/^\/+/, "");
			return body || undefined;
		} catch {
			return undefined;
		}
	};
	const reader = (files: Readonly<Record<string, string>>) => {
		const parsed = new Map<string, unknown>();
		return (bindingPath: string): unknown => {
			const path = companyPath(bindingPath);
			if (!path) return undefined;
			if (!parsed.has(path)) {
				const text = files[path];
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
	const readPreview = reader(input.files);
	const readBase = reader(input.baseFiles);
	const folderFiles = Object.keys(input.files)
		.sort()
		.flatMap((path): SurfaceFolderFile[] => {
			const relative = folderRelative(folderRoot, path);
			return relative === undefined ? [] : [{ path, relative }];
		});
	return {
		surface: input.surface,
		folderRoot,
		files: input.files,
		baseFiles: input.baseFiles,
		binaries: input.binaries,
		briefSummary: input.briefSummary,
		signal: input.signal,
		words: input.fromStarter ? (text) => (STARTER_WORDS.has(text) ? t(text) : text) : (text) => text,
		read: (source) => {
			if (source === undefined) return { found: false, value: undefined, base: undefined, changed: false };
			const preview = resolveSurfaceSource(source, readPreview);
			const base = resolveSurfaceSource(source, readBase);
			return {
				found: preview.found,
				value: preview.value,
				base: base.value,
				changed: preview.found !== base.found || !sameValue(preview.value, base.value),
			};
		},
		companyPath,
		matching: (globs) =>
			folderFiles.filter(
				(file) => globs === undefined || globs.some((glob) => surfaceGlobMatches(glob, file.relative)),
			),
	};
}
