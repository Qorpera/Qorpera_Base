import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingControlBusy } from "../src/coding-executor.ts";
import type { CodingMachineIntent } from "../src/coding-machine.ts";
import { type LxdCompanyMachineBinding, lxdCompanyMachinePlan } from "../src/company-machine.ts";
import { type CompanyMachineEntry, LxdCompanyMachineHost } from "../src/company-machine-host.ts";
import type { LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { testAgentMac, testAgentPlug } from "./helpers/coding-machine.ts";

const state = vi.hoisted(() => ({ controlPath: "" }));
vi.mock("../src/coding-storage.ts", () => ({
	createCodingNasStorage: () => ({
		get controlPath() {
			return state.controlPath;
		},
		assertControl: async () => {},
		prepareControl: async () => state.controlPath,
		prepare: async () => {},
		assert: async () => {},
	}),
}));

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const helper = Buffer.from("machine helper bytes");
const helperSha256 = createHash("sha256").update(helper).digest("hex");
const policy = {
	providerId: "machine-node",
	providerPolicySha256: "a".repeat(64),
	project: "machines",
	imageFingerprint: "b".repeat(64),
	bootstrapSha256: "c".repeat(64),
	storagePool: "machines",
	network: "qagent0",
};
function binding(): LxdCompanyMachineBinding {
	return {
		schema: "qorpera.lxd-company-machine/v1",
		machineId: id(2),
		placementId: id(6),
		companyId: id(3),
		environmentId: id(4),
		...policy,
		cpus: 4,
		memoryBytes: 8 * 1024 ** 3,
		rootDiskBytes: 40 * 1024 ** 3,
		repositoryWorkerId: null,
	};
}

/** SQL's side: one machine as the executor's list shows it, and every call recorded. */
async function fixture(pins: { helperSha256?: string; previousHelperSha256s?: string[] } = {}) {
	state.controlPath = await realpath(await mkdtemp(join(tmpdir(), "company-machine-host-")));
	await chmod(state.controlPath, 0o700);
	roots.push(state.controlPath);
	const plan = lxdCompanyMachinePlan(binding());
	const boot = randomUUID();
	const entry: CompanyMachineEntry & { schema: string } = {
		schema: "qorpera.company-machine-state/v2",
		machineId: id(2),
		placementId: id(6),
		retired: false,
		binding: binding(),
		bindingText: plan.text,
		instanceSha256: plan.instanceSha256,
		desiredState: "running",
		lifetime: "task",
		reserved: true,
		asleepSince: null,
		removing: false,
		released: false,
		runningAt: null,
		bootId: null,
		commands: [],
		sleepDue: false,
		stopDue: false,
		removeDue: false,
	};
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const refusals = new Map<string, string>();
	const admissions: unknown[] = [];
	/** Methods whose company locks stay busy past SQL's short wait. */
	const busy = new Set<string>();
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			calls.push({ method, args });
			if (busy.has(method)) throw new CodingControlBusy();
			if (method === "qorpera_admit_executor_machines") {
				const next = admissions.shift() ?? [];
				if (next instanceof Error) throw next;
				return next;
			}
			if (method === "qorpera_list_executor_machines") return [structuredClone(entry)];
			if (method === "qorpera_authorize_executor_machine") {
				const intent = args.p_intent as CodingMachineIntent;
				if (refusals.has(intent)) return { state: "refused", reason: refusals.get(intent) };
				return {
					schema: "qorpera.coding-machine-admission/v1",
					machineId: id(6),
					workerId: null,
					instanceSha256: plan.instanceSha256,
					intent,
					guestUid: null,
					validForMs: 5000,
					nodeId: id(5),
					nodeVersion: 1,
				};
			}
			if (method === "qorpera_mark_company_machine_running") return { state: "running" };
			if (method === "qorpera_suspend_company_machine") return { state: "suspended" };
			if (method === "qorpera_release_company_machine") return { state: "released" };
			return null;
		}),
	};
	// LXD with one VM and a guest whose helper answers through reply files.
	let instance: LxdInstanceRecord | undefined;
	let pending: LxdTrackedInstanceAction | undefined;
	const replies = new Map<string, unknown>();
	let observed: unknown = { at: 0, cpuUsec: 0, ioBytes: 0, ended: [] };
	/** What the guest's helper lists at a stop. */
	let stopped: unknown = { commands: [], containers: false };
	const client = {
		getInstance: vi.fn(async () => instance),
		submitInstanceOperation: vi.fn(async (_project: string, action: LxdTrackedInstanceAction) => {
			pending = action;
			return { project: "machines", instanceName: plan.request.name, operationId: randomUUID() };
		}),
		inspectInstanceOperation: vi.fn(async (): Promise<"succeeded" | "pending" | "failed"> => {
			if (pending?.action === "create")
				// LXD makes the machine from the request the agent plug completed.
				instance = {
					name: plan.request.name,
					type: "virtual-machine",
					status: "Stopped",
					statusCode: 102,
					profiles: [],
					devices: structuredClone(pending.request.devices),
					expandedDevices: structuredClone(pending.request.devices),
					config: { ...plan.request.config, "volatile.base_image": policy.imageFingerprint },
					expandedConfig: { ...plan.request.config, "volatile.base_image": policy.imageFingerprint },
				};
			else if (pending?.action === "delete") instance = undefined;
			else if (instance && pending) {
				instance.status = pending.action === "start" ? "Running" : "Stopped";
				instance.statusCode = pending.action === "start" ? 103 : 102;
			}
			pending = undefined;
			return "succeeded";
		}),
		execInstance: vi.fn(async (_project: string, _name: string, command: readonly string[]) => {
			if (command[0] !== "/usr/bin/node") return;
			const [nonce, action, ...args] = command.slice(2);
			replies.set(
				nonce,
				action === "prepare"
					? { schema: "qorpera.machine-guest/v1", machineId: args[0], bootId: boot, generation: Number(args[1]) }
					: action === "refresh-lease"
						? {
								schema: "qorpera.machine-guest-lease-receipt/v1",
								machineId: id(2),
								bootId: boot,
								validForMs: Number(args[0]),
							}
						: action === "observe"
							? {
									schema: "qorpera.machine-observation/v2",
									machineId: id(2),
									bootId: boot,
									...(observed as object),
								}
							: action === "stop-commands"
								? {
										schema: "qorpera.machine-commands-stopped/v1",
										machineId: id(2),
										bootId: boot,
										...(stopped as object),
									}
								: {
										schema: "qorpera.machine-command-result/v1",
										machineId: id(2),
										commandId: args[0],
										inputSha256: "e".repeat(64),
										state: "running",
										exitCode: null,
										output: "",
										truncated: false,
										log: {
											offset: 0,
											nextOffset: 0,
											totalBytes: 0,
											limitBytes: 67108864,
											limitReached: false,
										},
									},
			);
		}),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => {
			if (path === "/opt/qorpera-machine/cloud-machine-guest.mjs")
				return { content: helper, uid: 0, gid: 0, mode: 0o444 };
			const nonce = /\/replies\/([0-9a-f-]{36})\.json$/.exec(path)?.[1];
			if (!nonce || !replies.has(nonce)) throw new Error("LXD instance file unavailable");
			return { content: Buffer.from(JSON.stringify(replies.get(nonce))), uid: 0, gid: 0, mode: 0o600 };
		}),
		pushInstanceFile: vi.fn(async () => {}),
	};
	const agentPlug = vi.fn(testAgentPlug);
	const host = new LxdCompanyMachineHost({
		control,
		owner: "mx-a",
		machineIdSha256: "d".repeat(64),
		policy,
		client,
		journalRoot: state.controlPath,
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/nas",
			rootPath: "/nas/coding",
			source: "10.0.0.2:/coding",
			serverAddress: "10.0.0.2",
		},
		helperSha256,
		agentPlug,
		...pins,
	});
	const signal = new AbortController().signal;
	return {
		entry,
		calls,
		refusals,
		admissions,
		busy,
		client,
		host,
		agentPlug,
		signal,
		boot,
		instance: () => instance,
		observe: (value: unknown) => {
			observed = value;
		},
		snapshot: (value: unknown) => {
			stopped = value;
		},
		methods: () => calls.map((call) => call.method),
	};
}

describe("company machine host", () => {
	it("creates and starts a wanted machine, claims its boot for it and tells SQL it runs", async () => {
		const f = await fixture();
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.instance()?.status).toBe("Running");
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
		// Plugged into the node's agent exit right before the create: the card carries the plug's MAC.
		expect(f.agentPlug).toHaveBeenCalledTimes(1);
		expect(f.agentPlug.mock.calls[0][0]).toMatchObject({ kind: "machine", machineId: id(2), companyId: id(3) });
		expect(f.instance()?.devices.network?.hwaddr).toBe(testAgentMac);
		const execs = f.client.execInstance.mock.calls.map((call) => call[2].slice(3));
		expect(execs).toEqual([
			["prepare", id(2), expect.stringMatching(/^\d+$/)],
			["refresh-lease", "900000"],
		]);
		const marked = f.calls.find((call) => call.method === "qorpera_mark_company_machine_running");
		expect(marked?.args).toMatchObject({
			p_placement_id: id(6),
			p_owner: "mx-a",
			p_binding_text: f.entry.bindingText,
			p_boot_id: f.boot,
		});
		// Every LXD effect was covered by run authority.
		expect(
			f.calls
				.filter((call) => call.method === "qorpera_authorize_executor_machine")
				.every((call) => call.args.p_intent === "run"),
		).toBe(true);
	});

	it("keeps a running machine's lease and records the commands that ended, and a busy machine as used", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		f.entry.bootId = f.boot;
		f.entry.runningAt = new Date().toISOString();
		f.entry.commands = [id(7), id(8)];
		const recorded = () => f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").at(-1);
		/** The whole machine's work apart from its own control, every 10 s. */
		const sample = (seconds: number, cpu: number, io: number) => ({
			at: seconds * 1000,
			cpuUsec: Math.round(cpu * 1e6),
			ioBytes: io,
			ended: [],
		});
		f.observe({
			...sample(10, 1, 0),
			ended: [
				{ commandId: id(7), state: "failed", exitCode: 2, outputTail: "1 failing" },
				{ commandId: id(9), state: "lost", exitCode: null, outputTail: "" },
			],
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		// A command SQL does not list is never reported; the first sample has nothing to compare with.
		expect(recorded()?.args).toMatchObject({
			p_boot_id: f.boot,
			p_ended: [{ commandId: id(7), state: "failed", exitCode: 2, outputTail: "1 failing" }],
			p_busy: false,
		});
		// 0.5 processor-seconds in 10 s, 5% of one core: busy.
		f.observe(sample(20, 1.5, 0));
		await f.host.pass(f.signal);
		expect(recorded()?.args).toMatchObject({ p_ended: [], p_busy: true });
		// Little processor, but 200 KB moved in 10 s (more than 512 KiB in 30): busy by its data.
		f.observe(sample(30, 1.6, 200_000));
		await f.host.pass(f.signal);
		expect(recorded()?.args).toMatchObject({ p_busy: true });
		// A machine that only waits: nothing to record.
		f.observe(sample(40, 1.7, 200_100));
		const before = f.calls.length;
		await f.host.pass(f.signal);
		expect(f.calls.slice(before).some((call) => call.method === "qorpera_record_company_machine_commands")).toBe(
			false,
		);
		// A reply that is not the measured shape is refused.
		f.observe({ ...sample(50, 2, 0), cpuUsec: -1 });
		expect((await f.host.pass(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_GUEST_REPLY_INVALID",
		});
	});

	it("carries a busy machine a record did not reach SQL with to the next pass", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot });
		f.observe({ at: 10_000, cpuUsec: 0, ioBytes: 0, ended: [] });
		await f.host.pass(f.signal);
		f.observe({ at: 20_000, cpuUsec: 5_000_000, ioBytes: 0, ended: [] });
		f.busy.add("qorpera_record_company_machine_commands");
		await f.host.pass(f.signal);
		f.busy.delete("qorpera_record_company_machine_commands");
		// The next pass is quiet, but still owes SQL the busy machine.
		f.observe({ at: 30_000, cpuUsec: 5_000_000, ioBytes: 0, ended: [] });
		await f.host.pass(f.signal);
		const records = f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands");
		expect(records.at(-1)?.args).toMatchObject({ p_busy: true });
		// Once taken, it is owed no more.
		f.observe({ at: 40_000, cpuUsec: 5_000_000, ioBytes: 0, ended: [] });
		const before = records.length;
		await f.host.pass(f.signal);
		expect(f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands")).toHaveLength(before);
	});

	it("takes a last look before a sleep, so a machine busy again keeps running", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.observe({ at: 10_000, cpuUsec: 0, ioBytes: 0, ended: [] });
		await f.host.pass(f.signal);
		f.observe({
			at: 20_000,
			cpuUsec: 3_000_000,
			ioBytes: 0,
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "done" }],
		});
		f.entry.sleepDue = true;
		f.refusals.set("stop", "MACHINE_IN_USE");
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "not-now" }]);
		const methods = f.methods();
		const recordedAt = methods.lastIndexOf("qorpera_record_company_machine_commands");
		expect(recordedAt).toBeGreaterThan(-1);
		expect(recordedAt).toBeLessThan(methods.lastIndexOf("qorpera_authorize_executor_machine"));
		expect(f.calls[recordedAt].args).toMatchObject({
			p_ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "done" }],
			p_busy: true,
		});
		expect(f.client.execInstance.mock.calls.some((call) => call[2][3] === "stop-commands")).toBe(false);
	});

	it("leaves the machine running when the last look's record does not reach SQL", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot });
		f.observe({ at: 10_000, cpuUsec: 0, ioBytes: 0, ended: [] });
		await f.host.pass(f.signal);
		f.observe({ at: 20_000, cpuUsec: 3_000_000, ioBytes: 0, ended: [] });
		f.entry.sleepDue = true;
		f.busy.add("qorpera_record_company_machine_commands");
		await f.host.pass(f.signal);
		expect(
			f.calls.some((call) => call.method === "qorpera_authorize_executor_machine" && call.args.p_intent === "stop"),
		).toBe(false);
		expect(f.instance()?.status).toBe("Running");
	});

	it("still sleeps when the guest does not answer its last look", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		await f.host.pass(f.signal);
		f.observe(null);
		f.entry.sleepDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.methods()).not.toContain("qorpera_record_company_machine_commands");
		expect(f.methods()).toContain("qorpera_suspend_company_machine");
	});

	it("puts a machine to sleep under stop authority: the guest's snapshot reaches SQL before the power-off", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { sleepDue: true, runningAt: new Date().toISOString(), bootId: f.boot });
		f.snapshot({ commands: [id(7), id(8)], containers: true });
		// How many control calls were made when LXD was asked to power the machine off.
		let callsAtPowerOff = -1;
		const submit = f.client.submitInstanceOperation.getMockImplementation()!;
		f.client.submitInstanceOperation.mockImplementation(async (project: string, action: LxdTrackedInstanceAction) => {
			if (action.action === "stop") callsAtPowerOff = f.calls.length;
			return submit(project, action);
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.instance()?.status).toBe("Stopped");
		expect(f.client.submitInstanceOperation.mock.calls.at(-1)?.[1]).toMatchObject({ action: "stop", force: true });
		// The guest's helper lists what runs and stops it (and syncs its disk) first.
		expect(f.client.execInstance.mock.calls.at(-1)?.[2].slice(3)).toEqual(["stop-commands"]);
		const methods = f.methods();
		const stoppedAt = methods.indexOf("qorpera_record_company_machine_stop");
		expect(stoppedAt).toBeGreaterThan(
			f.calls.findIndex(
				(call) => call.method === "qorpera_authorize_executor_machine" && call.args.p_intent === "stop",
			),
		);
		expect(stoppedAt).toBeLessThan(callsAtPowerOff);
		expect(f.calls[stoppedAt].args).toMatchObject({
			p_placement_id: id(6),
			p_boot_id: f.boot,
			p_commands: [id(7), id(8)],
			p_containers: true,
		});
	});

	it("stops a guest whose helper cannot list what runs as before, and tells SQL nothing of it", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { sleepDue: true, runningAt: new Date().toISOString(), bootId: f.boot });
		const original = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			if (command[3] === "stop-commands") throw new Error("LXD exec failed");
			return original(project, name, command);
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.client.execInstance.mock.calls.at(-1)?.[2]).toEqual([
			"/bin/sh",
			"-c",
			"systemctl stop qorpera-machine.slice docker.service containerd.service; sync",
		]);
		expect(f.methods()).not.toContain("qorpera_record_company_machine_stop");
		expect(f.methods()).toContain("qorpera_suspend_company_machine");
	});

	it("never powers off before SQL took the stop's snapshot, and leaves out a snapshot it cannot read", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { sleepDue: true, runningAt: new Date().toISOString(), bootId: f.boot });
		f.snapshot({ commands: [id(7)], containers: false });
		f.busy.add("qorpera_record_company_machine_stop");
		await f.host.pass(f.signal);
		expect(f.instance()?.status).toBe("Running");
		expect(f.methods()).not.toContain("qorpera_suspend_company_machine");
		f.busy.delete("qorpera_record_company_machine_stop");
		// A snapshot that is not the listed shape, or of another boot, is not SQL's: the machine still sleeps, and what
		// ran is told at its power-off.
		for (const broken of [
			{ commands: ["not-a-command"], containers: false },
			{ commands: Array.from({ length: 33 }, () => id(7)), containers: false },
			{ commands: [], containers: "yes" },
			{ commands: [], containers: false, bootId: randomUUID() },
		]) {
			f.snapshot(broken);
			const before = f.calls.length;
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
			expect(f.calls.slice(before).map((call) => call.method)).not.toContain("qorpera_record_company_machine_stop");
			expect(f.calls.slice(before).map((call) => call.method)).toContain("qorpera_suspend_company_machine");
		}
	});

	it("measures afresh after a stop whose power-off did not happen", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot });
		f.observe({ at: 10_000, cpuUsec: 0, ioBytes: 0, ended: [] });
		await f.host.pass(f.signal);
		// The stop's helper ends a busy container, then a member wakes the machine before its power-off (SQL refuses it).
		f.observe({ at: 20_000, cpuUsec: 0, ioBytes: 0, ended: [] });
		f.entry.sleepDue = true;
		f.snapshot({ commands: [], containers: true });
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			if (command[3] === "stop-commands") f.refusals.set("stop", "MACHINE_WANTED_RUNNING");
			return exec(project, name, command);
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "not-now" }]);
		expect(f.instance()?.status).toBe("Running");
		// What the container used until the stop ended it is not busy work after it: the next look starts afresh.
		f.entry.sleepDue = false;
		f.observe({ at: 30_000, cpuUsec: 9_000_000, ioBytes: 0, ended: [] });
		const before = f.calls.length;
		await f.host.pass(f.signal);
		expect(f.calls.slice(before).some((call) => call.method === "qorpera_record_company_machine_commands")).toBe(
			false,
		);
	});

	it("keeps a running machine's lease and watches its commands while SQL refuses new run authority", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.refusals.set("run", "NODE_OBSERVATION_UNAVAILABLE");
		f.observe({
			at: 10_000,
			cpuUsec: 0,
			ioBytes: 0,
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }],
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		expect(f.client.execInstance.mock.calls.slice(-2).map((call) => call[2][3])).toEqual([
			"refresh-lease",
			"observe",
		]);
		expect(f.calls.at(-1)?.method).toBe("qorpera_record_company_machine_commands");
		// A machine that is not running is never started without it.
		f.refusals.set("run", "NODE_DISABLED");
		Object.assign(f.entry, { runningAt: null, bootId: null });
		await f.host.pass(f.signal);
		f.client.execInstance.mockClear();
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "not-now" }]);
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});

	it("settles a VM that stopped by itself from LXD's view: a run starts it again, a delete deletes it", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		// root inside ran poweroff (or the node rebooted)
		Object.assign(f.instance() as object, { status: "Stopped", statusCode: 102 });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.instance()?.status).toBe("Running");
		Object.assign(f.instance() as object, { status: "Stopped", statusCode: 102 });
		Object.assign(f.entry, { desiredState: "deleted", removeDue: true, reserved: false });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(f.instance()).toBeUndefined();
	});

	it("tries a failed create again, and releases a placement whose VM was never made", async () => {
		const f = await fixture();
		f.client.inspectInstanceOperation.mockImplementationOnce(async () => "failed");
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"create",
			"start",
		]);
		// Plugged in before each create, with the same claim both times (the tool gives that claim its one entry).
		expect(f.agentPlug).toHaveBeenCalledTimes(2);
		expect(f.agentPlug.mock.calls[1][0]).toEqual(f.agentPlug.mock.calls[0][0]);
		const g = await fixture();
		g.client.inspectInstanceOperation.mockImplementation(async () => "failed");
		expect((await g.host.pass(g.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_RECOVERY_REQUIRED",
		});
		expect(g.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"create",
			"create",
		]);
		expect(g.agentPlug).toHaveBeenCalledTimes(3);
		// Nothing was ever made: a member's delete has nothing to wait for.
		Object.assign(g.entry, { desiredState: "deleted", removeDue: true, reserved: false });
		expect(await g.host.pass(g.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(g.methods()).toContain("qorpera_release_company_machine");
	});

	it("settles a start LXD no longer knows from the VM itself", async () => {
		const f = await fixture();
		const effect = f.client.inspectInstanceOperation.getMockImplementation();
		if (!effect) throw new Error("fixture");
		let forgot = false;
		f.client.inspectInstanceOperation.mockImplementation(async () => {
			const state = await effect();
			// LXD started it, then forgot the operation (a daemon restart).
			if (f.client.submitInstanceOperation.mock.calls.at(-1)?.[1].action === "start" && !forgot) {
				forgot = true;
				throw new Error("LXD_OPERATION_UNKNOWN");
			}
			return state;
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
	});

	it("settles an effect LXD never confirmed once any operation it could have started is long over", async () => {
		const f = await fixture();
		// The create was written down but LXD refused it (or the executor stopped before it heard back).
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("LXD_REQUEST_FAILED"));
		expect((await f.host.pass(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_RECOVERY_REQUIRED",
		});
		expect((await f.host.pass(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_RECOVERY_REQUIRED",
		});
		const dispatch = join(state.controlPath, "company-machines", id(6), "000000.json");
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(dispatch, old, old);
		// No VM: the create did not happen, so it is made again.
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"create",
			"start",
		]);
	});

	it("keeps trusting the helper of an earlier image this node still runs, and nothing else", async () => {
		const f = await fixture({ helperSha256: "0".repeat(64), previousHelperSha256s: [helperSha256] });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		const g = await fixture({ helperSha256: "0".repeat(64) });
		expect(await g.host.pass(g.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "failed", code: "COMPANY_MACHINE_HELPER_DIFFERS" },
		]);
	});

	it("leaves an idle machine's programs alone when SQL says it is in use again", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { sleepDue: true, runningAt: new Date().toISOString(), bootId: f.boot });
		f.refusals.set("stop", "MACHINE_IN_USE");
		const execs = f.client.execInstance.mock.calls.length;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "not-now" }]);
		expect(f.client.execInstance.mock.calls.length).toBe(execs);
		expect(f.instance()?.status).toBe("Running");
		expect(f.methods()).not.toContain("qorpera_suspend_company_machine");
	});

	it("admits one machine per call until none is left, and a failed admission never stops the pass", async () => {
		const f = await fixture();
		f.admissions.push([id(2)], [id(9)], []);
		await f.host.pass(f.signal);
		expect(f.methods().filter((method) => method === "qorpera_admit_executor_machines")).toHaveLength(3);
		f.admissions.push(new Error("DEADLOCK_DETECTED"));
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot });
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: null, step: "admit", state: "failed", code: "DEADLOCK_DETECTED" },
			{ placementId: id(6), step: "commands", state: "done" },
		]);
	});

	it("deletes a retired placement (its machine moved on) and releases it", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { retired: true, desiredState: "deleted", stopDue: true, removeDue: true });
		await f.host.pass(f.signal);
		Object.assign(f.entry, { stopDue: false, reserved: false });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(f.instance()).toBeUndefined();
		expect(f.calls.find((call) => call.method === "qorpera_release_company_machine")?.args).toMatchObject({
			p_placement_id: id(6),
		});
	});

	it("waits when SQL refuses the effect, and deletes an asleep machine before releasing it", async () => {
		const f = await fixture();
		f.refusals.set("run", "NODE_CAPACITY_EXHAUSTED");
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "not-now" }]);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		f.refusals.clear();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { stopDue: true, desiredState: "deleted" });
		await f.host.pass(f.signal);
		Object.assign(f.entry, { stopDue: false, reserved: false, removeDue: true });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(f.instance()).toBeUndefined();
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
			"stop",
			"delete",
		]);
		expect(f.methods().filter((method) => method === "qorpera_release_company_machine")).toHaveLength(1);
	});

	it("records a failed step on the machine and never trusts a guest whose helper differs", async () => {
		const f = await fixture();
		f.client.readInstanceFile.mockImplementationOnce(async () => ({
			content: Buffer.from("other"),
			uid: 0,
			gid: 0,
			mode: 0o444,
		}));
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "failed", code: "COMPANY_MACHINE_HELPER_DIFFERS" },
		]);
		expect(f.calls.find((call) => call.method === "qorpera_record_company_machine_error")?.args).toMatchObject({
			p_stage: "start",
			p_code: "COMPANY_MACHINE_HELPER_DIFFERS",
		});
		expect(f.methods()).not.toContain("qorpera_mark_company_machine_running");
	});

	it("tries again on the next pass when the company's locks are busy, and records no fault", async () => {
		const f = await fixture();
		f.busy.add("qorpera_authorize_executor_machine");
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "not-now" }]);
		expect(f.methods()).not.toContain("qorpera_record_company_machine_error");
		f.busy.clear();
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		// A running machine keeps its lease and its commands are still watched while run authority is busy.
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.busy.add("qorpera_authorize_executor_machine");
		f.observe({
			at: 10_000,
			cpuUsec: 0,
			ioBytes: 0,
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }],
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		expect(f.client.execInstance.mock.calls.slice(-2).map((call) => call[2][3])).toEqual([
			"refresh-lease",
			"observe",
		]);
		// A later step that finds the company busy says so, and still records no fault.
		f.busy.add("qorpera_record_company_machine_commands");
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "not-now", code: "CODING_CONTROL_BUSY" },
		]);
		// Only the start's success cleared the machine's error; nothing was ever recorded as one.
		expect(
			f.calls.filter((call) => call.method === "qorpera_record_company_machine_error" && call.args.p_code !== null),
		).toEqual([]);
	});

	it("treats a guest that does not answer yet as starting", async () => {
		const f = await fixture();
		f.client.readInstanceFile.mockImplementationOnce(async () => {
			throw new Error("LXD instance file unavailable");
		});
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
	});

	it("refuses a listed binding that is not the one SQL hashed", async () => {
		const f = await fixture();
		f.entry.bindingText = f.entry.bindingText.replace('"cpus":4', '"cpus":8');
		expect((await f.host.pass(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_BINDING_DIFFERS",
		});
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});

	it("runs an authorized command through the inbox and the helper, and checks its receipt", async () => {
		const f = await fixture();
		const commandId = randomUUID();
		const receipt = await f.host.command(
			{ machineId: id(2), placementId: id(6), commandId, inputSha256: "e".repeat(64) },
			{ action: "start", commandId, inputSha256: "e".repeat(64), command: "npm test", timeoutMs: null },
			f.signal,
		);
		expect(receipt).toMatchObject({ machineId: id(2), commandId, state: "running" });
		expect(f.client.pushInstanceFile.mock.calls[0]).toEqual([
			"machines",
			"qorpera-machine-00000000000040008000000000000006",
			`/var/lib/qorpera-machine/inbox/${commandId}.json`,
			JSON.stringify({
				schema: "qorpera.machine-command-request/v1",
				machineId: id(2),
				commandId,
				inputSha256: "e".repeat(64),
				command: "npm test",
				timeoutMs: null,
			}),
			0o400,
			f.signal,
		]);
		expect(f.client.execInstance.mock.calls.at(-1)?.[2].slice(3)).toEqual(["start", commandId]);
		await expect(
			f.host.command(
				{ machineId: id(2), placementId: id(6), commandId, inputSha256: "f".repeat(64) },
				{ action: "read", read: { commandId, tail: true, limit: 100 } },
				f.signal,
			),
		).rejects.toThrow("COMPANY_MACHINE_COMMAND_INVALID");
		expect(f.client.execInstance.mock.calls.at(-1)?.[2].slice(3)).toEqual(["read", commandId, "tail", "100"]);
	});
});

// The journal lives on the NAS control path, in its own folder.
it("keeps company machine journals apart from coding machines'", async () => {
	const f = await fixture();
	await f.host.pass(f.signal);
	await expect(mkdir(join(state.controlPath, "company-machines", id(6)))).rejects.toThrow(/EEXIST/);
});
