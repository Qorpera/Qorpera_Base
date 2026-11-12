import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TimerOptions } from "node:timers";
import type * as TimersPromises from "node:timers/promises";
import {
	type CloudMachineCommandReceipt,
	cloudMachineFolderBytes,
	parseCloudMachineCommandReceipt,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingControlBusy, CodingControlRefused } from "../src/coding-executor.ts";
import type { CodingMachineIntent } from "../src/coding-machine.ts";
import { type LxdCompanyMachineBinding, lxdCompanyMachineName, lxdCompanyMachinePlan } from "../src/company-machine.ts";
import {
	COMPANY_MACHINE_CLIPBOARD_CLEAR,
	COMPANY_MACHINE_CODING_VALUE_HELPER,
	COMPANY_MACHINE_HOST_RPCS,
	COMPANY_MACHINE_MEMBER_LOOK,
	COMPANY_MACHINE_MEMBER_START,
	COMPANY_MACHINE_MEMBER_TYPE,
	COMPANY_MACHINE_SCREEN_HELPER,
	type CompanyMachineCommand,
	type CompanyMachineEntry,
	companyMachineMemberStartCommand,
	companyMachineMemberTypeCommand,
	LxdCompanyMachineHost,
} from "../src/company-machine-host.ts";
import type { FolderControl, FolderReads } from "../src/folder-control.ts";
import type {
	LxdExecPipeRequest,
	LxdExecStreamRequest,
	LxdInstanceRecord,
	LxdTrackedInstanceAction,
} from "../src/lxd-client.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";
import { testAgentMac, testAgentPlug } from "./helpers/coding-machine.ts";

const state = vi.hoisted(() => ({ controlPath: "" }));
// The host waits 500 ms before it looks again at a machine whose LXD effect it just dispatched (reconcileCodingMachine
// answers "pending" after every create, start, stop and delete). Here LXD's fake settles each one at once, so that wait
// was 128 of this file's 157 s (256 waits, 8 Nov). It is 5 ms here: the host still waits and looks again as often; only
// this one delay is shorter. Every other wait (the passes' second, a look's five seconds) is real.
vi.mock("node:timers/promises", async (importOriginal) => {
	const timers = await importOriginal<typeof TimersPromises>();
	return {
		...timers,
		setTimeout: (delay?: number, value?: unknown, options?: TimerOptions) =>
			timers.setTimeout(delay === 500 ? 5 : delay, value, options),
	};
});
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
async function fixture(
	options: {
		helperSha256?: string;
		previousHelperSha256s?: string[];
		folder?: boolean;
		passHoldMs?: number;
		guestReadyTimeoutMs?: number;
		codingValueTimeoutMs?: number;
		codingValueClearTimeoutMs?: number;
		screenTimeoutMs?: number;
		screenClearTimeoutMs?: number;
		memberLookTimeoutMs?: number;
		memberTypeTimeoutMs?: number;
		now?: () => number;
	} = {},
) {
	const { folder: withFolder, ...pins } = options;
	state.controlPath = await realpath(await mkdtemp(join(tmpdir(), "company-machine-host-")));
	await chmod(state.controlPath, 0o700);
	roots.push(state.controlPath);
	let plan = lxdCompanyMachinePlan(binding());
	let boot = randomUUID();
	/** SQL's calls (`sql:`), the folder service's requests (`folder:`), the helper's actions (`exec:`), the hand-overs
	 * (`mount`), the inbox pushes (`push`) and LXD's operations (`lxd:`), in the order they were made. */
	const order: string[] = [];
	/** The views SQL opened, and the refusal its next open gives (a detail), with the core's words the control kept. */
	const views = {
		opened: [] as { viewId: string; pass: string }[],
		refusal: undefined as string | null | undefined,
		reason: null as string | null,
	};
	/** What SQL's take-ins of the machine's reads answer, in turn (then nothing to take in): an answer, or an error. */
	const inherits: unknown[] = [];
	/** What SQL's member read checks answer, in turn (then nothing to check): an answer, or an error (20260930712000). */
	const memberReads: unknown[] = [];
	/** What SQL's fence after a capture answers, in turn (then: the picture leaves), 20260930713000. */
	const pictureChecks: unknown[] = [];
	/** What qorpera_machine_desktop_clipboard_cleared answers, in turn (then ok; F32). */
	const clipboardClears: unknown[] = [];
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
			// As the executor's control in production: a closed method set, of which the host's own list is the host's part
			// (F33 of #1661: a call missing from the list is refused here as it is there).
			if (!(COMPANY_MACHINE_HOST_RPCS as readonly string[]).includes(method))
				throw new Error("CODING_CONTROL_METHOD_INVALID");
			calls.push({ method, args });
			order.push(`sql:${method}`);
			if (busy.has(method)) throw new CodingControlBusy();
			if (method === "qorpera_folder_view_open") {
				if (views.refusal !== undefined) throw new CodingControlRefused(views.refusal, views.reason);
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
			if (method === "qorpera_folder_member_machine_reads") {
				const next = memberReads.shift();
				if (next instanceof Error) throw next;
				return next ?? { schema: "qorpera.folder-member-reads/v1", viewId: null, reads: 0 };
			}
			if (method === "qorpera_machine_desktop_picture_check") {
				const next = pictureChecks.shift();
				if (next instanceof Error) throw next;
				return next ?? { schema: "qorpera.machine-desktop-picture/v1", state: "ok" };
			}
			if (method === "qorpera_machine_desktop_clipboard_cleared") {
				const next = clipboardClears.shift();
				if (next instanceof Error) throw next;
				return next ?? { schema: "qorpera.machine-desktop-clipboard/v1", state: "ok" };
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
			// A pass waits for every step here, unless a test says otherwise.
			passHoldMs: Number.POSITIVE_INFINITY,
			...pins,
			...upgraded,
			...(withFolder ? { folder } : {}),
		});
	let host = make();
	const signal = new AbortController().signal;
	return {
		entry,
		calls,
		control,
		refusals,
		admissions,
		retirements,
		inherits,
		memberReads,
		pictureChecks,
		clipboardClears,
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
			// A new boot is marked once it is usable.
			["basic.target", "network-online.target"],
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

	it("treats a fresh boot whose agent drops between the boot's claim and its lease as starting", async () => {
		const f = await fixture();
		// Early in a boot the agent answers the claim, then drops before the lease (6f's live proof, a nested boot at 707 s).
		let drops = 1;
		dropping(f, (asked) => asked[3] === "refresh-lease" && drops-- > 0);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
		expect(f.methods()).not.toContain("qorpera_mark_company_machine_running");
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(f.client.execInstance.mock.calls.map((call) => call[2][3])).toEqual([
			"prepare",
			"refresh-lease",
			"prepare",
			"refresh-lease",
			"basic.target",
		]);
		expect(failures(f)).toEqual([]);
	});

	it("records a guest whose agent stays away past its grace, though the boot's claim still answers", async () => {
		const pending = [{ placementId: id(6), step: "guest", state: "pending" }];
		const failed = [{ placementId: id(6), step: "start", state: "failed", code: "UNCLASSIFIED" }];
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			// A running machine whose lease is never renewed again: each pass's claim answers, its lease drops.
			const f = await fixture();
			await f.host.pass(f.signal);
			f.running();
			dropping(f, (asked) => asked[3] === "refresh-lease");
			expect(await f.host.pass(f.signal)).toEqual(pending);
			clock.mockReturnValue(now + 179999);
			expect(await f.host.pass(f.signal)).toEqual(pending);
			clock.mockReturnValue(now + 180000);
			expect(await f.host.pass(f.signal)).toEqual(failed);
			expect(failures(f)).toEqual(["UNCLASSIFIED"]);
			// A fresh boot whose agent drops at its lease and never comes back fails the same way.
			clock.mockReturnValue(now);
			const g = await fixture();
			let gone = false;
			dropping(g, (asked) => {
				gone ||= asked[3] === "refresh-lease";
				return gone;
			});
			expect(await g.host.pass(g.signal)).toEqual(pending);
			clock.mockReturnValue(now + 179999);
			expect(await g.host.pass(g.signal)).toEqual(pending);
			clock.mockReturnValue(now + 180000);
			expect(await g.host.pass(g.signal)).toEqual(failed);
			expect(failures(g)).toEqual(["UNCLASSIFIED"]);
			expect(g.methods()).not.toContain("qorpera_mark_company_machine_running");
		} finally {
			clock.mockRestore();
		}
	});

	it("fails at once, with no grace, on a lease its helper answered wrong or refused", async () => {
		// The agent answered, so the boot is not still starting: null, a list, a reply that is not JSON, the helper's
		// refusal, or another boot's receipt each fail the first pass and are recorded.
		const receipt = { schema: "qorpera.machine-guest-lease-receipt/v1", machineId: id(2), validForMs: 900000 };
		const replies: [string, string][] = [
			["null", "COMPANY_MACHINE_GUEST_REPLY_INVALID"],
			["[]", "COMPANY_MACHINE_GUEST_REPLY_INVALID"],
			["{", "UNCLASSIFIED"],
			[
				JSON.stringify({ schema: "qorpera.machine-guest-refusal/v1", code: "MACHINE_GUEST_LEASE_INVALID" }),
				"MACHINE_GUEST_LEASE_INVALID",
			],
			[JSON.stringify({ ...receipt, bootId: randomUUID() }), "COMPANY_MACHINE_GUEST_REPLY_INVALID"],
		];
		for (const [reply, code] of replies) {
			const f = await fixture();
			answering(f, "refresh-lease", reply);
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "failed", code }]);
			expect(failures(f)).toEqual([code]);
			expect(f.methods()).not.toContain("qorpera_mark_company_machine_running");
		}
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
type Credit = {
	runId?: string;
	staffAgentId?: string;
	requestedByUserId?: string;
	bootId?: string | null;
	folderLost?: string | null;
};
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
/** The guest's LXD agent drops on the asks `drops` picks: LXD ends their exec `Disconnected`, which its client throws
 * without a code. */
function dropping(f: Fixture, drops: (asked: readonly string[]) => boolean) {
	const answer = f.client.execInstance.getMockImplementation();
	if (!answer) throw new Error("no simulated guest");
	f.client.execInstance.mockImplementation(async (project, name, asked) => {
		if (drops(asked)) throw new Error("LXD operation failed");
		return answer(project, name, asked);
	});
}
/** The guest's helper writes `reply` as its answer to each `action` it is asked. */
function answering(f: Fixture, action: string, reply: string) {
	const exec = f.client.execInstance.getMockImplementation();
	const read = f.client.readInstanceFile.getMockImplementation();
	if (!exec || !read) throw new Error("no simulated guest");
	const nonces = new Set<string>();
	f.client.execInstance.mockImplementation(async (project, name, asked) => {
		if (asked[3] === action) nonces.add(asked[2]);
		return exec(project, name, asked);
	});
	f.client.readInstanceFile.mockImplementation(async (project, name, path) =>
		nonces.has(/\/replies\/([0-9a-f-]{36})\.json$/.exec(path)?.[1] ?? "")
			? { content: Buffer.from(reply), uid: 0, gid: 0, mode: 0o600 }
			: read(project, name, path),
	);
}
const failures = (f: Fixture) =>
	f.calls
		.filter((call) => call.method === "qorpera_record_company_machine_error" && call.args.p_code !== null)
		.map((call) => call.args.p_code);
/** A command that printed one line and exited. */
const finished = {
	state: "succeeded",
	exitCode: 0,
	output: "ok\n",
	truncated: false,
	log: { offset: 0, nextOffset: 3, totalBytes: 3, limitBytes: 67108864, limitReached: false },
};
const idle = { at: 0, cpuUsec: 0, ioBytes: 0 };
/** What a boot's first pass asks the folder service when SQL counts no boot of the machine as running (F3 5g-5). */
const firstBoot = { op: "restarted", machine: id(6) };
const recorded = (f: Fixture) =>
	f.calls.filter((call) => call.method === "qorpera_record_company_machine_commands").map((call) => call.args.p_ended);

describe("company machine host's wake (perf A5)", () => {
	const BOOT_USABLE = "/usr/bin/systemctl is-active --quiet basic.target network-online.target";
	/** A guest whose agent does not answer yet, until `up.agent`; whose boot is usable from `up.usable`. */
	function booting(f: Awaited<ReturnType<typeof fixture>>) {
		const up = { agent: false, usable: false };
		const read = f.client.readInstanceFile.getMockImplementation()!;
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.readInstanceFile.mockImplementation(async (project, name, path) => {
			if (!up.agent) throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
			return read(project, name, path);
		});
		f.client.execInstance.mockImplementation(async (project, name, asked) => {
			if (!up.agent) throw new Error("LXD VM agent is not currently running");
			if (asked.join(" ") === BOOT_USABLE && !up.usable) throw new Error("LXD instance command failed");
			return exec(project, name, asked);
		});
		return up;
	}
	const until = async (done: () => boolean) => {
		for (let tries = 0; tries < 1000 && !done(); tries++) await new Promise((settle) => setTimeout(settle, 5));
		expect(done()).toBe(true);
	};

	it("a wake ends the wait before the next pass, and one during a pass leaves no wait after it", async () => {
		const f = await fixture();
		const wait = new AbortController();
		let ended = false;
		const paused = f.host.pause(60000, wait.signal).then(() => {
			ended = true;
		});
		await new Promise((settle) => setTimeout(settle, 20));
		expect(ended).toBe(false);
		f.host.wake();
		await paused;
		expect(ended).toBe(true);
		f.host.wake();
		const started = Date.now();
		await f.host.pause(60000, wait.signal);
		// At once, but for the second passes keep between them.
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("the wait ends at its time without a wake, and on its signal", async () => {
		const f = await fixture();
		const started = Date.now();
		await f.host.pause(30, f.signal);
		expect(Date.now() - started).toBeGreaterThanOrEqual(25);
		const wait = new AbortController();
		const paused = f.host.pause(60000, wait.signal);
		wait.abort();
		await paused;
	});

	it("asks a starting guest each second, of LXD alone, and the wait ends only once its boot is usable", async () => {
		const f = await fixture();
		const up = booting(f);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
		const before = f.calls.length;
		const wait = new AbortController();
		let ended = false;
		const paused = f.host.pause(60000, wait.signal).then(() => {
			ended = true;
		});
		// The agent answers the first file read, the boot is not usable yet: looks go on.
		up.agent = true;
		await until(
			() => f.client.execInstance.mock.calls.filter((call) => call[2].join(" ") === BOOT_USABLE).length >= 2,
		);
		expect(ended).toBe(false);
		up.usable = true;
		await paused;
		expect(ended).toBe(true);
		// SQL was asked nothing meanwhile: every step of the next pass asks it, as ever.
		expect(f.calls.length).toBe(before);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		// Started: nothing is looked at any more.
		const looks = f.client.execInstance.mock.calls.length;
		await f.host.pause(1100, f.signal);
		expect(f.client.execInstance.mock.calls.length).toBe(looks);
	});

	it("leaves a guest past its grace to the passes", async () => {
		const f = await fixture({ guestReadyTimeoutMs: 1 });
		const up = booting(f);
		await f.host.pass(f.signal).catch(() => undefined);
		await new Promise((settle) => setTimeout(settle, 5));
		up.agent = true;
		up.usable = true;
		const started = Date.now();
		await f.host.pause(1200, f.signal);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
	});

	it("a stopped boot's time to come up ends with it: its next wake starts a new one", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const f = await fixture();
			booting(f);
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			f.entry.stopDue = true;
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
			// Long after its first boot: the new boot's agent not answering yet is still only starting.
			clock.mockReturnValue(now + 3600000);
			f.entry.stopDue = false;
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
		} finally {
			clock.mockRestore();
		}
	});

	it("one placement's slow step does not hold its pass, and none starts another until it ended", async () => {
		const f = await fixture({ passHoldMs: 20 });
		await f.host.pass(f.signal);
		f.running();
		let free = () => {};
		const held = new Promise<void>((settle) => {
			free = settle;
		});
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project, name, asked) => {
			await held;
			return exec(project, name, asked);
		});
		f.client.execInstance.mockClear();
		// The pass answers though the guest does not, without its step.
		expect(await f.host.pass(f.signal)).toEqual([]);
		await until(() => f.client.execInstance.mock.calls.length === 1);
		// The next one admits and lists, and does not start the placement again.
		f.calls.length = 0;
		expect(await f.host.pass(f.signal)).toEqual([]);
		expect(f.methods()).toEqual(["qorpera_admit_executor_machines", "qorpera_list_executor_machines"]);
		expect(f.client.execInstance).toHaveBeenCalledTimes(1);
		free();
		await f.host.settled();
		// Then its step comes up again as ever.
		f.client.execInstance.mockImplementation(exec);
		await f.host.pass(f.signal);
		expect(f.client.execInstance.mock.calls.map((call) => call[2][3]).slice(-2)).toEqual([
			"refresh-lease",
			"observe",
		]);
	});

	it("hands over what a step that outlasted its pass came to, with the next pass", async () => {
		const f = await fixture({ passHoldMs: 20 });
		await f.host.pass(f.signal);
		f.running();
		let free = () => {};
		const held = new Promise<void>((settle) => {
			free = settle;
		});
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async () => {
			await held;
			throw new Error("LXD instance command failed");
		});
		expect(await f.host.pass(f.signal)).toEqual([]);
		free();
		await f.host.settled();
		f.client.execInstance.mockImplementation(exec);
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "guest", state: "pending" },
			{ placementId: id(6), step: "commands", state: "done" },
		]);
	});

	it("tells who waits once a start is done, and a stop or release asks for the next pass at once", async () => {
		const f = await fixture();
		const up = booting(f);
		const waiting = new AbortController();
		const told = f.host.changed(id(2), waiting.signal);
		let answer: boolean | undefined;
		void told.then((value) => {
			answer = value;
		});
		// Pending is not somewhere yet.
		await f.host.pass(f.signal);
		await new Promise((settle) => setTimeout(settle, 5));
		expect(answer).toBeUndefined();
		up.agent = true;
		up.usable = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		expect(await told).toBe(true);
		// Another machine's step tells nobody here, and a wait that ends says so.
		const other = new AbortController();
		const untold = f.host.changed(id(9), other.signal);
		await f.host.pass(f.signal);
		other.abort();
		expect(await untold).toBe(false);
		await f.host.pause(0, f.signal);
		// A machine in line waits for the room this frees: no wait before the next pass.
		f.running();
		f.entry.stopDue = true;
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "stop", state: "done" }]);
		const started = Date.now();
		await f.host.pause(60000, f.signal);
		// At once, but for the second passes keep between them.
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("leaves nothing on the long-lived signal it is given (Node 22's AbortSignal.any walks what is there)", async () => {
		const f = await fixture({ passHoldMs: 2000 });
		const process = new AbortController();
		const dependants = () => {
			const key = Object.getOwnPropertySymbols(process.signal).find((symbol) =>
				String(symbol).includes("kDependantSignals"),
			);
			return key ? ((process.signal as unknown as Record<symbol, Set<unknown> | undefined>)[key]?.size ?? 0) : 0;
		};
		const up = booting(f);
		await f.host.pass(process.signal);
		await f.host.pause(1100, process.signal);
		up.agent = true;
		up.usable = true;
		await f.host.pass(process.signal);
		f.running();
		await f.host.pass(process.signal);
		f.host.wake();
		await f.host.pause(1, process.signal);
		await f.host.settled();
		expect(dependants()).toBe(0);
		// And the process's end still reaches a step that outlasts its pass.
		const short = await fixture({ passHoldMs: 10 });
		await short.host.pass(new AbortController().signal);
		await short.host.settled();
		short.running();
		let seen: AbortSignal | undefined;
		short.client.execInstance.mockImplementation(async (_project, _name, _asked, signal?: AbortSignal) => {
			seen = signal;
			await new Promise((_settle, refuse) => signal?.addEventListener("abort", () => refuse(signal.reason)));
		});
		const ending = new AbortController();
		await short.host.pass(ending.signal);
		await until(() => seen !== undefined);
		expect(seen?.aborted).toBe(false);
		ending.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await short.host.settled();
		expect(seen?.aborted).toBe(true);
	});

	it("a usable boot whose step stays pending asks for one pass, not one after another (review F1)", async () => {
		for (const failing of ["prepare", "helper"] as const) {
			const f = await fixture();
			const up = booting(f);
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			up.agent = true;
			up.usable = true;
			if (failing === "prepare") {
				const exec = f.client.execInstance.getMockImplementation()!;
				f.client.execInstance.mockImplementation(async (project, name, asked) => {
					if (asked[3] === "prepare") throw new Error("LXD instance command failed");
					return exec(project, name, asked);
				});
			} else
				f.client.readInstanceFile.mockImplementation(async () => ({
					content: Buffer.from("another helper"),
					uid: 0,
					gid: 0,
					mode: 0o444,
				}));
			const lists = () => f.methods().filter((method) => method === "qorpera_list_executor_machines").length;
			const before = lists();
			const running = new AbortController();
			const loop = f.host.run(running.signal, () => undefined);
			await new Promise((settle) => setTimeout(settle, 7000));
			running.abort();
			await loop;
			// The first pass at once. Then, for a boot not up yet, at most STARTING_WAKES passes a look asked for; for a
			// step that failed for another reason, none: the next comes at its time, 10 s on.
			expect(lists() - before).toBeLessThanOrEqual(failing === "prepare" ? 4 : 1);
		}
	}, 30000);

	it("passes come a second apart at most, however many wakes come", async () => {
		const f = await fixture();
		await f.host.pass(f.signal);
		f.running();
		const running = new AbortController();
		const lists = () => f.methods().filter((method) => method === "qorpera_list_executor_machines").length;
		const before = lists();
		const loop = f.host.run(running.signal, () => undefined);
		const waking = setInterval(() => f.host.wake(), 20);
		await new Promise((settle) => setTimeout(settle, 2500));
		clearInterval(waking);
		running.abort();
		await loop;
		expect(lists() - before).toBeGreaterThanOrEqual(2);
		expect(lists() - before).toBeLessThanOrEqual(4);
	});

	it("a pass whose list was asked before a late step ended leaves that placement to the next pass (review F2)", async () => {
		const f = await fixture({ folder: true, passHoldMs: 20 });
		let free = () => {};
		const held = new Promise<void>((settle) => {
			free = settle;
		});
		const exec = f.client.execInstance.getMockImplementation()!;
		f.client.execInstance.mockImplementation(async (project, name, asked) => {
			if (asked[3] === "refresh-lease") await held;
			return exec(project, name, asked);
		});
		// The start step outlives its pass.
		expect(await f.host.pass(f.signal)).toEqual([]);
		// The next pass's list is answered as SQL saw it before the step ended, and delivered after it ended.
		const call = f.control.call.getMockImplementation()!;
		let listing: (() => void) | undefined;
		f.control.call.mockImplementation(async (method, args) => {
			if (method !== "qorpera_list_executor_machines") return call(method, args);
			const answer = await call(method, args);
			await new Promise<void>((settle) => {
				listing = settle;
			});
			return answer;
		});
		const second = f.host.pass(f.signal);
		await until(() => listing !== undefined);
		free();
		await f.host.settled();
		listing?.();
		await second;
		await f.host.settled();
		const marks = f.methods().filter((method) => method === "qorpera_mark_company_machine_running").length;
		expect(marks).toBe(1);
		expect(f.views.opened).toHaveLength(1);
	});

	it("marks a new boot running only once it is usable, for a minute at most (review F4)", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const f = await fixture();
			const up = booting(f);
			up.agent = true;
			const waiting = new AbortController();
			let told: boolean | undefined;
			void f.host.changed(id(2), waiting.signal).then((answer) => {
				told = answer;
			});
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			expect(f.methods()).not.toContain("qorpera_mark_company_machine_running");
			expect(told).toBeUndefined();
			// Usable: marked, and the waiting worker told.
			up.usable = true;
			expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
			await new Promise((settle) => setTimeout(settle, 0));
			expect(told).toBe(true);
			// A boot that never becomes usable is marked all the same once its minute is over.
			const g = await fixture();
			const late = booting(g);
			late.agent = true;
			expect(await g.host.pass(g.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			clock.mockReturnValue(now + 60001);
			expect(await g.host.pass(g.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
			// The minute counts from when the agent first answered, not from the first pass that found the boot starting:
			// a slow boot is still checked (review N2).
			clock.mockReturnValue(now);
			const slow = await fixture();
			const late2 = booting(slow);
			expect(await slow.host.pass(slow.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			clock.mockReturnValue(now + 61000);
			late2.agent = true;
			expect(await slow.host.pass(slow.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
			expect(slow.methods()).not.toContain("qorpera_mark_company_machine_running");
			clock.mockReturnValue(now + 121001);
			expect(await slow.host.pass(slow.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
		} finally {
			clock.mockRestore();
		}
	});

	it("a pass without a hold still waits for every step", async () => {
		const f = await fixture();
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "start", state: "done" }]);
	});
});

describe("company machine host's passes over the signal that lasts as long as its process", () => {
	it("hangs nothing off it (abort-scope.ts), and its end still reaches a step", async () => {
		const f = await fixture();
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await f.host.pass(lasting.signal);
			f.running();
			await f.host.pass(lasting.signal);
			await f.host.pass(lasting.signal);
			expect(watch.made()).toBeGreaterThan(0);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
		let seen: AbortSignal | undefined;
		f.client.execInstance.mockImplementation(async (_project, _name, _asked, signal?: AbortSignal) => {
			seen = signal;
			await new Promise((_settle, refuse) => signal?.addEventListener("abort", () => refuse(signal.reason)));
		});
		const passing = f.host.pass(lasting.signal);
		for (let tries = 0; tries < 400 && !seen; tries++) await new Promise((settle) => setTimeout(settle, 5));
		expect(seen?.aborted).toBe(false);
		lasting.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await passing.catch(() => undefined);
		expect(seen?.aborted).toBe(true);
	});
});

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

	it("says the machine restarted before SQL knows a boot with none running before it, and boots on unanswered (F3 5g-5)", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		// A folder service run vouches only for the machines it was told of: told first, its boot's boundaries can prove.
		expect(f.service.requests).toEqual([firstBoot]);
		const at = (step: string) => f.order.indexOf(step);
		expect(at("sql:qorpera_mark_company_machine_running")).toBeGreaterThan(at("folder:restarted"));
		expect(at("sql:qorpera_folder_view_open")).toBeGreaterThan(at("folder:restarted"));
		expect(at("folder:restarted")).toBeGreaterThan(-1);
		// Once a boot: its next pass asks it no more.
		f.running();
		await f.host.pass(f.signal);
		expect(f.service.requests.filter((request) => request.op === "restarted")).toHaveLength(1);
		// Unanswered, it holds the boot back in nothing: the boot's first unproven boundary restarts the machine instead.
		const g = await fixture({ folder: true });
		g.service.down = true;
		expect(await g.host.pass(g.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(g.service.requests).toEqual([firstBoot]);
		expect(g.order.indexOf("sql:qorpera_mark_company_machine_running")).toBeGreaterThan(
			g.order.indexOf("folder:restarted"),
		);
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
		expect(f.service.requests).toEqual([firstBoot, { op: "boundary", machine: id(6), final: [] }]);
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
		expect(f.service.requests).toEqual([firstBoot]);
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
		expect(f.service.requests).toEqual([firstBoot, { op: "boundary", machine: id(6), final: [] }]);
		f.service.reads = "denied";
		f.result(finished);
		const commandId = randomUUID();
		expect(await start(f, commandId)).toMatchObject({ state: "running", output: "" });
		expect(f.service.requests.slice(2)).toEqual([expect.objectContaining({ op: "open", commandId })]);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "open", "boundary"]);
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
		expect(f.service.requests).toEqual([firstBoot]);
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
		expect(f.service.requests).toEqual([firstBoot, { op: "open", machine: id(6), commandId, ...who }]);
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
		expect(f.service.requests.slice(2)).toEqual([boundary, boundary, boundary, boundary, boundary]);
		// A read from an offset is held where its reader stands.
		f.service.reads = "unproven";
		const from = await read(f, commandId, 2);
		expect(from).toMatchObject({ ...kept, log: { ...log, offset: 2, nextOffset: 2, totalBytes: 2 } });
		expect(parseCloudMachineCommandReceipt(from)).toEqual(from);
		// Nothing printed and no end: nothing to hold, and nothing asked.
		f.result({});
		expect(await read(f, commandId)).toMatchObject(kept);
		expect(f.service.requests).toHaveLength(8);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "boundary"]);
		// A take-in that fails holds the start's output for the next read.
		const kept = { state: "running", exitCode: null, output: "", truncated: false };
		const commandId = randomUUID();
		f.inherits.push(new Error("CODING_CONTROL_UNCONFIRMED"));
		expect(await start(f, commandId)).toMatchObject(kept);
		expect(await read(f, commandId)).toMatchObject(finished);
		expect(takeIns()).toHaveLength(3);
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "boundary"]);
	});

	it("records an end only once its command's window closed with the machine's reads released", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running([id(7), id(8), id(9)]);
		const ended = [7, 8, 9].map((n) => ({ commandId: id(n), state: "failed", exitCode: 1, outputTail: `tail ${n}` }));
		f.observe({ ...idle, ended });
		f.service.closes.push("released", "denied", "unanswered");
		await f.host.pass(f.signal);
		expect(f.service.requests).toEqual([
			firstBoot,
			...[7, 8, 9].map((n) => ({ op: "close", machine: id(6), commandId: id(n) })),
		]);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "open", "boundary"]);
		expect(recorded(f)).toEqual([]);
		deliver();
		expect(await started).toMatchObject({ state: "running" });
		// Delivered, a command its guest calls lost is ended: its window closes first (opened again before the look).
		await f.host.pass(f.signal);
		expect(f.service.requests.map((request) => request.op)).toEqual([
			"restarted",
			"open",
			"boundary",
			"open",
			"close",
		]);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "open", "boundary"]);
		expect(recorded(f)).toEqual([]);
		// A look after the delivery decides (the window opened again before it).
		await f.host.pass(f.signal);
		expect(f.service.requests.map((request) => request.op)).toEqual([
			"restarted",
			"open",
			"boundary",
			"open",
			"close",
		]);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "close", "open"]);
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
			firstBoot,
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
			firstBoot,
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
		expect(f.service.requests).toEqual([firstBoot, { op: "boundary", machine: id(6), final: [view.viewId] }]);
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
		expect(f.service.requests).toEqual([firstBoot, { op: "boundary", machine: id(6), final: [] }]);
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
		expect(f.service.requests).toEqual([
			firstBoot,
			expect.objectContaining({ op: "open", machine: id(6), commandId }),
		]);
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
		expect(f.service.requests).toEqual([firstBoot]);
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
			expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", via]);
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
		expect(f.service.requests.map((request) => request.op)).toEqual(["restarted", "boundary"]);
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

	it("asks a guest it restarted again, without its lease, while the boot that ended still answers its claim", async () => {
		const restart = { ...quiet, folder: "FOLDER_RESTART:VIEW_CLOSED" };
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const [view] = f.views.opened;
		f.service.held = [];
		f.service.closed = [view.viewId];
		expect(await f.host.pass(f.signal)).toEqual([restart]);
		// The reboot is not waited for: the next pass finds the boot that ended still answering its claim, and its agent
		// going down drops the lease (6f's live proof, the pass right after a restart at 1454.6 s).
		let down: "lease" | "all" | undefined = "lease";
		dropping(f, (asked) => down === "all" || (down === "lease" && asked[3] === "refresh-lease"));
		const from = f.order.length;
		expect(await f.host.pass(f.signal)).toEqual([restart]);
		expect(f.order.slice(from).filter((step) => step.startsWith("exec:") || step === "reboot")).toEqual([
			"exec:prepare",
			"reboot",
		]);
		expect(reboots(f)).toBe(2);
		// Then it is gone, and comes back as the next boot.
		down = "all";
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: id(6), step: "guest", state: "pending" }]);
		down = undefined;
		f.reboot();
		f.service.closed = [];
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(failures(f)).toEqual([]);
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
		expect(f.service.requests).toEqual([firstBoot, opened(a, first), opened(b, second)]);
		// A restarted service lost them: each pass says them again, with the same credit, before it looks.
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(3)).toEqual([opened(a, first), opened(b, second), plain]);
		// b ended: its window closes, and is not opened again.
		f.observe({ ...idle, ended: [{ commandId: b, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(6)).toEqual([
			opened(a, first),
			opened(b, second),
			{ op: "close", machine: id(6), commandId: b },
		]);
		expect(recorded(f)).toEqual([[{ commandId: b, state: "succeeded", exitCode: 0, outputTail: "ok" }]]);
		f.running([a, b]);
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(9)).toEqual([opened(a, first), { op: "close", machine: id(6), commandId: b }]);
		// SQL no longer lists a (it ended it): its window is left to its close.
		f.observe({ ...idle, ended: [] });
		f.running([]);
		await f.host.pass(f.signal);
		expect(f.service.requests.slice(11)).toEqual([plain]);
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

describe("company machine host's report of the company folder on each receipt (F3 6e-2a)", () => {
	const quiet = { placementId: id(6), step: "commands", state: "done" };
	const kept = { state: "running", exitCode: null, output: "", truncated: false };
	/** Why output is held back. */
	const held = {
		ended: "this boot's output stays on the machine: the boot no longer has /company, as `why` says",
		start: "a start shows no output: machine_read shows it once the company folder has released what the machine read",
		unanswered: "the company folder has not said yet whether what the machine read may be shown; read again",
		unproven:
			"the executor cannot prove what the machine read in /company: it restarts the machine, and this boot's output stays on it",
		unreadable:
			"something the machine read in /company is no longer readable: this boot's output stays on it, and the machine moves to a new disk",
		paused: "the company folder is paused; read again later",
		unreleased: "the company folder did not release what the machine read; read again",
		refused:
			"this run could not take in what the machine read in /company: a read is no longer readable to it, or it does not read the whole company folder",
		untaken: "the company folder did not answer this run's take-in of what the machine read; read again",
	};
	const refused = "the company folder refused this machine's view";
	/** The receipt's report, after checking the runtime takes the receipt whole. */
	const told = (receipt: CloudMachineCommandReceipt) => {
		expect(parseCloudMachineCommandReceipt(receipt)).toEqual(receipt);
		return receipt.companyFolder;
	};

	it("says whether the boot has /company, and why each receipt holds its output back", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		f.result(finished);
		expect(told(await start(f, commandId))).toEqual({ company: "mounted", heldBack: held.start });
		const answers: [service: Partial<Fixture["service"]>, heldBack: string][] = [
			[{ reads: "unanswered" }, held.unanswered],
			[{ down: true }, held.unanswered],
			[{ reads: "unproven" }, held.unproven],
			[{ reads: "unreadable" }, held.unreadable],
			[{ reads: "stopped" }, held.paused],
			[{ reads: "denied" }, held.unreleased],
			[{ reads: "run_ended" }, held.unreleased],
		];
		for (const [service, heldBack] of answers) {
			Object.assign(f.service, { reads: "released", down: false }, service);
			const receipt = await read(f, commandId);
			expect(receipt).toMatchObject(kept);
			expect(told(receipt)).toEqual({ company: "mounted", heldBack });
		}
		Object.assign(f.service, { reads: "released", down: false });
		// A take-in that fails, is refused, or answers another take-in, and a run it cannot name.
		const other = { schema: "qorpera.folder-inherit/v1", inheritId: randomUUID(), viewId: null, reads: 0 };
		f.inherits.push(new Error("CODING_CONTROL_UNCONFIRMED"), new CodingControlRefused(null), other);
		for (const heldBack of [held.untaken, held.refused, held.untaken])
			expect(told(await read(f, commandId))).toEqual({ company: "mounted", heldBack });
		expect(told(await read(f, commandId, undefined, { ...credit(), runId: "run" }))).toEqual({
			company: "mounted",
			heldBack: held.untaken,
		});
		// Output that leaves holds nothing back; a command running with nothing printed has nothing to hold.
		const out = await read(f, commandId);
		expect(out).toMatchObject(finished);
		expect(told(out)).toEqual({ company: "mounted" });
		f.result({});
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
		// Without a folder, a receipt has no report; and a guest's receipt never carries one of its own, with a folder or
		// without.
		const plain = await fixture();
		await plain.host.pass(plain.signal);
		plain.running();
		plain.result(finished);
		expect(await read(plain, commandId)).not.toHaveProperty("companyFolder");
		for (const g of [f, plain]) {
			g.result({ ...finished, companyFolder: { company: "mounted" } });
			await expect(read(g, commandId)).rejects.toThrow("COMPANY_MACHINE_COMMAND_INVALID");
		}
	});

	it("says why a boot has no /company, in the core's words when the control keeps them", async () => {
		const views: [reason: string | null, why: string][] = [
			[null, refused],
			["Folder view machine is not current", `${refused} because the machine is stopping, moving or starting again`],
			["Company folder is unavailable", `${refused}: Company folder is unavailable`],
		];
		for (const [reason, why] of views) {
			const f = await fixture({ folder: true });
			Object.assign(f.views, { refusal: null, reason });
			expect(await f.host.pass(f.signal)).toEqual([
				{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_NONE:REFUSED" },
			]);
			f.running();
			f.result(finished);
			const receipt = await start(f);
			expect(receipt).toMatchObject(finished);
			expect(told(receipt)).toEqual({ company: "none", why });
		}
		// A guest of an earlier image.
		const old = await fixture({ folder: true, helperSha256: "0".repeat(64), previousHelperSha256s: [helperSha256] });
		expect(await old.host.pass(old.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_NONE:OLD_HELPER" },
		]);
		old.running();
		expect(told(await start(old))).toEqual({
			company: "none",
			why: "this machine runs an earlier image without the company folder; it gets /company once it sleeps and wakes again",
		});
		// Views the node closed each time: fenced, and without /company.
		const closed = await fixture({ folder: true });
		closed.mounts.push("closed", "closed", "closed");
		await closed.host.pass(closed.signal);
		closed.running();
		await closed.host.pass(closed.signal);
		expect(await closed.host.pass(closed.signal)).toEqual([{ ...quiet, folder: "FOLDER_FENCED:CLOSED" }]);
		expect(told(await start(closed))).toEqual({
			company: "none",
			why: "the machine could not mount /company: the company folder closed each view it was handed",
			heldBack: held.start,
		});
		// A view handed over without an answer yet.
		const pending = await fixture({ folder: true });
		pending.mounts.push("unanswered");
		expect(await pending.host.pass(pending.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_UNANSWERED" },
		]);
		pending.running();
		expect(told(await start(pending))).toEqual({ company: "pending", heldBack: held.start });
	});

	it("says why a boot whose folder ended holds its output, and has SQL keep why its restart loses commands", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		const commandId = randomUUID();
		f.running();
		await start(f, commandId);
		f.result(finished);
		f.service.reads = "unproven";
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:UNPROVEN" }]);
		const marks = () => f.calls.filter((call) => call.method === "qorpera_mark_company_machine_folder_restart");
		expect(marks().map((call) => call.args)).toEqual([
			{
				p_placement_id: id(6),
				p_owner: "mx-a",
				p_binding_text: f.entry.bindingText,
				p_machine_id_sha256: "d".repeat(64),
				p_boot_id: f.boot,
				p_reason: "unproven",
			},
		]);
		expect(f.order.indexOf("sql:qorpera_mark_company_machine_folder_restart")).toBeLessThan(
			f.order.indexOf("reboot"),
		);
		const unproven =
			"the executor is restarting the machine because it could not prove what the machine read in /company";
		const receipt = await read(f, commandId);
		expect(receipt).toMatchObject(kept);
		expect(told(receipt)).toEqual({ company: "none", why: unproven, heldBack: held.ended });
		// Each pass that asks the reboot again asks the mark first; a mark that fails changes nothing.
		f.busy.add("qorpera_mark_company_machine_folder_restart");
		expect(await f.host.pass(f.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:UNPROVEN" }]);
		expect(marks()).toHaveLength(2);
		expect(f.order.filter((step) => step === "reboot")).toHaveLength(2);
		f.busy.delete("qorpera_mark_company_machine_folder_restart");
		// The next boot: a read of the command the restart lost says why, with SQL's cause.
		f.reboot();
		f.service.reads = "released";
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		f.running();
		f.result({ state: "lost", exitCode: null, output: "" });
		const lost = await read(f, commandId, undefined, { ...credit(), folderLost: "restart_unproven" });
		expect(lost).toMatchObject({ state: "lost" });
		expect(told(lost)).toEqual({
			company: "mounted",
			lost: "the executor restarted the machine because it could not prove what the machine read in /company",
		});
		// Only a lost receipt says it, and only for a cause the executor knows; a held one says it once it leaves.
		expect(told(await read(f, commandId, undefined, { ...credit(), folderLost: "elsewhere" }))).toEqual({
			company: "mounted",
		});
		f.service.reads = "unanswered";
		expect(told(await read(f, commandId, undefined, { ...credit(), folderLost: "restart_unproven" }))).toEqual({
			company: "mounted",
			heldBack: held.unanswered,
		});
		f.service.reads = "released";
		f.result(finished);
		expect(told(await read(f, commandId, undefined, { ...credit(), folderLost: "restart_unproven" }))).toEqual({
			company: "mounted",
		});
		// A view the core closed: the mark gives its own cause.
		const g = await fixture({ folder: true });
		await g.host.pass(g.signal);
		g.running();
		const [view] = g.views.opened;
		g.service.held = [];
		g.service.closed = [view.viewId];
		expect(await g.host.pass(g.signal)).toEqual([{ ...quiet, folder: "FOLDER_RESTART:VIEW_CLOSED" }]);
		expect(
			g.calls
				.filter((call) => call.method === "qorpera_mark_company_machine_folder_restart")
				.map((call) => call.args),
		).toEqual([expect.objectContaining({ p_boot_id: g.boot, p_reason: "view_closed" })]);
		g.result(finished);
		expect(told(await read(g, randomUUID()))).toEqual({
			company: "none",
			why: "the executor is restarting the machine because its /company view was closed",
			heldBack: held.ended,
		});
	});

	it("says why a boot whose disk is retired holds its output, and asks no restart's mark", async () => {
		const f = await fixture({ folder: true });
		f.views.refusal = "qorpera.test-machine/new-disk";
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_RETIRED:UNCHECKED" },
		]);
		f.running();
		f.result(finished);
		expect(told(await read(f, randomUUID()))).toEqual({
			company: "none",
			why: "the machine is moving to a new disk because a command ran on this one before /company was checked",
			heldBack: held.ended,
		});
		// A boot SQL no longer runs.
		const g = await fixture({ folder: true });
		g.views.refusal = "qorpera.test-machine/new-disk";
		g.retirements.push({ state: "stale" });
		expect(await g.host.pass(g.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_RETIRE_STALE" },
		]);
		g.running();
		g.result(finished);
		expect(told(await read(g, randomUUID()))).toEqual({
			company: "none",
			why: "this boot of the machine is no longer the current one",
			heldBack: held.ended,
		});
		// A take-in the core refuses as unreadable: that receipt says the take-in was refused, the boot's later ones that
		// the read is unreadable, and once the pass retired the disk, why the boot has no /company.
		const h = await fixture({ folder: true });
		await h.host.pass(h.signal);
		h.running();
		h.result(finished);
		const commandId = randomUUID();
		await start(h, commandId);
		h.inherits.push(new CodingControlRefused("qorpera.test-machine/unreadable"));
		expect(told(await read(h, commandId))).toEqual({ company: "mounted", heldBack: held.refused });
		expect(told(await cancel(h, commandId))).toEqual({ company: "mounted", heldBack: held.unreadable });
		expect(await h.host.pass(h.signal)).toEqual([{ ...quiet, folder: "FOLDER_RETIRED:UNREADABLE" }]);
		expect(told(await read(h, commandId))).toEqual({
			company: "none",
			why: "the machine is moving to a new disk because something it read in /company is no longer readable",
			heldBack: held.ended,
		});
		for (const k of [f, g, h]) expect(k.methods()).not.toContain("qorpera_mark_company_machine_folder_restart");
	});

	it("lists the paths the folder did not take once, on the boot's next receipt whose output leaves", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		f.result(finished);
		// A pass's plain boundary publishes the view's changes: saved, still pending, and not taken.
		f.service.report = {
			commitId: randomUUID(),
			seq: 4,
			paths: [
				{ path: "notes/plan.md", outcome: "conflict", reason: "changed meanwhile", receipt: randomUUID() },
				{ path: "notes/done.md", outcome: "saved" },
				{ path: "notes/later.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
				{ path: "people/pay.md", outcome: "denied" },
			],
		};
		expect(await f.host.pass(f.signal)).toEqual([quiet]);
		f.service.report = {};
		// A held receipt keeps them for the one that leaves; after it, they are said.
		expect(told(await start(f, commandId))).toEqual({ company: "mounted", heldBack: held.start });
		f.service.reads = "unproven";
		expect(told(await read(f, commandId))).toEqual({ company: "mounted", heldBack: held.unproven });
		f.service.reads = "released";
		expect(told(await read(f, commandId))).toEqual({
			company: "mounted",
			notSaved: [
				{ path: "notes/plan.md", outcome: "conflict", reason: "changed meanwhile" },
				{ path: "people/pay.md", outcome: "denied" },
			],
		});
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
		// A read's own boundary, and a window's close, say theirs too. Past 8, or past the report's size as the agent's tool
		// measures it, the rest are counted; a path the report cannot show is counted too.
		f.service.report = {
			commitId: null,
			seq: null,
			paths: [
				...Array.from({ length: 10 }, (_, n) => ({
					path: `reports/q${n}.md`,
					outcome: "refused",
					reason: `${"too long ".repeat(40)}${n}`,
				})),
				{ path: "x".repeat(400), outcome: "refused" },
			],
		};
		const many = told(await read(f, commandId));
		expect(many?.company).toBe("mounted");
		const listed = many?.notSaved ?? [];
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.length).toBeLessThan(8);
		expect(listed.length + (many?.moreNotSaved ?? 0)).toBe(11);
		expect(listed.map((item) => item.path)).toEqual(listed.map((_, n) => `reports/q${n}.md`));
		for (const item of listed) expect(item.reason).toHaveLength(200);
		expect(cloudMachineFolderBytes(many!)).toBeLessThanOrEqual(1536);
		f.service.report = {
			commitId: null,
			seq: null,
			paths: [{ path: "notes/end.md", outcome: "waiting_for_review" }],
		};
		f.running([commandId]);
		f.observe({ ...idle, ended: [{ commandId, state: "succeeded", exitCode: 0, outputTail: "ok" }] });
		await f.host.pass(f.signal);
		expect(f.service.requests.at(-1)).toEqual({ op: "close", machine: id(6), commandId });
		f.service.report = {};
		expect(told(await read(f, commandId))).toEqual({
			company: "mounted",
			notSaved: [{ path: "notes/end.md", outcome: "waiting_for_review" }],
		});
		// A boot's paths are said on that boot's receipts only: its final boundary's are not the next boot's.
		f.running();
		f.observe({ ...idle, ended: [] });
		f.service.report = { commitId: null, seq: null, paths: [{ path: "notes/old.md", outcome: "denied" }] };
		f.reboot();
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: id(6), step: "start", state: "done", folder: "FOLDER_MOUNTED" },
		]);
		expect(f.service.requests.at(-2)).toMatchObject({ op: "boundary", final: [expect.any(String)] });
		f.service.report = {};
		f.running();
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
	});

	it("says a write its view keeps pending on every receipt while it stays refused, and one on its way once it settles", async () => {
		const f = await fixture({ folder: true });
		await f.host.pass(f.signal);
		f.running();
		const commandId = randomUUID();
		f.result(finished);
		// The service keeps a refused write with new bytes pending, and a conflict whose bytes the receipt did not keep:
		// each boundary tries them again and reports them again, as it does an open file and a save not answered yet.
		const refusing = {
			commitId: randomUUID(),
			seq: 5,
			paths: [
				{ path: "people/pay.md", outcome: "denied", reason: "denied", kept: true },
				{ path: "reports/q3.md", outcome: "refused", reason: "command_ended", kept: true },
				{ path: "notes/both.md", outcome: "conflict", reason: "changed meanwhile", kept: true },
				{ path: "notes/open.md", outcome: "waiting", reason: "still open for writing", kept: true },
				{ path: "notes/later.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
			],
		};
		f.service.report = refusing;
		expect(await f.host.pass(f.signal)).toEqual([quiet]);
		expect(told(await start(f, commandId))).toEqual({ company: "mounted", heldBack: held.start });
		const both = {
			company: "mounted",
			stillNotSaved: [
				{ path: "people/pay.md", outcome: "denied", reason: "denied" },
				{ path: "reports/q3.md", outcome: "refused", reason: "command_ended" },
				{ path: "notes/both.md", outcome: "conflict", reason: "changed meanwhile" },
			],
		};
		// Said once on a receipt, though the pass's boundary and the read's both reported them; and again on the next
		// receipt, as long as the view still keeps them pending.
		expect(told(await read(f, commandId))).toEqual(both);
		expect(told(await read(f, commandId))).toEqual(both);
		// A quiet publish saved them meanwhile (only the service's notices say so): the view keeps nothing pending, and
		// nothing is said. Written and refused again the same way, they are said again.
		f.service.report = { commitId: null, seq: null, paths: [] };
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
		f.service.report = refusing;
		expect(told(await read(f, commandId))).toEqual(both);
		// A change set refused whole by the pause keeps what it carried for a later boundary: nothing is said for it yet.
		f.service.report = {
			commitId: null,
			seq: null,
			refused: "stopped",
			paths: [{ path: "notes/paused.md", outcome: "refused", reason: "stopped", kept: true }],
		};
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
		// Once they settle, a path that was on its way is said once with its answer, and one kept refused is said beside it.
		f.service.report = {
			commitId: randomUUID(),
			seq: 6,
			paths: [
				{ path: "people/pay.md", outcome: "saved" },
				{ path: "notes/open.md", outcome: "saved" },
				{ path: "notes/later.md", outcome: "conflict", reason: "changed meanwhile", receipt: randomUUID() },
				{ path: "notes/paused.md", outcome: "denied", reason: "denied", kept: true },
			],
		};
		expect(told(await read(f, commandId))).toEqual({
			company: "mounted",
			notSaved: [{ path: "notes/later.md", outcome: "conflict", reason: "changed meanwhile" }],
			stillNotSaved: [{ path: "notes/paused.md", outcome: "denied", reason: "denied" }],
		});
		f.service.report = {
			commitId: null,
			seq: null,
			paths: [{ path: "notes/paused.md", outcome: "denied", reason: "denied", kept: true }],
		};
		expect(told(await read(f, commandId))).toEqual({
			company: "mounted",
			stillNotSaved: [{ path: "notes/paused.md", outcome: "denied", reason: "denied" }],
		});
		// Past 8 they are counted, on every receipt alike.
		f.service.report = {
			commitId: null,
			seq: null,
			paths: Array.from({ length: 10 }, (_, n) => ({ path: `reports/r${n}.md`, outcome: "denied", kept: true })),
		};
		const pending = {
			company: "mounted",
			stillNotSaved: Array.from({ length: 8 }, (_, n) => ({ path: `reports/r${n}.md`, outcome: "denied" })),
			moreStillNotSaved: 2,
		};
		expect(told(await read(f, commandId))).toEqual(pending);
		expect(told(await read(f, commandId))).toEqual(pending);
		// A view the service no longer lists keeps nothing pending.
		f.service.held = [];
		expect(told(await read(f, commandId))).toEqual({ company: "mounted" });
	});
});

// The journal lives on the NAS control path, in its own folder.
it("keeps company machine journals apart from coding machines'", async () => {
	const f = await fixture();
	await f.host.pass(f.signal);
	await expect(mkdir(join(state.controlPath, "company-machines", id(6)))).rejects.toThrow(/EEXIST/);
});

// 20260930705000: save_coding_value runs the image's clipboard helper on the machine, on the boot SQL named, with SQL's
// target on its stdin; only its one line of stdout (a box or a refusal code) comes back. A run that did not end cleanly
// is followed by the executor's own clear (`--clear-only`), on the same boot, under its own deadline.
describe("a machine's clipboard helper", () => {
	const box = {
		schema: "qorpera.coding-value-machine-box/v1",
		ephemeralPublicKey: "ZXBo",
		iv: "aXY",
		tag: "dGFn",
		ciphertext: "Y2lwaGVy",
	};
	const run = {
		placementId: id(6),
		bootId: id(7),
		receiptId: id(8),
		target: { schema: "qorpera.coding-value-machine-target/v1" },
		desktopGeneration: 2,
	};
	const cleared = `${JSON.stringify({ schema: "qorpera.machine-coding-value-cleared/v1" })}\n`;
	type Answer = { exitCode: number; stdout: string } | "hang";
	/** The helper's run answers `answer` (or hangs until its signal aborts); its clear answers `clear`. Each call is
	 * kept with whether its signal was aborted when it was made. */
	async function piped(
		answer: Answer,
		clear: Answer = { exitCode: 0, stdout: cleared },
		deadlines: { codingValueTimeoutMs?: number; codingValueClearTimeoutMs?: number } = {},
	) {
		const f = await fixture(deadlines);
		const calls: { request: LxdExecPipeRequest; name: string; signal: AbortSignal; abortedAtCall: boolean }[] = [];
		const pipe = vi.fn(async (_project: string, name: string, request: LxdExecPipeRequest, signal: AbortSignal) => {
			calls.push({ request, name, signal, abortedAtCall: signal.aborted });
			const given = request.command.at(-1) === "--clear-only" ? clear : answer;
			if (given === "hang")
				return new Promise<never>((_resolve, reject) => {
					if (signal.aborted) reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			return { exitCode: given.exitCode, stdout: Buffer.from(given.stdout), stderrTail: Buffer.alloc(0) };
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		return { f, pipe, calls };
	}
	/** The executor's own clear: the same helper with --clear-only, on the same machine and boot. */
	const clearCommand = [
		"/bin/sh",
		"-c",
		expect.stringContaining('[ "$boot" = "$0" ]; } || exit 97; [ -f "$2" ] || exit 98; exec "$@"'),
		id(7),
		"/usr/bin/node",
		"/opt/qorpera-machine/cloud-machine-coding-value.mjs",
		"--clear-only",
	];

	it("runs the helper as the executor runs it, on SQL's boot with SQL's target, and answers its box", async () => {
		const { f, pipe } = await piped({
			exitCode: 0,
			stdout: `${JSON.stringify({ schema: "qorpera.machine-coding-value-box/v1", box })}\n`,
		});
		expect(await f.host.codingValue(run, f.signal)).toEqual({ box });
		const [project, name, request] = pipe.mock.calls[0]!;
		expect(project).toBe("machines");
		expect(name).toBe(lxdCompanyMachineName(id(6)));
		expect(request.command).toEqual([
			"/bin/sh",
			"-c",
			expect.stringContaining('[ "$boot" = "$0" ]; } || exit 97; [ -f "$2" ] || exit 98; exec "$@"'),
			id(7),
			"/usr/bin/node",
			COMPANY_MACHINE_CODING_VALUE_HELPER,
		]);
		expect(COMPANY_MACHINE_CODING_VALUE_HELPER).toBe("/opt/qorpera-machine/cloud-machine-coding-value.mjs");
		expect(JSON.parse(Buffer.from(request.stdin as Uint8Array).toString("utf8"))).toEqual(run.target);
		expect(request).toMatchObject({ environment: {}, cwd: "/", maxStdoutBytes: 16384, stderrTailBytes: 0 });
		// It ended cleanly, its own clear with it: no second exec. No command of the machine's is started or recorded.
		expect(pipe).toHaveBeenCalledTimes(1);
		expect(f.methods()).not.toContain("qorpera_authorize_machine_command");
	});

	it("answers the helper's refusal, another boot and an earlier image by code, with no clear of its own", async () => {
		for (const [answer, outcome] of [
			[
				{
					exitCode: 0,
					stdout: JSON.stringify({ schema: "qorpera.machine-coding-value-refusal/v1", code: "CLIPBOARD_EMPTY" }),
				},
				{ refused: "CLIPBOARD_EMPTY" },
			],
			// Neither ran the helper: another boot's clipboard went with it, and an earlier image has neither it nor xsel.
			[{ exitCode: 97, stdout: "" }, { refused: "MACHINE_BOOT_CHANGED" }],
			[{ exitCode: 98, stdout: "" }, { refused: "MACHINE_IMAGE_WITHOUT_CODING_VALUES" }],
		] as const) {
			const { f, pipe } = await piped(answer);
			expect(await f.host.codingValue(run, f.signal)).toEqual(outcome);
			expect(pipe).toHaveBeenCalledTimes(1);
		}
		const { f } = await piped({ exitCode: 0, stdout: "" });
		await expect(f.host.codingValue({ ...run, bootId: "boot" }, f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_CODING_VALUE_INVALID",
		);
		// Without the lease generation SQL's read saw (F29): never run.
		for (const desktopGeneration of [-1, 1.5, Number.NaN])
			await expect(f.host.codingValue({ ...run, desktopGeneration }, f.signal)).rejects.toThrow(
				"COMPANY_MACHINE_CODING_VALUE_INVALID",
			);
		// A client without the pipe exec: never run.
		const bare = await fixture();
		await expect(bare.host.codingValue(run, bare.signal)).rejects.toThrow("COMPANY_MACHINE_CODING_VALUE_UNAVAILABLE");
	});

	it("clears the clipboard itself after a failed exit or an answer that is not the helper's", async () => {
		for (const [answer, error] of [
			[{ exitCode: 1, stdout: "MACHINE_CODING_VALUE_FAILED" }, "COMPANY_MACHINE_CODING_VALUE_FAILED"],
			[{ exitCode: 137, stdout: "" }, "COMPANY_MACHINE_CODING_VALUE_FAILED"],
			[{ exitCode: 0, stdout: "" }, "COMPANY_MACHINE_CODING_VALUE_INVALID"],
			[{ exitCode: 0, stdout: "npm_not json" }, "COMPANY_MACHINE_CODING_VALUE_INVALID"],
			[
				{ exitCode: 0, stdout: JSON.stringify({ schema: "qorpera.machine-coding-value-box/v1", box, value: "x" }) },
				"COMPANY_MACHINE_CODING_VALUE_INVALID",
			],
			[
				{
					exitCode: 0,
					stdout: JSON.stringify({ schema: "qorpera.machine-coding-value-box/v1", box: { ...box, value: "x" } }),
				},
				"COMPANY_MACHINE_CODING_VALUE_INVALID",
			],
			[
				{
					exitCode: 0,
					stdout: JSON.stringify({ schema: "qorpera.machine-coding-value-refusal/v1", code: "lower case" }),
				},
				"COMPANY_MACHINE_CODING_VALUE_INVALID",
			],
		] as const) {
			const { f, calls } = await piped(answer);
			await expect(f.host.codingValue(run, f.signal), JSON.stringify(answer)).rejects.toThrow(error);
			expect(calls.map((call) => call.request.command)).toEqual([expect.anything(), clearCommand]);
			expect(calls[1]).toMatchObject({ name: lxdCompanyMachineName(id(6)), abortedAtCall: false });
			expect(calls[1]!.request).toMatchObject({ environment: {}, cwd: "/", stderrTailBytes: 0 });
			expect(calls[1]!.request.stdin).toBeUndefined();
		}
	});

	it("clears the clipboard itself when the request is cancelled mid-run, on its own signal and the same boot", async () => {
		const { f, calls } = await piped("hang");
		const request = new AbortController();
		const saving = f.host.codingValue(run, request.signal);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		request.abort(new Error("the gateway's request ended"));
		await expect(saving).rejects.toThrow("the gateway's request ended");
		expect(calls).toHaveLength(2);
		expect(calls[0]!.signal.aborted).toBe(true);
		// The clear came after the cancellation, under a signal of its own that the request's abort never reached.
		expect(calls[1]!.request.command).toEqual(clearCommand);
		expect(calls[1]!.name).toBe(calls[0]!.name);
		expect(calls[1]!.abortedAtCall).toBe(false);
		expect(calls[1]!.signal).not.toBe(calls[0]!.signal);
		expect(calls[1]!.signal.aborted).toBe(false);
	});

	it("clears the clipboard itself when the helper outlives its deadline, which kills it", async () => {
		const { f, calls } = await piped("hang", undefined, { codingValueTimeoutMs: 50 });
		await expect(f.host.codingValue(run, f.signal)).rejects.toThrow();
		expect(calls).toHaveLength(2);
		expect(calls[0]!.signal.aborted).toBe(true);
		expect(f.signal.aborted).toBe(false);
		expect(calls[1]!.request.command).toEqual(clearCommand);
		expect(calls[1]!.abortedAtCall).toBe(false);
	});

	it("logs only a fixed word when its own clear fails, and nothing when the machine restarted meanwhile", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			for (const clear of [
				{ exitCode: 1, stdout: "" },
				{ exitCode: 0, stdout: "something else" },
				"hang",
			] as const) {
				errors.mockClear();
				// Its own deadline ends a clear that never answers.
				const { f, calls } = await piped({ exitCode: 1, stdout: "" }, clear, { codingValueClearTimeoutMs: 50 });
				await expect(f.host.codingValue(run, f.signal)).rejects.toThrow("COMPANY_MACHINE_CODING_VALUE_FAILED");
				expect(calls).toHaveLength(2);
				if (clear === "hang") expect(calls[1]!.signal.aborted).toBe(true);
				expect(errors.mock.calls).toEqual([["COMPANY_MACHINE_CODING_VALUE_CLEAR_FAILED"]]);
			}
			errors.mockClear();
			const restarted = await piped({ exitCode: 1, stdout: "" }, { exitCode: 97, stdout: "" });
			await expect(restarted.f.host.codingValue(run, restarted.f.signal)).rejects.toThrow(
				"COMPANY_MACHINE_CODING_VALUE_FAILED",
			);
			expect(restarted.calls).toHaveLength(2);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});

describe("a machine's screen helper (machine_screen, 20260930708000)", () => {
	/** A PNG's signature and IHDR (13 bytes and its check), then `rest` bytes: what the host reads of a screenshot. */
	const png = (width = 1600, height = 1000, rest = 64) => {
		const ihdr = Buffer.alloc(25);
		ihdr.writeUInt32BE(13, 0);
		ihdr.write("IHDR", 4, "latin1");
		ihdr.writeUInt32BE(width, 8);
		ihdr.writeUInt32BE(height, 12);
		ihdr.set([8, 6, 0, 0, 0], 16);
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			ihdr,
			Buffer.alloc(rest, 7),
		]);
	};
	const header = (picture: Buffer | null, extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.machine-screen/v1",
		started: false,
		action: { type: "click", exitCode: 0 },
		activeWindow: "Sign in - Chromium",
		windows: ["Sign in - Chromium", "Terminal"],
		moreWindows: 0,
		png: picture ? picture.length : 0,
		...extra,
	});
	const output = (value: Record<string, unknown>, picture: Buffer | null = null) =>
		Buffer.concat([Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), picture ?? Buffer.alloc(0)]);
	const request = {
		schema: "qorpera.machine-screen-request/v1",
		receiptId: id(8),
		action: { type: "click", x: 812, y: 443 },
		settleMs: 500,
		look: true,
	};
	const run = (bootId = id(7)) => ({ placementId: id(6), bootId, runId: id(9), request, desktopGeneration: 3 });
	type Answer = { exitCode: number; stdout: Buffer } | "hang";
	async function piped(answer: Answer, options: Parameters<typeof fixture>[0] = {}) {
		const f = await fixture(options);
		const calls: { request: LxdExecPipeRequest; name: string; signal: AbortSignal }[] = [];
		const pipe = vi.fn(async (_project: string, name: string, given: LxdExecPipeRequest, signal: AbortSignal) => {
			calls.push({ request: given, name, signal });
			f.order.push("exec:screen");
			if (answer === "hang")
				return new Promise<never>((_resolve, reject) => {
					if (signal.aborted) reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			return { exitCode: answer.exitCode, stdout: answer.stdout, stderrTail: Buffer.alloc(0) };
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		return { f, pipe, calls };
	}

	it("runs the helper as the executor runs it, on SQL's boot with the request on stdin, and answers its header and PNG", async () => {
		const picture = png();
		const { f, pipe } = await piped({ exitCode: 0, stdout: output(header(picture), picture) });
		const shot = await f.host.screen(run(), f.signal);
		expect(shot).toEqual({ header: header(picture), png: picture });
		const [project, name, given] = pipe.mock.calls[0]!;
		expect(project).toBe("machines");
		expect(name).toBe(lxdCompanyMachineName(id(6)));
		expect(given.command).toEqual([
			"/bin/sh",
			"-c",
			expect.stringContaining('[ "$boot" = "$0" ]; } || exit 97; [ -f "$2" ] || exit 98; exec "$@"'),
			id(7),
			"/usr/bin/node",
			COMPANY_MACHINE_SCREEN_HELPER,
		]);
		expect(COMPANY_MACHINE_SCREEN_HELPER).toBe("/opt/qorpera-machine/cloud-machine-screen.mjs");
		// The verb and its arguments travel on stdin, never in the argv.
		expect(JSON.parse(Buffer.from(given.stdin as Uint8Array).toString("utf8"))).toEqual(request);
		expect(given).toMatchObject({
			environment: {},
			cwd: "/",
			maxStdoutBytes: 8 * 1024 * 1024 + 65536,
			stderrTailBytes: 0,
		});
		// Without the folder service there is no /company to release: no boundary, no take-in, no command; only the fence
		// after the capture (20260930713000): the lease generation the read saw, and no member's hold (null: an agent).
		expect(pipe).toHaveBeenCalledTimes(1);
		expect(f.methods()).toEqual(["qorpera_machine_desktop_picture_check"]);
		expect(f.calls.find((call) => call.method === "qorpera_machine_desktop_picture_check")?.args).toEqual({
			p_placement_id: id(6),
			p_generation: 3,
			p_user_id: null,
		});
		// A header with no picture (look false) is answered as such.
		const none = await piped({ exitCode: 0, stdout: output(header(null)) });
		expect(await none.f.host.screen(run(), none.f.signal)).toEqual({ header: header(null), png: null });
	});

	it("answers an action taken before, another boot, an earlier image and the helper's refusals by code", async () => {
		for (const [answer, outcome] of [
			// The action ran on this boot before: it never runs again.
			[{ exitCode: 96, stdout: Buffer.alloc(0) }, { refused: "SCREEN_ACTION_TAKEN" }],
			[{ exitCode: 97, stdout: Buffer.alloc(0) }, { refused: "MACHINE_BOOT_CHANGED" }],
			[{ exitCode: 98, stdout: Buffer.alloc(0) }, { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" }],
			[
				{
					exitCode: 0,
					stdout: output({ schema: "qorpera.machine-screen-refusal/v1", code: "DESKTOP_NOT_RUNNING" }),
				},
				{ refused: "DESKTOP_NOT_RUNNING" },
			],
		] as const) {
			const { f, pipe } = await piped(answer, { folder: true });
			expect(await f.host.screen(run(), f.signal)).toEqual(outcome);
			expect(pipe).toHaveBeenCalledTimes(1);
			// Nothing was shown, so nothing is released.
			expect(f.methods()).not.toContain("qorpera_folder_test_machine_inherit_reads");
		}
	});

	it("refuses an answer that is not the helper's, a failed helper, and a request it cannot run", async () => {
		const picture = png();
		const bad: [Buffer, string][] = [
			[Buffer.alloc(0), "no header"],
			[Buffer.from("not json\n"), "not json"],
			[output({ ...header(picture), shown: true }, picture), "another field"],
			[output(header(picture)), "a PNG missing"],
			[Buffer.concat([output(header(picture), picture), Buffer.from("x")]), "a byte past the PNG"],
			[output(header(null), picture), "a PNG no header names"],
			[output(header(png(3841, 1000)), png(3841, 1000)), "wider than a screen"],
			[output(header(png(1600, 2161)), png(1600, 2161)), "taller than a screen"],
			[output(header(png(0, 1000)), png(0, 1000)), "no width"],
			[
				output(
					header(Buffer.concat([Buffer.alloc(8), png().subarray(8)])),
					Buffer.concat([Buffer.alloc(8), png().subarray(8)]),
				),
				"no PNG signature",
			],
			[output(header(picture, { windows: Array.from({ length: 17 }, () => "w") }), picture), "17 windows"],
			[output(header(picture, { activeWindow: "a\u0007b" }), picture), "a control character"],
			[output(header(picture, { activeWindow: "x".repeat(121) }), picture), "a long title"],
			[output(header(picture, { action: { type: "fly", exitCode: 0 } }), picture), "another verb"],
			[output(header(picture, { action: { type: "click", exitCode: 256 } }), picture), "an exit past 255"],
			[
				output(header(picture, { action: { type: "click", exitCode: 1, error: "e".repeat(301) } }), picture),
				"a long error",
			],
			[output({ schema: "qorpera.machine-screen-refusal/v1", code: "lower" }), "a refusal of no code"],
			[
				Buffer.concat([
					output({ schema: "qorpera.machine-screen-refusal/v1", code: "DESKTOP_NOT_RUNNING" }),
					picture,
				]),
				"a refusal with bytes",
			],
			[Buffer.from(`${"x".repeat(65537)}\n`), "a header past its bound"],
		];
		for (const [stdout, what] of bad) {
			const { f } = await piped({ exitCode: 0, stdout });
			await expect(f.host.screen(run(), f.signal), what).rejects.toThrow("COMPANY_MACHINE_SCREEN_INVALID");
		}
		const failed = await piped({ exitCode: 1, stdout: Buffer.from("MACHINE_SCREEN_FAILED\n") });
		await expect(failed.f.host.screen(run(), failed.f.signal)).rejects.toThrow("COMPANY_MACHINE_SCREEN_FAILED");
		const { f, pipe } = await piped({ exitCode: 0, stdout: output(header(null)) });
		for (const wrong of [
			{ bootId: "boot" },
			{ runId: "run" },
			{ placementId: "placement" },
			{ desktopGeneration: -1 },
			{ desktopGeneration: 1.5 },
		])
			await expect(f.host.screen({ ...run(), ...wrong }, f.signal)).rejects.toThrow(
				"COMPANY_MACHINE_SCREEN_INVALID",
			);
		expect(pipe).not.toHaveBeenCalled();
		// A client without the pipe exec: never run.
		const bare = await fixture();
		await expect(bare.host.screen(run(), bare.signal)).rejects.toThrow("COMPANY_MACHINE_SCREEN_UNAVAILABLE");
	});

	it("ends the helper at its own deadline, and with the request", async () => {
		const { f, calls } = await piped("hang", { screenTimeoutMs: 50 });
		await expect(f.host.screen(run(), f.signal)).rejects.toThrow();
		expect(calls[0]!.signal.aborted).toBe(true);
		expect(f.signal.aborted).toBe(false);
		const cancelled = await piped("hang");
		const controller = new AbortController();
		const looking = cancelled.f.host.screen(run(), controller.signal);
		await vi.waitFor(() => expect(cancelled.calls).toHaveLength(1));
		controller.abort(new Error("the gateway's request ended"));
		await expect(looking).rejects.toThrow("the gateway's request ended");
	});

	/** A machine with /company, its boot's folder settled (mounted) and running, and the helper answering a screen. */
	async function mounted(options: Parameters<typeof fixture>[0] = {}) {
		const picture = png();
		const piping = await piped(
			{ exitCode: 0, stdout: output(header(picture), picture) },
			{ folder: true, ...options },
		);
		const { f } = piping;
		await f.host.pass(f.signal);
		f.running();
		await f.host.pass(f.signal);
		f.order.length = 0;
		f.service.requests.length = 0;
		f.calls.length = 0;
		return { ...piping, picture };
	}

	it("lets a screen of a machine with /company leave only after a boundary released its reads and the run took them in", async () => {
		const { f, picture } = await mounted();
		expect(await f.host.screen(run(f.boot), f.signal)).toEqual({ header: header(picture), png: picture });
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
		const inherit = f.calls.find((call) => call.method === "qorpera_folder_test_machine_inherit_reads");
		expect(inherit?.args).toMatchObject({ p_placement_id: id(6), p_boot_id: f.boot, p_run_id: id(9) });
		// The helper first, then the boundary, then the run's take-in.
		expect(f.order).toEqual([
			"exec:screen",
			"sql:qorpera_machine_desktop_picture_check",
			"folder:boundary",
			"sql:qorpera_folder_test_machine_inherit_reads",
		]);
	});

	it("holds the picture and the titles back when the folder does not release the reads, and tells what the action did", async () => {
		const held = (shot: unknown, why: string) =>
			expect(shot).toEqual({
				header: header(null, { activeWindow: null, windows: [] }),
				png: null,
				heldBack: expect.stringContaining(why),
			});
		for (const [reads, why] of [
			["unanswered", "has not said yet"],
			["unproven", "cannot prove"],
			["unreadable", "no longer readable"],
			["stopped", "paused"],
		] as const) {
			const { f } = await mounted();
			f.service.reads = reads;
			held(await f.host.screen(run(f.boot), f.signal), why);
			// Nothing is taken in for a picture that stays.
			expect(f.methods()).not.toContain("qorpera_folder_test_machine_inherit_reads");
		}
		// A service that does not answer holds it too.
		const { f } = await mounted();
		f.service.down = true;
		held(await f.host.screen(run(f.boot), f.signal), "has not said yet");
		// The run's take-in refused: the read is no longer readable to it, and the boot's later output stays held.
		const refused = await mounted();
		refused.f.inherits.push(new CodingControlRefused("qorpera.test-machine/unreadable"));
		held(await refused.f.host.screen(run(refused.f.boot), refused.f.signal), "could not take in");
		held(await refused.f.host.screen(run(refused.f.boot), refused.f.signal), "no longer readable");
		const untaken = await mounted();
		untaken.f.inherits.push(new Error("CODING_CONTROL_UNCONFIRMED"));
		held(await untaken.f.host.screen(run(untaken.f.boot), untaken.f.signal), "did not answer this run's take-in");
	});

	it("tells nothing of the guest's error text when the picture is held back, only the verb and its exit (review r1 F3)", async () => {
		const secret = "sensitive: the contents of /company/finance/salaries.csv";
		const action = { type: "type", exitCode: 1, error: secret };
		for (const hold of ["refused", "unproven"] as const) {
			const picture = png();
			const piping = await piped(
				{ exitCode: 0, stdout: output(header(picture, { action }), picture) },
				{ folder: true },
			);
			const { f } = piping;
			await f.host.pass(f.signal);
			f.running();
			await f.host.pass(f.signal);
			if (hold === "refused") f.inherits.push(new CodingControlRefused("qorpera.test-machine/unreadable"));
			else f.service.reads = "unproven";
			const shot = await f.host.screen(run(f.boot), f.signal);
			expect(shot).toMatchObject({
				header: { action: { type: "type", exitCode: 1 }, activeWindow: null, windows: [] },
				png: null,
				heldBack: expect.any(String),
			});
			expect(JSON.stringify(shot)).not.toContain("sensitive");
			expect(JSON.stringify(shot)).not.toContain("salaries");
		}
		// Released, the action's error is told as the helper gave it.
		const { f } = await mounted();
		Object.assign(f.client, {
			execInstancePipe: vi.fn(async () => ({
				exitCode: 0,
				stdout: output(header(png(), { action }), png()),
				stderrTail: Buffer.alloc(0),
			})),
		});
		expect(await f.host.screen(run(f.boot), f.signal)).toMatchObject({ header: { action } });
	});

	it("refuses a second action on a desktop while one runs, serves a look meanwhile, and frees it once the first ends (review r1 F4)", async () => {
		const f = await fixture();
		const picture = png();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pipe = vi.fn(async () => {
			if (pipe.mock.calls.length === 1) await gate;
			return { exitCode: 0, stdout: output(header(picture), picture), stderrTail: Buffer.alloc(0) };
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		const action = (receipt: number) => ({ ...run(), request: { ...request, receiptId: id(receipt) } });
		const look = { ...run(), request: { ...request, receiptId: null, action: null } };
		const first = f.host.screen(action(8), f.signal);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(1));
		// Another run's action: refused before the helper (no receipt marker made on the machine).
		expect(await f.host.screen({ ...action(11), runId: id(12) }, f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
		expect(pipe).toHaveBeenCalledTimes(1);
		// A look is served meanwhile; another machine's desktop is not this one.
		expect(await f.host.screen(look, f.signal)).toEqual({ header: header(picture), png: picture });
		expect(await f.host.screen({ ...action(13), placementId: id(14) }, f.signal)).toMatchObject({ png: picture });
		expect(pipe).toHaveBeenCalledTimes(3);
		release();
		expect(await first).toMatchObject({ png: picture });
		// The first ended: the next action runs.
		expect(await f.host.screen(action(15), f.signal)).toMatchObject({ png: picture });
		expect(pipe).toHaveBeenCalledTimes(4);
		// An action whose command failed, told by a helper that reached its own end (exit 0), frees it at once too; so
		// does a helper that never acted (the receipt's action was taken before: 96).
		const failed = header(picture, { action: { type: "type", exitCode: 1, error: "no window took the text" } });
		pipe.mockResolvedValueOnce({ exitCode: 0, stdout: output(failed, picture), stderrTail: Buffer.alloc(0) });
		expect(await f.host.screen(action(16), f.signal)).toMatchObject({ header: { action: { exitCode: 1 } } });
		pipe.mockResolvedValueOnce({ exitCode: 96, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) });
		expect(await f.host.screen(action(17), f.signal)).toHaveProperty("refused");
		expect(await f.host.screen(action(18), f.signal)).toMatchObject({ png: picture });
	});

	it("keeps a desktop busy after a helper that returned without reaching its own end, as its action's unit lives on (review r3 F4)", async () => {
		let clock = 1_800_000_000_000;
		const picture = png();
		// Killed inside the machine (137: the exec returns, the action's unit runs on to its limit), or failed (1).
		for (const exitCode of [137, 1]) {
			const f = await fixture({ now: () => clock });
			const pipe = vi.fn(async () =>
				pipe.mock.calls.length === 1
					? { exitCode, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) }
					: { exitCode: 0, stdout: output(header(picture), picture), stderrTail: Buffer.alloc(0) },
			);
			Object.assign(f.client, { execInstancePipe: pipe });
			const action = (receipt: number) => ({ ...run(), request: { ...request, receiptId: id(receipt) } });
			await expect(f.host.screen(action(8), f.signal)).rejects.toThrow("COMPANY_MACHINE_SCREEN_FAILED");
			// Another run's action meets the grace, not the helper; a look is served.
			expect(await f.host.screen({ ...action(11), runId: id(12) }, f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
			expect(
				await f.host.screen({ ...run(), request: { ...request, receiptId: null, action: null } }, f.signal),
			).toMatchObject({ png: picture });
			clock += 10_999;
			expect(await f.host.screen(action(13), f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
			clock += 2;
			expect(await f.host.screen(action(15), f.signal)).toMatchObject({ png: picture });
			expect(pipe).toHaveBeenCalledTimes(3);
		}
	});

	it("keeps a desktop busy for the action deadline and its kill after an action that was cut off, as what it started may type on", async () => {
		let clock = 1_800_000_000_000;
		const f = await fixture({ now: () => clock });
		const picture = png();
		const pipe = vi.fn(async (_project: string, _name: string, _given: LxdExecPipeRequest, signal: AbortSignal) => {
			if (pipe.mock.calls.length === 1)
				return new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			return { exitCode: 0, stdout: output(header(picture), picture), stderrTail: Buffer.alloc(0) };
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		const action = (receipt: number) => ({ ...run(), request: { ...request, receiptId: id(receipt) } });
		const controller = new AbortController();
		const cut = f.host.screen(action(8), controller.signal);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(1));
		controller.abort(new Error("the gateway's request ended"));
		await expect(cut).rejects.toThrow("the gateway's request ended");
		expect(await f.host.screen(action(11), f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
		// A look is served all the same.
		expect(
			await f.host.screen({ ...run(), request: { ...request, receiptId: null, action: null } }, f.signal),
		).toMatchObject({
			png: picture,
		});
		// The action's own deadline (10 s, kept by its unit on the machine) and a second for its kill to land.
		clock += 10_999;
		expect(await f.host.screen(action(12), f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
		clock += 2;
		expect(await f.host.screen(action(13), f.signal)).toMatchObject({ png: picture });
		expect(pipe).toHaveBeenCalledTimes(3);
		// Past its own deadline (screenTimeoutMs), the same.
		const slow = await fixture({ now: () => clock, screenTimeoutMs: 20 });
		Object.assign(slow.client, {
			execInstancePipe: vi.fn(
				(_project: string, _name: string, _given: LxdExecPipeRequest, signal: AbortSignal) =>
					new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			),
		});
		await expect(slow.host.screen(action(8), slow.signal)).rejects.toThrow();
		expect(await slow.host.screen(action(11), slow.signal)).toEqual({ refused: "DESKTOP_BUSY" });
	});

	it("takes in the reads of a boot without /company with no boundary, and asks one for a boot it does not know", async () => {
		const { f, picture } = await mounted({});
		const none = await piped({ exitCode: 0, stdout: output(header(picture), picture) }, { folder: true });
		none.f.views.refusal = null;
		await none.f.host.pass(none.f.signal);
		none.f.running();
		await none.f.host.pass(none.f.signal);
		none.f.service.requests.length = 0;
		none.f.calls.length = 0;
		expect(await none.f.host.screen(run(none.f.boot), none.f.signal)).toEqual({
			header: header(picture),
			png: picture,
		});
		expect(none.f.service.requests).toEqual([]);
		expect(none.f.methods()).toEqual([
			"qorpera_machine_desktop_picture_check",
			"qorpera_folder_test_machine_inherit_reads",
		]);
		// SQL's boot is not the one this process settled: the placement's boundary is asked all the same.
		expect(await f.host.screen(run(id(7)), f.signal)).toEqual({ header: header(picture), png: picture });
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
	});
});

describe("a member's look at a desktop (20260930712000)", () => {
	/** A PNG's signature and IHDR (13 bytes and its check), then `rest` bytes: what the host reads of a screenshot. */
	const png = (width = 1600, height = 1000, rest = 64) => {
		const ihdr = Buffer.alloc(25);
		ihdr.writeUInt32BE(13, 0);
		ihdr.write("IHDR", 4, "latin1");
		ihdr.writeUInt32BE(width, 8);
		ihdr.writeUInt32BE(height, 12);
		ihdr.set([8, 6, 0, 0, 0], 16);
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			ihdr,
			Buffer.alloc(rest, 7),
		]);
	};
	const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const look = (bootId = id(7), keepDesktop = false) => ({
		placementId: id(6),
		bootId,
		userId: id(21),
		keepDesktop,
		desktopGeneration: 4,
	});
	type Answer = { exitCode: number; stdout: Buffer } | "hang";
	async function piped(answer: Answer, options: Parameters<typeof fixture>[0] = {}) {
		const f = await fixture(options);
		const calls: { request: LxdExecPipeRequest; signal: AbortSignal }[] = [];
		const pipe = vi.fn(async (_project: string, _name: string, given: LxdExecPipeRequest, signal: AbortSignal) => {
			calls.push({ request: given, signal });
			f.order.push("exec:look");
			if (answer === "hang")
				return new Promise<never>((_resolve, reject) => {
					if (signal.aborted) reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			return { exitCode: answer.exitCode, stdout: answer.stdout, stderrTail: Buffer.alloc(0) };
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		return { f, pipe, calls };
	}

	it("runs the fixed script as root on SQL's boot, keep or look as its word, and answers the PNG and its sha-256", async () => {
		const picture = png();
		const { f, pipe } = await piped({ exitCode: 0, stdout: picture });
		expect(await f.host.memberLook(look(), f.signal)).toEqual({ png: picture, etag: sha(picture) });
		const [project, name, given] = pipe.mock.calls[0]!;
		expect(project).toBe("machines");
		expect(name).toBe(lxdCompanyMachineName(id(6)));
		expect(given.command).toEqual(["/bin/sh", "-c", COMPANY_MACHINE_MEMBER_LOOK, id(7), "look"]);
		// Nothing on stdin, no environment, the picture's own bound, no stderr kept.
		expect(given.stdin).toBeUndefined();
		expect(given).toMatchObject({ environment: {}, cwd: "/", maxStdoutBytes: 8 * 1024 * 1024, stderrTailBytes: 0 });
		// Without the folder service there is nothing to release; the fence after the capture is asked, for this member.
		expect(f.methods()).toEqual(["qorpera_machine_desktop_picture_check"]);
		expect(f.calls[0]?.args).toEqual({ p_placement_id: id(6), p_generation: 4, p_user_id: id(21) });
		// The member's word within 30 minutes: the desktop's idle stop is put off.
		await f.host.memberLook(look(id(7), true), f.signal);
		expect(pipe.mock.calls[1]![2].command.at(-1)).toBe("keep");
		// On SQL's boot only; scrot there; the desktop's unit active and its display answering; only `keep` touches the
		// desktop's note, and never makes one; the pointer drawn; no helper of the image, nothing started.
		for (const part of [
			'[ "$boot" = "$0" ]; } || exit 97',
			"command -v scrot >/dev/null 2>&1 || exit 98",
			"systemctl is-active --quiet qorpera-machine-desktop.service && DISPLAY=:1 xdpyinfo",
			"|| exit 95",
			'if [ "$1" = keep ]; then touch -c /run/qorpera-desktop/last-use; fi',
			'scrot --pointer --overwrite --silent "$f"',
		])
			expect(COMPANY_MACHINE_MEMBER_LOOK).toContain(part);
		expect(COMPANY_MACHINE_MEMBER_LOOK).not.toMatch(/desktop start|systemctl start|cloud-machine-screen|\/opt\//);
	});

	it("answers the screen off, another boot and an image without scrot by code, and fails on anything else", async () => {
		for (const [exitCode, refused] of [
			[95, "DESKTOP_NOT_RUNNING"],
			[97, "MACHINE_BOOT_CHANGED"],
			[98, "MACHINE_IMAGE_WITHOUT_SCREEN"],
		] as const) {
			const { f } = await piped({ exitCode, stdout: Buffer.alloc(0) }, { folder: true });
			expect(await f.host.memberLook(look(), f.signal)).toEqual({ refused });
			// Nothing was shown, so nothing is released.
			expect(f.methods()).not.toContain("qorpera_folder_member_machine_reads");
		}
		const failed = await piped({ exitCode: 1, stdout: png() });
		await expect(failed.f.host.memberLook(look(), failed.f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_LOOK_FAILED",
		);
		// A picture larger than a screen's is not streamed: the script says so, and removed it (review r1 F1).
		const large = await piped({ exitCode: 94, stdout: Buffer.alloc(0) });
		await expect(large.f.host.memberLook(look(), large.f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_LOOK_TOO_LARGE",
		);
		for (const [stdout, what] of [
			[Buffer.alloc(0), "nothing"],
			[Buffer.from("not a png"), "not a PNG"],
			[png(3841, 1000), "wider than a screen"],
			[png(1600, 2161), "taller than a screen"],
			[png(0, 1000), "no width"],
			[Buffer.concat([Buffer.alloc(8), png().subarray(8)]), "no signature"],
		] as const) {
			const { f } = await piped({ exitCode: 0, stdout });
			await expect(f.host.memberLook(look(), f.signal), what).rejects.toThrow("COMPANY_MACHINE_MEMBER_LOOK_INVALID");
		}
		const { f, pipe } = await piped({ exitCode: 0, stdout: png() });
		for (const wrong of [
			{ bootId: "boot" },
			{ userId: "member" },
			{ placementId: "placement" },
			{ keepDesktop: "yes" },
		])
			await expect(
				f.host.memberLook({ ...look(), ...wrong } as unknown as ReturnType<typeof look>, f.signal),
				JSON.stringify(wrong),
			).rejects.toThrow("COMPANY_MACHINE_MEMBER_LOOK_INVALID");
		expect(pipe).not.toHaveBeenCalled();
		const bare = await fixture();
		await expect(bare.host.memberLook(look(), bare.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_LOOK_UNAVAILABLE",
		);
	});

	it("ends the look at its own deadline, and with the request", async () => {
		const { f, calls } = await piped("hang", { memberLookTimeoutMs: 50 });
		await expect(f.host.memberLook(look(), f.signal)).rejects.toThrow();
		expect(calls[0]!.signal.aborted).toBe(true);
		const cancelled = await piped("hang");
		const controller = new AbortController();
		const looking = cancelled.f.host.memberLook(look(), controller.signal);
		await vi.waitFor(() => expect(cancelled.calls).toHaveLength(1));
		controller.abort(new Error("the member's request ended"));
		await expect(looking).rejects.toThrow("the member's request ended");
	});

	/** A machine with /company, its boot's folder settled and running, and the script answering a picture. */
	async function mounted() {
		const picture = png();
		const piping = await piped({ exitCode: 0, stdout: picture }, { folder: true });
		const { f } = piping;
		await f.host.pass(f.signal);
		f.running();
		await f.host.pass(f.signal);
		f.order.length = 0;
		f.service.requests.length = 0;
		f.calls.length = 0;
		return { ...piping, picture };
	}

	it("lets the picture of a machine with /company leave only after a boundary and the member's own read check", async () => {
		const { f, picture } = await mounted();
		expect(await f.host.memberLook(look(f.boot), f.signal)).toEqual({ png: picture, etag: sha(picture) });
		expect(f.service.requests).toEqual([{ op: "boundary", machine: id(6), final: [] }]);
		expect(f.calls.find((call) => call.method === "qorpera_folder_member_machine_reads")?.args).toEqual({
			p_placement_id: id(6),
			p_boot_id: f.boot,
			p_user_id: id(21),
		});
		// The look, then the boundary, then the member's check: never a run's take-in.
		expect(f.order).toEqual([
			"exec:look",
			"sql:qorpera_machine_desktop_picture_check",
			"folder:boundary",
			"sql:qorpera_folder_member_machine_reads",
		]);
		expect(f.methods()).not.toContain("qorpera_folder_test_machine_inherit_reads");
	});

	it("holds the picture while the folder does not release it, and hides it from a member who may not read what the machine read, marking nothing", async () => {
		for (const reads of ["unanswered", "unproven", "unreadable", "stopped"] as const) {
			const { f } = await mounted();
			f.service.reads = reads;
			expect(await f.host.memberLook(look(f.boot), f.signal), reads).toEqual({ held: "pending" });
			expect(f.methods()).not.toContain("qorpera_folder_member_machine_reads");
		}
		const down = await mounted();
		down.f.service.down = true;
		expect(await down.f.host.memberLook(look(down.f.boot), down.f.signal)).toEqual({ held: "pending" });
		// The member may not read a file the machine read: hidden, with no picture, size or etag.
		const { f, picture } = await mounted();
		f.memberReads.push(new CodingControlRefused("qorpera.test-machine/member-unreadable"));
		const hidden = await f.host.memberLook(look(f.boot), f.signal);
		expect(hidden).toEqual({ held: "hidden" });
		expect(JSON.stringify(hidden)).not.toContain(sha(picture));
		// The refusal is that member's alone: the boot is not marked, the machine is not moved, and the next look, an
		// agent's look and another member's look go on.
		expect(await f.host.memberLook(look(f.boot), f.signal)).toEqual({ png: picture, etag: sha(picture) });
		expect(f.methods()).not.toContain("qorpera_retire_company_machine");
		await f.host.pass(f.signal);
		expect(f.methods()).not.toContain("qorpera_retire_company_machine");
		// Another refusal, a lost answer, or an answer that is not the check's: held until the member looks again.
		for (const next of [
			new CodingControlRefused(null),
			new CodingControlRefused("qorpera.test-machine/unreadable"),
			new Error("CODING_CONTROL_UNCONFIRMED"),
			{ schema: "qorpera.folder-inherit/v1" },
			null,
		]) {
			f.memberReads.push(next ?? { not: "an answer" });
			expect(await f.host.memberLook(look(f.boot), f.signal), String(next)).toEqual({ held: "pending" });
		}
		expect(f.methods()).not.toContain("qorpera_retire_company_machine");
	});

	it("serves a member's look while an agent's action runs on the desktop", async () => {
		const f = await fixture();
		const picture = png();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const header = {
			schema: "qorpera.machine-screen/v1",
			started: false,
			action: { type: "click", exitCode: 0 },
			activeWindow: null,
			windows: [],
			moreWindows: 0,
			png: picture.length,
		};
		const pipe = vi.fn(async (_project: string, _name: string, given: LxdExecPipeRequest) => {
			if (given.command[2] === COMPANY_MACHINE_MEMBER_LOOK)
				return { exitCode: 0, stdout: picture, stderrTail: Buffer.alloc(0) };
			await gate;
			return {
				exitCode: 0,
				stdout: Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), picture]),
				stderrTail: Buffer.alloc(0),
			};
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		const acting = f.host.screen(
			{
				placementId: id(6),
				bootId: id(7),
				runId: id(9),
				request: {
					schema: "qorpera.machine-screen-request/v1",
					receiptId: id(8),
					action: { type: "click", x: 1, y: 1 },
					settleMs: 0,
					look: true,
				},
				desktopGeneration: 0,
			},
			f.signal,
		);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(1));
		expect(await f.host.memberLook(look(), f.signal)).toEqual({ png: picture, etag: sha(picture) });
		release();
		expect(await acting).toMatchObject({ png: picture });
	});

	it.skipIf(process.platform !== "linux")(
		"exits as the script says in a real shell: another boot, no scrot, the screen off",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "member-look-")));
			roots.push(bin);
			const tool = async (name: string, exitCode: number) => {
				await writeFile(join(bin, name), `#!/bin/sh\nexit ${exitCode}\n`);
				await chmod(join(bin, name), 0o755);
			};
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const run = (bootId: string) =>
				spawnSync("/bin/sh", ["-c", COMPANY_MACHINE_MEMBER_LOOK, bootId, "look"], { env: { PATH: bin } }).status;
			expect(run(randomUUID())).toBe(97);
			expect(run(boot)).toBe(98);
			await tool("scrot", 0);
			await tool("systemctl", 3);
			await tool("xdpyinfo", 0);
			expect(run(boot)).toBe(95);
			await tool("systemctl", 0);
			await tool("xdpyinfo", 1);
			expect(run(boot)).toBe(95);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"clears earlier looks' leftovers and never streams a picture larger than a screen's, in a real shell (review r1 F1)",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "member-look-bin-")));
			const view = await realpath(await mkdtemp(join(tmpdir(), "member-look-view-")));
			roots.push(bin, view);
			// The pictures' folder is the script's own (root's /run/qorpera-view on a machine); here a folder of the test's.
			const script = COMPANY_MACHINE_MEMBER_LOOK.replace("d=/run/qorpera-view", `d=${view}`);
			expect(script).not.toBe(COMPANY_MACHINE_MEMBER_LOOK);
			for (const [name, text] of [
				["systemctl", "#!/bin/sh\nexit 0\n"],
				["xdpyinfo", "#!/bin/sh\nexit 0\n"],
				// scrot writes as many bytes as the test asks to its last argument, the picture's file.
				["scrot", '#!/bin/sh\nfor a; do f=$a; done\nhead -c "$SCROT_BYTES" /dev/zero > "$f"\n'],
			]) {
				await writeFile(join(bin, name), text);
				await chmod(join(bin, name), 0o755);
			}
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const run = (bytes: number) =>
				spawnSync("/bin/sh", ["-c", script, boot, "look"], {
					env: { PATH: `${bin}:/usr/bin:/bin`, SCROT_BYTES: String(bytes) },
					maxBuffer: 16 * 1024 * 1024,
				});
			// A look killed two minutes ago left its picture; another look's is on its way now; a file of another name.
			const old = Date.now() / 1000 - 120;
			await writeFile(join(view, "look-111.png"), "a look cut off");
			await utimes(join(view, "look-111.png"), old, old);
			await writeFile(join(view, "look-222.png"), "a look in flight");
			await writeFile(join(view, "other.png"), "not a look");
			await utimes(join(view, "other.png"), old, old);
			const shown = run(100);
			expect(shown.status).toBe(0);
			expect(shown.stdout).toHaveLength(100);
			// The stale leftover is gone, the fresh one and the other file stay, and the look's own picture went with it.
			expect(readdirSync(view).sort()).toEqual(["look-222.png", "other.png"]);
			// Larger than a screen's picture may be: nothing streamed, and nothing left.
			const large = run(8 * 1024 * 1024 + 1);
			expect(large.status).toBe(94);
			expect(large.stdout).toHaveLength(0);
			expect(readdirSync(view).sort()).toEqual(["look-222.png", "other.png"]);
			// Exactly the bound is streamed.
			const bound = run(8 * 1024 * 1024);
			expect(bound.status).toBe(0);
			expect(bound.stdout).toHaveLength(8 * 1024 * 1024);
			expect(readdirSync(view).sort()).toEqual(["look-222.png", "other.png"]);
		},
	);
});

describe("a member's action on a desktop (20260930713000)", () => {
	/** A PNG's signature and IHDR, then `rest` bytes: what the host reads of a screenshot. */
	const png = (width = 1600, height = 1000, rest = 64) => {
		const ihdr = Buffer.alloc(25);
		ihdr.writeUInt32BE(13, 0);
		ihdr.write("IHDR", 4, "latin1");
		ihdr.writeUInt32BE(width, 8);
		ihdr.writeUInt32BE(height, 12);
		ihdr.set([8, 6, 0, 0, 0], 16);
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			ihdr,
			Buffer.alloc(rest, 7),
		]);
	};
	/** The screen helper's answer: its header (an action of `verb` that exited `exitCode`, titles) and maybe a PNG. */
	const output = (verb: string | null, picture: Buffer | null = null, exitCode: number | null = 0) =>
		Buffer.concat([
			Buffer.from(
				`${JSON.stringify({
					schema: "qorpera.machine-screen/v1",
					started: false,
					action: verb ? { type: verb, exitCode } : null,
					activeWindow: "Sign in - Bank",
					windows: ["Sign in - Bank"],
					moreWindows: 0,
					png: picture ? picture.length : 0,
				})}\n`,
				"utf8",
			),
			picture ?? Buffer.alloc(0),
		]);
	const act = (action: Record<string, unknown>, actionId = id(31), seat = 2) => ({
		seat,
		userId: id(21),
		placementId: id(6),
		bootId: id(7),
		actionId,
		action,
	});
	const agent = (action: Record<string, unknown> | null, receipt: number | null = 8) => ({
		placementId: id(6),
		bootId: id(7),
		runId: id(9),
		desktopGeneration: 2,
		request: {
			schema: "qorpera.machine-screen-request/v1",
			receiptId: receipt === null ? null : id(receipt),
			action,
			settleMs: 500,
			look: true,
		},
	});
	const answer = (exitCode: number, stdout = Buffer.alloc(0)) => ({ exitCode, stdout, stderrTail: Buffer.alloc(0) });
	/** The pipe exec: each call recorded; `reply` answers it (or holds it until released). */
	async function piped(
		reply: (given: LxdExecPipeRequest, signal: AbortSignal) => Promise<ReturnType<typeof answer>>,
		options: Parameters<typeof fixture>[0] = {},
	) {
		const f = await fixture(options);
		const calls: LxdExecPipeRequest[] = [];
		const pipe = vi.fn(async (_project: string, _name: string, given: LxdExecPipeRequest, signal: AbortSignal) => {
			calls.push(given);
			f.order.push(
				given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER) ||
					given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR
					? "exec:clear"
					: "exec:act",
			);
			return reply(given, signal);
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		return { f, pipe, calls };
	}
	const stdinText = (given: LxdExecPipeRequest) => Buffer.from(given.stdin as Uint8Array).toString("utf8");
	const cleared = answer(0, Buffer.from(`${JSON.stringify({ schema: "qorpera.machine-coding-value-cleared/v1" })}\n`));

	it("runs a click through the screen helper as an agent's action, its id the receipt, with no settle and no look, and answers only its exit", async () => {
		const { f, calls } = await piped(async () => answer(0, output("click")));
		const outcome = await f.host.memberAct(act({ type: "click", x: 812, y: 443, button: "right" }), f.signal);
		expect(outcome).toEqual({ done: { exitCode: 0 } });
		// Nothing of the screen, no title, comes back to the member.
		expect(JSON.stringify(outcome)).not.toContain("Bank");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.command).toEqual([
			"/bin/sh",
			"-c",
			expect.stringContaining('[ -f "$2" ] || exit 98; exec "$@"'),
			id(7),
			"/usr/bin/node",
			COMPANY_MACHINE_SCREEN_HELPER,
		]);
		expect(JSON.parse(stdinText(calls[0]!))).toEqual({
			schema: "qorpera.machine-screen-request/v1",
			receiptId: id(31),
			action: { type: "click", x: 812, y: 443, button: "right" },
			settleMs: 0,
			look: false,
		});
		// An action that failed on the desktop is told by its exit; the helper's own exits and refusals by code.
		for (const [reply, outcome] of [
			[answer(0, output("click", null, 1)), { done: { exitCode: 1 } }],
			[answer(0, output("click", null, null)), { done: { exitCode: null } }],
			[answer(96), { refused: "SCREEN_ACTION_TAKEN" }],
			[answer(97), { refused: "MACHINE_BOOT_CHANGED" }],
			[answer(98), { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" }],
			[
				answer(
					0,
					Buffer.from(
						`${JSON.stringify({ schema: "qorpera.machine-screen-refusal/v1", code: "DESKTOP_NOT_RUNNING" })}\n`,
					),
				),
				{ refused: "DESKTOP_NOT_RUNNING" },
			],
		] as const) {
			const one = await piped(async () => reply);
			expect(await one.f.host.memberAct(act({ type: "click", x: 1, y: 2 }), one.f.signal)).toEqual(outcome);
		}
		const failed = await piped(async () => answer(1));
		await expect(failed.f.host.memberAct(act({ type: "key", keys: ["Return"] }), failed.f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_ACT_FAILED",
		);
		const other = await piped(async () => answer(0, output("double")));
		await expect(other.f.host.memberAct(act({ type: "click", x: 1, y: 2 }), other.f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_ACT_INVALID",
		);
	});

	it("types a text from the fixed script's stdin, never through the helper or in an argument, and clears both selections after a pasted one", async () => {
		const { f, calls } = await piped(async (given) =>
			given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER) ? cleared : answer(0),
		);
		expect(await f.host.memberAct(act({ type: "type", text: "hunter2 is my password" }), f.signal)).toEqual({
			done: { exitCode: 0 },
		});
		expect(calls).toHaveLength(1);
		// In a transient unit with a deadline systemd keeps (review r1 F3), described by a fixed text, the text on stdin.
		expect(calls[0]!.command).toEqual(companyMachineMemberTypeCommand(id(7), "type"));
		expect(calls[0]!.command.slice(0, 17)).toEqual([
			"/usr/bin/systemd-run",
			"--quiet",
			"--wait",
			"--pipe",
			"--collect",
			"--expand-environment=no",
			"--slice=qorpera-machine.slice",
			"-p",
			"RuntimeMaxSec=10",
			"-p",
			"KillMode=control-group",
			"-p",
			"KillSignal=SIGKILL",
			"--description=qorpera member text",
			"--setenv=DISPLAY=:1",
			"--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"--setenv=HOME=/root",
		]);
		expect(calls[0]!.command.slice(-6)).toEqual(["--", "/bin/sh", "-c", COMPANY_MACHINE_MEMBER_TYPE, id(7), "type"]);
		expect(stdinText(calls[0]!)).toBe("hunter2 is my password");
		expect(JSON.stringify(calls[0]!.command)).not.toContain("hunter2");
		expect(calls[0]).toMatchObject({ environment: {}, cwd: "/", stderrTailBytes: 0 });
		// Beyond plain ASCII the desktop pastes it, and then both selections are cleared, on the same boot.
		f.order.length = 0;
		expect(await f.host.memberAct(act({ type: "type", text: "Åse Ørsted" }, id(32)), f.signal)).toEqual({
			done: { exitCode: 0 },
		});
		expect(calls[1]!.command).toEqual(companyMachineMemberTypeCommand(id(7), "paste"));
		expect(stdinText(calls[1]!)).toBe("Åse Ørsted");
		expect(calls[2]!.command).toEqual([
			"/bin/sh",
			"-c",
			expect.stringContaining("exit 97"),
			id(7),
			"/usr/bin/node",
			COMPANY_MACHINE_CODING_VALUE_HELPER,
			"--clear-only",
		]);
		// The seat asked again once the desktop is held (round 23), the paste, then the clear of both selections.
		expect(f.order).toEqual(["sql:qorpera_machine_desktop_picture_check", "exec:act", "exec:clear"]);
		// A tab or a line break is pasted too, as `desktop type` does.
		await f.host.memberAct(act({ type: "type", text: "one\ttwo" }, id(33)), f.signal);
		expect(calls[3]!.command.at(-1)).toBe("paste");
		expect(calls[4]!.command.at(-1)).toBe("--clear-only");
		// The script's own exits.
		for (const [exitCode, outcome] of [
			[95, { refused: "DESKTOP_NOT_RUNNING" }],
			[97, { refused: "MACHINE_BOOT_CHANGED" }],
			[98, { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" }],
			[1, { done: { exitCode: 1 } }],
			// systemd-run itself killed in the machine: its unit runs on to its limit.
			[137, { done: { exitCode: null } }],
		] as const) {
			const one = await piped(async () => answer(exitCode));
			expect(await one.f.host.memberAct(act({ type: "type", text: "abc" }), one.f.signal)).toEqual(outcome);
		}
	});

	it("clears the selections after a pasted text that failed or was cut off too, and logs only a fixed word when the clear fails", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const controller = new AbortController();
			const { f, calls } = await piped(async (given, signal) => {
				if (given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER)) return answer(1);
				return new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});
			const typing = f.host.memberAct(act({ type: "type", text: "pässword" }), controller.signal);
			await vi.waitFor(() => expect(calls).toHaveLength(1));
			controller.abort(new Error("the member's request ended"));
			await expect(typing).rejects.toThrow("the member's request ended");
			expect(calls).toHaveLength(2);
			// The clear's own deadline, not the request's, which ended.
			expect(calls[1]!.command.at(-1)).toBe("--clear-only");
			expect(errors.mock.calls).toEqual([["COMPANY_MACHINE_MEMBER_TEXT_CLEAR_FAILED"]]);
			expect(JSON.stringify(errors.mock.calls)).not.toContain("pässword");
		} finally {
			errors.mockRestore();
		}
	});

	it("refuses an action no member may send, before anything runs", async () => {
		const { f, pipe } = await piped(async () => answer(0, output("click")));
		for (const [wrong, what] of [
			[act({ type: "open", target: "https://bank.example.test" }), "open"],
			[act({ type: "type" }), "a type without its text"],
			[act({ type: "type", text: "" }), "an empty text"],
			[act({ type: "type", text: "x".repeat(501) }), "a text past 500"],
			[act({ type: "click", x: 1, y: 2, text: "x" }), "a text on a click"],
			[act({ type: "wiggle" }), "another verb"],
			[{ ...act({ type: "click", x: 1, y: 2 }), actionId: "action" }, "an action id of another shape"],
			[{ ...act({ type: "click", x: 1, y: 2 }), bootId: "boot" }, "a boot of another shape"],
		] as const)
			await expect(f.host.memberAct(wrong, f.signal), what).rejects.toThrow("COMPANY_MACHINE_MEMBER_ACT_INVALID");
		expect(pipe).not.toHaveBeenCalled();
		const bare = await fixture();
		await expect(bare.host.memberAct(act({ type: "click", x: 1, y: 2 }), bare.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_ACT_UNAVAILABLE",
		);
	});

	it("shares the desktop with the agent's actions: one at a time, and the grace after one that did not end cleanly", async () => {
		let clock = 1_800_000_000_000;
		const picture = png();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { f, pipe } = await piped(
			async (given) => {
				if (pipe.mock.calls.length === 1) await gate;
				const request = given.stdin ? JSON.parse(stdinText(given)) : {};
				return answer(0, output(request.action?.type ?? null, request.look ? picture : null));
			},
			{ now: () => clock },
		);
		// The agent's action runs: a member's action meets it, refused before the helper.
		const agentActing = f.host.screen(agent({ type: "click", x: 1, y: 1 }), f.signal);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(1));
		expect(await f.host.memberAct(act({ type: "click", x: 5, y: 5 }), f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
		expect(await f.host.memberAct(act({ type: "type", text: "abc" }), f.signal)).toEqual({ refused: "DESKTOP_BUSY" });
		expect(pipe).toHaveBeenCalledTimes(1);
		release();
		expect(await agentActing).toMatchObject({ png: picture });
		// Then the member's runs; the agent's action meets it.
		let hold = () => {};
		const held = new Promise<void>((resolve) => {
			hold = resolve;
		});
		pipe.mockImplementationOnce(async () => {
			await held;
			return answer(0, output("drag"));
		});
		const memberActing = f.host.memberAct(act({ type: "drag", x: 1, y: 1, toX: 9, toY: 9 }), f.signal);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(2));
		expect(await f.host.screen(agent({ type: "click", x: 1, y: 1 }, 11), f.signal)).toEqual({
			refused: "DESKTOP_BUSY",
		});
		hold();
		expect(await memberActing).toEqual({ done: { exitCode: 0 } });
		// A member's text cut off inside the machine (137): xdotool may type on, so the desktop stays busy 11 s.
		pipe.mockResolvedValueOnce(answer(137));
		expect(await f.host.memberAct(act({ type: "type", text: "abc" }, id(34)), f.signal)).toEqual({
			done: { exitCode: null },
		});
		expect(await f.host.screen(agent({ type: "click", x: 1, y: 1 }, 12), f.signal)).toEqual({
			refused: "DESKTOP_BUSY",
		});
		expect(await f.host.memberAct(act({ type: "click", x: 1, y: 1 }, id(35)), f.signal)).toEqual({
			refused: "DESKTOP_BUSY",
		});
		clock += 11_001;
		expect(await f.host.memberAct(act({ type: "click", x: 1, y: 1 }, id(36)), f.signal)).toEqual({
			done: { exitCode: 0 },
		});
	});

	it("reads no clipboard a member holds or took over since SQL's read, and never beside a member's action (v233 release review r1, F29 of #1661)", async () => {
		const box = {
			schema: "qorpera.coding-value-machine-box/v1",
			ephemeralPublicKey: "ZXBo",
			iv: "aXY",
			tag: "dGFn",
			ciphertext: "Y2lwaGVy",
		};
		const boxed = answer(
			0,
			Buffer.from(`${JSON.stringify({ schema: "qorpera.machine-coding-value-box/v1", box })}\n`),
		);
		const ok = { schema: "qorpera.machine-desktop-picture/v1", state: "ok" };
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		const save = {
			placementId: id(6),
			bootId: id(7),
			receiptId: id(40),
			target: { schema: "qorpera.coding-value-machine-target/v1" },
			desktopGeneration: 2,
		};
		let gate: Promise<void> | undefined;
		let open = () => {};
		const close = () => {
			gate = new Promise<void>((resolve) => {
				open = () => {
					gate = undefined;
					resolve();
				};
			});
		};
		const { f, calls } = await piped(async (given) => {
			if (gate) await gate;
			if (given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER))
				return given.command.at(-1) === "--clear-only" ? cleared : boxed;
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		const reads = () =>
			calls.filter(
				(given) =>
					given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER) && given.command.at(-1) !== "--clear-only",
			).length;
		const fenced = () => f.calls.filter((call) => call.method === "qorpera_machine_desktop_picture_check");
		// 1. A member took the desktop over since SQL's read, before the helper: nothing is read off the clipboard.
		f.pictureChecks.push(held);
		expect(await f.host.codingValue(save, f.signal)).toEqual({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		expect(reads()).toBe(0);
		expect(fenced().map((call) => call.args)).toEqual([{ p_placement_id: id(6), p_generation: 2, p_user_id: null }]);
		// 2. ... while the helper read it: the box is dropped whole (the helper's own clear stands; nothing else runs).
		f.pictureChecks.push(ok, held);
		const dropped = await f.host.codingValue(save, f.signal);
		expect(dropped).toEqual({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		expect(JSON.stringify(dropped)).not.toContain(box.ciphertext);
		expect(reads()).toBe(1);
		expect(calls).toHaveLength(1);
		expect(fenced()).toHaveLength(3);
		// 3. A fence that does not answer after the read: nothing leaves either; the call fails.
		f.pictureChecks.push(ok, new Error("fence unavailable"));
		await expect(f.host.codingValue(save, f.signal)).rejects.toThrow();
		expect(reads()).toBe(2);
		// 4. While the helper reads, a member's action (their copy) is refused before it runs; with no take-over the box
		//    leaves.
		close();
		const reading = f.host.codingValue(save, f.signal);
		await vi.waitFor(() => expect(reads()).toBe(3));
		expect(await f.host.memberAct(act({ type: "key", keys: ["ctrl+c"] }), f.signal)).toEqual({
			refused: "DESKTOP_BUSY",
		});
		expect(calls).toHaveLength(3);
		open();
		expect(await reading).toEqual({ box });
		// 5. While a member's action runs, a read is refused at once (a member holds the desktop), and reads nothing.
		close();
		const acting = f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(41)), f.signal);
		await vi.waitFor(() => expect(calls).toHaveLength(4));
		f.pictureChecks.push(held);
		expect(await f.host.codingValue(save, f.signal)).toEqual({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		expect(reads()).toBe(3);
		open();
		expect(await acting).toEqual({ done: { exitCode: 0 } });
		// 6. While an agent's action runs (no member holds it), a read waits for it, then reads.
		close();
		const agentActing = f.host.screen(agent({ type: "click", x: 1, y: 1 }, 13), f.signal);
		await vi.waitFor(() => expect(calls).toHaveLength(5));
		const waiting = f.host.codingValue(save, f.signal);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(reads()).toBe(3);
		open();
		expect(await agentActing).toMatchObject({ header: { action: { type: "click", exitCode: 0 } } });
		expect(await waiting).toEqual({ box });
		expect(reads()).toBe(4);
	});

	it("clears a clipboard a member held before an agent may read it: under the desktop's lock, after the fence, then SQL records it (v233 release review r1, F32 of #1661)", async () => {
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		const clear = { placementId: id(6), bootId: id(7), desktopGeneration: 4 };
		let clearAnswer = answer(0);
		let gate: Promise<void> | undefined;
		let open = () => {};
		const close = () => {
			gate = new Promise<void>((resolve) => {
				open = () => {
					gate = undefined;
					resolve();
				};
			});
		};
		const { f, calls } = await piped(async (given) => {
			if (gate) await gate;
			if (given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR) return clearAnswer;
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		const clears = () => calls.filter((given) => given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR).length;
		const recorded = () => f.calls.filter((call) => call.method === "qorpera_machine_desktop_clipboard_cleared");
		// 1. The fence (that generation, no one holding), the host's own clear of both selections (F34: its own script, not
		//    the helper's --clear-only), then SQL's record of that generation: in that order, the clipboard never read.
		f.order.length = 0;
		expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: true });
		expect(f.order).toEqual([
			"sql:qorpera_machine_desktop_picture_check",
			"exec:clear",
			"sql:qorpera_machine_desktop_clipboard_cleared",
		]);
		// At save time the script's bound is the save's (round 25 P1): a fixed word, never free text.
		expect(calls[0]!.command).toEqual(["/bin/sh", "-c", COMPANY_MACHINE_CLIPBOARD_CLEAR, id(7), "save"]);
		expect(calls[0]!).toMatchObject({ environment: {}, cwd: "/", stderrTailBytes: 0 });
		expect(calls[0]!.stdin).toBeUndefined();
		expect(f.calls.find((call) => call.method === "qorpera_machine_desktop_picture_check")?.args).toEqual({
			p_placement_id: id(6),
			p_generation: 4,
			p_user_id: null,
		});
		expect(recorded().map((call) => call.args)).toEqual([{ p_placement_id: id(6), p_generation: 4 }]);
		// 2. The fence says a member holds it, or took it over since SQL's read: nothing is cleared or recorded.
		f.pictureChecks.push(held);
		expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: false });
		expect(clears()).toBe(1);
		expect(recorded()).toHaveLength(1);
		// 3. A clear that failed confirms nothing (an xsel that failed: 1; a byte left on a selection: 2); another boot and an
		//    image without xsel are the agent's codes.
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			clearAnswer = answer(1);
			expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: false });
			clearAnswer = answer(2);
			expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: false });
			clearAnswer = answer(98);
			expect(await f.host.clearClipboard(clear, f.signal)).toEqual({
				refused: "MACHINE_IMAGE_WITHOUT_CODING_VALUES",
			});
			clearAnswer = answer(97);
			expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ refused: "MACHINE_BOOT_CHANGED" });
		} finally {
			errors.mockRestore();
		}
		expect(clears()).toBe(5);
		expect(recorded()).toHaveLength(1);
		clearAnswer = answer(0);
		// 4. SQL refuses the record (a take-over between the clear and the record): not cleared.
		f.clipboardClears.push({
			schema: "qorpera.machine-desktop-clipboard/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		});
		expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: false });
		// 5. While the clear runs, a member's action (their copy) is refused before it runs.
		close();
		const clearing = f.host.clearClipboard(clear, f.signal);
		await vi.waitFor(() => expect(clears()).toBe(7));
		expect(await f.host.memberAct(act({ type: "key", keys: ["ctrl+c"] }), f.signal)).toEqual({
			refused: "DESKTOP_BUSY",
		});
		open();
		expect(await clearing).toEqual({ cleared: true });
		// 6. While a member's action runs, a clear is not made beside it: the fence says a member holds the desktop.
		close();
		const acting = f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(42)), f.signal);
		await vi.waitFor(() => expect(calls).toHaveLength(8));
		f.pictureChecks.push(held);
		expect(await f.host.clearClipboard(clear, f.signal)).toEqual({ cleared: false });
		expect(clears()).toBe(7);
		open();
		expect(await acting).toEqual({ done: { exitCode: 0 } });
		// 7. Malformed: never run.
		for (const wrong of [
			{ ...clear, bootId: "boot" },
			{ ...clear, desktopGeneration: -1 },
		])
			await expect(f.host.clearClipboard(wrong, f.signal)).rejects.toThrow("COMPANY_MACHINE_CODING_VALUE_INVALID");
	});

	it("composes the host's own clipboard clear: the boot first, no display is clear, each xsel checked, then a byte count alone (F34 of #1661)", () => {
		const lines = COMPANY_MACHINE_CLIPBOARD_CLEAR.split("\n");
		expect(lines[0]).toBe('{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97');
		// Its bound inside the machine by a fixed word (round 25 P1): the four xsels end within 4 x 0.5 = 2 s at a screen
		// call (the host cuts at 3 s, SCREEN_CLEAR_MS, with the fence and the record) and 4 x 2 = 8 s at save time (10 s,
		// CODING_VALUE_CLEAR_MS, from the script's start). Any other word fails before anything runs.
		expect(lines[1]).toBe('case "$1" in screen) bound=0.5 ;; save) bound=2 ;; *) exit 1 ;; esac');
		expect(lines[2]).toBe("[ -S /tmp/.X11-unix/X1 ] || exit 0");
		expect(lines[3]).toBe("[ -x /usr/bin/xsel ] || exit 98");
		// Every xsel that runs is killed at that bound (SIGKILL: none outlives it).
		expect(
			COMPANY_MACHINE_CLIPBOARD_CLEAR.match(/\/usr\/bin\/timeout --signal=KILL "\$bound" \/usr\/bin\/xsel /g),
		).toHaveLength(2);
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR.match(/xsel --/g)).toHaveLength(2);
		// Both clears must succeed, then both read back: a failed read counts its own word, never empty.
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR).toContain('xsel --logfile /dev/null "$selection" --clear || exit 1');
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR).toContain(
			"--output --selectionTimeout 3000 || echo failed; } | /usr/bin/wc -c)",
		);
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR).toContain('[ "$left" -eq 0 ] || exit 2');
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR.match(/for selection in --clipboard --primary; do/g)).toHaveLength(2);
		// Nothing of a selection is printed, kept in a file or put on a command line.
		expect(COMPANY_MACHINE_CLIPBOARD_CLEAR).not.toMatch(/>\s*\/(?!dev\/null)|tee|echo "\$/);
	});

	it.skipIf(process.platform !== "linux")(
		"bounds each xsel of the clear inside the machine by the word it is given, in a real shell (round 25 P1 of #1661)",
		async () => {
			const dir = await realpath(await mkdtemp(join(tmpdir(), "clipboard-clear-")));
			roots.push(dir);
			// The display's socket and xsel are the test's; timeout and wc are the machine's own (/usr/bin).
			const display = createServer();
			await new Promise<void>((resolve) => display.listen(join(dir, "X1"), resolve));
			try {
				const script = COMPANY_MACHINE_CLIPBOARD_CLEAR.replaceAll("/tmp/.X11-unix/X1", join(dir, "X1")).replaceAll(
					"/usr/bin/xsel",
					join(dir, "xsel"),
				);
				expect(script.split(join(dir, "xsel"))).toHaveLength(4);
				const pids = join(dir, "pids");
				// A stand-in xsel: `hang` matches the calls that hang (they note their pid first), all others answer at once.
				const xsel = (hang: string) =>
					writeFile(
						join(dir, "xsel"),
						`#!/bin/sh\ncase "$*" in ${hang}) echo $$ >> ${pids}; exec /usr/bin/sleep 30 ;; esac\nexit 0\n`,
						{ mode: 0o755 },
					);
				const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
				const run = (word: string, bootId = boot) => {
					const began = performance.now();
					const status = spawnSync("/bin/sh", ["-c", script, bootId, word], { env: {} }).status;
					return { status, ms: performance.now() - began };
				};
				await xsel("nothing");
				expect(run("screen", randomUUID()).status).toBe(97);
				expect(run("screen").status).toBe(0);
				expect(run("save").status).toBe(0);
				for (const word of ["", "0.5", "2", "Screen", "screen save", "save;"]) expect(run(word).status).toBe(1);
				// A clear that hangs is killed at the bound: 0.5 s at a screen call, 2 s at save time (1: failed).
				await xsel("*--clear*");
				const screen = run("screen");
				expect(screen).toMatchObject({ status: 1 });
				expect(screen.ms).toBeGreaterThanOrEqual(450);
				expect(screen.ms).toBeLessThan(1500);
				const save = run("save");
				expect(save).toMatchObject({ status: 1 });
				expect(save.ms).toBeGreaterThanOrEqual(1900);
				expect(save.ms).toBeLessThan(3500);
				// A read-back that hangs is killed at it too, and counts as a byte left (2).
				await xsel("*--output*");
				const read = run("screen");
				expect(read).toMatchObject({ status: 2 });
				expect(read.ms).toBeLessThan(1500);
				// Nothing of any of them runs on.
				const hung = readFileSync(pids, "utf8").trim().split("\n");
				expect(hung).toHaveLength(3);
				for (const pid of hung) expect(existsSync(`/proc/${pid}`)).toBe(false);
			} finally {
				display.close();
			}
		},
	);

	it("clears an owed clipboard under the screen call's hold before it looks or acts, and fails nothing when it cannot (F35 of #1661)", async () => {
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		let clearAnswer = answer(0);
		let gate: Promise<void> | undefined;
		let open = () => {};
		const close = () => {
			gate = new Promise<void>((resolve) => {
				open = () => {
					gate = undefined;
					resolve();
				};
			});
		};
		const { f, calls } = await piped(async (given) => {
			if (given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR) return clearAnswer;
			if (gate) await gate;
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		const clears = () => calls.filter((given) => given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR).length;
		const recorded = () => f.calls.filter((call) => call.method === "qorpera_machine_desktop_clipboard_cleared");
		const owed = (action: Record<string, unknown> | null, receipt: number | null = null) => ({
			...agent(action, receipt),
			desktopGeneration: 4,
			clearClipboard: true,
		});
		// 1. A look that owes the clear: the fence, the clear, the record, then the look (and its own fence after the capture).
		f.order.length = 0;
		expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
		expect(f.order).toEqual([
			"sql:qorpera_machine_desktop_picture_check",
			"exec:clear",
			"sql:qorpera_machine_desktop_clipboard_cleared",
			"exec:act",
			"sql:qorpera_machine_desktop_picture_check",
		]);
		expect(recorded().map((call) => call.args)).toEqual([{ p_placement_id: id(6), p_generation: 4 }]);
		// 2. An action that owes it: the same, under the action's own hold, before the action.
		f.order.length = 0;
		expect(await f.host.screen(owed({ type: "click", x: 1, y: 1 }, 14), f.signal)).toMatchObject({
			header: { action: { type: "click", exitCode: 0 } },
		});
		expect(f.order.slice(0, 4)).toEqual([
			"sql:qorpera_machine_desktop_picture_check",
			"exec:clear",
			"sql:qorpera_machine_desktop_clipboard_cleared",
			"exec:act",
		]);
		// At a screen call the script's bound is the screen call's (round 25 P1): a fixed word after the boot id.
		expect(
			calls
				.filter((given) => given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR)
				.map((given) => given.command.slice(4)),
		).toEqual([["screen"], ["screen"]]);
		// 3. A screen call that owes nothing clears nothing.
		f.order.length = 0;
		await f.host.screen(agent(null, null), f.signal);
		expect(f.order).toEqual(["exec:act", "sql:qorpera_machine_desktop_picture_check"]);
		expect(clears()).toBe(2);
		// 4. The clear fails, the fence says no, the record is refused or throws: the look goes on all the same, and nothing
		//    more is recorded (the clear stays owed).
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			clearAnswer = answer(1);
			expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
			clearAnswer = answer(0);
			f.pictureChecks.push(held);
			expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
			f.clipboardClears.push({
				schema: "qorpera.machine-desktop-clipboard/v1",
				state: "refused",
				reason: "DESKTOP_MEMBER_IN_CONTROL",
			});
			expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
			f.clipboardClears.push(new Error("SQL unavailable"));
			expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
		} finally {
			errors.mockRestore();
		}
		expect(clears()).toBe(5);
		expect(recorded()).toHaveLength(4);
		// 5. A look while a member's action holds the desktop: no clear beside it (it stays owed), and the look is served.
		close();
		const acting = f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(43)), f.signal);
		await vi.waitFor(() => expect(f.order).toContain("exec:act"));
		const looked = f.host.screen(owed(null), f.signal);
		open();
		expect(await looked).toMatchObject({ png: expect.any(Buffer) });
		expect(await acting).toEqual({ done: { exitCode: 0 } });
		expect(clears()).toBe(5);
	});

	it("runs no action when the owed clear learns a member holds the desktop again, and a look goes on (round 24 N1)", async () => {
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		const { f, calls } = await piped(async (given) => {
			if (given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR) return answer(0);
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		const owed = (action: Record<string, unknown> | null, receipt: number | null = null) => ({
			...agent(action, receipt),
			desktopGeneration: 4,
			clearClipboard: true,
		});
		const acts = () => calls.filter((given) => given.command.includes(COMPANY_MACHINE_SCREEN_HELPER)).length;
		// The clear's fence says a member holds it: the action never reaches the helper (no receipt marker), the desktop is
		// free at once.
		f.order.length = 0;
		f.pictureChecks.push(held);
		expect(await f.host.screen(owed({ type: "click", x: 1, y: 1 }, 16), f.signal)).toEqual({
			refused: "DESKTOP_MEMBER_IN_CONTROL",
		});
		expect(f.order).toEqual(["sql:qorpera_machine_desktop_picture_check"]);
		expect(acts()).toBe(0);
		// The record says it: cleared, but the action does not run either.
		f.order.length = 0;
		f.clipboardClears.push({
			schema: "qorpera.machine-desktop-clipboard/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		});
		expect(await f.host.screen(owed({ type: "click", x: 1, y: 1 }, 17), f.signal)).toEqual({
			refused: "DESKTOP_MEMBER_IN_CONTROL",
		});
		expect(f.order).toEqual([
			"sql:qorpera_machine_desktop_picture_check",
			"exec:clear",
			"sql:qorpera_machine_desktop_clipboard_cleared",
		]);
		expect(acts()).toBe(0);
		// The desktop was let go: the next action runs.
		expect(await f.host.screen(agent({ type: "click", x: 1, y: 1 }, 18), f.signal)).toMatchObject({
			header: { action: { type: "click", exitCode: 0 } },
		});
		// A look goes on (its own fence after the capture decides the picture).
		f.pictureChecks.push(held);
		expect(await f.host.screen(owed(null), f.signal)).toMatchObject({ png: expect.any(Buffer) });
	});

	it("gives the owed clear at a screen call its own short limit: a slow X server leaves it owed and the call goes on (round 24 N2)", async () => {
		const { f, calls } = await piped(
			async (given, signal) => {
				if (given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR)
					return new Promise<never>((_resolve, reject) => {
						if (signal.aborted) reject(signal.reason);
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				const request = given.stdin ? JSON.parse(stdinText(given)) : {};
				return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
			},
			{ screenClearTimeoutMs: 50 },
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const began = Date.now();
			expect(
				await f.host.screen(
					{ ...agent({ type: "click", x: 1, y: 1 }, 19), desktopGeneration: 4, clearClipboard: true },
					f.signal,
				),
			).toMatchObject({ header: { action: { type: "click", exitCode: 0 } } });
			// Cut off at its limit, not at the clear script's own 10 s: nothing recorded, the action ran.
			expect(Date.now() - began).toBeLessThan(2000);
			expect(f.calls.filter((call) => call.method === "qorpera_machine_desktop_clipboard_cleared")).toHaveLength(0);
			expect(calls.filter((given) => given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR)[0]).toBeDefined();
			expect(errors.mock.calls).toEqual([["COMPANY_MACHINE_CLIPBOARD_CLEAR_FAILED"]]);
		} finally {
			errors.mockRestore();
		}
	});

	it("the headline flow: a member held the desktop and handed it back; the agent's look clears and records, its copy is its own, and its save reads it at the first call (F35 of #1661)", async () => {
		const box = {
			schema: "qorpera.coding-value-machine-box/v1",
			ephemeralPublicKey: "ZXBo",
			iv: "aXY",
			tag: "dGFn",
			ciphertext: "Y2lwaGVy",
		};
		const { f } = await piped(async (given) => {
			if (given.command[2] === COMPANY_MACHINE_CLIPBOARD_CLEAR) return answer(0);
			if (given.command.includes(COMPANY_MACHINE_CODING_VALUE_HELPER))
				return answer(
					0,
					Buffer.from(`${JSON.stringify({ schema: "qorpera.machine-coding-value-box/v1", box })}\n`),
				);
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		f.order.length = 0;
		// The agent's first screen call after the hand-back is its look; SQL says the clear is owed at generation 6.
		await f.host.screen({ ...agent(null, null), desktopGeneration: 6, clearClipboard: true }, f.signal);
		// It presses the site's Copy (an action; nothing owed any more), then saves: the first call reads its own copy.
		await f.host.screen({ ...agent({ type: "click", x: 400, y: 300 }, 15), desktopGeneration: 6 }, f.signal);
		const saved = await f.host.codingValue(
			{
				placementId: id(6),
				bootId: id(7),
				receiptId: id(44),
				target: { schema: "qorpera.coding-value-machine-target/v1" },
				desktopGeneration: 6,
			},
			f.signal,
		);
		expect(saved).toEqual({ box });
		expect(f.order.filter((step) => step === "exec:clear" || step.endsWith("clipboard_cleared"))).toEqual([
			"exec:clear",
			"sql:qorpera_machine_desktop_clipboard_cleared",
			// The save's read is the helper's (counted as a clipboard exec here), after the look's clear and the copy.
			"exec:clear",
		]);
		const firstClear = f.order.indexOf("exec:clear");
		const copy = f.order.indexOf("exec:act", firstClear);
		expect(firstClear).toBeLessThan(copy);
	});

	it("asks the fence again for a member's action once it holds the desktop: a hold handed back meanwhile runs nothing (round 23 of #1661)", async () => {
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		const { f, calls } = await piped(async (given) => {
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, output(request.action?.type ?? null, request.look ? png() : null));
		});
		f.pictureChecks.push(held);
		expect(await f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(45), 7), f.signal)).toEqual({
			refused: "DESKTOP_CONTROL_ENDED",
		});
		expect(calls).toHaveLength(0);
		expect(f.calls.find((call) => call.method === "qorpera_machine_desktop_picture_check")?.args).toEqual({
			p_placement_id: id(6),
			p_generation: 7,
			p_user_id: id(21),
		});
		// The desktop is free again at once: the next action runs.
		expect(await f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(46)), f.signal)).toEqual({
			done: { exitCode: 0 },
		});
		// A fence that does not answer runs nothing either, and frees the desktop.
		f.pictureChecks.push(new Error("SQL unavailable"));
		await expect(f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(47)), f.signal)).rejects.toThrow();
		expect(calls).toHaveLength(1);
		expect(await f.host.memberAct(act({ type: "click", x: 5, y: 5 }, id(48)), f.signal)).toEqual({
			done: { exitCode: 0 },
		});
		// Malformed: never run.
		await expect(f.host.memberAct({ ...act({ type: "click", x: 5, y: 5 }), seat: 0 }, f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_ACT_INVALID",
		);
	});

	it("lets no picture of a desktop a member took over since the look's read leave, to an agent or another member (review r1 F1)", async () => {
		const picture = png();
		const { f, pipe } = await piped(async (given) => {
			const request = given.stdin ? JSON.parse(stdinText(given)) : {};
			return answer(0, request.look ? output(null, picture) : png());
		});
		// SQL's fence answers that the lease generation moved (a member took over while the capture was on its way).
		const held = {
			schema: "qorpera.machine-desktop-picture/v1",
			state: "refused",
			reason: "DESKTOP_MEMBER_IN_CONTROL",
		};
		f.pictureChecks.push(held);
		const refused = await f.host.screen(agent(null, null), f.signal);
		expect(refused).toEqual({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		expect(JSON.stringify(refused)).not.toContain("Bank");
		expect(f.calls.at(-1)).toMatchObject({
			method: "qorpera_machine_desktop_picture_check",
			args: { p_placement_id: id(6), p_generation: 2, p_user_id: null },
		});
		// The same for an action's picture: the action ran (it was let in before the take-over), its picture stays.
		f.pictureChecks.push(held);
		expect(await f.host.screen(agent({ type: "click", x: 1, y: 1 }, 11), f.signal)).toEqual({
			refused: "DESKTOP_MEMBER_IN_CONTROL",
		});
		// The fence lets it through: the picture and the titles leave.
		expect(await f.host.screen(agent(null, null), f.signal)).toMatchObject({ png: picture });
		// Another member's look: none, and nothing of it; the fence names this member, who may see only a hold of their own.
		f.pictureChecks.push(held);
		const member = { placementId: id(6), bootId: id(7), userId: id(21), keepDesktop: false, desktopGeneration: 5 };
		expect(await f.host.memberLook(member, f.signal)).toEqual({ refused: "DESKTOP_MEMBER_IN_CONTROL" });
		expect(f.calls.at(-1)).toMatchObject({
			method: "qorpera_machine_desktop_picture_check",
			args: { p_placement_id: id(6), p_generation: 5, p_user_id: id(21) },
		});
		// A fence that does not answer lets nothing out either: the look fails, and is asked again.
		f.pictureChecks.push(new Error("CODING_CONTROL_UNCONFIRMED"));
		await expect(f.host.screen(agent(null, null), f.signal)).rejects.toThrow();
		f.pictureChecks.push(new Error("CODING_CONTROL_UNCONFIRMED"));
		await expect(f.host.memberLook(member, f.signal)).rejects.toThrow();
		f.pictureChecks.push({ schema: "qorpera.machine-desktop-picture/v1", state: "maybe" });
		await expect(f.host.screen(agent(null, null), f.signal)).rejects.toThrow("COMPANY_MACHINE_PICTURE_CHECK_INVALID");
		expect(pipe).toHaveBeenCalled();
	});

	it.skipIf(process.platform !== "linux")(
		"types from its stdin in a real shell, pastes beyond ASCII on both selections, and keeps the text out of every argument and file",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "member-type-bin-")));
			const log = join(await realpath(await mkdtemp(join(tmpdir(), "member-type-log-"))), "log");
			roots.push(bin, dirname(log));
			// Each tool records its argv; xdotool type and xsel record their stdin too, an x after it (so its last line breaks show).
			for (const [name, text] of [
				["systemctl", "#!/bin/sh\nexit 0\n"],
				["xdpyinfo", "#!/bin/sh\nexit 0\n"],
				[
					"xdotool",
					`#!/bin/sh\necho "xdotool $* DISPLAY=$DISPLAY" >> ${log}\nif [ "$1" = type ]; then echo "stdin: [$(cat; printf x)]" >> ${log}; fi\n`,
				],
				["xsel", `#!/bin/sh\necho "xsel $* stdin: [$(cat; printf x)]" >> ${log}\n`],
			]) {
				await writeFile(join(bin, name), text);
				await chmod(join(bin, name), 0o755);
			}
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const run = (text: string, mode: string, PATH = `${bin}:/usr/bin:/bin`, bootId = boot) =>
				spawnSync("/bin/sh", ["-c", COMPANY_MACHINE_MEMBER_TYPE, bootId, mode], { env: { PATH }, input: text });
			expect(run("hunter2 $HOME `id`", "type").status).toBe(0);
			expect(readFileSync(log, "utf8").split("\n")).toEqual([
				"xdotool type --delay 12 --file - DISPLAY=:1",
				"stdin: [hunter2 $HOME `id`x]",
				"",
			]);
			await writeFile(log, "");
			expect(run("Åse\n\n", "paste").status).toBe(0);
			expect(readFileSync(log, "utf8")).toBe(
				[
					"xsel --logfile /dev/null --clipboard --input stdin: [Åse\n\nx]",
					"xsel --logfile /dev/null --primary --input stdin: [Åse\n\nx]",
					"xdotool key --clearmodifiers shift+Insert DISPLAY=:1",
					"",
				].join("\n"),
			);
			// The text is no program's argument: only dash's own printf (no process of its own) and the shell take it.
			for (const line of COMPANY_MACHINE_MEMBER_TYPE.split("\n").filter((entry) => entry.includes("$text")))
				expect(line.trim(), line).toMatch(/^(text=\$\{text%x\}|printf %s "\$text" \| )/);
			// Another boot, no xdotool or xsel, the screen off (with the test's tools alone: these checks come first).
			expect(run("x", "type", bin, randomUUID()).status).toBe(97);
			await rm(join(bin, "xsel"));
			expect(run("x", "type", bin).status).toBe(98);
			await writeFile(join(bin, "xsel"), "#!/bin/sh\nexit 0\n");
			await chmod(join(bin, "xsel"), 0o755);
			await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 3\n");
			expect(run("x", "type", bin).status).toBe(95);
		},
	);

	it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0 || !existsSync("/usr/bin/systemd-run"))(
		"ends a stalled typing with its unit at the unit's limit, also once its client was cut off (review r1 F3; as root)",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "member-unit-bin-")));
			const marks = await realpath(await mkdtemp(join(tmpdir(), "member-unit-marks-")));
			roots.push(bin, marks);
			// xdotool takes the text from its stdin, stalls 3 s, then leaves a mark: what a stalled child would do on resuming.
			for (const [name, text] of [
				["systemctl", "#!/bin/sh\nexit 0\n"],
				["xdpyinfo", "#!/bin/sh\nexit 0\n"],
				["xsel", "#!/bin/sh\ncat >/dev/null\n"],
				["xdotool", `#!/bin/sh\ncat > ${marks}/stdin-$$\nsleep 3\ntouch ${marks}/acted-$$\n`],
			]) {
				await writeFile(join(bin, name), text);
				await chmod(join(bin, name), 0o755);
			}
			await chmod(bin, 0o755);
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const command = companyMachineMemberTypeCommand(boot, "type", {
				seconds: 1,
				path: `${bin}:/usr/bin:/bin`,
				slice: "qorpera-member-test.slice",
			});
			// Its client waits: the unit's limit ends it, and systemd-run answers 1.
			const waited = spawnSync(command[0] as string, command.slice(1), { input: "secret-text-1" });
			expect(waited.status).toBe(1);
			// Its client cut off (SIGKILL, as LXD ends an exec the executor gave up on): the unit runs on to its limit, and no
			// further: the stalled child never acts.
			const client = spawn(command[0] as string, command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
			client.stdin.end("secret-text-2");
			await new Promise((resolve) => globalThis.setTimeout(resolve, 400));
			client.kill("SIGKILL");
			await new Promise((resolve) => globalThis.setTimeout(resolve, 4600));
			expect(readdirSync(marks).filter((name) => name.startsWith("acted-"))).toEqual([]);
			// The text reached the child on its stdin, and the journal names only the unit's fixed description.
			expect(
				readdirSync(marks)
					.filter((name) => name.startsWith("stdin-"))
					.map((name) => readFileSync(join(marks, name), "utf8"))
					.sort(),
			).toEqual(["secret-text-1", "secret-text-2"]);
			const journal = spawnSync("journalctl", ["-b", "--no-pager", "--since", "-2min", "-o", "cat"], {
				encoding: "utf8",
			});
			expect(journal.stdout).not.toContain("secret-text");
			expect(journal.stdout).not.toContain("command -v xdotool");
			expect(journal.stdout).toContain("qorpera member text");
		},
		20_000,
	);
});

describe("a member's start of a desktop (20260930714000)", () => {
	const answer = (exitCode: number) => ({ exitCode, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) });
	const start = (startId = id(40)) => ({ placementId: id(6), bootId: id(7), startId });
	async function piped(
		reply: (given: LxdExecPipeRequest, signal: AbortSignal) => Promise<ReturnType<typeof answer>>,
		options: Parameters<typeof fixture>[0] = {},
	) {
		const f = await fixture(options);
		const calls: LxdExecPipeRequest[] = [];
		const pipe = vi.fn(async (_project: string, _name: string, given: LxdExecPipeRequest, signal: AbortSignal) => {
			calls.push(given);
			return reply(given, signal);
		});
		Object.assign(f.client, { execInstancePipe: pipe });
		return { f, pipe, calls };
	}

	it("runs the image's own `desktop start` in a transient unit of its own, with a limit that never reaches the desktop", async () => {
		const { f, calls } = await piped(async () => answer(0));
		expect(await f.host.memberStart(start(), f.signal)).toEqual({ outcome: "started" });
		expect(calls[0]!.command).toEqual(companyMachineMemberStartCommand(id(7)));
		expect(calls[0]!.command).toEqual([
			"/usr/bin/systemd-run",
			"--quiet",
			"--wait",
			"--collect",
			"--expand-environment=no",
			"--slice=qorpera-machine.slice",
			"-p",
			"RuntimeMaxSec=20",
			"-p",
			"KillMode=control-group",
			"-p",
			"KillSignal=SIGKILL",
			"--description=qorpera member desktop start",
			"--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"--setenv=HOME=/root",
			"--setenv=LANG=C.UTF-8",
			"--setenv=USER=root",
			"--",
			"/bin/sh",
			"-c",
			COMPANY_MACHINE_MEMBER_START,
			id(7),
		]);
		expect(calls[0]).toMatchObject({ environment: {}, cwd: "/", stderrTailBytes: 0 });
		expect(calls[0]!.stdin).toBeUndefined();
		// The script: the boot first, the helper there, whether the desktop ran, then `desktop start` with no argument.
		expect(COMPANY_MACHINE_MEMBER_START.split("\n")[0]).toContain("|| exit 97");
		expect(COMPANY_MACHINE_MEMBER_START).toContain("desktop start >/dev/null 2>&1");
	});

	it("maps the script's exit to a fixed outcome, and anything else to a desktop that did not start", async () => {
		for (const [exitCode, outcome] of [
			[0, { outcome: "started" }],
			[92, { outcome: "running" }],
			[3, { refused: "DESKTOP_MACHINE_TOO_SMALL" }],
			[97, { refused: "MACHINE_BOOT_CHANGED" }],
			[98, { refused: "MACHINE_IMAGE_WITHOUT_SCREEN" }],
			[1, { refused: "DESKTOP_DID_NOT_START" }],
			[137, { refused: "DESKTOP_DID_NOT_START" }],
			[2, { refused: "DESKTOP_DID_NOT_START" }],
		] as const) {
			const { f } = await piped(async () => answer(exitCode));
			expect(await f.host.memberStart(start(), f.signal), String(exitCode)).toEqual(outcome);
		}
		// Not answered in time: the unit ends at its own limit; the start did not end with a desktop.
		const slow = await piped(async () => {
			throw new Error("LXD exec stalled");
		});
		expect(await slow.f.host.memberStart(start(), slow.f.signal)).toEqual({ refused: "DESKTOP_DID_NOT_START" });
		// Malformed ids run nothing.
		const never = await piped(async () => answer(0));
		await expect(never.f.host.memberStart({ ...start(), bootId: "boot" }, never.f.signal)).rejects.toThrow(
			"COMPANY_MACHINE_MEMBER_START_INVALID",
		);
		expect(never.pipe).not.toHaveBeenCalled();
	});

	it("is never refused because the desktop is busy: an action on its way holds nothing a start needs", async () => {
		let release = () => {};
		const held = new Promise<ReturnType<typeof answer>>((resolve) => {
			release = () => resolve(answer(0));
		});
		const { f, pipe } = await piped(async (given) =>
			given.command.includes(COMPANY_MACHINE_MEMBER_START) ? answer(0) : held,
		);
		const acting = f.host.memberAct(
			{
				placementId: id(6),
				bootId: id(7),
				actionId: id(31),
				action: { type: "key", keys: ["Return"] },
				seat: 2,
				userId: id(21),
			},
			f.signal,
		);
		await vi.waitFor(() => expect(pipe).toHaveBeenCalledTimes(1));
		expect(await f.host.memberStart(start(), f.signal)).toEqual({ outcome: "started" });
		release();
		await acting.catch(() => undefined);
	});

	it.skipIf(process.platform !== "linux")(
		"exits as the script says in a real shell: another boot, no desktop, started, running, too small, failed",
		async () => {
			const bin = await realpath(await mkdtemp(join(tmpdir(), "member-start-")));
			roots.push(bin);
			const tool = async (name: string, body: string) => {
				await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
				await chmod(join(bin, name), 0o755);
			};
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const run = (bootId = boot) =>
				spawnSync("/bin/sh", ["-c", COMPANY_MACHINE_MEMBER_START, bootId], { env: { PATH: bin } }).status;
			expect(run(randomUUID())).toBe(97);
			expect(run()).toBe(98);
			// The desktop off: `desktop start` starts it (its arguments recorded).
			await tool("systemctl", "exit 3");
			await tool("xdpyinfo", "exit 1");
			await tool("desktop", `echo "$*" > ${join(bin, "asked")}; exit 0`);
			expect(run()).toBe(0);
			expect(readFileSync(join(bin, "asked"), "utf8")).toBe("start\n");
			// Running already: still asked (it only touches its idle clock), and told apart.
			await tool("systemctl", "exit 0");
			await tool("xdpyinfo", "exit 0");
			expect(run()).toBe(92);
			// Its own refusals: too small, and a failure.
			await tool("systemctl", "exit 3");
			await tool("desktop", "echo too small >&2; exit 3");
			expect(run()).toBe(3);
			await tool("desktop", "echo journal tail >&2; exit 1");
			expect(run()).toBe(1);
		},
	);
});
