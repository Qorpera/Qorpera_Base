/* Where the company's page (views/company-now.ts) puts the things of its reading, by rule and never from the file: the
 * thing the company attends to is the biggest and stands in the middle; the others stand around it in slots that are
 * smaller the fewer agents attend to them. Each agent of a thing, and each member it waits for, stands at the thing's
 * lower corners: right, then left, then outward.
 *
 * The slots are drawn on one canvas of 1052 x 620 units: the approved sketch's pane at its Big scale (one unit is one
 * screen pixel there), below the title. Every slot keeps its whole footprint (the shape, its two lines of label and
 * the figures at its corners) clear of every other one and inside the canvas, so the picture never overlaps itself at
 * any size: the canvas is scaled down whole to fit the pane, and never up. Under 720 screen pixels of pane the things
 * stack in one column, the attended one first. Every length out of here is in design pixels (`designPx`). */

/** The canvas, in units. */
export const CANVAS = { width: 1052, height: 620 } as const;
/** Design pixels per unit at most: the sketch was drawn at the Big scale, 1.3 screen pixels to a design pixel. */
const UNIT = 1 / 1.3;
/** A pane narrower than this many screen pixels stacks the things. */
export const COLUMN_BELOW = 720;
/** Below a shape: the gap, the name (up to two lines) and the state (one), in units. */
export const LABEL = 76;
/** How far the figures reach past a shape's side, in units: the first one's middle 4 past the edge, a second 40
 * further out, and half a figure. */
export const REACH = 75;
/** An agent's figure, and a member's face, in units. */
export const FIGURE = 62;
export const FACE = 46;
const SPACING = 40;

/** A slot: its middle and its size, in units. */
export type Slot = readonly [x: number, y: number, size: number];

/** One table per count of things: the attended thing's slot first, then the others from the biggest down. Six is the
 * sketch's "now". */
export const SLOTS: Readonly<Record<number, readonly Slot[]>> = {
	3: [
		[526, 300, 230],
		[180, 330, 150],
		[872, 330, 150],
	],
	4: [
		[526, 300, 220],
		[186, 230, 150],
		[866, 230, 140],
		[526, 68, 90],
	],
	5: [
		[526, 290, 220],
		[186, 202, 150],
		[866, 202, 132],
		[206, 472, 112],
		[846, 472, 112],
	],
	6: [
		[526, 308, 220],
		[186, 202, 150],
		[866, 202, 132],
		[206, 472, 112],
		[846, 472, 112],
		[526, 70, 84],
	],
	7: [
		[526, 320, 200],
		[150, 250, 130],
		[902, 250, 130],
		[220, 480, 104],
		[832, 480, 104],
		[400, 66, 76],
		[652, 66, 76],
	],
};

export interface ReadingSpot {
	readonly key: string;
	/** The thing's middle and its shape's size, in design pixels on the canvas. */
	readonly x: number;
	readonly y: number;
	readonly size: number;
	/** The footprint the slot keeps for it: shape, label and the figures at its corners. */
	readonly box: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

export interface ReadingLayout {
	readonly column: boolean;
	/** Design pixels per unit. */
	readonly unit: number;
	/** The canvas, in design pixels. */
	readonly width: number;
	readonly height: number;
	readonly spots: readonly ReadingSpot[];
}

export interface LayoutThing {
	readonly key: string;
	/** How many agents attend to it (only the ones the page draws). */
	readonly agents: number;
}

/** The things in slot order: the attended one, then the rest by how many agents attend to them, then the file's order. */
export function slotOrder<T extends LayoutThing>(things: readonly T[], attention: string): T[] {
	const first = things.find((thing) => thing.key === attention) ?? things[0];
	const rest = things
		.map((thing, index) => ({ thing, index }))
		.filter(({ thing }) => thing !== first)
		.sort((a, b) => b.thing.agents - a.thing.agents || a.index - b.index)
		.map(({ thing }) => thing);
	return first ? [first, ...rest] : rest;
}

function footprint(x: number, y: number, size: number) {
	return { left: x - size / 2 - REACH, top: y - size / 2, right: x + size / 2 + REACH, bottom: y + size / 2 + LABEL };
}

/** Lays the things out in a pane of `pane` design pixels; `screen` is the pane's width in screen pixels, which decides
 * the column. */
export function layoutReading(
	things: readonly LayoutThing[],
	attention: string,
	pane: { readonly width: number; readonly height: number },
	screenWidth: number,
): ReadingLayout {
	const ordered = slotOrder(things.slice(0, 7), attention);
	if (screenWidth < COLUMN_BELOW || ordered.length < 3) {
		// One column, the attended thing first and biggest; the page scrolls.
		const unit = Math.max(0.2, Math.min(UNIT, pane.width / (230 + 2 * REACH + 24)));
		let top = 16;
		const spots = ordered.map((thing, index) => {
			const size = index === 0 ? 150 : 110;
			const x = pane.width / unit / 2;
			const y = top + size / 2;
			top += size + LABEL + 28;
			return spot(thing.key, x, y, size, unit);
		});
		return { column: true, unit, width: pane.width, height: top * unit, spots };
	}
	const slots = SLOTS[ordered.length]!;
	const unit = Math.max(
		0.2,
		Math.min(UNIT, pane.width / CANVAS.width, pane.height > 0 ? pane.height / CANVAS.height : UNIT),
	);
	return {
		column: false,
		unit,
		width: CANVAS.width * unit,
		height: CANVAS.height * unit,
		spots: ordered.map((thing, index) => {
			const [x, y, size] = slots[index]!;
			return spot(thing.key, x, y, size, unit);
		}),
	};
}

function spot(key: string, x: number, y: number, size: number, unit: number): ReadingSpot {
	const box = footprint(x, y, size);
	return {
		key,
		x: x * unit,
		y: y * unit,
		size: size * unit,
		box: {
			left: box.left * unit,
			top: box.top * unit,
			right: box.right * unit,
			bottom: box.bottom * unit,
		},
	};
}

export interface FigureSpot {
	/** The figure's box, in design pixels on the canvas. */
	readonly left: number;
	readonly top: number;
	readonly size: number;
}

/** Where the `count` figures at a thing stand, in their order: agents first, then the members it waits for (`faces`
 * of them at the end, drawn smaller). Each side holds two at full size; more shrink and close up, so a side never
 * reaches past the slot's footprint. */
export function figureSpots(at: ReadingSpot, unit: number, count: number, faces: number): FigureSpot[] {
	const sides = [Math.ceil(count / 2), Math.floor(count / 2)];
	return Array.from({ length: count }, (_, index) => {
		const side = index % 2;
		const rank = Math.floor(index / 2);
		const many = sides[side]!;
		const fit = Math.min(1, 2 / many);
		const base = index >= count - faces ? FACE : FIGURE;
		const size = base * fit * unit;
		const spacing = (many > 1 ? Math.min(SPACING, SPACING / (many - 1)) : 0) * unit;
		const out = at.size / 2 + 4 * unit + rank * spacing;
		const middle = side === 0 ? at.x + out : at.x - out;
		return { left: middle - size / 2, top: at.y + at.size / 2 + 4 * unit - size, size };
	});
}
