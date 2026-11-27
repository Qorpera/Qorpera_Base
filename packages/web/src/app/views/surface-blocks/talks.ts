import {
	readSurfaceTalk,
	type StudioBinaryRef,
	SURFACE_TALK_FILE,
	SURFACE_TALK_FOOTINGS,
	SURFACE_TALK_STARTER_IDS,
	type SurfaceTalk,
	type SurfaceTalkFooting,
	type SurfaceTalkPicture,
	type SurfaceTalkSource,
	type SurfaceTalkStarterId,
	type SurfaceTalksBlock,
	surfaceTalkCover,
	surfaceTalkFooting,
	surfaceTalkPictureSeconds,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { phrase, t } from "../../../ui/preferences.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";
import { captionHash, parseVoiceClips, type VoiceClipMeta, voiceClipMime } from "../surface-voice-clips.ts";
import { SVG_FILE_RE, svgDataUrl } from "./artifacts.ts";
import { type SurfacePictures, svgText } from "./brand-mark.ts";
import { homeEmpty, parseJsonObject, type SurfaceBlockContext, type SurfaceBlockPrepared } from "./context.ts";
import { drawTalkPicture, type TalkTones, talkTones } from "./talk-pictures.ts";

const GAP_SECONDS = 1.2;
const VOICE_NET_MS = 4000;
const VOICE_LOAD_MS = 8000;

export const TALK_BORDER_WORDS: Readonly<Record<SurfaceTalkStarterId, readonly [has: string, not: string]>> = {
	exists: [
		phrase("The problem, who has it, what changes for them, what the company believes"),
		phrase("Prices, rivals, the plan, the tests"),
	],
	works: [
		phrase("The few claims that must all hold, and what backs each"),
		phrase("The steps of the plan, a catalogue of products"),
	],
	feel: [phrase("The ideas about the experience, and the reasoning behind each"), phrase("Money, suppliers, the law")],
	found: [phrase("What research found, and what each finding changed"), phrase("Guesses and hopes")],
	blocks: [phrase("The obstacles, the worst first, and what each would cost"), phrase("How each gets tested")],
	guesses: [
		phrase("Each guess in plain words, what would prove it, what would end it"),
		phrase("Why the company exists"),
	],
	next: [
		phrase("The steps in order, what each costs, what is known afterwards"),
		phrase("Why the company exists, the case for the business"),
	],
};

const FOOTING_WORDS: Readonly<Record<SurfaceTalkFooting, string>> = {
	research: phrase("Research posts"),
	bets: phrase("Bets"),
	plan: phrase("The plan and your own words"),
	unchecked: phrase("Figures no post has checked"),
};

export interface TalkPostMark {
	readonly number: string;
	readonly title: string;
}

export interface SurfaceTalksOptions {
	readonly companyName: string;
	readonly pictures: SurfacePictures;
	readonly read: StudioBinaryReader;
	readonly signal: AbortSignal;
	readonly post: (path: string, ctx: SurfaceBlockContext) => TalkPostMark | undefined;
	readonly openPost: (path: string) => void;
}

interface TalkFlat {
	readonly picture: SurfaceTalkPicture;
	readonly chapter: number;
	readonly at: number;
	readonly hash: string;
}

interface TalkItem {
	readonly path: string;
	readonly dir: string;
	readonly talk: SurfaceTalk;
	readonly changed: boolean;
	readonly flat: readonly TalkFlat[];
	readonly clips: ReadonlyMap<string, VoiceClipMeta>;
	readonly voiced: boolean;
	readonly footing: Readonly<Record<SurfaceTalkFooting, number>>;
}

interface TalksShown {
	readonly shelf: readonly TalkItem[];
	readonly ctx: SurfaceBlockContext;
	readonly kicker: string;
	readonly tones: TalkTones;
	readonly signature: readonly (string | undefined)[];
}

type TalksPlace =
	| { readonly page: "shelf" }
	| { readonly page: "talk"; readonly path: string }
	| { readonly page: "ask"; readonly path: string };

interface Playing {
	readonly item: TalkItem;
	readonly main: HTMLElement;
	readonly stage: HTMLElement;
	readonly art: HTMLElement;
	readonly big: HTMLElement;
	readonly segments: HTMLElement;
	readonly progress: HTMLElement;
	readonly caption: HTMLElement;
	readonly marks: HTMLElement;
	readonly time: HTMLElement;
	readonly voiceButton: HTMLButtonElement;
	readonly toggle: HTMLElement;
	readonly note: HTMLElement;
	readonly next: HTMLElement;
	readonly board: HTMLElement;
	readonly chapters: HTMLElement;
	readonly urls: Map<string, Promise<string>>;
	index: number;
	chapter: number;
	on: boolean;
	paused: boolean;
	touched: boolean;
	left: number;
	armedAt: number;
	turn: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	audio: HTMLAudioElement | null;
}

const TALK_FILE_RE = new RegExp(`(?:^|/)${SURFACE_TALK_FILE.replace(".", "\\.")}$`, "i");

function dirOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function two(n: number): string {
	return String(n).padStart(2, "0");
}

function clock(seconds: number): string {
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}:${two(whole % 60)}`;
}

function minutesLabel(seconds: number): string {
	if (seconds >= 150) return t("{count} min", { count: Math.round(seconds / 60) });
	const halves = Math.max(1, Math.round(seconds / 30));
	const whole = Math.floor(halves / 2);
	return t("{count} min", { count: `${whole === 0 ? "" : whole}${halves % 2 === 1 ? "½" : ""}` });
}

function countLabel(count: number, one: string, many: string): string {
	return count === 1 ? one : many.replace("{count}", String(count));
}

function pictureSeconds(item: TalkItem, at: number, voice: boolean): number {
	const flat = item.flat[at] as TalkFlat;
	const clip = voice && item.voiced ? item.clips.get(flat.hash) : undefined;
	return clip ? clip.seconds + GAP_SECONDS : surfaceTalkPictureSeconds(flat.picture.say);
}

function talkSeconds(item: TalkItem, voice = true): number {
	return item.flat.reduce((sum, _flat, at) => sum + pictureSeconds(item, at, voice), 0);
}

function chapterSeconds(item: TalkItem, chapter: number, voice: boolean): number {
	return item.flat.reduce(
		(sum, flat, at) => (flat.chapter === chapter ? sum + pictureSeconds(item, at, voice) : sum),
		0,
	);
}

function readShelf(block: SurfaceTalksBlock, ctx: SurfaceBlockContext): TalkItem[] {
	const items = ctx.matching([block.match]).flatMap((file): TalkItem[] => {
		if (!TALK_FILE_RE.test(file.path)) return [];
		const text = ctx.text(file.path);
		const parsed = parseJsonObject(text.value);
		const talk = parsed ? readSurfaceTalk(parsed).talk : undefined;
		if (!talk) return [];
		const dir = dirOf(file.path);
		const clips = parseVoiceClips(ctx.text(`${dir}/voice/clips.json`).value);
		const flat = talk.chapters.flatMap((chapter, index) =>
			chapter.pictures.map((picture, at) => ({
				picture,
				chapter: index,
				at,
				hash: captionHash(picture.say.trim()),
			})),
		);
		const voiced =
			flat.length > 0 &&
			flat.every((entry) => {
				const clip = clips.get(entry.hash);
				return clip !== undefined && ctx.binary(`${dir}/voice/${clip.file}`).value !== undefined;
			});
		return [
			{
				path: file.path,
				dir,
				talk,
				changed: text.value !== text.base,
				flat,
				clips,
				voiced,
				footing: surfaceTalkFooting(talk),
			},
		];
	});
	const place = (item: TalkItem) =>
		item.talk.starter ? SURFACE_TALK_STARTER_IDS.indexOf(item.talk.starter) : SURFACE_TALK_STARTER_IDS.length;
	return items.sort((a, b) => place(a) - place(b) || a.path.localeCompare(b.path));
}

function footBar(footing: Readonly<Record<SurfaceTalkFooting, number>>): HTMLElement {
	const total = SURFACE_TALK_FOOTINGS.reduce((sum, name) => sum + footing[name], 0) || 1;
	return h(
		"span",
		{ class: "tks-foot", role: "img", "aria-label": t("What this talk rests on") },
		SURFACE_TALK_FOOTINGS.flatMap((name) => {
			if (footing[name] === 0) return [];
			const share = h("i", { class: `is-${name}` });
			share.style.width = `${((footing[name] / total) * 100).toFixed(1)}%`;
			return [share];
		}),
	);
}

class TalksView {
	readonly el = h("section", { class: "tks", "data-block": "talks" });
	readonly #options: SurfaceTalksOptions;
	#shown: TalksShown | undefined;
	#place: TalksPlace = { page: "shelf" };
	#playing: Playing | null = null;
	#voice = true;

	constructor(options: SurfaceTalksOptions) {
		this.#options = options;
		this.el.addEventListener("click", (event) => this.#click(event), { signal: options.signal });
		window.addEventListener("keydown", (event) => this.#key(event), { signal: options.signal });
		options.signal.addEventListener("abort", () => this.#stop(), { once: true });
	}

	show(shown: TalksShown): void {
		const before = this.#shown;
		this.#shown = shown;
		this.el.style.setProperty("--tks-brand", shown.tones.tint.a);
		const same =
			before !== undefined &&
			before.kicker === shown.kicker &&
			before.signature.length === shown.signature.length &&
			before.signature.every((part, index) => part === shown.signature[index]);
		if (!same || this.el.childElementCount === 0) this.#render();
	}

	leave(): void {
		const playing = this.#playing;
		if (playing?.on && !playing.paused) this.#toggle();
	}

	deactivate(): void {
		this.#stop();
		this.el.replaceChildren();
	}

	#picture(shown: TalksShown, item: TalkItem, picture: SurfaceTalkPicture): HTMLElement {
		return drawTalkPicture(picture, shown.tones, item.talk.tone, (src, alt) => {
			const path = shown.ctx.companyPath(src);
			if (!path) return null;
			const svg = SVG_FILE_RE.test(path) ? svgText(shown.ctx.text(path).value) : undefined;
			if (svg) return h("img", { src: svgDataUrl(svg), alt });
			const binary = shown.ctx.binary(path).value;
			return binary ? this.#options.pictures.binaryImage(binary, alt, "") : null;
		});
	}

	#go(place: TalksPlace): void {
		this.#place = place;
		this.#render();
		const top = this.el.getBoundingClientRect().top;
		if (top < 0 || top > window.innerHeight * 0.5) this.el.scrollIntoView?.({ block: "start", behavior: "smooth" });
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const { act, path } = target.dataset;
		if (act === "talks-shelf") this.#go({ page: "shelf" });
		else if (act === "talks-open" && path) this.#go({ page: "talk", path });
		else if (act === "talks-ask" && path) this.#go({ page: "ask", path });
		else if (act === "talks-post" && path) this.#options.openPost(path);
		else if (act === "talks-toggle") this.#toggle();
		else if (act === "talks-voice") this.#switchVoice();
		else if (act === "talks-step") this.#jump((this.#playing?.index ?? 0) + Number(target.dataset.step));
		else if (act === "talks-at") this.#jump(Number(target.dataset.at));
		else if (act === "talks-chapter") this.#jumpChapter(Number(target.dataset.chapter));
	}

	#key(event: KeyboardEvent): void {
		const playing = this.#playing;
		if (!playing || !this.el.isConnected || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as Element | null;
		if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
		const box = playing.stage.getBoundingClientRect();
		if (box.bottom < 0 || box.top > window.innerHeight) return;
		if (event.key === " ") {
			if (target?.closest?.("button, a")) return;
			event.preventDefault();
			this.#toggle();
		} else if (event.key === "ArrowRight") this.#jump(playing.index + 1);
		else if (event.key === "ArrowLeft") this.#jump(playing.index - 1);
	}

	#render(): void {
		const shown = this.#shown;
		if (!shown) return;
		this.#stop();
		const place = this.#place;
		const item = place.page === "shelf" ? undefined : shown.shelf.find((entry) => entry.path === place.path);
		if (item && place.page === "talk" && item.talk.state === "made") {
			this.el.dataset.at = "talk";
			this.el.replaceChildren(...this.#player(shown, item));
			return;
		}
		if (item && item.talk.state !== "made") {
			this.#place = { page: "ask", path: item.path };
			this.el.dataset.at = "ask";
			this.el.replaceChildren(...this.#asking(shown, item));
			return;
		}
		this.#place = { page: "shelf" };
		this.el.dataset.at = "shelf";
		this.el.replaceChildren(...this.#shelf(shown));
	}

	#card(shown: TalksShown, item: TalkItem, at: number): HTMLElement {
		const { talk } = item;
		const pill = item.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null;
		if (talk.state !== "made") {
			const pointed = talk.state === "points";
			return h(
				"button",
				{ type: "button", class: "tks-card is-wait", "data-act": "talks-ask", "data-path": item.path },
				h(
					"span",
					{ class: "tks-num" },
					h("i", null, two(at + 1)),
					pointed ? t("points for your yes") : t("waits for your words"),
					pill,
				),
				h(
					"span",
					{ class: "tks-cover tks-wait" },
					h("em", null, pointed ? (talk.answer ?? "") : (talk.asks[0] ?? "")),
					h(
						"small",
						null,
						pointed
							? t("{count} points for your yes", { count: talk.points.length })
							: countLabel(talk.asks.length, t("1 question for you"), t("{count} questions for you")),
					),
				),
				h("span", { class: "tks-name" }, talk.title),
				talk.sub ? h("span", { class: "tks-sub" }, talk.sub) : null,
			);
		}
		const cover = surfaceTalkCover(talk);
		const meta = [
			minutesLabel(talkSeconds(item)),
			countLabel(talk.chapters.length, t("1 chapter"), t("{count} chapters")),
			item.voiced ? t("with voice") : "",
		]
			.filter(Boolean)
			.join(" · ");
		return h(
			"button",
			{ type: "button", class: "tks-card", "data-act": "talks-open", "data-path": item.path },
			h("span", { class: "tks-num" }, h("i", null, two(at + 1)), meta, pill),
			h("span", { class: "tks-cover" }, cover ? this.#picture(shown, item, cover) : null),
			h("span", { class: "tks-name" }, talk.title),
			talk.sub ? h("span", { class: "tks-sub" }, talk.sub) : null,
			footBar(item.footing),
		);
	}

	#shelf(shown: TalksShown): HTMLElement[] {
		const { shelf } = shown;
		if (shelf.length === 0)
			return [h("div", { class: "tks-kicker" }, shown.kicker), homeEmpty(t("Talks live here."))];
		const made = shelf.filter((item) => item.talk.state === "made");
		const waiting = shelf.length - made.length;
		const company = this.#options.companyName;
		const lead = company
			? countLabel(
					shelf.length,
					t("{company} in 1 talk.", { company }),
					t("{company} in {count} talks.", { company, count: "{count}" }),
				)
			: countLabel(shelf.length, t("1 talk."), t("{count} talks."));
		const state =
			waiting === 0
				? t("Each is as long as its subject needs.")
				: [
						countLabel(made.length, t("1 is made."), t("{count} are made.")),
						countLabel(waiting, t("1 waits for you."), t("{count} wait for you.")),
					].join(" ");
		const pictures = made.reduce((sum, item) => sum + item.flat.length, 0);
		const seconds = made.reduce((sum, item) => sum + talkSeconds(item), 0);
		const count = [
			t("{count} made", { count: made.length }),
			...(made.length > 0
				? [
						t("{count} min", { count: Math.max(1, Math.round(seconds / 60)) }),
						countLabel(pictures, t("1 picture"), t("{count} pictures")),
						t("every picture names what it rests on"),
					]
				: []),
		].join(" · ");
		return [
			h("div", { class: "tks-kicker" }, shown.kicker),
			h("p", { class: "tks-state" }, `${lead} `, h("span", null, state)),
			h("p", { class: "tks-count" }, count),
			h(
				"div",
				{ class: "tks-grid" },
				shelf.map((item, at) => this.#card(shown, item, at)),
			),
			...(made.length > 0
				? [
						h(
							"div",
							{ class: "tks-footkey" },
							h("span", null, t("Each bar shows what the talk rests on:")),
							SURFACE_TALK_FOOTINGS.map((name) =>
								h("span", null, h("i", { class: `is-${name}` }), t(FOOTING_WORDS[name])),
							),
						),
					]
				: []),
		];
	}

	#head(shown: TalksShown, item: TalkItem, facts: readonly string[], dek: string | undefined): HTMLElement[] {
		const at = shown.shelf.indexOf(item);
		return [
			h("button", { type: "button", class: "tks-back", "data-act": "talks-shelf" }, `← ${shown.kicker}`),
			h(
				"div",
				{ class: "tks-head" },
				h(
					"div",
					{ class: "tks-kick" },
					h("span", { class: "tks-k" }, t("Talk {n} of {total}", { n: at + 1, total: shown.shelf.length })),
					facts.map((fact) => h("span", null, fact)),
					item.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
				),
				h("h1", { class: "tks-title" }, item.talk.title),
				dek ? h("p", { class: "tks-dek" }, dek) : null,
			),
		];
	}

	#asking(shown: TalksShown, item: TalkItem): HTMLElement[] {
		const { talk } = item;
		const pointed = talk.state === "points";
		const borders = talk.starter ? TALK_BORDER_WORDS[talk.starter] : undefined;
		const questions = h(
			"div",
			{ class: "tks-asks" },
			talk.asks.map((ask, at) =>
				h(
					"div",
					{ class: `tks-ask${pointed ? " is-small" : ""}` },
					h("i", null, String(at + 1)),
					h("p", null, ask),
				),
			),
		);
		const railPart = (heading: string, text: string) =>
			h("div", null, h("h4", null, heading), h("p", { class: "tks-why" }, text));
		return [
			...this.#head(
				shown,
				item,
				pointed
					? [t("points for your yes"), t("no picture yet")]
					: [t("waits for your words"), countLabel(talk.asks.length, t("1 question"), t("{count} questions"))],
				pointed
					? t(
							"These are the points of the talk, each with where it comes from. Say yes, or correct a point. No picture is drawn before that.",
						)
					: t("This talk answers with reasons, and reasons are yours. Nothing is drawn until you have answered."),
			),
			h(
				"div",
				{ class: "tks-play" },
				h(
					"div",
					{ class: "tks-main" },
					...(pointed
						? [
								h("p", { class: "tks-answer" }, talk.answer ?? ""),
								h(
									"ol",
									{ class: "tks-points" },
									talk.points.map((point) =>
										h("li", null, h("span", null, point.text), h("em", null, point.from)),
									),
								),
								...(talk.asks.length > 0 ? [h("h4", { class: "tks-h" }, t("Still asked"))] : []),
							]
						: []),
					questions,
					...(talk.found.length > 0
						? [
								h("h4", { class: "tks-h" }, t("Found in the vision")),
								h(
									"ul",
									{ class: "tks-found" },
									talk.found.map((line) => h("li", null, line)),
								),
							]
						: []),
					...(talk.missing
						? [
								h("h4", { class: "tks-h" }, t("Not found there")),
								h("ul", { class: "tks-found" }, h("li", null, talk.missing)),
							]
						: []),
					h(
						"p",
						{ class: "tks-note" },
						pointed
							? t(
									"Say yes below, or correct a point in your own words. Then the agent draws the talk and gives it a cold listen before you see it.",
								)
							: t(
									"Answer below, in your own words. The agent then writes the points of the talk and shows them to you before it draws a single picture.",
								),
					),
				),
				h(
					"aside",
					{ class: "tks-rail" },
					railPart(t("Its one question"), talk.question),
					railPart(t("In it"), borders ? t(borders[0]) : talk.has),
					railPart(t("Never in it"), borders ? t(borders[1]) : talk.not),
					railPart(
						t("Why it asks"),
						t("The agent asks only what it did not find in the company’s vision or in what you have said."),
					),
				),
			),
		];
	}

	#player(shown: TalksShown, item: TalkItem): HTMLElement[] {
		const { talk } = item;
		const cover = surfaceTalkCover(talk);
		const art = h("div", { class: "tks-art is-still" }, cover ? this.#picture(shown, item, cover) : null);
		const big = h(
			"button",
			{ type: "button", class: "tks-big", "data-act": "talks-toggle", "aria-label": t("Play the talk") },
			h("span", null, "▶"),
		);
		const stage = h("div", { class: "tks-stage" }, art, big);
		const segments = h("div", { class: "tks-chsegs" });
		const progress = h("div", { class: "tks-scene" }, h("i"));
		const caption = h("p", { class: "tks-cap", "aria-live": "polite" });
		const marks = h("div", { class: "tks-from" });
		const time = h("span", { class: "tks-time" });
		const voiceButton = h("button", { type: "button", class: "tks-btn", "data-act": "talks-voice", hidden: true });
		const toggle = h("button", { type: "button", class: "tks-btn is-main", "data-act": "talks-toggle" });
		const note = h("p", { class: "tks-voicenote" });
		const next = h("div", { class: "tks-next", hidden: true });
		const board = h("div", { class: "tks-board" });
		const chapters = h(
			"nav",
			{ class: "tks-chlist" },
			talk.chapters.map((chapter, at) =>
				h(
					"button",
					{ type: "button", "data-act": "talks-chapter", "data-chapter": String(at) },
					h("i", null, two(at + 1)),
					h("span", null, chapter.title),
					h("em", null, clock(chapterSeconds(item, at, this.#voice))),
				),
			),
		);
		const main = h(
			"div",
			{ class: "tks-main" },
			stage,
			segments,
			progress,
			h(
				"div",
				{ class: "tks-under" },
				h("div", null, caption, marks),
				h(
					"div",
					{ class: "tks-ctl" },
					time,
					voiceButton,
					h(
						"button",
						{
							type: "button",
							class: "tks-btn",
							"data-act": "talks-step",
							"data-step": "-1",
							"aria-label": t("Previous picture"),
						},
						"←",
					),
					toggle,
					h(
						"button",
						{
							type: "button",
							class: "tks-btn",
							"data-act": "talks-step",
							"data-step": "1",
							"aria-label": t("Next picture"),
						},
						"→",
					),
				),
			),
			note,
			next,
			board,
		);
		this.#playing = {
			item,
			main,
			stage,
			art,
			big,
			segments,
			progress,
			caption,
			marks,
			time,
			voiceButton,
			toggle,
			note,
			next,
			board,
			chapters,
			urls: new Map(),
			index: 0,
			chapter: -1,
			on: false,
			paused: false,
			touched: false,
			left: 0,
			armedAt: 0,
			turn: 0,
			timer: undefined,
			audio: null,
		};
		this.#voiceUi();
		this.#set(0, false);
		this.#label();
		return [
			...this.#head(
				shown,
				item,
				[
					minutesLabel(talkSeconds(item)),
					...(item.voiced ? [t("with voice")] : []),
					countLabel(talk.chapters.length, t("1 chapter"), t("{count} chapters")),
					countLabel(item.flat.length, t("1 picture"), t("{count} pictures")),
				],
				talk.sub,
			),
			h(
				"div",
				{ class: "tks-play" },
				main,
				h(
					"aside",
					{ class: "tks-rail" },
					h("div", null, h("h4", null, t("Chapters")), chapters),
					h(
						"div",
						null,
						h("h4", null, t("Why this length")),
						h("p", { class: "tks-why" }, talk.whyThisLength ?? ""),
					),
					h(
						"div",
						null,
						h("h4", null, t("What it rests on")),
						footBar(item.footing),
						h(
							"div",
							{ class: "tks-footlist" },
							SURFACE_TALK_FOOTINGS.flatMap((name) =>
								item.footing[name] > 0
									? [h("span", null, t(FOOTING_WORDS[name]), h("b", null, String(item.footing[name])))]
									: [],
							),
						),
					),
				),
			),
		];
	}

	#mark(shown: TalksShown, source: SurfaceTalkSource): HTMLElement {
		if (source.kind === "yours") return h("span", { class: "is-plain" }, t("Your own words"));
		if (source.kind === "plan") return h("span", { class: "is-plain" }, t("The plan"));
		if (source.kind === "bet") return h("span", { class: "is-plain" }, t("Bet · {claim}", { claim: source.claim }));
		if (source.kind === "unchecked")
			return h("span", { class: "is-loose" }, t("{what} · no post has checked this", { what: source.what }));
		const path = shown.ctx.companyPath(source.path);
		const post = path ? this.#options.post(path, shown.ctx) : undefined;
		if (!path || !post) return h("span", { class: "is-plain" }, t("A research post"));
		return h(
			"button",
			{ type: "button", "data-act": "talks-post", "data-path": path },
			`${t("Post {n}", { n: post.number })} · ${post.title} →`,
		);
	}

	#useVoice(playing: Playing): boolean {
		return this.#voice && playing.item.voiced;
	}

	#ms(playing: Playing, at: number): number {
		return Math.round(pictureSeconds(playing.item, at, this.#voice) * 1000);
	}

	#set(at: number, move: boolean): void {
		const playing = this.#playing;
		const shown = this.#shown;
		const flat = playing?.item.flat[at];
		if (!playing || !shown || !flat) return;
		const { item } = playing;
		playing.index = at;
		const before = item.flat.slice(0, at).reduce((sum, _entry, index) => sum + this.#ms(playing, index), 0);
		const total = item.flat.reduce((sum, _entry, index) => sum + this.#ms(playing, index), 0);
		playing.main.style.setProperty("--dur", `${this.#ms(playing, at)}ms`);
		playing.stage.style.backgroundColor = shown.tones[flat.picture.tone ?? item.talk.tone].f;
		playing.art.classList.toggle("is-still", !move);
		playing.art.replaceChildren(this.#picture(shown, item, flat.picture));
		playing.caption.textContent = flat.picture.say;
		playing.marks.replaceChildren(...flat.picture.from.map((source) => this.#mark(shown, source)));
		playing.progress.replaceChildren(h("i"));
		playing.time.textContent = `${clock(before / 1000)} / ${clock(total / 1000)}`;
		playing.segments.replaceChildren(
			...item.talk.chapters.map((chapter, index) => {
				const done = index < flat.chapter ? 1 : index > flat.chapter ? 0 : (flat.at + 1) / chapter.pictures.length;
				const fill = h("i");
				fill.style.width = `${(done * 100).toFixed(1)}%`;
				const segment = h(
					"button",
					{
						type: "button",
						class: "tks-chseg",
						"data-act": "talks-chapter",
						"data-chapter": String(index),
						"aria-label": t("Chapter {n}: {title}", { n: index + 1, title: chapter.title }),
					},
					h("span", null, fill),
				);
				segment.style.flexGrow = String(Math.max(1, Math.round(chapterSeconds(item, index, false))));
				return segment;
			}),
		);
		[...playing.chapters.children].forEach((button, index) => {
			button.classList.toggle("is-on", index === flat.chapter);
		});
		if (playing.chapter !== flat.chapter) {
			playing.chapter = flat.chapter;
			const first = at - flat.at;
			playing.board.replaceChildren(
				...(item.talk.chapters[flat.chapter]?.pictures ?? []).map((picture, index) =>
					h(
						"button",
						{ type: "button", class: "tks-thumb", "data-act": "talks-at", "data-at": String(first + index) },
						h("span", { class: "tks-thumb-art" }, this.#picture(shown, item, picture)),
						h(
							"span",
							{ class: "tks-thumb-label" },
							h("i", null, String(index + 1)),
							`${picture.say.split(/\s+/).slice(0, 6).join(" ")}…`,
						),
					),
				),
			);
		}
		for (const thumb of playing.board.children)
			thumb.classList.toggle("is-on", Number((thumb as HTMLElement).dataset.at) === at);
		if (at < item.flat.length - 1) {
			playing.next.hidden = true;
			return;
		}
		const made = shown.shelf.filter((entry) => entry.talk.state === "made");
		const following = made[made.indexOf(item) + 1];
		playing.next.hidden = false;
		playing.next.replaceChildren(
			...(following
				? [
						h("span", null, t("Next: talk {n}", { n: shown.shelf.indexOf(following) + 1 })),
						h(
							"button",
							{ type: "button", "data-act": "talks-open", "data-path": following.path },
							`${following.talk.title} →`,
						),
					]
				: [
						h("span", null, t("That was the last talk.")),
						h("button", { type: "button", "data-act": "talks-shelf" }, t("Back to the talks")),
					]),
		);
	}

	#label(): void {
		const playing = this.#playing;
		if (!playing) return;
		const last = playing.index === playing.item.flat.length - 1;
		playing.toggle.textContent =
			playing.on && !playing.paused ? `❚❚ ${t("Pause")}` : `▶ ${last && !playing.on ? t("Play again") : t("Play")}`;
		playing.big.hidden = playing.on || playing.touched;
	}

	#voiceUi(): void {
		const playing = this.#playing;
		if (!playing) return;
		playing.voiceButton.hidden = !playing.item.voiced;
		playing.voiceButton.textContent = this.#voice ? t("Voice on") : t("Voice off");
		playing.voiceButton.setAttribute("aria-pressed", String(this.#voice));
		playing.note.textContent = !playing.item.voiced
			? t("Captions only. This talk has no voice yet. Space plays and pauses, the arrow keys step.")
			: this.#voice
				? t("Spoken in your voice model. Captions stay on. Space plays and pauses, the arrow keys step.")
				: t("Voice is off, captions only. Space plays and pauses, the arrow keys step.");
		[...playing.chapters.children].forEach((button, at) => {
			const time = button.querySelector("em");
			if (time) time.textContent = clock(chapterSeconds(playing.item, at, this.#voice));
		});
	}

	#clear(playing: Playing): void {
		if (playing.timer) clearTimeout(playing.timer);
		playing.timer = undefined;
	}

	#arm(playing: Playing, ms: number): void {
		this.#clear(playing);
		playing.left = ms;
		playing.armedAt = Date.now();
		playing.timer = setTimeout(() => this.#advance(), ms);
	}

	#hush(playing: Playing): void {
		if (!playing.audio) return;
		playing.audio.onended = null;
		playing.audio.onplaying = null;
		playing.audio.pause();
	}

	#clipUrl(playing: Playing, clip: VoiceClipMeta, ref: StudioBinaryRef): Promise<string> {
		let url = playing.urls.get(clip.caption);
		if (!url) {
			url = this.#options
				.read(ref, this.#options.signal)
				.then((bytes) =>
					URL.createObjectURL(new Blob([bytes.slice()], { type: voiceClipMime(clip.file, ref.mediaType) })),
				);
			playing.urls.set(clip.caption, url);
		}
		return url;
	}

	#run(playing: Playing, at: number): void {
		const turn = ++playing.turn;
		const flat = playing.item.flat[at] as TalkFlat;
		const clip = this.#useVoice(playing) ? playing.item.clips.get(flat.hash) : undefined;
		const ref = clip ? this.#shown?.ctx.binary(`${playing.item.dir}/voice/${clip.file}`).value : undefined;
		const reading = Math.round(surfaceTalkPictureSeconds(flat.picture.say) * 1000);
		if (!clip || !ref || typeof Audio !== "function") {
			this.#arm(playing, this.#ms(playing, at));
			return;
		}
		const mine = () => this.#playing === playing && playing.turn === turn && playing.on && !playing.paused;
		this.#hush(playing);
		this.#arm(playing, VOICE_LOAD_MS + reading);
		this.#clipUrl(playing, clip, ref).then(
			(url) => {
				if (!mine()) return;
				const audio = playing.audio ?? new Audio();
				playing.audio = audio;
				audio.onplaying = () => {
					if (mine()) this.#arm(playing, this.#ms(playing, at) + VOICE_NET_MS);
				};
				audio.onended = () => {
					if (mine()) this.#arm(playing, GAP_SECONDS * 1000);
				};
				audio.src = url;
				audio.play().catch(() => {
					if (mine()) this.#arm(playing, reading);
				});
			},
			() => {
				playing.urls.delete(clip.caption);
				if (mine()) this.#arm(playing, reading);
			},
		);
	}

	#advance(): void {
		const playing = this.#playing;
		if (!playing) return;
		playing.timer = undefined;
		if (playing.index < playing.item.flat.length - 1) {
			this.#set(playing.index + 1, true);
			this.#run(playing, playing.index);
			return;
		}
		playing.on = false;
		playing.main.classList.remove("is-playing");
		this.#label();
	}

	#toggle(): void {
		const playing = this.#playing;
		if (!playing) return;
		if (!playing.on) {
			playing.touched = true;
			if (playing.index === playing.item.flat.length - 1) playing.index = 0;
			playing.on = true;
			playing.paused = false;
			playing.main.classList.add("is-playing");
			playing.main.classList.remove("is-paused");
			this.#set(playing.index, true);
			this.#run(playing, playing.index);
		} else if (playing.paused) {
			playing.paused = false;
			playing.main.classList.remove("is-paused");
			const audio = playing.audio;
			if (audio && this.#useVoice(playing) && audio.src && !audio.ended && audio.currentTime > 0) {
				const turn = playing.turn;
				audio.onended = () => {
					if (this.#playing === playing && playing.turn === turn && playing.on && !playing.paused)
						this.#arm(playing, GAP_SECONDS * 1000);
				};
				audio.play().catch(() => undefined);
				const rest = ((audio.duration || 0) - audio.currentTime + GAP_SECONDS) * 1000;
				this.#arm(playing, Math.max(500, rest + VOICE_NET_MS));
			} else if (this.#useVoice(playing)) this.#run(playing, playing.index);
			else this.#arm(playing, playing.left);
		} else {
			playing.paused = true;
			playing.left = Math.max(300, playing.left - (Date.now() - playing.armedAt));
			this.#clear(playing);
			playing.audio?.pause();
			playing.main.classList.add("is-paused");
		}
		this.#label();
	}

	#jump(at: number): void {
		const playing = this.#playing;
		if (!playing || !Number.isFinite(at)) return;
		const index = Math.max(0, Math.min(playing.item.flat.length - 1, Math.trunc(at)));
		playing.touched = true;
		playing.turn += 1;
		this.#hush(playing);
		this.#set(index, true);
		if (playing.on) {
			playing.paused = false;
			playing.main.classList.remove("is-paused");
			this.#run(playing, index);
		}
		this.#label();
	}

	#jumpChapter(chapter: number): void {
		const at = this.#playing?.item.flat.findIndex((flat) => flat.chapter === chapter) ?? -1;
		if (at >= 0) this.#jump(at);
	}

	#switchVoice(): void {
		const playing = this.#playing;
		if (!playing?.item.voiced) return;
		this.#voice = !this.#voice;
		this.#voiceUi();
		if (!this.#voice) this.#hush(playing);
		if (playing.on && !playing.paused) this.#jump(playing.index);
		else {
			playing.turn += 1;
			this.#hush(playing);
			this.#clear(playing);
			if (playing.on) playing.left = this.#ms(playing, playing.index);
			this.#set(playing.index, false);
		}
	}

	#stop(): void {
		const playing = this.#playing;
		if (!playing) return;
		this.#playing = null;
		playing.turn += 1;
		this.#clear(playing);
		this.#hush(playing);
		playing.audio?.removeAttribute("src");
		for (const url of playing.urls.values())
			url.then(
				(value) => URL.revokeObjectURL(value),
				() => undefined,
			);
		playing.urls.clear();
	}
}

export class SurfaceTalks {
	readonly #options: SurfaceTalksOptions;
	readonly #views = new Map<string, TalksView>();
	readonly #shelves = new WeakMap<SurfaceBlockContext, Map<string, readonly TalkItem[]>>();

	constructor(options: SurfaceTalksOptions) {
		this.#options = options;
	}

	#shelf(block: SurfaceTalksBlock, ctx: SurfaceBlockContext): readonly TalkItem[] {
		let known = this.#shelves.get(ctx);
		if (!known) {
			known = new Map();
			this.#shelves.set(ctx, known);
		}
		let shelf = known.get(block.match);
		if (!shelf) {
			shelf = readShelf(block, ctx);
			known.set(block.match, shelf);
		}
		return shelf;
	}

	claimed(block: SurfaceTalksBlock, ctx: SurfaceBlockContext): readonly string[] {
		const paths: string[] = [];
		for (const item of this.#shelf(block, ctx)) {
			paths.push(item.path);
			const voice = `${item.dir}/voice/`;
			for (const path of [...Object.keys(ctx.files), ...Object.keys(ctx.binaries)])
				if (path.startsWith(voice)) paths.push(path);
			for (const flat of item.flat) {
				const art = flat.picture.kind === "art" ? ctx.companyPath(flat.picture.src) : undefined;
				if (art) paths.push(art);
			}
		}
		return paths;
	}

	prepare(key: string, block: SurfaceTalksBlock, ctx: SurfaceBlockContext, alone: boolean): SurfaceBlockPrepared {
		const shelf = this.#shelf(block, ctx);
		if (shelf.length === 0 && !alone && !block.heading) return { filled: false, pieces: [] };
		const kicker = block.heading ? ctx.words(block.heading) : t("Talks");
		const main = ctx.colors?.light.main;
		const signature = [
			main,
			...shelf.flatMap((item) => {
				const text = ctx.text(item.path);
				const clips = ctx.text(`${item.dir}/voice/clips.json`);
				return [
					item.path,
					text.value,
					text.base,
					clips.value,
					String(item.voiced),
					...item.flat.flatMap((flat) => {
						if (flat.picture.kind !== "art") return [];
						const art = ctx.companyPath(flat.picture.src);
						return art ? [ctx.text(art).value, ctx.binary(art).value?.fileSha256] : [];
					}),
					...item.flat.flatMap((flat) =>
						flat.picture.from.flatMap((source) => {
							const path = source.kind === "post" ? ctx.companyPath(source.path) : undefined;
							const post = path ? this.#options.post(path, ctx) : undefined;
							return post ? [post.number, post.title] : [];
						}),
					),
				];
			}),
		];
		return {
			filled: shelf.length > 0,
			pieces: [
				{
					build: () => {
						let view = this.#views.get(key);
						if (!view) {
							view = new TalksView(this.#options);
							this.#views.set(key, view);
						}
						view.show({ shelf, ctx, kicker, tones: talkTones(main), signature });
						return view.el;
					},
				},
			],
		};
	}

	shown(keys: ReadonlySet<string>): void {
		for (const [key, view] of this.#views) if (!keys.has(key)) view.leave();
	}

	keep(keys: ReadonlySet<string>): void {
		for (const [key, view] of this.#views) {
			if (keys.has(key)) continue;
			view.deactivate();
			this.#views.delete(key);
		}
	}

	deactivate(): void {
		for (const view of this.#views.values()) view.deactivate();
	}
}
