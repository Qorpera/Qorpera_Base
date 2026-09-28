import { describe, expect, it } from "vitest";
import {
	type AgentFile,
	type CompanyStateFileResult,
	companyStateName,
	companyStatePath,
	companyStateValue,
	freeCompanyStateName,
	isCompanyStateName,
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
	return result.problems;
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

	it("leaves ordinary files alone", () => {
		expect(parseCompanyStateFile("sales/leads/list.md", "anything")).toBeNull();
	});
});

describe("names", () => {
	it("makes plain-Latin folder names", () => {
		expect(companyStateName("Anna Berg")).toBe("anna-berg");
		expect(companyStateName("Søren Ærø-Ågård")).toBe("soeren-aeroe-aagaard");
		expect(companyStateName("José Müller")).toBe("jose-muller");
		expect(companyStateName("  R&D   team!! ")).toBe("rd-team");
		expect(companyStateName("日本")).toBe("");
		expect(companyStateName("a".repeat(80))).toHaveLength(64);
	});

	it("numbers a taken name and falls back when nothing is left", () => {
		expect(freeCompanyStateName("Anna Berg", "agent", new Set(["anna-berg", "anna-berg-2"]))).toBe("anna-berg-3");
		expect(freeCompanyStateName("日本", "agent", new Set(["agent"]))).toBe("agent-2");
		expect(freeCompanyStateName("Groups", "agent", new Set(["groups"]))).toBe("groups-2");
		expect(isCompanyStateName("anna-berg")).toBe(true);
		expect(isCompanyStateName("Anna")).toBe(false);
		expect(isCompanyStateName("a--b")).toBe(false);
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
		const text = `﻿---\r\n# who\r\nid: ${ANNA} # never changes\r\nname: "Anna \\"AB\\" Berg"\r\nrole: 'Head of Sales'\r\nkind: agent\r\nstatus: active\r\n---\r\nSell.\r\n`;
		expect(ok("agents/anna-berg/agent.md", text)).toMatchObject({
			id: ANNA,
			name: 'Anna "AB" Berg',
			role: "Head of Sales",
		});
	});

	it("writes a file that reads back the same", () => {
		const file = ok("agents/anna-berg/agent.md", agentText) as AgentFile;
		const { kind: _kind, ...fields } = file;
		expect(ok("agents/anna-berg/agent.md", writeAgentFile(fields))).toEqual(file);
		const tricky = {
			...fields,
			name: "Ops: #1",
			role: "true",
			colour: null,
			figure: null,
			model: null,
			effort: null,
		};
		expect(ok("agents/anna-berg/agent.md", writeAgentFile(tricky))).toEqual({ ...tricky, kind: "agent" });
	});

	it("names each problem with its line, and suggests a fresh id", () => {
		const problems = refused(
			"agents/anna-berg/agent.md",
			"---\nname: Anna\nrole: Sales\nkind: agent\nstatus: on leave\nteam: sales\nname: Again\n---\nSell.\n",
		);
		expect(problems.map((problem) => [problem.line, problem.key, problem.code])).toEqual([
			[7, "name", "duplicate_key"],
			[null, "id", "missing"],
			[5, "status", "value"],
			[6, "team", "unknown_key"],
		]);
		expect(problems.find((problem) => problem.key === "team")?.message).toContain(
			"allowed: colour, effort, figure, id",
		);
		const noId = refused(
			"agents/anna-berg/agent.md",
			`---\nid: ANNA\nname: A\nrole: B\nkind: agent\nstatus: active\n---\nx\n`,
		);
		expect(noId[0]?.message).toMatch(/a fresh one you can use/);
	});

	it("refuses values YAML would read as something other than text", () => {
		const problems = refused(
			"agents/anna-berg/agent.md",
			`---\nid: ${ANNA}\nname: 42\nrole: null\nkind: agent\nstatus: active\n---\nx\n`,
		);
		expect(problems.map((problem) => [problem.key, problem.code])).toEqual([
			["name", "quote"],
			["role", "quote"],
		]);
	});

	it("refuses broken settings blocks", () => {
		expect(refused("agents/anna-berg/agent.md", "no settings")[0]?.code).toBe("front_matter");
		expect(refused("agents/anna-berg/agent.md", "---\nid: x\n")[0]?.code).toBe("front_matter");
		const syntax = refused(
			"agents/anna-berg/agent.md",
			`---\nid: ${ANNA}\n\tname: A\nrole: {a: 1}\nkind: agent\nstatus: active\nfree text\n  - stray\n---\nx\n`,
		);
		expect(syntax.map((problem) => [problem.line, problem.code])).toEqual(
			expect.arrayContaining([
				[3, "syntax"],
				[4, "syntax"],
				[7, "syntax"],
				[8, "syntax"],
			]),
		);
		expect(refused("agents/anna-berg/agent.md", agentText.replace(/---\n[\s\S]*$/, "---\n\n"))).toBeTruthy();
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
	});
});

describe("vision.md", () => {
	it("takes the company's name from the first line", () => {
		const text = writeVisionFile("Nordlys Studio", "## What we build\nBooking software.");
		expect(text).toBe("# Nordlys Studio\n\n## What we build\nBooking software.\n");
		expect(ok("vision/vision.md", `\n\n${text}`)).toEqual({ kind: "vision", name: "Nordlys Studio" });
		expect(ok("vision/vision.md", "# C# Makers\n")).toEqual({ kind: "vision", name: "C# Makers" });
		expect(refused("vision/vision.md", "Nordlys\n")[0]).toMatchObject({ code: "body", line: 1 });
		expect(refused("vision/vision.md", "## Nordlys\n")[0]?.code).toBe("body");
		expect(refused("vision/vision.md", `# ${"n".repeat(121)}\n`)[0]?.code).toBe("body");
	});
});

describe("sections.md", () => {
	const text = `# Sections

Each line is an id. The words after it are only for reading.

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
					line: 5,
					members: [
						{ id: ANNA, line: 6 },
						{ id: TOM, line: 7 },
						{ id: GROUP, line: 8 },
					],
				},
				{ name: "Product", line: 10, members: [{ id: IDA, line: 11 }] },
				{ name: "Later", line: 13, members: [] },
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
			`- ${ANNA}\n## Sales\n- ${TOM}\nsome prose\n- ${TOM}\n## sales\n### Deep\n##\n`,
		);
		expect(problems.map((problem) => problem.line)).toEqual([1, 4, 5, 6, 7, 8]);
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
		expect(
			ok("agents/groups/launch-team/group.md", writeGroupFile({ ...fields, subtitle: null, people: [] })),
		).toMatchObject({
			people: [],
			subtitle: null,
		});
	});

	it("needs two agents, ids and a purpose", () => {
		const problems = refused(
			"agents/groups/launch-team/group.md",
			`---\nid: ${GROUP}\nname: Launch\nagents: [${ANNA}, nope, ${ANNA}]\n---\n`,
		);
		expect(problems.map((problem) => [problem.key, problem.code])).toEqual([
			["agents", "value"],
			["agents", "value"],
			[null, "body"],
		]);
		expect(
			refused("agents/groups/launch/group.md", `---\nid: ${GROUP}\nname: Launch\nagents: [${ANNA}]\n---\nx\n`)[0]
				?.message,
		).toBe("a group chat needs at least two agents");
		expect(
			refused("agents/groups/Launch/group.md", `---\nid: ${GROUP}\nname: L\nagents: [${ANNA}, ${IDA}]\n---\nx\n`)[0]
				?.code,
		).toBe("name");
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
		const block = `---\nid: ${ID}\nservice: google_drive\naccount: a@b.dk\nstatus: broken\nactions:\n  - list_files\nconnected_by: ${JONAS}\nconnected_at: 2026-02-30T10:00:00Z\n---\n`;
		expect(refused("connections/drive.md", block).map((problem) => problem.key)).toEqual(["connected_at"]);
		expect(ok("connections/drive.md", block.replace("02-30", "02-28"))).toMatchObject({
			actions: ["list_files"],
			purpose: "",
		});
	});

	it("keeps a rule to one sentence", () => {
		const file = {
			id: ID,
			outcome: "ask-first" as const,
			text: "When an agent wants to send an email to a customer.",
		};
		expect(ok("rules/ask-before-emailing-customers.md", writeRuleFile(file))).toEqual({ kind: "rule", ...file });
		expect(refused("rules/r.md", `---\nid: ${ID}\noutcome: ask-first\n---\nOne.\nTwo.\n`)[0]?.code).toBe("body");
		expect(refused("rules/r.md", `---\nid: ${ID}\noutcome: deny\n---\nOne.\n`)[0]?.key).toBe("outcome");
	});

	it("reads a todo", () => {
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
			quiet: { start: "22:00", end: "07:00" },
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
			{ when: "every", minutes: 30, starts: "2026-09-29T06:00:00.000Z" },
			{ when: "weekly", days: ["sat"], time: "09:30", starts: null },
			{ when: "window", minutes: 60, from: "09:00", to: "17:00", days: ["mon"], months: [1, 12] },
			{ when: "once", at: "2026-09-30T07:00:00Z" },
			{ when: "file-change", watch: "sales/leads", match: "exact" },
		];
		for (const trigger of triggers) {
			const file = { ...base, trigger };
			expect(ok("agents/a/routines/r.md", writeRoutineFile(file))).toEqual({ kind: "routine", ...file });
		}
		const concluded = {
			...base,
			trigger: triggers[3] as RoutineFile["trigger"],
			status: "concluded" as const,
			conclusion: "Fysio Nord signed.",
			runs: null,
			ends: "2026-12-31T00:00:00Z",
			quiet: { start: "22:00", end: "07:00" },
		};
		expect(ok("agents/a/routines/r.md", writeRoutineFile(concluded))).toEqual({ kind: "routine", ...concluded });
	});

	it("defaults effort, reply and match", () => {
		expect(
			ok(
				"agents/a/routines/r.md",
				`---\nid: ${ID}\ntitle: T\nstatus: paused\nwhen: file-change\nwatch: sales/\ntimezone: UTC\n---\nx\n`,
			),
		).toMatchObject({
			effort: "medium",
			reply: "optional",
			trigger: { when: "file-change", watch: "sales", match: "subtree" },
		});
	});

	it("refuses settings of another trigger and broken combinations", () => {
		const problems = refused(
			"agents/a/routines/r.md",
			`---\nid: ${ID}\ntitle: T\nstatus: active\nwhen: once\nat: 2026-09-30T07:00:00Z\nminutes: 5\nruns: 3\nends: 2026-09-01T00:00:00Z\nconclusion: early\n---\nx\n`,
		);
		expect(problems.map((problem) => [problem.key, problem.code])).toEqual([
			["minutes", "unknown_key"],
			["runs", "value"],
			["timezone", "missing"],
			["at", "value"],
			["conclusion", "value"],
		]);
		expect(
			refused(
				"agents/a/routines/r.md",
				`---\nid: ${ID}\ntitle: T\nstatus: concluded\nwhen: every\nminutes: 4\n---\nx\n`,
			),
		).toEqual([
			expect.objectContaining({ key: "minutes" }),
			expect.objectContaining({ key: "conclusion", code: "missing" }),
		]);
		expect(
			refused(
				"agents/a/routines/r.md",
				`---\nid: ${ID}\ntitle: T\nstatus: active\nwhen: every\nminutes: 5\nquiet: "22:00-07:00"\n---\nx\n`,
			)[0],
		).toMatchObject({ key: "timezone", code: "missing" });
		expect(
			refused(
				"agents/a/routines/r.md",
				`---\nid: ${ID}\ntitle: T\nstatus: active\nwhen: weekly\ndays: [mon, funday, mon]\ntime: "25:00"\ntimezone: Mars/Olympus\n---\nx\n`,
			).map((problem) => problem.key),
		).toEqual(["days", "days", "time", "timezone"]);
		expect(
			refused("agents/a/routines/r.md", `---\nid: ${ID}\ntitle: T\nstatus: active\nwhen: hourly\n---\nx\n`)[0]?.key,
		).toBe("when");
	});
});

describe("setCompanyStateSettings", () => {
	it("changes one setting and keeps every other byte", () => {
		const text = `---\nid: ${ANNA}   # keep this note\nname: Anna Berg\nstatus: active # was paused\nagents:\n  - ${IDA}\n---\nBody stays.\n`;
		expect(setCompanyStateSettings(text, { status: "paused" })).toBe(
			text.replace("status: active # was paused", "status: paused"),
		);
		expect(setCompanyStateSettings(text, { agents: null, subtitle: companyStateValue("Q4: launch") })).toBe(
			`---\nid: ${ANNA}   # keep this note\nname: Anna Berg\nstatus: active # was paused\nsubtitle: "Q4: launch"\n---\nBody stays.\n`,
		);
		const crlf = text.replaceAll("\n", "\r\n");
		expect(setCompanyStateSettings(crlf, { status: "paused" })).toContain("status: paused\r\n");
		expect(() => setCompanyStateSettings("# vision\n", { status: "x" })).toThrow();
	});
});
