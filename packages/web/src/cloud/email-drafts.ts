import { type Cloud, CloudRpcError } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export type EmailDraftAction = "save" | "send" | "discard";
export interface EmailDraftContent {
	to: string[];
	cc: string[];
	subject: string;
	body: string;
}
export interface EmailDraftState {
	from: string;
	content: EmailDraftContent;
	status: "ready" | "saved" | "sending" | "sent" | "discarded" | "unconfirmed";
	draftId?: string;
	messageId?: string;
	error?: string;
	notificationPending?: boolean;
	actionId?: string;
}
/** Local editor state survives thread polling and navigation, including incomplete addresses. */
export interface EmailDraftEditor {
	/** Keep the member's receipt expanded through conversation refreshes. */
	receiptExpanded?: boolean;
	fields?: { to: string; cc: string; subject: string; body: string };
	state?: EmailDraftState;
	content?: EmailDraftContent;
	pending?: Promise<void>;
	busy?: "load" | EmailDraftAction;
	error?: string;
	loaded?: boolean;
	/** A lost response must be recovered before another action or edit is offered. */
	unconfirmedAction?: EmailDraftAction;
	/** The last acknowledged receipt, used to recognize a click that was never admitted. */
	recoveryBase?: { actionId?: string; content: EmailDraftContent };
}

interface DraftReceipt extends EmailDraftState {
	companyId: string;
	actionId?: string;
	brokerOrigin?: string;
	phase?: string;
}
interface PendingAction {
	clientActionId: string;
	capability: string;
	action: EmailDraftAction;
	content: EmailDraftContent;
	sponsor?: { sponsorBindingId: string; sponsorVersion: number };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function content(value: unknown): EmailDraftContent {
	const input = record(value);
	const addresses = (value: unknown): value is string[] =>
		Array.isArray(value) &&
		value.length <= 20 &&
		value.every((address) => typeof address === "string" && address.length <= 320);
	if (
		!addresses(input.to) ||
		!addresses(input.cc) ||
		typeof input.subject !== "string" ||
		typeof input.body !== "string"
	)
		throw new Error("The email draft response is invalid.");
	return { to: [...input.to], cc: [...input.cc], subject: input.subject, body: input.body };
}

export function parseEmailDraftState(value: unknown): DraftReceipt {
	const input = record(value);
	if (
		input.schema !== "qorpera.email-draft-state/v1" ||
		typeof input.from !== "string" ||
		typeof input.companyId !== "string" ||
		!UUID_PATTERN.test(input.companyId) ||
		typeof input.status !== "string" ||
		!["ready", "saved", "sending", "sent", "discarded", "unconfirmed"].includes(input.status)
	)
		throw new Error("The email draft response is invalid.");
	const result: DraftReceipt = {
		from: input.from,
		content: content(input.content),
		status: input.status as EmailDraftState["status"],
		companyId: input.companyId,
	};
	if (typeof input.notificationPending === "boolean") result.notificationPending = input.notificationPending;
	for (const key of ["draftId", "messageId", "error", "phase"] as const)
		if (typeof input[key] === "string") result[key] = input[key];
	if (input.actionId != null) {
		if (typeof input.actionId !== "string" || !UUID_PATTERN.test(input.actionId))
			throw new Error("The email action is invalid.");
		result.actionId = input.actionId;
	}
	if (input.brokerOrigin != null) {
		const origin = new URL(String(input.brokerOrigin));
		if (
			origin.protocol !== "https:" ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		)
			throw new Error("The email service is not set up for this company.");
		result.brokerOrigin = origin.origin;
	}
	return result;
}

/** A member click, bound to one durable operation. A reload reuses its capability and
 * request id; an ambiguous delivery never becomes a fresh send. No provider token
 * reaches the browser. The short-lived capability is scoped to this one action. */
export class EmailDraftClient {
	readonly #cloud: Cloud;
	readonly #scope: string;
	readonly #signal: AbortSignal;
	readonly #pending = new Map<string, PendingAction>();
	readonly #running = new Map<string, Promise<EmailDraftState>>();
	constructor(cloud: Cloud, userId: string, signal: AbortSignal) {
		this.#cloud = cloud;
		this.#scope = `${cloud.config.projectUrl}:${userId}`;
		this.#signal = signal;
	}
	#key(sessionId: string, interactionId: string): string {
		if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(interactionId)) throw new Error("Invalid email draft.");
		return `qorpera.email-action/v1:${this.#scope}:${sessionId}:${interactionId}`;
	}
	#remember(key: string, pending?: PendingAction): void {
		if (pending) this.#pending.set(key, pending);
		else this.#pending.delete(key);
		try {
			if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
			else sessionStorage.removeItem(key);
		} catch {
			/* In private storage modes, the current tab still retains the exact request. */
		}
	}
	#restore(key: string): PendingAction | undefined {
		const memory = this.#pending.get(key);
		if (memory) return memory;
		try {
			const input = record(JSON.parse(sessionStorage.getItem(key) ?? "null"));
			if (
				typeof input.clientActionId !== "string" ||
				!UUID_PATTERN.test(input.clientActionId) ||
				typeof input.capability !== "string" ||
				!/^[A-Za-z0-9_-]{43}$/.test(input.capability) ||
				!["save", "send", "discard"].includes(String(input.action))
			)
				return undefined;
			const sponsor = record(input.sponsor);
			return {
				clientActionId: input.clientActionId,
				capability: input.capability,
				action: input.action as EmailDraftAction,
				content: content(input.content),
				...(typeof sponsor.sponsorBindingId === "string" &&
				UUID_PATTERN.test(sponsor.sponsorBindingId) &&
				Number.isSafeInteger(sponsor.sponsorVersion)
					? {
							sponsor: {
								sponsorBindingId: sponsor.sponsorBindingId,
								sponsorVersion: sponsor.sponsorVersion as number,
							},
						}
					: {}),
			};
		} catch {
			return undefined;
		}
	}
	async read(sessionId: string, interactionId: string): Promise<EmailDraftState> {
		this.#signal.throwIfAborted();
		const key = this.#key(sessionId, interactionId);
		const state = parseEmailDraftState(
			await this.#cloud.rpc("qorpera_get_email_draft", { p_session_id: sessionId, p_interaction_id: interactionId }),
		);
		if (["sent", "discarded"].includes(state.status)) {
			this.#remember(key);
			return state;
		}
		const pending = this.#restore(key);
		if (pending && state.actionId && state.actionId !== pending.clientActionId) {
			this.#remember(key);
			return state;
		}
		return pending ? this.#execute(key, sessionId, interactionId, pending) : state;
	}
	async act(
		sessionId: string,
		interactionId: string,
		action: EmailDraftAction,
		edited: EmailDraftContent,
		sponsor?: PendingAction["sponsor"],
	): Promise<EmailDraftState> {
		this.#signal.throwIfAborted();
		const key = this.#key(sessionId, interactionId);
		const existing = this.#restore(key);
		if (
			existing &&
			(existing.action !== action || JSON.stringify(content(existing.content)) !== JSON.stringify(content(edited)))
		)
			throw new Error("Refresh to confirm the previous email action before making changes.");
		const pending = existing ?? {
			clientActionId: crypto.randomUUID(),
			capability: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, ""),
			action,
			content: structuredClone(edited),
			sponsor,
		};
		this.#remember(key, pending);
		return this.#execute(key, sessionId, interactionId, pending);
	}
	#execute(key: string, sessionId: string, interactionId: string, pending: PendingAction): Promise<EmailDraftState> {
		const running = this.#running.get(key);
		if (running) return running;
		const run = this.#perform(key, sessionId, interactionId, pending).finally(() => this.#running.delete(key));
		this.#running.set(key, run);
		return run;
	}
	async #perform(
		key: string,
		sessionId: string,
		interactionId: string,
		pending: PendingAction,
	): Promise<EmailDraftState> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.capability));
		const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		let ticket: DraftReceipt;
		try {
			ticket = parseEmailDraftState(
				await this.#cloud.rpc("qorpera_prepare_email_draft_action", {
					p_session_id: sessionId,
					p_interaction_id: interactionId,
					p_client_action_id: pending.clientActionId,
					p_action: pending.action,
					p_content: pending.content,
					p_capability_sha256: hash,
					...(pending.sponsor
						? {
								p_sponsor_binding_id: pending.sponsor.sponsorBindingId,
								p_sponsor_version: pending.sponsor.sponsorVersion,
							}
						: {}),
				}),
			);
		} catch (error) {
			// A definite validation/authority refusal did not admit this click. Network
			// and malformed responses retain the request because admission is unknown.
			if (error instanceof CloudRpcError && (error.denied || ["22023", "P0002"].includes(error.code ?? "")))
				this.#remember(key);
			throw error;
		}
		if (ticket.actionId !== pending.clientActionId) throw new Error("The email action response is invalid.");
		if (["sent", "discarded"].includes(ticket.status) || ticket.phase === "failed" || ticket.phase === "succeeded") {
			this.#remember(key);
			return ticket;
		}
		if (!ticket.actionId || !ticket.brokerOrigin)
			throw new Error("The email action could not be confirmed. Check its status before trying again.");
		this.#signal.throwIfAborted();
		const response = await fetch(
			`${ticket.brokerOrigin}/v1/email-drafts/${ticket.actionId}?company=${ticket.companyId}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schema: "qorpera.email-draft-action/v1", capability: pending.capability }),
				redirect: "error",
				credentials: "omit",
				signal: this.#signal,
			},
		);
		if (!response.ok)
			throw new Error("The email action could not be confirmed. Check its status before trying again.");
		const result = parseEmailDraftState(await response.json());
		if (result.companyId !== ticket.companyId || result.actionId !== ticket.actionId)
			throw new Error("The email action response is invalid.");
		if (["ready", "saved", "sent", "discarded"].includes(result.status)) this.#remember(key);
		return result;
	}
}
