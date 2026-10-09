import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the agent exit's rules reader with its unit and the database's CA", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-agent-exit-rules-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-agent-exit-rules.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.agent-exit-rules-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", "supabase-prod-ca-2021.crt"],
		);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		for (const [file, source] of [
			["qorpera-agent-exit-rules.service", "deploy/agent-exit/qorpera-agent-exit-rules.service"],
			["supabase-prod-ca-2021.crt", "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"],
		])
			assert.deepEqual(await readFile(join(destination, file)), await readFile(join(repositoryRoot, source)));
		const executable = join(destination, "qorpera-agent-exit-rules.mjs");
		const bundle = await readFile(executable, "utf8");
		// The reader alone: no broker, vault or service-role key rides along.
		assert.ok(!bundle.includes("CloudSecretBroker"));
		assert.ok(!bundle.includes("SUPABASE_SERVICE_ROLE"));
		assert.ok(bundle.includes("public.qorpera_agent_exit_network_rules($1::uuid[])"));
		const syntax = spawnSync(process.execPath, ["--check", executable], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
		const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /Agent exit rules reader\. Requires private systemd credentials/);
		// Started without its credentials it stops with one line that names nothing.
		const bare = spawnSync(process.execPath, [executable], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			timeout: 10_000,
		});
		assert.equal(bare.status, 1);
		assert.equal(bare.stderr, "Agent exit rules reader could not start; inspect its credentials.\n");
		const service = await readFile(join(destination, "qorpera-agent-exit-rules.service"), "utf8");
		for (const line of [
			"DynamicUser=yes",
			"StateDirectory=qorpera-agent-exit/rules",
			"StateDirectoryMode=0700",
			"RuntimeDirectory=qorpera-agent-exit-rules",
			"LoadCredential=qorpera-agent-exit-rules-database-url:/etc/qorpera-agent-exit/database-url",
			"LoadCredential=qorpera-agent-exit-rules-database-ca:/usr/local/libexec/qorpera-agent-exit/supabase-prod-ca-2021.crt",
			"ExecStart=/usr/bin/node /usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit-rules.mjs",
			"UMask=0077",
			"NoNewPrivileges=yes",
			"ProtectSystem=strict",
			"CapabilityBoundingSet=",
			"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
		])
			assert.ok(service.split("\n").includes(line), line);
		assert.doesNotMatch(service, /^(?:Environment|NetworkNamespacePath|ReadWritePaths)=/m);
		const repeated = spawnSync(process.execPath, ["scripts/package-agent-exit-rules.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		assert.notEqual(repeated.status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
