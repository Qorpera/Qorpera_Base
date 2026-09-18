import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import type { CompanyComputerPrivacyChallenge } from "./cloud-company-computer-privacy.ts";

export interface MemberBrowserProfile {
	activeStaffAgentId: string | null;
	profileId: string;
	label: string;
	version: number;
	prepared: boolean;
}
export interface MemberBrowserProfileCatalog {
	scope: CompanyComputerScope;
	memberId: string;
	canUse: boolean;
	profiles: MemberBrowserProfile[];
	nextAfter: string | null;
}
export interface MemberBrowserGrantStatus {
	scope: CompanyComputerScope;
	memberId: string;
	staffAgentId: string;
	profile: MemberBrowserProfile;
	grant: {
		grantId: string;
		version: number;
		profileVersion: number;
		state: "active" | "revoked";
		usable: boolean;
	} | null;
}
export interface MemberBrowserGrantChange {
	profileId: string;
	grantId: string;
	version: number;
	state: "active" | "revoked";
	drains: CompanyComputerPrivacyChallenge["drains"];
}
export type CloudCompanyComputerBrowserProfilesRpc = (
	method:
		| "qorpera_member_browser_profiles"
		| "qorpera_create_member_browser_profile"
		| "qorpera_member_browser_grant_status"
		| "qorpera_set_runtime_browser_grant",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_BROWSER_PROFILE_RESPONSE");
	return value as Record<string, unknown>;
}
function uuid(value: unknown): asserts value is string {
	if (typeof value !== "string" || !COMPANY_COMPUTER_UUID.test(value)) throw new Error("INVALID_BROWSER_PROFILE_ID");
}
function version(value: unknown, minimum = 1): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error("INVALID_BROWSER_PROFILE_VERSION");
}
function label(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!value ||
		[...value].length > 80 ||
		value.startsWith(" ") ||
		value.endsWith(" ") ||
		/[\x00-\x1f\x7f-\x9f]/.test(value)
	)
		throw new Error("INVALID_BROWSER_PROFILE_LABEL");
}
function profile(value: unknown): MemberBrowserProfile {
	const row = record(value, "activeStaffAgentId,label,prepared,profileId,version");
	if (row.activeStaffAgentId !== null) uuid(row.activeStaffAgentId);
	uuid(row.profileId);
	label(row.label);
	version(row.version);
	if (typeof row.prepared !== "boolean") throw new Error("INVALID_BROWSER_PROFILE_RESPONSE");
	return {
		profileId: row.profileId,
		label: row.label,
		version: row.version,
		prepared: row.prepared,
		activeStaffAgentId: row.activeStaffAgentId as string | null,
	};
}

/** Owner-authenticated metadata and consent only. Browser preparation and
 * passwords remain in the private runtime surface; no read grants input. */
export class CloudCompanyComputerBrowserProfiles {
	readonly #scope: CompanyComputerScope;
	readonly #memberId: string;
	readonly #rpc: CloudCompanyComputerBrowserProfilesRpc;
	constructor(options: {
		scope: CompanyComputerScope;
		memberId: string;
		rpc: CloudCompanyComputerBrowserProfilesRpc;
	}) {
		record(options.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(options.scope, options.scope);
		uuid(options.memberId);
		this.#scope = Object.freeze({ ...options.scope });
		this.#memberId = options.memberId;
		this.#rpc = options.rpc;
	}
	async #request(
		method: Parameters<CloudCompanyComputerBrowserProfilesRpc>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		try {
			const response = await companyComputerRequest((s) => this.#rpc(method, structuredClone(args), s), signal);
			if (!response || response.error) throw new Error("unconfirmed");
			return response.data;
		} catch {
			throw new Error("BROWSER_PROFILE_UNCONFIRMED_REFRESH_STATUS");
		}
	}
	#owner(value: Record<string, unknown>): void {
		record(value.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(value.scope as unknown as CompanyComputerScope, this.#scope);
		if (value.memberId !== this.#memberId) throw new Error("BROWSER_PROFILE_OWNER_CHANGED");
	}
	async catalog(signal: AbortSignal, after: string | null = null): Promise<MemberBrowserProfileCatalog> {
		if (after !== null) uuid(after);
		const value = record(
			await this.#request("qorpera_member_browser_profiles", { p_scope: this.#scope, p_after: after }, signal),
			"canUse,memberId,nextAfter,profiles,scope",
		);
		this.#owner(value);
		if (typeof value.canUse !== "boolean" || !Array.isArray(value.profiles) || value.profiles.length > 50)
			throw new Error("INVALID_BROWSER_PROFILE_RESPONSE");
		let previous = after;
		const profiles = value.profiles.map((input) => {
			const row = profile(input);
			if (previous !== null && row.profileId <= previous) throw new Error("INVALID_BROWSER_PROFILE_CURSOR");
			previous = row.profileId;
			return row;
		});
		if (value.nextAfter !== null && (profiles.length !== 50 || value.nextAfter !== previous))
			throw new Error("INVALID_BROWSER_PROFILE_CURSOR");
		return {
			scope: { ...this.#scope },
			memberId: this.#memberId,
			canUse: value.canUse,
			profiles,
			nextAfter: value.nextAfter as string | null,
		};
	}
	async register(profileId: string, name: string, signal: AbortSignal): Promise<MemberBrowserProfile> {
		uuid(profileId);
		label(name);
		const row = profile(
			await this.#request(
				"qorpera_create_member_browser_profile",
				{ p_scope: this.#scope, p_profile_id: profileId, p_label: name },
				signal,
			),
		);
		if (row.profileId !== profileId || row.label !== name) throw new Error("BROWSER_PROFILE_CHANGED");
		return row;
	}
	async grantStatus(profileId: string, staffAgentId: string, signal: AbortSignal): Promise<MemberBrowserGrantStatus> {
		uuid(profileId);
		uuid(staffAgentId);
		const value = record(
			await this.#request(
				"qorpera_member_browser_grant_status",
				{ p_scope: this.#scope, p_profile_id: profileId, p_staff_agent_id: staffAgentId },
				signal,
			),
			"grant,memberId,profile,scope,staffAgentId",
		);
		this.#owner(value);
		const owned = profile(value.profile);
		if (owned.profileId !== profileId || value.staffAgentId !== staffAgentId)
			throw new Error("BROWSER_PROFILE_CHANGED");
		let grant: MemberBrowserGrantStatus["grant"] = null;
		if (value.grant !== null) {
			const row = record(value.grant, "grantId,profileVersion,state,usable,version");
			uuid(row.grantId);
			version(row.version);
			version(row.profileVersion);
			if (
				(row.state !== "active" && row.state !== "revoked") ||
				typeof row.usable !== "boolean" ||
				(row.usable && (row.state !== "active" || row.profileVersion !== owned.version || !owned.prepared))
			)
				throw new Error("INVALID_BROWSER_GRANT_RESPONSE");
			grant = {
				grantId: row.grantId,
				version: row.version,
				profileVersion: row.profileVersion,
				state: row.state,
				usable: row.usable,
			};
		}
		return { scope: { ...this.#scope }, memberId: this.#memberId, staffAgentId, profile: owned, grant };
	}
	async configure(
		input: {
			profileId: string;
			profileVersion: number;
			staffAgentId: string;
			expectedVersion: number;
			enabled: boolean;
		},
		signal: AbortSignal,
	): Promise<MemberBrowserGrantChange> {
		record(input, "enabled,expectedVersion,profileId,profileVersion,staffAgentId");
		input = { ...input };
		uuid(input.profileId);
		uuid(input.staffAgentId);
		version(input.profileVersion);
		version(input.expectedVersion, 0);
		if (typeof input.enabled !== "boolean" || input.expectedVersion === Number.MAX_SAFE_INTEGER)
			throw new Error("INVALID_BROWSER_GRANT_REQUEST");
		const value = record(
			await this.#request(
				"qorpera_set_runtime_browser_grant",
				{
					p_scope: this.#scope,
					p_profile_id: input.profileId,
					p_profile_version: input.profileVersion,
					p_staff_agent_id: input.staffAgentId,
					p_expected_version: input.expectedVersion,
					p_enabled: input.enabled,
				},
				signal,
			),
			"drains,grantId,profileId,state,version",
		);
		uuid(value.grantId);
		if (
			value.profileId !== input.profileId ||
			value.version !== input.expectedVersion + 1 ||
			value.state !== (input.enabled ? "active" : "revoked") ||
			!Array.isArray(value.drains) ||
			value.drains.length > 32
		)
			throw new Error("BROWSER_GRANT_CHANGED");
		const seen = new Set<string>();
		const drains = value.drains.map((inputDrain) => {
			const drain = record(inputDrain, "binding,drainId,epoch,state");
			uuid(drain.drainId);
			version(drain.epoch);
			record(
				drain.binding,
				"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
			);
			const binding = drain.binding as unknown as CompanyComputerScreenBinding;
			assertCompanyComputerScope(binding, this.#scope);
			assertCompanyComputerScreenBinding(binding, binding);
			if (drain.state !== "draining" || binding.staffAgentId !== input.staffAgentId || seen.has(binding.screenId))
				throw new Error("BROWSER_GRANT_DRAIN_CHANGED");
			seen.add(binding.screenId);
			return { state: "draining" as const, drainId: drain.drainId, epoch: drain.epoch, binding: { ...binding } };
		});
		return {
			profileId: input.profileId,
			grantId: value.grantId,
			version: value.version as number,
			state: value.state as "active" | "revoked",
			drains,
		};
	}
}
