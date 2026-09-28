import { createHash } from "node:crypto";
import { dirname } from "node:path";
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
const SHA256 = /^[0-9a-f]{64}$/;

/** One office installed on this host, as the operator read it: its service
 * document (and where it lives), and the policy and passthrough it names. */
export interface OfficeInstalledDocuments {
	servicePath: string;
	service: unknown;
	policy: unknown;
	passthrough?: unknown;
}
/** What the operator reads from the host and the registry for a company's next
 * Company Computer. The template is the company's computer already installed on
 * this host: the same image, company account (workbench uid/gid), project,
 * network, pool, size, registry endpoint and provider credential. */
export interface OfficeNextComputerInput {
	template: OfficeInstalledDocuments;
	/** Every other office installed on this host, of any company: nothing may collide with them either. */
	others: OfficeInstalledDocuments[];
	/** The new computer, from `qorpera_runtime_office_setup_queue`, and a new provider id. */
	office: {
		providerId: string;
		companyComputerId: string;
		logicalComputerId: string;
		computerGeneration: number;
		imageSha256: string;
		bootstrapSha256: string;
	};
	host: {
		nodeId: string;
		/** A new root-protected directory for this computer's documents. */
		configRoot: string;
		/** A new NFS mount of a new folder on the template's NAS: one writer per working folder. */
		workbench: { mountPoint: string; source: string };
		/** A new directory on the template's local journal filesystem. */
		journalPath: string;
		/** New host ports, when the template carries its own passthrough. */
		ports?: { viewer: number; native: number };
		/** A new id for the computer's first adoption. */
		adoptionId: string;
		/** The template's guest layout (2 when its adoption input names `company`). */
		layout: 1 | 2;
	};
}
export interface OfficeNextComputerPlan {
	schema: "qorpera.office-next-computer-plan/v1";
	/** Exact bytes to publish as root-owned 0444 files; the fleet document binds the service bytes. */
	files: { path: string; text: string; sha256: string }[];
	/** Arguments of qorpera_enroll_runtime_node_provider. Enrollment is immutable: check them twice. */
	enrollment: {
		nodeId: string;
		machineIdSha256: string;
		providerKind: "office";
		providerId: string;
		policySha256: string;
		cpuMillis: number;
		memoryBytes: number;
	};
	/** The lifecycle plan the provider asks for at review; intent and observation come from it. */
	lifecyclePlan: {
		path: string;
		input: Record<string, unknown>;
		reviewPath: string;
		writerFencePath: string;
		serviceBootstrapPath: string;
	};
	/** Root steps this plan does not perform, in order. */
	steps: string[];
}

const text = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const beneath = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const nested = (a: string, b: string) => beneath(a, b) || beneath(b, a);
function refuse(code: string): never {
	throw new Error(code);
}
/** An NFS source `server:/export/path`, its path normalized for nesting checks. */
function nfsSource(value: unknown): { server: string; path: string } {
	if (typeof value !== "string") refuse("OFFICE_NEXT_COMPUTER_WORKBENCH_INVALID");
	const at = value.indexOf(":/");
	if (at < 1) refuse("OFFICE_NEXT_COMPUTER_WORKBENCH_INVALID");
	const parts = value
		.slice(at + 2)
		.split("/")
		.filter(Boolean);
	if (!parts.length || parts.some((part) => part === "." || part === ".."))
		refuse("OFFICE_NEXT_COMPUTER_WORKBENCH_INVALID");
	return { server: value.slice(0, at), path: `/${parts.join("/")}` };
}
function installed(value: OfficeInstalledDocuments) {
	const record = officeRecord(value, [
		"servicePath",
		"service",
		"policy",
		...(value && Object.hasOwn(value, "passthrough") ? ["passthrough"] : []),
	]);
	const service = parseLxdOfficeLifecycleServiceConfig(record.service);
	const policy = parseLxdOfficePhysicalPolicy(record.policy);
	const passthrough =
		service.passthroughPath === undefined ? undefined : parseLxdOfficePassthroughConfig(record.passthrough);
	const paths = [
		officePhysicalPath(record.servicePath),
		service.policyPath,
		service.provenancePath,
		service.planPath,
		service.passthroughPath,
		service.softwareLanePath,
		service.codePackageLanePath,
	].filter((path): path is string => path !== undefined);
	return { service, policy, passthrough, paths, raw: record };
}

/** Derives the host documents of a company's next Company Computer from the
 * company's computer already installed on the same host. Pure: it reads no
 * file, mints no credential and changes nothing. Every output passes the same
 * parsers the provider uses. Nothing per computer is shared with any office on
 * the host (provider, computer, NAS folder, mount, journal, documents, ports),
 * so the new computer can never become a second writer of another's state. */
export function planOfficeNextComputer(input: OfficeNextComputerInput): OfficeNextComputerPlan {
	const template = installed(input.template);
	if (!Array.isArray(input.others)) refuse("OFFICE_NEXT_COMPUTER_HOST_UNKNOWN");
	const everyOffice = [template, ...input.others.map(installed)];
	const office = officeRecord(input.office, [
		"providerId",
		"companyComputerId",
		"logicalComputerId",
		"computerGeneration",
		"imageSha256",
		"bootstrapSha256",
	]);
	const host = officeRecord(input.host, [
		"nodeId",
		"configRoot",
		"workbench",
		"journalPath",
		"adoptionId",
		"layout",
		...(input.host && Object.hasOwn(input.host, "ports") ? ["ports"] : []),
	]);
	const workbench = officeRecord(host.workbench, ["mountPoint", "source"]);
	for (const value of [
		office.providerId,
		office.companyComputerId,
		office.logicalComputerId,
		host.nodeId,
		host.adoptionId,
	])
		if (typeof value !== "string" || !UUID.test(value)) refuse("OFFICE_NEXT_COMPUTER_IDENTITY_INVALID");
	if (
		!Number.isSafeInteger(office.computerGeneration) ||
		(office.computerGeneration as number) < 1 ||
		(host.layout !== 1 && host.layout !== 2)
	)
		refuse("OFFICE_NEXT_COMPUTER_IDENTITY_INVALID");
	// The database copies image and bootstrap from the company's newest computer:
	// a template on another image would only fail at the fleet offer, after setup.
	if (
		typeof office.imageSha256 !== "string" ||
		!SHA256.test(office.imageSha256) ||
		office.imageSha256 !== template.policy.guest.imageFingerprint ||
		office.bootstrapSha256 !== template.policy.guest.bootstrapSha256
	)
		refuse("OFFICE_NEXT_COMPUTER_IMAGE_DIFFERS");
	const configRoot = officePhysicalPath(host.configRoot);
	const journalPath = officePhysicalPath(host.journalPath);
	const mountPoint = officePhysicalPath(workbench.mountPoint);
	const source = nfsSource(workbench.source);
	// The template's NAS: the policy keeps its server address for the mount check.
	if (source.server !== nfsSource(template.policy.workbench.source).server)
		refuse("OFFICE_NEXT_COMPUTER_WORKBENCH_INVALID");
	if (!beneath(journalPath, template.policy.journal.mountPoint) || journalPath === template.policy.journal.mountPoint)
		refuse("OFFICE_NEXT_COMPUTER_JOURNAL_INVALID");
	if (nested(configRoot, mountPoint) || nested(configRoot, journalPath))
		refuse("OFFICE_NEXT_COMPUTER_DOCUMENTS_TAKEN");
	for (const other of everyOffice) {
		const guest = other.policy.guest;
		const otherSource = nfsSource(other.policy.workbench.source);
		if (
			office.providerId === guest.providerId ||
			office.companyComputerId === guest.companyComputerId ||
			office.logicalComputerId === guest.logicalComputerId
		)
			refuse("OFFICE_NEXT_COMPUTER_IDENTITY_TAKEN");
		if (
			nested(mountPoint, other.policy.workbench.mountPoint) ||
			(otherSource.server === source.server && nested(source.path, otherSource.path))
		)
			refuse("OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN");
		if (nested(journalPath, other.policy.journal.path)) refuse("OFFICE_NEXT_COMPUTER_JOURNAL_TAKEN");
		if (
			[
				other.policy.journal.path,
				other.policy.workbench.mountPoint,
				...other.paths,
				...other.paths.map((path) => dirname(path)),
			].some((path) => nested(configRoot, path))
		)
			refuse("OFFICE_NEXT_COMPUTER_DOCUMENTS_TAKEN");
	}
	const policy: LxdOfficePhysicalPolicy = {
		...template.policy,
		guest: {
			...template.policy.guest,
			providerId: office.providerId as string,
			companyComputerId: office.companyComputerId as string,
			logicalComputerId: office.logicalComputerId as string,
			computerGeneration: office.computerGeneration as number,
			workbenchSource: mountPoint,
		},
		workbench: { ...template.policy.workbench, mountPoint, source: workbench.source as string },
		journal: { ...template.policy.journal, path: journalPath },
	};
	const policySha256 = lxdOfficePhysicalPolicySha256(policy);
	const paths = {
		policy: `${configRoot}/policy.json`,
		provenance: `${configRoot}/provenance.json`,
		plan: `${configRoot}/plan.json`,
		service: `${configRoot}/service.json`,
		passthrough: `${configRoot}/passthrough.json`,
		fleet: `${configRoot}/fleet.json`,
		review: `${configRoot}/review.json`,
		writerFence: `${configRoot}/writer-fence.json`,
		bootstrap: `${configRoot}/service-bootstrap.json`,
	};
	const files: OfficeNextComputerPlan["files"] = [];
	const publish = (path: string, value: unknown) => {
		const bytes = text(value);
		files.push({ path, text: bytes, sha256: sha(bytes) });
		return bytes;
	};
	publish(paths.policy, parseLxdOfficePhysicalPolicy(policy));
	let passthrough: Record<string, unknown> | undefined;
	if (template.passthrough !== undefined) {
		const ports = officeRecord(host.ports, ["viewer", "native"]);
		const used = new Set(
			everyOffice.flatMap((other) => other.passthrough?.lanes.map((lane) => lane.listenPort) ?? []),
		);
		if (used.has(ports.viewer as number) || used.has(ports.native as number))
			refuse("OFFICE_NEXT_COMPUTER_PORT_TAKEN");
		const current = template.raw.passthrough as Record<string, unknown>;
		passthrough = {
			...current,
			viewer: { ...(current.viewer as object), listenPort: ports.viewer },
			native: { ...(current.native as object), listenPort: ports.native },
		};
		parseLxdOfficePassthroughConfig(passthrough);
		publish(paths.passthrough, passthrough);
	} else if (host.ports !== undefined) refuse("OFFICE_NEXT_COMPUTER_PASSTHROUGH_UNEXPECTED");
	// The template's software and package lanes name its own revision history;
	// the reset image manifest belongs to the image, which is the same.
	const serviceDocument = {
		schema: "qorpera.lxd-office-provider-service/v1",
		policyPath: paths.policy,
		provenancePath: paths.provenance,
		planPath: paths.plan,
		registryUrl: template.service.registryUrl,
		registryCredential: template.service.registryCredential,
		inventoryLimits: (template.raw.service as Record<string, unknown>).inventoryLimits,
		pollIntervalMs: template.service.pollIntervalMs,
		idleMs: template.service.idleMs,
		...(template.service.resetImagePackageManifestPath === undefined
			? {}
			: { resetImagePackageManifestPath: template.service.resetImagePackageManifestPath }),
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
	const owner = `${template.policy.workbench.uid}:${template.policy.workbench.gid}`;
	const ports = host.ports as { viewer: number; native: number } | undefined;
	return {
		schema: "qorpera.office-next-computer-plan/v1",
		files,
		enrollment: {
			nodeId: host.nodeId as string,
			machineIdSha256: template.policy.host.machineIdSha256,
			providerKind: "office",
			providerId: office.providerId as string,
			policySha256,
			cpuMillis: template.policy.guest.cpus * 1000,
			memoryBytes: template.policy.guest.memoryBytes,
		},
		lifecyclePlan: {
			path: paths.plan,
			// The new working folder is empty: nothing is carried over or quarantined.
			input: {
				schema: "qorpera.lxd-office-adoption-input/v1",
				adoptionId: host.adoptionId,
				shared: { workbench: null, desktopHome: null, ...(host.layout === 2 ? { company: null } : {}) },
				legacy: null,
				quarantine: [],
			},
			reviewPath: paths.review,
			writerFencePath: paths.writerFence,
			serviceBootstrapPath: paths.bootstrap,
		},
		steps: [
			`NAS: create the new working folder ${workbench.source}, owned by ${owner}, mode 0700. It is not inside, and does not contain, any office's folder.`,
			`Mount it at ${mountPoint} (${template.policy.workbench.filesystem}, hard, persistent in fstab: the units require the mount) with the template's options.`,
			`Journal: create ${journalPath} (${owner}, 0700) and an empty ${journalPath}/adoption.lock (${owner}, 0600, one link).`,
			`Create ${configRoot} (root, 0755) and publish the files of this plan byte for byte (root, 0444); check each sha256.`,
			`Copy the template's provenance document to ${paths.provenance}: the image is the same.`,
			"Enroll the provider with qorpera_enroll_runtime_node_provider and this plan's enrollment arguments. Enrollment cannot be changed afterwards.",
			`Install the fleet units: node qorpera-office-fleet-install.cjs ${paths.fleet} <binary> <binary sha256> <registry CA>.`,
			ports === undefined
				? "The template has no passthrough: route this computer's viewer and native ports the same way as the template's."
				: `Web mux: route /office/${office.companyComputerId}/view and /office/${office.companyComputerId}/native to this host's ports ${ports.viewer} and ${ports.native}, pinning this computer's own TLS certificate.`,
			`Enable qorpera-office-fleet-${instance}.service: it waits for the computer's start intent (a spare waits until someone starts it). Once the intent exists, run qorpera-office-fleet-stage-${instance}.service on each candidate host.`,
			`At review, write ${paths.plan} with the intent and observation from the provider's status and this plan's adoption input (layout ${host.layout}, like the template), ${paths.writerFence} (this host is the only writer of the new folder) and ${paths.review}.`,
			`Service bootstrap ${paths.bootstrap}: copy the template's endpoints, listener ports, origins and time zone. Mint for this computer its own TLS certificate and key, guest registry credential and objects token; never copy the template's TLS key. Native token: the company route's token when the company uses /office/{companyComputerId}/native, otherwise a new token with its own route entry.`,
			"Before members use it, bring the computer to the template's office software revision: the image may lack guest-code fixes the template received later.",
			"Sign-ins are kept in step only between computers that see the same company directory; until that directory is shared, this computer keeps its own.",
		],
	};
}
