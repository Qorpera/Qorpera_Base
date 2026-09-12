import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { runLxdOfficeControlObserver } from "./lxd-office-control-observer.ts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { LxdOfficeLifecycle, type LxdOfficeLifecycleResult, runLxdOfficeLifecycle } from "./lxd-office-lifecycle.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderHttpRegistry } from "./lxd-office-provider-registry.ts";
import { loadLxdOfficeSoftwareLane, parseLxdOfficeSoftwareLaneDocument } from "./lxd-office-software-lane.ts";
import { parseOfficeInventoryLimits } from "./lxd-office-storage-inventory.ts";

export function createOfficeLifecycleWriter(stream: Writable) {
	// Writable emits an error event in addition to rejecting its write callback.
	// Keep the handler for the stream lifetime, including errors after shutdown.
	stream.on("error", () => {});
	return (value: string): Promise<void> =>
		new Promise((resolve, reject) => {
			stream.write(`${value}\n`, (error) => (error ? reject(error) : resolve()));
		});
}
let stdoutWriter: ReturnType<typeof createOfficeLifecycleWriter> | undefined;
function writeObservation(value: string): Promise<void> {
	stdoutWriter ??= createOfficeLifecycleWriter(process.stdout);
	return stdoutWriter(value);
}

/** One pending diagnostic write, no queued backlog and no awaited export.
 * Times describe reconciliation observations, not exact VM transitions.
 * The next poll can report recovery after a failed sink; retained events are
 * never restamped or replayed as fresh observations. */
export function createOfficeLifecycleReporter(
	identity: LxdOfficeLifecycle["observationIdentity"],
	write: (value: string) => void | Promise<void>,
	now: () => Date = () => new Date(),
) {
	const binding = { ...identity };
	let pending = false;
	let previous = "";
	return (result?: LxdOfficeLifecycleResult): void => {
		if (pending) return;
		try {
			const record = {
				schema: "qorpera.lxd-office-provider-observation/v2",
				...binding,
				state: result?.state ?? "unconfirmed",
				phase: result?.phase ?? null,
				intentId: result?.intentId ?? null,
				transitionId: result?.transitionId ?? null,
				activationId: result?.activationId ?? null,
				observationSha256: result?.observationSha256 ?? null,
				acknowledgedAtMs: result?.acknowledgedAtMs ?? null,
				errorCategory: result ? (result.state === "failed" ? "PHASE_FAILED" : null) : "RECONCILIATION_UNCONFIRMED",
				physicalTransitionAt: null,
				resourceReleaseInferred: false,
			};
			const key = JSON.stringify(record);
			if (key === previous) return;
			const encoded = JSON.stringify({ ...record, observedAt: now().toISOString() });
			pending = true;
			try {
				void Promise.resolve(write(encoded))
					.then(
						() => {
							previous = key;
						},
						() => {},
					)
					.finally(() => {
						pending = false;
					});
			} catch {
				pending = false;
			}
		} catch {
			// Missing diagnostics remain missing; never change product authority.
		}
	};
}

export function parseLxdOfficeLifecycleServiceConfig(value: unknown) {
	const keys = [
		"schema",
		"policyPath",
		"provenancePath",
		"planPath",
		"registryUrl",
		"registryCredential",
		"inventoryLimits",
		"pollIntervalMs",
	];
	// The software lane is an optional, explicitly named sibling document.
	const r =
		value && typeof value === "object" && Object.hasOwn(value, "softwareLanePath")
			? officeRecord(value, [...keys, "softwareLanePath"])
			: officeRecord(value, keys);
	if (r.schema !== "qorpera.lxd-office-provider-service/v1" || typeof r.registryUrl !== "string")
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
	const credential = officeRecord(r.registryCredential, ["path", "bytes", "sha256"]);
	if (
		!Number.isSafeInteger(credential.bytes) ||
		(credential.bytes as number) < 32 ||
		(credential.bytes as number) > 4096 ||
		!Number.isSafeInteger(r.pollIntervalMs) ||
		(r.pollIntervalMs as number) < 1000 ||
		(r.pollIntervalMs as number) > 60000
	)
		throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
	// Validate the endpoint without loading a credential or sending a request.
	new LxdOfficeProviderHttpRegistry(r.registryUrl, "validation-only-".repeat(3));
	return {
		policyPath: officePhysicalPath(r.policyPath),
		provenancePath: officePhysicalPath(r.provenancePath),
		planPath: officePhysicalPath(r.planPath),
		registryUrl: r.registryUrl,
		registryCredential: {
			path: officePhysicalPath(credential.path),
			bytes: credential.bytes as number,
			sha256: officeSha(credential.sha256),
		},
		inventoryLimits: parseOfficeInventoryLimits(r.inventoryLimits),
		pollIntervalMs: r.pollIntervalMs as number,
		softwareLanePath: r.softwareLanePath === undefined ? undefined : officePhysicalPath(r.softwareLanePath),
	};
}

/** The service is executed as its dedicated non-root user under flock
 * --no-fork. No enrollment or boot is implied by loading configuration. All
 * paths originate in one root-protected local document, never request input. */
export async function runLxdOfficeLifecycleService(
	configPath: string,
	signal: AbortSignal,
	write: (value: string) => void | Promise<void> = writeObservation,
) {
	let credential: Buffer | undefined;
	try {
		const config = parseLxdOfficeLifecycleServiceConfig(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(await readLxdOfficeProtectedFile(configPath, 16384)),
			),
		);
		signal.throwIfAborted();
		credential = await readLxdOfficeCredentialFile(config.registryCredential.path, 4096);
		if (
			credential.byteLength !== config.registryCredential.bytes ||
			createHash("sha256").update(credential).digest("hex") !== config.registryCredential.sha256
		)
			throw new Error("credential differs");
		const registry = new LxdOfficeProviderHttpRegistry(
			config.registryUrl,
			new TextDecoder("utf8", { fatal: true }).decode(credential),
		);
		credential.fill(0);
		const software =
			config.softwareLanePath === undefined
				? undefined
				: await loadLxdOfficeSoftwareLane(
						parseLxdOfficeSoftwareLaneDocument(
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readLxdOfficeProtectedFile(config.softwareLanePath, 16384),
								),
							),
						),
						readLxdOfficeCredentialFile,
					);
		signal.throwIfAborted();
		const lifecycle = await LxdOfficeLifecycle.open(
			config.policyPath,
			config.provenancePath,
			registry,
			{ ...config, software },
			signal,
		);
		const emit = createOfficeLifecycleReporter(lifecycle.observationIdentity, write);
		const stop = new AbortController();
		const running = AbortSignal.any([signal, stop.signal]);
		const outcomes = await Promise.allSettled([
			runLxdOfficeLifecycle(
				lifecycle,
				running,
				(result) => emit(result),
				() => emit(),
				config.pollIntervalMs,
			).finally(() => stop.abort()),
			runLxdOfficeControlObserver(
				(checked) => lifecycle.observeControlOperations(checked),
				running,
				() => emit(),
			).finally(() => stop.abort()),
		]);
		if (!signal.aborted && outcomes.some((result) => result.status === "rejected"))
			throw new Error("OFFICE_PROVIDER_LOOPS_UNCONFIRMED");
	} catch {
		if (!signal.aborted) throw new Error("OFFICE_PROVIDER_SERVICE_UNCONFIRMED");
	} finally {
		credential?.fill(0);
	}
}
