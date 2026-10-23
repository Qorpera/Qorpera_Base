import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { AgentExitRulesReader } from "./agent-exit-rules.ts";
import { databaseTls } from "./database-ca.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

/**
 * The agent exit's rules reader as a service (qorpera-agent-exit-rules.service). It reads the database with the exit's
 * own login, from two private systemd credentials: the database URL, which the rollout script places on the node, and
 * Supabase's CA. A node installed with our own CA (install-agent-exit.sh --database-ca) has two more, that CA and its
 * sha256 pin, and trusts that CA alone (database-ca.ts). It reads the node's client map, keeps rules.json in its state
 * folder and writes status.json to its runtime folder.
 */

const MAX_CREDENTIAL_BYTES = 64 * 1024;
/** The plug's client map (deploy/agent-exit/qorpera-agent-plug.py). */
const CLIENTS_DIR = "/var/lib/qorpera-agent-exit/clients";

function exitDatabase(value: string): { host: string; port: number; user: string; password: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Agent exit rules database credential is invalid");
	}
	const user = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	const port = Number(url.port || "5432");
	if (
		(url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
		!/^qorpera_agent_exit(?:\.[a-z0-9]{20})?$/.test(user) ||
		!password ||
		/[\0\r\n]/.test(password) ||
		!url.hostname ||
		!Number.isSafeInteger(port) ||
		port < 1 ||
		port > 65_535 ||
		url.pathname !== "/postgres" ||
		url.hash ||
		url.searchParams.size !== 1 ||
		url.searchParams.get("sslmode") !== "verify-full"
	) {
		throw new Error("Agent exit rules database credential is invalid");
	}
	return { host: url.hostname, port, user, password };
}

async function readCredential(directory: string, name: string): Promise<string> {
	const bytes = await readCredentialBytes(directory, name);
	try {
		return new TextDecoder("utf8", { fatal: true }).decode(bytes).trim();
	} finally {
		bytes.fill(0);
	}
}

/** An optional credential: absent means its input was not given. Any other failure still fails closed. */
async function readOptionalCredential<T>(
	directory: string,
	name: string,
	read: (directory: string, name: string) => Promise<T>,
): Promise<T | undefined> {
	try {
		return await read(directory, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readCredentialBytes(directory: string, name: string): Promise<Buffer> {
	if (!isAbsolute(directory) || !/^[a-z][a-z0-9-]+$/.test(name)) {
		throw new Error("Agent exit rules credential path is invalid");
	}
	const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
	try {
		const metadata = await handle.stat();
		if (
			metadata.size < 1 ||
			!systemdCredentialMetadataIsSafe(
				{
					isFile: metadata.isFile(),
					size: metadata.size,
					uid: metadata.uid,
					gid: metadata.gid,
					mode: metadata.mode,
				},
				process.geteuid?.(),
				MAX_CREDENTIAL_BYTES,
				"linux",
			)
		)
			throw new Error("Agent exit rules credential is unsafe");
		const read = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (read.bytesRead !== metadata.size || read.bytesRead > MAX_CREDENTIAL_BYTES) {
			throw new Error("Agent exit rules credential changed during read");
		}
		return Buffer.from(bytes.subarray(0, read.bytesRead));
	} finally {
		bytes.fill(0);
		await handle.close();
	}
}

function directoryFromEnvironment(name: string): string {
	const value = process.env[name];
	if (!value || !isAbsolute(value) || value !== resolve(value)) throw new Error(`${name} is invalid`);
	return value;
}

export async function runAgentExitRulesMain(): Promise<void> {
	if (process.platform !== "linux") throw new Error("The agent exit rules reader runs on a Linux node");
	const credentials = directoryFromEnvironment("CREDENTIALS_DIRECTORY");
	const state = directoryFromEnvironment("STATE_DIRECTORY");
	const runtime = directoryFromEnvironment("RUNTIME_DIRECTORY");
	const database = exitDatabase(await readCredential(credentials, "qorpera-agent-exit-rules-database-url"));
	const ssl = databaseTls(
		{
			supabaseCa: await readCredential(credentials, "qorpera-agent-exit-rules-database-ca"),
			ownCa: await readOptionalCredential(
				credentials,
				"qorpera-agent-exit-rules-database-own-ca",
				readCredentialBytes,
			),
			ownCaSha256: await readOptionalCredential(
				credentials,
				"qorpera-agent-exit-rules-database-own-ca-sha256",
				readCredential,
			),
		},
		"Agent exit rules",
	);
	const pool = new Pool({
		host: database.host,
		port: database.port,
		user: database.user,
		password: database.password,
		database: "postgres",
		ssl,
		application_name: "qorpera-agent-exit-rules",
		max: 1,
		min: 0,
		allowExitOnIdle: true,
		connectionTimeoutMillis: 5000,
		query_timeout: 5000,
		statement_timeout: 4000,
		idle_in_transaction_session_timeout: 4000,
	});
	// An idle connection the pooler closes: the next pass connects again and reports what fails.
	pool.on("error", () => undefined);
	const reader = new AgentExitRulesReader({
		database: {
			async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
				return pool.query<Row>(text, [...values]);
			},
		},
		clientsDir: CLIENTS_DIR,
		rulesFile: join(state, "rules.json"),
		statusFile: join(runtime, "status.json"),
	});
	const stop = new AbortController();
	const shutdown = (): void => stop.abort();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		reader.start();
		await new Promise<void>((resolveWait) => {
			if (stop.signal.aborted) resolveWait();
			else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
		});
	} finally {
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
		await reader.close();
		await pool.end();
	}
}

if (
	process.argv[1] &&
	["agent-exit-rules-main.ts", "qorpera-agent-exit-rules.mjs"].includes(basename(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("Agent exit rules reader. Requires private systemd credentials and the agent exit's client map.");
	} else {
		runAgentExitRulesMain().catch(() => {
			console.error("Agent exit rules reader could not start; inspect its credentials.");
			process.exitCode = 1;
		});
	}
}
