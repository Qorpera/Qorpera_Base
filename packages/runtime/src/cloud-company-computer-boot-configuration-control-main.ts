import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import {
	controlCompanyComputerBootConfiguration,
	createCompanyComputerBootConfigurationSystemdManager,
} from "./cloud-company-computer-boot-configuration-control.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";

export async function runCompanyComputerBootConfigurationControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3) throw new Error("INVALID_OFFICE_BOOT_CONFIGURATION_COMMAND");
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
			await controlCompanyComputerBootConfiguration(
				command,
				createCompanyComputerBootConfigurationSystemdManager(),
				signal,
			);
		else
			await lockedCompanyComputerControlChild(
				command,
				signal,
				"/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs",
			);
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}
if (
	process.argv[1] &&
	[
		"cloud-company-computer-boot-configuration-control-main.ts",
		"qorpera-company-computer-boot-configuration-control.mjs",
	].includes(basename(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office configuration after VM resume. Requires retained shutdown history, current boot and kernel lock; never starts or activates the office.",
		);
	else
		runCompanyComputerBootConfigurationControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office boot configuration could not confirm retained history, workbench custody and credentials.",
			);
			process.exitCode = 1;
		});
}
