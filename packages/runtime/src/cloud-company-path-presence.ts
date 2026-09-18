import {
	COMPANY_PATH_PRESENCE_SCHEMA,
	COMPANY_PATH_PRESENCE_TTL_MS,
	type CompanyPathActivity,
	type CompanyPathExtent,
	type CompanyPathPresenceStatement,
	type CompanyPathPresenceView,
	type CompanyPathPresenceWire,
	type CompanyPresenceIdentity,
	type CompanyPresencePathRoutes,
	type CompanyPresenceRoute,
	companyPresenceBytes,
	companyPresenceOverlap,
	companyPresencePaths,
	parseCompanyPathPresence,
	parseCompanyPresenceIdentity,
	parseCompanyPresenceRoutes,
} from "@qorpera/cloud-client/company-path-presence";
import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";

type PresenceClient = Pick<SupabaseClient, "channel" | "removeChannel">;
export interface CloudCompanyPathPresence {
	observe(
		path: string,
		extent: CompanyPathExtent,
		activity: CompanyPathActivity,
		signal: AbortSignal,
	): Promise<CompanyPathPresenceView>;
	close(): Promise<void>;
}
export type CloudCompanyPathPresenceFactory = (
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	signal: AbortSignal,
) => CloudCompanyPathPresence | undefined;

/** Presence cannot hold up canonical work or turn startup. */
export async function observeCloudCompanyPathPresence(
	presence: CloudCompanyPathPresence | undefined,
	path: string,
	extent: CompanyPathExtent,
	activity: CompanyPathActivity,
	signal: AbortSignal,
): Promise<CompanyPathPresenceView | undefined> {
	if (!presence) return undefined;
	try {
		return await cloudToolRequest(
			(requestSignal) => presence.observe(path, extent, activity, requestSignal),
			signal,
			2000,
		);
	} catch {
		return {
			schema: "qorpera.company-path-presence-view/v1",
			state: "unavailable",
			observedAt: Date.now(),
			paths: [{ path, participants: [] }],
		};
	}
}

function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_NATIVE_PRESENCE_RESPONSE");
	return value as Record<string, unknown>;
}
interface Claim {
	path: string;
	extent: CompanyPathExtent;
	activity: CompanyPathActivity;
}

/** Host-owned, lossy observation. No RPC result or presence signature is an
 * effect grant; canonical reads/writes still use the Company File gateway.
 * The channel contains opaque path tokens and no filenames or native binding.
 */
export class CloudNativeCompanyPresence implements CloudCompanyPathPresence {
	readonly #binding: CloudNativeToolBinding;
	readonly #identity: CloudNativeToolIdentity;
	readonly #control: CloudCompanyPathControl;
	readonly #client: PresenceClient;
	readonly #stop = new AbortController();
	readonly #signal: AbortSignal;
	readonly #signatures = new PresenceSignatures();
	readonly #clientId = crypto.randomUUID();
	readonly #timer: ReturnType<typeof setInterval>;
	readonly #abort: () => void;
	#channel: RealtimeChannel | undefined;
	#connected = false;
	#closed = false;
	#closing: Promise<void> | undefined;
	#pending: Promise<void> | undefined;
	#claims: Claim[] = [];
	#revision = 0;
	#sequence = 0;
	#registration: CompanyPresenceIdentity | undefined;
	#statements: CompanyPathPresenceWire[] = [];
	#truncated = false;
	readonly #seen = new Map<string, number>();

	constructor(options: {
		binding: CloudNativeToolBinding;
		identity: CloudNativeToolIdentity;
		control: CloudCompanyPathControl;
		client: PresenceClient;
		signal: AbortSignal;
	}) {
		if (options.identity.audienceKind !== "company" || options.identity.runId !== options.binding.runId)
			throw new Error("INVALID_NATIVE_PRESENCE_AUDIENCE");
		this.#binding = parseCloudNativeToolBinding(options.binding);
		this.#identity = Object.freeze({ ...options.identity });
		this.#control = options.control;
		this.#client = options.client;
		this.#signal = AbortSignal.any([options.signal, this.#stop.signal]);
		this.#abort = () => {
			void this.close();
		};
		this.#signal.addEventListener("abort", this.#abort, { once: true });
		this.#timer = setInterval(() => {
			void this.#refresh();
		}, 10_000);
		this.#timer.unref?.();
		if (this.#signal.aborted) void this.close();
		else void this.#refresh();
	}

	#call(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal = this.#signal): Promise<unknown> {
		return cloudToolRequest((requestSignal) => this.#control.call(method, args, requestSignal), signal, 3000);
	}
	async #scope(paths: string[], signal: AbortSignal): Promise<CompanyPresencePathRoutes[]> {
		const row = closed(
			await this.#call(
				"qorpera_company_presence_scope",
				{
					p_environment_id: this.#identity.environmentId,
					p_binding: this.#binding,
					p_paths: paths,
				},
				signal,
			),
			"companyId,environmentId,paths,schema",
		);
		if (
			row.schema !== "qorpera.company-presence-scope/v1" ||
			row.companyId !== this.#identity.companyId ||
			row.environmentId !== this.#identity.environmentId
		)
			throw new Error("NATIVE_PRESENCE_SCOPE_CHANGED");
		const scoped = parseCompanyPresenceRoutes(row.paths, paths);
		if (scoped.some((item) => !item.routes.some((route) => route.path === item.path)))
			throw new Error("NATIVE_PRESENCE_PATH_UNAVAILABLE");
		return scoped;
	}
	#current(value: CompanyPathPresenceWire): boolean {
		const now = Date.now();
		return (
			value.companyId === this.#identity.companyId &&
			value.environmentId === this.#identity.environmentId &&
			value.expiresAt > now &&
			value.issuedAt <= now + 2000 &&
			value.issuedAt >= now - COMPANY_PATH_PRESENCE_TTL_MS
		);
	}
	#readState(channel: RealtimeChannel): void {
		if (this.#closed || channel !== this.#channel || !this.#connected) return;
		const state = Object.entries(channel.presenceState());
		this.#truncated = state.length > 64;
		this.#statements = [];
		for (const [clientId, metas] of state.slice(0, 64)) {
			if (metas.length > 4) this.#truncated = true;
			for (const meta of metas.slice(0, 4)) {
				try {
					// Supabase adds presence_ref; it is transport metadata, not signed data.
					const { presence_ref: _ref, ...payload } = meta;
					const value = parseCompanyPathPresence(payload);
					if (value.clientId === clientId && clientId !== this.#clientId && this.#current(value))
						this.#statements.push(value);
				} catch {
					/* Other member signals share this channel. */
				}
			}
		}
	}
	#disconnect(channel: RealtimeChannel): void {
		if (channel !== this.#channel) return;
		this.#channel = undefined;
		this.#connected = false;
		this.#statements = [];
		void this.#client.removeChannel(channel).catch(() => undefined);
	}
	#refresh(): Promise<void> {
		if (this.#pending) return this.#pending;
		if (this.#closed) return Promise.resolve();
		this.#pending = this.#tick()
			.catch(() => {
				this.#registration = undefined;
				if (this.#channel) this.#disconnect(this.#channel);
			})
			.finally(() => {
				this.#pending = undefined;
			});
		return this.#pending;
	}
	async #tick(): Promise<void> {
		const publicKey = await this.#signatures.publicKey();
		this.#signal.throwIfAborted();
		const identity = parseCompanyPresenceIdentity(
			await this.#call("qorpera_native_presence_register", {
				p_binding: this.#binding,
				p_client_id: this.#clientId,
				p_public_key: publicKey,
			}),
		);
		if (
			identity.companyId !== this.#identity.companyId ||
			identity.environmentId !== this.#identity.environmentId ||
			identity.runId !== this.#binding.runId ||
			identity.staffAgentId !== this.#identity.staffAgentId ||
			identity.clientId !== this.#clientId ||
			identity.publicKey !== publicKey ||
			identity.expiresAt <= Date.now() ||
			identity.expiresAt > Date.now() + COMPANY_PATH_PRESENCE_TTL_MS + 2000
		)
			throw new Error("NATIVE_PRESENCE_IDENTITY_CHANGED");
		this.#registration = identity;
		this.#signal.throwIfAborted();
		if (!this.#channel) {
			const next = this.#client.channel(`qorpera-presence-${identity.companyId}`, {
				config: { private: true, presence: { key: this.#clientId }, broadcast: { self: false } },
			});
			this.#channel = next;
			next.on("presence", { event: "sync" }, () => this.#readState(next));
			next.subscribe((status) => {
				if (this.#closed || next !== this.#channel) return;
				if (status === "SUBSCRIBED") {
					this.#connected = true;
					this.#readState(next);
					// Initial subscription can finish after this tick. Publish the latest claim.
					void this.#publish().catch(() => this.#disconnect(next));
				} else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT")
					this.#disconnect(next);
			});
		} else await this.#publish();
	}
	async #publish(): Promise<void> {
		const channel = this.#channel,
			identity = this.#registration,
			revision = this.#revision;
		if (!channel || !identity || !this.#connected || this.#closed) return;
		const claims = this.#claims.slice();
		const scope = claims.length
			? await this.#scope(
					claims.map((claim) => claim.path),
					this.#signal,
				)
			: [];
		const routes = new Map<string, CompanyPresenceRoute>();
		for (const [index, entry] of scope.entries())
			for (const route of entry.routes) {
				const value: CompanyPresenceRoute = {
					token: route.token,
					relation: route.path === entry.path ? "self" : "below",
					extent: claims[index].extent,
					activity: claims[index].activity,
				};
				routes.set(JSON.stringify(value), value);
			}
		const issuedAt = Date.now(),
			expiresAt = Math.min(identity.expiresAt, issuedAt + COMPANY_PATH_PRESENCE_TTL_MS);
		if (expiresAt <= issuedAt || revision !== this.#revision || this.#closed || channel !== this.#channel) return;
		const statement: CompanyPathPresenceStatement = {
			schema: COMPANY_PATH_PRESENCE_SCHEMA,
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			clientId: identity.clientId,
			sequence: ++this.#sequence,
			issuedAt,
			expiresAt,
			routes: [...routes.values()],
		};
		const signature = await this.#signatures.sign(companyPresenceBytes(statement));
		if (revision !== this.#revision || this.#closed || channel !== this.#channel) return;
		const tracked = await cloudToolRequest(() => channel.track({ ...statement, signature }), this.#signal, 3000);
		if (tracked !== "ok") throw new Error("NATIVE_PRESENCE_PUBLISH_UNAVAILABLE");
	}

	async observe(
		path: string,
		extent: CompanyPathExtent,
		activity: CompanyPathActivity,
		signal: AbortSignal,
	): Promise<CompanyPathPresenceView> {
		const result: CompanyPathPresenceView = {
			schema: "qorpera.company-path-presence-view/v1",
			state: "unavailable",
			observedAt: Date.now(),
			paths: [{ path, participants: [] }],
		};
		try {
			const paths = companyPresencePaths([path]);
			this.#claims = [{ path, extent, activity }];
			this.#revision++;
			await this.#refresh();
			// Own scope is a separate transaction from every publisher lookup.
			const scoped = await this.#scope(paths, AbortSignal.any([signal, this.#signal]));
			const channel = this.#channel;
			if (!channel || !this.#connected || this.#closed) return result;
			const routes = scoped[0].routes;
			// Verify the newest statement even when it no longer overlaps this path.
			// Filtering first could revive an older signed claim after the agent moved.
			const candidates = this.#statements.filter((value) => this.#current(value));
			let partial = this.#truncated || candidates.length > 32;
			const newest = new Map<
				string,
				{
					statement: CompanyPathPresenceWire;
					identity: CompanyPresenceIdentity;
					allowed: CompanyPresencePathRoutes[];
				}
			>();
			// Bound parallel lookups. Each authenticates one publisher and releases its
			// SQL locks before another RPC; no transaction locks a pair of native runs.
			for (let index = 0; index < Math.min(32, candidates.length); index += 4) {
				await Promise.all(
					candidates.slice(index, index + 4).map(async (statement) => {
						try {
							const value = await this.#call(
								"qorpera_native_presence_subject",
								{
									p_environment_id: this.#identity.environmentId,
									p_client_id: statement.clientId,
									p_paths: paths,
								},
								AbortSignal.any([signal, this.#signal]),
							);
							if (value === null) return;
							const row = closed(value, "identity,paths,schema");
							if (row.schema !== "qorpera.native-presence-subject/v1")
								throw new Error("INVALID_NATIVE_PRESENCE_SUBJECT");
							const identity = parseCompanyPresenceIdentity(row.identity);
							const allowed = parseCompanyPresenceRoutes(row.paths, paths);
							if (
								identity.companyId !== this.#identity.companyId ||
								identity.environmentId !== this.#identity.environmentId ||
								identity.clientId !== statement.clientId ||
								identity.runId === this.#binding.runId ||
								identity.expiresAt < statement.expiresAt ||
								!this.#current(statement)
							)
								return;
							if (
								!(await PresenceSignatures.verify(
									identity.publicKey,
									companyPresenceBytes(statement),
									statement.signature,
								))
							)
								return;
							if (statement.sequence < (this.#seen.get(statement.clientId) ?? 0) || !this.#current(statement))
								return;
							const previous = newest.get(statement.clientId);
							if (!previous || previous.statement.sequence < statement.sequence)
								newest.set(statement.clientId, { statement, identity, allowed });
						} catch {
							partial = true;
						}
					}),
				);
			}
			if (this.#closed || channel !== this.#channel || !this.#connected) return result;
			for (const { statement, identity, allowed } of newest.values()) {
				if (!this.#current(statement) || statement.sequence < (this.#seen.get(statement.clientId) ?? 0)) continue;
				this.#seen.set(statement.clientId, statement.sequence);
				if (this.#seen.size > 256) this.#seen.delete(this.#seen.keys().next().value!);
				for (const claim of statement.routes) {
					const route = routes.find(
						(route) =>
							route.token === claim.token &&
							allowed[0].routes.some((item) => item.path === route.path && item.token === route.token),
					);
					const overlap = route && companyPresenceOverlap(claim, route.path, path);
					if (
						overlap &&
						!result.paths[0].participants.some(
							(item) =>
								item.runId === identity.runId && item.overlap === overlap && item.activity === claim.activity,
						)
					)
						result.paths[0].participants.push({
							staffAgentId: identity.staffAgentId,
							runId: identity.runId,
							activity: claim.activity,
							overlap,
							expiresAt: statement.expiresAt,
						});
				}
			}
			// Refresh receiver authorization after all asynchronous subject lookups.
			const current = await this.#scope(paths, AbortSignal.any([signal, this.#signal]));
			if (JSON.stringify(current) !== JSON.stringify(scoped) || this.#closed || channel !== this.#channel)
				return { ...result, paths: [{ path, participants: [] }] };
			result.observedAt = Date.now();
			result.paths[0].participants = result.paths[0].participants.filter(
				(item) => item.expiresAt > result.observedAt,
			);
			result.state = partial ? "partial" : "available";
			return result;
		} catch {
			return { ...result, paths: [{ path, participants: [] }] };
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#signal.removeEventListener("abort", this.#abort);
		this.#stop.abort();
		clearInterval(this.#timer);
		const channel = this.#channel;
		this.#channel = undefined;
		this.#connected = false;
		this.#statements = [];
		this.#claims = [];
		this.#closing = (async () => {
			await this.#pending;
			await Promise.allSettled([
				...(channel ? [this.#client.removeChannel(channel)] : []),
				this.#call(
					"qorpera_native_presence_forget",
					{ p_binding: this.#binding, p_client_id: this.#clientId },
					AbortSignal.timeout(3000),
				),
			]);
		})();
		return this.#closing;
	}
}
