import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-office-adoption-files-linux.mjs");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image) throw new Error("Select a prepared local Linux Node image with QORPERA_OFFICE_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-adoption-linux-"));
try {
	const probe = join(temporary, "probe.mjs");
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-adoption-files-probe.ts"], outfile: probe, platform: "node", format: "esm", target: "node22.19", bundle: true, logLevel: "silent" });
	for (const scenario of ["normal", "empty", "quarantine-profile", "unlocked", "revoked", "review-unsafe", "source-change", "kill-temporary", "kill-promoted", "kill-result", "target-change", "journal-loss", "maintenance-unsafe", "maintenance-owner", "maintenance-missing", "maintenance-changed"]) {
		const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--cpus", "1", "--pids-limit", "64", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--user", "0:0", "--tmpfs", "/fixture:rw,nosuid,nodev,size=16m,mode=0755", "--tmpfs", "/journal:rw,nosuid,nodev,size=16m,mode=0755", "--tmpfs", "/review:rw,nosuid,nodev,size=4m,mode=0755", "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, image, "node", "/probe.mjs", "--parent", scenario], { cwd: repository, stdio: "inherit", timeout: 60000 });
		if (result.status !== 0) throw new Error(`Disposable office adoption proof failed: ${scenario}`);
	}
} finally { await rm(temporary, { recursive: true, force: true }); }
