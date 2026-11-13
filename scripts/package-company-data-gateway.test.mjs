import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "qorpera-company-data-gateway.mjs";

const freePort = () =>
	new Promise((done, fail) => {
		const server = net.createServer();
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});

test("packages the data gateway as one file with its sha256, and it runs with no node_modules", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-company-data-gateway-package-test-"));
	let child = null;
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-company-data-gateway.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		assert.deepEqual((await readdir(destination)).sort(), ["manifest.json", FILE, `${FILE}.sha256`]);
		const bytes = await readFile(join(destination, FILE));
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		assert.equal(await readFile(join(destination, `${FILE}.sha256`), "utf8"), `${sha256}  ${FILE}\n`);
		const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
		assert.equal(manifest.schema, "qorpera.company-data-gateway-package/v1");
		assert.deepEqual(manifest.artifacts, [{ file: FILE, bytes: bytes.byteLength, sha256 }]);
		// node-postgres as the repository pins it.
		const pinned = JSON.parse(await readFile(join(repositoryRoot, "packages/runtime/package.json"), "utf8")).dependencies.pg;
		assert.equal(manifest.pg, pinned);
		// The kit's entry, the gateway and node-postgres are inside; the drill's stand-in is not.
		const bundle = bytes.toString("utf8");
		// Checked with includes, so a failure never prints the whole bundle.
		for (const inside of ["data gateway: listening on", "qorpera_member_folder_read_many", "node_modules/pg/lib/client.js"])
			assert.ok(bundle.includes(inside), `the bundle holds ${inside}`);
		for (const outside of ["platform-standin", "stand-in"]) assert.ok(!bundle.includes(outside), `the bundle holds no ${outside}`);
		const imports = [...bundle.matchAll(/^import\s[^;\n]*from\s*["']([^"']+)["']/gm)].map((match) => match[1]);
		assert.deepEqual(imports.filter((name) => !name.startsWith("node:")), [], "the bundle imports nothing but node's own modules");

		// Alone in a folder with no node_modules beside or above it: it starts and answers.
		const alone = join(temporary, "alone");
		await mkdir(join(alone, "logins"), { recursive: true });
		await copyFile(join(destination, FILE), join(alone, FILE));
		for (const name of ["admin", "keeper", "watch"]) await writeFile(join(alone, "logins", name), "a-password\n");
		await writeFile(join(alone, "logins", "folder-key"), `${"ab".repeat(32)}\n`);
		const unset = spawnSync(process.execPath, [join(alone, FILE)], { cwd: alone, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 10_000 });
		assert.equal(unset.status, 2, unset.stderr);
		assert.match(unset.stderr, /DATA_LOGINS is not set/);
		const port = await freePort();
		child = spawn(process.execPath, [join(alone, FILE)], {
			cwd: alone,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				DATA_STORE_HOST: "127.0.0.1",
				DATA_STORE_PORT: "1",
				DATA_LOGINS: join(alone, "logins"),
				DATA_PLATFORM_URL: "http://127.0.0.1:1",
				DATA_PLATFORM_KEY: "test-key",
				DATA_LISTEN: `127.0.0.1:${port}`,
			},
		});
		let out = "";
		child.stdout.on("data", (part) => {
			out += part;
		});
		for (let attempt = 0; attempt < 100 && !out.includes("listening"); attempt++) await new Promise((done) => setTimeout(done, 50));
		assert.match(out, /listening on 127\.0\.0\.1:\d+, store 127\.0\.0\.1, secrets admin, folderKey, keeper, watch/);
		assert.doesNotMatch(out, /a-password|abab/);
		const answer = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(answer.status, 404);
		assert.deepEqual(await answer.json(), { error: "Not a call the data gateway answers" });

		const repeated = spawnSync(process.execPath, ["scripts/package-company-data-gateway.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		assert.notEqual(repeated.status, 0);
		assert.deepEqual(await readFile(join(destination, FILE)), bytes);
	} finally {
		child?.kill("SIGTERM");
		await rm(temporary, { recursive: true, force: true });
	}
});

test("refuses anything but --out and a new folder", () => {
	for (const args of [[], ["--out"], ["--outdir", "x"], ["--out", "x", "--extra"]]) {
		const refused = spawnSync(process.execPath, ["scripts/package-company-data-gateway.mjs", ...args], { cwd: repositoryRoot, encoding: "utf8" });
		assert.notEqual(refused.status, 0, args.join(" "));
		assert.match(refused.stderr, /--out <new-directory>/, args.join(" "));
	}
});
