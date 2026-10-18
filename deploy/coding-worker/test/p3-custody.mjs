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

/** The git objects the company folder holds, searched for the forms (one per line of the file `forms`) and for the
 * control (the file `control`), two ways, as git reads them:
 * - `store`: each object in the store that inflates as a git loose object (zlib, "<type> <size>\0"), as a loose object
 *   the folder saved in one chunk sits there;
 * - `saved`: the folder's saved files under each `code/<owner>/<name>/repo.git/objects/` (every version the path
 *   versions name: path, manifest and file SHA-256), each read back from the store through its manifest's chunks into a
 *   bare repository, which `git cat-file --batch-all-objects --batch` reads whole, packed and deltified objects too.
 * Each object found is named by its git id, its type and where it is: a store object's SHA-256, or the folder path of
 * the loose object or the pack. `oids` are looked for among the objects each way reads. It runs in the node as
 * `node -e` (so `require` is an argument) and returns only counts, ids and paths, never a value or a form. */
export function gitObjectSearch(require, { store, saved, forms, control, oids, scratch }) {
	const { createHash } = require("node:crypto");
	const fs = require("node:fs");
	const { dirname, join } = require("node:path");
	const { execFileSync } = require("node:child_process");
	const { constants, inflateSync } = require("node:zlib");
	const needles = fs.readFileSync(forms, "utf8").split("\n").filter(Boolean).map((form) => Buffer.from(form));
	const marker = Buffer.from(fs.readFileSync(control, "utf8").trim());
	const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
	const git = (args, input) => execFileSync("git", args, { input, maxBuffer: 2 ** 30, stdio: ["pipe", "pipe", "pipe"] });
	const HEADER = /^(blob|tree|commit|tag) (\d+)\0/;
	const result = (found) => ({ forms: [], control: [], seen: [], ...found });
	const sort = (object, content, into) => {
		if (needles.some((needle) => content.includes(needle))) into.forms.push(object);
		if (content.includes(marker)) into.control.push(object);
		if (oids.includes(object.oid)) into.seen.push(object.oid);
	};

	// The store, every file in it, by its name.
	const files = [];
	const walk = (folder) => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
			if (entry.isDirectory()) walk(join(folder, entry.name));
			else if (entry.isFile()) files.push([join(folder, entry.name), entry.name]);
	};
	walk(store);
	const inStore = result({ objects: files.length, git: 0 });
	for (const [path, name] of files) {
		const bytes = fs.readFileSync(path);
		// A zlib stream's header: deflate, and its first two bytes a multiple of 31.
		if (bytes.length < 2 || (bytes[0] & 0x0f) !== 8 || (bytes[0] * 256 + bytes[1]) % 31 !== 0) continue;
		let inflated;
		try {
			// A chunk may hold only the start of a stream: what it holds is read.
			inflated = inflateSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 2 ** 30 });
		} catch {
			continue;
		}
		const header = HEADER.exec(inflated.subarray(0, 32).toString("latin1"));
		if (!header) continue;
		inStore.git += 1;
		const whole = inflated.length === header[0].length + Number(header[2]);
		sort({ object: name, oid: whole ? digest("sha1", inflated) : null, type: header[1] }, inflated.subarray(header[0].length), inStore);
	}

	// The saved folder: each repository's objects, one bare repository for each version of a path (a loose object and a
	// pack keep their names, so there is one in practice).
	const byName = new Map(files.map(([path, name]) => [name, path]));
	const read = (sha256) => {
		const path = byName.get(sha256);
		const bytes = path ? fs.readFileSync(path) : null;
		return bytes && digest("sha256", bytes) === sha256 ? bytes : null;
	};
	const inSaved = result({ files: saved.length, missing: 0, repositories: 0, objects: 0 });
	const directory = fs.mkdtempSync(join(scratch, "p3-git-"));
	try {
		const layers = [];
		for (const { path, manifest, file } of saved) {
			const [, repository, rest] = /^(code\/[^/]+\/[^/]+\/repo\.git)\/(objects\/.+)$/.exec(path) ?? [];
			// Not a place git reads objects from, or one that would send it elsewhere (alternates).
			if (!repository || /^objects\/info\/(http-)?alternates$/.test(rest)) continue;
			const text = read(manifest);
			const chunks = text ? JSON.parse(text.toString("utf8")).chunks.map((chunk) => read(chunk.sha256)) : [null];
			const bytes = chunks.includes(null) ? null : Buffer.concat(chunks);
			if (!bytes || digest("sha256", bytes) !== file) {
				inSaved.missing += 1;
				continue;
			}
			if (layers.some((at) => at.repository === repository && at.files.get(rest) === file)) continue;
			let layer = layers.find((at) => at.repository === repository && !at.files.has(rest));
			if (!layer) {
				layer = { repository, files: new Map(), directory: join(directory, String(layers.length)) };
				git(["init", "-q", "--bare", layer.directory]);
				layers.push(layer);
			}
			layer.files.set(rest, file);
			fs.mkdirSync(dirname(join(layer.directory, rest)), { recursive: true });
			fs.writeFileSync(join(layer.directory, rest), bytes);
		}
		inSaved.repositories = new Set(layers.map((layer) => layer.repository)).size;
		for (const { repository, files: saves, directory: at } of layers) {
			// Where an object is: its loose path, and each pack whose index lists it.
			const packs = [...saves.keys()].filter((rest) => /^objects\/pack\/pack-[^/]+\.idx$/.test(rest)).map((rest) => {
				const listed = git(["--git-dir", at, "show-index"], fs.readFileSync(join(at, rest))).toString();
				return [`${repository}/${rest.replace(/\.idx$/, ".pack")}`, new Set(listed.split("\n").map((line) => line.split(" ")[1]))];
			});
			const places = (oid) => {
				const loose = `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
				return [
					...(saves.has(loose) ? [`loose ${repository}/${loose}`] : []),
					...packs.filter(([, listed]) => listed.has(oid)).map(([pack]) => `pack ${pack}`),
				];
			};
			const output = git(["--git-dir", at, "cat-file", "--batch-all-objects", "--batch"]);
			for (let next = 0; next < output.length; ) {
				const end = output.indexOf(10, next);
				const [oid, type, size] = output.subarray(next, end).toString().split(" ");
				const content = output.subarray(end + 1, end + 1 + Number(size));
				next = end + 1 + Number(size) + 1;
				inSaved.objects += 1;
				sort({ oid, type, where: places(oid) }, content, inSaved);
			}
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	return { store: inStore, saved: inSaved };
}

/** One JSON value of `select` as postgres (null when there is no row). */
export async function value(db, select) {
	const marker = `@@p3value${randomBytes(6).toString("hex")}@@`;
	const [found] = await db.marked(`select ${quote(marker)} || coalesce((${select})::text, 'null');`, marker);
	return found ?? null;
}
