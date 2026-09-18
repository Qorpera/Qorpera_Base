import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import { lockedCompanyComputerControlChild } from "./cloud-company-computer-preparation-control-main.ts";
import { controlCompanyComputerServiceStop } from "./cloud-company-computer-service-stop-control.ts";
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
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(100000)]);
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
if (
	process.argv[1] &&
	[
		"cloud-company-computer-service-stop-control-main.ts",
		"qorpera-company-computer-service-stop-control.mjs",
	].includes(basename(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Protected office stop and fresh inspection. Requires retained admission revocation and a kernel lock; never restarts, reboots or releases a machine.",
		);
	else
		runCompanyComputerServiceStopControlMain(process.argv.slice(2)).catch(() => {
			console.error(
				"Office service stop could not confirm the retained request and complete process-group cleanup.",
			);
			process.exitCode = 1;
		});
}
