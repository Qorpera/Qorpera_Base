import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Enough of an x86-64 ELF header for the packager's check. */
function fakeProgram() {
	const bytes = Buffer.alloc(64);
	bytes.write("\x7fELF", 0, "latin1");
	bytes.writeUInt16LE(62, 18);
	return bytes;
}

function packageInto(destination, program) {
	return spawnSync(
		process.execPath,
		["scripts/package-folder-service.mjs", "--out", destination, "--folder-program", program],
		{ cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
	);
}

test("packages the folder service, the folder program, the units and the installers with their hashes", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-folder-package-test-"));
	try {
		const program = join(temporary, "qorpera-folder");
		await writeFile(program, fakeProgram());
		const destination = join(temporary, "package");
		const packaged = packageInto(destination, program);
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(JSON.parse(packaged.stdout).manifestSha256, sha256(encoded));
		assert.equal(manifest.schema, "qorpera.folder-service-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((a) => a.file),
			[
				"qorpera-folder-service.cjs",
				"qorpera-folder",
				"qorpera-folder-service.socket",
				"qorpera-folder-control.socket",
				"qorpera-folder-service.service",
				"qorpera-folder-bridge.service",
				"install-folder-service.sh",
				"README.md",
			],
		);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes, artifact.file);
			assert.equal(sha256(bytes), artifact.sha256, artifact.file);
		}
		assert.equal((await stat(join(destination, "qorpera-folder"))).mode & 0o777, 0o755);
		const checked = spawnSync(process.execPath, ["--check", join(destination, "qorpera-folder-service.cjs")], { encoding: "utf8" });
		assert.equal(checked.status, 0, checked.stderr);
		// Outside systemd it refuses to start. It loads under the unit's --jitless (no WebAssembly) to get there.
		const unconfigured = spawnSync(process.execPath, ["--jitless", join(destination, "qorpera-folder-service.cjs")], {
			encoding: "utf8",
			env: { PATH: process.env.PATH },
		});
		assert.notEqual(unconfigured.status, 0);
		assert.match(unconfigured.stderr, /CREDENTIALS_DIRECTORY is not set/);

		// The installers' pins are the units' hashes.
		const pins = {
			"install-folder-service.sh": {
				EXPECTED_SOCKET_UNIT_SHA256: "qorpera-folder-service.socket",
				EXPECTED_CONTROL_SOCKET_UNIT_SHA256: "qorpera-folder-control.socket",
				EXPECTED_SERVICE_UNIT_SHA256: "qorpera-folder-service.service",
				EXPECTED_BRIDGE_UNIT_SHA256: "qorpera-folder-bridge.service",
			},
		};
		for (const [installer, expected] of Object.entries(pins)) {
			const script = await readFile(join(destination, installer), "utf8");
			for (const [name, unit] of Object.entries(expected)) {
				const pin = script.match(new RegExp(`^${name}="([0-9a-f]{64})"$`, "m"))?.[1];
				assert.equal(pin, sha256(await readFile(join(destination, unit))), `${installer} ${name}`);
			}
			assert.equal(spawnSync("bash", ["-n", join(destination, installer)]).status, 0, installer);
		}
		// The save check reads coding machines' git packs with the node's git under prlimit (F3 5j-5): no git, no install.
		const installer = await readFile(join(destination, "install-folder-service.sh"), "utf8");
		assert.match(installer, /^for tool in \/usr\/bin\/git \/usr\/bin\/prlimit; do$/m);

		const service = await readFile(join(destination, "qorpera-folder-service.service"), "utf8");
		for (const line of ["ProtectSystem=strict", "NoNewPrivileges=yes", "LimitCORE=0", "CapabilityBoundingSet=", "MemoryDenyWriteExecute=yes"])
			assert.match(service, new RegExp(`^${line}$`, "m"));
		assert.match(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
		assert.match(service, /^ExecStart=\/usr\/bin\/node --jitless \/opt\/qorpera-folder-service\/qorpera-folder-service\.cjs$/m);
		assert.ok(!/SupplementaryGroups/.test(service), "the service never holds LXD's group");
		assert.match(service, /^StartLimitIntervalSec=0$/m);
		assert.match(service, /^LoadCredential=qorpera-supabase-service-key:\/etc\/qorpera-folder-service\/supabase-key$/m);
		assert.match(service, /^RequiresMountsFor=\/srv\/qorpera\/canonical$/m);
		const bridge = await readFile(join(destination, "qorpera-folder-bridge.service"), "utf8");
		// LXD knows the bridge by its own client certificate on the pinned loopback listener, never by the socket's group.
		assert.match(bridge, /^RestrictAddressFamilies=AF_UNIX AF_VSOCK AF_INET$/m);
		assert.match(bridge, /^IPAddressDeny=any$/m);
		assert.match(bridge, /^IPAddressAllow=localhost$/m);
		assert.match(bridge, / --lxd-https \/etc\/qorpera-lxd-ids$/m);
		assert.ok(!/SupplementaryGroups|lxd-socket/.test(bridge), "the bridge never holds LXD's group");
		assert.ok(!/LoadCredential/.test(bridge), "the bridge holds no credential");
		const socket = await readFile(join(destination, "qorpera-folder-service.socket"), "utf8");
		assert.match(socket, /^SocketMode=0660$/m);
		assert.match(socket, /^SocketGroup=qorpera-folder-bridge$/m);
		// The control socket: the coding executor's alone (control.ts checks the same), told apart by its name.
		const control = await readFile(join(destination, "qorpera-folder-control.socket"), "utf8");
		assert.match(control, /^ListenStream=\/run\/qorpera-folder-control\/control\.sock$/m);
		assert.match(control, /^SocketUser=qorpera-coding-executor$/m);
		assert.match(control, /^SocketMode=0600$/m);
		assert.match(control, /^DirectoryMode=0755$/m);
		assert.match(control, /^FileDescriptorName=control$/m);
		assert.match(control, /^Service=qorpera-folder-service\.service$/m);
		assert.match(service, /^TimeoutStopSec=60s$/m);
		// The clean stop's note (clean-stop.ts) outlives every stop and start, a restart's included, and is the service's
		// alone.
		assert.match(service, /^RuntimeDirectory=qorpera-folder-service$/m);
		assert.match(service, /^RuntimeDirectoryMode=0700$/m);
		assert.match(service, /^RuntimeDirectoryPreserve=yes$/m);
		// The mount unit ships in the shared-execution package; it must land in PID 1's mount namespace.
		const mount = await readFile(join(repositoryRoot, "deploy/folder-service/qorpera-folder-mount@.service"), "utf8");
		for (const option of ["ProtectSystem", "PrivateTmp", "PrivateDevices", "ProtectHome", "ReadWritePaths", "InaccessiblePaths"])
			assert.ok(!new RegExp(`^${option}=`, "m").test(mount), option);
		assert.match(mount, /^RestartPreventExitStatus=3$/m);
		assert.match(mount, /^DeviceAllow=\/dev\/fuse rw$/m);
		assert.ok(!/allow-other/.test(mount), "step 1 serves only root");

		// No overwrite.
		assert.notEqual(packageInto(destination, program).status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("the core client's transport works under --jitless, where fetch does not", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-folder-jitless-test-"));
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ method: request.method, body, apikey: request.headers.apikey }));
		});
	});
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const entry = join(temporary, "entry.ts");
		const transport = join(repositoryRoot, "packages/object-gateway/src/folder-service/https-request.ts");
		await writeFile(
			entry,
			`import { nodeRequest } from ${JSON.stringify(transport)};
void (async () => {
	const answer = await nodeRequest(new URL(process.argv[2]!), { method: "POST", headers: { apikey: "k" }, body: "{}" }, 1024, new AbortController().signal);
	process.stdout.write(answer.status + " " + answer.body.toString());
})();
`,
		);
		await build({
			entryPoints: [entry],
			outfile: join(temporary, "entry.cjs"),
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node22.19",
			logLevel: "silent",
		});
		const url = `http://127.0.0.1:${server.address().port}/rest/v1/rpc/x`;
		// Asynchronous children: they call this process's server.
		const run = await promisify(execFile)(process.execPath, ["--jitless", join(temporary, "entry.cjs"), url], {
			timeout: 20_000,
		});
		assert.equal(run.stdout, '200 {"method":"POST","body":"{}","apikey":"k"}');
		const fetched = await promisify(execFile)(
			process.execPath,
			["--jitless", "-e", `fetch(${JSON.stringify(url)}).then(() => console.log("ok"), () => console.log("failed"))`],
			{ timeout: 20_000 },
		);
		assert.equal(fetched.stdout.trim(), "failed", "fetch works under --jitless now; the transport could go back to it");
	} finally {
		server.close();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("refuses a folder program that is not an x86-64 Linux build", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-folder-package-test-"));
	try {
		const program = join(temporary, "qorpera-folder");
		await writeFile(program, "#!/bin/sh\n");
		const refused = packageInto(join(temporary, "package"), program);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /x86-64 Linux build/);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
