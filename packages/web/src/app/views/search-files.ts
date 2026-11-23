import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type FileCategory, fileCategory, tileGlyph } from "./company-folder.ts";
import type { SearchHit, SearchMark } from "./search-window.ts";

export interface FoundFile {
	readonly path: string;
	readonly kind: string;
	readonly at?: string;
}

const WORKING_COPY = /^(code\/[^/]+\/[^/]+)\/worktrees\/[^/]+\/(.+)$/;
const FILE_MARKS: Partial<Record<FileCategory, SearchMark>> = {
	image: "image",
	document: "document",
	folder: "folder",
};

export function settledPath(path: string): string {
	const copy = WORKING_COPY.exec(path);
	return copy ? `${copy[1]}/${copy[2]}` : path;
}

export function filePlace(path: string, surfaceTitle: (slug: string) => string | undefined): string {
	const settled = settledPath(path);
	const folders = settled.split("/").slice(0, -1);
	let place: string;
	if (folders[0] === "code" && folders.length >= 3) {
		const home = (folders[1] === "surfaces" ? surfaceTitle(folders[2]!) : undefined) ?? folders[2]!;
		place = [home, ...folders.slice(3).slice(-1)].join(" / ");
	} else place = folders.length ? folders.slice(-2).join(" / ") : t("Company File");
	return settled === path ? place : t("{place} · draft", { place });
}

export function fileHit(
	file: FoundFile,
	open: (path: string) => void,
	surfaceTitle: (slug: string) => string | undefined = () => undefined,
): SearchHit {
	const { path, kind } = file;
	const category = fileCategory({ kind: kind === "folder" || kind === "symlink" ? kind : "file", path });
	const mark = FILE_MARKS[category];
	return {
		key: `file:${kind}:${path}`,
		kind: "files",
		title: path.slice(path.lastIndexOf("/") + 1),
		detail: filePlace(path, surfaceTitle),
		words: path,
		...(file.at ? { at: file.at } : {}),
		...(mark ? { marks: [mark] } : {}),
		lead: () => h("span", { class: `files-kind is-${category}` }, tileGlyph({ path }, category, false)),
		open: () => open(path),
	};
}

export function newestCopies(files: readonly FoundFile[]): FoundFile[] {
	const newest = new Map<string, FoundFile>();
	for (const file of files) {
		const settled = settledPath(file.path);
		const kept = newest.get(settled);
		if (!kept || (file.at ?? "") > (kept.at ?? "")) newest.set(settled, file);
	}
	const chosen = new Set(newest.values());
	return files.filter((file) => chosen.has(file));
}
