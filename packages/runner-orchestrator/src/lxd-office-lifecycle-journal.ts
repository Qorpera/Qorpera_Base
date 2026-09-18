import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeConfigurationRequest } from "./lxd-office-configuration-worker.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

export const OFFICE_LIFECYCLE_PHASES = [
	"creation",
	"inventory",
	"review",
	"adoption",
	"boot",
	"preparation",
	"configuration",
	"activation",
] as const;
export type LxdOfficeLifecyclePhase = (typeof OFFICE_LIFECYCLE_PHASES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIMIT = 65536;
export interface LxdOfficeLifecycleContext {
	allocationId: string | null;
	observationSha256: string | null;
	request: LxdOfficeConfigurationRequest | null;
}
interface RecordValue {
	schema: "qorpera.lxd-office-lifecycle-phase/v1";
	intentId: string;
	configurationSha256: string;
	phase: LxdOfficeLifecyclePhase;
	previousSha256: string | null;
	context: LxdOfficeLifecycleContext;
}
export function parseLxdOfficeLifecycleRequest(value: unknown): LxdOfficeConfigurationRequest {
	const r = officeRecord(value, [
		"intentId",
		"observationSha256",
		"input",
		"reviewPath",
		"writerFencePath",
		"serviceBootstrapPath",
	]);
	if (
		typeof r.intentId !== "string" ||
		!UUID.test(r.intentId) ||
		!r.input ||
		typeof r.input !== "object" ||
		Array.isArray(r.input) ||
		Buffer.byteLength(JSON.stringify(r)) > LIMIT - 4096
	)
		throw new Error("INVALID_OFFICE_LIFECYCLE_REQUEST");
	officeSha(r.observationSha256);
	for (const field of ["reviewPath", "writerFencePath", "serviceBootstrapPath"]) officePhysicalPath(r[field]);
	return structuredClone(r) as unknown as LxdOfficeConfigurationRequest;
}
function validateContext(value: unknown, index: number, intentId: string): LxdOfficeLifecycleContext {
	const r = officeRecord(value, ["allocationId", "observationSha256", "request"]);
	if (index === 0 ? r.allocationId !== null : typeof r.allocationId !== "string" || !UUID.test(r.allocationId))
		throw new Error("allocation");
	if (index < 2 ? r.observationSha256 !== null : officeSha(r.observationSha256) !== r.observationSha256)
		throw new Error("observation");
	if (index < 3) {
		if (r.request !== null) throw new Error("request");
	} else {
		const request = parseLxdOfficeLifecycleRequest(r.request);
		if (request.intentId !== intentId || request.observationSha256 !== r.observationSha256)
			throw new Error("request binding");
	}
	return structuredClone(r) as unknown as LxdOfficeLifecycleContext;
}

/** Eight immutable forward-only records. The next phase is fsynced before
 * its worker may run. A missing/corrupt chain never falls back to an earlier
 * worker, and pre-supervisor component journals require explicit recovery. */
export class LxdOfficeLifecycleJournal {
	readonly root: string;
	readonly intentId: string;
	readonly configurationSha256: string;
	private current: RecordValue;
	private constructor(root: string, intentId: string, configurationSha256: string, current: RecordValue) {
		this.root = root;
		this.intentId = intentId;
		this.configurationSha256 = configurationSha256;
		this.current = current;
	}
	static async open(root: string, intentId: string, configurationSha256: string, reserved: boolean) {
		if (!UUID.test(intentId)) throw new Error("INVALID_OFFICE_LIFECYCLE_INTENT");
		officeSha(configurationSha256);
		await checkDirectory(root);
		let current: RecordValue | undefined;
		let gap = false;
		for (const [index, phase] of OFFICE_LIFECYCLE_PHASES.entries()) {
			let value: unknown;
			try {
				value = (await readRecord(join(root, `lifecycle-${intentId}-${index}.json`), LIMIT)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				gap = true;
				continue;
			}
			if (gap) throw new Error("OFFICE_LIFECYCLE_JOURNAL_GAP");
			const record = officeRecord(value, [
				"schema",
				"intentId",
				"configurationSha256",
				"phase",
				"previousSha256",
				"context",
			]);
			const context = validateContext(record.context, index, intentId);
			if (
				record.schema !== "qorpera.lxd-office-lifecycle-phase/v1" ||
				record.intentId !== intentId ||
				record.configurationSha256 !== configurationSha256 ||
				record.phase !== phase ||
				record.previousSha256 !== (current ? officeDigest(current) : null) ||
				(current &&
					((index > 1 && context.allocationId !== current.context.allocationId) ||
						(index > 2 && context.observationSha256 !== current.context.observationSha256) ||
						(index > 3 && !isDeepStrictEqual(context.request, current.context.request))))
			)
				throw new Error("OFFICE_LIFECYCLE_JOURNAL_CHANGED");
			current = record as unknown as RecordValue;
		}
		if (!current) {
			if (reserved) throw new Error("OFFICE_LIFECYCLE_JOURNAL_MISSING");
			try {
				await lstat(join(root, `intent-${intentId}.json`));
				throw new Error("OFFICE_LIFECYCLE_JOURNAL_MISSING");
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
			}
			current = {
				schema: "qorpera.lxd-office-lifecycle-phase/v1",
				intentId,
				configurationSha256,
				phase: "creation",
				previousSha256: null,
				context: { allocationId: null, observationSha256: null, request: null },
			};
			if (!(await publish(root, `lifecycle-${intentId}-0.json`, Buffer.from(officeCanonical(current)))))
				throw new Error("OFFICE_LIFECYCLE_JOURNAL_RACE");
		}
		await syncDirectory(root);
		return new LxdOfficeLifecycleJournal(root, intentId, configurationSha256, current);
	}
	get phase() {
		return this.current.phase;
	}
	get context() {
		return structuredClone(this.current.context);
	}
	async advance(context: LxdOfficeLifecycleContext = this.context) {
		const index = OFFICE_LIFECYCLE_PHASES.indexOf(this.phase) + 1;
		if (index >= OFFICE_LIFECYCLE_PHASES.length) throw new Error("OFFICE_LIFECYCLE_ALREADY_ACTIVATING");
		const next: RecordValue = {
			...this.current,
			phase: OFFICE_LIFECYCLE_PHASES[index],
			previousSha256: officeDigest(this.current),
			context: validateContext(context, index, this.intentId),
		};
		const name = `lifecycle-${this.intentId}-${index}.json`;
		await publish(this.root, name, Buffer.from(officeCanonical(next)));
		if (!isDeepStrictEqual((await readRecord(join(this.root, name), LIMIT)).value, next))
			throw new Error("OFFICE_LIFECYCLE_JOURNAL_RACE");
		this.current = next;
	}
}
