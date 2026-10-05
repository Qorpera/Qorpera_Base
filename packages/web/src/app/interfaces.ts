/* Interfaces in the web client (contract, 2026-10-02 interfaces amendment; RUNTIME-INTERFACES.md). Until a company
 * keeps its own interface files (folder-v2, step I7), the client draws the library's definitions, and only the parts
 * whose source it can read today: a part without its source is not drawn, and an interface with no part to draw is
 * not listed (the client contract's rule against rendering missing machinery). Today that is Pulse's "Needs you"
 * and "Working now", read from the company's live state. */

import { INTERFACE_LIBRARY } from "@qorpera/cloud-client/interface-library";
import {
	type InterfaceBlock,
	type InterfaceButton,
	type InterfaceFile,
	type InterfaceQuery,
	parseInterfaceFile,
	type TableRow,
} from "@qorpera/cloud-client/interfaces";
import { t } from "../ui/preferences.ts";
import { type CompanyController, isAgentPairSession } from "./company.ts";

export interface CompanyInterface {
	/** The interface's folder name, its route: `#/c/{id}/i/{name}`. */
	readonly name: string;
	readonly file: InterfaceFile;
}

/** One row a block shows, with where it leads. A row from the company's live state leads to the thread it is
 * about; that link is the platform's, never the file's. */
export interface InterfaceRow {
	readonly row: TableRow;
	readonly href?: string;
	/** The row is about something happening right now (an agent writing). */
	readonly live?: boolean;
	/** The row's identity within its source, which an opened row follows through live updates. */
	readonly key: string;
}

/** The blocks this client draws today. A `detail` block is drawn only when a drawn block in its view opens it. */
const DRAWN_BLOCKS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["list", "table", "detail"]);
/** The sources this client reads today: their columns, and the column `since` and ordering use. */
const SOURCES: Readonly<Record<string, { readonly columns: readonly string[]; readonly time: string | null }>> = {
	working: { columns: ["agent", "what", "since"], time: "since" },
	waiting: { columns: ["id", "kind", "title", "from", "due"], time: "due" },
};

/** The `waiting` kinds whose row has a platform card the member answers in its thread. A mention leads to a
 * conversation, not a card. */
const CARD_KINDS: ReadonlySet<string> = new Set(["review", "question", "mail", "task", "offer", "run"]);
export function rowHasCard(source: string, row: TableRow): boolean {
	return source === "waiting" && typeof row.kind === "string" && CARD_KINDS.has(row.kind);
}

let library: CompanyInterface[] | undefined;
/** The library's definitions, parsed once. A definition that doesn't parse is a bug in the library; it is left out
 * rather than drawn wrong. */
function libraryInterfaces(): CompanyInterface[] {
	library ??= INTERFACE_LIBRARY.flatMap((entry) => {
		const parsed = parseInterfaceFile(entry.interface);
		return parsed.ok ? [{ name: entry.name, file: parsed.file }] : [];
	});
	return library;
}

export function interfaceSourceTime(source: string): string | null {
	return SOURCES[source]?.time ?? null;
}

/** Whether this client can draw a block: its kind is drawn here and it reads one source the client has. */
export function drawableBlock(block: InterfaceBlock): boolean {
	return DRAWN_BLOCKS.has(block.kind) && block.from.length === 1 && Object.hasOwn(SOURCES, block.from[0] ?? "");
}

/** The column of each quote source's rows that names the record its outside values came from, which a quote of them
 * carries as its `ref`: a mail row's thread (RUNTIME-INTERFACES.md §4; the member mail read's `thread`, step I5a).
 * The columns that carry outside content are the cloud client's (`interfaceOutsideColumns`). */
export const QUOTE_RECORD_COLUMNS: Readonly<Record<string, string>> = {
	mail: "thread",
};

/** A block in a view. A view built from another (`from_view`) shows that view's blocks and narrows each with its
 * own `where`: rows must match both, the view's filter first, then the block's own query. */
export interface ViewBlock {
	readonly block: InterfaceBlock;
	/** The `where` of every view this one is built from, each narrowing the next; empty for a view's own blocks. */
	readonly narrow: readonly NonNullable<InterfaceQuery["where"]>[];
}

export interface InterfaceViewShape {
	readonly name: string;
	readonly blocks: readonly ViewBlock[];
}

export function interfaceViews(file: InterfaceFile): InterfaceViewShape[] {
	const resolved: InterfaceViewShape[] = [];
	for (const view of file.views) {
		// The parser lets from_view name only a view above this one, so it has been resolved already.
		const base = view.fromView === null ? undefined : resolved.find((above) => above.name === view.fromView);
		const where = view.where;
		const blocks: ViewBlock[] =
			base === undefined
				? view.blocks.map((block) => ({ block, narrow: [] }))
				: base.blocks.map((shown) => ({
						block: shown.block,
						narrow: where ? [...shown.narrow, where] : shown.narrow,
					}));
		resolved.push({ name: view.name, blocks });
	}
	return resolved;
}

export function sourceColumns(source: string): readonly string[] | undefined {
	return SOURCES[source]?.columns;
}

/** The blocks of a view this client draws, in their order: the drawable ones, and a `detail` block that one of
 * them opens. A block a view narrows by a column its source doesn't have is left out of that view: it could only
 * ever look empty. */
export function viewBlocks(view: InterfaceViewShape): ViewBlock[] {
	const fits = ({ block, narrow }: ViewBlock) => {
		const columns = sourceColumns(block.from[0] ?? "") ?? [];
		return (
			drawableBlock(block) && narrow.every((where) => Object.keys(where).every((column) => columns.includes(column)))
		);
	};
	const drawn = view.blocks.filter((shown) => shown.block.kind !== "detail" && fits(shown));
	return view.blocks.filter(
		(shown) =>
			drawn.includes(shown) ||
			(shown.block.kind === "detail" &&
				shown.block.id !== null &&
				fits(shown) &&
				drawn.some((opener) => opener.block.opens === shown.block.id)),
	);
}

/** A button as this client draws it. */
export type DrawnButton =
	| { readonly verb: "answer"; readonly label: string }
	| { readonly verb: "message"; readonly label: string; readonly to: string; readonly text: string }
	| { readonly verb: "open"; readonly label: string; readonly target: string };

/** The buttons a block shows here. A member draws only what a member can do: `who = "agents"` is left out, and so
 * are the verbs whose machinery this client lacks today (add, set, take, offer, release need tables; `open file:`
 * needs a file route). */
export function blockButtons(file: InterfaceFile, block: InterfaceBlock): DrawnButton[] {
	return block.buttons.flatMap((name): DrawnButton[] => {
		if (name === "answer") return [{ verb: "answer", label: t("Answer") }];
		const button: InterfaceButton | undefined = file.buttons.find((candidate) => candidate.id === name);
		if (!button || button.who === "agents") return [];
		if (button.verb === "answer") return [{ verb: "answer", label: button.label }];
		if (button.verb === "message" && button.to !== null)
			return [{ verb: "message", label: button.label, to: button.to, text: button.text ?? "" }];
		if (
			button.verb === "open" &&
			button.target !== null &&
			(button.target === "row" || button.target.startsWith("agent:") || button.target.startsWith("interface:"))
		)
			return [{ verb: "open", label: button.label, target: button.target }];
		return [];
	});
}

function needsMet(file: InterfaceFile, company: CompanyController): boolean {
	return file.needs.every((need) => {
		// No member can read the company's mail yet (Q1's member read, step I5a); tables live in the folder (I7).
		if (need === "team") return (company.store.get().team?.members.length ?? 0) >= 2;
		return false;
	});
}

/** Whether `[access] members` lets this member see the page. It only narrows: the data is read with the
 * member's own rights either way. "owners" means owners and admins, as for `edit`. */
function memberMaySee(file: InterfaceFile, company: CompanyController): boolean {
	const access = file.access.members;
	if (access === "all") return true;
	if (access === "owners") {
		const role = company.store.get().team?.role;
		return role === "owner" || role === "admin";
	}
	return access.includes(company.userId);
}

/** The interfaces the Interfaces tab lists, the main one first. */
export function companyInterfaces(company: CompanyController): CompanyInterface[] {
	const shown = libraryInterfaces().filter(
		({ file }) =>
			file.status === "active" &&
			memberMaySee(file, company) &&
			needsMet(file, company) &&
			interfaceViews(file).some((view) => viewBlocks(view).length > 0),
	);
	return [...shown.filter((entry) => entry.file.main), ...shown.filter((entry) => !entry.file.main)];
}

export function companyInterface(company: CompanyController, name: string): CompanyInterface | undefined {
	return companyInterfaces(company).find((entry) => entry.name === name);
}

/** The rows of a source this client reads, or undefined when it can't read it. */
export function interfaceRows(company: CompanyController, source: string): InterfaceRow[] | undefined {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const agents = state.staff.filter((agent) => agent.employmentStatus === "active");
	const agentHref = (agentId: string) =>
		agentId === company.cofounderId() ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
	const since = (agentId: string) => company.activityFor(agentId)?.updatedAt ?? null;
	// A waiting item is its kind and its run: when one is answered and another comes for the same agent, an open
	// row never turns into the new one.
	const runKey = (kind: string, agentId: string) => `${kind}:${company.activityFor(agentId)?.runId ?? agentId}`;
	if (source === "working") {
		return agents.flatMap((agent) => {
			const now = company.agentState(agent.id);
			if (now !== "working" && now !== "writing") return [];
			// A run with no progress for 15 minutes says so, since its last progress.
			const stalled = company.noProgress(agent.id);
			const what = stalled ? t("No progress") : now === "writing" ? t("Writing") : t("Working");
			return [
				{
					row: { agent: agent.id, what, since: stalled?.since ?? since(agent.id) },
					href: agentHref(agent.id),
					live: true,
					key: `working:${agent.id}`,
				},
			];
		});
	}
	if (source === "waiting") {
		const rows: InterfaceRow[] = [];
		for (const agent of agents) {
			const now = company.agentState(agent.id);
			if (now === "decision") {
				rows.push({
					row: {
						id: agent.id,
						// An agent waiting on a member's decision: an action or change for review.
						kind: "review",
						title: t("{name} needs you", { name: agent.displayName }),
						from: agent.id,
						due: since(agent.id),
					},
					href: agentHref(agent.id),
					key: runKey("review", agent.id),
				});
			} else if (now === "failed") {
				rows.push({
					row: {
						id: agent.id,
						kind: "run",
						title: t("{name} has a run that did not finish", { name: agent.displayName }),
						from: agent.id,
						due: since(agent.id),
					},
					href: agentHref(agent.id),
					key: runKey("run", agent.id),
				});
			}
		}
		for (const [sessionId, count] of Object.entries(state.mentions ?? {})) {
			const session = state.sessions.find((item) => item.sessionId === sessionId);
			// Only conversations the rail itself offers: open ones, never an agent pair's transcript.
			if (!session || count <= 0 || session.status !== "open" || isAgentPairSession(session)) continue;
			rows.push({
				row: {
					id: sessionId,
					kind: "mention",
					title: t("You were mentioned in {conversation}", { conversation: session.title }),
					from: session.staffAgentId ?? null,
					due: null,
				},
				href: `#/c/${profileId}/chat/${sessionId}`,
				key: `mention:${sessionId}`,
			});
		}
		return rows;
	}
	return undefined;
}
