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
	readonly token: string;
	readonly blob: Blob | null;
}

const KINDS: Readonly<Record<string, { readonly type: string; readonly suffix: string }>> = {
	js: { type: "text/javascript", suffix: "module" },
	json: { type: "application/json", suffix: "json" },
	css: { type: "text/css", suffix: "" },
};

function dataAddress(type: string, bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
	return `data:${type};base64,${btoa(binary)}`;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE = /^\.\.?\//;
const DYNAMIC = new Set([2, 5, 7]);
const META = 3;

export const MODULE_SCHEME = "qorpera-module:";

const encoded = (path: string) =>
	path
		.split("/")
		.map((part) => encodeURIComponent(part).replace(/'/g, "%27"))
		.join("/");

export function virtualModule(path: string, kind = "js"): string {
	return `${MODULE_SCHEME}/${encoded(path)}${kind === "js" ? "" : `?type=${kind}`}`;
}

function kindOf(source: string, found: ImportSpecifier): string {
	if (found.a < 0) return "js";
	if (found.at) return found.at.find(([key]) => key === "type")?.[1] ?? "js";
	return /\btype\s*:\s*(["'])([^"'\\]*)\1/.exec(source.slice(found.a, found.se))?.[2] ?? "js";
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
			const outside = SCHEME.test(value) || value.startsWith("/");
			if (key.endsWith("/")) {
				const probe = outside || !value.endsWith("/") ? null : reader.resolve(base, `${value}_`);
				if (!prefixes.some(([known]) => known === key))
					prefixes.push([key, probe === null || !probe.endsWith("_") ? null : probe.slice(0, -1)]);
			} else if (!exact.has(key)) exact.set(key, outside ? null : reader.resolve(base, value));
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
			? `${frameFolder}${encoded(base === "" ? path : path.slice(base.length + 1))}`
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
			const kind = kindOf(source, found);
			if (!KINDS[kind]) {
				said.push(`${name} imports ${found.n} as ${kind}, which a page can't import`);
				continue;
			}
			const virtual = virtualModule(resolved.path, kind);
			edits.push([found.s, found.e, DYNAMIC.has(found.t) ? JSON.stringify(virtual) : virtual]);
			void load(resolved.path, kind, name, found.n);
		}
		let out = source;
		for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0]))
			out = out.slice(0, start) + text + out.slice(end);
		return out;
	};

	const load = (path: string, kind: string, importer: string, specifier: string): Promise<Bound | null> => {
		const virtual = virtualModule(path, kind);
		const known = bound.get(virtual);
		if (known) return known;
		const reading = (async () => {
			const source = await reader.text(path).catch(() => null);
			if (source === null) {
				said.push(`${importer} imports ${specifier}, which is not in the page's folder`);
				return null;
			}
			const text =
				kind === "js" ? `${rewrite(source, path, dirOf(path), metaUrl(path))}\n//# sourceURL=${virtual}` : source;
			if (reader.warm) return null;
			const bytes = new TextEncoder().encode(text);
			const { type, suffix } = KINDS[kind]!;
			// WHY: the frame's style-src names data: but not blob:, so a CSS module comes as a data: address.
			if (suffix === "") return { token: dataAddress(type, bytes), blob: null };
			return {
				token: `qorpera-file-${await sha32(bytes)}-${suffix}`,
				blob: new Blob([bytes as BlobPart], { type }),
			};
		})();
		bound.set(virtual, reading);
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
		if (path !== null) void load(path, "js", "the page", src);
	}
	for (const link of [...page.querySelectorAll<HTMLLinkElement>("link[rel~='modulepreload' i][href]")])
		if (reader.resolve(base, link.getAttribute("href") ?? "") !== null) changes.push(() => link.remove());

	let settled = 0;
	while (settled < bound.size) {
		settled = bound.size;
		await Promise.all([...bound.values()]);
	}
	const results = new Map<string, Bound>();
	for (const [virtual, reading] of bound) {
		const result = await reading;
		if (result) results.set(virtual, result);
	}
	for (const change of changes) change();
	for (const script of scripts) {
		const src = script.getAttribute("src");
		if (src === null) continue;
		const path = reader.resolve(base, src);
		if (path === null) continue;
		const result = results.get(virtualModule(path));
		if (result) script.setAttribute("src", result.token);
		else script.removeAttribute("src");
	}
	const imports: Record<string, string> = {};
	for (const [virtual, result] of results) imports[virtual] = result.token;
	for (const [key, path] of map.exact) {
		const result = path === null ? undefined : results.get(virtualModule(path));
		if (result) imports[key] = result.token;
	}
	for (const script of maps) script.remove();
	const element = page.createElement("script");
	element.setAttribute("type", "importmap");
	element.textContent = JSON.stringify({ imports }).replace(/</g, "\\u003c");
	page.head.prepend(element);
	const files = new Map<string, Blob>();
	for (const result of results.values()) if (result.blob) files.set(result.token, result.blob);
	return { files, said };
}
