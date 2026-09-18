import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { CompanyFileTransferSelection } from "@qorpera/cloud-client/cloud-file-transfer";
import {
	type ObjectStorageFileSelection,
	parseObjectStorageFileSelection,
} from "@qorpera/cloud-client/cloud-file-transfer";
import type { CloudMemberCompanyFileDownload } from "@qorpera/cloud-client/cloud-member-company-file";
import type { CloudMemberFileExportDownload } from "@qorpera/cloud-client/cloud-member-file-exports";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";

/** A human host action, never an agent tool or renderer filesystem bridge.
 * The native chooser owns the destination; the cloud reader owns authority. */
export async function saveSelectedMemberFile(options: {
	selection: unknown;
	signal: AbortSignal;
	current(): boolean;
	chooseDestination(name: string): Promise<string | null>;
	download(selection: CompanyFileTransferSelection, signal: AbortSignal): Promise<CloudMemberCompanyFileDownload>;
}): Promise<{ saved: false } | { saved: true; source: CloudMemberCompanyFileDownload["source"]; bytes: number }> {
	const value = options.selection;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "path,realm,version"
	)
		throw new Error("Invalid selected Company File");
	const input = value as Record<string, unknown>;
	if (
		input.realm !== "company_file" ||
		typeof input.version !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.version)
	)
		throw new Error("Invalid selected Company File");
	const selection: CompanyFileTransferSelection = {
		realm: "company_file",
		path: parseCloudCompanyPath(input.path),
		version: input.version,
	};
	const current = () => {
		options.signal.throwIfAborted();
		if (!options.current()) throw new Error("This Company File window is no longer authorized");
	};
	current();
	const destination = await options.chooseDestination(basename(selection.path).replace(/[<>:"|?*]/g, "_"));
	current();
	if (destination === null) return { saved: false };
	if (!isAbsolute(destination) || destination.includes("\0")) throw new Error("Invalid download destination");
	const file = await options.download(selection, options.signal);
	current();
	if (
		file.source.realm !== selection.realm ||
		file.source.path !== selection.path ||
		file.source.version !== selection.version
	)
		throw new Error("Selected Company File identity changed");
	await saveBytes(destination, file.bytes, options.signal, current);
	return { saved: true, source: file.source, bytes: file.bytes.length };
}

/** A pending change is downloaded by its plan identity, never represented as
 * an already published Company File version. */
export async function savePendingMemberFile(options: {
	path: string;
	planSha256: string;
	signal: AbortSignal;
	current(): boolean;
	chooseDestination(name: string): Promise<string | null>;
	download(signal: AbortSignal): Promise<{ bytes: Uint8Array; planSha256: string }>;
}): Promise<{ saved: false } | { saved: true; bytes: number; planSha256: string }> {
	const path = parseCloudCompanyPath(options.path),
		digest = options.planSha256;
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid Company File review");
	const current = () => {
		options.signal.throwIfAborted();
		if (!options.current()) throw new Error("This Company File window is no longer authorized");
	};
	current();
	const destination = await options.chooseDestination(basename(path).replace(/[<>:"|?*]/g, "_"));
	current();
	if (destination === null) return { saved: false };
	if (!isAbsolute(destination) || destination.includes("\0")) throw new Error("Invalid download destination");
	const file = await options.download(options.signal);
	current();
	if (file.planSha256 !== digest) throw new Error("Company File review identity changed");
	await saveBytes(destination, file.bytes, options.signal, current);
	return { saved: true, bytes: file.bytes.length, planSha256: digest };
}

export async function saveSelectedMemberExport(options: {
	selection: unknown;
	name: string;
	signal: AbortSignal;
	current(): boolean;
	chooseDestination(name: string): Promise<string | null>;
	download(selection: ObjectStorageFileSelection, signal: AbortSignal): Promise<CloudMemberFileExportDownload>;
}): Promise<{ saved: false } | { saved: true; source: CloudMemberFileExportDownload["source"]; bytes: number }> {
	const selection = parseObjectStorageFileSelection(options.selection);
	const current = () => {
		options.signal.throwIfAborted();
		if (!options.current()) throw new Error("This Company File window is no longer authorized");
	};
	current();
	const name = basename(options.name).replace(/[<>:"|?*]/g, "_");
	if (!name || /[\\\0-\x1f\x7f]/.test(name)) throw new Error("Invalid shared export filename");
	const destination = await options.chooseDestination(name);
	current();
	if (destination === null) return { saved: false };
	if (!isAbsolute(destination) || destination.includes("\0")) throw new Error("Invalid download destination");
	const file = await options.download(selection, options.signal);
	current();
	if (
		file.source.realm !== selection.realm ||
		file.source.assetId !== selection.assetId ||
		file.source.sha256 !== selection.sha256 ||
		file.asset.assetId !== selection.assetId ||
		file.asset.sha256 !== selection.sha256
	)
		throw new Error("Selected shared export changed");
	await saveBytes(destination, file.bytes, options.signal, current);
	return { saved: true, source: file.source, bytes: file.bytes.length };
}

async function saveBytes(
	destination: string,
	bytes: Uint8Array,
	signal: AbortSignal,
	current: () => void,
): Promise<void> {
	// Keep the selected destination untouched until all bytes are verified and
	// written. Rename replaces only the name confirmed in the native chooser;
	// it does not follow a destination symlink or publish a partial download.
	let staging: string | undefined;
	try {
		staging = await mkdtemp(join(dirname(destination), ".qorpera-download-"));
		const temporary = join(staging, "content");
		current();
		await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal });
		current();
		await rename(temporary, destination);
	} catch {
		throw new Error("The download could not be saved. Check the destination and try again.");
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
	}
}
