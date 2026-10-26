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
	codingMachineDisk,
	codingMachineLastStart,
	codingMachineStartDropped,
	codingMachineStartOperation,
	dropCodingMachineStart,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
	reconcileCodingMachine,
	recordCodingMachineDisk,
	undropCodingMachineStart,
} from "../src/coding-machine.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "../src/coding-vm.ts";
import { type LxdInstanceRecord, LxdSubmissionRefused, type LxdTrackedInstanceAction } from "../src/lxd-client.ts";
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
		hasImage: vi.fn(async (_project: string, _fingerprint: string, _signal: AbortSignal) => true),
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

/** The dispatch errors written next to the machine's journal, oldest first. */
async function dispatchErrors(f: Awaited<ReturnType<typeof fixture>>) {
	const root = join(f.journalRoot, f.value.machineId);
	const names = (await readdir(root)).filter((name) => name.startsWith("dispatch-error-")).sort();
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))));
}

/** The outside stops written next to the machine's journal, oldest first. */
async function outsideStops(f: Awaited<ReturnType<typeof fixture>>) {
	const root = join(f.journalRoot, f.value.machineId);
	const names = (await readdir(root)).filter((name) => name.startsWith("outside-stop-")).sort();
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))));
}

/** A full segment of stops and starts after a create. Its last `trailing` effects are `lastAction` (when given), each
 * settled `lastState`; only the very last one is when `trailing` is 1. */
async function retainedHistory(
	f: Awaited<ReturnType<typeof fixture>>,
	count: 381 | 384,
	lastState: "succeeded" | "failed" = "succeeded",
	lastAction?: "start" | "stop" | "rebuild",
	trailing = 1,
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
						: lastAction && sequence >= count - 3 * trailing
							? lastAction
							: Math.floor(sequence / 3) % 2
								? "start"
								: "stop",
				kind: ["dispatch", "accepted", "settled"][phase],
				operationId: phase === 0 ? null : id(1000 + Math.floor(sequence / 3)),
				state: phase === 2 ? (sequence >= count - 3 * trailing ? lastState : "succeeded") : null,
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
	it("counts failed starts and stops in a row across the checkpoint the last of them closed its segment with", async () => {
		// A disposable VM whose full segment ends with two failed starts (its triplets 125 and 126), the VM stopped.
		const f = await fixture();
		const root = await retainedHistory(f, 381, "failed", "start", 2);
		const plan = { ...f.journal, disposable: true as const, selfStops: undefined };
		const reconcile = () => reconcileCodingMachine({ ...f.options, plan, desiredState: "running" });
		f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
		const states: string[] = [];
		for (let attempt = 0; attempt < 4; attempt++) states.push((await reconcile()).state);
		// The rollover, the third start, then its failure: the third in a row, so an operator is waited for.
		expect(states).toEqual(["pending", "pending", "recovery-required", "recovery-required"]);
		expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
			segment: 1,
			previousEventCount: 381,
		});
		// The retained history's own create and start, then the third start.
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"start",
		]);
		// A member's machine whose full segment ends with three failed stops (its triplets 124 to 126), the VM seen
		// stopped: the start after them rolls it over. Seen running again, it is not stopped a fourth time.
		const g = await fixture();
		await retainedHistory(g, 381, "failed", "stop", 3);
		expect((await g.reconcile()).state).toBe("pending");
		const instance = g.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Running";
		instance.statusCode = 103;
		expect((await g.reconcile("stopped")).state).toBe("recovery-required");
		expect(g.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
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
	it("writes down next to the journal what LXD answered a refused create, names its status, and leaves the create to an operator", async () => {
		const f = await fixture();
		// As node02's coding project refused the agent card on 24 Oct 2026 (C8 C4-1): LXD's answer, no operation.
		const message =
			'Failed checking if instance creation allowed: Invalid device "network": Only managed network devices';
		f.client.submitInstanceOperation.mockRejectedValue(new LxdSubmissionRefused(403, 403, message));
		expect(await f.reconcile()).toMatchObject({ state: "recovery-required", lxdStatus: 403 });
		expect(await dispatchErrors(f)).toEqual([
			{
				schema: "qorpera.coding-machine-dispatch-error/v1",
				segment: 0,
				sequence: 0,
				action: "create",
				code: "LXD_OPERATION_SUBMISSION_UNCONFIRMED",
				lxd: { status: 403, code: 403, message },
				observedAt: expect.any(String),
			},
		]);
		// The create's dispatch is still the journal's tail: never sent again, and nothing more written down.
		const again = await f.reconcile();
		expect(again.state).toBe("recovery-required");
		expect(again.lxdStatus).toBeUndefined();
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(await dispatchErrors(f)).toHaveLength(1);
		expect(
			(await readdir(join(f.journalRoot, f.value.machineId))).filter((name) => /^\d{6}\.json$/.test(name)),
		).toEqual(["000000.json"]);
		// A submission LXD never answered keeps only its code.
		const g = await fixture();
		g.client.submitInstanceOperation.mockRejectedValue(new Error("LXD_OPERATION_SUBMISSION_UNCONFIRMED"));
		const unanswered = await g.reconcile();
		expect(unanswered.state).toBe("recovery-required");
		expect(unanswered.lxdStatus).toBeUndefined();
		expect(await dispatchErrors(g)).toEqual([
			expect.objectContaining({ action: "create", code: "LXD_OPERATION_SUBMISSION_UNCONFIRMED", lxd: null }),
		]);
		// One whose text is not a code keeps none of it.
		const h = await fixture();
		h.client.submitInstanceOperation.mockRejectedValue(new Error("connect ECONNREFUSED /var/snap/lxd/unix.socket"));
		expect((await h.reconcile()).state).toBe("recovery-required");
		expect(await dispatchErrors(h)).toEqual([expect.objectContaining({ code: "UNCLASSIFIED", lxd: null })]);
	});
	it("reads the machine's project before a create with the agent card, and fails before the plug, the authority and the dispatch when it refuses the card", async () => {
		const f = await fixture();
		const projectAllowsAgentCard = vi.fn(async (_project: string, _signal: AbortSignal) => false);
		const reconcile = () => reconcileCodingMachine({ ...f.options, desiredState: "running", projectAllowsAgentCard });
		await expect(reconcile()).rejects.toThrow("CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD");
		expect(projectAllowsAgentCard).toHaveBeenCalledWith("coding", f.controller.signal);
		// Only the reconcile's first authority ran: no plug, no create authority, nothing dispatched or written down.
		expect(f.authorize).toHaveBeenCalledTimes(1);
		expect(f.plug).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		const root = join(f.journalRoot, f.value.machineId);
		expect(await readdir(root)).toEqual(["binding.json"]);
		// Not even a stop needs anything: the machine was never made.
		expect(
			(await reconcileCodingMachine({ ...f.options, desiredState: "stopped", projectAllowsAgentCard })).state,
		).toBe("absent");
		// Once the project allows the card, the create goes out as the first, and nothing after it reads the project.
		projectAllowsAgentCard.mockResolvedValue(true);
		for (const expected of ["pending", "pending", "running"]) expect((await reconcile()).state).toBe(expected);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
		expect(projectAllowsAgentCard).toHaveBeenCalledTimes(2);
		expect(f.plug).toHaveBeenCalledTimes(1);
		// A project that cannot be read fails the create the same way, before anything goes out.
		const g = await fixture();
		const unread = vi.fn(async () => {
			throw new Error("LXD_PROJECT_UNCONFIRMED");
		});
		await expect(
			reconcileCodingMachine({ ...g.options, desiredState: "running", projectAllowsAgentCard: unread }),
		).rejects.toThrow("LXD_PROJECT_UNCONFIRMED");
		expect(g.plug).not.toHaveBeenCalled();
		expect(g.client.submitInstanceOperation).not.toHaveBeenCalled();
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
		const starting = vi.fn(async (_afterOperationId: string, signal: AbortSignal) => {
			expect(signal).toBe(f.controller.signal);
			order.push("starting");
			if (fail) {
				fail = false;
				throw new Error("CODING_FOLDER_CONTROL_UNAVAILABLE");
			}
			return undefined;
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
		// The fake LXD numbers each operation by its submission: the create 11, the starts 12, 14 and 15, the stop 13. Each
		// start is named by the effect it follows: the create (tried twice), the stop, the start the machine stopped after.
		expect(starting.mock.calls.map((call) => call[0])).toEqual([id(11), id(11), id(13), id(14)]);
	});
	it("rolls over a member's full journal that ends with a start whose VM stopped by itself", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381, "succeeded", "start");
		const starting = vi.fn(async (_afterOperationId: string, _signal: AbortSignal) => undefined);
		const reconcile = () => reconcileCodingMachine({ ...f.options, desiredState: "running", starting });
		expect((await reconcile()).state).toBe("pending");
		expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
			segment: 1,
			previousEventCount: 381,
		});
		expect((await reconcile()).state).toBe("pending");
		expect((await reconcile()).state).toBe("running");
		// The start after the rollover is named by the old segment's last start (its triplet 126), as before it.
		expect(starting.mock.calls.map((call) => call[0])).toEqual([id(1126)]);
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
	it("reads the start a member's machine last ran under right before each start (F3 5g-5)", async () => {
		const f = await fixture();
		const lastStarts: (string | null)[] = [];
		const starting = vi.fn(async () => {
			lastStarts.push(await codingMachineLastStart(f.journalRoot, f.journal));
			return undefined;
		});
		const reconcile = (desiredState: "running" | "stopped") =>
			reconcileCodingMachine({ ...f.options, desiredState, starting });
		for (const expected of ["pending", "pending", "running"])
			expect((await reconcile("running")).state).toBe(expected);
		for (const expected of ["pending", "stopped"]) expect((await reconcile("stopped")).state).toBe(expected);
		for (const expected of ["pending", "running"]) expect((await reconcile("running")).state).toBe(expected);
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Stopped";
		instance.statusCode = 102;
		for (const expected of ["pending", "running"]) expect((await reconcile("running")).state).toBe(expected);
		// The fake LXD numbers each operation by its submission: the create 11, the starts 12, 14 and 15, the stop 13.
		// Before the first start none ran; then the start the stop ended, then the start the machine stopped after.
		expect(lastStarts).toEqual([null, id(12), id(14)]);
		await expect(codingMachineLastStart(f.journalRoot, { ...f.journal, selfStops: undefined })).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
	});
	it("reads the start a member's machine last ran under back in the segment before, each record checked (F3 5g-5)", async () => {
		const f = await fixture();
		const root = await retainedHistory(f, 381);
		// The full segment ends with a stop (triplet 126), after the start of triplet 125.
		expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(1125));
		const lastStarts: (string | null)[] = [];
		const starting = vi.fn(async () => {
			lastStarts.push(await codingMachineLastStart(f.journalRoot, f.journal));
			return undefined;
		});
		const reconcile = (desiredState: "running" | "stopped" = "running") =>
			reconcileCodingMachine({ ...f.options, desiredState, starting });
		// Rolled over, the new segment holds nothing yet: the start is read back in the old one.
		expect((await reconcile()).state).toBe("pending");
		expect(await readdir(join(root, "segment-000001"))).toEqual(["checkpoint.json"]);
		expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(1125));
		// A record that is not the one the record after it names is refused.
		const retained = await readFile(join(root, "000378.json"));
		await writeFile(join(root, "000378.json"), Buffer.concat([retained.subarray(0, -1), Buffer.from(" \n")]));
		await expect(codingMachineLastStart(f.journalRoot, f.journal)).rejects.toThrow("CODING_MACHINE_JOURNAL_INVALID");
		await writeFile(join(root, "000378.json"), retained);
		for (const expected of ["pending", "running"]) expect((await reconcile()).state).toBe(expected);
		expect(lastStarts).toEqual([id(1125)]);
		// Once the new segment holds a start, it is that one.
		const started = id(10 + f.client.submitInstanceOperation.mock.calls.length);
		for (const expected of ["pending", "stopped"]) expect((await reconcile("stopped")).state).toBe(expected);
		expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(started);
	});
	it("reads the start a member's machine last ran under from a rollover that carried it (F3 5g-5)", async () => {
		const f = await fixture();
		await retainedHistory(f, 381, "succeeded", "start");
		expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(1126));
		expect((await f.reconcile()).state).toBe("pending");
		expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(1126));
	});
	it("marks a start dropped next to the machine's journal once, reads the mark, and takes it back (F3 5g-5)", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		const start = id(12);
		expect(await codingMachineStartDropped(f.journalRoot, f.journal, start)).toBe(false);
		// The call that wrote the mark says so; one after it finds it written.
		expect(await dropCodingMachineStart(f.journalRoot, f.journal, start)).toBe(true);
		expect(await dropCodingMachineStart(f.journalRoot, f.journal, start)).toBe(false);
		expect(await codingMachineStartDropped(f.journalRoot, f.journal, start)).toBe(true);
		expect(await codingMachineStartDropped(f.journalRoot, f.journal, id(14))).toBe(false);
		const mark = join(f.journalRoot, f.value.machineId, `dropped-start-${start}.json`);
		expect(JSON.parse(await readFile(mark, "utf8"))).toEqual({
			schema: "qorpera.coding-machine-dropped-start/v1",
			operationId: start,
		});
		// The journal reads past it.
		expect((await f.reconcile()).state).toBe("running");
		await undropCodingMachineStart(f.journalRoot, f.journal, start);
		expect(await codingMachineStartDropped(f.journalRoot, f.journal, start)).toBe(false);
		await undropCodingMachineStart(f.journalRoot, f.journal, start);
		// A mark that is not the one for its start, or a start that is not an operation id, is refused.
		await writeFile(
			mark,
			`${JSON.stringify({ schema: "qorpera.coding-machine-dropped-start/v1", operationId: id(14) })}\n`,
			{ mode: 0o600 },
		);
		await expect(codingMachineStartDropped(f.journalRoot, f.journal, start)).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
		await expect(codingMachineStartDropped(f.journalRoot, f.journal, "start")).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
		await expect(dropCodingMachineStart(f.journalRoot, f.journal, "../start")).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
	});
	it("writes down next to the machine's journal the rebuild that gave it its disk, and reads it (F3 5g-5)", async () => {
		const f = await fixture();
		for (const expected of ["pending", "pending", "running"]) expect((await f.reconcile()).state).toBe(expected);
		// The disk it was made with.
		expect(await codingMachineDisk(f.journalRoot, f.journal)).toBeNull();
		await recordCodingMachineDisk(f.journalRoot, f.journal, id(20));
		expect(await codingMachineDisk(f.journalRoot, f.journal)).toBe(id(20));
		// The next rebuild's disk takes its place, written whole.
		await recordCodingMachineDisk(f.journalRoot, f.journal, id(21));
		expect(await codingMachineDisk(f.journalRoot, f.journal)).toBe(id(21));
		const root = join(f.journalRoot, f.value.machineId);
		expect(JSON.parse(await readFile(join(root, "disk.json"), "utf8"))).toEqual({
			schema: "qorpera.coding-machine-disk/v1",
			operationId: id(21),
		});
		expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
		// The journal reads past it.
		expect((await f.reconcile()).state).toBe("running");
		// A record that is not one, or a rebuild that is not an operation id, is refused.
		for (const value of [
			{ schema: "qorpera.coding-machine-disk/v1", operationId: "rebuild" },
			{ schema: "qorpera.coding-machine-disk/v1", operationId: id(21), extra: 1 },
			{ schema: "qorpera.coding-machine-dropped-start/v1", operationId: id(21) },
		]) {
			await writeFile(join(root, "disk.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
			await expect(codingMachineDisk(f.journalRoot, f.journal)).rejects.toThrow("CODING_MACHINE_JOURNAL_INVALID");
		}
		await expect(recordCodingMachineDisk(f.journalRoot, f.journal, "../rebuild")).rejects.toThrow(
			"CODING_MACHINE_JOURNAL_INVALID",
		);
	});
	describe("a new disk from the machine's image (F3 5g-5)", () => {
		type After = "create" | "start" | "stop" | "rebuild";
		const actions = (f: Awaited<ReturnType<typeof fixture>>) =>
			f.client.submitInstanceOperation.mock.calls.map((call) => call[1]);
		const rebuild = (f: Awaited<ReturnType<typeof fixture>>) => ({
			action: "rebuild",
			name: f.plan.request.name,
			fingerprint: "b".repeat(64),
		});
		/** A stopped machine whose executor asks for a new disk right before the start after its stop. */
		async function stopped() {
			const f = await fixture();
			// Each authority, each call and each dispatch, in order.
			const order: string[] = [];
			const authorize = async (intent: CodingMachineIntent) => {
				order.push(`authorize:${intent}`);
				return receipt(f.journal, intent);
			};
			const starting = vi.fn(async (_afterOperationId: string, _signal: AbortSignal, after: After) => {
				order.push(`starting:${after}`);
				return after === "stop" ? ("rebuild" as const) : undefined;
			});
			const submit = f.client.submitInstanceOperation.getMockImplementation()!;
			f.client.submitInstanceOperation.mockImplementation(async (project, action, signal) => {
				order.push(action.action);
				return submit(project, action, signal);
			});
			const reconcile = (desiredState: "running" | "stopped" | "deleted" = "running") =>
				reconcileCodingMachine({ ...f.options, desiredState, authorize, starting });
			for (const expected of ["pending", "pending", "running"]) expect((await reconcile()).state).toBe(expected);
			for (const expected of ["pending", "stopped"]) expect((await reconcile("stopped")).state).toBe(expected);
			order.length = 0;
			return { f, order, starting, reconcile };
		}
		it("is a rebuild in place of the start, under its own authority, and the start after it is named by the rebuild", async () => {
			const { f, order, starting, reconcile } = await stopped();
			expect((await reconcile()).state).toBe("pending");
			expect(f.client.hasImage).toHaveBeenCalledWith(f.value.project, "b".repeat(64), f.controller.signal);
			// The machine never ran on the new disk yet: the start it last ran under is still the one before the stop.
			expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(12));
			for (const expected of ["pending", "running"]) expect((await reconcile()).state).toBe(expected);
			expect(order).toEqual([
				...["authorize:run", "starting:stop", "authorize:rebuild", "rebuild"],
				...["authorize:run", "starting:rebuild", "authorize:run", "start"],
				"authorize:run",
			]);
			// The fake LXD numbers each operation by its submission: the create 11, the start 12, the stop 13, the rebuild
			// 14 (from the machine's own image), the start 15.
			expect(actions(f)).toEqual([
				expect.objectContaining({ action: "create" }),
				{ action: "start", name: f.plan.request.name },
				{ action: "stop", name: f.plan.request.name, force: true },
				rebuild(f),
				{ action: "start", name: f.plan.request.name },
			]);
			expect(starting.mock.calls.map((call) => [call[0], call[2]])).toEqual([
				[id(11), "create"],
				[id(13), "stop"],
				[id(14), "rebuild"],
			]);
			expect(await codingMachineLastStart(f.journalRoot, f.journal)).toBe(id(15));
		});
		it("re-issues a failed rebuild without the executor, never starts on what it left, and waits for an operator after the third", async () => {
			const { f, order, starting, reconcile } = await stopped();
			for (let attempt = 0; attempt < 3; attempt++)
				f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
			const states: string[] = [];
			for (let attempt = 0; attempt < 5; attempt++) states.push((await reconcile()).state);
			expect(states).toEqual(["pending", "pending", "pending", "recovery-required", "recovery-required"]);
			expect(order.filter((step) => step.startsWith("starting:"))).toEqual(["starting:stop"]);
			expect(order.filter((step) => step === "authorize:rebuild")).toHaveLength(3);
			expect(actions(f).slice(3)).toEqual([rebuild(f), rebuild(f), rebuild(f)]);
			expect(starting).toHaveBeenCalledTimes(2);
			// The machine is stopped: a stop is done, and a delete still goes.
			expect((await reconcile("stopped")).state).toBe("stopped");
			for (const expected of ["pending", "deleted"]) expect((await reconcile("deleted")).state).toBe(expected);
			expect(actions(f).at(-1)).toEqual({ action: "delete", name: f.plan.request.name });
		});
		it("settles a rebuild LXD no longer knows as failed on the stopped VM, and rebuilds again", async () => {
			const { f, starting, reconcile } = await stopped();
			expect((await reconcile()).state).toBe("pending");
			f.client.inspectInstanceOperation.mockRejectedValueOnce(new Error("LXD_OPERATION_UNKNOWN"));
			expect((await reconcile()).state).toBe("pending");
			const root = join(f.journalRoot, f.value.machineId);
			const names = (await readdir(root)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
			const events = await Promise.all(
				names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))),
			);
			expect(events.slice(9).map((event) => [event.action, event.kind, event.state])).toEqual([
				["rebuild", "dispatch", null],
				["rebuild", "accepted", null],
				["rebuild", "settled", "failed"],
				["rebuild", "dispatch", null],
				["rebuild", "accepted", null],
			]);
			for (const expected of ["pending", "running"]) expect((await reconcile()).state).toBe(expected);
			// The start is named by the rebuild that succeeded (15), not the one LXD forgot (14).
			expect(starting.mock.calls.map((call) => [call[0], call[2]]).at(-1)).toEqual([id(15), "rebuild"]);
		});
		it("fails before its authority and its dispatch when the node no longer has the image, and the machine stays stopped", async () => {
			const { f, order, reconcile } = await stopped();
			f.client.hasImage.mockResolvedValueOnce(false);
			await expect(reconcile()).rejects.toThrow("CODING_MACHINE_IMAGE_GONE");
			expect(order).toEqual(["authorize:run", "starting:stop"]);
			expect(actions(f).map((action) => action.action)).toEqual(["create", "start", "stop"]);
			expect(f.instance()).toMatchObject({ status: "Stopped", statusCode: 102 });
			// Each turn fails so until the image is back; then the next one rebuilds.
			f.client.hasImage.mockResolvedValueOnce(false);
			await expect(reconcile()).rejects.toThrow("CODING_MACHINE_IMAGE_GONE");
			expect((await reconcile()).state).toBe("pending");
			expect(actions(f).at(-1)).toEqual(rebuild(f));
			// A client that can't look up images never rebuilds.
			const g = await stopped();
			const client = {
				getInstance: g.f.client.getInstance,
				submitInstanceOperation: g.f.client.submitInstanceOperation,
				inspectInstanceOperation: g.f.client.inspectInstanceOperation,
			};
			expect(
				(await reconcileCodingMachine({ ...g.f.options, client, desiredState: "running", starting: g.starting }))
					.state,
			).toBe("recovery-required");
			expect(actions(g.f).map((action) => action.action)).toEqual(["create", "start", "stop"]);
		});
		it("rolls over a full journal that ends with a rebuild before the start after it, or rebuilds again after a failed one", async () => {
			const f = await fixture();
			const root = await retainedHistory(f, 381, "succeeded", "rebuild");
			const starting = vi.fn(async (_afterOperationId: string, _signal: AbortSignal, _after: After) => undefined);
			const reconcile = (machine: typeof f) =>
				reconcileCodingMachine({ ...machine.options, desiredState: "running", starting });
			expect((await reconcile(f)).state).toBe("pending");
			expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
				segment: 1,
				previousEventCount: 381,
			});
			for (const expected of ["pending", "running"]) expect((await reconcile(f)).state).toBe(expected);
			// The start after the rollover is named by the old segment's last rebuild (its triplet 126).
			expect(starting.mock.calls.map((call) => [call[0], call[2]])).toEqual([[id(1126), "rebuild"]]);
			const g = await fixture();
			await retainedHistory(g, 381, "failed", "rebuild");
			for (const expected of ["pending", "pending", "pending", "running"])
				expect((await reconcile(g)).state).toBe(expected);
			// The retained history's own create and start, then the rebuild again (13) and the start after it.
			expect(actions(g).map((action) => action.action)).toEqual(["create", "start", "rebuild", "start"]);
			expect(starting.mock.calls.map((call) => [call[0], call[2]]).at(-1)).toEqual([id(13), "rebuild"]);
		});
		it("counts failed rebuilds in a row across the checkpoint a failed one closed its segment with", async () => {
			const f = await fixture();
			// The segment ends with two failed rebuilds (its triplets 125 and 126), after a stop.
			const root = await retainedHistory(f, 381, "failed", "rebuild", 2);
			const starting = vi.fn(async (_afterOperationId: string, _signal: AbortSignal, _after: After) => undefined);
			const reconcile = (desiredState: "running" | "deleted" = "running") =>
				reconcileCodingMachine({ ...f.options, desiredState, starting });
			f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
			const states: string[] = [];
			for (let attempt = 0; attempt < 4; attempt++) states.push((await reconcile()).state);
			// The rollover, the third rebuild, then its failure: the third in a row, so an operator is waited for.
			expect(states).toEqual(["pending", "pending", "recovery-required", "recovery-required"]);
			expect(JSON.parse(await readFile(join(root, "segment-000001", "checkpoint.json"), "utf8"))).toMatchObject({
				segment: 1,
				previousEventCount: 381,
			});
			expect(actions(f).map((action) => action.action)).toEqual(["create", "start", "rebuild"]);
			expect(starting).not.toHaveBeenCalled();
			// A record of the segment before that no longer matches the one after it is never counted.
			const g = await fixture();
			const gRoot = await retainedHistory(g, 381, "failed", "rebuild", 2);
			const reconcileG = () => reconcileCodingMachine({ ...g.options, desiredState: "running", starting });
			expect((await reconcileG()).state).toBe("pending");
			const record = JSON.parse(await readFile(join(gRoot, "000378.json"), "utf8"));
			await writeFile(join(gRoot, "000378.json"), `${JSON.stringify({ ...record, operationId: id(999) })}\n`);
			await expect(reconcileG()).rejects.toThrow("CODING_MACHINE_JOURNAL_INVALID");
			expect(actions(g).map((action) => action.action)).toEqual(["create", "start"]);
			// The machine is still stopped: a delete still goes.
			for (const expected of ["pending", "deleted"]) expect((await reconcile("deleted")).state).toBe(expected);
		});
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
