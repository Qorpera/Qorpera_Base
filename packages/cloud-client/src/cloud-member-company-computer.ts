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
}
export interface MemberAgentMachineControl {
	mine: boolean;
	name: string;
	until: string;
	/** The caller's take-over attempt that holds it (review r3 of #1661): the caller's own hold alone, else null. */
	attempt: string | null;
}
/** A take-over's answer (migration 20260930713000): the caller holds the desktop until `until`, or why not. */
export type MemberDesktopHold =
	| { state: "ok"; until: string }
	| {
			state: "refused";
			reason:
				| "DESKTOP_MACHINE_TOO_SMALL"
				| "MACHINE_NOT_RUNNING"
				| "MACHINE_NEEDS_COMPANY_VIEW"
				| "DESKTOP_MEMBER_IN_CONTROL"
				// The attempt was called off by a hand-back that named it: it holds nothing, ever (review r3).
				| "TAKE_CALLED_OFF"
				// The attempt's time is more than 2 minutes from the database's clock: it never takes (review r4).
				| "TAKE_EXPIRED";
			memberName: string | null;
	  };
/** The most take-over attempts one hand-back calls off (the database's own limit). */
export const DESKTOP_ATTEMPTS_MAX = 32;
const HOLD_REFUSALS = [
	"DESKTOP_MACHINE_TOO_SMALL",
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"TAKE_CALLED_OFF",
	"TAKE_EXPIRED",
] as const;
export interface MemberAgentMachines {
	/** Owners, admins and contributors may wake a sleeping machine; viewers may only watch. */
	canWake: boolean;
	/** Owners, admins and contributors may take a desktop over; viewers may only watch (false from a database before
	 * take-over, 20260930713000). */
	canTakeOver: boolean;
	/** At most 20: running ones first, then the ones the agent drove most recently, then the newest. */
	machines: MemberAgentMachine[];
	/** The database's time when it answered (review r4 of #1661): the page makes its take-over attempts' times by it.
	 * Null from a database before it. */
	serverNow: string | null;
}
/** A hand-back's answer: whether it gave a lease of the caller's back, and whether the caller still holds the machine by
 * a take-over attempt it did not name (another tab of theirs, or an earlier page). */
export interface MemberDesktopHandBack {
	handedBack: boolean;
	heldElsewhere: boolean;
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
				(row.waitingFor !== null && row.waitingFor !== "hours" && row.waitingFor !== "room")
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
					(held.attempt !== undefined &&
						held.attempt !== null &&
						(!held.mine || typeof held.attempt !== "string" || !COMPANY_COMPUTER_UUID.test(held.attempt)))
				)
					throw new Error(invalid);
				control = {
					mine: held.mine,
					name: held.name,
					until: held.until,
					attempt: typeof held.attempt === "string" ? held.attempt : null,
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
			};
		});
		if (new Set(machines.map((machine) => machine.machineId)).size !== machines.length) throw new Error(invalid);
		if (value.canTakeOver !== undefined && typeof value.canTakeOver !== "boolean") throw new Error(invalid);
		if (value.serverNow !== undefined && value.serverNow !== null && !text(value.serverNow, 64))
			throw new Error(invalid);
		return {
			canWake: value.canWake,
			canTakeOver: value.canTakeOver === true,
			machines,
			serverNow: typeof value.serverNow === "string" ? value.serverNow : null,
		};
	}
	/** Takes the machine's desktop over for the caller (qorpera_member_take_machine_desktop, 20260930713000), or renews
	 * the caller's own hold: until when, or why not (another member's hold names them). `attempt` is the caller's own uuid
	 * for this take-over; a hand-back that names it calls it off for good (TAKE_CALLED_OFF). */
	async takeDesktop(machineId: string, attempt: string, signal: AbortSignal): Promise<MemberDesktopHold> {
		if (!COMPANY_COMPUTER_UUID.test(attempt)) throw new Error("Invalid take-over attempt");
		const value = await this.#desktop(
			"qorpera_member_take_machine_desktop",
			machineId,
			{ p_attempt_id: attempt },
			signal,
		);
		if (
			value.state === "ok" &&
			Object.keys(value).sort().join() === "schema,state,until" &&
			typeof value.until === "string"
		)
			return { state: "ok", until: value.until };
		if (
			value.state === "refused" &&
			HOLD_REFUSALS.includes(value.reason as (typeof HOLD_REFUSALS)[number]) &&
			(value.memberName === undefined || typeof value.memberName === "string")
		)
			return {
				state: "refused",
				reason: value.reason as (typeof HOLD_REFUSALS)[number],
				memberName: (value.memberName as string | undefined) ?? null,
			};
		throw new Error("Invalid desktop hold");
	}
	/** The window's heartbeat (qorpera_member_keep_machine_desktop): the caller's hold renewed until when, or null when
	 * that attempt holds it no more. */
	async keepDesktop(machineId: string, attempt: string, signal: AbortSignal): Promise<string | null> {
		if (!COMPANY_COMPUTER_UUID.test(attempt)) throw new Error("Invalid take-over attempt");
		const value = await this.#desktop(
			"qorpera_member_keep_machine_desktop",
			machineId,
			{ p_attempt_id: attempt },
			signal,
		);
		if (value.state === "ok" && typeof value.until === "string") return value.until;
		if (value.state === "ended") return null;
		throw new Error("Invalid desktop hold");
	}
	/** Calls off for good each take-over attempt named (at most 32) and gives back the caller's lease when one of them
	 * holds it (qorpera_member_hand_back_machine_desktop): `handed_back` by their word, `closed` when the window closed
	 * or the page is left. Its answer means none of those attempts holds the machine or ever will; it says whether a
	 * lease was given back, and whether the caller still holds the machine by an attempt it did not name. */
	async handBackDesktop(
		machineId: string,
		reason: "handed_back" | "closed",
		attempts: readonly string[],
		signal: AbortSignal,
	): Promise<MemberDesktopHandBack> {
		if (attempts.length > DESKTOP_ATTEMPTS_MAX || attempts.some((attempt) => !COMPANY_COMPUTER_UUID.test(attempt)))
			throw new Error("Invalid take-over attempts");
		const value = await this.#desktop(
			"qorpera_member_hand_back_machine_desktop",
			machineId,
			{ p_reason: reason, p_attempt_ids: [...attempts] },
			signal,
		);
		if (
			value.state === "ok" &&
			typeof value.handedBack === "boolean" &&
			(value.heldElsewhere === undefined || typeof value.heldElsewhere === "boolean")
		)
			return { handedBack: value.handedBack, heldElsewhere: value.heldElsewhere === true };
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
