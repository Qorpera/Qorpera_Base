import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { runCompanyComputerControlEntry } from "./cloud-company-computer-control-entry.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import {
	COMPANY_COMPUTER_SERVICE_STOP_CONTROL_MS,
	controlCompanyComputerServiceStop,
} from "./cloud-company-computer-service-stop-control.ts";
import { createCompanyComputerServiceStopSystemdManager } from "./cloud-company-computer-service-stop-systemd.ts";

export async function runCompanyComputerServiceStopControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3 && values.length !== 4) throw new Error("INVALID_OFFICE_SERVICE_STOP_COMMAND");
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
		throw new Error("INVALID_OFFICE_SERVICE_STOP_COMMAND");
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(COMPANY_COMPUTER_SERVICE_STOP_CONTROL_MS)]);
	try {
		if (locked)
			await controlCompanyComputerServiceStop(
				command,
				createCompanyComputerServiceStopSystemdManager(),
				signal,
				inspectionId,
			);
		else
			await lockedCompanyComputerControlChild(
				command,
				signal,
				"/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",
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
	names: ["cloud-company-computer-service-stop-control-main.ts", "qorpera-company-computer-service-stop-control.mjs"],
	help: "Protected office stop and fresh inspection. Requires retained admission revocation and a kernel lock; never restarts, reboots or releases a machine.",
	failure: "Office service stop could not confirm the retained request and complete process-group cleanup.",
	run: runCompanyComputerServiceStopControlMain,
});
