import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CloudMemberCompanyComputerClient,
	type MemberAgentMachines,
	type MemberDesktopHandBack,
	type MemberDesktopHold,
	type MemberDesktopHoldName,
} from "@qorpera/cloud-client/cloud-member-company-computer";
import { isUuid } from "@qorpera/contracts";
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
	/** Takes a desktop over, or takes this member's own hold over again (migration 20260930713000), at this member's
	 * hand-back `epoch` for the machine as the page knows it: accepted only at the current one. `press` is the id this
	 * page minted for the press (F26); the answer names the hold's seat. */
	takeDesktop(machineId: string, epoch: number, press: string, signal: AbortSignal): Promise<MemberDesktopHold> {
		return this.client.takeDesktop(machineId, epoch, press, signal);
	}
	/** The window's heartbeat: until when this member's hold taken under `epoch` in the seat `seat` lasts now, or null
	 * when there is none. */
	keepDesktop(machineId: string, epoch: number, seat: number, signal: AbortSignal): Promise<string | null> {
		return this.client.keepDesktop(machineId, epoch, seat, signal);
	}
	/** Hands this member's hold named by `hold` (its seat, or the press that may have seated it) back at their hand-back
	 * `epoch` (by their word, or as their window closes): the current epoch afterwards, and whether they hold the
	 * machine now, in which seat. */
	handBackDesktop(
		machineId: string,
		reason: "handed_back" | "closed",
		epoch: number,
		hold: MemberDesktopHoldName,
		signal: AbortSignal,
	): Promise<MemberDesktopHandBack> {
		return this.client.handBackDesktop(machineId, reason, epoch, hold, signal);
	}
	/** Best effort, as the page goes (it is hidden for good, or the company's page is left): hands this member's hold of
	 * a desktop named by `hold` back at `epoch`, with the token the page last used, in a request the browser finishes
	 * after the page is gone (keepalive). It never throws and waits for nothing; a hold it does not reach runs out by
	 * itself in 5 minutes. */
	handBackOnLeave(machineId: string, epoch: number, hold: MemberDesktopHoldName): void {
		const token = this.#lastToken;
		const seat = hold.seat;
		const press = hold.press;
		if (
			!token ||
			!isUuid(machineId) ||
			!Number.isSafeInteger(epoch) ||
			epoch < 0 ||
			(seat === undefined && press === undefined) ||
			(seat !== undefined && (!Number.isSafeInteger(seat) || seat < 0)) ||
			(press !== undefined && !isUuid(press))
		)
			return;
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
						body: JSON.stringify({
							p_profile_id: this.#companyId,
							p_machine_id: machineId,
							p_reason: "closed",
							p_epoch: epoch,
							p_seat: seat ?? null,
							p_press: press ?? null,
						}),
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
