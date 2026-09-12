import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	type CompanyComputerServiceSoftwareArtifact,
	type CompanyComputerServiceSoftwarePlan,
	parseCompanyComputerServiceSoftwarePlan,
} from "@qorpera/contracts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

/** Root-protected sibling document of the provider service configuration.
 * It names the enrolled software revision the provider must measure, the two
 * operator-pinned tool digests, an optional signed plan for a pending update,
 * and where the separate provider capability lives. The capability bytes are
 * never part of this document. */
export interface LxdOfficeSoftwareLaneDocument {
	plan: Readonly<CompanyComputerServiceSoftwarePlan> | undefined;
	expectedRevision: number;
	expectedService: CompanyComputerServiceSoftwareArtifact;
	tools: { install: string; measure: string };
	capabilityCredential: { path: string; bytes: 64; sha256: string };
}
export interface LxdOfficeSoftwareLaneOptions {
	plan?: Readonly<CompanyComputerServiceSoftwarePlan>;
	expectedRevision: number;
	expectedService: CompanyComputerServiceSoftwareArtifact;
	measurementToolSha256: string;
	installToolSha256: string;
	/** Separate operator-enrolled provider capability; never journaled or logged. */
	providerCapability: string;
}
export function parseLxdOfficeSoftwareLaneDocument(value: unknown): Readonly<LxdOfficeSoftwareLaneDocument> {
	try {
		const r = officeRecord(value, [
			"schema",
			"plan",
			"expectedRevision",
			"expectedService",
			"tools",
			"capabilityCredential",
		]);
		if (r.schema !== "qorpera.lxd-office-software-lane/v1") throw new Error("schema");
		const service = officeRecord(r.expectedService, ["path", "bytes", "sha256"]);
		const tools = officeRecord(r.tools, ["install", "measure"]);
		const credential = officeRecord(r.capabilityCredential, ["path", "bytes", "sha256"]);
		if (
			!Number.isSafeInteger(r.expectedRevision) ||
			(r.expectedRevision as number) < 0 ||
			(r.expectedRevision as number) > 9007199254740990 ||
			service.path !== COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH ||
			!Number.isSafeInteger(service.bytes) ||
			(service.bytes as number) < 1 ||
			(service.bytes as number) > 32 * 1024 ** 2 ||
			credential.bytes !== 64
		)
			throw new Error("lane");
		const plan = r.plan === null ? undefined : parseCompanyComputerServiceSoftwarePlan(r.plan);
		return Object.freeze({
			plan,
			expectedRevision: r.expectedRevision as number,
			expectedService: Object.freeze({
				path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
				bytes: service.bytes as number,
				sha256: officeSha(service.sha256),
			}),
			tools: Object.freeze({ install: officeSha(tools.install), measure: officeSha(tools.measure) }),
			capabilityCredential: Object.freeze({
				path: officePhysicalPath(credential.path),
				bytes: 64 as const,
				sha256: officeSha(credential.sha256),
			}),
		});
	} catch {
		throw new Error("INVALID_OFFICE_SOFTWARE_LANE");
	}
}
/** Loads the capability through the protected credential reader and binds it
 * to the document's digest. The returned options hold the raw capability in
 * memory only; callers must not serialize them. */
export async function loadLxdOfficeSoftwareLane(
	document: Readonly<LxdOfficeSoftwareLaneDocument>,
	readCredential: (path: string, limit: number) => Promise<Buffer>,
): Promise<Readonly<LxdOfficeSoftwareLaneOptions>> {
	const bytes = await readCredential(document.capabilityCredential.path, 64);
	try {
		const capability = bytes.toString("ascii");
		if (
			bytes.byteLength !== 64 ||
			!/^[0-9a-f]{64}$/.test(capability) ||
			createHash("sha256").update(bytes).digest("hex") !== document.capabilityCredential.sha256
		)
			throw new Error("OFFICE_SOFTWARE_CAPABILITY_DIFFERS");
		return Object.freeze({
			plan: document.plan,
			expectedRevision: document.expectedRevision,
			expectedService: document.expectedService,
			measurementToolSha256: document.tools.measure,
			installToolSha256: document.tools.install,
			providerCapability: capability,
		});
	} finally {
		bytes.fill(0);
	}
}
