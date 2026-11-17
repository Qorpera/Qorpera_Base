import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeLoginReader } from "@qorpera/runtime/cloud-claude-login-reader";
import { afterEach, describe, expect, it } from "vitest";

const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = process.env.FAKE_SCENARIO;
const scenario = JSON.parse(fs.readFileSync(path, "utf8"));
const log = (line) => fs.appendFileSync(path + ".log", line + "\\n");
const args = process.argv.slice(2);
log("ARGS " + JSON.stringify(args));
log("CREDENTIALS " + fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + "/.credentials.json", "utf8"));
log("SETTINGS " + fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + "/.claude.json", "utf8").trim());
if (args[0] === "-p") {
	let buffered = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffered += chunk;
		for (const line of buffered.split("\\n").slice(0, -1)) {
			const request = JSON.parse(line);
			process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { rate_limits: scenario.usage } } }) + "\\n");
		}
		buffered = buffered.slice(buffered.lastIndexOf("\\n") + 1);
	});
} else {
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	const prompt = args[0];
	const kind = prompt.split(" ")[1] || "";
	const draw = (lines) => (lines.some((line) => line.includes("Enter to confirm")) && log("DRAWN confirm"), process.stdout.write("\\x1b[2J\\x1b[H" + ["\\u276f " + prompt, "\\u2500\\u2500\\u2500\\u2500"].concat(lines).join("\\r\\n")));
	draw(scenario.screens[kind] || ["  \\u23bf  " + scenario.otherwise]);
	if (scenario.changeAfterMs) setTimeout(() => draw(["  \\u23bf  " + scenario.changeTo]), scenario.changeAfterMs);
	process.stdin.on("data", (data) => {
		const text = data.toString();
		log("KEY " + JSON.stringify(text));
		if (text.includes("\\x03")) process.exit(0);
		if (text.includes("\\r") && scenario.answer) setTimeout(() => draw(["  \\u23bf  " + scenario.answer]), 100);
	});
	setTimeout(() => process.exit(0), 30000);
}
`;

const confirm = (words: string, count: string, focusYes = true) => [
	`  Use a ${words}?`,
	"",
	`  Refills your 5-hour and weekly limits now · your weekly reset day stays Nov 20, 10:51am`,
	`  ${count} left · use by Dec 1, 10:51am`,
	"",
	`  ${focusYes ? "❯ " : "  "}Yes, use my ${words}`,
	`  ${focusYes ? "  " : "❯ "}No, keep it`,
	"",
	"  Enter to confirm · Esc to cancel",
];

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function reader(scenario: Record<string, unknown>, settleMs = 300) {
	const root = await mkdtemp(join(tmpdir(), "claude-reader-"));
	roots.push(root);
	const claude = join(root, "claude");
	await writeFile(claude, FAKE);
	await chmod(claude, 0o755);
	const scenarioPath = join(root, "scenario.json");
	await writeFile(scenarioPath, JSON.stringify(scenario));
	const read = new ClaudeLoginReader({
		claudePath: claude,
		temporaryRoot: root,
		environment: { FAKE_SCENARIO: scenarioPath },
		timings: { screenMs: 5_000, claimMs: 3_000, settleMs },
	});
	const log = async () => (await readFile(`${scenarioPath}.log`, "utf8").catch(() => "")).split("\n");
	return { read, log, root };
}

const credentials = Buffer.from('{"claudeAiOauth":{"accessToken":"CANARY-READER"}}').toString("base64");
const FULL = { full: confirm("full reset", "3 full resets") };

describe.skipIf(process.platform !== "linux")("Claude Code's screens, read and pressed in a terminal", () => {
	it("hands Claude Code the credentials alone with its onboarding done, reads usage, and wipes the folder", async () => {
		const { read, log, root } = await reader({
			usage: { five_hour: { utilization: 28, resets_at: "2026-11-17T13:25:33+00:00" } },
			screens: { "": FULL.full },
		});
		const result = await read.readClaudeLogin(
			{ credentials, usage: true, resets: true },
			AbortSignal.timeout(20_000),
		);
		expect(result.usage?.windows).toEqual([
			{ id: "five_hour", label: "5 hours", usedPercent: 28, resetAt: "2026-11-17T13:25:33.000Z" },
		]);
		expect(result.resets?.entries).toEqual([
			expect.objectContaining({ kind: "full", left: 3, refills: "5-hour and weekly limits", usable: "now" }),
		]);
		const lines = await log();
		expect(lines).toContain('CREDENTIALS {"claudeAiOauth":{"accessToken":"CANARY-READER"}}');
		expect(lines).toContain('SETTINGS {"hasCompletedOnboarding":true}');
		expect(lines.filter((line) => line.startsWith("KEY ") && line.includes("\\r"))).toEqual([]);
		expect((await readdir(root)).filter((name) => name.startsWith("qorpera-claude-read-"))).toEqual([]);
	});

	it("presses Enter once on the confirm naming the kind asked, with Yes under the cursor, and reads the answer", async () => {
		const { read, log } = await reader({ screens: FULL, answer: "Limits reset · 2 full resets left" });
		expect(await read.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(20_000))).toEqual({
			outcome: "reset",
			left: 2,
		});
		const lines = await log();
		expect(lines).toContain('ARGS ["/limit-reset full"]');
		expect(lines.filter((line) => line === 'KEY "\\r"')).toHaveLength(1);
	});

	it("presses nothing on a confirm of another kind, with No under the cursor, or one that changes while it waits", async () => {
		for (const scenario of [
			{ screens: { weekly: confirm("full reset", "3 full resets") } },
			{ screens: { full: confirm("full reset", "3 full resets", false) } },
		]) {
			const kind = "weekly" in scenario.screens ? "weekly" : "full";
			const { read, log } = await reader(scenario);
			expect(await read.useClaudeReset({ credentials, kind }, AbortSignal.timeout(20_000))).toEqual({
				outcome: "failed",
			});
			expect((await log()).filter((line) => line === 'KEY "\\r"')).toEqual([]);
		}
		const changing = await reader({ screens: FULL, changeAfterMs: 500, changeTo: "Something else" }, 800);
		const started = Date.now();
		expect(await changing.read.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(20_000))).toEqual({
			outcome: "failed",
		});
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(await changing.log()).toContain("DRAWN confirm");
		expect((await changing.log()).filter((line) => line === 'KEY "\\r"')).toEqual([]);
	});

	it("says a reset is not confirmed when Claude Code answers nothing it knows after Enter", async () => {
		const { read, log } = await reader({ screens: FULL });
		expect(await read.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(20_000))).toEqual({
			outcome: "unconfirmed",
		});
		expect((await log()).filter((line) => line === 'KEY "\\r"')).toHaveLength(1);
	});

	it("shows no resets for a screen it does not know", async () => {
		const { read } = await reader({ screens: {}, otherwise: "A new kind of answer" });
		expect(
			(await read.readClaudeLogin({ credentials, usage: false, resets: true }, AbortSignal.timeout(20_000))).resets,
		).toBeNull();
	});
});
