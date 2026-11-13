// The path kit's engine: "How does it go, and where is the hole?"
// One to three lanes (groups of people) run left to right through the same steps. Each step is a node on the path;
// the evidence (marks) sits as dots under the step it supports; a step nobody has shown dissolves into fog with a
// gently pulsing "?". When steps carry values the path becomes a band to scale (a funnel).
// The agent writes only path.json (see KIT.md). Plain ES2020, one IIFE, no network, colours only from --q-* tokens.
(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	// A concept's page is the thing itself: the Concepts viewer beside it already names the app, says what it is and
	// who made it, so the page carries no title block and keeps almost nothing around its stage (Jonas, 13 November
	// 2026: "get rid of it ... minimize the borders/framing around the visual we are just trying to show"). Every
	// control, sheet and detail stays as it is. `concept` comes from the page (kitPage), never from the data.
	const BARE = KIT.concept === true;
	const SVGNS = "http://www.w3.org/2000/svg";
	const MAX = { title: 40, line: 60, step: 22, lane: 22, note: 90, mark: 40, kind: 14, next: 60, by: 22, figValue: 10, figLabel: 28, word: 28 };
	const WORDS = {
		known: "known",
		assumed: "assumed",
		unknown: "unknown",
		total: "in all",
		noMarks: "No evidence yet",
		close: "Close",
		next: "Next",
		empty: "Nothing to show yet.",
		more: "more",
		// a note to the app's owner: the button's label, naming the agent ("Ask Luna"), and what it says once sent
		tell: "",
		told: "",
	};
	const STATES = ["known", "assumed", "unknown"];
	const reduceMQ = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const still = () => reduceMQ.matches;

	// ---------------------------------------------------------------- figures (drawn pictures for a lane)
	// 48 x 48, stroked in the company colour; class f = soft fill, s = solid, w = window dots, bg = page-coloured.
	const FIG = {
		person: '<circle class="f" cx="24" cy="15.5" r="7"/><path class="f" d="M10.5 40.5c1.4-7.6 6.6-12 13.5-12s12.1 4.4 13.5 12z"/>',
		group:
			'<circle class="f" cx="24" cy="15" r="6.2"/><path class="f" d="M13.5 39c1.2-6.8 5-10.8 10.5-10.8S33.3 32.2 34.5 39z"/><circle cx="11.5" cy="19.5" r="4.4"/><path d="M4 37c.8-4.8 3.6-7.6 7.5-7.6 1.3 0 2.5.3 3.6.9"/><circle cx="36.5" cy="19.5" r="4.4"/><path d="M44 37c-.8-4.8-3.6-7.6-7.5-7.6-1.3 0-2.5.3-3.6.9"/>',
		office:
			'<path class="f" d="M11 41V9.5A2.5 2.5 0 0 1 13.5 7h13A2.5 2.5 0 0 1 29 9.5V41"/><path d="M29 17h6.5a2.5 2.5 0 0 1 2.5 2.5V41M6 41h36M17.5 41v-5.5h5V41"/><path class="w" d="M16.3 13.5h.4M23.3 13.5h.4M16.3 20h.4M23.3 20h.4M16.3 26.5h.4M23.3 26.5h.4M33.3 24h.4M33.3 30.5h.4"/>',
		home: '<path class="f" d="M11 21v19.5h26V21L24 10.5z"/><path d="M7 24 24 9.5 41 24"/><path d="M20.5 40.5v-7.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v7.5"/>',
		heart:
			'<path class="f" d="M24 39.5S9.5 31.2 9.5 20.6C9.5 15.3 13.4 11 18.4 11c2.6 0 4.6 1.3 5.6 3.2 1-1.9 3-3.2 5.6-3.2 5 0 8.9 4.3 8.9 9.6C38.5 31.2 24 39.5 24 39.5z"/>',
		cart: '<path class="f" d="M12.8 15.5h27l-3.5 14a2 2 0 0 1-1.9 1.5H16.2z"/><path d="M5.5 9h4.2a2 2 0 0 1 2 1.6l4.6 20.4"/><circle cx="18.5" cy="37.5" r="2.6"/><circle cx="33" cy="37.5" r="2.6"/>',
		coin: '<circle class="f" cx="24" cy="24" r="15.5"/><circle cx="24" cy="24" r="10.5" opacity=".5"/><path class="s" d="M24 18.5 29.5 24 24 29.5 18.5 24z"/>',
		headset:
			'<path d="M10.5 28v-4a13.5 13.5 0 0 1 27 0v4"/><rect class="f" x="7" y="26" width="7.5" height="11.5" rx="3"/><rect class="f" x="33.5" y="26" width="7.5" height="11.5" rx="3"/><path d="M37.5 37.5v1a4 4 0 0 1-4 4H28"/>',
		box: '<path class="f" d="M24 7.5 39 15.5v17L24 40.5 9 32.5v-17z"/><path d="M9 15.5 24 23.5l15-8M24 23.5v17M16.5 11.5l15 8"/>',
		truck:
			'<path class="f" d="M5 14.5A1.5 1.5 0 0 1 6.5 13h19a1.5 1.5 0 0 1 1.5 1.5V32H5z"/><path d="M27 19h7.6l5.4 6.6V32H27"/><circle class="bg" cx="13" cy="33.5" r="3.6"/><circle class="bg" cx="33" cy="33.5" r="3.6"/>',
		chat: '<path class="f" d="M10 10.5h28a3.5 3.5 0 0 1 3.5 3.5v15a3.5 3.5 0 0 1-3.5 3.5H22l-7.5 6.5v-6.5H10A3.5 3.5 0 0 1 6.5 29V14a3.5 3.5 0 0 1 3.5-3.5z"/><circle class="s" cx="17" cy="21.5" r="1.9"/><circle class="s" cx="24" cy="21.5" r="1.9"/><circle class="s" cx="31" cy="21.5" r="1.9"/>',
		question:
			'<circle class="f" cx="24" cy="24" r="15.5"/><path d="M19.4 19.6a4.8 4.8 0 1 1 7 4.3c-1.5.8-2.4 1.8-2.4 3.5v.6"/><circle class="s" cx="24" cy="32.6" r="1.6"/>',
		store:
			'<path class="f" d="M9.5 21v19.5h29V21"/><path d="M7 15 10 8.5h28l3 6.5c0 2.8-2.3 5-5 5s-5-2.2-5-5c0 2.8-2.3 5-5 5s-5-2.2-5-5c0 2.8-2.3 5-5 5s-5-2.2-5-5z"/><path d="M20 40.5V32h8v8.5"/>',
		factory:
			'<path class="f" d="M6 40.5V21l9 5.5V21l9 5.5V21l9 5.5V9.5A1.5 1.5 0 0 1 34.5 8h4A1.5 1.5 0 0 1 40 9.5v31z"/><path d="M4 40.5h40"/><path class="w" d="M12.8 34h.4M20.8 34h.4M28.8 34h.4"/>',
	};
	const FIG_ALIAS = { people: "group", team: "group", company: "office", building: "office", house: "home", shop: "store", money: "coin", price: "coin", package: "box", delivery: "truck", talk: "chat", speech: "chat", unknown: "question", love: "heart", headband: "headset" };

	// ---------------------------------------------------------------- style
	const CSS = `
body{margin:0}
.pk{position:relative;box-sizing:border-box;min-height:100vh;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);-webkit-tap-highlight-color:transparent;overflow-x:hidden;
 --pk-fog:var(--q-muted);--pk-pic:color-mix(in srgb,var(--q-accent) 11%,var(--q-bg));--pk-ease:cubic-bezier(.22,.8,.24,1)}
.pk *,.pk *::before,.pk *::after{box-sizing:border-box}
.pk-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;column-gap:40px;row-gap:18px}
.pk-head{min-width:0;max-width:34em}
.pk--bare{padding:clamp(12px,1vw,16px)}
.pk--bare .pk-head{display:none}
.pk--bare .pk-top:not(:has(.pk-figs)){display:none}
.pk--bare .pk-top:not(:has(.pk-figs))+.pk-map{margin-top:0}
.pk-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.pk-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.pk-figs{display:flex;gap:clamp(24px,4vw,56px);align-items:flex-start}
.pk-fig{min-width:0;transition:opacity .25s var(--pk-ease)}
.pk-fig-row{display:flex;align-items:baseline;gap:.32em;white-space:nowrap}
.pk-fig-n{font-size:clamp(44px,7vw,96px);font-weight:650;letter-spacing:-.03em;line-height:.92;font-variant-numeric:tabular-nums}
.pk-fig-u{font-size:clamp(17px,1.75vw,24px);font-weight:600;letter-spacing:-.01em;color:var(--q-muted)}
.pk-fig-l{margin-top:9px;font-size:14px;line-height:1.3;color:var(--q-muted);max-width:16em}
.pk-fig.warn .pk-fig-n{color:var(--q-warn)}
.pk-fig.warn .pk-fig-u{color:color-mix(in srgb,var(--q-warn) 72%,var(--q-bg))}
.pk-fig-l .q{display:inline-grid;place-items:center;width:17px;height:17px;margin-right:7px;vertical-align:-3px;border-radius:50%;border:1.4px dashed color-mix(in srgb,var(--q-warn) 80%,var(--q-bg));color:var(--q-warn);font-size:10.5px;font-weight:700;line-height:1}
.pk-fig.unk .pk-fig-n{color:var(--q-muted)}
.pk-fig.sm .pk-fig-n{font-size:clamp(28px,3.4vw,40px)}
.pk-map{position:relative;margin-top:clamp(10px,2.2vh,26px)}
.pk-map svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;max-width:none}
.pk-quiet{color:var(--q-muted);font-size:15px;margin:0}
/* paths */
.pk-ln{fill:none;stroke-linecap:round;stroke-linejoin:round}
.pk-ln.k{stroke:var(--q-accent)}
.pk-ln.body{stroke:var(--q-accent);stroke-opacity:.11}
.pk-ln.a{stroke:var(--q-accent);stroke-dasharray:9 8}
.pk-ln.dots{stroke:var(--pk-fog);stroke-dasharray:.1 9;opacity:.8}
.pk-ln.dots.deep{opacity:.5}
.pk-flow{fill:var(--q-accent)}
.pk-band.k{fill:var(--q-accent);fill-opacity:.24}
.pk-band.a{fill:var(--q-accent);fill-opacity:.1;stroke:var(--q-accent);stroke-width:1.4;stroke-dasharray:5 5}
.pk-band-edge{fill:none;stroke:var(--q-accent);stroke-width:1.2;stroke-opacity:.55}
.pk-meridian{stroke:var(--q-line);stroke-width:1;stroke-dasharray:2 6}
.pk-fog-tint{fill:var(--q-text);fill-opacity:.07}
.pk-fog-hatch{color:var(--pk-fog);opacity:.24}
.pk-hatch-line{fill:currentColor}
.pk-mask-blob{fill:currentColor}
/* lane identity */
.pk-ident{position:absolute;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px}
.pk-pic{position:relative;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:none;
 background:radial-gradient(130% 130% at 28% 20%,color-mix(in srgb,var(--q-accent) 22%,var(--q-bg)),var(--pk-pic) 64%);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--q-accent) 16%,transparent)}
.pk-pic img,.pk-pic video{width:100%;height:100%;object-fit:cover;display:block}
.pk-pic svg{position:static;max-width:none;width:56%;height:56%;color:var(--q-accent);fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.pk-pic svg .f{fill:currentColor;fill-opacity:.17}
.pk-pic svg .s{fill:currentColor;stroke:none}
.pk-pic svg .w{stroke-width:3.4}
.pk-pic svg .bg{fill:var(--pk-pic)}
.pk-pic.ph{background:var(--q-surface);box-shadow:inset 0 0 0 1px var(--q-line)}
.pk-pic.ph span{font-size:28px;font-weight:600;color:var(--q-muted)}
.pk-ident.sm .pk-lane-name{font-size:14px}
.pk-lane-name{font-size:16px;font-weight:600;line-height:1.25;letter-spacing:-.005em;max-width:100%;overflow-wrap:anywhere}
/* step labels */
.pk-step{position:absolute;font-size:15px;font-weight:600;line-height:1.25;letter-spacing:-.005em;text-wrap:balance;transition:color .2s}
.pk-step.h{text-align:center}
.pk-step.dim{color:var(--q-muted);font-weight:550}
.pk-step.hl{color:var(--q-warn)}
.pk-step small{display:block;font-size:13px;font-weight:500;color:var(--q-muted);margin-top:2px}
/* nodes */
.pk-node{position:absolute;margin:0;padding:0;border:0;background:none;border-radius:50%;cursor:pointer;color:inherit;font:inherit;display:grid;place-items:center;transition:scale .25s var(--pk-ease),opacity .25s}
.pk-node:focus-visible{outline:2px solid var(--q-accent);outline-offset:0}
.pk-ring{position:relative;display:grid;place-items:center;border-radius:50%;transition:box-shadow .25s var(--pk-ease),transform .25s var(--pk-ease)}
.pk-node.k .pk-ring{width:var(--pk-nd,22px);height:var(--pk-nd,22px);background:var(--q-bg);border:var(--pk-nw,4px) solid var(--q-accent)}
.pk-node.a .pk-ring{width:var(--pk-nd,22px);height:var(--pk-nd,22px);background:var(--q-bg);border:3px dashed var(--q-accent)}
.pk-node.u .pk-ring{width:var(--pk-ud,34px);height:var(--pk-ud,34px);background:var(--q-bg);border:2px dashed color-mix(in srgb,var(--q-warn) 80%,var(--q-bg));color:var(--q-warn);font-size:var(--pk-uq,16px);font-weight:700;line-height:1;box-shadow:0 0 18px 10px var(--q-bg)}
.pk-node.u::after{content:"";position:absolute;left:50%;top:50%;width:var(--pk-ud,34px);height:var(--pk-ud,34px);margin:calc(var(--pk-ud,34px) / -2) 0 0 calc(var(--pk-ud,34px) / -2);border-radius:50%;border:1.5px solid color-mix(in srgb,var(--q-warn) 60%,transparent);opacity:0;animation:pk-pulse 3.6s ease-out infinite;animation-delay:var(--pd,0s);pointer-events:none}
.pk-node:hover .pk-ring,.pk-node.open .pk-ring{transform:scale(1.18)}
.pk-node.k:hover .pk-ring,.pk-node.k.open .pk-ring{box-shadow:0 0 0 6px color-mix(in srgb,var(--q-accent) 20%,transparent)}
.pk-node.a:hover .pk-ring,.pk-node.a.open .pk-ring{box-shadow:0 0 0 6px color-mix(in srgb,var(--q-text) 7%,transparent)}
.pk-node.u:hover .pk-ring,.pk-node.u.open .pk-ring{box-shadow:0 0 18px 10px var(--q-bg),0 0 0 7px color-mix(in srgb,var(--q-warn) 16%,transparent)}
.pk-node.u:hover .pk-ring,.pk-node.u.open .pk-ring,.pk-node.u.hl .pk-ring{transform:scale(1.08)}
.pk-node.hl .pk-ring{box-shadow:0 0 18px 10px var(--q-bg),0 0 0 7px color-mix(in srgb,var(--q-warn) 22%,transparent)}
.pk-val{position:absolute;font-size:clamp(22px,2.4vw,30px);font-weight:650;letter-spacing:-.025em;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none}
.pk-val.a{color:var(--q-muted)}
.pk-tag{position:absolute;font-size:12.5px;line-height:1;padding:4px 8px 5px;border-radius:999px;border:1px dashed color-mix(in srgb,var(--q-muted) 70%,transparent);color:var(--q-muted);white-space:nowrap;pointer-events:none}
/* evidence dots */
.pk-dot{position:absolute;margin:0;padding:0;border:0;background:none;border-radius:50%;cursor:pointer;display:grid;place-items:center}
.pk-dot i{display:grid;place-items:center;width:var(--dd,16px);height:var(--dd,16px);border-radius:50%;background:var(--q-accent);color:var(--q-on-accent);transition:transform .2s var(--pk-ease),box-shadow .2s}
.pk-dot i svg{position:static;width:58%;height:58%;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
.pk-dot i b{font-size:calc(var(--dd,16px) * .46);font-weight:700;line-height:1;font-style:normal}
.pk-dot.a i{background:var(--q-bg);color:var(--q-accent);box-shadow:inset 0 0 0 2px var(--q-accent)}
.pk-dot:hover i,.pk-dot.on i,.pk-dot:focus-visible i{transform:scale(1.18)}
.pk-dot.on i{box-shadow:0 0 0 4px color-mix(in srgb,var(--q-accent) 22%,transparent)}
.pk-dot:focus-visible{outline:2px solid var(--q-accent);outline-offset:0}
.pk-map.glow .pk-dot i{box-shadow:0 0 0 4px color-mix(in srgb,var(--q-accent) 22%,transparent)}
.pk-count{position:absolute;white-space:nowrap;font-size:13px;line-height:22px;color:var(--q-muted);pointer-events:none;transition:opacity .25s}
.pk-count b{font-size:16px;font-weight:650;color:var(--q-text);margin-right:5px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.pk-more{position:absolute;font-size:13px;color:var(--q-muted);line-height:22px;pointer-events:none;font-variant-numeric:tabular-nums}
.pk-map.focus .pk-lanegroup,.pk-map.focus .pk-node:not(.open),.pk-map.focus .pk-dot:not(.mine),.pk-map.focus .pk-val:not(.mine),.pk-map.focus .pk-count:not(.mine){opacity:.32}
.pk-lanegroup{transition:opacity .25s}
.pk-dot,.pk-val{transition:opacity .25s}
/* the next flag */
.pk-flag{position:absolute;pointer-events:none}
.pk-flag svg{position:absolute;overflow:visible}
.pk-pole{stroke:var(--q-text);stroke-width:1.8;stroke-linecap:round}
.pk-foot{fill:var(--q-text);fill-opacity:.16}
.pk-pennant{fill:var(--q-accent);transform-box:fill-box;transform-origin:0 50%}
.pk-clear{position:absolute;background:var(--q-bg);filter:blur(12px);opacity:.94;border-radius:30px}
.pk-flag-text{position:absolute;font-size:15px;font-weight:600;line-height:20px;letter-spacing:-.005em;text-wrap:balance}
.pk-flag-text .what{display:block}
.pk-flag-text .by{display:flex;align-items:center;gap:6px;margin-top:8px;line-height:1.2;font-size:13px;font-weight:500;color:var(--q-muted)}
.pk-flag-text .by b{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--q-accent);color:var(--q-on-accent);font-size:11px;font-weight:650}
.pk-flag-text .lbl{display:block;font-size:12.5px;line-height:16px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--q-accent);margin-bottom:4px}
/* floating sheet and tip */
.pk-sheet,.pk-tip{position:absolute;z-index:5;background:color-mix(in srgb,var(--q-text) 3%,var(--q-bg));border:1px solid var(--q-line);border-radius:16px;
 box-shadow:0 1px 2px color-mix(in srgb,var(--q-text) 6%,transparent),0 14px 40px -8px color-mix(in srgb,var(--q-text) 22%,transparent)}
.pk-sheet{width:320px;padding:16px 16px 10px;animation:pk-sheet .22s var(--pk-ease) both}
.pk-sheet-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
.pk-sheet-title{flex:1;font-size:13px;line-height:1.35;color:var(--q-muted);padding-top:2px}
.pk-sheet-title b{display:block;font-size:15px;font-weight:650;color:var(--q-text)}
.pk-x{flex:none;width:32px;height:32px;margin:-6px -6px 0 0;border:0;border-radius:10px;background:none;color:var(--q-muted);font:inherit;font-size:20px;line-height:1;cursor:pointer}
.pk-x:hover{background:var(--q-surface);color:var(--q-text)}
.pk-note{margin:0 0 10px;font-size:14.5px;line-height:1.45}
.pk-state{display:inline-block;font-size:12.5px;line-height:1;padding:4px 8px 5px;border-radius:999px;margin:0 0 10px;color:var(--q-muted);border:1px dashed color-mix(in srgb,var(--q-muted) 70%,transparent)}
.pk-state.u{color:var(--q-warn);border-color:color-mix(in srgb,var(--q-warn) 55%,transparent)}
.pk-rows{list-style:none;margin:0 -8px;padding:0;border-top:1px solid var(--q-line)}
.pk-row{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 8px;border-radius:10px;color:inherit;text-decoration:none;font-size:14px;line-height:1.3}
a.pk-row:hover{background:var(--q-surface)}
.pk-row i{flex:none;width:9px;height:9px;border-radius:50%;background:var(--q-accent)}
.pk-row i.a{background:none;box-shadow:inset 0 0 0 1.6px var(--q-accent)}
.pk-row span{flex:1;min-width:0}
.pk-row em,.pk-tip-t em{font-style:normal;font-size:12px;font-weight:500;line-height:1;padding:3px 7px 4px;border-radius:999px;background:color-mix(in srgb,var(--q-text) 6%,var(--q-bg));color:var(--q-muted);white-space:nowrap}
.pk-row .go{flex:none;color:var(--q-muted);font-size:14px;width:16px;text-align:right}
a.pk-row:hover .go{color:var(--q-accent)}
.pk-none{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 0;font-size:14px;color:var(--q-muted)}
.pk-none i{width:16px;height:16px;border-radius:50%;border:1.5px dashed color-mix(in srgb,var(--q-warn) 70%,transparent)}
.pk-tip{width:max-content;max-width:280px;padding:10px 8px 10px 14px;display:flex;align-items:center;gap:10px;animation:pk-sheet .16s var(--pk-ease) both}
.pk-tip-t{min-width:0;font-size:14px;font-weight:600;line-height:1.3}
.pk-tip-t em{display:inline-block;margin-top:5px}
.pk-tip a{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:var(--q-accent);text-decoration:none;font-size:16px}
.pk-tip a:hover{background:var(--q-surface)}
.pk-sheet.dock{position:fixed;left:12px;right:12px;bottom:12px;top:auto;width:auto;max-height:62vh;overflow:auto}
/* a note to the app's owner, at the foot of a step's sheet */
/* the reason a note did not go stands quietly beside the button, over a cell that holds no height of its own, so
   nothing moves when it comes and goes */
.pk-tell{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:12px;margin:6px 0}
.pk-tell-c{position:relative;align-self:stretch}
.pk-tell-b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:40px;min-height:40px;margin:0;padding:0 15px 0 11px;border:0;border-radius:999px;background:color-mix(in srgb,var(--q-text) 7%,transparent);color:var(--q-text);font:inherit;font-size:14px;font-weight:550;line-height:1.2;cursor:pointer;transition:background .2s,opacity .2s}
.pk-tell-b:hover{background:color-mix(in srgb,var(--q-text) 12%,transparent)}
.pk-tell-b:focus-visible{outline:2px solid var(--q-accent);outline-offset:2px}
.pk-tell-b.pk-bare{padding:0}
.pk-tell-b svg{position:static;flex:none;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pk-tell-b[aria-busy=true]{opacity:.55;cursor:progress}
.pk-tell-b.pk-told{background:none;color:var(--q-muted);cursor:default;padding-left:3px}
.pk-tell-b.pk-told.pk-bare{padding:0}
.pk-tell-b.pk-told svg{color:var(--q-good)}
.pk-tell-why{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);margin:0;font-size:13px;line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:var(--q-muted)}
/* motion */
@keyframes pk-pulse{0%{transform:scale(1);opacity:.6}70%,100%{transform:scale(1.75);opacity:0}}
@keyframes pk-sheet{from{opacity:0;transform:translateY(4px)}}
@keyframes pk-wave{0%,100%{transform:skewY(0deg) scaleX(1)}50%{transform:skewY(-5deg) scaleX(.94)}}
@keyframes pk-drift{from{transform:translateX(0)}to{transform:translateX(-26px)}}
.pk-pennant{animation:pk-wave 4.2s ease-in-out infinite}
.pk-intro .pk-lanepath{animation:pk-revealx .52s var(--pk-ease) both;animation-delay:var(--d)}
.pk-intro.pk-v .pk-lanepath{animation-name:pk-revealy}
@keyframes pk-revealx{from{clip-path:inset(-60px 100% -60px -60px)}to{clip-path:inset(-60px -60px -60px -60px)}}
@keyframes pk-revealy{from{clip-path:inset(-60px -60px 100% -60px)}to{clip-path:inset(-60px -60px -60px -60px)}}
.pk-intro .pk-ident,.pk-intro .pk-step{animation:pk-fade .45s var(--pk-ease) both;animation-delay:var(--d)}
.pk-intro .pk-node,.pk-intro .pk-val,.pk-intro .pk-tag{animation:pk-pop .36s var(--pk-ease) both;animation-delay:var(--d)}
.pk-intro .pk-dot,.pk-intro .pk-more,.pk-intro .pk-count{animation:pk-drop .32s var(--pk-ease) both;animation-delay:var(--d)}
.pk-intro .pk-fogwrap{animation:pk-fogin .5s ease-out both;animation-delay:var(--d)}
.pk-intro .pk-flag{animation:pk-rise .3s var(--pk-ease) both;animation-delay:var(--d)}
.pk-intro .pk-fig{animation:pk-fade .5s var(--pk-ease) both;animation-delay:var(--d)}
@keyframes pk-fade{from{opacity:0;transform:translateY(4px)}}
@keyframes pk-pop{from{opacity:0;transform:scale(.4)}}
@keyframes pk-drop{from{opacity:0;transform:translateY(-14px)}}
@keyframes pk-fogin{from{opacity:0;transform:translateX(36px)}}
@keyframes pk-rise{from{opacity:0;transform:translateY(12px)}}
@media (prefers-reduced-motion:reduce){
 .pk *,.pk *::before,.pk *::after{animation:none!important;transition:none!important}
 .pk-node.u::after{display:none}
}
@media (max-width:520px){.pk-fig-l{font-size:13px}}
`;

	// ---------------------------------------------------------------- small helpers
	const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
	const list = (v) => (Array.isArray(v) ? v : []);
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const text = (v) => (v == null ? "" : typeof v === "string" || typeof v === "number" ? String(v) : "");
	function cut(v, n) {
		let s = text(v).replace(/\s+/g, " ").trim();
		const chars = Array.from(s);
		if (chars.length > n) s = `${chars.slice(0, n - 1).join("").trimEnd()}…`;
		return s;
	}
	function el(tag, cls, attrs, kids) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (attrs) for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
		if (kids != null) for (const k of [].concat(kids)) if (k != null && k !== "") e.append(k);
		return e;
	}
	function sv(tag, attrs, kids) {
		const e = document.createElementNS(SVGNS, tag);
		if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
		if (kids) for (const k of [].concat(kids)) if (k) e.append(k);
		return e;
	}
	function safeLink(v) {
		const s = text(v).trim();
		if (/^https:\/\/[^\s]+$/i.test(s) || /^(folder|app):[^\s]+$/i.test(s) || /^#[\w-]+$/.test(s)) return s;
		return "";
	}
	function place(e, x, y, w, h) {
		e.style.left = `${Math.round(x * 10) / 10}px`;
		e.style.top = `${Math.round(y * 10) / 10}px`;
		if (w != null) e.style.width = `${Math.round(w)}px`;
		if (h != null) e.style.height = `${Math.round(h)}px`;
		return e;
	}
	const r1 = (n) => Math.round(n * 10) / 10;
	let measureCtx = null;
	function measure(str, font) {
		if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
		if (!measureCtx) return str.length * 8;
		measureCtx.font = font;
		return measureCtx.measureText(str).width;
	}

	// ---------------------------------------------------------------- a note to the app's owner
	// qorpera.tell (RUNTIME-INTERFACE-APPS.md §3b and §5): one quiet button at the foot of a step's sheet, drawn only
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
		for (const x of document.querySelectorAll(".pk-tell-b")) if (x.__tell) x.__tell.paint();
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
		const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
		return Array.from(s).length <= 40 ? s : "";
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
		const b = el("button", "pk-tell-b", { type: "button" });
		const why = el("p", "pk-tell-why", { role: "status", "aria-live": "polite" });
		const paint = () => {
			const st = TOLD.get(key) || {};
			const label = st.done ? words.told : words.tell;
			const mark = sv("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
			mark.innerHTML = st.done ? TELL_ICON.tick : TELL_ICON.note;
			b.replaceChildren(mark);
			if (label) b.append(el("span", null, null, label));
			b.classList.toggle("pk-bare", !label);
			b.classList.toggle("pk-told", !!st.done);
			if (label) b.removeAttribute("aria-label");
			else b.setAttribute("aria-label", st.done ? "Sent" : "Send a note");
			b.setAttribute("aria-busy", String(!!st.busy));
			if (st.done) b.setAttribute("aria-disabled", "true");
			else b.removeAttribute("aria-disabled");
			why.textContent = st.why || "";
		};
		b.__tell = { key, paint };
		b.addEventListener("click", async (ev) => {
			ev.stopPropagation();
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
				for (const x of document.querySelectorAll(".pk-tell-b")) if (x.__tell && x.__tell.key === key) x.__tell.paint();
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
		return el("div", "pk-tell", null, [b, el("div", "pk-tell-c", null, why)]);
	}

	// ---------------------------------------------------------------- the data
	function markWords(v, fallback) {
		if (typeof v === "string" && v.trim()) return { one: cut(v, MAX.word), many: cut(v, MAX.word) };
		if (Array.isArray(v) && v.length) return { one: cut(v[0], MAX.word), many: cut(v[1] ?? v[0], MAX.word) };
		if (isObj(v)) {
			const one = cut(v.one ?? v.singular ?? v.many ?? v.plural, MAX.word);
			const many = cut(v.many ?? v.plural ?? v.other ?? v.one ?? v.singular, MAX.word);
			if (one || many) return { one: one || many, many: many || one };
		}
		return fallback;
	}

	function normalize(raw) {
		if (!isObj(raw)) throw new Error("The data is not an object.");
		const lang = typeof raw.lang === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = Object.assign({}, WORDS);
		if (isObj(raw.words)) for (const k of Object.keys(WORDS)) if (cut(raw.words[k], MAX.word)) words[k] = cut(raw.words[k], MAX.word);
		const mw = markWords(raw.markWord ?? raw.markWords, lang === "da" ? { one: "kilde", many: "kilder" } : { one: "mark", many: "marks" });

		// steps
		const steps = [];
		const byId = new Map();
		for (const s of list(raw.steps)) {
			const id = text(typeof s === "string" ? s : isObj(s) ? (s.id ?? s.name) : "").trim();
			if (!id || byId.has(id)) continue;
			const name = cut(typeof s === "string" ? s : (s.name ?? s.id), MAX.step) || cut(id, MAX.step);
			const st = { id, name, i: steps.length };
			steps.push(st);
			byId.set(id, st);
			if (steps.length >= 6) break;
		}
		const findStep = (v) => {
			const k = text(v).trim();
			if (!k) return null;
			return byId.get(k) || steps.find((s) => s.name.toLowerCase() === k.toLowerCase() || s.id.toLowerCase() === k.toLowerCase()) || null;
		};

		// lanes
		let lanesRaw = list(raw.lanes).filter(isObj).slice(0, 3);
		if (!lanesRaw.length) lanesRaw = [{ id: "_", name: "" }];
		const lanes = [];
		const laneIds = new Set();
		lanesRaw.forEach((l, i) => {
			let id = text(l.id ?? l.name).trim() || `lane${i + 1}`;
			if (laneIds.has(id)) id = `${id}_${i}`;
			laneIds.add(id);
			const fig = text(l.figure).trim().toLowerCase();
			const lane = {
				id,
				i,
				name: cut(l.name ?? (id === "_" ? "" : id), MAX.lane),
				figure: FIG[fig] ? fig : FIG[FIG_ALIAS[fig]] ? FIG_ALIAS[fig] : "",
				picture: typeof l.picture === "string" ? l.picture.trim() : "",
				at: new Map(),
				derived: false,
			};
			const given = l.steps;
			for (const st of steps) {
				let e;
				if (Array.isArray(given)) e = given.find((x) => (typeof x === "string" ? x : isObj(x) ? (x.id ?? x.step) : null) === st.id);
				else if (isObj(given)) e = given[st.id];
				if (e === undefined || e === null) continue;
				if (typeof e === "string") e = { state: e };
				if (!isObj(e)) e = {};
				const state = text(e.state).trim().toLowerCase();
				const num = typeof e.value === "number" && Number.isFinite(e.value) ? e.value : null;
				lane.at.set(st.id, {
					state: STATES.includes(state) ? state : "",
					value: num,
					valueText: num == null ? cut(e.value, MAX.figValue) : "",
					note: cut(e.note, MAX.note),
					ask: askOf(e.ask),
					marks: [],
				});
			}
			if (!lane.at.size) {
				lane.derived = true;
				for (const st of steps) lane.at.set(st.id, { state: "", value: null, valueText: "", note: "", marks: [] });
			}
			lanes.push(lane);
		});
		const findLane = (v) => {
			const k = text(v).trim().toLowerCase();
			if (!k) return null;
			return lanes.find((l) => l.id.toLowerCase() === k || l.name.toLowerCase() === k) || null;
		};

		// marks
		const marks = [];
		for (const m of list(raw.marks).slice(0, 120)) {
			if (!isObj(m)) continue;
			const st = findStep(m.step);
			const name = cut(m.name ?? m.title, MAX.mark);
			if (!st || !name) continue;
			const spec = m.lane;
			let targets;
			if (spec == null || spec === "" || spec === "all" || spec === "*") targets = lanes.filter((l) => l.at.has(st.id));
			else {
				const wanted = (Array.isArray(spec) ? spec : [spec]).map(findLane).filter(Boolean);
				targets = wanted.length ? wanted : lanes.filter((l) => l.at.has(st.id));
				for (const l of targets) if (!l.at.has(st.id)) l.at.set(st.id, { state: "known", value: null, valueText: "", note: "", marks: [] });
			}
			if (!targets.length) continue;
			const mark = { key: marks.length, name, kind: cut(m.kind, MAX.kind), step: st.id, source: safeLink(m.source) };
			marks.push(mark);
			for (const l of targets) l.at.get(st.id).marks.push(mark);
		}

		// states: what the agent said, else read from the marks (a mark reaches its step and every step before it)
		for (const lane of lanes) {
			const order = steps.filter((s) => lane.at.has(s.id));
			let last = -1;
			order.forEach((s, k) => {
				const e = lane.at.get(s.id);
				if (e.marks.length || e.value != null) last = k;
			});
			order.forEach((s, k) => {
				const e = lane.at.get(s.id);
				if (!e.state) e.state = k <= last ? "known" : "unknown";
				if (e.state === "unknown") {
					e.value = null;
					e.valueText = "";
				}
			});
			lane.order = order.map((s) => s.id);
		}

		// next
		let next = null;
		if (isObj(raw.next) && cut(raw.next.text, MAX.next)) {
			const nl = raw.next.lane == null || raw.next.lane === "all" ? null : findLane(raw.next.lane);
			let st = findStep(raw.next.step);
			const pool = nl ? [nl] : lanes;
			if (!st || !pool.some((l) => l.at.has(st.id))) {
				st = null;
				for (const s of steps) if (pool.some((l) => l.at.get(s.id)?.state === "unknown")) { st = s; break; }
				if (!st) st = steps[steps.length - 1] || null;
			}
			if (st) next = { text: cut(raw.next.text, MAX.next), by: cut(raw.next.by, MAX.by), step: st.id, lane: nl ? nl.id : (lanes.length === 1 ? lanes[0].id : "all") };
		}

		// hand-given figures
		const figures = list(raw.figures)
			.filter(isObj)
			.slice(0, 3)
			.map((f) => {
				const state = text(f.state).toLowerCase();
				const value = typeof f.value === "number" && Number.isFinite(f.value) ? f.value : cut(f.value, MAX.figValue);
				return { value: state === "unknown" ? "?" : value, label: cut(f.label, MAX.figLabel), unit: cut(f.unit, 12), state: STATES.includes(state) ? state : "known" };
			})
			.filter((f) => f.value !== "" || f.label);

		return { lang, title: cut(raw.title, MAX.title), line: cut(raw.line, MAX.line), words, mw, steps, lanes, marks, next, figures };
	}

	// ---------------------------------------------------------------- what the engine works out by itself
	function compute(m) {
		const nf = new Intl.NumberFormat(m.lang);
		const pf = (v) => new Intl.NumberFormat(m.lang, { style: "percent", maximumFractionDigits: v < 0.1 ? 1 : 0 }).format(v);
		const out = [];
		const unit = (n) => (n === 1 ? m.mw.one : m.mw.many);
		// a mark counts for its step and every step before it in its lane
		const reach = new Map(m.steps.map((s) => [s.id, new Set()]));
		for (const lane of m.lanes) {
			lane.order.forEach((sid, k) => {
				for (const later of lane.order.slice(k)) for (const mk of lane.at.get(later).marks) reach.get(sid).add(mk.key);
			});
		}
		let weakest = null;
		if (m.marks.length) {
			out.push({ n: m.marks.length, text: nf.format(m.marks.length), unit: unit(m.marks.length), label: m.words.total, kind: "total" });
			for (const s of m.steps) {
				if (!m.lanes.some((l) => l.at.has(s.id))) continue;
				const c = reach.get(s.id).size;
				if (!weakest || c < weakest.c) weakest = { c, step: s };
			}
			if (weakest && weakest.c < m.marks.length)
				out.push({ n: weakest.c, text: nf.format(weakest.c), unit: unit(weakest.c), label: weakest.step.name, hole: true, kind: "weak", step: weakest.step.id, warn: true });
		}
		// a funnel: the end of the first lane with numbers, and its weakest passage
		const funnel = m.lanes.find((l) => l.order.filter((id) => l.at.get(id).value != null).length >= 2);
		if (funnel) {
			const pts = funnel.order.filter((id) => funnel.at.get(id).value != null).map((id) => ({ id, v: funnel.at.get(id).value, name: m.steps.find((s) => s.id === id).name }));
			const first = pts[0];
			const last = pts[pts.length - 1];
			let drop = null;
			for (let k = 1; k < pts.length; k++) {
				if (pts[k - 1].v <= 0) continue;
				const r = pts[k].v / pts[k - 1].v;
				if (!drop || r < drop.r) drop = { r, a: pts[k - 1], b: pts[k] };
			}
			const fun = [];
			if (first.v > 0) fun.push({ text: pf(last.v / first.v), label: `${first.name} → ${last.name}`, kind: "conv" });
			if (drop && pts.length > 2) fun.push({ text: pf(drop.r), label: `${drop.a.name} → ${drop.b.name}`, kind: "weak", step: drop.b.id, warn: true });
			out.unshift(...fun);
		}
		const given = m.figures.map((f) => ({ text: typeof f.value === "number" ? nf.format(f.value) : f.value, n: typeof f.value === "number" ? f.value : null, unit: f.unit, label: f.label, kind: "given", unk: f.state === "unknown" }));
		const figures = [...out.slice(0, 2), ...given, ...out.slice(2)].slice(0, 3);
		return { figures, nf };
	}

	// ---------------------------------------------------------------- the page
	let model = null;
	let calc = null;
	let root = null;
	let mapEl = null;
	let introDone = false;
	const ui = { open: null, tip: null, tipPinned: false };
	let tipEl = null;
	let sheetEl = null;
	let tipTimer = 0;
	let geom = null;

	function injectStyle() {
		if (document.getElementById("pk-style")) return;
		const st = document.createElement("style");
		st.id = "pk-style";
		st.textContent = CSS;
		document.head.append(st);
	}

	function quiet(msg) {
		injectStyle();
		if (!root) {
			root = el("main", BARE ? "pk pk--bare" : "pk");
			document.body.append(root);
		}
		root.replaceChildren(el("p", "pk-quiet", null, msg));
	}

	function render() {
		injectStyle();
		const m = model;
		document.documentElement.lang = m.lang;
		if (!root) {
			root = el("main", BARE ? "pk pk--bare" : "pk");
			document.body.append(root);
		}
		const animate = !introDone && !still();
		root.classList.toggle("pk-intro", animate);
		calc = compute(m);
		const head = el("div", "pk-head", null, [m.title ? el("h1", "pk-title", null, m.title) : null, m.line ? el("p", "pk-line", null, m.line) : null]);
		const figs = el("div", "pk-figs");
		calc.figures.forEach((f, i) => {
			const n = el("span", "pk-fig-n", null, f.text);
			const box = el("div", `pk-fig${f.warn ? " warn" : ""}${f.unk ? " unk" : ""}`, null, [
				el("div", "pk-fig-row", null, [n, f.unit ? el("span", "pk-fig-u", null, f.unit) : null]),
				f.label ? el("div", "pk-fig-l", null, [f.hole ? el("span", "q", { "aria-hidden": "true" }, "?") : null, f.label]) : null,
			]);
			box.style.setProperty("--d", `${80 + i * 80}ms`);
			if (f.kind === "total") {
				box.addEventListener("pointerenter", () => mapEl && mapEl.classList.add("glow"));
				box.addEventListener("pointerleave", () => mapEl && mapEl.classList.remove("glow"));
			}
			if (f.step) {
				box.addEventListener("pointerenter", () => highlightStep(f.step, true));
				box.addEventListener("pointerleave", () => highlightStep(f.step, false));
			}
			if (animate && f.n != null && Number.isFinite(f.n) && f.n > 0 && Number.isInteger(f.n)) countUp(n, f.n, calc.nf, 80 + i * 80);
			figs.append(box);
		});
		const top = el("div", "pk-top", null, [head, calc.figures.length ? figs : null]);
		mapEl = el("div", "pk-map");
		root.replaceChildren(top, mapEl);
		layout();
		if (animate) {
			introDone = true;
			setTimeout(() => root && root.classList.remove("pk-intro"), 1700);
		}
	}

	function countUp(node, to, nf, delay) {
		const t0 = performance.now() + delay;
		const dur = 640;
		node.textContent = nf.format(0);
		const tick = (now) => {
			const p = clamp((now - t0) / dur, 0, 1);
			const e = 1 - (1 - p) ** 3;
			node.textContent = nf.format(Math.round(to * e));
			if (p < 1) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	function highlightStep(stepId, on) {
		if (!mapEl) return;
		for (const e of mapEl.querySelectorAll(`[data-step="${CSS_escape(stepId)}"]`)) e.classList.toggle("hl", on);
	}
	const CSS_escape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

	// ---------------------------------------------------------------- layout and drawing
	function pictureFor(lane, size) {
		const pic = el("div", "pk-pic");
		pic.style.width = pic.style.height = `${Math.round(size)}px`;
		let media = null;
		if (lane.picture) {
			const host = document.getElementById("kit-media");
			const src = host && Array.from(host.querySelectorAll("[data-kit-src]")).find((e) => e.getAttribute("data-kit-src") === lane.picture);
			if (src) {
				media = src.cloneNode(true);
				media.removeAttribute("hidden");
				media.setAttribute("alt", "");
				if (media.tagName === "VIDEO") {
					media.muted = true;
					media.loop = true;
					media.playsInline = true;
					if (!still()) media.autoplay = true;
				}
			}
		}
		if (media) pic.append(media);
		else if (lane.figure || !lane.picture) {
			const s = sv("svg", { viewBox: "0 0 48 48", "aria-hidden": "true" });
			s.innerHTML = FIG[lane.figure || "person"];
			pic.append(s);
		} else {
			pic.classList.add("ph");
			pic.append(el("span", null, null, Array.from(lane.name || "?")[0].toUpperCase()));
		}
		return pic;
	}

	function layout() {
		if (!model || !mapEl) return;
		const m = model;
		const W = mapEl.clientWidth;
		if (!W) return;
		const vertical = W < 640;
		root.classList.toggle("pk-v", vertical);
		const g = vertical ? geomV(m, W) : geomH(m, W);
		geom = g;
		mapEl.style.height = `${Math.round(g.H)}px`;
		const keepFocus = document.activeElement && mapEl.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null;
		mapEl.replaceChildren();
		closeTip(true);
		// a sheet docked on a phone hangs on root, not on the map: take it away too before it is drawn again
		if (sheetEl) sheetEl.remove();
		sheetEl = null;
		draw(m, g);
		if (keepFocus) {
			const back = mapEl.querySelector(`[data-key="${CSS_escape(keepFocus)}"]`);
			if (back) back.focus({ preventScroll: true });
		}
		if (ui.open) openSheet(ui.open.lane, ui.open.step, true);
	}

	// Sizes that grow with the room: k = 1 at a 1280 x 800 laptop with two lanes.
	function sizes(k, phone) {
		if (phone) return { nodeD: 24, ringW: 5, uD: 44, uQ: 19, dotD: 22, pitch: 27, lineW: 5, bodyW: 18 };
		return {
			nodeD: Math.round(30 * k),
			ringW: Math.max(4, Math.round(6 * k)),
			uD: Math.round(58 * k),
			uQ: Math.round(25 * k),
			dotD: Math.round(28 * k),
			pitch: Math.round(35 * k),
			lineW: r1(6 * k),
			bodyW: Math.round(24 * k),
		};
	}

	// how the flag's words wrap, for room above a lane
	function flagTextH(m, width) {
		if (!m.next) return 0;
		const font = getComputedStyle(root).fontFamily;
		const lines = Math.max(1, Math.ceil((measure(m.next.text, `600 15px ${font}`) + 8) / Math.max(80, width)));
		return 20 + lines * 20 + (m.next.by ? 30 : 4);
	}
	const flagLanes = (m) => {
		if (!m.next) return [];
		if (m.next.lane === "all") {
			// every lane where that step is still a hole; else where it is only assumed; else every lane that has it
			const where = (ok) => m.lanes.map((l, i) => (l.at.has(m.next.step) && ok(l.at.get(m.next.step).state) ? i : -1)).filter((i) => i >= 0);
			const holes = where((st) => st === "unknown");
			if (holes.length) return holes;
			const guesses = where((st) => st === "assumed");
			return guesses.length ? guesses : where(() => true);
		}
		const i = m.lanes.findIndex((l) => l.id === m.next.lane);
		return i >= 0 ? [i] : [];
	};

	// Horizontal: lanes are rows, steps are columns.
	function geomH(m, W) {
		const L = m.lanes.length;
		const S = m.steps.length;
		const pad = parseFloat(getComputedStyle(root).paddingBottom) || 24;
		const avail = window.innerHeight - mapEl.offsetTop - pad;
		const hasVal = m.lanes.some((l) => l.order.some((id) => l.at.get(id).value != null || l.at.get(id).valueText));
		const headerH = 46;
		const font = getComputedStyle(root).fontFamily;
		const rowAvail = Math.max(150, (avail - headerH) / L);
		const k = clamp(Math.min(rowAvail / (L === 1 ? 300 : 252), W / 1180), 0.68, L === 1 ? 1.25 : 1.16);
		const z = sizes(k, false);
		const pic = Math.round(clamp(rowAvail * 0.56, 64, 156 * k));
		const nameW = Math.max(0, ...m.lanes.map((l) => Math.min(200, measure(l.name, `600 16px ${font}`))));
		const identW = Math.max(pic, nameW);
		const x0 = identW + clamp(W * 0.065, 48, 104);
		const lastW = Math.min(170, measure(m.steps[S - 1]?.name || "", `600 15px ${font}`));
		const x1 = W - Math.max(z.uD / 2 + 10, clamp(lastW / 2 + 8, 44, 96));
		const spacing = S > 1 ? (x1 - x0) / (S - 1) : 240;
		const stepPos = m.steps.map((s, k2) => (S > 1 ? x0 + spacing * k2 : (x0 + x1) / 2));
		const perRow = clamp(Math.floor((spacing * 0.5) / z.pitch), 2, 6);
		const maxBand = hasVal ? clamp(rowAvail * 0.26, 22, 72) : 0;
		const fl = flagLanes(m);
		const textW = clamp(spacing * 0.8, 160, 270);
		const fH = flagTextH(m, textW);
		// room each lane needs above its line and below it
		const above = [];
		const below = [];
		m.lanes.forEach((lane, i) => {
			let rows = 0;
			let tag = false;
			for (const id of lane.order) {
				const e = lane.at.get(id);
				rows = Math.max(rows, Math.ceil(Math.min(e.marks.length, perRow * 4) / perRow));
				if (e.state === "assumed") tag = true;
			}
			let a = Math.max(pic / 2, z.uD / 2 + 10);
			if (hasVal) a = Math.max(a, maxBand / 2 + 56);
			if (tag) a = Math.max(a, z.nodeD / 2 + 40 + (hasVal ? 40 : 0));
			if (fl[0] === i) a = Math.max(a, fH + z.uD * 0.2 + 8);
			above.push(a);
			const dots = z.nodeD / 2 + 18 + rows * z.pitch + (hasVal ? maxBand / 2 : 0);
			below.push(Math.max(pic / 2 + 40, dots, z.uD / 2 + 12));
		});
		const need = headerH + above.reduce((a, b) => a + b, 0) + below.reduce((a, b) => a + b, 0);
		const H = Math.max(avail, need + (L - 1) * 24);
		const rest = H - need;
		const between = L > 1 ? clamp(rest / (L - 1 + 1.1), 24, 96) : 0;
		const left = rest - between * (L - 1);
		const headerTop = left * 0.42;
		const lines = [];
		let y = headerTop + headerH;
		m.lanes.forEach((l, i) => {
			y += above[i];
			lines.push(y);
			y += below[i] + between;
		});
		return { vertical: false, W, H, L, S, k, z, headerH, headerTop, above, below, between, pic, identW, x0, x1, spacing, stepPos, lines, maxBand, hasVal, perRow, textW, P: (f, c) => [f, c] };
	}

	// Vertical (phone): lanes are columns, steps are rows; step names in the left column.
	function geomV(m, W) {
		const L = m.lanes.length;
		const S = m.steps.length;
		const z = sizes(1, true);
		const hasVal = m.lanes.some((l) => l.order.some((id) => l.at.get(id).value != null || l.at.get(id).valueText));
		const stepW = clamp(W * 0.27, 88, 150);
		const colW = (W - stepW) / L;
		const pic = clamp(colW * 0.44, 44, 64);
		const font = getComputedStyle(root).fontFamily;
		const nameLines = Math.max(1, ...m.lanes.map((l) => Math.ceil(measure(l.name, `600 14px ${font}`) / (colW - 4))));
		const headerH = pic + 10 + Math.min(2, nameLines) * 18 + 20;
		const laneX = m.lanes.map((l, i) => stepW + colW * i + Math.max(z.uD / 2 + 4, colW * (L === 1 ? 0.18 : 0.27)));
		const dotsW = stepW + colW - laneX[0] - z.nodeD / 2 - 14;
		const perRow = clamp(Math.floor((dotsW + z.pitch - z.dotD) / z.pitch), 1, 8);
		let rowsMax = 1;
		for (const l of m.lanes) for (const id of l.order) rowsMax = Math.max(rowsMax, Math.ceil(Math.min(l.at.get(id).marks.length, perRow * 4) / perRow));
		const rowH = clamp(34 + rowsMax * z.pitch + 22 + (hasVal ? 28 : 0), 100, 190);
		const fl = flagLanes(m);
		const textW = W - (fl.length ? laneX[fl[0]] - z.uD / 2 : stepW) - 4;
		const flagH = m.next ? flagTextH(m, textW) + 18 : 0;
		const stepPos = [];
		let y = headerH + 44;
		m.steps.forEach((s) => {
			stepPos.push(y);
			y += rowH + (m.next && m.next.step === s.id ? flagH : 0);
		});
		const H = stepPos[S - 1] + rowH * 0.62 + (m.next && m.next.step === m.steps[S - 1].id ? flagH : 0);
		const maxBand = hasVal ? clamp(colW * 0.22, 14, 34) : 0;
		return { vertical: true, W, H, L, S, k: 1, z, headerH, rowH, pic, stepW, colW, laneX, lines: laneX, perRow, spacing: rowH, stepPos, maxBand, hasVal, flagH, textW, P: (f, c) => [c, f] };
	}

	// a small sign for the kind of a mark, from words in Danish and English; else the kind's first letter
	const KIND_SIGNS = [
		["bars", "statisti data tal survey spørgeskema måling measure poll analyse analysis undersøgelse"],
		["pillars", "myndighed authority government offentlig public ministeri styrelse agency regulator lov law"],
		["case", "case kundecase eksempel example"],
		["book", "studie study forskning research paper videnskab science"],
		["person", "historie story testimonial citat quote bruger user person kunde customer"],
		["chat", "interview samtale conversation call opkald møde meeting chat mail besked message"],
		["star", "anmeldelse review rating bedømmelse vurdering"],
		["cart", "ordre order køb purchase sale salg faktura invoice bestilling"],
		["doc", "artikel article rapport report notat note side page web blog dokument document"],
		["play", "video film"],
		["flask", "test forsøg eksperiment experiment pilot prototype"],
		["coin", "pris price betaling payment budget"],
	].map(([sign, words]) => [sign, words.split(" ")]);
	const SIGN_PATHS = {
		bars: "M3 10V7.2M6 10V3.2M9 10V5.4",
		pillars: "M1.8 4.4 6 2l4.2 2.4M2.8 5.6v3.6M6 5.6v3.6M9.2 5.6v3.6M1.8 10.2h8.4",
		case: "M2.2 4.4h7.6a.8.8 0 0 1 .8.8v4.2a.8.8 0 0 1-.8.8H2.2a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8zM4.3 4.4V3.2a.7.7 0 0 1 .7-.7h2a.7.7 0 0 1 .7.7v1.2",
		book: "M6 3.4C4.9 2.6 3.4 2.3 1.8 2.4v6.8c1.6-.1 3.1.2 4.2 1 1.1-.8 2.6-1.1 4.2-1V2.4c-1.6-.1-3.1.2-4.2 1zM6 3.4v6.8",
		person: "M6 5.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM2.6 10.3c.4-1.9 1.7-3 3.4-3s3 1.1 3.4 3",
		chat: "M2.2 2.6h7.6a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H5.4L3.2 10.4V8.6h-1a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8z",
		star: "M6 1.7l1.3 2.7 2.9.4-2.1 2 .5 2.9L6 8.3 3.4 9.7l.5-2.9-2.1-2 2.9-.4z",
		cart: "M1.4 2.2h1.4l1.2 5.6h5.2l1.1-4H3.4M4.9 10.2h.1M8.7 10.2h.1",
		doc: "M3 1.6h4.2l2.2 2.2v6.4a.4.4 0 0 1-.4.4H3a.4.4 0 0 1-.4-.4V2a.4.4 0 0 1 .4-.4zM4.4 5.8h3.2M4.4 7.8h3.2",
		play: "M4.2 2.6v6.8L9.4 6z",
		flask: "M4.6 1.8h2.8M5 1.8v3L2.4 9.4a.8.8 0 0 0 .7 1.2h5.8a.8.8 0 0 0 .7-1.2L7 4.8v-3",
		coin: "M6 10.4a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8zM6 3.8v4.4",
	};
	function signFor(mk) {
		const kind = (mk.kind || "").toLowerCase();
		if (kind) {
			const tokens = kind.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
			for (const [sign, words] of KIND_SIGNS) if (tokens.some((t) => words.some((w) => t.startsWith(w)))) return { path: SIGN_PATHS[sign] };
		}
		const letter = Array.from(mk.kind || mk.name || "")[0];
		return letter ? { letter: letter.toUpperCase() } : null;
	}
	function dotFace(mk, withSign) {
		const i = el("i");
		if (!withSign) return i;
		const sign = signFor(mk);
		if (sign && sign.path) {
			const s = sv("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" });
			s.append(sv("path", { d: sign.path }));
			i.append(s);
		} else if (sign) i.append(el("b", null, { "aria-hidden": "true" }, sign.letter));
		return i;
	}

	function draw(m, g) {
		const { P, z } = g;
		const pt = (f, c) => P(f, c).map(r1).join(" ");
		const intro = root.classList.contains("pk-intro");
		const lineDur = 520;
		const laneDelay = (i) => 30 + i * 60;
		// time at which the drawing line reaches a flow position
		const reachAt = (i, f) => {
			const start = g.vertical ? g.headerH : 0;
			const end = g.vertical ? g.H : g.W;
			const p = clamp((f - start) / Math.max(1, end - start), 0, 1);
			// the reveal eases out, so the line reaches far columns early
			return laneDelay(i) + lineDur * 0.85 * (1 - (1 - p) ** (1 / 3));
		};
		const maxVal = Math.max(1, ...m.lanes.flatMap((l) => l.order.map((id) => l.at.get(id).value ?? 0)));
		const thick = (v) => (v == null || !g.maxBand ? 0 : Math.max(5, (v / maxVal) * g.maxBand));
		const nodeHalf = (e) => (e.state === "unknown" ? z.uD / 2 : z.nodeD / 2);
		mapEl.style.setProperty("--pk-nd", `${z.nodeD}px`);
		mapEl.style.setProperty("--pk-nw", `${z.ringW}px`);
		mapEl.style.setProperty("--pk-ud", `${z.uD}px`);
		mapEl.style.setProperty("--pk-uq", `${z.uQ}px`);
		const fogAt = 360;
		const flagAt = 560;

		// meridians and step labels
		const back = sv("svg", { width: g.W, height: g.H, "aria-hidden": "true" });
		mapEl.append(back);
		const font = getComputedStyle(root).fontFamily;
		const labels = [];
		m.steps.forEach((s, k) => {
			const used = m.lanes.filter((l) => l.at.has(s.id));
			const allUnknown = used.length && used.every((l) => l.at.get(s.id).state === "unknown");
			const lab = el("div", `pk-step${g.vertical ? "" : " h"}${allUnknown ? " dim" : ""}`, { "data-step": s.id }, s.name);
			if (g.vertical) {
				place(lab, 0, g.stepPos[k] - 19, g.stepW - 12);
				lab.style.minHeight = "38px";
				lab.style.display = "flex";
				lab.style.alignItems = "center";
			} else {
				const w = Math.min(g.spacing - 18, 200);
				place(lab, g.stepPos[k] - w / 2, g.headerTop, w);
				lab.style.height = `${g.headerH - 12}px`;
				lab.style.display = "flex";
				lab.style.alignItems = "flex-end";
				lab.style.justifyContent = "center";
				// a quiet meridian through the column
				const lastI = g.lines.length - 1;
				back.append(sv("line", { class: "pk-meridian", x1: r1(g.stepPos[k]), y1: r1(g.headerTop + g.headerH - 2), x2: r1(g.stepPos[k]), y2: r1(Math.min(g.H - 4, g.lines[lastI] + g.below[lastI] * 0.8)) }));
			}
			lab.style.setProperty("--d", `${laneDelay(0) + k * 40}ms`);
			labels.push(lab);
		});

		// layers: lane lines, then the fog, then nodes and dots on top
		const fogBlobs = [];
		const front = document.createDocumentFragment();

		m.lanes.forEach((lane, i) => {
			const c = g.lines[i];
			const group = el("div", "pk-lanegroup");
			group.dataset.lane = lane.id;
			mapEl.append(group);
			// identity
			const ident = el("div", "pk-ident");
			ident.append(pictureFor(lane, g.pic));
			if (lane.name) ident.append(el("div", "pk-lane-name", null, lane.name));
			if (g.vertical) {
				const w = g.colW;
				place(ident, g.laneX[i] - w / 2, 0, w);
				ident.style.gap = "8px";
				ident.classList.add("sm");
			} else place(ident, 0, c - g.pic / 2, g.identW);
			ident.style.setProperty("--d", `${Math.max(0, laneDelay(i) - 40)}ms`);
			group.append(ident);

			// the lane's path
			const svg = sv("svg", { class: "pk-lanepath", width: g.W, height: g.H, "aria-hidden": "true" });
			svg.style.setProperty("--d", `${laneDelay(i)}ms`);
			const defs = sv("defs");
			svg.append(defs);
			group.append(svg);
			const startF = g.vertical ? g.headerH - 2 : (g.identW + g.pic) / 2 + 10;
			let prevF = startF;
			let prev = null;
			lane.order.forEach((sid, k) => {
				const s = m.steps.find((x) => x.id === sid);
				const e = lane.at.get(sid);
				const f = g.stepPos[s.i];
				const fromF = prev ? prevF + nodeHalf(prev) + 4 : prevF;
				const toF = f - nodeHalf(e) - 4;
				const tB = thick(e.value);
				const tA = prev ? thick(prev.value) : tB;
				if (e.state === "unknown") {
					// the line fades out and goes on as a faint dotted trail into the fog
					if (!prev || prev.state !== "unknown") {
						const gid = `pk-fade-${i}-${k}`;
						const [ax, ay] = P(fromF, c);
						const [bx, by] = P(toF, c);
						defs.append(
							sv("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: r1(ax), y1: r1(ay), x2: r1(bx), y2: r1(by) }, [
								sv("stop", { offset: "0", style: "stop-color:var(--q-accent);stop-opacity:1" }),
								sv("stop", { offset: "0.6", style: "stop-color:var(--q-accent);stop-opacity:0" }),
							]),
						);
						if (tA > 0) svg.append(sv("path", { d: bandPath(P, prev ? prevF : fromF, tA, toF, 1, c), fill: `url(#${gid})`, "fill-opacity": ".3" }));
						else svg.append(sv("path", { class: "pk-ln", d: `M${pt(prev ? prevF : fromF, c)}L${pt(toF, c)}`, stroke: `url(#${gid})`, "stroke-width": z.lineW }));
					}
					svg.append(sv("path", { class: `pk-ln dots${prev && prev.state === "unknown" ? " deep" : ""}`, d: `M${pt(fromF + 8, c)}L${pt(toF, c)}`, "stroke-width": r1(z.lineW * 0.55) }));
					// fog: around the node, over the trail leading in, and joining a neighbour lane that is also unknown here
					const rc = g.vertical ? g.colW * 0.46 : clamp((g.above[i] + g.below[i]) * 0.42, 58, 150);
					cloud(fogBlobs, f, c, g.spacing * 0.52, rc, i * 7 + k);
					if (!prev || prev.state !== "unknown") cloud(fogBlobs, f - g.spacing * 0.4, c, g.spacing * 0.3, rc * 0.55, i * 7 + k + 3);
					const nb = m.lanes[i + 1];
					if (nb && nb.at.get(sid)?.state === "unknown") {
						const c2 = g.lines[i + 1];
						cloud(fogBlobs, f, (c + c2) / 2, g.spacing * 0.48, (c2 - c) / 2 + 24, i * 7 + k + 5);
					}
				} else if (tA > 0 && tB > 0) {
					svg.append(sv("path", { class: `pk-band ${e.state === "assumed" ? "a" : "k"}`, d: bandPath(P, prev ? prevF : fromF, tA, f, tB, c) }));
				} else {
					const a0 = prev ? prevF : fromF;
					if (e.state === "known") svg.append(sv("path", { class: "pk-ln body", d: `M${pt(a0, c)}L${pt(f, c)}`, "stroke-width": z.bodyW }));
					svg.append(sv("path", { class: `pk-ln ${e.state === "assumed" ? "a" : "k"}`, d: `M${pt(a0, c)}L${pt(f, c)}`, "stroke-width": e.state === "assumed" ? r1(z.lineW * 0.75) : z.lineW }));
				}
				prev = e;
				prevF = f;
			});

			// a slow, sparse flow along the known part of the lane, fading where knowledge ends
			if (!still()) {
				let endF = null;
				let endUnknown = false;
				for (const sid of lane.order) {
					const e = lane.at.get(sid);
					const fs = g.stepPos[m.steps.find((x) => x.id === sid).i];
					if (e.state === "unknown") {
						endUnknown = true;
						endF = endF == null ? null : endF + (fs - endF) * 0.5;
						break;
					}
					endF = fs;
				}
				if (endF != null && endF > startF + 40) {
					const d = `M${pt(startF, c)}L${pt(endF, c)}`;
					const dur = clamp((endF - startF) / 70, 5, 12);
					for (let k = 0; k < 2; k++) {
						const begin = `${(1.2 + i * 1.3 + k * dur * 0.5).toFixed(2)}s`;
						svg.append(
							sv("circle", { class: "pk-flow", r: r1(z.lineW * 0.55), opacity: "0" }, [
								sv("animateMotion", { path: d, dur: `${dur}s`, begin, repeatCount: "indefinite", calcMode: "linear" }),
								sv("animate", { attributeName: "opacity", values: "0;.7;.7;0", keyTimes: endUnknown ? "0;.08;.7;1" : "0;.1;.85;1", dur: `${dur}s`, begin, repeatCount: "indefinite" }),
							]),
						);
					}
				}
			}

			// nodes, values, tags, dots, counts
			lane.order.forEach((sid) => {
				const s = m.steps.find((x) => x.id === sid);
				const e = lane.at.get(sid);
				const f = g.stepPos[s.i];
				const [x, y] = P(f, c);
				const cls = e.state === "unknown" ? "u" : e.state === "assumed" ? "a" : "k";
				const t = reachAt(i, f);
				const count = e.marks.length;
				const word = count === 1 ? m.mw.one : m.mw.many;
				const label = `${lane.name ? `${lane.name}, ` : ""}${s.name}: ${m.words[e.state]}, ${count} ${word}`;
				const node = el("button", `pk-node ${cls}`, { type: "button", "aria-label": label, "aria-expanded": "false", "data-step": sid, "data-key": `n:${lane.id}:${sid}` });
				node.append(el("span", "pk-ring", null, e.state === "unknown" ? "?" : null));
				const hit = Math.max(44, (e.state === "unknown" ? z.uD : z.nodeD) + 10);
				place(node, x - hit / 2, y - hit / 2, hit, hit);
				node.style.setProperty("--d", `${t}ms`);
				node.style.setProperty("--pd", `${(intro ? 1000 : 0) + i * 900 + s.i * 400}ms`);
				node.addEventListener("click", (ev) => {
					ev.stopPropagation();
					const isOpen = ui.open && ui.open.lane === lane.id && ui.open.step === sid;
					if (isOpen) closeSheet();
					else openSheet(lane.id, sid);
				});
				front.append(node);
				const half = Math.max(thick(e.value) / 2, nodeHalf(e));
				// value (funnel number)
				if (e.value != null || e.valueText) {
					const v = el("div", `pk-val${e.state === "assumed" ? " a" : ""}`, { "data-lane": lane.id, "data-step": sid }, e.value != null ? calc.nf.format(e.value) : e.valueText);
					if (g.vertical) {
						place(v, x + half + 12, y - 15);
						v.style.lineHeight = "30px";
					} else {
						const w = 180;
						place(v, x - w / 2, y - half - 46, w);
						v.style.textAlign = "center";
						v.style.lineHeight = "36px";
					}
					v.style.setProperty("--d", `${t + 40}ms`);
					front.append(v);
				}
				if (e.state === "assumed") {
					const tag = el("div", "pk-tag", null, m.words.assumed);
					const tw = measure(m.words.assumed, `12.5px ${font}`) + 18;
					if (g.vertical) place(tag, x + half + 12, e.value != null || e.valueText ? y + 18 : y - 11);
					else place(tag, x - tw / 2, y - half - (e.value != null || e.valueText ? 76 : 36));
					tag.style.setProperty("--d", `${t + 60}ms`);
					front.append(tag);
				}
				// the dots: a neat cluster under the step (beside it on a phone), each with a sign for its kind
				const marks = e.marks;
				if (!marks.length) return;
				const n = marks.length;
				const dense = n > 12;
				const pitch = dense ? Math.round(z.pitch * 0.7) : z.pitch;
				const dd = dense ? Math.max(14, Math.round(z.dotD * 0.62)) : z.dotD;
				const perRow = g.perRow + (dense ? 2 : 0);
				const cap = perRow * 4;
				const shown = n > cap ? marks.slice(0, cap - 1) : marks;
				const rows = Math.ceil(shown.length / perRow);
				const vOff = (e.value != null || e.valueText ? 30 : 0) + (g.vertical && e.state === "assumed" ? 26 : 0);
				let right = -Infinity;
				let firstY = 0;
				let lastY = 0;
				let leftX = Infinity;
				shown.forEach((mk, j) => {
					const r = Math.floor(j / perRow);
					const inRow = r < rows - 1 ? perRow : shown.length - r * perRow;
					const col = j % perRow;
					let dx;
					let dy;
					if (g.vertical) {
						dx = x + half + 10 + dd / 2 + col * pitch;
						dy = y + vOff + r * pitch;
					} else {
						dx = x + (col - (Math.min(perRow, shown.length) - 1) / 2) * pitch;
						if (r === rows - 1 && rows > 1) dx = x + (col - (inRow - 1) / 2) * pitch;
						dy = y + half + 14 + dd / 2 + r * pitch;
					}
					if (r === 0) {
						right = Math.max(right, dx + dd / 2);
						firstY = dy;
					}
					leftX = Math.min(leftX, dx - dd / 2);
					lastY = dy;
					const dot = el("button", `pk-dot${e.state === "known" ? "" : " a"}`, {
						type: "button",
						"aria-label": `${mk.name}${mk.kind ? `, ${mk.kind}` : ""}`,
						"data-key": `d:${lane.id}:${mk.key}`,
						"data-lane": lane.id,
						"data-step": sid,
					});
					dot.style.setProperty("--dd", `${dd}px`);
					dot.append(dotFace(mk, !dense));
					const box = Math.max(pitch - 2, dd + 4);
					place(dot, dx - box / 2, dy - box / 2, box, box);
					dot.style.setProperty("--d", `${t + 30 + j * 16}ms`);
					dot.addEventListener("pointerenter", (ev) => ev.pointerType === "mouse" && showTip(dot, mk, lane.id, false));
					dot.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && !ui.tipPinned && scheduleTipClose());
					dot.addEventListener("focus", () => showTip(dot, mk, lane.id, false));
					dot.addEventListener("blur", (ev) => {
						if (tipEl && ev.relatedTarget && tipEl.contains(ev.relatedTarget)) return;
						if (!ui.tipPinned) scheduleTipClose();
					});
					dot.addEventListener("click", (ev) => {
						ev.stopPropagation();
						const same = ui.tip && ui.tip.key === mk.key && ui.tip.lane === lane.id;
						if (same && ui.tipPinned) closeTip();
						else showTip(dot, mk, lane.id, true);
					});
					front.append(dot);
				});
				// how much is behind the step, said without hovering
				const cnt = el("div", "pk-count", { "data-lane": lane.id, "data-step": sid, "aria-hidden": "true" }, [el("b", null, null, calc.nf.format(n)), word]);
				if (g.vertical) place(cnt, leftX, lastY + dd / 2 + 4);
				else place(cnt, right + 10, firstY - 11);
				cnt.style.setProperty("--d", `${t + 60}ms`);
				front.append(cnt);
			});
		});

		// the fog (the hole), arriving last
		if (fogBlobs.length) {
			const wrap = el("div", "pk-fogwrap");
			wrap.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
			wrap.style.setProperty("--d", `${fogAt}ms`);
			const fog = sv("svg", { width: g.W, height: g.H, "aria-hidden": "true" });
			const blur = clamp(g.spacing * 0.075, 10, 26);
			const mask = sv("mask", { id: "pk-fogmask", maskUnits: "userSpaceOnUse", x: -200, y: -200, width: g.W + 400, height: g.H + 400, style: "mask-type:alpha" });
			const blobs = sv("g", { filter: "url(#pk-feather)" });
			const edge = (g.vertical ? g.H : g.W) + 6 - blur * 1.6;
			const crossLo = g.vertical ? g.stepW + blur * 0.6 : -Infinity;
			const crossHi = g.vertical ? g.W - blur * 0.6 : Infinity;
			for (const b of fogBlobs) {
				if (b.c - b.rc < crossLo) {
					const lo = Math.max(crossLo, b.c - b.rc);
					const hi = b.c + b.rc;
					b.c = (lo + hi) / 2;
					b.rc = (hi - lo) / 2;
				}
				if (b.c + b.rc > crossHi) {
					const lo = b.c - b.rc;
					b.c = (lo + crossHi) / 2;
					b.rc = Math.max(8, (crossHi - lo) / 2);
				}
				if (b.f + b.rf > edge) {
					const over = b.f + b.rf - edge;
					b.rf = Math.max(b.rf * 0.45, b.rf - over / 2);
					b.f = Math.min(b.f, edge - b.rf);
				}
				const [cx, cy] = P(b.f, b.c);
				const [rx, ry] = g.vertical ? [b.rc, b.rf] : [b.rf, b.rc];
				blobs.append(sv("ellipse", { class: "pk-mask-blob", cx: r1(cx), cy: r1(cy), rx: r1(rx), ry: r1(ry) }));
			}
			mask.append(blobs);
			const pat = sv("pattern", { id: "pk-hatch", width: "8", height: "8", patternUnits: "userSpaceOnUse", patternTransform: "rotate(-40)" }, [sv("rect", { class: "pk-hatch-line", width: "1.4", height: "8" })]);
			if (!still()) pat.append(sv("animate", { attributeName: "x", from: "0", to: "8", dur: "10s", repeatCount: "indefinite" }));
			fog.append(
				sv("defs", null, [sv("filter", { id: "pk-feather", x: "-60%", y: "-60%", width: "220%", height: "220%" }, [sv("feGaussianBlur", { stdDeviation: r1(blur) })]), mask, pat]),
				sv("g", { mask: "url(#pk-fogmask)" }, [
					sv("rect", { class: "pk-fog-tint", x: -100, y: -100, width: g.W + 200, height: g.H + 200 }),
					sv("rect", { class: "pk-fog-hatch", x: -100, y: -100, width: g.W + 200, height: g.H + 200, fill: "url(#pk-hatch)" }),
				]),
			);
			wrap.append(fog);
			mapEl.append(wrap);
		}
		mapEl.append(front);
		mapEl.append(...labels);

		// the next flag, planted in the hole
		if (m.next) drawFlag(m, g, flagAt);
	}

	function bandPath(P, fA, tA, fB, tB, c) {
		const p = (f, cc) => P(f, cc).map(r1).join(" ");
		const mid = (fA + fB) / 2;
		return `M${p(fA, c - tA / 2)}C${p(mid, c - tA / 2)} ${p(mid, c - tB / 2)} ${p(fB, c - tB / 2)}L${p(fB, c + tB / 2)}C${p(mid, c + tB / 2)} ${p(mid, c + tA / 2)} ${p(fA, c + tA / 2)}Z`;
	}

	// a soft cloud: one ellipse and a few smaller puffs around it, the same every time for the same place
	function cloud(out, f, c, rf, rc, seed) {
		const rnd = (k) => {
			const x = Math.sin((seed + 1) * 12.9898 + k * 78.233) * 43758.5453;
			return x - Math.floor(x);
		};
		out.push({ f, c, rf: rf * 0.86, rc });
		for (let k = 0; k < 4; k++) {
			const a = (k / 4) * Math.PI * 2 + rnd(k) * 1.2;
			out.push({ f: f + Math.cos(a) * rf * 0.42, c: c + Math.sin(a) * rc * 0.45, rf: rf * (0.42 + rnd(k + 9) * 0.22), rc: rc * (0.55 + rnd(k + 17) * 0.3) });
		}
	}

	// The next step: a flag planted in each "?" it will fill, the words beside the first one.
	function drawFlag(m, g, at) {
		const nx = m.next;
		const s = m.steps.find((x) => x.id === nx.step);
		const lanesIdx = flagLanes(m);
		if (!s || !lanesIdx.length) return;
		const f = g.stepPos[s.i];
		const z = g.z;
		const font = getComputedStyle(root).fontFamily;
		const ringR = (i) => (m.lanes[i].at.get(s.id).state === "unknown" ? z.uD / 2 : z.nodeD / 2);
		const tx = el("div", "pk-flag-text", null, [el("span", "lbl", null, m.words.next), el("span", "what", null, nx.text)]);
		if (nx.by) tx.append(el("span", "by", null, [el("b", null, null, Array.from(nx.by)[0].toUpperCase()), nx.by]));
		const textW = g.textW;
		const tw = Math.min(textW, measure(nx.text, `600 15px ${font}`) + 6);
		tx.style.width = `${Math.max(Math.min(130, textW), tw)}px`;

		lanesIdx.forEach((i, n) => {
			const [x, y] = g.P(f, g.lines[i]);
			const r = ringR(i);
			// the foot sits on the ring's upper right
			const fx = x + r * 0.62;
			const fy = y - r * 0.62;
			const withText = n === 0 && !g.vertical;
			const pole = withText ? Math.max(48, Math.round(fH() - r * 0.62 + 10)) : Math.round(clamp(r * 0.9 + 10, 26, 40));
			const flip = withText && fx + 30 + tw > g.W;
			const wrap = el("div", "pk-flag", { role: n === 0 ? "note" : null, "aria-hidden": n === 0 ? null : "true" });
			const px = flip ? 34 : 6;
			const svg = sv("svg", { width: 40, height: pole + 4 });
			svg.style.left = `${-px}px`;
			svg.style.top = "0";
			const pw = withText ? 26 : 20;
			const ph = withText ? 18 : 14;
			svg.append(
				sv("line", { class: "pk-pole", x1: px, y1: 1.5, x2: px, y2: pole }),
				sv("path", { class: "pk-pennant", d: flip ? `M${px} 2h-${pw}l6 ${ph / 2}-6 ${ph / 2}H${px}z` : `M${px} 2h${pw}l-6 ${ph / 2} 6 ${ph / 2}H${px}z` }),
			);
			wrap.append(svg);
			place(wrap, fx, fy - pole);
			wrap.style.setProperty("--d", `${at + n * 80}ms`);
			if (withText) {
				const clear = el("div", "pk-clear");
				tx.style.top = "-4px";
				if (flip) {
					tx.style.right = "36px";
					tx.style.textAlign = "right";
				} else tx.style.left = "34px";
				wrap.append(clear, tx);
				mapEl.append(wrap);
				place(clear, tx.offsetLeft - 14, tx.offsetTop - 10, tx.offsetWidth + 28, tx.offsetHeight + 20);
			} else mapEl.append(wrap);
		});
		if (g.vertical) {
			// on a phone the words stand in the room kept under the step's row
			const i = lanesIdx[0];
			const [x, y] = g.P(f, g.lines[i]);
			const box = el("div", "pk-flag pk-flag-v", { role: "note" });
			const clear = el("div", "pk-clear");
			tx.style.position = "relative";
			tx.style.width = `${g.textW}px`;
			box.append(clear, tx);
			place(box, x - z.uD / 2, y + z.uD / 2 + 14);
			box.style.setProperty("--d", `${at}ms`);
			mapEl.append(box);
			place(clear, -12, -8, tx.offsetWidth + 24, tx.offsetHeight + 16);
		}
		function fH() {
			return flagTextH(m, textW);
		}
	}

	// ---------------------------------------------------------------- the detail sheet (a tapped step)
	function openSheet(laneId, stepId, quietly) {
		const m = model;
		const lane = m.lanes.find((l) => l.id === laneId);
		const step = m.steps.find((s) => s.id === stepId);
		if (!lane || !step || !lane.at.has(stepId)) {
			closeSheet();
			return;
		}
		closeTip(true);
		if (sheetEl) sheetEl.remove();
		for (const n of mapEl.querySelectorAll(".pk-node.open")) {
			n.classList.remove("open");
			n.setAttribute("aria-expanded", "false");
		}
		for (const n of mapEl.querySelectorAll(".mine")) n.classList.remove("mine");
		ui.open = { lane: laneId, step: stepId };
		const e = lane.at.get(stepId);
		const node = mapEl.querySelector(`[data-key="${CSS_escape(`n:${laneId}:${stepId}`)}"]`);
		if (node) {
			node.classList.add("open");
			node.setAttribute("aria-expanded", "true");
		}
		const sel = `[data-lane="${CSS_escape(laneId)}"][data-step="${CSS_escape(stepId)}"]`;
		for (const d of mapEl.querySelectorAll(`.pk-dot${sel}, .pk-val${sel}, .pk-count${sel}`)) d.classList.add("mine");
		mapEl.classList.add("focus");
		for (const gr of mapEl.querySelectorAll(".pk-lanegroup")) gr.style.opacity = gr.dataset.lane === laneId ? "1" : "";

		const sh = el("div", "pk-sheet", { role: "dialog", "aria-label": `${lane.name ? `${lane.name} · ` : ""}${step.name}` });
		const x = el("button", "pk-x", { type: "button", "aria-label": m.words.close }, "×");
		x.addEventListener("click", (ev) => {
			ev.stopPropagation();
			closeSheet(true);
		});
		sh.append(el("div", "pk-sheet-head", null, [el("div", "pk-sheet-title", null, [el("b", null, null, step.name), lane.name || null]), x]));
		if (e.state !== "known") sh.append(el("span", `pk-state${e.state === "unknown" ? " u" : ""}`, null, m.words[e.state]));
		if (e.note) sh.append(el("p", "pk-note", null, e.note));
		if (e.marks.length) {
			const ul = el("ul", "pk-rows");
			for (const mk of e.marks) {
				const inner = [el("i", e.state === "known" ? null : "a"), el("span", null, null, mk.name), mk.kind ? el("em", null, null, mk.kind) : null];
				let row;
				if (mk.source) {
					row = el("a", "pk-row", { href: mk.source, target: mk.source.startsWith("https:") ? "_blank" : null, rel: mk.source.startsWith("https:") ? "noopener noreferrer" : null }, [...inner, el("span", "go", { "aria-hidden": "true" }, "↗")]);
				} else row = el("div", "pk-row", null, inner);
				ul.append(el("li", null, null, row));
			}
			sh.append(ul);
		} else sh.append(el("div", "pk-none", null, [el("i"), m.words.noMarks]));
		if (m.next && m.next.step === stepId && (m.next.lane === "all" || m.next.lane === laneId)) {
			sh.append(el("div", "pk-none", null, [el("span", null, { "aria-hidden": "true", style: "color:var(--q-accent)" }, "⚑"), `${m.words.next}: ${m.next.text}${m.next.by ? ` (${m.next.by})` : ""}`]));
		}
		// a path with no lanes of its own is one lane for all: its steps are named alone
		const one = laneId === "_";
		const tell = tellFoot(m.words, noteAbout(step.name, one ? "" : lane.name), one ? stepId : `${laneId}:${stepId}`, e.ask);
		if (tell) sh.append(tell);
		sh.addEventListener("click", (ev) => ev.stopPropagation());
		sheetEl = sh;
		const g = geom;
		if (g.vertical || window.innerWidth < 560) {
			sh.classList.add("dock");
			root.append(sh);
		} else {
			mapEl.append(sh);
			const [nx, ny] = g.P(g.stepPos[step.i], g.lines[lane.i]);
			const w = 320;
			sh.style.left = "0px";
			sh.style.top = "0px";
			const h = sh.offsetHeight;
			// under the step's own dots when there is room, else beside the step
			let below = ny + 24;
			for (const d of mapEl.querySelectorAll(`.pk-dot${sel}`)) below = Math.max(below, parseFloat(d.style.top) + d.offsetHeight + 8);
			below = Math.max(below, ny + (lane.at.get(stepId).state === "unknown" ? geom.z.uD : geom.z.nodeD) / 2 + 12);
			let left;
			let top;
			if (below + h <= g.H + 8) {
				left = clamp(nx - 44, 0, g.W - w);
				top = below;
			} else {
				left = nx + 30;
				if (left + w > g.W) left = nx - 30 - w;
				left = clamp(left, 0, g.W - w);
				top = clamp(ny - 26, 0, Math.max(0, g.H - h));
			}
			sh.style.left = `${left}px`;
			sh.style.top = `${top}px`;
		}
		if (quietly) sh.style.animation = "none";
	}

	function closeSheet(refocus) {
		const was = ui.open;
		ui.open = null;
		hushTold();
		if (sheetEl) sheetEl.remove();
		sheetEl = null;
		if (!mapEl) return;
		mapEl.classList.remove("focus");
		for (const gr of mapEl.querySelectorAll(".pk-lanegroup")) gr.style.opacity = "";
		for (const n of mapEl.querySelectorAll(".pk-node.open")) {
			n.classList.remove("open");
			n.setAttribute("aria-expanded", "false");
		}
		for (const n of mapEl.querySelectorAll(".mine")) n.classList.remove("mine");
		if (refocus && was) {
			const n = mapEl.querySelector(`[data-key="${CSS_escape(`n:${was.lane}:${was.step}`)}"]`);
			if (n) n.focus({ preventScroll: true });
		}
	}

	// ---------------------------------------------------------------- the tip (a dot under the pointer)
	function showTip(dot, mk, laneId, pin) {
		clearTimeout(tipTimer);
		if (ui.tip && ui.tip.key === mk.key && ui.tip.lane === laneId && tipEl) {
			if (pin) ui.tipPinned = true;
			return;
		}
		closeTip(true);
		ui.tip = { key: mk.key, lane: laneId };
		ui.tipPinned = !!pin;
		dot.classList.add("on");
		const t = el("div", "pk-tip", { role: "tooltip" });
		t.append(el("div", "pk-tip-t", null, [el("div", null, null, mk.name), mk.kind ? el("em", null, null, mk.kind) : null]));
		if (mk.source) {
			t.append(el("a", null, { href: mk.source, "aria-label": `${mk.name} ↗`, target: mk.source.startsWith("https:") ? "_blank" : null, rel: mk.source.startsWith("https:") ? "noopener noreferrer" : null }, "↗"));
		}
		t.addEventListener("pointerenter", () => clearTimeout(tipTimer));
		t.addEventListener("pointerleave", () => !ui.tipPinned && scheduleTipClose());
		t.addEventListener("click", (ev) => ev.stopPropagation());
		t.addEventListener("focusout", (ev) => {
			if (ev.relatedTarget && (t.contains(ev.relatedTarget) || ev.relatedTarget === dot)) return;
			if (!ui.tipPinned) scheduleTipClose();
		});
		// right after the dot in the document, so Tab reaches the ↗
		dot.after(t);
		tipEl = t;
		const dx = parseFloat(dot.style.left) + dot.offsetWidth / 2;
		const dy = parseFloat(dot.style.top) + dot.offsetHeight / 2;
		const w = t.offsetWidth;
		const h = t.offsetHeight;
		const W = mapEl.clientWidth;
		let left = clamp(dx - w / 2, -4, W - w + 4);
		let top = dy + dot.offsetHeight / 2 + 8;
		if (top + h > mapEl.clientHeight + 30) top = dy - dot.offsetHeight / 2 - 8 - h;
		t.style.left = `${left}px`;
		t.style.top = `${top}px`;
	}
	function scheduleTipClose() {
		clearTimeout(tipTimer);
		tipTimer = setTimeout(() => closeTip(), 160);
	}
	function closeTip(now) {
		clearTimeout(tipTimer);
		if (tipEl) tipEl.remove();
		tipEl = null;
		if (mapEl) for (const d of mapEl.querySelectorAll(".pk-dot.on")) d.classList.remove("on");
		ui.tip = null;
		ui.tipPinned = false;
	}

	// ---------------------------------------------------------------- global keys and taps
	document.addEventListener("keydown", (ev) => {
		if (ev.key !== "Escape") return;
		if (tipEl) {
			const key = ui.tip;
			closeTip();
			if (key && mapEl) {
				const d = mapEl.querySelector(`[data-key="${CSS_escape(`d:${key.lane}:${key.key}`)}"]`);
				if (d && document.activeElement !== d) d.focus({ preventScroll: true });
			}
		} else if (ui.open) closeSheet(true);
	});
	document.addEventListener("click", () => {
		if (tipEl) closeTip();
		if (ui.open) closeSheet();
	});

	let raf = 0;
	let lastW = 0;
	let lastH = 0;
	function onResize() {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(() => {
			if (!model || !mapEl) return;
			const w = root.clientWidth;
			const h = window.innerHeight;
			if (w === lastW && h === lastH) return;
			lastW = w;
			lastH = h;
			layout();
		});
	}
	window.addEventListener("resize", onResize);
	if (window.ResizeObserver) new ResizeObserver(onResize).observe(document.documentElement);

	// ---------------------------------------------------------------- loading
	let lastRead = 0;
	let pending = 0;
	async function load() {
		lastRead = Date.now();
		let raw;
		let txt;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			const app = KIT.app || "";
			const file = KIT.data || "path.json";
			const res = await bridge.read(`apps/${app}/${file}`);
			txt = typeof res === "string" ? res : res && (res.text ?? res.content);
			raw = JSON.parse(String(txt));
			const next = normalize(raw);
			if (!next.steps.length) throw new Error("no steps");
			model = next;
			render();
			lastW = root.clientWidth;
			lastH = window.innerHeight;
		} catch (err) {
			if (!model) quiet((raw && isObj(raw.words) && cut(raw.words.empty, 60)) || WORDS.empty);
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
		load();
		try {
			if (window.qorpera && typeof window.qorpera.onChange === "function") window.qorpera.onChange(onChange);
		} catch (e) {
			/* the frame may not offer it */
		}
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
