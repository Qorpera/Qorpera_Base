import type { CloudMemberFolderUnit } from "@qorpera/cloud-client/cloud-member-folder";
import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import {
	csvField,
	parseTableFile,
	parseTableRows,
	splitCsv,
	type TableFile,
	type TableRow,
	type TableValue,
	tableClaimProblems,
	tableRowKey,
} from "@qorpera/cloud-client/interfaces";
import {
	commitUnit,
	invalid,
	readStateFile,
	rewriteStateFile,
	unsaved,
	type WebMemberFolder,
} from "../cloud/company-folder-writes.ts";
import { t } from "../ui/preferences.ts";
import { ClaimLostError, rowsLocator, withCell } from "./interface-claims.ts";

/* The Members page's areas (Interfaces C6d; deploy/first-node/RUNTIME-INTERFACES.md §5.1): a member adds an area,
 * which is then theirs, and changes which agents an area has. A company whose folder has no `tables/areas/` gets it
 * with the first such change: the table's two files as founding writes them (`interfaceLibraryFiles`), in one new
 * folder, before the change itself; an areas table with no rows file yet gets one, its first line alone. Each change
 * rewrites `tables/areas/rows.csv` the way a claim does (app/interface-claims.ts): the rows are read and checked
 * against the table's current definition, the claim rule is checked here before anything is sent, and the write names
 * the version it read. When the file changed in between it is read and checked again; an area that changed meanwhile
 * ends the change with that said. */

const AREAS = "areas";
/** Tries of the first write when another writer made a folder it makes meanwhile. */
const FIRST_WRITE_TRIES = 3;
/** The byte order mark a rows file may start with, which stays where it is. */
const BOM = String.fromCharCode(0xfeff);

/** An agent the change adds is in another area by now (an agent is in one area only). Nothing was written. */
export class AgentInAreaError extends Error {
	readonly agent: string;
	constructor(agent: string) {
		super(t("That agent is in another area now."));
		this.name = "AgentInAreaError";
		this.agent = agent;
	}
}

/** What an area change needs: the member's own client for the company's folder, the member, and the company's members
 * now (a cell that names someone else counts as empty, as for a claim). */
interface AreaChange {
	readonly folder: WebMemberFolder;
	readonly memberId: string;
	readonly members?: ReadonlySet<string> | undefined;
	readonly signal: AbortSignal;
	readonly check: () => void;
}

/** Makes `tables/areas/` with the library's `table.toml` and `rows.csv`, byte for byte, when the folder has no such
 * folder; nothing else is written. Without `tables/` the one new folder is `tables`, with the table inside. A folder
 * another writer made meanwhile (`exists`) is looked for again, at most three tries in all. */
export async function ensureAreasTable(change: AreaChange, failure: string): Promise<void> {
	const { folder, signal, check } = change;
	const library = interfaceLibraryFiles(() => crypto.randomUUID());
	const files = ["table.toml", "rows.csv"].map((name) => {
		const text = library[`tables/${AREAS}/${name}`];
		if (text === undefined) throw new Error(failure);
		return { name, text };
	});
	for (let attempt = 1; ; attempt++) {
		const read = await folder.read(`tables/${AREAS}`, signal);
		check();
		if (read.entry !== null) return;
		const tables = await folder.read("tables", signal);
		check();
		const nested = tables.entry === null;
		const unit: CloudMemberFolderUnit = {
			op: "new_folder",
			path: nested ? "tables" : `tables/${AREAS}`,
			contents: [
				...(nested ? [{ path: AREAS, kind: "folder" as const }] : []),
				...files.map(({ name, text }) => ({
					path: nested ? `${AREAS}/${name}` : name,
					kind: "file" as const,
					text,
				})),
			],
		};
		const result = await commitUnit(folder, `web:areas-table:${crypto.randomUUID()}`, unit, signal);
		check();
		if (result.outcome === "saved") return;
		if (result.outcome === "conflict" && result.reason === "exists" && attempt < FIRST_WRITE_TRIES) continue;
		throw unsaved(result, failure);
	}
}

/** Makes `tables/areas/rows.csv` with its first line alone, naming the table's current columns, when the table has no
 * rows file yet (a table without one is valid and has no rows, RUNTIME-INTERFACES.md §5 "Rows"); nothing else is
 * written. A rows file another writer made meanwhile (`exists`) is the one the change then adds its row to. */
async function ensureAreaRows(change: AreaChange, failure: string): Promise<void> {
	const { folder, signal, check } = change;
	const path = `tables/${AREAS}/rows.csv`;
	const rows = await folder.read(path, signal);
	check();
	if (rows.entry !== null) return;
	const read = await readStateFile(folder, `tables/${AREAS}/table.toml`, signal);
	check();
	if (read === null) throw new Error(t("The areas are no longer here."));
	const parsed = parseTableFile(read.text);
	if (!parsed.ok)
		throw invalid(
			failure,
			parsed.problems.map((problem) => problem.message),
		);
	const text = `${parsed.file.columns.map((column) => csvField(column.name)).join(",")}\n`;
	const result = await commitUnit(
		folder,
		`web:areas-rows:${crypto.randomUUID()}`,
		{ op: "write", path, text },
		signal,
	);
	check();
	if (result.outcome === "saved" || (result.outcome === "conflict" && result.reason === "exists")) return;
	throw unsaved(result, failure);
}

/** Adds an area named `area`, with `about` when it says something, owned by the member, shared with no one, with no
 * supervisor and no agents: a row at the end of the rows file, every other byte as written. Supervision then goes
 * through the member's yes, as for an area they took. An area by that name already there ends it with that said. */
export async function addArea(change: AreaChange & { readonly area: string; readonly about: string }): Promise<void> {
	const failure = t("The area could not be added.");
	await ensureAreasTable(change, failure);
	await ensureAreaRows(change, failure);
	let definition: TableFile | null = null;
	await rewriteStateFile(
		change.folder,
		{
			locate: rowsLocator(change.folder, AREAS, failure, change.signal, (read) => {
				definition = read;
			}),
			rewrite: (text) => withArea(definition, text, change, failure),
			key: () => `web:area-add:${crypto.randomUUID()}`,
			gone: t("The areas are no longer here."),
			failure,
		},
		change.signal,
		change.check,
	);
}

/** Sets an area's agents, from those its detail showed (`shown`) to `agents`. Answers whether it wrote: false when the
 * cell already says it. Throws `ClaimLostError` when the area's agents are not the ones shown any more, and
 * `AgentInAreaError` when an agent it adds is in another area by now. */
export async function setAreaAgents(
	change: AreaChange & { readonly key: string; readonly shown: readonly string[]; readonly agents: readonly string[] },
): Promise<boolean> {
	const failure = t("The area's agents could not be changed.");
	let definition: TableFile | null = null;
	return await rewriteStateFile(
		change.folder,
		{
			locate: rowsLocator(change.folder, AREAS, failure, change.signal, (read) => {
				definition = read;
			}),
			rewrite: (text) => withAgents(definition, text, change, failure),
			key: () => `web:area-agents:${crypto.randomUUID()}`,
			gone: t("This area is no longer here."),
			failure,
		},
		change.signal,
		change.check,
	);
}

/** An `agents` cell as a list. */
export function agentList(value: TableValue | undefined): string[] {
	return Array.isArray(value) ? [...value] : [];
}

/** The rows of a rows file, refused with their problems when any row doesn't fit the definition: writing the rows
 * that do would lose the others, so the change waits for them to be fixed. */
function fittingRows(definition: TableFile, text: string, failure: string): readonly TableRow[] {
	const parsed = parseTableRows(definition, text);
	if (!parsed.readable || parsed.problems.length > 0)
		throw invalid(
			failure,
			parsed.problems.map((problem) => problem.message),
		);
	return parsed.rows;
}

/** `after`, once its rows fit and the claim rule lets the member make the change from `before`. */
function checked(
	definition: TableFile,
	before: readonly TableRow[],
	after: string,
	change: AreaChange,
	failure: string,
): string {
	const problems = tableClaimProblems(
		definition,
		before,
		fittingRows(definition, after, failure),
		{ kind: "member", memberId: change.memberId },
		{ folder: AREAS, members: change.members },
	);
	if (problems.length > 0)
		throw invalid(
			failure,
			problems.map((problem) => problem.message),
		);
	return after;
}

/** The rows file with the new area's row at its end. */
function withArea(
	definition: TableFile | null,
	text: string,
	change: AreaChange & { readonly area: string; readonly about: string },
	failure: string,
): string {
	if (definition === null) throw new ClaimLostError(t("That changed while you were looking."));
	const rows = fittingRows(definition, text, failure);
	const has = (column: string) => definition.columns.some((each) => each.name === column);
	const about = change.about.trim();
	const values: Record<string, TableValue> = {
		area: change.area.trim(),
		...(about && has("about") ? { about } : {}),
		...(has("owner") ? { owner: change.memberId } : {}),
		...(has("shared") ? { shared: false } : {}),
	};
	const key = tableRowKey(definition, values);
	if (rows.some((row) => tableRowKey(definition, row) === key))
		throw new Error(t("There is already an area called {area}.", { area: change.area.trim() }));
	// The row goes after the last one, with the file's own line ends and in its first line's column order; a column
	// that line leaves out is added to it, as a claim adds one.
	const mark = text.startsWith(BOM) ? BOM : "";
	const body = text.slice(mark.length);
	const header = splitCsv(body).records[0]?.fields ?? [];
	const end = body.includes("\r\n") ? "\r\n" : "\n";
	const line = header.map((column) => csvField(values[column] ?? null)).join(",");
	let after = `${text}${body === "" || body.endsWith("\n") ? "" : end}${line}${end}`;
	for (const [column, value] of Object.entries(values))
		if (!header.includes(column) && typeof value === "string") after = withCell(after, rows.length, column, value);
	return checked(definition, rows, after, change, failure);
}

/** The rows file with the area's `agents` cell set, or null when it already says it. */
function withAgents(
	definition: TableFile | null,
	text: string,
	change: AreaChange & { readonly key: string; readonly shown: readonly string[]; readonly agents: readonly string[] },
	failure: string,
): string | null {
	if (definition === null || !definition.columns.some((each) => each.name === "agents" && each.type === "agents"))
		throw new ClaimLostError(t("That changed while you were looking."));
	const rows = fittingRows(definition, text, failure);
	const index = rows.findIndex((row) => tableRowKey(definition, row) === change.key);
	const row = rows[index];
	if (row === undefined) throw new ClaimLostError(t("This area is no longer here."));
	const was = agentList(row.agents);
	if (JSON.stringify(was) === JSON.stringify(change.agents)) return null;
	if (JSON.stringify(was) !== JSON.stringify(change.shown))
		throw new ClaimLostError(t("That changed while you were looking."));
	// An agent is in one area only (§5.1, rule 9).
	for (const agent of change.agents) {
		if (was.includes(agent)) continue;
		if (rows.some((other, place) => place !== index && agentList(other.agents).includes(agent)))
			throw new AgentInAreaError(agent);
	}
	return checked(definition, rows, withCell(text, index, "agents", change.agents.join(" ")), change, failure);
}
