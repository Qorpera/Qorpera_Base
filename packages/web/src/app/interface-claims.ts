import {
	parseTableFile,
	parseTableRows,
	type TableFile,
	tableClaimProblems,
	tableRowKey,
	writeTableRows,
} from "@qorpera/cloud-client/interfaces";
import { invalid, readStateFile, rewriteStateFile, type WebMemberFolder } from "../cloud/company-folder-writes.ts";
import { t } from "../ui/preferences.ts";

/* A board's take and release (Interfaces step I9a; deploy/first-node/RUNTIME-INTERFACES.md §3.3 and §5): a member puts
 * their own id in a card's empty holder cell, or clears the cell that names them. The rows file is read and parsed
 * against the table's current definition, only that cell changes, the claim rule is checked here before anything is
 * sent, and the write names the version it read. When the file changed in between it is read and checked again: a
 * cell someone else took meanwhile, or that stopped being the member's, ends the claim with that said. */

/** What a page needs to write: the member's own client for the company's folder, and a check that the company is still
 * the one the page was drawn for. */
export interface InterfaceWrites {
	readonly folder: () => WebMemberFolder;
	readonly current: () => void;
}

/** The cell is not what the card showed any more: someone else took it, or it stopped being the member's. Nothing was
 * written. */
export class ClaimLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaimLostError";
	}
}

export type ClaimVerb = "take" | "release";

/** Takes or releases one row's holder cell in `tables/<table>/rows.csv`. Answers whether it wrote: false when the cell
 * already says it. Throws `ClaimLostError` when the cell changed under the card, and a refusal
 * (`WebCompanyFolderRejectedError`) with the problems when the rows or the claim don't pass. */
export async function claimTableCell(options: {
	readonly folder: WebMemberFolder;
	readonly table: string;
	/** The row's key, as `tableRowKey` writes it. */
	readonly key: string;
	readonly verb: ClaimVerb;
	readonly memberId: string;
	readonly signal: AbortSignal;
	readonly check: () => void;
}): Promise<boolean> {
	const { folder, table, verb, memberId, signal } = options;
	const failure = verb === "take" ? t("The card could not be taken.") : t("The card could not be released.");
	let definition: TableFile | null = null;
	return await rewriteStateFile(
		folder,
		{
			// The definition is read again on every try, so the rows are always parsed against the current one.
			locate: async () => {
				const read = await readStateFile(folder, `tables/${table}/table.toml`, signal);
				if (read === null) return null;
				const parsed = parseTableFile(read.text);
				if (!parsed.ok)
					throw invalid(
						failure,
						parsed.problems.map((problem) => problem.message),
					);
				definition = parsed.file;
				return `tables/${table}/rows.csv`;
			},
			rewrite: (text) => rewriteRows(definition, table, text, options.key, verb, memberId, failure),
			key: () => `web:board-${verb}:${crypto.randomUUID()}`,
			gone: t("This card is no longer here."),
			failure,
		},
		signal,
		options.check,
	);
}

/** The rows file with one cell changed, or null when it already says it. */
function rewriteRows(
	definition: TableFile | null,
	table: string,
	text: string,
	key: string,
	verb: ClaimVerb,
	memberId: string,
	failure: string,
): string | null {
	const holder = definition?.holder ?? null;
	if (definition === null || holder === null || !definition.columns.some((column) => column.name === holder))
		throw new ClaimLostError(t("That changed while you were looking."));
	// Rows that don't fit the definition would be lost by writing the ones that do, so the claim waits for them to be
	// fixed.
	const parsed = parseTableRows(definition, text);
	if (!parsed.readable || parsed.problems.length > 0)
		throw invalid(
			failure,
			parsed.problems.map((problem) => problem.message),
		);
	const index = parsed.rows.findIndex((row) => tableRowKey(definition, row) === key);
	const row = parsed.rows[index];
	if (row === undefined) throw new ClaimLostError(t("This card is no longer here."));
	const was = row[holder] ?? null;
	if (verb === "take") {
		if (was === memberId) return null;
		if (was !== null) throw new ClaimLostError(t("Someone else took it first."));
	} else if (was !== memberId) throw new ClaimLostError(t("That changed while you were looking."));
	const after = parsed.rows.map((each, place) =>
		place === index ? { ...each, [holder]: verb === "take" ? memberId : null } : each,
	);
	const problems = tableClaimProblems(definition, parsed.rows, after, { kind: "member", memberId }, { folder: table });
	if (problems.length > 0)
		throw invalid(
			failure,
			problems.map((problem) => problem.message),
		);
	const written = writeTableRows(definition, after);
	// A byte-order mark the file starts with stays.
	return text.startsWith("﻿") ? `﻿${written}` : written;
}
