#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLxdNativeLoginBootstrap } from "./lxd-runner-bootstrap.ts";

const TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;

export function safeLxdNativeLoginBootstrapError(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(TOKEN_PATTERN, "[redacted]")
			.slice(0, 1000)
			.trim() || "LXD native login bootstrap failed"
	);
}

export async function runLxdNativeLoginBootstrapMain(): Promise<void> {
	await runLxdNativeLoginBootstrap();
	console.log("LXD_NATIVE_LOGIN_BOOTSTRAP_READY");
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runLxdNativeLoginBootstrapMain().catch((error: unknown) => {
		console.error(safeLxdNativeLoginBootstrapError(error));
		process.exitCode = 1;
	});
}
