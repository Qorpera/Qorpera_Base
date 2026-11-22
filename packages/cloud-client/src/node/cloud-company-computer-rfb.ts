// noVNC's ExtendedClipboard pseudo-encoding, as a signed wire int32. -309 is XVP.
export const COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0;

// The input authority admits core KeyEvent and PointerEvent messages. Do not
// negotiate formats it cannot authorize: noVNC otherwise switches physical
// keys (including shortcuts) to QEMU events and the connection is rejected.
const unsupportedEncodings = new Set([COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD, -258, -316]);

/** The guest image and noVNC use 32-bit pixels with 24-bit true color. Pin this for safe server framing. */
export function assertCompanyComputerRfbPixelFormat(bytes: Buffer): void {
	const rShift = bytes[14];
	const gShift = bytes[15];
	const bShift = bytes[16];
	if (
		bytes.length < 20 ||
		bytes[4] !== 32 ||
		bytes[5] !== 24 ||
		bytes[6]! > 1 ||
		bytes[7] !== 1 ||
		bytes.readUInt16BE(8) !== 255 ||
		bytes.readUInt16BE(10) !== 255 ||
		bytes.readUInt16BE(12) !== 255 ||
		(rShift !== 0 && rShift !== 8 && rShift !== 16) ||
		(gShift !== 0 && gShift !== 8 && gShift !== 16) ||
		(bShift !== 0 && bShift !== 8 && bShift !== 16) ||
		rShift === gShift ||
		rShift === bShift ||
		gShift === bShift
	)
		throw new Error("RFB_PIXEL_FORMAT_UNSUPPORTED");
}

class ByteQueue {
	#chunks: Buffer[] = [];
	#head = 0;
	#headOffset = 0;
	#length = 0;

	get length(): number {
		return this.#length;
	}

	appendView(chunk: Uint8Array): Buffer | undefined {
		if (chunk.byteLength === 0) return undefined;
		const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		this.#chunks.push(view);
		this.#length += view.byteLength;
		return view;
	}

	detachTail(view: Buffer | undefined): void {
		if (!view || this.#length === 0) return;
		const lastIndex = this.#chunks.length - 1;
		if (lastIndex < this.#head || this.#chunks[lastIndex] !== view) return;
		const start = lastIndex === this.#head ? this.#headOffset : 0;
		this.#chunks[lastIndex] = Buffer.from(view.subarray(start));
		if (lastIndex === this.#head) this.#headOffset = 0;
	}

	at(index: number): number {
		let remaining = index + this.#headOffset;
		for (let i = this.#head; i < this.#chunks.length; i++) {
			const chunk = this.#chunks[i]!;
			if (remaining < chunk.length) return chunk[remaining]!;
			remaining -= chunk.length;
		}
		return 0;
	}

	readUInt16BE(offset: number): number {
		return (this.at(offset) << 8) | this.at(offset + 1);
	}

	readInt32BE(offset: number): number {
		return (
			(this.at(offset) << 24) | (this.at(offset + 1) << 16) | (this.at(offset + 2) << 8) | this.at(offset + 3) | 0
		);
	}

	readBigUInt64BE(offset: number): bigint {
		const hi = this.readInt32BE(offset) >>> 0;
		const lo = this.readInt32BE(offset + 4) >>> 0;
		return (BigInt(hi) << 32n) | BigInt(lo);
	}

	copyInto(offset: number, length: number, target: Buffer): void {
		let skip = offset + this.#headOffset;
		let written = 0;
		for (let i = this.#head; i < this.#chunks.length && written < length; i++) {
			const chunk = this.#chunks[i]!;
			if (skip >= chunk.length) {
				skip -= chunk.length;
				continue;
			}
			const take = Math.min(chunk.length - skip, length - written);
			chunk.copy(target, written, skip, skip + take);
			written += take;
			skip = 0;
		}
	}

	takeCopy(length: number, slow = false): Buffer {
		const out = slow ? Buffer.allocUnsafeSlow(length) : Buffer.allocUnsafe(length);
		this.copyInto(0, length, out);
		this.consume(length);
		return out;
	}

	consume(length: number): void {
		let remaining = length;
		this.#length -= length;
		while (remaining > 0 && this.#head < this.#chunks.length) {
			const chunk = this.#chunks[this.#head]!;
			const available = chunk.length - this.#headOffset;
			if (remaining < available) {
				this.#headOffset += remaining;
				return;
			}
			remaining -= available;
			this.#head += 1;
			this.#headOffset = 0;
		}
		if (this.#head === this.#chunks.length) {
			this.#chunks.length = 0;
			this.#head = 0;
			this.#headOffset = 0;
		} else if (this.#head >= 32) {
			this.#chunks = this.#chunks.slice(this.#head);
			this.#head = 0;
		}
	}
}

const RFB_VERSION_BYTES = Buffer.from("RFB 003.008\n", "ascii");

function unmaskPayload(payload: Buffer, mask: Buffer): void {
	const length = payload.length;
	let index = 0;
	if (length >= 16 && (payload.byteOffset & 3) === 0 && (mask.byteOffset & 3) === 0) {
		const maskWord = new Uint32Array(mask.buffer, mask.byteOffset, 1)[0]!;
		const words = new Uint32Array(payload.buffer, payload.byteOffset, length >>> 2);
		for (let w = 0; w < words.length; w++) words[w] ^= maskWord;
		index = words.length << 2;
	}
	const m0 = mask[0]!;
	const m1 = mask[1]!;
	const m2 = mask[2]!;
	const m3 = mask[3]!;
	for (; index + 3 < length; index += 4) {
		payload[index] ^= m0;
		payload[index + 1] ^= m1;
		payload[index + 2] ^= m2;
		payload[index + 3] ^= m3;
	}
	for (; index < length; index++) payload[index] ^= mask[index & 3]!;
}

/** RFC 6143 client framing, plus the bounded noVNC/TigerVNC extensions used by the existing viewer. */
export class CompanyComputerRfbClientParser {
	readonly #queue = new ByteQueue();
	#stage: "version" | "security" | "init" | "messages" = "version";

	push(chunk: Uint8Array): Array<{ kind: "protocol" | "input" | "blocked"; bytes: Buffer }> {
		if (this.#queue.length + chunk.length > 256 * 1024) throw new Error("RFB_BUFFER_LIMIT");
		const view = this.#queue.appendView(chunk);
		const messages: Array<{ kind: "protocol" | "input" | "blocked"; bytes: Buffer }> = [];
		try {
			while (this.#queue.length > 0) {
				if (messages.length >= 4096) throw new Error("RFB_MESSAGE_LIMIT");
				let length: number;
				let kind: "protocol" | "input" | "blocked" = "protocol";
				if (this.#stage === "version") {
					length = 12;
					if (this.#queue.length < length) break;
					for (let i = 0; i < 12; i++) {
						if (this.#queue.at(i) !== RFB_VERSION_BYTES[i]) throw new Error("RFB_VERSION_UNSUPPORTED");
					}
					this.#stage = "security";
				} else if (this.#stage === "security" || this.#stage === "init") {
					length = 1;
					// None is allowed only behind the authenticated cloud gateway. Shared init cannot kick other viewers off.
					if (this.#queue.at(0) !== 1) throw new Error("RFB_HANDSHAKE_UNSUPPORTED");
					this.#stage = this.#stage === "security" ? "init" : "messages";
				} else {
					const type = this.#queue.at(0);
					if (type === 0) length = 20;
					else if (type === 2) {
						if (this.#queue.length < 4) break;
						const encodings = this.#queue.readUInt16BE(2);
						if (encodings > 256) throw new Error("RFB_ENCODING_LIMIT");
						length = 4 + encodings * 4;
					} else if (type === 3 || type === 150) length = 10;
					else if (type === 4) {
						length = 8;
						kind = "input";
					} else if (type === 5) {
						if (this.#queue.length < 2) break;
						length = (this.#queue.at(1) & 128) === 0 ? 6 : 7;
						kind = "input";
					} else if (type === 255) {
						if (this.#queue.length < 2) break;
						if (this.#queue.at(1) !== 0) throw new Error("RFB_EXTENSION_UNSUPPORTED");
						length = 12;
						kind = "input";
					} else if (type === 6) {
						if (this.#queue.length < 8) break;
						const size = Math.abs(this.#queue.readInt32BE(4));
						if (size > 64 * 1024) throw new Error("RFB_CLIPBOARD_LIMIT");
						length = 8 + size;
						kind = "blocked";
					} else if (type === 251) {
						if (this.#queue.length < 8) break;
						length = 8 + this.#queue.at(6) * 16;
						kind = "blocked";
					} else if (type === 248) {
						if (this.#queue.length < 9) break;
						const extra = this.#queue.at(8);
						if (extra > 64) throw new Error("RFB_FENCE_LIMIT");
						length = 9 + extra;
					} else throw new Error("RFB_MESSAGE_UNSUPPORTED");
				}
				if (this.#queue.length < length) break;
				let bytes = this.#queue.takeCopy(length);
				if (this.#stage === "messages" && bytes[0] === 0 && length === 20)
					assertCompanyComputerRfbPixelFormat(bytes);
				if (this.#stage === "messages" && bytes[0] === 2 && length >= 4) {
					// Clipboard is a separate typed interaction. Extended keyboard and
					// mouse input must fall back to the core formats admitted by the gateway.
					const encodings: number[] = [];
					for (let offset = 4; offset < bytes.length; offset += 4) {
						const encoding = bytes.readInt32BE(offset);
						if (!unsupportedEncodings.has(encoding)) encodings.push(encoding);
					}
					bytes = Buffer.alloc(4 + encodings.length * 4);
					bytes[0] = 2;
					bytes.writeUInt16BE(encodings.length, 2);
					for (let index = 0; index < encodings.length; index++) {
						bytes.writeInt32BE(encodings[index]!, 4 + index * 4);
					}
				}
				messages.push({ kind, bytes });
			}
			return messages;
		} finally {
			this.#queue.detachTail(view);
		}
	}
}

/** Reused from the older loopback bridge, with total-message and fragment bounds and strict RFC 6455 checks. */
export class CompanyComputerWebSocketDecoder {
	readonly #queue = new ByteQueue();
	readonly #mask = Buffer.allocUnsafeSlow(4);
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#fragmentOpcode = 0;

	push(chunk: Buffer): Array<{ opcode: number; payload: Buffer }> {
		if (this.#queue.length + chunk.length > 256 * 1024) throw new Error("WEBSOCKET_BUFFER_LIMIT");
		const view = this.#queue.appendView(chunk);
		const messages: Array<{ opcode: number; payload: Buffer }> = [];
		try {
			for (;;) {
				if (this.#queue.length < 2) return messages;
				if (messages.length > 4096) throw new Error("WEBSOCKET_MESSAGE_LIMIT");
				const b0 = this.#queue.at(0);
				const b1 = this.#queue.at(1);
				const fin = (b0 & 128) !== 0;
				const opcode = b0 & 15;
				if (
					(b0 & 112) !== 0 ||
					(b1 & 128) === 0 ||
					(opcode !== 0 && opcode !== 2 && opcode !== 8 && opcode !== 9 && opcode !== 10)
				)
					throw new Error("INVALID_WEBSOCKET_FRAME");
				let length = b1 & 127;
				let offset = 2;
				if (length === 126) {
					if (this.#queue.length < 4) return messages;
					length = this.#queue.readUInt16BE(2);
					offset = 4;
					if (length < 126) throw new Error("INVALID_WEBSOCKET_LENGTH");
				} else if (length === 127) {
					if (this.#queue.length < 10) return messages;
					const wide = this.#queue.readBigUInt64BE(2);
					if (wide < 65_536n || wide > 128n * 1024n) throw new Error("WEBSOCKET_FRAME_LIMIT");
					length = Number(wide);
					offset = 10;
				}
				if (
					(opcode >= 8 && (!fin || length > 125)) ||
					(opcode === 0 && this.#fragmentOpcode === 0) ||
					(opcode === 2 && this.#fragmentOpcode !== 0) ||
					this.#fragmentBytes + length > 128 * 1024
				)
					throw new Error("INVALID_WEBSOCKET_FRAGMENT");
				if (this.#queue.length < offset + 4 + length) return messages;
				this.#queue.copyInto(offset, 4, this.#mask);
				this.#queue.consume(offset + 4);
				const payload = this.#queue.takeCopy(length, length >= 64);
				unmaskPayload(payload, this.#mask);
				if (opcode === 0 || (opcode === 2 && !fin)) {
					this.#fragmentOpcode = 2;
					this.#fragments.push(payload);
					this.#fragmentBytes += length;
					if (this.#fragments.length > 4096) throw new Error("WEBSOCKET_FRAGMENT_LIMIT");
					if (!fin) continue;
					messages.push({ opcode: 2, payload: Buffer.concat(this.#fragments, this.#fragmentBytes) });
					this.#fragments = [];
					this.#fragmentBytes = 0;
					this.#fragmentOpcode = 0;
				} else messages.push({ opcode, payload });
			}
		} finally {
			this.#queue.detachTail(view);
		}
	}
}

export function companyComputerWebSocketFrame(payload: Buffer, opcode = 2): Buffer {
	const length = payload.length;
	const headerLength = length < 126 ? 2 : length < 65_536 ? 4 : 10;
	const frame = Buffer.allocUnsafe(headerLength + length);
	frame[0] = 128 | opcode;
	if (length < 126) {
		frame[1] = length;
	} else if (length < 65_536) {
		frame[1] = 126;
		frame.writeUInt16BE(length, 2);
	} else {
		frame[1] = 127;
		frame.writeBigUInt64BE(BigInt(length), 2);
	}
	payload.copy(frame, headerLength);
	return frame;
}
