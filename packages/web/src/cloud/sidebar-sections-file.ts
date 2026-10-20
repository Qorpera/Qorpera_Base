import { parseCompanyStateFile, type SectionsFile } from "@qorpera/cloud-client/company-state-files";
import { t } from "../ui/preferences.ts";
import { type CompanySidebar, type SidebarRequest, sidebarItem } from "./sidebar.ts";

/*
 * A folder-v2 company's sections are its file `agents/sections.md` (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2): the sections in order, each listing agents and group chats by id. The id lines before the first section order
 * those in no section (Unassigned, 20260930519000); anyone listed nowhere is Unassigned too, after them.
 * qorpera_manage_company_sidebar refuses section changes and moves there, so the rail's are edits of the file, made as
 * the runtime's organize_sidebar makes them (packages/runtime/src/cloud-folder-sidebar.ts): the lines before the first
 * section are kept as they are but for the ordered ids, which follow them, and the sections are written back in the
 * seeded form, each line an id and the words after it only for reading. The commit's hook places the sidebar from the
 * file.
 */

export const SECTIONS_PATH = "agents/sections.md";

/** The sidebar requests the file decides; pins and hidden items stay the member's own settings. */
export type SectionsRequest = Extract<
	SidebarRequest,
	{ action: "create_section" | "rename_section" | "delete_section" | "move_agent" | "move_room" }
>;

export function isSectionsRequest(request: SidebarRequest): request is SectionsRequest {
	return request.action !== "set_pins" && request.action !== "set_hidden";
}

/** A sections request with its sections named, as the file names them. Names are taken when the request is made, so
 * a request queued behind another names the sections as the member saw them after it. */
export type SectionsChange =
	| { action: "create_section"; name: string; item?: string }
	| { action: "rename_section"; from: string; name: string }
	/** `unassigned`: Unassigned's order as drawn after the change, written where the cloud keeps it. */
	| { action: "delete_section"; name: string; unassigned?: readonly string[] }
	/** `section` null: Unassigned, then `unassigned` is its order as drawn, written where the cloud keeps it. */
	| {
			action: "move";
			item: string;
			section: string | null;
			order?: readonly string[];
			unassigned?: readonly string[];
	  };

/** A change the rail can say no to in the member's words, before anything is sent. */
export class SectionsChangeRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SectionsChangeRefusal";
	}
}

const gone = () => new SectionsChangeRefusal(t("This section is no longer there."));

/** Names a request's sections from the sidebar the member sees. `unassigned` is Unassigned's order as the change draws
 * it, given where the cloud keeps that order. */
export function sectionsChange(
	sidebar: CompanySidebar,
	request: SectionsRequest,
	unassigned?: readonly string[],
): SectionsChange {
	const nameOf = (sectionId: string) => {
		const section = sidebar.sections.find((item) => item.sectionId === sectionId);
		if (!section) throw gone();
		return section.name;
	};
	switch (request.action) {
		case "create_section": {
			const item = sidebarItem(request);
			return { action: "create_section", name: request.name, ...(item ? { item } : {}) };
		}
		case "rename_section":
			return { action: "rename_section", from: nameOf(request.sectionId), name: request.name };
		case "delete_section":
			return { action: "delete_section", name: nameOf(request.sectionId), ...(unassigned ? { unassigned } : {}) };
		case "move_agent":
		case "move_room":
			return {
				action: "move",
				item: sidebarItem(request)!,
				section: request.sectionId === null ? null : nameOf(request.sectionId),
				...(request.order ? { order: request.order } : {}),
				...(request.sectionId === null && unassigned ? { unassigned } : {}),
			};
	}
}

interface Section {
	name: string;
	members: { id: string; words: string }[];
}

/** Section names match ignoring case only, as the parser and the sidebar's index compare them: "Sales Ops" and
 * "Sales  Ops" are two sections. */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The file as the parser compares it: section names in order, each with its ids in order, then the ordered ids in no
 * section. */
const shape = (sections: readonly Section[], unassigned: Section["members"]) =>
	JSON.stringify([
		sections.map((section) => [section.name, section.members.map((member) => member.id)]),
		unassigned.map((member) => member.id),
	]);
/** A name beside an id, on one line (`\s` takes the line and paragraph separators). */
const readable = (name: string | undefined) =>
	(name ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** The file's new text for a change, or null when the sections already say it. `words` gives the name written beside
 * an id the file does not list yet. */
export function rewriteSectionsFile(
	text: string,
	change: SectionsChange,
	words: (id: string) => string | undefined,
): string | null {
	const parsed = parseCompanyStateFile(SECTIONS_PATH, text);
	if (!parsed?.ok || parsed.file.kind !== "sections")
		throw new SectionsChangeRefusal(
			t("The company's sections file does not read as sections. Ask the Co-Founder to correct agents/sections.md."),
		);
	const lines = text.split("\n");
	const file = parsed.file as SectionsFile;
	const ordered = new Set((file.unassigned ?? []).map((member) => member.line));
	// The company's notes: the lines before the first section but the ordered ids, which are written back after them.
	const preamble = lines
		.slice(0, file.sections.length ? (file.sections[0]?.line ?? 1) - 1 : lines.length)
		.filter((_line, index) => !ordered.has(index + 1));
	// The parser takes an indented entry too.
	const member = ({ id, line }: { id: string; line: number }) => ({
		id,
		words: /^[ \t]*[-*][ \t]+\S+[ \t]*(.*)$/.exec((lines[line - 1] ?? "").replace(/\r$/, ""))?.[1] ?? "",
	});
	const read: Section[] = file.sections.map((section) => ({
		name: section.name,
		members: section.members.map(member),
	}));
	const readUnassigned = (file.unassigned ?? []).map(member);
	const sections = structuredClone(read);
	const unassigned = apply(sections, structuredClone(readUnassigned), change, words);
	return shape(sections, unassigned) === shape(read, readUnassigned) ? null : render(preamble, unassigned, sections);
}

/** Applies a change to the sections in place; answers the ordered ids in no section after it. */
function apply(
	sections: Section[],
	listed: Section["members"],
	change: SectionsChange,
	words: (id: string) => string | undefined,
): Section["members"] {
	let unassigned = listed;
	const find = (name: string) => sections.find((section) => same(section.name, name));
	const said = new Map([...unassigned, ...sections.flatMap((section) => section.members)].map((m) => [m.id, m.words]));
	const inSection = (id: string) => sections.some((section) => section.members.some((member) => member.id === id));
	/** Unassigned in the order drawn. An id the file orders that the rail does not show (one that is gone keeps its
	 * place) stays, after them. */
	const reorder = (order: readonly string[]) => {
		const next = order
			.filter((id, index) => !inSection(id) && order.indexOf(id) === index)
			.map((id) => ({ id, words: said.get(id) || readable(words(id)) }));
		for (const kept of unassigned)
			if (!inSection(kept.id) && !next.some((item) => item.id === kept.id)) next.push(kept);
		return next;
	};
	const move = (id: string, section: string | null, order?: readonly string[]) => {
		const target = section === null ? undefined : find(section);
		if (section !== null && !target) throw gone();
		// Moved where it already is without an order: nothing changes, as in the cloud.
		if (!order && target?.members.some((member) => member.id === id)) return;
		const text = said.get(id) || readable(words(id));
		for (const each of sections) {
			const index = each.members.findIndex((member) => member.id === id);
			if (index >= 0) each.members.splice(index, 1);
		}
		unassigned = unassigned.filter((entry) => entry.id !== id);
		if (!target) return;
		// Before the first item the order puts after it. The file may list items the rail does not show (one that is
		// gone keeps its place), so only the items around it move it.
		const after = order ? order.slice(order.indexOf(id) + 1) : [];
		const before = after
			.map((next) => target.members.findIndex((member) => member.id === next))
			.find((index) => index >= 0);
		target.members.splice(before ?? target.members.length, 0, { id, words: text });
	};
	switch (change.action) {
		case "create_section": {
			const name = change.name.trim();
			if (!find(name)) sections.push({ name, members: [] });
			if (change.item) move(change.item, name);
			return unassigned;
		}
		case "rename_section": {
			const from = find(change.from);
			const to = find(change.name);
			// Renamed already (another tab, or a lost answer): the new name is there.
			if (!from) {
				if (to) return unassigned;
				throw gone();
			}
			if (to && to !== from)
				throw new SectionsChangeRefusal(t("A section called {name} already exists.", { name: `"${to.name}"` }));
			from.name = change.name.trim();
			return unassigned;
		}
		case "delete_section": {
			// Its items become Unassigned; a section already gone is already so.
			const index = sections.findIndex((section) => same(section.name, change.name));
			if (index >= 0) sections.splice(index, 1);
			return change.unassigned && index >= 0 ? reorder(change.unassigned) : unassigned;
		}
		case "move":
			move(change.item, change.section, change.order);
			return change.section === null && change.unassigned ? reorder(change.unassigned) : unassigned;
	}
}

/** The lines before the first section, kept as they are, then the ordered ids in no section, then the sections in the
 * seeded form. */
function render(preamble: readonly string[], unassigned: Section["members"], sections: readonly Section[]): string {
	const out = [...preamble];
	while (out.length > 0 && !(out.at(-1) ?? "").trim()) out.pop();
	if (unassigned.length && out.length) out.push("");
	for (const member of unassigned) out.push(`- ${member.id}${member.words ? ` ${member.words}` : ""}`);
	for (const section of sections) {
		// The parser's heading rule: a name ending in "#" takes a closing " #", which reading strips.
		if (out.length) out.push("");
		out.push(`## ${section.name.endsWith("#") ? `${section.name} #` : section.name}`);
		for (const member of section.members) out.push(`- ${member.id}${member.words ? ` ${member.words}` : ""}`);
	}
	return `${out.join("\n")}\n`;
}
