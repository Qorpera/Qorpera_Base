import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	parseCloudCodingCommandRead,
} from "@qorpera/contracts";

const UTF8_DECODER = new TextDecoder("utf8", { ignoreBOM: true });

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

/** At most one buffered chunk per pipe awaits a durable serialized write.
 * Excess output is drained after retaining a single overflow marker. */
export async function collectCodingCommandOutput(
	streams: readonly NodeJS.ReadableStream[],
	handle: FileHandle,
	maxBytes: number,
): Promise<void> {
	let bytes = 0,
		pending = Promise.resolve();
	await Promise.all(
		streams.map(async (stream) => {
			for await (const value of stream) {
				const remaining = maxBytes + 1 - bytes;
				if (remaining <= 0) continue;
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				const part = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
				bytes += part.length;
				if (part.length) {
					pending = pending.then(async () => {
						let offset = 0;
						while (offset < part.length) {
							const written = await handle.write(part, offset, part.length - offset);
							if (!written.bytesWritten) throw new Error("CODING_LOG_WRITE_FAILED");
							offset += written.bytesWritten;
						}
						await handle.sync();
					});
					await pending;
				}
			}
		}),
	);
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
	const handle = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== options.owner || stat.size > options.maxBytes + 1)
			throw new Error("INVALID_CODING_GUEST_OUTPUT");
		const totalBytes = Math.min(stat.size, options.maxBytes),
			limit = query.limit ?? 4096;
		let offset = query.tail ? Math.max(0, totalBytes - limit) : (query.offset ?? 0);
		if (offset > totalBytes) throw new Error("CODING_LOG_OFFSET_UNAVAILABLE");
		const base = Math.max(0, offset - 3),
			buffer = Buffer.alloc(Math.min(totalBytes - base, limit + 7));
		let used = 0;
		while (used < buffer.length) {
			const read = await handle.read(buffer, used, buffer.length - used, base + used);
			if (!read.bytesRead) break;
			used += read.bytesRead;
		}
		if (used !== buffer.length) throw new Error("CODING_LOG_CHANGED");
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
			limitReached = stat.size > options.maxBytes;
		return {
			output,
			truncated: nextOffset < totalBytes || limitReached,
			log: { offset, nextOffset, totalBytes, limitBytes: options.maxBytes, limitReached },
		};
	} finally {
		await handle.close();
	}
}
