/** Portable provider-to-guest preparation data. This contains no credentials,
 * endpoint, command, cloud authority or permission to start an office. */
export interface CompanyComputerPreparationEntry {
	readonly path: string;
	readonly kind: "directory" | "file";
	readonly mode: number;
	readonly bytes: number;
	readonly sha256: string | null;
}
export interface CompanyComputerPreparationRequest {
	readonly schema: "qorpera.office-guest-preparation/v1";
	readonly scope: {
		readonly companyId: string;
		readonly environmentId: string;
		readonly companyComputerId: string;
		readonly logicalComputerId: string;
	};
	readonly computerGeneration: number;
	readonly allocationId: string;
	readonly instanceSha256: string;
	readonly imageSha256: string;
	readonly bootstrapSha256: string;
	readonly bootId: string;
	readonly uid: number;
	readonly gid: number;
	readonly copy: {
		readonly adoptionId: string;
		readonly observationSha256: string;
		readonly planSha256: string;
		readonly reviewSha256: string;
		readonly outputInventorySha256: string;
	};
	readonly workbenchMount: {
		readonly filesystem: string;
		readonly source: string;
		readonly root: string;
		readonly mountPoint: "/var/lib/qorpera-office";
	};
	readonly limits: {
		readonly memoryBytes: number;
		readonly pids: number;
		readonly cpuQuota: number;
		readonly cpuPeriod: number;
	};
	readonly entries: readonly CompanyComputerPreparationEntry[];
}
export const COMPANY_COMPUTER_PREPARATION_MAX_BYTES = 16 * 1024 ** 2;
export interface CompanyComputerPreparationCommand {
	readonly commandId: string;
	readonly requestSha256: string;
	readonly bootId: string;
}
export function parseCompanyComputerPreparationCommand(value: unknown): Readonly<CompanyComputerPreparationCommand> {
	try {
		const command = record(value, ["commandId", "requestSha256", "bootId"]);
		pattern(command.commandId, UUID);
		pattern(command.bootId, UUID);
		pattern(command.requestSha256, SHA);
		return freeze(structuredClone(command) as unknown as CompanyComputerPreparationCommand);
	} catch {
		throw new Error("INVALID_OFFICE_PREPARATION_COMMAND");
	}
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const roots = ["desktop", "profiles", "screens", "workbench"];
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	return value as Record<string, unknown>;
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
		throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
}
function pattern(value: unknown, expression: RegExp): void {
	if (typeof value !== "string" || !expression.test(value)) throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
}
function freeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Closed, bounded manifest with all ancestors and exactly the four admitted
 * roots. Original host inode numbers are not portable through virtiofs; this
 * manifest instead binds the copied paths, private modes, lengths and hashes. */
export function parseCompanyComputerPreparationRequest(value: unknown): Readonly<CompanyComputerPreparationRequest> {
	const request = record(value, [
		"schema",
		"scope",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"imageSha256",
		"bootstrapSha256",
		"bootId",
		"uid",
		"gid",
		"copy",
		"workbenchMount",
		"limits",
		"entries",
	]);
	if (request.schema !== "qorpera.office-guest-preparation/v1") throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	for (const value of Object.values(
		record(request.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]),
	))
		pattern(value, UUID);
	for (const value of [request.allocationId, request.bootId]) pattern(value, UUID);
	for (const value of [request.instanceSha256, request.imageSha256, request.bootstrapSha256]) pattern(value, SHA);
	positive(request.computerGeneration);
	positive(request.uid, 2147483647);
	positive(request.gid, 2147483647);
	const copy = record(request.copy, [
		"adoptionId",
		"observationSha256",
		"planSha256",
		"reviewSha256",
		"outputInventorySha256",
	]);
	pattern(copy.adoptionId, UUID);
	for (const name of ["observationSha256", "planSha256", "reviewSha256", "outputInventorySha256"])
		pattern(copy[name], SHA);
	for (const value of Object.values(record(request.limits, ["memoryBytes", "pids", "cpuQuota", "cpuPeriod"])))
		positive(value);
	const mount = record(request.workbenchMount, ["filesystem", "source", "root", "mountPoint"]);
	if (
		!["virtiofs", "nfs", "nfs4", "ext4", "xfs", "btrfs", "zfs"].includes(mount.filesystem as string) ||
		mount.mountPoint !== "/var/lib/qorpera-office" ||
		typeof mount.root !== "string" ||
		!mount.root.startsWith("/") ||
		mount.root.length > 4096 ||
		/[\x00-\x20\x7f\\]/.test(mount.root) ||
		(mount.root !== "/" &&
			mount.root
				.slice(1)
				.split("/")
				.some((part) => !part || part === "." || part === "..")) ||
		typeof mount.source !== "string" ||
		!mount.source ||
		mount.source.length > 4096 ||
		/[\x00-\x20\x7f\\]/.test(mount.source)
	)
		throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	if (!Array.isArray(request.entries) || request.entries.length < 5 || request.entries.length > 100000)
		throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	const encoder = new TextEncoder();
	const entries = new Map<string, CompanyComputerPreparationEntry>();
	let total = 0;
	for (const input of request.entries) {
		const item = record(input, ["path", "kind", "mode", "bytes", "sha256"]);
		if (
			typeof item.path !== "string" ||
			!item.path ||
			encoder.encode(item.path).length > 4096 ||
			/[\x00-\x1f\x7f\\\ufffd]/.test(item.path) ||
			entries.has(item.path)
		)
			throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
		if (item.path !== ".") {
			const parts = item.path.split("/");
			if (
				parts.length > 64 ||
				!roots.includes(parts[0]) ||
				parts.some((part) => !part || part === "." || part === ".." || encoder.encode(part).length > 255)
			)
				throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
		}
		if (
			item.kind === "directory"
				? item.mode !== 0o700 || item.bytes !== 0 || item.sha256 !== null
				: item.kind !== "file" ||
					![0o600, 0o700].includes(item.mode as number) ||
					!Number.isSafeInteger(item.bytes) ||
					(item.bytes as number) < 0 ||
					(item.bytes as number) > 16 * 1024 ** 3 ||
					typeof item.sha256 !== "string" ||
					!SHA.test(item.sha256)
		)
			throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
		total += item.bytes as number;
		if (total > 64 * 1024 ** 3) throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
		entries.set(item.path, item as unknown as CompanyComputerPreparationEntry);
	}
	for (const name of [".", ...roots])
		if (entries.get(name)?.kind !== "directory") throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	for (const path of entries.keys()) {
		if (path === ".") continue;
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
		if (entries.get(parent)?.kind !== "directory") throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	}
	if (encoder.encode(JSON.stringify(request)).length > COMPANY_COMPUTER_PREPARATION_MAX_BYTES)
		throw new Error("INVALID_OFFICE_PREPARATION_REQUEST");
	const parsed = structuredClone(request) as unknown as CompanyComputerPreparationRequest;
	return freeze({
		...parsed,
		entries: parsed.entries
			.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				bytes: entry.bytes,
				sha256: entry.sha256,
			}))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	});
}

export function companyComputerPreparationRoot(request: CompanyComputerPreparationRequest): string {
	return `${request.workbenchMount.mountPoint}/.qorpera-adopted-${request.copy.adoptionId}`;
}

export const COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH = "/etc/qorpera-office/adoption.json";

/** Pure receipt data for a copied and guest-verified adoption. The protected
 * helper may publish it only after successful preparation. It never asserts
 * that the original source was empty, grants a browser profile, or activates
 * an office. The provider must independently verify its custody and bytes. */
export function companyComputerPreparationAdoptionReceipt(value: CompanyComputerPreparationRequest) {
	const request = parseCompanyComputerPreparationRequest(value);
	const root = companyComputerPreparationRoot(request);
	return freeze({
		schema: "qorpera.office-state-adoption/v1" as const,
		state: "complete" as const,
		scope: request.scope,
		computerGeneration: request.computerGeneration,
		allocationId: request.allocationId,
		instanceSha256: request.instanceSha256,
		imageSha256: request.imageSha256,
		bootstrapSha256: request.bootstrapSha256,
		bootId: request.bootId,
		layout: {
			workbenchRoot: `${root}/workbench`,
			desktopHome: `${root}/desktop`,
			screenStateRoot: `${root}/screens`,
			browserProfilesRoot: `${root}/profiles`,
		},
		workbenchMount: request.workbenchMount,
		disposition: "migration_completed" as const,
		inventorySha256: request.copy.outputInventorySha256,
		reviewSha256: request.copy.reviewSha256,
	});
}

export interface CompanyComputerPreparationReport {
	readonly schema: "qorpera.office-guest-preparation-result/v1";
	readonly state: "prepared";
	readonly scope: CompanyComputerPreparationRequest["scope"];
	readonly computerGeneration: number;
	readonly allocationId: string;
	readonly instanceSha256: string;
	readonly imageSha256: string;
	readonly bootstrapSha256: string;
	readonly bootId: string;
	readonly copy: CompanyComputerPreparationRequest["copy"];
	readonly workbenchMount: CompanyComputerPreparationRequest["workbenchMount"];
	readonly contentSha256: string;
	readonly observationSha256: string;
	readonly entries: number;
	readonly totalBytes: number;
	readonly requestSha256: string;
	readonly invocationId: string;
}
function canonicalPreparationValue(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(normalize);
		if (!input || typeof input !== "object") return input;
		return Object.fromEntries(
			Object.entries(input)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, child]) => [key, normalize(child)]),
		);
	};
	return JSON.stringify(normalize(value));
}
/** Data validation only. The caller computes both expected hashes from the
 * exact delivered request and normalized manifest, verifies protected report
 * custody, and matches invocationId to a fresh completed systemd invocation.
 * Neither a valid report nor its invocation ID is startup/admission authority. */
export function parseCompanyComputerPreparationReport(
	value: unknown,
	request: CompanyComputerPreparationRequest,
	expected: { requestSha256: string; contentSha256: string },
): Readonly<CompanyComputerPreparationReport> {
	const report = record(value, [
		"schema",
		"state",
		"scope",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"imageSha256",
		"bootstrapSha256",
		"bootId",
		"copy",
		"workbenchMount",
		"contentSha256",
		"observationSha256",
		"entries",
		"totalBytes",
		"requestSha256",
		"invocationId",
	]);
	pattern(expected.requestSha256, SHA);
	pattern(expected.contentSha256, SHA);
	pattern(report.observationSha256, SHA);
	pattern(report.invocationId, /^(?!0{32}$)[0-9a-f]{32}$/);
	if (
		report.schema !== "qorpera.office-guest-preparation-result/v1" ||
		report.state !== "prepared" ||
		report.requestSha256 !== expected.requestSha256 ||
		report.contentSha256 !== expected.contentSha256 ||
		report.entries !== request.entries.length ||
		report.totalBytes !== request.entries.reduce((sum, entry) => sum + entry.bytes, 0) ||
		(
			[
				"scope",
				"computerGeneration",
				"allocationId",
				"instanceSha256",
				"imageSha256",
				"bootstrapSha256",
				"bootId",
				"copy",
				"workbenchMount",
			] as const
		).some((key) => canonicalPreparationValue(report[key]) !== canonicalPreparationValue(request[key]))
	)
		throw new Error("OFFICE_PREPARATION_REPORT_MISMATCH");
	return freeze(structuredClone(report) as unknown as CompanyComputerPreparationReport);
}

export interface CompanyComputerPreparationCompletion {
	readonly schema: "qorpera.office-preparation-completion/v2";
	readonly command: CompanyComputerPreparationCommand;
	readonly invocationId: string;
	readonly reportSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly report: CompanyComputerPreparationReport;
}

/** Validate a protected helper completion against the caller's retained
 * command, exact request and independently read raw report digest. The caller
 * must establish custody, operation success and current boot/authority. */
export function parseCompanyComputerPreparationCompletion(
	value: unknown,
	request: CompanyComputerPreparationRequest,
	expected: {
		commandId: string;
		requestSha256: string;
		contentSha256: string;
		reportSha256: string;
		adoptionReceiptSha256: string;
	},
): Readonly<CompanyComputerPreparationCompletion> {
	const completion = record(value, [
		"schema",
		"command",
		"invocationId",
		"reportSha256",
		"adoptionReceiptSha256",
		"report",
	]);
	const command = parseCompanyComputerPreparationCommand(completion.command);
	pattern(expected.commandId, UUID);
	pattern(expected.reportSha256, SHA);
	pattern(expected.adoptionReceiptSha256, SHA);
	const report = parseCompanyComputerPreparationReport(completion.report, request, expected);
	if (
		completion.schema !== "qorpera.office-preparation-completion/v2" ||
		command.commandId !== expected.commandId ||
		command.requestSha256 !== expected.requestSha256 ||
		command.bootId !== request.bootId ||
		completion.reportSha256 !== expected.reportSha256 ||
		completion.adoptionReceiptSha256 !== expected.adoptionReceiptSha256 ||
		completion.invocationId !== report.invocationId
	)
		throw new Error("OFFICE_PREPARATION_COMPLETION_MISMATCH");
	return freeze({
		schema: "qorpera.office-preparation-completion/v2",
		command,
		invocationId: report.invocationId,
		reportSha256: expected.reportSha256,
		adoptionReceiptSha256: expected.adoptionReceiptSha256,
		report,
	});
}
