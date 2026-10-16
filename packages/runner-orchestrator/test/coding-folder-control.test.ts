import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_FOLDER_CONTROL_SOCKET,
	CodingFolderControl,
	CodingFolderControlRefused,
	codingFolderViewSaved,
} from "../src/coding-folder-control.ts";

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
		].map((report) => ({ viewId: randomUUID(), report }));
		const f = await control(reply(boundary({ views })));
		const answer = await f.client.boundary(MACHINE, [], signal());
		expect(answer.views).toEqual([
			{ viewId: views[0].viewId, unsaved: 0 },
			{ viewId: views[1].viewId, unsaved: 3 },
			{ viewId: views[2].viewId, unsaved: 2 },
			{ viewId: views[3].viewId, unsaved: 1, refused: "stopped" },
			{ viewId: views[4].viewId, unsaved: 0, refused: "unproven" },
		]);
		expect(JSON.stringify(answer)).not.toContain(CANARY);
		expect(answer.views.map((view) => codingFolderViewSaved(view))).toEqual([true, false, false, false, false]);
		expect(codingFolderViewSaved({ viewId: VIEW, error: "VIEW_CLOSED" })).toBe(false);
		expect(codingFolderViewSaved(undefined)).toBe(false);
	});

	it.each(["unanswered", "denied", "unreadable", "run_ended", "stopped", "invalid", "unproven"])(
		"passes on reads %s, which hold the output back",
		async (reads) => {
			const f = await control(reply(boundary({ reads, views: [] })));
			expect(await f.client.boundary(MACHINE, [], signal())).toEqual({ machine: MACHINE, reads, views: [] });
		},
	);

	it("says a machine restarted", async () => {
		const f = await control(reply({ restarted: { machine: MACHINE } }));
		await expect(f.client.restarted(MACHINE, signal())).resolves.toBeUndefined();
		expect(f.requests).toEqual([`${JSON.stringify({ op: "restarted", machine: MACHINE })}\n`]);
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
