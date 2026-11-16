// A worker that runs on Claude Code (lanes/agent-box-20261113, slice C4c; C4-WORKER-DESIGN.md as the lane's lead ruled
// it, 14 Nov 2026). An agent hands a plain worker to Claude Code on a member's word (C4a); its run is this composition,
// not a Codex turn: no Codex starts. The run opens its member's sealed Claude sign-in for this run only (C4b), puts the
// files in a private login folder of this run, starts unmodified Claude Code in its box beside the agent's own machine
// (C2, cloud-claude-box.ts: its shell and files are the machine's, as the agent's account), reads what it does from its
// stream, seals the credentials file back when Claude Code renewed it, and ends with Claude Code's own report. The
// runtime writes that report as the worker's results (report_work's path) and the worker-completion wake is unchanged.
//
// What holds here, by the founder's decisions:
// - The member's own plan pays and is never switched; nothing falls back to Codex. A failure before the box starts ends
//   the worker blocked, in words the dispatching agent can act on.
// - No program of ours renews a token, calls Anthropic with it or reads it for its own use: the files go into the folder
//   as the vault sealed them, and only `.credentials.json` is read back, for its digest and to send it to the vault.
// - Nothing of the login is logged, and nothing else Claude Code wrote in its folder is kept or sent: the folder's files
//   are overwritten and the folder removed, also when the run is stopped or fails.
// - Members see no step list: each tool call becomes one step of the run's own work log, never shown as a log.

import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CLAUDE_BOX_TOOLS,
	CLAUDE_CODE_PIN,
	type ClaudeCodeBox,
	type ClaudeCodeBoxOptions,
	claudeBoxStartStage,
} from "./cloud-claude-box.ts";
import type { ClaudeLoginFileName } from "./cloud-claude-login-vault.ts";
import { cloudHomeRefusalWords } from "./cloud-codex-home.ts";
import { sha256 } from "./cloud-company-folder-client.ts";
import { CloudHomeChannelRefused } from "./cloud-home-channel.ts";
import { claudeLoginFile } from "./cloud-model-login-sign-in.ts";
import type { ModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import { type ClaudeLoginRunClient, openClaudeLoginForRun, sealClaudeLoginBack } from "./cloud-secret-broker-http.ts";

// ---------------------------------------------------------------------------------------------------------------------
// What Claude Code is told

/** Appended to Claude Code's own system prompt (`--append-system-prompt-file`). No Qorpera tool names: it has none. */
export const CLAUDE_WORKER_SYSTEM_NOTE = [
	"You work on the company's machine as its agent.",
	"/company is the company's folder: a change you save there is saved for the whole company, with its history.",
	"Your file tools (Read, Write, Edit, NotebookEdit, Grep, Glob) see only /company, your home folder /var/lib/qorpera-agent and /tmp of that machine: use the shell for everything else on it. A file tool aimed at any other path reads or writes this program's own scratch space, not the machine.",
	"Never write a password, key or token into /company.",
	"sudo is yours on the machine.",
].join("\n");

/** The worker's brief, as its wake carries it (`qorpera.worker-dispatch/v1`). */
export interface ClaudeWorkerBrief {
	readonly title: string;
	readonly goal: string;
	readonly doneWhen: string;
	readonly context: string | null;
	readonly sources: readonly string[];
	/** The worker's own folder, as a company path (`QorperaOS/agents/<agent>/todos/<todo>/<worker>`). */
	readonly outputFolder: string;
	/** The agent's follow-up, on a worker's later run. */
	readonly followUp: string | null;
	/** On a follow-up: the summary of the worker's last report (the follow-up removed its results file). */
	readonly earlier?: string | null;
}

/** The brief of a Claude Code worker's wake (the wake bus checked its shape already). */
export function claudeWorkerBrief(payload: Readonly<Record<string, unknown>>): ClaudeWorkerBrief {
	const dispatch = (payload.dispatch ?? {}) as Readonly<Record<string, unknown>>;
	const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
	if (typeof payload.outputFolder !== "string" || !payload.outputFolder) throw new Error("Invalid Claude Code worker");
	return {
		title: text(payload.title),
		goal: text(dispatch.goal),
		doneWhen: text(dispatch.definitionOfDone),
		context: text(dispatch.context) || null,
		sources: Array.isArray(dispatch.sources)
			? dispatch.sources.filter((path): path is string => typeof path === "string" && path.length > 0)
			: [],
		outputFolder: payload.outputFolder,
		followUp: text(dispatch.followUp) || null,
	};
}

/** How much of a follow-up's earlier report its prompt carries. */
const EARLIER_CHARS = 2000;

/** A company path as the machine shows it: under /company. */
function machinePath(path: string): string {
	return `/company/${path.replace(/^\/+/, "").replace(/^company\//, "")}`;
}

/** What Claude Code reads on stdin: the worker's brief, where to put what it makes, and that its last message is its
 * report. */
export function claudeWorkerPrompt(brief: ClaudeWorkerBrief): string {
	const parts = [`# ${brief.title || "A piece of work"}`, `Goal: ${brief.goal}`, `Done when: ${brief.doneWhen}`];
	if (brief.context) parts.push(`Context: ${brief.context}`);
	if (brief.followUp) {
		// A follow-up is a new Claude Code session: it is told where its earlier work is and what it reported then.
		parts.push(
			`This follows up your earlier work on this, which is in ${machinePath(brief.outputFolder)}; your earlier report there (results.md) was replaced by this follow-up.`,
		);
		if (brief.earlier) parts.push(`Your earlier report said: ${oneLine(brief.earlier, EARLIER_CHARS)}`);
		parts.push(`The agent's follow-up on your earlier report: ${brief.followUp}`);
	}
	if (brief.sources.length)
		parts.push(
			`Sources, in the company's folder:\n${brief.sources.map((source) => `- ${machinePath(source)}`).join("\n")}`,
		);
	parts.push(
		`Put the files you make in ${machinePath(brief.outputFolder)}, unless the goal names another place.`,
		"Your last message is your report: what you did, what is left, and which files you changed.",
	);
	return `${parts.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// What comes back: the stream

/** One tool call of Claude Code's, as the run's work log keeps it. */
export interface ClaudeWorkerStep {
	readonly id: string;
	/** Claude Code's tool name (Bash, Read, ...). */
	readonly tool: string;
	/** A path, or the command's first line; bounded. */
	readonly what: string;
	readonly ok: boolean;
	readonly ms: number;
}

/** At most this many tool calls are kept as steps (a run past it keeps working; its later calls are counted only). */
export const CLAUDE_WORKER_MAX_STEPS = 2000;
const WHAT_CHARS = 200;
const WORDS_CHARS = 400;

/** One line of plain text from something Claude Code said, bounded, control characters out. */
function oneLine(value: string, chars: number): string {
	const line = value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}

function stepWhat(tool: string, input: unknown): string {
	const fields = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const first = (...names: string[]): string => {
		for (const name of names) if (typeof fields[name] === "string" && fields[name]) return fields[name] as string;
		return "";
	};
	const what =
		tool === "Bash"
			? (first("command").split("\n")[0] ?? "")
			: tool === "Grep" || tool === "Glob"
				? [first("pattern"), first("path")].filter(Boolean).join(" in ")
				: first("file_path", "notebook_path", "path", "task_id", "shell_id");
	return oneLine(what, WHAT_CHARS);
}

/** Claude Code's own words that its plan's limit is reached: kept as it said them (a pipe and a Unix time, as older
 * versions print it, is said as the time it names). */
function limitWords(text: string): string {
	const piped = /^(.*?)\|(\d{10})$/.exec(text.trim());
	if (piped) {
		const at = new Date(Number(piped[2]) * 1000).toISOString().replace(/:\d{2}\.\d{3}Z$/, " UTC");
		return oneLine(`${piped[1]}; it resets at ${at.replace("T", " ")}`, WORDS_CHARS);
	}
	return oneLine(text, WORDS_CHARS);
}

const LIMIT = /usage limit|hit your limit|limit reached|limit will reset|resets? (at|in)\b|rate[ _-]?limit/i;
const SIGNED_OUT =
	/oauth (token|session) (has )?expired|failed to authenticate|invalid api key|authentication[_ ](error|failed)|please run \/login|not logged in|credentials? (are|is) invalid|token (was )?revoked/i;

/** The final `result` line. */
export interface ClaudeWorkerResult {
	readonly subtype: string;
	readonly isError: boolean;
	readonly text: string;
	readonly turns: number | null;
}

/**
 * Reads Claude Code's `--output-format stream-json --verbose` lines: its init line (session, model, tools), each tool
 * use and its result as one step, a message that says the plan's limit is reached or the sign-in failed, and the final
 * result. Anything else is passed over; a line that is not JSON is ignored.
 */
export class ClaudeWorkerStream {
	readonly #now: () => number;
	readonly #open = new Map<string, { tool: string; what: string; at: number }>();
	readonly steps: ClaudeWorkerStep[] = [];
	/** Tool calls past CLAUDE_WORKER_MAX_STEPS. */
	uncounted = 0;
	init: { readonly sessionId: string; readonly model: string; readonly tools: readonly string[] } | null = null;
	result: ClaudeWorkerResult | null = null;
	/** Claude Code said its plan's limit is reached, in these words; and whether it used a tool after that. */
	limit: { readonly words: string; toolsAfter: number } | null = null;
	/** Claude Code said its sign-in failed. */
	signedOut = false;
	/** A tool use or result came before the init line: the tools were never shown to be the eight. */
	beforeInit = false;

	constructor(now: () => number = () => performance.now()) {
		this.#now = now;
	}

	/** One line; returns the steps it finished. */
	push(line: string): ClaudeWorkerStep[] {
		let event: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
			event = parsed as Record<string, unknown>;
		} catch {
			return [];
		}
		if (event.type === "system" && event.subtype === "init" && this.init === null) {
			this.init = {
				sessionId: typeof event.session_id === "string" ? event.session_id : "",
				model: typeof event.model === "string" ? event.model : "",
				tools: Array.isArray(event.tools)
					? event.tools.filter((tool): tool is string => typeof tool === "string")
					: [],
			};
			return [];
		}
		const message = (event.message ?? {}) as Record<string, unknown>;
		const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
		if (event.type === "assistant") {
			const said = content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join(" ");
			// Only Claude Code's own error mark says so (2.1.325, against a stub answering 429 and 401: its synthetic message
			// has `error: "rate_limit"` with "You've hit your 5-hour limit · resets …", or `error: "authentication_failed"`
			// with "Failed to authenticate: …"). What it writes in its work, "rate limit" or "not logged in" among it, is
			// never read as either.
			if (event.error === "rate_limit")
				this.limit ??= { words: limitWords(said || "Claude Code's plan limit is reached"), toolsAfter: 0 };
			if (event.error === "authentication_failed") this.signedOut = true;
			for (const block of content) {
				if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
				if (this.init === null) this.beforeInit = true;
				const tool = typeof block.name === "string" ? block.name : "unknown";
				this.#open.set(block.id, { tool, what: stepWhat(tool, block.input), at: this.#now() });
				if (this.limit) this.limit.toolsAfter++;
			}
			return [];
		}
		if (event.type === "user") {
			const done: ClaudeWorkerStep[] = [];
			for (const block of content) {
				if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
				if (this.init === null) this.beforeInit = true;
				const open = this.#open.get(block.tool_use_id);
				if (!open) continue;
				this.#open.delete(block.tool_use_id);
				const step = {
					id: block.tool_use_id,
					tool: open.tool,
					what: open.what,
					ok: block.is_error !== true,
					ms: Math.max(0, Math.round(this.#now() - open.at)),
				};
				if (this.steps.length < CLAUDE_WORKER_MAX_STEPS) {
					this.steps.push(step);
					done.push(step);
				} else this.uncounted++;
			}
			return done;
		}
		if (event.type === "result" && this.result === null) {
			const text = typeof event.result === "string" ? event.result : "";
			this.result = {
				subtype: typeof event.subtype === "string" ? event.subtype : "",
				isError: event.is_error === true || event.subtype !== "success",
				text,
				turns: typeof event.num_turns === "number" ? event.num_turns : null,
			};
			// An error result's own status (Claude Code's `api_error_status`), and only then its words.
			if (this.result.isError && (event.api_error_status === 429 || (text && LIMIT.test(text))))
				this.limit ??= { words: limitWords(text || "Claude Code's plan limit is reached"), toolsAfter: 0 };
			if (this.result.isError && (event.api_error_status === 401 || (text && SIGNED_OUT.test(text))))
				this.signedOut = true;
		}
		return [];
	}

	/** Whether the init line names exactly the box's tools (C2: `--tools` is the exclusive list). */
	toolsAsAllowed(): boolean {
		const tools = this.init?.tools ?? [];
		return (
			tools.length === CLAUDE_BOX_TOOLS.length &&
			[...tools].sort().join() === [...(CLAUDE_BOX_TOOLS as readonly string[])].sort().join()
		);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The words the dispatching agent gets

export const CLAUDE_WORKER_WORDS = Object.freeze({
	signedOut: (member: string) =>
		`Claude Code could not sign in as ${member}: their Claude sign-in has ended. Ask them to sign in again.`,
	notOpen: (member: string) =>
		`Claude Code is not open for ${member} now: dispatch this work again without Claude Code, or ask ${member} about it.`,
	limit: (member: string, words: string, nothingAfter: boolean) =>
		`${member}'s Claude plan has reached its limit. Claude Code said: "${words}".${nothingAfter ? " Nothing was changed after that point." : ""}`,
	boxFailed: "Claude Code could not start on Qorpera's side; nothing ran on the agent's machine. Try again later.",
	openFailed: (member: string) =>
		`Claude Code could not open ${member}'s sign-in on Qorpera's side now; nothing ran on the agent's machine. Try again later.`,
	toolsWrong:
		"Claude Code did not start the way Qorpera runs it, so it was stopped before it did anything. Try again later.",
	cut: (worked: boolean) =>
		worked
			? "Claude Code stopped before it finished, without a report. Part of the work may be done: look at the files before you try again."
			: "Claude Code stopped before it finished, without a report, and before it did anything. Try again later.",
	failed: (words: string) => `Claude Code could not finish the work. It said: "${words}".`,
});

// ---------------------------------------------------------------------------------------------------------------------
// The login: opened for this run, in a private folder, sealed back when Claude Code changed its credentials

/** The run's opened Claude login, as the vault client gives it (C4b's OpenedClaudeLogin). */
export interface ClaudeWorkerOpenedLogin {
	readonly claudeLoginId: string;
	readonly version: number;
	readonly envelopeSha256: string;
	readonly files: ReadonlyMap<ClaudeLoginFileName, Buffer>;
	readonly fileSha256: Readonly<Partial<Record<ClaudeLoginFileName, string>>>;
}
/** The base a seal-back compares and swaps against: what the run opened, or what it sealed since. */
export type ClaudeWorkerLoginBase = Pick<
	ClaudeWorkerOpenedLogin,
	"claudeLoginId" | "version" | "envelopeSha256" | "fileSha256"
>;
/** A seal-back's answer (C4b's sealClaudeLoginBack). `base` is the version just sealed, when the vault says it. */
export type ClaudeWorkerSealAnswer =
	| { readonly state: "unchanged" }
	| { readonly state: "sealed"; readonly version: number; readonly base?: ClaudeWorkerLoginBase }
	| { readonly state: "stale"; readonly version: number }
	| { readonly state: "refused"; readonly reason: "SIGNED_OUT" | "NOT_OPEN" };

/** The vault, for this run (the runtime binds the run's binding and the client). */
export interface ClaudeWorkerLogins {
	open(signal: AbortSignal): Promise<ClaudeWorkerOpenedLogin | { readonly refused: "SIGNED_OUT" | "NOT_OPEN" }>;
	seal(base: ClaudeWorkerLoginBase, credentials: Uint8Array, signal: AbortSignal): Promise<ClaudeWorkerSealAnswer>;
}

/** Overwrites every regular file under `folder` (no link followed) with zeros of its own size, then removes the folder.
 * The run's login folder lives in the run host's own temporary root; whether that is memory or disk, what Claude Code
 * kept there (the credentials, its transcripts, its settings) is overwritten before it is removed. */
export async function wipeClaudeLoginFolder(folder: string): Promise<void> {
	const walk = async (dir: string): Promise<void> => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			let metadata: Awaited<ReturnType<typeof lstat>>;
			try {
				metadata = await lstat(path);
			} catch {
				continue;
			}
			if (metadata.isDirectory()) await walk(path);
			else if (metadata.isFile() && metadata.size > 0) {
				try {
					const handle = await open(path, "r+");
					try {
						const zeros = Buffer.alloc(Math.min(metadata.size, 1 << 20));
						for (let at = 0; at < metadata.size; at += zeros.length)
							await handle.write(zeros, 0, Math.min(zeros.length, metadata.size - at), at);
						await handle.sync();
					} finally {
						await handle.close();
					}
				} catch {
					// Removed below either way.
				}
			}
		}
	};
	await walk(folder);
	await rm(folder, { recursive: true, force: true });
}

/** The credentials file's state on disk, to tell that Claude Code replaced it (it writes a new file and renames it). */
async function credentialsStamp(folder: string): Promise<string | null> {
	try {
		const metadata = await lstat(join(folder, ".credentials.json"));
		return metadata.isFile() ? `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}` : null;
	} catch {
		return null;
	}
}

/** Keeps the run's login in step with the vault: seals `.credentials.json` back once early, when Claude Code replaced it
 * soon after its start (it renews an expired token then), and again at the end when it changed again. */
class ClaudeWorkerLoginKeeper {
	readonly #logins: ClaudeWorkerLogins;
	readonly #folder: string;
	#base: ClaudeWorkerLoginBase;
	/** The credentials' digest the vault holds as this run's base. */
	#held: string | undefined;
	#lost = false;
	#queue: Promise<void> = Promise.resolve();
	sealed = 0;
	stale = 0;
	refused: "SIGNED_OUT" | "NOT_OPEN" | null = null;

	constructor(logins: ClaudeWorkerLogins, folder: string, opened: ClaudeWorkerOpenedLogin) {
		this.#logins = logins;
		this.#folder = folder;
		this.#base = {
			claudeLoginId: opened.claudeLoginId,
			version: opened.version,
			envelopeSha256: opened.envelopeSha256,
			fileSha256: { ...opened.fileSha256 },
		};
		this.#held = opened.fileSha256[".credentials.json"];
	}

	/** Seals the credentials back when they changed since what the vault holds. One at a time. Resolves true when the
	 * vault holds what the folder holds now (or nothing more can be sealed); rejects when the vault could not be asked. */
	sync(signal: AbortSignal): Promise<boolean> {
		const next = this.#queue.then(() => this.#sync(signal));
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #sync(signal: AbortSignal): Promise<boolean> {
		if (this.#lost || this.refused) return true;
		let credentials: Buffer;
		try {
			credentials = await claudeLoginFile(join(this.#folder, ".credentials.json"));
		} catch {
			// Gone, a link or out of bounds: nothing of it is sent.
			return true;
		}
		try {
			const digest = sha256(credentials);
			if (digest === this.#held) return true;
			let answer: ClaudeWorkerSealAnswer;
			try {
				answer = await this.#logins.seal(this.#base, credentials, signal);
			} catch {
				// A lost answer is asked once more; a seal that did land answers stale with the next version (below).
				signal.throwIfAborted();
				answer = await this.#logins.seal(this.#base, credentials, signal);
			}
			if (answer.state === "unchanged") {
				this.#held = digest;
				return true;
			}
			if (answer.state === "refused") {
				this.refused = answer.reason;
				return true;
			}
			if (answer.state === "sealed") {
				this.sealed++;
				this.#held = digest;
				this.#base = answer.base ?? (await this.#reopened(digest, signal)) ?? this.#base;
				return true;
			}
			// Stale: another seal came first. One version past ours may be our own, its answer lost: the vault's copy
			// says so when its credentials are the ones sent.
			if (answer.version === this.#base.version + 1) {
				const ours = await this.#reopened(digest, signal);
				if (ours) {
					this.sealed++;
					this.#held = digest;
					this.#base = ours;
					return true;
				}
			}
			// Another run's renewal won: its token is the member's now, and this run seals nothing more. Not an error.
			this.stale++;
			this.#lost = true;
			return true;
		} finally {
			credentials.fill(0);
		}
	}

	/** The login's newest version as the vault opens it again, when its credentials are `digest`; its files are zeroed at
	 * once (only their digests are kept). */
	async #reopened(digest: string, signal: AbortSignal): Promise<ClaudeWorkerLoginBase | undefined> {
		const opened = await this.#logins.open(signal);
		if ("refused" in opened) {
			this.refused = opened.refused;
			return undefined;
		}
		for (const bytes of opened.files.values()) bytes.fill(0);
		if (opened.fileSha256[".credentials.json"] !== digest) return undefined;
		return {
			claudeLoginId: opened.claudeLoginId,
			version: opened.version,
			envelopeSha256: opened.envelopeSha256,
			fileSha256: { ...opened.fileSha256 },
		};
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

/** How a Claude Code worker's run ended, for its report. */
export interface ClaudeWorkerOutcome {
	readonly outcome: "succeeded" | "blocked";
	/** The report's summary: Claude Code's own final message, or the words for why there is none. */
	readonly summary: string;
	/** For a blocked worker: what the agent can do. */
	readonly needs?: string;
	/** What Claude Code's init line named, when it started. */
	readonly model?: string;
	readonly sessionId?: string;
	readonly steps: number;
	/** The login: how many times its credentials were sealed back, and whether another run's seal came first. */
	readonly login?: { readonly sealed: number; readonly stale: number };
	readonly boxFailure?: string;
}

export interface ClaudeWorkerRunOptions {
	readonly brief: ClaudeWorkerBrief;
	/** The member whose plan pays, as the agent knows them. */
	readonly member: string;
	readonly logins: ClaudeWorkerLogins;
	/** Starts the box (launchClaudeCodeBox, with the run's channel, session and home bound). */
	readonly launch: (
		options: Pick<ClaudeCodeBoxOptions, "scratchRoot" | "login" | "prompt" | "systemNote" | "signal">,
	) => Promise<ClaudeCodeBox>;
	readonly root: string;
	/** Each step as it finishes, for the run's work log. Never throws back into the run. */
	readonly step?: (step: ClaudeWorkerStep | { readonly start: { model: string; sessionId: string } }) => void;
	readonly signal: AbortSignal;
	/** How long after the box starts a replaced credentials file is sealed back early (default 120 s). */
	readonly earlySealMs?: number;
	readonly pollMs?: number;
}

export function claudeWorkerScratchPrefix(root: string): string {
	return join(dirname(root), "qorpera-claude-box-");
}

export function claudeBoxFailureCode(error: unknown): string {
	const coded = error as { code?: unknown; reason?: unknown } | null;
	const detail = [coded?.code, coded?.reason].find(
		(value): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(value),
	);
	return `box-${claudeBoxStartStage(error) ?? "unknown"}${detail ? `:${detail}` : ""}`;
}

const SUMMARY_BYTES = 4000;
const NEEDS_BYTES = 1000;

/** Text as a worker's results file holds it: a line that would start one of its sections is a heading one level down,
 * and the whole is cut to `bytes` (UTF-8). */
export function claudeWorkerReportText(text: string, bytes: number): string {
	let out = text.replace(/\r\n?/g, "\n").replace(/^## /gm, "### ").trim();
	if (Buffer.byteLength(out) <= bytes) return out;
	while (Buffer.byteLength(`${out}…`) > bytes)
		out = out.slice(0, Math.max(0, out.length - Math.max(1, out.length >> 4)));
	return `${out.trimEnd()}…`;
}

function blocked(words: string, extra: Partial<ClaudeWorkerOutcome> & { steps?: number } = {}): ClaudeWorkerOutcome {
	return {
		outcome: "blocked",
		summary: claudeWorkerReportText(words, SUMMARY_BYTES),
		needs: claudeWorkerReportText(words, NEEDS_BYTES),
		steps: 0,
		...extra,
	};
}

/**
 * One Claude Code worker's run, from the open of its login to its outcome. Throws only when the run itself is stopped
 * (its signal); every other failure is an outcome, blocked, in its words. The login folder is removed before this
 * returns or throws.
 */
export async function runClaudeWorker(options: ClaudeWorkerRunOptions): Promise<ClaudeWorkerOutcome> {
	const { signal, member } = options;
	signal.throwIfAborted();
	let opened: Awaited<ReturnType<ClaudeWorkerLogins["open"]>>;
	try {
		opened = await options.logins.open(signal);
	} catch {
		// The vault unreachable, or an answer out of shape: nothing of Claude Code ran. Only a stop throws.
		signal.throwIfAborted();
		return blocked(CLAUDE_WORKER_WORDS.openFailed(member));
	}
	if ("refused" in opened)
		return blocked(
			opened.refused === "SIGNED_OUT" ? CLAUDE_WORKER_WORDS.signedOut(member) : CLAUDE_WORKER_WORDS.notOpen(member),
		);
	const folder = join(options.root, "claude-login");
	let scratchRoot: string | undefined;
	let keeper: ClaudeWorkerLoginKeeper | undefined;
	let box: ClaudeCodeBox | undefined;
	const stream = new ClaudeWorkerStream();
	let outcome: ClaudeWorkerOutcome;
	try {
		outcome = await (async (): Promise<ClaudeWorkerOutcome> => {
			try {
				await mkdir(folder, { mode: 0o700 });
				scratchRoot = await mkdtemp(claudeWorkerScratchPrefix(options.root));
				for (const [name, bytes] of opened.files)
					await writeFile(join(folder, name), bytes, { mode: 0o600, flag: "wx" });
			} catch {
				// The run's folders could not be made: nothing of Claude Code ran (what was written goes in `finally`).
				signal.throwIfAborted();
				return blocked(CLAUDE_WORKER_WORDS.openFailed(member));
			} finally {
				for (const bytes of opened.files.values()) bytes.fill(0);
			}
			keeper = new ClaudeWorkerLoginKeeper(options.logins, folder, opened);
			const before = await credentialsStamp(folder);
			try {
				box = await options.launch({
					scratchRoot: scratchRoot as string,
					login: { folder },
					prompt: claudeWorkerPrompt(options.brief),
					systemNote: CLAUDE_WORKER_SYSTEM_NOTE,
					signal,
				});
			} catch (error) {
				signal.throwIfAborted();
				const boxFailure = claudeBoxFailureCode(error);
				console.error(`The Claude Code box did not start (${boxFailure})`);
				return blocked(
					error instanceof CloudHomeChannelRefused
						? cloudHomeRefusalWords(error.reason)
						: CLAUDE_WORKER_WORDS.boxFailed,
					{ boxFailure },
				);
			}
			// The early seal: a credentials file Claude Code replaced soon after its start (its renewal) goes back at once, so a
			// run host that dies later leaves the member signed in.
			const started = performance.now();
			const watching = new AbortController();
			const watch = (async () => {
				let seen = before;
				const until = started + (options.earlySealMs ?? 120_000);
				while (!watching.signal.aborted && performance.now() < until) {
					await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250).unref?.());
					const now = await credentialsStamp(folder);
					if (now !== null && now !== seen) {
						// The early seal is the one that counts for a run that is stopped later (its job's end closes the
						// vault to it): a failed one is tried again, a few times, while the run goes on.
						for (let attempt = 0; attempt < 5 && !watching.signal.aborted; attempt++) {
							if (await (keeper?.sync(signal) ?? Promise.resolve(true)).catch(() => false)) break;
							await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)).unref?.());
						}
						seen = now;
					}
				}
			})();
			let toolsWrong = false;
			try {
				for await (const line of box.lines) {
					const hadInit = stream.init !== null;
					for (const step of stream.push(line)) options.step?.(step);
					if (stream.beforeInit) {
						toolsWrong = true;
						break;
					}
					if (!hadInit && stream.init) {
						if (!stream.toolsAsAllowed()) {
							toolsWrong = true;
							break;
						}
						options.step?.({ start: { model: stream.init.model, sessionId: stream.init.sessionId } });
					}
				}
			} finally {
				if (toolsWrong) await box.close();
				await box.exited;
				watching.abort();
				await watch;
			}
			signal.throwIfAborted();
			const facts = {
				steps: stream.steps.length + stream.uncounted,
				...(stream.init ? { model: stream.init.model, sessionId: stream.init.sessionId } : {}),
			};
			if (toolsWrong) return blocked(CLAUDE_WORKER_WORDS.toolsWrong, facts);
			// A successful result is the report, whatever an earlier message said.
			if (stream.result && !stream.result.isError)
				return {
					outcome: "succeeded",
					summary: claudeWorkerReportText(
						stream.result.text || "Claude Code finished and said nothing more.",
						SUMMARY_BYTES,
					),
					...facts,
				};
			if (stream.limit)
				return blocked(CLAUDE_WORKER_WORDS.limit(member, stream.limit.words, stream.limit.toolsAfter === 0), facts);
			if (stream.signedOut) return blocked(CLAUDE_WORKER_WORDS.signedOut(member), facts);
			const result = stream.result;
			if (!result) return blocked(CLAUDE_WORKER_WORDS.cut(facts.steps > 0), facts);
			return blocked(CLAUDE_WORKER_WORDS.failed(oneLine(result.text || result.subtype, WORDS_CHARS)), facts);
		})();
	} finally {
		await box?.close().catch(() => undefined);
		// Sealed back before anything else ends, also on a stop or a failure: the credentials Claude Code renewed are the
		// member's only valid ones. Bounded, so a stopped run still ends.
		if (keeper) await keeper.sync(AbortSignal.timeout(20_000)).catch(() => undefined);
		await wipeClaudeLoginFolder(folder).catch(() => undefined);
		if (scratchRoot)
			await rm(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() =>
				console.error("The Claude Code box's scratch folder was not removed"),
			);
	}
	return keeper ? { ...outcome, login: { sealed: keeper.sealed, stale: keeper.stale } } : outcome;
}

/** What the run's records say did the work: Claude Code's build and the model its init line named. */
export function claudeWorkerSessionId(
	outcome: Pick<ClaudeWorkerOutcome, "model" | "sessionId" | "boxFailure">,
): string {
	const part = (value: string | undefined) => (value ? value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 200) : "none");
	const id = `claude-code/${CLAUDE_CODE_PIN.version}/${part(outcome.model)}/${part(outcome.sessionId)}`;
	return outcome.boxFailure ? `${id}/${part(outcome.boxFailure)}` : id;
}

/** A blocked outcome in these words, before any of Claude Code ran (no machine for the run, for instance). */
export function claudeWorkerBlocked(words: string): ClaudeWorkerOutcome {
	return blocked(words);
}

/** The run's admitted tool catalog: Claude Code's own tools, under names of its own, and no tool of Qorpera's. The
 * admission records it, so the run's record says which program worked and with what. */
export const CLAUDE_WORKER_CATALOG = Object.freeze({
	type: "namespace",
	name: "qorpera",
	description: `Claude Code ${CLAUDE_CODE_PIN.version} works this worker's run on the agent's own machine, with its own tools and no others. No tool of Qorpera's is offered; the run reports Claude Code's last message as the worker's results.`,
	tools: CLAUDE_BOX_TOOLS.map((name) => ({
		type: "function",
		name: `claude_code_${name.toLowerCase()}`,
		description: `Claude Code's own ${name} tool, on the agent's machine.`,
		inputSchema: { type: "object", additionalProperties: false },
	})),
});

/** The run's login through the vault's two routes (C4b's client), for one run's binding. Only `.credentials.json` is
 * sealed back (C2's contract: Claude Code's renewal rewrites it); the vault keeps every other file as the run opened it. */
export function claudeWorkerLogins(client: ClaudeLoginRunClient, binding: ModelLoginRunBinding): ClaudeWorkerLogins {
	return {
		open: (signal) => openClaudeLoginForRun(client, binding, signal),
		seal: async (base, credentials, signal) => {
			const answer = await sealClaudeLoginBack(
				client,
				{ binding, opened: base, files: new Map([[".credentials.json", credentials]]) },
				signal,
			);
			if (answer.state === "unchanged") return { state: "unchanged" };
			if (answer.state === "refused") return { state: "refused", reason: answer.reason };
			if (answer.state === "sealed") return { state: "sealed", version: answer.version, base: answer.opened };
			return { state: "stale", version: answer.version };
		},
	};
}

/**
 * The files the run's machine view wrote, once they stand still. The home's window closes when its channel ends, and the
 * view's last boundary (what its quiet period still held) commits after that, credited to the run for two minutes
 * (20260930754000); the run does not hear when. So the list is read after a short wait and again until two reads agree,
 * within a bound. A read that fails keeps the list read before it. A stop throws.
 */
export async function claudeWorkerSettledOutputs(
	read: (signal: AbortSignal) => Promise<readonly string[]>,
	signal: AbortSignal,
	options: { firstMs?: number; stepMs?: number; untilMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<readonly string[]> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
	const step = options.stepMs ?? 2_000;
	const until = options.untilMs ?? 12_000;
	// A read that fails answers nothing: it neither agrees with the read before it nor replaces it.
	const attempt = async (): Promise<readonly string[] | undefined> => {
		try {
			return await read(signal);
		} catch {
			signal.throwIfAborted();
			return undefined;
		}
	};
	await sleep(options.firstMs ?? 2_000);
	signal.throwIfAborted();
	let last = await attempt();
	for (let waited = 0; waited < until; waited += step) {
		await sleep(step);
		signal.throwIfAborted();
		const next = await attempt();
		if (next === undefined) continue;
		if (last && next.join("\n") === last.join("\n")) return next;
		last = next;
	}
	return last ?? [];
}
