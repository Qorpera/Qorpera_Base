import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	parseCloudCodingCommandRead,
} from "@qorpera/contracts";

const UTF8_DECODER = new TextDecoder("utf8", { ignoreBOM: true });
const DEFAULT_FLUSH_BYTES = 65_536;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const RING_OPEN_RETRIES = 3;
const RING_RETRY_DELAY_MS = 5;

export interface CollectCodingCommandOutputOptions {
	readonly flushBytes?: number;
	readonly flushIntervalMs?: number;
	readonly ring?: {
		readonly path: string;
	};
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
	let offset = 0;
	while (offset < chunk.length) {
		const written = await handle.write(chunk, offset, chunk.length - offset);
		if (!written.bytesWritten) throw new Error("CODING_LOG_WRITE_FAILED");
		offset += written.bytesWritten;
	}
}

async function readAll(
	handle: FileHandle,
	target: Buffer,
	targetOffset: number,
	length: number,
	fileOffset: number,
): Promise<void> {
	let used = 0;
	while (used < length) {
		const read = await handle.read(target, targetOffset + used, length - used, fileOffset + used);
		if (!read.bytesRead) break;
		used += read.bytesRead;
	}
	if (used !== length) throw new Error("CODING_LOG_CHANGED");
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openLogSnapshot(options: {
	path: string;
	owner: number;
	maxBytes: number;
	ring: boolean;
}): Promise<{ handle: FileHandle; stat: Stats; prevHandle?: FileHandle }> {
	const prevPath = `${options.path}.prev`;
	for (let attempt = 0; attempt < RING_OPEN_RETRIES; attempt += 1) {
		let handle: FileHandle;
		try {
			handle = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if (options.ring && isEnoent(error) && attempt + 1 < RING_OPEN_RETRIES) {
				const prevExists = await lstat(prevPath)
					.then(() => true)
					.catch(() => false);
				if (prevExists) {
					await sleep(RING_RETRY_DELAY_MS);
					continue;
				}
			}
			throw error;
		}
		let stat: Stats;
		let unlinkedDuringRotation = false;
		try {
			stat = await handle.stat();
			if (options.ring && stat.nlink === 0 && attempt + 1 < RING_OPEN_RETRIES) {
				unlinkedDuringRotation = true;
			} else if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.uid !== options.owner ||
				stat.size > options.maxBytes + 1
			)
				throw new Error("INVALID_CODING_GUEST_OUTPUT");
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
		if (unlinkedDuringRotation) {
			await handle.close().catch(() => undefined);
			await sleep(RING_RETRY_DELAY_MS);
			continue;
		}
		if (!options.ring) return { handle, stat };
		let prevHandle: FileHandle;
		try {
			prevHandle = await open(prevPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if (isEnoent(error)) return { handle, stat };
			await handle.close().catch(() => undefined);
			throw error;
		}
		try {
			const prevStat = await prevHandle.stat();
			const currentPathStat = await lstat(options.path).catch(() => undefined);
			const rotatedDuringOpen =
				(prevStat.ino === stat.ino && prevStat.dev === stat.dev) ||
				!currentPathStat ||
				currentPathStat.ino !== stat.ino ||
				currentPathStat.dev !== stat.dev;
			if (rotatedDuringOpen) {
				await prevHandle.close().catch(() => undefined);
				await handle.close().catch(() => undefined);
				if (attempt + 1 < RING_OPEN_RETRIES) {
					await sleep(RING_RETRY_DELAY_MS);
					continue;
				}
				throw new Error("CODING_LOG_CHANGED");
			}
			if (
				!prevStat.isFile() ||
				prevStat.nlink !== 1 ||
				prevStat.uid !== options.owner ||
				prevStat.size !== options.maxBytes ||
				stat.size > options.maxBytes
			)
				throw new Error("INVALID_CODING_GUEST_OUTPUT");
			return { handle, stat, prevHandle };
		} catch (error) {
			await prevHandle.close().catch(() => undefined);
			await handle.close().catch(() => undefined);
			throw error;
		}
	}
	throw new Error("CODING_LOG_CHANGED");
}

function asciiEscapedSize(byte: number): number {
	if (byte >= 0x20 && byte !== 0x22 && byte !== 0x5c) return 1;
	if (
		byte === 0x22 ||
		byte === 0x5c ||
		byte === 0x08 ||
		byte === 0x09 ||
		byte === 0x0a ||
		byte === 0x0c ||
		byte === 0x0d
	)
		return 2;
	return 6;
}

export async function collectCodingCommandOutput(
	streams: readonly NodeJS.ReadableStream[],
	handle: FileHandle,
	maxBytes: number,
	options: CollectCodingCommandOutputOptions = {},
): Promise<void> {
	const flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES;
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	if (
		!Number.isSafeInteger(flushBytes) ||
		flushBytes < 1 ||
		!Number.isSafeInteger(flushIntervalMs) ||
		flushIntervalMs < 1
	)
		throw new Error("INVALID_CODING_LOG_FLUSH_OPTIONS");
	const ringPath = options.ring?.path;
	if (ringPath !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
		throw new Error("INVALID_CODING_LOG_LIMIT");
	const prevPath = ringPath === undefined ? undefined : `${ringPath}.prev`;
	let acceptedBytes = 0;
	let activeHandle = handle;
	let ownsActive = false;
	let currBytes = ringPath === undefined ? 0 : (await handle.stat()).size;
	let queuedChunks: Buffer[] = [];
	let queuedBytes = 0;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let lastSyncAt = performance.now();
	let dirtySinceSync = false;
	let writeChain = Promise.resolve();
	let failure: unknown;
	let rejectOnFailure: ((error: unknown) => void) | undefined;
	const failed = new Promise<never>((_resolve, reject) => {
		rejectOnFailure = reject;
	});
	failed.catch(() => undefined);

	const clearTimer = (): void => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
	};
	const recordFailure = (error: unknown): void => {
		if (failure === undefined) {
			failure = error;
			clearTimer();
			rejectOnFailure?.(error);
		}
	};
	const rotate = async (): Promise<void> => {
		await activeHandle.datasync();
		dirtySinceSync = false;
		if (ownsActive) {
			await activeHandle.close();
			ownsActive = false;
		}
		await rename(ringPath!, prevPath!);
		activeHandle = await open(
			ringPath!,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		ownsActive = true;
		currBytes = 0;
		lastSyncAt = performance.now();
	};
	const drainBatch = async (batch: Buffer[], syncMode: "ifDue" | "datasync" | "sync"): Promise<void> => {
		if (failure !== undefined) throw failure;
		const data = batch.length === 0 ? undefined : batch.length === 1 ? batch[0]! : Buffer.concat(batch);
		if (data !== undefined && data.length > 0) {
			if (ringPath === undefined) {
				await writeAll(activeHandle, data);
			} else {
				let offset = 0;
				while (offset < data.length) {
					if (currBytes >= maxBytes) await rotate();
					const space = maxBytes - currBytes;
					const remaining = data.length - offset;
					const slice = remaining <= space ? data.subarray(offset) : data.subarray(offset, offset + space);
					await writeAll(activeHandle, slice);
					currBytes += slice.length;
					offset += slice.length;
				}
			}
			dirtySinceSync = true;
		}
		if (syncMode === "sync") {
			await activeHandle.sync();
			dirtySinceSync = false;
			lastSyncAt = performance.now();
		} else if (dirtySinceSync && (syncMode === "datasync" || performance.now() - lastSyncAt >= flushIntervalMs)) {
			await activeHandle.datasync();
			dirtySinceSync = false;
			lastSyncAt = performance.now();
		}
	};
	const armTimer = (): void => {
		if (closed || flushTimer !== undefined || failure !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void scheduleFlush("datasync").catch(() => undefined);
		}, flushIntervalMs);
		flushTimer.unref();
	};
	const scheduleFlush = (syncMode: "ifDue" | "datasync" | "sync"): Promise<void> => {
		clearTimer();
		const batch = queuedChunks;
		queuedChunks = [];
		queuedBytes = 0;
		const next = writeChain.then(async () => {
			await drainBatch(batch, syncMode);
			if (!closed && dirtySinceSync && flushTimer === undefined && failure === undefined && syncMode !== "sync") {
				armTimer();
			}
		});
		writeChain = next.catch((error: unknown) => {
			recordFailure(error);
		});
		return next;
	};

	const collect = Promise.all(
		streams.map(async (stream) => {
			for await (const value of stream) {
				if (failure !== undefined) throw failure;
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				let part = chunk;
				if (ringPath === undefined) {
					const remaining = maxBytes + 1 - acceptedBytes;
					if (remaining <= 0) continue;
					part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
					acceptedBytes += part.length;
				}
				if (part.length === 0) continue;
				queuedChunks.push(part);
				queuedBytes += part.length;
				if (queuedBytes >= flushBytes) {
					await scheduleFlush("ifDue");
				} else if (flushTimer === undefined) {
					armTimer();
				}
			}
		}),
	);
	collect.catch(() => undefined);
	try {
		await Promise.race([collect, failed]);
		if (failure !== undefined) throw failure;
		await scheduleFlush("sync");
		if (failure !== undefined) throw failure;
	} finally {
		closed = true;
		clearTimer();
		await writeChain;
		clearTimer();
		if (ownsActive) {
			ownsActive = false;
			await activeHandle.close().catch(() => undefined);
		}
	}
}

/** Raw-byte cursors, bounded UTF-8 pages. Output remains untrusted; these
 * observations do not authenticate what the repository process printed. */
export async function readCodingCommandLog(options: {
	path: string;
	owner: number;
	protectedOwner: number;
	/** The session's NAS custody mount root, the one ancestor the host service owns. */
	mountRoot: string;
	boundary?: string;
	maxBytes: number;
	read: CloudCodingCommandRead;
	terminal: boolean;
	ring?: boolean;
}): Promise<Pick<CloudCodingCommandReceipt, "output" | "truncated" | "log">> {
	const query = parseCloudCodingCommandRead(options.read);
	for (let parent = dirname(options.path); parent !== dirname(parent); parent = dirname(parent)) {
		const stat = await lstat(parent);
		if (
			!stat.isDirectory() ||
			(stat.uid !== options.protectedOwner && parent !== options.mountRoot) ||
			(stat.mode & 0o022) !== 0
		)
			throw new Error("UNPROTECTED_CODING_GUEST_OUTPUT_PATH");
		if (parent === options.boundary) break;
	}
	const { handle, stat, prevHandle } = await openLogSnapshot({
		path: options.path,
		owner: options.owner,
		maxBytes: options.maxBytes,
		ring: options.ring === true,
	});
	try {
		const totalBytes = prevHandle ? options.maxBytes : Math.min(stat.size, options.maxBytes),
			limit = query.limit ?? 4096;
		let offset = query.tail ? Math.max(0, totalBytes - limit) : (query.offset ?? 0);
		if (offset > totalBytes) throw new Error("CODING_LOG_OFFSET_UNAVAILABLE");
		const base = Math.max(0, offset - 3),
			buffer = Buffer.alloc(Math.min(totalBytes - base, limit + 7));
		if (!prevHandle) {
			await readAll(handle, buffer, 0, buffer.length, base);
		} else {
			const split = options.maxBytes - stat.size;
			const prevCount = base < split ? Math.min(buffer.length, split - base) : 0;
			if (prevCount > 0) await readAll(prevHandle, buffer, 0, prevCount, stat.size + base);
			if (prevCount < buffer.length) {
				await readAll(handle, buffer, prevCount, buffer.length - prevCount, Math.max(0, base - split));
			}
		}
		const width = (index: number): number => {
			const b = buffer[index];
			const n = b < 128 ? 1 : b >= 194 && b <= 223 ? 2 : b >= 224 && b <= 239 ? 3 : b >= 240 && b <= 244 ? 4 : 1;
			if (index + n > buffer.length) return 1;
			for (let j = 1; j < n; j++) if ((buffer[index + j] & 192) !== 128) return 1;
			if (
				(b === 224 && buffer[index + 1] < 160) ||
				(b === 237 && buffer[index + 1] > 159) ||
				(b === 240 && buffer[index + 1] < 144) ||
				(b === 244 && buffer[index + 1] > 143)
			)
				return 1;
			return n;
		};
		for (let i = 0; i < offset - base; i++) {
			const n = width(i);
			if (i + n > offset - base) {
				if (!query.tail) throw new Error("CODING_LOG_OFFSET_SPLITS_UTF8");
				offset = base + i + n;
				break;
			}
		}
		let startCursor = offset - base,
			cursor = startCursor,
			bytes = 0,
			escapedBytes = 0,
			hasInvalid = false;
		const tailParts: { rawBytes: number; bytes: number; escapedBytes: number }[] = [];
		while (cursor < buffer.length && base + cursor < totalBytes) {
			const lead = buffer[cursor]!;
			const expected =
				lead >= 194 && lead <= 223 ? 2 : lead >= 224 && lead <= 239 ? 3 : lead >= 240 && lead <= 244 ? 4 : 1;
			if (!options.terminal && stat.size <= options.maxBytes && base + cursor + expected > totalBytes) {
				let allCont = true;
				for (let j = cursor + 1; j < buffer.length; j++) {
					if ((buffer[j]! & 192) !== 128) {
						allCont = false;
						break;
					}
				}
				if (allCont) break;
			}
			let n: number;
			let size: number;
			let escapedSize: number;
			if (lead < 128) {
				n = 1;
				size = 1;
				escapedSize = asciiEscapedSize(lead);
			} else {
				n = width(cursor);
				if (n === 1) {
					hasInvalid = true;
					size = 3;
					escapedSize = 3;
				} else {
					size = n;
					escapedSize = n;
				}
			}
			// Leave room for the protected query wrapper and receipt metadata inside
			// the LXD file API's fixed 64 KiB response ceiling.
			if ((bytes + size > limit || escapedBytes + escapedSize > 60000) && !query.tail) break;
			bytes += size;
			escapedBytes += escapedSize;
			cursor += n;
			if (query.tail) tailParts.push({ rawBytes: n, bytes: size, escapedBytes: escapedSize });
		}
		for (const part of tailParts) {
			if (bytes <= limit && escapedBytes <= 60000) break;
			bytes -= part.bytes;
			escapedBytes -= part.escapedBytes;
			offset += part.rawBytes;
			startCursor += part.rawBytes;
		}
		let output: string;
		if (!hasInvalid) {
			output = UTF8_DECODER.decode(buffer.subarray(startCursor, cursor));
		} else {
			const segments: string[] = [];
			let runStart = startCursor;
			let pos = startCursor;
			while (pos < cursor) {
				const b = buffer[pos]!;
				if (b < 128) {
					pos += 1;
					continue;
				}
				const n = width(pos);
				if (n === 1) {
					if (pos > runStart) segments.push(UTF8_DECODER.decode(buffer.subarray(runStart, pos)));
					segments.push("\uFFFD");
					pos += 1;
					runStart = pos;
				} else {
					pos += n;
				}
			}
			if (cursor > runStart) segments.push(UTF8_DECODER.decode(buffer.subarray(runStart, cursor)));
			output = segments.join("");
		}
		const nextOffset = base + cursor,
			limitReached = prevHandle !== undefined || stat.size > options.maxBytes;
		return {
			output,
			truncated: nextOffset < totalBytes || limitReached,
			log: { offset, nextOffset, totalBytes, limitBytes: options.maxBytes, limitReached },
		};
	} finally {
		await prevHandle?.close();
		await handle.close();
	}
}
