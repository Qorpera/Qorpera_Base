import { describe, expect, it } from "vitest";
import { companyStatePath, companyStatePathProblems, parseCompanyStateFile } from "../src/company-state-files.ts";
import { parseMemoryRunToml } from "../src/memory-run-files.ts";

const RUN = "00000000-0000-0000-0000-000000000000";
const CONVERSATION = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const HASH = "a".repeat(64);
const ROOT = `agents/research/memory/thread/runs/${RUN}`;
const GROUP_ROOT = `agents/groups/research-team/memory/runs/${RUN}`;
const TOML = `format = 1\nrun = "${RUN}"\nconversation = "${CONVERSATION}"\n`;
const LOG = `${ROOT}/log/00000000.jsonl`;
const TREE = `${ROOT}/t0/00000000.jsonl`;

function ordinary(changes: Record<string, unknown> = {}) {
	return {
		j: 0,
		tool: "read_file",
		call: "call-1",
		args: '{"path":"projects/research.md"}',
		args_bytes: 31,
		args_hash: HASH,
		result: null,
		reads: [],
		releases: [],
		paths: ["projects/research.md"],
		text: "Read the brief",
		at: "2026-10-09T12:30:00Z",
		...changes,
	};
}

function narrow(changes: Record<string, unknown> = {}) {
	return {
		j: 0,
		tool: "read_file",
		call: "call-1",
		at: "2026-10-09T12:30:00Z",
		finished: false,
		releases: [],
		args_hash: HASH,
		narrow: true,
		...changes,
	};
}

function tree(changes: Record<string, unknown> = {}) {
	return { l: 0, k: 0, free: true, text: "The research brief is ready.", ...changes };
}

function lines(...rows: readonly unknown[]): string {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function accepts(path: string, text: string, kind: string) {
	const result = parseCompanyStateFile(path, text);
	expect(result).toMatchObject({ ok: true, file: { kind } });
	if (!result?.ok) throw new Error(`Expected valid ${path}: ${JSON.stringify(result)}`);
	expect(result.file).toEqual({ kind });
}

function refuses(path: string, text: string) {
	const result = parseCompanyStateFile(path, text);
	expect(result).toMatchObject({ ok: false });
	if (!result || result.ok) throw new Error(`Expected invalid ${path}`);
	expect(result.problems.length).toBeGreaterThan(0);
	return result.problems;
}

describe("memory run paths and canonical origins", () => {
	it("dispatches all three kinds in agent and group trees with kind-only SQL parses", () => {
		for (const root of [ROOT, GROUP_ROOT]) {
			accepts(`${root}/run.toml`, TOML, "memory-run");
			accepts(`${root}/log/00000000.jsonl`, lines(ordinary()), "memory-steps");
			accepts(`${root}/t0/00000000.jsonl`, lines(tree()), "memory-run-block");
			expect(companyStatePathProblems(`${root}/run.toml`)).toEqual([]);
		}
		expect(companyStatePath(`${GROUP_ROOT}/run.toml`)).toMatchObject({ agent: null, group: "research-team" });
	});

	it("uses the path key for classification and refuses noncanonical spelling and names", () => {
		for (const path of [
			ROOT.toUpperCase(),
			ROOT.replace("research/", "bad_name/"),
			GROUP_ROOT.replace("research-team", "bad name"),
		]) {
			expect(companyStatePath(`${path}/run.toml`)?.kind).toBe("memory-run");
			expect(refuses(`${path}/run.toml`, TOML)[0]?.code).toBe("name");
		}
		for (const suffix of [
			"run.md",
			"log/0.jsonl",
			"t15/00000000.jsonl",
			"t00/00000000.jsonl",
			"log/00000000.jsonl/extra",
		])
			expect(companyStatePath(`${ROOT}/${suffix}`)).toBeNull();
		for (const path of [
			ROOT.replace("/thread", ""),
			ROOT.replace(RUN, "not-a-run"),
			ROOT.replace("agents/", "projects/"),
		])
			expect(companyStatePath(`${path}/run.toml`)).toBeNull();
	});

	it("reads the exact SQL origin including optional parent, continuation and narrow", () => {
		expect(parseMemoryRunToml(TOML)).toEqual({
			run: RUN,
			conversation: CONVERSATION,
			parent: null,
			step: null,
			continues: null,
			narrow: false,
		});
		const text = `${TOML}parent = "${RUN}"\nstep = 999999999\ncontinues = "${CONVERSATION}"\nnarrow = true\n`;
		expect(parseMemoryRunToml(text)).toEqual({
			run: RUN,
			conversation: CONVERSATION,
			parent: RUN,
			step: 999999999,
			continues: CONVERSATION,
			narrow: true,
		});
		accepts(`${ROOT}/run.toml`, text, "memory-run");
		accepts(`${ROOT}/run.toml`, `${TOML}parent = "${RUN}"\nstep = 0\n`, "memory-run");
	});

	it("rejects TOML extensions, reordered or duplicated fields, and mismatched run IDs", () => {
		for (const text of [
			TOML.slice(0, -1),
			`${TOML}\n`,
			`\ufeff${TOML}`,
			TOML.replaceAll("\n", "\r\n"),
			TOML.replace("format = 1", "format=1"),
			TOML.replace(CONVERSATION, CONVERSATION.toUpperCase()),
			`${TOML}narrow = false\n`,
			`${TOML}step = 0\n`,
			`${TOML}parent = "${RUN}"\n`,
			`${TOML}parent = "${RUN}"\nstep = 1000000000\n`,
			`${TOML}parent = "${RUN}"\nstep = 00\n`,
			`${TOML}narrow = true\ncontinues = "${RUN}"\n`,
			`${TOML}run = "${RUN}"\n`,
			`${TOML}# comment\n`,
		]) {
			expect(parseMemoryRunToml(text)).toBeNull();
			refuses(`${ROOT}/run.toml`, text);
		}
		refuses(`${ROOT}/run.toml`, TOML.replace(`run = "${RUN}"`, `run = "${CONVERSATION}"`));
	});
});

describe("memory step blocks", () => {
	it("accepts runtime ordinary, narrow and erased serializations with closed shapes", () => {
		for (const row of [
			ordinary(),
			ordinary({
				result: { content: "Found the brief" },
				reads: [{ path: "projects/brief.md", version: RUN }],
				releases: [RUN],
				reads_cut: true,
			}),
			narrow(),
			narrow({ finished: true, result_hash: HASH, releases: [RUN] }),
			{ j: 0, tool: "read_file", call: "call-1", args_hash: null, erased: true, args_bytes: 0 },
			{ j: 0, tool: "read_file", call: "call-1", args_hash: HASH, erased: true, narrow: true },
		])
			accepts(LOG, lines(row), "memory-steps");
		accepts(LOG, lines(ordinary({ result: 0, reads: [{ path: "", version: null }] })), "memory-steps");
		// The SQL checks the timestamp's shape, not its calendar validity; state checks remain server-side.
		accepts(LOG, lines(ordinary({ at: "0000-99-99T99:99:99Z", args_bytes: 9999999999 })), "memory-steps");
	});

	it("refuses unknown fields, malformed variants and pending reads/releases", () => {
		for (const row of [
			ordinary({ extra: true }),
			ordinary({ tool: "" }),
			ordinary({ call: "a\tb" }),
			ordinary({ j: 2147483648 }),
			ordinary({ args_hash: "bad" }),
			ordinary({ args_bytes: 10000000000 }),
			ordinary({ reads_cut: true }),
			ordinary({ reads: [{ path: "x", version: null }] }),
			ordinary({ releases: [RUN] }),
			ordinary({ result: {}, reads_cut: false }),
			ordinary({ result: {}, reads: [{ path: "x" }] }),
			ordinary({ result: {}, reads: [{ path: "x", version: 1 }] }),
			ordinary({ result: {}, reads: [null] }),
			narrow({ narrow: false }),
			narrow({ result_hash: HASH }),
			narrow({ finished: true }),
			narrow({ finished: true, result_hash: null }),
			narrow({ finished: "true" }),
			narrow({ text: "hidden" }),
			narrow({ paths: [] }),
			ordinary({ paths: undefined }),
			ordinary({ paths: "projects/research.md" }),
			ordinary({ paths: [null] }),
			ordinary({ paths: [["projects/research.md"]] }),
			{ j: 0, tool: "read_file", call: "x", args_hash: null, erased: true, args_bytes: 0, paths: [] },
			{ j: 0, tool: "read_file", call: "x", args_hash: null, erased: false, args_bytes: 0 },
			{ j: 0, tool: "read_file", call: "x", args_hash: null, erased: true, narrow: true, args_bytes: 0 },
		])
			refuses(LOG, lines(row));
	});

	it("detects duplicate decoded keys at the root and in every reads object", () => {
		const raw = JSON.stringify(ordinary({ result: {} }));
		refuses(LOG, `${raw.replace('"j":0', '"j":0,"j":0')}\n`);
		refuses(LOG, `${raw.replace('"j":0', '"j":0,"\\u006a":0')}\n`);
		refuses(LOG, `${raw.replace('"reads":[]', '"reads":[{"path":"x","path":"x","version":null}]')}\n`);
		refuses(LOG, `${raw.replace('"reads":[]', '"reads":[{"path":"x","version":null,"\\u0076ersion":null}]')}\n`);
		// Arbitrary result objects are not closed; SQL jsonb intentionally keeps their last duplicate.
		accepts(LOG, `${raw.replace('"result":{}', '"result":{"x":1,"x":2}')}\n`, "memory-steps");
	});

	it("measures raw JSON fields including quotes, escapes, whitespace and UTF-8 bytes", () => {
		accepts(LOG, lines(ordinary({ args: "a".repeat(8190) })), "memory-steps");
		refuses(LOG, lines(ordinary({ args: "a".repeat(8191) })));
		accepts(LOG, lines(ordinary({ text: "é".repeat(4095) })), "memory-steps");
		refuses(LOG, lines(ordinary({ text: "é".repeat(4096) })));
		const raw = JSON.stringify(ordinary({ result: {} }));
		accepts(LOG, `${raw.replace('"result":{}', `"result":{${" ".repeat(8190)}}`)}\n`, "memory-steps");
		refuses(LOG, `${raw.replace('"result":{}', `"result":{${" ".repeat(8191)}}`)}\n`);
		accepts(LOG, `${raw.replace('"reads":[]', `"reads":[${" ".repeat(16382)}]`)}\n`, "memory-steps");
		refuses(LOG, `${raw.replace('"reads":[]', `"reads":[${" ".repeat(16383)}]`)}\n`);
		const paths = '"paths":["projects/research.md"]';
		accepts(LOG, `${raw.replace(paths, `"paths":[${" ".repeat(8190)}]`)}\n`, "memory-steps");
		refuses(LOG, `${raw.replace(paths, `"paths":[${" ".repeat(8191)}]`)}\n`);
		refuses(LOG, lines(ordinary({ paths: ["a".repeat(4096), "b".repeat(4096)] })));
		// Each path is at most 4,096 characters, counted as SQL's char_length counts them: by code point.
		accepts(LOG, lines(ordinary({ paths: [`${"a".repeat(4095)}😀`] })), "memory-steps");
		refuses(LOG, lines(ordinary({ paths: ["a".repeat(4097)] })));
		const numbered = (length: number) => Array.from({ length }, (_, index) => String(index));
		accepts(LOG, lines(ordinary({ paths: numbered(1024) })), "memory-steps");
		refuses(LOG, lines(ordinary({ paths: numbered(1025) })));
		refuses(
			LOG,
			`${raw.replace('"args":"{\\"path\\":\\"projects/research.md\\"}"', `"args":"${"\\u0061".repeat(1366)}"`)}\n`,
		);
	});

	it("checks newline, contiguous block numbers, line count and exact byte ceilings", () => {
		accepts(LOG, lines(...Array.from({ length: 16 }, (_, j) => ordinary({ j }))), "memory-steps");
		refuses(LOG, lines(...Array.from({ length: 17 }, (_, j) => ordinary({ j }))));
		refuses(LOG, lines(ordinary({ j: 1 })));
		refuses(LOG, lines(ordinary(), ordinary({ j: 2 })));
		accepts(`${ROOT}/log/00000015.jsonl`, lines(ordinary({ j: 15 }), ordinary({ j: 16 })), "memory-steps");
		const raw = JSON.stringify(ordinary());
		refuses(LOG, raw);
		refuses(LOG, `${raw}\n\n`);
		refuses(LOG, "\n");
		accepts(LOG, `${raw}${" ".repeat(50175 - raw.length)}\n`, "memory-steps");
		refuses(LOG, `${raw}${" ".repeat(50176 - raw.length)}\n`);
		const second = JSON.stringify(ordinary({ j: 1 }));
		const block = `${raw}${" ".repeat(32767 - raw.length)}\n${second}${" ".repeat(32767 - second.length)}\n`;
		accepts(LOG, block, "memory-steps");
		expect(refuses(LOG, `${block} `)[0]?.code).toBe("too_large");
	});

	it("matches decimal numeric semantics without accepting fractions or Unicode unsupported by jsonb", () => {
		const raw = JSON.stringify(ordinary());
		accepts(LOG, `${raw.replace('"j":0', '"j":0e0')}\n`, "memory-steps");
		accepts(LOG, `${raw.replace('"j":0', '"j":-0')}\n`, "memory-steps");
		refuses(LOG, `${raw.replace('"j":0', '"j":0.0')}\n`);
		for (const value of ["\u0000", "\ud800", "\udc00"]) refuses(LOG, lines(ordinary({ result: { nested: value } })));
		accepts(LOG, lines(ordinary({ tool: "😀".repeat(128), call: "😀".repeat(256) })), "memory-steps");
		refuses(LOG, lines(ordinary({ tool: "😀".repeat(129) })));
		refuses(LOG, `${raw.replace('"result":null', '"result":1e131073')}\n`);
	});
});

describe("memory run summary blocks", () => {
	it("enforces tier placement and sorted unique level/number pairs", () => {
		accepts(
			TREE,
			lines(tree(), tree({ k: 15 }), tree({ l: 1, k: 7 }), tree({ l: 3, k: 1, free: false, tries: 3 })),
			"memory-run-block",
		);
		accepts(`${ROOT}/t14/00000000.jsonl`, lines(tree({ l: 59, k: 1 })), "memory-run-block");
		for (const rows of [
			[tree({ k: 16 })],
			[tree({ l: 4 })],
			[tree({ l: 60 })],
			[tree({ l: -1 })],
			[tree(), tree()],
			[tree({ l: 1 }), tree()],
			[tree({ k: 2 }), tree({ k: 1 })],
			[tree({ free: false })],
			[tree({ tries: 1 })],
			[tree({ free: false, tries: 0 })],
			[tree({ seq: 0 })],
		])
			refuses(TREE, lines(...rows));
	});

	it("keeps bigint precision and refuses overflow before doing placement", () => {
		const raw = JSON.stringify(tree());
		for (const number of ["9223372036854775807", "9223372036854775808", "9007199254740993", "-1", "0.0"])
			refuses(TREE, `${raw.replace('"k":0', `"k":${number}`)}\n`);
		accepts(`${ROOT}/t0/99999999.jsonl`, lines(tree({ k: 1599999999 })), "memory-run-block");
		refuses(`${ROOT}/t0/99999999.jsonl`, lines(tree({ k: 1600000000 })));
		refuses(TREE, `${raw.replace('"l":0', '"l":0,"l":0')}\n`);
	});

	it("enforces escaped summary bytes, raw line length, control characters and block bounds", () => {
		accepts(TREE, lines(tree({ text: '"'.repeat(1024) })), "memory-run-block");
		refuses(TREE, lines(tree({ text: '"'.repeat(1025) })));
		accepts(TREE, lines(tree({ text: "é".repeat(1024) })), "memory-run-block");
		refuses(TREE, lines(tree({ text: "é".repeat(1025) })));
		refuses(TREE, lines(tree({ text: "line\nline" })));
		refuses(TREE, lines(tree({ text: "\u0085" })));
		const raw = JSON.stringify(tree());
		accepts(TREE, `${raw}${" ".repeat(2113 - raw.length)}\n`, "memory-run-block");
		refuses(TREE, `${raw}${" ".repeat(2114 - raw.length)}\n`);
		const thirty = [
			...Array.from({ length: 16 }, (_, k) => tree({ l: 0, k })),
			...Array.from({ length: 8 }, (_, k) => tree({ l: 1, k })),
			...Array.from({ length: 4 }, (_, k) => tree({ l: 2, k })),
			...Array.from({ length: 2 }, (_, k) => tree({ l: 3, k })),
		];
		accepts(TREE, lines(...thirty), "memory-run-block");
		refuses(TREE, lines(...thirty, tree()));
		expect(refuses(TREE, " ".repeat(65005))[0]?.code).toBe("too_large");
	});
});
