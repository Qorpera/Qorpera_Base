import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeLxdOfficeControlJournals } from "../src/lxd-office-control-observer.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";
import { officeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const f = await officeStopWorkerFixture(roots);
	let now = 100000;
	let count = 0;
	const submit = f.exec.getMockImplementation()!;
	f.exec.mockImplementation(async (...args) => ({ ...(await submit(...args)), operationId: id(1000 + count++) }));
	f.state.physical = false;
	const suffix = `${f.binding.allocationId}-${f.request.transitionId}`;
	const record = join(f.root, `service-stop-retries-${suffix}.json`);
	const retry = (attempt: number) => join(f.root, `service-stop-retry-${suffix}-${attempt}`);
	const run = () => f.create(() => now).reconcile(f.activation.request.intentId, f.request, signal());
	return {
		...f,
		run,
		record,
		retry,
		advance: (ms: number) => {
			now += ms;
		},
		schedule: async () => JSON.parse(await readFile(record, "utf8")),
	};
}

describe("durable provider stop retries", () => {
	it("waits across provider replacement, then retries the same command and acknowledges its completion", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("failed");
		await expect(f.run()).resolves.toMatchObject({ state: "failed" });
		f.advance(29999);
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(1);
		f.advance(1);
		f.state.physical = true;
		f.poll.mockResolvedValue("succeeded");
		await expect(f.run()).resolves.toMatchObject({ state: "stopped" });
		expect(f.exec).toHaveBeenCalledTimes(2);
		expect(f.exec.mock.calls[1][2]).toEqual(f.exec.mock.calls[0][2]);
		expect(f.state.acknowledgements).toBe(1);
		expect(f.inspect).toHaveBeenCalledOnce();
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(2);
	});

	it("does not retry a pending invocation even after the longest delay", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("pending");
		await expect(f.run()).resolves.toMatchObject({ state: "pending" });
		f.advance(1200000);
		await expect(f.run()).resolves.toMatchObject({ state: "pending" });
		expect(f.exec).toHaveBeenCalledOnce();
		await expect(readFile(f.record)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["accepted", "submission"] as const)(
		"retries a forgotten %s result without inferring success",
		async (kind) => {
			const f = await fixture();
			const submit = f.exec.getMockImplementation()!;
			if (kind === "submission")
				f.exec.mockImplementationOnce(async (...args) => {
					await submit(...args);
					throw new Error("reply lost");
				});
			f.poll.mockRejectedValue(new Error("operation expired"));
			await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
			f.advance(30000);
			await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
			expect(f.exec).toHaveBeenCalledTimes(2);
			expect(f.state.acknowledgements).toBe(0);
		},
	);

	it("doubles backoff up to ten minutes and retains only the initial and latest retry directories", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("failed");
		await f.run();
		for (let attempt = 1; attempt <= 9; attempt++) {
			const delay = Math.min(30000 * 2 ** (attempt - 1), 600000);
			f.advance(delay - 1);
			await f.run();
			expect(f.exec).toHaveBeenCalledTimes(attempt);
			f.advance(1);
			await f.run();
			expect(f.exec).toHaveBeenCalledTimes(attempt + 1);
			const directories = (await readdir(f.root, { withFileTypes: true })).filter(
				(entry) => entry.isDirectory() && entry.name.startsWith("service-stop-"),
			);
			expect(directories.map((entry) => entry.name).sort()).toEqual(
				[f.names.journal.split("/").at(-1), f.retry(attempt).split("/").at(-1)].sort(),
			);
			expect(await f.schedule()).toMatchObject({ attempt, phase: "active" });
		}
		expect(f.state.acknowledgements).toBe(0);
	});

	it("the independent observer retains retry failure before LXD forgets it", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("failed").mockResolvedValue("pending");
		await f.run();
		f.advance(30000);
		await expect(f.run()).resolves.toMatchObject({ state: "pending" });
		await observeLxdOfficeControlJournals(f.root, { inspectOfficePreparation: async () => "failed" }, signal());
		const terminal = JSON.parse(await readFile(join(f.retry(1), "000002.json"), "utf8"));
		expect(terminal).toMatchObject({ kind: "settled", state: "failed", operationId: id(1001) });
		f.poll.mockRejectedValue(new Error("operation forgotten after five seconds"));
		await expect(f.run()).resolves.toMatchObject({ state: "failed" });
		f.advance(60000);
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(3);
	});

	it("treats a retry removed during the observer's pass as gone", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("failed").mockResolvedValue("pending");
		await f.run();
		f.advance(30000);
		await f.run();
		await expect(
			observeLxdOfficeControlJournals(
				f.root,
				{
					inspectOfficePreparation: async (reference) => {
						if (reference.operationId === id(1001)) await rm(f.retry(1), { recursive: true });
						return "failed";
					},
				},
				signal(),
			),
		).resolves.toBeUndefined();
	});

	it.each(["record", "journal", "authority", "attempt", "identity"] as const)(
		"refuses lost or altered %s without another dispatch",
		async (fault) => {
			const f = await fixture();
			f.poll.mockResolvedValue("failed");
			await f.run();
			f.advance(30000);
			await f.run();
			if (fault === "record") await rm(f.record);
			else if (fault === "journal") await rm(f.retry(1), { recursive: true });
			else if (fault === "authority") await rm(join(f.retry(1), "authority.json"));
			else {
				const record = await f.schedule();
				if (fault === "attempt") record.attempt = 0;
				else record.identitySha256 = "f".repeat(64);
				await writeFile(f.record, JSON.stringify(record), { mode: 0o600 });
			}
			f.advance(600000);
			await expect(f.run()).rejects.toThrow("OFFICE_STOP_UNCONFIRMED");
			expect(f.exec).toHaveBeenCalledTimes(2);
		},
	);

	it("recovers a reserved retry after a crash before journal creation", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("failed");
		await f.run();
		const record = await f.schedule();
		await writeFile(f.record, JSON.stringify({ ...record, attempt: 1, phase: "creating", retryAtMs: null }), {
			mode: 0o600,
		});
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(2);
		expect(await f.schedule()).toMatchObject({ attempt: 1, phase: "active" });
	});

	it("refuses unsafe retry record custody", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("failed");
		await f.run();
		await chmod(f.record, 0o644);
		f.advance(30000);
		await expect(f.run()).rejects.toThrow("OFFICE_STOP_UNCONFIRMED");
		expect(f.exec).toHaveBeenCalledOnce();
	});

	it.each(["empty", "temporary", "authority"] as const)(
		"recovers a crash while staging %s retry authority",
		async (fault) => {
			const f = await fixture();
			f.poll.mockResolvedValue("failed");
			await f.run();
			const record = await f.schedule();
			await writeFile(f.record, JSON.stringify({ ...record, attempt: 1, phase: "creating", retryAtMs: null }), {
				mode: 0o600,
			});
			const staging = join(f.root, `.creating-${basename(f.retry(1))}`);
			await mkdir(staging, { mode: 0o700 });
			if (fault !== "empty")
				await writeFile(
					join(staging, fault === "authority" ? "authority.json" : `.write-${id(2000)}`),
					"partial interrupted publication",
					{ mode: 0o600 },
				);
			await f.run();
			expect(f.exec).toHaveBeenCalledTimes(2);
			expect(f.exec.mock.calls[1][2]).toEqual(f.exec.mock.calls[0][2]);
			expect(await f.schedule()).toMatchObject({ attempt: 1, phase: "active" });
			expect((await readdir(f.root)).some((name) => name.startsWith(".creating-"))).toBe(false);
			await f.run();
			expect(f.exec).toHaveBeenCalledTimes(2);
		},
	);

	it("resumes interrupted retirement without requiring already-removed journal files", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("failed");
		await f.run();
		f.advance(30000);
		await f.run();
		const record = await f.schedule();
		await writeFile(f.record, JSON.stringify({ ...record, attempt: 2, phase: "creating", retryAtMs: null }), {
			mode: 0o600,
		});
		const retired = join(f.root, `.retired-${basename(f.retry(1))}`);
		await rename(f.retry(1), retired);
		await rm(join(retired, "authority.json"));
		await rm(join(retired, "000001.json"));
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(3);
		expect(f.exec.mock.calls[2][2]).toEqual(f.exec.mock.calls[0][2]);
		expect(await f.schedule()).toMatchObject({ attempt: 2, phase: "active" });
		const directories = (await readdir(f.root, { withFileTypes: true })).filter(
			(entry) => entry.isDirectory() && entry.name.includes("service-stop-"),
		);
		expect(directories.map((entry) => entry.name).sort()).toEqual(
			[basename(f.names.journal), basename(f.retry(2))].sort(),
		);
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(3);
	});

	it("starts a retry's backoff when its long-running invocation fails", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("failed").mockResolvedValue("pending");
		await f.run();
		f.advance(30000);
		await f.run();
		f.advance(600000);
		await expect(f.run()).resolves.toMatchObject({ state: "pending" });
		f.poll.mockResolvedValue("failed");
		await expect(f.run()).resolves.toMatchObject({ state: "failed" });
		expect(f.exec).toHaveBeenCalledTimes(2);
		f.advance(59999);
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(2);
		f.advance(1);
		await f.run();
		expect(f.exec).toHaveBeenCalledTimes(3);
	});
});
