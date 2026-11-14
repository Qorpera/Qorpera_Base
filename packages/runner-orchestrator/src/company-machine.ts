import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AGENT_BRIDGE, agentPlugCard, isAgentPlugCard } from "./agent-plug.ts";
import type { CodingMachineIntent, CodingMachineJournalPlan } from "./coding-machine.ts";
import type { LxdCreateInstanceRequest, LxdInstanceRecord } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const GiB = 1024 ** 3;

/** One placement of a company machine (2026-09-28): the VM an agent started
 * for a job, of the size it asked for, from the node's reviewed machine image.
 * The machine is the company's record; this is where it runs now, disposable
 * (Stateless Compute: a machine that wakes where there is no room starts
 * fresh as a new placement elsewhere). SQL placed it
 * (qorpera_place_company_machine) on this executor's node and fixed this
 * binding; nothing in it is chosen by the model except the size. No
 * credential, identity volume or disk of the node is attached: a test machine
 * sees the company folder through its folder service (6d), and a coding
 * session's work is in that folder. v2 (6e-1) dropped v1's read-only
 * repository disk. */
export interface LxdCompanyMachineBinding {
	schema: "qorpera.lxd-company-machine/v2";
	machineId: string;
	/** The placement's id: its node allocation, LXD name and journal. */
	placementId: string;
	companyId: string;
	environmentId: string;
	providerId: string;
	providerPolicySha256: string;
	project: string;
	imageFingerprint: string;
	bootstrapSha256: string;
	storagePool: string;
	network: string;
	cpus: number;
	memoryBytes: number;
	rootDiskBytes: number;
}
/** The canonical key order SQL hashes (qorpera_company_machine_binding_text). */
export const COMPANY_MACHINE_KEYS = [
	"schema",
	"machineId",
	"placementId",
	"companyId",
	"environmentId",
	"providerId",
	"providerPolicySha256",
	"project",
	"imageFingerprint",
	"bootstrapSha256",
	"storagePool",
	"network",
	"cpus",
	"memoryBytes",
	"rootDiskBytes",
] as const;
/** The node policy an executor makes machines with; SQL copies it into every binding. */
export type CompanyMachinePolicy = Pick<
	LxdCompanyMachineBinding,
	| "providerId"
	| "providerPolicySha256"
	| "project"
	| "imageFingerprint"
	| "bootstrapSha256"
	| "storagePool"
	| "network"
>;
export const COMPANY_MACHINE_POLICY_KEYS = [
	"providerId",
	"providerPolicySha256",
	"project",
	"imageFingerprint",
	"bootstrapSha256",
	"storagePool",
	"network",
] as const;
export function parseCompanyMachinePolicy(value: unknown): Readonly<CompanyMachinePolicy> {
	const input = value as Record<string, unknown>;
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).sort().join() !== [...COMPANY_MACHINE_POLICY_KEYS].sort().join() ||
		typeof input.providerId !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.providerId) ||
		![input.providerPolicySha256, input.imageFingerprint, input.bootstrapSha256].every(
			(sha) => typeof sha === "string" && SHA.test(sha),
		) ||
		![input.project, input.storagePool, input.network].every((name) => typeof name === "string" && NAME.test(name)) ||
		// An agent road machine: its only card is on the agents' bridge (deploy/agent-exit).
		input.network !== AGENT_BRIDGE
	)
		throw new Error("INVALID_COMPANY_MACHINE_POLICY");
	return Object.freeze(
		Object.fromEntries(COMPANY_MACHINE_POLICY_KEYS.map((key) => [key, input[key]])),
	) as unknown as CompanyMachinePolicy;
}

export function lxdCompanyMachineName(placementId: string): string {
	if (!UUID.test(placementId)) throw new Error("INVALID_COMPANY_MACHINE_BINDING");
	return `qorpera-machine-${placementId.replaceAll("-", "")}`;
}

/** The binding in its canonical order, its exact text and digest (what SQL
 * pinned) and the LXD request that creates it. */
export function lxdCompanyMachinePlan(value: LxdCompanyMachineBinding): {
	binding: Readonly<LxdCompanyMachineBinding>;
	text: string;
	instanceSha256: string;
	request: LxdCreateInstanceRequest;
} {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...COMPANY_MACHINE_KEYS].sort().join() ||
		value.schema !== "qorpera.lxd-company-machine/v2" ||
		![value.machineId, value.placementId, value.companyId, value.environmentId].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		![value.cpus, value.memoryBytes, value.rootDiskBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
		value.cpus > 64 ||
		value.memoryBytes < GiB ||
		value.memoryBytes > 1024 * GiB ||
		value.memoryBytes % GiB !== 0 ||
		value.rootDiskBytes < 10 * GiB ||
		value.rootDiskBytes > 2048 * GiB ||
		value.rootDiskBytes % GiB !== 0
	)
		throw new Error("INVALID_COMPANY_MACHINE_BINDING");
	parseCompanyMachinePolicy(Object.fromEntries(COMPANY_MACHINE_POLICY_KEYS.map((key) => [key, value[key]])));
	const binding = Object.freeze(
		Object.fromEntries(COMPANY_MACHINE_KEYS.map((key) => [key, value[key]])) as unknown as LxdCompanyMachineBinding,
	);
	const text = JSON.stringify(binding);
	const instanceSha256 = createHash("sha256").update(text).digest("hex");
	return { binding, text, instanceSha256, request: companyMachineRequest(binding, instanceSha256) };
}

/** How one executor release makes a placement's LXD request from its binding and the binding's digest. */
export type CompanyMachineRequestShape = (
	binding: Readonly<LxdCompanyMachineBinding>,
	instanceSha256: string,
) => LxdCreateInstanceRequest;

/** The request shapes of earlier executor releases, newest first. A placement's instance lives for months (a sleeping
 * machine keeps its disk and its instance across releases and machine images), and a run takes an instance only as one
 * of these or the current shape made it from the same binding. A release that changes the shape adds the shape as it
 * was here, written out as it stood (never derived from the current one). Empty: the shape has not changed since this
 * list began. */
export const EARLIER_COMPANY_MACHINE_REQUESTS: readonly CompanyMachineRequestShape[] = [];

/** The current shape. Its name and its user.qorpera.placement_id and user.qorpera.instance_sha256 markers never change
 * from one shape to the next: a stop and a delete know the placement's instance by them alone. */
function companyMachineRequest(
	binding: Readonly<LxdCompanyMachineBinding>,
	instanceSha256: string,
): LxdCreateInstanceRequest {
	return {
		name: lxdCompanyMachineName(binding.placementId),
		type: "virtual-machine",
		profiles: [],
		source: { type: "image", fingerprint: binding.imageFingerprint },
		config: {
			"boot.mode": "uefi-secureboot",
			"boot.autostart": "false",
			"limits.cpu": String(binding.cpus),
			"limits.memory": String(binding.memoryBytes),
			// /dev/lxd offers the guest nothing: no LXD API, no config, no metadata. The host starts every stream
			// into the machine; no pass or secret is ever in its config.
			"security.devlxd": "false",
			"user.qorpera.schema": binding.schema,
			"user.qorpera.machine_id": binding.machineId,
			"user.qorpera.placement_id": binding.placementId,
			"user.qorpera.allocation_id": binding.placementId,
			"user.qorpera.company_id": binding.companyId,
			"user.qorpera.environment_id": binding.environmentId,
			"user.qorpera.provider_id": binding.providerId,
			"user.qorpera.instance_sha256": instanceSha256,
			"user.qorpera.provider_policy_sha256": binding.providerPolicySha256,
			"user.qorpera.bootstrap_sha256": binding.bootstrapSha256,
		},
		devices: {
			root: { type: "disk", path: "/", pool: binding.storagePool, size: String(binding.rootDiskBytes) },
			// On the agents' bridge: machines never reach each other or pretend to be another machine (LXD's MAC
			// filter and port isolation, and the exit's bridge rules). Its MAC comes from the agent plug right before
			// the create (withAgentPlug).
			network: agentPlugCard("eth0"),
		},
	};
}

/** Whether the instance is this machine exactly: its name, configuration and devices, with nothing added; its agent
 * card carries a plug MAC. */
function isLxdCompanyMachineInstance(
	request: LxdCreateInstanceRequest,
	imageFingerprint: string,
	instance: LxdInstanceRecord,
): boolean {
	const { network, ...devices } = instance.devices;
	const { network: card, ...expected } = request.devices;
	return (
		instance.name === request.name &&
		instance.type === "virtual-machine" &&
		isDeepStrictEqual(instance.profiles, []) &&
		isAgentPlugCard(network, card) &&
		isDeepStrictEqual(devices, expected) &&
		isDeepStrictEqual(instance.devices, instance.expandedDevices) &&
		[instance.config, instance.expandedConfig].every(
			(config) =>
				config["volatile.base_image"] === imageFingerprint &&
				Object.entries(request.config).every(([key, value]) => config[key] === value) &&
				Object.keys(config).every(
					(key) => Object.hasOwn(request.config, key) || key.startsWith("image.") || key.startsWith("volatile."),
				),
		)
	);
}
/** The instance is this machine exactly (isLxdCompanyMachineInstance). */
export function assertLxdCompanyMachineInstance(
	request: LxdCreateInstanceRequest,
	imageFingerprint: string,
	instance: LxdInstanceRecord,
): void {
	if (!isLxdCompanyMachineInstance(request, imageFingerprint, instance)) throw new Error("COMPANY_MACHINE_DRIFTED");
}

/** The instance is this placement's own, whatever else about it differs from any shape: its name, and in its own and
 * its expanded configuration the markers that name the placement and the binding's digest. Only the executor writes
 * them (the guest has no /dev/lxd), and the digest pins the whole binding. Enough for a stop (a forced power-off) and a
 * delete (the instance and its own root disk): neither runs anything in the instance or keeps anything of it. */
export function assertLxdCompanyMachineIdentity(
	placementId: string,
	instanceSha256: string,
	instance: LxdInstanceRecord,
): void {
	if (
		instance.name !== lxdCompanyMachineName(placementId) ||
		instance.type !== "virtual-machine" ||
		![instance.config, instance.expandedConfig].every(
			(config) =>
				config["user.qorpera.placement_id"] === placementId &&
				config["user.qorpera.instance_sha256"] === instanceSha256,
		)
	)
		throw new Error("COMPANY_MACHINE_DRIFTED");
}

/** The coding machine's journaled lifecycle (reconcileCodingMachine) for a
 * company machine's placement: its own journal folder, request and instance
 * check. SQL's custody receipts name the placement. A stop or a delete checks
 * only that the instance is the placement's own; a run takes it only as the
 * current shape or one of `earlier` made it from this binding. */
export function lxdCompanyMachineJournalPlan(
	value: LxdCompanyMachineBinding,
	earlier: readonly CompanyMachineRequestShape[] = EARLIER_COMPANY_MACHINE_REQUESTS,
): CodingMachineJournalPlan & { readonly text: string } {
	const plan = lxdCompanyMachinePlan(value);
	const requests = [plan.request, ...earlier.map((shape) => shape(plan.binding, plan.instanceSha256))];
	return Object.freeze({
		machineId: plan.binding.placementId,
		instanceSha256: plan.instanceSha256,
		project: plan.binding.project,
		name: plan.request.name,
		journalName: plan.binding.placementId,
		binding: plan.binding,
		request: plan.request,
		agentPlug: {
			claim: {
				kind: "machine" as const,
				companyId: plan.binding.companyId,
				machineId: plan.binding.machineId,
				memberUserId: null,
				project: plan.binding.project,
				instance: plan.request.name,
			},
			device: "network",
		},
		// Scratch: LXD's view settles what the journal cannot (a poweroff inside, a node reboot, a failed create).
		disposable: true,
		text: plan.text,
		assertInstance: (instance: LxdInstanceRecord, intent: CodingMachineIntent) => {
			if (intent === "stop" || intent === "delete")
				assertLxdCompanyMachineIdentity(plan.binding.placementId, plan.instanceSha256, instance);
			else if (
				!requests.some((request) => isLxdCompanyMachineInstance(request, plan.binding.imageFingerprint, instance))
			)
				throw new Error("COMPANY_MACHINE_DRIFTED");
		},
	});
}
