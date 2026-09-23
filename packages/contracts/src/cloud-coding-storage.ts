/** Deployment-bound NAS identity. These descriptors carry no storage credential
 * and parsing them does not grant attachment or writer authority. */
export interface CloudCodingNasPolicy {
	readonly schema: "qorpera.coding-nas-policy/v1";
	readonly mountPoint: string;
	readonly source: string;
	readonly serverAddress: string;
	readonly rootPath: string;
}

export interface CloudCodingStorageBinding {
	readonly schema: "qorpera.coding-storage/v1";
	readonly volumeId: string;
	readonly workerId: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly writerGeneration: number;
	readonly machineIdSha256: string;
	readonly policy: CloudCodingNasPolicy;
	readonly dataSource: string;
	readonly custodySource: string;
	readonly dataTarget: "/workspace";
	readonly custodyTarget: "/var/lib/qorpera-coding";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error("INVALID_CODING_STORAGE");
	return value as Record<string, unknown>;
}

function path(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 2048 ||
		!value.startsWith("/") ||
		/[\x00-\x20\x7f\\]/.test(value) ||
		value
			.slice(1)
			.split("/")
			.some((part) => !part || part === "." || part === "..")
	)
		throw new Error("INVALID_CODING_STORAGE_PATH");
	return value;
}

export function parseCloudCodingNasPolicy(value: unknown): Readonly<CloudCodingNasPolicy> {
	const p = object(value, ["schema", "mountPoint", "source", "serverAddress", "rootPath"]);
	const mountPoint = path(p.mountPoint),
		rootPath = path(p.rootPath);
	// Keep the first backend deliberately explicit: NFSv4 over a pinned IPv4
	// address. Other transports need their own version and physical verifier.
	if (
		p.schema !== "qorpera.coding-nas-policy/v1" ||
		typeof p.serverAddress !== "string" ||
		!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(p.serverAddress) ||
		p.serverAddress.split(".").some((part) => String(Number(part)) !== part || Number(part) > 255) ||
		typeof p.source !== "string" ||
		!p.source.startsWith(`${p.serverAddress}:/`) ||
		!(rootPath === mountPoint || rootPath.startsWith(`${mountPoint}/`))
	)
		throw new Error("INVALID_CODING_NAS_POLICY");
	path(p.source.slice(p.serverAddress.length + 1));
	return Object.freeze({
		schema: "qorpera.coding-nas-policy/v1",
		mountPoint,
		source: p.source,
		serverAddress: p.serverAddress,
		rootPath,
	});
}

export function parseCloudCodingStorageBinding(value: unknown): Readonly<CloudCodingStorageBinding> {
	const b = object(value, [
		"schema",
		"volumeId",
		"workerId",
		"companyId",
		"environmentId",
		"writerGeneration",
		"machineIdSha256",
		"policy",
		"dataSource",
		"custodySource",
		"dataTarget",
		"custodyTarget",
	]);
	const policy = parseCloudCodingNasPolicy(b.policy);
	if (
		b.schema !== "qorpera.coding-storage/v1" ||
		![b.volumeId, b.workerId, b.companyId, b.environmentId].every((id) => typeof id === "string" && UUID.test(id)) ||
		b.volumeId !== b.workerId ||
		!Number.isSafeInteger(b.writerGeneration) ||
		Number(b.writerGeneration) < 1 ||
		typeof b.machineIdSha256 !== "string" ||
		!SHA.test(b.machineIdSha256) ||
		b.dataTarget !== "/workspace" ||
		b.custodyTarget !== "/var/lib/qorpera-coding"
	)
		throw new Error("INVALID_CODING_STORAGE_BINDING");
	const root = `${policy.rootPath}/workers/${b.companyId}/${b.environmentId}/${b.workerId}`;
	if (b.dataSource !== `${root}/data` || b.custodySource !== `${root}/guest-state`)
		throw new Error("CODING_STORAGE_PATH_BINDING_DIFFERS");
	return Object.freeze({
		schema: "qorpera.coding-storage/v1",
		volumeId: b.volumeId as string,
		workerId: b.workerId as string,
		companyId: b.companyId as string,
		environmentId: b.environmentId as string,
		writerGeneration: Number(b.writerGeneration),
		machineIdSha256: b.machineIdSha256,
		policy,
		dataSource: b.dataSource,
		custodySource: b.custodySource,
		dataTarget: "/workspace",
		custodyTarget: "/var/lib/qorpera-coding",
	});
}

export function createCloudCodingStorageBinding(
	policy: CloudCodingNasPolicy,
	scope: {
		workerId: string;
		companyId: string;
		environmentId: string;
		machineIdSha256: string;
		writerGeneration: number;
	},
): Readonly<CloudCodingStorageBinding> {
	const checked = parseCloudCodingNasPolicy(policy);
	const root = `${checked.rootPath}/workers/${scope.companyId}/${scope.environmentId}/${scope.workerId}`;
	return parseCloudCodingStorageBinding({
		...scope,
		schema: "qorpera.coding-storage/v1",
		volumeId: scope.workerId,
		policy: checked,
		dataSource: `${root}/data`,
		custodySource: `${root}/guest-state`,
		dataTarget: "/workspace",
		custodyTarget: "/var/lib/qorpera-coding",
	});
}
