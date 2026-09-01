import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CompanyComputerRfbServerParser } from "../src/cloud-company-computer-rfb-server.ts";
import {
	computerRfbRectangle,
	computerRfbServerClipboard,
	computerRfbServerHello,
	computerRfbUpdate,
} from "./fixtures/company-computer.ts";

function length32(bytes: Buffer, flags?: number): Buffer {
	const header = Buffer.alloc(flags === undefined ? 4 : 8);
	header.writeUInt32BE(bytes.length);
	if (flags !== undefined) header.writeUInt32BE(flags, 4);
	return Buffer.concat([header, bytes]);
}

function compact(bytes: Buffer): Buffer {
	const count = bytes.length;
	const header =
		count < 128
			? [count]
			: count < 16384
				? [(count & 127) | 128, count >> 7]
				: [(count & 127) | 128, ((count >> 7) & 127) | 128, count >> 14];
	return Buffer.concat([Buffer.from(header), bytes]);
}

const hello = computerRfbServerHello();
const clipboard = computerRfbServerClipboard("private clipboard");
const extended = computerRfbServerClipboard("private extended clipboard", true);
const pixels = Buffer.alloc(16, 3);
// Framing fixtures only; image/video payloads are deliberately not rendered in these tests.
const encodings: Array<{ name: string; rectangle: Buffer }> = [
	{ name: "raw", rectangle: computerRfbRectangle(0, 2, 2, pixels) },
	{ name: "copyrect", rectangle: computerRfbRectangle(1, 2, 2, Buffer.alloc(4)) },
	{ name: "RRE", rectangle: computerRfbRectangle(2, 2, 2, Buffer.concat([Buffer.from([0, 0, 0, 1]), pixels])) },
	{
		name: "hextile edge tiles",
		rectangle: computerRfbRectangle(
			5,
			17,
			17,
			Buffer.concat([
				Buffer.from([1]),
				Buffer.alloc(16 * 16 * 4, 3), // Raw tile.
				Buffer.from([26, 3, 3, 3, 0, 1, 3, 3, 3, 0, 0, 0]), // Background + one colored subrectangle.
				Buffer.from([6, 3, 3, 3, 0, 3, 3, 3, 0]), // Background and foreground, no subrectangles.
				Buffer.from([8, 1, 0, 0]), // One foreground subrectangle.
			]),
		),
	},
	{ name: "zlib", rectangle: computerRfbRectangle(6, 2, 2, length32(deflateSync(pixels))) },
	{
		name: "ZRLE",
		rectangle: computerRfbRectangle(
			16,
			2,
			2,
			length32(deflateSync(Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 3)]))),
		),
	},
	{ name: "Tight fill", rectangle: computerRfbRectangle(7, 2, 2, Buffer.from([0x80, 3, 3, 3])) },
	{ name: "Tight literal", rectangle: computerRfbRectangle(7, 1, 1, Buffer.from([0, 3, 3, 3])) },
	{
		name: "Tight compressed",
		rectangle: computerRfbRectangle(
			7,
			2,
			2,
			Buffer.concat([Buffer.from([0]), compact(deflateSync(Buffer.alloc(12, 3)))]),
		),
	},
	{
		name: "Tight gradient",
		rectangle: computerRfbRectangle(
			7,
			2,
			2,
			Buffer.concat([Buffer.from([0x40, 2]), compact(deflateSync(Buffer.alloc(12, 3)))]),
		),
	},
	{
		name: "Tight two-color palette",
		rectangle: computerRfbRectangle(7, 2, 2, Buffer.from([0x40, 1, 1, 3, 3, 3, 0, 0, 0, 1, 1])),
	},
	{
		name: "Tight compressed palette",
		rectangle: computerRfbRectangle(
			7,
			3,
			4,
			Buffer.concat([Buffer.from([0x40, 1, 2]), Buffer.alloc(9, 3), compact(deflateSync(Buffer.alloc(12, 2)))]),
		),
	},
	{
		name: "Tight JPEG",
		rectangle: computerRfbRectangle(7, 2, 2, Buffer.concat([Buffer.from([0x90]), compact(clipboard)])),
	},
	{
		name: "Tight PNG",
		rectangle: computerRfbRectangle(-260, 2, 2, Buffer.concat([Buffer.from([0xa0]), compact(clipboard)])),
	},
	{
		name: "JPEG markers and byte stuffing",
		rectangle: computerRfbRectangle(
			21,
			2,
			2,
			Buffer.concat([
				Buffer.from([255, 0xd8, 255, 0xe0, 0, clipboard.length + 2]),
				clipboard,
				Buffer.from([255, 0xc0, 0, 2, 255, 0xda, 0, 2]),
				clipboard,
				Buffer.from([255, 0, 3, 255, 0xd3, 3, 255, 0xd9]),
			]),
		),
	},
	{ name: "H264", rectangle: computerRfbRectangle(50, 2, 2, length32(clipboard, 2)) },
	{ name: "cursor", rectangle: computerRfbRectangle(-239, 2, 2, Buffer.alloc(18, 3)) },
	{
		name: "VMware classic cursor",
		rectangle: computerRfbRectangle(1464686180, 2, 2, Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(32, 3)])),
	},
	{
		name: "VMware alpha cursor",
		rectangle: computerRfbRectangle(1464686180, 2, 2, Buffer.concat([Buffer.from([1, 0]), pixels])),
	},
	{ name: "desktop name", rectangle: computerRfbRectangle(-307, 0, 0, length32(clipboard)) },
	{
		name: "desktop layout",
		rectangle: computerRfbRectangle(-308, 1920, 1200, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(16)])),
	},
	{ name: "LED state", rectangle: computerRfbRectangle(-261, 0, 0, Buffer.from([3])) },
	{ name: "desktop size", rectangle: computerRfbRectangle(-223, 1920, 1200) },
	{ name: "extended key capability", rectangle: computerRfbRectangle(-258, 0, 0) },
	{ name: "extended mouse capability", rectangle: computerRfbRectangle(-316, 0, 0) },
];

describe("server RFB clipboard boundary (framing fixtures, not cloud/render acceptance)", () => {
	it.each(encodings)(
		"preserves $name across every split while dropping adjacent clipboard messages",
		({ rectangle }) => {
			const update = computerRfbUpdate([rectangle]);
			const other = Buffer.concat([
				Buffer.from([2, 150, 250, 0, 1, 0, 248, 0, 0, 0, 0, 0, 0, 0, 3]),
				Buffer.from([3, 0, 1]),
			]);
			const wire = Buffer.concat([hello, clipboard, update, extended, other]);
			const expected = Buffer.concat([hello, update, other]);
			for (let split = 0; split <= wire.length; split++) {
				const parser = new CompanyComputerRfbServerParser();
				expect(
					Buffer.concat([...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))]),
				).toEqual(expected);
			}
			const parser = new CompanyComputerRfbServerParser();
			expect(Buffer.concat(Array.from(wire).flatMap((byte) => parser.push(Buffer.from([byte]))))).toEqual(expected);
		},
	);

	it("keeps framing across mixed rectangles, consecutive updates and fragmented clipboard payloads", () => {
		const update = computerRfbUpdate(encodings.map(({ rectangle }) => rectangle));
		const wire = Buffer.concat([hello, update, clipboard, update, extended, Buffer.from([2])]);
		const expected = Buffer.concat([hello, update, update, Buffer.from([2])]);
		for (const size of [1, 3, 7, 15, 64, 512, 65_536]) {
			const parser = new CompanyComputerRfbServerParser();
			const forwarded: Buffer[] = [];
			for (let offset = 0; offset < wire.length; offset += size)
				forwarded.push(...parser.push(wire.subarray(offset, offset + size)));
			expect(Buffer.concat(forwarded).equals(expected)).toBe(true);
		}
	});

	it("streams a full raw desktop with clipboard-shaped pixel bytes without buffering a whole frame", () => {
		const image = Buffer.alloc(1920 * 1200 * 4, 3);
		clipboard.copy(image, 65_530);
		const update = computerRfbUpdate([computerRfbRectangle(0, 1920, 1200, image)]);
		const wire = Buffer.concat([hello, update, clipboard, Buffer.from([2])]);
		const parser = new CompanyComputerRfbServerParser();
		const forwarded: Buffer[] = [];
		for (let index = 0; index < wire.length; index += 65_536)
			forwarded.push(...parser.push(wire.subarray(index, index + 65_536)));
		expect(Buffer.concat(forwarded).equals(Buffer.concat([hello, update, Buffer.from([2])]))).toBe(true);
	});

	it("handles compact lengths of two and three bytes without treating compressed bytes as messages", () => {
		for (const length of [128, 16_384]) {
			const body = Buffer.concat([Buffer.from([0x90]), compact(Buffer.alloc(length, 3))]);
			const update = computerRfbUpdate([computerRfbRectangle(7, 2, 2, body)]);
			const parser = new CompanyComputerRfbServerParser();
			expect(Buffer.concat(parser.push(Buffer.concat([hello, update, clipboard])))).toEqual(
				Buffer.concat([hello, update]),
			);
		}
	});

	it("honors LastRect and zero-sized rectangles without losing message boundaries", () => {
		const update = computerRfbUpdate(
			[
				computerRfbRectangle(0, 0, 0),
				computerRfbRectangle(5, 0, 0),
				computerRfbRectangle(6, 0, 0),
				computerRfbRectangle(16, 0, 0, length32(deflateSync(Buffer.alloc(0)))),
				computerRfbRectangle(-224, 0, 0),
			],
			65535,
		);
		const parser = new CompanyComputerRfbServerParser();
		expect(Buffer.concat(parser.push(Buffer.concat([hello, update, clipboard, Buffer.from([2])])))).toEqual(
			Buffer.concat([hello, update, Buffer.from([2])]),
		);
	});

	it("bounds clipboard payloads, including extended and empty messages", () => {
		const parser = new CompanyComputerRfbServerParser();
		parser.push(hello);
		expect(parser.push(computerRfbServerClipboard(""))).toEqual([]);
		expect(parser.push(computerRfbServerClipboard("x".repeat(65536), true))).toEqual([]);
		expect(() => parser.push(computerRfbServerClipboard("x".repeat(65537)))).toThrow("RFB_CLIPBOARD_LIMIT");
	});

	it("bounds chunk memory and framebuffer rectangle counts", () => {
		expect(() => new CompanyComputerRfbServerParser().push(Buffer.alloc(256 * 1024 + 1))).toThrow(
			"RFB_SERVER_BUFFER_LIMIT",
		);
		const parser = new CompanyComputerRfbServerParser();
		parser.push(hello);
		const update = computerRfbUpdate(Array.from({ length: 4097 }, () => computerRfbRectangle(0, 0, 0)));
		expect(() => parser.push(update)).toThrow("RFB_RECTANGLE_COUNT_LIMIT");
	});

	it("rejects unknown encodings and malformed server framing instead of bypassing the filter", () => {
		const tooLarge = Buffer.alloc(4);
		tooLarge.writeUInt32BE(16 * 1024 * 1024 + 1);
		for (const message of [
			Buffer.from([99]),
			computerRfbUpdate([computerRfbRectangle(999, 2, 2)]),
			computerRfbUpdate([computerRfbRectangle(0, 1921, 1200)]),
			computerRfbUpdate([computerRfbRectangle(16, 2, 2, tooLarge)]),
			computerRfbUpdate([computerRfbRectangle(7, 2, 2, Buffer.from([0xb0]))]),
			computerRfbUpdate([computerRfbRectangle(7, 0, 2, Buffer.from([0x40, 1, 0, 3, 3, 3]))]),
			computerRfbUpdate([computerRfbRectangle(5, 2, 2, Buffer.from([31]))]),
		]) {
			const parser = new CompanyComputerRfbServerParser();
			parser.push(hello);
			expect(() => parser.push(message)).toThrow();
		}
	});

	it("pins the guest handshake to the declared image format", () => {
		for (const [offset, value] of [
			[8, 3],
			[13, 2],
			[17, 1],
			[22, 8],
			[23, 8],
			[25, 0],
			[33, 16],
		]) {
			const invalid = Buffer.from(hello);
			invalid[offset] = value;
			expect(() => new CompanyComputerRfbServerParser().push(invalid)).toThrow();
		}
	});
});
