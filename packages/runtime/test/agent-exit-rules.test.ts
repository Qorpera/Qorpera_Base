import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentExitRulesReader, companyRules } from "@qorpera/runtime/agent-exit-rules";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const A = "0b6f2d8e-3c1a-4e5f-9a7b-1c2d3e4f5a6b";
const B = "1e2d3c4b-5a69-4788-97a6-b5c4d3e2f100";
const C = "2f3e4d5c-6b7a-4899-a8b7-c6d5e4f30211";
const V1 = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const V2 = "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";

let root: string;
let clients: string;
let rulesFile: string;
let statusFile: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qorpera-agent-exit-rules-test-"));
	clients = join(root, "clients");
	await mkdir(clients);
	await mkdir(join(root, "state"));
	await mkdir(join(root, "run"));
	rulesFile = join(root, "state", "rules.json");
	statusFile = join(root, "run", "status.json");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

async function plug(address: string, company: unknown): Promise<void> {
	await writeFile(
		join(clients, `${address}.json`),
		`${JSON.stringify({ schema: "qorpera.agent-plug/v1", address, company, machine: "m", kind: "agent" })}\n`,
	);
}

type Row = Record<string, unknown>;

function database(answer: (companies: string[]) => Row[] | Error) {
	return {
		query: vi.fn(async (_text: string, values: readonly unknown[]) => {
			const result = answer(values[0] as string[]);
			if (result instanceof Error) throw result;
			return { rows: result };
		}),
	};
}

function row(company: string, version: string, block: string[] = [], allow: string[] = [], mode = "open"): Row {
	return { company, version, mode, block, allow };
}

function reader(db: ReturnType<typeof database>, now = () => Date.parse("2026-10-09T12:00:00.000Z")) {
	return new AgentExitRulesReader({ database: db as never, clientsDir: clients, rulesFile, statusFile, now });
}

async function rules(): Promise<unknown> {
	return JSON.parse(await readFile(rulesFile, "utf8"));
}

async function status(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(statusFile, "utf8"));
}

it("asks for the client map's companies and writes every one: rules, or null for open", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	await plug("10.210.1.2", B);
	await plug("10.210.1.3", A);
	await plug("10.210.1.4", A);
	await plug("10.210.1.5", "acme-company");
	await plug("10.210.1.6", A.toUpperCase());
	await writeFile(join(clients, "10.210.1.7.json"), "{not json");
	await writeFile(join(clients, ".10.210.1.8.json.tmp"), JSON.stringify({ company: C }));
	await writeFile(join(clients, "10.210.1.9.txt"), JSON.stringify({ company: C }));
	await symlink(join(root, "elsewhere.json"), join(clients, "10.210.1.10.json"));
	await writeFile(join(root, "elsewhere.json"), JSON.stringify({ company: C }));
	await mkdir(join(clients, "10.210.1.11.json"));
	const db = database(() => [row(A, V1, ["casino.example", "*.torrents.example"], ["docs.example"])]);
	const status1 = await reader(db).pass();
	expect(db.query).toHaveBeenCalledExactlyOnceWith(
		"select company_id::text as company, version::text as version, mode, block, allow from public.qorpera_agent_exit_network_rules($1::uuid[])",
		[[A, B]],
	);
	const text = await readFile(rulesFile, "utf8");
	expect(text).toBe(
		`{"schema":"qorpera.agent-exit-rules/v1","companies":{"${A}":{"version":"${V1}","mode":"open","block":["casino.example","*.torrents.example"],"allow":["docs.example"]},"${B}":null}}\n`,
	);
	expect((await stat(rulesFile)).mode & 0o777).toBe(0o600);
	expect((await stat(statusFile)).mode & 0o777).toBe(0o644);
	expect(status1).toEqual({
		schema: "qorpera.agent-exit-rules-status/v1",
		checkedAt: "2026-10-09T12:00:00.000Z",
		readAt: "2026-10-09T12:00:00.000Z",
		ok: true,
		problem: null,
		companies: 2,
		withRules: 1,
		badRows: 0,
		skipped: 5,
	});
	expect(await status()).toEqual(status1);
});

it("calls once with no company, so a pass proves the login, and asks at most 10000 companies a call", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const empty = database(() => []);
	expect((await reader(empty).pass()).ok).toBe(true);
	expect(empty.query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [[]]);
	expect(await rules()).toEqual({ schema: "qorpera.agent-exit-rules/v1", companies: {} });
	const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
	const companies = Array.from({ length: 10_001 }, (_, index) => id(index));
	for (let start = 0; start < companies.length; start += 500) {
		const batch = companies.slice(start, start + 500);
		await Promise.all(batch.map((company, index) => plug(`10.211.${start}.${index}`, company)));
	}
	const last = id(10_000);
	const many = database((asked) => (asked.includes(last) ? [row(last, V1)] : []));
	const result = await reader(many).pass();
	expect(many.query.mock.calls.map((call) => (call[1][0] as string[]).length)).toEqual([10_000, 1]);
	expect(many.query.mock.calls[1]?.[1][0]).toEqual([last]);
	expect(result).toMatchObject({ ok: true, companies: 10_001, withRules: 1 });
}, 30_000);

it("rewrites the rules file only when the rules change, and drops companies no longer plugged in", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	await plug("10.210.1.2", A);
	await plug("10.210.1.3", B);
	let version = V1;
	const db = database(() => [row(A, version, ["casino.example"])]);
	const exit = reader(db);
	await exit.pass();
	const first = await stat(rulesFile);
	await exit.pass();
	expect((await stat(rulesFile)).ino).toBe(first.ino);
	version = V2;
	await exit.pass();
	expect((await stat(rulesFile)).ino).not.toBe(first.ino);
	expect(await rules()).toEqual({
		schema: "qorpera.agent-exit-rules/v1",
		companies: { [A]: { version: V2, mode: "open", block: ["casino.example"], allow: [] }, [B]: null },
	});
	await rm(join(clients, "10.210.1.2.json"));
	await exit.pass();
	expect(await rules()).toEqual({ schema: "qorpera.agent-exit-rules/v1", companies: { [B]: null } });
});

it("keeps the last rules when the database fails, and reports and logs only a code", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await plug("10.210.1.2", A);
	let now = Date.parse("2026-10-09T12:00:00.000Z");
	let answer: Row[] | Error = [row(A, V1, ["casino.example"])];
	const clock = () => now;
	const exit = reader(
		database(() => answer),
		clock,
	);
	await exit.pass();
	const kept = await readFile(rulesFile, "utf8");
	expect(log).toHaveBeenCalledExactlyOnceWith("Agent exit rules: reading the rules.");
	const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
	const failures: Array<[Error, string]> = [
		[coded("password authentication failed for user qorpera_agent_exit s3cret", "28P01"), "28P01"],
		[coded("connect ECONNREFUSED 10.0.0.1:5432", "ECONNREFUSED"), "ECONNREFUSED"],
		[new Error("Query read timeout"), "TIMEOUT"],
		[coded("odd", "not a code"), "DATABASE"],
		[new Error("anything else"), "DATABASE"],
	];
	for (const [error, code] of failures) {
		now += 2000;
		answer = error;
		const result = await exit.pass();
		expect(result).toMatchObject({
			ok: false,
			problem: code,
			readAt: "2026-10-09T12:00:00.000Z",
			companies: 1,
			withRules: 1,
		});
		expect(await status()).toEqual(result);
		expect(await readFile(rulesFile, "utf8")).toBe(kept);
	}
	now += 2000;
	await exit.pass();
	expect(log.mock.calls.map((call) => call[0])).toEqual([
		"Agent exit rules: reading the rules.",
		"Agent exit rules: cannot read the rules (28P01); the last rules stay.",
		"Agent exit rules: cannot read the rules (ECONNREFUSED); the last rules stay.",
		"Agent exit rules: cannot read the rules (TIMEOUT); the last rules stay.",
		"Agent exit rules: cannot read the rules (DATABASE); the last rules stay.",
	]);
	answer = [row(A, V1, ["casino.example"])];
	now += 2000;
	expect(await exit.pass()).toMatchObject({ ok: true, readAt: new Date(now).toISOString() });
	expect(log).toHaveBeenLastCalledWith("Agent exit rules: reading the rules.");
	expect(JSON.stringify(log.mock.calls)).not.toMatch(/s3cret|10\.0\.0\.1|password/);
});

it("refuses rows not as the database writes them: a company keeps its last rules or stays unknown", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await plug("10.210.1.2", A);
	let answer: Row[] = [row(A, V1, ["casino.example"])];
	const exit = reader(database(() => answer));
	await exit.pass();
	await plug("10.210.1.3", B);
	await plug("10.210.1.4", C);
	answer = [
		row(A, V2, ["Casino.example"]),
		row(B, V1, ["casino.example"], ["casino.example"]),
		row(C, V1),
		row(C, V2),
		row("3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d", V1),
	];
	const result = await exit.pass();
	expect(result).toMatchObject({ ok: false, problem: "BAD_ROWS", badRows: 4, companies: 1, withRules: 1 });
	expect(await rules()).toEqual({
		schema: "qorpera.agent-exit-rules/v1",
		companies: { [A]: { version: V1, mode: "open", block: ["casino.example"], allow: [] } },
	});
	expect(log).toHaveBeenLastCalledWith(
		"Agent exit rules: 4 rows refused (BAD_ROWS); those companies keep their last rules.",
	);
});

it("starts from the last run's rules file, so companies stay known while the database cannot be read", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	await plug("10.210.1.2", A);
	const saved = `{"schema":"qorpera.agent-exit-rules/v1","companies":{"${A}":{"version":"${V1}","mode":"only-listed","block":[],"allow":["docs.example"]},"${B}":null}}\n`;
	await writeFile(rulesFile, saved, { mode: 0o600 });
	const failing = reader(database(() => Object.assign(new Error("down"), { code: "57P03" })));
	expect(await failing.pass()).toMatchObject({
		ok: false,
		problem: "57P03",
		readAt: null,
		companies: 2,
		withRules: 1,
	});
	expect(await readFile(rulesFile, "utf8")).toBe(saved);
	await writeFile(rulesFile, `{"schema":"qorpera.agent-exit-rules/v1","companies":{"${A}":{"version":"x"}}}\n`);
	const fresh = reader(database(() => Object.assign(new Error("down"), { code: "57P03" })));
	expect(await fresh.pass()).toMatchObject({ ok: false, companies: 0, withRules: 0 });
	const working = reader(database(() => [row(A, V1)]));
	expect(await working.pass()).toMatchObject({ ok: true, companies: 1 });
	expect(await rules()).toEqual({
		schema: "qorpera.agent-exit-rules/v1",
		companies: { [A]: { version: V1, mode: "open", block: [], allow: [] } },
	});
});

it("reports a client map it cannot read, or a rules file it cannot write, and keeps the last rules", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const db = database(() => []);
	await rm(clients, { recursive: true });
	expect(await reader(db).pass()).toMatchObject({ ok: false, problem: "CLIENTS", readAt: null });
	expect(db.query).not.toHaveBeenCalled();
	await mkdir(clients);
	rulesFile = join(root, "missing", "rules.json");
	expect(await reader(db).pass()).toMatchObject({ ok: false, problem: "WRITE", readAt: null });
	expect(await status()).toMatchObject({ problem: "WRITE" });
});

it("passes at once and every interval until closed", async () => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const db = database(() => []);
	const exit = new AgentExitRulesReader({
		database: db as never,
		clientsDir: clients,
		rulesFile,
		statusFile,
		passEveryMs: 5,
	});
	exit.start();
	exit.start();
	await vi.waitFor(() => expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(3));
	await exit.close();
	const calls = db.query.mock.calls.length;
	await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	expect(db.query).toHaveBeenCalledTimes(calls);
});

it("reads one company's rules as the database writes them, and nothing else", () => {
	const good = {
		version: V1,
		mode: "only-listed",
		block: ["*.torrents.example"],
		allow: ["docs.example", "a.b.example"],
	};
	const thousand = Array.from({ length: 1000 }, (_, index) => `n${index}.example`);
	expect(companyRules(good)).toEqual(good);
	for (const bad of [
		null,
		[],
		{ ...good, extra: 1 },
		{ version: V1, mode: "open", block: [] },
		{ ...good, version: V1.toUpperCase() },
		{ ...good, mode: "closed" },
		{ ...good, block: "casino.example" },
		{ ...good, block: ["casino.example", "casino.example"] },
		{ ...good, block: ["https://casino.example"] },
		{ ...good, block: ["10.0.0.1"] },
		{ ...good, block: [7] },
		{ ...good, allow: ["*.torrents.example"] },
		{ ...good, block: [...thousand, "n1000.example"] },
	])
		expect(companyRules(bad)).toBeNull();
	expect(companyRules({ ...good, block: thousand })).not.toBeNull();
});
