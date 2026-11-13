import assert from "node:assert/strict";
import { ENVIRONMENT, finish, OWNER, pass, platformCommit, proveCompanyRun, sha256 } from "./prove-company-run.mjs";

// keyholes S2 (PR #1697): company_list shows a folder's tree in one call. End to end, through the real patched Codex
// and a migrated database (scripts/prove-company-run.mjs says what is real and what stands in):
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-s2-folder-tree.mjs
//
// - The largest listing, 500 entries, reaches the model in one result, whole, and says where to go on; the next call
//   with that `after` shows the rest, and the two together are exactly the folder's entries.
// - A listing whose lines do not all fit one result shows as many as fit and says where to go on; the next call shows
//   the rest, and nothing is lost between them.
// - The read rights: a glob over the whole company shows only what Alice's run may read, and a folder it may not read
//   is absent.
// - What was stored, read back: the run's context view (each output's bytes and the release it cites), the release
//   records (exactly the folder and the entries shown, under the hash of the answer), and the run's work log (each step
//   keeps its whole envelope, its release, its paths and its reads copy; every block parses with the shared parser).
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

/** big/: 20 folders of 25 files, 520 entries. Paths of 54 bytes, so 500 lines take about 29 KiB of one result. */
const AREAS = 20;
const PER_AREA = 25;
const bigFile = (i) =>
	`big/area-${String(Math.floor(i / PER_AREA)).padStart(2, "0")}/quarterly-planning-notes-for-sales-${String(i).padStart(4, "0")}.md`;
/** long/: 300 files of 120-byte paths, more than one result holds. */
const LONG = 300;
const longFile = (i) =>
	`long/${"a-long-name-that-a-generator-writes-when-it-keeps-the-whole-title-of-the-report-in-the-file-name"}-${String(i).padStart(4, "0")}.md`;
const SECRETS = { open: ["open/secret-1.md", "open/secret-2.md"], locked: ["locked/secret-3.md", "locked/inner/secret-4.md"] };

const mkdir = (path) => ({ op: "mkdir", path });
const write = (path, text) => ({ op: "write", path, text });
const SETUP = [
	platformCommit("prove-s2-big", [
		mkdir("big"),
		...Array.from({ length: AREAS }, (_, area) => mkdir(`big/area-${String(area).padStart(2, "0")}`)),
		...Array.from({ length: AREAS * PER_AREA }, (_, i) => write(bigFile(i), `Note ${i}.`)),
	]),
	platformCommit("prove-s2-long", [mkdir("long"), ...Array.from({ length: LONG }, (_, i) => write(longFile(i), `Report ${i}.`))]),
	platformCommit("prove-s2-rights", [
		mkdir("open"),
		mkdir("locked"),
		mkdir("locked/inner"),
		write("open/notes.md", "Open notes."),
		...[...SECRETS.open, ...SECRETS.locked].map((path) => write(path, `Secret at ${path}.`)),
	]),
	// locked/ becomes a resource of its own with no grant: no agent reads under it (core §5), the platform still does.
	`select public.qorpera_folder_set_resource('${ENVIRONMENT}', '${OWNER}', 'locked', 'subtree', 'company_shared', 'normal') \\g /dev/null`,
].join("\n");

/** A listing's answer, read as its lines: the header, the entries (path and kind), and the ending. An answer of one
 * line (an absent folder) has no entries. */
function listing(text) {
	const lines = text.split("\n");
	if (lines.length === 1) return { header: null, entries: [], ending: text };
	assert.equal(lines.at(-2), "", `a blank line before the ending: ${JSON.stringify(text.slice(-200))}`);
	const entries = lines.slice(1, -2).map((line) => {
		if (line.endsWith("/")) return { path: line.slice(0, -1), kind: "folder" };
		const [path, rest] = line.split("\t");
		return { path, kind: rest.startsWith("->") ? "symlink" : "file", bytes: Number(rest) };
	});
	return { header: lines[0], entries, ending: lines.at(-1) };
}

/** Where a listing says to go on: its `after`, or null when it says nothing more follows. */
const afterOf = (outputs) => {
	const { ending } = listing(JSON.parse(outputs.at(-1).output).content.text);
	const more = /call again with after ("(?:[^"\\]|\\.)*")\.$/.exec(ending);
	return more ? JSON.parse(more[1]) : null;
};

const CALLS = [
	() => ({ name: "company_list", arguments: { path: "big", depth: 8 } }),
	(outputs) => ({ name: "company_list", arguments: { path: "big", depth: 8, after: afterOf(outputs) } }),
	() => ({ name: "company_list", arguments: { path: "long" } }),
	(outputs) => ({ name: "company_list", arguments: { path: "long", after: afterOf(outputs) } }),
	() => ({ name: "company_list", arguments: { path: "", glob: "**/secret-*.md" } }),
	() => ({ name: "company_list", arguments: { path: "locked" } }),
];

/** The entries under a folder as the platform sees them (no read check), by path. */
function entriesUnder(db, folder) {
	return db.json(`select coalesce(jsonb_agg(jsonb_build_object('path', path, 'kind', kind, 'version', version) order by key_text), '[]')::text
		from public.qorpera_folder_entries where environment_id = '${ENVIRONMENT}' and kind <> 'claim'
			and key_text like '${folder}/%'`);
}

/** The reads a release recorded, as the run's read records keep them (every part, every resource). */
function releasedReads(db, runId, releaseId) {
	return db.json(`select coalesce(jsonb_agg(jsonb_build_object('path', x ->> 'path', 'version', x ->> 'version',
			'output', r.output_sha256)), '[]')::text
		from public.qorpera_folder_run_read_records r, jsonb_array_elements(r.reads) x
		where r.run_id = '${runId}' and r.release_id = '${releaseId}'`);
}

await finish(proveCompanyRun({
	name: "qorpera_prove_s2_folder_tree",
	prompt: "Look through the company folder's big/ and long/ folders, and find the secret files.",
	setup: SETUP,
	objects: new Map(),
	calls: CALLS,
	async check({ db, binding, outputs, log }) {
		const runId = binding.runId;
		const MAX = 32 * 1024;
		const answers = outputs.map((output) => ({ ...output, list: listing(output.text) }));
		for (const answer of answers) {
			assert.equal(answer.envelope.status, "ok", answer.output.slice(0, 300));
			assert.equal(answer.envelope.content.truncated, false, "the tool fitted its answer: the fence cut nothing");
			assert.equal(answer.envelope.content.includedBytes, answer.envelope.content.originalBytes);
			assert(answer.bytes <= MAX, `${answer.callId}: ${answer.bytes} B`);
		}

		// 1. The largest listing: 500 entries in one result, then where to go on.
		const big = entriesUnder(db, "big");
		assert.equal(big.length, AREAS + AREAS * PER_AREA);
		const [first, rest] = answers;
		assert.equal(first.list.entries.length, 500);
		assert(first.bytes > 28 * 1024, `the 500 entries take ${first.bytes} B of one result`);
		assert.equal(first.list.ending, `500 entries shown. More: call again with after ${JSON.stringify(first.list.entries[499].path)}.`);
		assert.match(first.list.header, /^big\/ \(version [0-9a-f-]{36}\), asOfSeq [0-9]+, depth 8:$/);
		pass(
			`company_list big/ at depth 8 reached the model whole through the patched Codex: 500 entries (${first.list.entries.filter((e) => e.kind === "folder").length} folders, ${first.list.entries.filter((e) => e.kind === "file").length} files) in one ${first.bytes}-byte result, ending ${JSON.stringify(first.list.ending.slice(0, 40))}…`,
		);
		assert.equal(rest.arguments.after, first.list.entries[499].path);
		assert.equal(rest.list.ending, `${big.length - 500} entries. Nothing more.`);
		const shownBig = [...first.list.entries, ...rest.list.entries];
		assert.deepEqual(
			shownBig.map((entry) => `${entry.path}:${entry.kind}`),
			big.map((entry) => `${entry.path}:${entry.kind}`),
			"the two calls show exactly the folder's entries, in order, each once",
		);
		const sizes = new Map(
			db
				.json(`select coalesce(jsonb_agg(jsonb_build_array(path, bytes)), '[]')::text from public.qorpera_folder_entries
					where environment_id = '${ENVIRONMENT}' and kind = 'file' and key_text like 'big/%'`)
				.map(([path, bytes]) => [path, Number(bytes)]),
		);
		assert(shownBig.every((entry) => entry.kind !== "file" || entry.bytes === sizes.get(entry.path)), "each file's size as stored");
		pass(
			`the next call, with after ${JSON.stringify(rest.arguments.after.slice(-12))}, showed the other ${rest.list.entries.length}: the two show all ${big.length} entries of big/ in key order, each once, with each file's size`,
		);

		// 2. A listing whose lines do not fit one result: as many as fit, then where to go on.
		const long = entriesUnder(db, "long");
		const [cut, after] = answers.slice(2, 4);
		const shown = cut.list.entries.length;
		assert(shown > 100 && shown < LONG, `${shown} of ${LONG} long paths in one result`);
		const last = cut.list.entries.at(-1).path;
		assert.equal(cut.list.ending, `${shown} entries shown. More: call again with after ${JSON.stringify(last)}.`);
		// The longest start that fits: one more line would not have (the tool's own fit, fitsOneResult, leaves 800 bytes
		// of the 32 KiB to the envelope).
		const next = long[shown];
		const nextLine = Buffer.byteLength(JSON.stringify(`${next.path}\t${sizesOf(db, next.path)}\n`)) - 2;
		assert(
			Buffer.byteLength(JSON.stringify(cut.text)) + nextLine > MAX - 800 - 8,
			"one more line would not have fit one result",
		);
		assert.equal(after.arguments.after, last);
		assert.equal(after.list.ending, `${LONG - shown} entries. Nothing more.`);
		assert.deepEqual(
			[...cut.list.entries, ...after.list.entries].map((entry) => entry.path),
			long.map((entry) => entry.path),
			"the two calls show exactly long/'s entries, in order, each once",
		);
		pass(
			`company_list long/ (paths of ${Buffer.byteLength(longFile(0))} bytes) showed the ${shown} entries that fit one ${cut.bytes}-byte result and said "More: call again with after …" naming the last one shown; the next call showed the other ${LONG - shown}, so nothing was left out`,
		);

		// 3. The read rights: what the run may not read is never shown, and its folder is absent.
		const [glob, locked] = answers.slice(4, 6);
		assert.deepEqual(
			glob.list.entries.map((entry) => entry.path),
			SECRETS.open,
		);
		assert.equal(glob.list.ending, "2 entries. Nothing more.");
		const platformSees = entriesUnder(db, "locked").map((entry) => entry.path);
		for (const path of SECRETS.locked) assert(platformSees.includes(path), `${path} exists (the platform reads it)`);
		pass(
			`a glob over the whole company (**/secret-*.md, depth 8) showed only ${SECRETS.open.join(" and ")}: the run may not read ${SECRETS.locked.join(" or ")}, which exist`,
		);
		assert.equal(locked.text, "locked: absent; nothing is there that you may read.");
		assert.equal(locked.envelope.provenance.companyReadId, undefined, "nothing was released for it");
		pass(`company_list locked/ answered ${JSON.stringify(locked.text)}, with nothing released`);

		// 4. The context view: each output as the model got it, and the release it cites.
		const views = db
			.json(`select coalesce(jsonb_agg(v.view -> 'outputs'), '[]')::text from public.qorpera_native_context_views v
				where v.run_id = '${runId}'`)
			.flat();
		for (const answer of answers) {
			const recorded = views.filter((output) => output.callId === answer.callId);
			assert(recorded.length >= 1, `${answer.callId} is in a context view`);
			for (const output of recorded) {
				assert.equal(output.bytes, answer.bytes);
				assert.equal(output.sha256, sha256(answer.output));
				assert.equal(output.readId ?? null, answer.envelope.provenance.companyReadId ?? null);
			}
		}
		pass(
			`the run's context views recorded each of the ${answers.length} outputs at its bytes (the largest ${Math.max(...answers.map((a) => a.bytes))}) with the release it cites`,
		);

		// 5. The release records: exactly the folder listed and the entries shown, under the hash of the answer.
		for (const answer of answers.slice(0, 5)) {
			const id = answer.envelope.provenance.companyReadId;
			assert(id, `${answer.callId} cites a release`);
			const reads = releasedReads(db, runId, id);
			const folder = answer.arguments.path;
			const expected = [...(folder === "" ? [] : [folder]), ...answer.list.entries.map((entry) => entry.path)].sort();
			assert.deepEqual(reads.map((read) => read.path).sort(), expected, `${answer.callId}: the release names what was shown`);
			assert(reads.every((read) => read.output === sha256(answer.text)), "under the hash of the answer the model got");
			assert(!reads.some((read) => read.path.startsWith("locked")), "no path the run may not read");
		}
		pass(
			`each listing's release recorded exactly the folder and the entries it showed (${releasedReads(db, runId, first.envelope.provenance.companyReadId).length} reads for the 500), under the hash of the answer; none under locked/`,
		);

		// 6. The run's work log, read back: each step keeps the envelope, its release, its paths and its reads copy. The
		//    last call named locked/, which not every agent reads, so its step is written narrow (§4.5, as for any tool
		//    whose arguments name such a path): its line keeps only its identity, keyed hashes and releases.
		const NARROW = answers.length - 1;
		assert.deepEqual(
			log.index.map((step) => [step.j, step.tool, step.call, step.finished, step.narrow]),
			answers.map((answer, j) => [j, "company_list", answer.callId, true, j === NARROW]),
		);
		for (const [j, answer] of answers.entries()) {
			const step = log.steps[j];
			assert.equal(step.value.call, answer.callId);
			const id = answer.envelope.provenance.companyReadId;
			assert.deepEqual(step.value.releases, id ? [id] : []);
			assert.deepEqual(log.index[j].releases, id ? [id] : []);
			if (j === NARROW) {
				assert.equal(step.value.narrow, true);
				assert.deepEqual(Object.keys(step.value).sort(), ["args_hash", "at", "call", "finished", "j", "narrow", "releases", "result_hash", "tool"]);
				assert(!step.line.includes("locked"), "the narrow line names no path");
				continue;
			}
			assert(step.line.includes(`"result":${answer.output},`), `step ${j} keeps its envelope byte for byte`);
			// The step names the folder its call named (the listing's lines are text: its entries are in its release).
			assert.deepEqual(step.value.paths, answer.arguments.path === "" ? [] : [answer.arguments.path]);
			const named = id ? releasedReads(db, runId, id) : [];
			const copy = step.value.reads;
			assert(copy.every((read) => named.some((n) => n.path === read.path && n.version === read.version)));
			assert.equal(step.value.reads_cut === true, copy.length < named.length);
			assert(Buffer.byteLength(JSON.stringify(copy)) <= 16 * 1024);
		}
		const firstStep = log.steps[0].value;
		assert.equal(firstStep.reads_cut, true);
		pass(
			`the run's log keeps all ${answers.length} steps (${log.blocks.length} blocks, each parsed by the shared parser): steps 0 to ${NARROW - 1} each with its whole envelope (step 0's ${first.bytes} B), its one release, the folder it named as its paths, and its reads copy (step 0's ${firstStep.reads.length} of ${releasedReads(db, runId, first.envelope.provenance.companyReadId).length} reads, marked reads_cut; the release records keep them all), none narrow; step ${NARROW} (it named locked/) narrow, with no path in its line`,
		);
		process.stdout.write(`Outputs: ${answers.map((a) => `${a.callId} ${a.bytes} B`).join(", ")}\n`);
	},
}));

/** A file's size as stored. */
function sizesOf(db, path) {
	return db.query(`select bytes from public.qorpera_folder_entries where environment_id = '${ENVIRONMENT}'
		and key_text = public.qorpera_folder_key('${path}')`);
}
