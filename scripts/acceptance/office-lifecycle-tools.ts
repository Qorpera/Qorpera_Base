import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { planLxdOfficeAdoption } from "../../packages/runner-orchestrator/src/lxd-office-adoption-plan.ts";
import { lxdOfficeGuestPlan } from "../../packages/runner-orchestrator/src/lxd-office-guest.ts";
import { captureLxdOfficeHostNamespace } from "../../packages/runner-orchestrator/src/lxd-office-host-namespace.ts";
import { officeDigest } from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { officeLifecycleErrorCode, parseLxdOfficeLifecycleServiceConfig, runLxdOfficeLifecycleService } from "../../packages/runner-orchestrator/src/lxd-office-lifecycle-service.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "../../packages/runner-orchestrator/src/lxd-office-physical-host.ts";
import { lxdOfficePhysicalPolicySha256, parseLxdOfficePhysicalPolicy } from "../../packages/runner-orchestrator/src/lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "../../packages/runner-orchestrator/src/lxd-office-start-control.ts";
import { runRuntimeNodeObserver } from "../../packages/runner-orchestrator/src/runtime-node-observer-service.ts";
import { RuntimeComputerHttpControl, readRuntimeComputerExecutorSecret } from "../../packages/runner-orchestrator/src/runtime-computer-http-control.ts";
import { exerciseRuntimeWorkloadUsage } from "./workload-usage-probe.ts";
import { officeServiceFailureDiagnostics } from "./office-service-diagnostics.ts";

// This executable composes the real production components. It supplies no
// replacement physical, registry, journal, clock, or worker ports.
const action = process.argv[2];
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (action === "service-diagnostics") {
	let text = "";
	for await (const bytes of process.stdin) {
		text += bytes.toString();
		if (Buffer.byteLength(text) > 65536) throw new Error("OFFICE_SERVICE_DIAGNOSTIC_LIMIT");
	}
	report(officeServiceFailureDiagnostics(text));
} else if (action === "provider") {
	try {
		await runLxdOfficeLifecycleService(process.argv[3], abort.signal, (line) => { process.stdout.write(`${line}\n`); });
	} catch (error) {
		report({ schema: "qorpera.office-acceptance-provider-failure/v1", state: "startup_failed", errorCode: officeLifecycleErrorCode(error) });
		process.exitCode = 1;
	}
} else if (action === "observer") {
	await runRuntimeNodeObserver(abort.signal, (state) => report({ observer: state }));
} else if (action === "namespace") {
	await captureLxdOfficeHostNamespace();
} else if (action === "finish-usage") {
	const config = parseLxdOfficeLifecycleServiceConfig(JSON.parse((await readLxdOfficeProtectedFile(process.argv[3], 16384)).toString("utf8")));
	assert(config.computerExecutorCredentialPath);
	const credential = await readLxdOfficeCredentialFile(config.registryCredential.path, 4096);
	try {
		assert.equal(credential.byteLength, config.registryCredential.bytes);
		assert.equal(createHash("sha256").update(credential).digest("hex"), config.registryCredential.sha256);
		const policy = parseLxdOfficePhysicalPolicy(JSON.parse((await readLxdOfficeProtectedFile(config.policyPath, 65536)).toString("utf8")));
		const journal = JSON.parse(await readFile(process.argv[4], "utf8"));
		const plan = lxdOfficeGuestPlan(journal.binding), binding = plan.binding;
		const control = new RuntimeComputerHttpControl({ supabaseUrl: config.registryUrl, supabaseServiceKey: credential.toString("utf8"),
			executorSecret: await readRuntimeComputerExecutorSecret(config.computerExecutorCredentialPath) });
		report(await exerciseRuntimeWorkloadUsage({ context: { allocationId: binding.allocationId, providerKind: "office", providerId: binding.providerId,
			policySha256: binding.providerPolicySha256, instanceSha256: plan.instanceSha256, bootstrapSha256: binding.bootstrapSha256,
			runId: null, runnerId: null, officeId: binding.companyComputerId, computerGeneration: binding.computerGeneration },
			guardSocketPath: "/run/qorpera-office-computer-guard/control.sock", lxdSocketPath: policy.host.socketPath, control,
			disposableRun: { githubHosted: true, companyId: binding.companyId }, close: true, signal: abort.signal }));
	} finally { credential.fill(0); }
} else if (action === "infrastructure") {
	const socketPath = "/var/snap/lxd/common/lxd/unix.socket";
	const client = new LxdUnixClient(socketPath);
	const server = await client.inspectOfficeServer("default", abort.signal);
	const infrastructure = await client.inspectOfficeInfrastructure("default", "lxdbr0", "default", abort.signal);
	const image = await client.inspectOfficeImage("default", process.argv[3], abort.signal);
	report({ host: { machineIdSha256: createHash("sha256").update((await readFile("/etc/machine-id", "utf8")).trim()).digest("hex"),
		socketPath, socketGid: (await stat(socketPath)).gid, certificateSha256: server.certificateSha256,
		serverName: server.serverName, serverVersion: server.serverVersion, architecture: server.architecture },
		infrastructure: { projectSha256: officeDigest(infrastructure.project), networkSha256: officeDigest(infrastructure.network), storagePoolSha256: officeDigest(infrastructure.storagePool) },
		image, cpuMillis: cpus().length * 1000, memoryBytes: totalmem() });
} else if (action === "policy") {
	const policy = parseLxdOfficePhysicalPolicy(JSON.parse(await readFile(process.argv[3], "utf8")));
	report({ policySha256: lxdOfficePhysicalPolicySha256(policy) });
} else if (action === "review") {
	const request = JSON.parse(await readFile(process.argv[3], "utf8"));
	assert.equal(request.observation.inventory.entries.length, 1, "Only a freshly created, empty export is eligible for automatic acceptance review");
	const input = { schema: "qorpera.lxd-office-adoption-input/v1", adoptionId: randomUUID(),
		shared: { workbench: null, desktopHome: null, company: null }, legacy: null, quarantine: [] };
	const plan = planLxdOfficeAdoption(input, request.binding, request.observation);
	const observationSha256 = officeDigest(request.observation), planSha256 = officeDigest(plan);
	const maintenance = { schema: "qorpera.lxd-office-storage-maintenance/v1", state: "exclusive_writers_confirmed",
		hostBootId: request.observation.hostBootId, providerBindingSha256: request.observation.providerBindingSha256, observationSha256, planSha256 };
	const maintenanceBytes = `${JSON.stringify(maintenance)}\n`;
	report({ input, plan, maintenanceBytes, providerBindingSha256: lxdOfficeProviderBindingSha256(request.binding),
		review: { schema: "qorpera.lxd-office-storage-review/v1", reviewId: randomUUID(), decision: "initialize_empty", observationSha256, planSha256,
			writerFence: { state: "exclusive_writers_confirmed", evidenceSha256: createHash("sha256").update(maintenanceBytes).digest("hex") } } });
} else throw new Error("Unknown office lifecycle acceptance action");
