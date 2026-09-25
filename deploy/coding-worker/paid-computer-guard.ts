import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPaidComputerGuardMain } from "../../packages/runner-orchestrator/src/computer-paid-guard-service.ts";

export { runPaidComputerGuardMain };
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
	runPaidComputerGuardMain().catch(() => { console.error("PAID_GUARD_START_FAILED"); process.exitCode = 1; });
