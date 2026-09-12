import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import {
	controlCompanyComputerResetConfiguration,
	createCompanyComputerResetConfigurationSystemdManager,
} from "./cloud-company-computer-reset-configuration-control.ts";

const executable = "/opt/qorpera-office/qorpera-company-computer-reset-configuration-control.mjs";
export async function runCompanyComputerResetConfigurationControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3) throw new Error("INVALID_OFFICE_RESET_CONFIGURATION_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerResetConfiguration(
				command,
				createCompanyComputerResetConfigurationSystemdManager(),
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
	["cloud-company-computer-reset-configuration-control-main.ts", basename(executable)].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office configuration on a recreated root after a governed reset. Requires the restored public receipt and predecessor history, the current boot and the kernel lock; never starts or activates the office.",
		);
	else
		runCompanyComputerResetConfigurationControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office reset configuration could not confirm restored provenance, workbench custody and credentials.",
			);
			process.exitCode = 1;
		});
}
