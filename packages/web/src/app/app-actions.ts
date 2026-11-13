import { osPath } from "@qorpera/cloud-client/company-state-files";
import { APP_WRITE_KEPT_TABLES, type AppManifest } from "@qorpera/cloud-client/interface-apps";
import {
	csvField,
	isInterfaceName,
	parseTableFile,
	parseTableRows,
	splitCsv,
	type TableColumn,
	type TableFile,
	type TableValue,
	tableFieldValue,
	tableNumberText,
} from "@qorpera/cloud-client/interfaces";
import { POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import {
	readStateFile,
	rewriteStateFile,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
} from "../cloud/company-folder-writes.ts";
import { questionOptions } from "../cloud/interactions.ts";
import type { OpenQuestion } from "../cloud/open-questions.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { APP_NOTE_ABOUT_MAX, APP_NOTE_AT, appNoteAbout, appNoteLine } from "../cloud/wall-reply.ts";
import { t } from "../ui/preferences.ts";
import { rowsLocator, withCell } from "./interface-claims.ts";
import { type OpenQuestions, questionApps } from "./open-questions.ts";

/* What a member can do from an interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §5 "Writes"; Jonas,
 * 10 November 2026: "interfaces let's you interact with your company directly"). An app's page only asks, over its
 * bridge (app/interface-apps.ts): this module checks the request against the company as the member reads it now, says
 * what the bar outside the frame must show (views/app-ask-bar.ts), and, once the member allowed it there, makes the
 * change as the member's own.
 * - An answer to an agent's open question that points at the app (app/open-questions.ts): one of the card's own
 *   options, sent as a tap on the card in the chat sends it. The bar's words are the card's, never the page's.
 * - A change to one row of a company table, or a new row: the cells the page names, typed as the table's columns type
 *   them. The bar shows each cell as it is and as it will be. The write names the rows file's version and is made only
 *   while the row still says what the bar showed; the folder core checks the table's `[write]` rule and the rows as for
 *   any save of the member's. Never a cell that names who holds, owns or does something (a member or an agent), never a
 *   key, never a row taken away.
 * - A note to the agent that owns the app, about a thing in it (Jonas, 13 November 2026: "you can't act very much
 *   inside of the interfaces"): the member's own words, typed in a field on the bar that starts with the page's draft,
 *   sent as the member's own message in that agent's thread (app/tell-agent.ts). The page names only what the note is
 *   about, which the bar shows as a value, never in its sentences; who hears it is the app's owner, or the Co-Founder,
 *   never the page's choice.
 * A refusal before the bar is told to the page alone, in English as the bridge's other refusals are. What goes wrong
 * after the member's yes is shown to the member on the bar, in their language, and told to the page in the same words. */

/** One cell of a row, as the bar shows it: `null` is an empty cell. */
export interface AppAskChange {
	readonly column: string;
	readonly before: string | null;
	readonly after: string | null;
}

/** What the bar shows for one request. */
export type AppAsk =
	| {
			readonly kind: "answer";
			/** The agent that asked. */
			readonly agentId: string;
			/** The card's title, and the labels of the options chosen. */
			readonly question: string;
			readonly answers: readonly string[];
	  }
	| {
			readonly kind: "row";
			readonly add: boolean;
			/** The table's name as its definition says it, and its folder. */
			readonly table: string;
			readonly folder: string;
			/** The row's key as the table reads it; null for a new row. */
			readonly row: string | null;
			readonly changes: readonly AppAskChange[];
	  }
	| {
			readonly kind: "tell";
			/** Who hears the note: the app's owner, or the Co-Founder when it has none at work. */
			readonly agentId: string;
			/** The app's name as its manifest says it. */
			readonly app: string;
			/** What the note is about, as the page said it, made one plain line (cloud/wall-reply.ts `appNoteAbout`). */
			readonly about: string;
			/** The page's draft of the member's words: what the bar's field starts with. */
			readonly draft: string;
	  };

/** How a note went: sent as the member's message, or waiting in the agent's thread (`href`) for the member to send, or
 * `held`: not added there, as that thread's draft answers something else already (app/tell-agent.ts), so the note
 * stays on the bar. */
export interface AppNoteSent {
	readonly sent: boolean;
	readonly href: string;
	readonly held?: true;
}

/** A request that passed its checks: what to show, and the change to make once the member allowed it. A note sends
 * `words`, what the bar's field holds when the member allowed it, and says how it went; the others take no words. */
export interface PreparedAsk {
	readonly ask: AppAsk;
	readonly perform: (words: string) => Promise<AppNoteSent | undefined>;
}

/** How a request ended. `told`: the member sent the note, and it went (`sent`) or waits in the agent's thread. `busy`:
 * another one was on the bar. `quiet`: the member said not now three times in a row, so the app asks no more until
 * they reload it. `gone`: the page it came from was put away, or its manifest changed, before the member chose. */
export type AppGateOutcome =
	| { readonly outcome: "saved" | "declined" | "busy" | "quiet" | "gone" }
	| { readonly outcome: "told"; readonly sent: boolean }
	| { readonly outcome: "failed"; readonly message: string };

/** The member's yes, asked outside the app's frame (views/app-ask-bar.ts): the one way a request becomes a change. */
export interface AppGate {
	/** Why no request can be shown now, or null. */
	readonly closed: () => "busy" | "quiet" | "gone" | null;
	/** Shows the request and, when the member allows it, makes the change with `perform`. */
	readonly ask: (ask: AppAsk, perform: PreparedAsk["perform"]) => Promise<AppGateOutcome>;
}

/** A request the app is told no to, with the reason its page is given. Nothing was shown and nothing changed. */
export class AppActionRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppActionRefused";
	}
}

/** What the answers need of the open company: its open questions (app/open-questions.ts), and the conversation a
 * card is in, which says why an answer was refused. */
export interface AppQuestionSource {
	readonly questions: Pick<OpenQuestions, "store" | "refresh" | "answer" | "forget">;
	readonly conversation?: (sessionId: string) => { get(): { readonly interactionError?: string } };
}

/** A page may read the questions this often from the cloud; between reads it is answered what was read. */
const QUESTIONS_READ_MS = 4_000;
const questionsRead = new WeakMap<object, number>();

/** The open question cards that point at `app`, as the cloud lists them for the member now. */
async function openQuestionsFor(source: AppQuestionSource, app: string): Promise<OpenQuestion[]> {
	const last = questionsRead.get(source.questions) ?? 0;
	if (Date.now() - last >= QUESTIONS_READ_MS || !source.questions.store.get().read) {
		questionsRead.set(source.questions, Date.now());
		await source.questions.refresh();
	}
	return source.questions.store.get().questions.filter((question) => questionApps(question.request).has(app));
}

/** The open questions that point at `app`, as its page is handed them: what each card says and its options. Never who
 * the member is, nor the conversation it was asked in. */
export async function appQuestions(source: AppQuestionSource, app: string, agentName: (agentId: string) => string) {
	return (await openQuestionsFor(source, app)).map((question) => ({
		id: question.interactionId,
		agent: agentName(question.staffAgentId),
		title: question.request.title,
		body: question.request.body ?? "",
		options: questionOptions(question.request).map((option) => ({
			label: option.label,
			value: option.value,
			description: option.description ?? "",
		})),
		multiSelect: question.request.payload.multiSelect === true,
		askedAt: question.createdAt,
	}));
}

/** Options one answer may hold, and cells one request may change. */
const MAX_ANSWER_VALUES = 20;
export const APP_ROW_MAX_CELLS = 12;
/** A cell's text a page may send, at most: a text column's own default limit. */
const MAX_CELL_CHARS = 500;

/** An answer to an open question that points at `app`: `params` is `{id, value}`, the value one of the card's options
 * (several for a card that takes several). */
export async function prepareAnswer(
	source: AppQuestionSource,
	app: string,
	params: Record<string, unknown>,
): Promise<PreparedAsk> {
	const { id, value } = params;
	const values = Array.isArray(value) ? value : [value];
	if (typeof id !== "string" || !POSTGRES_UUID_PATTERN.test(id.toLowerCase()))
		throw new AppActionRefused("answer takes a question's id");
	if (
		values.length < 1 ||
		values.length > MAX_ANSWER_VALUES ||
		values.some((each) => typeof each !== "string") ||
		new Set(values).size !== values.length
	)
		throw new AppActionRefused("answer takes one of the question's option values, or a list of them");
	const question = (await openQuestionsFor(source, app)).find((each) => each.interactionId === id.toLowerCase());
	if (!question) throw new AppActionRefused("No open question with that id points at this app");
	const options = questionOptions(question.request);
	if (values.length > 1 && question.request.payload.multiSelect !== true)
		throw new AppActionRefused("That question takes one answer");
	const chosen = (values as string[]).map((each) => options.find((option) => option.value === each));
	if (chosen.some((option) => option === undefined))
		throw new AppActionRefused("An answer from a page is one of the question's own options");
	return {
		ask: {
			kind: "answer",
			agentId: question.staffAgentId,
			question: question.request.title,
			answers: chosen.map((option) => option?.label ?? ""),
		},
		perform: async () => {
			try {
				await source.questions.answer(question, "answered", { values: values as string[] });
			} catch {
				// Why, as the card's own thread says it (app/views/question-dock.ts shows the same).
				throw new AppActionRefused(
					source.conversation?.(question.sessionId).get().interactionError ??
						t("Your answer could not be sent. Try again."),
				);
			}
			// Off the list at once, here and in the dock on the same page; the next read confirms it.
			source.questions.forget(question.interactionId);
			questionsRead.delete(source.questions);
			return undefined;
		},
	};
}

/* ---- A row of a table ------------------------------------------------------------------------------------------ */

/** What a page asks of a table: cells of the row with a key, or a new row. */
interface RowRequest {
	readonly add: boolean;
	/** The key as the page gave it: one value, or column → value for a key of several columns. */
	readonly key: unknown;
	readonly cells: Readonly<Record<string, unknown>>;
}

/** The change a request makes to a rows file as it is now, or why it makes none. */
type RowPlan =
	| {
			readonly ok: true;
			readonly row: string | null;
			readonly changes: readonly AppAskChange[];
			readonly text: string;
	  }
	| { readonly ok: false; readonly error: string };

/** A value as the bar shows it: an empty cell is null, a number, yes or no and a list as the rows file writes them. */
function shown(value: TableValue): string | null {
	if (value === null) return null;
	if (typeof value === "number") return tableNumberText(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return typeof value === "string" ? value : value.join(" ");
}

/** A value a page gave for a cell, typed as its column types it; a problem as the page is told it. */
function typed(column: TableColumn, value: unknown): { value: TableValue } | { problem: string } {
	let raw: string;
	if (value === null) raw = "";
	else if (typeof value === "boolean") {
		if (column.type !== "yes-no") return { problem: `${column.name} is not a yes-no column` };
		raw = value ? "yes" : "no";
	} else if (typeof value === "number") {
		if (!Number.isFinite(value) || !["number", "money", "percent"].includes(column.type))
			return { problem: `${column.name} does not take a number` };
		raw = tableNumberText(value);
	} else if (typeof value === "string") raw = value;
	else return { problem: `${column.name} takes text, a number, true or false, or null` };
	if (raw.length > MAX_CELL_CHARS) return { problem: `${column.name} is longer than ${MAX_CELL_CHARS} characters` };
	return tableFieldValue(column, raw);
}

/** A column a page may give a value: never one that names who holds, owns or does something. */
function writable(column: TableColumn): string | null {
	if (column.needsYes || column.type === "member" || column.type === "agent" || column.type === "agents")
		return `${column.name} names a member or an agent: an app does not change it`;
	return null;
}

/** The request against the table's definition and its rows as they are now. Pure: the same reading shows the bar and,
 * once allowed, writes, and a write is made only when both read the same change. */
export function planRowChange(table: TableFile, text: string, request: RowRequest): RowPlan {
	const no = (error: string): RowPlan => ({ ok: false, error });
	const parsed = parseTableRows(table, text);
	// Rows that don't fit the definition would be lost by a rewrite, so a change waits for them to be fixed.
	if (!parsed.readable || parsed.problems.length > 0)
		return no("That table's rows have problems, which its agent must fix first");
	const names = Object.keys(request.cells);
	const most = request.add ? table.columns.length : APP_ROW_MAX_CELLS;
	if (names.length < 1 || names.length > most)
		return no(request.add ? "addRow takes the new row's cells" : `setRow takes 1 to ${APP_ROW_MAX_CELLS} cells`);
	const values: Record<string, TableValue> = {};
	for (const name of names) {
		const column = table.columns.find((each) => each.name === name);
		if (!column) return no(`${name} is not a column of that table`);
		const refused = writable(column);
		if (refused) return no(refused);
		if (!request.add && table.key.includes(name)) return no(`${name} is the row's key: a key does not change`);
		const value = typed(column, request.cells[name]);
		if ("problem" in value) return no(value.problem);
		values[name] = value.value;
	}
	const keyOf = (row: Readonly<Record<string, TableValue>>) => JSON.stringify(table.key.map((k) => row[k] ?? null));
	const keyShown = (row: Readonly<Record<string, TableValue>>) =>
		table.key.map((k) => shown(row[k] ?? null) ?? "").join(" · ");

	if (request.add) {
		const row: Record<string, TableValue> = {};
		for (const column of table.columns) {
			if (Object.hasOwn(values, column.name)) row[column.name] = values[column.name] ?? null;
			else if (column.optional) row[column.name] = null;
			else return no(`A new row needs ${column.name}`);
		}
		if (parsed.rows.some((each) => keyOf(each) === keyOf(row))) return no("A row with that key is already there");
		const changes = table.columns
			.filter((column) => (row[column.name] ?? null) !== null)
			.map((column) => ({ column: column.name, before: null, after: shown(row[column.name] ?? null) }));
		// The row goes after the last one, with the file's own line ends and in its first line's column order; a column
		// that line leaves out is added to it, as a claim adds one (app/interface-claims.ts).
		const mark = text.startsWith("﻿") ? "﻿" : "";
		const body = text.slice(mark.length);
		const header = splitCsv(body).records[0]?.fields ?? [];
		const end = body.includes("\r\n") ? "\r\n" : "\n";
		const line = header.map((name) => csvField(row[name] ?? null)).join(",");
		let after = `${text}${body === "" || body.endsWith("\n") ? "" : end}${line}${end}`;
		for (const column of table.columns) {
			const value = row[column.name] ?? null;
			if (!header.includes(column.name) && value !== null)
				after = withCell(after, parsed.rows.length, column.name, shown(value) ?? "");
		}
		return settled(table, after, parsed.rows.length + 1, { row: null, changes, text: after });
	}

	// The key, typed as its columns type it: one value, or column → value.
	const given = request.key;
	const keyValues: Record<string, TableValue> = {};
	for (const name of table.key) {
		const column = table.columns.find((each) => each.name === name);
		const part =
			table.key.length === 1 && (typeof given !== "object" || given === null)
				? given
				: typeof given === "object" && given !== null && !Array.isArray(given)
					? (given as Record<string, unknown>)[name]
					: undefined;
		const value = column && part !== undefined && part !== null ? typed(column, part) : { problem: "" };
		if ("problem" in value) return no("setRow takes the row's key: the value of the table's key column");
		keyValues[name] = value.value;
	}
	const index = parsed.rows.findIndex((each) => keyOf(each) === keyOf(keyValues));
	const row = parsed.rows[index];
	if (row === undefined) return no("No row has that key");
	const changes = names
		.map((name) => ({ column: name, before: shown(row[name] ?? null), after: shown(values[name] ?? null) }))
		.filter((change) => change.before !== change.after);
	if (changes.length === 0) return no("That row already says this");
	// Only those fields' text changes: every other byte of the file stays as written.
	let after = text;
	for (const change of changes) after = withCell(after, index, change.column, change.after ?? "");
	return settled(table, after, parsed.rows.length, { row: keyShown(row), changes, text: after });
}

/** The plan, once the rows it writes read back whole against the definition: every row kept, none with a problem. */
function settled(
	table: TableFile,
	after: string,
	rows: number,
	plan: Omit<Extract<RowPlan, { ok: true }>, "ok">,
): RowPlan {
	const check = parseTableRows(table, after);
	return check.readable && check.problems.length === 0 && check.rows.length === rows
		? { ok: true, ...plan }
		: { ok: false, error: check.problems[0]?.message ?? "That change does not fit the table" };
}

const sameChanges = (a: readonly AppAskChange[], b: readonly AppAskChange[]) =>
	a.length === b.length &&
	a.every((change, at) => {
		const other = b[at];
		return change.column === other?.column && change.before === other.before && change.after === other.after;
	});

/** A change to one row of the table in `QorperaOS/tables/<table>/`: `params` is `{table, key, cells}`, or
 * `{table, cells}` for a new row. `check` throws when the member's access changed while it waited. */
export async function prepareRow(
	folder: WebMemberFolder,
	add: boolean,
	params: Record<string, unknown>,
	signal: AbortSignal,
	check: () => void,
): Promise<PreparedAsk> {
	const { table, key, cells } = params;
	if (typeof table !== "string" || !isInterfaceName(table) || APP_WRITE_KEPT_TABLES.includes(table))
		throw new AppActionRefused("No table an app may change has that name");
	if (typeof cells !== "object" || cells === null || Array.isArray(cells))
		throw new AppActionRefused("cells is an object of column to new value");
	const request: RowRequest = { add, key, cells: cells as Record<string, unknown> };
	const definition = await readStateFile(folder, osPath(`tables/${table}/table.toml`), signal);
	const parsed = definition === null ? null : parseTableFile(definition.text);
	if (!parsed?.ok) throw new AppActionRefused("No table has that name");
	if (parsed.file.write.members === "none") throw new AppActionRefused("Members may not change that table");
	const rows = await readStateFile(folder, osPath(`tables/${table}/rows.csv`), signal);
	check();
	if (rows === null) throw new AppActionRefused("That table has no rows file yet");
	const plan = planRowChange(parsed.file, rows.text, request);
	if (!plan.ok) throw new AppActionRefused(plan.error);
	return {
		ask: { kind: "row", add, table: parsed.file.name, folder: table, row: plan.row, changes: plan.changes },
		perform: async () => {
			let current: TableFile | null = null;
			const failure = t("The row could not be saved.");
			const gone = t("That table is no longer in the company.");
			try {
				await rewriteStateFile(
					folder,
					{
						locate: rowsLocator(folder, table, failure, signal, (read) => {
							current = read;
						}),
						// Read again at the write (and again when the file changed under it): the member allowed this change
						// of these values, so anything else by now is not what they said yes to.
						rewrite: (text) => {
							const now = current === null ? null : planRowChange(current, text, request);
							if (!now?.ok || now.row !== plan.row || !sameChanges(now.changes, plan.changes))
								throw new AppActionRefused(t("The row changed while you were deciding. Nothing was saved."));
							return now.text;
						},
						key: () => `web:app-row:${crypto.randomUUID()}`,
						gone,
						failure,
					},
					signal,
					check,
				);
			} catch (error) {
				if (error instanceof WebCompanyFolderRejectedError)
					throw new AppActionRefused(
						error.outcome === "denied" ? t("You may not change this table. Nothing was saved.") : error.message,
					);
				if (error instanceof Error && error.message === gone) throw new AppActionRefused(gone);
				throw error;
			}
			return undefined;
		},
	};
}

/* ---- A note to the app's owner --------------------------------------------------------------------------------- */

/** What a note needs of the open company (app/tell-agent.ts): who hears it, and the send. */
export interface AppTellSource {
	/** Who hears a note from an app with this owner now: the owner while it is at work, else the Co-Founder; or why no
	 * note can go, as the page is told it. */
	readonly receiver: (owner: string | null) => { readonly agentId: string } | { readonly refused: string };
	/** An agent by its id, for its name and figure on the bar. */
	readonly agent: (agentId: string) => HostedStaffAgent | undefined;
	/** Sends the member's words to the agent as their own message, under the line the note answers (`header`, the app
	 * and what it is about), or leaves them waiting in the agent's thread. */
	readonly send: (agentId: string, note: { readonly header: string; readonly text: string }) => Promise<AppNoteSent>;
}

/** A draft of the member's words a page may give, at most, in characters. */
export const APP_NOTE_DRAFT_MAX = 280;

const characters = (text: string) => [...text].length;

/** A note to the agent that owns `app`, about a thing in it: `params` is `{about, at, text}`. `about` is what the note is
 * about, 1 to 60 characters once made one plain line; `at` the thing's id in the app's data, or none; `text` a draft of
 * the member's words, at most 280 characters, or none. Nothing is read for it: who hears it is the app's owner as the
 * company has it now, or the Co-Founder. Once the member allowed it, the note goes as their own message: the app, the
 * thing and what it is about on its first line, then the words the bar's field held. */
export function prepareTell(
	source: AppTellSource,
	app: { readonly name: string; readonly manifest: Pick<AppManifest, "name" | "owner"> },
	params: Record<string, unknown>,
): PreparedAsk {
	const { about, at, text } = params;
	const said = typeof about === "string" ? appNoteAbout(about) : "";
	if (said === "" || characters(said) > APP_NOTE_ABOUT_MAX)
		throw new AppActionRefused(`tell takes about: what the note is about, 1 to ${APP_NOTE_ABOUT_MAX} characters`);
	if (at !== undefined && at !== null && (typeof at !== "string" || !APP_NOTE_AT.test(at)))
		throw new AppActionRefused("tell's at is the thing's id: up to 64 letters, digits and _ . : -");
	if (text !== undefined && text !== null && typeof text !== "string")
		throw new AppActionRefused("tell's text is a draft of the member's words");
	const draft = typeof text === "string" ? text : "";
	if (characters(draft) > APP_NOTE_DRAFT_MAX)
		throw new AppActionRefused(`tell's text is at most ${APP_NOTE_DRAFT_MAX} characters`);
	const receiver = source.receiver(app.manifest.owner);
	if ("refused" in receiver) throw new AppActionRefused(receiver.refused);
	const thing = typeof at === "string" ? at : null;
	return {
		ask: { kind: "tell", agentId: receiver.agentId, app: app.manifest.name, about: said, draft },
		perform: async (words) => {
			const own = words.trim();
			// The bar's Send is off while its field is empty.
			if (!own) throw new AppActionRefused(t("Write your note first."));
			try {
				return await source.send(receiver.agentId, { header: appNoteLine(app.name, thing, said), text: own });
			} catch (error) {
				throw new AppActionRefused(
					error instanceof Error ? error.message : t("Your note could not be sent. Try again."),
				);
			}
		},
	};
}
