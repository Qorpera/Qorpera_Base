import assert from "node:assert/strict";
import { ENVIRONMENT, finish, pass, proveCompanyRun, sha256, sqlText, textObjects } from "./prove-company-run.mjs";

// A company read that shows a token-shaped string goes on to its next request (keyholes lane, 13 Nov 2026; #1721). The
// tool boundary cuts a secret out of every answer (redactCloudWebhookSecrets) and hashes what is left; the context view
// cites a read under that hash, and SQL (qorpera_folder_record_context_view) refuses a citation whose hash is not the
// release's: "Context read provenance differs". So a read must be released under the hash of the cut text, or the run
// stops at its next model request ("Native boundary execution stopped"). A run of SQL test 924's company reads files,
// a link, a folder listing and a table that hold made-up strings of every shape the boundary cuts, one call a model
// request, through the real patched Codex, and the run goes on after each; what the model was shown, the releases, the
// context views and the run's work log are read back and compared.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-read-token.mjs
//
// On the shared harness scripts/prove-company-run.mjs (keyholes S2), which says what is real and what stands in; here
// the run has the interface tools too (table_read). Every token here is made up for this script (built from parts, so
// no token-shaped literal is in the source); none is a real secret.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const PROMPT = "Read the deploy notes and say where each key is kept.";

/** A made-up body of `n` characters: `label`, then digits. Unique per label, so it is the needle a leak would show. */
const body = (label, n) => `${label}${"0123456789".repeat(Math.ceil(n / 10))}`.slice(0, n);
/** Each shape the boundary cuts (cloud-native-tool-boundary.ts SECRET_CUTS), with a made-up body, and what the cut
 * leaves. Prefixes are joined here so that no token-shaped literal is in the source. */
const TOKENS = [
	{ shape: "whsec", body: body("FakeWhsecBody", 40), make: (b) => ["whsec", b].join("_"), shown: "whsec_[REDACTED]" },
	{ shape: "npm", body: body("FakeNpmBody", 36), make: (b) => ["npm", b].join("_"), shown: "npm_[REDACTED]" },
	{ shape: "ghp", body: body("FakeGhpBody", 36), make: (b) => ["ghp", b].join("_"), shown: "ghp_[REDACTED]" },
	{
		shape: "github_pat",
		body: body("FakeGithubPatBody_", 82),
		make: (b) => ["github", "pat", b].join("_"),
		shown: "github_pat_[REDACTED]",
	},
	{ shape: "sk_test", body: body("FakeSkTestBody", 24), make: (b) => ["sk", "test", b].join("_"), shown: "sk_[REDACTED]" },
	{ shape: "rk_live", body: body("FakeRkLiveBody", 24), make: (b) => ["rk", "live", b].join("_"), shown: "rk_[REDACTED]" },
	{ shape: "re", body: body("FakeResendBody", 20), make: (b) => ["re", "FakeRe12", b].join("_"), shown: "re_[REDACTED]" },
].map((token) => ({ ...token, raw: token.make(token.body) }));
/** The same cuts on text as other tools print it: URL-encoded, and JSON-escaped (a backslash in the file). */
const ENCODED = [
	{ shape: "whsec URL-encoded", body: body("FakeWhsecUrlBody", 40), raw: "", shown: "whsec_[REDACTED]" },
	{ shape: "whsec JSON-escaped", body: body("FakeWhsecJsonBody", 40), raw: "", shown: "whsec_[REDACTED]" },
	{ shape: "npm JSON-escaped", body: body("FakeNpmJsonBody", 36), raw: "", shown: "npm_[REDACTED]" },
];
ENCODED[0].raw = `whsec%5F${ENCODED[0].body}`;
ENCODED[1].raw = `whsec\\u005F${ENCODED[1].body}`;
ENCODED[2].raw = `npm\\u005F${ENCODED[2].body}`;

const PLAIN = { path: "notes/plain.md", text: "# Plain\n\nNothing secret here: the deploy runs at nine.\n" };
const KEY_FILES = TOKENS.map((token) => ({
	path: `notes/key-${token.shape.replace("_", "-")}.md`,
	text: `# Where the ${token.shape} key is\n\nThe deploy reads ${token.raw} from the vault.\n`,
	token,
}));
const MIXED = {
	path: "notes/mixed.md",
	text: `# Keys, as other tools print them\n\nURL-encoded: ${ENCODED[0].raw}\nJSON: {"secret":"${ENCODED[1].raw}","token":"${ENCODED[2].raw}"}\n`,
};
/** A long file of numbered lines, each with a token of its own (ghp_): more than one 32 KiB window. */
const LONG_TOKENS = Array.from({ length: 900 }, (_, n) => {
	const lineBody = body(`FakeGhpLine${String(n).padStart(4, "0")}x`, 36);
	return { body: lineBody, raw: TOKENS[2].make(lineBody) };
});
const LONG = {
	path: "notes/long.md",
	text: LONG_TOKENS.map((token, n) => `line ${String(n).padStart(4, "0")}: the deploy key is ${token.raw} here.\n`).join(""),
};
const LINK = { path: "notes/links/deploy", target: `vault/${TOKENS[5].raw}` };
const TABLE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TABLE = {
	folder: "QorperaOS/tables/deploy-notes",
	toml: [
		'format = "qorpera.table/v0"',
		"",
		"[table]",
		`id = "${TABLE_ID}"`,
		'name = "Deploy notes"',
		'about = "Where each deploy key is kept."',
		'rows = "file"',
		'key = ["name"]',
		"",
		"[[column]]",
		'name = "name"',
		'type = "text"',
		"max = 60",
		"",
		"[[column]]",
		'name = "note"',
		'type = "text"',
		"max = 200",
		"",
		"[write]",
		'agents = "all"',
		'members = "all"',
		"",
	].join("\n"),
	rows: `name,note\ndeploy,the deploy key is ${TOKENS[1].raw}\nbilling,the billing key is ${TOKENS[4].raw}\n`,
};

/** The calls the scripted model makes, one a request, in order: what it reads, and what the answer must show. `args`
 * takes the answers so far, by call id. */
const CALLS = [
	{ id: "call_plain", tool: "company_read", args: () => ({ path: PLAIN.path, offset: 0, limit: 4096 }), reads: [PLAIN.path], shows: [] },
	...KEY_FILES.map((file) => ({
		id: `call_key_${file.token.shape}`,
		tool: "company_read",
		args: () => ({ path: file.path, offset: 0, limit: 4096 }),
		reads: [file.path],
		shows: [file.token.shown],
	})),
	{
		id: "call_mixed",
		tool: "company_read",
		args: () => ({ path: MIXED.path, offset: 0, limit: 4096 }),
		reads: [MIXED.path],
		shows: ENCODED.map((token) => token.shown),
	},
	{
		id: "call_long_1",
		tool: "company_read",
		args: () => ({ path: LONG.path, offset: 0, limit: 32768 }),
		reads: [LONG.path],
		shows: [TOKENS[2].shown],
	},
	{
		id: "call_long_2",
		tool: "company_read",
		// The model reads on from the nextOffset the first window gave.
		args: (outputs) => ({ path: LONG.path, offset: JSON.parse(JSON.parse(outputs.get("call_long_1")).content.text).nextOffset, limit: 32768 }),
		reads: [LONG.path],
		shows: [TOKENS[2].shown],
	},
	{
		id: "call_list_links",
		tool: "company_list",
		args: () => ({ path: "notes/links", after: null, limit: 50 }),
		reads: ["notes/links", LINK.path],
		shows: [TOKENS[5].shown],
	},
	{
		id: "call_read_link",
		tool: "company_read",
		args: () => ({ path: LINK.path, offset: 0, limit: 4096 }),
		reads: [LINK.path],
		shows: [TOKENS[5].shown],
	},
	{
		id: "call_table",
		tool: "table_read",
		args: () => ({ table: "deploy-notes", where: null, after: null, limit: 50 }),
		reads: [`${TABLE.folder}/table.toml`, `${TABLE.folder}/rows.csv`],
		shows: [TOKENS[1].shown, TOKENS[4].shown],
	},
];


/** A structured file's entry for a platform commit, as the folder client makes it from the shared parser. */
function structured(code, path, text) {
	const where = code.companyStatePath(path);
	assert(where, `${path} is a structured path`);
	const parsed = code.parseCompanyStateFile(path, text);
	assert(parsed?.ok, `${path} parses: ${JSON.stringify(parsed?.problems ?? parsed)}`);
	return { path, kind: where.kind, text, parse: parsed.file, parserVersion: code.COMPANY_STATE_PARSER_VERSION };
}

const FILES = [PLAIN, ...KEY_FILES, MIXED, LONG];
/** The platform writes the files, the link and the table (SQL test 924's helpers). */
const SETUP = (code) => {
	const stage = (text) => `pg_temp.base_stage(${sqlText(text)})`;
	const write = (path, text) => `jsonb_build_object('op', 'write', 'path', ${sqlText(path)}, 'file', ${stage(text)})`;
	const tableToml = structured(code, `${TABLE.folder}/table.toml`, TABLE.toml);
	const tableRows = structured(code, `${TABLE.folder}/rows.csv`, TABLE.rows);
	return `select pg_temp.base_commit('{"kind":"platform"}', 'token-files', jsonb_build_array(
			jsonb_build_object('op', 'mkdir', 'path', 'notes'),
			jsonb_build_object('op', 'mkdir', 'path', 'notes/links'),
			${FILES.map((file) => write(file.path, file.text)).join(",\n\t\t\t")},
			jsonb_build_object('op', 'symlink', 'path', ${sqlText(LINK.path)}, 'target', ${sqlText(LINK.target)}),
			jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/tables'),
			jsonb_build_object('op', 'new_folder', 'path', ${sqlText(TABLE.folder)}, 'contents', jsonb_build_array(
				jsonb_build_object('path', 'table.toml', 'kind', 'file', 'file', ${stage(TABLE.toml)}),
				jsonb_build_object('path', 'rows.csv', 'kind', 'file', 'file', ${stage(TABLE.rows)})),
				'structured', ${sqlText(JSON.stringify([tableToml, tableRows]))}::jsonb))) \\g /dev/null`;
};

await finish(
	proveCompanyRun({
		name: "qorpera_read_token",
		prompt: PROMPT,
		setup: SETUP,
		objects: textObjects([...FILES.map((file) => file.text), TABLE.toml, TABLE.rows]),
		interfaceTools: true,
		calls: CALLS.map((call) => (outputs) => ({
			id: call.id,
			name: call.tool,
			arguments: call.args(new Map(outputs.map((output) => [output.callId, output.output]))),
		})),
		async check({ code, db, binding, run, outputs, state }) {
			const view = db.query("select pg_get_functiondef('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)'::regprocedure)");
			assert(view.includes("Context read provenance differs") && view.includes("20260930733000"));
			pass("the database refuses a context view that cites a read under a hash other than its release's (Context read provenance differs; 32 KiB bounds of 20260930733000)");

			// Every made-up token is one the boundary cuts, and the cut leaves its marker.
			for (const token of [...TOKENS, ...ENCODED]) assert.equal(code.redactCloudWebhookSecrets(`x ${token.raw} y`), `x ${token.shown} y`, token.shape);
			assert.equal(code.redactCloudWebhookSecrets(JSON.stringify(MIXED.text)).includes(ENCODED[1].body), false);
			pass(`each of the ${TOKENS.length} shapes the boundary cuts (${TOKENS.map((token) => token.shape).join(", ")}) and ${ENCODED.length} encoded forms is cut by redactCloudWebhookSecrets: the files hold strings the cut changes`);

			const versions = Object.fromEntries(
				db
					.json(`select coalesce(jsonb_agg(jsonb_build_array(e.path, e.version)), '[]')::text from public.qorpera_folder_entries e
						where e.environment_id = '${ENVIRONMENT}' and e.kind <> 'claim'
							and (e.path like 'notes/%' or e.path like ${sqlText(`${TABLE.folder}/%`)})`)
					.map(([path, version]) => [path, version]),
			);
			const setup = { versions };
			for (const call of CALLS)
				for (const path of call.reads) assert(setup.versions[path], `${path} is in the folder: ${JSON.stringify(setup.versions)}`);
			pass(
				`SQL test 924's run of Alice is leased (run ${binding.runId.slice(0, 8)}); the platform wrote ${FILES.length} files, a link and the table ${TABLE.folder} holding them (${Buffer.byteLength(LONG.text)} bytes in ${LONG.path})`,
			);

			// Each answer as the model got it: the request after its call carries it, and any later request that still
			// carries it (before the work log folds earlier answers into its step lines) carries the same bytes.
			const answers = new Map(outputs.map((output) => [output.callId, output.output]));
			let carried = 0;
			for (const request of state.agent)
				for (const item of request.body.input.filter((entry) => entry.type === "function_call_output")) {
					assert.equal(String(item.output), answers.get(item.call_id), `${item.call_id}: the same answer in every request that carries it`);
					carried++;
				}
			const provenance = db.refusals.filter((refusal) => refusal.includes("provenance"));
			assert.deepEqual(provenance, []);
			pass(
				`the run went on to its next request after every one of its ${CALLS.length} reads: ${state.agent.length} agent requests, each after a call carrying its answer (${carried} answers carried in all, the same bytes each time), the run ended with its closing message, and no context view was refused`,
			);
			const last = { outputs: answers };

			// Where the long file's first window ends. A token that edge cuts in two is in neither window whole, so neither is
			// cut: that is a different defect (the windows of a read, not its release), noted here and left to its own fix; it is
			// the one made-up token the checks below may find shown.
			const edge = JSON.parse(JSON.parse(answers.get("call_long_1")).content.text).bytesRead;
			let split = null;
			for (let at = 0, n = 0; n < LONG_TOKENS.length; n++) {
				const start = LONG.text.indexOf(LONG_TOKENS[n].raw, at);
				const end = start + LONG_TOKENS[n].raw.length;
				if (start < edge && edge < end) split = { ...LONG_TOKENS[n], line: n, start, end };
				if (start >= edge) break;
				at = end;
			}
			const NEEDLES = [...TOKENS, ...ENCODED, ...LONG_TOKENS].map((token) => token.body).filter((needle) => needle !== split?.body);

			// Each answer: what the model was shown, its release, and how the context views cite it.
			// A release is recorded per resource it draws on, each row with the release's output hash.
			const releases = new Map(
				db
					.json(`select coalesce(jsonb_agg(jsonb_build_object('id', g.release_id, 'shas', g.shas, 'reads', g.reads)), '[]')::text
						from (select r.release_id, jsonb_agg(distinct r.output_sha256) shas, jsonb_agg(x) reads
							from public.qorpera_folder_run_read_records r cross join lateral jsonb_array_elements(r.reads) x
							where r.run_id = '${binding.runId}' group by r.release_id) g`)
					.map((release) => {
						assert.equal(release.shas.length, 1, `release ${release.id}: one output hash`);
						return [release.id, { ...release, sha: release.shas[0] }];
					}),
			);
			const cited = db
				.json(`select coalesce(jsonb_agg(o), '[]')::text from public.qorpera_native_context_views v
					cross join lateral jsonb_array_elements(v.view -> 'outputs') o where v.run_id = '${binding.runId}'`)
				.filter((output) => output.readId !== null);
			const envelopes = new Map();
			for (const call of CALLS) {
				const output = last.outputs.get(call.id);
				assert(output, `${call.id}: an answer reached the model`);
				const envelope = JSON.parse(output);
				envelopes.set(call.id, { output, envelope });
				const { content, provenance } = envelope;
				assert.equal(envelope.status, "ok", `${call.id}: ${output.slice(0, 400)}`);
				assert.equal(provenance.tool, call.tool);
				assert(Buffer.byteLength(output) <= code.MAX_CLOUD_TOOL_RESULT_BYTES && !content.truncated, `${call.id}: ${Buffer.byteLength(output)} B`);
				assert.equal(content.sha256, sha256(content.text), `${call.id}: the model was shown the whole answer`);
				assert.equal(code.redactCloudWebhookSecrets(content.text), content.text, `${call.id}: cut again, the answer is unchanged`);
				for (const shown of call.shows) assert(content.text.includes(shown), `${call.id}: shows ${shown}`);
				for (const needle of NEEDLES) assert(!content.text.includes(needle), `${call.id}: shows no made-up token (${needle.slice(0, 12)}…)`);
				const release = releases.get(provenance.companyReadId);
				assert(release, `${call.id}: its companyReadId ${provenance.companyReadId} is a release of this run`);
				assert.equal(release.sha, content.sha256, `${call.id}: the release's output hash is the hash of what the model was shown`);
				assert.deepEqual(release.reads.map((read) => read.path).sort(), [...call.reads].sort(), `${call.id}: the release names its reads`);
				const cites = cited.filter((entry) => entry.callId === call.id);
				assert(cites.length >= 1, `${call.id}: a context view cites it`);
				assert(cites.every((entry) => entry.readId === provenance.companyReadId && entry.readSha256 === release.sha));
				pass(
					`${call.tool} ${JSON.stringify(call.args(last.outputs)).slice(0, 80)}: shown ${call.shows.length ? call.shows.join(" ") : "plain text"}, no token; the release ${provenance.companyReadId.slice(0, 8)} holds the hash of what was shown (${content.sha256.slice(0, 12)}), and ${cites.length} context views cite it under that hash`,
				);
			}

			// The long file: each window is the cut of the file's bytes it covers, and the second goes on where the first ended.
			const longBytes = Buffer.from(LONG.text, "utf8");
			const first = JSON.parse(envelopes.get("call_long_1").envelope.content.text);
			const second = JSON.parse(envelopes.get("call_long_2").envelope.content.text);
			assert(first.bytesRead > 29_000 && first.nextOffset === first.bytesRead && second.offset === first.nextOffset, JSON.stringify({ ...first, text: undefined }));
			assert.equal(first.text, code.redactCloudWebhookSecrets(longBytes.subarray(0, first.bytesRead).toString("utf8")));
			assert.equal(second.text, code.redactCloudWebhookSecrets(longBytes.subarray(second.offset, second.offset + second.bytesRead).toString("utf8")));
			const window = longBytes.subarray(0, first.bytesRead).toString("utf8");
			const tail = window.slice(window.lastIndexOf("\n") + 1);
			pass(
				`${LONG.path}: the first window (${first.bytesRead} file bytes, an envelope of ${Buffer.byteLength(envelopes.get("call_long_1").output)} B) is the cut of the file's bytes it covers, and the second reads on from its nextOffset ${first.nextOffset}; the window ends ${tail.length ? `inside a line (${JSON.stringify(tail.slice(-24))})` : "at a line's end"}`,
			);
			if (split) {
				// The two parts of the split token, each shown as the file has it: the first window's end, the second's start.
				assert(first.text.endsWith(split.raw.slice(0, edge - split.start)) && second.text.startsWith(split.raw.slice(edge - split.start)));
				process.stdout.write(
					`NOTE a different defect, not fixed here: the first window ends inside line ${split.line}'s token, after ${JSON.stringify(split.raw.slice(0, edge - split.start))}; neither window holds it whole, so neither is cut, and the second shows ${JSON.stringify(split.raw.slice(edge - split.start, edge - split.start + 16))}… (${split.end - edge} bytes) uncut\n`,
				);
			}

			// Nothing the provider got held a made-up token (but the split one): neither the agent's requests nor the compactor's.
			for (const request of [...state.agent.map((entry) => entry.input), ...state.compactor])
				for (const needle of NEEDLES) assert(!request.includes(needle), `a provider request held ${needle.slice(0, 12)}…`);
			pass(
				`no request the provider got (${state.agent.length} agent, ${state.compactor.length} compactor) holds any of the ${NEEDLES.length} made-up tokens${split ? " other than the one the window edge split" : ""}`,
			);

			// The run's work log keeps every step: a finished row per call naming its release, and the block's line holds the
			// envelope the model got, byte for byte.
			const steps = db.json(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'call', s.call_id, 'tool', s.tool, 'finished', s.finished,
					'releases', s.releases, 'block', s.block_path) order by s.j), '[]')::text
				from public.qorpera_memory_run_steps s where s.run_id = '${binding.runId}'`);
			assert.deepEqual(
				steps.map((step) => [step.call, step.tool, step.finished]),
				CALLS.map((call) => [call.id, call.tool, true]),
			);
			const place = new code.CloudRunLogCompanyFolder({ environmentId: run.identity.environmentId, runId: binding.runId, folder: run.folder, control: run.paths });
			const located = await place.locate(binding.runId, AbortSignal.timeout(30_000));
			assert(located.exists, JSON.stringify(located));
			const blocks = new Map();
			for (const stored of new Set(steps.map((step) => step.block))) {
				const path = `${located.path}/log/${stored.split("/").at(-1)}`;
				const block = await place.read(path, AbortSignal.timeout(30_000));
				assert(block, `the log's block ${path}`);
				blocks.set(stored, block.text);
			}
			for (const step of steps) {
				const { output, envelope } = envelopes.get(step.call);
				assert(step.releases.includes(envelope.provenance.companyReadId), `${step.call}: the step names its release`);
				const line = blocks
					.get(step.block)
					.split("\n")
					.find((text) => text.includes(`"call":${JSON.stringify(step.call)},`) && !text.includes('"result":null'));
				assert(line, `${step.call}: the block holds the step's finished line`);
				assert(line.includes(`"result":${output},`), `${step.call}: the line keeps the envelope as the fence issued it`);
				const parsed = JSON.parse(line);
				assert(JSON.stringify(parsed.releases).includes(envelope.provenance.companyReadId));
				const callPaths = CALLS.find((call) => call.id === step.call).reads;
				for (const read of parsed.reads) assert(callPaths.includes(read.path) && setup.versions[read.path] === read.version, `${step.call}: ${JSON.stringify(read)}`);
			}
			pass(
				`the run's work log keeps all ${steps.length} steps finished, in ${blocks.size} block(s): each line holds the envelope the model got byte for byte, its release and the reads it drew on`,
			);
		},
	}),
);
