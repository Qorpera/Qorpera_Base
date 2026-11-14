import { randomUUID } from "node:crypto";
import {
	parseCompanyStateFile,
	READING_PATH,
	type ReadingFile,
	writeAgentFile,
	writeReadingFile,
} from "@qorpera/cloud-client/company-state-files";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CLOUD_UPDATE_READING_DESCRIPTION,
	CloudFolderReading,
	type CloudReadingRequest,
	cloudCompanyMembers,
	cloudReadingTool,
	describeCloudCompanySenses,
	parseCloudReadingArguments,
} from "@qorpera/runtime/cloud-folder-reading";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolArgumentRefusal, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/* The company's reading of itself (lanes/company-reading-20261114; the founder, 14 November 2026: "It should feel like
 * the company is conscious almost"): update_reading, the Co-Founder's one writer of QorperaOS/vision/reading.md, and
 * the senses its company runs read beside their open work. */

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const MEMBER = "76600000-0000-4000-8000-0000000000a1";
const STRANGER = "76600000-0000-4000-8000-0000000000b1";
/** The fixture's clock starts at 2026-10-01T00:00:00Z and ticks a second a write. */
const START = Date.parse("2026-10-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const agentFile = (name: string, status: "active" | "archived" = "active", id: string = randomUUID()) =>
	writeAgentFile({
		id,
		name,
		role: name,
		agentKind: "agent",
		status,
		colour: null,
		figure: null,
		model: null,
		effort: null,
		instructions: `Own ${name}.`,
	});

const AGENTS = {
	"QorperaOS/agents/research/agent.md": agentFile("Research"),
	"QorperaOS/agents/product/agent.md": agentFile("Product"),
	"QorperaOS/agents/market/agent.md": agentFile("Market", "archived"),
};

const READING = {
	operationKey: "reading-1",
	sentence: "We are building the first shop for fresh bread.",
	line: "Ten customers talked to us; the shop is next.",
	attention: "product",
	things: [
		{
			key: "customers",
			name: "Customers",
			shape: "people",
			full: 40,
			state: "Ten talks done",
			agents: ["research"],
			waitsFor: [],
		},
		{
			key: "product",
			name: "The shop",
			shape: "cart",
			full: 20,
			state: "First pages",
			agents: ["product"],
			waitsFor: ["founders"],
		},
		{ key: "money", name: "Money", shape: "coin", full: 0, state: "No account yet", agents: [], waitsFor: [MEMBER] },
	],
	notes: ["We do not know the price yet."],
} satisfies Record<string, JsonValue>;

/** A saved reading, attending to `attention`, with one change. */
const saved = (attention: string) =>
	writeReadingFile({
		sentence: "We are finding out who buys bread.",
		line: null,
		attention,
		things: READING.things.map((thing) => ({ ...thing, shape: thing.shape as never })),
		changes: [{ agent: "research", what: "joined", line: "Research joined to talk to customers" }],
		notes: [],
	});

async function fixture(files: Record<string, string> = {}, now?: () => number) {
	// The vision folder is seeded with every company.
	const f = await folderWriterFixture({ files: { ...AGENTS, ...files }, folders: ["QorperaOS/vision"] });
	runs.push(f.run);
	const members = vi.fn(async () => new Set([MEMBER]) as ReadonlySet<string>);
	const writer = (operations = new CloudNativeToolOperations(f.run, f.operationControl)) =>
		new CloudFolderReading({ folder: f.folder, operations, identity: f.identity, members, ...(now ? { now } : {}) });
	return { ...f, members, writer };
}

const request = (value: Record<string, JsonValue>): CloudReadingRequest =>
	parseCloudReadingArguments({ ...READING, ...value } as JsonValue);
const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
const file = (f: { text: (path: string) => string | null }): ReadingFile => {
	const parsed = parseCompanyStateFile(READING_PATH, f.text(READING_PATH) ?? "");
	if (!parsed?.ok || parsed.file.kind !== "reading") throw new Error("The saved reading does not parse");
	return parsed.file;
};
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}

it("saves a first reading as one plain write under its receipt, owing no team decision", async () => {
	const f = await fixture();
	const result = parse(await f.writer().save(request({}), f.context));
	expect(result).toMatchObject({
		schema: "qorpera.company-reading-receipt/v1",
		runId: f.identity.runId,
		outcome: "saved",
		path: READING_PATH,
		attention: "product",
	});
	expect(result.next).toContain("every agent's next run reads it");
	// One unit, a new file; no review is recorded: the reading is the company's bookkeeping.
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({ key: "reading-file:reading-1", receiptId: result.receiptId });
	expect(f.commits[0]?.reviewId ?? null).toBeNull();
	expect(f.commits[0]?.units.map((unit) => [unit.op, unit.path, "expectedVersion" in unit])).toEqual([
		["write", READING_PATH, false],
	]);
	expect(f.recordings).toEqual([]);
	expect(file(f)).toEqual({
		kind: "reading",
		sentence: READING.sentence,
		line: READING.line,
		attention: "product",
		things: READING.things,
		changes: [],
		notes: READING.notes,
	});
	// A member waited for is checked against the company's members.
	expect(f.members).toHaveBeenCalledOnce();
	// The same call again replays its receipt.
	expect(parse(await f.writer().save(request({}), f.context))).toEqual(result);
	expect(f.commits).toHaveLength(1);
});

it("keeps the saved changes while attention stays and they are under seven days old, and empties them after", async () => {
	const young = await fixture({ [READING_PATH]: saved("product") }, () => START + 6 * DAY);
	expect(parse(await young.writer().save(request({}), young.context)).outcome).toBe("saved");
	expect(file(young).changes).toEqual([
		{ agent: "research", what: "joined", line: "Research joined to talk to customers" },
	]);
	// Over the version read.
	expect(young.commits[0]?.units[0]).toMatchObject({ expectedVersion: expect.any(String) });
	const old = await fixture({ [READING_PATH]: saved("product") }, () => START + 8 * DAY);
	expect(parse(await old.writer().save(request({}), old.context)).outcome).toBe("saved");
	expect(file(old).changes).toEqual([]);
	// Changes given without a move replace the saved ones.
	const given = await fixture({ [READING_PATH]: saved("product") }, () => START + DAY);
	const team = [{ agent: "product", what: "changed", line: "Product now also owns the price list" }];
	await given.writer().save(request({ team }), given.context);
	expect(file(given).changes).toEqual(team);
});

it("refuses a move of attention without the team decision it owes, and saves one with it", async () => {
	const moved = await fixture({ [READING_PATH]: saved("customers") });
	await refuses(
		moved.writer().save(request({}), moved.context),
		"attention moves to another thing than the saved reading's, and a move owes the team decision: call again with team",
	);
	expect(moved.commits).toEqual([]);
	expect(moved.operationControl.beginToolOperation).not.toHaveBeenCalled();
	// The changes are saved as the file's changes.
	const team = [
		{ agent: "product", what: "joined", line: "Product joined to build the shop" },
		{ agent: "market", what: "ended", line: "Market's daily watch ended" },
	];
	expect(parse(await moved.writer().save(request({ operationKey: "reading-2", team }), moved.context)).outcome).toBe(
		"saved",
	);
	expect(file(moved)).toMatchObject({ attention: "product", changes: team });
	// None with the reason is an answer too: the saved changes go.
	const none = await fixture({ [READING_PATH]: saved("customers") });
	const answer = request({ team: { none: "The team already covers the shop." } });
	expect(parse(await none.writer().save(answer, none.context)).outcome).toBe("saved");
	expect(file(none).changes).toEqual([]);
});

it("refuses before its receipt an agent that does not work here and a member the company does not have", async () => {
	const f = await fixture();
	const things = (agents: string[], waitsFor: string[] = []) =>
		READING.things.map((thing, index) => (index === 0 ? { ...thing, agents, waitsFor } : thing));
	// An archived agent, and a folder that is no agent's.
	await refuses(
		f.writer().save(request({ things: things(["market"]) }), f.context),
		"market is not an active agent's",
	);
	await refuses(f.writer().save(request({ things: things(["sales"]) }), f.context), "sales is not an active agent's");
	// A change names an agent's folder; an ended one is archived, and that is fine.
	await refuses(
		f.writer().save(request({ team: [{ agent: "sales", what: "joined", line: "Sales joined" }] }), f.context),
		"sales is not an agent's folder",
	);
	await refuses(
		f.writer().save(request({ things: things(["research"], [STRANGER]) }), f.context),
		`${STRANGER} is not a member of the company`,
	);
	// Review r1 of #1819 (F3): an id of the parser's shape that is no version-4 UUID is checked too.
	await refuses(
		f.writer().save(request({ things: things(["research"], ["11111111-1111-1111-1111-111111111111"]) }), f.context),
		"11111111-1111-1111-1111-111111111111 is not a member of the company",
	);
	expect(f.commits).toEqual([]);
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	await f
		.writer()
		.save(request({ team: [{ agent: "market", what: "ended", line: "Market's daily watch ended" }] }), f.context);
	expect(file(f).changes).toEqual([{ agent: "market", what: "ended", line: "Market's daily watch ended" }]);
	// No member id waited for: the members are not asked.
	const g = await fixture();
	await g.writer().save(request({ things: READING.things.map((thing) => ({ ...thing, waitsFor: [] })) }), g.context);
	expect(g.members).not.toHaveBeenCalled();
});

it("answers a reading changed since it was read as a conflict", async () => {
	const f = await fixture({ [READING_PATH]: saved("product") });
	const read = f.folder.readText.bind(f.folder);
	vi.spyOn(f.folder, "readText").mockImplementationOnce(async (path, max, signal) => {
		const found = await read(path, max, signal);
		return found && { ...found, entry: { ...found.entry, version: randomUUID() } };
	});
	const result = parse(await f.writer().save(request({}), f.context));
	expect(result).toMatchObject({ outcome: "conflict", version: null });
	expect(result.next).toContain("read it again and call once more with a new operationKey");
});

it("checks the file with the arguments, before anything is read, naming the parser's problems", () => {
	for (const [bad, reason] of [
		[{ attention: "sales" }, "attention names no thing"],
		[{ things: READING.things.slice(0, 2) }, "at least 3 things"],
		[{ things: READING.things.map((thing) => ({ ...thing, shape: "rocket" })) }, "This reading cannot be saved"],
		[{ sentence: "x".repeat(201) }, "This reading cannot be saved"],
		[{ notes: ["n", "n", "n", "n", "n", "n"] }, "## Notes has at most 5 lines"],
		[{ team: [] }, "team lists the changes"],
		[{ team: { none: "" } }, "team's none is one line"],
		[{ team: [{ agent: "product", what: "hired", line: "x" }] }, "each change of team has agent, what"],
		[{ extra: true }, "update_reading takes"],
	] as [Record<string, JsonValue>, string][]) {
		let thrown: unknown = null;
		try {
			request(bad);
		} catch (error) {
			thrown = error;
		}
		expect(thrown, reason).toBeInstanceOf(CloudToolArgumentRefusal);
		expect(String((thrown as Error).message)).toContain(reason);
	}
	expect(request({ line: null }).line).toBeNull();
});

it("is update_reading: its description says every field's meaning, and an operation key binds one request", async () => {
	const f = await fixture();
	const tool = cloudReadingTool(f.identity, f.writer());
	expect(tool.name).toBe("update_reading");
	expect(tool.description).toBe(CLOUD_UPDATE_READING_DESCRIPTION);
	for (const words of [
		"sentence:",
		"line:",
		"things:",
		"key (",
		"name (",
		"shape (its emblem: board, box",
		"full (a whole number from 0 to 100",
		"state (",
		"agents (up to 8 active agents",
		'waitsFor (up to 4 member ids from your context\'s senses, or ["founders"] alone)',
		"attention: the key of the one thing",
		"notes: up to 5 lines",
		"team: when attention moves",
		'{"none": "<why the team stays as it is>"}',
	])
		expect(tool.description).toContain(words);
	// Small enough that Codex sends it whole (it drops field descriptions from a schema of 5,000 bytes or more).
	expect(Buffer.byteLength(JSON.stringify(tool.inputSchema))).toBeLessThan(5_000);
	const parsed = tool.parseArguments(READING as unknown as JsonValue);
	expect(parse(await tool.execute(parsed, f.context))).toMatchObject({ outcome: "saved" });
	expect(() => tool.parseArguments({ ...READING, sentence: "We sell cake now." } as unknown as JsonValue)).toThrow(
		/already used in this run for a different reading/,
	);
});

it("reads the senses as the Co-Founder's run answer them, and the company's members by id", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const answer = {
		schema: "qorpera.company-senses/v1",
		runId: binding.runId,
		agents: [{ handle: "research", todos: { open: 2, blocked: 1, doneLast7d: 3 } }],
		members: [{ userId: MEMBER, role: "owner", login: { state: "ready" } }],
	};
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method) =>
		method === "qorpera_describe_company_senses"
			? answer
			: {
					schema: "qorpera.cofounder-crew/v1",
					runId: binding.runId,
					members: [{ userId: MEMBER }],
					agents: [],
					asks: [],
				},
	);
	const signal = new AbortController().signal;
	expect(await describeCloudCompanySenses(binding, { call }, signal)).toEqual(answer);
	expect(call).toHaveBeenCalledWith("qorpera_describe_company_senses", { p_binding: binding }, expect.anything());
	expect([...(await cloudCompanyMembers(binding, { call })(signal))]).toEqual([MEMBER]);
	// Another run's answer, or another schema, is no answer.
	for (const wrong of [{ ...answer, runId: randomUUID() }, { ...answer, schema: "qorpera.company-senses/v2" }, null]) {
		call.mockResolvedValueOnce(wrong);
		await expect(describeCloudCompanySenses(binding, { call }, signal)).rejects.toThrow("Company senses differ");
	}
});
