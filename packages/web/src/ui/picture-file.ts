import type { MemberPictureExtension } from "../cloud/member-pictures.ts";
import { phrase } from "./preferences.ts";

/* Turns a photo the member picked into their account picture: the square they
 * fitted to the circle (the centre square when they did not), 256 px on a side,
 * as WebP (JPEG where the browser cannot write WebP). The original never leaves
 * the device; only this small square is uploaded. */

export const PICTURE_SIZE = 256;
/** A larger file is refused before decoding: nobody needs 40 MB for a face. */
export const MAX_PICTURE_SOURCE_BYTES = 25 * 1024 * 1024;
/** The bucket's own limit; the square is far below it. */
export const MAX_PICTURE_BYTES = 512 * 1024;

export interface PreparedPicture {
	blob: Blob;
	extension: MemberPictureExtension;
}

/** A square of the photo, in the photo's own pixels. */
export interface PictureCrop {
	x: number;
	y: number;
	side: number;
}

/** A decoded photo; `release()` frees its object URL. */
export interface LoadedPicture {
	readonly url: string;
	readonly image: HTMLImageElement;
	readonly width: number;
	readonly height: number;
	release(): void;
}

/** A reason the member can act on, shown as is (its English source; the view translates it). */
export class PictureFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PictureFileError";
	}
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

export function centreCrop(width: number, height: number): PictureCrop {
	const side = Math.min(width, height);
	return { x: (width - side) / 2, y: (height - side) / 2, side };
}

export async function loadPicture(file: File): Promise<LoadedPicture> {
	if (file.type && !file.type.startsWith("image/"))
		throw new PictureFileError(phrase("Choose a picture file, such as a JPEG, PNG or WebP."));
	if (file.size > MAX_PICTURE_SOURCE_BYTES) throw new PictureFileError(phrase("Choose a picture smaller than 25 MB."));
	const url = URL.createObjectURL(file);
	const image = new Image();
	image.src = url;
	try {
		await image.decode();
	} catch {
		URL.revokeObjectURL(url);
		throw new PictureFileError(phrase("This browser could not read that picture. Try a JPEG or PNG."));
	}
	const width = image.naturalWidth;
	const height = image.naturalHeight;
	if (!width || !height) {
		URL.revokeObjectURL(url);
		throw new PictureFileError(phrase("This browser could not read that picture. Try a JPEG or PNG."));
	}
	return { url, image, width, height, release: () => URL.revokeObjectURL(url) };
}

export async function renderPicture(picture: LoadedPicture, crop?: PictureCrop): Promise<PreparedPicture> {
	const { x, y, side } = crop ?? centreCrop(picture.width, picture.height);
	const canvas = document.createElement("canvas");
	canvas.width = PICTURE_SIZE;
	canvas.height = PICTURE_SIZE;
	const context = canvas.getContext("2d");
	if (!context) throw new PictureFileError(phrase("This browser cannot prepare pictures."));
	// Transparent parts would turn black in a JPEG.
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, PICTURE_SIZE, PICTURE_SIZE);
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	context.drawImage(picture.image, x, y, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
	let blob = await encode(canvas, "image/webp");
	// Browsers that cannot write WebP hand back a PNG instead.
	if (blob?.type !== "image/webp") blob = await encode(canvas, "image/jpeg");
	if (!blob || (blob.type !== "image/webp" && blob.type !== "image/jpeg"))
		throw new PictureFileError(phrase("This browser cannot prepare pictures."));
	if (blob.size > MAX_PICTURE_BYTES) throw new PictureFileError(phrase("That picture is too detailed to upload."));
	return { blob, extension: blob.type === "image/webp" ? "webp" : "jpg" };
}

export async function preparePicture(file: File, crop?: PictureCrop): Promise<PreparedPicture> {
	const picture = await loadPicture(file);
	try {
		return await renderPicture(picture, crop);
	} finally {
		picture.release();
	}
}

export async function pictureSha256(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
