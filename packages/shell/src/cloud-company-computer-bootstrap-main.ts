#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompanyComputerGuestBootstrap, safeCompanyComputerGuestError } from "./cloud-company-computer-guest.ts";

export async function runCompanyComputerBootstrapMain(): Promise<void> {
	await runCompanyComputerGuestBootstrap();
	console.log("COMPANY_COMPUTER_BOOTSTRAP_READY");
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCompanyComputerBootstrapMain().catch((error: unknown) => {
		console.error(safeCompanyComputerGuestError(error));
		process.exitCode = 1;
	});
}
