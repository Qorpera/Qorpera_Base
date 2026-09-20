// Original Qorpera dock icons (browser, files, terminal). One drawing per icon,
// shared by icon.html (renders the PNGs embedded in ../qorpera-screen-session)
// and mock.html (the 1920x1200 look check). No third-party artwork.
// Canvas 112x112: a 92x92 rounded tile on top, the running dot underneath.
const TILE = { x: 10, y: 2, size: 92, radius: 22 };
const tiles = {
	browser: ["#5aa9ff", "#2563eb"],
	files: ["#ffd166", "#f59e0b"],
	terminal: ["#3b4252", "#1b1f2a"],
};
const glyphs = {
	// A globe: outline, equator and one meridian pair.
	browser: `<g fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round">
		<circle cx="56" cy="48" r="27"/>
		<ellipse cx="56" cy="48" rx="12" ry="27"/>
		<path d="M29 48h54"/></g>`,
	// A folder: back flap with tab, lighter front pocket.
	files: `<path d="M27 34a6 6 0 0 1 6-6h14.5a6 6 0 0 1 4.6 2.2l3.4 4.1H79a6 6 0 0 1 6 6V66a6 6 0 0 1-6 6H33a6 6 0 0 1-6-6z" fill="#fff" fill-opacity=".55"/>
		<path d="M27 45a5 5 0 0 1 5-5h48a5 5 0 0 1 5 5v21a6 6 0 0 1-6 6H33a6 6 0 0 1-6-6z" fill="#fff"/>`,
	// A prompt: chevron and cursor line.
	terminal: `<g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
		<path d="M32 33l16 15-16 15"/><path d="M56 64h24" stroke="#7ee787"/></g>`,
};
function dockIcon(name, state = "idle") {
	const [top, bottom] = tiles[name];
	const failed = state === "failed";
	const dot =
		state === "running"
			? `<circle cx="56" cy="105" r="5.5" fill="#fff" fill-opacity=".92"/>`
			: failed
				? `<circle cx="56" cy="105" r="5.5" fill="#f5a524"/>`
				: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 112" width="112" height="112">
	<defs>
		<linearGradient id="g-${name}-${state}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${failed ? "#8b93a1" : top}"/><stop offset="1" stop-color="${failed ? "#565d6b" : bottom}"/>
		</linearGradient>
	</defs>
	<rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="url(#g-${name}-${state})"/>
	<rect x="${TILE.x + 0.75}" y="${TILE.y + 0.75}" width="${TILE.size - 1.5}" height="${TILE.size - 1.5}" rx="${TILE.radius - 0.75}" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"/>
	<g${failed ? ' opacity=".8"' : ""}>${glyphs[name]}</g>
	${dot}
</svg>`;
}
