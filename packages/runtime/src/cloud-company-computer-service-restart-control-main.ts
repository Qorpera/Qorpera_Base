import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { runCompanyComputerControlEntry } from "./cloud-company-computer-control-entry.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import {
	controlCompanyComputerServiceRestart,
	createCompanyComputerServiceRestartSystemdManager,
} from "./cloud-company-computer-service-restart-control.ts";

export async function runCompanyComputerServiceRestartControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3 && values.length !== 4) throw new Error("INVALID_OFFICE_SERVICE_RESTART_COMMAND");
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
		throw new Error("INVALID_OFFICE_SERVICE_RESTART_COMMAND");
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerServiceRestart(
				command,
				createCompanyComputerServiceRestartSystemdManager(),
				signal,
				inspectionId,
			);
		else
			await lockedCompanyComputerControlChild(
				command,
				signal,
				"/opt/qorpera-office/qorpera-company-computer-service-restart-control.mjs",
				inspectionId,
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
		"cloud-company-computer-service-restart-control-main.ts",
		"qorpera-company-computer-service-restart-control.mjs",
	],
	help: "Protected office service restart and fresh inspection. Requires retained stop acknowledgement, prepared successor and the kernel lock; SQL activation remains separate.",
	failure: "Office service restart could not confirm the retained predecessor and new service invocation.",
	run: runCompanyComputerServiceRestartControlMain,
});
