// The flow kit's engine: "Where does it come from, and where does it go?"
// Money or people as a river: wide soft bands from where they come (on the left) through the company (a bar in the
// middle) to where they go (on the right), or straight from each source to each end, every band as wide as its
// amount. A few bands only: past six on a side the smallest join one band, "Other". One big number stands at the top;
// a member points at a band (or steps with the arrow keys) and the number becomes that band's.
// The agent writes only flow.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const SVGNS = "http://www.w3.org/2000/svg";
	const MAX = { title: 40, line: 60, name: 20, unit: 8, label: 24, word: 28, side: 6, links: 24 };
	const WORDS = {
		total: "in all",
		other: "Other",
		rest: "Not accounted for",
		assumed: "assumed",
		unknown: "not known",
		empty: "Nothing to show yet.",
		source: "Source",
	};
	const STATES = ["known", "assumed", "unknown"];
	const TONES = ["good", "warm", "accent", "warn", "bad", "violet", "teal"];
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.fk{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --fk-ease:cubic-bezier(.22,.8,.24,1);--fk-warm:color-mix(in srgb,var(--q-bad) 70%,var(--q-warn))}
.fk *,.fk *::before,.fk *::after{box-sizing:border-box}
.fk-head{min-width:0;max-width:40em}
.fk-title-row{display:flex;align-items:baseline;gap:8px}
.fk-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.fk-src{display:inline-grid;place-items:center;min-width:24px;min-height:24px;font-size:14px;color:var(--q-muted);text-decoration:none;border-radius:6px}
.fk-src:hover{color:var(--q-accent)}
.fk-src:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.fk-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.fk--bare{padding:clamp(12px,1vw,16px)}
.fk--bare .fk-head{display:none}
.fk-hero{margin-top:clamp(14px,2.4vh,26px);min-height:calc(clamp(44px,6vw,80px) + 32px)}
.fk--bare .fk-hero{margin-top:0}
.fk-row{display:flex;align-items:baseline;gap:.28em;white-space:nowrap}
.fk-n{font-size:clamp(44px,6vw,80px);font-weight:650;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.fk-n.unk{color:var(--q-muted)}
.fk-u{font-size:clamp(18px,1.9vw,26px);font-weight:600;letter-spacing:-.01em;color:var(--q-muted)}
.fk-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;font-size:14px;line-height:1.3;color:var(--q-muted);min-height:20px}
.fk-sub b{font-weight:650;color:var(--q-text)}
.fk-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1.3px dashed color-mix(in srgb,var(--q-muted) 70%,transparent);font-size:12px;font-weight:550;color:var(--q-muted)}
.fk-stage{position:relative;flex:none;margin-top:clamp(12px,2.4vh,28px);outline:none;touch-action:pan-y;border-radius:12px}
.fk-stage:focus-visible{box-shadow:0 0 0 2px var(--q-accent)}
.fk-stage svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;max-width:none}
.fk-band{fill:var(--fk-tone);fill-opacity:.24;transition:fill-opacity .2s;cursor:pointer}
.fk-band.unk{fill:none;stroke:color-mix(in srgb,var(--q-text) 30%,var(--q-bg));stroke-width:1.5;stroke-dasharray:5 6}
.fk-band.a{fill-opacity:.12;stroke:var(--fk-tone);stroke-opacity:.6;stroke-width:1.5;stroke-dasharray:6 6}
.fk.picking .fk-band{fill-opacity:.09}
.fk.picking .fk-band.on{fill-opacity:.46}
.fk-bar{fill:var(--fk-tone)}
.fk-band.rest{fill:var(--q-text);fill-opacity:.05;stroke:color-mix(in srgb,var(--q-text) 28%,var(--q-bg));stroke-width:1.3;stroke-dasharray:5 6}
.fk.picking .fk-band.rest.on{fill-opacity:.12}
.fk-lab.rest .fk-name{fill:var(--q-muted);font-weight:550}
.fk-bar.unk{fill:var(--q-bg);stroke:color-mix(in srgb,var(--q-text) 34%,var(--q-bg));stroke-width:1.5;stroke-dasharray:4 4}
.fk-mid{fill:var(--q-text)}
.fk-q{font-size:17px;font-weight:600;fill:var(--q-muted);text-anchor:middle;dominant-baseline:central;cursor:pointer}
.fk-name{font-size:15px;font-weight:600;fill:var(--q-text);cursor:pointer}
.fk-amt{font-size:13px;fill:var(--q-muted);font-variant-numeric:tabular-nums;cursor:pointer}
.fk-name,.fk-amt,.fk-mid-t{paint-order:stroke;stroke:var(--q-bg);stroke-width:4px;stroke-linejoin:round}
.fk-mid-t{font-size:13px;fill:var(--q-muted);text-anchor:middle}
.fk.picking .fk-lab:not(.on){opacity:.45}
.fk-lab{transition:opacity .2s;cursor:pointer}
.fk-quiet{margin:0;font-size:15px;color:var(--q-muted)}
.fk.small .fk-name{font-size:13px}
.fk.small .fk-amt{font-size:12px}
.fk.intro .fk-in{animation:fk-fade .8s var(--fk-ease) .1s both}
.fk.intro .fk-out{animation:fk-fade .8s var(--fk-ease) .45s both}
.fk.intro .fk-labs{animation:fk-fade .6s var(--fk-ease) .7s both}
@keyframes fk-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.fk *,.fk *::before,.fk *::after{transition:none!important;animation:none!important}}
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
	function toneVar(tone) {
		if (tone === "warm") return "var(--fk-warm)";
		if (tone === "violet") return "color-mix(in srgb,var(--q-accent) 55%,var(--q-bad))";
		if (tone === "teal") return "color-mix(in srgb,var(--q-good) 60%,var(--q-accent))";
		if (tone === "other") return "color-mix(in srgb,var(--q-text) 42%,var(--q-bg))";
		if (tone === "ink") return "color-mix(in srgb,var(--q-text) 80%,var(--q-bg))";
		return `var(--q-${tone})`;
	}

	// The page's own element: it takes the place of the one before and leaves the rest of the body (the pictures the
	// page names in #kit-media) where it is.
	function show(main) {
		for (const old of D.querySelectorAll("body > main.fk")) old.remove();
		D.body.append(main);
	}

	// ---------------------------------------------------------------- data
	function amount(raw) {
		const value = num(raw.value);
		const state = STATES.includes(raw.state) ? raw.state : value === null ? "unknown" : "known";
		return { value: state === "unknown" || value === null ? null : Math.max(0, value), state: value === null ? "unknown" : state };
	}
	const idOf = (raw, at, side) => (typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `${side}${at}`);
	// What several amounts add up to: their sum, assumed where one is, not known where all are.
	function sum(parts) {
		const known = parts.filter((p) => p.value !== null);
		if (!known.length) return { value: null, state: "unknown" };
		const value = known.reduce((t, p) => t + p.value, 0);
		return { value, state: known.length < parts.length || parts.some((p) => p.state === "assumed") ? "assumed" : "known" };
	}

	// A side of more than MAX.side ends: the largest stay in their order, a kept one always, and the rest join "Other".
	function cap(nodes, words) {
		if (nodes.length <= MAX.side) return { nodes, merged: new Map() };
		const room = MAX.side - 1;
		const kept = nodes.filter((n) => n.kept).slice(0, room);
		const ranked = nodes
			.filter((n) => !n.kept)
			.slice()
			.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
			.slice(0, room - kept.length);
		const stay = new Set([...kept, ...ranked]);
		const gone = nodes.filter((n) => !stay.has(n));
		const other = { id: "\u0000other", name: words.other, tone: "other", kept: false, ...sum(gone) };
		const merged = new Map(gone.map((n) => [n.id, other.id]));
		const out = nodes.filter((n) => stay.has(n) && !n.kept);
		out.push(other, ...nodes.filter((n) => stay.has(n) && n.kept));
		return { nodes: out, merged };
	}

	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...WORDS };
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const linked = Array.isArray(raw.links) && raw.links.length > 0;
		const side = (items, which, tone) => {
			const seen = new Set();
			const out = [];
			list(items).forEach((n, at) => {
				if (!isObj(n)) return;
				const id = idOf(n, at, which);
				if (seen.has(id)) return;
				seen.add(id);
				const kept = which === "to" && n.kept === true;
				out.push({ id, name: cut(n.name, MAX.name), tone: TONES.includes(n.tone) ? n.tone : kept ? "good" : tone, kept, ...amount(n) });
			});
			// the kept ones last, under the rest, as the sketch of the money river has them
			return out.filter((n) => !n.kept).concat(out.filter((n) => n.kept));
		};
		// through the middle money comes in green; straight through, the bands take the colour of where they end
		let from = side(raw.from, "from", linked ? "ink" : "good");
		let to = side(raw.to, "to", "warm");
		if (!from.length || !to.length) throw new Error("no ends");
		let links = [];
		if (linked) {
			for (const l of list(raw.links).slice(0, MAX.links * 4)) {
				if (!isObj(l)) continue;
				const a = from.find((n) => n.id === l.from);
				const b = to.find((n) => n.id === l.to);
				if (a && b) links.push({ from: a.id, to: b.id, ...amount(l) });
			}
			// an end's amount is what its bands carry
			for (const n of [...from, ...to]) Object.assign(n, sum(links.filter((l) => l.from === n.id || l.to === n.id)));
			from = from.filter((n) => links.some((l) => l.from === n.id));
			to = to.filter((n) => links.some((l) => l.to === n.id));
			if (!from.length || !to.length) throw new Error("no links");
		}
		const left = cap(from, words);
		const right = cap(to, words);
		if (linked) {
			// bands of ends that joined Other join as well, one band from each end to each end
			const joined = new Map();
			for (const l of links) {
				const a = left.merged.get(l.from) || l.from;
				const b = right.merged.get(l.to) || l.to;
				const key = `${a}\u0000${b}`;
				if (!joined.has(key)) joined.set(key, { from: a, to: b, parts: [] });
				joined.get(key).parts.push(l);
			}
			links = [...joined.values()].map((j) => ({ from: j.from, to: j.to, ...sum(j.parts) })).slice(0, MAX.links);
		}
		let headline = null;
		if (isObj(raw.headline)) {
			const value = num(raw.headline.value);
			const state = STATES.includes(raw.headline.state) ? raw.headline.state : value === null ? "unknown" : "known";
			headline = { value: state === "unknown" ? null : value, state, label: cut(raw.headline.label, MAX.label) };
		}
		// Through the middle, what came in and what went out are the same money. Where the agent's two sides differ by
		// more than a rounding (1 %), the side that is short gets the difference as a quiet band of its own, in the data's
		// own word (words.rest), so no band is drawn wider or narrower than its amount. Not while an amount is not known.
		const known = (nodes) => (nodes.every((n) => n.value !== null) ? nodes.reduce((t, n) => t + n.value, 0) : null);
		const came = known(left.nodes);
		const went = known(right.nodes);
		if (!linked && came !== null && went !== null && Math.abs(came - went) > Math.max(came, went) * 0.01) {
			const rest = { id: "\u0000rest", name: words.rest, tone: "other", kept: false, rest: true, value: Math.abs(came - went), state: "known" };
			const short = came > went ? right.nodes : left.nodes;
			const at = short.findIndex((n) => n.kept);
			short.splice(at < 0 ? short.length : at, 0, rest);
		}
		const middle = !linked && raw.middle !== false && raw.middle !== null ? cut(isObj(raw.middle) ? raw.middle.name : raw.middle, MAX.name) : null;
		const source = typeof raw.source === "string" && /^(?:https:\/\/|folder:)/.test(raw.source) ? raw.source : "";
		return {
			lang,
			words,
			title: cut(raw.title, MAX.title),
			line: cut(raw.line, MAX.line),
			unit: cut(raw.unit, MAX.unit),
			from: left.nodes,
			to: right.nodes,
			links: linked ? links : null,
			middle,
			headline,
			source,
		};
	}

	// The bands a member steps through: through the middle, one for each end; straight through, one for each pair.
	function bandsOf(m) {
		if (m.links) return m.links.map((l) => ({ kind: "link", ...l, tone: m.to.find((n) => n.id === l.to).tone }));
		return [...m.from.map((n) => ({ kind: "from", ...n, end: n.id })), ...m.to.map((n) => ({ kind: "to", ...n, end: n.id }))];
	}

	// ---------------------------------------------------------------- numbers
	function formats(m) {
		const all = [...m.from, ...m.to].map((n) => n.value).filter((v) => v !== null);
		const span = all.length ? Math.max(...all) : 0;
		const pick = (make) => {
			try {
				return make(m.lang);
			} catch {
				return make("en");
			}
		};
		const nf = pick((l) => new Intl.NumberFormat(l, { maximumFractionDigits: span >= 100 ? 0 : span >= 10 ? 1 : 2 }));
		const pf = pick((l) => new Intl.NumberFormat(l, { style: "percent", maximumFractionDigits: 0 }));
		return { num: (v) => nf.format(v), share: (v) => pf.format(v) };
	}
	const fmt = (m) => m.f || (m.f = formats(m));

	// ---------------------------------------------------------------- page
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "flow" }, CSS);
		D.head.append(style);
	}
	const ui = { model: null, bands: [], root: null, stage: null, hero: null, pick: null, width: 0, shown: false };

	function quiet(line) {
		ensureStyle();
		show(h("main", `fk${BARE ? " fk--bare" : ""}`, null, h("p", "fk-quiet", null, line)));
		ui.root = null;
	}

	function render(intro) {
		const m = ui.model;
		ensureStyle();
		D.documentElement.lang = m.lang;
		const root = h("main", `fk${BARE ? " fk--bare" : ""}${intro && !still() ? " intro" : ""}`, { lang: m.lang });
		const title = h("div", "fk-title-row", null, h("h1", "fk-title", null, m.title || ""));
		if (m.source) title.append(h("a", "fk-src", { href: m.source, title: m.words.source, "aria-label": m.words.source }, "↗"));
		root.append(h("header", "fk-head", null, title, m.line ? h("p", "fk-line", null, m.line) : null));
		const hero = h("div", "fk-hero", { "aria-live": "polite" });
		const stage = h("div", "fk-stage", { tabindex: "0", role: "slider", "aria-label": m.title || m.words.total, "aria-valuemin": "0", "aria-valuemax": String(Math.max(0, ui.bands.length - 1)) });
		root.append(hero, stage);
		show(root);
		ui.root = root;
		ui.hero = hero;
		ui.stage = stage;
		bindStage(stage);
		draw();
		if (intro) setTimeout(() => root.classList.remove("intro"), 2000);
	}

	function size() {
		const stage = ui.stage;
		const W = Math.max(280, stage.clientWidth || 0);
		const top = stage.getBoundingClientRect ? stage.getBoundingClientRect().top + (window.scrollY || 0) : 0;
		const pad = ui.root ? Number.parseFloat(getComputedStyle(ui.root).paddingBottom) || 24 : 24;
		const avail = (window.innerHeight || 800) - top - pad;
		const H = Math.round(Math.max(W < 600 ? 380 : 320, Math.min(avail, W < 600 ? W * 1.45 : W * 0.56)));
		return { W, H };
	}

	// A soft band from one edge to another: [x, top, bottom] at each end.
	function ribbon(a, b) {
		const mx = (a[0] + b[0]) / 2;
		return `M${r1(a[0])} ${r1(a[1])}C${r1(mx)} ${r1(a[1])} ${r1(mx)} ${r1(b[1])} ${r1(b[0])} ${r1(b[1])}L${r1(b[0])} ${r1(b[2])}C${r1(mx)} ${r1(b[2])} ${r1(mx)} ${r1(a[2])} ${r1(a[0])} ${r1(a[2])}Z`;
	}

	function draw() {
		const m = ui.model;
		const stage = ui.stage;
		if (!m || !stage) return;
		const { W, H } = size();
		stage.style.height = `${H}px`;
		ui.width = W;
		const f = fmt(m);
		const small = W < 600;
		ui.root.classList.toggle("small", small);
		// the columns of names: as wide as the longest name or amount, at most a quarter of the page
		const per = small ? 7.3 : 8.4;
		const longest = (nodes) => Math.max(...nodes.map((n) => Math.max(Array.from(n.name).length, (n.value === null ? 1 : f.num(n.value).length + Array.from(m.unit).length + 1) * 0.86)));
		const colL = Math.min(W * (small ? 0.27 : 0.22), longest(m.from) * per + 14);
		const colR = Math.min(W * (small ? 0.27 : 0.22), longest(m.to) * per + 14);
		const bar = small ? 10 : 14;
		const midW = small ? 12 : 18;
		const x0 = colL;
		const x2 = W - colR - bar;
		const xm = (x0 + bar + x2) / 2 - midW / 2;
		const padT = 4;
		const padB = m.middle ? 28 : 6;
		const gap = small ? 10 : 18;
		// a band nobody knows the size of: open, as wide as a small band, with a "?" in it
		const stub = small ? 16 : 24;
		const total = (nodes) => nodes.reduce((t, n) => t + (n.value ?? 0), 0);
		const stubs = (nodes) => nodes.filter((n) => n.value === null).length * stub;
		const room = (nodes) => H - padT - padB - (nodes.length - 1) * gap - stubs(nodes);
		const most = Math.max(total(m.from), total(m.to), 1e-9);
		const k = Math.max(0, Math.min(room(m.from) / Math.max(total(m.from), 1e-9), room(m.to) / Math.max(total(m.to), 1e-9), (H - padT - padB - stub * 2) / most));
		const bands = ui.bands;
		// a band's width; straight through, an end is as tall as its bands together
		const hb = (b) => (b.value === null ? stub : Math.max(m.links ? 1.5 : 2, b.value * k));
		const hOf = (n) => (m.links ? bands.filter((b) => b.from === n.id || b.to === n.id).reduce((t, b) => t + hb(b), 0) : hb(n));
		const place = (nodes) => {
			const height = nodes.reduce((t, n) => t + hOf(n), 0) + (nodes.length - 1) * gap;
			let y = padT + (H - padT - padB - height) / 2;
			return nodes.map((n) => {
				const at = { n, y, h: hOf(n) };
				y += at.h + gap;
				return at;
			});
		};
		const L = place(m.from);
		const R = place(m.to);
		const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
		const ins = s("g", { class: "fk-in" });
		const outs = s("g", { class: "fk-out" });
		const bars = s("g");
		const labs = s("g", { class: "fk-labs" });
		const els = [];
		const bandEl = (band, d, idx, g, ends) => {
			const p = s("path", { class: `fk-band${band.rest ? " rest" : band.value === null ? " unk" : band.state === "assumed" ? " a" : ""}`, d, "data-k": idx });
			p.style.setProperty("--fk-tone", toneVar(band.tone));
			g.append(p);
			(els[idx] = els[idx] || []).push(p);
			if (band.value === null) g.append(s("text", { class: "fk-q", x: r1((ends[0][0] + ends[1][0]) / 2), y: r1((ends[0][1] + ends[0][2] + ends[1][1] + ends[1][2]) / 4), "data-k": idx }, "?"));
		};
		if (!m.links) {
			// through the middle: each end's band meets the middle's bar, stacked in the ends' order
			const inH = L.reduce((t, a) => t + a.h, 0);
			const outH = R.reduce((t, a) => t + a.h, 0);
			const midH = Math.max(inH, outH);
			const midY = padT + (H - padT - padB - midH) / 2;
			let yi = midY + (midH - inH) / 2;
			L.forEach((a, i) => {
				const ends = [[x0 + bar, a.y, a.y + a.h], [xm, yi, yi + a.h]];
				bandEl(bands[i], ribbon(...ends), i, ins, ends);
				yi += a.h;
			});
			let yo = midY + (midH - outH) / 2;
			R.forEach((a, i) => {
				const idx = L.length + i;
				const ends = [[xm + midW, yo, yo + a.h], [x2, a.y, a.y + a.h]];
				bandEl(bands[idx], ribbon(...ends), idx, outs, ends);
				yo += a.h;
			});
			bars.append(s("rect", { class: "fk-mid", x: r1(xm), y: r1(midY), width: midW, height: r1(midH), rx: 5 }));
			if (m.middle) labs.append(s("text", { class: "fk-mid-t", x: r1(xm + midW / 2), y: r1(midY + midH + 20) }, m.middle));
		} else {
			// straight through: at each end its bands stack in the order of the ends across
			const offL = new Map(L.map((a) => [a.n.id, a.y]));
			const offR = new Map(R.map((a) => [a.n.id, a.y]));
			const order = (side, id) => side.findIndex((a) => a.n.id === id);
			const byLeft = bands.map((b, i) => ({ b, i })).sort((p, q) => order(L, p.b.from) - order(L, q.b.from) || order(R, p.b.to) - order(R, q.b.to));
			const startR = new Map();
			for (const { b, i } of bands.map((b, i) => ({ b, i })).sort((p, q) => order(R, p.b.to) - order(R, q.b.to) || order(L, p.b.from) - order(L, q.b.from))) {
				const y = offR.get(b.to);
				startR.set(i, y);
				offR.set(b.to, y + hb(b));
			}
			for (const { b, i } of byLeft) {
				const y = offL.get(b.from);
				offL.set(b.from, y + hb(b));
				const yr = startR.get(i);
				const ends = [[x0 + bar, y, y + hb(b)], [x2, yr, yr + hb(b)]];
				bandEl(b, ribbon(...ends), i, ins, ends);
			}
		}
		// the ends' bars and their names, the names kept apart where bands are thin
		const label = (a, x, anchor, idxs) => {
			const n = a.n;
			const bar_ = s("rect", { class: `fk-bar${n.value === null || n.rest ? " unk" : ""}`, x: r1(x), y: r1(a.y), width: bar, height: r1(a.h), rx: Math.min(4, bar / 3) });
			bar_.style.setProperty("--fk-tone", toneVar(n.tone));
			bars.append(bar_);
			const share = n.value === null ? "?" : `${f.num(n.value)}${m.unit ? ` ${m.unit}` : ""}`;
			const g = s("g", { class: `fk-lab${n.rest ? " rest" : ""}`, "data-k": idxs[0], "data-n": n.id });
			const tx = anchor === "end" ? x - 10 : x + bar + 10;
			// a finger's room round the name and the bar, so a thin band is as easy to pick as a wide one
			const wide = Math.max(Array.from(n.name).length * per, share.length * per * 0.86) + bar + 18;
			const hit = s("rect", { class: "fk-hit", x: r1(anchor === "end" ? x + bar - wide : x), width: r1(wide), height: 44, fill: "transparent" });
			g.append(s("text", { class: "fk-name", x: r1(tx), "text-anchor": anchor }, n.name), s("text", { class: "fk-amt", x: r1(tx), "text-anchor": anchor }, share), hit);
			labs.append(g);
			for (const idx of idxs) (els[idx] = els[idx] || []).push(g);
			return { g, y: a.y + a.h / 2 };
		};
		const ofEnd = (id, key) => bands.map((b, i) => (b[key] === id ? i : -1)).filter((i) => i >= 0);
		const sideLabels = (side, x, anchor, key, offset) =>
			side.map((a, i) => label(a, x, anchor, m.links ? ofEnd(a.n.id, key) : [offset + i]));
		const spread = (labels) => {
			const line = small ? 32 : 38;
			let prev = -Infinity;
			const ys = labels.map((l) => {
				const y = Math.max(l.y, prev + line);
				prev = y;
				return y;
			});
			const over = ys.length ? ys[ys.length - 1] - (H - line / 2) : 0;
			labels.forEach((l, i) => {
				const y = Math.max(line / 2, ys[i] - Math.max(0, over));
				const [name, amt, hit] = l.g.children;
				name.setAttribute("y", r1(y - 3));
				amt.setAttribute("y", r1(y + 14));
				hit.setAttribute("y", r1(y - 24));
			});
		};
		spread(sideLabels(L, x0, "end", "from", 0));
		spread(sideLabels(R, x2, "start", "to", L.length));
		svg.append(ins, outs, bars, labs);
		stage.replaceChildren(svg);
		ui.els = els;
		paint();
	}

	// The big number, the picked band, and what a reader hears.
	function paint() {
		const m = ui.model;
		if (!m || !ui.hero) return;
		const f = fmt(m);
		const b = ui.pick === null ? null : ui.bands[ui.pick];
		let value;
		let state;
		const what = [];
		if (b) {
			value = b.value;
			state = b.state;
			const ends = b.kind === "link" ? [m.from.find((n) => n.id === b.from).name, m.to.find((n) => n.id === b.to).name] : [b.name];
			what.push(h("b", null, null, ends.join(" → ")));
			const whole = b.kind === "to" ? sumOf(m.to) : sumOf(m.from);
			if (value !== null && whole.value) what.push(h("span", null, null, f.share(value / whole.value)));
		} else if (m.headline) {
			value = m.headline.value;
			state = m.headline.state;
			what.push(h("span", null, null, m.headline.label || m.words.total));
		} else {
			({ value, state } = sumOf(m.from));
			what.push(h("span", null, null, m.words.total));
		}
		const n = h("span", `fk-n${value === null ? " unk" : ""}`, null, value === null ? "?" : f.num(value));
		const row = h("div", "fk-row", null, n, value !== null && m.unit ? h("span", "fk-u", null, m.unit) : null);
		if (state === "assumed") what.push(h("span", "fk-tag", null, m.words.assumed));
		if (value === null) what.push(h("span", "fk-tag", null, m.words.unknown));
		ui.hero.replaceChildren(row, h("div", "fk-sub", null, what));
		ui.root.classList.toggle("picking", b !== null);
		// the picked band, and the names of its ends (an end's name stands for all its bands)
		for (const el of ui.stage.querySelectorAll(".on")) el.classList.remove("on");
		if (b) for (const el of (ui.els && ui.els[ui.pick]) || []) el.classList.add("on");
		if (ui.stage) {
			ui.stage.setAttribute("aria-valuenow", String(ui.pick === null ? 0 : ui.pick));
			ui.stage.setAttribute("aria-valuetext", `${b ? `${b.kind === "link" ? `${m.from.find((x) => x.id === b.from).name} → ${m.to.find((x) => x.id === b.to).name}` : b.name}: ` : ""}${value === null ? "?" : f.num(value)}${value !== null && m.unit ? ` ${m.unit}` : ""}`);
		}
	}
	// What a side's ends add up to: the whole the big number shows, "?" while one end is not known.
	function sumOf(all) {
		// the band for what is not accounted for is no end of the company's own
		const nodes = all.filter((n) => !n.rest);
		if (nodes.some((n) => n.value === null)) return { value: null, state: "unknown" };
		return { value: nodes.reduce((t, n) => t + n.value, 0), state: nodes.some((n) => n.state === "assumed") ? "assumed" : "known" };
	}

	function setPick(i) {
		if (i === ui.pick) return;
		ui.pick = i;
		paint();
	}
	function bindStage(stage) {
		const at = (e) => {
			const el = e.target && e.target.closest ? e.target.closest("[data-k]") : null;
			return el ? Number(el.getAttribute("data-k")) : null;
		};
		stage.addEventListener("pointermove", (e) => {
			if (e.pointerType === "touch" && !e.isPrimary) return;
			setPick(at(e));
		});
		stage.addEventListener("pointerdown", (e) => setPick(at(e)));
		// a finger that lifts leaves what it picked (a tap is how a phone picks; the touch ends before the focus comes),
		// a pointer that leaves takes it away
		stage.addEventListener("pointerleave", (e) => {
			if (e.pointerType !== "touch") setPick(null);
		});
		stage.addEventListener("blur", () => setPick(null));
		stage.addEventListener("keydown", (e) => {
			const n = ui.bands.length;
			let next = null;
			if (e.key === "ArrowRight" || e.key === "ArrowDown") next = ui.pick === null ? 0 : Math.min(n - 1, ui.pick + 1);
			else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = ui.pick === null ? n - 1 : Math.max(0, ui.pick - 1);
			else if (e.key === "Home") next = 0;
			else if (e.key === "End") next = n - 1;
			else if (e.key === "Escape") {
				setPick(null);
				return;
			}
			if (next === null || !n) return;
			e.preventDefault();
			setPick(next);
		});
	}

	// ---------------------------------------------------------------- size changes
	let resizeFrame = 0;
	function onResize() {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!ui.model || !ui.stage || !ui.root) return;
			const W = ui.stage.clientWidth;
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
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "flow.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			if (txt === lastText && ui.root) return;
			raw = JSON.parse(txt);
			const next = normalize(raw);
			const first = !ui.shown;
			const keep = ui.pick;
			ui.model = next;
			ui.bands = bandsOf(next);
			ui.pick = keep !== null && keep < ui.bands.length ? keep : null;
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
