// The map kit's engine: "What are we making, and who is at it?"
// The company, or one owner's area, as one picture: three to seven things, each its shape, pale and filled from the
// bottom as far as it is known or built; the agents' figures at the things they work on, a mark where a thing waits
// for a member; layers a member opens (a product opens into its parts), zoomed into with a spring. The first layer of
// the company's own map is its reading of itself, live through qorpera.reading(): the company's sentence as the title,
// the thing it attends to biggest and in the middle, a quiet line of what changed with "Not right?", and grey and still
// while the company cannot run. Where things stand is this engine's rule, never the data's.
// The agent writes only map.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: no title block (kitPage says so, never the data).
	const BARE = KIT.concept === true;
	const D = document;
	const MAX = { title: 40, line: 60, sentence: 200, name: 24, rname: 40, note: 40, word: 120, top: 7, layer: 12, all: 80, depth: 4, agents: 4, crumb: 40, change: 120, draft: 280, about: 60 };
	const EN = {
		finding: "We are finding our feet. The first reading comes with the next plan.",
		stood: "We have stood still since {time}.",
		stoodNow: "We have stood still.",
		full: "Your ChatGPT is full, so none of us can work.",
		fullOf: "{member}'s ChatGPT is full, so none of us can work.",
		opensAt: "It opens again at {time}.",
		opensOn: "It opens again on {date}.",
		signIn: "Your ChatGPT needs a new sign-in, so none of us can work.",
		signInOf: "{member}'s ChatGPT needs a new sign-in, so none of us can work.",
		noLogin: "You have not connected ChatGPT, so none of us can work.",
		noLoginOf: "{member} has no ChatGPT yet, so none of us can work.",
		notRight: "Not right?",
		draft: "Not right: {changes}.",
		changed: "What changed",
		where: "Where you are",
		open: "opens",
		leaves: "opens elsewhere",
		working: "working",
		waits: "waits for a founder",
		unknown: "not known",
		assumed: "assumed",
		weeks: "{n} w",
		months: "{n} mo",
		source: "Source",
		empty: "Nothing to show yet.",
		// a note to the app's owner from "Not right?": what the pill says once the note went
		tell: "",
		told: "Sent",
	};
	const DA = {
		finding: "Vi er ved at finde fodfæste. Den første aflæsning kommer med den næste plan.",
		stood: "Vi har stået stille siden {time}.",
		stoodNow: "Vi har stået stille.",
		full: "Din ChatGPT er fuld, så ingen af os kan arbejde.",
		fullOf: "{member}s ChatGPT er fuld, så ingen af os kan arbejde.",
		opensAt: "Den åbner igen kl. {time}.",
		opensOn: "Den åbner igen den {date}.",
		signIn: "Din ChatGPT skal logges ind igen, så ingen af os kan arbejde.",
		signInOf: "{member}s ChatGPT skal logges ind igen, så ingen af os kan arbejde.",
		noLogin: "Du har ikke forbundet ChatGPT, så ingen af os kan arbejde.",
		noLoginOf: "{member} har ingen ChatGPT endnu, så ingen af os kan arbejde.",
		notRight: "Ikke rigtigt?",
		draft: "Ikke rigtigt: {changes}.",
		changed: "Hvad der er ændret",
		where: "Hvor du er",
		open: "åbner",
		leaves: "åbner et andet sted",
		working: "arbejder",
		waits: "venter på en stifter",
		unknown: "ikke kendt",
		assumed: "antaget",
		weeks: "{n} u",
		months: "{n} md",
		source: "Kilde",
		empty: "Intet at vise endnu.",
		tell: "",
		told: "Sendt",
	};
	const STATES = ["known", "assumed", "unknown"];
	const SHAPE_NAMES = ["board", "box", "screen", "phone", "gear", "code", "person", "people", "heart", "pin", "globe", "chart", "coin", "bank", "drop", "megaphone", "cart", "handshake", "truck", "factory", "scale", "document", "chat", "wrench", "blob"];
	const ID = /^[A-Za-z0-9-]{1,64}$/;
	const STALE_DAYS = 14;
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const calm = () => reduceMQ.matches;

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.mp{position:relative;box-sizing:border-box;min-height:100vh;display:flex;flex-direction:column;background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --mp-solid:var(--q-accent);--mp-pale:color-mix(in srgb,var(--mp-solid) 17%,var(--q-bg));--mp-dash:var(--q-muted);
 --mp-spring:cubic-bezier(.3,1.25,.5,1);--mp-t:520ms;--mp-out:cubic-bezier(.2,.7,.2,1);--u:1px}
@supports (transition-timing-function:linear(0,1)){.mp{--mp-spring:linear(0,.009,.035 2.1%,.141 4.4%,.723 15.4%,.938 22.4%,1.017 28.1%,1.044 33.6%,1.045 38.7%,1.025 48.3%,1.004 61.3%,.998 77.6%,1)}}
.mp *,.mp *::before,.mp *::after{box-sizing:border-box}
.mp.is-still{--mp-solid:color-mix(in srgb,var(--q-muted) 70%,var(--q-bg));--mp-pale:color-mix(in srgb,var(--q-muted) 16%,var(--q-bg))}
.mp-head{flex:none;display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:640px;padding:38px 43px 0}
.mp-title{margin:0;font-size:23px;font-weight:700;line-height:29px;letter-spacing:-.01em;text-wrap:pretty}
.mp-titles{display:flex;align-items:flex-start;gap:12px}
.mp-here{position:relative;flex:none;width:var(--hs);height:var(--hs);margin-top:-2px;--hs:34px}
.mp-here .mp-fill .mp-solid{height:var(--hs)}
.mp-here[hidden]{display:none}
.mp-here svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.mp-here path{fill-rule:evenodd;stroke-width:5;stroke-linejoin:round}
.mp-line{margin:0;color:var(--q-muted);font-size:14px;line-height:20px}
.mp-src{font-size:13px;color:var(--q-muted);text-decoration:none}
.mp-src:hover{color:var(--q-accent)}
.mp--bare .mp-head{display:none}
.mp-trail{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;padding:18px 43px 0;font-size:13px;line-height:18px;color:var(--q-muted)}
.mp-trail[hidden]{display:none}
.mp .mp-crumb{max-width:24em;padding:2px 6px;margin:0 -2px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp .mp-crumb:hover{background:color-mix(in srgb,var(--q-text) 6%,transparent);color:var(--q-text)}
.mp .mp-crumb:focus-visible{outline:2px solid var(--q-accent);outline-offset:1px}
.mp-trail span[aria-current]{padding:2px 4px;color:var(--q-text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:24em}
.mp-sep{color:color-mix(in srgb,var(--q-muted) 60%,var(--q-bg))}
.mp-stage{flex:1 1 auto;min-height:0;display:flex;padding:12px 0}
.mp-canvas{position:relative;flex:none;margin:auto;overflow:visible}
.mp-thing{position:absolute;z-index:1;display:flex;flex-direction:column;align-items:center;transition:left var(--mp-t) var(--mp-spring),top var(--mp-t) var(--mp-spring),width var(--mp-t) var(--mp-spring)}
.mp .mp-hit{display:flex;flex-direction:column;align-items:center;max-width:100%;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:center;text-decoration:none;border-radius:16px}
.mp button.mp-hit,.mp a.mp-hit{cursor:pointer}
.mp .mp-hit:focus-visible{outline:2px solid var(--q-accent);outline-offset:6px}
.mp-shape{position:relative;flex:none;transition:width var(--mp-t) var(--mp-spring),height var(--mp-t) var(--mp-spring),transform .35s var(--mp-out)}
.mp-hit:is(button,a):hover .mp-shape,.mp-hit:is(button,a):focus-visible .mp-shape{transform:translateY(-5px)}
.mp-shape svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.mp-shape path{fill-rule:evenodd;stroke-width:5;stroke-linejoin:round;transition:fill .4s ease,stroke .4s ease}
.mp-pale path{fill:var(--mp-pale);stroke:var(--mp-pale)}
.mp-solid path{fill:var(--mp-solid);stroke:var(--mp-solid)}
.mp-dash{opacity:0;transition:opacity .4s ease}
.mp-dash path{fill:none;stroke:var(--mp-dash);stroke-width:2.6;stroke-dasharray:6 7;stroke-linecap:round}
.mp-pale{transition:opacity .4s ease}
.mp-fill{position:absolute;left:0;bottom:0;width:100%;overflow:hidden;transition:height var(--mp-t) var(--mp-out)}
.mp-fill .mp-solid{top:auto;bottom:0}
.mp-thing.is-empty .mp-dash,.mp-thing.is-unknown .mp-dash,.mp-thing.is-assumed .mp-dash{opacity:1}
.mp-thing.is-empty .mp-pale,.mp-thing.is-unknown .mp-pale,.mp-thing.is-unknown .mp-fill,.mp-thing.is-assumed .mp-fill{opacity:0}
.mp-thing.is-assumed .mp-dash{z-index:1}
.mp-thing.is-stale .mp-shape{opacity:.5}
.mp-thing.is-stale .mp-solid path{fill:var(--mp-pale);stroke:var(--mp-pale)}
.mp-thing.is-stale .mp-pale path{fill:color-mix(in srgb,var(--mp-pale) 55%,var(--q-bg));stroke:color-mix(in srgb,var(--mp-pale) 55%,var(--q-bg))}
.mp-q{position:absolute;transform:translate(-50%,-50%);color:var(--q-muted);font-weight:600;font-size:calc(var(--s) * .2);line-height:1}
.mp-q[hidden]{display:none}
.mp-mark{position:absolute;right:-2%;top:-2%;display:grid;place-items:center;width:calc(26 * var(--u));height:calc(26 * var(--u));border-radius:50%;background:var(--q-bg);color:var(--q-muted);box-shadow:0 0 0 1px color-mix(in srgb,var(--q-text) 12%,transparent);transition:transform .3s var(--mp-out),color .2s}
.mp-mark svg{position:static;width:58%;height:58%}
.mp-hit:is(button,a):hover .mp-mark,.mp-hit:is(button,a):focus-visible .mp-mark{color:var(--q-accent);transform:scale(1.15)}
.mp-name{display:-webkit-box;max-width:100%;padding-top:calc(12 * var(--u));overflow:hidden;color:var(--q-text);font-size:calc(16 * var(--u));font-weight:600;line-height:calc(22 * var(--u));-webkit-box-orient:vertical;-webkit-line-clamp:2}
.mp-label{max-width:100%;overflow:hidden;color:var(--q-muted);font-size:calc(14 * var(--u));line-height:calc(20 * var(--u));text-overflow:ellipsis;white-space:nowrap}
.mp-fig{position:absolute;z-index:2;display:block;border-radius:50%;transition:left var(--mp-t) var(--mp-spring),top var(--mp-t) var(--mp-spring),width var(--mp-t) var(--mp-spring),height var(--mp-t) var(--mp-spring)}
.mp-fig img{display:block;width:100%;height:100%;object-fit:contain}
.mp-fig.ini,.mp-face{display:grid;place-items:center;background:color-mix(in srgb,var(--q-accent) 14%,var(--q-bg));color:var(--q-accent);font-weight:650;font-size:calc(var(--f) * .36)}
.mp-face{background:color-mix(in srgb,var(--q-text) 52%,var(--q-bg));color:var(--q-bg);box-shadow:0 0 0 calc(3 * var(--u)) var(--q-bg),0 1px 4px rgb(0 0 0 / 18%)}
.mp-face.me,.mp-face.founder{background:var(--q-accent);color:var(--q-on-accent,#fff)}
.mp-face svg{width:62%;height:62%}
.mp-face svg path{fill:currentColor}
.mp-dot{position:absolute;right:-2%;bottom:-4%;width:26%;height:26%;border-radius:50%;background:var(--q-good);box-shadow:0 0 0 2px var(--q-bg)}
.mp.is-still .mp-fig img{filter:grayscale(1);opacity:.6}
.mp.is-still .mp-dot{display:none}
.mp.is-still .mp-face{filter:grayscale(1);opacity:.7}
.mp.is-still *,.mp.is-still *::before,.mp.is-still *::after{transition:none!important;animation:none!important}
.mp-fig.is-arriving{animation:mp-arrive 1200ms both}
@keyframes mp-arrive{0%{opacity:0;transform:translateX(80%) rotate(6deg);animation-timing-function:var(--mp-out)}36%{opacity:1;transform:translateX(-4%) rotate(-1deg)}100%{transform:none}}
.mp-thing.is-arriving{animation:mp-grow var(--mp-t) var(--mp-spring) both}
@keyframes mp-grow{from{opacity:0;transform:scale(.6)}}
.mp-thing.is-zoomed{animation:mp-in calc(var(--mp-t) * 1.1) var(--mp-out) both;animation-delay:calc(140ms + var(--i) * 35ms)}
@keyframes mp-in{from{opacity:0;transform:translateY(10px) scale(.86)}}
.mp-canvas.is-row{display:flex;flex-wrap:wrap;justify-content:center;gap:18px;max-width:640px;padding:24px}
.mp-fig.is-flow{position:relative;flex:none}
.mp-changes{flex:none;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 8px;padding:6px 24px 18px;font-size:12px;line-height:18px}
.mp-changes[hidden]{display:none}
.mp-change{display:inline-flex;align-items:center;gap:7px}
.mp-change .mp-fig{position:relative;flex:none;width:22px;height:22px}
.mp-change.is-ended .mp-fig img{filter:grayscale(1);opacity:.6}
.mp-cdot{color:var(--q-muted)}
.mp .mp-pill{display:inline-flex;align-items:center;gap:6px;min-height:26px;margin-left:6px;padding:3px 12px;border:1px solid color-mix(in srgb,var(--q-text) 22%,var(--q-bg));border-radius:999px;background:var(--q-bg);color:var(--q-text);font:inherit;font-size:11px;font-weight:500;cursor:pointer}
.mp .mp-pill:hover{background:color-mix(in srgb,var(--q-text) 6%,var(--q-bg))}
.mp .mp-pill:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.mp .mp-pill[aria-busy=true]{opacity:.55;cursor:progress}
.mp .mp-pill.told{border-color:transparent;color:var(--q-muted);cursor:default}
.mp-why{flex-basis:100%;margin:0;text-align:center;color:var(--q-muted);font-size:12px}
.mp-quiet{margin:auto;color:var(--q-muted);font-size:15px}
@media (max-width:600px){.mp-head{padding:22px 20px 0}.mp-title{font-size:20px;line-height:26px}.mp-here{--hs:29px}.mp-trail{padding:14px 20px 0}}
@media (prefers-reduced-motion:reduce){.mp *,.mp *::before,.mp *::after{transition:none!important;animation:none!important}}
`;

	// ---------------------------------------------------------------- the shapes
	// One path per name, one solid shape with white cuts in a 100 x 100 box (the cuts are subpaths: fill-rule evenodd).
	// The same set as the company's reading names (READING_SHAPES); another name draws the blob.
	const n2 = (v) => Number(v.toFixed(2));
	const rr = (x, y, w, h, r) => `M${n2(x + r)},${n2(y)}h${n2(w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}v${n2(h - 2 * r)}a${r},${r} 0 0 1 ${-r},${r}h${n2(-(w - 2 * r))}a${r},${r} 0 0 1 ${-r},${-r}v${n2(-(h - 2 * r))}a${r},${r} 0 0 1 ${r},${-r}z`;
	const ci = (cx, cy, rx, ry) => `M${n2(cx - rx)},${n2(cy)}a${rx},${ry === undefined ? rx : ry} 0 1 0 ${n2(2 * rx)},0a${rx},${ry === undefined ? rx : ry} 0 1 0 ${n2(-2 * rx)},0z`;
	const poly = (pts) => `M${pts.map(([x, y]) => `${n2(x)},${n2(y)}`).join("L")}Z`;
	function wrench() {
		const rad = (d) => (d * Math.PI) / 180;
		const at = (r, d) => [62 + r * Math.cos(rad(d)), 38 + r * Math.sin(rad(d))];
		const head = [];
		for (let d = -10; d <= 280; d += 10) head.push(at(22, d));
		for (let d = 280; d >= -10; d -= 10) head.push(at(9, d));
		const al = [Math.cos(rad(135)), Math.sin(rad(135))];
		const ac = [Math.cos(rad(45)), Math.sin(rad(45))];
		const p = (dist, side) => [62 + al[0] * dist + ac[0] * side, 38 + al[1] * dist + ac[1] * side];
		return poly(head) + poly([p(22.5, 8), p(60, 8), p(60, -8), p(22.5, -8)]);
	}
	function gear(teeth, outer, inner) {
		const step = (2 * Math.PI) / teeth;
		const at = (a, r) => `${n2(50 + r * Math.cos(a))},${n2(50 + r * Math.sin(a))}`;
		const pts = [];
		for (let t = 0; t < teeth; t++) {
			const m = t * step - Math.PI / 2;
			pts.push(at(m - step * 0.34, inner), at(m - step * 0.18, outer), at(m + step * 0.18, outer), at(m + step * 0.34, inner));
		}
		return `M${pts.join("L")}Z`;
	}
	// Each shape: its solid parts, its cuts, and where a "?" stands inside its outline. A thing not known, or only
	// assumed, is drawn by the outline alone: the solid parts, dashed, with no cut.
	const SHAPES = {
		board: [rr(8, 12, 84, 76, 14), rr(19, 25, 17, 30, 4) + rr(41.5, 25, 17, 44, 4) + rr(64, 25, 17, 20, 4)],
		box: [rr(10, 18, 80, 70, 10), rr(18, 32, 64, 12, 6) + rr(40, 56, 20, 14, 7), 50, 56],
		screen: [rr(6, 12, 88, 60, 10) + "M41,72h18l4,10h-26Z" + rr(26, 82, 48, 8, 4), rr(16, 22, 68, 40, 4), 50, 42],
		phone: [rr(26, 4, 48, 92, 12), rr(34, 14, 32, 62, 4) + ci(50, 85, 6), 50, 45],
		gear: [gear(8, 44, 33), ci(50, 50, 14)],
		code: [rr(6, 12, 88, 76, 14), "M38,28L16,50L38,72L48,62L36,50L48,38Z" + "M62,28L84,50L62,72L52,62L64,50L52,38Z"],
		person: [ci(50, 30, 17) + "M16,92C16,70 31,58 50,58C69,58 84,70 84,92Z", "", 50, 78],
		people: [ci(36, 32, 15) + "M8,86C8,66 20,56 36,56C52,56 64,66 64,86Z" + ci(80, 46, 10) + "M66,86V80C66,68 72,62 80,62C88,62 94,68 94,80V86Z", "", 36, 74],
		heart: ["M50,88C50,88 10,62 10,36C10,22 21,12 33,12C41,12 47,17 50,23C53,17 59,12 67,12C79,12 90,22 90,36C90,62 50,88 50,88Z", "", 50, 44],
		pin: ["M50,7C30,7 15,22 15,41C15,65 50,93 50,93C50,93 85,65 85,41C85,22 70,7 50,7Z", ci(50, 40, 13), 50, 42],
		globe: [ci(50, 50, 42), ci(50, 50, 18, 42) + ci(50, 50, 9, 42) + rr(10, 44, 22, 12, 6) + rr(68, 44, 22, 12, 6)],
		chart: [rr(6, 8, 88, 84, 12), rr(18, 50, 14, 28, 4) + rr(43, 34, 14, 44, 4) + rr(68, 20, 14, 58, 4)],
		coin: [ci(50, 50, 42), rr(42, 29, 16, 42, 8)],
		bank: ["M50,8L90,30V36H10V30Z" + rr(16, 42, 14, 34, 3) + rr(43, 42, 14, 34, 3) + rr(70, 42, 14, 34, 3) + rr(8, 80, 84, 10, 3), "", 50, 59],
		drop: ["M50,7C50,7 19,45 19,62a31,31 0 0 0 62,0C81,45 50,7 50,7Z", ci(41, 64, 10), 50, 62],
		megaphone: ["M14,38H30L74,14V86L30,62H14a6,6 0 0 1 -6,-6V44a6,6 0 0 1 6,-6Z" + "M30,72h12l5,16h-12Z" + rr(82, 38, 10, 24, 5), "", 48, 50],
		cart: ["M4,12H22L25,24H94L84,62H32L22,22H4Z" + ci(38, 80, 8) + ci(76, 80, 8), rr(38, 34, 36, 12, 6), 58, 42],
		handshake: ["M4,36L28,28L50,46L38,62L22,58L4,62Z" + "M96,36L72,28L54,40L66,54L78,58L96,62Z" + rr(30, 64, 40, 14, 7), "", 50, 30],
		truck: [rr(4, 22, 58, 48, 6) + "M64,34H80L94,50V70H64Z" + ci(24, 80, 9) + ci(78, 80, 9), "M69,40H79L88,52H69Z", 33, 46],
		factory: ["M50,10L90,42V86a5,5 0 0 1 -5,5H15a5,5 0 0 1 -5,-5V42Z", rr(40, 56, 20, 29, 5), 50, 60],
		scale: [rr(46, 16, 8, 62, 4) + rr(8, 20, 34, 8, 4) + rr(58, 20, 34, 8, 4) + "M6,46h36a18,18 0 0 1 -36,0Z" + "M58,46h36a18,18 0 0 1 -36,0Z" + rr(26, 80, 48, 10, 5), "", 24, 70],
		document: ["M20,6H62L86,30V88a6,6 0 0 1 -6,6H20a6,6 0 0 1 -6,-6V12a6,6 0 0 1 6,-6Z", "M58,10V34H82Z" + rr(24, 48, 50, 12, 6) + rr(24, 68, 36, 12, 6), 50, 58],
		chat: ["M16,12H84a10,10 0 0 1 10,10V62a10,10 0 0 1 -10,10H40L20,90V72H16a10,10 0 0 1 -10,-10V22a10,10 0 0 1 10,-10Z", ci(30, 42, 7) + ci(50, 42, 7) + ci(70, 42, 7), 50, 42],
		wrench: [wrench(), "", 62, 38],
		blob: ["M50,8C72,8 92,22 90,46C88,70 74,92 50,90C26,88 8,74 10,50C12,26 28,8 50,8Z", ""],
	};
	const shapeEntry = (name) => (Object.prototype.hasOwnProperty.call(SHAPES, name) ? SHAPES[name] : SHAPES.blob);
	/** The whole shape: its solid parts with their cuts. */
	const shapeOf = (name) => shapeEntry(name)[0] + shapeEntry(name)[1];
	/** The outline alone: the solid parts with no cut. */
	const outlineOf = (name) => shapeEntry(name)[0];
	/** Where a "?" stands inside the outline, in the 100 x 100 box. */
	const askAt = (name) => [shapeEntry(name)[2] ?? 50, shapeEntry(name)[3] ?? 50];

	// ---------------------------------------------------------------- where things stand
	// The canvas is 1052 x 620 units, one unit one pixel at most; it shrinks whole, so it never overlaps itself. Each
	// slot (middle x, middle y, size) keeps its footprint (the shape, two lines of label under it, the figures at its
	// lower corners) clear of every other one and inside the canvas. Three to seven are the company page's own tables;
	// one, two and eight to twelve (a layer's) follow the same rule. Under 720 px the things stack in one column.
	const CANVAS = { w: 1052, h: 620 };
	const LABEL = 76;
	const REACH = 75;
	const FIGURE = 62;
	const FACE = 46;
	const SPACING = 40;
	const COLUMN_BELOW = 720;
	const SLOTS = {
		3: [[526, 300, 230], [180, 330, 150], [872, 330, 150]],
		4: [[526, 300, 220], [186, 230, 150], [866, 230, 140], [526, 68, 90]],
		5: [[526, 290, 220], [186, 202, 150], [866, 202, 132], [206, 472, 112], [846, 472, 112]],
		6: [[526, 308, 220], [186, 202, 150], [866, 202, 132], [206, 472, 112], [846, 472, 112], [526, 70, 84]],
		7: [[526, 320, 200], [150, 250, 130], [902, 250, 130], [220, 480, 104], [832, 480, 104], [400, 66, 76], [652, 66, 76]],
	};
	function slots(count) {
		if (SLOTS[count]) return SLOTS[count];
		if (count <= 1) return [[526, 280, 240]];
		if (count === 2) return [[330, 290, 210], [722, 290, 210]];
		// eight to twelve: three rows, the middle row's middle first
		const rows = { 8: [3, 2, 3], 9: [3, 3, 3], 10: [3, 4, 3], 11: [4, 3, 4] }[count] || [4, 4, 4];
		const size = Math.max(...rows) === 4 ? 100 : 116;
		const rowH = size + LABEL;
		const gap = (CANVAS.h - 3 * rowH) / 2;
		const out = [];
		rows.forEach((k, r) => {
			const step = Math.min(CANVAS.w / k, size + 2 * REACH + 24);
			for (let i = 0; i < k; i++) out.push([Math.round(526 + (i - (k - 1) / 2) * step), Math.round(r * (rowH + gap) + size / 2), size]);
		});
		const mid = rows[0] + Math.floor((rows[1] - 1) / 2);
		return [out[mid], ...out.filter((_, i) => i !== mid)];
	}
	/** The things in slot order: the attended one (or, in a layer, the first with the most agents), then by agents. */
	function slotOrder(things, attention) {
		const ranked = things.map((t, i) => ({ t, i })).sort((a, b) => b.t.stands.agents.length - a.t.stands.agents.length || a.i - b.i);
		const first = things.find((t) => t.id === attention) || (ranked[0] && ranked[0].t);
		return first ? [first, ...ranked.map((x) => x.t).filter((t) => t !== first)] : [];
	}
	function layoutOf(things, attention, W, H) {
		const ordered = slotOrder(things.slice(0, MAX.layer), attention);
		const spot = (t, x, y, size, u) => ({ t, x: x * u, y: y * u, size: size * u, left: (x - size / 2 - REACH) * u, width: (size + 2 * REACH) * u });
		if (W < COLUMN_BELOW) {
			const u = Math.max(0.2, Math.min(1, W / (230 + 2 * REACH + 24)));
			let top = 16;
			const spots = ordered.map((t, i) => {
				const size = i === 0 ? 150 : 110;
				const s = spot(t, W / u / 2, top + size / 2, size, u);
				top += size + LABEL + 28;
				return s;
			});
			return { column: true, u, width: W, height: top * u, spots };
		}
		const table = slots(ordered.length);
		const u = Math.max(0.2, Math.min(1, W / CANVAS.w, H > 0 ? H / CANVAS.h : 1));
		return { column: false, u, width: CANVAS.w * u, height: CANVAS.h * u, spots: ordered.map((t, i) => spot(t, table[i][0], table[i][1], table[i][2], u)) };
	}
	/** Where the figures at a thing stand: agents first, then the members it waits for (smaller); right, then left, then
	 * outward. Each side holds two at full size; more shrink and close up. */
	function figureSpots(at, u, count, faces) {
		const sides = [Math.ceil(count / 2), Math.floor(count / 2)];
		const out = [];
		for (let i = 0; i < count; i++) {
			const side = i % 2;
			const rank = Math.floor(i / 2);
			const many = sides[side];
			const fit = Math.min(1, 2 / many);
			const size = (i >= count - faces ? FACE : FIGURE) * fit * u;
			const spacing = (many > 1 ? Math.min(SPACING, SPACING / (many - 1)) : 0) * u;
			const reach = at.size / 2 + 4 * u + rank * spacing;
			const middle = side === 0 ? at.x + reach : at.x - reach;
			out.push({ left: middle - size / 2, top: at.y + at.size / 2 + 4 * u - size, size });
		}
		return out;
	}

	// ---------------------------------------------------------------- helpers
	const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
	const list = (v) => (Array.isArray(v) ? v : []);
	const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
	function cut(v, n) {
		const chars = Array.from(text(v).replace(/\s+/g, " ").trim());
		return chars.length <= n ? chars.join("") : `${chars.slice(0, n - 1).join("").trimEnd()}…`;
	}
	const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]));
	function h(tag, cls, attrs, ...kids) {
		const el = D.createElement(tag);
		if (cls) el.className = cls;
		if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, String(attrs[k]));
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
		return el;
	}
	const SVGNS = "http://www.w3.org/2000/svg";
	function svgPath(cls, d, box) {
		const el = D.createElementNS(SVGNS, "svg");
		el.setAttribute("viewBox", box || "0 0 100 100");
		el.setAttribute("aria-hidden", "true");
		if (cls) el.setAttribute("class", cls);
		const p = D.createElementNS(SVGNS, "path");
		p.setAttribute("d", d);
		el.append(p);
		return el;
	}
	function icon(markup) {
		const el = D.createElementNS(SVGNS, "svg");
		el.setAttribute("viewBox", "0 0 24 24");
		el.setAttribute("aria-hidden", "true");
		el.setAttribute("fill", "none");
		el.setAttribute("stroke", "currentColor");
		el.setAttribute("stroke-width", "2.2");
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		el.innerHTML = markup;
		return el;
	}
	const ICON = {
		dive: '<path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4"/>',
		leave: '<path d="M9 7h8v8M17 7L7 17"/>',
	};
	const esc = (t) => (window.CSS && window.CSS.escape ? window.CSS.escape(t) : String(t).replace(/["\\]/g, "\\$&"));
	function figureSrc(id) {
		if (!id) return "";
		const found = D.querySelector(`#kit-media [data-kit-src="${esc(`figure:${id}`)}"]`);
		return (found && found.getAttribute("src")) || "";
	}
	const initials = (name) =>
		Array.from(name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0] || "").join("")).join("").toUpperCase() || "?";
	function when(iso, lang, date) {
		const at = new Date(iso);
		if (Number.isNaN(at.getTime())) return "";
		const now = new Date();
		const options = date
			? { day: "numeric", month: "long" }
			: at.toDateString() === now.toDateString()
				? { hour: "2-digit", minute: "2-digit" }
				: Math.abs(now.getTime() - at.getTime()) < 6 * 864e5
					? { weekday: "long", hour: "2-digit", minute: "2-digit" }
					: { day: "numeric", month: "long" };
		try {
			return new Intl.DateTimeFormat(lang, options).format(at);
		} catch {
			return new Intl.DateTimeFormat("en", options).format(at);
		}
	}
	function age(seen, words) {
		const at = Date.parse(seen);
		if (!Number.isFinite(at)) return "";
		const days = (Date.now() - at) / 864e5;
		if (days <= STALE_DAYS) return "";
		const weeks = Math.floor(days / 7);
		return weeks < 9 ? fill(words.weeks, { n: weeks }) : fill(words.months, { n: Math.floor(days / 30) });
	}

	// ---------------------------------------------------------------- data
	/** One thing of map.json as the engine draws it. */
	function thingOf(t, words) {
		const id = text(t.id).trim();
		const name = cut(t.name, MAX.name);
		if (!ID.test(id) || !name) return null;
		const state = STATES.includes(t.state) ? t.state : "known";
		const full = typeof t.full === "number" && Number.isFinite(t.full) ? Math.max(0, Math.min(100, Math.round(t.full))) : 0;
		const stale = typeof t.seen === "string" ? age(t.seen, words) : "";
		const opens = typeof t.opens === "string" && /^app:[a-z0-9][a-z0-9-]{0,63}$/.test(t.opens) ? t.opens : "";
		return {
			id,
			name,
			shape: typeof t.shape === "string" ? t.shape : "blob",
			state,
			full: state === "known" ? full : 0,
			label: stale || (state === "unknown" ? words.unknown : cut(t.note, MAX.note) || (state === "assumed" ? words.assumed : "")),
			stale: !!stale,
			names: list(t.agents).filter((a) => typeof a === "string" && a.trim()).slice(0, MAX.agents).map((a) => cut(a, MAX.name)),
			waits: t.waits === true,
			opens,
			source: typeof t.source === "string" && /^(?:https:\/\/|folder:)/.test(t.source) ? t.source : "",
		};
	}
	function thingsOf(raw, most, words, budget) {
		const out = [];
		const seen = new Set();
		for (const t of list(raw)) {
			if (!isObj(t) || out.length >= most || budget.left <= 0) continue;
			const thing = thingOf(t, words);
			if (!thing || seen.has(thing.id)) continue;
			seen.add(thing.id);
			budget.left--;
			out.push(thing);
		}
		return out;
	}
	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...(lang.slice(0, 2) === "da" ? DA : EN) };
		if (isObj(raw.words)) for (const k of Object.keys(EN)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const budget = { left: MAX.all };
		let top;
		if (raw.top === "reading") top = "reading";
		else if (isObj(raw.top)) {
			const things = thingsOf(raw.top.things, MAX.top, words, budget);
			if (!things.length) throw new Error("no things");
			const attention = text(raw.top.attention);
			top = { title: cut(raw.top.title, MAX.title), line: cut(raw.top.line, MAX.line), attention: things.some((t) => t.id === attention) ? attention : things[0].id, things };
		} else throw new Error("no top");
		const layers = new Map();
		if (isObj(raw.layers))
			for (const key of Object.keys(raw.layers)) {
				const layer = raw.layers[key];
				if (!ID.test(key) || !isObj(layer)) continue;
				const things = thingsOf(layer.things, MAX.layer, words, budget);
				if (things.length) layers.set(key, { line: cut(layer.line, MAX.line), things });
			}
		return { lang, words, top, layers, names: top === "reading" || [top, ...layers.values()].some((l) => l.things.some((t) => t.names.length)) };
	}

	// ---------------------------------------------------------------- what the page draws now
	const ui = { model: null, live: { reading: undefined, agents: null }, path: [], root: null, parts: null, things: new Map(), figs: new Map(), drawn: "", width: 0, height: 0, told: null, toldFor: "", u: 1, arriving: false, zooming: false, zoomKeep: "" };

	/** The team as the company has it (reading's team), by lower-case name; null where it is not known. */
	function teamByName() {
		const r = ui.live.reading;
		if (!r || !Array.isArray(r.team)) return null;
		const by = new Map();
		for (const a of r.team) if (a && typeof a.name === "string") by.set(a.name.toLowerCase(), a);
		return by;
	}
	function workingOf(name) {
		const r = ui.live.reading;
		const fromTeam = r && Array.isArray(r.team) ? r.team.find((a) => a && a.name === name) : null;
		if (fromTeam) return fromTeam.working === true;
		const a = Array.isArray(ui.live.agents) ? ui.live.agents.find((x) => x && x.name === name) : null;
		return !!(a && a.working === true);
	}
	/** The company's reading as the first layer's things. */
	function readingThings(reading, words) {
		return list(reading.things)
			.slice(0, MAX.top)
			.filter((t) => isObj(t) && typeof t.key === "string")
			.map((t) => ({
				id: t.key,
				name: cut(t.name, MAX.rname),
				shape: text(t.shape) || "blob",
				state: "known",
				full: typeof t.full === "number" ? Math.max(0, Math.min(100, Math.round(t.full))) : 0,
				label: cut(t.state, MAX.note),
				stale: false,
				stands: {
					agents: list(t.agents).filter(isObj).map((a) => ({ name: text(a.name), figure: text(a.figure), working: a.working === true })),
					faces: list(t.waits).filter(isObj).map((w) => ({ name: text(w.name), me: w.me === true })),
				},
				opens: "",
				source: "",
				words,
			}));
	}
	/** Who stands at a thing of map.json: the agents the company has (all named, where the team is not known). */
	function standsOf(t) {
		const team = teamByName();
		const agents = [];
		for (const name of t.names) {
			const found = team ? team.get(name.toLowerCase()) : null;
			if (team && !found) continue;
			agents.push(found ? { name: found.name, figure: text(found.figure), working: found.working === true } : { name, figure: "", working: workingOf(name) });
		}
		return { agents, faces: t.waits ? [{ name: "", me: false, founder: true }] : [] };
	}
	/** The layer on screen: its title, line, things and how it was reached. */
	function current() {
		const m = ui.model;
		const reading = m.top === "reading" ? ui.live.reading && ui.live.reading.reading : null;
		const first =
			m.top === "reading"
				? reading
					? { title: cut(reading.sentence, MAX.sentence), line: cut(reading.line, MAX.sentence), attention: text(reading.attention), things: readingThings(reading, m.words) }
					: null
				: { title: m.top.title, line: m.top.line, attention: m.top.attention, things: m.top.things.map((t) => ({ ...t, stands: standsOf(t) })) };
		// the way down, as far as it still goes
		const trail = [];
		let layer = first;
		const path = [];
		for (const id of ui.path) {
			if (!layer || path.length >= MAX.depth - 1) break;
			const thing = layer.things.find((t) => t.id === id);
			const inner = thing && !thing.opens && m.layers.get(id);
			if (!inner) break;
			trail.push({ title: layer.title, thing });
			path.push(id);
			layer = { title: thing.name, line: inner.line, attention: "", things: inner.things.map((t) => ({ ...t, stands: standsOf(t) })), thing };
		}
		if (path.length !== ui.path.length) ui.path = path;
		return { first, layer, trail, depth: path.length };
	}
	const opensLayer = (t, depth) => !t.opens && ui.model.layers.has(t.id) && depth < MAX.depth - 1;

	// ---------------------------------------------------------------- drawing
	let style = null;
	function ensureStyle() {
		if (style) return;
		style = h("style", null, { "data-kit": "map" }, CSS);
		D.head.append(style);
	}
	function show(main) {
		for (const old of D.querySelectorAll("body > main.mp")) if (old !== main) old.remove();
		if (main.parentNode !== D.body) D.body.append(main);
	}
	function quiet(line) {
		ensureStyle();
		const main = h("main", `mp${BARE ? " mp--bare" : ""}`, null, h("p", "mp-quiet", null, line));
		show(main);
		ui.root = null;
		ui.parts = null;
		ui.things.clear();
		ui.figs.clear();
	}
	function skeleton() {
		const title = h("h1", "mp-title");
		const herePale = svgPath("mp-pale", "");
		const hereSolid = svgPath("mp-solid", "");
		const hereFill = h("div", "mp-fill", null, hereSolid);
		const here = h("span", "mp-here", { "aria-hidden": "true", hidden: "" }, herePale, hereFill);
		const line = h("p", "mp-line");
		const src = h("a", "mp-src", { hidden: "" });
		const head = h("header", "mp-head", null, h("div", "mp-titles", null, here, title), line, src);
		const trail = h("nav", "mp-trail", { hidden: "" });
		const canvas = h("div", "mp-canvas");
		const stage = h("div", "mp-stage", null, canvas);
		const changes = h("div", "mp-changes", { role: "group", hidden: "" });
		const root = h("main", `mp${BARE ? " mp--bare" : ""}`, null, trail, head, stage, changes);
		ui.root = root;
		ui.parts = { title, here, herePaths: [herePale.firstChild, hereSolid.firstChild], hereFill, line, src, head, trail, canvas, stage, changes };
		ui.things.clear();
		ui.figs.clear();
		show(root);
	}

	/** The title and its line: the layer's, or on the company's own map why it stands still. */
	function words(view, standing) {
		const p = ui.parts;
		const w = ui.model.words;
		const lang = ui.model.lang;
		let title = view.layer ? view.layer.title : ui.model.top === "reading" ? w.finding : "";
		let line = view.layer ? view.layer.line : "";
		if (standing && standing.stopped && ui.model.top === "reading" && view.depth === 0) {
			title = standing.since ? fill(w.stood, { time: when(standing.since, lang) }) : w.stoodNow;
			const member = typeof standing.member === "string" && standing.member ? standing.member.split(/\s+/)[0] : "";
			const of = (own, other) => (member ? fill(other, { member }) : own);
			if (standing.why === "login_full") {
				const reset = typeof standing.resetsAt === "string" ? Date.parse(standing.resetsAt) : NaN;
				const opens = Number.isFinite(reset)
					? reset - Date.now() < 864e5
						? fill(w.opensAt, { time: when(standing.resetsAt, lang) })
						: fill(w.opensOn, { date: when(standing.resetsAt, lang, true) })
					: "";
				line = [of(w.full, w.fullOf), opens].filter(Boolean).join(" ");
			} else if (standing.why === "sign_in") line = of(w.signIn, w.signInOf);
			else if (standing.why === "no_login") line = of(w.noLogin, w.noLoginOf);
			else line = "";
		}
		p.title.textContent = title;
		p.line.textContent = line;
		p.line.hidden = !line;
		// where you are: the opened thing's own shape, small, filled as far as it is, left of its name
		const thing = view.layer && view.layer.thing;
		p.here.hidden = !thing;
		if (thing) {
			for (const path of p.herePaths) path.setAttribute("d", thing.state === "known" ? shapeOf(thing.shape) : outlineOf(thing.shape));
			p.hereFill.style.height = `${thing.full}%`;
		}
		const source = thing ? thing.source : "";
		if (source) {
			p.src.setAttribute("href", source);
			p.src.textContent = `${w.source} ↗`;
			p.src.hidden = false;
		} else p.src.hidden = true;
	}

	function trailEl(view) {
		const p = ui.parts;
		const w = ui.model.words;
		p.trail.hidden = view.depth === 0;
		p.trail.setAttribute("aria-label", w.where);
		if (view.depth === 0) return p.trail.replaceChildren();
		const items = [];
		view.trail.forEach((step, k) => {
			const b = h("button", "mp-crumb", { type: "button" }, cut(step.title, MAX.crumb));
			b.addEventListener("click", () => go(k));
			items.push(b, h("span", "mp-sep", { "aria-hidden": "true" }, "›"));
		});
		items.push(h("span", null, { "aria-current": "page" }, cut(view.layer.title, MAX.crumb)));
		p.trail.replaceChildren(...items);
	}

	function thingParts(t) {
		const dash = svgPath("mp-dash", "");
		const pale = svgPath("mp-pale", "");
		const solid = svgPath("mp-solid", "");
		const fillEl = h("div", "mp-fill", null, solid);
		const q = h("span", "mp-q", { "aria-hidden": "true" }, "?");
		const shape = h("div", "mp-shape", null, dash, pale, fillEl, q);
		const name = h("div", "mp-name");
		const label = h("div", "mp-label");
		const el = h("div", "mp-thing", { "data-id": t.id });
		return { el, shape, paths: [dash, pale, solid].map((s) => s.firstChild), solid, fill: fillEl, q, name, label, hit: null, look: "" };
	}

	/** One thing where its spot is: its shape filled, its name and label, and what a press does. */
	function placeThing(t, s, depth, i, still) {
		let parts = ui.things.get(t.id);
		const fresh = !parts;
		if (!parts) {
			parts = thingParts(t);
			ui.things.set(t.id, parts);
		}
		const el = parts.el;
		const u = ui.u;
		el.style.left = `${s.left}px`;
		el.style.top = `${s.y - s.size / 2}px`;
		el.style.width = `${s.width}px`;
		el.style.setProperty("--i", String(i));
		parts.shape.style.width = `${s.size}px`;
		parts.shape.style.height = `${s.size}px`;
		parts.shape.style.setProperty("--s", `${s.size}px`);
		parts.solid.style.height = `${s.size}px`;
		// a thing not known, or only assumed, is its outline alone: dashed, pale inside when assumed, no cut
		const whole = shapeOf(t.shape);
		const outline = outlineOf(t.shape);
		const open = t.state !== "known";
		[outline, open ? outline : whole, whole].forEach((d, k) => {
			if (parts.paths[k].getAttribute("d") !== d) parts.paths[k].setAttribute("d", d);
		});
		const [qx, qy] = askAt(t.shape);
		parts.q.style.left = `${qx}%`;
		parts.q.style.top = `${qy}%`;
		parts.fill.style.height = `${t.full}%`;
		el.classList.toggle("is-empty", t.state === "known" && t.full === 0);
		el.classList.toggle("is-unknown", t.state === "unknown");
		el.classList.toggle("is-assumed", t.state === "assumed");
		el.classList.toggle("is-stale", t.stale);
		parts.q.hidden = t.state !== "unknown";
		parts.name.textContent = t.name;
		parts.label.textContent = t.label;
		parts.label.hidden = !t.label;
		// what a press does: a layer opens, another interface opens, a source opens, or nothing
		const w = ui.model.words;
		const dive = opensLayer(t, depth);
		const kind = dive ? "dive" : t.opens ? "leave" : t.source ? "source" : "";
		const look = `${kind}|${t.opens}|${t.source}`;
		if (parts.look !== look || !parts.hit) {
			parts.look = look;
			const hit = dive
				? h("button", "mp-hit", { type: "button", "aria-haspopup": "true" })
				: t.opens || t.source
					? h("a", "mp-hit", { href: t.opens || t.source })
					: h("div", "mp-hit", { role: "img" });
			if (dive) hit.addEventListener("click", () => dive$(t.id));
			for (const old of parts.shape.querySelectorAll(".mp-mark")) old.remove();
			if (kind === "dive" || kind === "leave" || kind === "source") parts.shape.append(h("span", "mp-mark", { "aria-hidden": "true" }, icon(kind === "dive" ? ICON.dive : ICON.leave)));
			hit.append(parts.shape, parts.name, parts.label);
			el.replaceChildren(hit);
			parts.hit = hit;
		}
		parts.hit.setAttribute("aria-label", [t.name, t.label, kind === "dive" ? w.open : kind ? w.leaves : ""].filter(Boolean).join(", "));
		if (parts.el.parentNode !== ui.parts.canvas) ui.parts.canvas.append(parts.el);
		if (fresh && ui.arriving && !still && !calm()) {
			el.classList.add("is-arriving");
			setTimeout(() => el.classList.remove("is-arriving"), 900);
		}
		if (fresh && ui.zooming && t.id !== ui.zoomKeep && !calm()) {
			el.classList.add("is-zoomed");
			setTimeout(() => el.classList.remove("is-zoomed"), 1200);
		}
		return parts;
	}

	/** A figure: an agent by its picture (or its initial), a member who is waited for by a face. Kept by its key, so it
	 * walks to its new place. */
	function placeFigure(key, stand, left, top, size, still, flow) {
		let el = ui.figs.get(key);
		const fresh = !el;
		const look = JSON.stringify(stand);
		if (!el || el.__look !== look) {
			const next = stand.face
				? h("span", `mp-face mp-fig${stand.me ? " me" : ""}${stand.founder ? " founder" : ""}`, { role: "img" })
				: h("span", `mp-fig${figureSrc(stand.figure) ? "" : " ini"}`, { role: "img" });
			if (stand.face) {
				if (stand.founder) next.append(svgPath(null, shapeOf("person")));
				else next.append(initials(stand.name));
			} else {
				const src = figureSrc(stand.figure);
				if (src) next.append(h("img", null, { src, alt: "", draggable: "false" }));
				else next.append(initials(stand.name));
				if (stand.working) next.append(h("i", "mp-dot", { "aria-hidden": "true" }));
			}
			const label = stand.face ? (stand.founder ? ui.model.words.waits : stand.name) : stand.working ? `${stand.name}, ${ui.model.words.working}` : stand.name;
			next.setAttribute("aria-label", label);
			next.title = label;
			next.__look = look;
			if (el) {
				next.style.cssText = el.style.cssText;
				el.replaceWith(next);
			}
			el = next;
			ui.figs.set(key, el);
		}
		el.classList.toggle("is-flow", !!flow);
		if (flow) {
			el.style.removeProperty("left");
			el.style.removeProperty("top");
		} else {
			el.style.left = `${left}px`;
			el.style.top = `${top}px`;
		}
		el.style.width = `${size}px`;
		el.style.height = `${size}px`;
		el.style.setProperty("--f", `${size}px`);
		if (el.parentNode !== ui.parts.canvas) ui.parts.canvas.append(el);
		if (fresh && ui.arriving && !still && !calm() && !flow) {
			el.classList.add("is-arriving");
			setTimeout(() => el.classList.remove("is-arriving"), 1300);
		}
	}

	function measure() {
		const p = ui.parts;
		const W = Math.max(280, (p.stage && p.stage.clientWidth) || window.innerWidth || 1052);
		const used = (p.head.offsetHeight || 0) + (p.trail.hidden ? 0 : p.trail.offsetHeight || 0) + (p.changes.hidden ? 0 : p.changes.offsetHeight || 0);
		const H = Math.max(200, (window.innerHeight || 800) - used - 24);
		return { W, H };
	}

	function render(how) {
		if (!ui.model) return;
		ensureStyle();
		if (!ui.root) skeleton();
		const m = ui.model;
		const p = ui.parts;
		D.documentElement.lang = m.lang;
		ui.root.setAttribute("lang", m.lang);
		const live = ui.live.reading;
		const standing = live && isObj(live.standing) ? live.standing : null;
		const still = !!(standing && standing.stopped);
		ui.root.classList.toggle("is-still", still);
		const view = current();
		words(view, standing);
		trailEl(view);
		drawChanges(view, still);
		const before = how && how.from ? how.from : null;
		ui.arriving = how === "update";
		ui.zooming = !!(how && how.zoom);
		ui.zoomKeep = how && how.zoom === "out" ? how.id : "";
		if (how && how.zoom) {
			// another layer: none of the things before are kept
			for (const [, parts] of ui.things) parts.el.remove();
			ui.things.clear();
			for (const [, el] of ui.figs) el.remove();
			ui.figs.clear();
		}
		const keepThings = new Set();
		const keepFigs = new Set();
		const canvas = p.canvas;
		if (!view.layer) {
			// no reading yet: the team in a row, the Co-Founder first; no shapes
			canvas.classList.add("is-row");
			canvas.classList.remove("is-column");
			canvas.style.removeProperty("width");
			canvas.style.removeProperty("height");
			const team = live && Array.isArray(live.team) ? live.team.filter(isObj) : [];
			const row = [...team].sort((a, b) => Number(b.cofounder === true) - Number(a.cofounder === true));
			const seen = new Map();
			for (const a of row) {
				const name = text(a.name);
				const k = (seen.get(name) || 0) + 1;
				seen.set(name, k);
				const key = `row:${name}#${k}`;
				keepFigs.add(key);
				placeFigure(key, { name, figure: text(a.figure), working: !still && a.working === true }, 0, 0, FIGURE, still, true);
			}
		} else {
			canvas.classList.remove("is-row");
			const { W, H } = measure();
			const L = layoutOf(view.layer.things, view.layer.attention, W, H);
			ui.u = L.u;
			canvas.classList.toggle("is-column", L.column);
			canvas.style.width = `${L.width}px`;
			canvas.style.height = `${L.height}px`;
			canvas.style.setProperty("--u", `${L.u}px`);
			const seen = new Map();
			const keyOf = (k) => {
				const c = (seen.get(k) || 0) + 1;
				seen.set(k, c);
				return c === 1 ? k : `${k}#${c}`;
			};
			L.spots.forEach((s, i) => {
				const t = s.t;
				keepThings.add(t.id);
				placeThing(t, s, view.depth, i, still);
				const stands = [
					...t.stands.agents.map((a) => ({ key: keyOf(`agent:${a.name}`), stand: { name: a.name, figure: a.figure, working: !still && a.working } })),
					...t.stands.faces.map((f) => ({ key: keyOf(`face:${f.founder ? "founder" : f.name}`), stand: { face: true, name: f.name, me: f.me, founder: !!f.founder } })),
				];
				figureSpots(s, L.u, stands.length, t.stands.faces.length).forEach((at, k) => {
					keepFigs.add(stands[k].key);
					placeFigure(stands[k].key, stands[k].stand, at.left, at.top, at.size, still, false);
				});
			});
			// the zoom: into a thing, the new layer grows out of where the thing stood; out of one, it shrinks back into
			// the thing's place. The canvas moves as one, from its top left corner.
			if (before && !calm() && !still) {
				const came = how.zoom === "out" ? ui.things.get(how.id) : null;
				const C = canvas.getBoundingClientRect();
				const A = came ? came.shape.getBoundingClientRect() : C;
				if (A.width > 0 && before.width > 0 && C.width > 0) {
					const k = before.width / A.width;
					canvas.style.transition = "none";
					canvas.style.transformOrigin = "0 0";
					canvas.style.transform = `translate(${before.left - C.left - k * (A.left - C.left)}px,${before.top - C.top - k * (A.top - C.top)}px) scale(${k})`;
					canvas.getBoundingClientRect();
					requestAnimationFrame(() => {
						canvas.style.transition = "transform calc(var(--mp-t) * 1.25) var(--mp-spring)";
						canvas.style.transform = "";
						setTimeout(() => {
							canvas.style.removeProperty("transition");
							canvas.style.removeProperty("transform-origin");
						}, 900);
					});
				}
			}
		}
		for (const [key, parts] of ui.things)
			if (!keepThings.has(key)) {
				ui.things.delete(key);
				parts.el.remove();
			}
		for (const [key, el] of ui.figs)
			if (!keepFigs.has(key)) {
				ui.figs.delete(key);
				el.remove();
			}
		ui.width = (p.stage && p.stage.clientWidth) || 0;
		ui.height = window.innerHeight;
	}

	// ---------------------------------------------------------------- what changed, and "Not right?"
	function drawChanges(view, still) {
		const box = ui.parts.changes;
		const w = ui.model.words;
		const r = ui.live.reading && ui.live.reading.reading;
		const changes = ui.model.top === "reading" && view.depth === 0 && r && !still ? list(r.changes).filter((c) => isObj(c) && typeof c.line === "string" && c.line.trim()) : [];
		box.hidden = changes.length === 0;
		box.setAttribute("aria-label", w.changed);
		if (!changes.length) return box.replaceChildren();
		const key = JSON.stringify(changes);
		if (box.__key === key && box.childElementCount) return;
		box.__key = key;
		// a note sent about other changes says nothing of these
		if (ui.toldFor !== key) ui.told = null;
		const items = [];
		changes.slice(0, 6).forEach((c, i) => {
			if (i) items.push(h("span", "mp-cdot", { "aria-hidden": "true" }, "·"));
			const a = isObj(c.agent) ? c.agent : null;
			const src = a ? figureSrc(text(a.figure)) : "";
			const fig = a ? h("span", `mp-fig${src ? "" : " ini"}`, { "aria-hidden": "true" }, src ? h("img", null, { src, alt: "" }) : initials(text(a.name))) : null;
			if (fig) fig.style.setProperty("--f", "22px");
			items.push(h("span", `mp-change${c.what === "ended" ? " is-ended" : ""}`, null, fig, h("span", null, null, cut(c.line, MAX.change))));
		});
		const pill = notRight(changes, view, key);
		box.replaceChildren(...items, ...(pill || []).filter(Boolean));
	}
	// A note to the app's owner (qorpera.tell, RUNTIME-INTERFACE-APPS.md §5): a draft the member sends or changes on
	// Qorpera's bar above the page, never sent by itself. Only where the bridge has tell.
	function notRight(changes, view, key) {
		const bridge = window.qorpera;
		if (!bridge || typeof bridge.tell !== "function") return null;
		const w = ui.model.words;
		const st = ui.told || {};
		const b = h("button", `mp-pill${st.done ? " told" : ""}`, { type: "button", "aria-busy": String(!!st.busy) }, st.done ? w.told || w.notRight : w.tell || w.notRight);
		if (st.done) b.setAttribute("aria-disabled", "true");
		const why = st.why ? h("p", "mp-why", { role: "status" }, st.why) : null;
		b.addEventListener("click", async () => {
			const now = ui.told || {};
			if (now.busy || now.done) return;
			const settle = (next) => {
				ui.told = next;
				ui.toldFor = key;
				ui.parts.changes.__key = "";
				drawChanges(current(), false);
			};
			settle({ busy: true });
			try {
				await bridge.tell({ about: cut(view.first ? view.first.title : w.changed, MAX.about), text: cut(fill(w.draft, { changes: changes.map((c) => c.line.trim()).join("; ") }), MAX.draft) });
				settle({ done: true });
			} catch (err) {
				settle({ why: cut((err && err.message) || String(err || ""), 140) || "—" });
				setTimeout(() => {
					if (ui.told && ui.told.why) settle(null);
				}, 6000);
			}
		});
		return [b, why];
	}

	// ---------------------------------------------------------------- diving in and coming back
	function rectOf(el) {
		return el ? el.getBoundingClientRect() : null;
	}
	function dive$(id) {
		const parts = ui.things.get(id);
		const from = rectOf(parts && parts.shape);
		ui.path = [...ui.path, id];
		render({ zoom: "in", from });
		const first = ui.parts.canvas.querySelector(".mp-hit:is(button,a)");
		(first || ui.parts.trail.querySelector(".mp-crumb") || ui.parts.title).focus({ preventScroll: true });
	}
	/** Up to the layer at `depth` (0: the first), the focus on the thing that was opened from it. */
	function go(depth) {
		if (depth >= ui.path.length) return;
		const came = ui.path[depth];
		const from = rectOf(ui.parts && ui.parts.canvas);
		ui.path = ui.path.slice(0, depth);
		render({ zoom: "out", from, id: came });
		const back = ui.things.get(came);
		if (back && back.hit) back.hit.focus({ preventScroll: true });
	}
	D.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || e.isComposing || !ui.path.length || e.defaultPrevented) return;
		e.preventDefault();
		go(ui.path.length - 1);
	});

	// ---------------------------------------------------------------- size changes
	let resizeFrame = 0;
	window.addEventListener("resize", () => {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!ui.model || !ui.root) return;
			const W = (ui.parts.stage && ui.parts.stage.clientWidth) || 0;
			if (W === ui.width && window.innerHeight === ui.height) return;
			render(null);
		});
	});

	// ---------------------------------------------------------------- loading
	let lastRead = 0;
	let pending = 0;
	let lastText = null;
	// a reading that could not be read waits before it is asked again: every refusal counts against the page
	let readingWait = 0;
	let readingFails = 0;
	async function live(model) {
		const bridge = window.qorpera;
		if (!bridge) return;
		if (model.names && typeof bridge.reading === "function" && Date.now() >= readingWait) {
			try {
				const answer = await bridge.reading();
				if (isObj(answer)) ui.live.reading = answer;
				readingFails = 0;
			} catch (err) {
				readingFails++;
				// a manifest without reading asks no more until the page opens again: the company's map then has none
				if (/reads in app\.toml/.test(String(err && err.message))) {
					readingWait = Infinity;
					if (ui.live.reading === undefined) ui.live.reading = null;
				} else readingWait = Date.now() + Math.min(6e5, 1e4 * 2 ** (readingFails - 1));
			}
		} else if (typeof bridge.reading !== "function" && ui.live.reading === undefined) ui.live.reading = null;
		if (typeof bridge.agents === "function" && typeof bridge.reading !== "function")
			try {
				const agents = await bridge.agents();
				if (Array.isArray(agents)) ui.live.agents = agents;
			} catch {
				/* the page may not read agents */
			}
	}
	async function load() {
		lastRead = Date.now();
		let txt;
		let raw = null;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "map.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			raw = JSON.parse(txt);
			const model = txt === lastText && ui.model ? ui.model : normalize(raw);
			await live(model);
			// the company's map before its reading could be read once: nothing to draw yet, and asked again
			if (model.top === "reading" && ui.live.reading === undefined) {
				if (!ui.root) quiet(model.words.empty);
				clearTimeout(pending);
				pending = setTimeout(load, Math.min(6e5, Math.max(1e4, readingWait - Date.now())));
				return;
			}
			const key = JSON.stringify([txt, ui.live.reading, ui.live.agents]);
			if (key === ui.drawn && ui.root) return;
			const first = !ui.drawn || !ui.root;
			ui.model = model;
			lastText = txt;
			ui.drawn = key;
			render(first ? null : "update");
		} catch {
			if (!ui.root) quiet((raw && isObj(raw.words) && cut(raw.words.empty, 60)) || EN.empty);
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
