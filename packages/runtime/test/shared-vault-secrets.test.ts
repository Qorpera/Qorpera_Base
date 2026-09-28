import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sharedBrokerCapability } from "@qorpera/runtime/cloud-secret-broker";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it } from "vitest";

const tool = resolve(import.meta.dirname, "../../../deploy/cloud-secret-broker/shared-vault-secrets.py");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
	// The tool takes only a resolved path (macOS keeps its temporary folder behind a link).
	const directory = await realpath(await mkdtemp(join(tmpdir(), "shared-vault-")));
	roots.push(directory);
	return join(directory, "vault");
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const done = spawnSync("python3", [tool, ...args], { encoding: "utf8" });
	return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

it("makes both secrets as owner-only files once, and prints only hashes the broker derives the same way", async () => {
	const vault = await root();
	const made = run(["--root", vault, "generate", "--key-id", "vault-root-1"]);
	expect(made.status).toBe(0);
	const printed = JSON.parse(made.stdout) as {
		keyId: string;
		principalCapabilitySha256: string;
		fingerprints: { principalSecret: string; masterKey: string };
		fingerprintsSha256: string;
	};
	const secret = (await readFile(join(vault, "principal-secret"), "utf8")).trim();
	const masterKeys = await readFile(join(vault, "master-keys.json"), "utf8");
	// Nothing printed is a secret.
	expect(made.stdout).not.toContain(secret);
	expect(made.stdout).not.toContain(JSON.parse(masterKeys).keys[0].keyBase64url);
	expect(printed.keyId).toBe("vault-root-1");
	expect(printed.principalCapabilitySha256).toBe(
		createHash("sha256").update(sharedBrokerCapability(secret)).digest("hex"),
	);
	expect((await stat(join(vault, "principal-secret"))).mode & 0o777).toBe(0o400);
	expect((await stat(join(vault, "master-keys.json"))).mode & 0o777).toBe(0o400);
	expect((await stat(vault)).mode & 0o777).toBe(0o700);
	// The master key is one the broker's keyring takes.
	const entry = JSON.parse(masterKeys).keys[0] as { keyId: string; keyBase64url: string };
	const keyring = new CloudSecretKeyring({}, { [entry.keyId]: Buffer.from(entry.keyBase64url, "base64url") });
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: entry.keyId,
	};
	await expect(
		keyring.use(keyring.seal({ field: "value" }, identity), identity, async (fields) => fields.field),
	).resolves.toBe("value");
	keyring.close();
	// Never over existing secrets.
	const again = run(["--root", vault, "generate", "--key-id", "vault-root-1"]);
	expect(again.status).not.toBe(0);
	expect((await readFile(join(vault, "principal-secret"), "utf8")).trim()).toBe(secret);
	expect(JSON.parse(run(["--root", vault, "fingerprint"]).stdout)).toEqual(printed);
});

it("hands the standby its files once, on a ticket that never leaves it, checked before anything is written", async () => {
	const nodeOne = await root();
	const nodeTwo = await root();
	run(["--root", nodeOne, "generate", "--key-id", "vault-root-1"]);
	// On node 1 the operator copies the company brokers' database login, runtime token, connector clients and
	// coding executor token in, on the host.
	const passedOn = {
		"database-url": "postgresql://qorpera_secret_broker:PRIVATE@db.example.test:5432/postgres?sslmode=verify-full\n",
		runtime: `${randomBytes(32).toString("base64url")}\n`,
		"connectors.json": '{"schema":"qorpera.cloud-connector-service/v1","github":{"clientSecret":"PRIVATE"}}\n',
		"coding-executor": `${randomBytes(32).toString("base64url")}\n`,
	};
	for (const [name, content] of Object.entries(passedOn))
		await writeFile(join(nodeOne, name), content, { mode: 0o400 });
	const made = JSON.parse(run(["--root", nodeOne, "fingerprint"]).stdout);
	expect(Object.keys(made.fingerprints).sort()).toEqual([
		"coding-executor",
		"connectors.json",
		"database-url",
		"masterKey",
		"principalSecret",
		"runtime",
	]);
	// Node 2 makes the ticket; only its hash reaches node 1.
	const ticket = run(["--root", nodeTwo, "ticket"]);
	expect(ticket.status).toBe(0);
	const { ticketSha256 } = JSON.parse(ticket.stdout) as { ticketSha256: string };
	const held = (await readFile(join(nodeTwo, "fetch-ticket"), "utf8")).trim();
	expect(ticket.stdout).not.toContain(held);
	expect(createHash("sha256").update(held).digest("hex")).toBe(ticketSha256);
	const serveOnce = (ticketDigest: string) => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const serving = spawn(
			"python3",
			[
				tool,
				"--root",
				nodeOne,
				"serve",
				"--bind",
				"127.0.0.1",
				"--peer",
				"127.0.0.1",
				"--port",
				String(port),
				"--ticket-sha256",
				ticketDigest,
				"--ttl",
				"20",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let printed = "";
		serving.stdout.on("data", (chunk: Buffer) => {
			printed += chunk.toString();
		});
		const exited = new Promise<number | null>((resolveExit) => serving.once("exit", resolveExit));
		return { port, exited, printed: () => printed };
	};
	// A wrong digest from node 1 (the expected one does not match what arrives): nothing is written, and the
	// ticket is used up.
	const first = serveOnce(ticketSha256);
	await new Promise((resolveWait) => setTimeout(resolveWait, 700));
	const refused = run([
		"--root",
		nodeTwo,
		"fetch",
		"--source",
		"127.0.0.1",
		"--port",
		String(first.port),
		"--expect",
		"0".repeat(64),
	]);
	expect(refused.status).not.toBe(0);
	expect(JSON.parse(refused.stdout)).toEqual({ passed: false, match: "mismatch" });
	expect(await first.exited).toBe(0);
	await expect(stat(join(nodeTwo, "principal-secret"))).rejects.toThrow();
	await expect(stat(join(nodeTwo, "fetch-ticket"))).rejects.toThrow();
	// A fresh ticket, and node 1's own digest: the files arrive, owner-only, and match.
	const again = JSON.parse(run(["--root", nodeTwo, "ticket"]).stdout) as { ticketSha256: string };
	const second = serveOnce(again.ticketSha256);
	await new Promise((resolveWait) => setTimeout(resolveWait, 700));
	const fetched = run([
		"--root",
		nodeTwo,
		"fetch",
		"--source",
		"127.0.0.1",
		"--port",
		String(second.port),
		"--expect",
		made.fingerprintsSha256,
	]);
	expect(fetched.status).toBe(0);
	expect(JSON.parse(fetched.stdout)).toEqual({ ...made, match: "match" });
	expect(await second.exited).toBe(0);
	expect(JSON.parse(second.printed())).toMatchObject({
		passed: true,
		served: true,
		fingerprintsSha256: made.fingerprintsSha256,
	});
	for (const printed of [second.printed(), fetched.stdout, JSON.stringify(made)]) {
		expect(printed).not.toContain("PRIVATE");
		expect(printed).not.toContain((await readFile(join(nodeOne, "principal-secret"), "utf8")).trim());
	}
	for (const name of Object.keys(passedOn)) {
		expect(await readFile(join(nodeTwo, name), "utf8")).toBe(passedOn[name as keyof typeof passedOn]);
		expect((await stat(join(nodeTwo, name))).mode & 0o777).toBe(0o400);
	}
	expect((await stat(join(nodeTwo, "principal-secret"))).mode & 0o777).toBe(0o400);
	// A ticket works once: node 2 holds none now, and a second fetch refuses before asking.
	expect(
		run(["--root", nodeTwo, "fetch", "--source", "127.0.0.1", "--port", "1", "--expect", made.fingerprintsSha256])
			.status,
	).not.toBe(0);
});
