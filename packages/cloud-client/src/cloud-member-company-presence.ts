import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";
import {
	COMPANY_PATH_PRESENCE_TTL_MS,
	type CompanyPathPresenceView,
	type CompanyPathPresenceWire,
	companyPresencePaths,
	parseCompanyPathPresence,
	presenceUuid,
} from "./company-path-presence.ts";
import { parseMemberCompanyPresenceReply } from "./member-company-path-presence.ts";

/** Lossy, read-only native activity for member clients. It neither publishes
 * member activity nor grants native/file authority. Failures clear display data.
 * Supply a dedicated account-bound Realtime client: Supabase reuses topics
 * within a client, and this observer owns/removes its channel. */
export class CloudMemberCompanyPresence {
	readonly #companyId: string;
	readonly #environmentId: string;
	readonly #client: Pick<SupabaseClient, "channel" | "removeChannel">;
	readonly #url: string;
	readonly #token: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #onChange: (view: CompanyPathPresenceView) => void;
	readonly #stop = new AbortController();
	readonly #signal: AbortSignal;
	readonly #abort: () => void;
	readonly #timer: ReturnType<typeof setInterval>;
	readonly #seen = new Map<string, number>();
	#channel?: RealtimeChannel;
	#connected = false;
	#joining = false;
	#closed = false;
	#paths: string[] = [];
	#statements: CompanyPathPresenceWire[] = [];
	#truncated = false;
	#dirty = true;
	#revision = 0;
	#lastRequest = 0;
	#retryJoinAt = 0;
	#pending?: Promise<void>;
	#requestStop?: AbortController;
	#view?: CompanyPathPresenceView;
	#closing?: Promise<void>;
	constructor(options: {
		companyId: string;
		environmentId: string;
		client: Pick<SupabaseClient, "channel" | "removeChannel">;
		objectGatewayUrl: string;
		accessToken(signal: AbortSignal): Promise<string>;
		fetch?: typeof fetch;
		signal: AbortSignal;
		onChange(view: CompanyPathPresenceView): void;
	}) {
		this.#companyId = presenceUuid(options.companyId);
		this.#environmentId = presenceUuid(options.environmentId);
		const url = new URL(options.objectGatewayUrl);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new Error("INVALID_MEMBER_PRESENCE_GATEWAY");
		this.#url = `${url.origin}/v1/member-company-presence/${this.#companyId}/${this.#environmentId}`;
		this.#client = options.client;
		this.#token = options.accessToken;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#onChange = options.onChange;
		this.#signal = AbortSignal.any([options.signal, this.#stop.signal]);
		this.#abort = () => {
			void this.close();
		};
		this.#signal.addEventListener("abort", this.#abort, { once: true });
		this.#timer = setInterval(() => this.#tick(), 1000);
		this.#timer.unref?.();
		if (this.#signal.aborted) void this.close();
		else void this.#join();
	}
	select(value: readonly string[]): void {
		if (this.#closed) return;
		if (!Array.isArray(value)) throw new Error("INVALID_MEMBER_PRESENCE_PATHS");
		const paths = value.length === 0 ? [] : companyPresencePaths(value);
		this.#revision++;
		this.#requestStop?.abort();
		this.#paths = [...paths];
		this.#dirty = true;
		this.#clear();
		void this.#refresh();
	}
	#emit(view: CompanyPathPresenceView): void {
		this.#view = structuredClone(view);
		try {
			this.#onChange(structuredClone(view));
		} catch {
			/* A client callback is not authority. */
		}
	}
	#clear(): void {
		this.#emit({
			schema: "qorpera.company-path-presence-view/v1",
			state: "unavailable",
			observedAt: Date.now(),
			paths: this.#paths.map((path) => ({ path, participants: [] })),
		});
	}
	#current(statement: CompanyPathPresenceWire): boolean {
		const now = Date.now();
		return (
			statement.companyId === this.#companyId &&
			statement.environmentId === this.#environmentId &&
			statement.expiresAt > now &&
			statement.issuedAt <= now + 2000 &&
			statement.issuedAt >= now - COMPANY_PATH_PRESENCE_TTL_MS &&
			statement.sequence >= (this.#seen.get(statement.clientId) ?? 0)
		);
	}
	#read(channel: RealtimeChannel): void {
		if (this.#closed || channel !== this.#channel || !this.#connected) return;
		const state = Object.entries(channel.presenceState());
		this.#statements = [];
		this.#truncated = state.length > 64;
		for (const [clientId, metas] of state.slice(0, 64)) {
			if (!Array.isArray(metas)) {
				this.#truncated = true;
				continue;
			}
			if (metas.length > 4) this.#truncated = true;
			for (const meta of metas.slice(0, 4))
				try {
					const { presence_ref: _ref, ...payload } = meta;
					const statement = parseCompanyPathPresence(payload);
					if (statement.clientId === clientId && this.#current(statement)) this.#statements.push(statement);
				} catch {
					/* Other member presence uses this channel too. */
				}
		}
		this.#dirty = true;
	}
	#disconnect(channel: RealtimeChannel): void {
		if (channel !== this.#channel) return;
		this.#channel = undefined;
		this.#connected = false;
		this.#statements = [];
		this.#revision++;
		this.#requestStop?.abort();
		this.#retryJoinAt = Date.now() + 5000;
		this.#clear();
		void withCloudDeadline(() => this.#client.removeChannel(channel), 2000).catch(() => undefined);
	}
	async #join(): Promise<void> {
		if (this.#closed || this.#joining || this.#channel) return;
		this.#joining = true;
		try {
			const token = await withCloudDeadline((signal) => this.#token(signal), 2000, this.#signal);
			this.#signal.throwIfAborted();
			if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new Error("MEMBER_PRESENCE_SIGN_IN_UNAVAILABLE");
			const channel = this.#client.channel(`qorpera-presence-${this.#companyId}`, {
				config: { private: true, presence: { key: crypto.randomUUID() } },
			});
			this.#channel = channel;
			channel.on("presence", { event: "sync" }, () => this.#read(channel));
			channel.subscribe((status) => {
				if (this.#closed || this.#channel !== channel) return;
				if (status === "SUBSCRIBED") {
					this.#connected = true;
					this.#read(channel);
					void this.#refresh();
				} else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) this.#disconnect(channel);
			});
		} catch {
			if (!this.#closed) {
				if (this.#channel) this.#disconnect(this.#channel);
				else {
					this.#retryJoinAt = Date.now() + 5000;
					this.#clear();
				}
			}
		} finally {
			this.#joining = false;
		}
	}
	#tick(): void {
		if (this.#closed) return;
		if (this.#view) {
			const next = structuredClone(this.#view),
				now = Date.now();
			if (now - next.observedAt > COMPANY_PATH_PRESENCE_TTL_MS) {
				next.state = "unavailable";
				for (const path of next.paths) path.participants = [];
			} else
				for (const path of next.paths) path.participants = path.participants.filter((item) => item.expiresAt > now);
			if (JSON.stringify(next) !== JSON.stringify(this.#view)) this.#emit(next);
		}
		if (!this.#channel && Date.now() >= this.#retryJoinAt) void this.#join();
		if (Date.now() - this.#lastRequest >= (this.#dirty ? 1000 : 5000)) void this.#refresh();
	}
	#refresh(): Promise<void> {
		if (this.#pending) return this.#pending;
		if (this.#closed || !this.#connected || !this.#channel || !this.#paths.length) return Promise.resolve();
		const revision = this.#revision,
			channel = this.#channel,
			paths = [...this.#paths],
			stop = new AbortController();
		this.#requestStop = stop;
		this.#lastRequest = Date.now();
		this.#dirty = false;
		const candidates = this.#statements.filter((statement) => this.#current(statement));
		const offered = candidates.slice(0, 32),
			body = JSON.stringify({ paths, candidates: offered, truncated: this.#truncated || candidates.length > 32 });
		this.#pending = withCloudDeadline(
			async (signal) => {
				if (new TextEncoder().encode(body).length > 1024 * 1024) throw new Error("PRESENCE_REQUEST_TOO_LARGE");
				const token = await this.#token(signal);
				signal.throwIfAborted();
				if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new Error("MEMBER_PRESENCE_SIGN_IN_UNAVAILABLE");
				const request: RequestInit & Pick<Request, "cache"> = {
					method: "POST",
					redirect: "error",
					cache: "no-store",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body,
					signal,
				};
				const response = await this.#fetch(this.#url, request);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("MEMBER_PRESENCE_UNAVAILABLE");
				}
				const reply = parseMemberCompanyPresenceReply(
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, signal),
						),
					),
					this.#companyId,
					this.#environmentId,
					paths,
				);
				signal.throwIfAborted();
				if (this.#closed || revision !== this.#revision || channel !== this.#channel || !this.#connected) return;
				for (const item of reply.confirmed) {
					if (
						!offered.some(
							(statement) => statement.clientId === item.clientId && statement.sequence === item.sequence,
						)
					)
						throw new Error("PRESENCE_CONFIRMATION_CHANGED");
				}
				for (const item of reply.confirmed) {
					this.#seen.set(item.clientId, Math.max(this.#seen.get(item.clientId) ?? 0, item.sequence));
					if (this.#seen.size > 256) this.#seen.delete(this.#seen.keys().next().value!);
				}
				this.#emit(reply.view);
			},
			3500,
			AbortSignal.any([this.#signal, stop.signal]),
		)
			.catch(() => {
				if (!this.#closed && revision === this.#revision && channel === this.#channel) this.#clear();
			})
			.finally(() => {
				this.#pending = undefined;
				if (this.#requestStop === stop) this.#requestStop = undefined;
			});
		return this.#pending;
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#signal.removeEventListener("abort", this.#abort);
		this.#stop.abort();
		this.#requestStop?.abort();
		clearInterval(this.#timer);
		const channel = this.#channel;
		this.#channel = undefined;
		this.#connected = false;
		this.#statements = [];
		this.#seen.clear();
		this.#clear();
		this.#closing = Promise.allSettled([
			this.#pending,
			...(channel ? [withCloudDeadline(() => this.#client.removeChannel(channel), 2000)] : []),
		]).then(() => undefined);
		return this.#closing;
	}
}
