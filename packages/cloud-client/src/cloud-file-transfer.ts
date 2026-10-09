import { parseCloudCompanyPath } from "./company-path-schema.ts";

/** Explicit cloud realms. A workbench path is never a Company File path or
 * a member-device path, and an asset reference is not download authority. */
export const CLOUD_FILE_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_CLOUD_FILE_TRANSFER");
	return value as Record<string, unknown>;
}
export function parseWorkbenchFilePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.startsWith("/") ||
		/[\x00-\x1f\x7f\\]/.test(value) ||
		encoder.encode(value).length > 1024 ||
		new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(value)) !== value
	)
		throw new Error("INVALID_WORKBENCH_FILE_PATH");
	const parts = value.split("/");
	if (
		parts.length > 32 ||
		parts.some((part) => !part || part === "." || part === ".." || encoder.encode(part).length > 255)
	)
		throw new Error("INVALID_WORKBENCH_FILE_PATH");
	return value;
}
export function parseTransferMediaType(value: unknown): string {
	if (typeof value !== "string" || value.length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value))
		throw new Error("INVALID_TRANSFER_MEDIA_TYPE");
	return value;
}
export type CompanyComputerFileExportAction = {
	kind: "transfer";
	action: "export";
	source: { realm: "company_computer"; path: string };
	destination: { realm: "object_storage" };
	mediaType: string;
};
export function parseCompanyComputerFileExport(value: unknown): CompanyComputerFileExportAction {
	const row = closed(value, "action,destination,kind,mediaType,source");
	const source = closed(row.source, "path,realm"),
		destination = closed(row.destination, "realm");
	if (
		row.kind !== "transfer" ||
		row.action !== "export" ||
		source.realm !== "company_computer" ||
		destination.realm !== "object_storage"
	)
		throw new Error("INVALID_CLOUD_FILE_TRANSFER_REALM");
	return {
		kind: "transfer",
		action: "export",
		source: { realm: "company_computer", path: parseWorkbenchFilePath(source.path) },
		destination: { realm: "object_storage" },
		mediaType: parseTransferMediaType(row.mediaType),
	};
}
export type CompanyComputerFileExportAsset = {
	schema: "qorpera.file-transfer-asset/v1";
	assetId: string;
	sha256: string;
	bytes: number;
	mediaType: string;
	source: { realm: "company_computer"; companyComputerId: string; screenId: string; path: string };
	destination: { realm: "object_storage" };
};
export function parseCompanyComputerFileExportAsset(value: unknown): CompanyComputerFileExportAsset {
	const row = closed(value, "assetId,bytes,destination,mediaType,schema,sha256,source");
	const source = closed(row.source, "companyComputerId,path,realm,screenId"),
		destination = closed(row.destination, "realm");
	if (
		row.schema !== "qorpera.file-transfer-asset/v1" ||
		source.realm !== "company_computer" ||
		destination.realm !== "object_storage" ||
		[row.assetId, source.companyComputerId, source.screenId].some((id) => typeof id !== "string" || !UUID.test(id)) ||
		typeof row.sha256 !== "string" ||
		!SHA.test(row.sha256) ||
		!Number.isSafeInteger(row.bytes) ||
		(row.bytes as number) < 0 ||
		(row.bytes as number) > CLOUD_FILE_TRANSFER_MAX_BYTES
	)
		throw new Error("INVALID_CLOUD_FILE_TRANSFER_ASSET");
	return {
		schema: row.schema,
		assetId: row.assetId as string,
		sha256: row.sha256,
		bytes: row.bytes as number,
		mediaType: parseTransferMediaType(row.mediaType),
		source: {
			realm: "company_computer",
			companyComputerId: source.companyComputerId as string,
			screenId: source.screenId as string,
			path: parseWorkbenchFilePath(source.path),
		},
		destination: { realm: "object_storage" },
	};
}

export type CompanyFileTransferSelection = { realm: "company_file"; path: string; version: string };
export type ObjectStorageFileSelection = { realm: "object_storage"; assetId: string; sha256: string };
export function parseObjectStorageFileSelection(value: unknown): ObjectStorageFileSelection {
	const source = closed(value, "assetId,realm,sha256");
	if (
		source.realm !== "object_storage" ||
		typeof source.assetId !== "string" ||
		!UUID.test(source.assetId) ||
		typeof source.sha256 !== "string" ||
		!SHA.test(source.sha256)
	)
		throw new Error("INVALID_CLOUD_FILE_TRANSFER_ASSET");
	return { realm: "object_storage", assetId: source.assetId, sha256: source.sha256 };
}

/** company_write targets the governed Company File. This selection grants no
 * raw object access and cannot name a member device or workbench path. */
export type CompanyFileAssetWrite = {
	path: string;
	expectedVersion: string | null;
	operationKey: string;
	source: ObjectStorageFileSelection;
};
export function parseCompanyFileAssetWrite(value: unknown): CompanyFileAssetWrite {
	const row = closed(value, "expectedVersion,operationKey,path,source");
	if (
		(row.expectedVersion !== null && (typeof row.expectedVersion !== "string" || !UUID.test(row.expectedVersion))) ||
		typeof row.operationKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.operationKey)
	)
		throw new Error("INVALID_COMPANY_FILE_ASSET_WRITE");
	return {
		path: parseCloudCompanyPath(row.path),
		expectedVersion: row.expectedVersion as string | null,
		operationKey: row.operationKey,
		source: parseObjectStorageFileSelection(row.source),
	};
}
export type CompanyComputerFileImportAction = {
	kind: "transfer";
	action: "import";
	source: { realm: "object_storage"; assetId: string; sha256: string } | CompanyFileTransferSelection;
	destination: { realm: "company_computer"; path: string };
};
export function parseCompanyComputerFileImport(value: unknown): CompanyComputerFileImportAction {
	const row = closed(value, "action,destination,kind,source");
	const candidate = row.source as Record<string, unknown> | null;
	const source = closed(
			row.source,
			candidate?.realm === "company_file" ? "path,realm,version" : "assetId,realm,sha256",
		),
		destination = closed(row.destination, "path,realm");
	if (
		row.kind !== "transfer" ||
		row.action !== "import" ||
		destination.realm !== "company_computer" ||
		(source.realm === "company_file"
			? typeof source.version !== "string" || !UUID.test(source.version)
			: source.realm !== "object_storage" ||
				typeof source.assetId !== "string" ||
				!UUID.test(source.assetId) ||
				typeof source.sha256 !== "string" ||
				!SHA.test(source.sha256))
	)
		throw new Error("INVALID_CLOUD_FILE_TRANSFER_REALM");
	return {
		kind: "transfer",
		action: "import",
		source:
			source.realm === "company_file"
				? { realm: "company_file", path: parseCloudCompanyPath(source.path), version: source.version as string }
				: { realm: "object_storage", assetId: source.assetId as string, sha256: source.sha256 as string },
		destination: { realm: "company_computer", path: parseWorkbenchFilePath(destination.path) },
	};
}
