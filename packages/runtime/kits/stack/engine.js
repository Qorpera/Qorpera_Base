// The stack kit's engine: "What wants my yes?"
// Things that want a member's yes, one big card at a time: a soft colour field or a picture, one big number, one line,
// the asking agent's figure, and the answers as buttons under it. A card's buttons are the options of the agent's open
// question that points at the app (qorpera.questions), and a press answers it (qorpera.answer): Qorpera shows the
// member what will be sent, and it is sent on their yes. The card is stamped and the next comes forward; when none is
// left, the page says so. A card whose question is not open shows no buttons.
// The agent writes only stack.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const MAX = { title: 40, line: 60, card: 48, cardLine: 60, unit: 10, valueText: 18, by: 24, stamp: 16, word: 40, cards: 24, label: 24 };
	const WORDS = {
		done: "Nothing waits on you",
		answered: "{n} answered",
		waiting: "Not asked yet",
		saving: "Sending…",
		card: "Card {n} of {total}",
		assumed: "assumed",
		unknown: "not known",
		empty: "Nothing to show yet.",
		source: "Source",
		// a note to the app's owner: the button's label, naming the agent ("Ask Luna"), and what it says once sent
		tell: "",
		told: "",
	};
	const TONES = ["accent", "good", "violet", "warn", "teal", "bad"];
	const STATES = ["known", "assumed", "unknown"];
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.st{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --st-ease:cubic-bezier(.22,.8,.24,1);--st-shade:rgb(from var(--q-bg) calc(r*.3) calc(g*.3) calc(b*.32)/.3)}
.st *,.st *::before,.st *::after{box-sizing:border-box}
.st-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px 40px}
.st-head{min-width:0;max-width:34em}
.st-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.st-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.st--bare{padding:clamp(12px,1vw,16px)}
.st--bare .st-head{display:none}
.st .st-head{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.st-total{text-align:right}
.st-total-n{font-size:clamp(30px,3.4vw,44px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.st-total-n small{margin-left:.25em;font-size:.48em;font-weight:600;letter-spacing:-.01em;color:var(--q-muted)}
.st-total-n.unk{color:var(--q-muted)}
.st-total-l{margin-top:6px;font-size:14px;color:var(--q-muted)}
.st-stage{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:clamp(8px,2vh,24px) 0 clamp(16px,4vh,48px)}
.st-dots{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:0;min-height:40px}
.st-dot{display:grid;place-items:center;width:22px;height:40px;padding:0;border:0;background:none;cursor:pointer}
.st-dot i{display:block;width:8px;height:8px;border-radius:4px;background:color-mix(in srgb,var(--q-text) 14%,var(--q-bg));transition:width .3s var(--st-ease),background .3s}
.st-dot.done i{background:var(--q-text)}
.st-dot.on{width:40px}
.st-dot.on i{width:26px;background:var(--q-text)}
.st-dot:focus-visible{outline:2px solid var(--q-accent);outline-offset:-6px;border-radius:10px}
span.st-dot{cursor:default}
.st-pile{position:relative;width:min(560px,100%);margin-top:clamp(10px,2vh,22px)}
.st-back{position:absolute;border-radius:24px;background:color-mix(in srgb,var(--q-text) 4%,var(--q-bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--q-text) 6%,transparent)}
.st-back.b1{left:12px;right:12px;top:11px;bottom:-9px}
.st-back.b2{left:26px;right:26px;top:22px;bottom:-18px;background:color-mix(in srgb,var(--q-text) 3%,var(--q-bg))}
.st-card{position:relative;display:flex;flex-direction:column;border-radius:24px;background:var(--q-bg);overflow:hidden;
 box-shadow:0 0 0 1px color-mix(in srgb,var(--q-text) 9%,transparent),0 22px 48px -20px var(--st-shade);transition:transform .55s var(--st-ease),opacity .45s var(--st-ease)}
.st-card.enter{animation:st-enter .6s var(--st-ease) both}
.st-card.leave{transform:translate(-40%,-8px) rotate(-7deg);opacity:0}
.st-field{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;height:clamp(190px,36vh,330px);padding:24px 28px;
 background:linear-gradient(160deg,color-mix(in srgb,var(--st-tone) 12%,var(--q-bg)) 0%,color-mix(in srgb,var(--st-tone) 34%,var(--q-bg)) 100%)}
.st-field.pic{height:auto;aspect-ratio:16/9.4;max-height:44vh;padding:0;background:color-mix(in srgb,var(--st-tone) 10%,var(--q-bg))}
.st-field.pic img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.st-field .st-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:40px;font-weight:600;color:color-mix(in srgb,var(--st-tone) 50%,var(--q-bg))}
.st-num{display:flex;align-items:baseline;gap:.22em;white-space:nowrap;min-width:0}
.st-num b{font-size:clamp(44px,5.6vw,72px);font-weight:700;letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--st-tone) 28%,var(--q-text))}
.st-num b.txt{font-size:clamp(34px,4.2vw,52px)}
.st-num small{font-size:clamp(17px,1.8vw,22px);font-weight:600;color:color-mix(in srgb,var(--st-tone) 40%,var(--q-muted))}
.st-num .unk{color:var(--q-muted)}
.st-fline{font-size:15px;line-height:1.35;color:color-mix(in srgb,var(--st-tone) 30%,var(--q-muted))}
.st-tag{display:inline-flex;align-items:center;height:20px;margin-left:8px;padding:0 8px;border-radius:999px;border:1.3px dashed var(--q-muted);font-size:12px;font-weight:550;color:var(--q-muted);vertical-align:3px}
.st-body{display:flex;align-items:center;gap:16px;padding:20px 24px 22px}
.st-fig{flex:none;width:52px;height:52px;display:grid;place-items:center}
.st-fig img{width:100%;height:100%;object-fit:contain;display:block}
.st-fig.ini{border-radius:50%;background:color-mix(in srgb,var(--st-tone) 16%,var(--q-bg));font-size:20px;font-weight:650;color:color-mix(in srgb,var(--st-tone) 70%,var(--q-text))}
.st-ask{min-width:0;flex:1}
.st-ask h2{margin:0;font-size:clamp(18px,1.7vw,21px);font-weight:650;line-height:1.25;letter-spacing:-.01em}
.st-ask p{margin:3px 0 0;font-size:14px;line-height:1.35;color:var(--q-muted)}
.st-side{flex:none;text-align:right}
.st-side .st-num b{font-size:clamp(26px,2.6vw,34px);color:var(--q-text)}
.st-side .st-num small{font-size:15px;color:var(--q-muted)}
/* the paper of a bill */
.st-card.paper{border-radius:12px;padding:34px 34px 26px;gap:14px;background:var(--q-bg)}
.st-pile.paper .st-back{border-radius:12px}
.st-pile.paper .st-back.b1{left:4px;right:4px;top:4px;bottom:-4px;transform:rotate(-3.5deg)}
.st-pile.paper .st-back.b2{left:6px;right:6px;top:6px;bottom:-6px;transform:rotate(5deg)}
.st-paper-who{font-size:15px;color:var(--q-muted)}
.st-card.paper .st-num b{font-size:clamp(44px,5vw,60px);color:var(--q-text)}
.st-card.paper .st-num small{color:var(--q-muted)}
.st-bars{display:flex;flex-direction:column;gap:11px;margin:18px 0 8px}
.st-bars i{display:block;height:10px;border-radius:5px;background:color-mix(in srgb,var(--q-text) 7%,var(--q-bg))}
.st-card.paper .st-body{padding:10px 0 0}
.st-stamp{position:absolute;right:26px;top:26px;padding:8px 16px;border:4px solid currentColor;border-radius:12px;font-size:19px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;line-height:1.1;color:var(--q-muted);transform:rotate(-12deg);background:color-mix(in srgb,var(--q-bg) 70%,transparent);animation:st-stamp .35s var(--st-ease) both;pointer-events:none}
.st-stamp.main{color:var(--q-good)}
.st-card.paper .st-stamp{top:96px}
.st-acts{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:clamp(30px,5vh,48px);min-height:48px;width:min(560px,100%)}
.st .st-b{min-width:112px;min-height:48px;padding:0 24px;border-radius:14px;border:1px solid color-mix(in srgb,var(--q-text) 16%,transparent);background:var(--q-bg);color:var(--q-text);font:600 15px/1.2 var(--q-font);cursor:pointer;transition:transform .15s var(--st-ease),background .2s,opacity .2s}
.st .st-b:hover{background:color-mix(in srgb,var(--q-text) 5%,var(--q-bg))}
.st .st-b:active{transform:translateY(1px)}
.st .st-b.main{background:var(--q-text);border-color:var(--q-text);color:var(--q-bg)}
.st .st-b.main:hover{background:color-mix(in srgb,var(--q-text) 86%,var(--q-bg))}
.st .st-b:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.st .st-b[aria-busy=true]{opacity:.6;cursor:progress}
.st .st-b[disabled]{opacity:.45;cursor:default}
.st-wait{display:flex;align-items:center;gap:8px;min-height:48px;font-size:15px;color:var(--q-muted)}
.st-wait i{display:block;width:9px;height:9px;border-radius:50%;border:1.6px dashed var(--q-muted)}
.st-why{width:min(560px,100%);min-height:20px;margin:12px 0 0;font-size:14px;line-height:1.35;text-align:center;color:var(--q-muted)}
.st-tell{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:4px}
.st .st-tell-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:40px;min-height:40px;padding:0 16px 0 12px;border:0;border-radius:999px;background:none;color:var(--q-muted);font-size:14px;font-weight:550;line-height:1.2;cursor:pointer;transition:background .2s,color .2s}
.st .st-tell-b:hover{background:color-mix(in srgb,var(--q-text) 6%,transparent);color:var(--q-text)}
.st .st-tell-b:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.st .st-tell-b svg{flex:none;width:17px;height:17px}
.st .st-tell-b.st-bare{padding:0}
.st .st-tell-b[aria-busy=true]{opacity:.55;cursor:progress}
.st .st-tell-b.st-told{cursor:default}
.st .st-tell-b.st-told svg{color:var(--q-good)}
.st-tell-why{margin:0;font-size:13px;color:var(--q-muted);max-width:22em}
.st-done{display:flex;flex-direction:column;align-items:center;gap:14px;margin-top:clamp(40px,12vh,130px);text-align:center;animation:st-enter .7s var(--st-ease) both}
.st-done .st-fig{width:120px;height:120px}
.st-done-mark{display:grid;place-items:center;width:120px;height:120px;border-radius:50%;background:color-mix(in srgb,var(--q-good) 16%,var(--q-bg));color:var(--q-good)}
.st-done-mark svg{width:52px;height:52px}
.st-done h2{margin:6px 0 0;font-size:clamp(24px,2.6vw,30px);font-weight:700;letter-spacing:-.02em}
.st-done p{margin:0;font-size:15px;color:var(--q-muted)}
.st-quiet{margin:0;font-size:15px;color:var(--q-muted)}
@keyframes st-enter{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
@keyframes st-stamp{from{opacity:0;transform:rotate(-12deg) scale(1.6)}to{opacity:1;transform:rotate(-12deg) scale(1)}}
@media (max-width:560px){
 .st-stage{justify-content:flex-start}
 .st-total{text-align:left;width:100%}
 .st-field:not(.pic){height:clamp(180px,34vh,260px);padding:20px 22px}
 .st-body{padding:16px 18px 18px;gap:12px}
 .st-fig{width:44px;height:44px}
 .st-card.paper{padding:26px 22px 20px}
 .st-acts{gap:10px}
 .st .st-b{flex:1 1 0;min-width:0;padding:0 12px}
}
@media (prefers-reduced-motion:reduce){.st *,.st *::before,.st *::after{transition:none!important;animation:none!important}}
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
	function svg(markup, size) {
		const el = D.createElementNS("http://www.w3.org/2000/svg", "svg");
		el.setAttribute("viewBox", `0 0 ${size} ${size}`);
		el.setAttribute("aria-hidden", "true");
		el.setAttribute("fill", "none");
		el.setAttribute("stroke", "currentColor");
		el.setAttribute("stroke-width", "2");
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		el.innerHTML = markup;
		return el;
	}
	const say = (tpl, map) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : ""));
	const norm = (t) => text(t).toLowerCase().replace(/\s+/g, " ").trim();
	const esc = (t) => (window.CSS && window.CSS.escape ? window.CSS.escape(t) : String(t).replace(/["\\]/g, "\\$&"));
	// A picture the page names (kitPage): its own element, whose src the frame has set.
	function media(path) {
		if (!path) return null;
		return D.querySelector(`#kit-media [data-kit-src="${esc(path)}"]`);
	}
	function toneVar(tone) {
		if (tone === "violet") return "color-mix(in srgb,var(--q-accent) 55%,var(--q-bad))";
		if (tone === "teal") return "color-mix(in srgb,var(--q-good) 60%,var(--q-accent))";
		if (tone === "plain") return "var(--q-muted)";
		return `var(--q-${tone})`;
	}
	// The agent's figure from the page (kitPage carries the ones the data names), or its initial in a soft circle.
	function figureEl(id, name) {
		const found = id ? media(`figure:${id}`) : null;
		if (found && found.getAttribute("src")) {
			const img = h("img", null, { src: found.getAttribute("src"), alt: name || "" });
			return h("span", "st-fig", null, img);
		}
		const first = Array.from(name || "")[0];
		return first ? h("span", "st-fig ini", { "aria-hidden": "true" }, first.toUpperCase()) : null;
	}

	// The page's own element: it takes the place of the one before and leaves the rest of the body (the pictures the
	// page names in #kit-media) where it is.
	function show(main) {
		for (const old of D.querySelectorAll("body > main.st")) old.remove();
		D.body.append(main);
	}

	// ---------------------------------------------------------------- data
	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...WORDS };
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const seen = new Set();
		const cards = [];
		for (const c of list(raw.cards)) {
			if (!isObj(c) || cards.length >= MAX.cards) continue;
			const title = cut(c.title, MAX.card);
			if (!title) continue;
			let id = text(c.id).trim().slice(0, 64) || `card-${cards.length + 1}`;
			while (seen.has(id)) id += "+";
			seen.add(id);
			const value = num(c.value);
			const state = STATES.includes(c.state) ? c.state : "known";
			cards.push({
				id,
				title,
				// the whole title, normalised before the cut: a question's title is matched against it
				match: norm(c.title),
				value: state === "unknown" ? null : value,
				state: value === null && c.value !== undefined && typeof c.value !== "string" ? "unknown" : state,
				valueText: typeof c.value === "string" && value === null ? cut(c.value, MAX.valueText) : "",
				unit: cut(c.unit, MAX.unit),
				line: cut(c.line, MAX.cardLine),
				picture: typeof c.picture === "string" ? c.picture : "",
				tone: [...TONES, "plain"].includes(c.colour) ? c.colour : TONES[cards.length % TONES.length],
				by: cut(c.by, MAX.by),
				figure: typeof c.figure === "string" ? c.figure : "",
				paper: c.paper === true,
				question: text(c.question).trim(),
				answer: c.answer !== undefined && c.answer !== null && c.answer !== false ? cut(c.answer === true ? "" : c.answer, MAX.stamp) || "✓" : null,
				stamp: cut(c.stamp, MAX.stamp),
				ask: typeof c.ask === "string" && Array.from(c.ask.replace(/\s+/g, " ").trim()).length <= 40 ? c.ask.replace(/\s+/g, " ").trim() : "",
			});
		}
		let total = null;
		if (isObj(raw.total)) {
			const value = num(raw.total.value);
			const state = STATES.includes(raw.total.state) ? raw.total.state : value === null ? "unknown" : "known";
			total = { value: state === "unknown" ? null : value, state, unit: cut(raw.total.unit, MAX.unit), label: cut(raw.total.label, MAX.label) };
		}
		return { lang, words, title: cut(raw.title, MAX.title), line: cut(raw.line, MAX.line), cards, total };
	}
	function formatter(lang) {
		let nf;
		try {
			nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
		} catch {
			nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
		}
		return (v) => nf.format(v);
	}

	// ---------------------------------------------------------------- a note to the app's owner
	// qorpera.tell (RUNTIME-INTERFACE-APPS.md §3b and §5): one quiet button under a card's answers, drawn only where the
	// bridge has `tell` and the words name it. It asks from a press on it alone, once per press; the member writes the
	// note on Qorpera's bar above the page.
	const TELL_AT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
	const TOLD = new Map();
	const QUIET = new Map();
	const canTell = () => !!(window.qorpera && typeof window.qorpera.tell === "function");
	const TELL_ICON = {
		note: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.2L7 19.5V16a2.5 2.5 0 0 1-2.5-2.5z"/>',
		tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
	};
	function tellFoot(words, about, id, ask) {
		if (!canTell() || !about || !words.tell) return null;
		const at = TELL_AT.test(id || "") ? id : null;
		const key = `${id}\n${about}`;
		const b = h("button", "st-tell-b", { type: "button" });
		const why = h("p", "st-tell-why", { role: "status", "aria-live": "polite" });
		const paint = () => {
			const st = TOLD.get(key) || {};
			const label = st.done ? words.told : words.tell;
			b.replaceChildren(svg(st.done ? TELL_ICON.tick : TELL_ICON.note, 24));
			if (label) b.append(h("span", null, null, label));
			b.classList.toggle("st-bare", !label);
			b.classList.toggle("st-told", !!st.done);
			if (label) b.removeAttribute("aria-label");
			else b.setAttribute("aria-label", st.done ? "Sent" : "Send a note");
			b.setAttribute("aria-busy", String(!!st.busy));
			if (st.done) b.setAttribute("aria-disabled", "true");
			else b.removeAttribute("aria-disabled");
			why.textContent = st.why || "";
		};
		b.__tell = { key, paint };
		b.addEventListener("click", async () => {
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
				for (const x of D.querySelectorAll(".st-tell-b")) if (x.__tell && x.__tell.key === key) x.__tell.paint();
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
		return h("div", "st-tell", null, b, why);
	}

	// ---------------------------------------------------------------- state
	const S = {
		model: null,
		text: null,
		root: null,
		// the open questions as last read, and whether a read has worked yet
		qs: [],
		read: false,
		retry: 0,
		// card id -> the question id it was seen with, so a question answered elsewhere marks its card done
		seen: new Map(),
		// card id -> { label, main }: answered on this page, or elsewhere while it was open
		answered: new Map(),
		// ids of the questions answered on this page: a read that began before the answer may still list them
		gone: new Set(),
		// the card in front, by id, and the one being answered or leaving
		at: null,
		busy: null,
		leaving: null,
		why: new Map(),
		first: true,
	};

	// Each card with the open question that is its own: by the question's id, or by its whole title, which is the
	// card's. A card already done takes none: the same ask again (each month's bill) is a new question, not the old card's.
	function deal() {
		const m = S.model;
		const used = new Set();
		const cards = m.cards.map((c) => {
			if (c.answer !== null || S.answered.has(c.id)) return { ...c, q: null };
			const q = S.qs.find((x) => !used.has(x.id) && ((c.question && x.id === c.question) || norm(x.title) === c.match)) || null;
			if (q) used.add(q.id);
			return { ...c, q };
		});
		// open questions that point at the app and that no card names: drawn as plain cards, so nothing open is hidden
		for (const q of S.qs) {
			if (used.has(q.id)) continue;
			cards.push({
				id: `q:${q.id}`,
				title: cut(q.title, MAX.card),
				value: null,
				state: "known",
				valueText: "",
				unit: "",
				line: cut(text(q.body).split("\n")[0], MAX.cardLine),
				picture: "",
				tone: TONES[cards.length % TONES.length],
				by: cut(q.agent, MAX.by),
				figure: "",
				paper: false,
				question: q.id,
				answer: null,
				stamp: "",
				ask: "",
				q,
			});
		}
		const done = [];
		const open = [];
		const waiting = [];
		for (const c of cards) {
			if (c.answer !== null || S.answered.has(c.id)) done.push(c);
			else if (c.q) open.push(c);
			else waiting.push(c);
		}
		return { done, pile: [...open, ...waiting] };
	}

	// ---------------------------------------------------------------- drawing
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "stack" }, CSS);
		D.head.append(style);
	}
	function quiet(line) {
		ensureStyle();
		show(h("main", `st${BARE ? " st--bare" : ""}`, null, h("p", "st-quiet", null, line)));
		S.root = null;
	}
	function numEl(c, fmt) {
		if (c.valueText) return h("div", "st-num", null, h("b", "txt", null, c.valueText));
		if (c.value === null && c.state !== "unknown") return null;
		const row = h("div", "st-num", null, c.value === null ? h("b", "unk", null, "?") : h("b", null, null, fmt(c.value)));
		if (c.value !== null && c.unit) row.append(h("small", null, null, c.unit));
		if (c.state === "assumed") row.append(h("span", "st-tag", null, S.model.words.assumed));
		return row;
	}

	function cardEl(c, fmt, enter) {
		const words = S.model.words;
		const card = h("article", `st-card${c.paper ? " paper" : ""}${enter && !still() ? " enter" : ""}`, { "aria-label": c.title, "data-id": c.id });
		card.style.setProperty("--st-tone", toneVar(c.tone));
		const fig = figureEl(c.figure, c.by);
		const ask = h("div", "st-ask", null, h("h2", null, null, c.title), c.by ? h("p", null, null, c.by) : null);
		if (c.paper) {
			if (c.line) card.append(h("div", "st-paper-who", null, c.line));
			const n = numEl(c, fmt);
			if (n) card.append(n);
			card.append(h("div", "st-bars", { "aria-hidden": "true" }, h("i", null, { style: "width:82%" }), h("i", null, { style: "width:61%" }), h("i", null, { style: "width:72%" }), h("i", null, { style: "width:38%" })));
			card.append(h("div", "st-body", null, fig, ask));
		} else {
			const pic = c.picture ? media(c.picture) : null;
			const field = h("div", `st-field${c.picture ? " pic" : ""}`);
			if (c.picture) {
				if (pic && pic.getAttribute("src")) field.append(h("img", null, { src: pic.getAttribute("src"), alt: "" }));
				else field.append(h("span", "st-ph", { "aria-hidden": "true" }, "?"));
			} else {
				const n = numEl(c, fmt);
				if (n) field.append(n);
				if (c.line) field.append(h("div", "st-fline", null, c.line));
			}
			card.append(field);
			const body = h("div", "st-body", null, fig, ask);
			if (c.picture) {
				const n = numEl(c, fmt);
				if (n) body.append(h("div", "st-side", null, n));
				if (c.line) ask.append(h("p", null, null, c.line));
			}
			card.append(body);
		}
		const stamp = S.answered.get(c.id);
		if (stamp) card.append(h("span", `st-stamp${stamp.main ? " main" : ""}`, null, stamp.label || "✓"));
		return card;
	}

	function paint() {
		const m = S.model;
		if (!m) return;
		ensureStyle();
		const fmt = formatter(m.lang);
		const words = m.words;
		const focusKey = D.activeElement && D.activeElement.dataset ? D.activeElement.dataset.key : null;
		const { done, pile } = deal();
		const front = pile.find((c) => c.id === S.at) || pile[0] || null;
		S.at = front ? front.id : null;

		const root = h("main", `st${BARE ? " st--bare" : ""}`, { lang: m.lang });
		const top = h("div", "st-top");
		top.append(h("header", "st-head", null, h("h1", "st-title", null, m.title || ""), m.line ? h("p", "st-line", null, m.line) : null));
		if (m.total) {
			const t = m.total;
			const n = h("div", `st-total-n${t.value === null ? " unk" : ""}`, null, t.value === null ? "?" : fmt(t.value));
			if (t.value !== null && t.unit) n.append(h("small", null, null, t.unit));
			top.append(h("div", "st-total", null, n, t.label ? h("div", "st-total-l", null, t.label) : null));
		}
		root.append(top);
		const stage = h("section", "st-stage");
		root.append(stage);

		if (!front) {
			// all done: the asking agent's figure when there is one, else a tick, and how many were answered
			const lastFig = [...done].reverse().find((c) => c.figure && media(`figure:${c.figure}`));
			const mark = lastFig ? figureEl(lastFig.figure, lastFig.by) : h("span", "st-done-mark", null, svg('<path d="M10 25.5l9 9L38 15"/>', 48));
			const count = done.length;
			stage.append(h("div", "st-done", { role: "status" }, mark, h("h2", null, null, words.done), count ? h("p", null, null, say(words.answered, { n: String(count) })) : null));
		} else {
			// progress: one dot a card, the answered ones dark, the one in front long; the waiting ones open it
			const total = done.length + pile.length;
			const dots = h("div", "st-dots", { role: "group", "aria-label": say(words.card, { n: String(done.length + pile.indexOf(front) + 1), total: String(total) }) });
			for (let k = 0; k < done.length; k++) dots.append(h("span", "st-dot done", { "aria-hidden": "true" }, h("i")));
			pile.forEach((c, k) => {
				const on = c.id === front.id;
				const b = h("button", `st-dot${on ? " on" : ""}`, { type: "button", "aria-label": `${c.title} · ${say(words.card, { n: String(done.length + k + 1), total: String(total) })}`, "aria-current": on ? "true" : null, "data-key": `dot:${c.id}` }, h("i"));
				b.addEventListener("click", () => {
					if (S.busy) return;
					S.at = c.id;
					paint();
				});
				dots.append(b);
			});
			if (total > 1) stage.append(dots);
			const pileEl = h("div", `st-pile${front.paper ? " paper" : ""}`);
			if (pile.length > 2) pileEl.append(h("div", "st-back b2", { "aria-hidden": "true" }));
			if (pile.length > 1) pileEl.append(h("div", "st-back b1", { "aria-hidden": "true" }));
			const enter = S.first || S.entering === front.id;
			S.entering = null;
			pileEl.append(cardEl(front, fmt, enter));
			stage.append(pileEl);

			// the answers: the open question's options, the last one the main one
			const acts = h("div", "st-acts");
			const q = front.q;
			if (q && q.options.length) {
				q.options.forEach((o, k) => {
					const main = k === q.options.length - 1;
					const busy = S.busy === `${front.id}\n${o.value}`;
					const b = h("button", `st-b${main ? " main" : ""}`, { type: "button", "data-key": `answer:${front.id}:${o.value}`, "aria-busy": busy ? "true" : null, title: o.description || null }, busy ? words.saving : cut(o.label, MAX.label) || text(o.value));
					if (S.busy && !busy) b.disabled = true;
					b.addEventListener("click", () => answer(front, o, main));
					acts.append(b);
				});
			} else acts.append(h("div", "st-wait", null, h("i", null, { "aria-hidden": "true" }), words.waiting));
			stage.append(acts);
			stage.append(h("p", "st-why", { role: "status", "aria-live": "polite" }, S.why.get(front.id) || ""));
			const tell = tellFoot(words, front.title, front.id.startsWith("q:") ? "" : front.id, front.ask);
			if (tell) stage.append(tell);
		}
		show(root);
		S.root = root;
		S.first = false;
		if (focusKey) {
			const back = root.querySelector(`[data-key="${esc(focusKey)}"]`);
			if (back) back.focus({ preventScroll: true });
		}
	}

	// ---------------------------------------------------------------- answering
	async function answer(card, option, main) {
		if (S.busy || !card.q || !window.qorpera || typeof window.qorpera.answer !== "function") return;
		S.busy = `${card.id}\n${option.value}`;
		S.why.delete(card.id);
		paint();
		try {
			await window.qorpera.answer(card.q.id, card.q.multiSelect ? [option.value] : option.value);
		} catch (err) {
			S.busy = null;
			S.why.set(card.id, cut((err && err.message) || String(err || ""), 140) || "—");
			paint();
			return;
		}
		// answered: the card is stamped with the answer, then leaves, and the next comes forward
		S.busy = null;
		S.answered.set(card.id, { label: card.stamp || cut(option.label, MAX.stamp), main });
		S.gone.add(card.q.id);
		S.qs = S.qs.filter((q) => q.id !== card.q.id);
		const el = S.root && S.root.querySelector(`.st-card[data-id="${esc(card.id)}"]`);
		if (el) el.append(h("span", `st-stamp${main ? " main" : ""}`, null, card.stamp || cut(option.label, MAX.stamp)));
		for (const b of S.root ? S.root.querySelectorAll(".st-b") : []) {
			b.disabled = true;
			if (b.dataset.key === `answer:${card.id}:${option.value}`) {
				b.removeAttribute("aria-busy");
				b.textContent = cut(option.label, MAX.label) || text(option.value);
			}
		}
		const next = () => {
			const { pile } = deal();
			const after = pile.find((c) => c.id !== card.id);
			S.at = after ? after.id : null;
			S.entering = S.at;
			paint();
			const first = S.root && S.root.querySelector(".st-acts .st-b, .st-dot.on");
			if (first) first.focus({ preventScroll: true });
		};
		if (still() || !el) next();
		else {
			setTimeout(() => el.classList.add("leave"), 650);
			setTimeout(next, 1150);
		}
	}

	// ---------------------------------------------------------------- the open questions
	async function ask() {
		clearTimeout(S.retry);
		const bridge = window.qorpera;
		if (!bridge || typeof bridge.questions !== "function") return;
		let qs;
		try {
			qs = list(await bridge.questions()).filter((q) => isObj(q) && q.id && Array.isArray(q.options) && !S.gone.has(String(q.id)));
		} catch {
			// keep the questions the page shows, and ask again ten seconds later, until a read works
			S.retry = setTimeout(ask, 10000);
			return;
		}
		S.qs = qs.map((q) => ({
			id: String(q.id),
			agent: text(q.agent),
			title: text(q.title),
			body: text(q.body),
			multiSelect: q.multiSelect === true,
			options: q.options.filter(isObj).map((o) => ({ label: text(o.label), value: text(o.value), description: text(o.description) })),
		}));
		S.read = true;
		// a card whose question was open and is no longer was answered elsewhere, in the chat: it is done
		if (S.model) {
			const { pile } = deal();
			const open = new Map(pile.filter((c) => c.q).map((c) => [c.id, c.q.id]));
			for (const [id, qid] of S.seen) if (!open.has(id) && !S.answered.has(id) && !S.qs.some((q) => q.id === qid)) S.answered.set(id, { label: "", main: true });
			S.seen = new Map([...S.seen, ...open]);
		}
		if (!S.busy) paint();
	}

	// ---------------------------------------------------------------- loading
	let lastRead = 0;
	let pending = 0;
	async function load() {
		lastRead = Date.now();
		let txt;
		let raw = null;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			// the page puts the company's live values in place of the data's bindings
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "stack.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			if (txt !== S.text || !S.root) {
				raw = JSON.parse(txt);
				S.model = normalize(raw);
				S.text = txt;
				D.documentElement.lang = S.model.lang;
				if (!S.busy) paint();
			}
		} catch {
			if (!S.root) quiet((raw && isObj(raw.words) && cut(raw.words.empty, 60)) || WORDS.empty);
			// a read that gave no text: keep what is shown, and read again ten seconds later, until a read works
			if (typeof txt !== "string") {
				clearTimeout(pending);
				pending = setTimeout(load, 10000);
			}
			return;
		}
		// open questions come and go by themselves: read them again with every load
		await ask();
	}
	function onChange() {
		clearTimeout(pending);
		pending = setTimeout(load, Math.max(0, lastRead + 10000 - Date.now()));
	}
	D.addEventListener("keydown", (e) => {
		if (!S.root || S.busy || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const t = e.target;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
		const { pile } = deal();
		const k = pile.findIndex((c) => c.id === S.at);
		const next = pile[k + (e.key === "ArrowRight" ? 1 : -1)];
		if (!next) return;
		S.at = next.id;
		S.entering = next.id;
		paint();
	});
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
