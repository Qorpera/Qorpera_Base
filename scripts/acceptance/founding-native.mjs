import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startNativePostgres } from "./native-postgres.mjs";
import { runFoundingBrowser } from "./founding-browser.mjs";
import { closeServer, listenLoopback, platformBootstrapParts, startFoundingGateway, startFoundingMail, startOwnedProcess, waitHttp } from "./founding-services.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function foundingOptions(args) {
	const result = {};
	for (let i = 0; i < args.length; i += 2) {
		const field = { "--bin": "binDirectory", "--tools": "tools", "--out": "out" }[args[i]], value = args[i + 1];
		assert(field && result[field] === undefined && typeof value === "string" && isAbsolute(value) && resolve(value) === value && value !== "/" && !/[\x00-\x20\x7f'\\]/.test(value), "Exact isolated acceptance arguments required");
		result[field] = value;
	}
	assert(Object.keys(result).length === 3, "Require --bin, --tools, --out");
	return result;
}
async function freePort() { const server = createServer(); const port = await listenLoopback(server); await closeServer(server); return port; }

export async function runFoundingNative(options) {
	assert(process.platform === "linux" && process.getuid?.() > 0, "Disposable unprivileged Linux runner required");
	await mkdir(options.out, { mode: 0o700 });
	assert.equal(await realpath(options.out), options.out);
	assert.deepEqual(await readdir(options.out), []);
	const privateRoot = await mkdtemp("/tmp/qorpera-founding-");
	const owned = [];
	let cluster, mail, gateway;
	const evidence = { schema: "qorpera.founding-browser-acceptance/v1", commit: process.env.GITHUB_SHA ?? null,
		passed: false, cleanup: false, authVersion: "v2.197.0", postgrestVersion: "16.4" };
	const env = { PATH: "/usr/bin:/bin", HOME: privateRoot, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
	try {
		const certificate = await startOwnedProcess("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
			"-keyout", join(privateRoot, "key.pem"), "-out", join(privateRoot, "cert.pem"), "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
			{ cwd: privateRoot, env, logPath: join(privateRoot, "openssl.log") });
		owned.push(certificate); await certificate.wait();
		const jwtSecret = randomBytes(48).toString("base64url"), publicKey = `sb_publishable_${randomBytes(24).toString("base64url")}`;
		mail = await startFoundingMail();
		gateway = await startFoundingGateway({ cert: await readFile(join(privateRoot, "cert.pem")), key: await readFile(join(privateRoot, "key.pem")), publicKey,
			webRoot: join(repository, "packages/web/dist") });
		const authPort = await freePort(), restPort = await freePort();
		gateway.upstream.auth = authPort; gateway.upstream.rest = restPort;
		let authProcess;
		cluster = await startNativePostgres({ binDirectory: options.binDirectory, onProgress: name => process.stderr.write(`Founding DB: ${name}\n`),
			bootstrap: async handle => {
				const [before, after] = platformBootstrapParts(handle.platformSql);
				await handle.query(before);
				// Auth's migrations create auth.users, but the API queries users
				// through its connection search path (the hosted Auth role normally
				// configures this). Keep this local to Auth, not the shared DB role.
				const connection = `postgres://postgres@localhost/${handle.database}?host=${encodeURIComponent(handle.socketDirectory)}&sslmode=disable&search_path=auth`;
				authProcess = await startOwnedProcess(join(options.tools, "auth/auth"), [], {
					cwd: join(options.tools, "auth"), logPath: join(privateRoot, "auth.log"), env: { ...env,
						GOTRUE_DB_DRIVER: "postgres", DB_NAMESPACE: "auth", DATABASE_URL: connection,
						GOTRUE_API_HOST: "127.0.0.1", PORT: String(authPort), API_EXTERNAL_URL: `${gateway.origin}/auth/v1`,
						GOTRUE_SITE_URL: gateway.origin, GOTRUE_URI_ALLOW_LIST: gateway.origin,
						GOTRUE_JWT_SECRET: jwtSecret, GOTRUE_JWT_EXP: "3600", GOTRUE_JWT_AUD: "authenticated",
						GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated", GOTRUE_JWT_ADMIN_ROLES: "service_role",
						GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_DISABLE_SIGNUP: "false", GOTRUE_MAILER_AUTOCONFIRM: "false",
						GOTRUE_MAILER_OTP_LENGTH: "8", GOTRUE_MAILER_OTP_EXP: "600",
						GOTRUE_SMTP_HOST: "127.0.0.1", GOTRUE_SMTP_PORT: String(mail.port), GOTRUE_SMTP_ADMIN_EMAIL: "auth@founding.example.test",
						GOTRUE_SMTP_SENDER_NAME: "Founding acceptance", GOTRUE_SMTP_MAX_FREQUENCY: "1s", GOTRUE_RATE_LIMIT_EMAIL_SENT: "100",
						GOTRUE_MAILER_TEMPLATES_CONFIRMATION: mail.templateUrl, GOTRUE_MAILER_TEMPLATES_MAGIC_LINK: mail.templateUrl,
						GOTRUE_LOG_LEVEL: "warn", GOTRUE_DB_MAX_POOL_SIZE: "5",
					} });
				owned.push(authProcess);
				await waitHttp(`http://127.0.0.1:${authPort}/health`, authProcess);
				assert.equal(await handle.query("select to_regclass('auth.sessions') is not null and exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='encrypted_password');"), "t", "Real Auth migrations did not create identity/session schema");
				await handle.query(after);
			},
		});
		evidence.postgresVersion = cluster.postgresVersion; evidence.migrationCount = cluster.migrationCount;
		await cluster.query("create role founding_authenticator login noinherit; grant anon, authenticated, service_role to founding_authenticator;");
		const restProcess = await startOwnedProcess(join(options.tools, "rest/postgrest"), [], { cwd: privateRoot, logPath: join(privateRoot, "postgrest.log"), env: { ...env,
			PGRST_DB_URI: `postgres://founding_authenticator@localhost/${cluster.database}?host=${encodeURIComponent(cluster.socketDirectory)}&sslmode=disable`,
			PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_DB_POOL: "5", PGRST_DB_CONFIG: "false",
			PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(restPort), PGRST_LOG_LEVEL: "warn",
		} });
		owned.push(restProcess); await waitHttp(`http://127.0.0.1:${restPort}/`, restProcess);
		const build = await startOwnedProcess(process.execPath, ["packages/web/scripts/build.mjs"], { cwd: repository,
			env: { ...env, QORPERA_WEB_CONFIG_JSON: JSON.stringify({ projectUrl: gateway.origin, publishableKey: publicKey, objectGatewayUrl: gateway.origin }) },
			logPath: join(privateRoot, "web-build.log") });
		owned.push(build); await build.wait();
		Object.assign(evidence, await runFoundingBrowser({ origin: gateway.origin, publicKey, cluster, mail, out: options.out }));
		evidence.passed = true;
	} catch (error) {
		evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown founding acceptance failure";
		// Private logs can include OTPs or Auth tokens. Never upload or print them.
		process.stderr.write(`Founding acceptance failed: ${evidence.error}\n`);
	} finally {
		try {
			await gateway?.close();
			for (const process of owned.reverse()) await process.close();
			await mail?.close(); await cluster?.close();
			await rm(privateRoot, { recursive: true }); evidence.cleanup = true;
		} catch { evidence.cleanup = false; evidence.passed = false; evidence.cleanupError = "Owned process cleanup unconfirmed; private state retained"; }
		await writeFile(join(options.out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
	assert(evidence.passed && evidence.cleanup, "Founding acceptance failed; see bounded evidence.json");
	return evidence;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await runFoundingNative(foundingOptions(process.argv.slice(2)));
}
