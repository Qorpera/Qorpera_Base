import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
	askCompanyComputerFolderHelper,
	CompanyComputerFolderRequest,
} from "@qorpera/runtime/cloud-company-computer-folder-helper-client";
import { publishCompanyComputerFoldersLeft } from "@qorpera/runtime/cloud-company-computer-service-stop-folders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerDeferred, computerId } from "./fixtures/company-computer.ts";

const desktop = `desktop-${computerId(1)}`;
const command = `command-${computerId(2)}`;
const report = { commitId: "commit-1", seq: 3, paths: [] };
const refusal = (refused: string) => ({ answer: "refused", report: { commitId: null, seq: null, paths: [], refused } });
const mount = (name: string) => ({ name, viewId: computerId(9), program: "running" });

let directory: string;
let socket: string;
let server: Server;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "stop-folders-"));
	socket = join(directory, "helper.sock");
	server = createServer();
	await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
});

/** The folder helper: `list` answers the mounts, and each other request the answer queued for its op and name (a
 * function is called for it). */
function helper(mounts: string[]) {
	const asked: CompanyComputerFolderRequest[] = [];
	const options: Array<{ socket?: string; timeoutMs?: number; signal?: AbortSignal }> = [];
	const queued = new Map<string, unknown[]>();
	const ask = vi.fn(async (request: CompanyComputerFolderRequest, given: (typeof options)[number] = {}) => {
		asked.push(request);
		options.push(given);
		if (request.op === "list") return { answer: "list", mounts: mounts.map(mount) };
		const next = queued.get(`${request.op} ${"name" in request ? request.name : ""}`)?.shift();
		return typeof next === "function" ? next() : next;
	});
	const answer = (op: string, name: string, ...answers: unknown[]) => {
		queued.set(`${op} ${name}`, [...(queued.get(`${op} ${name}`) ?? []), ...answers]);
	};
	const ops = () => asked.map((request) => `${request.op}${"name" in request ? ` ${request.name}` : ""}`);
	return { ask: ask as unknown as typeof askCompanyComputerFolderHelper, asked, options, answer, ops };
}

const publish = (
	h: ReturnType<typeof helper>,
	until = performance.now() + 60000,
	signal = new AbortController().signal,
) => publishCompanyComputerFoldersLeft(signal, until, { socket, ask: h.ask });

describe("the stop control's mounts left", () => {
	it("asks every mount's boundary at once, a command's as its final one, and drops a mount a final answer left", async () => {
		const h = helper([desktop, command]);
		const first = computerDeferred<unknown>();
		h.answer("unmount", desktop, () => first.promise);
		h.answer("unmount", command, { answer: "closed", unmounted: false });
		h.answer("drop", command, { answer: "dropped" });
		const until = performance.now() + 60000;
		const done = publish(h, until);
		await vi.waitFor(() =>
			expect(h.ops()).toEqual(["list", `unmount ${desktop}`, `unmount ${command}`, `drop ${command}`]),
		);
		first.resolve({ answer: "saved", report, unmounted: true });
		await done;
		expect(h.ops()).toEqual(["list", `unmount ${desktop}`, `unmount ${command}`, `drop ${command}`]);
		expect(h.asked[1]).toMatchObject({ op: "unmount", name: desktop, final: false });
		expect(h.asked[2]).toMatchObject({ op: "unmount", name: command, final: true });
		for (const index of [1, 2]) {
			const { timeoutMs } = h.asked[index] as { timeoutMs: number };
			// The boundary leaves 10 s of the run's time for the unmount after it and a drop.
			expect(timeoutMs).toBeGreaterThan(49000);
			expect(timeoutMs).toBeLessThanOrEqual(50000);
			expect(h.options[index]?.timeoutMs).toBeGreaterThan(timeoutMs + 9000);
			expect(h.options[index]?.timeoutMs).toBeLessThanOrEqual(timeoutMs + 10000);
		}
		expect(h.options.every((given) => given.socket === socket)).toBe(true);
		expect(h.options[0]?.timeoutMs).toBe(10000);
	});

	it("gives a boundary at most the helper's maximum", async () => {
		const h = helper([desktop]);
		h.answer("unmount", desktop, { answer: "saved", report, unmounted: true });
		await publish(h, performance.now() + 300000);
		expect(h.asked[1]).toMatchObject({ timeoutMs: 120000 });
	});

	it.each([
		["the pause", refusal("stopped")],
		["rule 4", refusal("unproven")],
		["a denied read", refusal("denied")],
		["some paths", { answer: "refused", report: { ...report, paths: [{ path: "a", outcome: "refused" }] } }],
		["a saved boundary whose mount stayed", { answer: "saved", report }],
	])("takes %s as the mount's final answer, and drops what it left", async (_, answer) => {
		const h = helper([command]);
		h.answer("unmount", command, { ...answer, unmounted: false });
		h.answer("drop", command, { answer: "unknown" });
		await publish(h);
		expect(h.ops()).toEqual(["list", `unmount ${command}`, `drop ${command}`]);
	});

	it("takes a mount the helper no longer has as gone", async () => {
		const h = helper([desktop]);
		h.answer("unmount", desktop, { answer: "unknown" });
		await publish(h);
		expect(h.ops()).toEqual(["list", `unmount ${desktop}`]);
	});

	it.each([
		["no answer", undefined],
		["a malformed answer", { answer: "invalid" }],
		["an unanswered boundary (QRC01)", { answer: "unanswered", unmounted: false }],
		["the run check", { ...refusal("run_ended"), unmounted: false }],
	])("fails on %s, once every other mount was asked, and drops nothing of it", async (_, answer) => {
		const h = helper([command, desktop]);
		h.answer("unmount", command, answer);
		h.answer("unmount", desktop, { answer: "closed", unmounted: false });
		h.answer("drop", desktop, { answer: "dropped" });
		await expect(publish(h)).rejects.toThrow("OFFICE_FOLDERS_LEFT_UNPUBLISHED");
		expect(h.ops()).toEqual(["list", `unmount ${command}`, `unmount ${desktop}`, `drop ${desktop}`]);
	});

	it.each([
		["failed", { answer: "failed" }],
		["no answer", undefined],
	])("fails when a drop is answered %s", async (_, answer) => {
		const h = helper([desktop]);
		h.answer("unmount", desktop, { ...refusal("stopped"), unmounted: false });
		h.answer("drop", desktop, answer);
		await expect(publish(h)).rejects.toThrow("OFFICE_FOLDERS_LEFT_UNPUBLISHED");
	});

	it.each([
		["failed", { answer: "failed" }],
		["no answer", undefined],
	])("fails when the list is answered %s, asking nothing else", async (_, answer) => {
		const ask = vi.fn(async () => answer);
		await expect(
			publishCompanyComputerFoldersLeft(new AbortController().signal, performance.now() + 60000, {
				socket,
				ask: ask as unknown as typeof askCompanyComputerFolderHelper,
			}),
		).rejects.toThrow("OFFICE_FOLDERS_LEFT_UNLISTED");
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("does nothing when no mount is left", async () => {
		const h = helper([]);
		await publish(h);
		expect(h.ops()).toEqual(["list"]);
	});

	it("fails without asking when too little of the run is left for a boundary of a second", async () => {
		const h = helper([desktop]);
		await expect(publish(h, performance.now() + 10500)).rejects.toThrow("OFFICE_FOLDERS_LEFT_LATE");
		expect(h.asked).toEqual([]);
	});

	it("fails on the run's abort", async () => {
		const h = helper([desktop]);
		const stop = new AbortController();
		h.answer("unmount", desktop, () => {
			stop.abort();
			return undefined;
		});
		await expect(publish(h, performance.now() + 60000, stop.signal)).rejects.toThrow();
		expect(h.options[1]?.signal).toBe(stop.signal);
	});

	it("asks nothing on an image without the helper, and refuses a socket path that is not a socket", async () => {
		const h = helper([desktop]);
		await publishCompanyComputerFoldersLeft(new AbortController().signal, performance.now() + 60000, {
			socket: join(directory, "absent.sock"),
			ask: h.ask,
		});
		const file = join(directory, "file.sock");
		await writeFile(file, "");
		await expect(
			publishCompanyComputerFoldersLeft(new AbortController().signal, performance.now() + 60000, {
				socket: file,
				ask: h.ask,
			}),
		).rejects.toThrow("OFFICE_FOLDER_HELPER_UNCONFIRMED");
		expect(h.asked).toEqual([]);
	});
});
