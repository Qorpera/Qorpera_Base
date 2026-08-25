import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEphemeralCloudRunnerServiceConfig, runEphemeralCloudRunnerService } from "./cloud-runner-service.ts";

const TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;

export interface CloudRunnerServiceSignalHost {
	once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function safeCloudRunnerServiceError(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(TOKEN_PATTERN, "[redacted]")
			.slice(0, 1000)
			.trim() || "Ephemeral runner service failed"
	);
}

export async function withCloudRunnerShutdownSignals(
	run: (signal: AbortSignal) => Promise<void>,
	host: CloudRunnerServiceSignalHost = process,
): Promise<void> {
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort(new Error("Ephemeral runner service stopped"));
	host.once("SIGINT", stop);
	host.once("SIGTERM", stop);
	try {
		await run(shutdown.signal);
	} finally {
		host.removeListener("SIGINT", stop);
		host.removeListener("SIGTERM", stop);
	}
}

export async function runEphemeralCloudRunnerServiceMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const configPath = environment.QORPERA_RUNNER_CONFIG;
	if (!configPath) throw new Error("QORPERA_RUNNER_CONFIG is required");
	const config = await loadEphemeralCloudRunnerServiceConfig(configPath);
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
	runEphemeralCloudRunnerServiceMain().catch((error: unknown) => {
		console.error(safeCloudRunnerServiceError(error));
		process.exitCode = 1;
	});
}
