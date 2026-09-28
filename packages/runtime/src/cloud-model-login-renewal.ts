import { type ChildProcessByStdio, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { CODEX_RENEWAL_BUDGET_MS } from "./cloud-model-login-budget.ts";
import type { ModelLoginRenewal, ModelLoginRenewer } from "./cloud-model-login-vault.ts";
import { launchIsolatedNativeProcess, type NativeIsolationConfiguration } from "./cloud-native-isolation.ts";

/**
 * Renews one Codex login with the unmodified official Codex, for the vault only.
 *
 * The login is written into a fresh private `CODEX_HOME`; `codex app-server` is asked for the
 * account with `refreshToken: true`, which runs Codex's own renewal and saves the renewed login
 * in that home. No model, thread, tool or company data is involved. The home is wiped after.
 *
 * Codex answers `account/read` the same way whether the renewal worked or not, so the outcome is
 * read from the login file (changed means renewed) and, on failure, from Codex's own error line
 * `Failed to refresh token: <status>: <body>`, with Codex's own rule (0.155.1
 * `request_chatgpt_token_refresh`): a 401, the body code `refresh_token_expired`,
 * `refresh_token_reused` or `refresh_token_invalidated` (any case), or a 400 with the code
 * `invalid_grant` is permanent. Anything else may be retried.
 */

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AUTH_JSON_BYTES = 32 * 1024;
const CLIENT_NAME = "qorpera_model_login_vault";
const REFUSED_CODES = new Set(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

interface RenewalProcess {
	stdin: NodeJS.WritableStream & { writable: boolean };
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	exited: Promise<void>;
	/** Whether the process could not be started at all (a spawn `error`). */
	failedToStart(): boolean;
	kill(): void;
	close(): Promise<void>;
}

function harnessEnvironment(root: string): NodeJS.ProcessEnv {
	const home = join(root, "home");
	return {
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: join(root, "codex"),
		XDG_CONFIG_HOME: join(root, "xdg", "config"),
		XDG_DATA_HOME: join(root, "xdg", "data"),
		XDG_CACHE_HOME: join(root, "xdg", "cache"),
		PATH: process.env.PATH ?? "",
		NO_COLOR: "1",
		BROWSER: "echo",
		DISABLE_AUTOUPDATER: "1",
	};
}

/** Reads newline-delimited JSON-RPC answers by id; notifications and other lines are ignored.
 * Output past the cap stops Codex: the renewal then ends at once instead of waiting it out. */
function answers(stdout: NodeJS.ReadableStream, overflow: () => void): (id: number) => Promise<unknown> {
	const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const settled = new Map<number, { result?: unknown; error?: unknown }>();
	let buffered = "";
	let total = 0;
	stdout.setEncoding?.("utf8");
	stdout.on("data", (chunk: string) => {
		total += Buffer.byteLength(chunk);
		if (total > 4 * MAX_OUTPUT_BYTES) {
			overflow();
			return;
		}
		buffered += chunk;
		let end = buffered.indexOf("\n");
		while (end >= 0) {
			const line = buffered.slice(0, end).trim();
			buffered = buffered.slice(end + 1);
			end = buffered.indexOf("\n");
			if (!line.startsWith("{")) continue;
			let message: { id?: unknown; result?: unknown; error?: unknown };
			try {
				message = JSON.parse(line) as typeof message;
			} catch {
				continue;
			}
			if (typeof message.id !== "number" || (!("result" in message) && !("error" in message))) continue;
			const pending = waiting.get(message.id);
			if (pending) {
				waiting.delete(message.id);
				if ("error" in message) pending.reject(new Error("Codex refused the request"));
				else pending.resolve(message.result);
			} else settled.set(message.id, message);
		}
	});
	return (id) =>
		new Promise((resolveAnswer, reject) => {
			const early = settled.get(id);
			if (early) {
				settled.delete(id);
				if ("error" in early) reject(new Error("Codex refused the request"));
				else resolveAnswer(early.result);
				return;
			}
			waiting.set(id, { resolve: resolveAnswer, reject });
		});
}

/** Codex's `extract_refresh_token_error_code`: `error.code`, a string `error`, or `code`. */
function refreshErrorCode(body: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const map = value as Record<string, unknown>;
	const error = map.error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const code = (error as Record<string, unknown>).code;
		if (typeof code === "string") return code;
	} else if (typeof error === "string") return error;
	return typeof map.code === "string" ? map.code : undefined;
}

/** The body after a `Failed to refresh token: <status>: ` line: the longest leading JSON value. */
function refreshErrorBody(rest: string): string {
	const body = rest.slice(0, 16 * 1024);
	for (let end = body.lastIndexOf("}"); end > 0; end = body.lastIndexOf("}", end - 1)) {
		const candidate = body.slice(0, end + 1);
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			// A shorter prefix may be the JSON body followed by later log lines.
		}
	}
	return body.split("\n")[0] ?? "";
}

/** Applies Codex's own permanent-failure rule to its `Failed to refresh token` error lines. */
export function classifyCodexRenewalFailure(stderr: string): string | undefined {
	const line = /Failed to refresh token: (\d{3})\b[^:\n]*: /g;
	for (let found = line.exec(stderr); found; found = line.exec(stderr)) {
		const status = Number(found[1]);
		const code = refreshErrorCode(refreshErrorBody(stderr.slice(found.index + found[0].length)))?.toLowerCase();
		if (code && REFUSED_CODES.has(code)) return code;
		if (status === 400 && code === "invalid_grant") return "refresh_token_invalid_grant";
		if (status === 401) return "refresh_token_unauthorized";
	}
	return undefined;
}

/**
 * The helper's start-up self-check: the pinned Codex, launched exactly as a renewal or sign-in
 * launches it (inside the isolation when configured), answers `--version`. It proves the binary,
 * the sandbox and the unit's system-call filter on the real host; it makes no network call.
 */
export async function codexSelfCheck(options: {
	codexPath: string;
	temporaryRoot: string;
	isolation?: NativeIsolationConfiguration;
	timeoutMs?: number;
}): Promise<string> {
	const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
	const root = await mkdtemp(join(options.temporaryRoot, "qorpera-login-self-check-"));
	try {
		const scratchRoot = join(root, "scratch");
		for (const path of [
			"codex",
			"scratch",
			...["workspace", "home", "config", "data", "cache"].map((name) => join("scratch", name)),
		])
			await mkdir(join(root, path), { recursive: true, mode: 0o700 });
		let child: ChildProcessWithoutNullStreams | ChildProcessByStdio<null, Readable, Readable>;
		let close: () => Promise<void>;
		if (options.isolation) {
			const isolated = await launchIsolatedNativeProcess({
				configuration: options.isolation,
				command: options.codexPath,
				args: ["--version"],
				scratchRoot,
				codexHome: join(root, "codex"),
				signal,
			});
			isolated.child.stdin.end();
			child = isolated.child;
			close = () => isolated.close();
		} else {
			const direct = spawn(options.codexPath, ["--version"], {
				cwd: root,
				env: harnessEnvironment(root),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child = direct;
			const kill = (): void => {
				direct.kill("SIGKILL");
			};
			signal.addEventListener("abort", kill, { once: true });
			close = async () => {
				signal.removeEventListener("abort", kill);
				if (direct.exitCode === null && direct.signalCode === null) direct.kill("SIGKILL");
			};
		}
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (output.length < 4096) output += chunk.slice(0, 4096 - output.length);
		});
		child.stderr.on("data", () => undefined);
		const exitCode = await new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolveExit(code));
			signal.addEventListener("abort", () => reject(new Error("Codex self-check timed out")), { once: true });
		}).finally(() => close().catch(() => undefined));
		const version = output.split("\n")[0]?.trim() ?? "";
		if (exitCode !== 0 || !/^codex[\w-]* v?\d+\.\d+\.\d+/i.test(version) || version.length > 120)
			throw new Error("Codex self-check did not answer its version");
		return version;
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	}
}

export class CodexLoginRenewer implements ModelLoginRenewer {
	readonly #codexPath: string;
	readonly #temporaryRoot: string;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #timeoutMs: number;
	readonly #beforeLaunch: (() => Promise<void>) | undefined;

	constructor(options: {
		codexPath: string;
		temporaryRoot: string;
		isolation?: NativeIsolationConfiguration;
		timeoutMs?: number;
		/** Checked before every launch (the helper re-checks its pinned binary). */
		beforeLaunch?: () => Promise<void>;
	}) {
		for (const path of [options.codexPath, options.temporaryRoot])
			if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Codex login renewer paths must be absolute");
		this.#codexPath = options.codexPath;
		this.#temporaryRoot = options.temporaryRoot;
		this.#isolation = options.isolation ? Object.freeze({ ...options.isolation }) : undefined;
		this.#timeoutMs = options.timeoutMs ?? CODEX_RENEWAL_BUDGET_MS;
		this.#beforeLaunch = options.beforeLaunch;
	}

	async renew(authJson: string, signal: AbortSignal): Promise<ModelLoginRenewal> {
		if (Buffer.byteLength(authJson, "utf8") > MAX_AUTH_JSON_BYTES) throw new Error("Codex login is too large");
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
		const root = await mkdtemp(join(this.#temporaryRoot, "qorpera-login-renewal-"));
		try {
			for (const path of ["home", "codex", join("xdg", "config"), join("xdg", "data"), join("xdg", "cache")])
				await mkdir(join(root, path), { recursive: true, mode: 0o700 });
			const loginPath = join(root, "codex", "auth.json");
			await writeFile(loginPath, authJson, { mode: 0o600, flag: "wx" });
			let stderr = "";
			let launchFailure: string | undefined;
			try {
				try {
					await this.#beforeLaunch?.();
				} catch (error) {
					launchFailure = "codex_changed";
					throw error;
				}
				let launched: RenewalProcess;
				try {
					launched = await this.#launch(root, deadline);
				} catch (error) {
					launchFailure = "codex_launch_failed";
					throw error;
				}
				launched.stderr.setEncoding?.("utf8");
				launched.stderr.on("data", (chunk: string) => {
					if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
				});
				try {
					const answer = answers(launched.stdout, () => launched.kill());
					const send = (message: Record<string, unknown>): void => {
						if (launched.stdin.writable) launched.stdin.write(`${JSON.stringify(message)}\n`);
					};
					const request = async (id: number, method: string, params: unknown): Promise<unknown> => {
						const answered = answer(id);
						send({ id, method, params });
						return Promise.race([
							answered,
							launched.exited.then(() => {
								throw new Error("Codex stopped before answering");
							}),
							new Promise<never>((_resolve, reject) => {
								if (deadline.aborted) reject(new Error("Codex renewal timed out"));
								deadline.addEventListener("abort", () => reject(new Error("Codex renewal timed out")), {
									once: true,
								});
							}),
						]);
					};
					await request(1, "initialize", { clientInfo: { name: CLIENT_NAME, version: "1" } });
					send({ method: "initialized", params: {} });
					await request(2, "account/read", { refreshToken: true });
				} catch {
					// The login file and Codex's own error line decide below.
				} finally {
					await launched.close().catch(() => undefined);
					if (launched.failedToStart()) launchFailure = "codex_launch_failed";
				}
			} catch {
				// A launch that failed still leaves the login file to read below.
			}
			// Whatever happened, the file decides: Codex saves a renewed login before it answers.
			const renewed = await readFile(loginPath, "utf8").catch(() => undefined);
			if (renewed !== undefined && renewed !== authJson) {
				if (Buffer.byteLength(renewed) > MAX_AUTH_JSON_BYTES)
					return { outcome: "transient", reason: "renewal_too_large" };
				return { outcome: "renewed", authJson: renewed };
			}
			const refused = classifyCodexRenewalFailure(stderr);
			if (refused) return { outcome: "refused", reason: refused };
			return { outcome: "transient", reason: launchFailure ?? "renewal_unchanged" };
		} finally {
			// Codex is stopped by now; a failed removal must not replace the result.
			await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
		}
	}

	async #launch(root: string, signal: AbortSignal): Promise<RenewalProcess> {
		signal.throwIfAborted();
		if (!this.#isolation) {
			const child = spawn(this.#codexPath, ["app-server"], {
				cwd: root,
				env: harnessEnvironment(root),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			// A closed pipe or a failed start must never crash the helper.
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => undefined);
			let startFailed = false;
			const exited = new Promise<void>((resolveExit) => {
				child.once("exit", () => resolveExit());
				child.once("error", () => {
					startFailed = child.pid === undefined;
					resolveExit();
				});
			});
			const kill = (): void => {
				child.kill("SIGKILL");
			};
			signal.addEventListener("abort", kill, { once: true });
			return {
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: child.stderr,
				exited,
				failedToStart: () => startFailed,
				kill,
				async close() {
					signal.removeEventListener("abort", kill);
					child.stdin.end();
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
					await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					await exited;
				},
			};
		}
		const scratchRoot = await mkdtemp(join(this.#temporaryRoot, "qorpera-login-renewal-scratch-"));
		try {
			for (const name of ["workspace", "home", "config", "data", "cache"])
				await mkdir(join(scratchRoot, name), { mode: 0o700 });
			const isolated = await launchIsolatedNativeProcess({
				configuration: this.#isolation,
				command: this.#codexPath,
				args: ["app-server"],
				scratchRoot,
				codexHome: join(root, "codex"),
				signal,
			});
			const child = isolated.child;
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => undefined);
			let startFailed = false;
			const exited = new Promise<void>((resolveExit) => {
				if (child.exitCode !== null || child.signalCode !== null) resolveExit();
				child.once("exit", () => resolveExit());
				child.once("error", () => {
					startFailed = child.pid === undefined;
					resolveExit();
				});
			});
			return {
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: child.stderr,
				exited,
				failedToStart: () => startFailed,
				kill: () => {
					child.kill("SIGKILL");
				},
				async close() {
					child.stdin.end();
					try {
						await isolated.close();
					} finally {
						await rm(scratchRoot, { recursive: true, force: true });
					}
				},
			};
		} catch (error) {
			await rm(scratchRoot, { recursive: true, force: true });
			throw error;
		}
	}
}
