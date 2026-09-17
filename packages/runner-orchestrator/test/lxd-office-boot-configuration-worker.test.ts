import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeStopHash as hash } from "../src/lxd-office-stop-evidence.ts";
import { officeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = (resumed = true) => officeBootConfigurationWorkerFixture(roots, resumed);
describe("resumed boot configuration", () => {
	it("preserves original files and commands, installs one new boot and recovers after process restart", async () => {
		const f = await fixture(),
			originals = new Map([...f.guest].map(([path, file]) => [path, Buffer.from(file.content)]));
		const result = await f.run();
		expect(result).toMatchObject({ state: "awaiting_boot_admission", bootId: id(103), activationId: id(102) });
		expect(await f.run()).toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.resume.submit).toHaveBeenCalledOnce();
		for (const [path, bytes] of originals) expect(f.guest.get(path)!.content).toEqual(bytes);
		const configured = JSON.parse(f.staged()!.toString());
		expect(JSON.parse(configured.material.configuration).linux.attestation).toMatchObject({
			bootId: id(103),
			adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(id(103)),
		});
		const retained = (
			await Promise.all(
				(
					await readdir(f.root)
				)
					.filter((name) => name.endsWith(".json"))
					.map((name) => readFile(join(f.root, name), "utf8")),
			)
		).join("\n");
		for (const secret of [f.secrets.registry, f.secrets.native, f.secrets.objects, f.secrets.tlsKey])
			expect(retained).not.toContain(secret);
		expect(f.credentialBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
		expect(f.stage.mock.calls[0][3].every((byte) => byte === 0)).toBe(true);
	});
	it.each(["recorded", "unrecorded"])(
		"takes a plan with replaced TLS credentials only through the %s revision chain",
		async (kind) => {
			const f = await fixture();
			const path = f.input.serviceBootstrapPath,
				original = (await f.readProtected(path, 16384)).toString("utf8"),
				material = { tlsCert: `${f.secrets.tlsCert}\n`, tlsKey: `${f.secrets.tlsKey}\n` };
			const plan = JSON.parse(original);
			for (const [key, text] of Object.entries(material))
				plan.credentials[key] = {
					path: `${plan.credentials[key].path}-r1`,
					bytes: Buffer.byteLength(text),
					sha256: hash(Buffer.from(text)),
				};
			const next = JSON.stringify(plan);
			const chain = {
				schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
				allocationId: f.binding.allocationId,
				revisions: [
					{
						revision: 1,
						previousSha256: hash(Buffer.from(original)),
						nextSha256: hash(Buffer.from(next)),
						previousPlan: original,
						changed: ["tlsCert", "tlsKey"],
						reason: "tailnet certificate renewed",
						at: "2026-09-17T12:00:00Z",
					},
				],
			};
			const readProtected = f.readProtected.getMockImplementation()!,
				readCredential = f.readCredential.getMockImplementation()!;
			f.readProtected.mockImplementation(async (file: string, limit: number) => {
				if (file === path) return Buffer.from(next);
				if (file.endsWith("/service-bootstrap-revisions.json")) {
					if (kind === "unrecorded") throw Object.assign(new Error("missing"), { code: "ENOENT" });
					return Buffer.from(JSON.stringify(chain));
				}
				return readProtected(file, limit);
			});
			f.readCredential.mockImplementation(async (file: string, limit: number) => {
				const name = Object.keys(material).find((key) => file === plan.credentials[key].path);
				return name ? Buffer.from(material[name as keyof typeof material]) : readCredential(file, limit);
			});
			if (kind === "unrecorded") {
				await expect(f.run()).rejects.toThrow("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED");
				expect(f.stage).not.toHaveBeenCalled();
				expect(f.exec).not.toHaveBeenCalled();
				return;
			}
			const result = await f.run();
			expect(result).toMatchObject({ state: "awaiting_boot_admission", bootId: id(103) });
			expect(JSON.parse(await readFile(f.names.index, "utf8")).serviceBootstrapSha256).toBe(hash(Buffer.from(next)));
			const staged = JSON.parse(f.staged()!.toString());
			expect(staged.material.tlsCert).toBe(material.tlsCert);
			expect(
				f.guest.get(`${companyComputerBootDirectory(id(103))}/credentials/tls-cert.pem`)?.content.toString(),
			).toBe(material.tlsCert);
		},
	);
	it("cannot initiate a missing VM resume", async () => {
		const f = await fixture(false);
		await expect(f.run()).rejects.toThrow("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED");
		expect(f.resume.submit).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
	});
	it.each(["seed", "prepared", "observation", "done"] as const)(
		"refuses lost resume %s before invoking the verifier",
		async (name) => {
			const f = await fixture();
			await rm(f.resume.names[name]);
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).not.toHaveBeenCalled();
			expect(f.stage).not.toHaveBeenCalled();
			expect(f.resume.submit).toHaveBeenCalledOnce();
		},
	);
	it.each([true, false])("never retries a lost dispatch reply (installed %s)", async (installed) => {
		const f = await fixture();
		f.state.install = installed;
		const submit = f.exec.getMockImplementation()!;
		f.exec.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("lost reply");
		});
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.poll).not.toHaveBeenCalled();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("recovers an accepted operation after a lost poll without another dispatch", async () => {
		const f = await fixture();
		f.poll.mockRejectedValueOnce(new Error("lost poll"));
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it.each(["index", "observation", "journal"] as const)("refuses deleted acknowledged %s", async (name) => {
		const f = await fixture();
		await f.run();
		await rm(f.names[name], { recursive: true });
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it("refuses a lost index after dispatch even without an acknowledged completion", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("pending");
		await f.run();
		await rm(f.names.index);
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("recovers an intact command before dispatch after lost staging confirmation", async () => {
		const f = await fixture();
		f.readStage.mockRejectedValueOnce(new Error("lost staging"));
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		const identity = await readFile(f.names.index);
		await rm(f.names.index);
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		expect(await readFile(f.names.index)).toEqual(identity);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each(["registry", "native", "objects", "tlsCert", "tlsKey", "configuration"] as const)(
		"independently refuses missing installed %s after acknowledged configuration",
		async (key) => {
			const f = await fixture();
			await f.run();
			f.guest.delete(
				`${companyComputerBootDirectory(id(103))}/credentials/${COMPANY_COMPUTER_CONFIGURATION_FILES[key]}`,
			);
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.stage).toHaveBeenCalledOnce();
		},
	);
	it.each(["receipt", "completion", "mode", "bytes", "second-pass"])(
		"refuses altered %s during independent verification",
		async (kind) => {
			const f = await fixture(),
				submit = f.exec.getMockImplementation()!;
			f.exec.mockImplementation(async (...args) => {
				const result = await submit(...args),
					directory = companyComputerBootDirectory(id(103));
				if (kind === "receipt")
					f.guest.get(companyComputerBootAdoptionReceiptPath(id(103)))!.content = Buffer.from("{}");
				if (kind === "completion") f.guest.delete(`${directory}/configuration-completion.json`);
				if (kind === "mode") f.guest.get(`${directory}/credentials/native`)!.mode = 0o444;
				if (kind === "bytes") f.guest.get(`${directory}/credentials/native`)!.content = Buffer.from("changed");
				return result;
			});
			if (kind === "second-pass") {
				const read = f.file.getMockImplementation()!;
				let count = 0;
				f.file.mockImplementation(async (...args) => {
					if (args[2] === `${companyComputerBootDirectory(id(103))}/credentials/native` && ++count === 2)
						f.guest.get(args[2])!.content = Buffer.from("changed");
					return read(...args);
				});
			}
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it.each(["sql", "host", "boot", "credential", "history", "index"])(
		"rechecks %s after staging before dispatch",
		async (kind) => {
			const f = await fixture(),
				stage = f.stage.getMockImplementation()!;
			f.stage.mockImplementation(async (...args) => {
				await stage(...args);
				if (kind === "sql") f.intent.state = "admitted";
				if (kind === "host")
					f.check.mockImplementation(async () => ({ hostBootId: id(119), signal: signal(), validForMs: 5000 }));
				if (kind === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(119));
				if (kind === "credential") f.readCredential.mockRejectedValue(new Error("credential changed"));
				if (kind === "history") await writeFile(f.resume.powerOff.paths.done, "{}");
				if (kind === "index") await writeFile(f.names.index, "{}");
			});
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it("retains cancellation ownership across replacement workers until registry IO settles", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let release!: () => void, enter!: () => void;
		const blocked = new Promise<void>((r) => {
				release = r;
			}),
			entered = new Promise<void>((r) => {
				enter = r;
			});
		f.registry.mockImplementation(async (...args) => {
			if (args[0] === "qorpera_check_runtime_office_boot_intent") {
				enter();
				await blocked;
			}
			return original(...args);
		});
		const abort = new AbortController(),
			operation = f.run(abort.signal);
		await entered;
		abort.abort();
		await expect(operation).rejects.toThrow("ABORTED");
		await expect(f.run()).rejects.toThrow("PENDING");
		release();
		await vi.waitFor(() => expect(f.credentialBuffers.every((bytes) => bytes.every((b) => b === 0))).toBe(true));
		f.registry.mockImplementation(original);
		await vi.waitFor(async () => {
			await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		});
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
