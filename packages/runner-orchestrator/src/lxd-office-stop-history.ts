import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationCommand,
	companyComputerStopHistoryDirectory,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import type { LxdOfficeServiceStartClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeStopDecode, officeStopHash } from "./lxd-office-stop-evidence.ts";

/** Read every sealed blob while the stopped service's VM is still readable.
 * Only public root evidence is retained; no credentials or workbench bytes.
 * The guest independently owns archive directory/mount custody and sealing. */
export async function readLxdOfficeStopHistory(
	client: Pick<LxdOfficeServiceStartClient, "readInstanceFile">,
	binding: LxdOfficeGuestBinding,
	command: CompanyComputerPreparationCommand,
	activationId: string,
	completionPath: string,
	expected: Readonly<Record<string, string>>,
	signal: AbortSignal,
) {
	const root = companyComputerStopHistoryDirectory(command.bootId, activationId),
		name = lxdOfficeGuestPlan(binding).request.name;
	const read = async (path: string, max: number) => {
		signal.throwIfAborted();
		const file = await client.readInstanceFile(binding.project, name, path, max, signal);
		try {
			signal.throwIfAborted();
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o600 ||
				file.content.length < 1 ||
				file.content.length > max
			)
				throw new Error("history custody");
			return Buffer.from(file.content);
		} finally {
			file.content.fill(0);
		}
	};
	const bytes = await read(`${root}/manifest.json`, 65536),
		manifest = parseCompanyComputerStopHistoryManifest(officeStopDecode(bytes), command.bootId, activationId);
	if (
		!isDeepStrictEqual(manifest.command, command) ||
		manifest.completionPath !== completionPath ||
		!(await read(`${root}/claim.json`, 65536)).equals(bytes)
	)
		throw new Error("history binding differs");
	for (const [path, sha] of Object.entries(expected))
		if (!manifest.entries.some((entry) => entry.path === path && entry.sha256 === sha))
			throw new Error("history source differs");
	for (const entry of manifest.entries) {
		const content = await read(`${root}/${entry.sha256}.json`, entry.bytes);
		try {
			if (content.length !== entry.bytes || officeStopHash(content) !== entry.sha256)
				throw new Error("history blob differs");
		} finally {
			content.fill(0);
		}
	}
	for (const path of ["claim.json", "manifest.json"])
		if (!(await read(`${root}/${path}`, 65536)).equals(bytes)) throw new Error("history changed");
	signal.throwIfAborted();
	return { bytes, manifest, manifestSha256: officeStopHash(bytes) };
}
