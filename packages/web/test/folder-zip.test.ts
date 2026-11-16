import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { crc32, StoredZip, storedZipBytes } from "../src/app/views/folder-zip.ts";
import { readZip } from "./zip-reader.ts";

const encoder = new TextEncoder();
const modified = new Date(2026, 10, 16, 14, 30, 42);

async function bytesOf(parts: readonly Blob[]): Promise<Uint8Array> {
	return new Uint8Array(await new Blob([...parts]).arrayBuffer());
}

function filled(bytes: number, seed: number): Uint8Array {
	return Uint8Array.from({ length: bytes }, (_, index) => (index * 31 + seed) & 0xff);
}

describe("the stored zip a folder downloads as (app/views/folder-zip.ts)", () => {
	it("counts CRC-32 as zip does, also across pieces", () => {
		expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
		const whole = filled(70_000, 3);
		expect(crc32(whole.subarray(40_000), crc32(whole.subarray(0, 40_000)))).toBe(crc32(whole));
	});

	it("writes a known set of files as stored entries with their names, sizes, CRC-32 and bytes", async () => {
		const files = [
			{ name: "Notes/README.md", bytes: encoder.encode("# Notes\n") },
			{ name: "Notes/plan.txt", bytes: encoder.encode("one\ntwo\n") },
			{ name: "Notes/sub/empty.txt", bytes: new Uint8Array() },
		];
		const zip = new StoredZip();
		zip.folder("Notes", modified);
		const readme = zip.file(files[0]!.name, modified, false);
		readme.add(files[0]!.bytes);
		readme.end();
		const plan = zip.file(files[1]!.name, modified, true);
		plan.add(files[1]!.bytes);
		plan.end();
		zip.folder("Notes/sub", modified);
		const empty = zip.file(files[2]!.name, modified, false);
		empty.end();
		const made = zip.finish();
		const bytes = await bytesOf(made.parts);
		expect(bytes.byteLength).toBe(made.bytes);
		expect(made.bytes).toBe(
			storedZipBytes([
				{ name: "Notes/", bytes: 0 },
				{ name: "Notes/sub/", bytes: 0 },
				...files.map((file) => ({ name: file.name, bytes: file.bytes.byteLength })),
			]),
		);
		const entries = readZip(bytes);
		expect(entries.map((entry) => entry.name)).toEqual([
			"Notes/",
			"Notes/README.md",
			"Notes/plan.txt",
			"Notes/sub/",
			"Notes/sub/empty.txt",
		]);
		for (const file of files) {
			const entry = entries.find((each) => each.name === file.name)!;
			expect(entry.bytes).toEqual(file.bytes);
			expect(entry.crc).toBe(crc32(file.bytes));
			expect(entry.method).toBe(0);
			expect(entry.flags & 0x0800).toBe(0x0800);
		}
		expect(entries.find((entry) => entry.name === "Notes/plan.txt")!.mode).toBe(0o100755);
		expect(entries.find((entry) => entry.name === "Notes/README.md")!.mode).toBe(0o100644);
		expect(entries.find((entry) => entry.name === "Notes/")).toMatchObject({ mode: 0o40755, dos: 0x10 });
	});

	it("is an empty folder's zip: its folder alone", async () => {
		const zip = new StoredZip();
		zip.folder("Empty", modified);
		const made = zip.finish();
		const bytes = await bytesOf(made.parts);
		expect(made.bytes).toBe(storedZipBytes([{ name: "Empty/", bytes: 0 }]));
		expect(readZip(bytes)).toMatchObject([{ name: "Empty/", bytes: new Uint8Array(), crc: 0 }]);
	});

	it("keeps Danish letters in names as UTF-8 and counts their bytes", async () => {
		const name = "Kunder æøå/Årsrapport for Søren.md";
		const zip = new StoredZip();
		zip.folder("Kunder æøå", modified);
		const file = zip.file(name, modified, false);
		file.add(encoder.encode("Blåbærgrød\n"));
		file.end();
		const made = zip.finish();
		const bytes = await bytesOf(made.parts);
		expect(made.bytes).toBe(
			storedZipBytes([
				{ name: "Kunder æøå/", bytes: 0 },
				{ name, bytes: encoder.encode("Blåbærgrød\n").byteLength },
			]),
		);
		const entries = readZip(bytes);
		expect(entries.map((entry) => entry.name)).toEqual(["Kunder æøå/", name]);
		expect(new TextDecoder().decode(entries[1]!.bytes)).toBe("Blåbærgrød\n");
		expect(entries.every((entry) => entry.flags & 0x0800)).toBe(true);
	});

	it("writes a file of several chunks as one entry, with one CRC-32 over all of them", async () => {
		const chunk = 4 * 1024 * 1024;
		const pieces = [new Uint8Array(chunk).fill(1), new Uint8Array(chunk).fill(2), filled(1234, 3)];
		const whole = new Uint8Array(chunk * 2 + 1234);
		whole.set(pieces[0]!, 0);
		whole.set(pieces[1]!, chunk);
		whole.set(pieces[2]!, chunk * 2);
		const zip = new StoredZip();
		zip.folder("Big", modified);
		const file = zip.file("Big/film.mov", modified, false);
		for (const piece of pieces) file.add(piece);
		file.end();
		const made = zip.finish();
		expect(made.parts.length).toBe(1 + 1 + pieces.length + 2);
		const entries = readZip(await bytesOf(made.parts));
		expect(entries[1]!.bytes.byteLength).toBe(whole.byteLength);
		expect(Buffer.from(entries[1]!.bytes).equals(Buffer.from(whole))).toBe(true);
		expect(entries[1]!.crc).toBe(crc32(whole));
	});

	it("puts the time a file changed in its header, and a time before 1980 as 1 January 1980", async () => {
		const zip = new StoredZip();
		zip.folder("Old", new Date(1970, 0, 1));
		zip.file("Old/now.txt", modified, false).end();
		const bytes = await bytesOf(zip.finish().parts);
		const view = new DataView(bytes.buffer);
		expect(view.getUint16(10, true)).toBe(0);
		expect(view.getUint16(12, true)).toBe((1 << 5) | 1);
		const second = 30 + "Old/".length;
		expect(view.getUint16(second + 10, true)).toBe((14 << 11) | (30 << 5) | 21);
		expect(view.getUint16(second + 12, true)).toBe((46 << 9) | (11 << 5) | 16);
	});

	it("refuses a second entry while one is still being written", () => {
		const zip = new StoredZip();
		zip.file("a.txt", modified, false);
		expect(() => zip.file("b.txt", modified, false)).toThrow();
		expect(() => zip.finish()).toThrow();
	});
});
