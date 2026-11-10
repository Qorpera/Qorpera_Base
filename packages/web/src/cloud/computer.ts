import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CloudMemberCompanyComputerClient,
	type MemberAgentMachines,
	type MemberDesktopHold,
} from "@qorpera/cloud-client/cloud-member-company-computer";
import type { Cloud } from "./client.ts";
import { memberRouteTarget } from "./deployment-config.ts";
import { createWebMachineScreens, type WebMachineScreens } from "./machine-screens.ts";
import type { HostedProfile } from "./types.ts";

/** Member-only transport. Every request rechecks the account and company
 * lifetime, including after an asynchronous token refresh. */
export class WebCompanyComputer {
	readonly client: CloudMemberCompanyComputerClient;
	readonly canRequestWake: boolean;
	/** Looks at an agent's desktop through the member bridge (migration 20260930712000). */
	readonly screens: WebMachineScreens;
	readonly #cloud: Cloud;
	readonly #memberId: string;
	readonly #companyId: string;
	readonly #current: () => void;
	/** The member's token this page last used (in memory only): a hand-back as the page goes cannot wait for a fresh one. */
	#lastToken: string | null = null;
	constructor(cloud: Cloud, profile: HostedProfile, memberId: string, signal: AbortSignal, current: () => void) {
		this.canRequestWake = ["owner", "admin", "contributor"].includes(profile.role);
		this.#cloud = cloud;
		this.#memberId = memberId;
		this.#companyId = profile.profileId;
		this.#current = () => {
			signal.throwIfAborted();
			current();
		};
		const accessToken = async (requestSignal: AbortSignal) => {
			this.#current();
			requestSignal.throwIfAborted();
			const { data, error } = await cloud.supabase.auth.getSession();
			this.#current();
			requestSignal.throwIfAborted();
			if (error || !data.session || data.session.user.id !== memberId)
				throw new Error("Sign in again to open this computer.");
			this.#lastToken = data.session.access_token;
			return data.session.access_token;
		};
		const fetching = async (input: RequestInfo | URL, init?: RequestInit) => {
			this.#current();
			const response = await globalThis.fetch(input, {
				...init,
				signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
			});
			try {
				this.#current();
			} catch (error) {
				void response.body?.cancel().catch(() => undefined);
				throw error;
			}
			return response;
		};
		this.screens = createWebMachineScreens({
			companyId: profile.profileId,
			objectGatewayUrl: cloud.config.objectGatewayUrl,
			route: (url) => memberRouteTarget(cloud.config, url),
			accessToken,
			fetch: fetching,
		});
		this.client = new CloudMemberCompanyComputerClient({
			companyId: profile.profileId,
			environmentId: profile.environmentId,
			supabaseUrl: cloud.config.projectUrl,
			publishableKey: cloud.config.publishableKey,
			accessToken,
			fetch: fetching,
		});
	}
	/** An agent's machines for its computer window, and whether this member may wake one. */
	agentMachines(staffAgentId: string, signal: AbortSignal): Promise<MemberAgentMachines> {
		return this.client.agentMachines(staffAgentId, signal);
	}
	/** Wakes a sleeping machine (owners, admins and contributors). */
	wakeMachine(machineId: string, signal: AbortSignal): Promise<void> {
		return this.client.wakeMachine(machineId, signal);
	}
	/** Takes a desktop over, or renews this member's hold (migration 20260930713000). */
	takeDesktop(machineId: string, signal: AbortSignal): Promise<MemberDesktopHold> {
		return this.client.takeDesktop(machineId, signal);
	}
	/** The window's heartbeat: until when this member holds the desktop now, or null when they hold it no more. */
	keepDesktop(machineId: string, signal: AbortSignal): Promise<string | null> {
		return this.client.keepDesktop(machineId, signal);
	}
	/** Gives this member's hold back: by their word, or as their window closes. */
	handBackDesktop(machineId: string, reason: "handed_back" | "closed", signal: AbortSignal): Promise<boolean> {
		return this.client.handBackDesktop(machineId, reason, signal);
	}
	/** Best effort, as the page goes (it is hidden for good, or the company's page is left): gives this member's hold of
	 * a desktop back with the token the page last used, in a request the browser finishes after the page is gone
	 * (keepalive). It never throws and waits for nothing; a hold it does not reach runs out by itself in 5 minutes. */
	handBackOnLeave(machineId: string): void {
		const token = this.#lastToken;
		if (!token || !/^[0-9a-f-]{36}$/i.test(machineId)) return;
		try {
			void globalThis
				.fetch(
					`${new URL(this.#cloud.config.projectUrl).origin}/rest/v1/rpc/qorpera_member_hand_back_machine_desktop`,
					{
						method: "POST",
						keepalive: true,
						redirect: "error",
						credentials: "omit",
						cache: "no-store",
						headers: {
							authorization: `Bearer ${token}`,
							apikey: this.#cloud.config.publishableKey,
							"content-type": "application/json",
						},
						body: JSON.stringify({ p_profile_id: this.#companyId, p_machine_id: machineId, p_reason: "closed" }),
					},
				)
				.catch(() => undefined);
		} catch {
			// The page is going: nothing more to do.
		}
	}
	views(scope: CompanyComputerScope) {
		this.#current();
		const origin = this.#cloud.config.officeViewerOrigin;
		if (!origin) throw new Error("Screen viewing is not configured.");
		return this.client.views(scope, this.#memberId, `${origin}/office/${scope.companyComputerId}/view`);
	}
}
