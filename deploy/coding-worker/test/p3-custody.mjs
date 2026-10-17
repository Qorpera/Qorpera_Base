// P3's custody proof helpers (p3-driver.mjs with P3_CUSTODY=1): the forms a made-up vault value can take where it could
// leak, a guard that keeps them out of the driver's own output, the secret broker's database calls on the test database,
// and a search of every table for the forms. Nothing here prints a value or a form: only counts, names and paths.
import { randomBytes } from "node:crypto";
import { quote } from "./p3-database.mjs";

/** The executor's turn summary for a refused save (coding-executor.ts SAVE_REFUSAL), which names no path. */
export const SAVE_REFUSED =
	"The save was refused: a file this session wrote in the company folder carries one of the session's secret values, in its contents or its name. It was not saved, and nothing was published. Remove the value and finish again.";

/** The forms a value is searched in: itself, its hex (how a bytea column prints, and `xxd`), the part of its base64 in
 * either alphabet that only it decides at each of the three byte offsets (as the executor's mask has them), and its URL
 * encoding when that differs. */
export function custodyForms(value) {
	const bytes = Buffer.from(value, "utf8");
	const forms = new Set([value, bytes.toString("hex")]);
	for (const encoding of ["base64", "base64url"])
		for (let offset = 0; offset < 3; offset += 1) {
			const text = Buffer.concat([Buffer.alloc(offset), bytes, Buffer.alloc(2)]).toString(encoding);
			forms.add(text.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6)));
		}
	const encoded = encodeURIComponent(value);
	if (encoded !== value) forms.add(encoded);
	return [...forms];
}

// Where a line the driver prints comes from: the executor's journal and output, the stand-in PostgREST, the folder
// service's core calls, the executor's control calls, or the driver itself.
const SOURCES = [
	[/^(p3: )?executor( stdout)?: /, "executor"],
	[/^(p3: )?postgrest/, "postgrest"],
	[/^p3: core /, "core"],
	[/^p3: rpc /, "rpc"],
];

/** Keeps the forms out of what `stream` prints: a line that holds one is replaced by a line that says where it came
 * from and counts it in `counts`. The driver writes whole lines, so no form is split across two writes. */
export function withhold(stream, forms, counts) {
	const write = stream.write.bind(stream);
	stream.write = (chunk, ...rest) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (!forms.some((form) => text.includes(form))) return write(chunk, ...rest);
		if (typeof rest[0] === "string") rest.shift();
		const lines = text.split("\n").map((line) => {
			if (!forms.some((form) => line.includes(form))) return line;
			const source = SOURCES.find(([pattern]) => pattern.test(line))?.[1] ?? "driver";
			counts[source] = (counts[source] ?? 0) + 1;
			return `withheld: a line (${source}) that carried a custody form (${line.length} characters)`;
		});
		return write(lines.join("\n"), ...rest);
	};
}

/** The secret broker's database (its CloudSecretPostgresClient) on the test database: each query in one transaction as
 * the broker's own login, qorpera_secret_broker, with no JWT claims, committed (the broker's reads write audit rows).
 * A failure is noted by its SQLSTATE and first line only, and fails as the broker's client would. */
export function brokerDatabase(db, note) {
	return {
		async query(text, values = []) {
			const sql = text.replace(/\$(\d+)/g, (_, index) => {
				const value = values[Number(index) - 1];
				return value === null || value === undefined ? "null" : quote(String(value));
			});
			const marker = `@@p3broker${randomBytes(6).toString("hex")}@@`;
			let rows;
			try {
				rows = await db.marked(
					[
						"begin;",
						"select set_config('request.jwt.claims', '{}', true) \\g /dev/null",
						"set local session authorization qorpera_secret_broker;",
						`select ${quote(marker)} || coalesce(to_jsonb(q.result)::text, 'null') from (${sql}) as q;`,
						"commit;",
					].join("\n"),
					marker,
				);
			} catch (error) {
				note(`the broker's database call failed: ${error?.sqlState ?? "no SQLSTATE"} ${String(error?.message).split("\n")[0].slice(0, 200)}`);
				throw new Error("P3_BROKER_DATABASE_FAILED");
			}
			return { rowCount: rows.length, rows: rows.map((result) => ({ result })) };
		},
	};
}

/** Which tables (schema.table) hold each needle anywhere in a row's text, by needle; a bytea prints as hex there. The
 * needles are the function's argument, never its body, and nothing is committed. */
export async function databaseHolds(db, needles) {
	const marker = `@@p3holds${randomBytes(6).toString("hex")}@@`;
	const text = [
		"begin;",
		`create function pg_temp.p3_holds(p_needles text[]) returns jsonb language plpgsql as $holds$
declare v_table record; v_found int[]; v_holds jsonb := '{}';
begin
	for v_table in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(temp|toast)'
	loop
		execute format('select coalesce(array_agg(distinct i), ''{}'') from %I.%I r, generate_subscripts($1, 1) i '
			'where strpos(r::text, $1[i]) > 0', v_table.nspname, v_table.relname) into v_found using p_needles;
		for i in 1 .. coalesce(array_length(v_found, 1), 0) loop
			v_holds := jsonb_set(v_holds, array[v_found[i]::text],
				coalesce(v_holds -> (v_found[i]::text), '[]') || to_jsonb(v_table.nspname || '.' || v_table.relname));
		end loop;
	end loop;
	return v_holds;
end $holds$;`,
		`select ${quote(marker)} || pg_temp.p3_holds(array[${needles.map(quote).join(", ")}]::text[])::text;`,
	].join("\n");
	let holds;
	try {
		[holds] = await db.marked(text, marker);
	} catch (error) {
		throw new Error(`the table search failed: ${error?.sqlState ?? "no SQLSTATE"}`);
	}
	return needles.map((_, index) => holds?.[String(index + 1)] ?? []);
}

/** One JSON value of `select` as postgres (null when there is no row). */
export async function value(db, select) {
	const marker = `@@p3value${randomBytes(6).toString("hex")}@@`;
	const [found] = await db.marked(`select ${quote(marker)} || coalesce((${select})::text, 'null');`, marker);
	return found ?? null;
}
