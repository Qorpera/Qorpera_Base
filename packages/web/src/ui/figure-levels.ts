/* Figure surfaces at the size they are painted. A 512px surface drawn
 * several times smaller in one step skips pixels wherever the browser
 * resamples bilinearly (GPU canvases do, whatever imageSmoothingQuality
 * asks), so a crisp silhouette and the eyes turn jagged. Each surface is
 * halved down to the power of two at or above the painted side, every 2:1
 * step averaging exactly, and cached per size. */
const levels = new Map<string, HTMLCanvasElement>();

/** The power of two at or above `side`, from 32 to 512. */
export function bucketOf(side: number): number {
	return Math.min(512, 2 ** Math.ceil(Math.log2(Math.max(32, side))));
}

/** `image` (a 512px surface, named by `key`) halved down to `bucket`. */
export function level(key: string, image: CanvasImageSource, bucket: number): CanvasImageSource {
	if (bucket >= 512) return image;
	const levelKey = `${key}:${bucket}`;
	let scaled = levels.get(levelKey);
	if (scaled) return scaled;
	let current = image,
		size = 512;
	while (size > bucket) {
		size /= 2;
		const next = document.createElement("canvas");
		next.width = next.height = size;
		const nc = next.getContext("2d")!;
		nc.imageSmoothingQuality = "high";
		nc.drawImage(current, 0, 0, size, size);
		current = next;
	}
	scaled = current as HTMLCanvasElement;
	levels.set(levelKey, scaled);
	return scaled;
}
