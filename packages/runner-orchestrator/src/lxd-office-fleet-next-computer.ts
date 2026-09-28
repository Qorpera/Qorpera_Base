import { createHash } from "node:crypto";
import { parseOfficeFleetServiceConfig } from "./lxd-office-fleet-service.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";
import { parseLxdOfficePassthroughConfig } from "./lxd-office-passthrough.ts";
import {
	type LxdOfficePhysicalPolicy,
	lxdOfficePhysicalPolicySha256,
	officePhysicalPath,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What the operator reads from the host and the registry for a company's next
 * Company Computer. The template is the company's computer already installed on
 * this host: the same image, company account (workbench uid/gid), project,
 * network, pool, size, registry endpoint and credential. */
export interface OfficeNextComputerInput {
	template: { policy: unknown; service: unknown; passthrough?: unknown };
	/** The new computer, from `qorpera_runtime_office_setup_queue`, and a new provider id. */
	office: { providerId: string; companyComputerId: string; logicalComputerId: string; computerGeneration: number };
	host: {
		nodeId: string;
		/** A new root-protected directory for this computer's documents. */
		configRoot: string;
		/** A new NFS mount of a new NAS directory: one writer per working folder. */
		workbench: { mountPoint: string; source: string };
		/** A new directory on the template's local journal filesystem. */
		journalPath: string;
		/** New host ports, when the template carries its own passthrough. */
		ports?: { viewer: number; native: number };
	};
}
export interface OfficeNextComputerPlan {
	schema: "qorpera.office-next-computer-plan/v1";
	/** Exact bytes to publish as root-owned 0444 files; the fleet document binds the service bytes. */
	files: { path: string; text: string; sha256: string }[];
	/** Arguments of qorpera_enroll_runtime_node_provider; CPU and memory are the template's enrolled cost. */
	enrollment: {
		nodeId: string;
		machineIdSha256: string;
		providerKind: "office";
		providerId: string;
		policySha256: string;
	};
	/** Root steps this plan does not perform, in order. */
	steps: string[];
}

const text = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const beneath = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Derives the host documents of a company's next Company Computer from the
 * company's computer already installed on the same host. Pure: it reads no
 * file, mints no credential and changes nothing. Every output passes the same
 * parsers the provider uses, and every per-computer identity differs from the
 * template's (provider, computer, workbench folder, journal, ports), so the new
 * computer can never become a second writer of the first one's state. */
export function planOfficeNextComputer(input: OfficeNextComputerInput): OfficeNextComputerPlan {
	const template = parseLxdOfficePhysicalPolicy(input.template.policy);
	const service = parseLxdOfficeLifecycleServiceConfig(input.template.service);
	const office = officeRecord(input.office, [
		"providerId",
		"companyComputerId",
		"logicalComputerId",
		"computerGeneration",
	]);
	const host = officeRecord(input.host, [
		"nodeId",
		"configRoot",
		"workbench",
		"journalPath",
		...(input.host && Object.hasOwn(input.host, "ports") ? ["ports"] : []),
	]);
	const workbench = officeRecord(host.workbench, ["mountPoint", "source"]);
	for (const value of [office.providerId, office.companyComputerId, office.logicalComputerId, host.nodeId])
		if (typeof value !== "string" || !UUID.test(value)) throw new Error("OFFICE_NEXT_COMPUTER_IDENTITY_INVALID");
	if (!Number.isSafeInteger(office.computerGeneration) || (office.computerGeneration as number) < 1)
		throw new Error("OFFICE_NEXT_COMPUTER_IDENTITY_INVALID");
	const configRoot = officePhysicalPath(host.configRoot);
	const journalPath = officePhysicalPath(host.journalPath);
	const mountPoint = officePhysicalPath(workbench.mountPoint);
	if (
		office.providerId === template.guest.providerId ||
		office.companyComputerId === template.guest.companyComputerId ||
		office.logicalComputerId === template.guest.logicalComputerId ||
		mountPoint === template.workbench.mountPoint ||
		workbench.source === template.workbench.source ||
		beneath(mountPoint, template.workbench.mountPoint) ||
		beneath(template.workbench.mountPoint, mountPoint) ||
		!beneath(journalPath, template.journal.mountPoint) ||
		beneath(journalPath, template.journal.path) ||
		beneath(template.journal.path, journalPath) ||
		[template.journal.mountPoint, mountPoint, template.workbench.mountPoint].some(
			(root) => beneath(configRoot, root) || beneath(root, configRoot),
		)
	)
		throw new Error("OFFICE_NEXT_COMPUTER_SHARES_TEMPLATE_STATE");
	const policy: LxdOfficePhysicalPolicy = {
		...template,
		guest: {
			...template.guest,
			providerId: office.providerId as string,
			companyComputerId: office.companyComputerId as string,
			logicalComputerId: office.logicalComputerId as string,
			computerGeneration: office.computerGeneration as number,
			workbenchSource: mountPoint,
		},
		workbench: { ...template.workbench, mountPoint, source: workbench.source as string },
		journal: { ...template.journal, path: journalPath },
	};
	const policySha256 = lxdOfficePhysicalPolicySha256(policy);
	const paths = {
		policy: `${configRoot}/policy.json`,
		provenance: `${configRoot}/provenance.json`,
		plan: `${configRoot}/plan.json`,
		service: `${configRoot}/service.json`,
		passthrough: `${configRoot}/passthrough.json`,
		fleet: `${configRoot}/fleet.json`,
	};
	const files: OfficeNextComputerPlan["files"] = [];
	const publish = (path: string, value: unknown) => {
		const bytes = text(value);
		files.push({ path, text: bytes, sha256: sha(bytes) });
		return bytes;
	};
	publish(paths.policy, parseLxdOfficePhysicalPolicy(policy));
	let passthrough: unknown;
	if (service.passthroughPath !== undefined) {
		const current = officeRecord(input.template.passthrough, [
			"schema",
			"listenHost",
			"viewer",
			"native",
			"allowedClients",
		]);
		const parsed = parseLxdOfficePassthroughConfig(current);
		const ports = officeRecord(host.ports, ["viewer", "native"]);
		const used = new Set(parsed.lanes.flatMap((lane) => [lane.listenPort]));
		if (used.has(ports.viewer as number) || used.has(ports.native as number))
			throw new Error("OFFICE_NEXT_COMPUTER_SHARES_TEMPLATE_STATE");
		passthrough = {
			...current,
			viewer: { ...(current.viewer as object), listenPort: ports.viewer },
			native: { ...(current.native as object), listenPort: ports.native },
		};
		parseLxdOfficePassthroughConfig(passthrough);
		publish(paths.passthrough, passthrough);
	} else if (input.template.passthrough !== undefined || host.ports !== undefined)
		throw new Error("OFFICE_NEXT_COMPUTER_PASSTHROUGH_UNEXPECTED");
	// The template's software, reset and package lanes name its own revision
	// history; the new computer starts from the image and gets its own later.
	const serviceDocument = {
		schema: "qorpera.lxd-office-provider-service/v1",
		policyPath: paths.policy,
		provenancePath: paths.provenance,
		planPath: paths.plan,
		registryUrl: service.registryUrl,
		registryCredential: service.registryCredential,
		inventoryLimits: (input.template.service as Record<string, unknown>).inventoryLimits,
		pollIntervalMs: service.pollIntervalMs,
		idleMs: service.idleMs,
		...(passthrough === undefined ? {} : { passthroughPath: paths.passthrough }),
	};
	parseLxdOfficeLifecycleServiceConfig(serviceDocument);
	const serviceBytes = publish(paths.service, serviceDocument);
	const fleet = {
		schema: "qorpera.office-fleet-service/v1",
		nodeId: host.nodeId,
		servicePath: paths.service,
		serviceConfigSha256: sha(serviceBytes),
	};
	parseOfficeFleetServiceConfig(fleet);
	publish(paths.fleet, fleet);
	const instance = `${office.companyComputerId}-g${office.computerGeneration}`;
	return {
		schema: "qorpera.office-next-computer-plan/v1",
		files,
		enrollment: {
			nodeId: host.nodeId as string,
			machineIdSha256: template.host.machineIdSha256,
			providerKind: "office",
			providerId: office.providerId as string,
			policySha256,
		},
		steps: [
			`On the NAS, create the new working folder for ${workbench.source}, owned by uid ${template.workbench.uid} and gid ${template.workbench.gid}, mode 0700. Never reuse the template's folder.`,
			`Mount it at ${mountPoint} (${template.workbench.filesystem}, hard mount) the same way as ${template.workbench.mountPoint}.`,
			`Create ${journalPath} (owner ${template.workbench.uid}:${template.workbench.gid}, 0700) and an empty ${journalPath}/adoption.lock (0600).`,
			`Create ${configRoot} (root, 0755) and publish the files of this plan byte for byte (root, 0444).`,
			`Copy the template's provenance document to ${paths.provenance}: the image is the same.`,
			`Enroll the provider with qorpera_enroll_runtime_node_provider and the enrollment arguments of this plan, plus the template provider's enrolled CPU and memory.`,
			`Install the fleet units: node qorpera-office-fleet-install.cjs ${paths.fleet} <binary> <binary sha256> <registry CA>.`,
			passthrough === undefined
				? "The template has no passthrough: route this computer's viewer and native ports the same way as the template's."
				: `Route /office/${office.companyComputerId}/view and /native on the web mux to this host's ports ${(host.ports as { viewer: number }).viewer} and ${(host.ports as { native: number }).native}.`,
			`When the computer's start intent exists, start qorpera-office-fleet-stage-${instance}.service, then enable and start qorpera-office-fleet-${instance}.service.`,
			"The new working folder is empty, so its adoption review has nothing to carry over: write the plan's adoption input with shared workbench, desktop and company set to null (layout 2), legacy null and no quarantine.",
			"Sign-ins are kept in step only between computers that see the same company directory: until the company share is mounted, this computer keeps its own sign-ins.",
		],
	};
}
