import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	parseCloudCodingCommandRead,
} from "@qorpera/contracts";

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
				const chunk = Buffer.from(value),
					part = Buffer.from(chunk.subarray(0, Math.max(0, maxBytes + 1 - bytes)));
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
		let cursor = offset - base,
			bytes = 0,
			escapedBytes = 0,
			output = "";
		const tailParts: { rawBytes: number; text: string; bytes: number; escapedBytes: number }[] = [];
		while (cursor < buffer.length && base + cursor < totalBytes) {
			const lead = buffer[cursor],
				expected =
					lead >= 194 && lead <= 223 ? 2 : lead >= 224 && lead <= 239 ? 3 : lead >= 240 && lead <= 244 ? 4 : 1;
			if (
				!options.terminal &&
				stat.size <= options.maxBytes &&
				base + cursor + expected > totalBytes &&
				buffer.subarray(cursor + 1).every((b) => (b & 192) === 128)
			)
				break;
			const n = width(cursor),
				part = new TextDecoder("utf8", { ignoreBOM: true }).decode(buffer.subarray(cursor, cursor + n)),
				size = Buffer.byteLength(part),
				escapedSize = Buffer.byteLength(JSON.stringify(part)) - 2;
			// Leave room for the protected query wrapper and receipt metadata inside
			// the LXD file API's fixed 64 KiB response ceiling.
			if ((bytes + size > limit || escapedBytes + escapedSize > 60000) && !query.tail) break;
			output += part;
			bytes += size;
			escapedBytes += escapedSize;
			cursor += n;
			if (query.tail) tailParts.push({ rawBytes: n, text: part, bytes: size, escapedBytes: escapedSize });
		}
		let removedCharacters = 0;
		for (const part of tailParts) {
			if (bytes <= limit && escapedBytes <= 60000) break;
			bytes -= part.bytes;
			escapedBytes -= part.escapedBytes;
			offset += part.rawBytes;
			removedCharacters += part.text.length;
		}
		if (removedCharacters) output = output.slice(removedCharacters);
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
