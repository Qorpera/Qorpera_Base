// The explainer kit's engine (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a): a small Manim-like animation engine
// and its player, for an interface app that explains one thing as a short narrated video. save_app writes this file
// into the app's folder as engine.js, beside the page it makes (index.html) and the agent's own scenes.js. It is the
// source of packages/runtime/src/cloud-app-kit-explainer-engine.generated.ts (scripts/generate-app-kits.mjs); change
// it here, then run that script.
//
// Every frame is computed from the time alone (no state carried from frame to frame), so the video scrubs, pauses
// and jumps anywhere. No network, no storage, no fonts: it runs inside the app frame as it is.
//
// The page makes the video and starts it; scenes.js only fills it:
//   V.part("The idea");                       // a chapter mark (no card)
//   V.scene((s) => {
//     const a = s.box({ x: 400, y: 300, w: 240, h: 90, label: "Database", color: C.blue });
//     s.say("Caption for this beat.", s.create(a));
//   });
//
// The stage is 1600 x 900 units. Each say() is one caption. Its animations play one after another from the caption's
// start (`w: true` plays an animation with the one before it; `t` sets an offset in seconds). A caption lasts as long
// as its words take to read, or as long as its animations, whichever is longer.
//
// Voice. A caption can have a recorded clip: an element in index.html, before the scripts,
//   <audio data-caption="HASH" data-seconds="5.42" preload="none"><source src="voice/HASH.mp4"></audio>
// where HASH is captionHash(text) (FNV-1a 32-bit over the caption's UTF-8 text, 8 hex digits). A caption with a clip
// lasts as long as the clip, and the player speaks it while the caption is on screen. The caption stays: the voice
// can be switched off, and a phone may be silent. A caption without a clip is read in silence.
//
// Everything is inside one function, so a scenes.js may name its own things as it likes; it is handed Video, C and
// captionHash.

(() => {
"use strict";

const NS = "http://www.w3.org/2000/svg";
const C = {
  bg: "#0f1014", text: "#ECECEC", dim: "#9097a1", faint: "#3a3f47",
  blue: "#58C4DD", yellow: "#F7D96F", green: "#83C167", red: "#FC6255", teal: "#5CD0B3",
  purple: "#B189D6", orange: "#FF9A4A", pink: "#F38BA8", grey: "#6b727c",
};
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, p) => a + (b - a) * p;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Names a caption's voice clip: FNV-1a 32-bit over the caption's UTF-8 text, as 8 hex digits. */
function captionHash(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/** Multi-line SVG text ("a\nb"), centred on (0,0) by default. */
function textEl(parent, str, { size = 30, color = C.text, anchor = "middle", weight = 400, font = "serif", italic = false, lh = 1.25 } = {}) {
  const lines = String(str).split("\n");
  const t = el("text", {
    "font-size": size, fill: color, "text-anchor": anchor, "font-weight": weight,
    "font-family": font === "mono" ? "var(--mono)" : font === "sans" ? "var(--sans)" : "var(--serif)",
    "font-style": italic ? "italic" : "normal", "dominant-baseline": "central",
  }, parent);
  t.style.fontVariantNumeric = "tabular-nums";
  const top = -((lines.length - 1) * size * lh) / 2;
  lines.forEach((line, i) => {
    const ts = el("tspan", { x: 0, y: top + i * size * lh }, t);
    ts.textContent = line;
  });
  return t;
}

// ---------------------------------------------------------------- mobjects

class Mob {
  constructor(scene, o = {}) {
    this.scene = scene;
    this.base = { x: o.x ?? 0, y: o.y ?? 0, s: o.s ?? 1, rot: o.rot ?? 0, o: o.show ? 1 : 0, draw: o.show ? 1 : 0, v: o.v ?? 0, glow: 0, dy: 0 };
    this.shown = Boolean(o.show);
    this.g = el("g", {}, o.parent ? o.parent.g : scene.layer(o.layer ?? 1));
    this.strokes = [];
    this.fills = [];
    this.late = []; // elements that appear in the last part of a create (labels, arrow heads)
    scene.mobs.push(this);
  }
  stroke(e, fillOpacity = 0) {
    e.setAttribute("pathLength", 1);
    e.style.strokeDasharray = "1 1";
    this.strokes.push(e);
    if (fillOpacity) this.fills.push([e, fillOpacity]);
    return e;
  }
  apply(st) {
    this.g.setAttribute("transform", `translate(${st.x},${st.y + st.dy}) rotate(${st.rot}) scale(${st.s * (1 + 0.12 * st.glow)})`);
    this.g.style.opacity = st.o;
    const d = clamp01(st.draw);
    for (const e of this.strokes) e.style.strokeDashoffset = 1 - d;
    for (const [e, fo] of this.fills) e.style.fillOpacity = fo * clamp01((d - 0.45) / 0.55);
    for (const e of this.late) e.style.opacity = clamp01((d - 0.6) / 0.4);
    if (this.glowEl) this.glowEl.style.opacity = st.glow;
    this.update?.(st);
  }
  /** Where an arrow should attach on this mob's border, towards point p. */
  anchor(p) {
    const { x, y } = this.base;
    const hw = (this.w ?? 0) / 2, hh = (this.h ?? 0) / 2;
    if (!hw && !hh) return { x, y };
    const dx = p.x - x, dy = p.y - y;
    if (!dx && !dy) return { x, y };
    const k = Math.min(hw ? hw / Math.abs(dx || 1e-9) : Infinity, hh ? hh / Math.abs(dy || 1e-9) : Infinity);
    return { x: x + dx * Math.min(k, 1e6), y: y + dy * Math.min(k, 1e6) };
  }
}

class Box extends Mob {
  constructor(scene, o) {
    super(scene, o);
    const { w = 220, h = 80, color = C.blue, label = "", sub = "", size = 28, r = 14, fill = 0.13, dash = false, labelColor, subColor } = o;
    this.w = w; this.h = h;
    this.glowEl = el("rect", { x: -w / 2 - 6, y: -h / 2 - 6, width: w + 12, height: h + 12, rx: r + 4, fill: "none", stroke: color, "stroke-width": 2, opacity: 0, filter: "url(#glow)" }, this.g);
    this.rect = this.stroke(el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: r, fill: color, stroke: color, "stroke-width": 2.6 }, this.g), fill);
    if (dash) { this.strokes.pop(); this.rect.removeAttribute("pathLength"); this.rect.style.strokeDasharray = "8 7"; this.late.push(this.rect); }
    this.texts = [];
    if (label) {
      const t = textEl(this.g, label, { size, color: labelColor ?? C.text, font: o.font ?? "serif" });
      const dy = sub ? -size * 0.38 : 0;
      t.setAttribute("transform", `translate(0,${dy})`);
      this.late.push(t); this.label = t; this.texts.push([t, dy]);
    }
    if (sub) {
      const t = textEl(this.g, sub, { size: Math.round(size * 0.68), color: subColor ?? C.dim, font: "sans" });
      const dy = label ? size * 0.6 : 0;
      t.setAttribute("transform", `translate(0,${dy})`);
      this.late.push(t); this.texts.push([t, dy]);
    }
  }
  /** Shrink a label that is wider than its box (measured once, while visible). */
  update() {
    if (this.fitted === window.FIT_EPOCH) return;
    let measured = true;
    for (const [t, dy] of this.texts) {
      let w = 0;
      try { w = t.getBBox().width; } catch { w = 0; }
      if (!w) { measured = false; continue; }
      const k = Math.min(1, (this.w - 26) / w);
      t.setAttribute("transform", `translate(0,${dy}) scale(${k})`);
    }
    if (measured) this.fitted = window.FIT_EPOCH;
  }
}

class Txt extends Mob {
  constructor(scene, o) {
    super(scene, o);
    const { str = "", size = 34, color = C.text, anchor = "middle", weight, font, italic } = o;
    this.clip = el("clipPath", { id: `c${scene.video.uid()}` }, scene.video.defs);
    this.clipRect = el("rect", { x: -2000, y: -1000, width: 0, height: 2000 }, this.clip);
    const g = el("g", { "clip-path": `url(#${this.clip.id})` }, this.g);
    this.t = textEl(g, str, { size, color, anchor, weight, font, italic });
  }
  update(st) {
    const d = clamp01(st.draw);
    if (d >= 1) { this.clipRect.setAttribute("x", -50000); this.clipRect.setAttribute("width", 100000); return; }
    let bb = null;
    try { bb = this.t.getBBox(); } catch { bb = null; }
    if (!bb || !bb.width) bb = { x: -1000, width: 2000 };
    this.clipRect.setAttribute("x", bb.x - 4);
    this.clipRect.setAttribute("width", (bb.width + 12) * d);
  }
}

/** A number that shows its `v`: animate it with s.value(num, to). `fmt` turns the value into text. */
class Num extends Mob {
  constructor(scene, o) {
    super(scene, o);
    const { size = 64, color = C.text, anchor = "middle", weight = 600, font = "sans", fmt = (v) => String(Math.round(v)) } = o;
    this.fmt = fmt;
    this.base.v = o.from ?? o.v ?? 0;
    this.t = textEl(this.g, "", { size, color, anchor, weight, font });
    this.span = this.t.firstChild;
  }
  update(st) {
    const s = this.fmt(st.v);
    if (s !== this.last) { this.span.textContent = s; this.last = s; }
  }
}

/** A bar whose length is its `v` times `scale` (grow it with s.value). dir "up": x is the centre, y the baseline;
 *  a negative value hangs below the baseline in `negColor`. dir "right": x is the left end, y the centre. */
class Bar extends Mob {
  constructor(scene, o) {
    super(scene, { ...o, x: 0, y: 0 });
    const { x = 0, y = 0, w = 60, h = 60, dir = "up", scale = 1, color = C.blue, negColor = C.red, fill = 0.85 } = o;
    Object.assign(this, { x0: x, y0: y, bw: w, bh: h, dir, k: scale, color, negColor });
    this.base.o = 1;
    this.rect = el("rect", { rx: 3, fill: color, "fill-opacity": fill, stroke: color, "stroke-width": 2 }, this.g);
  }
  update(st) {
    const v = st.v * this.k, a = Math.abs(v), r = this.rect;
    const c = v < 0 ? this.negColor : this.color;
    r.setAttribute("fill", c); r.setAttribute("stroke", c);
    if (this.dir === "up") {
      r.setAttribute("x", this.x0 - this.bw / 2); r.setAttribute("width", this.bw);
      r.setAttribute("y", v >= 0 ? this.y0 - a : this.y0); r.setAttribute("height", a);
    } else {
      r.setAttribute("y", this.y0 - this.bh / 2); r.setAttribute("height", this.bh);
      r.setAttribute("x", v >= 0 ? this.x0 : this.x0 - a); r.setAttribute("width", a);
    }
    r.style.display = a < 0.5 ? "none" : "";
  }
}

/** A path drawn by `create`: a line, an arrow (head appears at the end), or any shape. */
class Line extends Mob {
  constructor(scene, o) {
    super(scene, { ...o, x: 0, y: 0 });
    const { d, color = C.dim, width = 3, head = true, label, labelSize = 22, labelAt = 0.5, labelOffset = -18, labelColor } = o;
    this.color = color;
    this.path = this.stroke(el("path", { d, fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" }, this.g));
    if (head) {
      const L = this.path.getTotalLength();
      const a = this.path.getPointAtLength(L), b = this.path.getPointAtLength(Math.max(0, L - 14));
      const ang = (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI;
      const h = el("path", { d: "M0,0 L-16,-8 L-16,8 Z", fill: color, transform: `translate(${a.x},${a.y}) rotate(${ang})` }, this.g);
      this.late.push(h);
    }
    if (label) {
      const L = this.path.getTotalLength();
      const p = this.path.getPointAtLength(L * labelAt);
      const t = textEl(this.g, label, { size: labelSize, color: labelColor ?? C.dim, font: "sans" });
      t.setAttribute("transform", `translate(${p.x},${p.y + labelOffset})`);
      this.late.push(t);
    }
  }
  pointAt(u) {
    const L = this.path.getTotalLength();
    return this.path.getPointAtLength(L * clamp01(u));
  }
}

/** A small labelled dot that travels along a Line during a `flow`. */
class Packet extends Mob {
  constructor(scene, o) {
    super(scene, { ...o, layer: 2 });
    const { color = C.yellow, label = "", r = 10, size = 22 } = o;
    this.line = o.line;
    el("circle", { r: r + 7, fill: color, opacity: 0.18 }, this.g);
    el("circle", { r, fill: color }, this.g);
    if (label) {
      const t = textEl(this.g, label, { size, color, font: "sans", weight: 600 });
      t.setAttribute("transform", `translate(0,${-r - 18})`);
    }
  }
  update(st) {
    const p = this.line.pointAt(st.v);
    this.g.setAttribute("transform", `translate(${p.x},${p.y}) scale(${st.s})`);
  }
}

/** Icons drawn as strokes so `create` draws them. Centred on (0,0), about 56 x 60 units at size 1. */
const ICONS = {
  person: (g, k) => [
    el("circle", { cx: 0, cy: -18 * k, r: 13 * k }, g),
    el("path", { d: `M${-24 * k},${26 * k} Q${-24 * k},${-2 * k} 0,${-2 * k} Q${24 * k},${-2 * k} ${24 * k},${26 * k} Z` }, g),
  ],
  bot: (g, k) => [
    el("rect", { x: -22 * k, y: -20 * k, width: 44 * k, height: 34 * k, rx: 9 * k }, g),
    el("path", { d: `M0,${-20 * k} L0,${-30 * k} M${-9 * k},${-4 * k} L${-9 * k},${0} M${9 * k},${-4 * k} L${9 * k},0 M${-12 * k},${22 * k} L${12 * k},${22 * k}` }, g),
  ],
  house: (g, k) => [
    el("path", { d: `M${-30 * k},${-2 * k} L0,${-28 * k} L${30 * k},${-2 * k} Z` }, g),
    el("rect", { x: -22 * k, y: -2 * k, width: 44 * k, height: 28 * k }, g),
    el("rect", { x: -6 * k, y: 8 * k, width: 12 * k, height: 18 * k }, g),
  ],
  bus: (g, k) => [
    el("rect", { x: -28 * k, y: -22 * k, width: 56 * k, height: 40 * k, rx: 8 * k }, g),
    el("path", { d: `M${-22 * k},${-14 * k} L${22 * k},${-14 * k} L${22 * k},${0} L${-22 * k},${0} Z` }, g),
    el("circle", { cx: -15 * k, cy: 22 * k, r: 6 * k }, g),
    el("circle", { cx: 15 * k, cy: 22 * k, r: 6 * k }, g),
  ],
  card: (g, k) => [
    el("rect", { x: -28 * k, y: -18 * k, width: 56 * k, height: 36 * k, rx: 5 * k }, g),
    el("path", { d: `M${-28 * k},${-7 * k} L${28 * k},${-7 * k} M${-18 * k},${8 * k} L${-4 * k},${8 * k}` }, g),
  ],
  server: (g, k) => [0, 1, 2].map((i) => el("rect", { x: -26 * k, y: (-28 + i * 19) * k, width: 52 * k, height: 15 * k, rx: 3 * k }, g)),
  db: (g, k) => [
    el("ellipse", { cx: 0, cy: -20 * k, rx: 26 * k, ry: 8 * k }, g),
    el("path", { d: `M${-26 * k},${-20 * k} L${-26 * k},${20 * k} A${26 * k},${8 * k} 0 0 0 ${26 * k},${20 * k} L${26 * k},${-20 * k}` }, g),
  ],
  cloud: (g, k) => [el("path", { d: `M${-26 * k},${16 * k} A${13 * k},${13 * k} 0 0 1 ${-20 * k},${-8 * k} A${17 * k},${17 * k} 0 0 1 ${10 * k},${-16 * k} A${14 * k},${14 * k} 0 0 1 ${28 * k},${4 * k} A${11 * k},${11 * k} 0 0 1 ${22 * k},${16 * k} Z` }, g)],
  lock: (g, k) => [
    el("rect", { x: -20 * k, y: -4 * k, width: 40 * k, height: 30 * k, rx: 5 * k }, g),
    el("path", { d: `M${-12 * k},${-4 * k} L${-12 * k},${-16 * k} A${12 * k},${12 * k} 0 0 1 ${12 * k},${-16 * k} L${12 * k},${-4 * k}` }, g),
  ],
  doc: (g, k) => [
    el("path", { d: `M${-18 * k},${-26 * k} L${8 * k},${-26 * k} L${18 * k},${-16 * k} L${18 * k},${26 * k} L${-18 * k},${26 * k} Z` }, g),
    el("path", { d: `M${-10 * k},${-6 * k} L${10 * k},${-6 * k} M${-10 * k},${4 * k} L${10 * k},${4 * k} M${-10 * k},${14 * k} L${4 * k},${14 * k}` }, g),
  ],
  coin: (g, k) => [el("circle", { cx: 0, cy: 0, r: 23 * k }, g), el("circle", { cx: 0, cy: 0, r: 15 * k }, g)],
  clock: (g, k) => [el("circle", { cx: 0, cy: 0, r: 24 * k }, g)],
  shield: (g, k) => [el("path", { d: `M0,${-26 * k} L${22 * k},${-17 * k} L${20 * k},${6 * k} Q${14 * k},${20 * k} 0,${28 * k} Q${-14 * k},${20 * k} ${-20 * k},${6 * k} L${-22 * k},${-17 * k} Z` }, g)],
  globe: (g, k) => [
    el("circle", { cx: 0, cy: 0, r: 24 * k }, g),
    el("path", { d: `M${-24 * k},0 L${24 * k},0 M0,${-24 * k} Q${-16 * k},0 0,${24 * k} M0,${-24 * k} Q${16 * k},0 0,${24 * k}` }, g),
  ],
  mail: (g, k) => [el("rect", { x: -24 * k, y: -16 * k, width: 48 * k, height: 32 * k, rx: 4 * k }, g), el("path", { d: `M${-24 * k},${-14 * k} L0,${4 * k} L${24 * k},${-14 * k}` }, g)],
  bolt: (g, k) => [el("path", { d: `M${4 * k},${-26 * k} L${-14 * k},${4 * k} L${0},${4 * k} L${-4 * k},${26 * k} L${14 * k},${-4 * k} L0,${-4 * k} Z` }, g)],
};

class Icon extends Mob {
  constructor(scene, o) {
    super(scene, o);
    const { name, color = C.blue, size = 1, label, labelSize = 24, fill = 0.12, labelColor } = o;
    this.w = 56 * size; this.h = 60 * size;
    const g = el("g", { fill: color, stroke: color, "stroke-width": 2.6, "stroke-linejoin": "round", "stroke-linecap": "round" }, this.g);
    // An unknown name draws a plain ring, so one wrong word does not stop the video.
    for (const e of (ICONS[name] ?? ICONS.clock)(g, size)) this.stroke(e, fill);
    if (name === "clock" && ICONS[name]) {
      this.hand = el("path", { d: `M0,0 L0,${-18 * size}`, stroke: color, "stroke-width": 3 }, g);
      this.late.push(this.hand);
    }
    if (label) {
      const t = textEl(this.g, label, { size: labelSize, color: labelColor ?? C.text, font: "sans" });
      t.setAttribute("transform", `translate(0,${34 * size + labelSize * 0.6 * String(label).split("\n").length})`);
      this.late.push(t);
    }
  }
  update(st) {
    if (this.hand) this.hand.setAttribute("transform", `rotate(${st.v * 360})`);
  }
}

// ---------------------------------------------------------------- animations

const KINDS = {
  create: (st, p) => { st.o = Math.max(st.o, p > 0 ? 1 : 0); st.draw = p; },
  write: (st, p) => { st.o = p > 0 ? 1 : st.o; st.draw = p; },
  fadeIn: (st, p, a) => { st.o = p * (a.to ?? 1); st.draw = 1; st.dy = (1 - p) * (a.shift ?? 0); },
  fadeOut: (st, p) => { st.o = st.o * (1 - p); },
  dim: (st, p, a) => { st.o = lerp(st.o, a.to ?? 0.25, p); },
  move: (st, p, a) => { if (a.x !== undefined) st.x = lerp(st.x, a.x, p); if (a.y !== undefined) st.y = lerp(st.y, a.y, p); if (a.cam !== undefined) st.s = lerp(st.s, a.cam, p); },
  scale: (st, p, a) => { st.s = lerp(st.s, a.to, p); },
  indicate: (st, p) => { st.glow = Math.sin(Math.PI * p); },
  value: (st, p, a) => { st.v = lerp(a.from ?? st.v, a.to, p); },
  flowStep: (st, p) => { st.o = p <= 0 || p >= 1 ? 0 : p < 0.08 ? p / 0.08 : p > 0.92 ? (1 - p) / 0.08 : 1; st.v = p; },
};

class Scene {
  constructor(video, index) {
    this.video = video;
    this.index = index;
    this.mobs = [];
    this.anims = [];
    this.segments = [];
    this.cursor = 0.3;
    this.root = el("g", { class: "scene" }, video.world);
    this.root.style.display = "none";
    this.layers = [el("g", {}, this.root), el("g", {}, this.root), el("g", {}, this.root)];
    const root = this.root;
    this.cam = { base: { x: 800, y: 450, s: 1, o: 1 }, apply(st) { root.setAttribute("transform", `translate(800,450) scale(${st.s}) translate(${-st.x},${-st.y})`); } };
    this.mobs.push(this.cam);
  }
  layer(i) { return this.layers[i]; }
  box(o) { return new Box(this, o); }
  text(o) { return new Txt(this, o); }
  number(o) { return new Num(this, o); }
  bar(o) { return new Bar(this, o); }
  icon(o) { return new Icon(this, o); }
  line(o) { return new Line(this, o); }
  /** An arrow from mob/point a to mob/point b (straight, or bent through `via` / curved by `bend`). */
  arrow(a, b, o = {}) {
    const pa0 = a.base ?? a, pb0 = b.base ?? b;
    const pa = a.anchor ? a.anchor(o.via ?? pb0) : pa0;
    const pb = b.anchor ? b.anchor(o.via ?? pa0) : pb0;
    const gap = o.gap ?? 10;
    const shrink = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / L) * gap, y: p.y + (dy / L) * gap }; };
    let d;
    if (o.via) { const s = shrink(pa, o.via), e = shrink(pb, o.via); d = `M${s.x},${s.y} Q${o.via.x},${o.via.y} ${e.x},${e.y}`; }
    else if (o.bend) {
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2, dx = pb.x - pa.x, dy = pb.y - pa.y;
      const c = { x: mx - dy * o.bend, y: my + dx * o.bend };
      const s = shrink(pa, c), e = shrink(pb, c); d = `M${s.x},${s.y} Q${c.x},${c.y} ${e.x},${e.y}`;
    } else { const s = shrink(pa, pb), e = shrink(pb, pa); d = `M${s.x},${s.y} L${e.x},${e.y}`; }
    return new Line(this, { ...o, d });
  }

  // Animation descriptors (passed to say()).
  create(mob, d = 1.2, o = {}) { return { mob, kind: "create", d, ...o }; }
  write(mob, d = 1.4, o = {}) { return { mob, kind: "write", d, ...o }; }
  fadeIn(mob, d = 0.8, o = {}) { return { mob, kind: "fadeIn", d, shift: 18, ...o }; }
  fadeOut(mob, d = 0.6, o = {}) { return { mob, kind: "fadeOut", d, ...o }; }
  dim(mob, to = 0.25, d = 0.6, o = {}) { return { mob, kind: "dim", d, to, ...o }; }
  move(mob, x, y, d = 1, o = {}) { return { mob, kind: "move", d, x, y, ...o }; }
  scale(mob, to, d = 0.8, o = {}) { return { mob, kind: "scale", d, to, ...o }; }
  indicate(mob, d = 1, o = {}) { return { mob, kind: "indicate", d, ...o }; }
  value(mob, to, d = 1, o = {}) { return { mob, kind: "value", d, to, ...o }; }
  /** Many mobs at once: s.all(s.create, [a, b, c], 1) */
  all(fn, mobs, ...args) { return mobs.map((m, i) => ({ ...fn.call(this, m, ...args), w: i > 0 })); }
  /** Packets travelling along a line. */
  flow(line, d = 1.6, o = {}) {
    const n = o.count ?? 1, gap = o.gap ?? 0.35;
    const out = [];
    for (let i = 0; i < n; i++) {
      const pk = new Packet(this, { line, color: o.color ?? C.yellow, label: o.label ?? "" });
      out.push({ mob: pk, kind: "flowStep", d, t: o.t, w: i > 0 ? true : o.w, lag: i * gap });
    }
    return out;
  }
  /** Pan and zoom: (x, y) is the point brought to the centre, s the zoom. */
  camera(x, y, s, d = 1.4, o = {}) { return { mob: this.cam, kind: "move", d, x, y, cam: s, ...o }; }

  /** One caption with its animations. */
  say(text, ...anims) {
    const start = this.cursor;
    let c = start, prev = start;
    for (const a of anims.flat()) {
      let t0;
      if (a.t !== undefined) t0 = start + a.t + (a.lag ?? 0); // explicit offset in the caption
      else if (a.w) t0 = prev + (a.lag ?? 0); // with the animation before it
      else t0 = c; // after everything so far
      if (!a.w) prev = t0;
      this.anims.push({ ...a, t0 });
      c = Math.max(c, t0 + a.d);
    }
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const v = this.video;
    // Spoken, a caption lasts as long as its clip and a breath; silent, as long as its words take to read.
    const clip = v.voice.get(captionHash(text)) ?? null;
    const dur = Math.max(clip ? clip.seconds + v.pad : words ? words / v.wps + v.pad : 0, c - start + 0.3, 1.2);
    this.segments.push({ text, start, end: start + dur, clip });
    this.cursor = start + dur;
    return this;
  }
  wait(sec) { this.cursor += sec; return this; }

  finish() {
    const first = new Map();
    for (const a of this.anims) if (!first.has(a.mob) || a.t0 < first.get(a.mob)) first.set(a.mob, a.t0);
    let lastStart = 0;
    for (const m of this.mobs) {
      if (m === this.cam || m instanceof Packet || m.shown) continue;
      if (first.has(m)) { lastStart = first.get(m); continue; }
      this.anims.push({ mob: m, kind: "fadeIn", d: 0.6, shift: 0, t0: lastStart + (lastStart ? 0.3 : 0.1) });
    }
    this.anims.sort((a, b) => a.t0 - b.t0);
    this.duration = this.cursor + 0.5;
  }
  render(t) {
    for (const m of this.mobs) m.st = { ...m.base };
    for (const a of this.anims) {
      if (t < a.t0) break;
      const raw = a.d > 0 ? (t - a.t0) / a.d : 1;
      const p = a.kind === "flowStep" ? clamp01(raw) : smooth(raw);
      if (a.kind === "flowStep" && raw > 1) { a.mob.st.o = 0; continue; }
      KINDS[a.kind](a.mob.st, p, a);
    }
    const out = this.hold ? 1 : clamp01((this.duration - t) / 0.6);
    for (const m of this.mobs) { if (m !== this.cam) m.st.o *= out; m.apply(m.st); }
  }
}

// ---------------------------------------------------------------- the player

const PLAYER_CSS = `
:root { --serif: "Iowan Old Style", "Palatino", "Georgia", serif; --sans: -apple-system, system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif; --mono: ui-monospace, Menlo, Consolas, monospace;
  --vp-bg: #0f1014; --vp-panel: #181a20; --vp-fg: #ececec; --vp-dim: #9097a1; --vp-accent: #F7D96F; --vp-line: #2a2e36; color-scheme: dark; }
html, body { margin: 0; height: 100%; background: var(--vp-bg); color: var(--vp-fg); font-family: var(--sans); overflow: hidden; }
.vp { height: 100%; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; padding: 14px 16px 10px; gap: 12px; }
.vp-main { flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.vp-frame { position: relative; aspect-ratio: 16 / 9; width: 100%; background: var(--vp-bg); border: 1px solid var(--vp-line); border-radius: 8px; overflow: hidden; flex: none; }
.vp-stage { width: 100%; height: 100%; display: block; cursor: pointer; }
.vp-big { position: absolute; left: 50%; top: 62%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: .6em; font: 600 clamp(14px, 2.1vw, 22px)/1 var(--sans);
  color: #15161a; background: var(--vp-accent); border: 0; border-radius: 999px; padding: .75em 1.3em .75em 1.05em; cursor: pointer; box-shadow: 0 6px 30px rgba(247,217,111,.25); }
.vp-big:hover { filter: brightness(1.06); }
.vp-big svg { width: 1em; height: 1em; }
.vp-big[hidden] { display: none; }
.vp-cc { width: 100%; max-width: 1000px; text-align: center; font-family: var(--serif); font-size: clamp(15px, 0.85rem + 0.55vw, 23px); line-height: 1.38; color: #f3f3f3; text-wrap: balance; flex: none; }
.vp-bar { display: flex; flex-direction: column; gap: 8px; flex: none; }
.vp-scrub { position: relative; height: 22px; cursor: pointer; touch-action: none; }
.vp-track, .vp-fill { position: absolute; left: 0; top: 9px; height: 4px; border-radius: 2px; }
.vp-track { right: 0; background: var(--vp-line); }
.vp-fill { background: var(--vp-accent); }
.vp-tick { position: absolute; top: 3px; width: 14px; height: 16px; margin-left: -7px; padding: 0; border: 0; background: none; cursor: pointer; }
.vp-tick::after { content: ""; position: absolute; left: 6px; top: 1px; width: 2px; height: 14px; background: #5a616c; border-radius: 1px; }
.vp-knob { position: absolute; top: 4px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: var(--vp-fg); pointer-events: none; }
.vp-row { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--vp-dim); min-width: 0; }
.vp-btn { font: inherit; font-weight: 600; color: var(--vp-fg); background: var(--vp-panel); border: 1px solid var(--vp-line); border-radius: 8px; padding: 7px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; flex: none; }
.vp-btn:hover { border-color: #4a505a; }
.vp-btn svg { width: 12px; height: 12px; }
.vp-voice { margin-left: auto; }
.vp-voice[aria-pressed="false"] { color: var(--vp-dim); }
.vp-voice svg { width: 14px; height: 12px; }
.vp-time { font-variant-numeric: tabular-nums; flex: none; }
.vp-now { color: var(--vp-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vp-chaps { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
.vp-chaps::-webkit-scrollbar { display: none; }
.vp-chip { font: 13px/1 var(--sans); color: var(--vp-dim); background: none; border: 1px solid var(--vp-line); border-radius: 999px; padding: 7px 11px; cursor: pointer; white-space: nowrap; flex: none; }
.vp-chip b { color: var(--vp-fg); font-weight: 600; margin-right: 5px; }
.vp-chip[aria-current="true"] { color: #15161a; background: var(--vp-accent); border-color: var(--vp-accent); }
.vp-chip[aria-current="true"] b { color: #15161a; }
.vp-measure { position: absolute; visibility: hidden; left: 0; top: 0; }
.vp-fail { box-sizing: border-box; max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem; font: 16px/1.5 var(--sans); color: var(--vp-fg); overflow-wrap: anywhere; }
`;
const ICON_VOICE = '<svg viewBox="0 0 14 12" aria-hidden="true"><path d="M1 4 H3.5 L7 1 V11 L3.5 8 H1 Z" fill="currentColor"/><path d="M9.2 3.6 A3.4 3.4 0 0 1 9.2 8.4 M10.9 1.9 A5.8 5.8 0 0 1 10.9 10.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 14 12" aria-hidden="true"><path d="M1 4 H3.5 L7 1 V11 L3.5 8 H1 Z" fill="currentColor"/><path d="M9.3 3.8 L13 8.2 M13 3.8 L9.3 8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 L11 6 L2 11 Z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z" fill="currentColor"/></svg>';
const ICON_AGAIN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 A4.5 4.5 0 1 1 1.6 5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M0 2 L3.4 5.6 L0.2 6.2 Z" fill="currentColor"/></svg>';

class Video {
  constructor(root, o = {}) {
    this.title = o.title ?? "Explainer";
    this.wps = o.wps ?? 3; // caption reading pace in words a second
    this.pad = o.pad ?? 0.5; // a breath after each caption
    // The recorded clips, by caption (see the top of this file). Read before the scenes are built: they set the pace.
    this.voice = new Map();
    for (const a of document.querySelectorAll("audio[data-caption]")) {
      const seconds = Number(a.dataset.seconds);
      // The clip is named on the element or on a <source> in it (the app's host puts the file itself there).
      const src = a.getAttribute("src") ? a.src : a.querySelector("source[src]")?.src;
      if (src && seconds > 0) this.voice.set(a.dataset.caption, { src, seconds });
    }
    if (!document.getElementById("vp-css")) {
      const st = document.createElement("style");
      st.id = "vp-css";
      st.textContent = PLAYER_CSS;
      document.head.appendChild(st);
    }
    root.innerHTML = `<div class="vp">
  <div class="vp-main"><div class="vp-frame">
    <svg class="vp-stage" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" role="img"></svg>
    <button class="vp-big" type="button"></button>
  </div><div class="vp-cc" aria-live="off"></div></div>
  <div class="vp-bar">
    <div class="vp-scrub" role="slider" aria-label="Position" tabindex="0"><div class="vp-track"></div><div class="vp-fill"></div><div class="vp-knob"></div></div>
    <div class="vp-row"><button class="vp-btn vp-play" type="button"></button><span class="vp-time"></span><span class="vp-now"></span><button class="vp-btn vp-voice" type="button" hidden></button></div>
    <div class="vp-chaps"></div>
  </div></div>`;
    this.root = root;
    root.style.height = "100%";
    this.svg = root.querySelector(".vp-stage");
    this.svg.setAttribute("aria-label", this.title);
    this.defs = el("defs", {}, this.svg);
    const f = el("filter", { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, this.defs);
    el("feGaussianBlur", { stdDeviation: 5 }, f);
    this.world = el("g", {}, this.svg);
    this.scenes = [];
    this.chapters = [];
    this._uid = 0;
  }
  uid() { return ++this._uid; }
  /** A chapter mark at the next scene (shown on the scrub bar and as a chip). */
  part(title) { this.chapters.push({ num: String(this.chapters.length + 1), title, sceneIndex: this.scenes.length }); }
  scene(build) {
    const s = new Scene(this, this.scenes.length);
    s.chapter = this.chapters.length - 1;
    build(s);
    s.finish();
    this.scenes.push(s);
    return s;
  }
  layout() {
    let t = 0;
    this.scenes[this.scenes.length - 1].hold = true; // the last frame stays on screen
    for (const s of this.scenes) { s.start = t; t += s.duration; }
    this.total = t;
    this.segments = this.scenes.flatMap((s) => s.segments.map((g) => ({ ...g, start: g.start + s.start, end: g.end + s.start })));
    for (const c of this.chapters) c.start = this.scenes[c.sceneIndex].start;
  }
  sceneAt(t) {
    let i = this.scenes.findIndex((s) => t < s.start + s.duration);
    if (i < 0) i = this.scenes.length - 1;
    return this.scenes[i];
  }
  render(t) {
    const s = this.sceneAt(t);
    if (this.shown !== s) {
      if (this.shown) this.shown.root.style.display = "none";
      s.root.style.display = "";
      this.shown = s;
    }
    s.render(t - s.start);
  }
  segmentAt(t) { return this.segments.find((g) => t >= g.start && t < g.end) ?? null; }

  /** Lays the video out and wires the player. Call once, after the last scene. */
  start() {
    // Once: a scenes.js that starts the video itself and the page that starts it after are one start.
    if (this.started) return;
    this.started = true;
    if (this.scenes.length === 0) { fail(this.root, "This video has no scenes yet."); return; }
    this.layout();
    const V = this, q = (c) => this.root.querySelector(c);
    const frame = q(".vp-frame"), main = q(".vp-main"), cc = q(".vp-cc"), big = q(".vp-big"), playBtn = q(".vp-play");
    const bar = q(".vp-bar"), scrub = q(".vp-scrub"), fill = q(".vp-fill"), knob = q(".vp-knob"), time = q(".vp-time"), now = q(".vp-now"), chaps = q(".vp-chaps");
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    let t = 0, playing = false, last = 0;

    // The voice: one audio element speaks the clip of the caption on screen. The timeline is the clock and the clip
    // follows it, so a pause, a jump or a scrub is the timeline's alone.
    const voiceBtn = q(".vp-voice"), speaker = new Audio();
    this.speaker = speaker; // for a look from outside: V.speaker.paused, .currentTime
    let voiceOn = V.segments.some((g) => g.clip), spoken = null, primed = false;
    voiceBtn.hidden = !voiceOn;
    function hush() { if (spoken) { speaker.pause(); spoken = null; } }
    function speak() {
      const seg = playing && voiceOn ? V.segmentAt(t) : null;
      const at = seg ? t - seg.start : 0;
      // Nothing to say now: paused, switched off, a silent caption, or the breath after a clip.
      if (!seg?.clip || at >= seg.clip.seconds) { if (spoken !== seg) hush(); return; }
      if (spoken !== seg) {
        spoken = seg;
        speaker.src = seg.clip.src;
        // Picked up inside a caption (after a pause or a jump): the clip joins where the timeline is, once the
        // browser knows the clip (a time set before that is dropped by some).
        if (at > 0.15) {
          speaker.addEventListener("loadedmetadata", () => {
            if (spoken === seg) speaker.currentTime = Math.min(seg.clip.seconds, Math.max(0, t - seg.start));
          }, { once: true });
        }
        speaker.play().catch(() => {});
      } else if (!speaker.paused && Math.abs(speaker.currentTime - at) > 0.35) speaker.currentTime = at;
    }
    // A browser plays sound only from the member's own press, and some hold every later clip to that as well. A
    // caption rarely starts in the same instant as a press, so the speaker is started inside each press that plays
    // the video or switches the voice on: muted, on the first clip, and stopped again unless the timeline has a clip
    // of its own to speak by then. After that the browser lets this one element play the clips that follow.
    function prime() {
      if (primed || !voiceOn) return;
      const first = V.segments.find((g) => g.clip);
      if (!first) return;
      primed = true;
      if (spoken) return; // this press already started a clip
      speaker.muted = true;
      speaker.src = first.clip.src;
      const settle = () => { speaker.muted = false; if (!spoken) speaker.pause(); };
      speaker.play().then(settle, settle);
    }
    function voice(on) {
      voiceOn = on;
      voiceBtn.setAttribute("aria-pressed", String(on));
      voiceBtn.innerHTML = on ? `${ICON_VOICE}Voice on` : `${ICON_MUTED}Voice off`;
      hush();
      speak();
    }
    voiceBtn.onclick = () => { voice(!voiceOn); prime(); };

    const chips = this.chapters.map((c) => {
      const tick = document.createElement("button");
      tick.className = "vp-tick"; tick.type = "button";
      tick.style.left = `${(c.start / V.total) * 100}%`;
      tick.title = `${c.num}. ${c.title}`;
      tick.setAttribute("aria-label", `Chapter ${c.num}: ${c.title}`);
      tick.onpointerdown = (e) => e.stopPropagation();
      tick.onclick = () => seek(c.start + 0.01);
      scrub.appendChild(tick);
      const b = document.createElement("button");
      b.className = "vp-chip"; b.type = "button";
      b.innerHTML = `<b>${c.num}</b>`;
      b.append(c.title);
      b.onclick = () => seek(c.start + 0.01);
      chaps.appendChild(b);
      return b;
    });

    // The stage keeps 16:9 and takes what the caption and the controls leave; the caption keeps the height of the
    // longest caption at this width, so nothing jumps while it plays.
    const measure = document.createElement("div");
    measure.className = "vp-cc vp-measure";
    this.root.appendChild(measure);
    function fit() {
      measure.style.width = `${Math.min(main.clientWidth, 1000)}px`;
      let h = 0;
      for (const g of V.segments) { measure.textContent = g.text; h = Math.max(h, measure.offsetHeight); }
      cc.style.height = `${h}px`;
      // What the page leaves for the stage: its height less the padding, the caption, the controls and the gaps.
      const vp = V.root.firstElementChild, cs = getComputedStyle(vp);
      const H = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - h - 10 - 12 - bar.offsetHeight;
      const W = main.clientWidth;
      frame.style.width = `${Math.max(120, Math.min(W, (H * 16) / 9))}px`;
    }

    function draw() {
      V.render(t);
      const seg = V.segmentAt(t);
      if (cc.textContent !== (seg ? seg.text : "")) cc.textContent = seg ? seg.text : "";
      const p = (t / V.total) * 100;
      fill.style.width = `${p}%`;
      knob.style.left = `${p}%`;
      scrub.setAttribute("aria-valuetext", fmt(t));
      time.textContent = `${fmt(t)} / ${fmt(V.total)}`;
      let ci = -1;
      V.chapters.forEach((c, i) => { if (t >= c.start - 0.001) ci = i; });
      now.textContent = ci >= 0 ? V.chapters[ci].title : "";
      chips.forEach((b, i) => b.setAttribute("aria-current", String(i === ci)));
      const atEnd = t >= V.total - 0.05;
      playBtn.innerHTML = playing ? `${ICON_PAUSE}Pause` : atEnd ? `${ICON_AGAIN}Replay` : `${ICON_PLAY}Play`;
      // The big button sits on the title frame only; the last frame stays clean.
      big.hidden = playing || t >= 0.05;
      big.innerHTML = `${ICON_PLAY}Play · ${fmt(V.total)}`;
      speak();
    }
    function frameTick(nowMs) {
      if (!playing) return;
      t += Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;
      if (t >= V.total) { t = V.total; playing = false; }
      draw();
      if (playing) requestAnimationFrame(frameTick);
    }
    function play() {
      if (t >= V.total - 0.05) t = 0;
      playing = true; last = performance.now();
      draw();
      prime();
      requestAnimationFrame(frameTick);
    }
    function pause() { playing = false; draw(); }
    function seek(to) { t = Math.max(0, Math.min(V.total, to)); hush(); draw(); }
    const toggle = () => (playing ? pause() : play());

    playBtn.onclick = toggle;
    big.onclick = (e) => { e.stopPropagation(); play(); };
    this.svg.onclick = toggle;
    const at = (e) => { const r = scrub.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * V.total; };
    let dragging = false;
    scrub.onpointerdown = (e) => { dragging = true; try { scrub.setPointerCapture(e.pointerId); } catch {} seek(at(e)); };
    scrub.onpointermove = (e) => { if (dragging) seek(at(e)); };
    scrub.onpointerup = scrub.onpointercancel = () => { dragging = false; };
    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "Space" || e.key === "k") { e.preventDefault(); toggle(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); seek(t - 5); }
      else if (e.code === "ArrowRight") { e.preventDefault(); seek(t + 5); }
      else if (e.key === "m" && !voiceBtn.hidden) { voice(!voiceOn); prime(); }
    });
    // ?t=95 opens paused at 1:35 (for review stills; the app frame has no query, so this is optional).
    try {
      const qt = new URLSearchParams(location.search).get("t");
      if (qt !== null && !Number.isNaN(Number(qt))) t = Math.max(0, Math.min(V.total, Number(qt)));
    } catch {}
    if (typeof ResizeObserver === "function") new ResizeObserver(() => fit()).observe(this.root);
    window.addEventListener("resize", fit);
    fit();
    voice(voiceOn);
    draw();
    (document.fonts?.ready ?? Promise.resolve()).then(() => { window.FIT_EPOCH += 1; fit(); draw(); });
  }
}

/** Says in the page that the video can't play, in place of an empty stage: what the maker needs to see to fix it. */
function fail(root, message) {
  const note = document.createElement("p");
  note.className = "vp-fail";
  note.textContent = message;
  root.replaceChildren(note);
}
// A mistake in scenes.js stops the script that builds the video: say which, where the video would be.
window.addEventListener("error", (event) => {
  const root = document.getElementById("video");
  if (!root || root.querySelector(".vp-fail")) return;
  const where = event.lineno ? ` (line ${event.lineno})` : "";
  fail(root, `This video's script has a mistake${where}: ${event.message}`);
});

window.FIT_EPOCH = 1;
window.C = C;
window.Video = Video;
window.captionHash = captionHash;
})();
