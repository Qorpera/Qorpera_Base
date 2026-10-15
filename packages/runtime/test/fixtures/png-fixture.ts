import { crc32, deflateSync } from "node:zlib";

// PNG files built byte by byte, so a test says exactly what the file holds.
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Buffer {
	const out = Buffer.alloc(12 + data.byteLength);
	out.writeUInt32BE(data.byteLength, 0);
	out.write(type, 4, "latin1");
	out.set(data, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
	return out;
}

export function pngHeader(width: number, height: number, depth: number, colour: number, interlace = 0): Buffer {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = depth;
	data[9] = colour;
	data[12] = interlace;
	return pngChunk("IHDR", data);
}

/** A PNG of rows already filtered (each starting with its filter byte), with chunks before its image data. */
export function pngFile(header: Buffer, rows: Uint8Array, ...before: Buffer[]): Buffer {
	return Buffer.concat([PNG_SIGNATURE, header, ...before, pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND")]);
}

/** Rows of samples, each after filter byte 0. */
export function pngRows(lines: number[][]): Buffer {
	return Buffer.from(lines.flatMap((line) => [0, ...line]));
}
