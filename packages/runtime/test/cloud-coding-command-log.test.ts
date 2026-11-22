import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
	parseCloudMachineCommandReceipt,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCodingCommandOutput, readCodingCommandLog } from "../src/cloud-coding-command-log.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(bytes: Buffer) {
	const root = await mkdtemp(join(tmpdir(), "coding-log-"));
	roots.push(root);
	const path = join(root, "output.log");
	await writeFile(path, bytes, { mode: 0o600 });
	return {
		path,
		owner: process.getuid?.() ?? 0,
		protectedOwner: process.getuid?.() ?? 0,
		mountRoot: root,
		boundary: root,
		maxBytes: 1048576,
		terminal: true,
		read: { commandId: randomUUID() },
	};
}
describe("retained coding command log pages", () => {
	it("drains both streams while retaining the entire budget plus one overflow marker", async () => {
		const f = await fixture(Buffer.alloc(0));
		const handle = await open(f.path, "a");
		try {
			await collectCodingCommandOutput(
				[
					Readable.from([Buffer.alloc(700000, 97), Buffer.alloc(700000, 97)]),
					Readable.from([Buffer.alloc(700000, 98)]),
				],
				handle,
				1048576,
			);
		} finally {
			await handle.close();
		}
		const bytes = await readFile(f.path);
		expect(bytes.length).toBe(1048577);
		expect(bytes.includes(97)).toBe(true);
		expect(bytes.includes(98)).toBe(true);
		expect((await readCodingCommandLog(f)).log.limitReached).toBe(true);
	});
	it("pages UTF8 without splitting characters or losing raw-byte cursors", async () => {
		const source = "a😀é中z\ufeff".repeat(200),
			f = await fixture(Buffer.from(source));
		let offset = 0,
			output = "";
		while (offset < Buffer.byteLength(source)) {
			const page = await readCodingCommandLog({ ...f, read: { ...f.read, offset, limit: 7 } });
			expect(page.log.nextOffset).toBeGreaterThan(offset);
			expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(7);
			output += page.output;
			offset = page.log.nextOffset;
		}
		expect(output).toBe(source);
	});
	it("rejects an interior Unicode cursor and aligns tail to the next character", async () => {
		const f = await fixture(Buffer.from("😀xyz"));
		await expect(readCodingCommandLog({ ...f, read: { ...f.read, offset: 1 } })).rejects.toThrow("SPLITS_UTF8");
		const tail = await readCodingCommandLog({ ...f, read: { ...f.read, tail: true, limit: 5 } });
		expect(tail.output).toBe("xyz");
		expect(tail.log.offset).toBe(4);
	});
	it("waits for a split in-flight character and decodes malformed terminal bytes within budget", async () => {
		const f = await fixture(Buffer.from([97, 240, 159]));
		const live = await readCodingCommandLog({ ...f, terminal: false });
		expect(live.output).toBe("a");
		expect(live.log.nextOffset).toBe(1);
		await writeFile(f.path, Buffer.from("a😀"));
		const next = await readCodingCommandLog({ ...f, read: { ...f.read, offset: 1, limit: 4 } });
		expect(next.output).toBe("😀");
		await writeFile(f.path, Buffer.from([255, 255, 255]));
		const invalid = await readCodingCommandLog({ ...f, read: { ...f.read, limit: 4 } });
		expect(invalid.output).toBe("�");
		expect(invalid.log.nextOffset).toBe(1);
		const tail = await readCodingCommandLog({ ...f, read: { ...f.read, tail: true, limit: 4 } });
		expect(tail.output).toBe("�");
		expect(tail.log.offset).toBe(2);
		expect(tail.log.nextOffset).toBe(3);
		expect(tail.truncated).toBe(false);
	});
	it("keeps worst-case escaped pages inside the real LXD 64 KiB ceiling without losing cursors", async () => {
		const f = await fixture(Buffer.alloc(16384, 0));
		let offset = 0,
			output = "";
		while (offset < 16384) {
			const query = parseCloudCodingCommandRead({ ...f.read, offset, limit: 16384 });
			const page = await readCodingCommandLog({ ...f, read: query });
			const receipt = {
				schema: "qorpera.coding-command-result/v2",
				workerId: randomUUID(),
				commandId: f.read.commandId,
				inputSha256: "a".repeat(64),
				state: "succeeded",
				exitCode: 0,
				...page,
			};
			expect(
				Buffer.byteLength(JSON.stringify({ schema: "qorpera.coding-command-page/v1", query, receipt })),
			).toBeLessThanOrEqual(65536);
			expect(parseCloudCodingCommandReceipt(receipt)).toEqual(receipt);
			expect(page.log.nextOffset).toBeGreaterThan(offset);
			output += page.output;
			offset = page.log.nextOffset;
		}
		expect(output).toBe("\0".repeat(16384));
		const tail = await readCodingCommandLog({ ...f, read: { ...f.read, tail: true, limit: 16384 } });
		expect(tail.log.nextOffset).toBe(16384);
		expect(tail.log.offset).toBe(6384);
		expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(65536);
	});
	it("denies invalid ranges and distinguishes retained-byte overflow from unread pages", async () => {
		const f = await fixture(Buffer.from("ok"));
		await expect(readCodingCommandLog({ ...f, read: { ...f.read, offset: 3 } })).rejects.toThrow(
			"OFFSET_UNAVAILABLE",
		);
		for (const patch of [{ offset: -1 }, { limit: 3 }, { tail: true, offset: 0 }, { offset: 1.5 }, { limit: 65537 }])
			expect(() => parseCloudCodingCommandRead({ ...f.read, ...patch })).toThrow();
		const receipt = {
			schema: "qorpera.coding-command-result/v2",
			workerId: randomUUID(),
			commandId: f.read.commandId,
			inputSha256: "a".repeat(64),
			state: "succeeded",
			exitCode: 0,
			...(await readCodingCommandLog(f)),
		};
		expect(parseCloudCodingCommandReceipt(receipt).output).toBe("ok");
		expect(() => parseCloudCodingCommandReceipt({ ...receipt, log: { ...receipt.log, nextOffset: 3 } })).toThrow();
	});

	it("matches per-byte UTF-8 and JSON escaping across all ASCII bytes, BOM, multi-byte UTF-8, and invalid subparts", async () => {
		const ascii = Buffer.from(Array.from({ length: 128 }, (_, i) => i));
		const mixed = Buffer.concat([
			ascii,
			Buffer.from("\ufeffé€😀"),
			Buffer.from([0xe2, 0x82, 0x20, 0xff, 0xc2, 0x41]),
		]);
		const f = await fixture(mixed);
		const page = await readCodingCommandLog({ ...f, read: { ...f.read, offset: 0, limit: 4096 } });
		const expectedAscii = ascii.toString("utf8");
		expect(page.output).toBe(`${expectedAscii}\ufeffé€😀\uFFFD\uFFFD \uFFFD\uFFFDA`);
		expect(page.log.nextOffset).toBe(mixed.length);

		const tail = await readCodingCommandLog({ ...f, read: { ...f.read, tail: true, limit: 16 } });
		expect(tail.output).toBe("\uFFFD\uFFFD \uFFFD\uFFFDA");
		expect(tail.log.nextOffset).toBe(mixed.length);
	});

	it("batches small chunks without per-chunk fsync and guarantees final sync on completion", async () => {
		const f = await fixture(Buffer.alloc(0));
		const handle = await open(f.path, "a");
		const writeSpy = vi.spyOn(handle, "write");
		const syncSpy = vi.spyOn(handle, "sync");
		const datasyncSpy = vi.spyOn(handle, "datasync");
		const chunks = Array.from({ length: 500 }, (_, index) => Buffer.from(`line-${String(index).padStart(4, "0")}\n`));
		try {
			await collectCodingCommandOutput([Readable.from(chunks)], handle, 1048576, {
				flushBytes: 65_536,
				flushIntervalMs: 5_000,
			});
		} finally {
			await handle.close();
		}
		expect(await readFile(f.path)).toEqual(Buffer.concat(chunks));
		expect(writeSpy.mock.calls.length).toBeLessThanOrEqual(4);
		expect(syncSpy).toHaveBeenCalledTimes(1);
		expect(datasyncSpy.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("flushes and datasyncs buffered bytes on the periodic interval for live readers", async () => {
		const f = await fixture(Buffer.alloc(0));
		const handle = await open(f.path, "a");
		const datasyncSpy = vi.spyOn(handle, "datasync");
		const syncSpy = vi.spyOn(handle, "sync");
		const stream = new PassThrough();
		const done = collectCodingCommandOutput([stream], handle, 1048576, {
			flushBytes: 65_536,
			flushIntervalMs: 25,
		});
		try {
			stream.write("ready on :3000\n");
			await vi.waitFor(async () => {
				const live = await readCodingCommandLog({ ...f, terminal: false });
				expect(live.output).toBe("ready on :3000\n");
			});
			await vi.waitFor(() => {
				expect(datasyncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
			});
			stream.end("stopped\n");
			await done;
		} finally {
			await handle.close();
		}
		expect(syncSpy).toHaveBeenCalledTimes(1);
		expect(await readFile(f.path, "utf8")).toBe("ready on :3000\nstopped\n");
	});

	it("rotates ring segments on overflow while keeping newest bytes, valid UTF-8 seams, and contract receipts", async () => {
		const f = await fixture(Buffer.alloc(0));
		const maxBytes = 1_048_576;
		const first = Buffer.alloc(maxBytes, 65);
		const second = Buffer.alloc(maxBytes, 66);
		const seamPrefix = Buffer.alloc(maxBytes - 2, 67);
		const emoji = Buffer.from("😀");
		const tailMarker = Buffer.from("CRASH_STACK_TRACE\n");
		const third = Buffer.concat([seamPrefix, emoji, tailMarker]);
		const all = Buffer.concat([first, second, third]);
		const expectedWindow = all.subarray(all.length - maxBytes);
		const handle = await open(f.path, "a");
		try {
			await collectCodingCommandOutput([Readable.from([first, second, third])], handle, maxBytes, {
				flushBytes: 65_536,
				ring: { path: f.path },
			});
		} finally {
			await handle.close();
		}
		expect((await stat(f.path)).size).toBe(tailMarker.length + 2);
		expect((await stat(`${f.path}.prev`)).size).toBe(maxBytes);

		const tail = await readCodingCommandLog({
			...f,
			maxBytes,
			ring: true,
			read: { ...f.read, tail: true, limit: 64 },
		});
		expect(tail.output).toBe(expectedWindow.subarray(expectedWindow.length - 64).toString("utf8"));
		expect(tail.truncated).toBe(true);
		expect(tail.log).toEqual({
			offset: maxBytes - 64,
			nextOffset: maxBytes,
			totalBytes: maxBytes,
			limitBytes: maxBytes,
			limitReached: true,
		});
		const codingReceipt = {
			schema: "qorpera.coding-command-result/v2" as const,
			workerId: randomUUID(),
			commandId: f.read.commandId,
			inputSha256: "a".repeat(64),
			state: "failed" as const,
			exitCode: 1,
			...tail,
		};
		expect(parseCloudCodingCommandReceipt(codingReceipt)).toEqual(codingReceipt);
		const machineReceipt = {
			schema: "qorpera.machine-command-result/v1" as const,
			machineId: randomUUID(),
			commandId: f.read.commandId,
			inputSha256: "a".repeat(64),
			state: "failed" as const,
			exitCode: 1,
			...tail,
		};
		expect(parseCloudMachineCommandReceipt(machineReceipt)).toEqual(machineReceipt);

		const seamOffset = maxBytes - tailMarker.length - emoji.length - 2;
		const acrossSeam = await readCodingCommandLog({
			...f,
			maxBytes,
			ring: true,
			read: { ...f.read, offset: seamOffset, limit: 64 },
		});
		expect(acrossSeam.output).toBe(`CC😀${tailMarker.toString("utf8")}`);
		expect(acrossSeam.log.nextOffset).toBe(maxBytes);
	});

	it("keeps ring mode file-free under maxBytes and rejects tampered ring predecessor files", async () => {
		const f = await fixture(Buffer.alloc(0));
		const maxBytes = 1_048_576;
		const handle = await open(f.path, "a");
		try {
			await collectCodingCommandOutput([Readable.from([Buffer.from("small output\n")])], handle, maxBytes, {
				ring: { path: f.path },
			});
		} finally {
			await handle.close();
		}
		await expect(stat(`${f.path}.prev`)).rejects.toThrow();
		const page = await readCodingCommandLog({ ...f, maxBytes, ring: true });
		expect(page.output).toBe("small output\n");
		expect(page.log.limitReached).toBe(false);

		const wrongSize = await fixture(Buffer.from("curr"));
		await writeFile(`${wrongSize.path}.prev`, Buffer.from("too-small"), { mode: 0o600 });
		await expect(readCodingCommandLog({ ...wrongSize, maxBytes, ring: true })).rejects.toThrow(
			"INVALID_CODING_GUEST_OUTPUT",
		);

		const linked = await fixture(Buffer.from("curr"));
		const target = join(linked.mountRoot, "other.log");
		await writeFile(target, Buffer.alloc(maxBytes, 65), { mode: 0o600 });
		await link(target, `${linked.path}.prev`);
		await expect(readCodingCommandLog({ ...linked, maxBytes, ring: true })).rejects.toThrow(
			"INVALID_CODING_GUEST_OUTPUT",
		);

		const sym = await fixture(Buffer.from("curr"));
		await symlink(target, `${sym.path}.prev`);
		await expect(readCodingCommandLog({ ...sym, maxBytes, ring: true })).rejects.toThrow();
	});
});
