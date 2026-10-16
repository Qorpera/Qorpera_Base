import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeServiceStopClient } from "./lxd-client.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { type LxdOfficeServiceStopIdentity, LxdOfficeServiceStopJournal } from "./lxd-office-service-stop-journal.ts";

interface RetryRecord {
	schema: "qorpera.lxd-office-stop-retry/v1";
	identitySha256: string;
	attempt: number;
	phase: "creating" | "active";
	retryAtMs: number | null;
}
type Client = Pick<LxdOfficeServiceStopClient, "submitOfficeServiceStop" | "inspectOfficeServiceStop">;

/** One replaceable, fsynced schedule under the supervisor's kernel lock. Each
 * attempt still has its own immutable dispatch journal. Only service stop may
 * repeat: the guest's retained claim and nonblocking lock make the same command
 * safe even when LXD forgot whether an earlier invocation finished. */
export class LxdOfficeStopRetries {
	readonly #root: string;
	readonly #identity: LxdOfficeServiceStopIdentity;
	readonly #client: Client;
	readonly #now: () => number;
	readonly #prefix: string;
	readonly #name: string;
	#record: RetryRecord | undefined;

	private constructor(root: string, identity: LxdOfficeServiceStopIdentity, client: Client, now: () => number) {
		this.#root = root;
		this.#identity = identity;
		this.#client = client;
		this.#now = now;
		const suffix = `${identity.binding.allocationId}-${identity.transitionId}`;
		this.#prefix = `service-stop-retry-${suffix}-`;
		this.#name = `service-stop-retries-${suffix}.json`;
	}

	static async open(root: string, identity: LxdOfficeServiceStopIdentity, client: Client, now = Date.now) {
		await checkDirectory(root);
		const retries = new LxdOfficeStopRetries(root, identity, client, now);
		try {
			const value = (await readRecord(join(root, retries.#name))).value as RetryRecord;
			if (
				!value ||
				Object.keys(value).sort().join() !== "attempt,identitySha256,phase,retryAtMs,schema" ||
				value.schema !== "qorpera.lxd-office-stop-retry/v1" ||
				value.identitySha256 !== officeDigest(identity) ||
				!Number.isSafeInteger(value.attempt) ||
				value.attempt < 0 ||
				(value.phase !== "active" && value.phase !== "creating") ||
				(value.attempt === 0 && value.phase !== "active") ||
				(value.phase === "creating" && value.retryAtMs !== null) ||
				(value.retryAtMs !== null && (!Number.isSafeInteger(value.retryAtMs) || value.retryAtMs < 1))
			)
				throw new Error("invalid stop retry schedule");
			retries.#record = value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			if (
				(await readdir(root)).some((name) =>
					[retries.#prefix, `.creating-${retries.#prefix}`, `.retired-${retries.#prefix}`].some((prefix) =>
						name.startsWith(prefix),
					),
				)
			)
				throw new Error("stop retry schedule lost");
		}
		return retries;
	}

	async #save(value: RetryRecord): Promise<void> {
		await checkDirectory(this.#root);
		let previous: unknown;
		try {
			previous = (await readRecord(join(this.#root, this.#name))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (!isDeepStrictEqual(previous, this.#record)) throw new Error("stop retry schedule changed");
		const temporary = join(this.#root, `.write-${randomUUID()}`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(`${JSON.stringify(value)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, join(this.#root, this.#name));
			await syncDirectory(this.#root);
			this.#record = value;
		} finally {
			await unlink(temporary).catch((error) => {
				if (!code(error, "ENOENT")) throw error;
			});
		}
	}

	async #exists(attempt: number, prefix = ""): Promise<boolean> {
		try {
			await lstat(join(this.#root, `${prefix}${this.#prefix}${attempt}`));
			return true;
		} catch (error) {
			if (code(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #prepare(signal: AbortSignal): Promise<LxdOfficeServiceStopJournal> {
		const record = this.#record!;
		if (record.phase !== "creating" || record.attempt < 1) throw new Error("stop retry is not reserved");
		signal.throwIfAborted();
		// Rename validated evidence out of the observer's namespace before
		// recursive removal. An interrupted removal then has a durable tombstone
		// name and can resume without treating partial cleanup as lost evidence.
		if (record.attempt > 1) {
			const previous = record.attempt - 1;
			const retired = join(this.#root, `.retired-${this.#prefix}${previous}`);
			if (await this.#exists(previous)) {
				if (await this.#exists(previous, ".retired-")) throw new Error("duplicate retired stop retry");
				await LxdOfficeServiceStopJournal.open(this.#root, { ...this.#identity, attempt: previous }, this.#client);
				await rename(join(this.#root, `${this.#prefix}${previous}`), retired);
				await syncDirectory(this.#root);
			}
			if (await this.#exists(previous, ".retired-")) {
				await checkDirectory(retired);
				await rm(retired, { recursive: true });
				await syncDirectory(this.#root);
			}
		}
		const journal = await LxdOfficeServiceStopJournal.open(
			this.#root,
			{ ...this.#identity, attempt: record.attempt },
			this.#client,
			await this.#exists(record.attempt),
		);
		if ((await journal.observe(signal)).state !== "not_dispatched") throw new Error("unarmed stop retry dispatched");
		await this.#save({ ...record, phase: "active" });
		return journal;
	}

	async current(signal: AbortSignal): Promise<LxdOfficeServiceStopJournal | undefined> {
		const record = this.#record;
		if (!record || record.attempt === 0) return undefined;
		if (record.phase === "creating") return this.#prepare(signal);
		// An active attempt is never recreated if its journal disappeared.
		return LxdOfficeServiceStopJournal.open(this.#root, { ...this.#identity, attempt: record.attempt }, this.#client);
	}

	async afterFailure(signal: AbortSignal, mayDispatch = true): Promise<LxdOfficeServiceStopJournal | undefined> {
		signal.throwIfAborted();
		const now = this.#now();
		if (!Number.isSafeInteger(now) || now < 1 || now > Number.MAX_SAFE_INTEGER - 600000)
			throw new Error("stop retry clock unavailable");
		const record = this.#record;
		if (!record) {
			await this.#save({
				schema: "qorpera.lxd-office-stop-retry/v1",
				identitySha256: officeDigest(this.#identity),
				attempt: 0,
				phase: "active",
				retryAtMs: now + 30000,
			});
			return undefined;
		}
		if (record.phase !== "active") throw new Error("stop retry is not active");
		if (record.retryAtMs === null) {
			// Count the wait from the first observation without a completion, not
			// from dispatch: a long-running attempt must still back off after failing.
			await this.#save({ ...record, retryAtMs: now + Math.min(30000 * 2 ** Math.min(record.attempt, 5), 600000) });
			return undefined;
		}
		if (!mayDispatch || now < record.retryAtMs) return undefined;
		const attempt = record.attempt + 1;
		if (!Number.isSafeInteger(attempt)) throw new Error("stop retry sequence exhausted");
		await this.#save({
			...record,
			attempt,
			phase: "creating",
			retryAtMs: null,
		});
		return this.#prepare(signal);
	}
}
