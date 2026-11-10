/*
 * The explainer kit of interface apps (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a; Jonas, 10 November 2026: "see
 * if there are some interfaces that present better through a 3B1B style video, explaining concepts and ideas clearly
 * but without needing to pin down an exact UI or design yet", and of such a video: "they need to be created with a
 * voice over too though, they can't be mute"). An app made from it is a short narrated video:
 * - `engine.js`, the animation engine and its player, the same in every explainer (packages/runtime/kits/explainer/
 *   engine.js; `EXPLAINER_ENGINE_JS` is its text);
 * - `index.html`, the page, which makes the video `V`, runs the agent's scenes and starts it (`explainerPage`);
 * - `scenes.js`, the agent's own: the scenes, each with its captions and what moves under them;
 * - `voice/`, when the video has a voice: one clip a caption, named by the caption's hash (`captionHash`), and
 *   `voice/clips.json`, which lists them with their lengths (`parseExplainerClips`). The page names each clip, so the
 *   web puts it into the page with the app's other files.
 * `save_app` writes the first two (cloud-folder-app-tools.ts); nothing here reads or writes the folder.
 */

import { EXPLAINER_ENGINE_JS } from "./cloud-app-kit-explainer-engine.generated.ts";

/** The files of an explainer, relative to its folder. */
export const EXPLAINER_ENGINE = "engine.js";
export const EXPLAINER_PAGE = "index.html";
export const EXPLAINER_SCENES = "scenes.js";
export const EXPLAINER_CLIPS = "voice/clips.json";
/** `voice/clips.json` is read up to this size. */
export const EXPLAINER_CLIPS_MAX_BYTES = 64 * 1024;
/** Spoken captions a video holds at most: an app's 64 files, less its manifest, the kit's three and the clips' list,
 * with a few left for the agent's own. */
export const EXPLAINER_MAX_CLIPS = 56;
/** A clip is at most this long: a caption is a sentence or two. */
const CLIP_MAX_SECONDS = 60;
/** A caption of more words than this is two ideas. */
const CAPTION_WORDS = 18;
/** A video read silently for longer than this many seconds is a lecture. */
const VIDEO_SECONDS = 180;

export { EXPLAINER_ENGINE_JS };

/** One recorded clip: the caption it speaks (by hash), its file in `voice/`, and its length. */
export interface ExplainerClip {
	readonly caption: string;
	readonly file: string;
	readonly seconds: number;
}

/** Names a caption's clip: FNV-1a 32-bit over the caption's UTF-8 text, as 8 hex digits. The engine computes the same
 * (`captionHash` in engine.js): a test holds the two together. */
export function captionHash(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * The clips `voice/clips.json` lists, in its order: `{ "clips": [{ "caption": "3f0a9c1e", "file": "3f0a9c1e.mp4",
 * "seconds": 5.42 }] }`. A clip's file is its caption's hash with `.mp4` or `.webm`, so the page names nothing outside
 * `voice/`. Whatever does not read as a clip is left out, one clip a caption, at most EXPLAINER_MAX_CLIPS: a list that
 * went wrong costs the video its voice there, never the video.
 */
export function parseExplainerClips(text: string): ExplainerClip[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	const listed = typeof value === "object" && value !== null ? (value as { clips?: unknown }).clips : null;
	if (!Array.isArray(listed)) return [];
	const clips = new Map<string, ExplainerClip>();
	for (const item of listed) {
		if (clips.size >= EXPLAINER_MAX_CLIPS) break;
		if (typeof item !== "object" || item === null) continue;
		const { caption, file, seconds } = item as { caption?: unknown; file?: unknown; seconds?: unknown };
		if (typeof caption !== "string" || !/^[0-9a-f]{8}$/.test(caption) || clips.has(caption)) continue;
		if (file !== `${caption}.mp4` && file !== `${caption}.webm`) continue;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > CLIP_MAX_SECONDS)
			continue;
		clips.set(caption, { caption, file, seconds: Math.round(seconds * 100) / 100 });
	}
	return [...clips.values()];
}

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string);

/**
 * An explainer's page. It makes the video before the agent's scenes run and starts it after them, so a scenes.js
 * holds only parts and scenes; one that makes and starts its own video still plays (the engine starts once). The
 * clips stand before the scripts, each named on a `<source>`, which the web's page builder turns into the file itself.
 * The page says it is dark, so the web's base style and what stands behind the page until it draws are dark too.
 */
export function explainerPage(title: string, clips: readonly ExplainerClip[]): string {
	// In a script: no `<`, so nothing in a title ends the script or opens a comment.
	const inScript = JSON.stringify(title).replace(/</g, "\\u003c");
	return [
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
		...clips.map(
			(clip) =>
				`<audio data-caption="${clip.caption}" data-seconds="${clip.seconds}" preload="none"><source src="voice/${clip.file}"></audio>`,
		),
		`<script src="${EXPLAINER_ENGINE}"></script>`,
		`<script>window.V = new Video(document.getElementById("video"), { title: ${inScript} });</script>`,
		`<script src="${EXPLAINER_SCENES}"></script>`,
		"<script>V.start();</script>",
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/** The captions a scenes.js speaks, as far as a read of its text tells: the first argument of each `.say(` when it is
 * one plain string. A caption built from parts or a variable is not found, so this counts and advises; it never
 * decides what the video says (the engine does, when it runs). */
export function explainerCaptions(scenes: string): string[] {
	const captions: string[] = [];
	// One plain string and nothing after it but the next argument or the end of the call.
	for (const match of scenes.matchAll(
		/\.say\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)\s*[,)]/g,
	)) {
		const raw = match[1] ?? match[2] ?? match[3] ?? "";
		const caption = raw.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_escape, code: string) =>
			code.length === 5 ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : code === "n" ? "\n" : code,
		);
		if (caption.trim()) captions.push(caption);
	}
	return captions;
}

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * What a quick read of an explainer's scenes.js finds, told to the agent after a save as `save_app` tells what it found
 * in a page (`appLookNotes`): advice, never a refusal. How the video looks stays the agent's to check, on a machine.
 */
export function explainerNotes(scenes: string): string[] {
	const notes: string[] = [];
	const captions = explainerCaptions(scenes);
	if (!/\bV\s*\.\s*scene\s*\(/.test(scenes) || captions.length === 0)
		notes.push(
			'No scene with a caption was found: a video is V.scene((s) => { … s.say("One short sentence.", s.create(thing)); }) once per picture, under V.part("Chapter") marks.',
		);
	if (/\bnew\s+Video\s*\(/.test(scenes))
		notes.push(
			"The page makes the video (V) and starts it: take new Video(…) and V.start() out of scenes.js, which only adds parts and scenes to V.",
		);
	if (captions.length > EXPLAINER_MAX_CLIPS)
		notes.push(
			`${captions.length} captions: a video speaks at most ${EXPLAINER_MAX_CLIPS}, and is best at 25 to 35. Cut it to the one thing it explains.`,
		);
	const long = captions.filter((caption) => words(caption) > CAPTION_WORDS);
	if (long.length > 0)
		notes.push(
			`${long.length} ${long.length === 1 ? "caption is" : "captions are"} longer than ${CAPTION_WORDS} words (the first: "${(long[0] as string).slice(0, 80)}${(long[0] as string).length > 80 ? "…" : ""}"): one idea a caption, about 15 words, and split the rest.`,
		);
	// Read silently a caption lasts its words at three a second and half a second more (the engine's pace).
	const seconds = Math.round(captions.reduce((sum, caption) => sum + words(caption) / 3 + 0.5, 0));
	if (seconds > VIDEO_SECONDS)
		notes.push(
			`About ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} of captions: aim at 90 to 120 seconds, and make a second video for a second idea.`,
		);
	return notes;
}
