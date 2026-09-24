import type { MemberPictureExtension } from "../cloud/member-pictures.ts";

/* Turns a photo the member picked into their account picture: the centre
 * square, 256 px on a side, as WebP (JPEG where the browser cannot write WebP).
 * The original never leaves the device; only this small square is uploaded. */

export const PICTURE_SIZE = 256;
/** A larger file is refused before decoding: nobody needs 40 MB for a face. */
export const MAX_PICTURE_SOURCE_BYTES = 25 * 1024 * 1024;
/** The bucket's own limit; the square is far below it. */
export const MAX_PICTURE_BYTES = 512 * 1024;

export interface PreparedPicture {
	blob: Blob;
	extension: MemberPictureExtension;
}

/** A reason the member can act on, shown as is. */
export class PictureFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PictureFileError";
	}
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

export async function preparePicture(file: File): Promise<PreparedPicture> {
	if (file.type && !file.type.startsWith("image/"))
		throw new PictureFileError("Choose a picture file, such as a JPEG, PNG or WebP.");
	if (file.size > MAX_PICTURE_SOURCE_BYTES) throw new PictureFileError("Choose a picture smaller than 25 MB.");
	const source = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = source;
		try {
			await image.decode();
		} catch {
			throw new PictureFileError("This browser could not read that picture. Try a JPEG or PNG.");
		}
		const width = image.naturalWidth;
		const height = image.naturalHeight;
		if (!width || !height) throw new PictureFileError("This browser could not read that picture. Try a JPEG or PNG.");
		const side = Math.min(width, height);
		const canvas = document.createElement("canvas");
		canvas.width = PICTURE_SIZE;
		canvas.height = PICTURE_SIZE;
		const context = canvas.getContext("2d");
		if (!context) throw new PictureFileError("This browser cannot prepare pictures.");
		// Transparent parts would turn black in a JPEG.
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, PICTURE_SIZE, PICTURE_SIZE);
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
		let blob = await encode(canvas, "image/webp");
		// Browsers that cannot write WebP hand back a PNG instead.
		if (blob?.type !== "image/webp") blob = await encode(canvas, "image/jpeg");
		if (!blob || (blob.type !== "image/webp" && blob.type !== "image/jpeg"))
			throw new PictureFileError("This browser cannot prepare pictures.");
		if (blob.size > MAX_PICTURE_BYTES) throw new PictureFileError("That picture is too detailed to upload.");
		return { blob, extension: blob.type === "image/webp" ? "webp" : "jpg" };
	} finally {
		URL.revokeObjectURL(source);
	}
}

export async function pictureSha256(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
