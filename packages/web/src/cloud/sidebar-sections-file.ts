import { parseCompanyStateFile, type SectionsFile } from "@qorpera/cloud-client/company-state-files";
import { t } from "../ui/preferences.ts";
import { type CompanySidebar, type SidebarRequest, sidebarItem } from "./sidebar.ts";

/*
 * A folder-v2 company's sections are its file `agents/sections.md` (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2): the sections in order, each listing agents and group chats by id; anyone not listed is Unassigned, whose order
 * is not kept. qorpera_manage_company_sidebar refuses section changes and moves there, so the rail's are edits of the
 * file, made as the runtime's organize_sidebar makes them (packages/runtime/src/cloud-folder-sidebar.ts): the lines
 * before the first section are kept as they are, and the sections are written back in the seeded form, each line an
 * id and the words after it only for reading. The commit's hook places the sidebar from the file.
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
	| { action: "delete_section"; name: string }
	/** `section` null: Unassigned. */
	| { action: "move"; item: string; section: string | null; order?: readonly string[] };

/** A change the rail can say no to in the member's words, before anything is sent. */
export class SectionsChangeRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SectionsChangeRefusal";
	}
}

const gone = () => new SectionsChangeRefusal(t("This section is no longer there."));

/** Names a request's sections from the sidebar the member sees. */
export function sectionsChange(sidebar: CompanySidebar, request: SectionsRequest): SectionsChange {
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
			return { action: "delete_section", name: nameOf(request.sectionId) };
		case "move_agent":
		case "move_room":
			return {
				action: "move",
				item: sidebarItem(request)!,
				section: request.sectionId === null ? null : nameOf(request.sectionId),
				...(request.order ? { order: request.order } : {}),
			};
	}
}

interface Section {
	name: string;
	members: { id: string; words: string }[];
}

/** Section names match ignoring case and runs of spaces, as the runtime's tool finds them. */
const same = (a: string, b: string) => a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();
/** The sections as the parser compares them: names in order, each with its ids in order. */
const shape = (sections: readonly { name: string; members: readonly { id: string }[] }[]) =>
	JSON.stringify(sections.map((section) => [section.name, section.members.map((member) => member.id)]));
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
	const preamble = lines.slice(0, file.sections.length ? (file.sections[0]?.line ?? 1) - 1 : lines.length);
	const read: Section[] = file.sections.map((section) => ({
		name: section.name,
		members: section.members.map((member) => ({
			id: member.id,
			// The parser takes an indented entry too.
			words: /^[ \t]*[-*][ \t]+\S+[ \t]*(.*)$/.exec((lines[member.line - 1] ?? "").replace(/\r$/, ""))?.[1] ?? "",
		})),
	}));
	const sections = structuredClone(read);
	apply(sections, change, words);
	return shape(sections) === shape(read) ? null : render(preamble, sections);
}

function apply(sections: Section[], change: SectionsChange, words: (id: string) => string | undefined): void {
	const find = (name: string) => sections.find((section) => same(section.name, name));
	const move = (id: string, section: string | null, order?: readonly string[]) => {
		const target = section === null ? undefined : find(section);
		if (section !== null && !target) throw gone();
		// Moved where it already is without an order: nothing changes, as in the cloud.
		if (!order && target?.members.some((member) => member.id === id)) return;
		let said = readable(words(id));
		for (const each of sections) {
			const index = each.members.findIndex((member) => member.id === id);
			if (index >= 0) {
				said = each.members[index]?.words || said;
				each.members.splice(index, 1);
			}
		}
		if (!target) return;
		// Before the first item the order puts after it. The file may list items the rail does not show (one that is
		// gone keeps its place), so only the items around it move it.
		const after = order ? order.slice(order.indexOf(id) + 1) : [];
		const before = after
			.map((next) => target.members.findIndex((member) => member.id === next))
			.find((index) => index >= 0);
		target.members.splice(before ?? target.members.length, 0, { id, words: said });
	};
	switch (change.action) {
		case "create_section": {
			const name = change.name.trim();
			if (!find(name)) sections.push({ name, members: [] });
			if (change.item) move(change.item, name);
			return;
		}
		case "rename_section": {
			const from = find(change.from);
			const to = find(change.name);
			// Renamed already (another tab, or a lost answer): the new name is there.
			if (!from) {
				if (to) return;
				throw gone();
			}
			if (to && to !== from)
				throw new SectionsChangeRefusal(t("A section called {name} already exists.", { name: `"${to.name}"` }));
			from.name = change.name.trim();
			return;
		}
		case "delete_section": {
			// Its items become Unassigned; a section already gone is already so.
			const index = sections.findIndex((section) => same(section.name, change.name));
			if (index >= 0) sections.splice(index, 1);
			return;
		}
		case "move":
			move(change.item, change.section, change.order);
			return;
	}
}

/** The lines before the first section, kept as they are, then the sections in the seeded form. */
function render(preamble: readonly string[], sections: readonly Section[]): string {
	const out = [...preamble];
	while (out.length > 0 && !(out.at(-1) ?? "").trim()) out.pop();
	for (const section of sections) {
		// The parser's heading rule: a name ending in "#" takes a closing " #", which reading strips.
		if (out.length) out.push("");
		out.push(`## ${section.name.endsWith("#") ? `${section.name} #` : section.name}`);
		for (const member of section.members) out.push(`- ${member.id}${member.words ? ` ${member.words}` : ""}`);
	}
	return `${out.join("\n")}\n`;
}
