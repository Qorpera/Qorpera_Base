import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import {
	controlCompanyComputerBootServiceRestart,
	createCompanyComputerBootServiceRestartSystemdManager,
} from "./cloud-company-computer-boot-service-restart-control.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";

const executable = "/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs";
export async function runCompanyComputerBootServiceRestartControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3 && values.length !== 4) throw new Error("INVALID_OFFICE_BOOT_SERVICE_RESTART_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
			commandId: values[0],
			requestSha256: values[1],
			bootId: values[2],
		}),
		inspectionId = values[3];
	if (
		inspectionId !== undefined &&
		parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId }).commandId === command.commandId
	)
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_RESTART_COMMAND");
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerBootServiceRestart(
				command,
				createCompanyComputerBootServiceRestartSystemdManager(),
				signal,
				inspectionId,
			);
		else await lockedCompanyComputerControlChild(command, signal, executable, inspectionId);
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}
if (
	process.argv[1] &&
	["cloud-company-computer-boot-service-restart-control-main.ts", basename(executable)].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected retained-boot service restart and inspection. Requires acknowledged boot configuration and the existing kernel lock; SQL admission remains provider-controlled.",
		);
	else
		runCompanyComputerBootServiceRestartControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office retained-boot service restart could not confirm protected configuration and the current invocation.",
			);
			process.exitCode = 1;
		});
}
