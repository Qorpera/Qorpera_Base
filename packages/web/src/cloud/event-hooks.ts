import type { Cloud } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

/**
 * Member surface for the company's event hooks: webhooks other services post
 * to, and the company's mailboxes (a mailbox is a hook proven by mail). What
 * arrives wakes the company's routines that start on it.
 *
 * Every member lists them. Only owners and admins get a webhook's address
 * (for an address-proven hook, knowing it is the proof) and may create, pause,
 * resume or remove one; the kernel refuses anyone else. A mailbox's email
 * address is public by nature, so every member sees it. RPCs listed in
 * supabase/CLIENT-CONTRACT.md §2, "Event hooks" and "Company mailboxes".
 */

export type EventHookStatus = "active" | "paused";

export interface EventHook {
	id: string;
	name: string;
	purpose: string;
	/** How a delivery proves itself: "address", "stripe", "github", "hmac-sha256", or "mail" for a mailbox. */
	proof: string;
	status: EventHookStatus;
	/** The URL senders post to: owners and admins only, and never a mailbox's. */
	url?: string;
	/** A mailbox's email address. */
	email?: string;
	/** A signed hook's: whether its sender's signing secret is in the vault. */
	signingSecretReady?: boolean;
	/** A Stripe hook's: the last event refused under the secret the vault read off Stripe's page, and why. */
	lastRefusal?: { receivedAt: string; reason: string };
	createdAt: string;
	lastReceivedAt?: string;
}

/** A webhook's path under the Supabase URL; the last part is the hook's 43-character address. */
const HOOK_PATH = /^\/functions\/v1\/event-intake\/[A-Za-z0-9_-]{43}$/;

export function parseEventHook(value: unknown, projectUrl: string): EventHook {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hook.");
	const input = value as Record<string, unknown>;
	if (
		input.schema !== "qorpera.event-hook/v1" ||
		typeof input.id !== "string" ||
		!UUID_PATTERN.test(input.id) ||
		typeof input.name !== "string" ||
		!input.name ||
		typeof input.proof !== "string" ||
		!input.proof ||
		(input.status !== "active" && input.status !== "paused")
	)
		throw new Error("Invalid hook.");
	const signing =
		input.signingSecret && typeof input.signingSecret === "object"
			? (input.signingSecret as Record<string, unknown>)
			: undefined;
	const refusal =
		signing?.lastRefusal && typeof signing.lastRefusal === "object"
			? (signing.lastRefusal as Record<string, unknown>)
			: undefined;
	return {
		id: input.id,
		name: input.name,
		purpose: typeof input.purpose === "string" ? input.purpose : "",
		proof: input.proof,
		status: input.status,
		...(input.proof !== "mail" && typeof input.path === "string" && HOOK_PATH.test(input.path)
			? { url: new URL(input.path, projectUrl).href }
			: {}),
		...(input.proof === "mail" && typeof input.email === "string" && input.email.includes("@")
			? { email: input.email }
			: {}),
		...(signing ? { signingSecretReady: signing.ready === true } : {}),
		...(typeof refusal?.receivedAt === "string" && typeof refusal.reason === "string" && refusal.reason
			? { lastRefusal: { receivedAt: refusal.receivedAt, reason: refusal.reason } }
			: {}),
		createdAt: typeof input.createdAt === "string" ? input.createdAt : "",
		...(typeof input.lastReceivedAt === "string" ? { lastReceivedAt: input.lastReceivedAt } : {}),
	};
}

export interface WebEventHooks {
	/** The company's live hooks and mailboxes, by name. */
	list(signal?: AbortSignal): Promise<EventHook[]>;
	/** Creates an address-proven webhook; resolves to it with its URL. */
	createHook(name: string, purpose: string, signal?: AbortSignal): Promise<EventHook>;
	/** Creates a mailbox at the company's mail domain; resolves to it with its email address. */
	createMailbox(localPart: string, purpose: string, signal?: AbortSignal): Promise<EventHook>;
	/** Pauses, resumes or removes a hook or a mailbox. Removing is final and frees its name. */
	setStatus(hookId: string, status: EventHookStatus | "removed", signal?: AbortSignal): Promise<void>;
}

export function createWebEventHooks(
	cloud: Cloud,
	profile: { profileId: string; environmentId: string },
): WebEventHooks {
	if (!UUID_PATTERN.test(profile.profileId) || !UUID_PATTERN.test(profile.environmentId))
		throw new Error("Invalid company for hooks.");
	const parse = (value: unknown) => parseEventHook(value, cloud.config.projectUrl);
	return {
		async list(signal) {
			signal?.throwIfAborted();
			const value = await cloud.rpc("qorpera_list_event_hooks", {
				p_profile_id: profile.profileId,
				p_environment_id: profile.environmentId,
			});
			if (!Array.isArray(value)) throw new Error("Invalid hooks.");
			return value.map(parse);
		},
		async createHook(name, purpose, signal) {
			signal?.throwIfAborted();
			return parse(
				await cloud.rpc("qorpera_create_event_hook", {
					p_profile_id: profile.profileId,
					p_environment_id: profile.environmentId,
					p_name: name,
					p_purpose: purpose,
					// Settings makes address-proven hooks only: a signed hook needs its
					// sender's signing secret in the vault, and members never paste one.
					p_proof: "address",
				}),
			);
		},
		async createMailbox(localPart, purpose, signal) {
			signal?.throwIfAborted();
			return parse(
				await cloud.rpc("qorpera_create_company_mailbox", {
					p_profile_id: profile.profileId,
					p_environment_id: profile.environmentId,
					p_local_part: localPart,
					p_purpose: purpose,
				}),
			);
		},
		async setStatus(hookId, status, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(hookId)) throw new Error("Invalid hook.");
			await cloud.rpc("qorpera_set_event_hook_status", { p_hook_id: hookId, p_status: status });
		},
	};
}
