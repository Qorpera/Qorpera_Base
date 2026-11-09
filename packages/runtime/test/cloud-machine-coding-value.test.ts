import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodingValueMachineIdentity,
	openCodingValueMachineCapture,
} from "@qorpera/runtime/cloud-coding-value-capture-box";
import {
	MACHINE_XSEL_MS,
	type MachineClipboard,
	type MachineCodingValuePorts,
	runMachineCodingValueCli,
	saveCodingValueFromClipboard,
	xselClipboard,
} from "@qorpera/runtime/cloud-machine-coding-value";
import { describe, expect, it, vi } from "vitest";

// 20260930705000: save_coding_value's helper on a company machine reads the desktop's clipboard, seals the one key of
// the service in it to the value's capture key, clears both selections on every path, and prints only the box or a
// refusal code. The clipboard is mocked here; deploy/machine/build-machine-image.sh checks the real one on the image.

const now = 1_790_000_000_000;
const token = `npm_${"Ab12Cd34Ef".repeat(3)}Gh12Kl`;
const other = `npm_${"Zz98Yy76Xx".repeat(3)}Ww54Vv`;

function recipient() {
	const pair = generateKeyPairSync("x25519");
	const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(12);
	return { privateKey: pair.privateKey, publicKey: Buffer.from(raw).toString("base64url") };
}

function fixture(
	clipboard: Buffer | string | "no-display" | "unreadable" | "too-large",
	options: { boot?: string } = {},
) {
	const key = recipient();
	const identity: CodingValueMachineIdentity = {
		companyId: randomUUID(),
		companyMachineId: randomUUID(),
		placementId: randomUUID(),
		bootId: randomUUID(),
		receiptId: randomUUID(),
		service: "npm",
		variable: "npm_token",
	};
	const target = {
		schema: "qorpera.coding-value-machine-target/v1",
		valuePattern: "^npm_[A-Za-z0-9]{36}$",
		capturePublicKey: key.publicKey,
		...identity,
	};
	/** The bytes handed to the helper, by reference: zeroed once it is done. */
	const handed: Buffer[] = [];
	const cleared: string[] = [];
	const board: MachineClipboard = {
		read: vi.fn(async () => {
			if (typeof clipboard === "string" && ["no-display", "unreadable", "too-large"].includes(clipboard))
				return clipboard as "no-display";
			const bytes = Buffer.from(clipboard);
			handed.push(bytes);
			return bytes;
		}),
		clear: vi.fn(async (selection: "clipboard" | "primary") => {
			cleared.push(selection);
		}),
	};
	const ports: MachineCodingValuePorts = {
		clipboard: board,
		bootId: async () => `${options.boot ?? identity.bootId}\n`,
		now: () => now,
	};
	return { key, identity, target, ports, cleared, handed, board };
}

const open = (f: ReturnType<typeof fixture>, box: unknown, expected = f.identity) =>
	openCodingValueMachineCapture(
		f.key.privateKey,
		f.key.publicKey,
		box,
		expected,
		async (capture) => capture.value.toString("utf8"),
		now + 1000,
	);

describe("save_coding_value's clipboard helper", () => {
	it("seals the key on the clipboard for exactly this call on this boot, and clears both selections", async () => {
		for (const copied of [token, `${token}\n`, `  ${token}\t`, `Your new token: ${token} (shown once)`]) {
			const f = fixture(copied);
			const output = await saveCodingValueFromClipboard(f.target, f.ports);
			expect(output.schema).toBe("qorpera.machine-coding-value-box/v1");
			const box = (output as { box: Record<string, string> }).box;
			expect(Object.keys(box).sort()).toEqual(["ciphertext", "ephemeralPublicKey", "iv", "schema", "tag"]);
			expect(box.schema).toBe("qorpera.coding-value-machine-box/v1");
			expect(JSON.stringify(output)).not.toContain(token.slice(4));
			await expect(open(f, box)).resolves.toBe(token);
			// Never for another boot, placement or call.
			for (const changed of [{ bootId: randomUUID() }, { placementId: randomUUID() }, { receiptId: randomUUID() }])
				await expect(open(f, box, { ...f.identity, ...changed })).rejects.toThrow("does not open here");
			expect(f.cleared).toEqual(["clipboard", "primary"]);
			expect(f.handed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
		}
	});

	it("refuses an empty clipboard, no key, more than one, and a stopped desktop, and clears it on every path", async () => {
		for (const [clipboard, code] of [
			["", "CLIPBOARD_EMPTY"],
			[" \n\t", "CLIPBOARD_EMPTY"],
			["hello there", "CLIPBOARD_NOT_A_KEY"],
			[`npm_${"a".repeat(35)}`, "CLIPBOARD_NOT_A_KEY"],
			[`NPM_TOKEN=${token}`, "CLIPBOARD_NOT_A_KEY"],
			[`ghp_${"a".repeat(36)}`, "CLIPBOARD_NOT_A_KEY"],
			["too-large", "CLIPBOARD_NOT_A_KEY"],
			[`${token}\n${other}`, "CLIPBOARD_MORE_THAN_ONE_KEY"],
			["no-display", "DESKTOP_NOT_RUNNING"],
			["unreadable", "CLIPBOARD_UNREADABLE"],
		] as const) {
			const f = fixture(clipboard);
			const output = await saveCodingValueFromClipboard(f.target, f.ports);
			expect(output, clipboard).toEqual({ schema: "qorpera.machine-coding-value-refusal/v1", code });
			expect(f.cleared, clipboard).toEqual(["clipboard", "primary"]);
			expect(f.handed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
		}
		// The same key copied twice is one key.
		const twice = fixture(`${token} ${token}`);
		expect((await saveCodingValueFromClipboard(twice.target, twice.ports)).schema).toBe(
			"qorpera.machine-coding-value-box/v1",
		);
	});

	it("refuses another boot and a target that is not the database's, before it reads the clipboard", async () => {
		const restarted = fixture(token, { boot: randomUUID() });
		expect(await saveCodingValueFromClipboard(restarted.target, restarted.ports)).toEqual({
			schema: "qorpera.machine-coding-value-refusal/v1",
			code: "MACHINE_BOOT_CHANGED",
		});
		expect(restarted.board.read).not.toHaveBeenCalled();
		expect(restarted.cleared).toEqual(["clipboard", "primary"]);
		const f = fixture(token);
		for (const target of [
			null,
			"text",
			[],
			{ ...f.target, extra: true },
			{ ...f.target, schema: "qorpera.coding-value-capture-target/v1" },
			{ ...f.target, bootId: "not a uuid" },
			{ ...f.target, service: 3 },
			// A pattern outside the portable subset is never guessed at.
			{ ...f.target, valuePattern: "^npm_.*$" },
		]) {
			const g = fixture(token);
			expect(await saveCodingValueFromClipboard(target, g.ports), JSON.stringify(target)).toEqual({
				schema: "qorpera.machine-coding-value-refusal/v1",
				code: "CODING_VALUE_TARGET_INVALID",
			});
			expect(g.board.read).not.toHaveBeenCalled();
			expect(g.cleared).toEqual(["clipboard", "primary"]);
		}
	});

	it("clears the clipboard when sealing fails, and the failure names no value", async () => {
		const f = fixture(token);
		const error = await saveCodingValueFromClipboard(
			{ ...f.target, capturePublicKey: "A".repeat(43) },
			f.ports,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).not.toContain(token.slice(4));
		expect(f.cleared).toEqual(["clipboard", "primary"]);
		expect(f.handed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it("prints one JSON line, the box or the code, and never the value", async () => {
		for (const copied of [token, "hello there", `${token} ${other}`]) {
			const f = fixture(copied);
			const written: string[] = [];
			async function* stdin() {
				yield Buffer.from(JSON.stringify(f.target).slice(0, 40));
				yield JSON.stringify(f.target).slice(40);
			}
			expect(
				await runMachineCodingValueCli({
					argv: [],
					stdin: stdin(),
					stdout: { write: (text) => written.push(text) },
					ports: f.ports,
				}),
			).toBe(0);
			expect(written).toHaveLength(1);
			expect(written[0]).toMatch(/^\{.*\}\n$/);
			expect(written[0]).not.toContain(token.slice(4));
			expect(written[0]).not.toContain(other.slice(4));
			expect(written[0]).not.toContain("hello");
			expect(f.cleared).toEqual(["clipboard", "primary"]);
		}
		// A target over its bound, or not JSON, is refused unread.
		const f = fixture(token);
		const written: string[] = [];
		async function* large() {
			yield Buffer.alloc(9000, 0x20);
		}
		await runMachineCodingValueCli({
			argv: [],
			stdin: large(),
			stdout: { write: (text) => written.push(text) },
			ports: f.ports,
		});
		expect(JSON.parse(written[0] as string)).toEqual({
			schema: "qorpera.machine-coding-value-refusal/v1",
			code: "CODING_VALUE_TARGET_INVALID",
		});
		expect(f.board.read).not.toHaveBeenCalled();
	});

	it("only clears both selections with --clear-only, the executor's own clear, and never reads the target", async () => {
		const f = fixture(token);
		const written: string[] = [];
		/** stdin that fails the call if it is read at all. */
		const unread = (): AsyncIterable<Buffer> => ({
			[Symbol.asyncIterator]: () => {
				throw new Error("stdin read");
			},
		});
		expect(
			await runMachineCodingValueCli({
				argv: ["--clear-only"],
				stdin: unread(),
				stdout: { write: (text) => written.push(text) },
				ports: f.ports,
			}),
		).toBe(0);
		expect(written).toEqual([`${JSON.stringify({ schema: "qorpera.machine-coding-value-cleared/v1" })}\n`]);
		expect(f.cleared.sort()).toEqual(["clipboard", "primary"]);
		expect(f.board.read).not.toHaveBeenCalled();
		// Any other arguments: cleared all the same, and refused.
		const g = fixture(token);
		const refusedLine: string[] = [];
		await runMachineCodingValueCli({
			argv: ["--clear"],
			stdin: unread(),
			stdout: { write: (text) => refusedLine.push(text) },
			ports: g.ports,
		});
		expect(JSON.parse(refusedLine[0] as string)).toEqual({
			schema: "qorpera.machine-coding-value-refusal/v1",
			code: "CODING_VALUE_TARGET_INVALID",
		});
		expect(g.cleared.sort()).toEqual(["clipboard", "primary"]);
		expect(g.board.read).not.toHaveBeenCalled();
	});
});

// The helper's time on the machine: one xsel read and both clears side by side, each xsel killed at MACHINE_XSEL_MS, so
// the clear always runs well inside the 20 s the executor gives the helper (company-machine-host.ts). A stand-in xsel
// that never answers shows it, with a shorter time.
describe("save_coding_value's helper on xsel", () => {
	async function standIn(read: "hang" | "empty", clear: "hang" | "log") {
		const dir = await mkdtemp(join(tmpdir(), "qorpera-xsel-"));
		const socket = join(dir, "X1");
		await writeFile(socket, "");
		const xsel = join(dir, "xsel");
		await writeFile(
			xsel,
			[
				"#!/bin/sh",
				'dir=$(dirname "$0")',
				'case " $* " in',
				`*" --output "*) ${read === "hang" ? "exec sleep 60" : "exit 0"} ;;`,
				`*" --clear "*) echo "$3" >> "$dir/cleared"; ${clear === "hang" ? "exec sleep 60" : "exit 0"} ;;`,
				"esac",
				"",
			].join("\n"),
		);
		await chmod(xsel, 0o755);
		return { dir, clipboard: xselClipboard({ xsel, socket, timeoutMs: 400 }) };
	}
	const cleared = async (dir: string) =>
		(await readFile(join(dir, "cleared"), "utf8").catch(() => "")).split("\n").filter(Boolean).sort();

	it("gives a read that never answers up in time, and still clears both selections", async () => {
		const f = fixture(token);
		for (const clear of ["log", "hang"] as const) {
			const { dir, clipboard } = await standIn("hang", clear);
			try {
				const started = Date.now();
				expect(await saveCodingValueFromClipboard(f.target, { ...f.ports, clipboard })).toEqual({
					schema: "qorpera.machine-coding-value-refusal/v1",
					code: "CLIPBOARD_UNREADABLE",
				});
				// One read's time and one clear's (side by side), each killed at its time: never three.
				expect(Date.now() - started).toBeLessThan(2 * 400 + 600);
				expect(await cleared(dir)).toEqual(["--clipboard", "--primary"]);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
		// An empty clipboard is read at once, and cleared all the same.
		const { dir, clipboard } = await standIn("empty", "log");
		try {
			expect(await saveCodingValueFromClipboard(f.target, { ...f.ports, clipboard })).toMatchObject({
				code: "CLIPBOARD_EMPTY",
			});
			expect(await cleared(dir)).toEqual(["--clipboard", "--primary"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fits the executor's deadline: a read and a clear at most, each well under it", () => {
		// The executor gives the helper 20 s and its own clear 10 s (company-machine-host.ts; the guest package's test
		// checks the two files agree).
		expect(MACHINE_XSEL_MS).toBe(4000);
		expect(2 * MACHINE_XSEL_MS + 2000).toBeLessThanOrEqual(10_000);
	});
});
