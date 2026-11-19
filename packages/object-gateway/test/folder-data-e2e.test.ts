import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataDoor, DoorAnswer } from "../src/folder-service/data-door.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { type BridgeInfo, type DataVerb, encodeJson, Kind } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	PLACEMENT,
	storeFile,
	TEST_MACHINE,
	testGrants,
} from "./folder-service-fixtures.ts";

const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

const TEST_VIEW = "7e57f1e0-0001-4a00-8b00-000000000001";
const PASS = "testpass_0123456789-abcdefghijklmnopqrstuvw";
const AT_TEST: BridgeInfo = { cid: 95, lookup: "found", machine: TEST_MACHINE };
const ELSEWHERE: BridgeInfo = {
	cid: 97,
	lookup: "found",
	machine: { ...TEST_MACHINE, name: `qorpera-machine-${"f".repeat(32)}` },
};
const FILES: Record<string, string> = {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": "create table orders (id int primary key);\n",
	"data/shop/queries/count.sql": "-- How many orders since :since.\nselect count(*) from orders;\n",
	"data/shop/actions/add.sql": "-- Add order :id.\ninsert into orders values (:id);\n",
};

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve) => server.listen(path, resolve));
}

function data(args: readonly string[]): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(program as string, ["data", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

describe.skipIf(!program)("the data command against the folder service", () => {
	async function machine() {
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-data-e2e-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "objects");
		const company = join(dir, "company");
		const core = new FakeCore();
		const entries = [folder("data"), folder("data/shop")];
		for (const part of ["tables", "queries", "actions"]) entries.push(folder(`data/shop/${part}`));
		let version = 1;
		for (const [path, text] of Object.entries(FILES)) {
			entries.push(await storeFile(root, path, text, ++version));
			await mkdir(join(company, path, ".."), { recursive: true });
			await writeFile(join(company, path), text);
		}
		core.seed(entries);
		core.openView(TEST_VIEW, PASS, { kind: "test_machine", machineId: PLACEMENT });
		const calls: { verb: DataVerb; body: Record<string, unknown> }[] = [];
		let answer: (verb: DataVerb, body: Record<string, unknown>) => DoorAnswer = () => ({
			status: 200,
			body: Buffer.from("{}"),
		});
		const door: DataDoor = {
			call: async (verb, body) => {
				const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
				calls.push({ verb, body: parsed });
				return answer(verb, parsed);
			},
		};
		const objects = new NasObjects({ root, cacheBytes: 16 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: testGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
			dataDoor: door,
		});
		cleanup.push(() => service.stop());
		const held = await service.open(
			{ protocol: 4, environmentId: ENV, viewId: TEST_VIEW, pass: PASS, role: "io" },
			AT_TEST,
		);
		cleanup.push(() => held.release());
		const serviceSocket = join(dir, "service.sock");
		const server = createFolderServer(service, () => {});
		await listen(server, serviceSocket);
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const bridged = async (name: string, info: BridgeInfo): Promise<string> => {
			const path = join(dir, name);
			const bridge = createServer((from) => {
				const upstream = connect(serviceSocket, () => {
					upstream.write(encodeJson(Kind.bridge, info));
					from.pipe(upstream);
					upstream.pipe(from);
				});
				from.on("error", () => upstream.destroy());
				upstream.on("error", () => from.destroy());
				from.on("close", () => upstream.destroy());
				upstream.on("close", () => from.destroy());
			});
			await listen(bridge, path);
			cleanup.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
			return `unix:${path}`;
		};
		const viewFile = join(dir, "view.json");
		await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId: TEST_VIEW, pass: PASS }), { mode: 0o600 });
		await chmod(viewFile, 0o600);
		const here = ["--view-file", viewFile, "--root", company, "--connect", await bridged("bridge.sock", AT_TEST)];
		const elsewhere = [
			"--view-file",
			viewFile,
			"--root",
			company,
			"--connect",
			await bridged("other.sock", ELSEWHERE),
		];
		return {
			dir,
			core,
			service,
			calls,
			here,
			elsewhere,
			answers: (next: typeof answer) => {
				answer = next;
			},
		};
	}

	const json = (status: number, value: unknown): DoorAnswer => ({ status, body: Buffer.from(JSON.stringify(value)) });
	const sha = (entry: { fileSha256?: string } | undefined): string => entry?.fileSha256 ?? "";

	it("asks a question as the machine's view, sends the text the store asks for, and prints the answer", async () => {
		const { core, service, calls, here, answers } = await machine();
		const question = "data/shop/queries/count.sql";
		const hash = sha(core.entries.get(question));
		answers((_verb, body) =>
			body.texts === undefined
				? json(200, { need: [{ path: question, sha256: hash }] })
				: json(200, { columns: ["count"], rows: [[2]], more: false }),
		);
		const asked = await data([...here, "query", "shop", "count", "since=2026-01-01", "limit:=5"]);
		expect(asked).toEqual({ code: 0, out: '{"columns":["count"],"more":false,"rows":[[2]]}\n', err: "" });
		expect(core.dataPasses.map((pass) => [pass.viewId, pass.database])).toEqual([
			[TEST_VIEW, "shop"],
			[TEST_VIEW, "shop"],
		]);
		const asks = { database: "shop", question: "count", params: { since: "2026-01-01", limit: 5 } };
		expect(calls).toEqual([
			{ verb: "query", body: { ...asks, pass: core.dataPasses[0]?.pass } },
			{ verb: "query", body: { ...asks, pass: core.dataPasses[1]?.pass, texts: { [hash]: FILES[question] } } },
		]);
		expect(await service.boundary(PLACEMENT)).toMatchObject({ reads: "released" });
		expect([...(core.readSets.get(TEST_VIEW)?.keys() ?? [])].sort()).toEqual(["data/shop/database.toml", question]);
	});

	it("describes, applies and changes, and gives a refusal's words with exit 1", async () => {
		const { calls, here, answers } = await machine();
		answers((verb) =>
			verb === "describe"
				? json(200, { databases: [{ database: "shop", name: "Shop" }], companyBytes: 1, limitBytes: 2 })
				: verb === "apply"
					? json(200, { applied: true, results: [{ step: "001-orders", state: "applied" }] })
					: verb === "change"
						? json(200, { changed: 1 })
						: json(404, { error: "No question shop/nope that you may read" }),
		);
		expect(await data([...here, "describe"])).toMatchObject({
			code: 0,
			out: '{"companyBytes":1,"databases":[{"database":"shop","name":"Shop"}],"limitBytes":2}\n',
		});
		expect(await data([...here, "describe", "shop"])).toMatchObject({ code: 0 });
		expect(await data([...here, "apply", "shop"])).toMatchObject({
			code: 0,
			out: '{"applied":true,"results":[{"state":"applied","step":"001-orders"}]}\n',
		});
		expect(await data([...here, "change", "shop", "add", "id:=7"])).toEqual({
			code: 0,
			out: '{"changed":1}\n',
			err: "",
		});
		expect(await data([...here, "query", "shop", "nope"])).toEqual({
			code: 1,
			out: "",
			err: "data: No question shop/nope that you may read\n",
		});
		expect(calls.map((call) => [call.verb, { ...call.body, pass: undefined }])).toEqual([
			["describe", { pass: undefined }],
			["describe", { database: "shop", pass: undefined }],
			["apply", { database: "shop", pass: undefined }],
			["change", { database: "shop", change: "add", params: { id: 7 }, pass: undefined }],
			["query", { database: "shop", question: "nope", pass: undefined }],
		]);
		expect(await data([...here, "apply", "nothing"])).toMatchObject({
			code: 1,
			err: expect.stringContaining("No database nothing that this machine may read"),
		});
	});

	it("reaches nothing from another machine, without a view, or past what the command line says", async () => {
		const { dir, calls, here, elsewhere } = await machine();
		expect(await data([...elsewhere, "describe"])).toMatchObject({
			code: 3,
			out: "",
			err: expect.stringContaining("The view, its pass or this machine did not match"),
		});
		expect(
			await data(["--view-file", join(dir, "none.json"), "--connect", here[5] as string, "describe"]),
		).toMatchObject({ code: 3, out: "", err: expect.stringContaining("this machine has no company folder") });
		expect(
			await data(["--view-file", here[1] as string, "--connect", `unix:${join(dir, "gone.sock")}`, "describe"]),
		).toMatchObject({ code: 3, out: "" });
		for (const bad of [
			[],
			["watch", "shop"],
			["query", "shop"],
			["change", "shop", "add", "id"],
			["apply", "Shop"],
		]) {
			const refused = await data([...here, ...bad]);
			expect(refused).toMatchObject({ code: 2, out: "" });
			expect(refused.err).toContain("qorpera-folder data");
		}
		expect(calls).toEqual([]);
	});
});
