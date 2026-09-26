import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { createCompanyComputerBootConfigurationSystemdManager } from "./cloud-company-computer-boot-configuration-control.ts";
import { controlCompanyComputerOutageTermination } from "./cloud-company-computer-outage-termination-control.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";

const executable = "/opt/qorpera-office/qorpera-company-computer-outage-termination-control.mjs";
export async function runCompanyComputerOutageTerminationControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3) throw new Error("INVALID_OFFICE_OUTAGE_TERMINATION_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
			commandId: values[0],
			requestSha256: values[1],
			bootId: values[2],
		}),
		stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerOutageTermination(
				command,
				createCompanyComputerBootConfigurationSystemdManager(),
				signal,
			);
		else await lockedCompanyComputerControlChild(command, signal, executable);
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}
if (
	process.argv[1] &&
	["cloud-company-computer-outage-termination-control-main.ts", basename(executable)].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office outage termination inspection. Requires fresh boot, unstarted units, retained preparation and kernel lock; never starts or admits the office.",
		);
	else
		runCompanyComputerOutageTerminationControlMain(process.argv.slice(2)).catch(() => {
			console.error("Office outage termination could not confirm retained custody and fresh-boot termination.");
			process.exitCode = 1;
		});
}
