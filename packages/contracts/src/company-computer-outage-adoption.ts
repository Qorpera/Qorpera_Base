import { type CompanyComputerGuestLayout, parseCompanyComputerGuestLayout } from "./company-computer-adoption.ts";
import {
	type CompanyComputerOutagePredecessor,
	type CompanyComputerOutageRecovery,
	type CompanyComputerOutageRecoveryRequest,
	type CompanyComputerOutageResumeObservation,
	type CompanyComputerOutageTerminationAcknowledgement,
	parseCompanyComputerOutagePredecessor,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageRecoveryRequest,
	parseCompanyComputerOutageResumeObservation,
	parseCompanyComputerOutageTerminationAcknowledgement,
} from "./company-computer-outage-recovery.ts";
import { outageEqual, outageRecord, outageSha, outageUuid } from "./company-computer-outage-values.ts";
import {
	type CompanyComputerPreparationRequest,
	companyComputerPreparationAdoptionReceipt,
} from "./company-computer-preparation.ts";

/** Retained persistent state after verified abrupt termination, not a clean shutdown receipt. */
export interface CompanyComputerOutageAdoptionReceipt {
	readonly schema: "qorpera.office-state-outage-retained/v1";
	readonly state: "complete";
	readonly scope: CompanyComputerPreparationRequest["scope"];
	readonly computerGeneration: number;
	readonly allocationId: string;
	readonly instanceSha256: string;
	readonly imageSha256: string;
	readonly bootstrapSha256: string;
	readonly bootId: string;
	readonly layout: Readonly<CompanyComputerGuestLayout>;
	readonly workbenchMount: CompanyComputerPreparationRequest["workbenchMount"];
	readonly origin: {
		readonly bootId: string;
		readonly preparationSha256: string;
		readonly adoptionReceiptSha256: string;
	};
	readonly recovery: {
		readonly request: CompanyComputerOutageRecoveryRequest;
		readonly predecessor: CompanyComputerOutagePredecessor;
	};
	readonly terminationSha256: string;
	readonly bootObservationSha256: string;
}
export function parseCompanyComputerOutageAdoptionReceipt(
	value: unknown,
): Readonly<CompanyComputerOutageAdoptionReceipt> {
	const r = outageRecord(
			value,
			[
				"schema",
				"state",
				"scope",
				"computerGeneration",
				"allocationId",
				"instanceSha256",
				"imageSha256",
				"bootstrapSha256",
				"bootId",
				"layout",
				"workbenchMount",
				"origin",
				"recovery",
				"terminationSha256",
				"bootObservationSha256",
			],
			16384,
		),
		raw = outageRecord(r.recovery, ["request", "predecessor"]),
		recovery = Object.freeze({
			request: parseCompanyComputerOutageRecoveryRequest(raw.request),
			predecessor: parseCompanyComputerOutagePredecessor(raw.predecessor),
		}),
		startup = recovery.predecessor.startup,
		origin = outageRecord(r.origin, ["bootId", "preparationSha256", "adoptionReceiptSha256"]),
		layout = parseCompanyComputerGuestLayout(r.layout),
		mount = outageRecord(r.workbenchMount, ["filesystem", "source", "root", "mountPoint"]);
	outageRecord(r.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
	for (const key of [
		"scope",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"imageSha256",
		"bootstrapSha256",
	] as const)
		if (!outageEqual(r[key], startup[key])) throw new Error("OFFICE_OUTAGE_ADOPTION_IDENTITY_DIFFERS");
	const bootId = outageUuid(r.bootId),
		originBootId = outageUuid(origin.bootId);
	if (
		r.schema !== "qorpera.office-state-outage-retained/v1" ||
		r.state !== "complete" ||
		bootId === startup.bootId ||
		bootId === originBootId ||
		recovery.request.activationId === recovery.predecessor.activationId
	)
		throw new Error("INVALID_OFFICE_OUTAGE_ADOPTION_RECEIPT");
	if (
		mount.mountPoint !== "/var/lib/qorpera-office" ||
		!["nfs", "nfs4", "virtiofs", "ext4", "xfs", "btrfs", "zfs"].includes(mount.filesystem as string) ||
		typeof mount.source !== "string" ||
		!mount.source ||
		mount.source.length > 4096 ||
		/[\x00-\x1f\x7f\\]/.test(mount.source) ||
		typeof mount.root !== "string" ||
		!mount.root.startsWith("/") ||
		mount.root.length > 4096 ||
		/[\x00-\x1f\x7f\\]/.test(mount.root) ||
		(mount.root !== "/" &&
			mount.root
				.slice(1)
				.split("/")
				.some((part) => !part || part === "." || part === "..")) ||
		Object.values(layout).some((path) => !path.startsWith(`${mount.mountPoint}/`))
	)
		throw new Error("INVALID_OFFICE_OUTAGE_MOUNT");
	return Object.freeze({
		...r,
		scope: Object.freeze({ ...startup.scope }),
		bootId,
		layout,
		workbenchMount: Object.freeze({ ...mount }),
		origin: Object.freeze({
			bootId: originBootId,
			preparationSha256: outageSha(origin.preparationSha256),
			adoptionReceiptSha256: outageSha(origin.adoptionReceiptSha256),
		}),
		recovery,
		terminationSha256: outageSha(r.terminationSha256),
		bootObservationSha256: outageSha(r.bootObservationSha256),
	}) as unknown as CompanyComputerOutageAdoptionReceipt;
}
export function companyComputerOutageAdoptionReceipt(
	original: CompanyComputerPreparationRequest,
	originPreparationSha256: string,
	originAdoptionReceiptSha256: string,
	recovery: CompanyComputerOutageRecovery,
	observation: CompanyComputerOutageResumeObservation,
	termination: CompanyComputerOutageTerminationAcknowledgement,
	bootObservationSha256: string,
	terminationSha256: string,
): Readonly<CompanyComputerOutageAdoptionReceipt> {
	const initial = companyComputerPreparationAdoptionReceipt(original),
		target = parseCompanyComputerOutageRecovery(recovery, recovery.request),
		boot = parseCompanyComputerOutageResumeObservation(observation, target),
		ack = parseCompanyComputerOutageTerminationAcknowledgement(termination),
		inspection = ack.request.inspection;
	if (
		!outageEqual(ack.request.recovery, target.request) ||
		inspection.bootId !== boot.bootId ||
		inspection.hostBootId !== boot.hostBootId ||
		inspection.physicalInstanceId !== boot.physicalInstanceId ||
		inspection.originPreparationSha256 !== originPreparationSha256 ||
		inspection.originAdoptionReceiptSha256 !== originAdoptionReceiptSha256 ||
		inspection.predecessorConfigurationSha256 !== target.predecessor.startup.configurationSha256 ||
		inspection.bootObservationSha256 !== bootObservationSha256
	)
		throw new Error("INVALID_OFFICE_OUTAGE_ADOPTION_TERMINATION");
	return parseCompanyComputerOutageAdoptionReceipt({
		schema: "qorpera.office-state-outage-retained/v1",
		state: "complete",
		scope: initial.scope,
		computerGeneration: initial.computerGeneration,
		allocationId: initial.allocationId,
		instanceSha256: initial.instanceSha256,
		imageSha256: initial.imageSha256,
		bootstrapSha256: initial.bootstrapSha256,
		bootId: boot.bootId,
		layout: initial.layout,
		workbenchMount: initial.workbenchMount,
		origin: {
			bootId: initial.bootId,
			preparationSha256: originPreparationSha256,
			adoptionReceiptSha256: originAdoptionReceiptSha256,
		},
		recovery: { request: target.request, predecessor: target.predecessor },
		terminationSha256,
		bootObservationSha256,
	});
}

/** Stable proof bytes across SQL JSON ordering and provider/guest parsing. */
export function companyComputerOutageTerminationAcknowledgementCanonical(
	value: CompanyComputerOutageTerminationAcknowledgement,
): string {
	return JSON.stringify(sorted(parseCompanyComputerOutageTerminationAcknowledgement(value)));
}

/** Public receipt bytes are invariant to transport key ordering. Add the
 * required file newline only at the provider/guest publication boundary. */
export function companyComputerOutageAdoptionReceiptCanonical(value: CompanyComputerOutageAdoptionReceipt): string {
	return JSON.stringify(sorted(parseCompanyComputerOutageAdoptionReceipt(value)));
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, sorted(item)]),
		);
	return value;
}
