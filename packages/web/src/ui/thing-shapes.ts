import { READING_SHAPES, type ReadingShape } from "@qorpera/cloud-client/company-state-files";

/* The emblems the company's page draws the things of its reading with (QorperaOS/vision/reading.md; Jonas, 14 November
 * 2026: "It should feel like the company is conscious almost"): one path per name of the platform's set, each one solid
 * shape with white cuts in a 100 x 100 box. A cut is a subpath inside a solid one, so the path is drawn with
 * `fill-rule: evenodd` and its solids never overlap. The page also strokes each path in its own colour (5 units, round
 * joins), which rounds its corners and narrows each cut by that much: a cut is at least 12 units wide. Board, pin, coin,
 * drop and person and the workshop drawn as `factory` come from the approved sketch. An unknown name draws `blob`. */

const n = (value: number) => Number(value.toFixed(2));

/** One path of several subpaths. */
const path = (...parts: string[]) => parts.join("");

/** A rounded rectangle, clockwise. */
function rr(x: number, y: number, w: number, h: number, r: number): string {
	return `M${n(x + r)},${n(y)}h${n(w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}v${n(h - 2 * r)}a${r},${r} 0 0 1 ${-r},${r}h${n(-(w - 2 * r))}a${r},${r} 0 0 1 ${-r},${-r}v${n(-(h - 2 * r))}a${r},${r} 0 0 1 ${r},${-r}z`;
}

/** An ellipse (a circle when `ry` is left out). */
function ci(cx: number, cy: number, rx: number, ry = rx): string {
	return `M${n(cx - rx)},${n(cy)}a${rx},${ry} 0 1 0 ${n(2 * rx)},0a${rx},${ry} 0 1 0 ${n(-2 * rx)},0z`;
}

/** A closed polygon through `points`. */
function poly(points: readonly (readonly [number, number])[]): string {
	return `M${points.map(([x, y]) => `${n(x)},${n(y)}`).join("L")}Z`;
}

/** An open-end wrench: a C-shaped head around (62, 38) opening up and right, its handle going down and left. */
function wrench(): string {
	const rad = (degrees: number) => (degrees * Math.PI) / 180;
	const at = (radius: number, degrees: number) =>
		[62 + radius * Math.cos(rad(degrees)), 38 + radius * Math.sin(rad(degrees))] as const;
	const head: (readonly [number, number])[] = [];
	for (let degrees = -10; degrees <= 280; degrees += 10) head.push(at(22, degrees));
	for (let degrees = 280; degrees >= -10; degrees -= 10) head.push(at(9, degrees));
	const along = [Math.cos(rad(135)), Math.sin(rad(135))] as const;
	const across = [Math.cos(rad(45)), Math.sin(rad(45))] as const;
	const point = (distance: number, side: number) =>
		[62 + along[0] * distance + across[0] * side, 38 + along[1] * distance + across[1] * side] as const;
	return path(poly(head), poly([point(22.5, 8), point(60, 8), point(60, -8), point(22.5, -8)]));
}

/** A gear: `teeth` teeth between two radii around (50, 50). */
function gear(teeth: number, outer: number, inner: number): string {
	const step = (2 * Math.PI) / teeth;
	const at = (angle: number, radius: number) =>
		`${n(50 + radius * Math.cos(angle))},${n(50 + radius * Math.sin(angle))}`;
	const points: string[] = [];
	for (let tooth = 0; tooth < teeth; tooth++) {
		const middle = tooth * step - Math.PI / 2;
		points.push(
			at(middle - step * 0.34, inner),
			at(middle - step * 0.18, outer),
			at(middle + step * 0.18, outer),
			at(middle + step * 0.34, inner),
		);
	}
	return `M${points.join("L")}Z`;
}

export const THING_SHAPES: Readonly<Record<ReadingShape, string>> = Object.freeze({
	// A board of three columns of work (the sketch's tracker).
	board: path(rr(8, 12, 84, 76, 14), rr(19, 25, 17, 30, 4), rr(41.5, 25, 17, 44, 4), rr(64, 25, 17, 20, 4)),
	box: path(rr(10, 18, 80, 70, 10), rr(18, 32, 64, 12, 6), rr(40, 56, 20, 14, 7)),
	screen: path(rr(6, 12, 88, 60, 10), rr(16, 22, 68, 40, 4), "M41,72h18l4,10h-26Z", rr(26, 82, 48, 8, 4)),
	phone: path(rr(26, 4, 48, 92, 12), rr(34, 14, 32, 62, 4), ci(50, 85, 6)),
	gear: path(gear(8, 44, 33), ci(50, 50, 14)),
	code: path(rr(6, 12, 88, 76, 14), "M38,28L16,50L38,72L48,62L36,50L48,38Z", "M62,28L84,50L62,72L52,62L64,50L52,38Z"),
	// The sketch's customer.
	person: path(ci(50, 30, 17), "M16,92C16,70 31,58 50,58C69,58 84,70 84,92Z"),
	people: path(
		ci(36, 32, 15),
		"M8,86C8,66 20,56 36,56C52,56 64,66 64,86Z",
		ci(80, 46, 10),
		"M66,86V80C66,68 72,62 80,62C88,62 94,68 94,80V86Z",
	),
	heart: "M50,88C50,88 10,62 10,36C10,22 21,12 33,12C41,12 47,17 50,23C53,17 59,12 67,12C79,12 90,22 90,36C90,62 50,88 50,88Z",
	// The sketch's market.
	pin: path("M50,7C30,7 15,22 15,41C15,65 50,93 50,93C50,93 85,65 85,41C85,22 70,7 50,7Z", ci(50, 40, 13)),
	globe: path(ci(50, 50, 42), ci(50, 50, 18, 42), ci(50, 50, 9, 42), rr(10, 44, 22, 12, 6), rr(68, 44, 22, 12, 6)),
	chart: path(rr(6, 8, 88, 84, 12), rr(18, 50, 14, 28, 4), rr(43, 34, 14, 44, 4), rr(68, 20, 14, 58, 4)),
	// The sketch's money.
	coin: path(ci(50, 50, 42), rr(42, 29, 16, 42, 8)),
	bank: path(
		"M50,8L90,30V36H10V30Z",
		rr(16, 42, 14, 34, 3),
		rr(43, 42, 14, 34, 3),
		rr(70, 42, 14, 34, 3),
		rr(8, 80, 84, 10, 3),
	),
	// The sketch's look.
	drop: path("M50,7C50,7 19,45 19,62a31,31 0 0 0 62,0C81,45 50,7 50,7Z", ci(41, 64, 10)),
	megaphone: path(
		"M14,38H30L74,14V86L30,62H14a6,6 0 0 1 -6,-6V44a6,6 0 0 1 6,-6Z",
		"M30,72h12l5,16h-12Z",
		rr(82, 38, 10, 24, 5),
	),
	cart: path("M4,12H22L25,24H94L84,62H32L22,22H4Z", rr(38, 34, 36, 12, 6), ci(38, 80, 8), ci(76, 80, 8)),
	handshake: path(
		"M4,36L28,28L50,46L38,62L22,58L4,62Z",
		"M96,36L72,28L54,40L66,54L78,58L96,62Z",
		rr(30, 64, 40, 14, 7),
	),
	truck: path(rr(4, 22, 58, 48, 6), "M64,34H80L94,50V70H64Z", "M69,40H79L88,52H69Z", ci(24, 80, 9), ci(78, 80, 9)),
	// The sketch's workshop: a house with its door.
	factory: path("M50,10L90,42V86a5,5 0 0 1 -5,5H15a5,5 0 0 1 -5,-5V42Z", rr(40, 56, 20, 29, 5)),
	scale: path(
		rr(46, 16, 8, 62, 4),
		rr(8, 20, 34, 8, 4),
		rr(58, 20, 34, 8, 4),
		"M6,46h36a18,18 0 0 1 -36,0Z",
		"M58,46h36a18,18 0 0 1 -36,0Z",
		rr(26, 80, 48, 10, 5),
	),
	document: path(
		"M20,6H62L86,30V88a6,6 0 0 1 -6,6H20a6,6 0 0 1 -6,-6V12a6,6 0 0 1 6,-6Z",
		"M58,10V34H82Z",
		rr(24, 48, 50, 12, 6),
		rr(24, 68, 36, 12, 6),
	),
	chat: path(
		"M16,12H84a10,10 0 0 1 10,10V62a10,10 0 0 1 -10,10H40L20,90V72H16a10,10 0 0 1 -10,-10V22a10,10 0 0 1 10,-10Z",
		ci(30, 42, 7),
		ci(50, 42, 7),
		ci(70, 42, 7),
	),
	wrench: wrench(),
	blob: "M50,8C72,8 92,22 90,46C88,70 74,92 50,90C26,88 8,74 10,50C12,26 28,8 50,8Z",
});

/** The path a thing's shape is drawn with: its own, or the plain blob for a name the set does not have. */
export function thingShape(name: string): string {
	return (READING_SHAPES as readonly string[]).includes(name) ? THING_SHAPES[name as ReadingShape] : THING_SHAPES.blob;
}
