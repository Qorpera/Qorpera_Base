import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	type CompanyComputerServiceSoftwareArtifact,
	type CompanyComputerServiceSoftwarePlan,
	parseCompanyComputerServiceSoftwarePlan,
} from "@qorpera/contracts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeProtectedPackageArtifactFile } from "./lxd-office-physical-host.ts";
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
	/** Host copy of the pinned measurement tool. The guest's staging root is a
	 * tmpfs, so a boot activation must stage the tool again before measuring. */
	measurementTool?: { path: string; bytes: number; sha256: string };
}
export interface LxdOfficeSoftwareLaneOptions {
	plan?: Readonly<CompanyComputerServiceSoftwarePlan>;
	expectedRevision: number;
	expectedService: CompanyComputerServiceSoftwareArtifact;
	measurementToolSha256: string;
	installToolSha256: string;
	/** Exact pinned measurement tool bytes when the lane names a host copy. */
	measurementTool?: Buffer;
	/** Separate operator-enrolled provider capability; never journaled or logged. */
	providerCapability: string;
}
export function parseLxdOfficeSoftwareLaneDocument(value: unknown): Readonly<LxdOfficeSoftwareLaneDocument> {
	try {
		const optional =
			value && typeof value === "object" && "measurementTool" in value ? (["measurementTool"] as const) : [];
		const r = officeRecord(value, [
			"schema",
			"plan",
			"expectedRevision",
			"expectedService",
			"tools",
			"capabilityCredential",
			...optional,
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
		let measurementTool: LxdOfficeSoftwareLaneDocument["measurementTool"];
		if (optional.length) {
			const tool = officeRecord(r.measurementTool, ["path", "bytes", "sha256"]);
			if (
				!Number.isSafeInteger(tool.bytes) ||
				(tool.bytes as number) < 1 ||
				(tool.bytes as number) > 32 * 1024 ** 2 ||
				officeSha(tool.sha256) !== officeSha(tools.measure)
			)
				throw new Error("measurement tool");
			measurementTool = Object.freeze({
				path: officePhysicalPath(tool.path),
				bytes: tool.bytes as number,
				sha256: tool.sha256 as string,
			});
		}
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
			...(measurementTool ? { measurementTool } : {}),
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
	readArtifact: (path: string, limit: number) => Promise<Buffer> = readLxdOfficeProtectedPackageArtifactFile,
): Promise<Readonly<LxdOfficeSoftwareLaneOptions>> {
	let measurementTool: Buffer | undefined;
	if (document.measurementTool) {
		measurementTool = await readArtifact(document.measurementTool.path, document.measurementTool.bytes);
		if (
			measurementTool.length !== document.measurementTool.bytes ||
			createHash("sha256").update(measurementTool).digest("hex") !== document.tools.measure
		)
			throw new Error("OFFICE_SOFTWARE_TOOL_PIN_DIFFERS");
	}
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
			...(measurementTool ? { measurementTool } : {}),
			providerCapability: capability,
		});
	} finally {
		bytes.fill(0);
	}
}
