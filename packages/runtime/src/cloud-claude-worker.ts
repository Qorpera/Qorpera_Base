import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { folderKey } from "@qorpera/contracts";
import {
	CLAUDE_BOX_TOOLS,
	CLAUDE_CODE_PIN,
	type ClaudeCodeBox,
	type ClaudeCodeBoxOptions,
	claudeBoxStartStage,
} from "./cloud-claude-box.ts";
import { type ClaudeLoginFileName, wipeClaudeLoginFolder } from "./cloud-claude-login-renewal.ts";
import { type ClaudeLoginUsage, claudeUsageFromRateLimitInfo } from "./cloud-claude-login-usage.ts";
import { CLAUDE_PICTURE_NOTE } from "./cloud-claude-picture-command.ts";
import { cloudHomeRefusalWords } from "./cloud-codex-home.ts";
import { CloudHomeChannelRefused } from "./cloud-home-channel.ts";
import type { ModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import { type CloudRuntimeClaudeChoice, isCloudRuntimeClaudeChoice } from "./cloud-runtime-policy.ts";
import { type ClaudeLoginRunClient, openClaudeLoginForRun } from "./cloud-secret-broker-http.ts";
import { CloudSecretBrokerBusyError } from "./cloud-vault-database-failure.ts";

// ---------------------------------------------------------------------------------------------------------------------
// What Claude Code is told

/** Appended to Claude Code's own system prompt (`--append-system-prompt-file`). No Qorpera tool names: it has none. */
export const CLAUDE_WORKER_SYSTEM_NOTE = [
	"You work on the company's machine as its agent.",
	"/company is the company's folder: a change you save there is saved for the whole company, with its history.",
	"Your file tools (Read, Write, Edit, NotebookEdit, Grep, Glob) see only /company, your home folder /var/lib/qorpera-agent and /tmp of that machine: use the shell for everything else on it. A file tool aimed at any other path reads or writes this program's own scratch space, not the machine.",
	"Never write a password, key or token into /company.",
	"sudo is yours on the machine.",
	CLAUDE_PICTURE_NOTE,
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
	readonly claude?: CloudRuntimeClaudeChoice;
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
		...(isCloudRuntimeClaudeChoice(payload.claude)
			? { claude: { model: payload.claude.model, effort: payload.claude.effort } }
			: {}),
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
	const socket = fields.ws && typeof fields.ws === "object" ? (fields.ws as Record<string, unknown>).url : undefined;
	const search = (): string => [first("pattern"), first("path")].filter(Boolean).join(" in ");
	const byTool: Readonly<Record<string, () => string>> = {
		Bash: () => first("command").split("\n")[0] ?? "",
		Monitor: () => first("command").split("\n")[0] || (typeof socket === "string" ? socket : ""),
		Grep: search,
		Glob: search,
		Task: () => [first("subagent_type"), first("description")].filter(Boolean).join(": "),
		WebSearch: () => first("query"),
		Skill: () => first("skill"),
	};
	const what = Object.hasOwn(byTool, tool)
		? byTool[tool]()
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
	beforeInit = false;
	usage: ClaudeLoginUsage | null = null;

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
		if (event.type === "rate_limit_event") {
			this.usage = claudeUsageFromRateLimitInfo(event.rate_limit_info) ?? this.usage;
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

export interface ClaudeWorkerOpenedLogin {
	readonly claudeLoginId: string;
	readonly version: number;
	readonly envelopeSha256: string;
	readonly files: ReadonlyMap<ClaudeLoginFileName, Buffer>;
	readonly fileSha256: Readonly<Partial<Record<ClaudeLoginFileName, string>>>;
}

export interface ClaudeWorkerLogins {
	open(
		signal: AbortSignal,
		knownVersion?: number,
	): Promise<
		| ClaudeWorkerOpenedLogin
		| { readonly refused: "SIGNED_OUT" | "NOT_OPEN" }
		| { readonly current: true; readonly version: number }
	>;
}

export { wipeClaudeLoginFolder };

const BUSY_RETRY_MS = 5_000;
const BUSY_RETRIES = 6;

async function openWhenRenewed(
	logins: ClaudeWorkerLogins,
	signal: AbortSignal,
	retryMs: number,
): Promise<Awaited<ReturnType<ClaudeWorkerLogins["open"]>>> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await logins.open(signal);
		} catch (error) {
			if (!(error instanceof CloudSecretBrokerBusyError) || attempt >= BUSY_RETRIES) throw error;
			await delay(retryMs, undefined, { signal });
		}
	}
}

class ClaudeWorkerLoginRefresher {
	readonly #logins: ClaudeWorkerLogins;
	readonly #folder: string;
	readonly #loginId: string;
	#version: number;
	refreshed = 0;
	ended = false;

	constructor(logins: ClaudeWorkerLogins, folder: string, opened: ClaudeWorkerOpenedLogin) {
		this.#logins = logins;
		this.#folder = folder;
		this.#loginId = opened.claudeLoginId;
		this.#version = opened.version;
	}

	async refresh(signal: AbortSignal): Promise<void> {
		if (this.ended) return;
		const next = await this.#logins.open(signal, this.#version);
		if ("refused" in next) {
			this.ended = true;
			return;
		}
		if ("current" in next) return;
		try {
			const credentials = next.files.get(".credentials.json");
			// WHY: a run keeps the Claude login it started on; another login's files never replace its own.
			if (!credentials || next.claudeLoginId !== this.#loginId || next.version <= this.#version) return;
			const staged = join(this.#folder, ".credentials.json.qorpera-next");
			await rm(staged, { force: true });
			await writeFile(staged, credentials, { mode: 0o600, flag: "wx" });
			await rename(staged, join(this.#folder, ".credentials.json"));
			this.#version = next.version;
			this.refreshed++;
		} finally {
			for (const bytes of next.files.values()) bytes.fill(0);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

export type ClaudeWorkerClaudeSide = "signed_out" | "not_open" | "limit" | "could_not_start";

/** How a Claude Code worker's run ended, for its report. */
export interface ClaudeWorkerOutcome {
	readonly outcome: "succeeded" | "blocked";
	readonly claudeSide?: ClaudeWorkerClaudeSide;
	/** The report's summary: Claude Code's own final message, or the words for why there is none. */
	readonly summary: string;
	/** For a blocked worker: what the agent can do. */
	readonly needs?: string;
	/** What Claude Code's init line named, when it started. */
	readonly model?: string;
	readonly sessionId?: string;
	readonly steps: number;
	readonly login?: { readonly refreshed: number };
	readonly boxFailure?: string;
}

export interface ClaudeWorkerRunOptions {
	readonly brief: ClaudeWorkerBrief;
	/** The member whose plan pays, as the agent knows them. */
	readonly member: string;
	readonly logins: ClaudeWorkerLogins;
	/** Starts the box (launchClaudeCodeBox, with the run's channel, session and home bound). */
	readonly launch: (
		options: Pick<
			ClaudeCodeBoxOptions,
			"scratchRoot" | "login" | "prompt" | "systemNote" | "signal" | "model" | "effort"
		>,
	) => Promise<ClaudeCodeBox>;
	readonly root: string;
	/** Each step as it finishes, for the run's work log. Never throws back into the run. */
	readonly step?: (step: ClaudeWorkerStep | { readonly start: { model: string; sessionId: string } }) => void;
	readonly usage?: (usage: ClaudeLoginUsage) => void;
	readonly signal: AbortSignal;
	readonly refreshMs?: number;
	readonly busyRetryMs?: number;
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
		opened = await openWhenRenewed(options.logins, signal, options.busyRetryMs ?? BUSY_RETRY_MS);
	} catch {
		// The vault unreachable, or an answer out of shape: nothing of Claude Code ran. Only a stop throws.
		signal.throwIfAborted();
		return blocked(CLAUDE_WORKER_WORDS.openFailed(member), { claudeSide: "could_not_start" });
	}
	if ("refused" in opened)
		return opened.refused === "SIGNED_OUT"
			? blocked(CLAUDE_WORKER_WORDS.signedOut(member), { claudeSide: "signed_out" })
			: blocked(CLAUDE_WORKER_WORDS.notOpen(member), { claudeSide: "not_open" });
	if ("current" in opened) return blocked(CLAUDE_WORKER_WORDS.openFailed(member), { claudeSide: "could_not_start" });
	const login = opened;
	const folder = join(options.root, "claude-login");
	let scratchRoot: string | undefined;
	let refresher: ClaudeWorkerLoginRefresher | undefined;
	let box: ClaudeCodeBox | undefined;
	const stream = new ClaudeWorkerStream();
	let outcome: ClaudeWorkerOutcome;
	try {
		outcome = await (async (): Promise<ClaudeWorkerOutcome> => {
			try {
				await mkdir(folder, { mode: 0o700 });
				scratchRoot = await mkdtemp(claudeWorkerScratchPrefix(options.root));
				for (const [name, bytes] of login.files)
					await writeFile(join(folder, name), bytes, { mode: 0o600, flag: "wx" });
			} catch {
				// The run's folders could not be made: nothing of Claude Code ran (what was written goes in `finally`).
				signal.throwIfAborted();
				return blocked(CLAUDE_WORKER_WORDS.openFailed(member), { claudeSide: "could_not_start" });
			} finally {
				for (const bytes of login.files.values()) bytes.fill(0);
			}
			refresher = new ClaudeWorkerLoginRefresher(options.logins, folder, login);
			try {
				box = await options.launch({
					scratchRoot: scratchRoot as string,
					login: { folder },
					prompt: claudeWorkerPrompt(options.brief),
					systemNote: CLAUDE_WORKER_SYSTEM_NOTE,
					signal,
					...(options.brief.claude
						? { model: options.brief.claude.model, effort: options.brief.claude.effort }
						: {}),
				});
			} catch (error) {
				signal.throwIfAborted();
				const boxFailure = claudeBoxFailureCode(error);
				console.error(`The Claude Code box did not start (${boxFailure})`);
				return blocked(
					error instanceof CloudHomeChannelRefused
						? cloudHomeRefusalWords(error.reason)
						: CLAUDE_WORKER_WORDS.boxFailed,
					{ boxFailure, claudeSide: "could_not_start" },
				);
			}
			const watching = new AbortController();
			const keepFresh = refresher;
			const watch = (async () => {
				const every = options.refreshMs ?? 60_000;
				while (!watching.signal.aborted && !keepFresh.ended) {
					await delay(every, undefined, { signal: watching.signal, ref: false }).catch(() => undefined);
					if (watching.signal.aborted) break;
					await keepFresh.refresh(AbortSignal.any([signal, watching.signal])).catch(() => undefined);
				}
			})();
			let toolsWrong = false;
			try {
				for await (const line of box.lines) {
					const hadInit = stream.init !== null;
					const usage = stream.usage;
					for (const step of stream.push(line)) options.step?.(step);
					if (stream.usage && stream.usage !== usage) options.usage?.(stream.usage);
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
			if (toolsWrong) return blocked(CLAUDE_WORKER_WORDS.toolsWrong, { ...facts, claudeSide: "could_not_start" });
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
				return blocked(CLAUDE_WORKER_WORDS.limit(member, stream.limit.words, stream.limit.toolsAfter === 0), {
					...facts,
					claudeSide: "limit",
				});
			if (stream.signedOut)
				return blocked(CLAUDE_WORKER_WORDS.signedOut(member), { ...facts, claudeSide: "signed_out" });
			const result = stream.result;
			if (!result)
				return blocked(
					CLAUDE_WORKER_WORDS.cut(facts.steps > 0),
					facts.steps > 0 ? facts : { ...facts, claudeSide: "could_not_start" },
				);
			return blocked(CLAUDE_WORKER_WORDS.failed(oneLine(result.text || result.subtype, WORDS_CHARS)), facts);
		})();
	} finally {
		await box?.close().catch(() => undefined);
		await wipeClaudeLoginFolder(folder).catch(() => undefined);
		if (scratchRoot)
			await rm(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() =>
				console.error("The Claude Code box's scratch folder was not removed"),
			);
	}
	return refresher ? { ...outcome, login: { refreshed: refresher.refreshed } } : outcome;
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
	return blocked(words, { claudeSide: "could_not_start" });
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

export function claudeWorkerLogins(client: ClaudeLoginRunClient, binding: ModelLoginRunBinding): ClaudeWorkerLogins {
	return { open: (signal, knownVersion) => openClaudeLoginForRun(client, binding, signal, knownVersion) };
}

const CLAUDE_CODE_TEMPORARY_FILE = /^(.+)\.tmp\.[1-9][0-9]{0,9}\.[0-9a-f]{12}$/;

export function claudeWorkerReportedOutputs(paths: unknown, resultsFile: string): string[] {
	const listed = (Array.isArray(paths) ? paths : []).filter(
		(path): path is string =>
			typeof path === "string" && path === path.trim() && !/[\r\n]/.test(path) && Buffer.byteLength(path) <= 256,
	);
	const written = new Set(listed.map(folderKey));
	return listed.filter((path) => {
		if (path === resultsFile) return false;
		const file = CLAUDE_CODE_TEMPORARY_FILE.exec(path)?.[1];
		return file === undefined || !written.has(folderKey(file));
	});
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
