// P3's object gateway, inside the proof's throwaway node (test/prove-coding-session-vm.sh): the gateway's own handler
// (packages/object-gateway/src/service.ts) with the folder service's route (`PUT /v1/folder-service-objects/…`), on the
// node's object store, with the gateway's SQL authority on the test database through the stand-in PostgREST
// (test/p3-postgrest.mjs). What a coding machine writes on its folder view reaches the store this way, as on a node.
// The gateway's loops (health probes, replication, folder GC, the platform's writers) do not run: the proof's database
// has no storage or auth API for them. The environment is the gateway's unit's (packages/object-gateway/src/cli.ts).
//   node p3-objects.mjs  (listens on 127.0.0.1:8090)
import { createServer } from "node:http";
import { resolve } from "node:path";
import { ObjectGatewayJournal } from "../../../packages/object-gateway/src/journal.ts";
import { FileSystemObjectStore } from "../../../packages/object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../../packages/object-gateway/src/replication.ts";
import { createObjectGatewayHandler } from "../../../packages/object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../../packages/object-gateway/src/supabase-authority.ts";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const authority = new SupabaseObjectAuthority({
	projectUrl: required("QORPERA_SUPABASE_URL"),
	publishableKey: required("QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required("QORPERA_SUPABASE_SECRET_KEY"),
});
const store = new FileSystemObjectStore(resolve(required("QORPERA_OBJECT_GATEWAY_STORAGE_ROOT")));
const replication = new ObjectGatewayReplication(
	new ObjectGatewayJournal(required("QORPERA_OBJECT_GATEWAY_STATE_ROOT")),
	store,
	authority,
);
const handler = createObjectGatewayHandler({
	store,
	authority,
	controlToken: required("QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN"),
	replication,
	folderServiceObjects: { token: required("QORPERA_OBJECT_GATEWAY_FOLDER_SERVICE_TOKEN"), authority },
});
const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
	response.once("finish", () =>
		process.stderr.write(`${JSON.stringify({ method: request.method, path: request.url, status: response.statusCode })}\n`),
	);
	handler(request, response);
});
server.listen(8090, "127.0.0.1", () => process.stdout.write("P3 objects listening on 127.0.0.1:8090\n"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
