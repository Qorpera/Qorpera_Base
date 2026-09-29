import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { reconcileOfficeFleet } from "./lxd-office-fleet.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { code, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeLifecycleJournal } from "./lxd-office-lifecycle-journal.ts";
import { parseLxdOfficeLifecycleServiceConfig, runLxdOfficeLifecycleService } from "./lxd-office-lifecycle-service.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { lxdOfficePhysicalPolicySha256, officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderHttpRegistry } from "./lxd-office-provider-registry.ts";
import { readLxdOfficeRetiredMarker } from "./lxd-office-retirement-control.ts";
import { OFFICE_RETIREMENT_REQUEST } from "./lxd-office-retirement-worker.ts";

export function parseOfficeFleetServiceConfig(value: unknown) {
	const r = officeRecord(value, ["schema", "nodeId", "servicePath", "serviceConfigSha256"]);
	if (
		r.schema !== "qorpera.office-fleet-service/v1" ||
		typeof r.nodeId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.nodeId)
	)
		throw new Error("OFFICE_FLEET_CONFIG_INVALID");
	return {
		nodeId: r.nodeId,
		servicePath: officePhysicalPath(r.servicePath),
		serviceConfigSha256: officeSha(r.serviceConfigSha256),
	};
}

/** Run under the SAME process-owned local journal lock as the lifecycle
 * provider. Each office/host has separate protected configuration and local
 * journal. Only the selected host enters the existing lifecycle service. */
export async function runOfficeFleetService(configPath: string, signal: AbortSignal, stageOnly = false): Promise<void> {
	const config = parseOfficeFleetServiceConfig(
		JSON.parse((await readLxdOfficeProtectedFile(configPath, 16384)).toString("utf8")),
	);
	const bytes = await readLxdOfficeProtectedFile(config.servicePath, 16384);
	if (createHash("sha256").update(bytes).digest("hex") !== config.serviceConfigSha256)
		throw new Error("OFFICE_FLEET_SERVICE_CHANGED");
	const service = parseLxdOfficeLifecycleServiceConfig(JSON.parse(bytes.toString("utf8")));
	const gate = await LxdOfficePhysicalGate.open(service.policyPath, service.provenancePath, signal);
	const policy = gate.policy,
		g = policy.guest;
	await assertOfficeAdoptionKernelLock(policy.journal.path);
	// A retired office (its company deleted) has no VM and makes no call; the unit ends.
	if (
		await readLxdOfficeRetiredMarker(policy.journal.path, {
			scope: {
				companyId: g.companyId,
				environmentId: g.environmentId,
				companyComputerId: g.companyComputerId,
				logicalComputerId: g.logicalComputerId,
			},
			computerGeneration: g.computerGeneration,
		})
	)
		return;
	// A pinned retirement continues on this host without the fleet: after the
	// company's purge only the retirement's own calls still answer.
	let pinned = true;
	try {
		await readRecord(join(policy.journal.path, OFFICE_RETIREMENT_REQUEST), 65536);
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		pinned = false;
	}
	if (pinned) {
		if (!stageOnly) await runLxdOfficeLifecycleService(config.servicePath, signal);
		return;
	}
	const credential = await readLxdOfficeCredentialFile(service.registryCredential.path, 4096);
	let registry: LxdOfficeProviderHttpRegistry;
	try {
		if (
			credential.length !== service.registryCredential.bytes ||
			createHash("sha256").update(credential).digest("hex") !== service.registryCredential.sha256
		)
			throw new Error("OFFICE_FLEET_CREDENTIAL_CHANGED");
		registry = new LxdOfficeProviderHttpRegistry(service.registryUrl, credential.toString("utf8"));
	} finally {
		credential.fill(0);
	}
	const client = new LxdUnixClient(policy.host.socketPath);
	while (!signal.aborted) {
		const result = await reconcileOfficeFleet(
			{
				policy,
				nodeId: config.nodeId,
				serviceConfigSha256: config.serviceConfigSha256,
				registry,
				stageOnly,
				inspect: async (checked) => {
					await gate.inspect(checked);
				},
				identity: async (intentId, existing, checked) => {
					await assertOfficeAdoptionKernelLock(policy.journal.path);
					await LxdOfficeLifecycleJournal.open(
						policy.journal.path,
						intentId,
						officeDigest({
							providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
							inventoryLimits: service.inventoryLimits,
							planPath: service.planPath,
						}),
						existing,
					);
					return openLxdOfficeCreationIdentity(policy, intentId, existing, client, checked);
				},
			},
			signal,
		);
		if (result === "selected") {
			// Do not let a config replacement between selection and launch redirect
			// this process to a different installation.
			if (
				createHash("sha256")
					.update(await readLxdOfficeProtectedFile(config.servicePath, 16384))
					.digest("hex") !== config.serviceConfigSha256
			)
				throw new Error("OFFICE_FLEET_SERVICE_CHANGED");
			if (!stageOnly) await runLxdOfficeLifecycleService(config.servicePath, signal);
			return;
		}
		if (result === "elsewhere" || result === "held" || result === "staged" || stageOnly) return;
		if (result === "retained") throw new Error("OFFICE_FLEET_EXISTING_OWNER_REQUIRES_ORIGINAL_SERVICE");
		await delay(service.pollIntervalMs, undefined, { signal }).catch(() => {});
	}
}
