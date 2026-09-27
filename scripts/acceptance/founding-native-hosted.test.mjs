import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	foundingNativeJoinedOptions,
	prepareFoundingNativeBrowser,
	readFoundingNativePayment,
} from "./founding-native-hosted.mjs";

test("joined native defaults to fixture funding and requires an explicit pair of private Stripe paths", async () => {
	assert.deepEqual(foundingNativeJoinedOptions(["--host", "/opt/private/host.json"]), {
		host: "/opt/private/host.json",
	});
	assert.equal(await readFoundingNativePayment({}), undefined);
	const args = [
		"--host",
		"/opt/private/host.json",
		"--stripe-cli",
		"/opt/stripe",
		"--stripe-key",
		"/private/test-key",
	];
	assert.equal(foundingNativeJoinedOptions(args).stripeKey, "/private/test-key");
	for (const extra of [
		["--host", "/other"],
		["--live-mode", "true"],
		["--project-url", "https://production.invalid"],
	])
		assert.throws(() => foundingNativeJoinedOptions([...args, ...extra]));
	assert.throws(() => foundingNativeJoinedOptions(args.slice(0, -2)));
	assert.throws(() => foundingNativeJoinedOptions(["--host", "/tmp/../host"]));
});

test("joined payment rejects live credentials, unsafe CLI custody and wrong versions before payment", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "founding-native-payment-"));
	const options = { stripeKey: join(root, "key"), stripeCli: join(root, "stripe") };
	try {
		await writeFile(options.stripeKey, "sk_test_fixture", { mode: 0o600 });
		await writeFile(options.stripeCli, "#!/bin/sh\nprintf 'stripe version 1.52.0\\n'\n", { mode: 0o700 });
		assert.deepEqual(await readFoundingNativePayment(options), {
			secret: "sk_test_fixture",
			stripeCli: options.stripeCli,
		});
		await writeFile(options.stripeKey, "sk_live_fixture");
		await assert.rejects(readFoundingNativePayment(options), /test-mode/);
		await writeFile(options.stripeKey, "sk_test_fixture");
		await chmod(options.stripeCli, 0o722);
		await assert.rejects(readFoundingNativePayment(options), /Protected Stripe CLI/);
		await chmod(options.stripeCli, 0o700);
		await symlink(options.stripeCli, join(root, "alias"));
		await assert.rejects(
			readFoundingNativePayment({ ...options, stripeCli: join(root, "alias") }),
			/Protected Stripe CLI/,
		);
		await writeFile(options.stripeCli, "#!/bin/sh\nprintf 'stripe version 0.0.0\\n'\n");
		await assert.rejects(readFoundingNativePayment(options), /Reviewed Stripe CLI/);
	} finally {
		await rm(root, { recursive: true });
	}
});

test("hosted composition reuses the native bootstrap and dispatch hooks without taking physical cleanup ownership", async () => {
	let bootstrapCloses = 0,
		hostedCloses = 0;
	const bootstrap = {
		nativeHandler: () => {},
		close: async () => {
			bootstrapCloses++;
		},
		provision: async (id) => id,
	};
	const platform = { out: "/private/evidence" };
	const calls = [];
	const modelAccountSetup = async (value) => {
		calls.push(["model", value]);
	};
	const afterMaterialized = async (pins) => {
		calls.push(["dispatch", pins]);
	};
	const payment = { secret: "sk_test_fixture", stripeCli: "/private/stripe" };
	const billing = () => {};
	const scenario = await prepareFoundingNativeBrowser(
		{ platform, bootstrap, modelAccountSetup, afterMaterialized, payment },
		{
			prepareHosted: async (actualPlatform, configuration) => {
				assert.equal(actualPlatform, platform);
				assert.equal(configuration.bootstrap.provision, bootstrap.provision);
				assert.equal(configuration.bootstrap.nativeHandler, bootstrap.nativeHandler);
				assert.equal(configuration.modelAccountSetup, modelAccountSetup);
				assert.equal(configuration.afterMaterialized, afterMaterialized);
				assert.equal(configuration.secret, payment.secret);
				assert.equal(configuration.out, platform.out);
				return {
					handleComputerBilling: billing,
					runBrowser: async (pins) => {
						await configuration.modelAccountSetup(pins);
						await configuration.afterMaterialized(pins);
					},
					close: async () => {
						hostedCloses++;
						await configuration.bootstrap.close();
					},
				};
			},
			runBrowser: () => {
				throw new Error("Hosted mode must not fall back to invoice fixtures");
			},
		},
	);
	const pins = Object.freeze({ profileId: "same-real-company", runId: "same-materialized-run" });
	assert.equal(scenario.handleComputerBilling, billing);
	await scenario.runBrowser(pins);
	assert.deepEqual(calls, [
		["model", pins],
		["dispatch", pins],
	]);
	await scenario.close();
	assert.equal(hostedCloses, 1);
	assert.equal(bootstrapCloses, 0, "Native physical custody must retain bootstrap until its own close");
	const failure = Object.assign(new Error("Owned payment cleanup unconfirmed"), { retainPrivateState: true });
	await assert.rejects(
		prepareFoundingNativeBrowser(
			{ platform, bootstrap, modelAccountSetup, afterMaterialized, payment },
			{
				prepareHosted: async () => {
					throw failure;
				},
			},
		),
		(error) => error === failure && error.retainPrivateState === true,
	);
});

test("fixture mode never constructs payment authority and still dispatches the actual browser handoff", async () => {
	const bootstrap = { nativeHandler: () => {}, close: async () => {} };
	const modelAccountSetup = async () => {};
	const afterMaterialized = async (pins) => pins;
	const scenario = await prepareFoundingNativeBrowser(
		{ platform: {}, bootstrap, modelAccountSetup, afterMaterialized },
		{
			prepareHosted: () => {
				throw new Error("Unexpected payment setup");
			},
			runBrowser: async (options) => {
				assert.equal(options.bootstrap, bootstrap);
				assert.equal(options.modelAccountSetup, modelAccountSetup);
				assert.equal(options.afterMaterialized, afterMaterialized);
				assert.equal(options.computerPlanSetup, undefined);
				return options.afterMaterialized("actual-run");
			},
		},
	);
	assert.equal(await scenario.runBrowser({}), "actual-run");
	assert.equal(scenario.handleComputerBilling, undefined);
});
