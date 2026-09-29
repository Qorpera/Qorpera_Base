import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import {
	COMPANY_COMPUTER_CONTROLS,
	packageCompanyComputerControls,
	REPOSITORY,
	withControlFaults,
} from "./fixtures/company-computer-controls.ts";

it("keeps the recorded output of every packaged office control and the code package loader fixed as real Linux root", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "office-control-output-"));
	try {
		const controls = await packageCompanyComputerControls(temporary);
		const probe = join(temporary, "probe");
		await mkdir(probe);
		const staged = [];
		for (const control of controls) {
			await withControlFaults(control.file, join(probe, basename(control.file)), "/tmp/qorpera-test-child-fault");
			staged.push({ ...control, file: `/probe/${basename(control.file)}` });
		}
		await writeFile(join(probe, "controls.json"), JSON.stringify(staged));
		for (const [entry, output] of [
			["packages/runtime/test/fixtures/company-computer-control-output-probe.ts", "controls.mjs"],
			["packages/runner-orchestrator/test/fixtures/office-code-package-loader-probe.ts", "loader.mjs"],
		])
			await build({
				entryPoints: [join(REPOSITORY, entry)],
				outfile: join(probe, output),
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				logLevel: "silent",
			});
		const result = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"--pull=never",
				"--network",
				"none",
				"--user",
				"0:0",
				"--tmpfs",
				"/opt/qorpera-office:rw,nosuid,nodev,mode=0755,size=64m",
				"--tmpfs",
				"/run/qorpera-office-preparation:rw,nosuid,nodev,mode=0700,size=64m",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,mode=1777,size=64m",
				"-v",
				`${probe}:/probe:ro`,
				"node:22-bookworm-slim",
				"sh",
				"-c",
				"node /probe/controls.mjs && node /probe/loader.mjs",
			],
			{ encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 ** 2 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const lines = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.filter((line) => line.recordedOutput === "exact").map((line) => line.purpose)).toEqual(
			COMPANY_COMPUTER_CONTROLS.map(([purpose]) => purpose),
		);
		expect(lines).toContainEqual({ controls: 13, actualLinuxRoot: true, lockedChildOutputRecorded: false });
		expect(lines.filter((line) => line.toolOutputRecorded === false).map((line) => line.scenario)).toEqual([
			"noisy-tool-success",
			"noisy-tool-refusal",
			"tool-uncaught-exception",
			"tool-unhandled-rejection",
			"tool-top-level-throw",
		]);
		expect(lines).toContainEqual({
			scenario: "real-kernel-flock-contention",
			actualLinux: true,
			topLevelExecutionDenied: true,
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}, 300000);
