import { CloudRpcError, describeError } from "../cloud/client.ts";
import { MAIL_HANDLE, type MailHandleStatus, type MailHandles } from "../cloud/event-hooks.ts";
import { phrase, t } from "./preferences.ts";

export interface MailAddressCalls {
	readonly canChoose: boolean;
	readonly handles: (signal: AbortSignal) => Promise<MailHandles>;
	readonly status: (handle: string, signal: AbortSignal) => Promise<MailHandleStatus>;
	readonly choose: (handle: string) => Promise<string>;
}

export const HANDLE_MAX_CHARACTERS = 24;

export const HANDLE_CHECK_DELAY_MS = 250;

export function cleanHandle(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "")
		.slice(0, HANDLE_MAX_CHARACTERS);
}

export type HandleState = MailHandleStatus | "reserved" | "checking" | "unknown";

const HANDLE_WORDS: Record<MailHandleStatus | "reserved" | "checking", string> = {
	free: phrase("Free"),
	ours: phrase("Already yours"),
	taken: phrase("That one belongs to another company"),
	invalid: phrase("Use a–z, 0–9 and hyphens"),
	reserved: phrase("This mailbox name is reserved. Choose another."),
	checking: phrase("Checking…"),
};

export function handleWords(state: HandleState): string {
	return state === "unknown" ? "" : t(HANDLE_WORDS[state]);
}

export function handleUsable(state: HandleState): boolean {
	return state === "free" || state === "ours" || state === "unknown";
}

export class HandleCheck {
	readonly #status: (handle: string, signal: AbortSignal) => Promise<MailHandleStatus>;
	readonly #changed: () => void;
	#handle: string | undefined;
	#state: HandleState = "unknown";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#abort: AbortController | undefined;

	constructor(status: (handle: string, signal: AbortSignal) => Promise<MailHandleStatus>, changed: () => void) {
		this.#status = status;
		this.#changed = changed;
	}

	get state(): HandleState {
		return this.#state;
	}

	set(handle: string): void {
		if (handle === this.#handle) return;
		this.#handle = handle;
		this.stop();
		if (!MAIL_HANDLE.test(handle)) {
			this.#show("invalid");
			return;
		}
		this.#show("checking");
		const abort = new AbortController();
		this.#abort = abort;
		this.#timer = setTimeout(() => {
			this.#status(handle, abort.signal).then(
				(status) => {
					if (!abort.signal.aborted) this.#show(status === "invalid" ? "reserved" : status);
				},
				() => {
					if (!abort.signal.aborted) this.#show("unknown");
				},
			);
		}, HANDLE_CHECK_DELAY_MS);
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#abort?.abort();
		this.#abort = undefined;
	}

	#show(state: HandleState): void {
		this.#state = state;
		this.#changed();
	}
}

export function mailboxRefusal(error: unknown): string {
	const code = error instanceof CloudRpcError ? error.code : undefined;
	const message = error instanceof Error ? error.message : "";
	if (code === "23505") return t("This address is taken.");
	if (code === "54000") return t("The company has as many webhooks and mailboxes as it can have. Remove one first.");
	if (code === "0A000") return t("Company mail is not set up yet.");
	if (code === "22023" && message.includes("reserved")) return t("This mailbox name is reserved. Choose another.");
	if (code === "22023" && message.includes("handle"))
		return t("A new address is the company's handle or a name, a dot and the handle, like acme or sales.acme.");
	if (code === "42501") return t("Only founders and admins can choose the address");
	return describeError(error);
}
