import { STUDIO_BINARY_MAX_BYTES, STUDIO_BINARY_MEDIA_TYPES, type StudioBinaryRef } from "@qorpera/contracts";

export interface SurfaceFolderReadableFile {
	readonly bytes: number;
}

export interface SurfaceFolderEntry<TFile extends SurfaceFolderReadableFile = SurfaceFolderReadableFile> {
	readonly path: string;
	readonly kind: string;
	readonly file: TFile | null;
}

export interface SurfaceFolderReader<TFile extends SurfaceFolderReadableFile = SurfaceFolderReadableFile> {
	list(
		parent: string | null,
		after: string | null,
		limit: number,
		signal: AbortSignal,
	): Promise<{ readonly entries: readonly SurfaceFolderEntry<TFile>[] }>;
	readFile(
		file: TFile,
		signal: AbortSignal,
		maxBytes?: number,
		options?: { readonly cached?: boolean },
	): Promise<Uint8Array>;
}

export interface SurfaceFolderContents {
	readonly files: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
}

const STUDIO_TEXT_FILE = /\.(?:json|md|markdown|txt|toml|ya?ml|css|m?js|svg|html?)$/i;
const STUDIO_BINARY_FILE = /\.(?:glb|webp|png|jpe?g)$/i;
const STUDIO_BINARY_TYPES = new Set<string>([...STUDIO_BINARY_MEDIA_TYPES, "application/octet-stream"]);
const STUDIO_MAX_BINARIES = 32;
const EMPTY_FOLDER: SurfaceFolderContents = { files: {}, binaries: {} };
const STUDIO_IGNORED_DIR = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"vendor",
	"coverage",
	"__pycache__",
	".venv",
	"out",
]);
const STUDIO_MAX_FILE_BYTES = 256 * 1024;
const STUDIO_MAX_TOTAL_BYTES = 1024 * 1024;
const STUDIO_MAX_FILES = 32;
const STUDIO_MAX_SUBFOLDERS = 12;
const STUDIO_FOLDER_DEPTH = 2;
const STUDIO_LIST_CONCURRENCY = 4;
const STUDIO_READ_CONCURRENCY = 6;

function isStudioBinaryRef(file: SurfaceFolderReadableFile): file is SurfaceFolderReadableFile & StudioBinaryRef {
	const record = file as Partial<StudioBinaryRef>;
	return (
		typeof record.manifestSha256 === "string" &&
		typeof record.fileSha256 === "string" &&
		typeof record.mediaType === "string" &&
		STUDIO_BINARY_TYPES.has(record.mediaType)
	);
}

function studioFilePriority(path: string): number {
	const lower = path.toLowerCase();
	if (lower.endsWith(".json")) return 0;
	if (lower.endsWith(".css") || lower.endsWith(".svg")) return 1;
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return 2;
	if (/\.(?:html?|m?js)$/.test(lower)) return 3;
	return 4;
}

export async function readSurfaceFolderFiles<TFile extends SurfaceFolderReadableFile>(
	folder: SurfaceFolderReader<TFile>,
	roots: readonly string[],
	signal: AbortSignal,
	unread?: (path: string) => void,
): Promise<SurfaceFolderContents> {
	const uniqueRoots = [...new Set(roots.map((root) => root.replace(/^\/+|\/+$/g, "")).filter(Boolean))];
	if (!uniqueRoots.length || signal.aborted) return EMPTY_FOLDER;
	const listFolder = async (parent: string): Promise<readonly SurfaceFolderEntry<TFile>[]> => {
		try {
			return (await folder.list(parent, null, 100, signal)).entries;
		} catch {
			unread?.(parent);
			return [];
		}
	};
	const rootPages = await Promise.all(uniqueRoots.map((root) => listFolder(root)));
	if (signal.aborted) return EMPTY_FOLDER;
	const subfolders: string[] = [];
	const candidates: { readonly path: string; readonly file: TFile }[] = [];
	const binaries: Record<string, StudioBinaryRef> = {};
	let binaryCount = 0;
	const seenPaths = new Set<string>();
	const collectEntries = (entries: readonly SurfaceFolderEntry<TFile>[], folders: string[] | null) => {
		for (const entry of entries) {
			if (folders && entry.kind === "folder") {
				const base = entry.path.split("/").at(-1)?.toLowerCase() ?? "";
				if (!STUDIO_IGNORED_DIR.has(base)) folders.push(entry.path);
				continue;
			}
			if (
				entry.kind === "file" &&
				entry.file &&
				!seenPaths.has(entry.path) &&
				binaryCount < STUDIO_MAX_BINARIES &&
				STUDIO_BINARY_FILE.test(entry.path) &&
				entry.file.bytes > 0 &&
				entry.file.bytes <= STUDIO_BINARY_MAX_BYTES &&
				isStudioBinaryRef(entry.file)
			) {
				seenPaths.add(entry.path);
				binaries[entry.path] = entry.file;
				binaryCount++;
				continue;
			}
			if (
				entry.kind !== "file" ||
				!entry.file ||
				seenPaths.has(entry.path) ||
				!STUDIO_TEXT_FILE.test(entry.path) ||
				entry.file.bytes > STUDIO_MAX_FILE_BYTES
			) {
				continue;
			}
			seenPaths.add(entry.path);
			candidates.push({ path: entry.path, file: entry.file });
		}
	};
	for (const entries of rootPages) collectEntries(entries, subfolders);
	let level = [...new Set(subfolders)].slice(0, STUDIO_MAX_SUBFOLDERS);
	let listed = 0;
	for (let depth = 1; depth <= STUDIO_FOLDER_DEPTH; depth++) {
		if (level.length === 0) break;
		const folders = level;
		listed += folders.length;
		let subNext = 0;
		const subPages: (readonly SurfaceFolderEntry<TFile>[])[] = [];
		const listWorker = async (): Promise<void> => {
			while (!signal.aborted) {
				const index = subNext++;
				if (index >= folders.length) return;
				subPages[index] = await listFolder(folders[index]!);
			}
		};
		await Promise.all(Array.from({ length: Math.min(STUDIO_LIST_CONCURRENCY, folders.length) }, () => listWorker()));
		if (signal.aborted) return EMPTY_FOLDER;
		const deeper: string[] = [];
		for (const entries of subPages) if (entries) collectEntries(entries, depth < STUDIO_FOLDER_DEPTH ? deeper : null);
		level = [...new Set(deeper)].slice(0, STUDIO_MAX_SUBFOLDERS - listed);
	}
	candidates.sort((a, b) => studioFilePriority(a.path) - studioFilePriority(b.path) || a.file.bytes - b.file.bytes);
	const selected: { readonly path: string; readonly file: TFile }[] = [];
	let totalBytes = 0;
	for (const item of candidates) {
		if (selected.length >= STUDIO_MAX_FILES) break;
		if (selected.length > 0 && totalBytes + item.file.bytes > STUDIO_MAX_TOTAL_BYTES) continue;
		selected.push(item);
		totalBytes += item.file.bytes;
	}
	if (selected.length === 0) return { files: {}, binaries };
	const decoder = new TextDecoder();
	const files: Record<string, string> = {};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (!signal.aborted) {
			const index = next++;
			if (index >= selected.length) return;
			const item = selected[index]!;
			try {
				const bytes = await folder.readFile(item.file, signal, STUDIO_MAX_FILE_BYTES, { cached: true });
				if (!signal.aborted) files[item.path] = decoder.decode(bytes);
			} catch {
				if (signal.aborted) return;
				unread?.(item.path);
			}
		}
	};
	const workers = Math.min(STUDIO_READ_CONCURRENCY, selected.length);
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return { files, binaries };
}

export function surfaceFolderRoots(surface: { readonly folderRoot: string | null; readonly slug: string }): string[] {
	return [surface.folderRoot?.replace(/^\/+|\/+$/g, ""), `QorperaOS/surfaces/${surface.slug}/notes`].filter(
		(item): item is string => Boolean(item),
	);
}
