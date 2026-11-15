import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, commentLines, commentsIn, describeFindings, languageOf, MAX_LINES, newFindings, verdict } from "./check-comments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const texts = (path, source) => commentsIn(path, source).map((unit) => unit.lines.join(" | "));
const problems = (path, source) => commentsIn(path, source).map((unit) => verdict(unit));
const found = (findings) => findings.map((finding) => `${finding.line} ${finding.problem} ${finding.text}`);

test("script files: only real comments count, never the same marks inside strings, patterns or templates", () => {
	const source = [
		"#!/usr/bin/env node",
		'const url = "https://example.com/a//b"; // after code',
		"const pattern = /https?:\\/\\//;",
		"const inClass = /[/*]+/.test(url) ? url.split(/\\/\\*/) : [];",
		"const half = total / 2 / parts; // a division, then a comment",
		"const text = `// inside ${value /* in a slot */} -- still ${`nested ${{ a: 1 }.a} // text`} text`;",
		"/** One doc line. */",
		"export function run() {",
		"\t// first",
		"\t// second",
		"\treturn /\\/\\/ not a comment/.test(text) ? count++ / 2 : 1; /* inline */",
		"}",
		"",
		"// apart",
	].join("\n");
	assert.deepEqual(texts("a.ts", source), [
		"after code",
		"a division, then a comment",
		"in a slot",
		"One doc line.",
		"first | second",
		"inline",
		"apart",
	]);
	assert.deepEqual(texts("a.mjs", "const a = 1; // js too\n"), ["js too"]);
});

test("a comment passes only as a short reason or a tool directive", () => {
	assert.deepEqual(
		problems(
			"a.ts",
			[
				"// explains what the next line does",
				"const a = 1;",
				"// WHY: the supplier answers with old data for two seconds after a write",
				"const b = 2;",
				"// WHY:",
				"const c = 3;",
				"// biome-ignore lint/suspicious/noExplicitAny: the supplier type is open",
				"const d = 4;",
				"// @ts-expect-error the fixture leaves the field out on purpose",
				"const e = 5;",
				'/// <reference types="node" />',
				"/** @param user the member who asked */",
				"const f = 6;",
				"/* why: lower case is not the marker */",
			].join("\n"),
		),
		["plain", null, "empty", null, null, null, "plain", "plain"],
	);
	const long = Array.from({ length: MAX_LINES + 1 }, (_, index) => `// ${index === 0 ? "WHY: " : ""}line ${index}`);
	assert.deepEqual(problems("a.ts", long.join("\n")), ["long"]);
	assert.deepEqual(problems("a.ts", long.slice(0, MAX_LINES).join("\n")), [null]);
	assert.deepEqual(problems("a.ts", "/**\n * WHY: one\n * two\n * three\n */\n"), [null]);
});

test("a directive speaks only for its own line", () => {
	const source = [
		"// biome-ignore lint/suspicious/noExplicitAny: the supplier type is open",
		"// and here is a paragraph that rides along",
		"// on the directive's back",
		"const a: any = 1;",
		"/* eslint-disable no-console",
		"   with prose under it */",
	].join("\n");
	assert.deepEqual(texts("a.ts", source), [
		"biome-ignore lint/suspicious/noExplicitAny: the supplier type is open",
		"and here is a paragraph that rides along | on the directive's back",
		"eslint-disable no-console | with prose under it",
	]);
	assert.deepEqual(problems("a.ts", source), [null, "plain", "plain"]);
});

test("SQL: strings and data bodies are not comments; function bodies are read", () => {
	const source = [
		"-- heading",
		"select '-- not a comment', 'it''s -- fine', E'a\\'-- b', \"odd -- name\" from t; -- tail",
		"/* outer /* inner */ still outer */",
		"create function f() returns void language plpgsql as $body$",
		"begin",
		"\t-- inside the function",
		"\tperform $q$ -- text handed to execute $q$;",
		"end",
		"$body$;",
		"insert into guides (body) values ($md$ run it with -- two dashes $md$);",
		"do $$ begin /* in a do block */ null; end $$;",
	].join("\n");
	assert.deepEqual(texts("m.sql", source), [
		"heading",
		"tail",
		"outer /* inner */ still outer",
		"inside the function",
		"in a do block",
	]);
	assert.deepEqual(problems("m.sql", "-- WHY: the index must exist before the backfill reads it\n"), [null]);
	assert.deepEqual(
		problems(
			"t.test.sql",
			[
				'-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"',
				"select 1;",
				"-- @fixture without its file",
			].join("\n"),
		),
		[null, "plain"],
	);
});

test("Rust: lifetimes, characters and raw strings do not start or hide comments", () => {
	const source = [
		"//! crate doc",
		"fn pick<'a>(x: &'a str, c: char) -> &'a str { // tail",
		"\tlet quote = '\\''; let slash = '/'; let wide = 'æ';",
		'\tlet raw = r#"// not a comment "quoted" "#; let bytes = br"// nor this";',
		'\tlet plain = "http://x"; /* block /* nested */ end */',
		"\t// SAFETY: the pointer came from Box::into_raw two lines up",
		"\tx",
		"}",
	].join("\n");
	assert.deepEqual(texts("lib.rs", source), [
		"crate doc",
		"tail",
		"block /* nested */ end",
		"SAFETY: the pointer came from Box::into_raw two lines up",
	]);
	assert.deepEqual(problems("lib.rs", source), ["plain", "plain", "plain", null]);
});

test("shell: whole-line comments, without the interpreter line or text handed to a command", () => {
	const shell = [
		"#!/bin/sh",
		"# shellcheck disable=SC2086",
		"set -eu  # trailing notes are not read",
		"cat <<'EOF' > /etc/thing.conf",
		"# a line of the written file",
		"EOF",
		"\t# after the text",
		"echo ${#name} \"it's fine\" # one quote mark in a trailing note: it's ignored",
		"python3 -c '",
		"# a line of the program handed over",
		"print(1)'",
		'message="first line',
		"# a line of the message",
		'last line"',
		"# back in the script",
		"printf 'std::cout << \"c++\" << std::endl;' > main.cc",
		"# after two angle marks inside quotes",
		"mask=$((1 << shift)); grep -q x <<< \"$mask\"",
		"# after a shift and a here-string",
		'cat <<-"END" | tr a b',
		"\t# a line of the piped text",
		"\tEND",
		"# after the piped text",
	].join("\n");
	assert.deepEqual(texts("run.sh", shell), [
		"shellcheck disable=SC2086",
		"after the text",
		"back in the script",
		"after two angle marks inside quotes",
		"after a shift and a here-string",
		"after the piped text",
	]);
	assert.deepEqual(problems("run.sh", shell), [null, "plain", "plain", "plain", "plain", "plain"]);
});

test("Python: whole-line comments, without the interpreter line or lines inside long strings", () => {
	const python = [
		"#!/usr/bin/env python3",
		"# -*- coding: utf-8 -*-",
		"import os",
		'HELP = """',
		"# a heading in the help text",
		'"""',
		"    # note",
		"x = '''one line''' # trailing notes are not read",
		"# last",
	].join("\n");
	assert.deepEqual(texts("tool.py", python), ["-*- coding: utf-8 -*-", "note", "last"]);
	assert.deepEqual(problems("tool.py", python), [null, "plain", "plain"]);
});

test("generated and vendored files, and other file kinds, are left alone", () => {
	assert.equal(languageOf("packages/runtime/src/cloud-runtime-bundle.generated.ts"), null);
	assert.equal(languageOf("supabase/migrations/20260930700000_runtime_bundle_activation_v247.sql"), null);
	assert.equal(languageOf("packages/member-web/ui/vendor/chart.js"), null);
	assert.equal(languageOf("packages/web/public/sw.js"), null);
	assert.equal(languageOf("README.md"), null);
	assert.equal(languageOf("packages/web/src/view.tsx"), null);
	assert.equal(languageOf("supabase/migrations/20260930769000_bank_days.sql"), "sql");
	assert.equal(languageOf("packages/runtime/src/run.ts"), "script");
});

test("only comments a change adds or edits are judged, line by line", () => {
	const before = ["// kept as written", "const a = 1;", "// first old line", "// second old line", "const b = 2;"].join("\n");
	const moved = ["const b = 2;", "// first old line", "// second old line", "const a = 1;", "// kept as written"].join("\n");
	assert.deepEqual(newFindings("a.ts", moved, [["a.ts", before]]), []);

	const edited = before.replace("second old line", "second line, reworded");
	assert.deepEqual(found(newFindings("a.ts", edited, [["a.ts", before]])), ["4 plain second line, reworded"]);

	const reasonUnderOldComment = before.replace("// second old line", "// second old line\n// WHY: the order matters to the supplier");
	assert.deepEqual(newFindings("a.ts", reasonUnderOldComment, [["a.ts", before]]), []);

	const directiveUnderOldComment = before.replace("// second old line", "// second old line\n// biome-ignore lint/a/b: needed");
	assert.deepEqual(newFindings("a.ts", directiveUnderOldComment, [["a.ts", before]]), []);

	const reason = "// WHY: the supplier counts from one\nconst c = 3;";
	const reasonGrown = "// WHY: the supplier counts from one\n// and never from zero\nconst c = 3;";
	assert.deepEqual(newFindings("a.ts", reasonGrown, [["a.ts", reason]]), []);
	const reasonOvergrown = `// WHY: the supplier counts from one\n${"// more\n".repeat(MAX_LINES)}const c = 3;`;
	assert.deepEqual(found(newFindings("a.ts", reasonOvergrown, [["a.ts", reason]])), ["2 plain more"]);

	assert.deepEqual(newFindings("b.ts", before, [["b.ts", null]]).length, 2);
	assert.deepEqual(newFindings("b.ts", before, [["b.ts", null]], commentLines("a.ts", before)), []);
});

test("the report names the file, the line and what to do", () => {
	const lines = describeFindings(newFindings("src/a.ts", "// plain words\n", []));
	assert.equal(lines[0], 'src/a.ts:1  comment without "WHY:": plain words');
	assert.match(lines.join("\n"), /1 new or edited comment\(s\) break the comment rule \(AGENTS\.md, "Comments"\)/);
});

function repository() {
	const cwd = mkdtempSync(join(tmpdir(), "check-comments-"));
	const git = (...args) =>
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	const write = (path, text) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), text);
	};
	const commit = (message, files) => {
		for (const [path, text] of Object.entries(files)) write(path, text);
		git("add", "--", ...Object.keys(files));
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	const breaks = (options) => check({ base: "master", cwd, ...options }).findings.map((finding) => `${finding.path}:${finding.text}`);
	return { cwd, git, write, commit, breaks };
}

test("a branch is judged from the moment the rule reached it", (context) => {
	const { cwd, git, write, commit, breaks } = repository();
	context.after(() => rmSync(cwd, { recursive: true, force: true }));

	git("init", "-q", "-b", "master");
	commit("start", { "src/a.ts": "// old note\nexport const a = 1;\n" });
	git("checkout", "-q", "-b", "work");
	const settled = Array.from({ length: 12 }, (_, index) => `export const settled${index} = ${index};`);
	const early = commit("work before the rule", {
		"src/b.ts": ["// written before the rule", "export const b = 1;", ...settled, ""].join("\n"),
	});
	git("checkout", "-q", "master");
	commit("the rule", { "scripts/check-comments.mjs": "export {};\n" });
	git("checkout", "-q", "work");

	assert.deepEqual(check({ base: "master", head: early, cwd }), { skipped: true, findings: [] });

	git("merge", "-q", "--no-ff", "-m", "merge master", "master");
	assert.deepEqual(breaks({}), []);

	commit("work after the rule", {
		"src/a.ts": "// old note\nexport const a = 1; // tail\n",
		"src/b.ts": [
			"// written before the rule",
			"export const b = 1;",
			...settled,
			"// written after the rule",
			"export const c = 2;",
			"// WHY: the supplier counts from one",
			"export const d = c + 1;",
			"",
		].join("\n"),
	});
	const committed = ["src/a.ts:tail", "src/b.ts:written after the rule"];
	assert.deepEqual(breaks({}), committed);
	assert.deepEqual(breaks({ head: "work" }), committed);

	git("mv", "src/b.ts", "src/renamed.ts");
	write("supabase/new.sql", "-- an untracked note\nselect 1;\n");
	write("notes.md", "<!-- not a checked kind -->\n");
	assert.deepEqual(breaks({}), ["src/a.ts:tail", "src/renamed.ts:written after the rule", "supabase/new.sql:an untracked note"]);
	assert.deepEqual(breaks({ head: "work" }), committed);

	git("commit", "-q", "-m", "rename");
	rmSync(join(cwd, "supabase/new.sql"));
	rmSync(join(cwd, "notes.md"));
	git("checkout", "-q", "-b", "fresh", "master");
	commit("cut after the rule", { "src/e.ts": "// no exemption here\nexport const e = 1;\n" });
	assert.deepEqual(breaks({}), ["src/e.ts:no exemption here"]);
});

test("a release branch that merges work written before the rule does not answer for that work", (context) => {
	const { cwd, git, commit, breaks } = repository();
	context.after(() => rmSync(cwd, { recursive: true, force: true }));

	git("init", "-q", "-b", "master");
	commit("start", { "src/a.ts": "export const a = 1;\n" });
	git("checkout", "-q", "-b", "approved");
	commit("approved before the rule", { "src/held.ts": "// approved before the rule\nexport const held = 1;\n" });
	git("checkout", "-q", "-b", "approved-too", "master");
	commit("also approved before the rule", { "src/a.ts": "// also approved before the rule\nexport const a = 1;\n" });
	git("checkout", "-q", "master");
	commit("the rule", { "scripts/check-comments.mjs": "export {};\n" });

	git("checkout", "-q", "-b", "release");
	git("merge", "-q", "--no-ff", "-m", "merge approved", "approved");
	git("merge", "-q", "--no-ff", "-m", "merge approved-too", "approved-too");
	assert.deepEqual(breaks({}), []);
	assert.deepEqual(breaks({ head: "release" }), []);

	commit("release work", { "src/held.ts": "// approved before the rule\nexport const held = 1;\n// written on the release\n" });
	assert.deepEqual(breaks({}), ["src/held.ts:written on the release"]);
});

test("code that moves to another file keeps the comments it had", (context) => {
	const { cwd, git, write, commit, breaks } = repository();
	context.after(() => rmSync(cwd, { recursive: true, force: true }));
	const large = Array.from({ length: 40 }, (_, index) => `export const large${index} = ${index};`);
	const helper = ["// how the helper rounds", "export function helper() {", "\treturn 1;", "}"];

	git("init", "-q", "-b", "master");
	commit("start", {
		"scripts/check-comments.mjs": "export {};\n",
		"src/large.ts": [...large, ...helper, ""].join("\n"),
		"src/gone.sql": "-- why the table is wide\nselect 1;\n",
	});
	git("checkout", "-q", "-b", "work");
	write("src/large.ts", [...large, ""].join("\n"));
	write("src/helper.ts", [...helper, "// said for the first time", ""].join("\n"));
	git("rm", "-q", "src/gone.sql");
	write("src/kept.sql", "-- why the table is wide\nselect 2;\n");
	assert.deepEqual(breaks({}), ["src/helper.ts:said for the first time"]);

	git("add", "--", "src/large.ts", "src/helper.ts", "src/kept.sql");
	git("commit", "-q", "-m", "split the helper out");
	assert.deepEqual(breaks({ head: "work" }), ["src/helper.ts:said for the first time"]);
});

test("the check and its tests keep the rule themselves", () => {
	for (const name of ["check-comments.mjs", "check-comments.test.mjs"]) {
		assert.deepEqual(newFindings(`scripts/${name}`, readFileSync(join(here, name), "utf8"), []), []);
	}
});
