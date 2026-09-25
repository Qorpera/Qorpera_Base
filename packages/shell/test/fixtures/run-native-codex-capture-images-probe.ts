import "./native-probe-source-loader.ts";

const { runNativeCodexCompactionProbe } = await import("./native-codex-compaction-probe.ts");
const { runNativeCodexFenceFailureProbe } = await import("./native-codex-fence-failure-probe.ts");

// Explicit artifact required: this acceptance command never silently skips.
const [binary, ...args] = process.argv.slice(2);
if (!binary || args.length) throw new Error("Expected one source-built native Codex artifact");
const checks = [];
for (const model of ["offline-probe", "provider-default"] as const) {
	// The native artifact removed remote compaction v1; v2 retains remote coverage.
	for (const mode of ["local", "remote-v2"] as const) {
		for (const revoke of [false, true]) {
			checks.push({ model, ...(await runNativeCodexCompactionProbe(binary, mode, revoke, model, true)) });
		}
	}
}
const unissuedMediaChecks = [await runNativeCodexFenceFailureProbe(binary, "message_image")];
console.log(JSON.stringify({ platform: process.platform, checks, unissuedMediaChecks }));
