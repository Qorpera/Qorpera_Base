import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerActivationAttestation,
	type CompanyComputerLifecycleRequest,
	type CompanyComputerResetPhase,
	type CompanyComputerResetPhaseRecord,
	type CompanyComputerResetPlan,
	parseCompanyComputerActivationAttestation,
	parseCompanyComputerResetPhaseRecord,
	parseCompanyComputerResetPlan,
} from "@qorpera/contracts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import type { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

const LIMIT = 65536;

/** Read the operator's protected reset plan beside the lifecycle plan. The
 * plan is a root-owned local document; it must bind the exact retained
 * replace recovery request. No guest, model or registry input reaches here. */
export async function readLxdOfficeResetPlan(
	readProtected: typeof readLxdOfficeProtectedFile,
	planPath: string,
	recovery: CompanyComputerLifecycleRequest,
): Promise<{ plan: CompanyComputerResetPlan; planSha256: string } | undefined> {
	let bytes: Buffer;
	try {
		bytes = await readProtected(`${planPath}.reset`, LIMIT);
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		return undefined;
	}
	const plan = parseCompanyComputerResetPlan(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
	if (!isDeepStrictEqual(plan.predecessor, recovery)) throw new Error("OFFICE_RESET_PLAN_PREDECESSOR_DIFFERS");
	return { plan, planSha256: officeDigest(plan) };
}

/** Immutable forward-only phase records for one reset: nine hash-chained
 * files beside the other allocation journals. A record is written only after
 * SQL committed the phase; the records fence local dispatch order and never
 * substitute for SQL status or physical evidence. */
export class LxdOfficeResetJournal {
	readonly root: string;
	readonly plan: CompanyComputerResetPlan;
	readonly #prefix: string;
	#records: CompanyComputerResetPhaseRecord[];
	private constructor(root: string, plan: CompanyComputerResetPlan, records: CompanyComputerResetPhaseRecord[]) {
		this.root = root;
		this.plan = plan;
		this.#prefix = `reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-`;
		this.#records = records;
	}
	static async open(root: string, value: CompanyComputerResetPlan): Promise<LxdOfficeResetJournal> {
		const plan = parseCompanyComputerResetPlan(value);
		await checkDirectory(root);
		const prefix = `reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-`;
		const records: CompanyComputerResetPhaseRecord[] = [];
		let gap = false;
		for (const [index, phase] of COMPANY_COMPUTER_RESET_PHASES.entries()) {
			let value: unknown;
			try {
				value = (await readRecord(join(root, `${prefix}${index + 1}.json`), LIMIT)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				gap = true;
				continue;
			}
			if (gap) throw new Error("OFFICE_RESET_JOURNAL_GAP");
			const record = parseCompanyComputerResetPhaseRecord(value, plan),
				previous = records.at(-1);
			if (
				record.phase !== phase ||
				record.previousSha256 !== (previous ? officeDigest(previous) : null) ||
				!isDeepStrictEqual(value, record)
			)
				throw new Error("OFFICE_RESET_JOURNAL_CHANGED");
			records.push(record);
		}
		await syncDirectory(root);
		return new LxdOfficeResetJournal(root, plan, records);
	}
	/** The last locally acknowledged phase, or null before begin was recorded. */
	get phase(): CompanyComputerResetPhase | null {
		return this.#records.at(-1)?.phase ?? null;
	}
	get records(): readonly CompanyComputerResetPhaseRecord[] {
		return this.#records.map((record) => structuredClone(record));
	}
	evidenceSha256(phase: CompanyComputerResetPhase): string | undefined {
		return this.#records.find((record) => record.phase === phase)?.evidenceSha256;
	}
	/** Append the next phase only. A repeated identical advance is idempotent;
	 * any skipped, earlier or changed phase is refused. */
	async advance(phase: CompanyComputerResetPhase, evidenceSha256: string): Promise<CompanyComputerResetPhaseRecord> {
		const index = COMPANY_COMPUTER_RESET_PHASES.indexOf(phase);
		if (index < 0) throw new Error("OFFICE_RESET_JOURNAL_PHASE_INVALID");
		const existing = this.#records[index];
		if (existing) {
			if (existing.evidenceSha256 !== officeSha(evidenceSha256) || this.#records.length !== index + 1)
				throw new Error("OFFICE_RESET_JOURNAL_CHANGED");
			return structuredClone(existing);
		}
		if (this.#records.length !== index) throw new Error("OFFICE_RESET_JOURNAL_ORDER");
		const previous = this.#records.at(-1);
		const next = parseCompanyComputerResetPhaseRecord(
			{
				schema: "qorpera.office-reset-phase/v1",
				resetId: this.plan.resetId,
				phase,
				sequence: index + 1,
				previousSha256: previous ? officeDigest(previous) : null,
				evidenceSha256: officeSha(evidenceSha256),
			},
			this.plan,
		);
		const name = `${this.#prefix}${index + 1}.json`;
		await publish(this.root, name, Buffer.from(officeCanonical(next)));
		if (!isDeepStrictEqual((await readRecord(join(this.root, name), LIMIT)).value, next))
			throw new Error("OFFICE_RESET_JOURNAL_RACE");
		this.#records = [...this.#records, next];
		return structuredClone(next);
	}
}

/** Retained reset seed: the exact plan digest, the predecessor's attestation,
 * its physical stop evidence and the retained VM command lineage. Written
 * before begin while the old root is still readable; every later tick must
 * read the identical record, so a destroyed root never has to be reread. */
export interface LxdOfficeResetSeed {
	schema: "qorpera.lxd-office-reset-seed/v1";
	intentId: string;
	planSha256: string;
	hostBootId: string;
	attestation: CompanyComputerActivationAttestation;
	completionPath: string;
	stopCompletionSha256: string;
	startObservationSha256: string;
	bootObservationSha256: string;
	originalBootId: string;
	adoptionReceiptSha256: string;
	commands: readonly { commandId: string; action: "create" | "start" | "stop" }[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseLxdOfficeResetSeed(value: unknown): LxdOfficeResetSeed {
	const r = officeRecord(value, [
		"schema",
		"intentId",
		"planSha256",
		"hostBootId",
		"attestation",
		"completionPath",
		"stopCompletionSha256",
		"startObservationSha256",
		"bootObservationSha256",
		"originalBootId",
		"adoptionReceiptSha256",
		"commands",
	]);
	if (
		r.schema !== "qorpera.lxd-office-reset-seed/v1" ||
		typeof r.intentId !== "string" ||
		!UUID.test(r.intentId) ||
		typeof r.hostBootId !== "string" ||
		!UUID.test(r.hostBootId) ||
		typeof r.originalBootId !== "string" ||
		!UUID.test(r.originalBootId) ||
		(r.completionPath !== "/run/qorpera-office-preparation/service-stop-completion.json" &&
			!/^\/run\/qorpera-office-preparation\/service-stop-completion-[0-9a-f-]{36}\.json$/.test(
				String(r.completionPath),
			)) ||
		!Array.isArray(r.commands) ||
		r.commands.length < 2 ||
		r.commands.length > 128 ||
		r.commands.some(
			(command, index) =>
				!command ||
				typeof command !== "object" ||
				Object.keys(command).sort().join() !== "action,commandId" ||
				!UUID.test((command as { commandId: unknown }).commandId as string) ||
				(command as { action: unknown }).action !== (index === 0 ? "create" : index % 2 ? "start" : "stop"),
		)
	)
		throw new Error("INVALID_OFFICE_RESET_SEED");
	for (const key of [
		"planSha256",
		"stopCompletionSha256",
		"startObservationSha256",
		"bootObservationSha256",
		"adoptionReceiptSha256",
	])
		officeSha(r[key]);
	return structuredClone({
		...r,
		attestation: parseCompanyComputerActivationAttestation(r.attestation),
	}) as unknown as LxdOfficeResetSeed;
}
