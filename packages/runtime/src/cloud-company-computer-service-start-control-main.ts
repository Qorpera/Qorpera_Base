import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import {
	controlCompanyComputerServiceStart,
	inspectCompanyComputerServiceStart,
} from "./cloud-company-computer-service-start-control.ts";
import { createCompanyComputerServiceStartSystemdManager } from "./cloud-company-computer-service-start-systemd.ts";

export async function runCompanyComputerServiceStartControlMain(args: readonly string[]): Promise<void> {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 3 && values.length !== 4) throw new Error("INVALID_OFFICE_SERVICE_START_COMMAND");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	const inspectionId = values[3];
	if (inspectionId !== undefined) {
		parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId });
		if (inspectionId === command.commandId) throw new Error("INVALID_OFFICE_SERVICE_START_COMMAND");
	}
	const stop = new AbortController(),
		shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60000)]);
	try {
		if (locked) {
			if (inspectionId === undefined)
				await controlCompanyComputerServiceStart(
					command,
					createCompanyComputerServiceStartSystemdManager(),
					signal,
				);
			else
				await inspectCompanyComputerServiceStart(
					command,
					inspectionId,
					createCompanyComputerServiceStartSystemdManager(),
					signal,
				);
		} else
			await lockedCompanyComputerControlChild(
				command,
				signal,
				"/opt/qorpera-office/qorpera-company-computer-service-start-control.mjs",
				inspectionId,
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
		"cloud-company-computer-service-start-control-main.ts",
		"qorpera-company-computer-service-start-control.mjs",
	].includes(basename(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office service start. Requires completed configuration and the existing kernel lock; activation remains provider-controlled.",
		);
	else
		runCompanyComputerServiceStartControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office service start could not confirm protected configuration and the current service invocation.",
			);
			process.exitCode = 1;
		});
}
