import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { type AddressInfo, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CoreReceipt, CoreRefusal, parseMachineDataPass } from "../src/folder-service/core.ts";
import { type DataDoor, type DoorAnswer, httpsDataDoor } from "../src/folder-service/data-door.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	type BridgeInfo,
	type DataVerb,
	encodeJson,
	type Frame,
	FrameReader,
	type Hello,
	Kind,
	parseDataCall,
	parseHello,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { type DataHandle, FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	CODING,
	CODING_MACHINE_ID,
	codingGrants,
	ENV,
	EXEC_HOST,
	FakeCore,
	FakeUploads,
	folder,
	OFFICE,
	PLACEMENT,
	storeFile,
	TEST_MACHINE,
	testGrants,
	v,
} from "./folder-service-fixtures.ts";

/** The `data` role (company databases, slice 8a: deploy/first-node/RUNTIME-COMPANY-DATABASES.md §9a): a company
 * machine's `data` command calls the company's databases through the folder service, as the view the service serves
 * that machine. The service asks the core for a data pass as the view, sends the call with it to the data gateway's
 * run door, and records the files the answer can show as reads served under the view, before the answer leaves. */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEST_VIEW = "7e57f1e0-0001-4a00-8b00-000000000001";
const PASS = "testpass_0123456789-abcdefghijklmnopqrstuvw";
const OTHER_PASS = "testpass_9876543210-zyxwvutsrqponmlkjihgfed";
const AT_TEST: BridgeInfo = { cid: 95, lookup: "found", machine: TEST_MACHINE };
const HELLO: Hello = { protocol: 5, environmentId: ENV, viewId: TEST_VIEW, pass: PASS, role: "data" };
const never = new AbortController().signal;
const receiptOf = (path: string): CoreReceipt => ({
	resourceId: v(path.length),
	resourceRevision: 3,
	grantId: null,
	grantRevision: null,
});

/** A run door in memory: every call it got, answered by `answer` (200 and `{ok: true}` unless set). */
class FakeDoor implements DataDoor {
	readonly calls: { verb: DataVerb; body: Record<string, unknown>; signal: AbortSignal }[] = [];
	answer: (verb: DataVerb, body: Record<string, unknown>, signal: AbortSignal) => Promise<DoorAnswer> | DoorAnswer =
		() => json(200, { ok: true });

	async call(verb: DataVerb, body: Buffer, signal: AbortSignal): Promise<DoorAnswer> {
		const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
		this.calls.push({ verb, body: parsed, signal });
		return this.answer(verb, parsed, signal);
	}
}

function json(status: number, value: unknown): DoorAnswer {
	return { status, body: Buffer.from(JSON.stringify(value)) };
}

/** A call the door holds until `release`, or until its signal ends it. */
function held(): { answer: FakeDoor["answer"]; release: () => void; reached: Promise<void> } {
	let release!: () => void;
	let reach!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return {
		release,
		reached,
		answer: (_verb, _body, signal) => {
			reach();
			return new Promise<DoorAnswer>((resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("ended")), { once: true });
				void gate.then(() => resolve(json(200, { ok: true })));
			});
		},
	};
}

/** A company with two databases (shop: a step, a question, a change, and files a pass leaves out; stock: only its
 * database.toml), a test machine's view, and the node's service with the run door. `mounted`: the machine's folder
 * program holds the view, as on a machine that has `/company`. */
async function company(options: { now?: () => number; door?: boolean; mounted?: boolean; callMs?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-data-role-"));
	const core = new FakeCore();
	if (options.now) core.now = options.now;
	core.receipts = receiptOf;
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		folder("data"),
		folder("data/shop"),
		await storeFile(root, "data/shop/database.toml", 'format = "qorpera.database/v1"\n', 2),
		folder("data/shop/tables"),
		await storeFile(root, "data/shop/tables/001-orders.sql", "create table orders (id int);\n", 3),
		folder("data/shop/queries"),
		await storeFile(root, "data/shop/queries/count.sql", "select count(*) from orders;\n", 4),
		await storeFile(root, "data/shop/queries/open.sql", "select * from orders;\n", 5),
		folder("data/shop/queries/old"),
		await storeFile(root, "data/shop/queries/old/gone.sql", "select 1;\n", 6),
		folder("data/shop/actions"),
		await storeFile(root, "data/shop/actions/add.sql", "insert into orders values (:id);\n", 7),
		await storeFile(root, "data/shop/notes.md", "Notes", 8),
		folder("data/stock"),
		await storeFile(root, "data/stock/database.toml", 'format = "qorpera.database/v1"\n', 9),
		folder("data/empty"),
	]);
	core.openView(TEST_VIEW, PASS, { kind: "test_machine", machineId: PLACEMENT });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const door = new FakeDoor();
	const lines: string[] = [];
	const service = new FolderService({
		core,
		objects,
		grants: testGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: (line) => lines.push(line),
		...(options.now ? { now: options.now } : {}),
		...(options.door === false ? {} : { dataDoor: door }),
		...(options.callMs === undefined ? {} : { dataCallMs: options.callMs, dataApplyMs: options.callMs * 2 }),
	});
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const mount = async (): Promise<ViewHandle> => {
		const handle = await service.open({ ...HELLO, protocol: 4, role: "io" }, AT_TEST);
		handles.push(handle);
		return handle;
	};
	const view = options.mounted === false ? undefined : await mount();
	const ask = (handle: DataHandle, verb: DataVerb, body: Record<string, unknown> = {}, signal = never) =>
		handle.call({ verb, body }, signal);
	/** The reads the view has released to the core so far, by path, after a boundary of its machine. */
	const released = async (): Promise<Record<string, { version: string | null; authority: CoreReceipt }>> => {
		expect(await service.boundary(PLACEMENT)).toMatchObject({ reads: "released" });
		return Object.fromEntries(
			[...(core.readSets.get(TEST_VIEW) ?? new Map())].map(([path, read]) => [
				path,
				{ version: read.version, authority: read.authority },
			]),
		);
	};
	return { root, core, door, service, lines, mount, view, ask, released };
}

const SHOP_TOML = "data/shop/database.toml";
const readOf = (path: string, version: number) => ({ version: v(version), authority: receiptOf(path) });

describe("the data role's protocol", () => {
	it("takes a data hello at protocol 5 alone, and a call of one verb with a body", () => {
		const hello = (value: Record<string, unknown>) => parseHello(Buffer.from(JSON.stringify({ ...HELLO, ...value })));
		expect(hello({})).toEqual(HELLO);
		expect(() => hello({ protocol: 4 })).toThrow(/Bad data request/);
		expect(() => hello({ abandon: true })).toThrow(/Bad data request/);
		expect(() => hello({ previous: { viewId: v(1), pass: OTHER_PASS } })).toThrow(/Bad data request/);
		// The mount's roles are at 5 what they are at 4.
		expect(hello({ role: "io" })).toMatchObject({ protocol: 5, role: "io" });
		const call = (value: unknown) => parseDataCall(Buffer.from(JSON.stringify(value)));
		expect(call({ verb: "query", body: { database: "shop", question: "count" } })).toEqual({
			verb: "query",
			body: { database: "shop", question: "count" },
		});
		for (const bad of [
			{ verb: "watch", body: {} },
			{ verb: "query" },
			{ verb: "query", body: [] },
			{ verb: "query", body: null },
			{ verb: "query", body: {}, pass: "x" },
			{ body: {} },
		])
			expect(() => call(bad)).toThrow(/Bad verb|Bad body|Unknown field|Missing field/);
	});

	it("reads a machine's pass as the core gives it, and no other shape", () => {
		const pass = "A".repeat(43);
		const entry = { path: SHOP_TOML, version: v(2), authority: receiptOf(SHOP_TOML) };
		const answer = {
			schema: "qorpera.machine-data-pass/v1",
			pass,
			expiresAt: "2026-11-15T12:00:00Z",
			files: 2,
			entries: [entry, { path: "data/shop/tables/001-orders.sql", version: v(3), authority: null }],
		};
		expect(parseMachineDataPass(answer)).toEqual({
			pass,
			entries: [entry, { path: "data/shop/tables/001-orders.sql", version: v(3) }],
		});
		for (const bad of [
			{ ...answer, schema: "qorpera.data-pass/v1" },
			{ ...answer, pass: "short" },
			{ ...answer, entries: undefined },
			{ ...answer, entries: [{ ...entry, version: "7" }] },
			{ ...answer, entries: [{ ...entry, path: "docs/plan.md" }] },
			{ ...answer, entries: [{ ...entry, authority: { resourceId: v(1) } }] },
		])
			expect(() => parseMachineDataPass(bad)).toThrow(/Folder core answer is invalid/);
	});
});

describe("the data role", () => {
	it("takes a data hello only for the test machine's view it serves that machine now", async () => {
		const { core, service, mount } = await company({ mounted: false });
		const at = (machine: BridgeInfo["machine"], cid: number): BridgeInfo => ({ cid, lookup: "found", machine });
		const otherMachine = at({ ...TEST_MACHINE, name: `qorpera-machine-${"f".repeat(32)}` }, 97);
		// A view no machine has joined is none to act as: not one the service does not hold, and not one it listed for
		// a machine it then refused.
		expect(() => service.data(HELLO, AT_TEST)).toThrow(/did not match/);
		await expect(service.open({ ...HELLO, protocol: 4, role: "io" }, otherMachine)).rejects.toMatchObject({
			code: "VIEW_REFUSED",
		});
		expect(() => service.data(HELLO, AT_TEST)).toThrow(/did not match/);
		const view = await mount();
		expect(service.data(HELLO, AT_TEST)).toMatchObject({ call: expect.any(Function) });
		for (const bridge of [otherMachine, at(OFFICE, 90), at(CODING, 91), at(EXEC_HOST, 77)])
			expect(() => service.data(HELLO, bridge)).toThrow(/did not match/);
		expect(() => service.data({ ...HELLO, pass: OTHER_PASS }, AT_TEST)).toThrow(/did not match/);
		expect(() => service.data({ ...HELLO, pass: "no-pass" }, AT_TEST)).toThrow(/did not match/);
		expect(() => service.data({ ...HELLO, environmentId: v(9) }, AT_TEST)).toThrow(/did not match/);
		expect(() => service.data({ ...HELLO, viewId: v(8) }, AT_TEST)).toThrow(/did not match/);
		// LXD could not say which machine called: asked again, never taken for the view's end.
		expect(() => service.data(HELLO, { cid: 95, lookup: "unavailable" })).toThrow(/could not tell which machine/);
		// A view the core closed is none; a hello checked before is refused at its next call.
		const data = service.data(HELLO, AT_TEST);
		core.views.get(TEST_VIEW)!.state = "closed";
		await service.renewLeases();
		expect(() => service.data(HELLO, AT_TEST)).toThrow(/did not match/);
		await expect(data.call({ verb: "describe", body: {} }, never)).rejects.toMatchObject({ code: "VIEW_REFUSED" });
		view.release();
	});

	it("is no road for another kind of view, and says so on a node without the run door", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-data-role-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const core = new FakeCore();
		core.seed([folder("data")]);
		const codingView = "c0de0000-0001-4a00-8b00-000000000001";
		core.openView(codingView, PASS, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
		const service = new FolderService({
			core,
			objects: new NasObjects({ root, cacheBytes: 1024 * 1024 }),
			grants: codingGrants(),
			log: () => undefined,
			dataDoor: new FakeDoor(),
		});
		cleanups.push(() => service.stop());
		const bridge: BridgeInfo = { cid: 91, lookup: "found", machine: CODING };
		const hello: Hello = { ...HELLO, viewId: codingView };
		const handle = await service.open({ ...hello, protocol: 4, role: "io" }, bridge);
		cleanups.push(() => handle.release());
		expect(() => service.data(hello, bridge)).toThrow(/did not match/);

		const without = await company({ door: false });
		expect(() => without.service.data(HELLO, AT_TEST)).toThrow(/does not reach the company's databases/);
		// The view's own refusal comes first: a caller that is not the view's machine learns nothing of the node.
		expect(() => without.service.data({ ...HELLO, pass: OTHER_PASS }, AT_TEST)).toThrow(/did not match/);
	});

	it("asks a pass as the view, sends the call with it, and gives the gateway's answer", async () => {
		const { core, door, service, ask } = await company();
		const data = service.data(HELLO, AT_TEST);
		door.answer = () => json(200, { columns: ["count"], rows: [[2]], more: false });
		expect(await ask(data, "query", { database: "shop", question: "count", params: { since: "2026" } })).toEqual({
			status: 200,
			value: { columns: ["count"], rows: [[2]], more: false },
		});
		expect(core.dataPasses).toEqual([
			{ viewId: TEST_VIEW, database: "shop", pass: expect.stringMatching(/^.{43}$/) },
		]);
		expect(door.calls).toHaveLength(1);
		expect(door.calls[0]).toMatchObject({
			verb: "query",
			body: { database: "shop", question: "count", params: { since: "2026" }, pass: core.dataPasses[0]!.pass },
		});
		// A describe of every database: a pass that names none. The machine's own `pass` never reaches the door, and
		// its texts do, as they are.
		expect(await ask(data, "describe", { pass: "the-machine's-own", texts: { abc: "select 1" } })).toMatchObject({
			status: 200,
		});
		expect(core.dataPasses[1]).toMatchObject({ database: null });
		expect(door.calls[1]!.body).toEqual({ pass: core.dataPasses[1]!.pass, texts: { abc: "select 1" } });
		// The gateway's refusal is the answer too, with its words.
		door.answer = () => json(404, { error: "No question shop/nope that you may read" });
		expect(await ask(data, "query", { database: "shop", question: "nope" })).toEqual({
			status: 404,
			value: { error: "No question shop/nope that you may read" },
		});
	});

	it("records the files an answer can show as the view's reads, released at the machine's next boundary", async () => {
		const { core, service, ask, released } = await company();
		const data = service.data(HELLO, AT_TEST);
		// A question by name: its database's database.toml and the question's file, as the core read them for the pass.
		await ask(data, "query", { database: "shop", question: "count" });
		// In memory until a boundary: nothing is released by the call itself.
		expect(core.releases).toEqual([]);
		expect(await released()).toEqual({
			[SHOP_TOML]: readOf(SHOP_TOML, 2),
			"data/shop/queries/count.sql": readOf("data/shop/queries/count.sql", 4),
		});
		// The same call again records nothing new.
		const before = core.releases.length;
		await ask(data, "query", { database: "shop", question: "count" });
		await released();
		expect(core.releases).toHaveLength(before);

		// A read of the machine's own: the database alone. A change: its file. An apply: every step's file.
		await ask(data, "query", { database: "stock", sql: "select 1" });
		expect(Object.keys(await released()).sort()).toEqual([
			SHOP_TOML,
			"data/shop/queries/count.sql",
			"data/stock/database.toml",
		]);
		await ask(data, "change", { database: "shop", change: "add", params: { id: 1 } });
		expect(await released()).toMatchObject({ "data/shop/actions/add.sql": readOf("data/shop/actions/add.sql", 7) });
		await ask(data, "apply", { database: "shop" });
		expect(await released()).toMatchObject({
			"data/shop/tables/001-orders.sql": readOf("data/shop/tables/001-orders.sql", 3),
		});
		// A describe: each database's database.toml and its questions' and changes' files, whose words it lists; never
		// a file a pass leaves out.
		await ask(data, "describe");
		expect(Object.keys(await released()).sort()).toEqual([
			"data/shop/actions/add.sql",
			SHOP_TOML,
			"data/shop/queries/count.sql",
			"data/shop/queries/open.sql",
			"data/shop/tables/001-orders.sql",
			"data/stock/database.toml",
		]);
	});

	it("records a refusal's reads too, and none for a call the gateway never answered", async () => {
		const { door, service, ask, released } = await company();
		const data = service.data(HELLO, AT_TEST);
		// PostgreSQL's words can show a row: a refused change has read what an answered one has.
		door.answer = () => json(400, { error: 'duplicate key value violates unique constraint "orders_pkey"' });
		expect(await ask(data, "change", { database: "shop", change: "add" })).toMatchObject({ status: 400 });
		expect(Object.keys(await released()).sort()).toEqual(["data/shop/actions/add.sql", SHOP_TOML]);
		door.answer = () => {
			throw new Error("connect ECONNREFUSED");
		};
		expect(await ask(data, "query", { database: "stock", sql: "select 1" })).toMatchObject({ status: 503 });
		expect(Object.keys(await released()).sort()).toEqual(["data/shop/actions/add.sql", SHOP_TOML]);
	});

	it("refuses a call it cannot make, in the gateway's form, before any pass or with the core's reason", async () => {
		const { core, door, service, ask } = await company();
		const data = service.data(HELLO, AT_TEST);
		for (const body of [{}, { database: "Shop" }, { database: 7 }, { database: "qorpera" }, { database: "pg_x" }])
			expect(await ask(data, "query", body)).toEqual({ status: 400, value: { error: "Name a database" } });
		expect(await ask(data, "describe", { database: "qorpera_data" })).toMatchObject({ status: 400 });
		expect(core.dataPasses).toEqual([]);
		// No such database, and a folder without a database.toml: the same words.
		for (const database of ["nothing", "empty"])
			expect(await ask(data, "apply", { database })).toEqual({
				status: 404,
				value: {
					error: `No database ${database} that this machine may read: it needs data/${database}/database.toml (format = "qorpera.database/v1")`,
				},
			});
		const refused = async (failure: Error, verb: DataVerb = "query") => {
			core.dataPassFailure = failure;
			const answer = await ask(data, verb, verb === "describe" ? {} : { database: "shop", sql: "select 1" });
			core.dataPassFailure = undefined;
			return answer;
		};
		expect(await refused(new CoreRefusal("stopped", "Company execution is paused"))).toMatchObject({ status: 423 });
		expect(await refused(new CoreRefusal("denied", "Folder view has ended"))).toMatchObject({ status: 403 });
		expect(
			await refused(new CoreRefusal("invalid", "Data pass would keep more than 1,000 files"), "describe"),
		).toEqual({
			status: 413,
			value: { error: "The company's databases hold more than 1,000 files together: name one database" },
		});
		expect(await refused(new CoreRefusal("invalid", "Data pass would keep more than 1,000 files"))).toEqual({
			status: 413,
			value: { error: "data/shop/ holds more than 1,000 files in database.toml, tables/, queries/ and actions/" },
		});
		expect(
			await refused(
				new CoreRefusal("invalid", "Data pass would look through more than 5,000 folders under data/"),
				"describe",
			),
		).toMatchObject({ status: 413, value: { error: expect.stringMatching(/5,000 folders/) } });
		expect(await refused(new CoreRefusal("invalid", "Something else"))).toMatchObject({ status: 400 });
		expect(await refused(new Error("The database did not answer"))).toEqual({
			status: 503,
			value: { error: "The company's databases cannot be reached now: try again" },
		});
		// None of them reached the door.
		expect(door.calls).toEqual([]);
	});

	it("never says a call that may have written failed: its outcome is unknown", async () => {
		const { door, service, ask } = await company();
		const data = service.data(HELLO, AT_TEST);
		const down = () => {
			throw new Error("socket hang up");
		};
		door.answer = down;
		expect(await ask(data, "change", { database: "shop", change: "add" })).toEqual({
			status: 504,
			value: { error: expect.stringMatching(/may or may not have run/) },
		});
		expect(await ask(data, "apply", { database: "shop" })).toEqual({
			status: 504,
			value: { error: expect.stringMatching(/may still be applying/) },
		});
		// A call that only looks wrote nothing.
		for (const [verb, body] of [
			["change", { database: "shop", change: "add", preview: true }],
			["apply", { database: "shop", check: `001-orders.${"a".repeat(64)}.${"b".repeat(64)}` }],
			["query", { database: "shop", question: "count" }],
			["describe", {}],
		] as const)
			expect(await ask(data, verb, body)).toMatchObject({ status: 503 });
		// The gateway's own 5xx is unknown for a write too, but for a full store (507), which wrote nothing.
		door.answer = () => json(503, { error: "The data store is not answering" });
		expect(await ask(data, "change", { database: "shop", change: "add" })).toMatchObject({ status: 504 });
		expect(await ask(data, "query", { database: "shop", question: "count" })).toEqual({
			status: 503,
			value: { error: "The data store is not answering" },
		});
		door.answer = () => json(507, { error: "The company's data is at its limit" });
		expect(await ask(data, "apply", { database: "shop" })).toEqual({
			status: 507,
			value: { error: "The company's data is at its limit" },
		});
		// The door took neither the node's token nor the pass: nothing of the gateway's 401 goes to the machine.
		door.answer = () => json(401, { error: "Not allowed" });
		expect(await ask(data, "query", { database: "shop", question: "count" })).toEqual({
			status: 503,
			value: { error: "The company's databases cannot be reached now: try again" },
		});
		// Nor an answer that is none: a status no HTTP answer has, or words that are not JSON.
		door.answer = () => json(0, { rows: [[1]] });
		expect(await ask(data, "query", { database: "shop", question: "count" })).toEqual({
			status: 503,
			value: { error: "The company's databases cannot be reached now: try again" },
		});
		door.answer = () => ({ status: 200, body: Buffer.from("<html>") });
		expect(await ask(data, "change", { database: "shop", change: "add" })).toMatchObject({ status: 504 });
		expect(await ask(data, "query", { database: "shop", question: "count" })).toMatchObject({ status: 503 });
	});

	it("gives a machine 4 calls at once and 120 a minute, and refuses the next at once", async () => {
		let now = 1_000_000;
		const { door, service, ask } = await company({ now: () => now });
		const data = service.data(HELLO, AT_TEST);
		const other = service.data(HELLO, AT_TEST);
		const slow = held();
		door.answer = slow.answer;
		const running = [0, 1, 2, 3].map((i) =>
			ask(i % 2 ? other : data, "query", { database: "shop", sql: "select 1" }),
		);
		await slow.reached;
		// The fifth, on either connection: refused at once, with nothing asked.
		expect(await ask(other, "describe")).toEqual({
			status: 429,
			value: { error: expect.stringMatching(/4 calls to the company's databases running/) },
		});
		expect(door.calls).toHaveLength(4);
		slow.release();
		for (const answer of await Promise.all(running)) expect(answer).toMatchObject({ status: 200 });
		door.answer = () => json(200, { ok: true });
		// 120 in a minute, the four among them; the one refused was no call made.
		for (let i = 0; i < 116; i++) expect(await ask(data, "describe")).toMatchObject({ status: 200 });
		expect(await ask(data, "describe")).toEqual({
			status: 429,
			value: { error: expect.stringMatching(/120 calls to the company's databases in the last minute/) },
		});
		// Until the minute has passed.
		now += 59_000;
		expect(await ask(data, "describe")).toMatchObject({ status: 429 });
		now += 2_000;
		expect(await ask(data, "describe")).toMatchObject({ status: 200 });
	});

	it("sends and gives no more than 1 MiB", async () => {
		const { door, service, ask } = await company();
		const data = service.data(HELLO, AT_TEST);
		expect(await ask(data, "query", { database: "shop", sql: "x".repeat(1024 * 1024) })).toEqual({
			status: 413,
			value: { error: "The call is larger than 1 MiB" },
		});
		expect(door.calls).toEqual([]);
		door.answer = () => "too_large";
		expect(await ask(data, "describe")).toEqual({
			status: 413,
			value: { error: "The answer is larger than 1 MiB: name one database" },
		});
		// An answer that fits a frame only without the service's own words around it.
		door.answer = () => json(200, { words: "x".repeat(1024 * 1024 - 14) });
		expect(await ask(data, "describe")).toMatchObject({ status: 413 });
		door.answer = () => json(200, { words: "x".repeat(1024 * 1024 - 64) });
		expect(await ask(data, "describe")).toMatchObject({ status: 200 });
	});

	it("ends a call at its time, and with its connection", async () => {
		const { door, service, ask } = await company({ callMs: 300 });
		const data = service.data(HELLO, AT_TEST);
		const slow = held();
		door.answer = slow.answer;
		// An apply has twice as long here (120 s against 30 s on a node): it still waits when the read has ended.
		const gone = new AbortController();
		const applying = ask(data, "apply", { database: "shop" }, gone.signal);
		expect(await ask(data, "query", { database: "shop", sql: "select 1" })).toMatchObject({ status: 503 });
		const [apply, read] = door.calls;
		expect(read!.signal.aborted).toBe(true);
		expect(apply!.signal.aborted).toBe(false);
		gone.abort();
		expect(await applying).toMatchObject({ status: 504 });
		expect(apply!.signal.aborted).toBe(true);
	});

	it("serves nothing past the view's lease, and gives no answer of a view that closed meanwhile", async () => {
		let now = 2_000_000;
		const { core, door, service, ask, released } = await company({ now: () => now });
		const data = service.data(HELLO, AT_TEST);
		now += 121_000;
		await expect(ask(data, "describe")).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await service.renewLeases();
		expect(await ask(data, "describe")).toMatchObject({ status: 200 });
		await released();
		const before = core.releases.length;
		// The core closes the view while the call is at the door: the answer shows rows no read was recorded for, so
		// it is not given.
		const slow = held();
		door.answer = slow.answer;
		const asked = ask(data, "query", { database: "stock", sql: "select 1" });
		await slow.reached;
		core.views.get(TEST_VIEW)!.state = "closed";
		await service.renewLeases();
		slow.release();
		await expect(asked).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		expect(core.releases).toHaveLength(before);
	});

	it("gives no answer once a clean stop has begun, and takes no hello", async () => {
		const { core, door, service, ask } = await company();
		const data = service.data(HELLO, AT_TEST);
		const slow = held();
		door.answer = slow.answer;
		const reading = ask(data, "query", { database: "shop", question: "count" });
		const writing = ask(data, "change", { database: "shop", change: "add" });
		await slow.reached;
		const stopped = service.stopCleanly();
		slow.release();
		expect(await reading).toMatchObject({ status: 503 });
		expect(await writing).toMatchObject({ status: 504, value: { error: expect.stringMatching(/may or may not/) } });
		await stopped;
		// No read was recorded after the stop began: none is left unreleased, and none was released.
		expect(core.releases).toEqual([]);
		expect(() => service.data(HELLO, AT_TEST)).toThrow(/stopping/);
		await expect(ask(data, "describe")).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});
});

/** A machine's side of one connection, as the bridge hands it to the service. */
class Client {
	readonly #socket: Socket;
	readonly #reader = new FrameReader();
	readonly #frames: Frame[] = [];
	readonly #waiters: ((frame: Frame | undefined) => void)[] = [];
	closed = false;

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (data: Buffer) => {
			for (const frame of this.#reader.push(data)) {
				const waiter = this.#waiters.shift();
				if (waiter) waiter(frame);
				else this.#frames.push(frame);
			}
		});
		socket.on("close", () => {
			this.closed = true;
			for (const waiter of this.#waiters.splice(0)) waiter(undefined);
		});
	}

	static async open(path: string): Promise<Client> {
		const socket = connect(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		cleanups.push(() => {
			socket.destroy();
		});
		return new Client(socket);
	}

	send(kind: number, value: unknown): void {
		this.#socket.write(encodeJson(kind, value));
	}

	close(): void {
		this.#socket.destroy();
	}

	/** The next frame's kind and JSON; undefined once the service ended the connection. */
	async next(timeoutMs = 3_000): Promise<{ kind: number; body: Record<string, unknown> } | undefined> {
		const frame =
			this.#frames.shift() ??
			(this.closed
				? undefined
				: await new Promise<Frame | undefined>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
						this.#waiters.push((f) => {
							clearTimeout(timer);
							resolve(f);
						});
					}));
		return frame && { kind: frame.kind, body: JSON.parse(frame.payload.toString("utf8")) };
	}
}

describe("the data role on the folder socket", () => {
	async function listening() {
		const made = await company();
		const server: Server = createFolderServer(made.service, (line) => made.lines.push(line));
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-data-socket-"));
		const path = join(dir, "service.sock");
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		});
		const dial = async (hello: Record<string, unknown> = {}, bridge: BridgeInfo = AT_TEST) => {
			const client = await Client.open(path);
			client.send(Kind.bridge, bridge);
			client.send(Kind.hello, { ...HELLO, ...hello });
			return { client, answer: await client.next() };
		};
		return { ...made, dial };
	}

	it("answers a data hello and each call in one frame, a call of up to 1 MiB", async () => {
		const { core, door, dial } = await listening();
		const { client, answer } = await dial();
		expect(answer).toEqual({ kind: Kind.helloOk, body: { protocol: 5, viewId: TEST_VIEW } });
		door.answer = () => json(200, { columns: ["n"], rows: [[1]], more: false });
		client.send(Kind.dataCall, { verb: "query", body: { database: "shop", question: "count" } });
		expect(await client.next()).toEqual({
			kind: Kind.dataAnswer,
			body: { status: 200, value: { columns: ["n"], rows: [[1]], more: false } },
		});
		// A call that carries a file's text: far past another role's 64 KiB.
		const text = "-- words\n".repeat(60_000);
		client.send(Kind.dataCall, { verb: "describe", body: { texts: { abc: text } } });
		expect(await client.next()).toMatchObject({ kind: Kind.dataAnswer, body: { status: 200 } });
		expect(door.calls[1]!.body).toEqual({ pass: core.dataPasses[1]!.pass, texts: { abc: text } });
		// The service's own refusal is an answer too, and the connection goes on.
		client.send(Kind.dataCall, { verb: "query", body: {} });
		expect(await client.next()).toEqual({
			kind: Kind.dataAnswer,
			body: { status: 400, value: { error: "Name a database" } },
		});
		client.send(Kind.dataCall, { verb: "describe", body: {} });
		expect(await client.next()).toMatchObject({ kind: Kind.dataAnswer, body: { status: 200 } });
	});

	it("refuses a hello like any other, and ends the connection at any other frame or a bad call", async () => {
		const { dial, lines } = await listening();
		for (const [hello, bridge] of [
			[{ pass: OTHER_PASS }, AT_TEST],
			[{}, { cid: 77, lookup: "found", machine: EXEC_HOST }],
			[{ viewId: v(8) }, AT_TEST],
		] as const) {
			const refused = await dial(hello, bridge);
			expect(refused.answer).toEqual({
				kind: Kind.error,
				body: { code: "VIEW_REFUSED", message: "The view, its pass or this machine did not match" },
			});
			expect(await refused.client.next()).toBeUndefined();
		}
		expect((await dial({ protocol: 4 })).answer).toMatchObject({ kind: Kind.error, body: { code: "BAD_REQUEST" } });
		for (const [kind, frame] of [
			[Kind.list, { path: "" }],
			[Kind.notices, { after: 0, nonce: null }],
			[Kind.hello, HELLO],
			[Kind.dataCall, { verb: "watch", body: {} }],
		] as const) {
			const { client, answer } = await dial();
			expect(answer).toMatchObject({ kind: Kind.helloOk });
			client.send(kind, frame);
			expect(await client.next()).toMatchObject({ kind: Kind.error, body: { code: "BAD_REQUEST" } });
			expect(await client.next()).toBeUndefined();
		}
		// A refusal says nothing of the pass in the service's log.
		expect(lines.join("\n")).not.toContain(PASS);
	});

	it("ends the call a connection waits for when the command goes", async () => {
		const { door, dial } = await listening();
		const { client } = await dial();
		const slow = held();
		door.answer = slow.answer;
		client.send(Kind.dataCall, { verb: "change", body: { database: "shop", change: "add" } });
		await slow.reached;
		expect(door.calls[0]!.signal.aborted).toBe(false);
		client.close();
		for (const end = Date.now() + 3_000; !door.calls[0]!.signal.aborted && Date.now() < end; )
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(door.calls[0]!.signal.aborted).toBe(true);
	});
});

describe("the run door over HTTPS, as the folder service calls it", () => {
	let directory: string;
	let cert: string;
	let other: string;
	let server: HttpsServer;
	const seen: { path?: string; authorization?: string; body: string }[] = [];
	const token = "t".repeat(43);
	const make = (name: string): void => {
		const made = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				join(directory, `${name}-key.pem`),
				"-out",
				join(directory, `${name}.pem`),
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ encoding: "utf8", timeout: 15_000 },
		);
		if (made.status !== 0) throw new Error("Could not create a disposable test TLS certificate");
	};
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "qorpera-folder-data-door-"));
		make("door");
		make("other");
		cert = await readFile(join(directory, "door.pem"), "utf8");
		other = await readFile(join(directory, "other.pem"), "utf8");
		const key = await readFile(join(directory, "door-key.pem"), "utf8");
		server = createHttpsServer({ cert, key }, (request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (part: string) => {
				body += part;
			});
			request.on("end", () => {
				seen.push({ path: request.url, authorization: request.headers.authorization, body });
				if (body.includes("slow")) return;
				if (body.includes("cut")) {
					response.socket?.destroy();
					return;
				}
				response.writeHead(body.includes("refuse") ? 404 : 200, { "content-type": "application/json" });
				response.end(body.includes("huge") ? JSON.stringify({ rows: "x".repeat(1024 * 1024) }) : '{"columns":[]}');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	});
	afterAll(async () => {
		server?.close();
		server?.closeAllConnections();
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	const url = (): string => `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

	it("calls the door with the node's token, the store's CA alone trusted, and gives the status and the bytes", async () => {
		const door = httpsDataDoor({ url: url(), ca: cert, token });
		const answer = await door.call("query", body({ database: "shop", pass: "p" }), never);
		expect(answer).toMatchObject({ status: 200 });
		expect((answer as { body: Buffer }).body.toString()).toBe('{"columns":[]}');
		expect(seen.at(-1)).toEqual({
			path: "/v1/run-data/query",
			authorization: `Bearer ${token}`,
			body: JSON.stringify({ database: "shop", pass: "p" }),
		});
		expect(await door.call("describe", body({ refuse: true }), never)).toMatchObject({ status: 404 });
		// More than a frame carries: said so, never buffered whole.
		expect(await door.call("describe", body({ huge: true }), never)).toBe("too_large");
		await expect(door.call("change", body({ cut: true }), never)).rejects.toThrow();
	});

	it("ends a call with its signal, and talks to no door the pinned CA did not sign", async () => {
		const door = httpsDataDoor({ url: url(), ca: cert, token });
		await expect(door.call("apply", body({ slow: true }), AbortSignal.timeout(100))).rejects.toThrow(/ended/);
		const ended = new AbortController();
		ended.abort();
		await expect(door.call("apply", body({}), ended.signal)).rejects.toThrow(/ended/);
		const before = seen.length;
		await expect(httpsDataDoor({ url: url(), ca: other, token }).call("query", body({}), never)).rejects.toThrow();
		expect(seen.length).toBe(before);
	});

	it("takes only an HTTPS origin, a CA and a token of 32 bytes", () => {
		for (const options of [
			{ url: "http://127.0.0.1:8481", ca: cert, token },
			{ url: "https://127.0.0.1:8481/v1", ca: cert, token },
			{ url: "https://user:pw@127.0.0.1:8481", ca: cert, token },
			{ url: "https://127.0.0.1:8481", ca: "not a certificate", token },
			{ url: "https://127.0.0.1:8481", ca: cert, token: "short" },
		])
			expect(() => httpsDataDoor(options)).toThrow(/URL, token or CA is not one/);
	});
});
