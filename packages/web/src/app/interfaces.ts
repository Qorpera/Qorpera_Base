/* Interfaces in the web client (contract, 2026-10-02 interfaces amendment; RUNTIME-INTERFACES.md). Until a company
 * keeps its own interface files (folder-v2, step I7), the client draws the library's definitions, and only the parts
 * whose source it can read today: a part without its source is not drawn, and an interface with no part to draw is
 * not listed (the client contract's rule against rendering missing machinery). Today that is Pulse's "Needs you"
 * and "Working now", read from the company's live state. */

import { INTERFACE_LIBRARY } from "@qorpera/cloud-client/interface-library";
import {
	type InterfaceBlock,
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

/** The blocks this client draws today. */
const DRAWN_BLOCKS: ReadonlySet<InterfaceBlock["kind"]> = new Set(["list"]);
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
			file.views.some((view) => view.blocks.some(drawableBlock)),
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
