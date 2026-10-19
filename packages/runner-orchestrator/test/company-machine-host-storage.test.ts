import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdCompanyMachineBinding, lxdCompanyMachinePlan } from "../src/company-machine.ts";
import { type CompanyMachineEntry, LxdCompanyMachineHost } from "../src/company-machine-host.ts";
import type { LxdInstanceRecord, LxdTrackedInstanceAction } from "../src/lxd-client.ts";
import { testAgentPlug } from "./helpers/coding-machine.ts";

/** The NAS storage as the real one keeps it (coding-storage.ts, execute()): its pending flag is set before the first
 * await, and an operation while another runs is refused at once. */
const nas = vi.hoisted(() => ({
	controlPath: "",
	/** Operations running now, the most at once, those begun, and those refused as overlapping. */
	active: 0,
	most: 0,
	begun: 0,
	refused: 0,
	/** What the next operation waits for, whatever its signal says (hard-NFS IO answers none). */
	hang: undefined as Promise<void> | undefined,
}));
vi.mock("../src/coding-storage.ts", () => ({
	createCodingNasStorage: () => {
		let pending = false;
		const execute = async () => {
			if (pending) {
				nas.refused++;
				throw new Error("CODING_STORAGE_IO_PENDING");
			}
			pending = true;
			nas.begun++;
			nas.active++;
			nas.most = Math.max(nas.most, nas.active);
			const hang = nas.hang;
			nas.hang = undefined;
			try {
				await (hang ?? new Promise<void>((resolve) => setImmediate(resolve)));
			} finally {
				nas.active--;
				pending = false;
			}
		};
		return {
			get controlPath() {
				return nas.controlPath;
			},
			assertControl: execute,
			prepareControl: async () => {
				await execute();
				return nas.controlPath;
			},
			prepare: execute,
			assert: execute,
		};
	},
}));

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
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
/** One of the company's task machines, wanted and not made yet. */
function machine(n: number, cpus: number): CompanyMachineEntry & { schema: string } {
	const binding: LxdCompanyMachineBinding = {
		schema: "qorpera.lxd-company-machine/v2",
		machineId: id(n),
		placementId: id(n + 1),
		companyId: id(3),
		environmentId: id(4),
		...policy,
		cpus,
		memoryBytes: 8 * 1024 ** 3,
		rootDiskBytes: 40 * 1024 ** 3,
	};
	const plan = lxdCompanyMachinePlan(binding);
	return {
		schema: "qorpera.company-machine-state/v2",
		machineId: binding.machineId,
		placementId: binding.placementId,
		retired: false,
		binding,
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
}

/** One company's two task machines (4 and 2 CPUs: well inside the node's room) as SQL lists them, and LXD with their
 * VMs, whose guests' helpers answer through reply files. */
async function fixture() {
	nas.controlPath = await realpath(await mkdtemp(join(tmpdir(), "company-machine-storage-")));
	await chmod(nas.controlPath, 0o700);
	roots.push(nas.controlPath);
	Object.assign(nas, { active: 0, most: 0, begun: 0, refused: 0, hang: undefined });
	const machines = [machine(10, 4), machine(20, 2)];
	const plans = new Map(
		machines.map((m) => {
			const plan = lxdCompanyMachinePlan(m.binding);
			return [plan.request.name, { machine: m, plan }];
		}),
	);
	/** What SQL's list shows. */
	let listed: typeof machines = [];
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			calls.push({ method, args });
			if (method === "qorpera_list_executor_machines") return structuredClone(listed);
			if (method === "qorpera_authorize_executor_machine") {
				const e = machines.find((m) => m.placementId === args.p_placement_id);
				return {
					schema: "qorpera.coding-machine-admission/v1",
					machineId: e?.placementId,
					workerId: null,
					instanceSha256: e?.instanceSha256,
					intent: args.p_intent,
					guestUid: null,
					validForMs: 5000,
					nodeId: id(5),
					nodeVersion: 1,
				};
			}
			if (method === "qorpera_mark_company_machine_running") return { state: "running" };
			return null;
		}),
	};
	const instances = new Map<string, LxdInstanceRecord>();
	const operations = new Map<string, LxdTrackedInstanceAction>();
	/** Each VM's boot: a new one at each start. */
	const boots = new Map<string, string>();
	const replies = new Map<string, unknown>();
	const client = {
		getInstance: vi.fn(async (_project: string, name: string) => instances.get(name)),
		submitInstanceOperation: vi.fn(async (project: string, action: LxdTrackedInstanceAction) => {
			const operationId = randomUUID();
			operations.set(operationId, action);
			return { project, instanceName: action.action === "create" ? action.request.name : action.name, operationId };
		}),
		inspectInstanceOperation: vi.fn(
			async (reference: { instanceName: string; operationId: string }): Promise<"succeeded"> => {
				const name = reference.instanceName;
				const action = operations.get(reference.operationId);
				operations.delete(reference.operationId);
				const config = { ...plans.get(name)?.plan.request.config, "volatile.base_image": policy.imageFingerprint };
				const vm = instances.get(name);
				if (action?.action === "create")
					// LXD makes the machine from the request the agent plug completed.
					instances.set(name, {
						name,
						type: "virtual-machine",
						status: "Stopped",
						statusCode: 102,
						profiles: [],
						devices: structuredClone(action.request.devices),
						expandedDevices: structuredClone(action.request.devices),
						config,
						expandedConfig: config,
					});
				else if (action?.action === "start" && vm) {
					vm.status = "Running";
					vm.statusCode = 103;
					boots.set(name, randomUUID());
				}
				return "succeeded";
			},
		),
		execInstance: vi.fn(async (_project: string, name: string, command: readonly string[]) => {
			const [nonce, action, ...args] = command.slice(2);
			const machineId = plans.get(name)?.machine.machineId;
			const bootId = boots.get(name);
			if (action === "prepare")
				replies.set(nonce, {
					schema: "qorpera.machine-guest/v1",
					machineId: args[0],
					bootId,
					generation: Number(args[1]),
				});
			else if (action === "refresh-lease")
				replies.set(nonce, {
					schema: "qorpera.machine-guest-lease-receipt/v1",
					machineId,
					bootId,
					validForMs: Number(args[0]),
				});
			else if (action === "observe")
				replies.set(nonce, {
					schema: "qorpera.machine-observation/v2",
					machineId,
					bootId,
					at: 0,
					cpuUsec: 0,
					ioBytes: 0,
					ended: [],
				});
			else throw new Error(`unexpected helper action ${action}`);
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
		journalRoot: nas.controlPath,
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/nas",
			rootPath: "/nas/coding",
			source: "10.0.0.2:/coding",
			serverAddress: "10.0.0.2",
		},
		helperSha256,
		agentPlug: testAgentPlug,
	});
	return {
		host,
		machines,
		signal: new AbortController().signal,
		/** SQL lists these machines. */
		list: (...shown: typeof machines) => {
			listed = shown;
		},
		/** SQL knows the machine's boot runs, as after its mark. */
		running: (m: (typeof machines)[number]) => {
			Object.assign(m, {
				runningAt: new Date().toISOString(),
				bootId: boots.get(lxdCompanyMachinePlan(m.binding).request.name),
			});
		},
		instance: (m: (typeof machines)[number]) => instances.get(lxdCompanyMachinePlan(m.binding).request.name),
		/** The codes the passes recorded on the machines (null: a step done). */
		recorded: () =>
			calls.filter((call) => call.method === "qorpera_record_company_machine_error").map((call) => call.args.p_code),
	};
}

describe("company machine host: NAS storage checks", () => {
	it("starts a company's second machine in the pass that keeps its first one, one storage check at a time", async () => {
		const f = await fixture();
		const [first, second] = f.machines;
		f.list(first);
		expect(await f.host.pass(f.signal)).toEqual([{ placementId: first.placementId, step: "start", state: "done" }]);
		f.running(first);
		f.list(first, second);
		const begun = nas.begun;
		// Both placements check the NAS in the same pass: the running one for its keep, the other for its start.
		expect(await f.host.pass(f.signal)).toEqual([
			{ placementId: first.placementId, step: "commands", state: "done" },
			{ placementId: second.placementId, step: "start", state: "done" },
		]);
		expect(nas.begun - begun).toBeGreaterThanOrEqual(2);
		expect(f.instance(second)?.status).toBe("Running");
		expect(nas.refused).toBe(0);
		expect(nas.most).toBe(1);
		expect(f.recorded().every((code) => code === null)).toBe(true);
	});

	it.each(["abort", "timeout"] as const)(
		"holds the next storage check until one that outlived its caller's %s settles, then runs it",
		async (how) => {
			const f = await fixture();
			const [first] = f.machines;
			f.list(first);
			// The checks' own bounds (5 s), fired by hand; every other bound as it is.
			const timeout = AbortSignal.timeout.bind(AbortSignal);
			const bounds: AbortController[] = [];
			vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
				if (ms !== 5000) return timeout(ms);
				const bound = new AbortController();
				bounds.push(bound);
				return bound.signal;
			});
			let release = () => {};
			nas.hang = new Promise<void>((resolve) => {
				release = resolve;
			});
			const stop = new AbortController();
			const hung = f.host.pass(stop.signal);
			await vi.waitFor(() => expect(nas.active).toBe(1));
			// The hung check's own bound is the only one so far (SQL's calls have 10 s, the start 300 s).
			expect(bounds).toHaveLength(1);
			if (how === "abort") stop.abort(new Error("EXECUTOR_STOPPING"));
			else bounds[0].abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
			// Its caller leaves; the check itself still runs.
			expect(await hung).toEqual([
				{
					placementId: first.placementId,
					step: "start",
					state: "failed",
					code: how === "abort" ? "EXECUTOR_STOPPING" : "UNCLASSIFIED",
				},
			]);
			expect(nas.active).toBe(1);
			// The next pass's check waits for it, not refused, and its own bound has not begun.
			let settled = false;
			const next = f.host.pass(f.signal).finally(() => {
				settled = true;
			});
			await setTimeout(100);
			expect(settled).toBe(false);
			expect(nas.begun).toBe(1);
			expect(nas.refused).toBe(0);
			expect(bounds).toHaveLength(1);
			// Once the hung check settles, the next one runs.
			release();
			expect(await next).toEqual([{ placementId: first.placementId, step: "start", state: "done" }]);
			expect(nas.begun).toBeGreaterThan(1);
			expect(nas.refused).toBe(0);
			expect(nas.most).toBe(1);
			expect(f.instance(first)?.status).toBe("Running");
		},
	);
});
