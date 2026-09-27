#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lxdNativeCompanyRuntimeFromEnvironment } from "./lxd-company-runtime.ts";
import { nodeHttpFetch } from "./node-http-fetch.ts";
import { ProviderNodeObservability } from "./node-observability.ts";
import { HttpCloudRunnerProviderService } from "./provider-service.ts";
import { SharedExecutionProviderBackend, type SharedExecutionProviderConfig } from "./shared-execution-backend.ts";

/** Shared execution service entry point. Runs as root inside the execution
 * host VM: it owns per-slot credentials on tmpfs, starts and stops the
 * per-run units, and answers the orchestrator on loopback. Every secret it
 * holds arrives as a systemd credential; nothing is read from the process
 * environment that a `systemctl show` would print. */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CREDENTIAL_BYTES = 8192;

function required(name: string, environment: NodeJS.ProcessEnv = process.env): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
	return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
	const encoded = process.env[name];
	const value = encoded === undefined ? fallback : Number(encoded);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
	return value;
}

async function systemdCredential(name: string): Promise<string | undefined> {
	const directory = process.env.CREDENTIALS_DIRECTORY;
	if (!directory) return undefined;
	if (!isAbsolute(directory)) throw new Error("CREDENTIALS_DIRECTORY must be absolute");
	const flags = process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(join(directory, name), flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_CREDENTIAL_BYTES || (metadata.mode & 0o077) !== 0)
			throw new Error(`Systemd credential ${name} is unsafe`);
		return (await handle.readFile({ encoding: "utf-8" })).trim();
	} finally {
		await handle.close();
	}
}

async function credential(credentialName: string, environmentName: string): Promise<string> {
	const value = (await systemdCredential(credentialName)) ?? process.env[environmentName];
	if (!value || /[\0\r\n]/.test(value)) throw new Error(`${environmentName} is required as a systemd credential`);
	return value.trim();
}

export async function sharedExecutionConfigFromEnvironment(): Promise<{
	config: SharedExecutionProviderConfig;
	providerToken: string;
	host: string;
	port: number;
}> {
	const nativeCompanyRuntime = lxdNativeCompanyRuntimeFromEnvironment(process.env);
	if (!nativeCompanyRuntime) throw new Error("Shared execution requires the governed company-path-v1 runtime");
	const serviceKey = await credential("qorpera-supabase-service-key", "QORPERA_SUPABASE_SERVICE_KEY");
	const providerToken = await credential("qorpera-runner-provider", "QORPERA_RUNNER_PROVIDER_TOKEN");
	if (!TOKEN_PATTERN.test(providerToken)) throw new Error("Runner provider token must contain 32 base64url bytes");
	const host = process.env.QORPERA_RUNNER_PROVIDER_HOST ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "localhost")
		throw new Error("The shared execution service answers its co-located orchestrator on loopback only");
	const slotCount = integer("QORPERA_SHARED_EXECUTION_SLOTS", 16, 1, 64);
	const config: SharedExecutionProviderConfig = {
		adapterId: required("QORPERA_RUNNER_PROVIDER_ADAPTER"),
		hostId: required("QORPERA_SHARED_EXECUTION_HOST_ID"),
		supabaseUrl: required("QORPERA_SUPABASE_URL"),
		supabaseServiceKey: serviceKey,
		supabasePublishableKey: required("QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		stateRoot: resolve(process.env.QORPERA_SHARED_EXECUTION_STATE_ROOT ?? "/var/lib/qorpera-shared-execution"),
		runRoot: resolve(process.env.QORPERA_SHARED_EXECUTION_RUN_ROOT ?? "/run/qorpera-shared-execution"),
		identityRoot: resolve(process.env.QORPERA_SHARED_EXECUTION_IDENTITY_ROOT ?? "/var/lib/qorpera/identities"),
		slotCount,
		portBase: integer("QORPERA_SHARED_EXECUTION_PORT_BASE", 20_000, 1024, 65_535 - slotCount * 2),
		hostUnitPrefix: "qorpera-shared-run-host@",
		runnerUnitPrefix: "qorpera-shared-runner@",
		hostAccountPrefix: "qorpera-shared-host",
		runnerAccountPrefix: "qorpera-shared-runner",
		runnerImage: required("QORPERA_EPHEMERAL_RUNNER_IMAGE"),
		runnerPodmanPath: resolve(required("QORPERA_EPHEMERAL_RUNNER_PODMAN")),
		runnerEntrypoint: required("QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT"),
		runnerVersion: process.env.QORPERA_EPHEMERAL_RUNNER_VERSION ?? "dev",
		codexPath: process.env.QORPERA_CODEX_PATH ?? "/usr/local/bin/codex",
		claudePath: process.env.QORPERA_CLAUDE_PATH ?? "/usr/local/bin/claude",
		nativeCompanyRuntime,
		startTimeoutMs: integer("QORPERA_SHARED_EXECUTION_START_TIMEOUT_MS", 30_000, 1000, 600_000),
		// Warm conversations (2026-09-27): off unless set.
		...(process.env.QORPERA_SHARED_EXECUTION_WARM_IDLE_MS
			? { warmIdleMs: integer("QORPERA_SHARED_EXECUTION_WARM_IDLE_MS", 300_000, 1, 30 * 60_000) }
			: {}),
	};
	return { config, providerToken, host, port: integer("QORPERA_RUNNER_PROVIDER_PORT", 18_450, 1, 65_535) };
}

async function main(): Promise<void> {
	const { config, providerToken, host, port } = await sharedExecutionConfigFromEnvironment();
	const backend = new SharedExecutionProviderBackend(config, { fetch: nodeHttpFetch });
	const service = new HttpCloudRunnerProviderService(backend, providerToken, host, port, {
		nodeObservations: new ProviderNodeObservability({
			providerAdapter: backend.adapterId,
			nodeId: process.env.QORPERA_RUNNER_NODE_ID,
			softwareVersion: process.env.QORPERA_RUNNER_PROVIDER_SOFTWARE_VERSION,
		}),
	});
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	// Retirement must not depend on the orchestrator being up: a finished
	// run's slot and its company-ceiling reservation are released within a few
	// seconds either way. Failures are counted, never printed with their text.
	let reconcileFailures = 0;
	const reconcile = async (): Promise<void> => {
		try {
			await backend.reconcile(shutdown.signal);
			reconcileFailures = 0;
		} catch {
			if (++reconcileFailures === 1 || reconcileFailures % 60 === 0)
				console.error(
					JSON.stringify({ schema: "qorpera.shared-execution-reconcile/v1", failures: reconcileFailures }),
				);
		}
	};
	const timer = setInterval(() => void reconcile(), 5000);
	try {
		await service.start();
		await new Promise<void>((resolveWait) =>
			shutdown.signal.addEventListener("abort", () => resolveWait(), { once: true }),
		);
	} finally {
		clearInterval(timer);
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await service.close();
		await backend.close();
	}
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	main().catch((error: unknown) => {
		console.error(
			(error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{43}/g, "[redacted]"),
		);
		process.exitCode = 1;
	});
}
