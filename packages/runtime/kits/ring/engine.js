// The ring kit's engine: "When is it?"
// A year, a month or a week as one ring: its months or days as soft segments round it, the part gone by a shade
// darker, a hand at now, marks for a point in time (a deadline, a launch, a payday) and wedges for a stretch (a
// campaign, a holiday, a busy season). Wedges with amounts reach out as far as their amount. The middle holds one big
// thing: the next one and how far off it is, or a number. A member runs a finger or the pointer round the ring (or the
// arrow keys) and the middle follows. The agent writes only ring.json (see KIT.md). Plain ES2020, one IIFE, no network,
// colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const SVGNS = "http://www.w3.org/2000/svg";
	const MAX = { title: 40, line: 60, name: 24, unit: 8, label: 24, word: 28, marks: 12, wedges: 8 };
	const WORDS = {
		days: "days",
		day: "day",
		today: "today",
		to: "to {name}",
		left: "left of {name}",
		ago: "{n} days ago",
		assumed: "assumed",
		unknown: "not known",
		empty: "Nothing to show yet.",
		source: "Source",
	};
	const SPANS = ["year", "month", "week"];
	const STATES = ["known", "assumed", "unknown"];
	const TONES = ["accent", "good", "warm", "warn", "bad", "violet", "teal"];
	const DAY = 86400000;
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.rk{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --rk-ease:cubic-bezier(.22,.8,.24,1);--rk-warm:color-mix(in srgb,var(--q-bad) 70%,var(--q-warn))}
.rk *,.rk *::before,.rk *::after{box-sizing:border-box}
.rk-head{min-width:0;max-width:40em;margin-bottom:clamp(8px,2vh,22px)}
.rk-title-row{display:flex;align-items:baseline;gap:8px}
.rk-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.rk-src{display:inline-grid;place-items:center;min-width:24px;min-height:24px;font-size:14px;color:var(--q-muted);text-decoration:none;border-radius:6px}
.rk-src:hover{color:var(--q-accent)}
.rk-src:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.rk-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.rk--bare{padding:clamp(12px,1vw,16px)}
.rk--bare .rk-head{display:none}
.rk-stage{position:relative;flex:none;outline:none;touch-action:pan-y;border-radius:50%;cursor:pointer}
.rk-stage:focus-visible{box-shadow:0 0 0 2px var(--q-accent)}
.rk-stage svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;max-width:none}
.rk-seg{fill:color-mix(in srgb,var(--q-text) 5%,var(--q-bg))}
.rk-seg.gone{fill:color-mix(in srgb,var(--q-text) 10%,var(--q-bg))}
.rk-tick{font-size:13px;fill:var(--q-muted);text-anchor:middle;dominant-baseline:central}
.rk-tick.now{fill:var(--q-text);font-weight:700}
.rk-wedge{fill:color-mix(in srgb,var(--rk-tone) 34%,var(--q-bg));transition:opacity .2s}
.rk-wedge.a{fill:color-mix(in srgb,var(--rk-tone) 12%,var(--q-bg));stroke:color-mix(in srgb,var(--rk-tone) 60%,var(--q-bg));stroke-width:2;stroke-dasharray:6 6}
.rk-wedge.unk{fill:none;stroke:color-mix(in srgb,var(--q-text) 26%,var(--q-bg));stroke-width:2.5;stroke-dasharray:6 8}
.rk-q{font-size:22px;font-weight:600;fill:var(--q-muted);text-anchor:middle;dominant-baseline:central}
.rk-mark{fill:var(--q-bg);stroke:var(--q-text);stroke-width:3;transform-box:fill-box;transform-origin:center;transition:opacity .2s,transform .2s var(--rk-ease)}
.rk-mark.gone{fill:color-mix(in srgb,var(--q-text) 78%,var(--q-bg));stroke:none}
.rk-mark.toned{stroke:var(--rk-tone)}
.rk-mark.gone.toned{fill:color-mix(in srgb,var(--rk-tone) 70%,var(--q-bg))}
.rk-mark.next{fill:var(--rk-tone);stroke:var(--q-bg);stroke-width:3;transform:scale(1.45)}
.rk-halo{fill:none;stroke:var(--rk-tone);stroke-width:3;stroke-opacity:.35}
.rk.picking .rk-item:not(.on){opacity:.42}
.rk-hand{stroke:var(--q-text);stroke-width:3;stroke-linecap:round}
.rk-hand-dot{fill:var(--q-text);stroke:var(--q-bg);stroke-width:3}
.rk-mid{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;text-align:center;pointer-events:none;max-width:var(--rk-mid-w,260px)}
.rk-row{display:flex;align-items:baseline;justify-content:center;gap:.24em;white-space:nowrap}
.rk-n{font-size:var(--rk-n,64px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums;color:var(--rk-big,var(--q-text))}
.rk-n.unk{color:var(--q-muted)}
.rk-u{font-size:calc(var(--rk-n,64px) * .36);font-weight:600;letter-spacing:-.01em;color:var(--q-muted)}
.rk-what{margin-top:8px;max-width:100%;font-size:15px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-when{margin-top:2px;max-width:100%;font-size:13px;line-height:1.3;color:var(--q-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rk-tag{display:inline-flex;align-items:center;height:20px;margin-top:6px;padding:0 8px;border-radius:999px;border:1.3px dashed color-mix(in srgb,var(--q-muted) 70%,transparent);font-size:12px;font-weight:550;color:var(--q-muted)}
.rk-quiet{margin:0;font-size:15px;color:var(--q-muted)}
.rk.intro .rk-segs{animation:rk-fade .7s var(--rk-ease) both}
.rk.intro .rk-wedges{animation:rk-grow .9s var(--rk-ease) .15s both;transform-box:view-box;transform-origin:50% 50%}
.rk.intro .rk-marks{animation:rk-fade .6s var(--rk-ease) .5s both}
.rk.intro .rk-hand-g{animation:rk-fade .5s var(--rk-ease) .7s both}
.rk.intro .rk-mid{animation:rk-fade .6s var(--rk-ease) .3s both}
@keyframes rk-fade{from{opacity:0}to{opacity:1}}
@keyframes rk-grow{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.rk *,.rk *::before,.rk *::after{transition:none!important;animation:none!important}}
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
	function toneVar(tone) {
		if (tone === "warm") return "var(--rk-warm)";
		if (tone === "violet") return "color-mix(in srgb,var(--q-accent) 55%,var(--q-bad))";
		if (tone === "teal") return "color-mix(in srgb,var(--q-good) 60%,var(--q-accent))";
		return `var(--q-${tone})`;
	}

	// The page's own element: it takes the place of the one before and leaves the rest of the body (the pictures the
	// page names in #kit-media) where it is.
	function show(main) {
		for (const old of D.querySelectorAll("body > main.rk")) old.remove();
		D.body.append(main);
	}

	// ---------------------------------------------------------------- dates
	// A date is a day: noon of it in the page's own time, so a change of summer time moves no day.
	function parseDate(v) {
		const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
		if (!m) return null;
		const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
		return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
	}
	const noon = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
	// The day's number, the same for every hour of it and in every time zone, and the day of a number.
	const dayNo = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
	const fromNo = (n) => {
		const u = new Date(n * DAY);
		return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12);
	};

	// The ring's span: the year, month or week that holds `start`, or that holds today when the data gives none. A year
	// or a month may start on any day (a year from July is a business year); a week given no start starts on a Monday.
	function spanOf(kind, start, today) {
		let a;
		if (start) a = start;
		else if (kind === "year") a = new Date(today.getFullYear(), 0, 1, 12);
		else if (kind === "month") a = new Date(today.getFullYear(), today.getMonth(), 1, 12);
		else a = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7), 12);
		const step = (k) =>
			kind === "year"
				? new Date(a.getFullYear(), a.getMonth() + k, a.getDate(), 12)
				: kind === "month"
					? new Date(a.getFullYear(), a.getMonth(), a.getDate() + k, 12)
					: new Date(a.getFullYear(), a.getMonth(), a.getDate() + k, 12);
		const end = kind === "year" ? step(12) : kind === "month" ? new Date(a.getFullYear(), a.getMonth() + 1, a.getDate(), 12) : step(7);
		const first = dayNo(a);
		const days = dayNo(end) - first;
		// the segments round the ring: a year's months, a month's or a week's days
		const segs = [];
		if (kind === "year") for (let k = 0; k < 12; k++) segs.push({ from: dayNo(step(k)) - first, to: dayNo(step(k + 1)) - first, at: step(k) });
		else for (let k = 0; k < days; k++) segs.push({ from: k, to: k + 1, at: step(k) });
		return { kind, first, days, segs };
	}

	// ---------------------------------------------------------------- data
	function valueOf(raw) {
		const value = num(raw.value);
		const given = raw.value !== undefined && raw.value !== null;
		const state = STATES.includes(raw.state) ? raw.state : given ? (value === null ? "unknown" : "known") : null;
		// no value at all: the thing has none to show (a date only); a value nobody knows: "?"
		return state === null ? { value: null, state: null } : { value: state === "unknown" ? null : value, state };
	}
	function normalize(raw, clock) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...WORDS };
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const kind = SPANS.includes(raw.span) ? raw.span : "year";
		const given = parseDate(raw.now);
		const today = given || noon(clock);
		const span = spanOf(kind, parseDate(raw.start), today);
		const items = [];
		const tone = (t, fallback) => (TONES.includes(t) ? t : fallback);
		let order = 0;
		for (const m of list(raw.marks)) {
			if (!isObj(m) || items.filter((i) => i.kind === "mark").length >= MAX.marks) continue;
			const at = parseDate(m.at);
			if (!at) continue;
			const k = dayNo(at) - span.first;
			if (k < 0 || k >= span.days) continue;
			items.push({ kind: "mark", name: cut(m.name, MAX.name), from: k, to: k, date: at, tone: tone(m.tone, null), order: order++, ...valueOf(m) });
		}
		let wedges = 0;
		for (const w of list(raw.wedges)) {
			if (!isObj(w) || wedges >= MAX.wedges) continue;
			const a = parseDate(w.from);
			const b = parseDate(w.to) || a;
			if (!a || !b) continue;
			let from = dayNo(a) - span.first;
			let to = dayNo(b) - span.first;
			if (to < from) [from, to] = [to, from];
			if (to < 0 || from >= span.days) continue;
			wedges++;
			items.push({
				kind: "wedge",
				name: cut(w.name, MAX.name),
				from: Math.max(0, from),
				to: Math.min(span.days - 1, to),
				date: fromNo(span.first + Math.max(0, from)),
				end: fromNo(span.first + Math.min(span.days - 1, to)),
				tone: tone(w.tone, null),
				order: order++,
				...valueOf(w),
			});
		}
		items.sort((x, y) => x.from - y.from || x.to - y.to || x.order - y.order);
		// tones: a wedge without one takes the next of a few soft ones, a mark keeps the plain ink
		const soft = ["warm", "good", "violet", "teal", "accent"];
		let next = 0;
		for (const i of items) if (!i.tone) i.tone = i.kind === "wedge" ? soft[next++ % soft.length] : "accent";
		let centre = null;
		if (isObj(raw.centre)) {
			const v = valueOf(raw.centre);
			if (v.state !== null) centre = { ...v, unit: cut(raw.centre.unit, MAX.unit), label: cut(raw.centre.label, MAX.label) };
		}
		const source = typeof raw.source === "string" && /^(?:https:\/\/|folder:)/.test(raw.source) ? raw.source : "";
		return {
			lang,
			words,
			kind,
			span,
			fixed: given !== null,
			today: dayNo(today) - span.first,
			title: cut(raw.title, MAX.title),
			line: cut(raw.line, MAX.line),
			unit: cut(raw.unit, MAX.unit),
			items,
			centre,
			source,
		};
	}

	// ---------------------------------------------------------------- numbers and dates in words
	function formats(m) {
		const pick = (make, fallback) => {
			try {
				return make(m.lang);
			} catch {
				return make(fallback);
			}
		};
		const all = m.items.map((i) => i.value).concat(m.centre ? [m.centre.value] : []).filter((v) => v !== null);
		const span = all.length ? Math.max(...all.map(Math.abs)) : 0;
		const nf = pick((l) => new Intl.NumberFormat(l, { maximumFractionDigits: span >= 100 ? 0 : span >= 10 ? 1 : 2 }), "en");
		const df = pick((l) => new Intl.DateTimeFormat(l, m.kind === "week" ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" }), "en");
		const month = pick((l) => new Intl.DateTimeFormat(l, { month: "short" }), "en");
		const letter = pick((l) => new Intl.DateTimeFormat(l, { month: "narrow" }), "en");
		const weekday = pick((l) => new Intl.DateTimeFormat(l, { weekday: "short" }), "en");
		const weekletter = pick((l) => new Intl.DateTimeFormat(l, { weekday: "narrow" }), "en");
		return {
			num: (v) => nf.format(v),
			date: (d) => df.format(d),
			month: (d, narrow) => (narrow ? letter : month).format(d).replace(/\.$/, ""),
			weekday: (d, narrow) => (narrow ? weekletter : weekday).format(d).replace(/\.$/, ""),
		};
	}

	const fmt = (m) => m.f || (m.f = formats(m));

	// What the middle says of a thing: the big part (a number and its unit, or a word), what it is, and when.
	function describe(m, i, f) {
		const when = i.kind === "wedge" && i.to > i.from ? `${f.date(i.date)} – ${f.date(i.end)}` : f.date(i.date);
		const days = (n) => (n === 1 ? m.words.day : m.words.days);
		if (i.state !== null) {
			return {
				big: i.value === null ? "?" : f.num(i.value),
				unit: i.value === null ? "" : m.unit,
				what: i.name,
				when,
				state: i.state,
				tone: i.tone,
			};
		}
		const t = m.today;
		if (i.from > t) {
			const n = i.from - t;
			return { big: f.num(n), unit: days(n), what: say(m.words.to, { name: i.name }), when, state: null, tone: i.tone };
		}
		if (i.kind === "mark" && i.from === t) return { big: m.words.today, unit: "", what: i.name, when, state: null, tone: i.tone, word: true };
		if (i.kind === "wedge" && i.to >= t) {
			const n = i.to - t + 1;
			return { big: f.num(n), unit: days(n), what: say(m.words.left, { name: i.name }), when, state: null, tone: i.tone };
		}
		const ago = t - i.to;
		return { big: f.date(i.kind === "wedge" ? i.end : i.date), unit: "", what: i.name, when: say(m.words.ago, { n: f.num(ago) }), state: null, tone: i.tone, word: true };
	}

	// The thing the middle shows when nobody points: the next mark (today's included) or the next wedge to begin, else
	// a wedge going on now.
	function nextIndex(m) {
		const t = m.today;
		const ahead = m.items.findIndex((i) => (i.kind === "mark" ? i.from >= t : i.from > t));
		if (ahead >= 0) return ahead;
		return m.items.findIndex((i) => i.kind === "wedge" && i.from <= t && i.to >= t);
	}

	// ---------------------------------------------------------------- page
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "ring" }, CSS);
		D.head.append(style);
	}
	const ui = { model: null, root: null, stage: null, mid: null, pick: null, geo: null, width: 0, shown: false };

	function quiet(line) {
		ensureStyle();
		show(h("main", `rk${BARE ? " rk--bare" : ""}`, null, h("p", "rk-quiet", null, line)));
		ui.root = null;
	}

	function render(intro) {
		const m = ui.model;
		ensureStyle();
		D.documentElement.lang = m.lang;
		const root = h("main", `rk${BARE ? " rk--bare" : ""}${intro && !still() ? " intro" : ""}`, { lang: m.lang });
		const title = h("div", "rk-title-row", null, h("h1", "rk-title", null, m.title || ""));
		if (m.source) title.append(h("a", "rk-src", { href: m.source, title: m.words.source, "aria-label": m.words.source }, "↗"));
		root.append(h("header", "rk-head", null, title, m.line ? h("p", "rk-line", null, m.line) : null));
		const stage = h("div", "rk-stage", { tabindex: "0", role: "slider", "aria-label": m.title || m.words.today, "aria-valuemin": "0", "aria-valuemax": String(Math.max(0, m.items.length - 1)) });
		const mid = h("div", "rk-mid", { "aria-live": "polite" });
		stage.append(mid);
		root.append(stage);
		show(root);
		ui.root = root;
		ui.stage = stage;
		ui.mid = mid;
		bindStage(stage);
		draw();
		if (intro) setTimeout(() => root.classList.remove("intro"), 2000);
	}

	function size() {
		const stage = ui.stage;
		const W = Math.max(260, (stage.parentElement && stage.parentElement.clientWidth) || stage.clientWidth || 0);
		const pad = ui.root ? (Number.parseFloat(getComputedStyle(ui.root).paddingLeft) || 0) * 2 : 0;
		const inner = Math.max(260, W - pad);
		const top = stage.getBoundingClientRect ? stage.getBoundingClientRect().top + (window.scrollY || 0) : 0;
		const bottom = ui.root ? Number.parseFloat(getComputedStyle(ui.root).paddingBottom) || 24 : 24;
		const avail = (window.innerHeight || 800) - top - bottom;
		const S = Math.round(Math.max(280, Math.min(inner, avail > 280 ? avail : inner, 820)));
		return { S };
	}

	// An arc band between two radii, from one angle to another (radians, 0 at the top, clockwise).
	function band(cx, cy, r0, r1_, a0, a1) {
		const pt = (r, a) => `${r1(cx + r * Math.sin(a))} ${r1(cy - r * Math.cos(a))}`;
		const big = a1 - a0 > Math.PI ? 1 : 0;
		if (a1 - a0 >= Math.PI * 2 - 1e-6) {
			const mid = a0 + Math.PI;
			return `M${pt(r1_, a0)}A${r1_} ${r1_} 0 1 1 ${pt(r1_, mid)}A${r1_} ${r1_} 0 1 1 ${pt(r1_, a0)}M${pt(r0, a0)}A${r0} ${r0} 0 1 0 ${pt(r0, mid)}A${r0} ${r0} 0 1 0 ${pt(r0, a0)}Z`;
		}
		return `M${pt(r1_, a0)}A${r1_} ${r1_} 0 ${big} 1 ${pt(r1_, a1)}L${pt(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${pt(r0, a0)}Z`;
	}

	function draw() {
		const m = ui.model;
		const stage = ui.stage;
		if (!m || !stage) return;
		const { S } = size();
		stage.style.width = `${S}px`;
		stage.style.height = `${S}px`;
		stage.style.marginLeft = "auto";
		stage.style.marginRight = "auto";
		ui.width = S;
		const f = fmt(m);
		const c = S / 2;
		const small = S < 460;
		const margin = small ? 26 : 36;
		const outer = c - margin;
		const values = m.items.filter((i) => i.kind === "wedge" && i.value !== null).map((i) => i.value);
		const rose = values.length > 0;
		const T = Math.max(14, Math.min(34, S * 0.05));
		// the track's middle: with amounts the wedges reach out from it, so it sits further in
		const R = rose ? outer * 0.6 : outer - T / 2 - 6;
		const rin = R - T / 2;
		const rout = R + T / 2;
		const days = m.span.days;
		const ang = (k) => (k / days) * Math.PI * 2;
		const svg = s("svg", { viewBox: `0 0 ${S} ${S}`, width: S, height: S, "aria-hidden": "true" });

		// the segments, the ones gone by a shade darker, and their names outside
		const segs = s("g", { class: "rk-segs" });
		const ticks = s("g");
		const gap = Math.min(0.012, (Math.PI * 2) / days / 6);
		// the names of the months or days stand outside the ring, beyond the longest wedge
		const tickR = rose ? outer + (small ? 13 : 18) : rout + (small ? 14 : 20);
		const narrow = (2 * Math.PI * tickR) / m.span.segs.length < 46;
		for (const g of m.span.segs) {
			const gone = g.to <= m.today;
			segs.append(s("path", { class: `rk-seg${gone ? " gone" : ""}`, d: band(c, c, rin, rout, ang(g.from) + gap, ang(g.to) - gap) }));
			let label = "";
			if (m.kind === "year") label = f.month(g.at, narrow);
			else if (m.kind === "week") label = f.weekday(g.at, narrow);
			else if (g.at.getDate() === 1 || g.at.getDate() % 5 === 0 || (g.from <= m.today && m.today < g.to)) label = String(g.at.getDate());
			if (!label) continue;
			const a = ang((g.from + g.to) / 2);
			const now = g.from <= m.today && m.today < g.to;
			ticks.append(s("text", { class: `rk-tick${now ? " now" : ""}`, x: r1(c + tickR * Math.sin(a)), y: r1(c - tickR * Math.cos(a)) }, label));
		}

		// the wedges: on the track, or reaching out as far as their amount
		const wedges = s("g", { class: "rk-wedges" });
		const marks = s("g", { class: "rk-marks" });
		const most = rose ? Math.max(...values.map(Math.abs), 1) : 1;
		const els = [];
		const base = Math.max(6, Math.min(11, T * 0.34));
		let prevMark = null;
		let shift = 1;
		m.items.forEach((i, idx) => {
			const g = s("g", { class: "rk-item" });
			g.style.setProperty("--rk-tone", toneVar(i.tone));
			if (i.kind === "wedge") {
				const a0 = ang(i.from) + gap;
				const a1 = ang(i.to + 1) - gap;
				let r0 = rin - 3;
				let r2 = rout + 3;
				if (rose) {
					r0 = rin;
					// as far out as its amount, from the inner edge, so a day of half the sales reaches half as far
					r2 = i.value === null ? rin + (outer - rin) * 0.55 : rin + Math.max(T * 0.5, (outer - rin) * (Math.abs(i.value) / most));
				}
				const cls = i.state === "unknown" ? " unk" : i.state === "assumed" ? " a" : "";
				g.append(s("path", { class: `rk-wedge${cls}`, d: band(c, c, r0, r2, a0, Math.max(a1, a0 + 0.004)) }));
				if (i.state === "unknown") {
					const am = (a0 + a1) / 2;
					const rq = (r0 + r2) / 2;
					g.append(s("text", { class: "rk-q", x: r1(c + rq * Math.sin(am)), y: r1(c - rq * Math.cos(am)) }, "?"));
				}
				wedges.append(g);
			} else {
				const a = ang(i.from + 0.5);
				// marks so close they would cover each other step a little in and out of the track's middle
				let r = R;
				if (prevMark !== null && Math.abs(a - prevMark.a) * R < base * 2.4) {
					r = prevMark.r === R ? R + shift * Math.min(T * 0.5, base * 1.3) : R;
					shift = -shift;
				}
				prevMark = { a, r };
				const cx = c + r * Math.sin(a);
				const cy = c - r * Math.cos(a);
				const gone = i.from < m.today;
				const toned = i.tone !== "accent";
				g.append(s("circle", { class: `rk-halo`, cx: r1(cx), cy: r1(cy), r: r1(base * 2.1), opacity: 0 }));
				g.append(s("circle", { class: `rk-mark${gone ? " gone" : ""}${toned ? " toned" : ""}`, cx: r1(cx), cy: r1(cy), r: r1(base) }));
				marks.append(g);
			}
			els[idx] = g;
		});

		// now: a hand from the middle's edge out to the track, and a dot on it
		const hand = s("g", { class: "rk-hand-g" });
		if (m.today >= 0 && m.today < days) {
			const frac = m.fixed ? 0.5 : (() => {
				const t = new Date();
				return (t.getHours() * 60 + t.getMinutes()) / 1440;
			})();
			const a = ang(m.today + frac);
			ui.handAngle = a;
			const line = s("line", { class: "rk-hand" });
			hand.append(line, s("circle", { class: "rk-hand-dot", cx: r1(c + R * Math.sin(a)), cy: r1(c - R * Math.cos(a)), r: r1(Math.max(5, T * 0.22)) }));
			ui.hand = { line, a, c, end: rin - 4 };
		} else {
			ui.hand = null;
		}

		svg.append(segs, ticks, wedges, hand, marks);
		ui.mid.style.setProperty("--rk-mid-w", `${Math.round(rin * 1.5)}px`);
		ui.mid.style.setProperty("--rk-n", `${Math.round(Math.max(34, Math.min(76, rin * 0.3)))}px`);
		stage.replaceChildren(svg, ui.mid);
		ui.svg = svg;
		ui.els = els;
		ui.geo = { c, R, rin, rout, outer, days, T, ang };
		paint();
	}

	// The middle, the picked thing's halo, the hand's length (clear of the middle's words) and what a reader hears.
	function paint() {
		const m = ui.model;
		if (!m || !ui.mid) return;
		const f = fmt(m);
		const at = ui.pick !== null ? ui.pick : nextIndex(m);
		let d;
		if (ui.pick === null && m.centre) {
			d = {
				big: m.centre.value === null ? "?" : f.num(m.centre.value),
				unit: m.centre.value === null ? "" : m.centre.unit || m.unit,
				what: m.centre.label,
				when: "",
				state: m.centre.state,
				tone: null,
			};
		} else if (at >= 0) d = describe(m, m.items[at], f);
		else d = { big: f.date(fromNo(m.span.first + Math.max(0, Math.min(m.span.days - 1, m.today)))), unit: "", what: m.words.today, when: "", state: null, tone: null, word: true };
		const n = h("span", `rk-n${d.big === "?" ? " unk" : ""}`, null, d.big);
		if (d.word) n.style.fontSize = "calc(var(--rk-n,64px) * .62)";
		if (d.tone && d.big !== "?") n.style.setProperty("--rk-big", `color-mix(in srgb,${toneVar(d.tone)} 82%,var(--q-text))`);
		const row = h("div", "rk-row", null, n, d.unit ? h("span", "rk-u", null, d.unit) : null);
		const kids = [row];
		if (d.what) kids.push(h("div", "rk-what", null, d.what));
		if (d.when) kids.push(h("div", "rk-when", null, d.when));
		if (d.state === "assumed") kids.push(h("span", "rk-tag", null, m.words.assumed));
		if (d.state === "unknown" && d.big === "?") kids.push(h("span", "rk-tag", null, m.words.unknown));
		ui.mid.replaceChildren(...kids);
		// the thing the middle speaks of stands out; while one is picked the others step back
		if (ui.root) ui.root.classList.toggle("picking", ui.pick !== null);
		(ui.els || []).forEach((g, idx) => {
			const on = idx === at && (ui.pick !== null || !m.centre);
			g.classList.toggle("on", on);
			const halo = g.querySelector(".rk-halo");
			if (halo) halo.setAttribute("opacity", on ? "1" : "0");
			const mark = g.querySelector(".rk-mark");
			if (mark) mark.classList.toggle("next", on);
		});
		if (ui.hand) {
			// from just outside the middle's words, along the hand's angle, to the track
			const box = ui.mid.getBoundingClientRect ? ui.mid.getBoundingClientRect() : null;
			const hw = box && box.width ? box.width / 2 + 12 : ui.geo.rin * 0.45;
			const hh = box && box.height ? box.height / 2 + 10 : ui.geo.rin * 0.3;
			const sx = Math.abs(Math.sin(ui.hand.a)) || 1e-6;
			const cy = Math.abs(Math.cos(ui.hand.a)) || 1e-6;
			const from = Math.min(hw / sx, hh / cy, ui.hand.end - 18);
			const { c, a, end, line } = ui.hand;
			line.setAttribute("x1", r1(c + from * Math.sin(a)));
			line.setAttribute("y1", r1(c - from * Math.cos(a)));
			line.setAttribute("x2", r1(c + end * Math.sin(a)));
			line.setAttribute("y2", r1(c - end * Math.cos(a)));
		}
		if (ui.stage) {
			ui.stage.setAttribute("aria-valuenow", String(Math.max(0, at)));
			ui.stage.setAttribute("aria-valuetext", [`${d.big}${d.unit ? ` ${d.unit}` : ""}`, d.what, d.when].filter(Boolean).join(", "));
		}
	}

	function setPick(i) {
		if (i === ui.pick) return;
		ui.pick = i;
		paint();
	}
	// The thing under a finger or the pointer: a mark near its angle, else the wedge it is in, else none.
	function pickAt(clientX, clientY) {
		const g = ui.geo;
		const m = ui.model;
		if (!g || !m) return null;
		const box = ui.stage.getBoundingClientRect();
		const x = clientX - box.left - g.c;
		const y = clientY - box.top - g.c;
		const dist = Math.hypot(x, y);
		if (dist < g.rin * 0.55 || dist > g.outer + 30) return null;
		let a = Math.atan2(x, -y);
		if (a < 0) a += Math.PI * 2;
		const k = (a / (Math.PI * 2)) * g.days;
		const near = Math.max(g.days / 40, 0.6);
		let best = null;
		let gap = Infinity;
		m.items.forEach((i, idx) => {
			if (i.kind !== "mark") return;
			let d = Math.abs(i.from + 0.5 - k);
			d = Math.min(d, g.days - d);
			if (d < near && d < gap) {
				gap = d;
				best = idx;
			}
		});
		if (best !== null) return best;
		const inside = m.items.findIndex((i) => i.kind === "wedge" && k >= i.from && k < i.to + 1);
		return inside >= 0 ? inside : null;
	}
	function bindStage(stage) {
		stage.addEventListener("pointermove", (e) => {
			if (e.pointerType === "touch" && !e.isPrimary) return;
			setPick(pickAt(e.clientX, e.clientY));
		});
		stage.addEventListener("pointerdown", (e) => setPick(pickAt(e.clientX, e.clientY)));
		// a finger that lifts leaves what it picked (a tap is how a phone picks; the touch ends before the focus comes),
		// a pointer that leaves takes it away
		stage.addEventListener("pointerleave", (e) => {
			if (e.pointerType !== "touch") setPick(null);
		});
		stage.addEventListener("blur", () => setPick(null));
		stage.addEventListener("keydown", (e) => {
			const m = ui.model;
			const n = m.items.length;
			if (!n) return;
			// from what the middle shows: the picked thing, or the next one when the middle speaks of it
			const base = ui.pick !== null ? ui.pick : nextIndex(m);
			const shown = ui.pick !== null || (!m.centre && base >= 0);
			let next = null;
			if (e.key === "ArrowRight" || e.key === "ArrowDown") next = base < 0 ? 0 : shown ? Math.min(n - 1, base + 1) : base;
			else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = base < 0 ? n - 1 : Math.max(0, base - 1);
			else if (e.key === "Home") next = 0;
			else if (e.key === "End") next = n - 1;
			else if (e.key === "Escape") {
				setPick(null);
				return;
			}
			if (next === null) return;
			e.preventDefault();
			setPick(next);
		});
	}

	// ---------------------------------------------------------------- size changes and the clock
	let resizeFrame = 0;
	function onResize() {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!ui.model || !ui.stage || !ui.root) return;
			const { S } = size();
			if (S === ui.width) return;
			draw();
		});
	}
	window.addEventListener("resize", onResize);

	// ---------------------------------------------------------------- loading
	let lastRead = 0;
	let pending = 0;
	let lastText = null;
	let lastDay = null;
	async function load() {
		lastRead = Date.now();
		let txt;
		let raw = null;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			// the page puts the company's live values in place of the data's bindings
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "ring.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			const day = dayNo(new Date());
			if (txt === lastText && day === lastDay && ui.root) return;
			raw = JSON.parse(txt);
			const next = normalize(raw, new Date());
			const first = !ui.shown;
			const keep = ui.pick;
			ui.model = next;
			ui.pick = keep !== null && keep < next.items.length ? keep : null;
			lastText = txt;
			lastDay = day;
			render(first);
			ui.shown = true;
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
	// the hand moves with the clock: once a minute it is drawn again where it now points, and a new day reads anew
	let tick = 0;
	function onTick() {
		clearTimeout(tick);
		tick = setTimeout(() => {
			if (ui.model && !ui.model.fixed && ui.root) {
				if (dayNo(new Date()) !== lastDay) onChange();
				else draw();
			}
			onTick();
		}, 60000);
	}
	function start() {
		ensureStyle();
		load();
		onTick();
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
