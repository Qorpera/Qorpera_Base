import { describe, expect, it } from "vitest";
import { HttpCloudRunnerAssignmentInbox } from "../src/cloud-runner-assignment-inbox.ts";

const token = "a".repeat(43);
const assignment = {
	schema: "qorpera.runner-assignment-delivery/v1",
	assignment_id: "11111111-1111-4111-8111-111111111111",
	job_id: "22222222-2222-4222-8222-222222222222",
	capability: "b".repeat(43),
};

describe("cloud runner assignment inbox", () => {
	it("delivers one authenticated assignment and accepts an exact replay", async () => {
		const inbox = new HttpCloudRunnerAssignmentInbox("127.0.0.1", 0, token);
		const port = await inbox.start();
		try {
			const waiting = inbox.next(new AbortController().signal);
			const delivered = await fetch(`http://127.0.0.1:${port}/v1/assignment`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(assignment),
			});
			expect(delivered.status).toBe(202);
			await expect(waiting).resolves.toEqual({
				assignmentId: assignment.assignment_id,
				jobId: assignment.job_id,
				capability: assignment.capability,
			});

			const replayed = await fetch(`http://127.0.0.1:${port}/v1/assignment`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(assignment),
			});
			expect(replayed.status).toBe(200);
		} finally {
			await inbox.close();
		}
	});

	it("rejects unauthenticated, malformed, and second assignments", async () => {
		const inbox = new HttpCloudRunnerAssignmentInbox("127.0.0.1", 0, token);
		const port = await inbox.start();
		try {
			const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/assignment`, {
				method: "POST",
				body: JSON.stringify(assignment),
			});
			expect(unauthorized.status).toBe(401);
			const accepted = await fetch(`http://127.0.0.1:${port}/v1/assignment`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(assignment),
			});
			expect(accepted.status).toBe(202);
			const conflicting = await fetch(`http://127.0.0.1:${port}/v1/assignment`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ ...assignment, assignment_id: "33333333-3333-4333-8333-333333333333" }),
			});
			expect(conflicting.status).toBe(409);
		} finally {
			await inbox.close();
		}
	});

	it("requires one explicit trusted source for a private VM-network listener", async () => {
		expect(() => new HttpCloudRunnerAssignmentInbox("0.0.0.0", 0, token)).toThrow("trust one VM-network source");
		const inbox = new HttpCloudRunnerAssignmentInbox("0.0.0.0", 0, token, "127.0.0.1");
		const port = await inbox.start();
		try {
			const health = await fetch(`http://127.0.0.1:${port}/healthz`);
			expect(health.status).toBe(200);
		} finally {
			await inbox.close();
		}
	});
});
