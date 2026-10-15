import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { Format } from "image-in-browser/lib/src/color/format.js";
import { GifDecoder } from "image-in-browser/lib/src/formats/gif-decoder.js";
import { JpegDecoder } from "image-in-browser/lib/src/formats/jpeg-decoder.js";
import { WebPDecoder } from "image-in-browser/lib/src/formats/webp-decoder.js";
import type { MemoryImage } from "image-in-browser/lib/src/image/image.js";

/*
 * The images company_read shows the model (chat images on folder-v2, PR3; the coordinator's decision of 14 October
 * 2026): a folder file that is a PNG, JPEG, GIF or WebP image is shown as one PNG of at most 1920×1200 pixels made
 * here, and the file itself stays exactly what the member or the machine wrote.
 *
 * - The pinned fence (0001-cloud-result-fence.patch) takes a tool result's image only as such a PNG, and it counts
 *   every image a request carries against one batch, so the PNG is also fitted to at most SHOWN_MAX_BYTES.
 * - Everything is JavaScript in this process: our own PNG decoder and encoder over node:zlib, and the pinned
 *   image-in-browser for JPEG, GIF and WebP. Those decoders trust their input (a JPEG allocates every block of its
 *   frame when it reads the frame header, its EXIF reader follows IFD loops, a GIF or WebP decodes every frame), so
 *   each gets a canonical file rebuilt here from what that format allows, after its size is checked: an image of more
 *   than MAX_IMAGE_PIXELS pixels, or a JPEG coding more than MAX_JPEG_SAMPLES samples, is refused by name before
 *   anything is allocated for its pixels.
 * - A JPEG's EXIF orientation is applied; a GIF or an animated WebP shows its first frame.
 * - The work is synchronous and takes a few seconds for a large image (2.7 seconds for a 26-megapixel JPEG on the test
 *   machine), during which this process does nothing else. Images are read and converted one at a time, with the event
 *   loop turning between them (oneImageAtATime), so the company host holds one image file and one decode, the peak
 *   measured for MAX_JPEG_SAMPLES.
 */

export type FolderImageFormat = "png" | "jpeg" | "gif" | "webp";

/** The largest image file read whole; a larger one is refused by name. */
export const MAX_FOLDER_IMAGE_BYTES = 64 * 1024 * 1024;
/** The most pixels an image may have (its canvas, for a GIF), a guard against decompression bombs. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/**
 * The most samples a JPEG's frame may code, every component at its own sampling. The library holds every block of the
 * frame at once, some 13 bytes a sample: on the test machine a 40-megapixel JPEG at full colour detail (4:4:4, 120
 * million samples) peaked at 1.6 GB, and the company host may use 2 GB. 40 million samples is a 26-megapixel photo at
 * the usual 4:2:0, 13 megapixels at 4:4:4.
 */
export const MAX_JPEG_SAMPLES = 40_000_000;
/** The fence's limits for a tool result's image, and the size each PNG is fitted to. */
export const SHOWN_MAX_WIDTH = 1920;
export const SHOWN_MAX_HEIGHT = 1200;
export const SHOWN_MAX_BYTES = 1024 * 1024;
/** A JPEG's scans each decode the whole frame again, and its other segments are tables. */
const MAX_JPEG_SCANS = 32;
const MAX_JPEG_SEGMENTS = 256;

export type FolderImageRefusalReason = "too_large" | "unreadable";

/** An image that is not shown: too large to convert here, or not one this module can read. */
export class FolderImageRefusal extends Error {
	readonly reason: FolderImageRefusalReason;
	constructor(reason: FolderImageRefusalReason, message: string) {
		super(message);
		this.name = "FolderImageRefusal";
		this.reason = reason;
	}
}

export interface FolderImageView {
	format: FolderImageFormat;
	/** The image upright, as a viewer shows it. */
	width: number;
	height: number;
	/** The PNG the model sees. */
	shownWidth: number;
	shownHeight: number;
	png: Buffer;
	sha256: string;
}

/** How much of a file's start tells its image format. */
export const IMAGE_HEAD_BYTES = 32;

/** The format an image file starts with (its first 16 bytes are enough), or undefined. */
export function folderImageFormat(head: Uint8Array): FolderImageFormat | undefined {
	const at = (offset: number, ...expected: number[]) => expected.every((byte, i) => head[offset + i] === byte);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
	if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
	return undefined;
}

/** The name of another image format a file starts with (one that is not shown here; its first IMAGE_HEAD_BYTES bytes
 * are enough), or undefined. */
export function otherImageFormat(head: Uint8Array): string | undefined {
	const at = (offset: number, ...expected: number[]) => expected.every((byte, i) => head[offset + i] === byte);
	const text = (offset: number, length: number) => String.fromCharCode(...head.subarray(offset, offset + length));
	if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return "TIFF";
	if (at(0, 0xff, 0x0a) || at(0, 0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a)) return "JPEG XL";
	if (text(4, 4) === "ftyp") {
		const brand = text(8, 4);
		if (brand === "avif" || brand === "avis") return "AVIF";
		if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "HEIF";
	}
	// A BMP's "BM" alone is too common a start of text: its reserved bytes are zero and its header size is a known one.
	if (at(0, 0x42, 0x4d) && at(6, 0, 0, 0, 0) && [12, 40, 52, 56, 64, 108, 124].includes(head[14]) && at(15, 0, 0, 0))
		return "BMP";
	return undefined;
}

/** Settles when the last image task queued in this process, and every one before it, is done. */
let lastImageTask: Promise<void> = Promise.resolve();

/**
 * Runs an image task (reading a file whole and making its PNG) once every one queued before it in this process is done,
 * and the event loop has turned since, so the work waiting behind an image runs before the next image. A task waits its
 * turn with nothing read; one whose signal aborts while it waits stops waiting and never runs.
 */
export async function oneImageAtATime<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
	const before = lastImageTask;
	let done = () => {};
	lastImageTask = new Promise((resolve) => {
		done = () => resolve();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			if (signal.aborted) return abort();
			signal.addEventListener("abort", abort, { once: true });
			void before.then(() =>
				setImmediate(() => {
					signal.removeEventListener("abort", abort);
					resolve();
				}),
			);
		});
		return await task();
	} finally {
		// The next task starts only after this one and every one before it, even when this one stopped waiting.
		void before.then(done);
	}
}

/** The PNG the model sees of an image file. Throws FolderImageRefusal for anything it does not show. */
export function folderImageView(bytes: Uint8Array): FolderImageView {
	const format = folderImageFormat(bytes);
	if (format === undefined)
		throw new FolderImageRefusal("unreadable", "the file is not a PNG, JPEG, GIF or WebP image");
	if (bytes.byteLength > MAX_FOLDER_IMAGE_BYTES)
		throw new FolderImageRefusal("too_large", `the file is larger than ${MAX_FOLDER_IMAGE_BYTES / 1024 / 1024} MiB`);
	try {
		const raster = RASTERS[format](bytes);
		const scale = Math.min(1, SHOWN_MAX_WIDTH / raster.width, SHOWN_MAX_HEIGHT / raster.height);
		const fitWidth = Math.min(SHOWN_MAX_WIDTH, Math.max(1, Math.round(raster.width * scale)));
		const fitHeight = Math.min(SHOWN_MAX_HEIGHT, Math.max(1, Math.round(raster.height * scale)));
		const fitted = resample(raster, fitWidth, fitHeight);
		// Fitted to the byte budget from the fitted pixels: each try shrinks by what the last one overshot.
		let shownWidth = fitWidth;
		let shownHeight = fitHeight;
		let png = encodePng(fitted, shownWidth, shownHeight);
		for (let tries = 0; png.byteLength > SHOWN_MAX_BYTES; tries++) {
			if (tries === 16) throw new Error("The image does not fit the byte budget");
			const factor = Math.sqrt(SHOWN_MAX_BYTES / png.byteLength) * 0.9;
			shownWidth = Math.max(1, Math.floor(shownWidth * factor));
			shownHeight = Math.max(1, Math.floor(shownHeight * factor));
			const smaller = resample(bufferRaster(fitted, fitWidth, fitHeight), shownWidth, shownHeight);
			png = encodePng(smaller, shownWidth, shownHeight);
		}
		return {
			format,
			width: raster.width,
			height: raster.height,
			shownWidth,
			shownHeight,
			png,
			sha256: createHash("sha256").update(png).digest("hex"),
		};
	} catch (error) {
		if (error instanceof FolderImageRefusal) throw error;
		throw new FolderImageRefusal("unreadable", `the ${format.toUpperCase()} image could not be read here`);
	}
}

/** An upright image as rows of 8-bit RGBA, top to bottom, delivered once. */
interface Raster {
	width: number;
	height: number;
	rows(each: (row: Uint8Array) => void): void;
}

const RASTERS: Record<FolderImageFormat, (bytes: Uint8Array) => Raster> = {
	png: pngRaster,
	jpeg: jpegRaster,
	gif: gifRaster,
	webp: webpRaster,
};

function unreadable(message: string): never {
	throw new FolderImageRefusal("unreadable", message);
}

function checkPixels(width: number, height: number): void {
	if (width * height > MAX_IMAGE_PIXELS)
		throw new FolderImageRefusal(
			"too_large",
			`the image has ${width}×${height} pixels, more than the ${MAX_IMAGE_PIXELS / 1_000_000} million shown here`,
		);
}

function bufferRaster(rgba: Uint8Array, width: number, height: number): Raster {
	return {
		width,
		height,
		rows(each) {
			for (let y = 0; y < height; y++) each(rgba.subarray(y * width * 4, (y + 1) * width * 4));
		},
	};
}

/*
 * Resampling: each target pixel is the area average of the source pixels it covers, with alpha premultiplied, so
 * transparent pixels add no colour. It never enlarges. In units of 1/(source × target) of the image, a source pixel
 * spans `target` units and a target pixel `source` units, so a source pixel falls into at most two target pixels; the
 * same holds for rows, and rows arrive one at a time into float sums the size of the target.
 */
function resample(source: Raster, width: number, height: number): Uint8Array {
	const sourceWidth = source.width;
	const sourceHeight = source.height;
	const sums = new Float32Array(width * height * 4);
	const line = new Float32Array(width * 4 + 4);
	const addLine = (target: number, weight: number) => {
		for (let i = 0, j = target * width * 4; i < width * 4; i++, j++) sums[j] += line[i] * weight;
	};
	let y = 0;
	source.rows((row) => {
		line.fill(0);
		let column = 0;
		let boundary = sourceWidth;
		for (let x = 0, i = 0; x < sourceWidth; x++, i += 4) {
			const start = x * width;
			while (start >= boundary) {
				column++;
				boundary += sourceWidth;
			}
			const alpha = row[i + 3];
			if (alpha === 0) continue;
			const leftUnits = Math.min(start + width, boundary) - start;
			const left = (leftUnits / sourceWidth) * alpha;
			const j = column * 4;
			line[j] += row[i] * left;
			line[j + 1] += row[i + 1] * left;
			line[j + 2] += row[i + 2] * left;
			line[j + 3] += left;
			if (leftUnits < width) {
				const right = ((width - leftUnits) / sourceWidth) * alpha;
				line[j + 4] += row[i] * right;
				line[j + 5] += row[i + 1] * right;
				line[j + 6] += row[i + 2] * right;
				line[j + 7] += right;
			}
		}
		const rowStart = y * height;
		const target = Math.floor(rowStart / sourceHeight);
		const topUnits = Math.min(rowStart + height, (target + 1) * sourceHeight) - rowStart;
		addLine(target, topUnits / sourceHeight);
		if (topUnits < height) addLine(target + 1, (height - topUnits) / sourceHeight);
		y++;
	});
	if (y !== sourceHeight) throw new Error("The image delivered the wrong number of rows");
	const out = new Uint8Array(width * height * 4);
	for (let i = 0; i < out.length; i += 4) {
		const alpha = sums[i + 3];
		if (alpha <= 0) continue;
		out[i] = Math.min(255, Math.round(sums[i] / alpha));
		out[i + 1] = Math.min(255, Math.round(sums[i + 1] / alpha));
		out[i + 2] = Math.min(255, Math.round(sums[i + 2] / alpha));
		out[i + 3] = Math.min(255, Math.round(alpha));
	}
	return out;
}

/** An 8-bit PNG of RGBA pixels: RGB when every pixel is opaque, each row with the filter that varies least. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
	let opaque = true;
	for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
	const channels = opaque ? 3 : 4;
	const stride = width * channels;
	const filtered = Buffer.alloc((stride + 1) * height);
	let previous = new Uint8Array(stride);
	let current = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		for (let x = 0, i = y * width * 4, j = 0; x < width; x++, i += 4) {
			current[j++] = rgba[i];
			current[j++] = rgba[i + 1];
			current[j++] = rgba[i + 2];
			if (channels === 4) current[j++] = rgba[i + 3];
		}
		let best = 0;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let filter = 0; filter < 5; filter++) {
			let score = 0;
			for (let i = 0; i < stride && score < bestScore; i++) {
				const value = (current[i] - predicted(filter, current, previous, i, channels)) & 0xff;
				score += value < 128 ? value : 256 - value;
			}
			if (score < bestScore) {
				bestScore = score;
				best = filter;
			}
		}
		const offset = y * (stride + 1);
		filtered[offset] = best;
		for (let i = 0; i < stride; i++)
			filtered[offset + 1 + i] = (current[i] - predicted(best, current, previous, i, channels)) & 0xff;
		[previous, current] = [current, previous];
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = opaque ? 2 : 6;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(filtered, { level: 6 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

/** What PNG filter `filter` predicts for byte i of a row, from the bytes left of it and the row above. */
function predicted(filter: number, row: Uint8Array, above: Uint8Array, i: number, step: number): number {
	if (filter === 0) return 0;
	const left = i >= step ? row[i - step] : 0;
	if (filter === 1) return left;
	if (filter === 2) return above[i];
	if (filter === 3) return (left + above[i]) >>> 1;
	return paeth(left, above[i], i >= step ? above[i - step] : 0);
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const toLeft = Math.abs(estimate - left);
	const toUp = Math.abs(estimate - up);
	const toUpLeft = Math.abs(estimate - upLeft);
	if (toLeft <= toUp && toLeft <= toUpLeft) return left;
	return toUp <= toUpLeft ? up : upLeft;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const chunk = Buffer.alloc(12 + data.byteLength);
	chunk.writeUInt32BE(data.byteLength, 0);
	chunk.write(type, 4, "latin1");
	chunk.set(data, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
	return chunk;
}

/*
 * PNG. Our own decoder, because the library's inflates without an output limit: the chunks are walked strictly (the
 * CRCs of the chunks it uses are checked, and an unknown critical chunk refuses the file), the size is checked from
 * IHDR, and the image data is inflated with node:zlib to exactly the length its rows take, and no more. Rows are
 * unfiltered in place and delivered one at a time; an interlaced image is assembled first. An APNG shows its default
 * image.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const TRNS = 0x74524e53;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
/** A chunk whose type's first letter is upper case is critical. */
const ANCILLARY = 0x20000000;
/** Channels per colour type, and the bit depths each allows. */
const PNG_COLOUR_TYPES = new Map<number, { channels: number; depths: readonly number[] }>([
	[0, { channels: 1, depths: [1, 2, 4, 8, 16] }],
	[2, { channels: 3, depths: [8, 16] }],
	[3, { channels: 1, depths: [1, 2, 4, 8] }],
	[4, { channels: 2, depths: [8, 16] }],
	[6, { channels: 4, depths: [8, 16] }],
]);
/** The seven Adam7 passes: first column and row, then the step between columns and rows. */
const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
] as const;

interface PngImage {
	width: number;
	height: number;
	depth: number;
	colour: number;
	channels: number;
	interlaced: boolean;
	palette: Uint8Array | undefined;
	transparency: Uint8Array | undefined;
}

function pngRaster(bytes: Uint8Array): Raster {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	/** Every chunk after the signature, in order, up to IEND. */
	const chunks = (each: (type: number, data: Uint8Array) => void) => {
		for (let at = 8; at < bytes.byteLength; ) {
			if (at + 12 > bytes.byteLength) unreadable("the PNG ends inside a chunk");
			const length = view.getUint32(at);
			const type = view.getUint32(at + 4);
			if (length > 0x7fffffff || at + 12 + length > bytes.byteLength) unreadable("the PNG ends inside a chunk");
			const checked = (type & ANCILLARY) === 0 || type === TRNS;
			if (checked && crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length))
				unreadable("a PNG chunk is damaged");
			if (type === IEND) return;
			each(type, bytes.subarray(at + 8, at + 8 + length));
			at += 12 + length;
		}
		unreadable("the PNG has no end");
	};
	let image: PngImage | undefined;
	let idatBytes = 0;
	let idatChunks = 0;
	let firstIdat: Uint8Array | undefined;
	chunks((type, data) => {
		if (image === undefined) {
			if (type !== IHDR || data.byteLength !== 13) unreadable("the PNG does not start with its header");
			const header = new DataView(data.buffer, data.byteOffset, 13);
			const width = header.getUint32(0);
			const height = header.getUint32(4);
			const kind = PNG_COLOUR_TYPES.get(data[9]);
			if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff)
				unreadable("the PNG has no pixels");
			if (!kind?.depths.includes(data[8]) || data[10] !== 0 || data[11] !== 0 || data[12] > 1)
				unreadable("the PNG's header is not valid");
			checkPixels(width, height);
			image = {
				width,
				height,
				depth: data[8],
				colour: data[9],
				channels: kind.channels,
				interlaced: data[12] === 1,
				palette: undefined,
				transparency: undefined,
			};
			return;
		}
		if (type === IHDR) unreadable("the PNG has two headers");
		if (type === IDAT) {
			idatBytes += data.byteLength;
			idatChunks++;
			firstIdat ??= data;
		} else if (idatChunks > 0) {
			if ((type & ANCILLARY) === 0) unreadable("the PNG has a critical chunk after its image data");
		} else if (type === PLTE) {
			if (image.palette || data.byteLength === 0 || data.byteLength % 3 !== 0 || data.byteLength > 768)
				unreadable("the PNG's palette is not valid");
			image.palette = data;
		} else if (type === TRNS) image.transparency = data;
		else if ((type & ANCILLARY) === 0) unreadable("the PNG has a critical chunk this reader does not know");
	});
	const png = image;
	if (png === undefined || firstIdat === undefined) unreadable("the PNG has no image data");
	if (png.colour === 3 && png.palette === undefined) unreadable("the PNG has no palette");
	let compressed = firstIdat;
	if (idatChunks > 1) {
		const whole = Buffer.allocUnsafe(idatBytes);
		let at = 0;
		chunks((type, data) => {
			if (type !== IDAT) return;
			whole.set(data, at);
			at += data.byteLength;
		});
		compressed = whole;
	}
	const bitsPerPixel = png.channels * png.depth;
	const rowBytes = (width: number) => Math.ceil((width * bitsPerPixel) / 8);
	const passes = png.interlaced
		? ADAM7.map(([x0, y0, dx, dy]) => ({
				x0,
				y0,
				dx,
				dy,
				width: png.width > x0 ? Math.ceil((png.width - x0) / dx) : 0,
				height: png.height > y0 ? Math.ceil((png.height - y0) / dy) : 0,
			})).filter((pass) => pass.width > 0 && pass.height > 0)
		: [{ x0: 0, y0: 0, dx: 1, dy: 1, width: png.width, height: png.height }];
	const expected = passes.reduce((sum, pass) => sum + pass.height * (1 + rowBytes(pass.width)), 0);
	// One output buffer of exactly the rows' length: a stream that inflates to more fails at maxOutputLength.
	const data = inflateSync(compressed, { chunkSize: Math.max(64, expected + 1), maxOutputLength: expected });
	if (data.byteLength !== expected) unreadable("the PNG's image data is cut short");
	const step = Math.max(1, bitsPerPixel >> 3);
	const toRgba = pngRowReader(png);
	let at = 0;
	/** Unfilters the next row of a pass in place, and returns where its bytes start. */
	const unfilter = (length: number, first: boolean): number => {
		const filter = data[at];
		const start = at + 1;
		const end = start + length;
		const above = length + 1;
		if (filter > 4) unreadable("a PNG row has an unknown filter");
		if (filter === 1) for (let i = start + step; i < end; i++) data[i] += data[i - step];
		else if (filter === 2 && !first) for (let i = start; i < end; i++) data[i] += data[i - above];
		else if (filter === 3)
			for (let i = start; i < end; i++)
				data[i] += ((i - start >= step ? data[i - step] : 0) + (first ? 0 : data[i - above])) >>> 1;
		else if (filter === 4)
			for (let i = start; i < end; i++) {
				const hasLeft = i - start >= step;
				const left = hasLeft ? data[i - step] : 0;
				data[i] += first ? left : paeth(left, data[i - above], hasLeft ? data[i - above - step] : 0);
			}
		at = end;
		return start;
	};
	return {
		width: png.width,
		height: png.height,
		rows(each) {
			if (!png.interlaced) {
				const row = new Uint8Array(png.width * 4);
				const length = rowBytes(png.width);
				for (let y = 0; y < png.height; y++) {
					toRgba(data, unfilter(length, y === 0), png.width, row);
					each(row);
				}
				return;
			}
			const whole = new Uint8Array(png.width * png.height * 4);
			for (const pass of passes) {
				const row = new Uint8Array(pass.width * 4);
				const length = rowBytes(pass.width);
				for (let j = 0; j < pass.height; j++) {
					toRgba(data, unfilter(length, j === 0), pass.width, row);
					const y = pass.y0 + j * pass.dy;
					for (let i = 0, o = (y * png.width + pass.x0) * 4; i < row.length; i += 4, o += pass.dx * 4) {
						whole[o] = row[i];
						whole[o + 1] = row[i + 1];
						whole[o + 2] = row[i + 2];
						whole[o + 3] = row[i + 3];
					}
				}
			}
			bufferRaster(whole, png.width, png.height).rows(each);
		},
	};
}

/**
 * Converts one unfiltered PNG row to 8-bit RGBA: 16-bit samples keep their high byte, lower depths scale up, and the
 * tRNS chunk's colour key or palette alphas make pixels transparent.
 */
function pngRowReader(png: PngImage): (data: Uint8Array, start: number, width: number, out: Uint8Array) => void {
	const { depth, colour, channels } = png;
	const palette = png.palette ?? new Uint8Array(0);
	const transparency = png.transparency ?? new Uint8Array(0);
	if (depth === 8 && colour === 6)
		return (data, start, width, out) => out.set(data.subarray(start, start + width * 4));
	const mask = (1 << depth) - 1;
	const scale = depth < 8 ? 255 / mask : 1;
	/** Sample i of a row at the image's depth. */
	const sample = (data: Uint8Array, start: number, i: number): number => {
		if (depth === 8) return data[start + i];
		if (depth === 16) return (data[start + 2 * i] << 8) | data[start + 2 * i + 1];
		const bit = i * depth;
		return (data[start + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
	};
	const eight = (value: number) => (depth === 16 ? value >> 8 : value * scale);
	/** A colour key from tRNS, as wide as the samples it is compared with, or -1. */
	const key = (i: number) =>
		transparency.byteLength >= 2 * i + 2 ? (transparency[2 * i] << 8) | transparency[2 * i + 1] : -1;
	const keyed = (colour === 0 && transparency.byteLength >= 2) || (colour === 2 && transparency.byteLength >= 6);
	const [red, green, blue] = keyed ? [key(0), key(1), key(2)] : [-1, -1, -1];
	const colours = palette.byteLength / 3;
	return (data, start, width, out) => {
		for (let x = 0, o = 0; x < width; x++, o += 4) {
			if (colour === 3) {
				const index = sample(data, start, x);
				const known = index < colours;
				out[o] = known ? palette[3 * index] : 0;
				out[o + 1] = known ? palette[3 * index + 1] : 0;
				out[o + 2] = known ? palette[3 * index + 2] : 0;
				out[o + 3] = known && index < transparency.byteLength ? transparency[index] : 255;
			} else if (colour === 0 || colour === 4) {
				const value = sample(data, start, x * channels);
				const level = eight(value);
				out[o] = level;
				out[o + 1] = level;
				out[o + 2] = level;
				if (colour === 4) out[o + 3] = eight(sample(data, start, x * channels + 1));
				else out[o + 3] = value === red ? 0 : 255;
			} else {
				const r = sample(data, start, x * channels);
				const g = sample(data, start, x * channels + 1);
				const b = sample(data, start, x * channels + 2);
				out[o] = eight(r);
				out[o + 1] = eight(g);
				out[o + 2] = eight(b);
				if (colour === 6) out[o + 3] = eight(sample(data, start, x * channels + 3));
				else out[o + 3] = r === red && g === green && b === blue ? 0 : 255;
			}
		}
	};
}

/** The pixels of a decoded library image as 8-bit samples, 3 or 4 a pixel, row after row. */
function libraryPixels(image: MemoryImage, width: number, height: number): { data: Uint8Array; channels: number } {
	if (image.width !== width || image.height !== height) unreadable("the decoded image has the wrong size");
	let pixels = image;
	if (pixels.format !== Format.uint8 || pixels.hasPalette || (pixels.numChannels !== 3 && pixels.numChannels !== 4))
		pixels = pixels.convert({ format: Format.uint8, numChannels: 4 });
	const data = pixels.toUint8Array();
	if (data.byteLength !== width * height * pixels.numChannels) unreadable("the decoded image has the wrong size");
	return { data, channels: pixels.numChannels };
}

/**
 * For each EXIF orientation (1 to 8), the stored pixel (x, y) of an upright pixel (X, Y), as [ax, bx, ay, by]:
 * x = ax·X + bx·Y and y = ay·X + by·Y, counted from the far edge where a factor is negative. Orientations 5 to 8
 * swap width and height.
 */
const ORIENTATIONS: readonly (readonly [number, number, number, number])[] = [
	[1, 0, 0, 1],
	[1, 0, 0, 1],
	[-1, 0, 0, 1],
	[-1, 0, 0, -1],
	[1, 0, 0, -1],
	[0, 1, 1, 0],
	[0, 1, -1, 0],
	[0, -1, -1, 0],
	[0, -1, 1, 0],
];

/** A stored image's rows as RGBA, turned upright by its EXIF orientation. */
function uprightRaster(
	pixels: { data: Uint8Array; channels: number },
	width: number,
	height: number,
	orientation: number,
): Raster {
	const { data, channels } = pixels;
	const [ax, bx, ay, by] = ORIENTATIONS[orientation] ?? ORIENTATIONS[1];
	const fromRight = ax < 0 || bx < 0 ? width - 1 : 0;
	const fromBottom = ay < 0 || by < 0 ? height - 1 : 0;
	const uprightWidth = ax === 0 ? height : width;
	const uprightHeight = ax === 0 ? width : height;
	const step = (ay * width + ax) * channels;
	return {
		width: uprightWidth,
		height: uprightHeight,
		rows(each) {
			const row = new Uint8Array(uprightWidth * 4);
			for (let Y = 0; Y < uprightHeight; Y++) {
				let i = ((by * Y + fromBottom) * width + bx * Y + fromRight) * channels;
				for (let o = 0; o < row.length; o += 4, i += step) {
					row[o] = data[i];
					row[o + 1] = data[i + 1];
					row[o + 2] = data[i + 2];
					row[o + 3] = channels === 4 ? data[i + 3] : 255;
				}
				each(row);
			}
		},
	};
}

/*
 * JPEG. The library decodes a canonical file rebuilt from the original: SOI; the tables (DQT, DHT, DRI); the first
 * Adobe APP14 (its colour transform); one 8-bit baseline, extended or progressive frame header, checked first; each
 * scan's header and its entropy-coded data; EOI. Other application segments and comments are dropped (the first EXIF
 * segment is read here for its orientation only), any other marker refuses the file, and a file cut short after a scan
 * keeps what it has. The library's scan reader can overrun a short scan into the segments after it and then look for
 * markers inside them, so no byte pair in a kept segment may read as a marker that allocates, decodes or parses.
 */
const JPEG_UNSAFE_PAIRS = new Set([
	0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xfe, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
	0xeb, 0xec, 0xed, 0xee, 0xef,
]);
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];
const ADOBE_HEADER = [0x41, 0x64, 0x6f, 0x62, 0x65, 0];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.byteLength >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function jpegRaster(bytes: Uint8Array): Raster {
	const jpeg = canonicalJpeg(bytes);
	const image = new JpegDecoder().decode({ bytes: jpeg.file });
	if (!image) unreadable("the JPEG could not be decoded");
	return uprightRaster(libraryPixels(image, jpeg.width, jpeg.height), jpeg.width, jpeg.height, jpeg.orientation);
}

/** The canonical JPEG the library decodes, the stored size, and the EXIF orientation. */
export function canonicalJpeg(bytes: Uint8Array): { file: Buffer; width: number; height: number; orientation: number } {
	const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
	let frame: { width: number; height: number; components: number } | undefined;
	let scans = 0;
	let segments = 0;
	let adobe = false;
	let exif = false;
	let orientation = 1;
	const keep = (segment: Uint8Array) => {
		if (++segments > MAX_JPEG_SEGMENTS) unreadable("the JPEG has too many segments");
		// The segment after its marker: its length and payload. A run of 0xFF that reaches its end runs into the next
		// segment's marker, so only a pair inside it can be read as a marker.
		if (segment[2] === 0xff) unreadable("a JPEG segment is too long");
		for (let i = 2; i < segment.byteLength; i++) {
			if (segment[i] !== 0xff) continue;
			while (i < segment.byteLength && segment[i] === 0xff) i++;
			if (i < segment.byteLength && JPEG_UNSAFE_PAIRS.has(segment[i]))
				unreadable("the JPEG has a marker inside a segment");
		}
		parts.push(segment);
	};
	const end = bytes.byteLength;
	let at = 2;
	walk: for (;;) {
		// The next marker as the decoder finds it: past other bytes and fill bytes, and never a stuffed zero.
		let marker = 0;
		do {
			while (at < end && bytes[at] !== 0xff) at++;
			while (at < end && bytes[at] === 0xff) at++;
			if (at >= end) break walk;
			marker = bytes[at++];
		} while (marker === 0);
		if (marker === 0xd9 || at + 2 > end) break;
		const length = (bytes[at] << 8) | bytes[at + 1];
		if (length < 2) unreadable("a JPEG segment is not valid");
		if (at + length > end) break;
		const segment = bytes.subarray(at - 2, at + length);
		const payload = bytes.subarray(at + 2, at + length);
		at += length;
		if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
			if (marker === 0xe1 && !exif && startsWith(payload, EXIF_HEADER)) {
				exif = true;
				orientation = exifOrientation(payload.subarray(EXIF_HEADER.length));
			} else if (marker === 0xee && !adobe && payload.byteLength >= 12 && startsWith(payload, ADOBE_HEADER)) {
				adobe = true;
				keep(segment);
			}
			continue;
		}
		if (marker === 0xdb || marker === 0xc4 || marker === 0xdd) keep(segment);
		else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
			if (frame) unreadable("the JPEG has more than one frame");
			frame = jpegFrame(payload);
			keep(segment);
		} else if (marker === 0xda) {
			if (!frame) unreadable("the JPEG has a scan before its frame");
			if (++scans > MAX_JPEG_SCANS) unreadable("the JPEG has too many scans");
			const count = payload[0];
			if (count < 1 || count > 4 || payload.byteLength !== 4 + 2 * count) unreadable("a JPEG scan is not valid");
			const approximation = payload[3 + 2 * count];
			if (
				payload[1 + 2 * count] > 63 ||
				payload[2 + 2 * count] > 63 ||
				approximation >> 4 > 13 ||
				(approximation & 15) > 13
			)
				unreadable("a JPEG scan is not valid");
			keep(segment);
			// Its entropy-coded data runs to the next marker; stuffed zeros and restart markers belong to it.
			const first = at;
			while (at < end) {
				const next = bytes[at + 1];
				if (bytes[at] !== 0xff) at++;
				else if (next === 0 || (next >= 0xd0 && next <= 0xd7)) at += 2;
				else if (next === 0xff) at++;
				else break;
			}
			parts.push(bytes.subarray(first, Math.min(at, end)));
		} else unreadable(`the JPEG uses a coding this reader does not support (marker ${marker.toString(16)})`);
	}
	if (!frame || scans === 0) unreadable("the JPEG has no image data");
	if (frame.components === 4 && !adobe) unreadable("the JPEG's four colour channels are not described");
	parts.push(Uint8Array.of(0xff, 0xd9));
	return { file: Buffer.concat(parts), width: frame.width, height: frame.height, orientation };
}

/**
 * A frame header (SOF0, SOF1, SOF2): 8-bit samples, 1, 3 or 4 distinct components each sampled 1 to 4 times, a size
 * within MAX_IMAGE_PIXELS, and within MAX_JPEG_SAMPLES the blocks the library allocates for it: whole MCUs of every
 * component.
 */
function jpegFrame(payload: Uint8Array): { width: number; height: number; components: number } {
	if (payload.byteLength < 6) unreadable("the JPEG's frame header is not valid");
	const height = (payload[1] << 8) | payload[2];
	const width = (payload[3] << 8) | payload[4];
	const components = payload[5];
	if (payload[0] !== 8) unreadable("the JPEG does not have 8-bit samples");
	if (width === 0 || height === 0) unreadable("the JPEG has no pixels");
	if ((components !== 1 && components !== 3 && components !== 4) || payload.byteLength !== 6 + 3 * components)
		unreadable("the JPEG's frame header is not valid");
	const ids = new Set<number>();
	let blocksPerMcu = 0;
	let maxHorizontal = 1;
	let maxVertical = 1;
	for (let i = 0; i < components; i++) {
		const horizontal = payload[7 + 3 * i] >> 4;
		const vertical = payload[7 + 3 * i] & 15;
		ids.add(payload[6 + 3 * i]);
		if (horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4)
			unreadable("the JPEG's frame header is not valid");
		blocksPerMcu += horizontal * vertical;
		maxHorizontal = Math.max(maxHorizontal, horizontal);
		maxVertical = Math.max(maxVertical, vertical);
	}
	if (ids.size !== components) unreadable("the JPEG's frame header is not valid");
	checkPixels(width, height);
	const mcus = Math.ceil(width / 8 / maxHorizontal) * Math.ceil(height / 8 / maxVertical);
	const samples = 64 * blocksPerMcu * mcus;
	if (samples > MAX_JPEG_SAMPLES)
		throw new FolderImageRefusal(
			"too_large",
			`the JPEG has ${width}×${height} pixels in ${Math.ceil(samples / 1_000_000)} million samples, more than the ${MAX_JPEG_SAMPLES / 1_000_000} million read here`,
		);
	return { width, height, components };
}

/** The orientation (tag 0x0112) in the first IFD of an EXIF block, 1 when it has none or it cannot be read. */
export function exifOrientation(tiff: Uint8Array): number {
	if (tiff.byteLength < 8) return 1;
	const little = tiff[0] === 0x49 && tiff[1] === 0x49;
	if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	if (view.getUint16(2, little) !== 42) return 1;
	const ifd = view.getUint32(4, little);
	if (ifd < 8 || ifd + 2 > tiff.byteLength) return 1;
	const entries = view.getUint16(ifd, little);
	for (let i = 0; i < entries; i++) {
		const entry = ifd + 2 + 12 * i;
		if (entry + 12 > tiff.byteLength) return 1;
		if (view.getUint16(entry, little) !== 0x0112) continue;
		if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) return 1;
		const value = view.getUint16(entry + 8, little);
		return value >= 1 && value <= 8 ? value : 1;
	}
	return 1;
}

/*
 * GIF. The library decodes a canonical single-frame file rebuilt from the original: its header and global colour
 * table, the graphic control extension that applies to the first frame (its transparent colour), and that frame at
 * the top left of a screen its own size. That frame is then placed at its offset on a transparent canvas the size of
 * the original's screen (grown to hold the frame, as browsers do), which counts against MAX_IMAGE_PIXELS.
 */
function gifRaster(bytes: Uint8Array): Raster {
	const gif = canonicalGif(bytes);
	const image = new GifDecoder().decode({ bytes: gif.file });
	// A palette image: one index a pixel (its numChannels is the palette's).
	if (!image || image.width !== gif.width || image.height !== gif.height || image.data?.numChannels !== 1)
		unreadable("the GIF could not be decoded");
	const palette = image.palette;
	if (!palette || palette.format !== Format.uint8) unreadable("the GIF has no colour table");
	const colours = palette.toUint8Array();
	const channels = palette.numChannels;
	const count = Math.min(palette.numColors, Math.floor(colours.byteLength / channels));
	const indices = image.toUint8Array();
	if (indices.byteLength !== gif.width * gif.height) unreadable("the GIF could not be decoded");
	return {
		width: gif.canvasWidth,
		height: gif.canvasHeight,
		rows(each) {
			const row = new Uint8Array(gif.canvasWidth * 4);
			for (let y = 0; y < gif.canvasHeight; y++) {
				row.fill(0);
				const line = y - gif.top;
				if (line >= 0 && line < gif.height) {
					for (let x = 0, i = line * gif.width, o = gif.left * 4; x < gif.width; x++, i++, o += 4) {
						const index = indices[i];
						if (index >= count) continue;
						row[o] = colours[index * channels];
						row[o + 1] = colours[index * channels + 1];
						row[o + 2] = colours[index * channels + 2];
						row[o + 3] = channels === 4 ? colours[index * channels + 3] : 255;
					}
				}
				each(row);
			}
		},
	};
}

/** The canonical GIF the library decodes, and where its frame sits on the original's canvas. */
export function canonicalGif(bytes: Uint8Array): {
	file: Buffer;
	canvasWidth: number;
	canvasHeight: number;
	left: number;
	top: number;
	width: number;
	height: number;
} {
	const end = bytes.byteLength;
	const u16 = (at: number) => bytes[at] | (bytes[at + 1] << 8);
	if (end < 13) unreadable("the GIF ends early");
	const screenFlags = bytes[10];
	const globalTable = screenFlags & 0x80 ? 3 * (2 << (screenFlags & 7)) : 0;
	let at = 13 + globalTable;
	if (at > end) unreadable("the GIF ends early");
	let control: Uint8Array | undefined;
	// Extensions before the first frame; only the last graphic control extension among them applies to it.
	while (bytes[at] !== 0x2c) {
		if (at >= end) unreadable("the GIF has no image");
		if (bytes[at] !== 0x21) unreadable("the GIF has a block this reader does not know");
		let next = at + 2;
		while (next < end && bytes[next] !== 0) next += 1 + bytes[next];
		if (next >= end) unreadable("the GIF ends early");
		next++;
		if (bytes[at + 1] === 0xf9 && bytes[at + 2] === 4 && next === at + 8) control = bytes.subarray(at, next);
		at = next;
	}
	if (at + 11 > end) unreadable("the GIF ends early");
	const left = u16(at + 1);
	const top = u16(at + 3);
	const width = u16(at + 5);
	const height = u16(at + 7);
	const flags = bytes[at + 9];
	const localTable = flags & 0x80 ? 3 * (2 << (flags & 7)) : 0;
	if (width === 0 || height === 0) unreadable("the GIF's first frame has no pixels");
	if (globalTable === 0 && localTable === 0) unreadable("the GIF has no colour table");
	const canvasWidth = Math.max(u16(6), left + width);
	const canvasHeight = Math.max(u16(8), top + height);
	checkPixels(canvasWidth, canvasHeight);
	const codeSizeAt = at + 10 + localTable;
	if (codeSizeAt >= end) unreadable("the GIF ends early");
	if (bytes[codeSizeAt] < 2 || bytes[codeSizeAt] > 8) unreadable("the GIF's image data is not valid");
	// The frame's data sub-blocks; of a file cut short, the whole ones.
	let dataEnd = codeSizeAt + 1;
	while (dataEnd < end && bytes[dataEnd] !== 0 && dataEnd + 1 + bytes[dataEnd] <= end) dataEnd += 1 + bytes[dataEnd];
	const screen = Buffer.from(bytes.subarray(0, 13 + globalTable));
	screen.writeUInt16LE(width, 6);
	screen.writeUInt16LE(height, 8);
	const descriptor = Buffer.from(bytes.subarray(at, codeSizeAt + 1));
	descriptor.writeUInt16LE(0, 1);
	descriptor.writeUInt16LE(0, 3);
	return {
		file: Buffer.concat([
			screen,
			...(control ? [control] : []),
			descriptor,
			bytes.subarray(codeSizeAt + 1, dataEnd),
			Uint8Array.of(0, 0x3b),
		]),
		canvasWidth,
		canvasHeight,
		left,
		top,
		width,
		height,
	};
}

/*
 * WebP. The library decodes a canonical still file rebuilt from the original's first image (the only one of a still
 * file, the first frame of an animation, shown alone): a lossless VP8L bitstream alone, or a lossy VP8 one with its
 * ALPH chunk when it has one. Its size is read from the bitstream itself first. The chunks are walked only up to that
 * image, at most MAX_WEBP_CHUNKS of them before it, and nothing is kept of the ones skipped.
 */
function webpRaster(bytes: Uint8Array): Raster {
	const webp = canonicalWebp(bytes);
	const image = new WebPDecoder().decode({ bytes: webp.file });
	if (!image) unreadable("the WebP could not be decoded");
	return uprightRaster(libraryPixels(image, webp.width, webp.height), webp.width, webp.height, 1);
}

interface RiffChunk {
	tag: string;
	data: Uint8Array;
}

/** The chunks a WebP may hold before its image (VP8X, ICCP, ANIM, ALPH, and ones this reader skips); more is refused. */
const MAX_WEBP_CHUNKS = 64;
const VP8X = 0x56503858;
const ANMF = 0x414e4d46;
const VP8L = 0x5650384c;
const VP8 = 0x56503820;
const ALPH = 0x414c5048;

/** The canonical WebP the library decodes, and its size. */
export function canonicalWebp(bytes: Uint8Array): { file: Buffer; width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 12) unreadable("the WebP ends early");
	const end = 8 + view.getUint32(4, true);
	if (end > bytes.byteLength || end < 12) unreadable("the WebP ends early");
	/**
	 * The image among the chunks from one offset to another: the first VP8L or VP8 chunk (or, when `frames`, ANMF), and
	 * the ALPH chunk before it. The chunks after it are not read, and of the ones before it only their tags and sizes.
	 */
	const image = (from: number, to: number, frames: boolean): { tag: number; data: Uint8Array; alpha?: Uint8Array } => {
		let alpha: Uint8Array | undefined;
		for (let at = from, skipped = 0; at + 8 <= to; ) {
			const tag = view.getUint32(at);
			const size = view.getUint32(at + 4, true);
			if (at + 8 + size > to) unreadable("the WebP ends early");
			if (tag === VP8L || tag === VP8 || (frames && tag === ANMF))
				return { tag, data: bytes.subarray(at + 8, at + 8 + size), alpha };
			if (++skipped > MAX_WEBP_CHUNKS) unreadable("the WebP has too many chunks before its image");
			if (tag === ALPH) alpha ??= bytes.subarray(at + 8, at + 8 + size);
			at += 8 + size + (size & 1);
		}
		unreadable("the WebP has no image");
	};
	let found = image(12, end, end >= 20 && view.getUint32(12) === VP8X);
	if (found.tag === ANMF) {
		if (found.data.byteLength < 16) unreadable("the WebP's first frame is not valid");
		const start = found.data.byteOffset - bytes.byteOffset;
		found = image(start + 16, start + found.data.byteLength, false);
	}
	const data = found.data;
	if (found.tag === VP8L) {
		if (data.byteLength < 5 || data[0] !== 0x2f) unreadable("the WebP's image data is not valid");
		const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
		if (bits >>> 29 !== 0) unreadable("the WebP's image data is not valid");
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >>> 14) & 0x3fff) + 1;
		checkPixels(width, height);
		return { file: riff([{ tag: "VP8L", data }]), width, height };
	}
	if (data.byteLength < 10 || data[0] & 1 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a)
		unreadable("the WebP's image data is not valid");
	const width = data[6] | (data[7] << 8);
	const height = data[8] | (data[9] << 8);
	if (width >> 14 || height >> 14) unreadable("the WebP's image is scaled, which this reader does not support");
	if (width === 0 || height === 0) unreadable("the WebP has no pixels");
	checkPixels(width, height);
	const lossy = { tag: "VP8 ", data };
	if (!found.alpha) return { file: riff([lossy]), width, height };
	const extended = Buffer.alloc(10);
	extended[0] = 0x10;
	extended.writeUIntLE(width - 1, 4, 3);
	extended.writeUIntLE(height - 1, 7, 3);
	return { file: riff([{ tag: "VP8X", data: extended }, { tag: "ALPH", data: found.alpha }, lossy]), width, height };
}

function riff(chunks: RiffChunk[]): Buffer {
	const parts: Uint8Array[] = [];
	for (const { tag, data } of chunks) {
		const header = Buffer.alloc(8);
		header.write(tag, 0, "latin1");
		header.writeUInt32LE(data.byteLength, 4);
		parts.push(header, data);
		if (data.byteLength & 1) parts.push(Uint8Array.of(0));
	}
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(4 + parts.reduce((sum, part) => sum + part.byteLength, 0), 4);
	head.write("WEBP", 8, "latin1");
	return Buffer.concat([head, ...parts]);
}
