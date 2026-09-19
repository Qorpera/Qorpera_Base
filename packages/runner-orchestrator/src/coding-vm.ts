import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CloudCodingRepository, parseCloudCodingRepository } from "@qorpera/contracts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord, LxdTrackedClient } from "./lxd-client.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_EVENTS = 384;

/** Trusted deployment policy and immutable worker authority. Image provenance,
 * node placement, network isolation and company admission are verified by the
 * admission backend. No model input, inherited LXD profile or host disk mount. */
export interface LxdCodingVmBinding {
	schema: "qorpera.lxd-coding-vm/v1";
	workerId: string;
	allocationId: string;
	companyId: string;
	environmentId: string;
	providerId: string;
	providerPolicySha256: string;
	repository: CloudCodingRepository;
	project: string;
	imageFingerprint: string;
	bootstrapSha256: string;
	storagePool: string;
	network: string;
	cpus: number;
	memoryBytes: number;
	rootDiskBytes: number;
}

export function lxdCodingVmPlan(value: LxdCodingVmBinding): {
	binding: Readonly<LxdCodingVmBinding>;
	instanceSha256: string;
	request: LxdCreateInstanceRequest;
} {
	const keys = [
		"schema",
		"workerId",
		"allocationId",
		"companyId",
		"environmentId",
		"providerId",
		"providerPolicySha256",
		"repository",
		"project",
		"imageFingerprint",
		"bootstrapSha256",
		"storagePool",
		"network",
		"cpus",
		"memoryBytes",
		"rootDiskBytes",
	];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("INVALID_CODING_VM_BINDING");
	if (
		value.schema !== "qorpera.lxd-coding-vm/v1" ||
		![value.workerId, value.allocationId, value.companyId, value.environmentId].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		typeof value.providerId !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(value.providerId) ||
		![value.providerPolicySha256, value.imageFingerprint, value.bootstrapSha256].every(
			(sha) => typeof sha === "string" && SHA.test(sha),
		) ||
		![value.project, value.storagePool, value.network].every((name) => typeof name === "string" && NAME.test(name)) ||
		![value.cpus, value.memoryBytes, value.rootDiskBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
		value.cpus > 64 ||
		value.memoryBytes > 1024 ** 4 ||
		value.rootDiskBytes > 1024 ** 4
	)
		throw new Error("INVALID_CODING_VM_BINDING");
	// Normalize property order before hashing; JSON order is not authority.
	const binding = Object.freeze(
		Object.fromEntries(
			keys.map((key) => [
				key,
				key === "repository"
					? parseCloudCodingRepository(value.repository)
					: value[key as keyof LxdCodingVmBinding],
			]),
		) as unknown as LxdCodingVmBinding,
	);
	const instanceSha256 = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
	return {
		binding,
		instanceSha256,
		request: {
			name: `qorpera-coding-${binding.workerId.replaceAll("-", "")}`,
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: binding.imageFingerprint },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"limits.cpu": String(binding.cpus),
				"limits.memory": String(binding.memoryBytes),
				"user.qorpera.schema": binding.schema,
				"user.qorpera.worker_id": binding.workerId,
				"user.qorpera.allocation_id": binding.allocationId,
				"user.qorpera.company_id": binding.companyId,
				"user.qorpera.environment_id": binding.environmentId,
				"user.qorpera.provider_id": binding.providerId,
				"user.qorpera.instance_sha256": instanceSha256,
				"user.qorpera.provider_policy_sha256": binding.providerPolicySha256,
				"user.qorpera.bootstrap_sha256": binding.bootstrapSha256,
				"user.qorpera.repository": `${binding.repository.host}/${binding.repository.owner}/${binding.repository.name}`,
				"user.qorpera.base_branch": binding.repository.baseBranch,
				"user.qorpera.branch": `qorpera/coding/${binding.workerId}`,
			},
			devices: {
				root: { type: "disk", path: "/", pool: binding.storagePool, size: String(binding.rootDiskBytes) },
				network: { type: "nic", network: binding.network, name: "eth0" },
			},
		},
	};
}

export function assertLxdCodingVmInstance(binding: LxdCodingVmBinding, instance: LxdInstanceRecord): void {
	const { request } = lxdCodingVmPlan(binding);
	if (
		instance.name !== request.name ||
		instance.type !== "virtual-machine" ||
		!isDeepStrictEqual(instance.profiles, []) ||
		!isDeepStrictEqual(instance.devices, request.devices) ||
		!isDeepStrictEqual(instance.expandedDevices, request.devices)
	)
		throw new Error("CODING_VM_DRIFTED");
	for (const config of [instance.config, instance.expandedConfig]) {
		if (
			config["volatile.base_image"] !== binding.imageFingerprint ||
			Object.entries(request.config).some(([key, value]) => config[key] !== value) ||
			Object.keys(config).some(
				(key) => !Object.hasOwn(request.config, key) && !key.startsWith("image.") && !key.startsWith("volatile."),
			)
		)
			throw new Error("CODING_VM_DRIFTED");
	}
}

export interface CodingVmAdmissionReceipt {
	schema: "qorpera.coding-vm-admission/v1";
	workerId: string;
	allocationId: string;
	instanceSha256: string;
	intent: "run" | "stop";
	validForMs: number;
	nodeId: string;
	nodeVersion: number;
}

export interface CodingVmAdmission {
	/** Must validate the live worker lease and the exact immutable binding;
	 * for run, also require signed image/bootstrap and network acceptance, a
	 * retained company reservation and fresh native node reservation. For stop,
	 * validate cleanup custody even if ordinary delegation has been revoked.
	 * No existing parent-run reservation may be relabelled as worker authority.
	 * Abort caller lifetime on lease loss; a receipt cannot renew that lease. */
	authorize(
		binding: Readonly<LxdCodingVmBinding>,
		intent: "run" | "stop",
		signal: AbortSignal,
	): Promise<CodingVmAdmissionReceipt>;
}

type Action = "create" | "start" | "stop";
interface Event {
	sequence: number;
	previousSha256: string;
	action: Action;
	kind: "dispatch" | "accepted" | "settled";
	operationId: string | null;
	state: "succeeded" | "failed" | null;
}
type Client = Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation">;
export interface CodingVmReconcileOptions {
	binding: LxdCodingVmBinding;
	/** Existing persistent service-owned physical 0700 root, outside the VM. */
	journalRoot: string;
	desiredState: "running" | "stopped";
	client: Client;
	admission: CodingVmAdmission;
	signal: AbortSignal;
}
export interface CodingVmReconcileResult {
	state: "running" | "stopped" | "absent" | "pending" | "recovery-required";
	workerId: string;
	allocationId: string;
	instanceName: string;
	instanceSha256: string;
}

function encode(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}
function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readEvents(
	root: string,
	binding: Readonly<LxdCodingVmBinding>,
): Promise<{ events: Event[]; previousSha256: string }> {
	await checkDirectory(root);
	const authority = await readRecord(join(root, "binding.json"));
	if (!isDeepStrictEqual(authority.value, binding)) throw new Error("CODING_VM_BINDING_CONFLICT");
	let previousSha256 = sha(authority.bytes);
	const names = (await readdir(root)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
	if (names.length > MAX_EVENTS) throw new Error("CODING_VM_JOURNAL_INVALID");
	const events: Event[] = [];
	for (const [sequence, name] of names.entries()) {
		if (name !== `${String(sequence).padStart(6, "0")}.json`) throw new Error("CODING_VM_JOURNAL_INVALID");
		const record = await readRecord(join(root, name));
		const event = record.value as Event;
		const prior = events.at(-1);
		const phase = sequence % 3;
		const expectedAction = sequence < 3 ? "create" : Math.floor(sequence / 3) % 2 ? "start" : "stop";
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			Object.keys(event).sort().join() !==
				["sequence", "previousSha256", "action", "kind", "operationId", "state"].sort().join() ||
			event.sequence !== sequence ||
			event.previousSha256 !== previousSha256 ||
			event.action !== expectedAction ||
			event.kind !== ["dispatch", "accepted", "settled"][phase] ||
			(phase === 0
				? event.operationId !== null
				: typeof event.operationId !== "string" || !UUID.test(event.operationId)) ||
			(phase !== 2 ? event.state !== null : !["succeeded", "failed"].includes(event.state as string)) ||
			(phase === 2 && event.operationId !== prior?.operationId) ||
			(phase === 0 && prior && prior.state !== "succeeded")
		)
			throw new Error("CODING_VM_JOURNAL_INVALID");
		events.push(event);
		previousSha256 = sha(record.bytes);
	}
	return { events, previousSha256 };
}

/** One bounded physical reconciliation. Retains the same VM and root disk
 * across coding turns. Never deletes, releases admission or blindly retries
 * an uncertain mutation. Running is physical state, not guest/tool readiness.
 * A supervision loop must keep renewing authority and use a separately
 * authorized stop after lease loss; this one-shot method is not a watchdog. */
export async function reconcileLxdCodingVm(options: CodingVmReconcileOptions): Promise<CodingVmReconcileResult> {
	const { binding, request, instanceSha256 } = lxdCodingVmPlan(options.binding);
	if (!["running", "stopped"].includes(options.desiredState)) throw new Error("INVALID_CODING_VM_DESIRED_STATE");
	const intent = options.desiredState === "running" ? "run" : "stop";
	const result = (state: CodingVmReconcileResult["state"]): CodingVmReconcileResult => ({
		state,
		workerId: binding.workerId,
		allocationId: binding.allocationId,
		instanceName: request.name,
		instanceSha256,
	});
	const authorize = async (): Promise<AbortSignal> => {
		options.signal.throwIfAborted();
		const started = performance.now();
		const timeout = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
		const receipt = await options.admission.authorize(binding, intent, timeout);
		timeout.throwIfAborted();
		if (
			!receipt ||
			!Number.isSafeInteger(receipt.validForMs) ||
			receipt.validForMs < 1 ||
			receipt.validForMs > 5000 ||
			!UUID.test(receipt.nodeId) ||
			!Number.isSafeInteger(receipt.nodeVersion) ||
			receipt.nodeVersion < 1 ||
			!isDeepStrictEqual(receipt, {
				schema: "qorpera.coding-vm-admission/v1",
				workerId: binding.workerId,
				allocationId: binding.allocationId,
				instanceSha256,
				intent,
				validForMs: receipt.validForMs,
				nodeId: receipt.nodeId,
				nodeVersion: receipt.nodeVersion,
			})
		)
			throw new Error("CODING_VM_ADMISSION_UNCONFIRMED");
		const remaining = Math.floor(receipt.validForMs - (performance.now() - started));
		if (remaining < 1) throw new Error("CODING_VM_ADMISSION_EXPIRED");
		return AbortSignal.any([timeout, AbortSignal.timeout(remaining)]);
	};
	let signal = await authorize();
	if (resolve(options.journalRoot) !== options.journalRoot) throw new Error("CODING_VM_JOURNAL_UNSAFE");
	await checkDirectory(options.journalRoot);
	const root = join(options.journalRoot, binding.workerId);
	try {
		await mkdir(root, { mode: 0o700 });
		await syncDirectory(options.journalRoot);
	} catch (error) {
		if (!code(error, "EEXIST")) throw error;
	}
	await checkDirectory(root);
	await publish(root, "binding.json", encode(binding));
	let current = await readEvents(root, binding);
	const append = (entry: Omit<Event, "sequence" | "previousSha256">): Promise<boolean> => {
		if (current.events.length >= MAX_EVENTS) throw new Error("CODING_VM_JOURNAL_FULL");
		return publish(
			root,
			`${String(current.events.length).padStart(6, "0")}.json`,
			encode({
				sequence: current.events.length,
				previousSha256: current.previousSha256,
				...entry,
			}),
		);
	};
	let tail = current.events.at(-1);
	if (tail?.kind === "dispatch") return result("recovery-required");
	if (tail?.kind === "accepted") {
		signal.throwIfAborted();
		let state: "pending" | "succeeded" | "failed";
		try {
			state = await options.client.inspectInstanceOperation(
				{ project: binding.project, instanceName: request.name, operationId: tail.operationId as string },
				signal,
			);
		} catch {
			return result("recovery-required");
		}
		signal.throwIfAborted();
		if (state === "pending") return result("pending");
		if (state !== "succeeded" && state !== "failed") return result("recovery-required");
		await append({ action: tail.action, kind: "settled", operationId: tail.operationId, state });
		current = await readEvents(root, binding);
		tail = current.events.at(-1);
		if (tail?.kind !== "settled" || tail.state !== state) return result("recovery-required");
	}
	if (tail?.state === "failed") return result("recovery-required");
	signal.throwIfAborted();
	const instance = await options.client.getInstance(binding.project, request.name, signal);
	signal.throwIfAborted();
	let action: Action;
	if (!tail) {
		// An existing name, even with identical labels, is not proof of our create.
		if (instance) return result("recovery-required");
		if (intent === "stop") return result("absent");
		action = "create";
	} else {
		if (!instance) return result("recovery-required");
		assertLxdCodingVmInstance(binding, instance);
		const expected = tail.action === "start" ? "Running" : "Stopped";
		if (instance.status !== expected || instance.statusCode !== (expected === "Running" ? 103 : 102))
			return result("recovery-required");
		if ((intent === "run") === (expected === "Running"))
			return result(expected === "Running" ? "running" : "stopped");
		action = intent === "run" ? "start" : "stop";
	}
	if (current.events.length > MAX_EVENTS - 3) throw new Error("CODING_VM_JOURNAL_FULL");
	// Fresh reservation immediately before irreversible dispatch; journal CAS
	// chooses one winner across processes. A crash after claiming is unknown.
	signal = await authorize();
	if (!(await append({ action, kind: "dispatch", operationId: null, state: null }))) return result("pending");
	let operationId: string;
	try {
		signal.throwIfAborted();
		const reference = await options.client.submitInstanceOperation(
			binding.project,
			action === "create" ? { action, request } : { action, name: request.name },
			signal,
		);
		if (
			reference.project !== binding.project ||
			reference.instanceName !== request.name ||
			!UUID.test(reference.operationId)
		)
			throw new Error("CODING_VM_OPERATION_UNBOUND");
		operationId = reference.operationId;
	} catch {
		return result("recovery-required");
	}
	// Preserve operation custody even if lease loss follows LXD acceptance.
	current = await readEvents(root, binding);
	tail = current.events.at(-1);
	if (tail?.kind !== "dispatch" || tail.action !== action) throw new Error("CODING_VM_JOURNAL_CONFLICT");
	await append({ action, kind: "accepted", operationId, state: null });
	options.signal.throwIfAborted();
	return result("pending");
}
