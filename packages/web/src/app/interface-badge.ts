import { queryInterfaceRows } from "@qorpera/cloud-client/interface-query";
import type { InterfaceFile, TableRow } from "@qorpera/cloud-client/interfaces";
import type { CompanyController } from "./company.ts";
import { rowInstant } from "./interface-sources.ts";
import { interfaceSource } from "./interfaces.ts";

/** The company's waiting mail sends as `waiting` rows, their times to the second as every row's are. */
function mailWaitingRows(company: CompanyController): TableRow[] {
	return (company.store.get().mail?.waiting ?? []).map((item) => ({
		id: item.reviewId,
		kind: "mail",
		title: item.subject ?? null,
		from: item.staffAgent?.staffAgentId ?? null,
		due: rowInstant(item.createdAt),
	}));
}

/** The badge's count, or 0 when the page has none or its source can't be read. */
export function interfaceBadge(company: CompanyController, file: InterfaceFile): number {
	const badge = file.badge;
	if (!badge) return 0;
	const source = interfaceSource(company, badge.from);
	if (!source?.readable) return 0;
	const rows = badge.from === "waiting" ? mailWaitingRows(company) : [];
	const now = Date.now();
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	return queryInterfaceRows(rows, badge.query, { time: source.time, clock: { now, startOfToday: today.getTime() } })
		.length;
}
