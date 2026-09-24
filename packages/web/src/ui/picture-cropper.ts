import { button, h, icon } from "./dom.ts";
import { type LoadedPicture, loadPicture, type PictureCrop } from "./picture-file.ts";
import { t, uiText } from "./preferences.ts";

/* Fitting a photo to the round picture before it is saved. The circle shows
 * what others will see; the photo is dragged behind it and zoomed with the
 * slider, the wheel, a pinch or + and −. The photo always covers the circle. */

/** The view is laid out in these units and scaled to the space it gets. */
export const CROP_STAGE = 288;
export const CROP_CIRCLE = 240;
const MARGIN = (CROP_STAGE - CROP_CIRCLE) / 2;
export const MAX_CROP_ZOOM = 4;

/** Where the photo sits behind the circle: `x`, `y` place its top-left corner
 * relative to the circle's, in view units. */
export class CropFrame {
	readonly width: number;
	readonly height: number;
	#zoom = 1;
	#x = 0;
	#y = 0;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.#x = (CROP_CIRCLE - width * this.scale) / 2;
		this.#y = (CROP_CIRCLE - height * this.scale) / 2;
	}

	get zoom(): number {
		return this.#zoom;
	}

	get x(): number {
		return this.#x;
	}

	get y(): number {
		return this.#y;
	}

	/** View units per photo pixel: at zoom 1 the photo's short side spans the circle. */
	get scale(): number {
		return (CROP_CIRCLE / Math.min(this.width, this.height)) * this.#zoom;
	}

	pan(dx: number, dy: number): void {
		this.#x += dx;
		this.#y += dy;
		this.#clamp();
	}

	/** Zooms keeping the photo point under (`fx`, `fy`), relative to the circle, where it is. */
	zoomTo(zoom: number, fx = CROP_CIRCLE / 2, fy = CROP_CIRCLE / 2): void {
		const pointX = (fx - this.#x) / this.scale;
		const pointY = (fy - this.#y) / this.scale;
		this.#zoom = Math.min(MAX_CROP_ZOOM, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
		this.#x = fx - pointX * this.scale;
		this.#y = fy - pointY * this.scale;
		this.#clamp();
	}

	crop(): PictureCrop {
		const side = Math.min(CROP_CIRCLE / this.scale, this.width, this.height);
		const x = Math.min(Math.max(0, -this.#x / this.scale), this.width - side);
		const y = Math.min(Math.max(0, -this.#y / this.scale), this.height - side);
		return { x, y, side };
	}

	#clamp(): void {
		this.#x = Math.min(0, Math.max(CROP_CIRCLE - this.width * this.scale, this.#x));
		this.#y = Math.min(0, Math.max(CROP_CIRCLE - this.height * this.scale, this.#y));
	}
}

/** Asks the member to fit `picture` to the circle; resolves with the square
 * they chose, or undefined when they cancel. */
export function cropPicture(
	picture: Pick<LoadedPicture, "url" | "width" | "height">,
): Promise<PictureCrop | undefined> {
	return new Promise((resolve) => {
		const frame = new CropFrame(picture.width, picture.height);
		const previous = document.activeElement;
		const titleId = `picture-crop-title-${Math.random().toString(36).slice(2)}`;
		const helpId = `${titleId}-help`;
		const image = h("img", {
			class: "picture-crop-image",
			src: picture.url,
			alt: "",
			draggable: "false",
		});
		image.style.width = `${picture.width}px`;
		image.style.height = `${picture.height}px`;
		const view = h(
			"div",
			{ class: "picture-crop-view" },
			image,
			h("div", { class: "picture-crop-circle", "aria-hidden": "true" }),
		);
		const stage = h(
			"div",
			{
				class: "picture-crop-stage",
				tabindex: "0",
				role: "group",
				"aria-label": t("Picture position"),
				"aria-describedby": helpId,
			},
			view,
		);
		const zoom = h("input", {
			type: "range",
			class: "picture-crop-zoom",
			min: "1",
			max: String(MAX_CROP_ZOOM),
			step: "0.01",
			value: "1",
			"aria-label": t("Zoom"),
		});
		const save = button(uiText("Save"), () => close(frame.crop()), { primary: true });
		const cancel = button(uiText("Cancel"), () => close(undefined));
		const dialog = h(
			"div",
			{
				class: "picture-crop",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": titleId,
			},
			h("h2", { id: titleId }, uiText("Fit your picture")),
			stage,
			h(
				"div",
				{ class: "picture-crop-zoom-row" },
				h("span", { class: "picture-crop-zoom-small", "aria-hidden": "true" }, icon("image")),
				zoom,
				h("span", { class: "picture-crop-zoom-large", "aria-hidden": "true" }, icon("image")),
			),
			h("p", { class: "picture-crop-help", id: helpId }, uiText("Drag the picture to move it; zoom to fit.")),
			h("div", { class: "modal-actions" }, cancel, save),
		);
		const backdrop = h("div", { class: "modal-backdrop picture-crop-backdrop" }, dialog);
		let closed = false;

		/** View units per CSS pixel of the stage as it is drawn. */
		let unit = 1;
		const fit = () => {
			const width = stage.getBoundingClientRect().width;
			unit = width > 0 ? CROP_STAGE / width : 1;
			view.style.transform = width > 0 ? `scale(${width / CROP_STAGE})` : "";
		};
		const draw = () => {
			image.style.transform = `translate(${MARGIN + frame.x}px, ${MARGIN + frame.y}px) scale(${frame.scale})`;
			zoom.value = String(frame.zoom);
		};
		/** A point of the page as circle coordinates in view units. */
		const circlePoint = (clientX: number, clientY: number) => {
			const rect = stage.getBoundingClientRect();
			return { x: (clientX - rect.left) * unit - MARGIN, y: (clientY - rect.top) * unit - MARGIN };
		};

		const pointers = new Map<number, { x: number; y: number }>();
		let pinch: { distance: number; zoom: number } | undefined;
		const spread = () => {
			const [a, b] = [...pointers.values()];
			return a && b
				? { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
				: undefined;
		};
		stage.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			stage.focus();
			try {
				stage.setPointerCapture(event.pointerId);
			} catch {
				// Without capture a drag still works while the pointer stays over the picture.
			}
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			const both = spread();
			pinch = both ? { distance: both.distance, zoom: frame.zoom } : undefined;
			stage.classList.add("is-dragging");
		});
		stage.addEventListener("pointermove", (event) => {
			const last = pointers.get(event.pointerId);
			if (!last) return;
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			const both = spread();
			if (pinch && both && pinch.distance > 0) {
				const focus = circlePoint(both.mid.x, both.mid.y);
				frame.zoomTo((pinch.zoom * both.distance) / pinch.distance, focus.x, focus.y);
			} else if (!pinch) frame.pan((event.clientX - last.x) * unit, (event.clientY - last.y) * unit);
			draw();
		});
		const release = (event: PointerEvent) => {
			pointers.delete(event.pointerId);
			const both = spread();
			pinch = both ? { distance: both.distance, zoom: frame.zoom } : undefined;
			if (!pointers.size) stage.classList.remove("is-dragging");
		};
		stage.addEventListener("pointerup", release);
		stage.addEventListener("pointercancel", release);
		stage.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				const focus = circlePoint(event.clientX, event.clientY);
				frame.zoomTo(frame.zoom * Math.exp(-event.deltaY * 0.002), focus.x, focus.y);
				draw();
			},
			{ passive: false },
		);
		stage.addEventListener("keydown", (event) => {
			const step = event.shiftKey ? 32 : 8;
			// An arrow moves the picture the way it points, as a drag would.
			const moves: Record<string, [number, number]> = {
				ArrowLeft: [-step, 0],
				ArrowRight: [step, 0],
				ArrowUp: [0, -step],
				ArrowDown: [0, step],
			};
			const move = moves[event.key];
			if (move) frame.pan(move[0], move[1]);
			else if (event.key === "+" || event.key === "=") frame.zoomTo(frame.zoom + 0.1);
			else if (event.key === "-" || event.key === "_") frame.zoomTo(frame.zoom - 0.1);
			else if (event.key === "Enter") {
				event.preventDefault();
				close(frame.crop());
				return;
			} else return;
			event.preventDefault();
			draw();
		});
		zoom.addEventListener("input", () => {
			frame.zoomTo(Number(zoom.value));
			draw();
		});

		// The dialog keeps its keys: Settings behind it neither closes on Escape nor takes Tab.
		dialog.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close(undefined);
			} else if (event.key === "Tab") {
				event.stopPropagation();
				const controls: HTMLElement[] = [stage, zoom, cancel, save];
				const index = controls.indexOf(document.activeElement as HTMLElement);
				const next = event.shiftKey
					? index <= 0
						? controls.length - 1
						: index - 1
					: index < 0 || index === controls.length - 1
						? 0
						: index + 1;
				event.preventDefault();
				controls[next]!.focus();
			}
		});
		backdrop.addEventListener("pointerdown", (event) => {
			if (event.target === backdrop) close(undefined);
		});
		const onRoute = () => close(undefined);
		window.addEventListener("hashchange", onRoute);
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;

		function close(result: PictureCrop | undefined): void {
			if (closed) return;
			closed = true;
			observer?.disconnect();
			window.removeEventListener("hashchange", onRoute);
			backdrop.remove();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			resolve(result);
		}

		document.body.append(backdrop);
		observer?.observe(stage);
		fit();
		draw();
		stage.focus();
	});
}

/** Loads the photo the member picked and lets them fit it. Throws a
 * PictureFileError when the browser cannot read it. */
export async function choosePictureCrop(file: File): Promise<PictureCrop | undefined> {
	const picture = await loadPicture(file);
	try {
		return await cropPicture(picture);
	} finally {
		picture.release();
	}
}
