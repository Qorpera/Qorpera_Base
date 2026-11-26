import type { StudioBinaryRef, SurfaceExplainerBlock } from "@qorpera/contracts";
import { AppFrame, type FramedPage } from "../../../ui/app-frame.ts";
import { h } from "../../../ui/dom.ts";
import { framePage } from "../../../ui/page-frame.ts";
import { t } from "../../../ui/preferences.ts";
import { loadStudioExplainerEngine } from "../studio-explainer-engine.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";
import {
	folderRelative,
	homeEmpty,
	isPlainRecord,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
	surfaceGlobFinds,
} from "./context.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";

const SCENES_FILE_RE = /\.js$/i;
const CAPTION_HASH_RE = /^[0-9a-f]{8}$/;
const CLIP_AUDIO_EXTS = new Set(["wav", "mp4", "m4a", "mp3", "webm"]);
const CLIP_MAX_SECONDS = 60;
const MAX_CLIPS = 400;

interface ExplainerClipMeta {
	readonly caption: string;
	readonly file: string;
	readonly seconds: number;
}

interface ExplainerItem {
	readonly path: string;
	readonly dir: string;
	readonly title: string;
	readonly scenes: string;
	readonly clips: readonly ExplainerClipMeta[];
	readonly voiceBinaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly changed: boolean;
}

interface MountedExplainer {
	readonly frame: AppFrame;
	readonly loadAbort: AbortController;
	readonly section: HTMLElement;
	readonly stage: HTMLElement;
	readonly meta: HTMLElement;
	readonly items: readonly ExplainerItem[];
	readonly signature: string;
	readonly heading: string;
}

function explainerSignature(item: ExplainerItem): string {
	const clips = item.clips.map((clip) => {
		const ref = item.voiceBinaries[clip.file];
		return [
			clip.caption,
			clip.file,
			clip.seconds,
			ref?.manifestSha256 ?? "",
			ref?.fileSha256 ?? "",
			ref?.mediaType ?? "",
		];
	});
	return JSON.stringify([item.path, item.title, item.scenes, clips]);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) =>
		ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
	);
}

function inlineScript(code: string): string {
	return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "\\x3c!--");
}

function dirOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function joinDir(dir: string, rel: string): string {
	return dir ? `${dir}/${rel}` : rel;
}

function audioMimeFor(file: string, mediaType: string): string {
	if (mediaType.startsWith("audio/")) return mediaType;
	const lower = file.toLowerCase();
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".webm")) return "audio/webm";
	return "audio/mp4";
}

function fileExtToken(file: string): string {
	const dot = file.lastIndexOf(".");
	const raw = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "bin";
	return raw.replace(/[^a-z0-9]/g, "").slice(0, 16) || "bin";
}

function isCaptionClipFile(caption: string, file: string): boolean {
	const dot = file.lastIndexOf(".");
	if (dot <= 0) return false;
	return file.slice(0, dot) === caption && CLIP_AUDIO_EXTS.has(file.slice(dot + 1));
}

function parseClipsJson(text: string | undefined): ExplainerClipMeta[] {
	if (!text) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return [];
	}
	const list = isPlainRecord(raw) && Array.isArray(raw.clips) ? raw.clips : [];
	const out: ExplainerClipMeta[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (out.length >= MAX_CLIPS || !isPlainRecord(entry)) continue;
		const caption = typeof entry.caption === "string" ? entry.caption : "";
		const file = typeof entry.file === "string" ? entry.file : "";
		const seconds = typeof entry.seconds === "number" ? entry.seconds : Number.NaN;
		if (
			!CAPTION_HASH_RE.test(caption) ||
			!isCaptionClipFile(caption, file) ||
			!Number.isFinite(seconds) ||
			seconds <= 0 ||
			seconds > CLIP_MAX_SECONDS ||
			seen.has(caption)
		) {
			continue;
		}
		seen.add(caption);
		out.push({ caption, file, seconds: Math.round(seconds * 100) / 100 });
	}
	return out;
}

function parseExplainerTitle(metaText: string | undefined, dir: string, folderRoot: string): string {
	if (metaText) {
		try {
			const parsed: unknown = JSON.parse(metaText);
			if (isPlainRecord(parsed) && typeof parsed.title === "string" && parsed.title.trim()) {
				return parsed.title.trim().slice(0, 120);
			}
		} catch {}
	}
	if (dir && dir !== folderRoot) return readableName(dir);
	return t("Breakdowns");
}

function matchingScenePaths(block: SurfaceExplainerBlock, ctx: SurfaceBlockContext): string[] {
	if ("from" in block) {
		const path = ctx.companyPath(block.from);
		return path && ctx.text(path).value !== undefined ? [path] : [];
	}
	const paths = Object.keys(ctx.files).filter((path) => {
		if (!SCENES_FILE_RE.test(path)) return false;
		const relative = folderRelative(ctx.folderRoot, path);
		return surfaceGlobFinds(block.match, relative === undefined ? { path } : { path, relative });
	});
	paths.sort((a, b) => a.localeCompare(b));
	return paths;
}

export function explainerClaimedPaths(block: SurfaceExplainerBlock, ctx: SurfaceBlockContext): string[] {
	const claimed: string[] = [];
	for (const scenePath of matchingScenePaths(block, ctx)) {
		claimed.push(scenePath);
		const dir = dirOf(scenePath);
		const metaPath = joinDir(dir, "explainer.json");
		const clipsPath = joinDir(dir, "voice/clips.json");
		const voicePrefix = `${joinDir(dir, "voice")}/`;
		if (ctx.text(metaPath).value !== undefined) claimed.push(metaPath);
		if (ctx.text(clipsPath).value !== undefined) claimed.push(clipsPath);
		for (const path of Object.keys(ctx.files)) {
			if (path.startsWith(voicePrefix)) claimed.push(path);
		}
	}
	return claimed;
}

function collectItems(block: SurfaceExplainerBlock, ctx: SurfaceBlockContext): ExplainerItem[] {
	const items: ExplainerItem[] = [];
	for (const path of matchingScenePaths(block, ctx)) {
		const scenesText = ctx.text(path);
		const scenes = scenesText.value ?? "";
		if (!scenes.trim()) continue;
		const dir = dirOf(path);
		const metaPath = joinDir(dir, "explainer.json");
		const metaText = ctx.text(metaPath);
		const clipsPath = joinDir(dir, "voice/clips.json");
		const clipsText = ctx.text(clipsPath);
		const clips = parseClipsJson(clipsText.value);
		const voiceBinaries: Record<string, StudioBinaryRef> = {};
		let voiceChanged = clipsText.value !== clipsText.base;
		for (const clip of clips) {
			const clipPath = joinDir(dir, `voice/${clip.file}`);
			const bin = ctx.binary(clipPath);
			if (bin.value) voiceBinaries[clip.file] = bin.value;
			if (bin.value?.fileSha256 !== bin.base?.fileSha256) voiceChanged = true;
		}
		const changed = scenes !== (scenesText.base ?? "") || metaText.value !== metaText.base || voiceChanged;
		items.push({
			path,
			dir,
			title: parseExplainerTitle(metaText.value, dir, ctx.folderRoot),
			scenes,
			clips,
			voiceBinaries,
			changed,
		});
	}
	return items;
}

function buildExplainerDocument(
	title: string,
	engineJs: string,
	scenesJs: string,
	audioTags: readonly string[],
): string | null {
	const inScript = JSON.stringify(title).replace(/</g, "\\u003c");
	const raw = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="dark">',
		`<title>${escapeHtml(title)}</title>`,
		"</head>",
		"<body>",
		'<div id="video"></div>',
		...audioTags,
		`<script>${inlineScript(engineJs)}</script>`,
		`<script>window.V = new Video(document.getElementById("video"), { title: ${inScript} });</script>`,
		`<script>${inlineScript(scenesJs)}</script>`,
		"<script>V.start();</script>",
		"</body>",
		"</html>",
		"",
	].join("\n");
	return framePage(raw);
}

export class SurfaceExplainers {
	readonly #read: StudioBinaryReader;
	readonly #signal: AbortSignal;
	readonly #fullscreen: StudioFullscreen;
	readonly #selected = new Map<string, string>();
	readonly #mounted = new Map<string, MountedExplainer>();

	constructor(read: StudioBinaryReader, signal: AbortSignal, fullscreen: StudioFullscreen) {
		this.#read = read;
		this.#signal = signal;
		this.#fullscreen = fullscreen;
		signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	prepare(key: string, block: SurfaceExplainerBlock, ctx: SurfaceBlockContext, alone = true): SurfaceBlockPrepared {
		const items = collectItems(block, ctx);
		const heading = block.heading ? ctx.words(block.heading) : "";
		if (items.length === 0) {
			this.#unmount(key);
			if (!alone) return { filled: false, pieces: [] };
			return {
				filled: false,
				pieces: [
					{
						build: () =>
							h(
								"section",
								{ class: "studio-section studio-explainer-block is-empty", "data-block": "explainer" },
								heading ? sectionHead(heading, false) : null,
								homeEmpty(t("Animated breakdowns live here.")),
							),
					},
				],
			};
		}
		const saved = this.#selected.get(key);
		const active = items.find((item) => item.path === saved) ?? items[0]!;
		this.#selected.set(key, active.path);
		return {
			filled: true,
			pieces: [
				{
					heavy: true,
					build: () => {
						const switcher =
							items.length > 1
								? h(
										"div",
										{ class: "studio-explainer-tabs", role: "tablist", "aria-label": t("Breakdowns") },
										...items.map((item) =>
											h(
												"button",
												{
													type: "button",
													role: "tab",
													class: `studio-explainer-tab${item.path === active.path ? " is-on" : ""}${item.changed ? " is-changed" : ""}`,
													"aria-selected": String(item.path === active.path),
													"data-act": "studio-explainer",
													"data-block": key,
													"data-path": item.path,
												},
												item.title,
											),
										),
									)
								: null;
						const signature = explainerSignature(active);
						const prev = this.#mounted.get(key);
						if (prev && prev.signature === signature && !prev.frame.signal.aborted) {
							prev.section.className = `studio-section studio-explainer-block${active.changed ? " is-changed" : ""}`;
							prev.section.dataset.file = active.path;
							while (prev.section.firstChild && prev.section.firstChild !== prev.meta) {
								prev.section.firstChild.remove();
							}
							if (heading) prev.section.insertBefore(sectionHead(heading, false), prev.meta);
							if (switcher) prev.section.insertBefore(switcher, prev.meta);
							this.#renderMeta(prev.meta, active, prev.frame, prev.stage, heading);
							this.#mounted.set(key, { ...prev, items, heading });
							return prev.section;
						}
						const meta = h("div", { class: "studio-explainer-head" });
						const stage = h("div", { class: "studio-explainer-stage" });
						const section = h(
							"section",
							{
								class: `studio-section studio-explainer-block${active.changed ? " is-changed" : ""}`,
								"data-block": "explainer",
								"data-file": active.path,
							},
							heading ? sectionHead(heading, false) : null,
							switcher,
							meta,
							stage,
						);
						this.#mount(key, items, active, signature, section, meta, stage, heading);
						return section;
					},
				},
			],
		};
	}

	select(key: string, path: string, root: HTMLElement): boolean {
		const mounted = this.#mounted.get(key);
		if (!mounted) return false;
		const next = mounted.items.find((item) => item.path === path);
		if (!next) return false;
		if (this.#selected.get(key) === next.path) return true;
		this.#selected.set(key, next.path);
		for (const button of root.querySelectorAll<HTMLElement>('[data-act="studio-explainer"]')) {
			if (button.dataset.block !== key) continue;
			const on = button.dataset.path === next.path;
			button.classList.toggle("is-on", on);
			button.setAttribute("aria-selected", String(on));
		}
		mounted.section.classList.toggle("is-changed", next.changed);
		mounted.section.dataset.file = next.path;
		this.#mount(
			key,
			mounted.items,
			next,
			explainerSignature(next),
			mounted.section,
			mounted.meta,
			mounted.stage,
			mounted.heading,
		);
		return true;
	}

	keep(activeKeys: ReadonlySet<string>): void {
		for (const key of [...this.#mounted.keys()]) {
			if (!activeKeys.has(key)) this.#unmount(key);
		}
	}

	deactivate(): void {
		for (const mounted of this.#mounted.values()) {
			this.#fullscreen.closeIfHosting(mounted.frame.frame);
			mounted.loadAbort.abort();
			mounted.frame.dispose();
		}
		this.#mounted.clear();
	}

	dispose(): void {
		this.deactivate();
		this.#selected.clear();
	}

	#unmount(key: string): void {
		const mounted = this.#mounted.get(key);
		if (!mounted) return;
		this.#fullscreen.closeIfHosting(mounted.frame.frame);
		mounted.loadAbort.abort();
		mounted.frame.dispose();
		this.#mounted.delete(key);
	}

	#renderMeta(meta: HTMLElement, item: ExplainerItem, frame: AppFrame, stage: HTMLElement, heading: string): void {
		const duplicateTitle =
			heading.trim().length > 0 && heading.trim().toLowerCase() === item.title.trim().toLowerCase();
		const expand = expandButton(item.title, () =>
			this.#fullscreen.openHosted(item.title, frame.frame, stage, "frame"),
		);
		meta.replaceChildren(
			h(
				"div",
				{ class: `studio-section-head${duplicateTitle && !item.changed ? " is-actions-only" : ""}` },
				duplicateTitle ? null : h("h3", null, item.title),
				item.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
				expand,
			),
		);
	}

	#mount(
		key: string,
		items: readonly ExplainerItem[],
		item: ExplainerItem,
		signature: string,
		section: HTMLElement,
		meta: HTMLElement,
		stage: HTMLElement,
		heading: string,
	): void {
		this.#unmount(key);
		const loadAbort = new AbortController();
		const onGlobalAbort = () => loadAbort.abort();
		if (this.#signal.aborted) {
			loadAbort.abort();
		} else {
			this.#signal.addEventListener("abort", onGlobalAbort, { once: true });
			loadAbort.signal.addEventListener("abort", () => this.#signal.removeEventListener("abort", onGlobalAbort), {
				once: true,
			});
		}
		const showError = () => {
			if (loadAbort.signal.aborted) return;
			this.#fullscreen.closeIfHosting(frame.frame);
			stage.replaceChildren(h("p", { class: "studio-html-fallback" }, t("Breakdown could not load.")));
		};
		const pagePromise = this.#buildPage(item, loadAbort.signal);
		const frame = new AppFrame(
			pagePromise,
			t("Breakdown: {name}", { name: item.title }),
			"studio-explainer-frame",
			async () => ({ ok: false, error: t("This page can't be shown here.") }),
			showError,
			{ again: true },
		);
		this.#renderMeta(meta, item, frame, stage, heading);
		stage.replaceChildren(frame.frame);
		this.#mounted.set(key, { frame, loadAbort, section, stage, meta, items, signature, heading });
	}

	async #buildPage(item: ExplainerItem, signal: AbortSignal): Promise<FramedPage> {
		const engineJs = await loadStudioExplainerEngine(signal);
		signal.throwIfAborted();
		if (!engineJs) throw new Error("Explainer engine unavailable");
		const files: [string, Blob][] = [];
		const audioTags: string[] = [];
		const loaded = await Promise.all(
			item.clips.map(async (clip) => {
				const ref = item.voiceBinaries[clip.file];
				if (!ref) return null;
				try {
					const bytes = await this.#read(ref, signal);
					if (signal.aborted) return null;
					const token = `qorpera-file-${ref.fileSha256.slice(0, 32)}-${fileExtToken(clip.file)}`;
					const blob = new Blob([bytes.slice()], { type: audioMimeFor(clip.file, ref.mediaType) });
					return { clip, token, blob };
				} catch {
					return null;
				}
			}),
		);
		signal.throwIfAborted();
		const seenTokens = new Set<string>();
		for (const entry of loaded) {
			if (!entry) continue;
			if (!seenTokens.has(entry.token)) {
				seenTokens.add(entry.token);
				files.push([entry.token, entry.blob]);
			}
			audioTags.push(
				`<audio data-caption="${entry.clip.caption}" data-seconds="${entry.clip.seconds}" preload="none"><source src="${entry.token}"></audio>`,
			);
		}
		const html = buildExplainerDocument(item.title, engineJs, item.scenes, audioTags);
		if (!html) throw new Error("Explainer HTML rejected");
		return files.length > 0 ? { html, files } : { html };
	}
}
