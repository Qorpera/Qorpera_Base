import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	chown,
	type FileHandle,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveCompanyComputerResetOutbox,
	type CompanyComputerResetOutboxOptions,
	inventoryCompanyComputerResetOutbox,
	restoreCompanyComputerResetOutbox,
} from "../../src/cloud-company-computer-reset-custody.ts";
import type { CompanyComputerScreenObservation } from "../../src/cloud-company-computer-screen-lifecycle.ts";
import { CompanyComputerScreenOutbox } from "../../src/cloud-company-computer-screen-outbox.ts";
import { computerBinding } from "./company-computer.ts";
import { screenStartup } from "./screen-lifecycle.ts";

assert.equal(process.platform, "linux", "Physical filesystem probe requires Linux");
assert.equal(process.getuid?.(), 0, "Physical ownership probe requires isolated root");

const signal = () => new AbortController().signal;
const roots: string[] = [];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Observe and fault the actual Node FileHandle sync operation. This disposable
// Linux tmpfs checks required syscall ordering/refusal, not power-loss survival.
async function traceSync(
	run: () => Promise<unknown>,
	fail?: (path: string, index: number) => boolean | Promise<boolean>,
): Promise<string[]> {
	const handle = await open("/tmp", "r");
	const prototype = Object.getPrototypeOf(handle) as { sync(this: FileHandle): Promise<void> };
	const original = prototype.sync;
	await handle.close();
	const paths: string[] = [];
	prototype.sync = async function (this: FileHandle) {
		const path = await realpath(`/proc/self/fd/${this.fd}`);
		paths.push(path);
		if (await fail?.(path, paths.length - 1)) throw new Error("injected custody fsync failure");
		await original.call(this);
	};
	try {
		await run();
		return paths;
	} finally {
		prototype.sync = original;
	}
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "reset-custody-"));
	roots.push(root);
	const guestRoot = join(root, "old"),
		nextRoot = join(root, "new"),
		source = join(guestRoot, "outbox"),
		destination = join(nextRoot, "outbox"),
		archive = join(root, "archive"),
		excluded = join(root, "model");
	for (const path of [guestRoot, nextRoot, source, destination, archive, excluded]) await mkdir(path, { mode: 0o700 });
	const startup = screenStartup();
	const options: CompanyComputerResetOutboxOptions = {
		binding: {
			schema: "qorpera.office-reset-custody-binding/v1",
			resetId: randomUUID(),
			transitionId: randomUUID(),
			predecessorActivationId: randomUUID(),
			successorActivationId: randomUUID(),
			rootIncarnationId: randomUUID(),
			predecessor: startup,
			outboxUid: process.getuid!(),
			outboxGid: process.getgid!(),
		},
		guestRoot,
		excludedRoots: [excluded],
		guard: {
			async assertStoppedAndExclusive(s) {
				s.throwIfAborted();
			},
		},
	};
	const queue = await CompanyComputerScreenOutbox.open(source, startup.scope, [excluded], {
		async call() {
			throw new Error("no SQL in custody fixture");
		},
	});
	const lifetimeId = randomUUID();
	for (const [index, [state, reason]] of (
		[
			["requested", "SCREEN_REQUESTED"],
			["ready", "DESKTOP_READY"],
			["failed", "DESKTOP_EXITED"],
		] as const
	).entries()) {
		const observation: CompanyComputerScreenObservation = {
			schema: "qorpera.runtime-screen-observation/v1",
			startup: { ...startup, bootId: "12345678-1234-4234-8234-123456789012" },
			binding: computerBinding(),
			privacy: null,
			event: {
				lifetimeId,
				eventId: randomUUID(),
				sequence: index + 1,
				observedAt: `2026-09-12T01:32:5${index}.000Z`,
				state,
				reason,
			},
		};
		await queue.retain(observation, signal());
	}
	await queue.close();
	const names = (await readdir(source)).sort(),
		bytes = new Map(
			await Promise.all(names.map(async (name) => [name, await readFile(join(source, name))] as const)),
		);
	return { root, guestRoot, nextRoot, source, destination, archive, excluded, options, names, bytes };
}
let checks = 0;
try {
	{
		const f = await fixture(),
			before = await inventoryCompanyComputerResetOutbox(f.source, f.options, signal());
		const sealed = await archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal());
		assert.deepEqual(sealed.manifest, before);
		assert.equal(sealed.manifestSha256, digest(await readFile(join(f.archive, "manifest.json"))));
		assert.deepEqual(await archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()), sealed);
		await rm(f.guestRoot, { recursive: true }); // Only this disposable fixture root.
		const restoreOptions = { ...f.options, guestRoot: f.nextRoot };
		const receipt = await restoreCompanyComputerResetOutbox(
			f.archive,
			f.destination,
			restoreOptions,
			sealed.manifestSha256,
			signal(),
		);
		assert.equal(receipt.state, "restored");
		assert.deepEqual(
			await restoreCompanyComputerResetOutbox(
				f.archive,
				f.destination,
				restoreOptions,
				sealed.manifestSha256,
				signal(),
			),
			receipt,
		);
		for (const [name, bytes] of f.bytes) assert.deepEqual(await readFile(join(f.destination, name)), bytes);
		const original = [...f.bytes.values()]
			.filter((bytes) => JSON.parse(bytes.toString()).schema === "qorpera.runtime-screen-observation/v1")
			.map((bytes) => bytes.toString());
		const delivered: string[] = [];
		const restored = await CompanyComputerScreenOutbox.open(
			f.destination,
			f.options.binding.predecessor.scope,
			[f.excluded],
			{
				async call(method, args) {
					if (method === "qorpera_record_runtime_screen_event")
						throw new Error("fixture historical authority loss");
					assert.equal(method, "qorpera_retain_runtime_screen_observation");
					const bytes = args.p_record as string,
						observation = JSON.parse(bytes),
						{ reason: _reason, ...event } = observation.event;
					delivered.push(bytes);
					return {
						schema: "qorpera.runtime-screen-retention-receipt/v1",
						confirmation: "unconfirmed",
						...event,
						observationSha256: digest(Buffer.from(bytes)),
						retainedAt: "2026-09-12T03:00:00.000Z",
					};
				},
			},
		);
		for (let n = 0; n < 3; n++) await restored.flush(signal());
		await restored.close();
		assert.deepEqual(delivered, original);
		assert.deepEqual(await readdir(f.destination), ["scope.json"]);
		for (const [name, bytes] of f.bytes) assert.deepEqual(await readFile(join(f.archive, name)), bytes);
		checks++;
	}
	for (const mutation of [
		"symlink",
		"hardlink",
		"mode",
		"oversize",
		"extra",
		"temporary",
		"noncanonical",
		"scope",
		"credential",
	]) {
		const f = await fixture(),
			name = f.names[0],
			path = join(f.source, name);
		if (mutation === "symlink") {
			await rename(path, join(f.root, "saved"));
			await symlink(join(f.root, "saved"), path);
		}
		if (mutation === "hardlink") await link(path, join(f.root, "linked"));
		if (mutation === "mode") await chmod(path, 0o644);
		if (mutation === "oversize") await writeFile(path, Buffer.alloc(73730));
		if (mutation === "extra")
			await writeFile(join(f.source, "private.key"), "NOT_A_REAL_CREDENTIAL", { mode: 0o600 });
		if (mutation === "temporary")
			await writeFile(join(f.source, `.write-${randomUUID()}`), "partial", { mode: 0o600 });
		if (mutation === "noncanonical") await writeFile(path, Buffer.concat([f.bytes.get(name)!, Buffer.from(" ")]));
		if (mutation === "scope") await writeFile(join(f.source, "scope.json"), "{}\n");
		if (mutation === "credential") {
			const value = JSON.parse(f.bytes.get(name)!.toString());
			value.credential = "NOT_A_REAL_CREDENTIAL";
			await writeFile(path, `${JSON.stringify(value)}\n`);
		}
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()));
		assert.deepEqual(await readdir(f.archive), []);
		checks++;
	}
	{
		const f = await fixture();
		await assert.rejects(
			inventoryCompanyComputerResetOutbox(f.source, { ...f.options, excludedRoots: [] }, signal()),
		);
		await assert.rejects(
			archiveCompanyComputerResetOutbox(f.source, f.archive, { ...f.options, excludedRoots: [f.root] }, signal()),
		);
		const inside = join(f.guestRoot, "archive");
		await mkdir(inside, { mode: 0o700 });
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, inside, f.options, signal()));
		await chmod(f.archive, 0o755);
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()));
		await chmod(f.archive, 0o700);
		const alias = join(f.root, "alias");
		await symlink(f.archive, alias);
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, alias, f.options, signal()));
		checks++;
	}
	{
		const f = await fixture();
		let calls = 0;
		const options = {
			...f.options,
			guard: {
				async assertStoppedAndExclusive() {
					if (++calls === 2) {
						await rename(f.source, `${f.source}-old`);
						await symlink(f.excluded, f.source);
					}
				},
			},
		};
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, f.archive, options, signal()));
		assert(!(await readdir(f.archive)).includes("manifest.json"));
		assert.deepEqual(await readdir(f.excluded), []);
		checks++;
	}
	{
		const f = await fixture();
		let calls = 0;
		await assert.rejects(
			archiveCompanyComputerResetOutbox(
				f.source,
				f.archive,
				{
					...f.options,
					guard: {
						async assertStoppedAndExclusive() {
							if (++calls === 3) throw new Error("writer fence lost");
						},
					},
				},
				signal(),
			),
			/writer fence lost/,
		);
		assert(!(await readdir(f.archive)).includes("manifest.json"));
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()));
		for (const [name, bytes] of f.bytes) assert.deepEqual(await readFile(join(f.source, name)), bytes);
		checks++;
	}
	{
		const f = await fixture(),
			sealed = await archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()),
			options = { ...f.options, guestRoot: f.nextRoot };
		await assert.rejects(
			restoreCompanyComputerResetOutbox(f.archive, f.destination, options, "0".repeat(64), signal()),
		);
		await assert.rejects(
			restoreCompanyComputerResetOutbox(
				f.archive,
				f.destination,
				{ ...options, binding: { ...options.binding, resetId: randomUUID() } },
				sealed.manifestSha256,
				signal(),
			),
		);
		assert.deepEqual(await readdir(f.destination), []);
		const path = join(f.archive, f.names[0]);
		await writeFile(path, Buffer.concat([f.bytes.get(f.names[0])!, Buffer.from(" ")]));
		await assert.rejects(
			restoreCompanyComputerResetOutbox(f.archive, f.destination, options, sealed.manifestSha256, signal()),
		);
		assert.deepEqual(await readdir(f.destination), []);
		checks++;
	}
	{
		const f = await fixture(),
			sealed = await archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal()),
			options = { ...f.options, guestRoot: f.nextRoot };
		await writeFile(join(f.destination, "scope.json"), "{}\n", { mode: 0o600 });
		await assert.rejects(
			restoreCompanyComputerResetOutbox(f.archive, f.destination, options, sealed.manifestSha256, signal()),
		);
		assert.equal(await readFile(join(f.destination, "scope.json"), "utf8"), "{}\n");
		checks++;
	}
	{
		const f = await fixture();
		const ids = { outboxUid: 1001, outboxGid: 1002 };
		await chown(f.source, ids.outboxUid, ids.outboxGid);
		await chown(f.destination, ids.outboxUid, ids.outboxGid);
		for (const name of f.names) await chown(join(f.source, name), ids.outboxUid, ids.outboxGid);
		const options = { ...f.options, binding: { ...f.options.binding, ...ids } };
		const sealed = await archiveCompanyComputerResetOutbox(f.source, f.archive, options, signal());
		await restoreCompanyComputerResetOutbox(
			f.archive,
			f.destination,
			{ ...options, guestRoot: f.nextRoot },
			sealed.manifestSha256,
			signal(),
		);
		for (const name of f.names) {
			const s = await lstat(join(f.destination, name));
			assert.equal(s.uid, ids.outboxUid);
			assert.equal(s.gid, ids.outboxGid);
			assert.equal(s.mode & 0o7777, 0o600);
			assert.equal(s.nlink, 1);
		}
		checks++;
	}
	{
		const f = await fixture(),
			controller = new AbortController();
		controller.abort();
		await assert.rejects(archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, controller.signal));
		assert.deepEqual(await readdir(f.archive), []);
		checks++;
	}
	{
		const f = await fixture();
		assert.deepEqual(await traceSync(() => inventoryCompanyComputerResetOutbox(f.source, f.options, signal())), []);
		await assert.rejects(inventoryCompanyComputerResetOutbox(f.source, { ...f.options, guestRoot: "/" }, signal()));
		checks++;
		const archive = () => archiveCompanyComputerResetOutbox(f.source, f.archive, f.options, signal());
		// Interrupt the actual first attempt after exclusive seal publication but
		// before syncing its directory. Readback now looks fully complete.
		await assert.rejects(
			traceSync(archive, async (path) => path === f.archive && (await readdir(f.archive)).includes("manifest.json")),
			/injected custody fsync failure/,
		);
		const archiveOrder = [
			...f.names.map((name) => join(f.archive, name)),
			join(f.archive, "manifest.json"),
			f.archive,
		];
		assert.deepEqual(await traceSync(archive), archiveOrder);
		for (let index = 0; index < archiveOrder.length; index++)
			await assert.rejects(
				traceSync(archive, (_path, current) => current === index),
				/injected custody fsync failure/,
			);
		assert.deepEqual(await traceSync(archive), archiveOrder);
		checks++;
		const sealed = await archive();
		const restore = () =>
			restoreCompanyComputerResetOutbox(
				f.archive,
				f.destination,
				{ ...f.options, guestRoot: f.nextRoot },
				sealed.manifestSha256,
				signal(),
			);
		// All names and bytes exist after this final-file write, but its fsync
		// fails. Recovery must flush every verified file then the directory.
		await assert.rejects(
			traceSync(restore, (path) => path === join(f.destination, f.names.at(-1)!)),
			/injected custody fsync failure/,
		);
		assert.deepEqual((await readdir(f.destination)).sort(), f.names);
		const restoreOrder = [...archiveOrder, ...f.names.map((name) => join(f.destination, name)), f.destination];
		assert.deepEqual(await traceSync(restore), restoreOrder);
		for (let index = 0; index < restoreOrder.length; index++)
			await assert.rejects(
				traceSync(restore, (_path, current) => current === index),
				/injected custody fsync failure/,
			);
		assert.deepEqual(await traceSync(restore), restoreOrder);
		for (const [name, bytes] of f.bytes) {
			assert.deepEqual(await readFile(join(f.source, name)), bytes);
			assert.deepEqual(await readFile(join(f.destination, name)), bytes);
		}
		checks++;
	}
	console.log(
		JSON.stringify({
			schema: "qorpera.reset-outbox-custody-probe/v1",
			checks,
			realLinuxFilesystem: true,
			originalBytesAndHistoricalStartupPreserved: true,
			exactOutboxReceiptReplay: true,
			archivePreserved: true,
			noCredentialsCopied: true,
			actualResetWorker: false,
			recoveredPrefixFsyncOrdering: true,
			powerLossDurabilityProof: false,
			sqlAuthority: "fixture guard",
			physicalRootLoss: "disposable local directory only",
		}),
	);
} finally {
	for (const root of roots) await rm(root, { recursive: true, force: true });
}
