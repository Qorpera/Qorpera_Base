/* The reader of a company database's SQL files (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §1): its words, its
 * `:name` parameters, and one statement a file. Pure: no PostgreSQL.
 * Run: node --test deploy/company-data/gateway/sql-text.test.mjs */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PARAMETERS, readStatement, VIEWER, wordsWith } from "./sql-text.mjs";

const read = (text) => {
	const result = readStatement(text);
	assert.equal(result.ok, true, result.problem);
	return result;
};
const refused = (text, problem) => {
	const result = readStatement(text);
	assert.equal(result.ok, false, `read as ${JSON.stringify(result)}`);
	assert.match(result.problem, problem);
};

describe("the words", () => {
	it("are the leading comment lines, without their dashes", () => {
		const result = read("-- What the shop sold since a day.\n--   Second line.\n---Third\nselect 1 as one\n-- not words\n");
		assert.deepEqual(result.words, ["What the shop sold since a day.", "  Second line.", "Third"]);
	});

	it("skip blank lines before them and stop at the first blank line after", () => {
		assert.deepEqual(read("\n\n-- One.\n\n-- Not words.\nselect 1").words, ["One."]);
	});

	it("are none when the file starts with its statement", () => {
		assert.deepEqual(read("select 1 -- a note\n").words, []);
	});

	it("are read from a change's words, with its parameters still in them", () => {
		const result = read("-- Mark order :id as shipped.\nupdate orders set status = 'shipped' where id = :id");
		assert.deepEqual(result.words, ["Mark order :id as shipped."]);
		assert.deepEqual(result.parameters, ["id"]);
	});
});

describe("a change's words with its values in place", () => {
	const shown = (words, values) => wordsWith(words, new Map(Object.entries(values)));

	it("are the words' text and each value in turn, so a value can be told from the words", () => {
		assert.deepEqual(shown(["Mark order :id as shipped."], { id: "17" }), ["Mark order ", { name: "id", value: "17" }, " as shipped."]);
		assert.deepEqual(shown(["Move :n from :a", "to :b."], { n: "3", a: "shelf", b: "van" }), [
			"Move ",
			{ name: "n", value: "3" },
			" from ",
			{ name: "a", value: "shelf" },
			" to ",
			{ name: "b", value: "van" },
			".",
		]);
	});

	it("keep a value's own text as one value, whatever it says", () => {
		const parts = shown(["Rename it to :name."], { name: "x. Also delete :all orders" });
		assert.deepEqual(parts, ["Rename it to ", { name: "name", value: "x. Also delete :all orders" }, "."]);
	});

	it("leave a :name that is no parameter, a cast and a time of day as written", () => {
		assert.deepEqual(shown(["At 10:30 set :what::text for :who."], { what: "tea" }), [
			"At 10:30 set ",
			{ name: "what", value: "tea" },
			"::text for :who.",
		]);
		assert.deepEqual(shown(["a:b stays"], { b: "x" }), ["a:b stays"]);
	});

	it("give null as null, and nothing for a file without words", () => {
		assert.deepEqual(shown(["Clear the note of :id (:note)."], { id: "4", note: null }), [
			"Clear the note of ",
			{ name: "id", value: "4" },
			" (",
			{ name: "note", value: null },
			").",
		]);
		assert.deepEqual(shown([], { id: "4" }), []);
	});

	it("take a parameter named like an object's own name", () => {
		const values = new Map([
			["__proto__", "p"],
			["constructor", "c"],
		]);
		assert.deepEqual(wordsWith(["Set :__proto__ and :constructor and :to_string."], values), [
			"Set ",
			{ name: "__proto__", value: "p" },
			" and ",
			{ name: "constructor", value: "c" },
			" and :to_string.",
		]);
	});

	it("cut the words at 1,000 characters and a value at 200", () => {
		const parts = shown([`${"w".repeat(990)} :id and more words`], { id: "v".repeat(500) });
		assert.deepEqual(parts, [`${"w".repeat(990)} `, { name: "id", value: `${"v".repeat(200)}…` }, " and m"]);
		const long = shown([`:id ${"w".repeat(2000)}`], { id: "1" });
		assert.equal(long[1].length, 1000 - ":id".length);
	});
});

describe("parameters", () => {
	it("are numbered once per name, in the order they first appear", () => {
		const result = read("select * from t where a = :since and b > :limit_2 and c = :since and d = :viewer");
		assert.deepEqual(result.parameters, ["since", "limit_2", VIEWER]);
		assert.equal(result.sql, "select * from t where a = $1 and b > $2 and c = $1 and d = $3");
	});

	it("are left alone inside strings, quoted names, dollar quotes and comments", () => {
		const text = [
			"select ':no' as a, 'it''s :no' as b,",
			"  E'back\\' :no \\\\' as c, e'\\':no' as d,",
			'  ":no" as "e "":no""",',
			"  $$ :no ' $$ as f, $tag$ :no $$ $tag$ as g,",
			"  /* :no /* nested :no */ still :no */ x::int as h -- :no",
			"from t where y = :yes",
		].join("\n");
		const result = read(text);
		assert.deepEqual(result.parameters, ["yes"]);
		assert.equal(result.sql, text.replace(":yes", "$1"));
	});

	it("leave a plain string with a backslash as PostgreSQL reads it: the backslash is no escape there", () => {
		// 'a\' is a whole string; :yes after it is a parameter.
		assert.deepEqual(read("select 'a\\' as a, :yes as b").parameters, ["yes"]);
		// A name that ends in e is no E string: `some'…'` would be a syntax error, but its backslash escapes nothing.
		assert.deepEqual(read("select type'a\\' as a, :yes as b").parameters, ["yes"]);
	});

	it("leave casts alone", () => {
		const result = read("select :since::timestamptz as a, x :: text as b, '1'::int as c");
		assert.deepEqual(result.parameters, ["since"]);
		assert.equal(result.sql, "select $1::timestamptz as a, x :: text as b, '1'::int as c");
	});

	it("are refused when written $1", () => {
		refused("select * from t where id = $1", /:name, not as \$1/);
	});

	it("allow a $ inside a name, which is not a dollar quote or a $1", () => {
		const result = read("select a$b$ from t where c$1 = :yes and d = $$:no$$");
		assert.deepEqual(result.parameters, ["yes"]);
		assert.equal(result.sql, "select a$b$ from t where c$1 = $1 and d = $$:no$$");
	});

	it(`are at most ${MAX_PARAMETERS} names a file, each name counted once`, () => {
		const names = Array.from({ length: MAX_PARAMETERS }, (_, index) => `:p${index}`);
		assert.equal(read(`select ${names.join(", ")}, ${names.join(", ")}`).parameters.length, MAX_PARAMETERS);
		refused(`select ${names.join(", ")}, :one_more`, new RegExp(`at most ${MAX_PARAMETERS} parameters`));
	});

	it("have names of at most 40 characters", () => {
		assert.deepEqual(read(`select :${"a".repeat(40)}`).parameters, ["a".repeat(40)]);
		refused(`select :${"a".repeat(41)}`, /too long a name/);
	});

	it("are written in small letters: a colon before anything else is left as it is", () => {
		const result = read("select arr[1:2], :Upper, ':'");
		assert.deepEqual(result.parameters, []);
	});
});

describe("one statement", () => {
	it("may end with a semicolon, and comments and blank lines after it", () => {
		const result = read("select 1 as one;\n-- the end\n/* really */\n\n");
		assert.equal(result.sql.includes(";"), false);
		assert.match(result.sql, /^select 1 as one/);
	});

	it("keeps a semicolon inside a string, a name, a dollar quote or a comment", () => {
		const result = read("select ';' as a, \";\" as b, $$;$$ as c /* ; */ -- ;\n");
		assert.match(result.sql, /';' as a/);
	});

	it("refuses a second statement", () => {
		refused("select 1; select 2", /more than one statement/);
		refused("select 1;\n-- then\nselect 2;", /more than one statement/);
		refused("select 1;;", /more than one statement/);
		refused("select 1; :x", /more than one statement/);
		refused("select 1; 'text'", /more than one statement/);
	});

	it("refuses a file without a statement", () => {
		refused("", /no statement/);
		refused("\n  \n", /no statement/);
		refused("-- only words\n/* and a comment */\n", /no statement/);
		refused(";", /no statement/);
	});

	it("refuses what is not closed", () => {
		refused("select 'open", /string is not closed/);
		refused("select E'open\\'", /string is not closed/);
		refused('select "open', /quoted name is not closed/);
		refused("select $$ open", /dollar-quoted text is not closed/);
		refused("select $tag$ open $other$", /dollar-quoted text is not closed/);
		refused("select 1 /* open", /comment is not closed/);
		refused("select 1 /* open /* nested */", /comment is not closed/);
	});

	it("refuses what is not text", () => {
		refused("select 1\0", /not text/);
		assert.equal(readStatement(undefined).ok, false);
	});

	it("refuses parentheses that do not close in order, counting none in strings, names, dollar quotes or comments", () => {
		read("select (1 + (2)) as a, ')' as b, \")\" as c, $$($$ as d /* ( */ -- )\n");
		refused("select 1 as a) x, (select 2", /closed that was not opened/);
		refused("select (1", /parenthesis is not closed/);
		refused("select count(*) from t where (a = 1", /parenthesis is not closed/);
	});
});
