import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudSha256 } from "../src/cloud-file-bytes.ts";
import {
	CloudMemberFolderClient,
	CloudMemberFolderError,
	prepareCloudMemberFolderUpload,
} from "../src/cloud-member-folder.ts";

const env = "63000000-0000-4000-8000-000000000020";
const uploadId = "63000000-0000-4000-8000-0000000000f1";
const commitId = "63000000-0000-4000-8000-0000000000c1";
const path = "apps/lagerliste/versions/1/Lagerliste.exe";
const MiB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("SHA-256 piece by piece", () => {
	it("gives what one call over the whole gives, however the bytes are cut", () => {
		const bytes = randomBytes(300_000);
		for (const cuts of [[], [1], [63, 64, 65], [55, 56, 57, 119, 120], [4096, 150_000]]) {
			const hash = new CloudSha256();
			let from = 0;
			for (const cut of [...cuts, bytes.length]) {
				hash.update(bytes.subarray(from, cut));
				from = cut;
			}
			expect(hash.hex()).toBe(sha(bytes));
		}
		for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128])
			expect(new CloudSha256().update(bytes.subarray(0, size)).hex()).toBe(sha(bytes.subarray(0, size)));
	});
});

function gateway(
	options: {
		have?: number[];
		piece?: (index: number, call: number) => Response | undefined | Promise<Response | undefined>;
		open?: (call: number) => Response | undefined;
		finish?: Record<string, unknown>;
		finishHold?: Promise<unknown>;
	} = {},
) {
	const requests: { method: string; path: string; body: Uint8Array | null; type: string | null }[] = [];
	let opens = 0;
	const pieces = new Map<number, number>();
	const folder = new CloudMemberFolderClient({
		environmentId: env,
		supabaseUrl: "https://cloud.test/",
		objectGatewayUrl: "https://objects.test/",
		publishableKey: "sb_publishable_fixture",
		accessToken: async () => "member-token",
		pieceRetryMs: 0,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const body = init?.body;
			const bytes =
				body instanceof Blob
					? new Uint8Array(await body.arrayBuffer())
					: typeof body === "string"
						? new TextEncoder().encode(body)
						: null;
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer member-token");
			requests.push({
				method: init?.method ?? "GET",
				path: url.pathname,
				body: bytes,
				type: headers.get("content-type"),
			});
			const step = url.pathname.split("/").slice(3);
			if (step.length === 1) {
				const scripted = options.open?.(++opens);
				if (scripted) return scripted;
				return Response.json({ schema: "qorpera.member-program-upload/v1", uploadId, have: options.have ?? [] });
			}
			if (step[2] === "stop") return new Response(null, { status: 204 });
			if (step.length === 3) {
				const index = Number(step[2]);
				const call = (pieces.get(index) ?? 0) + 1;
				pieces.set(index, call);
				const scripted = await options.piece?.(index, call);
				if (scripted) return scripted;
				return Response.json({ schema: "qorpera.member-program-piece/v1", piece: index, bytes: bytes?.length });
			}
			await options.finishHold;
			return Response.json(
				options.finish ?? { schema: "qorpera.member-program-finish/v1", outcome: "saved", version: commitId },
			);
		},
	});
	const put = () => requests.filter((request) => request.method === "PUT");
	return { folder, requests, put };
}

async function until(check: () => boolean) {
	for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 0));
	expect(check()).toBe(true);
}

const fileOf = (size: number) => {
	const bytes = randomBytes(size);
	return { bytes, blob: new Blob([bytes]) };
};

describe("a member's program file going up", () => {
	it("names the file's hash and each 4 MiB piece's, sends each piece once, and finishes with the member's key", async () => {
		const { bytes, blob } = fileOf(9 * MiB + 5);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		expect(prepared).toEqual({
			bytes: bytes.length,
			fileSha256: sha(bytes),
			pieces: [sha(bytes.subarray(0, 4 * MiB)), sha(bytes.subarray(4 * MiB, 8 * MiB)), sha(bytes.subarray(8 * MiB))],
		});
		const g = gateway();
		const progress: number[] = [];
		const commit = await g.folder.uploadFile(path, blob, prepared, {
			operationKey: "web:63000000-0000-4000-8000-0000000000d1",
			signal: new AbortController().signal,
			onProgress: (sent, total) => {
				expect(total).toBe(bytes.length);
				progress.push(sent);
			},
		});
		expect(commit).toEqual({ outcome: "saved", version: commitId, reason: null });
		const [open] = g.requests;
		expect(open?.path).toBe(`/v1/member-program-uploads/${env}`);
		expect(JSON.parse(new TextDecoder().decode(open?.body ?? new Uint8Array()))).toEqual({
			schema: "qorpera.member-program-upload/v1",
			path,
			bytes: bytes.length,
			fileSha256: sha(bytes),
			pieces: prepared.pieces,
		});
		const put = g.put();
		expect(put.map((request) => request.path).sort()).toEqual(
			[0, 1, 2].map((index) => `/v1/member-program-uploads/${env}/${uploadId}/${index}`),
		);
		for (const request of put) {
			const index = Number(request.path.split("/").at(-1));
			expect(request.type).toBe("application/octet-stream");
			expect(sha(request.body ?? new Uint8Array())).toBe(prepared.pieces[index]);
		}
		expect(progress[0]).toBe(0);
		expect(progress.at(-1)).toBe(bytes.length);
		expect([...progress].sort((a, b) => a - b)).toEqual(progress);
		const finish = g.requests.at(-1);
		expect(finish?.path).toBe(`/v1/member-program-uploads/${env}/${uploadId}`);
		expect(JSON.parse(new TextDecoder().decode(finish?.body ?? new Uint8Array()))).toEqual({
			schema: "qorpera.member-program-finish/v1",
			operationKey: "web:63000000-0000-4000-8000-0000000000d1",
		});
	});

	it("tries a piece again after an outage or a lost answer, and sends only what the gateway lacks on a resume", async () => {
		const { blob } = fileOf(12 * MiB);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		const g = gateway({
			have: [0],
			piece: (index, call) => (index === 2 && call < 3 ? new Response(null, { status: 503 }) : undefined),
		});
		const progress: number[] = [];
		await g.folder.uploadFile(path, blob, prepared, {
			operationKey: "web:k",
			signal: new AbortController().signal,
			onProgress: (sent) => progress.push(sent),
		});
		const sent = g.put().map((request) => Number(request.path.split("/").at(-1)));
		expect(sent.filter((index) => index === 0)).toEqual([]);
		expect(sent.filter((index) => index === 2)).toEqual([2, 2, 2]);
		expect(progress[0]).toBe(4 * MiB);
		expect(progress.at(-1)).toBe(12 * MiB);
	});

	it("waits while the gateway holds enough pieces ahead, and starts once again when the upload is gone", async () => {
		const { blob } = fileOf(5 * MiB);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		const g = gateway({
			piece: (index, call) =>
				index === 1 && call === 1
					? new Response(null, { status: 409 })
					: index === 0 && call === 1
						? new Response(null, { status: 404 })
						: undefined,
		});
		const commit = await g.folder.uploadFile(path, blob, prepared, {
			operationKey: "web:k",
			signal: new AbortController().signal,
		});
		expect(commit.version).toBe(commitId);
		expect(g.requests.filter((request) => request.path === `/v1/member-program-uploads/${env}`)).toHaveLength(2);
	});

	it("answers a file already at its path, another or this one, as the gateway found it", async () => {
		const { blob } = fileOf(10);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		const exists = gateway({
			finish: { schema: "qorpera.member-program-finish/v1", outcome: "exists", version: null },
		});
		expect(
			await exists.folder.uploadFile(path, blob, prepared, {
				operationKey: "web:k",
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "exists", version: null, reason: null });
		const denied = gateway({
			finish: { schema: "qorpera.member-program-finish/v1", outcome: "denied", version: null, reason: "denied" },
		});
		expect(
			(
				await denied.folder.uploadFile(path, blob, prepared, {
					operationKey: "web:k",
					signal: new AbortController().signal,
				})
			).reason,
		).toBe("denied");
		const broken = gateway({
			finish: { schema: "qorpera.member-program-finish/v1", outcome: "saved", version: null },
		});
		await expect(
			broken.folder.uploadFile(path, blob, prepared, {
				operationKey: "web:k",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Invalid company folder upload finish");
	});

	it("goes down to one piece at a time on a line too slow for three, and only then counts a late piece as a try", async () => {
		const { blob } = fileOf(20 * MiB);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		let going = 0;
		const g = gateway({
			piece: async () => {
				going++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				const late = going > 1;
				going--;
				return late ? new Response(null, { status: 408 }) : undefined;
			},
		});
		const result = await g.folder.uploadFile(path, blob, prepared, {
			operationKey: "web:k",
			signal: new AbortController().signal,
		});
		expect(result.outcome).toBe("saved");
		const sent = new Set(g.put().map((request) => request.path));
		expect(sent.size).toBe(5);
		const dead = gateway({ piece: () => new Response(null, { status: 408 }) });
		const error = await dead.folder
			.uploadFile(path, blob, prepared, { operationKey: "web:k", signal: new AbortController().signal })
			.catch((caught: unknown) => caught);
		expect((error as CloudMemberFolderError).status).toBe(408);
		expect(dead.put().length).toBeLessThan(12);
	});

	it("lets a finish already sent come back after the member's stop, so the caller knows whether the file was put", async () => {
		const { blob } = fileOf(10);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		const stop = new AbortController();
		let answer = () => {};
		const g = gateway({
			finishHold: new Promise<void>((resolve) => {
				answer = resolve;
			}),
		});
		const going = g.folder.uploadFile(path, blob, prepared, { operationKey: "web:k", signal: stop.signal });
		await until(() => g.requests.some((request) => request.path === `/v1/member-program-uploads/${env}/${uploadId}`));
		stop.abort(new Error("left the page"));
		answer();
		expect(await going).toEqual({ outcome: "saved", version: commitId, reason: null });
	});

	it("refuses a file past 256 MiB before any request, and gives a refusal its status without trying again", async () => {
		const huge = { size: 256 * MiB + 1, slice: () => new Blob([]) } as unknown as Blob;
		await expect(prepareCloudMemberFolderUpload(huge, new AbortController().signal)).rejects.toMatchObject({
			status: 413,
		});
		const { blob } = fileOf(10);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		for (const status of [403, 413, 423, 429]) {
			const g = gateway({ open: () => new Response(null, { status }) });
			const error = await g.folder
				.uploadFile(path, blob, prepared, { operationKey: "web:k", signal: new AbortController().signal })
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CloudMemberFolderError);
			expect((error as CloudMemberFolderError).status).toBe(status);
			expect(g.requests).toHaveLength(1);
		}
		await expect(
			gateway().folder.uploadFile(path, new Blob([new Uint8Array(11)]), prepared, {
				operationKey: "web:k",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("Invalid company folder upload");
	});

	it("stops when the member leaves: no more pieces, and the gateway is told to forget the upload", async () => {
		const { blob } = fileOf(16 * MiB);
		const prepared = await prepareCloudMemberFolderUpload(blob, new AbortController().signal);
		const stop = new AbortController();
		const g = gateway({
			piece: (index) => {
				if (index === 1) stop.abort(new Error("left the page"));
				return undefined;
			},
		});
		await expect(
			g.folder.uploadFile(path, blob, prepared, { operationKey: "web:k", signal: stop.signal }),
		).rejects.toThrow("left the page");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(g.requests.at(-1)?.path).toBe(`/v1/member-program-uploads/${env}/${uploadId}/stop`);
		expect(g.put().length).toBeLessThanOrEqual(3);
		expect(g.requests.some((request) => request.path === `/v1/member-program-uploads/${env}/${uploadId}`)).toBe(
			false,
		);
	});
});
