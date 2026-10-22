import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	commitUnitOutcome,
	drainPlatformClaims,
	PlatformFolderProblem,
	PlatformFolderWriter,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * The company bank summary's writer (Bank connection part 3, migration 20260930528000). The vault records each company's
 * bank summary (`qorpera.bank-summary/v1`, cloud-bank-sync.ts) in the database and never writes the folder; this writer
 * claims one company whose newest summary the folder lacks, makes `bank/` when it is missing, writes the summary as
 * `bank/summary.json` (the file the Bank page draws, packages/web/src/app/bank-page.ts) as the platform under the claim's
 * operation key at the version the claim read, and finishes the claim. The database checked the summary's shape when the
 * vault recorded it; the web parses it strictly again. Problems are reported as codes, never with a message. Built
 * switched off: the gateway runs it only with QORPERA_BANK_SUMMARY_WRITER=1.
 */

/** Every field a claim carries; any other refuses it. */
const CLAIM_KEYS = [
	"schema",
	"profileId",
	"environmentId",
	"generation",
	"attempt",
	"operationKey",
	"folderPresent",
	"currentVersion",
	"summary",
	"leaseUntil",
] as const;
export const BANK_SUMMARY_FOLDER = "bank";
export const BANK_SUMMARY_PATH = "bank/summary.json";
const MEDIA_TYPE = "application/json";
/** The database keeps a summary of at most 256 KiB. */
const MAX_FILE_BYTES = 512 * 1024;
/** A claim and a finish get their own short deadline, so a drain that ran out of time still takes and closes a claim
 * whole. */
const FINISH_MS = 15_000;

export interface BankSummaryClaim {
	readonly profileId: string;
	readonly environmentId: string;
	readonly generation: number;
	readonly operationKey: string;
	readonly folderPresent: boolean;
	/** The file's version now, which the commit expects; null when there is none. */
	readonly currentVersion: string | null;
	readonly summary: Record<string, unknown>;
}

const problem = platformFolderProblem;

/** A commit's reason as a problem code the finish accepts; anything else is `refused`. */
const reasonCode = (reason: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused");

/** A claim answer (`qorpera.bank-summary-claim/v1`), checked field by field; null when nothing is due. */
export function parseBankSummaryClaim(value: unknown): BankSummaryClaim | null {
	if (value === null) return null;
	const input = record(value, CLAIM_KEYS, "claim_invalid");
	const whole = (field: unknown) =>
		Number.isSafeInteger(field) && (field as number) >= 1 ? (field as number) : problem("claim_invalid");
	const generation = whole(input.generation);
	const attempt = whole(input.attempt);
	const summary = input.summary as Record<string, unknown> | null;
	if (
		input.schema !== "qorpera.bank-summary-claim/v1" ||
		typeof input.profileId !== "string" ||
		!UUID.test(input.profileId) ||
		typeof input.environmentId !== "string" ||
		!UUID.test(input.environmentId) ||
		input.operationKey !== `bank-summary:${input.profileId}:${generation}:${attempt}` ||
		typeof input.folderPresent !== "boolean" ||
		(input.currentVersion !== null &&
			!(typeof input.currentVersion === "string" && UUID.test(input.currentVersion))) ||
		typeof input.leaseUntil !== "string" ||
		!summary ||
		typeof summary !== "object" ||
		Array.isArray(summary) ||
		summary.schema !== "qorpera.bank-summary/v1"
	)
		problem("claim_invalid");
	return {
		profileId: input.profileId as string,
		environmentId: input.environmentId as string,
		generation,
		operationKey: input.operationKey as string,
		folderPresent: input.folderPresent as boolean,
		currentVersion: input.currentVersion as string | null,
		summary: summary as Record<string, unknown>,
	};
}

/** The file's text: the summary as the vault recorded it, two-space JSON with a final line break. */
export function bankSummaryText(summary: Record<string, unknown>): string {
	return `${JSON.stringify(summary, null, 2)}\n`;
}

export interface BankSummaryWriterOptions {
	readonly workerId: string;
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly leaseSeconds?: number;
}

export class BankSummaryWriter {
	readonly #options: BankSummaryWriterOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseSeconds: number;

	constructor(options: BankSummaryWriterOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Bank summary writer identity is invalid");
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
		this.#leaseSeconds = options.leaseSeconds ?? 60;
		if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900)
			throw new Error("Bank summary writer lease is invalid");
	}

	/** Writes due summaries until none is due or `max` were handled. Returns how many were handled. */
	writeDue(max = 20, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<number> {
		return drainPlatformClaims(max, () => this.writeOne(signal), signal);
	}

	/** Claims one due company and writes its bank/summary.json; false when nothing is due. */
	async writeOne(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<boolean> {
		const answer = await this.#options.authority.publisher(
			"qorpera_claim_bank_summary_file",
			{ p_worker: this.#options.workerId, p_lease_seconds: this.#leaseSeconds },
			AbortSignal.timeout(FINISH_MS),
		);
		let claim: BankSummaryClaim | null;
		try {
			claim = parseBankSummaryClaim(answer);
		} catch (error) {
			// A claim that names its company and generation is finished with the problem; anything else is left to its lease.
			const input = answer as { profileId?: unknown; generation?: unknown } | null;
			if (
				error instanceof PlatformFolderProblem &&
				typeof input?.profileId === "string" &&
				UUID.test(input.profileId) &&
				Number.isSafeInteger(input.generation)
			)
				await this.#finish(input.profileId, input.generation as number, error.code);
			throw error;
		}
		if (!claim) return false;
		let code: string | null = null;
		try {
			await this.#write(claim, signal);
		} catch (error) {
			code = platformFolderProblemCode(error);
		}
		await this.#finish(claim.profileId, claim.generation, code);
		return true;
	}

	async #write(claim: BankSummaryClaim, signal: AbortSignal): Promise<void> {
		if (!claim.folderPresent) {
			const made = commitUnitOutcome(
				await this.#folder.commit(
					claim.environmentId,
					`${claim.operationKey}:folder`,
					[{ op: "mkdir", path: BANK_SUMMARY_FOLDER }],
					signal,
				),
			);
			// Made now, or already there (a member made it since the claim read the folder).
			if (made.outcome !== "saved" && made.reason !== "exists") problem(reasonCode(made.reason ?? made.outcome));
		}
		const bytes = new TextEncoder().encode(bankSummaryText(claim.summary));
		if (bytes.byteLength > MAX_FILE_BYTES) problem("file_too_large");
		const file = await this.#folder.stage(
			claim.environmentId,
			bytes,
			{ mediaType: MEDIA_TYPE, executable: false },
			signal,
		);
		const unit = commitUnitOutcome(
			await this.#folder.commit(
				claim.environmentId,
				claim.operationKey,
				[
					{
						op: "write",
						path: BANK_SUMMARY_PATH,
						file,
						...(claim.currentVersion ? { expectedVersion: claim.currentVersion } : {}),
					},
				],
				signal,
			),
		);
		// Not saved (the file changed since the claim read it, say): back off with the reason; the next claim reads it again.
		if (unit.outcome !== "saved") problem(reasonCode(unit.reason ?? unit.outcome));
	}

	/** Closes a claim on its own short deadline. `finished: false` means another writer holds the company now. */
	async #finish(profileId: string, generation: number, code: string | null): Promise<void> {
		const answer = (await this.#options.authority.publisher(
			"qorpera_finish_bank_summary_file",
			{ p_worker: this.#options.workerId, p_profile_id: profileId, p_generation: generation, p_problem: code },
			AbortSignal.timeout(FINISH_MS),
		)) as { schema?: unknown; finished?: unknown } | null;
		if (answer?.schema !== "qorpera.bank-summary-finish/v1" || typeof answer.finished !== "boolean")
			problem("finish_invalid");
	}
}
