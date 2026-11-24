import type { StudioBinaryRef, SurfaceArtifactsBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { markdown } from "../../../ui/markdown.ts";
import { t } from "../../../ui/preferences.ts";
import type { SurfacePictures } from "./brand-mark.ts";
import { COLOR_VALUE, type ColorToken, collectColors } from "./colours.ts";
import {
	homeEmpty,
	parseJsonObject,
	readableName,
	type StudioSectionTask,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
} from "./context.ts";
import { expandButton, type StudioFullscreen, type StudioVisualItem } from "./fullscreen.ts";
import { renderSwatches } from "./palette.ts";
import {
	COLOR_GROUPS,
	collectSpecs,
	renderSpecEntries,
	renderSpecTables,
	type SpecEntry,
	type SpecTable,
	TYPE_GROUPS,
} from "./specs.ts";
import { type Face, facesOf, renderTypeRows } from "./type-specimen.ts";

export const HTML_FILE_RE = /\.html?$/i;
export const SVG_FILE_RE = /\.svg$/i;
export const IMAGE_FILE_RE = /\.(?:png|webp|jpe?g)$/i;
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

export interface StudioHtmlFrame {
	readonly html: string;
	readonly path: string;
	readonly title: string;
	readonly files: Readonly<Record<string, string>>;
	readonly className: string;
	readonly listen?: (data: unknown) => void;
}

export interface StudioHtmlPages {
	readonly frame: (page: StudioHtmlFrame) => HTMLElement;
	readonly linksChanged: (html: string, htmlPath: string) => boolean;
}

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

type StudioVisualArtifact =
	| {
			readonly kind: "svg";
			readonly path: string;
			readonly title: string;
			readonly svg: string;
			readonly changed: boolean;
	  }
	| {
			readonly kind: "binary";
			readonly path: string;
			readonly title: string;
			readonly ref: StudioBinaryRef;
			readonly changed: boolean;
	  };

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

export function renderPlainDoc(content: string, bodyClass: string, signal: AbortSignal, full = false): HTMLElement[] {
	if (full || content.length <= MAX_INITIAL_TEXT_CHARS) {
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

function renderVisualImage(asset: StudioVisualArtifact, pictures: SurfacePictures, className: string): HTMLElement {
	if (asset.kind === "svg") {
		return h("img", {
			class: className,
			src: svgDataUrl(asset.svg),
			alt: asset.title,
		});
	}
	return pictures.binaryImage(asset.ref, asset.title, className);
}

function renderVisualAssets(
	assets: readonly StudioVisualArtifact[],
	heading: string | null,
	pictures: SurfacePictures,
	fullscreen: StudioFullscreen,
): HTMLElement {
	const items: StudioVisualItem[] = assets.map((asset) => ({
		title: asset.title,
		render: () => renderVisualImage(asset, pictures, "studio-fullscreen-img"),
	}));
	return h(
		"section",
		{ class: "studio-section" },
		heading ? h("div", { class: "studio-section-head" }, h("h2", null, heading)) : null,
		h(
			"div",
			{ class: "studio-svg-grid" },
			assets.map((asset, index) => {
				const open = () => fullscreen.openMedia(items, index);
				const label = t("Show {name} large", { name: asset.title });
				return h(
					"figure",
					{ class: `studio-svg-card${asset.changed ? " is-changed" : ""}`, "data-file": asset.path },
					h(
						"button",
						{
							type: "button",
							class: "studio-svg-stage",
							"aria-label": label,
							title: label,
							onclick: open,
						},
						renderVisualImage(asset, pictures, "studio-svg-img"),
					),
					h(
						"figcaption",
						{ class: "studio-svg-meta" },
						h("strong", null, asset.title),
						asset.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						expandButton(asset.title, open),
					),
				);
			}),
		),
	);
}

function renderDocBody(doc: StudioDoc, signal: AbortSignal, full = false): HTMLElement[] {
	return doc.isMarkdown
		? [h("div", { class: "studio-doc-body" }, markdown(doc.content))]
		: renderPlainDoc(doc.content, "studio-doc-body studio-plain-text", signal, full);
}

function renderDoc(doc: StudioDoc, signal: AbortSignal, fullscreen: StudioFullscreen): HTMLElement {
	return h(
		"section",
		{ class: `studio-section studio-doc${doc.changed ? " is-changed" : ""}`, "data-file": doc.path },
		sectionHead(
			doc.title,
			doc.changed,
			expandButton(doc.title, () =>
				fullscreen.openContent(
					doc.title,
					() => h("div", { class: "studio-fullscreen-doc" }, ...renderDocBody(doc, signal, true)),
					"doc",
				),
			),
		),
		...renderDocBody(doc, signal),
	);
}

interface JsonCard {
	readonly path: string;
	readonly colours: readonly ColorToken[];
	readonly faces: readonly Face[];
	readonly entries: readonly SpecEntry[];
	readonly tables: readonly SpecTable[];
	readonly changed: boolean;
}

function jsonCard(path: string, content: string, baseContent: string | undefined): JsonCard | undefined {
	const parsed = parseJsonObject(content);
	if (!parsed) return undefined;
	const base = parseJsonObject(baseContent);
	const colours: ColorToken[] = [];
	const faces: Face[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		const lower = key.toLowerCase();
		if (COLOR_GROUPS.has(lower) || (typeof value === "string" && COLOR_VALUE.test(value.trim())))
			collectColors(value, base, [key], colours);
		else if (TYPE_GROUPS.has(lower) && typeof value === "string")
			faces.push(...facesOf({ [key]: value }, { [key]: base?.[key] }, ""));
		else if (TYPE_GROUPS.has(lower)) faces.push(...facesOf(value, base?.[key], key));
	}
	const entries: SpecEntry[] = [];
	const tables: SpecTable[] = [];
	collectSpecs(parsed, base, [], entries, tables);
	if (colours.length + faces.length + entries.length + tables.length === 0) return undefined;
	return { path, colours, faces, entries, tables, changed: baseContent !== content };
}

function renderJsonBody(card: JsonCard, signal: AbortSignal, full = false): HTMLElement {
	return h(
		"div",
		{ class: "studio-json-body" },
		card.colours.length ? renderSwatches(card.colours) : null,
		card.faces.length ? renderTypeRows(card.faces) : null,
		card.entries.length ? renderSpecEntries(card.entries) : null,
		...renderSpecTables(card.tables, signal, full),
	);
}

function renderJsonCard(card: JsonCard, signal: AbortSignal, fullscreen: StudioFullscreen): HTMLElement {
	const title = readableName(card.path);
	return h(
		"section",
		{ class: `studio-section${card.changed ? " is-changed" : ""}`, "data-file": card.path },
		sectionHead(
			title,
			card.changed,
			expandButton(title, () => fullscreen.openContent(title, () => renderJsonBody(card, signal, true), "wide")),
		),
		card.colours.length ? renderSwatches(card.colours) : null,
		card.faces.length ? renderTypeRows(card.faces) : null,
		card.entries.length ? renderSpecEntries(card.entries) : null,
		...renderSpecTables(card.tables, signal),
	);
}

export interface SurfaceArtifactsPlace {
	readonly claimed: ReadonlySet<string>;
	readonly alone: boolean;
}

export function prepareArtifacts(
	block: SurfaceArtifactsBlock,
	ctx: SurfaceBlockContext,
	htmlPages: StudioHtmlPages,
	pictures: SurfacePictures,
	fullscreen: StudioFullscreen,
	place: SurfaceArtifactsPlace,
): SurfaceBlockPrepared {
	const visuals: StudioVisualArtifact[] = [];
	const docs: StudioDoc[] = [];
	const cards: JsonCard[] = [];
	const pages: { readonly path: string; readonly title: string; readonly html: string; readonly changed: boolean }[] =
		[];
	for (const { path } of ctx.matching(block.match, block.skip)) {
		if (place.claimed.has(path)) continue;
		const text = ctx.text(path);
		if (text.value !== undefined) {
			const content = text.value;
			const changed = text.base !== content;
			if (JSON_FILE_RE.test(path)) {
				const card = OWN_BLOCK_JSON_RE.test(path) ? undefined : jsonCard(path, content, text.base);
				if (card) cards.push(card);
			} else if (SVG_FILE_RE.test(path)) {
				const trimmed = content.trim();
				if (!/<svg[\s>]/i.test(trimmed)) continue;
				visuals.push({ kind: "svg", path, title: readableName(path), svg: trimmed, changed });
			} else if (MARKDOWN_FILE_RE.test(path) || PROSE_TEXT_FILE_RE.test(path)) {
				docs.push({ path, title: readableName(path), content, isMarkdown: MARKDOWN_FILE_RE.test(path), changed });
			} else if (HTML_FILE_RE.test(path)) {
				pages.push({
					path,
					title: htmlDocumentTitle(content, path),
					html: content,
					changed: changed || htmlPages.linksChanged(content, path),
				});
			}
			continue;
		}
		if (IMAGE_FILE_RE.test(path)) {
			const binary = ctx.binary(path);
			if (binary.value?.mediaType.startsWith("image/")) {
				visuals.push({
					kind: "binary",
					path,
					title: readableName(path),
					ref: binary.value,
					changed: binary.value.fileSha256 !== binary.base?.fileSha256,
				});
			}
		}
	}
	docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));
	const filled = visuals.length + docs.length + cards.length + pages.length > 0;
	if (!filled && !block.heading && !place.alone) return { filled, pieces: [] };
	const pieces: StudioSectionTask[] = [];
	if (block.heading) {
		const heading = ctx.words(block.heading);
		pieces.push({ build: () => sectionHead(heading, false) });
	}
	if (!filled) {
		pieces.push({ build: () => homeEmpty(t("Artifacts. Models, pictures and notes live here.")) });
		return { filled, pieces };
	}
	if (visuals.length) {
		const hasRaster = visuals.some((asset) => asset.kind === "binary");
		const onlyVisuals = docs.length === 0 && cards.length === 0 && pages.length === 0;
		const visualHeading = block.heading && onlyVisuals ? null : hasRaster ? t("Visuals") : t("Vector assets");
		pieces.push({ build: () => renderVisualAssets(visuals, visualHeading, pictures, fullscreen) });
	}
	for (const doc of docs) pieces.push({ build: () => renderDoc(doc, ctx.signal, fullscreen) });
	for (const card of cards) pieces.push({ build: () => renderJsonCard(card, ctx.signal, fullscreen) });
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
					sectionHead(
						page.title,
						page.changed,
						expandButton(page.title, () =>
							fullscreen.openContent(
								page.title,
								() =>
									htmlPages.frame({
										html: page.html,
										path: page.path,
										title: page.title,
										files: ctx.files,
										className: "studio-html-frame is-fullscreen",
									}),
								"frame",
							),
						),
					),
					htmlPages.frame({
						html: page.html,
						path: page.path,
						title: page.title,
						files: ctx.files,
						className: "studio-html-frame",
					}),
				),
		});
	}
	return { filled, pieces };
}
