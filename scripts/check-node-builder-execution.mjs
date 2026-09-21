import { isDeepStrictEqual } from "node:util";
import { LxdUnixClient } from "../packages/runner-orchestrator/src/lxd-client.ts";
import { inspectLxdHostInventorySocket } from "../packages/runner-orchestrator/src/lxd-office-physical-host.ts";
import { officeRecord } from "../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { readRuntimeNodeHost } from "../packages/runner-orchestrator/src/runtime-node-host.ts";
import { verifyNodeBuilderExecution } from "./node-builder-execution-guard.mjs";

async function main() {
// The protected root dispatcher supplies the reviewed bundle with Node -e after
// dropping to the existing observer account. The canonical socket inspector
// deliberately refuses root; its namespace/socket checks still run unchanged.
if (process.argv.length !== 1 || process.platform !== "linux" || !process.geteuid?.()) throw new Error("BUILDER_EXECUTION_UNPRIVILEGED_STDIN_ONLY");
let bytes = 0;
const chunks = [];
for await (const chunk of process.stdin) {
	bytes += chunk.length;
	if (bytes > 1024 * 1024) throw new Error("BUILDER_EXECUTION_INPUT_TOO_LARGE");
	chunks.push(chunk);
}
const input = officeRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")), ["contract", "authority"]);
const signal = AbortSignal.timeout(5000);
const policy = input.contract.inventoryPolicy;
const before = { ...await inspectLxdHostInventorySocket(policy.host, signal), ...await readRuntimeNodeHost(signal) };
if (before.machineIdSha256 !== policy.host.machineIdSha256 || before.bootId !== input.contract.hostBootId)
	throw new Error("BUILDER_EXECUTION_HOST_DIFFERS");
const inventory = await new LxdUnixClient(policy.host.socketPath).inspectHostInventory(signal);
const after = { ...await inspectLxdHostInventorySocket(policy.host, signal), ...await readRuntimeNodeHost(signal) };
if (!isDeepStrictEqual(before, after)) throw new Error("BUILDER_EXECUTION_HOST_CHANGED");
signal.throwIfAborted();
console.log(JSON.stringify(verifyNodeBuilderExecution(input.contract, input.authority, inventory, Date.now())));
}
main().catch(() => { console.error("BUILDER_EXECUTION_UNCONFIRMED"); process.exitCode = 1; });
