import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { join, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runFoundingNative, foundingOptions } from "./founding-native.mjs";
import { runFoundingBrowser } from "./founding-browser.mjs";
import { prepareFoundingBootstrap } from "./founding-bootstrap.mjs";
import {
	handleComputerBilling,
	createComputerBillingRpc,
	STRIPE_API_VERSION,
	verifyStripeSignature,
} from "../../supabase/functions/computer-billing/computer-billing.ts";
export function hostedFoundingOptions(args) {
	const extra = {},
		native = [];
	for (let i = 0; i < args.length; i += 2) {
		const name = args[i],
			value = args[i + 1];
		if (["--stripe-cli", "--stripe-key"].includes(name)) {
			assert(
				typeof value === "string" &&
					isAbsolute(value) &&
					resolve(value) === value &&
					value !== "/" &&
					!/[\x00-\x20\x7f'\\]/.test(value) &&
					extra[name] === undefined,
				"Exact private Stripe paths required",
			);
			extra[name] = value;
		} else native.push(name, value);
	}
	assert(extra["--stripe-cli"] && extra["--stripe-key"], "Require --stripe-cli and --stripe-key");
	return { ...foundingOptions(native), stripeCli: extra["--stripe-cli"], stripeKey: extra["--stripe-key"] };
}
export async function protectedStripeTestKey(path) {
	const stat = await lstat(path);
	assert(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.uid === process.getuid() &&
			(stat.mode & 0o077) === 0 &&
			stat.size <= 512,
		"Owned private test key file required",
	);
	assert.equal(await realpath(path), path, "Canonical private test key path required");
	const secret = (await readFile(path, "utf8")).trim().replace(/^QORPERA_STRIPE_SECRET_KEY=/, "");
	assert(/^sk_test_[A-Za-z0-9]+$/.test(secret), "Only a Stripe test-mode key is allowed");
	return secret;
}

/** Real payment setup for the disposable native platform only. The browser
 * receives ordinary Auth credentials; billing authority remains server-side. */
export async function prepareHostedFoundingScenario(platform, configuration) {
	const { secret, stripeCli, out } = configuration;
	assert(/^sk_test_[A-Za-z0-9]+$/.test(secret), "Only Stripe test mode is allowed");
	const runId = randomUUID(),
		objects = { products: [], prices: [], customers: [], sessions: [], subscriptions: [] };
	const checks = [],
		deliveries = [],
		events = new Map();
	const quote = (s) => `'${s.replaceAll("'", "''")}'`;
	let phase = "setup";
	async function provider(path, method = "GET", fields) {
		const response = await fetch(`https://api.stripe.com/v1/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${secret}`,
				"Stripe-Version": STRIPE_API_VERSION,
				...(method === "POST"
					? {
							"content-type": "application/x-www-form-urlencoded",
							"Idempotency-Key": `qorpera-hosted-${runId}-${createHash("sha256")
								.update(path + JSON.stringify(fields))
								.digest("hex")}`,
						}
					: {}),
			},
			...(fields ? { body: new URLSearchParams(fields) } : {}),
			signal: AbortSignal.timeout(20000),
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Stripe ${path.split("/")[0]} HTTP ${response.status}`);
		}
		const value = await response.json();
		assert(value.livemode === undefined || value.livemode === false);
		return value;
	}
	async function until(read, accept, label, ms = 90000) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			const value = await read();
			if (accept(value)) return value;
			await delay(250);
		}
		throw new Error(`Checkout acceptance timeout: ${label}`);
	}
	const { cluster, gateway, jwtSecret, authPort, restPort, privateRoot } = platform;
	const bridge = randomBytes(48).toString("hex");
	const jwtPart = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
	const head = `${jwtPart({ alg: "HS256", typ: "JWT" })}.${jwtPart({ role: "service_role", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
	const serviceJwt = `${head}.${createHmac("sha256", jwtSecret).update(head).digest("base64url")}`;
	const options = {
		stripeSecretKey: secret,
		webhookSecret: "pending",
		returnUrl: gateway.origin,
		portalConfigurationId: "",
		liveMode: false,
		pricePlans: {},
		now: Date.now,
		authenticate: async (token) => {
			const response = await fetch(`http://127.0.0.1:${authPort}/user`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) {
				await response.body?.cancel();
				return null;
			}
			const user = await response.json();
			return typeof user.id === "string" ? user.id : null;
		},
		rpc: createComputerBillingRpc(gateway.origin, serviceJwt, bridge, async (url, init) => {
			const target = new URL(String(url));
			assert.equal(target.origin, gateway.origin);
			assert.equal(target.pathname, "/rest/v1/rpc/qorpera_computer_billing_rpc");
			return fetch(`http://127.0.0.1:${restPort}/rpc/qorpera_computer_billing_rpc`, init);
		}),
		fetch: async (url, init) => {
			const target = new URL(String(url));
			assert.equal(target.origin, "https://api.stripe.com");
			const response = await fetch(url, init);
			if (response.ok && init?.method === "POST") {
				const v = await response.clone().json();
				if (v.object === "customer") objects.customers.push(v.id);
				if (v.object === "checkout.session") objects.sessions.push(v.id);
			}
			return response;
		},
	};
	let server, listener, memberId, sessionId, page, bootstrap;
	let listenerExited = false,
		listenerClosed;
	const browserSignals = [];
	const close = async () => {
		const failures = [];
		try {
			if (page && !page.isClosed()) {
				await page.screenshot({ path: join(out, "final-ui.png"), fullPage: true });
				await writeFile(
					join(out, "browser-diagnostics.json"),
					JSON.stringify(
						{
							phase,
							browserSignals,
							location: new URL(page.url()).origin,
							inputs: await page
								.locator("input")
								.evaluateAll((nodes) => nodes.map((n) => ({ name: n.name, id: n.id, type: n.type }))),
							frames: await Promise.all(
								page
									.frames()
									.map(async (f) => ({
										origin: new URL(f.url() || "about:blank").origin,
										inputs: await f
											.locator("input")
											.evaluateAll((nodes) =>
												nodes.map((n) => ({ name: n.name, id: n.id, type: n.type, placeholder: n.placeholder })),
											),
									})),
							),
							notices: await page.locator(".notice").allTextContents(),
							buttons: await page.getByRole("button").allTextContents(),
						},
						null,
						2,
					) + "\n",
					{ mode: 0o600 },
				);
			}
		} catch {
			browserSignals.push({ kind: "diagnostics_unavailable" });
		}
		for (const id of objects.sessions) {
			try {
				const value = await provider(`checkout/sessions/${id}`);
				if (value.subscription && !objects.subscriptions.includes(value.subscription))
					objects.subscriptions.push(value.subscription);
				if (value.status === "open") await provider(`checkout/sessions/${id}/expire`, "POST", {});
			} catch {
				failures.push("session");
			}
		}
		for (const id of objects.subscriptions) {
			try {
				const value = await provider(`subscriptions/${id}`);
				assert(objects.customers.includes(value.customer));
				if (value.status !== "canceled") await provider(`subscriptions/${id}`, "DELETE");
			} catch {
				failures.push("subscription");
			}
		}
		for (const id of objects.prices) {
			try {
				await provider(`prices/${id}`, "POST", { active: "false" });
			} catch {
				failures.push("price");
			}
		}
		for (const id of objects.products) {
			try {
				await provider(`products/${id}`, "POST", { active: "false" });
			} catch {
				failures.push("product");
			}
		}
		if (listener && !listenerExited) {
			listener.kill("SIGTERM");
			await Promise.race([listenerClosed, delay(5000)]);
			if (!listenerExited) {
				listener.kill("SIGKILL");
				await Promise.race([listenerClosed, delay(3000)]);
			}
			if (!listenerExited) failures.push("listener");
		}
		if (server) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		try {
			await bootstrap?.close();
		} catch {
			failures.push("bootstrap_server");
		}
		await writeFile(
			join(out, "checkout-details.json"),
			JSON.stringify({ runId, phase, checks, deliveries, objects, cleanupFailures: failures }, null, 2) + "\n",
			{ mode: 0o600 },
		);
		assert.deepEqual(failures, [], "Owned Stripe test-object cleanup failed");
	};
	try {
		bootstrap = await prepareFoundingBootstrap(platform);
		await cluster.query(`insert into public.qorpera_computer_billing_keys(key_sha256,label) values('${createHash("sha256").update(bridge).digest("hex")}','Hosted Checkout acceptance');
   update public.qorpera_computer_billing_readiness set runtime_accounting_ready=true,checkout_enabled=true where singleton;
   update public.qorpera_computer_plan_versions set active_for_checkout=true where plan_key in ('basis','standard') and version=1;`);
		const product = await provider("products", "POST", {
			name: `Qorpera hosted acceptance ${runId}`,
			"metadata[qorpera_acceptance_run]": runId,
		});
		objects.products.push(product.id);
		for (const [planKey, amount] of [
			["basis", "18500"],
			["standard", "63000"],
		]) {
			const price = await provider("prices", "POST", {
				product: product.id,
				currency: "dkk",
				unit_amount: amount,
				"recurring[interval]": "month",
			});
			objects.prices.push(price.id);
			options.pricePlans[price.id] = { planKey, version: 1 };
		}
		server = createServer(async (req, res) => {
			try {
				if (req.method !== "POST" || req.url !== "/webhook") {
					res.writeHead(404).end();
					return;
				}
				const chunks = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					assert(size <= 1048576);
					chunks.push(chunk);
				}
				const bytes = Buffer.concat(chunks);
				await verifyStripeSignature(
					bytes,
					String(req.headers["stripe-signature"] ?? ""),
					options.webhookSecret,
					Date.now(),
				);
				const event = JSON.parse(bytes);
				assert.equal(event.livemode, false);
				assert.equal(event.api_version, STRIPE_API_VERSION);
				if (!objects.customers.includes(event.data.object.customer)) {
					res.writeHead(200).end('{"outsideAcceptance":true}');
					return;
				}
				const result = await handleComputerBilling(
					new Request(`${gateway.origin}/functions/v1/computer-billing/webhook`, {
						method: "POST",
						body: bytes,
						headers: { "stripe-signature": String(req.headers["stripe-signature"]) },
					}),
					options,
				);
				const body = await result.text();
				const error = (() => {
					try {
						const value = JSON.parse(body).error;
						return typeof value === "string" && /^[A-Za-z .-]{1,120}$/.test(value) ? value : undefined;
					} catch {
						return undefined;
					}
				})();
				assert(events.size < 1000 || events.has(event.id), "Webhook evidence bound exceeded");
				events.set(event.id, {
					event,
					bytes,
					signature: String(req.headers["stripe-signature"]),
					status: result.status,
				});
				deliveries.push({
					id: event.id,
					type: event.type,
					status: result.status,
					genuineCliSignature: true,
					...(error ? { error } : {}),
				});
				await writeFile(join(privateRoot, `${event.id}.json`), bytes, { mode: 0o600 });
				res.writeHead(result.status).end(body);
			} catch {
				res.writeHead(503).end();
			}
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		listener = spawn(
			stripeCli,
			[
				"listen",
				"--latest",
				"--skip-update",
				"--events",
				"customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed",
				"--forward-to",
				`http://127.0.0.1:${server.address().port}/webhook`,
				"--config",
				join(privateRoot, "stripe.toml"),
			],
			{ env: { PATH: process.env.PATH, HOME: privateRoot, STRIPE_API_KEY: secret }, stdio: ["ignore", "pipe", "pipe"] },
		);
		listenerClosed = new Promise((resolve) => {
			listener.once("close", () => {
				listenerExited = true;
				resolve();
			});
			listener.once("error", () => {
				listenerExited = true;
				resolve();
			});
		});
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Stripe CLI listener unavailable")), 30000);
			let data = "";
			const inspect = (bytes) => {
				data = (data + bytes).slice(-16384);
				const value = /whsec_[A-Za-z0-9]+/.exec(data)?.[0];
				if (value) {
					options.webhookSecret = value;
					clearTimeout(timer);
					resolve();
				}
			};
			listener.stdout.on("data", inspect);
			listener.stderr.on("data", inspect);
			listener.once("error", reject);
		});
		return {
			close,
			handleComputerBilling: (request) => handleComputerBilling(request, options),
			runBrowser: async (browserOptions) => {
				const purchases = [];
				const founding = await runFoundingBrowser({
					...browserOptions,
					bootstrap,
					afterMaterialized: configuration.afterMaterialized,
					modelAccountSetup: configuration.modelAccountSetup,
					computerPlanSetup: async (members) => {
						for (const [index, member] of members.entries()) {
							const planKey = index === 0 ? "basis" : "standard";
							page = member.page;
							memberId = member.userId;
							const email = member.email,
								hours = planKey === "basis" ? 74 : 286;
							phase = "plan_ui_" + planKey;
							await page.locator(".account-trigger").click();
							await page.getByRole("menuitem", { name: "Account and settings", exact: true }).click();
							await page.getByRole("tab", { name: "Plan & usage", exact: true }).click();
							await page.getByRole("button", { name: "View computer plans", exact: true }).click();
							await page
								.locator('[data-plan="' + planKey + '"]')
								.getByRole("button", { name: "Choose plan", exact: true })
								.click();
							await Promise.race([
								page.waitForURL((url) => url.hostname === "checkout.stripe.com"),
								page
									.locator(".notice-danger")
									.waitFor()
									.then(async () => {
										throw new Error("Checkout UI: " + (await page.locator(".notice-danger").innerText()));
									}),
							]);
							phase = "hosted_checkout_" + planKey;
							sessionId = objects.sessions.at(-1);
							assert(sessionId);
							assert.equal(
								await cluster.query(
									"select count(*) from public.qorpera_computer_allowance_buckets where user_id=" +
										quote(memberId) +
										"::uuid;",
								),
								"0",
							);
							await page.locator('input[name="email"]').fill(email);
							const cardRow = await page.locator("#payment-method-label-card").boundingBox();
							assert(cardRow);
							await page.mouse.click(cardRow.x + cardRow.width / 2, cardRow.y + cardRow.height / 2);
							const input = async (name) =>
								until(
									async () => {
										for (const frame of page.frames()) {
											const locator = frame.locator("input[name=" + name + "]");
											if ((await locator.count()) && (await locator.isVisible())) return locator;
										}
										return null;
									},
									Boolean,
									"Stripe field " + name,
									30000,
								);
							await (await input("email")).fill(email);
							await (await input("cardNumber")).fill("4242424242424242");
							await (await input("cardExpiry")).fill("1230");
							await (await input("cardCvc")).fill("123");
							await (await input("billingName")).fill("Qorpera Acceptance");
							const country = page.locator('select[name="billingCountry"]');
							if (await country.count()) await country.selectOption("DK");
							const postal = page.locator('input[name="billingPostalCode"]');
							if (await postal.isVisible()) await postal.fill("2100");
							phase = "hosted_payment_" + planKey;
							await page.getByTestId("hosted-payment-submit-button").click();
							await page.waitForURL((url) => url.origin === browserOptions.origin, { timeout: 90000 });
							const session = await provider("checkout/sessions/" + sessionId);
							assert.equal(session.status, "complete");
							assert.equal(session.payment_status, "paid");
							assert.equal(session.client_reference_id, memberId);
							objects.subscriptions.push(session.subscription);
							const paid = await until(
								() =>
									[...events.values()].find(
										(v) => v.event.type === "invoice.paid" && v.event.data.object.id === session.invoice,
									),
								(v) => v?.status === 200,
								"genuine paid invoice webhook",
							);
							// Stripe retries a 503; the local CLI does not. Replay the exact original
							// signed delivery after the concurrent invoice lease has completed.
							await until(
								async () => {
									for (const value of events.values()) {
										if (value.event.data.object.customer !== session.customer || value.status === 200) continue;
										const retry = await handleComputerBilling(
											new Request(browserOptions.origin + "/functions/v1/computer-billing/webhook", {
												method: "POST",
												body: value.bytes,
												headers: { "stripe-signature": value.signature },
											}),
											options,
										);
										value.status = retry.status;
										deliveries.push({
											id: value.event.id,
											type: value.event.type,
											status: retry.status,
											replayOfOriginalCliDelivery: true,
										});
									}
									return [...events.values()]
										.filter((v) => v.event.data.object.customer === session.customer)
										.every((v) => v.status === 200);
								},
								Boolean,
								"concurrent subscription delivery retry",
								30000,
							);
							const replay = await handleComputerBilling(
								new Request(browserOptions.origin + "/functions/v1/computer-billing/webhook", {
									method: "POST",
									body: paid.bytes,
									headers: { "stripe-signature": paid.signature },
								}),
								options,
							);
							assert.equal(replay.status, 200);
							assert.equal(
								await cluster.query(
									"select count(*) from public.qorpera_computer_billing_inbox where completed_at is null;",
								),
								"0",
							);
							checks.push(
								planKey +
									" concurrent subscription delivery converged and exact signed invoice replay preserved one bucket",
							);
							const funded = await cluster.query(
								"select funded_us::text from public.qorpera_computer_allowance_buckets where user_id=" +
									quote(memberId) +
									"::uuid and invoice_id=" +
									quote(session.invoice) +
									";",
							);
							assert.equal(funded, String(hours * 3600000000));
							await page.locator(".account-trigger").click();
							await page.getByRole("menuitem", { name: "Account and settings", exact: true }).click();
							await page.getByRole("tab", { name: "Plan & usage", exact: true }).click();
							await page.getByText(hours + " standard hours available", { exact: true }).waitFor();
							await page.getByRole("button", { name: "Close settings", exact: true }).click();
							purchases.push({
								userId: memberId,
								planKey,
								hours,
								checkoutId: sessionId,
								invoiceId: session.invoice,
								eventId: paid.event.id,
							});
							checks.push(
								planKey + " actual hosted payment, genuine CLI invoice funding, actual member balance display",
							);
						}
						return {
							boundary:
								"Actual production Plan UI and hosted Stripe test-card payments for Basis/Standard; genuine signed CLI invoices through production billing/PostgREST; both founders consented their real balances. Model login remains a separate member-bound fixture; no physical model execution.",
						};
					},
				});
				phase = "complete";
				return {
					...founding,
					schema: "qorpera.hosted-checkout-founding-acceptance/v1",
					runId,
					purchases,
					checks,
					deliveries,
					objects,
				};
			},
		};
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			cleanupError.retainPrivateState = true;
			throw cleanupError;
		}
		throw error;
	}
}

export async function runHostedFounding(options) {
	const secret = await protectedStripeTestKey(options.stripeKey);
	const executable = await lstat(options.stripeCli);
	assert(
		executable.isFile() && !executable.isSymbolicLink() && (executable.mode & 0o022) === 0,
		"Protected Stripe CLI required",
	);
	const version = await promisify(execFile)(options.stripeCli, ["--version"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 2048,
		env: { PATH: process.env.PATH },
	});
	assert.equal(version.stdout.trim(), "stripe version 1.52.0", "Reviewed Stripe CLI version required");
	return runFoundingNative(options, (platform) =>
		prepareHostedFoundingScenario(platform, { secret, stripeCli: options.stripeCli, out: options.out }),
	);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await runHostedFounding(hostedFoundingOptions(process.argv.slice(2)));
}
