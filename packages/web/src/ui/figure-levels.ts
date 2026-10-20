/* Figure surfaces at the size they are painted. A 512px surface drawn
 * several times smaller in one step skips pixels wherever the browser
 * resamples bilinearly (GPU canvases do, whatever imageSmoothingQuality
 * asks), so a crisp silhouette and the eyes turn jagged. Each surface is
 * halved down to the power of two at or above the painted side, every 2:1
 * step averaging exactly. */
const levels = new Map<string, HTMLCanvasElement>();
const scratch = new Map<number, HTMLCanvasElement>();

/** The power of two at or above `side`, from 32 to 512. */
export function bucketOf(side: number): number {
	return Math.min(512, 2 ** Math.ceil(Math.log2(Math.max(32, side))));
}

/** Halve a 512px `image` down to `bucket`, each step onto `canvasFor(size)`;
 * `reused` canvases are cleared first. */
function halve(
	image: CanvasImageSource,
	bucket: number,
	canvasFor: (size: number) => HTMLCanvasElement,
	reused = false,
): CanvasImageSource {
	let current = image,
		size = 512;
	while (size > bucket) {
		size /= 2;
		const next = canvasFor(size);
		const nc = next.getContext("2d")!;
		if (reused) nc.clearRect(0, 0, size, size);
		nc.imageSmoothingQuality = "high";
		nc.drawImage(current, 0, 0, size, size);
		current = next;
	}
	return current;
}

function canvas(size: number): HTMLCanvasElement {
	const created = document.createElement("canvas");
	created.width = created.height = size;
	return created;
}

/** `image` (a fixed 512px surface, named by `key`) halved down to `bucket`, cached. */
export function level(key: string, image: CanvasImageSource, bucket: number): CanvasImageSource {
	if (bucket >= 512) return image;
	const levelKey = `${key}:${bucket}`;
	let scaled = levels.get(levelKey);
	if (!scaled) {
		scaled = halve(image, bucket, canvas) as HTMLCanvasElement;
		levels.set(levelKey, scaled);
	}
	return scaled;
}

/** A 512px surface drawn fresh each frame (the eyes) halved down to
 * `bucket` through reused canvases. Valid until the next call. */
export function reduce(image: CanvasImageSource, bucket: number): CanvasImageSource {
	return halve(
		image,
		bucket,
		(size) => {
			let reused = scratch.get(size);
			if (!reused) {
				reused = canvas(size);
				scratch.set(size, reused);
			}
			return reused;
		},
		true,
	);
}
