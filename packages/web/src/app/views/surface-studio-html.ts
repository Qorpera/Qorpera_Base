import { compileIdentityTokensCss, IDENTITY_TOKENS_CSS_PATH, IDENTITY_TOKENS_JSON_PATH } from "@qorpera/contracts";
import { frameParsedPage } from "../../ui/page-frame.ts";
import { SVG_FILE_RE, svgDataUrl } from "./surface-blocks/files.ts";

const TOKEN_STYLESHEET_RE = /(?:^|\/)(?:tokens|qorpera-identity)\.css$/i;
const SCRIPT_FILE_RE = /\.m?js$/i;

export function resolveRelativeStudioPath(fromFilePath: string, href: string): string | null {
	const trimmed = href.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;
	const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
	if (!withoutQuery) return null;
	const fromParts = fromFilePath.includes("/") ? fromFilePath.slice(0, fromFilePath.lastIndexOf("/")).split("/") : [];
	const minDepth = fromParts.length > 0 ? 1 : 0;
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
		if (resolved !== fromParts[0] && !resolved.startsWith(`${fromParts[0]}/`)) return null;
	}
	return resolved;
}

export function compiledTokensCssFrom(
	files: Readonly<Record<string, string>>,
	folderRoot: string | null | undefined,
	fallbackCss: string,
): string {
	const cleanRoot = folderRoot?.replace(/^\/+|\/+$/g, "");
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
): boolean {
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		if (!/\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)/i.test(tag)) continue;
		const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rawHref = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
		const resolved = resolveRelativeStudioPath(htmlPath, rawHref);
		if (!resolved) continue;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			const nextCss = previewTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH] || "";
			const prevCss = baseTokensCss || baseFiles[resolved] || baseFiles[IDENTITY_TOKENS_CSS_PATH] || "";
			if (nextCss !== prevCss) return true;
		} else if (/\.css$/i.test(resolved)) {
			if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
		}
	}
	for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
		const src = match[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const rawSrc = src?.[1] ?? src?.[2] ?? src?.[3] ?? "";
		const resolved = resolveRelativeStudioPath(htmlPath, rawSrc);
		if (!resolved || !SVG_FILE_RE.test(resolved)) continue;
		if ((files[resolved] ?? "") !== (baseFiles[resolved] ?? "")) return true;
	}
	return false;
}

export function prepareStudioHtmlPreview(
	html: string,
	htmlPath: string,
	files: Readonly<Record<string, string>>,
	compiledTokensCss: string,
): string | null {
	const doc = new DOMParser().parseFromString(html, "text/html");
	let modified = false;
	for (const link of [...doc.querySelectorAll("link[href]")]) {
		const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
		if (!rel.includes("stylesheet")) continue;
		const resolved = resolveRelativeStudioPath(htmlPath, link.getAttribute("href") ?? "");
		if (!resolved) continue;
		let css: string | undefined;
		if (TOKEN_STYLESHEET_RE.test(resolved)) {
			css = compiledTokensCss || files[resolved] || files[IDENTITY_TOKENS_CSS_PATH];
		} else if (/\.css$/i.test(resolved)) {
			css = files[resolved];
		}
		if (!css) continue;
		const style = doc.createElement("style");
		style.textContent = css.replace(/<\/(style)/gi, "<\\/$1");
		link.replaceWith(style);
		modified = true;
	}
	const deferred: HTMLScriptElement[] = [];
	for (const script of [...doc.querySelectorAll("script[src]")]) {
		const resolved = resolveRelativeStudioPath(htmlPath, script.getAttribute("src") ?? "");
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
		const resolved = resolveRelativeStudioPath(htmlPath, img.getAttribute("src") ?? "");
		if (!resolved || !SVG_FILE_RE.test(resolved)) continue;
		const svg = files[resolved]?.trim();
		if (!svg || !/<svg[\s>]/i.test(svg)) continue;
		img.setAttribute("src", svgDataUrl(svg));
		modified = true;
	}
	if (!modified) return frameParsedPage(doc, html);
	return frameParsedPage(doc);
}
