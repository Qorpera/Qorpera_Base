import "./native-probe-source-loader.ts";

const { runNativeCodexCompositionProbe } = await import("./native-codex-composition-probe.ts");
const [binary, ...args] = process.argv.slice(2);
if (!binary || args.length) throw new Error("Expected the pinned native Codex binary directly");
const checks = [];
for (const model of ["offline-probe", "provider-default"] as const) {
	for (const mode of ["delivery", "cancelled"] as const)
		checks.push(await runNativeCodexCompositionProbe(binary, mode, model));
}
console.log(JSON.stringify({ schema: "qorpera.native-message-composition-proof/v1", checks }));
