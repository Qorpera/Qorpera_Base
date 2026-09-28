import { describe, expect, it } from "vitest";
import {
	type AgentFile,
	COMPANY_STATE_SEEDED_PATHS,
	type CompanyStateFileResult,
	canonicalCompanyStateInstant,
	companyPathKey,
	companyStateName,
	companyStatePath,
	companyStatePathProblems,
	companyStateSeedTree,
	companyStateTimeZoneProblem,
	companyStateValue,
	freeCompanyStateName,
	isCompanyStateName,
	isCompanyStateTimeZoneName,
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
	writeAgentFile,
	writeConnectionFile,
	writeGroupFile,
	writeRoutineFile,
	writeRuleFile,
	writeSectionsFile,
	writeTodoFile,
	writeVisionFile,
	writeWorkerBriefFile,
	writeWorkerResultsFile,
} from "../src/company-state-files.ts";

const ANNA = "7b0e6c9e-1c7a-4d8e-9a55-2f0d1f6a3b10";
const TOM = "3c1f0a77-52d4-4b8e-8f31-0d6e2b9a4c18";
const IDA = "9e2d4b16-7a3c-4f58-b1e0-6c8d2a5f7b93";
const GROUP = "0c4f9a3e-8b21-4f6c-a0d2-7e5b1c3d9f40";
const JONAS = "5d2c8e41-0b7f-4a93-9c16-e2f4a8b0d375";
const ID = "5f3c2a10-9d84-4e61-b7a2-3c0e8f1d6b29";

function ok(path: string, text: string) {
	const result = parseCompanyStateFile(path, text);
	if (!result?.ok) throw new Error(`expected ${path} to parse: ${JSON.stringify(result)}`);
	return result.file;
}

function refused(path: string, text: string) {
	const result = parseCompanyStateFile(path, text) as CompanyStateFileResult;
	expect(result).not.toBeNull();
	if (result.ok) throw new Error(`expected ${path} to be refused`);
	expect(result.problems.length).toBeGreaterThan(0);
	return result.problems;
}

function keys(problems: readonly { key: string | null; code: string }[]) {
	return problems.map((problem) => [problem.key, problem.code]);
}

const agentText = `---
id: ${ANNA}
name: Anna Berg
role: Head of Sales
kind: agent
status: active
colour: coral
figure: flame
model: gpt-6-sol
effort: low
---
You run sales for Nordlys. You find clinics that
still book by phone and get them to a demo.

## How you work
- Answer new leads within the hour.
`;

const agentFields = (update: Record<string, string> = {}) =>
	`---\n${Object.entries({ id: ANNA, name: "Anna", role: "Sales", kind: "agent", status: "active", ...update })
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n")}\n---\nSell.\n`;

function agentBase(): Omit<AgentFile, "kind"> {
	return {
		id: ANNA,
		name: "Anna",
		role: "Sales",
		agentKind: "agent",
		status: "active",
		colour: null,
		figure: null,
		model: null,
		effort: null,
		instructions: "Sell.",
	};
}

describe("companyStatePath", () => {
	it("recognises every structured file and nothing else", () => {
		const kinds = Object.fromEntries(
			[
				"vision/vision.md",
				"agents/sections.md",
				"agents/anna-berg/agent.md",
				"agents/anna-berg/routines/morning-lead-sweep.md",
				"agents/anna-berg/todos/pricing-page.md",
				"agents/anna-berg/todos/pricing-page/w1/brief.md",
				"agents/anna-berg/todos/pricing-page/w1/results.md",
				"agents/groups/launch-team/group.md",
				"connections/gmail-sales-nordlys-dk.md",
				"rules/ask-before-emailing-customers.md",
				"Agents/Anna-Berg/Agent.md",
				"rules/.md",
				"vision/notes.md",
				"agents/anna-berg/memory/profile.md",
				"agents/anna-berg/routines/notes/x.md",
				"agents/anna-berg/todos/pricing-page/w1/draft.md",
				"agents/anna-berg/skills/cold-email/SKILL.md",
				"agents/groups/launch-team/notes.md",
				"agents/groups/agent.md",
				"connections/archive/old.md",
				"rules/readme.txt",
				"skills/x/SKILL.md",
			].map((path) => [path, companyStatePath(path)?.kind ?? null]),
		);
		expect(kinds).toEqual({
			"vision/vision.md": "vision",
			"agents/sections.md": "sections",
			"agents/anna-berg/agent.md": "agent",
			"agents/anna-berg/routines/morning-lead-sweep.md": "routine",
			"agents/anna-berg/todos/pricing-page.md": "todo",
			"agents/anna-berg/todos/pricing-page/w1/brief.md": "worker-brief",
			"agents/anna-berg/todos/pricing-page/w1/results.md": "worker-results",
			"agents/groups/launch-team/group.md": "group",
			"connections/gmail-sales-nordlys-dk.md": "connection",
			"rules/ask-before-emailing-customers.md": "rule",
			"Agents/Anna-Berg/Agent.md": "agent",
			"rules/.md": "rule",
			"vision/notes.md": null,
			"agents/anna-berg/memory/profile.md": null,
			"agents/anna-berg/routines/notes/x.md": null,
			"agents/anna-berg/todos/pricing-page/w1/draft.md": null,
			"agents/anna-berg/skills/cold-email/SKILL.md": null,
			"agents/groups/launch-team/notes.md": null,
			"agents/groups/agent.md": null,
			"connections/archive/old.md": null,
			"rules/readme.txt": null,
			"skills/x/SKILL.md": null,
		});
		expect(companyStatePath("agents/anna-berg/todos/pricing-page/w1/brief.md")).toMatchObject({
			agent: "anna-berg",
			todo: "pricing-page",
			worker: "w1",
		});
	});

	it("decides the kind on the folder's key, as the database does", () => {
		for (const path of ["ａｇｅｎｔｓ/anna/agent.md", "agentſ/anna/agent.md", "AGENTS/anna/AGENT.MD"]) {
			expect(companyPathKey(path)).toBe("agents/anna/agent.md");
			expect(companyStatePath(path)?.kind).toBe("agent");
		}
		// The names as written still follow the rule, and so does the extension.
		expect(refused("AGENTS/anna/AGENT.MD", agentText).map((problem) => problem.code)).toEqual(["name"]);
		expect(refused("rules/.md", "---\n---\n")[0]?.code).toBe("name");
	});

	it("checks a path on its own, for renames and for folders at structured places", () => {
		const codes = (path: string, folder = false) =>
			companyStatePathProblems(path, folder).map((problem) => problem.code);
		expect(codes("agents/anna/routines/daily.md")).toEqual([]);
		expect(codes("agents/anna/routines/Daily report.md")).toEqual(["name"]);
		expect(codes("agents/anna/routines/Daily.md")).toEqual(["name"]);
		expect(codes("agents/anna/Routines/daily.md")).toEqual(["name"]);
		expect(codes("sales/Leads.md")).toEqual([]);
		expect(codes("agents/anna", true)).toEqual([]);
		expect(codes("agents/Anna", true)).toEqual(["name"]);
		expect(codes("agents/anna/Routines", true)).toEqual(["name"]);
		expect(codes("agents/anna/todos/Old Stuff", true)).toEqual(["name"]);
		expect(codes("agents/groups/Launch", true)).toEqual(["name"]);
		expect(codes("agents/anna/Notes", true)).toEqual([]);
		expect(codes("Sales", true)).toEqual([]);
		expect(codes("agents/Anna/", true)).toEqual(["name"]);
		expect(companyStatePathProblems("agents/a/todos/T", true)[0]?.message).toContain("for example t");
		expect(companyStatePathProblems("agents/a/todos/t/日本", true)[0]?.message).toContain("for example worker");
		expect(companyStatePathProblems("agents/a/todos/日本", true)[0]?.message).toContain("for example todo");
	});

	it("leaves ordinary files alone", () => {
		expect(parseCompanyStateFile("sales/leads/list.md", "anything")).toBeNull();
	});
});

describe("names", () => {
	it("makes plain-Latin folder names", () => {
		expect(companyStateName("Anna Berg")).toBe("anna-berg");
		expect(companyStateName("Søren Ærø-Ågård")).toBe("soeren-aeroe-aagaard");
		expect(companyStateName("Åsa")).toBe("aasa");
		expect(companyStateName("José Müller")).toBe("jose-muller");
		expect(companyStateName("  R&D   team!! ")).toBe("rd-team");
		expect(companyStateName("日本")).toBe("");
		expect(companyStateName("a".repeat(80))).toHaveLength(64);
		expect(companyStateName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
	});

	it("numbers a taken name and falls back when nothing is left", () => {
		expect(freeCompanyStateName("Anna Berg", "agent", new Set(["anna-berg", "anna-berg-2"]))).toBe("anna-berg-3");
		expect(freeCompanyStateName("日本", "agent", new Set(["agent"]))).toBe("agent-2");
		expect(freeCompanyStateName("Groups", "agent", new Set(["groups"]))).toBe("groups-2");
		expect(freeCompanyStateName("a".repeat(70), "agent", new Set(["a".repeat(64)]))).toBe(`${"a".repeat(62)}-2`);
		expect(isCompanyStateName("anna-berg")).toBe(true);
		expect(isCompanyStateName("Anna")).toBe(false);
		expect(isCompanyStateName("a--b")).toBe(false);
	});

	it("suggests a name of the right kind", () => {
		const text = `---\nid: ${GROUP}\nname: L\nagents: [${ANNA}, ${IDA}]\n---\nx\n`;
		expect(refused("agents/groups/日本/group.md", text)[0]?.message).toContain("for example group");
		expect(refused("agents/groups/Launch Team/group.md", text)[0]?.message).toContain("for example launch-team");
	});
});

describe("agent.md", () => {
	it("reads the settings and the instructions", () => {
		expect(ok("agents/anna-berg/agent.md", agentText)).toEqual({
			kind: "agent",
			id: ANNA,
			name: "Anna Berg",
			role: "Head of Sales",
			agentKind: "agent",
			status: "active",
			colour: "coral",
			figure: "flame",
			model: "gpt-6-sol",
			effort: "low",
			instructions:
				"You run sales for Nordlys. You find clinics that\nstill book by phone and get them to a demo.\n\n## How you work\n- Answer new leads within the hour.",
		});
	});

	it("reads CRLF files, a byte-order mark, notes and quotes", () => {
		const text = `\ufeff---\r\n# who\r\nid: ${ANNA} # never changes\r\nname: "Anna \\"AB\\" Berg"\r\nrole: 'Head of ''Sales'''\r\nkind: agent\r\nstatus: active\r\n---\r\n\r\n    Sell.\r\n`;
		expect(ok("agents/anna-berg/agent.md", text)).toMatchObject({
			id: ANNA,
			name: 'Anna "AB" Berg',
			role: "Head of 'Sales'",
			instructions: "Sell.",
		});
	});

	it("writes a file that reads back the same", () => {
		const file = ok("agents/anna-berg/agent.md", agentText) as AgentFile;
		const { kind: _kind, ...fields } = file;
		expect(ok("agents/anna-berg/agent.md", writeAgentFile(fields))).toEqual(file);
		for (const name of [
			"Ops: #1",
			"true",
			"- lead",
			"#1 fan",
			",Anna",
			"[team]",
			"C# dev",
			"ÆØÅ",
			"a\\b",
			"'quoted'",
			'"x"',
		])
			expect(ok("agents/a/agent.md", writeAgentFile({ ...fields, name }))).toMatchObject({ name });
		const bare = { ...fields, colour: null, figure: null, model: null, effort: null };
		expect(ok("agents/anna-berg/agent.md", writeAgentFile(bare))).toEqual({ ...bare, kind: "agent" });
	});

	it("names each problem with its line, the same way every time", () => {
		const text =
			"---\nname: Anna\nrole: Sales\nkind: agent\nstatus: on leave\nteam: sales\nname: Again\n---\nSell.\n";
		const problems = refused("agents/anna-berg/agent.md", text);
		expect(problems.map((problem) => [problem.line, problem.key, problem.code])).toEqual([
			[7, "name", "duplicate_key"],
			[null, "id", "missing"],
			[5, "status", "value"],
			[6, "team", "unknown_key"],
		]);
		expect(problems.find((problem) => problem.key === "team")?.message).toContain(
			"allowed: colour, effort, figure, id",
		);
		expect(parseCompanyStateFile("agents/anna-berg/agent.md", agentFields({ id: "ANNA" }))).toEqual(
			parseCompanyStateFile("agents/anna-berg/agent.md", agentFields({ id: "ANNA" })),
		);
		expect(refused("agents/a/agent.md", agentFields({ id: ANNA.toUpperCase() }))[0]?.message).toBe(
			"id must be written in lowercase",
		);
	});

	it("refuses values YAML would read differently", () => {
		expect(keys(refused("agents/a/agent.md", agentFields({ name: "42", role: "null" })))).toEqual([
			["name", "quote"],
			["role", "quote"],
		]);
		expect(keys(refused("agents/a/agent.md", agentFields({ name: '"  padded  "' })))).toEqual([["name", "value"]]);
		expect(keys(refused("agents/a/agent.md", agentFields({ name: ",Anna" })))).toEqual([
			["name", "syntax"],
			["name", "missing"],
		]);
		expect(keys(refused("agents/a/agent.md", agentFields({ name: '"a\\tb"' })))).toEqual([["name", "value"]]);
		expect(keys(refused("agents/a/agent.md", agentFields({ colour: "[]" })))).toEqual([["colour", "missing"]]);
		expect(keys(refused("agents/a/agent.md", agentFields({ effort: "" })))).toEqual([["effort", "missing"]]);
		expect(keys(refused("agents/a/agent.md", agentFields({ figure: "brain" })))).toEqual([["figure", "value"]]);
	});

	it("refuses escapes that make half a character", () => {
		expect(refused("agents/a/agent.md", agentFields({ name: '"\\ud800"' }))[0]?.message).toBe(
			"a \\u escape is half of a character",
		);
		expect(ok("agents/a/agent.md", agentFields({ name: '"\\ud83d\\ude00 A"' }))).toMatchObject({ name: "😀 A" });
		expect(refused("agents/a/agent.md", agentFields({ name: '"\\x41"' }))[0]?.code).toBe("syntax");
		expect(refused("agents/a/agent.md", `${agentFields()}\ud800`)[0]?.code).toBe("encoding");
	});

	it("refuses broken settings blocks", () => {
		expect(refused("agents/anna-berg/agent.md", "no settings")[0]?.code).toBe("front_matter");
		expect(refused("agents/anna-berg/agent.md", "---\nid: x\n")[0]?.code).toBe("front_matter");
		const syntax = refused(
			"agents/anna-berg/agent.md",
			`---\nid: ${ANNA}\n\tname: A\nrole: {a: 1}\nkind: agent\nstatus: active\nfree text\n  - stray\nname:x\n  indented: 1\nx\u2028y: 1\n---\nx\n`,
		);
		expect(syntax.filter((problem) => problem.code === "syntax").map((problem) => problem.line)).toEqual([
			3, 4, 7, 8, 9, 10, 11,
		]);
	});

	it("refuses control characters anywhere in a settings line, notes included", () => {
		expect(refused("agents/a/agent.md", agentFields({ name: "a\rb" }))[0]?.code).toBe("syntax");
		expect(refused("agents/a/agent.md", agentFields({ name: "a # note\u0007" }))[0]?.code).toBe("syntax");
	});

	it("wants an empty list written as []", () => {
		const group = `---\nid: ${GROUP}\nname: L\nagents: [${ANNA}, ${IDA}]\npeople:\n---\nx\n`;
		expect(keys(refused("agents/groups/l/group.md", group))).toEqual([["people", "missing"]]);
		expect(ok("agents/groups/l/group.md", group.replace("people:", "people: []"))).toMatchObject({ people: [] });
	});

	it("wants the fixed names in lowercase, as written", () => {
		for (const path of ["agents/anna/Agent.md", "Agents/anna/agent.md"]) {
			expect(companyStatePath(path)?.kind).toBe("agent");
			expect(refused(path, agentText)[0]?.code).toBe("name");
		}
		expect(refused("ａｇｅｎｔｓ/anna/agent.md", agentText)[0]?.message).toBe(
			"write the path in lowercase, as agents/anna/agent.md",
		);
	});

	it("keeps list items lined up, as YAML reads them", () => {
		const group = (list: string) => `---\nid: ${GROUP}\nname: L\nagents:\n${list}\n---\nx\n`;
		expect(refused("agents/groups/l/group.md", group(`  - ${ANNA}\n    - ${IDA}`))[0]?.message).toBe(
			"list items must line up under the first one",
		);
		expect(ok("agents/groups/l/group.md", group(`- ${ANNA}\n- ${IDA}`))).toMatchObject({ agents: [ANNA, IDA] });
		expect(ok("agents/groups/l/group.md", group(`  - ${ANNA}\n  # the second\n\n  - ${IDA}`))).toMatchObject({
			agents: [ANNA, IDA],
		});
		expect(
			refused("agents/groups/l/group.md", `---\nid: ${GROUP}\nname: L\nagents: [${ANNA}, a{b}]\n---\nx\n`)[0]?.code,
		).toBe("syntax");
	});

	it("refuses an empty body and a folder name that breaks the rule", () => {
		expect(refused("agents/anna-berg/agent.md", agentText.replace(/---\nYou[\s\S]*$/, "---\n"))[0]?.code).toBe(
			"body",
		);
		const name = refused("agents/Anna Berg/agent.md", agentText);
		expect(name[0]).toMatchObject({ code: "name" });
		expect(name[0]?.message).toContain("anna-berg");
	});

	it("refuses files that are too large or not text", () => {
		expect(refused("agents/a/agent.md", `${agentText}${"x".repeat(70_000)}`)[0]?.code).toBe("too_large");
		expect(refused("agents/a/agent.md", "---\u0000")[0]?.code).toBe("encoding");
		expect(ok("agents/a/agent.md", `${agentFields()}�`)).toMatchObject({ instructions: "Sell.\n�" });
	});

	it("reports at most 50 problems, and shortens quoted input", () => {
		const lines = `---\n${"x\n".repeat(30_000)}---\nx\n`;
		const problems = refused("agents/a/agent.md", lines);
		expect(problems).toHaveLength(51);
		expect(problems.at(-1)?.message).toMatch(/^and \d+ more problems$/);
		const long = refused("agents/a/agent.md", agentFields({ [`k${"x".repeat(5000)}`]: "v" }));
		expect(long[0]?.message.length).toBeLessThan(400);
		const twice = `---\n${`k${"x".repeat(5000)}: 1\n`.repeat(2)}---\nx\n`;
		expect(JSON.stringify(refused("agents/a/agent.md", twice)).length).toBeLessThan(3000);
		expect(JSON.stringify(long).length).toBeLessThan(2000);
	});

	it("keeps Unicode spaces, as YAML does, and refuses them at the edges", () => {
		expect(ok("agents/a/agent.md", agentFields({ name: "a\u00a0#b" }))).toMatchObject({ name: "a\u00a0#b" });
		expect(keys(refused("agents/a/agent.md", agentFields({ name: "Anna\u00a0" })))).toEqual([["name", "value"]]);
		expect(refused("agents/a/agent.md", agentFields({ note: "x" }).replace("note: x", "\u00a0# note"))[0]?.code).toBe(
			"syntax",
		);
		const group = `---\nid: ${GROUP}\nname: L\nagents:\n  - \u00a0${ANNA}\n  - ${IDA}\n---\nx\n`;
		expect(refused("agents/groups/l/group.md", group)[0]?.key).toBe("agents");
		expect(refused("agents/a/agent.md", agentFields({ name: "a # note\ufffe" }))[0]?.code).toBe("syntax");
		expect(refused("vision/vision.md", `#${" ".repeat(10)}\rx\n`)[0]?.code).toBe("body");
	});

	it("reads a pathological 64 KiB file in linear time", () => {
		const spaces = " ".repeat(65_000);
		const inputs: [string, string][] = [
			["vision/vision.md", `# a${spaces}b`],
			["agents/sections.md", `## a${spaces}b`],
			["agents/sections.md", `## Sales\n- ${ANNA}${spaces}x`],
			["agents/a/agent.md", `---\nname: a${spaces}b\n---\n`],
			["agents/a/agent.md", `---\nname: a${":".repeat(65_000)}\n---\n`],
			["agents/a/agent.md", `---\nname: ${"1".repeat(65_000)}x\n---\n`],
			["agents/a/agent.md", `---\nagents: [${"a,".repeat(30_000)}]\n---\n`],
			["agents/a/agent.md", `---\nname:${spaces}\rx\n---\nx\n`],
			["agents/a/agent.md", `---\nagents:\n  -${spaces}\rx\n---\nx\n`],
			["agents/a/agent.md", `---\nname: a # ${spaces}\rx\n---\nx\n`],
			["agents/a/agent.md", `---\nname: a${spaces}\n---\nx\n`],
			["agents/a/agent.md", `---\nname:${spaces}a${spaces}\n---\nx\n`],
			["agents/a/agent.md", `---\n${"x\n".repeat(30_000)}---\nx\n`],
			["agents/sections.md", `## Sales\n- ${ANNA}\t${spaces}\rx`],
		];
		for (const [path, text] of inputs) {
			const started = performance.now();
			parseCompanyStateFile(path, text);
			expect(performance.now() - started).toBeLessThan(250);
		}
	});
});

describe("vision.md", () => {
	it("takes the company's name from the first line", () => {
		const text = writeVisionFile("Nordlys Studio", "## What we build\nBooking software.");
		expect(text).toBe("# Nordlys Studio\n\n## What we build\nBooking software.\n");
		expect(ok("vision/vision.md", `\n\n${text}`)).toEqual({ kind: "vision", name: "Nordlys Studio" });
		expect(ok("vision/vision.md", "# C# Makers\n")).toEqual({ kind: "vision", name: "C# Makers" });
		expect(ok("vision/vision.md", "# Nordlys ##\n")).toEqual({ kind: "vision", name: "Nordlys" });
		expect(ok("vision/vision.md", "#   Nordlys   \n")).toEqual({ kind: "vision", name: "Nordlys" });
		expect(refused("vision/vision.md", "Nordlys\n")[0]).toMatchObject({ code: "body", line: 1 });
		expect(refused("vision/vision.md", "## Nordlys\n")[0]?.code).toBe("body");
		expect(refused("vision/vision.md", "# \n")[0]?.code).toBe("body");
		expect(refused("vision/vision.md", `# ${"n".repeat(121)}\n`)[0]?.code).toBe("body");
	});
});

describe("sections.md", () => {
	const text = `# Sections

Each line is an id. The words after it are only for reading.

### Notes before the sections are free text

## Sales
- ${ANNA} Anna Berg
- ${TOM} Tom Holm
* ${GROUP} Launch team (group chat)

## Product
- ${IDA} Ida Lund

## Later
`;

	it("reads sections in order, with their members", () => {
		expect(ok("agents/sections.md", text)).toEqual({
			kind: "sections",
			sections: [
				{
					name: "Sales",
					line: 7,
					members: [
						{ id: ANNA, line: 8 },
						{ id: TOM, line: 9 },
						{ id: GROUP, line: 10 },
					],
				},
				{ name: "Product", line: 12, members: [{ id: IDA, line: 13 }] },
				{ name: "Later", line: 15, members: [] },
			],
		});
		const names = new Map([
			[ANNA, "Anna Berg"],
			[IDA, "Ida Lund"],
		]);
		const file = ok("agents/sections.md", text);
		if (file.kind !== "sections") throw new Error("kind");
		const written = writeSectionsFile(file, names);
		expect(written).toContain(`- ${ANNA} Anna Berg\n`);
		expect(
			(ok("agents/sections.md", written) as typeof file).sections.map((section) => section.members.length),
		).toEqual([3, 1, 0]);
	});

	it("refuses lines it cannot place", () => {
		const problems = refused(
			"agents/sections.md",
			`- ${ANNA}\n## Sales\n- ${TOM}\nsome prose\n- ${TOM}\n## sales\n### Deep\n##\n##Team\n## A\tB\n## X\n- ${ANNA.toUpperCase()}\n`,
		);
		expect(problems.map((problem) => problem.line)).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 12]);
		expect(problems.at(-1)?.message).toBe("ids are written in lowercase");
	});
});

describe("group.md", () => {
	it("reads members as two lists and the purpose", () => {
		const text = `---
id: ${GROUP}
name: Launch team
subtitle: Getting version 2 out
agents:
  - ${ANNA} # Anna Berg
  - ${IDA} # Ida Lund
people:
  - ${JONAS} # Jonas
---
Plan and ship version 2 by 1 November.
`;
		const file = ok("agents/groups/launch-team/group.md", text);
		expect(file).toEqual({
			kind: "group",
			id: GROUP,
			name: "Launch team",
			subtitle: "Getting version 2 out",
			agents: [ANNA, IDA],
			people: [JONAS],
			purpose: "Plan and ship version 2 by 1 November.",
		});
		if (file.kind !== "group") throw new Error("kind");
		const { kind: _kind, ...fields } = file;
		const written = writeGroupFile(fields, new Map([[ANNA, "Anna Berg"]]));
		expect(written).toContain(`  - ${ANNA} # Anna Berg\n`);
		expect(ok("agents/groups/launch-team/group.md", written)).toEqual(file);
		for (const subtitle of [null, ""])
			expect(
				ok("agents/groups/launch-team/group.md", writeGroupFile({ ...fields, subtitle, people: [] })),
			).toMatchObject({
				people: [],
				subtitle,
			});
	});

	it("needs two agents, ids and a purpose", () => {
		const problems = refused(
			"agents/groups/launch-team/group.md",
			`---\nid: ${GROUP}\nname: Launch\nagents: [${ANNA}, nope, ${ANNA}]\n---\n`,
		);
		expect(keys(problems)).toEqual([
			["agents", "value"],
			["agents", "value"],
			[null, "body"],
		]);
		expect(
			refused("agents/groups/launch/group.md", `---\nid: ${GROUP}\nname: Launch\nagents: [${ANNA}]\n---\nx\n`)[0]
				?.message,
		).toBe("a group chat needs at least two agents");
		expect(
			keys(refused("agents/groups/launch/group.md", `---\nid: ${GROUP}\nname: Launch\nagents: []\n---\nx\n`)),
		).toEqual([["agents", "value"]]);
	});
});

describe("connections, rules, todos and worker files", () => {
	it("reads a connection and writes it back", () => {
		const file = {
			id: ID,
			service: "gmail",
			account: "sales@nordlys.dk",
			status: "connected" as const,
			actions: ["search_messages", "read_message", "send_message"],
			connectedBy: JONAS,
			connectedAt: "2026-09-28T10:14:00Z",
			purpose: "The shared sales inbox.",
		};
		expect(ok("connections/gmail-sales-nordlys-dk.md", writeConnectionFile(file))).toEqual({
			kind: "connection",
			...file,
		});
		const block = `---\nid: ${ID}\nservice: google_drive\naccount: a@b.dk\nstatus: broken\nactions:\n  - list_files\nconnected_by: ${JONAS}\nconnected_at: 2026-02-30T10:00Z\n---\n`;
		expect(refused("connections/drive.md", block).map((problem) => problem.key)).toEqual(["connected_at"]);
		expect(ok("connections/drive.md", block.replace("02-30", "02-28"))).toMatchObject({
			actions: ["list_files"],
			purpose: "",
			connectedAt: "2026-02-28T10:00:00Z",
		});
	});

	it("keeps a rule to how the sentence ends", () => {
		const file = { id: ID, outcome: "ask-first" as const, text: "send an email to a customer." };
		expect(ok("rules/ask-before-emailing-customers.md", writeRuleFile(file))).toEqual({ kind: "rule", ...file });
		expect(ok("rules/r.md", `---\nid: ${ID}\noutcome: allow\n---\n\n\n   ${"x".repeat(280)}   \n`)).toMatchObject({
			text: "x".repeat(280),
		});
		for (const text of ["One.\nTwo.", "a\tb", "x".repeat(281)])
			expect(refused("rules/r.md", `---\nid: ${ID}\noutcome: ask-first\n---\n${text}\n`)[0]?.code).toBe("body");
		expect(refused("rules/r.md", `---\nid: ${ID}\noutcome: deny\n---\nOne.\n`)[0]?.key).toBe("outcome");
	});

	it("reads a todo, counting its title in bytes", () => {
		const file = {
			id: ID,
			title: "Draft the pricing page",
			status: "open" as const,
			requestedBy: JONAS,
			detail: "One page.\nDone when Jonas approves.",
		};
		const text = writeTodoFile(file, "Jonas");
		expect(text).toContain(`requested_by: ${JONAS} # Jonas\n`);
		expect(ok("agents/anna-berg/todos/pricing-page.md", text)).toEqual({ kind: "todo", ...file });
		expect(ok("agents/a/todos/t.md", writeTodoFile({ ...file, requestedBy: null, detail: "" }))).toMatchObject({
			requestedBy: null,
			detail: "",
		});
		expect(ok("agents/a/todos/t.md", writeTodoFile({ ...file, title: "ø".repeat(100) }))).toMatchObject({
			title: "ø".repeat(100),
		});
		expect(refused("agents/a/todos/t.md", writeTodoFile({ ...file, title: "ø".repeat(150) }))[0]?.message).toBe(
			"title must be 1–200 bytes",
		);
		expect(refused("agents/a/todos/t.md", `---\nid: ${ID}\ntitle: T\nstatus: waiting\n---\n`)[0]?.key).toBe("status");
	});

	it("reads a worker's brief and results", () => {
		const brief = {
			id: ID,
			title: "Collect clinic prices",
			species: "in-house" as const,
			access: "write" as const,
			revival: "each" as const,
			dispatchedAt: "2026-09-28T10:00:00.123Z",
			brief: "## Goal\nCollect prices.",
		};
		expect(ok("agents/a/todos/t/w1/brief.md", writeWorkerBriefFile(brief))).toEqual({
			kind: "worker-brief",
			...brief,
		});
		const results = {
			outcome: "succeeded" as const,
			reportedAt: "2026-09-28T11:00:00Z",
			decision: "accepted" as const,
			note: "Good: #1 source",
			report: "## Summary\nDone.",
		};
		expect(ok("agents/a/todos/t/w1/results.md", writeWorkerResultsFile(results))).toEqual({
			kind: "worker-results",
			...results,
		});
		expect(
			refused(
				"agents/a/todos/t/w1/results.md",
				"---\noutcome: succeeded\nreported_at: 2026-09-28T11:00:00Z\nnote: x\n---\nr\n",
			)[0]?.key,
		).toBe("note");
		expect(refused("agents/a/todos/T/w1/brief.md", writeWorkerBriefFile(brief))[0]?.code).toBe("name");
	});
});

describe("routines", () => {
	const weekly = `---
id: ${ID}
title: Morning lead sweep
status: active
when: weekly
days: [mon, tue, wed, thu, fri]
time: "08:00"
timezone: Europe/Copenhagen
quiet: "22:00-07:00"
effort: medium
reply: optional
---
Go through new leads in sales/leads/.
`;
	const routine = (lines: string) => `---\nid: ${ID}\ntitle: T\nstatus: active\n${lines}\n---\nx\n`;

	it("reads a weekly routine", () => {
		expect(ok("agents/anna-berg/routines/morning-lead-sweep.md", weekly)).toEqual({
			kind: "routine",
			id: ID,
			title: "Morning lead sweep",
			status: "active",
			trigger: { when: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00", starts: null },
			timezone: "Europe/Copenhagen",
			ends: null,
			runs: null,
			quiet: { start: "22:00", end: "07:00", timezone: "Europe/Copenhagen" },
			effort: "medium",
			reply: "optional",
			conclusion: null,
			instructions: "Go through new leads in sales/leads/.",
		});
	});

	it("writes every trigger so it reads back the same", () => {
		const base: Omit<RoutineFile, "kind" | "trigger"> = {
			id: ID,
			title: "Watch",
			status: "active",
			timezone: "Europe/Copenhagen",
			ends: null,
			runs: null,
			quiet: null,
			effort: "low",
			reply: "silent",
			conclusion: null,
			instructions: "Look.",
		};
		const triggers: RoutineFile["trigger"][] = [
			{ when: "every", minutes: 30, starts: "2026-09-29T06:00:00Z" },
			{ when: "weekly", days: ["sat"], time: "09:30", starts: null },
			{ when: "window", minutes: 60, from: "09:00", to: "17:00", days: ["mon"], months: [1, 12] },
			{ when: "once", at: "2026-09-30T07:00:00.123456Z" },
			{ when: "file-change", watch: "sales/leads", match: "exact" },
		];
		for (const trigger of triggers) {
			const file = { ...base, trigger };
			expect(ok("agents/a/routines/r.md", writeRoutineFile(file))).toEqual({ kind: "routine", ...file });
		}
		const concluded = {
			...base,
			trigger: { when: "every", minutes: 5, starts: null } as const,
			timezone: null,
			status: "concluded" as const,
			conclusion: "Fysio Nord signed.",
			ends: "2026-12-31T00:00:00Z",
			quiet: { start: "22:00", end: "07:00", timezone: "Europe/Oslo" },
		};
		const written = writeRoutineFile(concluded);
		expect(written).toContain("quiet_timezone: Europe/Oslo\n");
		expect(ok("agents/a/routines/r.md", written)).toEqual({ kind: "routine", ...concluded });
	});

	it("gives instants one form, so a new spelling is not a new timing", () => {
		expect(canonicalCompanyStateInstant("2026-09-30T07:00Z")).toBe("2026-09-30T07:00:00Z");
		expect(canonicalCompanyStateInstant("2026-09-30T07:00:00.000Z")).toBe("2026-09-30T07:00:00Z");
		expect(canonicalCompanyStateInstant("2026-09-30T07:00:00.500Z")).toBe("2026-09-30T07:00:00.5Z");
		expect(canonicalCompanyStateInstant("0099-01-01T00:00Z")).toBe("0099-01-01T00:00:00Z");
		expect(canonicalCompanyStateInstant("0000-01-01T00:00Z")).toBeNull();
		expect(canonicalCompanyStateInstant("2024-02-29T00:00Z")).toBe("2024-02-29T00:00:00Z");
		expect(canonicalCompanyStateInstant("2026-02-29T00:00Z")).toBeNull();
		expect(canonicalCompanyStateInstant("2026-09-30T24:00:00Z")).toBeNull();
		expect(canonicalCompanyStateInstant("2026-09-30T07:00:60Z")).toBeNull();
		expect(canonicalCompanyStateInstant("2026-09-30T07:00:00+02:00")).toBeNull();
		expect(ok("agents/a/routines/r.md", routine("when: once\nat: 2026-09-30T07:00Z\ntimezone: UTC"))).toMatchObject({
			trigger: { at: "2026-09-30T07:00:00Z" },
		});
	});

	it("compares at and ends to the microsecond", () => {
		expect(
			ok(
				"agents/a/routines/r.md",
				routine("when: once\nat: 2026-09-30T07:00:00Z\nends: 2026-09-30T07:00:00.000001Z\ntimezone: UTC"),
			),
		).toMatchObject({ ends: "2026-09-30T07:00:00.000001Z" });
		for (const ends of ["2026-09-30T07:00:00Z", "2026-09-30T06:59:59.999999Z"])
			expect(
				refused(
					"agents/a/routines/r.md",
					routine(`when: once\nat: 2026-09-30T07:00:00Z\nends: ${ends}\ntimezone: UTC`),
				)[0]?.key,
			).toBe("at");
	});

	it("defaults effort and reply, and asks for match", () => {
		expect(
			ok("agents/a/routines/r.md", routine("when: file-change\nwatch: sales/\nmatch: subtree\ntimezone: UTC")),
		).toMatchObject({
			effort: "medium",
			reply: "optional",
			trigger: { when: "file-change", watch: "sales", match: "subtree" },
		});
		expect(
			keys(refused("agents/a/routines/r.md", routine("when: file-change\nwatch: sales\ntimezone: UTC"))),
		).toEqual([["match", "missing"]]);
		for (const empty of ["effort:", "effort: []", "reply:", "match:"])
			expect(
				refused(
					"agents/a/routines/r.md",
					routine(`when: file-change\nwatch: sales\nmatch: exact\ntimezone: UTC\n${empty}`),
				).length,
			).toBeGreaterThan(0);
	});

	it("refuses settings of another trigger and broken combinations", () => {
		expect(
			keys(
				refused(
					"agents/a/routines/r.md",
					routine(
						"when: once\nat: 2026-09-30T07:00:00Z\nminutes: 5\nruns: 3\nends: 2026-09-01T00:00:00Z\nconclusion: early",
					),
				),
			),
		).toEqual([
			["minutes", "unknown_key"],
			["timezone", "missing"],
			["runs", "value"],
			["at", "value"],
			["conclusion", "value"],
		]);
		expect(
			keys(
				refused(
					"agents/a/routines/r.md",
					`---\nid: ${ID}\ntitle: T\nstatus: concluded\nwhen: every\nminutes: 4\n---\nx\n`,
				),
			),
		).toEqual([
			["minutes", "value"],
			["conclusion", "missing"],
		]);
		expect(keys(refused("agents/a/routines/r.md", routine('when: every\nminutes: "30"')))).toEqual([
			["minutes", "value"],
		]);
		expect(keys(refused("agents/a/routines/r.md", routine('when: every\nminutes: 5\nquiet: "22:00-07:00"')))).toEqual(
			[["timezone", "missing"]],
		);
		expect(
			ok(
				"agents/a/routines/r.md",
				routine('when: every\nminutes: 5\nquiet: "22:00-07:00"\nquiet_timezone: Europe/Oslo'),
			),
		).toMatchObject({ timezone: null, quiet: { timezone: "Europe/Oslo" } });
		expect(
			keys(
				refused(
					"agents/a/routines/r.md",
					routine('when: weekly\ndays: [mon, funday, mon]\ntime: "25:00"\ntimezone: mars/olympus'),
				),
			),
		).toEqual([
			["days", "value"],
			["days", "value"],
			["time", "value"],
			["timezone", "value"],
		]);
		expect(refused("agents/a/routines/r.md", routine("when: hourly"))[0]?.key).toBe("when");
		expect(
			keys(
				refused(
					"agents/a/routines/r.md",
					routine('when: window\nminutes: 60\nfrom: "09:00"\nto: "17:00"\nmonths: []\ntimezone: UTC'),
				),
			),
		).toEqual([["months", "value"]]);
		for (const effort of ["xhigh", "max"])
			expect(refused("agents/a/routines/r.md", routine(`when: every\nminutes: 5\neffort: ${effort}`))[0]?.key).toBe(
				"effort",
			);
		expect(refused("agents/a/routines/r.md", routine(`when: every\nminutes: 5\ntitle2: x`))[0]?.code).toBe(
			"unknown_key",
		);
	});

	it("counts the title and the conclusion in bytes", () => {
		const text = routine("when: every\nminutes: 5").replace("title: T", `title: ${"é".repeat(81)}`);
		expect(refused("agents/a/routines/r.md", text)[0]).toMatchObject({
			key: "title",
			message: "title must be 1–160 bytes",
		});
	});
});

describe("time zones", () => {
	it("have the list's shape in the parser, the same in every engine", () => {
		for (const name of [
			"Europe/Copenhagen",
			"UTC",
			"EST5EDT",
			"Etc/GMT+5",
			"America/Argentina/ComodRivadavia",
			"Mars/Olympus",
		])
			expect(isCompanyStateTimeZoneName(name)).toBe(true);
		for (const name of [
			"europe/copenhagen",
			"etc/utc",
			"gmt",
			"us/pacific",
			"asia/kolkata",
			"est5edt",
			"Europe//Oslo",
			"/UTC",
		])
			expect(isCompanyStateTimeZoneName(name)).toBe(false);
	});

	it("get an engine hint for editors", () => {
		expect(companyStateTimeZoneProblem("Europe/Copenhagen")).toBeNull();
		expect(companyStateTimeZoneProblem("europe/copenhagen")).toBe("write the time zone as Europe/Copenhagen");
		expect(companyStateTimeZoneProblem("us/pacific")).toContain("unknown time zone");
		expect(companyStateTimeZoneProblem("Mars/Olympus")).toContain("unknown time zone");
	});
});

describe("companyStateValue", () => {
	it("quotes what would not read back the same, and escapes controls", () => {
		expect(companyStateValue("Anna Berg")).toBe("Anna Berg");
		expect(companyStateValue("a\tb")).toBe('"a\\tb"');
		expect(companyStateValue("a\u2028b")).toBe('"a\\u2028b"');
		expect(companyStateValue("a\u0085b")).toBe('"a\\u0085b"');
		for (const text of [
			"yes",
			"No",
			"on",
			"OFF",
			"08:00",
			"8:00",
			"1:30:00",
			"010",
			"0b101",
			"-0x1F",
			"1_000",
			"=",
			"<<",
		])
			expect(companyStateValue(text)).toBe(`"${text}"`);
		for (const text of ["Anna", "v2", "2026 plan", "a=b"]) expect(companyStateValue(text)).toBe(text);
		for (const text of [
			`${"1".repeat(65_000)}x`,
			`${"1_".repeat(30_000)}x`,
			`0x${"f".repeat(65_000)}g`,
			`${"1:".repeat(30_000)}x`,
		]) {
			const started = performance.now();
			companyStateValue(text);
			expect(performance.now() - started).toBeLessThan(250);
		}
		// A value the format refuses still makes a file the parser reads; the parse refuses the value.
		expect(keys(refused("agents/a/agent.md", writeAgentFile({ ...agentBase(), name: "Anna\u2028Berg" })))).toEqual([
			["name", "value"],
		]);
		expect(keys(refused("agents/a/agent.md", writeAgentFile({ ...agentBase(), name: "Anna\tBerg" })))).toEqual([
			["name", "value"],
		]);
		for (const name of ["Anna\ufffe", "Anna\uffff"]) {
			expect(companyStateValue(name)).toMatch(/^"Anna\\uff/);
			expect(ok("agents/a/agent.md", writeAgentFile({ ...agentBase(), name }))).toMatchObject({ name });
		}
		const group = writeGroupFile(
			{ id: GROUP, name: "L", subtitle: null, agents: [ANNA, IDA], people: [], purpose: "P" },
			new Map([[ANNA, "Anna\ufffeBerg"]]),
		);
		expect(ok("agents/groups/l/group.md", group)).toMatchObject({ agents: [ANNA, IDA] });
		for (const text of ["2026-09-30", "2026-9-3", "._5"]) expect(companyStateValue(text)).toBe(`"${text}"`);
		// A canonical instant stays plain, as the file writers write it.
		expect(companyStateValue("2026-09-30T07:00:00Z")).toBe("2026-09-30T07:00:00Z");
		expect(companyStateValue("2026-09-30T07:00Z")).toBe('"2026-09-30T07:00Z"');
	});
});

describe("heading writers", () => {
	it("write names that read back the same, and refuse names that are not one line", () => {
		for (const name of ["Sales #", "Top ##", "#", "C# team"]) {
			expect(ok("vision/vision.md", writeVisionFile(name, ""))).toEqual({ kind: "vision", name });
			const file = ok("agents/sections.md", writeSectionsFile({ sections: [{ name, line: 0, members: [] }] }));
			expect(file.kind === "sections" && file.sections[0]?.name).toBe(name);
		}
		expect(() => writeSectionsFile({ sections: [{ name: `Sales\n- ${ANNA}`, line: 0, members: [] }] })).toThrow();
		expect(() => writeVisionFile("Acme\nEvil", "")).toThrow();
		expect(() => writeVisionFile(" ", "")).toThrow();
		const names = new Map([[ANNA, "Anna\u0000\u0007\nBerg"]]);
		expect(
			writeSectionsFile({ sections: [{ name: "Sales", line: 0, members: [{ id: ANNA, line: 0 }] }] }, names),
		).toContain(`- ${ANNA} Anna Berg\n`);
		const group = writeGroupFile(
			{ id: GROUP, name: "L", subtitle: null, agents: [ANNA, IDA], people: [], purpose: "P" },
			names,
		);
		expect(ok("agents/groups/l/group.md", group)).toMatchObject({ agents: [ANNA, IDA] });
	});
});

describe("setCompanyStateSettings", () => {
	it("changes one setting and keeps every other byte", () => {
		const text = `---\nid: ${ANNA}   # keep this note\nname: Anna Berg\nstatus: active # was paused\nagents:\n  - ${IDA}\n---\nBody stays.\n`;
		expect(setCompanyStateSettings(text, { status: "paused" })).toBe(
			text.replace("status: active # was paused", "status: paused"),
		);
		expect(setCompanyStateSettings(text, { agents: null, subtitle: "Q4: launch" })).toBe(
			`---\nid: ${ANNA}   # keep this note\nname: Anna Berg\nstatus: active # was paused\nsubtitle: "Q4: launch"\n---\nBody stays.\n`,
		);
		expect(() => setCompanyStateSettings("# vision\n", { status: "x" })).toThrow();
		expect(() => setCompanyStateSettings(text, { "bad key": "x" })).toThrow();
	});

	it("keeps a byte-order mark and each line's own ending", () => {
		const text = `\ufeff---\r\nid: ${ANNA}\nstatus: active\r\n---\r\nBody\n`;
		expect(setCompanyStateSettings(text, { status: "paused", effort: "low" })).toBe(
			`\ufeff---\r\nid: ${ANNA}\nstatus: paused\r\neffort: low\r\n---\r\nBody\n`,
		);
	});

	it("replaces a whole list, notes between its items included, and nothing after it", () => {
		const text = `---\nagents:\n  - ${ANNA}\n  # the next one\n\n  - ${IDA}\n# about people\npeople: []\n---\nx\n`;
		expect(setCompanyStateSettings(text, { agents: [TOM, JONAS] })).toBe(
			`---\nagents: [${TOM}, ${JONAS}]\n# about people\npeople: []\n---\nx\n`,
		);
	});

	it("takes whole numbers only, and list lines only under a key without a value", () => {
		const text = `---\nid: ${ANNA}\nstatus: active\n- stray\n---\nx\n`;
		expect(setCompanyStateSettings(text, { status: "archived" })).toBe(
			text.replace("status: active", "status: archived"),
		);
		for (const runs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5])
			expect(() => setCompanyStateSettings(text, { runs })).toThrow();
	});

	it("encodes values, so a value cannot add a setting", () => {
		const text = `---\nid: ${ANNA}\nstatus: active\n---\nx\n`;
		const changed = setCompanyStateSettings(text, { status: "paused\nkind: co-founder", runs: 3 });
		expect(changed).toBe(`---\nid: ${ANNA}\nstatus: "paused\\nkind: co-founder"\nruns: 3\n---\nx\n`);
	});
});

describe("companyStateSeedTree", () => {
	it("seeds the tree of contract 5.6, parents first, with files that parse", () => {
		const tree = companyStateSeedTree({ companyName: "Nordlys Studio", cofounderId: ANNA });
		const paths = tree.map((entry) => entry.path);
		for (const [index, entry] of tree.entries()) {
			const parent = entry.path.split("/").slice(0, -1).join("/");
			if (parent) expect(paths.slice(0, index)).toContain(parent);
			expect(companyStatePathProblems(entry.path, entry.kind === "folder")).toEqual([]);
			if (entry.kind === "file") expect(parseCompanyStateFile(entry.path, entry.text ?? "")?.ok).toBe(true);
		}
		for (const seeded of COMPANY_STATE_SEEDED_PATHS) expect(paths).toContain(seeded);
		expect(ok("vision/vision.md", tree.find((entry) => entry.path === "vision/vision.md")?.text ?? "")).toEqual({
			kind: "vision",
			name: "Nordlys Studio",
		});
		expect(
			ok(
				"agents/co-founder/agent.md",
				tree.find((entry) => entry.path === "agents/co-founder/agent.md")?.text ?? "",
			),
		).toMatchObject({ id: ANNA, agentKind: "co-founder", status: "active", colour: "blue", figure: "crown" });
		expect(ok("agents/sections.md", tree.find((entry) => entry.path === "agents/sections.md")?.text ?? "")).toEqual({
			kind: "sections",
			sections: [],
		});
	});

	it("seeds the founding table's vision, roles and the Co-Founder's first todo", () => {
		const tree = companyStateSeedTree({
			companyName: "Nordlys Studio",
			cofounderId: ANNA,
			vision: "  We book physiotherapy.\n\nFor small clinics.  ",
			founders: [
				{ displayName: "Jonas", role: "Product and sales" },
				{ displayName: "Ida\nLund", role: "" },
				{ displayName: " ", role: "ignored" },
			],
			firstTodo: { id: ID, requestedBy: JONAS },
		});
		const vision = tree.find((entry) => entry.path === "vision/vision.md")?.text ?? "";
		expect(ok("vision/vision.md", vision)).toEqual({ kind: "vision", name: "Nordlys Studio" });
		expect(vision).toBe(
			"# Nordlys Studio\n\nWe book physiotherapy.\n\nFor small clinics.\n\n## What we build\n\n## For whom\n\n## Why\n\n## How we work\n- Jonas: Product and sales\n- Ida Lund\n",
		);
		const todo = tree.find((entry) => entry.path === "agents/co-founder/todos/start-with-the-founders.md");
		expect(ok(todo?.path ?? "", todo?.text ?? "")).toMatchObject({ id: ID, status: "open", requestedBy: JONAS });
		const paths = tree.map((entry) => entry.path);
		expect(paths.indexOf("agents/co-founder/todos")).toBeLessThan(paths.indexOf(todo?.path ?? ""));
	});
});
