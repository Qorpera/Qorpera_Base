// The Claude Code box on the run host (lanes/agent-box-20261113/CLAUDE-HOME-BUILD.md, slice C2; the set-up A5 that
// P4-CLAUDE-CODE-ON-THE-HOME.md proved).
//
// One run's UNMODIFIED Claude Code, pinned, in a sealed box beside the agent's home. Its sign-in and its program stay
// in the box; its work happens on the home:
//
//   run host                                                              | the agent's home (the agent is root there)
//   this driver --exec channel (one per run, the mux) --------------------+--> `codex exec-server` (as qorpera-agent)
//              --sftp channel (the same home session) -------------------+--> `sftp-server` (as qorpera-agent)
//   qorpera-claude-box-ns (user + mount + PID namespace of the run's own)
//     sshfs (passive, over the sftp channel) mounted at <scratch>/mnt, seen only in this namespace
//     bwrap, no capability, no network but Anthropic through the egress relay:
//       Claude Code -p, sign-in on descriptor 3 or its own login folder at /slot/config
//         Bash      -> CLAUDE_CODE_SHELL_PREFIX -> /run/qorpera-home/shell.sock -> the mux -> the home
//         Read/Edit/Write/NotebookEdit -> /company, /var/lib/qorpera-agent, /tmp = the home's, through the mount
//
// What holds the sign-in where it is (P4 section 3.3, each of these was needed):
// - the token on a descriptor, never a file, an argument or the environment (or Claude Code's own login folder,
//   which this driver never opens);
// - deny rules for the box's own paths only: `Read/Edit/Write(//slot/**)`, `Read(//opt/claude/**)`; never `/etc`,
//   `/usr` or `/proc` (Claude Code applies Read rules to the paths a Bash command names, and those mean the home's);
// - settings from the box alone: `--settings <read-only file> --setting-sources user --strict-mcp-config`;
// - links resolved on the home (sshfs `follow_symlinks`), so a planted link means what it means on the home;
// - HOME and CLAUDE_CONFIG_DIR under /slot, never on the home (the shell snapshot's login shell reads HOME).

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CLOUD_ACTION_REVIEW_SPECIFICATION, type CloudActionReviewer } from "./cloud-action-review.ts";
import {
	CLAUDE_REVIEW_HOOK_PATH,
	CLAUDE_REVIEW_HOOK_TOOLS,
	type ClaudeFileChange,
	CloudClaudeFilesGate,
	cloudClaudeFileCall,
} from "./cloud-claude-home-review.ts";
import {
	CLOUD_CLAUDE_SHELL_SOCKET_NAME,
	type CloudClaudeHomeChannel,
	CloudClaudeHomeShell,
	type CloudClaudeHomeStream,
} from "./cloud-claude-home-shell.ts";
import type { CloudCodexHomeMachine, CloudCodexHomeReview } from "./cloud-codex-home.ts";
import {
	assertNativeSocketPath,
	NATIVE_CLAUDE_CODE_EGRESS_HOSTS,
	NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS,
	NATIVE_EGRESS_SOCKET_NAME,
	type NativeEgressTransport,
	startNativeCodexEgress,
} from "./cloud-native-egress.ts";
import { privateDirectory, rootOwnedFile } from "./cloud-native-isolation.ts";
import { CLOUD_RUNTIME_CLAUDE_EFFORTS } from "./cloud-runtime-policy.ts";

/** The Claude Code this box runs: deploy/first-node/native-claude/linux-x64-artifact.json (a test keeps them equal).
 * Never older than 2.1.311 (P2: 2.1.231 reads /proc/self/environ through a link). */
export const CLAUDE_CODE_PIN = Object.freeze({
	package: "@anthropic-ai/claude-code-linux-x64",
	version: "2.1.325",
	bytes: 365_842_960,
	sha256: "0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf",
});
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.311";

/** Where the run host keeps the box's parts (the execution host image installs them root-owned). */
export const CLAUDE_BOX_CONFIGURATION = Object.freeze({
	binary: "/opt/qorpera-harnesses/native-claude/claude",
	entryPoint: "/opt/qorpera-runner/qorpera-native-isolation-child.mjs",
	shellClient: "/opt/qorpera-runner/qorpera-claude-home-shell.mjs",
	stage: "/opt/qorpera-runner/qorpera-claude-box-stage.sh",
	namespaceHelper: "/opt/qorpera-runner/qorpera-claude-box-ns",
	sshfs: "/usr/bin/sshfs",
	bwrap: "/usr/bin/bwrap",
	node: "/usr/bin/node",
});
export type ClaudeBoxConfiguration = { readonly [K in keyof typeof CLAUDE_BOX_CONFIGURATION]: string };

/** The paths inside the box. */
export const CLAUDE_BOX_PATHS = Object.freeze({
	binary: "/opt/claude/claude",
	/** The entry and the shell client keep their own file's extension in the box (`.mjs` as the image installs them). */
	entryPoint: "/opt/qorpera/native-entry",
	shellPrefix: "/opt/qorpera/home-shell",
	reviewHook: CLAUDE_REVIEW_HOOK_PATH,
	/** Ahead of the box's own PATH: `rg`, the bridge that runs ripgrep on the home (Grep and Glob). */
	searchBin: "/opt/qorpera/bin",
	settings: "/opt/qorpera/settings.json",
	/** The caller's short note appended to Claude Code's system prompt (`--append-system-prompt-file`), written per run
	 * and bound read-only, as the settings are. */
	systemNote: "/opt/qorpera/system-note.md",
	shellSocket: "/run/qorpera-home/shell.sock",
	config: "/slot/config",
	home: "/slot/home",
	extraCa: "/opt/qorpera/extra-ca.pem",
});
/** The home's folders the box sees at the same paths: the work, the agent's home folder, and /tmp (Claude Code's
 * working-folder file and its commands' output files are written on the home and read in the box). */
export const CLAUDE_BOX_HOME_FOLDERS = Object.freeze(["/company", "/var/lib/qorpera-agent", "/tmp"]);

/** The deny rules: the box's own folders only (A5). */
export const CLAUDE_BOX_DENY = Object.freeze([
	"Read(//slot/**)",
	"Edit(//slot/**)",
	"Write(//slot/**)",
	"Read(//opt/claude/**)",
]);

/** Switches that make the box weaker, for the proof's positive controls only (P4's A2 and A3 leaked the sign-in). */
export interface ClaudeBoxProofWeakening {
	readonly noDenyRules?: true;
	readonly noFollowSymlinks?: true;
}

/** The settings file the box reads (read-only in the box), as text. */
export const CLAUDE_REVIEW_HOOK_SECONDS = 600;

export function claudeBoxSettings(weakening?: ClaudeBoxProofWeakening, options: { reviewHook?: boolean } = {}): string {
	return `${JSON.stringify({
		permissions: {
			defaultMode: "bypassPermissions",
			...(weakening?.noDenyRules ? {} : { deny: [...CLAUDE_BOX_DENY] }),
		},
		sandbox: { enabled: false },
		attribution: { commit: "", pr: "" },
		...(options.reviewHook
			? {
					hooks: {
						PreToolUse: [
							{
								matcher: CLAUDE_REVIEW_HOOK_TOOLS.join("|"),
								hooks: [
									{
										type: "command",
										command: CLAUDE_BOX_PATHS.reviewHook,
										timeout: CLAUDE_REVIEW_HOOK_SECONDS,
									},
								],
							},
						],
					},
				}
			: {}),
	})}\n`;
}

/**
 * The sshfs options: the home resolves links, nothing on the mount runs or is a device or a set-id program. Every file
 * is shown as the box's own account (`uid`, `gid`): the namespace the mount lives in maps that account alone, and the
 * kernel refuses any write to a file whose owner it cannot map (the home's root and agent accounts), so without this
 * no tool could write anything (look1.log). Who may change what is still the home's to say: sftp-server runs there as
 * the agent's account and answers each change with the home's own permissions.
 */
export function claudeBoxMountOptions(
	owner: { uid: number; gid: number },
	weakening?: ClaudeBoxProofWeakening,
): string {
	if (!Number.isSafeInteger(owner.uid) || owner.uid < 1 || !Number.isSafeInteger(owner.gid) || owner.gid < 0)
		throw new Error("Invalid box account");
	return [
		"passive",
		"nosuid",
		"nodev",
		"noexec",
		...(weakening?.noFollowSymlinks ? [] : ["follow_symlinks"]),
		`uid=${owner.uid}`,
		`gid=${owner.gid}`,
	].join(",");
}

/**
 * The tools a box may offer, and the list slice 1 gives: exactly the ones the proofs cover. `--tools` is the exclusive
 * list: every other built-in tool (agents, schedules, triggers, web, worktrees, skills) is absent, not merely denied.
 * Naming Grep and Glob in it also brings them back: 2.1.325 hides them unless a launch list names them
 * (`setSearchToolsOptIn`, search6.log). They run ripgrep, which here is the home's own through the `rg` bridge
 * (USE_BUILTIN_RIPGREP=0): one round trip on the home's disk, never a walk of the mount.
 */
export const CLAUDE_BOX_TOOLS = Object.freeze([
	"Bash",
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",
	"Grep",
	"Glob",
	"TaskStop",
] as const);
export type ClaudeBoxTool = (typeof CLAUDE_BOX_TOOLS)[number];

/** Claude Code's arguments: print mode, its prompt on stdin, its stream as JSON lines, settings from the box only, and
 * the tools named, no others. */
export function claudeBoxArguments(
	options: { model?: string; effort?: string; tools?: readonly ClaudeBoxTool[]; systemNote?: boolean } = {},
): string[] {
	if (options.model !== undefined && !/^[A-Za-z0-9._:[\]-]{1,128}$/.test(options.model))
		throw new Error("Invalid Claude model");
	if (options.effort !== undefined && !(CLOUD_RUNTIME_CLAUDE_EFFORTS as readonly string[]).includes(options.effort))
		throw new Error("Invalid Claude effort");
	const tools = options.tools ?? CLAUDE_BOX_TOOLS;
	if (
		tools.length === 0 ||
		new Set(tools).size !== tools.length ||
		tools.some((tool) => !(CLAUDE_BOX_TOOLS as readonly string[]).includes(tool))
	)
		throw new Error("Invalid Claude tools");
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"bypassPermissions",
		"--settings",
		CLAUDE_BOX_PATHS.settings,
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--tools",
		tools.join(","),
		...(options.systemNote ? ["--append-system-prompt-file", CLAUDE_BOX_PATHS.systemNote] : []),
		...(options.model ? ["--model", options.model] : []),
		...(options.effort ? ["--effort", options.effort] : []),
	];
}

/** The sign-in the box runs with. A token is handed in on descriptor 3 and never written anywhere. A login folder is
 * Claude Code's own config folder (its `.credentials.json` and what Claude Code keeps beside it), the caller's,
 * private to this account: the driver mounts it at /slot/config and never opens what is in it. */
export type ClaudeBoxLogin = { readonly token: string } | { readonly folder: string };

/** The box's environment (bwrap sets it after clearing its own). */
export function claudeBoxEnvironment(options: {
	login: "token" | "folder";
	extraCa?: boolean;
}): Record<string, string> {
	return {
		HOME: CLAUDE_BOX_PATHS.home,
		USER: "claude",
		LOGNAME: "claude",
		SHELL: "/bin/bash",
		PATH: `${CLAUDE_BOX_PATHS.searchBin}:/usr/bin:/bin`,
		LANG: "C.UTF-8",
		TZ: "UTC",
		TERM: "dumb",
		NO_COLOR: "1",
		CLAUDE_CONFIG_DIR: CLAUDE_BOX_PATHS.config,
		CLAUDE_CODE_SHELL_PREFIX: CLAUDE_BOX_PATHS.shellPrefix,
		// Grep and Glob run the `rg` on PATH, the bridge to the home, not the copy built into Claude Code.
		USE_BUILTIN_RIPGREP: "0",
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		...(options.login === "token" ? { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" } : {}),
		...(options.extraCa ? { NODE_EXTRA_CA_CERTS: CLAUDE_BOX_PATHS.extraCa } : {}),
	};
}

export const CLAUDE_BOX_START_STAGES = Object.freeze([
	"platform",
	"parts",
	"pin",
	"arguments",
	"scratch",
	"socket-path",
	"shell-socket",
	"files-channel",
	"egress",
	"spawn",
] as const);
export type ClaudeBoxStartStage = (typeof CLAUDE_BOX_START_STAGES)[number];

const startStages = new WeakMap<Error, ClaudeBoxStartStage>();

function claudeBoxStartFailure(error: unknown, stage: ClaudeBoxStartStage): Error {
	const failure = error instanceof Error ? error : new Error("The Claude Code box did not start");
	if (!startStages.has(failure)) startStages.set(failure, stage);
	return failure;
}

export function claudeBoxStartStage(error: unknown): ClaudeBoxStartStage | undefined {
	return error instanceof Error ? startStages.get(error) : undefined;
}

export function claudeBoxSocketPaths(scratchRoot: string): string[] {
	return [join(scratchRoot, CLOUD_CLAUDE_SHELL_SOCKET_NAME), join(scratchRoot, NATIVE_EGRESS_SOCKET_NAME)];
}

/** The scratch root's own parts, made per run. */
function scratchPaths(root: string) {
	return {
		config: join(root, "slot-config"),
		home: join(root, "slot-home"),
		mount: join(root, "mnt"),
		settings: join(root, "settings.json"),
		systemNote: join(root, "system-note.md"),
		prefix: join(root, "home-shell"),
		rg: join(root, "rg"),
		reviewHook: join(root, "review-hook"),
		passwd: join(root, "passwd"),
		group: join(root, "group"),
	};
}

function claudeBoxSystem(passwd: string, group: string): string[] {
	return [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
		"--disable-userns",
		"--assert-userns-disabled",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--symlink",
		"usr/sbin",
		"/sbin",
		"--ro-bind",
		"/etc/ssl/certs",
		"/etc/ssl/certs",
		"--ro-bind",
		"/etc/ld.so.cache",
		"/etc/ld.so.cache",
		"--ro-bind",
		passwd,
		"/etc/passwd",
		"--ro-bind",
		group,
		"/etc/group",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/run",
	];
}

/** The whole command: the namespace helper, the mount stage, and the box. No file system checks, so its shape can be
 * checked anywhere. */
export function claudeBoxInvocation(options: {
	configuration: ClaudeBoxConfiguration;
	scratchRoot: string;
	relayPath: string;
	shellSocket: string;
	/** The run host's account the box runs as (the mount shows every file as its own). */
	owner: { uid: number; gid: number };
	login: "token" | { folder: string };
	weakening?: ClaudeBoxProofWeakening;
	extraCa?: string;
	model?: string;
	effort?: string;
	tools?: readonly ClaudeBoxTool[];
	/** The run wrote a system note (scratch `system-note.md`): bound read-only and appended to the system prompt. */
	systemNote?: boolean;
	reviewHook?: boolean;
}): { command: string; args: string[] } {
	const c = options.configuration;
	const s = scratchPaths(options.scratchRoot);
	const login = options.login === "token" ? "token" : "folder";
	const config = options.login === "token" ? s.config : options.login.folder;
	const box = [
		...claudeBoxSystem(s.passwd, s.group),
		"--ro-bind",
		options.shellSocket,
		CLAUDE_BOX_PATHS.shellSocket,
		"--ro-bind",
		options.relayPath,
		options.relayPath,
		"--ro-bind",
		c.binary,
		CLAUDE_BOX_PATHS.binary,
		"--ro-bind",
		c.entryPoint,
		`${CLAUDE_BOX_PATHS.entryPoint}${extname(c.entryPoint)}`,
		"--ro-bind",
		c.shellClient,
		`${CLAUDE_BOX_PATHS.shellPrefix}${extname(c.shellClient)}`,
		"--ro-bind",
		s.prefix,
		CLAUDE_BOX_PATHS.shellPrefix,
		"--ro-bind",
		s.rg,
		`${CLAUDE_BOX_PATHS.searchBin}/rg`,
		...(options.reviewHook ? ["--ro-bind", s.reviewHook, CLAUDE_BOX_PATHS.reviewHook] : []),
		"--ro-bind",
		s.settings,
		CLAUDE_BOX_PATHS.settings,
		...(options.extraCa ? ["--ro-bind", options.extraCa, CLAUDE_BOX_PATHS.extraCa] : []),
		...(options.systemNote ? ["--ro-bind", s.systemNote, CLAUDE_BOX_PATHS.systemNote] : []),
		"--bind",
		config,
		CLAUDE_BOX_PATHS.config,
		"--bind",
		s.home,
		CLAUDE_BOX_PATHS.home,
		...CLAUDE_BOX_HOME_FOLDERS.flatMap((folder) => ["--bind", `${s.mount}${folder}`, folder]),
	];
	for (const [name, value] of Object.entries(claudeBoxEnvironment({ login, extraCa: Boolean(options.extraCa) })))
		box.push("--setenv", name, value);
	box.push(
		"--chdir",
		"/company",
		"--remount-ro",
		"/",
		"--",
		c.node,
		`${CLAUDE_BOX_PATHS.entryPoint}${extname(c.entryPoint)}`,
		options.relayPath,
		CLAUDE_BOX_PATHS.binary,
		...claudeBoxArguments({
			model: options.model,
			effort: options.effort,
			tools: options.tools,
			systemNote: options.systemNote,
		}),
	);
	return {
		command: c.namespaceHelper,
		args: [
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
			c.stage,
			s.mount,
			c.sshfs,
			claudeBoxMountOptions(options.owner, options.weakening),
			"--",
			c.bwrap,
			...box,
		],
	};
}

const pinChecked = new Map<string, Promise<void>>();

/** The binary is the pinned build: size and sha-256, once per file this process sees (366 MB). */
export function checkClaudeCodePin(path: string): Promise<void> {
	const check = async (): Promise<void> => {
		const metadata = await lstat(path);
		if (metadata.size !== CLAUDE_CODE_PIN.bytes) throw new Error("Claude Code is not the pinned build");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
		if (hash.digest("hex") !== CLAUDE_CODE_PIN.sha256) throw new Error("Claude Code is not the pinned build");
	};
	return lstat(path).then((metadata) => {
		const key = `${path}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
		let known = pinChecked.get(key);
		if (!known) {
			known = check();
			pinChecked.set(key, known);
			known.catch(() => pinChecked.delete(key));
		}
		return known;
	});
}

export const CLAUDE_ACTION_REVIEW_MODEL = "haiku";
const REVIEW_OUTPUT_BYTES = 1024 * 1024;
const VERDICT_SCHEMA = (CLOUD_ACTION_REVIEW_SPECIFICATION as { tools: { inputSchema: unknown }[] }).tools[0]
	?.inputSchema;
export const CLAUDE_ACTION_REVIEW_ANSWER = `Here you have no tools, and qorpera.review_verdict is not one you can call: your whole reply is its arguments, exactly one JSON object and nothing before or after it, matching this JSON schema: ${JSON.stringify(VERDICT_SCHEMA)}`;

export function claudeReviewerArguments(model: string): string[] {
	if (!/^[A-Za-z0-9._:[\]-]{1,128}$/.test(model)) throw new Error("Invalid Claude model");
	return [
		"-p",
		"--output-format",
		"json",
		"--max-turns",
		"1",
		"--tools",
		"",
		"--settings",
		CLAUDE_BOX_PATHS.settings,
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--system-prompt-file",
		CLAUDE_BOX_PATHS.systemNote,
		"--model",
		model,
	];
}

export function claudeReviewerVerdict(stdout: string): unknown {
	const last = stdout.trim().split("\n").at(-1) ?? "";
	const result = JSON.parse(last) as { type?: unknown; is_error?: unknown; result?: unknown };
	if (result.type !== "result" || result.is_error !== false || typeof result.result !== "string")
		throw new Error("The reviewer gave no verdict");
	const text = result.result;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("The reviewer gave no verdict");
	return JSON.parse(text.slice(start, end + 1));
}

function reviewerPaths(root: string) {
	return {
		home: join(root, "h"),
		config: join(root, "c"),
		settings: join(root, "settings.json"),
		system: join(root, "system.md"),
		passwd: join(root, "passwd"),
		group: join(root, "group"),
	};
}

export function claudeReviewerInvocation(options: {
	configuration: ClaudeBoxConfiguration;
	root: string;
	relayPath: string;
	login: "token" | { folder: string };
	extraCa?: string;
	model: string;
}): string[] {
	const c = options.configuration;
	const r = reviewerPaths(options.root);
	const args = [
		...claudeBoxSystem(r.passwd, r.group),
		"--ro-bind",
		options.relayPath,
		options.relayPath,
		"--ro-bind",
		c.binary,
		CLAUDE_BOX_PATHS.binary,
		"--ro-bind",
		c.entryPoint,
		`${CLAUDE_BOX_PATHS.entryPoint}${extname(c.entryPoint)}`,
		"--ro-bind",
		r.settings,
		CLAUDE_BOX_PATHS.settings,
		"--ro-bind",
		r.system,
		CLAUDE_BOX_PATHS.systemNote,
		...(options.extraCa ? ["--ro-bind", options.extraCa, CLAUDE_BOX_PATHS.extraCa] : []),
		"--bind",
		options.login === "token" ? r.config : options.login.folder,
		CLAUDE_BOX_PATHS.config,
		"--bind",
		r.home,
		CLAUDE_BOX_PATHS.home,
	];
	const login = options.login === "token" ? "token" : "folder";
	for (const [name, value] of Object.entries(claudeBoxEnvironment({ login, extraCa: Boolean(options.extraCa) })))
		args.push("--setenv", name, value);
	args.push(
		"--chdir",
		CLAUDE_BOX_PATHS.home,
		"--remount-ro",
		"/",
		"--",
		c.node,
		`${CLAUDE_BOX_PATHS.entryPoint}${extname(c.entryPoint)}`,
		options.relayPath,
		CLAUDE_BOX_PATHS.binary,
		...claudeReviewerArguments(options.model),
	);
	return args;
}

type ReviewInput = Parameters<CloudActionReviewer["review"]>[0];

export class ClaudeCodeReviewer implements CloudActionReviewer {
	readonly #run: (input: ReviewInput, signal: AbortSignal) => Promise<unknown>;
	readonly #closing = new AbortController();
	#queue: Promise<unknown> = Promise.resolve();
	reviews = 0;

	constructor(run: (input: ReviewInput, signal: AbortSignal) => Promise<unknown>) {
		this.#run = run;
	}

	review(input: ReviewInput, signal: AbortSignal): Promise<unknown> {
		const both = AbortSignal.any([signal, this.#closing.signal]);
		const next = this.#queue.then(() => {
			both.throwIfAborted();
			this.reviews += 1;
			return this.#run(input, both);
		});
		this.#queue = next.catch(() => undefined);
		return next;
	}

	close(): void {
		this.#closing.abort();
	}
}

async function runClaudeReviewer(
	options: {
		configuration: ClaudeBoxConfiguration;
		scratchRoot: string;
		login: ClaudeBoxLogin;
		proof?: ClaudeCodeBoxOptions["proof"];
		spawnBox: typeof spawn;
	},
	input: ReviewInput,
	signal: AbortSignal,
): Promise<unknown> {
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? uid;
	const token = "token" in options.login ? options.login.token : undefined;
	const root = await mkdtemp(join(options.scratchRoot, "r"));
	let relay: Awaited<ReturnType<typeof startNativeCodexEgress>> | undefined;
	let child: ChildProcess | undefined;
	const kill = (): void => {
		if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	try {
		const r = reviewerPaths(root);
		await mkdir(r.home, { mode: 0o700 });
		await writeFile(r.settings, claudeBoxSettings(), { mode: 0o400, flag: "wx" });
		await writeFile(r.system, `${input.instructions}\n\n${CLAUDE_ACTION_REVIEW_ANSWER}\n`, {
			mode: 0o400,
			flag: "wx",
		});
		await writeFile(r.passwd, `claude:x:${uid}:${gid}::${CLAUDE_BOX_PATHS.home}:/bin/bash\n`, {
			mode: 0o400,
			flag: "wx",
		});
		await writeFile(r.group, `claude:x:${gid}:\n`, { mode: 0o400, flag: "wx" });
		if (token !== undefined) {
			await mkdir(r.config, { mode: 0o700 });
			await writeFile(
				join(r.config, ".claude.json"),
				`${JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true })}\n`,
				{ mode: 0o600, flag: "wx" },
			);
		}
		relay = await startNativeCodexEgress({
			root,
			signal,
			hosts: token !== undefined ? NATIVE_CLAUDE_CODE_EGRESS_HOSTS : NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS,
			...(options.proof?.transport ? { transport: options.proof.transport } : {}),
		});
		signal.throwIfAborted();
		const launched = options.spawnBox(
			options.configuration.bwrap,
			claudeReviewerInvocation({
				configuration: options.configuration,
				root,
				relayPath: relay.path,
				login: token !== undefined ? "token" : { folder: (options.login as { folder: string }).folder },
				...(options.proof?.extraCa ? { extraCa: options.proof.extraCa } : {}),
				model: input.model,
			}),
			{
				cwd: root,
				env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
				stdio: ["pipe", "pipe", "ignore", token !== undefined ? "pipe" : "ignore"],
				detached: true,
			},
		);
		child = launched;
		const exited = new Promise<void>((resolve) => {
			launched.once("error", () => resolve());
			launched.once("close", () => resolve());
		});
		signal.addEventListener("abort", kill, { once: true });
		const stdio = launched.stdio as unknown as readonly (Readable | Writable | null)[];
		if (token !== undefined) {
			const tokenPipe = stdio[3] as Writable;
			tokenPipe.on("error", () => undefined);
			tokenPipe.end(token);
		}
		const stdin = stdio[0] as Writable;
		stdin.on("error", () => undefined);
		stdin.end(input.prompt);
		let out = "";
		const stdout = stdio[1] as Readable;
		stdout.setEncoding("utf8");
		stdout.on("data", (text: string) => {
			if (out.length < REVIEW_OUTPUT_BYTES) out += text;
		});
		await exited;
		signal.throwIfAborted();
		try {
			return claudeReviewerVerdict(out);
		} catch (error) {
			console.error(`The Claude Code reviewer gave no verdict (exit ${launched.exitCode ?? launched.signalCode})`);
			throw error;
		}
	} finally {
		signal.removeEventListener("abort", kill);
		kill();
		await relay?.close().catch(() => undefined);
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** How long closing the box waits for the session's close in SQL (as CLOUD_HOME_CLOSE_MS). */
const CLAUDE_BOX_CLOSE_MS = 5_000;

/** One piece of the SFTP stream as a channel line (C1's contract: standard base64, at most 768 KiB a piece). */
const SFTP_PIECE = 768 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A started box. */
export interface ClaudeCodeBox {
	/** Claude Code's stream-json lines, as they come. */
	readonly lines: AsyncIterable<string>;
	/** Resolves with the box's exit code when it ends (Claude Code's, or the stage's 70 when the home did not mount). */
	readonly exited: Promise<number>;
	/** Claude Code's stderr and the stage's, bounded, for the host's journal. */
	readonly stderr: () => string;
	readonly shell: CloudClaudeHomeShell;
	readonly files?: CloudClaudeFilesGate;
	readonly reviewer?: ClaudeCodeReviewer;
	/** Ends the box, the mount, both channels and the egress relay; removes the box's own folders. Idempotent. */
	close(): Promise<void>;
}

/** What starting one run's box takes. */
export interface ClaudeCodeBoxOptions {
	configuration?: ClaudeBoxConfiguration;
	/** The run's private scratch root (this account's, mode 0700), made for this run and removed by the caller. */
	scratchRoot: string;
	login: ClaudeBoxLogin;
	/** The home: its channels and the one session that authorizes both (C1's contract: a second id for the same run
	 * on the same boot supersedes the first in SQL, so the caller makes ONE id per run and boot and passes it here). */
	channel: CloudClaudeHomeChannel;
	sessionId: string;
	machineId: string;
	/** Closes the session in SQL (`qorpera_close_home_session`), called once by `close()` after both channels are
	 * closed: "stopped" when the run's signal ended it, "ended" otherwise. As Codex's home does (cloud-codex-home.ts). */
	endSession?: (sessionId: string, reason: "ended" | "stopped") => Promise<void>;
	/** What the model is asked; Claude Code reads it on stdin. */
	prompt: string;
	/** A short note appended to Claude Code's own system prompt (at most 16 KiB), read-only in the box. */
	systemNote?: string;
	model?: string;
	effort?: string;
	/** The tools Claude Code offers, no others (default and slice 1: CLAUDE_BOX_TOOLS). */
	tools?: readonly ClaudeBoxTool[];
	signal: AbortSignal;
	review?: {
		readonly gate: CloudCodexHomeReview;
		readonly machine: CloudCodexHomeMachine;
		readonly attach: (reviewer: CloudActionReviewer | undefined) => void;
		readonly onLone?: (change: ClaudeFileChange) => void;
	};
	/** Proofs only: the egress transport (as startNativeCodexEgress takes it), a CA file the box trusts for the stub's
	 * TLS, and the positive controls' weaker set-ups. */
	proof?: { transport?: NativeEgressTransport; extraCa?: string; weakening?: ClaudeBoxProofWeakening };
}

/**
 * Starts one run's Claude Code box beside its home. No fallback: a part that is not root's, not the pin, a channel that
 * will not open or a mount that fails ends the start, and nothing of the box runs outside it.
 */
export async function launchClaudeCodeBox(options: ClaudeCodeBoxOptions): Promise<ClaudeCodeBox> {
	const configuration = options.configuration ?? CLAUDE_BOX_CONFIGURATION;
	let stage: ClaudeBoxStartStage = "platform";
	try {
		if (process.platform !== "linux" || !process.getuid?.())
			throw new Error("The Claude Code box needs unprivileged Linux");
		options.signal.throwIfAborted();
		stage = "parts";
		for (const file of [
			configuration.binary,
			configuration.entryPoint,
			configuration.shellClient,
			configuration.stage,
			configuration.namespaceHelper,
			configuration.sshfs,
			configuration.bwrap,
			configuration.node,
			...(options.proof?.extraCa ? [options.proof.extraCa] : []),
		])
			await rootOwnedFile(file);
		stage = "pin";
		await checkClaudeCodePin(configuration.binary);
	} catch (error) {
		throw claudeBoxStartFailure(error, stage);
	}
	return startClaudeCodeBox({ ...options, configuration }, spawn);
}

/**
 * The start itself, once launchClaudeCodeBox has checked every part (root's, the pin).
 *
 * @internal Exported for the tests alone, which give it a stand-in for the box's process. A run starts its box with
 * launchClaudeCodeBox: this function checks neither whose the parts are nor that Claude Code is the pinned build.
 */
export async function startClaudeCodeBox(
	options: ClaudeCodeBoxOptions & { configuration: ClaudeBoxConfiguration },
	spawnBox: typeof spawn,
): Promise<ClaudeCodeBox> {
	const progress: { stage: ClaudeBoxStartStage } = { stage: "platform" };
	try {
		return await startBox(options, spawnBox, progress);
	} catch (error) {
		throw claudeBoxStartFailure(error, progress.stage);
	}
}

async function startBox(
	options: ClaudeCodeBoxOptions & { configuration: ClaudeBoxConfiguration },
	spawnBox: typeof spawn,
	progress: { stage: ClaudeBoxStartStage },
): Promise<ClaudeCodeBox> {
	// Said again here, where the account is used: the box's own account is this process's, never root's (review r2, F1).
	const uid = process.getuid?.();
	if (process.platform !== "linux" || !uid) throw new Error("The Claude Code box needs unprivileged Linux");
	options.signal.throwIfAborted();
	progress.stage = "arguments";
	const configuration = options.configuration;
	const login = options.login;
	const token = "token" in login ? login.token : undefined;
	if (token !== undefined && !/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error("Invalid Claude sign-in token");
	// The model and the tools are checked before anything of the home opens: a start that fails on them has used
	// nothing of the caller's one session (review r2, F3).
	claudeBoxArguments({ model: options.model, effort: options.effort, tools: options.tools });
	if (options.systemNote !== undefined && (!options.systemNote || Buffer.byteLength(options.systemNote) > 16_384))
		throw new Error("Invalid Claude system note");
	progress.stage = "scratch";
	await privateDirectory(options.scratchRoot);
	progress.stage = "socket-path";
	for (const path of claudeBoxSocketPaths(options.scratchRoot)) assertNativeSocketPath(path, "The Claude Code box's");
	progress.stage = "scratch";
	if ("folder" in login) {
		if (!isAbsolute(login.folder) || login.folder.startsWith(`${options.scratchRoot}/`))
			throw new Error("Invalid Claude login folder");
		await privateDirectory(login.folder);
	}
	const s = scratchPaths(options.scratchRoot);
	for (const folder of [s.config, s.home, s.mount]) await mkdir(folder, { mode: 0o700 });
	const gid = process.getgid?.() ?? uid;
	const review = options.review;
	await writeFile(s.settings, claudeBoxSettings(options.proof?.weakening, { reviewHook: review !== undefined }), {
		mode: 0o400,
		flag: "wx",
	});
	if (options.systemNote !== undefined) await writeFile(s.systemNote, options.systemNote, { mode: 0o400, flag: "wx" });
	await writeFile(s.passwd, `claude:x:${uid}:${gid}::${CLAUDE_BOX_PATHS.home}:/bin/bash\n`, {
		mode: 0o400,
		flag: "wx",
	});
	await writeFile(s.group, `claude:x:${gid}:\n`, { mode: 0o400, flag: "wx" });
	await writeFile(
		s.prefix,
		`#!/bin/sh\nexec ${configuration.node} ${CLAUDE_BOX_PATHS.shellPrefix}${extname(configuration.shellClient)} "$@"\n`,
		{ mode: 0o500, flag: "wx" },
	);
	await writeFile(
		s.rg,
		`#!/bin/sh\nexec ${configuration.node} ${CLAUDE_BOX_PATHS.shellPrefix}${extname(configuration.shellClient)} --rg "$@"\n`,
		{ mode: 0o500, flag: "wx" },
	);
	if (review)
		await writeFile(
			s.reviewHook,
			`#!/bin/sh\nexec ${configuration.node} ${CLAUDE_BOX_PATHS.shellPrefix}${extname(configuration.shellClient)} --hook\n`,
			{ mode: 0o500, flag: "wx" },
		);
	// Claude Code's own first-run state for a box of its own; a login folder is the caller's and is left as it is.
	if (token !== undefined)
		await writeFile(
			join(s.config, ".claude.json"),
			`${JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true })}\n`,
			{ mode: 0o600, flag: "wx" },
		);

	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const cleanups: (() => Promise<void>)[] = [];
	let closing: Promise<void> | undefined;
	// Whether a channel of the session ever opened: only then is there a session for SQL to close. A launch that failed
	// before leaves the caller's id unused, to start again with (review round 1, F3).
	let filesOpened = false;
	let shellOf: CloudClaudeHomeShell | undefined;
	let gate: CloudClaudeFilesGate | undefined;
	let reviewer: ClaudeCodeReviewer | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			controller.abort();
			for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
			// Both channels are closed now; then the one session that authorized them, if one ever opened.
			if (options.endSession && (filesOpened || (shellOf?.counts.channels ?? 0) > 0))
				await Promise.race([
					options
						.endSession(options.sessionId, options.signal.aborted ? "stopped" : "ended")
						.catch(() => undefined),
					new Promise((resolve) => setTimeout(resolve, CLAUDE_BOX_CLOSE_MS).unref()),
				]);
			// The box's own folders: transcripts, Claude Code's state, its big outputs. Never the caller's login folder.
			for (const path of [
				s.config,
				s.home,
				s.settings,
				s.systemNote,
				s.passwd,
				s.group,
				s.prefix,
				s.rg,
				s.reviewHook,
			])
				await rm(path, { recursive: true, force: true }).catch(() => undefined);
			// The mount point stays empty in this namespace (the mount lives in the box's): only an empty folder goes.
			await rmdir(s.mount).catch(() => undefined);
		})();
		return closing;
	};
	try {
		// The shell: one exec channel, opened on the first command.
		const shell = new CloudClaudeHomeShell({
			channel: options.channel,
			sessionId: options.sessionId,
			machineId: options.machineId,
			signal,
			...(review
				? {
						review: { gate: review.gate, machine: review.machine },
						hook: async (text: string, hookSignal: AbortSignal) => {
							const call = cloudClaudeFileCall(text);
							if (
								!call ||
								!CLAUDE_BOX_HOME_FOLDERS.some(
									(folder) => call.path === folder || call.path.startsWith(`${folder}/`),
								)
							)
								return undefined;
							return gate ? await gate.admit(call, hookSignal) : undefined;
						},
					}
				: {}),
		});
		progress.stage = "shell-socket";
		await shell.listen(options.scratchRoot);
		shellOf = shell;
		cleanups.push(() => shell.close());
		// The files: the sftp channel of the same session, open before sshfs says its first word.
		progress.stage = "files-channel";
		const files: CloudClaudeHomeStream = await options.channel.open(
			{ sessionId: options.sessionId, machineId: options.machineId, kind: "sftp" },
			signal,
		);
		filesOpened = true;
		cleanups.push(() => files.close());
		progress.stage = "egress";
		const relay = await startNativeCodexEgress({
			root: options.scratchRoot,
			signal,
			hosts: token !== undefined ? NATIVE_CLAUDE_CODE_EGRESS_HOSTS : NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS,
			...(options.proof?.transport ? { transport: options.proof.transport } : {}),
		});
		cleanups.push(() => relay.close());
		if (review) {
			const made = new ClaudeCodeReviewer((input, reviewSignal) =>
				runClaudeReviewer(
					{
						configuration,
						scratchRoot: options.scratchRoot,
						login,
						...(options.proof ? { proof: options.proof } : {}),
						spawnBox,
					},
					input,
					reviewSignal,
				),
			);
			reviewer = made;
			review.attach(made);
			cleanups.push(async () => {
				review.attach(undefined);
				made.close();
			});
		}
		signal.throwIfAborted();
		progress.stage = "spawn";
		const invocation = claudeBoxInvocation({
			configuration,
			scratchRoot: options.scratchRoot,
			relayPath: relay.path,
			shellSocket: shell.socketPath,
			owner: { uid, gid },
			login: token !== undefined ? "token" : { folder: (login as { folder: string }).folder },
			weakening: options.proof?.weakening,
			extraCa: options.proof?.extraCa,
			model: options.model,
			effort: options.effort,
			tools: options.tools,
			systemNote: options.systemNote !== undefined,
			reviewHook: review !== undefined,
		});
		const child = spawnBox(invocation.command, invocation.args, {
			cwd: options.scratchRoot,
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			stdio: ["pipe", "pipe", "pipe", token !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
			detached: true,
		});
		// Node's types name five descriptors; the box has six (3: the token, 4 and 5: the mount's SFTP stream).
		const stdio = child.stdio as unknown as readonly (Readable | Writable | null)[];
		const exited = new Promise<number>((resolve) => {
			child.once("error", () => resolve(255));
			child.once("close", (code, killed) => resolve(code ?? (killed ? 137 : 255)));
		});
		cleanups.push(async () => {
			if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
		});
		// The run's stop ends the box at once, as close() does: the process group first, then the relay, both channels
		// (so no write of the turn reaches the home after it, and the home ends the commands running there) and the
		// session (review round 1, F1). Set once the kill is among the cleanups, so a stop always ends the process
		// before anything else; nothing waits between the check above and here, so no stop can fall in between
		// (review r2, F2). close() takes the listener off again.
		const stop = (): void => void close();
		options.signal.addEventListener("abort", stop, { once: true });
		cleanups.push(async () => options.signal.removeEventListener("abort", stop));
		// The sign-in: written once into descriptor 3 and closed; Claude Code reads it and the pipe is empty after.
		if (token !== undefined) {
			const tokenPipe = stdio[3] as Writable;
			tokenPipe.on("error", () => undefined);
			tokenPipe.end(token);
		}
		// sshfs <-> the home's sftp channel.
		const toMount = stdio[4] as Writable;
		const fromMount = stdio[5] as Readable;
		toMount.on("error", () => undefined);
		fromMount.on("error", () => undefined);
		const toHome = (bytes: Buffer): void => {
			for (let at = 0; at < bytes.length; at += SFTP_PIECE)
				files.write(bytes.subarray(at, at + SFTP_PIECE).toString("base64"));
		};
		if (review) {
			gate = new CloudClaudeFilesGate({
				machine: review.machine,
				review: review.gate,
				signal,
				toHome,
				toMount: (bytes) => void toMount.write(bytes),
			});
			if (review.onLone) gate.onLone = review.onLone;
		}
		const filesGate = gate;
		void (async () => {
			try {
				for await (const chunk of fromMount) {
					if (!filesGate) toHome(chunk as Buffer);
					else {
						filesGate.fromMount(chunk as Buffer);
						if (filesGate.broken) break;
					}
				}
			} catch {
				// The mount ended; the box's close ends the channel.
			}
			if (filesGate?.broken) void files.close();
		})();
		void (async () => {
			try {
				for await (const line of files.lines) {
					if (!line || !BASE64.test(line)) break;
					const bytes = Buffer.from(line, "base64");
					if (filesGate) filesGate.fromHome(bytes);
					if (filesGate ? toMount.writableNeedDrain : !toMount.write(bytes))
						await new Promise<void>((resolve) => toMount.once("drain", resolve));
					if (filesGate?.broken) break;
				}
			} catch {
				// The channel ended.
			}
			toMount.end();
		})();
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (text: string) => {
			stderr = (stderr + text).slice(-65_536);
		});
		const stdin = child.stdin as Writable;
		stdin.on("error", () => undefined);
		stdin.end(options.prompt);
		child.stdout?.setEncoding("utf8");
		const stdout = child.stdout as Readable;
		async function* lines(): AsyncGenerator<string> {
			let rest = "";
			for await (const chunk of stdout) {
				rest += chunk as string;
				let end = rest.indexOf("\n");
				while (end >= 0) {
					filesGate?.notice(rest.slice(0, end));
					yield rest.slice(0, end);
					rest = rest.slice(end + 1);
					end = rest.indexOf("\n");
				}
			}
			if (rest) yield rest;
		}
		return {
			lines: lines(),
			exited,
			stderr: () => stderr,
			shell,
			...(filesGate ? { files: filesGate } : {}),
			...(reviewer ? { reviewer } : {}),
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
