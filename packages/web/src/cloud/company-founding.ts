import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* The founding table (migration 20260928248200): friends take seats, write their roles, connect
 * their own ChatGPT account and press Ready; one Start makes every founder at the table an owner.
 * The server decides everything; the client never grants ownership or starts an agent itself. */

export const FOUNDING_VISION_MAX_BYTES = 16384;
export const FOUNDING_ROLE_MAX_CHARACTERS = 300;
export const FOUNDING_NAME_MAX_CHARACTERS = 120;
export const FOUNDING_MAX_SEATS = 8;

export interface FounderSeat {
	userId: string;
	displayName: string;
	state: "invited" | "joined";
	role: string;
	invitedByUserId: string | null;
	/** Ready for the table as it is now. */
	ready: boolean;
	/** Their own ChatGPT account can pay for their work in this company. */
	modelLoginReady: boolean;
	creator: boolean;
}

export interface CompanyFounding {
	profileId: string;
	companyName: string;
	vision: string;
	phase: "open" | "started";
	revision: number;
	createdByUserId: string;
	seats: FounderSeat[];
	/** Joined founders Start still waits for. */
	waitingFor: string[];
	me: {
		userId: string;
		state: "invited" | "joined" | null;
		canEdit: boolean;
		canManage: boolean;
		canStart: boolean;
	};
	start: { startedAt: string; startedByUserId: string | null; revision: number; companyReady: boolean } | null;
}

export interface FoundingTableEntry {
	profileId: string;
	companyName: string;
	phase: "open" | "started";
	myState: "invited" | "joined";
	invitedByDisplayName: string | null;
	joined: number;
}

function flag(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new CloudShapeError(label);
	return value;
}

function text(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maxBytes)
		throw new CloudShapeError(label);
	return value;
}

function revision(value: unknown): number {
	return boundedInteger(value, "table revision", 1, Number.MAX_SAFE_INTEGER);
}

export function parseCompanyFounding(value: unknown): CompanyFounding {
	const input = record(value, "founding table");
	if (input.schema !== "qorpera.company-founding/v1") throw new CloudShapeError("founding table schema");
	const seats = array(input.seats, "founder seats").map((entry): FounderSeat => {
		const seat = record(entry, "founder seat");
		return {
			userId: uuid(seat.userId, "founder id"),
			displayName: nonEmptyString(seat.displayName, "founder name", 256),
			state: oneOf(seat.state, ["invited", "joined"] as const, "seat state"),
			role: text(seat.role, "founder role", FOUNDING_ROLE_MAX_CHARACTERS * 4),
			invitedByUserId: seat.invitedByUserId === null ? null : uuid(seat.invitedByUserId, "inviter"),
			ready: flag(seat.ready, "founder ready"),
			modelLoginReady: flag(seat.modelLoginReady, "founder login"),
			creator: flag(seat.creator, "table creator"),
		};
	});
	if (new Set(seats.map((seat) => seat.userId)).size !== seats.length) throw new CloudShapeError("duplicate seat");
	const me = record(input.me, "my seat");
	const start = input.start === null ? null : record(input.start, "table start");
	const phase = oneOf(input.phase, ["open", "started"] as const, "table phase");
	if ((phase === "started") !== (start !== null)) throw new CloudShapeError("table start");
	return {
		profileId: uuid(input.profileId, "company id"),
		companyName: nonEmptyString(input.companyName, "company name", FOUNDING_NAME_MAX_CHARACTERS),
		vision: text(input.vision, "company vision", FOUNDING_VISION_MAX_BYTES),
		phase,
		revision: revision(input.revision),
		createdByUserId: uuid(input.createdByUserId, "table creator"),
		seats,
		waitingFor: array(input.waitingFor, "founders Start waits for").map((id) => uuid(id, "founder id")),
		me: {
			userId: uuid(me.userId, "my account"),
			state: me.state === null ? null : oneOf(me.state, ["invited", "joined"] as const, "my seat"),
			canEdit: flag(me.canEdit, "can edit"),
			canManage: flag(me.canManage, "can manage"),
			canStart: flag(me.canStart, "can start"),
		},
		start: start
			? {
					startedAt: timestamp(start.startedAt, "start time"),
					startedByUserId: start.startedByUserId === null ? null : uuid(start.startedByUserId, "starter"),
					revision: revision(start.revision),
					companyReady: flag(start.companyReady, "company ready"),
				}
			: null,
	};
}

export function parseFoundingTables(value: unknown): FoundingTableEntry[] {
	return array(value, "founding tables").map((entry) => {
		const table = record(entry, "founding table");
		return {
			profileId: uuid(table.profileId, "company id"),
			companyName: nonEmptyString(table.companyName, "company name", FOUNDING_NAME_MAX_CHARACTERS),
			phase: oneOf(table.phase, ["open", "started"] as const, "table phase"),
			myState: oneOf(table.myState, ["invited", "joined"] as const, "my seat"),
			invitedByDisplayName:
				table.invitedByDisplayName === null ? null : nonEmptyString(table.invitedByDisplayName, "inviter", 256),
			joined: boundedInteger(table.joined, "founders at the table", 0, FOUNDING_MAX_SEATS),
		};
	});
}

export class CompanyFoundingApi {
	readonly #cloud: Cloud;
	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}
	/** False until new companies are created on the company folder; the hub then keeps its old form. */
	async available(): Promise<boolean> {
		return flag(await this.#cloud.rpc("qorpera_company_founding_available"), "founding available");
	}
	list(): Promise<FoundingTableEntry[]> {
		return this.#cloud.rpc("qorpera_list_company_foundings").then(parseFoundingTables);
	}
	open(clientCreationId: string, companyName: string): Promise<CompanyFounding> {
		return this.#cloud
			.rpc("qorpera_open_company_founding", {
				p_client_creation_id: uuid(clientCreationId, "creation id"),
				p_company_name: companyName.trim(),
			})
			.then(parseCompanyFounding);
	}
	read(profileId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_read_company_founding", profileId);
	}
	update(profileId: string, expectedRevision: number, companyName: string, vision: string): Promise<CompanyFounding> {
		return this.#call("qorpera_update_company_founding", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_company_name: companyName.trim(),
			p_vision: vision.trim(),
		});
	}
	invite(profileId: string, friendUserId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_invite_company_founder", profileId, {
			p_friend_user_id: uuid(friendUserId, "friend"),
		});
	}
	/** Joining returns the table; declining returns nothing, since the table is no longer yours to read. */
	async respond(profileId: string, accept: boolean): Promise<CompanyFounding | null> {
		const id = uuid(profileId, "company id");
		const result = await this.#cloud.rpc("qorpera_respond_company_founding", { p_profile_id: id, p_accept: accept });
		if (accept) return this.#same(id, parseCompanyFounding(result));
		const receipt = record(result, "declined invitation");
		if (receipt.state !== "declined" || uuid(receipt.profileId, "declined company") !== id)
			throw new CloudShapeError("declined invitation");
		return null;
	}
	setRole(profileId: string, expectedRevision: number, role: string): Promise<CompanyFounding> {
		return this.#call("qorpera_set_founder_role", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_role: role.trim(),
		});
	}
	setReady(profileId: string, expectedRevision: number, ready: boolean): Promise<CompanyFounding> {
		return this.#call("qorpera_set_founder_ready", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_ready: ready,
		});
	}
	/** Someone else's seat: the table afterwards. */
	remove(profileId: string, userId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_remove_company_founder", profileId, { p_user_id: uuid(userId, "founder") });
	}
	/** Your own seat: you leave the table. */
	async leave(profileId: string, userId: string): Promise<void> {
		const id = uuid(profileId, "company id");
		const receipt = record(
			await this.#cloud.rpc("qorpera_remove_company_founder", {
				p_profile_id: id,
				p_user_id: uuid(userId, "founder"),
			}),
			"left table",
		);
		if (receipt.state !== "left" || uuid(receipt.profileId, "left company") !== id)
			throw new CloudShapeError("left table");
	}
	start(profileId: string, expectedRevision: number, clientStartId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_start_company_founding", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_client_start_id: uuid(clientStartId, "start id"),
		});
	}
	async #call(method: string, profileId: string, args: Record<string, unknown> = {}): Promise<CompanyFounding> {
		const id = uuid(profileId, "company id");
		return this.#same(id, parseCompanyFounding(await this.#cloud.rpc(method, { p_profile_id: id, ...args })));
	}
	#same(profileId: string, table: CompanyFounding): CompanyFounding {
		if (table.profileId !== profileId) throw new CloudShapeError("founding table identity");
		return table;
	}
}
