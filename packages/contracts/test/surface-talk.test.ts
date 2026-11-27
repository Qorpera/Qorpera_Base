import { describe, expect, it } from "vitest";
import {
	describeSurfaceBlocks,
	describeSurfaceFormats,
	parseSurfaceLayout,
	readSurfaceTalk,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_TALK_FORMAT,
	SURFACE_TALK_KINDS,
	SURFACE_TALK_STARTER_IDS,
	SURFACE_TALK_STARTERS,
	SURFACE_TALK_TONES,
	SURFACE_TALKS_DEFAULT_MATCH,
	surfaceTalkCover,
	surfaceTalkFooting,
	surfaceTalkPictureSeconds,
	surfaceTalkPosts,
	surfaceTalkSeconds,
	surfaceTalkSpokenLines,
} from "../src/index.ts";
import { exampleTalk, type Json } from "./surface-talk-example.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
function pictureOf(talk: Json, chapter: number, picture: number): Json {
	return ((talk.chapters as Json[])[chapter]?.pictures as Json[])[picture] as Json;
}

function whyItExists(pictures: readonly Json[] = []): Json {
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
		leftOut: [{ what: "Prices, rivals and the first steps", goesTo: "Their own talks" }],
		agreed: "2026-11-20",
		tone: "deep",
		whyThisLength: "The founders' reason and nothing else.",
		listen: {
			day: "2026-11-21",
			heard: "It exists so a faulty bike is mended the evening you notice.",
			lines: 4,
			marked: 0,
		},
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
						title: "Today a fault means",
						items: [
							{ mark: "no", label: "A trip to the workshop" },
							{ mark: "no", label: "A week without the bike" },
						],
						say: "Today a fault means a trip to a workshop and a week without the bike. So people ride on with it.",
						from: ["yours"],
					},
					...pictures,
				],
			},
		],
	};
}

function problemsOf(talk: Json, rivals?: readonly string[]): readonly string[] {
	return readSurfaceTalk(talk, { now: NOW, ...(rivals ? { rivals } : {}) }).problems;
}

describe("a talk file", () => {
	it("reads a made talk that uses every kind of picture", () => {
		const read = readSurfaceTalk(exampleTalk(), { now: NOW });
		expect(read.problems).toEqual([]);
		const talk = read.talk;
		if (!talk) throw new Error("the example talk did not read");
		expect(talk.state).toBe("made");
		expect(talk.has).toBe(SURFACE_TALK_STARTERS.find((starter) => starter.id === "found")?.has);
		const pictures = talk.chapters.flatMap((chapter) => chapter.pictures);
		expect(pictures).toHaveLength(17);
		expect(new Set(pictures.map((picture) => picture.kind))).toEqual(new Set(SURFACE_TALK_KINDS));
		expect(surfaceTalkSpokenLines(talk)).toHaveLength(17);
		expect(surfaceTalkSeconds(talk)).toBeCloseTo(
			pictures.reduce((sum, picture) => sum + surfaceTalkPictureSeconds(picture.say), 0),
			6,
		);
		expect(surfaceTalkSeconds(talk)).toBeGreaterThan(170);
		expect(surfaceTalkSeconds(talk)).toBeLessThan(200);
		expect(surfaceTalkFooting(talk)).toEqual({ research: 12, bets: 1, plan: 3, unchecked: 1 });
		expect(surfaceTalkCover(talk)?.kind).toBe("number");
		expect(surfaceTalkPosts(talk)).toEqual(["research/riders.report.json", "research/repairs.report.json"]);
		expect(pictures[7]?.from).toEqual([{ kind: "post", path: "research/repairs.report.json" }, { kind: "plan" }]);
		expect(pictures[13]?.from).toEqual([{ kind: "bet", claim: "Most repairs finish on the first visit" }]);
	});

	it("times a picture by its spoken words, never under seven seconds", () => {
		expect(surfaceTalkPictureSeconds("Five short words are here.")).toBe(7);
		expect(surfaceTalkPictureSeconds(Array.from({ length: 45 }, () => "word").join(" "))).toBeCloseTo(20.6, 6);
	});

	it("names its cover by number, and falls back to the first drawn picture", () => {
		const talk = exampleTalk();
		talk.cover = 15;
		expect(surfaceTalkCover(readSurfaceTalk(talk, { now: NOW }).talk as never)?.kind).toBe("quote");
		talk.cover = 18;
		expect(problemsOf(talk)).toEqual(['talk: "cover" must be the number of a picture, 1 to 17']);
	});

	it("is in one of three states by what it holds", () => {
		const waiting = {
			starter: "works",
			title: "Why it can work",
			question: "Why would this work as a business?",
			asks: ["Why do you believe riders will pay for a visit?", "What do you see that workshops do not?"],
			found: ["Who it is for: people who ride to work every day."],
			missing: "Why they would pay, and why us.",
		};
		const asked = readSurfaceTalk(waiting, { now: NOW });
		expect(asked.problems).toEqual([]);
		expect(asked.talk).toMatchObject({ state: "asks", tone: "paper", points: [], chapters: [] });
		expect(asked.talk?.asks).toHaveLength(2);

		const { chapters: _chapters, listen: _listen, agreed: _agreed, ...pointed } = exampleTalk();
		const points = readSurfaceTalk(
			{ ...pointed, asks: ["What would you show someone after a month?"] },
			{ now: NOW },
		);
		expect(points.problems).toEqual([]);
		expect(points.talk).toMatchObject({ state: "points", chapters: [] });
		expect(points.talk?.points).toHaveLength(3);

		expect(problemsOf({ ...waiting, asks: [] })).toEqual(['talk: "asks" has 0 entries, must be 1 to 3']);
		expect(problemsOf({ ...waiting, asks: ["Tell me why."] })).toEqual([
			"talk: asks[0] must be an open question ending in ?",
		]);
	});

	it("needs the founder's yes and a cold listen before it holds pictures", () => {
		const unagreed = exampleTalk();
		delete unagreed.agreed;
		expect(problemsOf(unagreed)).toEqual([
			'talk: a talk with pictures needs "agreed": the day the founder said yes to its points. Show the points first and wait for that yes',
		]);

		const unheard = exampleTalk();
		delete unheard.listen;
		expect(problemsOf(unheard)[0]).toContain('a talk with pictures needs "listen"');

		const marked = exampleTalk();
		(marked.listen as Json).marked = 2;
		expect(problemsOf(marked)).toEqual([
			"listen: 2 of 17 lines were marked, more than one in ten: fix what was marked and listen again with a fresh listener",
		]);

		const grown = exampleTalk();
		(grown.listen as Json).lines = 15;
		expect(problemsOf(grown)).toEqual([
			"listen: the cold listen heard 15 lines and the talk now speaks 17; a line added since was never heard, so listen again with a fresh listener",
		]);
		const cut = exampleTalk();
		Object.assign(cut.listen as Json, { lines: 20, marked: 2 });
		expect(problemsOf(cut)).toEqual([]);

		const early = exampleTalk();
		(early.listen as Json).day = "2026-11-19";
		expect(problemsOf(early)).toEqual(["listen: the cold listen is dated before the founder's yes to the points"]);

		const tomorrow = exampleTalk();
		tomorrow.agreed = "2026-12-24";
		expect(problemsOf(tomorrow)[0]).toBe('talk: "agreed" is a day that has not come yet');

		const asking = exampleTalk();
		asking.asks = ["What would you show someone after a month?"];
		expect(problemsOf(asking)[0]).toContain('a talk with pictures holds no "asks"');
	});
});

describe("the talk checker", () => {
	it("refuses a code number, shown or spoken", () => {
		const spoken = exampleTalk();
		pictureOf(spoken, 0, 1).say =
			"We asked sixty riders outside three stations, and B3 says forty-one of them ride a bike with a known fault.";
		expect(problemsOf(spoken)).toEqual([
			'chapter 1 picture 2: a code number is shown or spoken ("B3"); say the thing itself',
		]);

		const numbered = exampleTalk();
		pictureOf(numbered, 2, 4).title = "Bet 3: done on the first visit";
		expect(problemsOf(numbered)).toEqual([
			'chapter 3 picture 5: a code number is shown or spoken ("Bet 3"); say the thing itself',
		]);

		const marked = exampleTalk();
		pictureOf(marked, 2, 4).from = ["bet:H12 first visit"];
		expect(problemsOf(marked)[0]).toContain('a code number is shown or spoken ("H12")');

		const post = exampleTalk();
		pictureOf(post, 0, 3).sub = "See post 6 for the count";
		expect(problemsOf(post)[0]).toContain('("post 6")');

		const path = exampleTalk();
		pictureOf(path, 0, 0).from = ["post:research/R2-riders.report.json"];
		expect(problemsOf(path)).toEqual([]);
	});

	it("refuses a page or tab name and a phrase like the Strategy says", () => {
		for (const [say, found] of [
			[
				"The Strategy says most riders wait because they have no time, and distance comes a clear second.",
				"The Strategy",
			],
			["On the Market tab you can see that most riders wait because they have no time at all.", "tab"],
			["The research post on riders shows that most of them wait because they have no time.", "research post"],
			[
				"This interface shows that most riders wait because they have no time for the workshop at all.",
				"This interface",
			],
		] as const) {
			const talk = exampleTalk();
			pictureOf(talk, 0, 2).say = say;
			expect(problemsOf(talk), say).toEqual([
				`chapter 1 picture 3: a page or tab name is shown or spoken ("${found}"); say the thing itself`,
			]);
		}
	});

	it("holds chapter titles, the question and what the founder is asked to the same words", () => {
		const titled = exampleTalk();
		((titled.chapters as Json[])[1] as Json).title = "Bet 3 holds";
		expect(problemsOf(titled)).toEqual([
			'chapter 2: a code number is shown or spoken ("Bet 3"); say the thing itself',
		]);

		const bordered = whyItExists();
		((bordered.chapters as Json[])[0] as Json).title = "Cheaper than Velo Fix";
		expect(problemsOf(bordered, ["Velo Fix"])).toEqual([
			'chapter 1: outside this talk\'s borders: prices or money ("Cheaper") never belongs in "Why it exists"',
			'chapter 1: outside this talk\'s borders: a rival the page names ("Velo Fix") never belongs in "Why it exists"; a word that is the founders\' own and not the rival goes in "ownWords"',
		]);

		const asked = {
			starter: "exists",
			title: "Why Tinwhistle exists",
			question: "Why does Tinwhistle exist?",
			asks: ["What did you see on the Market tab that made you start?"],
			found: ["B3 says riders wait."],
			missing: "What a visit should cost in kroner.",
		};
		expect(problemsOf(asked)).toEqual([
			'talk: a page or tab name is shown or spoken ("tab"); say the thing itself',
			'talk: a code number is shown or spoken ("B3"); say the thing itself',
		]);
		expect(problemsOf({ ...asked, asks: ["Why did you start?"], found: [] })).toEqual([]);
	});

	it("lets a quarter or a half-year through, which is not a code", () => {
		const dated = exampleTalk();
		pictureOf(dated, 1, 1).items = [
			{ when: "Q3 2027", label: "Bike handed in" },
			{ when: "H1 2028", label: "Parts arrive" },
			{ when: "Q4", label: "Bike collected" },
		];
		expect(problemsOf(dated)).toEqual([]);
		pictureOf(dated, 1, 1).items = [
			{ when: "H1", label: "Bike handed in" },
			{ when: "Later", label: "Bike collected" },
		];
		expect(problemsOf(dated)).toEqual([
			'chapter 2 picture 2: a code number is shown or spoken ("H1"); say the thing itself',
		]);
	});

	it("refuses more than one statement picture in five", () => {
		const talk = exampleTalk();
		for (const at of [1, 2, 3]) {
			const picture = pictureOf(talk, 0, at);
			for (const key of Object.keys(picture)) if (!["say", "from"].includes(key)) delete picture[key];
			Object.assign(picture, { kind: "statement", text: "Riders wait." });
		}
		expect(problemsOf(talk)).toEqual([
			"talk: 4 of 17 pictures are statements; at most one in five, the rest draw a shape",
		]);
	});

	it("refuses a talk over fifteen minutes, and sets no shortest length", () => {
		const long = Array.from({ length: 45 }, () => "word").join(" ");
		const talk = exampleTalk();
		const title = pictureOf(talk, 0, 0);
		const number = pictureOf(talk, 0, 1);
		talk.chapters = Array.from({ length: 6 }, (_, chapter) => ({
			title: `Part ${["one", "two", "three", "four", "five", "six"][chapter]}`,
			points: [chapter % 3],
			pictures: [{ ...title, say: long }, ...Array.from({ length: 7 }, () => ({ ...number, say: long }))],
		}));
		(talk.listen as Json).lines = 48;
		expect(problemsOf(talk)).toEqual(["talk: runs 16.5 minutes, at most 15; past that it is two talks"]);

		expect(problemsOf(whyItExists())).toEqual([]);
		expect(surfaceTalkSeconds(readSurfaceTalk(whyItExists(), { now: NOW }).talk as never)).toBeLessThan(25);
	});

	it("keeps the talk on why the company exists free of prices, rivals, plan steps and tests", () => {
		const base = { from: ["yours"] };
		const price = {
			...base,
			kind: "number",
			value: "349",
			unit: "kr",
			label: "for a visit at your door",
			say: "A visit at your door costs three hundred and forty-nine kroner, which is less than most workshops ask.",
		};
		expect(problemsOf(whyItExists([price]))).toEqual([
			'chapter 1 picture 3: outside this talk\'s borders: prices or money ("kr") never belongs in "Why it exists"',
		]);

		const cheaper = {
			...base,
			kind: "statement",
			text: "Cheaper than a workshop.",
			say: "And it is cheaper than a workshop, because nobody pays for a shop on a busy street.",
		};
		expect(problemsOf(whyItExists([cheaper]))[0]).toContain('prices or money ("Cheaper")');

		const rival = {
			...base,
			kind: "versus",
			left: { title: "Velo Fix", lines: ["Workshops in four towns"] },
			right: { title: "Tinwhistle", lines: ["Comes to your door"] },
			say: "Another company has workshops in four towns. We have none, because we come to the door instead.",
		};
		expect(problemsOf(whyItExists([rival]))).toEqual([]);
		expect(problemsOf(whyItExists([rival]), ["Velo Fix", "Spokesmen"])).toEqual([
			'chapter 1 picture 3: outside this talk\'s borders: a rival the page names ("Velo Fix") never belongs in "Why it exists"; a word that is the founders\' own and not the rival goes in "ownWords"',
		]);

		const calm = {
			...base,
			kind: "quote",
			text: "Calm on the ride to work.",
			by: "A founder",
			say: "What it is for in the end is more calm on the ride to work, every single day.",
		};
		expect(problemsOf(whyItExists([{ ...calm, text: "More calm on the ride to work." }]), ["Calm"])).toEqual([]);
		expect(problemsOf(whyItExists([calm]), ["Calm"])[0]).toContain('a rival the page names ("Calm")');
		expect(problemsOf({ ...whyItExists([calm]), ownWords: ["Calm"] }, ["Calm", "Velo Fix"])).toEqual([]);
		expect(problemsOf({ ...whyItExists([rival]), ownWords: ["Calm"] }, ["Calm", "Velo Fix"])[0]).toContain(
			'("Velo Fix")',
		);

		const step = {
			...base,
			kind: "steps",
			items: [
				{ title: "Step 1", lines: ["One van"], state: "now" },
				{ title: "Later", lines: ["Three vans"], state: "later" },
			],
			say: "We begin with one van in one town and see how it goes, and three vans come after that.",
		};
		expect(problemsOf(whyItExists([step]))[0]).toContain('the steps of the plan ("Step 1")');

		const test = {
			...base,
			kind: "statement",
			text: "First we test it in one town.",
			say: "Before anything else we try it for a month in one town and count how many riders book.",
		};
		expect(problemsOf(whyItExists([test]))[0]).toContain('the tests ("test")');

		const found = exampleTalk();
		Object.assign(pictureOf(found, 0, 1), { value: "349", unit: "kr" });
		expect(problemsOf(found, ["Velo Fix"])).toEqual([]);
	});

	it("keeps a starter's borders fixed and asks an own talk for its own", () => {
		const fixed = whyItExists();
		fixed.not = "Nothing";
		expect(problemsOf(fixed)).toEqual(['talk: a starter talk takes no "has" or "not"; its borders are fixed']);

		const own = whyItExists();
		delete own.starter;
		expect(problemsOf(own)).toEqual(['talk: "has" is missing', 'talk: "not" is missing']);
		Object.assign(own, { has: "How a visit is booked and done", not: "Why the company exists" });
		const read = readSurfaceTalk(own, { now: NOW });
		expect(read.problems).toEqual([]);
		expect(read.talk).toMatchObject({ has: "How a visit is booked and done", not: "Why the company exists" });
		expect(read.talk?.starter).toBeUndefined();

		const unknown = whyItExists();
		unknown.starter = "mission";
		expect(problemsOf(unknown)[0]).toBe(`talk: "starter" must be one of ${SURFACE_TALK_STARTER_IDS.join(", ")}`);
	});

	it("holds every picture to its shape and its word limits", () => {
		const cases: readonly (readonly [number, number, Json, string])[] = [
			[0, 0, { title: "Repairs that people keep putting off for far too long" }, '"title" is 10 words, at most 8'],
			[0, 1, { value: "41 riders" }, '"value" is 9 characters, at most 8'],
			[0, 1, { say: "Too short." }, '"say" is 2 words, must be 12 to 45'],
			[0, 2, { items: [{ label: "No time", value: 23 }] }, '"items" has 1 entries, must be 2 to 9'],
			[0, 3, { percent: 140 }, '"percent" must be 0 to 100'],
			[1, 2, { total: 100 }, "the parts sum to 120, the total says 100"],
			[1, 3, { left: "At the workshop" }, '"left" must be {title, big?, lines}'],
			[
				2,
				2,
				{
					rows: [
						{ label: "Tubes", cells: "yy" },
						{ label: "Chains", cells: "yxy" },
					],
				},
				"one per column",
			],
			[
				2,
				3,
				{
					items: [
						{ title: "Book", state: "soon" },
						{ title: "Ride", state: "later" },
					],
				},
				"now, next or later",
			],
			[2, 4, { pass: { value: 180, label: "Worth doing" } }, "pass.value 180 is outside 0 to 100"],
			[2, 6, { src: "../van.png" }, '"src" must be the path of a picture file'],
			[2, 7, { kind: "chart" }, '"kind" must be one of title, statement'],
			[2, 7, { from: [] }, '"from" has 0 entries, must be 1 to 8'],
			[2, 7, { from: ["the riders study"] }, 'use "yours", "plan", "post:<path>"'],
			[2, 7, { tone: "lavender" }, `"tone" must be one of ${SURFACE_TALK_TONES.join(", ")}`],
		];
		for (const [chapter, picture, change, problem] of cases) {
			const talk = exampleTalk();
			Object.assign(pictureOf(talk, chapter, picture), change);
			expect(problemsOf(talk).join("\n"), problem).toContain(problem);
		}

		const dash = exampleTalk();
		pictureOf(dash, 0, 2).say =
			"Most of them wait — and this matters — because they have no time for the workshop at all.";
		expect(problemsOf(dash)).toEqual(['chapter 1 picture 3: "say" holds a dash aside; say it plainly']);

		const twice = exampleTalk();
		(pictureOf(twice, 2, 7) as Json).kind = "art";
		Object.assign(pictureOf(twice, 2, 7), { src: "talks/found/VAN.png", alt: "The van again" });
		expect(problemsOf(twice)).toContain("chapter 3 picture 8: this picture file is used twice in the talk");
	});

	it("holds the chapters to the points", () => {
		const untitled = exampleTalk();
		(untitled.chapters as Json[])[1] = {
			...(untitled.chapters as Json[])[1],
			pictures: ((untitled.chapters as Json[])[1]?.pictures as Json[]).slice(1),
		};
		expect(problemsOf(untitled)).toEqual(["chapter 2: must open with a title picture"]);

		const dropped = exampleTalk();
		((dropped.chapters as Json[])[2] as Json).points = [1];
		expect(problemsOf(dropped)).toEqual(["talk: no chapter carries point 3; every point is carried by a chapter"]);

		const stray = exampleTalk();
		((stray.chapters as Json[])[2] as Json).points = [2, 5];
		expect(problemsOf(stray)).toEqual(['chapter 3: "points" holds 5, not the index of a point']);

		const wordy = exampleTalk();
		wordy.answer = Array.from({ length: 36 }, () => "word").join(" ");
		expect(problemsOf(wordy)[0]).toContain('"answer" is 36 words, at most 35');

		expect(readSurfaceTalk("talk", { now: NOW }).problems).toEqual(["talk: must be a JSON object"]);
	});
});

describe("the talks block", () => {
	const layoutWith = (blocks: readonly unknown[]) => ({
		schema: SURFACE_LAYOUT_SCHEMA,
		tabs: [{ id: "talks", title: "Talks", blocks }],
	});

	it("needs nothing named: its talks have a default home", () => {
		expect(parseSurfaceLayout(layoutWith([{ type: "talks" }])).tabs[0]?.blocks[0]).toEqual({
			type: "talks",
			match: SURFACE_TALKS_DEFAULT_MATCH,
		});
		expect(
			parseSurfaceLayout(layoutWith([{ type: "talks", id: "shelf", match: "told/*/talk.json", heading: "Told" }]))
				.tabs[0]?.blocks[0],
		).toEqual({ type: "talks", id: "shelf", match: "told/*/talk.json", heading: "Told" });
		expect(() => parseSurfaceLayout(layoutWith([{ type: "talks", from: "talks.json" }]))).toThrow(
			"layout.tabs[0].blocks[0] has a field that talks does not take; its fields are type, id, match, heading",
		);
	});

	it("is in the block reference, and brings the talk format to a layout that holds it", () => {
		expect(describeSurfaceBlocks()).toContain(
			`- talks: narrated talks: a shelf, a player. match? glob (${SURFACE_TALKS_DEFAULT_MATCH}); heading?`,
		);
		const formats = describeSurfaceFormats(parseSurfaceLayout(layoutWith([{ type: "talks" }])));
		expect(formats).toContain(SURFACE_TALK_FORMAT);
		expect(describeSurfaceFormats(parseSurfaceLayout(layoutWith([{ type: "library" }])))).not.toContain(
			SURFACE_TALK_FORMAT,
		);
	});

	it("tells the writer every kind, tone and starter the checker knows", () => {
		for (const kind of SURFACE_TALK_KINDS) expect(SURFACE_TALK_FORMAT, kind).toContain(`${kind} {`);
		for (const tone of SURFACE_TALK_TONES) expect(SURFACE_TALK_FORMAT, tone).toContain(tone);
		expect(SURFACE_TALK_FORMAT).toContain(SURFACE_TALK_STARTER_IDS.join(", "));
		expect(SURFACE_TALK_STARTERS.map((starter) => starter.id)).toEqual([...SURFACE_TALK_STARTER_IDS]);
		expect(SURFACE_TALK_STARTERS.map((starter) => starter.name)).toEqual([
			"Why it exists",
			"Why it can work",
			"How it should feel",
			"What we found",
			"What stands in the way",
			"What we are still guessing",
			"What we do next",
		]);
	});
});
