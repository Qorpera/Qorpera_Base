import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { parseCloudCodingCommandRead, parseCloudCodingCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
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
		for (const patch of [{ offset: -1 }, { limit: 3 }, { tail: true, offset: 0 }, { offset: 1.5 }, { limit: 16385 }])
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
});
