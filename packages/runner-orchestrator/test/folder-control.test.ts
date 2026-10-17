import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderControlError, parseMachineBoundary, UnixFolderControl } from "../src/folder-control.ts";

let directory = "";
let server: Server | undefined;
afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

/** A control socket that answers each request line with what `answer` gives (undefined: it ends without one). */
async function serve(answer: (request: Record<string, unknown>, socket: Socket) => string | undefined) {
	directory = await mkdtemp(join(tmpdir(), "folder-control-"));
	const path = join(directory, "control.sock");
	const requests: Record<string, unknown>[] = [];
	server = createServer({ allowHalfOpen: true }, (socket) => {
		let text = "";
		socket.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			const newline = text.indexOf("\n");
			if (newline === -1) return;
			const request = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
			requests.push(request);
			const line = answer(request, socket);
			if (line === undefined) socket.end();
			else socket.end(`${line}\n`);
		});
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server?.listen(path, resolve));
	return { control: new UnixFolderControl(path), requests, path };
}
const signal = () => new AbortController().signal;

describe("the folder service's control socket client (F3 6d)", () => {
	it("asks each of the four requests on its own connection, and checks each answer", async () => {
		const machine = randomUUID();
		const commandId = randomUUID();
		const viewId = randomUUID();
		const window = { commandId, runId: randomUUID(), staffAgentId: randomUUID(), requestedByUserId: randomUUID() };
		const { control, requests } = await serve((request) => {
			if (request.op === "restarted") return JSON.stringify({ restarted: { machine } });
			if (request.op === "open") return JSON.stringify({ opened: { machine, commandId } });
			return JSON.stringify({
				boundary: {
					machine,
					reads: request.op === "close" ? "unanswered" : "released",
					views: [{ viewId, report: { paths: [] } }],
				},
			});
		});
		expect(await control.boundary(machine, [viewId], signal())).toEqual({
			machine,
			reads: "released",
			views: [{ viewId, report: { paths: [] } }],
		});
		await control.restarted(machine, signal());
		await control.openWindow(machine, window, signal());
		expect(await control.closeWindow(machine, commandId, signal())).toMatchObject({ reads: "unanswered" });
		expect(requests).toEqual([
			{ op: "boundary", machine, final: [viewId] },
			{ op: "restarted", machine },
			{ op: "open", machine, ...window },
			{ op: "close", machine, commandId },
		]);
	});

	it("throws the service's error as an answer, and a view's error stays in its boundary", async () => {
		const machine = randomUUID();
		const viewId = randomUUID();
		let line = JSON.stringify({ error: { code: "UNAVAILABLE", message: "The service is stopping" } });
		const { control } = await serve(() => line);
		const failed = control.closeWindow(machine, randomUUID(), signal());
		await expect(failed).rejects.toBeInstanceOf(FolderControlError);
		await expect(failed).rejects.toMatchObject({ code: "UNAVAILABLE", message: "FOLDER_CONTROL_UNAVAILABLE" });
		line = JSON.stringify({
			boundary: { machine, reads: "unproven", views: [{ viewId, error: { code: "VIEW_CLOSED", message: "gone" } }] },
		});
		expect(await control.boundary(machine, [viewId], signal())).toEqual({
			machine,
			reads: "unproven",
			views: [{ viewId, error: { code: "VIEW_CLOSED", message: "gone" } }],
		});
	});

	it("refuses an answer that is not the one asked, or not its shape", async () => {
		const machine = randomUUID();
		const viewId = randomUUID();
		const boundary = { machine, reads: "released", views: [] as unknown[] };
		const bad = [
			"not json",
			JSON.stringify([]),
			JSON.stringify({ opened: { machine, commandId: randomUUID() } }),
			JSON.stringify({ boundary, restarted: { machine } }),
			JSON.stringify({ boundary: { ...boundary, machine: randomUUID() } }),
			JSON.stringify({ boundary: { ...boundary, reads: "maybe" } }),
			JSON.stringify({ boundary: { ...boundary, extra: 1 } }),
			JSON.stringify({ boundary: { ...boundary, views: [{ viewId: "view" }] } }),
			JSON.stringify({ boundary: { ...boundary, views: [{ viewId, report: {}, error: {} }] } }),
			JSON.stringify({ boundary: { ...boundary, views: [{ viewId, error: { code: "ODD", message: "x" } }] } }),
			JSON.stringify({ error: { code: "UNAVAILABLE" } }),
		];
		const answers = [...bad];
		const { control } = await serve(() => answers.shift());
		for (const _ of bad)
			await expect(control.boundary(machine, [], signal())).rejects.toThrow("FOLDER_CONTROL_ANSWER_INVALID");
		// The answers of the other requests are checked the same way. A restart's `dropped` (F3 5g-5) is not read here,
		// but it is a boolean, and nothing else comes with it.
		for (const restarted of [
			{ machine: randomUUID() },
			{ machine, dropped: "yes" },
			{ machine, dropped: false, at: 1 },
		]) {
			answers.push(JSON.stringify({ restarted }));
			await expect(control.restarted(machine, signal())).rejects.toThrow("FOLDER_CONTROL_ANSWER_INVALID");
		}
		for (const dropped of [true, false]) {
			answers.push(JSON.stringify({ restarted: { machine, dropped } }));
			await expect(control.restarted(machine, signal())).resolves.toBeUndefined();
		}
		answers.push(JSON.stringify({ opened: { machine, commandId: randomUUID() } }));
		const window = { commandId: randomUUID(), runId: viewId, staffAgentId: viewId, requestedByUserId: viewId };
		await expect(control.openWindow(machine, window, signal())).rejects.toThrow("FOLDER_CONTROL_ANSWER_INVALID");
		const views = Array.from({ length: 1025 }, () => ({ viewId, report: {} }));
		expect(() => parseMachineBoundary({ ...boundary, views }, machine)).toThrow("FOLDER_CONTROL_ANSWER_INVALID");
	});

	it("is unanswered when the service ends without an answer, is not there, or the signal ends the wait", async () => {
		const machine = randomUUID();
		const { control, path } = await serve(() => undefined);
		await expect(control.boundary(machine, [], signal())).rejects.toThrow("FOLDER_CONTROL_UNANSWERED");
		// A service that never answers: the caller's signal ends the wait.
		const held: Socket[] = [];
		server?.removeAllListeners("connection");
		server?.on("connection", (socket: Socket) => {
			held.push(socket);
			socket.on("error", () => undefined);
		});
		const waited = control.boundary(machine, [], AbortSignal.timeout(200));
		await expect(waited).rejects.toThrow("FOLDER_CONTROL_UNANSWERED");
		const aborted = new AbortController();
		aborted.abort();
		await expect(control.restarted(machine, aborted.signal)).rejects.toThrow("FOLDER_CONTROL_UNANSWERED");
		// The silent stand-in keeps its half of that connection open, so the server could not close: end it here.
		for (const socket of held) socket.destroy();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
		await expect(new UnixFolderControl(path).restarted(machine, signal())).rejects.toThrow(
			"FOLDER_CONTROL_UNANSWERED",
		);
	});

	it("never sends a request that is not well formed", async () => {
		const machine = randomUUID();
		const { control, requests } = await serve(() => JSON.stringify({ restarted: { machine } }));
		await expect(control.boundary("machine", [], signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		await expect(control.boundary(machine, ["view"], signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		const final = Array.from({ length: 257 }, () => randomUUID());
		await expect(control.boundary(machine, final, signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		const window = { commandId: randomUUID(), runId: "run", staffAgentId: machine, requestedByUserId: machine };
		await expect(control.openWindow(machine, window, signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		await expect(control.closeWindow(machine, "command", signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		await expect(control.restarted("machine", signal())).rejects.toThrow("FOLDER_CONTROL_REQUEST_INVALID");
		expect(requests).toEqual([]);
		expect(() => new UnixFolderControl("run/control.sock")).toThrow("FOLDER_CONTROL_CONFIGURATION_INVALID");
	});
});
