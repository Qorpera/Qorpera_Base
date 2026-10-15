import type { TableValue } from "@qorpera/cloud-client/interfaces";
import type { Cloud } from "./client.ts";
import { array, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Offers of a claimed cell (Interfaces step I9c; migration 20260928509110_interface_offers, supabase/CLIENT-CONTRACT.md
 * "Offers of a claimed cell"). A member offers a `needs_yes` member cell of a table to another member. The platform
 * keeps the offer; the file changes only when the member it names saves themselves into the cell. */

export const INTERFACE_OFFER_STATES = ["open", "accepted", "declined", "withdrawn", "lapsed"] as const;
export type InterfaceOfferState = (typeof INTERFACE_OFFER_STATES)[number];

export interface MemberInterfaceOffer {
	readonly id: string;
	/** The table's id, which follows the table through a move. */
	readonly table: string;
	/** The table's folder now (`tables/<name>`). */
	readonly folder: string | null;
	/** The row's typed key, as the client's table parse gives it; null once the offer is closed. */
	readonly key: readonly TableValue[] | null;
	/** The cell's column; null once the offer is closed. */
	readonly column: string | null;
	readonly from: string;
	/** The cell as the offer read it: its holder, or null for an empty cell. */
	readonly was: string | null;
	readonly to: string;
	readonly state: InterfaceOfferState;
	/** The agent offered to an area's supervisor, to add to the area's agents (I9b, migration
	 * 20260930372000_interface_supervision_agents); null for a cell's offer. */
	readonly agent: string | null;
	readonly at: string;
}

export interface MemberInterfaceOffers {
	readonly offers: readonly MemberInterfaceOffer[];
	/** More than 500 are open: the newest 500 came. */
	readonly truncated: boolean;
}

export interface InterfaceOfferRequest {
	readonly table: string;
	readonly key: readonly TableValue[];
	readonly column: string;
	readonly was: string | null;
	readonly to: string;
}

/** An offer made (or the one already open for that cell and member), or why not, in words to show. */
export type InterfaceOfferAnswer =
	| { readonly ok: true; readonly offer: MemberInterfaceOffer }
	| { readonly ok: false; readonly reason: string; readonly message: string };

/** The four calls, for one company. */
export interface InterfaceOfferCalls {
	list(): Promise<MemberInterfaceOffers>;
	offer(request: InterfaceOfferRequest): Promise<InterfaceOfferAnswer>;
	decline(offer: string): Promise<void>;
	withdraw(offer: string): Promise<void>;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
	value === null || value === undefined ? null : parse(value);

/** A row's typed key, as the client's table parse gives it. */
export function parseInterfaceKey(value: unknown, label: string): TableValue[] {
	return array(value, label).map((item): TableValue => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (Array.isArray(item) && item.every((each) => typeof each === "string")) return item as string[];
		throw new CloudShapeError(label);
	});
}

export function parseInterfaceOffer(value: unknown): MemberInterfaceOffer {
	const item = record(value, "offer");
	return {
		id: uuid(item.id, "offer id"),
		// The table's id as its table.md gives it: a lowercase uuid (interfaces.ts `table.id`), as the database prints it.
		table: uuid(item.table, "offer table"),
		folder: nullable(item.folder, (folder) => nonEmptyString(folder, "offer folder")),
		key: nullable(item.key, (key) => parseInterfaceKey(key, "offer key")),
		column: nullable(item.column, (column) => nonEmptyString(column, "offer column", 200)),
		from: uuid(item.from, "offer from"),
		was: nullable(item.was, (was) => uuid(was, "offer cell")),
		to: uuid(item.to, "offer to"),
		state: oneOf(item.state, INTERFACE_OFFER_STATES, "offer state"),
		agent: nullable(item.agent, (agent) => uuid(agent, "offer agent")),
		at: timestamp(item.at, "offer time"),
	};
}

export function parseInterfaceOffers(value: unknown): MemberInterfaceOffers {
	const input = record(value, "offers");
	if (input.schema !== "qorpera.member-interface-offers/v1" || typeof input.truncated !== "boolean")
		throw new CloudShapeError("offers");
	return { offers: array(input.offers, "offers").map(parseInterfaceOffer), truncated: input.truncated };
}

export function parseInterfaceOfferAnswer(value: unknown): InterfaceOfferAnswer {
	const input = record(value, "offer answer");
	if (input.schema !== "qorpera.interface-offer/v1") throw new CloudShapeError("offer answer");
	if (input.ok === true) return { ok: true, offer: parseInterfaceOffer(input.offer) };
	if (input.ok !== false) throw new CloudShapeError("offer answer");
	return {
		ok: false,
		reason: nonEmptyString(input.reason, "offer refusal"),
		message: nonEmptyString(input.message, "offer refusal"),
	};
}

export function interfaceOfferCalls(cloud: Cloud, environmentId: string): InterfaceOfferCalls {
	const close = async (name: string, offer: string) => {
		const input = record(await cloud.rpc(name, { p_environment_id: environmentId, p_offer: offer }), "offer answer");
		if (input.schema !== "qorpera.interface-offer/v1" || input.ok !== true) throw new CloudShapeError("offer answer");
	};
	return {
		list: async () =>
			parseInterfaceOffers(await cloud.rpc("qorpera_member_interface_offers", { p_environment_id: environmentId })),
		offer: async (request) =>
			parseInterfaceOfferAnswer(
				await cloud.rpc("qorpera_offer_interface_cell", {
					p_environment_id: environmentId,
					p_request: {
						table: request.table,
						key: request.key,
						column: request.column,
						was: request.was,
						to: request.to,
					},
				}),
			),
		decline: (offer) => close("qorpera_decline_interface_offer", offer),
		withdraw: (offer) => close("qorpera_withdraw_interface_offer", offer),
	};
}
