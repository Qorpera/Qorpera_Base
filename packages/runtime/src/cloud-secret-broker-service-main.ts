import { X509Certificate } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { composeCloudConnectorService, parseCloudConnectorServiceConfig } from "./cloud-connector-service.ts";
import { ModelLoginHelperClient } from "./cloud-model-login-helper.ts";
import { CloudModelLoginVault } from "./cloud-model-login-vault.ts";
import {
	CloudSecretBroker,
	type CloudSecretConnectorAdapter,
	PostgresCloudSecretBrokerAuthority,
} from "./cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService, parseMemberOrigin } from "./cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const SUPABASE_CA_FINGERPRINT =
	"80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function brokerDatabase(value: string): {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
} {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Cloud secret broker database credential is invalid");
	}
	const user = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	const port = Number(url.port || "5432");
	if (
		(url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
		!/^qorpera_secret_broker(?:\.[a-z0-9]{20})?$/.test(user) ||
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
		throw new Error("Cloud secret broker database credential is invalid");
	}
	return { host: url.hostname, port, user, password, database: "postgres" };
}

/** An optional credential: absent means the feature stays off. Any other
 * failure still fails closed. */
async function readOptionalCredential(directory: string, name: string): Promise<string | undefined> {
	try {
		return await readCredential(directory, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readCredential(directory: string, name: string): Promise<string> {
	if (!isAbsolute(directory) || !/^[a-z][a-z0-9-]+$/.test(name)) {
		throw new Error("Cloud secret broker credential path is invalid");
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
			throw new Error("Cloud secret broker credential is unsafe");
		const read = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (read.bytesRead !== metadata.size || read.bytesRead > MAX_CREDENTIAL_BYTES) {
			throw new Error("Cloud secret broker credential changed during read");
		}
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead)).trim();
	} finally {
		bytes.fill(0);
		await handle.close();
	}
}

function parseLoginHelper(value: string): { socketPath: string; token: string } {
	const input = record(JSON.parse(value), ["schema", "socketPath", "token"], "Cloud secret broker login helper");
	if (
		input.schema !== "qorpera.model-login-helper-client/v1" ||
		typeof input.socketPath !== "string" ||
		!isAbsolute(input.socketPath) ||
		resolve(input.socketPath) !== input.socketPath ||
		typeof input.token !== "string" ||
		!TOKEN.test(input.token)
	)
		throw new Error("Cloud secret broker login helper is invalid");
	return { socketPath: input.socketPath, token: input.token };
}

function parseKeyring(value: string): CloudSecretKeyring {
	const input = record(JSON.parse(value), ["schema", "keys"], "Cloud secret keyring");
	if (input.schema !== "qorpera.cloud-secret-keyring/v1" || !Array.isArray(input.keys)) {
		throw new Error("Cloud secret keyring is invalid");
	}
	if (input.keys.length < 1 || input.keys.length > 32) throw new Error("Cloud secret keyring is invalid");
	const keys = Object.create(null) as Record<string, Uint8Array>;
	const opened: Buffer[] = [];
	try {
		for (const item of input.keys) {
			const entry = record(item, ["keyId", "keyBase64url"], "Cloud secret keyring entry");
			if (
				typeof entry.keyId !== "string" ||
				!KEY_ID.test(entry.keyId) ||
				typeof entry.keyBase64url !== "string" ||
				!/^[A-Za-z0-9_-]{43}$/.test(entry.keyBase64url) ||
				Object.hasOwn(keys, entry.keyId)
			)
				throw new Error("Cloud secret keyring entry is invalid");
			const decoded = Buffer.from(entry.keyBase64url, "base64url");
			opened.push(decoded);
			if (decoded.byteLength !== 32 || decoded.toString("base64url") !== entry.keyBase64url) {
				throw new Error("Cloud secret keyring entry is invalid");
			}
			keys[entry.keyId] = decoded;
		}
		return new CloudSecretKeyring(keys);
	} finally {
		for (const key of opened) key.fill(0);
	}
}

/**
 * Runs only in the independently credentialed cloud broker process. Connector
 * adapters are compiled into this process; none can be supplied by a model,
 * Company File recipe, runner, or database row.
 */
export async function runCloudSecretBrokerServiceMain(
	environment: NodeJS.ProcessEnv = process.env,
	adapters: readonly CloudSecretConnectorAdapter[] = [],
): Promise<void> {
	if (process.platform !== "linux") throw new Error("The cloud secret broker requires a separate Linux service");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory || !isAbsolute(directory)) throw new Error("Cloud secret broker requires systemd credentials");
	const configValue: unknown = JSON.parse(await readCredential(directory, "qorpera-cloud-secret-config"));
	// memberOrigins (optional, v2): the member app origins allowed to post a capture from a browser.
	const withOrigins = !!configValue && typeof configValue === "object" && Object.hasOwn(configValue, "memberOrigins");
	const config = record(
		configValue,
		withOrigins ? ["schema", "brokerAuthorityId", "port", "memberOrigins"] : ["schema", "brokerAuthorityId", "port"],
		"Cloud secret broker configuration",
	);
	if (
		config.schema !== "qorpera.cloud-secret-broker-service/v2" ||
		typeof config.brokerAuthorityId !== "string" ||
		!UUID.test(config.brokerAuthorityId) ||
		!Number.isSafeInteger(config.port) ||
		(config.port as number) < 1 ||
		(config.port as number) > 65_535 ||
		(withOrigins && (!Array.isArray(config.memberOrigins) || config.memberOrigins.length > 16))
	)
		throw new Error("Cloud secret broker configuration is invalid");
	const memberOrigins = withOrigins ? (config.memberOrigins as unknown[]).map(parseMemberOrigin) : [];
	const database = brokerDatabase(await readCredential(directory, "qorpera-cloud-secret-database-url"));
	const databaseCa = await readCredential(directory, "qorpera-cloud-secret-database-ca");
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(databaseCa);
	} catch {
		throw new Error("Cloud secret broker database CA is invalid");
	}
	if (certificate.fingerprint256 !== SUPABASE_CA_FINGERPRINT || certificate.ca !== true) {
		throw new Error("Cloud secret broker database CA is invalid");
	}
	const brokerCapability = await readCredential(directory, "qorpera-cloud-secret-control");
	const runtimeToken = await readCredential(directory, "qorpera-cloud-secret-runtime");
	// Bundle v88: the coding executor's own bearer for repository credentials.
	// Only a broker whose company runs coding sessions gets it (a drop-in);
	// without it the route answers 404. Never the runtime token guests hold.
	const codingExecutorToken = await readOptionalCredential(directory, "qorpera-cloud-secret-coding-executor");
	// Model logins in the vault (Stateless Compute step 1, change 2): the login helper's socket
	// and token. Without it the vault hands logins out as stored and never renews them.
	const loginHelperText = await readOptionalCredential(directory, "qorpera-cloud-secret-login-helper");
	const loginHelper = loginHelperText === undefined ? undefined : parseLoginHelper(loginHelperText);
	const secrets = [database.password, brokerCapability, runtimeToken, codingExecutorToken, loginHelper?.token].filter(
		(value): value is string => value !== undefined,
	);
	if (
		!CAPABILITY.test(brokerCapability) ||
		!TOKEN.test(runtimeToken) ||
		(codingExecutorToken !== undefined && !TOKEN.test(codingExecutorToken)) ||
		new Set(secrets).size !== secrets.length
	)
		throw new Error("Cloud secret broker credentials are invalid");
	const keyring = parseKeyring(await readCredential(directory, "qorpera-cloud-secret-keyring"));
	// Step 7 production connectors and their OAuth routes exist only when the
	// operator supplies the connectors credential. The canary and any adapters
	// passed by the caller are kept either way.
	const connectorsText = await readOptionalCredential(directory, "qorpera-cloud-secret-connectors");
	const connectors = connectorsText
		? composeCloudConnectorService(parseCloudConnectorServiceConfig(connectorsText), memberOrigins)
		: undefined;
	if (connectors) {
		console.error(`Cloud secret broker serves connectors: ${connectors.connectors.join(", ")}`);
	}
	const pool = new Pool({
		host: database.host,
		port: database.port,
		user: database.user,
		password: database.password,
		database: database.database,
		ssl: { ca: databaseCa, rejectUnauthorized: true },
		application_name: "qorpera-cloud-secret-broker",
		max: 2,
		min: 0,
		allowExitOnIdle: true,
		connectionTimeoutMillis: 5000,
		query_timeout: 5000,
		statement_timeout: 4000,
		idle_in_transaction_session_timeout: 4000,
	});
	try {
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					return pool.query<Row>(text, [...values]);
				},
			},
			brokerAuthorityId: config.brokerAuthorityId,
			brokerCapability,
		});
		const broker = new CloudSecretBroker({
			authority,
			keyring,
			adapters: [...adapters, ...(connectors?.adapters ?? [])],
		});
		const service = new HttpCloudSecretBrokerService(broker, runtimeToken, {
			host: "127.0.0.1",
			port: config.port as number,
			memberOrigins,
			...(connectors ? { oauth: connectors.oauth } : {}),
			...(codingExecutorToken ? { codingExecutorToken } : {}),
			// Model logins in the vault (Stateless Compute step 1). The helper renews; without it a
			// login is handed out as stored and nothing renews it.
			modelLogins: new CloudModelLoginVault({
				authority,
				keyring,
				...(loginHelper ? { renewer: new ModelLoginHelperClient(loginHelper) } : {}),
			}),
		});
		const stop = new AbortController();
		const shutdown = (): void => stop.abort();
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await service.start();
			await new Promise<void>((resolveWait) => {
				if (stop.signal.aborted) resolveWait();
				else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
			});
		} finally {
			process.removeListener("SIGINT", shutdown);
			process.removeListener("SIGTERM", shutdown);
			await service.close();
		}
	} finally {
		await pool.end();
		keyring.close();
	}
}

if (
	process.argv[1] &&
	["cloud-secret-broker-service-main.ts", "qorpera-cloud-secret-broker-service.mjs"].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("Cloud secret broker. Requires private systemd credentials and a TLS reverse proxy.");
	} else {
		runCloudSecretBrokerServiceMain().catch(() => {
			console.error("Cloud secret broker could not start or continue; inspect its private authority configuration.");
			process.exitCode = 1;
		});
	}
}
