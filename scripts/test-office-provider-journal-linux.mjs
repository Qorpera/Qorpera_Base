import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preparation = process.argv.length === 3 && process.argv[2] === "--preparation";
const configuration = process.argv.length === 3 && process.argv[2] === "--configuration";
const serviceStart = process.argv.length === 3 && process.argv[2] === "--service-start";
if (process.argv.length !== 2 && !preparation && !configuration && !serviceStart) throw new Error("Usage: node scripts/test-office-provider-journal-linux.mjs [--preparation | --configuration | --service-start]");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image) throw new Error("Select a prepared local Linux Node image with QORPERA_OFFICE_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-journal-linux-"));
try {
	const probe = join(temporary, "probe.mjs");
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-operation-crash-probe.ts"], outfile: probe, platform: "node", format: "esm", target: "node22.19", bundle: true, logLevel: "silent" });
	const result = spawnSync("docker", ["run", "--platform", "linux/amd64", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "1000:1000", "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
		"--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, image, "node", "/probe.mjs", ...(serviceStart ? ["--service-start"] : configuration ? ["--configuration"] : preparation ? ["--preparation"] : [])],
		{ cwd: repository, stdio: "inherit", timeout: 60000 });
	if (result.status !== 0) throw new Error("Disposable office operation crash proof failed");
} finally { await rm(temporary, { recursive: true, force: true }); }
