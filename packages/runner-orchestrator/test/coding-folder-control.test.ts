import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_FOLDER_CONTROL_SOCKET,
	type CodingFolderBoundaryView,
	CodingFolderControl,
	CodingFolderControlRefused,
	type CodingFolderReads,
	codingFolderBoundaryHeld,
	codingFolderSaveRefused,
	codingFolderViewSaved,
} from "../src/coding-folder-control.ts";
import { CodingFolderSecretKey, type CodingFolderSecretSet } from "../src/coding-folder-secrets.ts";

const MACHINE = "12345678-1234-4234-8234-000000000001";
const VIEW = "12345678-1234-4234-8234-000000000002";
const FINAL = "12345678-1234-4234-8234-000000000003";
const OTHER = "12345678-1234-4234-8234-000000000004";
const CANARY = "canary-folder-answer";

const directories: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A control socket that serves each connection with `serve`. */
async function listen(serve: (socket: Socket) => void, timeoutMs?: number) {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-folder-control-"));
	directories.push(directory);
	const path = join(directory, "control.sock");
	let connections = 0;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		connections++;
		sockets.add(socket);
		socket.on("error", () => undefined);
		serve(socket);
	});
	servers.push(server);
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(path, done);
	});
	return {
		client: new CodingFolderControl({ path, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
		connections: () => connections,
		path,
	};
}

/** One that takes each connection's whole request, all that came before our side ended, and then has `answer` answer. */
async function control(answer: (socket: Socket) => void, timeoutMs?: number) {
	const requests: string[] = [];
	const served = await listen((socket) => {
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("end", () => {
			requests.push(Buffer.concat(chunks).toString());
			answer(socket);
		});
	}, timeoutMs);
	return { ...served, requests };
}

const reply =
	(value: unknown) =>
	(socket: Socket): void => {
		socket.end(typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`);
	};
const report = { commitId: null, seq: null, paths: [{ path: CANARY, outcome: "saved" }] };
const boundary = (patch: Record<string, unknown> = {}) => ({
	boundary: {
		machine: MACHINE,
		reads: "released",
		views: [
			{ viewId: VIEW, report },
			{ viewId: FINAL, error: { code: "VIEW_CLOSED", message: CANARY } },
		],
		...patch,
	},
});
const viewError = { code: "DENIED", message: "" };
const signal = () => new AbortController().signal;

describe("the folder service's control socket", () => {
	it("is where the socket unit puts it", () => {
		expect(CODING_FOLDER_CONTROL_SOCKET).toBe("/run/qorpera-folder-control/control.sock");
	});

	it("asks a machine's boundary on a connection of its own, and reads each view's report or error", async () => {
		const f = await control(reply(boundary()));
		const answer = await f.client.boundary(MACHINE, [FINAL], signal());
		expect(answer).toEqual({
			machine: MACHINE,
			reads: "released",
			views: [
				{ viewId: VIEW, unsaved: 0 },
				{ viewId: FINAL, error: "VIEW_CLOSED" },
			],
		});
		expect(JSON.stringify(answer)).not.toContain(CANARY);
		expect([answer, answer.views, ...answer.views].every((value) => Object.isFrozen(value))).toBe(true);
		expect(f.requests).toEqual([`${JSON.stringify({ op: "boundary", machine: MACHINE, final: [FINAL] })}\n`]);
		await f.client.boundary(MACHINE, [], signal());
		expect(f.requests[1]).toBe(`${JSON.stringify({ op: "boundary", machine: MACHINE, final: [] })}\n`);
		expect(f.connections()).toBe(2);
	});

	it("reads what each view's report says of the save: paths not saved, and a change set refused whole", async () => {
		const views = [
			// A final that closed the view with every path saved.
			{ commitId: CANARY, seq: 7, closed: true, paths: [{ path: CANARY, outcome: "saved" }] },
			// A final keeps nothing pending, so what it did not save is lost with the close.
			{
				commitId: CANARY,
				seq: 8,
				closed: true,
				paths: [
					{ path: CANARY, outcome: "saved" },
					// A conflicting link carries its target (the service's protocol 4), which is not kept either.
					{ path: CANARY, outcome: "conflict", receipt: CANARY, target: CANARY },
					{ path: CANARY, outcome: "denied", reason: CANARY },
					{ path: CANARY, outcome: "waiting_for_review", reason: "parked" },
				],
			},
			// A commit with no answer yet, and a path waiting on an open file: both kept pending.
			{
				commitId: null,
				seq: null,
				paths: [
					{ path: CANARY, outcome: "not_applied", reason: CANARY, kept: true },
					{ path: CANARY, outcome: "waiting", reason: CANARY, kept: true },
					{ path: CANARY, outcome: "saved" },
				],
			},
			// Refused whole: what it carried stays pending.
			{ commitId: null, seq: null, refused: "stopped", paths: [{ path: CANARY, outcome: "refused", kept: true }] },
			{ commitId: null, seq: null, refused: "unproven", paths: [] },
			// The save check's refusals (5j-5 (a)): for a secret value in a file, a name or a link's target, or a change
			// waiting on one. A file it could not finish checking, or a refusal of the core's own, found no value.
			{
				commitId: null,
				seq: null,
				paths: [
					{ path: CANARY, outcome: "refused", reason: "it carries a secret value", kept: true },
					{ path: CANARY, outcome: "refused", reason: "a name in this folder carries a secret value", kept: true },
					{ path: CANARY, outcome: "refused", reason: "its link's target carries a secret value", kept: true },
					{ path: CANARY, outcome: "refused", reason: "it waits for a change that carries a secret value" },
					{ path: CANARY, outcome: "refused", reason: "it could not be checked for secret values", kept: true },
					{ path: CANARY, outcome: "refused", reason: "structured_invalid", kept: true },
					{ path: CANARY, outcome: "refused", kept: true },
					{ path: CANARY, outcome: "denied", reason: "it carries a secret value" },
				],
			},
			{
				commitId: null,
				seq: null,
				paths: [
					{ path: CANARY, outcome: "saved" },
					{ path: CANARY, outcome: "refused", reason: "it carries a secret value", kept: true },
				],
			},
		].map((report) => ({ viewId: randomUUID(), report }));
		const f = await control(reply(boundary({ views })));
		const answer = await f.client.boundary(MACHINE, [], signal());
		expect(answer.views).toEqual([
			{ viewId: views[0].viewId, unsaved: 0 },
			{ viewId: views[1].viewId, unsaved: 3, unsavedOutcome: "conflict" },
			{ viewId: views[2].viewId, unsaved: 2, unsavedOutcome: "not_applied" },
			{ viewId: views[3].viewId, unsaved: 1, unsavedOutcome: "refused", refused: "stopped" },
			{ viewId: views[4].viewId, unsaved: 0, refused: "unproven" },
			{ viewId: views[5].viewId, unsaved: 8, unsavedOutcome: "refused", secretRefused: 4 },
			{ viewId: views[6].viewId, unsaved: 1, unsavedOutcome: "refused", secretRefused: 1 },
		]);
		expect(JSON.stringify(answer)).not.toContain(CANARY);
		expect(answer.views.map((view) => codingFolderViewSaved(view))).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(codingFolderViewSaved({ viewId: VIEW, error: "VIEW_CLOSED" })).toBe(false);
		expect(codingFolderViewSaved(undefined)).toBe(false);
		const one = (view: CodingFolderBoundaryView) => ({ machine: MACHINE, reads: "released" as const, views: [view] });
		expect(answer.views.map((view) => codingFolderBoundaryHeld(one(view)))).toEqual([
			undefined,
			"UNSAVED_CONFLICT",
			"UNSAVED_NOT_APPLIED",
			"REFUSED_STOPPED",
			"REFUSED_UNPROVEN",
			"UNSAVED_REFUSED",
			"UNSAVED_REFUSED",
		]);
		expect(answer.views.map((view) => codingFolderSaveRefused(one(view)))).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
	});

	it("tells a save held back only by paths that carry a secret value (5j-5 (a)) from any other", () => {
		const refused = (reads: CodingFolderReads, ...views: CodingFolderBoundaryView[]) =>
			codingFolderSaveRefused({ machine: MACHINE, reads, views });
		const saved = { viewId: VIEW, unsaved: 0 };
		const carries = { viewId: FINAL, unsaved: 2, unsavedOutcome: "refused", secretRefused: 2 };
		expect(refused("released", saved, carries)).toBe(true);
		expect(refused("released", carries, { ...carries, viewId: OTHER })).toBe(true);
		// Saved, so nothing is held.
		expect(refused("released")).toBe(false);
		expect(refused("released", saved)).toBe(false);
		// Held for something else too: the reads, a path refused for no value found or left waiting, an error, a change
		// set refused whole, or a view with no report.
		expect(refused("unproven", carries)).toBe(false);
		expect(refused("released", { ...carries, secretRefused: 1 })).toBe(false);
		expect(refused("released", { viewId: FINAL, unsaved: 1, unsavedOutcome: "refused" })).toBe(false);
		expect(refused("released", carries, { viewId: OTHER, unsaved: 1, unsavedOutcome: "waiting" })).toBe(false);
		expect(refused("released", carries, { viewId: OTHER, error: "VIEW_CLOSED" })).toBe(false);
		expect(refused("released", { ...carries, refused: "stopped" })).toBe(false);
		expect(refused("released", carries, { viewId: OTHER })).toBe(false);
	});

	it("names why a boundary holds the output back, from its reads or its first view not saved", () => {
		const saved = { viewId: VIEW, unsaved: 0 };
		const held = (reads: CodingFolderReads, ...views: CodingFolderBoundaryView[]) =>
			codingFolderBoundaryHeld({ machine: MACHINE, reads, views });
		expect(held("released")).toBeUndefined();
		expect(held("released", saved, { viewId: FINAL, unsaved: 0 })).toBeUndefined();
		// The reads come first, whatever the views say.
		expect(held("unanswered", saved)).toBe("READS_UNANSWERED");
		expect(held("run_ended", { viewId: FINAL, error: "VIEW_CLOSED" })).toBe("READS_RUN_ENDED");
		// The first view not saved names it: its error, a whole refusal, its first path not saved, or no report.
		expect(held("released", saved, { viewId: FINAL, error: "VIEW_CLOSED" }, { viewId: OTHER, unsaved: 1 })).toBe(
			"VIEW_CLOSED",
		);
		expect(held("released", { viewId: FINAL, unsaved: 2, unsavedOutcome: "waiting", refused: "denied" })).toBe(
			"REFUSED_DENIED",
		);
		expect(held("released", { viewId: FINAL, unsaved: 2, unsavedOutcome: "waiting_for_review" })).toBe(
			"UNSAVED_WAITING_FOR_REVIEW",
		);
		expect(held("released", { viewId: FINAL, unsaved: 2 })).toBe("UNSAVED");
		expect(held("released", { viewId: FINAL })).toBe("UNREPORTED");
		// Each is a code's reason, as the executor's log keeps it.
		for (const reads of [
			"unanswered",
			"denied",
			"unreadable",
			"run_ended",
			"stopped",
			"invalid",
			"unproven",
		] as const)
			expect(held(reads)).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
		expect(held("released", { viewId: FINAL, error: `V${"_".repeat(63)}` })).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
	});

	it.each(["unanswered", "denied", "unreadable", "run_ended", "stopped", "invalid", "unproven"])(
		"passes on reads %s, which hold the output back",
		async (reads) => {
			const f = await control(reply(boundary({ reads, views: [] })));
			expect(await f.client.boundary(MACHINE, [], signal())).toEqual({ machine: MACHINE, reads, views: [] });
		},
	);

	it("says a machine restarted, and hears whether a read it was served before may have gone unreleased", async () => {
		for (const [answer, dropped] of [
			[{ machine: MACHINE, dropped: false }, false],
			[{ dropped: true, machine: MACHINE }, true],
			// A service from before F3 5g-5 does not say: the same as yes.
			[{ machine: MACHINE }, true],
		] as const) {
			const f = await control(reply({ restarted: answer }));
			await expect(f.client.restarted(MACHINE, signal())).resolves.toBe(dropped);
			expect(f.requests).toEqual([`${JSON.stringify({ op: "restarted", machine: MACHINE })}\n`]);
		}
	});

	it.each([
		["a machine that is not an id", "machine", []],
		["a final view that is not an id", MACHINE, ["view"]],
		["a final view twice", MACHINE, [VIEW, VIEW]],
		["more final views than the service takes", MACHINE, Array.from({ length: 257 }, () => randomUUID())],
	])("refuses %s before it connects", async (_name, machine, final) => {
		const f = await control(reply(boundary()));
		await expect(f.client.boundary(machine as string, final as string[], signal())).rejects.toThrow(
			"CODING_FOLDER_CONTROL_REQUEST_INVALID",
		);
		await expect(f.client.restarted("machine", signal())).rejects.toThrow("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		expect(f.connections()).toBe(0);
	});

	it("names as many final views as the service takes", async () => {
		const final = Array.from({ length: 256 }, () => randomUUID());
		const f = await control(reply(boundary({ views: [] })));
		await f.client.boundary(MACHINE, final, signal());
		expect(JSON.parse(f.requests[0]).final).toEqual(final);
	});

	it("rejects the service's error with its code alone", async () => {
		for (const code of ["VIEW_REFUSED", "UNAVAILABLE", "BAD_REQUEST"]) {
			const f = await control(reply({ error: { code, message: CANARY } }));
			const error = await f.client.boundary(MACHINE, [], signal()).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CodingFolderControlRefused);
			expect((error as CodingFolderControlRefused).code).toBe(code);
			expect((error as Error).message).toBe(`CODING_FOLDER_CONTROL_REFUSED:${code}`);
			await expect(f.client.restarted(MACHINE, signal())).rejects.toThrow(`CODING_FOLDER_CONTROL_REFUSED:${code}`);
		}
	});

	it("reads the refusal of a service that closes without reading the request", async () => {
		// As 5c's control.ts refuses a peer: the answer at once, then the connection goes with our request unread.
		const f = await listen((socket) => {
			socket.end(`${JSON.stringify({ error: { code: "VIEW_REFUSED", message: CANARY } })}\n`);
			socket.destroySoon();
		});
		for (let round = 0; round < 20; round++)
			await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow(
				"CODING_FOLDER_CONTROL_REFUSED:VIEW_REFUSED",
			);
	});

	it.each<[string, unknown]>([
		["another machine's boundary", boundary({ machine: OTHER })],
		["reads it does not know", boundary({ reads: "maybe" })],
		["reads that are not text", boundary({ reads: ["released"] })],
		["an unknown key", boundary({ token: CANARY })],
		["no views", { boundary: { machine: MACHINE, reads: "released" } }],
		["views that are not a list", boundary({ views: { [VIEW]: report } })],
		["a view that is not an object", boundary({ views: [VIEW] })],
		["a view id that is not an id", boundary({ views: [{ viewId: CANARY, report }] })],
		["a view with a report and an error", boundary({ views: [{ viewId: VIEW, report, error: viewError }] })],
		["a view with neither", boundary({ views: [{ viewId: VIEW }] })],
		["a view with another key", boundary({ views: [{ viewId: VIEW, report, token: CANARY }] })],
		["a report that is not an object", boundary({ views: [{ viewId: VIEW, report: CANARY }] })],
		["a report that is a list", boundary({ views: [{ viewId: VIEW, report: [CANARY] }] })],
		["a report that is null", boundary({ views: [{ viewId: VIEW, report: null }] })],
		...(
			[
				["a report without paths", { commitId: null, seq: null }],
				["a report without a commit id", { seq: null, paths: [] }],
				["a report with another key", { ...report, token: CANARY }],
				["a commit id that is not text", { ...report, commitId: 1 }],
				["a negative seq", { ...report, seq: -1 }],
				["a closed that is not true", { ...report, closed: false }],
				["a whole refusal it does not know", { ...report, refused: CANARY }],
				["a whole refusal of released", { ...report, refused: "released" }],
				["a path that is not an object", { ...report, paths: [CANARY] }],
				["a path without an outcome", { ...report, paths: [{ path: CANARY }] }],
				["an outcome it does not know", { ...report, paths: [{ path: CANARY, outcome: CANARY }] }],
				["a kept that is not true", { ...report, paths: [{ path: CANARY, outcome: "waiting", kept: false }] }],
				["a path entry with another key", { ...report, paths: [{ path: CANARY, outcome: "saved", at: 1 }] }],
				["a reason that is not text", { ...report, paths: [{ path: CANARY, outcome: "denied", reason: 1 }] }],
				[
					"a link target that is not text",
					{ ...report, paths: [{ path: CANARY, outcome: "conflict", target: 1 }] },
				],
			] satisfies [string, unknown][]
		).map(([name, bad]): [string, unknown] => [name, boundary({ views: [{ viewId: VIEW, report: bad }] })]),
		["a lowercase error code", boundary({ views: [{ viewId: VIEW, error: { code: CANARY, message: "" } }] })],
		["an error without a message", boundary({ views: [{ viewId: VIEW, error: { code: "DENIED" } }] })],
		["an error with another key", boundary({ views: [{ viewId: VIEW, error: { ...viewError, at: 1 } }] })],
		[
			"a view twice",
			boundary({
				views: [
					{ viewId: VIEW, report },
					{ viewId: VIEW, error: viewError },
				],
			}),
		],
		["a restart's answer", { restarted: { machine: MACHINE } }],
		["the answer and an error", { ...boundary(), error: { code: "UNAVAILABLE", message: "" } }],
		["an error that is not one", { error: CANARY }],
		["an error code that is too long", { error: { code: `A${"B".repeat(64)}`, message: "" } }],
		["nothing in it", {}],
		["a list", [boundary()]],
		["not JSON", `${CANARY}\n`],
		["a byte order mark", `﻿${JSON.stringify(boundary())}\n`],
		[
			"bytes that are not UTF-8",
			Buffer.concat([
				Buffer.from(`{"error":{"code":"DENIED","message":"`),
				Buffer.from([0xff]),
				Buffer.from('"}}\n'),
			]),
		],
		["bytes after the line", `${JSON.stringify(boundary())}\n${CANARY}`],
		["a second line", `${JSON.stringify(boundary())}\n${JSON.stringify(boundary())}\n`],
		["an empty line", "\n"],
	])("refuses an answer with %s, without quoting it", async (_name, answer) => {
		const f = await control(reply(answer));
		const error = await f.client.boundary(MACHINE, [FINAL], signal()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(CodingFolderControlRefused);
		expect((error as Error).message).toBe("CODING_FOLDER_CONTROL_ANSWER_INVALID");
	});

	it.each([
		["another machine", { restarted: { machine: OTHER } }],
		["another key", { restarted: { machine: MACHINE, at: 1 } }],
		["another key beside dropped", { restarted: { machine: MACHINE, dropped: false, at: 1 } }],
		["a dropped that is not a boolean", { restarted: { machine: MACHINE, dropped: "no" } }],
		["a dropped of null", { restarted: { machine: MACHINE, dropped: null } }],
		["a boundary's answer", boundary()],
	])("refuses a restart's answer for %s", async (_name, answer) => {
		const f = await control(reply(answer));
		await expect(f.client.restarted(MACHINE, signal())).rejects.toThrow("CODING_FOLDER_CONTROL_ANSWER_INVALID");
	});

	it("refuses an answer over 16 MiB without waiting for its end", async () => {
		const f = await control((socket) => {
			socket.write(`{"boundary":{"machine":"${MACHINE}","reads":"released","views":[],"pad":"`);
			socket.write("x".repeat(16 * 1024 * 1024));
		});
		await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_ANSWER_INVALID");
	});

	it("is unavailable without a socket, or when the service closes without a whole answer", async () => {
		const missing = new CodingFolderControl({ path: join(tmpdir(), `qorpera-no-control-${randomUUID()}.sock`) });
		await expect(missing.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		await expect(missing.restarted(MACHINE, signal())).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		for (const close of [
			(socket: Socket) => socket.end(),
			(socket: Socket) => socket.destroy(),
			(socket: Socket) => socket.end(JSON.stringify(boundary())),
			(socket: Socket) => socket.write(JSON.stringify(boundary()), () => socket.destroy()),
		]) {
			const f = await control(close);
			await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		}
	});

	it("gives up on a service that does not answer in time", async () => {
		const f = await control(() => undefined, 50);
		await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_TIMEOUT");
		await expect(f.client.restarted(MACHINE, signal())).rejects.toThrow("CODING_FOLDER_CONTROL_TIMEOUT");
	});

	it("stops at the caller's abort, with its reason", async () => {
		const f = await control(() => undefined);
		const controller = new AbortController();
		const asked = f.client.boundary(MACHINE, [], controller.signal);
		await expect.poll(() => f.requests.length).toBe(1);
		controller.abort(new Error("turn ended"));
		await expect(asked).rejects.toThrow("turn ended");
		await expect(f.client.restarted(MACHINE, controller.signal)).rejects.toThrow("turn ended");
		expect(f.connections()).toBe(1);
	});

	it("refuses a timeout that is not a positive whole number of milliseconds a Node timer keeps", () => {
		for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
			expect(() => new CodingFolderControl({ timeoutMs })).toThrow("Invalid folder control timeout");
		expect(() => new CodingFolderControl({ timeoutMs: 2_147_483_647 })).not.toThrow();
	});
});

describe("the machine's secret values for the save check (5j-5 (a))", () => {
	// The service's pinned vectors (object-gateway secret-scan.test.ts), under the key 0..31.
	const key = new CodingFolderSecretKey(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
	const VALUE = "test-value-0001";
	const pinned = { length: 15, start: 629920, whole: "5X_nxV1CHyqs5ZYNTg0gzw" };
	const two = key.set([VALUE, "12345678"]).set;

	/** A service answering each request by its op, and a client that sends `secrets`' set. */
	async function service(
		answers: Record<string, unknown>,
		secrets: (machine: string) => CodingFolderSecretSet | undefined,
	) {
		const f = await control((socket) => {
			const op = String(JSON.parse(f.requests.at(-1) ?? "{}").op);
			reply(answers[op] ?? { error: { code: "BAD_REQUEST", message: CANARY } })(socket);
		});
		return { ...f, client: new CodingFolderControl({ path: f.path, secrets }) };
	}

	it("sends the machine's set before each boundary, as keyed hashes, and hears how many values the service holds", async () => {
		const f = await service({ secrets: { secrets: { machine: MACHINE, values: 2 } }, boundary: boundary() }, (m) =>
			m === MACHINE ? two : undefined,
		);
		await expect(f.client.secrets(MACHINE, signal())).resolves.toBe(2);
		const sent = JSON.parse(f.requests[0]);
		expect(sent).toEqual({
			op: "secrets",
			machine: MACHINE,
			key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url"),
			values: [pinned, { length: 8, start: 482076, whole: "2qRGAeL827FEO7IY3r5SvQ" }],
		});
		// Never a value, nor a part of one (the machine's id holds the other's digits).
		expect(f.requests[0]).not.toContain(VALUE);
		expect(f.requests[0]?.replaceAll(MACHINE, "")).not.toContain("12345678");
		await f.client.boundary(MACHINE, [FINAL], signal());
		expect(f.requests.slice(1).map((request) => JSON.parse(request).op)).toEqual(["secrets", "boundary"]);
	});

	/** A service that holds each secrets request, unanswered and its connection open, until the test answers it; a
	 * boundary it answers at once. */
	async function holding(secrets: () => CodingFolderSecretSet | undefined, timeoutMs?: number) {
		const held: { values: unknown[]; closed: boolean; answer: () => void }[] = [];
		const f = await listen((socket) => {
			const chunks: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.on("end", () => {
				const request = JSON.parse(Buffer.concat(chunks).toString());
				if (request.op !== "secrets") {
					reply(boundary())(socket);
					return;
				}
				const each = {
					values: request.values,
					closed: false,
					answer: () => reply({ secrets: { machine: MACHINE, values: request.values.length } })(socket),
				};
				socket.on("close", () => {
					each.closed = true;
				});
				held.push(each);
			});
		});
		const client = new CodingFolderControl({
			path: f.path,
			secrets,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
		return { ...f, client, held };
	}
	const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

	it("sends a machine's sets one at a time, each as it is when its send starts: an older one never follows a newer", async () => {
		let set = key.set([VALUE]).set;
		const f = await holding(() => set);
		const first = f.client.secrets(MACHINE, signal());
		await expect.poll(() => f.held.length).toBe(1);
		// The values grow while the first send waits for its answer. The callers since wait for the next send, which
		// starts once the first was answered and sends what the machine has by then.
		set = two;
		const second = f.client.secrets(MACHINE, signal());
		const boundaryAsked = f.client.boundary(MACHINE, [], signal());
		await pause(50);
		expect(f.connections()).toBe(1);
		f.held[0]?.answer();
		await expect(first).resolves.toBe(1);
		await expect.poll(() => f.held.length).toBe(2);
		expect(f.held.map((each) => each.values)).toEqual([key.set([VALUE]).set.values, two.values]);
		// The boundary is asked only once the set it waited for is in.
		expect(f.connections()).toBe(2);
		f.held[1]?.answer();
		await expect(second).resolves.toBe(2);
		await expect(boundaryAsked).resolves.toMatchObject({ machine: MACHINE });
		// The callers that waited together shared one send.
		expect(f.connections()).toBe(3);
	});

	it("goes on with a send when its caller stops waiting, and sends the next only after its answer", async () => {
		const f = await holding(() => two, 200);
		const controller = new AbortController();
		const aborted = f.client.secrets(MACHINE, controller.signal);
		await expect.poll(() => f.held.length).toBe(1);
		controller.abort(new Error("turn ended"));
		await expect(aborted).rejects.toThrow("turn ended");
		await expect(f.client.secrets(MACHINE, signal())).rejects.toThrow("CODING_FOLDER_CONTROL_TIMEOUT");
		await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_TIMEOUT");
		// The first request is still where the service may read it, so nothing was sent after it.
		expect(f.held[0]?.closed).toBe(false);
		expect(f.connections()).toBe(1);
		f.held[0]?.answer();
		await expect.poll(() => f.held.length).toBe(2);
		f.held[1]?.answer();
		await expect.poll(() => f.held[1]?.closed).toBe(true);
		// A caller's own abort, as it asks, does not send.
		const gone = new AbortController();
		gone.abort(new Error("turn ended"));
		await expect(f.client.secrets(MACHINE, gone.signal)).rejects.toThrow("turn ended");
		expect(f.connections()).toBe(2);
	});

	it("sends the next set once a send's connection ends unanswered", async () => {
		const f = await holding(() => two);
		const first = f.client.secrets(MACHINE, signal());
		await expect.poll(() => f.held.length).toBe(1);
		const second = f.client.secrets(MACHINE, signal());
		for (const socket of sockets) socket.destroy();
		await expect(first).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		await expect.poll(() => f.held.length).toBe(2);
		f.held[1]?.answer();
		await expect(second).resolves.toBe(2);
	});

	it("sends an empty set as one: a machine whose member has no secrets", async () => {
		const f = await service({ secrets: { secrets: { machine: MACHINE, values: 0 } } }, () => key.set([]).set);
		await expect(f.client.secrets(MACHINE, signal())).resolves.toBe(0);
		expect(JSON.parse(f.requests[0]).values).toEqual([]);
	});

	it("sends nothing while the machine's values are not known here, and the boundary still goes", async () => {
		const f = await service({ boundary: boundary() }, () => undefined);
		await expect(f.client.secrets(MACHINE, signal())).resolves.toBeNull();
		expect(f.connections()).toBe(0);
		await f.client.boundary(MACHINE, [], signal());
		expect(f.requests.map((request) => JSON.parse(request).op)).toEqual(["boundary"]);
		// Without the option, too.
		const plain = await control(reply(boundary()));
		await expect(plain.client.secrets(MACHINE, signal())).resolves.toBeNull();
		expect(plain.connections()).toBe(0);
	});

	it("carries on against a service from before the check, which refuses the request as BAD_REQUEST", async () => {
		const f = await service(
			{
				secrets: {
					error: { code: "BAD_REQUEST", message: "A request's op is boundary, restarted, open or close" },
				},
				boundary: boundary(),
			},
			() => two,
		);
		await expect(f.client.secrets(MACHINE, signal())).resolves.toBe("unsupported");
		await expect(f.client.boundary(MACHINE, [], signal())).resolves.toMatchObject({ machine: MACHINE });
	});

	it("fails the boundary, before it is asked, when the set does not reach the service", async () => {
		for (const code of ["UNAVAILABLE", "DENIED"]) {
			const f = await service({ secrets: { error: { code, message: CANARY } }, boundary: boundary() }, () => two);
			await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow(
				`CODING_FOLDER_CONTROL_REFUSED:${code}`,
			);
			expect(f.requests.map((request) => JSON.parse(request).op)).toEqual(["secrets"]);
		}
		const path = join(tmpdir(), `qorpera-no-folder-${randomUUID()}.sock`);
		const gone = new CodingFolderControl({ path, secrets: () => two });
		await expect(gone.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
	});

	it.each([
		["a key that is not 32 bytes", { ...two, key: Buffer.alloc(31).toString("base64url") }],
		["a key padded", { ...two, key: `${two.key}=` }],
		["a value shorter than the service checks", { ...two, values: [{ ...pinned, length: 7 }] }],
		["a value longer than the service checks", { ...two, values: [{ ...pinned, length: 32 * 1024 + 1 }] }],
		["a start of more than 20 bits", { ...two, values: [{ ...pinned, start: 2 ** 20 }] }],
		["a negative start", { ...two, values: [{ ...pinned, start: -1 }] }],
		["a hash that is not 16 bytes", { ...two, values: [{ ...pinned, whole: "5X_nxV1CHyqs5ZYNTg0g" }] }],
		["a hash written another way", { ...two, values: [{ ...pinned, whole: "5X_nxV1CHyqs5ZYNTg0gzx" }] }],
		["more values than the service holds", { ...two, values: Array.from({ length: 4097 }, () => pinned) }],
	])("refuses %s before it connects", async (_name, set) => {
		const f = await service({}, () => set as CodingFolderSecretSet);
		await expect(f.client.secrets(MACHINE, signal())).rejects.toThrow("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		await expect(f.client.boundary(MACHINE, [], signal())).rejects.toThrow("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		await expect(f.client.secrets("machine", signal())).rejects.toThrow("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		expect(f.connections()).toBe(0);
	});

	it("takes 4096 values, the most one set holds", async () => {
		const values = Array.from({ length: 4096 }, () => pinned);
		const f = await service({ secrets: { secrets: { machine: MACHINE, values: 1 } } }, () => ({ ...two, values }));
		await expect(f.client.secrets(MACHINE, signal())).resolves.toBe(1);
	});

	it.each([
		["another machine", { machine: OTHER, values: 2 }],
		["more values than were sent", { machine: MACHINE, values: 3 }],
		["a negative count", { machine: MACHINE, values: -1 }],
		["a count that is not a number", { machine: MACHINE, values: "2" }],
		["more than it says", { machine: MACHINE, values: 2, note: CANARY }],
	])("refuses an answer naming %s, without quoting it", async (_name, answer) => {
		const f = await service({ secrets: { secrets: answer } }, () => two);
		const error = await f.client.secrets(MACHINE, signal()).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe("CODING_FOLDER_CONTROL_ANSWER_INVALID");
	});
});
