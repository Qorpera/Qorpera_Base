import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, commentsIn, languageOf, MAX_LINES, newFindings, verdict } from "./check-comments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const texts = (path, source) => commentsIn(path, source).map((unit) => unit.lines.join(" | "));
const problems = (path, source) => commentsIn(path, source).map((unit) => verdict(unit));

test("script files: only real comments count, never the same marks inside strings, patterns or templates", () => {
	const source = [
		"#!/usr/bin/env node",
		'const url = "https://example.com/a//b"; // after code',
		"const pattern = /https?:\\/\\//;",
		"const text = `// inside ${value /* in a slot */} -- still text`;",
		"/** One doc line. */",
		"export function run() {",
		"\t// first",
		"\t// second",
		"\treturn 1; /* inline */",
		"}",
		"",
		"// apart",
	].join("\n");
	assert.deepEqual(texts("a.ts", source), [
		"after code",
		"in a slot",
		"One doc line.",
		"first | second",
		"inline",
		"apart",
	]);
	assert.deepEqual(texts("a.mjs", "const a = 1; // js too\n"), ["js too"]);
});

test("script files: text between tags is not a comment", () => {
	const source = ["const view = (", "\t<div>// shown to people {/* hidden */}</div>", ");"].join("\n");
	assert.deepEqual(texts("view.tsx", source), ["hidden"]);
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
				"/** @type {number} */",
				"const f = 6;",
				"/** Holds the count. @type {number} */",
				"const g = 7;",
				"/* why: lower case is not the marker */",
			].join("\n"),
		),
		["plain", null, "empty", null, null, null, null, "plain", "plain"],
	);
	const long = Array.from({ length: MAX_LINES + 1 }, (_, index) => `// ${index === 0 ? "WHY: " : ""}line ${index}`);
	assert.deepEqual(problems("a.ts", long.join("\n")), ["long"]);
	assert.deepEqual(problems("a.ts", long.slice(0, MAX_LINES).join("\n")), [null]);
	assert.deepEqual(problems("a.ts", "/**\n * WHY: one\n * two\n * three\n */\n"), [null]);
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

test("shell and Python: whole-line comments, without the first line's interpreter or text handed to a command", () => {
	const shell = [
		"#!/bin/sh",
		"# shellcheck disable=SC2086",
		"set -eu  # trailing notes are not read",
		"cat <<'EOF' > /etc/thing.conf",
		"# a line of the written file",
		"EOF",
		"\t# after the text",
		"echo ${#name}",
	].join("\n");
	assert.deepEqual(texts("run.sh", shell), ["shellcheck disable=SC2086", "after the text"]);
	assert.deepEqual(problems("run.sh", shell), [null, "plain"]);
	const python = ["#!/usr/bin/env python3", "# -*- coding: utf-8 -*-", "import os", "    # note", "x = 1"].join("\n");
	assert.deepEqual(problems("tool.py", python), [null, "plain"]);
});

test("generated and vendored files, and other file kinds, are left alone", () => {
	assert.equal(languageOf("packages/runtime/src/cloud-runtime-bundle.generated.ts"), null);
	assert.equal(languageOf("supabase/migrations/20260930700000_runtime_bundle_activation_v247.sql"), null);
	assert.equal(languageOf("packages/member-web/ui/vendor/chart.js"), null);
	assert.equal(languageOf("packages/web/public/sw.js"), null);
	assert.equal(languageOf("README.md"), null);
	assert.equal(languageOf("supabase/migrations/20260930769000_bank_days.sql"), "sql");
	assert.equal(languageOf("packages/runtime/src/run.ts"), "script");
});

test("only comments a change adds or edits are judged", () => {
	const before = ["// kept as written", "const a = 1;", "// first old line", "// second old line", "const b = 2;"].join("\n");
	const moved = ["const b = 2;", "// first old line", "// second old line", "const a = 1;", "// kept as written"].join("\n");
	assert.deepEqual(newFindings("a.ts", moved, [["a.ts", before]]), []);
	const edited = before.replace("second old line", "second line, reworded");
	assert.deepEqual(newFindings("a.ts", edited, [["a.ts", before]]), [
		{ path: "a.ts", line: 3, problem: "plain", text: "first old line" },
	]);
	assert.deepEqual(newFindings("a.ts", `${before}\n// WHY: the order matters to the supplier\n`, [["a.ts", before]]), []);
	assert.deepEqual(newFindings("b.ts", before, [["b.ts", null]]).length, 2);
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
	return { cwd, git, write, commit };
}

test("a branch is judged from the moment the rule reached it", (context) => {
	const { cwd, git, write, commit } = repository();
	context.after(() => rmSync(cwd, { recursive: true, force: true }));
	const found = (options) => check({ base: "master", cwd, ...options }).findings.map((finding) => `${finding.path}:${finding.text}`);

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
	assert.deepEqual(found({}), []);

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
	assert.deepEqual(found({}), committed);
	assert.deepEqual(found({ head: "work" }), committed);

	git("mv", "src/b.ts", "src/renamed.ts");
	write("supabase/new.sql", "-- an untracked note\nselect 1;\n");
	write("notes.md", "<!-- not a checked kind -->\n");
	assert.deepEqual(found({}), ["src/a.ts:tail", "src/renamed.ts:written after the rule", "supabase/new.sql:an untracked note"]);
	assert.deepEqual(found({ head: "work" }), committed);

	git("commit", "-q", "-m", "rename");
	rmSync(join(cwd, "supabase/new.sql"));
	rmSync(join(cwd, "notes.md"));
	git("checkout", "-q", "-b", "fresh", "master");
	commit("cut after the rule", { "src/e.ts": "// no exemption here\nexport const e = 1;\n" });
	assert.deepEqual(found({}), ["src/e.ts:no exemption here"]);
});

test("a release branch that merges work written before the rule does not answer for that work", (context) => {
	const { cwd, git, commit } = repository();
	context.after(() => rmSync(cwd, { recursive: true, force: true }));
	const found = (options) => check({ base: "master", cwd, ...options }).findings.map((finding) => `${finding.path}:${finding.text}`);

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
	assert.deepEqual(found({}), []);
	assert.deepEqual(found({ head: "release" }), []);

	commit("release work", { "src/held.ts": "// approved before the rule\nexport const held = 1;\n// written on the release\n" });
	assert.deepEqual(found({}), ["src/held.ts:written on the release"]);
});

test("the check and its tests keep the rule themselves", () => {
	for (const name of ["check-comments.mjs", "check-comments.test.mjs"]) {
		assert.deepEqual(newFindings(`scripts/${name}`, readFileSync(join(here, name), "utf8"), []), []);
	}
});
