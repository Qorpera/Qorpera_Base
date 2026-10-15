import { createHash, randomBytes } from "node:crypto";
import {
	exifOrientation,
	FolderImageRefusal,
	type FolderImageView,
	folderImageFormat,
	folderImageView,
	MAX_FOLDER_IMAGE_BYTES,
	oneImageAtATime,
	otherImageFormat,
	SHOWN_MAX_BYTES,
} from "@qorpera/runtime/cloud-folder-images";
import { JpegChroma, JpegEncoder } from "image-in-browser/lib/src/formats/jpeg-encoder.js";
import { PngDecoder } from "image-in-browser/lib/src/formats/png-decoder.js";
import { WebPEncoder } from "image-in-browser/lib/src/formats/webp-encoder.js";
import { MemoryImage } from "image-in-browser/lib/src/image/image.js";
import { expect, it } from "vitest";
import { PNG_SIGNATURE, pngChunk, pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

type Rgba = [number, number, number, number];
const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

/** An 8-bit RGBA PNG, plain or Adam7-interlaced. */
function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => Rgba, interlaced = false): Buffer {
	const passes = interlaced
		? [
				[0, 0, 8, 8],
				[4, 0, 8, 8],
				[0, 4, 4, 8],
				[2, 0, 4, 4],
				[0, 2, 2, 4],
				[1, 0, 2, 2],
				[0, 1, 1, 2],
			]
		: [[0, 0, 1, 1]];
	const lines: number[][] = [];
	for (const [x0, y0, dx, dy] of passes)
		for (let y = y0; y < height; y += dy) {
			const line: number[] = [];
			for (let x = x0; x < width; x += dx) line.push(...pixel(x, y));
			if (line.length > 0) lines.push(line);
		}
	return pngFile(pngHeader(width, height, 8, 6, interlaced ? 1 : 0), pngRows(lines));
}
/** An 8-bit grey PNG of one level, whose rows deflate to almost nothing. */
function greyPng(width: number, height: number, level: number): Buffer {
	const data = Buffer.alloc((width + 1) * height, level);
	for (let y = 0; y < height; y++) data[y * (width + 1)] = 0;
	return pngFile(pngHeader(width, height, 8, 0), data);
}

/** The shown PNG, read back with the library's own decoder. */
function shown(view: FolderImageView) {
	const image = new PngDecoder().decode({ bytes: view.png });
	if (!image) throw new Error("The shown PNG does not decode");
	expect([image.width, image.height]).toEqual([view.shownWidth, view.shownHeight]);
	expect(view.sha256).toBe(createHash("sha256").update(view.png).digest("hex"));
	return {
		/** Colour type 2 (RGB) or 6 (RGBA). */
		colour: view.png[25],
		at(x: number, y: number): Rgba {
			const pixel = image.getPixel(x, y);
			return [pixel.r, pixel.g, pixel.b, image.numChannels === 4 ? pixel.a : 255].map(Number) as Rgba;
		},
	};
}

function refusal(bytes: Uint8Array): FolderImageRefusal {
	try {
		folderImageView(bytes);
	} catch (error) {
		expect(error).toBeInstanceOf(FolderImageRefusal);
		return error as FolderImageRefusal;
	}
	throw new Error("The image was shown");
}

/** A JPEG of a left red half and a right blue half, 16×8, with an EXIF orientation when one is given. */
function jpeg(orientation?: number): Buffer {
	const image = MemoryImage.fromBytes({
		width: 16,
		height: 8,
		numChannels: 3,
		bytes: Uint8Array.from({ length: 16 * 8 * 3 }, (_, i) => {
			const x = Math.floor(i / 3) % 16;
			return (x < 8 ? RED : BLUE)[i % 3];
		}).buffer,
	});
	const file = Buffer.from(new JpegEncoder(100).encode({ image, chroma: JpegChroma.yuv444 }));
	if (orientation === undefined) return file;
	// A little-endian TIFF block with one entry: tag 0x0112 (orientation), SHORT, one value.
	const tiff = Buffer.from([
		0x49,
		0x49,
		0x2a,
		0,
		8,
		0,
		0,
		0,
		1,
		0,
		0x12,
		0x01,
		3,
		0,
		1,
		0,
		0,
		0,
		orientation,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
	]);
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
	const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, payload.byteLength + 2]), payload]);
	return Buffer.concat([file.subarray(0, 2), app1, file.subarray(2)]);
}

// GIF: the LZW data of one pixel of colour 0, and of colour 1 (code size 2: clear, the colour, end).
const GIF_PIXEL_0 = [2, 2, 0x44, 0x01, 0];
const GIF_PIXEL_1 = [2, 2, 0x4c, 0x01, 0];
/** A GIF89a with a two-colour table (red, blue), a screen of the given size, and the given blocks. */
function gif(width: number, height: number, ...blocks: number[][]): Buffer {
	return Buffer.from([
		...Buffer.from("GIF89a", "latin1"),
		width & 0xff,
		width >> 8,
		height & 0xff,
		height >> 8,
		0x80,
		0,
		0,
		...RED.slice(0, 3),
		...BLUE.slice(0, 3),
		...blocks.flat(),
		0x3b,
	]);
}
/** A 1×1 frame at (left, top) and its image data. */
const frame = (left: number, top: number, data: number[]) => [0x2c, left, 0, top, 0, 1, 0, 1, 0, 0, ...data];

/** A WebP file of RIFF chunks. */
function webp(...chunks: [string, Uint8Array][]): Buffer {
	const body = Buffer.concat(
		chunks.flatMap(([tag, data]) => {
			const head = Buffer.alloc(8);
			head.write(tag, 0, "latin1");
			head.writeUInt32LE(data.byteLength, 4);
			return [head, data, Buffer.alloc(data.byteLength & 1)];
		}),
	);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(4 + body.byteLength, 4);
	head.write("WEBP", 8, "latin1");
	return Buffer.concat([head, body]);
}
/** The VP8L bitstream of a lossless WebP of one colour, made by the library's encoder. */
function vp8l(width: number, height: number, colour: Rgba): Uint8Array {
	const image = new MemoryImage({ width, height, numChannels: 3 });
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) image.setPixelRgb(x, y, colour[0], colour[1], colour[2]);
	const file = Buffer.from(new WebPEncoder().encode({ image }));
	for (let at = 12; at + 8 <= file.byteLength; ) {
		const size = file.readUInt32LE(at + 4);
		if (file.toString("latin1", at, at + 4) === "VP8L") return file.subarray(at + 8, at + 8 + size);
		at += 8 + size + (size & 1);
	}
	throw new Error("The encoder wrote no VP8L chunk");
}

it("knows the four shown formats, and other image formats by name, from a file's start", () => {
	const head = (...bytes: (number | string)[]) =>
		Buffer.concat(
			bytes.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from([part]))),
		);
	expect(folderImageFormat(PNG_SIGNATURE)).toBe("png");
	expect(folderImageFormat(head(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
	expect(folderImageFormat(head("GIF87a"))).toBe("gif");
	expect(folderImageFormat(head("GIF89a"))).toBe("gif");
	expect(folderImageFormat(head("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("webp");
	expect(folderImageFormat(head("RIFF", 0, 0, 0, 0, "WAVE"))).toBeUndefined();
	expect(folderImageFormat(head("GIF88a"))).toBeUndefined();
	expect(folderImageFormat(head("# a note"))).toBeUndefined();

	expect(otherImageFormat(head("II*", 0))).toBe("TIFF");
	expect(otherImageFormat(head("MM", 0, "*"))).toBe("TIFF");
	expect(otherImageFormat(head(0, 0, 0, 0x1c, "ftypavif"))).toBe("AVIF");
	expect(otherImageFormat(head(0, 0, 0, 0x18, "ftypheic"))).toBe("HEIF");
	expect(otherImageFormat(head(0, 0, 0, 0x18, "ftypisom"))).toBeUndefined();
	expect(otherImageFormat(head(0xff, 0x0a))).toBe("JPEG XL");
	expect(otherImageFormat(head(0, 0, 0, 0x0c, "JXL ", 0x0d, 0x0a, 0x87, 0x0a))).toBe("JPEG XL");
	// A BMP header: "BM", the file size, four reserved zero bytes, the pixel offset, then the size of its info header.
	expect(otherImageFormat(head("BM", 0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0))).toBe("BMP");
	// Text that starts with "BM" is not a BMP.
	expect(otherImageFormat(head("BMW sales by quarter, 2026"))).toBeUndefined();
	expect(otherImageFormat(PNG_SIGNATURE)).toBeUndefined();
});

it("shows a small PNG as it is: RGB when every pixel is opaque, RGBA when one is not", () => {
	const pixels: Rgba[][] = [
		[RED, BLUE, [0, 255, 0, 255]],
		[
			[10, 20, 30, 255],
			[200, 100, 50, 255],
			[1, 2, 3, 255],
		],
	];
	const opaque = folderImageView(rgbaPng(3, 2, (x, y) => pixels[y][x]));
	expect(opaque).toMatchObject({ format: "png", width: 3, height: 2, shownWidth: 3, shownHeight: 2 });
	const image = shown(opaque);
	expect(image.colour).toBe(2);
	for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) expect(image.at(x, y)).toEqual(pixels[y][x]);

	pixels[1][2] = [1, 2, 3, 40];
	const translucent = shown(folderImageView(rgbaPng(3, 2, (x, y) => pixels[y][x])));
	expect(translucent.colour).toBe(6);
	expect(translucent.at(2, 1)).toEqual([1, 2, 3, 40]);
	expect(translucent.at(0, 0)).toEqual(RED);
});

it("fits an image to 1920×1200, keeping its shape, and never enlarges one", () => {
	const sizes = (width: number, height: number) => {
		const view = folderImageView(greyPng(width, height, 77));
		expect(shown(view).at(0, 0)).toEqual([77, 77, 77, 255]);
		return [view.width, view.height, view.shownWidth, view.shownHeight];
	};
	expect(sizes(3840, 2400)).toEqual([3840, 2400, 1920, 1200]);
	expect(sizes(4000, 1000)).toEqual([4000, 1000, 1920, 480]);
	expect(sizes(1000, 3000)).toEqual([1000, 3000, 400, 1200]);
	expect(sizes(10, 10)).toEqual([10, 10, 10, 10]);
});

it("averages the pixels it shrinks, and a transparent pixel adds no colour", () => {
	// Opaque red next to transparent blue, 3840 wide: each shown pixel is half of each, so red at half alpha.
	const view = folderImageView(rgbaPng(3840, 1, (x) => (x % 2 === 0 ? RED : [0, 0, 255, 0])));
	expect([view.shownWidth, view.shownHeight]).toEqual([1920, 1]);
	const [r, g, b, a] = shown(view).at(700, 0);
	expect([r, g, b]).toEqual([255, 0, 0]);
	expect(a).toBeGreaterThanOrEqual(127);
	expect(a).toBeLessThanOrEqual(128);
});

it("keeps the shown PNG within the byte budget by shrinking it further, in its shape", () => {
	// RGBA noise, which no filter or deflate makes smaller.
	const stride = 1920 * 4 + 1;
	const noise = randomBytes(stride * 1200);
	for (let y = 0; y < 1200; y++) noise[y * stride] = 0;
	const view = folderImageView(pngFile(pngHeader(1920, 1200, 8, 6), noise));
	expect(view.png.byteLength).toBeLessThanOrEqual(SHOWN_MAX_BYTES);
	expect([view.width, view.height]).toEqual([1920, 1200]);
	expect(view.shownWidth).toBeLessThan(1920);
	expect(view.shownWidth / view.shownHeight).toBeCloseTo(1.6, 1);
	shown(view);
});

it("reads interlaced, palette, grey and 16-bit PNGs, with their transparency", () => {
	const pixel = (x: number, y: number): Rgba => [x * 40, y * 40, (x + y) * 20, 255 - x];
	const plain = folderImageView(rgbaPng(5, 5, pixel));
	const interlaced = folderImageView(rgbaPng(5, 5, pixel, true));
	expect(interlaced.sha256).toBe(plain.sha256);
	expect(shown(interlaced).at(4, 3)).toEqual(pixel(4, 3));

	// One-bit palette indices 0 and 1 (red, blue); tRNS makes red half transparent and leaves blue opaque.
	const palette = shown(
		folderImageView(
			pngFile(
				pngHeader(2, 1, 1, 3),
				pngRows([[0b0100_0000]]),
				pngChunk("PLTE", Uint8Array.from([...RED.slice(0, 3), ...BLUE.slice(0, 3)])),
				pngChunk("tRNS", Uint8Array.of(0x80)),
			),
		),
	);
	expect(palette.at(0, 0)).toEqual([255, 0, 0, 0x80]);
	expect(palette.at(1, 0)).toEqual(BLUE);

	// Sixteen-bit grey keeps each sample's high byte; tRNS's colour key makes its colour transparent.
	const grey = shown(
		folderImageView(
			pngFile(
				pngHeader(2, 1, 16, 0),
				pngRows([[0x12, 0x34, 0xff, 0xff]]),
				pngChunk("tRNS", Uint8Array.of(0xff, 0xff)),
			),
		),
	);
	expect(grey.at(0, 0)).toEqual([0x12, 0x12, 0x12, 255]);
	expect(grey.at(1, 0)[3]).toBe(0);
});

it("refuses a PNG it cannot read, by name, and anything that is not one of the four formats", () => {
	const good = greyPng(2, 2, 9);
	const damaged = Buffer.from(good);
	damaged[29] ^= 1; // a byte of IHDR's CRC
	expect(refusal(damaged)).toMatchObject({ reason: "unreadable", message: "a PNG chunk is damaged" });
	expect(refusal(Buffer.concat([PNG_SIGNATURE, Buffer.from("not chunks")])).reason).toBe("unreadable");
	expect(refusal(pngFile(pngHeader(2, 2, 8, 0), pngRows([[1, 2]]), pngChunk("ABCD", Uint8Array.of(1)))).message).toBe(
		"the PNG has a critical chunk this reader does not know",
	);
	expect(
		refusal(
			pngFile(
				pngHeader(2, 2, 8, 3),
				pngRows([
					[0, 0],
					[0, 0],
				]),
			),
		).message,
	).toBe("the PNG has no palette");
	// Image data that inflates to more than its rows take stops at their length.
	expect(refusal(pngFile(pngHeader(1, 1, 8, 0), Buffer.alloc(1_000_000)))).toMatchObject({
		reason: "unreadable",
		message: "the PNG image could not be read here",
	});
	expect(refusal(Buffer.from("# a note\n"))).toMatchObject({
		reason: "unreadable",
		message: "the file is not a PNG, JPEG, GIF or WebP image",
	});
});

it("refuses an image of more pixels than the cap from its header, in every format, before decoding it", () => {
	const tooLarge = (bytes: Uint8Array, size: string) =>
		expect(refusal(bytes)).toMatchObject({
			reason: "too_large",
			message: `the image has ${size} pixels, more than the 40 million shown here`,
		});
	// A PNG of only its header.
	tooLarge(Buffer.concat([PNG_SIGNATURE, pngHeader(8000, 6000, 8, 2)]), "8000×6000");
	// A JPEG of only its frame header: 8 bits, 6000 high, 8000 wide, three components.
	tooLarge(
		Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x17, 0x70, 0x1f, 0x40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
		"8000×6000",
	);
	// A JPEG is also held to the samples its frame codes: 6000×4000 at 4:4:4 is 72 million, at 4:2:0 36 million (and
	// then the file has no scan).
	const sampled = (luma: number) =>
		Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x0f, 0xa0, 0x17, 0x70, 3, 1, luma, 0, 2, 0x11, 1, 3, 0x11, 1]);
	expect(refusal(sampled(0x11))).toMatchObject({
		reason: "too_large",
		message: "the JPEG has 6000×4000 pixels in 72 million samples, more than the 40 million read here",
	});
	expect(refusal(sampled(0x22))).toMatchObject({ reason: "unreadable", message: "the JPEG has no image data" });
	// A GIF's canvas is its screen: one pixel on a screen of 8000×6000.
	tooLarge(gif(8000, 6000, frame(0, 0, GIF_PIXEL_0)), "8000×6000");
	// A lossless WebP's size is in its bitstream's first bytes: 16384×16384.
	tooLarge(webp(["VP8L", Uint8Array.of(0x2f, 0xff, 0xff, 0xff, 0x0f)]), "16384×16384");
	// And a file larger than the cap is not read at all.
	const huge = Buffer.alloc(MAX_FOLDER_IMAGE_BYTES + 1);
	huge.set(PNG_SIGNATURE);
	expect(refusal(huge)).toMatchObject({ reason: "too_large", message: "the file is larger than 64 MiB" });
});

it("shows a JPEG upright by its EXIF orientation", () => {
	const top = (view: FolderImageView) => shown(view).at(Math.floor(view.shownWidth / 2), 2);
	const bottom = (view: FolderImageView) => shown(view).at(Math.floor(view.shownWidth / 2), view.shownHeight - 3);
	const near = (colour: Rgba) => (actual: Rgba) => {
		for (let i = 0; i < 4; i++) expect(Math.abs(actual[i] - colour[i])).toBeLessThan(24);
	};
	const stored = folderImageView(jpeg());
	expect(stored).toMatchObject({ format: "jpeg", width: 16, height: 8, shownWidth: 16, shownHeight: 8 });
	near(RED)(shown(stored).at(2, 4));
	near(BLUE)(shown(stored).at(13, 4));
	// 6: turned a quarter clockwise to stand up, so the stored left half (red) is the upright top.
	const six = folderImageView(jpeg(6));
	expect(six).toMatchObject({ width: 8, height: 16, shownWidth: 8, shownHeight: 16 });
	near(RED)(top(six));
	near(BLUE)(bottom(six));
	// 8: a quarter the other way, so blue is on top.
	const eight = folderImageView(jpeg(8));
	expect(eight).toMatchObject({ width: 8, height: 16 });
	near(BLUE)(top(eight));
	near(RED)(bottom(eight));
	// 3: half a turn, so the halves swap sides.
	const three = shown(folderImageView(jpeg(3)));
	near(BLUE)(three.at(2, 4));
	near(RED)(three.at(13, 4));

	// The orientation is read from the first IFD only, and only as one SHORT from 1 to 8.
	const ifd = (order: "II" | "MM", type: number, value: number) => {
		const tiff = Buffer.alloc(26);
		tiff.write(order, 0, "latin1");
		const little = order === "II";
		const u16 = (at: number, n: number) => (little ? tiff.writeUInt16LE(n, at) : tiff.writeUInt16BE(n, at));
		const u32 = (at: number, n: number) => (little ? tiff.writeUInt32LE(n, at) : tiff.writeUInt32BE(n, at));
		u16(2, 42);
		u32(4, 8);
		u16(8, 1);
		u16(10, 0x0112);
		u16(12, type);
		u32(14, 1);
		u16(18, value);
		return tiff;
	};
	expect(exifOrientation(ifd("MM", 3, 3))).toBe(3);
	expect(exifOrientation(ifd("II", 3, 8))).toBe(8);
	expect(exifOrientation(ifd("II", 4, 6))).toBe(1);
	expect(exifOrientation(ifd("II", 3, 9))).toBe(1);
	expect(exifOrientation(ifd("II", 3, 6).subarray(0, 20))).toBe(1);
});

it("refuses a JPEG coding it does not read, and a segment that hides a marker, by name", () => {
	// A lossless frame (SOF3).
	expect(refusal(Buffer.from([0xff, 0xd8, 0xff, 0xc3, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])).message).toBe(
		"the JPEG uses a coding this reader does not support (marker c3)",
	);
	// Twelve-bit samples.
	expect(refusal(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 12, 0, 1, 0, 1, 1, 1, 0x11, 0])).message).toBe(
		"the JPEG does not have 8-bit samples",
	);
	// A quantization table whose bytes read as a frame marker.
	expect(refusal(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 6, 0xff, 0xc0, 0, 0])).message).toBe(
		"the JPEG has a marker inside a segment",
	);
	// No frame or scan at all.
	expect(refusal(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).message).toBe("the JPEG has no image data");
});

it("shows a GIF's first frame where it sits on the canvas, and nothing of the frames after it", () => {
	const view = folderImageView(gif(3, 2, frame(2, 1, GIF_PIXEL_0), frame(0, 0, GIF_PIXEL_1)));
	expect(view).toMatchObject({ format: "gif", width: 3, height: 2, shownWidth: 3, shownHeight: 2 });
	const image = shown(view);
	expect(image.at(2, 1)).toEqual(RED);
	for (const [x, y] of [
		[0, 0],
		[1, 0],
		[2, 0],
		[0, 1],
		[1, 1],
	])
		expect(image.at(x, y)[3]).toBe(0);

	// A frame past the screen's edge grows the canvas to hold it.
	expect(folderImageView(gif(1, 1, frame(2, 1, GIF_PIXEL_1)))).toMatchObject({ width: 3, height: 2 });
	// The graphic control extension before the frame makes its colour 0 transparent.
	const transparent = folderImageView(gif(1, 1, [0x21, 0xf9, 4, 1, 0, 0, 0, 0], frame(0, 0, GIF_PIXEL_0)));
	expect(shown(transparent).at(0, 0)[3]).toBe(0);
	expect(refusal(gif(1, 1, [0x99])).message).toBe("the GIF has a block this reader does not know");
});

it("shows a still WebP, and the first frame of an animated one", () => {
	const still = folderImageView(webp(["VP8L", vp8l(4, 2, RED)]));
	expect(still).toMatchObject({ format: "webp", width: 4, height: 2, shownWidth: 4, shownHeight: 2 });
	expect(shown(still).at(3, 1)).toEqual(RED);

	// VP8X with the animation flag, ANIM, then two frames: red and blue.
	const extended = Buffer.alloc(10);
	extended[0] = 0x02;
	extended.writeUIntLE(1, 4, 3);
	extended.writeUIntLE(1, 7, 3);
	const animationFrame = (colour: Rgba) => {
		const head = Buffer.alloc(16);
		head.writeUIntLE(1, 6, 3);
		head.writeUIntLE(1, 9, 3);
		head.writeUIntLE(100, 12, 3);
		const data = vp8l(2, 2, colour);
		const tag = Buffer.alloc(8);
		tag.write("VP8L", 0, "latin1");
		tag.writeUInt32LE(data.byteLength, 4);
		return Buffer.concat([head, tag, data, Buffer.alloc(data.byteLength & 1)]);
	};
	const animated = folderImageView(
		webp(
			["VP8X", extended],
			["ANIM", Buffer.alloc(6)],
			["ANMF", animationFrame(RED)],
			["ANMF", animationFrame(BLUE)],
		),
	);
	expect(animated).toMatchObject({ width: 2, height: 2 });
	expect(shown(animated).at(1, 1)).toEqual(RED);
	expect(refusal(webp(["VP8X", extended], ["ANIM", Buffer.alloc(6)])).message).toBe("the WebP has no image");
});

it("reads a WebP's chunks only up to its image, and refuses one with many chunks before it", () => {
	const image = webp(["VP8L", vp8l(1, 1, RED)]);
	/** The image with empty chunks (eight bytes each) before and after it. */
	const padded = (before: number, after: number) => {
		const empty = (count: number) => {
			const run = Buffer.alloc(8 * count);
			for (let i = 0; i < count; i++) run.write("JUNK", 8 * i, "latin1");
			return run;
		};
		const body = Buffer.concat([empty(before), image.subarray(12), empty(after)]);
		const head = Buffer.from(image.subarray(0, 12));
		head.writeUInt32LE(4 + body.byteLength, 4);
		return Buffer.concat([head, body]);
	};
	expect(folderImageView(padded(64, 0))).toMatchObject({ format: "webp", width: 1, height: 1 });
	expect(refusal(padded(65, 0)).message).toBe("the WebP has too many chunks before its image");
	// A file under the size cap holds millions of empty chunks: the reader stops at the 65th, and never reads the
	// ones after the image.
	expect(refusal(padded(1_000_000, 0)).message).toBe("the WebP has too many chunks before its image");
	expect(folderImageView(padded(0, 1_000_000))).toMatchObject({ format: "webp", width: 1, height: 1 });
});

it("reads and converts one image at a time, and a call that stops waiting never runs", async () => {
	const order: string[] = [];
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = () => resolve();
	});
	const task = (name: string, wait?: Promise<void>) => async () => {
		order.push(`${name} starts`);
		if (name === "c") throw new Error("c failed");
		await wait;
		order.push(`${name} ends`);
		return name;
	};
	const settled = (promise: Promise<string>) => promise.catch((error: Error) => `refused: ${error.message}`);
	// Several turns of the event loop: everything that can run by then has.
	const turns = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const live = new AbortController().signal;
	const stopped = new AbortController();
	const a = settled(oneImageAtATime(live, task("a", opened)));
	const b = settled(oneImageAtATime(stopped.signal, task("b")));
	const c = settled(oneImageAtATime(live, task("c")));
	const d = settled(oneImageAtATime(live, task("d")));
	await turns();
	expect(order).toEqual(["a starts"]);
	// b stops waiting at once, and c still waits for a.
	stopped.abort(new Error("the run stopped"));
	expect(await b).toBe("refused: the run stopped");
	await turns();
	expect(order).toEqual(["a starts"]);
	open();
	expect(await Promise.all([a, c, d])).toEqual(["a", "refused: c failed", "d"]);
	expect(order).toEqual(["a starts", "a ends", "c starts", "d starts", "d ends"]);
	// A call whose run has already stopped never queues.
	expect(await settled(oneImageAtATime(AbortSignal.abort(new Error("stopped before")), task("e")))).toBe(
		"refused: stopped before",
	);
	expect(order).not.toContain("e starts");
});
