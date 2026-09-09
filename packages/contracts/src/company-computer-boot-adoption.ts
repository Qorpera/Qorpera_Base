import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./company-computer-adoption.ts";
import {
	type CompanyComputerBootIntentRequest,
	parseCompanyComputerBootIntentRequest,
} from "./company-computer-boot-intent.ts";
import { companyComputerBootDirectory } from "./company-computer-configuration.ts";
import {
	type CompanyComputerPreparationRequest,
	companyComputerPreparationAdoptionReceipt,
} from "./company-computer-preparation.ts";

/** Retained provider measurement. Parsing does not prove a VM operation or
 * grant boot/service authority; the provider verifies its operation journal. */
export interface CompanyComputerResumeObservation {
	readonly schema: "qorpera.lxd-office-resume-observation/v1";
	readonly intentId: string;
	readonly allocationId: string;
	readonly bootIntentId: string;
	readonly activationId: string;
	readonly startCommandId: string;
	readonly requestSha256: string;
	readonly powerOffCompletionSha256: string;
	readonly stopHistorySha256: string;
	readonly hostBootId: string;
	readonly bootId: string;
	readonly instanceSha256: string;
	readonly operationId: string;
}
/** A retained workbench, not a second assertion about copied file contents. */
export interface CompanyComputerBootAdoptionReceipt {
	readonly schema: "qorpera.office-state-retained/v1";
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
	readonly bootIntent: CompanyComputerBootIntentRequest;
	readonly bootObservationSha256: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("record");
	return value as Record<string, unknown>;
}
function pattern(value: unknown, expression: RegExp) {
	if (typeof value !== "string" || !expression.test(value)) throw new Error("identity");
}
const sha = (value: unknown) => pattern(value, /^[0-9a-f]{64}$/);
function same(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	const a = left as Record<string, unknown>,
		b = right as Record<string, unknown>;
	return (
		Object.keys(a).sort().join() === Object.keys(b).sort().join() &&
		Object.keys(a).every((key) => same(a[key], b[key]))
	);
}
export function parseCompanyComputerResumeObservation(
	value: unknown,
	intent: CompanyComputerBootIntentRequest,
): Readonly<CompanyComputerResumeObservation> {
	try {
		const r = record(value, [
			"schema",
			"intentId",
			"allocationId",
			"bootIntentId",
			"activationId",
			"startCommandId",
			"requestSha256",
			"powerOffCompletionSha256",
			"stopHistorySha256",
			"hostBootId",
			"bootId",
			"instanceSha256",
			"operationId",
		]);
		const request = parseCompanyComputerBootIntentRequest(intent);
		for (const key of [
			"intentId",
			"allocationId",
			"bootIntentId",
			"activationId",
			"startCommandId",
			"hostBootId",
			"bootId",
			"operationId",
		])
			pattern(r[key], UUID);
		for (const key of ["requestSha256", "powerOffCompletionSha256", "stopHistorySha256", "instanceSha256"])
			sha(r[key]);
		if (
			r.schema !== "qorpera.lxd-office-resume-observation/v1" ||
			r.bootIntentId !== request.bootIntentId ||
			r.activationId !== request.activationId ||
			r.allocationId !== request.predecessor.startup.allocationId ||
			r.instanceSha256 !== request.predecessor.startup.instanceSha256 ||
			r.bootId === request.predecessor.startup.bootId ||
			r.powerOffCompletionSha256 !== request.powerOffCompletionSha256 ||
			r.stopHistorySha256 !== request.stopHistorySha256
		)
			throw new Error("binding");
		return Object.freeze({ ...r }) as unknown as CompanyComputerResumeObservation;
	} catch {
		throw new Error("INVALID_OFFICE_RESUME_OBSERVATION");
	}
}
/** Exact provider canonical encoding for this closed, flat string record. */
export function companyComputerResumeObservationCanonical(
	value: CompanyComputerResumeObservation,
	intent: CompanyComputerBootIntentRequest,
): string {
	const parsed = parseCompanyComputerResumeObservation(value, intent);
	return JSON.stringify(parsed, Object.keys(parsed).sort());
}
export function parseCompanyComputerBootAdoptionReceipt(value: unknown): Readonly<CompanyComputerBootAdoptionReceipt> {
	try {
		const r = record(value, [
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
			"bootIntent",
			"bootObservationSha256",
		]);
		if (
			r.schema !== "qorpera.office-state-retained/v1" ||
			r.state !== "complete" ||
			new TextEncoder().encode(JSON.stringify(value)).length > 16384
		)
			throw new Error("receipt");
		const bootIntent = parseCompanyComputerBootIntentRequest(r.bootIntent),
			startup = bootIntent.predecessor.startup;
		record(r.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
		for (const key of [
			"scope",
			"computerGeneration",
			"allocationId",
			"instanceSha256",
			"imageSha256",
			"bootstrapSha256",
		] as const)
			if (!same(r[key], startup[key])) throw new Error("retained identity");
		pattern(r.bootId, UUID);
		sha(r.bootObservationSha256);
		const origin = record(r.origin, ["bootId", "preparationSha256", "adoptionReceiptSha256"]);
		pattern(origin.bootId, UUID);
		sha(origin.preparationSha256);
		sha(origin.adoptionReceiptSha256);
		if (r.bootId === startup.bootId || r.bootId === origin.bootId) throw new Error("boot reused");
		const layout = record(r.layout, ["workbenchRoot", "desktopHome", "screenStateRoot", "browserProfilesRoot"]);
		assertCompanyComputerGuestLayout(layout as unknown as CompanyComputerGuestLayout);
		const mount = record(r.workbenchMount, ["filesystem", "source", "root", "mountPoint"]);
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
			Object.values(layout).some((path) => !(path as string).startsWith(`${mount.mountPoint}/`))
		)
			throw new Error("mount");
		return Object.freeze({
			...r,
			scope: Object.freeze({ ...startup.scope }),
			layout: Object.freeze({ ...layout }),
			workbenchMount: Object.freeze({ ...mount }),
			origin: Object.freeze({ ...origin }),
			bootIntent,
		}) as unknown as CompanyComputerBootAdoptionReceipt;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_ADOPTION_RECEIPT");
	}
}
export function companyComputerBootAdoptionReceipt(
	original: CompanyComputerPreparationRequest,
	originPreparationSha256: string,
	originAdoptionReceiptSha256: string,
	intent: CompanyComputerBootIntentRequest,
	observation: CompanyComputerResumeObservation,
	bootObservationSha256: string,
): Readonly<CompanyComputerBootAdoptionReceipt> {
	const initial = companyComputerPreparationAdoptionReceipt(original),
		boot = parseCompanyComputerResumeObservation(observation, intent);
	return parseCompanyComputerBootAdoptionReceipt({
		schema: "qorpera.office-state-retained/v1",
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
		bootIntent: intent,
		bootObservationSha256,
	});
}
export function companyComputerBootAdoptionReceiptPath(bootId: string): string {
	return `${companyComputerBootDirectory(bootId)}/adoption.json`;
}
