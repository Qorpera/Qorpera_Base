import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudMachineCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingControlBusy, CodingControlRefused } from "../src/coding-executor.ts";
import type { CodingMachineIntent } from "../src/coding-machine.ts";
import { type LxdCompanyMachineBinding, lxdCompanyMachinePlan } from "../src/company-machine.ts";
import {
	type CompanyMachineCommand,
	type CompanyMachineEntry,
	LxdCompanyMachineHost,
} from "../src/company-machine-host.ts";
import type { FolderControl, FolderReads } from "../src/folder-control.ts";
import type { LxdExecStreamRequest, LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
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
function binding(placementId = id(6)): LxdCompanyMachineBinding {
	return {
		schema: "qorpera.lxd-company-machine/v2",
		machineId: id(2),
		placementId,
		companyId: id(3),
		environmentId: id(4),
		...policy,
		cpus: 4,
		memoryBytes: 8 * 1024 ** 3,
		rootDiskBytes: 40 * 1024 ** 3,
	};
}

/** SQL's side: one machine as the executor's list shows it, and every call recorded. With `folder`, the node's folder
 * service too (F3 6d): every request recorded, in one order with SQL's calls and the guest's helper. */
async function fixture(options: { helperSha256?: string; previousHelperSha256s?: string[]; folder?: boolean } = {}) {
	const { folder: withFolder, ...pins } = options;
	state.controlPath = await realpath(await mkdtemp(join(tmpdir(), "company-machine-host-")));
	await chmod(state.controlPath, 0o700);
	roots.push(state.controlPath);
	let plan = lxdCompanyMachinePlan(binding());
	let boot = randomUUID();
	/** SQL's calls (`sql:`), the folder service's requests (`folder:`), the helper's actions (`exec:`), the hand-overs
	 * (`mount`), the inbox pushes (`push`) and LXD's operations (`lxd:`), in the order they were made. */
	const order: string[] = [];
	/** The views SQL opened, and the refusal its next open gives (a detail). */
	const views = { opened: [] as { viewId: string; pass: string }[], refusal: undefined as string | null | undefined };
	/** What SQL's take-ins of the machine's reads answer, in turn (then nothing to take in): an answer, or an error. */
	const inherits: unknown[] = [];
	/** The folder service: the reads its boundaries answer, the views it holds, and whether it answers at all. */
	const service = {
		reads: "released" as FolderReads,
		/** Each window close's reads, in turn (then `reads`). */
		closes: [] as FolderReads[],
		/** What a window close waits for before it answers. */
		gate: undefined as Promise<void> | undefined,
		/** What a window open waits for before it answers. */
		opening: undefined as Promise<void> | undefined,
		/** What the next boundaries wait for before they answer, in turn (each answer taken when it was asked). */
		waits: [] as Promise<void>[],
		held: [] as string[],
		/** What each view the service holds reports from its publish. */
		report: {} as Record<string, unknown>,
		/** Views the core closed while the boundary was out: listed with VIEW_CLOSED. */
		closed: [] as string[],
		down: false,
		requests: [] as Record<string, unknown>[],
	};
	/** What the guest's folder-mount answers, in turn (then mounted): its mount, or a refusal's code. */
	const mounts: string[] = [];
	const handovers: { command: readonly string[]; stdin: Record<string, unknown> }[] = [];
	/** Fields a command's receipt has besides the running one's. */
	let result: Record<string, unknown> = {};
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
	/** What SQL's retirements answer, in turn (then the placement retired, for the cause the executor gave). */
	const retirements: unknown[] = [];
	/** Methods whose company locks stay busy past SQL's short wait. */
	const busy = new Set<string>();
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			calls.push({ method, args });
			order.push(`sql:${method}`);
			if (busy.has(method)) throw new CodingControlBusy();
			if (method === "qorpera_folder_view_open") {
				if (views.refusal !== undefined) throw new CodingControlRefused(views.refusal);
				const view = { viewId: randomUUID(), pass: randomBytes(32).toString("base64url") };
				views.opened.push(view);
				const leaseUntil = new Date(Date.now() + 120000).toISOString();
				return { schema: "qorpera.folder-view/v1", ...view, leaseUntil };
			}
			if (method === "qorpera_folder_view_close") return { state: "closed" };
			if (method === "qorpera_folder_test_machine_inherit_reads") {
				const next = inherits.shift();
				if (next instanceof Error) throw next;
				return (
					next ?? {
						schema: "qorpera.folder-inherit/v1",
						inheritId: args.p_inherit_id,
						viewId: null,
						reads: 0,
						replay: false,
					}
				);
			}
			if (method === "qorpera_retire_company_machine")
				return (
					retirements.shift() ?? {
						state: "retired",
						machineId: id(2),
						placementId: args.p_placement_id,
						reason: args.p_reason === "unreadable" ? "unreadable" : "unchecked",
						retiredAt: new Date().toISOString(),
					}
				);
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
					machineId: entry.placementId,
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
			order.push(`lxd:${action.action}`);
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
		execInstance: vi.fn(async (_project: string, _name: string, asked: readonly string[]) => {
			// A start on a machine with a folder: the guest's shell runs the helper only on the boot it names.
			let command = asked;
			if (asked[0] === "/bin/sh" && asked[4] === "/usr/bin/node") {
				if (asked[3] !== boot) throw new Error("LXD instance command failed");
				command = asked.slice(4);
			}
			if (command[0] !== "/usr/bin/node") {
				if (command.join(" ") === "/bin/sh -c systemctl --no-block reboot") order.push("reboot");
				return;
			}
			const [nonce, action, ...args] = command.slice(2);
			order.push(`exec:${action}`);
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
										...result,
									},
			);
		}),
		...(withFolder
			? {
					// The guest's folder-mount (F3 6c): the view on stdin, its answer in the reply file.
					execInstanceStream: vi.fn(async (_project: string, _name: string, request: LxdExecStreamRequest) => {
						order.push("mount");
						const stdin = JSON.parse(request.stdin.toString("utf8")) as Record<string, unknown>;
						handovers.push({ command: request.command, stdin });
						const mount = mounts.shift() ?? "mounted";
						replies.set(
							request.command[2],
							["mounted", "closed", "unanswered"].includes(mount)
								? { schema: "qorpera.machine-guest-folder/v1", viewId: stdin.viewId, mount }
								: { schema: "qorpera.machine-guest-refusal/v1", code: mount },
						);
						if (mount === "mounted") service.held.push(stdin.viewId as string);
						return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
					}),
				}
			: {}),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => {
			if (path === "/opt/qorpera-machine/cloud-machine-guest.mjs")
				return { content: helper, uid: 0, gid: 0, mode: 0o444 };
			const nonce = /\/replies\/([0-9a-f-]{36})\.json$/.exec(path)?.[1];
			if (!nonce || !replies.has(nonce)) throw new Error("LXD instance file unavailable");
			return { content: Buffer.from(JSON.stringify(replies.get(nonce))), uid: 0, gid: 0, mode: 0o600 };
		}),
		pushInstanceFile: vi.fn(async () => {
			order.push("push");
		}),
	};
	const ask = (request: Record<string, unknown>) => {
		service.requests.push(request);
		order.push(`folder:${request.op}`);
		if (service.down) throw new Error("FOLDER_CONTROL_UNANSWERED");
	};
	const answer = (machine: string, reads: FolderReads) => ({
		machine,
		reads,
		views: [
			...service.held.map((viewId) => ({ viewId, report: { ...service.report } })),
			...service.closed.map((viewId) => ({
				viewId,
				error: { code: "VIEW_CLOSED" as const, message: "View closed" },
			})),
		],
	});
	const folder: FolderControl = {
		boundary: async (machine, final) => {
			ask({ op: "boundary", machine, final: [...final] });
			const boundary = answer(machine, service.reads);
			// A final closes its views in the core.
			service.held = service.held.filter((viewId) => !final.includes(viewId));
			const wait = service.waits.shift();
			if (wait) await wait;
			return boundary;
		},
		restarted: async (machine) => ask({ op: "restarted", machine }),
		openWindow: async (machine, window) => {
			ask({ op: "open", machine, ...window });
			await service.opening;
		},
		closeWindow: async (machine, commandId) => {
			ask({ op: "close", machine, commandId });
			await service.gate;
			return answer(machine, service.closes.shift() ?? service.reads);
		},
	};
	const agentPlug = vi.fn(testAgentPlug);
	const make = (upgraded: Omit<typeof options, "folder"> = {}) =>
		new LxdCompanyMachineHost({
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
			...upgraded,
			...(withFolder ? { folder } : {}),
		});
	let host = make();
	const signal = new AbortController().signal;
	return {
		entry,
		calls,
		refusals,
		admissions,
		retirements,
		inherits,
		busy,
		client,
		get host() {
			return host;
		},
		agentPlug,
		signal,
		get boot() {
			return boot;
		},
		order,
		views,
		service,
		mounts,
		handovers,
		/** The guest boots again (its helper answers a new boot id). */
		reboot: () => {
			boot = randomUUID();
		},
		/** The executor's process restarts: a new host, with nothing in memory (and maybe new helper pins). */
		restart: (upgraded: Omit<typeof options, "folder"> = {}) => {
			host = make(upgraded);
		},
		/** SQL knows the boot runs, as after its mark. */
		running: (commands: string[] = []) => {
			Object.assign(entry, { runningAt: new Date().toISOString(), bootId: boot, commands });
		},
		/** Admission put the machine on a new placement (a new disk): wanted, and not made yet. */
		place: (placementId: string) => {
			plan = lxdCompanyMachinePlan(binding(placementId));
			Object.assign(entry, {
				placementId,
				retired: false,
				binding: binding(placementId),
				bindingText: plan.text,
				instanceSha256: plan.instanceSha256,
				desiredState: "running",
				reserved: true,
				removing: false,
				released: false,
				runningAt: null,
				bootId: null,
				commands: [],
				sleepDue: false,
				stopDue: false,
				removeDue: false,
			});
		},
		result: (value: Record<string, unknown>) => {
			result = value;
		},
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Who a command's window credits: its run, the run's agent and the member who asked. */
const credit = () => ({ runId: randomUUID(), staffAgentId: randomUUID(), requestedByUserId: randomUUID() });
type Credit = { runId?: string; staffAgentId?: string; requestedByUserId?: string; bootId?: string | null };
/** A start of `commandId`, as the gateway authorizes it for the boot SQL knows. */
function start(f: Fixture, commandId = randomUUID(), who: Credit = credit()) {
	return f.host.command(
		{ machineId: id(2), placementId: id(6), commandId, inputSha256: "e".repeat(64), bootId: f.boot, ...who },
		{ action: "start", commandId, inputSha256: "e".repeat(64), command: "npm test", timeoutMs: null },
		f.signal,
	);
}
/** A read of `commandId`'s log: its tail, or from `offset`, by the run in `who`. */
function read(f: Fixture, commandId: string, offset?: number, who: Credit = credit()) {
	return f.host.command(
		{ machineId: id(2), placementId: id(6), commandId, inputSha256: "e".repeat(64), bootId: f.boot, ...who },
		{
			action: "read",
			read: offset === undefined ? { commandId, tail: true, limit: 100 } : { commandId, offset, limit: 100 },
		},
		f.signal,
	);
}
/** A cancel of `commandId`, by the run in `who`. */
function cancel(f: Fixture, commandId: string, who: Credit = credit()) {
	return f.host.command(
		{ machineId: id(2), placementId: id(6), commandId, inputSha256: "e".repeat(64), bootId: f.boot, ...who },
		{ action: "cancel", commandId },
		f.signal,
	);
}
/** A command that printed one line and exited. */
const finished = {
	state: "succeeded",
	exitCode: 0,
	output: "ok\n",
	truncated: false,
	log: { offset: 0, nextOffset: 3, totalBytes: 3, limitBytes: 67108864, limitReached: false },
};
const idle = { at: 0, cpuUsec: 0, ioBytes: 0 };
const recorded = (f: Fixture) =>
	f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").map((call) => call.args.p_ended);

describe("company machine host with the node's folder service (F3 6d)", () => {
	it("opens the boot's own view once SQL knows the boot, and hands it to the guest on stdin alone", async () => {
		const f = await fixture({ folder: true });
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(f.views.opened).toHaveLength(1);
		const [view] = f.views.opened;
		expect(f.calls.find((call) => call.method === "qorpera_folder_view_open")?.args).toEqual({
			p_environment_id: id(4),
			p_opener: { kind: "platform" },
			p_kind: "test_machine",
			p_anchor: { companyMachineId: id(2), placementId: id(6), bootId: f.boot },
		});
		const opened = f.order.indexOf("sql:qorpera_folder_view_open");
		expect(opened).toBeGreaterThan(f.order.indexOf("sql:qorpera_mark_company_machine_running"));
		expect(f.order.indexOf("sql:qorpera_mark_company_machine_running")).toBeGreaterThan(-1);
		expect(f.order.indexOf("mount")).toBeGreaterThan(opened);
		const helperPath = "/opt/qorpera-machine/cloud-machine-guest.mjs";
		expect(f.handovers).toEqual([
			{
				command: ["/usr/bin/node", helperPath, expect.any(String), "folder-mount"],
				stdin: { environmentId: id(4), viewId: view.viewId, pass: view.pass },
			},
		]);
		// The pass is in no argument, file or request of the executor's but the hand-over's stdin.
		const elsewhere = JSON.stringify([
			f.client.execInstance.mock.calls.map((call) => call.slice(0, 3)),
			f.client.pushInstanceFile.mock.calls,
			f.service.requests,
			f.handovers.map((handover) => handover.command),
		]);
		expect(elsewhere).not.toContain(view.pass);
		// Settled: the next pass of the boot opens and hands over nothing.
		f.running();
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		expect(f.views.opened).toHaveLength(1);
		expect(f.handovers).toHaveLength(1);
	});

	it("runs a boot without /company when SQL refuses its first view and the service holds none", async () => {
		const f = await fixture({ folder: true });
		f.views.refusal = null;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_NONE:REFUSED" },
		]);
		expect(f.handovers).toEqual([]);
		f.running([id(7)]);
		f.observe({ ...idle, ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		expect(recorded(f)).toEqual([[{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }]]);
		f.result(finished);
		expect(await start(f)).toMatchObject({ state: "succeeded", exitCode: 0, output: "ok\n" });
		// One plain boundary showed no view of the machine and its reads released; then no window and no boundary.
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
		expect(f.methods().filter((method) => method === "qorpera_folder_view_open")).toHaveLength(1);
		// A refusal without the new disk's detail moves nothing.
		expect(f.methods()).not.toContain("qorpera_retire_company_machine");
	});

	it("gives a guest of an earlier image no view, and fences it while the service may have one reach it", async () => {
		const pins = { helperSha256: "0".repeat(64), previousHelperSha256s: [helperSha256] };
		const f = await fixture({ folder: true, ...pins });
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_NONE:OLD_HELPER" },
		]);
		expect(f.methods()).not.toContain("qorpera_folder_view_open");
		expect(f.handovers).toEqual([]);
		// A view of the machine the service still holds, or reads it has not released: the boot stays fenced.
		for (const service of [{ held: [randomUUID()] }, { reads: "unproven" as const }]) {
			const g = await fixture({ folder: true, ...pins });
			Object.assign(g.service, service);
			expect(await g.host.pass(g.signal)).toEqual([
				{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_FENCED:OLD_HELPER" },
			]);
			g.running();
			g.service.reads = "unproven";
			g.result(finished);
			const commandId = randomUUID();
			expect(await start(g, commandId)).toMatchObject({ state: "running", output: "" });
			expect(g.service.requests.at(-1)).toMatchObject({ op: "open", machine: id(6), commandId });
			expect(await read(g, commandId)).toMatchObject({ state: "running", exitCode: null, output: "" });
			expect(g.handovers).toEqual([]);
		}
	});

	it("hands the same view over again next pass when the guest did not take it, and a start waits", async () => {
		const f = await fixture({ folder: true });
		f.mounts.push("MACHINE_FOLDER_UNAVAILABLE");
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "MACHINE_FOLDER_UNAVAILABLE" },
		]);
		f.running();
		const started = start(f);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(f.order).not.toContain("push");
		expect(f.service.requests).toEqual([]);
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(await started).toMatchObject({ state: "running" });
		expect(f.views.opened).toHaveLength(1);
		const [view] = f.views.opened;
		expect(f.handovers.map((handover) => handover.stdin.viewId)).toEqual([view.viewId, view.viewId]);
		// The window opens after the hand-over, and before the guest's inbox gets the command.
		expect(f.order.indexOf("folder:open")).toBeGreaterThan(f.order.lastIndexOf("mount"));
		expect(f.order.indexOf("push")).toBeGreaterThan(f.order.indexOf("folder:open"));
	});

	it("opens a new view when the node closed the one handed over, twice more, then stays fenced", async () => {
		const f = await fixture({ folder: true });
		f.mounts.push("closed", "closed", "closed");
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "MACHINE_FOLDER_CLOSED" },
		]);
		f.running();
		const closed = { placementId: id(6), step: "commands", state: "done", folder: "MACHINE_FOLDER_CLOSED" };
		expect(await f.host.pass(f.signal)).toEqual([closed]);
		expect(await f.host.pass(f.signal)).toEqual([{ ...closed, folder: "FOLDER_FENCED:CLOSED" }]);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		expect(f.views.opened).toHaveLength(3);
		expect(f.handovers.map((handover) => handover.stdin.viewId)).toEqual(f.views.opened.map((view) => view.viewId));
		// Each closed view is closed in SQL too, with its own pass.
		expect(f.calls.filter((call) => call.method === "qorpera_folder_view_close").map((call) => call.args)).toEqual(
			f.views.opened.map((view) => ({ p_view_id: view.viewId, p_pass: view.pass })),
		);
		// The guest had the passes, and may have read with them: its commands get windows, and wait for released reads.
		// Its boot is watched each pass from then on (6d-2), with a plain boundary.
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
		f.service.reads = "denied";
		f.result(finished);
		const commandId = randomUUID();
		expect(await start(f, commandId)).toMatchObject({ state: "running", output: "" });
		expect(f.service.requests.slice(1)).toEqual([expect.objectContaining({ op: "open", commandId })]);
		expect(await read(f, commandId)).toMatchObject({ state: "running", exitCode: null, output: "" });
		f.running([commandId]);
		f.observe({ ...idle, ended: [{ commandId, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		await f.host.pass(f.signal);
		expect(f.service.requests.at(-1)).toEqual({ op: "close", machine: id(6), commandId });
		expect(recorded(f)).toEqual([]);
		// The final at the stop names every view the guest was handed.
		f.running();
		f.entry.sleepDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.service.requests.filter((request) => request.op === "boundary").at(-1)).toEqual({
			op: "boundary",
			machine: id(6),
			final: f.views.opened.map((view) => view.viewId),
		});
	});

	it("stays fenced when SQL refuses a view after the guest was handed one", async () => {
		const f = await fixture({ folder: true });
		f.mounts.push("closed");
		await f.host.pass(f.signal);
		f.running();
		f.views.refusal = null;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_FENCED:REFUSED" },
		]);
		f.service.reads = "denied";
		f.result(finished);
		const commandId = randomUUID();
		await start(f, commandId);
		expect(await read(f, commandId)).toMatchObject({ state: "running", exitCode: null, output: "" });
		expect(f.service.requests.map((request) => request.op)).toEqual(["open", "boundary"]);
	});

	it("refuses a start it cannot fence: no boot, no run to credit, or no window", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		await expect(start(f, randomUUID(), { ...credit(), runId: "run" })).rejects.toThrow(
			"COMPANY_MACHINE_COMMAND_INVALID",
		);
		await expect(start(f, randomUUID(), { ...credit(), bootId: null })).rejects.toThrow(
			"COMPANY_MACHINE_FOLDER_UNANSWERED",
		);
		expect(f.service.requests).toEqual([]);
		f.service.down = true;
		await expect(start(f)).rejects.toThrow("FOLDER_CONTROL_UNANSWERED");
		expect(f.order).not.toContain("push");
		expect(f.methods()).not.toContain("qorpera_folder_view_close");
	});

	it("holds what a command printed, and how it ended, until the machine's reads are released", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		const who = credit();
		f.result(finished);
		const receipt = await start(f, commandId, who);
		expect(f.service.requests).toEqual([{ op: "open", machine: id(6), commandId, ...who }]);
		// A start asks no boundary (the gateway's time is mostly spent): its output waits for the next read. A held
		// receipt says nothing of the guest's: not its log's size, its end or its exit.
		const log = { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false };
		const kept = { state: "running", exitCode: null, output: "", truncated: false, log };
		expect(receipt).toMatchObject(kept);
		expect(parseCloudMachineCommandReceipt(receipt)).toEqual(receipt);
		for (const reads of ["unanswered", "unproven", "denied"] as const) {
			f.service.reads = reads;
			expect(await read(f, commandId)).toMatchObject(kept);
		}
		f.service.down = true;
		expect(await read(f, commandId)).toMatchObject(kept);
		f.service.down = false;
		f.service.reads = "released";
		expect(await read(f, commandId)).toMatchObject(finished);
		// Each read asked the machine's boundary, naming no view final.
		const boundary = { op: "boundary", machine: id(6), final: [] };
		expect(f.service.requests.slice(1)).toEqual([boundary, boundary, boundary, boundary, boundary]);
		// A read from an offset is held where its reader stands.
		f.service.reads = "unproven";
		const from = await read(f, commandId, 2);
		expect(from).toMatchObject({ ...kept, log: { ...log, offset: 2, nextOffset: 2, totalBytes: 2 } });
		expect(parseCloudMachineCommandReceipt(from)).toEqual(from);
		// Nothing printed and no end: nothing to hold, and nothing asked.
		f.result({});
		expect(await read(f, commandId)).toMatchObject(kept);
		expect(f.service.requests).toHaveLength(7);
	});

	it("holds an end with nothing printed, cancelled or lost, until the machine's reads are released", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		await start(f, commandId);
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		for (const state of ["cancelled", "lost"] as const) {
			f.result({ state, exitCode: null, output: "" });
			for (const reads of ["unanswered", "unproven"] as const) {
				f.service.reads = reads;
				expect(await read(f, commandId)).toMatchObject(kept);
			}
			f.service.down = true;
			expect(await read(f, commandId)).toMatchObject(kept);
			f.service.down = false;
			f.service.reads = "released";
			expect(await read(f, commandId)).toMatchObject({ state, exitCode: null, output: "" });
		}
		expect(f.service.requests.filter((request) => request.op === "boundary")).toHaveLength(8);
	});

	it("lets output out only once the run that gets it took in the machine's reads (6d-3b)", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		f.result(finished);
		const takeIns = () => f.calls.filter((call) => call.method === "qorpera_folder_test_machine_inherit_reads");
		// A start's receipt is held, and takes nothing in.
		await start(f, commandId);
		expect(takeIns()).toEqual([]);
		// A read: the boundary released the machine's reads, then the reading run took them in.
		const reader = credit();
		expect(await read(f, commandId, undefined, reader)).toMatchObject(finished);
		expect(takeIns().map((call) => call.args)).toEqual([
			{ p_placement_id: id(6), p_boot_id: f.boot, p_run_id: reader.runId, p_inherit_id: expect.any(String) },
		]);
		const takeIn = "sql:qorpera_folder_test_machine_inherit_reads";
		expect(f.order.slice(-3)).toEqual(["exec:read", "folder:boundary", takeIn]);
		// A cancel too, with a take-in of its own: each takes in what the machine read since.
		const canceller = credit();
		expect(await cancel(f, commandId, canceller)).toMatchObject(finished);
		expect(takeIns()).toHaveLength(2);
		expect(takeIns()[1].args).toMatchObject({ p_placement_id: id(6), p_boot_id: f.boot, p_run_id: canceller.runId });
		expect(takeIns()[1].args.p_inherit_id).not.toBe(takeIns()[0].args.p_inherit_id);
		// A take-in that fails, is refused for any cause but an unreadable read, is busy, or answers another take-in or
		// nothing it knows, holds that output only.
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		const other = { schema: "qorpera.folder-inherit/v1", inheritId: randomUUID(), viewId: null, reads: 0 };
		f.inherits.push(
			new Error("CODING_CONTROL_UNCONFIRMED"),
			new CodingControlRefused(null),
			new CodingControlRefused("qorpera.test-machine/new-disk"),
			new CodingControlBusy(),
			other,
			{ ...other, schema: "qorpera.folder-inherit/v2" },
			[],
		);
		for (let left = 7; left > 0; left--) expect(await read(f, commandId)).toMatchObject(kept);
		expect(takeIns()).toHaveLength(9);
		expect(await read(f, commandId)).toMatchObject(finished);
		// A run or a boot the take-in cannot name holds the output, and asks none.
		for (const who of [{ runId: "run" }, { bootId: null }])
			expect(await read(f, commandId, undefined, { ...credit(), ...who })).toMatchObject(kept);
		// A boundary that does not release the machine's reads asks none either.
		f.service.reads = "unproven";
		expect(await read(f, commandId)).toMatchObject(kept);
		expect(takeIns()).toHaveLength(10);
		expect(f.methods()).not.toContain("qorpera_retire_company_machine");
	});

	it("has a boot without /company take in its disk's reads too, and hold its output until then (6d-3b)", async () => {
		const f = await fixture({ folder: true });
		f.views.refusal = null;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_NONE:REFUSED" },
		]);
		f.running();
		f.result(finished);
		const takeIns = () => f.calls.filter((call) => call.method === "qorpera_folder_test_machine_inherit_reads");
		// A start gets the output, its run's take-in first; no boundary (the boot has no view of its own).
		const starter = credit();
		expect(await start(f, randomUUID(), starter)).toMatchObject(finished);
		expect(takeIns().map((call) => call.args)).toEqual([
			{ p_placement_id: id(6), p_boot_id: f.boot, p_run_id: starter.runId, p_inherit_id: expect.any(String) },
		]);
		expect(f.service.requests.map((request) => request.op)).toEqual(["boundary"]);
		// A take-in that fails holds the start's output for the next read.
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		const commandId = randomUUID();
		f.inherits.push(new Error("CODING_CONTROL_UNCONFIRMED"));
		expect(await start(f, commandId)).toMatchObject(kept);
		expect(await read(f, commandId)).toMatchObject(finished);
		expect(takeIns()).toHaveLength(3);
		expect(f.service.requests.map((request) => request.op)).toEqual(["boundary"]);
	});

	it("records an end only once its command's window closed with the machine's reads released", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running([id(7), id(8), id(9)]);
		const ended = [7, 8, 9].map((n) => ({ commandId: id(n), state: "failed", exitCode: 1, outputTail: `tail ${n}` }));
		f.observe({ ...idle, ended });
		f.service.closes.push("released", "denied", "unanswered");
		await f.host.pass(f.signal);
		expect(f.service.requests).toEqual([7, 8, 9].map((n) => ({ op: "close", machine: id(6), commandId: id(n) })));
		// How a command ended, its exit and its tail are output too: an unreleased or unanswered close leaves the end
		// for a later pass.
		expect(recorded(f)).toEqual([[ended[0]]]);
		expect(f.order.indexOf("sql:qorpera_record_company_machine_commands")).toBeGreaterThan(
			f.order.lastIndexOf("folder:close"),
		);
		f.entry.commands = [id(8), id(9)];
		f.observe({ ...idle, ended: ended.slice(1) });
		f.service.down = true;
		await f.host.pass(f.signal);
		f.service.down = false;
		f.service.reads = "denied";
		await f.host.pass(f.signal);
		expect(recorded(f)).toHaveLength(1);
		f.service.reads = "released";
		await f.host.pass(f.signal);
		expect(recorded(f)).toEqual([[ended[0]], ended.slice(1)]);
	});

	it("leaves a start's window open while it is delivered, though a pass meanwhile sees its command lost", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		// The window is open, and the inbox push waits: the guest does not have the command yet.
		let deliver = () => {};
		const delivered = new Promise<void>((resolve) => {
			deliver = resolve;
		});
		f.client.pushInstanceFile.mockImplementationOnce(async () => {
			await delivered;
			f.order.push("push");
		});
		const started = start(f, commandId);
		await vi.waitFor(() => expect(f.order).toContain("folder:open"));
		f.observe({ ...idle, ended: [{ commandId, state: "lost" }] });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		// Not opened again either (#reopen), and the pass's plain boundary watched the boot.
		expect(f.service.requests.map((request) => request.op)).toEqual(["open", "boundary"]);
		expect(recorded(f)).toEqual([]);
		deliver();
		expect(await started).toMatchObject({ state: "running" });
		// Delivered, a command its guest calls lost is ended: its window closes first (opened again before the look).
		await f.host.pass(f.signal);
		expect(f.service.requests.map((request) => request.op)).toEqual(["open", "boundary", "open", "close"]);
		expect(recorded(f)).toEqual([[{ commandId, state: "lost", outputTail: "" }]]);
	});

	it("leaves a start's window open when its guest called it lost before the start was delivered", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		// The guest calls the command lost, and its answer waits until the start was delivered in full.
		let answer = () => {};
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		let looked = false;
		const exec = f.client.execInstance.getMockImplementation();
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			const done = await exec?.(project, name, command);
			if (command[3] !== "observe") return done;
			looked = true;
			await answered;
			return done;
		});
		f.observe({ ...idle, ended: [{ commandId, state: "lost" }] });
		const passed = f.host.pass(f.signal);
		await vi.waitFor(() => expect(looked).toBe(true));
		expect(await start(f, commandId)).toMatchObject({ state: "running" });
		answer();
		expect(await passed).toEqual([{ placementId: id(6), step: "commands", state: "done" }]);
		// That answer is from before the guest had the command: its window stays open, and nothing is recorded. The
		// pass's plain boundary watched the boot.
		expect(f.service.requests.map((request) => request.op)).toEqual(["open", "boundary"]);
		expect(recorded(f)).toEqual([]);
		// A look after the delivery decides (the window opened again before it).
		await f.host.pass(f.signal);
		expect(f.service.requests.map((request) => request.op)).toEqual(["open", "boundary", "open", "close"]);
		expect(recorded(f)).toEqual([[{ commandId, state: "lost", outputTail: "" }]]);
	});

	it("opens a start's window only once a close of it on its way is answered", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		// A pass sees the command lost before its start came, and the service answers that close late.
		let answer = () => {};
		f.service.gate = new Promise<void>((resolve) => {
			answer = resolve;
		});
		f.observe({ ...idle, ended: [{ commandId, state: "lost" }] });
		const passed = f.host.pass(f.signal);
		await vi.waitFor(() => expect(f.order).toContain("folder:close"));
		const started = start(f, commandId);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.order).not.toContain("folder:open");
		answer();
		await passed;
		expect(await started).toMatchObject({ state: "running" });
		expect(f.service.requests.map((request) => request.op)).toEqual(["close", "open"]);
		expect(f.order.indexOf("push")).toBeGreaterThan(f.order.indexOf("folder:open"));
		// The start came while that close was on its way: the pass does not end it.
		expect(recorded(f)).toEqual([]);
	});

	it("ends the boot's folder at a stop, before SQL ends its commands and the machine powers off", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		await f.host.pass(f.signal);
		const [view] = f.views.opened;
		f.entry.sleepDue = true;
		f.snapshot({ commands: [id(7)], containers: false });
		const from = f.order.length;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		// The final boundary of its view, the view's close in SQL, and once powered off, its windows end (after the plain
		// boundary that watched the boot the pass before).
		expect(f.service.requests).toEqual([
			{ op: "boundary", machine: id(6), final: [] },
			{ op: "boundary", machine: id(6), final: [view.viewId] },
			{ op: "restarted", machine: id(6) },
		]);
		expect(f.calls.find((call) => call.method === "qorpera_folder_view_close")?.args).toEqual({
			p_view_id: view.viewId,
			p_pass: view.pass,
		});
		const after = f.order.slice(from);
		const at = (step: string) => after.indexOf(step);
		expect(at("exec:stop-commands")).toBeGreaterThan(-1);
		expect(at("folder:boundary")).toBeGreaterThan(at("exec:stop-commands"));
		expect(at("sql:qorpera_folder_view_close")).toBeGreaterThan(at("folder:boundary"));
		expect(at("sql:qorpera_record_company_machine_stop")).toBeGreaterThan(at("sql:qorpera_folder_view_close"));
		expect(at("lxd:stop")).toBeGreaterThan(at("sql:qorpera_record_company_machine_stop"));
		expect(at("folder:restarted")).toBeGreaterThan(at("lxd:stop"));
		expect(at("sql:qorpera_suspend_company_machine")).toBeGreaterThan(at("folder:restarted"));
	});

	it("ends the boot before when the machine booted again, before SQL is told of the new boot", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [old] = f.views.opened;
		f.reboot();
		const from = f.order.length;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(f.service.requests).toEqual([
			{ op: "boundary", machine: id(6), final: [old.viewId] },
			{ op: "restarted", machine: id(6) },
		]);
		expect(f.order.slice(from).filter((step) => /^folder:|view_|mark_company|^mount$/.test(step))).toEqual([
			"folder:boundary",
			"sql:qorpera_folder_view_close",
			"folder:restarted",
			"sql:qorpera_mark_company_machine_running",
			"sql:qorpera_folder_view_open",
			"mount",
		]);
		expect(f.calls.find((call) => call.method === "qorpera_folder_view_close")?.args).toEqual({
			p_view_id: old.viewId,
			p_pass: old.pass,
		});
		expect(f.calls.filter((call) => call.method === "qorpera_folder_view_open").at(-1)?.args.p_anchor).toEqual({
			companyMachineId: id(2),
			placementId: id(6),
			bootId: f.boot,
		});
	});

	it("ends the boot's folder before it deletes a machine SQL still counts as running", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [view] = f.views.opened;
		// Its VM powered off by itself (LXD deletes only a stopped VM), and SQL still has its boot.
		Object.assign(f.instance() as object, { status: "Stopped", statusCode: 102 });
		Object.assign(f.entry, { desiredState: "deleted", removeDue: true, reserved: false });
		const from = f.order.length;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [view.viewId] }]);
		const after = f.order.slice(from);
		expect(after.indexOf("sql:qorpera_folder_view_close")).toBeGreaterThan(after.indexOf("folder:boundary"));
		expect(after.findIndex((step) => step.startsWith("lxd:"))).toBeGreaterThan(
			after.indexOf("sql:qorpera_folder_view_close"),
		);
	});

	it("after its own restart keeps the views the service holds, and opens none to take /company away", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [view] = f.views.opened;
		f.restart();
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_HELD" },
		]);
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
		expect(f.views.opened).toHaveLength(1);
		expect(f.handovers).toHaveLength(1);
		// Its commands stay fenced.
		await start(f);
		expect(f.service.requests.at(-1)).toMatchObject({ op: "open", machine: id(6) });
		// At the stop its final names the held view; with no pass in this process, the view lapses with its lease.
		f.entry.sleepDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.service.requests.filter((request) => request.op === "boundary").at(-1)).toEqual({
			op: "boundary",
			machine: id(6),
			final: [view.viewId],
		});
		expect(f.methods()).not.toContain("qorpera_folder_view_close");
	});

	it("after its own restart, fences a boot whose view SQL refuses, and waits while the service is down", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		f.service.held = [];
		f.restart();
		f.service.down = true;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_CONTROL_UNANSWERED" },
		]);
		await expect(start(f, randomUUID(), { ...credit(), bootId: null })).rejects.toThrow(
			"COMPANY_MACHINE_FOLDER_UNANSWERED",
		);
		f.service.down = false;
		f.views.refusal = null;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_FENCED:REFUSED" },
		]);
		await start(f);
		expect(f.service.requests.at(-1)).toMatchObject({ op: "open", machine: id(6) });
		expect(f.handovers).toHaveLength(1);
	});

	it("after its own restart with a newer helper, keeps fencing the guest whose earlier helper took a view", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [view] = f.views.opened;
		// The node's helper moved on; the guest still runs, mounted, with the one it booted with.
		f.restart({ helperSha256: "0".repeat(64), previousHelperSha256s: [helperSha256] });
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "commands", state: "done", folder: "FOLDER_FENCED:OLD_HELPER" },
		]);
		expect(f.views.opened).toHaveLength(1);
		expect(f.handovers).toHaveLength(1);
		const commandId = randomUUID();
		f.result(finished);
		await start(f, commandId);
		expect(f.service.requests).toEqual([expect.objectContaining({ op: "open", machine: id(6), commandId })]);
		f.service.reads = "unproven";
		expect(await read(f, commandId)).toMatchObject({ state: "running", exitCode: null, output: "" });
		f.service.reads = "released";
		expect(await read(f, commandId)).toMatchObject(finished);
		// At the stop its final names the view the service holds.
		f.entry.sleepDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		expect(f.service.requests.filter((request) => request.op === "boundary").at(-1)).toEqual({
			op: "boundary",
			machine: id(6),
			final: [view.viewId],
		});
	});
});

describe("company machine host when a test machine's folder can never be proven (F3 6d-2)", () => {
	const quiet = { placementId: id(6), step: "commands", state: "done" };
	const reboots = (f: Fixture) => f.order.filter((step) => step === "reboot").length;

	it("moves a machine to a new disk when SQL refuses its new disk a view, and refuses its starts meanwhile", async () => {
		const f = await fixture({ folder: true });
		f.views.refusal = "qorpera.test-machine/new-disk";
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_RETIRED:UNCHECKED" },
		]);
		expect(f.calls.find((call) => call.method === "qorpera_retire_company_machine")?.args).toEqual({
			p_placement_id: id(6),
			p_owner: "mx-a",
			p_binding_text: f.entry.bindingText,
			p_machine_id_sha256: "d".repeat(64),
			p_boot_id: f.boot,
			p_reason: "new-disk",
		});
		expect(f.order.indexOf("sql:qorpera_retire_company_machine")).toBeGreaterThan(
			f.order.indexOf("sql:qorpera_folder_view_open"),
		);
		expect(f.handovers).toEqual([]);
		// SQL ended its commands lost. A start the gateway still let through is refused, and nothing of the boot is
		// looked at or asked again until its stop.
		f.running();
		await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNCHECKED" }]);
		expect(f.order).not.toContain("exec:observe");
		expect(f.methods().filter((method) => method === "qorpera_retire_company_machine")).toHaveLength(1);
		expect(f.service.requests).toEqual([]);
		expect(reboots(f)).toBe(0);
		// The retired placement is stopped and deleted as any retired one, and admission puts the machine on a new one.
		Object.assign(f.entry, { retired: true, desiredState: "deleted", stopDue: true, removeDue: true });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		Object.assign(f.entry, { stopDue: false, reserved: false, runningAt: null });
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "release", state: "done" }]);
		expect(f.instance()).toBeUndefined();
		f.place(id(16));
		f.reboot();
		f.views.refusal = undefined;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(16), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(f.calls.filter((call) => call.method === "qorpera_folder_view_open").at(-1)?.args.p_anchor).toEqual({
			companyMachineId: id(2),
			placementId: id(16),
			bootId: f.boot,
		});
		expect(f.order).not.toContain("push");
	});

	it("moves a machine to a new disk when the core cannot read its view's reads, at a close or a plain boundary", async () => {
		for (const via of ["close", "boundary"] as const) {
			const f = await fixture({ folder: true });
			await f.host.pass(f.signal);
			f.running([id(7)]);
			if (via === "close") {
				f.observe({ ...idle, ended: [{ commandId: id(7), state: "succeeded", exitCode: 0, outputTail: "ok" }] });
				f.service.closes.push("unreadable");
			} else f.service.reads = "unreadable";
			expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNREADABLE" }]);
			expect(f.service.requests.map((request) => request.op)).toEqual([via]);
			expect(f.calls.find((call) => call.method === "qorpera_retire_company_machine")?.args).toMatchObject({
				p_placement_id: id(6),
				p_boot_id: f.boot,
				p_reason: "unreadable",
			});
			expect(recorded(f)).toEqual([]);
			await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
			expect(reboots(f)).toBe(0);
		}
	});

	it("moves a machine to a new disk when a view reports its publish refused for a read the core cannot read", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		// A read released before fails its commit's read set, checked again: the view's report says so, and with no read
		// left to release the machine's reads answer released.
		f.service.report = {
			commitId: null,
			seq: null,
			paths: [{ path: "notes/plan.md", outcome: "refused", reason: "unreadable" }],
			refused: "unreadable",
		};
		expect(f.service.reads).toBe("released");
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNREADABLE" }]);
		expect(f.service.requests.map((request) => request.op)).toEqual(["boundary"]);
		expect(f.calls.find((call) => call.method === "qorpera_retire_company_machine")?.args).toMatchObject({
			p_placement_id: id(6),
			p_boot_id: f.boot,
			p_reason: "unreadable",
		});
		await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		expect(reboots(f)).toBe(0);
		// A publish refused for any other cause changes nothing.
		const g = await fixture({ folder: true });
		await g.host.pass(g.signal);
		g.running();
		for (const refused of ["denied", "run_ended", "stopped", "invalid"]) {
			g.service.report = { commitId: null, seq: null, paths: [], refused };
			expect(await g.host.pass(g.signal)).toEqual([quiet]);
		}
		expect(g.methods()).not.toContain("qorpera_retire_company_machine");
		expect(await start(g)).toMatchObject({ state: "running" });
	});

	it("moves a machine to a new disk when the core refuses a run's take-in as unreadable (6d-3b)", async () => {
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		// On a boot with a view, and on one without /company: the disk keeps what earlier views were served.
		for (const none of [false, true]) {
			const f = await fixture({ folder: true });
			if (none) f.views.refusal = null;
			await f.host.pass(f.signal);
			f.running();
			f.result(finished);
			const commandId = randomUUID();
			await start(f, commandId);
			const takeIns = () => f.calls.filter((call) => call.method === "qorpera_folder_test_machine_inherit_reads");
			const asked = takeIns().length;
			f.inherits.push(new CodingControlRefused("qorpera.test-machine/unreadable"));
			expect(await read(f, commandId)).toMatchObject(kept);
			// Every later output of the boot is held, and asks no take-in; the retirement waits for the pass.
			expect(await read(f, commandId)).toMatchObject(kept);
			expect(await cancel(f, commandId)).toMatchObject(kept);
			expect(takeIns()).toHaveLength(asked + 1);
			expect(f.methods()).not.toContain("qorpera_retire_company_machine");
			expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNREADABLE" }]);
			expect(f.calls.find((call) => call.method === "qorpera_retire_company_machine")?.args).toMatchObject({
				p_placement_id: id(6),
				p_boot_id: f.boot,
				p_reason: "unreadable",
			});
			await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
			expect(await read(f, commandId)).toMatchObject(kept);
			expect(takeIns()).toHaveLength(asked + 1);
			expect(reboots(f)).toBe(0);
		}
		// A retirement that does not reach SQL is asked again next pass.
		const g = await fixture({ folder: true });
		await g.host.pass(g.signal);
		g.running();
		g.result(finished);
		const commandId = randomUUID();
		await start(g, commandId);
		g.inherits.push(new CodingControlRefused("qorpera.test-machine/unreadable"));
		expect(await read(g, commandId)).toMatchObject(kept);
		g.busy.add("qorpera_retire_company_machine");
		expect(await g.host.pass(g.signal)).toEqual([{ ...quiet, folder: "CODING_CONTROL_BUSY" }]);
		expect(await read(g, commandId)).toMatchObject(kept);
		g.busy.delete("qorpera_retire_company_machine");
		expect(await g.host.pass(g.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNREADABLE" }]);
	});

	it("keeps a disk SQL says may still get a view, and refuses the starts of a boot SQL no longer runs", async () => {
		const f = await fixture({ folder: true });
		// The new disk got its view meanwhile: the boot stays as it is, and its open is tried again next pass.
		f.views.refusal = "qorpera.test-machine/new-disk";
		f.retirements.push({ state: "kept", reason: "FOLDER_DISK_USABLE" });
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_DISK_USABLE" },
		]);
		f.running();
		f.views.refusal = undefined;
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_MOUNTED" }]);
		// Unreadable reads on a disk SQL keeps: the boot runs on.
		f.service.reads = "unreadable";
		f.retirements.push({ state: "kept", reason: "FOLDER_DISK_USABLE" });
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_DISK_USABLE" }]);
		f.service.reads = "released";
		expect(await start(f)).toMatchObject({ state: "running" });
		// An answer that is not this placement's changes nothing; a boot SQL no longer runs refuses its starts.
		f.service.reads = "unreadable";
		f.retirements.push(
			{ state: "retired", machineId: id(2), placementId: id(9), reason: "unchecked" },
			{ state: "stale" },
		);
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "COMPANY_MACHINE_RETIRE_INVALID" }]);
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRE_STALE" }]);
		await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRE_STALE" }]);
		expect(f.methods().filter((method) => method === "qorpera_retire_company_machine")).toHaveLength(4);
		expect(reboots(f)).toBe(0);
	});

	it("restarts a guest whose reads stay unproven, refuses its starts until it booted again, then gives it a view", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [old] = f.views.opened;
		f.service.reads = "unproven";
		const restart = { ...quiet, folder: "FOLDER_RESTART:UNPROVEN" };
		expect(await f.host.pass(f.signal)).toEqual([restart]);
		// The guest reboots itself, unwaited: a stop would wait for its commands.
		const asked = f.client.execInstance.mock.calls.map((call) => call[2].join(" "));
		expect(asked.filter((command) => command.includes("reboot"))).toEqual(["/bin/sh -c systemctl --no-block reboot"]);
		expect(f.order.indexOf("reboot")).toBeGreaterThan(f.order.indexOf("folder:boundary"));
		expect(f.order).not.toContain("lxd:stop");
		await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		// Not booted again yet: asked again, and nothing of the boot is looked at.
		const looks = f.order.filter((step) => step === "exec:observe").length;
		expect(await f.host.pass(f.signal)).toEqual([restart]);
		expect(f.order.filter((step) => step === "exec:observe")).toHaveLength(looks);
		expect(reboots(f)).toBe(2);
		// The next boot: the boot before ends (its final, its view's close, the restart said), then it gets its own view.
		f.reboot();
		f.service.reads = "released";
		const from = f.order.length;
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(f.order.slice(from).filter((step) => /^folder:|view_|mark_company|^mount$/.test(step))).toEqual([
			"folder:boundary",
			"sql:qorpera_folder_view_close",
			"folder:restarted",
			"sql:qorpera_mark_company_machine_running",
			"sql:qorpera_folder_view_open",
			"mount",
		]);
		expect(f.service.requests.at(-2)).toEqual({ op: "boundary", machine: id(6), final: [old.viewId] });
		expect(f.views.opened.at(-1)?.viewId).not.toBe(old.viewId);
		f.running();
		expect(await start(f)).toMatchObject({ state: "running" });
		expect(reboots(f)).toBe(2);
		// A boot fenced without a view of its own (a guest of an earlier image, while the service held one) restarts too.
		const g = await fixture({ folder: true, helperSha256: "0".repeat(64), previousHelperSha256s: [helperSha256] });
		g.service.held = [randomUUID()];
		expect(await g.host.pass(g.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_FENCED:OLD_HELPER" },
		]);
		g.running();
		expect(await g.host.pass(g.signal)).toEqual([quiet]);
		g.service.reads = "unproven";
		expect(await g.host.pass(g.signal)).toEqual([restart]);
		expect(reboots(g)).toBe(1);
	});

	it("restarts a guest whose own view the core closed, or that stays gone from the service", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [view] = f.views.opened;
		// A narrowing (or a crashed service's view refused to the next one): the boundary lists the view closed.
		f.service.held = [];
		f.service.closed = [view.viewId];
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_CLOSED" }]);
		expect(f.order.at(-1)).toBe("reboot");
		await expect(start(f)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		// A view that is not the boot's own changes nothing.
		const g = await fixture({ folder: true });
		await g.host.pass(g.signal);
		g.running();
		const [own] = g.views.opened;
		g.service.closed = [randomUUID()];
		expect(await g.host.pass(g.signal)).toEqual([quiet]);
		// Gone from the service: its folder program may be connecting again (a restarted service), for 90 s at most.
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			g.service.held = [];
			expect(await g.host.pass(g.signal)).toEqual([quiet]);
			clock.mockReturnValue(now + 60000);
			g.service.held = [own.viewId];
			expect(await g.host.pass(g.signal)).toEqual([quiet]);
			g.service.held = [];
			clock.mockReturnValue(now + 100000);
			expect(await g.host.pass(g.signal)).toEqual([quiet]);
			clock.mockReturnValue(now + 189999);
			expect(await g.host.pass(g.signal)).toEqual([quiet]);
			expect(reboots(g)).toBe(0);
			clock.mockReturnValue(now + 190000);
			expect(await g.host.pass(g.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
		} finally {
			clock.mockRestore();
		}
		expect(reboots(g)).toBe(1);
		// A view the guest never answered mounted is not missed.
		const h = await fixture({ folder: true });
		h.mounts.push("unanswered");
		expect(await h.host.pass(h.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_UNANSWERED" },
		]);
		h.running();
		h.service.held = [];
		const later = Date.now() + 1000000;
		const late = vi.spyOn(Date, "now").mockReturnValue(later);
		try {
			expect(await h.host.pass(h.signal)).toEqual([quiet]);
			late.mockReturnValue(later + 1000000);
			expect(await h.host.pass(h.signal)).toEqual([quiet]);
		} finally {
			late.mockRestore();
		}
		expect(reboots(h)).toBe(0);
	});

	it("opens a running command's window again each pass, until its command ends or SQL no longer lists it", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const [a, b] = [randomUUID(), randomUUID()];
		f.running([a, b]);
		const [first, second] = [credit(), credit()];
		await start(f, a, first);
		await start(f, b, second);
		const opened = (commandId: string, who: ReturnType<typeof credit>) => ({
			op: "open",
			machine: id(6),
			commandId,
			...who,
		});
		const plain = { op: "boundary", machine: id(6), final: [] };
		expect(f.service.requests).toEqual([opened(a, first), opened(b, second)]);
		// A restarted service lost them: each pass says them again, with the same credit, before it looks.
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(2)).toEqual([opened(a, first), opened(b, second), plain]);
		// b ended: its window closes, and is not opened again.
		f.observe({ ...idle, ended: [{ commandId: b, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(5)).toEqual([
			opened(a, first),
			opened(b, second),
			{ op: "close", machine: id(6), commandId: b },
		]);
		expect(recorded(f)).toEqual([[{ commandId: b, state: "succeeded", exitCode: 0, outputTail: "ok" }]]);
		f.running([a, b]);
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(8)).toEqual([opened(a, first), { op: "close", machine: id(6), commandId: b }]);
		// SQL no longer lists a (it ended it): its window is left to its close.
		f.observe({ ...idle, ended: [] });
		f.running([]);
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(10)).toEqual([plain]);
	});

	it("holds what a boot whose folder ended prints, though its reboot failed and a boundary releases its reads", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		await start(f, commandId);
		f.result(finished);
		// The guest does not take its reboot.
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			if (command.join(" ") !== "/bin/sh -c systemctl --no-block reboot") return exec(project, name, command);
			f.order.push("reboot");
			throw new Error("LXD instance command failed");
		});
		expect(await f.host.pass(f.signal)).toEqual([quiet]);
		// The service crashed, and the next one holds no view of the boot's: it answers the machine's reads released.
		f.service.held = [];
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect(await f.host.pass(f.signal)).toEqual([quiet]);
			clock.mockReturnValue(now + 90000);
			expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
		} finally {
			clock.mockRestore();
		}
		expect(reboots(f)).toBe(1);
		// Its guest still runs the command. A read and a cancel reach it, and each gets the held receipt, made from the
		// request alone: no boundary is asked.
		const asked = f.service.requests.length;
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		const log = { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false };
		expect(await read(f, commandId)).toMatchObject({ ...kept, log });
		expect(await read(f, commandId, 2)).toMatchObject({
			...kept,
			log: { ...log, offset: 2, nextOffset: 2, totalBytes: 2 },
		});
		expect(await cancel(f, commandId)).toMatchObject({ ...kept, log });
		expect(f.order.slice(-3)).toEqual(["exec:read", "exec:read", "exec:cancel"]);
		expect(f.service.requests).toHaveLength(asked);
		// Each pass asks the reboot again, and records nothing of the boot.
		f.observe({ ...idle, ended: [{ commandId, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
		expect(reboots(f)).toBe(2);
		expect(recorded(f)).toEqual([]);
		// A read whose boundary is out when its boot ends: answered released, it is held all the same.
		const g = await fixture({ folder: true });
		await g.host.pass(g.signal);
		const other = randomUUID();
		g.running([other]);
		await start(g, other);
		g.result(finished);
		let answer = () => {};
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		g.service.waits.push(answered);
		const reading = read(g, other);
		await vi.waitFor(() => expect(g.order.at(-1)).toBe("folder:boundary"));
		g.service.reads = "unproven";
		expect(await g.host.pass(g.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:UNPROVEN" }]);
		answer();
		expect(await reading).toMatchObject({ ...kept, log });
		expect(g.service.requests.filter((request) => request.op === "boundary")).toHaveLength(2);
	});

	it("records nothing of how a boot whose folder ended ran its commands at its stop, though its reboot failed", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		await start(f, commandId);
		// The guest does not take its reboot.
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
			if (command.join(" ") !== "/bin/sh -c systemctl --no-block reboot") return exec(project, name, command);
			f.order.push("reboot");
			throw new Error("LXD instance command failed");
		});
		expect(await f.host.pass(f.signal)).toEqual([quiet]);
		// The service crashed, and the next one holds no view of the boot's: it answers the machine's reads released.
		f.service.held = [];
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect(await f.host.pass(f.signal)).toEqual([quiet]);
			clock.mockReturnValue(now + 90000);
			expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
		} finally {
			clock.mockRestore();
		}
		// The command finishes meanwhile, and the machine is stopped before its guest boots again.
		f.observe({ ...idle, ended: [{ commandId, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		f.snapshot({ commands: [commandId], containers: true });
		f.entry.stopDue = true;
		const from = f.order.length;
		const asked = f.service.requests.length;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		// No last look, no window close, and no end of the command recorded. Its stop lists none of the boot's commands
		// (SQL ends them lost at the power-off), and tells its containers.
		const after = f.order.slice(from);
		expect(after).not.toContain("exec:observe");
		expect(f.service.requests.slice(asked).map((request) => request.op)).toEqual(["boundary", "restarted"]);
		expect(recorded(f)).toEqual([]);
		expect(f.calls.find((call) => call.method === "qorpera_record_company_machine_stop")?.args).toMatchObject({
			p_boot_id: f.boot,
			p_commands: [],
			p_containers: true,
		});
		expect(after.indexOf("sql:qorpera_suspend_company_machine")).toBeGreaterThan(after.indexOf("lxd:stop"));
		expect(reboots(f)).toBe(1);
	});

	it("records nothing of a boot whose folder ended at a stop tried again, after its record or power-off failed", async () => {
		for (const failed of ["record", "power-off"] as const) {
			const f = await fixture({ folder: true });
			await f.host.pass(f.signal);
			const commandId = randomUUID();
			f.running([commandId]);
			await start(f, commandId);
			// The guest does not take its reboot.
			const exec = f.client.execInstance.getMockImplementation()!;
			f.client.execInstance.mockImplementation(async (project: string, name: string, command: readonly string[]) => {
				if (command.join(" ") !== "/bin/sh -c systemctl --no-block reboot") return exec(project, name, command);
				f.order.push("reboot");
				throw new Error("LXD instance command failed");
			});
			expect(await f.host.pass(f.signal)).toEqual([quiet]);
			// The service crashed, and the next one holds no view of the boot's: it answers the machine's reads released.
			f.service.held = [];
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			try {
				expect(await f.host.pass(f.signal)).toEqual([quiet]);
				clock.mockReturnValue(now + 90000);
				expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
			} finally {
				clock.mockRestore();
			}
			// The command finishes meanwhile, and the machine is stopped before its guest boots again.
			f.observe({ ...idle, ended: [{ commandId, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
			f.snapshot({ commands: [commandId], containers: true });
			f.entry.stopDue = true;
			const from = f.order.length;
			const asked = f.service.requests.length;
			if (failed === "record") {
				// SQL does not take the stop's record (its company's locks are busy): the boot's folder ended by then.
				f.busy.add("qorpera_record_company_machine_stop");
				expect(await f.host.pass(f.signal)).toEqual([
					{ placementId: id(6), step: "stop", state: "not-now", code: "CODING_CONTROL_BUSY" },
				]);
				f.busy.delete("qorpera_record_company_machine_stop");
			} else {
				// SQL refuses the power-off once the stop was recorded: the machine is wanted running again first.
				const failing = f.client.execInstance.getMockImplementation()!;
				f.client.execInstance.mockImplementation(
					async (project: string, name: string, command: readonly string[]) => {
						if (command[3] === "stop-commands") f.refusals.set("stop", "MACHINE_WANTED_RUNNING");
						return failing(project, name, command);
					},
				);
				expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "not-now" }]);
				f.client.execInstance.mockImplementation(failing);
				f.refusals.delete("stop");
				f.entry.stopDue = false;
				// Its guest is asked to reboot again, and nothing of the boot is looked at or recorded.
				expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_GONE" }]);
				expect(reboots(f)).toBe(2);
				f.entry.stopDue = true;
			}
			expect(f.instance()?.status).toBe("Running");
			// The stop tried again: no last look, no window close, and no end of the command recorded. Each of its records
			// lists none of the boot's commands, and tells its containers.
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
			const after = f.order.slice(from);
			expect(after).not.toContain("exec:observe");
			expect(f.service.requests.slice(asked).map((request) => request.op)).not.toContain("close");
			expect(recorded(f)).toEqual([]);
			expect(
				f.calls
					.filter((call) => call.method === "qorpera_record_company_machine_stop")
					.map((call) => [call.args.p_boot_id, call.args.p_commands, call.args.p_containers]),
			).toEqual([
				[f.boot, [], true],
				[f.boot, [], true],
			]);
			expect(f.instance()?.status).toBe("Stopped");
			const suspended = after.lastIndexOf("sql:qorpera_suspend_company_machine");
			expect(suspended).toBeGreaterThan(after.lastIndexOf("lxd:stop"));
		}
	});

	it("holds what a boot whose folder ended prints, and refuses its starts, until SQL takes its next boot", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running([commandId]);
		await start(f, commandId);
		f.service.reads = "unproven";
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:UNPROVEN" }]);
		// The guest boots again, its command printed and exited before. SQL does not take the next boot yet (its
		// company's locks are busy): it still knows the boot before, whose folder ended, and the gateway lets in that
		// boot's reads.
		const old = f.boot;
		f.reboot();
		f.service.reads = "released";
		f.result(finished);
		f.busy.add("qorpera_mark_company_machine_running");
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "not-now", code: "CODING_CONTROL_BUSY" },
		]);
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		const onOld = (action: CompanyMachineCommand) =>
			f.host.command(
				{ machineId: id(2), placementId: id(6), commandId, inputSha256: "e".repeat(64), bootId: old, ...credit() },
				action,
				f.signal,
			);
		const reading: CompanyMachineCommand = { action: "read", read: { commandId, tail: true, limit: 100 } };
		expect(await onOld(reading)).toMatchObject(kept);
		expect(await onOld({ action: "cancel", commandId })).toMatchObject(kept);
		const late = { ...credit(), bootId: old };
		await expect(start(f, randomUUID(), late)).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		// SQL takes the next boot, which gets its own view. A read let in for the boot before is still held, and the next
		// boot's starts run.
		f.busy.delete("qorpera_mark_company_machine_running");
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(await onOld(reading)).toMatchObject(kept);
		f.running();
		f.result({});
		expect(await start(f)).toMatchObject({ state: "running" });
	});

	it("refuses a start whose boot a pass ended while its window opened, and the restart waits for it", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		// The service answers the start's window open late.
		let open = () => {};
		f.service.opening = new Promise<void>((resolve) => {
			open = resolve;
		});
		const started = start(f);
		await vi.waitFor(() => expect(f.order).toContain("folder:open"));
		// A pass meanwhile ends the boot (its reads stay unproven), and its restart waits for the start on its way.
		f.service.reads = "unproven";
		const passed = f.host.pass(f.signal);
		await vi.waitFor(() => expect(f.order.at(-1)).toBe("folder:boundary"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.order).not.toContain("reboot");
		// The start goes on once its window opened, and is refused: nothing reaches the guest.
		open();
		await expect(started).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		expect(await passed).toEqual([{ ...quiet, folder: "FOLDER_RESTART:UNPROVEN" }]);
		expect(f.order).not.toContain("push");
		expect(f.order).not.toContain("exec:start");
		expect(f.order.at(-1)).toBe("reboot");
	});

	it("starts nothing when a start's delivery crosses its guest's restart, seen by a pass or not", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const boot = f.boot;
		// The inbox push waits, and the guest boots again meanwhile (the job runs as root in its VM), unseen yet.
		const held = () => {
			let deliver = () => {};
			const delivered = new Promise<void>((resolve) => {
				deliver = resolve;
			});
			f.client.pushInstanceFile.mockImplementationOnce(async () => {
				await delivered;
				f.order.push("push");
			});
			return deliver;
		};
		const commandId = randomUUID();
		const deliver = held();
		const started = start(f, commandId);
		await vi.waitFor(() => expect(f.order).toContain("folder:open"));
		f.reboot();
		deliver();
		// The guest's shell checks the boot the start was let in on, in the start's own exec: on the next boot it fails,
		// and the helper never runs.
		await expect(started).rejects.toThrow("LXD instance command failed");
		expect(f.client.execInstance.mock.calls.at(-1)?.[2]).toEqual([
			"/bin/sh",
			"-c",
			'read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ] && exec "$@"',
			boot,
			"/usr/bin/node",
			"/opt/qorpera-machine/cloud-machine-guest.mjs",
			expect.stringMatching(/^[0-9a-f-]{36}$/),
			"start",
			commandId,
		]);
		expect(f.order).not.toContain("exec:start");
		// A pass that sees the next boot meanwhile ends the boot before: a start still on its way to it is refused.
		const later = held();
		const again = start(f, randomUUID(), { ...credit(), bootId: boot });
		await vi.waitFor(() => expect(f.order.filter((step) => step === "folder:open")).toHaveLength(2));
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		later();
		await expect(again).rejects.toThrow("COMPANY_MACHINE_FOLDER_ENDED");
		expect(f.order).not.toContain("exec:start");
		// On the boot it was let in on, a start runs.
		f.running();
		expect(await start(f)).toMatchObject({ state: "running" });
		expect(f.order.at(-1)).toBe("exec:start");
	});
});

// The journal lives on the NAS control path, in its own folder.
it("keeps company machine journals apart from coding machines'", async () => {
	const f = await fixture();
	await f.host.pass(f.signal);
	await expect(mkdir(join(state.controlPath, "company-machines", id(6)))).rejects.toThrow(/EEXIST/);
});
