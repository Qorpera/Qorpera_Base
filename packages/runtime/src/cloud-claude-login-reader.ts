import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withAbortScopes } from "./abort-scope.ts";
import {
	CLAUDE_RESET_ARGUMENTS,
	type ClaudeLoginResets,
	type ClaudeLoginUsage,
	type ClaudeResetEntry,
	type ClaudeResetKind,
	type ClaudeResetOutcome,
	type ClaudeResetScreen,
	ClaudeTerminal,
	claudeResetAnswer,
	claudeResetEntry,
	claudeUsageFromGetUsage,
	readClaudeResetScreen,
} from "./cloud-claude-login-usage.ts";
import {
	launchIsolatedNativeProcess,
	NATIVE_CLAUDE_TERMINAL,
	type NativeClaudeRead,
	type NativeIsolationConfiguration,
	nativeTerminalCommand,
} from "./cloud-native-isolation.ts";

export interface ClaudeLoginRead {
	readonly usage: ClaudeLoginUsage | null;
	readonly resets: ClaudeLoginResets | null;
}

export interface ClaudeLoginReads {
	readClaudeLogin(
		request: { readonly credentials: string; readonly usage: boolean; readonly resets: boolean },
		signal: AbortSignal,
	): Promise<ClaudeLoginRead>;
	useClaudeReset(
		request: { readonly credentials: string; readonly kind: ClaudeResetKind },
		signal: AbortSignal,
	): Promise<ClaudeResetOutcome>;
}

const USAGE_ARGUMENTS = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--setting-sources",
	"user",
	"--strict-mcp-config",
	"--tools",
	"",
];
const MAX_OUTPUT_CHARACTERS = 4 * 1024 * 1024;
const MAX_CREDENTIALS_BYTES = 16 * 1024;
const USAGE_MS = 15_000;
const SCREEN_MS = 20_000;
const CLAIM_MS = 45_000;
const POLL_MS = 200;
const SETTLE_MS = 1_200;
const SCREEN_LAUNCHES = 3;
const UNCHECKED = "Couldn't check for a reset right now · try again in a moment";
const ONBOARDED = '{"hasCompletedOnboarding":true}\n';

interface ClaudeProcess {
	readonly child: ChildProcessWithoutNullStreams;
	close(): Promise<void>;
}

function absolute(value: string, label: string): string {
	if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be absolute`);
	return value;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolvePause, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolvePause();
		}, milliseconds);
		const stop = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", stop, { once: true });
	});
}

export class ClaudeLoginReader implements ClaudeLoginReads {
	readonly #claudePath: string;
	readonly #temporaryRoot: string;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #beforeLaunch: (() => Promise<void>) | undefined;
	readonly #environment: Readonly<Record<string, string>>;
	readonly #timings: { readonly screenMs: number; readonly claimMs: number; readonly settleMs: number };

	constructor(options: {
		claudePath: string;
		temporaryRoot: string;
		isolation?: NativeIsolationConfiguration;
		beforeLaunch?: () => Promise<void>;
		environment?: Readonly<Record<string, string>>;
		timings?: { readonly screenMs: number; readonly claimMs: number; readonly settleMs: number };
	}) {
		this.#claudePath = absolute(options.claudePath, "Claude Code path");
		this.#temporaryRoot = absolute(options.temporaryRoot, "Claude read root");
		this.#isolation = options.isolation;
		this.#beforeLaunch = options.beforeLaunch;
		if (options.isolation && options.environment) throw new Error("An isolated Claude read takes no environment");
		this.#environment = options.environment ?? {};
		this.#timings = options.timings ?? { screenMs: SCREEN_MS, claimMs: CLAIM_MS, settleMs: SETTLE_MS };
	}

	async readClaudeLogin(
		request: { readonly credentials: string; readonly usage: boolean; readonly resets: boolean },
		signal: AbortSignal,
	): Promise<ClaudeLoginRead> {
		return this.#withLogin(request.credentials, async (root) => {
			const usage = request.usage ? await this.#usage(root, signal).catch(() => null) : null;
			const resets = request.resets ? await this.#resets(root, signal).catch(() => null) : null;
			return { usage, resets };
		});
	}

	async useClaudeReset(
		request: { readonly credentials: string; readonly kind: ClaudeResetKind },
		signal: AbortSignal,
	): Promise<ClaudeResetOutcome> {
		return this.#withLogin(request.credentials, async (root) => {
			for (let launch = 1; ; launch += 1) {
				const run = await this.#launch(
					root,
					[`/limit-reset ${CLAUDE_RESET_ARGUMENTS[request.kind]}`],
					"screen",
					signal,
				);
				const watch = this.#watch(run);
				try {
					const shown = await this.#until(
						watch,
						(screen) =>
							screen.kind === "confirm" ||
							(screen.kind === "answer" && (!!claudeResetAnswer(screen.line) || screen.line === UNCHECKED)),
						this.#timings.screenMs,
						signal,
					);
					if (shown?.kind === "answer" && shown.line === UNCHECKED && launch < SCREEN_LAUNCHES) continue;
					if (shown?.kind !== "confirm" || shown.reset !== request.kind || !shown.yesFocused)
						return { outcome: "failed" };
					await pause(this.#timings.settleMs, signal);
					const still = watch.screen();
					if (still?.kind !== "confirm" || still.reset !== request.kind || !still.yesFocused)
						return { outcome: "failed" };
					run.child.stdin.write("\r");
					const answered = await this.#until(
						watch,
						(screen) => screen.kind === "answer" && !!claudeResetAnswer(screen.line),
						this.#timings.claimMs,
						signal,
					);
					const answer = answered?.kind === "answer" ? claudeResetAnswer(answered.line) : undefined;
					if (answer?.kind === "reset") return { outcome: "reset", left: answer.left };
					if (answer?.kind === "failed") return { outcome: "failed" };
					return { outcome: "unconfirmed" };
				} finally {
					await run.close();
				}
			}
		});
	}

	async #withLogin<T>(credentials: string, work: (root: string) => Promise<T>): Promise<T> {
		if (typeof credentials !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials))
			throw new Error("Claude login credentials are invalid");
		const bytes = Buffer.from(credentials, "base64");
		const root = await mkdtemp(join(this.#temporaryRoot, "qorpera-claude-read-"));
		try {
			if (bytes.byteLength < 2 || bytes.byteLength > MAX_CREDENTIALS_BYTES)
				throw new Error("Claude login credentials are invalid");
			await mkdir(join(root, "claude"), { mode: 0o700 });
			await writeFile(join(root, "claude", ".credentials.json"), bytes, { mode: 0o600, flag: "wx" });
			await writeFile(join(root, "claude", ".claude.json"), ONBOARDED, { mode: 0o600, flag: "wx" });
			return await work(root);
		} finally {
			bytes.fill(0);
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}

	async #launch(root: string, args: string[], read: NativeClaudeRead, signal: AbortSignal): Promise<ClaudeProcess> {
		signal.throwIfAborted();
		await this.#beforeLaunch?.();
		const scratchRoot = await mkdtemp(join(root, "s"));
		for (const path of ["workspace", "home", "config", "data", "cache"])
			await mkdir(join(scratchRoot, path), { mode: 0o700 });
		const configDirectory = join(root, "claude");
		if (this.#isolation) {
			const isolated = await launchIsolatedNativeProcess({
				configuration: this.#isolation,
				command: this.#claudePath,
				args,
				scratchRoot,
				codexHome: configDirectory,
				harness: "claude-code",
				claudeRead: read,
				signal,
			});
			isolated.child.stdin.on("error", () => undefined);
			return { child: isolated.child, close: () => isolated.close() };
		}
		const environment = {
			HOME: join(scratchRoot, "home"),
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			TZ: "UTC",
			NO_COLOR: "1",
			CLAUDE_CONFIG_DIR: configDirectory,
			DISABLE_AUTOUPDATER: "1",
			...(read === "usage"
				? { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" }
				: {
						CLAUDE_CODE_SANDBOXED: "1",
						TERM: "xterm-256color",
						COLUMNS: String(NATIVE_CLAUDE_TERMINAL.cols),
						LINES: String(NATIVE_CLAUDE_TERMINAL.rows),
						SHELL: "/bin/sh",
					}),
			...this.#environment,
		};
		const child =
			read === "screen"
				? spawn("/usr/bin/script", nativeTerminalCommand("/usr/bin/stty", this.#claudePath, args), {
						cwd: join(scratchRoot, "workspace"),
						env: environment,
						stdio: ["pipe", "pipe", "pipe"],
						detached: true,
					})
				: spawn(this.#claudePath, args, {
						cwd: join(scratchRoot, "workspace"),
						env: environment,
						stdio: ["pipe", "pipe", "pipe"],
						detached: true,
					});
		let closed = false;
		const waitForClose = (ms: number): Promise<void> => {
			if (closed) return Promise.resolve();
			return new Promise<void>((resolveExit) => {
				const onClose = (): void => {
					clearTimeout(timer);
					resolveExit();
				};
				const timer = setTimeout(() => {
					child.removeListener("close", onClose);
					resolveExit();
				}, ms);
				timer.unref?.();
				child.once("close", onClose);
			});
		};
		child.once("close", () => {
			closed = true;
		});
		const kill = (): void => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		signal.addEventListener("abort", kill, { once: true });
		child.once("error", () => undefined);
		child.stdin.on("error", () => undefined);
		return {
			child,
			async close() {
				signal.removeEventListener("abort", kill);
				if (!closed && child.exitCode === null && child.signalCode === null) {
					if (read === "screen") {
						if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write("\x03");
						await waitForClose(150);
						if (!closed && child.exitCode === null && child.signalCode === null) {
							if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write("\x03");
							await waitForClose(3000);
						}
					}
					if (!closed && child.exitCode === null && child.signalCode === null) {
						kill();
						await waitForClose(2000);
					}
				}
			},
		};
	}

	async #usage(root: string, signal: AbortSignal): Promise<ClaudeLoginUsage | null> {
		return withAbortScopes(
			[signal],
			async (deadline) => {
				const run = await this.#launch(root, USAGE_ARGUMENTS, "usage", deadline);
				let onAbort: (() => void) | undefined;
				try {
					const id = `usage-${randomUUID()}`;
					const answered = new Promise<unknown>((resolveAnswer, reject) => {
						let buffered = "";
						let total = 0;
						run.child.stdout.setEncoding("utf8");
						run.child.stdout.on("data", (chunk: string) => {
							total += chunk.length;
							if (total > MAX_OUTPUT_CHARACTERS) {
								reject(new Error("Claude Code said too much"));
								return;
							}
							buffered += chunk;
							let end = buffered.indexOf("\n");
							while (end >= 0) {
								const line = buffered.slice(0, end);
								buffered = buffered.slice(end + 1);
								end = buffered.indexOf("\n");
								try {
									const event = JSON.parse(line) as { type?: unknown; response?: Record<string, unknown> };
									if (event.type === "control_response" && event.response?.request_id === id)
										resolveAnswer(event.response);
								} catch {}
							}
						});
						run.child.stdout.once("end", () => reject(new Error("Claude Code ended without its usage")));
						onAbort = () => reject(deadline.reason);
						deadline.addEventListener("abort", onAbort, { once: true });
					});
					run.child.stderr.resume();
					run.child.stdin.write(
						`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_usage", skip_behaviors: true } })}\n`,
					);
					const response = (await answered) as { subtype?: unknown; response?: unknown };
					return response.subtype === "success" ? (claudeUsageFromGetUsage(response.response) ?? null) : null;
				} finally {
					if (onAbort) deadline.removeEventListener("abort", onAbort);
					run.child.stdin.end();
					await run.close();
				}
			},
			USAGE_MS,
		);
	}

	#watch(run: ClaudeProcess): { screen(): ClaudeResetScreen | undefined; ended(): boolean } {
		const terminal = new ClaudeTerminal(NATIVE_CLAUDE_TERMINAL.rows, NATIVE_CLAUDE_TERMINAL.cols);
		let total = 0;
		let ended = false;
		run.child.stdout.setEncoding("utf8");
		run.child.stdout.on("data", (chunk: string) => {
			total += chunk.length;
			if (total <= MAX_OUTPUT_CHARACTERS) terminal.feed(chunk);
		});
		run.child.stdout.once("end", () => {
			ended = true;
		});
		run.child.stderr.resume();
		return { screen: () => readClaudeResetScreen(terminal.lines()), ended: () => ended };
	}

	async #until(
		watch: { screen(): ClaudeResetScreen | undefined; ended(): boolean },
		done: (screen: ClaudeResetScreen) => boolean,
		milliseconds: number,
		signal: AbortSignal,
	): Promise<ClaudeResetScreen | undefined> {
		const until = Date.now() + milliseconds;
		while (Date.now() < until) {
			const screen = watch.screen();
			if (screen && done(screen)) return screen;
			if (watch.ended()) return watch.screen();
			await pause(POLL_MS, signal);
		}
		return undefined;
	}

	async #confirm(
		root: string,
		kind: ClaudeResetKind | undefined,
		signal: AbortSignal,
	): Promise<ClaudeResetScreen | undefined> {
		for (let launch = 1; ; launch += 1) {
			const run = await this.#launch(
				root,
				[kind ? `/limit-reset ${CLAUDE_RESET_ARGUMENTS[kind]}` : "/limit-reset"],
				"screen",
				signal,
			);
			try {
				const shown = await this.#until(
					this.#watch(run),
					(screen) => screen.kind !== "answer" || !!claudeResetAnswer(screen.line) || screen.line === UNCHECKED,
					this.#timings.screenMs,
					signal,
				);
				if (shown?.kind !== "answer" || shown.line !== UNCHECKED || launch >= SCREEN_LAUNCHES) return shown;
			} finally {
				await run.close();
			}
		}
	}

	async #resets(root: string, signal: AbortSignal): Promise<ClaudeLoginResets | null> {
		const observedAt = new Date().toISOString();
		const shown = await this.#confirm(root, undefined, signal);
		if (shown?.kind === "confirm") return { observedAt, entries: [claudeResetEntry(shown)] };
		if (shown?.kind === "choose") {
			const entries: ClaudeResetEntry[] = [];
			for (const offer of shown.offers) {
				const each = await this.#confirm(root, offer.reset, signal);
				if (each?.kind !== "confirm" || each.reset !== offer.reset) return null;
				entries.push(claudeResetEntry(each));
			}
			return { observedAt, entries };
		}
		const answer = shown?.kind === "answer" ? claudeResetAnswer(shown.line) : undefined;
		if (answer?.kind === "none") return { observedAt, entries: [] };
		if (answer?.kind === "saved")
			return {
				observedAt,
				entries: [
					{
						kind: null,
						left: answer.left,
						refills: null,
						weekStays: null,
						useBy: answer.useBy,
						usable: "at_limit",
					},
				],
			};
		return null;
	}
}
