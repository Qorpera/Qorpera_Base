import {
	CloudMemberBrowserRecovery,
	type MemberBrowserRecoveryRpc,
} from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { presenceUuid } from "@qorpera/cloud-client/company-path-presence";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type MemberWebConfig, parseMemberWebConfig } from "./config.ts";

export interface WebCompany {
	companyId: string;
	environmentId: string;
	name: string;
	environmentName: string;
	role: "owner" | "admin" | "contributor" | "viewer";
}
type Rpc = "qorpera_list_hosted_profiles" | Parameters<MemberBrowserRecoveryRpc>[0];
type Context = {
	memberId: string;
	signal: AbortSignal;
	current(): void;
	token(signal: AbortSignal): Promise<string>;
	rpc(method: Rpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
};
function companies(value: unknown): WebCompany[] {
	if (!Array.isArray(value) || value.length > 2000) throw new Error("Company list is unavailable");
	const seen = new Set<string>();
	return value.map((value) => {
		// bootstrap_state is the legacy snapshot's; the list may still send it, and nothing here reads it.
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value)
				.filter((key) => key !== "bootstrap_state")
				.sort()
				.join() !== "contract_version,created_at,environment_id,environment_name,profile_id,profile_name,role"
		)
			throw new Error("Invalid company list");
		const companyId = presenceUuid(value.profile_id),
			environmentId = presenceUuid(value.environment_id),
			key = `${companyId}:${environmentId}`;
		if (
			seen.has(key) ||
			!["owner", "admin", "contributor", "viewer"].includes(value.role) ||
			![value.profile_name, value.environment_name].every(
				(name) => typeof name === "string" && [...name].length > 0 && [...name].length <= 120,
			) ||
			!Number.isSafeInteger(value.contract_version) ||
			value.contract_version < 1 ||
			typeof value.created_at !== "string" ||
			!Number.isFinite(Date.parse(value.created_at))
		)
			throw new Error("Invalid company list");
		seen.add(key);
		return {
			companyId,
			environmentId,
			name: value.profile_name,
			environmentName: value.environment_name,
			role: value.role,
		};
	});
}

/** The account owns cancellation and selection only. Every operation still
 * carries the member token to the same cloud authority used by desktop. */
export class WebMemberAccount {
	readonly #config: MemberWebConfig;
	readonly #auth: Pick<SupabaseClient, "auth">;
	readonly #fetch: typeof fetch;
	#memberId: string | null = null;
	#stop = new AbortController();
	#companyStop?: AbortController;
	#companies: WebCompany[] = [];
	#catalogRevision = 0;
	constructor(options: { config: MemberWebConfig; client: Pick<SupabaseClient, "auth">; fetch?: typeof fetch }) {
		this.#config = parseMemberWebConfig(options.config);
		this.#auth = options.client;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}
	get memberId(): string | null {
		return this.#memberId;
	}
	/** Call synchronously on account/sign-out events; do not await Auth SDK
	 * operations inside its onAuthStateChange callback. */
	setSession(session: Session | null): boolean {
		const memberId = session ? presenceUuid(session.user.id) : null;
		if (memberId === this.#memberId) return false;
		this.#stop.abort();
		this.#companyStop?.abort();
		this.#companyStop = undefined;
		this.#stop = new AbortController();
		this.#companies = [];
		this.#memberId = memberId;
		return true;
	}
	close(): void {
		this.#stop.abort();
		this.#companyStop?.abort();
		this.#memberId = null;
		this.#companies = [];
	}
	leaveCompany(): void {
		this.#companyStop?.abort();
		this.#companyStop = undefined;
	}
	#context(): Context {
		const memberId = this.#memberId,
			signal = this.#stop.signal;
		if (!memberId || signal.aborted) throw new Error("Sign in to continue");
		const current = () => {
			signal.throwIfAborted();
			if (this.#memberId !== memberId) throw new Error("The signed-in account changed");
		};
		const token = async (requestSignal: AbortSignal) => {
			current();
			requestSignal.throwIfAborted();
			const { data, error } = await this.#auth.auth.getSession();
			current();
			requestSignal.throwIfAborted();
			if (
				error ||
				data.session?.user.id !== memberId ||
				typeof data.session.access_token !== "string" ||
				!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
			)
				throw new Error("Sign in to continue");
			return data.session.access_token;
		};
		const rpc: Context["rpc"] = (method, args, caller) =>
			withCloudDeadline(
				async (requestSignal) => {
					const bearer = await token(requestSignal),
						response = await this.#fetch(`${this.#config.supabaseUrl}/rest/v1/rpc/${method}`, {
							method: "POST",
							headers: {
								authorization: `Bearer ${bearer}`,
								apikey: this.#config.publishableKey,
								"content-type": "application/json",
							},
							body: JSON.stringify(args),
							signal: requestSignal,
							redirect: "error",
							cache: "no-store",
						});
					if (response.status !== 200) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error("Cloud access is unavailable. Refresh to check access.");
					}
					const value = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, requestSignal),
						),
					);
					current();
					requestSignal.throwIfAborted();
					return value;
				},
				10000,
				AbortSignal.any([signal, caller]),
			);
		return { memberId, signal, current, token, rpc };
	}
	async companies(): Promise<WebCompany[]> {
		const context = this.#context();
		const revision = ++this.#catalogRevision;
		this.#companies = [];
		const result = companies(await context.rpc("qorpera_list_hosted_profiles", {}, context.signal));
		context.current();
		if (revision !== this.#catalogRevision) throw new Error("Company list was refreshed");
		this.#companies = result;
		return structuredClone(result);
	}
	openCompany(environmentId: string): WebCompanySession {
		const context = this.#context(),
			company = this.#companies.find((company) => company.environmentId === environmentId);
		if (!company) throw new Error("Refresh and select a company");
		this.#companyStop?.abort();
		this.#companyStop = new AbortController();
		return new WebCompanySession({
			config: this.#config,
			company,
			context,
			signal: AbortSignal.any([context.signal, this.#companyStop.signal]),
			fetch: this.#fetch,
		});
	}
	recovery(): { client: CloudMemberBrowserRecovery; signal: AbortSignal; current(): void } {
		const context = this.#context();
		return {
			client: new CloudMemberBrowserRecovery({
				memberId: context.memberId,
				rpc: async (method, args, signal) => ({ data: await context.rpc(method, args, signal), error: null }),
			}),
			signal: context.signal,
			current: context.current,
		};
	}
}

export class WebCompanySession {
	readonly company: Readonly<WebCompany>;
	readonly memberId: string;
	readonly signal: AbortSignal;
	readonly computer: CloudMemberCompanyComputerClient;
	readonly #config: MemberWebConfig;
	readonly #context: Context;
	constructor(options: {
		config: MemberWebConfig;
		company: WebCompany;
		context: Context;
		signal: AbortSignal;
		fetch: typeof fetch;
	}) {
		this.company = Object.freeze({ ...options.company });
		this.memberId = options.context.memberId;
		this.signal = options.signal;
		this.#config = options.config;
		this.#context = options.context;
		this.computer = new CloudMemberCompanyComputerClient({
			companyId: this.company.companyId,
			environmentId: this.company.environmentId,
			supabaseUrl: options.config.supabaseUrl,
			publishableKey: options.config.publishableKey,
			accessToken: async (signal) => {
				this.current();
				const token = await options.context.token(signal);
				this.current();
				return token;
			},
			fetch: async (input, init) => {
				this.current();
				const response = await options.fetch(input, {
					...init,
					signal: AbortSignal.any([this.signal, ...(init?.signal ? [init.signal] : [])]),
				});
				if (this.signal.aborted) {
					void response.body?.cancel().catch(() => undefined);
					this.signal.throwIfAborted();
				}
				this.current();
				return response;
			},
		});
	}
	current = (): void => {
		this.#context.current();
		this.signal.throwIfAborted();
	};
	views(scope: Parameters<CloudMemberCompanyComputerClient["views"]>[0]) {
		this.current();
		if (!this.#config.officeViewerOrigin) throw new Error("Cloud screen viewing has not been configured");
		return this.computer.views(
			scope,
			this.memberId,
			`${this.#config.officeViewerOrigin}/office/${scope.companyComputerId}/view`,
		);
	}
}
