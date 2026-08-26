#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LxdUnixClient } from "./lxd-client.ts";
import { verifyLxdImageProvenanceFiles } from "./lxd-image-provenance.ts";
import {
	HttpLxdNativeLoginGateway,
	LxdNativeLoginGateway,
	type LxdNativeLoginGatewayConfig,
} from "./lxd-login-gateway.ts";
import {
	HttpLxdGuestTransport,
	LxdCloudRunnerProviderBackend,
	type LxdCloudRunnerProviderConfig,
} from "./lxd-provider.ts";
import { nodeHttpFetch } from "./node-http-fetch.ts";
import { ProcessCloudRunnerProviderBackend, type ProcessCloudRunnerProviderConfig } from "./process-provider.ts";
import {
	type CloudRunnerProviderServiceBackend,
	type CloudRunnerProviderServiceNetworkOptions,
	HttpCloudRunnerProviderService,
} from "./provider-service.ts";

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

function integer(name: string, fallback?: number): number {
	const encoded = process.env[name];
	if (encoded === undefined && fallback !== undefined) return fallback;
	const value = Number(encoded);
	if (!Number.isSafeInteger(value)) throw new Error(`${name} is invalid`);
	return value;
}

function optionalAbsoluteFile(name: string): Buffer | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	if (!value || !isAbsolute(value) || value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new Error(`${name} must be an absolute path`);
	}
	return readFileSync(value);
}

function providerNetwork(): { host: string; options: CloudRunnerProviderServiceNetworkOptions } {
	const host = process.env.QORPERA_RUNNER_PROVIDER_HOST ?? "127.0.0.1";
	const trustedSource = process.env.QORPERA_RUNNER_PROVIDER_TRUSTED_SOURCE;
	const certificate = optionalAbsoluteFile("QORPERA_RUNNER_PROVIDER_TLS_CERT");
	const privateKey = optionalAbsoluteFile("QORPERA_RUNNER_PROVIDER_TLS_KEY");
	if ((certificate === undefined) !== (privateKey === undefined)) {
		throw new Error("Runner provider TLS requires both certificate and private key files");
	}
	const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
	if (!loopback) {
		if (isIP(host) !== 4) throw new Error("Non-loopback runner provider host must be an IPv4 address");
		if (!trustedSource || isIP(trustedSource) !== 4) {
			throw new Error("Non-loopback runner provider host requires one trusted IPv4 source");
		}
		if (!certificate || !privateKey) {
			throw new Error("Non-loopback runner provider host requires TLS");
		}
	}
	return {
		host,
		options: {
			...(trustedSource ? { trustedSource } : {}),
			...(certificate && privateKey ? { tls: { certificate, privateKey } } : {}),
		},
	};
}

function processConfig(): ProcessCloudRunnerProviderConfig {
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

function lxdConfig(): LxdCloudRunnerProviderConfig {
	return {
		adapterId: required("QORPERA_RUNNER_PROVIDER_ADAPTER"),
		supabaseUrl: required("QORPERA_SUPABASE_URL"),
		supabaseServiceKey: required("QORPERA_SUPABASE_SERVICE_KEY"),
		supabasePublishableKey: required("QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		stateRoot: resolve(required("QORPERA_RUNNER_PROVIDER_STATE_ROOT")),
		project: required("QORPERA_LXD_PROJECT"),
		jobProfile: required("QORPERA_LXD_JOB_PROFILE"),
		networkInterface: required("QORPERA_LXD_NETWORK_INTERFACE"),
		imageServer: required("QORPERA_LXD_IMAGE_SERVER"),
		imageFingerprint: required("QORPERA_LXD_IMAGE_FINGERPRINT"),
		storagePool: required("QORPERA_LXD_STORAGE_POOL"),
		identityVolumePrefix: process.env.QORPERA_LXD_IDENTITY_VOLUME_PREFIX ?? "identity-",
		identityVolumeSize: required("QORPERA_LXD_IDENTITY_VOLUME_SIZE"),
		rootDiskSize: required("QORPERA_LXD_ROOT_DISK_SIZE"),
		cpuLimit: integer("QORPERA_LXD_CPU_LIMIT"),
		memoryLimit: required("QORPERA_LXD_MEMORY_LIMIT"),
		guestAssignmentPort: integer("QORPERA_LXD_GUEST_ASSIGNMENT_PORT", 8082),
		guestAssignmentSource: required("QORPERA_LXD_GUEST_ASSIGNMENT_SOURCE"),
		nativeBridgePort: integer("QORPERA_LXD_NATIVE_BRIDGE_PORT", 8083),
		nativeExecutionGid: integer("QORPERA_LXD_NATIVE_EXECUTION_GID", 42041),
		guestReadyTimeoutMs: integer("QORPERA_LXD_GUEST_READY_TIMEOUT_MS", 300_000),
		runnerImage: required("QORPERA_EPHEMERAL_RUNNER_IMAGE"),
		runnerPodmanPath: required("QORPERA_EPHEMERAL_RUNNER_PODMAN"),
		runnerEntrypoint: required("QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT"),
		runnerVersion: process.env.QORPERA_EPHEMERAL_RUNNER_VERSION ?? "dev",
		codexPath: process.env.QORPERA_CODEX_PATH ?? "/usr/local/bin/codex",
		claudePath: process.env.QORPERA_CLAUDE_PATH ?? "/usr/local/bin/claude",
		guestBootstrapService: process.env.QORPERA_LXD_GUEST_BOOTSTRAP_SERVICE ?? "qorpera-lxd-runner-bootstrap.service",
		...liveCompanyConfig(),
	};
}

/** The live company tree is opt-in and all-or-nothing: a host mount path and
 * the profile it belongs to, or neither. */
function liveCompanyConfig(): { liveCompanyRoot?: string; liveCompanyProfileId?: string } {
	const root = process.env.QORPERA_LXD_LIVE_COMPANY_ROOT;
	const profileId = process.env.QORPERA_LXD_LIVE_COMPANY_PROFILE_ID;
	if (!root && !profileId) return {};
	if (!root || !profileId) {
		throw new Error("QORPERA_LXD_LIVE_COMPANY_ROOT and QORPERA_LXD_LIVE_COMPANY_PROFILE_ID are required together");
	}
	return { liveCompanyRoot: resolve(root), liveCompanyProfileId: profileId };
}

function lxdLoginConfig(config: LxdCloudRunnerProviderConfig): LxdNativeLoginGatewayConfig {
	return {
		adapterId: config.adapterId,
		supabaseUrl: config.supabaseUrl,
		supabaseServiceKey: config.supabaseServiceKey,
		stateRoot: resolve(required("QORPERA_LXD_LOGIN_STATE_ROOT")),
		project: config.project,
		loginProfile: required("QORPERA_LXD_LOGIN_PROFILE"),
		networkInterface: config.networkInterface,
		imageServer: config.imageServer,
		imageFingerprint: config.imageFingerprint,
		storagePool: config.storagePool,
		identityVolumePrefix: config.identityVolumePrefix,
		identityVolumeSize: config.identityVolumeSize,
		rootDiskSize: config.rootDiskSize,
		cpuLimit: config.cpuLimit,
		memoryLimit: config.memoryLimit,
		nativeBridgePort: config.nativeBridgePort,
		guestTrustedSource: config.guestAssignmentSource,
		guestReadyTimeoutMs: config.guestReadyTimeoutMs,
		codexPath: config.codexPath,
		claudePath: config.claudePath,
		loginBootstrapService:
			process.env.QORPERA_LXD_LOGIN_BOOTSTRAP_SERVICE ?? "qorpera-lxd-native-login-bootstrap.service",
	};
}

interface ProviderRuntime {
	backend: CloudRunnerProviderServiceBackend;
	loginGateway?: HttpLxdNativeLoginGateway;
}

function runtime(): ProviderRuntime {
	const kind = process.env.QORPERA_RUNNER_PROVIDER_BACKEND ?? "process";
	if (kind === "process") return { backend: new ProcessCloudRunnerProviderBackend(processConfig(), nodeHttpFetch) };
	if (kind === "lxd") {
		const config = lxdConfig();
		verifyLxdImageProvenanceFiles(
			resolve(required("QORPERA_LXD_IMAGE_PROVENANCE")),
			resolve(required("QORPERA_LXD_IMAGE_PROVENANCE_PUBLIC_KEY")),
			{
				imageServer: config.imageServer,
				imageFingerprint: config.imageFingerprint,
				guestPackageManifestSha256: required("QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256"),
				runnerImage: config.runnerImage,
				runnerImageArchiveSha256: required("QORPERA_EPHEMERAL_RUNNER_IMAGE_ARCHIVE_SHA256"),
				runnerImageCosignBundleSha256: required("QORPERA_EPHEMERAL_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256"),
			},
		);
		const client = new LxdUnixClient(
			process.env.QORPERA_LXD_SOCKET ?? "/var/snap/lxd/common/lxd/unix.socket",
			integer("QORPERA_LXD_OPERATION_TIMEOUT_SECONDS", 120),
		);
		return {
			backend: new LxdCloudRunnerProviderBackend(
				config,
				client,
				new HttpLxdGuestTransport(client, nodeHttpFetch),
				nodeHttpFetch,
			),
			loginGateway: new HttpLxdNativeLoginGateway(
				new LxdNativeLoginGateway(lxdLoginConfig(config), client, nodeHttpFetch),
				process.env.QORPERA_LXD_LOGIN_GATEWAY_HOST ?? "127.0.0.1",
				integer("QORPERA_LXD_LOGIN_GATEWAY_PORT", 18082),
			),
		};
	}
	throw new Error("QORPERA_RUNNER_PROVIDER_BACKEND must be process or lxd");
}

async function main(): Promise<void> {
	const current = runtime();
	const network = providerNetwork();
	const service = new HttpCloudRunnerProviderService(
		current.backend,
		required("QORPERA_RUNNER_PROVIDER_TOKEN"),
		network.host,
		port(),
		network.options,
	);
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await service.start();
		await current.loginGateway?.start();
		await new Promise<void>((resolveWait) =>
			shutdown.signal.addEventListener("abort", () => resolveWait(), { once: true }),
		);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await current.loginGateway?.close();
		await service.close();
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
