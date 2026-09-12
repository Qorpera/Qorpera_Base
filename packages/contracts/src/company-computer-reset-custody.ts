import {
	type CompanyComputerStartupIdentity,
	parseCompanyComputerStartupIdentity,
} from "./company-computer-activation.ts";

export const COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS = 8192;
export const COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
export const COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES = 73729;
export const COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${uuid}$`);
const NAME = new RegExp(`^${uuid}-[0-9]{16}\\.json$`);
const SHA = /^[0-9a-f]{64}$/;

/** Custody identity only. Neither this document nor a parsed receipt permits
 * deletion, restart, release, successor admission or a change of allocation. */
export interface CompanyComputerResetCustodyBinding {
	readonly schema: "qorpera.office-reset-custody-binding/v1";
	readonly resetId: string;
	readonly transitionId: string;
	readonly predecessorActivationId: string;
	readonly successorActivationId: string;
	readonly rootIncarnationId: string;
	readonly predecessor: Readonly<CompanyComputerStartupIdentity>;
	readonly outboxUid: number;
	readonly outboxGid: number;
}
export interface CompanyComputerResetOutboxFile {
	readonly name: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly uid: number;
	readonly gid: number;
	readonly mode: 384;
}
export interface CompanyComputerResetOutboxManifest {
	readonly schema: "qorpera.office-reset-outbox/v1";
	readonly binding: Readonly<CompanyComputerResetCustodyBinding>;
	readonly files: readonly Readonly<CompanyComputerResetOutboxFile>[];
	readonly recordCount: number;
	readonly totalBytes: number;
}
export interface CompanyComputerResetOutboxRestoreReceipt {
	readonly schema: "qorpera.office-reset-outbox-restore/v1";
	readonly binding: Readonly<CompanyComputerResetCustodyBinding>;
	readonly manifestSha256: string;
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly state: "restored";
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys
	)
		throw new Error("record");
	return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("number");
	return value as number;
}
export function parseCompanyComputerResetCustodyBinding(value: unknown): Readonly<CompanyComputerResetCustodyBinding> {
	try {
		const v = record(
			value,
			"outboxGid,outboxUid,predecessor,predecessorActivationId,resetId,rootIncarnationId,schema,successorActivationId,transitionId",
		);
		if (v.schema !== "qorpera.office-reset-custody-binding/v1") throw new Error("schema");
		const ids = [v.resetId, v.transitionId, v.predecessorActivationId, v.successorActivationId, v.rootIncarnationId];
		if (ids.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length)
			throw new Error("identity");
		const predecessor = parseCompanyComputerStartupIdentity(v.predecessor);
		if (ids.includes(predecessor.bootId) || ids.includes(predecessor.allocationId)) throw new Error("identity reuse");
		return Object.freeze({
			...v,
			predecessor,
			outboxUid: integer(v.outboxUid, 0, 2147483647),
			outboxGid: integer(v.outboxGid, 0, 2147483647),
		}) as unknown as Readonly<CompanyComputerResetCustodyBinding>;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_CUSTODY_BINDING");
	}
}
export function parseCompanyComputerResetOutboxManifest(
	value: unknown,
	expected: CompanyComputerResetCustodyBinding,
): Readonly<CompanyComputerResetOutboxManifest> {
	try {
		const v = record(value, "binding,files,recordCount,schema,totalBytes");
		const binding = parseCompanyComputerResetCustodyBinding(v.binding);
		const expectedBinding = parseCompanyComputerResetCustodyBinding(expected);
		// Compare parsed primitives by field, independent of input property order.
		for (const key of [
			"resetId",
			"transitionId",
			"predecessorActivationId",
			"successorActivationId",
			"rootIncarnationId",
			"outboxUid",
			"outboxGid",
		] as const)
			if (binding[key] !== expectedBinding[key]) throw new Error("binding");
		for (const key of Object.keys(expectedBinding.predecessor) as (keyof CompanyComputerStartupIdentity)[]) {
			if (key === "scope") {
				for (const field of Object.keys(
					expectedBinding.predecessor.scope,
				) as (keyof CompanyComputerStartupIdentity["scope"])[])
					if (binding.predecessor.scope[field] !== expectedBinding.predecessor.scope[field])
						throw new Error("scope");
			} else if (binding.predecessor[key] !== expectedBinding.predecessor[key]) throw new Error("startup");
		}
		if (
			v.schema !== "qorpera.office-reset-outbox/v1" ||
			!Array.isArray(v.files) ||
			v.files.length < 1 ||
			v.files.length > COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS + 1
		)
			throw new Error("inventory");
		let previous = "",
			totalBytes = 0,
			recordBytes = 0,
			scopeCount = 0;
		const files = v.files.map((value) => {
			const f = record(value, "bytes,gid,mode,name,sha256,uid");
			if (
				typeof f.name !== "string" ||
				(f.name !== "scope.json" && !NAME.test(f.name)) ||
				f.name <= previous ||
				typeof f.sha256 !== "string" ||
				!SHA.test(f.sha256) ||
				f.mode !== 0o600 ||
				f.uid !== binding.outboxUid ||
				f.gid !== binding.outboxGid
			)
				throw new Error("file");
			if (f.name !== "scope.json") integer(Number(f.name.slice(37, 53)), 1, Number.MAX_SAFE_INTEGER);
			previous = f.name;
			const bytes = integer(f.bytes, 1, COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES);
			totalBytes += bytes;
			if (f.name === "scope.json") scopeCount++;
			else recordBytes += bytes;
			return Object.freeze({ ...f, bytes }) as unknown as Readonly<CompanyComputerResetOutboxFile>;
		});
		if (
			scopeCount !== 1 ||
			recordBytes > COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES ||
			v.recordCount !== files.length - 1 ||
			v.totalBytes !== totalBytes
		)
			throw new Error("totals");
		return Object.freeze({
			schema: "qorpera.office-reset-outbox/v1",
			binding,
			files: Object.freeze(files),
			recordCount: files.length - 1,
			totalBytes,
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_OUTBOX_MANIFEST");
	}
}
export function parseCompanyComputerResetOutboxRestoreReceipt(
	value: unknown,
	manifest: CompanyComputerResetOutboxManifest,
	manifestSha256: string,
): Readonly<CompanyComputerResetOutboxRestoreReceipt> {
	try {
		const v = record(value, "binding,fileCount,manifestSha256,schema,state,totalBytes");
		const parsed = parseCompanyComputerResetOutboxManifest(manifest, manifest.binding);
		parseCompanyComputerResetOutboxManifest({ ...parsed, binding: v.binding }, parsed.binding);
		if (
			v.schema !== "qorpera.office-reset-outbox-restore/v1" ||
			v.state !== "restored" ||
			!SHA.test(manifestSha256) ||
			v.manifestSha256 !== manifestSha256 ||
			v.fileCount !== parsed.files.length ||
			v.totalBytes !== parsed.totalBytes
		)
			throw new Error("receipt");
		return Object.freeze({
			...v,
			binding: parsed.binding,
		}) as unknown as Readonly<CompanyComputerResetOutboxRestoreReceipt>;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_OUTBOX_RESTORE_RECEIPT");
	}
}
