import { createHash } from "node:crypto";
import type { LxdCreateInstanceRequest } from "./lxd-client.ts";
import type { LxdNativeLoginGatewayConfig } from "./lxd-login-gateway.ts";
import { lxdResourceBytes } from "./lxd-native-node-policy.ts";

export const LOGIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export const loginSha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function lxdLoginNodePolicy(config: LxdNativeLoginGatewayConfig, machineIdSha256: string) {
	const policy = {
		schema: "qorpera.lxd-login-node-policy/v1" as const,
		providerId: config.adapterId,
		machineIdSha256,
		project: config.project,
		loginProfile: config.loginProfile,
		networkInterface: config.networkInterface,
		imageServer: config.imageServer,
		imageFingerprint: config.imageFingerprint,
		storagePool: config.storagePool,
		identityVolumePrefix: config.identityVolumePrefix,
		identityVolumeSize: config.identityVolumeSize,
		rootDiskSize: config.rootDiskSize,
		cpuLimit: config.cpuLimit,
		memoryLimit: config.memoryLimit,
	};
	validatePolicy(policy);
	return { policy, policySha256: loginSha256(JSON.stringify(policy)) };
}
type LoginPolicy = ReturnType<typeof lxdLoginNodePolicy>["policy"];

export interface LxdLoginBinding {
	schema: "qorpera.lxd-login-allocation/v1";
	allocationId: string;
	loginId: string;
	profileId: string;
	computeIdentityId: string;
	capabilitySha256: string;
	bootstrapSha256: string;
	policy: LoginPolicy;
}

function keys(value: object, names: string): void {
	if (Object.keys(value).sort().join() !== names.split(",").sort().join()) throw new Error("INVALID_LOGIN_BINDING");
}

function validatePolicy(policy: LoginPolicy): void {
	if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("INVALID_LOGIN_POLICY");
	keys(
		policy,
		"schema,providerId,machineIdSha256,project,loginProfile,networkInterface,imageServer,imageFingerprint,storagePool,identityVolumePrefix,identityVolumeSize,rootDiskSize,cpuLimit,memoryLimit",
	);
	if (
		policy.schema !== "qorpera.lxd-login-node-policy/v1" ||
		Object.entries(policy).some(([key, value]) => key !== "cpuLimit" && typeof value !== "string") ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(policy.providerId) ||
		!SHA.test(policy.machineIdSha256) ||
		!SHA.test(policy.imageFingerprint) ||
		[policy.project, policy.loginProfile, policy.networkInterface, policy.storagePool].some(
			(value) => typeof value !== "string" || !NAME.test(value),
		) ||
		!/^[a-z][a-z0-9-]{0,31}$/.test(policy.identityVolumePrefix) ||
		!Number.isSafeInteger(policy.cpuLimit) ||
		policy.cpuLimit < 1 ||
		policy.cpuLimit > 256
	)
		throw new Error("INVALID_LOGIN_POLICY");
	if (policy.imageServer !== "local") {
		const source = new URL(policy.imageServer);
		if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash)
			throw new Error("INVALID_LOGIN_POLICY");
	}
	for (const value of [policy.memoryLimit, policy.rootDiskSize, policy.identityVolumeSize]) lxdResourceBytes(value);
}

/** Public, immutable physical authority. No bearer, service credential or
 * account bytes enter either the LXD request or its retained identity. */
export function lxdLoginPlan(value: LxdLoginBinding) {
	const binding = structuredClone(value);
	if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("INVALID_LOGIN_BINDING");
	keys(binding, "schema,allocationId,loginId,profileId,computeIdentityId,capabilitySha256,bootstrapSha256,policy");
	if (
		binding.schema !== "qorpera.lxd-login-allocation/v1" ||
		[binding.allocationId, binding.loginId, binding.profileId, binding.computeIdentityId].some(
			(id) => typeof id !== "string" || !LOGIN_UUID.test(id),
		) ||
		[binding.capabilitySha256, binding.bootstrapSha256].some((hash) => typeof hash !== "string" || !SHA.test(hash))
	)
		throw new Error("INVALID_LOGIN_BINDING");
	validatePolicy(binding.policy);
	const p = binding.policy;
	const request: LxdCreateInstanceRequest = {
		name: `qorpera-login-${binding.allocationId.replaceAll("-", "")}`,
		type: "virtual-machine",
		profiles: [p.loginProfile],
		config: {
			"boot.mode": "uefi-secureboot",
			"limits.cpu": String(p.cpuLimit),
			"limits.memory": p.memoryLimit,
			"user.qorpera.schema": "qorpera.native-login-vm/v2",
			"user.qorpera.allocation_id": binding.allocationId,
			"user.qorpera.login_id": binding.loginId,
			"user.qorpera.profile_id": binding.profileId,
			"user.qorpera.provider_adapter": p.providerId,
			"user.qorpera.provider_policy_sha256": loginSha256(JSON.stringify(p)),
			"user.qorpera.instance_sha256": loginSha256(JSON.stringify(binding)),
			"user.qorpera.compute_identity_id": binding.computeIdentityId,
			"user.qorpera.bootstrap_sha256": binding.bootstrapSha256,
			"user.qorpera.image_fingerprint": p.imageFingerprint,
		},
		devices: {
			root: { type: "disk", path: "/", pool: p.storagePool, size: p.rootDiskSize },
			"compute-identity": {
				type: "disk",
				path: "/var/lib/qorpera/identity",
				pool: p.storagePool,
				source: `${p.identityVolumePrefix}${binding.computeIdentityId}`,
			},
		},
		source:
			p.imageServer === "local"
				? { type: "image", fingerprint: p.imageFingerprint }
				: {
						type: "image",
						mode: "pull",
						protocol: "simplestreams",
						server: p.imageServer,
						fingerprint: p.imageFingerprint,
					},
	};
	return {
		binding,
		request,
		instanceSha256: loginSha256(JSON.stringify(binding)),
		policySha256: loginSha256(JSON.stringify(p)),
		cpuMillis: p.cpuLimit * 1000,
		memoryBytes: lxdResourceBytes(p.memoryLimit),
	};
}
