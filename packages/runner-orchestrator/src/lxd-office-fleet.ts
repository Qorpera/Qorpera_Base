import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import {
	assertLxdOfficePhysicalBinding,
	type LxdOfficePhysicalPolicy,
	lxdOfficePhysicalPolicySha256,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type CompanyComputerScope = Pick<
	LxdOfficePhysicalPolicy["guest"],
	"companyId" | "environmentId" | "companyComputerId" | "logicalComputerId"
>;
export type OfficeFleetMethod =
	| "qorpera_runtime_office_fleet_status"
	| "qorpera_offer_runtime_office_fleet"
	| "qorpera_place_runtime_office_fleet";
export interface OfficeFleetRegistry {
	call(method: OfficeFleetMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface OfficeFleetOffer {
	schema: "qorpera.office-fleet-offer/v1";
	scope: CompanyComputerScope;
	computerGeneration: number;
	intentId: string;
	providerId: string;
	nodeId: string;
	policySha256: string;
	machineIdSha256: string;
	allocationId: string;
	instanceSha256: string;
	providerBindingSha256: string;
	imageSha256: string;
	bootstrapSha256: string;
	cpuMillis: number;
	memoryBytes: number;
	serviceConfigSha256: string;
}
export interface OfficeFleetStatus {
	schema: "qorpera.office-fleet-status/v1";
	scope: CompanyComputerScope;
	computerGeneration: number;
	intentId: string | null;
	state: "waiting" | "unplaced" | "placed" | "retained" | "held";
	offer: OfficeFleetOffer | null;
}
export function officeFleetScope(policy: LxdOfficePhysicalPolicy): CompanyComputerScope {
	const { companyId, environmentId, companyComputerId, logicalComputerId } = policy.guest;
	return { companyId, environmentId, companyComputerId, logicalComputerId };
}
export function parseOfficeFleetOffer(value: unknown): OfficeFleetOffer {
	const r = officeRecord(value, [
		"schema",
		"scope",
		"computerGeneration",
		"intentId",
		"providerId",
		"nodeId",
		"policySha256",
		"machineIdSha256",
		"allocationId",
		"instanceSha256",
		"providerBindingSha256",
		"imageSha256",
		"bootstrapSha256",
		"cpuMillis",
		"memoryBytes",
		"serviceConfigSha256",
	]);
	const scope = officeRecord(r.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
	if (
		r.schema !== "qorpera.office-fleet-offer/v1" ||
		![...Object.values(scope), r.intentId, r.providerId, r.nodeId, r.allocationId].every(
			(v) => typeof v === "string" && UUID.test(v),
		) ||
		![r.computerGeneration, r.cpuMillis, r.memoryBytes].every((v) => Number.isSafeInteger(v) && Number(v) > 0)
	)
		throw new Error("OFFICE_FLEET_OFFER_INVALID");
	for (const key of [
		"policySha256",
		"machineIdSha256",
		"instanceSha256",
		"providerBindingSha256",
		"imageSha256",
		"bootstrapSha256",
		"serviceConfigSha256",
	])
		officeSha(r[key]);
	return structuredClone(r) as unknown as OfficeFleetOffer;
}
export function parseOfficeFleetStatus(value: unknown, policy: LxdOfficePhysicalPolicy): OfficeFleetStatus {
	const r = officeRecord(value, ["schema", "scope", "computerGeneration", "intentId", "state", "offer"]);
	if (
		r.schema !== "qorpera.office-fleet-status/v1" ||
		!isDeepStrictEqual(r.scope, officeFleetScope(policy)) ||
		r.computerGeneration !== policy.guest.computerGeneration ||
		(r.intentId !== null && (typeof r.intentId !== "string" || !UUID.test(r.intentId))) ||
		!["waiting", "unplaced", "placed", "retained", "held"].includes(String(r.state))
	)
		throw new Error("OFFICE_FLEET_STATUS_INVALID");
	const offer = r.offer === null ? null : parseOfficeFleetOffer(r.offer);
	if (
		(r.state === "placed") !== (offer !== null) ||
		(r.state === "unplaced" && r.intentId === null) ||
		(offer &&
			(!isDeepStrictEqual(offer.scope, r.scope) ||
				offer.computerGeneration !== r.computerGeneration ||
				offer.intentId !== r.intentId))
	)
		throw new Error("OFFICE_FLEET_STATUS_INVALID");
	return { ...r, offer } as unknown as OfficeFleetStatus;
}

export function officeFleetOffer(
	policy: LxdOfficePhysicalPolicy,
	nodeId: string,
	serviceConfigSha256: string,
	identity: LxdOfficeCreationIdentity,
): OfficeFleetOffer {
	assertLxdOfficePhysicalBinding(policy, identity.binding);
	return parseOfficeFleetOffer({
		schema: "qorpera.office-fleet-offer/v1",
		scope: officeFleetScope(policy),
		computerGeneration: policy.guest.computerGeneration,
		intentId: identity.intentId,
		providerId: policy.guest.providerId,
		nodeId,
		policySha256: lxdOfficePhysicalPolicySha256(policy),
		machineIdSha256: policy.host.machineIdSha256,
		allocationId: identity.binding.allocationId,
		instanceSha256: lxdOfficeGuestPlan(identity.binding).instanceSha256,
		providerBindingSha256: lxdOfficeProviderBindingSha256(identity.binding),
		imageSha256: policy.guest.imageFingerprint,
		bootstrapSha256: policy.guest.bootstrapSha256,
		cpuMillis: policy.guest.cpus * 1000,
		memoryBytes: policy.guest.memoryBytes,
		serviceConfigSha256,
	});
}

/** One host's candidate. Preparation writes only the host-local immutable
 * journals; it cannot create a VM or write the NAS workbench. SQL atomically
 * selects and reserves a host. Lost replies are reconciled by status and the
 * exact same local identity, never by replacing an allocation or moving custody. */
export async function reconcileOfficeFleet(
	options: {
		policy: LxdOfficePhysicalPolicy;
		nodeId: string;
		serviceConfigSha256: string;
		registry: OfficeFleetRegistry;
		inspect(signal: AbortSignal): Promise<void>;
		identity(intentId: string, existing: boolean, signal: AbortSignal): Promise<LxdOfficeCreationIdentity>;
		/** Stage-only is used to publish every candidate before enabling selection. */
		stageOnly?: boolean;
	},
	signal: AbortSignal,
): Promise<"selected" | "elsewhere" | "waiting" | "held" | "retained" | "staged"> {
	const policy = parseLxdOfficePhysicalPolicy(options.policy);
	if (!UUID.test(options.nodeId)) throw new Error("OFFICE_FLEET_NODE_INVALID");
	officeSha(options.serviceConfigSha256);
	const args = { p_scope: officeFleetScope(policy), p_computer_generation: policy.guest.computerGeneration };
	const call = async (method: OfficeFleetMethod, input: Record<string, unknown>) => {
		signal.throwIfAborted();
		const result = await options.registry.call(method, input, signal);
		signal.throwIfAborted();
		return parseOfficeFleetStatus(result, policy);
	};
	let status = await call("qorpera_runtime_office_fleet_status", args);
	if (status.state === "unplaced") {
		await options.inspect(signal);
		signal.throwIfAborted();
		const identity = await options.identity(status.intentId!, false, signal);
		if (identity.intentId !== status.intentId) throw new Error("OFFICE_FLEET_INTENT_CHANGED");
		const offer = officeFleetOffer(policy, options.nodeId, options.serviceConfigSha256, identity);
		status = await call("qorpera_offer_runtime_office_fleet", { p_offer: offer });
		if (status.state === "unplaced") {
			if (options.stageOnly) return "staged";
			status = await call("qorpera_place_runtime_office_fleet", args);
		}
	}
	if (status.state === "placed") {
		if (status.offer!.providerId !== policy.guest.providerId) return "elsewhere";
		// A selected host never reconstructs missing journals, even when no VM is
		// visible yet. The selected reservation is already a durable commitment.
		const identity = await options.identity(status.intentId!, true, signal);
		signal.throwIfAborted();
		if (
			!isDeepStrictEqual(
				status.offer,
				officeFleetOffer(policy, options.nodeId, options.serviceConfigSha256, identity),
			)
		)
			throw new Error("OFFICE_FLEET_SELECTION_CHANGED");
		return "selected";
	}
	return status.state === "unplaced" ? "waiting" : status.state;
}
