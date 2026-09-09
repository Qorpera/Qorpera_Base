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
/** Historical import receipt, not a guarantee about future mutable workbench bytes. */
export type CompanyComputerFileImportResult = {
	schema: "qorpera.file-import-result/v1";
	transferId: string;
	source:
		| Exclude<CompanyComputerFileImportAction["source"], CompanyFileTransferSelection>
		| (CompanyFileTransferSelection & { assetId: string; sha256: string; manifestSha256: string });
	destination: { realm: "company_computer"; companyComputerId: string; screenId: string; path: string };
	bytes: number;
	mediaType: string;
};
export function parseCompanyComputerFileImportResult(value: unknown): CompanyComputerFileImportResult {
	const row = closed(value, "bytes,destination,mediaType,schema,source,transferId");
	const destination = closed(row.destination, "companyComputerId,path,realm,screenId");
	const rawSource = row.source as Record<string, unknown> | null;
	let source: CompanyComputerFileImportResult["source"];
	if (rawSource?.realm === "company_file") {
		const value = closed(rawSource, "assetId,manifestSha256,path,realm,sha256,version");
		if (
			typeof value.assetId !== "string" ||
			!UUID.test(value.assetId) ||
			typeof value.version !== "string" ||
			!UUID.test(value.version) ||
			typeof value.sha256 !== "string" ||
			!SHA.test(value.sha256) ||
			typeof value.manifestSha256 !== "string" ||
			!SHA.test(value.manifestSha256)
		)
			throw new Error("INVALID_CLOUD_FILE_IMPORT_RESULT");
		source = {
			realm: "company_file",
			path: parseCloudCompanyPath(value.path),
			version: value.version,
			assetId: value.assetId,
			sha256: value.sha256,
			manifestSha256: value.manifestSha256,
		};
	} else {
		const parsed = parseCompanyComputerFileImport({
			kind: "transfer",
			action: "import",
			source: row.source,
			destination: { realm: destination.realm, path: destination.path },
		});
		if (parsed.source.realm !== "object_storage") throw new Error("INVALID_CLOUD_FILE_IMPORT_RESULT");
		source = parsed.source;
	}
	const action = parseCompanyComputerFileImport({
		kind: "transfer",
		action: "import",
		source:
			source.realm === "company_file" ? { realm: source.realm, path: source.path, version: source.version } : source,
		destination: { realm: destination.realm, path: destination.path },
	});
	if (
		row.schema !== "qorpera.file-import-result/v1" ||
		[row.transferId, destination.companyComputerId, destination.screenId].some(
			(id) => typeof id !== "string" || !UUID.test(id),
		) ||
		!Number.isSafeInteger(row.bytes) ||
		(row.bytes as number) < 0 ||
		(row.bytes as number) > CLOUD_FILE_TRANSFER_MAX_BYTES
	)
		throw new Error("INVALID_CLOUD_FILE_IMPORT_RESULT");
	return {
		schema: row.schema,
		transferId: row.transferId as string,
		source,
		destination: {
			...action.destination,
			companyComputerId: destination.companyComputerId as string,
			screenId: destination.screenId as string,
		},
		bytes: row.bytes as number,
		mediaType: parseTransferMediaType(row.mediaType),
	};
}

/** Server-authored immutable source metadata. Parsing grants no read authority. */
export type CompanyFileTransferSource = {
	schema: "qorpera.company-file-transfer-source/v1";
	companyId: string;
	environmentId: string;
	source: CompanyFileTransferSelection;
	sha256: string;
	manifestSha256: string;
	manifestBytes: number;
	bytes: number;
	mediaType: "application/octet-stream";
};
export function parseCompanyFileTransferSource(value: unknown): CompanyFileTransferSource {
	const row = closed(
		value,
		"bytes,companyId,environmentId,manifestBytes,manifestSha256,mediaType,schema,sha256,source",
	);
	const source = closed(row.source, "path,realm,version");
	if (
		row.schema !== "qorpera.company-file-transfer-source/v1" ||
		source.realm !== "company_file" ||
		[row.companyId, row.environmentId, source.version].some((id) => typeof id !== "string" || !UUID.test(id)) ||
		[row.sha256, row.manifestSha256].some((hash) => typeof hash !== "string" || !SHA.test(hash)) ||
		!Number.isSafeInteger(row.bytes) ||
		(row.bytes as number) < 0 ||
		(row.bytes as number) > CLOUD_FILE_TRANSFER_MAX_BYTES ||
		!Number.isSafeInteger(row.manifestBytes) ||
		(row.manifestBytes as number) < 1 ||
		(row.manifestBytes as number) > 8192 ||
		row.mediaType !== "application/octet-stream"
	)
		throw new Error("INVALID_COMPANY_FILE_TRANSFER_SOURCE");
	return {
		schema: row.schema,
		companyId: row.companyId as string,
		environmentId: row.environmentId as string,
		source: { realm: "company_file", path: parseCloudCompanyPath(source.path), version: source.version as string },
		sha256: row.sha256 as string,
		manifestSha256: row.manifestSha256 as string,
		manifestBytes: row.manifestBytes as number,
		bytes: row.bytes as number,
		mediaType: row.mediaType,
	};
}
