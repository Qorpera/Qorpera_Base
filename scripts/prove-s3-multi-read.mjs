import assert from "node:assert/strict";
import {
	ENVIRONMENT,
	finish,
	OWNER,
	pass,
	platformCommit,
	proveCompanyRun,
	sha256,
	textObjects,
} from "./prove-company-run.mjs";

// keyholes S3 (PR #1700): company_read reads several files in one call. End to end, through the real patched Codex and
// a migrated database (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-s3-multi-read.mjs
//
// - Seven files in one read fill one 32 KiB result: the small ones whole, the two that do not fit cut alike, each with
//   its own version and nextOffset; a read of one of them from its nextOffset goes on exactly where it was cut.
// - The read rights: a path the run may not read is answered as absent (as SQL answers it, like a missing path), and
//   the files beside it are shown.
// - Each file's read is recorded: one release a file, in the answer's order, all under the hash of the answer; the
//   context view cites the first; the run's work log keeps every release, a reads copy for each file and the paths the
//   call named, every block parsed by the shared parser.
// - The bytes of the files are read one file at a time, so the call never contends with itself at the object gateway,
//   which serves two operations at a time and one on any one object (the stand-in answers 503 otherwise, as the gateway
//   does for a file just written), also for two files of the same content, which share their objects.
// - Secrets (13 Nov 2026, after #1721): a read of several files where some hold made-up token-shaped strings shows them
//   cut, its releases are under the hash of what was shown, and the run goes on to its next request. No window starts
//   or ends inside a token: a long file of tokens in two windows (the case #1721's proof noted), a window asked to start
//   inside one, a window too small for one, and two such files cut alike all show every token cut; a token-shaped run
//   longer than any window is shown cut, and the answer says the read goes on inside it.
// Every token here is made up (built from parts, so no token-shaped literal is in the source); none is a real secret.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const SMALL = Array.from({ length: 5 }, (_, n) => ({
	path: `docs/s${n + 1}.md`,
	text: `# Small file ${n + 1}\n\n${`Point ${n + 1} of a short note, kept whole. `.repeat(32)}\n`,
}));
const MEDIUM = {
	path: "docs/medium.md",
	text: Array.from({ length: 400 }, (_, n) => `medium ${String(n).padStart(4, "0")}: a line of the medium file.\n`).join(""),
};
const LARGE = {
	path: "docs/large.md",
	text: Array.from({ length: 1800 }, (_, n) => `line ${String(n).padStart(5, "0")} of the large file, in words.\n`).join(""),
};
/** Two files of the same content: they share their objects, which the gateway serves one operation at a time. */
const OPEN = [
	{ path: "open/a.md", text: "An open file, copied.\n" },
	{ path: "open/b.md", text: "An open file, copied.\n" },
];
const SECRET = { path: "locked/secret.md", text: "A secret the run may not read.\n" };
/** A made-up body of `n` characters: `label`, then digits; the needle a leak would show. */
const body = (label, n) => `${label}${"0123456789".repeat(Math.ceil(n / 10))}`.slice(0, n);
const ghp = (b) => ["ghp", b].join("_");
const npm = (b) => ["npm", b].join("_");
const skTest = (b) => ["sk", "test", b].join("_");
const DEPLOY_TOKEN = ghp(body("FakeDeployKey", 36));
const KEYS = [
	{ path: "keys/deploy.md", text: `# Deploy\n\nThe deploy reads ${DEPLOY_TOKEN} from the vault.\n` },
	{ path: "keys/billing.md", text: `# Billing\n\nBilling signs with ${skTest(body("FakeBillingKey", 24))} today.\n` },
];
/** Long files of numbered lines, each with a token of its own: more than one 32 KiB window (#1721's case). */
const lined = (path, label, make) => {
	const tokens = Array.from({ length: 900 }, (_, n) => make(body(`${label}${String(n).padStart(4, "0")}x`, 36)));
	return {
		path,
		tokens,
		text: tokens.map((token, n) => `line ${String(n).padStart(4, "0")}: the deploy key is ${token} here.\n`).join(""),
	};
};
const LONG = lined("notes/long.md", "FakeGhpLine", ghp);
const LONG_B = lined("notes/long-b.md", "FakeNpmLine", npm);
/** A token-shaped run longer than any window: "ghp_" and 40,000 letters and digits. */
const BLOB = {
	path: "notes/blob.md",
	text: `# Blob\n\n${ghp(body("FakeOverlongRun", 40_000))}\nend\n`,
};
/** Where each token of a file lies, by byte (all ASCII). */
const spansOf = (file) => {
	const spans = [];
	for (const token of file.tokens) {
		const start = file.text.indexOf(token, spans.at(-1)?.end ?? 0);
		spans.push({ start, end: start + token.length });
	}
	return spans;
};
const inside = (spans, at) => spans.some((span) => span.start < at && at < span.end);
/** The made-up tokens' bodies: no answer and no request may hold one. */
const NEEDLES = [
	body("FakeDeployKey", 36),
	body("FakeBillingKey", 24),
	...[LONG, LONG_B].flatMap((file) => file.tokens.map((token) => token.slice(4))),
	"FakeOverlongRun",
];
const MISSING = "nope/missing.md";
const FILES = [...SMALL, MEDIUM, LARGE, ...OPEN, SECRET, ...KEYS, LONG, LONG_B, BLOB];
const FIRST = [...SMALL, MEDIUM, LARGE].map((file) => file.path);
const RIGHTS = [OPEN[0].path, SECRET.path, MISSING, OPEN[1].path];

const SETUP = [
	platformCommit("prove-s3-files", [
		{ op: "mkdir", path: "docs" },
		{ op: "mkdir", path: "open" },
		{ op: "mkdir", path: "locked" },
		{ op: "mkdir", path: "keys" },
		{ op: "mkdir", path: "notes" },
		...FILES.map((file) => ({ op: "write", path: file.path, text: file.text })),
	]),
	// locked/ becomes a resource of its own with no grant: no agent reads under it (core §5), the platform still does.
	`select public.qorpera_folder_set_resource('${ENVIRONMENT}', '${OWNER}', 'locked', 'subtree', 'company_shared', 'normal') \\g /dev/null`,
].join("\n");

const filesOf = (output) => JSON.parse(JSON.parse(output).content.text).files;
const answerOf = (output) => JSON.parse(JSON.parse(output).content.text);
const TOKEN_READ = [SMALL[0].path, KEYS[0].path, KEYS[1].path];
/** Where line 3's token of LONG starts, and a byte inside it. */
const MID = spansOf(LONG)[3];
const DEPLOY_AT = KEYS[0].text.indexOf(DEPLOY_TOKEN);

const CALLS = [
	() => ({ name: "company_read", arguments: { paths: FIRST } }),
	(outputs) => ({
		name: "company_read",
		arguments: {
			path: LARGE.path,
			offset: filesOf(outputs.at(-1).output).find((file) => file.path === LARGE.path).nextOffset,
		},
	}),
	() => ({ name: "company_read", arguments: { paths: TOKEN_READ } }),
	() => ({ name: "company_read", arguments: { path: LONG.path } }),
	(outputs) => ({ name: "company_read", arguments: { path: LONG.path, offset: answerOf(outputs.at(-1).output).nextOffset } }),
	() => ({ name: "company_read", arguments: { path: LONG.path, offset: MID.start + 10, limit: 200 } }),
	() => ({ name: "company_read", arguments: { path: KEYS[0].path, offset: DEPLOY_AT, limit: 8 } }),
	() => ({ name: "company_read", arguments: { paths: [LONG.path, LONG_B.path] } }),
	() => ({ name: "company_read", arguments: { path: BLOB.path } }),
	(outputs) => ({ name: "company_read", arguments: { path: BLOB.path, offset: answerOf(outputs.at(-1).output).nextOffset } }),
	() => ({ name: "company_read", arguments: { paths: RIGHTS } }),
];
/** The files each call reads, one release each, in order. */
const READS = [
	FIRST,
	[LARGE.path],
	TOKEN_READ,
	[LONG.path],
	[LONG.path],
	[LONG.path],
	[KEYS[0].path],
	[LONG.path, LONG_B.path],
	[BLOB.path],
	[BLOB.path],
	[OPEN[0].path, OPEN[1].path],
];
const NARROW = CALLS.length - 1;

/** Each release's reads as the run's read records keep them, in release order. */
function releasedReads(db, runId, releaseIds) {
	return releaseIds.map((id) =>
		db.json(`select coalesce(jsonb_agg(jsonb_build_object('path', x ->> 'path', 'version', x ->> 'version',
				'output', r.output_sha256)), '[]')::text
			from public.qorpera_folder_run_read_records r, jsonb_array_elements(r.reads) x
			where r.run_id = '${runId}' and r.release_id = '${id}'`),
	);
}

const versionOf = (db, path) =>
	db.query(`select version from public.qorpera_folder_entries where environment_id = '${ENVIRONMENT}'
		and key_text = public.qorpera_folder_key('${path}')`);

await finish(
	proveCompanyRun({
		name: "qorpera_prove_s3_multi_read",
		prompt: "Read the notes in docs/ and the open files.",
		setup: SETUP,
		objects: textObjects(FILES.map((file) => file.text)),
		calls: CALLS,
		async check({ code, db, binding, outputs, state, log }) {
			const runId = binding.runId;
			const MAX = 32 * 1024;
			for (const answer of outputs) {
				assert.equal(answer.envelope.status, "ok", answer.output.slice(0, 300));
				assert.equal(answer.envelope.content.truncated, false, "the tool fitted its answer: the fence cut nothing");
				assert(answer.bytes <= MAX, `${answer.callId}: ${answer.bytes} B`);
			}
			const [many, on] = outputs;
			const rights = outputs[NARROW];

			// 1. Seven files in one result: the small ones whole, the rest cut alike, each with its own nextOffset.
			const files = JSON.parse(many.text).files;
			assert.deepEqual(
				files.map((file) => file.path),
				FIRST,
			);
			for (const [index, file] of files.entries()) {
				const source = [...SMALL, MEDIUM, LARGE][index];
				assert.equal(file.kind, "file");
				assert.equal(file.version, versionOf(db, file.path), `${file.path}: the version a change names`);
				assert.equal(file.offset, 0);
				assert.equal(file.totalBytes, Buffer.byteLength(source.text));
				assert.equal(file.bytesRead, Buffer.byteLength(file.text));
				assert(source.text.startsWith(file.text), `${file.path}: its text from the start`);
			}
			const small = files.slice(0, 5);
			assert(small.every((file) => file.nextOffset === null && file.bytesRead === file.totalBytes));
			const [medium, large] = files.slice(5);
			assert.equal(medium.bytesRead, large.bytesRead, "the files that do not fit share the room alike");
			assert(medium.bytesRead < medium.totalBytes && large.bytesRead < large.totalBytes);
			assert.equal(medium.nextOffset, medium.bytesRead);
			assert.equal(large.nextOffset, large.bytesRead);
			// The result is filled: its answer, escaped once more as the fence does, is within a few bytes of the bound the
			// tool fits it to (fitsOneResult: 32 KiB less the envelope's 800).
			const escaped = Buffer.byteLength(JSON.stringify(many.text));
			assert(escaped <= MAX - 800 && escaped > MAX - 800 - 64, `the answer takes ${escaped} B escaped`);
			pass(
				`company_read with 7 paths reached the model whole through the patched Codex in one ${many.bytes}-byte result: 5 small files whole (nextOffset null), and ${MEDIUM.path} and ${LARGE.path} cut alike at ${large.bytesRead} bytes of ${medium.totalBytes} and ${large.totalBytes}, each with nextOffset ${large.nextOffset} and its version`,
			);
			const going = JSON.parse(on.text);
			assert.equal(going.path, LARGE.path);
			assert.equal(going.offset, large.nextOffset);
			assert.equal(going.text, LARGE.text.slice(large.nextOffset, large.nextOffset + going.bytesRead));
			assert(going.bytesRead > 20 * 1024);
			pass(
				`reading ${LARGE.path} alone from that nextOffset went on exactly where the cut was (${going.bytesRead} bytes from byte ${going.offset}, nextOffset ${going.nextOffset})`,
			);

			// 2. The read rights: a path the run may not read is absent, and the others are shown.
			const answered = JSON.parse(rights.text).files;
			assert.deepEqual(answered, [
				{
					path: OPEN[0].path,
					kind: "file",
					version: versionOf(db, OPEN[0].path),
					offset: 0,
					bytesRead: Buffer.byteLength(OPEN[0].text),
					totalBytes: Buffer.byteLength(OPEN[0].text),
					text: OPEN[0].text,
					nextOffset: null,
				},
				{ path: SECRET.path, kind: "absent", version: null },
				{ path: MISSING, kind: "absent", version: null },
				{
					path: OPEN[1].path,
					kind: "file",
					version: versionOf(db, OPEN[1].path),
					offset: 0,
					bytesRead: Buffer.byteLength(OPEN[1].text),
					totalBytes: Buffer.byteLength(OPEN[1].text),
					text: OPEN[1].text,
					nextOffset: null,
				},
			]);
			assert(versionOf(db, SECRET.path), `${SECRET.path} exists (the platform reads it)`);
			pass(
				`company_read of ${RIGHTS.join(", ")}: ${SECRET.path}, which the run may not read and which exists, is answered absent like ${MISSING}, and both open files are shown whole beside it`,
			);

			// 3. Secrets. A read of several files holding tokens shows them cut, and the run went on to its next request.
			const views = db
				.json(`select coalesce(jsonb_agg(v.view -> 'outputs'), '[]')::text from public.qorpera_native_context_views v
					where v.run_id = '${runId}'`)
				.flat();
			const tokenRead = outputs[2];
			assert(tokenRead.text.includes("ghp_[REDACTED]") && tokenRead.text.includes("sk_[REDACTED]"), tokenRead.text);
			assert.equal(code.redactCloudWebhookSecrets(tokenRead.text), tokenRead.text);
			assert.equal(tokenRead.envelope.content.sha256, sha256(tokenRead.text));
			const tokenReleases = log.steps[2].value.releases;
			assert.equal(tokenReleases.length, TOKEN_READ.length);
			for (const part of releasedReads(db, runId, tokenReleases))
				assert.equal(part[0].output, tokenRead.envelope.content.sha256, "each release is under the hash of what was shown");
			const tokenCites = views.filter((output) => output.callId === tokenRead.callId);
			assert(tokenCites.length >= 1 && tokenCites.every((output) => output.readSha256 === tokenRead.envelope.content.sha256));
			assert.deepEqual(
				db.refusals.filter((refusal) => refusal.includes("provenance")),
				[],
			);
			assert(state.agent.length > 3 + 1, "the run made its next request after the read");
			pass(
				`company_read of ${TOKEN_READ.join(", ")} showed the made-up ghp_ and sk_test_ tokens cut (ghp_[REDACTED], sk_[REDACTED]); its ${tokenReleases.length} releases and ${tokenCites.length} context-view citations are all under the hash of what was shown, no context view was refused, and the run went on to its next request`,
			);

			// 4. Windows never start or end inside a token: each window is the cut of exactly the file bytes it covers.
			const window = (j, file) => {
				const answer = answerOf(outputs[j].output);
				const bytes = Buffer.from(file.text, "utf8");
				assert.equal(
					answer.text,
					code.redactCloudWebhookSecrets(bytes.subarray(answer.offset, answer.offset + answer.bytesRead).toString("utf8")),
					`${outputs[j].callId}: the cut of the bytes it covers`,
				);
				return answer;
			};
			const longSpans = spansOf(LONG);
			const first = window(3, LONG);
			const second = window(4, LONG);
			assert.equal(first.offset, 0);
			assert.equal(second.offset, first.nextOffset);
			assert(!inside(longSpans, first.nextOffset), "the first window does not end inside a token");
			assert(first.bytesRead > 29_000 && second.bytesRead > 29_000);
			const endsAt = longSpans.find((span) => span.start === first.nextOffset);
			pass(
				`${LONG.path} in two windows: the first (${first.bytesRead} bytes) ends ${endsAt ? "where a token starts, so the second holds it whole" : "between tokens"}, the second goes on from its nextOffset ${first.nextOffset}; each is the cut of exactly the bytes it covers, every token in them cut`,
			);
			const mid = window(5, LONG);
			assert.equal(mid.offset, MID.start, "a window asked to start inside a token starts where the token does");
			assert(mid.text.startsWith("ghp_[REDACTED]"), mid.text.slice(0, 40));
			assert(!inside(longSpans, mid.offset + mid.bytesRead));
			pass(
				`a read asked to start inside a token (offset ${MID.start + 10}) started where the token does (offset ${mid.offset}) and showed it cut; it ended outside a token`,
			);
			const tiny = window(6, KEYS[0]);
			assert.equal(tiny.offset, DEPLOY_AT);
			assert.equal(tiny.bytesRead, DEPLOY_TOKEN.length);
			assert.equal(tiny.text, "ghp_[REDACTED]");
			assert.equal(tiny.nextOffset, DEPLOY_AT + DEPLOY_TOKEN.length);
			pass(
				`a read of 8 bytes at a token took the whole token (${tiny.bytesRead} bytes) and showed it cut, nextOffset just past it`,
			);
			const both = JSON.parse(outputs[7].text).files;
			for (const [k, file] of [LONG, LONG_B].entries()) {
				const shown = both[k];
				const bytes = Buffer.from(file.text, "utf8");
				assert.equal(shown.path, file.path);
				assert.equal(shown.text, code.redactCloudWebhookSecrets(bytes.subarray(0, shown.bytesRead).toString("utf8")));
				assert.equal(shown.nextOffset, shown.bytesRead);
				assert(!inside(spansOf(file), shown.bytesRead), `${file.path}: its window does not end inside a token`);
			}
			pass(
				`${LONG.path} and ${LONG_B.path} read together and cut alike (${both[0].bytesRead} and ${both[1].bytesRead} bytes): each ends outside a token, each the cut of exactly its bytes, with its own nextOffset`,
			);
			const blob1 = window(8, BLOB);
			const blob2 = answerOf(outputs[9].output);
			const runAt = BLOB.text.indexOf(ghp(""));
			assert.equal(blob1.nextOffset, runAt, "the window before the run ends where it starts");
			assert.equal(blob2.offset, runAt);
			assert.equal(blob2.text, "ghp_[REDACTED]");
			assert.equal(blob2.nextOffset, runAt + blob2.bytesRead);
			assert(blob2.bytesRead > 32 * 1024 && blob2.nextOffset < Buffer.byteLength(BLOB.text));
			assert.match(blob2.secretRun, new RegExp(`starts at offset ${runAt} and goes on past nextOffset`));
			pass(
				`a token-shaped run of ${BLOB.text.length - runAt - 5} bytes, longer than any window: the window before it ends at its start (${runAt}); the next shows the ${blob2.bytesRead} bytes it read of it as ghp_[REDACTED] and says ${JSON.stringify(blob2.secretRun)}`,
			);
			for (const answer of outputs)
				for (const needle of NEEDLES) assert(!answer.text.includes(needle), `${answer.callId} shows ${needle.slice(0, 16)}…`);
			for (const request of [...state.agent.map((entry) => entry.input), ...state.compactor])
				for (const needle of NEEDLES) assert(!request.includes(needle), `a provider request held ${needle.slice(0, 16)}…`);
			pass(
				`no answer and no request the provider got (${state.agent.length} agent, ${state.compactor.length} compactor) holds any of the ${NEEDLES.length} made-up tokens, nor any of the over-long run`,
			);

			// 5. Each file's read is recorded: one release a file, in the answer's order, under the hash of the answer.
			const step = (j) => log.steps[j].value;
			const releases = outputs.map((_, j) => step(j).releases);
			assert.equal(new Set(releases[0]).size, FIRST.length);
			const expected = READS;
			for (const [j, answer] of outputs.entries()) {
				const reads = releasedReads(db, runId, releases[j]);
				assert.deepEqual(
					reads.map((part) => part.map((read) => read.path)),
					expected[j].map((path) => [path]),
					`step ${j}: one read a release, in order`,
				);
				for (const [k, part] of reads.entries()) {
					assert.equal(part[0].version, versionOf(db, expected[j][k]));
					assert.equal(part[0].output, sha256(answer.text), "under the hash of the answer the model got");
				}
				assert.equal(answer.envelope.provenance.companyReadId, releases[j][0], "the answer cites its first release");
			}
			pass(
				`each file's read was recorded as its own release (${releases.map((ids) => ids.length).join(", ")} for the ${outputs.length} calls, in the answer's order; none for ${SECRET.path} or ${MISSING}), each naming that file's version, all under the hash of the answer the model got, the answer citing the first`,
			);

			// 6. The context view: each output at its bytes, citing its first release.
			for (const [j, answer] of outputs.entries()) {
				const recorded = views.filter((output) => output.callId === answer.callId);
				assert(recorded.length >= 1, `${answer.callId} is in a context view`);
				for (const output of recorded) {
					assert.equal(output.bytes, answer.bytes);
					assert.equal(output.readId, releases[j][0]);
					assert.equal(output.readSha256, sha256(answer.text));
				}
			}
			pass(
				`the run's context views recorded the ${outputs.length} outputs at their bytes (the largest ${Math.max(...outputs.map((a) => a.bytes))}), each citing its first release`,
			);

			// 7. The run's work log, read back.
			assert.deepEqual(
				log.index.map((row) => [row.j, row.tool, row.call, row.finished, row.narrow]),
				outputs.map((answer, j) => [j, "company_read", answer.callId, true, j === NARROW]),
			);
			for (let j = 0; j < NARROW; j++) {
				assert(log.steps[j].line.includes(`"result":${outputs[j].output},`), `step ${j} keeps its envelope byte for byte`);
				assert.deepEqual(log.index[j].releases, releases[j]);
				assert.deepEqual(
					step(j).reads,
					expected[j].map((path) => ({ path, version: versionOf(db, path) })),
				);
				assert.equal(step(j).reads_cut, undefined);
				assert.deepEqual([...step(j).paths].sort(), [...expected[j]].sort());
			}
			// The last call named locked/secret.md, which not every agent reads, so its step is written narrow (§4.5, as
			// for any call whose arguments name such a path): its line keeps its releases and keyed hashes, no path.
			assert.equal(step(NARROW).narrow, true);
			assert.deepEqual(step(NARROW).releases, releases[NARROW]);
			assert(!log.steps[NARROW].line.includes("locked") && !log.steps[NARROW].line.includes("open/"));
			pass(
				`the run's log keeps all ${outputs.length} steps (${log.blocks.length} blocks, each parsed by the shared parser): step 0 with its whole ${many.bytes}-byte envelope, its 7 releases, a reads copy naming each file and version, and the 7 paths it named; steps 1 to ${NARROW - 1} likewise; step ${NARROW} (it named ${SECRET.path}) narrow, keeping its 2 releases and no path`,
			);

			// 6. The bytes took turns: no get found the lanes busy or its object in flight, the two copies' shared objects
			//    included. (A read of several files takes one file's bytes at a time; the run's work log may read its tree
			//    beside a call, so two gets can be in flight, which the lanes take.)
			assert(state.lane.gets >= 2 * READS.flat().length, `${state.lane.gets} gets`);
			assert.equal(state.lane.busy, 0, "no get found the lanes busy or its object in flight");
			assert(state.lane.most <= 2, `${state.lane.most} gets at once`);
			pass(
				`the files' bytes took turns: ${state.lane.gets} gets of manifests and chunks, at most ${state.lane.most} in flight, none answered busy by the stand-in's two NAS lanes (one get an object), ${OPEN.map((file) => file.path).join(" and ")} sharing their objects included`,
			);
			process.stdout.write(`Outputs: ${outputs.map((a) => `${a.callId} ${a.bytes} B`).join(", ")}\n`);
		},
	}),
);
