import { createHash } from "node:crypto";
import type { LxdCloudRunnerProviderConfig } from "./lxd-provider.ts";

/** Exact binary units used by LXD configuration. No rounding into a cheaper
 * reservation, string arithmetic or unbounded numeric conversion. */
export function lxdResourceBytes(value: string): number {
	const match = /^([1-9][0-9]*)(KiB|MiB|GiB|TiB)$/.exec(value);
	if (!match || match[1].length > 16) throw new Error("INVALID_LXD_RESOURCE_BYTES");
	const bytes = BigInt(match[1]) * 1024n ** BigInt(["KiB", "MiB", "GiB", "TiB"].indexOf(match[2]) + 1);
	if (bytes > 1125899906842624n) throw new Error("INVALID_LXD_RESOURCE_BYTES");
	return Number(bytes);
}

/** Public physical policy for explicit node enrollment. Deliberately excludes
 * endpoint credentials, identity-capsule material and bootstrap secret bytes. */
export function lxdNativeNodePolicy(config: LxdCloudRunnerProviderConfig, machineIdSha256: string) {
	if (
		!/^[0-9a-f]{64}$/.test(machineIdSha256) ||
		!Number.isSafeInteger(config.cpuLimit) ||
		config.cpuLimit < 1 ||
		config.cpuLimit > 256
	)
		throw new Error("INVALID_LXD_NODE_POLICY");
	const policy = {
		schema: "qorpera.lxd-native-node-policy/v1",
		providerId: config.adapterId,
		machineIdSha256,
		project: config.project,
		jobProfile: config.jobProfile,
		storagePool: config.storagePool,
		imageFingerprint: config.imageFingerprint,
		cpuMillis: config.cpuLimit * 1000,
		memoryBytes: lxdResourceBytes(config.memoryLimit),
		rootDiskBytes: lxdResourceBytes(config.rootDiskSize),
		identityVolumeBytes: lxdResourceBytes(config.identityVolumeSize),
		networkInterface: config.networkInterface,
		guestAssignmentSource: config.guestAssignmentSource,
		nativeExecutionGid: config.nativeExecutionGid,
		nativeCompany: config.nativeCompanyRuntime
			? {
					mode: config.nativeCompanyRuntime.mode,
					binarySha256: config.nativeCompanyRuntime.binarySha256,
					network: config.nativeCompanyRuntime.network,
					recoveryVolumeBytes: lxdResourceBytes(config.nativeCompanyRuntime.recoveryVolumeSize),
				}
			: null,
	};
	return { policy, policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
}
