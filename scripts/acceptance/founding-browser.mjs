import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { bootstrapCompanySql, computerPlansSql, modelAccountsSql, runtimeEvidenceSql, sqlUuid } from "./founding-fixtures.mjs";

async function eventually(use, message, timeout = 30000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) { const value = await use(); if (value) return value; await delay(150); }
	throw new Error(message);
}
function lastJson(output) {
	return JSON.parse(output.split("\n").filter(line => line.startsWith("{") || line.startsWith("[")).at(-1));
}

export async function runFoundingBrowser({ origin, publicKey, cluster, mail, out }) {
	const browser = await chromium.launch({ headless: true });
	const contexts = [], errors = [], blocked = [], memberTokens = new Map();
	const evidence = { steps: [], boundaries: {
		auth: "Real pinned Supabase Auth, SMTP OTP verification and signed sessions",
		database: "Real isolated PostgreSQL17, complete repository migrations, real PostgREST member role/JWT authority",
		client: "Actual production web entry, styles, auth, controllers and views; separate browser contexts",
		bootstrap: "Canonical staging/verification/finalization RPCs; storage object metadata fixture",
		modelAccounts: "Separate member-owned native-login completion/sponsor fixtures; no external ChatGPT OAuth or model execution",
		computerCapacity: "Canonical invoice-funded Basis/Standard balances, actual readiness-gated rollout enrollment and each founder's UI pool consent; Stripe payment itself is fixture, no live checkout or capacity",
		runtime: "Actual launch, turn materialization, wake and immutable startup context; no inference or physical VM dispatch",
		realtime: "Not hosted; production polling/reload paths provide shared state",
	} };
	try {
		async function member(email) {
			const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US", viewport: { width: 1440, height: 1100 } });
			contexts.push(context);
			await context.route("**/*", route => {
				const url = new URL(route.request().url());
				if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
				blocked.push(url.origin); return route.abort("blockedbyclient");
			});
			const page = await context.newPage(); page.setDefaultTimeout(20000);
			page.on("pageerror", error => errors.push(error.message));
			page.on("response", async response => {
				if (response.url().startsWith(`${origin}/auth/v1/verify`) && response.ok()) {
					const session = await response.json(); memberTokens.set(email, session.access_token);
				}
			});
			const settingsReady = page.waitForResponse(response => response.url() === `${origin}/auth/v1/settings`).then(response => response.finished());
			await page.goto(origin);
			await settingsReady;
			await page.getByLabel("Email", { exact: true }).fill(email);
			const [otpResponse] = await Promise.all([
				page.waitForResponse(response => response.url().startsWith(`${origin}/auth/v1/otp`) && response.request().method() === "POST"),
				page.getByRole("button", { name: "Continue with email", exact: true }).click(),
			]).catch(() => { throw new Error(`OTP submit was not observed for member ${contexts.length}; blocked destinations: ${blocked.length}; browser errors: ${errors.length}`); });
			if (!otpResponse.ok()) {
				// Only the fixed provider error code is retained. Never log response
				// bodies, request headers, OTPs, sessions or email addresses.
				const response = await otpResponse.json().catch(() => ({}));
				const code = typeof response.error_code === "string" && /^[a-z_]{1,80}$/.test(response.error_code) ? response.error_code : "unavailable";
				throw new Error(`Real Auth OTP request failed: HTTP ${otpResponse.status()} (${code}); SMTP ${JSON.stringify(mail.diagnostics())}`);
			}
			await page.getByLabel("Verification code", { exact: true }).fill(await mail.code(email));
			await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
			await page.getByRole("heading", { name: "Start your first company", exact: true }).waitFor();
			const userId = await cluster.query(`select id from auth.users where email='${email}' and email_confirmed_at is not null;`);
			sqlUuid(userId); assert(memberTokens.has(email), "Real Auth session not observed");
			return { page, context, email, userId };
		}
		const first = await member("founder-a@founding.example.test"), second = await member("founder-b@founding.example.test");
		assert.notEqual(first.userId, second.userId);
		evidence.steps.push("Two independent users signed in through real email OTP UI");
		async function rpc(member, name, args) {
			const result = await member.context.request.post(`${origin}/rest/v1/rpc/${name}`, { headers: { apikey: publicKey, authorization: `Bearer ${memberTokens.get(member.email)}` }, data: args });
			return { status: result.status(), body: await result.json() };
		}
		async function submit(page, name, action) {
			const [response] = await Promise.all([
				page.waitForResponse(response => response.url() === `${origin}/rest/v1/rpc/${name}` && response.request().method() === "POST"),
				action(),
			]);
			assert.equal(response.status(), 200, `${name} did not succeed`);
			await response.finished();
		}
		async function materialized(profileId) {
			return eventually(async () => {
				const runtime = lastJson(await cluster.query(runtimeEvidenceSql(profileId)));
				assert(runtime.request, "Launch request evidence is missing");
				assert.notEqual(runtime.request.status, "failed", `Launch materialization failed: ${runtime.request.failure_reason}`);
				return runtime.request.status === "materialized" ? runtime : null;
			}, "Launch remained queued at the real materializer boundary");
		}
		async function friends(member) {
			await member.page.locator(".account-trigger").click();
			await member.page.getByRole("menuitem", { name: "Friends", exact: true }).click();
			await member.page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
		}
		await friends(first);
		await first.page.getByLabel("Search friends, or type an email to add someone").fill(second.email);
		await first.page.getByRole("button", { name: "Send request", exact: true }).click();
		await first.page.getByText(`Request sent to ${second.email}.`, { exact: true }).waitFor();
		await first.page.getByRole("button", { name: "Close settings", exact: true }).click();
		await friends(second);
		await second.page.getByRole("button", { name: "Accept", exact: true }).click();
		await second.page.getByRole("button", { name: "Remove", exact: true }).waitFor();
		await second.page.getByRole("button", { name: "Close settings", exact: true }).click();
		evidence.steps.push("Friend request and acceptance completed through each member's UI");
		await first.page.getByLabel("Company name", { exact: true }).fill("Acceptance Builders");
		await first.page.getByRole("button", { name: "Create company", exact: true }).click();
		const profileId = await eventually(async () => {
			const value = await cluster.query(`select profile_id from public.qorpera_company_founding where created_by_user_id=${sqlUuid(first.userId)};`);
			return value || null;
		}, "Client did not create a founding company");
		sqlUuid(profileId);
		await cluster.query(await bootstrapCompanySql(profileId));
		await first.page.getByRole("heading", { name: "Set up your company", exact: true }).waitFor();
		assert(await first.page.getByRole("button", { name: "Start company", exact: true }).isDisabled());
		const outsider = await rpc(second, "qorpera_read_company_founding", { p_profile_id: profileId });
		assert(outsider.status >= 400, "Nonmember could read founding company");
		await first.page.getByLabel("A little about the company").fill("Build practical tools for small local businesses. Shared judgment, clear evidence, useful prototypes.");
		await submit(first.page, "qorpera_update_company_founding", () => first.page.getByRole("button", { name: "Save company details", exact: true }).click());
		await eventually(() => first.page.getByRole("button", { name: "Save company details", exact: true }).isEnabled(), "Company edit did not finish");
		await first.page.getByLabel("Choose a co-founder", { exact: true }).selectOption(second.userId);
		await submit(first.page, "qorpera_invite_company_founder", () => first.page.getByRole("button", { name: "Invite co-founder", exact: true }).click());
		await first.page.getByText("Invited", { exact: true }).waitFor();
		await second.page.reload();
		await second.page.getByRole("button", { name: "Join setup", exact: true }).click();
		await second.page.getByRole("heading", { name: "Set up your company", exact: true }).waitFor();
		const prelaunchRoles = lastJson(await cluster.query(`select jsonb_object_agg(user_id,role) from public.qorpera_profile_members where profile_id=${sqlUuid(profileId)};`));
		assert.equal(prelaunchRoles[first.userId], "owner"); assert.equal(prelaunchRoles[second.userId], "contributor");
		assert(await second.page.getByRole("button", { name: "I'm Ready", exact: true }).isDisabled());
		evidence.steps.push("Company created/bootstrap finalized; second founder explicitly joined as contributor; early launch and unconnected Ready blocked");
		await cluster.query(modelAccountsSql(profileId, [first.userId, second.userId]));
		await cluster.query(computerPlansSql([first.userId, second.userId]));
		// This isolated deployment explicitly publishes readiness. Ordinary
		// production refresh/creation enrolls paid enforcement; no per-company
		// mode row is fabricated, and individual offers remain unpublished.
		await cluster.query("update public.qorpera_computer_billing_readiness set runtime_accounting_ready=true,checkout_enabled=true where singleton;");
		const unfundedPool = await rpc(first, "qorpera_read_company_founding", { p_profile_id: profileId });
		assert.equal(unfundedPool.body.computerUsage.meterMode, "paid", "Published rollout did not enroll existing open setup");
		assert.equal(unfundedPool.body.computerUsage.canStart, false, "Paid plan or Computer Usage owner implied pool consent");
		await Promise.all([first.page.reload(), second.page.reload()]);
		await first.page.getByLabel("Your role (optional)", { exact: true }).fill("Product and customer discovery");
		await first.page.getByLabel("Contribute my Qorpera computer allowance to this company", { exact: true }).check();
		await first.page.getByRole("button", { name: "I'm Ready", exact: true }).click();
		await first.page.getByRole("button", { name: "Not ready yet", exact: true }).waitFor();
		await second.page.getByLabel("Your role (optional)", { exact: true }).fill("Engineering and delivery");
		await second.page.getByLabel("Contribute my Qorpera computer allowance to this company", { exact: true }).check();
		await second.page.getByRole("button", { name: "I'm Ready", exact: true }).click();
		await second.page.getByRole("button", { name: "Not ready yet", exact: true }).waitFor();
		const ready = await rpc(second, "qorpera_read_company_founding", { p_profile_id: profileId });
		assert.equal(ready.status, 200); assert(ready.body.seats.every(seat => seat.readyRevision === ready.body.revision));
		assert(ready.body.seats.every(seat => seat.computerPoolEnabled));
		assert.equal(ready.body.computerUsage.meterMode, "paid");
		assert.equal(ready.body.computerUsage.availableAllowance.availableUs, String(360 * 3600000000));
		const [firstUsage, secondUsage] = await Promise.all([rpc(first, "qorpera_my_computer_usage", {}), rpc(second, "qorpera_my_computer_usage", {})]);
		assert.equal(firstUsage.body.balance.availableUs, String(74 * 3600000000));
		assert.equal(secondUsage.body.balance.availableUs, String(286 * 3600000000));
		evidence.steps.push("Invoice-funded Basis and Standard plans retained separate member balances; each founder explicitly contributed through UI; combined company pool matched 360 standard hours");
		// An edit after both signatures invalidates the exact shared revision.
		await first.page.getByLabel("A little about the company").fill("Build practical tools for local businesses. Agree on the vision, validate with customers, and ship useful prototypes.");
		await first.page.getByRole("button", { name: "Save company details", exact: true }).click();
		await first.page.getByRole("button", { name: "I'm Ready", exact: true }).waitFor();
		const stale = await rpc(second, "qorpera_set_founder_ready", { p_profile_id: profileId, p_expected_revision: ready.body.revision, p_ready: true, p_role_description: "Engineering" });
		assert.equal(stale.status, 412, "Stale co-signature accepted");
		await second.page.reload();
		await first.page.getByRole("button", { name: "I'm Ready", exact: true }).click();
		await first.page.getByRole("button", { name: "Not ready yet", exact: true }).waitFor();
		await second.page.getByRole("button", { name: "I'm Ready", exact: true }).click();
		await second.page.getByRole("button", { name: "Not ready yet", exact: true }).waitFor();
		await eventually(() => second.page.getByRole("button", { name: "Start company", exact: true }).isEnabled(), "Ready founders were not allowed to start");
		await Promise.all([first.page.screenshot({ path: join(out, "founder-a-ready.png"), fullPage: true }), second.page.screenshot({ path: join(out, "founder-b-ready.png"), fullPage: true })]);
		evidence.steps.push("Both members co-signed; later company edit invalidated signatures; stale revision refused; both re-signed current vision");
		let launchRequest, lost = false;
		await second.page.route("**/rest/v1/rpc/qorpera_launch_company_founding", async route => {
			launchRequest = route.request().postDataJSON();
			const response = await route.fetch(); assert.equal(response.status(), 200);
			if (!lost) { lost = true; await route.abort("connectionreset"); } else await route.fulfill({ response });
		});
		await second.page.getByRole("button", { name: "Start company", exact: true }).click();
		await eventually(async () => (await rpc(second, "qorpera_read_company_founding", { p_profile_id: profileId })).body.phase === "launched", "Launch not committed");
		assert(lost && launchRequest, "Lost launch reply was not exercised");
		const [exactReplay, otherTab] = await Promise.all([
			rpc(second, "qorpera_launch_company_founding", launchRequest),
			rpc(first, "qorpera_launch_company_founding", { p_profile_id: profileId, p_expected_revision: 0, p_client_launch_id: randomUUID() }),
		]);
		assert.equal(exactReplay.status, 200); assert.equal(otherTab.status, 200);
		assert.deepEqual(exactReplay.body.launch, otherTab.body.launch);
		await Promise.all([first.page.reload(), second.page.reload()]);
		await eventually(async () => !first.page.url().endsWith("/founding") && !second.page.url().endsWith("/founding"), "Launched clients did not open the company");
		const runtime = await materialized(profileId);
		assert.equal(runtime.phase, "launched"); assert.equal(runtime.requestCount, 1);
		assert.deepEqual(runtime.owners.sort(), [first.userId, second.userId].sort());
		assert.equal(runtime.request.status, "materialized");
		assert.equal(runtime.run.requested_by_user_id, second.userId);
		assert.equal(runtime.run.sponsored_by_user_id, second.userId);
		assert.equal(runtime.source.authorUserId, first.userId);
		assert.equal(runtime.source.kind, "private_startup");
		const startup = JSON.parse(runtime.source.text);
		assert.equal(startup.schema, "qorpera.founding-startup/v1");
		assert.deepEqual(startup.founding, runtime.receipt);
		assert.equal(startup.founding.roster.length, 2);
		assert(startup.founding.roster.every(founder => typeof founder.displayName === "string" && founder.displayName.length));
		evidence.steps.push("Noncreator launched; lost response and two-member replay retained one launch/turn; both owners materialized with launcher's own model sponsor and immutable shared vision");
		evidence.runtime = { profileId, receiptId: runtime.receipt.receiptId, requester: second.userId, author: first.userId,
			ownerCount: runtime.owners.length, requestCount: runtime.requestCount, status: runtime.request.status,
			sourceKind: runtime.source.kind, rosterCount: startup.founding.roster.length };
		await first.page.goto(`${origin}/#/`);
		await first.page.getByRole("button", { name: /New company Seeds a Company File/ }).click();
		await first.page.getByLabel("Company name", { exact: true }).fill("Acceptance Solo");
		await first.page.getByRole("button", { name: "Create", exact: true }).click();
		const soloId = await eventually(async () => {
			const value = await cluster.query(`select profile_id from public.qorpera_company_founding where created_by_user_id=${sqlUuid(first.userId)} and profile_id<>${sqlUuid(profileId)};`);
			return value || null;
		}, "Solo company creation did not arrive");
		await cluster.query(await bootstrapCompanySql(soloId));
		await first.page.getByRole("heading", { name: "Set up your company", exact: true }).waitFor();
		await cluster.query(modelAccountsSql(soloId, [first.userId]));
		assert.equal(await cluster.query(`select public.qorpera_company_paid_computer_mode(${sqlUuid(soloId)});`), "t", "Published creation did not enroll paid enforcement");
		await first.page.reload();
		await first.page.getByLabel("Contribute my Qorpera computer allowance to this company", { exact: true }).check();
		await first.page.getByRole("button", { name: "I'm Ready", exact: true }).click();
		await eventually(() => first.page.getByRole("button", { name: "Start company", exact: true }).isEnabled(), "Solo Ready did not enable launch");
		await first.page.getByRole("button", { name: "Start company", exact: true }).click();
		await eventually(async () => (await rpc(first, "qorpera_read_company_founding", { p_profile_id: soloId })).body.phase === "launched", "Solo launch did not commit");
		const solo = await materialized(soloId);
		assert.deepEqual(solo.owners, [first.userId]); assert.equal(solo.requestCount, 1);
		assert.equal(solo.request.status, "materialized"); assert.equal(solo.run.sponsored_by_user_id, first.userId);
		assert.equal(JSON.parse(solo.source.text).founding.roster.length, 1);
		assert.equal(await cluster.query("select count(*) from public.qorpera_computer_allowance_buckets;"), "2", "Solo company duplicated global paid allowance");
		const soloUsage = await rpc(first, "qorpera_my_computer_usage", {});
		assert.equal(soloUsage.body.balance.availableUs, String(74 * 3600000000), "Founding debited a plan before any physical computer ran");
		evidence.steps.push("Solo founder also created, readied and launched through actual UI, producing one owner and one materialized turn");
		assert.deepEqual(blocked, [], "Browser attempted a nonlocal network destination");
		assert.deepEqual(errors, [], "Production web client threw uncaught browser errors");
		return evidence;
	} catch (error) {
		if (error instanceof Error) error.message += `\nCompleted acceptance steps: ${evidence.steps.join("; ")}`;
		throw error;
	} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); memberTokens.clear(); }
}
