import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// The vault's connection-file writer (P22b) against a real database: test 704's folder-v2 company, every migration,
// the object gateway's writer and file store as built, and its RPCs answered by the database as the service role.
// It writes the files the vault marked, keeps a member's text through a rewrite, deletes a disconnected account's
// file, and puts nothing of the vault's secrets into any file.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_connection_files";
const environmentId = "70400000-0000-4000-8000-000000000020";
const profileId = "70400000-0000-4000-8000-000000000010";
const gmail = "70400000-0000-4000-8000-0000000000e1";
const github = "70400000-0000-4000-8000-0000000000e2";
const member = { kind: "member", userId: "70400000-0000-4000-8000-000000000002" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const literal = (value) =>
	value === null || value === undefined
		? "null"
		: typeof value === "number"
			? String(value)
			: `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;

async function main() {
	const database = await hostedDatabase(databaseName);
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-connection-files-"));
	try {
		const query = (sql) => database.cluster.psql(databaseName, sql, ["-qAt"]).trim();
		const rpc = (method, args) => {
			const parameters = Object.entries(args).map(([name, value]) => {
				assert(/^p_[a-z][a-z0-9_]*$/.test(name));
				return `${name}=>${literal(value)}`;
			});
			const out = query(`set request.jwt.claims = '{"role":"service_role"}';
				select to_jsonb(public.${method}(${parameters.join(",")}));`);
			return out ? JSON.parse(out) : null;
		};

		// 704's company, committed: its vault rows predate the folder, then the seed tree and the Co-Founder, whose hire
		// grants it the two shared connections' operations, and so marks them due.
		const source = await readFile(join(repositoryRoot, "supabase/tests/704_folder_state_connections.test.sql"), "utf8");
		const marker = "-- 1. The company, and the platform writing its first connection file";
		assert(source.includes(marker));
		database.cluster.psql(
			databaseName,
			`${source.split(marker)[0]}
			do $$
			declare r jsonb;
			begin
				r := pg_temp.commit(pg_temp.platform(), 'seed-0001', jsonb_build_array(
					jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Connections'),
					jsonb_build_object('op','mkdir','path','agents'),
					pg_temp.write('agents/sections.md', 'sections', E'# Sections\\n', '{"kind":"sections","sections":[]}'),
					pg_temp.hire('co-founder', '70400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
					jsonb_build_object('op','mkdir','path','connections')));
				if (select count(*) from jsonb_array_elements(r -> 'units') u where u ->> 'outcome' = 'saved') <> 6 then
					raise exception 'seed: %', r; end if;
			end $$;
			commit;`,
		);
		assert.equal(query(`select count(distinct secret_id) from public.qorpera_folder_connection_file_marks`), "2");

		const modulePath = join(scratch, "writer.mjs");
		await build({
			absWorkingDir: repositoryRoot,
			stdin: {
				resolveDir: repositoryRoot,
				contents: [
					'export {ConnectionFileWriter} from "./packages/object-gateway/src/connection-files.ts";',
					'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
					'export {parseCompanyStateFile, COMPANY_STATE_PARSER_VERSION} from "./packages/cloud-client/src/company-state-files.ts";',
				].join("\n"),
			},
			platform: "node",
			format: "esm",
			target: "node22",
			bundle: true,
			outfile: modulePath,
			logLevel: "silent",
		});
		const code = await import(pathToFileURL(modulePath).href);
		const store = new code.FileSystemObjectStore(join(scratch, "objects"));
		const replication = {
			async uploadWithAuthority(profile, hash, bytes, callbacks) {
				await callbacks.authorize();
				const result = await store.put(profile, hash, bytes);
				await callbacks.confirm();
				return result;
			},
		};
		const writer = new code.ConnectionFileWriter({
			workerId: "70400000-0000-4000-8000-00000000000a",
			authority: { publisher: async (method, args) => rpc(method, args) },
			store,
			replication,
		});
		const file = (path) => {
			const row = query(`select to_jsonb(e) from public.qorpera_folder_entries e
				where e.environment_id = '${environmentId}' and e.key_text = ${literal(path)} and e.kind = 'file'`);
			return row ? JSON.parse(row) : null;
		};
		const text = async (path) => {
			const entry = file(path);
			assert(entry, `${path} exists`);
			return new TextDecoder().decode(await store.get(profileId, entry.file_sha256, Number(entry.bytes)));
		};
		const parse = async (path) => {
			const parsed = code.parseCompanyStateFile(path, await text(path));
			assert(parsed?.ok, `${path} parses`);
			return parsed.file;
		};
		const drain = async () => {
			const handled = await writer.writeDue(20);
			assert.equal(query(`select count(*) from public.qorpera_folder_connection_file_work where dirty or last_problem is not null`), "0");
			return handled;
		};

		// 1. The two marked connections get their files, as the vault says.
		assert.equal(await drain(), 2);
		const hello = await parse("connections/gmail.md");
		assert.deepEqual(
			{ id: hello.id, service: hello.service, account: hello.account, status: hello.status, purpose: hello.purpose },
			{ id: gmail, service: "gmail", account: "hello@nordlys.test", status: "connected", purpose: "" },
		);
		assert.deepEqual(
			hello.actions,
			JSON.parse(query(`select jsonb_agg(distinct operation_id order by operation_id) from public.qorpera_cloud_secret_operation_grants
				where secret_id = '${gmail}' and status = 'active'`)),
		);
		assert.equal((await parse("connections/github.md")).account, "nordlys");
		assert.equal(await drain(), 0);

		// 2. A member writes the text below the settings; a new account name is rewritten around it.
		const memberText = (await text("connections/gmail.md")).replace(/\n---\n$/, "\n---\nThe shared inbox.\n");
		const memberBytes = new TextEncoder().encode(memberText);
		const manifest = JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: sha256(memberBytes),
			bytes: memberBytes.byteLength,
			mediaType: "text/markdown",
			executable: false,
			chunks: [{ sha256: sha256(memberBytes), bytes: memberBytes.byteLength }],
		});
		const open = rpc("qorpera_folder_open_upload", { p_environment_id: environmentId, p_actor: member, p_manifest: manifest });
		for (const [hash, bytes] of [[sha256(memberBytes), memberBytes], [sha256(manifest), new TextEncoder().encode(manifest)]]) {
			if (open.present.includes(hash)) continue;
			rpc("qorpera_folder_authorize_object_upload", {
				p_environment_id: environmentId, p_actor: member, p_intent: open.intentId, p_sha256: hash, p_bytes: bytes.byteLength,
			});
			await store.put(profileId, hash, bytes);
			rpc("qorpera_folder_confirm_object", {
				p_environment_id: environmentId, p_actor: member, p_intent: open.intentId, p_sha256: hash, p_bytes: bytes.byteLength,
			});
		}
		const sealed = rpc("qorpera_folder_seal_upload", { p_environment_id: environmentId, p_actor: member, p_intent: open.intentId });
		assert.equal(sealed.state, "sealed");
		const edit = rpc("qorpera_folder_commit", {
			p_environment_id: environmentId,
			p_actor: member,
			p_operation_key: "member-edit-0001",
			p_units: [{
				op: "write",
				path: "connections/gmail.md",
				file: sealed.file,
				expectedVersion: file("connections/gmail.md").version,
				structured: [{ path: "connections/gmail.md", kind: "connection", text: memberText,
					parse: code.parseCompanyStateFile("connections/gmail.md", memberText).file, parserVersion: code.COMPANY_STATE_PARSER_VERSION }],
			}],
		});
		assert.equal(edit.units[0].outcome, "saved", JSON.stringify(edit));
		query(`update public.qorpera_cloud_secrets set account_label = 'team@nordlys.test' where id = '${gmail}'`);
		assert.equal(await drain(), 1);
		const after = await text("connections/gmail.md");
		assert.equal(after, memberText.replace("account: hello@nordlys.test", "account: team@nordlys.test"));
		assert.equal((await parse("connections/gmail.md")).purpose, "The shared inbox.");

		// 3. A Disconnect removes the account's file.
		query(`update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp(),
			revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '${github}'`);
		assert.equal(await drain(), 1);
		assert.equal(file("connections/github.md"), null);

		// 4. Nothing of the vault beyond the allow-list is in any connection file version, or in the writer's commits.
		const written = JSON.parse(query(`select coalesce(jsonb_agg(jsonb_build_object('sha', v.file_sha256, 'bytes', v.bytes)), '[]')
			from public.qorpera_folder_path_versions v
			where v.environment_id = '${environmentId}' and v.path like 'connections/%' and v.file_sha256 is not null`));
		const commits = query(`select coalesce(string_agg(to_jsonb(c)::text, ' '), '') from public.qorpera_folder_commits c
			where c.environment_id = '${environmentId}' and c.operation_key like 'connection-file:%'`);
		assert(written.length >= 4 && commits.includes("connection-file:"));
		const forbidden = ["Gmail account", "GitHub account", "Drive account", "My Gmail", "key-1", "1".repeat(64),
			"70400000-0000-4000-8000-0000000000d1"];
		for (const version of written) {
			const body = new TextDecoder().decode(await store.get(profileId, version.sha, Number(version.bytes)));
			for (const word of forbidden) assert(!body.includes(word), `a connection file carries ${word}`);
		}
		for (const word of forbidden) assert(!commits.includes(word), `a writer's commit carries ${word}`);
		process.stdout.write("Connection file writer checks passed (write, member text kept, Disconnect deletes, allow-list only)\n");
	} finally {
		await rm(scratch, { recursive: true, force: true });
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
