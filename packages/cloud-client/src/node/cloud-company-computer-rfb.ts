// noVNC's ExtendedClipboard pseudo-encoding, as a signed wire int32. -309 is XVP.
export const COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0;

/** The guest image and noVNC use 32-bit pixels with 24-bit true color. Pin this for safe server framing. */
export function assertCompanyComputerRfbPixelFormat(bytes: Buffer): void {
	if (
		bytes.length < 20 ||
		bytes[4] !== 32 ||
		bytes[5] !== 24 ||
		bytes[6] > 1 ||
		bytes[7] !== 1 ||
		[8, 10, 12].some((offset) => bytes.readUInt16BE(offset) !== 255) ||
		new Set([bytes[14], bytes[15], bytes[16]]).size !== 3 ||
		[bytes[14], bytes[15], bytes[16]].some((shift) => ![0, 8, 16].includes(shift))
	)
		throw new Error("RFB_PIXEL_FORMAT_UNSUPPORTED");
}

/** RFC 6143 client framing, plus the bounded noVNC/TigerVNC extensions used by the existing viewer. */
export class CompanyComputerRfbClientParser {
	#buffer = Buffer.alloc(0);
	#stage: "version" | "security" | "init" | "messages" = "version";

	push(chunk: Uint8Array): Array<{ kind: "protocol" | "input" | "blocked"; bytes: Buffer }> {
		if (this.#buffer.length + chunk.length > 256 * 1024) throw new Error("RFB_BUFFER_LIMIT");
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const messages: Array<{ kind: "protocol" | "input" | "blocked"; bytes: Buffer }> = [];
		while (this.#buffer.length > 0) {
			if (messages.length >= 4096) throw new Error("RFB_MESSAGE_LIMIT");
			let length: number;
			let kind: "protocol" | "input" | "blocked" = "protocol";
			if (this.#stage === "version") {
				length = 12;
				if (this.#buffer.length < length) break;
				if (this.#buffer.subarray(0, length).toString("ascii") !== "RFB 003.008\n")
					throw new Error("RFB_VERSION_UNSUPPORTED");
				this.#stage = "security";
			} else if (this.#stage === "security" || this.#stage === "init") {
				length = 1;
				// None is allowed only behind the authenticated cloud gateway. Shared init cannot kick other viewers off.
				if (this.#buffer[0] !== 1) throw new Error("RFB_HANDSHAKE_UNSUPPORTED");
				this.#stage = this.#stage === "security" ? "init" : "messages";
			} else {
				const type = this.#buffer[0];
				if (type === 0) length = 20;
				else if (type === 2) {
					if (this.#buffer.length < 4) break;
					const encodings = this.#buffer.readUInt16BE(2);
					if (encodings > 256) throw new Error("RFB_ENCODING_LIMIT");
					length = 4 + encodings * 4;
				} else if (type === 3 || type === 150) length = 10;
				else if (type === 4) {
					length = 8;
					kind = "input";
				} else if (type === 5) {
					if (this.#buffer.length < 2) break;
					length = (this.#buffer[1] & 128) === 0 ? 6 : 7;
					kind = "input";
				} else if (type === 255) {
					if (this.#buffer.length < 2) break;
					if (this.#buffer[1] !== 0) throw new Error("RFB_EXTENSION_UNSUPPORTED");
					length = 12;
					kind = "input";
				} else if (type === 6) {
					if (this.#buffer.length < 8) break;
					const size = Math.abs(this.#buffer.readInt32BE(4));
					if (size > 64 * 1024) throw new Error("RFB_CLIPBOARD_LIMIT");
					length = 8 + size;
					kind = "blocked";
				} else if (type === 251) {
					if (this.#buffer.length < 8) break;
					length = 8 + this.#buffer[6] * 16;
					kind = "blocked";
				} else if (type === 248) {
					if (this.#buffer.length < 9) break;
					if (this.#buffer[8] > 64) throw new Error("RFB_FENCE_LIMIT");
					length = 9 + this.#buffer[8];
				} else throw new Error("RFB_MESSAGE_UNSUPPORTED");
			}
			if (this.#buffer.length < length) break;
			let bytes = Buffer.from(this.#buffer.subarray(0, length));
			this.#buffer = this.#buffer.subarray(length);
			if (this.#stage === "messages" && bytes[0] === 0 && length === 20) assertCompanyComputerRfbPixelFormat(bytes);
			if (this.#stage === "messages" && bytes[0] === 2 && length >= 4) {
				// Disable extended clipboard negotiation. Clipboard transfer is a separate typed interaction.
				const encodings: number[] = [];
				for (let offset = 4; offset < bytes.length; offset += 4) {
					const encoding = bytes.readInt32BE(offset);
					if (encoding !== COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD) encodings.push(encoding);
				}
				bytes = Buffer.alloc(4 + encodings.length * 4);
				bytes[0] = 2;
				bytes.writeUInt16BE(encodings.length, 2);
				encodings.forEach((encoding, index) => {
					bytes.writeInt32BE(encoding, 4 + index * 4);
				});
			}
			messages.push({ kind, bytes });
		}
		return messages;
	}
}

/** Reused from the older loopback bridge, with total-message and fragment bounds and strict RFC 6455 checks. */
export class CompanyComputerWebSocketDecoder {
	#buffer = Buffer.alloc(0);
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#fragmentOpcode = 0;

	push(chunk: Buffer): Array<{ opcode: number; payload: Buffer }> {
		if (this.#buffer.length + chunk.length > 256 * 1024) throw new Error("WEBSOCKET_BUFFER_LIMIT");
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const messages: Array<{ opcode: number; payload: Buffer }> = [];
		for (;;) {
			if (this.#buffer.length < 2) return messages;
			if (messages.length > 4096) throw new Error("WEBSOCKET_MESSAGE_LIMIT");
			const fin = (this.#buffer[0] & 128) !== 0;
			const opcode = this.#buffer[0] & 15;
			if ((this.#buffer[0] & 112) !== 0 || (this.#buffer[1] & 128) === 0 || ![0, 2, 8, 9, 10].includes(opcode))
				throw new Error("INVALID_WEBSOCKET_FRAME");
			let length = this.#buffer[1] & 127;
			let offset = 2;
			if (length === 126) {
				if (this.#buffer.length < 4) return messages;
				length = this.#buffer.readUInt16BE(2);
				offset = 4;
				if (length < 126) throw new Error("INVALID_WEBSOCKET_LENGTH");
			} else if (length === 127) {
				if (this.#buffer.length < 10) return messages;
				const wide = this.#buffer.readBigUInt64BE(2);
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
			if (this.#buffer.length < offset + 4 + length) return messages;
			const mask = this.#buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + length));
			for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
			this.#buffer = this.#buffer.subarray(offset + 4 + length);
			if (opcode === 0 || (opcode === 2 && !fin)) {
				this.#fragmentOpcode = 2;
				this.#fragments.push(payload);
				this.#fragmentBytes += length;
				if (this.#fragments.length > 4096) throw new Error("WEBSOCKET_FRAGMENT_LIMIT");
				if (!fin) continue;
				messages.push({ opcode: 2, payload: Buffer.concat(this.#fragments) });
				this.#fragments = [];
				this.#fragmentBytes = 0;
				this.#fragmentOpcode = 0;
			} else messages.push({ opcode, payload });
		}
	}
}

export function companyComputerWebSocketFrame(payload: Buffer, opcode = 2): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) header = Buffer.from([128 | opcode, length]);
	else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 128 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 128 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}
