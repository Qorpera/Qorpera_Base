import {
	fold,
	type MemoryTreeBuilt,
	type MemoryTreePart,
	memoryOverflow,
	memoryPartBytes,
	memoryPartRow,
	memoryRowBytes,
	memoryView,
} from "@qorpera/runtime/memory-tree/fold";
import { OVERFLOW, PLACEHOLDER, VIEW } from "@qorpera/runtime/memory-tree/tree";
import { expect, it } from "vitest";

function bytes(view: readonly MemoryTreePart[]): number {
	return view.reduce((total, item) => total + memoryPartBytes(item), 0);
}

/** Whether the parts tile `[0, T)` in order, each `node(l, k)` aligned to its size. */
function tiles(view: readonly MemoryTreePart[], T: number): boolean {
	let start = 0;
	for (const item of view) {
		if (item.k * 2 ** item.l !== start) return false;
		start += 2 ** item.l;
	}
	return start === T;
}

/** A pure, seeded choice of which lines are built and how long they are. */
function someBuilt(seed: number, chance: number): MemoryTreeBuilt {
	return (l, k) => {
		let h = Math.imul(l + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca6b) ^ seed;
		h ^= h >>> 15;
		h = Math.imul(h, 0x2c1b3c6d);
		h ^= h >>> 12;
		h = Math.imul(h, 0x297a2d39);
		h ^= h >>> 15;
		if ((h >>> 0) / 2 ** 32 >= chance) return undefined;
		return `${l}.${k}:${"t".repeat((h >>> 4) % 40)}`;
	};
}

/** §5.2 as written: each message joins, then the furthest pair merges while the view passes its budget. */
function foldAsWritten(T: number, built: MemoryTreeBuilt, budget: number): MemoryTreePart[] {
	const view: MemoryTreePart[] = [];
	for (let n = 1; n <= T; n += 1) {
		view.push({ l: 0, k: n - 1, text: built(0, n - 1) ?? null });
		while (bytes(view) > budget) {
			let best = -1;
			let distance = Number.NEGATIVE_INFINITY;
			for (let index = 0; index + 1 < view.length; index += 1) {
				const a = view[index];
				const b = view[index + 1];
				if (a.l !== b.l || a.k % 2 !== 0 || b.k !== a.k + 1 || built(a.l + 1, a.k / 2) === undefined) continue;
				const far = n / 2 ** a.l - a.k;
				if (far > distance) {
					best = index;
					distance = far;
				}
			}
			if (best < 0) break;
			const a = view[best];
			view.splice(best, 2, { l: a.l + 1, k: a.k / 2, text: built(a.l + 1, a.k / 2) ?? null });
		}
	}
	return view;
}

it("shows every message as itself while the view fits", () => {
	expect(fold(5, () => "x", 1_000_000).map(memoryPartRow)).toEqual(["0+1|x", "1+1|x", "2+1|x", "3+1|x", "4+1|x"]);
	expect(fold(0, () => "x", 100)).toEqual([]);
	expect(() => fold(-1, () => "x", 100)).toThrow();
});

it("merges the pair furthest from the end in its own size", () => {
	// Each row here costs 8 bytes as a JSON string with its separator, so 24 bytes hold three.
	expect(fold(4, () => "x", 24).map(memoryPartRow)).toEqual(["0+2|x", "2+1|x", "3+1|x"]);
	expect(fold(5, () => "x", 24).map(memoryPartRow)).toEqual(["0+2|x", "2+2|x", "4+1|x"]);
	// At 6, 0+2 and 2+2 are 3 of their size from the end and 4+1 and 5+1 only 2 of theirs.
	expect(fold(6, () => "x", 24).map(memoryPartRow)).toEqual(["0+4|x", "4+1|x", "5+1|x"]);
});

it("counts a row as the prompt sends it: a JSON string, escaped, and a separator", () => {
	expect(memoryRowBytes("0+1|x")).toBe(8);
	// `<` and `>` are sent as six characters each, each `"` as two, and æ is two bytes.
	expect(memoryRowBytes('0+1|<b>"æ"')).toBe(26);
	expect(memoryPartBytes({ l: 2, k: 1, text: "<&>" })).toBe(memoryRowBytes("4+4|<&>"));
	expect(memoryPartBytes({ l: 2, k: 1, text: null })).toBe(memoryRowBytes(`4+4|${PLACEHOLDER}`));
});

it("matches §5.2 as written, for lines built at random", () => {
	for (const chance of [1, 0.9, 0.6, 0.2]) {
		for (const budget of [60, 400, 1_500]) {
			const built = someBuilt(Math.round(chance * 1000) + budget, chance);
			for (const T of [1, 2, 3, 17, 64, 65, 250]) {
				expect(fold(T, built, budget), `chance ${chance}, budget ${budget}, T ${T}`).toEqual(
					foldAsWritten(T, built, budget),
				);
			}
		}
	}
});

it("tiles [0, T) with aligned parts, within its budget when every line is built", () => {
	const built: MemoryTreeBuilt = (l, k) => `${l}/${k}`;
	for (let T = 1; T <= 400; T += 1) {
		const view = fold(T, built, 300);
		expect(tiles(view, T), `T ${T}`).toBe(true);
		expect(bytes(view), `T ${T}`).toBeLessThanOrEqual(300);
	}
});

it("waits for lines not built, and past OVERFLOW merges the oldest pairs into placeholder parents", () => {
	expect(memoryPartRow({ l: 0, k: 5, text: null })).toBe("5+1|(not summarized yet: zoom it)");
	expect(memoryPartRow({ l: 0, k: 5, text: null })).toBe(`5+1|${PLACEHOLDER}`);
	const none: MemoryTreeBuilt = () => undefined;
	const leaves = fold(1_000, none, 2_000);
	expect(leaves).toHaveLength(1_000);
	expect(leaves.every((item) => item.l === 0 && item.text === null)).toBe(true);
	const view = memoryView(1_000, none, 2_000);
	expect(tiles(view, 1_000)).toBe(true);
	expect(bytes(view)).toBeLessThanOrEqual(2_000 * OVERFLOW);
	expect(view.every((item) => item.text === null)).toBe(true);
	// The older a part, the coarser.
	for (let index = 1; index < view.length; index += 1) expect(view[index].l).toBeLessThanOrEqual(view[index - 1].l);

	// Messages that are built keep their text at the end; their missing parents become placeholders before them.
	const leavesOnly: MemoryTreeBuilt = (l, k) => (l === 0 ? `message ${k}` : undefined);
	const mixed = memoryView(300, leavesOnly, 1_000);
	expect(tiles(mixed, 300)).toBe(true);
	expect(bytes(mixed)).toBeLessThanOrEqual(1_000 * OVERFLOW);
	expect(memoryPartRow(mixed[mixed.length - 1])).toBe("299+1|message 299");
	expect(mixed[0].text).toBeNull();
	// Within the budget, overflow changes nothing; with no siblings left, it stops.
	const fits = fold(10, leavesOnly, 1_000);
	expect(memoryOverflow(fits, leavesOnly, 1_000)).toEqual(fits);
	const lone: MemoryTreePart[] = [{ l: 0, k: 0, text: "x".repeat(500) }];
	expect(memoryOverflow(lone, none, 10)).toEqual(lone);
});

it("is a pure function of T and the built lines, and the next message's view keeps most of this one", () => {
	const built: MemoryTreeBuilt = (l, k) => `${l}.${k} ${"s".repeat(32)}`;
	expect(fold(2_100, built, 4_000)).toEqual(fold(2_100, built, 4_000));
	let steps = 0;
	let kept = 0;
	let previous = fold(2_000, built, 4_000).map(memoryPartRow);
	for (let T = 2_001; T <= 2_256; T += 1) {
		const rows = fold(T, built, 4_000).map(memoryPartRow);
		let shared = 0;
		while (shared < previous.length && rows[shared] === previous[shared]) shared += 1;
		steps += 1;
		if (shared * 2 >= previous.length) kept += 1;
		previous = rows;
	}
	// A level-l line changes about once per 2^l messages, so most steps change only the newest, finest parts.
	expect(kept / steps).toBeGreaterThanOrEqual(0.75);
});

it("folds 20,000 messages within VIEW, built or not", () => {
	const long: MemoryTreeBuilt = (l, k) => `${l}.${k} ${"n".repeat(480)}`;
	const built = fold(20_000, long, VIEW);
	expect(tiles(built, 20_000)).toBe(true);
	expect(bytes(built)).toBeLessThanOrEqual(VIEW);
	const short = fold(20_000, () => "ok", VIEW);
	expect(tiles(short, 20_000)).toBe(true);
	expect(bytes(short)).toBeLessThanOrEqual(VIEW);
	const none = memoryView(20_000, () => undefined, VIEW);
	expect(tiles(none, 20_000)).toBe(true);
	expect(bytes(none)).toBeLessThanOrEqual(VIEW * OVERFLOW);
});
