import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";

// Acceptance transport only. No enrollment, member RPCs, funding dispatcher,
// arbitrary REST or replacement SQL authority is exposed to the guest.
export const OFFICE_GUEST_RPCS = Object.freeze([
	"qorpera_check_runtime_office_startup",
	"qorpera_report_runtime_office_ready",
	"qorpera_check_runtime_office_guest_binding",
	"qorpera_runtime_office_supervisor_status",
	"qorpera_runtime_office_privacy_status",
	"qorpera_ack_runtime_office_drain",
	"qorpera_ack_runtime_office_privacy",
	"qorpera_check_runtime_office_private_surface",
	"qorpera_check_runtime_office_shared_surface",
	"qorpera_runtime_office_screen_appearance",
]);
export const OFFICE_PROVIDER_RPCS = Object.freeze([
	...OFFICE_GUEST_RPCS,
	"qorpera_runtime_node_inventory_context",
	"qorpera_observe_runtime_node_inventory",
	"qorpera_observe_runtime_node",
	"qorpera_observe_runtime_node_health",
	"qorpera_observe_computer_usage",
	"qorpera_read_node_computer_usage",
	"qorpera_suspend_runtime_node_machine",
	"qorpera_reconcile_runtime_office_idle",
	"qorpera_prepare_runtime_office_successor",
	"qorpera_runtime_office_successor_status",
	"qorpera_check_runtime_office_successor",
	"qorpera_activate_runtime_office_successor",
	"qorpera_prepare_runtime_office_boot_successor",
	"qorpera_runtime_office_boot_successor_status",
	"qorpera_check_runtime_office_boot_successor",
	"qorpera_activate_runtime_office_boot_successor",
	"qorpera_prepare_runtime_office_boot_intent",
	"qorpera_runtime_office_boot_intent_status",
	"qorpera_check_runtime_office_boot_intent",
	"qorpera_check_office_package_invocation",
	"qorpera_ack_office_package_invocation",
	"qorpera_reserve_runtime_node_machine",
	"qorpera_runtime_office_provider_status",
	"qorpera_runtime_office_provider_activation",
	"qorpera_reserve_runtime_office_start",
	"qorpera_check_runtime_office_start",
	"qorpera_check_runtime_office_adoption",
	"qorpera_prepare_runtime_office_activation",
	"qorpera_runtime_office_activation_status",
	"qorpera_activate_runtime_office",
	"qorpera_begin_runtime_office_lifecycle",
	"qorpera_runtime_office_lifecycle_status",
	"qorpera_prepare_runtime_office_stop",
	"qorpera_ack_runtime_office_stop",
	"qorpera_runtime_office_stop_status",
	"qorpera_paid_office_admission",
	"qorpera_describe_runtime_computer_permit",
	"qorpera_prepare_runtime_computer_permit",
	"qorpera_bind_runtime_computer_permit",
	"qorpera_checkpoint_runtime_computer_permit",
	"qorpera_renew_runtime_computer_permit",
	"qorpera_finish_runtime_computer_permit",
	"qorpera_abandon_runtime_computer_permit",
	"qorpera_describe_runtime_computer_prestart",
	"qorpera_register_runtime_office_computer_outage",
	"qorpera_prepare_runtime_office_outage_recovery",
	"qorpera_check_runtime_office_outage_recovery",
	"qorpera_runtime_office_outage_recovery_status",
	"qorpera_prepare_runtime_office_outage_termination",
	"qorpera_ack_runtime_office_outage_termination",
	"qorpera_check_runtime_office_outage_configuration",
	"qorpera_prepare_runtime_office_outage_successor",
	"qorpera_runtime_office_outage_successor_status",
	"qorpera_check_runtime_office_outage_successor",
	"qorpera_activate_runtime_office_outage_successor",
]);
const REQUEST_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TYPES = new Set(["json", "jsonb", "text", "uuid", "bigint", "integer", "boolean", "timestamp with time zone", "text[]", "uuid[]"]);
const guestMethods = new Set(OFFICE_GUEST_RPCS);
const providerMethods = new Set(OFFICE_PROVIDER_RPCS);
const secretDigest = (value) => createHash("sha256").update(value).digest();
const unavailable = () => new Error("OFFICE_ACCEPTANCE_RPC_UNAVAILABLE");

/** Discover only named, scalar-returning production functions. Refuse overloads,
 * unsupported types or a missing migrated function instead of guessing casts. */
export async function loadOfficeRpcSignatures(query) {
	const names = OFFICE_PROVIDER_RPCS.map((name) => `'${name}'`).join(",");
	const sql = `select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'set',p.proretset,'defaults',p.pronargdefaults,
 'args',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proargnames[a.ordinality],'type',format_type(a.type_oid,null)) order by a.ordinality),'[]'::jsonb)
 from unnest(p.proargtypes::oid[]) with ordinality a(type_oid,ordinality)))),'[]'::jsonb)
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in (${names}) and p.prokind='f';`;
	let rows;
	try { rows = JSON.parse(await query(sql, { timeoutMs: 10000, maxOutputBytes: 256 * 1024 })); }
	catch { throw new Error("OFFICE_ACCEPTANCE_SIGNATURES_UNAVAILABLE"); }
	if (!Array.isArray(rows)) throw new Error("OFFICE_ACCEPTANCE_SIGNATURES_INVALID");
	const signatures = new Map();
	for (const row of rows) {
		if (!providerMethods.has(row.name) || signatures.has(row.name) || row.set !== false || !Array.isArray(row.args) ||
			!Number.isInteger(row.defaults) || row.defaults < 0 || row.defaults > row.args.length ||
			row.args.some((arg) => !/^p_[a-z0-9_]+$/.test(arg.name) || !TYPES.has(arg.type)) ||
			new Set(row.args.map((arg) => arg.name)).size !== row.args.length) throw new Error("OFFICE_ACCEPTANCE_SIGNATURES_INVALID");
		signatures.set(row.name, row);
	}
	if (signatures.size !== providerMethods.size) throw new Error("OFFICE_ACCEPTANCE_MIGRATIONS_INCOMPLETE");
	return signatures;
}

function invocationSql(signature, args) {
	const supplied = Object.keys(args);
	if (supplied.some((key) => !signature.args.some((arg) => arg.name === key)) ||
		signature.args.slice(0, signature.args.length - signature.defaults).some((arg) => !Object.hasOwn(args, arg.name))) return null;
	const selected = signature.args.filter((arg) => Object.hasOwn(args, arg.name));
	const payload = Buffer.from(JSON.stringify(args)).toString("base64");
	// psql quotes :'office_args'; base64 carries no quotes, newline or metacommand.
	// jsonb_to_record performs PostgreSQL's own typed argument conversion. Omitted
	// optional names remain omitted so the actual function default is preserved.
	const input = selected.length ? `with input as (select * from jsonb_to_record(convert_from(decode(:'office_args','base64'),'UTF8')::jsonb) as args(${selected.map((arg) => `${arg.name} ${arg.type}`).join(",")}))` : "";
	const parameters = selected.map((arg) => `${arg.name} => (select ${arg.name} from input)`).join(",");
	return `\\set office_args ${payload}\nbegin;\nset local role service_role;\nset local request.jwt.claims='{"role":"service_role"}';\nset local statement_timeout='2000ms';\nset local lock_timeout='1500ms';\n${input}\nselect coalesce(to_jsonb(public.${signature.name}(${parameters})),'null'::jsonb);\ncommit;\n`;
}

/** TLS material is generated by the caller. Never relax peer validation in the
 * guest/provider: install the fixture CA and use the certificate's real SAN. */
export async function startOfficeRpcServer({ query, tls, tokens, listen, onSample }) {
	if (typeof query !== "function" || !tls?.key || !tls?.cert || !tokens ||
		![tokens.guest, tokens.provider].every((token) => typeof token === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(token)) ||
		tokens.guest === tokens.provider || typeof listen?.host !== "string" || !Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535)
		throw new Error("INVALID_OFFICE_ACCEPTANCE_SERVER");
	const signatures = await loadOfficeRpcSignatures(query);
	const guest = secretDigest(tokens.guest), provider = secretDigest(tokens.provider);
	let pending = 0;
	const server = createServer({ ...tls, minVersion: "TLSv1.2", maxHeaderSize: 8192 }, async (request, response) => {
		const reply = (status, value) => {
			if (response.destroyed || response.writableEnded) return;
			const body = JSON.stringify(value);
			response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }).end(body);
		};
		const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
		if (!bearer || request.headers.apikey !== bearer) { reply(401, { error: "Unauthorized" }); return; }
		const digest = secretDigest(bearer);
		const allowed = timingSafeEqual(digest, provider) ? providerMethods : timingSafeEqual(digest, guest) ? guestMethods : null;
		if (!allowed) { reply(401, { error: "Unauthorized" }); return; }
		const name = request.url?.match(/^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/)?.[1];
		if (request.method !== "POST" || !name || !allowed.has(name)) { reply(403, { error: "RPC forbidden" }); return; }
		if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || request.headers["content-encoding"]) {
			reply(415, { error: "JSON required" }); return;
		}
		if (pending >= 16) { reply(503, { error: "RPC unavailable" }); return; }
		pending++;
		const lifetime = new AbortController(), timer = setTimeout(() => { lifetime.abort(); request.destroy(); }, 3000);
		const disconnected = () => { if (!response.writableEnded) lifetime.abort(); };
		response.once("close", disconnected);
		try {
			const chunks = []; let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > REQUEST_LIMIT) { reply(413, { error: "Request too large" }); request.resume(); return; } chunks.push(chunk); }
			let args;
			try { args = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))); }
			catch { reply(400, { error: "Invalid JSON" }); return; }
			if (!args || typeof args !== "object" || Array.isArray(args)) { reply(400, { error: "Invalid arguments" }); return; }
			const sql = invocationSql(signatures.get(name), args);
			if (!sql) { reply(400, { error: "Invalid arguments" }); return; }
			lifetime.signal.throwIfAborted();
			// Capture the authorized observation before SQL: a disconnected caller
			// may lose the response after COMMIT. The oracle joins observation IDs
			// against committed rows, excluding requests the database rejected.
			// Never retain executor secrets or the surrounding RPC request.
			if (args.p_request?.sample && onSample) onSample({ method: name, permitId: args.p_request.permitId, sample: structuredClone(args.p_request.sample) });
			const output = await query(sql, { signal: lifetime.signal, timeoutMs: 2500, maxOutputBytes: RESPONSE_LIMIT + 1 });
			lifetime.signal.throwIfAborted();
			if (Buffer.byteLength(output) > RESPONSE_LIMIT) throw unavailable();
			const value = JSON.parse(output);
			if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_LIMIT) throw unavailable();
			reply(200, value);
		} catch { reply(503, { error: "RPC unavailable" }); }
		finally { clearTimeout(timer); response.removeListener("close", disconnected); pending--; }
	});
	server.requestTimeout = 4000; server.headersTimeout = 4000; server.keepAliveTimeout = 1000;
	server.setTimeout(4000, (socket) => socket.destroy());
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listen.port, listen.host, resolve); });
	return { address: server.address(), signatures, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
