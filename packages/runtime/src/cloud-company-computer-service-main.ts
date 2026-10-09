import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { CompanyComputerFillKey } from "./cloud-company-account-fill-box.ts";
import {
	CompanyComputerLifecycleFailure,
	type CompanyComputerLifecycleStage,
	companyComputerFailureDiagnostic,
} from "./cloud-company-computer-diagnostics.ts";
import { CompanyComputerLinuxBoundary } from "./cloud-company-computer-linux-boundary.ts";
import { startCompanyComputerLinuxOfficeService } from "./cloud-company-computer-linux-service.ts";
import { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { CompanyComputerScreenLifecyclePublisher } from "./cloud-company-computer-screen-lifecycle.ts";
import { CompanyComputerScreenOutbox } from "./cloud-company-computer-screen-outbox.ts";
import { parseCompanyComputerServiceConfig } from "./cloud-company-computer-service-config.ts";
import { readCompanyComputerServiceCredential } from "./cloud-company-computer-service-credentials.ts";
import { CompanyComputerStartupControl } from "./cloud-company-computer-startup.ts";
import { assertGuestImageSelfUpdateMasked } from "./lxd-guest-image-updates.ts";

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
	let stage: CompanyComputerLifecycleStage = "image";
	let failure: CompanyComputerLifecycleFailure | undefined;
	try {
		// Before any credential is read: an image that can update itself has
		// needrestart restart this service under members, and its shutdown
		// inhibitor refuses the office VM's stop.
		await assertGuestImageSelfUpdateMasked();
		stage = "credentials";
		const configBytes = await read("qorpera-office-config");
		stage = "configuration";
		const config = parseCompanyComputerServiceConfig(text(configBytes));
		stage = "credentials";
		const registryKey = text(await read("qorpera-office-registry"));
		const nativeToken = text(await read("qorpera-office-native"));
		// The capture object gateway's token (qorpera-office-objects) is no longer read: company objects are gone
		// (legacy removal, step C). The orchestrator still writes it, and the configuration its URL, until it drops them.
		if (
			!/^[\x21-\x7e]{32,8192}$/.test(registryKey) ||
			!/^[A-Za-z0-9_-]{43}$/.test(nativeToken) ||
			registryKey === nativeToken
		)
			throw new Error("OFFICE_SERVICE_CREDENTIALS_INVALID");
		const registry = new HttpCloudCompanyComputerRegistry({
			supabaseUrl: config.registryUrl,
			serviceRoleKey: registryKey,
		});
		stage = "configuration";
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
		// This service's key for company account fills (A1-3): made here, kept in memory only, its public half
		// reported with readiness. A restart makes a new one.
		const fillKey = new CompanyComputerFillKey();
		const startup = new CompanyComputerStartupControl(startupIdentity, registry, {
			fillPublicKey: fillKey.publicKey,
		});
		// Constructor validation has no I/O; reject malformed physical bindings
		// before even opening TLS material. The service repeats live preflight.
		new CompanyComputerLinuxBoundary({
			...config.linux,
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			registry,
		});
		stage = "tls";
		const tls = { cert: await read("qorpera-office-tls-cert"), key: await read("qorpera-office-tls-key") };
		createSecureContext({ ...tls, minVersion: "TLSv1.3" });
		stop.signal.throwIfAborted();
		stage = "outbox";
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
		stage = "startup";
		service = await startCompanyComputerLinuxOfficeService({
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			linux: { ...config.linux, fillKey },
			registry,
			native: { ...config.native, token: nativeToken, tls },
			startup,
			screenLifecycle,
			viewer: { ...config.viewer, tls },
			signal: stop.signal,
		});
		stage = "supervision";
		await service.finished;
		// An unexpected successful end is also a failed office lifetime.
		if (!stop.signal.aborted) throw new Error("OFFICE_SERVICE_ENDED_UNEXPECTEDLY");
	} catch (error) {
		failure = new CompanyComputerLifecycleFailure(stage, error);
	} finally {
		stop.abort();
		try {
			await service?.close();
		} catch (error) {
			// close() may repeat the already-rejected lifetime promise; that is
			// the original supervision failure, not a new drain failure.
			if (!failure || failure.cause !== error)
				failure = new CompanyComputerLifecycleFailure(
					"service-drain",
					failure ? new AggregateError([error, failure]) : error,
				);
		} finally {
			try {
				await screenOutbox?.close();
			} catch (error) {
				failure = new CompanyComputerLifecycleFailure(
					"outbox-drain",
					failure ? new AggregateError([error, failure]) : error,
				);
			} finally {
				process.removeListener("SIGINT", shutdown);
				process.removeListener("SIGTERM", shutdown);
				for (const buffer of buffers) buffer.fill(0);
			}
		}
	}
	if (failure) throw failure;
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
		runCompanyComputerServiceMain().catch((error) => {
			console.error(JSON.stringify(companyComputerFailureDiagnostic(error)));
			process.exitCode = 1;
		});
	}
}
