(() => {
	"use strict";

	const KIT = window.QORPERA_KIT || {};
	const BARE = KIT.concept === true;
	const D = document;
	const MAX = { title: 60, name: 48, label: 28, caption: 90, kind: 20, word: 60, top: 7, parts: 12, depth: 3, all: 80, agents: 4 };
	const STATES = ["done", "now", "later", "open"];
	const STANDS = ["in order", "side by side"];
	const PICTURE = /\.(?:png|jpe?g|webp)$/i;
	const EN = {
		done: "Done",
		now: "Now",
		later: "Later",
		open: "Still open",
		of: "{n} of {m}",
		step: "{kind} {n} of {m}",
		enter: "Open",
		noPicture: "No picture yet",
		unshaped: "Not shaped yet",
		where: "Where you are",
		parts: "Parts",
		onIt: "{name} is on it now",
		empty: "Nothing to show yet.",
	};
	const DA = {
		done: "Færdig",
		now: "Nu",
		later: "Senere",
		open: "Stadig åben",
		of: "{n} af {m}",
		step: "{kind} {n} af {m}",
		enter: "Åbn",
		noPicture: "Intet billede endnu",
		unshaped: "Ikke formet endnu",
		where: "Hvor du er",
		parts: "Dele",
		onIt: "{name} er i gang nu",
		empty: "Intet at vise endnu.",
	};
	const reduceMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
	const calm = () => reduceMQ.matches;

	const CSS = `
html,body{margin:0;background:#161615}
.rm{position:relative;box-sizing:border-box;display:flex;flex-direction:column;min-height:100vh;min-width:0;overflow-x:hidden;background:#161615;color:#fff;font-family:var(--q-font,system-ui,sans-serif);color-scheme:dark;-webkit-tap-highlight-color:transparent;
 --rm-pad:clamp(16px,3.6vw,40px);--rm-ease:cubic-bezier(.22,.8,.24,1);--rm-ink:#161615;--rm-ring:0 0 0 3px #fff;--rm-lo:104px;--rm-rise:64px;--rm-root:176px;--rm-w:132px;--rm-rw:200px}
.rm *,.rm *::before,.rm *::after{box-sizing:border-box}
.rm-stage{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.rm-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 35%;opacity:0;transition:opacity .45s ease}
.rm-pic.on{opacity:1}
.rm-scrim{position:absolute;left:0;right:0;pointer-events:none}
.rm-scrim.top{top:0;height:max(290px,42%);background:linear-gradient(to bottom,rgb(12 12 12/.7),rgb(12 12 12/0))}
.rm-scrim.bottom{bottom:0;height:max(300px,40%);background:linear-gradient(to top,rgb(12 12 12/.66),rgb(12 12 12/0))}
.rm-head{position:relative;z-index:1;flex:none;display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:min(820px,100%);padding:24px var(--rm-pad) 0;text-shadow:0 1px 12px rgb(0 0 0/.35)}
.rm.is-root .rm-head{padding-top:36px}
.rm-trail{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;max-width:100%;font-size:13px;line-height:18px}
.rm-trail[hidden]{display:none}
.rm .rm-crumb{max-width:22em;margin:0 -4px;padding:2px 4px;border:0;border-radius:6px;background:none;color:#fff;font:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:inherit}
.rm .rm-crumb:hover{text-decoration:underline}
.rm-sep{opacity:.75}
.rm-kicker{max-width:100%;margin:0;font-size:15px;font-weight:650;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rm-kicker[hidden]{display:none}
.rm-title{margin:0;max-width:100%;font-size:clamp(26px,3.4vw,42px);font-weight:650;line-height:1.14;letter-spacing:-.025em;text-wrap:balance;overflow-wrap:anywhere}
.rm.is-root .rm-title{font-size:clamp(30px,3.8vw,46px)}
.rm-line{display:-webkit-box;max-width:100%;margin:0;font-size:15px;line-height:21px;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.rm-line[hidden]{display:none}
.rm .rm-open{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:8px 14px;border:0;border-radius:12px;background:#fff;color:var(--rm-ink);font:inherit;font-size:14px;font-weight:650;line-height:20px;cursor:pointer;text-shadow:none;transition:transform .2s var(--rm-ease)}
.rm .rm-open:hover{transform:translateY(-1px)}
.rm-open[hidden]{display:none}
.rm-fill{flex:1 1 auto;min-height:16px}
.rm-strip{position:relative;z-index:1;flex:none;display:flex;align-items:flex-end;gap:14px;max-width:100%;padding:8px var(--rm-pad) 28px;overflow-x:auto;overflow-y:hidden;scroll-padding:0 var(--rm-pad);scrollbar-width:thin;scrollbar-color:rgb(255 255 255/.35) transparent;overscroll-behavior-x:contain}
.rm-strip::after{content:"";flex:0 0 1px;margin-left:-14px}
.rm .rm-tile{position:relative;flex:1 1 0;min-width:var(--rm-w);height:calc(var(--rm-lo) + var(--rm-rise) * var(--f,.55));margin:0;padding:0;border:0;border-radius:14px;overflow:hidden;background:#2a2a29;color:#fff;font:inherit;text-align:left;cursor:pointer;box-shadow:0 0 0 0 transparent;transition:box-shadow .2s ease,transform .25s var(--rm-ease)}
.rm.is-root .rm-tile{min-width:var(--rm-rw);height:var(--rm-root);border-radius:16px}
.rm .rm-tile:hover{transform:translateY(-3px)}
.rm .rm-tile.is-picked,.rm.is-root .rm-tile.is-now{box-shadow:var(--rm-ring)}
.rm .rm-tile:focus-visible,.rm .rm-crumb:focus-visible,.rm .rm-open:focus-visible{outline:3px solid var(--q-accent,#6ea4ff);outline-offset:3px}
.rm-tile img.rm-thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .35s ease}
.rm-tile img.rm-thumb.on{opacity:1}
.rm-shade{position:absolute;inset:0;background:linear-gradient(to top,rgb(12 12 12/.76),rgb(12 12 12/0) 72%)}
.rm-cap{position:absolute;left:10px;right:10px;bottom:8px;display:flex;flex-direction:column;gap:1px;min-width:0}
.rm-cap b{display:block;overflow:hidden;font-size:13px;font-weight:650;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
.rm-cap small{display:block;overflow:hidden;font-size:12px;font-weight:400;line-height:16px;text-overflow:ellipsis;white-space:nowrap;opacity:.92}
.rm.is-root .rm-cap{left:14px;right:14px;bottom:12px}
.rm.is-root .rm-cap b{font-size:20px;line-height:26px;letter-spacing:-.01em}
.rm.is-root .rm-cap small{font-size:13px;line-height:17px}
.rm-tile.is-open::after{content:"";position:absolute;inset:0;border:2px dashed rgb(255 255 255/.9);border-radius:inherit;pointer-events:none}
.rm-tile.is-bare{background:rgb(12 12 12/.45);border:2px dashed rgb(255 255 255/.85);box-shadow:none}
.rm-tile.is-bare .rm-shade{display:none}
.rm-tile.is-bare.is-open::after{display:none}
.rm .rm-tile.is-bare.is-picked{box-shadow:var(--rm-ring)}
.rm-figs{position:absolute;right:8px;top:8px;display:flex;flex-direction:row-reverse}
.rm-fig{display:grid;place-items:center;width:30px;height:30px;margin-left:-8px;border-radius:50%;overflow:hidden;font-size:11px;font-weight:650}
.rm-fig.ini{background:rgb(255 255 255/.9);color:var(--rm-ink);box-shadow:0 0 0 2px rgb(12 12 12/.5)}
.rm-fig img{display:block;width:100%;height:100%;object-fit:contain}
.rm.is-root .rm-figs{right:10px;top:10px}
.rm.is-root .rm-fig{width:36px;height:36px}
.rm-check{position:absolute;left:8px;top:8px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#fff;color:var(--rm-ink)}
.rm-check svg{width:15px;height:15px}
.rm-quiet{margin:auto;padding:24px;color:#fff;opacity:.8;font-size:15px}
.rm--bare .rm-head{display:none}
.rm.is-entering .rm-tile{animation:rm-rise .5s var(--rm-ease) both;animation-delay:calc(var(--i) * 40ms)}
@keyframes rm-rise{from{opacity:0;transform:translateY(12px)}}
@media (max-width:1100px){.rm{--rm-root:156px;--rm-rw:180px}}
@media (max-width:700px){.rm{--rm-lo:76px;--rm-rise:48px;--rm-root:140px;--rm-w:118px;--rm-rw:210px}.rm-head{padding-top:18px}.rm.is-root .rm-head{padding-top:26px}.rm-kicker{font-size:14px}.rm-line{font-size:14px;line-height:20px;-webkit-line-clamp:3}.rm-strip{gap:10px;padding-bottom:20px}.rm-strip::after{margin-left:-10px}}
@media (prefers-reduced-motion:reduce){.rm *,.rm *::before,.rm *::after{transition:none!important;animation:none!important}}
`;

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
		if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, String(attrs[k]));
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== "") el.append(kid);
		return el;
	}
	function check() {
		const el = D.createElementNS("http://www.w3.org/2000/svg", "svg");
		el.setAttribute("viewBox", "0 0 24 24");
		el.setAttribute("aria-hidden", "true");
		el.setAttribute("fill", "none");
		el.setAttribute("stroke", "currentColor");
		el.setAttribute("stroke-width", "3");
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		el.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
		return el;
	}
	const esc = (t) => (window.CSS && window.CSS.escape ? window.CSS.escape(t) : String(t).replace(/["\\]/g, "\\$&"));
	function media(path) {
		const found = D.querySelector(`#kit-media [data-kit-src="${esc(path)}"]`);
		return (found && found.getAttribute("src")) || "";
	}
	const initials = (name) =>
		Array.from(name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0] || "").join("")).join("").toUpperCase() || "?";
	function ownPicture(v) {
		return typeof v === "string" && v.length <= 200 && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("/") && !v.split("/").includes("..") && !/[\0-\x1f"<>\\]/.test(v) && PICTURE.test(v) ? v : "";
	}

	function nodeOf(raw, depth, budget) {
		const parts = [];
		if (depth < MAX.depth)
			for (const p of list(raw.parts)) {
				if (parts.length >= (depth === 0 ? MAX.top : MAX.parts) || budget.left <= 0) break;
				if (!isObj(p) || !cut(p.name, MAX.name)) continue;
				budget.left--;
				parts.push(nodeOf(p, depth + 1, budget));
			}
		const name = cut(depth === 0 ? raw.title : raw.name, depth === 0 ? MAX.title : MAX.name);
		return {
			name,
			label: cut(raw.label, MAX.label) || cut(name, MAX.label),
			caption: cut(raw.caption, MAX.caption),
			picture: ownPicture(raw.picture),
			state: STATES.includes(raw.state) ? raw.state : depth === 0 ? "now" : "later",
			agents: list(raw.agents).filter((a) => typeof a === "string" && a.trim()).slice(0, MAX.agents).map((a) => cut(a, MAX.name)),
			kind: cut(raw.kind, MAX.kind),
			inOrder: raw.stand === STANDS[0],
			parts,
		};
	}
	function normalize(raw) {
		if (!isObj(raw)) throw new Error("not an object");
		const lang = typeof raw.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.lang) ? raw.lang : "en";
		const words = { ...(lang.slice(0, 2) === "da" ? DA : EN) };
		if (isObj(raw.words)) for (const k of Object.keys(EN)) if (typeof raw.words[k] === "string" && raw.words[k].trim()) words[k] = cut(raw.words[k], MAX.word);
		const root = nodeOf(raw, 0, { left: MAX.all });
		if (!root.name || !root.parts.length) throw new Error("nothing to draw");
		const named = (n) => n.agents.length > 0 || n.parts.some(named);
		return { lang, words, root, names: named(root) };
	}

	const ui = { model: null, path: [], pick: 0, root: null, parts: null, drawn: "", reading: undefined, front: 0, shown: "", entering: false };
	const urls = new Map();

	function pictureUrl(path) {
		if (!path) return Promise.resolve(null);
		const known = urls.get(path);
		if (known) return known;
		const given = media(path);
		const bridge = window.qorpera;
		const asked = given
			? Promise.resolve(given)
			: bridge && typeof bridge.file === "function"
				? Promise.resolve()
						.then(() => bridge.file(path))
						.then(
							(url) => (typeof url === "string" && url ? url : null),
							() => null,
						)
				: Promise.resolve(path);
		urls.set(path, asked);
		return asked;
	}
	function forgetMissing() {
		for (const [path, asked] of [...urls])
			asked.then((url) => {
				if (url === null && urls.get(path) === asked) urls.delete(path);
			});
	}
	const warm = (node) => {
		for (const p of node ? node.parts : []) pictureUrl(p.picture);
	};

	function teamFigure(name) {
		const r = ui.reading;
		const team = r && Array.isArray(r.team) ? r.team : null;
		if (!team) return { name, figure: "", known: true };
		const found = team.find((a) => a && typeof a.name === "string" && a.name.toLowerCase() === name.toLowerCase());
		return found ? { name: found.name, figure: text(found.figure), known: true } : { name, figure: "", known: false };
	}

	function layerAt(path) {
		let node = ui.model.root;
		const trail = [];
		const kept = [];
		for (const i of path) {
			const next = node.parts[i];
			if (!next) break;
			trail.push(node);
			kept.push(i);
			node = next;
		}
		return { node, trail, path: kept };
	}
	const firstNow = (node) => Math.max(0, node.parts.findIndex((p) => p.state === "now"));

	function ensureStyle() {
		if (D.querySelector('style[data-kit="roadmap"]')) return;
		D.head.append(h("style", null, { "data-kit": "roadmap" }, CSS));
	}
	function show(main) {
		for (const old of D.querySelectorAll("body > main.rm")) if (old !== main) old.remove();
		if (main.parentNode !== D.body) D.body.append(main);
	}
	function quiet(line) {
		ensureStyle();
		show(h("main", `rm${BARE ? " rm--bare" : ""}`, null, h("p", "rm-quiet", null, line)));
		ui.root = null;
		ui.parts = null;
	}
	function skeleton() {
		const pics = [h("img", "rm-pic", { alt: "", decoding: "async" }), h("img", "rm-pic", { alt: "", decoding: "async" })];
		const stage = h("div", "rm-stage", { "aria-hidden": "true" }, pics, h("div", "rm-scrim top"), h("div", "rm-scrim bottom"));
		const trail = h("nav", "rm-trail", { hidden: "" });
		const kicker = h("p", "rm-kicker", { hidden: "" });
		const title = h("h1", "rm-title");
		const line = h("p", "rm-line", { hidden: "" });
		const open = h("button", "rm-open", { type: "button", hidden: "" });
		open.addEventListener("click", () => enter());
		open.addEventListener("pointerenter", () => warm(shownPart()));
		open.addEventListener("focus", () => warm(shownPart()));
		const head = h("header", "rm-head", null, trail, kicker, title, line, open);
		const strip = h("div", "rm-strip", { role: "group" });
		const root = h("main", `rm${BARE ? " rm--bare" : ""}`, null, stage, head, h("div", "rm-fill"), strip);
		ui.root = root;
		ui.parts = { pics, trail, kicker, title, line, open, strip };
		ui.shown = "";
		ui.front = 0;
		show(root);
	}

	function shownPart() {
		const { node, path } = layerAt(ui.path);
		if (!path.length) return null;
		return node.parts[ui.pick] || node;
	}
	const heldTile = () => {
		const at = D.activeElement && D.activeElement.closest ? D.activeElement.closest(".rm-tile") : null;
		return at && ui.parts && ui.parts.strip.contains(at) ? Number(at.getAttribute("data-i")) : -1;
	};

	function stageTo(path, alt) {
		const p = ui.parts;
		if (ui.shown === path) return;
		ui.shown = path;
		const [a, b] = ui.front ? [p.pics[1], p.pics[0]] : [p.pics[0], p.pics[1]];
		if (!path) {
			a.classList.remove("on");
			b.classList.remove("on");
			return;
		}
		pictureUrl(path).then((url) => {
			if (ui.shown !== path || ui.parts !== p) return;
			if (!url) {
				a.classList.remove("on");
				b.classList.remove("on");
				return;
			}
			const swap = () => {
				if (ui.shown !== path || ui.parts !== p) return;
				b.classList.add("on");
				a.classList.remove("on");
				ui.front = ui.front ? 0 : 1;
			};
			b.onload = swap;
			b.onerror = () => {
				if (ui.shown === path) a.classList.remove("on");
			};
			b.alt = alt;
			a.alt = "";
			if (b.getAttribute("src") === url && b.complete && b.naturalWidth) swap();
			else b.src = url;
		});
	}

	function stateWord(part) {
		const w = ui.model.words;
		return part.state === "later" ? "" : w[part.state];
	}
	function partsLine(part) {
		const w = ui.model.words;
		if (!part.parts.length) return "";
		if (!part.inOrder) return part.parts.map((p) => p.label).join(" · ");
		const groups = [];
		for (const p of part.parts) {
			const last = groups[groups.length - 1];
			if (last && last.state === p.state) last.names.push(p.label);
			else groups.push({ state: p.state, names: [p.label] });
		}
		return groups.map((g) => `${w[g.state]}: ${g.names.join(", ")}`).join(" · ");
	}
	function lineOf(part) {
		if (part.caption) return part.caption;
		const parts = partsLine(part);
		if (parts) return parts;
		return part.state === "later" || part.state === "open" ? ui.model.words.unshaped : "";
	}

	function tile(part, i, layer, rootLayer, picked) {
		const w = ui.model.words;
		const n = layer.inOrder ? `${i + 1} · ` : "";
		const second = rootLayer ? [part.caption, stateWord(part)].filter(Boolean).join(" · ") : "";
		const bare = !part.picture;
		const label = [layer.inOrder ? `${i + 1}` : "", part.name, part.caption, stateWord(part)].filter(Boolean).join(", ");
		const b = h("button", `rm-tile is-${part.state}${bare ? " is-bare" : ""}${picked ? " is-picked" : ""}`, {
			type: "button",
			"aria-label": label,
			"aria-pressed": rootLayer ? null : String(picked),
			"data-i": String(i),
		});
		b.style.setProperty("--i", String(i));
		if (layer.inOrder && !rootLayer) b.style.setProperty("--f", String(layer.parts.length > 1 ? i / (layer.parts.length - 1) : 0.55));
		if (!bare) {
			const img = h("img", "rm-thumb", { alt: part.name, decoding: "async", draggable: "false" });
			img.onload = () => img.classList.add("on");
			img.onerror = () => {
				img.onerror = null;
				img.remove();
				b.classList.add("is-bare");
				b.querySelector(".rm-cap").append(h("small", null, null, w.noPicture));
			};
			b.append(img, h("span", "rm-shade"));
			pictureUrl(part.picture).then((url) => {
				if (url) img.src = url;
				else if (img.onerror) img.onerror();
			});
		}
		b.append(h("span", "rm-cap", null, h("b", null, null, rootLayer ? part.name : `${n}${part.label}`), second ? h("small", null, null, second) : null, bare ? h("small", null, null, w.noPicture) : null));
		if (part.state === "done") b.append(h("span", "rm-check", { "aria-hidden": "true" }, check()));
		if (part.state === "now" && part.agents.length) {
			const figs = h("span", "rm-figs");
			for (const name of part.agents) {
				const who = teamFigure(name);
				if (!who.known) continue;
				const src = who.figure ? media(`figure:${who.figure}`) : "";
				const said = fill(w.onIt, { name: who.name });
				figs.append(src ? h("span", "rm-fig", { title: said }, h("img", null, { src, alt: said })) : h("span", "rm-fig ini", { role: "img", "aria-label": said, title: said }, initials(who.name)));
			}
			if (figs.childElementCount) b.append(figs);
		}
		b.addEventListener("click", () => (rootLayer ? down(i) : pick(i)));
		if (rootLayer) {
			b.addEventListener("pointerenter", () => warm(part));
			b.addEventListener("focus", () => warm(part));
		}
		return b;
	}

	function render() {
		if (!ui.model) return;
		ensureStyle();
		if (!ui.root) skeleton();
		const m = ui.model;
		const p = ui.parts;
		D.documentElement.lang = m.lang;
		ui.root.setAttribute("lang", m.lang);
		const held = heldTile();
		const { node: layer, trail, path } = layerAt(ui.path);
		ui.path = path;
		const rootLayer = path.length === 0;
		if (!rootLayer && (ui.pick < 0 || ui.pick >= layer.parts.length)) ui.pick = firstNow(layer);
		ui.root.classList.toggle("is-root", rootLayer);
		p.trail.hidden = rootLayer;
		p.trail.setAttribute("aria-label", m.words.where);
		p.trail.replaceChildren(
			...trail.flatMap((node, k) => {
				const crumb = h("button", "rm-crumb", { type: "button" }, `${k === 0 ? "‹ " : ""}${cut(node.name, 40)}`);
				crumb.addEventListener("click", () => up(k));
				return k ? [h("span", "rm-sep", { "aria-hidden": "true" }, "›"), crumb] : [crumb];
			}),
		);
		const shown = rootLayer ? layer : layer.parts[ui.pick] || layer;
		const ordinal = () => (layer.kind ? fill(m.words.step, { kind: layer.kind, n: ui.pick + 1, m: layer.parts.length }) : fill(m.words.of, { n: ui.pick + 1, m: layer.parts.length }));
		const kicker = rootLayer
			? ""
			: shown === layer
				? [trail[trail.length - 1].name, stateWord(layer)].filter(Boolean).join(" · ")
				: [layer.name, layer.inOrder ? ordinal() : "", stateWord(shown)].filter(Boolean).join(" · ");
		p.kicker.textContent = kicker;
		p.kicker.hidden = !kicker;
		p.title.textContent = shown.name;
		const line = rootLayer ? layer.caption : lineOf(shown);
		p.line.textContent = line;
		p.line.hidden = !line;
		const opens = !rootLayer && shown !== layer && shown.parts.length > 0;
		p.open.hidden = !opens;
		p.open.textContent = `${m.words.enter} ›`;
		p.open.setAttribute("aria-label", `${m.words.enter}: ${shown.name}`);
		stageTo(shown.picture, shown.name);
		p.strip.setAttribute("aria-label", layer.kind || m.words.parts);
		const key = `${path.join("/")}|${ui.drawn}`;
		if (p.strip.__key !== key) {
			p.strip.__key = key;
			ui.root.classList.toggle("is-entering", ui.entering && !calm());
			p.strip.replaceChildren(...layer.parts.map((part, i) => tile(part, i, layer, rootLayer, !rootLayer && i === ui.pick)));
			if (ui.entering) setTimeout(() => ui.root && ui.root.classList.remove("is-entering"), 900);
		} else
			for (const t of p.strip.querySelectorAll(".rm-tile")) {
				const on = !rootLayer && Number(t.getAttribute("data-i")) === ui.pick;
				t.classList.toggle("is-picked", on);
				if (!rootLayer) t.setAttribute("aria-pressed", String(on));
			}
		ui.entering = false;
		if (held >= 0) focusTile(held);
	}

	function focusTile(i) {
		const t = ui.parts && ui.parts.strip.querySelector(`.rm-tile[data-i="${i}"]`);
		if (!t) return;
		t.focus({ preventScroll: true });
		if (t.scrollIntoView) t.scrollIntoView({ block: "nearest", inline: "nearest", behavior: calm() ? "auto" : "smooth" });
	}
	function pick(i) {
		ui.pick = i;
		render();
		focusTile(i);
	}
	function down(i) {
		const { node } = layerAt(ui.path);
		const next = node.parts[i];
		if (!next) return;
		ui.path = [...ui.path, i];
		ui.pick = firstNow(next);
		ui.entering = true;
		render();
		if (next.parts.length) focusTile(ui.pick);
		else ui.parts.trail.querySelector(".rm-crumb").focus({ preventScroll: true });
	}
	function enter() {
		if (!ui.path.length) return;
		down(ui.pick);
	}
	function up(depth) {
		if (depth >= ui.path.length) return;
		const came = ui.path[depth];
		ui.path = ui.path.slice(0, depth);
		ui.pick = came;
		ui.entering = true;
		render();
		focusTile(came);
	}
	D.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || e.isComposing || !ui.path.length || e.defaultPrevented) return;
		e.preventDefault();
		up(ui.path.length - 1);
	});

	let lastRead = 0;
	let pending = 0;
	let lastText = null;
	let readingWait = 0;
	let readingFails = 0;
	async function live(model) {
		const bridge = window.qorpera;
		if (!bridge || !model.names || typeof bridge.reading !== "function" || Date.now() < readingWait) return;
		try {
			const answer = await bridge.reading();
			if (isObj(answer)) ui.reading = answer;
			readingFails = 0;
		} catch (err) {
			readingFails++;
			readingWait = /reads in app\.toml/.test(String(err && err.message)) ? Infinity : Date.now() + Math.min(6e5, 1e4 * 2 ** (readingFails - 1));
		}
	}
	async function load() {
		lastRead = Date.now();
		let txt;
		let raw = null;
		try {
			const bridge = window.qorpera;
			if (!bridge || typeof bridge.read !== "function") throw new Error("no bridge");
			const res = await (typeof KIT.load === "function" ? KIT.load() : bridge.read(`apps/${KIT.app || ""}/${KIT.data || "roadmap.json"}`));
			txt = typeof res === "string" ? res : res && (res.text ?? (res.content && res.content.text) ?? res.content);
			if (typeof txt !== "string") throw new Error("no text");
			raw = JSON.parse(txt);
			const changed = txt !== lastText;
			const model = !changed && ui.model ? ui.model : normalize(raw);
			if (changed && lastText !== null) forgetMissing();
			await live(model);
			const team = ui.reading && Array.isArray(ui.reading.team) ? ui.reading.team.map((a) => (a ? [a.name, a.figure] : null)) : null;
			const key = JSON.stringify([txt, team]);
			if (key === ui.drawn && ui.root) return;
			ui.model = model;
			lastText = txt;
			ui.drawn = key;
			render();
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
		} catch {}
	}
	if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
})();
