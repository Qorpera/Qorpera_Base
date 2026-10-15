import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import { createGmailConnectorAdapters } from "../../packages/runtime/src/cloud-connector-google.ts";
import { CloudSecretBroker, PostgresCloudSecretBrokerAuthority } from "../../packages/runtime/src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../../packages/runtime/src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../../packages/runtime/src/cloud-secret-crypto.ts";
import { EmailDraftClient } from "../../packages/web/src/cloud/email-drafts.ts";

const [container, temporary, database] = process.argv.slice(2);
// Only a disposable container its driver started: its own, or the hosted-db suite's.
if (!/^qorpera-(email-e2e|hosted-db)-[0-9]+-[a-f0-9]{8}$/.test(container ?? "")) throw new Error("An owned isolated E2E container is required");
if (!/^[a-z][a-z0-9_]{0,62}$/.test(database ?? "")) throw new Error("The E2E database name is required");
// The 924 folder-v2 company: its owner reviews a draft Bob raised in Bob's thread.
const owner = "92400000-0000-4000-8000-000000000001";
const interaction = "62000000-0000-4000-8000-000000000003";
const brokerId = "62000000-0000-4000-8000-000000000001";
const identity = { companyId: "92400000-0000-4000-8000-000000000010", environmentId: "92400000-0000-4000-8000-000000000020", secretId: "62000000-0000-4000-8000-000000000002", version: 1, keyId: "test" };
const brokerCapability = randomBytes(32).toString("base64url");
const keyring = new CloudSecretKeyring({ test: randomBytes(32) });
const refreshToken = "synthetic-e2e-refresh-token";
const envelope = Buffer.from(keyring.seal({ refresh_token: refreshToken }, identity));
const writes = [];
const requests = [];
// This adapter-only injection is the sole simulated external service. All
// unrecognized destinations fail closed instead of reaching the network.
const providerFetch = async (input, init) => {
	const url = new URL(String(input));
	if (url.href === "https://oauth2.googleapis.com/token") {
		assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), refreshToken);
		return Response.json({ access_token: "synthetic-e2e-access-token", expires_in: 3600 });
	}
	assert.equal(url.origin, "https://gmail.googleapis.com");
	assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-e2e-access-token");
	if (url.pathname === "/gmail/v1/users/me/profile") return Response.json({ emailAddress: "sender@example.test" });
	const data = JSON.parse(String(init?.body ?? "{}"));
	writes.push({ path: url.pathname, method: init?.method ?? "GET", data });
	if (url.pathname === "/gmail/v1/users/me/drafts/send") {
		assert.equal(data.id, "draft-e2e");
		return Response.json({ id: "sent-e2e", threadId: "thread-e2e" });
	}
	if (url.pathname === "/gmail/v1/users/me/drafts" || url.pathname === "/gmail/v1/users/me/drafts/draft-e2e")
		return Response.json({ id: "draft-e2e", message: { id: "draft-message-e2e", threadId: "thread-e2e" } });
	throw new Error(`Unexpected simulated Gmail path: ${url.pathname}`);
};

function sql(statement) {
	const result = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}
// This is deliberately restricted to synthetic fixture values in an isolated
// database. Production uses its normal parameterized PostgreSQL driver.
function literal(value) {
	if (value == null) return "null";
	if (typeof value === "number") { assert(Number.isSafeInteger(value)); return String(value); }
	return `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
const authority = new PostgresCloudSecretBrokerAuthority({
	brokerAuthorityId: brokerId, brokerCapability,
	database: { async query(statement, values) {
		const bound = statement.replace(/\$(\d+)/g, (_, index) => literal(values[Number(index) - 1]));
		const result = JSON.parse(sql(`set session authorization qorpera_secret_broker; ${bound};`));
		return { rowCount: 1, rows: [{ result }] };
	} },
});
const broker = new CloudSecretBroker({ authority, keyring, adapters: createGmailConnectorAdapters({ fetch: providerFetch, client: { clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-client-secret" } }) });
const service = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), { memberOrigins: ["https://app.example.test"] });
let proxy;
try {
	const port = await service.start();
	proxy = createServer({ key: readFileSync(join(temporary, "key.pem")), cert: readFileSync(join(temporary, "cert.pem")) }, (request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => requests.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") }));
		const upstream = httpRequest({ hostname: "127.0.0.1", port, path: request.url, method: request.method, headers: { ...request.headers, origin: "https://app.example.test" } }, (reply) => {
			response.writeHead(reply.statusCode, reply.headers);
			reply.pipe(response);
		});
		upstream.on("error", (error) => response.destroy(error));
		request.pipe(upstream);
	});
	await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
	const origin = `https://127.0.0.1:${proxy.address().port}`;
	const seed = readFileSync(join(temporary, "seed.sql"), "utf8")
		.replace("https://broker.example.test", origin)
		.replace("'test',repeat('a',64)", `'test',${literal(createHash("sha256").update(brokerCapability).digest("hex"))}`)
		.replace("decode('abcd','hex'),repeat('b',64)", `decode('${envelope.toString("hex")}','hex'),${literal(createHash("sha256").update(envelope).digest("hex"))}`);
	assert(!seed.includes("decode('abcd','hex')"));
	sql(`${seed}\nreset role; commit;`);
	const session = sql("select session_id from public.qorpera_company_rooms where bound_staff_agent_id='92400000-0000-4000-8000-000000000031';");
	// The owner's sponsor from the 924 fixture pays for the answer that wakes Bob.
	const sponsor = { sponsorBindingId: sql("select id from public.qorpera_execution_sponsor_bindings where client_binding_id='92400000-0000-4000-8000-000000000061';"), sponsorVersion: 1 };
	const memberPrefix = `set request.jwt.claims=${literal(JSON.stringify({ sub: owner, role: "authenticated" }))}; set role authenticated;`;
	const cloud = { config: { projectUrl: "https://isolated-postgres.example.test" }, async rpc(name, args) {
		assert(["qorpera_get_email_draft", "qorpera_prepare_email_draft_action"].includes(name));
		assert(Object.keys(args).every((key) => /^p_[a-z_][a-z0-9_]*$/.test(key)));
		return JSON.parse(sql(`${memberPrefix} select public.${name}(${Object.entries(args).map(([key, value]) => `${key} => ${literal(value)}`).join(",")});`));
	} };
	const client = new EmailDraftClient(cloud, owner, AbortSignal.timeout(60_000));
	const initial = await client.read(session, interaction);
	assert.equal(initial.status, "ready");
	assert.equal(initial.from, "sender@example.test");
	const saved = await client.act(session, interaction, "save", initial.content, sponsor);
	assert.equal(saved.status, "saved");
	assert.equal(saved.draftId, "draft-e2e");
	const edited = { to: ["henrik@example.test"], cc: ["copy@example.test"], subject: "Om Qorpera", body: "Hej Henrik,\n\nÆndret tekst om Qorpera.\nMed venlig hilsen" };
	const updated = await client.act(session, interaction, "save", edited, sponsor);
	assert.equal(updated.status, "saved");
	assert.deepEqual(updated.content, edited);
	const final = { ...edited, to: ["final@example.test"], body: "Den endelige tekst, godkendt af medlemmet.\nHere's the approved text." };
	const sent = await client.act(session, interaction, "send", final, sponsor);
	assert.equal(sent.status, "sent");
	assert.equal(sent.messageId, "sent-e2e");
	assert.equal(sent.notificationPending, false);
	assert.deepEqual(sent.content, final);
	const sendRequest = requests.at(-1);
	const replay = await fetch(`${origin}${sendRequest.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: sendRequest.body });
	assert.equal(replay.status, 200);
	assert.deepEqual((await replay.json()).content, final);
	const reopened = await new EmailDraftClient(cloud, owner, AbortSignal.timeout(10_000)).read(session, interaction);
	assert.equal(reopened.status, "sent");
	assert.deepEqual(reopened.content, final);
	assert.deepEqual(writes.map(({ method, path }) => `${method} ${path}`), ["POST /gmail/v1/users/me/drafts", "PUT /gmail/v1/users/me/drafts/draft-e2e", "POST /gmail/v1/users/me/drafts/send"]);
	const mime = Buffer.from(writes.at(-1).data.message.raw, "base64url").toString("utf8");
	assert(mime.includes("From: sender@example.test\r\n"));
	assert(mime.includes("To: final@example.test\r\n"));
	assert(mime.includes("Cc: copy@example.test\r\n"));
	assert.equal(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8"), final.body);
	const answers = JSON.parse(sql(`select coalesce(jsonb_agg(body),'[]'::jsonb) from public.qorpera_session_inputs where body->>'interactionId'=${literal(interaction)};`));
	assert.equal(answers.length, 1);
	assert.equal(answers[0].answer.messageId, "sent-e2e");
	assert.deepEqual(answers[0].answer.content, final);
	assert(!JSON.stringify(requests).includes(refreshToken));
	assert(!JSON.stringify(sent).includes(refreshToken));
	console.log("Verified: save, edit, atomic send, HTTPS replay without duplicate delivery, reopened card, one durable answer with exact approved content");
} finally {
	if (proxy) await new Promise((resolveClose) => { proxy.close(resolveClose); proxy.closeAllConnections(); });
	await service.close();
	keyring.close();
}
