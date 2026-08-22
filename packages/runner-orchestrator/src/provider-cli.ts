#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessCloudRunnerProviderBackend, type ProcessCloudRunnerProviderConfig } from "./process-provider.ts";
import { HttpCloudRunnerProviderService } from "./provider-service.ts";

function required(name: string): string {
	const value = process.env[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
	return value;
}

function port(): number {
	const value = Number(process.env.QORPERA_RUNNER_PROVIDER_PORT ?? "8081");
	if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
		throw new Error("QORPERA_RUNNER_PROVIDER_PORT is invalid");
	}
	return value;
}

function config(): ProcessCloudRunnerProviderConfig {
	const nativeExecutionBoundary = required("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY");
	if (nativeExecutionBoundary !== "virtual_machine" && nativeExecutionBoundary !== "microvm") {
		throw new Error("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY must name the dedicated machine boundary");
	}
	return {
		adapterId: required("QORPERA_RUNNER_PROVIDER_ADAPTER"),
		supabaseUrl: required("QORPERA_SUPABASE_URL"),
		supabaseServiceKey: required("QORPERA_SUPABASE_SERVICE_KEY"),
		supabasePublishableKey: required("QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		runnerModulePath: resolve(required("QORPERA_EPHEMERAL_RUNNER_MODULE")),
		nativeProviderModulePath: resolve(required("QORPERA_NATIVE_PROVIDER_MODULE")),
		stateRoot: resolve(required("QORPERA_RUNNER_PROVIDER_STATE_ROOT")),
		temporaryRoot: resolve(required("QORPERA_RUNNER_PROVIDER_TEMPORARY_ROOT")),
		image: required("QORPERA_EPHEMERAL_RUNNER_IMAGE"),
		podmanPath: resolve(required("QORPERA_EPHEMERAL_RUNNER_PODMAN")),
		entrypoint: required("QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT"),
		nativeProviderMasterKeyFile: resolve(required("QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE")),
		nativeExecutionBoundary,
		codexPath: process.env.QORPERA_CODEX_PATH ?? "codex",
		claudePath: process.env.QORPERA_CLAUDE_PATH ?? "claude",
		platform: process.env.QORPERA_EPHEMERAL_RUNNER_PLATFORM ?? process.platform,
		runnerVersion: process.env.QORPERA_EPHEMERAL_RUNNER_VERSION ?? "dev",
	};
}

async function main(): Promise<void> {
	const backend = new ProcessCloudRunnerProviderBackend(config());
	const service = new HttpCloudRunnerProviderService(
		backend,
		required("QORPERA_RUNNER_PROVIDER_TOKEN"),
		process.env.QORPERA_RUNNER_PROVIDER_HOST ?? "127.0.0.1",
		port(),
	);
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await service.start();
		await new Promise<void>((resolveWait) =>
			shutdown.signal.addEventListener("abort", () => resolveWait(), { once: true }),
		);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await service.close();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(
			(error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{43}/g, "[redacted]"),
		);
		process.exitCode = 1;
	});
}
