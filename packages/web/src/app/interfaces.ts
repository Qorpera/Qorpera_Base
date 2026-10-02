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
}

/** The blocks this client draws today. A `detail` block is drawn only when a drawn block in its view opens it. */
const DRAWN_BLOCKS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["list", "table", "detail"]);
/** The sources this client reads today, and the column `since` and ordering use. */
const SOURCES: Readonly<Record<string, { readonly time: string | null }>> = {
	working: { time: "since" },
	waiting: { time: "due" },
};

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

/** The columns of each source that carry outside content (contract 11.1), such as an email's sender or subject.
 * They keep their outside-content mark wherever they are shown or sent. */
export const OUTSIDE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	mail: ["from_name", "from_address", "subject"],
};

/** A view as drawn. A view built from another (`from_view`) takes that view's blocks, each with the view's own
 * `where` added to its query. */
export interface InterfaceViewShape {
	readonly name: string;
	readonly blocks: readonly InterfaceBlock[];
}

export function interfaceViews(file: InterfaceFile): InterfaceViewShape[] {
	const resolved: InterfaceViewShape[] = [];
	for (const view of file.views) {
		// The parser lets from_view name only a view above this one, so it has been resolved already.
		const base = view.fromView === null ? undefined : resolved.find((above) => above.name === view.fromView);
		const where = view.where;
		const blocks =
			base === undefined
				? view.blocks
				: base.blocks.map((block) =>
						where === null
							? block
							: { ...block, query: { ...block.query, where: { ...block.query.where, ...where } } },
					);
		resolved.push({ name: view.name, blocks });
	}
	return resolved;
}

/** The blocks of a view this client draws, in their order: the drawable ones, and a `detail` block that one of
 * them opens. */
export function viewBlocks(view: InterfaceViewShape): InterfaceBlock[] {
	const drawn = view.blocks.filter((block) => block.kind !== "detail" && drawableBlock(block));
	return view.blocks.filter(
		(block) =>
			drawn.includes(block) ||
			(block.kind === "detail" &&
				block.id !== null &&
				drawableBlock(block) &&
				drawn.some((opener) => opener.opens === block.id)),
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
	if (source === "working") {
		return agents.flatMap((agent) => {
			const now = company.agentState(agent.id);
			if (now !== "working" && now !== "writing") return [];
			return [
				{
					row: { agent: agent.id, what: now === "writing" ? t("Writing") : t("Working"), since: since(agent.id) },
					href: agentHref(agent.id),
					live: true,
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
			});
		}
		return rows;
	}
	return undefined;
}
