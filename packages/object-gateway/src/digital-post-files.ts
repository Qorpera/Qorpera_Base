import { createHash } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	drainPlatformClaims,
	PlatformFolderProblem,
	PlatformFolderWriter,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * The Digital Post letters' writer (deploy/first-node/RUNTIME-DIGITAL-POST.md, part 3; migration 20260930530000). The
 * vault keeps each letter and its files in the database (part 2) and never writes the folder; this writer claims one
 * kept letter, reads its staged files back in pieces and checks each one's size and SHA-256, stages them, and commits
 * as the platform under the claim's operation key, in one change set: `digital-post/` and the year's folder when they
 * are missing, the letter's folder with all its files (one unit, so a letter is in the folder whole or not at all), and
 * the index `digital-post/letters.json` at the version the claim read. A letter's folder that is already there (an
 * earlier commit whose finish was lost) gets only the files it lacks; nothing is overwritten, and a path that holds
 * something else (`blocked`) writes nothing. Problems are reported as
 * codes, never with a message. Built switched off: the gateway runs it only with QORPERA_DIGITAL_POST_WRITER=1.
 */

const CLAIM_KEYS = [
	"schema",
	"letterId",
	"profileId",
	"environmentId",
	"attempt",
	"operationKey",
	"folder",
	"rootPresent",
	"yearPresent",
	"folderPresent",
	"blocked",
	"files",
	"indexVersion",
	"index",
	"leaseUntil",
] as const;
const FILE_KEYS = ["name", "mediaType", "bytes", "sha256", "version"] as const;
export const DIGITAL_POST_ROOT = "digital-post";
export const DIGITAL_POST_INDEX = "digital-post/letters.json";
/** The chunk size the vault staged in, and the piece the database answers at most (its answers stay under 1 MiB). */
const CHUNK_BYTES = 1024 * 1024;
const PIECE_BYTES = 512 * 1024;
/** The index stays within what the Mailbox reads of a folder file (256 KiB): the oldest letters are left out first. */
export const DIGITAL_POST_INDEX_MAX_BYTES = 240 * 1024;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINISH_MS = 15_000;

export interface DigitalPostLetterFile {
	readonly name: string;
	readonly mediaType: string;
	readonly bytes: number;
	readonly sha256: string;
	/** The file's version in the folder now, when the letter's folder already holds it. */
	readonly version: string | null;
}

export interface DigitalPostLetterClaim {
	readonly letterId: string;
	readonly profileId: string;
	readonly environmentId: string;
	readonly operationKey: string;
	readonly folder: string;
	readonly rootPresent: boolean;
	readonly yearPresent: boolean;
	readonly folderPresent: boolean;
	/** A path the letter needs holds something else: a folder or a link where a file goes, or the other way round. */
	readonly blocked: boolean;
	readonly files: readonly DigitalPostLetterFile[];
	readonly indexVersion: string | null;
	readonly index: readonly Record<string, unknown>[];
}

const problem = platformFolderProblem;
const reasonCode = (reason: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused");
const flag = (value: unknown): boolean => (typeof value === "boolean" ? value : problem("claim_invalid"));
const version = (value: unknown): string | null =>
	value === null ? null : typeof value === "string" && UUID.test(value) ? value : problem("claim_invalid");

/** A claim answer (`qorpera.digital-post-letter-claim/v1`), checked field by field; null when nothing is due. */
export function parseDigitalPostLetterClaim(value: unknown): DigitalPostLetterClaim | null {
	if (value === null) return null;
	const input = record(value, CLAIM_KEYS, "claim_invalid");
	const attempt = Number.isSafeInteger(input.attempt) && (input.attempt as number) >= 1 ? input.attempt : null;
	const folder = typeof input.folder === "string" ? input.folder : "";
	if (
		input.schema !== "qorpera.digital-post-letter-claim/v1" ||
		typeof input.letterId !== "string" ||
		!UUID.test(input.letterId) ||
		typeof input.profileId !== "string" ||
		!UUID.test(input.profileId) ||
		typeof input.environmentId !== "string" ||
		!UUID.test(input.environmentId) ||
		attempt === null ||
		input.operationKey !== `digital-post:${input.letterId}:${attempt}` ||
		!/^digital-post\/[0-9]{4}\/[^/]+$/.test(folder) ||
		!Array.isArray(input.files) ||
		input.files.length < 2 ||
		input.files.length > 103 ||
		!Array.isArray(input.index) ||
		input.index.length > 200 ||
		typeof input.leaseUntil !== "string"
	)
		problem("claim_invalid");
	try {
		parseCloudCompanyPath(folder);
	} catch {
		problem("claim_invalid");
	}
	const files = (input.files as unknown[]).map((item) => {
		const file = record(item, FILE_KEYS, "claim_invalid");
		if (
			typeof file.name !== "string" ||
			file.name.includes("/") ||
			typeof file.mediaType !== "string" ||
			!MEDIA_TYPE.test(file.mediaType) ||
			!Number.isSafeInteger(file.bytes) ||
			(file.bytes as number) < 0 ||
			(file.bytes as number) > 32 * 1024 * 1024 ||
			typeof file.sha256 !== "string" ||
			!SHA256.test(file.sha256)
		)
			problem("claim_invalid");
		try {
			parseCloudCompanyPath(`${folder}/${file.name as string}`);
		} catch {
			problem("claim_invalid");
		}
		return {
			name: file.name as string,
			mediaType: file.mediaType as string,
			bytes: file.bytes as number,
			sha256: file.sha256 as string,
			version: version(file.version),
		};
	});
	const index = (input.index as unknown[]).map((entry) =>
		entry && typeof entry === "object" && !Array.isArray(entry)
			? (entry as Record<string, unknown>)
			: problem("claim_invalid"),
	);
	return {
		letterId: input.letterId as string,
		profileId: input.profileId as string,
		environmentId: input.environmentId as string,
		operationKey: input.operationKey as string,
		folder,
		rootPresent: flag(input.rootPresent),
		yearPresent: flag(input.yearPresent),
		folderPresent: flag(input.folderPresent),
		blocked: flag(input.blocked),
		files,
		indexVersion: version(input.indexVersion),
		index,
	};
}

/** The index's text: the letters newest first as the vault summarized them, compact JSON with a final line break,
 * leaving out the oldest until it fits the Mailbox's read limit. */
export function digitalPostIndexText(letters: readonly Record<string, unknown>[]): string {
	let kept = letters.length;
	for (;;) {
		const text = `${JSON.stringify({ schema: "qorpera.digital-post-letters/v1", letters: letters.slice(0, kept) })}\n`;
		if (kept === 0 || new TextEncoder().encode(text).byteLength <= DIGITAL_POST_INDEX_MAX_BYTES) return text;
		kept -= 1;
	}
}

/** Each unit's outcome of a commit (`qorpera.folder-commit/v1`), in order. */
function commitOutcomes(value: unknown, count: number): { outcome: string; reason: string | null }[] {
	const units = (value as { schema?: unknown; units?: unknown } | null)?.units;
	if ((value as { schema?: unknown } | null)?.schema !== "qorpera.folder-commit/v1" || !Array.isArray(units))
		return problem("commit_invalid");
	if (units.length !== count) problem("commit_invalid");
	return units.map((unit) => {
		const item = unit as { outcome?: unknown; reason?: unknown };
		if (typeof item?.outcome !== "string") return problem("commit_invalid");
		return { outcome: item.outcome, reason: typeof item.reason === "string" ? item.reason : null };
	});
}

export interface DigitalPostLetterWriterOptions {
	readonly workerId: string;
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly leaseSeconds?: number;
}

export class DigitalPostLetterWriter {
	readonly #options: DigitalPostLetterWriterOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseSeconds: number;

	constructor(options: DigitalPostLetterWriterOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Digital Post letter writer identity is invalid");
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
		this.#leaseSeconds = options.leaseSeconds ?? 300;
		if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900)
			throw new Error("Digital Post letter writer lease is invalid");
	}

	/** Writes due letters until none is due or `max` were handled. Returns how many were handled. */
	writeDue(max = 10, signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<number> {
		return drainPlatformClaims(max, () => this.writeOne(signal), signal);
	}

	/** Claims one kept letter and writes it into the company folder; false when nothing is due. */
	async writeOne(signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<boolean> {
		const answer = await this.#options.authority.publisher(
			"qorpera_claim_digital_post_letter_file",
			{ p_worker: this.#options.workerId, p_lease_seconds: this.#leaseSeconds },
			AbortSignal.timeout(FINISH_MS),
		);
		let claim: DigitalPostLetterClaim | null;
		try {
			claim = parseDigitalPostLetterClaim(answer);
		} catch (error) {
			// A claim that names its letter is finished with the problem; anything else is left to its lease.
			const input = answer as { letterId?: unknown } | null;
			if (error instanceof PlatformFolderProblem && typeof input?.letterId === "string" && UUID.test(input.letterId))
				await this.#finish(input.letterId, error.code);
			throw error;
		}
		if (!claim) return false;
		let code: string | null = null;
		try {
			await this.#write(claim, signal);
		} catch (error) {
			code = platformFolderProblemCode(error);
		}
		await this.#finish(claim.letterId, code);
		return true;
	}

	async #write(claim: DigitalPostLetterClaim, signal: AbortSignal): Promise<void> {
		// Something else stands where the letter goes: nothing is written, and the letter keeps its bytes and backs off.
		if (claim.blocked) problem("path_taken");
		const missing = claim.files.map((file, index) => ({ file, index })).filter(({ file }) => file.version === null);
		const staged = new Map<number, unknown>();
		// Only what the folder lacks is read and staged: the whole letter, or the files an earlier write did not leave.
		for (const { file, index } of claim.folderPresent
			? missing
			: claim.files.map((file, index) => ({ file, index }))) {
			const bytes = await this.#staged(claim, file, index, signal);
			staged.set(
				index,
				await this.#folder.stage(
					claim.environmentId,
					bytes,
					{ mediaType: file.mediaType, executable: false },
					signal,
				),
			);
		}
		const year = claim.folder.split("/").slice(0, 2).join("/");
		const units: unknown[] = [
			...(claim.rootPresent ? [] : [{ op: "mkdir", path: DIGITAL_POST_ROOT }]),
			...(claim.yearPresent ? [] : [{ op: "mkdir", path: year }]),
		];
		if (!claim.folderPresent)
			units.push({
				op: "new_folder",
				path: claim.folder,
				contents: claim.files.map((file, index) => ({ path: file.name, kind: "file", file: staged.get(index) })),
			});
		else
			for (const { file, index } of missing)
				units.push({ op: "write", path: `${claim.folder}/${file.name}`, file: staged.get(index) });
		const indexFile = await this.#folder.stage(
			claim.environmentId,
			new TextEncoder().encode(digitalPostIndexText(claim.index)),
			{ mediaType: "application/json", executable: false },
			signal,
		);
		units.push({
			op: "write",
			path: DIGITAL_POST_INDEX,
			file: indexFile,
			...(claim.indexVersion ? { expectedVersion: claim.indexVersion } : {}),
		});
		const outcomes = commitOutcomes(
			await this.#folder.commit(claim.environmentId, claim.operationKey, units, signal),
			units.length,
		);
		// Any unit not saved (a folder made by someone since the claim read it, an index changed since): back off with its
		// reason; the next claim reads the folder again and writes only what is still missing.
		const failed = outcomes.find((unit) => unit.outcome !== "saved");
		if (failed) problem(reasonCode(failed.reason ?? failed.outcome));
	}

	/** One staged file, read back in pieces and checked against the size and SHA-256 it was kept with. */
	async #staged(
		claim: DigitalPostLetterClaim,
		file: DigitalPostLetterFile,
		index: number,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		const bytes = new Uint8Array(file.bytes);
		for (let offset = 0; offset < file.bytes; offset += PIECE_BYTES) {
			signal.throwIfAborted();
			const chunk = Math.floor(offset / CHUNK_BYTES);
			const length = Math.min(PIECE_BYTES, file.bytes - offset);
			const answer = (await this.#options.authority.publisher(
				"qorpera_read_digital_post_chunk",
				{
					p_worker: this.#options.workerId,
					p_letter_id: claim.letterId,
					p_file_index: index,
					p_chunk_index: chunk,
					p_offset: offset - chunk * CHUNK_BYTES,
					p_length: length,
				},
				signal,
			)) as { schema?: unknown; content?: unknown } | null;
			const content =
				answer?.schema === "qorpera.digital-post-chunk-piece/v1" && typeof answer.content === "string"
					? Buffer.from(answer.content, "base64")
					: problem("chunk_invalid");
			if (content.byteLength !== length) problem("chunk_invalid");
			bytes.set(content, offset);
		}
		if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) problem("chunk_invalid");
		return bytes;
	}

	/** Closes a claim on its own short deadline. `finished: false` means another writer holds the letter now. */
	async #finish(letterId: string, code: string | null): Promise<void> {
		const answer = (await this.#options.authority.publisher(
			"qorpera_finish_digital_post_letter_file",
			{ p_worker: this.#options.workerId, p_letter_id: letterId, p_problem: code },
			AbortSignal.timeout(FINISH_MS),
		)) as { schema?: unknown; finished?: unknown } | null;
		if (answer?.schema !== "qorpera.digital-post-letter-finish/v1" || typeof answer.finished !== "boolean")
			problem("finish_invalid");
	}
}
