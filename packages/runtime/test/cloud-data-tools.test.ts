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
	DATA_DESCRIBE_DESCRIPTION,
	DATA_QUERY_DESCRIPTION,
	httpsCompanyDataDoor,
} from "@qorpera/runtime/cloud-data-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary, type CloudToolResult } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CLOUD_RUNTIME_TOOL_OPERATIONS, CloudRuntimeObservability } from "@qorpera/runtime/cloud-runtime-observability";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/* Company databases, slice 5 (cloud-data-tools.ts, migration 20260930750000): data_describe, data_apply and data_query.
 * Each call asks the platform for a data pass through the run's real folder client and sends it to the data gateway's
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

/** A run with the three tools. `platform` answers the folder client's calls (the pass, a file's entry); `door` answers
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
	it("are three runtime tools, described briefly, and a worker's run is not offered data_apply", async () => {
		const f = await fixture(() => ok({}));
		expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([
			["data_describe", "runtime"],
			["data_apply", "runtime"],
			["data_query", "runtime"],
		]);
		for (const tool of f.tools) {
			expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain(tool.name);
			expect(Buffer.byteLength(tool.description)).toBeLessThan(600);
		}
		expect(f.tools.map((tool) => tool.description)).toEqual([
			DATA_DESCRIBE_DESCRIPTION,
			DATA_APPLY_DESCRIPTION,
			DATA_QUERY_DESCRIPTION,
		]);
		expect(DATA_APPLY_DESCRIPTION).toContain("it waits for a member to say yes");
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

	it("shows as many rows as one result holds, with more", async () => {
		const rows = Array.from({ length: 200 }, (_, index) => [index, "x".repeat(400)]);
		const f = await fixture(() => ok({ columns: ["n", "text"], rows, more: false, asOf: "2026-11-13T10:00:00Z" }));
		const answer = JSON.parse((await f.invoke("data_query", { database: "shop", sql: "select 1" })).text);
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
