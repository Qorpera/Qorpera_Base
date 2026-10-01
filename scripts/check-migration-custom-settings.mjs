// Refuses a migration that gives a function, procedure, role or database its own value for a custom parameter
// (a name with a dot, such as qorpera.company_fence_wait):
//   create function … set qorpera.x = '…'      alter function … set qorpera.x = '…'
//   alter role … set qorpera.x = '…'           alter database … set qorpera.x to '…'
// PostgreSQL 15+ lets only a superuser, or a role granted SET on that parameter, store such a value (guc.c,
// validate_option_array_item), and Supabase's postgres role, which applies the migrations in production, is
// neither: the migration fails with "permission denied to set parameter" (42501). The hosted-db tests apply
// migrations as a superuser and never see it; v158's production dry run did (20260928339380, 2026-10-01).
// set_config(name, value, true) and a SET [LOCAL] statement need no such right: use those inside the body.
//
// Statements in dynamic SQL (string and dollar-quoted literals, function and DO bodies) are checked too.
// Usage: node scripts/check-migration-custom-settings.mjs [FILE...]   (default: supabase/migrations/*.sql)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(root, "supabase", "migrations");

/** Values already applied in production, which a later migration may not repeat: `file: parameter`. None so far
 * (2026-10-01: the live schema of master has none but the five of 20260928339380, which never reached production). */
export const APPLIED = new Set([]);

const IDENT = String.raw`(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")`;
/** A custom parameter: dotted names, or one quoted identifier with a dot inside, as pg_get_functiondef prints it. */
const CUSTOM = String.raw`(?:"(?:[^"]|"")*\.(?:[^"]|"")*"|${IDENT}(?:\s*\.\s*${IDENT})+)`;
/** Statements whose SET or RESET clause is stored with the object, not run. */
const OWNER =
	/\b(?:create\s+(?:or\s+replace\s+)?(?:function|procedure)|alter\s+(?:function|procedure|routine|role|user|group|database))\b/i;
const SETTING = new RegExp(String.raw`\b(set|reset)\s+(${CUSTOM})`, "gi");

/** The text as code (comments dropped, every literal replaced by an empty one) and the literals' contents. */
export function lexSql(text) {
	let code = "";
	const literals = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "-" && text[i + 1] === "-") {
			const end = text.indexOf("\n", i);
			i = end < 0 ? text.length : end;
		} else if (c === "/" && text[i + 1] === "*") {
			let depth = 1;
			i += 2;
			while (i < text.length && depth > 0) {
				if (text.startsWith("/*", i)) {
					depth += 1;
					i += 2;
				} else if (text.startsWith("*/", i)) {
					depth -= 1;
					i += 2;
				} else i += 1;
			}
			code += " ";
		} else if (c === "'") {
			const escapes = /(?:^|[^a-z0-9_$])e$/i.test(code);
			let value = "";
			let j = i + 1;
			while (j < text.length) {
				if (escapes && text[j] === "\\") {
					const next = text[j + 1] ?? "";
					value += { n: "\n", t: "\t", r: "\r" }[next] ?? next;
					j += 2;
				} else if (text[j] === "'" && text[j + 1] === "'") {
					value += "'";
					j += 2;
				} else if (text[j] === "'") break;
				else value += text[j++];
			}
			literals.push(value);
			code += "''";
			i = j + 1;
		} else if (c === '"') {
			let j = i + 1;
			while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
			code += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "$" && !/[a-z0-9_$]$/i.test(code) && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(text.slice(i, i + 64))) {
			const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(text.slice(i, i + 64))[0];
			// A literal's contents may be a fragment of SQL (a patch's old or new text): an unclosed quote runs to its end.
			const found = text.indexOf(tag, i + tag.length);
			const end = found < 0 ? text.length : found;
			literals.push(text.slice(i + tag.length, end));
			code += "$$";
			i = end + tag.length;
		} else {
			code += c;
			i += 1;
		}
	}
	return { code, literals };
}

/** Every stored custom parameter value in `text`, its literals included: [{ statement, parameter }]. */
export function customSettings(text) {
	const { code, literals } = lexSql(text);
	const found = [];
	for (const statement of code.split(";")) {
		const owner = OWNER.exec(statement);
		if (!owner) continue;
		for (const match of statement.slice(owner.index).matchAll(SETTING))
			found.push({
				statement: owner[0].replace(/\s+/g, " ").toLowerCase(),
				parameter: match[2].replace(/\s+|"/g, "").toLowerCase(),
			});
	}
	for (const literal of literals) found.push(...customSettings(literal));
	return found;
}

/** Problems in these files, each as "file: …" (allowlisted ones left out). */
export function checkFiles(files) {
	const problems = [];
	for (const file of files) {
		const name = relative(root, file);
		for (const { statement, parameter } of customSettings(readFileSync(file, "utf8"))) {
			if (APPLIED.has(`${name}: ${parameter}`)) continue;
			problems.push(`${name}: ${statement} … set ${parameter}`);
		}
	}
	return problems;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const files = process.argv.length > 2
		? process.argv.slice(2).map((file) => resolve(file))
		: readdirSync(MIGRATIONS)
				.filter((name) => name.endsWith(".sql"))
				.sort()
				.map((name) => join(MIGRATIONS, name));
	const problems = checkFiles(files);
	if (problems.length > 0) {
		console.error(
			"A function, role or database setting of a custom parameter needs a superuser, which production's migration role is not (42501).\n" +
				"Set it in the body instead: set_config(name, value, true), and give the caller's value back (20260928339380 shows how).",
		);
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	console.log(`Migration custom settings: ${files.length} files, none stored with a function, role or database.`);
}
