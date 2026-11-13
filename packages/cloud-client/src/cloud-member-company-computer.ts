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
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

export interface MemberCompanyComputerCatalog {
	companyId: string;
	environmentId: string;
	canManage: boolean;
	scope: CompanyComputerScope | null;
	staff: { staffAgentId: string; name: string }[];
	nextAfter: string | null;
}
/** Where an agent's screen is, or would go (migration 20260928237200). */
export type MemberAgentComputerPlacement =
	| "screen"
	| "room"
	| "starting"
	| "stopped"
	| "unstarted"
	| "new"
	/** The agent's computer access was revoked on every computer of the company. */
	| "denied"
	| "none";
export interface MemberAgentComputer {
	canManage: boolean;
	/** The company's computers that are not retired. */
	computers: number;
	placement: MemberAgentComputerPlacement;
	/** Null when no computer can take the agent now (every one full and only an owner or admin may add one, or none at all). */
	computer: {
		scope: CompanyComputerScope;
		number: number;
		/** Why a started computer is not up yet: its host is being prepared, the servers have no room, or
		 * the company is out of computer hours (a sleeping computer then waits too). */
		waiting: CompanyComputerWait | null;
	} | null;
}
/** Why a started computer is not up yet (migration 20260928237200; 'hours' since 20260929720000). */
export type CompanyComputerWait = "setup" | "room" | "hours";
const WAITS: readonly CompanyComputerWait[] = ["setup", "room", "hours"];
const PLACEMENTS: readonly MemberAgentComputerPlacement[] = [
	"screen",
	"room",
	"starting",
	"stopped",
	"unstarted",
	"new",
	"denied",
	"none",
];
/** Where one of an agent's machines stands (qorpera_company_machine_state): on its way up while `starting` (placed)
 * or `waiting` (for room or computer hours), on, going to sleep, or asleep. */
export type MemberAgentMachineState = "running" | "starting" | "waiting" | "stopping" | "stopped";
const MACHINE_STATES: readonly MemberAgentMachineState[] = ["running", "starting", "waiting", "stopping", "stopped"];
/** One of an agent's machines, as a member's computer window lists it (migration 20260930712000): one the agent started
 * or whose screen it drove last. Nothing of where it runs. */
export interface MemberAgentMachine {
	machineId: string;
	name: string;
	purpose: string;
	state: MemberAgentMachineState;
	lifetime: "task" | "always-on";
	/** Big enough for a desktop (2 processors, 4 GiB): a machine without one has no screen to show. */
	desktopCapable: boolean;
	startedByAgent: boolean;
	/** When an agent last drove its screen, and that agent's name (null: never). */
	screenUsedAt: string | null;
	screenAgentName: string | null;
	/** Why a machine that wants to run waits: the company's computer hours, or room on the servers. */
	waitingFor: "hours" | "room" | null;
	/** The member who holds its desktop now (migration 20260930713000): the caller (`mine`) or another, by name, and
	 * when the hold runs out unless renewed; null when no one holds it (or a database before take-over). */
	control: MemberAgentMachineControl | null;
	/** The caller's own hand-back epoch for the machine (review r5 of #1661): a take-over is accepted only at it, and only
	 * the database moves it (0 when never handed back, or from a database before it). */
	epoch: number;
	/** The other members who acted on the desktop they share with the agent in the last minute, by name
	 * (20260930734000); never the caller. Empty when none (or from a database before shared control). */
	others: string[];
	/** The desktop's lease generation (20260930738000): a number that moves at every seating of a member and every
	 * hand-back that ends a lease. Each shared action carries the one its input was made under, and SQL refuses it once
	 * that moved. Null for a viewer, and from a database before it. */
	generation: number | null;
}
export interface MemberAgentMachineControl {
	mine: boolean;
	name: string;
	until: string;
	/** The hand-back epoch the caller's own hold was taken under (review r5 of #1661); null for another member's. */
	epoch: number | null;
	/** The seat of the caller's own hold (F26 of #1661): a number the database gives each seating of a member on the
	 * desktop, so two holds of the caller under one epoch (a lease that ran out and was taken again, another tab's
	 * take-over) are told apart; null for another member's. */
	seat: number | null;
	/** The id of the take-over request that seated the caller's own hold (F26), for a page to recognise a hold its own
	 * press made when that press's answer was lost; never authority. Null for another member's. */
	press: string | null;
}
/** A take-over's answer (migration 20260930713000): the caller holds the desktop until `until`, in the seat `seat`
 * (F26: everything done as holder names it beside the epoch), or why not. */
export type MemberDesktopHold =
	| { state: "ok"; until: string; seat: number }
	| {
			state: "refused";
			reason:
				| "DESKTOP_MACHINE_TOO_SMALL"
				| "MACHINE_NOT_RUNNING"
				| "MACHINE_NEEDS_COMPANY_VIEW"
				| "DESKTOP_MEMBER_IN_CONTROL"
				// Sent at an epoch that is not the caller's current one: a hand-back moved it on (review r5).
				| "TAKE_CALLED_OFF";
			memberName: string | null;
			/** The caller's current hand-back epoch, with TAKE_CALLED_OFF; null otherwise. */
			epoch: number | null;
	  };
const HOLD_REFUSALS = [
	"DESKTOP_MACHINE_TOO_SMALL",
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"TAKE_CALLED_OFF",
] as const;
/** A hand-back epoch as the database answers it. */
function epochOf(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export interface MemberAgentMachines {
	/** Owners, admins and contributors may wake a sleeping machine; viewers may only watch. */
	canWake: boolean;
	/** Owners, admins and contributors may take a desktop over; viewers may only watch (false from a database before
	 * take-over, 20260930713000). */
	canTakeOver: boolean;
	/** At most 20: running ones first, then the ones the agent drove most recently, then the newest. */
	machines: MemberAgentMachine[];
}
/** Why a member's start of a computer for an agent made none (migration 20260930730000): the agent is off staff or
 * deleted, one was made for it less than a minute ago, no server could ever hold a desktop computer, or no node runs
 * machines yet. Out of computer hours or no room now are no refusal: the computer is made and waits, as any. */
export const MEMBER_AGENT_COMPUTER_REFUSALS = [
	"AGENT_UNAVAILABLE",
	"START_TOO_SOON",
	"MACHINE_TOO_LARGE",
	"MACHINES_UNAVAILABLE",
] as const;
export type MemberAgentComputerRefusal = (typeof MEMBER_AGENT_COMPUTER_REFUSALS)[number];
/** A member's start of a computer for an agent: the computer made now, or the agent's own one big enough for a desktop
 * (made nothing new), or why none was made. */
export type MemberAgentComputerStart =
	| { kind: "started" | "existing"; machineId: string; name: string; state: string }
	| { kind: "refused"; reason: MemberAgentComputerRefusal };
/** A hand-back's answer (review r5 of #1661, F26): whether it gave a live lease of the caller's back, the caller's
 * current epoch for the machine, and whether the caller holds the machine now (another tab of theirs, at that epoch)
 * and, if so, that hold's seat. Once an epoch above e came, nothing taken or sent at e or earlier holds the desktop or
 * ever will. */
export interface MemberDesktopHandBack {
	handedBack: boolean;
	epoch: number;
	holding: boolean;
	seat: number | null;
}

function field(value: unknown, error: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
	return value as Record<string, unknown>;
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid Company Computer response");
	return value as Record<string, unknown>;
}
interface Options {
	companyId: string;
	environmentId: string;
	supabaseUrl: string;
	publishableKey: string;
	accessToken: (signal: AbortSignal) => Promise<string>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

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
		options: { missing?: true } = {},
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
				if (options.missing && response.status === 404) {
					// A backend that predates this function (PostgREST: no such function): the caller falls back.
					const body = new TextDecoder("utf-8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 64 * 1024, deadline),
					);
					let code: unknown;
					try {
						code = (JSON.parse(body) as { code?: unknown } | null)?.code;
					} catch {
						code = undefined;
					}
					if (code !== "PGRST202") throw new Error("Company Computer access is unavailable");
					return { data: undefined, error: null };
				}
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
	/** The computer that shows this agent's screen: where it is, or where it would go.
	 * `undefined` when the backend predates several computers per company; then
	 * the catalog's one computer is the agent's. */
	async agentComputer(staffAgentId: string, signal: AbortSignal): Promise<MemberAgentComputer | undefined> {
		if (!COMPANY_COMPUTER_UUID.test(staffAgentId)) throw new Error("Invalid Company Computer agent");
		const { data } = await this.#rpc(
			"qorpera_member_agent_office",
			{ p_environment_id: this.#options.environmentId, p_staff_agent_id: staffAgentId },
			signal,
			{ missing: true },
		);
		if (data === undefined) return undefined;
		const value = record(data, "canManage,companyId,computer,computers,environmentId,placement,staffAgentId");
		if (
			value.companyId !== this.#options.companyId ||
			value.environmentId !== this.#options.environmentId ||
			value.staffAgentId !== staffAgentId ||
			typeof value.canManage !== "boolean" ||
			!Number.isSafeInteger(value.computers) ||
			(value.computers as number) < 0 ||
			!PLACEMENTS.includes(value.placement as MemberAgentComputerPlacement)
		)
			throw new Error("Invalid Company Computer placement");
		let computer: MemberAgentComputer["computer"] = null;
		if (value.computer !== null) {
			const row = record(value.computer, "number,scope,waiting");
			if (
				!Number.isSafeInteger(row.number) ||
				(row.number as number) < 1 ||
				(row.waiting !== null && !WAITS.includes(row.waiting as CompanyComputerWait))
			)
				throw new Error("Invalid Company Computer placement");
			computer = {
				scope: this.#scope(row.scope as CompanyComputerScope),
				number: row.number as number,
				waiting: row.waiting as CompanyComputerWait | null,
			};
		}
		return {
			canManage: value.canManage,
			computers: value.computers as number,
			placement: value.placement as MemberAgentComputerPlacement,
			computer,
		};
	}
	/** An agent's machines for the computer window (qorpera_list_agent_machines, migration 20260930712000). Fields this
	 * client does not know are ignored, so the database may add some first. */
	async agentMachines(staffAgentId: string, signal: AbortSignal): Promise<MemberAgentMachines> {
		if (!COMPANY_COMPUTER_UUID.test(staffAgentId)) throw new Error("Invalid agent machines request");
		const invalid = "Invalid agent machines";
		const value = field(
			(
				await this.#rpc(
					"qorpera_list_agent_machines",
					{ p_profile_id: this.#options.companyId, p_staff_agent_id: staffAgentId },
					signal,
				)
			).data,
			invalid,
		);
		if (
			value.schema !== "qorpera.agent-machines/v1" ||
			value.profileId !== this.#options.companyId ||
			value.staffAgentId !== staffAgentId ||
			typeof value.canWake !== "boolean" ||
			!Array.isArray(value.machines) ||
			value.machines.length > 20
		)
			throw new Error(invalid);
		const text = (input: unknown, max: number): input is string =>
			typeof input === "string" && input.length > 0 && [...input].length <= max;
		const machines = value.machines.map((input): MemberAgentMachine => {
			const row = field(input, invalid);
			if (
				typeof row.machineId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(row.machineId) ||
				!text(row.name, 40) ||
				!text(row.purpose, 300) ||
				!MACHINE_STATES.includes(row.state as MemberAgentMachineState) ||
				(row.lifetime !== "task" && row.lifetime !== "always-on") ||
				typeof row.desktopCapable !== "boolean" ||
				typeof row.startedByAgent !== "boolean" ||
				(row.screenUsedAt !== null && !text(row.screenUsedAt, 64)) ||
				(row.screenAgentName !== null && !text(row.screenAgentName, 160)) ||
				(row.waitingFor !== null && row.waitingFor !== "hours" && row.waitingFor !== "room") ||
				(row.epoch !== undefined && !epochOf(row.epoch)) ||
				// The other members using the shared desktop (20260930734000); absent before shared control.
				(row.others !== undefined &&
					(!Array.isArray(row.others) ||
						row.others.length > 50 ||
						!row.others.every((name) => text(name, 256)))) ||
				// The desktop's lease generation (20260930738000); absent (or null) for a viewer and before it.
				(row.generation !== undefined && row.generation !== null && !epochOf(row.generation))
			)
				throw new Error(invalid);
			// Who holds the desktop (20260930713000); absent before the take-over migration.
			let control: MemberAgentMachineControl | null = null;
			if (row.control !== undefined && row.control !== null) {
				const held = field(row.control, invalid);
				if (
					typeof held.mine !== "boolean" ||
					!text(held.name, 256) ||
					!text(held.until, 64) ||
					(held.epoch !== undefined && held.epoch !== null && (!held.mine || !epochOf(held.epoch))) ||
					(held.seat !== undefined && held.seat !== null && (!held.mine || !epochOf(held.seat))) ||
					(held.press !== undefined &&
						held.press !== null &&
						(!held.mine || typeof held.press !== "string" || !COMPANY_COMPUTER_UUID.test(held.press)))
				)
					throw new Error(invalid);
				control = {
					mine: held.mine,
					name: held.name,
					until: held.until,
					epoch: epochOf(held.epoch) ? held.epoch : null,
					seat: epochOf(held.seat) ? held.seat : null,
					press: typeof held.press === "string" ? held.press : null,
				};
			}
			return {
				machineId: row.machineId,
				name: row.name,
				purpose: row.purpose,
				state: row.state as MemberAgentMachineState,
				lifetime: row.lifetime,
				desktopCapable: row.desktopCapable,
				startedByAgent: row.startedByAgent,
				screenUsedAt: row.screenUsedAt as string | null,
				screenAgentName: row.screenAgentName as string | null,
				waitingFor: row.waitingFor as "hours" | "room" | null,
				control,
				epoch: epochOf(row.epoch) ? row.epoch : 0,
				others: Array.isArray(row.others) ? [...(row.others as string[])] : [],
				generation: epochOf(row.generation) ? row.generation : null,
			};
		});
		if (new Set(machines.map((machine) => machine.machineId)).size !== machines.length) throw new Error(invalid);
		if (value.canTakeOver !== undefined && typeof value.canTakeOver !== "boolean") throw new Error(invalid);
		return { canWake: value.canWake, canTakeOver: value.canTakeOver === true, machines };
	}
	/** Takes the machine's desktop over for the caller (qorpera_member_take_machine_desktop, 20260930713000), or takes
	 * the caller's own hold over again (a new seat: the hold seated before ends for its page): until when and the seat,
	 * or why not (another member's hold names them). It is sent at the caller's hand-back epoch for the machine as the
	 * page knows it, and accepted only at the current one (TAKE_CALLED_OFF with the current one otherwise). `press` is
	 * an id the page mints for this request (F26): the hold remembers it, and the list shows it beside the caller's own
	 * hold, for recognition only. */
	async takeDesktop(machineId: string, epoch: number, press: string, signal: AbortSignal): Promise<MemberDesktopHold> {
		if (!epochOf(epoch)) throw new Error("Invalid hand-back epoch");
		if (!COMPANY_COMPUTER_UUID.test(press)) throw new Error("Invalid take-over press");
		const value = await this.#desktop(
			"qorpera_member_take_machine_desktop",
			machineId,
			{ p_epoch: epoch, p_press: press },
			signal,
		);
		if (
			value.state === "ok" &&
			Object.keys(value).sort().join() === "schema,seat,state,until" &&
			typeof value.until === "string" &&
			epochOf(value.seat)
		)
			return { state: "ok", until: value.until, seat: value.seat };
		if (
			value.state === "refused" &&
			HOLD_REFUSALS.includes(value.reason as (typeof HOLD_REFUSALS)[number]) &&
			(value.memberName === undefined || typeof value.memberName === "string") &&
			(value.reason === "TAKE_CALLED_OFF" ? epochOf(value.epoch) : value.epoch === undefined)
		)
			return {
				state: "refused",
				reason: value.reason as (typeof HOLD_REFUSALS)[number],
				memberName: (value.memberName as string | undefined) ?? null,
				epoch: epochOf(value.epoch) ? value.epoch : null,
			};
		throw new Error("Invalid desktop hold");
	}
	/** The window's heartbeat (qorpera_member_keep_machine_desktop): the caller's hold taken under `epoch` in the seat
	 * `seat` renewed until when, or null when there is none (F26: another seat of the caller's is none). */
	async keepDesktop(machineId: string, epoch: number, seat: number, signal: AbortSignal): Promise<string | null> {
		if (!epochOf(epoch)) throw new Error("Invalid hand-back epoch");
		if (!epochOf(seat)) throw new Error("Invalid desktop seat");
		const value = await this.#desktop(
			"qorpera_member_keep_machine_desktop",
			machineId,
			{ p_epoch: epoch, p_seat: seat },
			signal,
		);
		if (value.state === "ok" && typeof value.until === "string") return value.until;
		if (value.state === "ended") return null;
		throw new Error("Invalid desktop hold");
	}
	/** Hands the machine back at the caller's hand-back epoch `epoch` (qorpera_member_hand_back_machine_desktop):
	 * `handed_back` by their word, `closed` when the window closed or the page is left; in one of two forms (F27, F28 of
	 * #1661). EXACT, `seat` a number: the caller's lease under `epoch` in that seat ends, if it is the lease, and the
	 * epoch moves on only when no live lease of the caller's is left (a stale tab's hand-back never ends another tab's
	 * hold); a page sends it only when every take-over it sent for the machine at that epoch was answered. VOID, `seat`
	 * null: at the current epoch the epoch moves on and the caller's lease under it ends, whichever seat (another tab's
	 * too); it is what voids a take-over of the page's that may still be on its way. At an older epoch neither changes
	 * anything. */
	async handBackDesktop(
		machineId: string,
		reason: "handed_back" | "closed",
		epoch: number,
		seat: number | null,
		signal: AbortSignal,
	): Promise<MemberDesktopHandBack> {
		if (!epochOf(epoch)) throw new Error("Invalid hand-back epoch");
		if (seat !== null && !epochOf(seat)) throw new Error("Invalid desktop seat");
		const value = await this.#desktop(
			"qorpera_member_hand_back_machine_desktop",
			machineId,
			{ p_reason: reason, p_epoch: epoch, p_seat: seat },
			signal,
		);
		if (
			value.state === "ok" &&
			typeof value.handedBack === "boolean" &&
			epochOf(value.epoch) &&
			typeof value.holding === "boolean" &&
			(value.holding ? epochOf(value.seat) : value.seat === null)
		)
			return {
				handedBack: value.handedBack,
				epoch: value.epoch,
				holding: value.holding,
				seat: value.holding ? (value.seat as number) : null,
			};
		throw new Error("Invalid desktop hand-back");
	}
	async #desktop(
		method: string,
		machineId: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (!COMPANY_COMPUTER_UUID.test(machineId)) throw new Error("Invalid machine");
		const value = field(
			(await this.#rpc(method, { p_profile_id: this.#options.companyId, p_machine_id: machineId, ...args }, signal))
				.data,
			"Invalid desktop hold",
		);
		if (value.schema !== "qorpera.member-machine-desktop/v1") throw new Error("Invalid desktop hold");
		return value;
	}
	/** Wakes a sleeping machine of the company (qorpera_member_manage_company_machine 'start'): it takes its place in
	 * line, and the nodes give it room. Owners, admins and contributors only; the database refuses anyone else. */
	async wakeMachine(machineId: string, signal: AbortSignal): Promise<void> {
		if (!COMPANY_COMPUTER_UUID.test(machineId)) throw new Error("Invalid machine");
		const value = field(
			(
				await this.#rpc(
					"qorpera_member_manage_company_machine",
					{ p_profile_id: this.#options.companyId, p_machine_id: machineId, p_action: "start" },
					signal,
				)
			).data,
			"Invalid machine wake",
		);
		if (value.machineId !== machineId) throw new Error("Invalid machine wake");
	}
	/** Starts a desktop computer for an agent that has none (qorpera_member_start_agent_computer, migration 20260930730000):
	 * one machine as the agent's own machine_start with desktop true and its defaults makes it, or the agent's existing one.
	 * Owners, admins and contributors only; the database refuses anyone else. */
	async startAgentComputer(staffAgentId: string, signal: AbortSignal): Promise<MemberAgentComputerStart> {
		if (!COMPANY_COMPUTER_UUID.test(staffAgentId)) throw new Error("Invalid agent");
		const value = field(
			(
				await this.#rpc(
					"qorpera_member_start_agent_computer",
					{ p_profile_id: this.#options.companyId, p_staff_agent_id: staffAgentId },
					signal,
				)
			).data,
			"Invalid computer start",
		);
		if (value.schema !== "qorpera.member-agent-computer/v1") throw new Error("Invalid computer start");
		if (value.state === "refused") {
			record(value, "reason,schema,state");
			if (!(MEMBER_AGENT_COMPUTER_REFUSALS as readonly unknown[]).includes(value.reason))
				throw new Error("Invalid computer start");
			return { kind: "refused", reason: value.reason as MemberAgentComputerRefusal };
		}
		record(value, "machine,schema,state");
		const machine = field(value.machine, "Invalid computer start");
		record(machine, "machineId,name,state");
		if (
			(value.state !== "started" && value.state !== "existing") ||
			typeof machine.machineId !== "string" ||
			!COMPANY_COMPUTER_UUID.test(machine.machineId) ||
			typeof machine.name !== "string" ||
			!/^[a-z0-9][a-z0-9-]{0,39}$/.test(machine.name) ||
			typeof machine.state !== "string" ||
			!/^[a-z]{1,20}$/.test(machine.state)
		)
			throw new Error("Invalid computer start");
		return { kind: value.state, machineId: machine.machineId, name: machine.name, state: machine.state };
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
