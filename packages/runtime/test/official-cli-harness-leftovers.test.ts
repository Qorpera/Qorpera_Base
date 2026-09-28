import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const writers: number[] = [];
const mouth = { url: "http://127.0.0.1:1/mcp", bearerToken: "m".repeat(43) };

afterEach(async () => {
	for (const pid of writers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already stopped.
		}
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

/** Like Codex's plugin sync `git fetch`: keeps adding files to its clone until the clone is gone. */
const LEFTOVER_WRITER = [
	'const fs = require("node:fs");',
	'const path = require("node:path");',
	"const [directory, pidFile] = process.argv.slice(1);",
	"fs.mkdirSync(directory, { recursive: true });",
	'fs.writeFileSync(path.join(directory, "object-0"), "x");',
	"fs.writeFileSync(pidFile, String(process.pid));",
	"const until = Date.now() + 10_000;",
	"let count = 1;",
	"setInterval(() => {",
	"  if (Date.now() > until) process.exit(0);",
	"  try {",
	'    fs.writeFileSync(path.join(directory, "object-" + count++), "x");',
	"  } catch {",
	"    process.exit(0);",
	"  }",
	"}, 2);",
].join("\n");

/** A stand-in for `codex exec`: `node exec ...` runs this file from the company root. */
async function fakeCodex(company: string, options: { leaveWriter: boolean }): Promise<string> {
	const pidFile = join(company, "writer.pid");
	await writeFile(
		join(company, "exec"),
		[
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			`fs.writeFileSync(${JSON.stringify(join(company, "argv.json"))}, JSON.stringify(process.argv.slice(2)));`,
			"const finish = () => {",
			'  console.log(JSON.stringify({ type: "thread.started", thread_id: "leftover-thread" }));',
			'  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));',
			"  process.exit(0);",
			"};",
			"process.stdin.resume();",
			'process.stdin.on("end", () => {',
			`  if (!${options.leaveWriter}) return finish();`,
			'  const clone = path.join(process.env.CODEX_HOME, ".tmp", "plugins-clone-x", ".git");',
			`  spawn(process.execPath, ["-e", ${JSON.stringify(LEFTOVER_WRITER)}, clone, ${JSON.stringify(pidFile)}], { stdio: "ignore" });`,
			`  const started = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(started); finish(); } }, 5);`,
			"});",
		].join("\n"),
		"utf-8",
	);
	return pidFile;
}

function execute(identity: string, company: string): Promise<{ providerSessionId?: string }> {
	return new OfficialCliNativeHarnessDriver(process.execPath, process.execPath).execute({
		mouth,
		harness: "codex-cli",
		model: "gpt-test",
		identityRoot: identity,
		companyRoot: company,
		prompt: "canonical transcript",
	});
}

it("starts Codex with its plugin startup sync switched off", async () => {
	const identity = await temporaryRoot("qorpera-harness-leftovers-identity-");
	const company = await temporaryRoot("qorpera-harness-leftovers-company-");
	await fakeCodex(company, { leaveWriter: false });
	await expect(execute(identity, company)).resolves.toEqual({ providerSessionId: "leftover-thread" });
	const args = JSON.parse(await readFile(join(company, "argv.json"), "utf-8")) as string[];
	expect(args.some((arg, index) => arg === "features.plugins=false" && args[index - 1] === "-c")).toBe(true);
});

it.skipIf(process.platform === "win32")(
	"stops what the harness left writing into the Codex home before the identity root is removed",
	async () => {
		const identity = await temporaryRoot("qorpera-harness-leftovers-identity-");
		const company = await temporaryRoot("qorpera-harness-leftovers-company-");
		const pidFile = await fakeCodex(company, { leaveWriter: true });
		await expect(execute(identity, company)).resolves.toEqual({ providerSessionId: "leftover-thread" });
		writers.push(Number(await readFile(pidFile, "utf-8")));
		const clone = join(identity, "codex", ".tmp", "plugins-clone-x", ".git");
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		const written = (await readdir(clone)).length;
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		expect((await readdir(clone)).length).toBe(written);
		// The plain removal that raced the leftover writer (ENOTEMPTY on the clone's .git).
		await rm(identity, { recursive: true, force: true });
		await expect(lstat(identity)).rejects.toMatchObject({ code: "ENOENT" });
	},
);
