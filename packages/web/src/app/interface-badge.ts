/* An interface's badge on its rail row (RUNTIME-INTERFACES.md §3 `badge`): how many rows of its source its query
 * keeps. For the `waiting` source those are Pulse's rows and the company's mail sends that wait for a person (the
 * member mail read's waiting call, step I5a), as rows of kind `mail`. The `waiting` source's own rows never hold mail:
 * an agent whose send waits is already there as a `review` row, the way Pulse lists it, so nothing is counted twice
 * under one kind. */

import { queryInterfaceRows } from "@qorpera/cloud-client/interface-query";
import type { InterfaceFile, TableRow } from "@qorpera/cloud-client/interfaces";
import type { CompanyController } from "./company.ts";
import { interfaceRows, interfaceSource } from "./interfaces.ts";

/** The company's waiting mail sends as `waiting` rows. */
export function mailWaitingRows(company: CompanyController): TableRow[] {
	return (company.store.get().mail?.waiting ?? []).map((item) => ({
		id: item.reviewId,
		kind: "mail",
		title: item.subject ?? null,
		from: item.staffAgent?.staffAgentId ?? null,
		due: item.createdAt,
	}));
}

/** The badge's count, or 0 when the page has none or its source can't be read. */
export function interfaceBadge(company: CompanyController, file: InterfaceFile): number {
	const badge = file.badge;
	if (!badge) return 0;
	const source = interfaceSource(company, badge.from);
	if (!source?.readable) return 0;
	const rows = (interfaceRows(company, badge.from) ?? []).map((item) => item.row);
	if (badge.from === "waiting") rows.push(...mailWaitingRows(company));
	const now = Date.now();
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	return queryInterfaceRows(rows, badge.query, { time: source.time, clock: { now, startOfToday: today.getTime() } })
		.length;
}
