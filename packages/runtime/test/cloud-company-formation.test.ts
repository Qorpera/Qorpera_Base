import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	COMPANY_STATE_COFOUNDER_HANDLE,
	COMPANY_STATE_FIRST_TODO_PATH,
	companyStateSeedTree,
} from "@qorpera/cloud-client/company-state-files";
import {
	COMPANY_FORMATION_PATH,
	COMPANY_FORMATION_SCHEMA,
	COMPANY_FORMATION_STAGES,
	COMPANY_FORMATION_STATUSES,
	companyFormationWriteRefusal,
	isCompanyFormationPath,
} from "@qorpera/runtime/cloud-company-formation";
import { cloudRuntimeHireBehavior } from "@qorpera/runtime/cloud-runtime-hire-overlays";
import { describe, expect, it } from "vitest";

const formationId = "11111111-1111-4111-8111-111111111112";
const cofounderStaffAgentId = "22222222-2222-4222-8222-222222222223";
const cofounderId = "33333333-3333-4333-8333-333333333334";
const firstTodoId = "44444444-4444-4444-8444-444444444445";

function document(state: string, status: string, revision: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schema: COMPANY_FORMATION_SCHEMA,
		formationId,
		cofounderStaffAgentId,
		state,
		status,
		revision,
		...extra,
	});
}

describe("company formation keys", () => {
	it("names the same stages, in the same order, as the table's state check", async () => {
		const kernel = await readFile(
			resolve(import.meta.dirname, "../../../supabase/migrations/20260828019100_company_organization_kernel.sql"),
			"utf8",
		);
		const table = kernel.slice(kernel.indexOf("create table public.qorpera_company_formations ("));
		const states = /state text not null default 'source_inventory' check \(state in \(\s*([^)]*)\)\)/.exec(table);
		const statuses = /status text not null default 'active' check \(status in \(([^)]*)\)\)/.exec(table);
		const names = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
		expect(names(states![1])).toEqual([...COMPANY_FORMATION_STAGES]);
		expect(names(statuses![1]).sort()).toEqual([...COMPANY_FORMATION_STATUSES].sort());
	});

	it("points the Co-Founder at the company folder's own files, with no formation file or stages (P28b)", () => {
		const cofounder = cloudRuntimeHireBehavior("cofounder");
		// The paths the creation's seed tree writes (companyStateSeedTree, #749).
		for (const path of ["vision/vision.md", "agents/sections.md", "agent.md"]) expect(cofounder).toContain(path);
		expect(cofounder).toContain("Your first todo, Start with the founders, is to shape vision/vision.md with them");
		expect(cofounder).toContain("done when every founder has agreed their part of the vision");
		// The founders wrote the vision at the founding table: the hello, after any acknowledgement, builds on it.
		expect(cofounder).toContain(
			"Before your hello (after any acknowledgement your reply policy asks for), read vision/vision.md",
		);
		expect(cofounder).toContain(
			"Only when the vision says nothing yet, ask instead whether they are starting from a blank page",
		);
		// Every path and the first todo's title it names are the seed tree's.
		const seeded = companyStateSeedTree({
			companyName: "Nordlys Kaffe",
			cofounderId,
			firstTodo: { id: firstTodoId, requestedBy: null },
		});
		const paths = new Set(seeded.map((entry) => entry.path));
		for (const path of ["vision/vision.md", "agents/sections.md"]) expect(paths.has(path)).toBe(true);
		expect(paths.has(`agents/${COMPANY_STATE_COFOUNDER_HANDLE}/agent.md`)).toBe(true);
		const todo = seeded.find((entry) => entry.path === COMPANY_STATE_FIRST_TODO_PATH);
		expect(todo?.text).toContain("title: Start with the founders");
		expect(todo?.text).toContain("Done when every founder has agreed their part of the vision.");
		// Stage keys such as "research" are ordinary words; the list, the schema and the file are not.
		for (const overlay of [cofounder, cloudRuntimeHireBehavior("employee")]) {
			for (const key of [
				COMPANY_FORMATION_STAGES.join(", "),
				"stage keys",
				COMPANY_FORMATION_SCHEMA,
				"formation.json",
				"organization/",
			])
				expect(overlay).not.toContain(key);
		}
	});

	// The gateway then reads the file where bootstrap wrote it, COMPANY_FORMATION_PATH.
	it("recognises the formation file under the Company File's case-folded key only", () => {
		expect(isCompanyFormationPath(COMPANY_FORMATION_PATH)).toBe(true);
		expect(isCompanyFormationPath("Organization/Formation.JSON")).toBe(true);
		expect(isCompanyFormationPath("organization/formation.json.bak")).toBe(false);
		expect(isCompanyFormationPath("notes/organization/formation.json")).toBe(false);
	});
});

describe("company formation write rule", () => {
	it("accepts the same stage or the next one, one revision up", () => {
		for (const [index, state] of COMPANY_FORMATION_STAGES.entries()) {
			const current = document(state, "active", index + 1);
			expect(companyFormationWriteRefusal(current, document(state, "active", index + 2))).toBeNull();
			const next = COMPANY_FORMATION_STAGES[index + 1];
			if (next) expect(companyFormationWriteRefusal(current, document(next, "paused", index + 2))).toBeNull();
		}
		expect(
			companyFormationWriteRefusal(document("operating", "completed", 7), document("operating", "completed", 8)),
		).toBeNull();
	});

	it("reads formationId as PostgreSQL reads a uuid, and cofounderStaffAgentId only in its canonical form", () => {
		const ids = {
			formationId: "abcdef01-2345-4678-89ab-cdef01234567",
			cofounderStaffAgentId: "fedcba98-7654-4321-8fed-cba987654321",
		};
		const current = document("research", "active", 3, ids);
		const digits = ids.formationId.replaceAll("-", "");
		for (const spelling of [
			ids.formationId.toUpperCase(),
			`{${ids.formationId}}`,
			digits,
			digits.replace(/(.{4})(?!$)/g, "$1-"),
		])
			expect(
				companyFormationWriteRefusal(current, document("research", "active", 4, { ...ids, formationId: spelling })),
			).toBeNull();
		// The projection requires the Co-Founder's id in lower-case canonical form.
		for (const changed of [
			{ ...ids, cofounderStaffAgentId: ids.cofounderStaffAgentId.toUpperCase() },
			{ ...ids, formationId: "not-a-uuid" },
			// PostgreSQL allows a hyphen only after a group of four digits, and braces only as a pair.
			{ ...ids, formationId: `-${ids.formationId}` },
			{ ...ids, formationId: `${digits.slice(0, 3)}-${digits.slice(3)}` },
			{ ...ids, formationId: `{${ids.formationId}` },
			{ ...ids, formationId: formationId },
		])
			expect(companyFormationWriteRefusal(current, document("research", "active", 4, changed))).toMatch(
				/^formationId and cofounderStaffAgentId must stay unchanged\. /,
			);
	});

	it("names the stage the file is at and the one allowed next", () => {
		const refusal = companyFormationWriteRefusal(
			document("goals_ratified", "active", 5),
			document("operating", "active", 6),
		);
		expect(refusal).toBe(
			"the stage moves one step at a time and never back. organization/formation.json is at stage goals_ratified, revision 5, status active. " +
				`Write it back with exactly its six fields: schema ${COMPANY_FORMATION_SCHEMA}, formationId and cofounderStaffAgentId unchanged, ` +
				"revision 6, state goals_ratified or responsibility_map, status active, paused, completed.",
		);
		// The retired name after goals_ratified (2026-09-02 rename) is not a stage key.
		expect(
			companyFormationWriteRefusal(
				document("goals_ratified", "active", 5),
				document("organization_formation", "active", 6),
			),
		).toMatch(/^state must be one of the formation stage keys\. .* state goals_ratified or responsibility_map,/);
		// The last stage has no next one, and a completed formation stays completed.
		expect(
			companyFormationWriteRefusal(document("operating", "completed", 7), document("operating", "active", 8)),
		).toMatch(/^a completed formation stays completed\. .*revision 8, state operating, status completed\.$/);
		expect(
			companyFormationWriteRefusal(document("operating", "active", 7), document("responsibility_map", "active", 8)),
		).toMatch(/^the stage moves one step at a time and never back\. .*revision 8, state operating, status /);
	});

	it.each([
		["the text is not JSON", "{"],
		["the text is not a JSON object", "[]"],
		["it must have exactly the fields", document("discovery", "active", 3, { note: "extra" })],
		["it must have exactly the fields", JSON.stringify({ schema: COMPANY_FORMATION_SCHEMA, state: "discovery" })],
		["the schema changed", document("discovery", "active", 3, { schema: "qorpera.company-formation/v2" })],
		[
			"formationId and cofounderStaffAgentId must stay unchanged",
			document("discovery", "active", 3, { formationId: cofounderStaffAgentId }),
		],
		[
			"formationId and cofounderStaffAgentId must stay unchanged",
			document("discovery", "active", 3, { cofounderStaffAgentId: formationId }),
		],
		["revision must be 3", document("discovery", "active", 2)],
		["revision must be 3", document("discovery", "active", 4)],
		["revision must be 3", document("discovery", "active", 3, { revision: "3" })],
		["the stage moves one step at a time and never back", document("source_inventory", "active", 3)],
		["the stage moves one step at a time and never back", document("vision_proposal", "active", 3)],
		["state must be one of the formation stage keys", document("Research", "active", 3)],
		["status must be active, paused, completed", document("research", "done", 3)],
	])("refuses a write where %s", (problem, next) => {
		const refusal = companyFormationWriteRefusal(document("discovery", "active", 2), next);
		expect(refusal?.startsWith(`${problem}`)).toBe(true);
		expect(refusal).toContain(
			"organization/formation.json is at stage discovery, revision 2, status active. Write it back with exactly its six fields",
		);
		expect(refusal).toContain("revision 3, state discovery or research,");
		expect(refusal).not.toContain("extra");
	});

	it("leaves a file it cannot read as a recorded formation to the database", () => {
		const next = document("discovery", "active", 2);
		for (const current of [
			"",
			"{",
			"[]",
			document("organization_formation", "active", 1),
			document("discovery", "finished", 1),
			document("discovery", "active", 0),
			document("discovery", "active", 1, { schema: "qorpera.company-formation/v2" }),
			JSON.stringify({ state: "discovery", status: "active", revision: 1 }),
		])
			expect(companyFormationWriteRefusal(current, next)).toBeNull();
	});
});
