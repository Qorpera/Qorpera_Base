import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertLxdCodingVmInstance,
	type CodingVmAdmissionReceipt,
	type LxdCodingVmBinding,
	lxdCodingVmPlan,
	reconcileLxdCodingVm,
} from "../src/coding-vm.ts";
import type { LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { codingStorageFixture } from "./helpers/coding-storage.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function binding(): LxdCodingVmBinding {
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
async function fixture() {
	const journalRoot = await realpath(await mkdtemp(join(tmpdir(), "coding-vm-")));
	await chmod(journalRoot, 0o700);
	roots.push(journalRoot);
	const value = binding();
	const plan = lxdCodingVmPlan(value);
	let instance: LxdInstanceRecord | undefined;
	let pending: LxdTrackedInstanceAction | undefined;
	const client = {
		getInstance: vi.fn(async () => instance),
		submitInstanceOperation: vi.fn(
			async (_project: string, action: LxdTrackedInstanceAction, _signal: AbortSignal) => {
				pending = action;
				return {
					project: value.project,
					instanceName: plan.request.name,
					operationId: id(10 + client.submitInstanceOperation.mock.calls.length),
				};
			},
		),
		inspectInstanceOperation: vi.fn(async (): Promise<"succeeded" | "pending" | "failed"> => {
			if (pending?.action === "create") {
				instance = {
					name: plan.request.name,
					type: "virtual-machine",
					status: "Stopped",
					statusCode: 102,
					profiles: [],
					devices: structuredClone(plan.request.devices),
					expandedDevices: structuredClone(plan.request.devices),
					config: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
					expandedConfig: { ...plan.request.config, "volatile.base_image": value.imageFingerprint },
				};
			} else if (instance && pending) {
				instance.status = pending.action === "start" ? "Running" : "Stopped";
				instance.statusCode = pending.action === "start" ? 103 : 102;
			}
			return "succeeded";
		}),
	};
	const controller = new AbortController();
	const authorize = vi.fn(
		async (_binding: Readonly<LxdCodingVmBinding>, intent: "run" | "stop"): Promise<CodingVmAdmissionReceipt> => ({
			schema: "qorpera.coding-vm-admission/v1",
			workerId: value.workerId,
			allocationId: value.allocationId,
			instanceSha256: plan.instanceSha256,
			intent,
			validForMs: 5000,
			nodeId: id(5),
			nodeVersion: 1,
		}),
	);
	const options = {
		binding: value,
		journalRoot,
		desiredState: "running" as const,
		client,
		admission: { authorize },
		signal: controller.signal,
	};
	return {
		value,
		plan,
		client,
		authorize,
		controller,
		journalRoot,
		options,
		reconcile: (desiredState: "running" | "stopped" = "running") =>
			reconcileLxdCodingVm({ ...options, desiredState }),
		instance: () => instance,
	};
}

async function retainedHistory(f: Awaited<ReturnType<typeof fixture>>, count: 381 | 384) {
	await f.reconcile();
	await f.reconcile();
	await f.reconcile();
	const root = join(f.journalRoot, f.value.workerId);
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
				state: phase === 2 ? "succeeded" : null,
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

describe("retained coding VM lifecycle", () => {
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
	it("pins repository, branch, resources, NAS mounts and image without inherited profiles or identity mounts", () => {
		const plan = lxdCodingVmPlan(binding());
		expect(plan.request.profiles).toEqual([]);
		expect(Object.keys(plan.request.devices).sort()).toEqual(["custody", "data", "network", "root"]);
		expect(plan.request.name).toBe(`qorpera-coding-${id(1).replaceAll("-", "")}`);
		expect(plan.request.config["user.qorpera.branch"]).toBe(`qorpera/coding/${id(1)}`);
		expect(plan.request.config["boot.autostart"]).toBe("false");
		expect(
			lxdCodingVmPlan({ ...binding(), repository: { ...binding().repository, name: "other" } }).instanceSha256,
		).not.toBe(plan.instanceSha256);
	});
	it.each([
		{ profiles: ["default"] },
		{ imageFingerprint: "latest" },
		{ cpus: 65 },
		{ network: "../other" },
		{ workerId: "bad" },
		{ rootDiskBytes: Infinity },
		{ computeIdentityPath: "/secret" },
	])("rejects inadmissible binding %j", (patch) => {
		expect(() => lxdCodingVmPlan({ ...binding(), ...patch })).toThrow("INVALID_CODING_VM_BINDING");
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
	it("refuses repository retargeting with the same worker identity", async () => {
		const f = await fixture();
		await f.reconcile();
		f.value.repository = { ...f.value.repository, name: "elsewhere" };
		f.authorize.mockImplementation(async (_binding, intent) => ({
			schema: "qorpera.coding-vm-admission/v1",
			workerId: f.value.workerId,
			allocationId: f.value.allocationId,
			instanceSha256: lxdCodingVmPlan(f.value).instanceSha256,
			intent,
			validForMs: 5000,
			nodeId: id(5),
			nodeVersion: 1,
		}));
		await expect(f.reconcile()).rejects.toThrow("CODING_VM_BINDING_CONFLICT");
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
		expect(() => assertLxdCodingVmInstance(f.value, instance)).toThrow("CODING_VM_DRIFTED");
		await expect(f.reconcile()).rejects.toThrow("CODING_VM_DRIFTED");
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
		f.authorize.mockResolvedValue({
			schema: "qorpera.coding-vm-admission/v1",
			workerId: id(100),
			allocationId: f.value.allocationId,
			instanceSha256: f.plan.instanceSha256,
			intent: "run",
			validForMs: 5000,
			nodeId: id(5),
			nodeVersion: 1,
		});
		await expect(f.reconcile()).rejects.toThrow("CODING_VM_ADMISSION_UNCONFIRMED");
		expect(f.client.getInstance).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("fresh dispatch authorization can revoke an earlier successful admission", async () => {
		const f = await fixture();
		f.authorize
			.mockImplementationOnce(async (_binding, intent) => ({
				schema: "qorpera.coding-vm-admission/v1",
				workerId: f.value.workerId,
				allocationId: f.value.allocationId,
				instanceSha256: f.plan.instanceSha256,
				intent,
				validForMs: 5000,
				nodeId: id(5),
				nodeVersion: 1,
			}))
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
		const accepted = JSON.parse(await readFile(join(f.journalRoot, f.value.workerId, "000001.json"), "utf8"));
		expect(accepted.kind).toBe("accepted");
		expect(accepted.operationId).toBe(id(11));
	});
	it("rejects a symlinked journal and performs no LXD calls", async () => {
		const f = await fixture();
		const other = await mkdtemp(join(tmpdir(), "coding-vm-other-"));
		roots.push(other);
		await symlink(other, join(f.journalRoot, f.value.workerId));
		await expect(f.reconcile()).rejects.toThrow("JOURNAL_DIRECTORY_UNSAFE");
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it("keeps private immutable lifecycle records", async () => {
		const f = await fixture();
		await f.reconcile();
		expect((await readdir(join(f.journalRoot, f.value.workerId))).sort()).toEqual([
			"000000.json",
			"000001.json",
			"binding.json",
		]);
	});
});
