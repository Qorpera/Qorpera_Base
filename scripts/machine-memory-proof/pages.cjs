// The browser half of scripts/prove-machine-memory.sh: drives the desktop's own Chromium over its debugging port with
// the image's Playwright and prints one `M {json}` line per measure. It runs inside the machine.
//
//   node pages.cjs mix LABEL             an animated page, two real sites scrolled, a video: frames a second, load times
//   node pages.cjs heavyapps             three heavy web apps, left open
//   node pages.cjs tabs LIMIT stop|past  one more tab at a time. stop: until under 300 MB of room. past: on past the
//                                        edge, until three tabs have been ended (their pages crash) or LIMIT is open
//   node pages.cjs anim MS LABEL         the animated page again, with everything open
const { chromium } = require("playwright");
const fs = require("node:fs");

const M = (o) => console.log(`M ${JSON.stringify(o)}`);
const meminfo = () => {
	const text = fs.readFileSync("/proc/meminfo", "utf8");
	const mb = (key) => Math.round(Number(text.match(new RegExp(`${key}:\\s+(\\d+)`))[1]) / 1024);
	return { availMB: mb("MemAvailable"), swapUsedMB: mb("SwapTotal") - mb("SwapFree"), roomMB: mb("MemAvailable") + mb("SwapFree") };
};
const cpu = () => {
	const p = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
	return { idle: p[3] + p[4], total: p.reduce((a, b) => a + b, 0) };
};
const busy = (a, b) => Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)));
const short = (e) => String(e?.message).split("\n")[0].slice(0, 80);
const within = (promise, ms) =>
	Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms))]);
// Frames a second of a page over `ms`, scrolling it or not: the page's own animation frames.
const fps = (page, ms, scroll) =>
	page.evaluate(
		({ ms, scroll }) =>
			new Promise((done) => {
				const t0 = performance.now();
				let last = t0;
				let n = 0;
				let worst = 0;
				const gaps = [];
				function frame(now) {
					const gap = now - last;
					last = now;
					n++;
					gaps.push(gap);
					if (gap > worst) worst = gap;
					if (scroll) window.scrollBy(0, 30);
					if (now - t0 < ms) requestAnimationFrame(frame);
					else {
						gaps.sort((a, b) => a - b);
						done({
							fps: +((n * 1000) / (now - t0)).toFixed(1),
							p95ms: Math.round(gaps[Math.floor(gaps.length * 0.95)] || 0),
							worstMs: Math.round(worst),
						});
					}
				}
				requestAnimationFrame(frame);
			}),
		{ ms, scroll },
	);
const APP = "http://127.0.0.1:8700/app.html";
const TABS = [
	"Copenhagen", "Norway", "Sweden", "Hiking", "Mountain", "Fjord", "Aarhus", "Odense", "Jutland", "Zealand", "Bornholm",
	"Funen", "Oslo", "Bergen", "Stockholm", "Gothenburg", "Helsinki", "Reykjavik", "Iceland", "Finland", "Greenland",
	"Baltic_Sea", "North_Sea", "Skagen", "Denmark", "Germany", "France", "Spain", "Italy", "Poland", "Netherlands",
	"Belgium", "Austria", "Switzerland", "Portugal", "Greece", "Ireland", "Scotland", "Wales", "England", "London",
	"Paris", "Berlin", "Madrid", "Rome", "Vienna", "Prague", "Warsaw", "Budapest", "Lisbon", "Athens", "Dublin",
	"Amsterdam", "Brussels", "Hamburg", "Munich", "Milan", "Barcelona", "Europe", "Asia", "Africa", "Australia",
	"Canada", "Japan", "India", "Brazil", "Mexico", "Egypt", "Turkey", "Atlantic_Ocean", "Pacific_Ocean", "Alps",
];

(async () => {
	const [phase, arg, label = ""] = process.argv.slice(2);
	const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
	const context = browser.contexts()[0];
	if (phase === "anim") {
		const page = await context.newPage();
		await page.bringToFront();
		await page.goto(APP, { waitUntil: "load", timeout: 30000 });
		const before = cpu();
		const frames = await fps(page, Number(arg), false);
		M({ t: "anim", label, ...frames, busyPct: busy(before, cpu()), ...meminfo() });
		await page.close();
	} else if (phase === "mix") {
		const out = { t: "mix", label: arg };
		let page = await context.newPage();
		await page.bringToFront();
		await page.goto(APP, { waitUntil: "load", timeout: 30000 });
		const before = cpu();
		const frames = await fps(page, 6000, false);
		out.animFps = frames.fps;
		out.animP95 = frames.p95ms;
		await page.close();
		for (const [name, url] of [
			["wikipedia", "https://en.wikipedia.org/wiki/Denmark"],
			["github", "https://github.com/torvalds/linux"],
		]) {
			page = await context.newPage();
			await page.bringToFront();
			const t = Date.now();
			try {
				await page.goto(url, { waitUntil: "load", timeout: 60000 });
				out[`${name}LoadMs`] = Date.now() - t;
				out[`${name}ScrollFps`] = (await fps(page, 3000, true)).fps;
			} catch (e) {
				out[`${name}Err`] = short(e);
			}
			await page.close().catch(() => {});
		}
		page = await context.newPage();
		await page.bringToFront();
		try {
			await page.goto("http://127.0.0.1:8700/video.html?src=v720.webm", { waitUntil: "load", timeout: 20000 });
			const played = await page.evaluate(
				() =>
					new Promise((done) => {
						const v = document.getElementById("v");
						v.play()
							.then(() =>
								setTimeout(() => {
									const q = v.getVideoPlaybackQuality();
									done({ frames: q.totalVideoFrames, dropped: q.droppedVideoFrames });
								}, 8000),
							)
							.catch((e) => done({ error: String(e) }));
					}),
			);
			out.videoFrames = played.frames;
			out.videoDropped = played.dropped;
		} catch (e) {
			out.videoErr = short(e);
		}
		await page.close().catch(() => {});
		out.busyPct = busy(before, cpu());
		M({ ...out, ...meminfo() });
	} else if (phase === "heavyapps") {
		for (const [name, url] of [
			["vscode.dev", "https://vscode.dev/"],
			["excalidraw", "https://excalidraw.com/"],
			["osm-edit-map", "https://www.openstreetmap.org/#map=16/55.6761/12.5683"],
		]) {
			const page = await context.newPage();
			await page.bringToFront();
			const t = Date.now();
			let loadMs = null;
			let err = null;
			let frames = {};
			try {
				await page.goto(url, { waitUntil: "load", timeout: 60000 });
				loadMs = Date.now() - t;
				await page.waitForTimeout(6000);
				frames = await fps(page, 3000, false);
			} catch (e) {
				err = short(e);
			}
			M({ t: "heavyapp", name, loadMs, ...frames, ...meminfo(), err });
		}
	} else if (phase === "tabs") {
		const limit = Math.min(Number(arg) || 24, TABS.length);
		const past = label === "past";
		const pages = [];
		let ended = 0;
		let failed = 0;
		for (const name of TABS.slice(0, limit)) {
			let page = null;
			let loadMs = null;
			let err = null;
			let frames = {};
			const t = Date.now();
			try {
				page = await within(context.newPage(), 30000);
				// A tab whose process was ended shows as a crashed page.
				page.on("crash", () => {
					ended++;
				});
				await within(page.bringToFront(), 15000);
				await page.goto(`https://en.wikipedia.org/wiki/${name}`, { waitUntil: "load", timeout: 45000 });
				loadMs = Date.now() - t;
			} catch (e) {
				err = short(e);
			}
			pages.push(page);
			if (page && !err) {
				try {
					frames = await within(fps(page, 1500, true), 20000);
				} catch (e) {
					err = short(e);
				}
			}
			M({ t: "tab", open: pages.length, loadMs, ...frames, ...meminfo(), ended, err });
			failed = err ? failed + 1 : 0;
			if (past && ended >= 3) {
				M({ t: "tabs-stop", reason: "three tabs were ended", open: pages.length, ended });
				break;
			}
			if (failed >= 4) {
				M({ t: "tabs-stop", reason: "four tabs in a row failed", open: pages.length, ended });
				break;
			}
			if (!past && meminfo().roomMB < 300) {
				M({ t: "tabs-stop", reason: "under 300 MB of room (free memory plus free swap)", open: pages.length, ended });
				break;
			}
		}
		// Coming back to the first tabs that still live: what does it cost to return to something that was pushed out?
		let back = 0;
		for (const [index, page] of pages.entries()) {
			if (!page || back >= 3) continue;
			const t = Date.now();
			try {
				await within(page.bringToFront(), 20000);
				await within(
					page.evaluate(() => document.body.innerText.length),
					30000,
				);
				const backMs = Date.now() - t;
				M({ t: "back", tab: index + 1, backMs, ...(await within(fps(page, 1500, true), 20000)), ...meminfo() });
				back++;
			} catch (e) {
				if (!/crash/i.test(String(e?.message))) {
					M({ t: "back", tab: index + 1, backMs: Date.now() - t, err: short(e) });
					back++;
				}
			}
		}
		M({ t: "tabs-end", open: pages.length, ended });
	} else throw new Error(`no such phase: ${phase}`);
	await browser.close();
})().catch((e) => {
	M({ t: "error", phase: process.argv[2], message: String(e?.message).split("\n")[0].slice(0, 160) });
	process.exit(1);
});
