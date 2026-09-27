import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineAdmissionReceipt,
	type CodingMachineIntent,
	type CodingMachineJournalPlan,
	type LxdCodingMachineBinding,
	lxdCodingMachineJournalPlan,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
	reconcileCodingMachine,
} from "../src/coding-machine.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan, lxdLegacyCodingMachineJournalPlan } from "../src/coding-vm.ts";
import type { LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
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
		network: "coding-net",
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
	const fake = lxd(value.project, plan.request.name, () => ({
		name: plan.request.name,
		type: "virtual-machine",
		status: "Stopped",
		statusCode: 102,
		profiles: [],
		devices: structuredClone(plan.request.devices),
		expandedDevices: structuredClone(plan.request.devices),
		config: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
		expandedConfig: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
	}));
	const client = fake.client;
	const controller = new AbortController();
	const authorize = vi.fn(receiptFor(journal));
	const options = {
		plan: journal,
		journalRoot,
		desiredState: "running" as const,
		client,
		authorize,
		signal: controller.signal,
	};
	return {
		value,
		plan,
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

async function retainedHistory(
	f: Awaited<ReturnType<typeof fixture>>,
	count: 381 | 384,
	lastState: "succeeded" | "failed" = "succeeded",
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
				action: sequence < 3 ? "create" : Math.floor(sequence / 3) % 2 ? "start" : "stop",
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
	it("does not restart externally stopped VM using historical start evidence", async () => {
		const f = await fixture();
		await f.reconcile();
		await f.reconcile();
		await f.reconcile();
		const instance = f.instance();
		if (!instance) throw new Error("missing fixture VM");
		instance.status = "Stopped";
		instance.statusCode = 102;
		expect((await f.reconcile()).state).toBe("recovery-required");
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
		{ machineId: "bad" },
		{ memberUserId: "bad" },
		{ rootDiskBytes: Infinity },
		{ storage: {} },
	])("rejects inadmissible binding %j", (patch) => {
		expect(() => lxdCodingMachinePlan({ ...binding(), ...patch })).toThrow("INVALID_CODING_MACHINE_BINDING");
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
				{ action: "create", request: f.plan.request },
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
