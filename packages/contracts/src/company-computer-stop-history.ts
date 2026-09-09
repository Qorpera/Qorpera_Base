import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_STOP_HISTORY_ROOT = "/etc/qorpera-office/history";
export interface CompanyComputerStopHistoryEntry {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly mode: number;
}
/** Root-disk evidence only. Parsing grants no new boot or SQL authority. */
export interface CompanyComputerStopHistoryManifest {
	readonly schema: "qorpera.office-stop-history/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly activationId: string;
	readonly completionPath: string;
	readonly entries: readonly CompanyComputerStopHistoryEntry[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function companyComputerStopHistoryDirectory(bootId: string, activationId: string): string {
	if (typeof bootId !== "string" || !UUID.test(bootId) || typeof activationId !== "string" || !UUID.test(activationId))
		throw new Error("INVALID_OFFICE_STOP_HISTORY_IDENTITY");
	return `${COMPANY_COMPUTER_STOP_HISTORY_ROOT}/${bootId}/${activationId}`;
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys
	)
		throw new Error("history record");
	return value as Record<string, unknown>;
}
export function parseCompanyComputerStopHistoryManifest(
	value: unknown,
	bootId: string,
	activationId: string,
): CompanyComputerStopHistoryManifest {
	try {
		companyComputerStopHistoryDirectory(bootId, activationId);
		const r = record(value, "activationId,command,completionPath,entries,schema"),
			command = parseCompanyComputerPreparationCommand(r.command);
		if (
			r.schema !== "qorpera.office-stop-history/v1" ||
			r.activationId !== activationId ||
			command.bootId !== bootId ||
			!Array.isArray(r.entries) ||
			r.entries.length < 2 ||
			r.entries.length > 128 ||
			![
				"/run/qorpera-office-preparation/service-stop-completion.json",
				`/run/qorpera-office-preparation/service-stop-completion-${activationId}.json`,
			].includes(r.completionPath as string) ||
			new TextEncoder().encode(JSON.stringify(value)).length > 65536
		)
			throw new Error("history binding");
		const bootDirectory = `/etc/qorpera-office/boots/${bootId.replaceAll("-", "")}`;
		const bootPublicPaths = [
			"adoption.json",
			"configuration-claim.json",
			"configuration-completion.json",
			"credentials/config.json",
		].map((path) => `${bootDirectory}/${path}`);
		let previous = "",
			total = 0;
		const entries = r.entries.map((value) => {
			const entry = record(value, "bytes,mode,path,sha256");
			if (
				typeof entry.path !== "string" ||
				entry.path.length > 512 ||
				!(
					/^\/run\/qorpera-office-preparation\/[a-z0-9-]+\.json$/.test(entry.path) ||
					entry.path === "/etc/qorpera-office/credentials/config.json" ||
					entry.path === "/etc/qorpera-office/adoption.json" ||
					bootPublicPaths.includes(entry.path)
				) ||
				entry.path <= previous ||
				!Number.isSafeInteger(entry.bytes) ||
				(entry.bytes as number) < 1 ||
				(entry.bytes as number) > 65536 ||
				![0o400, 0o444, 0o600].includes(entry.mode as number) ||
				typeof entry.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(entry.sha256)
			)
				throw new Error("history entry");
			previous = entry.path;
			total += entry.bytes as number;
			return Object.freeze({ ...entry }) as unknown as CompanyComputerStopHistoryEntry;
		});
		if (total > 4 * 1024 ** 2 || !entries.some((entry) => entry.path === r.completionPath))
			throw new Error("history size");
		// Preserve the original wire key order; existing root manifests are immutable.
		return Object.freeze({
			...r,
			command,
			entries: Object.freeze(entries),
		}) as unknown as CompanyComputerStopHistoryManifest;
	} catch {
		throw new Error("INVALID_OFFICE_STOP_HISTORY_MANIFEST");
	}
}
