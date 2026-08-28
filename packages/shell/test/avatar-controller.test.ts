import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const directory = new URL("../userland/avatars/", import.meta.url);
const code = ["motion-model.js", "motion-visuals.js", "avatar-state.js", "avatar-controller.js"]
	.map((file) => readFileSync(new URL(file, directory), "utf8"))
	.join("\n");

// Deterministic DOM/WAAPI boundary: exercise production mounts and clocks
// without launching a browser, opening an account, or starting a model.
const boundary = `
	let now = 0, sequence = 0;
	const frames = new Map(), observers = [], mediaListeners = new Map();
	const media = { matches: false, addEventListener: (name, callback) => mediaListeners.set(name, callback) };
	class Node {
		constructor(tag = 'span') {
			this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {};
			this.style = {transform:'none'}; this.handlers = new Map(); this.animations = [];
			this.clientWidth = 26; this.isConnected = true;
		}
		append(...children) { this.children.push(...children); }
		replaceChildren(...children) { this.children = children; }
		setAttribute(name, value) { this.attributes[name] = value; if (name === 'class') this.className = value; }
		getAttribute(name) { return this.attributes[name]; }
		addEventListener(name, fn) { this.handlers.set(name, fn); }
		removeEventListener(name) { this.handlers.delete(name); }
		animate(keyframes, options) {
			const animation = {
				keyframes, options, playState:'running', currentTime:0, startTime:0,
				cancel() { this.playState = 'idle'; }, pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; }
			};
			this.animations.push(animation); return animation;
		}
	}
	class Observer {
		constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
		observe(target) { this.targets.add(target); }
		unobserve(target) { this.targets.delete(target); }
	}
	const ResizeObserver = Observer, IntersectionObserver = Observer, MutationObserver = Observer;
	class Image { decode() { return Promise.resolve(); } }
	const documentListeners = new Map();
	const document = {
		hidden:false, body:new Node('body'), documentElement:{dataset:{}},
		timeline:{get currentTime() { return now; }},
		createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag),
		addEventListener: (name, callback) => documentListeners.set(name, callback)
	};
	const window = {devicePixelRatio:2, matchMedia:() => media, QORPERA_AVATAR_APPEARANCE:{
		prepare() {}, source: (id, color) => id + ':' + color
	}};
	const performance = {now: () => now};
	const getComputedStyle = node => node.style;
	const requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
	const cancelAnimationFrame = id => frames.delete(id);
	const queueMicrotask = callback => Promise.resolve().then(callback);
	function step(time) { now = time; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time); }
	function nodes(root, className) {
		return [...(root.className === className ? [root] : []), ...root.children.flatMap(child => nodes(child, className))];
	}
`;

async function evaluate<T>(script: string): Promise<T> {
	return (await runInNewContext(`${boundary}\n${code}\n(async () => {${script}})()`)) as T;
}

describe("shared production avatar controller", () => {
	it("mounts sidebar, header, and trailing activity on the same timeline without hover-driven rail motion", async () => {
		const result = await evaluate<{
			starts: number[];
			states: string[];
			dots: unknown[];
			sidebarHover: boolean;
			headerHover: boolean;
			color: string;
		}>(`
			const api = window.QORPERA_AVATARS;
			const rail = new Node(), header = new Node(), thread = new Node();
			rail.clientWidth = 50;
			api.update('company:a', {figure:'planet', color:'#2047bd', name:'Agent', requestedState:'working'});
			api.mount(rail, {key:'company:a', figure:'planet', color:'#2047bd'}, {hover:false});
			step(310);
			api.mount(header, {key:'company:a', figure:'planet', color:'#2047bd'});
			api.mount(thread, {key:'company:a', figure:'planet', color:'#2047bd'});
			const starts = [rail,header,thread].map(host => nodes(host,'motion-body')[0].animations.at(-1).startTime);
			api.update('company:a', {requestedState:'writing'});
			for (let i = 0; i < 8; i++) await Promise.resolve();
			step(1230);
			const states = [rail,header,thread].map(host => nodes(host,'motion-rig')[0].dataset.state);
			const dots = [header,thread].map(host => nodes(host,'motion-typing')[0].children.map(dot => dot.attributes));
			api.update('company:a', {color:'#ff2994'});
			step(1240);
			return {starts,states,dots,sidebarHover:rail.handlers.has('pointerenter'),headerHover:header.handlers.has('pointerenter'),
				color:nodes(thread,'motion-body')[0].children[0].src};
		`);
		expect(result.starts).toEqual([0, 0, 0]);
		expect(result.states).toEqual(["writing", "writing", "writing"]);
		expect(result.dots[0]).toEqual(result.dots[1]);
		expect(result.sidebarHover).toBe(false);
		expect(result.headerHover).toBe(true);
		expect(result.color).toBe("planet:#ff2994");
	});

	it("keeps identities independent, supports figure replacement, and releases detached animations", async () => {
		const result = await evaluate<{
			first: string;
			second: string;
			remounted: string;
			cancelled: boolean;
			observed: boolean;
		}>(`
			const api = window.QORPERA_AVATARS, first = new Node(), second = new Node();
			for (const [key,host] of [['a',first],['b',second]]) api.mount(host, {key,figure:'planet',color:'#2047bd'});
			api.update('a',{requestedState:'working'});
			step(200);
			const states = [first,second].map(host => nodes(host,'motion-rig')[0].dataset.state);
			api.update('a',{figure:'ghost',color:'#ff2994'});
			const oldBody = nodes(first,'motion-body')[0];
			first.isConnected = false;
			observers[2].callback([{removedNodes:[first]}]);
			await Promise.resolve();
			return {first:states[0],second:states[1],remounted:oldBody.children[0].src,
				cancelled:oldBody.animations.every(a => a.playState === 'idle'),observed:observers[0].targets.has(first)};
		`);
		expect(result.first).toBe("working");
		expect(result.second).toBe("still");
		expect(result.remounted).toContain("ghost");
		expect(result.cancelled).toBe(true);
		expect(result.observed).toBe(false);
	});

	it("pauses hidden pages and provides static reduced-motion typing", async () => {
		const result = await evaluate<{
			paused: boolean;
			resumed: boolean;
			noRunning: boolean;
			form: string;
			queued: number;
		}>(`
			const api = window.QORPERA_AVATARS, host = new Node();
			api.mount(host,{key:'a',figure:'rocket',color:'#f96e2d'});
			api.update('a',{requestedState:'working'});
			step(200);
			const body = nodes(host,'motion-body')[0];
			document.hidden = true; documentListeners.get('visibilitychange')();
			const paused = body.animations.every(a => a.playState === 'paused');
			step(4000);
			document.hidden = false; documentListeners.get('visibilitychange')();
			const resumed = body.animations.every(a => a.playState === 'running');
			media.matches = true; mediaListeners.get('change')();
			api.update('a',{requestedState:'writing'}); step(4100);
			return {paused,resumed,noRunning:body.animations.every(a => a.playState === 'idle'),
				form:nodes(host,'motion-rig')[0].dataset.form, queued:frames.size};
		`);
		expect(result).toEqual({ paused: true, resumed: true, noRunning: true, form: "typing", queued: 0 });
	});

	it("uses stable compact layouts for two, three, four, and overflowing membership", async () => {
		const layouts = await evaluate<number[][][]>(`return [2,3,4,7].map(window.QORPERA_AVATARS.groupLayout);`);
		expect(layouts.map((layout) => layout.length)).toEqual([2, 3, 4, 4]);
		expect(layouts[2]).toEqual(layouts[3]);
		for (const layout of layouts)
			for (const [x, y, size] of layout) {
				expect(x).toBeGreaterThanOrEqual(0);
				expect(y).toBeGreaterThanOrEqual(0);
				expect(x + size).toBeLessThanOrEqual(48);
				expect(y + size).toBeLessThanOrEqual(44);
			}
	});
});
