import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { WebMemberAccount } from "../src/account.ts";
import type { MemberWebConfig } from "../src/config.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config: MemberWebConfig = {
	schema: "qorpera.member-web-config/v1",
	supabaseUrl: "https://control.test",
	publishableKey: "sb_publishable_fixture1",
	officeViewerOrigin: null,
};
const session = (n = 1) => ({ user: { id: id(n) }, access_token: `member-${n}` }) as Session;
const row = (n = 10) => ({
	profile_id: id(n),
	environment_id: id(n + 1),
	profile_name: `Company ${n}`,
	environment_name: "Main",
	role: "owner",
	contract_version: 1,
	created_at: "2026-09-08T00:00:00Z",
	bootstrap_state: "completed",
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { resolve, promise };
}
function fixture() {
	const state = {
		session: session() as Session | null,
		rows: [row(), row(20)],
		rpc: undefined as ((url: string, init: RequestInit) => Promise<Response>) | undefined,
	};
	const getSession = vi.fn(async () => ({ data: { session: state.session }, error: null }));
	const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		expect(init?.redirect).toBe("error");
		expect(init?.cache).toBe("no-store");
		if (state.rpc) return state.rpc(url, init!);
		if (url.endsWith("qorpera_list_hosted_profiles")) return Response.json(state.rows);
		if (url.endsWith("qorpera_member_office_catalog"))
			return Response.json({
				companyId: id(10),
				environmentId: id(11),
				canManage: true,
				scope: null,
				staff: [],
				nextAfter: null,
			});
		throw new Error(`Unexpected request: ${url}`);
	});
	const account = new WebMemberAccount({
		config,
		client: { auth: { getSession } } as unknown as SupabaseClient,
		fetch: request,
	});
	account.setSession(state.session);
	return { account, state, getSession, request };
}
describe("web account boundaries", () => {
	it("only opens an observed company and gives callers copies of catalog data", async () => {
		const { account } = fixture();
		expect(() => account.openCompany(id(11))).toThrow();
		const rows = await account.companies();
		rows[0].environmentId = id(999);
		expect(() => account.openCompany(id(999))).toThrow();
		expect(account.openCompany(id(11)).company.companyId).toBe(id(10));
	});
	it("company switching and leaving cancel old sessions while preserving the account", async () => {
		const { account } = fixture();
		await account.companies();
		const first = account.openCompany(id(11));
		const second = account.openCompany(id(21));
		expect(first.signal.aborted).toBe(true);
		expect(() => first.current()).toThrow();
		account.leaveCompany();
		expect(second.signal.aborted).toBe(true);
		expect(account.memberId).toBe(id(1));
	});
	it("token refresh preserves the selected company; account change cancels all old work", async () => {
		const { account, state } = fixture();
		await account.companies();
		const company = account.openCompany(id(11)),
			recovery = account.recovery();
		expect(account.setSession({ ...session(), access_token: "refreshed" })).toBe(false);
		company.current();
		state.session = session(2);
		expect(account.setSession(state.session)).toBe(true);
		expect(company.signal.aborted).toBe(true);
		expect(recovery.signal.aborted).toBe(true);
		expect(() => account.openCompany(id(11))).toThrow();
	});
	it("drops a late getSession result without sending the former account's token", async () => {
		const { account, state, getSession, request } = fixture(),
			delayed = deferred<Awaited<ReturnType<typeof getSession>>>();
		getSession.mockImplementationOnce(() => delayed.promise);
		const pending = account.companies();
		const result = expect(pending).rejects.toThrow();
		state.session = session(2);
		account.setSession(state.session);
		delayed.resolve({ data: { session: session() }, error: null });
		await result;
		expect(request).not.toHaveBeenCalled();
	});
	it("rejects a mismatched member returned by Auth even if the UI event is delayed", async () => {
		const { account, state, request } = fixture();
		state.session = session(2);
		await expect(account.companies()).rejects.toThrow("Sign in");
		expect(request).not.toHaveBeenCalled();
	});
	it("discards late Company Computer results after switching companies", async () => {
		const { account, state } = fixture();
		await account.companies();
		const first = account.openCompany(id(11)),
			delayed = deferred<Response>();
		state.rpc = async () => delayed.promise;
		const pending = first.computer.catalog(first.signal),
			result = expect(pending).rejects.toThrow();
		account.openCompany(id(21));
		delayed.resolve(
			Response.json({
				companyId: id(10),
				environmentId: id(11),
				canManage: true,
				scope: null,
				staff: [],
				nextAfter: null,
			}),
		);
		await result;
	});
	it("rejects obsolete catalog refreshes rather than overwriting newer choices", async () => {
		const { account, state } = fixture(),
			old = deferred<Response>();
		let count = 0;
		state.rpc = async () => (++count === 1 ? old.promise : Response.json([row(30)]));
		const pending = account.companies(),
			denied = expect(pending).rejects.toThrow("refreshed");
		await account.companies();
		old.resolve(Response.json([row()]));
		await denied;
		expect(() => account.openCompany(id(11))).toThrow();
		account.openCompany(id(31)).current();
	});
	it("opens a company straight to its Company Computer", async () => {
		const { account } = fixture();
		await account.companies();
		const company = account.openCompany(id(11));
		expect((await company.computer.catalog(company.signal)).scope).toBeNull();
	});
	it("accepts a company list without the legacy bootstrap_state", async () => {
		const { account, state } = fixture();
		const { bootstrap_state: _, ...current } = row();
		state.rpc = async () => Response.json([current]);
		expect((await account.companies()).map((company) => company.companyId)).toEqual([id(10)]);
	});
	it.each(["scope", "extra", "oversized", "status"])("rejects %s catalog responses", async (kind) => {
		const { account, state } = fixture();
		state.rpc = async () =>
			kind === "status"
				? new Response(null, { status: 403 })
				: Response.json(
						kind === "oversized"
							? new Array(2001).fill(row())
							: [{ ...row(), ...(kind === "extra" ? { providerToken: "never" } : { environment_id: "bad" }) }],
					);
		await expect(account.companies()).rejects.toThrow();
		expect(() => account.openCompany(id(11))).toThrow();
	});
	it("cannot infer a viewer endpoint or revive a signed-out account", async () => {
		const { account } = fixture();
		await account.companies();
		const company = account.openCompany(id(11));
		expect(() =>
			company.views({
				companyId: id(10),
				environmentId: id(11),
				companyComputerId: id(12),
				logicalComputerId: id(13),
			}),
		).toThrow("not been configured");
		account.close();
		await expect(account.companies()).rejects.toThrow("Sign in");
		expect(() => account.recovery()).toThrow();
	});
});
