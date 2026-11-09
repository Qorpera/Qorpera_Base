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
		// At exactly 2:1, plain bilinear sampling lands between four source pixels: the 2x2
		// average itself. "high" adds nothing there (WebKit's is further from that average) and
		// costs 1.5x (WebKit) to 4x (Chromium) per step, which the eyes pay every frame.
		nc.imageSmoothingQuality = "low";
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

/** A box on the 512px surface, [left, top, right, bottom] in its pixels. */
export type Region = [number, number, number, number];

/** `region` grown by a pixel and out to multiples of 512/`grid` (whole pixels at that level),
 * within the surface. */
export function alignRegion(region: Region, grid: number): Region {
	const step = 512 / grid;
	const down = (value: number) => Math.min(512, Math.max(0, Math.floor((value - 1) / step) * step));
	const up = (value: number) => Math.min(512, Math.max(0, Math.ceil((value + 1) / step) * step));
	return [down(region[0]), down(region[1]), up(region[2]), up(region[3])];
}

/** A cleared canvas for a box of `width` x `height` at the level of side `size`, from `boxes` (one per
 * level, kept by its owner), cleared whole (nothing from an earlier box can reach a resampler). A
 * layer cleared, drawn and halved each frame costs about its canvas's size, not what is drawn on it
 * (measured 9 Nov 2026: 3.1 ms in WebKit and 0.32 in Chromium for 512px, 0.08 and 0.03 for 128x80).
 * Each figure keeps its own boxes: WebKit can run a draw from part of a canvas after later calls
 * have changed that canvas, so boxes shared between figures gave one figure the next one's eyes
 * (or none). A figure reuses its boxes only on its next frame, after the browser has drawn. A box
 * that does not fit gets a new, larger canvas rather than a resized one, for the same reason. */
export function boxCanvas(
	boxes: Map<number, HTMLCanvasElement>,
	size: number,
	width: number,
	height: number,
): HTMLCanvasElement {
	const box = boxes.get(size);
	if (!box || box.width < width || box.height < height) {
		const round = (value: number) => Math.min(size, Math.ceil(value / 32) * 32);
		const grown = document.createElement("canvas");
		grown.width = round(Math.max(box?.width ?? 0, width));
		grown.height = round(Math.max(box?.height ?? 0, height));
		boxes.set(size, grown);
		return grown;
	}
	// A reused canvas keeps the last box's transform, which would move the clear.
	const context = box.getContext("2d")!;
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.clearRect(0, 0, box.width, box.height);
	return box;
}
