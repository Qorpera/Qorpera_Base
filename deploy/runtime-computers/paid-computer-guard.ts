import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPaidComputerGuardMain } from "../../packages/runner-orchestrator/src/computer-paid-guard-service.ts";

export function parseRuntimeComputerGuardArgs(args: string[]) {
	if ((args.length !== 2 && args.length !== 4) || args[0] !== "--provider" ||
		(args[1] !== "native" && args[1] !== "office") ||
		(args.length === 4 && (args[2] !== "--lxd-socket" || !args[3] || resolve(args[3]) !== args[3] || /[\x00-\x20]/.test(args[3]))))
		throw new Error("Usage: qorpera-runtime-computer-guard --provider native|office [--lxd-socket <absolute-path>]");
	return { provider: args[1], socketPath: args[3] } as { provider: "native" | "office"; socketPath: string | undefined };
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const config = parseRuntimeComputerGuardArgs(process.argv.slice(2));
	runPaidComputerGuardMain(config.provider, config.socketPath).catch(() => {
		console.error("PAID_GUARD_START_FAILED"); process.exitCode = 1;
	});
}
