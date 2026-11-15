// The shelf kit's engine: "How do our things stand?"
// The company's real things side by side on one shelf, each as a big picture with one level behind it: a soft colour
// block whose height is the level, the number that matters under it (warm when it is low), and an agent's one-line note
// on the thing that needs one. Without levels it is a gallery: finished things, framed, with the maker's figure. A
// member taps a thing to see it larger, with its note, its source and a button for a note to the app's owner.
// The agent writes only shelf.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const MAX = { title: 40, line: 60, name: 24, unit: 12, note: 60, by: 24, word: 40, things: 8 };
	const WORDS = {
		low: "low",
		assumed: "assumed",
		unknown: "not known",
		close: "Close",
		source: "Source",
		empty: "Nothing to show yet.",
		// a note to the app's owner: the button's label, naming the agent ("Ask Luna"), and what it says once sent
		tell: "",
		told: "",
	};
	const STATES = ["known", "assumed", "unknown"];
	const TONES = ["good", "accent", "violet", "teal", "warn"];
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.sh{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --sh-ease:cubic-bezier(.22,.8,.24,1);--sh-warm:color-mix(in srgb,var(--q-bad) 70%,var(--q-warn));--sh-shade:rgb(from var(--q-bg) calc(r*.3) calc(g*.3) calc(b*.32)/.32)}
.sh *,.sh *::before,.sh *::after{box-sizing:border-box}
.sh-head{min-width:0;max-width:40em}
.sh-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.sh-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.sh--bare{padding:clamp(12px,1vw,16px)}
.sh--bare .sh-head{display:none}
.sh-shelf{flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;gap:clamp(28px,5vh,56px);padding:clamp(12px,3vh,36px) 0 clamp(8px,2vh,20px)}
.sh-row{position:relative;display:grid;grid-template-columns:repeat(var(--sh-cols),minmax(0,var(--sh-w)));justify-content:center;column-gap:clamp(12px,2.4vw,40px)}
.sh-row.planked::before{content:"";position:absolute;left:max(-16px,calc(var(--sh-pad) * -1));right:max(-16px,calc(var(--sh-pad) * -1));top:var(--sh-scene);height:12px;border-radius:6px;background:color-mix(in srgb,var(--q-text) 11%,var(--q-bg));box-shadow:0 7px 0 -2px color-mix(in srgb,var(--q-text) 6%,var(--q-bg))}
.sh .sh-thing{position:relative;display:flex;flex-direction:column;align-items:center;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:center;cursor:pointer;border-radius:22px}
.sh .sh-thing:focus-visible{outline:2px solid var(--q-accent);outline-offset:6px}
.sh-scene{position:relative;display:block;width:100%;height:var(--sh-scene)}
.sh-level{position:absolute;left:7%;right:7%;bottom:0;display:block;border-radius:28px 28px 0 0;background:color-mix(in srgb,var(--sh-tone) 17%,var(--q-bg));transform-origin:50% 100%;transition:height .6s var(--sh-ease)}
.sh-level.low{background:color-mix(in srgb,var(--sh-warm) 19%,var(--q-bg))}
.sh-level.a{background:transparent;border:2px dashed color-mix(in srgb,var(--sh-tone) 45%,var(--q-bg));border-bottom:0}
.sh-level.unk{left:14%;right:14%;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--q-text) 7%,transparent) 0 2px,transparent 2px 9px);border:2px dashed color-mix(in srgb,var(--q-text) 22%,var(--q-bg));border-bottom:0}
.sh-level.unk::after{content:"?";position:absolute;left:0;right:0;top:12px;font-size:24px;font-weight:600;color:var(--q-muted)}
.sh.intro .sh-level{animation:sh-grow .9s var(--sh-ease) both;animation-delay:calc(var(--i) * 60ms + 120ms)}
.sh.intro .sh-pic,.sh.intro .sh-frame{animation:sh-rise .7s var(--sh-ease) both;animation-delay:calc(var(--i) * 60ms)}
.sh.intro .sh-note{animation:sh-rise .6s var(--sh-ease) both;animation-delay:calc(var(--i) * 60ms + 700ms)}
.sh-pic{position:absolute;left:8%;right:8%;bottom:0;height:min(76%,calc(var(--sh-w) * 1.05));display:flex;align-items:flex-end;justify-content:center;transition:transform .35s var(--sh-ease)}
.sh-pic img{max-width:100%;max-height:100%;object-fit:contain;display:block;filter:drop-shadow(0 14px 14px rgb(from var(--q-bg) calc(r*.3) calc(g*.3) calc(b*.32)/.16))}
.sh-ph{display:grid;place-items:center;width:62%;aspect-ratio:3/4;border-radius:16px;border:2px dashed color-mix(in srgb,var(--q-text) 20%,var(--q-bg));color:var(--q-muted);font-size:26px;font-weight:600}
.sh .sh-thing:hover .sh-pic,.sh .sh-thing:focus-visible .sh-pic{transform:translateY(-6px)}
.sh-frame{position:absolute;left:4%;right:4%;top:4%;bottom:0;display:block;border-radius:18px;overflow:hidden;background:color-mix(in srgb,var(--sh-tone) 12%,var(--q-bg));box-shadow:0 20px 44px -18px var(--sh-shade);transition:transform .35s var(--sh-ease)}
.sh-frame img{width:100%;height:100%;object-fit:cover;display:block}
.sh-frame .sh-ph{position:absolute;inset:0;width:auto;aspect-ratio:auto;border:0;border-radius:0}
.sh .sh-thing:hover .sh-frame{transform:translateY(-4px)}
.sh-note{position:absolute;left:50%;bottom:calc(min(76%,calc(var(--sh-w) * 1.05)) + 12px);z-index:2;display:flex;align-items:center;gap:9px;width:max-content;max-width:min(calc(var(--sh-w) + 24px),calc(100vw - 32px));padding:8px 14px 8px 8px;border-radius:16px;background:var(--q-bg);box-shadow:0 0 0 1px color-mix(in srgb,var(--q-text) 7%,transparent),0 12px 26px -10px var(--sh-shade);transform:translateX(-50%);text-align:left}
.sh-note .sh-fig{width:32px;height:32px}
.sh-note span{min-width:0;font-size:14px;font-weight:600;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.sh-fig{flex:none;display:grid;place-items:center;width:28px;height:28px}
.sh-fig img{width:100%;height:100%;object-fit:contain;display:block}
.sh-fig.ini{border-radius:50%;background:color-mix(in srgb,var(--q-accent) 14%,var(--q-bg));font-size:13px;font-weight:650;color:var(--q-accent)}
.sh-num{display:flex;align-items:baseline;justify-content:center;gap:.24em;margin-top:28px;white-space:nowrap;max-width:100%}
.sh-num b{font-size:clamp(28px,3.1vw,42px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.sh-num small{font-size:14px;font-weight:550;color:var(--q-muted);overflow:hidden;text-overflow:ellipsis}
.sh-num.low b{color:var(--sh-warm)}
.sh-num.unk b{color:var(--q-muted)}
.sh-name{display:block;margin-top:6px;max-width:100%;font-size:14px;line-height:1.3;color:var(--q-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh-tag{display:inline-flex;align-items:center;height:18px;margin-left:6px;padding:0 7px;border-radius:999px;border:1.3px dashed var(--q-muted);font-size:11.5px;font-weight:550;color:var(--q-muted);vertical-align:2px}
.sh-tag.low{border:0;background:color-mix(in srgb,var(--sh-warm) 15%,var(--q-bg));color:var(--sh-warm)}
.sh-maker{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;font-size:14px;color:var(--q-muted)}
.sh-row.gallery .sh-num{margin-top:18px}
.sh-quiet{margin:0;font-size:15px;color:var(--q-muted)}
/* a thing opened */
.sh-sheet{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:clamp(12px,4vw,40px);background:color-mix(in srgb,var(--q-bg) 72%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s var(--sh-ease)}
.sh-sheet.is-open{opacity:1}
.sh-card{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);width:min(860px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:24px;background:var(--q-bg);box-shadow:0 0 0 1px color-mix(in srgb,var(--q-text) 8%,transparent),0 30px 80px -30px var(--sh-shade);transform:translateY(10px) scale(.985);transition:transform .35s var(--sh-ease)}
.sh-sheet.is-open .sh-card{transform:none}
.sh-big{position:relative;display:flex;align-items:flex-end;justify-content:center;min-height:360px;padding:36px 28px 0;background:color-mix(in srgb,var(--sh-tone) 13%,var(--q-bg))}
.sh-big.low{background:color-mix(in srgb,var(--sh-warm) 14%,var(--q-bg))}
.sh-big img{max-width:100%;max-height:340px;object-fit:contain;display:block}
.sh-big.framed{padding:0;align-items:stretch}
.sh-big.framed img{width:100%;height:100%;max-height:none;object-fit:cover}
.sh-big .sh-ph{width:46%;margin-bottom:36px}
.sh-info{display:flex;flex-direction:column;gap:14px;padding:34px 32px 28px;min-width:0}
.sh-info h2{margin:0;padding-right:40px;font-size:22px;font-weight:650;line-height:1.25;letter-spacing:-.01em}
.sh-info .sh-num{justify-content:flex-start;margin-top:0}
.sh-info .sh-num b{font-size:clamp(40px,4.4vw,56px)}
.sh-bar{position:relative;height:12px;border-radius:6px;background:color-mix(in srgb,var(--q-text) 7%,var(--q-bg));overflow:hidden}
.sh-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:color-mix(in srgb,var(--sh-tone) 60%,var(--q-bg))}
.sh-bar.low i{background:var(--sh-warm)}
.sh-said{display:flex;align-items:center;gap:12px;font-size:15px;line-height:1.4}
.sh-said .sh-fig{width:40px;height:40px}
.sh-said small{display:block;font-size:13px;color:var(--q-muted)}
.sh-src{align-self:flex-start;font-size:14px;color:var(--q-muted);text-decoration:none}
.sh-src:hover{color:var(--q-accent)}
.sh .sh-x{position:absolute;right:14px;top:14px;z-index:1;display:grid;place-items:center;width:40px;height:40px;padding:0;border:0;border-radius:50%;background:color-mix(in srgb,var(--q-text) 6%,var(--q-bg));color:var(--q-text);cursor:pointer}
.sh .sh-x:hover{background:color-mix(in srgb,var(--q-text) 11%,var(--q-bg))}
.sh .sh-x:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.sh .sh-x svg{width:18px;height:18px}
.sh-tell{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:14px;margin-top:auto;padding-top:6px}
.sh-tell-c{position:relative;align-self:stretch}
.sh .sh-tell-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:40px;min-height:40px;padding:0 16px 0 12px;border:0;border-radius:999px;background:color-mix(in srgb,var(--q-text) 7%,transparent);color:var(--q-text);font-size:14px;font-weight:550;line-height:1.2;cursor:pointer;transition:background .2s,opacity .2s}
.sh .sh-tell-b:hover{background:color-mix(in srgb,var(--q-text) 12%,transparent)}
.sh .sh-tell-b:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.sh .sh-tell-b.sh-bare{padding:0}
.sh .sh-tell-b svg{flex:none;width:17px;height:17px}
.sh .sh-tell-b[aria-busy=true]{opacity:.55;cursor:progress}
.sh .sh-tell-b.sh-told{background:none;color:var(--q-muted);cursor:default;padding-left:4px}
.sh .sh-tell-b.sh-told.sh-bare{padding:0}
.sh .sh-tell-b.sh-told svg{color:var(--q-good)}
.sh-tell-why{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);margin:0;font-size:13px;line-height:1.3;color:var(--q-muted);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}
@keyframes sh-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes sh-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@media (max-width:640px){
 .sh-card{grid-template-columns:1fr}
 .sh-big{min-height:240px}
 .sh-big img{max-height:230px}
 .sh-info{padding:22px 22px 22px}
 .sh-note{padding:6px 10px 6px 6px;gap:7px}
 .sh-note .sh-fig{width:26px;height:26px}
 .sh-note span{font-size:13px}
 .sh-num{margin-top:22px}
}
@media (prefers-reduced-motion:reduce){.sh *,.sh *::before,.sh *::after{transition:none!important;animation:none!important}}
`;

	// ---------------------------------------------------------------- helpers
	const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
	const list = (v) => (Array.isArray(v) ? v : []);
	const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
	function cut(v, n) {
		const chars = Array.from(text(v).replace(/\s+/g, " ").trim());
		return chars.length <= n ? chars.join("") : `${chars.slice(0, n - 1).join("").trimEnd()}…`;
	}
	// a number is a number: a text is shown as written (a live value arrives as a number)
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	function h(tag, cls, attrs, ...kids) {
		const el = D.createElement(tag);
		if (cls) el.className = cls;
		if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, String(attrs[k]));
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
		return el;
	}
	function svg(markup) {
		const el = D.createElementNS("http://www.w3.org/2000/svg", "svg");
		el.setAttribute("viewBox", "0 0 24 24");
		el.setAttribute("aria-hidden", "true");
		el.setAttribute("fill", "none");
		el.setAttribute("stroke", "currentColor");
		el.setAttribute("stroke-width", "2");
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		el.innerHTML = markup;
		return el;
	}
	const esc = (t) => (window.CSS && window.CSS.escape ? window.CSS.escape(t) : String(t).replace(/["\\]/g, "\\$&"));
	function media(path) {
		if (!path) return null;
		return D.querySelector(`#kit-media [data-kit-src="${esc(path)}"]`);
	}
	function toneVar(tone) {
		if (tone === "violet") return "color-mix(in srgb,var(--q-accent) 55%,var(--q-bad))";
		if (tone === "teal") return "color-mix(in srgb,var(--q-good) 60%,var(--q-accent))";
		return `var(--q-${tone})`;
	}
	function picture(path) {
		const found = media(path);
		if (found && found.getAttribute("src")) return h("img", null, { src: found.getAttribute("src"), alt: "", draggable: "false" });
		return h("span", "sh-ph", { "aria-hidden": "true" }, "?");
	}
	function figureEl(id, name) {
		const found = id ? media(`figure:${id}`) : null;
		if (found && found.getAttribute("src")) return h("span", "sh-fig", null, h("img", null, { src: found.getAttribute("src"), alt: name || "" }));
		const first = Array.from(name || "")[0];
		return first ? h("span", "sh-fig ini", { "aria-hidden": "true" }, first.toUpperCase()) : null;
	}

	// The page's own element: it takes the place of the one before and leaves the rest of the body (the pictures the
	// page names in #kit-media) where it is.
	function show(main) {
		for (const old of D.querySelectorAll("body > main.sh")) old.remove();
		D.body.append(main);
	}

	// ---------------------------------------------------------------- data
	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...WORDS };
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const unit = cut(raw.unit, MAX.unit);
		const seen = new Set();
		const things = [];
		for (const t of list(raw.things)) {
			if (!isObj(t) || things.length >= MAX.things) continue;
			const name = cut(t.name, MAX.name);
			if (!name) continue;
			let id = text(t.id).trim().slice(0, 64) || `thing-${things.length + 1}`;
			while (seen.has(id)) id += "+";
			seen.add(id);
			const value = num(t.value);
			const state = STATES.includes(t.state) ? t.state : t.value !== undefined && typeof t.value !== "string" && value === null ? "unknown" : "known";
			const max = num(t.max);
			let level = num(t.level);
			if (level !== null) level = Math.max(0, Math.min(1, level > 1 && level <= 100 ? level / 100 : level));
			else if (value !== null && max !== null && max > 0) level = Math.max(0, Math.min(1, value / max));
			// a level is drawn where the thing has one; one whose number is not known yet is a hole in the shelf
			const hasLevel = t.level !== undefined || t.max !== undefined;
			const lowAt = num(t.low);
			const low = t.low === true || (lowAt !== null && value !== null && value <= lowAt);
			const ask = typeof t.ask === "string" ? t.ask.replace(/\s+/g, " ").trim() : "";
			things.push({
				id,
				name,
				picture: typeof t.picture === "string" ? t.picture : "",
				value: state === "unknown" ? null : value,
				valueText: typeof t.value === "string" && value === null ? cut(t.value, 14) : "",
				state,
				unit: t.unit === undefined ? unit : cut(t.unit, MAX.unit),
				level: state === "unknown" ? null : level,
				hasLevel,
				low,
				note: cut(t.note, MAX.note),
				by: cut(t.by, MAX.by),
				figure: typeof t.figure === "string" ? t.figure : "",
				ask: Array.from(ask).length <= 40 ? ask : "",
				source: typeof t.source === "string" && /^(?:https:\/\/|folder:)/.test(t.source) ? t.source : "",
				tone: TONES.includes(t.colour) ? t.colour : TONES[things.length % TONES.length],
			});
		}
		if (!things.length) throw new Error("no things");
		return { lang, words, title: cut(raw.title, MAX.title), line: cut(raw.line, MAX.line), things };
	}
	function formatter(lang) {
		let nf;
		try {
			nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
		} catch {
			nf = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
		}
		return (v) => nf.format(v);
	}

	// ---------------------------------------------------------------- a note to the app's owner
	// qorpera.tell (RUNTIME-INTERFACE-APPS.md §3b and §5): one quiet button at the foot of an opened thing, drawn only
	// where the bridge has `tell` (an older web, or the page opened outside Qorpera, has none). It asks from a press on
	// it alone, once per press; the member writes the note on Qorpera's bar above the page.
	const TELL_AT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
	const TOLD = new Map();
	const QUIET = new Map();
	const canTell = () => !!(window.qorpera && typeof window.qorpera.tell === "function");
	const ICON = {
		note: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.2L7 19.5V16a2.5 2.5 0 0 1-2.5-2.5z"/>',
		tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
		x: '<path d="M6 6l12 12M18 6L6 18"/>',
	};
	// a closed thing keeps no reason: it is gone at once
	function hushTold() {
		for (const [key, st] of TOLD)
			if (st.why) {
				clearTimeout(QUIET.get(key));
				TOLD.delete(key);
			}
		for (const x of D.querySelectorAll(".sh-tell-b")) if (x.__tell) x.__tell.paint();
	}
	function tellFoot(words, about, id, ask) {
		if (!canTell() || !about) return null;
		const at = TELL_AT.test(id || "") ? id : null;
		const key = `${id}\n${about}`;
		const b = h("button", "sh-tell-b", { type: "button" });
		const why = h("p", "sh-tell-why", { role: "status", "aria-live": "polite" });
		const paint = () => {
			const st = TOLD.get(key) || {};
			const label = st.done ? words.told : words.tell;
			b.replaceChildren(svg(st.done ? ICON.tick : ICON.note));
			if (label) b.append(h("span", null, null, label));
			b.classList.toggle("sh-bare", !label);
			b.classList.toggle("sh-told", !!st.done);
			if (label) b.removeAttribute("aria-label");
			else b.setAttribute("aria-label", st.done ? "Sent" : "Send a note");
			b.setAttribute("aria-busy", String(!!st.busy));
			if (st.done) b.setAttribute("aria-disabled", "true");
			else b.removeAttribute("aria-disabled");
			why.textContent = st.why || "";
		};
		b.__tell = { key, paint };
		b.addEventListener("click", async (e) => {
			e.stopPropagation();
			const st = TOLD.get(key) || {};
			if (st.busy || st.done || !canTell()) return;
			const note = { about };
			if (at) note.at = at;
			if (ask) note.text = ask;
			const settle = (next) => {
				clearTimeout(QUIET.get(key));
				TOLD.set(key, next);
				// most often the reason is the member's own "not now" of a moment ago: it goes by itself
				if (next.why) QUIET.set(key, setTimeout(() => TOLD.get(key) === next && settle({}), 6000));
				for (const x of D.querySelectorAll(".sh-tell-b")) if (x.__tell && x.__tell.key === key) x.__tell.paint();
			};
			settle({ busy: true });
			try {
				await window.qorpera.tell(note);
				settle({ done: true });
			} catch (err) {
				settle({ why: cut((err && err.message) || String(err || ""), 140) || "—" });
			}
		});
		paint();
		return h("div", "sh-tell", null, b, h("div", "sh-tell-c", null, why));
	}

	// ---------------------------------------------------------------- drawing
	const ui = { model: null, root: null, open: null, sheet: null, opener: null, width: 0, height: 0, shown: false, count: 0 };
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "shelf" }, CSS);
		D.head.append(style);
	}
	function quiet(line) {
		ensureStyle();
		show(h("main", `sh${BARE ? " sh--bare" : ""}`, null, h("p", "sh-quiet", null, line)));
		ui.root = null;
	}
	function numEl(t, fmt, words) {
		const row = h("span", `sh-num${t.low ? " low" : ""}${t.value === null && !t.valueText ? " unk" : ""}`);
		if (t.valueText) row.append(h("b", null, null, t.valueText));
		else if (t.value === null) {
			if (t.state !== "unknown") return null;
			row.append(h("b", null, null, "?"));
		} else {
			const b = h("b", null, { "data-n": String(t.value) }, fmt(t.value));
			row.append(b);
			if (t.unit) row.append(h("small", null, null, t.unit));
		}
		if (t.state === "assumed") row.append(h("span", "sh-tag", null, words.assumed));
		return row;
	}

	function layout() {
		const W = Math.max(280, (ui.root && ui.root.clientWidth) || window.innerWidth || 1280);
		const pad = Math.max(16, Math.min(36, W * 0.026));
		const inner = W - pad * 2;
		const n = ui.model.things.length;
		const cols = W < 600 ? Math.min(n, 2) : W < 900 ? Math.min(n, 3) : Math.min(n, n === 7 || n === 8 ? 4 : 6);
		const rows = Math.ceil(n / cols);
		const gap = Math.max(12, Math.min(40, W * 0.024));
		const w = Math.floor(Math.min(300, (inner - gap * (cols - 1)) / cols));
		const head = BARE ? 0 : 70;
		const labels = 112;
		const H = window.innerHeight || 800;
		const avail = (H - pad * 2 - head - 40) / rows - labels - (rows > 1 ? 40 : 0);
		const scene = Math.round(Math.max(W < 600 ? 170 : 200, Math.min(avail, w * 1.7, 470)));
		return { W, pad, cols, w, scene };
	}

	function render(intro) {
		const m = ui.model;
		ensureStyle();
		D.documentElement.lang = m.lang;
		const fmt = formatter(m.lang);
		const root = h("main", `sh${BARE ? " sh--bare" : ""}${intro && !still() ? " intro" : ""}`, { lang: m.lang });
		root.append(h("header", "sh-head", null, h("h1", "sh-title", null, m.title || ""), m.line ? h("p", "sh-line", null, m.line) : null));
		const shelf = h("div", "sh-shelf");
		root.append(shelf);
		show(root);
		ui.root = root;
		const L = layout();
		ui.width = L.W;
		ui.height = window.innerHeight;
		shelf.style.setProperty("--sh-w", `${L.w}px`);
		shelf.style.setProperty("--sh-scene", `${L.scene}px`);
		shelf.style.setProperty("--sh-pad", `${L.pad}px`);
		for (let r = 0; r < m.things.length; r += L.cols) {
			const part = m.things.slice(r, r + L.cols);
			const leveled = part.some((t) => t.hasLevel);
			const row = h("div", `sh-row${leveled ? " planked" : " gallery"}`);
			row.style.setProperty("--sh-cols", String(part.length));
			part.forEach((t, k) => row.append(thingEl(t, r + k, fmt, m.words, leveled)));
			shelf.append(row);
		}
		if (intro && !still()) {
			for (const b of root.querySelectorAll(".sh-num b[data-n]")) countUp(b, Number(b.dataset.n), fmt);
			setTimeout(() => root.classList.remove("intro"), 2400);
		}
		if (ui.open) {
			const t = m.things.find((x) => x.id === ui.open);
			if (t) openSheet(t, true);
			else closeSheet(true);
		}
	}

	function thingEl(t, i, fmt, words, leveled) {
		const b = h("button", "sh-thing", { type: "button", "data-id": t.id, "aria-haspopup": "dialog", "aria-expanded": ui.open === t.id ? "true" : "false" });
		b.style.setProperty("--sh-tone", toneVar(t.tone));
		b.style.setProperty("--i", String(i));
		const scene = h("span", "sh-scene");
		if (leveled && t.hasLevel) {
			if (t.level === null) scene.append(h("span", "sh-level unk", { style: "height:46%" }));
			else scene.append(h("span", `sh-level${t.low ? " low" : ""}${t.state === "assumed" ? " a" : ""}`, { style: `height:${Math.max(3, Math.round(t.level * 94))}%` }));
		}
		if (leveled || t.hasLevel) {
			const pic = h("span", "sh-pic", null, picture(t.picture));
			scene.append(pic);
		} else scene.append(h("span", "sh-frame", null, picture(t.picture)));
		if (t.note) {
			const fig = figureEl(t.figure, t.by);
			scene.append(h("span", "sh-note", null, fig, h("span", null, null, t.note)));
		}
		b.append(scene);
		const n = numEl(t, fmt, words);
		if (n) b.append(n);
		const name = h("span", "sh-name", null, t.name);
		if (t.low && !t.note) name.append(h("span", "sh-tag low", null, words.low));
		b.append(name);
		// a gallery thing names its maker under it
		if (!t.hasLevel && !t.note && (t.by || t.figure)) b.append(h("span", "sh-maker", null, figureEl(t.figure, t.by), t.by || ""));
		const label = [t.name, t.value !== null ? `${fmt(t.value)}${t.unit ? ` ${t.unit}` : ""}` : t.valueText, t.low ? words.low : "", t.note].filter(Boolean).join(", ");
		b.setAttribute("aria-label", label);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			if (ui.open === t.id) closeSheet();
			else openSheet(t);
		});
		return b;
	}

	function countUp(el, to, fmt) {
		const t0 = performance.now();
		let frames = 0;
		// by the clock, and never longer than about 100 frames, so a page whose frames come slowly still ends there
		const step = (t) => {
			const k = Math.min(1, Math.max((t - t0) / 900, ++frames / 96));
			const e = 1 - (1 - k) ** 3;
			el.textContent = fmt(k >= 1 ? to : Math.round(to * e));
			if (k < 1) requestAnimationFrame(step);
		};
		el.textContent = fmt(0);
		requestAnimationFrame(step);
	}

	// ---------------------------------------------------------------- a thing opened
	function openSheet(t, again) {
		const m = ui.model;
		const fmt = formatter(m.lang);
		const words = m.words;
		if (!again) {
			hushTold();
			ui.opener = t.id;
		}
		// one sheet at a time: one still fading out goes at once
		for (const old of ui.root.querySelectorAll(".sh-sheet")) old.remove();
		ui.open = t.id;
		for (const b of ui.root.querySelectorAll(".sh-thing")) b.setAttribute("aria-expanded", String(b.dataset.id === t.id));
		const close = h("button", "sh-x", { type: "button", "aria-label": words.close }, svg(ICON.x));
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			closeSheet();
		});
		const big = h("div", `sh-big${t.low ? " low" : ""}${t.hasLevel ? "" : " framed"}`, null, picture(t.picture));
		const info = h("div", "sh-info", null, h("h2", null, null, t.name));
		const n = numEl(t, fmt, words);
		if (n) {
			if (t.low) n.append(h("span", "sh-tag low", null, words.low));
			info.append(n);
		}
		if (t.hasLevel && t.level !== null) info.append(h("div", `sh-bar${t.low ? " low" : ""}`, { role: "img", "aria-label": `${Math.round(t.level * 100)}%` }, h("i", null, { style: `width:${Math.max(2, Math.round(t.level * 100))}%` })));
		if (t.note || t.by) {
			const said = h("div", "sh-said", null, figureEl(t.figure, t.by), h("div", null, null, t.note || "", t.by ? h("small", null, null, t.by) : null));
			info.append(said);
		}
		if (t.source) info.append(h("a", "sh-src", { href: t.source }, `${words.source} ↗`));
		const tell = tellFoot(words, t.name, t.id, t.ask);
		if (tell) info.append(tell);
		const card = h("div", "sh-card", null, close, big, info);
		card.style.setProperty("--sh-tone", toneVar(t.tone));
		card.addEventListener("click", (e) => e.stopPropagation());
		const sheet = h("div", `sh-sheet${again ? " is-open" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": t.name }, card);
		sheet.addEventListener("click", () => closeSheet());
		ui.root.append(sheet);
		ui.sheet = sheet;
		if (!again) {
			requestAnimationFrame(() => sheet.classList.add("is-open"));
			sheet.classList.add("is-open");
			close.focus({ preventScroll: true });
		}
	}
	function closeSheet(quietly) {
		const sheet = ui.sheet;
		const was = ui.opener || ui.open;
		ui.open = null;
		ui.sheet = null;
		hushTold();
		if (ui.root) for (const b of ui.root.querySelectorAll(".sh-thing")) b.setAttribute("aria-expanded", "false");
		if (!sheet) return;
		sheet.classList.remove("is-open");
		sheet.setAttribute("inert", "");
		sheet.setAttribute("aria-hidden", "true");
		if (still() || quietly) sheet.remove();
		else setTimeout(() => sheet.remove(), 260);
		if (!quietly && was && ui.root) {
			const back = ui.root.querySelector(`.sh-thing[data-id="${esc(was)}"]`);
			if (back) back.focus({ preventScroll: true });
		}
	}
	D.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && ui.open) {
			e.preventDefault();
			closeSheet();
		}
	});

	// ---------------------------------------------------------------- size changes
	let resizeFrame = 0;
	window.addEventListener("resize", () => {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!ui.model || !ui.root) return;
			const W = ui.root.clientWidth;
			if (W === ui.width && window.innerHeight === ui.height) return;
			render(false);
		});
	});

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
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "shelf.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			if (txt === lastText && ui.root) return;
			raw = JSON.parse(txt);
			ui.model = normalize(raw);
			lastText = txt;
			const first = !ui.shown;
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
