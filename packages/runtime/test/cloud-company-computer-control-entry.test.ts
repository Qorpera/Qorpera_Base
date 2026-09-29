import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	COMPANY_COMPUTER_CONTROLS,
	CONTROL_FAULT_SECRET,
	type PackagedCompanyComputerControl,
	packageCompanyComputerControls,
	REPOSITORY,
	withControlFaults,
} from "./fixtures/company-computer-controls.ts";

/** Runs like LXD does: empty environment, root directory, both streams captured. */
function run(file: string, args: readonly string[], env: Record<string, string> = {}) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((done, fail) => {
		const child = spawn(process.execPath, [file, ...args], {
			cwd: "/",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", fail);
		child.once("close", (status) => done({ status, stdout, stderr }));
	});
}

const commandId = "11111111-1111-4111-8111-111111111111",
	requestSha256 = "a".repeat(64),
	bootId = "22222222-2222-4222-8222-222222222222",
	inspectionId = "33333333-3333-4333-8333-333333333333";
/** The exact argument shapes the provider submits for each control. */
function providerArgs(purpose: PackagedCompanyComputerControl["purpose"]): string[][] {
	const command = [commandId, requestSha256, bootId];
	if (purpose === "install") return [[...command, "b".repeat(64), "c".repeat(64)]];
	if (purpose === "measure") return [[...command, "b".repeat(64)]];
	return ["preparation", "configuration", "boot-configuration", "reset-configuration"].includes(purpose)
		? [command]
		: [command, [...command, inspectionId]];
}

let directory: string;
let controls: PackagedCompanyComputerControl[];
const fixture = { entry: "", other: "", imposter: "" };
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "office-control-entry-"));
	controls = await packageCompanyComputerControls(directory);
	await mkdir(join(directory, "faulted"));
	await mkdir(join(directory, "fixture"));
	await mkdir(join(directory, "imposter"));
	fixture.entry = join(directory, "fixture", "qorpera-company-computer-fixture-control.mjs");
	fixture.other = join(directory, "fixture", "other-control.mjs");
	fixture.imposter = join(directory, "imposter", "qorpera-company-computer-fixture-control.mjs");
	const options = { bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" } as const;
	await build({
		...options,
		entryPoints: [join(REPOSITORY, "packages/runtime/test/fixtures/company-computer-control-entry-fixture.ts")],
		outfile: fixture.entry,
	});
	await build({
		...options,
		stdin: {
			contents: 'import "./company-computer-control-entry-fixture.ts"; console.log("not an office control");',
			resolveDir: join(REPOSITORY, "packages/runtime/test/fixtures"),
			loader: "ts",
		},
		outfile: fixture.other,
	});
	await writeFile(fixture.imposter, `import ${JSON.stringify(pathToFileURL(fixture.entry).href)};\n`);
}, 180000);
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("shared office control entry", () => {
	const failure = "Fixture office control could not confirm its request.\n";
	it("writes nothing on success, whatever the work tried to print", async () => {
		for (const scenario of ["noisy-success", "awaited-write", "ended-streams"])
			expect(await run(fixture.entry, [scenario])).toEqual({ status: 0, stdout: "", stderr: "" });
	});

	it.each([
		["noisy-refusal"],
		["ended-streams-refusal"],
		["synchronous-throw"],
		["uncaught-exception"],
		["uncaught-after-success"],
		["unhandled-rejection"],
		["refusal-then-uncaught"],
		["unknown"],
	])("writes exactly the fixed line once for %s", async (scenario) => {
		expect(await run(fixture.entry, [scenario])).toEqual({ status: 1, stdout: "", stderr: failure });
	});

	it("refuses provider-supplied bytes without echoing them", async () => {
		expect(await run(fixture.entry, ["--config", CONTROL_FAULT_SECRET])).toEqual({
			status: 1,
			stdout: "",
			stderr: failure,
		});
	});

	it("writes only the fixed help line for --help", async () => {
		expect(await run(fixture.entry, ["--help"])).toEqual({
			status: 0,
			stdout: "Fixture office control.\n",
			stderr: "",
		});
	});

	it("leaves a process that is not the control alone", async () => {
		expect(await run(fixture.other, ["noisy-refusal"])).toEqual({
			status: 0,
			stdout: "not an office control\n",
			stderr: "",
		});
	});

	it("refuses a file that borrows the control's name", async () => {
		expect(await run(fixture.imposter, ["noisy-success"])).toEqual({ status: 1, stdout: "", stderr: failure });
	});
});

describe("packaged office controls under failure injection", () => {
	it.each(COMPANY_COMPUTER_CONTROLS.map(([purpose]) => [purpose]))(
		"%s writes only its fixed line on every refusal and fault",
		async (purpose) => {
			const control = controls.find((candidate) => candidate.purpose === purpose)!;
			const faulted = join(directory, "faulted", control.file.split("/").at(-1)!);
			// Never created here: only the Linux probe drives the locked child's faults.
			await withControlFaults(control.file, faulted, join(directory, "child-fault"));
			const refusal = { status: 1, stdout: "", stderr: `${control.failure}\n` };
			const shaped = providerArgs(purpose);
			const cases: Array<[string, string[], Record<string, string>]> = [
				["no arguments", [], {}],
				["unexpected argument", ["unexpected"], {}],
				["provider bytes", ["--config", CONTROL_FAULT_SECRET], {}],
				["forged locked child", ["--locked", ...shaped[0]], {}],
				...shaped.map((args): [string, string[], Record<string, string>] => [
					`provider command ${args.length}`,
					args,
					{},
				]),
				...["noise", "uncaught", "unhandled"].map((fault): [string, string[], Record<string, string>] => [
					`${fault} in the recorded process`,
					shaped[0],
					{ QORPERA_TEST_OUTER_FAULT: fault },
				]),
			];
			const results = await Promise.all(
				cases.map(async ([name, args, env]) => [name, await run(faulted, args, env)] as const),
			);
			for (const [name, result] of results) expect({ name, ...result }).toEqual({ name, ...refusal });
			const help = await run(control.file, ["--help"]);
			expect(help.status).toBe(0);
			expect(help.stderr).toBe("");
			expect(help.stdout).toMatch(/^[A-Z][^\n]+\.\n$/);
		},
		60000,
	);
});
