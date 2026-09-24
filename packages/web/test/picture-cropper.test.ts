// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CROP_CIRCLE, CropFrame, cropPicture, MAX_CROP_ZOOM } from "../src/ui/picture-cropper.ts";

const landscape = { url: "blob:photo", width: 1600, height: 1000 };

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function open(picture = landscape) {
	const before = document.createElement("button");
	document.body.append(before);
	before.focus();
	const result = cropPicture(picture);
	const dialog = document.querySelector<HTMLElement>(".picture-crop")!;
	const stage = dialog.querySelector<HTMLElement>(".picture-crop-stage")!;
	const zoom = dialog.querySelector<HTMLInputElement>(".picture-crop-zoom")!;
	const buttons = [...dialog.querySelectorAll<HTMLButtonElement>(".modal-actions button")];
	const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
		target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
	return { before, result, dialog, stage, zoom, cancel: buttons[0]!, save: buttons[1]!, key };
}

describe("the crop frame", () => {
	it("starts on the centre square, with the photo's short side across the circle", () => {
		const frame = new CropFrame(1600, 1000);
		expect(frame.crop()).toEqual({ x: 300, y: 0, side: 1000 });
		expect(frame.scale).toBeCloseTo(CROP_CIRCLE / 1000);
	});

	it("never lets the photo leave the circle uncovered", () => {
		const frame = new CropFrame(1600, 1000);
		frame.pan(10_000, 10_000);
		expect(frame.crop()).toEqual({ x: 0, y: 0, side: 1000 });
		frame.pan(-10_000, -10_000);
		expect(frame.crop()).toEqual({ x: 600, y: 0, side: 1000 });
		frame.zoomTo(0.2);
		expect(frame.zoom).toBe(1);
		frame.zoomTo(40);
		expect(frame.zoom).toBe(MAX_CROP_ZOOM);
	});

	it("zooms around the point it is given", () => {
		const frame = new CropFrame(1600, 1000);
		frame.zoomTo(2);
		expect(frame.crop()).toEqual({ x: 550, y: 250, side: 500 });
		// Around the circle's top-left corner, that photo point stays put.
		const corner = new CropFrame(1000, 1000);
		corner.zoomTo(2, 0, 0);
		expect(corner.crop()).toEqual({ x: 0, y: 0, side: 500 });
	});
});

describe("fitting a picture", () => {
	it("moves with the arrows, zooms with the slider and keys, and saves the square", async () => {
		const { result, stage, zoom, save, key } = open();
		expect(document.activeElement).toBe(stage);
		zoom.value = "2";
		zoom.dispatchEvent(new Event("input"));
		// An arrow moves the picture the way it points: left shows more of its right side.
		key(stage, "ArrowLeft");
		key(stage, "ArrowUp", { shiftKey: true });
		key(stage, "+");
		key(stage, "-");
		save.click();
		const crop = (await result)!;
		const scale = (CROP_CIRCLE / 1000) * 2;
		expect(crop.side).toBeCloseTo(500);
		expect(crop.x).toBeCloseTo(550 + 8 / scale);
		expect(crop.y).toBeCloseTo(250 + 32 / scale);
		expect(document.querySelector(".picture-crop")).toBeNull();
	});

	it("follows a drag and the wheel", async () => {
		const { result, stage, key } = open();
		const pointer = (type: string, x: number, y: number) =>
			stage.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
		stage.dispatchEvent(
			new WheelEvent("wheel", { deltaY: -500, clientX: 0, clientY: 0, bubbles: true, cancelable: true }),
		);
		pointer("pointerdown", 100, 100);
		pointer("pointermove", 60, 80);
		pointer("pointerup", 60, 80);
		key(stage, "Enter");
		const crop = (await result)!;
		expect(crop.side).toBeLessThan(1000);
		// Dragged left and up: the square moved right and down within the photo.
		expect(crop.x).toBeGreaterThan(0);
		expect(crop.y).toBeGreaterThan(0);
	});

	it("closes on Escape without closing what lies behind, and gives focus back", async () => {
		const { before, result, stage, key } = open();
		const behind = vi.fn();
		document.addEventListener("keydown", behind);
		key(stage, "Escape");
		document.removeEventListener("keydown", behind);
		expect(await result).toBeUndefined();
		expect(behind).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(before);
	});

	it("keeps Tab inside, and cancels from the button or a click outside", async () => {
		const first = open();
		first.save.focus();
		first.key(first.save, "Tab");
		expect(document.activeElement).toBe(first.stage);
		first.key(first.stage, "Tab", { shiftKey: true });
		expect(document.activeElement).toBe(first.save);
		first.cancel.click();
		expect(await first.result).toBeUndefined();

		const second = open();
		const backdrop = document.querySelector(".picture-crop-backdrop")!;
		backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(await second.result).toBeUndefined();
	});
});
