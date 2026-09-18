import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BEHAVIORS = new Set([
	"safe",
	"reflect_raw",
	"reflect_url",
	"reflect_base64",
	"reflect_base64url",
	"drop_once",
	"stall",
]);
const MODES = new Set(["success", "drop_retry", "stall", "denied"]);
const CONNECTOR_ID = "step2_canary";
const OPERATION_ID = "record_marker";
const OPERATION_VERSION = 1;
const TOOL_NAME = "step2_canary_record_marker";
const DESTINATION_ORIGIN = "https://127.0.0.1:9443";
const ADAPTER_SHA256 = "68005807f937e1886229541fe8fdf293eceda2c33692d200deb4a997853ceb60";
const SERVICE_KEY_PATH = "/etc/credstore.encrypted/qorpera-supabase-service-key";
const DATABASE_URL_PATH = "/etc/credstore.encrypted/qorpera-cloud-secret-database-url";
const RUNTIME_TOKEN_PATH = "/etc/credstore.encrypted/qorpera-cloud-secret-runtime";

function fail(message) {
	throw new Error(message);
}

function record(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		fail(`${label} is invalid`);
	}
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) fail(`${label} is invalid`);
	return value;
}

function argumentsFromCommandLine(values) {
	if (values.length !== 10) fail("Step 2 canary driver arguments are invalid");
	const parsed = Object.create(null);
	for (let index = 0; index < values.length; index += 2) {
		const name = values[index];
		if (!name?.startsWith("--") || Object.hasOwn(parsed, name)) fail("Step 2 canary driver arguments are invalid");
		parsed[name] = values[index + 1];
	}
	const expected = ["--binding-base64url", "--behavior", "--grant-id", "--label", "--mode"];
	if (Object.keys(parsed).sort().join() !== expected.sort().join()) fail("Step 2 canary driver arguments are invalid");
	if (!UUID.test(parsed["--grant-id"]) || !BEHAVIORS.has(parsed["--behavior"]) || !MODES.has(parsed["--mode"]) || !LABEL.test(parsed["--label"])) {
		fail("Step 2 canary driver arguments are invalid");
	}
	let binding;
	try {
		binding = JSON.parse(Buffer.from(parsed["--binding-base64url"], "base64url").toString("utf8"));
	} catch {
		fail("Step 2 canary binding is invalid");
	}
	record(
		binding,
		["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId", "provider", "nativeHarness", "model"],
		"Step 2 canary binding",
	);
	for (const name of ["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId"]) {
		if (!UUID.test(binding[name])) fail("Step 2 canary binding is invalid");
	}
	if (binding.provider !== "openai" || binding.nativeHarness !== "codex-cli" || binding.model !== "gpt-native") {
		fail("Step 2 canary binding is invalid");
	}
	return {
		binding,
		grantId: parsed["--grant-id"],
		behavior: parsed["--behavior"],
		label: parsed["--label"],
		mode: parsed["--mode"],
	};
}

function credential(path) {
	const result = spawnSync("/usr/bin/systemd-creds", ["decrypt", path, "-"], {
		encoding: null,
		maxBuffer: 128 * 1024,
		timeout: 5000,
	});
	if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.byteLength < 1) {
		result.stdout?.fill(0);
		result.stderr?.fill(0);
		fail("Step 2 canary host credential is unavailable");
	}
	result.stderr?.fill(0);
	return result.stdout;
}

async function boundedJson(response, maximumBytes) {
	const bytes = Buffer.from(await response.arrayBuffer());
	try {
		if (bytes.byteLength > maximumBytes) fail("Step 2 canary response is too large");
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	} finally {
		bytes.fill(0);
	}
}

async function main() {
	const options = argumentsFromCommandLine(process.argv.slice(2));
	const serviceKeyBytes = credential(SERVICE_KEY_PATH);
	const databaseUrlBytes = credential(DATABASE_URL_PATH);
	const runtimeTokenBytes = credential(RUNTIME_TOKEN_PATH);
	try {
		const serviceKey = serviceKeyBytes.toString("utf8").trim();
		const databaseUrl = databaseUrlBytes.toString("utf8").trim();
		const databasePassword = decodeURIComponent(new URL(databaseUrl).password);
		const runtimeToken = runtimeTokenBytes.toString("utf8").trim();
		if (
			!serviceKey ||
			/[\0\r\n]/.test(serviceKey) ||
			!databasePassword ||
			/[\0\r\n]/.test(databasePassword) ||
			!databaseUrl.includes("qorpera_secret_broker") ||
			!/^[A-Za-z0-9_-]{43}$/.test(runtimeToken)
		) {
			fail("Step 2 canary host credential is invalid");
		}
		const supabaseOrigin = "https://mxkduffilvonpgiakzfq.supabase.co";
		const rpc = async (name, body) => {
			const response = await fetch(`${supabaseOrigin}/rest/v1/rpc/${name}`, {
				method: "POST",
				redirect: "error",
				headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				fail("Step 2 canary authority rejected the operation");
			}
			return boundedJson(response, 128 * 1024);
		};
		const operationArguments = { label: options.label, behavior: options.behavior };
		const inputSha256 = createHash("sha256").update(JSON.stringify(operationArguments)).digest("hex");
		const idempotencyKey = `canary-${options.behavior}-${randomUUID()}`;
		const receiptId = randomUUID();
		const downstreamIdempotencySha256 = createHash("sha256").update(idempotencyKey).digest("hex");
		const begun = await rpc("qorpera_begin_native_tool_operation", {
			p_binding: options.binding,
			p_receipt_id: receiptId,
			p_logical_operation_key: `${TOOL_NAME}:${options.grantId}:${idempotencyKey}`,
			p_input_sha256: inputSha256,
			p_downstream_idempotency_sha256: downstreamIdempotencySha256,
			p_requires_company_revision: false,
		});
		if (begun?.state !== "executing") fail("Step 2 canary receipt was not admitted");
		const request = {
			schema: "qorpera.cloud-secret-operation-request/v1",
			binding: options.binding,
			receiptId,
			inputSha256,
			grantId: options.grantId,
			connectorId: CONNECTOR_ID,
			operationId: OPERATION_ID,
			operationVersion: OPERATION_VERSION,
			adapterSha256: ADAPTER_SHA256,
			destinationOrigin: DESTINATION_ORIGIN,
			idempotencyKey,
			arguments: operationArguments,
		};
		const execute = async () => {
			const response = await fetch("http://127.0.0.1:9080/v1/operations", {
				method: "POST",
				redirect: "error",
				headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				return { status: response.status, content: null };
			}
			return { status: response.status, content: await boundedJson(response, 48 * 1024) };
		};
		let outcome = await execute();
		if (options.mode === "drop_retry") {
			if (outcome.status !== 403) fail("Step 2 canary lost response was not withheld");
			outcome = await execute();
		}
		if (options.mode === "stall" || options.mode === "denied") {
			if (outcome.status !== 403 || outcome.content !== null) fail("Step 2 canary denial did not fail closed");
			console.log(JSON.stringify({
				schema: "qorpera.step2-secret-canary-driver-result/v1",
				behavior: options.behavior,
				mode: options.mode,
				status: "denied",
				receiptId,
			}));
			return;
		}
		if (outcome.status !== 200 || !outcome.content) fail("Step 2 canary operation outcome is unconfirmed");
		const responseText = JSON.stringify(outcome.content);
		for (const secret of [
			serviceKey,
			databaseUrl,
			databasePassword,
			runtimeToken,
			encodeURIComponent(serviceKey),
			encodeURIComponent(databaseUrl),
			encodeURIComponent(databasePassword),
			encodeURIComponent(runtimeToken),
			Buffer.from(serviceKey).toString("base64"),
			Buffer.from(databaseUrl).toString("base64"),
			Buffer.from(databasePassword).toString("base64"),
			Buffer.from(runtimeToken).toString("base64"),
			Buffer.from(serviceKey).toString("base64url"),
			Buffer.from(databaseUrl).toString("base64url"),
			Buffer.from(databasePassword).toString("base64url"),
			Buffer.from(runtimeToken).toString("base64url"),
		]) {
			if (secret && responseText.includes(secret)) fail("Step 2 canary broker response exposed a host credential");
		}
		const result = record(outcome.content, ["kind", "value"], "Step 2 canary broker result");
		if (result.kind !== "json") fail("Step 2 canary broker result is invalid");
		const value = record(result.value, Object.keys(result.value ?? {}), "Step 2 canary connector result");
		const withheld = value.result === "withheld_sensitive_response";
		if (options.behavior.startsWith("reflect_") !== withheld) fail("Step 2 canary response fence differs");
		await rpc("qorpera_complete_native_tool_operation", {
			p_binding: options.binding,
			p_receipt_id: receiptId,
			p_input_sha256: inputSha256,
			p_result: outcome.content,
			p_output_snapshot_id: null,
			p_proposal_id: null,
		});
		console.log(JSON.stringify({
			schema: "qorpera.step2-secret-canary-driver-result/v1",
			behavior: options.behavior,
			mode: options.mode,
			status: "completed",
			receiptId,
			withheld,
			reused: value.reused === true,
		}));
	} finally {
		serviceKeyBytes.fill(0);
		databaseUrlBytes.fill(0);
		runtimeTokenBytes.fill(0);
	}
}

main().catch((error) => {
	const message = error instanceof Error && /^Step 2 canary [A-Za-z0-9 ]+$/.test(error.message)
		? error.message
		: "Step 2 secret-custody canary driver failed closed";
	console.error(message);
	process.exitCode = 1;
});
