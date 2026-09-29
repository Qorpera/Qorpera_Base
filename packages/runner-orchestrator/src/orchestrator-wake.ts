import { NodeWebSocket } from "./node-websocket.ts";
import type { CloudRunnerWakeSource } from "./orchestrator.ts";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type RealtimeOrchestratorWakeState = "joined" | "refused" | "dropped" | "unreachable";

export interface RealtimeOrchestratorWakeOptions {
	/** The Supabase project origin (https). */
	supabaseUrl: string;
	/** The public key the orchestrator already holds; Realtime treats it as the anon role. */
	publishableKey: string;
	/** The orchestrator's current private wake topic (it follows control-token rotation). */
	topic: () => string;
	heartbeatMs?: number;
	connectTimeoutMs?: number;
	reconnectInitialMs?: number;
	reconnectMaximumMs?: number;
	/** Joins, refusals and drops, for the service log. Never carries the topic or a key. */
	onState?: (state: RealtimeOrchestratorWakeState, reason?: string) => void;
}

interface PhoenixMessage {
	topic?: unknown;
	event?: unknown;
	payload?: unknown;
	ref?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Wake-ups for one orchestrator over Supabase Realtime: the database broadcasts to the orchestrator's
 * private topic whenever claimable work may have appeared, and this client passes each one to the claim loop.
 * It joins with the publishable key alone (no database credential); the topic is derived from the control
 * token, so only this orchestrator and the database know it, and only the database may publish to it.
 * Heartbeats every `heartbeatMs`; an unanswered heartbeat, a close or an error is a drop, followed by a
 * reconnect with backoff. `listening` is true only while the channel is joined. */
export class RealtimeOrchestratorWake implements CloudRunnerWakeSource {
	readonly #options: Required<Omit<RealtimeOrchestratorWakeOptions, "onState">> &
		Pick<RealtimeOrchestratorWakeOptions, "onState">;
	readonly #url: URL;
	readonly #listeners = new Set<() => void>();
	#socket?: NodeWebSocket;
	#topic?: string;
	#joinRef?: string;
	/** When the pending join was sent; a join unanswered by the next heartbeat is a drop. */
	#joinSentAt?: number;
	#heartbeatRef?: string;
	#ref = 0;
	#listening = false;
	#running = false;
	#attempt = 0;
	#timer?: NodeJS.Timeout;

	constructor(options: RealtimeOrchestratorWakeOptions) {
		const url = new URL("/realtime/v1/websocket", options.supabaseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		)
			throw new Error("Realtime wake-ups require an HTTPS project URL");
		if (!options.publishableKey.trim() || /[\0\r\n]/.test(options.publishableKey))
			throw new Error("Realtime wake-ups require the publishable key");
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("apikey", options.publishableKey);
		url.searchParams.set("vsn", "1.0.0");
		this.#url = url;
		this.#options = {
			heartbeatMs: 25_000,
			connectTimeoutMs: 10_000,
			reconnectInitialMs: 1000,
			reconnectMaximumMs: 30_000,
			...options,
		};
	}

	get listening(): boolean {
		return this.#listening;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The control token rotated: move to the new topic now rather than at the next heartbeat. */
	refresh(): void {
		if (!this.#socket) return;
		this.#follow(this.#options.topic());
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#connect();
	}

	stop(): void {
		this.#running = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#listening = false;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close();
	}

	async #connect(): Promise<void> {
		if (!this.#running) return;
		let socket: NodeWebSocket | undefined;
		try {
			socket = await NodeWebSocket.connect(
				this.#url,
				{
					message: (text) => {
						if (socket && socket === this.#socket) this.#message(text);
					},
					close: (reason) => {
						if (socket && socket === this.#socket) this.#drop(reason);
					},
				},
				this.#options.connectTimeoutMs,
			);
		} catch (error) {
			this.#options.onState?.("unreachable", error instanceof Error ? error.message : "Realtime connection failed");
			this.#retry();
			return;
		}
		if (!this.#running || socket.closed) {
			socket.close();
			if (this.#running) this.#retry();
			return;
		}
		this.#socket = socket;
		this.#join(this.#options.topic());
		if (this.#socket) this.#schedule(this.#options.heartbeatMs, () => this.#heartbeat());
	}

	#join(topic: string): void {
		this.#topic = topic;
		this.#joinRef = this.#nextRef();
		this.#joinSentAt = Date.now();
		this.#send({
			topic: `realtime:${topic}`,
			event: "phx_join",
			payload: {
				config: {
					broadcast: { ack: false, self: false },
					presence: { key: "", enabled: false },
					postgres_changes: [],
					private: true,
				},
				// A legacy anon key is a JWT and doubles as the access token; a publishable key is not, and
				// Realtime takes the role from the connection's apikey.
				...(JWT_PATTERN.test(this.#options.publishableKey) ? { access_token: this.#options.publishableKey } : {}),
			},
			ref: this.#joinRef,
			join_ref: this.#joinRef,
		});
	}

	#heartbeat(): void {
		if (!this.#socket) return;
		if (this.#heartbeatRef !== undefined) {
			this.#drop("Realtime heartbeat went unanswered");
			return;
		}
		if (
			!this.#listening &&
			this.#joinSentAt !== undefined &&
			Date.now() - this.#joinSentAt >= this.#options.connectTimeoutMs
		) {
			this.#drop("Realtime did not answer the join");
			return;
		}
		this.#follow(this.#options.topic());
		if (!this.#socket) return;
		this.#heartbeatRef = this.#nextRef();
		this.#send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.#heartbeatRef });
		if (this.#socket) this.#schedule(this.#options.heartbeatMs, () => this.#heartbeat());
	}

	/** Leaves the joined topic and joins `topic` when they differ (after a control rotation). */
	#follow(topic: string): void {
		if (topic === this.#topic) return;
		const wasListening = this.#listening;
		this.#listening = false;
		this.#send({ topic: `realtime:${this.#topic}`, event: "phx_leave", payload: {}, ref: this.#nextRef() });
		if (!this.#socket) return;
		this.#join(topic);
		if (wasListening) this.#notify();
	}

	#message(text: string): void {
		let message: PhoenixMessage;
		try {
			message = record(JSON.parse(text)) ?? {};
		} catch {
			return;
		}
		const payload = record(message.payload);
		if (message.event === "phx_reply") {
			if (message.topic === "phoenix" && message.ref === this.#heartbeatRef) {
				this.#heartbeatRef = undefined;
				return;
			}
			if (message.topic !== `realtime:${this.#topic}` || message.ref !== this.#joinRef) return;
			if (payload?.status === "ok") {
				this.#attempt = 0;
				this.#joinSentAt = undefined;
				this.#listening = true;
				this.#options.onState?.("joined");
				// Catch up on anything announced while the channel was not joined.
				this.#notify();
				return;
			}
			this.#options.onState?.("refused", "Realtime refused the wake-up channel");
			this.#drop("Realtime refused the wake-up channel", false);
			return;
		}
		if (message.topic !== `realtime:${this.#topic}`) return;
		if (message.event === "broadcast" && payload?.event === "wake") {
			if (this.#listening) this.#notify();
			return;
		}
		if (message.event === "phx_error" || message.event === "phx_close") this.#drop("Realtime closed the channel");
	}

	#drop(reason: string, report = true): void {
		const socket = this.#socket;
		this.#socket = undefined;
		this.#heartbeatRef = undefined;
		this.#joinRef = undefined;
		this.#joinSentAt = undefined;
		socket?.close();
		const wasListening = this.#listening;
		this.#listening = false;
		if (report) this.#options.onState?.("dropped", reason);
		// Whatever was announced during the gap is found by the claim this triggers or by the fast poll.
		if (wasListening) this.#notify();
		this.#retry();
	}

	#retry(): void {
		if (!this.#running) return;
		const delay = Math.min(
			this.#options.reconnectMaximumMs,
			this.#options.reconnectInitialMs * 2 ** Math.min(this.#attempt, 16),
		);
		this.#attempt++;
		this.#schedule(delay, () => void this.#connect());
	}

	#schedule(delayMs: number, action: () => void): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(action, delayMs);
		this.#timer.unref();
	}

	#send(message: Record<string, unknown>): void {
		try {
			this.#socket?.send(JSON.stringify(message));
		} catch {
			this.#drop("Realtime connection closed");
		}
	}

	#nextRef(): string {
		this.#ref++;
		return String(this.#ref);
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
