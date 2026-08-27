#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compatibility tombstone for old staged images. The direct-NAS Company
 * File has no publication-head sync service; keeping this source entry point
 * fail-closed prevents an accidentally retained unit from mutating `live`.
 * Current guest packages do not include this file or its service. */

export async function runCloudCompanyComputerSyncServiceMain(
	_environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	throw new Error("Company Computer publication-head sync is retired; use the mounted live NAS Company File");
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCloudCompanyComputerSyncServiceMain().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
