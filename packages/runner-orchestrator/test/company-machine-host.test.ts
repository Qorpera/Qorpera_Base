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
	network: "machine-net",
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
	let observed: unknown = { at: 0, ended: [], running: [], cpu: { busyUsec: 0, totalUsec: 0, ownUsec: 0 } };
	const client = {
		getInstance: vi.fn(async () => instance),
		submitInstanceOperation: vi.fn(async (_project: string, action: LxdTrackedInstanceAction) => {
			pending = action;
			return { project: "machines", instanceName: plan.request.name, operationId: randomUUID() };
		}),
		inspectInstanceOperation: vi.fn(async (): Promise<"succeeded" | "pending" | "failed"> => {
			if (pending?.action === "create")
				instance = {
					name: plan.request.name,
					type: "virtual-machine",
					status: "Stopped",
					statusCode: 102,
					profiles: [],
					devices: structuredClone(plan.request.devices),
					expandedDevices: structuredClone(plan.request.devices),
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
									// The guest's paging cursor: one look measures every running command unless a test says otherwise.
									next: null,
									...(observed as object),
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
									log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
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
		signal,
		boot,
		instance: () => instance,
		observe: (value: unknown) => {
			observed = value;
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

	it("keeps a running machine's lease and records the commands that ended, busy commands and busy outside work", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		f.entry.bootId = f.boot;
		f.entry.runningAt = new Date().toISOString();
		f.entry.commands = [id(7), id(8)];
		const recorded = () => f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").at(-1);
		const usec = (seconds: number) => Math.round(seconds * 1e6);
		/** A sample every 10 s of a two-processor machine: id(8) runs, and the whole machine and its own units used so much. */
		const sample = (
			seconds: number,
			command: { cpu: number; io: number },
			machine: { busy: number; own: number },
		) => ({
			at: seconds * 1000,
			ended: [],
			running: [
				{ commandId: id(8), cpuUsec: usec(command.cpu), ioBytes: command.io },
				// SQL does not list it: never reported.
				{ commandId: id(9), cpuUsec: usec(99), ioBytes: 99_000_000 },
			],
			cpu: { busyUsec: usec(machine.busy), totalUsec: usec(seconds * 2), ownUsec: usec(machine.own) },
		});
		f.observe({
			...sample(10, { cpu: 1, io: 0 }, { busy: 5, own: 4 }),
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
			p_busy_commands: [],
			p_outside_busy: false,
		});
		// 0.6 processor-seconds in 10 s, 6% of one core: busy. The machine's busy time is the command's own.
		f.observe(sample(20, { cpu: 1.6, io: 0 }, { busy: 5.6, own: 4.6 }));
		await f.host.pass(f.signal);
		expect(recorded()?.args).toMatchObject({ p_ended: [], p_busy_commands: [id(8)], p_outside_busy: false });
		// 4% of one core, but 200 KB moved in 10 s (more than 512 KiB in 30): busy by its data.
		f.observe(sample(30, { cpu: 2, io: 200_000 }, { busy: 6, own: 5 }));
		await f.host.pass(f.signal);
		expect(recorded()?.args).toMatchObject({ p_busy_commands: [id(8)], p_outside_busy: false });
		// The command only waits; something outside it (a container) used half a processor-second of 20: busy outside.
		f.observe(sample(40, { cpu: 2.01, io: 200_100 }, { busy: 6.51, own: 5.01 }));
		await f.host.pass(f.signal);
		expect(recorded()?.args).toMatchObject({ p_busy_commands: [], p_outside_busy: true });
		// Nothing busy, nothing ended: nothing to record.
		f.observe(sample(50, { cpu: 2.02, io: 200_200 }, { busy: 6.6, own: 5.1 }));
		const before = f.calls.length;
		await f.host.pass(f.signal);
		expect(f.calls.slice(before).some((call) => call.method === "qorpera_record_company_machine_commands")).toBe(
			false,
		);
		// A reply that is not the measured shape is refused.
		f.observe({
			...sample(60, { cpu: 3, io: 0 }, { busy: 7, own: 6 }),
			running: [{ commandId: id(8), cpuUsec: -1, ioBytes: 0 }],
		});
		expect((await f.host.pass(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "COMPANY_MACHINE_GUEST_REPLY_INVALID",
		});
	});

	it("takes a last look before a sleep, so what ended on its own is recorded as it ended", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		await f.host.pass(f.signal);
		f.observe({
			at: 10_000,
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "done" }],
			running: [],
			cpu: { busyUsec: 0, totalUsec: 20e6, ownUsec: 0 },
		});
		f.entry.sleepDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		const methods = f.methods();
		const recordedAt = methods.lastIndexOf("qorpera_record_company_machine_commands");
		expect(recordedAt).toBeGreaterThan(-1);
		expect(recordedAt).toBeLessThan(methods.lastIndexOf("qorpera_authorize_executor_machine"));
		expect(f.calls[recordedAt].args).toMatchObject({ p_ended: [expect.objectContaining({ commandId: id(7) })] });
	});

	it("counts a busy command beyond the 64 SQL lists: the guest measures every running command", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		// SQL lists the oldest 64 open commands; a 65th runs a build.
		const listed = Array.from({ length: 64 }, () => randomUUID());
		const build = randomUUID();
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: listed });
		const sample = (seconds: number, buildCpu: number) => ({
			at: seconds * 1000,
			ended: [],
			running: [
				...listed.map((commandId) => ({ commandId, cpuUsec: 0, ioBytes: 0 })),
				{ commandId: build, cpuUsec: buildCpu * 1e6, ioBytes: 0 },
			],
			cpu: { busyUsec: buildCpu * 1e6, totalUsec: seconds * 2e6, ownUsec: buildCpu * 1e6 },
		});
		f.observe(sample(10, 1));
		await f.host.pass(f.signal);
		f.observe(sample(20, 5));
		await f.host.pass(f.signal);
		expect(
			f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").at(-1)?.args,
		).toMatchObject({
			p_busy_commands: [build],
			p_outside_busy: false,
		});
	});

	it("leaves the machine running when the last look's record does not reach SQL", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.observe({
			at: 0,
			ended: [],
			running: [{ commandId: id(7), cpuUsec: 0, ioBytes: 0 }],
			cpu: { busyUsec: 0, totalUsec: 0, ownUsec: 0 },
		});
		await f.host.pass(f.signal);
		// The command was busy since: the look sees it, but its record finds the company's locks busy.
		f.observe({
			at: 10_000,
			ended: [],
			running: [{ commandId: id(7), cpuUsec: 5_000_000, ioBytes: 0 }],
			cpu: { busyUsec: 5_000_000, totalUsec: 20_000_000, ownUsec: 5_000_000 },
		});
		f.busy.add("qorpera_record_company_machine_commands");
		f.entry.sleepDue = true;
		let before = f.calls.length;
		expect((await f.host.pass(f.signal))[0]).toMatchObject({ state: "not-now" });
		let methods = f.calls.slice(before).map((call) => call.method);
		expect(methods).toContain("qorpera_record_company_machine_commands");
		// No stop custody, no stop: the machine keeps running, programs and all, until a pass records what it saw.
		expect(methods).not.toContain("qorpera_authorize_executor_machine");
		expect(f.instance()?.status).toBe("Running");
		// The next pass looks quiet, but the busy work seen before still goes to SQL first, before any stop custody.
		f.busy.clear();
		f.observe({
			at: 20_000,
			ended: [],
			running: [{ commandId: id(7), cpuUsec: 5_000_100, ioBytes: 0 }],
			cpu: { busyUsec: 5_000_100, totalUsec: 40_000_000, ownUsec: 5_000_100 },
		});
		before = f.calls.length;
		await f.host.pass(f.signal);
		methods = f.calls.slice(before).map((call) => call.method);
		const recordedAt = methods.indexOf("qorpera_record_company_machine_commands");
		expect(recordedAt).toBeGreaterThan(-1);
		expect(f.calls[before + recordedAt].args).toMatchObject({ p_busy_commands: [id(7)] });
		expect(recordedAt).toBeLessThan(methods.indexOf("qorpera_authorize_executor_machine"));
	});

	it("carries busy work a record did not reach SQL with even when the guest then does not answer", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.observe({ at: 0, ended: [], running: [], cpu: { busyUsec: 0, totalUsec: 0, ownUsec: 0 } });
		await f.host.pass(f.signal);
		// Outside work was busy, but its record finds the company's locks busy.
		f.observe({ at: 10_000, ended: [], running: [], cpu: { busyUsec: 5e6, totalUsec: 20e6, ownUsec: 0 } });
		f.busy.add("qorpera_record_company_machine_commands");
		await f.host.pass(f.signal);
		f.busy.clear();
		// The guest no longer answers; before the machine sleeps, what was seen is recorded.
		f.observe(null);
		f.entry.sleepDue = true;
		const before = f.calls.length;
		await f.host.pass(f.signal);
		const calls = f.calls.slice(before);
		const recordedAt = calls.findIndex((call) => call.method === "qorpera_record_company_machine_commands");
		expect(calls[recordedAt]?.args).toMatchObject({ p_ended: [], p_busy_commands: [], p_outside_busy: true });
		expect(recordedAt).toBeLessThan(calls.findIndex((call) => call.method === "qorpera_authorize_executor_machine"));
	});

	it("pages through more running commands than one look measures, each against its own last sample", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [] });
		const ids = Array.from({ length: 300 }, () => randomUUID()).sort();
		const busy = ids[280];
		// The guest answers a page of 256 after the cursor it is given, as cloud-machine-guest does.
		const pages: string[] = [];
		let seconds = 0;
		const page = (cursor: string | undefined) => {
			const after = cursor === undefined || cursor === "-" ? ids : ids.filter((id) => id > cursor);
			const measured = after.slice(0, 256);
			return {
				running: measured.map((commandId) => ({
					commandId,
					cpuUsec: commandId === busy ? seconds * 1e6 : 0,
					ioBytes: 0,
				})),
				next: after.length > measured.length ? (measured.at(-1) ?? null) : null,
			};
		};
		for (let pass = 0; pass < 4; pass++) {
			seconds += 10;
			const cursor = pass === 0 ? "-" : pages.at(-1);
			const answered = page(cursor);
			pages.push(answered.next ?? "-");
			f.observe({
				at: seconds * 1000,
				ended: [],
				...answered,
				cpu: { busyUsec: 0, totalUsec: seconds * 2e6, ownUsec: 0 },
			});
			await f.host.pass(f.signal);
			// The executor asked for the page after the previous look's cursor.
			const asked = f.client.execInstance.mock.calls.filter((call) => call[2][3] === "observe").at(-1)?.[2];
			expect(asked?.[5]).toBe(cursor);
		}
		// The busy command sorts after the first 256: seen on the second and fourth looks, busy between them.
		expect(
			f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").at(-1)?.args,
		).toMatchObject({
			p_busy_commands: [busy],
		});
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

	it("puts a machine to sleep under stop authority, then gives its room back", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { sleepDue: true, runningAt: new Date().toISOString(), bootId: f.boot });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.instance()?.status).toBe("Stopped");
		expect(f.client.submitInstanceOperation.mock.calls.at(-1)?.[1]).toMatchObject({ action: "stop", force: true });
		// The guest's helper marks and stops its programs (and syncs its disk) first.
		expect(f.client.execInstance.mock.calls.at(-1)?.[2].slice(3)).toEqual(["stop-commands"]);
		expect(f.methods()).toContain("qorpera_suspend_company_machine");
	});

	it("stops a guest whose helper cannot mark its programs as before", async () => {
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
	});

	it("sweeps every page of running commands before a sleep, so a busy one on a later page keeps the machine", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [] });
		const ids = Array.from({ length: 300 }, () => randomUUID()).sort();
		const resumed = ids[290];
		let seconds = 0;
		let resumedCpu = 0;
		// The guest pages through its commands as cloud-machine-guest does, at the cursor it is given.
		const original = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			if (command[3] === "observe") {
				const cursor = command[5];
				const after = cursor === "-" ? ids : ids.filter((id) => id > cursor);
				const measured = after.slice(0, 256);
				f.observe({
					at: seconds * 1000,
					ended: [],
					running: measured.map((commandId) => ({
						commandId,
						cpuUsec: commandId === resumed ? resumedCpu * 1e6 : 0,
						ioBytes: 0,
					})),
					next: after.length > measured.length ? (measured.at(-1) ?? null) : null,
					cpu: { busyUsec: resumedCpu * 1e6, totalUsec: seconds * 2e6, ownUsec: resumedCpu * 1e6 },
				});
			}
			return original(project, name, command);
		});
		// Two passes measure both pages once: the later page's command waits.
		seconds = 10;
		await f.host.pass(f.signal);
		seconds = 20;
		await f.host.pass(f.signal);
		// It resumes work; the next pass is a sleep, which looks at every page before asking for stop custody.
		seconds = 30;
		resumedCpu = 5;
		f.entry.sleepDue = true;
		const before = f.calls.length;
		await f.host.pass(f.signal);
		const calls = f.calls.slice(before);
		const recorded = calls.findIndex(
			(call) =>
				call.method === "qorpera_record_company_machine_commands" &&
				(call.args.p_busy_commands as string[]).includes(resumed),
		);
		expect(recorded).toBeGreaterThan(-1);
		expect(recorded).toBeLessThan(calls.findIndex((call) => call.method === "qorpera_authorize_executor_machine"));
	});

	it("keeps a running machine's lease and watches its commands while SQL refuses new run authority", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		Object.assign(f.entry, { runningAt: new Date().toISOString(), bootId: f.boot, commands: [id(7)] });
		f.refusals.set("run", "NODE_OBSERVATION_UNAVAILABLE");
		f.observe({
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }],
			at: 0,
			running: [],
			cpu: { busyUsec: 0, totalUsec: 0, ownUsec: 0 },
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
			ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }],
			at: 0,
			running: [],
			cpu: { busyUsec: 0, totalUsec: 0, ownUsec: 0 },
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
