import type { SurfaceFilesBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { markdown } from "../../../ui/markdown.ts";
import { t } from "../../../ui/preferences.ts";
import {
	homeEmpty,
	parseJsonObject,
	readableName,
	type StudioSectionTask,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
} from "./context.ts";
import { collectSpecs, renderSpecEntries, renderSpecTables, type SpecEntry, type SpecTable } from "./specs.ts";

export const HTML_FILE_RE = /\.html?$/i;
export const SVG_FILE_RE = /\.svg$/i;
export const MARKDOWN_FILE_RE = /\.(?:md|markdown)$/i;
export const PROSE_TEXT_FILE_RE = /\.txt$/i;
const JSON_FILE_RE = /\.json$/i;
const OWN_BLOCK_JSON_RE = /(?:^|\/)object\.json$|\.report\.json$/i;
const MAX_INITIAL_TEXT_CHARS = 32_000;
const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export type StudioHtmlFrameMaker = (
	html: string,
	htmlPath: string,
	title: string,
	files: Readonly<Record<string, string>>,
	className: string,
) => HTMLElement;

export interface StudioDoc {
	readonly path: string;
	readonly title: string;
	readonly content: string;
	readonly baseContent?: string;
	readonly isMarkdown: boolean;
	readonly changed: boolean;
}

export interface StudioSvgAsset {
	readonly path: string;
	readonly title: string;
	readonly svg: string;
	readonly baseSvg?: string;
	readonly changed: boolean;
}

export function docPriority(path: string): number {
	const lower = path.toLowerCase();
	if (lower.includes("voice") || lower.includes("brief") || lower.includes("readme")) return 0;
	if (lower.includes("spec") || lower.includes("guide")) return 1;
	return 2;
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function htmlDocumentTitle(html: string, fallbackPath: string): string {
	const match = html.match(/<title\b[^>]*>([\s\S]{1,200}?)<\/title>/i);
	if (!match) return readableName(fallbackPath);
	const title = match[1]!
		.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (full, hex, dec, named) => {
			if (hex) {
				const code = Number.parseInt(hex, 16);
				return Number.isFinite(code) ? String.fromCodePoint(code) : full;
			}
			if (dec) {
				const code = Number.parseInt(dec, 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : full;
			}
			return NAMED_HTML_ENTITIES[String(named).toLowerCase()] ?? full;
		})
		.trim()
		.replace(/\s+/g, " ");
	return title && title.length <= 80 ? title : readableName(fallbackPath);
}

export function renderPlainDoc(content: string, bodyClass: string, signal: AbortSignal): HTMLElement[] {
	if (content.length <= MAX_INITIAL_TEXT_CHARS) {
		return [h("div", { class: bodyClass }, content)];
	}
	const textEl = h("div", { class: bodyClass }, `${content.slice(0, MAX_INITIAL_TEXT_CHARS)}…`);
	const moreBtn = h("button", { type: "button", class: "btn btn-small studio-more-btn" }, t("Show full file"));
	moreBtn.addEventListener(
		"click",
		() => {
			textEl.textContent = content;
			moreBtn.remove();
		},
		{ once: true, signal },
	);
	return [textEl, moreBtn];
}

export function renderSvgAssets(svgs: readonly StudioSvgAsset[], heading: string): HTMLElement {
	return h(
		"section",
		{ class: "studio-section" },
		h("div", { class: "studio-section-head" }, h("h2", null, heading)),
		h(
			"div",
			{ class: "studio-svg-grid" },
			svgs.map((asset) =>
				h(
					"figure",
					{ class: `studio-svg-card${asset.changed ? " is-changed" : ""}`, "data-file": asset.path },
					h(
						"div",
						{ class: "studio-svg-stage" },
						h("img", {
							class: "studio-svg-img",
							src: svgDataUrl(asset.svg),
							alt: asset.title,
						}),
					),
					h(
						"figcaption",
						{ class: "studio-svg-meta" },
						h("strong", null, asset.title),
						h("code", { class: "studio-file-tag" }, asset.path),
						asset.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
					),
				),
			),
		),
	);
}

export function renderDoc(doc: StudioDoc, signal: AbortSignal): HTMLElement {
	return h(
		"section",
		{ class: `studio-section studio-doc${doc.changed ? " is-changed" : ""}`, "data-file": doc.path },
		h(
			"div",
			{ class: "studio-section-head" },
			h("h2", null, doc.title),
			h("code", { class: "studio-file-tag" }, doc.path),
			doc.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
		),
		...(doc.isMarkdown
			? [h("div", { class: "studio-doc-body" }, markdown(doc.content))]
			: renderPlainDoc(doc.content, "studio-doc-body studio-plain-text", signal)),
	);
}

interface JsonCard {
	readonly path: string;
	readonly entries: readonly SpecEntry[];
	readonly tables: readonly SpecTable[];
	readonly changed: boolean;
}

function jsonCard(path: string, content: string, baseContent: string | undefined): JsonCard | undefined {
	const parsed = parseJsonObject(content);
	if (!parsed) return undefined;
	const entries: SpecEntry[] = [];
	const tables: SpecTable[] = [];
	collectSpecs(parsed, parseJsonObject(baseContent), [], entries, tables);
	if (entries.length === 0 && tables.length === 0) return undefined;
	return { path, entries, tables, changed: baseContent !== content };
}

function renderJsonCard(card: JsonCard, signal: AbortSignal): HTMLElement {
	return h(
		"section",
		{ class: `studio-section${card.changed ? " is-changed" : ""}`, "data-file": card.path },
		sectionHead(readableName(card.path), card.changed, h("code", { class: "studio-file-tag" }, card.path)),
		card.entries.length ? renderSpecEntries(card.entries) : null,
		...renderSpecTables(card.tables, signal),
	);
}

export interface SurfaceFilesPlace {
	readonly claimed: ReadonlySet<string>;
	readonly alone: boolean;
}

export function prepareFiles(
	block: SurfaceFilesBlock,
	ctx: SurfaceBlockContext,
	htmlFrame: StudioHtmlFrameMaker,
	place: SurfaceFilesPlace,
): SurfaceBlockPrepared {
	const svgs: StudioSvgAsset[] = [];
	const docs: StudioDoc[] = [];
	const cards: JsonCard[] = [];
	const pages: { readonly path: string; readonly title: string; readonly html: string; readonly changed: boolean }[] =
		[];
	for (const { path } of ctx.matching(block.match)) {
		if (place.claimed.has(path)) continue;
		const content = ctx.files[path] ?? "";
		const baseContent = ctx.baseFiles[path];
		const changed = baseContent !== content;
		if (JSON_FILE_RE.test(path)) {
			const card = OWN_BLOCK_JSON_RE.test(path) ? undefined : jsonCard(path, content, baseContent);
			if (card) cards.push(card);
		} else if (SVG_FILE_RE.test(path)) {
			const trimmed = content.trim();
			if (!/<svg[\s>]/i.test(trimmed)) continue;
			svgs.push({ path, title: readableName(path), svg: trimmed, changed });
		} else if (MARKDOWN_FILE_RE.test(path) || PROSE_TEXT_FILE_RE.test(path)) {
			docs.push({ path, title: readableName(path), content, isMarkdown: MARKDOWN_FILE_RE.test(path), changed });
		} else if (HTML_FILE_RE.test(path)) {
			pages.push({ path, title: htmlDocumentTitle(content, path), html: content, changed });
		}
	}
	docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));
	const filled = svgs.length + docs.length + cards.length + pages.length > 0;
	if (!filled && !block.heading && !place.alone) return { filled, pieces: [] };
	const pieces: StudioSectionTask[] = [];
	if (block.heading) {
		const heading = ctx.words(block.heading);
		pieces.push({ build: () => sectionHead(heading, false) });
	}
	if (!filled) {
		pieces.push({ build: () => homeEmpty(t("Working files. Models, pictures and notes live here.")) });
		return { filled, pieces };
	}
	if (svgs.length) pieces.push({ build: () => renderSvgAssets(svgs, t("Vector assets")) });
	for (const doc of docs) pieces.push({ build: () => renderDoc(doc, ctx.signal) });
	for (const card of cards) pieces.push({ build: () => renderJsonCard(card, ctx.signal) });
	for (const page of pages) {
		pieces.push({
			heavy: true,
			build: () =>
				h(
					"section",
					{
						class: `studio-section studio-html-card${page.changed ? " is-changed" : ""}`,
						"data-file": page.path,
					},
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, page.title),
						h("code", { class: "studio-file-tag" }, page.path),
						page.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
					),
					htmlFrame(page.html, page.path, page.title, ctx.files, "studio-html-frame"),
				),
		});
	}
	return { filled, pieces };
}
