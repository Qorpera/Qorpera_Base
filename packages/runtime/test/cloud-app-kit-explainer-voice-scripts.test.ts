import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

/* The explainer kit's voice scripts (packages/runtime/kits/explainer/voice-*.cjs; RUNTIME-INTERFACE-APPS.md §3a), run
 * as a machine runs them, over a stand-in for Playwright (fixtures/voice-playwright-stub.cjs) whose page runs the
 * scripts' own page functions. What a real browser and a real call do is proven outside the suite; here it is what
 * the scripts promise the runtime: a turn whose end has come is written before the recorder goes, a turn that cannot
 * be written is a failure, and a page that says its video is broken gives no captions (review r1 of #1660). */

const KIT = fileURLToPath(new URL("../kits/explainer/", import.meta.url));
const STUB = fileURLToPath(new URL("./fixtures/voice-playwright-stub.cjs", import.meta.url));

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Line = Record<string, unknown>;
const marked = (output: string): Line[] =>
	output
		.split("\n")
		.filter((line) => line.startsWith("QORPERA-VOICE "))
		.map((line) => JSON.parse(line.slice("QORPERA-VOICE ".length)) as Line);

function run(script: string, args: string[], scenario: string): Promise<{ code: number | null; lines: Line[] }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[join(KIT, script), ...args],
			{ env: { ...process.env, QORPERA_PLAYWRIGHT: STUB, QORPERA_VOICE_SCENARIO: scenario }, timeout: 20_000 },
			(error, stdout) =>
				resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, lines: marked(stdout) }),
		);
	});
}

/** The recorder with its answer waiting, told to stop `stopAfterMs` after the call stands. `finishing` is the seconds
 * it gives a turn to finish, where a test cannot wait the forty it gives by itself. */
function recorded(
	scenario: string,
	stopAfterMs: number,
	finishing?: number,
): Promise<{ code: number | null; lines: Line[]; work: string }> {
	const work = mkdtempSync(join(tmpdir(), "voice-peer-test-"));
	folders.push(work);
	writeFileSync(join(work, "answer.sdp"), "v=0 the answer\n");
	return new Promise((resolve) => {
		const args = [join(KIT, "voice-peer.cjs"), work, "20", ...(finishing ? [String(finishing)] : [])];
		const child = spawn(process.execPath, args, {
			env: { ...process.env, QORPERA_PLAYWRIGHT: STUB, QORPERA_VOICE_SCENARIO: scenario },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		let told = false;
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (!told && output.includes('"connected":true')) {
				told = true;
				setTimeout(() => writeFileSync(join(work, "stop"), ""), stopAfterMs);
			}
		});
		child.on("close", (code) => resolve({ code, lines: marked(output), work }));
	});
}

it("reads the captions of a started video, and none from a page that says its video is broken", async () => {
	const read = await run("voice-captions.cjs", ["/company/apps/fee/index.html"], "captions");
	expect(read).toEqual({
		code: 0,
		lines: [
			{
				captions: [
					{ text: "Each traveller pays one fee.", hash: "0000aaaa" },
					{ text: "So four friends see it.", hash: "0000bbbb" },
				],
			},
		],
	});
	// A scenes.js that stops halfway leaves the captions it got to in the video: they are not the video's.
	const broken = await run("voice-captions.cjs", ["/company/apps/fee/index.html"], "captions-failed");
	expect(broken.lines).toEqual([{ problem: "This video's script has a mistake (line 9): fee is not defined" }]);
	// A path that is not absolute is no page of a machine.
	const relative = await run("voice-captions.cjs", ["apps/fee/index.html"], "captions");
	expect(relative.code).toBe(1);
	expect(relative.lines).toEqual([{ problem: "give the page's absolute path" }]);
});

it("records a turn of the voice and writes it before it goes", async () => {
	const { code, lines, work } = await recorded("turn", 3000);
	expect(code).toBe(0);
	expect(lines.map((line) => Object.keys(line)[0])).toEqual(["offer", "connected", "turn", "ended"]);
	expect(lines[0]).toEqual({ offer: "v=0 the offer\n" });
	expect(lines[2]).toMatchObject({ turn: 1, file: "1.webm", bytes: 16 });
	expect(lines[3]).toEqual({ ended: "stop" });
	expect(readFileSync(join(work, "1.webm"), "utf8")).toBe("the turn's sound");
});

it("finishes a turn whose end has come even when it is told to stop meanwhile", async () => {
	// The turn ends half a second in and its file takes two more seconds to write; stop comes after one.
	const { code, lines, work } = await recorded("turn-slow-write", 1000);
	expect(code).toBe(0);
	expect(lines.map((line) => Object.keys(line)[0])).toEqual(["offer", "connected", "turn", "ended"]);
	expect(lines[3]).toEqual({ ended: "stop" });
	expect(existsSync(join(work, "1.webm"))).toBe(true);
});

it("ends as a failure when a turn cannot be written, and says why", async () => {
	const { code, lines, work } = await recorded("turn-lost-write", 3000);
	expect(code).toBe(1);
	expect(lines.at(-1)).toEqual({ ended: "a turn could not be kept: no room left on the machine" });
	expect(lines.some((line) => "turn" in line)).toBe(false);
	expect(existsSync(join(work, "1.webm"))).toBe(false);
});

it("ends as a failure when a turn is still not written when its time to finish is up", async () => {
	// The turn's end came, its file never does; stop comes after a second, and the turn gets two to finish.
	const { code, lines, work } = await recorded("turn-stalled-write", 1000, 2);
	expect(code).toBe(1);
	expect(lines.at(-1)).toEqual({ ended: "a turn could not be kept: it was not written in time" });
	expect(lines.some((line) => "turn" in line)).toBe(false);
	expect(existsSync(join(work, "1.webm"))).toBe(false);
});
