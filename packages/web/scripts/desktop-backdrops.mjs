// The machine desktop's backdrop figures for the web (13 Nov 2026): the computer window draws the desktop the member is
// about to see while it starts (src/ui/computer-scene.ts), from the same traced paths the machine's backdrop pictures
// were rendered from (deploy/lxd-company-computer-guest/backdrops-source, deploy/machine/backdrops-source). One small
// JSON per figure in public/assets/desktop/backdrops, fetched when a window first needs it. Run after a backdrop source
// changes: `node packages/web/scripts/desktop-backdrops.mjs` (test/computer-scene.test.ts holds the copies equal).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Which source draws which figure: the machine's own table (scripts/machine-desktop-art.mjs BACKDROP_FILES), and the
 * neutral wordmark. */
export const BACKDROP_SOURCES = Object.freeze({
	planet: "deploy/lxd-company-computer-guest/backdrops-source/brain.html",
	acorn: "deploy/lxd-company-computer-guest/backdrops-source/folio.html",
	flame: "deploy/lxd-company-computer-guest/backdrops-source/ribbon.html",
	rocket: "deploy/lxd-company-computer-guest/backdrops-source/pebble.html",
	crown: "deploy/lxd-company-computer-guest/backdrops-source/halo.html",
	heart: "deploy/lxd-company-computer-guest/backdrops-source/bloom.html",
	star: "deploy/lxd-company-computer-guest/backdrops-source/star.html",
	cloud: "deploy/lxd-company-computer-guest/backdrops-source/cloud.html",
	bolt: "deploy/lxd-company-computer-guest/backdrops-source/bolt.html",
	mushroom: "deploy/lxd-company-computer-guest/backdrops-source/mushroom.html",
	moon: "deploy/lxd-company-computer-guest/backdrops-source/moon.html",
	puzzle: "deploy/lxd-company-computer-guest/backdrops-source/puzzle.html",
	neutral: "deploy/machine/backdrops-source/neutral.html",
});

/** One source's figure: its group transform, fill rule and paths, as the web draws them. */
export function backdropFromSource(html) {
	const group = html.match(/<g id="fig"([^>]*)>([\s\S]*?)<\/g>/);
	if (!group) throw new Error("A backdrop source without its figure");
	return {
		transform: group[1].match(/transform="([^"]*)"/)?.[1] ?? "",
		evenodd: /fill-rule="evenodd"/.test(group[1]),
		paths: [...group[2].matchAll(/<path([^>]*)\/>/g)].map((match) => ({
			d: match[1].match(/ d="([^"]*)"/)?.[1] ?? "",
			transform: match[1].match(/transform="([^"]*)"/)?.[1] ?? "",
		})),
	};
}

export function desktopBackdrops() {
	return Object.fromEntries(
		Object.entries(BACKDROP_SOURCES).map(([figure, source]) => [
			figure,
			backdropFromSource(readFileSync(join(root, source), "utf8")),
		]),
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = join(root, "packages/web/public/assets/desktop/backdrops");
	mkdirSync(out, { recursive: true });
	for (const [figure, backdrop] of Object.entries(desktopBackdrops()))
		writeFileSync(join(out, `${figure}.json`), `${JSON.stringify(backdrop)}\n`);
}
