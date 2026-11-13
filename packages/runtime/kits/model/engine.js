/* Qorpera interface kit "model": an interactive model of how a business works in numbers.
 * The agent hands in model.json (inputs, small formulas, a flow, a curve). This engine draws it:
 * sliders on the left, the one figure that matters, a waterfall from what the customer pays down to what is left,
 * and a curve of the month against volume with its break-even. Plain ES2020, one file, no libraries, no network. */
(() => {
	"use strict";
	const KIT = window.QORPERA_KIT || {};
	const D = document;
	const NS = "http://www.w3.org/2000/svg";
	const reduced = () => {
		try {
			return matchMedia("(prefers-reduced-motion: reduce)").matches;
		} catch (e) {
			return false;
		}
	};
	const isPhone = () => innerWidth < 760;

	const WORDS = {
		assumed: "assumed",
		unknown: "unknown",
		yours: "your guess",
		reset: "Reset",
		resetOne: "Reset this one",
		example: "Try an example",
		hint: "or drag the {n} hatched sliders",
		hintLast: "or drag the last hatched slider",
		known: "known",
		provisional: "provisional",
		breakEven: "Break-even",
		never: "No break-even",
		below: "at most",
		save: "Save the numbers",
		saving: "Saving…",
		saved: "Saved",
		error: "Can't compute",
		empty: "Nothing to show yet.",
	};
	const STATES = ["known", "assumed", "unknown"];
	const RANK = { known: 0, yours: 1, assumed: 2, unknown: 3 };
	const ID = /^[\p{L}_][\p{L}\p{N}_]*$/u;

	// ---------- small helpers
	const arr = (v) => (Array.isArray(v) ? v : []);
	const toNum = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
	const fin = Number.isFinite;
	const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
	const cut = (s, n) => {
		if (s == null || typeof s === "object") return "";
		const t = String(s).replace(/[ \t\r\n\f\v]+/g, " ").trim();
		return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
	};
	const safeHref = (u) => (typeof u === "string" && /^(app:|folder:|https:\/\/|#)/i.test(u.trim()) ? u.trim() : null);
	const dict = () => Object.create(null);
	function h(tag, cls, kids) {
		const e = D.createElement(tag);
		if (cls) e.className = cls;
		if (kids != null) for (const k of [].concat(kids)) if (k != null && k !== false) e.append(k);
		return e;
	}
	function sv(tag, cls, attrs) {
		const e = D.createElementNS(NS, tag);
		if (cls) e.setAttribute("class", cls);
		if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
		return e;
	}
	const decimals = (step) => {
		const s = String(step);
		if (s.includes("e-")) return Math.min(6, Number(s.split("e-")[1]));
		return Math.min(6, (s.split(".")[1] || "").length);
	};
	const niceStep = (raw) => {
		if (!(raw > 0)) return 1;
		const mag = 10 ** Math.floor(Math.log10(raw));
		const n = raw / mag;
		return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
	};
	function niceTicks(lo, hi, count) {
		if (!(hi > lo)) return [lo];
		const step = niceStep((hi - lo) / count);
		const out = [];
		for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && out.length < 20; v += step) out.push(Number(v.toFixed(10)));
		return out;
	}

	// ---------- formulas: a small safe parser and evaluator (no eval, no Function)
	const FUNCS = Object.assign(dict(), {
		min: [1, 99],
		max: [1, 99],
		round: [1, 2],
		abs: [1, 1],
		floor: [1, 1],
		ceil: [1, 1],
		clamp: [3, 3],
		if: [3, 3],
		tiers: [2, 99],
	});
	const TOK = /\s*(?:((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\p{L}_][\p{L}\p{N}_]*)|(<=|>=|==|!=|&&|\|\||[-+*/(),<>!]))/uy;
	function parse(src) {
		const text = String(src);
		const toks = [];
		let at = 0;
		while (at < text.length) {
			if (!text.slice(at).trim()) break;
			TOK.lastIndex = at;
			const m = TOK.exec(text);
			if (!m) throw new Error(`unexpected "${text.slice(at).trim()[0]}"`);
			at = TOK.lastIndex;
			toks.push(m[1] != null ? { t: "n", v: Number(m[1]) } : m[2] != null ? { t: "i", v: m[2] } : { t: "o", v: m[3] });
		}
		if (!toks.length) throw new Error("empty");
		let p = 0;
		const op = (v) => toks[p] && toks[p].t === "o" && toks[p].v === v;
		const need = (v) => {
			if (!op(v)) throw new Error(`"${v}" missing`);
			p++;
		};
		const bin = (next, ops) => () => {
			let a = next();
			while (toks[p] && toks[p].t === "o" && ops.includes(toks[p].v)) {
				const o = toks[p++].v;
				a = { k: "b", o, a, b: next() };
			}
			return a;
		};
		const prim = () => {
			const t = toks[p++];
			if (!t) throw new Error("ends too early");
			if (t.t === "n") return { k: "n", v: t.v };
			if (t.t === "i") {
				if (!op("(")) return { k: "i", n: t.v };
				p++;
				const f = t.v;
				if (!FUNCS[f]) throw new Error(`no function "${f}"`);
				const args = [];
				if (!op(")"))
					for (;;) {
						args.push(or());
						if (!op(",")) break;
						p++;
					}
				need(")");
				if (args.length < FUNCS[f][0] || args.length > FUNCS[f][1] || (f === "tiers" && args.length % 2))
					throw new Error(`${f}() takes other values`);
				return { k: "f", f, args };
			}
			if (t.v === "(") {
				const e = or();
				need(")");
				return e;
			}
			throw new Error(`unexpected "${t.v}"`);
		};
		const unary = () => {
			if (op("-")) {
				p++;
				return { k: "neg", a: unary() };
			}
			if (op("+")) {
				p++;
				return unary();
			}
			if (op("!")) {
				p++;
				return { k: "not", a: unary() };
			}
			return prim();
		};
		const mul = bin(unary, ["*", "/"]);
		const add = bin(mul, ["+", "-"]);
		const cmp = bin(add, ["<", ">", "<=", ">=", "==", "!="]);
		const and = bin(cmp, ["&&"]);
		const or = bin(and, ["||"]);
		const ast = or();
		if (p < toks.length) throw new Error(`unexpected "${toks[p].v}"`);
		return ast;
	}
	const namesIn = (n, out = new Set()) => {
		if (!n) return out;
		if (n.k === "i") out.add(n.n);
		if (n.a) namesIn(n.a, out);
		if (n.b) namesIn(n.b, out);
		if (n.args) for (const x of n.args) namesIn(x, out);
		return out;
	};
	function ev(n, get) {
		switch (n.k) {
			case "n":
				return n.v;
			case "i":
				return get(n.n);
			case "neg":
				return -ev(n.a, get);
			case "not":
				return ev(n.a, get) ? 0 : 1;
			case "f":
				return call(n.f, n.args, get);
		}
		if (n.o === "&&") return ev(n.a, get) && ev(n.b, get) ? 1 : 0;
		if (n.o === "||") return ev(n.a, get) || ev(n.b, get) ? 1 : 0;
		const a = ev(n.a, get);
		const b = ev(n.b, get);
		switch (n.o) {
			case "+":
				return a + b;
			case "-":
				return a - b;
			case "*":
				return a * b;
			case "/":
				return b === 0 ? NaN : a / b;
			case "<":
				return +(a < b);
			case ">":
				return +(a > b);
			case "<=":
				return +(a <= b);
			case ">=":
				return +(a >= b);
			case "==":
				return +(Math.abs(a - b) < 1e-9);
			case "!=":
				return +!(Math.abs(a - b) < 1e-9);
		}
		return NaN;
	}
	function call(f, A, get) {
		const e = (i) => ev(A[i], get);
		switch (f) {
			case "if":
				return e(0) ? e(1) : e(2);
			case "min":
				return Math.min(...A.map((_, i) => e(i)));
			case "max":
				return Math.max(...A.map((_, i) => e(i)));
			case "round": {
				const k = 10 ** clamp(Math.round(A.length > 1 ? e(1) : 0), -6, 6);
				return Math.round(e(0) * k) / k;
			}
			case "abs":
				return Math.abs(e(0));
			case "floor":
				return Math.floor(e(0));
			case "ceil":
				return Math.ceil(e(0));
			case "clamp":
				return Math.min(Math.max(e(0), e(1)), e(2));
			case "tiers": {
				// tiers(x, limit1, rate1, limit2, rate2, ..., rateRest): a stepped share of x.
				const x = e(0);
				let prev = 0;
				let sum = 0;
				for (let i = 1; i < A.length - 1; i += 2) {
					if (x <= prev) return sum;
					const lim = e(i);
					if (lim > prev) {
						sum += (Math.min(x, lim) - prev) * e(i + 1);
						prev = lim;
					}
				}
				return x > prev ? sum + (x - prev) * e(A.length - 1) : sum;
			}
		}
		return NaN;
	}

	// ---------- the data, made safe
	function normInput(r, M) {
		if (!r || typeof r !== "object") return null;
		if (typeof r.id !== "string" || !ID.test(r.id) || FUNCS[r.id]) {
			M.errs.push(`input “${cut(r.label || r.id, 20) || "?"}” needs an id`);
			return null;
		}
		if (M.inp[r.id]) {
			M.errs.push(`“${r.id}” is used twice`);
			return null;
		}
		const state = STATES.includes(r.state) ? r.state : "known";
		let min = toNum(r.min);
		let max = toNum(r.max);
		const v0 = toNum(state === "unknown" ? (r.start ?? r.value) : (r.value ?? r.start));
		if (!fin(min)) min = Math.min(0, fin(v0) ? v0 : 0);
		if (!fin(max) || max <= min) max = fin(v0) && v0 > min ? min + (v0 - min) * 2 : min + 100;
		let step = toNum(r.step);
		if (!(step > 0) || step > max - min) step = niceStep((max - min) / 100);
		// a slider's values are min + k × step, so they carry the decimals of both
		const dec = Math.max(decimals(step), decimals(min));
		const snap = (v) => clamp(Number((Math.round((v - min) / step) * step + min).toFixed(dec)), min, max);
		// the company's own numbers are kept exactly; only what a slider sets lands on its steps
		const fit = (v) => clamp(v, min, max);
		const v1 = fin(v0) ? (state === "unknown" ? snap(v0) : fit(v0)) : snap(min + (max - min) / 2);
		const inp = {
			id: r.id,
			label: cut(r.label || r.id, 28),
			unit: cut(r.unit, 10),
			min,
			max,
			step,
			dec,
			snap,
			fit,
			vdec: Math.max(dec, Math.min(4, decimals(v1))),
			state,
			value: v1,
			note: cut(r.note, 90),
			source: safeHref(r.source),
			marks: [],
		};
		for (const m of arr(r.marks).slice(0, 6)) {
			if (!m || typeof m !== "object") continue;
			const ast = compile(m.value, `«${inp.id}» mark`, M.errs);
			if (ast) inp.marks.push({ label: cut(m.label, 24), note: cut(m.note, 40), ast });
		}
		return inp;
	}
	// a save's key as the bridge takes it: the value of the table's key column, or {column: value} for a key of several
	// columns; null when there is none (the button adds a row), undefined when it is no key at all
	function saveKey(k) {
		const one = (v) => (typeof v === "string" && v.trim() !== "") || typeof v === "boolean" || (typeof v === "number" && fin(v));
		if (k == null) return null;
		if (typeof k !== "object") return one(k) ? (typeof k === "string" ? k.trim() : k) : undefined;
		return !Array.isArray(k) && Object.keys(k).length && Object.values(k).every(one) ? k : undefined;
	}
	function compile(src, where, errs) {
		if (typeof src === "number") return fin(src) ? { k: "n", v: src } : null;
		if (typeof src !== "string" || !src.trim()) {
			errs.push(`${where}: no value`);
			return null;
		}
		try {
			return parse(src);
		} catch (e) {
			errs.push(`${where}: ${e.message}`);
			return null;
		}
	}
	function normalize(d) {
		const errs = [];
		const lang = typeof d.lang === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(d.lang) ? d.lang : D.documentElement.lang || "en";
		const words = { ...WORDS };
		if (d.words && typeof d.words === "object")
			for (const k of Object.keys(WORDS)) if (typeof d.words[k] === "string" && d.words[k].trim()) words[k] = cut(d.words[k], 40);
		const M = {
			lang,
			words,
			title: cut(d.title, 40),
			line: cut(d.line, 60),
			unit: cut(d.unit, 8),
			source: safeHref(d.source),
			groups: [],
			inputs: [],
			inp: dict(),
			comp: dict(),
			errs,
		};
		let groups = arr(d.groups);
		if (!groups.length && Array.isArray(d.inputs)) groups = [{ inputs: d.inputs }];
		for (const g of groups.slice(0, 6)) {
			if (!g || typeof g !== "object") continue;
			const G = { label: cut(g.label, 28), inputs: [] };
			for (const r of arr(g.inputs)) {
				if (M.inputs.length >= 16) break;
				const inp = normInput(r, M);
				if (!inp) continue;
				G.inputs.push(inp);
				M.inputs.push(inp);
				M.inp[inp.id] = inp;
			}
			if (G.inputs.length) M.groups.push(G);
		}
		const comp = Array.isArray(d.computed)
			? d.computed
			: d.computed && typeof d.computed === "object"
				? Object.keys(d.computed).map((id) => ({ id, formula: d.computed[id] }))
				: [];
		for (const c of comp.slice(0, 48)) {
			if (!c || typeof c !== "object") continue;
			if (typeof c.id !== "string" || !ID.test(c.id) || M.inp[c.id] || M.comp[c.id] || FUNCS[c.id]) {
				errs.push(`“${cut(c.id, 20)}” is not a free name`);
				continue;
			}
			const ast = compile(c.formula ?? c.value, `«${c.id}»`, errs);
			M.comp[c.id] = { id: c.id, ast: ast || { k: "n", v: NaN } };
		}
		// flow
		const f = d.flow;
		if (f && typeof f === "object") {
			const from = f.from && typeof f.from === "object" ? f.from : { value: f.from };
			const fromAst = compile(from.value, "flow", errs);
			const steps = [];
			for (const s of arr(f.steps).slice(0, 10)) {
				if (!s || typeof s !== "object") continue;
				const ast = compile(s.value, `«${cut(s.label, 22)}»`, errs);
				if (ast) steps.push({ label: cut(s.label, 22), ast, state: STATES.includes(s.state) ? s.state : null });
			}
			if (fromAst && steps.length)
				M.flow = {
					from: { label: cut(from.label, 22), ast: fromAst },
					steps,
					result: cut(typeof f.result === "string" ? f.result : f.result && f.result.label, 22),
				};
		}
		// headline
		const hd = typeof d.headline === "string" ? { value: d.headline } : d.headline && typeof d.headline === "object" ? d.headline : {};
		M.head = {
			label: cut(hd.label || (M.flow && M.flow.result), 28),
			unit: cut(hd.unit ?? M.unit, 8),
			ast: hd.value != null ? compile(hd.value, "headline", errs) : null,
		};
		if (!M.head.ast && !M.flow) {
			const last = Object.keys(M.comp).pop();
			if (last) M.head.ast = { k: "i", n: last };
		}
		// curve
		const cv = d.curve;
		if (cv && typeof cv === "object") {
			if (typeof cv.x === "string" && M.inp[cv.x] && M.inp[cv.x].max > M.inp[cv.x].min) {
				const ast = compile(cv.y, "curve", errs);
				if (ast)
					M.curve = {
						x: cv.x,
						ast,
						label: cut(cv.label, 28),
						unit: cut(cv.unit ?? M.inp[cv.x].unit, 12),
						yUnit: cut(cv.yUnit ?? M.unit, 8),
					};
			} else errs.push("curve: x");
		}
		// scenarios
		M.scen = [];
		for (const s of arr(d.scenarios).slice(0, 4)) {
			if (!s || typeof s !== "object" || !s.values || typeof s.values !== "object") continue;
			const values = dict();
			for (const k of Object.keys(s.values)) if (M.inp[k] && fin(toNum(s.values[k]))) values[k] = M.inp[k].fit(toNum(s.values[k]));
			if (cut(s.label, 16) && Object.keys(values).length) M.scen.push({ label: cut(s.label, 16), values });
		}
		// save: one row, the named columns or else every input; a keyed row takes at most 12 cells (setRow's limit)
		const sv0 = d.save;
		if (sv0 && typeof sv0 === "object" && typeof sv0.table === "string" && sv0.table.trim()) {
			const key = saveKey(sv0.key);
			const named = arr(sv0.columns).filter((c) => typeof c === "string" && (M.inp[c] || M.comp[c]));
			const columns = named.length ? named : M.inputs.map((i) => i.id);
			if (key === undefined) errs.push("save: key is a value or {column: value}");
			else if (key !== null && columns.length > 12) errs.push("save: name at most 12 columns");
			else M.save = { table: sv0.table.trim(), key, columns };
		}
		// names that point nowhere, and loops
		const check = (ast, where) => {
			for (const n of namesIn(ast)) if (!M.inp[n] && !M.comp[n]) errs.push(`${where}: no “${n}”`);
		};
		for (const id in M.comp) check(M.comp[id].ast, `«${id}»`);
		for (const i of M.inputs) for (const m of i.marks) check(m.ast, `«${i.id}» mark`);
		if (M.flow) {
			check(M.flow.from.ast, "flow");
			for (const s of M.flow.steps) check(s.ast, `«${s.label}»`);
		}
		if (M.head.ast) check(M.head.ast, "headline");
		if (M.curve) check(M.curve.ast, "curve");
		const seen = dict();
		const walk = (id, path) => {
			if (seen[id] === 2) return;
			if (seen[id] === 1) {
				errs.push(`loop: ${path.slice(path.indexOf(id)).concat(id).join(" → ")}`);
				return;
			}
			seen[id] = 1;
			for (const n of namesIn(M.comp[id].ast)) if (M.comp[n]) walk(n, path.concat(id));
			seen[id] = 2;
		};
		for (const id in M.comp) walk(id, []);
		return M;
	}

	// ---------- state
	let M = null;
	let ui = null;
	const S = { values: dict(), touched: new Set(), hand: new Set() };

	function evaluator(over) {
		const memo = new Map();
		const busy = new Set();
		const inVal = (id) => (over && id in over ? over[id] : S.values[id]);
		const getter = (deps) => (name) => {
			if (M.inp[name]) {
				deps.add(name);
				return inVal(name);
			}
			if (M.comp[name]) {
				const r = getC(name);
				for (const x of r.deps) deps.add(x);
				return r.v;
			}
			return NaN;
		};
		const getC = (id) => {
			let r = memo.get(id);
			if (r) return r;
			if (busy.has(id)) return { v: NaN, deps: new Set() };
			busy.add(id);
			const deps = new Set();
			let v;
			try {
				v = ev(M.comp[id].ast, getter(deps));
			} catch (e) {
				v = NaN;
			}
			busy.delete(id);
			r = { v: fin(v) ? v : NaN, deps };
			memo.set(id, r);
			return r;
		};
		return (ast) => {
			const deps = new Set();
			let v;
			try {
				v = ev(ast, getter(deps));
			} catch (e) {
				v = NaN;
			}
			return { v: fin(v) ? v : NaN, deps };
		};
	}
	const stOf = (id) => (S.touched.has(id) ? "yours" : M.inp[id].state);
	function stateOf(deps, skip) {
		let st = "known";
		for (const id of deps) {
			if (id === skip) continue;
			const s = stOf(id);
			if (RANK[s] > RANK[st]) st = s;
		}
		return st;
	}
	const missing = (deps, skip) => [...deps].filter((id) => id !== skip && stOf(id) === "unknown");

	// ---------- numbers
	const NF = new Map();
	function fmt(v, dec) {
		if (!fin(v)) return "–";
		const k = 10 ** dec;
		let r = Math.round(v * k) / k;
		if (Object.is(r, -0) || r === 0) r = 0;
		let f = NF.get(dec);
		if (!f) {
			try {
				f = new Intl.NumberFormat(M ? M.lang : "en", { maximumFractionDigits: dec, minimumFractionDigits: 0 });
			} catch (e) {
				f = new Intl.NumberFormat("en", { maximumFractionDigits: dec });
			}
			NF.set(dec, f);
		}
		return f.format(r).replace(/^-/, "−");
	}
	const autoDec = (v) => (fin(v) && Math.abs(v) < 10 && Math.round(v) !== v ? 1 : 0);
	const ceilTo = (v, dec) => {
		const k = 10 ** dec;
		return Math.ceil(v * k - 1e-9) / k;
	};

	// ---------- motion: every drawn number eases to its target (exponential ease-out), within ~200 ms while dragging
	const A = { cur: dict(), tgt: dict(), tau: dict(), otau: dict(), raf: 0, t: 0, opening: true, openUntil: 0 };
	function target(key, v, tau, openTau) {
		const val = fin(v) ? v : 0;
		A.tgt[key] = val;
		A.tau[key] = tau;
		A.otau[key] = openTau || tau;
		if (!(key in A.cur)) A.cur[key] = A.opening && !reduced() ? 0 : val;
	}
	function kick() {
		if (!A.raf) {
			A.t = performance.now();
			A.raf = requestAnimationFrame(frame);
		}
	}
	function frame(now) {
		const dt = Math.min(64, Math.max(1, now - A.t));
		A.t = now;
		if (!A.openUntil) A.openUntil = now + 1000;
		if (A.opening && now > A.openUntil) A.opening = false;
		const rm = reduced();
		let busy = false;
		const ease = (c, tg, tau, scale) => {
			if (rm || !fin(c)) return tg;
			const d = tg - c;
			if (Math.abs(d) <= Math.max(0.01, scale * 6e-4)) return tg;
			busy = true;
			return c + d * (1 - Math.exp(-dt / tau));
		};
		for (const k in A.tgt) {
			const c = A.cur[k];
			const tg = A.tgt[k];
			A.cur[k] = ease(c, tg, A.opening ? A.otau[k] : A.tau[k], Math.max(Math.abs(tg), fin(c) ? Math.abs(c) : 0));
		}
		const C = ui && ui.curve;
		if (C && C.y && C.yT) {
			let span = 1;
			for (let i = 0; i < C.yT.length; i++) if (fin(C.yT[i])) span = Math.max(span, Math.abs(C.yT[i]));
			for (let i = 0; i < C.y.length; i++) C.y[i] = fin(C.yT[i]) ? ease(C.y[i], C.yT[i], A.opening ? 240 : 70, span) : NaN;
		}
		draw();
		if (busy || A.opening) A.raf = requestAnimationFrame(frame);
		else A.raf = 0;
	}

	// ---------- the page
	const CSS = `
body{margin:0}
.mk{--ink:color-mix(in srgb,var(--q-text) 80%,var(--q-bg));--soft:color-mix(in srgb,var(--q-text) 17%,var(--q-bg));--hatch:repeating-linear-gradient(-45deg,color-mix(in srgb,var(--q-text) 32%,transparent) 0 1.5px,transparent 1.5px 6px);--phatch:repeating-linear-gradient(-45deg,color-mix(in srgb,var(--q-accent) 52%,transparent) 0 1.5px,transparent 1.5px 6px);--pbase:color-mix(in srgb,var(--q-accent) 6%,var(--q-bg));--pale:color-mix(in srgb,var(--q-accent) 62%,var(--q-bg));--ease:cubic-bezier(.2,.7,.2,1);
box-sizing:border-box;position:relative;display:grid;grid-template-columns:minmax(0,36fr) minmax(0,64fr);grid-template-rows:auto auto minmax(0,1.2fr) minmax(0,1fr);grid-template-areas:"head head" "inputs top" "inputs flow" "inputs curve";column-gap:clamp(28px,4.8vw,72px);height:100vh;min-height:600px;padding:clamp(16px,2.6vw,36px);background:var(--q-bg);color:var(--q-text);font-family:var(--q-font);font-size:15px;line-height:1.4;-webkit-tap-highlight-color:transparent}
.mk *,.mk *::before,.mk *::after{box-sizing:border-box}
:where(.mk) button{font:inherit;color:inherit}
.mk-head{grid-area:head;min-width:0;padding-bottom:clamp(10px,2vh,20px)}
.mk-title{margin:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.mk-line{margin:2px 0 0;font-size:15px;line-height:1.4;color:var(--q-muted)}
.mk-err{margin:4px 0 0;font-size:13px;color:var(--q-muted)}
.mk-err:empty{display:none}
.mk-src{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;margin-left:2px;border-radius:6px;color:var(--q-muted);text-decoration:none;font-size:13px;vertical-align:baseline}
.mk-src:hover{color:var(--q-accent)}
.mk-tools{grid-area:head;justify-self:end;align-self:start;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end;min-width:0}
.mk-chip{appearance:none;border:0;height:40px;padding:0 16px;border-radius:999px;background:var(--q-surface);font-size:14px;font-weight:550;cursor:pointer;transition:background-color .15s,color .15s,transform .15s var(--ease)}
.mk-chip:hover{background:color-mix(in srgb,var(--q-text) 9%,var(--q-bg));transform:translateY(-1px)}
.mk-chip[aria-pressed=true]{background:var(--q-accent);color:var(--q-on-accent)}
.mk-chip.mk-plain{background:transparent;color:var(--q-muted)}
.mk-chip.mk-plain:hover{color:var(--q-text);background:var(--q-surface)}
.mk-chip.mk-save{background:var(--q-accent-soft);color:var(--q-accent)}
.mk-chip.mk-save:hover{background:color-mix(in srgb,var(--q-accent) 22%,var(--q-bg))}
.mk-chip:disabled,.mk-chip.mk-save:disabled{background:var(--q-surface);color:var(--q-muted);cursor:default;transform:none}
.mk-chip[hidden]{display:none}
.mk-reason{flex-basis:100%;text-align:right;font-size:13px;color:var(--q-muted);margin:0}
.mk-reason:empty{display:none}
.mk-inputs{grid-area:inputs;display:flex;flex-direction:column;justify-content:flex-start;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;padding:0 2px 4px;margin:0 -2px}
.mk-inputs::-webkit-scrollbar{display:none}
.mk-inputs.mk-more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 36px),transparent)}
.mk-group{display:flex;flex-direction:column;flex:none}
.mk-group+.mk-group{margin-top:clamp(6px,1.8vh,16px)}
.mk-glabel{margin:0 0 1px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--q-muted);opacity:.85}
.mk-row{position:relative;padding-top:clamp(0px,.4vh,6px);transition:opacity .2s}
.mk-row.mk-dim{opacity:.32}
.mk-rt{position:relative;z-index:4;display:flex;align-items:baseline;gap:8px;min-height:22px;pointer-events:none}
.mk-rt .mk-label,.mk-rt .mk-val{pointer-events:none}
.mk-rt button,.mk-rt a,.mk-rt .mk-noted{pointer-events:auto}
.mk-lc{display:flex;align-items:baseline;gap:8px;min-width:0;flex:0 1 auto}
.mk-label{min-width:0;flex:0 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;color:var(--q-muted);transition:color .2s}
.mk-noted{cursor:help;text-decoration:underline dotted transparent;text-underline-offset:4px;transition:color .2s,text-decoration-color .2s;border-radius:4px}
.mk-noted:hover,.mk-noted:focus-visible,.mk-noted[aria-expanded=true]{text-decoration-color:color-mix(in srgb,var(--q-text) 45%,transparent)}
.mk-row:hover .mk-label,.mk-row.mk-hot .mk-label{color:var(--q-text)}
.mk-tag{flex:none;font-size:12px;line-height:18px;padding:0 7px;border-radius:999px;border:1px dashed color-mix(in srgb,var(--q-text) 42%,var(--q-bg));color:var(--q-muted)}
.mk-mine{position:relative;flex:none;appearance:none;border:0;font-size:12px;font-weight:600;line-height:20px;padding:0 8px;border-radius:999px;background:var(--q-accent-soft);color:var(--q-accent)!important;cursor:pointer;white-space:nowrap}
.mk-mine::after{content:"";position:absolute;inset:-10px -4px}
.mk-mine i{font-style:normal;margin-left:5px;opacity:.7}
.mk-legend{display:none;flex-wrap:wrap;gap:6px 18px;margin-top:auto;padding-top:16px;font-size:13px;color:var(--q-muted)}
.mk-lg{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.mk-sw{display:inline-block;width:18px;height:6px;border-radius:3px;background:var(--ink)}
.mk-sw[data-st=assumed]{height:0;border-radius:0;background:none;border-top:2px dashed color-mix(in srgb,var(--q-text) 45%,var(--q-bg))}
.mk-sw[data-st=unknown]{height:9px;border-radius:4px;background:var(--phatch),var(--pbase)}
.mk-sw[data-st=yours]{background:var(--q-accent)}
.mk-tight .mk-tw{height:22px}.mk-tight .mk-rt{min-height:20px}.mk-tight .mk-row{padding-top:1px}.mk-tight .mk-group+.mk-group{margin-top:8px}
.mk-mine:hover i{opacity:1}
.mk-tag[hidden],.mk-mine[hidden]{display:none}
.mk-val{margin-left:auto;flex:none;font-size:18px;font-weight:620;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.mk-val small{margin-left:4px;font-size:13px;font-weight:500;letter-spacing:0;color:var(--q-muted)}
.mk-row[data-st=unknown] .mk-val b{color:var(--pale);font-weight:600}
.mk-row[data-st=yours] .mk-val b{color:var(--q-accent)}
.mk-tw{position:relative;height:25px}
.mk-range{position:absolute;z-index:1;left:0;right:0;top:-9px;bottom:-7px;width:100%;height:auto;margin:0;padding:0;opacity:0;cursor:pointer;-webkit-appearance:none;appearance:none;background:transparent;touch-action:pan-y}
.mk-range::-webkit-slider-runnable-track{height:100%;background:transparent;border:0}
.mk-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:44px;border:0;background:transparent}
.mk-range::-moz-range-thumb{width:20px;height:44px;border:0;background:transparent}
.mk-range::-moz-range-track{background:transparent}
.mk-track{position:absolute;left:0;right:0;top:50%;height:6px;margin-top:-3px;border-radius:3px;background:var(--q-line);pointer-events:none}
.mk-fill{position:absolute;left:0;top:0;bottom:0;width:calc(10px + var(--r,0) * (100% - 20px));border-radius:inherit;background:var(--ink)}
.mk-thumb{position:absolute;z-index:3;top:50%;left:calc(10px + var(--r,0) * (100% - 20px));width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 3px var(--q-bg);pointer-events:none;transition:transform .18s var(--ease),background-color .25s,box-shadow .25s}
.mk-row:hover .mk-thumb,.mk-row.mk-hot .mk-thumb{transform:scale(1.14)}
.mk-range:active~.mk-thumb{transform:scale(1.24)}
.mk-range:focus-visible~.mk-thumb{outline:2px solid var(--q-accent);outline-offset:3px}
.mk-row[data-st=yours] .mk-fill,.mk-row[data-st=yours] .mk-thumb{background:var(--q-accent)}
.mk-row[data-st=assumed] .mk-track{height:0;margin-top:-1px;border-radius:0;background:none;border-top:2px dashed color-mix(in srgb,var(--q-text) 36%,var(--q-bg))}
.mk-row[data-st=assumed] .mk-fill,.mk-row[data-st=unknown] .mk-fill{display:none}
.mk-row[data-st=assumed] .mk-thumb{background:var(--q-bg);box-shadow:inset 0 0 0 2px var(--ink),0 0 0 3px var(--q-bg)}
.mk-row[data-st=unknown] .mk-track{height:10px;margin-top:-5px;border-radius:5px;background:var(--phatch),var(--pbase)}
.mk-row[data-st=unknown] .mk-thumb{background:var(--q-bg);box-shadow:inset 0 0 0 2px var(--pale),0 0 0 3px var(--q-bg)}
.mk-row[data-st=unknown]:hover .mk-thumb,.mk-row[data-st=unknown].mk-hot .mk-thumb{box-shadow:inset 0 0 0 2px var(--q-accent),0 0 0 3px var(--q-bg)}
.mk-glide .mk-thumb,.mk-glide .mk-fill,.mk-glide .mk-mark{transition:left .6s var(--ease),width .6s var(--ease),transform .18s var(--ease)}
.mk-mark{position:absolute;z-index:2;top:50%;left:calc(10px + var(--r,0) * (100% - 20px));width:16px;height:24px;margin:-6px 0 0 -8px;padding:0;border:0;background:none;cursor:pointer}
.mk-mark::before{content:"";position:absolute;left:7px;top:12px;width:2px;height:9px;border-radius:1px;background:var(--ink);transform-origin:50% 0;transition:background-color .15s,transform .15s var(--ease)}
.mk-mark[data-st=assumed]::before{background:linear-gradient(var(--ink) 0 3.5px,transparent 3.5px 5.5px,var(--ink) 5.5px)}
.mk-mark:hover::before,.mk-mark:focus-visible::before{background:var(--q-accent);box-shadow:none;transform:scaleY(1.3)}
.mk-mark:focus-visible{outline:none}
.mk-tip{position:fixed;z-index:60;left:0;top:0;max-width:300px;padding:7px 11px;border-radius:12px;background:var(--q-bg);border:1px solid var(--q-line);box-shadow:0 8px 28px color-mix(in srgb,var(--q-text) 14%,transparent);font:13px/1.4 var(--q-font);color:var(--q-text);pointer-events:none;opacity:0;transform:translate(-50%,calc(-100% - 8px));transition:opacity .14s}
.mk-tip.mk-on{opacity:1}
.mk-tip.mk-note{transform:translate(0,6px);font-size:14px}
.mk-tip b{font-weight:620;font-variant-numeric:tabular-nums}
.mk-tip span{display:block;color:var(--q-muted)}
.mk-top{grid-area:top;display:flex;align-items:flex-end;gap:0 24px;min-width:0}
.mk-hl{min-width:0}
.mk-hl-label,.mk-be-label{display:flex;align-items:center;gap:8px;min-height:22px;font-size:14px;color:var(--q-muted);white-space:nowrap}
.mk-be-label{justify-content:flex-end}
.mk-hl-fig{display:flex;align-items:baseline;font-size:clamp(44px,7vw,96px);font-weight:650;letter-spacing:-.03em;line-height:1.04;font-variant-numeric:tabular-nums;white-space:nowrap}
.mk-hl-num{transition:color .3s}
.mk-hl[data-sign=pos] .mk-hl-num{color:var(--q-good)}
.mk-hl[data-sign=neg] .mk-hl-num{color:var(--q-bad)}
.mk-hl-unit{margin-left:.2em;font-size:.34em;font-weight:600;letter-spacing:0;color:var(--q-muted)}
.mk-hl[data-st=unknown] .mk-hl-num{color:transparent;background:repeating-linear-gradient(-45deg,var(--q-accent) 0 2px,color-mix(in srgb,var(--q-accent) 34%,var(--q-bg)) 2px 4.5px);-webkit-background-clip:text;background-clip:text}
.mk-ptag{border-color:var(--pale);color:var(--q-accent)}
.mk-tag[hidden]{display:none}
.mk-go{align-self:flex-end;display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:0 0 clamp(4px,1vw,12px) clamp(0px,1vw,10px);letter-spacing:0;line-height:1.3}
.mk-go[hidden]{display:none}
.mk-gobtn{appearance:none;border:0;height:46px;padding:0 22px;border-radius:999px;background:var(--q-accent);color:var(--q-on-accent)!important;font-size:15px;font-weight:620;cursor:pointer;white-space:nowrap;box-shadow:0 6px 20px color-mix(in srgb,var(--q-accent) 30%,transparent);transition:transform .18s var(--ease),box-shadow .18s,filter .18s}
.mk-gobtn:hover{transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 10px 26px color-mix(in srgb,var(--q-accent) 36%,transparent)}
.mk-gobtn:active{transform:translateY(0) scale(.98)}
.mk-gobtn:focus-visible{outline:2px solid var(--q-accent);outline-offset:3px}
.mk-hint{appearance:none;border:0;background:none;margin:0;padding:4px 2px;font-size:13px;font-weight:500;color:var(--q-muted);cursor:pointer;white-space:nowrap}
.mk-hint:hover{color:var(--q-text)}
.mk-be{flex:none;margin-left:auto;text-align:right}
.mk-be[hidden]{display:none}
.mk-be-fig{font-size:clamp(24px,2.6vw,32px);font-weight:650;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap}
.mk-be-fig small{margin-left:5px;font-size:14px;font-weight:550;letter-spacing:0;color:var(--q-muted)}
.mk-be-fig.mk-never{font-size:clamp(18px,1.8vw,22px);color:var(--q-bad)}
.mk-be-fig.mk-prov,.mk-be-fig.mk-prov.mk-never{color:var(--pale)}
.mk-flow{grid-area:flow;position:relative;min-height:170px;margin-top:clamp(10px,3vh,30px)}
.mk-wf-zero{position:absolute;left:0;right:0;height:1px;background:color-mix(in srgb,var(--q-text) 28%,var(--q-bg));pointer-events:none}
.mk-flow[data-o=v] .mk-wf-zero{width:1px;height:auto;top:0;bottom:0;right:auto}
.mk-wf-bar{position:absolute;border-radius:3px;background:var(--soft);pointer-events:none;transition:opacity .2s,background-color .3s,filter .2s}
.mk-wf-bar[data-k=from]{background:var(--q-accent)}
.mk-wf-bar[data-k=step][data-sign=up]{background:color-mix(in srgb,var(--q-good) 45%,var(--q-bg))}
.mk-wf-bar[data-k=res][data-sign=pos]{background:var(--q-good)}
.mk-wf-bar[data-k=res][data-sign=neg]{background:var(--q-bad)}
.mk-wf-bar[data-st=assumed]{background:color-mix(in srgb,var(--q-text) 6%,var(--q-bg));border:1.5px dashed color-mix(in srgb,var(--q-text) 48%,var(--q-bg))}
.mk-wf-bar[data-k=from][data-st=assumed]{background:color-mix(in srgb,var(--q-accent) 12%,var(--q-bg));border-color:var(--q-accent)}
.mk-wf-bar[data-st=unknown]{background:var(--phatch),var(--pbase);border:0}
.mk-wf-bar[data-k=from][data-st=unknown]{background:repeating-linear-gradient(-45deg,color-mix(in srgb,var(--q-accent) 72%,transparent) 0 1.5px,transparent 1.5px 6px),color-mix(in srgb,var(--q-accent) 12%,var(--q-bg))}
.mk-wf-bar.mk-hot{filter:brightness(1.06);box-shadow:0 0 0 2px var(--q-bg),0 0 0 3.5px color-mix(in srgb,var(--q-accent) 70%,var(--q-bg))}
.mk-wf-amt{position:absolute;padding:0 4px;border-radius:4px;background:var(--q-bg);font-size:13px;font-weight:620;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;transform:translate(-50%,-100%);pointer-events:none;transition:opacity .2s,color .3s}
.mk-wf-amt.mk-below{transform:translate(-50%,0)}
.mk-wf-amt[data-k=res]{font-size:14px}
.mk-wf-amt[data-k=res][data-sign=pos]{color:var(--q-good)}
.mk-wf-amt[data-k=res][data-sign=neg]{color:var(--q-bad)}
.mk-wf-amt[data-st=unknown]{color:var(--pale)!important}
.mk-wf-name{position:absolute;overflow:hidden;overflow-wrap:normal;word-break:normal;hyphens:manual;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13px;line-height:1.25;text-align:center;color:var(--q-muted);transform:translateX(-50%);pointer-events:none;transition:opacity .2s,color .2s}
.mk-wf-name.mk-hot{color:var(--q-text)}
.mk-wf-link{position:absolute;height:0;border-top:1px dashed color-mix(in srgb,var(--q-text) 32%,var(--q-bg));pointer-events:none}
.mk-flow[data-o=v] .mk-wf-link{width:0;border-top:0;border-left:1px dashed color-mix(in srgb,var(--q-text) 32%,var(--q-bg))}
.mk-flow[data-o=v] .mk-wf-name{z-index:1;transform:none;text-align:left;-webkit-line-clamp:1;white-space:nowrap;display:block;text-overflow:ellipsis;width:auto!important;max-width:64%;padding-right:8px;background:var(--q-bg)}
.mk-flow[data-o=v] .mk-wf-amt{z-index:1;transform:translateX(-100%);padding:0 0 0 8px;border-radius:0}
.mk-wf-hit{position:absolute;z-index:2;cursor:pointer;border-radius:8px}
.mk-flow .mk-dim{opacity:.26}
.mk-curve{grid-area:curve;position:relative;display:flex;flex-direction:column;min-height:150px;margin-top:clamp(14px,3.4vh,34px)}
.mk-cv-head{display:flex;justify-content:space-between;gap:12px;min-height:20px;font-size:13px;color:var(--q-muted)}
.mk-cv-box{position:relative;flex:1;min-height:0}
.mk-cv-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;touch-action:pan-y;cursor:ew-resize;outline:none;user-select:none;-webkit-user-select:none}
.mk-cv-svg:focus-visible{outline:2px solid var(--q-accent);outline-offset:6px;border-radius:8px}
.mk-cv-grid{stroke:var(--q-line);stroke-width:1}
.mk-cv-zero{stroke:color-mix(in srgb,var(--q-text) 42%,var(--q-bg));stroke-width:1}
.mk-cv-t{fill:var(--q-muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.mk-cv-up{fill:color-mix(in srgb,var(--q-good) 17%,transparent)}
.mk-cv-dn{fill:color-mix(in srgb,var(--q-bad) 14%,transparent)}
.mk-cv-lu,.mk-cv-ld{fill:none;stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}
.mk-cv-lu{stroke:var(--q-good)}
.mk-cv-ld{stroke:var(--q-bad)}
.mk-cv-phr{fill:color-mix(in srgb,var(--q-accent) 40%,transparent)}
.mk-curve[data-st=unknown] .mk-cv-up,.mk-curve[data-st=unknown] .mk-cv-dn{fill:url(#mk-ph)}
.mk-curve[data-st=unknown] .mk-cv-lu,.mk-curve[data-st=unknown] .mk-cv-ld{stroke:var(--pale);stroke-dasharray:6 5;stroke-width:2}
.mk-curve[data-st=unknown] .mk-cv-bed{stroke:var(--pale)}
.mk-curve[data-st=unknown] .mk-cv-bel,.mk-curve[data-st=unknown] .mk-cv-dl{fill:var(--pale)}
.mk-curve[data-st=unknown] .mk-cv-bev{stroke:color-mix(in srgb,var(--q-accent) 35%,var(--q-bg))}
.mk-cv-bed{fill:var(--q-bg);stroke:var(--q-text);stroke-width:2}
.mk-cv-bel{fill:var(--q-text);font-size:13px;font-weight:620;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:var(--q-bg);stroke-width:5px;stroke-linejoin:round}
.mk-cv-bev{stroke:color-mix(in srgb,var(--q-text) 30%,var(--q-bg));stroke-dasharray:2 3}
.mk-cv-dot{fill:var(--q-accent);stroke:var(--q-bg);stroke-width:3;transition:r .18s var(--ease)}
.mk-curve[data-x=unknown] .mk-cv-dot{fill:var(--q-bg);stroke:var(--pale);stroke-width:2.5}
.mk-cv-drop{stroke:color-mix(in srgb,var(--q-accent) 55%,var(--q-bg));stroke-dasharray:2 3}
.mk-cv-dl{fill:var(--q-text);font-size:13px;font-weight:620;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:var(--q-bg);stroke-width:5px;stroke-linejoin:round}
.mk-cv-dl tspan.mk-m{fill:var(--q-muted);font-weight:500}
.mk-cv-hv{stroke:color-mix(in srgb,var(--q-text) 26%,var(--q-bg))}
.mk-cv-hl{fill:var(--q-muted);font-size:12.5px;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:var(--q-bg);stroke-width:5px}
.mk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mk-quiet{margin:0;padding:clamp(16px,2.6vw,36px);font:15px/1.5 var(--q-font);color:var(--q-muted)}
@keyframes mk-in{from{opacity:0;transform:translateY(8px)}}
.mk-head,.mk-top,.mk-tools,.mk-curve,.mk-row{animation:mk-in .75s var(--ease) both}
.mk-row{animation-delay:calc(var(--i,0) * 40ms)}
.mk-top{animation-delay:.08s}.mk-curve{animation-delay:.2s}
@media (min-width:1100px){
.mk{grid-template-columns:minmax(0,39fr) minmax(0,61fr)}
.mk-group+.mk-group{margin-top:clamp(10px,2.6vh,24px)}
.mk-glabel{margin-bottom:2px}
.mk-row{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(100px,1fr) var(--vw,92px) 20px;align-items:center;column-gap:12px;padding-top:0;min-height:clamp(38px,5.4vh,46px)}
.mk-rt{display:contents}
.mk-lc{grid-column:1;grid-row:1;display:block;max-height:2.6em;overflow:hidden;line-height:1.25;text-wrap:balance}
.mk-lc .mk-label{display:inline;white-space:normal;overflow:visible}
.mk-lc .mk-src{min-height:0;min-width:16px;margin-left:1px;vertical-align:baseline}
.mk-tw{grid-column:2;grid-row:1;height:40px!important}
.mk-range{top:0;bottom:0}
.mk-val{grid-column:3;grid-row:1;margin:0;text-align:right;font-size:17px}
.mk-mine{grid-column:4;grid-row:1;justify-self:center;width:22px;height:22px;padding:0;border-radius:50%;background:none;color:var(--q-muted)!important;font-size:14px;line-height:22px}
.mk-mine:hover{background:var(--q-accent-soft);color:var(--q-accent)!important}
.mk-mine span{display:none}
.mk-mine i{margin:0;opacity:1}
.mk-row .mk-tag{display:none}
.mk-legend{display:flex}
}
@media (max-width:759px){
.mk-tw{height:30px}
.mk{grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-template-areas:"head" "top" "flow" "tools" "inputs" "curve";height:auto;min-height:100vh}
.mk-tools{grid-area:tools}
.mk-head{padding-right:0!important}
.mk-head{padding-bottom:18px}
.mk-tools{justify-self:stretch;justify-content:flex-start;margin:22px 0 4px}
.mk-reason{text-align:left}
.mk-inputs{overflow:visible;margin:0;padding:0}
.mk-group+.mk-group{margin-top:22px}
.mk-row{padding-top:8px}
.mk-glabel,.mk-tag,.mk-mine,.mk-cv-t,.mk-cv-hl{font-size:13px}
.mk-flow{min-height:0;margin-top:20px}
.mk-curve{height:250px;flex:none;margin-top:34px}
.mk-top{gap:12px}
.mk-hl-fig{font-size:clamp(44px,13vw,64px)}
.mk-top{flex-wrap:wrap}
.mk-go{order:3;flex-basis:100%;margin:14px 0 0}
.mk-be-fig{font-size:22px}
}
@media (prefers-reduced-motion:reduce){.mk *,.mk{animation:none!important;transition:none!important}}
`;

	function injectStyle() {
		if (D.getElementById("mk-style")) return;
		const st = h("style");
		st.id = "mk-style";
		st.textContent = CSS;
		D.head.append(st);
	}
	function srcLink(href) {
		const a = h("a", "mk-src", "↗");
		a.href = href;
		a.setAttribute("aria-label", "↗");
		if (/^https:/i.test(href)) {
			a.target = "_blank";
			a.rel = "noopener";
		}
		return a;
	}
	function quiet(text) {
		if (ui) return;
		injectStyle();
		for (const e of D.querySelectorAll("body > .mk-quiet")) e.remove();
		D.body.append(h("p", "mk-quiet", text || (/^da\b/.test(D.documentElement.lang) ? "Intet at vise endnu." : WORDS.empty)));
	}

	function build() {
		for (const e of D.querySelectorAll("body > .mk, body > .mk-quiet, body > .mk-tip")) e.remove();
		injectStyle();
		NF.clear();
		const W = M.words;
		const root = h("main", "mk");
		root.lang = M.lang;
		ui = { root, rows: [], W, hl: null };
		// head
		ui.err = h("p", "mk-err");
		const line = M.line || M.source ? h("p", "mk-line", [M.line || null, M.source ? srcLink(M.source) : null]) : null;
		const head = h("header", "mk-head", [h("h1", "mk-title", M.title || D.title || ""), line, ui.err]);
		// tools: scenarios, reset, save
		const tools = h("div", "mk-tools");
		ui.chips = M.scen.map((sc) => {
			const b = h("button", "mk-chip", sc.label);
			b.type = "button";
			b.setAttribute("aria-pressed", "false");
			b.addEventListener("click", () => applyScenario(sc));
			tools.append(b);
			return b;
		});
		ui.reset = h("button", "mk-chip mk-plain", W.reset);
		ui.reset.type = "button";
		ui.reset.hidden = true;
		ui.reset.addEventListener("click", resetAll);
		tools.append(ui.reset);
		if (M.save && window.qorpera && typeof qorpera[M.save.key === null ? "addRow" : "setRow"] === "function") {
			ui.save = h("button", "mk-chip mk-save", W.save);
			ui.save.type = "button";
			ui.save.addEventListener("click", save);
			ui.reason = h("p", "mk-reason");
			ui.reason.setAttribute("role", "status");
			tools.append(ui.save, ui.reason);
		}
		// inputs
		const inputs = h("section", "mk-inputs");
		let i = 0;
		for (const g of M.groups) {
			const box = h("div", "mk-group", g.label ? h("p", "mk-glabel", g.label) : null);
			for (const inp of g.inputs) box.append(buildRow(inp, i++));
			inputs.append(box);
		}
		const present = new Set(M.inputs.map((x) => x.state));
		present.add("yours");
		const legend = h(
			"div",
			"mk-legend",
			["known", "assumed", "unknown", "yours"].filter((k) => present.has(k)).map((k) => {
				const sw = h("i", "mk-sw");
				sw.dataset.st = k;
				return h("span", "mk-lg", [sw, k === "yours" ? W.yours : W[k]]);
			}),
		);
		legend.setAttribute("aria-hidden", "true");
		inputs.append(legend);
		const longest = Math.max(...M.inputs.map((x) => Math.max(fmt(x.max, x.dec).length, fmt(x.min, x.dec).length) * 10 + (x.unit ? x.unit.length * 7.5 + 4 : 0)));
		inputs.style.setProperty("--vw", `${Math.round(clamp(longest + 4, 56, 132))}px`);
		root.append(head, tools);
		ui.head = head;
		ui.tools = tools;
		ui.inputs = inputs;
		inputs.addEventListener("scroll", () => inputs.classList.toggle("mk-more", inputs.scrollTop + inputs.clientHeight < inputs.scrollHeight - 2), { passive: true });
		// the hero comes first in reading order (the grid places it on the right)
		buildTop(root);
		if (M.flow) buildFlow(root);
		root.append(inputs);
		if (M.curve) buildCurve(root);
		if (!M.flow && !M.curve) root.style.gridTemplateRows = "auto auto 1fr";
		ui.live = h("p", "mk-sr");
		ui.live.setAttribute("aria-live", "polite");
		root.append(ui.live);
		ui.tip = h("div", "mk-tip");
		ui.tip.setAttribute("role", "tooltip");
		D.body.append(root, ui.tip);
		ui.err.textContent = M.errs.length ? `${W.error}: ${M.errs[0]}${M.errs.length > 1 ? ` (+${M.errs.length - 1})` : ""}` : "";
		// sizes
		const ro = new ResizeObserver(() => layout());
		if (ui.flow) ro.observe(ui.flow.box);
		if (ui.curve) ro.observe(ui.curve.box);
		ro.observe(root);
		ui.ro = ro;
		D.addEventListener("pointerdown", onDocDown, true);
		D.addEventListener("keydown", onDocKey);
		layout();
	}

	function buildRow(inp, i) {
		const W = M.words;
		const row = h("div", "mk-row");
		row.style.setProperty("--i", i);
		const r = { inp, row };
		const lab = h("span", inp.note ? "mk-label mk-noted" : "mk-label", inp.label);
		if (inp.note) {
			lab.setAttribute("role", "button");
			lab.tabIndex = 0;
			lab.setAttribute("aria-expanded", "false");
			lab.addEventListener("click", (e) => {
				e.stopPropagation();
				toggleNote(lab, inp.note);
			});
			lab.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggleNote(lab, inp.note);
				}
			});
		}
		r.tag = h("span", "mk-tag", W.assumed);
		r.mine = h("button", "mk-mine", [h("span", null, W.yours), h("i", null, "↺")]);
		r.mine.type = "button";
		r.mine.title = W.resetOne;
		r.mine.setAttribute("aria-label", `${W.yours}. ${W.resetOne}`);
		r.mine.addEventListener("click", () => {
			S.touched.delete(inp.id);
			S.hand.delete(inp.id);
			S.values[inp.id] = inp.value;
			glide();
			update();
		});
		r.num = h("b");
		r.unit = h("small", null, inp.unit);
		r.val = h("span", "mk-val", [r.num, inp.unit ? r.unit : null]);
		lab.title = inp.note ? `${inp.label} · ${inp.note}` : inp.label;
		const top = h("div", "mk-rt", [h("div", "mk-lc", [lab, r.tag, inp.source ? srcLink(inp.source) : null]), r.mine, r.val]);
		const range = h("input", "mk-range");
		range.type = "range";
		range.min = String(inp.min);
		range.max = String(inp.max);
		range.step = String(inp.step);
		range.value = String(S.values[inp.id]);
		range.setAttribute("aria-label", inp.label);
		r.range = range;
		r.tw = h("div", "mk-tw", [range, h("div", "mk-track", h("div", "mk-fill"))]);
		r.marks = inp.marks.map((m) => {
			const b = h("button", "mk-mark");
			b.type = "button";
			b.setAttribute("aria-label", m.label);
			const show = () => showTip(b, m, inp);
			b.addEventListener("pointerenter", show);
			b.addEventListener("focus", show);
			b.addEventListener("pointerleave", hideTip);
			b.addEventListener("blur", hideTip);
			b.addEventListener("click", (e) => {
				e.preventDefault();
				if (!fin(m.v)) return;
				S.values[inp.id] = inp.fit(m.v);
				S.touched.add(inp.id);
				S.hand.add(inp.id);
				glide();
				update();
				showTip(b, m, inp);
			});
			r.tw.append(b);
			return { m, b };
		});
		r.tw.append(h("div", "mk-thumb"));
		row.append(top, r.tw);
		const touch = () => {
			S.hand.add(inp.id);
			if (!S.touched.has(inp.id)) {
				S.touched.add(inp.id);
				update();
			}
		};
		range.addEventListener("input", () => {
			S.values[inp.id] = inp.snap(Number(range.value));
			S.touched.add(inp.id);
			S.hand.add(inp.id);
			update();
			if (r.marks.length) nearMark(r);
		});
		const settle = () => {
			if (!r.tipAuto) return;
			clearTimeout(r.tipT);
			r.tipT = setTimeout(() => {
				if (r.tipAuto) hideTip();
				r.tipAuto = false;
			}, 1400);
		};
		range.addEventListener("pointerup", settle);
		range.addEventListener("keyup", settle);
		range.addEventListener("blur", () => {
			if (r.tipAuto) hideTip();
			r.tipAuto = false;
		});
		range.addEventListener("pointerdown", () => {
			ui.dragging = true;
			touch();
		});
		range.addEventListener("pointerup", () => (ui.dragging = false));
		range.addEventListener("pointercancel", () => (ui.dragging = false));
		range.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				touch();
			}
		});
		const enter = () => setHL({ input: inp.id });
		const leave = () => setHL(null);
		row.addEventListener("pointerenter", enter);
		row.addEventListener("pointerleave", leave);
		range.addEventListener("focus", enter);
		range.addEventListener("blur", leave);
		ui.rows.push(r);
		return row;
	}

	function buildTop(root) {
		const W = M.words;
		const top = h("section", "mk-top");
		ui.hlTag = h("span", "mk-tag", W.assumed);
		ui.hlTag.hidden = true;
		ui.provTag = h("span", "mk-tag mk-ptag", W.provisional);
		ui.hlNum = h("span", "mk-hl-num", "");
		const open = () => M.inputs.filter((x) => stOf(x.id) === "unknown").map((x) => x.id);
		ui.goBtn = h("button", "mk-gobtn", W.example);
		ui.goBtn.type = "button";
		ui.goBtn.addEventListener("click", tryExample);
		ui.hint = h("button", "mk-hint");
		ui.hint.type = "button";
		ui.hint.addEventListener("click", () => {
			const ids = open();
			const id = (ui.miss || []).find((x) => ids.includes(x)) || ids[0];
			const r = id && ui.rows.find((x) => x.inp.id === id);
			if (r) {
				r.range.focus({ preventScroll: true });
				r.row.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
			}
		});
		for (const b of [ui.goBtn, ui.hint]) {
			b.addEventListener("pointerenter", () => setHL({ inputs: new Set(open()) }));
			b.addEventListener("pointerleave", () => setHL(null));
		}
		ui.go = h("div", "mk-go", [ui.goBtn, ui.hint]);
		const unit = M.head.unit ? h("span", "mk-hl-unit", M.head.unit) : null;
		ui.hl = h("div", "mk-hl", [h("div", "mk-hl-label", [h("span", null, M.head.label || ""), ui.hlTag, ui.provTag]), h("div", "mk-hl-fig", [ui.hlNum, unit])]);
		top.append(ui.hl, ui.go);
		if (M.curve) {
			ui.beNum = h("span", null, "");
			ui.beUnit = h("small", null, M.curve.unit);
			ui.beFig = h("div", "mk-be-fig", [ui.beNum, ui.beUnit]);
			ui.be = h("div", "mk-be", [h("div", "mk-be-label", W.breakEven), ui.beFig]);
			top.append(ui.be);
		}
		root.append(top);
	}

	function buildFlow(root) {
		const box = h("section", "mk-flow");
		box.setAttribute("role", "img");
		const F = { box, cols: [], links: [], o: "h", w: 0, h: 0 };
		F.zero = h("div", "mk-wf-zero");
		box.append(F.zero);
		const n = M.flow.steps.length + 2;
		for (let i = 0; i < n; i++) {
			const k = i === 0 ? "from" : i === n - 1 ? "res" : "step";
			const label = i === 0 ? M.flow.from.label : i === n - 1 ? M.flow.result : M.flow.steps[i - 1].label;
			const c = { i, k, deps: new Set(), st: "known", v: 0 };
			c.bar = h("div", "mk-wf-bar");
			c.amt = h("div", "mk-wf-amt");
			c.name = h("div", "mk-wf-name", label || "");
			c.hit = h("div", "mk-wf-hit");
			for (const e of [c.bar, c.amt]) e.dataset.k = k;
			c.hit.addEventListener("pointerenter", () => setHL({ col: i }));
			c.hit.addEventListener("pointerleave", () => setHL(null));
			c.hit.addEventListener("click", () => {
				const id = [...c.deps].find((d) => stOf(d) === "unknown") || [...c.deps][0];
				const r = id && ui.rows.find((x) => x.inp.id === id);
				if (r) {
					r.range.focus({ preventScroll: true });
					if (isPhone()) r.row.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
				}
			});
			box.append(c.bar, c.amt, c.name);
			F.cols.push(c);
		}
		for (let i = 0; i < n - 1; i++) {
			const l = h("div", "mk-wf-link");
			box.append(l);
			F.links.push(l);
		}
		for (const c of F.cols) box.append(c.hit);
		ui.flow = F;
		root.append(box);
	}

	function buildCurve(root) {
		const W = M.words;
		const xi = M.inp[M.curve.x];
		const box = h("div", "mk-cv-box");
		const svg = sv("svg", "mk-cv-svg", { tabindex: "0", role: "slider", "aria-label": `${M.curve.label || ""} · ${xi.label}` });
		const defs = sv("defs");
		const cu = sv("clipPath", null, { id: "mk-cu" });
		const cd = sv("clipPath", null, { id: "mk-cd" });
		const C = { box, svg, w: 0, h: 0, N: 121 };
		C.ru = sv("rect");
		C.rd = sv("rect");
		cu.append(C.ru);
		cd.append(C.rd);
		const pat = sv("pattern", null, { id: "mk-ph", width: "6", height: "6", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
		pat.append(sv("rect", "mk-cv-phr", { width: "1.5", height: "6" }));
		defs.append(cu, cd, pat);
		C.grid = sv("g");
		C.xt = sv("g");
		C.au = sv("path", "mk-cv-up", { "clip-path": "url(#mk-cu)" });
		C.ad = sv("path", "mk-cv-dn", { "clip-path": "url(#mk-cd)" });
		C.zero = sv("line", "mk-cv-zero");
		C.lu = sv("path", "mk-cv-lu", { "clip-path": "url(#mk-cu)" });
		C.ld = sv("path", "mk-cv-ld", { "clip-path": "url(#mk-cd)" });
		C.hv = sv("line", "mk-cv-hv");
		C.hl = sv("text", "mk-cv-hl");
		C.bev = sv("line", "mk-cv-bev");
		C.bed = sv("circle", "mk-cv-bed", { r: "5" });
		C.bel = sv("text", "mk-cv-bel");
		C.drop = sv("line", "mk-cv-drop");
		C.dot = sv("circle", "mk-cv-dot", { r: "7" });
		C.dl = sv("text", "mk-cv-dl");
		svg.append(defs, C.grid, C.xt, C.au, C.ad, C.zero, C.lu, C.ld, C.hv, C.hl, C.bev, C.bed, C.bel, C.drop, C.dot, C.dl);
		box.append(svg);
		const wrap = h("section", "mk-curve", [h("div", "mk-cv-head", [h("span", null, M.curve.label || ""), null]), box]);
		ui.curve = C;
		C.wrap = wrap;
		root.append(wrap);
		// drag on the curve moves the x slider; hover reads the curve
		const xAt = (e) => {
			const r = svg.getBoundingClientRect();
			return C.invX ? xi.snap(C.invX(e.clientX - r.left)) : null;
		};
		const setX = (x) => {
			if (x == null) return;
			S.values[xi.id] = x;
			S.touched.add(xi.id);
			S.hand.add(xi.id);
			C.hover = null;
			update();
		};
		let down = null;
		svg.addEventListener("pointerdown", (e) => {
			if (e.button) return;
			down = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === "touch", moved: false };
			if (!down.touch) {
				svg.setPointerCapture(e.pointerId);
				ui.dragging = true;
				setX(xAt(e));
			}
		});
		svg.addEventListener("pointermove", (e) => {
			if (down && down.id === e.pointerId) {
				if (down.touch && !down.moved) {
					if (Math.abs(e.clientX - down.x) < 6) return;
					if (Math.abs(e.clientY - down.y) > Math.abs(e.clientX - down.x)) {
						down = null;
						return;
					}
					down.moved = true;
					try {
						svg.setPointerCapture(e.pointerId);
					} catch (err) {
						/* the pointer is gone */
					}
					ui.dragging = true;
				}
				setX(xAt(e));
				return;
			}
			if (e.pointerType === "mouse") {
				C.hover = xAt(e);
				drawCurve();
			}
		});
		const end = (e) => {
			if (down && down.touch && !down.moved && e.type === "pointerup") setX(xAt(e));
			down = null;
			ui.dragging = false;
		};
		svg.addEventListener("pointerup", end);
		svg.addEventListener("pointercancel", end);
		svg.addEventListener("pointerleave", () => {
			C.hover = null;
			drawCurve();
		});
		svg.addEventListener("keydown", (e) => {
			const v = S.values[xi.id];
			const big = Math.max(xi.step, niceStep((xi.max - xi.min) / 10));
			const map = { ArrowRight: v + xi.step, ArrowUp: v + xi.step, ArrowLeft: v - xi.step, ArrowDown: v - xi.step, PageUp: v + big, PageDown: v - big, Home: xi.min, End: xi.max };
			if (!(e.key in map)) return;
			e.preventDefault();
			setX(xi.snap(map[e.key]));
		});
		svg.setAttribute("aria-valuemin", String(xi.min));
		svg.setAttribute("aria-valuemax", String(xi.max));
		void W;
	}

	// ---------- layout (sizes come from the boxes)
	function layout() {
		if (!ui) return;
		ui.head.style.paddingRight = isPhone() ? "" : `${ui.tools.offsetWidth + 24}px`;
		const inp = ui.inputs;
		ui.root.classList.remove("mk-tight");
		if (!isPhone() && inp.scrollHeight > inp.clientHeight + 2) ui.root.classList.add("mk-tight");
		inp.classList.toggle("mk-more", !isPhone() && inp.scrollHeight > inp.clientHeight + 2 && inp.scrollTop + inp.clientHeight < inp.scrollHeight - 2);
		const F = ui.flow;
		if (F) {
			const o = isPhone() ? "v" : "h";
			F.o = o;
			F.box.dataset.o = o;
			if (o === "v") F.box.style.height = `${F.cols.length * 46 + 6}px`;
			else F.box.style.height = "";
			F.w = F.box.clientWidth;
			F.h = F.box.clientHeight;
		}
		if (F && F.o === "h") {
			// names shrink a little to keep whole words, before any word is broken
			draw();
			const over = () => F.cols.some((c) => c.name.scrollWidth > c.name.clientWidth + 1);
			const size = (v) => {
				for (const c of F.cols) c.name.style.fontSize = v;
			};
			size("");
			for (const c of F.cols) c.name.style.overflowWrap = "";
			for (const fs of ["12px", "11.5px"]) {
				if (!over()) break;
				size(fs);
			}
			for (const c of F.cols) if (c.name.scrollWidth > c.name.clientWidth + 1) c.name.style.overflowWrap = "anywhere";
		} else if (F) for (const c of F.cols) c.name.style.fontSize = "";
		const C = ui.curve;
		if (C) {
			C.w = C.box.clientWidth;
			C.h = C.box.clientHeight;
			C.svg.setAttribute("viewBox", `0 0 ${Math.max(1, C.w)} ${Math.max(1, C.h)}`);
		}
		draw();
	}

	// ---------- update: compute everything from the values, then let the frames ease there
	function update() {
		if (!M || !ui) return;
		const E = evaluator();
		for (const r of ui.rows) paintRow(r, E);
		let rem = null;
		if (ui.flow) {
			const F = ui.flow;
			const fl = M.flow;
			const parts = [E(fl.from.ast), ...fl.steps.map((s) => E(s.ast))];
			const all = new Set();
			let left = parts[0].v;
			parts.forEach((p, i) => {
				if (i) left -= p.v;
				for (const d of p.deps) all.add(d);
				const c = F.cols[i];
				c.deps = p.deps;
				let st = stateOf(p.deps);
				const own = i ? fl.steps[i - 1].state : null;
				if (own && RANK[own] > RANK[st]) st = own;
				c.st = st;
				c.v = p.v;
				target(`f${i}`, p.v, 70, 180 + i * 45);
			});
			const rc = F.cols[F.cols.length - 1];
			rc.deps = all;
			rc.st = stateOf(all) === "unknown" || F.cols.some((c) => c !== rc && c.st === "unknown") ? "unknown" : "known";
			rc.v = left;
			rem = { v: left, deps: all };
			for (const c of F.cols) {
				const sign = c.st === "unknown" ? "" : c.k === "res" ? (!fin(c.v) || Math.round(c.v) === 0 ? "" : c.v > 0 ? "pos" : "neg") : c.k === "step" && c.v < 0 ? "up" : "";
				for (const e of [c.bar, c.amt]) {
					e.dataset.st = c.st;
					e.dataset.sign = sign;
				}
			}
			F.box.setAttribute(
				"aria-label",
				F.cols.map((c, i) => `${i === 0 ? M.flow.from.label : i === F.cols.length - 1 ? M.flow.result : M.flow.steps[i - 1].label}: ${c.st === "unknown" ? "?" : fmt(c.v, 0)}`).join(", "),
			);
		}
		// headline
		const hv = M.head.ast ? E(M.head.ast) : rem;
		if (hv) {
			ui.hv = hv;
			const was = ui.hst;
			ui.hst = stateOf(hv.deps);
			if (was === "unknown" && ui.hst !== "unknown") A.cur.hl = 0;
			if (!M.head.ast && rem && ui.flow.cols.some((c, i) => i < ui.flow.cols.length - 1 && c.st === "unknown")) ui.hst = "unknown";
			ui.miss = missing(hv.deps);
			target("hl", hv.v, 80, 320);
		}
		paintHead();
		if (ui.curve) computeCurve();
		// tools
		if (ui.reset.hidden !== (S.touched.size === 0)) {
			ui.reset.hidden = S.touched.size === 0;
			ui.head.style.paddingRight = isPhone() ? "" : `${ui.tools.offsetWidth + 24}px`;
		}
		if (ui.save) ui.save.disabled = S.touched.size === 0;
		for (let i = 0; i < ui.chips.length; i++) {
			const sc = M.scen[i];
			const on = Object.keys(sc.values).every((k) => S.touched.has(k) && Math.abs(S.values[k] - sc.values[k]) < 1e-9);
			ui.chips[i].setAttribute("aria-pressed", String(on));
		}
		paintHL();
		clearTimeout(ui.liveT);
		ui.liveT = setTimeout(speak, 700);
		kick();
	}

	function paintRow(r, E) {
		const inp = r.inp;
		const v = S.values[inp.id];
		const st = stOf(inp.id);
		r.row.dataset.st = st;
		r.tw.style.setProperty("--r", String(inp.max > inp.min ? (v - inp.min) / (inp.max - inp.min) : 0));
		if (r.range.value !== String(v)) r.range.value = String(v);
		r.num.textContent = st === "unknown" ? "?" : fmt(v, inp.vdec);
		r.unit.hidden = st === "unknown";
		r.tag.hidden = st !== "assumed";
		r.mine.hidden = st !== "yours";
		r.range.setAttribute("aria-valuetext", st === "unknown" ? `${M.words.unknown}` : `${fmt(v, inp.vdec)} ${inp.unit}`.trim());
		for (const mk of r.marks) {
			const res = E(mk.m.ast);
			mk.m.v = res.v;
			mk.m.st = stateOf(res.deps);
			const ok = fin(res.v) && res.v >= inp.min && res.v <= inp.max;
			mk.b.hidden = !ok;
			if (ok) mk.b.style.setProperty("--r", String((res.v - inp.min) / (inp.max - inp.min)));
			mk.b.dataset.st = mk.m.st === "assumed" ? "assumed" : "known";
		}
	}

	function paintHead() {
		const W = M.words;
		const st = ui.hst || "unknown";
		const prov = st === "unknown";
		ui.hl.dataset.st = st;
		ui.provTag.hidden = !prov;
		ui.hlTag.hidden = st !== "assumed";
		const open = M.inputs.filter((x) => stOf(x.id) === "unknown").length;
		ui.go.hidden = open === 0;
		ui.hint.textContent = open === 1 ? W.hintLast : W.hint.replace("{n}", String(open));
		const v = ui.hv ? ui.hv.v : NaN;
		ui.hl.dataset.sign = prov || !fin(v) || Math.round(v) === 0 ? "" : v > 0 ? "pos" : "neg";
	}

	function computeCurve() {
		const C = ui.curve;
		const cv = M.curve;
		const xi = M.inp[cv.x];
		const N = C.N;
		if (!C.yT) C.yT = new Float64Array(N);
		const all = new Set();
		const xs = [];
		for (let i = 0; i < N; i++) {
			const x = xi.min + (i / (N - 1)) * (xi.max - xi.min);
			const r = evaluator({ [cv.x]: x })(cv.ast);
			xs.push(x);
			C.yT[i] = r.v;
			for (const d of r.deps) all.add(d);
		}
		if (!C.y) C.y = Float64Array.from(C.yT, (v) => (A.opening && !reduced() ? 0 : v));
		C.xs = xs;
		C.deps = all;
		const was = C.st;
		C.st = stateOf(all, cv.x);
		if (was === "unknown" && C.st !== "unknown" && !reduced()) {
			C.y.fill(0);
			A.cur.dy = 0;
		}
		C.wrap.dataset.st = C.st;
		C.xKnown = stOf(cv.x) !== "unknown";
		C.wrap.dataset.x = C.xKnown ? "known" : "unknown";
		const cur = evaluator()(cv.ast);
		C.cur = cur.v;
		target("dx", S.values[cv.x], 60, 300);
		target("dy", cur.v, 70, 300);
		// break-even: the first x where the curve reaches zero, searched past the range when needed
		const f = (x) => evaluator({ [cv.x]: x })(cv.ast).v;
		const bisect = (a, b) => {
			for (let k = 0; k < 40; k++) {
				const m = (a + b) / 2;
				if (f(m) >= 0) b = m;
				else a = m;
			}
			return b;
		};
		let be = { kind: "never" };
		if (C.yT[0] >= 0) be = { kind: xi.min > 0 && C.yT[0] > 0 ? "below" : "in", x: xi.min };
		else {
			for (let i = 1; i < N; i++)
				if (C.yT[i - 1] < 0 && C.yT[i] >= 0) {
					be = { kind: "in", x: bisect(xs[i - 1], xs[i]) };
					break;
				}
			if (be.kind === "never" && fin(C.yT[N - 1]) && C.yT[N - 1] > C.yT[0]) {
				let a = xi.max;
				for (let k = 2; k <= 256; k *= 2) {
					const b = xi.min + (xi.max - xi.min) * k;
					if (f(b) >= 0) {
						be = { kind: "out", x: bisect(a, b) };
						break;
					}
					a = b;
				}
			}
		}
		C.be = be;
		if (be.x != null) target("bx", Math.min(be.x, xi.max), 70, 300);
		// the secondary figure in the top
		const W = M.words;
		if (ui.be) {
			const prov = C.st === "unknown";
			ui.beFig.classList.toggle("mk-prov", prov);
			ui.beFig.classList.toggle("mk-never", be.kind === "never");
			ui.beUnit.hidden = be.kind === "never";
			if (be.kind === "never") ui.beNum.textContent = W.never;
			else {
				const x = fmt(ceilTo(be.x, xi.dec), xi.dec);
				ui.beNum.textContent = `${be.kind === "below" ? `${W.below} ` : ""}${x}`;
			}
		}
		C.svg.setAttribute("aria-valuenow", String(S.values[cv.x]));
		C.svg.setAttribute("aria-valuetext", `${fmt(S.values[cv.x], xi.dec)} ${M.curve.unit}`.trim());
	}

	// ---------- drawing, every frame while something moves
	function draw() {
		if (!ui) return;
		if (ui.flow) drawFlow();
		if (ui.curve) drawCurve();
		if (ui.hv) {
			const t = fin(ui.hv.v) ? fmt(A.cur.hl, autoDec(ui.hv.v)) : "–";
			if (ui.hlNum.textContent !== t) ui.hlNum.textContent = t;
		}
	}

	function drawFlow() {
		const F = ui.flow;
		const W = F.w;
		const H = F.h;
		if (!W || !H) return;
		const n = F.cols.length;
		const v = [];
		for (let i = 0; i < n - 1; i++) v.push(A.cur[`f${i}`] || 0);
		const seg = [[0, v[0]]];
		let run = v[0];
		let lo = Math.min(0, run);
		let hi = Math.max(0, run);
		for (let i = 1; i < n - 1; i++) {
			const a = run;
			run -= v[i];
			seg.push([a, run]);
			lo = Math.min(lo, run);
			hi = Math.max(hi, run);
		}
		seg.push([0, run]);
		if (hi - lo < 1e-9) hi = lo + 1;
		const unit = M.unit;
		const text = (c, i) => {
			if (!fin(c.v)) return "–";
			if (i === 0) return `${fmt(v[0], autoDec(c.v))}${unit ? ` ${unit}` : ""}`;
			if (i === n - 1) return `${fmt(run, autoDec(c.v))}${unit ? ` ${unit}` : ""}`;
			return v[i] < 0 ? `+${fmt(-v[i], autoDec(c.v))}` : `−${fmt(v[i], autoDec(c.v))}`;
		};
		const px = (x) => `${Math.round(x * 10) / 10}px`;
		const put = (e, l, t, w, hh) => {
			const s = e.style;
			s.left = px(l);
			s.top = px(t);
			if (w != null) s.width = px(w);
			if (hh != null) s.height = px(hh);
		};
		if (F.o === "h") {
			const nameH = 38;
			const plotT = 26;
			const plotB = H - nameH - 24;
			const y = (val) => plotB - ((val - lo) / (hi - lo)) * (plotB - plotT);
			const colW = W / n;
			const bw = clamp(colW * 0.52, 14, 68);
			F.cols.forEach((c, i) => {
				const [a, b] = seg[i];
				const cx = colW * (i + 0.5);
				let t = y(Math.max(a, b));
				let bot = y(Math.min(a, b));
				if (bot - t < 2) {
					const m = (t + bot) / 2;
					t = m - 1;
					bot = m + 1;
				}
				put(c.bar, cx - bw / 2, t, bw, bot - t);
				const below = i === n - 1 && run < 0;
				c.amt.classList.toggle("mk-below", below);
				put(c.amt, cx, below ? bot + 5 : t - 5);
				const tx = text(c, i);
				if (c.amt.textContent !== tx) c.amt.textContent = tx;
				put(c.name, cx, H - nameH, colW - 4);
				put(c.hit, i * colW, 0, colW, H);
			});
			F.links.forEach((l, i) => {
				const lv = i === 0 ? v[0] : seg[i][1];
				put(l, colW * (i + 0.5) + bw / 2, y(lv), colW - bw, null);
				l.style.height = "0px";
			});
			put(F.zero, 0, y(0), null, null);
			F.zero.style.width = "";
			F.zero.style.height = "1px";
		} else {
			const rowH = 46;
			const x = (val) => ((val - lo) / (hi - lo)) * W;
			F.cols.forEach((c, i) => {
				const [a, b] = seg[i];
				const top = i * rowH;
				let l = x(Math.min(a, b));
				let r = x(Math.max(a, b));
				if (r - l < 2) {
					const m = (l + r) / 2;
					l = m - 1;
					r = m + 1;
				}
				put(c.bar, l, top + 24, r - l, 13);
				put(c.name, 0, top + 2, W * 0.66);
				c.name.style.fontSize = "";
				c.amt.classList.remove("mk-below");
				put(c.amt, W, top + 2);
				const tx = text(c, i);
				if (c.amt.textContent !== tx) c.amt.textContent = tx;
				put(c.hit, 0, top, W, rowH);
			});
			F.links.forEach((ln, i) => {
				const lv = i === 0 ? v[0] : seg[i][1];
				put(ln, x(lv), i * rowH + 37, null, rowH - 13);
				ln.style.width = "0px";
			});
			put(F.zero, x(0), 0, null, null);
			F.zero.style.height = "";
			F.zero.style.width = "1px";
		}
	}

	function drawCurve() {
		const C = ui.curve;
		const W = C.w;
		const H = C.h;
		if (!W || !H || !C.y) return;
		const xi = M.inp[M.curve.x];
		const N = C.y.length;
		const known = C.st !== "unknown";
		let ylo = 0;
		let yhi = 0;
		for (let i = 0; i < N; i++) {
			const y = C.y[i];
			if (fin(y)) {
				if (y < ylo) ylo = y;
				if (y > yhi) yhi = y;
			}
		}
		if (yhi - ylo < 1e-9) {
			yhi += 1;
			ylo -= 1;
		}
		const pad = (yhi - ylo) * 0.1;
		yhi += pad;
		if (ylo < 0) ylo -= pad;
		const ticks = known ? niceTicks(ylo, yhi, H < 190 ? 3 : 4) : [0];
		const labels = ticks.map((t) => fmt(t, 0));
		const gut = Math.max(...labels.map((t) => t.length)) * 7.3 + 14;
		const L = gut;
		const R = W - 4;
		const T = 8;
		const B = H - 26;
		const X = (x) => L + ((x - xi.min) / (xi.max - xi.min)) * (R - L);
		const Y = (y) => B - ((y - ylo) / (yhi - ylo)) * (B - T);
		C.invX = (px) => xi.min + clamp((px - L) / (R - L), 0, 1) * (xi.max - xi.min);

		const f1 = (v) => v.toFixed(1);
		let g = "";
		ticks.forEach((t, i) => {
			const yy = f1(Y(t));
			if (t !== 0) g += `<line class="mk-cv-grid" x1="${f1(L)}" x2="${f1(R)}" y1="${yy}" y2="${yy}"/>`;
			g += `<text class="mk-cv-t" x="${f1(L - 10)}" y="${yy}" dy="0.33em" text-anchor="end">${labels[i]}</text>`;
		});
		if (C.gk !== g) {
			C.grid.innerHTML = g;
			C.gk = g;
		}
		const xt = niceTicks(xi.min, xi.max, W < 420 ? 3 : 5);
		let gx = "";
		let stop = Infinity;
		for (let i = xt.length - 1; i >= 0; i--) {
			const t = xt[i];
			const last = i === xt.length - 1;
			const xx = X(t);
			const tx = `${fmt(t, xi.dec)}${last && M.curve.unit ? ` ${M.curve.unit}` : ""}`;
			const w = tx.length * 7;
			const anchor = last && R - xx < w / 2 + 4 ? "end" : "middle";
			const left = anchor === "end" ? R - w : xx - w / 2;
			const rightEdge = anchor === "end" ? R : xx + w / 2;
			if (rightEdge > stop - 10) continue;
			stop = left;
			gx += `<text class="mk-cv-t" x="${f1(anchor === "end" ? R : xx)}" y="${f1(B + 19)}" text-anchor="${anchor}">${esc(tx)}</text>`;
		}
		if (C.xk !== gx) {
			C.xt.innerHTML = gx;
			C.xk = gx;
		}
		const z = Y(0);
		let d = "";
		let pen = false;
		let first = null;
		let last = null;
		for (let i = 0; i < N; i++) {
			const y = C.y[i];
			if (!fin(y)) {
				pen = false;
				continue;
			}
			const xx = X(C.xs ? C.xs[i] : xi.min + (i / (N - 1)) * (xi.max - xi.min));
			d += `${pen ? "L" : "M"}${f1(xx)},${f1(Y(y))}`;
			pen = true;
			if (first == null) first = xx;
			last = xx;
		}
		C.lu.setAttribute("d", d);
		C.ld.setAttribute("d", d);
		const area = first == null ? "" : `${d}L${f1(last)},${f1(z)}L${f1(first)},${f1(z)}Z`;
		C.au.setAttribute("d", area);
		C.ad.setAttribute("d", area);
		const rect = (r, y0, y1) => {
			r.setAttribute("x", f1(L - 2));
			r.setAttribute("width", f1(R - L + 4));
			r.setAttribute("y", f1(y0));
			r.setAttribute("height", f1(Math.max(0, y1 - y0)));
		};
		rect(C.ru, T - 20, z);
		rect(C.rd, z, B + 20);
		setLine(C.zero, L, z, R, z);
		const W0 = M.words;
		// the current x: a dot that follows the slider
		const dx = X(clamp(A.cur.dx, xi.min, xi.max));
		const dy = fin(C.cur) ? Y(A.cur.dy) : z;
		C.dot.setAttribute("cx", f1(dx));
		C.dot.setAttribute("cy", f1(dy));
		setLine(C.drop, dx, dy + 8, dx, B);
		let lbl = `<tspan class="mk-m">${esc(`${fmt(S.values[xi.id], xi.dec)} ${M.curve.unit}`.trim())}</tspan>`;
		if (fin(C.cur)) lbl += `<tspan dx="8">${esc(`${C.cur > 0 ? "+" : ""}${fmt(A.cur.dy, 0)} ${M.curve.yUnit}`.trim())}</tspan>`;
		// the label goes on the open side of the line: below a rising line, above a falling one
		const at = clamp(Math.round(((A.cur.dx - xi.min) / (xi.max - xi.min)) * (N - 1)), 0, N - 1);
		const ya = C.y[Math.max(0, at - 2)];
		const yb = C.y[Math.min(N - 1, at + 2)];
		const rising = fin(ya) && fin(yb) && yb > ya;
		const right = dx < L + (R - L) * 0.6;
		let below = rising ? right : !right;
		if (!below && dy - T < 26) below = true;
		else if (below && B - dy < 30) below = false;
		const dlY = below ? dy + 24 : dy - 13;
		C.dl.setAttribute("x", f1(right ? dx + 13 : dx - 13));
		C.dl.setAttribute("y", f1(dlY));
		C.dl.setAttribute("text-anchor", right ? "start" : "end");
		if (C.dk !== lbl) {
			C.dl.innerHTML = lbl;
			C.dk = lbl;
		}
		// break-even marker
		const be = C.be || { kind: "never" };
		const showBe = be.kind !== "never" && fin(A.cur.bx);
		for (const e of [C.bev, C.bed, C.bel]) e.style.display = showBe ? "" : "none";
		if (showBe) {
			const bx = X(clamp(A.cur.bx, xi.min, xi.max));
			C.bed.setAttribute("cx", f1(bx));
			C.bed.setAttribute("cy", f1(z));
			setLine(C.bev, bx, T + 18, bx, B);
			const xv = fmt(ceilTo(be.x, xi.dec), xi.dec);
			const tx = `${be.kind === "out" ? "→ " : ""}${W0.breakEven}: ${be.kind === "below" ? `${W0.below} ` : ""}${xv} ${M.curve.unit}`.trim();
			const near = Math.abs(bx - dx) < 170 && Math.abs(dlY - (T + 12)) < 20;
			const anchor = bx > R - 110 ? "end" : bx < L + 110 ? "start" : "middle";
			C.bel.setAttribute("x", f1(anchor === "end" ? Math.min(bx + 6, R) : anchor === "start" ? Math.max(bx - 6, L) : bx));
			C.bel.setAttribute("y", f1(near ? z + 22 : T + 12));
			C.bel.setAttribute("text-anchor", anchor);
			if (C.bel.textContent !== tx) C.bel.textContent = tx;
			C.bev.style.display = near ? "none" : "";
		}
		// hover readout
		const hv = C.hover;
		const showHv = hv != null;
		C.hv.style.display = showHv ? "" : "none";
		C.hl.style.display = showHv ? "" : "none";
		if (showHv) {
			const hx = X(hv);
			const hy = evaluator({ [xi.id]: hv })(M.curve.ast).v;
			setLine(C.hv, hx, T, hx, B);
			C.hl.setAttribute("x", f1(hx + (hx > R - 140 ? -8 : 8)));
			C.hl.setAttribute("y", f1(B - 8));
			C.hl.setAttribute("text-anchor", hx > R - 140 ? "end" : "start");
			C.hl.textContent = `${fmt(hv, xi.dec)} ${M.curve.unit} · ${fin(hy) ? `${hy > 0 ? "+" : ""}${fmt(hy, 0)}` : "–"} ${M.curve.yUnit}`;
		}
	}
	const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	function setLine(l, x1, y1, x2, y2) {
		l.setAttribute("x1", x1.toFixed(1));
		l.setAttribute("y1", y1.toFixed(1));
		l.setAttribute("x2", x2.toFixed(1));
		l.setAttribute("y2", y2.toFixed(1));
	}

	// ---------- highlight: a slice and the sliders that drive it light up together
	function setHL(next) {
		if (!ui) return;
		ui.hlState = next;
		paintHL();
	}
	function paintHL() {
		const H = ui.hlState;
		const F = ui.flow;
		let rows = null;
		let cols = null;
		if (H && H.col != null && F) {
			rows = F.cols[H.col].deps;
			cols = new Set([H.col]);
		} else if (H && H.input && F) {
			const hit = F.cols.filter((c) => c.deps.has(H.input)).map((c) => c.i);
			if (hit.length) cols = new Set(hit);
		} else if (H && H.inputs) rows = H.inputs;
		for (const r of ui.rows) {
			r.row.classList.toggle("mk-dim", !!rows && rows.size > 0 && !rows.has(r.inp.id));
			r.row.classList.toggle("mk-hot", !!rows && rows.has(r.inp.id));
		}
		if (F)
			for (const c of F.cols) {
				const dim = !!cols && !cols.has(c.i);
				for (const e of [c.bar, c.amt, c.name]) e.classList.toggle("mk-dim", dim);
				c.bar.classList.toggle("mk-hot", !!cols && cols.has(c.i) && !!H && H.col != null);
				c.name.classList.toggle("mk-hot", !!cols && cols.has(c.i));
			}
	}

	// ---------- tips and notes
	function showTip(b, m, inp) {
		const t = ui.tip;
		t.classList.remove("mk-note");
		const val = fin(m.v) ? `${m.st === "assumed" ? "≈ " : ""}${fmt(m.v, inp.dec)} ${inp.unit}`.trim() : "–";
		t.replaceChildren(h("b", null, m.label), ` · ${val}`, m.note ? h("span", null, m.note) : null);
		const r = b.getBoundingClientRect();
		t.style.left = "0px";
		t.style.top = "0px";
		t.classList.add("mk-on");
		const w = t.offsetWidth;
		t.style.left = `${clamp(r.left + r.width / 2, w / 2 + 8, innerWidth - w / 2 - 8)}px`;
		t.style.top = `${r.top + 2}px`;
		ui.tipFor = b;
	}
	function hideTip() {
		if (!ui || !ui.tip) return;
		ui.tip.classList.remove("mk-on");
		if (ui.noteFor) ui.noteFor.setAttribute("aria-expanded", "false");
		ui.tipFor = null;
		ui.noteFor = null;
	}
	function toggleNote(lab, note) {
		if (ui.noteFor === lab) return hideTip();
		hideTip();
		const t = ui.tip;
		t.classList.add("mk-note");
		t.replaceChildren(note);
		const r = lab.getBoundingClientRect();
		t.style.left = "0px";
		t.classList.add("mk-on");
		const w = t.offsetWidth;
		t.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
		t.style.top = `${r.bottom}px`;
		ui.noteFor = lab;
		lab.setAttribute("aria-expanded", "true");
	}
	function onDocDown(e) {
		if (ui && ui.noteFor && !ui.noteFor.contains(e.target)) hideTip();
	}
	function onDocKey(e) {
		if (e.key === "Escape") hideTip();
	}

	// ---------- actions
	let glideT = 0;
	function glide() {
		if (reduced() || !ui) return;
		ui.root.classList.add("mk-glide");
		clearTimeout(glideT);
		glideT = setTimeout(() => ui && ui.root.classList.remove("mk-glide"), 650);
	}
	function applyScenario(sc) {
		for (const k of Object.keys(sc.values)) {
			S.values[k] = sc.values[k];
			S.touched.add(k);
		}
		glide();
		update();
	}
	function tryExample() {
		let any = false;
		for (const inp of M.inputs)
			if (stOf(inp.id) === "unknown") {
				S.values[inp.id] = inp.value;
				S.touched.add(inp.id);
				any = true;
			}
		if (!any) return;
		if (!reduced()) for (const k in A.cur) if (/^f\d+$/.test(k)) A.cur[k] = 0;
		let had = false;
		try {
			had = ui.goBtn.matches(":focus-visible");
		} catch (e) {
			had = false;
		}
		glide();
		setHL(null);
		update();
		if (had && ui.rows[0]) ui.rows[0].range.focus({ preventScroll: true });
	}
	function nearMark(r) {
		const inp = r.inp;
		const span = inp.max - inp.min;
		let best = null;
		for (const mk of r.marks) {
			if (mk.b.hidden || !fin(mk.m.v)) continue;
			const d = Math.abs(mk.m.v - S.values[inp.id]);
			if (d <= span * 0.025 && (!best || d < best.d)) best = { mk, d };
		}
		clearTimeout(r.tipT);
		if (best) {
			showTip(best.mk.b, best.mk.m, inp);
			r.tipAuto = true;
		} else if (r.tipAuto) {
			hideTip();
			r.tipAuto = false;
		}
	}
	function resetAll() {
		S.touched.clear();
		S.hand.clear();
		for (const inp of M.inputs) S.values[inp.id] = inp.value;
		glide();
		update();
	}
	async function save() {
		const W = M.words;
		const b = ui.save;
		const cols = M.save.columns;
		const E = evaluator();
		const cells = {};
		for (const c of cols) {
			if (M.inp[c]) cells[c] = stOf(c) === "unknown" ? null : S.values[c];
			else {
				const r = E({ k: "i", n: c });
				cells[c] = stateOf(r.deps) === "unknown" || !fin(r.v) ? null : Math.round(r.v * 100) / 100;
			}
		}
		b.disabled = true;
		b.textContent = W.saving;
		ui.reason.textContent = "";
		try {
			if (M.save.key !== null) await qorpera.setRow(M.save.table, M.save.key, cells);
			else await qorpera.addRow(M.save.table, cells);
			b.textContent = `${W.saved} ✓`;
			setTimeout(() => {
				if (ui && ui.save === b) b.textContent = W.save;
			}, 2400);
		} catch (e) {
			b.textContent = W.save;
			ui.reason.textContent = cut(e && e.message ? e.message : String(e || ""), 90);
		} finally {
			b.disabled = S.touched.size === 0;
		}
	}
	function speak() {
		if (!ui || !ui.live) return;
		const parts = [];
		if (ui.hv && M.head.label) parts.push(`${M.head.label}: ${ui.hst === "unknown" ? M.words.unknown : `${fmt(ui.hv.v, autoDec(ui.hv.v))} ${M.head.unit}`}`);
		if (ui.curve && ui.be) parts.push(`${M.words.breakEven}: ${ui.beNum.textContent} ${ui.curve.st === "unknown" ? "" : M.curve.unit}`.trim());
		ui.live.textContent = parts.join(". ");
	}

	// ---------- loading, and keeping up with the company folder
	let lastText = null;
	let lastLoad = 0;
	let pending = 0;
	async function load() {
		lastLoad = Date.now();
		if (ui && ui.dragging) {
			pending = setTimeout(load, 1500);
			return;
		}
		let text;
		try {
			const q = window.qorpera;
			if (!q || typeof q.read !== "function") throw new Error("no bridge");
			const raw = await q.read(`apps/${KIT.app}/${KIT.data || "model.json"}`);
			text = typeof raw === "string" ? raw : raw && (raw.text ?? (raw.content && raw.content.text) ?? raw.content);
			if (typeof text !== "string") throw new Error("no text");
		} catch (e) {
			// keep what is shown, and read again ten seconds later, until a read works
			quiet();
			clearTimeout(pending);
			pending = setTimeout(load, 10000);
			return;
		}
		if (text === lastText) return;
		let data;
		try {
			data = JSON.parse(text);
		} catch (e) {
			return quiet();
		}
		if (!data || typeof data !== "object") return quiet();
		let next;
		try {
			next = normalize(data);
		} catch (e) {
			return quiet();
		}
		if (!next.inputs.length) return quiet(next.words.empty);
		lastText = text;
		// keep what the member chose: touched values stay where they were (clamped to the new range)
		const keep = new Map();
		for (const id of S.touched) {
			const n = next.inp[id];
			const o = M && M.inp[id];
			if (n && (S.hand.has(id) || (o && o.state === n.state && o.value === n.value))) keep.set(id, S.values[id]);
		}
		const hand = new Set([...S.hand].filter((id) => keep.has(id)));
		const focused = D.activeElement && ui && ui.rows.find((r) => r.range === D.activeElement);
		S.touched = new Set();
		S.hand = hand;
		S.values = dict();
		for (const inp of next.inputs) S.values[inp.id] = inp.value;
		for (const [id, v] of keep) {
			S.values[id] = next.inp[id].fit(v);
			S.touched.add(id);
		}
		const first = !M;
		M = next;
		if (ui && ui.ro) ui.ro.disconnect();
		D.removeEventListener("pointerdown", onDocDown, true);
		D.removeEventListener("keydown", onDocKey);
		if (!first) {
			// a redraw after a change: no entry animation, values ease from where they were
			A.opening = false;
		}
		const C0 = ui && ui.curve;
		build();
		if (C0 && C0.y && ui.curve && C0.y.length === ui.curve.N) ui.curve.y = C0.y;
		update();
		if (focused) {
			const r = ui.rows.find((x) => x.inp.id === focused.inp.id);
			if (r) r.range.focus({ preventScroll: true });
		}
	}
	function changed() {
		clearTimeout(pending);
		pending = setTimeout(load, Math.max(0, lastLoad + 10000 - Date.now()));
	}
	function start() {
		load();
		try {
			if (window.qorpera && typeof qorpera.onChange === "function") qorpera.onChange(changed);
		} catch (e) {
			/* no live updates in this frame */
		}
		addEventListener("resize", () => {
			if (ui) layout();
		});
	}
	if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", start);
	else start();
})();
