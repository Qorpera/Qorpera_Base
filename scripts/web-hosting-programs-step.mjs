import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheKey, cacheRunner } from "./folder-program-step.mjs";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WEB_HOSTING_CRATES = ["crates/qorpera-web-router", "crates/qorpera-app-host"];

const TARGET = "/tmp/target";
const RUNNER_DAYS = 2;
const LEFTOVER_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL = "qorpera.web-hosting-target";
const STAMPS = 'for d in /v/*; do echo "${d#/v/} $(stat -c %Y "$d/.qorpera-used" 2>/dev/null || echo 0)"; done';

function run(docker, args, output = "inherit") {
	return new Promise((done) => {
		const child = spawn(docker, args, { stdio: ["ignore", output, output] });
		child.on("error", () => done(127));
		child.on("exit", (code) => done(code ?? 1));
	});
}

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

export async function pruneWebHostingVolumes(docker, own, now = Date.now()) {
	const listed = await capture(docker, ["volume", "ls", "-q", "--filter", "name=qorpera-web-hosting-target-"]);
	if (listed.code !== 0) return;
	const names = listed.stdout.split("\n").filter(Boolean);
	const old = [];
	const runners = names.filter((name) => /^qorpera-web-hosting-target-ci[0-9]+$/.test(name) && name !== own);
	if (runners.length > 0) {
		const mounts = runners.flatMap((name) => ["-v", `${name}:/v/${name}:ro`]);
		const stamps = await capture(docker, ["run", "--rm", ...mounts, RUST_IMAGE, "sh", "-c", STAMPS]);
		for (const [name, seconds] of stamps.stdout.split("\n").map((line) => line.split(" ")))
			if (runners.includes(name) && now - Number(seconds) * 1000 > RUNNER_DAYS * DAY_MS) old.push(name);
	}
	const leftovers = names.filter((name) => /^qorpera-web-hosting-target-run-[0-9][0-9-]*$/.test(name));
	if (leftovers.length > 0) {
		const made = await capture(docker, ["volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}", ...leftovers]);
		for (const line of made.stdout.split("\n")) {
			const name = line.split(" ")[0];
			const created = Date.parse(line.slice(name.length + 1));
			if (leftovers.includes(name) && now - created > LEFTOVER_DAYS * DAY_MS) old.push(name);
		}
	}
	for (const name of old)
		if ((await capture(docker, ["volume", "rm", name])).code === 0)
			console.log(`== web-hosting-programs: removed the unused volume ${name}`);
}

export async function removeLeftWebHostingContainers(docker, target) {
	const listed = await capture(docker, ["ps", "-aq", "--filter", `label=${LABEL}=${target}`]);
	if (listed.code !== 0) return false;
	const ids = listed.stdout.split("\n").filter(Boolean);
	if (ids.length === 0) return true;
	console.log(`== web-hosting-programs: removing ${ids.length} container(s) a killed run left on ${target}`);
	return (await capture(docker, ["rm", "-f", ...ids])).code === 0;
}

export async function webHostingProgramsStep({
	root = repository,
	docker = "docker",
	status = existsSync(join(root, ".run-on-node-status")) ? readFileSync(join(root, ".run-on-node-status"), "utf8") : "",
	user = userInfo().username,
	now = Date.now(),
} = {}) {
	const runner = cacheRunner(status, user);
	const target = runner ? `qorpera-web-hosting-target-${runner}` : `qorpera-web-hosting-target-run-${now}-${process.pid}`;
	const pruned = pruneWebHostingVolumes(docker, target, now);
	const work = mkdtempSync(join(tmpdir(), "qorpera-web-hosting-step-"));
	try {
		if (!(await removeLeftWebHostingContainers(docker, target))) {
			console.log(`== web-hosting-programs: the containers a killed run left on ${target} could not be removed`);
			return false;
		}
		const jobs = WEB_HOSTING_CRATES.map((crate) => {
			const pkg = basename(crate);
			const crateDir = join(root, crate);
			const key = cacheKey(crateDir);
			const subTarget = `${TARGET}/${pkg}`;
			const logPath = join(work, `${pkg}.log`);
			const logFd = openSync(logPath, "w");
			const script = [
				`mkdir -p ${subTarget}`,
				`if [ "$(cat ${subTarget}/.qorpera-key 2>/dev/null)" = "$KEY" ]; then cargo clean --locked -p ${pkg}; else find ${subTarget} -mindepth 1 -delete && echo "$KEY" >${subTarget}/.qorpera-key; fi`,
				`touch ${TARGET}/.qorpera-used`,
				"cargo test --locked",
			].join(" && ");
			const started = Date.now();
			const promise = run(
				docker,
				[
					"run",
					"--rm",
					"--label",
					`${LABEL}=${target}`,
					"-e",
					`KEY=${key}`,
					"-e",
					`CARGO_TARGET_DIR=${subTarget}`,
					"-v",
					"qorpera-cargo-registry:/usr/local/cargo/registry",
					"-v",
					`${crateDir}:/src:ro`,
					"-v",
					`${target}:${TARGET}`,
					"-w",
					"/src",
					RUST_IMAGE,
					"sh",
					"-c",
					script,
				],
				logFd,
			).then((code) => {
				closeSync(logFd);
				return { crate, logPath, code, seconds: ((Date.now() - started) / 1000).toFixed(1) };
			});
			return promise;
		});
		const results = await Promise.all(jobs);
		let ok = true;
		for (const result of results) {
			console.log(`== web-hosting-programs: testing ${result.crate}`);
			process.stdout.write(readFileSync(result.logPath));
			if (result.code !== 0) {
				console.log(`== web-hosting-programs: ${result.crate} FAILED (${result.code}) after ${result.seconds} s`);
				ok = false;
			} else {
				console.log(`== web-hosting-programs: ${result.crate} passed in ${result.seconds} s`);
			}
		}
		return ok;
	} finally {
		rmSync(work, { recursive: true, force: true });
		if (!runner) await run(docker, ["volume", "rm", target], "ignore");
		await pruned;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = (await webHostingProgramsStep()) ? 0 : 1;
}
