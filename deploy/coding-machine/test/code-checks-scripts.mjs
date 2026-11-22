// The executor's commands for a repository's checks and site (own code storage, steps 3 and 4), one file each, for
// test/prove-in-coding-machine.sh: copy.sh (step 3's clean copy), collect.sh and drop.sh (step 4). Each is the
// executor's own text, read from the source and never written by hand: collect.sh and drop.sh are code-site.ts'
// constants (it imports nothing of the platform's, so Node imports it with its types stripped); the copy is a private
// constant of coding-executor-host.ts, which imports the whole executor, so its array literals are read from that file
// and evaluated on their own. test/prove-coding-image.sh runs this on the test machine before it pushes the proof in:
//
//   node deploy/coding-machine/test/code-checks-scripts.mjs <folder>
//
// (Node 22.18 or later strips the types itself; before that, add --experimental-strip-types.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
	CODE_CHECKS_NEWER_RUN,
	CODE_SITE_COLLECT,
	CODE_SITE_DROP,
} from "../../../packages/runner-orchestrator/src/code-site.ts";

const out = process.argv[2];
if (!out) {
	console.error("usage: node code-checks-scripts.mjs <folder>");
	process.exit(2);
}
const host = readFileSync(
	new URL("../../../packages/runner-orchestrator/src/coding-executor-host.ts", import.meta.url),
	"utf8",
);
/** One constant's declaration in the host, from `const <name> = [` to its end. */
const declaration = (name, end) => {
	const start = host.indexOf(`const ${name} = [`);
	const stop = start < 0 ? -1 : host.indexOf(end, start);
	return stop < 0 ? null : host.slice(start, stop + end.length);
};
// The host's own guard while it keeps one; code-site.ts' once it imports that.
const guard =
	declaration("CODE_CHECKS_NEWER_RUN", "\n];") ??
	`const CODE_CHECKS_NEWER_RUN = ${JSON.stringify(CODE_CHECKS_NEWER_RUN)};`;
const extract = (name) => {
	const text = declaration(name, '\n].join("\\n");');
	if (text === null) throw new Error(`${name} is not in coding-executor-host.ts as this reads it`);
	const value = runInNewContext(`${guard}\n${text}\n${name}`);
	if (typeof value !== "string" || !value.startsWith("set -eu\n") || !value.includes(CODE_CHECKS_NEWER_RUN.join("\n")))
		throw new Error(`${name} did not read as a checks script`);
	return value;
};
const copy = extract("CODE_CHECKS_COPY");
const diff = extract("CODE_CHECKS_DIFF");
const cacheSave = extract("CODE_CHECKS_CACHE_SAVE");
const persist = extract("CODE_CHECKS_PERSIST");
const persistDrop = extract("CODE_CHECKS_PERSIST_DROP");
mkdirSync(out, { recursive: true });
for (const [name, text] of [
	["copy.sh", copy],
	["diff.sh", diff],
	["cache-save.sh", cacheSave],
	["persist.sh", persist],
	["persist-drop.sh", persistDrop],
	["collect.sh", CODE_SITE_COLLECT],
	["drop.sh", CODE_SITE_DROP],
])
	writeFileSync(join(out, name), `${text}\n`, { mode: 0o644 });
console.log(`wrote copy.sh, diff.sh, cache-save.sh, persist.sh, persist-drop.sh, collect.sh and drop.sh to ${out}`);
