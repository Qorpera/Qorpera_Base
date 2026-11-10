// A stand-in for Playwright in the tests of the explainer kit's voice scripts (the scripts load it through
// QORPERA_PLAYWRIGHT). Its page runs a script's page functions in this process, over stand-ins for the few browser
// things they use, and plays one scenario (QORPERA_VOICE_SCENARIO):
//   captions         a started video with two captions
//   captions-failed  a page that says its script has a mistake, with the captions it got to still in the video
//   turn             a call in which the voice speaks one turn
//   turn-slow-write  the same, with the turn's file written two seconds late
//   turn-lost-write  the same, with the turn's file refused
//   turn-stalled-write  the same, with the turn's file never written
//   turn-last-moment-write  the same, with the turn's file written 1.95 s after the recorder is told to stop
const fs = require("node:fs");
const path = require("node:path");
const scenario = process.env.QORPERA_VOICE_SCENARIO || "turn";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// When the recorder was told to stop (its work folder is its first argument), as seen from here.
let stopSeen = 0;
const watching = setInterval(() => {
	if (!stopSeen && process.argv[2] && fs.existsSync(path.join(process.argv[2], "stop"))) stopSeen = Date.now();
}, 10);
watching.unref();

function captionsPage() {
	globalThis.V = { segments: [{ text: "Each traveller pays one fee." }, { text: "So four friends see it." }] };
	globalThis.captionHash = (text) => (text.startsWith("Each") ? "0000aaaa" : "0000bbbb");
	const failed = scenario === "captions-failed" ? { textContent: "This video's script has a mistake (line 9): fee is not defined" } : null;
	globalThis.document = { querySelector: (selector) => (selector === ".vp-fail" ? failed : null) };
}

function callPage() {
	// The sound of the call: loud while the voice speaks.
	let loud = false;
	globalThis.window = globalThis;
	globalThis.AudioContext = class {
		resume() {
			return Promise.resolve();
		}
		createMediaStreamDestination() {
			return { stream: { getAudioTracks: () => [{}] } };
		}
		createConstantSource() {
			return { offset: { value: 1 }, connect() {}, start() {} };
		}
		createAnalyser() {
			return { fftSize: 0, getFloatTimeDomainData: (samples) => samples.fill(loud ? 0.2 : 0) };
		}
		createMediaStreamSource() {
			return { connect() {} };
		}
	};
	globalThis.Audio = class {
		play() {
			return Promise.resolve();
		}
	};
	globalThis.MediaStream = class {};
	globalThis.MediaRecorder = class {
		start() {
			this.ondataavailable?.({ data: new Blob([Buffer.from("the turn's sound")]) });
		}
		stop() {
			setTimeout(() => this.onstop?.(), 10);
		}
	};
	globalThis.RTCPeerConnection = class {
		constructor() {
			this.iceGatheringState = "complete";
			this.connectionState = "new";
			this.localDescription = null;
		}
		addTrack() {}
		addEventListener() {}
		createDataChannel() {
			this.events = {};
			return this.events;
		}
		async createOffer() {
			return { type: "offer", sdp: "v=0 the offer\n" };
		}
		async setLocalDescription(description) {
			this.localDescription = description;
		}
		async setRemoteDescription() {
			this.connectionState = "connected";
			this.ontrack?.({ streams: [{}], track: {} });
			// The voice speaks one turn: its start, half a second of sound, its end, then quiet.
			const say = (type) => this.events.onmessage?.({ data: JSON.stringify({ type }) });
			setTimeout(() => {
				loud = true;
				say("turn.created");
			}, 200);
			setTimeout(() => say("turn.done"), 500);
			setTimeout(() => {
				loud = false;
			}, 700);
		}
	};
}

const page = {
	async goto() {
		captionsPage();
	},
	async exposeFunction(name, write) {
		callPage();
		globalThis[name] = async (...args) => {
			if (scenario === "turn-slow-write") await sleep(2000);
			if (scenario === "turn-lost-write") throw new Error("no room left on the machine");
			if (scenario === "turn-stalled-write") await new Promise(() => {});
			if (scenario === "turn-last-moment-write") {
				while (!stopSeen) await sleep(10);
				await sleep(Math.max(0, stopSeen + 1950 - Date.now()));
			}
			return write(...args);
		};
	},
	evaluate: async (run, arg) => run(arg),
};

exports.chromium = { launch: async () => ({ newPage: async () => page, close: async () => {} }) };
