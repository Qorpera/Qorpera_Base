import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPlugCard, withAgentPlug } from "../src/agent-plug.ts";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineAdmissionReceipt,
	type CodingMachineIntent,
	type CodingMachineJournalPlan,
	codingMachineStartOperation,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
	reconcileCodingMachine,
} from "../src/coding-machine.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "../src/coding-vm.ts";
import type { LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { testAgentMac, testAgentPlug } from "./helpers/coding-machine.ts";
import { codingStorageFixture } from "./helpers/coding-storage.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const storage = {
	policy: {
		schema: "qorpera.coding-nas-policy/v1" as const,
		mountPoint: "/nas",
		rootPath: "/nas/coding",
		source: "10.0.0.2:/coding",
		serverAddress: "10.0.0.2",
	},
	machineIdSha256: "d".repeat(64),
};
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function binding(): LxdCodingMachineBinding {
	return {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: id(2),
		companyId: id(3),
		environmentId: id(4),
		memberUserId: id(6),
		providerId: "native-node",
		providerPolicySha256: "a".repeat(64),
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding-disks",
		network: "qagent0",
		cpus: 2,
		memoryBytes: 4096 * 1024 ** 2,
		rootDiskBytes: 64 * 1024 ** 3,
	};
}
function receipt(journal: CodingMachineJournalPlan, intent: CodingMachineIntent): CodingMachineAdmissionReceipt {
	return {
		schema: "qorpera.coding-machine-admission/v1",
		machineId: journal.machineId,
		workerId: null,
		instanceSha256: journal.instanceSha256,
		intent,
		guestUid: null,
		validForMs: 5000,
		nodeId: id(5),
		nodeVersion: 1,
	};
}
const receiptFor = (journal: CodingMachineJournalPlan) => async (intent: CodingMachineIntent) =>
	receipt(journal, intent);
/** A fake LXD for one instance, created from `request` and changed by the journal's operations. */
function lxd(project: string, name: string, request: () => LxdInstanceRecord) {
	let instance: LxdInstanceRecord | undefined;
	let pending: LxdTrackedInstanceAction | undefined;
	const client = {
		getInstance: vi.fn(async () => instance),
		submitInstanceOperation: vi.fn(
			async (_project: string, action: LxdTrackedInstanceAction, _signal: AbortSignal) => {
				pending = action;
				return {
					project,
					instanceName: name,
					operationId: id(10 + client.submitInstanceOperation.mock.calls.length),
				};
			},
		),
		inspectInstanceOperation: vi.fn(async (): Promise<"succeeded" | "pending" | "failed"> => {
			if (pending?.action === "create") instance = request();
			else if (pending?.action === "delete") instance = undefined;
			else if (instance && pending) {
				instance.status = pending.action === "start" ? "Running" : "Stopped";
				instance.statusCode = pending.action === "start" ? 103 : 102;
			}
			return "succeeded";
		}),
	};
	return {
		client,
		instance: () => instance,
		set: (value: LxdInstanceRecord | undefined) => {
			instance = value;
		},
	};
}
async function fixture() {
	const journalRoot = await realpath(await mkdtemp(join(tmpdir(), "coding-machine-")));
	await chmod(journalRoot, 0o700);
	roots.push(journalRoot);
	const value = binding();
	const plan = lxdCodingMachinePlan(value);
	const journal = lxdCodingMachineJournalPlan(value, storage);
	// The machine as LXD makes it from the create the plug completed (its agent card's MAC).
	const created = withAgentPlug(plan.request, "network", testAgentMac);
	const fake = lxd(value.project, plan.request.name, () => ({
		name: plan.request.name,
		type: "virtual-machine",
		status: "Stopped",
		statusCode: 102,
		profiles: [],
		devices: structuredClone(created.devices),
		expandedDevices: structuredClone(created.devices),
		config: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
		expandedConfig: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
	}));
	const client = fake.client;
	const plug = vi.fn(testAgentPlug);
	const controller = new AbortController();
	const authorize = vi.fn(receiptFor(journal));
	const options = {
		plan: journal,
		journalRoot,
		desiredState: "running" as const,
		client,
		authorize,
		signal: controller.signal,
		plug,
	};
	return {
		value,
		plan,
		created,
		plug,
		journal,
		client,
		authorize,
		controller,
		journalRoot,
		options,
		reconcile: (desiredState: "running" | "stopped" | "deleted" = "running") =>
			reconcileCodingMachine({ ...options, desiredState }),
		instance: fake.instance,
	};
}

/** The outside stops written next to the machine's journal, oldest first. */
async function outsideStops(f: Awaited<ReturnType<typeof fixture>>) {
	const root = join(f.journalRoot, f.value.machineId);
	const names = (await readdir(root)).filter((name) => name.startsWith("outside-stop-")).sort();
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))));
}

async function retainedHistory(
	f: Awaited<ReturnType<typeof fixture>>,
	count: 381 | 384,
	lastState: "succeeded" | "failed" = "succeeded",
	lastAction?: "start",
) {
	await f.reconcile();
	await f.reconcile();
	await f.reconcile();
	const root = join(f.journalRoot, f.value.machineId);
	let previousSha256 = createHash("sha256")
		.update(await readFile(join(root, "binding.json")))
		.digest("hex");
	for (let sequence = 0; sequence < count; sequence++) {
		const phase = sequence % 3;
		const bytes = Buffer.from(
			`${JSON.stringify({
				sequence,
				previousSha256,
				action:
					sequence < 3
						? "create"
						: lastAction && sequence >= count - 3
							? lastAction
							: Math.floor(sequence / 3) % 2
								? "start"
								: "stop",
				kind: ["dispatch", "accepted", "settled"][phase],
				operationId: phase === 0 ? null : id(1000 + Math.floor(sequence / 3)),
				state: phase === 2 ? (sequence === count - 1 ? lastState : "succeeded") : null,
			})}\n`,
		);
		await writeFile(join(root, `${String(sequence).padStart(6, "0")}.json`), bytes, { mode: 0o600 });
		previousSha256 = createHash("sha256").update(bytes).digest("hex");
	}
	const instance = f.instance();
	if (!instance) throw new Error("missing fixture VM");
	instance.status = count === 381 ? "Stopped" : "Running";
	instance.statusCode = count === 381 ? 102 : 103;
	return root;
}

describe("a coding machine's journaled lifecycle", () => {
	it("rolls over a settled stopped journal and retains exact history and stop capacity", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381);
		const retained = await readFile(join(root, "000380.json"));
		await Promise.all([f.reconcile(), f.reconcile()]);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(2);
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
		expect((await f.reconcile("stopped")).state).toBe("pending");
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		expect(await readFile(join(root, "000380.json"))).toEqual(retained);
		expect((await readdir(join(root, "segment-000001"))).length).toBe(7);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
			"stop",
		]);
		// A coding VM is powered off, never asked to shut down (live 2026-09-24:
		// the guest ignored the request and kept its reservation).
		expect(f.client.submitInstanceOperation.mock.calls.at(-1)?.[1]).toMatchObject({ action: "stop", force: true });
	});
	it("permits exact stop from a legacy full start journal then rolls over without recreating the VM", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 384);
		expect((await f.reconcile("stopped")).state).toBe("pending");
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		expect(JSON.parse(await readFile(join(root, "000386.json"), "utf8")).action).toBe("stop");
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
	});
	it("rolls over a disposable VM's full journal that ends with a start whose VM stopped by itself", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381, "succeeded", "start");
		const plan = { ...f.journal, disposable: true as const, selfStops: undefined };
		const reconcile = (desiredState: "running" | "stopped" | "deleted" = "running") =>
			reconcileCodingMachine({ ...f.options, plan, desiredState });
		// A journal for a VM that never stops by itself never accepts it (a start after a start).
		await expect(
			reconcileCodingMachine({ ...f.options, plan: { ...f.journal, selfStops: undefined } }),
		).rejects.toThrow("CODING_MACHINE_JOURNAL_INVALID");
		expect((await reconcile()).state).toBe("pending");
		expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
			segment: 1,
			previousEventCount: 381,
		});
		expect((await reconcile()).state).toBe("pending");
		expect((await reconcile()).state).toBe("running");
		expect((await reconcile("stopped")).state).toBe("pending");
		expect((await reconcile("stopped")).state).toBe("stopped");
	});
	it("rolls over after a failed stop whose VM LXD shows stopped", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381, "failed");
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		expect((await f.reconcile()).state).toBe("pending");
		expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
			segment: 1,
			previousEventCount: 381,
		});
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
		]);
	});
	it("recovers an empty unpublished rollover directory but never replays an unknown new-segment start", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381);
		await mkdir(join(root, "segment-000001"), { mode: 0o700 });
		expect((await f.reconcile()).state).toBe("pending");
		f.client.submitInstanceOperation.mockRejectedValue(new Error("response lost"));
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(3);
	});
	it("reconciles accepted creation, retains one VM over turns, stops without deleting, then resumes the same disk", async () => {
		const f = await fixture();
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
		expect((await f.reconcile()).state).toBe("running");
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
		expect((await f.reconcile("stopped")).state).toBe("pending");
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"stop",
			"start",
		]);
		expect(f.instance()?.devices.root).toEqual(f.plan.request.devices.root);
	});
	it("cancellation before provision leaves no physical allocation", async () => {
		const f = await fixture();
		expect((await f.reconcile("stopped")).state).toBe("absent");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("never resubmits an unknown create even after reopening or physical absence", async () => {
		const f = await fixture();
		f.client.submitInstanceOperation.mockRejectedValue(new Error("lost create response"));
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect((await f.reconcile("stopped")).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("one concurrent claimant dispatches create", async () => {
		const f = await fixture();
		await Promise.all([f.reconcile(), f.reconcile(), f.reconcile()]);
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("does not start while known create is pending or unobservable", async () => {
		const f = await fixture();
		await f.reconcile();
		f.client.inspectInstanceOperation.mockResolvedValueOnce("pending").mockRejectedValueOnce(new Error("404"));
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("does not use failed creation as permission to retry", async () => {
		const f = await fixture();
		await f.reconcile();
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect((await f.reconcile()).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("refuses retargeting the same machine to another image", async () => {
		const f = await fixture();
		await f.reconcile();
		const moved = lxdCodingMachineJournalPlan({ ...f.value, imageFingerprint: "e".repeat(64) }, storage);
		await expect(
			reconcileCodingMachine({ ...f.options, plan: moved, authorize: receiptFor(moved), desiredState: "running" }),
		).rejects.toThrow("CODING_MACHINE_BINDING_CONFLICT");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("checks expanded configuration before returning reusable running VM", async () => {
		const f = await fixture();
		await f.reconcile();
		await f.reconcile();
		await f.reconcile();
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.expandedDevices = {
			...instance.expandedDevices,
			secret: { type: "disk", source: "/secret", path: "/secret" },
		};
		expect(() => assertLxdCodingMachineInstance(f.value, storage, instance)).toThrow("CODING_MACHINE_DRIFTED");
		await expect(f.reconcile()).rejects.toThrow("CODING_MACHINE_DRIFTED");
	});
	it("settles a member's machine that stopped by itself (the host watchdog, a node reboot) as stopped", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Stopped";
		instance.statusCode = 102;
		// A VM that never stops by itself keeps the start's evidence for an operator.
		expect((await reconcileCodingMachine({ ...f.options, plan: { ...f.journal, selfStops: undefined } })).state).toBe(
			"recovery-required",
		);
		// A stop needs no effect; a run starts it again on the same disk.
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		for (const expected of ["pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		// Stopped by itself again, it is deleted without a stop of its own.
		instance.status = "Stopped";
		instance.statusCode = 102;
		for (const expected of ["pending", "deleted"]) expect((await f.reconcile("deleted")).state).toBe(expected);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
			"delete",
		]);
		// Each outside stop is written down once, after the start it ended, and numbered.
		const started = async (sequence: number) =>
			JSON.parse(
				await readFile(join(f.journalRoot, f.value.machineId, `${String(sequence).padStart(6, "0")}.json`), "utf8"),
			).operationId;
		expect(await outsideStops(f)).toEqual([
			{
				schema: "qorpera.coding-machine-outside-stop/v1",
				segment: 0,
				sequence: 5,
				operationId: await started(5),
				count: 1,
				observedAt: expect.any(String),
			},
			expect.objectContaining({ segment: 0, sequence: 8, operationId: await started(8), count: 2 }),
		]);
	});
	it("waits for an operator once a member's machine stops by itself a fourth time within an hour", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
			const f = await fixture();
			const stoppedFromOutside = vi.fn(async () => {});
			Object.assign(f.options, { stoppedFromOutside });
			for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
			const stopFromOutside = (at: string) => {
				vi.setSystemTime(new Date(at));
				const instance = f.instance();
				if (!instance) throw new Error("missing fixture VM");
				instance.status = "Stopped";
				instance.statusCode = 102;
			};
			// Four outside stops spread over more than an hour: each time it is started again.
			for (const at of [
				"2026-10-15T08:10:00Z",
				"2026-10-15T08:40:00Z",
				"2026-10-15T09:00:00Z",
				"2026-10-15T09:15:00Z",
			]) {
				stopFromOutside(at);
				for (const expected of ["pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
			}
			// A fifth makes four within the hour (08:40 to 09:30): the old rule, for every intent, and it stays.
			stopFromOutside("2026-10-15T09:30:00Z");
			for (const desired of ["running", "stopped", "deleted", "running"] as const)
				expect((await f.reconcile(desired)).state).toBe("recovery-required");
			vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
			expect((await f.reconcile()).state).toBe("recovery-required");
			expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(6);
			// The executor hears of every stop each time it is seen, the refused ones too: 4 restarts, then 5 refusals.
			expect(stoppedFromOutside).toHaveBeenCalledTimes(9);
			expect(
				(await outsideStops(f)).map(({ count, sequence, observedAt }) => [count, sequence, observedAt]),
			).toEqual([
				[1, 5, "2026-10-15T08:10:00.000Z"],
				[2, 8, "2026-10-15T08:40:00.000Z"],
				[3, 11, "2026-10-15T09:00:00.000Z"],
				[4, 14, "2026-10-15T09:15:00.000Z"],
				[5, 17, "2026-10-15T09:30:00.000Z"],
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("hands a member's outside stop to the executor once it is written down, before anything is done to the VM", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		// The stop the executor is told of, and what was written down and done to the VM by then; the first call fails.
		const seen: [string, number, number][] = [];
		let fail = true;
		const stoppedFromOutside = vi.fn(async (startOperationId: string, signal: AbortSignal) => {
			expect(signal).toBe(f.controller.signal);
			seen.push([
				startOperationId,
				(await outsideStops(f)).length,
				f.client.submitInstanceOperation.mock.calls.length,
			]);
			if (fail) {
				fail = false;
				throw new Error("CODING_HOST_MACHINE_STOPPED_UNCONFIRMED");
			}
		});
		const reconcile = (desiredState: "running" | "stopped" | "deleted", plan = f.journal) =>
			reconcileCodingMachine({ ...f.options, plan, desiredState, stoppedFromOutside });
		expect((await reconcile("running")).state).toBe("running");
		instance.status = "Stopped";
		instance.statusCode = 102;
		// A VM that never stops by itself has nothing to tell.
		expect((await reconcile("running", { ...f.journal, selfStops: undefined })).state).toBe("recovery-required");
		expect(stoppedFromOutside).not.toHaveBeenCalled();
		// A failure fails the run before its start; the next run tells it again, then starts it.
		await expect(reconcile("running")).rejects.toThrow("CODING_HOST_MACHINE_STOPPED_UNCONFIRMED");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(2);
		for (const expected of ["pending", "running"]) expect((await reconcile("running")).state).toBe(expected);
		// Stopped from outside again: told before the stop is settled and before the delete.
		instance.status = "Stopped";
		instance.statusCode = 102;
		expect((await reconcile("stopped")).state).toBe("stopped");
		for (const expected of ["pending", "deleted"]) expect((await reconcile("deleted")).state).toBe(expected);
		// Each stop is named by the start it ended, the same each time it is seen, as its record next to the journal is.
		const [first, second] = (await outsideStops(f)).map((stop) => stop.operationId);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
		expect(seen).toEqual([
			[first, 1, 2],
			[first, 1, 2],
			[second, 2, 3],
			[second, 2, 3],
		]);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
			"delete",
		]);
	});
	it("tells the executor right before each start, ahead of the start's fresh authority, and dispatches nothing when that fails", async () => {
		const f = await fixture();
		// Each authority, each call and each dispatch, in order; the first call fails.
		const order: string[] = [];
		const authorize = async (intent: CodingMachineIntent) => {
			order.push(`authorize:${intent}`);
			return receipt(f.journal, intent);
		};
		let fail = true;
		const starting = vi.fn(async (signal: AbortSignal) => {
			expect(signal).toBe(f.controller.signal);
			order.push("starting");
			if (fail) {
				fail = false;
				throw new Error("CODING_FOLDER_CONTROL_UNAVAILABLE");
			}
		});
		const submit = f.client.submitInstanceOperation.getMockImplementation()!;
		f.client.submitInstanceOperation.mockImplementation(async (project, action, signal) => {
			order.push(action.action);
			return submit(project, action, signal);
		});
		const reconcile = (desiredState: "running" | "stopped" = "running") =>
			reconcileCodingMachine({ ...f.options, desiredState, authorize, starting });
		// The create is not told; its first start is, and a failure dispatches nothing.
		expect((await reconcile()).state).toBe("pending");
		await expect(reconcile()).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		for (const expected of ["pending", "running", "running"]) expect((await reconcile()).state).toBe(expected);
		// A stop is not told; the start after it is, and so is the start after a stop from outside.
		for (const expected of ["pending", "stopped"]) expect((await reconcile("stopped")).state).toBe(expected);
		for (const expected of ["pending", "running"]) expect((await reconcile()).state).toBe(expected);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Stopped";
		instance.statusCode = 102;
		for (const expected of ["pending", "running"]) expect((await reconcile()).state).toBe(expected);
		const start = ["authorize:run", "starting", "authorize:run", "start"];
		expect(order).toEqual([
			...["authorize:run", "authorize:run", "create"],
			...["authorize:run", "starting"],
			...start,
			...["authorize:run", "authorize:run"],
			...["authorize:stop", "authorize:stop", "stop", "authorize:stop"],
			...start,
			"authorize:run",
			...start,
			"authorize:run",
		]);
		expect(starting).toHaveBeenCalledTimes(4);
	});
	it("rolls over a member's full journal that ends with a start whose VM stopped by itself", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381, "succeeded", "start");
		expect((await f.reconcile()).state).toBe("pending");
		expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
			segment: 1,
			previousEventCount: 381,
		});
		expect((await f.reconcile()).state).toBe("pending");
		expect((await f.reconcile()).state).toBe("running");
		expect((await f.reconcile("stopped")).state).toBe("pending");
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		// The stop is written down once, after the start that ended the old segment.
		expect(await outsideStops(f)).toEqual([expect.objectContaining({ segment: 0, sequence: 380, count: 1 })]);
	});
	it("reads the start a member's machine runs under, also once it stopped by itself and was started again", async () => {
		const f = await fixture();
		// The fake LXD numbers each operation by its submission.
		const submitted = () => id(10 + f.client.submitInstanceOperation.mock.calls.length);
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const first = submitted();
		expect(await codingMachineStartOperation(f.journalRoot, f.journal)).toBe(first);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Stopped";
		instance.statusCode = 102;
		// Started again: two starts in a row, read as its reconcile reads them.
		for (const expected of ["pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
		]);
		const second = submitted();
		expect(second).not.toBe(first);
		expect(await codingMachineStartOperation(f.journalRoot, f.journal)).toBe(second);
		// A machine that never stops by itself has no such journal.
		await expect(codingMachineStartOperation(f.journalRoot, { ...f.journal, selfStops: undefined })).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
		// Stopped, it runs under no start.
		for (const expected of ["pending", "stopped"]) expect((await f.reconcile("stopped")).state).toBe(expected);
		await expect(codingMachineStartOperation(f.journalRoot, f.journal)).rejects.toThrow(
			"CODING_MACHINE_START_UNCONFIRMED",
		);
	});
	it("reads the start a member's machine runs under across a rollover that carried a start whose VM stopped by itself", async () => {
		const f = await fixture();
		await retainedHistory(f, 381, "succeeded", "start");
		// The full segment ends with the start the machine ran under before it stopped.
		expect(await codingMachineStartOperation(f.journalRoot, f.journal)).toBe(id(1126));
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		// The new segment's start, after the carried one.
		expect(f.client.submitInstanceOperation.mock.calls.at(-1)?.[1]).toMatchObject({ action: "start" });
		const started = id(10 + f.client.submitInstanceOperation.mock.calls.length);
		expect(await codingMachineStartOperation(f.journalRoot, f.journal)).toBe(started);
		await expect(codingMachineStartOperation(f.journalRoot, { ...f.journal, selfStops: undefined })).rejects.toThrow(
			"CODING_MACHINE_CHECKPOINT_INVALID",
		);
	});
	it("never takes a member's VM that LXD shows in any other state for stopped", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Starting";
		instance.statusCode = 106;
		expect((await f.reconcile("stopped")).state).toBe("recovery-required");
		expect((await f.reconcile("deleted")).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(2);
	});
	it("rejects stale or mismatched admission before physical calls", async () => {
		const f = await fixture();
		f.authorize.mockResolvedValue({ ...receipt(f.journal, "run"), machineId: id(100) });
		await expect(f.reconcile()).rejects.toThrow("CODING_MACHINE_ADMISSION_UNCONFIRMED");
		f.authorize.mockResolvedValue({ ...receipt(f.journal, "run"), intent: "stop" });
		await expect(f.reconcile()).rejects.toThrow("CODING_MACHINE_ADMISSION_UNCONFIRMED");
		expect(f.client.getInstance).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("fresh dispatch authorization can revoke an earlier successful admission", async () => {
		const f = await fixture();
		f.authorize
			.mockImplementationOnce(async (intent) => receipt(f.journal, intent))
			.mockRejectedValue(new Error("lease lost"));
		await expect(f.reconcile()).rejects.toThrow("lease lost");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("persists acceptance on lease loss but never reports the VM running", async () => {
		const f = await fixture();
		f.client.submitInstanceOperation.mockImplementation(async () => {
			f.controller.abort();
			return { project: f.value.project, instanceName: f.plan.request.name, operationId: id(11) };
		});
		await expect(f.reconcile()).rejects.toThrow();
		const accepted = JSON.parse(await readFile(join(f.journalRoot, f.value.machineId, "000001.json"), "utf8"));
		expect(accepted.kind).toBe("accepted");
		expect(accepted.operationId).toBe(id(11));
	});
	it("rejects a symlinked journal and performs no LXD calls", async () => {
		const f = await fixture();
		const other = await mkdtemp(join(tmpdir(), "coding-machine-other-"));
		roots.push(other);
		await symlink(other, join(f.journalRoot, f.value.machineId));
		await expect(f.reconcile()).rejects.toThrow("JOURNAL_DIRECTORY_UNSAFE");
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	describe("a stop that failed or that LXD forgot", () => {
		async function running() {
			const f = await fixture();
			for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
			return f;
		}
		const events = async (f: Awaited<ReturnType<typeof fixture>>) => {
			const root = join(f.journalRoot, f.value.machineId);
			const names = (await readdir(root)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
			return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))));
		};
		const actions = (f: Awaited<ReturnType<typeof fixture>>) =>
			f.client.submitInstanceOperation.mock.calls.map((call) => call[1]);
		it("re-issues a forced stop while LXD still shows the VM running, then settles stopped", async () => {
			const f = await running();
			// Live 2026-09-24: "Failed shutting down instance", the VM kept running.
			f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
			expect((await f.reconcile("stopped")).state).toBe("pending");
			expect((await f.reconcile("stopped")).state).toBe("pending");
			expect((await f.reconcile("stopped")).state).toBe("stopped");
			expect(actions(f).slice(2)).toEqual([
				{ action: "stop", name: f.plan.request.name, force: true },
				{ action: "stop", name: f.plan.request.name, force: true },
			]);
			expect((await events(f)).slice(6).map((event) => [event.action, event.kind, event.state])).toEqual([
				["stop", "dispatch", null],
				["stop", "accepted", null],
				["stop", "settled", "failed"],
				["stop", "dispatch", null],
				["stop", "accepted", null],
				["stop", "settled", "succeeded"],
			]);
			// The healed journal still reads, and the next turn starts the same VM.
			expect((await f.reconcile()).state).toBe("pending");
			expect((await f.reconcile()).state).toBe("running");
			expect(actions(f).at(-1)).toEqual({ action: "start", name: f.plan.request.name });
		});
		it("heals a failed stop whose VM LXD shows stopped, without another dispatch", async () => {
			const f = await running();
			f.client.inspectInstanceOperation.mockImplementationOnce(async () => {
				const instance = f.instance()!;
				instance.status = "Stopped";
				instance.statusCode = 102;
				return "failed";
			});
			expect((await f.reconcile("stopped")).state).toBe("pending");
			expect((await f.reconcile("stopped")).state).toBe("stopped");
			expect((await f.reconcile("stopped")).state).toBe("stopped");
			expect(actions(f).map((action) => action.action)).toEqual(["create", "start", "stop"]);
			// A later turn may start it: the VM is physically stopped.
			expect((await f.reconcile()).state).toBe("pending");
			expect((await f.reconcile()).state).toBe("running");
			expect(actions(f).map((action) => action.action)).toEqual(["create", "start", "stop", "start"]);
		});
		it("settles a stop LXD no longer knows from the VM itself", async () => {
			const f = await running();
			expect((await f.reconcile("stopped")).state).toBe("pending");
			// LXD finished and pruned the operation before it was observed.
			f.client.inspectInstanceOperation.mockImplementationOnce(async () => {
				const instance = f.instance()!;
				instance.status = "Stopped";
				instance.statusCode = 102;
				throw new Error("LXD_OPERATION_UNKNOWN");
			});
			expect((await f.reconcile("stopped")).state).toBe("stopped");
			expect((await events(f)).at(-1)).toMatchObject({ action: "stop", kind: "settled", state: "succeeded" });
			const g = await running();
			expect((await g.reconcile("stopped")).state).toBe("pending");
			g.client.inspectInstanceOperation.mockRejectedValueOnce(new Error("LXD_OPERATION_UNKNOWN"));
			expect((await g.reconcile("stopped")).state).toBe("pending");
			expect((await events(g)).slice(8, 10).map((event) => [event.kind, event.state])).toEqual([
				["settled", "failed"],
				["dispatch", null],
			]);
			expect(actions(g).map((action) => action.action)).toEqual(["create", "start", "stop", "stop"]);
		});
		it("keeps any other unobservable operation, and any failed start, for an operator", async () => {
			const f = await running();
			expect((await f.reconcile("stopped")).state).toBe("pending");
			f.client.inspectInstanceOperation.mockRejectedValue(new Error("LXD_OPERATION_UNCONFIRMED"));
			expect((await f.reconcile("stopped")).state).toBe("recovery-required");
			expect((await events(f)).at(-1)).toMatchObject({ action: "stop", kind: "accepted" });
			// A start LXD forgot, or one that failed, is never settled or retried here.
			const g = await running();
			expect((await g.reconcile("stopped")).state).toBe("pending");
			expect((await g.reconcile("stopped")).state).toBe("stopped");
			expect((await g.reconcile()).state).toBe("pending");
			g.client.inspectInstanceOperation.mockRejectedValueOnce(new Error("LXD_OPERATION_UNKNOWN"));
			expect((await g.reconcile("stopped")).state).toBe("recovery-required");
			g.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
			expect((await g.reconcile()).state).toBe("recovery-required");
			expect((await g.reconcile("stopped")).state).toBe("recovery-required");
			expect((await events(g)).at(-1)).toMatchObject({ action: "start", kind: "settled", state: "failed" });
			expect(actions(g).map((action) => action.action)).toEqual(["create", "start", "stop", "start"]);
		});
		it("never reuses a VM whose stop failed while it still runs", async () => {
			const f = await running();
			f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
			expect((await f.reconcile("stopped")).state).toBe("pending");
			expect((await f.reconcile()).state).toBe("recovery-required");
			expect(actions(f).map((action) => action.action)).toEqual(["create", "start", "stop"]);
		});
		it("gives up after three failed stops in a row", async () => {
			const f = await running();
			f.client.inspectInstanceOperation.mockResolvedValue("failed");
			const states: string[] = [];
			for (let attempt = 0; attempt < 6; attempt++) states.push((await f.reconcile("stopped")).state);
			expect(states).toEqual([
				"pending",
				"pending",
				"pending",
				"recovery-required",
				"recovery-required",
				"recovery-required",
			]);
			expect(actions(f).filter((action) => action.action === "stop")).toHaveLength(3);
		});
		it("refuses a journal that dispatches after a failed start", async () => {
			const f = await running();
			const root = join(f.journalRoot, f.value.machineId);
			const settled = JSON.parse(await readFile(join(root, "000005.json"), "utf8"));
			await writeFile(join(root, "000005.json"), `${JSON.stringify({ ...settled, state: "failed" })}\n`);
			const bytes = await readFile(join(root, "000005.json"));
			await writeFile(
				join(root, "000006.json"),
				`${JSON.stringify({
					sequence: 6,
					previousSha256: createHash("sha256").update(bytes).digest("hex"),
					action: "stop",
					kind: "dispatch",
					operationId: null,
					state: null,
				})}\n`,
				{ mode: 0o600 },
			);
			await expect(f.reconcile("stopped")).rejects.toThrow("CODING_MACHINE_JOURNAL_INVALID");
		});
	});
	it("keeps private immutable lifecycle records", async () => {
		const f = await fixture();
		await f.reconcile();
		expect((await readdir(join(f.journalRoot, f.value.machineId))).sort()).toEqual([
			"000000.json",
			"000001.json",
			"binding.json",
		]);
	});
});

describe("a member's coding machine", () => {
	it("is one VM per member and environment with no session, profile or identity mount of its own", () => {
		const plan = lxdCodingMachinePlan(binding());
		expect(plan.request.profiles).toEqual([]);
		expect(Object.keys(plan.request.devices).sort()).toEqual(["network", "root"]);
		expect(plan.request.name).toBe(`qorpera-coding-machine-${id(2).replaceAll("-", "")}`);
		expect(plan.request.config).toMatchObject({
			"boot.autostart": "false",
			"user.qorpera.schema": "qorpera.lxd-coding-machine/v1",
			"user.qorpera.allocation_id": id(2),
			"user.qorpera.member_user_id": id(6),
			"user.qorpera.instance_sha256": plan.instanceSha256,
		});
		// The binding text SQL pins is the same whatever the key order it came in.
		const shuffled = Object.fromEntries(Object.entries(binding()).reverse()) as unknown as LxdCodingMachineBinding;
		expect(lxdCodingMachinePlan(shuffled).text).toBe(plan.text);
		expect(plan.instanceSha256).toBe(createHash("sha256").update(plan.text).digest("hex"));
	});
	it.each([
		{ profiles: ["default"] },
		{ imageFingerprint: "latest" },
		{ cpus: 65 },
		{ network: "../other" },
		{ network: "coding-net" },
		{ machineId: "bad" },
		{ memberUserId: "bad" },
		{ rootDiskBytes: Infinity },
		{ storage: {} },
	])("rejects inadmissible binding %j", (patch) => {
		expect(() => lxdCodingMachinePlan({ ...binding(), ...patch })).toThrow("INVALID_CODING_MACHINE_BINDING");
	});
	it("plugs into the agents' bridge: the plug's MAC on its only card, the plug called right before the create", async () => {
		const f = await fixture();
		expect(f.plan.request.devices.network).toEqual(agentPlugCard("eth0"));
		expect((await f.reconcile()).state).toBe("pending");
		expect(f.plug).toHaveBeenCalledTimes(1);
		expect(f.plug.mock.calls[0][0]).toEqual({
			kind: "coding",
			companyId: id(3),
			machineId: id(2),
			memberUserId: id(6),
			project: "coding",
			instance: f.plan.request.name,
		});
		// The plug comes after LXD showed no instance, and the fresh authority for the dispatch after the plug, so
		// the plug costs none of it.
		expect(f.client.getInstance.mock.invocationCallOrder[0]).toBeLessThan(f.plug.mock.invocationCallOrder[0]);
		expect(f.plug.mock.invocationCallOrder[0]).toBeLessThan(f.authorize.mock.invocationCallOrder.at(-1) as number);
		expect(f.client.submitInstanceOperation.mock.calls[0][1]).toEqual({ action: "create", request: f.created });
		expect(f.created.devices.network).toEqual({ ...agentPlugCard("eth0"), hwaddr: testAgentMac });
		for (const expected of ["pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		expect(f.plug).toHaveBeenCalledTimes(1);
	});
	it("dispatches nothing when the plug refuses", async () => {
		const f = await fixture();
		f.plug.mockRejectedValueOnce(new Error("AGENT_PLUG_REFUSED:NO_FREE_ADDRESS"));
		await expect(f.reconcile()).rejects.toThrow("AGENT_PLUG_REFUSED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		expect((await f.reconcile()).state).toBe("pending");
		expect(f.client.submitInstanceOperation.mock.calls[0][1]).toEqual({ action: "create", request: f.created });
	});
	it("never creates an agent card without a plug MAC: a plan that names no plug is refused before the dispatch", async () => {
		const f = await fixture();
		const { agentPlug: _, ...unplugged } = f.journal;
		await expect(
			reconcileCodingMachine({ ...f.options, plan: unplugged as CodingMachineJournalPlan }),
		).rejects.toThrow("AGENT_PLUG_MISSING");
		expect(f.plug).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		// Nothing was journaled: the plan with its plug then creates as for a machine never tried.
		expect((await f.reconcile()).state).toBe("pending");
		expect(f.client.submitInstanceOperation.mock.calls[0][1]).toEqual({ action: "create", request: f.created });
	});
	it("is only the machine it is with its agent card: a plug MAC, the card's exact keys, on the agents' bridge", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const instance = f.instance()!;
		const card = instance.devices.network;
		for (const network of [
			{ ...card, hwaddr: undefined as unknown as string },
			{ ...card, hwaddr: "00:16:3e:00:00:01" },
			{ ...card, hwaddr: "0e:51:0a:d2:00:05" },
			{ ...card, parent: "machine-net" },
			{ ...card, "security.port_isolation": "false" },
			{ ...card, "ipv4.address": "10.210.1.1" },
			{ type: "nic", network: "coding-net", name: "eth0" },
		]) {
			const devices = { ...instance.devices, network: JSON.parse(JSON.stringify(network)) };
			expect(() =>
				assertLxdCodingMachineInstance(f.value, storage, { ...instance, devices, expandedDevices: devices }),
			).toThrow("CODING_MACHINE_DRIFTED");
		}
	});
	it("accepts complete session folders of its company and environment, and nothing else", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const instance = f.instance()!;
		const session = lxdCodingSessionDevices(lxdCodingSessionStorage(f.value, storage, id(20)));
		expect(Object.values(session).map((device) => device.path)).toEqual([
			`/workspace/${id(20)}`,
			`/var/lib/qorpera-coding/${id(20)}`,
		]);
		expect(Object.values(session).map((device) => device.source)).toEqual([
			`/nas/coding/workers/${id(3)}/${id(4)}/${id(20)}/data`,
			`/nas/coding/workers/${id(3)}/${id(4)}/${id(20)}/guest-state`,
		]);
		instance.devices = instance.expandedDevices = { ...instance.devices, ...session };
		expect(assertLxdCodingMachineInstance(f.value, storage, instance)).toEqual([id(20)]);
		// Attached sessions do not stop the machine from being the same machine.
		expect((await f.reconcile()).state).toBe("running");
		const [dataName, custodyName] = Object.keys(session);
		for (const change of [
			{ [dataName]: undefined },
			{ [dataName]: { ...session[dataName], source: "/nas/coding/workers/elsewhere/data" } },
			{ [custodyName]: { ...session[custodyName], path: "/var/lib/qorpera-coding" } },
			{ extra: { type: "disk", source: "/secret", path: "/secret" } },
			{ [`data-${"f".repeat(31)}`]: session[dataName] },
		]) {
			const devices = Object.fromEntries(
				Object.entries({ ...instance.devices, ...change }).filter(([, device]) => device !== undefined),
			) as LxdInstanceRecord["devices"];
			expect(() =>
				assertLxdCodingMachineInstance(f.value, storage, { ...instance, devices, expandedDevices: devices }),
			).toThrow("CODING_MACHINE_DRIFTED");
		}
		// Another company's folder layout for the same worker is refused too.
		const foreign = lxdCodingSessionDevices(
			lxdCodingSessionStorage({ ...f.value, companyId: id(9) }, storage, id(20)),
		);
		const devices = { ...instance.devices, ...foreign };
		expect(() =>
			assertLxdCodingMachineInstance(f.value, storage, { ...instance, devices, expandedDevices: devices }),
		).toThrow("CODING_MACHINE_DRIFTED");
	});
	describe("removal", () => {
		async function stopped() {
			const f = await fixture();
			for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
			for (const expected of ["pending", "stopped"]) expect((await f.reconcile("stopped")).state).toBe(expected);
			return f;
		}
		it("deletes a stopped machine under its own journaled delete, and the proof is its absence", async () => {
			const f = await stopped();
			expect((await f.reconcile("deleted")).state).toBe("pending");
			expect((await f.reconcile("deleted")).state).toBe("deleted");
			expect((await f.reconcile("deleted")).state).toBe("deleted");
			expect((await f.reconcile("stopped")).state).toBe("deleted");
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1])).toEqual([
				{ action: "create", request: f.created },
				{ action: "start", name: f.plan.request.name },
				{ action: "stop", name: f.plan.request.name, force: true },
				{ action: "delete", name: f.plan.request.name },
			]);
			expect(
				f.authorize.mock.calls.map((call) => call[0]).filter((intent) => intent === "delete").length,
			).toBeGreaterThan(0);
			// A deleted machine never runs again, and one that reappears is not ours.
			expect((await f.reconcile()).state).toBe("recovery-required");
		});
		it("never deletes a running machine: only a confirmed stop comes first", async () => {
			const f = await fixture();
			for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
			expect((await f.reconcile("deleted")).state).toBe("recovery-required");
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
		});
		it("reports a machine never created as absent without any LXD effect", async () => {
			const f = await fixture();
			expect((await f.reconcile("deleted")).state).toBe("absent");
			expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		});
		it("settles a delete LXD no longer knows from the machine's absence", async () => {
			const f = await stopped();
			expect((await f.reconcile("deleted")).state).toBe("pending");
			f.client.inspectInstanceOperation.mockImplementationOnce(async () => {
				throw new Error("LXD_OPERATION_UNKNOWN");
			});
			// The fake LXD never ran the delete: the machine is still there, so the delete failed.
			expect((await f.reconcile("deleted")).state).toBe("pending");
			expect((await f.reconcile("deleted")).state).toBe("deleted");
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
				"create",
				"start",
				"stop",
				"delete",
				"delete",
			]);
		});
		it("re-issues a failed delete only while the machine is there and stopped, three times at most", async () => {
			const f = await stopped();
			f.client.inspectInstanceOperation.mockResolvedValue("failed");
			const states: string[] = [];
			for (let attempt = 0; attempt < 5; attempt++) states.push((await f.reconcile("deleted")).state);
			expect(states).toEqual(["pending", "pending", "pending", "recovery-required", "recovery-required"]);
			expect(f.client.submitInstanceOperation.mock.calls.filter((call) => call[1].action === "delete")).toHaveLength(
				3,
			);
			// A failed delete is never followed by a start.
			expect((await f.reconcile()).state).toBe("recovery-required");
		});
		it("refuses a delete receipt for another intent", async () => {
			const f = await stopped();
			f.authorize.mockImplementation(async () => receipt(f.journal, "stop"));
			await expect(f.reconcile("deleted")).rejects.toThrow("CODING_MACHINE_ADMISSION_UNCONFIRMED");
			expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).not.toContain("delete");
		});
	});
});

describe("a kept per-session VM from before", () => {
	function legacyBinding(): LxdCodingVmBinding {
		return {
			schema: "qorpera.lxd-coding-vm/v2",
			storage: codingStorageFixture({ workerId: id(1), companyId: id(3), environmentId: id(4) }),
			workerId: id(1),
			allocationId: id(2),
			companyId: id(3),
			environmentId: id(4),
			providerId: "native-node",
			providerPolicySha256: "a".repeat(64),
			repository: { host: "github.com", owner: "qorpera", name: "project", baseBranch: "main" },
			project: "coding",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "coding-disks",
			network: "coding-net",
			cpus: 2,
			memoryBytes: 4096 * 1024 ** 2,
			rootDiskBytes: 64 * 1024 ** 3,
		};
	}
	it("is stopped, deleted and proven gone through its old journal, and never created again", async () => {
		const journalRoot = await realpath(await mkdtemp(join(tmpdir(), "coding-machine-legacy-")));
		await chmod(journalRoot, 0o700);
		roots.push(journalRoot);
		const value = legacyBinding(),
			vm = lxdCodingVmPlan(value),
			retire = lxdLegacyCodingMachineJournalPlan(value);
		expect(retire).toMatchObject({ machineId: id(2), journalName: id(1), request: null, name: vm.request.name });
		const fake = lxd(value.project, vm.request.name, () => ({
			name: vm.request.name,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			profiles: [],
			devices: structuredClone(vm.request.devices),
			expandedDevices: structuredClone(vm.request.devices),
			config: { ...vm.request.config, "volatile.base_image": value.imageFingerprint },
			expandedConfig: { ...vm.request.config, "volatile.base_image": value.imageFingerprint },
		}));
		const run = (plan: CodingMachineJournalPlan, desiredState: "running" | "stopped" | "deleted") =>
			reconcileCodingMachine({
				plan,
				journalRoot,
				desiredState,
				client: fake.client,
				authorize: receiptFor(plan),
				signal: new AbortController().signal,
			});
		// The journal a v93 executor left: created, started, stopped.
		const old = { ...retire, request: vm.request };
		for (const [desired, expected] of [
			["running", "pending"],
			["running", "pending"],
			["running", "running"],
			["stopped", "pending"],
			["stopped", "stopped"],
		] as const)
			expect((await run(old, desired)).state).toBe(expected);
		expect(JSON.parse(await readFile(join(journalRoot, id(1), "binding.json"), "utf8"))).toEqual(vm.binding);
		expect((await run(retire, "stopped")).state).toBe("stopped");
		expect((await run(retire, "deleted")).state).toBe("pending");
		expect((await run(retire, "deleted")).state).toBe("deleted");
		expect((await run(retire, "running")).state).toBe("recovery-required");
		expect(fake.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"stop",
			"delete",
		]);
		// With no journal at all, nothing is created for it.
		const empty = await realpath(await mkdtemp(join(tmpdir(), "coding-machine-legacy-empty-")));
		await chmod(empty, 0o700);
		roots.push(empty);
		expect(
			(
				await reconcileCodingMachine({
					plan: retire,
					journalRoot: empty,
					desiredState: "running",
					client: lxd(value.project, vm.request.name, () => {
						throw new Error("never created");
					}).client,
					authorize: receiptFor(retire),
					signal: new AbortController().signal,
				})
			).state,
		).toBe("recovery-required");
	});
});
