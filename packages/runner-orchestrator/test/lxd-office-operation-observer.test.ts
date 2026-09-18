import { chmod, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdOperationState, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { runOfficeLifecycleLoops } from "../src/lxd-office-lifecycle-service.ts";
import { observeLxdOfficeOperationJournals } from "../src/lxd-office-operation-observer.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const roots: string[] = [];
const signal = () => new AbortController().signal;
function binding(): LxdOfficeGuestBinding {
	return {
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		allocationId: id(5),
		project: "offices",
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	};
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(now?: () => Date) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-journal-")));
	roots.push(root);
	await chmod(root, 0o700);
	const config = binding();
	const plan = lxdOfficeGuestPlan(config);
	let counter = 100;
	const client = {
		submitInstanceOperation: vi.fn(
			async (project: string, _action: LxdTrackedInstanceAction, _signal: AbortSignal) => ({
				project,
				instanceName: plan.request.name,
				operationId: id(counter++),
			}),
		),
		inspectInstanceOperation: vi.fn(async (): Promise<LxdOperationState> => "pending"),
	};
	const reopen = () => LxdOfficeOperationJournal.open(root, id(6), config, client, false, now);
	const journal = await reopen();
	const path = join(root, config.allocationId);
	const events = async () =>
		Promise.all(
			(await readdir(path))
				.filter((name) => /^\d{6}\.json$/.test(name))
				.sort()
				.map(async (name) => JSON.parse(await readFile(join(path, name), "utf8"))),
		);
	return { root, path, config, plan, client, journal, reopen, events };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("independent VM terminal observation", () => {
	it.each(["succeeded", "failed"] as const)(
		"retains %s exactly once with concurrent worker reconciliation",
		async (state) => {
			const f = await fixture();
			await f.journal.reconcile(id(10), "delete", signal());
			const both = latch();
			let entered = 0;
			f.client.inspectInstanceOperation.mockImplementation(async () => {
				if (++entered === 2) both.release();
				await both.promise;
				return state;
			});
			await Promise.all([
				observeLxdOfficeOperationJournals(f.root, f.client, signal()),
				f.journal.reconcile(id(10), "delete", signal()),
			]);
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted", "settled"]);
			const before = await f.events();
			const calls = f.client.inspectInstanceOperation.mock.calls.length;
			await observeLxdOfficeOperationJournals(f.root, f.client, signal());
			await expect((await f.reopen()).reconcile(id(10), "delete", signal())).resolves.toMatchObject({ state });
			expect(await f.events()).toEqual(before);
			expect(f.client.inspectInstanceOperation).toHaveBeenCalledTimes(calls);
			expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps an accepted missing operation unknown across observer and process recovery", async () => {
		const f = await fixture();
		await f.journal.reconcile(id(10), "delete", signal());
		f.client.inspectInstanceOperation.mockRejectedValue(new Error("404 operation not found"));
		await observeLxdOfficeOperationJournals(f.root, f.client, signal());
		await expect((await f.reopen()).reconcile(id(10), "delete", signal())).resolves.toMatchObject({
			state: "unknown",
		});
		expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted"]);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("never creates a missing journal or inspects an empty or dispatch-only journal", async () => {
		const f = await fixture();
		await observeLxdOfficeOperationJournals(f.root, f.client, signal());
		f.client.submitInstanceOperation.mockRejectedValue(new Error("lost response"));
		await f.journal.reconcile(id(10), "delete", signal());
		await observeLxdOfficeOperationJournals(f.root, f.client, signal());
		await expect(
			LxdOfficeOperationJournal.observeExisting(f.root, id(99), f.client.inspectInstanceOperation, signal()),
		).rejects.toThrow();
		expect(await readdir(f.root)).toEqual([id(5)]);
		expect(f.client.inspectInstanceOperation).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it.each(["authority", "chain", "symlink"])("refuses untrusted %s without provider calls", async (kind) => {
		const f = await fixture();
		await f.journal.reconcile(id(10), "delete", signal());
		f.client.inspectInstanceOperation.mockClear();
		if (kind === "symlink") {
			await symlink(f.path, join(f.root, id(99)));
			await rm(join(f.path, "authority.json"));
		} else {
			const path = join(f.path, kind === "authority" ? "authority.json" : "000001.json");
			await chmod(path, 0o600);
			const value = JSON.parse(await readFile(path, "utf8"));
			if (kind === "authority") value.binding.allocationId = id(99);
			else value.previousSha256 = "0".repeat(64);
			await writeFile(path, JSON.stringify(value), { mode: 0o600 });
		}
		await expect(observeLxdOfficeOperationJournals(f.root, f.client, signal())).rejects.toThrow();
		expect(f.client.inspectInstanceOperation).not.toHaveBeenCalled();
	});
	it("aborts before scanning without creating or querying anything", async () => {
		const f = await fixture();
		await f.journal.reconcile(id(10), "delete", signal());
		f.client.inspectInstanceOperation.mockClear();
		const stop = new AbortController();
		stop.abort();
		const before = await f.events();
		await expect(observeLxdOfficeOperationJournals(f.root, f.client, stop.signal)).rejects.toThrow();
		expect(await f.events()).toEqual(before);
		expect(f.client.inspectInstanceOperation).not.toHaveBeenCalled();
	});
	it("captures within retention while cloud and guest control siblings are stalled, then awaits shutdown", async () => {
		const f = await fixture();
		await f.journal.reconcile(id(10), "delete", signal());
		const stop = new AbortController(),
			cloud = latch(),
			control = latch(),
			captured = latch();
		let polls = 0;
		const began = Date.now();
		f.client.inspectInstanceOperation.mockImplementation(async () => {
			if (Date.now() - began > 5000) throw new Error("operation expired");
			return ++polls === 1 ? "pending" : "succeeded";
		});
		const lifecycle = {
			reconcile: vi.fn(async () => {
				await cloud.promise;
				return { state: "idle" as const };
			}),
			observeControlOperations: vi.fn(async () => {
				await control.promise;
			}),
			observeVmOperations: vi.fn(async (checked: AbortSignal) => {
				await observeLxdOfficeOperationJournals(f.root, f.client, checked);
				if ((await f.events()).at(-1)?.kind === "settled") captured.release();
			}),
		};
		let ended = false;
		const running = runOfficeLifecycleLoops(lifecycle, stop.signal, 60000, () => {}).finally(() => {
			ended = true;
		});
		try {
			await captured.promise;
			expect(polls).toBe(2);
			expect(lifecycle.reconcile).toHaveBeenCalledTimes(1);
			expect(lifecycle.observeControlOperations).toHaveBeenCalledTimes(1);
			stop.abort();
			await tick();
			expect(ended).toBe(false);
			cloud.release();
			control.release();
			await running;
			const calls = polls;
			await tick();
			expect(polls).toBe(calls);
			expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
			expect((await f.events()).at(-1)).toMatchObject({ state: "succeeded" });
		} finally {
			stop.abort();
			cloud.release();
			control.release();
			await running;
		}
	});
});
