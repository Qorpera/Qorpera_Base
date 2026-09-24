import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingRepository,
	type CloudCodingStorageBinding,
	parseCloudCodingRepository,
	parseCloudCodingStorageBinding,
} from "@qorpera/contracts";
import type { CodingMachineJournalPlan } from "./coding-machine.ts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** The binding of a kept per-session VM from before per-member machines
 * (before bundle v101): one VM per session, with the session's NAS mounts
 * as fixed devices. New turns never create one; the executor only retires them
 * (lxdLegacyCodingMachineJournalPlan). */
export interface LxdCodingVmBinding {
	schema: "qorpera.lxd-coding-vm/v2";
	workerId: string;
	allocationId: string;
	companyId: string;
	environmentId: string;
	providerId: string;
	providerPolicySha256: string;
	repository: CloudCodingRepository;
	storage: CloudCodingStorageBinding;
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
		"storage",
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
		value.schema !== "qorpera.lxd-coding-vm/v2" ||
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
	const storage = parseCloudCodingStorageBinding(value.storage);
	if (
		storage.workerId !== value.workerId ||
		storage.companyId !== value.companyId ||
		storage.environmentId !== value.environmentId
	)
		throw new Error("CODING_VM_STORAGE_SCOPE_CHANGED");
	// Normalize property order before hashing; JSON order is not authority.
	const binding = Object.freeze(
		Object.fromEntries(
			keys.map((key) => [
				key,
				key === "repository"
					? parseCloudCodingRepository(value.repository)
					: key === "storage"
						? storage
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
				data: {
					type: "disk",
					path: binding.storage.dataTarget,
					source: binding.storage.dataSource,
					required: "true",
				},
				custody: {
					type: "disk",
					path: binding.storage.custodyTarget,
					source: binding.storage.custodySource,
					required: "true",
				},
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

/** A kept per-session VM from before per-member machines (a machine of kind
 * 'session' in SQL): never run again, only stopped, deleted and released
 * through the shared machine journal. Its journal is the one it always had,
 * named after its worker. */
export function lxdLegacyCodingMachineJournalPlan(value: LxdCodingVmBinding): CodingMachineJournalPlan {
	const plan = lxdCodingVmPlan(value);
	return Object.freeze({
		machineId: plan.binding.allocationId,
		instanceSha256: plan.instanceSha256,
		project: plan.binding.project,
		name: plan.request.name,
		journalName: plan.binding.workerId,
		binding: plan.binding,
		request: null,
		assertInstance: (instance: LxdInstanceRecord) => assertLxdCodingVmInstance(plan.binding, instance),
	});
}
