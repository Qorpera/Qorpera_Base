#!/usr/bin/env node
import { cloudRunnerOrchestratorServiceConfigFromEnvironment, runCloudRunnerOrchestratorService } from "./service.ts";

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{43}/g, "[redacted]");
}

const controller = new AbortController();
const stop = (): void => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
	const config = cloudRunnerOrchestratorServiceConfigFromEnvironment(process.env);
	await runCloudRunnerOrchestratorService({
		config,
		signal: controller.signal,
		onError: (error) => console.error(safeError(error)),
	});
} catch (error) {
	console.error(safeError(error));
	process.exitCode = 1;
} finally {
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
}
