import { readSurfaceLibrary, type SurfaceLibraryOpen, surfaceLibraryThemeKey } from "@qorpera/contracts";
import { parseReportJson, type ReportDocument } from "./report-document.ts";

export interface LibraryPost {
	readonly path: string;
	readonly doc: ReportDocument;
	readonly number: string;
	readonly themeKey?: string;
	readonly themeName?: string;
	readonly sourceCount: number;
	readonly basis?: string;
	readonly checked?: string;
	readonly claims: readonly string[];
	readonly cover?: { readonly path: string; readonly alt: string };
	readonly related: readonly string[];
}

export interface LibraryTheme {
	readonly key: string;
	readonly name: string;
	readonly question?: string;
	readonly lead?: string;
	readonly icon?: string;
	readonly open: readonly SurfaceLibraryOpen[];
	readonly posts: readonly LibraryPost[];
}

export interface LibraryModel {
	readonly line?: string;
	readonly themes: readonly LibraryTheme[];
	readonly posts: readonly LibraryPost[];
	readonly featured: readonly LibraryPost[];
	readonly sourceCount: number;
	readonly pictures: readonly string[];
}

export interface LibraryInput {
	readonly paths: readonly string[];
	readonly text: (path: string) => { readonly value: string | undefined; readonly base: string | undefined };
	readonly file: unknown;
	readonly resolve: (path: string) => string | undefined;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_MARKS = /\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g;

function readDocument(path: string, value: string, base: string | undefined): ReportDocument | undefined {
	const parsed = parseReportJson(path, value);
	if (!parsed) return undefined;
	const parsedBase = base ? parseReportJson(path, base) : undefined;
	return { ...parsed, changed: base !== value, ...(parsedBase ? { base: { ...parsedBase, changed: false } } : {}) };
}

function mostCommon(values: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	let best: string | undefined;
	for (const [value, count] of counts) if (best === undefined || count > (counts.get(best) ?? 0)) best = value;
	return best;
}

function sortDay(doc: ReportDocument): string {
	return CALENDAR_DAY.test(doc.date) ? doc.date : "";
}

export function buildLibraryModel(input: LibraryInput): LibraryModel {
	const file = readSurfaceLibrary(input.file);
	const documents: ReportDocument[] = [];
	for (const path of input.paths) {
		const text = input.text(path);
		const doc = text.value ? readDocument(path, text.value, text.base) : undefined;
		if (doc) documents.push(doc);
	}
	documents.sort((a, b) => sortDay(a).localeCompare(sortDay(b)) || a.path.localeCompare(b.path));

	const names = new Map(file.themes.map((theme) => [surfaceLibraryThemeKey(theme.name), theme.name]));
	for (const doc of documents) {
		const theme = doc.evidence?.theme;
		if (theme && !names.has(surfaceLibraryThemeKey(theme))) names.set(surfaceLibraryThemeKey(theme), theme.trim());
	}
	const pictures = new Set<string>();
	const numbered = documents.map((doc, index): LibraryPost => {
		const evidence = doc.evidence;
		const themeKey = evidence?.theme ? surfaceLibraryThemeKey(evidence.theme) : undefined;
		const themeName = themeKey === undefined ? undefined : names.get(themeKey);
		const sources = evidence?.sources ?? [];
		const coverPath = evidence?.cover ? input.resolve(evidence.cover.src) : undefined;
		if (coverPath) pictures.add(coverPath);
		const basis = mostCommon(sources.flatMap((source) => (source.kind ? [source.kind] : [])));
		const checked = sources.reduce((latest, source) => (source.checked > latest ? source.checked : latest), "");
		return {
			path: doc.path,
			doc,
			number: String(index + 1).padStart(3, "0"),
			...(themeKey !== undefined && themeName !== undefined ? { themeKey, themeName } : {}),
			sourceCount: sources.length,
			...(basis ? { basis } : {}),
			...(checked ? { checked } : {}),
			claims: (evidence?.shortAnswer ?? []).map((claim) =>
				sources.length ? claim.replace(SOURCE_MARKS, "").trim() : claim,
			),
			...(coverPath && evidence?.cover ? { cover: { path: coverPath, alt: evidence.cover.alt } } : {}),
			related: (evidence?.related ?? []).flatMap((path) => {
				const resolved = input.resolve(path);
				return resolved ? [resolved] : [];
			}),
		};
	});
	const posts = [...numbered].reverse();

	const themes: LibraryTheme[] = file.themes.map((theme) => {
		const icon = theme.icon ? input.resolve(theme.icon) : undefined;
		if (icon) pictures.add(icon);
		return {
			key: surfaceLibraryThemeKey(theme.name),
			name: theme.name,
			...(theme.question ? { question: theme.question } : {}),
			...(theme.lead ? { lead: theme.lead } : {}),
			...(icon ? { icon } : {}),
			open: theme.open,
			posts: [],
		};
	});
	for (const [key, name] of names) {
		if (!themes.some((theme) => theme.key === key)) themes.push({ key, name, open: [], posts: [] });
	}
	const filled = themes.map((theme): LibraryTheme => {
		const own = posts.filter((post) => post.themeKey === theme.key);
		const open = new Map(theme.open.map((item) => [item.what.toLowerCase(), item]));
		for (const post of own) {
			for (const item of post.doc.evidence?.notFound ?? []) {
				const known = open.get(item.what.toLowerCase());
				if (!known || (!known.note && item.note)) open.set(item.what.toLowerCase(), item);
			}
		}
		return { ...theme, open: [...open.values()], posts: own };
	});

	const byPath = new Map(posts.map((post) => [post.path, post]));
	const named = file.featured.flatMap((path) => {
		const resolved = input.resolve(path);
		const post = resolved ? byPath.get(resolved) : undefined;
		return post ? [post] : [];
	});
	return {
		...(file.line ? { line: file.line } : {}),
		themes: filled,
		posts,
		featured: named.length > 0 ? named : posts.slice(0, 1),
		sourceCount: posts.reduce((sum, post) => sum + post.sourceCount, 0),
		pictures: [...pictures],
	};
}
