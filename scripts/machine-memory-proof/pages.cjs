// The browser half of scripts/prove-machine-memory.sh: drives the desktop's own Chromium over its debugging port with
// the image's Playwright and prints one `M {json}` line per measure. It runs inside the machine.
//
//   node pages.cjs mix LABEL             an animated page, two real sites scrolled, a video: frames a second, load times
//   node pages.cjs heavyapps             three heavy web apps, left open
//   node pages.cjs tabs LIMIT stop|past  one more tab at a time. stop: until under 300 MB of room. past: on past the
//                                        edge, until three tabs have been ended (their pages crash) or LIMIT is open
//   node pages.cjs anim MS LABEL         the animated page again, with everything open
//
// Its exit code is the phase's word (guest.sh's `phase` fails the proof on anything but 0):
//   0  the phase did what it is for
//   1  it did not (the reason is its `phase-failed` line)
//   3  the browser is gone: it no longer answers on its debugging port (its `browser-gone` line)
// A tab the guard ended is neither: that is what the guard is for, and the tabs phase past the edge counts on it. What
// an error on a tab means, and when the tabs phase did what it is for, is decided in verdicts.cjs.
const { chromium } = require("playwright");
const fs = require("node:fs");
const http = require("node:http");
const { tabsVerdict, whatEnded } = require("./verdicts.cjs");

const DEBUG = "http://127.0.0.1:9222";
// Each measure with its time (UTC), so it can be laid beside the probe's clicks and the guard's journal lines.
const M = (o) => console.log(`M ${JSON.stringify({ ...o, at: new Date().toISOString().slice(11, 19) })}`);
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
// Whether the browser still answers on its debugging port: the browser's main process serves it, so a browser that is
// gone answers nothing there. Three tries of 5 s: at the edge it may be slow, but a living browser is never silent.
const browserAnswers = async () => {
	for (let attempt = 0; attempt < 3; attempt++) {
		const answered = await new Promise((done) => {
			const request = http.get(`${DEBUG}/json/version`, { timeout: 5000 }, (response) => {
				response.resume();
				done(response.statusCode === 200);
			});
			request.on("timeout", () => request.destroy());
			request.on("error", () => done(false));
		});
		if (answered) return true;
		await new Promise((done) => setTimeout(done, 1000));
	}
	return false;
};
/** The phase did not do what it is for (exit 1). */
class PhaseFailed extends Error {}
/** The browser itself is gone (exit 3). */
class BrowserGone extends Error {}
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
	const browser = await chromium.connectOverCDP(DEBUG);
	const context = browser.contexts()[0];
	// A tab whose process was ended shows as a crashed page. Every page of the browser is watched, whoever opened it: the
	// heavy apps an earlier phase left open are tabs the guard may end too.
	const crashed = new Set();
	const watch = (page) => page.on("crash", () => crashed.add(page));
	for (const page of context.pages()) watch(page);
	context.on("page", watch);
	// What an error on a tab means. The browser's port is asked each time: only it tells a browser that is gone.
	const meaning = async (page, error) =>
		whatEnded({ crashed: page ? crashed.has(page) : false, message: error?.message, browserAnswers: await browserAnswers() });
	if (phase === "anim") {
		// Past the edge this page's own tab may be the one the guard ends: then once more, three times at most.
		for (let attempt = 1; ; attempt++) {
			let page = null;
			try {
				page = await context.newPage();
				await page.bringToFront();
				await page.goto(APP, { waitUntil: "load", timeout: 30000 });
				const before = cpu();
				const frames = await fps(page, Number(arg), false);
				M({ t: "anim", label, ...frames, busyPct: busy(before, cpu()), ...meminfo() });
				await page.close();
				break;
			} catch (error) {
				const kind = await meaning(page, error);
				if (kind === "browser") throw new BrowserGone(short(error));
				if (kind !== "tab") throw error;
				M({ t: "anim-ended", attempt, ...meminfo() });
				if (attempt >= 3) throw new PhaseFailed("the animated page's tab was ended three times");
			}
		}
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
			if (played.error) out.videoErr = String(played.error).slice(0, 80);
			out.videoFrames = played.frames;
			out.videoDropped = played.dropped;
		} catch (e) {
			out.videoErr = short(e);
		}
		await page.close().catch(() => {});
		out.busyPct = busy(before, cpu());
		M({ ...out, ...meminfo() });
		// Every part of the mix is a number the proof reports: one that did not run is a mix that did not end well.
		const errors = Object.keys(out).filter((key) => key.endsWith("Err"));
		if (errors.length) throw new PhaseFailed(`not every part ran: ${errors.map((key) => `${key}: ${out[key]}`).join("; ")}`);
	} else if (phase === "heavyapps") {
		// The load the next phases stand on: an app that did not open leaves the machine lighter than the proof says.
		const errors = [];
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
				errors.push(`${name}: ${err}`);
			}
			M({ t: "heavyapp", name, loadMs, ...frames, ...meminfo(), err });
		}
		if (errors.length) throw new PhaseFailed(`not every heavy app opened: ${errors.join("; ")}`);
	} else if (phase === "tabs") {
		const limit = Math.min(Number(arg) || 24, TABS.length);
		const past = label === "past";
		const pages = [];
		// Tabs that failed for another reason than being ended: these fail the phase.
		const failures = [];
		let failedInARow = 0;
		// Why the phase stopped: "limit" (every tab asked for is open), "ended" (three tabs were ended), "room" (the
		// machine is nearly full) or "failing" (four tabs in a row failed).
		let stop = "limit";
		for (const name of TABS.slice(0, limit)) {
			let page = null;
			let loadMs = null;
			let err = null;
			let frames = {};
			const t = Date.now();
			try {
				page = await within(context.newPage(), 30000);
				await within(page.bringToFront(), 15000);
				await page.goto(`https://en.wikipedia.org/wiki/${name}`, { waitUntil: "load", timeout: 45000 });
				loadMs = Date.now() - t;
				frames = await within(fps(page, 1500, true), 20000);
			} catch (error) {
				const kind = await meaning(page, error);
				if (kind === "browser") throw new BrowserGone(short(error));
				err = short(error);
				// An ended tab is what the guard is for; anything else is this tab's failure.
				if (kind === "other") failures.push(`tab ${pages.length + 1}: ${err}`);
				failedInARow = kind === "other" ? failedInARow + 1 : 0;
			}
			if (!err) failedInARow = 0;
			pages.push(page);
			const ended = crashed.size;
			M({ t: "tab", open: pages.length, loadMs, ...frames, ...meminfo(), ended, err });
			if (past && ended >= 3) {
				stop = "ended";
				M({ t: "tabs-stop", reason: "three tabs were ended", open: pages.length, ended });
				break;
			}
			if (failedInARow >= 4) {
				stop = "failing";
				M({ t: "tabs-stop", reason: "four tabs in a row failed", open: pages.length, ended });
				break;
			}
			if (!past && meminfo().roomMB < 300) {
				stop = "room";
				M({ t: "tabs-stop", reason: "under 300 MB of room (free memory plus free swap)", open: pages.length, ended });
				break;
			}
		}
		// Coming back to the first tabs that still live: what does it cost to return to something that was pushed out?
		let back = 0;
		for (const [index, page] of pages.entries()) {
			if (!page || back >= 3 || crashed.has(page)) continue;
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
			} catch (error) {
				const kind = await meaning(page, error);
				if (kind === "browser") throw new BrowserGone(short(error));
				// A tab ended just now is passed over; one that does not come back for another reason fails the phase.
				if (kind === "other") {
					failures.push(`back to tab ${index + 1}: ${short(error)}`);
					M({ t: "back", tab: index + 1, backMs: Date.now() - t, err: short(error) });
					back++;
				}
			}
		}
		const reason = tabsVerdict({ past, stop, ended: crashed.size, failures });
		M({ t: "tabs-end", open: pages.length, ended: crashed.size, stop, failures: failures.length, verdict: reason ?? "ended well" });
		if (reason) throw new PhaseFailed(reason);
	} else throw new PhaseFailed(`no such phase: ${phase}`);
	// Whatever the phase did, the browser itself is still there: tabs may be ended, the browser may not.
	if (!(await browserAnswers())) throw new BrowserGone("the browser no longer answers on its debugging port");
	await browser.close();
})().catch(async (error) => {
	// Whatever went wrong, the first question is whether the browser itself is gone.
	if (error instanceof BrowserGone || !(await browserAnswers())) {
		M({ t: "browser-gone", phase: process.argv[2], message: short(error) });
		process.exit(3);
	}
	M({ t: "phase-failed", phase: process.argv[2], reason: String(error?.message).split("\n")[0].slice(0, 240) });
	process.exit(1);
});
