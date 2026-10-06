/* The `mail` and `mail_addresses` sources (RUNTIME-INTERFACES.md §4; Interfaces step I5c), read from the company's
 * mail as app/company-mail.ts keeps it. They are sources only once that read is open: a page that names them is not
 * drawn before.
 *
 * A `mail` block reads the list its view asks for: a view's or a block's `where` that names one `state` or one
 * `address` asks the threads call for just those (the call filters by them itself); any other column (`direction`,
 * `unread`, ...) is filtered here, on the threads read, as a table's columns are. */

import type { InterfaceQuery, TableRow } from "@qorpera/cloud-client/interfaces";
import type { MailThreadState, MailThreadSummary } from "../cloud/mail.ts";
import type { CompanyController } from "./company.ts";
import type { MailList, MailListRequest } from "./company-mail.ts";
import { mailListKey } from "./company-mail.ts";
import type { InterfaceRow } from "./interfaces.ts";

export const MAIL_SOURCES: Readonly<
	Record<string, { readonly columns: readonly string[]; readonly time: string | null }>
> = {
	mail: {
		columns: [
			"thread",
			"address",
			"from_name",
			"from_address",
			"subject",
			"last_at",
			"state",
			"handled_by",
			"direction",
			"unread",
		],
		time: "last_at",
	},
	// `handled_by` lists the agents that handle the address; `routine` names the routines that read it.
	mail_addresses: { columns: ["address", "handled_by", "routine", "last_7_days"], time: null },
};

const STATES: readonly MailThreadState[] = ["new", "handled", "waiting"];

export function isMailSource(source: string): boolean {
	return Object.hasOwn(MAIL_SOURCES, source);
}

/** A mail source's columns, once the company's mail is read; undefined before, or for another source. */
export function mailSource(
	company: CompanyController,
	source: string,
): { readonly columns: readonly string[]; readonly time: string | null } | undefined {
	if (!isMailSource(source) || company.store.get().mail === undefined) return undefined;
	return MAIL_SOURCES[source];
}

/** The one value every `where` gives a column, when they all give the same single text; else none. */
function single(wheres: readonly NonNullable<InterfaceQuery["where"]>[], column: string): string | undefined {
	const values = new Set<unknown>();
	for (const where of wheres) if (Object.hasOwn(where, column)) values.add(where[column]);
	const [value] = values;
	return values.size === 1 && typeof value === "string" ? value : undefined;
}

/** The list a `mail` block reads: the threads call's own filters from its view's and its own `where`. */
export function mailRequest(
	narrow: readonly NonNullable<InterfaceQuery["where"]>[],
	where: InterfaceQuery["where"],
): MailListRequest {
	const wheres = where ? [...narrow, where] : narrow;
	const state = single(wheres, "state");
	const address = single(wheres, "address");
	return {
		...(address?.trim() ? { address } : {}),
		...(state !== undefined && (STATES as readonly string[]).includes(state)
			? { state: state as MailThreadState }
			: {}),
	};
}

/** A thread as a `mail` row. Account mail has no subject (the call keeps it back); nothing else is left out. */
export function mailRow(item: MailThreadSummary): TableRow {
	return {
		thread: item.thread,
		address: item.address,
		from_name: item.fromName ?? null,
		from_address: item.fromAddress ?? null,
		subject: item.account ? null : (item.subject ?? null),
		last_at: item.lastAt,
		state: item.state,
		handled_by: item.handledBy?.staffAgentId ?? null,
		direction: item.direction,
		unread: item.unread,
	};
}

const rowKey = (thread: string) => `mail:${thread}`;

/** The read of the list a request names, or undefined while it is being read. */
export function mailList(company: CompanyController, request: MailListRequest): MailList | undefined {
	return company.store.get().mail?.lists[mailListKey(request)];
}

/** The `mail` rows of the list a request names, newest first, as far as its pages are read. */
export function mailRows(company: CompanyController, request: MailListRequest = {}): InterfaceRow[] | undefined {
	if (company.store.get().mail === undefined) return undefined;
	return (mailList(company, request)?.threads ?? []).map((item) => ({ row: mailRow(item), key: rowKey(item.thread) }));
}

/** The rows of a mail source, or undefined for another source or before the company's mail is read. `mail` is its
 * whole list here; a `mail` block reads the list its view names (`mailRows`). */
export function mailSourceRows(company: CompanyController, source: string): InterfaceRow[] | undefined {
	const mail = company.store.get().mail;
	if (!isMailSource(source) || mail === undefined) return undefined;
	if (source === "mail") return mailRows(company);
	return mail.addresses.map((address) => ({
		row: {
			address: address.address,
			handled_by: address.handledBy.map((agent) => agent.staffAgentId),
			routine: address.routines.length ? address.routines.map((routine) => routine.title).join(", ") : null,
			last_7_days: address.last7Days,
		},
		key: `mail_addresses:${address.address}`,
	}));
}

/** A thread's summary from any list read, newest read first. */
export function mailSummary(company: CompanyController, thread: string): MailThreadSummary | undefined {
	for (const list of Object.values(company.store.get().mail?.lists ?? {})) {
		const found = list.threads.find((item) => item.thread === thread);
		if (found) return found;
	}
	return undefined;
}

/** The row an opened `mail` block shows when its view's list no longer holds it (a waiting send answered in the
 * "Waiting for you" view): the thread from another list, or just its id. The block reads the thread itself. */
export function openedMailRow(company: CompanyController, key: string): InterfaceRow | undefined {
	if (!key.startsWith("mail:")) return undefined;
	const thread = key.slice("mail:".length);
	const found = mailSummary(company, thread);
	return { row: found ? mailRow(found) : { thread }, key };
}

/** The thread a `mail` row names. */
export function rowThread(row: TableRow): string | undefined {
	return typeof row.thread === "string" ? row.thread : undefined;
}
