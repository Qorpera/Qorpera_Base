import { type CloudCodingSessionLayout, cloudCodingSessionLayout } from "@qorpera/contracts";

export interface CodingGuestResourceProfile {
	maxTimeoutMs: number;
	memoryBytes: number;
	tasksMax: number;
	cpuQuotaPercent: number;
	maxLogBytes: number;
}
export const DEFAULT_CODING_GUEST_RESOURCES: Readonly<CodingGuestResourceProfile> = Object.freeze({
	maxTimeoutMs: 1800000,
	memoryBytes: 2147483648,
	tasksMax: 256,
	cpuQuotaPercent: 200,
	maxLogBytes: 67108864,
});
/** One session's configuration inside its member's coding machine. The vmId
 * is the machine the session is attached to for this boot; the paths are the
 * session's layout (cloudCodingSessionLayout) and nothing else. */
export interface CodingGuestConfiguration {
	schema: "qorpera.coding-command-guest/v3";
	workerId: string;
	vmId: string;
	bootId: string;
	uid: number;
	gid: number;
	workspacePath: string;
	homePath: string;
	cachePath: string;
	outputRoot: string;
	resourceProfile: CodingGuestResourceProfile;
}
/** The four folders a session's configuration names. */
export type CodingGuestFolders = Pick<
	CloudCodingSessionLayout,
	"workspacePath" | "homePath" | "cachePath" | "outputRoot"
>;
/** Closed deployment configuration. Paths are the session's fixed layout, not
 * a choice of the packet or the model; only trusted test composition passes
 * other `folders`. This parser cannot prove their NAS backing. */
export function parseCodingGuestConfiguration(value: unknown, folders?: CodingGuestFolders): CodingGuestConfiguration {
	const input = value as Record<string, unknown>;
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).sort().join() !==
			"bootId,cachePath,gid,homePath,outputRoot,resourceProfile,schema,uid,vmId,workerId,workspacePath" ||
		input.schema !== "qorpera.coding-command-guest/v3" ||
		![input.workerId, input.vmId, input.bootId].every((id) => typeof id === "string" && uuid.test(id)) ||
		![input.uid, input.gid].every((id) => Number.isSafeInteger(id) && Number(id) >= 1000 && Number(id) < 4294967295)
	)
		throw new Error("INVALID_CODING_GUEST_CONFIGURATION");
	const layout = folders ?? cloudCodingSessionLayout(input.workerId as string);
	if (
		input.workspacePath !== layout.workspacePath ||
		input.homePath !== layout.homePath ||
		input.cachePath !== layout.cachePath ||
		input.outputRoot !== layout.outputRoot
	)
		throw new Error("INVALID_CODING_GUEST_PATHS");
	const profile = input.resourceProfile as Record<string, unknown>;
	const bounds = {
		maxTimeoutMs: [1000, 1800000],
		memoryBytes: [268435456, 137438953472],
		tasksMax: [16, 4096],
		cpuQuotaPercent: [10, 6400],
		maxLogBytes: [1048576, 1073741824],
	};
	if (
		!profile ||
		typeof profile !== "object" ||
		Array.isArray(profile) ||
		Object.keys(profile).sort().join() !== Object.keys(bounds).sort().join() ||
		Object.entries(bounds).some(
			([key, [min, max]]) =>
				!Number.isSafeInteger(profile[key]) || Number(profile[key]) < min || Number(profile[key]) > max,
		)
	)
		throw new Error("INVALID_CODING_GUEST_RESOURCES");
	return Object.freeze({
		...input,
		resourceProfile: Object.freeze({ ...profile }),
	}) as unknown as CodingGuestConfiguration;
}
