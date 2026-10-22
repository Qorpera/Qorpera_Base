import { createHash } from "node:crypto";
import { POSTGRES_UUID_PATTERN as UUID } from "@qorpera/contracts";
import {
	DigitalPostAnswerTooLarge,
	type DigitalPostClient,
	type DigitalPostKey,
	DigitalPostKeyRefused,
	parseDigitalPostKey,
} from "./cloud-connector-digital-post.ts";
import { ConnectorRequestError } from "./cloud-connector-http.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import { type DigitalPostLetterLayout, layOutDigitalPostLetter } from "./digital-post-letter-files.ts";
import { DigitalPostLetterInvalid, readDigitalPostLetter } from "./digital-post-memo.ts";

/**
 * The company Digital Post sync (deploy/first-node/RUNTIME-DIGITAL-POST.md, part 2; migration 20260930529000). A
 * company's vault claims its sync when it is due (right after a connect, then every ten minutes), opens the sealed API
 * key, lists the letters Digital Post holds for the company's recipient system, and for each one: fetches it, reads
 * and lays it out, keeps it in the database (its summary, then its files in 1 MiB chunks, then the seal), and only
 * then sends Digital Post the business receipt, after which Digital Post deletes it. Writing the letters into the
 * company folder is the object gateway's (part 3), never the vault's.
 *
 * A letter Digital Post delivers again is kept once and receipted again. A letter the vault cannot read is held: not
 * receipted, so Digital Post moves it to Virk after seven days, and not fetched again meanwhile. Nothing here logs or
 * records a key or a letter's content: errors are fixed phrases.
 */

export interface DigitalPostSyncLease {
	readonly secretId: string;
	readonly version: number;
	readonly lease: string;
}

export interface DigitalPostKeptFile {
	readonly name: string;
	readonly mediaType: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface DigitalPostSyncAuthority {
	claimDigitalPostSync(signal: AbortSignal): Promise<unknown>;
	keepDigitalPostLetter(
		input: DigitalPostSyncLease & {
			memoId: string;
			summary: DigitalPostLetterLayout["summary"];
			files: readonly DigitalPostKeptFile[];
		},
		signal: AbortSignal,
	): Promise<unknown>;
	stageDigitalPostChunk(
		input: DigitalPostSyncLease & { letterId: string; fileIndex: number; chunkIndex: number; content: Uint8Array },
		signal: AbortSignal,
	): Promise<unknown>;
	sealDigitalPostLetter(input: DigitalPostSyncLease & { letterId: string }, signal: AbortSignal): Promise<unknown>;
	holdDigitalPostLetter(
		input: DigitalPostSyncLease & { memoId: string; reason: string },
		signal: AbortSignal,
	): Promise<unknown>;
	finishDigitalPostSync(
		input: DigitalPostSyncLease & {
			outcome: "current" | "more" | "failed" | "refused";
			systemId: string | null;
			receipted: readonly string[];
			error: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

export type DigitalPostSyncOutcome = "idle" | "current" | "more" | "failed" | "refused";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATABASE_DEADLINE_MS = 10_000;
/** One pass: the list, then every letter on it. The claim's lease is fifteen minutes. */
const PASS_DEADLINE_MS = 10 * 60_000;
const PASS_EVERY_MS = 60_000;
/** Pages of Digital Post's list a pass reads at most (50 letters each) before it gives the rest to the next pass. */
const LIST_PAGES = 20;
/** The chunk size the database stages a file in. */
export const DIGITAL_POST_CHUNK_BYTES = 1024 * 1024;
/** The most a letter's files may hold together (the database's bound); a larger letter is held for Virk. */
export const DIGITAL_POST_LETTER_STAGE_BYTES = 48 * 1024 * 1024;

interface Claim extends DigitalPostSyncLease {
	readonly companyId: string;
	readonly environmentId: string;
	readonly keyId: string;
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
	readonly held: ReadonlySet<string>;
}

function parseClaim(value: unknown): Claim | null {
	if (value === null) return null;
	const input = value as Record<string, unknown>;
	const base64 =
		typeof input?.encryptedEnvelopeBase64 === "string" ? input.encryptedEnvelopeBase64.replace(/\r?\n/g, "") : "";
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).sort().join() !==
			"companyId,encryptedEnvelopeBase64,envelopeSha256,environmentId,held,keyId,lease,schema,secretId,secretVersion" ||
		input.schema !== "qorpera.digital-post-sync-claim/v1" ||
		![input.companyId, input.environmentId, input.secretId, input.lease].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		!Number.isSafeInteger(input.secretVersion) ||
		(input.secretVersion as number) < 1 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		base64.length > 180_000 ||
		!BASE64.test(base64) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA.test(input.envelopeSha256) ||
		!Array.isArray(input.held) ||
		input.held.length > 1000 ||
		input.held.some((id) => typeof id !== "string" || !UUID.test(id))
	)
		throw new Error("Digital Post sync claim is invalid");
	return {
		companyId: input.companyId as string,
		environmentId: input.environmentId as string,
		secretId: input.secretId as string,
		version: input.secretVersion as number,
		lease: input.lease as string,
		keyId: input.keyId,
		encryptedEnvelopeBase64: base64,
		envelopeSha256: input.envelopeSha256,
		held: new Set(input.held as string[]),
	};
}

function parseKept(value: unknown): { letterId: string; state: "staging" | "kept" } {
	const input = value as Record<string, unknown>;
	if (
		!input ||
		typeof input !== "object" ||
		input.schema !== "qorpera.digital-post-letter-kept/v1" ||
		typeof input.letterId !== "string" ||
		!UUID.test(input.letterId) ||
		(input.state !== "staging" && input.state !== "kept")
	)
		throw new DigitalPostSyncError("the database did not keep the letter");
	return { letterId: input.letterId, state: input.state };
}

/** A failure whose message is a fixed phrase, safe to record. */
class DigitalPostSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DigitalPostSyncError";
	}
}

function failurePhrase(error: unknown, signal: AbortSignal): string {
	if (error instanceof DigitalPostSyncError) return error.message;
	if (error instanceof ConnectorRequestError) {
		if (error.reason === "forbidden")
			return "Digital Post refused the call: check the system's IP addresses and that its supplier is Qorpera's CVR";
		if (error.reason === "rate_limited") return "Digital Post asked us to wait";
		return "Digital Post did not answer as expected";
	}
	if (signal.aborted) return "the Digital Post pass took too long";
	return "the Digital Post pass failed";
}

const database = (): AbortSignal => AbortSignal.timeout(DATABASE_DEADLINE_MS);

/** One company authority's Digital Post sync. */
export class CloudDigitalPostSyncs {
	readonly #authority: DigitalPostSyncAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;
	readonly #post: Pick<DigitalPostClient, "available" | "letter" | "receipt">;
	readonly #now: () => Date;

	constructor(options: {
		authority: DigitalPostSyncAuthority;
		keyring: Pick<CloudSecretKeyring, "use">;
		post: Pick<DigitalPostClient, "available" | "letter" | "receipt">;
		now?: () => Date;
	}) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
		this.#post = options.post;
		this.#now = options.now ?? (() => new Date());
	}

	/** Claims the company's sync if it is due, takes the letters waiting and records the outcome. A sync claimed but not
	 * finished (the vault stopped) is offered again when its lease ends; what it kept stays kept. */
	async pass(signal: AbortSignal): Promise<DigitalPostSyncOutcome> {
		const claim = parseClaim(await this.#authority.claimDigitalPostSync(AbortSignal.any([signal, database()])));
		if (!claim) return "idle";
		const lease = { secretId: claim.secretId, version: claim.version, lease: claim.lease };
		const receipted: string[] = [];
		let systemId: string | null = null;
		const finish = (outcome: "current" | "more" | "failed" | "refused", error: string | null) =>
			// Recorded even when the pass is closing: Digital Post has been asked, and receipts may have gone.
			this.#authority.finishDigitalPostSync({ ...lease, outcome, systemId, receipted, error }, database());
		const passing = AbortSignal.any([signal, AbortSignal.timeout(PASS_DEADLINE_MS)]);
		let outcome: "current" | "more";
		try {
			outcome = await this.#withKey(claim, (key) => {
				systemId = key.systemId;
				return this.#take(claim, lease, key, receipted, passing);
			});
		} catch (error) {
			if (error instanceof DigitalPostKeyRefused) {
				await finish("refused", "Digital Post refused the company's key; connect Digital Post again");
				return "refused";
			}
			await finish("failed", failurePhrase(error, passing));
			return "failed";
		}
		await finish(outcome, null);
		return outcome;
	}

	/** Opens the key only for the pass; nothing that leaves holds it. */
	async #withKey<T>(claim: Claim, work: (key: DigitalPostKey) => Promise<T>): Promise<T> {
		const envelope = Buffer.from(claim.encryptedEnvelopeBase64, "base64");
		try {
			if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256)
				throw new DigitalPostSyncError("the envelope digest differs");
			// The keyring hides an error thrown inside it, so the outcome comes back as a value and is thrown here.
			const outcome = await this.#keyring.use(
				envelope,
				{
					companyId: claim.companyId,
					environmentId: claim.environmentId,
					secretId: claim.secretId,
					version: claim.version,
					keyId: claim.keyId,
				},
				async (fields): Promise<{ value: T } | { error: unknown }> => {
					let key: DigitalPostKey;
					try {
						key = parseDigitalPostKey(fields.api_key ?? "");
					} catch {
						// A key that is not one can never work: the member saves it again.
						return { error: new DigitalPostKeyRefused() };
					}
					try {
						return { value: await work(key) };
					} catch (error) {
						return { error };
					}
				},
			);
			if ("error" in outcome) throw outcome.error;
			return outcome.value;
		} catch (error) {
			if (
				error instanceof DigitalPostSyncError ||
				error instanceof DigitalPostKeyRefused ||
				error instanceof ConnectorRequestError
			)
				throw error;
			throw new DigitalPostSyncError(
				error instanceof Error && error.name === "AbortError"
					? "the Digital Post pass took too long"
					: "the letters could not be fetched or kept",
			);
		} finally {
			envelope.fill(0);
		}
	}

	/**
	 * The letters on Digital Post's list that are not held: fetched, kept, receipted. Held letters stay on the list until
	 * Digital Post moves them to Virk, so a page may hold nothing to take: the pass reads on, page by page. A receipt
	 * shifts the pages after it, so a pass that receipted something stops at the end of that page (`more`: the next pass
	 * starts again from the first page), and one that reached the last page is `current`.
	 */
	async #take(
		claim: Claim,
		lease: DigitalPostSyncLease,
		key: DigitalPostKey,
		receipted: string[],
		signal: AbortSignal,
	): Promise<"current" | "more"> {
		for (let page = 0; page < LIST_PAGES; page += 1) {
			const available = await this.#post.available(key, signal, page);
			let took = false;
			for (const memoId of available.ids) {
				if (claim.held.has(memoId)) continue;
				if (await this.#takeOne(lease, key, memoId, receipted, signal)) took = true;
			}
			if (available.complete) return "current";
			if (took) return "more";
		}
		return "current";
	}

	/** One letter: true when it was kept and receipted; false when Digital Post no longer had it or it was held. */
	async #takeOne(
		lease: DigitalPostSyncLease,
		key: DigitalPostKey,
		memoId: string,
		receipted: string[],
		signal: AbortSignal,
	): Promise<boolean> {
		signal.throwIfAborted();
		const hold = async (reason: string): Promise<false> => {
			await this.#authority.holdDigitalPostLetter({ ...lease, memoId, reason }, database());
			return false;
		};
		let xml: Uint8Array | null;
		try {
			xml = await this.#post.letter(key, memoId, signal);
		} catch (error) {
			if (error instanceof DigitalPostAnswerTooLarge) return hold("the letter is too large for Qorpera");
			throw error;
		}
		if (xml === null) return false;
		let layout: DigitalPostLetterLayout;
		try {
			layout = layOutDigitalPostLetter(readDigitalPostLetter(xml), this.#now());
		} catch (error) {
			return hold(error instanceof DigitalPostLetterInvalid ? error.message : "the letter could not be laid out");
		}
		if (layout.files.reduce((total, file) => total + file.bytes.byteLength, 0) > DIGITAL_POST_LETTER_STAGE_BYTES)
			return hold("the letter is too large for Qorpera");
		const kept = parseKept(
			await this.#authority.keepDigitalPostLetter(
				{
					...lease,
					memoId,
					summary: layout.summary,
					files: layout.files.map((file) => ({
						name: file.name,
						mediaType: file.mediaType,
						bytes: file.bytes.byteLength,
						sha256: file.sha256,
					})),
				},
				database(),
			),
		);
		if (kept.state === "staging") {
			for (const [fileIndex, file] of layout.files.entries())
				for (let start = 0; start < file.bytes.byteLength; start += DIGITAL_POST_CHUNK_BYTES)
					await this.#authority.stageDigitalPostChunk(
						{
							...lease,
							letterId: kept.letterId,
							fileIndex,
							chunkIndex: start / DIGITAL_POST_CHUNK_BYTES,
							content: file.bytes.subarray(start, start + DIGITAL_POST_CHUNK_BYTES),
						},
						database(),
					);
			if (
				parseKept(await this.#authority.sealDigitalPostLetter({ ...lease, letterId: kept.letterId }, database()))
					.state !== "kept"
			)
				throw new DigitalPostSyncError("the database did not keep the letter");
		}
		// Kept: only now may Digital Post delete it.
		await this.#post.receipt(key, memoId, layout.summary.messageUuid, this.#now(), signal);
		receipted.push(kept.letterId);
		return true;
	}
}

/** A single-company vault's loop: one pass a minute (a single cheap claim); a sync is due right after a connect, then
 * every ten minutes, so most passes find nothing. */
export class CloudDigitalPostSyncUpkeep {
	readonly #syncs: Pick<CloudDigitalPostSyncs, "pass">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	readonly #closing = new AbortController();
	#started = false;

	constructor(options: { syncs: Pick<CloudDigitalPostSyncs, "pass">; passEveryMs?: number; firstPassMs?: number }) {
		this.#syncs = options.syncs;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 20_000 + Math.floor(Math.random() * 60_000);
	}

	start(): void {
		if (this.#started || this.#closing.signal.aborted) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closing.signal.aborted) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closing.signal.aborted) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closing.abort();
		clearTimeout(this.#timer);
		await this.#running;
	}

	async pass(): Promise<void> {
		await logDigitalPostSyncPass(this.#syncs, this.#closing.signal);
	}
}

/** Runs one pass and logs its outcome, never a key, a sender or a letter. */
export async function logDigitalPostSyncPass(
	syncs: Pick<CloudDigitalPostSyncs, "pass">,
	signal: AbortSignal,
): Promise<void> {
	try {
		const outcome = await syncs.pass(signal);
		if (outcome === "refused")
			console.error("Digital Post sync: Digital Post refused a company's key; it must connect again.");
		if (outcome === "failed") console.error("Digital Post sync: a pass failed; it is tried again later.");
	} catch {
		console.error("Digital Post sync: a pass stopped on an error; the next pass tries again.");
	}
}
