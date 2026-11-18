/* The `mail` and `mail_addresses` sources (RUNTIME-INTERFACES.md §4; Interfaces step I5c), read from the company's
 * mail as app/company-mail.ts keeps it. They are sources only once that read is open: a page that names them is not
 * drawn before. */

import type { TableRow } from "@qorpera/cloud-client/interfaces";
import type { MailThreadSummary } from "../cloud/mail.ts";
import type { CompanyController } from "./company.ts";
import type { MailList, MailListRequest } from "./company-mail.ts";
import { mailListKey } from "./company-mail.ts";
import { rowInstant } from "./interface-sources.ts";
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

/** A thread as a `mail` row. Account mail has no subject (the call keeps it back); nothing else is left out. Its time
 * is to the second, as every row's is (`rowInstant`): the cloud's `…09:00:00.123456+00:00` is a time `since` can't
 * read. */
export function mailRow(item: MailThreadSummary): TableRow {
	return {
		thread: item.thread,
		address: item.address,
		from_name: item.fromName ?? null,
		from_address: item.fromAddress ?? null,
		subject: item.account ? null : (item.subject ?? null),
		last_at: rowInstant(item.lastAt) ?? item.lastAt,
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
function mailRows(company: CompanyController, request: MailListRequest = {}): InterfaceRow[] | undefined {
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

/** Whether a thread is account mail (A1), as far as it is read: its summary or its read says so. The cloud takes no
 * quote of it (`qorpera_check_member_quotes`), as it shows none of its words. */
export function isAccountMail(company: CompanyController, thread: string): boolean {
	if (mailSummary(company, thread)?.account) return true;
	const read = company.store.get().mail?.threads[thread];
	return (
		read?.status === "ready" &&
		read.thread.messages.some((message) => message.kind === "received" && message.account !== undefined)
	);
}
