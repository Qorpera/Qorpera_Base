import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AgentPlugClaim, agentPlugCard, isAgentPlugCard } from "./agent-plug.ts";
import type { LxdCreateInstanceRequest, LxdInspectableClient, LxdInstanceRecord } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Resolved provider authority, never client/model options. NAS backing,
 * signed image provenance and cloud allocation must be verified separately. */
export interface LxdOfficeGuestBinding {
	schema: "qorpera.lxd-office-guest/v2";
	providerId: string;
	providerPolicySha256: string;
	companyId: string;
	environmentId: string;
	companyComputerId: string;
	logicalComputerId: string;
	computerGeneration: number;
	allocationId: string;
	project: string;
	imageFingerprint: string;
	bootstrapSha256: string;
	storagePool: string;
	rootDiskBytes: number;
	workbenchSource: string;
	network: string;
	cpus: number;
	memoryBytes: number;
}

export function parseLxdOfficeGuestBinding(value: unknown): Readonly<LxdOfficeGuestBinding> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !==
			[
				"schema",
				"providerId",
				"providerPolicySha256",
				"companyId",
				"environmentId",
				"companyComputerId",
				"logicalComputerId",
				"computerGeneration",
				"allocationId",
				"project",
				"imageFingerprint",
				"bootstrapSha256",
				"storagePool",
				"rootDiskBytes",
				"workbenchSource",
				"network",
				"cpus",
				"memoryBytes",
			]
				.sort()
				.join()
	)
		throw new Error("INVALID_LXD_OFFICE_BINDING");
	const input = { ...value } as LxdOfficeGuestBinding;
	if (
		input.schema !== "qorpera.lxd-office-guest/v2" ||
		![
			input.providerId,
			input.companyId,
			input.environmentId,
			input.companyComputerId,
			input.logicalComputerId,
			input.allocationId,
		].every((id) => typeof id === "string" && UUID.test(id)) ||
		![input.imageFingerprint, input.bootstrapSha256, input.providerPolicySha256].every(
			(sha) => typeof sha === "string" && SHA.test(sha),
		) ||
		![input.project, input.storagePool, input.network].every((name) => typeof name === "string" && NAME.test(name)) ||
		![input.computerGeneration, input.cpus, input.memoryBytes, input.rootDiskBytes].every(
			(number) => Number.isSafeInteger(number) && number >= 1,
		) ||
		input.cpus > 64 ||
		input.memoryBytes > 1024 ** 4 ||
		input.rootDiskBytes > 1024 ** 4 ||
		typeof input.workbenchSource !== "string" ||
		input.workbenchSource === "/" ||
		input.workbenchSource !== resolve(input.workbenchSource) ||
		input.workbenchSource.length > 4096 ||
		/[\x00-\x20\x7f\\]/.test(input.workbenchSource) ||
		/(?:^|\/)(?:live|company-live|identity|credentials|\.codex|\.claude)(?:\/|$)/.test(input.workbenchSource)
	)
		throw new Error("INVALID_LXD_OFFICE_BINDING");
	return Object.freeze(input);
}

/** The office gets one persistent workbench, an image root and two controlled
 * NICs: `network` on the office network for the computer's own services (the
 * passthrough finds it by that name), and `plug`, a port of the agents' bridge
 * that the agents' browsers and shells leave by. Its MAC comes from the plug
 * right before each create (`withAgentPlug`). LXD gives a VM's NICs their PCI
 * slots in device-name order, so `plug`, named after `network`, stays the
 * second card and `network` keeps the first card's slot (the image names the
 * plug `qagent` by its MAC). No runner bootstrap, Compute Identity disk,
 * profile or canonical mount. */
export function lxdOfficeGuestPlan(value: LxdOfficeGuestBinding): {
	binding: Readonly<LxdOfficeGuestBinding>;
	instanceSha256: string;
	request: LxdCreateInstanceRequest;
} {
	const binding = parseLxdOfficeGuestBinding(value);
	const name = `qorpera-office-${binding.allocationId.replaceAll("-", "")}`;
	const instanceSha256 = createHash("sha256")
		.update(
			JSON.stringify({
				schema: binding.schema,
				providerId: binding.providerId,
				providerPolicySha256: binding.providerPolicySha256,
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
				computerGeneration: binding.computerGeneration,
				allocationId: binding.allocationId,
				project: binding.project,
				name,
			}),
		)
		.digest("hex");
	return {
		binding,
		instanceSha256,
		request: {
			name,
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: binding.imageFingerprint },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"limits.cpu": String(binding.cpus),
				"limits.memory": String(binding.memoryBytes),
				"user.qorpera.schema": binding.schema,
				"user.qorpera.provider_id": binding.providerId,
				"user.qorpera.provider_policy_sha256": binding.providerPolicySha256,
				"user.qorpera.company_id": binding.companyId,
				"user.qorpera.environment_id": binding.environmentId,
				"user.qorpera.office_id": binding.companyComputerId,
				"user.qorpera.logical_computer_id": binding.logicalComputerId,
				"user.qorpera.computer_generation": String(binding.computerGeneration),
				"user.qorpera.allocation_id": binding.allocationId,
				"user.qorpera.instance_sha256": instanceSha256,
				"user.qorpera.bootstrap_sha256": binding.bootstrapSha256,
			},
			devices: {
				root: { type: "disk", path: "/", pool: binding.storagePool, size: String(binding.rootDiskBytes) },
				network: { type: "nic", network: binding.network, name: "eth0" },
				plug: agentPlugCard("qagent"),
				workbench: {
					type: "disk",
					source: binding.workbenchSource,
					path: "/var/lib/qorpera-office",
					required: "true",
				},
			},
		},
	};
}

/** What the plug records for this computer: the exit's reconciler checks it
 * against the instance's company_id and office_id. */
export function lxdOfficeAgentPlugClaim(value: LxdOfficeGuestBinding): AgentPlugClaim {
	const { binding, request } = lxdOfficeGuestPlan(value);
	return {
		kind: "office",
		companyId: binding.companyId,
		machineId: binding.companyComputerId,
		memberUserId: null,
		project: binding.project,
		instance: request.name,
	};
}

export function assertLxdOfficeGuestInstance(binding: LxdOfficeGuestBinding, instance: LxdInstanceRecord): void {
	const { request } = lxdOfficeGuestPlan(binding);
	const { plug: template, ...planned } = request.devices;
	// The agent card is the plan's with the MAC its plug gave (one MAC, the same in both views); every other device
	// is exactly the plan's.
	const matches = (devices: LxdInstanceRecord["devices"]): boolean => {
		const { plug, ...rest } = devices;
		return isAgentPlugCard(plug, template) && isDeepStrictEqual(rest, planned);
	};
	if (
		instance.name !== request.name ||
		instance.type !== "virtual-machine" ||
		!isDeepStrictEqual(instance.profiles, []) ||
		!matches(instance.devices) ||
		!matches(instance.expandedDevices) ||
		!isDeepStrictEqual(instance.devices.plug, instance.expandedDevices.plug)
	)
		throw new Error("LXD_OFFICE_GUEST_DRIFTED");
	for (const config of [instance.config, instance.expandedConfig]) {
		if (
			config["volatile.base_image"] !== binding.imageFingerprint ||
			Object.entries(request.config).some(([key, value]) => config[key] !== value) ||
			Object.keys(config).some(
				(key) => !Object.hasOwn(request.config, key) && !key.startsWith("image.") && !key.startsWith("volatile."),
			)
		)
			throw new Error("LXD_OFFICE_GUEST_DRIFTED");
	}
}

/** Observe the current boot twice, around exact expanded VM configuration.
 * This grants neither readiness nor activation and performs no mutations. */
export async function inspectLxdOfficeGuestBoot(
	client: Pick<LxdInspectableClient, "getInstance" | "readInstanceFile">,
	value: LxdOfficeGuestBinding,
	signal: AbortSignal,
): Promise<{ bootId: string; instanceSha256: string }> {
	const { binding, request, instanceSha256 } = lxdOfficeGuestPlan(value);
	const checked = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
	const instance = async (): Promise<void> => {
		checked.throwIfAborted();
		const current = await client.getInstance(binding.project, request.name, checked);
		if (!current || current.status !== "Running" || current.statusCode !== 103) throw new Error("guest unavailable");
		assertLxdOfficeGuestInstance(binding, current);
		checked.throwIfAborted();
	};
	const boot = async (): Promise<string> => {
		const file = await client.readInstanceFile(
			binding.project,
			request.name,
			"/proc/sys/kernel/random/boot_id",
			64,
			checked,
		);
		checked.throwIfAborted();
		const id = new TextDecoder("utf8", { fatal: true }).decode(file.content);
		if (
			file.uid !== 0 ||
			file.gid !== 0 ||
			file.mode !== 0o444 ||
			!/^[0-9a-f-]{36}\n?$/.test(id) ||
			!UUID.test(id.trim())
		)
			throw new Error("boot unavailable");
		return id.trim();
	};
	try {
		await instance();
		const bootId = await boot();
		await instance();
		if ((await boot()) !== bootId) throw new Error("rebooted");
		return { bootId, instanceSha256 };
	} catch {
		throw new Error("LXD_OFFICE_BOOT_UNCONFIRMED");
	}
}
