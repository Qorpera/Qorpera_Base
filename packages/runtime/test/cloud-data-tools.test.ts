import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudCompanyFolderBytes, CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import {
	type CloudCompanyDataDoor,
	type CloudCompanyDataVerb,
	cloudDataTools,
	DATA_APPLY_DESCRIPTION,
	DATA_CHANGE_DESCRIPTION,
	DATA_DESCRIBE_DESCRIPTION,
	DATA_QUERY_DESCRIPTION,
	httpsCompanyDataDoor,
} from "@qorpera/runtime/cloud-data-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary, type CloudToolResult } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_RUNTIME_TOOL_OPERATIONS,
	CloudRuntimeDiagnosticError,
	CloudRuntimeObservability,
} from "@qorpera/runtime/cloud-runtime-observability";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/* Company databases, slice 5 (cloud-data-tools.ts, migration 20260930750000): data_describe, data_apply and data_query;
 * and slice 7 (migration 20260930763000): data_change. Each call asks the platform for a data pass through the run's real folder client and sends it to the data gateway's
 * run door. The platform's answers have the shapes the SQL gives (test 1244 pins them against the real functions), and
 * the door is a stand-in that answers as the gateway does (deploy/company-data/gateway/gateway.test.mjs drives the real
 * one); the HTTPS door is driven against a real TLS server. */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const PASS = "qorpera_run_data_pass";
const READ = "qorpera_folder_read";
const pass = () => ({
	schema: "qorpera.data-pass/v1",
	pass: randomBytes(32).toString("base64url"),
	expiresAt: "2026-11-13T12:00:00+00:00",
	files: 4,
});
const FILES = new Map([
	["data/shop/queries/count.sql", "-- How many orders.\nselect count(*) as orders from orders;\n"],
	["data/shop/tables/001-orders.sql", "create table orders (id int primary key);\n"],
]);
const entry = (path: string, text: string) => ({
	path,
	kind: "file",
	version: "73000000-0000-4000-8000-000000000001",
	seq: 3,
	updatedAt: "2026-11-13T10:00:00+00:00",
	authority: {
		resourceId: "73000000-0000-4000-8000-000000000002",
		resourceRevision: 1,
		grantId: null,
		grantRevision: null,
	},
	manifestSha256: sha(`manifest:${text}`),
	fileSha256: sha(text),
	bytes: Buffer.byteLength(text),
	mediaType: "text/plain",
	executable: false,
});

type DoorCall = { verb: CloudCompanyDataVerb; body: Record<string, unknown> };

/** A run with the data tools. `platform` answers the folder client's calls (the pass, a file's entry); `door` answers
 * the run door's. */
async function fixture(
	door: (call: DoorCall, count: number) => { status: number; value: unknown },
	options: {
		platform?: (method: CloudCompanyPathRpc, args: Record<string, unknown>) => unknown;
		apply?: boolean;
		files?: Map<string, string>;
	} = {},
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const files = options.files ?? FILES;
	const platformCalls: { method: CloudCompanyPathRpc; args: Record<string, unknown> }[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			platformCalls.push({ method, args: structuredClone(args) });
			if (options.platform) return options.platform(method, args);
			if (method === PASS) return pass();
			if (method === READ) {
				const path = args.p_path as string;
				const text = files.get(path);
				return {
					schema: "qorpera.folder-read/v1",
					asOfSeq: 3,
					found: text !== undefined,
					entry: text === undefined ? null : entry(path, text),
				};
			}
			throw new Error(`Unexpected ${method}`);
		}),
	};
	const bytes: CloudCompanyFolderBytes = {
		put: vi.fn(),
		get: vi.fn(async (file) => {
			const text = [...files.values()].find((one) => sha(one) === file.fileSha256);
			return new TextEncoder().encode(text ?? "");
		}),
		range: vi.fn(),
	};
	const folder = new CloudCompanyFolderClient({ binding, identity: run.identity, control, bytes });
	const doorCalls: DoorCall[] = [];
	const stand: CloudCompanyDataDoor = {
		call: vi.fn(async (verb, body) => {
			doorCalls.push({ verb, body: structuredClone(body) });
			return door({ verb, body }, doorCalls.length);
		}),
	};
	const tools = cloudDataTools({ folder, door: stand, apply: options.apply ?? true });
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools,
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
		observability: new CloudRuntimeObservability({ assignmentId: binding.assignmentId, publish: async () => {} }),
	});
	let callId = 0;
	const invoke = async (name: string, args: Record<string, unknown>) => {
		const response = await boundary.invoke(`data_${++callId}`, "qorpera", name, args);
		const envelope = JSON.parse(response.contentItems[0].text) as CloudToolResult;
		return { success: response.success, status: envelope.status, text: envelope.content.text };
	};
	return { binding, run, tools, invoke, platformCalls, doorCalls };
}

const ok = (value: unknown) => ({ status: 200, value });

describe("the company data tools", () => {
	it("are four runtime tools, described briefly, and a worker's run is offered neither data_apply nor data_change", async () => {
		const f = await fixture(() => ok({}));
		expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([
			["data_describe", "runtime"],
			["data_apply", "runtime"],
			["data_query", "runtime"],
			["data_change", "runtime"],
		]);
		for (const tool of f.tools) {
			expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain(tool.name);
			expect(Buffer.byteLength(tool.description)).toBeLessThan(600);
		}
		expect(f.tools.map((tool) => tool.description)).toEqual([
			DATA_DESCRIBE_DESCRIPTION,
			DATA_APPLY_DESCRIPTION,
			DATA_QUERY_DESCRIPTION,
			DATA_CHANGE_DESCRIPTION,
		]);
		expect(DATA_APPLY_DESCRIPTION).toContain("it waits for a member to say yes");
		expect(DATA_CHANGE_DESCRIPTION).toContain("data/<database>/actions/<change>.sql");
		expect(DATA_CHANGE_DESCRIPTION).toContain("A change that fails changes nothing.");
		const worker = await fixture(() => ok({}), { apply: false });
		expect(worker.tools.map((tool) => tool.name)).toEqual(["data_describe", "data_query"]);
	});

	it("asks with a new pass the run's folder client gets as the run, and shows the answer", async () => {
		const f = await fixture(() =>
			ok({ columns: ["orders"], rows: [[12]], more: false, asOf: "2026-11-13T10:00:00Z" }),
		);
		const answer = await f.invoke("data_query", { database: "shop", question: "count" });
		expect(answer).toMatchObject({ success: true, status: "ok" });
		expect(JSON.parse(answer.text)).toEqual({
			columns: ["orders"],
			rows: [[12]],
			more: false,
			asOf: "2026-11-13T10:00:00Z",
		});
		expect(f.platformCalls).toEqual([
			{
				method: PASS,
				args: {
					p_environment_id: f.run.identity.environmentId,
					p_actor: {
						kind: "run",
						runId: f.binding.runId,
						jobId: f.binding.jobId,
						runnerId: f.binding.runnerId,
						assignmentId: f.binding.assignmentId,
					},
					p_database: "shop",
				},
			},
		]);
		expect(f.doorCalls).toHaveLength(1);
		expect(f.doorCalls[0]?.verb).toBe("query");
		expect(Object.keys(f.doorCalls[0]?.body ?? {}).sort()).toEqual(["database", "pass", "question"]);
		expect(f.doorCalls[0]?.body.pass).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// A read of its own, with params; data_describe without a name asks for a pass for every database.
		await f.invoke("data_query", { database: "shop", sql: "select :n::int as n", params: { n: 2 } });
		expect(f.doorCalls[1]?.body).toMatchObject({ database: "shop", sql: "select :n::int as n", params: { n: 2 } });
		const described = await fixture(() => ok({ databases: [], companyBytes: 0, limitBytes: 1024 }));
		await described.invoke("data_describe", {});
		expect(described.platformCalls[0]?.args.p_database).toBeNull();
		expect(described.doorCalls[0]?.body).not.toHaveProperty("database");
	});

	it("reads the files the gateway asks for as the run, and asks again with a new pass and their texts", async () => {
		const step = FILES.get("data/shop/tables/001-orders.sql") ?? "";
		const f = await fixture((_call, count) =>
			count === 1
				? ok({ need: [{ path: "data/shop/tables/001-orders.sql", sha256: sha(step) }] })
				: ok({ applied: true, results: [{ name: "001-orders", state: "applied" }] }),
		);
		const answer = await f.invoke("data_apply", { database: "shop" });
		expect(answer.status).toBe("ok");
		expect(JSON.parse(answer.text)).toEqual({
			database: "shop",
			applied: true,
			steps: [{ name: "001-orders", state: "applied" }],
		});
		expect(f.platformCalls.map((call) => call.method)).toEqual([PASS, READ, PASS]);
		expect(f.doorCalls[1]?.body.texts).toEqual({ [sha(step)]: step });
		expect(f.doorCalls[1]?.body.pass).not.toBe(f.doorCalls[0]?.body.pass);
	});

	it("sends no text whose hash is not the one asked for, and gives up when the files keep changing", async () => {
		const f = await fixture(() =>
			ok({ need: [{ path: "data/shop/tables/001-orders.sql", sha256: "0".repeat(64) }] }),
		);
		const answer = await f.invoke("data_apply", { database: "shop" });
		expect(answer).toMatchObject({
			status: "denied",
			text: "REFUSED: The database's files kept changing while they were read: try again",
		});
		expect(f.doorCalls).toHaveLength(8);
		for (const call of f.doorCalls.slice(1)) expect(call.body.texts).toEqual({});
	});

	it("says when there is no database the run may read, or too many files for one pass", async () => {
		const none = await fixture(() => ok({}), {
			platform: () => {
				throw new CloudCompanyFolderRpcError("P0002", "Data pass has no such database");
			},
		});
		expect(await none.invoke("data_describe", { database: "payroll" })).toMatchObject({
			status: "denied",
			text: 'REFUSED: No database payroll that you may read: it needs data/payroll/database.toml (format = "qorpera.database/v1")',
		});
		const many = await fixture(() => ok({}), {
			platform: () => {
				throw new CloudCompanyFolderRpcError("54000", "Data pass would keep more than 1,000 files");
			},
		});
		expect(await many.invoke("data_describe", {})).toMatchObject({
			status: "denied",
			text: "REFUSED: The company's databases hold more than 1,000 files together: name one database",
		});
		expect(none.doorCalls).toEqual([]);
		// Looking through data/ has its own bound, with its own words.
		const folders = await fixture(() => ok({}), {
			platform: () => {
				throw new CloudCompanyFolderRpcError(
					"54000",
					"Data pass would look through more than 5,000 folders under data/",
				);
			},
		});
		expect(await folders.invoke("data_describe", {})).toMatchObject({
			status: "denied",
			text: "REFUSED: data/ holds more than 5,000 folders to look through: name one database",
		});
	});

	it("tells PostgreSQL's words and place as a refusal, and a door that refused the run as no answer", async () => {
		const f = await fixture(() => ({
			status: 400,
			value: { error: 'syntax error at or near "form"', code: "42601", position: 10 },
		}));
		expect(await f.invoke("data_query", { database: "shop", sql: "select 1 form x" })).toMatchObject({
			status: "denied",
			text: 'REFUSED: syntax error at or near "form" (at character 10)',
		});
		const closed = await fixture(() => ({ status: 401, value: { error: "Not allowed" } }));
		const answer = await closed.invoke("data_query", { database: "shop", question: "count" });
		expect(answer.status).not.toBe("ok");
		expect(answer.text).not.toMatch(/^REFUSED/);
	});

	it("says a held step waits for a member's yes, and counts the steps already applied", async () => {
		const f = await fixture(() =>
			ok({
				applied: false,
				results: [
					{ name: "001-orders", state: "already" },
					{ name: "002-notes", state: "applied" },
					{
						name: "003-clear",
						state: "held",
						detail: "It would destroy data, which waits for a member",
						destroys: [{ what: "deleted rows", object: "shop.orders", rows: 40 }],
					},
				],
			}),
		);
		const answer = JSON.parse((await f.invoke("data_apply", { database: "shop" })).text);
		expect(answer).toEqual({
			database: "shop",
			applied: false,
			alreadyApplied: 1,
			steps: [
				{ name: "002-notes", state: "applied" },
				{
					name: "003-clear",
					state: "held",
					detail:
						"It would destroy data, so it waits for a member to say yes; nothing changed. Tell the member what it would destroy.",
					destroys: [{ what: "deleted rows", object: "shop.orders", rows: 40 }],
				},
			],
		});
	});

	it("says which steps still wait when the gateway's apply ran out of time, and to call data_apply again", async () => {
		const f = await fixture(() =>
			ok({
				applied: false,
				more: true,
				results: [
					{ name: "001-orders", state: "applied" },
					{ name: "002-notes", state: "waiting" },
				],
			}),
		);
		expect(JSON.parse((await f.invoke("data_apply", { database: "shop" })).text)).toEqual({
			database: "shop",
			applied: false,
			steps: [
				{ name: "001-orders", state: "applied" },
				{ name: "002-notes", state: "waiting" },
			],
			more: true,
			note: "Steps are still waiting: call data_apply again to apply them",
		});
	});

	it("never says an apply failed when its call ended without an answer: the steps may still be applying", async () => {
		const unknown =
			"REFUSED: No answer came from the company's data store, so the steps may still be applying. Call data_describe to see which steps landed, then data_apply again for any still waiting.";
		const ended = await fixture(() => {
			throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company data door call ended");
		});
		expect(await ended.invoke("data_apply", { database: "shop" })).toMatchObject({ status: "denied", text: unknown });
		const failed = await fixture(() => ({ status: 500, value: { error: "The data gateway failed" } }));
		expect(await failed.invoke("data_apply", { database: "shop" })).toMatchObject({
			status: "denied",
			text: unknown,
		});
		// A read that ended is no answer, as before.
		const read = await ended.invoke("data_query", { database: "shop", question: "count" });
		expect(read.status).not.toBe("ok");
		expect(read.text).not.toMatch(/^REFUSED/);
	});

	it("sends the texts the gateway asks for in bodies that fit its 1 MiB as JSON, escaping counted", async () => {
		// Nine distinct steps of 64 KiB, nearly all newlines: each doubles in size as JSON.
		const files = new Map<string, string>();
		for (let n = 1; n <= 9; n++) {
			const head = `-- step ${n}\n`;
			files.set(`data/shop/tables/00${n}-s.sql`, head + "\n".repeat(64 * 1024 - head.length));
		}
		const wanted = [...files].map(([path, text]) => ({ path, sha256: sha(text) }));
		const held = new Set<string>();
		const sizes: number[] = [];
		const f = await fixture(
			({ body }) => {
				sizes.push(Buffer.byteLength(JSON.stringify(body)));
				for (const hash of Object.keys((body.texts as Record<string, string> | undefined) ?? {})) held.add(hash);
				const need = wanted.filter((one) => !held.has(one.sha256));
				return need.length > 0
					? ok({ need })
					: ok({ applied: true, results: wanted.map((one) => ({ name: one.path, state: "applied" })) });
			},
			{ files },
		);
		expect((await f.invoke("data_apply", { database: "shop" })).status).toBe("ok");
		expect(held.size).toBe(9);
		expect(sizes.length).toBeGreaterThan(2);
		for (const size of sizes) expect(size).toBeLessThanOrEqual(1024 * 1024);
	});

	it("shows as many rows as one result holds, with more", async () => {
		const rows = Array.from({ length: 200 }, (_, index) => [index, "x".repeat(400)]);
		const f = await fixture(() => ok({ columns: ["n", "text"], rows, more: false, asOf: "2026-11-13T10:00:00Z" }));
		const answer = JSON.parse((await f.invoke("data_query", { database: "shop", sql: "select 1" })).text);
		expect(answer.more).toBe(true);
		expect(answer.rows.length).toBeGreaterThan(0);
		expect(answer.rows.length).toBeLessThan(200);
		expect(answer.rows[0]).toEqual([0, "x".repeat(400)]);
	});

	it("runs a named change with its values, and shows how many rows it wrote and what it gave back", async () => {
		const f = await fixture(() =>
			ok({
				changed: 1,
				columns: ["id", "customer"],
				rows: [[41, "Ada"]],
				more: false,
				asOf: "2026-11-14T10:00:00Z",
			}),
		);
		const answer = await f.invoke("data_change", {
			database: "shop",
			change: "add-order",
			params: { customer: "Ada", amount: 120.5, gift: false, note: null },
		});
		expect(answer).toMatchObject({ success: true, status: "ok" });
		expect(JSON.parse(answer.text)).toEqual({
			database: "shop",
			change: "add-order",
			changed: 1,
			columns: ["id", "customer"],
			rows: [[41, "Ada"]],
			more: false,
			asOf: "2026-11-14T10:00:00Z",
		});
		// A pass for the database, as the run, and the change by its name: no SQL of the agent's own goes to the door.
		expect(f.platformCalls.map((call) => [call.method, call.args.p_database])).toEqual([[PASS, "shop"]]);
		expect(f.doorCalls).toHaveLength(1);
		expect(f.doorCalls[0]?.verb).toBe("change");
		const { pass: sent, ...body } = f.doorCalls[0]?.body ?? {};
		expect(sent).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(body).toEqual({
			database: "shop",
			change: "add-order",
			params: { customer: "Ada", amount: 120.5, gift: false, note: null },
		});
		// A statement that gives nothing back: how many rows it wrote, and no rows. A select that called a function says
		// what the function gave, and no count.
		const plain = await fixture(() => ok({ changed: 3, asOf: "2026-11-14T10:00:00Z" }));
		expect(JSON.parse((await plain.invoke("data_change", { database: "shop", change: "close-all" })).text)).toEqual({
			database: "shop",
			change: "close-all",
			changed: 3,
			asOf: "2026-11-14T10:00:00Z",
		});
		expect(plain.doorCalls[0]?.body).not.toHaveProperty("params");
		const called = await fixture(() =>
			ok({ columns: ["closed"], rows: [[7]], more: false, asOf: "2026-11-14T10:00:00Z" }),
		);
		expect(JSON.parse((await called.invoke("data_change", { database: "shop", change: "close-all" })).text)).toEqual({
			database: "shop",
			change: "close-all",
			columns: ["closed"],
			rows: [[7]],
			more: false,
			asOf: "2026-11-14T10:00:00Z",
		});
	});

	it("reads a change's file as the run when the gateway asks for it, and tells the gateway's refusal as it is", async () => {
		const files = new Map([
			...FILES,
			[
				"data/shop/actions/mark-shipped.sql",
				"-- Mark order :id as shipped.\nupdate orders set id = id where id = :id;\n",
			],
		]);
		const text = files.get("data/shop/actions/mark-shipped.sql") ?? "";
		const f = await fixture(
			(_call, count) =>
				count === 1
					? ok({ need: [{ path: "data/shop/actions/mark-shipped.sql", sha256: sha(text) }] })
					: ok({ changed: 1, asOf: "2026-11-14T10:00:00Z" }),
			{ files },
		);
		const answer = await f.invoke("data_change", { database: "shop", change: "mark-shipped", params: { id: 7 } });
		expect(answer.status).toBe("ok");
		expect(f.platformCalls.map((call) => call.method)).toEqual([PASS, READ, PASS]);
		expect(f.doorCalls[1]?.body.texts).toEqual({ [sha(text)]: text });
		expect(f.doorCalls[1]?.body).toMatchObject({ database: "shop", change: "mark-shipped", params: { id: 7 } });
		// What the gateway refused, in its words: a change that does a step's work, one that is not there, a full database.
		for (const [status, error] of [
			[
				400,
				"A change adds, changes and deletes rows. This one also dropped table shop.orders, which is a step's work: nothing was changed",
			],
			[404, "No change shop/nope that you may run"],
			[
				507,
				"This company's database is at its size limit of 1 GiB: only a change that deletes rows runs until there is room",
			],
		] as const) {
			const refused = await fixture(() => ({ status, value: { error } }));
			expect(await refused.invoke("data_change", { database: "shop", change: "nope" })).toMatchObject({
				status: "denied",
				text: `REFUSED: ${error}`,
			});
		}
	});

	it("never says a change failed when its call ended without an answer: it may have run", async () => {
		const unknown =
			"REFUSED: No answer came from the company's data store, so the change may or may not have run. Read the rows with data_query before you run it again, so it does not run twice.";
		const ended = await fixture(() => {
			throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company data door call ended");
		});
		expect(await ended.invoke("data_change", { database: "shop", change: "add-order" })).toMatchObject({
			status: "denied",
			text: unknown,
		});
		const failed = await fixture(() => ({ status: 503, value: { error: "The data store did not answer" } }));
		expect(await failed.invoke("data_change", { database: "shop", change: "add-order" })).toMatchObject({
			status: "denied",
			text: unknown,
		});
		// An answer that is not a change's is no answer.
		for (const value of [{ changed: "three" }, { rows: [[1]] }, { columns: ["id"], rows: "none", more: false }]) {
			const odd = await fixture(() => ok(value));
			const answer = await odd.invoke("data_change", { database: "shop", change: "add-order" });
			expect(answer.status, JSON.stringify(value)).not.toBe("ok");
			expect(answer.text).not.toMatch(/^REFUSED/);
		}
	});

	it("shows as many of a change's rows as one result holds, with more, and always how many it wrote", async () => {
		const rows = Array.from({ length: 200 }, (_, index) => [index, "x".repeat(400)]);
		const f = await fixture(() =>
			ok({ changed: 200, columns: ["id", "note"], rows, more: false, asOf: "2026-11-14T10:00:00Z" }),
		);
		const answer = JSON.parse((await f.invoke("data_change", { database: "shop", change: "note-all" })).text);
		expect(answer.changed).toBe(200);
		expect(answer.more).toBe(true);
		expect(answer.rows.length).toBeGreaterThan(0);
		expect(answer.rows.length).toBeLessThan(200);
		expect(answer.rows[0]).toEqual([0, "x".repeat(400)]);
	});

	it("refuses arguments it cannot send, before asking for a pass", async () => {
		const f = await fixture(() => ok({}));
		for (const args of [
			{ database: "Shop", question: "count" },
			{ database: "shop" },
			{ database: "shop", question: "count", sql: "select 1" },
			{ database: "shop", question: "Count" },
			{ database: "shop", sql: "x".repeat(16 * 1024 + 1) },
			{ database: "shop", sql: "select 1", params: { "a-b": 1 } },
			{ database: "shop", sql: "select 1", params: { a: [1] } },
			{ database: "shop", sql: "select 1", extra: true },
		])
			expect((await f.invoke("data_query", args)).success, JSON.stringify(args).slice(0, 80)).toBe(false);
		expect((await f.invoke("data_apply", {})).success).toBe(false);
		for (const args of [
			{ database: "shop" },
			{ change: "add-order" },
			{ database: "shop", change: "Add Order" },
			{ database: "shop", change: "x".repeat(61) },
			{ database: "shop", change: "add-order", sql: "delete from orders" },
			{ database: "shop", change: "add-order", params: [1] },
			{ database: "shop", change: "add-order", params: { "a-b": 1 } },
			{ database: "shop", change: "add-order", params: { a: { b: 1 } } },
			{ database: "shop", change: "add-order", params: { a: "x".repeat(5000) } },
		])
			expect((await f.invoke("data_change", args)).success, JSON.stringify(args).slice(0, 80)).toBe(false);
		expect(f.platformCalls).toEqual([]);
	});
});

describe("the run door over HTTPS", () => {
	let directory: string;
	let cert: string;
	let key: string;
	let other: string;
	let server: Server;
	const seen: { path?: string; authorization?: string; body?: string }[] = [];
	const slow: NodeJS.Timeout[] = [];
	const token = randomBytes(32).toString("base64url");
	const make = (name: string) => {
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
			{ encoding: "utf8", timeout: 15000 },
		);
		if (made.status !== 0) throw new Error("Could not create disposable test TLS certificate");
	};
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "qorpera-data-door-test-"));
		make("door");
		make("other");
		cert = await readFile(join(directory, "door.pem"), "utf8");
		key = await readFile(join(directory, "door-key.pem"), "utf8");
		other = await readFile(join(directory, "other.pem"), "utf8");
		server = createServer({ cert, key }, (request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (part: string) => {
				body += part;
			});
			request.on("end", () => {
				seen.push({ path: request.url, authorization: request.headers.authorization, body });
				// An answer after 32 s, past a read's 30 s.
				if (body.includes("slow")) {
					slow.push(
						setTimeout(() => {
							response.writeHead(200, { "content-type": "application/json" });
							response.end('{"applied":true,"results":[]}');
						}, 32_000),
					);
					return;
				}
				const text = body.includes("huge")
					? JSON.stringify({ rows: "x".repeat(5 * 1024 * 1024) })
					: '{"columns":[]}';
				response.writeHead(body.includes("refuse") ? 404 : 200, { "content-type": "application/json" });
				response.end(text);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	});
	afterAll(async () => {
		for (const timer of slow) clearTimeout(timer);
		server?.close();
		server?.closeAllConnections();
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	const url = () => `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

	it("calls the door with the node's token, its CA pinned, and gives back the status and the answer", async () => {
		const door = httpsCompanyDataDoor({ url: url(), ca: cert, token });
		expect(await door.call("query", { database: "shop", pass: "p" }, new AbortController().signal)).toEqual({
			status: 200,
			value: { columns: [] },
		});
		expect(seen.at(-1)).toEqual({
			path: "/v1/run-data/query",
			authorization: `Bearer ${token}`,
			body: JSON.stringify({ database: "shop", pass: "p" }),
		});
		expect(await door.call("describe", { refuse: true }, new AbortController().signal)).toEqual({
			status: 404,
			value: { columns: [] },
		});
		await expect(door.call("query", { huge: true }, new AbortController().signal)).rejects.toThrow(/too large/);
	});

	it("waits 120 s for an apply, whose steps may take longer than a read's 30 s, and 30 s for a read", async () => {
		const door = httpsCompanyDataDoor({ url: url(), ca: cert, token });
		const [applied, read] = await Promise.allSettled([
			door.call("apply", { database: "slow" }, new AbortController().signal),
			door.call("query", { database: "slow" }, new AbortController().signal),
		]);
		expect(applied).toEqual({ status: "fulfilled", value: { status: 200, value: { applied: true, results: [] } } });
		expect(read.status).toBe("rejected");
		expect(String((read as PromiseRejectedResult).reason)).toMatch(/unavailable/);
	}, 60_000);

	it("does not talk to a door whose certificate the pinned CA did not sign", async () => {
		const door = httpsCompanyDataDoor({ url: url(), ca: other, token });
		const before = seen.length;
		await expect(door.call("query", {}, new AbortController().signal)).rejects.toThrow(/unavailable/);
		expect(seen.length).toBe(before);
	});

	it("takes only an HTTPS origin, a CA and a token of 32 bytes", () => {
		for (const options of [
			{ url: "http://127.0.0.1:8490", ca: cert, token },
			{ url: "https://127.0.0.1:8490/v1", ca: cert, token },
			{ url: "https://user:pw@127.0.0.1:8490", ca: cert, token },
			{ url: "https://127.0.0.1:8490", ca: "not a certificate", token },
			{ url: "https://127.0.0.1:8490", ca: cert, token: "short" },
		])
			expect(() => httpsCompanyDataDoor(options)).toThrow("Invalid company data door configuration");
	});
});
