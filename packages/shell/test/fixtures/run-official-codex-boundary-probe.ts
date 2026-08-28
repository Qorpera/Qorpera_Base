import { runNativeCodexCompactionProbe } from "./native-codex-compaction-probe.ts";
import { runNativeCodexFenceFailureProbe } from "./native-codex-fence-failure-probe.ts";
import { runOfficialCodexBoundaryProbe } from "./official-codex-boundary-probe.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Expected the pinned official Codex command");
const proof = await runOfficialCodexBoundaryProbe([command, ...args], "provider-default");
if (args.length > 0) throw new Error("Failure acceptance requires the native artifact directly");
const failureChecks = [
	await runNativeCodexFenceFailureProbe(command, "revoked"),
	await runNativeCodexFenceFailureProbe(command, "stalled"),
];
const compactionChecks = [];
const providerDefaultCompactionChecks = [];
for (const mode of ["local", "remote", "remote-v2"] as const) {
	compactionChecks.push(await runNativeCodexCompactionProbe(command, mode));
	compactionChecks.push(await runNativeCodexCompactionProbe(command, mode, true));
	providerDefaultCompactionChecks.push(await runNativeCodexCompactionProbe(command, mode, false, "provider-default"));
	providerDefaultCompactionChecks.push(await runNativeCodexCompactionProbe(command, mode, true, "provider-default"));
}
console.log(JSON.stringify({ ...proof, failureChecks, compactionChecks, providerDefaultCompactionChecks }));
