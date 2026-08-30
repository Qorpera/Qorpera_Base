#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { CompanyBootstrapProvisioner } from "./company-bootstrap.ts";
import { ObjectGatewayJournal } from "./journal.ts";
import { SupabaseMemberCompanyAuthority } from "./member-company-authority.ts";
import { migrateLegacyObjects } from "./migration.ts";
import { FileSystemObjectStore } from "./object-store.ts";
import { ObjectReadLeases } from "./read-lease.ts";
import { ObjectGatewayReplication } from "./replication.ts";
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

const readLeaseSeconds = Number(process.env.QORPERA_OBJECT_READ_LEASE_SECONDS ?? "0");
const authority = new SupabaseObjectAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
	readLeaseSeconds,
});
const store = new FileSystemObjectStore(resolve(required(process.env, "QORPERA_OBJECT_GATEWAY_STORAGE_ROOT")));
const journal = new ObjectGatewayJournal(required(process.env, "QORPERA_OBJECT_GATEWAY_STATE_ROOT"));
const replication = new ObjectGatewayReplication(journal, store, authority);
const readLeases = readLeaseSeconds > 0 ? new ObjectReadLeases(journal) : undefined;
const memberAuthority = new SupabaseMemberCompanyAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
});
const companyBootstrap = new CompanyBootstrapProvisioner({
	workerId: process.env.QORPERA_COMPANY_BOOTSTRAP_WORKER_ID?.trim() || randomUUID(),
	authority: memberAuthority,
	store,
	replication,
	authorizeServiceDownload: (profileId, sha256) => authority.authorizeServiceDownload(profileId, sha256),
	readLegacyObject: (profileId, sha256) => authority.readLegacyObject(profileId, sha256),
});
const handler = createObjectGatewayHandler({
	store,
	authority,
	controlToken: required(process.env, "QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN"),
	verifierToken: required(process.env, "QORPERA_OBJECT_GATEWAY_VERIFIER_TOKEN"),
	replication,
	memberObjects: authority,
	...(process.env.QORPERA_MEMBER_COMPANY_FILES === "1" ? { memberFiles: memberAuthority } : {}),
	...(process.env.QORPERA_OBJECT_GATEWAY_NATIVE_TOKEN
		? { nativeObjects: { token: required(process.env, "QORPERA_OBJECT_GATEWAY_NATIVE_TOKEN"), authority } }
		: {}),
	...(readLeases
		? { readLeases, revocationToken: required(process.env, "QORPERA_OBJECT_GATEWAY_REVOCATION_TOKEN") }
		: {}),
});
if (process.argv[2] === "migrate") {
	const migrated = await migrateLegacyObjects(authority, store);
	process.stdout.write(`Migrated ${migrated} legacy object(s) to the NAS backend\n`);
} else {
	const host = process.env.QORPERA_OBJECT_GATEWAY_HOST?.trim() || "127.0.0.1";
	const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, handler);
	let maintaining = false;
	const maintain = async (): Promise<void> => {
		if (maintaining) return;
		maintaining = true;
		try {
			await Promise.all([
				authority.probeHealth(),
				store.probe(),
				replication.reconcile(),
				readLeases?.prune(),
				companyBootstrap.provisionOne(),
			]);
		} catch {
			process.stderr.write("Object gateway maintenance requires operator attention\n");
		} finally {
			maintaining = false;
		}
	};
	const maintenance = setInterval(() => {
		void maintain();
	}, 15_000);
	void maintain();
	server.listen(port(process.env), host, () => {
		process.stdout.write(`Qorpera object gateway listening on ${host}:${port(process.env)}\n`);
	});

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			clearInterval(maintenance);
			server.close(() => process.exit(0));
		});
	}
}
