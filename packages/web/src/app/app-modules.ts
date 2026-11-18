import { type ImportSpecifier, parse } from "../vendor/es-module-lexer/lexer.asm.mjs";

export interface ModuleReader {
	readonly warm: boolean;
	text(path: string): Promise<string | null>;
	resolve(base: string, reference: string): string | null;
}

export interface BoundModules {
	readonly files: ReadonlyMap<string, Blob>;
	readonly said: readonly string[];
}

interface PageMap {
	readonly exact: ReadonlyMap<string, string | null>;
	readonly prefixes: readonly (readonly [string, string | null])[];
}

type Resolved = { readonly path: string } | { readonly kept: true } | { readonly refused: string };

interface Bound {
	readonly path: string;
	readonly token: string;
	readonly blob: Blob;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE = /^\.\.?\//;
const DYNAMIC = new Set([2, 5, 7]);
const META = 3;

export const MODULE_SCHEME = "qorpera-module:";

export function virtualModule(path: string): string {
	return `${MODULE_SCHEME}/${path
		.split("/")
		.map((part) => encodeURIComponent(part).replace(/'/g, "%27"))
		.join("/")}`;
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

async function sha32(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
	return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pageMap(scripts: readonly HTMLScriptElement[], reader: ModuleReader, base: string): PageMap {
	const exact = new Map<string, string | null>();
	const prefixes: [string, string | null][] = [];
	for (const script of scripts) {
		let imports: unknown;
		try {
			imports = (JSON.parse(script.textContent ?? "") as { imports?: unknown }).imports;
		} catch {
			continue;
		}
		if (typeof imports !== "object" || imports === null) continue;
		for (const [key, value] of Object.entries(imports)) {
			if (typeof value !== "string" || key === "" || RELATIVE.test(key) || key.startsWith("/") || SCHEME.test(key))
				continue;
			const local = SCHEME.test(value) || value.startsWith("/") ? null : reader.resolve(base, value);
			if (key.endsWith("/")) {
				if (!prefixes.some(([known]) => known === key))
					prefixes.push([key, local === null || !value.endsWith("/") ? null : `${local}/`]);
			} else if (!exact.has(key)) exact.set(key, local);
		}
	}
	prefixes.sort((a, b) => b[0].length - a[0].length);
	return { exact, prefixes };
}

function resolveSpecifier(map: PageMap, reader: ModuleReader, from: string, specifier: string): Resolved {
	if (RELATIVE.test(specifier)) {
		const path = reader.resolve(from, specifier);
		return path === null ? { refused: "which is outside the page's folder" } : { path };
	}
	if (/^(?:blob|data):/i.test(specifier)) return { kept: true };
	if (SCHEME.test(specifier) || specifier.startsWith("/"))
		return { refused: "which is not a file of the page's folder" };
	if (map.exact.has(specifier)) {
		const path = map.exact.get(specifier);
		return path ? { path } : { refused: "which the page's import map names outside its folder" };
	}
	for (const [prefix, target] of map.prefixes)
		if (specifier.startsWith(prefix)) {
			const path = target === null ? null : reader.resolve("", target + specifier.slice(prefix.length));
			return path === null ? { refused: "which the page's import map names outside its folder" } : { path };
		}
	return { refused: "which the page's import map does not name" };
}

export async function bindModules(
	page: Document,
	reader: ModuleReader,
	base: string,
	frameFolder: string,
): Promise<BoundModules | null> {
	const maps = [...page.querySelectorAll<HTMLScriptElement>("script[type='importmap' i]")];
	const scripts = [...page.querySelectorAll<HTMLScriptElement>("script[type='module' i]")];
	if (maps.length === 0 && scripts.length === 0) return null;
	const map = pageMap(maps, reader, base);
	const said: string[] = [];
	const bound = new Map<string, Promise<Bound | null>>();
	const metaUrl = (path: string) =>
		base === "" || path.startsWith(`${base}/`)
			? `${frameFolder}${base === "" ? path : path.slice(base.length + 1)}`
			: null;

	const rewrite = (source: string, name: string, from: string, url: string | null): string => {
		let imports: readonly ImportSpecifier[];
		try {
			[imports] = parse(source, name);
		} catch (error) {
			said.push(
				`${name} could not be read as a module: ${error instanceof Error ? error.message : "it does not parse"}`,
			);
			return source;
		}
		const edits: (readonly [number, number, string])[] = [];
		for (const found of imports) {
			if (found.t === META) {
				if (url !== null && source.startsWith(".url", found.e) && !/[\w$]/.test(source[found.e + 4] ?? ""))
					edits.push([found.s, found.e + 4, JSON.stringify(url)]);
				continue;
			}
			if (found.n === undefined) continue;
			const resolved = resolveSpecifier(map, reader, from, found.n);
			if ("kept" in resolved) continue;
			if ("refused" in resolved) {
				said.push(`${name} imports ${found.n}, ${resolved.refused}`);
				continue;
			}
			const virtual = virtualModule(resolved.path);
			edits.push([found.s, found.e, DYNAMIC.has(found.t) ? JSON.stringify(virtual) : virtual]);
			void load(resolved.path, name, found.n);
		}
		let out = source;
		for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0]))
			out = out.slice(0, start) + text + out.slice(end);
		return out;
	};

	const load = (path: string, importer: string, specifier: string): Promise<Bound | null> => {
		const known = bound.get(path);
		if (known) return known;
		const reading = (async () => {
			const source = await reader.text(path).catch(() => null);
			if (source === null) {
				said.push(`${importer} imports ${specifier}, which is not in the page's folder`);
				return null;
			}
			const text = `${rewrite(source, path, dirOf(path), metaUrl(path))}\n//# sourceURL=${virtualModule(path)}`;
			if (reader.warm) return null;
			const bytes = new TextEncoder().encode(text);
			const token = `qorpera-file-${await sha32(bytes)}-module`;
			return { path, token, blob: new Blob([bytes as BlobPart], { type: "text/javascript" }) };
		})();
		bound.set(path, reading);
		return reading;
	};

	const changes: (() => void)[] = [];
	for (const script of scripts) {
		const src = script.getAttribute("src");
		if (src === null) {
			const text = rewrite(script.textContent ?? "", "the page", base, null);
			changes.push(() => {
				script.textContent = text.replace(/<\/script/gi, "<\\/script");
			});
			continue;
		}
		const path = reader.resolve(base, src);
		if (path !== null) void load(path, "the page", src);
	}
	for (const link of [...page.querySelectorAll<HTMLLinkElement>("link[rel~='modulepreload' i][href]")])
		if (reader.resolve(base, link.getAttribute("href") ?? "") !== null) changes.push(() => link.remove());

	let settled = 0;
	while (settled < bound.size) {
		settled = bound.size;
		await Promise.all([...bound.values()]);
	}
	const results = new Map<string, Bound>();
	for (const [path, reading] of bound) {
		const result = await reading;
		if (result) results.set(path, result);
	}
	for (const change of changes) change();
	for (const script of scripts) {
		const src = script.getAttribute("src");
		if (src === null) continue;
		const path = reader.resolve(base, src);
		if (path === null) continue;
		const result = results.get(path);
		if (result) script.setAttribute("src", result.token);
		else script.removeAttribute("src");
	}
	const imports: Record<string, string> = {};
	for (const [path, result] of results) imports[virtualModule(path)] = result.token;
	for (const [key, path] of map.exact) {
		const result = path === null ? undefined : results.get(path);
		if (result) imports[key] = result.token;
	}
	for (const script of maps) script.remove();
	const element = page.createElement("script");
	element.setAttribute("type", "importmap");
	element.textContent = JSON.stringify({ imports }).replace(/</g, "\\u003c");
	page.head.prepend(element);
	const files = new Map<string, Blob>();
	for (const result of results.values()) files.set(result.token, result.blob);
	return { files, said };
}
