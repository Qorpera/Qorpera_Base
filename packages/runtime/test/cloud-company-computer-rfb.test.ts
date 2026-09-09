import {
	COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD,
	CompanyComputerRfbClientParser,
	CompanyComputerWebSocketDecoder,
} from "@qorpera/cloud-client/node/cloud-company-computer-rfb";
import { describe, expect, it } from "vitest";
import { computerRfbServerHello } from "./fixtures/company-computer.ts";

function maskedFrame(payload: Buffer, opcode = 2, fin = true): Buffer {
	const mask = Buffer.from([1, 2, 3, 4]);
	const header =
		payload.length < 126 ? Buffer.from([(fin ? 128 : 0) | opcode, 128 | payload.length]) : Buffer.alloc(4);
	if (payload.length >= 126) {
		header[0] = (fin ? 128 : 0) | opcode;
		header[1] = 254;
		header.writeUInt16BE(payload.length, 2);
	}
	return Buffer.concat([header, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}

const clientHello = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);

describe("noVNC client protocol filtering", () => {
	it("recognizes split input frames without letting clipboard or resize bytes become input", () => {
		const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
		const clipboard = Buffer.alloc(8 + key.length);
		clipboard[0] = 6;
		clipboard.writeInt32BE(-key.length, 4);
		key.copy(clipboard, 8);
		const resize = Buffer.alloc(24);
		resize[0] = 251;
		resize[6] = 1;
		const all = Buffer.concat([clientHello, clipboard, resize, key]);
		for (let split = 0; split <= all.length; split++) {
			const parser = new CompanyComputerRfbClientParser();
			const output = [...parser.push(all.subarray(0, split)), ...parser.push(all.subarray(split))];
			expect(output.filter((message) => message.kind === "input").map((message) => message.bytes)).toEqual([key]);
			expect(output.filter((message) => message.kind === "blocked")).toHaveLength(2);
		}
	});

	it("strips extended clipboard negotiation while retaining normal encodings and bounded extensions", () => {
		const parser = new CompanyComputerRfbClientParser();
		parser.push(clientHello);
		const encodings = Buffer.alloc(16);
		encodings[0] = 2;
		encodings.writeUInt16BE(3, 2);
		encodings.writeUInt32BE(3231835598, 4); // Actual vendored noVNC identifier, not XVP (-309).
		encodings.writeInt32BE(16, 8);
		encodings.writeInt32BE(-309, 12);
		expect(COMPANY_COMPUTER_RFB_EXTENDED_CLIPBOARD).toBe(encodings.readInt32BE(4));
		const output = parser.push(encodings)[0].bytes;
		expect(output.readUInt16BE(2)).toBe(2);
		expect(output.readInt32BE(4)).toBe(16);
		expect(output.readInt32BE(8)).toBe(-309);
		const extendedKey = Buffer.alloc(12);
		extendedKey[0] = 255;
		const extendedPointer = Buffer.from([5, 128, 0, 1, 0, 1, 1]);
		expect(parser.push(Buffer.concat([extendedKey, extendedPointer])).map((message) => message.kind)).toEqual([
			"input",
			"input",
		]);
	});

	it("refuses unsupported handshakes and oversized or unknown protocol messages", () => {
		expect(() => new CompanyComputerRfbClientParser().push(Buffer.from("RFB 003.003\n"))).toThrow(
			"RFB_VERSION_UNSUPPORTED",
		);
		expect(() =>
			new CompanyComputerRfbClientParser().push(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([2])])),
		).toThrow("RFB_HANDSHAKE_UNSUPPORTED");
		const parser = new CompanyComputerRfbClientParser();
		parser.push(clientHello);
		const clipboard = Buffer.alloc(8);
		clipboard[0] = 6;
		clipboard.writeInt32BE(65_537, 4);
		expect(() => parser.push(clipboard)).toThrow("RFB_CLIPBOARD_LIMIT");
		const unknown = new CompanyComputerRfbClientParser();
		unknown.push(clientHello);
		expect(() => unknown.push(Buffer.from([99]))).toThrow("RFB_MESSAGE_UNSUPPORTED");
	});

	it("pins client pixel format to the same byte widths as the guest output filter", () => {
		const format = Buffer.from(computerRfbServerHello().subarray(18, 38));
		format.fill(0, 0, 4);
		const parser = new CompanyComputerRfbClientParser();
		parser.push(clientHello);
		expect(parser.push(format)[0].bytes).toEqual(format);
		format[4] = 8;
		expect(() => parser.push(format)).toThrow("RFB_PIXEL_FORMAT_UNSUPPORTED");
	});
});

describe("bounded loopback WebSocket decoding", () => {
	it("handles split frames, fragments and interleaved ping without altering binary payloads", () => {
		const stream = Buffer.concat([
			maskedFrame(Buffer.from("ab"), 2, false),
			maskedFrame(Buffer.from("ping"), 9),
			maskedFrame(Buffer.from("cd"), 0),
		]);
		for (let split = 0; split <= stream.length; split++) {
			const decoder = new CompanyComputerWebSocketDecoder();
			const output = [...decoder.push(stream.subarray(0, split)), ...decoder.push(stream.subarray(split))];
			expect(output.map(({ opcode, payload }) => [opcode, payload.toString()])).toEqual([
				[9, "ping"],
				[2, "abcd"],
			]);
		}
	});

	it.each([
		Buffer.from([130, 1, 1]), // unmasked
		maskedFrame(Buffer.from("text"), 1),
		maskedFrame(Buffer.alloc(0), 0), // orphan continuation
		maskedFrame(Buffer.alloc(126), 9), // oversized control
		Buffer.from([194, 128, 1, 2, 3, 4]), // RSV bit
		Buffer.from([130, 254, 0, 1, 1, 2, 3, 4, 1]), // noncanonical length
	])("refuses malformed client frames", (frame) => {
		expect(() => new CompanyComputerWebSocketDecoder().push(frame)).toThrow();
	});

	it("bounds total fragment storage, including incomplete messages", () => {
		const decoder = new CompanyComputerWebSocketDecoder();
		decoder.push(maskedFrame(Buffer.alloc(65_535), 2, false));
		decoder.push(maskedFrame(Buffer.alloc(65_535), 0, false));
		expect(() => decoder.push(maskedFrame(Buffer.alloc(3), 0, false))).toThrow("INVALID_WEBSOCKET_FRAGMENT");
	});
});
