/**
 * Tests for the Figma plug-in UI logic.
 *
 * The network code lives in src/ui.js because the plugin sandbox has no fetch.
 * The module is imported directly (it is plain JS) and run against a stubbed DOM,
 * fetch and localStorage, so the assertions are on the real implementation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(join(__dirname, "..", "src", "ui.js"), "utf8");

interface Call {
	url: string;
	init: RequestInit;
}

const IDS = [
	"status", "prompt", "model", "textModel", "output",
	"connect", "disconnect", "generate", "edit", "text", "appKey",
];

const harness = () => {
	const elements = new Map<string, Record<string, unknown>>();
	for (const id of IDS) {
		elements.set(id, {
			id, value: "", textContent: "", innerHTML: "", dataset: {},
			disabled: false, addEventListener: vi.fn(), appendChild: vi.fn(),
		});
	}
	const calls: Call[] = [];
	const posted: { type: string; [key: string]: unknown }[] = [];
	const opened: string[] = [];
	const storage = new Map<string, string>();
	let responder: (url: string, init: RequestInit) => Response = () =>
		new Response(JSON.stringify({}), { status: 200 });

	const document = {
		getElementById: (id: string) => elements.get(id) ?? null,
		createElement: () => ({ value: "", textContent: "" }),
	};
	const parent = { postMessage: (event: { pluginMessage: { type: string } }) => posted.push(event.pluginMessage) };
	const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return responder(url, init);
	});
	const window = {
		open: (url: string) => opened.push(url),
		onmessage: undefined as unknown,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	const localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	};

	const factory = new Function(
		"document", "parent", "fetch", "window", "localStorage", "setTimeout",
		`${source}\n;return { beginDeviceFlow, loadModels, generate, generateText, call,
		   setToken: (value) => { token = value; }, getToken: () => token };`,
	);
	// The polling interval has a 5s floor by design, which would outlast the test
	// timeout. Substitute a near-instant timer so the loop is exercised without
	// waiting; the floor itself is asserted separately.
	const fastTimeout = (fn: () => void, _ms?: number) => setTimeout(fn, 0);
	const api = factory(
		document, parent, fetchStub, window, localStorage, fastTimeout,
	) as {
		beginDeviceFlow: () => Promise<string>;
		loadModels: () => Promise<void>;
		generate: (mode: string) => Promise<unknown>;
		generateText: () => Promise<unknown>;
		call: (url: string, init?: RequestInit) => Promise<unknown>;
		setToken: (value: string | null) => void;
		getToken: () => string | null;
	};

	return {
		api, calls, posted, opened, elements, window,
		setResponder: (fn: typeof responder) => {
			responder = fn;
		},
		deviceCode: (extra: Record<string, unknown> = {}) =>
			new Response(JSON.stringify({
				device_code: "d", user_code: "NRX8V2H8", expires_in: 600, interval: 0,
				verification_uri: "https://enter.pollinations.ai/device",
				...extra,
			}), { status: 200 }),
		images: (models: unknown[]) => new Response(JSON.stringify(models), { status: 200 }),
		image: (b64 = "QUJD") => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 }),
	};
};

describe("figma ui network layer", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	it("runs the real source from src/ui.js", () => {
		expect(source).toContain("async function beginDeviceFlow");
		expect(source).toContain("pollinations.token");
		// The 5s polling floor is a real behaviour, so assert it exists even
		// though the tests substitute a fast timer.
		expect(source).toContain("Math.max(5, Number(code.interval || 5))");
	});

	it("turns HTTP errors into sentences and never leaks the body", async () => {
		h.setResponder(() => new Response(JSON.stringify({ echo: "sk_secret" }), { status: 402 }));
		await expect(h.api.call("https://gen.pollinations.ai/x")).rejects.toThrow(/Insufficient Pollen/);
		await h.api.call("https://gen.pollinations.ai/x").catch((error: Error) => {
			expect(error.message).not.toContain("sk_secret");
		});
	});

	it.each([
		[401, /expired/],
		[403, /Access denied/],
		[429, /Rate limit/],
		[500, /HTTP 500/],
	])("maps HTTP %i to its own message", async (status, pattern) => {
		h.setResponder(() => new Response("{}", { status }));
		await expect(h.api.call("https://gen.pollinations.ai/x")).rejects.toThrow(pattern);
	});

	it("asks for a device code, opens the approval page and returns the token", async () => {
		h.setResponder((url) =>
			url.includes("/api/device/code")
				? h.deviceCode()
				: new Response(JSON.stringify({ access_token: "sk_new" }), { status: 200 }),
		);
		await expect(h.api.beginDeviceFlow()).resolves.toBe("sk_new");
		expect(h.calls[0].url).toContain("/api/device/code");
		expect(h.opened[0]).toContain("enter.pollinations.ai/device");
	});

	it("sends an app key as client_id when one is given", async () => {
		h.setResponder((url) =>
			url.includes("/api/device/code")
				? h.deviceCode()
				: new Response(JSON.stringify({ access_token: "sk_x" }), { status: 200 }),
		);
		h.elements.get("appKey")!.value = "pk_publishable";
		await h.api.beginDeviceFlow();
		expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ client_id: "pk_publishable" });
	});

	it("keeps polling while authorization is pending", async () => {
		let polls = 0;
		h.setResponder((url) => {
			if (url.includes("/api/device/code")) return h.deviceCode();
			polls += 1;
			return polls < 3
				? new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 })
				: new Response(JSON.stringify({ access_token: "sk_done" }), { status: 200 });
		});
		await expect(h.api.beginDeviceFlow()).resolves.toBe("sk_done");
		expect(polls).toBe(3);
	});

	it("refuses a declined authorization", async () => {
		h.setResponder((url) =>
			url.includes("/api/device/code")
				? h.deviceCode()
				: new Response(JSON.stringify({ error: "access_denied" }), { status: 200 }),
		);
		await expect(h.api.beginDeviceFlow()).rejects.toThrow(/declined/);
	});

	it("rejects an incomplete authorization response", async () => {
		h.setResponder(() => new Response(JSON.stringify({ device_code: "d" }), { status: 200 }));
		await expect(h.api.beginDeviceFlow()).rejects.toThrow(/Invalid authorization/);
	});

	it("filters video-only models out of the image picker", async () => {
		h.setResponder((url) =>
			url.includes("/image/models")
				? h.images([
					{ name: "a/image", output_modalities: ["image"] },
					{ name: "b/video", output_modalities: ["video"] },
				])
				: h.images([{ name: "t/text" }]),
		);
		h.api.setToken("sk_x");
		await h.api.loadModels();
		const appended = (h.elements.get("model")!.appendChild as ReturnType<typeof vi.fn>).mock.calls;
		expect(appended).toHaveLength(1);
	});

	it("posts generated bytes to the sandbox", async () => {
		h.setResponder((url) => {
			if (url.includes("/image/models")) return h.images([{ name: "m", output_modalities: ["image"] }]);
			if (url.includes("/text/models")) return h.images([]);
			return h.image();
		});
		h.api.setToken("sk_x");
		await h.api.loadModels();
		h.elements.get("model")!.value = "m";
		h.elements.get("prompt")!.value = "a fox";
		await h.api.generate("generate");
		expect(h.posted.some((m) => m.type === "place-image")).toBe(true);
	});

	it("refuses to generate without a prompt, a token or a model", async () => {
		await h.api.generate("generate");
		expect(h.calls).toHaveLength(0);
		h.elements.get("prompt")!.value = "something";
		await h.api.generate("generate");
		expect(h.calls).toHaveLength(0);
	});

	it("reports a response with no image data", async () => {
		h.setResponder((url) => {
			if (url.includes("/image/models")) return h.images([{ name: "m", output_modalities: ["image"] }]);
			if (url.includes("/text/models")) return h.images([]);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});
		h.api.setToken("sk_x");
		await h.api.loadModels();
		h.elements.get("model")!.value = "m";
		h.elements.get("prompt")!.value = "a fox";
		await h.api.generate("generate");
		expect(h.posted.some((m) => m.type === "place-image")).toBe(false);
		expect(String(h.elements.get("status")!.textContent)).toContain("no image");
	});

	it("returns the model's text and posts it for placement", async () => {
		h.setResponder((url) =>
			url.includes("/text/models")
				? h.images([{ name: "t/text" }])
				: url.includes("/image/models")
					? h.images([])
					: new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }),
		);
		h.api.setToken("sk_x");
		await h.api.loadModels();
		h.elements.get("textModel")!.value = "t/text";
		h.elements.get("prompt")!.value = "say hello";
		await h.api.generateText();
		expect(h.elements.get("output")!.value).toBe("hello");
		expect(h.posted.some((m) => m.type === "place-text")).toBe(true);
	});
});
