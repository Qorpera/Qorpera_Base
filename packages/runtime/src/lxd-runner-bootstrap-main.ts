#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLxdRunnerBootstrap } from "./lxd-runner-bootstrap.ts";

const TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;

export function safeLxdRunnerBootstrapError(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(TOKEN_PATTERN, "[redacted]")
			.slice(0, 1000)
			.trim() || "LXD runner bootstrap failed"
	);
}

export async function runLxdRunnerBootstrapMain(): Promise<void> {
	await runLxdRunnerBootstrap();
	console.log("LXD_RUNNER_BOOTSTRAP_READY");
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runLxdRunnerBootstrapMain().catch((error: unknown) => {
		console.error(safeLxdRunnerBootstrapError(error));
		process.exitCode = 1;
	});
}
