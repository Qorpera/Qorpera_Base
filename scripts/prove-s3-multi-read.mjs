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
const MISSING = "nope/missing.md";
const FILES = [...SMALL, MEDIUM, LARGE, ...OPEN, SECRET];
const FIRST = [...SMALL, MEDIUM, LARGE].map((file) => file.path);
const RIGHTS = [OPEN[0].path, SECRET.path, MISSING, OPEN[1].path];

const SETUP = [
	platformCommit("prove-s3-files", [
		{ op: "mkdir", path: "docs" },
		{ op: "mkdir", path: "open" },
		{ op: "mkdir", path: "locked" },
		...FILES.map((file) => ({ op: "write", path: file.path, text: file.text })),
	]),
	// locked/ becomes a resource of its own with no grant: no agent reads under it (core §5), the platform still does.
	`select public.qorpera_folder_set_resource('${ENVIRONMENT}', '${OWNER}', 'locked', 'subtree', 'company_shared', 'normal') \\g /dev/null`,
].join("\n");

const filesOf = (output) => JSON.parse(JSON.parse(output).content.text).files;

const CALLS = [
	() => ({ name: "company_read", arguments: { paths: FIRST } }),
	(outputs) => ({
		name: "company_read",
		arguments: {
			path: LARGE.path,
			offset: filesOf(outputs.at(-1).output).find((file) => file.path === LARGE.path).nextOffset,
		},
	}),
	() => ({ name: "company_read", arguments: { paths: RIGHTS } }),
];

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
		async check({ db, binding, outputs, state, log }) {
			const runId = binding.runId;
			const MAX = 32 * 1024;
			for (const answer of outputs) {
				assert.equal(answer.envelope.status, "ok", answer.output.slice(0, 300));
				assert.equal(answer.envelope.content.truncated, false, "the tool fitted its answer: the fence cut nothing");
				assert(answer.bytes <= MAX, `${answer.callId}: ${answer.bytes} B`);
			}
			const [many, on, rights] = outputs;

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

			// 3. Each file's read is recorded: one release a file, in the answer's order, under the hash of the answer.
			const step = (j) => log.steps[j].value;
			const releases = [step(0).releases, step(1).releases, step(2).releases];
			assert.equal(releases[0].length, FIRST.length);
			assert.equal(new Set(releases[0]).size, FIRST.length);
			assert.equal(releases[1].length, 1);
			assert.equal(releases[2].length, 2, "a release for each file shown, none for the absent paths");
			const expected = [FIRST, [LARGE.path], [OPEN[0].path, OPEN[1].path]];
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
				`each file's read was recorded as its own release (7, 1 and 2 of them, in the answer's order; none for ${SECRET.path} or ${MISSING}), each naming that file's version, all under the hash of the answer the model got, the answer citing the first`,
			);

			// 4. The context view: each output at its bytes, citing its first release.
			const views = db
				.json(`select coalesce(jsonb_agg(v.view -> 'outputs'), '[]')::text from public.qorpera_native_context_views v
					where v.run_id = '${runId}'`)
				.flat();
			for (const [j, answer] of outputs.entries()) {
				const recorded = views.filter((output) => output.callId === answer.callId);
				assert(recorded.length >= 1, `${answer.callId} is in a context view`);
				for (const output of recorded) {
					assert.equal(output.bytes, answer.bytes);
					assert.equal(output.readId, releases[j][0]);
					assert.equal(output.readSha256, sha256(answer.text));
				}
			}
			pass(`the run's context views recorded the 3 outputs at their bytes (the largest ${many.bytes}), each citing its first release`);

			// 5. The run's work log, read back.
			assert.deepEqual(
				log.index.map((row) => [row.j, row.tool, row.call, row.finished, row.narrow]),
				outputs.map((answer, j) => [j, "company_read", answer.callId, true, j === 2]),
			);
			for (const j of [0, 1]) {
				assert(log.steps[j].line.includes(`"result":${outputs[j].output},`), `step ${j} keeps its envelope byte for byte`);
				assert.deepEqual(log.index[j].releases, releases[j]);
				assert.deepEqual(
					step(j).reads,
					expected[j].map((path) => ({ path, version: versionOf(db, path) })),
				);
				assert.equal(step(j).reads_cut, undefined);
				assert.deepEqual([...step(j).paths].sort(), [...expected[j]].sort());
			}
			// The third call named locked/secret.md, which not every agent reads, so its step is written narrow (§4.5, as
			// for any call whose arguments name such a path): its line keeps its releases and keyed hashes, no path.
			assert.equal(step(2).narrow, true);
			assert.deepEqual(step(2).releases, releases[2]);
			assert(!log.steps[2].line.includes("locked") && !log.steps[2].line.includes("open/"));
			pass(
				`the run's log keeps all 3 steps (${log.blocks.length} blocks, each parsed by the shared parser): step 0 with its whole ${many.bytes}-byte envelope, its 7 releases, a reads copy naming each file and version, and the 7 paths it named; step 1 likewise; step 2 (it named ${SECRET.path}) narrow, keeping its 2 releases and no path`,
			);

			// 6. The bytes took turns: one get at a time, none answered busy, the two copies' shared objects included.
			assert(state.lane.gets >= 2 * (FIRST.length + 1 + OPEN.length), `${state.lane.gets} gets`);
			assert.equal(state.lane.busy, 0, "no get found the lanes busy or its object in flight");
			assert.equal(state.lane.most, 1, `${state.lane.most} gets at once`);
			pass(
				`the files' bytes took turns: ${state.lane.gets} gets of manifests and chunks, one at a time, none answered busy by the stand-in's two NAS lanes (one get an object), ${OPEN.map((file) => file.path).join(" and ")} sharing their objects included`,
			);
			process.stdout.write(`Outputs: ${outputs.map((a) => `${a.callId} ${a.bytes} B`).join(", ")}\n`);
		},
	}),
);
