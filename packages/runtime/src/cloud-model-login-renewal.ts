import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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
 * ("Failed to refresh token: <status>: <body>"). Codex treats 401, a known refresh-token code or
 * a 400 `invalid_grant` as permanent; so does this runner. Anything else may be retried.
 */

const REFUSED = [
	["refresh_token_reused", /refresh_token_reused/],
	["refresh_token_expired", /refresh_token_expired/],
	["refresh_token_invalidated", /refresh_token_invalidated/],
	["refresh_token_unauthorized", /Failed to refresh token: 401\b/],
	["refresh_token_invalid_grant", /Failed to refresh token: 400\b[^\n]*invalid_grant/],
] as const;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AUTH_JSON_BYTES = 32 * 1024;
const CLIENT_NAME = "qorpera_model_login_vault";

interface RenewalProcess {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	exited: Promise<void>;
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

/** Reads newline-delimited JSON-RPC answers by id; notifications and other lines are ignored. */
function answers(stdout: NodeJS.ReadableStream): (id: number) => Promise<unknown> {
	const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const settled = new Map<number, { result?: unknown; error?: unknown }>();
	let buffered = "";
	let total = 0;
	stdout.setEncoding?.("utf8");
	stdout.on("data", (chunk: string) => {
		total += Buffer.byteLength(chunk);
		if (total > 4 * MAX_OUTPUT_BYTES) return;
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

export function classifyCodexRenewalFailure(stderr: string): string | undefined {
	for (const [reason, pattern] of REFUSED) if (pattern.test(stderr)) return reason;
	return undefined;
}

export class CodexLoginRenewer implements ModelLoginRenewer {
	readonly #codexPath: string;
	readonly #temporaryRoot: string;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #timeoutMs: number;

	constructor(options: {
		codexPath: string;
		temporaryRoot: string;
		isolation?: NativeIsolationConfiguration;
		timeoutMs?: number;
	}) {
		for (const path of [options.codexPath, options.temporaryRoot])
			if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Codex login renewer paths must be absolute");
		this.#codexPath = options.codexPath;
		this.#temporaryRoot = options.temporaryRoot;
		this.#isolation = options.isolation ? Object.freeze({ ...options.isolation }) : undefined;
		this.#timeoutMs = options.timeoutMs ?? 45_000;
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
			const launched = await this.#launch(root, deadline);
			launched.stderr.setEncoding?.("utf8");
			launched.stderr.on("data", (chunk: string) => {
				if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
			});
			try {
				const answer = answers(launched.stdout);
				const send = (message: Record<string, unknown>): void => {
					launched.stdin.write(`${JSON.stringify(message)}\n`);
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
				await launched.close();
			}
			const renewed = await readFile(loginPath, "utf8").catch(() => undefined);
			if (renewed !== undefined && renewed !== authJson && Buffer.byteLength(renewed) <= MAX_AUTH_JSON_BYTES)
				return { outcome: "renewed", authJson: renewed };
			const refused = classifyCodexRenewalFailure(stderr);
			return refused
				? { outcome: "refused", reason: refused }
				: { outcome: "transient", reason: "renewal_unchanged" };
		} finally {
			await rm(root, { recursive: true, force: true });
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
			const exited = new Promise<void>((resolveExit) => {
				child.once("exit", () => resolveExit());
				child.once("error", () => resolveExit());
			});
			const stop = (): void => {
				child.kill("SIGKILL");
			};
			signal.addEventListener("abort", stop, { once: true });
			return {
				stdin: child.stdin,
				stdout: child.stdout,
				stderr: child.stderr,
				exited,
				async close() {
					signal.removeEventListener("abort", stop);
					child.stdin.end();
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
					await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
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
			const exited = new Promise<void>((resolveExit) => {
				if (isolated.child.exitCode !== null || isolated.child.signalCode !== null) resolveExit();
				isolated.child.once("exit", () => resolveExit());
			});
			return {
				stdin: isolated.child.stdin,
				stdout: isolated.child.stdout,
				stderr: isolated.child.stderr,
				exited,
				async close() {
					isolated.child.stdin.end();
					await isolated.close();
					await rm(scratchRoot, { recursive: true, force: true });
				},
			};
		} catch (error) {
			await rm(scratchRoot, { recursive: true, force: true });
			throw error;
		}
	}
}
