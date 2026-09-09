import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import { officeConfigurationWorkerFixture } from "./fixtures/office-configuration-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const fixture = (prepared = true) => officeConfigurationWorkerFixture(roots, prepared);
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("provider configuration of an acknowledged prepared boot", () => {
	it.each(["missing", "changed", "mode", "owner"])(
		"refuses %s selected boot credentials while original credentials are intact",
		async (fault) => {
			const f = await fixture();
			await f.worker.reconcile(f.request, signal());
			const selected = [...f.guest.keys()].find(
				(path) => path.startsWith("/etc/qorpera-office/boots/") && path.endsWith("/native"),
			)!;
			expect(selected).toBeDefined();
			const original = Buffer.from(f.guest.get("/etc/qorpera-office/credentials/native")!.content);
			const file = f.guest.get(selected)!;
			if (fault === "missing") f.guest.delete(selected);
			if (fault === "changed") file.content = Buffer.from("changed");
			if (fault === "mode") file.mode = 0o644;
			if (fault === "owner") file.uid = 1000;
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
			expect(f.guest.get("/etc/qorpera-office/credentials/native")!.content.equals(original)).toBe(true);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);

	it("refuses an expired credential inspection and recovers without dispatching again", async () => {
		const f = await fixture(),
			read = f.file.getMockImplementation()!;
		let delayed = false;
		f.file.mockImplementation(async (...args) => {
			if (!delayed && args[2].startsWith("/etc/qorpera-office/credentials/")) {
				delayed = true;
				const authority = args[4];
				if (!authority) throw new Error("missing inspection authority");
				await new Promise<void>((resolve) => {
					if (authority.aborted) resolve();
					else authority.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			return read(...args);
		});
		await expect(f.worker.reconcileSettled(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
		expect(delayed).toBe(true);
		expect(await readdir(f.root)).not.toContain(f.names.completion);
		f.file.mockImplementation(read);
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_activation" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	}, 15000);
	it("detects credential edits between the two independent passes", async () => {
		const f = await fixture(),
			read = f.file.getMockImplementation()!;
		f.file.mockImplementation(async (...args) => {
			const value = await read(...args);
			if (args[2] === "/etc/qorpera-office/credentials/tls-key.pem")
				f.guest.get("/etc/qorpera-office/credentials/config.json")!.content =
					Buffer.from("changed after first pass");
			return value;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
		expect(await readdir(f.root)).not.toContain(f.names.completion);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("rechecks current authority after the last credential pass before publishing completion", async () => {
		const f = await fixture(),
			read = f.file.getMockImplementation()!;
		let passes = 0;
		f.file.mockImplementation(async (...args) => {
			const value = await read(...args);
			if (args[2] === "/etc/qorpera-office/credentials/tls-key.pem" && ++passes === 2)
				f.call.mockRejectedValue(new Error("provider disabled"));
			return value;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
		expect(passes).toBe(2);
		expect(await readdir(f.root)).not.toContain(f.names.completion);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("installs one command, independently verifies all files, resumes and journals no credential values", async () => {
		const f = await fixture();
		const preparedDispatches = f.preparation.exec.mock.calls.length;
		const result = await f.worker.reconcile(f.request, signal());
		expect(result.state).toBe("awaiting_activation");
		const observation = (await readRecord(join(f.root, f.names.observation))).value;
		expect(result).toMatchObject({ observationSha256: officeDigest(observation) });
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).toHaveBeenCalledOnce();
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.preparation.exec).toHaveBeenCalledTimes(preparedDispatches);
		for (const bytes of f.credentialBuffers) expect(bytes.every((v) => v === 0)).toBe(true);
		for (const call of f.stage.mock.calls) expect(call[3].every((v) => v === 0)).toBe(true);
		for (const name of [
			f.names.index,
			f.names.observation,
			f.names.completion,
			...(await readdir(join(f.root, f.names.journal))).map((name) => `${f.names.journal}/${name}`),
		]) {
			const text = await readFile(join(f.root, name), "utf8");
			for (const secret of Object.values(f.secrets)) expect(text).not.toContain(secret);
		}
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
		expect(f.call.mock.calls.every(([method]) => method === "qorpera_check_runtime_office_adoption")).toBe(true);
	});
	it("cannot start preparation when acknowledged preparation is absent", async () => {
		const f = await fixture(false);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
		expect(f.preparation.exec).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
		expect(f.readCredential).not.toHaveBeenCalled();
	});
	it("resumes a known pending operation without staging or dispatching again", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("pending");
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe("pending");
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({
			state: "awaiting_activation",
			commandId: first.commandId,
		});
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("does not retry an uncertain submission even if guest completion exists", async () => {
		const f = await fixture();
		const original = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => {
			await original(...args);
			throw new Error(f.secrets.registry);
		});
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe("unknown");
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(first);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.poll).not.toHaveBeenCalled();
		expect(await readdir(f.root)).not.toContain(f.names.completion);
	});
	it.each(["registry", "native", "objects", "tlsCert", "tlsKey"] as const)(
		"refuses changed protected %s bytes before staging",
		async (key) => {
			const f = await fixture();
			f.secrets[key] += "x";
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_CONFIGURATION_UNCONFIRMED");
			expect(f.stage).not.toHaveBeenCalled();
			expect(f.exec).not.toHaveBeenCalled();
			for (const bytes of f.credentialBuffers) expect(bytes.every((v) => v === 0)).toBe(true);
		},
	);
	it("refuses allocation substitution before reading credentials", async () => {
		const f = await fixture();
		f.bootstrap.providerBindingSha256 = "f".repeat(64);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.readCredential).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
	});
	it("refuses a changed bootstrap after staging before dispatch", async () => {
		const f = await fixture();
		const stage = f.stage.getMockImplementation()!;
		f.stage.mockImplementation(async (...args) => {
			await stage(...args);
			f.bootstrap.registryUrl = "https://changed.invalid";
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).not.toHaveBeenCalled();
	});
	it.each(["authority", "boot"] as const)("refuses changed %s after staging", async (changed) => {
		const f = await fixture(),
			stage = f.stage.getMockImplementation()!;
		f.stage.mockImplementation(async (...args) => {
			await stage(...args);
			if (changed === "authority") f.call.mockRejectedValue(new Error("provider disabled"));
			else
				f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(
					"ffffffff-ffff-4fff-8fff-ffffffffffff\n",
				);
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("keeps configuration occupied until cancelled nested preparation IO settles", async () => {
		const f = await fixture(),
			abort = new AbortController();
		let release!: () => void, enter!: () => void;
		const pending = new Promise<void>((resolve) => {
				release = resolve;
			}),
			entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
		const read = f.file.getMockImplementation()!;
		f.file.mockImplementationOnce(async (...args) => {
			enter();
			await pending;
			return read(...args);
		});
		const result = f.worker.reconcileSettled(f.request, abort.signal);
		const rejected = expect(result).rejects.toThrow("OFFICE_CONFIGURATION_RECONCILIATION_ABORTED");
		await entered;
		abort.abort();
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(
			"OFFICE_CONFIGURATION_RECONCILIATION_PENDING",
		);
		release();
		await rejected;
		expect(f.stage).not.toHaveBeenCalled();
		await expect(f.worker.reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_activation" });
	});
	it.each(["uid", "gid", "mode", "content"] as const)(
		"refuses installed credential %s substitution without repairing",
		async (property) => {
			const f = await fixture();
			const execute = f.exec.getMockImplementation()!;
			f.exec.mockImplementation(async (...args) => {
				const operation = await execute(...args);
				const file = f.guest.get("/etc/qorpera-office/credentials/native")!;
				if (property === "content") file.content = Buffer.from("substituted");
				else file[property] = property === "mode" ? 0o444 : 1000;
				return operation;
			});
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
			expect(f.stage).toHaveBeenCalledOnce();
			expect(f.exec).toHaveBeenCalledOnce();
			expect(await readdir(f.root)).not.toContain(f.names.completion);
		},
	);
	it.each(["index", "observation", "journal"] as const)(
		"refuses missing acknowledged %s without reconstructing it",
		async (key) => {
			const f = await fixture();
			await f.worker.reconcile(f.request, signal());
			await rm(join(f.root, f.names[key]), { recursive: true });
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
			expect(f.stage).toHaveBeenCalledOnce();
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it("rejects configuration completion from a different preparation", async () => {
		const f = await fixture();
		const execute = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => {
			const operation = await execute(...args);
			const file = f.guest.get("/run/qorpera-office-preparation/configuration-completion.json")!;
			const value = JSON.parse(file.content.toString());
			value.preparationCompletionSha256 = "f".repeat(64);
			file.content = Buffer.from(JSON.stringify(value));
			return operation;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(await readdir(f.root)).not.toContain(f.names.completion);
	});
	it("keeps the phase occupied while cancelled credential IO is still pending and redacts its rejection", async () => {
		const f = await fixture();
		const abort = new AbortController();
		let release!: () => void, entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.readCredential.mockImplementationOnce(async () => {
			entered();
			await pending;
			throw new Error(f.secrets.registry);
		});
		const result = f.worker.reconcileSettled(f.request, abort.signal);
		const rejected = expect(result).rejects.toThrow("OFFICE_CONFIGURATION_RECONCILIATION_ABORTED");
		await started;
		abort.abort();
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(
			"OFFICE_CONFIGURATION_RECONCILIATION_PENDING",
		);
		release();
		await rejected;
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("retains accepted cancellation, then resumes the same operation after replacement", async () => {
		const f = await fixture();
		const abort = new AbortController(),
			execute = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => {
			const result = await execute(...args);
			abort.abort();
			return result;
		});
		await expect(f.worker.reconcileSettled(f.request, abort.signal)).rejects.toThrow();
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_activation" });
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("recovers an undispatched identity but refuses loss after dispatch", async () => {
		const f = await fixture();
		f.stage.mockRejectedValueOnce(new Error("interrupted upload"));
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		await unlink(join(f.root, f.names.index));
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_activation" });
		expect(f.exec).toHaveBeenCalledOnce();
		await unlink(join(f.root, f.names.index));
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("refuses retained evidence edits before writing completion", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.request, signal());
		await writeFile(join(f.root, f.names.observation), "{}");
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
