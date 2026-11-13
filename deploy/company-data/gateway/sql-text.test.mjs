/* The reader of a company database's SQL files (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §1): its words, its
 * `:name` parameters, and one statement a file. Pure: no PostgreSQL.
 * Run: node --test deploy/company-data/gateway/sql-text.test.mjs */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PARAMETERS, readStatement, VIEWER } from "./sql-text.mjs";

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
});
