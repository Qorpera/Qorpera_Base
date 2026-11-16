import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BOX_CONFIGURATION, claudeBoxStartStage, startClaudeCodeBox } from "@qorpera/runtime/cloud-claude-box";
import type { CloudClaudeHomeChannel } from "@qorpera/runtime/cloud-claude-home-shell";
import { claudeBoxFailureCode } from "@qorpera/runtime/cloud-claude-worker";
import { afterEach, describe, expect, it, vi } from "vitest";

const SESSION = "00000000-0000-4000-8000-000000000001";
const MACHINE = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A private scratch root, four levels deep as privateDirectory wants it. */
async function scratch(): Promise<string> {
	const base = mkdtempSync(join(tmpdir(), "claude-box-start-"));
	roots.push(base);
	const root = join(base, "run");
	await mkdir(root, { mode: 0o700 });
	return root;
}

/** The home's channels, recording what was opened and closed; `refuse` makes the file channel's opening fail. */
function home(refuse = false) {
	const opened: string[] = [];
	const closed: string[] = [];
	const channel: CloudClaudeHomeChannel = {
		open: async (input) => {
			if (refuse && input.kind === "sftp") throw new Error("refused");
			opened.push(input.kind ?? "exec");
			return {
				write: () => undefined,
				lines: (async function* () {})(),
				close: async () => {
					closed.push(input.kind ?? "exec");
				},
			};
		},
	};
	return { channel, opened, closed };
}

/** A stand-in for the box's process: it runs until it is killed, with the box's six descriptors. */
const standIn: typeof spawn = ((_command: string, _args: readonly string[], options: object) =>
	spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)) as unknown as typeof spawn;

describe.skipIf(process.platform !== "linux")("the box's start", () => {
	it("ends the box, both channels and the session when the run is stopped (review round 1, F1)", async () => {
		const controller = new AbortController();
		const { channel, opened, closed } = home();
		const ended: string[] = [];
		const box = await startClaudeCodeBox(
			{
				configuration: CLAUDE_BOX_CONFIGURATION,
				scratchRoot: await scratch(),
				login: { token: "sk-ant-oat01-test" },
				channel,
				sessionId: SESSION,
				machineId: MACHINE,
				endSession: async (id, reason) => {
					ended.push(`${id}:${reason}`);
				},
				prompt: "hi",
				signal: controller.signal,
			},
			standIn,
		);
		expect(opened).toEqual(["sftp"]);
		controller.abort();
		const code = await Promise.race([
			box.exited,
			new Promise((resolve) => setTimeout(() => resolve("running"), 3000)),
		]);
		expect(code).toBe(137);
		await box.close();
		expect(closed).toEqual(["sftp"]);
		expect(ended).toEqual([`${SESSION}:stopped`]);
	});

	it("leaves the session alone when no channel of it ever opened (review round 1, F3)", async () => {
		const { channel } = home(true);
		const ended: string[] = [];
		await expect(
			startClaudeCodeBox(
				{
					configuration: CLAUDE_BOX_CONFIGURATION,
					scratchRoot: await scratch(),
					login: { token: "sk-ant-oat01-test" },
					channel,
					sessionId: SESSION,
					machineId: MACHINE,
					endSession: async (id, reason) => {
						ended.push(`${id}:${reason}`);
					},
					prompt: "hi",
					signal: new AbortController().signal,
				},
				standIn,
			),
		).rejects.toThrow("refused");
		expect(ended).toEqual([]);
	});

	it("refuses a scratch root whose sockets would not fit before anything of the home opens, and names the stage", async () => {
		const base = mkdtempSync(join(tmpdir(), "claude-box-start-"));
		roots.push(base);
		const root = join(base, "r".repeat(Math.max(1, 101 - base.length)));
		await mkdir(root, { mode: 0o700 });
		const { channel, opened } = home();
		const failure = await startClaudeCodeBox(
			{
				configuration: CLAUDE_BOX_CONFIGURATION,
				scratchRoot: root,
				login: { token: "sk-ant-oat01-test" },
				channel,
				sessionId: SESSION,
				machineId: MACHINE,
				prompt: "hi",
				signal: new AbortController().signal,
			},
			standIn,
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(String(failure)).toContain("The Claude Code box's socket path too long");
		expect(claudeBoxStartStage(failure)).toBe("socket-path");
		expect(claudeBoxFailureCode(failure)).toBe("box-socket-path");
		expect(opened).toEqual([]);
		expect(readdirSync(root)).toEqual([]);
		const refused = home(true);
		const closedChannel = await startClaudeCodeBox(
			{
				configuration: CLAUDE_BOX_CONFIGURATION,
				scratchRoot: await scratch(),
				login: { token: "sk-ant-oat01-test" },
				channel: refused.channel,
				sessionId: SESSION,
				machineId: MACHINE,
				prompt: "hi",
				signal: new AbortController().signal,
			},
			standIn,
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(claudeBoxFailureCode(closedChannel)).toBe("box-files-channel");
	});

	it("refuses a tool or a model it does not know before anything of the home opens (review round 2, F3)", async () => {
		for (const bad of [
			{ tools: ["Bash", "WebFetch"] },
			{ tools: ["Bash", "Bash"] },
			{ tools: [] },
			{ model: "claude opus --dangerously-skip-permissions" },
			{ effort: "max --dangerously-skip-permissions" },
		]) {
			const { channel, opened } = home();
			const ended: string[] = [];
			const root = await scratch();
			await expect(
				startClaudeCodeBox(
					{
						configuration: CLAUDE_BOX_CONFIGURATION,
						scratchRoot: root,
						login: { token: "sk-ant-oat01-test" },
						channel,
						sessionId: SESSION,
						machineId: MACHINE,
						endSession: async (id, reason) => {
							ended.push(`${id}:${reason}`);
						},
						prompt: "hi",
						signal: new AbortController().signal,
						...(bad as object),
					},
					standIn,
				),
			).rejects.toThrow(/Invalid Claude (tools|model|effort)/);
			expect(opened).toEqual([]);
			expect(ended).toEqual([]);
			// Nothing of the box was made in the run's folder either.
			expect(readdirSync(root)).toEqual([]);
		}
	});

	it("never starts as root (review round 2, F1)", async () => {
		const { channel, opened } = home();
		const account = vi.spyOn(process, "getuid").mockReturnValue(0);
		try {
			await expect(
				startClaudeCodeBox(
					{
						configuration: CLAUDE_BOX_CONFIGURATION,
						scratchRoot: await scratch(),
						login: { token: "sk-ant-oat01-test" },
						channel,
						sessionId: SESSION,
						machineId: MACHINE,
						prompt: "hi",
						signal: new AbortController().signal,
					},
					standIn,
				),
			).rejects.toThrow("The Claude Code box needs unprivileged Linux");
		} finally {
			account.mockRestore();
		}
		expect(opened).toEqual([]);
	});
});
