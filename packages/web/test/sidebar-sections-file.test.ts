import { parseCompanyStateFile, writeSectionsFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import type { CompanySidebar } from "../src/cloud/sidebar.ts";
import {
	isSectionsRequest,
	rewriteSectionsFile,
	SECTIONS_PATH,
	SectionsChangeRefusal,
	sectionsChange,
} from "../src/cloud/sidebar-sections-file.ts";
import { id } from "./fixtures.ts";

const [ada, bo, cy, gone] = [id(41), id(42), id(43), id(49)];
const research = id(60);
const ops = id(61);
const names = new Map([
	[ada, "Ada"],
	[bo, "Bo"],
	[cy, "Cy"],
]);
const words = (agentId: string) => names.get(agentId);

/** The file's sections as names, each with its ids. */
function read(text: string): [string, ...string[]][] {
	const parsed = parseCompanyStateFile(SECTIONS_PATH, text);
	if (!parsed?.ok || parsed.file.kind !== "sections") throw new Error("not sections");
	return parsed.file.sections.map((section) => [section.name, ...section.members.map((member) => member.id)]);
}

const seeded = () =>
	writeSectionsFile(
		{
			sections: [
				{
					name: "Research",
					line: 0,
					members: [
						{ id: bo, line: 0 },
						{ id: gone, line: 0 },
						{ id: ada, line: 0 },
					],
				},
				{ name: "Ops", line: 0, members: [] },
			],
		},
		names,
	);

describe("agents/sections.md from the rail", () => {
	it("names the request's sections as the member sees them", () => {
		const sidebar: CompanySidebar = {
			sections: [
				{ sectionId: research, name: "Research" },
				{ sectionId: ops, name: "Ops" },
			],
			placements: {},
			pinned: [],
			hidden: [],
		};
		expect(sectionsChange(sidebar, { action: "move_agent", staffAgentId: cy, sectionId: ops, order: [cy] })).toEqual({
			action: "move",
			item: cy,
			section: "Ops",
			order: [cy],
		});
		expect(sectionsChange(sidebar, { action: "move_room", roomId: cy, sectionId: null })).toEqual({
			action: "move",
			item: cy,
			section: null,
		});
		expect(sectionsChange(sidebar, { action: "rename_section", sectionId: ops, name: "Money" })).toEqual({
			action: "rename_section",
			from: "Ops",
			name: "Money",
		});
		expect(() => sectionsChange(sidebar, { action: "delete_section", sectionId: id(62) })).toThrow(
			SectionsChangeRefusal,
		);
		expect(isSectionsRequest({ action: "set_pins", order: [] })).toBe(false);
		expect(isSectionsRequest({ action: "set_hidden", staffAgentId: ada, hidden: true })).toBe(false);
		expect(isSectionsRequest({ action: "delete_section", sectionId: ops })).toBe(true);
	});

	it("moves an item before the one the order puts after it, around items the rail does not show", () => {
		const text = seeded();
		// Cy dragged above Ada: the gone agent the file still lists keeps its place.
		const moved = rewriteSectionsFile(
			text,
			{ action: "move", item: cy, section: "Research", order: [bo, cy, ada] },
			words,
		)!;
		expect(read(moved)).toEqual([["Research", bo, gone, cy, ada], ["Ops"]]);
		expect(moved).toContain(`- ${cy} Cy`);
		// Ada dragged above Bo, within its section, keeps the words beside its id.
		const up = rewriteSectionsFile(
			moved,
			{ action: "move", item: ada, section: "Research", order: [ada, bo, cy] },
			() => "Other",
		)!;
		expect(read(up)).toEqual([["Research", ada, bo, gone, cy], ["Ops"]]);
		expect(up).toContain(`- ${ada} Ada`);
		// To another section, last without an order; out to Unassigned, unlisted.
		const ops = rewriteSectionsFile(up, { action: "move", item: bo, section: "ops" }, words)!;
		expect(read(ops)).toEqual([
			["Research", ada, gone, cy],
			["Ops", bo],
		]);
		expect(read(rewriteSectionsFile(ops, { action: "move", item: cy, section: null }, words)!)).toEqual([
			["Research", ada, gone],
			["Ops", bo],
		]);
	});

	it("writes nothing when the sections already say it", () => {
		const text = seeded();
		expect(rewriteSectionsFile(text, { action: "move", item: ada, section: "Research" }, words)).toBeNull();
		expect(
			rewriteSectionsFile(text, { action: "move", item: ada, section: "Research", order: [bo, ada] }, words),
		).toBeNull();
		// Without the order the cloud keeps (none given): an item in no section moved there again changes nothing.
		expect(
			rewriteSectionsFile(text, { action: "move", item: cy, section: null, order: [cy, ada] }, words),
		).toBeNull();
		expect(rewriteSectionsFile(text, { action: "create_section", name: "research" }, words)).toBeNull();
		expect(rewriteSectionsFile(text, { action: "delete_section", name: "Money" }, words)).toBeNull();
		expect(rewriteSectionsFile(text, { action: "rename_section", from: "Gone", name: "Ops" }, words)).toBeNull();
	});

	it("makes, renames and deletes sections, keeping the company's notes before them", () => {
		const text = `# Our team\n\nNotes the company keeps.\n\n## Research\n- ${bo} Bo\n`;
		const made = rewriteSectionsFile(text, { action: "create_section", name: " Sales ", item: bo }, words)!;
		expect(made.startsWith("# Our team\n\nNotes the company keeps.\n\n## Research\n")).toBe(true);
		expect(read(made)).toEqual([["Research"], ["Sales", bo]]);
		const renamed = rewriteSectionsFile(made, { action: "rename_section", from: "sales", name: "Deals #" }, words)!;
		expect(read(renamed)).toEqual([["Research"], ["Deals #", bo]]);
		expect(() =>
			rewriteSectionsFile(renamed, { action: "rename_section", from: "Deals #", name: "research" }, words),
		).toThrow('A section called "Research" already exists.');
		const deleted = rewriteSectionsFile(renamed, { action: "delete_section", name: "deals #" }, words)!;
		expect(read(deleted)).toEqual([["Research"]]);
		expect(() => rewriteSectionsFile(text, { action: "move", item: bo, section: "Sales" }, words)).toThrow(
			"This section is no longer there.",
		);
		expect(() =>
			rewriteSectionsFile(text, { action: "rename_section", from: "Sales", name: "Deals" }, words),
		).toThrow("This section is no longer there.");
	});

	it("writes the order of what is in no section where the cloud keeps it, after the company's notes", () => {
		const text = `# Sections\n\nOur notes.\n- ${cy} Cy the builder\n- ${gone}\n\n## Research\n- ${bo} Bo\n- ${ada} Ada\n`;
		const unassigned = (written: string | null) => {
			const parsed = parseCompanyStateFile(SECTIONS_PATH, written ?? "");
			if (!parsed?.ok || parsed.file.kind !== "sections") throw new Error("not sections");
			return (parsed.file.unassigned ?? []).map((member) => member.id);
		};
		// Ada out of Research, above Cy: the drawn order is written; the gone id keeps its place after it.
		const out = rewriteSectionsFile(
			text,
			{ action: "move", item: ada, section: null, order: [ada, cy], unassigned: [ada, cy] },
			words,
		)!;
		expect(read(out)).toEqual([["Research", bo]]);
		expect(unassigned(out)).toEqual([ada, cy, gone]);
		expect(out).toBe(
			`# Sections\n\nOur notes.\n\n- ${ada} Ada\n- ${cy} Cy the builder\n- ${gone}\n\n## Research\n- ${bo} Bo\n`,
		);
		// Back into a section: it leaves the order, the rest stays.
		const back = rewriteSectionsFile(
			out,
			{ action: "move", item: ada, section: "Research", order: [ada, bo] },
			words,
		)!;
		expect(read(back)).toEqual([["Research", ada, bo]]);
		expect(unassigned(back)).toEqual([cy, gone]);
		// The same order again writes nothing.
		expect(
			rewriteSectionsFile(back, { action: "move", item: cy, section: null, order: [cy], unassigned: [cy] }, words),
		).toBeNull();
		// A deleted section's items join the order as drawn.
		expect(
			unassigned(
				rewriteSectionsFile(back, { action: "delete_section", name: "research", unassigned: [cy, ada, bo] }, words),
			),
		).toEqual([cy, ada, bo, gone]);
		// A cloud that keeps no such order gets none written: a move there only leaves its section.
		const old = rewriteSectionsFile(back, { action: "move", item: bo, section: null, order: [bo, cy] }, words)!;
		expect(unassigned(old)).toEqual([cy, gone]);
		expect(read(old)).toEqual([["Research", ada]]);
	});

	it("tells apart sections whose names differ only in their spaces, as the parser does", () => {
		const text = `## Sales Ops\n- ${ada} Ada\n\n## Sales  Ops\n- ${bo} Bo\n`;
		expect(read(text)).toEqual([
			["Sales Ops", ada],
			["Sales  Ops", bo],
		]);
		expect(read(rewriteSectionsFile(text, { action: "delete_section", name: "sales  ops" }, words)!)).toEqual([
			["Sales Ops", ada],
		]);
		expect(read(rewriteSectionsFile(text, { action: "move", item: cy, section: "Sales  Ops" }, words)!)).toEqual([
			["Sales Ops", ada],
			["Sales  Ops", bo, cy],
		]);
		expect(
			read(rewriteSectionsFile(text, { action: "rename_section", from: "Sales  Ops", name: "Deals" }, words)!),
		).toEqual([
			["Sales Ops", ada],
			["Deals", bo],
		]);
	});

	it("writes a name beside a new id on one line, and refuses a file that does not read as sections", () => {
		const moved = rewriteSectionsFile(
			seeded(),
			{ action: "move", item: cy, section: "Ops" },
			() => " Cy\nthe\tbuilder ",
		)!;
		expect(moved).toContain(`- ${cy} Cy the builder\n`);
		expect(read(moved)).toEqual([
			["Research", bo, gone, ada],
			["Ops", cy],
		]);
		expect(() =>
			rewriteSectionsFile(`## Ops\nnot an id\n`, { action: "delete_section", name: "Ops" }, words),
		).toThrow(SectionsChangeRefusal);
	});
});
