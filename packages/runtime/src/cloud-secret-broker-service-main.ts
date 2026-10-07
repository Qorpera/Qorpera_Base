import { X509Certificate } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ChatGptPlanOAuth, parseChatGptPlanClient } from "./cloud-chatgpt-plan.ts";
import { ChatGptPlanSignIns } from "./cloud-chatgpt-plan-sign-in.ts";
import type { CloudConnectorOAuthFlows } from "./cloud-connector-oauth.ts";
import { composeCloudConnectorService, parseCloudConnectorServiceConfig } from "./cloud-connector-service.ts";
import {
	CloudConnectorTokenRevocations,
	CloudConnectorTokenRevocationUpkeep,
	CloudConnectorTokenRevoker,
} from "./cloud-connector-token-revocation.ts";
import { CloudEventVerifications, CloudEventVerificationUpkeep } from "./cloud-event-verification.ts";
import { ModelLoginHelperClient } from "./cloud-model-login-helper.ts";
import { CloudModelLoginUpkeep } from "./cloud-model-login-upkeep.ts";
import { CloudModelLoginVault } from "./cloud-model-login-vault.ts";
import { CloudModelLoginSignIns } from "./cloud-model-login-vault-sign-in.ts";
import { CloudModelLoginUsage } from "./cloud-model-login-vault-usage.ts";
import {
	CloudSecretBroker,
	type CloudSecretConnectorAdapter,
	PostgresCloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerPrincipal,
} from "./cloud-secret-broker.ts";
import {
	HttpCloudSecretBrokerService,
	type NativeBindingProof,
	parseMemberOrigin,
} from "./cloud-secret-broker-http.ts";
import { SharedCloudSecretBrokerCompanies } from "./cloud-secret-broker-shared.ts";
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

/** A company's own keys (`qorpera.cloud-secret-keyring/v1`), or the shared vault's master keys
 * (`qorpera.cloud-secret-master-keys/v1`), from which each company's key is derived. */
function parseKeyring(value: string, masterKeys = false): CloudSecretKeyring {
	const input = record(JSON.parse(value), ["schema", "keys"], "Cloud secret keyring");
	if (
		input.schema !== (masterKeys ? "qorpera.cloud-secret-master-keys/v1" : "qorpera.cloud-secret-keyring/v1") ||
		!Array.isArray(input.keys)
	) {
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
		return masterKeys ? new CloudSecretKeyring({}, keys) : new CloudSecretKeyring(keys);
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
	// v2 is one company's broker (`brokerAuthorityId`); v3 is the shared vault (`principalId`, Vault By
	// Default), which serves every company created after its start time.
	const shared =
		!!configValue &&
		typeof configValue === "object" &&
		(configValue as Record<string, unknown>).schema === "qorpera.cloud-secret-broker-service/v3";
	const identityKey = shared ? "principalId" : "brokerAuthorityId";
	const config = record(
		configValue,
		withOrigins ? ["schema", identityKey, "port", "memberOrigins"] : ["schema", identityKey, "port"],
		"Cloud secret broker configuration",
	);
	const identity = config[identityKey];
	if (
		(!shared && config.schema !== "qorpera.cloud-secret-broker-service/v2") ||
		typeof identity !== "string" ||
		!UUID.test(identity) ||
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
	// One company's broker proves its authority with its capability; the shared vault derives every
	// company's capability, and its own, from its principal secret.
	const brokerCapability = await readCredential(
		directory,
		shared ? "qorpera-cloud-secret-principal" : "qorpera-cloud-secret-control",
	);
	const runtimeToken = await readCredential(directory, "qorpera-cloud-secret-runtime");
	// Bundle v88: the coding executor's own bearer for repository credentials.
	// Only a broker whose company runs coding sessions gets it (a drop-in);
	// without it the route answers 404. Never the runtime token guests hold.
	const codingExecutorToken = await readOptionalCredential(directory, "qorpera-cloud-secret-coding-executor");
	// Model logins in the vault (Stateless Compute step 1, change 2): the login helper's socket
	// and token. Without it the vault hands logins out as stored and never renews them.
	const loginHelperText = await readOptionalCredential(directory, "qorpera-cloud-secret-login-helper");
	const loginHelper = loginHelperText === undefined ? undefined : parseLoginHelper(loginHelperText);
	// Sign in with ChatGPT (built switched off): Qorpera's client registration with OpenAI, which the
	// operator adds once OpenAI approves Qorpera. Without it no plan sign-in starts, and plan logins are
	// neither renewed nor ended here.
	const chatGptPlanText = await readOptionalCredential(directory, "qorpera-cloud-secret-chatgpt-plan");
	let chatGptPlanClient: ReturnType<typeof parseChatGptPlanClient> | undefined;
	try {
		chatGptPlanClient = chatGptPlanText === undefined ? undefined : parseChatGptPlanClient(chatGptPlanText);
	} catch {
		// A broken plan registration must not stop every company's vault: plans stay off, and the operator sees it.
		console.error("Cloud secret broker: the ChatGPT plan credential is invalid; ChatGPT plan sign-ins stay off.");
	}
	const chatGptPlan = chatGptPlanClient ? new ChatGptPlanOAuth({ client: chatGptPlanClient }) : undefined;
	if (chatGptPlan) console.error("Cloud secret broker serves ChatGPT plan sign-ins.");
	const secrets = [
		database.password,
		brokerCapability,
		runtimeToken,
		codingExecutorToken,
		loginHelper?.token,
		chatGptPlanClient?.clientSecret ?? undefined,
	].filter((value): value is string => value !== undefined);
	if (
		(shared ? !TOKEN.test(brokerCapability) : !CAPABILITY.test(brokerCapability)) ||
		!TOKEN.test(runtimeToken) ||
		(codingExecutorToken !== undefined && !TOKEN.test(codingExecutorToken)) ||
		new Set(secrets).size !== secrets.length
	)
		throw new Error("Cloud secret broker credentials are invalid");
	const keyring = shared
		? parseKeyring(await readCredential(directory, "qorpera-cloud-secret-master-keys"), true)
		: parseKeyring(await readCredential(directory, "qorpera-cloud-secret-keyring"));
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
		application_name: shared ? "qorpera-shared-vault" : "qorpera-cloud-secret-broker",
		// The shared vault runs every company's calls and background passes on one pool.
		max: shared ? 8 : 2,
		min: 0,
		allowExitOnIdle: true,
		connectionTimeoutMillis: 5000,
		query_timeout: 5000,
		statement_timeout: 4000,
		idle_in_transaction_session_timeout: 4000,
	});
	const databaseClient = {
		async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
			return pool.query<Row>(text, [...values]);
		},
	};
	// G2-6a: a native host's request holds its run's lease before a runtime-token route serves its binding. The holder
	// travels as a bound parameter, never in the statement text.
	const proveBinding: NativeBindingProof = async (binding, holder) => {
		const result = await databaseClient.query<{ proven: boolean }>(
			"select public.qorpera_native_binding_proven($1::jsonb, $2) as proven",
			[JSON.stringify(binding), holder],
		);
		if (result.rows[0]?.proven !== true) throw new Error("Native binding proof is refused");
	};
	if (shared) {
		try {
			await runSharedVault({
				principal: new PostgresCloudSecretBrokerPrincipal({
					database: databaseClient,
					principalId: identity,
					principalSecret: brokerCapability,
				}),
				keyring,
				adapters: [...adapters, ...(connectors?.adapters ?? [])],
				helper: loginHelper ? new ModelLoginHelperClient(loginHelper) : undefined,
				chatGptPlan,
				revoker: connectors?.revoker ?? new CloudConnectorTokenRevoker(),
				runtimeToken,
				proveBinding,
				port: config.port as number,
				memberOrigins,
				oauth: connectors?.oauth,
				codingExecutorToken,
			});
		} finally {
			await pool.end();
			keyring.close();
		}
		return;
	}
	try {
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: databaseClient,
			brokerAuthorityId: identity,
			brokerCapability,
		});
		const broker = new CloudSecretBroker({
			authority,
			keyring,
			adapters: [...adapters, ...(connectors?.adapters ?? [])],
		});
		const helper = loginHelper ? new ModelLoginHelperClient(loginHelper) : undefined;
		// Members' sign-ins to the vault: the broker collects finished Codex ones in the background.
		const signIns =
			helper || chatGptPlan
				? new CloudModelLoginSignIns({
						authority,
						keyring,
						...(helper ? { helper } : {}),
						...(chatGptPlan ? { plan: new ChatGptPlanSignIns({ oauth: chatGptPlan, authority, keyring }) } : {}),
					})
				: undefined;
		// Model logins in the vault (Stateless Compute step 1). The helper renews and runs a
		// member's sign-in; without it a login is handed out as stored, nothing renews it, and
		// the sign-in route answers 404.
		const modelLogins = new CloudModelLoginVault({
			authority,
			keyring,
			...(helper ? { renewer: helper } : {}),
			...(chatGptPlan ? { chatGptPlan } : {}),
		});
		// The vault's upkeep: it renews idle logins itself (Codex logins only with the helper, plan logins
		// only with the plan client) and ends unused plan logins at OpenAI.
		const upkeep = new CloudModelLoginUpkeep({ vault: modelLogins });
		// Disconnected and deleted connections' tokens, cancelled at the provider once a minute (D6).
		// Without the connectors credential Google's revoke still works; GitHub's waits for its client.
		const revocations = new CloudConnectorTokenRevocationUpkeep({
			revocations: new CloudConnectorTokenRevocations({
				authority,
				keyring,
				revoker: connectors?.revoker ?? new CloudConnectorTokenRevoker(),
			}),
		});
		// Deliveries to the company's signed hooks, checked against their signing secrets every five seconds (W1b).
		const verifications = new CloudEventVerificationUpkeep({
			verifications: new CloudEventVerifications({ authority, keyring }),
		});
		const service = new HttpCloudSecretBrokerService(broker, runtimeToken, {
			host: "127.0.0.1",
			port: config.port as number,
			memberOrigins,
			proveBinding,
			...(connectors ? { oauth: connectors.oauth } : {}),
			...(codingExecutorToken ? { codingExecutorToken } : {}),
			modelLogins,
			...(signIns ? { modelLoginSignIns: signIns } : {}),
			// Usage of vault logins needs no helper: the broker reads it with the pass.
			modelLoginUsage: new CloudModelLoginUsage({ authority, keyring }),
		});
		const stop = new AbortController();
		const shutdown = (): void => stop.abort();
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await service.start();
			signIns?.start();
			upkeep.start();
			revocations.start();
			verifications.start();
			await new Promise<void>((resolveWait) => {
				if (stop.signal.aborted) resolveWait();
				else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
			});
		} finally {
			process.removeListener("SIGINT", shutdown);
			process.removeListener("SIGTERM", shutdown);
			// All at once: the server stops taking requests while a renewal in flight finishes, so a
			// stop stays within the unit's 90 s.
			await Promise.all([
				upkeep.close(),
				revocations.close(),
				verifications.close(),
				signIns?.close(),
				service.close(),
			]);
		}
	} finally {
		await pool.end();
		keyring.close();
	}
}

/** The shared vault (Vault By Default): every company created after its start time, each on its own
 * authority, with the same routes and background work as one company's broker. */
async function runSharedVault(options: {
	principal: PostgresCloudSecretBrokerPrincipal;
	keyring: CloudSecretKeyring;
	adapters: readonly CloudSecretConnectorAdapter[];
	helper: ModelLoginHelperClient | undefined;
	chatGptPlan: ChatGptPlanOAuth | undefined;
	revoker: CloudConnectorTokenRevoker;
	runtimeToken: string;
	proveBinding: NativeBindingProof;
	port: number;
	memberOrigins: readonly string[];
	oauth: CloudConnectorOAuthFlows | undefined;
	codingExecutorToken: string | undefined;
}): Promise<void> {
	const companies = new SharedCloudSecretBrokerCompanies({
		principal: options.principal,
		keyring: options.keyring,
		adapters: options.adapters,
		...(options.helper ? { helper: options.helper } : {}),
		...(options.chatGptPlan ? { chatGptPlan: options.chatGptPlan } : {}),
		revoker: options.revoker,
	});
	const service = new HttpCloudSecretBrokerService(companies, options.runtimeToken, {
		host: "127.0.0.1",
		port: options.port,
		memberOrigins: options.memberOrigins,
		proveBinding: options.proveBinding,
		...(options.oauth ? { oauth: options.oauth } : {}),
		...(options.codingExecutorToken ? { codingExecutorToken: options.codingExecutorToken } : {}),
	});
	const stop = new AbortController();
	const shutdown = (): void => stop.abort();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await service.start();
		companies.start();
		await new Promise<void>((resolveWait) => {
			if (stop.signal.aborted) resolveWait();
			else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
		});
	} finally {
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
		await Promise.all([companies.close(), service.close()]);
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
