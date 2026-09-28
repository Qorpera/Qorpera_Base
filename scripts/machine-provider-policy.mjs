import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Prints one node's machine policy for the operator: the executor's
// `machines` configuration block and the service-role SQL that enrolls the
// node provider (the largest machine this node makes) and the executor.
//
//   node scripts/machine-provider-policy.mjs <image-build.json> <owner> <node-id> <machine-id-sha256> \
//     <provider-id> <max-cpus> <max-memory-gib> [project] [storage-pool] [network]
//
// The provider policy digest covers everything a machine of this node is made
// from, so a new image or helper is a new provider policy (and old machines
// keep theirs until they are deleted).
const [buildPath, owner, nodeId, machineIdSha256, providerId, maxCpus, maxMemoryGiB, project = "machines", storagePool, network = "machine-net"] =
	process.argv.slice(2);
if (!buildPath || !owner || !nodeId || !machineIdSha256 || !providerId || !maxCpus || !maxMemoryGiB)
	throw new Error("Usage: machine-provider-policy.mjs <image-build.json> <owner> <node-id> <machine-id-sha256> <provider-id> <max-cpus> <max-memory-gib> [project] [storage-pool] [network]");
const build = JSON.parse(await readFile(buildPath, "utf8"));
if (build.schema !== "qorpera.machine-image-build/v1") throw new Error("Not a machine image build record");
const cpuMillis = Number(maxCpus) * 1000;
const memoryBytes = Number(maxMemoryGiB) * 1024 ** 3;
if (!Number.isSafeInteger(cpuMillis) || cpuMillis < 1000 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1024 ** 3)
	throw new Error("Invalid largest machine");
const pool = storagePool ?? project;
const policyDocument = {
	schema: "qorpera.machine-provider-policy/v1",
	project,
	imageFingerprint: build.imageFingerprint,
	bootstrapSha256: build.bootstrapSha256,
	storagePool: pool,
	network,
	helperSha256: build.helperSha256,
	maxCpuMillis: cpuMillis,
	maxMemoryBytes: memoryBytes,
};
const providerPolicySha256 = createHash("sha256").update(JSON.stringify(policyDocument)).digest("hex");
const policy = {
	providerId,
	providerPolicySha256,
	project,
	imageFingerprint: build.imageFingerprint,
	bootstrapSha256: build.bootstrapSha256,
	storagePool: pool,
	network,
};
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
console.log(
	JSON.stringify(
		{
			policyDocument,
			executorConfiguration: { machines: { policy, helperSha256: build.helperSha256 } },
			sql: [
				`select public.qorpera_enroll_runtime_node_provider(${quote(nodeId)}::uuid, ${quote(machineIdSha256)}, 'machine', ${quote(providerId)}, ${quote(providerPolicySha256)}, ${cpuMillis}, ${memoryBytes});`,
				`select public.qorpera_configure_machine_executor(${quote(owner)}, ${quote(machineIdSha256)}, true, ${quote(JSON.stringify(policy))}::jsonb);`,
			],
		},
		null,
		2,
	),
);
