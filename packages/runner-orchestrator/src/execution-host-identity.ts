/** Compute Identity volumes on a node's shared execution host
 * (deploy/shared-execution). The host reads each member login from a disk
 * device of exactly this shape, one per identity:
 *
 *   identity-<uuid>: { type: disk, pool: <pool>, source: <prefix><uuid>,
 *                      path: /var/lib/qorpera/identities/<uuid> }
 *
 * It is the shape operators attached by hand since the 2026-09-22 pilot and
 * the shape the node's login gateway now hot-plugs itself: the volume the
 * gateway created for that identity, read-write like its every other mount
 * (login VM, one-run guest); the execution service only reads it
 * (shared-execution-identity.ts). The node inventory observer leaves exactly
 * these devices out of the host's enrolled digest and reports them instead;
 * anything else under such a name, or with any other key, stays enrollment. */

export const EXECUTION_HOST_IDENTITY_ROOT = "/var/lib/qorpera/identities";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IDENTITY = new RegExp(`^${UUID}$`);
const DEVICE = new RegExp(`^identity-(${UUID})$`);
/** The LXD pool and volume-prefix rules of the login gateway that creates the volumes. */
const POOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
/** More identities than any node holds; bounds the inventory report. */
export const MAX_EXECUTION_HOST_IDENTITIES = 4096;

export interface ExecutionHostIdentityVolumes {
	/** The login gateway's QORPERA_LXD_STORAGE_POOL. */
	pool: string;
	/** The login gateway's QORPERA_LXD_IDENTITY_VOLUME_PREFIX. */
	sourcePrefix: string;
}

type Devices = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function parseExecutionHostIdentityVolumes(value: unknown): ExecutionHostIdentityVolumes {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== "pool,sourcePrefix"
	)
		throw new Error("INVALID_EXECUTION_HOST_IDENTITY_VOLUMES");
	const { pool, sourcePrefix } = value as Record<string, unknown>;
	if (typeof pool !== "string" || !POOL.test(pool) || typeof sourcePrefix !== "string" || !PREFIX.test(sourcePrefix))
		throw new Error("INVALID_EXECUTION_HOST_IDENTITY_VOLUMES");
	return { pool, sourcePrefix };
}

/** The one device that mounts this identity's volume. The id must already be
 * the canonical lower-case form the control plane issues. */
export function executionHostIdentityDevice(
	volumes: ExecutionHostIdentityVolumes,
	computeIdentityId: string,
): { name: string; device: Readonly<Record<string, string>> } {
	if (!IDENTITY.test(computeIdentityId)) throw new Error("INVALID_EXECUTION_HOST_IDENTITY");
	return {
		name: `identity-${computeIdentityId}`,
		device: {
			type: "disk",
			pool: volumes.pool,
			source: `${volumes.sourcePrefix}${computeIdentityId}`,
			path: `${EXECUTION_HOST_IDENTITY_ROOT}/${computeIdentityId}`,
		},
	};
}

/** The identity a device mounts, when it is exactly an identity device. */
export function executionHostIdentityOf(
	volumes: ExecutionHostIdentityVolumes,
	name: string,
	device: Readonly<Record<string, string>> | undefined,
): string | undefined {
	const match = DEVICE.exec(name);
	if (!match || !device) return undefined;
	const expected = executionHostIdentityDevice(volumes, match[1]).device;
	const keys = Object.keys(device);
	return keys.length === 4 && keys.every((key) => Object.hasOwn(expected, key) && device[key] === expected[key])
		? match[1]
		: undefined;
}

/** Splits an instance's devices into its identity devices and the rest. A
 * device counts only when the instance itself carries it and its effective
 * (expanded) form is the same, so a profile can neither add nor alter one. */
export function executionHostIdentityDevices(
	volumes: ExecutionHostIdentityVolumes,
	devices: Devices,
	expandedDevices: Devices,
): { identities: string[]; devices: Devices; expandedDevices: Devices } {
	const names = new Set(
		Object.keys(devices).filter((name) => {
			const identity = executionHostIdentityOf(volumes, name, devices[name]);
			return identity !== undefined && executionHostIdentityOf(volumes, name, expandedDevices[name]) === identity;
		}),
	);
	const rest = (value: Devices) => Object.fromEntries(Object.entries(value).filter(([name]) => !names.has(name)));
	return {
		identities: [...names].map((name) => name.slice("identity-".length)).sort(),
		devices: rest(devices),
		expandedDevices: rest(expandedDevices),
	};
}
