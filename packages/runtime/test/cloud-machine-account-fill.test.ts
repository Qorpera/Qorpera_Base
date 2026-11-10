import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyComputerFillKey, sealCompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import type { CompanyComputerSiteStopReason } from "@qorpera/runtime/cloud-company-computer-site-stops";
import {
	fillAccountOnMachine,
	MACHINE_ACCOUNT_FILL_REFUSALS,
	type MachineAccountFillPorts,
	type MachineFillFocus,
	type MachineFillLanded,
	type MachineFillPage,
	MachineFillPageChanged,
	machineChromium,
	machineChromiumPort,
	parseMachineAccountFillTarget,
	runMachineAccountFillCli,
} from "@qorpera/runtime/cloud-machine-account-fill";
import { describe, expect, it, vi } from "vitest";

// 20260930710000: fill_company_account's helper on a company machine checks the focused tab, makes a key in memory,
// prints only its public half, opens the vault's box for exactly this call on this boot, checks the tab again against the
// hosts sealed in the box, types the value with CDP Input.insertText, and prints only a code. The browser is mocked here;
// the DevTools path is proved against a real Chromium (deploy/machine/build-machine-image.sh's check, and node02).

const now = 1_790_000_000_000;
const secret = "hunter2-Correct-Horse";

interface FakeTab {
	id: string;
	address: string;
	stop?: CompanyComputerSiteStopReason;
	focus: MachineFillFocus;
	landed?: MachineFillLanded;
	fails?: "address" | "insert";
	/** The tab left the document bound at the first look: by that look's bind, or by this look's address read. */
	changed?: "bind" | "address";
	/** The insert never settles: the browser stopped answering once the value was handed over. */
	hangs?: boolean;
}

/** One look at a tab; `seen` keeps each look's page and each insert's address check. */
function page(
	tab: FakeTab,
	typed: string[],
	seen: { pages: MachineFillPage[]; allowed: ((address: string) => boolean)[] },
): MachineFillPage {
	const found: MachineFillPage = {
		id: tab.id,
		bind: vi.fn(async () => {
			if (tab.changed === "bind") throw new MachineFillPageChanged();
		}),
		address: vi.fn(async () => {
			if (tab.fails === "address") throw new Error("DEVTOOLS_CALL_TIMEOUT");
			if (tab.changed === "address") throw new MachineFillPageChanged();
			return tab.address;
		}),
		stop: vi.fn(async () => tab.stop),
		focus: vi.fn(async () => tab.focus),
		insert: vi.fn(async (value: string, allowed: (address: string) => boolean) => {
			typed.push(value);
			seen.allowed.push(allowed);
			if (tab.fails === "insert") throw new Error("DEVTOOLS_CLOSED");
			if (tab.hangs) await new Promise<never>(() => undefined);
			return tab.landed ?? "filled";
		}),
	};
	seen.pages.push(found);
	return found;
}

/** The executor's side: the target first, then (once the helper's key is out) the vault's box for `identity`, or nothing. */
function fixture(
	options: {
		tabs?: FakeTab[];
		/** The tab the second look finds focused (the first by default). */
		later?: FakeTab[];
		field?: "login" | "password" | "code";
		hosts?: string[];
		/** The hosts the vault seals into the box (the target's by default). */
		sealed?: string[];
		boot?: string;
		/** What the box is bound to, where it differs from the target. */
		bound?: Record<string, unknown>;
		/** Another identity altogether for the box (an office's). */
		identity?: (ids: Record<string, string>) => Record<string, unknown>;
		box?: "none" | "garbage";
		browser?: "DESKTOP_NOT_RUNNING" | "BROWSER_NOT_OPEN" | "BROWSER_UNVERIFIED";
		sealedAt?: number;
	} = {},
) {
	const ids = {
		companyId: randomUUID(),
		companyMachineId: randomUUID(),
		placementId: randomUUID(),
		bootId: randomUUID(),
		receiptId: randomUUID(),
		accountId: randomUUID(),
	};
	const field = options.field ?? "password";
	const hosts = options.hosts ?? ["npmjs.com", "www.npmjs.com"];
	const target = { schema: "qorpera.machine-account-fill-target/v1", ...ids, field, hosts };
	const tabs = options.tabs ?? [
		{
			id: "tab-1",
			address: "https://www.npmjs.com/login",
			focus: { kind: "input", type: "password", usable: true } as MachineFillFocus,
		},
	];
	const typed: string[] = [];
	const seen = { pages: [] as MachineFillPage[], allowed: [] as ((address: string) => boolean)[] };
	// Each look reads the tabs anew, as the browser answers them; the helper knows a tab again by its id.
	const look = (list: FakeTab[]) => {
		if (list.length === 0) return "none" as const;
		if (list.length > 1) return "many" as const;
		return page(list[0]!, typed, seen);
	};
	let looks = 0;
	const closed = vi.fn();
	const keys: CompanyComputerFillKey[] = [];
	const ports: MachineAccountFillPorts = {
		bootId: async () => `${options.boot ?? ids.bootId}\n`,
		browser: vi.fn(
			async () =>
				options.browser ?? {
					focusedPage: async () => look(looks++ === 0 ? tabs : (options.later ?? tabs)),
					close: closed,
				},
		),
		key: () => {
			const key = new CompanyComputerFillKey();
			keys.push(key);
			return key;
		},
		now: () => now,
	};
	/** stdin: the target, then the box once the helper printed its key (or stdin ends). Chunks are kept to check zeroing. */
	const handed: Buffer[] = [];
	let printed = "";
	let readyResolve: (line: string) => void = () => undefined;
	const ready = new Promise<string>((resolve) => {
		readyResolve = resolve;
	});
	async function* stdin(): AsyncGenerator<Buffer> {
		const first = Buffer.from(`${JSON.stringify(target)}\n`);
		handed.push(first);
		yield first;
		const line = await ready;
		const answer = JSON.parse(line) as { schema: string; publicKey?: string };
		if (answer.schema !== "qorpera.machine-account-fill-ready/v1" || options.box === "none") return;
		const box =
			options.box === "garbage"
				? {
						schema: "qorpera.company-account-fill-box/v1",
						ephemeralPublicKey: "a",
						iv: "b",
						tag: "c",
						ciphertext: "d",
					}
				: sealCompanyAccountFill(
						{ value: secret, hosts: options.sealed ?? hosts },
						answer.publicKey as string,
						(options.identity ? options.identity(ids) : { ...ids, field, ...options.bound }) as never,
						options.sealedAt ?? now,
					);
		const second = Buffer.from(`${JSON.stringify(box)}\n`);
		handed.push(second);
		yield second;
	}
	const stdout = {
		write: (text: string) => {
			printed += text;
			if (!printed.includes("\n") || printed.split("\n").length > 2) return;
			readyResolve(printed.split("\n")[0]!);
		},
	};
	const run = (signal = new AbortController().signal) =>
		fillAccountOnMachine({ stdin: stdin(), stdout, ports, signal }).finally(() => readyResolve('{"schema":"done"}'));
	return { ids, target, typed, seen, ports, run, closed, handed, keys, printed: () => printed };
}

const lines = (text: string) =>
	text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, string>);

describe("fill_company_account's helper", () => {
	it("prints its key, opens the vault's box for this call on this boot, types the value once and prints FILLED", async () => {
		const f = fixture();
		expect(await f.run()).toBe("FILLED");
		const said = lines(f.printed());
		expect(said).toEqual([
			{ schema: "qorpera.machine-account-fill-ready/v1", publicKey: f.keys[0]!.publicKey },
			{ schema: "qorpera.machine-account-fill-result/v1", code: "FILLED" },
		]);
		expect(f.typed).toEqual([secret]);
		// Nothing printed is the value; every stdin buffer handed in is zeroed once read.
		expect(f.printed()).not.toContain(secret);
		expect(f.handed).toHaveLength(2);
		for (const buffer of f.handed) expect(buffer.every((byte) => byte === 0)).toBe(true);
		expect(f.closed).toHaveBeenCalledTimes(1);
	});

	it("opens the box only for exactly its identity, on this boot, within its lifetime", async () => {
		for (const bound of [
			{ receiptId: randomUUID() },
			{ placementId: randomUUID() },
			{ companyMachineId: randomUUID() },
			{ accountId: randomUUID() },
			{ bootId: randomUUID() },
			{ field: "login" },
		]) {
			const f = fixture({ bound });
			expect(await f.run(), JSON.stringify(bound)).toBe("FILL_BOX_REFUSED");
			expect(f.typed).toEqual([]);
		}
		// An office's box (a computer and its generation) never opens on a machine.
		const office = fixture({
			identity: (ids) => ({
				companyId: ids.companyId,
				companyComputerId: ids.companyMachineId,
				computerGeneration: 1,
				receiptId: ids.receiptId,
				accountId: ids.accountId,
				field: "password",
			}),
		});
		await expect(office.run()).resolves.toBe("FILL_BOX_REFUSED");
		// Spent: sealed longer ago than a box lives.
		const old = fixture({ sealedAt: now - 120_000 });
		expect(await old.run()).toBe("FILL_BOX_REFUSED");
		expect(old.typed).toEqual([]);
		const garbage = fixture({ box: "garbage" });
		expect(await garbage.run()).toBe("FILL_BOX_REFUSED");
		// The vault refused (stdin ends): nothing typed.
		const none = fixture({ box: "none" });
		expect(await none.run()).toBe("FILL_NO_BOX");
		expect(none.typed).toEqual([]);
	});

	it("refuses a page that is not the account's over https, a frame, the wrong box and a bot check, before the vault", async () => {
		const tab = (patch: Partial<FakeTab>): FakeTab[] => [
			{
				id: "tab-1",
				address: "https://www.npmjs.com/login",
				focus: { kind: "input", type: "password", usable: true },
				...patch,
			},
		];
		for (const [patch, code, field] of [
			[{ address: "http://www.npmjs.com/login" }, "FILL_WRONG_SITE"],
			[{ address: "https://npmjs.com.evil.example/login" }, "FILL_WRONG_SITE"],
			[{ address: "https://login.npmjs.com/" }, "FILL_WRONG_SITE"],
			[{ address: "https://www.npmjs.com:8443/login" }, "FILL_WRONG_SITE"],
			[{ address: "https://user@www.npmjs.com/login" }, "FILL_WRONG_SITE"],
			[{ address: "data:text/html,<input type=password>" }, "FILL_WRONG_SITE"],
			[{ focus: { kind: "frame" } }, "FILL_IN_FRAME"],
			[{ focus: { kind: "none" } }, "FILL_WRONG_BOX"],
			[{ focus: { kind: "other" } }, "FILL_WRONG_BOX"],
			[{ focus: { kind: "input", type: "text", usable: true } }, "FILL_WRONG_BOX"],
			[{ focus: { kind: "input", type: "password", usable: false } }, "FILL_WRONG_BOX"],
			[{ focus: { kind: "input", type: "password", usable: true } }, "FILL_WRONG_BOX", "login"],
			[{ focus: { kind: "input", type: "hidden", usable: true } }, "FILL_WRONG_BOX", "code"],
			[{ stop: "captcha" }, "SITE_STOP_CAPTCHA"],
			[{ stop: "human_check" }, "SITE_STOP_HUMAN_CHECK"],
			[{ stop: "unusual_activity" }, "SITE_STOP_UNUSUAL_ACTIVITY"],
			[{ stop: "blocked" }, "SITE_STOP_BLOCKED"],
		] as const) {
			const f = fixture({ tabs: tab(patch), ...(field ? { field } : {}) });
			expect(await f.run(), JSON.stringify(patch)).toBe(code);
			// Refused before any key was made: the vault was never asked, and the only line is the code.
			expect(lines(f.printed())).toEqual([{ schema: "qorpera.machine-account-fill-result/v1", code }]);
			expect(f.keys).toEqual([]);
			expect(f.typed).toEqual([]);
		}
		// The box's own hosts decide last: a host the database named but the vault did not seal is refused.
		const narrower = fixture({ sealed: ["npmjs.com"] });
		expect(await narrower.run()).toBe("FILL_WRONG_SITE");
		expect(narrower.typed).toEqual([]);
		// A login goes into an email box, a code into a number box.
		const login = fixture({
			field: "login",
			tabs: tab({ focus: { kind: "input", type: "email", usable: true } }),
		});
		expect(await login.run()).toBe("FILLED");
		const code = fixture({ field: "code", tabs: tab({ focus: { kind: "input", type: "number", usable: true } }) });
		expect(await code.run()).toBe("FILLED");
	});

	it("checks the tab again after the box: another tab, a redirect or a bot check meanwhile types nothing", async () => {
		const first: FakeTab = {
			id: "tab-1",
			address: "https://www.npmjs.com/login",
			focus: { kind: "input", type: "password", usable: true },
		};
		const other = fixture({ tabs: [first], later: [{ ...first, id: "tab-2" }] });
		expect(await other.run()).toBe("NO_FOCUSED_PAGE");
		expect(other.typed).toEqual([]);
		// The same tab, redirected elsewhere, or showing a bot check, or with the focus moved, by its second look.
		for (const [later, code] of [
			[{ address: "https://npmjs.evil.example/login" }, "FILL_WRONG_SITE"],
			[{ stop: "unusual_activity" }, "SITE_STOP_UNUSUAL_ACTIVITY"],
			[{ focus: { kind: "frame" } }, "FILL_IN_FRAME"],
		] as const) {
			const moved = fixture({ tabs: [first], later: [{ ...first, ...later }] });
			expect(await moved.run(), JSON.stringify(later)).toBe(code);
			expect(moved.keys).toHaveLength(1);
			expect(moved.typed).toEqual([]);
		}
		for (const [tabs, code] of [
			[[], "NO_FOCUSED_PAGE"],
			[[first, { ...first, id: "tab-2" }], "NO_FOCUSED_PAGE"],
		] as const) {
			const f = fixture({ tabs: [...tabs] });
			expect(await f.run()).toBe(code);
		}
	});

	it("binds both looks and the typing to the first look's document: a change refuses before anything is typed", async () => {
		const first: FakeTab = {
			id: "tab-1",
			address: "https://www.npmjs.com/login",
			focus: { kind: "input", type: "password", usable: true },
		};
		// Both looks bind (the second checks it is still the first one's document), each before its first read.
		const f = fixture({ tabs: [first] });
		expect(await f.run()).toBe("FILLED");
		expect(f.seen.pages).toHaveLength(2);
		for (const found of f.seen.pages) {
			expect(found.bind).toHaveBeenCalledTimes(1);
			expect(vi.mocked(found.bind).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(found.address).mock.invocationCallOrder[0]!,
			);
		}
		// The tab left the document at the first look: refused before the key, so the vault is never asked.
		const early = fixture({ tabs: [{ ...first, changed: "bind" }] });
		expect(await early.run()).toBe("FILL_PAGE_CHANGED");
		expect(lines(early.printed())).toEqual([
			{ schema: "qorpera.machine-account-fill-result/v1", code: "FILL_PAGE_CHANGED" },
		]);
		expect(early.keys).toEqual([]);
		// After the box: a redirect seen by the second look's bind or a read of it (never inserted), or by the insert itself
		// right before it typed.
		for (const [patch, inserted] of [
			[{ changed: "bind" }, false],
			[{ changed: "address" }, false],
			[{ landed: "changed" }, true],
		] as const) {
			const moved = fixture({ tabs: [first], later: [{ ...first, ...patch }] });
			expect(await moved.run(), JSON.stringify(patch)).toBe("FILL_PAGE_CHANGED");
			expect(moved.keys).toHaveLength(1);
			expect(moved.typed).toEqual(inserted ? [secret] : []);
		}
		// The insert checks the address right before and right after against the hosts sealed in the box, not the target's.
		const narrower = fixture({ sealed: ["www.npmjs.com"] });
		expect(await narrower.run()).toBe("FILLED");
		const allowed = narrower.seen.allowed[0]!;
		expect(allowed("https://www.npmjs.com/login")).toBe(true);
		for (const address of [
			"https://npmjs.com/login",
			"http://www.npmjs.com/login",
			"https://www.npmjs.com.evil.example/login",
			"https://evil.example/login",
		])
			expect(allowed(address), address).toBe(false);
	});

	it("says where a typed value went, and that a failure after typing may have left it on the page", async () => {
		const tab = (patch: Partial<FakeTab>): FakeTab[] => [
			{
				id: "tab-1",
				address: "https://www.npmjs.com/login",
				focus: { kind: "input", type: "password", usable: true },
				...patch,
			},
		];
		for (const [landed, code] of [
			["emptied", "FILL_UNCONFIRMED"],
			["lost", "FILL_LOST"],
			["moved", "FILL_WRONG_BOX"],
			["changed", "FILL_PAGE_CHANGED"],
		] as const) {
			const f = fixture({ tabs: tab({ landed }) });
			expect(await f.run()).toBe(code);
		}
		// The browser stopped answering once the value was handed over: not confirmed emptied.
		const after = fixture({ tabs: tab({ fails: "insert" }) });
		expect(await after.run()).toBe("FILL_LOST");
		expect(lines(after.printed()).at(-1)).toEqual({
			schema: "qorpera.machine-account-fill-result/v1",
			code: "FILL_LOST",
		});
		const before = fixture({ tabs: tab({ fails: "address" }) });
		expect(await before.run()).toBe("BROWSER_NOT_ANSWERING");
		expect(before.typed).toEqual([]);
	});

	it("answers FILL_LOST, never FILL_EXPIRED, when its deadline passes after the value was handed over", async () => {
		const deadline = new AbortController();
		const f = fixture({
			tabs: [
				{
					id: "tab-1",
					address: "https://www.npmjs.com/login",
					focus: { kind: "input", type: "password", usable: true },
					hangs: true,
				},
			],
		});
		const running = f.run(deadline.signal);
		await vi.waitFor(() => expect(f.typed).toEqual([secret]));
		deadline.abort();
		expect(await running).toBe("FILL_LOST");
		expect(lines(f.printed()).at(-1)).toEqual({
			schema: "qorpera.machine-account-fill-result/v1",
			code: "FILL_LOST",
		});
		expect(f.printed()).not.toContain(secret);
		expect(f.closed).toHaveBeenCalledTimes(1);
	});

	it("refuses without a desktop, a browser of desktop open's, another boot or a target", async () => {
		for (const browser of ["DESKTOP_NOT_RUNNING", "BROWSER_NOT_OPEN", "BROWSER_UNVERIFIED"] as const) {
			const f = fixture({ browser });
			expect(await f.run()).toBe(browser);
			expect(f.keys).toEqual([]);
		}
		const restarted = fixture({ boot: randomUUID() });
		expect(await restarted.run()).toBe("MACHINE_BOOT_CHANGED");
		expect(restarted.ports.browser).not.toHaveBeenCalled();
		const target = fixture().target;
		expect(parseMachineAccountFillTarget(target)).not.toBeNull();
		for (const bad of [
			{ ...target, value: secret },
			{ ...target, field: "new_password" },
			{ ...target, hosts: [] },
			{ ...target, hosts: ["NPMJS.com"] },
			{ ...target, hosts: ["npmjs.com", "npmjs.com"] },
			{ ...target, hosts: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"] },
			{ ...target, receiptId: "receipt" },
			{ ...target, schema: "qorpera.coding-value-machine-target/v1" },
		])
			expect(parseMachineAccountFillTarget(bad), JSON.stringify(bad)).toBeNull();
	});

	it("stops at its deadline and types nothing after it", async () => {
		const deadline = new AbortController();
		// The vault never answers: stdin waits; the deadline ends the run.
		const stuck = fixture();
		const never = new Promise<never>(() => undefined);
		async function* stdin(): AsyncGenerator<Buffer> {
			yield Buffer.from(`${JSON.stringify(stuck.target)}\n`);
			await never;
		}
		let printed = "";
		const running = fillAccountOnMachine({
			stdin: stdin(),
			stdout: {
				write: (text: string) => {
					printed += text;
				},
			},
			ports: stuck.ports,
			signal: deadline.signal,
		});
		await vi.waitFor(() => expect(printed).toContain("ready"));
		deadline.abort();
		expect(await running).toBe("FILL_EXPIRED");
		expect(lines(printed).at(-1)).toEqual({ schema: "qorpera.machine-account-fill-result/v1", code: "FILL_EXPIRED" });
		expect(stuck.typed).toEqual([]);
	});

	it("as a program, refuses any argument and prints only codes", async () => {
		let printed = "";
		expect(
			await runMachineAccountFillCli({
				argv: ["--value", secret],
				stdin: (async function* () {})(),
				stdout: {
					write: (text: string) => {
						printed += text;
					},
				},
			}),
		).toBe(0);
		expect(lines(printed)).toEqual([
			{ schema: "qorpera.machine-account-fill-result/v1", code: "FILL_TARGET_INVALID" },
		]);
		expect(MACHINE_ACCOUNT_FILL_REFUSALS).toContain("FILL_TARGET_INVALID");
	});
});

describe("the desktop's Chromium", () => {
	const chromium = "/usr/lib/qorpera-chromium/chrome";
	const profile = "--user-data-dir=/home/desktop/.config/qorpera-chromium";
	interface FakeProcess {
		pid: number;
		exe?: string;
		uid?: number;
		argv?: readonly string[];
		started?: number;
		sockets: readonly number[];
	}
	/** A /proc of processes (exe, real uid, command line, start, socket fds) and the TCP listeners. */
	async function proc(processes: FakeProcess[], listeners: { port: number; inode: number; address?: string }[]) {
		const root = await mkdtemp(join(tmpdir(), "qorpera-fill-proc-"));
		const procRoot = join(root, "proc");
		await mkdir(join(procRoot, "net"), { recursive: true });
		await mkdir(join(root, "etc"));
		await writeFile(
			join(root, "etc", "passwd"),
			"root:x:0:0::/root:/bin/bash\ndesktop:x:1001:1001::/home/desktop:/bin/bash\n",
		);
		const rows = listeners.map(
			(listener, index) =>
				`  ${index}: ${listener.address ?? "0100007F"}:${listener.port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 ${listener.inode} 1 0000000000000000 100 0 0 10 0`,
		);
		await writeFile(
			join(procRoot, "net", "tcp"),
			`  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n${rows.join("\n")}\n`,
		);
		for (const entry of processes) {
			const dir = join(procRoot, String(entry.pid));
			await mkdir(join(dir, "fd"), { recursive: true });
			await symlink(entry.exe ?? chromium, join(dir, "exe"));
			const uid = entry.uid ?? 1001;
			await writeFile(join(dir, "status"), `Name:\tchrome\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
			await writeFile(
				join(dir, "cmdline"),
				`${[chromium, ...(entry.argv ?? [profile, "--remote-debugging-port=0"])].join("\0")}\0`,
			);
			// Field 22, the start: the command name may hold spaces and parentheses.
			await writeFile(
				join(dir, "stat"),
				`${entry.pid} (chrome (x)) S 1 ${entry.pid} ${entry.pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${entry.started ?? 100} 0 0\n`,
			);
			for (const [fd, socket] of entry.sockets.entries())
				await symlink(`socket:[${socket}]`, join(dir, "fd", String(fd + 3)));
		}
		return { root, proc: procRoot };
	}

	it("finds the desktop browser's loopback port off the kernel, never a file or another program's", async () => {
		const cases: [Parameters<typeof proc>, { port: number } | "absent" | "other"][] = [
			[[[{ pid: 41, sockets: [7001] }], [{ port: 40123, inode: 7001 }]], { port: 40123 }],
			// Its renderer and an agent's own server hold sockets too: only the browser process's listener counts.
			[
				[
					[
						{ pid: 41, sockets: [7001, 7005] },
						{ pid: 42, argv: [profile, "--type=renderer"], sockets: [7002] },
						{ pid: 43, exe: "/opt/node/bin/node", uid: 0, argv: ["server.js"], sockets: [7003] },
					],
					[
						{ port: 9222, inode: 7003 },
						{ port: 40123, inode: 7001 },
						{ port: 40200, inode: 7002 },
					],
				],
				{ port: 40123 },
			],
			// A second desktop open that hands its address over and exits: the oldest is the browser.
			[
				[
					[
						{ pid: 50, started: 900, sockets: [7009] },
						{ pid: 41, started: 100, sockets: [7001] },
					],
					[
						{ port: 40999, inode: 7009 },
						{ port: 40123, inode: 7001 },
					],
				],
				{ port: 40123 },
			],
			// No browser of the desktop's: none at all, root's, another profile, or another program.
			[[[], [{ port: 40123, inode: 7001 }]], "absent"],
			[[[{ pid: 41, uid: 0, sockets: [7001] }], [{ port: 40123, inode: 7001 }]], "absent"],
			[
				[
					[{ pid: 41, argv: ["--user-data-dir=/home/desktop/other"], sockets: [7001] }],
					[{ port: 40123, inode: 7001 }],
				],
				"absent",
			],
			[[[{ pid: 41, exe: "/usr/bin/python3", sockets: [7001] }], [{ port: 40123, inode: 7001 }]], "absent"],
			// The browser runs but listens on no loopback port: started without one, or not on the loopback.
			[[[{ pid: 41, argv: [profile], sockets: [7001] }], []], "other"],
			[[[{ pid: 41, sockets: [7001] }], [{ port: 40123, inode: 7001, address: "00000000" }]], "other"],
		];
		for (const [given, expected] of cases) {
			const fake = await proc(...given);
			try {
				expect(await machineChromiumPort({ proc: fake.proc, root: fake.root }), JSON.stringify(given)).toEqual(
					expected,
				);
			} finally {
				await rm(fake.root, { recursive: true, force: true });
			}
		}
	});

	it("refuses with no desktop, no browser of desktop open's, or one with no DevTools port", async () => {
		const signal = new AbortController().signal;
		for (const [processes, listeners, expected] of [
			[[], [], "BROWSER_NOT_OPEN"],
			[[{ pid: 41, argv: [profile], sockets: [7001] }], [], "BROWSER_UNVERIFIED"],
		] as const) {
			const fake = await proc([...processes], [...listeners]);
			const socket = join(fake.root, "X1");
			try {
				expect(await machineChromium({ socket, proc: fake.proc, root: fake.root })(signal)).toBe(
					"DESKTOP_NOT_RUNNING",
				);
				await writeFile(socket, "");
				expect(await machineChromium({ socket, proc: fake.proc, root: fake.root })(signal)).toBe(expected);
			} finally {
				await rm(fake.root, { recursive: true, force: true });
			}
		}
		// A listener that answers DevTools' version for another address is not the browser's.
		const server = createServer((_request, reply) => {
			reply.setHeader("content-type", "application/json");
			reply.end(JSON.stringify({ webSocketDebuggerUrl: "ws://evil.example:9222/devtools/browser/x" }));
		});
		await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
		const port = (server.address() as AddressInfo).port;
		const fake = await proc([{ pid: 41, sockets: [7001] }], [{ port, inode: 7001 }]);
		const socket = join(fake.root, "X1");
		await writeFile(socket, "");
		try {
			expect(await machineChromium({ socket, proc: fake.proc, root: fake.root })(signal)).toBe("BROWSER_UNVERIFIED");
		} finally {
			server.close();
			await rm(fake.root, { recursive: true, force: true });
		}
	});
});
