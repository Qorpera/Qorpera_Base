import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { NativeHarnessDriver } from "./cloud-native-provider-host.ts";

/**
 * A member's Codex sign-in, run by the vault's login helper (Stateless Compute step 1,
 * change 2B). The helper runs the official `codex login --device-auth` in a private home,
 * with the same driver a node uses, and keeps the sign-in until the member has finished in
 * the browser. The finished login is handed to the broker once, then wiped.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_AUTH_JSON_BYTES = 32 * 1024;
/** Codex's device code lasts 15 minutes; a sign-in never runs longer. */
const MAX_SIGN_IN_MS = 15 * 60_000;
/** A finished or failed sign-in waits this long for the broker to read it, then is wiped. */
const SETTLED_KEEP_MS = 2 * 60_000;

export type ModelLoginSignInState =
	| { readonly status: "preparing" }
	| { readonly status: "awaiting_member"; readonly interactionUrl?: string; readonly userCode?: string }
	| {
			readonly status: "completed";
			readonly authJson: string;
			readonly providerAccountReference?: string;
			readonly providerAccountEmail?: string;
	  }
	| { readonly status: "failed"; readonly reason: string };

/** The helper's side of a member's sign-in, as the broker sees it. */
export interface ModelLoginSignInHelper {
	/** Starts the sign-in, or answers its state when it runs already. */
	beginSignIn(request: { signInId: string; expiresAt: string }, signal: AbortSignal): Promise<ModelLoginSignInState>;
	/** Ends the sign-in and wipes its home (the broker has saved the login, or given up). */
	finishSignIn(signInId: string, signal: AbortSignal): Promise<void>;
}

interface Entry {
	root: string;
	state: ModelLoginSignInState;
	cancel?: () => Promise<void>;
	timer: ReturnType<typeof setTimeout>;
	changed: Promise<void>;
	notify: () => void;
}

export class CodexSignIns implements ModelLoginSignInHelper {
	readonly #driver: Pick<NativeHarnessDriver, "beginLogin">;
	readonly #temporaryRoot: string;
	readonly #beforeLaunch: (() => Promise<void>) | undefined;
	readonly #limit: number;
	readonly #promptWaitMs: number;
	readonly #entries = new Map<string, Entry>();

	constructor(options: {
		driver: Pick<NativeHarnessDriver, "beginLogin">;
		temporaryRoot: string;
		/** Checked before every launch (the helper re-checks its pinned binary). */
		beforeLaunch?: () => Promise<void>;
		limit?: number;
		promptWaitMs?: number;
	}) {
		if (!isAbsolute(options.temporaryRoot) || resolve(options.temporaryRoot) !== options.temporaryRoot)
			throw new Error("Sign-in temporary root must be absolute");
		this.#driver = options.driver;
		this.#temporaryRoot = options.temporaryRoot;
		this.#beforeLaunch = options.beforeLaunch;
		this.#limit = options.limit ?? 8;
		this.#promptWaitMs = options.promptWaitMs ?? 15_000;
	}

	async beginSignIn(
		request: { signInId: string; expiresAt: string },
		signal: AbortSignal,
	): Promise<ModelLoginSignInState> {
		if (!UUID.test(request.signInId)) throw new Error("Sign-in id is invalid");
		const expiresAt = Date.parse(request.expiresAt);
		if (!Number.isFinite(expiresAt)) throw new Error("Sign-in expiry is invalid");
		let entry = this.#entries.get(request.signInId);
		if (!entry) {
			const lifetime = Math.min(expiresAt - Date.now(), MAX_SIGN_IN_MS);
			if (lifetime <= 0) return { status: "failed", reason: "sign_in_expired" };
			if (this.#entries.size >= this.#limit) return { status: "preparing" };
			entry = await this.#start(request.signInId, lifetime);
		}
		if (entry.state.status !== "preparing") return entry.state;
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

	async finishSignIn(signInId: string, _signal: AbortSignal): Promise<void> {
		if (!UUID.test(signInId)) throw new Error("Sign-in id is invalid");
		await this.#end(signInId);
	}

	/** Ends every sign-in (the helper is stopping). */
	async close(): Promise<void> {
		await Promise.all([...this.#entries.keys()].map((id) => this.#end(id)));
	}

	async #start(signInId: string, lifetime: number): Promise<Entry> {
		const root = await mkdtemp(join(this.#temporaryRoot, "qorpera-sign-in-"));
		let notify = (): void => undefined;
		const entry: Entry = {
			root,
			state: { status: "preparing" },
			timer: setTimeout(() => void this.#end(signInId), lifetime),
			changed: new Promise<void>((resolveChange) => {
				notify = resolveChange;
			}),
			notify: () => notify(),
		};
		this.#entries.set(signInId, entry);
		const settle = (state: ModelLoginSignInState): void => {
			if (this.#entries.get(signInId) !== entry) return;
			entry.state = state;
			entry.notify();
			entry.changed = new Promise<void>((resolveChange) => {
				notify = resolveChange;
			});
			if (state.status === "completed" || state.status === "failed") {
				clearTimeout(entry.timer);
				entry.timer = setTimeout(() => void this.#end(signInId), SETTLED_KEEP_MS);
				// The login now lives in memory only: Codex has stopped and its home can go.
				void rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
			}
		};
		try {
			await this.#beforeLaunch?.();
			const handle = await this.#driver.beginLogin("codex-cli", root, AbortSignal.timeout(lifetime));
			entry.cancel = () => handle.cancel();
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
						authJson = await readFile(join(root, "codex", "auth.json"), "utf8");
					} catch {
						settle({ status: "failed", reason: "sign_in_no_login" });
						return;
					}
					if (Buffer.byteLength(authJson) > MAX_AUTH_JSON_BYTES) {
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
			settle({ status: "failed", reason: "codex_launch_failed" });
		}
		return entry;
	}

	async #end(signInId: string): Promise<void> {
		const entry = this.#entries.get(signInId);
		if (!entry) return;
		this.#entries.delete(signInId);
		clearTimeout(entry.timer);
		entry.notify();
		await entry.cancel?.().catch(() => undefined);
		await rm(entry.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	}
}
