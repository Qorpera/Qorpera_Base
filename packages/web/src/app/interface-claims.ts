import { osPath } from "@qorpera/cloud-client/company-state-files";
import { parseTableFile, splitCsv, type TableFile } from "@qorpera/cloud-client/interfaces";
import { invalid, readStateFile, type WebMemberFolder } from "../cloud/company-folder-writes.ts";
import type { WebConnectors } from "../cloud/connectors.ts";
import type { CompanyDatabases } from "./company-data.ts";
import type { DataAskSend } from "./data-ask.ts";
import type { MailboxManage } from "./views/mailbox.ts";

export interface InterfaceWrites {
	/** The calls behind the Mailbox's Addresses: the company's mail addresses and its Digital Post key. */
	readonly mailManage?: () => MailboxManage;
	/** The company's connections, for the Bank page's Connect the bank: its sign-in and whether it is connected. */
	readonly bankConnection?: () => Pick<WebConnectors, "list" | "beginSignIn" | "finishSignIn">;
	readonly data?: () => CompanyDatabases | undefined;
	readonly dataAsk?: DataAskSend;
}

/** A rewrite's `locate` for `QorperaOS/tables/<table>/rows.csv`. The definition is read again on every try and handed
 * to `found`, so the rows are always parsed against the current one; a definition that doesn't parse is refused with
 * its problems. */
export function rowsLocator(
	folder: WebMemberFolder,
	table: string,
	failure: string,
	signal: AbortSignal,
	found: (definition: TableFile) => void,
): () => Promise<string | null> {
	return async () => {
		const read = await readStateFile(folder, osPath(`tables/${table}/table.toml`), signal);
		if (read === null) return null;
		const parsed = parseTableFile(read.text);
		if (!parsed.ok)
			throw invalid(
				failure,
				parsed.problems.map((problem) => problem.message),
			);
		found(parsed.file);
		return osPath(`tables/${table}/rows.csv`);
	};
}

/** `text` with the `column` field of its `index`th row set to `value`, and every other byte as it was: the typed
 * values are only for the checks, so writing them back can't round a number or reword a time in another row. The rows
 * parsed without problems, so each line that isn't blank is one of them, in order. A first line that leaves the column
 * out gets it at its end, and every row an empty field for it. */
export function withCell(text: string, index: number, name: string, value: string): string {
	// A byte-order mark the file starts with stays.
	const mark = text.startsWith("\ufeff") ? "\ufeff" : "";
	const body = text.slice(mark.length);
	const { records } = splitCsv(body);
	const lineStarts = [0];
	for (let at = body.indexOf("\n"); at >= 0; at = body.indexOf("\n", at + 1)) lineStarts.push(at + 1);
	const startOf = (place: number) => {
		const record = records[place];
		return record === undefined ? body.length : (lineStarts[record.line - 1] ?? body.length);
	};
	const column = records[0]?.fields.indexOf(name) ?? -1;
	let row = -1;
	const lines = records.map((record, place) => {
		const raw = body.slice(startOf(place), startOf(place + 1));
		const end = /\r?\n$/.exec(raw)?.[0] ?? "";
		const line = raw.slice(0, raw.length - end.length);
		if (place === 0) return column < 0 ? `${line},${csvText(name)}${end}` : raw;
		if (record.fields.length === 1 && record.fields[0] === "") return raw;
		row += 1;
		if (row !== index) return column < 0 ? `${line},${end}` : raw;
		if (column < 0) return `${line},${csvText(value)}${end}`;
		const [from, to] = fieldSpans(line)[column] ?? [line.length, line.length];
		return `${line.slice(0, from)}${csvText(value)}${line.slice(to)}${end}`;
	});
	return `${mark}${lines.join("")}`;
}

/** Where each field of one well-formed CSV record starts and ends in its text. */
function fieldSpans(record: string): [number, number][] {
	const spans: [number, number][] = [];
	let from = 0;
	let quoted = false;
	for (let at = 0; at < record.length; at++) {
		// A doubled quote inside a quoted field turns `quoted` off and on again.
		if (record[at] === '"') quoted = !quoted;
		else if (record[at] === "," && !quoted) {
			spans.push([from, at]);
			from = at + 1;
		}
	}
	spans.push([from, record.length]);
	return spans;
}

/** A field's text as CSV writes it, quoted when it must be. */
const csvText = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
