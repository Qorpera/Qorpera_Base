import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { NativeHarnessDriver } from "./cloud-native-provider-host.ts";

/**
 * A member's Codex sign-in, run by the vault's login helper (Stateless Compute step 1,
 * change 2B). The helper runs the official `codex login --device-auth` in a private home,
 * with the same driver a node uses, and keeps the sign-in while the member finishes in the
 * browser. The web client stops asking once it shows the link and code, so the broker
 * collects finished sign-ins itself (`listCompletedSignIns`, then `readSignIn`) and ends each
 * one (`finishSignIn`); nothing is kept after that.
 *
 * One helper serves every company broker on its host. A sign-in is bound to its company, its
 * Compute Identity and its capability digest; a newer sign-in of the same identity ends the
 * older one, and each company may run only a few at once.
 *
 * A Claude sign-in (20260930564000) runs the official, unmodified Claude Code (`claude auth login
 * --claudeai`) the same way. It shows Anthropic's sign-in page and then waits for the code Anthropic
 * gives the member, which the member pastes into Qorpera's page: `submitCode` writes it once to
 * Claude Code's input. Claude Code exchanges it itself; its login files are kept as they are, unread
 * (`CLAUDE_LOGIN_FILES`), for the vault to seal.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_AUTH_JSON_BYTES = 32 * 1024;
/** Claude Code's login files in its config directory: its credentials, and its account settings (which name the
 * signed-in account). Kept as bytes, never parsed. */
export const CLAUDE_LOGIN_FILES = [".credentials.json", ".claude.json"] as const;
export const CLAUDE_LOGIN_FILES_SCHEMA = "qorpera.claude-login-files/v1";
const MAX_CLAUDE_FILE_BYTES = 16 * 1024;
/** Both Claude files in base64, well inside a sealed login's 128 KiB. */
const MAX_CLAUDE_FILES_BYTES = 64 * 1024;
/** After its code, Claude Code exchanges it with Anthropic and reads the account; the answer waits this long. */
const CODE_WAIT_MS = 25_000;
/** Codex's device code lasts 15 minutes; a sign-in never runs longer. */
const MAX_SIGN_IN_MS = 15 * 60_000;
/** A finished or failed sign-in waits this long for its broker (which may be restarting). */
const SETTLED_KEEP_MS = 5 * 60_000;
/** An ended sign-in is not started again for this long (a late poll racing its completion). */
const ENDED_MEMORY_MS = MAX_SIGN_IN_MS;

export type ModelLoginSignInState =
	| { readonly status: "preparing" }
	| { readonly status: "awaiting_member"; readonly interactionUrl?: string; readonly userCode?: string }
	| {
			readonly status: "completed";
			/** Codex's auth.json, or for a Claude sign-in its login files (`qorpera.claude-login-files/v1`). */
			readonly authJson: string;
			readonly providerAccountReference?: string;
			readonly providerAccountEmail?: string;
	  }
	| { readonly status: "failed"; readonly reason: string };

export interface ModelLoginSignInBinding {
	readonly signInId: string;
	readonly companyId: string;
	readonly computeIdentityId: string;
	readonly capabilitySha256: string;
	readonly expiresAt: string;
	/** A Claude sign-in; absent for Codex. */
	readonly harness?: "claude-code";
}

/** The helper's side of members' sign-ins, as a broker sees it. */
export interface ModelLoginSignInHelper {
	/** Starts the sign-in, or answers its state when it runs already. */
	beginSignIn(binding: ModelLoginSignInBinding, signal: AbortSignal): Promise<ModelLoginSignInState>;
	/** The sign-in's state, without starting anything; `unknown` when the helper has none. */
	readSignIn(
		request: { signInId: string; companyId: string },
		signal: AbortSignal,
	): Promise<ModelLoginSignInState | { readonly status: "unknown" }>;
	/** The company's finished sign-ins waiting for their broker. */
	listCompletedSignIns(
		request: { companyId: string },
		signal: AbortSignal,
	): Promise<ReadonlyArray<{ signInId: string; capabilitySha256: string }>>;
	/** Ends the sign-in and wipes it (saved, refused, or no longer pending). */
	finishSignIn(request: { signInId: string; companyId: string }, signal: AbortSignal): Promise<void>;
	/** A Claude sign-in: Anthropic's code, given once; the state once Claude Code has used it (or still waiting). */
	submitCode?(
		request: { signInId: string; companyId: string; code: string },
		signal: AbortSignal,
	): Promise<ModelLoginSignInState | { readonly status: "unknown" }>;
}

interface Entry {
	binding: ModelLoginSignInBinding;
	root?: string;
	state: ModelLoginSignInState;
	cancel?: () => Promise<void>;
	submitCode?: (code: string) => void;
	timer: ReturnType<typeof setTimeout>;
	changed: Promise<void>;
	notify: () => void;
	ended: boolean;
}

function checkBinding(binding: ModelLoginSignInBinding): number {
	if (
		!UUID.test(binding.signInId) ||
		!UUID.test(binding.companyId) ||
		!UUID.test(binding.computeIdentityId) ||
		!SHA256.test(binding.capabilitySha256) ||
		(binding.harness !== undefined && binding.harness !== "claude-code")
	)
		throw new Error("Sign-in binding is invalid");
	const expiresAt = Date.parse(binding.expiresAt);
	if (!Number.isFinite(expiresAt)) throw new Error("Sign-in expiry is invalid");
	return expiresAt;
}

const settled = (state: ModelLoginSignInState): boolean => state.status === "completed" || state.status === "failed";

/** One of Claude Code's login files, as bytes: a regular file, never through a link (O_NOFOLLOW), read from the
 * handle it was checked on. */
async function claudeLoginFile(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_CLAUDE_FILE_BYTES) throw new Error("Claude login file is unsafe");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

/** Claude Code's login files, as bytes: its credentials (required) and its account settings (when it wrote them). */
async function claudeLoginFiles(configDirectory: string): Promise<string> {
	const files: Record<string, string> = {};
	for (const name of CLAUDE_LOGIN_FILES) {
		let bytes: Buffer;
		try {
			bytes = await claudeLoginFile(join(configDirectory, name));
		} catch (error) {
			if (name !== ".credentials.json" && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
			throw error;
		}
		try {
			if (bytes.byteLength < 2 || bytes.byteLength > MAX_CLAUDE_FILE_BYTES)
				throw new Error("Claude login file size");
			files[name] = bytes.toString("base64");
		} finally {
			bytes.fill(0);
		}
	}
	return JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files });
}

export class CodexSignIns implements ModelLoginSignInHelper {
	readonly #driver: Pick<NativeHarnessDriver, "beginLogin">;
	readonly #claude: boolean;
	readonly #temporaryRoot: string;
	readonly #limit: number;
	readonly #companyLimit: number;
	readonly #promptWaitMs: number;
	readonly #entries = new Map<string, Entry>();
	/** Sign-ins ended recently, with the time until which they stay ended. */
	readonly #ended = new Map<string, number>();

	constructor(options: {
		driver: Pick<NativeHarnessDriver, "beginLogin">;
		temporaryRoot: string;
		/** Sign-ins running at once on this helper, and per company. */
		limit?: number;
		companyLimit?: number;
		promptWaitMs?: number;
		/** The driver runs the pinned official Claude Code too; without it a Claude sign-in fails. */
		claude?: boolean;
	}) {
		if (!isAbsolute(options.temporaryRoot) || resolve(options.temporaryRoot) !== options.temporaryRoot)
			throw new Error("Sign-in temporary root must be absolute");
		this.#driver = options.driver;
		this.#claude = options.claude ?? false;
		this.#temporaryRoot = options.temporaryRoot;
		this.#limit = options.limit ?? 6;
		this.#companyLimit = options.companyLimit ?? 2;
		this.#promptWaitMs = options.promptWaitMs ?? 12_000;
	}

	async beginSignIn(binding: ModelLoginSignInBinding, signal: AbortSignal): Promise<ModelLoginSignInState> {
		const expiresAt = checkBinding(binding);
		let entry = this.#entries.get(binding.signInId);
		if (
			entry &&
			(entry.binding.companyId !== binding.companyId ||
				entry.binding.computeIdentityId !== binding.computeIdentityId ||
				entry.binding.capabilitySha256 !== binding.capabilitySha256 ||
				entry.binding.harness !== binding.harness)
		)
			throw new Error("Sign-in belongs to another company or capability");
		if (!entry) {
			const lifetime = Math.min(expiresAt - Date.now(), MAX_SIGN_IN_MS);
			if (lifetime <= 0) return { status: "failed", reason: "sign_in_expired" };
			for (const [id, until] of this.#ended) if (until <= Date.now()) this.#ended.delete(id);
			// Ended moments ago (its broker completed it): the caller's next look finds it complete.
			if (this.#ended.has(binding.signInId)) return { status: "preparing" };
			// A newer sign-in of the same identity replaces the older one (a member who retried).
			for (const [id, other] of this.#entries)
				if (
					other.binding.companyId === binding.companyId &&
					other.binding.computeIdentityId === binding.computeIdentityId &&
					!settled(other.state)
				)
					await this.#end(id);
			const running = [...this.#entries.values()].filter((other) => !settled(other.state));
			if (
				running.length >= this.#limit ||
				running.filter((other) => other.binding.companyId === binding.companyId).length >= this.#companyLimit
			)
				return { status: "preparing" };
			entry = this.#start(binding, lifetime);
		}
		if (entry.state.status !== "preparing" || signal.aborted) return entry.state;
		// Codex prints the link and code within seconds; the broker's caller asks again soon.
		await Promise.race([
			entry.changed,
			new Promise<void>((resolveWait) => {
				const timer = setTimeout(resolveWait, this.#promptWaitMs);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolveWait();
					},
					{ once: true },
				);
			}),
		]);
		return entry.state;
	}

	async readSignIn(
		request: { signInId: string; companyId: string },
		_signal: AbortSignal,
	): Promise<ModelLoginSignInState | { readonly status: "unknown" }> {
		const entry = this.#entries.get(request.signInId);
		if (!entry || entry.binding.companyId !== request.companyId) return { status: "unknown" };
		return entry.state;
	}

	async listCompletedSignIns(
		request: { companyId: string },
		_signal: AbortSignal,
	): Promise<ReadonlyArray<{ signInId: string; capabilitySha256: string }>> {
		return [...this.#entries.values()]
			.filter((entry) => entry.binding.companyId === request.companyId && entry.state.status === "completed")
			.map((entry) => ({ signInId: entry.binding.signInId, capabilitySha256: entry.binding.capabilitySha256 }));
	}

	async finishSignIn(request: { signInId: string; companyId: string }, _signal: AbortSignal): Promise<void> {
		const entry = this.#entries.get(request.signInId);
		if (!entry || entry.binding.companyId !== request.companyId) return;
		await this.#end(request.signInId);
	}

	async submitCode(
		request: { signInId: string; companyId: string; code: string },
		signal: AbortSignal,
	): Promise<ModelLoginSignInState | { readonly status: "unknown" }> {
		const entry = this.#entries.get(request.signInId);
		if (!entry || entry.binding.companyId !== request.companyId) return { status: "unknown" };
		if (entry.binding.harness !== "claude-code" || entry.state.status !== "awaiting_member" || !entry.submitCode)
			throw new Error("Sign-in takes no code now");
		const changed = entry.changed;
		entry.submitCode(request.code);
		entry.submitCode = undefined;
		await Promise.race([
			changed,
			new Promise<void>((resolveWait) => {
				const timer = setTimeout(resolveWait, CODE_WAIT_MS);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolveWait();
					},
					{ once: true },
				);
			}),
		]);
		return entry.state;
	}

	/** Ends every sign-in (the helper is stopping). */
	async close(): Promise<void> {
		await Promise.all([...this.#entries.keys()].map((id) => this.#end(id)));
	}

	/** Registers the entry at once (a second poll finds it), then starts Codex or Claude Code. */
	#start(binding: ModelLoginSignInBinding, lifetime: number): Entry {
		let notify = (): void => undefined;
		const entry: Entry = {
			binding,
			state: { status: "preparing" },
			timer: setTimeout(() => void this.#end(binding.signInId), lifetime),
			changed: new Promise<void>((resolveChange) => {
				notify = resolveChange;
			}),
			notify: () => notify(),
			ended: false,
		};
		this.#entries.set(binding.signInId, entry);
		const settle = (state: ModelLoginSignInState): void => {
			if (entry.ended || this.#entries.get(binding.signInId) !== entry) return;
			entry.state = state;
			entry.notify();
			entry.changed = new Promise<void>((resolveChange) => {
				notify = resolveChange;
			});
			if (settled(state)) {
				clearTimeout(entry.timer);
				entry.timer = setTimeout(() => void this.#end(binding.signInId), SETTLED_KEEP_MS);
				// Codex has stopped: the login now lives in memory only, and its home can go.
				if (entry.root) void rm(entry.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
			}
		};
		void (async () => {
			try {
				const root = await mkdtemp(join(this.#temporaryRoot, "qorpera-sign-in-"));
				entry.root = root;
				if (entry.ended) {
					await rm(root, { recursive: true, force: true });
					return;
				}
				const claude = binding.harness === "claude-code";
				if (claude && !this.#claude) {
					settle({ status: "failed", reason: "claude_unavailable" });
					return;
				}
				const handle = await this.#driver.beginLogin(
					claude ? "claude-code" : "codex-cli",
					root,
					AbortSignal.timeout(lifetime),
				);
				entry.cancel = () => handle.cancel();
				if (claude) {
					if (!handle.submitCode) throw new Error("Claude Code takes no code");
					entry.submitCode = (code) => handle.submitCode?.(code);
				}
				if (entry.ended) {
					await handle.cancel().catch(() => undefined);
					return;
				}
				handle.prompt.then(
					(prompt) => {
						if (entry.state.status !== "preparing") return;
						if (!prompt.interactionUrl && !prompt.userCode) return;
						settle({
							status: "awaiting_member",
							...(prompt.interactionUrl ? { interactionUrl: prompt.interactionUrl } : {}),
							...(prompt.userCode ? { userCode: prompt.userCode } : {}),
						});
					},
					() => settle({ status: "failed", reason: "sign_in_no_prompt" }),
				);
				handle.completed.then(
					async (account) => {
						let authJson: string;
						try {
							authJson = claude
								? await claudeLoginFiles(join(root, "claude"))
								: await readFile(join(root, "codex", "auth.json"), "utf8");
						} catch {
							settle({ status: "failed", reason: "sign_in_no_login" });
							return;
						}
						if (Buffer.byteLength(authJson) > (claude ? MAX_CLAUDE_FILES_BYTES : MAX_AUTH_JSON_BYTES)) {
							settle({ status: "failed", reason: "sign_in_login_too_large" });
							return;
						}
						settle({
							status: "completed",
							authJson,
							...(account.providerAccountReference
								? { providerAccountReference: account.providerAccountReference }
								: {}),
							...(account.providerAccountEmail ? { providerAccountEmail: account.providerAccountEmail } : {}),
						});
					},
					() => settle({ status: "failed", reason: "sign_in_not_completed" }),
				);
			} catch {
				settle({
					status: "failed",
					reason: binding.harness === "claude-code" ? "claude_launch_failed" : "codex_launch_failed",
				});
			}
		})();
		return entry;
	}

	async #end(signInId: string): Promise<void> {
		const entry = this.#entries.get(signInId);
		if (!entry) return;
		this.#entries.delete(signInId);
		this.#ended.set(signInId, Date.now() + ENDED_MEMORY_MS);
		entry.ended = true;
		clearTimeout(entry.timer);
		entry.notify();
		await entry.cancel?.().catch(() => undefined);
		if (entry.root) await rm(entry.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	}
}
