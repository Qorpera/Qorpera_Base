export const SURFACE_LIBRARY_DEFAULT_FILE = "research.json";
export const SURFACE_LIBRARY_DEFAULT_MATCH = "**/*.report.json";
export const SURFACE_LIBRARY_THEMES_MAX = 12;
export const SURFACE_LIBRARY_OPEN_MAX = 12;
export const SURFACE_LIBRARY_FEATURED_MAX = 4;

export const SURFACE_LIBRARY_FORMAT = `A library file (default ${SURFACE_LIBRARY_DEFAULT_FILE}) is {"line":"<one sentence: what the company is finding out>","themes":[{"name":"<as its posts name it>","question":"<the one question the theme asks>","lead":"<what it looks at, one sentence that follows the name>","icon":"<a one-colour .svg in this folder>","open":[{"what":"<not known yet>","note":"<what would close it>"}]}],"featured":["<path of a *.report.json>"]}. The library block shows each post under the "theme" it names, numbered oldest first; a theme named here with no post yet shows as empty, so name the themes the company must answer before their posts exist. At most ${SURFACE_LIBRARY_THEMES_MAX} themes, ${SURFACE_LIBRARY_OPEN_MAX} open lines a theme and ${SURFACE_LIBRARY_FEATURED_MAX} featured posts; with no "featured" the newest post leads.`;

export interface SurfaceLibraryOpen {
	readonly what: string;
	readonly note?: string;
}

export interface SurfaceLibraryTheme {
	readonly name: string;
	readonly question?: string;
	readonly lead?: string;
	readonly icon?: string;
	readonly open: readonly SurfaceLibraryOpen[];
}

export interface SurfaceLibraryFile {
	readonly line?: string;
	readonly themes: readonly SurfaceLibraryTheme[];
	readonly featured: readonly string[];
}

const EMPTY_LIBRARY: SurfaceLibraryFile = { themes: [], featured: [] };
const ICON_FILE = /\.svg$/i;
const REPORT_FILE = /\.report\.json$/i;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function line(value: unknown): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed === "" || /[\r\n]/.test(trimmed) ? undefined : trimmed;
}

function folderPath(value: unknown, file: RegExp): string | undefined {
	const path = line(value);
	if (path === undefined || !file.test(path) || path.includes("\\") || path.includes("\0")) return undefined;
	const parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
	return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : path;
}

export function compareSurfaceLibraryPosts(
	a: { readonly date: string; readonly path: string },
	b: { readonly date: string; readonly path: string },
): number {
	const day = (date: string) => (CALENDAR_DAY.test(date) ? date : "");
	return day(a.date).localeCompare(day(b.date)) || a.path.localeCompare(b.path);
}

export function surfaceLibraryThemeKey(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function readOpen(value: unknown): SurfaceLibraryOpen[] {
	if (!Array.isArray(value)) return [];
	const open: SurfaceLibraryOpen[] = [];
	for (const entry of value) {
		if (open.length >= SURFACE_LIBRARY_OPEN_MAX) break;
		const what = isPlainObject(entry) ? line(entry.what) : undefined;
		if (what === undefined || !isPlainObject(entry)) continue;
		const note = line(entry.note);
		open.push({ what, ...(note === undefined ? {} : { note }) });
	}
	return open;
}

function readThemes(value: unknown): SurfaceLibraryTheme[] {
	if (!Array.isArray(value)) return [];
	const themes: SurfaceLibraryTheme[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (themes.length >= SURFACE_LIBRARY_THEMES_MAX) break;
		const name = isPlainObject(entry) ? line(entry.name) : undefined;
		if (name === undefined || !isPlainObject(entry) || seen.has(surfaceLibraryThemeKey(name))) continue;
		seen.add(surfaceLibraryThemeKey(name));
		const question = line(entry.question);
		const lead = line(entry.lead);
		const icon = folderPath(entry.icon, ICON_FILE);
		themes.push({
			name,
			...(question === undefined ? {} : { question }),
			...(lead === undefined ? {} : { lead }),
			...(icon === undefined ? {} : { icon }),
			open: readOpen(entry.open),
		});
	}
	return themes;
}

function readFeatured(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const featured: string[] = [];
	for (const entry of value) {
		if (featured.length >= SURFACE_LIBRARY_FEATURED_MAX) break;
		const path = folderPath(entry, REPORT_FILE);
		if (path !== undefined && !featured.includes(path)) featured.push(path);
	}
	return featured;
}

export function readSurfaceLibrary(value: unknown): SurfaceLibraryFile {
	if (!isPlainObject(value)) return EMPTY_LIBRARY;
	const lead = line(value.line);
	return {
		...(lead === undefined ? {} : { line: lead }),
		themes: readThemes(value.themes),
		featured: readFeatured(value.featured),
	};
}
