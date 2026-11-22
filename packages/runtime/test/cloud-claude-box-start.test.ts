import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
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

	it("ends the mount forwarding loop without hanging when toMount closes during backpressure (gated and ungated)", async () => {
		const sftpVersion = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]).toString("base64");
		for (const gated of [false, true]) {
			let wrote = false;
			let endedMount = false;
			let iteratorClosed = false;
			const toMount = new Writable({
				highWaterMark: 1,
				write(_chunk, _encoding, _callback) {
					wrote = true;
				},
			});
			const originalEnd = toMount.end.bind(toMount);
			toMount.end = ((...args: Parameters<typeof toMount.end>) => {
				endedMount = true;
				return originalEnd(...args);
			}) as typeof toMount.end;

			let fakeChild: EventEmitter | undefined;
			const fakeSpawn: typeof spawn = (() => {
				const child = new EventEmitter() as unknown as Record<string, unknown>;
				fakeChild = child as unknown as EventEmitter;
				const stdin = new PassThrough();
				const stdout = new PassThrough();
				const stderr = new PassThrough();
				const tokenPipe = new PassThrough();
				const fromMount = new PassThrough();
				child.stdin = stdin;
				child.stdout = stdout;
				child.stderr = stderr;
				child.stdio = [stdin, stdout, stderr, tokenPipe, toMount, fromMount];
				child.pid = undefined;
				child.exitCode = null;
				child.signalCode = null;
				child.kill = () => {
					child.signalCode = "SIGKILL";
					(child as unknown as EventEmitter).emit("close", null, "SIGKILL");
					return true;
				};
				return child;
			}) as unknown as typeof spawn;

			let releaseSecondLine: (() => void) | undefined;
			const lines = (async function* () {
				try {
					yield sftpVersion;
					await new Promise<void>((resolve) => {
						releaseSecondLine = resolve;
					});
					yield sftpVersion;
				} finally {
					iteratorClosed = true;
				}
			})();
			const channel: CloudClaudeHomeChannel = {
				open: async () => ({
					write: () => undefined,
					lines,
					close: async () => {
						releaseSecondLine?.();
						await lines.return(undefined);
					},
				}),
			};
			const box = await startClaudeCodeBox(
				{
					configuration: CLAUDE_BOX_CONFIGURATION,
					scratchRoot: await scratch(),
					login: { token: "sk-ant-oat01-test" },
					channel,
					sessionId: SESSION,
					machineId: MACHINE,
					prompt: "hi",
					signal: new AbortController().signal,
					...(gated
						? {
								review: {
									gate: {} as never,
									machine: {} as never,
									attach: () => undefined,
								},
							}
						: {}),
				},
				fakeSpawn,
			);
			try {
				await vi.waitFor(() => expect(wrote).toBe(true));
				expect(toMount.writableNeedDrain).toBe(true);
				toMount.destroy();
				await vi.waitFor(() => expect(endedMount).toBe(true));
				await vi.waitFor(() => expect(iteratorClosed).toBe(true));
			} finally {
				releaseSecondLine?.();
				fakeChild?.emit("close", 0, null);
				await box.close();
			}
		}
	});
});
