#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompanyComputerGuestBootstrap } from "./cloud-company-computer-guest.ts";

const TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;

export function safeCompanyComputerGuestError(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(TOKEN_PATTERN, "[redacted]")
			.slice(0, 1_000)
			.trim() || "Company computer guest service failed"
	);
}

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
