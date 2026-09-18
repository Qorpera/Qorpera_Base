import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-company-computer-service-linux.mjs");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image) throw new Error("Select a prepared local Linux Node/setpriv image with QORPERA_OFFICE_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-service-linux-"));
function run(command, args) {
	const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", timeout: 60000 });
	if (result.status !== 0) throw new Error("Disposable office service probe failed");
}
try {
	const artifact = join(temporary, "artifact");
	run(process.execPath, ["scripts/package-company-computer.mjs", "--out", artifact]);
	// The packaging workspace is private; the image install directory is 0755.
	await chmod(artifact, 0o755);
	await build({ absWorkingDir: repository, entryPoints: ["packages/runtime/test/fixtures/company-computer-service-linux-probe.ts"], outfile: join(temporary, "probe.mjs"), platform: "node", format: "esm", target: "node22.19", bundle: true, logLevel: "silent" });
	run("docker", ["run", "--rm", "--network", "none", "--read-only", "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP"].flatMap((cap) => ["--cap-add", cap]),
		"--tmpfs", "/run:rw,nosuid,nodev,size=16m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
		"--mount", `type=bind,src=${artifact},dst=/artifact,readonly`, "--mount", `type=bind,src=${join(temporary, "probe.mjs")},dst=/probe.mjs,readonly`,
		image, "node", "/probe.mjs", "--prepare"]);
} finally { await rm(temporary, { recursive: true, force: true }); }
