import "./native-probe-source-loader.ts";

const { runNativeCodexCompactionProbe } = await import("./native-codex-compaction-probe.ts");
const { runNativeCodexFenceFailureProbe } = await import("./native-codex-fence-failure-probe.ts");
const { runOfficialCodexBoundaryProbe } = await import("./official-codex-boundary-probe.ts");

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Expected the pinned official Codex command");
const proof = await runOfficialCodexBoundaryProbe([command, ...args], "provider-default");
const solBoundaryProof = await runOfficialCodexBoundaryProbe([command, ...args], "gpt-5.6-sol");
if (args.length > 0) throw new Error("Failure acceptance requires the native artifact directly");
const failureChecks = [
	await runNativeCodexFenceFailureProbe(command, "revoked"),
	await runNativeCodexFenceFailureProbe(command, "stalled"),
];
const compactionChecks = [];
const providerDefaultCompactionChecks = [];
for (const mode of ["local", "remote-v2"] as const) {
	compactionChecks.push(await runNativeCodexCompactionProbe(command, mode));
	compactionChecks.push(await runNativeCodexCompactionProbe(command, mode, true));
	providerDefaultCompactionChecks.push(await runNativeCodexCompactionProbe(command, mode, false, "provider-default"));
	providerDefaultCompactionChecks.push(await runNativeCodexCompactionProbe(command, mode, true, "provider-default"));
}
console.log(
	JSON.stringify({ ...proof, solBoundaryProof, failureChecks, compactionChecks, providerDefaultCompactionChecks }),
);
