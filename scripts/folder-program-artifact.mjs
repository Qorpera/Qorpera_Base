import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The folder program's build record (deploy/folder-service/folder-program-linux-x64.json): which source, built in
 * which pinned image, gave which bytes. The shared-execution installer pins those bytes; the scripts tests check the
 * record names today's source and the installer's pin; the run-on-node step `folder-program` builds the source again
 * and checks it gives the recorded bytes. A change to crates/qorpera-folder therefore needs a new record, made with
 * `node scripts/build-folder-program.mjs --out <dir>` on Linux (it prints the record). */

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CRATE = "crates/qorpera-folder";
export const RECORD = "deploy/folder-service/folder-program-linux-x64.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function files(directory) {
	const out = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) out.push(...files(path));
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

/** One digest of what the program is built from (paths and contents): the manifest, the lock file and `src/`. Tests
 * and documents are not part of the program. */
export function folderProgramSourceSha256(root = repository) {
	const crate = join(root, CRATE);
	const inputs = [join(crate, "Cargo.toml"), join(crate, "Cargo.lock"), ...files(join(crate, "src"))];
	const lines = inputs.map((path) => `${relative(crate, path).split("\\").join("/")}\0${sha256(readFileSync(path))}\n`).sort();
	return sha256(lines.join(""));
}

export function readFolderProgramRecord(root = repository) {
	const record = JSON.parse(readFileSync(join(root, RECORD), "utf8"));
	const keys = ["schema", "image", "target", "profile", "sourceSha256", "bytes", "sha256"];
	if (
		Object.keys(record).length !== keys.length ||
		keys.some((key) => !(key in record)) ||
		record.schema !== "qorpera.folder-program-artifact/v1" ||
		record.target !== "x86_64-unknown-linux-gnu" ||
		record.profile !== "release" ||
		!/^[0-9a-f]{64}$/.test(record.sourceSha256) ||
		!/^[0-9a-f]{64}$/.test(record.sha256) ||
		!Number.isSafeInteger(record.bytes) ||
		record.bytes < 1
	)
		throw new Error(`${RECORD} is not a folder program record`);
	return record;
}

/** The record a build of today's source in `image` made. */
export function recordFor(bytes, image, root = repository) {
	return {
		schema: "qorpera.folder-program-artifact/v1",
		image,
		target: "x86_64-unknown-linux-gnu",
		profile: "release",
		sourceSha256: folderProgramSourceSha256(root),
		bytes: bytes.byteLength,
		sha256: sha256(bytes),
	};
}

// `--check <program>`: the program is what the record says today's source builds to.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [flag, program] = process.argv.slice(2);
	if (flag !== "--check" || !program) throw new Error("Usage: node scripts/folder-program-artifact.mjs --check <built program>");
	const record = readFolderProgramRecord();
	const built = readFileSync(program);
	const source = folderProgramSourceSha256();
	if (record.sourceSha256 !== source)
		throw new Error(`${RECORD} names other source (${record.sourceSha256}, today ${source}): record the new build`);
	if (built.byteLength !== record.bytes || sha256(built) !== record.sha256)
		throw new Error(`The build gave ${sha256(built)} (${built.byteLength} bytes), not the recorded ${record.sha256}: it is not reproducible`);
	console.log(`folder program ${record.sha256} matches its record`);
}
