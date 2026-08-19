import { randomUUID } from "node:crypto";
import type { QorperaHostedPrimary, SessionTurnInput } from "./hosted-primary.ts";

/**
 * Per-company client of the hosted session arbiter (migration 20260818007000,
 * contract in supabase/SESSIONS.md).
 *
 * The cloud owns the conversation: one open session per staff agent, adopted
 * or atomically created, and every turn — the kickoff included — is a queue
 * row that exactly one executor claims. This class holds the per-company
 * mapping from staff agents to their hosted sessions plus the single active
 * claim, and nothing else; timers, children, and dispatch stay in main.ts
 * where the runtime lifecycle already lives.
 *
 * Every method that talks to the cloud can reject. Callers degrade to
 * today's solo behaviour on failure — the arbiter makes multiplayer
 * coherent when the cloud is reachable, and must never make solo work
 * impossible when it is not.
 */

export interface ArbiterSessionRef {
	hostedSessionId: string;
	/** Trail identity: the local trail header id equals this by construction. */
	clientSessionId: string;
	staffAgentId: string;
	title: string;
	createdAt: string;
	/** True when this machine's ensure created the session (and its kickoff row). */
	created: boolean;
}

export interface ArbiterClaim {
	hostedSessionId: string;
	staffAgentId: string;
	inputs: SessionTurnInput[];
	claimedAt: number;
}

const RENEW_INTERVAL_MS = 45_000;
const TURN_LEASE_SECONDS = 180;

export class CloudSessionArbiter {
	readonly claimantId: string;
	readonly #primary: QorperaHostedPrimary;
	readonly #environmentId: string;
	readonly #byStaff = new Map<string, ArbiterSessionRef>();
	#activeClaim: ArbiterClaim | undefined;
	#lastRenewAt = 0;

	constructor(primary: QorperaHostedPrimary, environmentId: string, claimantId: string = randomUUID()) {
		this.#primary = primary;
		this.#environmentId = environmentId;
		this.claimantId = claimantId;
	}

	sessionForStaff(staffAgentId: string): ArbiterSessionRef | undefined {
		return this.#byStaff.get(staffAgentId);
	}

	get activeClaim(): ArbiterClaim | undefined {
		return this.#activeClaim;
	}

	/** Adopt the staff agent's open hosted session, or create it (which also
	 * enqueues the one kickoff row server-side). The preferred client session
	 * id is used only when this call ends up creating; adoption always takes
	 * the cloud's identity so the local trail file matches every other
	 * machine's. */
	async ensureSession(
		staffAgentId: string,
		title: string,
		preferredClientSessionId?: string,
	): Promise<ArbiterSessionRef> {
		const clientSessionId = preferredClientSessionId ?? randomUUID();
		const handle = await this.#primary.ensureStaffSession(this.#environmentId, staffAgentId, clientSessionId, title);
		let ref: ArbiterSessionRef;
		if (handle.created) {
			ref = {
				hostedSessionId: handle.sessionId,
				clientSessionId,
				staffAgentId,
				title: handle.title,
				createdAt: new Date().toISOString(),
				created: true,
			};
		} else {
			// The ensure result carries the hosted id; the trail identity other
			// machines share comes from the session listing.
			const hosted = (await this.#primary.listSessions(this.#environmentId)).find(
				(session) => session.sessionId === handle.sessionId,
			);
			if (!hosted) throw new Error("adopted staff session is not listable");
			ref = {
				hostedSessionId: hosted.sessionId,
				clientSessionId: hosted.clientSessionId,
				staffAgentId,
				title: hosted.title,
				createdAt: hosted.createdAt,
				created: false,
			};
		}
		this.#byStaff.set(staffAgentId, ref);
		return ref;
	}

	/** Enqueue a user message. Idempotent server-side by the minted input id. */
	async appendUserMessage(staffAgentId: string, text: string): Promise<void> {
		const ref = this.#requireSession(staffAgentId);
		await this.#primary.appendSessionInput(ref.hostedSessionId, randomUUID(), { text });
	}

	/** Try to become the executor for the staff agent's pending turn. Returns
	 * the claimed inputs (kickoff first when present), or undefined when the
	 * queue is empty or another executor's turn is in flight. */
	async claimTurn(staffAgentId: string): Promise<ArbiterClaim | undefined> {
		const ref = this.#requireSession(staffAgentId);
		if (this.#activeClaim) return undefined;
		const claim = await this.#primary.claimSessionTurn(ref.hostedSessionId, this.claimantId, TURN_LEASE_SECONDS);
		if (!claim.claimed) return undefined;
		this.#activeClaim = {
			hostedSessionId: ref.hostedSessionId,
			staffAgentId,
			inputs: claim.inputs,
			claimedAt: Date.now(),
		};
		this.#lastRenewAt = Date.now();
		return this.#activeClaim;
	}

	/** Keep the lease alive while the agent works. Throttled internally; safe
	 * to call from every activity frame. */
	async renewIfDue(): Promise<void> {
		const claim = this.#activeClaim;
		if (!claim) return;
		const now = Date.now();
		if (now - this.#lastRenewAt < RENEW_INTERVAL_MS) return;
		this.#lastRenewAt = now;
		await this.#primary.renewSessionTurn(claim.hostedSessionId, this.claimantId, TURN_LEASE_SECONDS);
	}

	/** The turn ran to completion: mark its inputs consumed. */
	async completeTurn(): Promise<void> {
		const claim = this.#activeClaim;
		if (!claim) return;
		this.#activeClaim = undefined;
		await this.#primary.completeSessionTurn(claim.hostedSessionId, this.claimantId);
	}

	/** The executor died or the turn failed before running: never mark the
	 * inputs consumed — drop the local claim and let the lease expire so
	 * another machine (or this one, later) takes the turn over. */
	abandonClaim(): void {
		this.#activeClaim = undefined;
	}

	#requireSession(staffAgentId: string): ArbiterSessionRef {
		const ref = this.#byStaff.get(staffAgentId);
		if (!ref) throw new Error("staff session has not been ensured");
		return ref;
	}
}
