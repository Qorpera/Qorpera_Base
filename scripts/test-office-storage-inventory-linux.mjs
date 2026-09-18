import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-office-storage-inventory-linux.mjs");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image) throw new Error("Select a prepared local Linux Node image with QORPERA_OFFICE_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-inventory-linux-"));
try {
	const probe = join(temporary, "probe.mjs");
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-storage-inventory-probe.ts"], outfile: probe, platform: "node", format: "esm", target: "node22.19", bundle: true, logLevel: "silent" });
	for (const nested of [false, true]) {
		const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--cpus", "1", "--pids-limit", "64", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--user", "0:0", "--tmpfs", "/fixture:rw,nosuid,nodev,size=32m,mode=0755", "--tmpfs", "/review:rw,nosuid,nodev,size=1m,mode=0755", ...(nested ? ["--tmpfs", "/fixture/nested:rw,nosuid,nodev,size=1m,mode=0700"] : []), "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, image, "node", "/probe.mjs", ...(nested ? ["--nested"] : [])], { cwd: repository, stdio: "inherit", timeout: 60000 });
		if (result.status !== 0) throw new Error("Disposable office storage inventory proof failed");
	}
} finally { await rm(temporary, { recursive: true, force: true }); }
