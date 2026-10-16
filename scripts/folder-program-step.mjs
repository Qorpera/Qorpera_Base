import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CARGO_BUILD, CRATE, folderProgramSourceSha256, readFolderProgramRecord } from "./folder-program-artifact.mjs";
import { NODE_IMAGE, RUST_IMAGE } from "./run-on-node-plan.mjs";

/** The run-on-node step `folder-program` (scripts/run-on-node-plan.mjs): crates/qorpera-folder's unit and FUSE tests
 * in the pinned Rust image and, beside them, its release build, the build's check against its record
 * (scripts/folder-program-artifact.mjs) and the built program against the folder service in Node, its runs with real
 * git using the pinned git.
 *
 * Compiled crates stay between runs in a target volume of the runner user's own: run-on-node gives each run one of
 * ci01..ci16, and no other run has that user meanwhile. The volume is keyed by the image (the toolchain) and the
 * crate's manifest and lock file; a volume with any other key is emptied first, so the build starts clean. The folder
 * program itself is built again on every run (`cargo clean -p`): cargo goes by file times, and a copied tree's say
 * nothing. Outside run-on-node the volume is the run's own and is removed at the end.
 *
 * run-on-node kills what a killed run left behind as the runner user, but the step's containers are docker's and
 * keep running. Each carries its target volume in a label, and the next run on that volume removes them before it
 * touches the crates, so no compiler of a killed run still writes there. */

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUSE = ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"];
/** The target directory scripts/build-folder-program.mjs builds the recorded program in. */
const TARGET = "/tmp/target";
/** A runner's volume unused this long is removed; so is a run's own volume that a killed run left behind a day ago. */
const RUNNER_DAYS = 2;
const LEFTOVER_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The label on every container the step starts; its value is the run's target volume. */
const LABEL = "qorpera.folder-program-target";

const PREPARE = `if [ "$(cat ${TARGET}/.qorpera-key 2>/dev/null)" = "$KEY" ]; then echo kept; else find ${TARGET} -mindepth 1 -delete && echo "$KEY" >${TARGET}/.qorpera-key && echo emptied; fi && touch ${TARGET}/.qorpera-used && cargo fetch --locked >&2`;
const TEST = "cargo clean --locked -p qorpera-folder && cargo test --locked";
const BUILD = `cargo clean --locked -p qorpera-folder --release && ${CARGO_BUILD} && cp ${TARGET}/release/qorpera-folder /out/`;
const CLEAN_BUILD = `rm -rf ${TARGET}/release && ${CARGO_BUILD} && cp ${TARGET}/release/qorpera-folder /out/`;
const CHECK = "node ../../scripts/folder-program-artifact.mjs --check /out/qorpera-folder";
const E2E = "node ../../node_modules/vitest/dist/cli.js --run test/folder-mount-e2e.test.ts test/folder-git-e2e.test.ts";
/** The pinned git, for the program's runs with real git on the mount (F3 step 5d): the coding machine's
 * (deploy/coding-machine/coding-image.json), built in NODE_IMAGE once per test machine into a volume of its own,
 * relocatable, and without what the runs do not use (http, Perl, Python, translations). A run that loses the race to
 * build it drops its own copy. */
const GIT_VERSION = "2.56.0";
const GIT_SHA256 = "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3";
const GIT_VOLUME = `qorpera-git-${GIT_VERSION}`;
const GIT_MAKE = `make -C git-${GIT_VERSION} -j$(nproc) prefix=/opt/git RUNTIME_PREFIX=YesPlease NO_TCLTK=YesPlease NO_RUST=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease NO_GETTEXT=YesPlease NO_CURL=YesPlease NO_EXPAT=YesPlease NO_OPENSSL=YesPlease`;
const GIT = `test -x /git/${GIT_VERSION}/bin/git || { cd /tmp && curl -fsSLo git.tar.xz https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz && echo "${GIT_SHA256}  git.tar.xz" | sha256sum -c - && tar xf git.tar.xz && ${GIT_MAKE} all >/dev/null && s=/git/.stage-$$ && ${GIT_MAKE} DESTDIR=$s install >/dev/null && { mv -T $s/opt/git /git/${GIT_VERSION} || true; } && rm -rf $s; }`;
const STAMPS = 'for d in /v/*; do echo "${d#/v/} $(stat -c %Y "$d/.qorpera-used" 2>/dev/null || echo 0)"; done';

/** The runner user whose target volume this run keeps: the one run-on-node's status file names, if this process runs
 * as that user. */
export function cacheRunner(status, user) {
	const runner = /^runner=(ci[0-9]+) /.exec(status.split("\n")[0])?.[1];
	return runner !== undefined && runner === user ? runner : null;
}

/** What the kept crates were compiled with: the image and the crate's manifest, lock file and any build script,
 * toolchain file or cargo configuration. The folder program's own source is not in it: it is built again every run. */
export function cacheKey(crate, image = RUST_IMAGE) {
	const hash = createHash("sha256").update(`qorpera-folder-target/v1\0${image}\n`);
	const files = ["Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain", "rust-toolchain.toml", ".cargo/config", ".cargo/config.toml"];
	for (const name of files) {
		const path = join(crate, name);
		hash.update(`${name}\0${existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "-"}\n`);
	}
	return hash.digest("hex");
}

/** Exit code of `docker args`, its output to `output` (a file descriptor, or the step's own). */
function run(docker, args, output = "inherit") {
	return new Promise((done) => {
		const child = spawn(docker, args, { stdio: ["ignore", output, output] });
		child.on("error", () => done(127));
		child.on("exit", (code) => done(code ?? 1));
	});
}

/** Exit code and standard output of `docker args`; its errors go to the step's. */
function capture(docker, args) {
	return new Promise((done) => {
		const child = spawn(docker, args, { stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => done({ code: 127, stdout }));
		child.on("close", (code) => done({ code: code ?? 1, stdout }));
	});
}

/** Removes the target volumes of runner users that have not run this step for RUNNER_DAYS, and the volumes of single
 * runs (`qorpera-folder-out-…`, `qorpera-folder-target-run-…`, and the older step's `qorpera-folder-<time>`) made more
 * than LEFTOVER_DAYS ago, which only a killed run leaves. Docker refuses to remove a volume a container uses. Best
 * effort: nothing here fails the step. */
export async function pruneVolumes(docker, own, now = Date.now()) {
	const listed = await capture(docker, ["volume", "ls", "-q", "--filter", "name=qorpera-folder-"]);
	if (listed.code !== 0) return;
	const names = listed.stdout.split("\n").filter(Boolean);
	const old = [];
	const runners = names.filter((name) => /^qorpera-folder-target-ci[0-9]+$/.test(name) && name !== own);
	if (runners.length > 0) {
		const mounts = runners.flatMap((name) => ["-v", `${name}:/v/${name}:ro`]);
		const stamps = await capture(docker, ["run", "--rm", ...mounts, RUST_IMAGE, "sh", "-c", STAMPS]);
		for (const [name, seconds] of stamps.stdout.split("\n").map((line) => line.split(" ")))
			if (runners.includes(name) && now - Number(seconds) * 1000 > RUNNER_DAYS * DAY_MS) old.push(name);
	}
	const leftovers = names.filter((name) => /^qorpera-folder-(out-|target-run-)?[0-9][0-9-]*$/.test(name));
	if (leftovers.length > 0) {
		const made = await capture(docker, ["volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}", ...leftovers]);
		for (const line of made.stdout.split("\n")) {
			const name = line.split(" ")[0];
			const created = Date.parse(line.slice(name.length + 1));
			if (leftovers.includes(name) && now - created > LEFTOVER_DAYS * DAY_MS) old.push(name);
		}
	}
	for (const name of old)
		if ((await capture(docker, ["volume", "rm", name])).code === 0) console.log(`== folder-program: removed the unused volume ${name}`);
}

/** Removes the containers a killed run of the step left on `target`, running or not; true once none is left. This
 * run holds the runner user, so no live run has that volume. */
export async function removeLeftContainers(docker, target) {
	const listed = await capture(docker, ["ps", "-aq", "--filter", `label=${LABEL}=${target}`]);
	if (listed.code !== 0) return false;
	const ids = listed.stdout.split("\n").filter(Boolean);
	if (ids.length === 0) return true;
	console.log(`== folder-program: removing ${ids.length} container(s) a killed run left on ${target}`);
	return (await capture(docker, ["rm", "-f", ...ids])).code === 0;
}

/** Runs the step; true when the tests, the build, its check and the program against the service all passed. */
export async function folderProgramStep({
	root = repository,
	docker = "docker",
	status = existsSync(join(root, ".run-on-node-status")) ? readFileSync(join(root, ".run-on-node-status"), "utf8") : "",
	user = userInfo().username,
	now = Date.now(),
} = {}) {
	const runner = cacheRunner(status, user);
	const target = runner ? `qorpera-folder-target-${runner}` : `qorpera-folder-target-run-${now}-${process.pid}`;
	const out = `qorpera-folder-out-${now}-${process.pid}`;
	const rust = (script, extra = []) => [
		"run",
		"--rm",
		"--label",
		`${LABEL}=${target}`,
		...extra,
		"-e",
		`CARGO_TARGET_DIR=${TARGET}`,
		"-v",
		"qorpera-cargo-registry:/usr/local/cargo/registry",
		"-v",
		`${join(root, CRATE)}:/src:ro`,
		"-v",
		`${target}:${TARGET}`,
		"-w",
		"/src",
		RUST_IMAGE,
		"sh",
		"-c",
		script,
	];
	const node = (script, extra = []) => [
		"run",
		"--rm",
		"--label",
		`${LABEL}=${target}`,
		...extra,
		"-e",
		"QORPERA_FOLDER_MOUNT_BIN=/out/qorpera-folder",
		"-v",
		`${out}:/out:ro`,
		"-v",
		`${root}:/repo`,
		"-w",
		"/repo/packages/object-gateway",
		NODE_IMAGE,
		"sh",
		"-c",
		script,
	];
	const pruned = pruneVolumes(docker, target, now);
	const work = mkdtempSync(join(tmpdir(), "qorpera-folder-step-"));
	try {
		if ((await run(docker, ["volume", "create", out], "ignore")) !== 0) return false;
		if (!(await removeLeftContainers(docker, target))) {
			console.log(`== folder-program: the containers a killed run left on ${target} could not be removed`);
			return false;
		}
		const key = cacheKey(join(root, CRATE));
		const prepared = await capture(docker, rust(PREPARE, ["-e", `KEY=${key}`]));
		if (prepared.code !== 0) {
			console.log(`== folder-program: preparing ${target} failed (${prepared.code})`);
			return false;
		}
		const kept = prepared.stdout.trim() === "kept";
		const state = kept ? "kept" : "emptied for a clean build";
		console.log(`== folder-program: compiled crates in ${target} ${state} (key ${key.slice(0, 12)})`);
		// The tests' output waits in a file and is printed after the build's, as run-on-node-plan.mjs's `beside` does.
		const testLog = openSync(join(work, "tests.log"), "w");
		const tested = run(docker, rust(TEST, [...FUSE, "-e", "QORPERA_FOLDER_FUSE_TESTS=1"]), testLog);
		let built = (await run(docker, rust(BUILD, ["-v", `${out}:/out`]))) === 0;
		let checked = built && (await run(docker, node(CHECK))) === 0;
		// Kept crates that give other bytes than a clean build would fail a sound record: build again from clean, so the
		// check always judges what a clean build gives. A record of other source fails either way.
		if (built && !checked && kept && sourceRecorded(root)) {
			console.log("== folder-program: the build from kept crates is not the recorded one; building again from clean");
			built = (await run(docker, rust(CLEAN_BUILD, ["-v", `${out}:/out`]))) === 0;
			checked = built && (await run(docker, node(CHECK))) === 0;
		}
		const gitReady = checked && (await run(docker, node(GIT, ["-v", `${GIT_VOLUME}:/git`]))) === 0;
		const gitRuns = ["-e", `QORPERA_GIT_BIN=/git/${GIT_VERSION}/bin/git`, "-v", `${GIT_VOLUME}:/git:ro`];
		const served = gitReady && (await run(docker, node(E2E, [...FUSE, ...gitRuns]))) === 0;
		const testCode = await tested;
		closeSync(testLog);
		console.log("== folder-program: the unit and FUSE tests (ran beside)");
		process.stdout.write(readFileSync(join(work, "tests.log")));
		return served && testCode === 0;
	} finally {
		rmSync(work, { recursive: true, force: true });
		await run(docker, ["volume", "rm", out, ...(runner ? [] : [target])], "ignore");
		await pruned;
	}
}

/** Whether the build record names today's source: only then can a clean build match it. */
function sourceRecorded(root) {
	try {
		return readFolderProgramRecord(root).sourceSha256 === folderProgramSourceSha256(root);
	} catch {
		return false;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	process.exitCode = (await folderProgramStep()) ? 0 : 1;
