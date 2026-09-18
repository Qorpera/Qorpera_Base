import { CloudCompanyComputerAccess } from "./cloud-company-computer-access.ts";
import { CloudCompanyComputerBrowserProfiles } from "./cloud-company-computer-browser-profiles.ts";
import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
} from "./cloud-company-computer-contract.ts";
import { CloudCompanyComputerSignIn } from "./cloud-company-computer-sign-in.ts";
import { CloudCompanyComputerStart } from "./cloud-company-computer-start.ts";
import { CloudCompanyComputerViews } from "./cloud-company-computer-views.ts";
import type { CloudMemberCompanyFileReader } from "./cloud-member-company-file.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

export interface MemberCompanyComputerCatalog {
	companyId: string;
	environmentId: string;
	canManage: boolean;
	scope: CompanyComputerScope | null;
	staff: { staffAgentId: string; name: string }[];
	nextAfter: string | null;
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid Company Computer response");
	return value as Record<string, unknown>;
}
type Options = Pick<
	ConstructorParameters<typeof CloudMemberCompanyFileReader>[0],
	"companyId" | "environmentId" | "supabaseUrl" | "publishableKey" | "accessToken" | "fetch" | "timeoutMs"
>;

/** Shared authenticated transport and discovery for member hosts. No provider
 * credentials, execution, machine lifecycle ownership or inferred endpoint. */
export class CloudMemberCompanyComputerClient {
	readonly #options: Options;
	readonly #origin: string;
	readonly #fetch: typeof fetch;
	constructor(options: Options) {
		const url = new URL(options.supabaseUrl);
		if (
			!COMPANY_COMPUTER_UUID.test(options.companyId) ||
			!COMPANY_COMPUTER_UUID.test(options.environmentId) ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!options.publishableKey ||
			options.publishableKey.length > 8192 ||
			/[\0\r\n]/.test(options.publishableKey) ||
			(options.timeoutMs !== undefined &&
				(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000))
		)
			throw new Error("Invalid Company Computer configuration");
		this.#options = { ...options };
		this.#origin = url.origin;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}
	#scope(value: CompanyComputerScope): CompanyComputerScope {
		record(value, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(value, value);
		if (value.companyId !== this.#options.companyId || value.environmentId !== this.#options.environmentId)
			throw new Error("Company Computer belongs to a different company");
		return { ...value };
	}
	async #rpc(
		method: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ data: unknown; error: null }> {
		return withCloudDeadline(
			async (deadline) => {
				const token = await this.#options.accessToken(deadline);
				deadline.throwIfAborted();
				if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
					throw new Error("Member sign-in is unavailable");
				const request: RequestInit & Pick<Request, "cache"> = {
					method: "POST",
					redirect: "error",
					cache: "no-store",
					signal: deadline,
					headers: {
						authorization: `Bearer ${token}`,
						apikey: this.#options.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify(args),
				};
				const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, request);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Company Computer access is unavailable");
				}
				const data = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 256 * 1024, deadline),
					),
				);
				deadline.throwIfAborted();
				return { data, error: null };
			},
			this.#options.timeoutMs ?? 15000,
			signal,
		);
	}
	async catalog(signal: AbortSignal, after: string | null = null): Promise<MemberCompanyComputerCatalog> {
		if (after !== null && !COMPANY_COMPUTER_UUID.test(after)) throw new Error("Invalid Company Computer page");
		const value = record(
			(
				await this.#rpc(
					"qorpera_member_office_catalog",
					{ p_environment_id: this.#options.environmentId, p_after: after },
					signal,
				)
			).data,
			"canManage,companyId,environmentId,nextAfter,scope,staff",
		);
		if (
			value.companyId !== this.#options.companyId ||
			value.environmentId !== this.#options.environmentId ||
			typeof value.canManage !== "boolean" ||
			!Array.isArray(value.staff) ||
			value.staff.length > 50
		)
			throw new Error("Invalid Company Computer catalog");
		const scope = value.scope === null ? null : this.#scope(value.scope as CompanyComputerScope);
		let previous = after;
		const staff = value.staff.map((input) => {
			const row = record(input, "name,staffAgentId");
			if (
				typeof row.staffAgentId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(row.staffAgentId) ||
				(previous !== null && row.staffAgentId <= previous) ||
				typeof row.name !== "string" ||
				!row.name ||
				[...row.name].length > 160
			)
				throw new Error("Invalid Company Computer roster");
			previous = row.staffAgentId;
			return { staffAgentId: row.staffAgentId, name: row.name };
		});
		if (value.nextAfter !== null && (staff.length !== 50 || value.nextAfter !== previous))
			throw new Error("Invalid Company Computer cursor");
		return {
			companyId: this.#options.companyId,
			environmentId: this.#options.environmentId,
			canManage: value.canManage,
			scope,
			staff,
			nextAfter: value.nextAfter as string | null,
		};
	}
	start(scope: CompanyComputerScope): CloudCompanyComputerStart {
		return new CloudCompanyComputerStart(this.#scope(scope), (method, args, signal) =>
			this.#rpc(method, args, signal),
		);
	}
	access(scope: CompanyComputerScope, staffAgentId: string): CloudCompanyComputerAccess {
		return new CloudCompanyComputerAccess(this.#scope(scope), staffAgentId, (method, args, signal) =>
			this.#rpc(method, args, signal),
		);
	}
	signIn(scope: CompanyComputerScope, memberId: string): CloudCompanyComputerSignIn {
		return new CloudCompanyComputerSignIn({
			scope: this.#scope(scope),
			memberId,
			rpc: (method, args, signal) => this.#rpc(method, args, signal),
		});
	}
	browserProfiles(scope: CompanyComputerScope, memberId: string): CloudCompanyComputerBrowserProfiles {
		return new CloudCompanyComputerBrowserProfiles({
			scope: this.#scope(scope),
			memberId,
			rpc: (method, args, signal) => this.#rpc(method, args, signal),
		});
	}
	views(
		scope: CompanyComputerScope,
		memberId: string,
		url: string,
		createWebSocket?: ConstructorParameters<typeof CloudCompanyComputerViews>[0]["createWebSocket"],
	): CloudCompanyComputerViews {
		return new CloudCompanyComputerViews({
			scope: this.#scope(scope),
			memberId,
			url,
			createWebSocket,
			rpc: (method, args, signal) => this.#rpc(method, args, signal),
		});
	}
}
