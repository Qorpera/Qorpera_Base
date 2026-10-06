#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { CodingResultsWriter } from "./coding-results-files.ts";
import { CompanyFolderCreator } from "./company-folder-creation.ts";
import { ConnectionFileWriter } from "./connection-files.ts";
import { ObjectGatewayFolderGc } from "./folder-gc.ts";
import { ObjectGatewayJournal } from "./journal.ts";
import { SupabaseMemberCompanyAuthority } from "./member-company-authority.ts";
import { MemberCompanyObservations } from "./member-observability.ts";
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
const folderGc = new ObjectGatewayFolderGc(store, replication, authority);
const readLeases = readLeaseSeconds > 0 ? new ObjectReadLeases(journal) : undefined;
const memberAuthority = new SupabaseMemberCompanyAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
});
// The legacy company bootstrap (CompanyBootstrapProvisioner) no longer runs: new companies are created at the founding
// table, on folder-v2, by the creation loop below. A legacy bootstrap job stays queued (lobby hardening, #776's review).
// The vault's connection-file writer (P22b): off unless QORPERA_CONNECTION_FILE_WRITER=1; the coordinator turns it on.
// Its own database client (its own circuit, so a slow commit never refuses members' file requests) and its own loop.
const connectionFiles =
	process.env.QORPERA_CONNECTION_FILE_WRITER === "1"
		? new ConnectionFileWriter({
				workerId: process.env.QORPERA_CONNECTION_FILE_WORKER_ID?.trim() || randomUUID(),
				authority: new SupabaseMemberCompanyAuthority({
					projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
					publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
					secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
				}),
				store,
				replication,
				readFallback: (profileId, sha256) => authority.readLegacyObject(profileId, sha256),
			})
		: undefined;
// A coding turn's results.md writer (C3d): off unless QORPERA_CODING_RESULTS_WRITER=1; the coordinator turns it on. Its own
// database client and its own loop, as the connection-file writer's.
const codingResults =
	process.env.QORPERA_CODING_RESULTS_WRITER === "1"
		? new CodingResultsWriter({
				workerId: process.env.QORPERA_CODING_RESULTS_WORKER_ID?.trim() || randomUUID(),
				authority: new SupabaseMemberCompanyAuthority({
					projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
					publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
					secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
				}),
				store,
				replication,
			})
		: undefined;
// Company creation's worker (P14b): off unless QORPERA_COMPANY_FOLDER_CREATOR=1; the coordinator turns it on. Its own
// database client and its own loop, as the connection-file writer's.
const companyCreation =
	process.env.QORPERA_COMPANY_FOLDER_CREATOR === "1"
		? new CompanyFolderCreator({
				workerId: process.env.QORPERA_COMPANY_FOLDER_CREATOR_WORKER_ID?.trim() || randomUUID(),
				// The creation commit is one larger transaction: a longer limit than a member's call, so a slow create
				// does not open this client's circuit and refuse the release that follows.
				authority: new SupabaseMemberCompanyAuthority({
					projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
					publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
					secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
					requestTimeoutMs: 30_000,
				}),
				store,
				replication,
			})
		: undefined;
const handler = createObjectGatewayHandler({
	store,
	authority,
	controlToken: required(process.env, "QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN"),
	verifierToken: required(process.env, "QORPERA_OBJECT_GATEWAY_VERIFIER_TOKEN"),
	replication,
	folderGc,
	memberObjects: authority,
	memberFolderObjects: authority,
	// Members' folder commits (P34a) on their own database client, as the platform's writers: a slow commit never
	// opens the circuit members' reads and file requests share.
	memberFolderCommits: new SupabaseMemberCompanyAuthority({
		projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
		publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
		requestTimeoutMs: 15_000,
	}),
	// Their follow-up (F2's P15) on another client: a failing follow-up never opens the commits' circuit.
	memberFolderFollowUps: new SupabaseMemberCompanyAuthority({
		projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
		publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
		requestTimeoutMs: 3_000,
	}),
	memberObservations: new MemberCompanyObservations(),
	memberClientOrigins: JSON.parse(process.env.QORPERA_MEMBER_CLIENT_ORIGINS ?? "[]"),
	...(process.env.QORPERA_MEMBER_COMPANY_FILES === "1" ? { memberFiles: memberAuthority } : {}),
	...(process.env.QORPERA_OBJECT_GATEWAY_NATIVE_TOKEN
		? {
				nativeObjects: {
					token: required(process.env, "QORPERA_OBJECT_GATEWAY_NATIVE_TOKEN"),
					authority,
					folder: authority,
				},
			}
		: {}),
	// The folder service's puts (F3 step 3): off until its own token is configured.
	...(process.env.QORPERA_OBJECT_GATEWAY_FOLDER_SERVICE_TOKEN
		? {
				folderServiceObjects: {
					token: required(process.env, "QORPERA_OBJECT_GATEWAY_FOLDER_SERVICE_TOKEN"),
					authority,
				},
			}
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
				// One after another, so the probe and the scan never take both NAS slots at once; folder GC's quarantine
				// before the reconcile, so a replicate entry the scan writes finds its object back in place.
				store
					.probe()
					.then(() => folderGc.recover())
					.then(() => replication.reconcile()),
				readLeases?.prune(),
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
	// The connection-file writer's own loop: one drain at a time (its worker id holds at most one claim), at most ten
	// files and 60 s per tick, so it never holds up the gateway's other maintenance.
	let writing = false;
	const writeConnectionFiles = async (): Promise<void> => {
		if (!connectionFiles || writing) return;
		writing = true;
		try {
			await connectionFiles.writeDue(10, AbortSignal.timeout(60_000));
		} catch {
			process.stderr.write("Connection file writer requires operator attention\n");
		} finally {
			writing = false;
		}
	};
	const connectionFileWrites = setInterval(() => {
		void writeConnectionFiles();
	}, 15_000);
	// The coding results writer's own loop, every 5 s (an agent's revival waits up to a minute for the file): one drain at
	// a time, at most ten files and 30 s per tick.
	let writingResults = false;
	const writeCodingResults = async (): Promise<void> => {
		if (!codingResults || writingResults) return;
		writingResults = true;
		try {
			await codingResults.writeDue(10, AbortSignal.timeout(30_000));
		} catch {
			process.stderr.write("Coding results writer requires operator attention\n");
		} finally {
			writingResults = false;
		}
	};
	const codingResultsWrites = setInterval(() => {
		void writeCodingResults();
	}, 5_000);
	// Company creation's own loop: one drain at a time, at most five companies and 120 s per tick.
	let creating = false;
	const createCompanies = async (): Promise<void> => {
		if (!companyCreation || creating) return;
		creating = true;
		try {
			await companyCreation.createDue(5, AbortSignal.timeout(120_000));
		} catch {
			process.stderr.write("Company creation worker requires operator attention\n");
		} finally {
			creating = false;
		}
	};
	const companyCreations = setInterval(() => {
		void createCompanies();
	}, 15_000);
	server.listen(port(process.env), host, () => {
		process.stdout.write(`Qorpera object gateway listening on ${host}:${port(process.env)}\n`);
	});

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			clearInterval(maintenance);
			clearInterval(connectionFileWrites);
			clearInterval(codingResultsWrites);
			clearInterval(companyCreations);
			server.close(() => process.exit(0));
		});
	}
}
