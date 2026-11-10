import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
	type CompanyAccountFillIdentity,
	CompanyComputerFillKey,
	sealCompanyAccountFill,
} from "../../src/cloud-company-account-fill-box.ts";
import {
	fillAccountOnMachine,
	type MachineAccountFillPorts,
	type MachineFillPage,
	machineChromium,
	machineChromiumPort,
} from "../../src/cloud-machine-account-fill.ts";

/* fill_company_account's helper against a real Chromium (review round 1 of #1644). Runs as root in the container
 * scripts/test-machine-account-fill-browser.mjs makes: the machine image's pinned Chrome for Testing at its path, started
 * as the account `desktop` with the profile and loopback DevTools port `desktop open` gives it, on a TigerVNC display
 * with openbox, and local https pages for the account's site (fill-check.test) and another site (evil.test). The helper
 * runs as the executor runs it (/opt/probe/helper.mjs, bundled as the image ships it) or, where a case must move the tab
 * between two of the helper's own steps, in this process with the real browser port wrapped. Each case prints PASS or
 * FAIL with what it saw (never the value); the probe exits 1 if any failed. */

const SITE = "fill-check.test";
const EVIL = "evil.test";
const PROFILE = "/home/desktop/.config/qorpera-chromium";
const READY = "qorpera.machine-account-fill-ready/v1";
const secret = `Qf-${randomBytes(18).toString("base64url")}`;
const hide = (text: string) => text.replaceAll(secret, "<the value>");
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

/* The pages. Each reports every input event's box and value to the server it came from (a beacon outlives a navigation),
 * so what a page heard is known even after the tab left it. The box fills the page, so a click anywhere reaches it. */
const heard: { host: string; box: string; value: string }[] = [];
const REPORT =
	'<script>document.addEventListener("input", (event) => navigator.sendBeacon("/heard", JSON.stringify({ box: event.target.id, value: event.target.value })), true);</script>';
const BOX =
	'<input id="p" type="password" autocomplete="off" style="position:fixed;left:0;top:0;width:100%;height:100%;font-size:40px">';
const SINK =
	'<input id="sink" type="text" autocomplete="off" style="position:fixed;left:0;top:0;width:160px;height:28px;z-index:2">';
/** The box already holds text as long as the value: a length check alone cannot tell the two apart. */
const PREFILLED = `<script>document.getElementById("p").value = "${"y".repeat(secret.length)}";</script>`;
const on = (event: string, body: string) =>
	`<script>document.getElementById("p").addEventListener("${event}", () => { ${body} });</script>`;
function page(host: string, path: string): string | undefined {
	const html = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}${REPORT}`;
	if (host === EVIL)
		return path === "/autofocus" ? html("Sign in", BOX.replace("<input ", "<input autofocus ")) : undefined;
	switch (path) {
		case "/blank":
			return html("start", "");
		case "/sign-in":
			return html("Sign in", BOX);
		// A select handler that moves the focus (the helper used to select the box's text first).
		case "/select-moves":
			return html("Sign in", BOX + SINK + PREFILLED + on("select", 'document.getElementById("sink").focus();'));
		// The focus moves as the value goes in, and once it is in.
		case "/beforeinput-moves":
			return html("Sign in", BOX + SINK + PREFILLED + on("beforeinput", 'document.getElementById("sink").focus();'));
		case "/input-moves":
			return html("Sign in", BOX + SINK + PREFILLED + on("input", 'document.getElementById("sink").focus();'));
		// The page leaves for another site, or stops answering, once the value is in.
		case "/input-leaves":
			return html("Sign in", BOX + on("input", `location.href = "https://${EVIL}/autofocus";`));
		case "/input-hangs":
			return html("Sign in", BOX + on("input", "const end = Date.now() + 6000; while (Date.now() < end);"));
		default:
			return undefined;
	}
}

/** One DevTools connection of the probe's own, to drive and read the tab (never the helper's). */
class Tab {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, (message: Record<string, unknown>) => void>();
	#next = 1;
	#session = "";
	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (typeof message.id === "number") this.#pending.get(message.id)?.(message);
		});
	}
	static async open(): Promise<Tab> {
		const port = await machineChromiumPort();
		if (typeof port !== "object") throw new Error(`no DevTools port: ${port}`);
		const version = (await (await fetch(`http://127.0.0.1:${port.port}/json/version`)).json()) as {
			webSocketDebuggerUrl: string;
		};
		const socket = new WebSocket(version.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const tab = new Tab(socket);
		const pages = (
			(await tab.call("Target.getTargets", {}, false)).targetInfos as { type: string; targetId: string }[]
		).filter((target) => target.type === "page");
		if (pages.length !== 1) throw new Error(`${pages.length} tabs`);
		tab.#session = (await tab.call("Target.attachToTarget", { targetId: pages[0]?.targetId, flatten: true }, false))
			.sessionId as string;
		return tab;
	}
	call(method: string, params: Record<string, unknown> = {}, inTab = true): Promise<Record<string, unknown>> {
		const id = this.#next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
			this.#pending.set(id, (message) => {
				clearTimeout(timer);
				this.#pending.delete(id);
				if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
				else resolve(message.result as Record<string, unknown>);
			});
			this.#socket.send(JSON.stringify({ id, method, params, ...(inTab ? { sessionId: this.#session } : {}) }));
		});
	}
	/** An expression in the page's own world; undefined while the tab is between documents. */
	async read(expression: string): Promise<unknown> {
		try {
			const answer = await this.call("Runtime.evaluate", { expression, returnByValue: true });
			return answer.exceptionDetails ? undefined : (answer.result as { value?: unknown }).value;
		} catch {
			return undefined;
		}
	}
	async until(expression: string, what: string, ms = 15_000): Promise<void> {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if ((await this.read(expression)) === true) return;
			await delay(100);
		}
		throw new Error(`timed out waiting for ${what}`);
	}
	/** Goes to the page, gives the window and the box the focus, and waits until the page says the box has it. */
	async visit(path: string, host = SITE): Promise<void> {
		const url = `https://${host}${path}`;
		await this.call("Page.navigate", { url });
		await this.until(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`, url);
		execFileSync("xdotool", ["mousemove", "800", "500", "click", "1"], { env: { ...process.env, DISPLAY: ":1" } });
		await this.read('document.getElementById("p").focus()');
		await this.until(
			'document.hasFocus() && document.activeElement && document.activeElement.id === "p"',
			`the box of ${url} to have the focus`,
		);
	}
	/** The page's address and its boxes' values. */
	async values(): Promise<Record<string, string>> {
		return (await this.read(
			'({ host: location.host, ...Object.fromEntries([...document.querySelectorAll("input")].map((box) => [box.id, box.value])) })',
		)) as Record<string, string>;
	}
}

const machineIds = () => ({
	companyId: randomUUID(),
	companyMachineId: randomUUID(),
	placementId: randomUUID(),
	bootId: boot,
	receiptId: randomUUID(),
	accountId: randomUUID(),
	field: "password" as const,
});
const targetOf = (identity: ReturnType<typeof machineIds>, hosts: string[]) => ({
	schema: "qorpera.machine-account-fill-target/v1",
	...identity,
	hosts,
});
const sealed = (publicKey: string, identity: CompanyAccountFillIdentity) =>
	sealCompanyAccountFill({ value: secret, hosts: [SITE] }, publicKey, identity);

/** The helper as the executor runs it: the target on stdin, then (once it printed its key, and after `whileSealing`, the
 * vault's turn) the box; its last line's code. */
async function program(options: { hosts?: string[]; whileSealing?: () => Promise<void> } = {}): Promise<string> {
	const identity = machineIds();
	const child: ChildProcess = spawn("/usr/bin/node", ["/opt/probe/helper.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	let answered = false;
	child.stderr?.on("data", (chunk: Buffer) => {
		err += chunk.toString("utf8");
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
		if (answered || !out.includes("\n")) return;
		answered = true;
		const line = JSON.parse(out.slice(0, out.indexOf("\n"))) as { schema: string; publicKey?: string };
		void (async () => {
			if (line.schema === READY) {
				await options.whileSealing?.();
				child.stdin?.write(`${JSON.stringify(sealed(line.publicKey as string, identity))}\n`);
			}
			child.stdin?.end();
		})();
	});
	const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
	child.stdin?.write(`${JSON.stringify(targetOf(identity, options.hosts ?? [SITE]))}\n`);
	const status = await closed;
	if (out.includes(secret) || err.includes(secret)) throw new Error("the helper printed the value");
	if (status !== 0) throw new Error(`the helper exited ${status}: ${hide(err.trim())}`);
	const last = out.trim().split("\n").at(-1) ?? "{}";
	return (JSON.parse(last) as { code?: string }).code ?? "none";
}

/** What a case does between the helper's own steps: before or after the `call`th call of one of the page's methods
 * (the first look and the second, after the box, each call them once). */
interface Step {
	method: string;
	call: number;
	when: "before" | "after";
	run(deadline: AbortController): Promise<void>;
}

/** The desktop's Chromium as the helper finds it, with each focused tab's methods wrapped to run `step`. */
function watched(open: MachineAccountFillPorts["browser"], step: Step, deadline: AbortController) {
	const counts = new Map<PropertyKey, number>();
	const wrap = (found: MachineFillPage): MachineFillPage =>
		new Proxy(found, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					const call = (counts.get(key) ?? 0) + 1;
					counts.set(key, call);
					const mine = key === step.method && call === step.call;
					if (mine && step.when === "before") await step.run(deadline);
					const answer: unknown = await value.apply(target, args);
					if (mine && step.when === "after") await step.run(deadline);
					return answer;
				};
			},
		});
	const browser: MachineAccountFillPorts["browser"] = async (signal) => {
		const opened = await open(signal);
		if (typeof opened === "string") return opened;
		return {
			focusedPage: async () => {
				const found = await opened.focusedPage();
				return typeof found === "string" ? found : wrap(found);
			},
			close: () => opened.close(),
		};
	};
	return browser;
}

/** The helper in this process against the real browser, with `step` run between two of its own steps. */
async function inProcess(step: Step): Promise<string> {
	const identity = machineIds();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), 20_000);
	let printed = "";
	let ready: (line: string) => void = () => undefined;
	const first = new Promise<string>((resolve) => {
		ready = resolve;
	});
	async function* stdin(): AsyncGenerator<Buffer> {
		yield Buffer.from(`${JSON.stringify(targetOf(identity, [SITE]))}\n`);
		const line = JSON.parse(await first) as { schema: string; publicKey?: string };
		if (line.schema !== READY) return;
		yield Buffer.from(`${JSON.stringify(sealed(line.publicKey as string, identity))}\n`);
	}
	try {
		const code = await fillAccountOnMachine({
			stdin: stdin(),
			stdout: {
				write: (text: string) => {
					printed += text;
					if (printed.includes("\n")) ready(printed.slice(0, printed.indexOf("\n")));
				},
			},
			ports: {
				bootId: async () => boot,
				browser: watched(machineChromium(), step, deadline),
				key: () => new CompanyComputerFillKey(),
				now: Date.now,
			},
			signal: deadline.signal,
		});
		if (printed.includes(secret)) throw new Error("the helper printed the value");
		return code;
	} finally {
		clearTimeout(timer);
		ready('{"schema":"done"}');
	}
}

function equal(actual: unknown, expected: unknown, what: string): void {
	if (actual !== expected)
		throw new Error(hide(`${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
}
/** Nothing the other site's pages heard since `since`. */
function nothingHeardOn(host: string, since: number): void {
	const there = heard.slice(since).filter((entry) => entry.host === host);
	if (there.length > 0) throw new Error(hide(`${host} heard ${JSON.stringify(there)}`));
}
const describe = (value: string | undefined) =>
	value === "" ? "empty" : value === secret ? "the value" : value === undefined ? "gone" : "other text";

let failed = 0;
async function check(name: string, body: () => Promise<string>): Promise<void> {
	try {
		console.log(`PASS ${name}: ${await body()}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}: ${hide(error instanceof Error ? error.message : String(error))}`);
	}
}

const children: ChildProcess[] = [];
/** A program of the desktop's, its output in /tmp/<log>.log (printed when the probe fails). */
const started = (log: string, command: string, args: string[]) => {
	const output = openSync(`/tmp/${log}.log`, "a");
	const child = spawn(command, args, { stdio: ["ignore", output, output] });
	children.push(child);
	return child;
};
const asDesktop = ["-u", "desktop", "--", "env", "DISPLAY=:1", "HOME=/home/desktop"];

async function main(): Promise<void> {
	execFileSync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-days",
		"1",
		"-subj",
		`/CN=${SITE}`,
		"-addext",
		`subjectAltName=DNS:${SITE},DNS:${EVIL}`,
		"-keyout",
		"/tmp/probe.key",
		"-out",
		"/tmp/probe.crt",
	]);
	const server = createServer(
		{ key: readFileSync("/tmp/probe.key"), cert: readFileSync("/tmp/probe.crt") },
		(request, reply) => {
			const host = (request.headers.host ?? "").replace(/:443$/, "");
			if (request.method === "POST" && request.url === "/heard") {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					const entry = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { box: string; value: string };
					heard.push({ host, box: entry.box, value: entry.value });
					reply.end();
				});
				return;
			}
			const body = page(host, request.url ?? "");
			reply.statusCode = body ? 200 : 404;
			reply.setHeader("content-type", "text/html; charset=utf-8");
			reply.setHeader("cache-control", "no-store");
			reply.end(body ?? "");
		},
	);
	await new Promise<void>((listening) => server.listen(443, "127.0.0.1", listening));
	// The display (TigerVNC's X server, as on the machine) and a window manager that gives a new window the focus.
	started("xvnc", "Xvnc", [
		":1",
		"-geometry",
		"1600x1000",
		"-depth",
		"24",
		"-SecurityTypes",
		"None",
		"-localhost",
		"-ac",
	]);
	for (let i = 0; i < 100 && !existsSync("/tmp/.X11-unix/X1"); i++) await delay(100);
	await delay(500);
	started("openbox", "runuser", [...asDesktop, "openbox"]);
	await delay(500);
	// Chromium as desktop open starts it (its own profile, a DevTools port the kernel picks on the loopback); the
	// container has no user namespaces for its sandbox, and the test hosts are local.
	started("chromium", "runuser", [
		...asDesktop,
		"/usr/lib/qorpera-chromium/chrome",
		`--user-data-dir=${PROFILE}`,
		"--remote-debugging-port=0",
		"--start-maximized",
		"--no-first-run",
		"--no-default-browser-check",
		"--password-store=basic",
		"--disable-infobars",
		"--no-sandbox",
		"--ignore-certificate-errors",
		`--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${EVIL} 127.0.0.1`,
		`https://${SITE}/blank`,
	]);
	let port: Awaited<ReturnType<typeof machineChromiumPort>> = "absent";
	for (let i = 0; i < 150 && typeof port !== "object"; i++) {
		await delay(200);
		port = await machineChromiumPort();
	}
	if (typeof port !== "object") throw new Error(`Chromium's DevTools port was not found: ${port}`);
	console.log(`Chromium's DevTools port: 127.0.0.1:${port.port}`);
	const tab = await Tab.open();
	await tab.until(`location.host === "${SITE}" && document.readyState === "complete"`, "the first page");
	const evil = () => tab.visit("/autofocus", EVIL);

	await check("the account's own page gets the value whole", async () => {
		await tab.visit("/sign-in");
		const since = heard.length;
		const code = await program();
		equal(code, "FILLED", "code");
		equal((await tab.values()).p, secret, "the box");
		for (let i = 0; i < 50 && !heard.slice(since).some((entry) => entry.value === secret); i++) await delay(100);
		equal(
			heard.slice(since).some((entry) => entry.host === SITE && entry.box === "p" && entry.value === secret),
			true,
			"the page heard the value",
		);
		return code;
	});

	// F1: the tab goes to another site between two of the helper's steps after the box opened. Before the fix, the helper
	// made its isolated world again in the new document and typed into its autofocused password box.
	for (const [method, after] of [
		["address", "the address was read"],
		["stop", "the page was checked for a person check"],
		["focus", "the box was found"],
	] as const)
		await check(`a redirect after ${after} types nothing`, async () => {
			await tab.visit("/sign-in");
			const since = heard.length;
			const code = await inProcess({ method, call: 2, when: "after", run: evil });
			const values = await tab.values();
			equal(values.host, EVIL, "the tab's site");
			equal(values.p, "", "the other site's box");
			nothingHeardOn(EVIL, since);
			equal(code, "FILL_PAGE_CHANGED", "code");
			return code;
		});
	await check("the same address loaded again during the check types nothing", async () => {
		await tab.visit("/sign-in");
		const code = await inProcess({ method: "address", call: 2, when: "after", run: () => tab.visit("/sign-in") });
		equal((await tab.values()).p, "", "the reloaded page's box");
		equal(code, "FILL_PAGE_CHANGED", "code");
		return code;
	});
	await check("a redirect while the vault seals types nothing", async () => {
		await tab.visit("/sign-in");
		const since = heard.length;
		const code = await program({ whileSealing: evil });
		equal((await tab.values()).p, "", "the other site's box");
		nothingHeardOn(EVIL, since);
		equal(code, "FILL_PAGE_CHANGED", "code");
		return code;
	});

	// F2: the box held text as long as the value, and the page moved the focus.
	await check("a select handler that moves the focus gets nothing", async () => {
		await tab.visit("/select-moves");
		const code = await program();
		const values = await tab.values();
		equal(values.sink, "", "the box the focus moved to");
		equal(code, "FILLED", "code");
		equal(values.p, secret, "the box");
		return code;
	});
	await check("the focus moved as the value went in: wherever it went is emptied, or the tab must go", async () => {
		await tab.visit("/beforeinput-moves");
		const code = await program();
		const values = await tab.values();
		const saw = `${code}, the box ${describe(values.p)}, the box the focus moved to ${describe(values.sink)}`;
		if (code === "FILLED" && (values.p !== secret || values.sink !== "")) throw new Error(saw);
		if (code === "FILL_UNCONFIRMED" && (values.p !== "" || values.sink !== "")) throw new Error(saw);
		if (!["FILLED", "FILL_UNCONFIRMED", "FILL_LOST"].includes(code)) throw new Error(saw);
		return saw;
	});
	await check("the focus moved once the value was in: both boxes emptied", async () => {
		await tab.visit("/input-moves");
		const code = await program();
		const values = await tab.values();
		equal(values.sink, "", "the box the focus moved to");
		equal(values.p, "", "the box");
		equal(code, "FILL_UNCONFIRMED", "code");
		return code;
	});

	// F3: the value went in, and what became of it cannot be confirmed.
	await check("the page leaves for another site as the value goes in: lost", async () => {
		await tab.visit("/input-leaves");
		const code = await program();
		equal(code, "FILL_LOST", "code");
		return code;
	});
	await check("the page stops answering once the value is in: lost", async () => {
		await tab.visit("/input-hangs");
		const code = await program();
		await tab.until("true", "the page to answer again");
		equal(code, "FILL_LOST", "code");
		return code;
	});
	await check("the deadline passes once the value went in: lost", async () => {
		await tab.visit("/input-hangs");
		const code = await inProcess({
			method: "insert",
			call: 1,
			when: "before",
			run: async (deadline) => {
				setTimeout(() => deadline.abort(), 1000);
			},
		});
		await tab.until("true", "the page to answer again");
		equal(code, "FILL_LOST", "code");
		return code;
	});

	await check("another site's page is refused before the vault", async () => {
		await evil();
		const code = await program({ hosts: [SITE] });
		equal((await tab.values()).p, "", "the other site's box");
		equal(code, "FILL_WRONG_SITE", "code");
		return code;
	});
	server.close();
}

try {
	await main();
} catch (error) {
	failed += 1;
	console.log(`FAIL the probe: ${hide(error instanceof Error ? error.message : String(error))}`);
	console.log(execFileSync("ps", ["-eo", "pid,user,args", "--cols", "160"], { encoding: "utf8" }));
	for (const log of ["xvnc", "openbox", "chromium"])
		if (existsSync(`/tmp/${log}.log`))
			console.log(`--- ${log}\n${readFileSync(`/tmp/${log}.log`, "utf8").slice(-3000)}`);
} finally {
	for (const child of children.reverse()) child.kill("SIGKILL");
}
console.log(failed === 0 ? "PROBE PASSED" : `PROBE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
