import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import { isIPv4 } from "node:net";

// Execution-only routes needed by the native host. No enrollment, founding,
// payment, permit, capacity or billing RPC is available to the guest key.
export const FOUNDING_NATIVE_GUEST_RPCS = Object.freeze([
	"qorpera_identity_recovery_runtime_state",
	"qorpera_list_native_provider_account_refreshes",
	"qorpera_record_native_provider_account_metadata",
	"qorpera_validate_native_provider_execution_lease",
	"qorpera_describe_native_tool_authority",
	"qorpera_begin_native_tool_operation",
	"qorpera_complete_native_tool_operation",
	"qorpera_send_native_agent_message",
	"qorpera_append_native_interaction_request",
	"qorpera_begin_native_company_execution_v2",
	"qorpera_describe_company_run_context",
	"qorpera_read_company_run_context",
	"qorpera_record_runtime_observation",
	"qorpera_record_provider_usage_signal",
	"qorpera_record_native_context_view",
	"qorpera_read_company_path_v2",
	"qorpera_list_company_paths_v2",
	"qorpera_read_company_path",
	"qorpera_list_company_paths",
	"qorpera_confirm_company_path_read",
	"qorpera_assert_company_path_reads",
	"qorpera_list_native_connector_tools",
	"qorpera_describe_agent_open_work",
	"qorpera_native_presence_register",
	"qorpera_company_presence_scope",
	"qorpera_native_presence_subject",
	"qorpera_native_presence_forget",
	"qorpera_read_native_wake",
	"qorpera_runtime_wake_policy",
	"qorpera_assert_wake_work_allowed",
	"qorpera_assert_wake_completion",
]);
const digest = (text) => createHash("sha256").update(text).digest();
const MAX_BYTES = 2 * 1024 * 1024;

/** Private acceptance gateway for a single isolated guest. Actual edge handlers
 * own runner capability checks; native objects own live SQL binding checks.
 * The guest's opaque API key can reach only the fixed execution RPC allowlist;
 * the actual PostgREST service JWT remains inside this host process. */
export async function startFoundingNativePlatform({
	host,
	key,
	cert,
	guestKey,
	publicKey,
	serviceJwt,
	restPort,
	edges,
	nativeObjects,
	capsules,
	capsuleId: allowedCapsuleId,
	port = 0,
	transport = fetch,
}) {
	assert(isIPv4(host) && (host.startsWith("10.") || host === "127.0.0.1"));
	assert(/^[A-Za-z0-9_-]{43}$/.test(guestKey) && guestKey !== publicKey && guestKey !== serviceJwt);
	assert(Number.isInteger(restPort) && restPort > 0 && restPort <= 65535);
	assert(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(allowedCapsuleId),
		"Exact single guest capsule required",
	);
	assert(Number.isSafeInteger(port) && port >= 0 && port <= 65535);
	const expected = digest(guestKey),
		allowed = new Set(FOUNDING_NATIVE_GUEST_RPCS);
	const server = createServer(
		{ key, cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 },
		async (request, response) => {
			try {
				if (request.url?.startsWith("/v1/native-company-objects/")) {
					nativeObjects(request, response);
					return;
				}
				const edgeName = /^\/functions\/v1\/(runner-control|runner-orchestrator)$/.exec(
					request.url ?? "",
				)?.[1];
				const rpcName = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(request.url ?? "")?.[1];
				const capsuleId =
					/^\/storage\/v1\/object\/qorpera-native-compute-capsules\/([0-9a-f-]{36})\.capsule$/.exec(
						request.url ?? "",
					)?.[1];
				const guest =
					typeof request.headers.apikey === "string" &&
					timingSafeEqual(digest(request.headers.apikey), expected);
				if (
					!(edgeName && request.headers.apikey === publicKey) &&
					!(guest && ((rpcName && allowed.has(rpcName)) || (capsuleId && capsuleId === allowedCapsuleId)))
				) {
					response.writeHead(403).end();
					return;
				}
				if (capsuleId && request.method === "GET") {
					const bytes = await capsules.get(`native-capsule/${capsuleId}`);
					assert(bytes.length <= MAX_BYTES);
					response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
					return;
				}
				assert.equal(request.method, "POST");
				const chunks = [];
				let size = 0;
				for await (const chunk of request) {
					size += chunk.length;
					assert(size <= MAX_BYTES);
					chunks.push(chunk);
				}
				const body = Buffer.concat(chunks);
				if (capsuleId) {
					await capsules.put(`native-capsule/${capsuleId}`, body);
					response.writeHead(200, { "content-type": "application/json" }).end("{}");
					return;
				}
				let result;
				if (edgeName) {
					const headers = new Headers();
					for (const [name, value] of Object.entries(request.headers))
						if (typeof value === "string") headers.set(name, value);
					result = await edges[edgeName].handler(
						new Request(`https://${request.headers.host}${request.url}`, { method: "POST", headers, body }),
					);
				} else {
					result = await transport(`http://127.0.0.1:${restPort}/rpc/${rpcName}`, {
						method: "POST",
						redirect: "error",
						headers: { authorization: `Bearer ${serviceJwt}`, "content-type": "application/json" },
						body,
						signal: AbortSignal.timeout(10000),
					});
				}
				const bytes = Buffer.from(await result.arrayBuffer());
				assert(bytes.length <= MAX_BYTES);
				response.writeHead(result.status, Object.fromEntries(result.headers)).end(bytes);
			} catch {
				if (!response.headersSent) response.writeHead(503);
				response.end();
			}
		},
	);
	server.requestTimeout = 15000;
	server.headersTimeout = 15000;
	server.keepAliveTimeout = 1000;
	server.setTimeout(15000, (socket) => socket.destroy());
	server.on("upgrade", (_request, socket) => socket.destroy());
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	return {
		origin: `https://${host}:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	};
}
