/**
 * Electron returns BGRA pixels. A single-color frame means the renderer never
 * painted even when its DOM exists; a small luminance spread avoids treating
 * antialiasing noise as a successful shell render.
 */
export function bitmapLooksBlank(bitmap: Uint8Array): boolean {
	const pixelCount = Math.floor(bitmap.length / 4);
	if (pixelCount === 0) return true;
	const stride = Math.max(1, Math.floor(pixelCount / 4096));
	let darkest = 255;
	let lightest = 0;
	for (let pixel = 0; pixel < pixelCount; pixel += stride) {
		const offset = pixel * 4;
		const luminance = Math.round((bitmap[offset] * 29 + bitmap[offset + 1] * 150 + bitmap[offset + 2] * 77) / 256);
		darkest = Math.min(darkest, luminance);
		lightest = Math.max(lightest, luminance);
		if (lightest - darkest >= 16) return false;
	}
	return true;
}
