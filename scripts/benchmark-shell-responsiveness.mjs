import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;

function parseArguments(argv) {
	const options = {
		app: process.env.QORPERA_SHELL_APP,
		baseline: undefined,
		output: undefined,
		runs: DEFAULT_RUNS,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--app" && value) {
			options.app = value;
			index += 1;
		} else if (argument === "--baseline" && value) {
			options.baseline = value;
			index += 1;
		} else if (argument === "--output" && value) {
			options.output = value;
			index += 1;
		} else if (argument === "--runs" && value) {
			options.runs = Number.parseInt(value, 10);
			index += 1;
		} else if (argument === "--timeout-ms" && value) {
			options.timeoutMs = Number.parseInt(value, 10);
			index += 1;
		} else if (argument === "--help") {
			console.log(
				"Usage: node scripts/benchmark-shell-responsiveness.mjs --app <executable> [--runs 5] [--output report.json] [--baseline report.json]",
			);
			process.exit(0);
		} else {
			throw new Error(`Unknown or incomplete argument: ${argument}`);
		}
	}
	if (!options.app) throw new Error("Pass --app or set QORPERA_SHELL_APP to the packaged shell executable.");
	if (!existsSync(options.app)) throw new Error(`Shell executable does not exist: ${options.app}`);
	if (!Number.isSafeInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer.");
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
		throw new Error("--timeout-ms must be an integer of at least 1000.");
	}
	return { ...options, app: resolve(options.app) };
}

function delay(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function availablePort() {
	return new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a local debugging port."));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolvePromise(address.port);
			});
		});
	});
}

async function fetchJson(url, deadline) {
	let lastError;
	while (performance.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return await response.json();
			lastError = new Error(`${response.status} ${response.statusText}`);
		} catch (error) {
			lastError = error;
		}
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

class CdpClient {
	#id = 0;
	#pending = new Map();
	#socket;

	constructor(socket) {
		this.#socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (!message.id) return;
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("CDP connection closed."));
			this.#pending.clear();
		});
	}

	static async connect(url, deadline) {
		const socket = new WebSocket(url);
		await new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out opening the CDP WebSocket.")), deadline - performance.now());
			socket.addEventListener("open", () => {
				clearTimeout(timeout);
				resolvePromise();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timeout);
				reject(new Error("Could not open the CDP WebSocket."));
			});
		});
		return new CdpClient(socket);
	}

	async send(method, params = {}) {
		const id = ++this.#id;
		const result = new Promise((resolvePromise, reject) => {
			this.#pending.set(id, { resolve: resolvePromise, reject });
		});
		this.#socket.send(JSON.stringify({ id, method, params }));
		return result;
	}

	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result.value;
	}

	close() {
		this.#socket.close();
	}
}

function percentile(values, quantile) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
	return sorted[index];
}

function distribution(values) {
	if (values.length === 0) return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	return {
		min: Math.min(...values),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		p99: percentile(values, 0.99),
		max: Math.max(...values),
	};
}

function round(value) {
	return Math.round(value * 1000) / 1000;
}

function processResources(rootPid) {
	if (process.platform === "win32") return { rssMiB: undefined, cpuPercent: undefined, processCount: undefined };
	const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter((row) => row.length === 4 && row.every(Number.isFinite));
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, parentPid] of rows) {
			if (!descendants.has(parentPid) || descendants.has(pid)) continue;
			descendants.add(pid);
			changed = true;
		}
	}
	const owned = rows.filter(([pid]) => descendants.has(pid));
	return {
		rssMiB: owned.reduce((total, row) => total + row[2], 0) / 1024,
		cpuPercent: owned.reduce((total, row) => total + row[3], 0),
		processCount: owned.length,
	};
}

async function terminateProcessTree(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
		} catch {
			// The process may have exited between the status check and taskkill.
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		return;
	}
	await Promise.race([
		new Promise((resolvePromise) => child.once("exit", resolvePromise)),
		delay(2_000).then(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The process exited during the grace period.
			}
		}),
	]);
}

const RENDERER_BENCHMARK = String.raw`(async () => {
	const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
	const summarize = (values) => {
		const sorted = [...values].sort((left, right) => left - right);
		const pick = (quantile) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
		return { min: sorted[0] ?? 0, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: sorted.at(-1) ?? 0 };
	};
	const samples = async (iterations, operation) => {
		const values = [];
		for (let index = 0; index < iterations; index += 1) {
			const startedAt = performance.now();
			await operation(index);
			values.push(performance.now() - startedAt);
		}
		return summarize(values);
	};
	const timed = async (operation) => {
		const startedAt = performance.now();
		await operation();
		return performance.now() - startedAt;
	};

	const capabilityFingerprint = {
		bridgeMethods: Object.keys(window.qorpera ?? {}).length,
		buttons: document.querySelectorAll("button").length,
		forms: document.querySelectorAll("form").length,
		scripts: document.scripts.length,
		hasFeedback: typeof window.qorperaFeedback?.open === "function",
		hasConversationRenderer: typeof renderHistory === "function",
		hasComposer: typeof syncComposer === "function",
	};

	const feedbackOpenHandler = await samples(50, () => {
		window.qorperaFeedback.open(document.body);
	});
	const feedbackOpenPaint = await samples(25, async () => {
		window.qorperaFeedback.open(document.body);
		await frame();
	});
	const feedbackCloseHandler = await samples(50, () => {
		document.getElementById("feedbackClose").click();
	});
	const feedbackClosePaint = await samples(25, async () => {
		document.getElementById("feedbackClose").click();
		await frame();
	});

	document.body.classList.remove("welcome", "hub");
	document.body.classList.add("company-shell");
	document.getElementById("accountView").hidden = true;
	document.getElementById("welcomeView").hidden = true;
	document.getElementById("conav").style.display = "";
	if (typeof show === "function") show("chat");
	await frame();
	const composer = document.getElementById("input");
	const composerInputHandler = await samples(100, (index) => {
		composer.value = index % 2 === 0 ? "Short message" : "A longer message that wraps across the composer width. ".repeat(8);
		composer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const composerInputPaint = await samples(40, async (index) => {
		composer.value = index % 2 === 0 ? "Short message" : "A longer message that wraps across the composer width. ".repeat(8);
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		await frame();
	});
	composer.value = "";
	composer.dispatchEvent(new Event("input", { bubbles: true }));

	const fixture = (count) => Array.from({ length: count }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		timestamp: 1_780_000_000_000 + index,
		content: [{
			type: "text",
			text: index % 2 === 0
				? "Founder prompt " + index + ": inspect the current state and preserve every capability."
				: "Result " + index + "\n\n- Evidence retained\n- Capability parity checked\n- Next action measured",
		}],
	}));
	const history = {};
	for (const count of [500, 1000, 2000]) {
		const messages = fixture(count);
		history[String(count)] = summarize([
			await timed(() => {
				show("chat");
				renderThreadHeader();
				renderHistory(messages);
				document.getElementById("messages").scrollHeight;
			}),
		]);
	}

	const messages = document.getElementById("messages");
	const transcriptCapabilityFingerprint = {
		messages: messages.querySelectorAll(":scope > .msg").length,
		userMessages: messages.querySelectorAll(":scope > .msg.user").length,
		assistantMessages: messages.querySelectorAll(":scope > .msg.assistant").length,
		rewindControls: messages.querySelectorAll(":scope > .msg.user > .msg-rewind").length,
		assistantLists: messages.querySelectorAll(":scope > .msg.assistant ul").length,
		firstUserText: messages.querySelector(":scope > .msg.user")?.textContent?.trim() ?? "",
		lastAssistantText: [...messages.querySelectorAll(":scope > .msg.assistant")].at(-1)?.textContent?.trim() ?? "",
	};

	const benchmarkStaff = {
		id: "responsiveness-agent",
		displayName: "Responsiveness Agent",
		role: "Performance researcher",
		description: "Measures app responsiveness without changing capabilities.",
		appearance: { color: "#1684ff", shape: "round", creature: "pebble" },
	};
	const routineFixture = (count) => Array.from({ length: count }, (_, index) => ({
		id: "routine-" + index,
		staffAgentId: benchmarkStaff.id,
		title: "Responsiveness routine " + index,
		prompt: "Measure path " + index + " and preserve all behavior.",
		enabled: index % 5 !== 0,
		running: index % 97 === 0,
		suspendedReason: index % 211 === 0 ? "Benchmark attention state" : "",
		lastOutcome: index % 211 === 0 ? "failed" : "succeeded",
		lastRunAt: "2026-08-26T08:00:00.000Z",
		nextRunAt: "2026-08-26T09:00:00.000Z",
		triggers: [{ id: "trigger-" + index, kind: "schedule", intervalMinutes: 60 }],
		effort: "high",
		placement: "local",
		publication: { mode: "automatic" },
	}));
	state.staff = [benchmarkStaff];
	state.runtime = { revision: 0, sessions: [] };
	state.connectionRequests = [];
	currentStaffId = benchmarkStaff.id;
	currentRoomId = null;
	currentSession = "responsiveness-agent.jsonl";
	const sidepanel = document.getElementById("agentSidepanel");
	const sidepanelTitlebar = document.getElementById("agentSidepanelTitlebar");
	const sidepanelContent = document.getElementById("agentSidepanelContent");
	const resetSidepanel = () => {
		agentSidepanelMode = null;
		agentRoutineEditor = null;
		sidepanel.hidden = true;
		sidepanelTitlebar.hidden = true;
		sidepanel.classList.remove("is-opening", "is-closing");
		sidepanelTitlebar.classList.remove("is-opening", "is-closing");
		sidepanelContent.replaceChildren();
	};
	state.scheduledJobs = routineFixture(5000);
	resetSidepanel();
	const sidepanelOpenHandler = summarize([await timed(() => openAgentSidepanel("computer"))]);
	const sidepanelOpenPaint = summarize([await timed(async () => {
		resetSidepanel();
		openAgentSidepanel("computer");
		await frame();
	})]);
	const sidepanelComplete = summarize([await timed(async () => {
		const deadline = performance.now() + 15000;
		while (sidepanelContent.querySelectorAll(".agent-routine-row").length < 5000) {
			if (performance.now() >= deadline) throw new Error("sidepanel completion timed out");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	})]);
	const sidepanelCapabilityFingerprint = {
		title: document.getElementById("agentSidepanelTitle").textContent,
		routineRows: sidepanelContent.querySelectorAll(".agent-routine-row").length,
		routineButtons: sidepanelContent.querySelectorAll('button[type="button"]').length,
		runningLabels: [...sidepanelContent.querySelectorAll(".agent-routine-row > small")].filter((element) => element.textContent === "Running").length,
		onLabels: [...sidepanelContent.querySelectorAll(".agent-routine-row > small")].filter((element) => element.textContent === "On").length,
		offLabels: [...sidepanelContent.querySelectorAll(".agent-routine-row > small")].filter((element) => element.textContent === "Off").length,
		firstTitle: sidepanelContent.querySelector(".agent-routine-row strong")?.textContent ?? "",
		lastTitle: [...sidepanelContent.querySelectorAll(".agent-routine-row strong")].at(-1)?.textContent ?? "",
		createAction: typeof sidepanelContent.querySelector(".agent-routine-create")?.onclick === "function",
		firstRowAction: typeof sidepanelContent.querySelector(".agent-routine-row")?.onclick === "function",
	};
	const sidepanelCloseHandler = summarize([await timed(() => closeAgentSidepanel(false))]);
	messages.replaceChildren();
	const append1000 = await timed(() => {
		for (let index = 0; index < 1000; index += 1) addMsg(index % 2 === 0 ? "user" : "assistant", "Message " + index);
		messages.scrollHeight;
	});
	const idleEventLoopLag = await new Promise((resolve) => {
		const values = [];
		let previous = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			values.push(Math.max(0, now - previous - 10));
			previous = now;
			if (values.length < 100) return;
			clearInterval(timer);
			resolve(summarize(values));
		}, 10);
	});
	return {
		capabilityFingerprint,
		feedbackOpenHandler,
		feedbackOpenPaint,
		feedbackCloseHandler,
		feedbackClosePaint,
		composerInputHandler,
		composerInputPaint,
		history,
		transcriptCapabilityFingerprint,
		sidepanelOpenHandler,
		sidepanelOpenPaint,
		sidepanelComplete,
		sidepanelCloseHandler,
		sidepanelCapabilityFingerprint,
		append1000,
		idleEventLoopLag,
		domNodesAfterFixture: document.getElementsByTagName("*").length,
	};
})()`;

async function benchmarkRun(app, runIndex, timeoutMs) {
	const profile = mkdtempSync(join(tmpdir(), `qorpera-responsiveness-${runIndex}-`));
	const port = await availablePort();
	const startedAt = performance.now();
	const output = [];
	const child = spawn(
		app,
		[
			`--remote-debugging-port=${port}`,
			"--remote-allow-origins=*",
			`--user-data-dir=${profile}`,
		],
		{
			detached: process.platform !== "win32",
			env: { ...process.env, QORPERA_RESPONSIVENESS_BENCHMARK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	let spawnError;
	child.on("error", (error) => {
		spawnError = error;
		output.push(String(error));
	});
	let cdp;
	try {
		const deadline = startedAt + timeoutMs;
		let targets;
		while (performance.now() < deadline) {
			if (spawnError) throw spawnError;
			targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, deadline);
			if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) break;
			await delay(20);
		}
		const target = targets?.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
		if (!target) throw new Error("Electron exposed no renderer target.");
		const debuggerReadyMs = performance.now() - startedAt;
		cdp = await CdpClient.connect(target.webSocketDebuggerUrl, deadline);
		await cdp.send("Runtime.enable");
		const ready = await cdp.evaluate(`new Promise((resolve, reject) => {
			const deadline = performance.now() + 15000;
			const inspect = () => {
				if (document.documentElement?.dataset.qorperaReady) {
					const navigation = performance.getEntriesByType("navigation")[0];
					const paint = performance.getEntriesByName("first-contentful-paint")[0];
					resolve({
						readyState: document.readyState,
						readyMarker: document.documentElement.dataset.qorperaReady,
						domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
						loadEventMs: navigation?.loadEventEnd ?? 0,
						firstContentfulPaintMs: paint?.startTime ?? null,
					});
				} else if (performance.now() >= deadline) reject(new Error("renderer ready marker timed out"));
				else setTimeout(inspect, 10);
			};
			inspect();
		})`);
		const rendererReadyMs = performance.now() - startedAt;
		const renderer = await cdp.evaluate(RENDERER_BENCHMARK);
		const resources = processResources(child.pid);
		return {
			run: runIndex,
			startup: { debuggerReadyMs, rendererReadyMs, ...ready },
			renderer,
			resources,
		};
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : error}\n${output.join("").trim()}`);
	} finally {
		cdp?.close();
		await terminateProcessTree(child);
		rmSync(profile, { recursive: true, force: true });
	}
}

function aggregate(runs) {
	const startupKeys = ["debuggerReadyMs", "rendererReadyMs", "domContentLoadedMs", "loadEventMs", "firstContentfulPaintMs"];
	const startup = Object.fromEntries(
		startupKeys.map((key) => [key, distribution(runs.map((run) => run.startup[key]).filter((value) => value > 0))]),
	);
	const paths = {
		"feedback-open-handler": runs.map((run) => run.renderer.feedbackOpenHandler.p95),
		"feedback-open-paint": runs.map((run) => run.renderer.feedbackOpenPaint.p95),
		"feedback-close-handler": runs.map((run) => run.renderer.feedbackCloseHandler.p95),
		"feedback-close-paint": runs.map((run) => run.renderer.feedbackClosePaint.p95),
		"composer-input-handler": runs.map((run) => run.renderer.composerInputHandler.p95),
		"composer-input-paint": runs.map((run) => run.renderer.composerInputPaint.p95),
		"history-500": runs.map((run) => run.renderer.history["500"].p95),
		"history-1000": runs.map((run) => run.renderer.history["1000"].p95),
		"history-2000": runs.map((run) => run.renderer.history["2000"].p95),
		"agent-thread-load-500": runs.map((run) => run.renderer.history["500"].p95),
		"agent-thread-load-1000": runs.map((run) => run.renderer.history["1000"].p95),
		"agent-thread-load-2000": runs.map((run) => run.renderer.history["2000"].p95),
		"sidepanel-open-5000-handler": runs.map((run) => run.renderer.sidepanelOpenHandler.p95),
		"sidepanel-open-5000-paint": runs.map((run) => run.renderer.sidepanelOpenPaint.p95),
		"sidepanel-complete-5000": runs.map((run) => run.renderer.sidepanelComplete.p95),
		"sidepanel-full-5000": runs.map(
			(run) => run.renderer.sidepanelOpenPaint.p95 + run.renderer.sidepanelComplete.p95,
		),
		"sidepanel-close-handler": runs.map((run) => run.renderer.sidepanelCloseHandler.p95),
		"append-1000": runs.map((run) => run.renderer.append1000),
		"idle-event-loop-lag": runs.map((run) => run.renderer.idleEventLoopLag.p95),
	};
	const interactions = Object.fromEntries(Object.entries(paths).map(([key, values]) => [key, distribution(values)]));
	const slowestInteractivePath = Object.entries(interactions)
		.filter(([key]) => key !== "idle-event-loop-lag" && !key.endsWith("-paint"))
		.sort((left, right) => right[1].p95 - left[1].p95)[0];
	const performanceTargets = Object.fromEntries(
		[
			["agentThread", "agent-thread-load-2000"],
			["sidepanelHandler", "sidepanel-open-5000-handler"],
			["sidepanelPaint", "sidepanel-open-5000-paint"],
		].map(([domain, name]) => [domain, { name, p95Ms: interactions[name].p95, targetMs: interactions[name].p95 / 10 }]),
	);
	return {
		startup,
		interactions,
		resources: {
			rssMiB: distribution(runs.map((run) => run.resources.rssMiB).filter(Number.isFinite)),
			cpuPercent: distribution(runs.map((run) => run.resources.cpuPercent).filter(Number.isFinite)),
			processCount: distribution(runs.map((run) => run.resources.processCount).filter(Number.isFinite)),
		},
		slowestInteractivePath: {
			name: slowestInteractivePath[0],
			p95Ms: slowestInteractivePath[1].p95,
			targetMs: slowestInteractivePath[1].p95 / 10,
		},
		performanceTargets,
	};
}

function compareWithBaseline(current, baseline) {
	const targets = Object.fromEntries(
		Object.entries(baseline.aggregate.performanceTargets).map(([domain, target]) => {
			const baselineLatencyMs = baseline.aggregate.interactions[target.name]?.p95;
			const currentLatencyMs = current.aggregate.interactions[target.name]?.p95;
			if (!Number.isFinite(baselineLatencyMs) || !Number.isFinite(currentLatencyMs)) {
				throw new Error(`The baseline path ${target.name} is missing from one report.`);
			}
			return [domain, {
				name: target.name,
				baselineLatencyMs,
				currentLatencyMs,
				speedup: baselineLatencyMs / currentLatencyMs,
				targetMet: baselineLatencyMs / currentLatencyMs >= 10,
			}];
		}),
	);
	const startupRegressionThreshold = Math.max(
		baseline.aggregate.startup.rendererReadyMs.p50 * 1.1,
		baseline.aggregate.startup.rendererReadyMs.p50 + 250,
	);
	const startupRegression = current.aggregate.startup.rendererReadyMs.p50 > startupRegressionThreshold;
	const sidepanelCompletionRegressionThreshold = Math.max(
		baseline.aggregate.interactions["sidepanel-full-5000"].p50 * 1.1,
		baseline.aggregate.interactions["sidepanel-full-5000"].p50 + 50,
	);
	const sidepanelCompletionRegression =
		current.aggregate.interactions["sidepanel-full-5000"].p50 > sidepanelCompletionRegressionThreshold;
	const capabilityParity =
		JSON.stringify(current.runs[0].renderer.capabilityFingerprint) ===
			JSON.stringify(baseline.runs[0].renderer.capabilityFingerprint) &&
		JSON.stringify(current.runs[0].renderer.transcriptCapabilityFingerprint) ===
			JSON.stringify(baseline.runs[0].renderer.transcriptCapabilityFingerprint) &&
		JSON.stringify(current.runs[0].renderer.sidepanelCapabilityFingerprint) ===
			JSON.stringify(baseline.runs[0].renderer.sidepanelCapabilityFingerprint);
	const targetMet = Object.values(targets).every((target) => target.targetMet);
	return {
		targets,
		targetMet,
		startupRegression,
		sidepanelCompletionRegression,
		capabilityParity,
		accepted: targetMet && !startupRegression && !sidepanelCompletionRegression && capabilityParity,
	};
}

function printReport(report) {
	console.log(`\nQorpera Base responsiveness (${report.runs.length} isolated runs)`);
	console.log(`  renderer ready p50/p95: ${round(report.aggregate.startup.rendererReadyMs.p50)} / ${round(report.aggregate.startup.rendererReadyMs.p95)} ms`);
	const paint = report.aggregate.startup.firstContentfulPaintMs;
	console.log(
		paint.p95 > 0
			? `  first contentful paint p50/p95: ${round(paint.p50)} / ${round(paint.p95)} ms`
			: "  first contentful paint: unavailable from this packaged renderer",
	);
	for (const [name, values] of Object.entries(report.aggregate.interactions)) {
		console.log(`  ${name} p50/p95: ${round(values.p50)} / ${round(values.p95)} ms`);
	}
	const targets = report.comparison?.targets ?? report.aggregate.performanceTargets;
	for (const [domain, target] of Object.entries(targets)) {
		const baselineLatency = target.baselineLatencyMs ?? target.p95Ms;
		console.log(`  ${domain} target: ${target.name} ${round(baselineLatency)} ms -> ${round(baselineLatency / 10)} ms`);
		if (Number.isFinite(target.speedup)) console.log(`  ${domain} speedup: ${round(target.speedup)}x`);
	}
	if (report.comparison) {
		console.log(`  capability parity: ${report.comparison.capabilityParity ? "pass" : "fail"}`);
		console.log(`  median startup regression: ${report.comparison.startupRegression ? "fail" : "pass"}`);
		console.log(
			`  sidepanel completion regression: ${report.comparison.sidepanelCompletionRegression ? "fail" : "pass"}`,
		);
		console.log(`  10x acceptance: ${report.comparison.accepted ? "pass" : "fail"}`);
	}
}

const options = parseArguments(process.argv.slice(2));
const runs = [];
for (let index = 1; index <= options.runs; index += 1) {
	let run;
	for (let attempt = 1; attempt <= 3 && !run; attempt += 1) {
		process.stdout.write(`Benchmark run ${index}/${options.runs}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}... `);
		try {
			run = await benchmarkRun(options.app, index, options.timeoutMs);
		} catch (error) {
			if (attempt === 3) throw error;
			console.log(`startup failed: ${error instanceof Error ? error.message.split("\n", 1)[0] : error}`);
			await delay(250);
		}
	}
	runs.push(run);
	console.log(`${round(run.startup.rendererReadyMs)} ms to renderer ready`);
}
const report = {
	schema: "qorpera.shell-responsiveness/v2",
	createdAt: new Date().toISOString(),
	app: options.app,
	platform: process.platform,
	architecture: process.arch,
	runs,
	aggregate: aggregate(runs),
};
if (options.baseline) {
	const baseline = JSON.parse(readFileSync(resolve(options.baseline), "utf8"));
	report.comparison = compareWithBaseline(report, baseline);
}
printReport(report);
if (options.output) writeFileSync(resolve(options.output), `${JSON.stringify(report, null, "\t")}\n`);
if (report.comparison && !report.comparison.accepted) process.exitCode = 1;
