/**
 * Pollinations for Figma — UI iframe script.
 *
 * Every network call lives here: the plugin sandbox has no fetch, so requests
 * must run in this iframe and be relayed over postMessage. The iframe runs on a
 * null-ish origin, which is why the manifest lists the two Pollinations hosts
 * under networkAccess.allowedDomains.
 */

const ENTER = "https://enter.pollinations.ai";
const GEN = "https://gen.pollinations.ai";
const TOKEN_KEY = "pollinations.token";

const el = (id) => document.getElementById(id);
const post = (pluginMessage) => parent.postMessage({ pluginMessage }, "*");

let token = null;
let imageModels = [];
let textModels = [];

function message(text, kind) {
	el("status").textContent = text;
	el("status").dataset.kind = kind || "";
}

async function call(url, options) {
	const response = await fetch(url, options);
	if (response.status >= 400) {
		// Never surface the body: it can echo the bearer credential.
		if (response.status === 401) throw new Error("Authorization expired. Connect again.");
		if (response.status === 402) throw new Error("Insufficient Pollen or budget for this account.");
		if (response.status === 403) throw new Error("Access denied. Check model permissions.");
		if (response.status === 429) throw new Error("Rate limit reached. Wait and try again.");
		throw new Error(`Pollinations returned HTTP ${response.status}.`);
	}
	return response.json();
}

async function beginDeviceFlow() {
	const appKey = el("appKey").value.trim();
	const body = appKey ? { client_id: appKey } : {};
	const code = await call(`${ENTER}/api/device/code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!code.device_code || !code.user_code) throw new Error("Invalid authorization response.");
	message(`Approve code ${code.user_code} in the browser, then keep this open.`);
	window.open(code.verification_uri_complete || code.verification_uri, "_blank");

	const deadline = Date.now() + Number(code.expires_in || 600) * 1000;
	let interval = Math.max(5, Number(code.interval || 5));
	while (Date.now() < deadline) {
		await wait(interval * 1000);
		const result = await call(`${ENTER}/api/device/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_code: code.device_code }),
		});
		if (result.access_token && result.access_token.startsWith("sk_")) return result.access_token;
		if (result.error === "slow_down") interval += 5;
		else if (result.error === "access_denied") throw new Error("Authorization declined.");
		else if (result.error === "expired_token") break;
		else if (result.error !== "authorization_pending") throw new Error("Authorization failed.");
	}
	throw new Error("Authorization code expired. Connect again.");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
	try {
		el("connect").disabled = true;
		const granted = await beginDeviceFlow();
		token = granted;
		saveToken(granted);
		message("Connected.");
		await loadModels();
	} catch (error) {
		message(error.message, "error");
	} finally {
		el("connect").disabled = false;
	}
}

function saveToken(value) {
	try {
		localStorage.setItem(TOKEN_KEY, value || "");
	} catch {
		// Storage can be unavailable in the iframe; the sandbox copy still works.
	}
}

async function loadModels() {
	if (!token) return;
	try {
		const images = await call(`${GEN}/image/models`, { headers: auth() });
		imageModels = (images || []).filter(
			(model) =>
				model.name &&
				(model.output_modalities || []).includes("image") &&
				!(model.output_modalities || []).includes("video"),
		);
		const picker = el("model");
		picker.innerHTML = "";
		for (const model of imageModels) {
			const option = document.createElement("option");
			option.value = model.name;
			option.textContent = model.name;
			picker.appendChild(option);
		}

		const texts = await call(`${GEN}/text/models`, { headers: auth() });
		textModels = (texts || []).map((model) => model.name).filter(Boolean);
		const textPicker = el("textModel");
		textPicker.innerHTML = "";
		for (const name of textModels) {
			const option = document.createElement("option");
			option.value = name;
			option.textContent = name;
			textPicker.appendChild(option);
		}
	} catch (error) {
		message(error.message, "error");
	}
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function generate(mode) {
	const prompt = el("prompt").value.trim();
	if (!prompt) return message("Enter a prompt.", "error");
	if (!token) return message("Connect your account first.", "error");
	const model = imageModels.find((entry) => entry.name === el("model").value);
	if (!model) return message("Choose a model.", "error");

	// Editing needs the selection's bytes, which only the sandbox can export.
	let source = null;
	if (mode === "edit") {
		message("Reading the selection…");
		source = await requestSelectionBytes();
		if (!source) return message("Select an image, shape or frame first.", "error");
	}

	message("Generating… this can take a while.");
	try {
		const payload = { model: model.name, prompt, response_format: "b64_json" };
		let route = "/v1/images/generations";
		if (source) {
			payload.image = `data:image/png;base64,${source}`;
			route = "/v1/images/edits";
		}
		const result = await call(`${GEN}${route}`, {
			method: "POST",
			headers: { ...auth(), "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const encoded = result?.data?.[0]?.b64_json;
		if (!encoded) throw new Error("Generation returned no image.");
		post({ type: mode === "edit" ? "place-edit" : "place-image", bytes: encoded });
		message("Placed on the canvas.");
	} catch (error) {
		message(error.message, "error");
	}
}

/** Ask the sandbox to export the current selection as base64 PNG. */
function requestSelectionBytes() {
	return new Promise((resolve) => {
		const handler = (event) => {
			const msg = event.data.pluginMessage;
			if (!msg || msg.type !== "selection-bytes") return;
			window.removeEventListener("message", handler);
			resolve(msg.bytes);
		};
		window.addEventListener("message", handler);
		post({ type: "read-selection" });
	});
}

async function generateText() {
	const prompt = el("prompt").value.trim();
	if (!prompt) return message("Enter a prompt.", "error");
	if (!token) return message("Connect your account first.", "error");
	message("Generating text…");
	try {
		const result = await call(`${GEN}/v1/chat/completions`, {
			method: "POST",
			headers: { ...auth(), "Content-Type": "application/json" },
			body: JSON.stringify({
				model: el("textModel").value,
				messages: [{ role: "user", content: prompt }],
			}),
		});
		const text = result?.choices?.[0]?.message?.content;
		if (!text) throw new Error("The model returned no text.");
		el("output").value = text;
		post({ type: "place-text", text });
		message("Text placed on the canvas.");
	} catch (error) {
		message(error.message, "error");
	}
}

/** Messages from the sandbox: the stored token, or an error to show. */
function handleMessage(event) {
	const msg = event.data.pluginMessage;
	if (!msg) return;
	if (msg.type === "token") {
		token = msg.token || null;
		saveToken(token);
		if (token) {
			message("Connected.");
			void loadModels();
		} else {
			message("Not connected.");
		}
	}
	if (msg.type === "error") message(msg.message, "error");
}

function start() {
	el("connect").addEventListener("click", connect);
	el("disconnect").addEventListener("click", () => {
		token = null;
		saveToken("");
		post({ type: "forget-token" });
		message("Disconnected on this device.");
	});
	el("generate").addEventListener("click", () => void generate("generate"));
	el("edit").addEventListener("click", () => void generate("edit"));
	el("text").addEventListener("click", () => void generateText());

	window.onmessage = handleMessage;

	// The sandbox answers ui-ready with the token it holds.
	post({ type: "ui-ready" });
}

start();
