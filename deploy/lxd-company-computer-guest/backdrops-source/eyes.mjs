// The eyes on a desktop's backdrop (14 Nov 2026; Jonas, on the first real desktops: "The eyes should stay on the
// wallpaper - even if we can't animate it, it makes the computer feel alive"). The computer window's start scene
// (packages/web/src/ui/computer-scene.ts) draws the agent's figure with its eyes on the wallpaper it is about to show;
// the picture that then came had the figure without them. Each figure's backdrop source now carries the same two eyes,
// still: where the product draws them (motion-model.js `faces`, in the figure's 100-unit frame), white, in the frame's
// own transform. The retired ghost (wisp.html) has no eyes in the product and gets none.
//
//   node deploy/lxd-company-computer-guest/backdrops-source/eyes.mjs   writes the eyes into every source
//   then render.sh draws the pictures from them (scripts/package-machine-guest.test.mjs holds source and product alike)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

/** Which figure each source draws (the files have historical names: render.sh). */
export const BACKDROP_SOURCE_FIGURES = Object.freeze({
	bloom: "heart",
	brain: "planet",
	folio: "acorn",
	halo: "crown",
	pebble: "rocket",
	ribbon: "flame",
	star: "star",
	cloud: "cloud",
	bolt: "bolt",
	mushroom: "mushroom",
	moon: "moon",
	puzzle: "puzzle",
});

/** The product's eye geometry by figure: two eyes each, their centre, size and turn in the 100-unit frame. */
export function productFaces() {
	const scope = {};
	new Function("window", readFileSync(join(root, "packages/web/public/assets/avatars/motion-model.js"), "utf8"))(scope);
	return scope.QORPERA_MOTION_MODEL.faces;
}

const number = (value) => String(Math.round(value * 1000) / 1000);

/** The eyes of one figure as the source carries them: a group beside the figure's, in the same transform. */
export function backdropEyes(eyes, transform) {
	const shapes = eyes.map((eye) => {
		const radius = Math.min(eye.width, eye.height) / 2;
		return `<rect x="${number(eye.x - eye.width / 2)}" y="${number(eye.y - eye.height / 2)}" width="${number(eye.width)}" height="${number(eye.height)}" rx="${number(radius)}" transform="rotate(${number(eye.rotation)} ${number(eye.x)} ${number(eye.y)})"/>`;
	});
	return `<g id="eyes" fill="#fff" transform="${transform}">${shapes.join("")}</g>`;
}

/** A source with its figure's eyes: put after the figure's group, replacing eyes it already carries. */
export function withBackdropEyes(html, eyes) {
	const figure = html.match(/<g id="fig"[^>]*transform="([^"]*)"[^>]*>[\s\S]*?<\/g>/);
	if (!figure) throw new Error("A backdrop source without its figure");
	const bare = html.replace(/<g id="eyes"[^>]*>[\s\S]*?<\/g>/, "");
	const end = bare.indexOf(figure[0]) + figure[0].length;
	return bare.slice(0, end) + backdropEyes(eyes, figure[1]) + bare.slice(end);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const faces = productFaces();
	for (const [source, figure] of Object.entries(BACKDROP_SOURCE_FIGURES)) {
		const file = join(here, `${source}.html`);
		const eyes = faces[figure];
		if (!eyes || eyes.length !== 2) throw new Error(`The product draws no pair of eyes for ${figure}`);
		writeFileSync(file, withBackdropEyes(readFileSync(file, "utf8"), eyes));
	}
}
