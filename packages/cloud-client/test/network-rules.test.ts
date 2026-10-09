import { describe, expect, it } from "vitest";
import { companyStatePathProblems, parseCompanyStateFile } from "../src/company-state-files.ts";
import {
	isNetworkRulesName,
	NETWORK_RULES_MAX_NAMES,
	NETWORK_RULES_PATH,
	parseNetworkRulesFile,
} from "../src/network-rules.ts";

function ok(text: string) {
	const result = parseNetworkRulesFile(text);
	if (!result.ok) throw new Error(`expected the rules to parse: ${JSON.stringify(result.problems)}`);
	return result.file;
}

function refused(text: string) {
	const result = parseNetworkRulesFile(text);
	if (result.ok) throw new Error("expected the rules to be refused");
	return result.problems;
}

function keys(problems: readonly { key: string | null; code: string }[]) {
	return problems.map((problem) => [problem.key, problem.code]);
}

const list = (names: readonly unknown[]) => JSON.stringify(names);

const nordlys = `# Which names the company's machines reach.
mode = "only-listed"
block = ["casino.example", "*.torrents.example"]
allow = [
	"github.com",
	"*.npmjs.org", # the registry's mirrors
]
`;

describe("parseNetworkRulesFile", () => {
	it("reads the mode and both lists as written", () => {
		expect(parseNetworkRulesFile(nordlys)).toEqual({
			ok: true,
			file: {
				kind: "network-rules",
				mode: "only-listed",
				block: ["casino.example", "*.torrents.example"],
				allow: ["github.com", "*.npmjs.org"],
			},
			problems: [],
		});
	});

	it("is open with empty lists when the file says nothing", () => {
		const empty = { kind: "network-rules", block: [], allow: [] };
		for (const text of ["", "# nothing yet\n", "\n\n", 'mode = "open"\n'])
			expect(ok(text)).toEqual({ ...empty, mode: "open" });
		expect(ok('mode = "only-listed"\n')).toEqual({ ...empty, mode: "only-listed" });
	});

	it("keeps allow in open, so a list outlives a change of mode", () => {
		expect(ok('mode = "open"\nallow = ["github.com"]\n')).toEqual({
			kind: "network-rules",
			mode: "open",
			block: [],
			allow: ["github.com"],
		});
	});

	it("lets a blocked name and an allowed name under it stand together", () => {
		// The exit refuses a blocked name whatever allow says; only the same name in both lists is a mistake.
		expect(ok('block = ["*.github.com"]\nallow = ["github.com"]\n').block).toEqual(["*.github.com"]);
		expect(ok('block = ["github.com"]\nallow = ["api.github.com"]\n').allow).toEqual(["api.github.com"]);
	});

	it("refuses a file over 64 KiB and takes one at the bound", () => {
		expect(refused(`#${"x".repeat(64 * 1024)}`)).toEqual([
			{ line: null, key: null, code: "too_large", message: "The file is larger than 64 KiB." },
		]);
		expect(ok(`#${"x".repeat(64 * 1024 - 1)}`).mode).toBe("open");
	});

	it("refuses a byte order mark and a lone surrogate", () => {
		const encoding = [
			{ line: null, key: null, code: "encoding", message: "The file must be UTF-8 text without a byte order mark." },
		];
		expect(refused('﻿mode = "open"\n')).toEqual(encoding);
		expect(refused('mode = "\ud800"\n')).toEqual(encoding);
	});

	it("refuses text that is not TOML, with its line", () => {
		expect(refused("# rules\nmode = open\n")).toEqual([
			{ line: 2, key: null, code: "toml", message: '"open" is not a value; text goes in quotes.' },
		]);
		expect(refused('mode = "open"\nmode = "only-listed"\n')).toEqual([
			{ line: 2, key: null, code: "toml", message: '"mode" is set twice.' },
		]);
	});

	it("names every key it does not know", () => {
		expect(refused('mode = "open"\nallowed = ["github.com"]\n[proxy]\nport = 8080\n')).toEqual([
			{
				line: 2,
				key: "allowed",
				code: "unknown_key",
				message: '"allowed" is not a key here. Allowed: mode, block, allow.',
			},
			{
				line: 3,
				key: "proxy",
				code: "unknown_key",
				message: '"proxy" is not a key here. Allowed: mode, block, allow.',
			},
		]);
	});

	it("takes only open and only-listed as the mode", () => {
		for (const value of ['"closed"', '"Open"', '"only_listed"', "1", "true", '["open"]'])
			expect(refused(`\nmode = ${value}\n`)).toEqual([
				{ line: 2, key: "mode", code: "bad_value", message: "mode must be one of: open, only-listed." },
			]);
	});

	it("takes the lists as lists of quoted names", () => {
		for (const [text, key] of [
			['block = "casino.example"\n', "block"],
			["allow = [443]\n", "allow"],
			['allow = ["github.com", 443]\n', "allow"],
			['block = [["casino.example"]]\n', "block"],
			['block = { name = "casino.example" }\n', "block"],
			['[block]\nname = "casino.example"\n', "block"],
		] as const)
			expect(refused(text)).toEqual([
				{
					line: 1,
					key,
					code: "bad_value",
					message: `${key} must be a list of names in quotes, as ["example.com"].`,
				},
			]);
	});

	it("takes at most 1000 names a list", () => {
		const names = (count: number) => Array.from({ length: count }, (_, index) => `site-${index}.example`);
		expect(NETWORK_RULES_MAX_NAMES).toBe(1000);
		const full = `block = ${list(names(1000))}\nallow = ${list(names(1000).map((name) => `a.${name}`))}\n`;
		expect(ok(full).block).toHaveLength(1000);
		expect(refused(`mode = "only-listed"\nallow = ${list(names(1001))}\n`)).toEqual([
			{ line: 2, key: "allow", code: "too_large", message: "allow takes at most 1000 names, not 1001." },
		]);
	});

	it("says how to fix a name, entry by entry", () => {
		const problems = refused(
			`block = ${list([
				"https://casino.example",
				"casino.example/x",
				"Casino.Example",
				"casino.example.",
				"a.*.example",
				"*example.com",
				"10.0.0.1",
				"*.10.0.0.1",
				"ex_ample.com",
				"example.com:443",
				"",
				"casino.example",
			])}\n`,
		);
		expect(problems).toEqual(
			[
				'"https://casino.example": write the name alone, without https:// or a path.',
				'"casino.example/x": write the name alone, without https:// or a path.',
				'"Casino.Example": write the name in lowercase, as "casino.example".',
				'"casino.example.": write the name without the dot at the end.',
				'"a.*.example": a * stands only at the very front, as "*.example.com".',
				'"*example.com": a * stands only at the very front, as "*.example.com".',
				'"10.0.0.1" is an address. The rules list names; a site\'s addresses change.',
				'"*.10.0.0.1" is an address. The rules list names; a site\'s addresses change.',
				'"ex_ample.com" is not a name. Names are lowercase letters, digits, hyphens and dots, as "example.com".',
				'"example.com:443" is not a name. Names are lowercase letters, digits, hyphens and dots, as "example.com".',
				"An empty text is not a name.",
			].map((message, index) => ({ line: 1, key: `block[${index}]`, code: "bad_value", message })),
		);
	});

	it("clips a long entry in its message", () => {
		const [problem] = refused(`block = ${list([`${"a".repeat(70)}_.example`])}\n`);
		expect(problem?.message).toBe(
			`"${"a".repeat(57)}…" is not a name. Names are lowercase letters, digits, hyphens and dots, as "example.com".`,
		);
	});

	it("refuses a name twice in one list, and in both lists", () => {
		expect(refused('block = ["a.example", "b.example", "a.example"]\n')).toEqual([
			{ line: 1, key: "block[2]", code: "duplicate", message: 'block lists "a.example" twice.' },
		]);
		expect(refused('block = ["github.com"]\n\nallow = ["pypi.org", "github.com"]\n')).toEqual([
			{
				line: 3,
				key: "allow[1]",
				code: "duplicate",
				message: '"github.com" is both blocked and allowed. Keep it in one list.',
			},
		]);
		// A name that is not one is reported as that, once a list, and not again as an overlap.
		expect(keys(refused('block = ["Bad"]\nallow = ["Bad"]\n'))).toEqual([
			["block[0]", "bad_value"],
			["allow[0]", "bad_value"],
		]);
	});

	it("reports every problem in one pass", () => {
		const text = 'mode = "closed"\nblock = ["x_y", "a.example", "a.example"]\nallow = 1\nproxy = true\n';
		expect(keys(refused(text))).toEqual([
			["proxy", "unknown_key"],
			["mode", "bad_value"],
			["block[0]", "bad_value"],
			["block[2]", "duplicate"],
			["allow", "bad_value"],
		]);
	});

	it("reports at most 50 problems and counts the rest with the first one's code", () => {
		const bad = (count: number) => Array.from({ length: count }, (_, index) => `n_${index}`);
		const sixty = refused(`block = ${list(bad(60))}\n`);
		expect(sixty).toHaveLength(51);
		expect(sixty[49]?.key).toBe("block[49]");
		expect(sixty[50]).toEqual({ line: null, key: null, code: "bad_value", message: "and 10 more problems" });
		const mixed = refused(`block = ${list([...bad(50), "a.example", "a.example"])}\n`);
		expect(mixed[50]).toEqual({ line: null, key: null, code: "duplicate", message: "and 1 more problem" });
		expect(refused(`block = ${list(bad(50))}\n`)).toHaveLength(50);
	});
});

describe("isNetworkRulesName", () => {
	// The same cases as the database's qorpera_company_network_rules_name_valid (supabase/tests/949).
	const label = (char: string, length: number) => char.repeat(length);
	const longest = `${label("a", 63)}.${label("b", 63)}.${label("c", 63)}.${label("d", 61)}`;

	it("takes lowercase names of up to 253 characters, with *. in front for the names under one", () => {
		expect(longest).toHaveLength(253);
		for (const name of [
			"example.com",
			"*.example.com",
			"localhost",
			"a-b.c0.example",
			"xn--bcher-kva.example",
			"3com.example",
			"example.123a",
			`${label("a", 63)}.example`,
			longest,
			`*.${longest}`,
		])
			expect([name, isNetworkRulesName(name)]).toEqual([name, true]);
	});

	it("refuses addresses, URLs, wildcards anywhere but the front, and anything else", () => {
		for (const name of [
			`${longest}d`,
			`${label("a", 64)}.example`,
			"Example.com",
			"example.com.",
			"https://example.com",
			"example.com/x",
			"a.*.example.com",
			"*example.com",
			"*",
			"*.",
			"ex_ample.com",
			"-example.com",
			"example-.com",
			"a..example",
			".example.com",
			"",
			"10.0.0.1",
			"*.10.0.0.1",
			"1234",
			"example.com:443",
			"[::1]",
			"example.com\n",
			"bücher.example",
		])
			expect([name, isNetworkRulesName(name)]).toEqual([name, false]);
	});
});

describe("rules/network.toml as a company state file", () => {
	it("is read by its own parser through the one dispatch", () => {
		const result = parseCompanyStateFile(NETWORK_RULES_PATH, nordlys);
		expect(result).toMatchObject({
			ok: true,
			path: { kind: "network-rules", agent: null, group: null, name: null, todo: null, worker: null },
			file: { kind: "network-rules", mode: "only-listed", allow: ["github.com", "*.npmjs.org"] },
		});
		expect(parseCompanyStateFile(NETWORK_RULES_PATH, 'mode = "closed"\n')).toEqual({
			ok: false,
			path: { kind: "network-rules", agent: null, group: null, name: null, todo: null, worker: null },
			problems: [{ line: 1, key: "mode", code: "bad_value", message: "mode must be one of: open, only-listed." }],
		});
	});

	it("asks for the path in lowercase before reading the rules", () => {
		const result = parseCompanyStateFile("Rules/Network.toml", 'mode = "closed"\n');
		expect(result?.ok).toBe(false);
		if (result?.ok !== false) return;
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]).toMatchObject({ line: null, key: null, code: "name" });
		expect(result.problems[0]?.message).toMatch(/^write the path in lowercase, as /);
	});

	it("leaves a review rule a review rule", () => {
		expect(parseCompanyStateFile("rules/network.md", "x")?.path.kind).toBe("rule");
		expect(parseCompanyStateFile("rules/other.toml", 'mode = "open"\n')).toBeNull();
	});

	it("keeps its path for the file: no folder takes the name", () => {
		for (const folder of ["rules/network.toml", "Rules/Network.TOML/", "rules/network.toml//"])
			expect(companyStatePathProblems(folder, true)).toEqual([
				{
					line: null,
					key: null,
					code: "name",
					message: "rules/network.toml is the name of the network rules file, not a folder",
				},
			]);
		expect(companyStatePathProblems("rules/network.toml")).toEqual([]);
		expect(companyStatePathProblems("rules/network", true)).toEqual([]);
		expect(companyStatePathProblems("rules/drafts/network.toml", true)).toEqual([]);
	});
});
