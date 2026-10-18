// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. The run-on-node plan's deploy-node step runs it, and
// prove-coding-session-vm.sh before it builds anything. And for the custody proof (P3_CUSTODY=1): the forms it searches,
// the guard on the driver's output, the executor's reasons it reads, the executor composition's broker and save check,
// its search of the company folder's git objects, and the pack it writes whose value is whole only in a resolved delta.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { CARRIES, custodyForms, DELTA_PACK, gitObjectSearch, SAVE_REFUSED, withhold } from "./p3-custody.mjs";
import { postgrestError, postgrestStatus } from "./p3-postgrest-errors.mjs";

const driver = fileURLToPath(new URL("./p3-driver.mjs", import.meta.url));
const executor = fileURLToPath(new URL("./p3-executor.ts", import.meta.url));
const codingExecutor = fileURLToPath(new URL("../../../packages/runner-orchestrator/src/coding-executor.ts", import.meta.url));
const secretScan = fileURLToPath(new URL("../../../packages/object-gateway/src/folder-service/secret-scan.ts", import.meta.url));

test("the driver's imports link and it stops at its usage line", () => {
	const run = spawnSync(process.execPath, [driver], { encoding: "utf8" });
	assert.match(run.stderr, /usage: p3-driver\.mjs/, run.stderr);
});

test("no top-level binding is declared below the main flow's start", () => {
	const lines = readFileSync(driver, "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith("const db = await "));
	assert.ok(start > 0, "the driver's main flow starts at `const db = await …`");
	const late = lines
		.map((line, index) => `${index + 1}: ${line}`)
		.slice(start + 1)
		.filter((line) => /^\d+: (const|let|var|class) /.test(line))
		.filter((line) => !/^\d+: let (executor|stopping|postgrest);$/.test(line));
	assert.deepEqual(late, []);
});

test("the stand-in answers a failed call with PostgREST's status", () => {
	const cases = [
		// Busy: production's control calls 55P03 busy only in a 500 (review r1 F2: it was 400 here).
		["55P03", 500], ["40001", 500], ["40P01", 500],
		// The folder view refusals the control keeps: 42501 (a role is always set here) and 22023.
		["42501", 403], ["22023", 400], ["P0001", 400],
		["P0002", 500], ["XX000", 500], ["23505", 409], ["23503", 409], ["25006", 405], ["25001", 500],
		["08006", 503], ["53100", 503], ["53400", 500], ["42883", 404], ["42P01", 404], ["42P17", 500],
		["PGRST202", 404], ["PT402", 402], ["PT100", 400], [null, 500], ["", 500],
	];
	assert.deepEqual(cases.map(([code]) => [code, postgrestStatus(code)]), cases);
});

test("the stand-in's error body is PostgREST's, exactly", () => {
	const answer = postgrestError(Object.assign(new Error("Folder view is unavailable"), { sqlState: "42501" }));
	assert.equal(answer.status, 403);
	const body = JSON.parse(answer.body);
	assert.deepEqual(Object.keys(body).sort(), ["code", "details", "hint", "message"]);
	assert.deepEqual(body, { code: "42501", message: "Folder view is unavailable", details: null, hint: null });
	const detail = "qorpera.test-machine/new-disk";
	assert.equal(JSON.parse(postgrestError({ sqlState: "42501", message: "m", detail }).body).details, detail);
	// The stand-in's own failure, without a SQLSTATE: a 500 that no caller reads as busy or refused.
	assert.deepEqual(postgrestError(new Error("psql exited")), {
		status: 500, body: JSON.stringify({ code: null, message: "psql exited", details: null, hint: null }),
	});
});

test("the executor's control is production's, and the driver answers its requests as the stand-in's", () => {
	const source = readFileSync(executor, "utf8");
	assert.match(source, /^import \{ CodingExecutorHttpControl \} from "\.\.\/control\.ts";$/m);
	assert.match(source, /new CodingExecutorHttpControl\(\{[^}]*fetch: rest\.fetch,\s*\}\)/);
	// Review r1 F1: a copy of the control's refusal mapping here got CodingControlRefused's arguments wrong.
	assert.doesNotMatch(source, /CodingControlRefused|CodingControlBusy|VIEW_REFUSALS|t: "rpc"/);
	const driven = readFileSync(driver, "utf8");
	assert.match(driven, /if \(message\.t === "rest"\) \{\n[^\n]*\n\t*void timed\("rpc", name, restAnswer\(/);
	assert.match(driven, /return \{ name: rpc\?\.\[1\], \.\.\.postgrestError\(error\) \};/);
});

test("the custody proof searches the value, its hex, its base64 at each offset and its URL encoding", () => {
	const value = "p3probe-Zm9vYmFy_baz-0123456789abcdefABCDEF";
	const forms = custodyForms(value);
	assert.ok(forms.includes(value));
	assert.ok(forms.includes(Buffer.from(value).toString("hex")));
	// Whatever bytes come before and after it, its base64 in either alphabet holds one of the forms.
	for (const encoding of ["base64", "base64url"])
		for (let before = 0; before < 6; before += 1)
			for (let after = 0; after < 3; after += 1) {
				const text = Buffer.concat([Buffer.alloc(before, 0xa7), Buffer.from(value), Buffer.alloc(after, 0x5c)]).toString(encoding);
				assert.ok(forms.some((form) => form !== value && text.includes(form)), `${encoding}, ${before} bytes before, ${after} after`);
			}
	// No URL form for a value URL encoding leaves alone; one for a value it changes.
	assert.ok(!forms.some((form) => form.includes("%")));
	assert.ok(custodyForms("p3 probe/value+1").includes("p3%20probe%2Fvalue%2B1"));
	// The driver's probe: every form is long enough to match nothing by chance.
	assert.ok(custodyForms(`p3probe-${"A".repeat(32)}`).every((form) => form.length >= 40));
});

test("the driver's output withholds a line that carries a form, and counts it by source", () => {
	const forms = custodyForms("p3probe-withheld-0123456789");
	const written = [];
	const stream = { write: (chunk, ...rest) => written.push([String(chunk), rest.length]) };
	const counts = {};
	withhold(stream, forms, counts);
	stream.write("PASS: nothing here\n");
	stream.write(`executor: {"event":"x","value":"${forms[0]}"}\np3: rpc ok\n`, "utf8", () => undefined);
	stream.write(Buffer.from(`p3: rpc answered ${forms[1]}\n`));
	stream.write(`something ${forms.at(-1)}\n`);
	assert.equal(written[0][0], "PASS: nothing here\n");
	assert.match(written[1][0], /^withheld: a line \(executor\) that carried a custody form \(\d+ characters\)\np3: rpc ok\n$/);
	assert.equal(written[1][1], 1, "the encoding is dropped with the text; the callback stays");
	assert.match(written[2][0], /^withheld: a line \(rpc\) /);
	assert.match(written[3][0], /^withheld: a line \(driver\) /);
	assert.ok(written.every(([text]) => !forms.some((form) => text.includes(form))));
	assert.deepEqual(counts, { executor: 1, rpc: 1, driver: 1 });
});

test("the custody proof reads the executor's own reason for a refused save, and the folder's for a path that carries a value", () => {
	// The refusal, then its way out of a git commit that carried the value.
	const refusal = /const SAVE_REFUSAL =\n\t"([^"]*)";/.exec(readFileSync(codingExecutor, "utf8"))?.[1];
	assert.ok(refusal?.startsWith(SAVE_REFUSED), refusal);
	assert.match(readFileSync(secretScan, "utf8"), new RegExp(`^export const CARRIES = ${JSON.stringify(CARRIES)};$`, "m"));
});

test("the executor composition asks the broker as production's client, and gives the save check the machine's values", () => {
	const source = readFileSync(executor, "utf8");
	assert.match(source, /new CodingMachineCommandSecrets\(new BrokerCodingEnvironment\(\{[^}]*fetch: broker\.fetch \}\)\)/);
	assert.match(source, /\.\.\.\(commandSecrets \? \{ commandSecrets \} : \{\}\),/);
	// The host reads the boundaries' secrets at a session's attach: without it, the attach fails on a TypeError.
	assert.match(source, /const boundaries: Pick<CodingFolderControl, "boundary" \| "restarted" \| "secrets"> = \{/);
	assert.match(source, /new CodingFolderControl\(\{ \.\.\.\(config\.folder\.controlSocket \? \{ path: config\.folder\.controlSocket \} : \{\}\), secrets \}\)/);
	assert.match(source, /else if \(message\.t === "broker"\) broker\.answer\(message\);/);
});

test("the custody proof finds a value in the folder's git objects: loose in the store, and loose or packed in the saved repo.git", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-git-search-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const value = `p3probe-${randomBytes(16).toString("hex")}`;
	const control = `p3-control-${randomBytes(16).toString("hex")}`;
	const forms = custodyForms(value);
	writeFileSync(join(root, "forms"), forms.join("\n"));
	writeFileSync(join(root, "control"), control);
	const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
	const repository = (name) => {
		const work = join(root, name);
		execFileSync("git", ["init", "-q", work], { stdio: "pipe" });
		const git = (...args) => execFileSync("git", ["-C", work, "-c", "user.name=P3", "-c", "user.email=p3@qorpera.invalid", ...args],
			{ encoding: "utf8", stdio: "pipe" }).trim();
		const commit = (files, message) => {
			for (const [file, text] of Object.entries(files))
				if (text === null) rmSync(join(work, file));
				else writeFileSync(join(work, file), text);
			git("add", "-A");
			git("commit", "-q", "-m", message);
			return git("rev-parse", "HEAD");
		};
		const objects = join(work, ".git", "objects");
		const files = () => readdirSync(objects, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
			.map((entry) => relative(objects, join(entry.parentPath, entry.name)));
		return { git, commit, objects, files };
	};
	const blob = (text) => execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim();
	const noise = randomBytes(6000).toString("hex").match(/.{1,64}/g).join("\n");

	// Loose, as a turn leaves them: a value committed and removed, a big file that starts with it, and a control.
	const loose = repository("loose");
	loose.commit({ "leak.txt": `P3 custody\n${value}\n`, "big.txt": `${value}\n${noise}\n` }, "a value");
	const headLoose = loose.commit({ "leak.txt": null, "big.txt": null, "control.txt": `${control}\n` }, "a control");
	// Packed: the value only in a blob the pack holds as a delta of a bigger one.
	const packed = repository("packed");
	const base = `${noise}\n${randomBytes(2000).toString("hex")}\n`;
	packed.commit({ "big.txt": base }, "base");
	packed.commit({ "big.txt": `${noise}\n${value}\n` }, "a value");
	const headPacked = packed.commit({ "big.txt": base, "control.txt": `${control}\n` }, "a control");
	packed.git("repack", "-a", "-d", "-f", "-q");
	const [pack] = packed.files().filter((file) => file.endsWith(".pack"));
	const deltified = blob(`${noise}\n${value}\n`);
	const verified = packed.git("verify-pack", "-v", join(packed.objects, pack.replace(/\.pack$/, ".idx"))).split("\n");
	assert.equal(verified.find((line) => line.startsWith(deltified))?.split(/\s+/).length, 7, "the value's blob is a delta in the pack");
	assert.ok(!packed.files().some((file) => /^[0-9a-f]{2}\//.test(file)), "no loose object is left");

	// The store and the saved folder's path versions: a loose object in one chunk (the big one in two), a pack in three.
	const store = join(root, "store");
	const profile = join(store, "00000000-0000-4000-8000-000000000001");
	mkdirSync(profile, { recursive: true });
	const put = (bytes) => {
		writeFileSync(join(profile, sha256(bytes)), bytes);
		return sha256(bytes);
	};
	const bigLoose = blob(`${value}\n${noise}\n`);
	const save = (path, bytes, parts) => {
		const size = Math.ceil(bytes.length / parts);
		const chunks = Array.from({ length: parts }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
		const manifest = JSON.stringify({ schema: "qorpera.cloud-file-manifest/v2", fileSha256: sha256(bytes), bytes: bytes.length,
			mediaType: "application/octet-stream", executable: false, chunks: chunks.map((chunk) => ({ sha256: put(chunk), bytes: chunk.length })) });
		return { path, manifest: put(Buffer.from(manifest)), file: sha256(bytes) };
	};
	const saved = [];
	for (const [name, at] of [["loose", loose], ["packed", packed]])
		for (const file of at.files())
			saved.push(save(`code/qorpera/${name}/repo.git/objects/${file}`, readFileSync(join(at.objects, file)),
				file === `${bigLoose.slice(0, 2)}/${bigLoose.slice(2)}` ? 2 : file.endsWith(".pack") ? 3 : 1));
	// The pack whole too, unnamed, as a refused save's bytes may wait in the store.
	put(readFileSync(join(packed.objects, pack)));
	// Alternates would have git read the packed repository's objects from the disk: not followed.
	saved.push(save("code/qorpera/loose/repo.git/objects/info/alternates", Buffer.from(`${packed.objects}\n`), 1));
	// A saved file whose bytes the store lacks is counted.
	saved.push({ path: `code/qorpera/loose/repo.git/objects/ff/${"0".repeat(38)}`, manifest: "e".repeat(64), file: "e".repeat(64) });

	const found = gitObjectSearch(createRequire(import.meta.url), { store, saved, forms: join(root, "forms"), control: join(root, "control"),
		oids: [headLoose, headPacked], scratch: root });
	const text = JSON.stringify(found);
	assert.ok(!forms.some((form) => text.includes(form)) && !text.includes(control), "only counts, ids and paths");
	assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("p3-git-")), [], "the rebuilt repositories are removed");
	const looseObjects = loose.files().filter((file) => /^[0-9a-f]{2}\//.test(file)).length;
	const leak = blob(`P3 custody\n${value}\n`);
	const kept = blob(`${control}\n`);
	// The store: each loose object inflates; the big one's first chunk holds its start, the value in it, and no id. The
	// whole pack is read, deltas resolved; the first of its three chunks starts one, and cannot be read alone.
	assert.equal(found.store.git, looseObjects);
	assert.equal(found.store.packs, 1);
	assert.equal(found.store.unreadPacks, 1);
	const inStore = (list) => list.map(({ oid, type, pack: inPack }) => `${oid} ${type}${inPack ? " pack" : ""}`).sort();
	assert.deepEqual(inStore(found.store.forms), [`${leak} blob`, "null blob", `${deltified} blob pack`].sort());
	assert.deepEqual(inStore(found.store.control), [`${kept} blob`, `${kept} blob pack`].sort());
	assert.deepEqual(found.store.seen.sort(), [headLoose, headPacked].sort());
	// The saved folder: both repositories whole, where each object is, the alternates not followed, the missing file.
	const loosePath = (oid) => `loose code/qorpera/loose/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
	const packPath = `pack code/qorpera/packed/repo.git/objects/${pack}`;
	assert.equal(found.saved.repositories, 2);
	assert.equal(found.saved.missing, 1);
	assert.equal(found.saved.files, saved.length);
	assert.equal(found.saved.objects, looseObjects + verified.filter((line) => /^[0-9a-f]{40} /.test(line)).length);
	const where = (list) => list.map(({ oid, type, where: at }) => `${oid} ${type} ${at.join(" + ")}`).sort();
	assert.deepEqual(where(found.saved.forms), [`${leak} blob ${loosePath(leak)}`, `${bigLoose} blob ${loosePath(bigLoose)}`,
		`${deltified} blob ${packPath}`].sort());
	assert.deepEqual(where(found.saved.control), [`${kept} blob ${loosePath(kept)}`, `${kept} blob ${packPath}`].sort());
	assert.deepEqual(found.saved.seen.sort(), [headLoose, headPacked].sort());
});

test("the driver runs the git object search in the node, after the file search, on the saved folder's git files", () => {
	const driven = readFileSync(driver, "utf8");
	const files = driven.indexOf('const fileHits = search(PLACES, "/root/p3-custody-forms")');
	const objects = driven.indexOf("`(${gitObjectSearch})(require, JSON.parse(require(\"node:fs\").readFileSync(process.argv[1], \"utf8\")))))`");
	assert.ok(files > 0 && objects > files, "the rebuilt repositories, in the node's /root, come after the file search");
	assert.ok(driven.includes("and path like 'code/%/repo.git/objects/%') as v\");"));
	assert.ok(driven.includes('oids: [head9], scratch: "/root" }));'));
});

test("the custody proof's delta pack holds the value whole in no object as the pack stores it, only in the resolved delta", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-delta-pack-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
	const value = `p3probe-${randomBytes(24).toString("base64url")}`;
	const output = execFileSync("bash", ["--noprofile", "--norc", "-c", DELTA_PACK], { cwd: root, env: { ...process.env, P3_PROBE: value }, encoding: "utf8" });
	assert.ok(!output.includes(value));
	const fields = Object.fromEntries(output.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
	assert.match(fields.pack, /^pack-[0-9a-f]{40}$/);
	assert.match(fields.base, /^[0-9a-f]{40}$/);
	assert.equal(fields.delta, `7 ${fields.base}`, "the target is a delta on the base");
	assert.deepEqual([fields["in-base"], fields["in-target"], fields["in-pack"], fields.loose], ["0", "1", "0", "0"]);
	// Each object inflated as the pack stores it (the target as its delta's instructions): none holds the value.
	const pack = join(root, ".git", "objects", "pack", fields.pack);
	const bytes = readFileSync(`${pack}.pack`);
	const entries = execFileSync("git", ["-C", root, "verify-pack", "-v", `${pack}.idx`], { encoding: "utf8" }).split("\n")
		.map((line) => line.split(/\s+/)).filter((parts) => /^[0-9a-f]{40}$/.test(parts[0]));
	assert.deepEqual(entries.map((parts) => parts[0]).sort(), [fields.base, fields.target].sort());
	const types = {};
	for (const [oid, , , stored, offset] of entries) {
		const entry = bytes.subarray(Number(offset), Number(offset) + Number(stored));
		// The entry's header: its type and size, then an offset delta's base offset or a ref delta's base id.
		let at = 0;
		while (entry[at] & 0x80) at += 1;
		at += 1;
		const type = (entry[0] >> 4) & 7;
		if (type === 6) {
			while (entry[at] & 0x80) at += 1;
			at += 1;
		} else if (type === 7) at += 20;
		types[oid] = type;
		assert.ok(!inflateSync(entry.subarray(at)).includes(value), `the pack's ${oid}`);
	}
	// The base whole (a blob, type 3), the target a delta on its id (type 7).
	assert.deepEqual(types, { [fields.base]: 3, [fields.target]: 7 });
});
