import {
	LINE_BYTES,
	type MemoryTreeLine,
	memoryBlockPath,
	memoryBlockText,
	memoryFreeLeaf,
	memoryFreeParent,
	memoryLineJson,
	memoryLineProblem,
	memoryLineStoredBytes,
	memoryLineText,
	memoryNodeAddress,
	NODE,
} from "@qorpera/runtime/memory-tree/tree";
import { expect, it } from "vitest";

const HASH = "a".repeat(64);

it("addresses a node by start and size, and finds its block by tier", () => {
	expect(memoryNodeAddress(3, 273)).toBe("2184+8");
	expect(memoryNodeAddress(0, 0)).toBe("0+1");
	// Tier 0 holds levels 0 to 3 of 16 messages per block; tier 1 levels 4 to 7 of 256.
	expect(memoryBlockPath(0, 2184)).toBe("t0/00000136.jsonl");
	expect(memoryBlockPath(3, 273)).toBe("t0/00000136.jsonl");
	expect(memoryBlockPath(0, 15)).toBe("t0/00000000.jsonl");
	expect(memoryBlockPath(0, 16)).toBe("t0/00000001.jsonl");
	expect(memoryBlockPath(4, 0)).toBe("t1/00000000.jsonl");
	expect(memoryBlockPath(7, 1)).toBe("t1/00000000.jsonl");
	expect(memoryBlockPath(4, 16)).toBe("t1/00000001.jsonl");
	expect(memoryBlockPath(8, 3)).toBe("t2/00000000.jsonl");
});

it("stores a line's text with control characters as spaces, and counts its bytes as the block does", () => {
	expect(memoryLineText("Jonas: line one\nline two\t\u0085end")).toBe("Jonas: line one line two  end");
	expect(memoryLineText("lone \ud800 surrogate")).toBe("lone \ufffd surrogate");
	expect(memoryLineText("pair \ud83d\ude00 kept")).toBe("pair \ud83d\ude00 kept");
	// UTF-8, with only " and \ escaped: Danish letters take two bytes each.
	expect(memoryLineStoredBytes('a"b\\')).toBe(6);
	expect(memoryLineStoredBytes("æøå")).toBe(6);
});

it("makes a free node within NODE, and stores it within 2 × NODE even when it is all quotes or control characters", () => {
	expect(memoryFreeLeaf("x".repeat(NODE))).toBe("x".repeat(NODE));
	expect(memoryFreeLeaf("x".repeat(NODE + 1))).toBeNull();
	expect(memoryFreeLeaf("ø".repeat(NODE / 2 + 1))).toBeNull();
	const quotes = memoryFreeLeaf('"'.repeat(NODE)) as string;
	expect(memoryLineStoredBytes(quotes)).toBe(2 * NODE);
	const controls = memoryFreeLeaf("\u0085".repeat(NODE / 2)) as string;
	expect(controls).toBe(" ".repeat(NODE / 2));
	expect(memoryLineProblem({ l: 0, k: 0, seq: 1, hash: HASH, free: true, text: quotes })).toBeNull();
	expect(memoryFreeParent("a".repeat(255), "b".repeat(256))).toBe(`${"a".repeat(255)} ${"b".repeat(256)}`);
	expect(memoryFreeParent("a".repeat(256), "b".repeat(256))).toBeNull();
});

it("writes a line with closed keys in the design's order, and refuses one the commit would refuse", () => {
	expect(memoryLineJson({ l: 0, k: 2184, seq: 9113, hash: HASH, free: true, text: "Jonas: hi" })).toBe(
		`{"l":0,"k":2184,"seq":9113,"hash":"${HASH}","free":true,"text":"Jonas: hi"}`,
	);
	expect(memoryLineJson({ l: 3, k: 273, free: false, tries: 2, text: "…" })).toBe(
		'{"l":3,"k":273,"free":false,"text":"…","tries":2}',
	);
	const bad: MemoryTreeLine[] = [
		{ l: 0, k: 0, free: true, text: "no event" },
		{ l: 0, k: 0, seq: 1, hash: "A".repeat(64), free: true, text: "hash in capitals" },
		{ l: 1, k: 0, seq: 1, hash: HASH, free: true, text: "an event above level 0" },
		{ l: 1, k: 0, free: false, text: "no tries" },
		{ l: 1, k: 0, free: true, tries: 1, text: "tries on a free line" },
		{ l: 1, k: 0, free: false, tries: 4, text: "too many tries" },
		{ l: 1, k: 0, free: true, text: "a\nnewline" },
		{ l: 1, k: 0, free: true, text: "x".repeat(LINE_BYTES + 1) },
		{ l: 1, k: 0, free: true, text: '"'.repeat(LINE_BYTES / 2 + 1) },
		{ l: 60, k: 0, free: true, text: "level too high" },
		{ l: 1, k: -1, free: true, text: "negative k" },
	];
	for (const line of bad) expect(() => memoryLineJson(line), line.text).toThrow(/Invalid memory tree line/);
	expect(memoryLineProblem({ l: 1, k: 0, free: true, text: "x".repeat(LINE_BYTES) })).toBeNull();
});

it("writes a block's lines in (l, k) order, and a full block at the limit within 65,004 bytes", () => {
	const line = (l: number, k: number): MemoryTreeLine =>
		l === 0
			? { l, k, seq: 10_000_000 + k, hash: HASH, free: false, tries: 3, text: '"'.repeat(LINE_BYTES / 2) }
			: { l, k, free: false, tries: 3, text: "\\".repeat(LINE_BYTES / 2) };
	const lines: MemoryTreeLine[] = [];
	for (let l = 3; l >= 0; l -= 1) for (let k = 2 ** (4 - l) - 1; k >= 0; k -= 1) lines.push(line(l, k));
	expect(lines).toHaveLength(30);
	const text = memoryBlockText(lines);
	expect(text.endsWith("\n")).toBe(true);
	const rows = text.slice(0, -1).split("\n");
	expect(rows).toHaveLength(30);
	expect(rows.map((row) => JSON.parse(row)).map((row) => [row.l, row.k])).toEqual(
		[...lines].sort((a, b) => a.l - b.l || a.k - b.k).map((item) => [item.l, item.k]),
	);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65_004);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
	expect(() => memoryBlockText([line(0, 0), line(0, 16)])).toThrow(/two blocks/);
	expect(() => memoryBlockText([line(0, 0), line(4, 0)])).toThrow(/two blocks/);
	expect(() => memoryBlockText([line(0, 1), line(0, 1)])).toThrow(/once/);
	expect(() => memoryBlockText([])).toThrow(/1 to 30/);
});

it("writes a run log's lines with no event at any level, and refuses one that names an event", () => {
	const step: MemoryTreeLine = { l: 0, k: 12, free: true, text: "company_read sales/prices.md" };
	expect(memoryLineJson(step, "run")).toBe('{"l":0,"k":12,"free":true,"text":"company_read sales/prices.md"}');
	expect(() => memoryLineJson(step)).toThrow(/seq and hash/);
	expect(memoryLineProblem({ ...step, seq: 1, hash: HASH }, "run")).toBe("a run log's line names no event");
	const level2: MemoryTreeLine = { l: 2, k: 0, hash: HASH, free: false, tries: 1, text: "Read the prices." };
	expect(memoryLineProblem(level2, "run")).toBe("a run log's line names no event");
	const parent: MemoryTreeLine = { l: 1, k: 6, free: false, tries: 1, text: "Read the prices." };
	const block = memoryBlockText([parent, step], "run");
	expect(block).toBe(`${memoryLineJson(step, "run")}\n${memoryLineJson(parent, "run")}\n`);
	expect(() => memoryBlockText([parent, step])).toThrow(/seq and hash/);
});
