import { UUID_PATTERN } from "./parse.ts";

/* The company sidebar (2026-09-24): sections are the company's, shared by every
 * member and changed by agents too; pins and hidden agents are this member's own.
 * qorpera_read_company_sidebar answers the member's whole sidebar and every change
 * through qorpera_manage_company_sidebar answers it again. */

export interface SidebarSection {
	sectionId: string;
	name: string;
}

export interface SidebarPlacement {
	/** Undefined: Unassigned. */
	sectionId?: string;
	position: number;
}

export interface CompanySidebar {
	/** In their order in the rail. */
	sections: SidebarSection[];
	/** Where placed agents sit, by agent id. An agent without an entry is Unassigned, after the positioned ones. */
	placements: Record<string, SidebarPlacement>;
	/** This member's pinned agents, in order. */
	pinned: string[];
	/** Agents this member keeps out of the rail. */
	hidden: string[];
}

export type SidebarRequest =
	| { action: "create_section"; sectionId: string; name: string; staffAgentId?: string; unpin?: boolean }
	| { action: "rename_section"; sectionId: string; name: string }
	| { action: "delete_section"; sectionId: string }
	| { action: "move_agent"; staffAgentId: string; sectionId: string | null; order?: string[]; unpin?: boolean }
	| { action: "set_pins"; order: string[] }
	| { action: "set_hidden"; staffAgentId: string; hidden: boolean };

export const SECTION_NAME_LIMIT = 60;
export const PIN_LIMIT = 24;

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${what}`);
	return value as Record<string, unknown>;
}
function id(value: unknown, what: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${what}`);
	return value.toLowerCase();
}
function ids(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) throw new Error(`Invalid ${what}`);
	return value.map((item) => id(item, what));
}

export function parseCompanySidebar(value: unknown): CompanySidebar {
	const input = record(value, "company sidebar");
	if (input.schema !== "qorpera.company-sidebar/v1") throw new Error("Invalid company sidebar");
	if (!Array.isArray(input.sections) || !Array.isArray(input.placements)) throw new Error("Invalid company sidebar");
	const sections = input.sections.map((item) => {
		const section = record(item, "sidebar section");
		if (typeof section.name !== "string" || !section.name.trim()) throw new Error("Invalid sidebar section");
		return { sectionId: id(section.sectionId, "sidebar section"), name: section.name };
	});
	const placements: Record<string, SidebarPlacement> = {};
	for (const item of input.placements) {
		const placement = record(item, "sidebar placement");
		const position = placement.position;
		if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0)
			throw new Error("Invalid sidebar placement");
		placements[id(placement.staffAgentId, "sidebar placement")] =
			placement.sectionId === null || placement.sectionId === undefined
				? { position }
				: { sectionId: id(placement.sectionId, "sidebar placement"), position };
	}
	return {
		sections,
		placements,
		pinned: ids(input.pinned, "pinned agent"),
		hidden: ids(input.hidden, "hidden agent"),
	};
}

/** The agents of one container (a section, or Unassigned for undefined) in their
 * order: positioned agents by position, then the rest in roster order. The cloud
 * orders the same way. */
export function containerOrder(
	sidebar: CompanySidebar,
	sectionId: string | undefined,
	roster: readonly string[],
): string[] {
	const known = new Set(sidebar.sections.map((section) => section.sectionId));
	const home = (agentId: string) => {
		const placed = sidebar.placements[agentId]?.sectionId;
		return placed && known.has(placed) ? placed : undefined;
	};
	const rank = new Map(roster.map((agentId, index) => [agentId, index]));
	return roster
		.filter((agentId) => home(agentId) === sectionId)
		.sort((left, right) => {
			const a = sidebar.placements[left],
				b = sidebar.placements[right];
			// A placement whose section is gone keeps no position there.
			const pa = a && home(left) === a.sectionId ? a.position : Number.POSITIVE_INFINITY;
			const pb = b && home(right) === b.sectionId ? b.position : Number.POSITIVE_INFINITY;
			return pa === pb ? (rank.get(left) ?? 0) - (rank.get(right) ?? 0) : pa - pb;
		});
}

/** What a change will look like, drawn before the cloud answers. The cloud's
 * answer replaces it; the rules here mirror qorpera_manage_company_sidebar. */
export function applySidebarRequest(
	sidebar: CompanySidebar,
	request: SidebarRequest,
	roster: readonly string[],
): CompanySidebar {
	const next: CompanySidebar = {
		sections: [...sidebar.sections],
		placements: { ...sidebar.placements },
		pinned: [...sidebar.pinned],
		hidden: [...sidebar.hidden],
	};
	const place = (agentId: string, sectionId: string | undefined, order?: readonly string[]) => {
		const members = containerOrder(next, sectionId, roster).filter((member) => member !== agentId);
		let final: string[];
		if (order) {
			final = [];
			for (const member of order)
				if ((member === agentId || members.includes(member)) && !final.includes(member)) final.push(member);
			if (!final.includes(agentId)) final.push(agentId);
			for (const member of members) if (!final.includes(member)) final.push(member);
		} else final = [...members, agentId];
		final.forEach((member, position) => {
			next.placements[member] = sectionId ? { sectionId, position } : { position };
		});
	};
	const unpin = (agentId: string) => {
		next.pinned = next.pinned.filter((pinned) => pinned !== agentId);
	};
	switch (request.action) {
		case "create_section":
			if (!next.sections.some((section) => section.sectionId === request.sectionId))
				next.sections.push({ sectionId: request.sectionId, name: request.name });
			if (request.staffAgentId) {
				place(request.staffAgentId, request.sectionId);
				if (request.unpin) unpin(request.staffAgentId);
			}
			break;
		case "rename_section":
			next.sections = next.sections.map((section) =>
				section.sectionId === request.sectionId ? { ...section, name: request.name } : section,
			);
			break;
		case "delete_section": {
			const unassigned = containerOrder(next, undefined, roster);
			const members = containerOrder(next, request.sectionId, roster);
			next.sections = next.sections.filter((section) => section.sectionId !== request.sectionId);
			[...unassigned, ...members].forEach((member, position) => {
				next.placements[member] = { position };
			});
			break;
		}
		case "move_agent":
			place(request.staffAgentId, request.sectionId ?? undefined, request.order);
			if (request.unpin) unpin(request.staffAgentId);
			break;
		case "set_pins":
			next.pinned = [...request.order];
			next.hidden = next.hidden.filter((agentId) => !request.order.includes(agentId));
			break;
		case "set_hidden":
			if (request.hidden) {
				if (!next.hidden.includes(request.staffAgentId)) next.hidden.push(request.staffAgentId);
				unpin(request.staffAgentId);
			} else next.hidden = next.hidden.filter((agentId) => agentId !== request.staffAgentId);
			break;
	}
	return next;
}
