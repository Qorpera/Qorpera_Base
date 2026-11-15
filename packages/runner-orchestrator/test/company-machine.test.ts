import { chmod, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPlugCard, withAgentPlug } from "../src/agent-plug.ts";
import {
	type CodingMachineDesiredState,
	type CodingMachineIntent,
	reconcileCodingMachine,
} from "../src/coding-machine.ts";
import {
	assertLxdCompanyMachineInstance,
	type CompanyMachineRequestShape,
	type LxdCompanyMachineBinding,
	lxdCompanyMachineJournalPlan,
	lxdCompanyMachinePlan,
	parseCompanyMachinePolicy,
} from "../src/company-machine.ts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { testAgentPlug } from "./helpers/coding-machine.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function companyMachineBinding(overrides: Partial<LxdCompanyMachineBinding> = {}): LxdCompanyMachineBinding {
	return {
		schema: "qorpera.lxd-company-machine/v2",
		machineId: id(2),
		placementId: id(5),
		companyId: id(3),
		environmentId: id(4),
		providerId: "machine-node",
		providerPolicySha256: "a".repeat(64),
		project: "machines",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "machines",
		network: "qagent0",
		cpus: 8,
		memoryBytes: 32 * 1024 ** 3,
		rootDiskBytes: 100 * 1024 ** 3,
		...overrides,
	};
}
/** The instance LXD made from the request the agent plug completed. */
function instance(planned: ReturnType<typeof lxdCompanyMachinePlan>["request"]): LxdInstanceRecord {
	return made(withAgentPlug(planned, "network", "0e:51:0a:d2:01:07"));
}
function made(request: LxdCreateInstanceRequest): LxdInstanceRecord {
	return {
		name: request.name,
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		profiles: [],
		devices: structuredClone(request.devices),
		expandedDevices: structuredClone(request.devices),
		config: { ...request.config, "volatile.base_image": "b".repeat(64), "image.os": "ubuntu" },
		expandedConfig: { ...request.config, "volatile.base_image": "b".repeat(64), "image.os": "ubuntu" },
	};
}
/** Sets (or, with undefined, removes) a configuration key in the instance's own and expanded configuration. */
function configure(target: LxdInstanceRecord, key: string, value: string | undefined): LxdInstanceRecord {
	for (const config of [target.config, target.expandedConfig] as Record<string, string>[])
		if (value === undefined) delete config[key];
		else config[key] = value;
	return target;
}
/** What a later release may find on an instance an earlier one made: a configuration key it no longer sets, one it did
 * not set yet, a device it no longer adds. */
function drift(target: LxdInstanceRecord): LxdInstanceRecord {
	configure(target, "security.devlxd", undefined);
	configure(target, "limits.cpu.allowance", "50%");
	const devices = { ...target.devices, gpu: { type: "gpu", gputype: "virtio" } };
	return Object.assign(target, { devices, expandedDevices: structuredClone(devices) });
}

/** reconcileCodingMachine for a company machine's placement through a fake LXD that settles each effect when asked. */
async function lifecycle() {
	const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
	const journalRoot = await realpath(await mkdtemp(join(tmpdir(), "company-machine-")));
	await chmod(journalRoot, 0o700);
	roots.push(journalRoot);
	let current: LxdInstanceRecord | undefined;
	let pending: LxdTrackedInstanceAction | undefined;
	const client = {
		getInstance: vi.fn(async () => current),
		submitInstanceOperation: vi.fn(async (_project: string, action: LxdTrackedInstanceAction) => {
			pending = action;
			return {
				project: journal.project,
				instanceName: journal.name,
				operationId: id(100 + client.submitInstanceOperation.mock.calls.length),
			};
		}),
		inspectInstanceOperation: vi.fn(async (): Promise<"succeeded" | "pending" | "failed"> => {
			if (pending?.action === "create") current = { ...made(pending.request), status: "Stopped", statusCode: 102 };
			else if (pending?.action === "delete") current = undefined;
			else if (current && pending) stopped(pending.action !== "start");
			pending = undefined;
			return "succeeded";
		}),
	};
	const stopped = (yes: boolean) => {
		if (current)
			Object.assign(current, yes ? { status: "Stopped", statusCode: 102 } : { status: "Running", statusCode: 103 });
	};
	const reconcile = (desiredState: CodingMachineDesiredState) =>
		reconcileCodingMachine({
			plan: journal,
			journalRoot,
			desiredState,
			client,
			authorize: async (intent: CodingMachineIntent) => ({
				schema: "qorpera.coding-machine-admission/v1",
				machineId: journal.machineId,
				workerId: null,
				instanceSha256: journal.instanceSha256,
				intent,
				guestUid: null,
				validForMs: 5000,
				nodeId: id(9),
				nodeVersion: 1,
			}),
			signal: new AbortController().signal,
			plug: testAgentPlug,
		});
	return {
		journal,
		reconcile,
		/** Reconciles until the machine is no longer pending. */
		settle: async (desiredState: CodingMachineDesiredState) => {
			for (let attempt = 0; attempt < 6; attempt++) {
				const { state } = await reconcile(desiredState);
				if (state !== "pending") return state;
			}
			throw new Error("still pending");
		},
		client,
		instance: () => current,
		stopped,
		/** The journal's record at `sequence`. */
		record: (sequence: number) => join(journalRoot, journal.journalName, `${String(sequence).padStart(6, "0")}.json`),
		actions: () => client.submitInstanceOperation.mock.calls.map((call) => call[1].action),
	};
}

describe("company machine plan", () => {
	it("hashes the canonical binding text SQL pins (qorpera_company_machine_binding_text)", () => {
		const plan = lxdCompanyMachinePlan(companyMachineBinding());
		// The same text supabase/tests/628 asserts for this binding.
		expect(plan.text).toBe(
			`{"schema":"qorpera.lxd-company-machine/v2","machineId":"${id(2)}","placementId":"${id(5)}","companyId":"${id(3)}","environmentId":"${id(4)}",` +
				`"providerId":"machine-node","providerPolicySha256":"${"a".repeat(64)}","project":"machines","imageFingerprint":"${"b".repeat(64)}",` +
				`"bootstrapSha256":"${"c".repeat(64)}","storagePool":"machines","network":"qagent0","cpus":8,"memoryBytes":34359738368,` +
				`"rootDiskBytes":107374182400}`,
		);
		// Key order in the input never changes the text.
		const shuffled = Object.fromEntries(
			Object.entries(companyMachineBinding()).reverse(),
		) as unknown as LxdCompanyMachineBinding;
		expect(lxdCompanyMachinePlan(shuffled).instanceSha256).toBe(plan.instanceSha256);
	});

	it("creates exactly the placement SQL made: its size, its markers, its network and nothing else (the pinned shape)", () => {
		const { request, instanceSha256 } = lxdCompanyMachinePlan(companyMachineBinding());
		const moved =
			"The request a company machine is made with changed. Its instances live for months (a sleeping machine keeps " +
			"its disk and its instance), and a run takes an instance only as a shape made it: add the request as it was " +
			"before this change, written out, to EARLIER_COMPANY_MACHINE_REQUESTS (company-machine.ts), with a test that an " +
			"instance it made still runs; then update this pin. Never change the name or the user.qorpera.placement_id and " +
			"user.qorpera.instance_sha256 markers: a stop and a delete know the placement's instance by them alone.";
		expect(request, moved).toEqual({
			name: "qorpera-machine-00000000000040008000000000000005",
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: "b".repeat(64) },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"limits.cpu": "8",
				"limits.memory": "34359738368",
				"security.devlxd": "false",
				"user.qorpera.schema": "qorpera.lxd-company-machine/v2",
				"user.qorpera.machine_id": id(2),
				"user.qorpera.placement_id": id(5),
				"user.qorpera.allocation_id": id(5),
				"user.qorpera.company_id": id(3),
				"user.qorpera.environment_id": id(4),
				"user.qorpera.provider_id": "machine-node",
				"user.qorpera.instance_sha256": instanceSha256,
				"user.qorpera.provider_policy_sha256": "a".repeat(64),
				"user.qorpera.bootstrap_sha256": "c".repeat(64),
			},
			devices: {
				root: { type: "disk", path: "/", pool: "machines", size: "107374182400" },
				// On the agents' bridge; its MAC comes from the agent plug right before the create. Written out, so a change
				// of agentPlugCard moves the pin too.
				network: {
					type: "nic",
					nictype: "bridged",
					parent: "qagent0",
					name: "eth0",
					"ipv6.address": "none",
					"security.mac_filtering": "true",
					"security.ipv6_filtering": "true",
					"security.port_isolation": "true",
				},
			},
		});
	});

	it("refuses a v1 binding and v1's repository key: no disk of the node is attached (6e-1)", () => {
		const v1 = { ...companyMachineBinding(), schema: "qorpera.lxd-company-machine/v1" };
		for (const binding of [
			v1,
			{ ...v1, repositoryWorkerId: null },
			{ ...companyMachineBinding(), repositoryWorkerId: null },
		])
			expect(() => lxdCompanyMachinePlan(binding as unknown as LxdCompanyMachineBinding)).toThrow(
				"INVALID_COMPANY_MACHINE_BINDING",
			);
	});

	it.each([
		{ cpus: 65 },
		{ cpus: 0 },
		{ memoryBytes: 512 * 1024 ** 2 },
		{ memoryBytes: 3.5 * 1024 ** 3 },
		{ rootDiskBytes: 5 * 1024 ** 3 },
		{ network: "Bad Net" },
		{ network: "machine-net" },
		{ imageFingerprint: "x" },
		{ placementId: "placement" },
	])("refuses a binding outside its bounds: %o", (overrides) => {
		expect(() =>
			lxdCompanyMachinePlan(companyMachineBinding(overrides as Partial<LxdCompanyMachineBinding>)),
		).toThrow("INVALID_COMPANY_MACHINE");
	});

	it("journals and receipts the placement, not the machine: a new placement is a new instance", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		expect([journal.machineId, journal.journalName, journal.name]).toEqual([
			id(5),
			id(5),
			"qorpera-machine-00000000000040008000000000000005",
		]);
		const moved = lxdCompanyMachineJournalPlan(companyMachineBinding({ placementId: id(6) }));
		expect(moved.instanceSha256).not.toBe(journal.instanceSha256);
		expect(moved.name).not.toBe(journal.name);
	});

	it("refuses an instance anything was added to", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		const request = journal.request!;
		expect(() => journal.assertInstance(instance(request), "run")).not.toThrow();
		const extraDevice = instance(request);
		(extraDevice.devices as Record<string, Record<string, string>>).host = {
			type: "disk",
			source: "/",
			path: "/host",
		};
		expect(() => assertLxdCompanyMachineInstance(request, "b".repeat(64), extraDevice)).toThrow(
			"COMPANY_MACHINE_DRIFTED",
		);
		const extraConfig = instance(request);
		(extraConfig.config as Record<string, string>)["security.privileged"] = "true";
		expect(() => journal.assertInstance(extraConfig, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		const otherImage = instance(request);
		(otherImage.expandedConfig as Record<string, string>)["volatile.base_image"] = "e".repeat(64);
		expect(() => journal.assertInstance(otherImage, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		// Its agent card: a plug MAC, exactly the card's keys, on the agents' bridge.
		const cards: Record<string, string>[] = [
			{ ...agentPlugCard("eth0") },
			{ ...agentPlugCard("eth0"), hwaddr: "00:16:3e:00:00:01" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:00:07" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:07", parent: "machine-net" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:07", "ipv4.address": "10.210.1.7" },
			{ type: "nic", network: "machine-net", name: "eth0" },
		];
		for (const card of cards) {
			const other = instance(request);
			other.devices = { ...other.devices, network: card };
			other.expandedDevices = structuredClone(other.devices);
			expect(() => journal.assertInstance(other, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		}
	});

	it("gives the guest no /dev/lxd, and no pass ever reaches the machine's LXD config", () => {
		const pass = `qfp_${"z".repeat(40)}`;
		const { request } = lxdCompanyMachinePlan(companyMachineBinding());
		expect(request.config["security.devlxd"]).toBe("false");
		// Its config is its limits, its boot and the binding's markers: no key names a pass, secret or cloud-init.
		for (const key of Object.keys(request.config))
			expect(key).toMatch(
				/^(boot\.(mode|autostart)|limits\.(cpu|memory)|security\.devlxd|user\.qorpera\.[a-z0-9_]+)$/,
			);
		expect(Object.keys(request.config).filter((key) => /pass|secret|token|credential|cloud-init/i.test(key))).toEqual(
			[],
		);
		// A binding cannot carry one: its keys are exact.
		expect(() =>
			lxdCompanyMachinePlan({ ...companyMachineBinding(), pass } as unknown as LxdCompanyMachineBinding),
		).toThrow("INVALID_COMPANY_MACHINE_BINDING");
		// An instance that has /dev/lxd back, or that a pass was put into, has drifted.
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		for (const [key, value] of [
			["security.devlxd", "true"],
			["user.qorpera.pass", pass],
			["cloud-init.user-data", pass],
			["environment.QORPERA_FOLDER_PASS", pass],
		]) {
			const other = instance(journal.request!);
			(other.config as Record<string, string>)[key] = value;
			(other.expandedConfig as Record<string, string>)[key] = value;
			expect(() => journal.assertInstance(other, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		}
		const before = instance(journal.request!);
		delete (before.config as Record<string, string>)["security.devlxd"];
		delete (before.expandedConfig as Record<string, string>)["security.devlxd"];
		expect(() => journal.assertInstance(before, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
	});

	it("names its plug claim: the machine, its company and this placement's instance", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		expect(journal.agentPlug).toEqual({
			claim: {
				kind: "machine",
				companyId: id(3),
				machineId: id(2),
				memberUserId: null,
				project: "machines",
				instance: "qorpera-machine-00000000000040008000000000000005",
			},
			device: "network",
		});
	});

	it("reads a node policy only in its closed shape", () => {
		const policy = {
			providerId: "machine-node",
			providerPolicySha256: "a".repeat(64),
			project: "machines",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "machines",
			network: "qagent0",
		};
		expect(parseCompanyMachinePolicy(policy)).toEqual(policy);
		expect(() => parseCompanyMachinePolicy({ ...policy, network: "machine-net" })).toThrow(
			"INVALID_COMPANY_MACHINE_POLICY",
		);
		expect(() => parseCompanyMachinePolicy({ ...policy, cpus: 4 })).toThrow("INVALID_COMPANY_MACHINE_POLICY");
		expect(() => parseCompanyMachinePolicy({ ...policy, project: "../x" })).toThrow("INVALID_COMPANY_MACHINE_POLICY");
	});
});

describe("a company machine's instance made by an earlier release", () => {
	it("is stopped and deleted when it is the placement's own, whatever else differs, and never run", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		const request = journal.request!;
		const otherCard = instance(request);
		otherCard.devices = { ...otherCard.devices, network: { type: "nic", network: "machine-net", name: "eth0" } };
		otherCard.expandedDevices = structuredClone(otherCard.devices);
		for (const other of [
			drift(instance(request)),
			configure(instance(request), "security.devlxd", undefined),
			configure(instance(request), "volatile.base_image", "e".repeat(64)),
			otherCard,
			{ ...instance(request), profiles: ["default"] },
		]) {
			expect(() => journal.assertInstance(other, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
			expect(() => journal.assertInstance(other, "rebuild")).toThrow("COMPANY_MACHINE_DRIFTED");
			for (const intent of ["stop", "delete"] as const)
				expect(() => journal.assertInstance(other, intent)).not.toThrow();
		}
	});

	it("is refused for a stop and a delete too when it is not the placement's own", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding());
		const request = journal.request!;
		const ownOnly = (key: string, value: string) => {
			const other = instance(request);
			(other.config as Record<string, string>)[key] = value;
			return other;
		};
		const expandedOnly = (key: string, value: string) => {
			const other = instance(request);
			(other.expandedConfig as Record<string, string>)[key] = value;
			return other;
		};
		for (const other of [
			// Another placement's instance, and one of another binding for this placement (another size: another digest).
			instance(lxdCompanyMachinePlan(companyMachineBinding({ placementId: id(6) })).request),
			instance(lxdCompanyMachinePlan(companyMachineBinding({ cpus: 4 })).request),
			{ ...instance(request), name: "qorpera-machine-00000000000040008000000000000006" },
			{ ...instance(request), type: "container" as const },
			ownOnly("user.qorpera.placement_id", id(6)),
			expandedOnly("user.qorpera.placement_id", id(6)),
			ownOnly("user.qorpera.instance_sha256", "f".repeat(64)),
			expandedOnly("user.qorpera.instance_sha256", "f".repeat(64)),
			configure(instance(request), "user.qorpera.placement_id", undefined),
			configure(instance(request), "user.qorpera.instance_sha256", undefined),
		])
			for (const intent of ["run", "stop", "delete"] as const)
				expect(() => journal.assertInstance(other, intent)).toThrow("COMPANY_MACHINE_DRIFTED");
	});

	it("runs only when one earlier shape made it, exactly, from the same binding; new ones are made in the current shape", () => {
		// A made-up earlier shape: before /dev/lxd was closed, with a device since dropped.
		const beforeDevlxd: CompanyMachineRequestShape = (binding) => {
			const { request } = lxdCompanyMachinePlan(binding as LxdCompanyMachineBinding);
			const config = Object.fromEntries(Object.entries(request.config).filter(([key]) => key !== "security.devlxd"));
			return { ...request, config, devices: { ...request.devices, gpu: { type: "gpu", gputype: "virtio" } } };
		};
		const today = lxdCompanyMachineJournalPlan(companyMachineBinding());
		const kept = lxdCompanyMachineJournalPlan(companyMachineBinding(), [beforeDevlxd]);
		const old = instance(beforeDevlxd(lxdCompanyMachinePlan(companyMachineBinding()).binding, kept.instanceSha256));
		expect(old.config["security.devlxd"]).toBeUndefined();
		expect(() => today.assertInstance(old, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		for (const intent of ["run", "rebuild", "stop", "delete"] as const) {
			expect(() => kept.assertInstance(old, intent)).not.toThrow();
			expect(() => kept.assertInstance(instance(kept.request!), intent)).not.toThrow();
		}
		// Nothing else: the old shape with anything added, half of one shape and half of the other, or the old shape of
		// another binding for this placement.
		const half = instance(today.request!);
		Object.assign(half, { devices: old.devices, expandedDevices: old.expandedDevices });
		for (const other of [
			configure(instance(beforeDevlxd(lxdCompanyMachinePlan(companyMachineBinding()).binding, "")), "x.y", "z"),
			half,
			instance(beforeDevlxd(lxdCompanyMachinePlan(companyMachineBinding({ cpus: 4 })).binding, "")),
		])
			expect(() => kept.assertInstance(other, "run")).toThrow("COMPANY_MACHINE_DRIFTED");
		expect(kept.request).toEqual(today.request);
	});

	it("is stopped and deleted through the journal while a run of it keeps failing", async () => {
		const f = await lifecycle();
		expect(await f.settle("running")).toBe("running");
		drift(f.instance()!);
		await expect(f.reconcile("running")).rejects.toThrow("COMPANY_MACHINE_DRIFTED");
		expect(await f.settle("stopped")).toBe("stopped");
		expect(f.instance()?.status).toBe("Stopped");
		await expect(f.reconcile("running")).rejects.toThrow("COMPANY_MACHINE_DRIFTED");
		expect(await f.settle("deleted")).toBe("deleted");
		expect(f.instance()).toBeUndefined();
		expect(f.actions()).toEqual(["create", "start", "stop", "delete"]);
	});

	it("is never stopped or deleted through the journal when it is not the placement's own", async () => {
		const f = await lifecycle();
		expect(await f.settle("running")).toBe("running");
		configure(f.instance()!, "user.qorpera.instance_sha256", "f".repeat(64));
		await expect(f.reconcile("stopped")).rejects.toThrow("COMPANY_MACHINE_DRIFTED");
		f.stopped(true);
		await expect(f.reconcile("deleted")).rejects.toThrow("COMPANY_MACHINE_DRIFTED");
		expect(f.actions()).toEqual(["create", "start"]);
	});

	it("settles a stop LXD forgot, or never confirmed, from the instance, and deletes it again after a failed delete", async () => {
		// A stop LXD finished and forgot.
		const f = await lifecycle();
		expect(await f.settle("running")).toBe("running");
		drift(f.instance()!);
		expect((await f.reconcile("stopped")).state).toBe("pending");
		f.client.inspectInstanceOperation.mockImplementationOnce(async () => {
			f.stopped(true);
			throw new Error("LXD_OPERATION_UNKNOWN");
		});
		expect((await f.reconcile("stopped")).state).toBe("stopped");
		// A delete that failed is issued again.
		expect((await f.reconcile("deleted")).state).toBe("pending");
		f.client.inspectInstanceOperation.mockResolvedValueOnce("failed");
		expect((await f.reconcile("deleted")).state).toBe("pending");
		expect(await f.settle("deleted")).toBe("deleted");
		expect(f.actions()).toEqual(["create", "start", "stop", "delete", "delete"]);
		// A stop whose submission never came back is settled from the instance once any operation it started is over.
		const g = await lifecycle();
		expect(await g.settle("running")).toBe("running");
		drift(g.instance()!);
		g.client.submitInstanceOperation.mockRejectedValueOnce(new Error("socket hang up"));
		expect((await g.reconcile("stopped")).state).toBe("recovery-required");
		g.stopped(true);
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(g.record(6), old, old);
		expect((await g.reconcile("stopped")).state).toBe("stopped");
		expect(g.actions()).toEqual(["create", "start", "stop"]);
	});
});
