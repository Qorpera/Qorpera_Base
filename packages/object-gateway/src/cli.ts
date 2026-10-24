#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { BankSummaryWriter } from "./bank-summary-files.ts";
import { CodingResultsWriter } from "./coding-results-files.ts";
import { CompanyFolderCreator } from "./company-folder-creation.ts";
import { ConnectionFileWriter } from "./connection-files.ts";
import { DigitalPostLetterWriter } from "./digital-post-files.ts";
import { ObjectGatewayFolderGc } from "./folder-gc.ts";
import { ObjectGatewayJournal } from "./journal.ts";
import { SupabaseMemberCompanyAuthority } from "./member-company-authority.ts";
import { MemberCompanyObservations } from "./member-observability.ts";
import { MemoryMessageEraser } from "./memory-message-eraser.ts";
import { migrateLegacyObjects } from "./migration.ts";
import { FileSystemObjectStore } from "./object-store.ts";
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

const authority = new SupabaseObjectAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
});
const store = new FileSystemObjectStore(resolve(required(process.env, "QORPERA_OBJECT_GATEWAY_STORAGE_ROOT")));
const journal = new ObjectGatewayJournal(required(process.env, "QORPERA_OBJECT_GATEWAY_STATE_ROOT"));
const replication = new ObjectGatewayReplication(journal, store, authority);
const folderGc = new ObjectGatewayFolderGc(store, replication, authority);
const memberAuthority = new SupabaseMemberCompanyAuthority({
	projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
	publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
	secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
});
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
// The company bank summary's writer (Bank connection part 3): off unless QORPERA_BANK_SUMMARY_WRITER=1; the coordinator turns
// it on. Its own database client and its own loop, as the connection-file writer's.
const bankSummaries =
	process.env.QORPERA_BANK_SUMMARY_WRITER === "1"
		? new BankSummaryWriter({
				workerId: process.env.QORPERA_BANK_SUMMARY_WORKER_ID?.trim() || randomUUID(),
				authority: new SupabaseMemberCompanyAuthority({
					projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
					publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
					secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
				}),
				store,
				replication,
			})
		: undefined;
// The Digital Post letters' writer (RUNTIME-DIGITAL-POST.md part 3): off unless QORPERA_DIGITAL_POST_WRITER=1; the
// coordinator turns it on. Its own database client and its own loop, as the connection-file writer's.
const digitalPostLetters =
	process.env.QORPERA_DIGITAL_POST_WRITER === "1"
		? new DigitalPostLetterWriter({
				workerId: process.env.QORPERA_DIGITAL_POST_WORKER_ID?.trim() || randomUUID(),
				authority: new SupabaseMemberCompanyAuthority({
					projectUrl: required(process.env, "QORPERA_SUPABASE_URL"),
					publishableKey: required(process.env, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
					secretKey: required(process.env, "QORPERA_SUPABASE_SECRET_KEY"),
				}),
				store,
				replication,
			})
		: undefined;
// The memory message eraser (M3): off unless QORPERA_MEMORY_MESSAGE_ERASER=1; the coordinator turns it on. Its own
// database client and its own loop, as the connection-file writer's.
const memoryErase =
	process.env.QORPERA_MEMORY_MESSAGE_ERASER === "1"
		? new MemoryMessageEraser({
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
	replication,
	folderGc,
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
	// The bank summary writer's own loop, every 15 s (a summary is new at most every few hours a company): one drain at a
	// time, at most ten files and 60 s per tick.
	let writingSummaries = false;
	const writeBankSummaries = async (): Promise<void> => {
		if (!bankSummaries || writingSummaries) return;
		writingSummaries = true;
		try {
			await bankSummaries.writeDue(10, AbortSignal.timeout(60_000));
		} catch {
			process.stderr.write("Bank summary writer requires operator attention\n");
		} finally {
			writingSummaries = false;
		}
	};
	const bankSummaryWrites = setInterval(() => {
		void writeBankSummaries();
	}, 15_000);
	// The Digital Post letters' own loop, every 15 s (a company gets a few letters a month; the vault fetches every ten
	// minutes): one drain at a time, at most five letters and 120 s per tick.
	let writingLetters = false;
	const writeDigitalPostLetters = async (): Promise<void> => {
		if (!digitalPostLetters || writingLetters) return;
		writingLetters = true;
		try {
			await digitalPostLetters.writeDue(5, AbortSignal.timeout(120_000));
		} catch {
			process.stderr.write("Digital Post letter writer requires operator attention\n");
		} finally {
			writingLetters = false;
		}
	};
	const digitalPostWrites = setInterval(() => {
		void writeDigitalPostLetters();
	}, 15_000);
	// The memory message eraser's own loop, every 5 s, as the coding results writer's: one pass at a time, at most ten
	// erases and 30 s per tick.
	let erasing = false;
	const eraseMemoryMessages = async (): Promise<void> => {
		if (!memoryErase || erasing) return;
		erasing = true;
		try {
			await memoryErase.eraseDue(10, AbortSignal.timeout(30_000));
		} catch {
			process.stderr.write("Memory message eraser requires operator attention\n");
		} finally {
			erasing = false;
		}
	};
	const memoryErasures = setInterval(() => {
		void eraseMemoryMessages();
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
			clearInterval(bankSummaryWrites);
			clearInterval(digitalPostWrites);
			clearInterval(memoryErasures);
			clearInterval(companyCreations);
			server.close(() => process.exit(0));
		});
	}
}
