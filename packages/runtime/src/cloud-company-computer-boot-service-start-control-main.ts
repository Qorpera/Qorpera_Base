import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import {
	controlCompanyComputerBootServiceStart,
	createCompanyComputerBootServiceStartSystemdManager,
} from "./cloud-company-computer-boot-service-start-control.ts";
import { runCompanyComputerControlEntry } from "./cloud-company-computer-control-entry.ts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";

const executable = "/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs";
export async function runCompanyComputerBootServiceStartControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3 && values.length !== 4) throw new Error("INVALID_OFFICE_BOOT_SERVICE_START_COMMAND");
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
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_START_COMMAND");
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked)
			await controlCompanyComputerBootServiceStart(
				command,
				createCompanyComputerBootServiceStartSystemdManager(),
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
		"cloud-company-computer-boot-service-start-control-main.ts",
		"qorpera-company-computer-boot-service-start-control.mjs",
	],
	help: "Protected retained-boot service start and inspection. Requires acknowledged boot configuration and the existing kernel lock; SQL admission remains provider-controlled.",
	failure: "Office retained-boot service start could not confirm protected configuration and the current invocation.",
	run: runCompanyComputerBootServiceStartControlMain,
});
