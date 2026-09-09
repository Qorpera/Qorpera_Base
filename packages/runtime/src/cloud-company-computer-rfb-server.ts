import { assertCompanyComputerRfbPixelFormat } from "@qorpera/cloud-client/node/cloud-company-computer-rfb";

type Stage =
	| "version"
	| "security"
	| "security_result"
	| "init"
	| "messages"
	| "rectangle"
	| "length32"
	| "rre"
	| "hextile"
	| "tight"
	| "tight_filter"
	| "tight_palette"
	| "tight_length"
	| "vmware_cursor"
	| "desktop_name"
	| "extended_desktop"
	| "h264"
	| "jpeg_marker"
	| "jpeg_scan";
type Destination = "messages" | "rectangle_done" | "tile_done" | "tight_data" | "jpeg_marker" | "jpeg_scan";

/**
 * Server-side RFB 3.8 framing, following the unchanged vendored noVNC decoders.
 * Only ServerCutText is removed. Pixel/compressed payloads are streamed unchanged,
 * never searched for clipboard byte patterns or decompressed. Both directions
 * pin the image's 32-bit true-color format so pixel payload lengths cannot drift.
 * Unknown/malformed framing fails closed; memory does not grow with a framebuffer.
 */
export class CompanyComputerRfbServerParser {
	#buffer = Buffer.alloc(0);
	#output: Buffer[] = [];
	#stage: Stage = "version";
	#remaining = 0;
	#discard = false;
	#destination: Destination = "messages";
	#rectangles = 0;
	#rectangleCount = 0;
	#frameBytes = 0;
	#width = 0;
	#height = 0;
	#encoding = 0;
	#tileX = 0;
	#tileY = 0;
	#tightBytes = 0;

	push(chunk: Uint8Array): Buffer[] {
		if (this.#buffer.length + chunk.length > 256 * 1024) throw new Error("RFB_SERVER_BUFFER_LIMIT");
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		this.#output = [];
		let steps = 0;
		while (this.#buffer.length > 0) {
			if (++steps > 65_536) throw new Error("RFB_SERVER_MESSAGE_LIMIT");
			if (this.#remaining > 0) {
				const count = Math.min(this.#remaining, this.#buffer.length);
				this.#take(count, !this.#discard);
				this.#remaining -= count;
				if (this.#remaining === 0) this.#advance();
			} else if (!this.#header()) break;
		}
		const output = this.#output;
		this.#output = [];
		return output;
	}

	#take(length: number, forward = true): void {
		if (this.#rectangles > 0) {
			this.#frameBytes += length;
			if (this.#frameBytes > 64 * 1024 * 1024) throw new Error("RFB_FRAMEBUFFER_LIMIT");
		}
		if (forward && length > 0) this.#output.push(Buffer.from(this.#buffer.subarray(0, length)));
		this.#buffer = this.#buffer.subarray(length);
	}

	#body(length: number, destination: Destination, discard = false): void {
		if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024)
			throw new Error("RFB_RECTANGLE_LIMIT");
		this.#remaining = length;
		this.#destination = destination;
		this.#discard = discard;
		if (length === 0) this.#advance();
	}

	#advance(): void {
		if (this.#destination === "rectangle_done") {
			this.#rectangles--;
			this.#stage = this.#rectangles > 0 ? "rectangle" : "messages";
		} else if (this.#destination === "tile_done") {
			this.#tileX += 16;
			if (this.#tileX >= this.#width) {
				this.#tileX = 0;
				this.#tileY += 16;
			}
			if (this.#tileY >= this.#height) this.#body(0, "rectangle_done");
			else this.#stage = "hextile";
		} else if (this.#destination === "tight_data") {
			if (this.#tightBytes < 12) this.#body(this.#tightBytes, "rectangle_done");
			else this.#stage = "tight_length";
		} else this.#stage = this.#destination;
	}

	#header(): boolean {
		const bytes = this.#buffer;
		if (this.#stage === "version") {
			if (bytes.length < 12) return false;
			if (!bytes.subarray(0, 12).equals(Buffer.from("RFB 003.008\n"))) throw new Error("RFB_VERSION_UNSUPPORTED");
			this.#take(12);
			this.#stage = "security";
		} else if (this.#stage === "security") {
			if (bytes.length < 2) return false;
			if (bytes[0] !== 1 || bytes[1] !== 1) throw new Error("RFB_HANDSHAKE_UNSUPPORTED");
			this.#take(2);
			this.#stage = "security_result";
		} else if (this.#stage === "security_result") {
			if (bytes.length < 4) return false;
			if (bytes.readUInt32BE() !== 0) throw new Error("RFB_HANDSHAKE_UNSUPPORTED");
			this.#take(4);
			this.#stage = "init";
		} else if (this.#stage === "init") {
			if (bytes.length < 24) return false;
			assertCompanyComputerRfbPixelFormat(bytes);
			if (bytes.readUInt16BE(0) !== 1920 || bytes.readUInt16BE(2) !== 1200)
				throw new Error("RFB_SCREEN_SIZE_UNSUPPORTED");
			const length = bytes.readUInt32BE(20);
			if (length > 4096) throw new Error("RFB_DESKTOP_NAME_LIMIT");
			this.#take(24);
			this.#body(length, "messages");
		} else if (this.#stage === "messages") {
			return this.#message();
		} else if (this.#stage === "rectangle") {
			return this.#rectangle();
		} else if (this.#stage === "length32" || this.#stage === "desktop_name" || this.#stage === "h264") {
			const header = this.#stage === "h264" ? 8 : 4;
			if (bytes.length < header) return false;
			const length = bytes.readUInt32BE();
			if (this.#stage === "desktop_name" && length > 4096) throw new Error("RFB_DESKTOP_NAME_LIMIT");
			this.#take(header);
			this.#body(length, "rectangle_done");
		} else if (this.#stage === "rre") {
			if (bytes.length < 4) return false;
			const length = 4 + bytes.readUInt32BE() * 12;
			this.#take(4);
			this.#body(length, "rectangle_done");
		} else if (this.#stage === "hextile") {
			const code = bytes[0];
			if (code > 30) throw new Error("RFB_HEXTILE_UNSUPPORTED");
			if (code & 1) {
				this.#take(1);
				this.#body(
					Math.min(16, this.#width - this.#tileX) * Math.min(16, this.#height - this.#tileY) * 4,
					"tile_done",
				);
			} else {
				const header = 1 + (code & 2 ? 4 : 0) + (code & 4 ? 4 : 0) + (code & 8 ? 1 : 0);
				if (bytes.length < header) return false;
				const length = code & 8 ? bytes[header - 1] * (code & 16 ? 6 : 2) : 0;
				this.#take(header);
				this.#body(length, "tile_done");
			}
		} else if (this.#stage === "tight") {
			const control = bytes[0] >> 4;
			if (control > 10 || (control === 10 && this.#encoding !== -260) || (control < 8 && this.#encoding === -260))
				throw new Error("RFB_TIGHT_UNSUPPORTED");
			this.#take(1);
			if (control === 8) this.#body(3, "rectangle_done");
			else if (control === 9 || control === 10) this.#stage = "tight_length";
			else if (control & 4) this.#stage = "tight_filter";
			else {
				this.#tightBytes = this.#width * this.#height * 3;
				this.#body(0, "tight_data");
			}
		} else if (this.#stage === "tight_filter") {
			const filter = bytes[0];
			if (filter > 2) throw new Error("RFB_TIGHT_FILTER_UNSUPPORTED");
			this.#take(1);
			if (filter === 1) this.#stage = "tight_palette";
			else {
				this.#tightBytes = this.#width * this.#height * 3;
				this.#body(0, "tight_data");
			}
		} else if (this.#stage === "tight_palette") {
			// noVNC retains palette state for empty palette rectangles. Refuse that
			// ambiguous case rather than let its next rectangle and this parser drift.
			if (this.#width === 0 || this.#height === 0) throw new Error("RFB_TIGHT_PALETTE_EMPTY");
			const colors = bytes[0] + 1;
			this.#tightBytes = Math.ceil((this.#width * (colors <= 2 ? 1 : 8)) / 8) * this.#height;
			this.#take(1);
			this.#body(colors * 3, "tight_data");
		} else if (this.#stage === "tight_length") {
			let header = 1;
			let length = bytes[0] & 127;
			if (bytes[0] & 128) {
				if (bytes.length < 2) return false;
				header = 2;
				length |= (bytes[1] & 127) << 7;
				if (bytes[1] & 128) {
					if (bytes.length < 3) return false;
					header = 3;
					length |= bytes[2] << 14;
				}
			}
			this.#take(header);
			this.#body(length, "rectangle_done");
		} else if (this.#stage === "vmware_cursor") {
			if (bytes.length < 2) return false;
			const type = bytes[0];
			if (type !== 0 && type !== 1) throw new Error("RFB_CURSOR_UNSUPPORTED");
			this.#take(2);
			this.#body(this.#width * this.#height * (type === 0 ? 8 : 4), "rectangle_done");
		} else if (this.#stage === "extended_desktop") {
			if (bytes.length < 4) return false;
			const screens = bytes[0];
			if (screens > 32) throw new Error("RFB_DESKTOP_LAYOUT_LIMIT");
			this.#take(4);
			this.#body(screens * 16, "rectangle_done");
		} else if (this.#stage === "jpeg_marker") {
			if (bytes.length < 2) return false;
			if (bytes[0] !== 255) throw new Error("RFB_JPEG_MARKER_INVALID");
			const marker = bytes[1];
			if ((marker >= 0xd0 && marker <= 0xd9) || marker === 1) {
				this.#take(2);
				if (marker === 0xd9) this.#body(0, "rectangle_done");
			} else {
				if (bytes.length < 4) return false;
				const length = bytes.readUInt16BE(2);
				if (length < 2) throw new Error("RFB_JPEG_LENGTH_INVALID");
				this.#take(4);
				this.#body(length - 2, marker === 0xda ? "jpeg_scan" : "jpeg_marker");
			}
		} else if (this.#stage === "jpeg_scan") {
			const marker = bytes.indexOf(255);
			if (marker < 0) this.#take(bytes.length);
			else if (marker === bytes.length - 1) {
				this.#take(marker);
				return false;
			} else if (bytes[marker + 1] === 0 || (bytes[marker + 1] >= 0xd0 && bytes[marker + 1] <= 0xd7)) {
				this.#take(marker + 2);
			} else {
				this.#take(marker);
				this.#stage = "jpeg_marker";
			}
		}
		return true;
	}

	#message(): boolean {
		const bytes = this.#buffer;
		const type = bytes[0];
		if (type === 0) {
			if (bytes.length < 4) return false;
			this.#rectangles = bytes.readUInt16BE(2);
			this.#rectangleCount = 0;
			this.#frameBytes = 0;
			this.#take(4);
			if (this.#rectangles > 0) this.#stage = "rectangle";
		} else if (type === 3) {
			if (bytes.length < 8) return false;
			const length = Math.abs(bytes.readInt32BE(4));
			if (length > 64 * 1024) throw new Error("RFB_CLIPBOARD_LIMIT");
			this.#take(8, false);
			this.#body(length, "messages", true);
		} else if (type === 2 || type === 150) this.#take(1);
		else if (type === 248) {
			if (bytes.length < 9) return false;
			const length = bytes[8];
			if (length > 64) throw new Error("RFB_FENCE_LIMIT");
			this.#take(9);
			this.#body(length, "messages");
		} else if (type === 250) {
			if (bytes.length < 4) return false;
			this.#take(4);
		} else throw new Error("RFB_SERVER_MESSAGE_UNSUPPORTED");
		return true;
	}

	#rectangle(): boolean {
		const bytes = this.#buffer;
		if (bytes.length < 12) return false;
		if (++this.#rectangleCount > 4096) throw new Error("RFB_RECTANGLE_COUNT_LIMIT");
		this.#width = bytes.readUInt16BE(4);
		this.#height = bytes.readUInt16BE(6);
		this.#encoding = bytes.readInt32BE(8);
		if (this.#width > 1920 || this.#height > 1200) throw new Error("RFB_RECTANGLE_SIZE_UNSUPPORTED");
		const pixels = this.#width * this.#height;
		this.#take(12);
		switch (this.#encoding) {
			case 0:
				this.#body(pixels * 4, "rectangle_done");
				break;
			case 1:
				this.#body(4, "rectangle_done");
				break;
			case 2:
				this.#stage = "rre";
				break;
			case 5:
				this.#tileX = 0;
				this.#tileY = 0;
				if (pixels === 0) this.#body(0, "rectangle_done");
				else this.#stage = "hextile";
				break;
			case 6:
				if (pixels === 0) this.#body(0, "rectangle_done");
				else this.#stage = "length32";
				break;
			case 16:
				// Unlike Zlib, ZRLE always carries its length and compressed payload.
				this.#stage = "length32";
				break;
			case 7:
			case -260:
				this.#stage = "tight";
				break;
			case 21:
				this.#stage = "jpeg_marker";
				break;
			case 50:
				this.#stage = "h264";
				break;
			case -239:
				this.#body(pixels * 4 + Math.ceil(this.#width / 8) * this.#height, "rectangle_done");
				break;
			case 1464686180:
				this.#stage = "vmware_cursor";
				break;
			case -307:
				this.#stage = "desktop_name";
				break;
			case -308:
				this.#stage = "extended_desktop";
				break;
			case -261:
				this.#body(1, "rectangle_done");
				break;
			case -224:
				this.#rectangles = 1;
				this.#body(0, "rectangle_done");
				break;
			case -223:
			case -258:
			case -316:
				this.#body(0, "rectangle_done");
				break;
			default:
				throw new Error("RFB_SERVER_ENCODING_UNSUPPORTED");
		}
		return true;
	}
}
