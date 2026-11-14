// The curve kit's engine: "Where is it going?"
// One value over time, drawn big: the past as a filled area, the expected part as a dotted line inside a band that
// widens with how unsure it is, a "now" line, a dashed safe level and a few marked points, with the value that matters
// large at the top. A member runs a finger or the pointer along it (or the arrow keys) and the big number follows.
// The agent writes only curve.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const SVGNS = "http://www.w3.org/2000/svg";
	const MAX = { title: 40, line: 60, unit: 8, label: 12, mark: 24, safe: 24, head: 24, word: 28, points: 120, marks: 3 };
	const WORDS = {
		now: "now",
		safe: "safe level",
		expected: "expected",
		assumed: "assumed",
		unknown: "not known",
		between: "{low} to {high}",
		empty: "Nothing to show yet.",
		source: "Source",
	};
	const STATES = ["known", "assumed", "unknown"];
	const TONES = ["accent", "good", "warn", "bad"];
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.ck{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --ck-tone:var(--q-accent);--ck-ease:cubic-bezier(.22,.8,.24,1)}
.ck *,.ck *::before,.ck *::after{box-sizing:border-box}
.ck.t-good{--ck-tone:var(--q-good)}.ck.t-warn{--ck-tone:var(--q-warn)}.ck.t-bad{--ck-tone:var(--q-bad)}
.ck-head{min-width:0;max-width:40em}
.ck-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.ck-title-row{display:flex;align-items:baseline;gap:8px}
.ck-src{display:inline-grid;place-items:center;min-width:24px;min-height:24px;font-size:14px;color:var(--q-muted);text-decoration:none;border-radius:6px}
.ck-src:hover{color:var(--q-accent)}
.ck-src:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.ck-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.ck--bare{padding:clamp(12px,1vw,16px)}
.ck--bare .ck-head{display:none}
.ck-hero{margin-top:clamp(14px,2.4vh,26px);min-height:calc(clamp(44px,6vw,80px) + 32px)}
.ck--bare .ck-hero{margin-top:0}
.ck-row{display:flex;align-items:baseline;gap:.28em;white-space:nowrap}
.ck-n{font-size:clamp(44px,6vw,80px);font-weight:650;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.ck-u{font-size:clamp(18px,1.9vw,26px);font-weight:600;letter-spacing:-.01em;color:var(--q-muted)}
.ck-n.unk{color:var(--q-muted)}
.ck-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;font-size:14px;line-height:1.3;color:var(--q-muted);min-height:20px}
.ck-sub b{font-weight:650;color:var(--q-text)}
.ck-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1.3px dashed color-mix(in srgb,var(--q-muted) 70%,transparent);font-size:12px;font-weight:550;color:var(--q-muted)}
.ck-tag.exp{border-style:solid;border-color:transparent;background:color-mix(in srgb,var(--ck-tone) 13%,var(--q-bg));color:color-mix(in srgb,var(--ck-tone) 78%,var(--q-text))}
.ck-plot{position:relative;flex:none;margin-top:clamp(8px,1.6vh,18px);min-height:240px;outline:none;touch-action:pan-y;cursor:crosshair;border-radius:12px}
.ck-plot:focus-visible{box-shadow:0 0 0 2px var(--q-accent)}
.ck-plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;max-width:none}
.ck-area{fill:var(--ck-tone);fill-opacity:.2}
.ck-past{fill:none;stroke:var(--ck-tone);stroke-width:5;stroke-linejoin:round;stroke-linecap:round}
.ck-past.a{stroke-dasharray:10 9}
.ck-gap{fill:none;stroke:var(--q-muted);stroke-width:2;stroke-dasharray:1 7;stroke-linecap:round;opacity:.7}
.ck-band{fill:var(--ck-tone);fill-opacity:.11}
.ck-band-edge{fill:none;stroke:var(--ck-tone);stroke-width:1.2;stroke-opacity:.28}
.ck-ahead{fill:none;stroke:var(--ck-tone);stroke-width:4.5;stroke-dasharray:1.5 10;stroke-linecap:round;stroke-linejoin:round}
.ck-fog{fill:url(#ck-hatch);opacity:.9}
.ck-fog-tint{fill:var(--q-text);fill-opacity:.035}
.ck-hatch-line{stroke:var(--q-muted);stroke-width:1.3;opacity:.35}
.ck-q{font-size:30px;font-weight:600;fill:var(--q-muted);text-anchor:middle;dominant-baseline:central}
.ck-safe{stroke:var(--q-warn);stroke-width:2;stroke-dasharray:8 8;opacity:.75}
.ck-safe-t{font-size:13px;font-weight:550;fill:var(--q-warn);text-anchor:end}
.ck-now{stroke:var(--q-text);stroke-width:2}
.ck-now-dot{fill:var(--q-text)}
.ck-x{font-size:13px;fill:var(--q-muted);text-anchor:middle}
.ck-x.now{fill:var(--q-text);font-weight:700}
.ck-mark{fill:var(--q-bg);stroke:var(--ck-tone);stroke-width:4}
.ck-mark-v{font-size:20px;font-weight:700;fill:var(--q-text);text-anchor:middle;font-variant-numeric:tabular-nums}
.ck-mark-t{font-size:13px;fill:var(--q-muted);text-anchor:middle}
.ck-mark-v,.ck-mark-t,.ck-safe-t{paint-order:stroke;stroke:var(--q-bg);stroke-width:5px;stroke-linejoin:round}
.ck-scrub{pointer-events:none;opacity:0;transition:opacity .15s}
.ck-scrub.on{opacity:1}
.ck-hair{stroke:var(--q-text);stroke-opacity:.35;stroke-width:1.5}
.ck-hair-dot{fill:var(--ck-tone);stroke:var(--q-bg);stroke-width:3}
.ck-hair-ring{fill:var(--q-bg);stroke:var(--ck-tone);stroke-width:2.5;stroke-dasharray:3 3}
.ck-quiet{margin:0;font-size:15px;color:var(--q-muted)}
.ck.intro .ck-past{animation:ck-draw 1s var(--ck-ease) both}
.ck.intro .ck-area{animation:ck-fade .9s var(--ck-ease) .15s both}
.ck.intro .ck-later{animation:ck-fade .8s var(--ck-ease) .55s both}
.ck.intro .ck-marks{animation:ck-fade .6s var(--ck-ease) .85s both}
@keyframes ck-draw{from{stroke-dashoffset:var(--ck-len)}to{stroke-dashoffset:0}}
@keyframes ck-fade{from{opacity:0}to{opacity:1}}
@media (max-width:560px){.ck-plot{cursor:default}}
@media (prefers-reduced-motion:reduce){.ck *,.ck *::before,.ck *::after{transition:none!important;animation:none!important}}
`;

	// ---------------------------------------------------------------- helpers
	const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
	const list = (v) => (Array.isArray(v) ? v : []);
	const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
	function cut(v, n) {
		const chars = Array.from(text(v).replace(/\s+/g, " ").trim());
		return chars.length <= n ? chars.join("") : `${chars.slice(0, n - 1).join("").trimEnd()}…`;
	}
	function num(v) {
		const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
		return Number.isFinite(n) ? n : null;
	}
	function h(tag, cls, attrs, ...kids) {
		const el = D.createElement(tag);
		if (cls) el.className = cls;
		if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, String(attrs[k]));
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
		return el;
	}
	function s(tag, attrs, ...kids) {
		const el = D.createElementNS(SVGNS, tag);
		if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, String(attrs[k]));
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
		return el;
	}
	const r1 = (v) => Math.round(v * 10) / 10;
	const say = (tpl, map) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : ""));

	// The page's own element: it takes the place of the one before and leaves the rest of the body (the pictures the
	// page names in #kit-media) where it is.
	function show(main) {
		for (const old of D.querySelectorAll("body > main.ck")) old.remove();
		D.body.append(main);
	}

	// ---------------------------------------------------------------- data
	function bandOf(v) {
		let lo = null;
		let hi = null;
		if (Array.isArray(v)) {
			lo = num(v[0]);
			hi = num(v[1]);
		} else if (isObj(v)) {
			lo = num(v.low);
			hi = num(v.high);
		}
		if (lo === null || hi === null) return null;
		return lo <= hi ? [lo, hi] : [hi, lo];
	}
	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...WORDS };
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const points = list(raw.points)
			.slice(0, MAX.points)
			.filter(isObj)
			.map((p) => {
				const value = num(p.value);
				const state = STATES.includes(p.state) ? p.state : value === null ? "unknown" : "known";
				return { label: cut(p.label, MAX.label), value: state === "unknown" ? null : value, state, band: bandOf(p.band) };
			});
		if (points.length < 2) throw new Error("fewer than two points");
		let now = -1;
		if (typeof raw.now === "number" && Number.isInteger(raw.now) && raw.now >= 0 && raw.now < points.length) now = raw.now;
		else if (typeof raw.now === "string") now = points.findIndex((p) => p.label === cut(raw.now, MAX.label));
		const safeRaw = isObj(raw.safe) ? raw.safe : { value: raw.safe };
		const safeValue = num(safeRaw.value);
		const safe = safeValue === null ? null : { value: safeValue, label: cut(safeRaw.label, MAX.safe) || words.safe };
		const marks = [];
		for (const m of list(raw.marks)) {
			if (!isObj(m) || marks.length >= MAX.marks) continue;
			const i = typeof m.at === "number" && Number.isInteger(m.at) ? m.at : points.findIndex((p) => p.label === cut(m.at, MAX.label));
			if (i < 0 || i >= points.length || marks.some((x) => x.i === i)) continue;
			marks.push({ i, text: cut(m.text, MAX.mark) });
		}
		let headline = null;
		if (isObj(raw.headline)) {
			const value = num(raw.headline.value);
			const state = STATES.includes(raw.headline.state) ? raw.headline.state : value === null ? "unknown" : "known";
			headline = { value: state === "unknown" ? null : value, state, label: cut(raw.headline.label, MAX.head) };
		}
		const source = typeof raw.source === "string" && /^(?:https:\/\/|folder:)/.test(raw.source) ? raw.source : "";
		return {
			lang,
			words,
			title: cut(raw.title, MAX.title),
			line: cut(raw.line, MAX.line),
			unit: cut(raw.unit, MAX.unit),
			tone: TONES.includes(raw.tone) ? raw.tone : "accent",
			points,
			now,
			safe,
			marks,
			headline,
			source,
		};
	}

	// ---------------------------------------------------------------- numbers
	function formatter(m) {
		const all = [];
		for (const p of m.points) {
			if (p.value !== null) all.push(p.value);
			if (p.band) all.push(p.band[0], p.band[1]);
		}
		const span = all.length ? Math.max(...all.map(Math.abs)) : 0;
		const digits = span >= 100 ? 0 : span >= 10 ? 1 : 2;
		let nf;
		try {
			nf = new Intl.NumberFormat(m.lang, { maximumFractionDigits: digits });
		} catch {
			nf = new Intl.NumberFormat("en", { maximumFractionDigits: digits });
		}
		return (v) => nf.format(v);
	}

	// A smooth line through points that never overshoots them (monotone cubic, Fritsch and Carlson).
	function smooth(pts) {
		if (pts.length < 2) return pts.length ? `M${r1(pts[0][0])} ${r1(pts[0][1])}` : "";
		if (pts.length === 2) return `M${r1(pts[0][0])} ${r1(pts[0][1])}L${r1(pts[1][0])} ${r1(pts[1][1])}`;
		const n = pts.length;
		const dx = [];
		const dy = [];
		const m = [];
		for (let i = 0; i < n - 1; i++) {
			dx.push(pts[i + 1][0] - pts[i][0]);
			dy.push(pts[i + 1][1] - pts[i][1]);
			m.push(dx[i] ? dy[i] / dx[i] : 0);
		}
		const t = [m[0]];
		for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
		t.push(m[n - 2]);
		for (let i = 0; i < n - 1; i++) {
			if (m[i] === 0) {
				t[i] = 0;
				t[i + 1] = 0;
				continue;
			}
			const a = t[i] / m[i];
			const b = t[i + 1] / m[i];
			const q = a * a + b * b;
			if (q > 9) {
				const k = 3 / Math.sqrt(q);
				t[i] = k * a * m[i];
				t[i + 1] = k * b * m[i];
			}
		}
		let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
		for (let i = 0; i < n - 1; i++) {
			const third = dx[i] / 3;
			d += `C${r1(pts[i][0] + third)} ${r1(pts[i][1] + t[i] * third)} ${r1(pts[i + 1][0] - third)} ${r1(pts[i + 1][1] - t[i + 1] * third)} ${r1(pts[i + 1][0])} ${r1(pts[i + 1][1])}`;
		}
		return d;
	}
	// The same line backwards, for the lower edge of a band.
	const reversed = (pts) => smooth(pts.slice().reverse()).replace(/^M/, "L");

	// ---------------------------------------------------------------- page
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "curve" }, CSS);
		D.head.append(style);
	}
	const ui = { model: null, root: null, plot: null, svg: null, hero: null, scrub: null, frame: 0, count: 0, width: 0, height: 0, shown: false };

	function quiet(line) {
		ensureStyle();
		show(h("main", `ck${BARE ? " ck--bare" : ""}`, null, h("p", "ck-quiet", null, line)));
		ui.root = null;
	}

	function render(intro) {
		const m = ui.model;
		ensureStyle();
		D.documentElement.lang = m.lang;
		const root = h("main", `ck t-${m.tone}${BARE ? " ck--bare" : ""}${intro && !still() ? " intro" : ""}`, { lang: m.lang });
		const title = h("div", "ck-title-row", null, h("h1", "ck-title", null, m.title || ""));
		if (m.source) title.append(h("a", "ck-src", { href: m.source, title: m.words.source, "aria-label": m.words.source }, "↗"));
		root.append(h("header", "ck-head", null, title, m.line ? h("p", "ck-line", null, m.line) : null));
		const hero = h("div", "ck-hero", { "aria-live": "polite" });
		root.append(hero);
		const plot = h("div", "ck-plot", { tabindex: "0", role: "slider", "aria-label": m.title || m.words.now, "aria-valuemin": "0", "aria-valuemax": String(m.points.length - 1) });
		root.append(plot);
		show(root);
		ui.root = root;
		ui.hero = hero;
		ui.plot = plot;
		bindPlot(plot);
		draw();
		paintHero(intro && !still());
		if (intro) setTimeout(() => root.classList.remove("intro"), 2200);
	}

	// The index whose value the big number shows when nobody points: now, or the last point with a value.
	function restIndex(m) {
		if (m.now >= 0) return m.now;
		for (let i = m.points.length - 1; i >= 0; i--) if (m.points[i].value !== null) return i;
		return m.points.length - 1;
	}
	const isAhead = (m, i) => m.now >= 0 && i > m.now;

	function paintHero(count) {
		const m = ui.model;
		const fmt = formatter(m);
		const i = ui.scrub;
		let value;
		let state;
		let label;
		let band = null;
		let ahead = false;
		if (i === null && m.headline) {
			value = m.headline.value;
			state = m.headline.state;
			label = m.headline.label || m.words.now;
		} else {
			const at = i === null ? restIndex(m) : i;
			const p = m.points[at];
			value = p.value;
			state = p.state;
			ahead = isAhead(m, at);
			band = ahead ? p.band : null;
			label = i === null ? (m.now >= 0 ? m.words.now : p.label) : p.label;
			if (value === null && band) state = "band";
		}
		const n = h("span", `ck-n${value === null ? " unk" : ""}`);
		const row = h("div", "ck-row", null, n);
		if (value !== null && m.unit) row.append(h("span", "ck-u", null, m.unit));
		if (value === null && band) {
			n.textContent = `${fmt(band[0])}–${fmt(band[1])}`;
			n.classList.remove("unk");
			n.style.fontSize = "clamp(34px,4.6vw,60px)";
			if (m.unit) row.append(h("span", "ck-u", null, m.unit));
		} else if (value === null) n.textContent = "?";
		else if (count) countTo(n, value, fmt);
		else n.textContent = fmt(value);
		const sub = h("div", "ck-sub", null, h("span", null, null, label));
		if (ahead) sub.append(h("span", "ck-tag exp", null, m.words.expected));
		if (state === "assumed") sub.append(h("span", "ck-tag", null, m.words.assumed));
		if (state === "unknown" && value === null && !band) sub.append(h("span", "ck-tag", null, m.words.unknown));
		if (band && value !== null) sub.append(h("span", null, null, say(m.words.between, { low: fmt(band[0]), high: fmt(band[1]) })));
		ui.hero.replaceChildren(row, sub);
		if (ui.plot) {
			const at = i === null ? restIndex(m) : i;
			const p = m.points[at];
			ui.plot.setAttribute("aria-valuenow", String(at));
			ui.plot.setAttribute("aria-valuetext", `${p.label}: ${p.value === null ? (p.band ? `${fmt(p.band[0])}–${fmt(p.band[1])}` : "?") : fmt(p.value)}${m.unit ? ` ${m.unit}` : ""}`);
		}
	}
	function countTo(el, to, fmt) {
		cancelAnimationFrame(ui.count);
		const t0 = performance.now();
		const from = to * 0.6;
		let frames = 0;
		// by the clock, and never longer than about 100 frames, so a page whose frames come slowly still ends there
		const step = (t) => {
			const k = Math.min(1, Math.max((t - t0) / 800, ++frames / 96));
			const e = 1 - (1 - k) ** 3;
			el.textContent = fmt(k >= 1 ? to : from + (to - from) * e);
			if (k < 1) ui.count = requestAnimationFrame(step);
		};
		el.textContent = fmt(from);
		ui.count = requestAnimationFrame(step);
	}

	// ---------------------------------------------------------------- the drawing
	function size() {
		const plot = ui.plot;
		const W = Math.max(240, plot.clientWidth || 0);
		const top = plot.getBoundingClientRect ? plot.getBoundingClientRect().top + (window.scrollY || 0) : 0;
		const pad = ui.root ? Number.parseFloat(getComputedStyle(ui.root).paddingBottom) || 24 : 24;
		const avail = (window.innerHeight || 800) - top - pad;
		const H = Math.round(Math.max(260, Math.min(avail, W < 600 ? W * 1.8 : W * 0.62)));
		return { W, H };
	}

	function draw() {
		const m = ui.model;
		const plot = ui.plot;
		if (!m || !plot) return;
		const { W, H } = size();
		plot.style.height = `${H}px`;
		ui.width = W;
		ui.height = H;
		const fmt = formatter(m);
		const n = m.points.length;
		const phone = W < 600;
		const padL = 12;
		const padR = 12;
		const padT = 34;
		const padB = 36;
		const x = (i) => padL + ((W - padL - padR) * i) / (n - 1);
		const vals = [];
		for (const p of m.points) {
			if (p.value !== null) vals.push(p.value);
			if (p.band && isAhead(m, m.points.indexOf(p))) vals.push(p.band[0], p.band[1]);
		}
		if (m.safe) vals.push(m.safe.value);
		if (m.headline && m.headline.value !== null && !vals.length) vals.push(m.headline.value);
		let lo = vals.length ? Math.min(...vals) : 0;
		let hi = vals.length ? Math.max(...vals) : 1;
		if (lo >= 0 && lo <= hi * 0.4) lo = 0;
		else lo -= (hi - lo) * 0.18 || 1;
		hi += (hi - lo) * 0.1 || 1;
		const bottom = H - padB;
		const y = (v) => padT + (bottom - padT) * (1 - (v - lo) / (hi - lo));
		const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
		const defs = s("defs");
		const hatch = s("pattern", { id: "ck-hatch", width: 9, height: 9, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, s("line", { x1: 0, y1: 0, x2: 0, y2: 9, class: "ck-hatch-line" }));
		defs.append(hatch);
		svg.append(defs);
		const last = m.now >= 0 ? m.now : n - 1;

		// the past: runs of points with a value, each a filled area under a solid line
		const past = s("g");
		let run = [];
		let prevEnd = null;
		const flush = () => {
			if (!run.length) return;
			const pts = run.map((i) => [x(i), y(m.points[i].value)]);
			if (prevEnd) past.append(s("path", { class: "ck-gap", d: `M${r1(prevEnd[0])} ${r1(prevEnd[1])}L${r1(pts[0][0])} ${r1(pts[0][1])}` }));
			const line = smooth(pts);
			if (pts.length > 1) past.append(s("path", { class: "ck-area", d: `${line}L${r1(pts[pts.length - 1][0])} ${bottom}L${r1(pts[0][0])} ${bottom}Z` }));
			const assumed = run.some((i) => m.points[i].state === "assumed");
			const stroke = s("path", { class: `ck-past${assumed ? " a" : ""}`, d: line });
			const len = pts.reduce((sum, p, k) => (k ? sum + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0) * 1.15 + 20;
			if (!assumed) {
				stroke.style.setProperty("--ck-len", String(Math.round(len)));
				stroke.style.strokeDasharray = String(Math.round(len));
			}
			past.append(stroke);
			prevEnd = pts[pts.length - 1];
			run = [];
		};
		for (let i = 0; i <= last; i++) {
			if (m.points[i].value === null) flush();
			else run.push(i);
		}
		flush();

		// what is expected: a band from now outwards, a dotted line inside it, and fog where nothing is said
		const later = s("g", { class: "ck-later" });
		if (m.now >= 0 && m.now < n - 1) {
			const start = m.points[m.now].value;
			const upper = [];
			const lower = [];
			const line = [];
			const lines = [];
			let fogFrom = -1;
			if (start !== null) {
				upper.push([x(m.now), y(start)]);
				lower.push([x(m.now), y(start)]);
				line.push([x(m.now), y(start)]);
			}
			for (let i = m.now + 1; i < n; i++) {
				const p = m.points[i];
				const band = p.band || (p.value !== null ? [p.value, p.value] : null);
				if (!band) {
					fogFrom = i;
					break;
				}
				upper.push([x(i), y(band[1])]);
				lower.push([x(i), y(band[0])]);
				if (p.value !== null) line.push([x(i), y(p.value)]);
				else if (line.length) {
					lines.push(line.splice(0));
				}
			}
			if (line.length) lines.push(line.splice(0));
			if (upper.length > 1) {
				const top = smooth(upper);
				later.append(s("path", { class: "ck-band", d: `${top}${reversed(lower)}Z` }));
				later.append(s("path", { class: "ck-band-edge", d: top }), s("path", { class: "ck-band-edge", d: smooth(lower) }));
			}
			for (const part of lines) if (part.length > 1) later.append(s("path", { class: "ck-ahead", d: smooth(part) }));
			if (fogFrom > 0) {
				const fx = x(fogFrom - 1) + (x(fogFrom) - x(fogFrom - 1)) * 0.5;
				later.append(
					s("rect", { class: "ck-fog-tint", x: r1(fx), y: padT - 10, width: r1(W - padR - fx), height: r1(bottom - padT + 10), rx: 10 }),
					s("rect", { class: "ck-fog", x: r1(fx), y: padT - 10, width: r1(W - padR - fx), height: r1(bottom - padT + 10), rx: 10 }),
					s("text", { class: "ck-q", x: r1((fx + W - padR) / 2), y: r1((padT + bottom) / 2) }, "?"),
				);
			}
		}

		// the safe level
		const safeG = s("g");
		// where the safe level's words stand: [left, top, bottom], which a mark's words keep clear of
		let safeBox = null;
		if (m.safe && m.safe.value >= lo && m.safe.value <= hi) {
			const sy = r1(y(m.safe.value));
			safeG.append(s("line", { class: "ck-safe", x1: 0, x2: W, y1: sy, y2: sy }));
			safeG.append(s("text", { class: "ck-safe-t", x: W - padR, y: sy - 9 }, m.safe.label));
			safeBox = [W - padR - Array.from(m.safe.label).length * 7.4 - 8, sy - 26, sy + 4];
		}

		// now
		const nowG = s("g");
		if (m.now >= 0) {
			const nx = r1(x(m.now));
			nowG.append(s("line", { class: "ck-now", x1: nx, x2: nx, y1: padT - 18, y2: bottom + 6 }));
			const v = m.points[m.now].value;
			if (v !== null) nowG.append(s("circle", { class: "ck-now-dot", cx: nx, cy: r1(y(v)), r: 8.5 }));
		}

		// the labels along the bottom: as many as fit, now always
		const xs = s("g");
		const widest = Math.max(...m.points.map((p) => Array.from(p.label).length), Array.from(m.words.now).length) * 7.6 + 18;
		const fit = Math.max(2, Math.floor((W - padL - padR) / widest));
		const every = Math.max(1, Math.ceil(n / fit));
		for (let i = 0; i < n; i++) {
			const isNow = i === m.now;
			if (!isNow && (i % every !== 0 || (m.now >= 0 && Math.abs(i - m.now) < every))) continue;
			const label = isNow ? m.words.now : m.points[i].label;
			if (!label) continue;
			const anchor = i === 0 && !isNow ? "start" : i === n - 1 && !isNow ? "end" : "middle";
			const t = s("text", { class: `ck-x${isNow ? " now" : ""}`, x: r1(i === 0 ? padL - 4 : i === n - 1 ? W - padR + 4 : x(i)), y: H - 10 }, label);
			t.style.textAnchor = anchor;
			xs.append(t);
		}

		// the marked points, each with its value and a few words, below a low and above a high
		const marks = s("g", { class: "ck-marks" });
		for (const mk of m.marks) {
			const p = m.points[mk.i];
			const v = p.value !== null ? p.value : p.band ? (p.band[0] + p.band[1]) / 2 : null;
			if (v === null) continue;
			const mx = x(mk.i);
			const my = y(v);
			const before = m.points[mk.i - 1];
			const after = m.points[mk.i + 1];
			const around = [before, after].filter((q) => q && q.value !== null).map((q) => q.value);
			const low = around.length ? v <= Math.min(...around) : my > (padT + bottom) / 2;
			marks.append(s("circle", { class: "ck-mark", cx: r1(mx), cy: r1(my), r: 8 }));
			const cx = Math.min(W - 64, Math.max(64, mx));
			// below a low and above a high, outside the band where there is one, and clear of the safe level's words
			const band = isAhead(m, mk.i) && p.band ? p.band : [v, v];
			const under = Math.max(my, y(band[0])) + 34;
			const over = Math.min(my, y(band[1])) - 40;
			const safeY = m.safe ? y(m.safe.value) : -1e9;
			const fits = (ty) =>
				ty - 20 > padT - 30 &&
				ty + 24 < bottom &&
				!(safeY > ty - 22 && safeY < ty + 26) &&
				!(safeBox && cx + 64 > safeBox[0] && ty + 24 > safeBox[1] && ty - 20 < safeBox[2]);
			const ty = (low ? [under, my + 34, over] : [over, my - 32, under]).find(fits) ?? (low ? my + 34 : my - 32);
			marks.append(s("text", { class: "ck-mark-v", x: r1(cx), y: r1(ty) }, fmt(v)));
			if (mk.text) marks.append(s("text", { class: "ck-mark-t", x: r1(cx), y: r1(ty + 19) }, mk.text));
		}

		// what follows a finger or the pointer
		const scrub = s("g", { class: "ck-scrub" });
		const hair = s("line", { class: "ck-hair", y1: padT - 18, y2: bottom });
		const dot = s("circle", { class: "ck-hair-dot", r: 7 });
		scrub.append(hair, dot);

		svg.append(past, later, safeG, nowG, marks, xs, scrub);
		plot.replaceChildren(svg);
		ui.svg = svg;
		ui.geo = { x, y, padL, padR, n, W, phone };
		ui.scrubEls = { scrub, hair, dot };
		paintScrub();
	}

	function paintScrub() {
		const els = ui.scrubEls;
		const m = ui.model;
		if (!els || !m) return;
		const i = ui.scrub;
		if (i === null) {
			els.scrub.classList.remove("on");
			return;
		}
		const p = m.points[i];
		const gx = r1(ui.geo.x(i));
		els.hair.setAttribute("x1", gx);
		els.hair.setAttribute("x2", gx);
		const v = p.value !== null ? p.value : p.band && isAhead(m, i) ? (p.band[0] + p.band[1]) / 2 : null;
		if (v === null) els.dot.setAttribute("r", "0");
		else {
			els.dot.setAttribute("r", "7");
			els.dot.setAttribute("cx", gx);
			els.dot.setAttribute("cy", r1(ui.geo.y(v)));
			els.dot.setAttribute("class", p.value === null ? "ck-hair-ring" : "ck-hair-dot");
		}
		els.scrub.classList.add("on");
	}

	function setScrub(i) {
		if (i === ui.scrub) return;
		ui.scrub = i;
		paintScrub();
		paintHero(false);
	}
	function indexAt(clientX) {
		const g = ui.geo;
		const box = ui.plot.getBoundingClientRect();
		const px = clientX - box.left;
		const k = (px - g.padL) / ((g.W - g.padL - g.padR) / (g.n - 1));
		return Math.max(0, Math.min(g.n - 1, Math.round(k)));
	}
	function bindPlot(plot) {
		plot.addEventListener("pointermove", (e) => {
			if (e.pointerType === "touch" && !e.isPrimary) return;
			setScrub(indexAt(e.clientX));
		});
		plot.addEventListener("pointerdown", (e) => setScrub(indexAt(e.clientX)));
		plot.addEventListener("pointerleave", (e) => {
			if (D.activeElement !== plot || e.pointerType === "mouse") setScrub(null);
		});
		plot.addEventListener("focus", () => {
			if (ui.scrub === null && plot.matches(":focus-visible")) setScrub(restIndex(ui.model));
		});
		plot.addEventListener("blur", () => setScrub(null));
		plot.addEventListener("keydown", (e) => {
			const n = ui.model.points.length;
			const at = ui.scrub === null ? restIndex(ui.model) : ui.scrub;
			let next = null;
			if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(n - 1, at + 1);
			else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, at - 1);
			else if (e.key === "Home") next = 0;
			else if (e.key === "End") next = n - 1;
			else if (e.key === "Escape") {
				setScrub(null);
				return;
			}
			if (next === null) return;
			e.preventDefault();
			setScrub(next);
		});
	}

	// ---------------------------------------------------------------- size changes
	let resizeFrame = 0;
	function onResize() {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!ui.model || !ui.plot || !ui.root) return;
			const W = ui.plot.clientWidth;
			if (W === ui.width && ui.lastH === window.innerHeight) return;
			ui.lastH = window.innerHeight;
			draw();
		});
	}
	window.addEventListener("resize", onResize);

	// ---------------------------------------------------------------- loading
	let lastRead = 0;
	let pending = 0;
	let lastText = null;
	async function load() {
		lastRead = Date.now();
		let txt;
		let raw = null;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			// the page puts the company's live values in place of the data's bindings
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "curve.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			if (txt === lastText && ui.root) return;
			raw = JSON.parse(txt);
			const next = normalize(raw);
			const first = !ui.shown;
			const keep = ui.scrub;
			ui.model = next;
			ui.scrub = keep !== null && keep < next.points.length ? keep : null;
			lastText = txt;
			render(first);
			ui.shown = true;
			ui.lastH = window.innerHeight;
		} catch {
			if (!ui.root) quiet((raw && isObj(raw.words) && cut(raw.words.empty, 60)) || WORDS.empty);
			// a read that gave no text: keep what is shown, and read again ten seconds later, until a read works
			if (typeof txt !== "string") {
				clearTimeout(pending);
				pending = setTimeout(load, 10000);
			}
		}
	}
	function onChange() {
		clearTimeout(pending);
		pending = setTimeout(load, Math.max(0, lastRead + 10000 - Date.now()));
	}
	function start() {
		ensureStyle();
		load();
		// a live value that moved: read again at once
		if (typeof KIT.onLive === "function") KIT.onLive(load);
		try {
			if (window.qorpera && typeof window.qorpera.onChange === "function") window.qorpera.onChange(onChange);
		} catch {
			/* the frame may not offer it */
		}
	}
	if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
})();
