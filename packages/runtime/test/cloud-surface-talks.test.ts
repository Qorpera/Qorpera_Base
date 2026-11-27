import {
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_TALK_STARTERS,
} from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { captionHash } from "../src/cloud-app-kit-explainer.ts";
import type { CloudToolContext } from "../src/cloud-native-tool-boundary.ts";
import { PLATFORM_SKILL_FILES } from "../src/cloud-platform-skills.ts";
import { PLATFORM_UPDATES } from "../src/cloud-platform-updates.ts";
import { SURFACE_ESCALATION_WAKE_PROTOCOL } from "../src/cloud-surface-escalation-wake.ts";
import { renderStudioPreviewHtml } from "../src/cloud-surface-inspect-tool.ts";
import { createNarrateExplainerTool } from "../src/cloud-surface-narrate-tool.ts";
import { checkStagedSurfaceDeliverables, checkStagedSurfaceTalks } from "../src/cloud-surface-tools.ts";

type Json = Record<string, unknown>;

const OPENING = "This talk gives the reason Tinwhistle exists, in the founders' own words. It is a short one.";
const TODAY = "Today a fault means a trip to a workshop and a week without the bike. So people ride on with it.";

function madeTalk(change: (talk: Json, pictures: Json[]) => void = () => {}): string {
	const pictures: Json[] = [
		{
			kind: "title",
			kicker: "Why it exists",
			title: "Mended the same evening",
			say: OPENING,
			from: ["yours"],
		},
		{
			kind: "marks",
			title: "Today a fault means",
			items: [
				{ mark: "no", label: "A trip to the workshop" },
				{ mark: "no", label: "A week without the bike" },
			],
			say: TODAY,
			from: ["yours"],
		},
	];
	const talk: Json = {
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
			lines: 2,
			marked: 0,
		},
		chapters: [{ title: "The reason", points: [0, 1, 2], pictures }],
	};
	change(talk, pictures);
	return JSON.stringify(talk);
}

function pointsTalk(): string {
	const { chapters: _chapters, listen: _listen, agreed: _agreed, ...rest } = JSON.parse(madeTalk()) as Json;
	return JSON.stringify(rest);
}

const write = (path: string, content: string): StudioPatchOp => ({ op: "write_text", path, content });

function fakeContext(): CloudToolContext {
	return {
		callId: "call-1",
		companyId: "11111111-1111-4111-8111-111111111111",
		runId: "22222222-2222-4222-8222-222222222222",
		argumentSha256: "0".repeat(64),
		signal: new AbortController().signal,
	};
}

describe("staging a talk", () => {
	it("stages a talk that passes the check, in any of its three states", () => {
		expect(() => checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", madeTalk())])).not.toThrow();
		expect(() =>
			checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", pointsTalk())]),
		).not.toThrow();
		expect(() =>
			checkStagedSurfaceDeliverables([
				write(
					"talks/why-it-can-work/talk.json",
					JSON.stringify({
						starter: "works",
						title: "Why it can work",
						question: "Why would this work as a business?",
						asks: ["Why do you believe riders will pay for a visit?"],
					}),
				),
			]),
		).not.toThrow();
		expect(() => checkStagedSurfaceDeliverables([write("notes/talk.json.md", "not a talk")])).not.toThrow();
	});

	it("refuses a talk with a code number in it, and stages nothing", () => {
		const coded = madeTalk((_talk, pictures) => {
			(pictures[1] as Json).say =
				"Today a fault means a trip to a workshop, and B3 says a week without the bike. So people ride on.";
		});
		expect(() => checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", coded)])).toThrow(
			'talks/why-it-exists/talk.json is not a talk the founder can be shown: chapter 1 picture 2: a code number is shown or spoken ("B3"); say the thing itself. Fix it and stage the talk whole again; nothing was staged.',
		);
	});

	it("refuses what is outside the talk's borders, a talk with no cold listen, and a merge", () => {
		const priced = madeTalk((_talk, pictures) => {
			(pictures[1] as Json).title = "A visit is cheaper";
		});
		expect(() => checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", priced)])).toThrow(
			'outside this talk\'s borders: prices or money ("cheaper") never belongs in "Why it exists"',
		);
		const unheard = madeTalk((talk) => {
			delete talk.listen;
		});
		expect(() => checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", unheard)])).toThrow(
			'a talk with pictures needs "listen"',
		);
		expect(() => checkStagedSurfaceDeliverables([write("talks/why-it-exists/talk.json", "{ not json")])).toThrow(
			"content is not valid JSON",
		);
		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "merge_json", path: "talks/why-it-exists/talk.json", patch: { title: "Why we exist" } },
			]),
		).toThrow("a talk is written whole, with write_text, never merged");
	});

	it("counts a talk as a deliverable of its own", () => {
		const post = JSON.stringify({ headline: "A post", sections: [{ heading: "One", paragraphs: ["Text."] }] });
		expect(() =>
			checkStagedSurfaceDeliverables([
				write("talks/why-it-exists/talk.json", madeTalk()),
				write("research/a.report.json", post),
			]),
		).toThrow("in its own stage_surface_patch call");
		expect(() =>
			checkStagedSurfaceDeliverables([
				write("talks/why-it-exists/talk.json", madeTalk()),
				{
					op: "write_file",
					path: "talks/why-it-exists/van.png",
					file: { manifestSha256: "a".repeat(64), fileSha256: "b".repeat(64), bytes: 8, mediaType: "image/png" },
				},
			]),
		).not.toThrow();
	});
});

describe("staging a talk against its page", () => {
	const signal = new AbortController().signal;
	const staging = (files: Record<string, string>, layout: string | null = null) => ({
		folderRoot: "surfaces/strategy",
		waitingOps: [],
		readLayout: vi.fn(async () => layout),
		readText: vi.fn(async (path: string) => files[path] ?? null),
	});
	const landscape = JSON.stringify({
		players: [
			{ id: "us", name: "Tinwhistle", isUs: true },
			{ id: "velo", name: "Velo Fix" },
			{ id: "spokes", name: "Spokesmen" },
		],
	});
	const named = madeTalk((_talk, pictures) => {
		(pictures[1] as Json).say =
			"Today a fault means a trip to a workshop such as Velo Fix and a week without the bike. So people ride on.";
	});

	it("keeps the rivals the page names out of the talk on why the company exists", async () => {
		const page = staging({ "landscape.json": landscape });
		await expect(
			checkStagedSurfaceTalks([write("talks/why-it-exists/talk.json", named)], page, signal),
		).rejects.toThrow('outside this talk\'s borders: a rival ("Velo Fix") never belongs in "Why it exists"');
		expect(page.readText).toHaveBeenCalledWith("landscape.json", signal);

		await expect(
			checkStagedSurfaceTalks([write("talks/why-it-exists/talk.json", madeTalk())], page, signal),
		).resolves.toBeUndefined();
		await expect(
			checkStagedSurfaceTalks([write("talks/why-it-exists/talk.json", named)], staging({}), signal),
		).resolves.toBeUndefined();
	});

	it("reads the rivals from the file the page's own layout names", async () => {
		const layout = JSON.stringify({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [{ id: "market", title: "Market", blocks: [{ type: "landscape", from: "market/rivals.json#/map" }] }],
		});
		const page = staging({ "market/rivals.json": landscape }, layout);
		await expect(
			checkStagedSurfaceTalks([write("talks/why-it-exists/talk.json", named)], page, signal),
		).rejects.toThrow('a rival ("Velo Fix")');
		expect(page.readText).not.toHaveBeenCalledWith("landscape.json", signal);
	});

	it("refuses a picture that rests on a post that is not there", async () => {
		const resting = madeTalk((talk, pictures) => {
			talk.starter = "found";
			(pictures[1] as Json).from = ["post:research/riders.report.json"];
		});
		const op = write("surfaces/strategy/talks/what-we-found/talk.json", resting);
		await expect(checkStagedSurfaceTalks([op], staging({}), signal)).rejects.toThrow(
			"a picture rests on research/riders.report.json, which is not in this folder",
		);
		await expect(
			checkStagedSurfaceTalks([op], staging({ "research/riders.report.json": "{}" }), signal),
		).resolves.toBeUndefined();
		await expect(
			checkStagedSurfaceTalks([op, write("research/riders.report.json", "{}")], staging({}), signal),
		).resolves.toBeUndefined();
		await expect(
			checkStagedSurfaceTalks(
				[op],
				{ folderRoot: "surfaces/strategy", waitingOps: [], readLayout: async () => null },
				signal,
			),
		).resolves.toBeUndefined();
	});
});

describe("a talk's voice", () => {
	function narrator(files: Record<string, string>) {
		const staged: StudioPatchOp[][] = [];
		const spoken: string[] = [];
		const tool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "surfaces/strategy",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			readStudioText: async (path) => files[path] ?? null,
			stageBytes: async (bytes, mediaType) =>
				({
					manifestSha256: "a".repeat(64),
					fileSha256: "b".repeat(64),
					bytes: bytes.byteLength,
					mediaType,
				}) as StudioBinaryRef,
			surfacePatch: {
				stageSurfacePatch: async (_sessionId, request) => {
					staged.push([...request.ops]);
					return { changeId: "44444444-4444-4444-8444-444444444444", seq: 2, openChangeCount: 2 };
				},
			},
			synthesizeGemini: async ({ text }) => {
				spoken.push(text);
				return {
					audio: new Uint8Array([82, 73, 70, 70]),
					mediaType: "audio/wav",
					fileExtension: "wav",
					seconds: 6.2,
					usage: { inputTokens: 8, cachedTokens: 0, outputTokens: 120 },
				};
			},
		});
		return { tool, staged, spoken };
	}

	it("records one clip for each spoken line, beside the talk, and only the lines that have none", async () => {
		const clips = JSON.stringify({
			clips: [{ caption: captionHash(OPENING), file: `${captionHash(OPENING)}.wav`, seconds: 5.1 }],
		});
		const { tool, staged, spoken } = narrator({
			"talks/why-it-exists/talk.json": madeTalk(),
			"talks/why-it-exists/voice/clips.json": clips,
		});
		const result = await tool.execute({ scenesPath: "talks/why-it-exists/talk.json" }, fakeContext());
		expect(JSON.parse(String(result.value))).toMatchObject({
			ok: true,
			state: "spoken",
			spokenNow: 1,
			reused: 1,
			total: 2,
			clipsPath: "talks/why-it-exists/voice/clips.json",
		});
		expect(spoken).toEqual([TODAY]);
		expect(staged[0]?.map((op) => op.path)).toEqual([
			`talks/why-it-exists/voice/${captionHash(TODAY)}.wav`,
			"talks/why-it-exists/voice/clips.json",
		]);
	});

	it("records nothing for a talk without pictures or one that does not pass the check", async () => {
		const waiting = narrator({ "talks/why-it-exists/talk.json": pointsTalk() });
		await expect(
			waiting.tool.execute({ scenesPath: "talks/why-it-exists/talk.json" }, fakeContext()),
		).rejects.toThrow("TALK_NOT_MADE");
		const coded = narrator({
			"talks/why-it-exists/talk.json": madeTalk((_talk, pictures) => {
				(pictures[0] as Json).kicker = "Bet 3";
			}),
		});
		await expect(coded.tool.execute({ scenesPath: "talks/why-it-exists/talk.json" }, fakeContext())).rejects.toThrow(
			"INVALID_TALK: talks/why-it-exists/talk.json does not pass the talk check, so it gets no voice",
		);
		expect(waiting.spoken).toEqual([]);
		expect(coded.spoken).toEqual([]);
		expect(() => coded.tool.parseArguments({ scenesPath: "talks/why-it-exists/points.json" })).toThrow(
			"scenesPath must point to a .js scenes file, tour.json or a talk's talk.json",
		);
	});
});

describe("the audit's view of a Talks tab", () => {
	it("lists each talk with its state, and warns about one that does not read", () => {
		const layout = JSON.stringify({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [{ id: "talks", title: "Talks", blocks: [{ type: "talks" }] }],
		});
		const snapshot = {
			surfaceTitle: "Strategy",
			folderRoot: "surfaces/strategy",
			starter: "strategy" as const,
			files: {
				"surfaces/strategy/layout.json": layout,
				"surfaces/strategy/talks/why-it-exists/talk.json": madeTalk(),
				"surfaces/strategy/talks/how-it-feels/talk.json": pointsTalk(),
				"surfaces/strategy/talks/broken/talk.json": JSON.stringify({ title: "Broken" }),
				"surfaces/strategy/talks/why-it-exists/voice/clips.json": JSON.stringify({ clips: [] }),
			},
			binaries: {},
		};
		const rendered = renderStudioPreviewHtml({ snapshot, tabId: "talks", theme: "light" });
		expect(rendered.renderedBlocks).toEqual([{ type: "talks", heading: "Talks", filled: true }]);
		expect(rendered.html).toContain("<strong>Why Tinwhistle exists</strong><p>1 min · 1 chapters · 2 pictures</p>");
		expect(rendered.html).toContain("3 points for the founder&#39;s yes");
		expect(rendered.warnings.join("\n")).toContain("Talk talks/broken/talk.json does not read and is not shown");

		const empty = renderStudioPreviewHtml({
			snapshot: { ...snapshot, files: { "surfaces/strategy/layout.json": layout } },
			tabId: "talks",
			theme: "light",
		});
		expect(empty.renderedBlocks).toEqual([{ type: "talks", heading: "Talks", filled: false }]);
		expect(empty.html).toContain("No talks staged yet");
	});
});

describe("the talk skills and the Co-Founder's side", () => {
	const writer = PLATFORM_SKILL_FILES.talks as string;
	const listener = PLATFORM_SKILL_FILES["talk-listen"] as string;

	it("give the writer the seven rules, the order of work and the seven starter talks", () => {
		for (const rule of [
			"1. One question",
			"2. Each talk has borders",
			"3. The reason comes from the founders",
			"4. Spoken for someone who never opened this page",
			"5. Everything earns its place",
			"6. As long as the answer, up to fifteen minutes",
			"7. A cold listen before the founder sees it",
		])
			expect(writer, rule).toContain(rule);
		expect(writer).toContain("Never write your own reading of a reason, not even as a draft to confirm");
		expect(writer).toContain("No picture before that yes");
		expect(writer).toContain("the talk-listen skill (`read_skill`)");
		expect(writer).toContain("Record a voice with `narrate_explainer` only when the founder asks");
		for (const starter of SURFACE_TALK_STARTERS) expect(writer, starter.id).toContain(`- ${starter.name}: `);
		expect(writer.indexOf("Read the vision")).toBeLessThan(writer.indexOf('"Talk questions:"'));
		expect(writer.indexOf('"Talk questions:"')).toBeLessThan(writer.indexOf('"Talk points:"'));
		expect(writer.indexOf('"Talk points:"')).toBeLessThan(writer.indexOf("5. Draw"));
		expect(writer.indexOf("5. Draw")).toBeLessThan(writer.indexOf("6. The cold listen"));
		expect(writer.indexOf("6. The cold listen")).toBeLessThan(writer.indexOf("7. Then stage the talk"));
	});

	it("give the listener only the lines, and three verdicts", () => {
		expect(listener).toContain("its title, its question and its spoken lines in order, and nothing else");
		for (const verdict of ["carries:", "why am I told this:", "could not follow:"])
			expect(listener, verdict).toContain(verdict);
		expect(listener).toContain("Every word, name, code or abbreviation you were never told");
		expect(listener).toContain("more than one line in ten marked, a fresh listener");
	});

	it("leave a talk's questions and points to the founder, and its cold listen to a worker", () => {
		for (const start of ['"Talk questions:"', '"Talk points:"', '"Cold listener needed:"']) {
			expect(writer, start).toContain(start);
			expect(SURFACE_ESCALATION_WAKE_PROTOCOL, start).toContain(start);
		}
		expect(SURFACE_ESCALATION_WAKE_PROTOCOL).toContain("the talk-listen skill (read_skill)");
		expect(SURFACE_ESCALATION_WAKE_PROTOCOL).toContain("never yours to supply or approve");
		expect(PLATFORM_UPDATES.find((update) => update.id === "talks")?.text).toContain(
			"A talk gets a voice only when a founder asks.",
		);
	});
});
