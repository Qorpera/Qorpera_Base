/* Qorpera interface kit: object. "What is the thing?"
 * Shows a physical thing as an object the member turns with a hand, with its parts pointed out on it.
 * The agent hands in object.json and pictures only: a turntable sprite sheet (or a still), parts with per-frame
 * tracks, facts, optional variants. Plain ES2020, no network, no libraries. */
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: the Concepts viewer beside it already names the app, says what it is and
	// who made it, so the page carries no title block and keeps almost nothing around its stage (Jonas, 13 November
	// 2026: "get rid of it ... minimize the borders/framing around the visual we are just trying to show"). Every
	// control, sheet and detail stays as it is. `concept` comes from the page (kitPage), never from the data.
	const BARE = KIT.concept === true;
	const D = document;
	const mq = (q) => (window.matchMedia ? matchMedia(q) : { matches: false, addEventListener() {} });
	const REDUCED = mq("(prefers-reduced-motion: reduce)");
	const calm = () => REDUCED.matches;
	const EN = {
		assumed: "assumed",
		unknown: "unknown",
		drag: "Drag to turn",
		close: "Close",
		source: "Source",
		turn: "Turn the object",
		empty: "Nothing to show yet.",
		// a note to the app's owner: the button's label, naming the agent ("Ask Luna"), and what it says once sent
		tell: "",
		told: "",
	};
	const STATES = { known: 1, assumed: 1, unknown: 1 };
	const SVGNS = "http://www.w3.org/2000/svg";
	const IDLE_MS = 20000;
	const TURN_SECONDS = 42; // one slow turn by itself

	// ------------------------------------------------------------------ small helpers
	const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
	const cut = (v, n) => {
		const s = typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "";
		return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
	};
	const st = (v) => (STATES[v] ? v : "known");
	const link = (s) => (typeof s === "string" && /^(folder:|app:|https:\/\/|#)/.test(s.trim()) ? s.trim() : null);
	const int = (v, lo, hi) => (Number.isFinite(+v) ? clamp(Math.round(+v), lo, hi) : 0);
	const ease = (t) => 1 - (1 - t) ** 3;
	const mod = (a, n) => ((a % n) + n) % n;
	function h(tag, cls, attrs, kids) {
		const e = D.createElement(tag);
		if (cls) e.className = cls;
		if (attrs) for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
		for (const k of [].concat(kids ?? [])) if (k != null) e.append(k);
		return e;
	}
	function s(tag, attrs) {
		const e = D.createElementNS(SVGNS, tag);
		if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
		return e;
	}

	// ------------------------------------------------------------------ style
	const STYLE = `
body{margin:0}
.ok{box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);display:flex;flex-direction:column;gap:clamp(6px,1.2vh,14px);color:var(--q-text);background:var(--q-bg);font-family:var(--q-font);-webkit-tap-highlight-color:transparent;overflow-x:hidden}
.ok *,.ok *::before,.ok *::after{box-sizing:border-box}
.ok button{font:inherit;color:inherit}
.ok-head{position:relative;z-index:2}
.ok--bare{padding:clamp(12px,1vw,16px)}
.ok--bare .ok-head{display:none}
.ok-head h1{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.ok-head p{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.ok-src{display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;margin:-6px 0 -6px 2px;color:var(--q-muted);text-decoration:none;font-size:14px;border-radius:8px;vertical-align:middle}
.ok-src:hover{color:var(--q-accent)}
.ok-view{position:relative;flex:1 1 auto;min-height:0}
.ok-object{position:absolute;touch-action:pan-y;cursor:grab;outline:none;user-select:none;-webkit-user-select:none;border-radius:28px}
.ok-object.still{cursor:default}
.ok-object.grab{cursor:grabbing}
.ok-object:focus-visible{outline:2px solid color-mix(in srgb,var(--q-accent) 60%,transparent);outline-offset:2px}
.ok-view:has(.ok-object:focus-visible) .ok-hint{opacity:1;color:var(--q-accent)}
.ok-object canvas{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transform:translateY(14px) scale(.985);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}
.ok.in .ok-object canvas{opacity:1;transform:none}
.ok-shadow{position:absolute;pointer-events:none;border-radius:50%;opacity:0;transition:opacity 1.1s ease .15s;background:radial-gradient(closest-side,color-mix(in srgb,var(--q-text) 30%,transparent),color-mix(in srgb,var(--q-text) 12%,transparent) 48%,transparent)}
@supports (color:rgb(from red r g b)){.ok-shadow{background:radial-gradient(closest-side,rgb(from var(--q-bg) calc(r*.48) calc(g*.48) calc(b*.5) / .6),rgb(from var(--q-bg) calc(r*.48) calc(g*.48) calc(b*.5) / .2) 52%,transparent)}}
.ok.in .ok-shadow{opacity:1}
.ok-lines{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.ok-lines .halo{stroke:var(--q-bg);stroke-width:3.2;stroke-linecap:round;fill:none;opacity:.75}
.ok-lines .lead{stroke:color-mix(in srgb,var(--q-text) 52%,var(--q-bg));stroke-width:1;fill:none;stroke-linecap:round;transition:stroke .2s}
.ok-lines .hot .lead{stroke:var(--q-accent);stroke-width:1.4}
.ok-lines .dot{fill:var(--q-accent);stroke:var(--q-bg);stroke-width:2;transition:r .2s}
.ok-lines .assumed .dot{fill:var(--q-bg);stroke:var(--q-accent);stroke-width:2;stroke-dasharray:3.1 2.3}
.ok-lines .unknown .dot{fill:color-mix(in srgb,var(--q-bg) 82%,var(--q-text));stroke:var(--q-muted);stroke-width:1.5;stroke-dasharray:2.6 2.2}
.ok-lines .q{font:700 9.5px var(--q-font);fill:var(--q-muted);text-anchor:middle;dominant-baseline:central}
.ok-lines .ring{fill:none;stroke:var(--q-accent);stroke-width:1.5;opacity:0}
.ok-lines .sel .ring{opacity:.55;animation:ok-pulse 2.4s ease-out infinite}
@keyframes ok-pulse{0%{opacity:.6;stroke-width:2}100%{opacity:0;stroke-width:.5}}
.ok-label{position:absolute;display:flex;align-items:center;gap:10px;border:0;background:none;padding:5px 6px;min-height:42px;max-width:240px;cursor:pointer;border-radius:12px;text-align:left;opacity:0;transform:translateX(var(--from,0));transition:opacity .45s ease,transform .6s cubic-bezier(.2,.7,.2,1),color .2s}
.ok.in .ok-label{opacity:1;transform:none}
.ok.in .ok-label.off{opacity:.42}
.ok-label.l{flex-direction:row-reverse;text-align:right;--from:10px}
.ok-label.r{--from:-10px}
.ok-label:focus-visible,.ok-chip:focus-visible,.ok-close:focus-visible,.ok-src:focus-visible,.ok-strip button:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.ok-label:hover .ok-name,.ok-label.hot .ok-name{color:var(--q-accent)}
.ok-label[aria-pressed=true] .ok-name{color:var(--q-accent);font-weight:650}
.ok-txt{display:flex;flex-direction:column;min-width:0}
.ok-name{font-size:14px;font-weight:560;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .2s}
.ok-val{font-size:13px;line-height:1.3;color:var(--q-muted);font-variant-numeric:tabular-nums;white-space:nowrap;display:flex;gap:6px;align-items:center}
.ok-label.l .ok-val{justify-content:flex-end}
.ok-mark{flex:none;width:12px;height:12px;border-radius:50%;background:var(--q-accent);box-shadow:0 0 0 2px var(--q-bg)}
.ok-mark.assumed{background:var(--q-bg);border:2px dashed var(--q-accent)}
.ok-mark.unknown{width:16px;height:16px;background:color-mix(in srgb,var(--q-bg) 85%,var(--q-text));border:1.5px dashed var(--q-muted);display:grid;place-items:center;font-size:10px;font-weight:700;color:var(--q-muted)}
.ok-tag{font-size:11px;line-height:1;padding:3px 6px;border-radius:999px;border:1px dashed color-mix(in srgb,var(--q-text) 40%,var(--q-bg));color:var(--q-muted)}
.ok-unk{display:inline-grid;place-items:center;min-width:2.1em;padding:0 .45em;border-radius:.45em;border:1px dashed color-mix(in srgb,var(--q-text) 32%,var(--q-bg));color:var(--q-muted);font-weight:650;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--q-text) 13%,transparent) 0 1.5px,transparent 1.5px 6px)}
.ok-val .ok-unk{font-size:11px;line-height:16px;min-width:22px}
.ok-note{position:absolute;z-index:3;left:50%;bottom:6px;width:min(440px,calc(100% - 8px));transform:translate(-50%,8px);opacity:0;visibility:hidden;pointer-events:none;background:var(--q-surface);border-radius:16px;padding:13px 46px 14px 16px;box-shadow:0 0 0 1px var(--q-line),0 18px 40px -22px color-mix(in srgb,var(--q-text) 55%,transparent);transition:opacity .25s ease,transform .35s cubic-bezier(.2,.7,.2,1),visibility 0s linear .25s}
.ok-note.open{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .25s ease,transform .35s cubic-bezier(.2,.7,.2,1)}
.ok-note-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:15px;font-weight:650;line-height:1.3}
.ok-note-h .ok-val{font-size:14px;font-weight:500}
.ok-note p{margin:5px 0 0;font-size:15px;line-height:1.45;color:var(--q-text)}
.ok-close{position:absolute;right:6px;top:6px;width:40px;height:40px;border:0;background:none;border-radius:12px;color:var(--q-muted);cursor:pointer;display:grid;place-items:center}
.ok-close:hover{color:var(--q-text);background:color-mix(in srgb,var(--q-text) 6%,transparent)}
/* a note to the app's owner, at the foot of a part's note: the reason a note did not go stands quietly beside the
   button, over a cell that holds no height of its own, so the note (anchored by its foot on a wide screen) keeps its
   height when it comes and goes */
.ok-tell{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:14px;margin-top:10px}
.ok-tell-c{position:relative;align-self:stretch}
.ok .ok-tell-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:40px;min-height:40px;padding:0 16px 0 12px;border:0;border-radius:999px;background:color-mix(in srgb,var(--q-text) 7%,transparent);color:var(--q-text);font-size:14px;font-weight:550;line-height:1.2;cursor:pointer;transition:background .2s,opacity .2s}
.ok .ok-tell-b:hover{background:color-mix(in srgb,var(--q-text) 12%,transparent)}
.ok .ok-tell-b:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.ok .ok-tell-b.ok-bare{padding:0}
.ok .ok-tell-b svg{flex:none;width:17px;height:17px}
.ok .ok-tell-b[aria-busy=true]{opacity:.55;cursor:progress}
.ok .ok-tell-b.ok-told{background:none;color:var(--q-muted);cursor:default;padding-left:4px}
.ok .ok-tell-b.ok-told.ok-bare{padding:0}
.ok .ok-tell-b.ok-told svg{color:var(--q-good)}
.ok-note .ok-tell-why{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);margin:0;font-size:13px;line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:var(--q-muted)}
.ok-hint{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;font-size:13px;color:var(--q-muted);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .6s ease}
.ok.in .ok-hint.show{opacity:1}
.ok-below{display:flex;flex-direction:column;align-items:center;gap:clamp(10px,1.8vh,20px)}
.ok-chips{display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
.ok-chip{min-height:40px;padding:0 16px;border-radius:14px;border:1px solid var(--q-line);background:var(--q-surface);cursor:pointer;font-size:14px;font-weight:550;transition:transform .2s,border-color .2s,background .2s}
.ok-chip:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--q-text) 30%,var(--q-bg))}
.ok-chip[aria-pressed=true]{border-color:var(--q-accent);background:var(--q-accent-soft)}
.ok-facts{display:flex;justify-content:center;flex-wrap:wrap;gap:6px clamp(26px,4.6vw,68px);margin:0;padding:0;list-style:none}
.ok-fact{display:flex;flex-direction:column;align-items:center;min-width:72px;opacity:0;transform:translateY(8px);transition:opacity .6s ease,transform .7s cubic-bezier(.2,.7,.2,1)}
.ok.in .ok-fact{opacity:1;transform:none}
.ok-fv{font-size:clamp(24px,2.5vw,32px);font-weight:650;letter-spacing:-.025em;line-height:1.12;font-variant-numeric:tabular-nums;white-space:nowrap;display:flex;align-items:center;gap:8px}
.ok-fv.assumed span:first-child{text-decoration:underline dashed color-mix(in srgb,var(--q-text) 40%,var(--q-bg));text-decoration-thickness:1.5px;text-underline-offset:6px}
.ok-fv .ok-unk{font-size:.8em;line-height:1.25;min-width:2.2em}
.ok-fl{margin-top:3px;font-size:13px;color:var(--q-muted);display:flex;gap:6px;align-items:center;white-space:nowrap}
.ok-strip{display:none}
.ok-empty{margin:auto 0;color:var(--q-muted);font-size:15px}
.ok.phone .ok-view{flex:none}
.ok.phone .ok-label,.ok.phone .ok-lines .lead,.ok.phone .ok-lines .halo{display:none}
.ok.phone .ok-strip{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1 * clamp(16px,2.6vw,36px));padding:2px clamp(16px,2.6vw,36px) 4px;scroll-padding:0 clamp(16px,2.6vw,36px)}
.ok.phone .ok-strip::-webkit-scrollbar{display:none}
.ok-strip button{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px 0 12px;border-radius:14px;border:1px solid var(--q-line);background:var(--q-surface);cursor:pointer;font-size:14px;font-weight:550;white-space:nowrap;transition:opacity .3s,border-color .2s}
.ok-strip button.off{opacity:.55}
.ok-strip button[aria-pressed=true]{border-color:var(--q-accent);background:var(--q-accent-soft)}
.ok-strip .ok-val{font-weight:400}
.ok.phone .ok-note{position:relative;left:auto;bottom:auto;width:auto;transform:none;display:none;margin-top:2px}
.ok.phone .ok-note.open{display:block}
.ok.phone .ok-hint{bottom:2px}
.ok.phone .ok-below{align-items:stretch}
.ok.phone .ok-facts{display:grid;grid-template-columns:1fr 1fr;gap:16px 18px;justify-content:stretch}
.ok.phone .ok-fact{align-items:flex-start;min-width:0}
.ok.phone .ok-fv{font-size:26px}
@media (prefers-reduced-motion:reduce){.ok *,.ok *::before,.ok *::after{transition:none!important;animation:none!important}}
`;

	// ------------------------------------------------------------------ a note to the app's owner
	// qorpera.tell (RUNTIME-INTERFACE-APPS.md §3b and §5): one quiet button at the foot of a part's note, drawn only
	// where the bridge has `tell` (an older web, or the page opened outside Qorpera, has none). It asks from a press on
	// it alone, once per press; the member writes the note on Qorpera's bar above the page.
	const TELL_AT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
	// each thing's note so far, by what it is about: { busy }, { done } or { why } (the reason it did not go)
	const TOLD = new Map();
	// the timer that takes a thing's reason away again
	const QUIET = new Map();
	// a closed detail keeps no reason: it is gone at once
	function hushTold() {
		for (const [key, st] of TOLD)
			if (st.why) {
				clearTimeout(QUIET.get(key));
				TOLD.delete(key);
			}
		for (const x of D.querySelectorAll(".ok-tell-b")) if (x.__tell) x.__tell.paint();
	}
	const canTell = () => !!(window.qorpera && typeof window.qorpera.tell === "function");
	// what a note is about, as one line of at most 60 characters, cut at a word
	function noteAbout(...parts) {
		const chars = Array.from(parts.filter(Boolean).join(" · "));
		if (chars.length <= 60) return chars.join("");
		let end = 59;
		while (end > 0 && chars[end] !== " ") end--;
		return `${(end > 0 ? chars.slice(0, end) : chars.slice(0, 59)).join("").replace(/[\s·]+$/, "")}…`;
	}
	// a draft for the note, as a thing's `ask` gives it: one line of at most 40 characters, or none
	function askOf(v) {
		const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
		return Array.from(t).length <= 40 ? t : "";
	}
	const TELL_ICON = {
		note: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.2L7 19.5V16a2.5 2.5 0 0 1-2.5-2.5z"/>',
		tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
	};
	function tellFoot(words, about, id, ask) {
		if (!canTell() || !about) return null;
		// `at` is only what goes out: the state is the thing's own, so two ids the call cannot take stay two things
		const at = TELL_AT.test(id || "") ? id : null;
		const key = `${id}\n${about}`;
		// a new view of the thing starts without the reason an earlier one showed
		if ((TOLD.get(key) || {}).why) {
			clearTimeout(QUIET.get(key));
			TOLD.delete(key);
		}
		const b = h("button", "ok-tell-b", { type: "button" });
		const why = h("p", "ok-tell-why", { role: "status", "aria-live": "polite" });
		const paint = () => {
			const st = TOLD.get(key) || {};
			const label = st.done ? words.told : words.tell;
			const mark = s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" });
			mark.innerHTML = st.done ? TELL_ICON.tick : TELL_ICON.note;
			b.replaceChildren(mark);
			if (label) b.append(h("span", null, null, label));
			b.classList.toggle("ok-bare", !label);
			b.classList.toggle("ok-told", !!st.done);
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
				for (const x of D.querySelectorAll(".ok-tell-b")) if (x.__tell && x.__tell.key === key) x.__tell.paint();
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
		return h("div", "ok-tell", null, [b, h("div", "ok-tell-c", null, why)]);
	}

	// ------------------------------------------------------------------ data
	function picOf(tt, still) {
		if (tt && typeof tt === "object" && typeof tt.picture === "string") {
			const frames = int(tt.frames, 0, 720);
			const fw = +tt.frameWidth;
			const fh = +tt.frameHeight;
			if (frames >= 1 && fw > 0 && fh > 0) {
				const columns = int(tt.columns || frames, 1, frames);
				return { path: tt.picture, frames, columns, fw, fh, sheet: frames > 1 };
			}
		}
		if (typeof still === "string" && still) return { path: still, frames: 1, columns: 1, fw: 0, fh: 0, sheet: false };
		return null;
	}
	function partsOf(list) {
		if (!Array.isArray(list)) return [];
		const seen = {};
		return list
			.filter((p) => p && typeof p === "object")
			.slice(0, 12)
			.map((p, i) => {
				let id = cut(p.id, 40) || `part${i}`;
				if (seen[id]) id = `${id}-${i}`;
				seen[id] = 1;
				const state = st(p.state);
				return {
					id,
					name: cut(p.name, 22) || "—",
					note: cut(p.note, 90),
					ask: askOf(p.ask),
					state,
					value: state === "unknown" ? "" : cut(p.value, 16),
					source: link(p.source),
					track: Array.isArray(p.track)
						? p.track.map((t) =>
								Array.isArray(t) && Number.isFinite(+t[0]) && Number.isFinite(+t[1]) ? [clamp(+t[0], -0.2, 1.2), clamp(+t[1], -0.2, 1.2), +t[2] ? 1 : 0] : [0.5, 0.5, 0],
							)
						: null,
				};
			});
	}
	function factsOf(list) {
		if (!Array.isArray(list)) return [];
		return list
			.filter((f) => f && typeof f === "object")
			.slice(0, 5)
			.map((f) => {
				const state = st(f.state);
				return { label: cut(f.label, 18) || "—", value: state === "unknown" ? "" : cut(f.value, 14), state, source: link(f.source) };
			});
	}
	function normalize(raw) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const words = { ...EN };
		if (raw.words && typeof raw.words === "object") for (const k in EN) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], 40);
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw.lang) ? raw.lang : D.documentElement.lang || "en";
		const main = {
			id: "main",
			name: cut(raw.name, 22) || cut(raw.title, 22) || "—",
			line: cut(raw.line, 60),
			pic: picOf(raw.turntable, raw.picture),
			parts: partsOf(raw.parts),
			facts: factsOf(raw.facts),
		};
		const variants = [main];
		if (Array.isArray(raw.variants))
			raw.variants
				.filter((v) => v && typeof v === "object")
				.slice(0, 6)
				.forEach((v, i) => {
					variants.push({
						id: cut(v.id, 40) || `variant${i}`,
						name: cut(v.name, 22) || "—",
						line: cut(v.line, 60) || main.line,
						pic: picOf(v.turntable, v.picture),
						parts: Array.isArray(v.parts) ? partsOf(v.parts) : main.parts,
						facts: Array.isArray(v.facts) ? factsOf(v.facts) : main.facts,
					});
				});
		if (!variants.some((v) => v.pic || v.parts.length || v.facts.length)) return null;
		return { lang, title: cut(raw.title, 60) || cut(D.title, 60), source: link(raw.source), words, variants };
	}

	// ------------------------------------------------------------------ pictures (only those the page named)
	const media = new Map();
	let shelf = null; // #kit-media: the page keeps it (hidden) so its pictures stay where the frame put them
	function picture(path) {
		if (media.has(path)) return media.get(path);
		shelf = shelf || D.getElementById("kit-media");
		const el = shelf ? Array.from(shelf.querySelectorAll("[data-kit-src]")).find((e) => e.getAttribute("data-kit-src") === path) : null;
		const rec = { el: el && el.tagName === "IMG" ? el : null, ok: false, w: 0, h: 0, bounds: undefined };
		rec.ready = new Promise((resolve) => {
			const img = rec.el;
			if (!img) return resolve(rec);
			const done = () => {
				rec.ok = img.naturalWidth > 0;
				rec.w = img.naturalWidth;
				rec.h = img.naturalHeight;
				resolve(rec);
			};
			const decode = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(done);
			if (img.complete && img.naturalWidth) decode();
			else if (img.complete && img.getAttribute("src") && !img.naturalWidth && img.src.startsWith("data:")) done();
			else {
				img.addEventListener("load", decode, { once: true });
				img.addEventListener("error", done, { once: true });
				if (img.complete) setTimeout(() => (img.naturalWidth ? decode() : done()), 0);
			}
		});
		media.set(path, rec);
		return rec;
	}
	/** Where the object really is inside its frames, read from the picture's own alpha (once). */
	function boundsOf(rec, pic) {
		if (rec.bounds !== undefined) return rec.bounds;
		rec.bounds = null;
		try {
			const sc = Math.min(1, 90 / pic.fh);
			const fw = Math.max(6, Math.round(pic.fw * sc));
			const fh = Math.max(6, Math.round(pic.fh * sc));
			const rows = Math.ceil(pic.frames / pic.columns);
			const c = D.createElement("canvas");
			c.width = fw * pic.columns;
			c.height = fh * rows;
			const x = c.getContext("2d", { willReadFrequently: true });
			x.drawImage(rec.el, 0, 0, pic.fw * pic.columns, pic.fh * rows, 0, 0, c.width, c.height);
			const px = x.getImageData(0, 0, c.width, c.height).data;
			let left = 1;
			let right = 0;
			let top = 1;
			let bottom = 0;
			let baseL = 1;
			let baseR = 0;
			for (let f = 0; f < pic.frames; f++) {
				const ox = (f % pic.columns) * fw;
				const oy = Math.floor(f / pic.columns) * fh;
				let fb = -1;
				for (let y = fh - 1; y >= 0 && fb < 0; y--) for (let xx = 0; xx < fw; xx++) if (px[((oy + y) * c.width + ox + xx) * 4 + 3] > 60) fb = y;
				for (let y = 0; y < fh; y++)
					for (let xx = 0; xx < fw; xx++) {
						if (px[((oy + y) * c.width + ox + xx) * 4 + 3] <= 60) continue;
						left = Math.min(left, xx / fw);
						right = Math.max(right, (xx + 1) / fw);
						top = Math.min(top, y / fh);
						bottom = Math.max(bottom, (y + 1) / fh);
						if (fb >= 0 && y >= fb - Math.max(1, fh * 0.03)) {
							baseL = Math.min(baseL, xx / fw);
							baseR = Math.max(baseR, (xx + 1) / fw);
						}
					}
			}
			if (right > left && bottom > top) rec.bounds = { left, right, top, bottom, baseL: baseL < baseR ? baseL : left, baseR: baseL < baseR ? baseR : right };
		} catch (e) {
			rec.bounds = null; // a picture the page may not read: fall back to the frame
		}
		return rec.bounds;
	}

	// ------------------------------------------------------------------ the page
	const S = {
		data: null,
		vi: 0,
		sel: null,
		was: null, // the part whose note was open, so the focus can go back to what opened it
		hot: null,
		ang: 0,
		vel: 0,
		autoV: 0,
		touched: false,
		lastTouch: 0,
		drag: null,
		anim: null,
		fade: null,
		box: null,
		dirty: true,
		running: false,
		built: false,
		speed: 0,
		prevAng: 0,
		lastMove: 0,
	};
	let R = null; // the built page's elements

	const V = () => S.data.variants[S.vi];
	const N = () => V().pic?.frames || 1;

	function touch() {
		S.touched = true;
		S.lastTouch = performance.now();
		R?.hint.classList.remove("show");
	}

	function build() {
		const d = S.data;
		const root = h("main", BARE ? "ok ok--bare" : "ok", { lang: d.lang });
		const title = h("h1", null, null, d.title);
		const line = h("p");
		const head = h("header", "ok-head", null, [title, line]);
		const view = h("div", "ok-view");
		const object = h("div", "ok-object", { tabindex: "0" });
		const shadow = h("div", "ok-shadow", { "aria-hidden": "true" });
		const canvas = h("canvas", null, { "aria-hidden": "true" });
		object.append(canvas);
		const lines = s("svg", { class: "ok-lines", "aria-hidden": "true" });
		const hint = h("div", "ok-hint", { "aria-hidden": "true" });
		hint.innerHTML = `<svg width="22" height="10" viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5h20M5 1 1 5l4 4M17 1l4 4-4 4"/></svg>`;
		hint.append(h("span", null, null, d.words.drag));
		// closed, it is inert as well as unseen: nothing in it takes the focus or is read out (a note faded out but
		// still in the page was reachable by Shift+Tab, and its button asked about a part no longer open)
		const note = h("div", "ok-note", { role: "status", "aria-live": "polite", inert: true });
		view.append(shadow, object, lines, hint, note);
		const strip = h("div", "ok-strip", { role: "group" });
		const chips = h("div", "ok-chips", { role: "group" });
		const facts = h("ul", "ok-facts");
		const below = h("div", "ok-below", null, [chips, facts]);
		root.append(head, view, strip, below);
		shelf = shelf || D.getElementById("kit-media");
		D.body.replaceChildren(...(shelf ? [shelf] : []), root);
		R = { root, head, title, line, view, object, shadow, canvas, ctx: canvas.getContext("2d"), lines, hint, note, strip, chips, facts, below, labels: [], marks: [] };

		object.addEventListener("pointerdown", down);
		object.addEventListener("pointermove", move);
		object.addEventListener("pointerup", up);
		object.addEventListener("pointercancel", cancel);
		object.addEventListener("lostpointercapture", cancel);
		object.addEventListener("keydown", key);
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && S.sel) {
				select(null);
				e.preventDefault();
			}
		});
		variantChips();
		fill(true);
		new ResizeObserver(() => layout()).observe(root);
		addEventListener("resize", layout);
		requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("in")));
		S.built = true;
		loop();
	}

	function variantChips() {
		const d = S.data;
		R.chips.replaceChildren();
		if (d.variants.length < 2) return;
		d.variants.forEach((v, i) => {
			const b = h("button", "ok-chip", { type: "button", "aria-pressed": i === S.vi ? "true" : "false" }, v.name);
			b.addEventListener("click", () => chooseVariant(i));
			R.chips.append(b);
		});
	}

	/** Labels, strip, facts and head for the current variant. */
	function fill(first) {
		const d = S.data;
		const v = V();
		R.line.replaceChildren(v.line || "");
		if (d.source) R.line.append("\u00a0", h("a", "ok-src", { href: d.source, title: d.words.source, "aria-label": d.words.source }, "↗"));
		const pic = v.pic;
		R.object.classList.toggle("still", !pic?.sheet);
		if (pic?.sheet) {
			R.object.setAttribute("role", "slider");
			R.object.setAttribute("aria-label", d.words.turn);
			R.object.setAttribute("aria-valuemin", "0");
			R.object.setAttribute("aria-valuemax", "359");
		} else {
			R.object.setAttribute("role", "img");
			R.object.setAttribute("aria-label", v.name);
			for (const a of ["aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"]) R.object.removeAttribute(a);
		}
		// labels
		for (const l of R.labels) l.el.remove();
		R.lines.replaceChildren();
		R.labels = v.parts.map((p, i) => {
			const el = h("button", "ok-label", { type: "button", "aria-pressed": S.sel === p.id ? "true" : "false" }, textOf(p, d.words));
			el.style.transitionDelay = first ? `${280 + i * 40}ms` : "0ms";
			el.addEventListener("click", () => {
				touch();
				select(S.sel === p.id ? null : p.id, true);
			});
			el.addEventListener("pointerenter", () => hover(p.id));
			el.addEventListener("pointerleave", () => hover(null));
			el.addEventListener("focus", () => hover(p.id));
			el.addEventListener("blur", () => hover(null));
			R.view.append(el);
			const g = s("g", { class: p.state });
			const halo = s("path", { class: "halo" });
			const lead = s("path", { class: "lead" });
			const ring = s("circle", { class: "ring", r: "13" });
			const dot = s("circle", { class: "dot", r: p.state === "known" ? "5.5" : p.state === "assumed" ? "6" : "8" });
			g.append(halo, lead, ring, dot);
			let q = null;
			if (p.state === "unknown") {
				q = s("text", { class: "q" });
				q.textContent = "?";
				g.append(q);
			}
			R.lines.append(g);
			return { part: p, el, g, halo, lead, ring, dot, q, side: "r", y: 0, mark: null };
		});
		// phone strip
		R.strip.replaceChildren(
			...v.parts.map((p) => {
				const b = h("button", null, { type: "button", "aria-pressed": S.sel === p.id ? "true" : "false", "data-id": p.id }, [markOf(p.state), h("span", null, null, p.name), valueOf(p, d.words)]);
				b.addEventListener("click", () => {
					touch();
					select(S.sel === p.id ? null : p.id, true);
				});
				return b;
			}),
		);
		R.strip.setAttribute("aria-label", d.title);
		// facts
		R.facts.replaceChildren(
			...v.facts.map((f, i) => {
				const val = h("div", `ok-fv ${f.state}`);
				if (f.state === "unknown") val.append(h("span", "ok-unk", { title: d.words.unknown }, "?"));
				else {
					const num = h("span", null, null, f.value);
					val.append(num);
					if (f.state === "assumed") val.append(h("span", "ok-tag", null, d.words.assumed));
					countUp(num, f.value, first ? 380 + i * 60 : 60);
				}
				const lab = h("div", "ok-fl", null, f.label);
				if (f.source) lab.append(h("a", "ok-src", { href: f.source, title: d.words.source, "aria-label": d.words.source }, "↗"));
				const li = h("li", "ok-fact", null, [val, lab]);
				li.style.transitionDelay = first ? `${420 + i * 50}ms` : "0ms";
				return li;
			}),
		);
		R.hint.classList.toggle("show", !!pic?.sheet && !S.touched);
		noteFor();
		R.chips.querySelectorAll(".ok-chip").forEach((b, i) => b.setAttribute("aria-pressed", i === S.vi ? "true" : "false"));
		if (pic) {
			const rec = picture(pic.path);
			rec.ready.then(() => {
				if (!pic.sheet && rec.ok && !pic.fw) {
					pic.fw = rec.w;
					pic.fh = rec.h;
				}
				layout();
			});
		}
		layout();
	}

	function markOf(state) {
		const m = h("span", `ok-mark ${state}`, { "aria-hidden": "true" });
		if (state === "unknown") m.textContent = "?";
		return m;
	}
	function valueOf(p, words) {
		const v = h("span", "ok-val");
		if (p.state === "unknown") v.append(h("span", "ok-unk", { title: words.unknown }, "?"));
		else if (p.value) v.append(h("span", null, null, p.value));
		if (p.state === "assumed") v.append(h("span", "ok-tag", null, words.assumed));
		return v;
	}
	function textOf(p, words) {
		const t = h("span", "ok-txt", null, [h("span", "ok-name", null, p.name)]);
		const v = valueOf(p, words);
		if (v.childNodes.length) t.append(v);
		return t;
	}

	/** Count a value's first number up to itself, keeping its own way of writing it. */
	function countUp(el, text, delay) {
		const m = /(\d+(?:[.,]\d+)?)/.exec(text);
		if (!m || calm()) {
			el.textContent = text;
			return;
		}
		const raw = m[1];
		const sep = raw.includes(",") ? "," : raw.includes(".") ? "." : "";
		const dec = sep ? raw.split(sep)[1].length : 0;
		const target = Number.parseFloat(raw.replace(",", "."));
		if (!Number.isFinite(target) || target === 0) {
			el.textContent = text;
			return;
		}
		const pre = text.slice(0, m.index);
		const post = text.slice(m.index + raw.length);
		const show = (x) => {
			let n = x.toFixed(dec);
			if (sep === ",") n = n.replace(".", ",");
			el.textContent = pre + n + post;
		};
		show(0);
		const t0 = performance.now() + delay;
		const step = (now) => {
			const t = clamp((now - t0) / 900, 0, 1);
			show(target * ease(t));
			if (t < 1) requestAnimationFrame(step);
			else el.textContent = text;
		};
		requestAnimationFrame(step);
	}

	// ------------------------------------------------------------------ layout
	function layout() {
		if (!R || !S.data) return;
		const v = V();
		const pic = v.pic;
		const rec = pic ? picture(pic.path) : null;
		const fw = pic?.fw || 4;
		const fh = pic?.fh || 3;
		const vw = R.view.clientWidth || R.root.clientWidth;
		const phone = innerWidth < 700;
		R.root.classList.toggle("phone", phone);
		// on a phone the note sits in the flow under the strip of names; on a wide screen it floats over the stage
		if (phone && R.note.parentNode !== R.root) R.root.insertBefore(R.note, R.below);
		else if (!phone && R.note.parentNode !== R.view) R.view.append(R.note);
		const b = rec?.ok && pic.fw ? boundsOf(rec, pic) : null;
		const ext = b ? Math.max(0.5 - b.left, b.right - 0.5) : 0.5; // half-width of the object, in frame widths
		let w;
		let hgt;
		if (phone) {
			w = vw;
			hgt = (w * fh) / fw;
			const cap = innerHeight * 0.6;
			if (hgt > cap) {
				hgt = cap;
				w = (hgt * fw) / fh;
			}
			R.view.style.height = `${Math.round(hgt + 8)}px`;
		} else {
			R.view.style.height = "";
			const pad = parseFloat(getComputedStyle(R.root).paddingTop) || 24;
			const gap = parseFloat(getComputedStyle(R.root).rowGap) || 10;
			const avail = innerHeight - pad * 2 - R.head.offsetHeight - R.below.offsetHeight - gap * 2;
			hgt = Math.max(260, avail);
			w = (hgt * fw) / fh;
			const room = vw - 2 * 230; // room left for the object between two label columns
			if (w * ext * 2 > room) {
				w = Math.max(200, room / (ext * 2));
				hgt = (w * fh) / fw;
			}
			R.view.style.minHeight = `${Math.round(Math.max(hgt, 260))}px`;
		}
		const viewH = phone ? hgt + 8 : Math.max(R.view.clientHeight, hgt);
		const left = (vw - w) / 2;
		const top = phone ? 0 : Math.max(0, (viewH - hgt) / 2);
		S.box = { left, top, w, h: hgt, ext, phone, vw, vh: viewH };
		Object.assign(R.object.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${hgt}px` });
		const dpr = Math.min(2.5, devicePixelRatio || 1);
		const cw = Math.round(w * dpr);
		const ch = Math.round(hgt * dpr);
		if (R.canvas.width !== cw || R.canvas.height !== ch) {
			R.canvas.width = cw;
			R.canvas.height = ch;
		}
		// the soft contact shadow under the object
		const baseL = b ? b.baseL : 0.3;
		const baseR = b ? b.baseR : 0.7;
		const ground = b ? b.bottom : 0.96;
		const sw = Math.max(0.16, (baseR - baseL) * 1.5) * w;
		Object.assign(R.shadow.style, {
			left: `${left + ((baseL + baseR) / 2) * w - sw / 2}px`,
			top: `${top + ground * hgt - sw * 0.15}px`,
			width: `${sw}px`,
			height: `${sw * 0.2}px`,
		});
		R.shadow.style.visibility = rec?.ok ? "" : "hidden";
		R.lines.setAttribute("width", vw);
		R.lines.setAttribute("height", viewH);
		R.lines.setAttribute("viewBox", `0 0 ${vw} ${viewH}`);
		placeLabels();
		S.dirty = true;
		draw();
	}

	/** Two tidy columns: each label gets a fixed slot beside the object, near where its part sits at the first frame. */
	function placeLabels() {
		const B = S.box;
		if (!B || B.phone) return;
		const items = R.labels;
		if (!items.length) return;
		const at0 = (p) => (p.track && p.track.length ? p.track[0] : null);
		items.forEach((it) => {
			const t = at0(it.part);
			it.side = t ? (t[0] < 0.5 ? "l" : "r") : "r";
			it.want = t ? B.top + t[1] * B.h : B.top + B.h / 2;
			it.x0 = t ? t[0] : 0.5;
		});
		// balance the columns: move the parts nearest the middle across
		const count = (sd) => items.filter((i) => i.side === sd).length;
		const limit = Math.ceil(items.length / 2) + 1;
		for (const sd of ["l", "r"]) {
			while (count(sd) > limit) {
				const mover = items.filter((i) => i.side === sd).sort((a, b) => Math.abs(a.x0 - 0.5) - Math.abs(b.x0 - 0.5))[0];
				mover.side = sd === "l" ? "r" : "l";
			}
		}
		const half = B.w * B.ext;
		const cx = B.left + B.w / 2;
		const gapX = Math.max(18, Math.min(56, B.w * 0.08));
		for (const sd of ["l", "r"]) {
			const col = items.filter((i) => i.side === sd).sort((a, b) => a.want - b.want);
			if (!col.length) continue;
			const step = clamp(B.h / (col.length + 1), 46, 58);
			// start from the wanted places, then push apart and keep inside the object's height
			const ys = col.map((i) => i.want);
			for (let pass = 0; pass < 40; pass++) {
				for (let k = 1; k < ys.length; k++) if (ys[k] - ys[k - 1] < step) ys[k] = ys[k - 1] + step;
				// keep the column centred on where its parts are, so leaders stay as level as they can
				const drift = ys.reduce((a, y, k) => a + y - col[k].want, 0) / ys.length;
				for (let k = 0; k < ys.length; k++) ys[k] -= drift * 0.5;
				const lo = B.top + 24;
				const hi = B.top + B.h - 24;
				const over = ys[ys.length - 1] - hi;
				if (over > 0) for (let k = 0; k < ys.length; k++) ys[k] -= over;
				const under = lo - ys[0];
				if (under > 0) for (let k = 0; k < ys.length; k++) ys[k] += under;
			}
			col.forEach((it, k) => {
				it.y = ys[k];
				const el = it.el;
				el.classList.remove("l", "r");
				el.classList.add(sd);
				el.style.top = `${Math.round(it.y)}px`;
				el.style.marginTop = "-21px";
				el.style.maxWidth = `${Math.max(120, (sd === "l" ? cx - half - gapX : B.vw - (cx + half + gapX)) - 4)}px`;
				if (sd === "l") {
					el.style.left = "";
					el.style.right = `${Math.round(B.vw - (cx - half - gapX))}px`;
				} else {
					el.style.right = "";
					el.style.left = `${Math.round(cx + half + gapX)}px`;
				}
			});
		}
		// where each leader starts: just beside the name, on its middle
		// (offsets, not rects: the labels may still be sliding in)
		for (const it of items) {
			const e = it.el;
			const n = e.querySelector(".ok-name");
			it.mark = { x: it.side === "l" ? e.offsetLeft + e.offsetWidth + 2 : e.offsetLeft - 2, y: e.offsetTop + n.offsetTop + n.offsetHeight / 2 };
		}
		syncLabels();
	}

	// ------------------------------------------------------------------ drawing
	function frameRect(pic, f) {
		const c = mod(f, pic.frames);
		return [(c % pic.columns) * pic.fw, Math.floor(c / pic.columns) * pic.fh, pic.fw, pic.fh];
	}
	function paint(ctx, pic, ang, alpha) {
		const rec = picture(pic.path);
		const W = ctx.canvas.width;
		const H = ctx.canvas.height;
		if (!rec.ok || !pic.fw) {
			// a quiet placeholder where a missing picture would be
			ctx.save();
			ctx.globalAlpha = alpha * 0.9;
			ctx.strokeStyle = getComputedStyle(R.hint).color; // the quiet text colour, resolved
			ctx.globalAlpha = alpha * 0.45;
			ctx.lineWidth = Math.max(1, W / 300);
			ctx.setLineDash([W / 60, W / 70]);
			ctx.beginPath();
			ctx.ellipse(W / 2, H * 0.5, W * 0.3, H * 0.36, 0, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
			return;
		}
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		if (!pic.sheet) {
			ctx.globalAlpha = alpha;
			ctx.drawImage(rec.el, 0, 0, pic.fw, pic.fh, 0, 0, W, H);
			return;
		}
		const a = mod(ang, pic.frames);
		const f0 = Math.floor(a);
		const t = shown(a - f0);
		if (t < 0.02 || t > 0.98) {
			ctx.globalAlpha = alpha;
			ctx.drawImage(rec.el, ...frameRect(pic, t > 0.98 ? f0 + 1 : f0), 0, 0, W, H);
		} else {
			// a true blend of two neighbouring frames: add them, weighted (premultiplied, so edges stay clean)
			ctx.globalAlpha = alpha * (1 - t);
			ctx.drawImage(rec.el, ...frameRect(pic, f0), 0, 0, W, H);
			ctx.globalAlpha = alpha * t;
			ctx.drawImage(rec.el, ...frameRect(pic, f0 + 1), 0, 0, W, H);
		}
	}
	/** How far the picture is between two frames. Neighbouring frames blend while the object moves fast (it reads as
	 * motion); turning slowly, the blend is squeezed into a short dissolve at each step; held still, one whole frame. */
	function shown(frac) {
		if (performance.now() - S.lastMove > 90) return frac < 0.5 ? 0 : 1;
		const sharp = clamp(10 / (1 + S.speed), 1, 8);
		return clamp((frac - 0.5) * sharp + 0.5, 0, 1);
	}
	function draw() {
		if (!R || !S.box) return;
		const ctx = R.ctx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		ctx.clearRect(0, 0, R.canvas.width, R.canvas.height);
		ctx.globalCompositeOperation = "lighter";
		const v = V();
		if (S.fade && S.fade.pic) {
			const k = S.fade.k;
			paint(ctx, S.fade.pic, S.fade.ang, 1 - k);
			if (v.pic) paint(ctx, v.pic, S.ang, k);
		} else if (v.pic) paint(ctx, v.pic, S.ang, S.fade ? S.fade.k : 1);
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
		overlay();
		if (v.pic?.sheet) {
			const deg = Math.round((mod(S.ang, v.pic.frames) / v.pic.frames) * 360) % 360;
			R.object.setAttribute("aria-valuenow", String(deg));
			R.object.setAttribute("aria-valuetext", `${deg}°`);
		}
		S.dirty = false;
	}

	/** Where a part is at the current angle: [x, y, visibility 0..1] in view pixels. */
	function where(p) {
		const tr = p.track;
		const pic = V().pic;
		if (!tr || !tr.length || !pic) return null;
		let x;
		let y;
		let vis;
		if (!pic.sheet || tr.length !== pic.frames) {
			if (tr.length !== pic.frames && pic.sheet) return null;
			[x, y, vis] = tr[0];
		} else {
			const a = mod(S.ang, pic.frames);
			const f0 = Math.floor(a);
			const t = shown(a - f0);
			const A = tr[f0];
			const B = tr[(f0 + 1) % pic.frames];
			x = A[0] + (B[0] - A[0]) * t;
			y = A[1] + (B[1] - A[1]) * t;
			vis = A[2] + (B[2] - A[2]) * t;
		}
		if (S.fade) vis *= S.fade.k;
		const b = S.box;
		return [b.left + x * b.w, b.top + y * b.h, vis];
	}
	function overlay() {
		if (!R.labels.length) return;
		for (const it of R.labels) {
			const w = where(it.part);
			const vis = w ? w[2] : 0;
			const shown = vis > 0.02;
			it.g.style.display = shown ? "" : "none";
			it.vis = vis;
			if (!shown) continue;
			const [x, y] = w;
			it.g.style.opacity = vis.toFixed(3);
			it.dot.setAttribute("cx", x.toFixed(1));
			it.dot.setAttribute("cy", y.toFixed(1));
			it.ring.setAttribute("cx", x.toFixed(1));
			it.ring.setAttribute("cy", y.toFixed(1));
			if (it.q) {
				it.q.setAttribute("x", x.toFixed(1));
				it.q.setAttribute("y", (y + 0.5).toFixed(1));
			}
			if (it.mark && !S.box.phone) {
				const d = `M${it.mark.x.toFixed(1)} ${it.mark.y.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`;
				it.lead.setAttribute("d", d);
				it.halo.setAttribute("d", d);
				// a leader that has to reach across the object to the far side steps back, so the near ones read first
				const B = S.box;
				const across = ((x - (B.left + B.w / 2)) * (it.side === "l" ? 1 : -1)) / Math.max(1, B.w * B.ext);
				const hot = it.part.id === S.hot || it.part.id === S.sel;
				const o = hot ? "1" : ((1 - 0.7 * clamp(across, 0, 1)) * (S.sel ? 0.4 : 1)).toFixed(3);
				it.lead.style.opacity = o;
				it.halo.style.opacity = o;
			}
		}
		syncLabels();
	}
	function syncLabels() {
		for (const it of R.labels) {
			const off = !(it.vis > 0.5);
			if (it.off !== off) {
				it.off = off;
				it.el.classList.toggle("off", off);
				R.strip.querySelector(`[data-id="${CSS.escape(it.part.id)}"]`)?.classList.toggle("off", off);
			}
			const hot = it.part.id === S.hot || it.part.id === S.sel;
			it.g.classList.toggle("hot", hot);
			it.g.classList.toggle("sel", it.part.id === S.sel);
			it.el.classList.toggle("hot", it.part.id === S.hot);
			it.dot.setAttribute("r", String((it.part.state === "unknown" ? 8 : it.part.state === "assumed" ? 6 : 5.5) + (hot ? 1.5 : 0)));
		}
	}

	// ------------------------------------------------------------------ motion
	function loop() {
		if (S.running) return;
		S.running = true;
		let last = performance.now();
		const tick = (now) => {
			const dt = Math.min(64, now - last);
			last = now;
			step(now, dt);
			if (S.dirty) draw();
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}
	function step(now, dt) {
		if (!S.data || D.hidden) return;
		const pic = V().pic;
		const turning = pic?.sheet;
		if (S.fade) {
			S.fade.k = clamp((now - S.fade.t0) / 380, 0, 1);
			if (S.fade.k >= 1) S.fade = null;
			S.dirty = true;
		}
		if (!turning) return;
		const n = pic.frames;
		const idle = now - S.lastTouch > IDLE_MS;
		const wantAuto = !calm() && (!S.touched || idle) && !S.sel && !S.drag && !S.anim;
		const target = wantAuto ? n / (TURN_SECONDS * 1000) : 0;
		const before = S.prevAng;
		S.autoV += (target - S.autoV) * Math.min(1, dt / (target ? 900 : 220));
		if (Math.abs(S.autoV) < 1e-7) S.autoV = 0;
		if (S.anim) {
			const t = clamp((now - S.anim.t0) / S.anim.dur, 0, 1);
			S.ang = S.anim.from + (S.anim.to - S.anim.from) * ease(t);
			if (t >= 1) S.anim = null;
		} else if (!S.drag) {
			if (S.vel) {
				S.ang += S.vel * dt;
				S.vel *= Math.exp(-dt / 330);
				if (Math.abs(S.vel) < 0.0004) S.vel = 0;
			}
			S.ang += S.autoV * dt;
			if (!S.vel && !S.autoV) {
				// come to rest on a whole frame, so the picture is never a blend at rest
				const r = Math.round(S.ang);
				const d = r - S.ang;
				S.ang = Math.abs(d) < 0.004 ? r : S.ang + d * Math.min(1, dt / 90);
			}
		}
		if (S.ang !== before) {
			S.dirty = true;
			S.lastMove = now;
		} else if (now - S.lastMove < 140) S.dirty = true; // let the picture settle onto a whole frame
		S.speed += ((Math.abs(S.ang - before) / Math.max(1, dt)) * 1000 - S.speed) * Math.min(1, dt / 120);
		S.prevAng = S.ang;
		if (Math.abs(S.ang) > n * 1000) S.ang = mod(S.ang, n);
	}
	function turnTo(frame) {
		const pic = V().pic;
		if (!pic?.sheet) return;
		const n = pic.frames;
		let d = mod(frame - S.ang, n);
		if (d > n / 2) d -= n;
		S.vel = 0;
		S.autoV = 0;
		if (calm() || Math.abs(d) < 0.01) {
			S.ang += d;
			S.anim = null;
			S.dirty = true;
			return;
		}
		S.anim = { from: S.ang, to: S.ang + d, t0: performance.now(), dur: clamp(420 + Math.abs(d) * (360 / n) * 4.2, 450, 1150) };
	}
	/** The frame where a part faces the viewer best: the middle of its longest run of visible frames. */
	function bestFrame(p) {
		const pic = V().pic;
		const tr = p.track;
		if (!pic?.sheet || !tr || tr.length !== pic.frames) return null;
		const n = tr.length;
		let best = null;
		let len = 0;
		for (let i = 0; i < n; i++) {
			if (!tr[i][2] || tr[(i - 1 + n) % n][2]) continue;
			let k = 0;
			while (k < n && tr[(i + k) % n][2]) k++;
			if (k > len) {
				len = k;
				best = i + (k - 1) / 2;
			}
		}
		if (best == null && tr.every((t) => t[2])) {
			// always in view: turn it to where it is nearest the middle
			let err = 9;
			tr.forEach((t, i) => {
				if (Math.abs(t[0] - 0.5) < err) {
					err = Math.abs(t[0] - 0.5);
					best = i;
				}
			});
		}
		return best == null ? null : Math.round(best) % n;
	}

	// ------------------------------------------------------------------ choosing
	function hover(id) {
		S.hot = id;
		if (R) syncLabels();
	}
	function select(id, turn) {
		S.sel = id;
		const part = id ? V().parts.find((p) => p.id === id) : null;
		if (!part) S.sel = null;
		for (const it of R.labels) it.el.setAttribute("aria-pressed", it.part.id === S.sel ? "true" : "false");
		R.strip.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.getAttribute("data-id") === S.sel ? "true" : "false"));
		if (part && turn) {
			const f = bestFrame(part);
			if (f != null) turnTo(f);
		}
		noteFor();
		syncLabels();
		S.dirty = true;
	}
	function noteFor() {
		const d = S.data;
		const part = S.sel ? V().parts.find((p) => p.id === S.sel) : null;
		if (!part) {
			const inside = R.note.contains(D.activeElement);
			R.note.classList.remove("open");
			R.note.setAttribute("inert", "");
			hushTold();
			// the focus goes back to what opened the note, never onto a part that is no longer shown
			if (inside) openerOf(S.was)?.focus({ preventScroll: true });
			S.was = null;
			return;
		}
		S.was = part.id;
		R.note.removeAttribute("inert");
		const head = h("div", "ok-note-h", null, [markOf(part.state), h("span", null, null, part.name)]);
		const v = valueOf(part, d.words);
		if (v.childNodes.length) head.append(v);
		if (part.source) head.append(h("a", "ok-src", { href: part.source, title: d.words.source, "aria-label": d.words.source }, "↗"));
		const close = h("button", "ok-close", { type: "button", "aria-label": d.words.close, title: d.words.close });
		close.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l10 10M12 2 2 12"/></svg>`;
		close.addEventListener("click", () => select(null));
		// with variants to choose from, the note names the one shown
		const tell = tellFoot(d.words, noteAbout(part.name, d.variants.length > 1 ? V().name : ""), part.id, part.ask);
		R.note.replaceChildren(head, ...(part.note ? [h("p", null, null, part.note)] : []), ...(tell ? [tell] : []), close);
		R.note.classList.add("open");
	}
	/** What opens a part's note: its name beside the object, or its button in the strip on a phone. */
	function openerOf(id) {
		if (!id || !R) return null;
		if (S.box?.phone) return R.strip.querySelector(`[data-id="${CSS.escape(id)}"]`);
		return (R.labels.find((it) => it.part.id === id) || {}).el ?? null;
	}
	function chooseVariant(i) {
		if (i === S.vi) return;
		touch();
		const old = V();
		const oldN = N();
		S.fade = old.pic ? { pic: old.pic, ang: S.ang, k: 0, t0: performance.now() } : { pic: null, k: 0, t0: performance.now() };
		if (calm()) S.fade = null;
		S.vi = i;
		const n = N();
		S.ang = old.pic?.sheet && V().pic?.sheet ? (mod(S.ang, oldN) / oldN) * n : 0;
		S.anim = null;
		S.vel = 0;
		if (S.sel && !V().parts.some((p) => p.id === S.sel)) S.sel = null;
		fill(false);
		if (S.sel) select(S.sel, true);
	}

	// ------------------------------------------------------------------ hands and keys
	function down(e) {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		touch();
		S.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, a0: S.ang, moved: false, lx: e.clientX, lt: e.timeStamp, v: 0 };
		S.anim = null;
		S.vel = 0;
	}
	function move(e) {
		const g = S.drag;
		if (!g || g.id !== e.pointerId) return;
		const dx = e.clientX - g.x0;
		const pic = V().pic;
		if (!g.moved) {
			if (Math.abs(dx) < 6) return;
			if (Math.abs(e.clientY - g.y0) > Math.abs(dx) && e.pointerType !== "mouse") {
				S.drag = null; // a vertical swipe on a phone scrolls the page
				return;
			}
			g.moved = true;
			if (pic?.sheet) {
				R.object.classList.add("grab");
				try {
					R.object.setPointerCapture(e.pointerId);
				} catch (err) {
					/* fine without */
				}
			}
		}
		if (!pic?.sheet) return;
		const k = (pic.frames * 0.55) / Math.max(200, S.box.w); // frames per pixel: one object-width is about half a turn
		S.ang = g.a0 + (e.clientX - g.x0) * k;
		const dt = Math.max(1, e.timeStamp - g.lt);
		g.v = g.v * 0.6 + (((e.clientX - g.lx) * k) / dt) * 0.4;
		g.lx = e.clientX;
		g.lt = e.timeStamp;
		S.dirty = true;
		e.preventDefault();
	}
	function up(e) {
		const g = S.drag;
		if (!g || g.id !== e.pointerId) return;
		S.drag = null;
		R.object.classList.remove("grab");
		touch();
		if (!g.moved) return tap(e);
		if (!calm() && e.timeStamp - g.lt < 90) S.vel = clamp(g.v, -0.05, 0.05);
	}
	function cancel(e) {
		if (S.drag && (!e || e.pointerId === S.drag.id)) {
			S.drag = null;
			R.object.classList.remove("grab");
		}
	}
	function tap(e) {
		const vr = R.view.getBoundingClientRect();
		const px = e.clientX - vr.left;
		const py = e.clientY - vr.top;
		let best = null;
		let dist = S.box.phone ? 30 : 24;
		for (const it of R.labels) {
			const w = where(it.part);
			if (!w || w[2] < 0.5) continue;
			const d = Math.hypot(w[0] - px, w[1] - py);
			if (d < dist) {
				dist = d;
				best = it.part.id;
			}
		}
		if (best) select(best === S.sel ? null : best, best !== S.sel);
		else if (S.sel) select(null);
	}
	function key(e) {
		const pic = V().pic;
		if (!pic?.sheet) return;
		const step = Math.max(1, Math.round(pic.frames / 24));
		let target = null;
		if (e.key === "ArrowRight" || e.key === "ArrowUp") target = Math.round(S.anim ? S.anim.to : S.ang) + step;
		else if (e.key === "ArrowLeft" || e.key === "ArrowDown") target = Math.round(S.anim ? S.anim.to : S.ang) - step;
		else if (e.key === "Home") target = 0;
		else if (e.key === "End") target = Math.round(pic.frames / 2);
		if (target == null) return;
		e.preventDefault();
		touch();
		const n = pic.frames;
		S.vel = 0;
		S.autoV = 0;
		const base = S.anim ? S.anim.to : S.ang;
		const d = e.key === "Home" || e.key === "End" ? (() => {
			let x = mod(target - base, n);
			if (x > n / 2) x -= n;
			return x;
		})() : target - base;
		if (calm()) {
			S.ang = base + d;
			S.dirty = true;
		} else S.anim = { from: S.ang, to: base + d, t0: performance.now(), dur: 380 };
	}

	// ------------------------------------------------------------------ data in and out
	/** The data; null when the file holds nothing to show, undefined when the read itself failed. */
	async function read() {
		const q = window.qorpera;
		if (!q || typeof q.read !== "function" || !KIT.app) return undefined;
		let text;
		try {
			const r = await q.read(`apps/${KIT.app}/${KIT.data || "object.json"}`);
			text = typeof r === "string" ? r : r && (r.text ?? r.content);
		} catch (e) {
			return undefined;
		}
		if (typeof text !== "string") return undefined;
		try {
			return normalize(JSON.parse(text));
		} catch (e) {
			return null;
		}
	}
	function empty(text) {
		if (S.built) return;
		const root = h("main", BARE ? "ok ok--bare" : "ok", null, [h("p", "ok-empty", null, text)]);
		shelf = shelf || D.getElementById("kit-media");
		D.body.replaceChildren(...(shelf ? [shelf] : []), root);
	}
	async function start() {
		const style = h("style", null, { "data-kit": "object" }, STYLE);
		D.head.append(style);
		let lastRead = 0;
		let pending = null;
		const refresh = async () => {
			pending = null;
			lastRead = Date.now();
			const next = await read();
			if (!next) {
				// keep what was last shown; a read that failed is tried again ten seconds later, until one works
				if (!S.built) empty(EN.empty);
				if (next === undefined && !pending) pending = setTimeout(refresh, 10000);
				return;
			}
			if (!S.built) {
				S.data = next;
				if (next.lang) D.documentElement.lang = next.lang;
				build();
				return;
			}
			const keepVariant = V().id;
			S.data = next;
			const vi = next.variants.findIndex((v) => v.id === keepVariant);
			S.vi = vi >= 0 ? vi : 0;
			if (S.sel && !V().parts.some((p) => p.id === S.sel)) S.sel = null;
			R.title.textContent = next.title;
			variantChips();
			fill(false);
		};
		try {
			window.qorpera?.onChange?.(() => {
				if (pending) return;
				const wait = Math.max(0, 10000 - (Date.now() - lastRead));
				pending = setTimeout(refresh, wait);
			});
		} catch (e) {
			/* no live changes here */
		}
		await refresh();
	}
	if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
})();
