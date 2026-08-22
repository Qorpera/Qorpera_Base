#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import { migrateLegacyObjects } from "./migration.ts";
import { FileSystemObjectStore } from "./object-store.ts";
import { createObjectGatewayHandler } from "./service.ts";
import { SupabaseObjectAuthority } from "./supabase-authority.ts";

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function port(environment: NodeJS.ProcessEnv): number {
	const value = Number(environment.QORPERA_OBJECT_GATEWAY_PORT ?? "8090");
	if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
		throw new Error("QORPERA_OBJECT_GATEWAY_PORT is invalid");
	}
	return value;
}

const authority = new SupabaseObjectAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
});
const store = new FileSystemObjectStore(resolve(required(process.env, "QORPERA_OBJECT_GATEWAY_STORAGE_ROOT")));
const handler = createObjectGatewayHandler({
	store,
	authority,
	controlToken: required(process.env, "QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN"),
	verifierToken: required(process.env, "QORPERA_OBJECT_GATEWAY_VERIFIER_TOKEN"),
});
if (process.argv[2] === "migrate") {
	const migrated = await migrateLegacyObjects(authority, store);
	process.stdout.write(`Migrated ${migrated} legacy object(s) to the NAS backend\n`);
} else {
	const host = process.env.QORPERA_OBJECT_GATEWAY_HOST?.trim() || "127.0.0.1";
	const server = createServer(handler);
	server.listen(port(process.env), host, () => {
		process.stdout.write(`Qorpera object gateway listening on ${host}:${port(process.env)}\n`);
	});

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => server.close(() => process.exit(0)));
	}
}
