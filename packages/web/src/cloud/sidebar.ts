import { UUID_PATTERN } from "./parse.ts";

/* The company sidebar (2026-09-24): sections are the company's, shared by every
 * member and changed by agents too; pins and hidden agents are this member's own.
 * qorpera_read_company_sidebar answers the member's whole sidebar and every change
 * through qorpera_manage_company_sidebar answers it again.
 * Since 20260927140000 group chats are placed, pinned and hidden like agents, named by
 * their room id; agents and group chats share one order in each section. */

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
	/** Where placed agents and group chats sit, by agent or room id. One without an entry
	 * is Unassigned, after the positioned ones. */
	placements: Record<string, SidebarPlacement>;
	/** This member's pinned agents and group chats, in order. */
	pinned: string[];
	/** Agents and group chats this member keeps out of the rail. */
	hidden: string[];
	/** Whether the cloud places group chats too (and takes images in them); an older one places agents only. */
	groupChats?: boolean;
}

export type SidebarRequest =
	| {
			action: "create_section";
			sectionId: string;
			name: string;
			staffAgentId?: string;
			roomId?: string;
			unpin?: boolean;
	  }
	| { action: "rename_section"; sectionId: string; name: string }
	| { action: "delete_section"; sectionId: string }
	| { action: "move_agent"; staffAgentId: string; sectionId: string | null; order?: string[]; unpin?: boolean }
	| { action: "move_room"; roomId: string; sectionId: string | null; order?: string[]; unpin?: boolean }
	/** Agents and group chats, in one order. */
	| { action: "set_pins"; order: string[] }
	| { action: "set_hidden"; staffAgentId: string; hidden: boolean }
	| { action: "set_hidden"; roomId: string; hidden: boolean };

/** What a request places, pins or hides: an agent or a group chat, by its id. */
export function sidebarItem(request: SidebarRequest): string | undefined {
	return "staffAgentId" in request ? request.staffAgentId : "roomId" in request ? request.roomId : undefined;
}

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
	const groupChats = input.roomPlacements !== undefined;
	if (groupChats && !Array.isArray(input.roomPlacements)) throw new Error("Invalid company sidebar");
	const placements: Record<string, SidebarPlacement> = {};
	const place = (item: unknown, key: "staffAgentId" | "roomId") => {
		const placement = record(item, "sidebar placement");
		const position = placement.position;
		if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0)
			throw new Error("Invalid sidebar placement");
		placements[id(placement[key], "sidebar placement")] =
			placement.sectionId === null || placement.sectionId === undefined
				? { position }
				: { sectionId: id(placement.sectionId, "sidebar placement"), position };
	};
	for (const item of input.placements) place(item, "staffAgentId");
	for (const item of groupChats ? (input.roomPlacements as unknown[]) : []) place(item, "roomId");
	return {
		sections,
		placements,
		pinned: ids(input.pinned, "pinned agent"),
		hidden: ids(input.hidden, "hidden agent"),
		...(groupChats ? { groupChats } : {}),
	};
}

/** The agents and group chats of one container (a section, or Unassigned for undefined)
 * in their order: positioned ones by position, then the rest in roster order (agents,
 * then group chats oldest first). The cloud orders the same way. */
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
		...(sidebar.groupChats ? { groupChats: true } : {}),
	};
	// An agent and a group chat are placed alike, by their ids.
	const place = (itemId: string, sectionId: string | undefined, order?: readonly string[]) => {
		const current = containerOrder(next, sectionId, roster);
		// Moving an item where it already is changes nothing, as in the cloud.
		if (!order && current.includes(itemId)) return;
		const members = current.filter((member) => member !== itemId);
		let final: string[];
		if (order) {
			final = [];
			for (const member of order)
				if ((member === itemId || members.includes(member)) && !final.includes(member)) final.push(member);
			if (!final.includes(itemId)) final.push(itemId);
			for (const member of members) if (!final.includes(member)) final.push(member);
		} else final = [...members, itemId];
		final.forEach((member, position) => {
			next.placements[member] = sectionId ? { sectionId, position } : { position };
		});
	};
	const unpin = (itemId: string) => {
		next.pinned = next.pinned.filter((pinned) => pinned !== itemId);
	};
	const item = sidebarItem(request);
	switch (request.action) {
		case "create_section":
			if (!next.sections.some((section) => section.sectionId === request.sectionId))
				next.sections.push({ sectionId: request.sectionId, name: request.name });
			if (item) {
				place(item, request.sectionId);
				if (request.unpin) unpin(item);
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
		case "move_room":
			place(item!, request.sectionId ?? undefined, request.order);
			if (request.unpin) unpin(item!);
			break;
		case "set_pins":
			next.pinned = [...request.order];
			next.hidden = next.hidden.filter((agentId) => !request.order.includes(agentId));
			break;
		case "set_hidden":
			if (request.hidden) {
				if (!next.hidden.includes(item!)) next.hidden.push(item!);
				unpin(item!);
			} else next.hidden = next.hidden.filter((hidden) => hidden !== item);
			break;
	}
	return next;
}
