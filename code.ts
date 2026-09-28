/**
 * Pollinations for Figma — plugin sandbox.
 *
 * The sandbox has no network access and no DOM, so this half only touches the
 * document: it exports the selection for editing and places generated images.
 * All HTTP happens in the UI iframe and arrives over postMessage.
 */

/**
 * The sandbox provides atob and btoa but has no DOM lib, so they are declared
 * here rather than pulling in the whole DOM type set.
 */
declare function atob(data: string): string;
declare function btoa(data: string): string;

/** Storage is available through the plugin API; the token lives here, not in the file. */
const TOKEN_KEY = "pollinations.token";

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

async function loadToken(): Promise<string | null> {
	const stored = await figma.clientStorage.getAsync(TOKEN_KEY);
	return typeof stored === "string" && stored.startsWith("sk_") ? stored : null;
}

/** Replace a node's fill with the generated image, or fill a frame background. */
function applyImage(node: SceneNode, hash: string) {
	const paint: ImagePaint = { type: "IMAGE", scaleMode: "FILL", imageHash: hash };
	if ("fills" in node && Array.isArray(node.fills)) {
		const next = JSON.parse(JSON.stringify(node.fills)) as Paint[];
		node.fills = [...next, paint];
		return;
	}
	if (node.type === "FRAME") {
		const next = JSON.parse(JSON.stringify(node.backgrounds)) as Paint[];
		node.backgrounds = [...next, paint];
	}
}

/**
 * Place a generated image as a filled rectangle over the viewport.
 *
 * The image's dimensions are not available synchronously — an Image is a handle
 * and its bytes may still be downloading — so the node is sized from
 * getSizeAsync().
 */
async function placeImage(hash: string): Promise<string> {
	const node = figma.createRectangle();
	const image = figma.getImageByHash(hash);
	if (!image) throw new Error("The generated image could not be read.");
	const size = await image.getSizeAsync();
	node.resize(Math.max(64, size.width), Math.max(64, size.height));
	node.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: hash }];
	const viewport = figma.viewport.center;
	node.x = Math.round(viewport.x - node.width / 2);
	node.y = Math.round(viewport.y - node.height / 2);
	node.name = "Pollinations";
	figma.currentPage.appendChild(node);
	figma.currentPage.selection = [node];
	figma.viewport.scrollAndZoomIntoView([node]);
	return node.id;
}

const selectedNode = (): SceneNode | null =>
	figma.currentPage.selection.length > 0 ? figma.currentPage.selection[0] : null;

figma.ui.onmessage = async (msg: {
	type: string;
	bytes?: string;
	text?: string;
	token?: string;
}) => {
	try {
		if (msg.type === "ui-ready") {
			figma.ui.postMessage({ type: "token", token: await loadToken() });
			return;
		}

		if (msg.type === "store-token") {
			await figma.clientStorage.setAsync(TOKEN_KEY, msg.token ?? "");
			return;
		}

		if (msg.type === "forget-token") {
			await figma.clientStorage.deleteAsync(TOKEN_KEY);
			return;
		}

		if (msg.type === "read-selection") {
			const node = selectedNode();
			if (!node) {
				figma.ui.postMessage({ type: "selection-bytes", bytes: null });
				return;
			}
			const bytes = await node.exportAsync({
				format: "PNG",
				constraint: { type: "SCALE", value: 2 },
			});
			figma.ui.postMessage({ type: "selection-bytes", bytes: bytesToBase64(bytes) });
			return;
		}

		if (msg.type === "place-image" || msg.type === "place-edit") {
			if (!msg.bytes) throw new Error("No image data arrived.");
			const bytes = base64ToBytes(msg.bytes);
			// createImage takes bytes directly; it is the supported entry point here.
			const image = figma.createImage(bytes);
			const target = msg.type === "place-edit" ? selectedNode() : null;
			if (target) {
				applyImage(target, image.hash);
				figma.currentPage.selection = [target];
				figma.notify("Pollinations: image applied to the selection.");
			} else {
				await placeImage(image.hash);
				figma.notify("Pollinations: image placed on the canvas.");
			}
			return;
		}

		if (msg.type === "place-text") {
			if (!msg.text) return;
			const font = { family: "Inter", style: "Regular" };
			await figma.loadFontAsync(font);
			const text = figma.createText();
			text.fontName = font;
			text.characters = msg.text;
			const viewport = figma.viewport.center;
			text.x = Math.round(viewport.x);
			text.y = Math.round(viewport.y);
			figma.currentPage.appendChild(text);
			figma.currentPage.selection = [text];
			figma.viewport.scrollAndZoomIntoView([text]);
			return;
		}
	} catch (error) {
		figma.ui.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : "Something went wrong.",
		});
	}
};

figma.showUI(__html__, { width: 380, height: 560 });
