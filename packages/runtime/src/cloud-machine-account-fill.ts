import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { isUuid } from "@qorpera/contracts";
import { type CompanyAccountFill, CompanyComputerFillKey } from "./cloud-company-account-fill-box.ts";
import { companyAccountFillHost } from "./cloud-company-computer-account-fill.ts";
import {
	COMPANY_COMPUTER_SITE_SAMPLE,
	COMPANY_COMPUTER_SITE_STOP_CODES,
	type CompanyComputerSiteStopReason,
	companyComputerCheckFrame,
	companyComputerSiteStop,
} from "./cloud-company-computer-site-stops.ts";

/* fill_company_account's helper on a company machine (20260930711000; Jonas, 10 November 2026: "Build machine sign-ins").
 * The agent opened the account's sign-in page with `desktop open` and clicked into the field. The coding executor runs
 * this fixed program, shipped in the machine image beside the guest helper (never anything the agent wrote), as root on
 * the boot the database named, in one exec whose stdin and stdout stay open for the exchange:
 * 1. stdin's first line is the executor's target (qorpera_authorize_machine_account_fill): what the box is bound to and
 *    the account's site and sign-in hosts. The helper checks the focused tab against them (below) before anything is
 *    asked of the vault, makes an X25519 key pair in memory, and prints one line: the public half, or why not.
 * 2. The executor asks the vault, which seals the value to that key, bound to this call's receipt and the machine's
 *    placement and boot; stdin's second line is that box (or stdin ends: the vault refused, and the executor says why).
 * 3. The helper opens the box in memory (only for exactly this identity on this boot, and within its lifetime), checks the
 *    tab again against the hosts sealed inside it, sets the value on the focused box from inside the checked document,
 *    and prints one line: FILLED or a refusal code. Then it waits for stdin to end and exits.
 * The page check, as the office's (cloud-company-computer-account-fill.ts) and A1-4c's stop: the one tab whose window has
 * the focus, its main frame on the account's site or one of its sign-in hosts over https; the focused element in that
 * document itself (not in a frame), an input box of the field's kind; and no CAPTCHA, human check, unusual activity
 * warning or block shown. Both checks and the typing are bound to the one document the tab showed at the first look
 * (reviews of #1644): any navigation of the tab from then on, to another document or within this one, refuses before
 * anything is typed (FILL_PAGE_CHANGED), and one seen once the value is in is FILL_LOST. The value is never typed at
 * the tab (CDP Input.insertText reaches whatever document the tab shows when it lands): one call on the checked box, in
 * the helper's own world of that document, checks the document, its address and the box's focus and sets the value with
 * the native setter, then fires input and change; if the document is gone the call fails and reaches no other. The value
 * counts as filled only when that same box, still with the focus, holds it exactly and a complete scan of the document,
 * every open shadow root and every frame of its own origin finds no other copy, twice, 200 ms apart. Once the value may
 * have reached the page, anything else is FILL_LOST (review round 3: no outcome says the page is clean; a page can copy
 * a value at any time): the box and every copy found are emptied, but the tab must still go.
 * It never prints, logs or writes the value: stdout carries the key's public half and codes only.
 * Buffers it holds are zeroed when done; the opened value is a string, which the process drops and exits with.
 * The agent is root on its machine: it can read the browser's memory and the page, or replace this program or the
 * browser. What the check protects against is a value typed somewhere it should not go by mistake or by a page's doing (a
 * look-alike or redirected site, a frame, a bot check), and the value reaching any tool output, chat, history or file.
 * The program itself is cloud-machine-account-fill-main.ts, which only the guest package bundles: this module is
 * imported by the runtime too (its codes), so it must never run anything when loaded. */

export const MACHINE_ACCOUNT_FILL_TARGET_SCHEMA = "qorpera.machine-account-fill-target/v1";
export const MACHINE_ACCOUNT_FILL_READY_SCHEMA = "qorpera.machine-account-fill-ready/v1";
export const MACHINE_ACCOUNT_FILL_RESULT_SCHEMA = "qorpera.machine-account-fill-result/v1";
/** Why the helper typed nothing, typed and took it back, or typed and could not take it back (FILL_LOST); each reaches the
 * agent (cloud-machine-tools.ts says what to do). */
export const MACHINE_ACCOUNT_FILL_REFUSALS = [
	/** No desktop runs on the machine. */
	"DESKTOP_NOT_RUNNING",
	/** No Chromium with the profile `desktop open` gives it runs on the desktop (or it stopped answering at the start). */
	"BROWSER_NOT_OPEN",
	/** The desktop's Chromium runs but holds no DevTools port on the loopback (started another way), or the port's answer is
	 * not that browser's. */
	"BROWSER_UNVERIFIED",
	/** No tab has the focus, or more than one. */
	"NO_FOCUSED_PAGE",
	/** The focused tab is not on the account's site or a sign-in host of it, over https. */
	"FILL_WRONG_SITE",
	/** The focus is inside a frame of the page. */
	"FILL_IN_FRAME",
	/** The focused element is not a box of the field's kind, or none has the focus (also: the focus left it before the
	 * value went in). Nothing was typed. */
	"FILL_WRONG_BOX",
	/** The tab navigated (to another document, or within this one), loaded again, closed or crashed while the helper
	 * checked it. Nothing was typed. */
	"FILL_PAGE_CHANGED",
	"SITE_STOP_CAPTCHA",
	"SITE_STOP_HUMAN_CHECK",
	"SITE_STOP_UNUSUAL_ACTIVITY",
	"SITE_STOP_BLOCKED",
	/** The value may still be on the page: it was set (or may have been) and is not verified filled. The box did not keep
	 * it exactly or lost the focus, the page copied it elsewhere, the scan could not finish, the tab navigated once it was
	 * in, or the browser stopped answering or the deadline passed once it was handed over. The tab must go before any
	 * picture. */
	"FILL_LOST",
	/** The vault's box did not open here: another identity, another boot, or past its lifetime. */
	"FILL_BOX_REFUSED",
	/** stdin ended without a box: the executor says why (the vault's refusal). */
	"FILL_NO_BOX",
	/** The helper's own deadline passed before anything was typed. */
	"FILL_EXPIRED",
	/** The browser stopped answering before anything was typed. */
	"BROWSER_NOT_ANSWERING",
	/** The machine restarted since the executor read where it runs. */
	"MACHINE_BOOT_CHANGED",
	/** The target on stdin is not one. */
	"FILL_TARGET_INVALID",
] as const;
export type MachineAccountFillRefusal = (typeof MACHINE_ACCOUNT_FILL_REFUSALS)[number];
export type MachineAccountFillCode = "FILLED" | MachineAccountFillRefusal;

/** What a field's box must be, as the office's (cloud-company-computer-account-fill.ts). */
const BOX_TYPES: Readonly<Record<"login" | "password" | "code", readonly string[]>> = {
	login: ["text", "email", "tel"],
	password: ["password"],
	code: ["text", "tel", "number", "password"],
};
/** The helper's whole run, from its start: within the executor's deadline (company-machine-host.ts). */
export const MACHINE_ACCOUNT_FILL_MS = 20_000;
/** The target on stdin is small; a box is five base64url parts of at most a few KiB. */
const TARGET_MAX_BYTES = 8192;
const BOX_MAX_BYTES = 16384;

/** The focused element of a tab's own document, as the page check reads it. */
export type MachineFillFocus =
	| { readonly kind: "none" }
	| { readonly kind: "frame" }
	| { readonly kind: "other" }
	| { readonly kind: "input"; readonly type: string; readonly usable: boolean };

/** The tab left the document the helper bound to (it navigated, to another document or within this one, loaded again,
 * closed or crashed): thrown by a bound page's reads. Before anything was typed it is FILL_PAGE_CHANGED. */
export class MachineFillPageChanged extends Error {
	constructor() {
		super("FILL_PAGE_CHANGED");
	}
}

/** Where an insert left the value: exactly in the box `focus` read, still focused, and in no other box (filled); nothing
 * set because the focus left that box (moved) or the tab left the bound document or the account's hosts (changed); or set,
 * or maybe set, and not verified filled (lost). */
export type MachineFillLanded = "filled" | "moved" | "changed" | "lost";

/** One tab of the desktop's Chromium, as the helper reads and types into it. */
export interface MachineFillPage {
	/** The browser's id of the tab. */
	readonly id: string;
	/** Binds this tab's reads and the insert to the document it shows now (its main frame's loader, a world of the
	 * helper's own made in it, and the tab's navigation events from then on); bound already, it checks the tab is still
	 * on that document. Every read throws MachineFillPageChanged once the tab left it. */
	bind(): Promise<void>;
	/** The tab's main frame address, as the browser keeps it. */
	address(): Promise<string>;
	/** What the tab shows that asks for a person: frames of a CAPTCHA or human check service first, then its title and
	 * the top of its text (A1-4c). */
	stop(): Promise<CompanyComputerSiteStopReason | undefined>;
	/** The element that has the focus in the tab's own document; the next insert types only into it. */
	focus(): Promise<MachineFillFocus>;
	/** Sets the value on the box `focus` read, in one call inside the bound document that first checks the document, its
	 * address against `hosts` and the box's focus; then looks where the value is, and checks the bound document is still
	 * at an allowed address. Once the value may have been set it never throws: what it cannot confirm is lost. */
	insert(value: string, hosts: readonly string[]): Promise<MachineFillLanded>;
}

export interface MachineFillBrowser {
	/** The one tab whose window has the focus, or why none. */
	focusedPage(): Promise<MachineFillPage | "none" | "many">;
	close(): void;
}

export interface MachineAccountFillPorts {
	/** The kernel's boot id (/proc/sys/kernel/random/boot_id). */
	bootId(): Promise<string>;
	/** The desktop's Chromium through the DevTools port `desktop open` gave it, or why not. */
	browser(
		signal: AbortSignal,
	): Promise<MachineFillBrowser | "DESKTOP_NOT_RUNNING" | "BROWSER_NOT_OPEN" | "BROWSER_UNVERIFIED">;
	/** A key pair for this call, in memory only (the tests' own may differ). */
	key(): CompanyComputerFillKey;
	now(): number;
}

const TARGET_KEYS = [
	"accountId",
	"bootId",
	"companyId",
	"companyMachineId",
	"field",
	"hosts",
	"placementId",
	"receiptId",
	"schema",
].join();
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface Target {
	readonly companyId: string;
	readonly companyMachineId: string;
	readonly placementId: string;
	readonly bootId: string;
	readonly receiptId: string;
	readonly accountId: string;
	readonly field: "login" | "password" | "code";
	readonly hosts: readonly string[];
}

/** The executor's target, or null: every field the database answers, and nothing else. */
export function parseMachineAccountFillTarget(value: unknown): Target | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join() !== TARGET_KEYS || input.schema !== MACHINE_ACCOUNT_FILL_TARGET_SCHEMA)
		return null;
	const ids = [
		input.companyId,
		input.companyMachineId,
		input.placementId,
		input.bootId,
		input.receiptId,
		input.accountId,
	];
	const hosts = input.hosts;
	if (
		!ids.every((id) => isUuid(id)) ||
		(input.field !== "login" && input.field !== "password" && input.field !== "code") ||
		!Array.isArray(hosts) ||
		hosts.length < 1 ||
		hosts.length > 5 ||
		!hosts.every((host) => typeof host === "string" && host.length <= 253 && HOST.test(host)) ||
		new Set(hosts).size !== hosts.length
	)
		return null;
	return {
		companyId: input.companyId as string,
		companyMachineId: input.companyMachineId as string,
		placementId: input.placementId as string,
		bootId: input.bootId as string,
		receiptId: input.receiptId as string,
		accountId: input.accountId as string,
		field: input.field,
		hosts: [...(hosts as string[])],
	};
}

/** Why a tab may not get the field's value now, or undefined: the site over https, no bot check, a box of the field's
 * kind with the focus in the tab's own document. */
async function pageRefusal(
	page: MachineFillPage,
	hosts: readonly string[],
	field: Target["field"],
): Promise<MachineAccountFillRefusal | undefined> {
	if (companyAccountFillHost(await page.address(), hosts) === null) return "FILL_WRONG_SITE";
	const stop = await page.stop();
	if (stop) return COMPANY_COMPUTER_SITE_STOP_CODES[stop] as MachineAccountFillRefusal;
	const focus = await page.focus();
	if (focus.kind === "frame") return "FILL_IN_FRAME";
	if (focus.kind !== "input" || !focus.usable || !BOX_TYPES[field].includes(focus.type)) return "FILL_WRONG_BOX";
	return undefined;
}

/** Lines off stdin, each within its bound: the bytes up to a newline, or null once stdin ends (or a line is too long). */
class LineReader {
	readonly #source: AsyncIterator<Buffer | string>;
	#held: Buffer = Buffer.alloc(0);
	#ended = false;
	constructor(stdin: AsyncIterable<Buffer | string>) {
		this.#source = stdin[Symbol.asyncIterator]();
	}
	async line(maxBytes: number): Promise<Buffer | null> {
		for (;;) {
			const end = this.#held.indexOf(10);
			if (end >= 0) {
				const line = Buffer.from(this.#held.subarray(0, end));
				const rest = Buffer.from(this.#held.subarray(end + 1));
				this.#held.fill(0);
				this.#held = rest;
				if (line.length <= maxBytes) return line;
				line.fill(0);
				return null;
			}
			if (this.#held.length > maxBytes || this.#ended) {
				this.#held.fill(0);
				this.#held = Buffer.alloc(0);
				return null;
			}
			const next = await this.#source.next();
			if (next.done) {
				this.#ended = true;
				continue;
			}
			const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
			const joined = Buffer.concat([this.#held, chunk]);
			this.#held.fill(0);
			if (typeof next.value !== "string") chunk.fill(0);
			this.#held = joined;
		}
	}
	/** Reads stdin to its end, keeping nothing. */
	async drain(): Promise<void> {
		this.#held.fill(0);
		this.#held = Buffer.alloc(0);
		if (this.#ended) return;
		for (;;) {
			const next = await this.#source.next();
			if (next.done) break;
			if (typeof next.value !== "string") next.value.fill(0);
		}
		this.#ended = true;
	}
}

function json(line: Buffer | null): unknown {
	if (!line) return null;
	try {
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line));
	} catch {
		return null;
	} finally {
		line.fill(0);
	}
}

/** An insert's outcome as the helper prints it: verified filled, nothing set (moved, changed), or the value maybe still
 * on the page (lost). */
const LANDED_CODES: Readonly<Record<MachineFillLanded, MachineAccountFillCode>> = {
	filled: "FILLED",
	moved: "FILL_WRONG_BOX",
	changed: "FILL_PAGE_CHANGED",
	lost: "FILL_LOST",
};

/** Resolves when the signal aborts. */
function aborted(signal: AbortSignal): Promise<"expired"> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve("expired");
		else signal.addEventListener("abort", () => resolve("expired"), { once: true });
	});
}

/**
 * One fill, as the executor runs it: the target off stdin, the page checked, the key's public half printed, the box off
 * stdin, opened for exactly this call on this boot, the page checked against the hosts sealed in it, the value typed, a
 * code printed. Every line it prints is the key's public half or a code; the value is never in one.
 */
export async function fillAccountOnMachine(options: {
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(text: string): unknown };
	ports: MachineAccountFillPorts;
	signal: AbortSignal;
}): Promise<MachineAccountFillCode> {
	const { ports, signal } = options;
	const lines = new LineReader(options.stdin);
	const say = (value: Record<string, string>) => options.stdout.write(`${JSON.stringify(value)}\n`);
	// One result line at most, whatever ends the run first.
	let answered: MachineAccountFillCode | undefined;
	const result = (code: MachineAccountFillCode): MachineAccountFillCode => {
		if (answered) return answered;
		answered = code;
		say({ schema: MACHINE_ACCOUNT_FILL_RESULT_SCHEMA, code });
		return code;
	};
	let browser: MachineFillBrowser | undefined;
	// Whether the value may have been handed to the browser: from then on, whatever ends the run before the page
	// confirmed where the value went (a failure, the deadline) is FILL_LOST.
	let typed = false;
	const run = async (): Promise<MachineAccountFillCode> => {
		const target = parseMachineAccountFillTarget(json(await lines.line(TARGET_MAX_BYTES)));
		if (!target) return result("FILL_TARGET_INVALID");
		const boot = (await ports.bootId()).trim();
		if (boot !== target.bootId) return result("MACHINE_BOOT_CHANGED");
		const opened = await ports.browser(signal);
		if (typeof opened === "string") return result(opened);
		browser = opened;
		if (signal.aborted) return result("FILL_EXPIRED");
		const page = await browser.focusedPage();
		if (page === "none" || page === "many") return result("NO_FOCUSED_PAGE");
		// Both checks and the typing run in the document the tab shows now: any navigation from here refuses.
		await page.bind();
		// Before the vault is asked: the tab against the account's hosts as the database names them.
		const early = await pageRefusal(page, target.hosts, target.field);
		if (early) return result(early);
		if (signal.aborted) return result("FILL_EXPIRED");
		const key = ports.key();
		say({ schema: MACHINE_ACCOUNT_FILL_READY_SCHEMA, publicKey: key.publicKey });
		const box = json(await lines.line(BOX_MAX_BYTES));
		if (!box) return result("FILL_NO_BOX");
		let fill: CompanyAccountFill;
		try {
			fill = key.open(
				box,
				{
					companyId: target.companyId,
					companyMachineId: target.companyMachineId,
					placementId: target.placementId,
					// This boot's own id: a box for another boot never opens here.
					bootId: boot,
					receiptId: target.receiptId,
					accountId: target.accountId,
					field: target.field,
				},
				ports.now(),
			);
		} catch {
			return result("FILL_BOX_REFUSED");
		}
		// The same tab still has the focus, on the same document, and passes again against the hosts sealed in the box.
		const now = await browser.focusedPage();
		if (now === "none" || now === "many" || now.id !== page.id) return result("NO_FOCUSED_PAGE");
		await now.bind();
		const late = await pageRefusal(now, fill.hosts, target.field);
		if (late) return result(late);
		// Past the deadline nothing is typed: the result is already out.
		if (signal.aborted) return result("FILL_EXPIRED");
		typed = true;
		const landed = await now.insert(fill.value, fill.hosts);
		return result(LANDED_CODES[landed]);
	};
	try {
		// A failure (the browser stopped answering, its connection closed, the tab left the document) is a code too: once
		// the value may have been handed over, that it may still be on the page.
		const running = run().catch((error: unknown) =>
			result(
				typed
					? "FILL_LOST"
					: error instanceof MachineFillPageChanged
						? "FILL_PAGE_CHANGED"
						: "BROWSER_NOT_ANSWERING",
			),
		);
		const outcome = await Promise.race([running, aborted(signal)]);
		if (outcome === "expired") return result(typed ? "FILL_LOST" : "FILL_EXPIRED");
		// The executor ends stdin once it has the last line; reading it to its end lets the exec end cleanly.
		await Promise.race([lines.drain().catch(() => undefined), aborted(signal)]);
		return outcome;
	} finally {
		browser?.close();
	}
}

/* The desktop's Chromium, through its DevTools port. */

/** The display the desktop runs on (deploy/machine/desktop-session), and its socket. */
const DISPLAY_SOCKET = "/tmp/.X11-unix/X1";
/** The pinned Chromium (deploy/machine/build-machine-image.sh), and the profile `desktop open` gives it with a loopback
 * DevTools port of the kernel's choosing (`--remote-debugging-port=0`). */
export const MACHINE_CHROMIUM = "/usr/lib/qorpera-chromium/chrome";
export const MACHINE_CHROMIUM_PROFILE = "/home/desktop/.config/qorpera-chromium";
/** How long one DevTools call may take. */
const CALL_MS = 3000;

/** The user id of the desktop's account, from /etc/passwd. */
async function desktopUid(root: string): Promise<number | null> {
	try {
		const line = (await readFile(`${root}/etc/passwd`, "utf8"))
			.split("\n")
			.find((entry) => entry.startsWith("desktop:"));
		const uid = line?.split(":")[2];
		return uid && /^[0-9]+$/.test(uid) ? Number(uid) : null;
	} catch {
		return null;
	}
}

/**
 * The DevTools port of the desktop's own Chromium, read off the kernel rather than any file a program could write: the
 * browser process (not a renderer or helper) running the pinned Chromium as the desktop's account with the profile
 * `desktop open` gives it, and the TCP socket it holds listening on 127.0.0.1. Of two such processes (a second `desktop
 * open` that hands its address to the running browser and exits), the oldest is the browser. "absent" when no such browser
 * runs; "other" when it runs but listens on no loopback port (started another way, without `desktop open`).
 */
export async function machineChromiumPort(
	options: { proc?: string; root?: string; chromium?: string; profile?: string } = {},
): Promise<{ port: number } | "absent" | "other"> {
	const proc = options.proc ?? "/proc";
	const chromium = options.chromium ?? MACHINE_CHROMIUM;
	const profile = `--user-data-dir=${options.profile ?? MACHINE_CHROMIUM_PROFILE}`;
	const uid = await desktopUid(options.root ?? "");
	if (uid === null) return "absent";
	const browsers: { started: bigint; sockets: Set<string> }[] = [];
	for (const pid of (await readdir(proc)).filter((name) => /^[1-9][0-9]*$/.test(name))) {
		try {
			if ((await readlink(`${proc}/${pid}/exe`)) !== chromium) continue;
			if (Number(/^Uid:\s+([0-9]+)/m.exec(await readFile(`${proc}/${pid}/status`, "utf8"))?.[1]) !== uid) continue;
			const argv = (await readFile(`${proc}/${pid}/cmdline`, "utf8")).split("\0");
			if (!argv.includes(profile) || argv.some((argument) => argument.startsWith("--type="))) continue;
			// The process's start, in clock ticks since boot: field 22 of its stat, after the command name's parenthesis.
			const stat = await readFile(`${proc}/${pid}/stat`, "utf8");
			const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			if (!started || !/^[0-9]+$/.test(started)) continue;
			const sockets = new Set<string>();
			for (const fd of await readdir(`${proc}/${pid}/fd`)) {
				const link = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
				const inode = /^socket:\[([0-9]+)\]$/.exec(link)?.[1];
				if (inode) sockets.add(inode);
			}
			browsers.push({ started: BigInt(started), sockets });
		} catch {
			// A process that ended meanwhile.
		}
	}
	if (browsers.length === 0) return "absent";
	browsers.sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
	const browser = browsers[0] as { sockets: Set<string> };
	try {
		for (const line of (await readFile(`${proc}/net/tcp`, "utf8")).split("\n").slice(1)) {
			// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
			const fields = line.trim().split(/\s+/);
			const local = /^0100007F:([0-9A-F]{4})$/.exec(fields[1] ?? "");
			if (local?.[1] && fields[3] === "0A" && fields[9] && browser.sockets.has(fields[9]))
				return { port: Number.parseInt(local[1], 16) };
		}
	} catch {
		return "other";
	}
	return "other";
}

/** The browser's own DevTools address, as it answers on the loopback port: ws://127.0.0.1:<port>/devtools/browser/<id>. */
async function browserAddress(port: number, signal: AbortSignal): Promise<string | null> {
	try {
		const answer = await fetch(`http://127.0.0.1:${port}/json/version`, {
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
		});
		if (answer.status !== 200) return null;
		const text = await answer.text();
		if (text.length > 8192) return null;
		const address = (JSON.parse(text) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
		return typeof address === "string" &&
			new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/[0-9a-f-]{36}$`).test(address)
			? address
			: null;
	} catch {
		return null;
	}
}

type DevToolsMessage = {
	id?: number;
	result?: unknown;
	error?: { message?: string };
	method?: string;
	params?: unknown;
	sessionId?: string;
};
type DevToolsListener = (method: string, params: Record<string, unknown>) => void;

/** One DevTools connection over the global WebSocket: calls by id, and the events of the sessions something listens to
 * (the bound tab's navigations). */
class DevTools {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	readonly #listeners = new Map<string, DevToolsListener>();
	#next = 1;
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			let message: DevToolsMessage;
			try {
				message = JSON.parse(event.data) as DevToolsMessage;
			} catch {
				return;
			}
			if (message.id === undefined) {
				if (typeof message.method !== "string") return;
				const params =
					message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
				// A session's own events, and the browser's word that a session ended.
				const session =
					message.sessionId ??
					(message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string"
						? params.sessionId
						: undefined);
				if (session !== undefined) this.#listeners.get(session)?.(message.method, params);
				return;
			}
			const waiting = this.#pending.get(message.id);
			if (!waiting) return;
			this.#pending.delete(message.id);
			if (message.error || !message.result || typeof message.result !== "object")
				waiting.reject(new Error("DEVTOOLS_CALL_FAILED"));
			else waiting.resolve(message.result as Record<string, unknown>);
		});
		const fail = () => {
			for (const waiting of this.#pending.values()) waiting.reject(new Error("DEVTOOLS_CLOSED"));
			this.#pending.clear();
			// Nothing more will be heard from any session: as if each ended.
			for (const listener of this.#listeners.values()) listener("Inspector.detached", {});
		};
		socket.addEventListener("close", fail);
		socket.addEventListener("error", fail);
	}
	static connect(url: string, signal: AbortSignal): Promise<DevTools> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error("DEVTOOLS_UNREACHABLE"));
			}, CALL_MS);
			const stop = () => {
				clearTimeout(timer);
				socket.close();
				reject(new Error("DEVTOOLS_UNREACHABLE"));
			};
			signal.addEventListener("abort", stop, { once: true });
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", stop);
				resolve(new DevTools(socket));
			});
			socket.addEventListener("error", stop);
		});
	}
	/** Hears every event of one session from now on. */
	listen(sessionId: string, listener: DevToolsListener): void {
		this.#listeners.set(sessionId, listener);
	}
	call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = this.#next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("DEVTOOLS_CALL_TIMEOUT"));
			}, CALL_MS);
			this.#pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			} catch {
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(new Error("DEVTOOLS_CLOSED"));
			}
		});
	}
	close(): void {
		this.#socket.close();
	}
}

/* Functions the page check runs in the tab's isolated world (its own globals, the page's document): the page's scripts
 * cannot change what they read by replacing a built-in. */

/** The element with the focus, through open shadow roots. */
const DEEP_ACTIVE = `(() => {
	let element = document.activeElement;
	while (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
	return element ?? document.body ?? document.documentElement;
})()`;
const DESCRIBE = `function () {
	const tag = this.tagName;
	if (tag === "IFRAME" || tag === "FRAME" || tag === "OBJECT" || tag === "EMBED") return { kind: "frame" };
	if (tag === "BODY" || tag === "HTML") return { kind: "none" };
	if (tag !== "INPUT") return { kind: "other" };
	return { kind: "input", type: this.type, usable: !this.disabled && !this.readOnly && this.isConnected };
}`;
/** Whether the element (a frame of the page) is shown. */
const VISIBLE = `function () {
	if (!this.isConnected) return false;
	if (typeof this.checkVisibility === "function" && !this.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
		return false;
	const box = this.getBoundingClientRect();
	return box.width > 0 && box.height > 0;
}`;
/** The frames in the document and its open shadow roots, as their elements name them, and whether each is shown. */
const FRAMES = `(() => {
	const found = [];
	const visible = ${VISIBLE};
	const walk = (root, depth) => {
		for (const element of root.querySelectorAll("iframe, frame")) found.push({ url: element.src || "", visible: visible.call(element) });
		if (depth < 4) for (const host of root.querySelectorAll("*")) if (host.shadowRoot) walk(host.shadowRoot, depth + 1);
	};
	walk(document, 0);
	return found.slice(0, 64);
})()`;
const SHOWN = `(() => {
	const text = (document.body && document.body.innerText) || "";
	return { title: document.title, text: text.slice(0, ${COMPANY_COMPUTER_SITE_SAMPLE}), length: text.length };
})()`;
/** Sets the value on the box (`this`, an object of the helper's world in the bound document), in this one call: only in
 * the document the helper stamped (a call on a document that is gone fails in the browser and reaches no other), at an
 * address the account allows, with this box connected and focused. The native setter of the box's own prototype (the
 * helper's world, which no page script can replace) sets it as typing would, so a framework that tracks the box's value
 * sees it change on the input and change events that follow. Nothing is set otherwise. */
const SET = `function (value, hosts, stamp) {
	if (globalThis.qorperaAccountFillDocument !== stamp || this.ownerDocument !== document) return "changed";
	const address = new URL(location.href);
	if (address.protocol !== "https:" || address.username || address.password || address.port || !hosts.includes(address.hostname))
		return "changed";
	let active = document.activeElement;
	while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
	if (!this.isConnected || active !== this || !document.hasFocus()) return "moved";
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, value);
	this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	this.dispatchEvent(new Event("change", { bubbles: true }));
	return "set";
}`;
/** How long the page's own reactions to the value get before each look where it is. */
const SETTLE_MS = 200;
/** How many elements and text nodes one scan of the page may visit before it gives up (and the value is lost). */
const SCAN_BUDGET = 250_000;
/** Where the value is, once the page reacted: filled only when this same box, connected and with the focus, holds it
 * exactly and a complete scan finds no copy in any other input or text area, and so again a settle later. The scan is
 * iterative, with no depth limit: the document, every open shadow root, and the document of every frame of its own
 * origin (iframe, frame, object). It is incomplete, and the value lost, past its budget, or when a frame's document
 * cannot be read although its window is of this origin. Anything but filled empties the box and every copy found (the
 * native setter, then an input event so the page's own state follows) and answers lost: a page can copy the value again
 * at any time, so no answer says it is gone. */
const LANDED = `async function (value) {
	const settle = () => new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS}));
	const scan = () => {
		const copies = [];
		const roots = [document];
		let visited = 0;
		while (roots.length > 0) {
			const root = roots.pop();
			const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
			for (let element = walker.nextNode(); element; element = walker.nextNode()) {
				if (++visited > ${SCAN_BUDGET}) return { complete: false, copies };
				if (element.shadowRoot) roots.push(element.shadowRoot);
				const tag = element.tagName;
				if ((tag === "INPUT" || tag === "TEXTAREA") && element !== this && typeof element.value === "string" && element.value.includes(value))
					copies.push(element);
				if (tag === "IFRAME" || tag === "FRAME" || tag === "OBJECT") {
					let inner = null;
					try {
						inner = element.contentDocument;
					} catch {
						return { complete: false, copies };
					}
					if (inner) roots.push(inner);
					else if (element.contentWindow) {
						// No document to read: another origin's frame (its window refuses this origin), or one that cannot be read.
						try {
							void element.contentWindow.location.href;
							return { complete: false, copies };
						} catch {}
					}
				}
			}
		}
		return { complete: true, copies };
	};
	const kept = () => {
		let active = document.activeElement;
		while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
		return this.isConnected && active === this && this.value === value;
	};
	await settle();
	let look = scan();
	if (kept() && look.complete && look.copies.length === 0) {
		await settle();
		look = scan();
		if (kept() && look.complete && look.copies.length === 0) return "filled";
	}
	const empty = (field) => {
		const own = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(own, "value").set.call(field, "");
		field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	};
	empty(this);
	for (const field of look.copies) empty(field);
	return "lost";
}`;
/** The helper's isolated world in a tab: its own globals over the page's document. */
const WORLD = "qorpera-account-fill";
/** A tab's events that say its main frame left the document it showed, or is about to (its frame's id in the event). */
const NAVIGATIONS = new Set([
	"Page.frameRequestedNavigation",
	"Page.frameScheduledNavigation",
	"Page.frameStartedNavigating",
	"Page.frameStartedLoading",
	"Page.frameNavigated",
	"Page.navigatedWithinDocument",
	"Page.documentOpened",
	"Page.frameDetached",
]);
/** A tab's events that say it went altogether: closed, crashed, or its session ended. */
const ENDINGS = new Set(["Inspector.detached", "Inspector.targetCrashed", "Target.detachedFromTarget"]);

interface FrameTree {
	frame: { id: string; url: string; loaderId: string };
	childFrames?: FrameTree[];
}

/** One tab, through a flat DevTools session attached to it. Unbound, it only answers whether it has the focus; bound
 * (`bind`), every read and the insert run in the one document it showed then. */
class DevToolsPage implements MachineFillPage {
	readonly id: string;
	readonly #tools: DevTools;
	readonly #session: string;
	/** Before `bind`: a world in whatever document the tab shows, made again after a navigation (only to read whether
	 * the tab has the focus). */
	#world: number | undefined;
	/** After `bind`: the main frame, the loader of its document then, the helper's world made in that document, and the
	 * stamp the helper left in that world (a world's globals belong to one document). */
	#document: { frameId: string; loaderId: string; world: number; stamp: string } | undefined;
	/** The tab's main frame id, once known; and whether the browser said the tab left the bound document since. */
	#main: string | undefined;
	#changed = false;
	#focused: string | undefined;
	constructor(tools: DevTools, id: string, session: string) {
		this.#tools = tools;
		this.id = id;
		this.#session = session;
	}
	async #tree(): Promise<FrameTree> {
		return (await this.#tools.call("Page.getFrameTree", {}, this.#session)).frameTree as FrameTree;
	}
	async #isolatedWorld(frameId: string): Promise<number> {
		const made = await this.#tools.call(
			"Page.createIsolatedWorld",
			{ frameId, worldName: WORLD, grantUniveralAccess: false },
			this.#session,
		);
		if (typeof made.executionContextId !== "number") throw new Error("DEVTOOLS_CALL_FAILED");
		return made.executionContextId;
	}
	async bind(): Promise<void> {
		if (this.#document) {
			await this.#unchanged();
			return;
		}
		// The main frame's id stays the tab's across its navigations; from now on every navigation event of it is heard
		// (the Page domain's, never the Runtime domain's, which sites can notice).
		this.#main = (await this.#tree()).frame.id;
		this.#tools.listen(this.#session, (method, params) => {
			const frame =
				typeof params.frameId === "string" ? params.frameId : (params.frame as { id?: unknown } | undefined)?.id;
			if (ENDINGS.has(method) || (NAVIGATIONS.has(method) && frame === this.#main)) this.#changed = true;
		});
		await this.#tools.call("Page.enable", {}, this.#session);
		// The world is the document's whose loader was read before and after it was made and stamped, with no navigation
		// between.
		const before = (await this.#tree()).frame;
		const world = await this.#isolatedWorld(before.id);
		const stamp = randomUUID();
		const stamped = await this.#tools.call(
			"Runtime.evaluate",
			{ expression: `globalThis.qorperaAccountFillDocument = "${stamp}"`, contextId: world, returnByValue: true },
			this.#session,
		);
		const after = (await this.#tree()).frame;
		if (
			stamped.exceptionDetails ||
			this.#changed ||
			before.id !== this.#main ||
			after.id !== before.id ||
			after.loaderId !== before.loaderId
		)
			throw new MachineFillPageChanged();
		this.#document = { frameId: before.id, loaderId: before.loaderId, world, stamp };
	}
	/** The bound document's frame tree as the browser keeps it now; refuses once the tab left that document. */
	async #unchanged(): Promise<FrameTree> {
		const bound = this.#document;
		if (!bound) throw new Error("FILL_PAGE_NOT_BOUND");
		if (this.#changed) throw new MachineFillPageChanged();
		const tree = await this.#tree();
		if (this.#changed || tree.frame.id !== bound.frameId || tree.frame.loaderId !== bound.loaderId)
			throw new MachineFillPageChanged();
		return tree;
	}
	/** One call in the bound document: one that fails because the document went, or that the tab navigated during, is the
	 * page's change. */
	async #within<T>(work: (world: number) => Promise<T>): Promise<T> {
		const bound = this.#document;
		if (!bound) throw new Error("FILL_PAGE_NOT_BOUND");
		if (this.#changed) throw new MachineFillPageChanged();
		let answer: T;
		try {
			answer = await work(bound.world);
		} catch (error) {
			await this.#unchanged();
			throw error;
		}
		if (this.#changed) throw new MachineFillPageChanged();
		return answer;
	}
	/** An expression in the helper's world of the bound document; never made again elsewhere. */
	async #evaluate(expression: string, byValue = true): Promise<{ value?: unknown; objectId?: string }> {
		const answer = await this.#within((world) =>
			this.#tools.call(
				"Runtime.evaluate",
				{ expression, contextId: world, returnByValue: byValue, awaitPromise: false },
				this.#session,
			),
		);
		if (answer.exceptionDetails) throw new Error("DEVTOOLS_CALL_FAILED");
		return (answer.result ?? {}) as { value?: unknown; objectId?: string };
	}
	async #on(objectId: string, declaration: string, args: unknown[] = [], awaitPromise = false): Promise<unknown> {
		const answer = await this.#within(() =>
			this.#tools.call(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration: declaration,
					arguments: args.map((value) => ({ value })),
					returnByValue: true,
					awaitPromise,
				},
				this.#session,
			),
		);
		if (answer.exceptionDetails) throw new Error("DEVTOOLS_CALL_FAILED");
		return (answer.result as { value?: unknown } | undefined)?.value;
	}
	/** Whether the tab is shown and its window has the focus: in the bound document once bound (a change refuses). */
	async focused(): Promise<boolean> {
		const expression = "document.visibilityState === 'visible' && document.hasFocus()";
		if (this.#document) return (await this.#evaluate(expression)).value === true;
		const call = async () => {
			this.#world ??= await this.#isolatedWorld((await this.#tree()).frame.id);
			return this.#tools.call(
				"Runtime.evaluate",
				{ expression, contextId: this.#world, returnByValue: true, awaitPromise: false },
				this.#session,
			);
		};
		let answer: Record<string, unknown>;
		try {
			answer = await call();
		} catch {
			// A navigation ends an unbound world: make it again once.
			this.#world = undefined;
			answer = await call();
		}
		return (answer.result as { value?: unknown } | undefined)?.value === true;
	}
	async address(): Promise<string> {
		return (await this.#unchanged()).frame.url;
	}
	async stop(): Promise<CompanyComputerSiteStopReason | undefined> {
		const reason = await this.#stop();
		// What was read is the bound document's: a navigation meanwhile is the change, not the stop.
		await this.#unchanged();
		return reason;
	}
	async #stop(): Promise<CompanyComputerSiteStopReason | undefined> {
		// The frames the browser keeps first (a page that does not answer still shows them): a check frame whose
		// element's visibility cannot be read counts, as on the office.
		const children: FrameTree[] = [];
		const walk = (node: FrameTree) => {
			for (const child of node.childFrames ?? []) {
				children.push(child);
				walk(child);
			}
		};
		walk(await this.#unchanged());
		for (const child of children.slice(0, 64)) {
			if (!companyComputerCheckFrame({ url: child.frame.url })) continue;
			let visible: boolean | undefined;
			try {
				const owner = await this.#tools.call("DOM.getFrameOwner", { frameId: child.frame.id }, this.#session);
				const node = await this.#within((world) =>
					this.#tools.call(
						"DOM.resolveNode",
						{ backendNodeId: owner.backendNodeId, executionContextId: world },
						this.#session,
					),
				);
				const objectId = (node.object as { objectId?: string } | undefined)?.objectId;
				if (objectId) visible = (await this.#on(objectId, VISIBLE)) === true;
			} catch {
				visible = undefined;
			}
			const reason = companyComputerCheckFrame({
				url: child.frame.url,
				...(visible === undefined ? {} : { visible }),
			});
			if (reason) return reason;
		}
		// The frames the page's own elements name, in the document and its open shadow roots.
		const named = (await this.#evaluate(FRAMES)).value;
		if (Array.isArray(named))
			for (const frame of named as Array<{ url?: unknown; visible?: unknown }>) {
				if (typeof frame.url !== "string" || typeof frame.visible !== "boolean") continue;
				const reason = companyComputerCheckFrame({ url: frame.url, visible: frame.visible });
				if (reason) return reason;
			}
		const shown = (await this.#evaluate(SHOWN)).value as { title?: unknown; text?: unknown; length?: unknown };
		return typeof shown?.title === "string" && typeof shown.text === "string" && typeof shown.length === "number"
			? companyComputerSiteStop({ title: shown.title, text: shown.text, length: shown.length })
			: undefined;
	}
	async focus(): Promise<MachineFillFocus> {
		const element = await this.#evaluate(DEEP_ACTIVE, false);
		this.#focused = element.objectId;
		if (!element.objectId) return { kind: "none" };
		const described = (await this.#on(element.objectId, DESCRIBE)) as Record<string, unknown> | undefined;
		if (described?.kind === "input")
			return {
				kind: "input",
				type: typeof described.type === "string" ? described.type : "",
				usable: described.usable === true,
			};
		return { kind: described?.kind === "frame" ? "frame" : described?.kind === "other" ? "other" : "none" };
	}
	async insert(value: string, hosts: readonly string[]): Promise<MachineFillLanded> {
		const box = this.#focused;
		const bound = this.#document;
		if (!box || !bound) return "moved";
		// Right before: still the bound document, at an address the account allows, with no navigation heard.
		try {
			if (companyAccountFillHost((await this.#unchanged()).frame.url, hosts) === null) return "changed";
		} catch (error) {
			if (error instanceof MachineFillPageChanged) return "changed";
			throw error;
		}
		if (this.#changed) return "changed";
		// The value is set on the box `focus` read, inside the bound document itself: the call runs in the helper's world of
		// that document, or the browser refuses it; it never reaches a document that replaced it (review round 2 of #1644).
		let set: unknown;
		try {
			const answer = await this.#tools.call(
				"Runtime.callFunctionOn",
				{
					objectId: box,
					functionDeclaration: SET,
					arguments: [{ value }, { value: [...hosts] }, { value: bound.stamp }],
					returnByValue: true,
				},
				this.#session,
			);
			set = answer.exceptionDetails ? "failed" : (answer.result as { value?: unknown } | undefined)?.value;
		} catch (error) {
			// The browser refused the call (the box's document is gone): it never ran. No answer at all: it may have.
			if (error instanceof Error && error.message === "DEVTOOLS_CALL_FAILED")
				return (await this.#unchanged().then(
					() => false,
					(failure: unknown) => failure instanceof MachineFillPageChanged,
				))
					? "changed"
					: "lost";
			return "lost";
		}
		if (set === "moved" || set === "changed") return set;
		if (set !== "set") return "lost";
		// From here the value is on the page: nothing below throws, and what is not confirmed is lost.
		try {
			const landed = await this.#on(box, LANDED, [value], true);
			// Right after: still the bound document (no navigation heard meanwhile), at an address the account allows.
			if (companyAccountFillHost((await this.#unchanged()).frame.url, hosts) === null) return "lost";
			return landed === "filled" ? "filled" : "lost";
		} catch {
			return "lost";
		}
	}
}

/** The desktop's Chromium, verified, with its tabs. */
class DevToolsBrowser implements MachineFillBrowser {
	readonly #tools: DevTools;
	readonly #pages = new Map<string, DevToolsPage>();
	constructor(tools: DevTools) {
		this.#tools = tools;
	}
	async focusedPage(): Promise<MachineFillPage | "none" | "many"> {
		const targets = (await this.#tools.call("Target.getTargets")).targetInfos;
		if (!Array.isArray(targets)) return "none";
		const focused: DevToolsPage[] = [];
		for (const target of (targets as Array<{ targetId?: unknown; type?: unknown }>).slice(0, 64)) {
			if (target.type !== "page" || typeof target.targetId !== "string") continue;
			let page = this.#pages.get(target.targetId);
			try {
				if (!page) {
					const attached = await this.#tools.call("Target.attachToTarget", {
						targetId: target.targetId,
						flatten: true,
					});
					if (typeof attached.sessionId !== "string") continue;
					page = new DevToolsPage(this.#tools, target.targetId, attached.sessionId);
					this.#pages.set(target.targetId, page);
				}
				if (await page.focused()) focused.push(page);
			} catch (error) {
				// The bound tab that left its document is the run's refusal; any other tab that does not answer (asleep,
				// closing) has no focus.
				if (error instanceof MachineFillPageChanged) throw error;
			}
		}
		if (focused.length > 1) return "many";
		return focused[0] ?? "none";
	}
	close(): void {
		this.#tools.close();
	}
}

/** The desktop's Chromium on this machine: the loopback DevTools port its browser process holds (`desktop open` starts it
 * with one), read off the kernel, then its DevTools over that port. The paths are the tests' own when given. */
export function machineChromium(
	options: { socket?: string; profile?: string; proc?: string; root?: string; chromium?: string } = {},
): MachineAccountFillPorts["browser"] {
	return async (signal) => {
		if (!existsSync(options.socket ?? DISPLAY_SOCKET)) return "DESKTOP_NOT_RUNNING";
		const port = await machineChromiumPort(options);
		if (port === "absent") return "BROWSER_NOT_OPEN";
		if (port === "other") return "BROWSER_UNVERIFIED";
		const address = await browserAddress(port.port, signal);
		if (!address) return "BROWSER_UNVERIFIED";
		try {
			return new DevToolsBrowser(await DevTools.connect(address, signal));
		} catch {
			return "BROWSER_NOT_OPEN";
		}
	};
}

/**
 * The program. With no arguments: the exchange above on stdin and stdout, exit 0. Any argument: the target refused. A
 * failure prints a fixed word on stderr and exits 1; the executor never shows either.
 */
export async function runMachineAccountFillCli(options: {
	argv: readonly string[];
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(text: string): unknown };
	ports?: MachineAccountFillPorts;
	deadlineMs?: number;
}): Promise<number> {
	if (options.argv.length > 0) {
		options.stdout.write(
			`${JSON.stringify({ schema: MACHINE_ACCOUNT_FILL_RESULT_SCHEMA, code: "FILL_TARGET_INVALID" })}\n`,
		);
		return 0;
	}
	const ports = options.ports ?? {
		bootId: () => readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		browser: machineChromium(),
		key: () => new CompanyComputerFillKey(),
		now: Date.now,
	};
	const deadline = AbortSignal.timeout(options.deadlineMs ?? MACHINE_ACCOUNT_FILL_MS);
	await fillAccountOnMachine({ stdin: options.stdin, stdout: options.stdout, ports, signal: deadline });
	return 0;
}
