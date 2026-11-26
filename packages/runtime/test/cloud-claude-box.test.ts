import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CLOUD_ACTION_REVIEW_INSTRUCTIONS } from "@qorpera/runtime/cloud-action-review";
import {
	CLAUDE_ACTION_REVIEW_ANSWER,
	CLAUDE_ACTION_REVIEW_MODEL,
	CLAUDE_BOX_CODING_FOLDERS,
	CLAUDE_BOX_CONFIGURATION,
	CLAUDE_BOX_DENY,
	CLAUDE_BOX_HOME_FOLDERS,
	CLAUDE_BOX_PATHS,
	CLAUDE_BOX_SYSTEM_NOTE_MAX_BYTES,
	CLAUDE_BOX_TOOLS,
	CLAUDE_BOX_TOOLS_KEPT_OUT,
	CLAUDE_CODE_MINIMUM_VERSION,
	CLAUDE_CODE_PIN,
	ClaudeCodeReviewer,
	claudeBoxArguments,
	claudeBoxEnvironment,
	claudeBoxInvocation,
	claudeBoxMountOptions,
	claudeBoxSettings,
	claudeBoxStartStage,
	claudeBoxStdoutLines,
	claudeReviewerArguments,
	claudeReviewerInvocation,
	claudeReviewerVerdict,
	claudeWarmReviewerArguments,
	claudeWarmReviewerInvocation,
	startClaudeCodeBox,
	WarmClaudeReviewer,
} from "@qorpera/runtime/cloud-claude-box";
import { expect, it, vi } from "vitest";

const root = join(import.meta.dirname, "../../..");
const scratch = "/var/lib/qorpera-native-provider/runs/abc";
const base = {
	configuration: CLAUDE_BOX_CONFIGURATION,
	scratchRoot: scratch,
	relayPath: `${scratch}/egress.sock`,
	shellSocket: `${scratch}/shell.sock`,
	owner: { uid: 997, gid: 996 },
};

/** The pairs of `--flag a b` in the box's part of the command. */
function pairs(args: readonly string[], flag: string): [string, string][] {
	const found: [string, string][] = [];
	for (let i = 0; i < args.length; i += 1) if (args[i] === flag) found.push([args[i + 1], args[i + 2]]);
	return found;
}

function versionAtLeast(version: string, minimum: string): boolean {
	const a = version.split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
	return true;
}

it("pins the Claude Code the artifact names, never older than 2.1.311", () => {
	const artifact = JSON.parse(
		readFileSync(join(root, "deploy/first-node/native-claude/linux-x64-artifact.json"), "utf8"),
	) as {
		schema: string;
		source: { package: string; version: string; integrity: string };
		artifact: { file: string; bytes: number; sha256: string; modified: boolean };
		minimumVersion: string;
	};
	expect(artifact.schema).toBe("qorpera.native-claude-artifact/v1");
	expect(artifact.source.package).toBe(CLAUDE_CODE_PIN.package);
	expect(artifact.source.version).toBe(CLAUDE_CODE_PIN.version);
	expect(artifact.source.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
	expect(artifact.artifact).toMatchObject({
		file: "claude",
		bytes: CLAUDE_CODE_PIN.bytes,
		sha256: CLAUDE_CODE_PIN.sha256,
		modified: false,
	});
	expect(artifact.minimumVersion).toBe(CLAUDE_CODE_MINIMUM_VERSION);
	expect(CLAUDE_CODE_MINIMUM_VERSION).toBe("2.1.311");
	expect(versionAtLeast(CLAUDE_CODE_PIN.version, CLAUDE_CODE_MINIMUM_VERSION)).toBe(true);
});

it("writes A5's settings: bypass, no sandbox, deny rules on the box's own folders only", () => {
	expect(JSON.parse(claudeBoxSettings())).toEqual({
		permissions: {
			defaultMode: "bypassPermissions",
			deny: ["Read(//slot/**)", "Edit(//slot/**)", "Write(//slot/**)", "Read(//opt/claude/**)"],
		},
		sandbox: { enabled: false },
		attribution: { commit: "", pr: "" },
	});
	// Claude Code applies Read rules to the paths a Bash command names: a rule on a path the home also has would
	// refuse the agent's own commands there (P4 3.6).
	for (const rule of CLAUDE_BOX_DENY) expect(rule).toMatch(/^(Read|Edit|Write)\(\/\/(slot|opt\/claude)\/\*\*\)$/);
	expect(JSON.parse(claudeBoxSettings({ noDenyRules: true })).permissions.deny).toBeUndefined();
});

it("starts Claude Code in print mode with settings from the box alone", () => {
	expect(claudeBoxArguments()).toEqual([
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"bypassPermissions",
		"--settings",
		"/opt/qorpera/settings.json",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--tools",
		"Bash,Read,Edit,Write,NotebookEdit,Grep,Glob,TaskStop,Task,WebSearch,Skill,ToolSearch,TaskCreate,TaskGet,TaskList,TaskUpdate,ReportFindings,Monitor",
	]);
	expect(claudeBoxArguments({ tools: ["Bash", "Read"] }).slice(-2)).toEqual(["--tools", "Bash,Read"]);
	for (const tools of [[], ["Bash", "Bash"], ["Bash", "WebFetch"], ["Workflow"], ["SendMessage"], ["default"]])
		expect(() => claudeBoxArguments({ tools: tools as never })).toThrow("Invalid Claude tools");
	expect(claudeBoxArguments({ model: "claude-opus-5-5" }).slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
	expect(() => claudeBoxArguments({ model: "x --settings /tmp/evil" })).toThrow("Invalid Claude model");
	expect(claudeBoxArguments({ model: "claude-fable-5-2", effort: "xhigh" }).slice(-4)).toEqual([
		"--model",
		"claude-fable-5-2",
		"--effort",
		"xhigh",
	]);
	for (const effort of ["low", "medium", "high", "xhigh", "max"])
		expect(claudeBoxArguments({ effort }).slice(-2)).toEqual(["--effort", effort]);
	for (const effort of ["", "ultra", "high --settings /tmp/evil"])
		expect(() => claudeBoxArguments({ effort })).toThrow("Invalid Claude effort");
	expect(claudeBoxArguments()).not.toContain("--effort");
});

it("offers every built-in tool of Claude Code 2.1.325's print mode but the ten that reach past the box or the run", () => {
	const printMode = [
		"Task",
		"Bash",
		"CronCreate",
		"CronDelete",
		"CronList",
		"Edit",
		"EnterWorktree",
		"ExitWorktree",
		"Glob",
		"Grep",
		"ListAgents",
		"Monitor",
		"NotebookEdit",
		"Read",
		"ReportFindings",
		"ScheduleWakeup",
		"SendMessage",
		"Skill",
		"TaskCreate",
		"TaskGet",
		"TaskList",
		"TaskStop",
		"TaskUpdate",
		"ToolSearch",
		"WebFetch",
		"WebSearch",
		"Workflow",
		"Write",
	];
	const keptOut = Object.keys(CLAUDE_BOX_TOOLS_KEPT_OUT);
	expect(keptOut.sort()).toEqual([
		"CronCreate",
		"CronDelete",
		"CronList",
		"EnterWorktree",
		"ExitWorktree",
		"ListAgents",
		"ScheduleWakeup",
		"SendMessage",
		"WebFetch",
		"Workflow",
	]);
	expect([...CLAUDE_BOX_TOOLS, ...keptOut].sort()).toEqual(printMode.sort());
	for (const tool of keptOut)
		expect(() => claudeBoxArguments({ tools: [tool as never] })).toThrow("Invalid Claude tools");
	expect(claudeBoxArguments().at(-1)?.split(",")).toEqual([...CLAUDE_BOX_TOOLS]);
});

it("hands a token in on descriptor 3 only, and keeps HOME and the config folder in the box", () => {
	const token = claudeBoxEnvironment({ login: "token" });
	expect(token.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe("3");
	expect(token.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	expect(token.HOME).toBe("/slot/home");
	expect(token.CLAUDE_CONFIG_DIR).toBe("/slot/config");
	expect(token.CLAUDE_CODE_SHELL_PREFIX).toBe("/opt/qorpera/home-shell");
	// Grep and Glob run the home's ripgrep through the bridge first on PATH.
	expect(token.USE_BUILTIN_RIPGREP).toBe("0");
	expect(token.PATH).toBe("/opt/qorpera/bin:/usr/bin:/bin");
	expect(token.NODE_EXTRA_CA_CERTS).toBeUndefined();
	const folder = claudeBoxEnvironment({ login: "folder" });
	expect(folder.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
	for (const environment of [token, folder])
		for (const folderOfHome of CLAUDE_BOX_HOME_FOLDERS) {
			expect(environment.HOME.startsWith(folderOfHome)).toBe(false);
			expect(environment.CLAUDE_CONFIG_DIR.startsWith(folderOfHome)).toBe(false);
		}
});

it("mounts the home with links resolved there, nothing on it runnable, every file shown as the box's account", () => {
	expect(claudeBoxMountOptions({ uid: 997, gid: 996 })).toBe(
		"passive,nosuid,nodev,noexec,follow_symlinks,uid=997,gid=996",
	);
	expect(claudeBoxMountOptions({ uid: 997, gid: 996 }, { noFollowSymlinks: true })).toBe(
		"passive,nosuid,nodev,noexec,uid=997,gid=996",
	);
	expect(() => claudeBoxMountOptions({ uid: 0, gid: 0 })).toThrow("Invalid box account");
});

it("starts Claude Code in the box on the model and effort it is given", () => {
	expect(
		claudeBoxInvocation({ ...base, login: "token", model: "claude-opus-5-5", effort: "max" }).args.slice(-4),
	).toEqual(["--model", "claude-opus-5-5", "--effort", "max"]);
	expect(claudeBoxInvocation({ ...base, login: "token" }).args).not.toContain("--effort");
});

it("makes the mount in the run's own namespace and starts the box without a capability", () => {
	const { command, args } = claudeBoxInvocation({ ...base, login: "token" });
	expect(command).toBe("/opt/qorpera-runner/qorpera-claude-box-ns");
	const split = args.indexOf("/usr/bin/bwrap");
	expect(args.slice(0, split)).toEqual([
		"--user",
		"--map-current-user",
		"--keep-caps",
		"--mount",
		"--pid",
		"--fork",
		"--kill-child",
		"--mount-proc",
		"--",
		"/bin/bash",
		"/opt/qorpera-runner/qorpera-claude-box-stage.sh",
		`${scratch}/mnt`,
		"/usr/bin/sshfs",
		"passive,nosuid,nodev,noexec,follow_symlinks,uid=997,gid=996",
		"--",
	]);
	const box = args.slice(split + 1);
	for (const flag of ["--unshare-user", "--unshare-net", "--disable-userns", "--die-with-parent", "--clearenv"])
		expect(box).toContain(flag);
	expect(box.slice(box.indexOf("--cap-drop"), box.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
	const binds = pairs(box, "--bind");
	expect(binds).toEqual([
		[`${scratch}/slot-config`, "/slot/config"],
		[`${scratch}/slot-home`, "/slot/home"],
		[`${scratch}/mnt/company`, "/company"],
		[`${scratch}/mnt/var/lib/qorpera-agent`, "/var/lib/qorpera-agent"],
		[`${scratch}/mnt/tmp`, "/tmp"],
	]);
	const readOnly = pairs(box, "--ro-bind");
	expect(readOnly).toContainEqual(["/opt/qorpera-harnesses/native-claude/claude", CLAUDE_BOX_PATHS.binary]);
	expect(readOnly).toContainEqual([`${scratch}/settings.json`, CLAUDE_BOX_PATHS.settings]);
	expect(readOnly).toContainEqual([`${scratch}/shell.sock`, CLAUDE_BOX_PATHS.shellSocket]);
	expect(readOnly).toContainEqual([`${scratch}/rg`, "/opt/qorpera/bin/rg"]);
	// The run host's own /etc never enters the box whole.
	expect(readOnly.filter(([, inside]) => inside.startsWith("/etc")).map(([, inside]) => inside)).toEqual([
		"/etc/ssl/certs",
		"/etc/ld.so.cache",
		"/etc/passwd",
		"/etc/group",
	]);
	expect(box.slice(-17)).toEqual([
		"/usr/bin/node",
		"/opt/qorpera/native-entry.mjs",
		`${scratch}/egress.sock`,
		"/opt/claude/claude",
		...claudeBoxArguments(),
	]);
	const environment = pairs(box, "--setenv");
	expect(Object.fromEntries(environment)).toEqual(claudeBoxEnvironment({ login: "token" }));
});

it("mounts a login folder as Claude Code's config folder and never a token's variable with it", () => {
	const { args } = claudeBoxInvocation({ ...base, login: { folder: "/var/lib/qorpera-claude-logins/m1" } });
	const box = args.slice(args.indexOf("/usr/bin/bwrap") + 1);
	expect(pairs(box, "--bind")[0]).toEqual(["/var/lib/qorpera-claude-logins/m1", "/slot/config"]);
	expect(Object.fromEntries(pairs(box, "--setenv")).CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
});

it("asks the file tools' hook of the host before each change, only in a box whose work is reviewed", () => {
	expect(JSON.parse(claudeBoxSettings()).hooks).toBeUndefined();
	expect(JSON.parse(claudeBoxSettings(undefined, { reviewHook: true })).hooks).toEqual({
		PreToolUse: [
			{
				matcher: "Write|Edit|NotebookEdit",
				hooks: [{ type: "command", command: "/opt/qorpera/review-hook", timeout: 600 }],
			},
		],
	});
	const plain = pairs(claudeBoxInvocation({ ...base, login: "token" }).args, "--ro-bind");
	const reviewed = pairs(claudeBoxInvocation({ ...base, login: "token", reviewHook: true }).args, "--ro-bind");
	expect(plain).not.toContainEqual([`${scratch}/review-hook`, CLAUDE_BOX_PATHS.reviewHook]);
	expect(reviewed).toContainEqual([`${scratch}/review-hook`, CLAUDE_BOX_PATHS.reviewHook]);
});

it("reviews in a box of its own: no tools, no home, no shell, the run's own sign-in and model", () => {
	const root = `${scratch}/rAbc123`;
	const args = claudeReviewerInvocation({
		configuration: CLAUDE_BOX_CONFIGURATION,
		root,
		relayPath: `${root}/egress.sock`,
		login: { folder: "/var/lib/qorpera-claude-logins/m1" },
		model: CLAUDE_ACTION_REVIEW_MODEL,
	});
	expect(pairs(args, "--bind")).toEqual([
		["/var/lib/qorpera-claude-logins/m1", "/slot/config"],
		[`${root}/h`, "/slot/home"],
	]);
	const readOnly = pairs(args, "--ro-bind").map(([, inside]) => inside);
	for (const inside of [
		CLAUDE_BOX_PATHS.shellSocket,
		CLAUDE_BOX_PATHS.shellPrefix,
		"/opt/qorpera/bin/rg",
		...CLAUDE_BOX_HOME_FOLDERS,
	])
		expect(readOnly).not.toContain(inside);
	expect(args.slice(args.indexOf("--") + 1)).toEqual([
		"/usr/bin/node",
		"/opt/qorpera/native-entry.mjs",
		`${root}/egress.sock`,
		"/opt/claude/claude",
		...claudeReviewerArguments(CLAUDE_ACTION_REVIEW_MODEL),
	]);
	expect(claudeReviewerArguments("haiku")).toEqual([
		"-p",
		"--output-format",
		"json",
		"--max-turns",
		"1",
		"--tools",
		"",
		"--settings",
		"/opt/qorpera/settings.json",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--system-prompt-file",
		"/opt/qorpera/system-note.md",
		"--model",
		"haiku",
	]);
	expect(() => claudeReviewerArguments("haiku --tools Bash")).toThrow("Invalid Claude model");
	const token = claudeReviewerInvocation({
		configuration: CLAUDE_BOX_CONFIGURATION,
		root,
		relayPath: `${root}/egress.sock`,
		login: "token",
		model: "haiku",
	});
	expect(pairs(token, "--bind")[0]).toEqual([`${root}/c`, "/slot/config"]);
	expect(Object.fromEntries(pairs(token, "--setenv")).CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe("3");
	expect(CLAUDE_ACTION_REVIEW_ANSWER).toContain('"guards"');
	expect(CLOUD_ACTION_REVIEW_INSTRUCTIONS).toContain("qorpera.review_verdict");
});

it("reads the verdict from the reviewer's one result, and nothing else", () => {
	const verdict = { decision: "allow", ruleIds: [], builtIn: "none", reason: "Fine.", proposedRule: "" };
	const result = (text: string, error = false) =>
		JSON.stringify({ type: "result", subtype: error ? "error_max_turns" : "success", is_error: error, result: text });
	expect(claudeReviewerVerdict(`${result(`Here: ${JSON.stringify(verdict)}`)}\n`)).toEqual(verdict);
	expect(() => claudeReviewerVerdict(result(JSON.stringify(verdict), true))).toThrow("no verdict");
	expect(() => claudeReviewerVerdict(result("I cannot decide."))).toThrow("no verdict");
	expect(() => claudeReviewerVerdict("")).toThrow();
});

it("reviews one at a time, and a closed reviewer starts none", async () => {
	let running = 0;
	let most = 0;
	const run = vi.fn(async () => {
		running += 1;
		most = Math.max(most, running);
		await new Promise((resolve) => setTimeout(resolve, 10));
		running -= 1;
		return { decision: "allow" };
	});
	const reviewer = new ClaudeCodeReviewer(run);
	const input = { instructions: "i", prompt: "p", model: "haiku", effort: "low" as const };
	await Promise.all([1, 2, 3].map(() => reviewer.review(input, new AbortController().signal)));
	expect(most).toBe(1);
	expect(reviewer.reviews).toBe(3);
	reviewer.close();
	await expect(reviewer.review(input, new AbortController().signal)).rejects.toThrow();
	expect(run).toHaveBeenCalledTimes(3);
});

it("rejects an aborted queued review immediately while keeping subsequent waiters serialized", async () => {
	let releaseFirst!: () => void;
	const order: string[] = [];
	const run = vi.fn(async (input: { prompt: string }) => {
		order.push(`start:${input.prompt}`);
		if (input.prompt === "first") {
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
		}
		order.push(`end:${input.prompt}`);
		return { decision: "allow" };
	});
	const reviewer = new ClaudeCodeReviewer(run);
	const base = { instructions: "i", model: "haiku", effort: "low" as const };
	const first = reviewer.review({ ...base, prompt: "first" }, new AbortController().signal);
	const abortSecond = new AbortController();
	const second = reviewer.review({ ...base, prompt: "second" }, abortSecond.signal);
	const third = reviewer.review({ ...base, prompt: "third" }, new AbortController().signal);
	abortSecond.abort(new Error("cancelled"));
	await expect(second).rejects.toThrow("cancelled");
	expect(order).toEqual(["start:first"]);
	releaseFirst();
	await Promise.all([first, third]);
	expect(order).toEqual(["start:first", "end:first", "start:third", "end:third"]);
});

it("splits stdout chunks linearly, notifies on trailing unterminated lines, and fails closed on overflow", async () => {
	const noticed: string[] = [];
	const yielded: string[] = [];
	async function* chunks() {
		yield '{"a":';
		yield '1}\n{"b":2}\n{"c":';
		yield "3}";
	}
	for await (const line of claudeBoxStdoutLines(chunks(), (line) => noticed.push(line), undefined, 64)) {
		yielded.push(line);
	}
	expect(yielded).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	expect(noticed).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);

	let overflowed = 0;
	const beforeOverflow: string[] = [];
	async function* huge() {
		yield "ok\n";
		yield "x".repeat(40);
		yield "y".repeat(40);
		yield "\nafter\n";
	}
	for await (const line of claudeBoxStdoutLines(
		huge(),
		(line) => beforeOverflow.push(line),
		() => {
			overflowed += 1;
		},
		64,
	)) {
		expect(line).toBe("ok");
	}
	expect(beforeOverflow).toEqual(["ok"]);
	expect(overflowed).toBe(1);
});

it("keeps a warm stream-json reviewer alive across allow verdicts, recycles on deny/ask or config change, and falls back once on early exit", async () => {
	const warmArgs = claudeWarmReviewerArguments("haiku");
	expect(warmArgs).toEqual([
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--tools",
		"",
		"--settings",
		"/opt/qorpera/settings.json",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--system-prompt-file",
		"/opt/qorpera/system-note.md",
		"--model",
		"haiku",
	]);
	expect(warmArgs).not.toContain("--max-turns");
	expect(() => claudeWarmReviewerArguments("haiku --tools Bash")).toThrow("Invalid Claude model");
	const inv = claudeWarmReviewerInvocation({
		configuration: CLAUDE_BOX_CONFIGURATION,
		root: `${scratch}/rw1`,
		relayPath: `${scratch}/egress.sock`,
		login: { folder: "/var/lib/qorpera-claude-logins/m1" },
		model: "haiku",
	});
	expect(inv.slice(inv.indexOf("--") + 1)).toEqual([
		"/usr/bin/node",
		"/opt/qorpera/native-entry.mjs",
		`${scratch}/egress.sock`,
		"/opt/claude/claude",
		...warmArgs,
	]);

	const temp = await mkdtemp(join(tmpdir(), "qorpera-warm-claude-reviewer-"));
	try {
		const spawnedArgs: string[][] = [];
		let failFirstWarm = false;
		const spawnBox = vi.fn((_cmd: string, args: readonly string[]) => {
			spawnedArgs.push([...args]);
			const child = new EventEmitter() as EventEmitter & {
				pid: number;
				exitCode: number | null;
				signalCode: NodeJS.Signals | null;
				stdio: [PassThrough, PassThrough, PassThrough, PassThrough | null];
				kill: (sig?: NodeJS.Signals) => boolean;
			};
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const fd3 = new PassThrough();
			child.pid = 999_999;
			child.exitCode = null;
			child.signalCode = null;
			child.stdio = [stdin, stdout, stderr, fd3];
			child.kill = () => {
				if (child.exitCode === null) {
					child.exitCode = 137;
					stdout.end();
					child.emit("close", 137, "SIGKILL");
				}
				return true;
			};
			const isWarm = args.includes("--input-format");
			let buffer = "";
			stdin.setEncoding("utf8");
			stdin.on("data", (chunk: string) => {
				buffer += chunk;
				if (!isWarm) return;
				while (buffer.includes("\n")) {
					const idx = buffer.indexOf("\n");
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (failFirstWarm) {
						failFirstWarm = false;
						child.exitCode = 1;
						stdout.end();
						child.emit("close", 1, null);
						return;
					}
					const msg = JSON.parse(line) as { message: { content: string } };
					const decision = msg.message.content.includes("DENY")
						? "deny"
						: msg.message.content.includes("ASK")
							? "ask"
							: "allow";
					stdout.write(`${JSON.stringify({ type: "assistant", message: {} })}\n`);
					stdout.write(
						`${JSON.stringify({
							type: "result",
							is_error: false,
							result: JSON.stringify({
								decision,
								ruleIds: [],
								builtIn: "none",
								reason: decision,
								proposedRule: "",
							}),
						})}\n`,
					);
				}
			});
			stdin.on("end", () => {
				if (isWarm) return;
				stdout.end(
					`${JSON.stringify({
						type: "result",
						is_error: false,
						result: JSON.stringify({
							decision: "allow",
							ruleIds: [],
							builtIn: "none",
							reason: "cold-fallback",
							proposedRule: "",
						}),
					})}\n`,
				);
				child.exitCode = 0;
				child.emit("close", 0, null);
			});
			return child as never;
		});

		const warm = new WarmClaudeReviewer({
			configuration: CLAUDE_BOX_CONFIGURATION,
			scratchRoot: temp,
			relayPath: join(temp, "egress.sock"),
			login: { folder: temp },
			spawnBox: spawnBox as never,
		});
		const signal = new AbortController().signal;
		const baseInput = { instructions: "rule-set-1", model: "haiku", effort: "low" as const };
		// WHY: Two consecutive allow verdicts reuse a single warm process.
		expect(await warm.review({ ...baseInput, prompt: "allow-1" }, signal)).toMatchObject({ decision: "allow" });
		expect(await warm.review({ ...baseInput, prompt: "allow-2" }, signal)).toMatchObject({ decision: "allow" });
		expect(spawnBox).toHaveBeenCalledTimes(1);
		// WHY: Deny verdict recycles the process immediately so refusal context never leaks into the next review.
		expect(await warm.review({ ...baseInput, prompt: "DENY-3" }, signal)).toMatchObject({ decision: "deny" });
		expect(spawnBox).toHaveBeenCalledTimes(1);
		expect(await warm.review({ ...baseInput, prompt: "allow-4" }, signal)).toMatchObject({ decision: "allow" });
		expect(spawnBox).toHaveBeenCalledTimes(2);
		// WHY: Changing instructions recycles the warm process.
		expect(await warm.review({ ...baseInput, instructions: "rule-set-2", prompt: "allow-5" }, signal)).toMatchObject({
			decision: "allow",
		});
		expect(spawnBox).toHaveBeenCalledTimes(3);
		// WHY: If a warm process exits before emitting a result, it falls back once to single-shot cold review.
		await warm.close();
		const warmFallback = new WarmClaudeReviewer({
			configuration: CLAUDE_BOX_CONFIGURATION,
			scratchRoot: temp,
			relayPath: join(temp, "egress.sock"),
			login: { folder: temp },
			spawnBox: spawnBox as never,
		});
		failFirstWarm = true;
		expect(await warmFallback.review({ ...baseInput, prompt: "fallback-6" }, signal)).toMatchObject({
			decision: "allow",
			reason: "cold-fallback",
		});
		expect(spawnBox).toHaveBeenCalledTimes(5);
		expect(spawnedArgs.at(-2)).toContain("--input-format");
		expect(spawnedArgs.at(-1)).toContain("--max-turns");
		await warmFallback.close();
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

it("supports custom homeFolders, cwd, and local MCP bridge config for coding sessions", () => {
	expect(CLAUDE_BOX_CODING_FOLDERS).toEqual(["/company", "/tmp"]);
	expect(CLAUDE_BOX_SYSTEM_NOTE_MAX_BYTES).toBe(65_536);
	const argsWithMcp = claudeBoxArguments({ mcpConfig: true });
	expect(argsWithMcp).toContain("--strict-mcp-config");
	expect(argsWithMcp.slice(argsWithMcp.indexOf("--mcp-config"), argsWithMcp.indexOf("--mcp-config") + 2)).toEqual([
		"--mcp-config",
		CLAUDE_BOX_PATHS.mcpConfig,
	]);
	const invocation = claudeBoxInvocation({
		...base,
		login: { folder: "/var/lib/qorpera-native-provider/login" },
		homeFolders: CLAUDE_BOX_CODING_FOLDERS,
		cwd: "/company/code/app/web/worktrees/w1",
		mcp: { socketPath: `${scratch}/mcp.sock`, serverName: "qorpera" },
		model: "claude-opus-5-5",
		effort: "high",
		systemNote: true,
	});
	const split = invocation.args.indexOf("/usr/bin/bwrap");
	const box = invocation.args.slice(split + 1);
	const binds = pairs(box, "--bind");
	expect(binds).toEqual([
		["/var/lib/qorpera-native-provider/login", "/slot/config"],
		[`${scratch}/slot-home`, "/slot/home"],
		[`${scratch}/mnt/company`, "/company"],
		[`${scratch}/mnt/tmp`, "/tmp"],
	]);
	const roBinds = pairs(box, "--ro-bind");
	expect(roBinds).toContainEqual([`${scratch}/mcp.sock`, CLAUDE_BOX_PATHS.mcpSocket]);
	expect(roBinds).toContainEqual([`${scratch}/mcp-client`, CLAUDE_BOX_PATHS.mcpClient]);
	expect(roBinds).toContainEqual([`${scratch}/mcp-config.json`, CLAUDE_BOX_PATHS.mcpConfig]);
	expect(box.slice(box.indexOf("--chdir"), box.indexOf("--chdir") + 2)).toEqual([
		"--chdir",
		"/company/code/app/web/worktrees/w1",
	]);
	expect(box).toContain("--mcp-config");
	expect(box).toContain(CLAUDE_BOX_PATHS.mcpConfig);
	expect(Object.fromEntries(pairs(box, "--setenv")).ENABLE_TOOL_SEARCH).toBe("false");
	expect(claudeBoxEnvironment({ login: "folder" }).ENABLE_TOOL_SEARCH).toBeUndefined();
	expect(claudeBoxEnvironment({ login: "folder", mcp: true }).ENABLE_TOOL_SEARCH).toBe("false");
	expect(() => claudeBoxInvocation({ ...base, login: "token", homeFolders: [] })).toThrow(
		"Invalid Claude box home folders",
	);
	expect(() => claudeBoxInvocation({ ...base, login: "token", homeFolders: ["/company", "/company"] })).toThrow(
		"Invalid Claude box home folders",
	);
	expect(() => claudeBoxInvocation({ ...base, login: "token", homeFolders: ["/company/../etc"] })).toThrow(
		"Invalid Claude box home folders",
	);
	expect(() =>
		claudeBoxInvocation({
			...base,
			login: "token",
			homeFolders: CLAUDE_BOX_CODING_FOLDERS,
			cwd: "/var/lib/qorpera-agent",
		}),
	).toThrow("Invalid Claude box working directory");
	expect(() => claudeBoxInvocation({ ...base, login: "token", mcp: { socketPath: "relative.sock" } })).toThrow(
		"Invalid Claude MCP socket",
	);
	expect(() =>
		claudeBoxInvocation({
			...base,
			login: "token",
			mcp: { socketPath: `${scratch}/mcp.sock`, serverName: "Bad Name" },
		}),
	).toThrow("Invalid Claude MCP server name");
});

it.skipIf(process.platform !== "linux")(
	"accepts 16-64 KiB systemNote past the arguments stage and rejects notes above CLAUDE_BOX_SYSTEM_NOTE_MAX_BYTES",
	async () => {
		const dummyChannel = { open: vi.fn() };
		const baseStart = {
			configuration: CLAUDE_BOX_CONFIGURATION,
			scratchRoot: "/nonexistent-qorpera-claude-box-scratch",
			login: { token: "tok-123" },
			channel: dummyChannel,
			sessionId: "00000000-0000-4000-8000-000000000001",
			machineId: "00000000-0000-4000-8000-000000000002",
			prompt: "hi",
			signal: new AbortController().signal,
		};
		let acceptedErr: unknown;
		try {
			await startClaudeCodeBox({ ...baseStart, systemNote: "x".repeat(20_000) }, vi.fn() as never);
		} catch (error) {
			acceptedErr = error;
		}
		expect(claudeBoxStartStage(acceptedErr)).toBe("scratch");

		for (const badNote of ["", "x".repeat(CLAUDE_BOX_SYSTEM_NOTE_MAX_BYTES + 1)]) {
			let rejectedErr: unknown;
			try {
				await startClaudeCodeBox({ ...baseStart, systemNote: badNote }, vi.fn() as never);
			} catch (error) {
				rejectedErr = error;
			}
			expect(rejectedErr).toBeInstanceOf(Error);
			expect((rejectedErr as Error).message).toBe("Invalid Claude system note");
			expect(claudeBoxStartStage(rejectedErr)).toBe("arguments");
		}
		let reviewTmpErr: unknown;
		try {
			await startClaudeCodeBox(
				{
					...baseStart,
					tmpDir: "/tmp/qc-0123456789ab",
					review: {
						machine: { id: baseStart.machineId, name: "home" },
						gate: { check: vi.fn() },
						attach: vi.fn(),
					},
				},
				vi.fn() as never,
			);
		} catch (error) {
			reviewTmpErr = error;
		}
		expect(reviewTmpErr).toBeInstanceOf(Error);
		expect((reviewTmpErr as Error).message).toBe("Invalid Claude tmpDir");
		expect(claudeBoxStartStage(reviewTmpErr)).toBe("arguments");
	},
);

it("sets CLAUDE_CODE_TMPDIR when tmpDir is provided and rejects unsafe tmpDir paths", () => {
	expect(claudeBoxEnvironment({ login: "folder" }).CLAUDE_CODE_TMPDIR).toBeUndefined();
	expect(claudeBoxEnvironment({ login: "folder", tmpDir: "/tmp/qc-0123456789ab" }).CLAUDE_CODE_TMPDIR).toBe(
		"/tmp/qc-0123456789ab",
	);
	const inv = claudeBoxInvocation({
		...base,
		login: { folder: `${scratch}/login` },
		tmpDir: "/tmp/qc-0123456789ab",
	});
	expect(pairs(inv.args, "--setenv")).toContainEqual(["CLAUDE_CODE_TMPDIR", "/tmp/qc-0123456789ab"]);
	for (const bad of [
		"",
		"/tmp",
		"/tmp/",
		"/tmp/.",
		"/tmp/..",
		"/tmp/a/b",
		"/var/tmp/qc-1",
		`/tmp/${"a".repeat(65)}`,
	]) {
		expect(() => claudeBoxEnvironment({ login: "folder", tmpDir: bad })).toThrow("Invalid Claude tmpDir");
		expect(() =>
			claudeBoxInvocation({
				...base,
				login: { folder: `${scratch}/login` },
				tmpDir: bad,
			}),
		).toThrow("Invalid Claude tmpDir");
	}
	expect(() =>
		claudeBoxInvocation({
			...base,
			login: { folder: `${scratch}/login` },
			homeFolders: ["/company"],
			cwd: "/company",
			tmpDir: "/tmp/qc-0123456789ab",
		}),
	).toThrow("Invalid Claude tmpDir");
	expect(() =>
		claudeBoxInvocation({
			...base,
			login: { folder: `${scratch}/login` },
			reviewHook: true,
			tmpDir: "/tmp/qc-0123456789ab",
		}),
	).toThrow("Invalid Claude tmpDir");
});
