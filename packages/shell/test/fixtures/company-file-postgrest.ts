import { createHash, randomUUID } from "node:crypto";
import type { CloudCompanyPathPlan } from "@qorpera/cloud-client/company-path-schema";
import type { CloudCompanyTreeEntry } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { nativeToolAuthorityFixture } from "./native-tool-authority-fixture.ts";

/** A PostgreSQL error as PostgREST reports it: a custom PTxyz SQLSTATE becomes HTTP xyz. */
export class FakeSqlError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function status(code: string): number {
	if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
	if (code === "42501") return 403;
	if (code === "22023") return 400;
	return 500;
}

/**
 * The real HTTP adapter and the real path gateway over a fake PostgREST. Only
 * the plain trusted read/list and the governed check/prepare/commit RPCs are
 * emulated, with the migrations' order of checks: a completed operation key
 * replays first; then a stale expected version is PT412
 * (20260828019950_company_path_preconditions); a moved head at commit is PT409;
 * a continuation page on a moved snapshot is PT412
 * (20260828019960_runtime_request_preconditions). A deletion leaves a
 * tombstone that keeps a version, as qorpera_publish_company_path does, so
 * recreating the path must name it. Authority is not modelled.
 */
export function companyFilePostgrest() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const objects = new Map<string, Uint8Array>();
	const transport: CloudObjectTransport = {
		put: async (path, bytes) => {
			if (objects.has(path)) return "exists";
			objects.set(path, Uint8Array.from(bytes));
			return "stored";
		},
		get: async (path) => {
			const bytes = objects.get(path);
			if (!bytes) throw new Error("Missing fixture object");
			return bytes;
		},
	};
	const store = new CloudContentAddressedStore(transport);
	const entries = new Map<string, { version: string; entry: CloudCompanyTreeEntry | null }>();
	const receipts = new Map<string, unknown>();
	let head = randomUUID();
	/** Every RPC as it crossed HTTP, with the status PostgREST answered. */
	const requests: { method: string; path: string | null; status: number }[] = [];
	/** Runs before an RPC is handled: a concurrent writer, or an injected SQL error. */
	const before: { hook?: (method: string, args: Record<string, unknown>) => Promise<void> | void } = {};

	const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const moveHead = () => {
		head = randomUUID();
	};
	const directory = (path: string) => {
		for (let folder = path; folder; folder = parent(folder))
			if (!entries.get(folder)?.entry)
				entries.set(folder, { version: randomUUID(), entry: { kind: "directory", path: folder } });
	};
	/** Another writer (a member, or another run of the same agent) changes a file. */
	const seed = async (path: string, text: string) => {
		directory(parent(path));
		const file = await store.putFile(identity.companyId, Buffer.from(text), "application/octet-stream");
		entries.set(path, { version: randomUUID(), entry: { kind: "file", path, executable: false, file } });
		moveHead();
	};
	/** Another writer deletes a file or an empty folder: a tombstone with a fresh version. */
	const remove = (path: string) => {
		entries.set(path, { version: randomUUID(), entry: null });
		moveHead();
	};
	/** Another writer stores bytes a notebook cannot read (too large, or not UTF-8). */
	const seedBytes = async (path: string, bytes: Uint8Array) => {
		directory(parent(path));
		const file = await store.putFile(identity.companyId, bytes, "application/octet-stream");
		entries.set(path, { version: randomUUID(), entry: { kind: "file", path, executable: false, file } });
		moveHead();
	};
	const text = async (path: string): Promise<string | null> => {
		const found = entries.get(path)?.entry;
		if (!found || found.kind !== "file") return null;
		const manifest = JSON.parse(
			Buffer.from(objects.get(`${identity.companyId}/${found.file.manifestSha256}`)!).toString("utf8"),
		) as { chunks: { sha256: string }[] };
		return Buffer.concat(
			manifest.chunks.map((chunk) => Buffer.from(objects.get(`${identity.companyId}/${chunk.sha256}`)!)),
		).toString("utf8");
	};

	const stale = (plan: CloudCompanyPathPlan) => {
		const current = entries.get(plan.path);
		if ((current?.version ?? null) !== plan.expectedVersion)
			throw new FakeSqlError("PT412", "Company File path version changed");
		if (plan.entry === null && !current?.entry)
			throw new FakeSqlError("PT412", "Company File deletion target is unavailable");
	};
	const sql = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
		if (method === "qorpera_verify_company_path_file") return null;
		if (method === "qorpera_verify_company_path_tree")
			return createHash("sha256")
				.update(args.p_manifest_text as string)
				.digest("hex");
		if (
			JSON.stringify(args.p_binding) !== JSON.stringify(binding) ||
			args.p_environment_id !== identity.environmentId
		)
			throw new FakeSqlError("42501", "Native Company File binding differs");
		if (method === "qorpera_read_company_path") {
			const found = entries.get(args.p_path as string);
			return {
				path: args.p_path,
				version: found?.version ?? null,
				entry: found?.entry ?? null,
				manifestBytes:
					found?.entry?.kind === "file"
						? objects.get(`${identity.companyId}/${found.entry.file.manifestSha256}`)!.length
						: null,
				companyId: identity.companyId,
			};
		}
		if (method === "qorpera_list_company_paths") {
			const limit = args.p_limit as number;
			const after = args.p_after as string | null;
			if (
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 100 ||
				(after !== null && args.p_snapshot_id === null)
			)
				throw new FakeSqlError("22023", "Company File page is invalid");
			if (args.p_snapshot_id !== null && args.p_snapshot_id !== head)
				throw new FakeSqlError("PT412", "Company File page changed");
			const visible = [...entries.entries()]
				.filter(
					([path, { entry }]) =>
						entry !== null && parent(path) === args.p_path && (after === null || path > after),
				)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.slice(0, limit + 1);
			const items = visible.slice(0, limit).map(([path, { version, entry }]) => ({
				path,
				version,
				kind: entry!.kind,
				bytes: entry!.kind === "file" ? entry!.file.bytes : null,
			}));
			const hasMore = visible.length > limit;
			return { snapshotId: head, items, hasMore, nextAfter: hasMore ? items.at(-1)!.path : null };
		}
		const plan = args.p_plan as CloudCompanyPathPlan;
		const receipt = receipts.get(plan.operationKey);
		if (method === "qorpera_check_company_path_mutation") {
			if (receipt) return { state: "completed", result: receipt };
			stale(plan);
			return { state: "ready" };
		}
		if (method === "qorpera_prepare_company_path_mutation") {
			if (receipt) return { state: "completed", result: receipt };
			stale(plan);
			return {
				state: "ready",
				snapshotId: head,
				entries: [...entries.values()].flatMap(({ entry }) => (entry ? [entry] : [])),
			};
		}
		if (method === "qorpera_commit_company_path_mutation") {
			if (receipt) return receipt;
			stale(plan);
			if (args.p_expected_head !== head) throw new FakeSqlError("PT409", "Company File head changed");
			const version = randomUUID();
			entries.set(plan.path, { version, entry: plan.entry });
			moveHead();
			const result = {
				schema: "qorpera.company-path-result/v1",
				state: "applied",
				operationKey: plan.operationKey,
				path: plan.path,
				version,
				snapshotId: head,
				receiptId: randomUUID(),
				proposalId: null,
			};
			receipts.set(plan.operationKey, result);
			return result;
		}
		throw new FakeSqlError("42883", `Unexpected fixture RPC ${method}`);
	};

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const method = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
		const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const path =
			typeof args.p_path === "string"
				? args.p_path
				: ((args.p_plan as CloudCompanyPathPlan | undefined)?.path ?? null);
		try {
			await before.hook?.(method, args);
			const value = await sql(method, args);
			requests.push({ method, path, status: value === null ? 204 : 200 });
			return value === null ? new Response(null, { status: 204 }) : Response.json(value);
		} catch (error) {
			if (!(error instanceof FakeSqlError)) throw error;
			requests.push({ method, path, status: status(error.code) });
			return Response.json(
				{ code: error.code, message: error.message, details: null, hint: null },
				{ status: status(error.code) },
			);
		}
	};
	const control = new HttpCloudCompanyPathControl({
		supabaseUrl: "https://authority.example",
		serviceRoleKey: "synthetic-service-key",
		fetch,
	});
	const gateway = new CloudCompanyPathGateway({ binding, identity, control, store });
	return {
		binding,
		identity,
		gateway,
		store,
		entries,
		requests,
		before,
		seed,
		seedBytes,
		remove,
		directory,
		text,
		moveHead,
	};
}
