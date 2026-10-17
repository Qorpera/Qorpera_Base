import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingNasPolicy,
	type CloudCodingStorageBinding,
	cloudCodingSessionLayout,
	createCloudCodingStorageBinding,
} from "@qorpera/contracts";
import {
	AGENT_BRIDGE,
	type AgentPlug,
	type AgentPlugClaim,
	agentPlugCard,
	isAgentPlugCard,
	isAgentPlugMac,
	runAgentPlug,
	withAgentPlug,
} from "./agent-plug.ts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord, LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_EVENTS = 384;
// Old journals could fill all 384 slots with a start. Keep three emergency
// slots for that exact stop; new starts reserve stop space and rotate first.
const MAX_RETAINED_EVENTS = MAX_EVENTS + 3;
// A stop or delete that failed is re-issued from the VM's own state, at most
// this many failed attempts in a row; then an operator.
const MAX_FAILED_ATTEMPTS = 3;
// A disposable VM's effect that LXD never confirmed (a crash, a restart, a
// refused submission) is settled from the VM itself once any operation it
// could have started is long over.
const DISPATCH_SETTLE_MS = 10 * 60_000;
// A member's machine that stopped by itself more than this many times within
// the window waits for an operator: a stop-start loop (a watchdog that keeps
// stopping it, a guest that keeps powering off) is never run again by itself.
const MAX_OUTSIDE_STOPS = 3;
const OUTSIDE_STOP_WINDOW_MS = 60 * 60_000;
const OUTSIDE_STOP = /^outside-stop-\d{6}-\d{6}\.json$/;

/** One member's coding machine in one company environment: the machine SQL
 * planned (qorpera_plan_coding_machine) from the environment's VM policy. It
 * carries no session: sessions attach their NAS folders while their turn runs.
 * No model login, repository credential, identity volume or inherited profile. */
export interface LxdCodingMachineBinding {
	schema: "qorpera.lxd-coding-machine/v1";
	machineId: string;
	companyId: string;
	environmentId: string;
	memberUserId: string;
	providerId: string;
	providerPolicySha256: string;
	project: string;
	imageFingerprint: string;
	bootstrapSha256: string;
	storagePool: string;
	network: string;
	cpus: number;
	memoryBytes: number;
	rootDiskBytes: number;
}
const MACHINE_KEYS = [
	"schema",
	"machineId",
	"companyId",
	"environmentId",
	"memberUserId",
	"providerId",
	"providerPolicySha256",
	"project",
	"imageFingerprint",
	"bootstrapSha256",
	"storagePool",
	"network",
	"cpus",
	"memoryBytes",
	"rootDiskBytes",
] as const;

export function lxdCodingMachineName(machineId: string): string {
	if (!UUID.test(machineId)) throw new Error("INVALID_CODING_MACHINE_BINDING");
	return `qorpera-coding-machine-${machineId.replaceAll("-", "")}`;
}

/** The binding in its one canonical key order: `text` is what SQL hashes into
 * the machine's instance digest on its first run authority, so it is the same
 * text every time. */
export function lxdCodingMachinePlan(value: LxdCodingMachineBinding): {
	binding: Readonly<LxdCodingMachineBinding>;
	text: string;
	instanceSha256: string;
	request: LxdCreateInstanceRequest;
} {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...MACHINE_KEYS].sort().join() ||
		value.schema !== "qorpera.lxd-coding-machine/v1" ||
		![value.machineId, value.companyId, value.environmentId, value.memberUserId].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		typeof value.providerId !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(value.providerId) ||
		![value.providerPolicySha256, value.imageFingerprint, value.bootstrapSha256].every(
			(sha) => typeof sha === "string" && SHA.test(sha),
		) ||
		![value.project, value.storagePool, value.network].every((name) => typeof name === "string" && NAME.test(name)) ||
		// An agent road machine: its only card is on the agents' bridge (deploy/agent-exit).
		value.network !== AGENT_BRIDGE ||
		![value.cpus, value.memoryBytes, value.rootDiskBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
		value.cpus > 64 ||
		value.memoryBytes > 1024 ** 4 ||
		value.rootDiskBytes > 1024 ** 4
	)
		throw new Error("INVALID_CODING_MACHINE_BINDING");
	const binding = Object.freeze(
		Object.fromEntries(MACHINE_KEYS.map((key) => [key, value[key]])) as unknown as LxdCodingMachineBinding,
	);
	const text = JSON.stringify(binding);
	const instanceSha256 = createHash("sha256").update(text).digest("hex");
	return {
		binding,
		text,
		instanceSha256,
		request: {
			name: lxdCodingMachineName(binding.machineId),
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: binding.imageFingerprint },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"limits.cpu": String(binding.cpus),
				"limits.memory": String(binding.memoryBytes),
				"user.qorpera.schema": binding.schema,
				"user.qorpera.machine_id": binding.machineId,
				"user.qorpera.allocation_id": binding.machineId,
				"user.qorpera.company_id": binding.companyId,
				"user.qorpera.environment_id": binding.environmentId,
				"user.qorpera.member_user_id": binding.memberUserId,
				"user.qorpera.provider_id": binding.providerId,
				"user.qorpera.instance_sha256": instanceSha256,
				"user.qorpera.provider_policy_sha256": binding.providerPolicySha256,
				"user.qorpera.bootstrap_sha256": binding.bootstrapSha256,
			},
			devices: {
				root: { type: "disk", path: "/", pool: binding.storagePool, size: String(binding.rootDiskBytes) },
				// Its MAC comes from the agent plug right before the create (withAgentPlug).
				network: agentPlugCard("eth0"),
			},
		},
	};
}

/** Where the executor's NAS placement puts every session's folders. */
export interface CodingMachineStorage {
	readonly policy: CloudCodingNasPolicy;
	readonly machineIdSha256: string;
}
/** A session's pinned NAS volume, for this machine's company and environment. */
export function lxdCodingSessionStorage(
	machine: Readonly<LxdCodingMachineBinding>,
	storage: CodingMachineStorage,
	workerId: string,
): Readonly<CloudCodingStorageBinding> {
	return createCloudCodingStorageBinding(storage.policy, {
		workerId,
		companyId: machine.companyId,
		environmentId: machine.environmentId,
		machineIdSha256: storage.machineIdSha256,
		writerGeneration: 1,
	});
}
const SESSION_DEVICE = /^(data|custody)-([0-9a-f]{32})$/;
/** The two directory disks that attach one session: its NAS data volume at
 * its data root and its NAS custody volume at its custody root. */
export function lxdCodingSessionDevices(
	storage: Readonly<CloudCodingStorageBinding>,
): Record<string, Readonly<Record<string, string>>> {
	const layout = cloudCodingSessionLayout(storage.workerId),
		compact = storage.workerId.replaceAll("-", "");
	return {
		[`data-${compact}`]: { type: "disk", source: storage.dataSource, path: layout.dataRoot, required: "true" },
		[`custody-${compact}`]: {
			type: "disk",
			source: storage.custodySource,
			path: layout.custodyRoot,
			required: "true",
		},
	};
}
function workerOf(compact: string): string {
	return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** The instance is this machine: its exact name, configuration and base
 * devices, and nothing attached but complete, well-formed session folders of
 * this company and environment. Returns the sessions attached. */
export function assertLxdCodingMachineInstance(
	machine: Readonly<LxdCodingMachineBinding>,
	storage: CodingMachineStorage,
	instance: LxdInstanceRecord,
): string[] {
	const { request } = lxdCodingMachinePlan(machine);
	if (
		instance.name !== request.name ||
		instance.type !== "virtual-machine" ||
		!isDeepStrictEqual(instance.profiles, []) ||
		!isDeepStrictEqual(instance.devices, instance.expandedDevices)
	)
		throw new Error("CODING_MACHINE_DRIFTED");
	for (const config of [instance.config, instance.expandedConfig]) {
		if (
			config["volatile.base_image"] !== machine.imageFingerprint ||
			Object.entries(request.config).some(([key, value]) => config[key] !== value) ||
			Object.keys(config).some(
				(key) => !Object.hasOwn(request.config, key) && !key.startsWith("image.") && !key.startsWith("volatile."),
			)
		)
			throw new Error("CODING_MACHINE_DRIFTED");
	}
	const sessions = new Set<string>();
	for (const [name, device] of Object.entries(instance.devices)) {
		if (name === "network") {
			if (!isAgentPlugCard(device, request.devices.network)) throw new Error("CODING_MACHINE_DRIFTED");
			continue;
		}
		if (Object.hasOwn(request.devices, name)) {
			if (!isDeepStrictEqual(device, request.devices[name])) throw new Error("CODING_MACHINE_DRIFTED");
			continue;
		}
		const match = SESSION_DEVICE.exec(name);
		const workerId = match ? workerOf(match[2]) : "";
		if (!UUID.test(workerId)) throw new Error("CODING_MACHINE_DRIFTED");
		sessions.add(workerId);
	}
	for (const name of Object.keys(request.devices))
		if (!Object.hasOwn(instance.devices, name)) throw new Error("CODING_MACHINE_DRIFTED");
	for (const workerId of sessions) {
		const expected = lxdCodingSessionDevices(lxdCodingSessionStorage(machine, storage, workerId));
		for (const [name, device] of Object.entries(expected))
			if (!isDeepStrictEqual(instance.devices[name], device)) throw new Error("CODING_MACHINE_DRIFTED");
	}
	return [...sessions].sort();
}

export type CodingMachineIntent = "run" | "stop" | "detach" | "delete";
/** A few seconds of SQL authority for one machine effect
 * (qorpera_authorize_coding_machine_run / _custody). */
export interface CodingMachineAdmissionReceipt {
	schema: "qorpera.coding-machine-admission/v1";
	machineId: string;
	workerId: string | null;
	instanceSha256: string;
	intent: CodingMachineIntent;
	guestUid: number | null;
	validForMs: number;
	nodeId: string;
	nodeVersion: number;
}
/** Checks a receipt against the effect it must cover and the time spent
 * getting it; returns the milliseconds of authority left. */
export function checkCodingMachineReceipt(
	value: unknown,
	expected: { machineId: string; instanceSha256: string; intent: CodingMachineIntent; workerId?: string | null },
	elapsedMs: number,
): number {
	const receipt = value as Record<string, unknown>;
	if (
		!receipt ||
		typeof receipt !== "object" ||
		Array.isArray(receipt) ||
		Object.keys(receipt).sort().join() !==
			"guestUid,instanceSha256,intent,machineId,nodeId,nodeVersion,schema,validForMs,workerId" ||
		receipt.schema !== "qorpera.coding-machine-admission/v1" ||
		receipt.machineId !== expected.machineId ||
		receipt.instanceSha256 !== expected.instanceSha256 ||
		receipt.intent !== expected.intent ||
		(expected.workerId !== undefined && receipt.workerId !== expected.workerId) ||
		(receipt.workerId !== null && (typeof receipt.workerId !== "string" || !UUID.test(receipt.workerId))) ||
		(receipt.guestUid !== null &&
			(!Number.isSafeInteger(receipt.guestUid) ||
				Number(receipt.guestUid) < 1000 ||
				Number(receipt.guestUid) > 4294967294)) ||
		!Number.isSafeInteger(receipt.validForMs) ||
		Number(receipt.validForMs) < 1 ||
		Number(receipt.validForMs) > 5000 ||
		typeof receipt.nodeId !== "string" ||
		!UUID.test(receipt.nodeId) ||
		!Number.isSafeInteger(receipt.nodeVersion) ||
		Number(receipt.nodeVersion) < 1
	)
		throw new Error("CODING_MACHINE_ADMISSION_UNCONFIRMED");
	const remaining = Math.floor(Number(receipt.validForMs) - elapsedMs);
	if (remaining < 1) throw new Error("CODING_MACHINE_ADMISSION_EXPIRED");
	return remaining;
}

/** What the journal needs of a machine: a member's machine, or a kept
 * per-session VM from before (coding-vm.ts) that is only ever retired. */
export interface CodingMachineJournalPlan {
	readonly machineId: string;
	readonly instanceSha256: string;
	readonly project: string;
	readonly name: string;
	/** The journal folder under the machines root. */
	readonly journalName: string;
	/** Pinned as binding.json: the journal's authority. */
	readonly binding: Readonly<object>;
	/** How to create it; none for a machine that is only retired. */
	readonly request: LxdCreateInstanceRequest | null;
	/** An agent road machine: its request's `device` is the agent card, whose MAC the plug gives right before each
	 * create. */
	readonly agentPlug?: { readonly claim: AgentPlugClaim; readonly device: string };
	/** A VM that keeps nothing of its own (a company machine): where the
	 * journal cannot tell, LXD's view settles it. A VM that stopped by itself
	 * (a poweroff inside, a node reboot) is stopped; a failed create or start
	 * is tried again a bounded number of times; a VM that is gone needs no
	 * delete. Coding machines never set it. */
	readonly disposable?: true;
	/** A member's machine: a VM that LXD shows stopped after its settled start
	 * (the host watchdog's forced stop, a poweroff inside, a node reboot) is
	 * stopped, so a run starts it again and a delete deletes it. Each such stop
	 * is written down next to the journal, and a machine that stops by itself
	 * too often waits for an operator, as does everything else the journal
	 * cannot tell. */
	readonly selfStops?: true;
	assertInstance(instance: LxdInstanceRecord): void;
}
export function lxdCodingMachineJournalPlan(
	value: LxdCodingMachineBinding,
	storage: CodingMachineStorage,
): CodingMachineJournalPlan {
	const plan = lxdCodingMachinePlan(value);
	return Object.freeze({
		machineId: plan.binding.machineId,
		instanceSha256: plan.instanceSha256,
		project: plan.binding.project,
		name: plan.request.name,
		journalName: plan.binding.machineId,
		binding: plan.binding,
		request: plan.request,
		agentPlug: {
			claim: {
				kind: "coding" as const,
				companyId: plan.binding.companyId,
				machineId: plan.binding.machineId,
				memberUserId: plan.binding.memberUserId,
				project: plan.binding.project,
				instance: plan.request.name,
			},
			device: "network",
		},
		selfStops: true,
		assertInstance: (instance: LxdInstanceRecord) => {
			assertLxdCodingMachineInstance(plan.binding, storage, instance);
		},
	});
}

type Action = "create" | "start" | "stop" | "delete";
interface Event {
	sequence: number;
	previousSha256: string;
	action: Action;
	kind: "dispatch" | "accepted" | "settled";
	operationId: string | null;
	state: "succeeded" | "failed" | null;
}
type Client = Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation">;
export type CodingMachineDesiredState = "running" | "stopped" | "deleted";
export interface CodingMachineReconcileOptions {
	plan: CodingMachineJournalPlan;
	/** Existing persistent service-owned physical 0700 root, outside the VM. */
	journalRoot: string;
	desiredState: CodingMachineDesiredState;
	client: Client;
	/** Fresh SQL authority for this effect's intent (run, stop or delete). */
	authorize(intent: CodingMachineIntent, signal: AbortSignal): Promise<unknown>;
	signal: AbortSignal;
	/** The node's agent plug (default: its plug tool), for a plan with an agent card. */
	plug?: AgentPlug;
	/** A member's machine that LXD shows stopped after its settled start: called
	 * once that stop is written down and before anything else is done to the
	 * machine (a start, a delete, or waiting for an operator), each time it is
	 * seen so. The executor ends the machine's attachments here. A failure
	 * fails the reconcile. `startOperationId` names the stop: the LXD operation
	 * of the start it ended, the same each time that stop is seen and no other
	 * stop's, since the next start comes only after this call succeeds. */
	stoppedFromOutside?: (startOperationId: string, signal: AbortSignal) => Promise<void>;
	/** A machine LXD shows stopped, about to be started (the first start after its create too): called each time,
	 * before the start's fresh authority, so its time costs none of it. The executor says here that the machine
	 * restarted (the folder service's `restarted`) and records the restart. `afterOperationId` names the start: the
	 * LXD operation of the settled effect it follows (the create, the stop, or the start the machine stopped after),
	 * the same each time this start is about to go out and no other start's, since that effect stays the journal's
	 * last until the start is dispatched. A failure fails the reconcile, and nothing is dispatched. */
	starting?: (afterOperationId: string, signal: AbortSignal) => Promise<void>;
}
export interface CodingMachineReconcileResult {
	/** absent: never created; deleted: our journaled delete and no instance. */
	state: "running" | "stopped" | "absent" | "deleted" | "pending" | "recovery-required";
	machineId: string;
	instanceName: string;
	instanceSha256: string;
}

/** Which triplet may follow a settled one: create first; then start and stop
 * in turn (or start again, or delete, after the start of a VM that may stop by
 * itself); delete only from a stopped machine and never followed by anything.
 * A failed stop leaves the VM's state to physical observation (a re-issued
 * stop while it still runs, else start or delete); a failed delete may only
 * be re-issued. A failed create or start is followed by nothing: an operator
 * settles it. */
function nextActions(
	settled: Event | undefined,
	segment: number,
	disposable: boolean,
	selfStops: boolean,
): readonly Action[] {
	if (!settled) return segment === 0 ? ["create"] : [];
	if (settled.state === "succeeded") {
		if (settled.action === "start")
			// A disposable VM, or a member's machine, may stop by itself after its start: it is started again or deleted.
			return disposable || selfStops ? ["stop", "start", "delete"] : ["stop"];
		return settled.action === "delete" ? [] : ["start", "delete"];
	}
	if (settled.action === "stop") return ["stop", "start", "delete"];
	if (settled.action === "delete") return ["delete"];
	// A disposable VM's failed create or start is tried again (or the VM is given up).
	if (!disposable) return [];
	return settled.action === "create" ? ["create", "start", "stop", "delete"] : ["start", "stop", "delete"];
}
function trailingFailed(events: readonly Event[], action: Action): number {
	let count = 0;
	for (let index = events.length - 1; index >= 2; index -= 3) {
		const event = events[index];
		if (event.kind !== "settled" || event.action !== action || event.state !== "failed") break;
		count++;
	}
	return count;
}
function physical(instance: LxdInstanceRecord): "running" | "stopped" | "other" {
	if (instance.status === "Running" && instance.statusCode === 103) return "running";
	if (instance.status === "Stopped" && instance.statusCode === 102) return "stopped";
	return "other";
}
/** What the VM shows of an effect whose outcome LXD no longer knows: gone is a
 * delete done (and a create not done), stopped is a stop done (and a start not
 * done), running the opposite. null: the VM cannot tell. */
function effectFromView(
	action: Action,
	plan: CodingMachineJournalPlan,
	observed: LxdInstanceRecord | undefined,
): "succeeded" | "failed" | null {
	if (action === "delete") return observed ? "failed" : "succeeded";
	if (!observed) return action === "create" ? "failed" : null;
	plan.assertInstance(observed);
	if (action === "create") return "succeeded";
	const seen = physical(observed);
	if (seen === "other") return null;
	return seen === (action === "stop" ? "stopped" : "running") ? "succeeded" : "failed";
}
function encode(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}
function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
/** Writes down, once per start, that a member's machine stopped by itself
 * after that settled start (segment and sequence name it), numbered among all
 * its outside stops. True when it has now stopped by itself more than
 * MAX_OUTSIDE_STOPS times within OUTSIDE_STOP_WINDOW_MS: the stop that crosses
 * it stays the newest, so the machine keeps waiting for an operator. */
async function recordOutsideStop(root: string, segment: number, start: Event): Promise<boolean> {
	const recorded = async () => (await readdir(root)).filter((name) => OUTSIDE_STOP.test(name)).sort();
	const name = `outside-stop-${String(segment).padStart(6, "0")}-${String(start.sequence).padStart(6, "0")}.json`;
	const before = await recorded();
	if (!before.includes(name))
		await publish(
			root,
			name,
			encode({
				schema: "qorpera.coding-machine-outside-stop/v1",
				segment,
				sequence: start.sequence,
				operationId: start.operationId,
				count: before.length + 1,
				observedAt: new Date().toISOString(),
			}),
		);
	const recent = (await recorded()).slice(-(MAX_OUTSIDE_STOPS + 1));
	if (recent.at(-1) !== name) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
	if (recent.length <= MAX_OUTSIDE_STOPS) return false;
	const [first, last] = await Promise.all(
		[recent[0], name].map(async (entry) => {
			const value = (await readRecord(join(root, entry))).value as Record<string, unknown>;
			const observed = Date.parse(String(value?.observedAt));
			if (
				Object.keys(value ?? {})
					.sort()
					.join() !== "count,observedAt,operationId,schema,segment,sequence" ||
				value.schema !== "qorpera.coding-machine-outside-stop/v1" ||
				!Number.isFinite(observed)
			)
				throw new Error("CODING_MACHINE_JOURNAL_INVALID");
			return observed;
		}),
	);
	return last - first < OUTSIDE_STOP_WINDOW_MS;
}

async function readEvents(
	root: string,
	binding: Readonly<object>,
	disposable = false,
	selfStops = false,
): Promise<{ events: Event[]; previousSha256: string; root: string; segment: number; prior?: Event }> {
	await checkDirectory(root);
	const authority = await readRecord(join(root, "binding.json"));
	if (!isDeepStrictEqual(authority.value, binding)) throw new Error("CODING_MACHINE_BINDING_CONFLICT");
	let previousSha256 = sha(authority.bytes);
	const segments = (await readdir(root)).filter((name) => /^segment-\d{6}$/.test(name)).sort();
	let activeRoot = root;
	let prior: Event | undefined;
	for (const [index, name] of segments.entries()) {
		if (name !== `segment-${String(index + 1).padStart(6, "0")}`) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
		const nextRoot = join(root, name);
		await checkDirectory(nextRoot);
		let checkpoint: Awaited<ReturnType<typeof readRecord>>;
		try {
			checkpoint = await readRecord(join(nextRoot, "checkpoint.json"));
		} catch (error) {
			// mkdir may precede checkpoint publication. Nothing in an incomplete
			// final segment is executable, and a later reconciler can finish it.
			if (code(error, "ENOENT") && index === segments.length - 1 && !(await readdir(nextRoot)).length) break;
			throw error;
		}
		const value = checkpoint.value as Record<string, unknown>;
		if (
			!value ||
			Object.keys(value).sort().join() !==
				"bindingSha256,previousEventCount,previousSegment,previousTailSha256,schema,segment" ||
			value.schema !== "qorpera.coding-vm-checkpoint/v1" ||
			value.segment !== index + 1 ||
			value.previousSegment !== index ||
			value.bindingSha256 !== sha(authority.bytes) ||
			!Number.isSafeInteger(value.previousEventCount) ||
			Number(value.previousEventCount) < MAX_EVENTS - 3 ||
			Number(value.previousEventCount) > MAX_RETAINED_EVENTS
		)
			throw new Error("CODING_MACHINE_CHECKPOINT_INVALID");
		const tail = await readRecord(
			join(activeRoot, `${String(Number(value.previousEventCount) - 1).padStart(6, "0")}.json`),
		);
		prior = tail.value as Event;
		if (
			sha(tail.bytes) !== value.previousTailSha256 ||
			prior.sequence !== Number(value.previousEventCount) - 1 ||
			(prior.action !== "stop" &&
				!(disposable && (prior.action === "start" || prior.action === "create")) &&
				!(selfStops && prior.action === "start" && prior.state === "succeeded")) ||
			prior.kind !== "settled" ||
			(prior.state !== "succeeded" && prior.state !== "failed") ||
			!UUID.test(prior.operationId ?? "")
		)
			throw new Error("CODING_MACHINE_CHECKPOINT_INVALID");
		activeRoot = nextRoot;
		previousSha256 = sha(checkpoint.bytes);
	}
	const segment = activeRoot === root ? 0 : Number(activeRoot.slice(-6));
	const names = (await readdir(activeRoot)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
	if (names.length > MAX_RETAINED_EVENTS) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
	const events: Event[] = [];
	const carried = prior;
	for (const [sequence, name] of names.entries()) {
		if (name !== `${String(sequence).padStart(6, "0")}.json`) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
		const record = await readRecord(join(activeRoot, name));
		const event = record.value as Event;
		const previous = events.at(-1);
		const phase = sequence % 3;
		const expectedActions =
			phase === 0
				? nextActions(previous ?? carried, segment, disposable, selfStops)
				: [events[sequence - phase].action];
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			Object.keys(event).sort().join() !==
				["sequence", "previousSha256", "action", "kind", "operationId", "state"].sort().join() ||
			event.sequence !== sequence ||
			event.previousSha256 !== previousSha256 ||
			!expectedActions.includes(event.action) ||
			event.kind !== ["dispatch", "accepted", "settled"][phase] ||
			(phase === 0
				? event.operationId !== null
				: typeof event.operationId !== "string" || !UUID.test(event.operationId)) ||
			(phase !== 2 ? event.state !== null : !["succeeded", "failed"].includes(event.state as string)) ||
			(phase === 2 && event.operationId !== previous?.operationId)
		)
			throw new Error("CODING_MACHINE_JOURNAL_INVALID");
		events.push(event);
		previousSha256 = sha(record.bytes);
	}
	return { events, previousSha256, root: activeRoot, segment, prior };
}

/** The LXD operation that started the machine as it runs now, from its journal under `journalRoot`: the last effect
 * that succeeded there, which must be a start (a stop that failed since leaves it running). The folder model's
 * commands are kept under it (coding-folder-command-transport.ts), so a command the guest lost is judged against the
 * start it ran under. CODING_MACHINE_START_UNCONFIRMED when the journal does not show one. A member's machine started
 * again after it stopped by itself has two starts in a row, read as its reconcile reads them. */
export async function codingMachineStartOperation(
	journalRoot: string,
	plan: CodingMachineJournalPlan,
): Promise<string> {
	const current = await readEvents(
		join(journalRoot, plan.journalName),
		plan.binding,
		plan.disposable === true,
		plan.selfStops === true,
	);
	const last = [...(current.prior ? [current.prior] : []), ...current.events]
		.reverse()
		.find((event) => event.kind === "settled" && event.state === "succeeded");
	// readEvents checked each settled event's operation id.
	if (last?.action !== "start" || last.operationId === null) throw new Error("CODING_MACHINE_START_UNCONFIRMED");
	return last.operationId;
}

/** The start the machine last ran under, from its journal under `journalRoot`, read while it is stopped and before it
 * starts again: the last start that succeeded there, or null when it never started. A segment opens after the stop
 * that closed the one before it, so the start that stop ended may be the old segment's: it is read back there, each
 * record checked against the one after it. */
export async function codingMachineLastStart(
	journalRoot: string,
	plan: CodingMachineJournalPlan,
): Promise<string | null> {
	const base = join(journalRoot, plan.journalName);
	const current = await readEvents(base, plan.binding, plan.disposable === true, plan.selfStops === true);
	const started = (event: Event) =>
		event.kind === "settled" && event.state === "succeeded" && event.action === "start";
	// readEvents checked each settled event's operation id.
	const found = [...(current.prior ? [current.prior] : []), ...current.events].reverse().find(started);
	if (found) return found.operationId as string;
	if (!current.prior) return null;
	const root = current.segment === 1 ? base : join(base, `segment-${String(current.segment - 1).padStart(6, "0")}`);
	for (let after = current.prior; after.sequence > 0; ) {
		const record = await readRecord(join(root, `${String(after.sequence - 1).padStart(6, "0")}.json`));
		const event = record.value as Event | null;
		if (!event || sha(record.bytes) !== after.previousSha256 || event.sequence !== after.sequence - 1)
			throw new Error("CODING_MACHINE_JOURNAL_INVALID");
		if (started(event)) {
			if (!UUID.test(event.operationId ?? "")) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
			return event.operationId as string;
		}
		after = event;
	}
	// A full segment always holds a start that succeeded.
	throw new Error("CODING_MACHINE_START_UNCONFIRMED");
}

const DROPPED_START_SCHEMA = "qorpera.coding-machine-dropped-start/v1";
const droppedStart = (startOperationId: string) => {
	if (!UUID.test(startOperationId)) throw new Error("CODING_MACHINE_JOURNAL_INVALID");
	return `dropped-start-${startOperationId}.json`;
};

/** Writes down next to the machine's journal that what the machine left on its disk on the boot `startOperationId`
 * started is not to be kept (F3 5g-5): the folder service could not say that every read the machine was served
 * before it restarted was released. True when this call wrote it, false when it was written already. */
export async function dropCodingMachineStart(
	journalRoot: string,
	plan: CodingMachineJournalPlan,
	startOperationId: string,
): Promise<boolean> {
	return publish(
		join(journalRoot, plan.journalName),
		droppedStart(startOperationId),
		encode({ schema: DROPPED_START_SCHEMA, operationId: startOperationId }),
	);
}

/** Takes back the mark dropCodingMachineStart wrote, once the folder service answered that nothing was dropped. */
export async function undropCodingMachineStart(
	journalRoot: string,
	plan: CodingMachineJournalPlan,
	startOperationId: string,
): Promise<void> {
	const root = join(journalRoot, plan.journalName);
	await checkDirectory(root);
	await unlink(join(root, droppedStart(startOperationId))).catch((error: unknown) => {
		if (!code(error, "ENOENT")) throw error;
	});
	await syncDirectory(root);
}

/** Whether the boot `startOperationId` started is marked dropped (dropCodingMachineStart). */
export async function codingMachineStartDropped(
	journalRoot: string,
	plan: CodingMachineJournalPlan,
	startOperationId: string,
): Promise<boolean> {
	const root = join(journalRoot, plan.journalName);
	await checkDirectory(root);
	let value: unknown;
	try {
		({ value } = await readRecord(join(root, droppedStart(startOperationId))));
	} catch (error) {
		if (code(error, "ENOENT")) return false;
		throw error;
	}
	if (!isDeepStrictEqual(value, { schema: DROPPED_START_SCHEMA, operationId: startOperationId }))
		throw new Error("CODING_MACHINE_JOURNAL_INVALID");
	return true;
}

/** One bounded physical reconciliation of one machine against its journal on
 * the NAS control path. Never blindly retries an uncertain mutation: only a
 * forced stop or a delete is re-issued, and only from LXD's view of the VM
 * after a failed or forgotten one. Delete follows only a confirmed stop, and
 * "deleted" is the deletion proof: our own accepted delete in the journal and
 * no instance of that name. Running is physical state, not guest readiness. */
export async function reconcileCodingMachine(
	options: CodingMachineReconcileOptions,
): Promise<CodingMachineReconcileResult> {
	const plan = options.plan;
	const intent: CodingMachineIntent =
		options.desiredState === "running" ? "run" : options.desiredState === "stopped" ? "stop" : "delete";
	if (!["running", "stopped", "deleted"].includes(options.desiredState))
		throw new Error("INVALID_CODING_MACHINE_DESIRED_STATE");
	const result = (state: CodingMachineReconcileResult["state"]): CodingMachineReconcileResult => ({
		state,
		machineId: plan.machineId,
		instanceName: plan.name,
		instanceSha256: plan.instanceSha256,
	});
	const authorize = async (): Promise<AbortSignal> => {
		options.signal.throwIfAborted();
		const started = performance.now();
		const timeout = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
		const receipt = await options.authorize(intent, timeout);
		timeout.throwIfAborted();
		const remaining = checkCodingMachineReceipt(
			receipt,
			{ machineId: plan.machineId, instanceSha256: plan.instanceSha256, intent },
			performance.now() - started,
		);
		return AbortSignal.any([timeout, AbortSignal.timeout(remaining)]);
	};
	let signal = await authorize();
	if (resolve(options.journalRoot) !== options.journalRoot) throw new Error("CODING_MACHINE_JOURNAL_UNSAFE");
	await checkDirectory(options.journalRoot);
	const root = join(options.journalRoot, plan.journalName);
	try {
		await mkdir(root, { mode: 0o700 });
		await syncDirectory(options.journalRoot);
	} catch (error) {
		if (!code(error, "EEXIST")) throw error;
	}
	await checkDirectory(root);
	await publish(root, "binding.json", encode(plan.binding));
	let current = await readEvents(root, plan.binding, plan.disposable === true, plan.selfStops === true);
	const append = (entry: Omit<Event, "sequence" | "previousSha256">): Promise<boolean> => {
		if (current.events.length >= MAX_RETAINED_EVENTS) throw new Error("CODING_MACHINE_JOURNAL_FULL");
		return publish(
			current.root,
			`${String(current.events.length).padStart(6, "0")}.json`,
			encode({ sequence: current.events.length, previousSha256: current.previousSha256, ...entry }),
		);
	};
	let tail = current.events.at(-1) ?? current.prior;
	if (tail?.kind === "dispatch") {
		// Whether LXD took this effect is unknown. A disposable VM settles it from the VM once any
		// operation it could have started is long over; the accepted record then names an operation
		// id no LXD issued (none was ever confirmed). Anything else waits for an operator.
		if (!plan.disposable) return result("recovery-required");
		const written = await stat(join(current.root, `${String(tail.sequence).padStart(6, "0")}.json`));
		if (Date.now() - written.mtimeMs < DISPATCH_SETTLE_MS) return result("recovery-required");
		const observed = await options.client.getInstance(plan.project, plan.name, signal);
		signal.throwIfAborted();
		const state = effectFromView(tail.action, plan, observed);
		if (!state) return result("recovery-required");
		if (!(await append({ action: tail.action, kind: "accepted", operationId: randomUUID(), state: null })))
			return result("pending");
		current = await readEvents(root, plan.binding, true);
		tail = current.events.at(-1);
		if (tail?.kind !== "accepted") return result("recovery-required");
		await append({ action: tail.action, kind: "settled", operationId: tail.operationId, state });
		current = await readEvents(root, plan.binding, true);
		tail = current.events.at(-1);
		if (tail?.kind !== "settled" || tail.state !== state) return result("recovery-required");
	}
	if (tail?.kind === "accepted") {
		signal.throwIfAborted();
		let state: "pending" | "succeeded" | "failed";
		try {
			state = await options.client.inspectInstanceOperation(
				{ project: plan.project, instanceName: plan.name, operationId: tail.operationId as string },
				signal,
			);
		} catch (error) {
			// LXD keeps a finished operation only briefly. A stop or delete it no
			// longer knows is settled from the VM itself: stopped (or gone) is the
			// effect, still running (or still there) is its absence. A disposable
			// VM's create or start is settled the same way. Anything else stays unknown.
			if (
				(tail.action !== "stop" && tail.action !== "delete" && !plan.disposable) ||
				!(error instanceof Error) ||
				error.message !== "LXD_OPERATION_UNKNOWN"
			)
				return result("recovery-required");
			const observed = await options.client.getInstance(plan.project, plan.name, signal);
			signal.throwIfAborted();
			const seen = effectFromView(tail.action, plan, observed);
			if (!seen) return result("recovery-required");
			state = seen;
		}
		signal.throwIfAborted();
		if (state === "pending") return result("pending");
		if (state !== "succeeded" && state !== "failed") return result("recovery-required");
		await append({ action: tail.action, kind: "settled", operationId: tail.operationId, state });
		current = await readEvents(root, plan.binding, plan.disposable === true, plan.selfStops === true);
		tail = current.events.at(-1);
		if (tail?.kind !== "settled" || tail.state !== state) return result("recovery-required");
	}
	if (tail?.state === "failed" && tail.action !== "stop" && tail.action !== "delete" && !plan.disposable)
		return result("recovery-required");
	signal.throwIfAborted();
	const instance = await options.client.getInstance(plan.project, plan.name, signal);
	signal.throwIfAborted();
	let action: Action;
	if (!tail) {
		// An existing name, even with identical labels, is not proof of our create.
		if (instance) return result("recovery-required");
		if (intent !== "run") return result("absent");
		if (!plan.request) return result("recovery-required");
		action = "create";
	} else if (tail.action === "delete") {
		// A deleted machine never returns; a failed delete is only re-issued.
		if (!instance) return intent === "run" ? result("recovery-required") : result("deleted");
		plan.assertInstance(instance);
		if (
			tail.state !== "failed" ||
			intent !== "delete" ||
			physical(instance) !== "stopped" ||
			trailingFailed(current.events, "delete") >= MAX_FAILED_ATTEMPTS
		)
			return result("recovery-required");
		action = "delete";
	} else {
		if (!instance) {
			if (!plan.disposable) return result("recovery-required");
			// A disposable VM that is not there: nothing to stop or delete. Only a
			// create that failed (and left nothing) is made again, a bounded number of times.
			if (intent !== "run") return result("absent");
			if (
				tail.action !== "create" ||
				tail.state !== "failed" ||
				!plan.request ||
				trailingFailed(current.events, "create") >= MAX_FAILED_ATTEMPTS
			)
				return result("recovery-required");
			action = "create";
		} else {
			plan.assertInstance(instance);
			const seen = physical(instance);
			if (tail.state === "failed") {
				// A failed stop: the VM is whatever LXD shows. Stopped is stopped (a
				// run then starts it, a delete deletes it); still running gets a fresh
				// forced stop, which is safe to repeat because the VM keeps no state of
				// its own. A run never reuses a VM whose stop failed without stopping it
				// first. A disposable VM's failed create or start is settled the same
				// way, and a run tries the start again a bounded number of times.
				if (seen === "stopped") {
					if (intent === "stop") return result("stopped");
					if (intent === "delete") action = "delete";
					else if (
						tail.action === "stop" ||
						trailingFailed(current.events, tail.action as Action) < MAX_FAILED_ATTEMPTS
					)
						action = "start";
					else return result("recovery-required");
				} else if (
					seen === "running" &&
					intent === "stop" &&
					trailingFailed(current.events, "stop") < MAX_FAILED_ATTEMPTS
				)
					action = "stop";
				else if (seen === "running" && intent === "run" && plan.disposable) return result("running");
				else return result("recovery-required");
			} else {
				let expected: "running" | "stopped" = tail.action === "start" ? "running" : "stopped";
				if (expected === "running" && seen === "stopped") {
					// A disposable VM that stopped by itself after its start is stopped. So is a member's machine,
					// each time written down and its sessions told, until it stops by itself too often.
					if (plan.selfStops) {
						const tooOften = await recordOutsideStop(
							root,
							current.events.length ? current.segment : current.segment - 1,
							tail,
						);
						await options.stoppedFromOutside?.(tail.operationId as string, options.signal);
						options.signal.throwIfAborted();
						if (tooOften) return result("recovery-required");
					}
					if (plan.disposable || plan.selfStops) expected = "stopped";
				}
				if (seen !== expected) return result("recovery-required");
				if (intent === "delete") {
					// Only a confirmed stop comes before a delete.
					if (expected !== "stopped") return result("recovery-required");
					action = "delete";
				} else if ((intent === "run") === (expected === "running")) return result(expected);
				else action = intent === "run" ? "start" : "stop";
			}
		}
	}
	if (
		(action === "start" && current.events.length > MAX_EVENTS - 6) ||
		(action === "delete" && current.events.length > MAX_RETAINED_EVENTS - 3)
	) {
		// Only a physically verified, settled stop can close a segment: a stop
		// that succeeded, or a failed one whose VM was just seen stopped. No record
		// is deleted or overwritten; the checkpoint commits its exact predecessor.
		// Every contender derives the same next segment, whose first effect still
		// competes through the ordinary immutable event CAS.
		// A disposable VM, or a member's machine, that stopped by itself (its last record a start, LXD showing it
		// stopped) closes one too.
		const selfStopped =
			((plan.disposable === true && (tail?.action === "start" || tail?.action === "create")) ||
				(plan.selfStops === true && tail?.action === "start" && tail.state === "succeeded")) &&
			instance !== undefined &&
			physical(instance) === "stopped";
		if ((tail?.action !== "stop" && !selfStopped) || tail?.kind !== "settled" || current.segment >= 999999)
			throw new Error("CODING_MACHINE_JOURNAL_FULL");
		const nextRoot = join(root, `segment-${String(current.segment + 1).padStart(6, "0")}`);
		await mkdir(nextRoot, { mode: 0o700 }).catch((error) => {
			if (!code(error, "EEXIST")) throw error;
		});
		await checkDirectory(nextRoot);
		await syncDirectory(root);
		const checkpoint = {
			schema: "qorpera.coding-vm-checkpoint/v1",
			segment: current.segment + 1,
			previousSegment: current.segment,
			bindingSha256: sha((await readRecord(join(root, "binding.json"))).bytes),
			previousEventCount: current.events.length,
			previousTailSha256: current.previousSha256,
		};
		await publish(nextRoot, "checkpoint.json", encode(checkpoint));
		if (!isDeepStrictEqual((await readRecord(join(nextRoot, "checkpoint.json"))).value, checkpoint))
			throw new Error("CODING_MACHINE_CHECKPOINT_INVALID");
		return result("pending");
	}
	if (current.events.length > MAX_RETAINED_EVENTS - 3) throw new Error("CODING_MACHINE_JOURNAL_FULL");
	// An agent road machine is plugged in right before each create (the old instance, if any, is gone): the plug
	// gives the MAC its card carries. Before the fresh authority, so the plug's time costs none of it. A plug that
	// is never followed by a create (another process won the dispatch) is the same entry again for that winner.
	let request = plan.request;
	if (action === "create" && plan.agentPlug) {
		if (!request) return result("recovery-required");
		const hwaddr = await (options.plug ?? runAgentPlug)(plan.agentPlug.claim, options.signal);
		request = withAgentPlug(request, plan.agentPlug.device, hwaddr);
	}
	// No card on the agents' bridge goes out without a plug MAC: a plan that names no plug never makes one.
	if (
		action === "create" &&
		Object.values(request?.devices ?? {}).some(
			(device) => device.parent === AGENT_BRIDGE && !isAgentPlugMac(device.hwaddr),
		)
	)
		throw new Error("AGENT_PLUG_MISSING");
	// A start goes out only once the executor has said the machine restarted. Before the fresh authority too. The
	// settled effect it follows names it.
	if (action === "start" && options.starting) {
		if (tail?.kind !== "settled" || typeof tail.operationId !== "string")
			throw new Error("CODING_MACHINE_JOURNAL_INVALID");
		await options.starting(tail.operationId, options.signal);
		options.signal.throwIfAborted();
	}
	// Fresh authority immediately before irreversible dispatch; journal CAS
	// chooses one winner across processes. A crash after claiming is unknown.
	signal = await authorize();
	if (!(await append({ action, kind: "dispatch", operationId: null, state: null }))) return result("pending");
	let operationId: string;
	try {
		signal.throwIfAborted();
		const reference = await options.client.submitInstanceOperation(
			plan.project,
			// The machine holds no state of its own (every session's work is on the
			// NAS): power it off; a guest that ignores the shutdown request would
			// otherwise keep its place on the node until an operator stepped in.
			action === "create"
				? { action, request: request as LxdCreateInstanceRequest }
				: action === "stop"
					? { action, name: plan.name, force: true }
					: { action, name: plan.name },
			signal,
		);
		if (
			reference.project !== plan.project ||
			reference.instanceName !== plan.name ||
			!UUID.test(reference.operationId)
		)
			throw new Error("CODING_MACHINE_OPERATION_UNBOUND");
		operationId = reference.operationId;
	} catch {
		return result("recovery-required");
	}
	// Preserve operation custody even if authority loss follows LXD acceptance.
	current = await readEvents(root, plan.binding, plan.disposable === true, plan.selfStops === true);
	tail = current.events.at(-1);
	if (tail?.kind !== "dispatch" || tail.action !== action) throw new Error("CODING_MACHINE_JOURNAL_CONFLICT");
	await append({ action, kind: "accepted", operationId, state: null });
	options.signal.throwIfAborted();
	return result("pending");
}
