import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdInstanceRecord, LxdUnixClient } from "../src/lxd-client.ts";
import { openLxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficeInventoryWorker } from "../src/lxd-office-inventory-worker.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import {
	type OfficeInventoryLimits,
	type OfficeInventorySource,
	type OfficeStorageInventory,
	parseOfficeInventoryLimits,
} from "../src/lxd-office-storage-inventory.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";
import { pluggedOfficeRequest, testAgentMac } from "./helpers/agent-plug.ts";

const intentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hostBootId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const limits = { maxEntries: 100, maxDepth: 8, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 };
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(create: "succeeded" | "pending" | "failed" | null = "succeeded") {
	const { policy } = officePhysicalFixture();
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-inventory-")));
	roots.push(root);
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	const client = new LxdUnixClient("/unused-inventory-fixture.socket");
	const submit = vi.spyOn(client, "submitInstanceOperation").mockImplementation(async (project, action) => ({
		project,
		instanceName: action.action === "create" ? action.request.name : action.name,
		operationId,
	}));
	vi.spyOn(client, "inspectInstanceOperation").mockResolvedValue(create ?? "pending");
	const identity = await openLxdOfficeCreationIdentity(policy, intentId, false, client, signal());
	const journal = await LxdOfficeOperationJournal.open(root, intentId, identity.binding, client, true);
	if (create) await journal.reconcile(identity.createCommandId, "create", signal(), testAgentMac);
	submit.mockClear();
	const request = pluggedOfficeRequest(identity.binding);
	const instance: LxdInstanceRecord = {
		name: request.name,
		type: "virtual-machine",
		status: "Stopped",
		statusCode: 102,
		profiles: [],
		config: { ...request.config, "volatile.base_image": policy.guest.imageFingerprint },
		expandedConfig: { ...request.config, "volatile.base_image": policy.guest.imageFingerprint },
		devices: request.devices,
		expandedDevices: request.devices,
	};
	const get = vi.spyOn(client, "getInstance").mockResolvedValue(instance);
	const call = vi.fn(async (method: string, _args: Record<string, unknown>, checked: AbortSignal) => {
		checked.throwIfAborted();
		expect(method).toBe("qorpera_check_runtime_office_start");
		return { state: "authorized", intentId, computerGeneration: 1, validForMs: 5000 };
	});
	const check = vi.fn(async () => ({ signal: signal(), hostBootId, validForMs: 5000 }));
	const inventory: OfficeStorageInventory = {
		schema: "qorpera.office-storage-inventory/v1",
		root: policy.workbench.mountPoint,
		mountId: "111",
		entries: [],
		totalBytes: 0,
	};
	const inspect = vi.fn(
		async (_source: OfficeInventorySource, _limits: OfficeInventoryLimits, checked: AbortSignal) => {
			checked.throwIfAborted();
			return inventory;
		},
	);
	const worker = () => new LxdOfficeInventoryWorker({ policy, check }, { call }, limits, client, inspect);
	return { root, policy, identity, journal, client, get, submit, instance, call, check, inspect, inventory, worker };
}

describe("provider office storage observations", () => {
	it("records a repeatable private observation tied to the durable allocation without dispatching or activating", async () => {
		const f = await fixture();
		const first = await f.worker().inspect(intentId, signal());
		expect(first.observation).toMatchObject({
			intentId,
			allocationId: f.identity.binding.allocationId,
			hostBootId,
			inventory: f.inventory,
		});
		expect(officeDigest(first.observation)).toBe(first.observationSha256);
		expect((await readRecord(first.evidencePath, 65536)).value).toEqual(first.observation);
		expect(await f.worker().inspect(intentId, signal())).toEqual(first);
		expect(f.inspect).toHaveBeenCalledWith(
			{
				root: f.policy.workbench.mountPoint,
				uid: 1000,
				gid: 1000,
				mount: f.policy.workbench,
				serverAddress: f.policy.workbench.serverAddress,
			},
			limits,
			expect.any(AbortSignal),
		);
		expect(f.get).toHaveBeenCalledTimes(6);
		expect(f.submit).not.toHaveBeenCalled();
		expect(await readFile(first.evidencePath, "utf8")).not.toContain("adoption/v1");
	});
	it.each([null, "pending", "failed"] as const)("requires completed creation, rejecting %s", async (state) => {
		const f = await fixture(state);
		await expect(f.worker().inspect(intentId, signal())).rejects.toThrow("OFFICE_INVENTORY_CREATION_UNCONFIRMED");
		expect(f.inspect).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("cannot mint a new allocation when the intent identity is missing", async () => {
		const f = await fixture();
		await expect(f.worker().inspect(operationId, signal())).rejects.toThrow("OFFICE_CREATION_JOURNAL_MISSING");
		expect(f.inspect).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it.each(["running", "missing", "drift", "revoked", "physical"])(
		"refuses inventory before reading NAS: %s",
		async (reason) => {
			const f = await fixture();
			if (reason === "running") f.instance.status = "Running";
			if (reason === "missing") f.get.mockResolvedValue(undefined);
			if (reason === "drift") f.instance.expandedDevices = {};
			if (reason === "revoked") f.call.mockRejectedValue(new Error("revoked"));
			if (reason === "physical") f.check.mockRejectedValue(new Error("physical"));
			await expect(f.worker().inspect(intentId, signal())).rejects.toThrow();
			expect(f.inspect).not.toHaveBeenCalled();
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it.each(["running", "reboot", "revoked", "physical", "start-dispatch"])(
		"withholds the observation after a changed boundary: %s",
		async (reason) => {
			const f = await fixture();
			f.inspect.mockImplementationOnce(async () => {
				if (reason === "running") f.instance.status = "Running";
				if (reason === "reboot")
					f.check.mockResolvedValue({ signal: signal(), hostBootId: operationId, validForMs: 5000 });
				if (reason === "revoked") f.call.mockRejectedValue(new Error("revoked"));
				if (reason === "physical") f.check.mockRejectedValue(new Error("physical"));
				if (reason === "start-dispatch") {
					f.submit.mockRejectedValueOnce(new Error("lost reply"));
					await f.journal.reconcile(operationId, "start", signal());
				}
				return f.inventory;
			});
			await expect(f.worker().inspect(intentId, signal())).rejects.toThrow();
		},
	);
	it("requires reviewable evidence to remain intact on repeated inspection", async () => {
		const f = await fixture();
		const first = await f.worker().inspect(intentId, signal());
		await writeFile(first.evidencePath, JSON.stringify({ tampered: true }));
		await expect(f.worker().inspect(intentId, signal())).rejects.toThrow("OFFICE_INVENTORY_EVIDENCE_CHANGED");
	});
	it.each([false, true])("retains an aborted underlying scan until it settles (composed=%s)", async (composed) => {
		const f = await fixture();
		let finish!: (value: OfficeStorageInventory) => void;
		let entered!: () => void;
		const scanning = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.inspect.mockImplementationOnce(() => {
			entered();
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const worker = f.worker();
		const controller = new AbortController();
		const first = composed
			? worker.inspectSettled(intentId, controller.signal)
			: worker.inspect(intentId, controller.signal);
		let finished = false;
		void first
			.finally(() => {
				finished = true;
			})
			.catch(() => {});
		await scanning;
		controller.abort();
		if (composed) {
			await new Promise((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
		} else await expect(first).rejects.toThrow("OFFICE_INVENTORY_WORKER_ABORTED");
		await expect(worker.inspect(intentId, signal())).rejects.toThrow("OFFICE_INVENTORY_WORKER_PENDING");
		finish(f.inventory);
		await expect(first).rejects.toThrow("OFFICE_INVENTORY_WORKER_ABORTED");
		await new Promise((resolve) => setImmediate(resolve));
		expect(await worker.inspect(intentId, signal())).toHaveProperty("observationSha256");
	});
});

describe("bounded inventory policy", () => {
	it("snapshots closed positive integer limits", () => {
		const input = { ...limits };
		const result = parseOfficeInventoryLimits(input);
		input.maxEntries = 1;
		expect(result.maxEntries).toBe(100);
		expect(Object.isFrozen(result)).toBe(true);
	});
	it.each(Object.keys(limits))("rejects invalid %s", (key) => {
		for (const value of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER, null])
			expect(() => parseOfficeInventoryLimits({ ...limits, [key]: value })).toThrow();
	});
	it("rejects unknown fields and a file limit exceeding the aggregate", () => {
		expect(() => parseOfficeInventoryLimits({ ...limits, truncate: true })).toThrow();
		expect(() => parseOfficeInventoryLimits({ ...limits, maxTotalBytes: 1 })).toThrow();
	});
	it("keeps ordinary journal read limits closed unless a bounded inventory size is explicitly supplied", async () => {
		const f = await fixture();
		const path = join(f.root, "large.json");
		await writeFile(path, JSON.stringify({ value: "x".repeat(20000) }), { mode: 0o600 });
		await expect(readRecord(path)).rejects.toThrow("invalid journal record");
		expect((await readRecord(path, 22000)).bytes.length).toBeGreaterThan(20000);
		for (const invalid of [0, -1, 1.5, 17 * 1024 ** 2])
			await expect(readRecord(path, invalid)).rejects.toThrow("INVALID_OFFICE_JOURNAL_RECORD_LIMIT");
	});
});
