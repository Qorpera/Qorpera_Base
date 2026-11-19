import { randomUUID } from "node:crypto";
import { AGENT_MODELS } from "@qorpera/cloud-client/company-state-files";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import {
	compileCloudNativeCompanyInstructions,
	composeCloudNativeCompanyPrompt,
	parseCloudNativeCompanyContext,
} from "@qorpera/runtime/cloud-native-company-context";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolArgumentRefusal, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudToolsOnDemand } from "@qorpera/runtime/cloud-native-tools-on-demand";
import {
	cloudPlatformUpdatesContext,
	cloudRecordReflectionTool,
	decisionsFor,
	isPlatformDay,
	newestReflections,
	PLATFORM_UPDATE_ID,
	PLATFORM_UPDATE_TEXT_MAX_BYTES,
	PLATFORM_UPDATE_TITLE_MAX_BYTES,
	PLATFORM_UPDATES,
	type PlatformUpdate,
	parseRecordReflectionArguments,
	parseReflections,
	pendingPlatformUpdates,
	REFLECTIONS_HEADING,
	REFLECTIONS_MAX_BYTES,
	REFLECTIONS_PATH,
	REFLECTIONS_PROBLEM,
	REFLECTIONS_READ_MAX_BYTES,
	readCloudPlatformUpdates,
	reflectionLine,
	UPDATE_MARGIN_DAYS,
	writeReflection,
} from "@qorpera/runtime/cloud-platform-updates";
import { CLOUD_RUNTIME_TOOL_OPERATIONS } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, describe, expect, it } from "vitest";
import { catalogs } from "./fixtures/cloud-tool-catalogs-fixture.ts";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";
import { nativeCompanyContextFixture } from "./fixtures/native-company-context-fixture.ts";

const BASELINE_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];

const FIXTURE_UPDATES: readonly PlatformUpdate[] = [
	{ id: "old-kit", kind: "capability", date: "2026-10-01", title: "Old kit", text: "A kit from before." },
	{ id: "bank-kit", kind: "capability", date: "2026-11-10", title: "Bank kit", text: "The bank as a kit." },
	{ id: "gpt-7", kind: "model", date: "2026-11-12", title: "A better model", text: "gpt-7 thinks better." },
	{ id: "short-plans", kind: "behaviour", date: "2026-11-11", title: "Shorter plans", text: "Plans are shorter." },
];

describe("the list of platform updates", () => {
	it("keeps every entry within its bounds: a unique id, a real day not after today, one line each", () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(new Set(PLATFORM_UPDATES.map((update) => update.id)).size).toBe(PLATFORM_UPDATES.length);
		for (const update of PLATFORM_UPDATES) {
			expect(update.id, update.id).toMatch(PLATFORM_UPDATE_ID);
			expect(Buffer.byteLength(update.id), update.id).toBeLessThanOrEqual(64);
			expect(["model", "behaviour", "capability"], update.id).toContain(update.kind);
			expect(isPlatformDay(update.date), update.id).toBe(true);
			expect(update.date <= today, update.id).toBe(true);
			expect(update.title.trim(), update.id).toBe(update.title);
			expect(update.text.trim(), update.id).toBe(update.text);
			expect(update.title.length, update.id).toBeGreaterThan(0);
			expect(update.text.length, update.id).toBeGreaterThan(0);
			expect(Buffer.byteLength(update.title), update.id).toBeLessThanOrEqual(PLATFORM_UPDATE_TITLE_MAX_BYTES);
			expect(Buffer.byteLength(update.text), update.id).toBeLessThanOrEqual(PLATFORM_UPDATE_TEXT_MAX_BYTES);
			expect(`${update.title}${update.text}`, update.id).not.toMatch(/[\n\r]/);
			expect(update.text, update.id).not.toMatch(/#\d|QorperaOS\/|\.(?:md|ts|sql|json)\b/);
		}
	});

	it("names only tools the Co-Founder's company runs have", async () => {
		const { staff } = await catalogs();
		const tools = new Set(staff.map((tool) => tool.name));
		const named = new Set(
			PLATFORM_UPDATES.flatMap((update) =>
				[...update.text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(([name]) => name),
			),
		);
		expect([...named]).toEqual(expect.arrayContaining(["update_reading", "end_role", "save_app"]));
		for (const name of named) expect(tools.has(name), name).toBe(true);
	});

	it("names every model agents can be given: the models of today, or a model update's text", () => {
		const told = PLATFORM_UPDATES.filter((update) => update.kind === "model").map((update) => update.text);
		for (const model of AGENT_MODELS)
			expect(
				BASELINE_MODELS.includes(model) || told.some((text) => text.includes(model)),
				`${model} reached agents without a model update in PLATFORM_UPDATES`,
			).toBe(true);
	});

	it("takes the decisions that fit each kind", () => {
		expect(decisionsFor("capability")).toEqual(["use", "later", "not"]);
		expect(decisionsFor("model")).toEqual(["reviewed"]);
		expect(decisionsFor("behaviour")).toEqual(["use", "later", "not", "reviewed"]);
	});
});

describe("the company's record of its reflections", () => {
	const FILE = `${REFLECTIONS_HEADING}
Our own note: Strategy reads this on Mondays.
- map-kit | 2026-11-17 | use | Strategy keeps the company's map; first layer from our reading.
- shape-kits | 2026-11-17 | later | We have no numbers that change over time yet.
- not a reflection
- shape-kits | 2026-11-31 | use | A day that is no day.
*   Bank-Kit|2026-11-18|LATER|  Spaces and case are read.
- gpt-7 | 2026-11-18 | maybe | No such decision.
- shape-kits | 2026-11-19 | use | Shop shows its stock on a shelf.
`;

	it("reads the lines that read, skips the rest, and keeps the newest line for an id", () => {
		expect(parseReflections(FILE)).toEqual([
			{
				id: "map-kit",
				day: "2026-11-17",
				decision: "use",
				line: "Strategy keeps the company's map; first layer from our reading.",
			},
			{
				id: "shape-kits",
				day: "2026-11-17",
				decision: "later",
				line: "We have no numbers that change over time yet.",
			},
			{ id: "bank-kit", day: "2026-11-18", decision: "later", line: "Spaces and case are read." },
			{ id: "shape-kits", day: "2026-11-19", decision: "use", line: "Shop shows its stock on a shelf." },
		]);
		expect(newestReflections(parseReflections(FILE)).get("shape-kits")?.decision).toBe("use");
		expect(parseReflections("")).toEqual([]);
	});

	it("reads every line, so a record of more than 200 lines keeps its old decisions", () => {
		const lines = [
			REFLECTIONS_HEADING,
			"- bank-kit | 2026-11-12 | use | Money owner draws the bank.",
			...Array.from({ length: 250 }, (_, index) => `- kit-${index} | 2026-11-17 | not | Not for us.`),
		];
		const read = parseReflections(lines.join("\n"));
		expect(read).toHaveLength(251);
		expect(newestReflections(read).get("bank-kit")?.decision).toBe("use");
		expect(
			pendingPlatformUpdates(FIXTURE_UPDATES, newestReflections(read), "2026-11-01", "2026-11-20").map(
				(update) => update.id,
			),
		).toEqual(["short-plans", "gpt-7"]);
	});

	it("writes one canonical line last and keeps every other line as written, and reads it back", () => {
		const reflection = {
			id: "map-kit",
			day: "2026-11-20",
			decision: "not" as const,
			line: "Not now: no reading yet.",
		};
		expect(reflectionLine(reflection)).toBe("- map-kit | 2026-11-20 | not | Not now: no reading yet.");
		expect(writeReflection(null, reflection)).toBe(
			`${REFLECTIONS_HEADING}\n- map-kit | 2026-11-20 | not | Not now: no reading yet.\n`,
		);
		expect(writeReflection(FILE, reflection)).toBe(
			`${FILE}- map-kit | 2026-11-20 | not | Not now: no reading yet.\n`,
		);
		expect(writeReflection("# Ours\n- odd line", reflection)).toBe(
			"# Ours\n- odd line\n- map-kit | 2026-11-20 | not | Not now: no reading yet.\n",
		);
		expect(parseReflections(writeReflection(FILE, reflection)).at(-1)).toEqual(reflection);
		expect(parseReflections(writeReflection(null, reflection))).toEqual([reflection]);
	});
});

describe("pending updates", () => {
	const recorded = (lines: string[]) => newestReflections(parseReflections(lines.join("\n")));
	const ids = (updates: readonly PlatformUpdate[]) => updates.map((update) => update.id);

	it("are every update since the company was made when nothing is recorded, oldest first", () => {
		expect(ids(pendingPlatformUpdates(FIXTURE_UPDATES, new Map(), "2026-11-01", "2026-11-20"))).toEqual([
			"bank-kit",
			"short-plans",
			"gpt-7",
		]);
		expect(ids(pendingPlatformUpdates(FIXTURE_UPDATES, new Map(), "2026-09-01", "2026-11-20"))[0]).toBe("old-kit");
	});

	it("count an update dated at most 30 days before the company was made, which its PR's day may be", () => {
		const dated = (date: string): PlatformUpdate => ({
			id: "kit",
			kind: "capability",
			date,
			title: "Kit",
			text: "Kit.",
		});
		const pending = (date: string) =>
			ids(pendingPlatformUpdates([dated(date)], new Map(), "2026-12-10", "2026-12-20"));
		expect(UPDATE_MARGIN_DAYS).toBe(30);
		expect(pending("2026-11-11")).toEqual(["kit"]);
		expect(pending("2026-11-10")).toEqual(["kit"]);
		expect(pending("2026-11-09")).toEqual([]);
		expect(pending("2026-12-10")).toEqual(["kit"]);
		expect(ids(pendingPlatformUpdates(FIXTURE_UPDATES, new Map(), "2026-11-11", "2026-11-20"))).toEqual([
			"bank-kit",
			"short-plans",
			"gpt-7",
		]);
	});

	it("leave the list once recorded, and a later comes back after 28 days", () => {
		const all = (lines: string[], today: string) =>
			ids(pendingPlatformUpdates(FIXTURE_UPDATES, recorded(lines), "2026-11-01", today));
		expect(
			all(
				[
					"- bank-kit | 2026-11-12 | use | Money owner draws the bank.",
					"- gpt-7 | 2026-11-12 | reviewed | Plans redone by the owners.",
					"- short-plans | 2026-11-12 | not | We keep long plans.",
				],
				"2026-11-20",
			),
		).toEqual([]);
		const later = ["- bank-kit | 2026-11-12 | later | No bank yet."];
		expect(all(later, "2026-12-10")).toEqual(["short-plans", "gpt-7"]);
		expect(all(later, "2026-12-11")).toEqual(["bank-kit", "short-plans", "gpt-7"]);
		expect(all([...later, "- bank-kit | 2026-12-11 | use | The bank is open now."], "2027-02-01")).toEqual([
			"short-plans",
			"gpt-7",
		]);
	});

	it("show at most six in the context, with how many more", () => {
		const many = Array.from(
			{ length: 8 },
			(_, index): PlatformUpdate => ({
				id: `kit-${index}`,
				kind: "capability",
				date: `2026-11-${String(10 + index).padStart(2, "0")}`,
				title: `Kit ${index}`,
				text: `Kit ${index}.`,
			}),
		);
		const context = cloudPlatformUpdatesContext(pendingPlatformUpdates(many, new Map(), "2026-11-01", "2026-11-20"));
		expect(context?.pending?.map((update) => update.id)).toEqual([
			"kit-0",
			"kit-1",
			"kit-2",
			"kit-3",
			"kit-4",
			"kit-5",
		]);
		expect(context?.more).toBe(2);
		expect(context?.pending?.[0]).toEqual({
			id: "kit-0",
			kind: "capability",
			date: "2026-11-10",
			title: "Kit 0",
			text: "Kit 0.",
		});
		expect(cloudPlatformUpdatesContext(many.slice(0, 2))).not.toHaveProperty("more");
		expect(cloudPlatformUpdatesContext([])).toBeUndefined();
	});
});

describe("reading the updates for a run", () => {
	const runs: CloudNativeToolRun[] = [];
	afterEach(() => {
		for (const run of runs.splice(0)) run.close();
	});

	it("dates the company by its vision folder, reads its record, and names both reads to release", async () => {
		const f = await folderWriterFixture({
			folders: ["QorperaOS/vision"],
			files: { [REFLECTIONS_PATH]: `${REFLECTIONS_HEADING}\n- bank-kit | 2026-11-12 | use | Money owner.\n` },
		});
		runs.push(f.run);
		const read = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			FIXTURE_UPDATES,
		);
		expect(read.context?.pending?.map((update) => update.id)).toEqual(["old-kit", "short-plans", "gpt-7"]);
		expect(read.reads.map((entry) => entry.path)).toEqual(["QorperaOS/vision", REFLECTIONS_PATH]);
		const none = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			[],
		);
		expect(none).toEqual({ context: undefined, reads: [] });
	});

	it("tells the Co-Founder to shorten a record too large to read, and shows no list it cannot trust", async () => {
		const big = `${REFLECTIONS_HEADING}\n${"- an own note that a founder wrote by hand into the record\n".repeat(5000)}`;
		const f = await folderWriterFixture({ folders: ["QorperaOS/vision"], files: { [REFLECTIONS_PATH]: big } });
		runs.push(f.run);
		expect(Buffer.byteLength(big)).toBeGreaterThan(REFLECTIONS_READ_MAX_BYTES);
		const read = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			FIXTURE_UPDATES,
		);
		expect(read.context).toEqual({ problem: REFLECTIONS_PROBLEM });
		expect(REFLECTIONS_PROBLEM).toBe(
			"QorperaOS/vision/reflections.md is not a text file of at most 256 KiB, so the updates you have not reflected on cannot be shown: keep only the newest line for each update in it.",
		);
		expect(read.reads.map((entry) => entry.path)).toEqual(["QorperaOS/vision", REFLECTIONS_PATH]);
		const none = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			[],
		);
		expect(none).toEqual({ context: undefined, reads: [] });
		const handEdited = `${REFLECTIONS_HEADING}\n${"- a note\n".repeat(20000)}- bank-kit | 2026-11-12 | use | Money owner.\n`;
		expect(Buffer.byteLength(handEdited)).toBeGreaterThan(REFLECTIONS_MAX_BYTES);
		f.seed(REFLECTIONS_PATH, handEdited);
		const kept = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			FIXTURE_UPDATES,
		);
		expect(kept.context?.pending?.map((update) => update.id)).toEqual(["old-kit", "short-plans", "gpt-7"]);
	});

	it("reads no record as none, and fails without a vision folder", async () => {
		const f = await folderWriterFixture({ folders: ["QorperaOS/vision"] });
		runs.push(f.run);
		const read = await readCloudPlatformUpdates(
			f.folder,
			new Date("2026-11-20T08:00:00Z"),
			new AbortController().signal,
			FIXTURE_UPDATES,
		);
		expect(read.context?.pending?.map((update) => update.id)).toEqual([
			"old-kit",
			"bank-kit",
			"short-plans",
			"gpt-7",
		]);
		expect(read.reads.map((entry) => entry.path)).toEqual(["QorperaOS/vision"]);
		const bare = await folderWriterFixture();
		runs.push(bare.run);
		await expect(
			readCloudPlatformUpdates(bare.folder, new Date("2026-11-20T08:00:00Z"), new AbortController().signal),
		).rejects.toThrow();
	});
});

describe("updates in a run's context and instructions", () => {
	const wake = (kind: string, source: string, final: string, extra: Record<string, unknown> = {}) =>
		({
			kind,
			source: { kind: source, id: randomUUID(), occurrenceKey: `${source}:1` },
			policy: { final },
			...extra,
		}) as never;
	const routine = wake("routine", "schedule", "optional", { routine: { dynamic: false } });
	const compile = (agentKind: "cofounder" | "employee", runWake: never, tools: string[]) => {
		const f = nativeCompanyContextFixture();
		f.context.agentKind = agentKind;
		return compileCloudNativeCompanyInstructions(parseCloudNativeCompanyContext(f.context, f.binding), runWake, {
			head: "# Head",
			tools: new Set(tools),
		});
	};
	const SENTENCE = "When your context has updates";

	it("opens the planning run with the reflection, only for a run that can record it", () => {
		const planning = compile("cofounder", routine, ["record_reflection", "company_read"]);
		expect(planning).toContain(`# Your planning run\n${SENTENCE}, the platform the company runs on has changed`);
		expect(planning.split(SENTENCE)).toHaveLength(2);
		expect(planning.indexOf(SENTENCE)).toBeLessThan(planning.indexOf("In a planning run, read the vision"));
		expect(compile("cofounder", routine, ["company_read"])).not.toContain(SENTENCE);
		expect(compile("cofounder", wake("human", "input", "required"), ["record_reflection"])).not.toContain(SENTENCE);
		expect(compile("employee", routine, ["record_reflection"])).not.toContain(SENTENCE);
	});

	it("puts updates beside openWork in the context message, and nothing without them", () => {
		const f = nativeCompanyContextFixture();
		const context = parseCloudNativeCompanyContext(f.context, f.binding);
		const updates = cloudPlatformUpdatesContext(FIXTURE_UPDATES);
		const shown = JSON.parse(
			composeCloudNativeCompanyPrompt(
				context,
				null,
				undefined,
				undefined,
				{ todos: { open: 1, blocked: 0 }, workers: { active: 0, blocked: 0 } },
				undefined,
				undefined,
				undefined,
				undefined,
				[],
				updates,
			),
		);
		expect(shown.updates).toEqual(updates);
		expect(Object.keys(shown).indexOf("updates")).toBe(Object.keys(shown).indexOf("openWork") + 1);
		expect(JSON.parse(composeCloudNativeCompanyPrompt(context))).not.toHaveProperty("updates");
	});
});

describe("record_reflection", () => {
	const runs: CloudNativeToolRun[] = [];
	afterEach(() => {
		for (const run of runs.splice(0)) run.close();
	});
	const NOW = new Date("2026-11-20T08:00:00Z");

	async function fixture(
		files: Record<string, string> = {},
		folder?: (real: CloudCompanyFolderClient) => CloudCompanyFolderClient,
	) {
		const f = await folderWriterFixture({ files, folders: ["QorperaOS/vision"] });
		runs.push(f.run);
		const tool = cloudRecordReflectionTool({
			folder: folder ? folder(f.folder) : f.folder,
			operations: f.operations(),
			identity: f.identity,
			updates: FIXTURE_UPDATES,
			now: () => NOW,
		});
		const call = async (value: Record<string, JsonValue>) => {
			const content = await tool.execute(tool.parseArguments({ operationKey: randomUUID(), ...value }), {
				...f.context,
				callId: randomUUID(),
			});
			return JSON.parse(String(content.value));
		};
		return { ...f, tool, call };
	}

	it("is the Co-Founder's bookkeeping, named in the observations' list, opened on demand", () => {
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("record_reflection");
		const tool = cloudRecordReflectionTool({
			folder: {} as never,
			operations: {} as never,
			identity: {} as never,
		});
		expect(cloudToolsOnDemand([tool], "cofounder").deferred.has("record_reflection")).toBe(true);
	});

	it("saves a new record with its heading, then a line last, and answers unchanged for the same again", async () => {
		const f = await fixture();
		await expect(
			f.call({ update: "bank-kit", decision: "later", line: "No bank account yet." }),
		).resolves.toMatchObject({
			schema: "qorpera.platform-reflection/v1",
			update: "bank-kit",
			decision: "later",
			day: "2026-11-20",
			outcome: "saved",
			file: REFLECTIONS_PATH,
		});
		expect(f.text(REFLECTIONS_PATH)).toBe(
			`${REFLECTIONS_HEADING}\n- bank-kit | 2026-11-20 | later | No bank account yet.\n`,
		);
		expect(f.commits[0]?.units[0]).toMatchObject({ op: "write", path: REFLECTIONS_PATH });
		expect(f.commits[0]?.units[0]).not.toHaveProperty("expectedVersion");
		await expect(
			f.call({ update: "gpt-7", decision: "reviewed", line: "Plans and jobs gone over again." }),
		).resolves.toMatchObject({
			outcome: "saved",
		});
		expect(f.commits[1]?.units[0]).toMatchObject({ expectedVersion: expect.any(String) });
		expect(f.text(REFLECTIONS_PATH)).toBe(
			`${REFLECTIONS_HEADING}\n- bank-kit | 2026-11-20 | later | No bank account yet.\n- gpt-7 | 2026-11-20 | reviewed | Plans and jobs gone over again.\n`,
		);
		await expect(f.call({ update: "bank-kit", decision: "later", line: "Said once more." })).resolves.toMatchObject({
			outcome: "unchanged",
		});
		expect(f.commits).toHaveLength(2);
		expect(f.releases.at(-1)?.p_reads).toEqual([expect.objectContaining({ path: REFLECTIONS_PATH })]);
		await expect(
			f.call({ update: "short-plans", decision: "reviewed", line: "Routines shortened." }),
		).resolves.toMatchObject({
			outcome: "saved",
		});
	});

	it("keeps the company's own lines as written", async () => {
		const own = `${REFLECTIONS_HEADING}\nWe keep this file by hand too.\n- bank-kit | 2026-11-12 | later | No bank yet.`;
		const f = await fixture({ [REFLECTIONS_PATH]: own });
		await expect(
			f.call({ update: "bank-kit", decision: "use", line: "Money owner draws the bank." }),
		).resolves.toMatchObject({
			outcome: "saved",
		});
		expect(f.text(REFLECTIONS_PATH)).toBe(`${own}\n- bank-kit | 2026-11-20 | use | Money owner draws the bank.\n`);
	});

	it("refuses before writing an unknown update, a decision its kind does not take, and a line that is not one", () => {
		const parse = (value: Record<string, JsonValue>) =>
			parseRecordReflectionArguments(
				{ operationKey: "k1", update: "bank-kit", decision: "use", line: "Yes.", ...value },
				FIXTURE_UPDATES,
			);
		expect(parse({})).toEqual({ operationKey: "k1", update: "bank-kit", decision: "use", line: "Yes." });
		for (const [value, words] of [
			[{ update: "no-such-kit" }, "update is no platform update's id"],
			[{ decision: "reviewed" }, "bank-kit is a capability: its decision is use or later or not"],
			[{ update: "gpt-7", decision: "use" }, "gpt-7 is a new model: its decision is reviewed"],
			[{ update: "gpt-7", decision: "not" }, "gpt-7 is a new model"],
			[{ decision: "maybe" }, "decision is one of use, later, not, reviewed"],
			[{ line: "" }, "line is one line of 1 to 160 bytes"],
			[{ line: "two\nlines" }, "line is one line"],
			[{ line: "x".repeat(161) }, "line is one line"],
			[{ extra: true }, "record_reflection takes exactly"],
		] as const) {
			expect(() => parse(value as Record<string, JsonValue>)).toThrow(CloudToolArgumentRefusal);
			expect(() => parse(value as Record<string, JsonValue>)).toThrow(words);
		}
		expect(parse({ update: "short-plans", decision: "reviewed" }).decision).toBe("reviewed");
		expect(parse({ line: "é".repeat(80) }).line).toHaveLength(80);
	});

	it("refuses a record that would pass 64 KiB, or cannot be read, with advice that keeps every decision", async () => {
		const near = `${REFLECTIONS_HEADING}\n${"- a note\n".repeat(Math.floor((REFLECTIONS_MAX_BYTES - 40) / 9))}`;
		const f = await fixture({ [REFLECTIONS_PATH]: near });
		const refused = (value: Record<string, JsonValue>) =>
			f.call(value).then(
				() => null,
				(thrown: unknown) => thrown,
			);
		const full = await refused({ update: "bank-kit", decision: "use", line: "Money owner draws the bank." });
		expect(full).toBeInstanceOf(CloudToolRefusal);
		expect((full as Error).message).toBe(
			"QorperaOS/vision/reflections.md would be larger than 64 KiB: keep only the newest line for each update in it, then call again",
		);
		f.seed(REFLECTIONS_PATH, "x".repeat(REFLECTIONS_READ_MAX_BYTES + 1));
		const unreadable = await refused({ update: "bank-kit", decision: "use", line: "Money owner draws the bank." });
		expect(unreadable).toBeInstanceOf(CloudToolRefusal);
		expect((unreadable as Error).message).toBe(
			"QorperaOS/vision/reflections.md is not a text file of at most 256 KiB: keep only the newest line for each update in it, then call again",
		);
		expect(f.commits).toHaveLength(0);
	});

	it("answers conflict when the record changed since it was read, and writes nothing", async () => {
		const f = await fixture({ [REFLECTIONS_PATH]: `${REFLECTIONS_HEADING}\n` }, (real) => {
			let seeded = false;
			return {
				readText: async (...args: Parameters<CloudCompanyFolderClient["readText"]>) => {
					const found = await real.readText(...args);
					if (!seeded) {
						seeded = true;
						f.seed(
							REFLECTIONS_PATH,
							`${REFLECTIONS_HEADING}\n- map-kit | 2026-11-19 | use | Written meanwhile.\n`,
						);
					}
					return found;
				},
				commit: (...args: Parameters<CloudCompanyFolderClient["commit"]>) => real.commit(...args),
				release: (...args: Parameters<CloudCompanyFolderClient["release"]>) => real.release(...args),
			} as unknown as CloudCompanyFolderClient;
		});
		await expect(f.call({ update: "bank-kit", decision: "not", line: "Not for us." })).resolves.toMatchObject({
			outcome: "conflict",
			next: expect.stringContaining("call again with a new operationKey"),
		});
		expect(f.text(REFLECTIONS_PATH)).toBe(
			`${REFLECTIONS_HEADING}\n- map-kit | 2026-11-19 | use | Written meanwhile.\n`,
		);
	});
});
