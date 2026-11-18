import { readFileSync } from "node:fs";
import { appGuide } from "@qorpera/runtime/cloud-app-guides";
import {
	captionHash,
	EXPLAINER_ENGINE_JS,
	EXPLAINER_MANY_CAPTIONS,
	EXPLAINER_VOICE_CAPTIONS_CJS,
	EXPLAINER_VOICE_ENCODE_CJS,
	EXPLAINER_VOICE_PEER_CJS,
	explainerCaptions,
	explainerNotes,
	explainerPage,
	explainerSpokenMatches,
	parseExplainerClips,
} from "@qorpera/runtime/cloud-app-kit-explainer";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

/* The explainer kit (RUNTIME-INTERFACE-APPS.md §3a): the engine's text as the runtime holds it, the page save_app
 * writes around an agent's scenes, the list of voice clips, and what a read of a scenes.js tells its maker. The engine
 * itself runs in a browser: packages/web/test/explainer-kit-engine.test.ts runs this same file in a DOM. */

const ENGINE_SOURCE = new URL("../kits/explainer/engine.js", import.meta.url);
const kitFile = (name: string) => readFileSync(new URL(`../kits/explainer/${name}`, import.meta.url), "utf8");

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

it("holds the engine's text exactly as its source file has it", () => {
	// A change to kits/explainer/engine.js reaches no app until `npm run generate:app-kits` has run.
	expect(EXPLAINER_ENGINE_JS).toBe(readFileSync(ENGINE_SOURCE, "utf8"));
	// One function around everything, so an agent's scenes.js may name its own things as it likes.
	expect(EXPLAINER_ENGINE_JS).toMatch(/\n\(\(\) => \{\n"use strict";\n/);
	expect(EXPLAINER_ENGINE_JS.trimEnd().endsWith("})();")).toBe(true);
});

it("holds the voice scripts' text exactly as their source files have it", () => {
	expect(EXPLAINER_VOICE_CAPTIONS_CJS).toBe(kitFile("voice-captions.cjs"));
	expect(EXPLAINER_VOICE_PEER_CJS).toBe(kitFile("voice-peer.cjs"));
	expect(EXPLAINER_VOICE_ENCODE_CJS).toBe(kitFile("voice-encode.cjs"));
	// A machine runs each as one command with the script's text in it: a command holds at most 16384 bytes
	// (cloud-machine-tools.ts), and the text travels as base64 with a few words around it.
	for (const script of [EXPLAINER_VOICE_CAPTIONS_CJS, EXPLAINER_VOICE_PEER_CJS, EXPLAINER_VOICE_ENCODE_CJS])
		expect(Math.ceil(Buffer.byteLength(script) / 3) * 4).toBeLessThan(16384 - 512);
	// The recorder is handed no sign-in and reads none: only the offer and the answer pass.
	expect(EXPLAINER_VOICE_PEER_CJS).not.toMatch(/auth\.json|CODEX_HOME|access[-_ ]?token|Authorization/i);
	// Every line a script prints for the runtime is marked, so other output of a machine's command is no line of it.
	for (const script of [EXPLAINER_VOICE_CAPTIONS_CJS, EXPLAINER_VOICE_PEER_CJS, EXPLAINER_VOICE_ENCODE_CJS])
		expect(script).toContain("QORPERA-VOICE ");
});

it("keeps a clip only when the voice said its caption, numbers aside", () => {
	// As spoken on 10 November 2026 (the call's own transcripts).
	const kept: [string, string][] = [
		[
			"Fjeldtur plans cabin weekends for groups of friends. How would it make money?",
			"Fjeldtur plans cabin weekends for groups of friends. How would it make money?",
		],
		[
			"So four friends see NOK 596 in fees before they commit.",
			"So four friends see NOK five hundred and ninety-six in fees before they commit.",
		],
		[
			"NOK 82.50 is left per group, before fixed costs.",
			"NOK eighty-two point five zero is left per group, before fixed costs.",
		],
		[
			"At NOK 1,200 a failure, five leave 22.50. Ten push it below zero.",
			"At NOK one thousand two hundred a failure, five leave twenty-two point five zero. Ten push it below zero.",
		],
		[
			"That one loss wipes out what about 3.6 good groups leave.",
			"That one loss wipes out what about three point six good groups leave.",
		],
		[
			"Hver rejsende betaler ét synligt gebyr: 149 kroner, inklusive moms.",
			"Hver rejsende betaler ét synligt gebyr: et hundrede niogfyrre kroner, inklusive moms.",
		],
		[
			"Så fire venner ser 596 kroner i gebyrer, før de binder sig.",
			"Så fire venner ser fem hundrede seksoghalvfems kroner i gebyrer, før de binder sig.",
		],
		// Said as digits, in other punctuation and case, with a curly apostrophe.
		["The organiser's cost isn't priced yet.", "the organiser\u2019s cost isn\u2019t priced yet"],
		["Each traveller pays 149 kroner.", "Each traveller pays 149 kroner."],
		// The letters around a digit are words of the caption; the digit is a number.
		["Our B2B plan is ready.", "Our B two B plan is ready."],
	];
	for (const [caption, said] of kept) expect(explainerSpokenMatches(caption, said), caption).toBe(true);
	const dropped: [string, string][] = [
		// The one of 28 that came back with sentences of the voice's own.
		[
			"Failures cost money. One cabin charges NOK 300, even five or more days ahead.",
			"Failures cost money. One cabin charges NOK three hundred, even five or more days ahead. One carrier keeps vouchers when they cancel. Another keeps NOK fifty per change and gives nothing back inside twenty-four hours.",
		],
		// Talked about instead of read (the voice with no rule, 10 November).
		[
			"Fjeldtur plans cabin weekends for groups of friends. How would it make money?",
			"Imagine an app called Fjeldtur. It plans cabin weekends for groups of friends. What's one way it could make money?",
		],
		// A word left out, a word changed, a word added to a caption with no number, words in another order, nothing.
		["Planning the trip is free. So is voting on it.", "Planning the trip is free. So is voting."],
		["Planning the trip is free. So is voting on it.", "Planning the trip is free. So is voting for it."],
		["Planning the trip is free. So is voting on it.", "Sure. Planning the trip is free. So is voting on it."],
		["Planning the trip is free. So is voting on it.", "So is voting on it. Planning the trip is free."],
		["Planning the trip is free.", ""],
		// A name with a digit in it is not a number: other letters, or none, are not the caption (review r1 of #1660).
		["Our B2B plan is ready.", "Our B2C plan is ready."],
		["Our B2B plan is ready.", "Our plan is ready."],
		["The X200 ships in May.", "The Y200 ships in May."],
	];
	for (const [caption, said] of dropped) expect(explainerSpokenMatches(caption, said), said).toBe(false);
});

it("names a caption's clip as the engine does", () => {
	// The engine's own function, taken from its text and run here: the page finds a clip only under the same name.
	const source = /\nfunction captionHash\(text\) \{[\s\S]*?\n\}\n/.exec(EXPLAINER_ENGINE_JS)?.[0];
	expect(source).toBeDefined();
	const engineHash = new Function(`${source}; return captionHash;`)() as (text: string) => string;
	for (const caption of [
		"Fjeldtur plans cabin weekends for groups of friends. How would it make money?",
		"Så fire venner ser 596 kroner i gebyrer, før de binder sig.",
		"",
		"€ 12 — “quoted” 🙂",
	]) {
		expect(captionHash(caption)).toBe(engineHash(caption));
		expect(captionHash(caption)).toMatch(/^[0-9a-f]{8}$/);
	}
	expect(captionHash("")).toBe("811c9dc5");
	expect(captionHash("a")).toBe("e40c292c");
});

it("writes the page around the agent's scenes: the video made before them, started after", () => {
	expect(explainerPage("How the fee works", [])).toBe(
		[
			"<!doctype html>",
			'<html lang="en">',
			"<head>",
			'<meta charset="utf-8">',
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			'<meta name="color-scheme" content="dark">',
			"<title>How the fee works</title>",
			"</head>",
			"<body>",
			'<div id="video"></div>',
			'<script src="engine.js"></script>',
			'<script>window.V = new Video(document.getElementById("video"), { title: "How the fee works" });</script>',
			'<script src="scenes.js"></script>',
			"<script>V.start();</script>",
			"</body>",
			"</html>",
			"",
		].join("\n"),
	);
	// The clips stand before the scripts, each named on a <source>, which the web's page builder puts the file into.
	const spoken = explainerPage("T", [
		{ caption: "3f0a9c1e", file: "3f0a9c1e.mp4", seconds: 5.42 },
		{ caption: "0000beef", file: "0000beef.webm", seconds: 2 },
	]);
	expect(spoken).toContain(
		'<div id="video"></div>\n<audio data-caption="3f0a9c1e" data-seconds="5.42" preload="none"><source src="voice/3f0a9c1e.mp4"></audio>\n<audio data-caption="0000beef" data-seconds="2" preload="none"><source src="voice/0000beef.webm"></audio>\n<script src="engine.js">',
	);
	// A title can end neither the title nor the script it is written into.
	const sharp = explainerPage('</title><script>alert(1)</script> & "x" <!--', []);
	expect(sharp).toContain(
		"<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &lt;!--</title>",
	);
	expect(sharp).toContain(
		'{ title: "\\u003c/title>\\u003cscript>alert(1)\\u003c/script> & \\"x\\" \\u003c!--" });</script>',
	);
	expect(sharp.match(/<script/g)).toHaveLength(4);
});

it("reads the list of voice clips, and leaves out whatever is not one", () => {
	const listed = JSON.stringify({
		schema: "qorpera.explainer-voice/v1",
		voice: "cove",
		clips: [
			{ caption: "3f0a9c1e", file: "3f0a9c1e.mp4", seconds: 5.4249 },
			{ caption: "0000beef", file: "0000beef.webm", seconds: 2 },
			// Twice the same caption: the first stands.
			{ caption: "3f0a9c1e", file: "3f0a9c1e.webm", seconds: 9 },
			// A file that is not the caption's own, a path, a length that is none, and what is no clip at all.
			{ caption: "aaaaaaaa", file: "bbbbbbbb.mp4", seconds: 1 },
			{ caption: "cccccccc", file: "../cccccccc.mp4", seconds: 1 },
			{ caption: "dddddddd", file: "dddddddd.mp3", seconds: 1 },
			{ caption: "eeeeeeee", file: "eeeeeeee.mp4", seconds: 0 },
			{ caption: "ffffffff", file: "ffffffff.mp4", seconds: 61 },
			{ caption: "FFFFFFFF", file: "FFFFFFFF.mp4", seconds: 1 },
			{ caption: "11111111", file: "11111111.mp4", seconds: "3" },
			null,
			"clip",
		],
	});
	expect(parseExplainerClips(listed)).toEqual([
		{ caption: "3f0a9c1e", file: "3f0a9c1e.mp4", seconds: 5.42 },
		{ caption: "0000beef", file: "0000beef.webm", seconds: 2 },
	]);
	for (const none of ["", "not json", "[]", "null", '{"clips":{}}', '{"voice":"cove"}'])
		expect(parseExplainerClips(none)).toEqual([]);
	const many = Array.from({ length: EXPLAINER_MANY_CAPTIONS + 9 }, (_, n) => {
		const caption = n.toString(16).padStart(8, "0");
		return { caption, file: `${caption}.mp4`, seconds: 1 };
	});
	expect(parseExplainerClips(JSON.stringify({ clips: many }))).toHaveLength(EXPLAINER_MANY_CAPTIONS + 9);
});

const SCENES = `V.part("The idea");
V.scene((s) => {
  const fee = s.number({ x: 800, y: 450, from: 149, size: 96 });
  s.say("Each traveller pays one visible fee: 149 kroner.", s.fadeIn(fee));
  s.say('So four friends see 596 kroner \\'up front\\'.', s.value(fee, 596));
  s.say(\`Nothing else is charged.\`);
});
`;

it("finds the captions a scenes.js speaks, as far as a read of its text tells", () => {
	expect(explainerCaptions(SCENES)).toEqual([
		"Each traveller pays one visible fee: 149 kroner.",
		"So four friends see 596 kroner 'up front'.",
		"Nothing else is charged.",
	]);
	// A caption built from parts is not one plain string: it is not counted, and nothing is guessed.
	expect(explainerCaptions('s.say("a" + b); s.say(text); s.say(`x` + y);')).toEqual([]);
	expect(explainerCaptions('s.say("caf\\u00e9 \\"au lait\\"")')).toEqual(['café "au lait"']);
});

it("tells the maker what a read of the scenes found, and nothing of a video that is in order", () => {
	expect(explainerNotes(SCENES)).toEqual([]);
	const empty = explainerNotes("// to do");
	expect(empty).toHaveLength(1);
	expect(empty[0]).toContain("No scene with a caption was found");
	const own = explainerNotes(`const V = new Video(document.getElementById("video"));\n${SCENES}V.start();`);
	expect(own).toEqual([
		"The page makes the video (V) and starts it: take new Video(…) and V.start() out of scenes.js, which only adds parts and scenes to V.",
	]);
	const wordy =
		'V.scene((s) => { s.say("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"); });';
	expect(explainerNotes(wordy)[0]).toContain('1 caption is longer than 18 words (the first: "one two three');
	const many = `V.scene((s) => { ${Array.from({ length: EXPLAINER_MANY_CAPTIONS + 1 }, (_, n) => `s.say("Caption number ${n} says a little more than nothing at all here.");`).join(" ")} });`;
	const notes = explainerNotes(many);
	expect(notes[0]).toContain(`${EXPLAINER_MANY_CAPTIONS + 1} captions: a video is best at 25 to 35`);
	expect(notes[1]).toMatch(/^About 4:\d\d of captions: aim at 90 to 120 seconds/);
});

it("tells an agent in the explainer's guide only what the engine can draw", async () => {
	const f = await folderWriterFixture();
	runs.push(f.run);
	const [saveApp] = cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	expect(saveApp?.description).toContain(
		"you write the kit's one file among files (<kit>.json, such as model.json; an explainer's scenes.js)",
	);
	const kit = (
		saveApp?.inputSchema as {
			properties: { manifest: { properties: { kit: { enum: unknown[]; description: string } } } };
		}
	).properties.manifest.properties.kit;
	expect(kit.enum).toEqual([
		"explainer",
		"model",
		"board",
		"path",
		"object",
		"curve",
		"stack",
		"shelf",
		"map",
		"ring",
		"flow",
		"roadmap",
		"program",
		null,
	]);
	expect(kit.description).toContain("explainer: a mechanism or a decision that a short narrated video explains.");
	const said = appGuide("explainer");
	// Every call the guidance names is one the engine's scene has, and every icon and colour is one it draws.
	const methods = new Set([...said.matchAll(/\bs\.([A-Za-z]+)\(/g)].map((match) => match[1] as string));
	expect([...methods].sort()).toEqual(
		[
			"all",
			"arrow",
			"bar",
			"box",
			"camera",
			"create",
			"dim",
			"fadeIn",
			"fadeOut",
			"flow",
			"icon",
			"indicate",
			"line",
			"move",
			"number",
			"say",
			"scale",
			"text",
			"value",
			"write",
		].sort(),
	);
	for (const method of methods) expect(EXPLAINER_ENGINE_JS, method).toMatch(new RegExp(`\\n  ${method}\\(`));
	expect(EXPLAINER_ENGINE_JS).toMatch(/\n {2}part\(title\) \{/);
	expect(EXPLAINER_ENGINE_JS).toMatch(/\n {2}scene\(build\) \{/);
	const icons = /with name of ([a-z, ]+);/.exec(said)?.[1]?.split(", ") ?? [];
	expect(icons).toHaveLength(16);
	const drawn = /\nconst ICONS = \{\n([\s\S]*?)\n\};\n/.exec(EXPLAINER_ENGINE_JS)?.[1] ?? "";
	expect([...drawn.matchAll(/^ {2}([a-z]+): /gm)].map((match) => match[1]).sort()).toEqual([...icons].sort());
	const colours = /\nconst C = \{([\s\S]*?)\n\};\n/.exec(EXPLAINER_ENGINE_JS)?.[1] ?? "";
	for (const colour of ["yellow", "green", "red", "blue", "teal", "purple", "grey"]) {
		expect(said).toContain(colour);
		expect(colours).toMatch(new RegExp(`\\b${colour}: "#`));
	}
	// What makes a video worth watching, and how it is looked at before it is shown.
	for (const rule of [
		"Use it where motion explains better than a page",
		"Not for a thing a member should handle (that is another kit) and not as a mock-up of a screen.",
		"You write one file, scenes.js; save_app writes engine.js and index.html beside it, so never write or edit those two.",
		"The captions are the narration: shown under the stage, and spoken word for word when the video has a voice.",
		"amounts as they are said (149 kroner, not NOK 149.00)",
		"A mechanism is motion",
		"Every number, name and claim comes from the company's files",
		"index.html?t=SECONDS opens the video paused at that second",
	])
		expect(said).toContain(rule);
});
