/* Qorpera interface kit "board": real things as pictures a founder compares or chooses between.
   One engine, three modes chosen by the data's `mode`:
     scale   things standing on one true scale (a shelf), unknown values in a dashed bay;
     choose  two to four directions side by side, each its own world, one of them chosen through the agent's question;
     wall    a masonry wall of reference pictures.
   The agent writes only board.json and the pictures. Plain ES2020, no network, colours from Qorpera's base style. */
(() => {
	"use strict";
	if (window.__qorperaBoardKit) return;
	window.__qorperaBoardKit = true;

	const D = document;
	const KIT = window.QORPERA_KIT || {};
	const RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
	const calm = () => !!(RM && RM.matches);
	const BASE_WORDS = {
		assumed: "assumed",
		unknown: "unknown",
		notKnown: "Not known yet",
		all: "All",
		close: "Close",
		source: "Source",
		choose: "Choose",
		recommended: "Recommended",
		chosen: "Chosen",
		saving: "Saving…",
		back: "Back",
		colours: "Colours",
		type: "Type",
		film: "Film",
		previous: "Previous",
		next: "Next",
		keep: "Keep",
		drop: "Drop",
		empty: "Nothing to show yet.",
	};
	let WORDS = { ...BASE_WORDS };
	let LANG = "en";

	/* ---------------------------------------------------------------- style */

	const STYLE = `
body{margin:0}
.bk{--glow:transparent;--pad:clamp(16px,2.6vw,36px);--ease:cubic-bezier(.2,.8,.2,1);--hair:color-mix(in srgb,var(--q-text) 13%,transparent);--rule:color-mix(in srgb,var(--q-text) 36%,transparent);--hatch:repeating-linear-gradient(135deg,color-mix(in srgb,var(--q-text) 13%,transparent) 0 1px,transparent 1px 6px);--shade:color-mix(in srgb,var(--q-text) 24%,transparent);box-sizing:border-box;min-height:100vh;margin:0;padding:var(--pad);display:flex;flex-direction:column;gap:clamp(14px,2.4vh,26px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);line-height:1.4;overflow-x:clip;position:relative;-webkit-tap-highlight-color:transparent}
@supports (color:rgb(from red r g b)){.bk{--shade:rgb(from var(--q-bg) calc(r*.28) calc(g*.28) calc(b*.3)/.5);--glow:oklch(from var(--q-bg) calc(l + (1 - l) * .2) c h/calc((1 - l) * 1.1))}}
.bk *,.bk *::before,.bk *::after{box-sizing:border-box}
:where(.bk) button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:inherit;-webkit-appearance:none;appearance:none}
.bk :focus{outline:none}
.bk :focus-visible{outline:2px solid var(--q-accent);outline-offset:3px;border-radius:12px}
.bk img,.bk video{max-width:none}
.bk-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 28px;position:relative;z-index:4}
.bk-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.bk-line{margin:3px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.bk-empty{margin:auto 0;font-size:15px;color:var(--q-muted)}
.bk-ph{display:grid;place-items:center;width:100%;height:100%;border-radius:14px;background:color-mix(in srgb,var(--q-text) 5%,transparent);color:color-mix(in srgb,var(--q-text) 30%,transparent)}
.bk-ph svg{width:min(34%,48px);height:auto}
.bk-q{display:inline-flex;align-items:center;justify-content:center;min-width:1.9em;height:1.2em;padding:0 .35em;border-radius:.42em;border:1.5px dashed color-mix(in srgb,var(--q-text) 34%,transparent);background:var(--hatch);color:var(--q-muted);font-weight:650;line-height:1;letter-spacing:0;font-variant-numeric:normal}
.bk-mini{display:inline-block;font-size:12px;line-height:17px;padding:0 6px;border-radius:6px;border:1px dashed var(--rule);color:var(--q-muted);font-weight:500;letter-spacing:0;vertical-align:middle}
.bk-src{display:inline-grid;place-items:center;min-width:32px;height:32px;border-radius:9px;color:var(--q-muted);text-decoration:none;font-size:16px;line-height:1}
.bk-src:hover{color:var(--q-text);background:color-mix(in srgb,var(--q-text) 7%,transparent)}
@keyframes bk-rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes bk-fade{from{opacity:0}to{opacity:1}}

/* scale */
.bk-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;max-width:100%}
.bk-chip{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 16px;border-radius:999px;background:var(--q-surface);box-shadow:inset 0 0 0 1px var(--hair);font-size:14px;font-weight:550;white-space:nowrap;transition:background .25s,color .25s,box-shadow .25s}
.bk-chip:hover{box-shadow:inset 0 0 0 1px var(--rule)}
.bk-chip[aria-pressed=true]{background:var(--q-text);color:var(--q-bg);box-shadow:none}
.bk-glyph{flex:0 0 auto;opacity:.5}
.bk-shelf{position:relative;flex:1 1 auto;min-height:360px}
.bk-shelf.is-instant *{transition:none!important}
.bk-blabel{position:absolute;left:0;font-size:13px;font-weight:600;line-height:18px;color:var(--q-muted);white-space:nowrap;letter-spacing:.01em;transition:top .7s var(--ease),left .7s var(--ease)}
.bk-blabel b{font-weight:650;color:var(--q-text);margin-right:8px}
.bk-plank{position:absolute;height:2px;margin-top:-1px;border-radius:2px;background:var(--rule);transition:all .7s var(--ease)}
.bk-tick{position:absolute;width:1px;height:6px;background:var(--rule);transition:left .7s var(--ease),top .7s var(--ease)}
.bk-tl{position:absolute;font-size:13px;line-height:16px;color:var(--q-muted);font-variant-numeric:tabular-nums;white-space:nowrap;transform:translateX(-50%);transition:left .7s var(--ease),top .7s var(--ease)}
.bk-tl.is-start{transform:none}.bk-tl.is-end{transform:translateX(-100%)}
.bk-dot{position:absolute;z-index:1;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--q-text);transition:left .7s var(--ease),top .7s var(--ease),transform .3s var(--ease),background .25s,opacity .35s}
.bk-dot.is-assumed{background:var(--q-bg);box-shadow:inset 0 0 0 1.5px var(--q-text)}
.bk-dot.is-hot{background:var(--q-accent);transform:scale(1.45)}
.bk-dot.is-assumed.is-hot{background:var(--q-bg);box-shadow:inset 0 0 0 1.5px var(--q-accent)}
.bk-stem{position:absolute;z-index:1;width:0;border-left:1px solid var(--rule);transform-origin:50% 100%;transition:left .7s var(--ease),top .7s var(--ease),height .7s var(--ease),transform .7s var(--ease),opacity .35s,border-color .25s}
.bk-stem.is-assumed{border-left-style:dashed}
.bk-stem.is-hot{border-color:var(--q-accent)}
.bk-bay{position:absolute;border-radius:18px;border:1.5px dashed color-mix(in srgb,var(--q-text) 24%,transparent);background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--q-text) 6%,transparent) 0 1px,transparent 1px 7px);transition:all .7s var(--ease)}
.bk-item{position:absolute;left:0;top:0;z-index:2;display:block;border-radius:14px;transition:transform .7s var(--ease),opacity .35s,filter .35s;touch-action:manipulation}
.bk-item:focus-visible{outline-offset:6px}
.bk-in{display:flex;flex-direction:column;align-items:center}
.bk-pic{position:relative;display:block;transition:width .7s var(--ease),height .7s var(--ease),margin-top .7s var(--ease)}
.bk-pic>img,.bk-pic>.bk-ph{position:relative;z-index:1;width:100%;height:100%;object-fit:contain;transition:transform .45s var(--ease),left .7s var(--ease),top .7s var(--ease),width .7s var(--ease),height .7s var(--ease)}
.bk-pic::before,.bk-spic-in::before{content:"";position:absolute;left:-14%;right:-14%;top:-10%;bottom:-18%;border-radius:50%;background:radial-gradient(closest-side,var(--glow),transparent);pointer-events:none}
.bk-pic.is-photo>img{border-radius:12px;object-fit:cover}
.bk-pic.is-photo::after,.bk-pic.is-ph::after,.bk-pic.is-ph::before{display:none}
.bk-pic>img{display:block}
.bk-pic::after{content:"";position:absolute;left:10%;right:10%;bottom:-7px;height:16px;border-radius:50%;background:radial-gradient(closest-side,var(--shade),transparent);transition:transform .45s var(--ease),opacity .45s}
.bk-item.is-hot{z-index:3}
.bk-item.is-hot .bk-pic>img,.bk-item.is-hot .bk-pic>.bk-ph{transform:translateY(-10px) scale(1.04)}
.bk-item.is-hot .bk-pic::after{transform:scale(.8);opacity:.5}
.bk-lab{display:flex;flex-direction:column;align-items:center;margin-top:10px;padding:0 4px;border-radius:6px;background:var(--q-bg);white-space:nowrap;transition:margin-top .7s var(--ease)}
.bk-name{font-size:14px;font-weight:550;line-height:18px}
.bk-val{display:flex;align-items:center;gap:6px;font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:30px;font-variant-numeric:tabular-nums}
.bk-val.is-assumed>span:first-child{text-decoration:underline dashed var(--rule) 1.5px;text-underline-offset:5px}
.bk-item.is-bay .bk-lab{background:none}
.bk-shelf.has-hot .bk-item:not(.is-hot),.bk-shelf.has-group .bk-item.is-out{opacity:.24;filter:saturate(.2)}
.bk-shelf.has-hot :is(.bk-dot,.bk-stem):not(.is-hot),.bk-shelf.has-group :is(.bk-dot,.bk-stem).is-out{opacity:.28}
.bk.is-first .bk-in{animation:bk-rise .8s var(--ease) both;animation-delay:calc(140ms + var(--i,0) * 40ms)}
.bk.is-first :is(.bk-dot,.bk-stem,.bk-tick,.bk-tl,.bk-bay,.bk-blabel,.bk-plank){animation:bk-fade .9s var(--ease) both;animation-delay:calc(80ms + var(--i,0) * 40ms)}
.bk-sheet{position:fixed;z-index:20;top:16px;right:16px;bottom:16px;width:min(392px,36vw);display:flex;flex-direction:column;background:var(--q-surface);color:var(--q-text);border-radius:18px;box-shadow:0 0 0 1px var(--hair),0 30px 70px -24px var(--shade);transform:translateX(calc(100% + 40px));visibility:hidden;transition:transform .5s var(--ease),visibility 0s linear .5s;overflow:hidden}
.bk-sheet.is-open{transform:none;visibility:visible;transition:transform .5s var(--ease)}
.bk-sbody{flex:1;overflow:auto;overscroll-behavior:contain;padding:20px 24px 28px}
.bk-x{position:absolute;z-index:3;top:10px;right:10px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:var(--q-muted)}
.bk-x:hover{color:var(--q-text);background:color-mix(in srgb,var(--q-text) 7%,transparent)}
.bk-x svg{width:16px;height:16px}
.bk-spic{height:clamp(110px,19vh,180px);margin:10px 0 18px;display:flex;justify-content:center;align-items:flex-end}
.bk-spic-in{position:relative;display:block;width:60%;height:100%}
.bk-spic-in>img,.bk-spic-in>.bk-ph{position:relative;z-index:1;display:block;width:100%;height:100%;object-fit:contain}
.bk-spic-in::after{content:"";position:absolute;left:10%;right:10%;bottom:-8px;height:18px;border-radius:50%;background:radial-gradient(closest-side,var(--shade),transparent)}
.bk-spic-in.is-photo>img{border-radius:12px;object-fit:cover}.bk-spic-in.is-photo::after{display:none}
.bk-sname{display:flex;align-items:center;gap:6px;margin:0;font-size:20px;font-weight:650;line-height:1.25;letter-spacing:-.01em}
.bk-sval{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:4px 0 2px;font-size:clamp(34px,3.6vw,50px);font-weight:650;line-height:1.08;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.bk-sval.is-assumed>span:first-child{text-decoration:underline dashed var(--rule) 2px;text-underline-offset:8px}
.bk-sgroup{font-size:13px;color:var(--q-muted);margin-top:2px}
.bk-tags{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 2px}
.bk-tag{font-size:13px;line-height:28px;padding:0 11px;border-radius:999px;background:color-mix(in srgb,var(--q-text) 7%,transparent)}
.bk-facts{margin:16px 0 0;padding:0}
.bk-fact{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:42px;padding:6px 0;border-top:1px solid var(--hair)}
.bk-fact dt{font-size:13px;color:var(--q-muted)}
.bk-fact dd{display:flex;align-items:center;gap:8px;margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em;text-align:right;font-variant-numeric:tabular-nums}
.bk-fact dd.is-assumed>span:first-child{text-decoration:underline dashed var(--rule) 1.5px;text-underline-offset:5px}
.bk-note{margin:16px 0 0;font-size:15px;line-height:1.45}
.bk-route{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--hair)}
.bk-rname{font-size:13px;color:var(--q-muted);margin-bottom:12px}
.bk-track{position:relative;height:42px;margin:0 8px}
.bk-track::before{content:"";position:absolute;left:0;right:0;top:6px;height:2px;margin-top:-1px;background:radial-gradient(circle,color-mix(in srgb,var(--q-text) 45%,transparent) 1px,transparent 1.6px) 0 50%/8px 2px repeat-x;animation:bk-march 1.4s linear infinite}
@keyframes bk-march{to{background-position:8px 50%}}
.bk-stop{position:absolute;top:0;width:13px;height:13px;margin-left:-6.5px;border-radius:50%;background:var(--q-surface);box-shadow:inset 0 0 0 2px var(--q-text)}
.bk-stopl{position:absolute;top:21px;left:50%;transform:translateX(-50%);font-size:13px;line-height:16px;white-space:nowrap}
.bk-stopl.is-first{left:-2px;transform:none}.bk-stopl.is-last{left:auto;right:-2px;transform:none}
.bk-rail{position:absolute;left:0;top:0;width:100%;height:13px;pointer-events:none}
.bk-parcel{position:absolute;left:-8px;top:-1px;width:16px;height:15px;border-radius:4px;background:var(--q-accent);box-shadow:0 5px 10px -5px var(--shade)}
.bk-parcel::after{content:"";position:absolute;left:7px;top:0;bottom:0;width:2px;background:color-mix(in srgb,var(--q-on-accent) 55%,transparent)}
.bk-route.n2 .bk-rail{animation:bk-go2 4.2s var(--ease) infinite}
.bk-route.n3 .bk-rail{animation:bk-go3 5.4s var(--ease) infinite}
.bk-route.n4 .bk-rail{animation:bk-go4 6.6s var(--ease) infinite}
.bk-route .bk-parcel{animation:bk-blink var(--d,5.4s) linear infinite}
.bk-route.n2 .bk-parcel{--d:4.2s}.bk-route.n4 .bk-parcel{--d:6.6s}
@keyframes bk-go2{0%,14%{transform:translateX(0)}74%,100%{transform:translateX(100%)}}
@keyframes bk-go3{0%,10%{transform:translateX(0)}40%,52%{transform:translateX(50%)}82%,100%{transform:translateX(100%)}}
@keyframes bk-go4{0%,8%{transform:translateX(0)}28%,36%{transform:translateX(33.333%)}56%,64%{transform:translateX(66.667%)}86%,100%{transform:translateX(100%)}}
@keyframes bk-blink{0%{opacity:0}5%,93%{opacity:1}100%{opacity:0}}
.bk-scrim{position:fixed;inset:0;z-index:19;background:var(--shade);opacity:0;pointer-events:none;transition:opacity .4s}
@media (min-width:641px){.bk-scale.has-sheet{padding-right:calc(min(392px,36vw) + 40px)}}
@media (max-width:640px){
.bk-head{flex-direction:column;gap:14px}
.bk-chips{justify-content:flex-start;flex-wrap:nowrap;overflow-x:auto;margin:0 calc(-1 * var(--pad));padding:0 var(--pad);scrollbar-width:none;width:calc(100% + 2 * var(--pad));max-width:none}
.bk-chips::-webkit-scrollbar{display:none}
.bk-shelf{flex:0 0 auto;min-height:0}
.bk-name{font-size:13px;line-height:17px}
.bk-val{font-size:19px;line-height:24px}
.bk-sheet{top:auto;left:0;right:0;bottom:0;width:auto;max-height:86vh;border-radius:20px 20px 0 0;transform:translateY(calc(100% + 40px))}
.bk-sheet::before{content:"";position:absolute;top:8px;left:50%;width:36px;height:4px;margin-left:-18px;border-radius:2px;background:var(--hair)}
.bk-scale.has-sheet .bk-scrim{opacity:1;pointer-events:auto}
.bk-sbody{padding:22px 20px 28px}
}

/* choose */
.bk-choose{padding-bottom:0;gap:clamp(14px,2.2vh,22px)}
.bk-panels{flex:1 1 auto;display:flex;min-height:480px;margin:0 calc(-1 * var(--pad))}
.bk-panel,.bk-world{--bg:var(--q-surface);--ink:var(--q-text);--soft:color-mix(in srgb,var(--ink) 66%,var(--bg));--faint:color-mix(in srgb,var(--ink) 12%,transparent)}
.bk-panel{flex:1 1 0;min-width:0;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:16px;padding:clamp(18px,2.3vw,30px) clamp(18px,2.3vw,30px) 0;background:var(--bg);color:var(--ink);text-align:center;overflow:hidden;transition:flex-grow .65s var(--ease),opacity .45s,filter .45s}
.bk-panel+.bk-panel{box-shadow:inset 1px 0 0 var(--faint)}
.bk-panel:focus-visible{outline:2px solid var(--q-accent);outline-offset:-5px;border-radius:0}
@media (hover:hover){.bk-panel:hover{flex-grow:1.4}}
.bk-panel:focus-visible{flex-grow:1.4}
.bk-ptop{align-self:stretch;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:30px}
.bk-badge{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:999px;font-size:13px;font-weight:600;color:var(--ink);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 30%,transparent);white-space:nowrap}
.bk-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.bk-chosen{display:none;align-items:center;gap:6px;height:30px;padding:0 12px 0 10px;border-radius:999px;background:var(--ink);color:var(--bg);font-size:13px;font-weight:650;white-space:nowrap;margin-left:auto}
.bk-chosen svg{width:14px;height:14px}
.is-chosen>.bk-ptop .bk-chosen,.bk-wtop .bk-chosen.is-on{display:inline-flex}
.bk-pmid{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-width:0;max-width:100%;padding-bottom:clamp(0px,2vh,24px)}
.bk-plogo{display:block;width:clamp(72px,9.5vw,132px);height:clamp(72px,9.5vw,132px);margin-bottom:clamp(6px,1.6vh,18px);transition:transform .6s var(--ease)}
.bk-plogo>img,.bk-plogo>.bk-ph{width:100%;height:100%;object-fit:contain}
.bk-panel:hover .bk-plogo{transform:scale(1.04)}
.bk-pname{font-size:clamp(32px,3.9vw,54px);line-height:1.05;letter-spacing:-.025em;font-weight:400;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.bk-pline{font-size:15px;line-height:1.4;color:var(--soft);max-width:30ch}
.bk-win{position:relative;display:block;width:100%;max-width:640px;aspect-ratio:16/10;border-radius:10px 10px 0 0;overflow:hidden;background:color-mix(in srgb,var(--ink) 6%,var(--bg));box-shadow:0 0 0 1px var(--faint),0 -18px 50px -30px color-mix(in srgb,var(--ink) 50%,transparent);margin-top:auto;transition:transform .65s var(--ease)}
.bk-win>img,.bk-win>video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 0}
.bk-win>video{opacity:0;transition:opacity .5s}
.bk-win.is-playing>video{opacity:1}
.bk-strip{position:absolute;left:0;right:0;bottom:0;display:flex;height:clamp(10px,1.6vh,14px);z-index:2}
.bk-strip i{flex:1}
.bk-panels.has-chosen .bk-panel:not(.is-chosen){opacity:.5;filter:saturate(.35)}
.bk.is-first .bk-panel{animation:bk-rise .85s var(--ease) both;animation-delay:calc(100ms + var(--i,0) * 70ms)}
.bk.is-first .bk-pmid{animation:bk-rise .9s var(--ease) both;animation-delay:calc(260ms + var(--i,0) * 70ms)}
.bk-world{position:fixed;inset:0;z-index:30;background:var(--bg);color:var(--ink);overflow:auto;overscroll-behavior:contain;transition:clip-path .62s var(--ease)}
.bk-win-in{box-sizing:border-box;min-height:100%;padding:var(--pad);display:flex;flex-direction:column;gap:clamp(14px,2.6vh,28px);opacity:0;transform:translateY(14px);transition:opacity .4s .16s,transform .7s .16s var(--ease)}
.bk-world.is-in .bk-win-in{opacity:1;transform:none}
.bk-wtop{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px}
.bk-wtop>div{display:flex;align-items:center;gap:8px}
.bk-back{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 16px 0 12px;border-radius:999px;font-size:14px;font-weight:550;color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,transparent);transition:background .2s}
.bk-back:hover{background:color-mix(in srgb,var(--ink) 12%,transparent)}
.bk-back svg{width:16px;height:16px}
.bk-wbody{flex:1;display:grid;grid-template-columns:minmax(0,1.95fr) minmax(270px,1fr);gap:clamp(24px,4vw,60px);align-items:stretch;align-content:center;padding-bottom:clamp(0px,3vh,32px)}
.bk-viewer{display:flex;flex-direction:column;gap:14px;min-width:0}
.bk-main{position:relative;aspect-ratio:16/10;max-height:calc(100vh - 230px);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--ink) 5%,var(--bg));box-shadow:0 0 0 1px var(--faint),0 40px 70px -40px color-mix(in srgb,var(--ink) 60%,transparent)}
.bk-main>img,.bk-main>video,.bk-main>.bk-ph{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;animation:bk-fade .45s var(--ease)}
.bk-main>.bk-logo-big{position:absolute;inset:22%;width:56%;height:56%;object-fit:contain}
.bk-thumbs{display:flex;gap:12px;overflow-x:auto;scrollbar-width:none;padding:3px}
.bk-thumbs::-webkit-scrollbar{display:none}
.bk-thumb{flex:0 0 auto;width:clamp(96px,9.5vw,128px);display:flex;flex-direction:column;gap:7px;font-size:13px;line-height:16px;color:var(--soft);border-radius:8px}
.bk-thumb>span:first-child{position:relative;display:block;aspect-ratio:16/10;border-radius:8px;overflow:hidden;background:color-mix(in srgb,var(--ink) 6%,var(--bg));box-shadow:0 0 0 1px var(--faint);transition:box-shadow .2s}
.bk-thumb>span:first-child>*{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 0}
.bk-thumb>span:first-child>.bk-play{inset:auto;left:50%;top:50%;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:var(--bg);box-shadow:0 4px 12px -4px color-mix(in srgb,var(--ink) 60%,transparent)}
.bk-play svg{width:13px;height:13px;margin-left:2px;fill:currentColor;stroke:none}
.bk-thumb[aria-current=true]{color:var(--ink);font-weight:600}
.bk-thumb[aria-current=true]>span:first-child{box-shadow:0 0 0 2px var(--ink)}
.bk-side{display:flex;flex-direction:column;gap:clamp(18px,3.2vh,32px);min-width:0}
.bk-wname{display:flex;align-items:center;gap:clamp(12px,1.4vw,18px);margin:0;font-size:clamp(40px,4.6vw,66px);font-weight:400;line-height:1;letter-spacing:-.025em}
.bk-wname>span:first-child{flex:0 0 auto;display:block;width:clamp(44px,4.6vw,66px);height:clamp(44px,4.6vw,66px)}
.bk-wname>span:first-child>*{width:100%;height:100%;object-fit:contain}
.bk-wline{margin:-6px 0 0;font-size:16px;color:var(--soft)}
.bk-sec>h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--soft);letter-spacing:.01em}
.bk-sws{display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:10px}
.bk-sw{display:flex;flex-direction:column;gap:3px;font-size:13px;line-height:17px;min-width:0}
.bk-sw i{display:block;height:clamp(52px,9vh,92px);border-radius:10px;margin-bottom:5px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 16%,transparent)}
.bk-sw b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-sw small{font-size:13px;color:var(--soft);font-family:var(--q-mono);text-transform:uppercase}
.bk-type{display:flex;align-items:flex-end;gap:16px}
.bk-type .aa{font-size:clamp(54px,5.6vw,84px);line-height:.9;letter-spacing:-.02em}
.bk-type div{display:flex;flex-direction:column;gap:4px;min-width:0;padding-bottom:4px}
.bk-type b{font-size:13px;font-weight:600}
.bk-type span{font-size:clamp(18px,1.7vw,24px);line-height:1.2}
.bk-act{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-top:auto}
.bk-pick{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:54px;padding:0 30px;border-radius:999px;background:var(--ink);color:var(--bg);font-size:17px;font-weight:650;letter-spacing:-.005em;transition:transform .2s var(--ease),opacity .2s;box-shadow:0 14px 30px -16px color-mix(in srgb,var(--ink) 80%,transparent)}
.bk-pick:hover{transform:translateY(-1px)}
.bk-pick:focus-visible{outline-color:var(--ink);border-radius:999px}
.bk-pick[aria-busy=true]{opacity:.7;cursor:progress}
.bk-pick[aria-busy=true]::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:bk-spin .8s linear infinite}
@keyframes bk-spin{to{transform:rotate(360deg)}}
.bk-done{display:inline-flex;align-items:center;gap:10px;min-height:54px;padding:0 24px 0 20px;border-radius:999px;font-size:17px;font-weight:650;box-shadow:inset 0 0 0 2px var(--ink)}
.bk-done svg{width:18px;height:18px}
.bk-reason{font-size:14px;color:var(--ink);max-width:40ch;padding-left:2px}
.bk-reason::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--q-bad);margin-right:8px;vertical-align:1px}
@media (max-width:760px){
.bk-panels{flex-direction:column;min-height:0;flex:0 0 auto}
.bk-panel{flex:0 0 auto;min-height:max(210px,25vh);flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start;text-align:left;gap:12px 18px;padding:20px var(--pad) 26px}
.bk-panel+.bk-panel{box-shadow:inset 0 1px 0 var(--faint)}
.bk-ptop{flex:1 0 100%;min-height:0;order:0}
.bk-ptop:empty{display:none}
.bk-pmid{flex:1 1 0;align-items:flex-start;gap:6px;order:1}
.bk-plogo{width:64px;height:64px;margin:0 0 4px}
.bk-pname{font-size:34px}
.bk-pline{font-size:14px}
.bk-win{order:2;flex:0 0 42%;max-width:220px;margin:0;border-radius:8px}
.bk-panel:hover{flex-grow:0}
.bk-wbody{display:flex;flex-direction:column;gap:24px}
.bk-side{display:contents}
.bk-wname{order:-2;font-size:44px}
.bk-wline{order:-1;margin-top:-12px}
.bk-sec{order:1}
.bk-act{order:2}
.bk-main{max-height:none}
.bk-act{position:sticky;bottom:0;margin:0 calc(-1 * var(--pad)) calc(-1 * var(--pad));padding:14px var(--pad) calc(18px + env(safe-area-inset-bottom,0px));background:linear-gradient(color-mix(in srgb,var(--bg) 0%,transparent),var(--bg) 36%)}
.bk-pick{width:100%}
}

/* wall */
.bk-wall{columns:4 220px;column-gap:14px}
.bk-tile{position:relative;display:block;width:100%;margin:0 0 14px;break-inside:avoid;border-radius:12px;overflow:hidden;background:var(--q-surface);transition:transform .35s var(--ease),opacity .35s,filter .35s}
.bk-tile>img,.bk-tile>.bk-ph{display:block;width:100%;height:auto;transition:transform .6s var(--ease)}
.bk-tile>.bk-ph{display:grid;aspect-ratio:4/3;border-radius:0}
.bk-tile.is-cut>img{padding:12%}
.bk-tile:hover>img{transform:scale(1.03)}
.bk-tov{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:2px;padding:28px 14px 12px;background:linear-gradient(transparent,color-mix(in srgb,var(--q-bg) 92%,transparent) 55%);color:var(--q-text);text-align:left;opacity:0;transform:translateY(8px);transition:opacity .3s,transform .4s var(--ease)}
.bk-tile:hover .bk-tov,.bk-tile:focus-visible .bk-tov{opacity:1;transform:none}
.bk-tname{font-size:14px;font-weight:600}
.bk-tnote{font-size:13px;color:var(--q-muted);line-height:1.35}
.bk-mark{position:absolute;top:10px;left:10px;z-index:2;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--q-bg);color:var(--q-text);box-shadow:0 4px 14px -6px var(--shade)}
.bk-mark svg{width:15px;height:15px}
.bk-tile.is-keep .bk-mark{background:var(--q-accent);color:var(--q-on-accent)}
.bk-tile.is-drop{opacity:.55;filter:grayscale(.8)}
.bk-tile.is-drop::after{content:"";position:absolute;left:-10%;right:-10%;top:50%;height:2px;background:var(--q-text);transform:rotate(-24deg);opacity:.55}
.bk.is-first .bk-tile{animation:bk-rise .8s var(--ease) both;animation-delay:calc(100ms + var(--i,0) * 40ms)}
.bk-light{position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:var(--pad);background:color-mix(in srgb,var(--q-bg) 95%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);animation:bk-fade .3s var(--ease)}
.bk-light figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:100%;min-height:0}
.bk-light figure>img,.bk-light figure>.bk-ph{max-width:min(100%,1100px);max-height:calc(100vh - 170px);width:auto;height:auto;border-radius:12px;box-shadow:0 30px 70px -30px var(--shade);animation:bk-rise .45s var(--ease)}
.bk-light figure>.bk-ph{width:60vw;aspect-ratio:4/3}
.bk-light figcaption{display:flex;align-items:center;flex-wrap:wrap;justify-content:center;gap:4px 10px;font-size:15px;text-align:center;max-width:70ch}
.bk-light figcaption b{font-weight:650}
.bk-light figcaption span{color:var(--q-muted)}
.bk-nav{position:absolute;top:50%;width:44px;height:44px;margin-top:-22px;border-radius:50%;display:grid;place-items:center;background:var(--q-surface);box-shadow:inset 0 0 0 1px var(--hair)}
.bk-nav svg{width:18px;height:18px}
.bk-nav.prev{left:var(--pad)}.bk-nav.next{right:var(--pad)}
.bk-light .bk-x{top:var(--pad);right:var(--pad);background:var(--q-surface);box-shadow:inset 0 0 0 1px var(--hair)}
@media (max-width:640px){.bk-wall{columns:2 140px;column-gap:10px}.bk-tile{margin-bottom:10px}.bk-tov{opacity:1;transform:none;padding:22px 10px 9px}.bk-tnote{display:none}.bk-nav{top:auto;bottom:var(--pad)}}

@media (prefers-reduced-motion:reduce){
.bk *,.bk *::before,.bk *::after{animation:none!important;transition-duration:0s!important;transition-delay:0s!important}
.bk-rail{transform:translateX(100%)}
}`;

	/* -------------------------------------------------------------- helpers */

	function h(tag, cls, attrs, ...kids) {
		const el = D.createElement(tag);
		if (cls) el.className = cls;
		if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		for (const kid of kids) if (kid !== null && kid !== undefined && kid !== "") el.append(kid);
		return el;
	}
	const NS = "http://www.w3.org/2000/svg";
	function icon(paths, view = "0 0 24 24") {
		const s = D.createElementNS(NS, "svg");
		s.setAttribute("viewBox", view);
		s.setAttribute("aria-hidden", "true");
		s.setAttribute("fill", "none");
		s.setAttribute("stroke", "currentColor");
		s.setAttribute("stroke-width", "2");
		s.setAttribute("stroke-linecap", "round");
		s.setAttribute("stroke-linejoin", "round");
		for (const d of paths) {
			const p = D.createElementNS(NS, "path");
			p.setAttribute("d", d);
			s.append(p);
		}
		return s;
	}
	const ICON = {
		close: () => icon(["M6 6l12 12", "M18 6L6 18"]),
		back: () => icon(["M15 5l-7 7 7 7"]),
		next: () => icon(["M9 5l7 7-7 7"]),
		tick: () => icon(["M5 12.5l4.5 4.5L19 7.5"]),
		strike: () => icon(["M6 12h12"]),
		play: () => icon(["M8 5.5v13l11-6.5z"]),
		picture: () => icon(["M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z", "M4 16l4.5-4.5 4 4 2.5-2.5L20 18"]),
	};
	const txt = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
	function clip(v, max) {
		const chars = Array.from(txt(v));
		return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
	}
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
	const list = (v) => (Array.isArray(v) ? v : []);
	const STATES = ["known", "assumed", "unknown"];
	const stateOf = (v) => (STATES.includes(v) ? v : "known");
	function hex(v) {
		const s = txt(v);
		if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
		if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
		return null;
	}
	const link = (v) => {
		const s = txt(v);
		return /^(https:\/\/|folder:|app:|#)\S+$/i.test(s) ? s : "";
	};
	const family = (v) => {
		const s = txt(v);
		return s && s.length <= 120 && /^[\w\s,'"-]+$/.test(s) ? s : "";
	};
	const fmt = (n, digits) =>
		new Intl.NumberFormat(LANG, digits === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
	const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
	const isVideo = (p) => /\.(mp4|webm)$/i.test(p || "");

	/* Colours of an option's own world (content colours from the data). */
	function rgb(c) {
		return [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
	}
	function lum(c) {
		const [r, g, b] = rgb(c).map((v) => {
			const x = v / 255;
			return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}
	const contrast = (a, b) => {
		const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
		return (hi + 0.05) / (lo + 0.05);
	};
	/** The same hue at another lightness: a readable ink for a background that brought no palette. */
	function relight(c, l) {
		const [r, g, b] = rgb(c).map((v) => v / 255);
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const d = max - min;
		let hue = 0;
		if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		const s = d ? d / (1 - Math.abs(max + min - 1)) : 0;
		const sat = Math.min(s, 0.35);
		const C = (1 - Math.abs(2 * l - 1)) * sat;
		const X = C * (1 - Math.abs(((hue % 6) + 6) % 2 - 1));
		const m = l - C / 2;
		const k = Math.floor(((hue % 6) + 6) % 6);
		const [R, G, B] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][k];
		return `#${[R, G, B].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
	}
	function worldColours(el, o) {
		const bg = o.background || (o.palette.length ? o.palette.slice().sort((a, b) => lum(b.hex) - lum(a.hex))[0].hex : null);
		if (!bg) return;
		let ink = null;
		let best = 0;
		for (const c of o.palette) {
			const k = contrast(c.hex, bg);
			if (k > best) [best, ink] = [k, c.hex];
		}
		if (!ink || best < 4.5) ink = relight(bg, lum(bg) > 0.3 ? 0.14 : 0.95);
		el.style.setProperty("--bg", bg);
		el.style.setProperty("--ink", ink);
	}

	/* Pictures and videos exist only where the page named them when it opened: find the element, never load a path. */
	function mediaFor(path) {
		const p = txt(path);
		const box = D.getElementById("kit-media");
		if (!p || !box) return null;
		for (const el of box.querySelectorAll("[data-kit-src]")) if (el.getAttribute("data-kit-src") === p) return el;
		return null;
	}
	function placeholder() {
		return h("span", "bk-ph", { "aria-hidden": "true" }, ICON.picture());
	}
	function picture(path, alt) {
		const src = mediaFor(path);
		if (src && src.tagName === "IMG") {
			const img = D.createElement("img");
			img.src = src.currentSrc || src.src;
			img.alt = alt || "";
			img.decoding = "async";
			img.draggable = false;
			return img;
		}
		if (src && src.tagName === "VIDEO") return video(path) || placeholder();
		return placeholder();
	}
	function video(path) {
		const src = mediaFor(path);
		if (!src || src.tagName !== "VIDEO") return null;
		const v = src.cloneNode(true);
		v.removeAttribute("data-kit-src");
		v.muted = true;
		v.defaultMuted = true;
		v.loop = true;
		v.playsInline = true;
		v.setAttribute("playsinline", "");
		v.setAttribute("muted", "");
		v.preload = "auto";
		v.setAttribute("aria-hidden", "true");
		return v;
	}
	function aspectOf(path, fallback) {
		const src = mediaFor(path);
		if (src && src.naturalWidth > 0 && src.naturalHeight > 0) return src.naturalWidth / src.naturalHeight;
		return fallback;
	}
	/** The visible part of a cut-out (its box without transparent margins), and whether it is a plain photo. */
	const TRIMS = new Map();
	function trimOf(img) {
		if (!img || img.tagName !== "IMG" || !img.complete || !img.naturalWidth) return null;
		const key = img.currentSrc || img.src;
		if (TRIMS.has(key)) return TRIMS.get(key);
		let out = null;
		try {
			const k = Math.min(1, 180 / Math.max(img.naturalWidth, img.naturalHeight));
			const w = Math.max(1, Math.round(img.naturalWidth * k));
			const hh = Math.max(1, Math.round(img.naturalHeight * k));
			const c = D.createElement("canvas");
			c.width = w;
			c.height = hh;
			const g = c.getContext("2d", { willReadFrequently: true });
			g.drawImage(img, 0, 0, w, hh);
			const a = g.getImageData(0, 0, w, hh).data;
			const alpha = (x, y) => a[(y * w + x) * 4 + 3];
			const photo = [alpha(0, 0), alpha(w - 1, 0), alpha(0, hh - 1), alpha(w - 1, hh - 1)].every((v) => v > 240);
			let [x0, y0, x1, y1] = [w, hh, -1, -1];
			if (!photo)
				for (let y = 0; y < hh; y++)
					for (let x = 0; x < w; x++)
						if (alpha(x, y) > 20) {
							if (x < x0) x0 = x;
							if (x > x1) x1 = x;
							if (y < y0) y0 = y;
							if (y > y1) y1 = y;
						}
			out = { photo, x: 0, y: 0, w: 1, h: 1 };
			if (!photo && x1 >= x0 && y1 >= y0) {
				x0 = Math.max(0, x0 - 1);
				y0 = Math.max(0, y0 - 1);
				x1 = Math.min(w, x1 + 2);
				y1 = Math.min(hh, y1 + 2);
				out = { photo, x: x0 / w, y: y0 / hh, w: (x1 - x0) / w, h: (y1 - y0) / hh };
			}
		} catch {
			out = null;
		}
		TRIMS.set(key, out);
		return out;
	}
	/** Sizes a picture's box to pw×ph showing only the picture's visible part. */
	function fitPicture(box, img, pw, ph) {
		box.style.width = `${Math.round(pw)}px`;
		box.style.height = `${Math.round(ph)}px`;
		if (!img || img.tagName !== "IMG") return;
		const t = trimOf(img);
		box.classList.toggle("is-photo", !!(t && t.photo));
		if (!t || t.photo || (t.w > 0.99 && t.h > 0.99)) {
			Object.assign(img.style, { position: "", left: "", top: "", width: "", height: "", maxWidth: "" });
			return;
		}
		const iw = pw / t.w;
		const ih = ph / t.h;
		Object.assign(img.style, { position: "absolute", left: `${-t.x * iw}px`, top: `${-t.y * ih}px`, width: `${iw}px`, height: `${ih}px`, maxWidth: "none" });
	}
	function visibleAspect(img, fallback) {
		if (!img || img.tagName !== "IMG" || !img.naturalWidth) return fallback;
		const t = trimOf(img);
		const a = (img.naturalWidth * (t ? t.w : 1)) / (img.naturalHeight * (t ? t.h : 1));
		return Number.isFinite(a) && a > 0 ? a : fallback;
	}
	function play(v) {
		if (!v || calm()) return;
		try {
			const p = v.play();
			if (p && p.catch) p.catch(() => {});
		} catch {}
	}
	function qMark() {
		return h("span", "bk-q", { role: "img", "aria-label": WORDS.unknown }, "?");
	}
	function sourceLink(href, name) {
		if (!href) return null;
		return h("a", "bk-src", { href, target: "_blank", rel: "noopener", title: WORDS.source, "aria-label": `${WORDS.source}: ${name}` }, "↗");
	}
	/** Counts the number inside a text up to its figure, keeping the text as written. */
	function countUp(el, text, delay) {
		el.textContent = text;
		if (calm()) return;
		const m = /\d(?:[\d.,   ]*\d)?/.exec(text);
		if (!m) return;
		const parts = new Intl.NumberFormat(LANG).formatToParts(12345.6);
		const group = (parts.find((p) => p.type === "group") || {}).value || ",";
		const dec = (parts.find((p) => p.type === "decimal") || {}).value || ".";
		const raw = m[0];
		const plain = raw.split(group).join("");
		const at = plain.lastIndexOf(dec);
		const digits = at >= 0 ? plain.length - at - 1 : 0;
		const n = Number(plain.replace(dec, "."));
		if (!Number.isFinite(n) || n <= 0) return;
		const f = new Intl.NumberFormat(LANG, { minimumFractionDigits: digits, maximumFractionDigits: digits });
		if (f.format(n) !== raw) return;
		const pre = text.slice(0, m.index);
		const post = text.slice(m.index + raw.length);
		const start = performance.now() + delay;
		el.textContent = pre + f.format(0) + post;
		const step = (now) => {
			if (!el.isConnected) return;
			const k = clamp((now - start) / 950, 0, 1);
			el.textContent = k >= 1 ? text : pre + f.format(n * (1 - (1 - k) ** 3)) + post;
			if (k < 1) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}
	function makeHead(m) {
		const head = h("header", "bk-head");
		const t = h("div", "bk-titles");
		if (m.title) t.append(h("h1", "bk-title", null, m.title));
		if (m.line) t.append(h("p", "bk-line", null, m.line));
		head.append(t);
		return head;
	}

	/* ---------------------------------------------------------------- data */

	function normalize(d) {
		if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("not a board");
		const lang = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(txt(d.lang)) ? txt(d.lang) : D.documentElement.lang || "en";
		const words = { ...BASE_WORDS };
		if (d.words && typeof d.words === "object") for (const k of Object.keys(BASE_WORDS)) if (clip(d.words[k], 40)) words[k] = clip(d.words[k], 40);
		const seen = new Set();
		let recommended = false;
		const items = list(d.items)
			.filter((x) => x && typeof x === "object")
			.slice(0, 60)
			.map((x, i) => {
				let id = clip(x.id, 48) || `item-${i + 1}`;
				while (seen.has(id)) id += "-";
				seen.add(id);
				const value = num(x.value);
				const facts = list(x.facts)
					.slice(0, 5)
					.map((f) => (Array.isArray(f) ? { label: f[0], value: f[1], state: f[2] } : f && typeof f === "object" ? f : null))
					.filter((f) => f && clip(f.label, 18))
					.map((f) => {
						const v = clip(f.value, 22);
						const st = v ? stateOf(f.state) : "unknown";
						return { label: clip(f.label, 18), value: st === "unknown" ? "" : v, state: st };
					});
				const rec = x.recommended === true && !recommended;
				if (rec) recommended = true;
				const t = x.type && typeof x.type === "object" ? x.type : typeof x.type === "string" ? { name: x.type, family: x.type } : null;
				return {
					id,
					name: clip(x.name, 28) || clip(x.id, 28) || "—",
					picture: txt(x.picture),
					value,
					valueText: clip(x.valueText, 20),
					state: value === null ? "unknown" : stateOf(x.state),
					group: txt(x.group),
					axis: txt(x.axis),
					tags: list(x.tags)
						.map((s) => clip(s, 16))
						.filter(Boolean)
						.slice(0, 3),
					facts,
					note: clip(x.note, 90),
					source: link(x.source),
					line: clip(x.line, 60),
					logo: txt(x.logo),
					background: hex(x.background),
					palette: list(x.palette)
						.map((p) => (typeof p === "string" ? { name: "", hex: hex(p) } : p && typeof p === "object" ? { name: clip(p.name, 16), hex: hex(p.hex) } : null))
						.filter((p) => p && p.hex)
						.slice(0, 5),
					video: isVideo(txt(x.video)) ? txt(x.video) : "",
					poster: txt(x.poster),
					gallery: list(x.gallery)
						.map((g) => (typeof g === "string" ? { src: txt(g), caption: "" } : g && typeof g === "object" ? { src: txt(g.src || g.picture || g.video), caption: clip(g.caption, 18) } : null))
						.filter((g) => g && g.src)
						.slice(0, 8),
					type: t && (family(t.family) || clip(t.name, 24)) ? { name: clip(t.name, 24) || clip(t.family, 24), family: family(t.family) || family(t.name), sample: clip(t.sample, 44) } : null,
					recommended: rec,
					by: clip(x.by, 24),
					mark: x.mark === "keep" || x.mark === "drop" ? x.mark : null,
				};
			});
		const vals = items.map((it) => it.value).filter((v) => v !== null);
		const axesIn = Array.isArray(d.axis) ? d.axis : d.axis && typeof d.axis === "object" ? [d.axis] : [{}];
		const axes = axesIn
			.filter((a) => a && typeof a === "object")
			.slice(0, 3)
			.map((a, i) => {
				let min = num(a.min);
				let max = num(a.max);
				if (min === null) min = vals.length && Math.min(...vals) < 0 ? niceFloor(Math.min(...vals)) : 0;
				if (max === null || max <= min) max = vals.length ? niceCeil(Math.max(...vals, min + 1) * 1.08) : min + 100;
				if (max <= min) max = min + 1;
				return { id: txt(a.id) || String(i), label: clip(a.label, 36), unit: clip(a.unit, 10), min, max };
			});
		if (!axes.length) axes.push({ id: "0", label: "", unit: "", min: 0, max: vals.length ? niceCeil(Math.max(...vals) * 1.08) : 100 });
		const groups = list(d.groups)
			.filter((g) => g && typeof g === "object" && txt(g.id))
			.slice(0, 6)
			.map((g) => {
				const route = list(g.route)
					.map((s) => clip(s, 14))
					.filter(Boolean)
					.slice(0, 4);
				return { id: txt(g.id), name: clip(g.name, 24) || clip(g.id, 24), route: route.length >= 2 ? route : [] };
			});
		let mode = ["scale", "choose", "wall"].includes(d.mode) ? d.mode : null;
		if (!mode) mode = items.some((it) => it.palette.length || it.logo) ? "choose" : vals.length ? "scale" : "wall";
		const chosen = txt(d.chosen);
		return { lang, words, mode, title: clip(d.title, 40), line: clip(d.line, 60), axes, groups, items, question: txt(d.question), chosen: items.some((it) => it.id === chosen) ? chosen : null };
	}
	function niceStep(span, count) {
		const raw = span / Math.max(1, count);
		const p = 10 ** Math.floor(Math.log10(raw));
		const f = raw / p;
		return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
	}
	function niceCeil(v) {
		const s = niceStep(Math.abs(v) || 1, 4);
		return Math.ceil(v / s) * s;
	}
	function niceFloor(v) {
		const s = niceStep(Math.abs(v) || 1, 4);
		return Math.floor(v / s) * s;
	}

	/* --------------------------------------------------------- mode: scale */

	/** Places blocks of a board in tiers so none overlaps, each as near its exact point as it can be. */
	function placeBoard(blocks, width, tiers, gap) {
		const order = blocks.slice().sort((a, b) => a.x - b.x);
		const right = new Array(tiers).fill(Number.NEGATIVE_INFINITY);
		const rows = Array.from({ length: tiers }, () => []);
		for (const b of order) {
			let pick = -1;
			let least = Number.POSITIVE_INFINITY;
			for (let t = 0; t < tiers; t++) {
				const shift = Math.max(0, right[t] + gap - (b.x - b.w / 2));
				if (shift <= b.w * 0.28) {
					pick = t;
					break;
				}
				if (shift < least) [least, pick] = [shift, t];
			}
			b.tier = pick;
			rows[pick].push(b);
			right[pick] = Math.max(right[pick] + gap, b.x - b.w / 2) + b.w;
		}
		let disp = 0;
		let over = 0;
		// from the top tier down: a lower block keeps clear of the hairlines that run down past it from above
		for (let t = tiers - 1; t >= 0; t--) {
			const guards = [];
			for (let u = t + 1; u < tiers; u++)
				for (const b of rows[u]) {
					const lo = Math.min(b.p, b.x);
					const hi = Math.max(b.p, b.x);
					guards.push({ x: (lo + hi) / 2, w: hi - lo + 8, weight: 60, guard: true });
				}
			const outside = () => rows[t].some((b) => b.p - b.w / 2 < -0.5 || b.p + b.w / 2 > width + 0.5);
			repel(rows[t].concat(guards).sort((a, b) => a.x - b.x), 0, width, gap);
			// keeping clear of a hairline never pushes a block off the board; the label hides the line instead
			if (guards.length && outside()) repel(rows[t], 0, width, gap);
			for (const b of rows[t]) {
				disp = Math.max(disp, Math.abs(b.p - b.x) / b.w);
				over = Math.max(over, (b.p + b.w / 2 - width) / width, -(b.p - b.w / 2) / width);
			}
		}
		return { disp, over };
	}
	function repel(row, lo, hi, gap) {
		const clusters = [];
		for (const b of row) {
			clusters.push({ items: [b], w: b.w, start: clamp(b.x - b.w / 2, lo, Math.max(lo, hi - b.w)) });
			while (clusters.length > 1) {
				const a = clusters[clusters.length - 2];
				const z = clusters[clusters.length - 1];
				if (a.start + a.w + gap <= z.start + 0.01) break;
				const items = a.items.concat(z.items);
				let off = 0;
				let sum = 0;
				let weight = 0;
				for (const it of items) {
					const k = it.weight || 1;
					sum += k * (it.x - it.w / 2 - off);
					weight += k;
					off += it.w + gap;
				}
				const w = off - gap;
				clusters.splice(clusters.length - 2, 2, { items, w, start: clamp(sum / weight, lo, Math.max(lo, hi - w)) });
			}
		}
		for (const c of clusters) {
			let s = c.start;
			for (const it of c.items) {
				it.p = s + it.w / 2;
				s += it.w + gap;
			}
		}
	}
	function ticksFor(ax) {
		const step = niceStep(ax.max - ax.min, 5);
		const out = [];
		for (let v = Math.ceil(ax.min / step - 1e-9) * step; v <= ax.max + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
		return { step, out };
	}

	function viewScale(root, m, keep, first) {
		const ac = new AbortController();
		const on = { signal: ac.signal };
		const S = { open: null, group: m.groups.some((g) => g.id === keep.group) ? keep.group : null, hover: null, focus: null };
		const head = makeHead(m);
		root.append(head);
		const groups = m.groups.filter((g) => m.items.some((it) => it.group === g.id));
		const chips = [];
		if (groups.length) {
			const row = h("div", "bk-chips", { role: "group", "aria-label": m.title || WORDS.all });
			for (const g of [{ id: null, name: WORDS.all, route: [] }].concat(groups)) {
				const b = h("button", "bk-chip", { type: "button", "aria-pressed": String(S.group === g.id) });
				if (g.route.length) {
					const n = g.route.length;
					const glyph = D.createElementNS(NS, "svg");
					glyph.setAttribute("viewBox", `0 0 ${(n - 1) * 9 + 6} 6`);
					glyph.setAttribute("width", String((n - 1) * 9 + 6));
					glyph.setAttribute("height", "6");
					glyph.setAttribute("aria-hidden", "true");
					glyph.setAttribute("class", "bk-glyph");
					const line = D.createElementNS(NS, "path");
					line.setAttribute("d", `M3 3h${(n - 1) * 9}`);
					line.setAttribute("stroke", "currentColor");
					line.setAttribute("stroke-width", "1.2");
					glyph.append(line);
					for (let k = 0; k < n; k++) {
						const c = D.createElementNS(NS, "circle");
						c.setAttribute("cx", String(3 + k * 9));
						c.setAttribute("cy", "3");
						c.setAttribute("r", "2.4");
						c.setAttribute("fill", "currentColor");
						glyph.append(c);
					}
					b.append(glyph);
				}
				b.append(g.name);
				b.addEventListener("click", () => setGroup(S.group === g.id ? null : g.id), on);
				row.append(b);
				chips.push({ g, b });
			}
			head.append(row);
		}
		const shelf = h("section", "bk-shelf is-instant", { "aria-label": m.title || "" });
		root.append(shelf);

		const boards = m.axes.map((ax, i) => ({ ax, i, items: [], el: {} }));
		const boardOf = (it) => {
			const k = m.axes.findIndex((a) => a.id === it.axis);
			return boards[k >= 0 ? k : 0];
		};
		const items = m.items.map((d) => ({ d, bay: d.state === "unknown" || d.value === null }));
		for (const it of items) if (!it.bay) boardOf(it.d).items.push(it);
		const bay = items.filter((it) => it.bay);
		const shown = boards.filter((b, i) => b.items.length || (i === 0 && !bay.length));
		const ordered = shown.flatMap((b) => b.items.slice().sort((a, z) => a.d.value - z.d.value)).concat(bay);

		// boards: label, plank, ticks
		shown.forEach((b, bi) => {
			const unit = b.ax.unit;
			const label = h("div", "bk-blabel", { "aria-hidden": "true" });
			if (unit) label.append(h("b", null, null, unit));
			if (b.ax.label) label.append(b.ax.label);
			label.style.setProperty("--i", bi);
			const plank = h("div", "bk-plank");
			plank.style.setProperty("--i", bi);
			const { step, out } = ticksFor(b.ax);
			const digits = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
			b.ticks = out.map((v, k) => {
				const mark = h("div", "bk-tick");
				const tl = h("div", "bk-tl", { "aria-hidden": "true" }, fmt(v, digits));
				mark.style.setProperty("--i", k);
				tl.style.setProperty("--i", k);
				shelf.append(mark, tl);
				return { v, mark, tl };
			});
			shelf.append(label, plank);
			b.el = { label, plank };
		});
		let bayEl = null;
		let bayLabel = null;
		let G0 = null;
		if (bay.length) {
			bayEl = h("div", "bk-bay", { "aria-hidden": "true" });
			bayLabel = h("div", "bk-blabel", { "aria-hidden": "true" }, WORDS.notKnown);
			shelf.append(bayEl, bayLabel);
		}
		// items
		ordered.forEach((it, i) => {
			const d = it.d;
			const valText = it.bay ? "" : d.valueText || `${fmt(d.value)}${boardOf(d).ax.unit ? ` ${boardOf(d).ax.unit}` : ""}`;
			it.valText = valText;
			const btn = h("button", `bk-item${it.bay ? " is-bay" : ""}`, {
				type: "button",
				"data-id": d.id,
				"aria-label": `${d.name}, ${it.bay ? WORDS.unknown : valText}${d.state === "assumed" ? `, ${WORDS.assumed}` : ""}`,
				"aria-haspopup": "dialog",
			});
			btn.style.setProperty("--i", i);
			const inner = h("span", "bk-in");
			const img = picture(d.picture, "");
			const pic = h("span", `bk-pic${img.tagName === "IMG" ? "" : " is-ph"}`);
			if (img.tagName === "IMG" && !img.complete) img.addEventListener("load", () => schedule(), { once: true, signal: ac.signal });
			pic.append(img);
			const lab = h("span", "bk-lab");
			const name = h("span", "bk-name", null, d.name);
			const val = h("span", `bk-val${d.state === "assumed" ? " is-assumed" : ""}`);
			if (it.bay) val.append(qMark());
			else {
				const num = h("span", null, null, valText);
				val.append(num);
				it.num = num;
				if (d.state === "assumed") val.append(h("span", "bk-mini", null, WORDS.assumed));
			}
			lab.append(name, val);
			inner.append(pic, lab);
			btn.append(inner);
			Object.assign(it, { btn, pic, img, lab, name, val, i });
			if (!it.bay) {
				it.dot = h("span", `bk-dot${d.state === "assumed" ? " is-assumed" : ""}`);
				it.stem = h("span", `bk-stem${d.state === "assumed" ? " is-assumed" : ""}`);
				it.dot.style.setProperty("--i", i);
				it.stem.style.setProperty("--i", i);
				shelf.append(it.stem, it.dot);
			}
			btn.addEventListener("click", () => (S.open === d.id ? close() : open(d.id)), on);
			btn.addEventListener(
				"pointerenter",
				(e) => {
					if (e.pointerType === "mouse") {
						S.hover = d.id;
						paint();
					}
				},
				on,
			);
			btn.addEventListener(
				"pointerleave",
				() => {
					if (S.hover === d.id) {
						S.hover = null;
						paint();
					}
				},
				on,
			);
			btn.addEventListener(
				"focus",
				() => {
					S.focus = btn.matches(":focus-visible") ? d.id : null;
					paint();
				},
				on,
			);
			btn.addEventListener(
				"blur",
				() => {
					S.focus = null;
					paint();
				},
				on,
			);
			btn.addEventListener("keydown", (e) => step(e, i), on);
			shelf.append(btn);
		});

		// the sheet
		const scrim = h("div", "bk-scrim", { "aria-hidden": "true" });
		const sheet = h("aside", "bk-sheet", { role: "dialog", "aria-modal": "false", "aria-hidden": "true", "aria-label": m.title || "" });
		const x = h("button", "bk-x", { type: "button", "aria-label": WORDS.close, title: WORDS.close }, ICON.close());
		const body = h("div", "bk-sbody");
		sheet.append(x, body);
		root.append(scrim, sheet);
		x.addEventListener("click", () => close(true), on);
		scrim.addEventListener("click", () => close(true), on);

		function fill(it) {
			const d = it.d;
			body.replaceChildren();
			const pic = h("div", "bk-spic");
			const inner = h("span", "bk-spic-in");
			const img = picture(d.picture, d.name);
			inner.append(img);
			pic.append(inner);
			const fit = () => {
				const pw0 = pic.clientWidth;
				const ph0 = pic.clientHeight;
				if (!pw0 || !ph0 || !inner.isConnected) return;
				const a = visibleAspect(img, aspectOf(d.picture, 1.3));
				const ph = Math.min(ph0, pw0 / a);
				fitPicture(inner, img, ph * a, ph);
			};
			requestAnimationFrame(fit);
			if (img.tagName === "IMG" && !img.complete) img.addEventListener("load", fit, { once: true });
			const title = h("h2", "bk-sname", null, d.name);
			const src = sourceLink(d.source, d.name);
			if (src) title.append(src);
			const val = h("div", `bk-sval${d.state === "assumed" ? " is-assumed" : ""}`);
			if (it.bay) val.append(qMark());
			else {
				val.append(h("span", null, null, it.valText));
				if (d.state === "assumed") val.append(h("span", "bk-mini", null, WORDS.assumed));
			}
			body.append(pic, title, val);
			const group = m.groups.find((g) => g.id === d.group);
			if (d.tags.length) body.append(h("div", "bk-tags", null, ...d.tags.map((t) => h("span", "bk-tag", null, t))));
			if (d.facts.length) {
				const dl = h("dl", "bk-facts");
				for (const f of d.facts) {
					const dd = h("dd", f.state === "assumed" ? "is-assumed" : null);
					if (f.state === "unknown") dd.append(qMark());
					else {
						dd.append(h("span", null, null, f.value));
						if (f.state === "assumed") dd.append(h("span", "bk-mini", null, WORDS.assumed));
					}
					dl.append(h("div", "bk-fact", null, h("dt", null, null, f.label), dd));
				}
				body.append(dl);
			}
			if (group && group.route.length) {
				const n = group.route.length;
				const route = h("div", `bk-route n${n}`);
				const track = h("div", "bk-track", { role: "img", "aria-label": group.route.join(" → ") });
				group.route.forEach((s, k) => {
					const stop = h("span", "bk-stop");
					stop.style.left = `${(k / (n - 1)) * 100}%`;
					stop.append(h("span", `bk-stopl${k === 0 ? " is-first" : k === n - 1 ? " is-last" : ""}`, null, s));
					track.append(stop);
				});
				track.append(h("span", "bk-rail", null, h("span", "bk-parcel")));
				route.append(h("div", "bk-rname", null, group.name), track);
				body.append(route);
			}
			if (d.note) body.append(h("p", "bk-note", null, d.note));
			body.scrollTop = 0;
		}
		function open(id) {
			const it = items.find((t) => t.d.id === id);
			if (!it) return;
			S.open = id;
			fill(it);
			sheet.setAttribute("aria-label", it.d.name);
			sheet.setAttribute("aria-hidden", "false");
			sheet.classList.add("is-open");
			root.classList.add("has-sheet");
			paint();
		}
		function close(refocus) {
			if (!S.open) return;
			const id = S.open;
			S.open = null;
			sheet.classList.remove("is-open");
			sheet.setAttribute("aria-hidden", "true");
			root.classList.remove("has-sheet");
			paint();
			if (refocus) {
				const it = items.find((t) => t.d.id === id);
				if (it) it.btn.focus({ preventScroll: true });
			}
		}
		function setGroup(id) {
			S.group = id;
			for (const c of chips) c.b.setAttribute("aria-pressed", String(c.g.id === id));
			if (S.open && id && (items.find((t) => t.d.id === S.open) || {}).d?.group !== id) close();
			paint();
		}
		function step(e, i) {
			const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -1e9, End: 1e9 }[e.key];
			if (k === undefined) return;
			e.preventDefault();
			const to = ordered[clamp(i + k, 0, ordered.length - 1)];
			to.btn.focus({ preventScroll: true });
			S.focus = to.d.id;
			if (S.open) open(to.d.id);
			paint();
		}
		function paint() {
			const hot = S.hover || S.focus || S.open;
			shelf.classList.toggle("has-hot", !!hot);
			shelf.classList.toggle("has-group", !!S.group);
			for (const it of items) {
				const on = it.d.id === hot;
				const out = !!S.group && it.d.group !== S.group;
				it.btn.classList.toggle("is-hot", on);
				it.btn.classList.toggle("is-out", out);
				it.btn.setAttribute("aria-expanded", String(S.open === it.d.id));
				for (const el of [it.dot, it.stem]) {
					if (!el) continue;
					el.classList.toggle("is-hot", on || S.open === it.d.id);
					el.classList.toggle("is-out", out);
				}
			}
		}
		D.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Escape" && S.open) close(true);
			},
			on,
		);
		D.addEventListener(
			"pointerdown",
			(e) => {
				if (!S.open) return;
				const t = e.target;
				if (sheet.contains(t) || (t.closest && t.closest(".bk-item,.bk-chip,.bk-x,[data-harness-bar]"))) return;
				close();
			},
			on,
		);

		/* layout */
		const DESK = { labelRow: 30, ruler: 40, stem: 15, tierGap: 22, gapB: 30, bayGap: 26, bayPad: 26, minPic: 70, maxPic: 250, labGap: 10, gap: 22 };
		const PHONE = { labelRow: 28, ruler: 36, stem: 13, tierGap: 16, gapB: 24, bayGap: 0, bayPad: 14, minPic: 56, maxPic: 96, labGap: 8, gap: 12 };
		let raf = 0;
		function schedule() {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(layout);
		}
		function layout() {
			const W = shelf.clientWidth;
			if (!W) return;
			const phone = W < 560;
			const G = phone ? PHONE : DESK;
			for (const it of ordered) {
				it.aspect = clamp(visibleAspect(it.img, aspectOf(it.d.picture, 1.3)), 0.4, 3.2);
				// measured once with the final text (a value may be counting up later)
				if (!it.lw) it.lw = Math.ceil(Math.max(it.name.getBoundingClientRect().width, it.val.getBoundingClientRect().width));
				it.lh = it.lab.offsetHeight;
			}
			const labH = Math.max(...ordered.map((it) => it.lh), 40);
			// a picture fits a box picH tall and capW wide; very wide things get shorter, not wider than their share
			let capW = 9999;
			const picBox = (it, picH) => {
				const ph = Math.min(picH, capW / it.aspect);
				return { pw: ph * it.aspect, ph };
			};
			const blockW = (it, picH) => Math.ceil(Math.max(picBox(it, picH).pw, it.lw)) + 4;
			const most = Math.max(1, ...shown.map((b) => b.items.length));
			const bayInner = (picH) => (bay.length ? Math.max(...bay.map((it) => blockW(it, picH))) : 0);
			let best = null;
			if (!phone) {
				const H = Math.max(shelf.clientHeight, 360);
				const n = Math.max(1, shown.length);
				const boardH = (H - (n - 1) * G.gapB) / n;
				const area = boardH - G.labelRow - G.ruler;
				for (const share of [0.7, 1.2, 1.9])
				for (const T of [1, 2, 3])
					for (const s of [1, 0.88, 0.76, 0.64]) {
						capW = clamp((W - (bay.length ? 260 : 0)) / (most + share), 150, 460);
						const picH = Math.floor(Math.min(G.maxPic, (area - G.stem - (T - 1) * G.tierGap) / T - labH - G.labGap) * s);
						if (picH < G.minPic) continue;
						const bw = bay.length ? bayInner(picH) + 2 * G.bayPad : 0;
						const width = shown.length ? W - (bw ? bw + G.bayGap : 0) : 0;
						if (shown.length && width < 160) continue;
						// bigger pictures are better; fewer tiers are better; so is standing close to one's own point
						const fill = ordered.reduce((sum, it) => sum + picBox(it, picH).ph, 0) / ordered.length / Math.max(1, Math.min(G.maxPic, area - G.stem - labH - G.labGap));
						let cost = (T - 1) * 0.6 + (1 - fill) * 1.4;
						for (const b of shown) {
							b.blocks = b.items.map((it) => ({ it, w: blockW(it, picH), x: xOf(b, it, width) }));
							const r = placeBoard(b.blocks, width, T, G.gap);
							cost += Math.max(0, r.disp - 0.22) * 2.4 + Math.max(0, r.over) * 14;
							b.plan = b.blocks.map((k) => ({ ...k }));
						}
						if (!best || cost < best.cost - 1e-9) best = { cost, T, picH, bw, width, boardH, capW, plans: shown.map((b) => b.plan) };
					}
				if (!best) {
					const picH = G.minPic;
					const bw = bay.length ? bayInner(picH) + 2 * G.bayPad : 0;
					const width = Math.max(160, W - (bw ? bw + G.bayGap : 0));
					for (const b of shown) {
						b.blocks = b.items.map((it) => ({ it, w: blockW(it, picH), x: xOf(b, it, width) }));
						placeBoard(b.blocks, width, 3, G.gap);
						b.plan = b.blocks;
					}
					best = { T: 3, picH, bw, width, boardH, plans: shown.map((b) => b.plan) };
				}
				capW = best.capW || capW;
				const bh = best.picH + G.labGap + labH;
				shown.forEach((b, bi) => {
					const top = bi * (best.boardH + G.gapB);
					drawBoard(b, best.plans[bi], top, best.boardH, best.width, best.picH, bh, G, picBox);
				});
				if (bay.length) {
					const x0 = shown.length ? best.width + G.bayGap : 0;
					const w = shown.length ? best.bw : W;
					const y0 = G.labelRow;
					const y1 = shown.length ? (shown.length - 1) * (best.boardH + G.gapB) + best.boardH - G.ruler : best.boardH - G.ruler;
					drawBay(x0, y0, w, y1 - y0, best.picH, bh, G, 0, picBox);
				}
				shelf.style.height = "";
			} else {
				// phone: boards stacked, each as tall as its tiers need; the bay is a row under them
				let y = 0;
				capW = clamp(W / 2.5, 110, 200);
				// one picture size for every board: the smallest any board needs to stand without running off the side
				let picH = Math.floor(G.maxPic * 0.62);
				for (const s of [1, 0.86, 0.74, 0.62]) {
					const ph = Math.floor(G.maxPic * s);
					const ok = shown.every((b) =>
						[1, 2, 3, 4].some((T) => {
							const blocks = b.items.map((it) => ({ it, w: blockW(it, ph), x: xOf(b, it, W) }));
							return placeBoard(blocks, W, T, G.gap).over <= 0.001;
						}),
					);
					if (ok) {
						picH = ph;
						break;
					}
				}
				const bh = picH + G.labGap + labH;
				for (const b of shown) {
					let pick = null;
					for (const T of [1, 2, 3, 4]) {
						b.blocks = b.items.map((it) => ({ it, w: blockW(it, picH), x: xOf(b, it, W) }));
						const r = placeBoard(b.blocks, W, T, G.gap);
						const cost = (T - 1) * 0.9 + Math.max(0, r.disp - 0.18) * 1.4 + Math.max(0, r.over) * 14;
						if (!pick || cost < pick.cost) pick = { cost, T, plan: b.blocks.map((k) => ({ ...k })) };
					}
					const used = Math.max(1, ...pick.plan.map((k) => k.tier + 1));
					const moved = used === 1 && pick.plan.some((k) => Math.abs(k.p - k.x) > 30);
					const boardH = G.labelRow + used * bh + (used - 1) * G.tierGap + G.stem + G.ruler + (moved ? 26 : 0);
					drawBoard(b, pick.plan, y, boardH, W, picH, bh, G, picBox, moved ? 26 : 0);
					y += boardH + G.gapB;
				}
				if (bay.length) {
					const per = Math.max(1, Math.floor((W - 2 * G.bayPad + G.gap) / (bayInner(picH) + G.gap)));
					const rowsN = Math.ceil(bay.length / per);
					const hgt = G.bayPad * 2 + rowsN * bh + (rowsN - 1) * G.tierGap;
					drawBay(0, y + G.labelRow, W, hgt, picH, bh, G, per, picBox);
					y += G.labelRow + hgt + G.ruler;
				}
				shelf.style.height = `${Math.ceil(y)}px`;
			}
			if (shelf.classList.contains("is-instant")) requestAnimationFrame(() => requestAnimationFrame(() => shelf.classList.remove("is-instant")));
		}
		function xOf(b, it, width) {
			const ax = b.ax;
			return clamp((it.d.value - ax.min) / (ax.max - ax.min), 0, 1) * width;
		}
		function sizeItem(it, w, picH, picBox) {
			const { pw, ph } = picBox(it, picH);
			it.btn.style.width = `${w}px`;
			it.pic.style.marginTop = `${Math.round(picH - ph)}px`;
			it.lab.style.marginTop = `${G0.labGap}px`;
			fitPicture(it.pic, it.img, pw, ph);
		}
		function drawBoard(b, plan, top, boardH, width, picH, bh, G, picBox, room) {
			G0 = G;
			const tiers = Math.max(1, ...plan.map((k) => k.tier + 1));
			const head = room !== undefined ? room : boardH - G.labelRow - G.ruler - G.stem - bh;
			const plankY = top + boardH - G.ruler;
			b.el.label.style.top = `${top}px`;
			b.el.label.style.left = "0px";
			Object.assign(b.el.plank.style, { left: "0px", top: `${plankY}px`, width: `${width}px` });
			for (const t of b.ticks) {
				const x = clamp((t.v - b.ax.min) / (b.ax.max - b.ax.min), 0, 1) * width;
				Object.assign(t.mark.style, { left: `${x}px`, top: `${plankY + 1}px` });
				Object.assign(t.tl.style, { left: `${x}px`, top: `${plankY + 12}px` });
				t.tl.classList.toggle("is-start", x < 18);
				t.tl.classList.toggle("is-end", x > width - 18);
			}
			for (const k of plan) {
				const it = k.it;
				// a block pushed aside to make room rises a little, so its hairline falls steeply to its point
				const lift = tiers === 1 ? Math.min(Math.max(0, Math.abs(k.p - k.x) - 24) * 0.5, Math.max(0, head - 4), 56) : 0;
				const bottom = plankY - G.stem - lift - k.tier * (bh + G.tierGap);
				sizeItem(it, k.w, picH, picBox);
				it.btn.style.transform = `translate(${Math.round(k.p - k.w / 2)}px, ${Math.round(bottom - bh)}px)`;
				Object.assign(it.dot.style, { left: `${k.x}px`, top: `${plankY}px` });
				const ax = k.x;
				const ay = plankY - 2;
				const bx = k.p;
				const by = bottom + 2;
				const len = Math.max(0, Math.hypot(bx - ax, ay - by));
				const ang = Math.atan2(bx - ax, ay - by);
				Object.assign(it.stem.style, { left: `${ax}px`, top: `${ay - len}px`, height: `${len}px`, transform: `rotate(${ang}rad)` });
			}
		}
		function drawBay(x0, y0, w, hgt, picH, bh, G, perRow, picBox) {
			G0 = G;
			Object.assign(bayEl.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${hgt}px` });
			bayLabel.style.left = `${x0}px`;
			bayLabel.style.top = `${y0 - G.labelRow}px`;
			const per = perRow || Math.max(1, Math.floor((hgt - 2 * G.bayPad + G.tierGap) / (bh + G.tierGap)));
			const cols = perRow ? Math.min(perRow, bay.length) : Math.ceil(bay.length / per);
			const rows = perRow ? Math.ceil(bay.length / perRow) : Math.min(per, bay.length);
			const cw = (w - 2 * G.bayPad) / cols;
			const usedH = rows * bh + (rows - 1) * G.tierGap;
			bay.forEach((it, k) => {
				const c = perRow ? k % cols : Math.floor(k / per);
				const r = perRow ? Math.floor(k / cols) : k % per;
				const bw = Math.min(cw, Math.ceil(Math.max(picBox(it, picH).pw, it.lw)) + 4);
				sizeItem(it, bw, picH, picBox);
				const cx = x0 + G.bayPad + cw * (c + 0.5);
				const cy = y0 + (hgt - usedH) / 2 + r * (bh + G.tierGap);
				it.btn.style.transform = `translate(${Math.round(cx - bw / 2)}px, ${Math.round(cy)}px)`;
			});
		}
		const ro = new ResizeObserver(() => {
			const phone = shelf.clientWidth < 560;
			if (phone !== ro.phone) for (const it of ordered) it.lw = 0;
			ro.phone = phone;
			schedule();
		});
		ro.observe(shelf);
		layout();
		ro.phone = shelf.clientWidth < 560;
		if (first) for (const it of ordered) if (it.num) countUp(it.num, it.valText, 260 + it.i * 40);
		paint();
		if (keep.open && items.some((t) => t.d.id === keep.open)) {
			sheet.style.transition = "none";
			open(keep.open);
			requestAnimationFrame(() => requestAnimationFrame(() => (sheet.style.transition = "")));
		}
		return {
			keep: () => ({ open: S.open, group: S.group }),
			destroy() {
				ac.abort();
				ro.disconnect();
				cancelAnimationFrame(raf);
			},
		};
	}

	/* -------------------------------------------------------- mode: choose */

	function viewChoose(root, m, keep, first) {
		const ac = new AbortController();
		const on = { signal: ac.signal };
		const opts = m.items.slice(0, 4);
		const S = { chosen: keep.chosen || app.chosen || m.chosen || null, q: keep.q || null, saving: null, reason: {}, world: null };
		root.append(makeHead(m));
		const row = h("div", "bk-panels");
		root.append(row);
		const rec = (o) => (o.by ? `${WORDS.recommended} · ${o.by}` : WORDS.recommended);
		const panels = opts.map((o, i) => {
			const p = h("button", "bk-panel", { type: "button", "data-id": o.id, "aria-haspopup": "dialog", "aria-label": `${o.name}${o.recommended ? `, ${rec(o)}` : ""}${o.line ? `. ${o.line}` : ""}` });
			p.style.setProperty("--i", i);
			worldColours(p, o);
			const top = h("span", "bk-ptop");
			if (o.recommended) top.append(h("span", "bk-badge", null, rec(o)));
			top.append(h("span", "bk-chosen", null, ICON.tick(), WORDS.chosen));
			const mid = h("span", "bk-pmid");
			if (o.logo) mid.append(h("span", "bk-plogo", null, picture(o.logo, "")));
			const name = h("span", "bk-pname", null, o.name);
			if (o.type && o.type.family) name.style.fontFamily = o.type.family;
			mid.append(name);
			if (o.line) mid.append(h("span", "bk-pline", null, o.line));
			p.append(top, mid);
			let v = null;
			let win = null;
			if (o.poster || o.video) {
				win = h("span", "bk-win", { "aria-hidden": "true" });
				if (o.poster) win.append(picture(o.poster, ""));
				v = o.video ? video(o.video) : null;
				if (v) {
					if (!o.poster) win.classList.add("is-playing");
					v.addEventListener("playing", () => win.classList.add("is-playing"), on);
					win.append(v);
				}
				p.append(win);
			}
			if (o.palette.length) p.append(h("span", "bk-strip", { "aria-hidden": "true" }, ...o.palette.map((c) => Object.assign(h("i"), { style: `background:${c.hex}` }))));
			const start = () => play(v);
			const stop = () => {
				if (!v) return;
				v.pause();
				if (o.poster) win.classList.remove("is-playing");
			};
			p.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && start(), on);
			p.addEventListener("pointerleave", stop, on);
			p.addEventListener("focus", () => p.matches(":focus-visible") && start(), on);
			p.addEventListener("blur", stop, on);
			p.addEventListener("click", () => openWorld(o.id), on);
			row.append(p);
			return { o, p };
		});
		let world = null;
		function canAnswer(o) {
			return !!(S.q && S.q.options.some((x) => String(x.value) === o.id));
		}
		function mark() {
			row.classList.toggle("has-chosen", !!S.chosen);
			for (const { o, p } of panels) p.classList.toggle("is-chosen", S.chosen === o.id);
			if (world) world.update();
		}
		async function ask() {
			if (!window.qorpera || typeof window.qorpera.questions !== "function") return;
			try {
				const qs = list(await window.qorpera.questions()).filter((q) => q && q.id && Array.isArray(q.options));
				const ids = opts.map((o) => o.id);
				S.q =
					(m.question ? qs.find((q) => q.id === m.question) : null) ||
					qs.find((q) => q.options.length && q.options.every((x) => ids.includes(String(x.value)))) ||
					qs.find((q) => q.options.some((x) => ids.includes(String(x.value)))) ||
					null;
			} catch {
				S.q = null;
			}
			if (world) world.update();
		}
		async function choose(o) {
			if (!S.q || S.saving) return;
			S.saving = o.id;
			S.reason[o.id] = "";
			world && world.update();
			try {
				await window.qorpera.answer(S.q.id, o.id);
				S.chosen = o.id;
				app.chosen = o.id;
				S.q = null;
			} catch (e) {
				S.reason[o.id] = clip((e && e.message) || String(e || ""), 140) || "—";
			}
			S.saving = null;
			mark();
		}
		function openWorld(id, instant) {
			const P = panels.find((x) => x.o.id === id);
			if (!P) return;
			if (world) world.remove(true);
			S.world = id;
			const o = P.o;
			const w = h("div", "bk-world", { role: "dialog", "aria-modal": "true", "aria-label": o.name });
			worldColours(w, o);
			const inner = h("div", "bk-win-in");
			const back = h("button", "bk-back", { type: "button" }, ICON.back(), WORDS.back);
			const topR = h("div");
			if (o.recommended) topR.append(h("span", "bk-badge", null, rec(o)));
			const chosenMark = h("span", "bk-chosen", null, ICON.tick(), WORDS.chosen);
			topR.append(chosenMark);
			inner.append(h("div", "bk-wtop", null, back, topR));
			const bodyEl = h("div", "bk-wbody");
			// viewer: the video first, then the gallery
			const viewer = h("div", "bk-viewer");
			const main = h("div", "bk-main");
			const shots = [];
			if (o.video && mediaFor(o.video)) shots.push({ src: o.video, caption: WORDS.film });
			for (const g of o.gallery) if (mediaFor(g.src)) shots.push(g);
			if (!shots.length && o.poster) shots.push({ src: o.poster, caption: "" });
			const thumbs = h("div", "bk-thumbs", { role: "group", "aria-label": o.name });
			let shown = -1;
			const show = (k) => {
				if (k === shown || !shots[k]) return;
				shown = k;
				const s = shots[k];
				const el = isVideo(s.src) ? video(s.src) : picture(s.src, s.caption || o.name);
				if (el.tagName === "VIDEO") {
					if (calm()) el.controls = true;
					if (k === 0 && o.poster && mediaFor(o.poster)) el.poster = (mediaFor(o.poster) || {}).src || "";
					el.addEventListener("loadeddata", () => play(el), { once: true });
					play(el);
				}
				main.replaceChildren(el);
				thumbs.querySelectorAll(".bk-thumb").forEach((t, j) => t.setAttribute("aria-current", String(j === k)));
			};
			if (shots.length > 1)
				shots.forEach((s, k) => {
					const face = h("span");
					if (isVideo(s.src)) face.append(o.poster ? picture(o.poster, "") : h("span"), h("span", "bk-play", null, ICON.play()));
					else face.append(picture(s.src, ""));
					const t = h("button", "bk-thumb", { type: "button", "aria-label": s.caption || `${k + 1}` }, face, s.caption ? h("span", null, null, s.caption) : null);
					t.addEventListener("click", () => show(k), on);
					thumbs.append(t);
				});
			if (shots.length) {
				viewer.append(main);
				if (shots.length > 1) viewer.append(thumbs);
				show(0);
			} else if (o.logo) {
				const big = picture(o.logo, o.name);
				big.classList.add("bk-logo-big");
				main.append(big);
				viewer.append(main);
			}
			const side = h("div", "bk-side");
			const nm = h("h2", "bk-wname");
			if (o.logo) nm.append(h("span", null, null, picture(o.logo, "")));
			const nmText = h("span", null, null, o.name);
			if (o.type && o.type.family) nmText.style.fontFamily = o.type.family;
			nm.append(nmText);
			const src = sourceLink(o.source, o.name);
			if (src) {
				src.style.color = "var(--soft)";
				nm.append(src);
			}
			side.append(nm);
			if (o.line) side.append(h("p", "bk-wline", null, o.line));
			if (o.palette.length) {
				const sws = h("div", "bk-sws");
				for (const c of o.palette) sws.append(h("div", "bk-sw", null, Object.assign(h("i"), { style: `background:${c.hex}` }), c.name ? h("b", null, null, c.name) : null, h("small", null, null, c.hex)));
				side.append(h("section", "bk-sec", null, h("h3", null, null, WORDS.colours), sws));
			}
			if (o.type) {
				const ty = h("div", "bk-type");
				const aa = h("span", "aa", { "aria-hidden": "true" }, "Aa");
				const sample = o.sample || o.type.sample;
				const words = h("div", null, null, h("b", null, null, o.type.name), sample ? h("span", null, null, sample) : null);
				if (o.type.family) {
					aa.style.fontFamily = o.type.family;
					words.lastChild.style.fontFamily = o.type.family;
				}
				ty.append(aa, words);
				side.append(h("section", "bk-sec", null, h("h3", null, null, WORDS.type), ty));
			}
			const act = h("div", "bk-act", { "aria-live": "polite" });
			side.append(act);
			bodyEl.append(viewer.childNodes.length ? viewer : h("div"), side);
			inner.append(bodyEl);
			w.append(inner);
			root.append(w);
			function update() {
				chosenMark.classList.toggle("is-on", S.chosen === o.id);
				act.replaceChildren();
				if (S.chosen === o.id) {
					act.append(h("span", "bk-done", null, ICON.tick(), `${WORDS.chosen}: ${o.name}`));
					return;
				}
				if (S.chosen || !canAnswer(o)) return;
				const busy = S.saving === o.id;
				const b = h("button", "bk-pick", { type: "button", "aria-busy": String(busy) }, busy ? WORDS.saving : `${WORDS.choose} ${o.name}`);
				if (busy) b.setAttribute("aria-disabled", "true");
				b.addEventListener("click", () => choose(o), on);
				act.append(b);
				if (S.reason[o.id]) act.append(h("p", "bk-reason", null, S.reason[o.id]));
				if (!busy && act.dataset.focus === "1") b.focus({ preventScroll: true });
			}
			const rect = () => {
				const r = P.p.getBoundingClientRect();
				return `inset(${Math.max(0, r.top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px)`;
			};
			if (instant || calm()) w.classList.add("is-in");
			else {
				w.style.clipPath = rect();
				w.getBoundingClientRect();
				requestAnimationFrame(() => {
					w.style.clipPath = "inset(0px 0px 0px 0px)";
					w.classList.add("is-in");
				});
			}
			back.addEventListener("click", () => closeWorld(), on);
			w.addEventListener(
				"keydown",
				(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						closeWorld();
					}
				},
				on,
			);
			back.focus({ preventScroll: true });
			world = {
				id,
				update,
				remove(now) {
					w.querySelectorAll("video").forEach((v) => v.pause());
					if (now || calm()) return w.remove();
					w.classList.remove("is-in");
					w.style.clipPath = rect();
					let done = false;
					const end = () => {
						if (!done) {
							done = true;
							w.remove();
						}
					};
					w.addEventListener("transitionend", (e) => e.propertyName === "clip-path" && end());
					setTimeout(end, 800);
				},
			};
			update();
		}
		function closeWorld() {
			if (!world) return;
			const id = world.id;
			world.remove();
			world = null;
			S.world = null;
			const P = panels.find((x) => x.o.id === id);
			if (P) P.p.focus({ preventScroll: true });
		}
		mark();
		if (keep.world && opts.some((o) => o.id === keep.world)) openWorld(keep.world, true);
		ask();
		return {
			keep: () => ({ chosen: S.chosen, q: S.q, world: S.world }),
			refresh: ask,
			destroy() {
				ac.abort();
				if (world) world.remove(true);
			},
		};
	}

	/* ---------------------------------------------------------- mode: wall */

	function viewWall(root, m, keep, first) {
		const ac = new AbortController();
		const on = { signal: ac.signal };
		root.append(makeHead(m));
		const grid = h("div", "bk-wall");
		root.append(grid);
		const tiles = m.items.map((d, i) => {
			const t = h("button", `bk-tile${d.mark ? ` is-${d.mark}` : ""}`, { type: "button", "aria-label": `${d.name}${d.mark ? `, ${WORDS[d.mark]}` : ""}`, "aria-haspopup": "dialog" });
			t.style.setProperty("--i", i);
			const img = picture(d.picture, d.name);
			const cut = () => {
				const tr = trimOf(img);
				t.classList.toggle("is-cut", !!(tr && !tr.photo));
			};
			if (img.tagName === "IMG") img.complete ? cut() : img.addEventListener("load", cut, { once: true, signal: ac.signal });
			t.append(img);
			if (d.mark) t.append(h("span", "bk-mark", { title: WORDS[d.mark] }, d.mark === "keep" ? ICON.tick() : ICON.strike()));
			t.append(h("span", "bk-tov", null, h("span", "bk-tname", null, d.name), d.note ? h("span", "bk-tnote", null, d.note) : null));
			t.addEventListener("click", () => show(i), on);
			grid.append(t);
			return t;
		});
		let light = null;
		let at = -1;
		function show(i) {
			if (!m.items.length) return;
			at = (i + m.items.length) % m.items.length;
			const d = m.items[at];
			if (!light) {
				light = h("div", "bk-light", { role: "dialog", "aria-modal": "true" });
				light.addEventListener(
					"click",
					(e) => {
						if (e.target === light) hide();
					},
					on,
				);
				root.append(light);
			}
			light.setAttribute("aria-label", d.name);
			const fig = h("figure");
			fig.append(picture(d.picture, d.name));
			const cap = h("figcaption", null, null, h("b", null, null, d.name));
			if (d.mark) cap.append(h("span", null, null, `· ${WORDS[d.mark]}`));
			if (d.note) cap.append(h("span", null, null, d.note));
			const src = sourceLink(d.source, d.name);
			if (src) cap.append(src);
			fig.append(cap);
			const x = h("button", "bk-x", { type: "button", "aria-label": WORDS.close }, ICON.close());
			x.addEventListener("click", hide, on);
			light.replaceChildren(fig, x);
			if (m.items.length > 1) {
				const prev = h("button", "bk-nav prev", { type: "button", "aria-label": WORDS.previous }, ICON.back());
				const next = h("button", "bk-nav next", { type: "button", "aria-label": WORDS.next }, ICON.next());
				prev.addEventListener("click", () => show(at - 1), on);
				next.addEventListener("click", () => show(at + 1), on);
				light.append(prev, next);
			}
			x.focus({ preventScroll: true });
		}
		function hide() {
			if (!light) return;
			light.remove();
			light = null;
			if (tiles[at]) tiles[at].focus({ preventScroll: true });
			at = -1;
		}
		D.addEventListener(
			"keydown",
			(e) => {
				if (!light) return;
				if (e.key === "Escape") hide();
				else if (e.key === "ArrowRight") show(at + 1);
				else if (e.key === "ArrowLeft") show(at - 1);
			},
			on,
		);
		if (typeof keep.light === "number" && keep.light >= 0 && keep.light < m.items.length) show(keep.light);
		return {
			keep: () => ({ light: light ? at : -1 }),
			destroy() {
				ac.abort();
			},
		};
	}

	/* ------------------------------------------------------------ the page */

	const app = { text: null, model: null, view: null, root: null, mounted: false, chosen: null, last: 0, timer: 0 };

	function ensureStyle() {
		if (D.getElementById("bk-style")) return;
		if (!D.querySelector("link[rel~=icon]")) (D.head || D.documentElement).append(h("link", null, { rel: "icon", href: "data:," }));
		const st = D.createElement("style");
		st.id = "bk-style";
		st.textContent = STYLE;
		(D.head || D.documentElement).append(st);
	}
	function empty() {
		ensureStyle();
		if (app.root) return;
		const root = h("main", "bk");
		root.append(h("p", "bk-empty", null, WORDS.empty));
		D.body.append(root);
		app.root = root;
	}
	function mount(model) {
		ensureStyle();
		const keep = app.view && app.view.keep ? app.view.keep() : {};
		const active = D.activeElement;
		const focusId = active && active.closest ? (active.closest("[data-id]") || {}).dataset?.id : null;
		if (app.view) app.view.destroy();
		app.view = null;
		if (app.root) app.root.remove();
		WORDS = model.words;
		LANG = model.lang;
		const first = !app.mounted;
		const root = h("main", `bk bk-${model.mode}${first ? " is-first" : ""}`, { lang: model.lang });
		D.body.append(root);
		app.root = root;
		app.model = model;
		const make = model.mode === "choose" ? viewChoose : model.mode === "wall" ? viewWall : viewScale;
		if (!model.items.length) root.append(makeHead(model), h("p", "bk-empty", null, WORDS.empty));
		else app.view = make(root, model, keep, first);
		app.mounted = true;
		if (focusId && !first) {
			const el = root.querySelector(`[data-id="${window.CSS && window.CSS.escape ? window.CSS.escape(focusId) : focusId}"]`);
			if (el && !root.querySelector(".bk-world,.bk-light")) el.focus({ preventScroll: true });
		}
		if (first) setTimeout(() => root.classList.remove("is-first"), 2400);
	}
	async function load() {
		app.last = Date.now();
		let text;
		try {
			if (!window.qorpera || typeof window.qorpera.read !== "function") throw new Error("no bridge");
			const got = await window.qorpera.read(`apps/${KIT.app}/${KIT.data || "board.json"}`);
			text = typeof got === "string" ? got : got && typeof got === "object" ? got.text || got.content || "" : "";
		} catch {
			if (!app.model) empty();
			// keep what is shown, and read again ten seconds later, until a read works
			clearTimeout(app.timer);
			app.timer = setTimeout(load, 10000);
			return;
		}
		let model = null;
		if (text !== app.text) {
			try {
				model = normalize(JSON.parse(text));
			} catch {
				if (!app.model) empty();
			}
		}
		if (!model) {
			// the page stays as it is, but open questions come and go by themselves: read them again
			if (app.view && app.view.refresh) app.view.refresh();
			return;
		}
		app.text = text;
		try {
			mount(model);
		} catch {
			if (!app.root) empty();
		}
	}
	function changed() {
		clearTimeout(app.timer);
		app.timer = setTimeout(load, Math.max(0, app.last + 10000 - Date.now()));
	}
	function start() {
		ensureStyle();
		load();
		try {
			if (window.qorpera && typeof window.qorpera.onChange === "function") window.qorpera.onChange(changed);
		} catch {}
	}
	if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
})();
