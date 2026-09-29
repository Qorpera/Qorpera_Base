import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { controlCompanyComputerConfiguration } from "./cloud-company-computer-configuration-control.ts";
import { runCompanyComputerControlEntry } from "./cloud-company-computer-control-entry.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import { createCompanyComputerPreparationSystemdManager } from "./cloud-company-computer-preparation-systemd.ts";

export async function runCompanyComputerConfigurationControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked";
	const values = locked ? args.slice(1) : args;
	if (values.length !== 3) throw new Error("INVALID_OFFICE_CONFIGURATION_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	const stop = new AbortController();
	const shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerConfiguration(command, createCompanyComputerPreparationSystemdManager(), signal);
		else
			await lockedCompanyComputerControlChild(
				command,
				signal,
				"/opt/qorpera-office/qorpera-company-computer-configuration-control.mjs",
			);
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}

runCompanyComputerControlEntry({
	moduleUrl: import.meta.url,
	names: [
		"cloud-company-computer-configuration-control-main.ts",
		"qorpera-company-computer-configuration-control.mjs",
	],
	help: "Protected office configuration installation. Requires completed preparation and the existing kernel lock; never activates or starts the office.",
	failure: "Office configuration installation could not confirm protected preparation, configuration and credentials.",
	run: runCompanyComputerConfigurationControlMain,
});
