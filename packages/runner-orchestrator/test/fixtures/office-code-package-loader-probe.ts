import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { OFFICE_CODE_PACKAGE_LOADER } from "../../src/lxd-office-code-package-loader.ts";

const root = "/run/qorpera-office-preparation",
	id = "11111111-1111-4111-8111-111111111111",
	stage = `${root}/code-package-${id}`,
	marker = "/tmp/loader-side-effect";
const bytes = Buffer.from(
	`require('node:fs').writeFileSync('${marker}','top-level executed');exports.runOfficeCodePackageTool=()=>{};`,
);
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const sha = hash(bytes);
function setup(tool = bytes) {
	rmSync(stage, { recursive: true, force: true });
	rmSync(marker, { force: true });
	rmSync("/tmp/loader-link", { force: true });
	chmodSync(root, 0o700);
	mkdirSync(stage, { mode: 0o700 });
	writeFileSync(`${stage}/bootstrap.cjs`, tool, { mode: 0o400 });
	writeFileSync(`${stage}/measure.cjs`, tool, { mode: 0o400 });
	writeFileSync(`${root}/control.lock`, "", { mode: 0o600 });
}
function invoke(args: string[] = ["bootstrap", id, sha, String(bytes.length)]) {
	return spawnSync("/usr/bin/node", ["-e", OFFICE_CODE_PACKAGE_LOADER, ...args], {
		cwd: "/",
		env: {},
		encoding: "utf8",
		timeout: 10000,
	});
}
/** LXD records the loader's stdout/stderr on the host: nothing on success,
 * exactly one fixed line on any refusal, never tool output. */
function recorded(scenario: string, result: SpawnSyncReturns<string>, accepted: boolean) {
	assert.equal(result.stdout, "", `${scenario}: stdout`);
	assert.equal(result.stderr, accepted ? "" : "OFFICE_CODE_PACKAGE_LOADER_UNCONFIRMED\n", `${scenario}: stderr`);
}
function denied(scenario: string, args?: string[]) {
	const result = invoke(args);
	assert.notEqual(result.status, 0, `${scenario}: loader unexpectedly accepted`);
	recorded(scenario, result, false);
	assert.equal(existsSync(marker), false, `${scenario}: top-level tool side effect executed before refusal`);
	console.log(JSON.stringify({ scenario, actualLinux: true, topLevelExecutionDenied: true }));
}
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
setup();
const bootstrap = invoke();
assert.equal(bootstrap.status, 0);
recorded("verified-bootstrap", bootstrap, true);
assert.equal(existsSync(marker), true);
console.log(JSON.stringify({ scenario: "verified-bootstrap", actualLinux: true, executionConfirmed: true }));
setup();
const measure = invoke(["measure", id, sha, String(bytes.length)]);
assert.equal(measure.status, 0);
recorded("verified-measure", measure, true);
assert.equal(existsSync(marker), true);
console.log(JSON.stringify({ scenario: "verified-measure", actualLinux: true, executionConfirmed: true }));
// The locked child holds the protected packet. Whatever it writes, throws or
// rejects, the recorded loader output stays empty or the one fixed line.
const secret = "protected-request-and-credential-bytes";
const noise = `const fs=require('node:fs');for(const write of [console.log,console.error,console.warn,(m)=>process.stdout.write(m),(m)=>process.stderr.write(m),(m)=>fs.writeSync(1,m),(m)=>fs.writeSync(2,m),(m)=>process.emitWarning(m)])write('${secret}');`;
for (const [scenario, source] of Object.entries({
	"noisy-tool-success": `${noise}exports.runOfficeCodePackageTool=async()=>{${noise}};`,
	"noisy-tool-refusal": `${noise}exports.runOfficeCodePackageTool=async()=>{${noise}throw new Error('${secret}');};`,
	"tool-uncaught-exception": `exports.runOfficeCodePackageTool=()=>{setImmediate(()=>{throw new Error('${secret}');});return new Promise(()=>{});};`,
	"tool-unhandled-rejection": `exports.runOfficeCodePackageTool=async()=>{Promise.reject(new Error('${secret}'));};`,
	"tool-top-level-throw": `${noise}throw new Error('${secret}');`,
})) {
	const tool = Buffer.from(source);
	setup(tool);
	const result = invoke(["bootstrap", id, hash(tool), String(tool.length)]);
	const accepted = scenario === "noisy-tool-success";
	assert.equal(result.status, accepted ? 0 : 1, scenario);
	recorded(scenario, result, accepted);
	console.log(JSON.stringify({ scenario, actualLinux: true, toolOutputRecorded: false }));
}
for (const scenario of [
	"wrong-hash",
	"wrong-size",
	"overflow",
	"writable-tool",
	"foreign-owner",
	"symlink-tool",
	"hardlink-tool",
	"fifo-tool",
	"writable-root",
	"writable-stage",
	"symlink-stage",
	"invalid-purpose",
	"invalid-id",
	"forged-locked",
] as const) {
	setup();
	let args: string[] | undefined;
	if (scenario === "wrong-hash") args = ["bootstrap", id, "0".repeat(64), String(bytes.length)];
	if (scenario === "wrong-size") args = ["bootstrap", id, sha, String(bytes.length + 1)];
	if (scenario === "overflow") args = ["bootstrap", id, sha, String(16 * 1024 ** 2 + 1)];
	if (scenario === "writable-tool") chmodSync(`${stage}/bootstrap.cjs`, 0o600);
	if (scenario === "foreign-owner") chownSync(`${stage}/bootstrap.cjs`, 1000, 1000);
	if (scenario === "symlink-tool") {
		rmSync(`${stage}/bootstrap.cjs`);
		symlinkSync(`${stage}/measure.cjs`, `${stage}/bootstrap.cjs`);
	}
	if (scenario === "hardlink-tool") linkSync(`${stage}/bootstrap.cjs`, `${stage}/hardlink.cjs`);
	if (scenario === "fifo-tool") {
		rmSync(`${stage}/bootstrap.cjs`);
		assert.equal(spawnSync("mkfifo", ["-m", "400", `${stage}/bootstrap.cjs`]).status, 0);
	}
	if (scenario === "writable-root") chmodSync(root, 0o722);
	if (scenario === "writable-stage") chmodSync(stage, 0o722);
	if (scenario === "symlink-stage") {
		rmSync(stage, { recursive: true });
		symlinkSync("/tmp", stage);
	}
	if (scenario === "invalid-purpose") args = ["other", id, sha, String(bytes.length)];
	if (scenario === "invalid-id") args = ["bootstrap", "../../tmp", sha, String(bytes.length)];
	if (scenario === "forged-locked") args = ["bootstrap", id, sha, String(bytes.length), "--locked"];
	denied(scenario, args);
}
setup();
const unlocked = openSync(`${root}/control.lock`, "r+");
try {
	const result = spawnSync(
		"/usr/bin/node",
		["-e", OFFICE_CODE_PACKAGE_LOADER, "bootstrap", id, sha, String(bytes.length), "--locked"],
		{ cwd: "/", env: {}, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe", unlocked] },
	);
	assert.notEqual(result.status, 0, "unlocked inherited descriptor was accepted");
	recorded("unlocked-inherited-descriptor", result, false);
	assert.equal(existsSync(marker), false, "unlocked descriptor allowed top-level execution");
	console.log(
		JSON.stringify({ scenario: "unlocked-inherited-descriptor", actualLinux: true, topLevelExecutionDenied: true }),
	);
} finally {
	closeSync(unlocked);
}
setup();
const holder = spawn(
	"/usr/bin/flock",
	["--exclusive", `${root}/control.lock`, "/usr/bin/node", "-e", "console.log('held');setTimeout(()=>{},15000)"],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
try {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("flock fixture timeout")), 3000);
		holder.once("error", reject);
		holder.stdout.once("data", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	denied("real-kernel-flock-contention");
} finally {
	holder.kill("SIGKILL");
}
