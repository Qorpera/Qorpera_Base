import { officeImagePublicKey, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officeInstallHash } from "./lxd-office-installation.ts";
import { officeInstallLockFd, readOfficeInstallFile } from "./lxd-office-installation-host.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";
import { type NodeUpdateEnrollment, RuntimeNodeUpdateController } from "./runtime-node-update.ts";
import { LinuxNodeUpdatePhysicalPorts, parseNodeUpdateHostEnrollment } from "./runtime-node-update-host.ts";
import { sealNodeUpdateCompletion, selectNodeUpdateJournal } from "./runtime-node-update-journals.ts";
import { createNodeUpdateRegistryPorts } from "./runtime-node-update-ports.ts";
import { RuntimeNodeUpdateRegistry } from "./runtime-node-update-registry.ts";

export function parseNodeUpdateServiceConfig(value: unknown) {
	const c = officeRecord(value, ["schema", "host", "registry", "baseline", "updaterSha256"]),
		b = officeRecord(c.baseline, [
			"nodeId",
			"machineIdSha256",
			"publicKey",
			"previousRevision",
			"previousReleaseSha256",
			"previousArtifactSha256",
		]),
		r = officeRecord(c.registry, ["origin", "publicApiKey", "capability", "capabilityRevision"]);
	if (
		c.schema !== "qorpera.node-update-service/v1" ||
		typeof b.nodeId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.nodeId) ||
		typeof b.publicKey !== "string" ||
		!Number.isSafeInteger(b.previousRevision) ||
		(b.previousRevision as number) < 0 ||
		(b.previousRevision as number) >= Number.MAX_SAFE_INTEGER - 1 ||
		typeof r.origin !== "string" ||
		typeof r.publicApiKey !== "string" ||
		!Number.isSafeInteger(r.capabilityRevision) ||
		(r.capabilityRevision as number) < 1
	)
		throw new Error("NODE_UPDATE_SERVICE_CONFIG_INVALID");
	officeImagePublicKey(b.publicKey);
	const baseline: NodeUpdateEnrollment = {
			nodeId: b.nodeId,
			machineIdSha256: officeSha(b.machineIdSha256),
			publicKey: b.publicKey,
			previousRevision: b.previousRevision as number,
			previousReleaseSha256: officeSha(b.previousReleaseSha256),
			previousArtifactSha256: officeSha(b.previousArtifactSha256),
		},
		host = parseNodeUpdateHostEnrollment(c.host),
		registry = {
			origin: r.origin,
			publicApiKey: r.publicApiKey,
			capability: officeSha(r.capability),
			capabilityRevision: r.capabilityRevision as number,
		};
	if (baseline.machineIdSha256 !== host.machineIdSha256) throw new Error("NODE_UPDATE_SERVICE_HOST_DIFFERS");
	// Validate the closed credential/origin contract without making a request.
	new RuntimeNodeUpdateRegistry({ ...registry, enrollment: baseline });
	return { host, baseline, registry, updaterSha256: officeSha(c.updaterSha256) };
}

export async function runNodeUpdateOnce(configPath: string, signal: AbortSignal): Promise<unknown> {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getegid?.() !== 0 ||
		configPath !== "/etc/qorpera/node-updater/service.json" ||
		process.argv[1] !== "/opt/qorpera/node-updater/qorpera-node-updater.cjs"
	)
		throw new Error("NODE_UPDATE_ENROLLED_ROOT_SERVICE_REQUIRED");
	const bytes = await readOfficeInstallFile(configPath, 65536, true);
	try {
		const config = parseNodeUpdateServiceConfig(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
		if (officeInstallHash(await readOfficeInstallFile(process.argv[1], 64 * 1024 ** 2)) !== config.updaterSha256)
			throw new Error("NODE_UPDATE_SERVICE_EXECUTABLE_CHANGED");
		await checkDirectory(config.host.journalRoot);
		await officeInstallLockFd(config.host.lockPath, 0);
		const selected = await selectNodeUpdateJournal(
			config.host.journalRoot,
			config.baseline,
			async (enrollment, checked) =>
				(await new RuntimeNodeUpdateRegistry({ ...config.registry, enrollment }).desired(checked))?.envelope ??
				null,
			signal,
		);
		if (!selected) return { state: "idle" };
		const registry = new RuntimeNodeUpdateRegistry({ ...config.registry, enrollment: selected.enrollment }),
			physical = new LinuxNodeUpdatePhysicalPorts(config.host, selected.root, registry),
			ports = createNodeUpdateRegistryPorts(registry, physical),
			result = await new RuntimeNodeUpdateController(
				selected.root,
				selected.envelope,
				selected.enrollment,
				ports,
			).reconcile(signal);
		if (result.state === "completed")
			await sealNodeUpdateCompletion(selected.root, selected.envelope, selected.enrollment, signal);
		return { ...result, revision: selected.release.revision };
	} finally {
		bytes.fill(0);
	}
}
