import {
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	type StudioBinaryRef,
} from "@qorpera/contracts";
import { frameParsedPage, parseHtmlInert } from "../../ui/page-frame.ts";
import { SVG_FILE_RE, svgDataUrl } from "./surface-blocks/artifacts.ts";

const TOKEN_STYLESHEET_RE = /(?:^|\/)(?:tokens|qorpera-identity)\.css$/i;
const SCRIPT_FILE_RE = /\.m?js$/i;
const ASSET_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_FRAME_ASSET_PATH_CHARS = 512;

const TEXT_ASSET_MIME: Readonly<Record<string, string>> = {
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

function cleanRootFolder(folderRoot: string | null | undefined): string {
	return folderRoot ? folderRoot.replace(/^\/+|\/+$/g, "") : "";
}

export function studioFrameBase(htmlPath: string, folderRoot: string | null | undefined): string {
	const root = cleanRootFolder(folderRoot);
	const cleanPath = htmlPath.replace(/^\/+/, "");
	const relative = root && cleanPath.startsWith(`${root}/`) ? cleanPath.slice(root.length + 1) : cleanPath;
	const slash = relative.lastIndexOf("/");
	return slash > 0 ? relative.slice(0, slash) : "";
}

export function resolveStudioFrameAssetPath(
	folderRoot: string | null | undefined,
	base: string,
	rawPath: string,
): string | null {
	if (
		base.length > MAX_FRAME_ASSET_PATH_CHARS ||
		rawPath.length > MAX_FRAME_ASSET_PATH_CHARS ||
		base.includes("\\") ||
		base.includes("\0") ||
		rawPath.includes("\\") ||
		rawPath.includes("\0")
	) {
		return null;
	}
	const trimmedBase = base.trim();
	const baseParts: string[] = [];
	if (trimmedBase !== "") {
		if (trimmedBase.startsWith("/") || trimmedBase.endsWith("/")) return null;
		for (const part of trimmedBase.split("/")) {
			if (!part || part === "." || part === "..") return null;
			baseParts.push(part);
		}
	}
	const trimmed = rawPath.trim();
	if (!trimmed || ASSET_SCHEME_RE.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("/")) return null;
	const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
	if (!withoutQuery) return null;
	for (const part of withoutQuery.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (baseParts.length === 0) return null;
			baseParts.pop();
			continue;
		}
		baseParts.push(part);
	}
	if (baseParts.length === 0) return null;
	const relative = baseParts.join("/");
	const root = cleanRootFolder(folderRoot);
	return root ? `${root}/${relative}` : relative;
}

export function studioAssetMimeType(path: string): string {
	const dot = path.lastIndexOf(".");
	const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
	return TEXT_ASSET_MIME[ext] ?? "application/octet-stream";
}

export function resolveRelativeStudioPath(
	fromFilePath: string,
	href: string,
	folderRoot?: string | null,
): string | null {
	const trimmed = href.trim();
	if (!trimmed || ASSET_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) return null;
	const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
	if (!withoutQuery) return null;
	const fromParts = fromFilePath.includes("/") ? fromFilePath.slice(0, fromFilePath.lastIndexOf("/")).split("/") : [];
	const root = cleanRootFolder(folderRoot);
	const rootParts = root ? root.split("/") : [];
	const rootMatches =
		rootParts.length > 0 &&
		fromParts.length >= rootParts.length &&
		rootParts.every((part, index) => fromParts[index] === part);
	const minDepth = rootMatches ? rootParts.length : fromParts.length > 0 ? 1 : 0;
	const baseParts = withoutQuery.startsWith("/") ? [] : [...fromParts];
	for (const part of withoutQuery.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (baseParts.length <= (withoutQuery.startsWith("/") ? 0 : minDepth)) return null;
			baseParts.pop();
			continue;
		}
		baseParts.push(part);
	}
	const resolved = baseParts.join("/");
	if (!resolved) return null;
	if (withoutQuery.startsWith("/") && minDepth > 0 && !TOKEN_STYLESHEET_RE.test(resolved)) {
		const prefix = rootMatches ? root : fromParts[0]!;
		if (resolved !== prefix && !resolved.startsWith(`${prefix}/`)) return null;
	}
	return resolved;
}

export function compiledTokensCssFrom(
	files: Readonly<Record<string, string>>,
	folderRoot: string | null | undefined,
	fallbackCss: string,
): string {
	const cleanRoot = cleanRootFolder(folderRoot);
	const tokensJson =
		files[IDENTITY_TOKENS_JSON_PATH] ??
		(cleanRoot ? files[`${cleanRoot}/tokens.json`] : undefined) ??
		files["tokens.json"];
	if (tokensJson?.trim()) {
		const compiled = compileIdentityTokensCss(tokensJson);
		if (compiled) return compiled;
	}
	return files[IDENTITY_TOKENS_CSS_PATH] ?? (cleanRoot ? files[`${cleanRoot}/tokens.css`] : undefined) ?? fallbackCss;
}

export function studioHtmlDependencyChanged(
	html: string,
	htmlPath: string,
	files: Readonly<Record<string, string>>,
	baseFiles: Readonly<Record<string, string>>,
	previewTokensCss: string,
	baseTokensCss: string,
	binaries?: Readonly<Record<string, StudioBinaryRef>>,
	baseBinaries?: Readonly<Record<string, StudioBinaryRef>>,
	folderRoot?: string | null,
): boolean {
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		if (!/\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)/i.test(tag)) continue;
		const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rawHref = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
		const resolved = resolveRelativeStudioPath(htmlPath, rawHref, folderRoot);
		if (!resolved) continue;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			const nextCss = previewTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH] || "";
			const prevCss = baseTokensCss || baseFiles[resolved] || baseFiles[IDENTITY_TOKENS_CSS_PATH] || "";
			if (nextCss !== prevCss) return true;
		} else if (/\.css$/i.test(resolved)) {
			if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
		}
	}
	for (const match of html.matchAll(/<(?:img|video|audio|source)\b[^>]*>/gi)) {
		for (const attr of ["src", "poster"]) {
			const hit = match[0].match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
			const rawSrc = hit?.[1] ?? hit?.[2] ?? hit?.[3] ?? "";
			if (!rawSrc) continue;
			const resolved = resolveRelativeStudioPath(htmlPath, rawSrc, folderRoot);
			if (!resolved) continue;
			if (SVG_FILE_RE.test(resolved)) {
				if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
			} else if (binaries || baseBinaries) {
				if (binaries?.[resolved]?.fileSha256 !== baseBinaries?.[resolved]?.fileSha256) return true;
			}
		}
	}
	return false;
}

export function prepareStudioHtmlPreview(
	html: string,
	htmlPath: string,
	files: Readonly<Record<string, string>>,
	compiledTokensCss: string,
	binaries?: Readonly<Record<string, StudioBinaryRef>>,
	folderRoot?: string | null,
): string | null {
	const parsed = parseHtmlInert(html);
	const { doc } = parsed;
	const root = cleanRootFolder(folderRoot);
	let modified = false;
	for (const link of [...doc.querySelectorAll("link[href]")]) {
		const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
		if (!rel.includes("stylesheet")) continue;
		const resolved = resolveRelativeStudioPath(htmlPath, link.getAttribute("href") ?? "", root);
		if (!resolved) continue;
		let css: string | undefined;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			css = compiledTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH];
		} else if (/\.css$/i.test(resolved)) {
			css = files[resolved];
		}
		if (!css) continue;
		const style = doc.createElement("noframes");
		style.setAttribute(parsed.tagAttr, "");
		style.textContent = css.replace(/<\/(style)/gi, "<\\/$1").replace(/<\/noframes/gi, parsed.endNoframesToken);
		link.replaceWith(style);
		modified = true;
	}
	const deferred: HTMLScriptElement[] = [];
	for (const script of [...doc.querySelectorAll("script[src]")]) {
		const resolved = resolveRelativeStudioPath(htmlPath, script.getAttribute("src") ?? "", root);
		const code = resolved && SCRIPT_FILE_RE.test(resolved) ? files[resolved] : undefined;
		if (code === undefined) continue;
		const classic = (script.getAttribute("type") ?? "").trim().toLowerCase() !== "module";
		const inline = doc.createElement("script");
		for (const attribute of [...script.attributes])
			if (attribute.name !== "src" && !(classic && (attribute.name === "defer" || attribute.name === "async")))
				inline.setAttribute(attribute.name, attribute.value);
		inline.textContent = code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "\\x3c!--");
		if (classic && script.hasAttribute("defer")) {
			script.remove();
			deferred.push(inline);
		} else {
			script.replaceWith(inline);
		}
		modified = true;
	}
	doc.body.append(...deferred);
	for (const img of [...doc.querySelectorAll("img[src]")]) {
		const resolved = resolveRelativeStudioPath(htmlPath, img.getAttribute("src") ?? "", root);
		if (!resolved || !SVG_FILE_RE.test(resolved)) continue;
		const svg = files[resolved]?.trim();
		if (!svg || !/<svg[\s>]/i.test(svg)) continue;
		img.setAttribute("src", svgDataUrl(svg));
		modified = true;
	}
	if (binaries) {
		for (const element of [
			...doc.querySelectorAll(
				"img[src], image[href], video[src], video[poster], audio[src], source[src], track[src]",
			),
		]) {
			const attributes =
				element.localName === "video" ? ["poster", "src"] : element.localName === "image" ? ["href"] : ["src"];
			for (const attribute of attributes) {
				const raw = element.getAttribute(attribute);
				if (!raw) continue;
				const resolved = resolveRelativeStudioPath(htmlPath, raw, root);
				if (!resolved || !Object.hasOwn(binaries, resolved)) continue;
				const relative = root && resolved.startsWith(`${root}/`) ? resolved.slice(root.length + 1) : resolved;
				element.removeAttribute(attribute);
				element.setAttribute(`data-qorpera-${attribute}`, relative);
				modified = true;
			}
		}
	}
	if (!modified) return frameParsedPage(doc, html, parsed);
	return frameParsedPage(doc, undefined, parsed);
}
