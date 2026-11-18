import {
	CLOUD_VOICE_NAMES,
	type CloudVoiceCall,
	CloudVoiceChannel,
	CloudVoiceUnavailable,
	cloudVoiceOpenInput,
	isCloudVoiceName,
} from "@qorpera/runtime/cloud-voice-channel";
import { describe, expect, it, vi } from "vitest";

const OFFER = "v=0\r\nPRIVATE_OFFER_SDP\r\n";

describe("CloudVoiceChannel", () => {
	it("refuses a call while no run's lane is attached, and after it is detached", async () => {
		const channel = new CloudVoiceChannel();
		const signal = new AbortController().signal;
		await expect(channel.open({ offerSdp: OFFER }, signal)).rejects.toBeInstanceOf(CloudVoiceUnavailable);
		const call: CloudVoiceCall = {
			answerSdp: "v=0\r\nANSWER\r\n",
			speak: async () => ({ transcript: "" }),
			close: async () => undefined,
		};
		const lane = vi.fn(async () => call);
		channel.attach(lane);
		await expect(channel.open({ offerSdp: OFFER, voice: "cove" }, signal)).resolves.toBe(call);
		expect(lane).toHaveBeenCalledWith({ offerSdp: OFFER, voice: "cove" }, signal);
		channel.attach(undefined);
		await expect(channel.open({ offerSdp: OFFER }, signal)).rejects.toBeInstanceOf(CloudVoiceUnavailable);
		expect(lane).toHaveBeenCalledOnce();
		expect(channel.stopMs).toBeUndefined();
		expect(new CloudVoiceChannel({ stopMs: 200 }).stopMs).toBe(200);
	});
});

describe("cloudVoiceOpenInput", () => {
	it("takes an offer and, optionally, one of the allowed voices", () => {
		expect(cloudVoiceOpenInput({ offerSdp: OFFER })).toEqual({ offerSdp: OFFER });
		for (const voice of CLOUD_VOICE_NAMES)
			expect(cloudVoiceOpenInput({ offerSdp: OFFER, voice })).toEqual({ offerSdp: OFFER, voice });
		expect(CLOUD_VOICE_NAMES).toEqual([
			"juniper",
			"maple",
			"spruce",
			"ember",
			"vale",
			"breeze",
			"arbor",
			"sol",
			"cove",
		]);
	});

	it("refuses an unknown voice, and an offer that is empty or too large, without repeating either", () => {
		expect(() => cloudVoiceOpenInput({ offerSdp: OFFER, voice: "PRIVATE_VOICE" })).toThrow(/^Invalid voice name$/);
		expect(isCloudVoiceName("Cove")).toBe(false);
		expect(() => cloudVoiceOpenInput({ offerSdp: " \r\n" })).toThrow(/^Invalid voice offer$/);
		expect(() => cloudVoiceOpenInput({ offerSdp: "x".repeat(64 * 1024 + 1) })).toThrow(/^Invalid voice offer$/);
		expect(() => cloudVoiceOpenInput({ offerSdp: 7 as never })).toThrow(/^Invalid voice offer$/);
	});
});
