import { describe, expect, it } from "vitest";
import {
	type AgentFile,
	appendWorkerFollowUp,
	COMPANY_STATE_HUMAN_TASK_SKILL_PATH,
	COMPANY_STATE_SEEDED_PATHS,
	type CompanyStateFileResult,
	type ContactFile,
	canonicalCompanyStateInstant,
	companyPathKey,
	companyStateName,
	companyStatePath,
	companyStatePathProblems,
	companyStateSeedTree,
	companyStateTimeZoneProblem,
	companyStateValue,
	freeCompanyStateName,
	type HumanTaskFile,
	humanTaskFolder,
	humanTaskNotePath,
	humanTaskPersonChange,
	humanTaskProofPath,
	isCompanyStateName,
	isCompanyStateTimeZoneName,
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
	WORKER_BRIEF_SECTIONS,
	type WorkerBriefFile,
	workerKeyProblem,
	workerStandingTexts,
	workerTextHeading,
	writeAgentFile,
	writeConnectionFile,
	writeContactFile,
	writeGroupFile,
	writeHookFile,
	writeHumanTaskFile,
	writeMailboxFile,
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
				"connections/hook-stripe-payments.md",
				"connections/mailbox-support.md",
				"Connections/Hook-Forms.MD",
				"connections/hooks.md",
				"connections/mailbox.md",
				"rules/ask-before-emailing-customers.md",
				"human-tasks/fit-disk-node-2.md",
				"contacts/maria-jensen.md",
				"Human-Tasks/Fit-Disk.MD",
				"human-tasks/fit-disk-node-2/note.md",
				"human-tasks/fit-disk-node-2/proof/label.md",
				"contacts/archive/old.md",
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
			"connections/hook-stripe-payments.md": "hook",
			"connections/mailbox-support.md": "mailbox",
			"Connections/Hook-Forms.MD": "hook",
			"connections/hooks.md": "connection",
			"connections/mailbox.md": "connection",
			"rules/ask-before-emailing-customers.md": "rule",
			"human-tasks/fit-disk-node-2.md": "human-task",
			"contacts/maria-jensen.md": "contact",
			"Human-Tasks/Fit-Disk.MD": "human-task",
			"human-tasks/fit-disk-node-2/note.md": null,
			"human-tasks/fit-disk-node-2/proof/label.md": null,
			"contacts/archive/old.md": null,
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
		// The seeded agents/groups is spelled in lowercase; any other spelling is read as an agent's folder.
		expect(codes("agents/groups", true)).toEqual([]);
		for (const spelled of ["Agents/Groups", "agents/Groups", "AGENTS/GROUPS", "Agents/groups/launch"])
			expect(codes(spelled, true)).toEqual(["name"]);
		expect(codes("agents/anna/Notes", true)).toEqual([]);
		expect(codes("Sales", true)).toEqual([]);
		expect(codes("agents/Anna/", true)).toEqual(["name"]);
		expect(companyStatePathProblems("agents/a/todos/T", true)[0]?.message).toContain("for example t");
		expect(companyStatePathProblems("agents/a/todos/t/日本", true)[0]?.message).toContain("for example worker");
		expect(companyStatePathProblems("agents/a/todos/日本", true)[0]?.message).toContain("for example todo");
		// Human tasks and contacts (H1): the file names, the top folders and a task's folder and proof/.
		expect(codes("human-tasks/fit-disk.md")).toEqual([]);
		expect(codes("human-tasks/my_task.md")).toEqual(["name"]);
		expect(codes("contacts/Maria.md")).toEqual(["name"]);
		expect(codes("contacts/.md")).toEqual(["name"]);
		for (const folder of ["human-tasks", "contacts", "human-tasks/fit-disk", "human-tasks/fit-disk/proof"])
			expect(codes(folder, true)).toEqual([]);
		for (const folder of ["Human-Tasks", "Contacts", "human-tasks/Fit Disk", "human-tasks/fit-disk/Proof"])
			expect(codes(folder, true)).toEqual(["name"]);
		expect(codes("human-tasks/fit-disk/photos", true)).toEqual([]);
		expect(codes("contacts/archive", true)).toEqual([]);
		expect(companyStatePathProblems("human-tasks/日本", true)[0]?.message).toContain("for example task");
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

	it("refuses control characters in the instructions, keeping tabs", () => {
		expect(refused("agents/a/agent.md", agentFields().replace("Sell.", "Sell\u0007."))[0]?.code).toBe("body");
		expect(ok("agents/a/agent.md", agentFields().replace("Sell.", "Sell\tnow."))).toMatchObject({
			instructions: "Sell\tnow.",
		});
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

	// A quadratic path costs seconds on these inputs; a linear one milliseconds. The bound leaves room for a busy machine.
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
			expect(performance.now() - started).toBeLessThan(1000);
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

describe("hook and mailbox files (E1)", () => {
	const hook = {
		id: ID,
		name: "stripe-payments",
		proof: "stripe" as const,
		status: "active" as const,
		maxBodyBytes: 65536,
		perMinute: 60,
		createdBy: JONAS,
		createdAt: "2026-10-04T08:00:00.5Z",
		purpose: "Payments from Stripe wake the Analyst.",
	};
	const box = {
		id: ID,
		address: "support@inbox.qorpera.com",
		status: "paused" as const,
		createdBy: JONAS,
		createdAt: "2026-10-04T08:00:00Z",
		purpose: "",
	};

	it("reads a hook and a mailbox and writes them back, with the parse the database checks", () => {
		const parsed = ok("connections/hook-stripe-payments.md", writeHookFile(hook));
		expect(parsed).toStrictEqual({ kind: "hook", ...hook });
		// The keys the database's parse shape names (20260930060000).
		expect(Object.keys(parsed).sort()).toEqual(
			[
				"createdAt",
				"createdBy",
				"id",
				"kind",
				"maxBodyBytes",
				"name",
				"perMinute",
				"proof",
				"purpose",
				"status",
			].sort(),
		);
		const mail = ok("connections/mailbox-support.md", writeMailboxFile(box));
		expect(mail).toStrictEqual({ kind: "mailbox", ...box });
		expect(Object.keys(mail).sort()).toEqual(
			["address", "createdAt", "createdBy", "id", "kind", "purpose", "status"].sort(),
		);
		// A name YAML would read as something else is quoted, and reads back the same.
		expect(ok("connections/hook-yes.md", writeHookFile({ ...hook, name: "yes" }))).toMatchObject({ name: "yes" });
		expect(ok("connections/hook-x.md", writeHookFile({ ...hook, name: "a--b-" }))).toMatchObject({ name: "a--b-" });
	});

	it("refuses settings outside the hook's own rules, and any other key", () => {
		const text = writeHookFile(hook);
		const problems = (from: string, to: string) => keys(refused("connections/hook-p.md", text.replace(from, to)));
		expect(problems("proof: stripe", "proof: paypal")).toEqual([["proof", "value"]]);
		expect(problems("status: active", "status: removed")).toEqual([["status", "value"]]);
		expect(problems("max_body_bytes: 65536", "max_body_bytes: 1023")).toEqual([["max_body_bytes", "value"]]);
		expect(problems("max_body_bytes: 65536", 'max_body_bytes: "65536"')).toEqual([["max_body_bytes", "value"]]);
		expect(problems("per_minute: 60", "per_minute: 121")).toEqual([["per_minute", "value"]]);
		expect(problems("name: stripe-payments", "name: Stripe")).toEqual([["name", "value"]]);
		expect(problems("per_minute: 60", "per_minute: 60\naddress: x")).toEqual([["address", "unknown_key"]]);
		expect(problems(`created_by: ${JONAS}`, "created_by: someone")).toEqual([["created_by", "value"]]);
		const mail = writeMailboxFile(box);
		expect(keys(refused("connections/mailbox-s.md", mail.replace("support@inbox.qorpera.com", "Support@x")))).toEqual(
			[["address", "value"]],
		);
		expect(
			keys(refused("connections/mailbox-s.md", mail.replace("status: paused", "status: active\nproof: mail"))),
		).toEqual([["proof", "unknown_key"]]);
		// A vault connection's file at a hook's name is read as a hook's file, which it is not.
		const vault = writeConnectionFile({
			id: ID,
			service: "gmail",
			account: "a@b.dk",
			status: "connected",
			actions: [],
			connectedBy: JONAS,
			connectedAt: "2026-10-04T08:00:00Z",
			purpose: "",
		});
		expect(keys(refused("connections/hook-gmail.md", vault))).toContainEqual(["service", "unknown_key"]);
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

	it("reads a website account's own keys, and only on a website account (A1)", () => {
		const file = {
			id: ID,
			service: "website",
			account: "ops@nordlys.dk",
			status: "pending" as const,
			actions: [],
			connectedBy: GROUP,
			connectedAt: "2026-10-02T08:00:00Z",
			site: "accounts.example.com",
			twoStep: "authenticator" as const,
			openedFor: IDA,
			purpose: "The supplier portal.",
		};
		const text = writeConnectionFile(file);
		expect(text).toContain("site: accounts.example.com\ntwo_step: authenticator\nopened_for: ");
		expect(ok("connections/example-portal.md", text)).toStrictEqual({ kind: "connection", ...file });
		for (const status of ["connected", "needs_person", "broken"] as const)
			expect(ok("connections/p.md", writeConnectionFile({ ...file, status, openedFor: null }))).toMatchObject({
				status,
				openedFor: null,
			});
		// Any other service keeps its shape: none of the three keys, and only connected or broken.
		const gmail = writeConnectionFile({
			...file,
			service: "gmail",
			status: "connected",
			site: undefined,
			twoStep: undefined,
			openedFor: undefined,
		});
		expect(gmail).not.toContain("site:");
		expect(Object.keys(ok("connections/g.md", gmail) as object).sort()).toEqual(
			["kind", "id", "service", "account", "status", "actions", "connectedBy", "connectedAt", "purpose"].sort(),
		);
		const block = (lines: string, service = "website") =>
			`---\nid: ${ID}\nservice: ${service}\naccount: a@b.dk\nstatus: connected\nactions: []\nconnected_by: ${JONAS}\nconnected_at: 2026-10-02T08:00:00Z\n${lines}\n---\n`;
		const problems = (lines: string, service?: string) => keys(refused("connections/p.md", block(lines, service)));
		expect(problems("two_step: none")).toEqual([["site", "missing"]]);
		expect(problems("site: example.com")).toEqual([["two_step", "missing"]]);
		for (const site of [
			"Example.com",
			"example",
			"-a.example.com",
			"a-.example.com",
			"a..example.com",
			"a.example.com.",
			`${"a".repeat(64)}.com`,
			`a.${"b".repeat(64)}`,
			"a_b.example.com",
			"https://example.com",
		])
			expect(problems(`site: "${site}"\ntwo_step: none`)).toEqual([["site", "value"]]);
		// The vault's rule, exactly: labels of 1-63 characters, a host of up to 253.
		expect(ok("connections/p.md", block(`site: ${"a".repeat(63)}.com\ntwo_step: none`))).toBeTruthy();
		// A host YAML would read as a number is written in quotes, and reads back as the host.
		for (const site of ["1.5", "1.5e10", "10.0"])
			expect(ok("connections/p.md", writeConnectionFile({ ...file, site }))).toMatchObject({ site });
		const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
		expect(ok("connections/p.md", block(`site: ${longest}\ntwo_step: none`))).toMatchObject({ site: longest });
		expect(problems(`site: ${longest}d\ntwo_step: none`)).toEqual([["site", "value"]]);
		expect(problems("site: example.com\ntwo_step: phone")).toEqual([["two_step", "value"]]);
		expect(problems("site: example.com\ntwo_step: none\nopened_for: todo-1")).toEqual([["opened_for", "value"]]);
		// On any other service the three keys are unknown settings, each named once.
		expect(problems("site: example.com\ntwo_step: none", "gmail")).toEqual([
			["site", "unknown_key"],
			["two_step", "unknown_key"],
		]);
		expect(problems(`opened_for: ${IDA}`, "gmail")).toEqual([["opened_for", "unknown_key"]]);
		// A website account's states are four.
		expect(
			keys(
				refused("connections/p.md", block("site: example.com\ntwo_step: none").replace("connected\n", "closed\n")),
			),
		).toEqual([["status", "value"]]);
		expect(
			keys(refused("connections/p.md", block("").replace("connected\n", "pending\n").replace("website", "gmail"))),
		).toEqual([["status", "value"]]);
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
		const brief: Omit<WorkerBriefFile, "kind"> = {
			id: ID,
			title: "Collect clinic prices",
			species: "in-house",
			access: "write",
			revival: "each",
			dispatchedAt: "2026-09-28T10:00:00.123Z",
			followUps: 0,
			followedUpAt: null,
			goal: "Collect prices.",
			doneWhen: "Ten clinics, each with a source.",
			context: null,
			sources: [],
			...workerStandingTexts({ species: "in-house", access: "write", revival: "each" }),
			followUp: null,
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
			summary: "Done.",
			needs: null,
			files: [],
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

	describe("worker files' sections (F2-5b)", () => {
		const PATH = "agents/a/todos/t/w1/brief.md";
		const RESULTS = "agents/a/todos/t/w1/results.md";
		const standing = workerStandingTexts({ species: "in-house", access: "read", revival: "batch" });
		const brief: Omit<WorkerBriefFile, "kind"> = {
			id: ID,
			title: "Compare suppliers",
			species: "in-house",
			access: "read",
			revival: "batch",
			dispatchedAt: "2026-10-03T08:00:00Z",
			followUps: 0,
			followedUpAt: null,
			goal: "Find three suppliers of 4 TB NVMe disks.\n\n# Notes\n- price, delivery",
			doneWhen: "Three suppliers with prices.",
			context: "Node 2 needs a second disk.",
			sources: ["ops/node-2/storage-alert.md", "notes/suppliers.md"],
			...standing,
			followUp: null,
		};
		const front = (lines: string) =>
			`---\nid: ${ID}\ntitle: T\nspecies: in-house\naccess: read\nrevival: batch\ndispatched_at: 2026-10-03T08:00:00Z\n${lines}\n---\n`;
		const sections = (follow = "") =>
			`## Goal\nG\n## Done when\nD\n## Authority\nA\n## Output\nO\n## Cancellation\nC\n## Completion\nX\n${follow}`;

		it("round-trips a brief, its sections in order, and a follow-up", () => {
			const text = writeWorkerBriefFile(brief);
			expect(text).toContain("follow_ups: 0\n");
			expect(text).not.toContain("followed_up_at");
			expect(text.indexOf("## Goal")).toBeLessThan(text.indexOf("## Sources"));
			expect(text).toContain("## Sources\n- ops/node-2/storage-alert.md\n- notes/suppliers.md");
			expect(ok(PATH, text)).toEqual({ kind: "worker-brief", ...brief });
			const once = appendWorkerFollowUp(PATH, text, "Add a fourth supplier.", "2026-10-03T09:00:00Z");
			const twice = appendWorkerFollowUp(PATH, once, "Only Danish ones.", "2026-10-03T10:00:00Z");
			expect(ok(PATH, twice)).toEqual({
				kind: "worker-brief",
				...brief,
				followUps: 2,
				followedUpAt: "2026-10-03T10:00:00Z",
				followUp: "Only Danish ones.",
			});
			expect(twice).not.toContain("fourth");
			expect(() => appendWorkerFollowUp(PATH, "nope", "x", "2026-10-03T10:00:00Z")).toThrow("does not parse");
		});

		it("refuses a brief's missing, misplaced and unbalanced sections", () => {
			expect(ok(PATH, `${front("follow_ups: 0")}${sections()}`)).toMatchObject({
				goal: "G",
				context: null,
				sources: [],
			});
			expect(
				refused(PATH, `${front("follow_ups: 0")}${sections().replace("## Done when\nD\n", "")}`)[0]?.message,
			).toBe("write what done is under ## Done when");
			expect(refused(PATH, `${front("follow_ups: 0")}Hello\n${sections()}`)[0]?.message).toBe(
				"the brief starts with ## Goal",
			);
			expect(
				refused(
					PATH,
					`${front("follow_ups: 0")}${sections().replace("## Goal\nG\n## Done when\nD", "## Done when\nD\n## Goal\nG")}`,
				)[0]?.message,
			).toContain("come once each, in this order: ## Goal, ## Done when");
			expect(refused(PATH, `${front("follow_ups: 1")}${sections("## Follow-up\nF\n")}`)[0]?.key).toBe(
				"followed_up_at",
			);
			expect(
				refused(PATH, `${front("follow_ups: 1\nfollowed_up_at: 2026-10-03T09:00:00Z")}${sections()}`)[0]?.message,
			).toBe("write the latest follow-up under ## Follow-up");
			expect(refused(PATH, `${front("follow_ups: 0")}${sections("## Follow-up\nF\n")}`)[0]?.message).toBe(
				"## Follow-up goes with follow_ups of 1 or more",
			);
			expect(
				refused(PATH, `${front("follow_ups: 0\nfollowed_up_at: 2026-10-03T09:00:00Z")}${sections()}`)[0]?.key,
			).toBe("followed_up_at");
			expect(refused(PATH, `${front("")}${sections()}`)[0]?.key).toBe("follow_ups");
			expect(refused(PATH, `${front("follow_ups: -1")}${sections()}`)[0]?.key).toBe("follow_ups");
			// Another heading is text, so a goal may hold its own headings.
			expect(
				ok(PATH, `${front("follow_ups: 0")}${sections().replace("G\n", "G\n## Steps\n- one\n")}`),
			).toMatchObject({
				goal: "G\n## Steps\n- one",
			});
		});

		it("holds sources and sections to today's bounds", () => {
			const at = (paths: string[]) =>
				`${front("follow_ups: 0")}${sections().replace("## Authority", `## Sources\n${paths.map((p) => `- ${p}`).join("\n")}\n## Authority`)}`;
			expect(ok(PATH, at(["a.md", "b/c.md"]))).toMatchObject({ sources: ["a.md", "b/c.md"] });
			expect(refused(PATH, at(Array.from({ length: 9 }, (_, i) => `s${i}.md`)))[0]?.message).toBe(
				"## Sources lists at most 8 paths",
			);
			expect(refused(PATH, at(["a.md", "A.md"]))[0]?.message).toContain("is listed twice");
			expect(refused(PATH, at(["../x"]))[0]?.message).toContain('each line under ## Sources is "- " and a path');
			expect(
				refused(
					PATH,
					`${front("follow_ups: 0")}${sections().replace("## Authority", "## Sources\n\n## Authority")}`,
				)[0]?.message,
			).toBe("## Sources lists at least one path");
			expect(
				refused(PATH, `${front("follow_ups: 0")}${sections().replace("G\n", `${"g".repeat(4001)}\n`)}`)[0]?.message,
			).toBe("## Goal is longer than 4000 bytes");
		});

		it("reads a report's summary, needs and files", () => {
			const report = (lines: string, body: string) =>
				`---\noutcome: ${lines}\nreported_at: 2026-10-03T11:00:00Z\n---\n${body}`;
			expect(ok(RESULTS, report("blocked", "Stuck.\n\n## Needs\nA login.\n\n## Files\n- out/a.md"))).toMatchObject({
				summary: "Stuck.",
				needs: "A login.",
				files: ["out/a.md"],
			});
			expect(refused(RESULTS, report("blocked", "Stuck."))[0]?.message).toBe(
				"a blocked worker writes what it needs under ## Needs",
			);
			expect(refused(RESULTS, report("succeeded", "Done.\n## Needs\nx"))[0]?.message).toBe(
				"## Needs is only for a blocked worker",
			);
			expect(refused(RESULTS, report("succeeded", "## Files\n- a.md"))[0]?.message).toBe(
				"write the summary first, above any ## heading",
			);
			expect(
				refused(
					RESULTS,
					report("failed", `Nope.\n## Files\n${["a", "b", "c", "d", "e"].map((x) => `- ${x}.md`).join("\n")}`),
				)[0]?.message,
			).toBe("## Files lists at most 4 paths");
			expect(refused(RESULTS, report("failed", `${"s".repeat(4001)}`))[0]?.message).toBe(
				"the summary is longer than 4000 bytes",
			);
			const file = {
				outcome: "blocked" as const,
				reportedAt: "2026-10-03T11:00:00Z",
				decision: null,
				note: null,
				summary: "S",
				needs: "N",
				files: ["x/y.md"],
			};
			expect(ok(RESULTS, writeWorkerResultsFile(file))).toEqual({ kind: "worker-results", ...file });
		});

		it("refuses model text that would start a section, CRLF included, per file", () => {
			expect(workerTextHeading("Plan:\n## Files\n- a", "worker-results")).toBe("## Files");
			expect(workerTextHeading("Plan:\n## Files\n- a", "worker-brief")).toBeNull();
			expect(workerTextHeading("## Goal ##", "worker-brief")).toBe("## Goal");
			expect(workerTextHeading("Done.\r\n## Files\r\n- out/a.md", "worker-results")).toBe("## Files");
			expect(workerTextHeading("### Goal\n## Notes\n#Goal", "worker-brief")).toBeNull();
			expect(() => writeWorkerBriefFile({ ...brief, goal: "x\n## Sources\n- y" })).toThrow(
				'The text for ## Goal has a line "## Sources"',
			);
			expect(() => writeWorkerBriefFile({ ...brief, doneWhen: "x\r\n## Context\r\ny" })).toThrow(
				'The text for ## Done when has a line "## Context"',
			);
			const report = {
				outcome: "succeeded" as const,
				reportedAt: "2026-10-03T11:00:00Z",
				decision: null,
				note: null,
				summary: "a",
				needs: null,
				files: [] as string[],
			};
			expect(() => writeWorkerResultsFile({ ...report, summary: "Done.\r\n## Files\r\n- out/a.md" })).toThrow(
				'The summary has a line "## Files"',
			);
			// A results summary may hold the brief's headings: results split only on Needs and Files.
			const sourced = writeWorkerResultsFile({ ...report, summary: "Done.\r\n## Sources\r\n- a.md" });
			expect(ok(RESULTS, sourced)).toMatchObject({ summary: "Done.\n## Sources\n- a.md", files: [] });
			expect(() => writeWorkerResultsFile({ ...report, files: [" a.md"] })).toThrow("## Files:");
			expect(() => writeWorkerResultsFile({ ...report, files: ["a.md\n- b.md"] })).toThrow("## Files:");
			expect(() => writeWorkerResultsFile({ ...report, files: [`${"f".repeat(254)}.md`] })).toThrow(
				"longer than 256 bytes",
			);
			expect(() => writeWorkerBriefFile({ ...brief, sources: ["../x"] })).toThrow("## Sources:");
			expect(WORKER_BRIEF_SECTIONS.at(-1)).toBe("Follow-up");
		});

		it("names the line of a bad item, and refuses empty, repeated and long sections", () => {
			const text = `${front("follow_ups: 0")}## Goal\nG\n## Done when\nD\n## Sources\n\n\n- ok.md\n- ../x\n## Authority\nA\n## Output\nO\n## Cancellation\nC\n## Completion\nX\n`;
			const problems = refused(PATH, text);
			expect(problems[0]?.message).toContain('each line under ## Sources is "- "');
			// The front matter is 9 lines; the body starts at 10, ## Sources at 14, the bad item at 18.
			expect(problems[0]?.line).toBe(18);
			expect(
				refused(PATH, `${front("follow_ups: 0")}${sections().replace("## Done when\nD", "## Done when\n")}`)[0]
					?.message,
			).toBe("write what done is under ## Done when");
			expect(
				refused(
					PATH,
					`${front("follow_ups: 0")}${sections().replace("## Authority", "## Context\n\n## Authority")}`,
				)[0]?.message,
			).toBe("write the context under ## Context");
			expect(refused(PATH, `${front("follow_ups: 0")}${sections()}## Goal\nAgain\n`)[0]?.message).toContain(
				"sections come once each",
			);
			expect(
				refused(PATH, `${front("follow_ups: 0")}${sections().replace("D\n", `${"d".repeat(2001)}\n`)}`)[0]?.message,
			).toBe("## Done when is longer than 2000 bytes");
			expect(
				refused(
					PATH,
					`${front("follow_ups: 1\nfollowed_up_at: 2026-10-03T09:00:00Z")}${sections(`## Follow-up\n${"f".repeat(4001)}\n`)}`,
				)[0]?.message,
			).toBe("## Follow-up is longer than 4000 bytes");
			const crlf = writeWorkerBriefFile(brief).replace(/\n/g, "\r\n");
			expect(ok(PATH, crlf)).toEqual({ kind: "worker-brief", ...brief });
			expect(() => appendWorkerFollowUp(RESULTS, writeWorkerBriefFile(brief), "x", "2026-10-03T10:00:00Z")).toThrow(
				"does not parse",
			);
		});

		it("holds a report's needs and files to their rules", () => {
			const report = (lines: string, body: string) =>
				`---\noutcome: ${lines}\nreported_at: 2026-10-03T11:00:00Z\n---\n${body}`;
			expect(refused(RESULTS, report("blocked", "Stuck.\n## Needs\n"))[0]?.message).toBe(
				"write what it needs under ## Needs",
			);
			expect(refused(RESULTS, report("blocked", `Stuck.\n## Needs\n${"n".repeat(1001)}`))[0]?.message).toBe(
				"## Needs is longer than 1000 bytes",
			);
			expect(refused(RESULTS, report("failed", "Nope.\n## Files\n- a.md\n- A.md"))[0]?.message).toContain(
				"is listed twice",
			);
			expect(refused(RESULTS, report("failed", "Nope.\n## Files\n- a.md\nb.md"))[0]?.line).toBe(8);
			expect(refused(RESULTS, report("failed", `Nope.\n## Files\n- ${"f".repeat(254)}.md`))[0]?.message).toContain(
				"each line under ## Files",
			);
			expect(refused(RESULTS, report("failed", "Nope.\n## Files\n- a.md\n## Needs\nx"))[0]?.message).toContain(
				"sections come once each, in this order: ## Needs, ## Files",
			);
		});

		it("gives today's standing texts and the folder key rule", () => {
			expect(workerStandingTexts({ species: "in-house", access: "read", revival: "batch" })).toEqual({
				authority: "Read what this agent may read. Write nothing.",
				output:
					"Report once through report_work: outcome, a summary the parent can act on, and the files you wrote.",
				cancellation: "Ends with its todo, or when the parent cancels it. A cancelled worker cannot report.",
				completion:
					"The parent is revived once every worker it dispatched together has reported, or at once when you are blocked.",
			});
			expect(workerStandingTexts({ species: "in-house", access: "write", revival: "each" }).completion).toBe(
				"The parent is revived as soon as you report.",
			);
			expect(workerStandingTexts({ species: "in-house", access: "write", revival: "batch" }).authority).toBe(
				"Read what this agent may read. Write only inside outputFolder, or where this agent already holds a write grant.",
			);
			expect(workerStandingTexts({ species: "coding", access: "read", revival: "batch" })).toMatchObject({
				authority:
					"Work only in the repository and branch the cloud selected. Company File sources are read-only context. Publication is a draft PR through the trusted path.",
				output:
					"Finish through coding_finish with the commit to publish, or ask the owner through coding_ask when a decision is theirs.",
			});
			expect(workerKeyProblem("price-check-2")).toBeNull();
			expect(workerKeyProblem("con")).toContain("are reserved names");
			expect(workerKeyProblem("lpt1")).not.toBeNull();
			expect(workerKeyProblem("price.check")).toContain("cannot name a worker's folder");
			expect(workerKeyProblem("a--b")).not.toBeNull();
			expect(workerKeyProblem("a".repeat(65))).not.toBeNull();
		});
	});
});

describe("human tasks and contacts (H1)", () => {
	const OPS = "7f3a9c21-44d0-4e6b-8a55-2c1f0b9e3d77";
	const TODO = "3c9e1a52-7d4b-4f60-8e21-5b0a9c7d2e14";
	const task = (lines: string, text = "## Why\nIt matters.\n## Steps\n- [ ] Do it\n") =>
		`---\nid: ${ID}\ntitle: Fit the disk\n${lines}\n---\n${text}`;
	const member = `status: open\nmember: ${JONAS}\nfrom: ${OPS}\ndue: 2026-10-09T16:00:00Z`;
	const contactTask = `status: open\ncontact: ${IDA}\nfrom: ${OPS}\ndue: 2026-10-09T16:00:00Z`;
	const base: Omit<HumanTaskFile, "kind" | "steps"> = {
		id: ID,
		title: "Fit the second disk in node 2",
		status: "open",
		member: JONAS,
		contact: null,
		from: OPS,
		todo: TODO,
		due: "2026-10-09T16:00:00Z",
		minutes: 40,
		proof: ["photo", "note"],
		files: ["ops/node-2/storage-alert.md"],
		reason: null,
		secret: null,
		secretState: null,
		connection: null,
		step: null,
		instructions:
			"## Why\nNode 2 is 91% full.\n## Steps\n- [ ] Order a 4 TB NVMe\n- [x] Agree a window\n## Done looks like\nThe photo.",
	};

	it("reads a task and writes it back, with the steps of its checklist", () => {
		const text = writeHumanTaskFile(
			base,
			new Map([
				[JONAS, "Jonas"],
				[OPS, "Operations"],
				[TODO, "node-2-storage"],
			]),
		);
		expect(text).toContain(`member: ${JONAS} # Jonas\n`);
		expect(text).toContain(`todo: ${TODO} # node-2-storage\n`);
		expect(ok("human-tasks/fit-disk-node-2.md", text)).toEqual({
			kind: "human-task",
			...base,
			steps: [
				{ line: 16, text: "Order a 4 TB NVMe", done: false },
				{ line: 17, text: "Agree a window", done: true },
			],
		});
		// Every key a member's takeover task uses, as A1 maps its card: the asking agent's own screen is
		// found from `from` when the person opens the task, so the file names no machine or screen.
		const takeover = {
			...base,
			minutes: null,
			proof: [],
			files: [],
			secret: "Code from the SMS",
			secretState: "asked" as const,
			connection: GROUP,
			step: "phone_code" as const,
			todo: null,
		};
		expect(ok("human-tasks/github-code.md", writeHumanTaskFile(takeover))).toMatchObject({
			secret: "Code from the SMS",
			secretState: "asked",
			connection: GROUP,
			step: "phone_code",
			proof: [],
			files: [],
		});
		const forContact = { ...base, member: null, contact: IDA, files: ["finance/vat-q3-draft.pdf"] };
		expect(ok("human-tasks/file-vat-q3.md", writeHumanTaskFile(forContact))).toMatchObject({
			contact: IDA,
			member: null,
		});
	});

	it("is for exactly one person, and keeps the secret to a member's task", () => {
		const problems = (lines: string) => keys(refused("human-tasks/t.md", task(lines)));
		expect(problems(`status: open\nfrom: ${OPS}\ndue: 2026-10-09T16:00:00Z`)).toEqual([["member", "missing"]]);
		expect(problems(`${member}\ncontact: ${IDA}`)).toEqual([["member", "value"]]);
		expect(problems(`${member}\ncomputer: ${ID}`)).toEqual([["computer", "unknown_key"]]);
		expect(problems(`${contactTask}\nsecret: Code\nsecret_state: asked`)).toEqual([
			["secret", "value"],
			["secret_state", "value"],
		]);
		expect(problems(`${member}\nsecret: Code`)).toEqual([["secret_state", "missing"]]);
		expect(problems(`${member}\nsecret_state: saved`)).toEqual([["secret", "missing"]]);
		expect(problems(`${member}\nsecret: Code\nsecret_state: kept`)).toEqual([["secret_state", "value"]]);
		expect(ok("human-tasks/t.md", task(`${member}\nsecret: Code\nsecret_state: saved`))).toMatchObject({
			secretState: "saved",
		});
	});

	it("says why only when a task went back, was declined or cancelled", () => {
		const problems = (lines: string) => keys(refused("human-tasks/t.md", task(lines)));
		const withStatus = (status: string) => member.replace("status: open", `status: ${status}`);
		for (const status of ["returned", "declined"]) {
			expect(problems(withStatus(status))).toEqual([["reason", "missing"]]);
			expect(
				ok("human-tasks/t.md", task(`${withStatus(status)}\nreason: The serial is not readable`)),
			).toMatchObject({
				status,
				reason: "The serial is not readable",
			});
		}
		expect(ok("human-tasks/t.md", task(withStatus("cancelled")))).toMatchObject({ reason: null });
		expect(ok("human-tasks/t.md", task(`${withStatus("cancelled")}\nreason: No longer needed`))).toMatchObject({
			reason: "No longer needed",
		});
		for (const status of ["open", "done", "accepted"])
			expect(problems(`${withStatus(status)}\nreason: Old`)).toEqual([["reason", "value"]]);
		// An invalid status is one problem, not two.
		expect(problems(`${withStatus("waiting")}\nreason: Old`)).toEqual([["status", "value"]]);
		expect(problems(`${withStatus("cancelled")}\nreason: ${"x".repeat(501)}`)).toEqual([["reason", "value"]]);
	});

	it("checks the other settings and needs a body", () => {
		const problems = (lines: string, text?: string) => keys(refused("human-tasks/t.md", task(lines, text)));
		expect(problems(`${member}\nminutes: 481`)).toEqual([["minutes", "value"]]);
		expect(problems(`${member}\nminutes: 0`)).toEqual([["minutes", "value"]]);
		expect(problems(`${member}\nproof: []`)).toEqual([["proof", "value"]]);
		// A list key with no items is left out, not written empty.
		expect(refused("human-tasks/t.md", task(`${member}\nproof:`))).toMatchObject([
			{ key: "proof", code: "missing", message: "proof has no items; give it one or remove the line" },
		]);
		expect(problems(`${member}\nproof: [photo, video]`)).toEqual([["proof", "value"]]);
		expect(problems(`${member}\nproof: [photo, photo]`)).toEqual([["proof", "value"]]);
		expect(problems(`${member}\nstep: puzzle`)).toEqual([["step", "value"]]);
		expect(problems(`${member}\ntodo: node-2-storage`)).toEqual([["todo", "value"]]);
		expect(problems(`${member}\nwhen: daily`)).toEqual([["when", "unknown_key"]]);
		expect(problems(`status: open\nmember: ${JONAS}\ndue: 2026-10-09T16:00:00Z`)).toEqual([["from", "missing"]]);
		expect(problems(member, "")).toEqual([[null, "body"]]);
		expect(problems(`${member}\ntitle2: x`.replace("title2", "title"))).toEqual([["title", "duplicate_key"]]);
	});

	it("reads files as literal paths of files, each once, and keeps a contact's task out of the company's own", () => {
		const problems = (lines: string) => keys(refused("human-tasks/t.md", task(lines)));
		const files = (list: string) => `${member}\nfiles: ${list}`;
		expect(ok("human-tasks/t.md", task(files('[sales/q3 draft.pdf, "a*b.md"]')))).toMatchObject({
			files: ["sales/q3 draft.pdf", "a*b.md"],
		});
		for (const bad of ["[sales/]", "[/sales/a.pdf]", "[sales//a.pdf]", "[sales/../a.pdf]", "[./a.pdf]", "[]"])
			expect(problems(files(bad))).toEqual([["files", "value"]]);
		// Only paths the folder can hold (the core's path rule, as parseCloudCompanyPath).
		for (const bad of [
			"[a:b.pdf]",
			"[50%.pdf]",
			'["a\\\\b.pdf"]',
			'["Notes /x.pdf"]',
			"[con.txt]",
			"[x.]",
			'["e\u0301.pdf"]',
		])
			expect(problems(files(bad))).toEqual([["files", "value"]]);
		// A plain entry YAML reads as something other than text is quoted.
		expect(problems(files("[42, true, null]"))).toEqual([
			["files", "quote"],
			["files", "quote"],
			["files", "quote"],
		]);
		expect(ok("human-tasks/t.md", task(files('["42", "true"]')))).toMatchObject({ files: ["42", "true"] });
		expect(problems(files(`[a${"x".repeat(4096)}]`))).toEqual([["files", "value"]]);
		// Repeats are compared by key: two spellings are one entry.
		expect(problems(files("[Sales/A.pdf, sales/a.pdf]"))).toEqual([["files", "value"]]);
		expect(problems(files(`[${Array.from({ length: 21 }, (_, n) => `f${n}.pdf`).join(", ")}]`))).toEqual([
			["files", "value"],
		]);
		const contactFiles = (list: string) => `${contactTask}\nfiles: ${list}`;
		for (const root of [
			"agents/a/memory/x.md",
			"Contacts/b.md",
			"human-tasks/other/proof/p.jpg",
			"connections/c.md",
			"rules/r.md",
			"hooks/h/e.json",
		])
			expect(keys(refused("human-tasks/t.md", task(contactFiles(`[${root}]`))))).toEqual([["files", "value"]]);
		expect(ok("human-tasks/t.md", task(contactFiles("[finance/vat-q3-draft.pdf, agentsx/a.pdf]")))).toMatchObject({
			files: ["finance/vat-q3-draft.pdf", "agentsx/a.pdf"],
		});
		// A member's task may list them.
		expect(ok("human-tasks/t.md", task(files("[agents/a/memory/x.md]")))).toMatchObject({
			files: ["agents/a/memory/x.md"],
		});
	});

	it("reads the steps of the first exact ## Steps section only", () => {
		const steps = (text: string) => (ok("human-tasks/t.md", task(member, text)) as HumanTaskFile).steps;
		// The body starts on line 9 (six settings between the two --- lines).
		expect(
			steps(
				"## Why\nx\n## Steps\n- [ ] One\n- [X] Two  \n  - [ ] indented\n- [] no\n-  [ ] no\ntext\n# End\n- [ ] after",
			),
		).toEqual([
			{ line: 12, text: "One", done: false },
			{ line: 13, text: "Two", done: true },
		]);
		expect(steps("## Steps ##\n- [ ] A\n## Steps\n- [ ] B")).toEqual([{ line: 10, text: "A", done: false }]);
		expect(steps("## steps\n- [ ] A\n### Steps\n- [ ] B\n## Stepsx\n- [ ] C")).toEqual([]);
		expect(steps("## Steps\n```\n- [ ] in a fence\n```\n### More\n- [x] deeper")).toEqual([
			{ line: 11, text: "in a fence", done: false },
			{ line: 14, text: "deeper", done: true },
		]);
		expect(steps("Why.\r\n## Steps\r\n- [ ] A\r\n")).toEqual([{ line: 11, text: "A", done: false }]);
		expect(steps("No steps here.")).toEqual([]);
		const problems = (text: string) => refused("human-tasks/t.md", task(member, text)).map((p) => [p.line, p.code]);
		expect(problems("## Steps\n- [ ]   \n")).toEqual([[10, "body"]]);
		expect(problems("## Steps\n- [ ] a\tb\n")).toEqual([[10, "body"]]);
		expect(problems("## Steps\n- [ ] a\u2028b\n")).toEqual([[10, "body"]]);
		// One carriage return before a line end is dropped, not two.
		expect(problems("## Steps\n- [ ] A\r\r\n")).toEqual([[10, "body"]]);
		expect(problems(`## Steps\n- [ ] ${"x".repeat(501)}\n`)).toEqual([[10, "body"]]);
		expect(ok("human-tasks/t.md", task(member, `## Steps\n- [ ] ${"ø".repeat(250)}\n`))).toBeTruthy();
		const many = (n: number) => `## Steps\n${Array.from({ length: n }, (_, i) => `- [ ] Step ${i}`).join("\n")}\n`;
		expect((ok("human-tasks/t.md", task(member, many(50))) as HumanTaskFile).steps).toHaveLength(50);
		expect(problems(many(51))).toEqual([[9, "body"]]);
	});

	it("reads a contact and writes it back", () => {
		const file: Omit<ContactFile, "kind"> = {
			id: IDA,
			name: "Maria Jensen",
			organization: "Jensen Revision ApS",
			email: "maria@jensen-revision.example",
			phone: "+45 12 34 56 78",
			asks: ["bookkeeping review", "VAT filing"],
			notes: "Our accountant since 2025.\n## History\n- 2026-10-08 Filed Q3 VAT",
		};
		expect(ok("contacts/maria-jensen.md", writeContactFile(file))).toEqual({ kind: "contact", ...file });
		const bare = { ...file, organization: null, email: null, phone: null, asks: [], notes: "" };
		expect(writeContactFile(bare)).toBe(`---\nid: ${IDA}\nname: Maria Jensen\n---\n`);
		expect(ok("contacts/m.md", writeContactFile(bare))).toEqual({ kind: "contact", ...bare });
		// A phone without spaces would read as a number in YAML: the writer quotes it, and the parse keeps it.
		expect(ok("contacts/m.md", writeContactFile({ ...bare, phone: "+4512345678" }))).toMatchObject({
			phone: "+4512345678",
		});
	});

	it("checks a contact's email, phone and asks", () => {
		const contactText = (lines: string) => `---\nid: ${IDA}\nname: Maria\n${lines}\n---\n`;
		const problems = (lines: string) => keys(refused("contacts/m.md", contactText(lines)));
		for (const email of ["a@b", "x@y.dk", "first.last+tag@sub.example.org", '"o\'brien@x.ie"'])
			expect(ok("contacts/m.md", contactText(`email: ${email}`))).toBeTruthy();
		for (const email of [
			"ab",
			"maria.example.com",
			"a@b@c",
			'"@x.dk"',
			"a@",
			"a@.dk",
			"a@dk.",
			'"a b@x.dk"',
			'"æ@x.dk"',
			'"a@x.dk\u00a0x"',
		])
			expect(problems(`email: ${email}`)).toEqual([["email", "value"]]);
		for (const phone of ['"+4512345678"', "+45 12 34 56 78", '"+123456"', `"+${"1".repeat(20)}"`])
			expect(ok("contacts/m.md", contactText(`phone: ${phone}`))).toBeTruthy();
		for (const phone of [
			'"+12345"',
			`"+${"1".repeat(21)}"`,
			'"45 12 34 56"',
			"+45  12 34 56",
			'"+45-12-34-56"',
			'" +4512345678"',
		])
			expect(problems(`phone: ${phone}`)).toEqual([["phone", "value"]]);
		expect(problems("asks: []")).toEqual([["asks", "value"]]);
		expect(problems("asks: [VAT filing, VAT filing]")).toEqual([["asks", "value"]]);
		expect(problems("asks: [true, 42, null, ~, .5, 0x1F]")).toEqual(
			Array.from({ length: 6 }, () => ["asks", "quote"]),
		);
		expect(problems("asks:\n  - false")).toEqual([["asks", "quote"]]);
		expect(ok("contacts/m.md", contactText('asks: ["true", "42"]'))).toMatchObject({ asks: ["true", "42"] });
		expect(ok("contacts/m.md", contactText("asks: [VAT filing, vat filing]"))).toMatchObject({
			asks: ["VAT filing", "vat filing"],
		});
		expect(problems(`asks: [${"x".repeat(101)}]`)).toEqual([["asks", "value"]]);
		expect(problems('asks: [" VAT filing", "VAT filing "]')).toEqual([
			["asks", "value"],
			["asks", "value"],
		]);
		expect(problems(`asks: [${Array.from({ length: 51 }, (_, n) => `a${n}`).join(", ")}]`)).toEqual([
			["asks", "value"],
		]);
		expect(problems("name2: x".replace("name2", "name"))).toEqual([["name", "duplicate_key"]]);
		expect(problems("company: x")).toEqual([["company", "unknown_key"]]);
	});
});

describe("human tasks: the proof's names and the person's change (H2a)", () => {
	const OPS = "7f3a9c21-44d0-4e6b-8a55-2c1f0b9e3d77";
	const file = (status: string, extra = "", body = "## Steps\n- [ ] Order the disk\n- [x] Agree a window\n") =>
		`---\nid: ${ID}\ntitle: Fit the disk\nstatus: ${status}\nmember: ${JONAS}\nfrom: ${OPS}\ndue: 2026-10-09T16:00:00Z\n${extra}---\n${body}`;
	const path = "human-tasks/fit-disk.md";

	it("names the task's folder, its proof and its note", () => {
		expect(humanTaskFolder(path)).toBe("human-tasks/fit-disk");
		expect(humanTaskProofPath(path, "photo", 1, "jpg")).toBe("human-tasks/fit-disk/proof/photo-1.jpg");
		expect(humanTaskProofPath(path, "signature", 2, "png")).toBe("human-tasks/fit-disk/proof/signature-2.png");
		expect(humanTaskNotePath(path)).toBe("human-tasks/fit-disk/note.md");
		expect(() => humanTaskFolder("contacts/maria.md")).toThrow(RangeError);
		// Only the spelling the database keeps: a compatibility or upper-case spelling is refused here, not later.
		expect(() => humanTaskFolder("ＨＵＭＡＮ-TASKS/fit.md")).toThrow(RangeError);
		expect(() => humanTaskFolder("human-tasks/Fit.md")).toThrow(RangeError);
		expect(() => humanTaskProofPath(path, "note" as "photo", 1, "md")).toThrow(RangeError);
		expect(() => humanTaskProofPath(path, "photo", 0, "jpg")).toThrow(RangeError);
		expect(() => humanTaskProofPath(path, "photo", 1, "JPG")).toThrow(RangeError);
		expect(() => humanTaskProofPath(path, "photo", 1, "")).toThrow(RangeError);
	});

	it("ticks one box and changes nothing else", () => {
		const text = file("open");
		const ticked = humanTaskPersonChange(path, text, { kind: "tick", step: 0, done: true });
		expect(ticked).toBe(text.replace("- [ ] Order the disk", "- [x] Order the disk"));
		expect(humanTaskPersonChange(path, ticked, { kind: "tick", step: 1, done: false })).toBe(
			ticked.replace("- [x] Agree a window", "- [ ] Agree a window"),
		);
		// A carriage return and an upper-case X stay as the file had them.
		const crlf = file("open").replaceAll("\n", "\r\n").replace("- [x]", "- [X]");
		expect(humanTaskPersonChange(path, crlf, { kind: "tick", step: 1, done: true })).toBe(
			crlf.replace("- [X] Agree", "- [x] Agree"),
		);
		expect(() => humanTaskPersonChange(path, text, { kind: "tick", step: 2, done: true })).toThrow(/no step 2/);
		// A byte-order mark and notes in the settings stay as they were.
		const noted = `\ufeff${file("open", "minutes: 40 # about\n")}`;
		expect(humanTaskPersonChange(path, noted, { kind: "tick", step: 0, done: true })).toBe(
			noted.replace("- [ ] Order the disk", "- [x] Order the disk"),
		);
		expect(humanTaskPersonChange(path, noted, { kind: "done" })).toBe(noted.replace("status: open", "status: done"));
	});

	it("marks a task done or declined, and only an open or returned one", () => {
		const returned = file("returned", "reason: The serial is not readable\n");
		const done = humanTaskPersonChange(path, returned, { kind: "done" });
		expect(done).toBe(file("done"));
		const declined = humanTaskPersonChange(path, file("open"), { kind: "declined", reason: "I am away that week" });
		expect(ok(path, declined)).toMatchObject({ status: "declined", reason: "I am away that week" });
		expect(declined).toBe(file("declined", "reason: I am away that week\n"));
		for (const status of ["done", "accepted", "declined", "cancelled"])
			expect(() =>
				humanTaskPersonChange(path, file(status, status === "declined" ? "reason: x\n" : ""), { kind: "done" }),
			).toThrow(/not the person's to change/);
		expect(() => humanTaskPersonChange(path, file("open"), { kind: "declined", reason: "" })).toThrow(
			/would be refused/,
		);
		expect(() => humanTaskPersonChange("human-tasks/x.md", "not a task", { kind: "done" })).toThrow(/parses/);
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
			expect(performance.now() - started).toBeLessThan(1000);
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
			// Every structured file parses; the seeded skill is an ordinary file.
			if (entry.kind === "file")
				expect(parseCompanyStateFile(entry.path, entry.text ?? "")?.ok ?? entry.path).toBe(
					entry.path === COMPANY_STATE_HUMAN_TASK_SKILL_PATH ? entry.path : true,
				);
		}
		for (const seeded of COMPANY_STATE_SEEDED_PATHS) expect(paths).toContain(seeded);
		// The fixed folders of contract 5.6 in its order, human-tasks/ and contacts/ among them (Jonas, 2 Oct).
		expect(paths.filter((path) => !path.includes("/"))).toEqual([
			"vision",
			"agents",
			"connections",
			"human-tasks",
			"contacts",
			"skills",
			"rules",
		]);
		const skill = tree.find((entry) => entry.path === COMPANY_STATE_HUMAN_TASK_SKILL_PATH)?.text ?? "";
		expect(skill).toMatch(/^---\nname: human-task\ndescription: .+\n---\n# Human tasks\n/);
		expect(skill).toContain("`## Steps`");
		expect(ok("vision/vision.md", tree.find((entry) => entry.path === "vision/vision.md")?.text ?? "")).toEqual({
			kind: "vision",
			name: "Nordlys Studio",
		});
		expect(
			ok(
				"agents/co-founder/agent.md",
				tree.find((entry) => entry.path === "agents/co-founder/agent.md")?.text ?? "",
			),
		).toMatchObject({ id: ANNA, agentKind: "co-founder", status: "active", colour: null, figure: "crown" });
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

	it("throws rather than seed a file the database would refuse", () => {
		expect(() =>
			companyStateSeedTree({ companyName: "Nordlys Studio", cofounderId: ANNA, vision: "x".repeat(70000) }),
		).toThrow(/vision\/vision\.md would be refused/);
	});
});
