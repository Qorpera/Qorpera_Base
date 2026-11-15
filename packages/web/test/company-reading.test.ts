// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { READING_PATH, type ReadingFile, writeReadingFile } from "@qorpera/cloud-client/company-state-files";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appReading, CompanyReading, type ReadingPeople } from "../src/app/company-reading.ts";
import { AppBridge, type CompanyApp } from "../src/app/interface-apps.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { type CompanyStanding, parseCompanyStanding, STANDING_KEYS } from "../src/cloud/company-standing.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";

/* The door `qorpera.reading()` (app/company-reading.ts; Jonas, 15 November 2026: "Use a map kit"): the company's
 * reading of itself, its agents and its standing, for a page whose manifest reads `reading`, as plain names. */

const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const VIEWER = id(1);
const agent = (n: number, name: string, creature: string, extra: Partial<HostedStaffAgent> = {}): HostedStaffAgent => ({
	profileId: id(3),
	id: id(n),
	displayName: name,
	role: name,
	charter: name,
	appearance: { color: "", shape: "", creature },
	employmentStatus: "active",
	lifecycleState: "active",
	version: 1,
	createdAt: `2026-11-01T09:00:${String(n).padStart(2, "0")}Z`,
	updatedAt: "2026-11-01T09:00:00Z",
	updatedByUserId: VIEWER,
	...extra,
});
const research = agent(41, "Customer research", "heart");
const cofounder = agent(40, "Co-Founder", "crown");
const product = agent(45, "Product", "puzzle");
const market = agent(42, "Market", "planet", { employmentStatus: "archived" });
/** Handles unlike the names, so an answer that carried one would show it. */
const HANDLES = new Map([
	["ceo-x", cofounder.id],
	["cust-res", research.id],
	["prod-x", product.id],
	["mkt-q", market.id],
]);
const member = (userId: string, name: string, role: HostedProfileMember["role"]): HostedProfileMember => ({
	userId,
	email: `${name.toLowerCase()}@example.invalid`,
	displayName: name,
	role,
	joinedAt: "2026-11-01T09:00:00Z",
});
const people = (working: readonly string[] = [product.id]): ReadingPeople => ({
	staff: [product, research, cofounder, market],
	working: (agentId) => working.includes(agentId),
	cofounderId: cofounder.id,
	members: [member(VIEWER, "Jonas", "owner"), member(id(60), "Sofie", "admin")],
	viewer: VIEWER,
});
const thing = (
	key: string,
	name: string,
	shape: ReadingFile["things"][number]["shape"],
	agents: string[],
	waitsFor: string[] = [],
) => ({ key, name, shape, full: 40, state: "On paper", agents, waitsFor });
const FILE: Omit<ReadingFile, "kind"> = {
	sentence: "We know what a workshop needs and have a repair tracker on paper.",
	line: "One thing waits for you.",
	attention: "tracker",
	things: [
		thing("needs", "What workshops need", "factory", ["cust-res"]),
		// an ended agent and one the company does not have stand nowhere
		thing("market", "The market", "pin", ["mkt-q", "nobody"]),
		thing("tracker", "The repair tracker", "board", ["prod-x", "ceo-x"], [id(60)]),
		thing("money", "Money", "coin", [], ["founders"]),
	],
	changes: [
		{ agent: "prod-x", what: "joined", line: "Product joined" },
		{ agent: "market", what: "ended", line: "Market's watch ended" },
		{ agent: "ghost", what: "changed", line: "Somebody changed" },
	],
	notes: ["Ask about the price"],
};
const TEXT = writeReadingFile(FILE);
const STOPPED: CompanyStanding = {
	stopped: true,
	since: "2026-11-15T07:00:00.000Z",
	why: "login_full",
	member: id(60),
	resetsAt: "2026-11-20T07:00:00.000Z",
	waiting: 3,
};

/** The member's folder with the reading (or none), its versions, and the agents' folders. */
function folder(text: () => string | null) {
	const reads = { entries: 0, bytes: 0, folders: 0 };
	const bytes = () => new TextEncoder().encode(text() ?? "");
	return {
		reads,
		read: async (path: string) => {
			reads.entries++;
			const now = text();
			return {
				asOfSeq: 1,
				entry:
					path === READING_PATH && now !== null
						? {
								path,
								kind: "file",
								version: `v${now.length}`,
								seq: 1,
								updatedAt: "2026-11-15T09:00:00Z",
								file: { bytes: bytes().byteLength },
								target: null,
							}
						: null,
			};
		},
		readFile: async () => {
			reads.bytes++;
			return bytes();
		},
		stateFolders: async () => {
			reads.folders++;
			return {
				agents: [...HANDLES].map(([handle, staffAgentId]) => ({
					staffAgentId,
					file: `QorperaOS/agents/${handle}/agent.md`,
				})),
				groups: [],
				routines: null,
			};
		},
	};
}

const reading = (
	text: () => string | null,
	standing: () => Promise<CompanyStanding> = async () => STOPPED,
	signal = new AbortController().signal,
) => {
	const files = folder(text);
	const asked = vi.fn(standing);
	const source = new CompanyReading({ folder: () => files as never, people: () => people(), standing: asked }, signal);
	return { source, files, asked };
};

describe("the company's reading for an app's page", () => {
	it("answers the reading, the team and the standing as plain names", () => {
		const answer = appReading({ kind: "reading", ...FILE }, HANDLES, people(), STOPPED);
		expect(answer.team).toEqual([
			{ name: "Co-Founder", figure: "crown", working: false, cofounder: true },
			{ name: "Customer research", figure: "heart", working: false, cofounder: false },
			{ name: "Product", figure: "puzzle", working: true, cofounder: false },
		]);
		expect(answer.reading).toMatchObject({
			sentence: FILE.sentence,
			line: FILE.line,
			attention: "tracker",
			notes: ["Ask about the price"],
		});
		const things = answer.reading?.things ?? [];
		expect(things.map((each) => each.key)).toEqual(["needs", "market", "tracker", "money"]);
		expect(things[0]).toEqual({
			key: "needs",
			name: "What workshops need",
			shape: "factory",
			full: 40,
			state: "On paper",
			agents: [{ name: "Customer research", figure: "heart", working: false }],
			waits: [],
		});
		// An agent whose role ended, and one the company does not have, stand at no thing.
		expect(things[1]?.agents).toEqual([]);
		expect(things[2]?.agents.map((each) => each.name)).toEqual(["Product", "Co-Founder"]);
		// A member by name; "founders" is every owner, and `me` is the member looking.
		expect(things[2]?.waits).toEqual([{ name: "Sofie", me: false }]);
		expect(things[3]?.waits).toEqual([{ name: "Jonas", me: true }]);
		// A change keeps its line: an ended agent is still named by its figure, one nobody is found for has none.
		expect(answer.reading?.changes).toEqual([
			{ agent: { name: "Product", figure: "puzzle" }, what: "joined", line: "Product joined" },
			{ agent: { name: "Market", figure: "planet" }, what: "ended", line: "Market's watch ended" },
			{ agent: null, what: "changed", line: "Somebody changed" },
		]);
		// The member whose login holds the company by name; the member looking is "you": no name.
		expect(answer.standing).toEqual({
			stopped: true,
			since: STOPPED.since,
			why: "login_full",
			member: "Sofie",
			resetsAt: STOPPED.resetsAt,
		});
		expect(appReading(null, HANDLES, people(), { ...STOPPED, member: VIEWER }).standing?.member).toBeNull();
		// No path, handle, user id or agent id reaches the page.
		const said = JSON.stringify(answer);
		for (const hidden of ["QorperaOS", "ceo-x", "cust-res", "prod-x", "mkt-q", "22222222-", "example.invalid"])
			expect(said, hidden).not.toContain(hidden);
	});

	it("answers no reading, the team and no standing for a company without them", () => {
		const answer = appReading(null, HANDLES, people(), null);
		expect(answer.reading).toBeNull();
		expect(answer.standing).toBeNull();
		expect(answer.team.map((each) => each.name)).toEqual(["Co-Founder", "Customer research", "Product"]);
	});

	it("reads the file's bytes only when it changed, and keeps the last reading that read", async () => {
		let text: string | null = TEXT;
		const { source, files } = reading(() => text);
		const signal = new AbortController().signal;
		expect((await source.read(signal)).reading?.sentence).toBe(FILE.sentence);
		await source.read(signal);
		expect(files.reads).toMatchObject({ entries: 2, bytes: 1, folders: 1 });
		// A file that does not read keeps the reading before it.
		text = `${TEXT}\n## Broken\nkey: Not A Key\n`;
		expect((await source.read(signal)).reading?.sentence).toBe(FILE.sentence);
		// A file taken away is no reading.
		text = null;
		expect((await source.read(signal)).reading).toBeNull();
	});

	it("answers no standing from an older backend, and asks it no more", async () => {
		const missing = new CloudRpcError("qorpera_read_company_standing", { message: "no", code: "PGRST202" }, 404);
		const { source, asked } = reading(
			() => TEXT,
			async () => {
				throw missing;
			},
		);
		const signal = new AbortController().signal;
		expect((await source.read(signal)).standing).toBeNull();
		expect((await source.read(signal)).standing).toBeNull();
		expect(asked).toHaveBeenCalledTimes(1);
	});

	it("holds the standing to the migration's own keys", () => {
		const sql = readFileSync(resolve("../../supabase/migrations/20260930765000_company_reading.sql"), "utf8");
		const built =
			/jsonb_build_object\('schema', 'qorpera\.company-standing\/v1',([\s\S]*?)end \$\$;/.exec(sql)?.[1] ?? "";
		const keys = ["schema", ...[...built.matchAll(/^\s*'([a-zA-Z]+)',/gm)].map((match) => match[1])];
		expect(keys).toEqual([...STANDING_KEYS]);
		expect(
			parseCompanyStanding({
				schema: "qorpera.company-standing/v1",
				stopped: false,
				since: null,
				why: null,
				member: null,
				resetsAt: null,
				waiting: 0,
			}),
		).toMatchObject({ stopped: false, waiting: 0 });
	});
});

describe("the company's standing while a page reads it", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads it every 30 s while a page watches, tells the page when it changed, and stops after", async () => {
		let now: CompanyStanding = { ...STOPPED, stopped: false, why: null, member: null, resetsAt: null };
		const { source, asked } = reading(
			() => TEXT,
			async () => now,
		);
		await source.read(new AbortController().signal);
		expect(asked).toHaveBeenCalledTimes(1);
		const page = new AbortController();
		const changed = vi.fn();
		source.watch(page.signal, changed);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(asked).toHaveBeenCalledTimes(2);
		expect(changed).not.toHaveBeenCalled();
		now = STOPPED;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(changed).toHaveBeenCalledTimes(1);
		expect((await source.read(new AbortController().signal)).standing?.stopped).toBe(true);
		// The tab comes back: read at once.
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(asked).toHaveBeenCalledTimes(4);
		// The page went: no more reads.
		page.abort();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(asked).toHaveBeenCalledTimes(4);
	});
});

describe("the bridge's door to the reading", () => {
	const app = (reads: string): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest(`name = "Map"\nkit = "shelf"\nreads = [${reads}]\n`);
		if (!parsed.ok) throw new Error("manifest");
		return { name: "map", path: "apps/map", manifest: parsed.manifest, problems: [], version: null };
	};
	const answer = {
		reading: null,
		team: [{ name: "Co-Founder", figure: "crown", working: true, cofounder: true }],
		standing: null,
	};
	const bridge = (reads: string, withReading = true) =>
		new AppBridge(
			{
				folder: () => folder(() => null) as never,
				agents: () => [],
				...(withReading ? { reading: { read: async () => answer as never, watch: () => undefined } } : {}),
			},
			app(reads),
			crypto.randomUUID(),
			new AbortController().signal,
		);

	it("answers only a page whose manifest reads reading", async () => {
		expect(await bridge("").answer({ method: "reading", params: {} })).toEqual({
			ok: false,
			error: 'Add "reading" to reads in app.toml to read the company\'s reading of itself',
		});
		expect(await bridge('"agents"').answer({ method: "reading", params: {} })).toMatchObject({ ok: false });
		expect(await bridge('"reading"').answer({ method: "reading", params: {} })).toEqual({ ok: true, value: answer });
		// Where the company's reading can't be read: none, no team, no standing.
		expect(await bridge('"reading"', false).answer({ method: "reading", params: {} })).toEqual({
			ok: true,
			value: { reading: null, team: [], standing: null },
		});
	});
});
