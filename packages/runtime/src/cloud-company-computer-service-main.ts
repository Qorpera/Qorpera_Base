import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { CompanyComputerLinuxBoundary } from "./cloud-company-computer-linux-boundary.ts";
import { startCompanyComputerLinuxOfficeService } from "./cloud-company-computer-linux-service.ts";
import { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { CompanyComputerScreenLifecyclePublisher } from "./cloud-company-computer-screen-lifecycle.ts";
import { CompanyComputerScreenOutbox } from "./cloud-company-computer-screen-outbox.ts";
import { parseCompanyComputerServiceConfig } from "./cloud-company-computer-service-config.ts";
import { readCompanyComputerServiceCredential } from "./cloud-company-computer-service-credentials.ts";
import { CompanyComputerStartupControl } from "./cloud-company-computer-startup.ts";

/** One process owns the office, independent of clients. Configuration never
 * activates an office or manufactures adoption; the Linux preflight and first
 * cloud reconciliation must succeed before the service accepts work. */
export async function runCompanyComputerServiceMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory) throw new Error("OFFICE_SYSTEMD_CREDENTIALS_REQUIRED");
	const stop = new AbortController();
	const shutdown = (): void => stop.abort();
	// Register before file reads, TLS validation or any physical startup.
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const buffers: Buffer[] = [];
	const read = async (name: Parameters<typeof readCompanyComputerServiceCredential>[1]): Promise<Buffer> => {
		stop.signal.throwIfAborted();
		const value = await readCompanyComputerServiceCredential(directory, name);
		buffers.push(value);
		stop.signal.throwIfAborted();
		return value;
	};
	const text = (value: Buffer): string => new TextDecoder("utf8", { fatal: true }).decode(value).trim();
	let service: Awaited<ReturnType<typeof startCompanyComputerLinuxOfficeService>> | undefined;
	let screenOutbox: CompanyComputerScreenOutbox | undefined;
	try {
		const configBytes = await read("qorpera-office-config");
		const config = parseCompanyComputerServiceConfig(text(configBytes));
		const registryKey = text(await read("qorpera-office-registry"));
		const nativeToken = text(await read("qorpera-office-native"));
		const objectsToken = text(await read("qorpera-office-objects"));
		if (
			!/^[\x21-\x7e]{32,8192}$/.test(registryKey) ||
			![nativeToken, objectsToken].every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)) ||
			new Set([registryKey, nativeToken, objectsToken]).size !== 3
		)
			throw new Error("OFFICE_SERVICE_CREDENTIALS_INVALID");
		const registry = new HttpCloudCompanyComputerRegistry({
			supabaseUrl: config.registryUrl,
			serviceRoleKey: registryKey,
		});
		const startupIdentity = {
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			allocationId: config.linux.attestation.allocationId,
			instanceSha256: config.linux.attestation.instanceSha256,
			imageSha256: config.linux.attestation.imageSha256,
			bootstrapSha256: config.linux.attestation.bootstrapSha256,
			bootId: config.linux.attestation.bootId,
			configurationSha256: createHash("sha256").update(configBytes).digest("hex"),
			serviceInvocationId: environment.INVOCATION_ID ?? "",
		};
		const startup = new CompanyComputerStartupControl(startupIdentity, registry);
		// Constructor validation has no I/O; reject malformed physical bindings
		// before even opening TLS material. The service repeats live preflight.
		new CompanyComputerLinuxBoundary({
			...config.linux,
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			registry,
		});
		const tls = { cert: await read("qorpera-office-tls-cert"), key: await read("qorpera-office-tls-key") };
		createSecureContext({ ...tls, minVersion: "TLSv1.3" });
		stop.signal.throwIfAborted();
		screenOutbox = await CompanyComputerScreenOutbox.open(
			"/var/lib/qorpera-office-events",
			config.scope,
			[
				...Object.values(config.linux.layout),
				config.linux.displayRuntimeRoot,
				config.linux.browserRuntimeRoot,
				config.linux.captureRoot,
				config.linux.privateWorkbenchMount.mountPoint,
			],
			registry,
		);
		const screenLifecycle = new CompanyComputerScreenLifecyclePublisher(startupIdentity, registry, screenOutbox);
		screenOutbox.start();
		service = await startCompanyComputerLinuxOfficeService({
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			linux: config.linux,
			registry,
			native: { ...config.native, token: nativeToken, tls },
			startup,
			screenLifecycle,
			viewer: { ...config.viewer, tls },
			captureObjectGateway: { baseUrl: config.captureObjectGatewayUrl, token: objectsToken },
			signal: stop.signal,
		});
		await service.finished;
		// An unexpected successful end is also a failed office lifetime.
		if (!stop.signal.aborted) throw new Error("OFFICE_SERVICE_ENDED_UNEXPECTEDLY");
	} finally {
		stop.abort();
		try {
			await service?.close();
		} finally {
			try {
				await screenOutbox?.close();
			} finally {
				process.removeListener("SIGINT", shutdown);
				process.removeListener("SIGTERM", shutdown);
				for (const buffer of buffers) buffer.fill(0);
			}
		}
	}
}

if (
	process.argv[1] &&
	["cloud-company-computer-service-main.ts", "qorpera-company-computer-service.mjs"].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log(
			"Headless shared office. Requires an adopted Linux guest, current cloud admission and private systemd credentials.",
		);
	} else if (process.argv.length !== 2) {
		console.error("Office service accepts only --help; startup configuration must use systemd credentials.");
		process.exitCode = 1;
	} else {
		runCompanyComputerServiceMain().catch(() => {
			console.error(
				"Office service could not start or continue; inspect protected configuration and office authority.",
			);
			process.exitCode = 1;
		});
	}
}
