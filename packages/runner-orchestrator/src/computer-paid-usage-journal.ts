import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type PaidComputerGuardRecord, parsePaidComputerGuardRecord } from "./computer-paid-guard.ts";
import {
	PAID_COMPUTER_USAGE_ENTRY_BYTES,
	PAID_COMPUTER_USAGE_PAGE_BYTES,
	PAID_COMPUTER_USAGE_ZERO,
	type PaidComputerUsageCursor,
	type PaidComputerUsageEntry,
	type PaidComputerUsageFrame,
	type PaidComputerUsagePage,
	type PaidComputerUsageReadOptions,
	paidComputerUsageCursor,
	paidComputerUsageFrame,
	parsePaidComputerUsageCursor,
	parsePaidComputerUsageEntry,
	parsePaidComputerUsageFrame,
} from "./computer-paid-usage.ts";
import { checkDirectory, code, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

interface Identity {
	permitId: string;
	allocationId: string;
	nodeId: string;
	epoch: string;
	instanceSha256: string;
	hostMachineIdSha256: string;
	hostBootId: string;
	physicalInstanceId: string;
	prestart: { guardIncarnationId: string; prepareSha256: string };
	cpuMillis: number;
	memoryBytes: number;
	tariffVersion: number;
}
interface Anchor {
	schema: "qorpera.computer-guard-usage-anchor/v1";
	identity: Identity;
	head: PaidComputerUsageFrame | null;
	lastRunning: PaidComputerUsageFrame | null;
	acknowledged: PaidComputerUsageFrame | null;
	sealed: boolean;
}
function identity(record: PaidComputerGuardRecord): Identity {
	const { permit, machine } = parsePaidComputerGuardRecord(record);
	if (permit.schema !== "qorpera.computer-usage-permit/v2" || !permit.prestart)
		throw new Error("PAID_USAGE_V2_REQUIRED");
	return {
		permitId: permit.permitId,
		allocationId: permit.allocationId,
		nodeId: permit.nodeId,
		epoch: permit.epoch,
		instanceSha256: permit.instanceSha256,
		hostMachineIdSha256: machine.hostMachineIdSha256,
		hostBootId: permit.hostBootId,
		physicalInstanceId: machine.physicalInstanceId,
		prestart: permit.prestart,
		cpuMillis: permit.cpuMillis,
		memoryBytes: permit.memoryBytes,
		tariffVersion: permit.tariffVersion,
	};
}
function entryIdentity(entry: PaidComputerUsageEntry): Identity {
	const p = entry.permit;
	return {
		permitId: p.permitId,
		allocationId: p.allocationId,
		nodeId: p.nodeId,
		epoch: p.epoch,
		instanceSha256: p.instanceSha256,
		hostMachineIdSha256: entry.hostMachineIdSha256,
		hostBootId: p.hostBootId,
		physicalInstanceId: entry.physicalInstanceId,
		prestart: p.prestart!,
		cpuMillis: p.cpuMillis,
		memoryBytes: p.memoryBytes,
		tariffVersion: p.tariffVersion,
	};
}
function sequenceName(sequence: number): string {
	return `${String(sequence).padStart(16, "0")}.json`;
}
function terminal(frame: PaidComputerUsageFrame): boolean {
	return parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).stopReceipt !== null;
}

/** One guard-process writer. Physical expiry never awaits this serializer.
 * A fsynced anchor fences append/ack ambiguity; corruption never becomes a
 * fresh sequence. Only an exact one-entry unpublished tail is recoverable. */
export class PaidComputerUsageJournal {
	readonly root: string;
	#anchor: Anchor | null = null;
	#ready = false;
	#unconfirmed = false;
	#pending: Promise<unknown> = Promise.resolve();
	constructor(root: string) {
		this.root = root;
	}
	#exclusive<T>(use: () => Promise<T>): Promise<T> {
		const work = this.#pending.catch(() => undefined).then(use);
		this.#pending = work;
		return work;
	}
	async #replace(name: string, value: unknown): Promise<void> {
		await checkDirectory(this.root);
		const temporary = join(this.root, `.write-${randomUUID()}`),
			bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, join(this.root, name));
			await syncDirectory(this.root);
		} finally {
			await unlink(temporary).catch((error) => {
				if (!code(error, "ENOENT")) throw error;
			});
		}
	}
	async #readFrame(sequence: number): Promise<PaidComputerUsageFrame> {
		const loaded = await readRecord(join(this.root, sequenceName(sequence)), PAID_COMPUTER_USAGE_ENTRY_BYTES);
		const frame = parsePaidComputerUsageFrame({
			sequence,
			sha256: createHash("sha256").update(loaded.bytes).digest("hex"),
			entryText: loaded.bytes.toString("utf8"),
		});
		return frame;
	}
	#confirmed(): Anchor {
		if (!this.#ready || !this.#anchor) throw new Error("PAID_USAGE_NOT_INITIALIZED");
		if (this.#unconfirmed) throw new Error("PAID_USAGE_UNCONFIRMED");
		return this.#anchor;
	}
	assertReady(): void {
		this.#confirmed();
	}
	async #assertAnchor(anchor: Anchor): Promise<void> {
		try {
			const actual = (await readRecord(join(this.root, "head.json"), 65536)).value;
			if (!isDeepStrictEqual(actual, anchor)) throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
		} catch (error) {
			this.#unconfirmed = true;
			throw error;
		}
	}
	async initialize(record: PaidComputerGuardRecord, create = false): Promise<void> {
		return this.#exclusive(async () => {
			if (this.#ready || this.#anchor) throw new Error("PAID_USAGE_ALREADY_INITIALIZED");
			const expected = identity(record);
			if (create) {
				// Only a new, never-dispatched guard may create an initial anchor. Existing
				// empty directories are ambiguous and must not reset retained history.
				if (record.startDispatched) throw new Error("PAID_USAGE_NEW_GUARD_REQUIRED");
				await mkdir(this.root, { mode: 0o700 });
				await syncDirectory(dirname(this.root));
				await checkDirectory(this.root);
				const anchor: Anchor = {
					schema: "qorpera.computer-guard-usage-anchor/v1",
					identity: expected,
					head: null,
					lastRunning: null,
					acknowledged: null,
					sealed: false,
				};
				await this.#replace("head.json", anchor);
				this.#anchor = anchor;
				this.#ready = true;
				return;
			}
			await checkDirectory(this.root);
			const raw = (await readRecord(join(this.root, "head.json"), 65536)).value;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PAID_USAGE_ANCHOR_INVALID");
			const a = raw as Record<string, unknown>;
			if (
				Object.keys(a).sort().join() !==
					["schema", "identity", "head", "lastRunning", "acknowledged", "sealed"].sort().join() ||
				a.schema !== "qorpera.computer-guard-usage-anchor/v1" ||
				typeof a.sealed !== "boolean" ||
				!isDeepStrictEqual(a.identity, expected)
			)
				throw new Error("PAID_USAGE_ANCHOR_INVALID");
			const head = a.head === null ? null : parsePaidComputerUsageFrame(a.head),
				lastRunning = a.lastRunning === null ? null : parsePaidComputerUsageFrame(a.lastRunning),
				acknowledged = a.acknowledged === null ? null : parsePaidComputerUsageFrame(a.acknowledged);
			if ((acknowledged?.sequence ?? 0) > (head?.sequence ?? 0) || (head !== null && terminal(head)) !== a.sealed)
				throw new Error("PAID_USAGE_ANCHOR_INVALID");
			if (
				lastRunning &&
				(lastRunning.sequence > (head?.sequence ?? 0) ||
					parsePaidComputerUsageEntry(JSON.parse(lastRunning.entryText)).sample.state !== "running")
			)
				throw new Error("PAID_USAGE_ANCHOR_INVALID");
			if (
				(head &&
					parsePaidComputerUsageEntry(JSON.parse(head.entryText)).sample.state === "running" &&
					!isDeepStrictEqual(head, lastRunning)) ||
				(acknowledged &&
					parsePaidComputerUsageEntry(JSON.parse(acknowledged.entryText)).sample.state === "running" &&
					(!lastRunning || lastRunning.sequence < acknowledged.sequence))
			)
				throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
			for (const frame of [head, acknowledged, lastRunning])
				if (
					frame &&
					!isDeepStrictEqual(entryIdentity(parsePaidComputerUsageEntry(JSON.parse(frame.entryText))), expected)
				)
					throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
			if (head && acknowledged?.sequence === head.sequence && !isDeepStrictEqual(acknowledged, head))
				throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
			if (head) {
				const entry = parsePaidComputerUsageEntry(JSON.parse(head.entryText));
				if (
					entry.permit.generation > record.permit.generation ||
					(entry.stopReceipt && !isDeepStrictEqual(entry.stopReceipt, record.stopReceipt))
				)
					throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
			}
			const anchor: Anchor = {
				schema: a.schema,
				identity: expected,
				head,
				lastRunning,
				acknowledged,
				sealed: a.sealed,
			};
			const names = (await readdir(this.root)).filter((name) => name !== "head.json" && !name.startsWith(".write-"));
			if (names.some((name) => !/^[0-9]{16}\.json$/.test(name))) throw new Error("PAID_USAGE_JOURNAL_INVALID");
			const pending = names.filter((name) => Number(name.slice(0, -5)) > (acknowledged?.sequence ?? 0)).sort();
			const required = (head?.sequence ?? 0) - (acknowledged?.sequence ?? 0);
			if (pending.length < required || pending.length > required + (a.sealed ? 0 : 1) || pending.length > 4096)
				throw new Error("PAID_USAGE_PREFIX_MISSING");
			let previous = acknowledged;
			for (let index = 0; index < pending.length; index++) {
				const sequence = (acknowledged?.sequence ?? 0) + index + 1;
				if (pending[index] !== sequenceName(sequence)) throw new Error("PAID_USAGE_PREFIX_MISSING");
				const frame = await this.#readFrame(sequence),
					entry = parsePaidComputerUsageEntry(JSON.parse(frame.entryText));
				this.#validateNext(expected, previous, entry);
				if (sequence === head?.sequence && !isDeepStrictEqual(head, frame))
					throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
				if (sequence === lastRunning?.sequence && !isDeepStrictEqual(frame, lastRunning))
					throw new Error("PAID_USAGE_ANCHOR_DIFFERS");
				previous = frame;
			}
			if (previous && previous.sequence > (head?.sequence ?? 0)) {
				anchor.head = previous;
				if (parsePaidComputerUsageEntry(JSON.parse(previous.entryText)).sample.state === "running")
					anchor.lastRunning = previous;
				anchor.sealed = terminal(previous);
				await this.#replace("head.json", anchor);
			}
			// A lost acknowledgement reply may leave old files. Validate exact retained
			// head when present, then remove only the already acknowledged prefix.
			for (const name of names)
				if (Number(name.slice(0, -5)) <= (acknowledged?.sequence ?? 0)) {
					const sequence = Number(name.slice(0, -5)),
						frame = await this.#readFrame(sequence);
					const entry = parsePaidComputerUsageEntry(JSON.parse(frame.entryText));
					if (
						!isDeepStrictEqual(entryIdentity(entry), expected) ||
						(sequence === acknowledged?.sequence && !isDeepStrictEqual(frame, acknowledged))
					)
						throw new Error("PAID_USAGE_ACK_LEFTOVER_DIFFERS");
				}
			for (const name of names)
				if (Number(name.slice(0, -5)) <= (acknowledged?.sequence ?? 0)) await unlink(join(this.root, name));
			await syncDirectory(this.root);
			this.#anchor = anchor;
			this.#ready = true;
		});
	}
	#validateNext(expected: Identity, previous: PaidComputerUsageFrame | null, entry: PaidComputerUsageEntry): void {
		const cursor = previous ? paidComputerUsageCursor(previous) : PAID_COMPUTER_USAGE_ZERO;
		if (
			!isDeepStrictEqual(entryIdentity(entry), expected) ||
			entry.sequence !== cursor.sequence + 1 ||
			entry.previousSha256 !== cursor.sha256 ||
			entry.sample.previousObservationId !== cursor.observationId ||
			(previous && terminal(previous))
		)
			throw new Error("PAID_USAGE_CHAIN_DIFFERS");
		if (previous) {
			const prior = parsePaidComputerUsageEntry(JSON.parse(previous.entryText));
			if (
				entry.permit.generation < prior.permit.generation ||
				entry.permit.generation > prior.permit.generation + 1 ||
				(entry.sample.hostBootId === prior.sample.hostBootId &&
					entry.sample.hostUptimeMs < prior.sample.hostUptimeMs) ||
				Date.parse(entry.sample.observedAt) < Date.parse(prior.sample.observedAt) ||
				(prior.sample.guestBootId !== null &&
					entry.sample.guestBootId !== null &&
					prior.sample.guestBootId !== entry.sample.guestBootId)
			)
				throw new Error("PAID_USAGE_CHAIN_DIFFERS");
			if (
				entry.permit.generation === prior.permit.generation &&
				(entry.permit.reservationId !== prior.permit.reservationId ||
					entry.permit.issuedAt !== prior.permit.issuedAt ||
					entry.permit.deadline !== prior.permit.deadline ||
					entry.deadlineUptimeMs !== prior.deadlineUptimeMs)
			)
				throw new Error("PAID_USAGE_AUTHORITY_DIFFERS");
			if (
				entry.permit.generation > prior.permit.generation &&
				(entry.permit.reservationId === prior.permit.reservationId ||
					entry.deadlineUptimeMs <= prior.deadlineUptimeMs ||
					Date.parse(entry.permit.deadline) <= Date.parse(prior.permit.deadline))
			)
				throw new Error("PAID_USAGE_AUTHORITY_DIFFERS");
		}
	}
	async append(value: PaidComputerUsageEntry): Promise<PaidComputerUsageFrame> {
		return this.#exclusive(async () => {
			const anchor = this.#confirmed(),
				entry = parsePaidComputerUsageEntry(value),
				frame = paidComputerUsageFrame(entry);
			if (anchor.sealed) throw new Error("PAID_USAGE_SEALED");
			if ((anchor.head?.sequence ?? 0) - (anchor.acknowledged?.sequence ?? 0) >= 4096)
				throw new Error("PAID_USAGE_OUTBOX_FULL");
			this.#validateNext(anchor.identity, anchor.head, entry);
			try {
				await this.#assertAnchor(anchor);
				// An existing file can only be an interrupted append from this same guard.
				const existing = await this.#readFrame(frame.sequence).catch((error) => {
					if (!code(error, "ENOENT")) throw error;
					return null;
				});
				if (existing && !isDeepStrictEqual(existing, frame)) throw new Error("PAID_USAGE_APPEND_DIFFERS");
				if (!existing) {
					const temporary = join(this.root, `.write-${randomUUID()}`),
						file = await open(
							temporary,
							constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
							0o600,
						);
					try {
						await file.writeFile(frame.entryText);
						await file.sync();
					} finally {
						await file.close();
					}
					await rename(temporary, join(this.root, sequenceName(frame.sequence)));
					await syncDirectory(this.root);
				}
				const next = {
					...anchor,
					head: frame,
					lastRunning: entry.sample.state === "running" ? frame : anchor.lastRunning,
					sealed: entry.stopReceipt !== null,
				};
				await this.#replace("head.json", next);
				this.#anchor = next;
				return frame;
			} catch (error) {
				this.#unconfirmed = true;
				throw error;
			}
		});
	}
	async lastRunning(): Promise<PaidComputerUsageEntry | null> {
		return this.#exclusive(async () => {
			const frame = this.#confirmed().lastRunning;
			return frame ? parsePaidComputerUsageEntry(JSON.parse(frame.entryText)) : null;
		});
	}
	async latest(): Promise<PaidComputerUsageEntry | null> {
		return this.#exclusive(async () => {
			const head = this.#confirmed().head;
			return head ? parsePaidComputerUsageEntry(JSON.parse(head.entryText)) : null;
		});
	}
	async read(options: PaidComputerUsageReadOptions = {}, sealing = false): Promise<PaidComputerUsagePage> {
		return this.#exclusive(async () => {
			const anchor = this.#confirmed(),
				acknowledgedThrough = anchor.acknowledged
					? paidComputerUsageCursor(anchor.acknowledged)
					: { ...PAID_COMPUTER_USAGE_ZERO },
				head = anchor.head ? paidComputerUsageCursor(anchor.head) : { ...PAID_COMPUTER_USAGE_ZERO };
			await this.#assertAnchor(anchor);
			const after = options.afterSequence ?? acknowledgedThrough.sequence,
				limit = options.limit ?? 16;
			if (
				!Number.isSafeInteger(after) ||
				after < acknowledgedThrough.sequence ||
				after > head.sequence ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 16
			)
				throw new Error("PAID_USAGE_READ_INVALID");
			const entries: PaidComputerUsageFrame[] = [];
			for (let sequence = after + 1; sequence <= head.sequence && entries.length < limit; sequence++) {
				const frame = await this.#readFrame(sequence).catch((error) => {
					this.#unconfirmed = true;
					throw error;
				});
				if (Buffer.byteLength(JSON.stringify([...entries, frame])) > PAID_COMPUTER_USAGE_PAGE_BYTES) break;
				entries.push(frame);
			}
			return {
				schema: "qorpera.computer-guard-usage-page/v1",
				permitId: anchor.identity.permitId,
				epoch: anchor.identity.epoch,
				acknowledgedThrough,
				head,
				entries,
				state: anchor.sealed ? "sealed" : sealing ? "sealing" : "open",
				finalSequence: anchor.sealed ? head.sequence : null,
			};
		});
	}
	async acknowledge(value: PaidComputerUsageCursor): Promise<PaidComputerUsageCursor> {
		return this.#exclusive(async () => {
			const anchor = this.#confirmed(),
				cursor = parsePaidComputerUsageCursor(value),
				old = anchor.acknowledged ? paidComputerUsageCursor(anchor.acknowledged) : { ...PAID_COMPUTER_USAGE_ZERO };
			if (cursor.sequence < old.sequence) throw new Error("PAID_USAGE_ACK_STALE");
			if (cursor.sequence === old.sequence) {
				if (!isDeepStrictEqual(cursor, old)) throw new Error("PAID_USAGE_ACK_DIFFERS");
				return old;
			}
			if (!anchor.head || cursor.sequence > anchor.head.sequence) throw new Error("PAID_USAGE_ACK_AHEAD");
			const frame = await this.#readFrame(cursor.sequence).catch((error) => {
				this.#unconfirmed = true;
				throw error;
			});
			if (!isDeepStrictEqual(paidComputerUsageCursor(frame), cursor)) throw new Error("PAID_USAGE_ACK_DIFFERS");
			try {
				await this.#assertAnchor(anchor);
				const next = { ...anchor, acknowledged: frame };
				await this.#replace("head.json", next);
				this.#anchor = next;
				for (let sequence = old.sequence + 1; sequence <= cursor.sequence; sequence++)
					await unlink(join(this.root, sequenceName(sequence)));
				await syncDirectory(this.root);
				return cursor;
			} catch (error) {
				this.#unconfirmed = true;
				throw error;
			}
		});
	}
}
