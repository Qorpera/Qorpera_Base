// The pictures of a machine's desktop (12 Nov 2026), which scripts/package-machine-guest.mjs carries as one archive
// and deploy/machine/build-machine-image.sh unpacks at /usr/share/qorpera-desktop: the office dock's nine icon
// drawings (deploy/lxd-company-computer-guest/design/icons) as dock/<icon>.png, the six of them that carry a mark
// drawn again for a light ground (deploy/machine/dock-light, 14 Nov 2026: the dock stands on the wallpaper) as
// dock-light/<icon>.png, and a backdrop set for every figure an agent can have as backdrops/<figure>/<HH>.png, 24
// frames each, with the neutral Qorpera set (deploy/machine/backdrops) as backdrops/neutral. The session shows them
// (deploy/machine/desktop-look).

/** The dock's icon states: one drawing each. */
export const DOCK_ICONS = Object.freeze([
	"browser-failed",
	"browser-idle",
	"browser-launching",
	"browser-launching-2",
	"browser-running",
	"files-idle",
	"files-running",
	"terminal-idle",
	"terminal-running",
]);

/** The icon states with a mark under the tile: on a light ground the mark is dark, a drawing of its own. */
export const DOCK_ICONS_LIGHT = Object.freeze([
	"browser-failed",
	"browser-launching",
	"browser-launching-2",
	"browser-running",
	"files-running",
	"terminal-running",
]);

/** Which of the office's backdrop files draws which figure. The files have historical names: the table is
 * cloud-company-computer-wallpapers.ts's COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER without the retired ghost, which
 * every client draws as the moon (a test keeps the two alike). */
export const BACKDROP_FILES = Object.freeze({
	planet: "brain",
	acorn: "folio",
	flame: "ribbon",
	rocket: "pebble",
	crown: "halo",
	heart: "bloom",
	star: "star",
	cloud: "cloud",
	bolt: "bolt",
	mushroom: "mushroom",
	moon: "moon",
	puzzle: "puzzle",
});

/** The set a machine shows when it names no figure. */
export const NEUTRAL_BACKDROP = "neutral";

const HOURS = Array.from({ length: 24 }, (_value, hour) => String(hour).padStart(2, "0"));

/** Every picture: its name in the archive and its source in the repository. */
export const MACHINE_DESKTOP_PICTURES = Object.freeze([
	...DOCK_ICONS.map((icon) => ({
		name: `dock/${icon}.png`,
		source: `deploy/lxd-company-computer-guest/design/icons/${icon}.png`,
	})),
	...DOCK_ICONS_LIGHT.map((icon) => ({
		name: `dock-light/${icon}.png`,
		source: `deploy/machine/dock-light/${icon}.png`,
	})),
	...Object.entries(BACKDROP_FILES).flatMap(([figure, file]) =>
		HOURS.map((hour) => ({
			name: `backdrops/${figure}/${hour}.png`,
			source: `deploy/lxd-company-computer-guest/backdrops/qorpera-screen-${file}-${hour}.png`,
		})),
	),
	...HOURS.map((hour) => ({
		name: `backdrops/${NEUTRAL_BACKDROP}/${hour}.png`,
		source: `deploy/machine/backdrops/neutral-${hour}.png`,
	})),
]);

/** A plain tar archive (ustar) of files, the same bytes for the same files wherever it is made: root's, mode 0644, one
 * fixed date (12 Nov 2026, as octal seconds), in the order given. */
export function tarArchive(entries) {
	const blocks = [];
	for (const { name, bytes } of entries) {
		if (Buffer.byteLength(name) > 99) throw new Error(`The archive name ${name} is too long`);
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write("15275200600\0", 136);
		header.write("        ", 148);
		header.write("0", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		header.write("root", 265);
		header.write("root", 297);
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}
