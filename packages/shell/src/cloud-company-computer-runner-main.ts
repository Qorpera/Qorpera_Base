#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeCompanyComputerGuestError } from "./cloud-company-computer-bootstrap-main.ts";
import { parseCompanyComputerRunnerServiceConfig } from "./cloud-company-computer-guest.ts";
import { runEphemeralCloudRunnerService } from "./cloud-runner-service.ts";
import { withCloudRunnerShutdownSignals } from "./cloud-runner-service-main.ts";

/** Standing runner service for the Company Computer guest: the reviewed
 * ephemeral execution pipeline, composed from the company-flavor service
 * configuration the bootstrap installed. Per-job workspaces live on the
 * dataset workbench; everything else — receipts, transcripts, sealed
 * capsules, publication through the verifier — is byte-for-byte the
 * ephemeral lane's behavior. */
export async function runCloudCompanyComputerRunnerServiceMain(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const configPath = environment.QORPERA_RUNNER_CONFIG;
	if (!configPath) throw new Error("QORPERA_RUNNER_CONFIG is required");
	const config = parseCompanyComputerRunnerServiceConfig(JSON.parse(await readFile(resolve(configPath), "utf-8")));
	await withCloudRunnerShutdownSignals((signal) =>
		runEphemeralCloudRunnerService({
			config,
			credentialsDirectory: environment.CREDENTIALS_DIRECTORY,
			signal,
		}),
	);
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCloudCompanyComputerRunnerServiceMain().catch((error: unknown) => {
		console.error(safeCompanyComputerGuestError(error));
		process.exitCode = 1;
	});
}
