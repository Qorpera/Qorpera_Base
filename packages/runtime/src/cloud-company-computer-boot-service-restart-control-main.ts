import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import {
	controlCompanyComputerBootServiceRestart,
	createCompanyComputerBootServiceRestartSystemdManager,
} from "./cloud-company-computer-boot-service-restart-control.ts";
import { runCompanyComputerControlEntry } from "./cloud-company-computer-control-entry.ts";
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
runCompanyComputerControlEntry({
	moduleUrl: import.meta.url,
	names: [
		"cloud-company-computer-boot-service-restart-control-main.ts",
		"qorpera-company-computer-boot-service-restart-control.mjs",
	],
	help: "Protected retained-boot service restart and inspection. Requires acknowledged boot configuration and the existing kernel lock; SQL admission remains provider-controlled.",
	failure:
		"Office retained-boot service restart could not confirm protected configuration and the current invocation.",
	run: runCompanyComputerBootServiceRestartControlMain,
});
