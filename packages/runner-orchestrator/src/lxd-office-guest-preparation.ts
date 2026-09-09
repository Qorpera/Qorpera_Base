import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationRequest,
	companyComputerPreparationRoot,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import type { LxdOfficeAdoptionCopyResult } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeAdoptionPlan } from "./lxd-office-adoption-plan.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

/** Pure translation of retained copy evidence into a bounded read-only guest
 * request. The boot worker must load actual protected/journaled inputs, check
 * current authority and the physical boot, and retain the writer handoff. This
 * function neither starts a VM nor creates an adoption/activation receipt. */
export function createLxdOfficeGuestPreparationRequest(options: {
	binding: LxdOfficeGuestBinding;
	observation: LxdOfficeStorageObservation;
	plan: Readonly<LxdOfficeAdoptionPlan>;
	result: LxdOfficeAdoptionCopyResult;
	bootId: string;
	uid: number;
	gid: number;
	workbenchMount: CompanyComputerPreparationRequest["workbenchMount"];
	limits: CompanyComputerPreparationRequest["limits"];
}): Readonly<CompanyComputerPreparationRequest> {
	const { binding, instanceSha256 } = lxdOfficeGuestPlan(options.binding);
	const { observation, plan, result } = options;
	officeRecord(result, [
		"schema",
		"state",
		"adoptionId",
		"observationSha256",
		"planSha256",
		"reviewSha256",
		"outputInventorySha256",
	]);
	if (
		observation.allocationId !== binding.allocationId ||
		observation.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding) ||
		plan.observationSha256 !== officeDigest(observation) ||
		result.observationSha256 !== plan.observationSha256 ||
		result.planSha256 !== officeDigest(plan) ||
		result.adoptionId !== plan.adoptionId ||
		result.schema !== "qorpera.lxd-office-adoption-copy/v1" ||
		result.state !== "copied"
	)
		throw new Error("OFFICE_PREPARATION_COPY_MISMATCH");
	const request = parseCompanyComputerPreparationRequest({
		schema: "qorpera.office-guest-preparation/v1",
		scope: {
			companyId: binding.companyId,
			environmentId: binding.environmentId,
			companyComputerId: binding.companyComputerId,
			logicalComputerId: binding.logicalComputerId,
		},
		computerGeneration: binding.computerGeneration,
		allocationId: binding.allocationId,
		instanceSha256,
		imageSha256: binding.imageFingerprint,
		bootstrapSha256: binding.bootstrapSha256,
		bootId: options.bootId,
		uid: options.uid,
		gid: options.gid,
		workbenchMount: options.workbenchMount,
		limits: options.limits,
		copy: {
			adoptionId: result.adoptionId,
			observationSha256: result.observationSha256,
			planSha256: result.planSha256,
			reviewSha256: result.reviewSha256,
			outputInventorySha256: result.outputInventorySha256,
		},
		entries: [
			{ path: ".", kind: "directory", mode: 0o700, bytes: 0, sha256: null },
			...plan.items.map((item) => ({
				path: item.destination,
				kind: item.kind,
				mode: item.mode,
				bytes: item.kind === "file" ? item.source?.bytes : 0,
				sha256: item.kind === "file" ? item.source?.sha256 : null,
			})),
		],
	});
	const root = companyComputerPreparationRoot(request);
	if (
		!isDeepStrictEqual(plan.guestLayout, {
			workbenchRoot: `${root}/workbench`,
			desktopHome: `${root}/desktop`,
			screenStateRoot: `${root}/screens`,
			browserProfilesRoot: `${root}/profiles`,
		})
	)
		throw new Error("OFFICE_PREPARATION_LAYOUT_MISMATCH");
	return request;
}
