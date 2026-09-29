import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { type AddressInfo, connect, createServer } from "node:net";
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

/** A port the kernel has just handed out, so no other server (another test's `listen(0)`) is on it when the
 * vault server binds it a moment later. */
async function freePort(): Promise<number> {
	const holder = createServer();
	await new Promise<void>((resolveListen) => holder.listen(0, "127.0.0.1", resolveListen));
	const { port } = holder.address() as AddressInfo;
	await new Promise((resolveClose) => holder.close(resolveClose));
	return port;
}

type Serving = { port: number; exited: Promise<number | null>; printed: () => string; stderr: () => string };

/** The three servers of the hand-off test share this one budget for starting. With the ~8 s the test waits
 * otherwise (a 5 s silent connection, a 3 s deadline), a slow start is reported by `listening`, not by the
 * test's 30 s timeout. */
const READY_BUDGET_MS = 15_000;

/** Waits until the spawned `serve` accepts connections on its port, instead of a fixed pause that a loaded
 * test machine outlasts. The probe closes at once: the server reads nothing from it (or closes a peer it
 * does not serve before reading), so it changes nothing the test then checks. */
async function listening(server: Serving, readyBy: number): Promise<void> {
	let stopped: { code: number | null } | undefined;
	void server.exited.then((code) => {
		stopped = { code };
	});
	for (;;) {
		const connected = await new Promise<boolean>((resolveProbe) => {
			const probe = connect({ host: "127.0.0.1", port: server.port });
			probe.once("connect", () => {
				probe.destroy();
				resolveProbe(true);
			});
			probe.once("error", () => {
				probe.destroy();
				resolveProbe(false);
			});
		});
		if (connected) return;
		if (stopped)
			throw new Error(
				`The vault server on ${server.port} stopped before it listened (exit code ${stopped.code}): ${server.stderr().trim().slice(-2_000) || "(no stderr)"}`,
			);
		if (Date.now() >= readyBy)
			throw new Error(
				`The vault server did not listen on ${server.port} within the test's ${READY_BUDGET_MS} ms start budget`,
			);
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
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
	const readyBy = Date.now() + READY_BUDGET_MS;
	const serveOnce = async (ticketDigest: string, peer = "127.0.0.1", ttl = 20): Promise<Serving> => {
		const port = await freePort();
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
				peer,
				"--port",
				String(port),
				"--ticket-sha256",
				ticketDigest,
				"--ttl",
				String(ttl),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let printed = "";
		let stderr = "";
		serving.stdout.on("data", (chunk: Buffer) => {
			printed += chunk.toString();
		});
		serving.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		// "close" comes after both streams have ended, so all of the server's output is read by then.
		const exited = new Promise<number | null>((resolveExit) => serving.once("close", resolveExit));
		return { port, exited, printed: () => printed, stderr: () => stderr };
	};
	// A wrong digest from node 1 (the expected one does not match what arrives): nothing is written, and the
	// ticket is used up.
	const first = await serveOnce(ticketSha256);
	await listening(first, readyBy);
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
	// A file already there: refused before asking, nothing written, and the ticket used up all the same.
	run(["--root", nodeTwo, "ticket"]);
	await writeFile(join(nodeTwo, "runtime"), "left over\n", { mode: 0o400 });
	expect(
		run(["--root", nodeTwo, "fetch", "--source", "127.0.0.1", "--port", "1", "--expect", made.fingerprintsSha256])
			.status,
	).not.toBe(0);
	await expect(stat(join(nodeTwo, "fetch-ticket"))).rejects.toThrow();
	await expect(stat(join(nodeTwo, "principal-secret"))).rejects.toThrow();
	await rm(join(nodeTwo, "runtime"));
	// An unused ticket is replaced by a new one.
	const unused = JSON.parse(run(["--root", nodeTwo, "ticket"]).stdout) as { ticketSha256: string };
	// A fresh ticket, and node 1's own digest: the files arrive, owner-only, and match, although a silent
	// connection came first (it is closed after 5 s, well inside the fetch's own 15 s).
	const again = JSON.parse(run(["--root", nodeTwo, "ticket"]).stdout) as { ticketSha256: string };
	expect(again.ticketSha256).not.toBe(unused.ticketSha256);
	const second = await serveOnce(again.ticketSha256);
	await listening(second, readyBy);
	const silent = connect({ host: "127.0.0.1", port: second.port });
	await new Promise((resolveConnect) => silent.once("connect", resolveConnect));
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
	silent.destroy();
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
	// Another address gets nothing: node 1 closes it before reading, and stops at its deadline.
	const nodeThree = await root();
	const other = JSON.parse(run(["--root", nodeThree, "ticket"]).stdout) as { ticketSha256: string };
	const elsewhere = await serveOnce(other.ticketSha256, "127.0.0.2", 3);
	await listening(elsewhere, readyBy);
	const refusedElsewhere = run([
		"--root",
		nodeThree,
		"fetch",
		"--source",
		"127.0.0.1",
		"--port",
		String(elsewhere.port),
		"--expect",
		made.fingerprintsSha256,
	]);
	expect(refusedElsewhere.status).not.toBe(0);
	await expect(stat(join(nodeThree, "principal-secret"))).rejects.toThrow();
	expect(await elsewhere.exited).not.toBe(0);
	// Its own result, so a server that never ran (its port taken, say) cannot pass for one that served nothing.
	expect(JSON.parse(elsewhere.printed())).toMatchObject({ passed: false, served: false, peer: "127.0.0.2" });
}, 30_000);

it("gives the shared vault its own login helper token, written on the host and never printed", async () => {
	const vault = await root();
	const helperRoot = join(vault, "..", "helper");
	// Without the helper installed, nothing is written.
	expect(run(["--root", vault, "helper-token", "--helper-root", helperRoot]).status).not.toBe(0);
	await expect(stat(join(vault, "login-helper.json"))).rejects.toThrow();
	await mkdir(helperRoot, { mode: 0o700 });
	const made = run(["--root", vault, "helper-token", "--helper-root", helperRoot]);
	expect(made.status).toBe(0);
	const token = (await readFile(join(helperRoot, "vault-token"), "utf8")).trim();
	expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(made.stdout).not.toContain(token);
	expect(JSON.parse(await readFile(join(vault, "login-helper.json"), "utf8"))).toEqual({
		schema: "qorpera.model-login-helper-client/v1",
		socketPath: "/run/qorpera-model-login-helper/helper.sock",
		token,
	});
	expect((await stat(join(helperRoot, "vault-token"))).mode & 0o777).toBe(0o400);
	expect((await stat(join(vault, "login-helper.json"))).mode & 0o777).toBe(0o400);
	// Never over an existing one.
	expect(run(["--root", vault, "helper-token", "--helper-root", helperRoot]).status).not.toBe(0);
	expect((await readFile(join(helperRoot, "vault-token"), "utf8")).trim()).toBe(token);
});
