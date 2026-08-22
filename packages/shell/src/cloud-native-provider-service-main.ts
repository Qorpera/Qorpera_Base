import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NativeProviderHost, OfficialCliNativeHarnessDriver } from "./cloud-native-provider-host.ts";
import {
	HttpNativeProviderHostService,
	SupabaseNativeCredentialCapsuleStore,
	SupabaseNativeProviderControlPlane,
} from "./cloud-native-provider-service.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
	return value;
}

function optionalPort(value: string | undefined): number {
	const port = Number(value ?? "8082");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("QORPERA_NATIVE_PROVIDER_PORT is invalid");
	}
	return port;
}

export async function runNativeProviderHostServiceMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const baseUrl = required(environment, "QORPERA_SUPABASE_URL");
	const serviceKey = required(environment, "QORPERA_SUPABASE_SERVICE_KEY");
	const masterKeyPath = resolve(required(environment, "QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE"));
	const masterKey = (await readFile(masterKeyPath, "utf-8")).trim();
	const bridgeToken = required(environment, "QORPERA_NATIVE_PROVIDER_BRIDGE_TOKEN");
	const executionBoundary = required(environment, "QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY");
	if (executionBoundary !== "virtual_machine" && executionBoundary !== "microvm") {
		throw new Error("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY must name the dedicated machine boundary");
	}
	if (!TOKEN_PATTERN.test(masterKey) || !TOKEN_PATTERN.test(bridgeToken)) {
		throw new Error("Native provider credentials must contain 32 base64url bytes");
	}
	const host = new NativeProviderHost({
		controlPlane: new SupabaseNativeProviderControlPlane(baseUrl, serviceKey),
		capsules: new SupabaseNativeCredentialCapsuleStore(baseUrl, serviceKey),
		harness: new OfficialCliNativeHarnessDriver(
			environment.QORPERA_CODEX_PATH ?? "codex",
			environment.QORPERA_CLAUDE_PATH ?? "claude",
		),
		masterKey,
		...(environment.QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT
			? { temporaryRoot: environment.QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT }
			: {}),
	});
	const service = new HttpNativeProviderHostService(
		host,
		bridgeToken,
		environment.QORPERA_NATIVE_PROVIDER_HOST ?? "127.0.0.1",
		optionalPort(environment.QORPERA_NATIVE_PROVIDER_PORT),
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

if (process.argv[1]?.endsWith("qorpera-native-provider-host.mjs")) {
	runNativeProviderHostServiceMain().catch((error: unknown) => {
		const message = (error instanceof Error ? error.message : String(error))
			.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")
			.slice(0, 1000);
		console.error(message);
		process.exitCode = 1;
	});
}
