// @vitest-environment jsdom
import {
	type StudioBinaryRef,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_STARTER_LAYOUTS,
	SURFACE_TALK_KINDS,
	SURFACE_TALK_STARTERS,
	SURFACE_TALK_TONES,
	type SurfaceSummary,
	surfaceColorContrast,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleTalk } from "../../contracts/test/surface-talk-example.ts";
import { talkTones } from "../src/app/views/surface-blocks/talk-pictures.ts";
import { TALK_BORDER_WORDS } from "../src/app/views/surface-blocks/talks.ts";
import { SurfaceLayoutView } from "../src/app/views/surface-layout-view.ts";
import { SurfaceStudioView } from "../src/app/views/surface-studio-view.ts";
import { captionHash } from "../src/app/views/surface-voice-clips.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fakeClient, storeWith, summary, workspace } from "./surface-fixtures.ts";

type Json = Record<string, unknown>;

const ROOT = "surfaces/strategy";
const FOUND = `${ROOT}/talks/what-we-found/talk.json`;
const WORKS = `${ROOT}/talks/why-it-can-work/talk.json`;
const VISIT = `${ROOT}/talks/how-a-visit-goes/talk.json`;
const EXISTS = `${ROOT}/talks/why-it-exists/talk.json`;
const RIDERS = `${ROOT}/research/riders.report.json`;
const VAN =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#143f35"/></svg>';

const KIND_MARK: Readonly<Record<(typeof SURFACE_TALK_KINDS)[number], string>> = {
	title: ".tkp-title",
	statement: ".tkp-text",
	quote: ".tkp-qtext",
	number: ".tkp-nrow",
	bars: ".tkp-bars .tkp-bar",
	split: ".tkp-spbar .tkp-sppart",
	ring: ".tkp-ring-arc",
	meter: ".tkp-mtrack .tkp-mgood",
	versus: ".tkp-vside.is-r",
	steps: ".tkp-stbox.is-later",
	marks: ".tkp-mrow .tkp-dot.is-part",
	matrix: ".tkp-xrow.is-us",
	open: ".tkp-oitem",
	timeline: ".tkp-tpoint",
	art: ".tkp-in.is-art img",
};

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function found(): Json {
	const talk = exampleTalk();
	for (const chapter of talk.chapters as { pictures: Json[] }[])
		for (const picture of chapter.pictures) if (picture.kind === "art") picture.src = "talks/what-we-found/van.svg";
	return talk;
}

function exists(): Json {
	return {
		starter: "exists",
		title: "Why Tinwhistle exists",
		sub: "The reason, in the founders' own words.",
		question: "Why does Tinwhistle exist?",
		answer: "Tinwhistle exists so that a bike with a fault is mended the evening you notice it.",
		points: [
			{ text: "A fault you know about stays on the bike for weeks.", from: "Your vision" },
			{ text: "The repair is short. Getting to it is what takes the time.", from: "Your vision" },
			{ text: "So the repair should come to you.", from: "Your words of 20 Nov" },
		],
		leftOut: [],
		agreed: "2026-11-20",
		tone: "deep",
		whyThisLength: "The founders' reason and nothing else.",
		listen: { day: "2026-11-21", heard: "It exists so a faulty bike is mended at once.", lines: 2, marked: 0 },
		chapters: [
			{
				title: "The reason",
				points: [0, 1, 2],
				pictures: [
					{
						kind: "title",
						kicker: "Why it exists",
						title: "Mended the same evening",
						say: "This talk gives the reason Tinwhistle exists, in the founders' own words. It is a short one.",
						from: ["yours"],
					},
					{
						kind: "marks",
						title: "A fault today means",
						items: [
							{ mark: "no", label: "A trip to the workshop" },
							{ mark: "no", label: "A week without the bike" },
						],
						say: "A fault means a trip and a week without the bike. So the repair should come to you.",
						from: ["yours"],
					},
				],
			},
		],
	};
}

const WAITING = {
	starter: "works",
	title: "Why it can work",
	question: "Why would this work as a business?",
	asks: ["Why do you believe riders will pay for a visit?", "What do you see that workshops do not?"],
	found: ["Who it is for: people who ride to work every day."],
	missing: "Why they would pay, and why us.",
};

const POINTS = {
	title: "How a visit goes",
	sub: "From the booking to the ride home.",
	question: "What happens when a rider books a visit?",
	has: "How a visit is booked and done",
	not: "Why the company exists",
	answer: "A rider picks an evening, the mechanic comes to the door, and the bike is ready the same night.",
	points: [
		{ text: "The rider picks an evening.", from: "The plan" },
		{ text: "The van carries the common parts.", from: "What we found" },
		{ text: "A second visit is free.", from: "Your words of 20 Nov" },
	],
	leftOut: [],
	asks: ["What should a second visit cost you?"],
};

const POST = {
	headline: "Two riders in three ride on with a known fault",
	subtitle: "Counted outside three stations.",
	date: "2026-11-18",
	question: "How many riders ride on with a fault they know about?",
	theme: "Riders",
	shortAnswer: ["Two riders in three ride on with a known fault. [1]"],
	sources: [
		{
			n: 1,
			title: "Street count",
			publisher: "Tinwhistle",
			url: "https://example.com/count",
			opened: "2026-11-18",
			backs: "41 of 60",
			kind: "Our own count",
			checked: "2026-11-19",
		},
	],
	method: ["Counted outside three stations."],
	notFound: [],
	sections: [{ heading: "What we saw", paragraphs: ["Most riders wait. [1]"] }],
};

function layout(): string {
	const own = structuredClone(SURFACE_STARTER_LAYOUTS.strategy) as unknown as { tabs: unknown[] };
	own.tabs.unshift({ id: "talks", title: "Talks", blocks: [{ type: "talks" }] });
	own.tabs.push({ id: "files", title: "Files", blocks: [{ type: "artifacts" }] });
	return JSON.stringify({ ...own, schema: SURFACE_LAYOUT_SCHEMA });
}

function pageFiles(talks: Readonly<Record<string, unknown>> = {}): Record<string, string> {
	return {
		[`${ROOT}/layout.json`]: layout(),
		[`${ROOT}/talks/what-we-found/van.svg`]: VAN,
		[RIDERS]: JSON.stringify(POST),
		...Object.fromEntries(Object.entries(talks).map(([path, talk]) => [path, JSON.stringify(talk)])),
	};
}

function strategy(): SurfaceSummary {
	return summary({
		id: "22222222-2222-4222-8222-222222222260",
		slug: "strategy",
		title: "Strategy",
		archetype: "studio",
		kind: "strategy",
		icon: "figure:lighthouse",
		sourceKind: "folder",
		repositoryKey: null,
		folderRoot: ROOT,
		siteSlug: null,
		previewMode: "studio_overlay",
		liveUrl: null,
	});
}

async function store(companyName = "Tinwhistle") {
	const surface = strategy();
	const made = storeWith(
		fakeClient({
			listSurfaces: vi.fn(async () => [surface]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface })),
		}),
		{ companyName },
	);
	await made.load();
	await made.openSurface(surface.slug);
	return { surface, store: made };
}

function reach(root: HTMLElement) {
	const find = <E extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<E>(selector);
	const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
	const texts = (selector: string) =>
		all(selector).map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim());
	const press = (selector: string) => {
		const target = find(selector);
		if (!target) throw new Error(`nothing matches ${selector}`);
		target.click();
	};
	return { find, all, texts, press };
}

async function open(baseFiles: Readonly<Record<string, string>>, companyName?: string) {
	const made = await store(companyName);
	const view = new SurfaceStudioView({
		store: made.store,
		surface: made.surface,
		signal: new AbortController().signal,
		baseFiles,
		timeSlice: false,
	});
	document.body.append(view.el);
	const page = reach(view.el);
	page.press('[data-act="studio-tab"][data-tab="talks"]');
	return { ...page, view };
}

const card = (path: string) => `.tks-card[data-path="${path}"]`;
const step = (by: number) => `[data-act="talks-step"][data-step="${by}"]`;

describe("The Talks tab's shelf", () => {
	it("draws an empty home before any talk exists", async () => {
		const page = await open(pageFiles());
		expect(page.texts(".studio-tab")[0]).toBe("Talks");
		expect(page.texts(".tks-kicker")).toEqual(["Talks"]);
		expect(page.texts(".studio-home-empty")).toEqual(["Talks live here."]);
		expect(page.all(".tks-card")).toEqual([]);
	});

	it("shows each talk in the starters' order, made or waiting, with what it rests on", async () => {
		const page = await open(pageFiles({ [FOUND]: found(), [WORKS]: WAITING, [VISIT]: POINTS, [EXISTS]: exists() }));
		expect(page.texts(".tks-state")).toEqual(["Tinwhistle in 4 talks. 2 are made. 2 wait for you."]);
		expect(page.texts(".tks-count")).toEqual(["2 made · 4 min · 19 pictures · every picture names what it rests on"]);
		expect(page.texts(".tks-name")).toEqual([
			"Why Tinwhistle exists",
			"Why it can work",
			"What we found",
			"How a visit goes",
		]);
		expect(page.texts(".tks-num")).toEqual([
			"01½ min · 1 chapter",
			"02waits for your words",
			"033 min · 3 chapters",
			"04points for your yes",
		]);
		expect(page.texts(`${card(WORKS)} .tks-wait`)).toEqual([
			"Why do you believe riders will pay for a visit?2 questions for you",
		]);
		expect(page.texts(`${card(VISIT)} .tks-wait small`)).toEqual(["3 points for your yes"]);
		expect(page.find(`${card(FOUND)} .tks-cover .tkp-nrow`)?.textContent).toBe("41");
		expect(page.all(`${card(FOUND)} .tks-foot i`).map((part) => [part.className, part.style.width])).toEqual([
			["is-research", "70.6%"],
			["is-bets", "5.9%"],
			["is-plan", "17.6%"],
			["is-unchecked", "5.9%"],
		]);
		expect(page.all(`${card(WORKS)} .tks-foot`)).toEqual([]);
		expect(page.texts(".tks-footkey span")).toEqual([
			"Each bar shows what the talk rests on:",
			"Research posts",
			"Bets",
			"The plan and your own words",
			"Figures no post has checked",
		]);
	});

	it("leaves out a talk that does not pass the check, and says the rest in Danish", async () => {
		const coded = found();
		((coded.chapters as { pictures: Json[] }[])[0]?.pictures[0] as Json).kicker = "Bet 3";
		setLanguagePreference("da");
		const page = await open(pageFiles({ [FOUND]: coded, [WORKS]: WAITING }), "");
		expect(page.texts(".tks-name")).toEqual(["Why it can work"]);
		expect(page.texts(".tks-state")).toEqual(["1 talk. 0 er lavet. 1 venter på dig."]);
		expect(page.texts(".tks-count")).toEqual(["0 lavet"]);
		expect(page.texts(".tks-num")).toEqual(["01venter på dine ord"]);
		expect(page.all(".tks-footkey")).toEqual([]);
	});

	it("keeps a talk's own files out of the files a page lists", async () => {
		const page = await open(
			pageFiles({
				[FOUND]: found(),
				[`${ROOT}/talks/what-we-found/voice/clips.json`]: { clips: [] },
				[`${ROOT}/notes/loose.json`]: { a: 1 },
			}),
		);
		page.press('[data-act="studio-tab"][data-tab="files"]');
		const listed = page.all("[data-file]").map((item) => item.dataset.file);
		expect(listed).toContain(`${ROOT}/notes/loose.json`);
		expect(listed.filter((path) => path?.includes("/talks/"))).toEqual([]);
	});
});

describe("The Talks tab's waiting states", () => {
	it("shows a talk that waits for the founder's words with its questions and its borders", async () => {
		const page = await open(pageFiles({ [WORKS]: WAITING, [FOUND]: found() }));
		page.press(card(WORKS));
		expect(page.find(".tks")?.dataset.at).toBe("ask");
		expect(page.texts(".tks-kick span")).toEqual(["Talk 1 of 2", "waits for your words", "2 questions"]);
		expect(page.texts(".tks-title")).toEqual(["Why it can work"]);
		expect(page.texts(".tks-ask")).toEqual([
			"1Why do you believe riders will pay for a visit?",
			"2What do you see that workshops do not?",
		]);
		expect(page.texts(".tks-h")).toEqual(["Found in the vision", "Not found there"]);
		expect(page.texts(".tks-found li")).toEqual([
			"Who it is for: people who ride to work every day.",
			"Why they would pay, and why us.",
		]);
		expect(page.texts(".tks-rail > div")).toEqual([
			"Its one questionWhy would this work as a business?",
			"In itThe few claims that must all hold, and what backs each",
			"Never in itThe steps of the plan, a catalogue of products",
			"Why it asksThe agent asks only what it did not find in the company’s vision or in what you have said.",
		]);
		expect(page.all(".tkp")).toEqual([]);
		page.press('[data-act="talks-shelf"]');
		expect(page.find(".tks")?.dataset.at).toBe("shelf");
	});

	it("shows a talk with points for the founder's yes, each point with where it comes from", async () => {
		const page = await open(pageFiles({ [VISIT]: POINTS }));
		page.press(card(VISIT));
		expect(page.texts(".tks-kick span")).toEqual(["Talk 1 of 1", "points for your yes", "no picture yet"]);
		expect(page.texts(".tks-answer")).toEqual([POINTS.answer]);
		expect(page.texts(".tks-points li")).toEqual([
			"The rider picks an evening.The plan",
			"The van carries the common parts.What we found",
			"A second visit is free.Your words of 20 Nov",
		]);
		expect(page.texts(".tks-h")).toEqual(["Still asked"]);
		expect(page.texts(".tks-ask.is-small")).toEqual(["1What should a second visit cost you?"]);
		expect(page.texts(".tks-rail > div").slice(1, 3)).toEqual([
			"In itHow a visit is booked and done",
			"Never in itWhy the company exists",
		]);
	});

	it("says each starter's borders in the words the checker holds", () => {
		for (const starter of SURFACE_TALK_STARTERS)
			expect(TALK_BORDER_WORDS[starter.id], starter.id).toEqual([starter.has, starter.not]);
	});
});

describe("The Talks tab's player", () => {
	it("opens a talk on its first picture, with its chapters, its length and what it rests on", async () => {
		const page = await open(pageFiles({ [FOUND]: found(), [EXISTS]: exists() }));
		page.press(card(FOUND));
		expect(page.find(".tks")?.dataset.at).toBe("talk");
		expect(page.texts(".tks-kick span")).toEqual(["Talk 2 of 2", "3 min", "3 chapters", "17 pictures"]);
		expect(page.texts(".tks-title")).toEqual(["What we found"]);
		expect(page.find(".tks-art")?.classList.contains("is-still")).toBe(true);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Repairs people put off"]);
		expect(page.texts(".tks-cap")[0]).toContain("This talk covers what we learned from sixty riders");
		expect(page.texts(".tks-time")).toEqual(["0:00 / 3:15"]);
		expect(page.texts(".tks-btn.is-main")).toEqual(["▶ Play"]);
		expect(page.find<HTMLButtonElement>('[data-act="talks-voice"]')?.hidden).toBe(true);
		expect(page.texts(".tks-voicenote")[0]).toContain("Captions only. This talk has no voice yet.");
		expect(page.texts(".tks-chlist button")).toEqual([
			"01Who needs a repair0:45",
			"02What a visit takes0:55",
			"03What it would take1:35",
		]);
		expect(page.texts(".tks-rail > div")[1]).toBe(
			"Why this lengthThree findings, each with the pictures that show it.",
		);
		expect(page.texts(".tks-footlist span")).toEqual([
			"Research posts12",
			"Bets1",
			"The plan and your own words3",
			"Figures no post has checked1",
		]);
		expect(page.all(".tks-thumb")).toHaveLength(4);
		expect(page.all(".tks-thumb.is-on")).toHaveLength(1);
		expect(page.find(".tks-next")?.hidden).toBe(true);
	});

	it("draws every kind of picture, and names what each rests on", async () => {
		const page = await open(pageFiles({ [FOUND]: found() }));
		page.press(card(FOUND));
		const kinds = (found().chapters as { pictures: { kind: (typeof SURFACE_TALK_KINDS)[number] }[] }[]).flatMap(
			(chapter) => chapter.pictures.map((picture) => picture.kind),
		);
		expect(new Set(kinds)).toEqual(new Set(SURFACE_TALK_KINDS));
		const marks: string[][] = [];
		for (const [at, kind] of kinds.entries()) {
			if (at > 0) page.press(step(1));
			expect(page.find(`.tks-art ${KIND_MARK[kind]}`), `${at + 1}: ${kind}`).not.toBeNull();
			marks.push(page.texts(".tks-from > *"));
		}
		expect(marks[0]).toEqual(["Post 001 · Two riders in three ride on with a known fault →"]);
		expect(marks[4]).toEqual(["A research post"]);
		expect(marks[7]).toEqual(["A research post", "The plan"]);
		expect(marks[13]).toEqual(["Bet · Most repairs finish on the first visit"]);
		expect(marks[15]).toEqual(["Your own words"]);
		expect(marks[16]).toEqual(["Winter bookings from a trade magazine · no post has checked this"]);
		expect(page.find(".tks-from .is-loose")).not.toBeNull();
		expect(page.find<HTMLImageElement>(".tks-art .tkp-in.is-art img")).toBeNull();
		page.press(step(-1));
		expect(page.find<HTMLImageElement>(".tks-art .tkp-in.is-art img")?.alt).toBe(
			"A small repair van with its side door open",
		);
		const inner = page.find(".tks-art .tkp-in");
		for (const name of ["f", "a", "b", "t", "m", "oa", "ob"])
			expect(inner?.style.getPropertyValue(`--${name}`), name).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("plays picture by picture at reading pace, holds on pause, and hands over at the end", async () => {
		vi.useFakeTimers();
		const page = await open(pageFiles({ [EXISTS]: exists(), [FOUND]: found() }));
		page.press(card(EXISTS));
		expect(page.texts(".tks-time")).toEqual(["0:00 / 0:19"]);
		page.press(".tks-big");
		expect(page.texts(".tks-btn.is-main")).toEqual(["❚❚ Pause"]);
		expect(page.find(".tks-main")?.classList.contains("is-playing")).toBe(true);
		expect(page.find(".tks-big")?.hidden).toBe(true);
		expect(page.find(".tks-art")?.classList.contains("is-still")).toBe(false);
		await vi.advanceTimersByTimeAsync(9000);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Mended the same evening"]);

		page.press(".tks-btn.is-main");
		expect(page.find(".tks-main")?.classList.contains("is-paused")).toBe(true);
		await vi.advanceTimersByTimeAsync(60000);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Mended the same evening"]);

		page.press(".tks-btn.is-main");
		await vi.advanceTimersByTimeAsync(700);
		expect(page.texts(".tks-art .tkp-btitle")).toEqual(["A fault today means"]);
		expect(page.texts(".tks-time")).toEqual(["0:09 / 0:19"]);
		expect(page.texts(".tks-next")).toEqual(["Next: talk 2What we found →"]);

		await vi.advanceTimersByTimeAsync(10000);
		expect(page.texts(".tks-btn.is-main")).toEqual(["▶ Play again"]);
		expect(page.find(".tks-main")?.classList.contains("is-playing")).toBe(false);

		page.press(".tks-next button");
		expect(page.texts(".tks-title")).toEqual(["What we found"]);
		page.press('.tks-chlist [data-chapter="2"]');
		expect(page.texts(".tks-art .tkp-title")).toEqual(["What a van must carry"]);
		expect(page.texts(".tks-chlist button.is-on")).toEqual(["03What it would take1:35"]);
		expect(page.all(".tks-thumb")).toHaveLength(8);
		page.press('.tks-thumb[data-at="16"]');
		expect(page.texts(".tks-next")).toEqual(["That was the last talk.Back to the talks"]);
		page.press(".tks-next button");
		expect(page.find(".tks")?.dataset.at).toBe("shelf");
	});

	it("steps with the arrow keys and plays with space, but not while the founder types", async () => {
		const page = await open(pageFiles({ [FOUND]: found() }));
		page.press(card(FOUND));
		const key = (name: string, target: EventTarget = window) =>
			target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
		key("ArrowRight");
		expect(page.find(".tks-art .tkp-nrow")).not.toBeNull();
		key("ArrowLeft");
		expect(page.find(".tks-art .tkp-title")).not.toBeNull();
		key(" ");
		expect(page.texts(".tks-btn.is-main")).toEqual(["❚❚ Pause"]);
		key(" ");
		expect(page.texts(".tks-btn.is-main")).toEqual(["▶ Play"]);
		const box = document.createElement("textarea");
		document.body.append(box);
		key("ArrowRight", box);
		key(" ", box);
		expect(page.find(".tks-art .tkp-title")).not.toBeNull();
		expect(page.texts(".tks-btn.is-main")).toEqual(["▶ Play"]);
	});

	it("opens the post a picture rests on, in the Research tab", async () => {
		const page = await open(pageFiles({ [FOUND]: found() }));
		page.press(card(FOUND));
		page.press(".tks-from button");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(page.texts(".studio-tab.is-on")).toEqual(["Research"]);
		expect(page.texts(".po-title")).toEqual(["Two riders in three ride on with a known fault"]);
		expect(page.find(".tks")).toBeNull();
	});
});

describe("A talk's voice", () => {
	class FakeAudio {
		static made: FakeAudio[] = [];
		src = "";
		currentTime = 0;
		duration = 6;
		ended = false;
		paused = true;
		onended: (() => void) | null = null;
		onplaying: (() => void) | null = null;
		constructor() {
			FakeAudio.made.push(this);
		}
		play(): Promise<void> {
			this.paused = false;
			this.ended = false;
			this.currentTime = 0.1;
			this.onplaying?.();
			return Promise.resolve();
		}
		pause(): void {
			this.paused = true;
		}
		removeAttribute(): void {
			this.src = "";
		}
		finish(): void {
			this.ended = true;
			this.paused = true;
			this.onended?.();
		}
	}

	async function voiced() {
		FakeAudio.made = [];
		vi.stubGlobal("Audio", FakeAudio);
		Object.assign(URL, { createObjectURL: vi.fn(() => "blob:clip"), revokeObjectURL: vi.fn() });
		const talk = exists();
		const lines = (talk.chapters as { pictures: { say: string }[] }[]).flatMap((chapter) =>
			chapter.pictures.map((picture) => picture.say),
		);
		const clips = lines.map((line) => ({ caption: captionHash(line), file: `${captionHash(line)}.m4a`, seconds: 6 }));
		const files = {
			...pageFiles({ [EXISTS]: talk }),
			[`${ROOT}/talks/why-it-exists/voice/clips.json`]: JSON.stringify({ clips }),
		};
		const binaries: Record<string, StudioBinaryRef> = Object.fromEntries(
			clips.map((clip, at) => [
				`${ROOT}/talks/why-it-exists/voice/${clip.file}`,
				{ manifestSha256: "a".repeat(64), fileSha256: String(at).repeat(64), bytes: 4, mediaType: "audio/mp4" },
			]),
		);
		const made = await store();
		const readBinary = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
		const view = new SurfaceLayoutView({
			store: made.store,
			surface: made.surface,
			signal: new AbortController().signal,
			baseFiles: () => files,
			timeSlice: false,
			readBinary,
		});
		const draw = (tab: string) => {
			const plan = view.plan({
				surface: made.surface,
				files,
				baseFiles: files,
				binaries,
				baseBinaries: binaries,
				company: undefined,
				briefSummary: "",
				starter: "strategy",
				tab,
				legacyModel: undefined,
				htmlPages: { frame: () => document.createElement("div"), linksChanged: () => false },
			});
			document.body.replaceChildren(...plan.tasks.map((task) => task.build()));
		};
		draw("talks");
		return { ...reach(document.body), readBinary, draw };
	}

	it("shows on the shelf and in the player, with the talk timed by its clips", async () => {
		const page = await voiced();
		expect(page.texts(".tks-num")).toEqual(["01½ min · 1 chapter · with voice"]);
		page.press(".tks-card");
		expect(page.texts(".tks-kick span")).toEqual(["Talk 1 of 1", "½ min", "with voice", "1 chapter", "2 pictures"]);
		expect(page.texts(".tks-time")).toEqual(["0:00 / 0:14"]);
		const button = page.find<HTMLButtonElement>('[data-act="talks-voice"]');
		expect(button?.hidden).toBe(false);
		expect(button?.textContent).toBe("Voice on");
		expect(page.texts(".tks-voicenote")[0]).toContain("Spoken in your voice model. Captions stay on.");
	});

	it("waits for a sentence to end before the next picture, and holds the voice on pause", async () => {
		vi.useFakeTimers();
		const page = await voiced();
		page.press(".tks-card");
		page.press(".tks-btn.is-main");
		await vi.advanceTimersByTimeAsync(0);
		expect(page.readBinary).toHaveBeenCalledTimes(1);
		const audio = FakeAudio.made[0] as FakeAudio;
		expect(audio.paused).toBe(false);
		expect(audio.src).toBe("blob:clip");

		await vi.advanceTimersByTimeAsync(9000);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Mended the same evening"]);

		page.press(".tks-btn.is-main");
		expect(audio.paused).toBe(true);
		await vi.advanceTimersByTimeAsync(60000);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Mended the same evening"]);
		page.press(".tks-btn.is-main");
		expect(audio.paused).toBe(false);

		audio.finish();
		await vi.advanceTimersByTimeAsync(1100);
		expect(page.texts(".tks-art .tkp-title")).toEqual(["Mended the same evening"]);
		await vi.advanceTimersByTimeAsync(200);
		expect(page.texts(".tks-art .tkp-btitle")).toEqual(["A fault today means"]);
		expect(page.readBinary).toHaveBeenCalledTimes(2);
	});

	it("switches to captions only, and stops the sound when the founder leaves the tab", async () => {
		vi.useFakeTimers();
		const page = await voiced();
		page.press(".tks-card");
		page.press(".tks-btn.is-main");
		await vi.advanceTimersByTimeAsync(0);
		const audio = FakeAudio.made[0] as FakeAudio;
		page.press('[data-act="talks-voice"]');
		expect(page.texts('[data-act="talks-voice"]')).toEqual(["Voice off"]);
		expect(audio.paused).toBe(true);
		expect(page.texts(".tks-time")).toEqual(["0:00 / 0:19"]);
		expect(page.texts(".tks-voicenote")[0]).toContain("Voice is off, captions only.");
		await vi.advanceTimersByTimeAsync(10000);
		expect(page.texts(".tks-art .tkp-btitle")).toEqual(["A fault today means"]);
		expect(audio.paused).toBe(true);

		page.press('[data-act="talks-voice"]');
		await vi.advanceTimersByTimeAsync(0);
		expect(audio.paused).toBe(false);
		page.draw("research");
		expect(audio.paused).toBe(true);
	});
});

describe("A talk's colours", () => {
	it("come from the company's own colour and stay readable, whatever it is", () => {
		for (const main of ["#57398c", "#f2c230", "#111111", "#ffffff", "#1f6f5c", undefined]) {
			const tones = talkTones(main);
			for (const name of SURFACE_TALK_TONES) {
				const tone = tones[name];
				expect(surfaceColorContrast(tone.t, tone.f), `${main} ${name} text`).toBeGreaterThanOrEqual(4.5);
				expect(surfaceColorContrast(tone.a, tone.f), `${main} ${name} shape`).toBeGreaterThanOrEqual(3);
				expect(surfaceColorContrast(tone.oa, tone.a), `${main} ${name} on shape`).toBeGreaterThanOrEqual(3);
			}
		}
		expect(talkTones("#57398c").brand.f).toBe("#57398c");
		expect(talkTones("#57398c").tint.a).toBe("#57398c");
	});
});
