import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const signal = () => new AbortController().signal;

import {
	cleanupOfficeCodePackagePipelineFixtures,
	officeCodePackagePipelineFixture as fixture,
} from "./fixtures/office-code-package-pipeline.ts";

afterEach(cleanupOfficeCodePackagePipelineFixtures);
describe("governed provision phase pipeline", () => {
	it("stages signed exact bytes, installs once, independently observes, and uses retained completed root receipt", async () => {
		const f = await fixture();
		await f.lane.enroll(signal());
		const done = await f.ensure();
		expect(done.receipt.state).toBe("installed");
		await f.ensure();
		expect(f.actions.filter((a) => a === "bootstrap:install")).toHaveLength(1);
		expect(f.methods.filter((m) => m === "qorpera_check_office_package_provision")).toHaveLength(1);
		expect(f.methods.filter((m) => m === "qorpera_ack_office_package_provision")).toHaveLength(1);
		for (const name of await readdir(f.root))
			expect(await readFile(join(f.root, name), "utf8")).not.toContain(f.f.capability);
	});
	it("recovers lost install reply through observation without a second installation dispatch", async () => {
		const f = await fixture();
		f.loseInstall();
		await expect(f.ensure()).rejects.toThrow("lost install reply");
		await f.ensure();
		expect(f.actions.filter((a) => a === "bootstrap:install")).toHaveLength(1);
		expect(f.actions.filter((a) => a === "measure:observation")).toHaveLength(1);
	});
	it("never treats authorized SQL state as physical dispatch after a lost SQL reply", async () => {
		const f = await fixture();
		f.loseDispatch();
		await expect(f.ensure()).rejects.toThrow();
		await expect(f.ensure()).rejects.toThrow("missing installed");
		expect(f.actions.filter((a) => a === "bootstrap:install")).toHaveLength(0);
		expect(f.methods.filter((m) => m === "qorpera_check_office_package_provision")).toHaveLength(1);
	});
	it("refuses changed observation evidence without acknowledgement", async () => {
		const f = await fixture();
		f.tamperObservation();
		await expect(f.ensure()).rejects.toThrow("OBSERVATION_UNCONFIRMED");
		expect(f.methods).not.toContain("qorpera_ack_office_package_provision");
	});
	it("performs full staging before the fresh invocation deadline and separately proves a rebooted invocation", async () => {
		const f = await fixture(),
			done = await f.ensure(),
			pins = await f.lane.prepareInvocation(done.packet, f.context.originalPreparation, signal()),
			before = f.actions.length,
			startup = {
				...f.f.resetPlan.predecessor.startup,
				bootId: randomUUID(),
				serviceInvocationId: randomUUID().replaceAll("-", ""),
			};
		await f.lane.measureInvocation(pins, randomUUID(), startup, performance.now() + 5000, signal());
		expect(f.actions.slice(before).filter((a) => a.startsWith("stage:"))).toHaveLength(1);
		expect(f.methods.at(-1)).toBe("qorpera_ack_office_package_invocation");
	});
	it("refuses invocation whose outer authority expired before probe", async () => {
		const f = await fixture(),
			done = await f.ensure(),
			pins = await f.lane.prepareInvocation(done.packet, f.context.originalPreparation, signal());
		await expect(
			f.lane.measureInvocation(
				pins,
				randomUUID(),
				f.f.resetPlan.predecessor.startup,
				performance.now() - 1,
				signal(),
			),
		).rejects.toThrow("INVOCATION_EXPIRED");
		expect(f.methods).not.toContain("qorpera_check_office_package_invocation");
	});
});
