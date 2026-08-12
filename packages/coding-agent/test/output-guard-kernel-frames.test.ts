import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// In rpc mode takeOverStdout() redirects plain process.stdout.write to stderr
// so stray library output cannot corrupt the protocol stream. Kernel-lane
// frames (binding challenge, gate requests, trail appends) must therefore go
// through writeRawStdout — a challenge shunted to stderr leaves the kernel
// deaf and every sandboxed founder session dies in "kernel binding timed out".

type WriteSpy = ReturnType<typeof vi.fn>;

function installSpies(): { stdout: WriteSpy; stderr: WriteSpy; restore: () => void } {
	const stdout = vi.fn((_chunk: unknown, cb?: (error?: Error | null) => void) => {
		cb?.();
		return true;
	});
	const stderr = vi.fn((_chunk: unknown, cb?: (error?: Error | null) => void) => {
		cb?.();
		return true;
	});
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	process.stdout.write = stdout as unknown as typeof process.stdout.write;
	process.stderr.write = stderr as unknown as typeof process.stderr.write;
	return {
		stdout,
		stderr,
		restore: () => {
			process.stdout.write = originalStdout;
			process.stderr.write = originalStderr;
		},
	};
}

function written(spy: WriteSpy): string {
	return spy.mock.calls.map((call) => String(call[0])).join("");
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("output guard kernel-frame routing", () => {
	it("redirects plain stdout writes to stderr but keeps writeRawStdout on real stdout", async () => {
		const spies = installSpies();
		try {
			const guard = await import("../src/core/output-guard.ts");
			guard.takeOverStdout();
			try {
				process.stdout.write("stray library output\n");
				guard.writeRawStdout('{"type":"protocol frame"}\n');
				await guard.flushRawStdout();
				expect(written(spies.stderr)).toContain("stray library output");
				expect(written(spies.stdout)).toContain("protocol frame");
				expect(written(spies.stdout)).not.toContain("stray library output");
			} finally {
				guard.restoreStdout();
			}
		} finally {
			spies.restore();
		}
	});

	it("delivers the kernel binding challenge on real stdout while stdout is taken over", async () => {
		vi.useFakeTimers();
		const pair = generateKeyPairSync("ed25519");
		vi.stubEnv("QORPERA_KERNEL_REQUIRED", "1");
		vi.stubEnv("QORPERA_TRAIL_BROKER_TOKEN", "token-1");
		vi.stubEnv(
			"QORPERA_KERNEL_PUBLIC_KEY",
			pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
		);
		const spies = installSpies();
		try {
			const guard = await import("../src/core/output-guard.ts");
			const broker = await import("../src/core/kernel-broker.ts");
			guard.takeOverStdout();
			try {
				broker.beginKernelBinding("session-1");
				await guard.flushRawStdout();
				expect(written(spies.stdout)).toContain('"type":"qorpera_kernel_challenge"');
				expect(written(spies.stderr)).not.toContain("qorpera_kernel_challenge");
			} finally {
				guard.restoreStdout();
				vi.clearAllTimers();
			}
		} finally {
			spies.restore();
		}
	});
});
