import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
import type { CompanyComputerLinuxOfficeServiceOptions } from "@qorpera/runtime/cloud-company-computer-linux-service";
import { runCompanyComputerServiceMain } from "@qorpera/runtime/cloud-company-computer-service-main";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computerDeferred } from "./fixtures/company-computer.ts";
import { computerServiceConfig } from "./fixtures/company-computer-service.ts";

const mocked = vi.hoisted(() => ({
	read: vi.fn(),
	start: vi.fn(),
	outboxOpen: vi.fn(),
	outboxStart: vi.fn(),
	outboxClose: vi.fn(),
	retain: vi.fn(),
}));
vi.mock("../src/cloud-company-computer-screen-outbox.ts", () => ({
	CompanyComputerScreenOutbox: { open: mocked.outboxOpen },
}));
vi.mock("../src/cloud-company-computer-service-credentials.ts", () => ({
	readCompanyComputerServiceCredential: mocked.read,
}));
vi.mock("../src/cloud-company-computer-linux-service.ts", () => ({
	startCompanyComputerLinuxOfficeService: mocked.start,
}));
const platform = process.platform;
const initialListeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
let temporary: string;
let cert: Buffer;
let key: Buffer;
let config: ReturnType<typeof computerServiceConfig>;
let credentials: Record<string, Buffer>;
let issued: Buffer[];
beforeAll(async () => {
	temporary = await mkdtemp(join(tmpdir(), "qorpera-office-main-tls-"));
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(temporary, "key"),
			"-out",
			join(temporary, "cert"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
		],
		{ timeout: 15000, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error("Fixture certificate creation failed");
	cert = await readFile(join(temporary, "cert"));
	key = await readFile(join(temporary, "key"));
});
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "linux" });
	vi.spyOn(process, "getuid").mockReturnValue(1000);
	vi.spyOn(process, "geteuid").mockReturnValue(1000);
	config = computerServiceConfig();
	issued = [];
	mocked.outboxClose.mockResolvedValue(undefined);
	mocked.retain.mockResolvedValue(undefined);
	mocked.outboxOpen.mockResolvedValue({ retain: mocked.retain, start: mocked.outboxStart, close: mocked.outboxClose });
	credentials = {
		"qorpera-office-registry": Buffer.from("r".repeat(64)),
		"qorpera-office-native": Buffer.from("n".repeat(43)),
		"qorpera-office-objects": Buffer.from("o".repeat(43)),
		"qorpera-office-tls-cert": cert,
		"qorpera-office-tls-key": key,
	};
	mocked.read.mockImplementation(async (_directory, name) => {
		const value =
			name === "qorpera-office-config" ? Buffer.from(JSON.stringify(config)) : Buffer.from(credentials[name]);
		issued.push(value);
		return value;
	});
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.restoreAllMocks();
	mocked.read.mockReset();
	mocked.start.mockReset();
	mocked.outboxOpen.mockReset();
	mocked.outboxStart.mockReset();
	mocked.outboxClose.mockReset();
	mocked.retain.mockReset();
	for (const buffer of issued) expect(buffer.every((byte) => byte === 0)).toBe(true);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		expect(process.listenerCount(signal)).toBe(initialListeners[signal]);
});
afterAll(async () => {
	await rm(temporary, { recursive: true, force: true });
});
const environment = {
	CREDENTIALS_DIRECTORY: "/run/credentials/qorpera-company-computer.service",
	INVOCATION_ID: "a".repeat(32),
};

describe("headless office process lifetime (physical guest mocked)", () => {
	it.each(["startup", "supervision", "service-drain", "outbox-drain"] as const)(
		"reports %s distinctly and safely after confirmed cleanup",
		async (stage) => {
			const secret = "Bearer credentials-secret /run/credentials/private";
			const original = Object.assign(new Error(secret), { code: "EACCES" });
			const close = vi.fn(async () => {
				if (stage === "supervision" || stage === "service-drain") throw original;
			});
			mocked.start.mockImplementation(async () => {
				if (stage === "startup") throw original;
				if (stage !== "supervision") process.emit("SIGTERM");
				return { finished: stage === "supervision" ? Promise.reject(original) : Promise.resolve(), close };
			});
			if (stage === "outbox-drain") mocked.outboxClose.mockRejectedValueOnce(original);
			const failure = await runCompanyComputerServiceMain(environment).catch((error: unknown) => error);
			const diagnostic = companyComputerFailureDiagnostic(failure);
			expect(diagnostic.stages).toEqual([stage]);
			expect(diagnostic.categories).toEqual(["filesystem-permission"]);
			expect(JSON.stringify(diagnostic)).not.toContain(secret);
			expect(mocked.outboxClose).toHaveBeenCalledOnce();
		},
	);
	it("retains primary supervision failure when both cleanup owners fail", async () => {
		mocked.start.mockImplementation(async () => ({
			finished: Promise.reject(new Error("OFFICE_SERVICE_SUPERVISION_FAILED")),
			close: async () => {
				throw new Error("OFFICE_GUEST_DRAIN_UNCONFIRMED");
			},
		}));
		mocked.outboxClose.mockRejectedValueOnce(Object.assign(new Error("private path"), { code: "EIO" }));
		const failure = await runCompanyComputerServiceMain(environment).catch((error: unknown) => error);
		const diagnostic = companyComputerFailureDiagnostic(failure);
		expect(diagnostic.stages).toEqual(["outbox-drain", "service-drain", "supervision"]);
		expect(diagnostic.codes).toEqual(["OFFICE_GUEST_DRAIN_UNCONFIRMED", "OFFICE_SERVICE_SUPERVISION_FAILED"]);
	});
	it("still fails a drain that rejects without an error value", async () => {
		mocked.start.mockImplementation(async () => {
			process.emit("SIGTERM");
			return { finished: Promise.resolve(), close: () => Promise.reject() };
		});
		const failure = await runCompanyComputerServiceMain(environment).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(companyComputerFailureDiagnostic(failure).stages).toEqual(["service-drain"]);
	});
	it("requires a real systemd invocation identity before physical startup", async () => {
		await expect(runCompanyComputerServiceMain({ ...environment, INVOCATION_ID: "" })).rejects.toThrow(
			"INVALID_OFFICE_STARTUP_IDENTITY",
		);
		expect(mocked.start).not.toHaveBeenCalled();
	});
	it.each(["SIGINT", "SIGTERM"] as const)("awaits confirmed cleanup across repeated %s", async (signal) => {
		const started = computerDeferred<CompanyComputerLinuxOfficeServiceOptions>();
		const finished = computerDeferred<void>();
		const drained = computerDeferred<void>();
		const close = vi.fn(() => drained.promise);
		mocked.start.mockImplementation(async (options) => {
			started.resolve(options);
			return { finished: finished.promise, close };
		});
		const run = runCompanyComputerServiceMain({
			...environment,
			OPENAI_API_KEY: "ignored",
			QORPERA_OFFICE_NATIVE_TOKEN: "ignored",
		});
		const options = await started.promise;
		expect(options.scope).toEqual(config.scope);
		expect(options.native.token).toBe("n".repeat(43));
		expect(options.captureObjectGateway.token).toBe("o".repeat(43));
		expect(options.native.tls.cert).toEqual(cert);
		expect(options.startup).toBeDefined();
		expect(options.screenLifecycle).toBeDefined();
		expect(mocked.outboxOpen.mock.calls[0][0]).toBe("/var/lib/qorpera-office-events");
		expect(mocked.outboxOpen.mock.calls[0][1]).toEqual(config.scope);
		expect(mocked.outboxOpen.mock.calls[0][2]).toEqual(expect.arrayContaining(Object.values(config.linux.layout)));
		expect(mocked.outboxStart).toHaveBeenCalledOnce();
		process.emit(signal);
		process.emit(signal);
		expect(options.signal.aborted).toBe(true);
		let done = false;
		void run.then(() => {
			done = true;
		});
		finished.resolve();
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
		expect(done).toBe(false);
		expect(mocked.outboxClose).not.toHaveBeenCalled();
		drained.resolve();
		await run;
		expect(mocked.outboxClose).toHaveBeenCalledOnce();
	});
	it("does not launch after cancellation during credential loading", async () => {
		mocked.read.mockImplementationOnce(async () => {
			process.emit("SIGTERM");
			const value = Buffer.from(JSON.stringify(config));
			issued.push(value);
			return value;
		});
		await expect(runCompanyComputerServiceMain(environment)).rejects.toThrow();
		expect(mocked.start).not.toHaveBeenCalled();
		expect(mocked.read).toHaveBeenCalledTimes(1);
	});
	it("forwards an aborted signal when shutdown occurs during physical startup", async () => {
		const close = vi.fn(async () => undefined);
		mocked.start.mockImplementation(async (options) => {
			process.emit("SIGTERM");
			expect(options.signal.aborted).toBe(true);
			return { finished: Promise.resolve(), close };
		});
		await runCompanyComputerServiceMain(environment);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it.each(["supervision", "unexpected end", "unknown drain"])("fails closed after %s", async (failure) => {
		const close = vi.fn(async () => {
			if (failure === "unknown drain") throw new Error("drain unknown");
		});
		mocked.start.mockImplementation(async () => ({
			finished: failure === "supervision" ? Promise.reject(new Error("supervision failed")) : Promise.resolve(),
			close,
		}));
		await expect(runCompanyComputerServiceMain(environment)).rejects.toThrow();
		expect(close).toHaveBeenCalledTimes(1);
		expect(mocked.outboxClose).toHaveBeenCalledOnce();
	});
	it("refuses unavailable private custody before physical startup", async () => {
		mocked.outboxOpen.mockRejectedValueOnce(new Error("SCREEN_OUTBOX_DIRECTORY_UNSAFE"));
		await expect(runCompanyComputerServiceMain(environment)).rejects.toThrow("SCREEN_OUTBOX_DIRECTORY_UNSAFE");
		expect(mocked.start).not.toHaveBeenCalled();
		expect(mocked.outboxStart).not.toHaveBeenCalled();
	});
	it.each(["tls", "native token", "reused credential", "stale shape", "mutable adoption", "volatile mount"])(
		"rejects %s before physical startup",
		async (failure) => {
			if (failure === "tls") credentials["qorpera-office-tls-key"] = Buffer.from("private-key-that-must-not-leak");
			if (failure === "native token") credentials["qorpera-office-native"] = Buffer.from("short");
			if (failure === "reused credential")
				credentials["qorpera-office-native"] = credentials["qorpera-office-objects"];
			if (failure === "stale shape") Object.assign(config, { computeIdentityId: "forbidden" });
			if (failure === "mutable adoption")
				config.linux.attestation.adoptionReceiptPath = "/srv/workbench/adoption.json";
			if (failure === "volatile mount") config.linux.workbenchMount.filesystem = "tmpfs";
			await expect(runCompanyComputerServiceMain(environment)).rejects.toThrow();
			expect(mocked.start).not.toHaveBeenCalled();
		},
	);
	it.each(["root", "darwin", "credentials"])("requires actual service prerequisites: %s", async (missing) => {
		if (missing === "root") vi.mocked(process.geteuid!).mockReturnValue(0);
		if (missing === "darwin") Object.defineProperty(process, "platform", { value: "darwin" });
		await expect(
			runCompanyComputerServiceMain(
				missing === "credentials" ? { QORPERA_OFFICE_NATIVE_TOKEN: "ignored" } : environment,
			),
		).rejects.toThrow();
		expect(mocked.read).not.toHaveBeenCalled();
		expect(mocked.start).not.toHaveBeenCalled();
	});
});
