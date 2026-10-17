import type { TableValue } from "@qorpera/cloud-client/interfaces";
import type { Cloud } from "./client.ts";
import { parseInterfaceKey } from "./interface-offers.ts";
import { array, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Supervision consents (Interfaces step I9b; migration 20260928549360_interface_supervision,
 * supabase/CLIENT-CONTRACT.md "Supervision consent"). A member supervises an area's agents by consent: the platform
 * makes one when their own save puts them in a row of `tables/areas`' `supervisor` cell, and keeps it as its own
 * record. A cell that names a member with no live consent waits for theirs. */

export const INTERFACE_SUPERVISION_STATES = ["live", "withdrawn", "released", "gone", "left"] as const;
export type InterfaceSupervisionState = (typeof INTERFACE_SUPERVISION_STATES)[number];

export interface MemberInterfaceSupervision {
	readonly id: string;
	/** The areas table's id. */
	readonly table: string;
	/** Its folder now (`tables/areas`). */
	readonly folder: string | null;
	/** The row's typed key, as the client's table parse gives it; null once the consent ended. */
	readonly key: readonly TableValue[] | null;
	/** The supervising member. */
	readonly user: string;
	readonly state: InterfaceSupervisionState;
	readonly at: string;
	readonly endedAt: string | null;
}

export interface MemberInterfaceSupervisions {
	readonly supervisions: readonly MemberInterfaceSupervision[];
	/** More than 500 are live: the newest 500 came. */
	readonly truncated: boolean;
}

/** A consent made (or the live one), or why not, in words to show. */
export type InterfaceSupervisionAnswer =
	| { readonly ok: true; readonly supervision: MemberInterfaceSupervision }
	| { readonly ok: false; readonly reason: string; readonly message: string };

/** The three calls, for one company. */
export interface InterfaceSupervisionCalls {
	list(): Promise<MemberInterfaceSupervisions>;
	/** The member the row's `supervisor` cell names consents again. */
	consent(key: readonly TableValue[]): Promise<InterfaceSupervisionAnswer>;
	/** The member ends their live consent; the cell keeps naming them. */
	withdraw(supervision: string): Promise<void>;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
	value === null || value === undefined ? null : parse(value);

export function parseInterfaceSupervision(value: unknown): MemberInterfaceSupervision {
	const item = record(value, "supervision");
	return {
		id: uuid(item.id, "supervision id"),
		table: uuid(item.table, "supervision table"),
		folder: nullable(item.folder, (folder) => nonEmptyString(folder, "supervision folder")),
		key: nullable(item.key, (key) => parseInterfaceKey(key, "supervision key")),
		user: uuid(item.user, "supervision member"),
		state: oneOf(item.state, INTERFACE_SUPERVISION_STATES, "supervision state"),
		at: timestamp(item.at, "supervision time"),
		endedAt: nullable(item.endedAt, (at) => timestamp(at, "supervision end")),
	};
}

export function parseInterfaceSupervisions(value: unknown): MemberInterfaceSupervisions {
	const input = record(value, "supervisions");
	if (input.schema !== "qorpera.member-interface-supervisions/v1" || typeof input.truncated !== "boolean")
		throw new CloudShapeError("supervisions");
	return {
		supervisions: array(input.supervisions, "supervisions").map(parseInterfaceSupervision),
		truncated: input.truncated,
	};
}

export function parseInterfaceSupervisionAnswer(value: unknown): InterfaceSupervisionAnswer {
	const input = record(value, "supervision answer");
	if (input.schema !== "qorpera.interface-supervision/v1") throw new CloudShapeError("supervision answer");
	if (input.ok === true) return { ok: true, supervision: parseInterfaceSupervision(input.supervision) };
	if (input.ok !== false) throw new CloudShapeError("supervision answer");
	return {
		ok: false,
		reason: nonEmptyString(input.reason, "supervision refusal"),
		message: nonEmptyString(input.message, "supervision refusal"),
	};
}

export function interfaceSupervisionCalls(cloud: Cloud, environmentId: string): InterfaceSupervisionCalls {
	return {
		list: async () =>
			parseInterfaceSupervisions(
				await cloud.rpc("qorpera_member_interface_supervisions", { p_environment_id: environmentId }),
			),
		consent: async (key) =>
			parseInterfaceSupervisionAnswer(
				await cloud.rpc("qorpera_consent_interface_supervision", {
					p_environment_id: environmentId,
					p_request: { key },
				}),
			),
		withdraw: async (supervision) => {
			const answer = parseInterfaceSupervisionAnswer(
				await cloud.rpc("qorpera_withdraw_interface_supervision", {
					p_environment_id: environmentId,
					p_supervision: supervision,
				}),
			);
			if (!answer.ok) throw new CloudShapeError("supervision answer");
		},
	};
}
