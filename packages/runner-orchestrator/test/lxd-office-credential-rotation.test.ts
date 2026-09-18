import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseLxdOfficeTailnetCertificate,
	reviseLxdOfficeServiceBootstrapCredential,
} from "../src/lxd-office-credential-rotation.ts";
import {
	assertLxdOfficeServiceBootstrapContinuity,
	parseLxdOfficeServiceBootstrapRevisions,
} from "../src/lxd-office-service-bootstrap-revisions.ts";
import { officeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-credential-rotation-")));
	await chmod(root, 0o700);
	roots.push(root);
	return root;
}
/** A throwaway P-256 pair for the given DNS name and lifetime (openssl CLI). */
function certificate(domain: string, days: number, dir: string, tag: string) {
	const key = join(dir, `${tag}.key`),
		cert = join(dir, `${tag}.crt`);
	execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key], { stdio: "ignore" });
	execFileSync(
		"openssl",
		[
			"req",
			"-new",
			"-x509",
			"-key",
			key,
			"-out",
			cert,
			"-days",
			String(days),
			"-subj",
			`/CN=${domain}`,
			"-addext",
			`subjectAltName=DNS:${domain}`,
		],
		{ stdio: "ignore" },
	);
	return { key, cert };
}
const DOMAIN = "node.example.ts.net";

describe("tailnet certificate admission", () => {
	it("accepts a pair whose SAN names the route and that stays valid long enough", async () => {
		const dir = await scratch();
		const { key, cert } = certificate(DOMAIN, 90, dir, "a");
		const certPem = await readFile(cert),
			keyPem = await readFile(key);
		const parsed = parseLxdOfficeTailnetCertificate(certPem, keyPem, DOMAIN, Date.now(), 14 * 86400000);
		expect(parsed.sha256).toBe(sha(certPem));
		expect(Date.parse(parsed.notAfter)).toBeGreaterThan(Date.now() + 80 * 86400000);
	});
	it.each(["name", "expiring", "key", "domain"])("refuses a pair that is wrong by %s", async (kind) => {
		const dir = await scratch();
		const a = certificate(DOMAIN, 90, dir, "a"),
			b = certificate("other.example.ts.net", 90, dir, "b"),
			c = certificate(DOMAIN, 5, dir, "c");
		const attempt = () => {
			if (kind === "name")
				return parseLxdOfficeTailnetCertificate(readSync(b.cert), readSync(b.key), DOMAIN, Date.now(), 86400000);
			if (kind === "expiring")
				return parseLxdOfficeTailnetCertificate(
					readSync(c.cert),
					readSync(c.key),
					DOMAIN,
					Date.now(),
					14 * 86400000,
				);
			if (kind === "key")
				return parseLxdOfficeTailnetCertificate(readSync(a.cert), readSync(b.key), DOMAIN, Date.now(), 86400000);
			return parseLxdOfficeTailnetCertificate(readSync(a.cert), readSync(a.key), "Bad Domain", Date.now(), 86400000);
		};
		expect(attempt).toThrow(/OFFICE_CREDENTIAL_/);
	});
});
function readSync(path: string): Buffer {
	return execFileSync("cat", [path]);
}

describe("service bootstrap credential revision", () => {
	it("writes revision files, retains the previous plan and extends a chain the boot worker accepts", async () => {
		const f = await officeBootConfigurationWorkerFixture(roots);
		const dir = await scratch();
		// A real plan directory: the fixture's plan text with credential paths inside `dir`.
		const original = JSON.parse((await f.readProtected(f.input.serviceBootstrapPath)).toString("utf8"));
		for (const [name, ref] of Object.entries(original.credentials) as [string, { path: string }][]) {
			ref.path = join(dir, name);
			await writeFile(ref.path, f.secrets[name as keyof typeof f.secrets], { mode: 0o440 });
		}
		const planPath = join(dir, "service-bootstrap.json");
		const originalBytes = Buffer.from(`${JSON.stringify(original)}\n`);
		await writeFile(planPath, originalBytes, { mode: 0o444 });
		const first = certificate(DOMAIN, 90, dir, "r1"),
			second = certificate(DOMAIN, 90, dir, "r2");
		const one = await reviseLxdOfficeServiceBootstrapCredential(
			planPath,
			f.binding.allocationId,
			await readFile(first.cert),
			await readFile(first.key),
			"renewed",
			Date.UTC(2026, 8, 17, 12),
		);
		expect(one).toMatchObject({ revision: 1, previousPlanSha256: sha(originalBytes) });
		expect(await readFile(join(dir, "service-bootstrap.json.r0"))).toEqual(originalBytes);
		expect(await readFile(join(dir, "tlsCert-r1"))).toEqual(await readFile(first.cert));
		const plan1 = JSON.parse((await readFile(planPath)).toString("utf8"));
		expect(plan1.credentials.tlsCert).toEqual({
			path: join(dir, "tlsCert-r1"),
			bytes: (await readFile(first.cert)).length,
			sha256: sha(await readFile(first.cert)),
		});
		expect({ ...plan1, credentials: undefined }).toEqual({ ...original, credentials: undefined });
		const two = await reviseLxdOfficeServiceBootstrapCredential(
			planPath,
			f.binding.allocationId,
			await readFile(second.cert),
			await readFile(second.key),
			"renewed again",
			Date.UTC(2026, 8, 18, 12),
		);
		expect(two.revision).toBe(2);
		const chain = parseLxdOfficeServiceBootstrapRevisions(
			JSON.parse((await readFile(join(dir, "service-bootstrap-revisions.json"))).toString("utf8")),
			f.binding.allocationId,
		);
		expect(chain.revisions.map((r) => [r.revision, r.previousSha256, r.nextSha256])).toEqual([
			[1, sha(originalBytes), one.planSha256],
			[2, one.planSha256, two.planSha256],
		]);
		// The boot worker's continuity rule accepts the result from either predecessor digest.
		const readProtected = async (path: string) => readFile(path);
		const planBytes = await readFile(planPath);
		await expect(
			assertLxdOfficeServiceBootstrapContinuity(
				{ planBytes, planPath, predecessorSha256: sha(originalBytes), binding: f.binding },
				readProtected,
				signal(),
			),
		).resolves.toBe(2);
		await expect(
			assertLxdOfficeServiceBootstrapContinuity(
				{ planBytes, planPath, predecessorSha256: one.planSha256, binding: f.binding },
				readProtected,
				signal(),
			),
		).resolves.toBe(1);
		// The same certificate again is not a revision.
		await expect(
			reviseLxdOfficeServiceBootstrapCredential(
				planPath,
				f.binding.allocationId,
				await readFile(second.cert),
				await readFile(second.key),
				"again",
				Date.now(),
			),
		).rejects.toThrow("OFFICE_CREDENTIAL_ALREADY_NAMED");
	});
});
