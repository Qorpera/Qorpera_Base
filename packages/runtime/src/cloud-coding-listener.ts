import type { CloudCodingListenerControl } from "./cloud-coding-control.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Explicit cloud listener for providers without a completion callback. The
 * database atomically admits the parent wake and consumes the event. Restart
 * and concurrent listeners replay that same transaction, never model polling. */
export class CloudCodingCompletionListener {
	readonly #control: CloudCodingListenerControl;
	readonly #owner: string;
	#active = false;
	constructor(control: CloudCodingListenerControl, owner: string) {
		if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(owner)) throw new Error("Invalid coding listener identity");
		this.#control = control;
		this.#owner = owner;
	}
	async tick(
		signal: AbortSignal,
	): Promise<{ inspected: number; delivered: number; pending: number; cancelled: number; unconfirmed: number }> {
		if (this.#active) throw new Error("Coding listener tick already active");
		this.#active = true;
		try {
			const events = await cloudToolRequest(
				(checked) =>
					this.#control.call("qorpera_read_coding_completions", { p_owner: this.#owner, p_limit: 50 }, checked),
				signal,
			);
			if (!Array.isArray(events) || events.length > 50) throw new Error("Invalid coding completion page");
			const ids = events.map((event: unknown) => {
				if (
					!event ||
					typeof event !== "object" ||
					Array.isArray(event) ||
					!("id" in event) ||
					typeof event.id !== "string" ||
					!UUID.test(event.id)
				)
					throw new Error("Invalid coding completion event");
				return event.id;
			});
			if (new Set(ids).size !== ids.length) throw new Error("Duplicate coding completion event");
			const result = { inspected: ids.length, delivered: 0, pending: 0, cancelled: 0, unconfirmed: 0 };
			for (const id of ids) {
				signal.throwIfAborted();
				try {
					const value = await cloudToolRequest(
						(checked) => this.#control.call("qorpera_deliver_coding_completion", { p_event_id: id }, checked),
						signal,
					);
					if (!value || typeof value !== "object" || Array.isArray(value))
						throw new Error("Invalid coding delivery");
					const receipt = value as Record<string, unknown>;
					if (
						Object.keys(receipt).sort().join() !== "eventId,occurrenceId,schema,status" ||
						receipt.schema !== "qorpera.coding-completion-delivery/v1" ||
						receipt.eventId !== id ||
						!["delivered", "pending", "cancelled"].includes(String(receipt.status)) ||
						(receipt.status === "delivered"
							? typeof receipt.occurrenceId !== "string" || !UUID.test(receipt.occurrenceId)
							: receipt.occurrenceId !== null)
					)
						throw new Error("Invalid coding delivery");
					result[receipt.status as "delivered" | "pending" | "cancelled"]++;
				} catch {
					signal.throwIfAborted();
					// Unknown delivery remains in SQL. A later tick observes or
					// reconciles it; no fabricated acknowledgement or new event.
					result.unconfirmed++;
				}
			}
			return result;
		} finally {
			this.#active = false;
		}
	}
}
