/**
 * Build the Figma plug-in.
 *
 *  1. code.ts -> code.js   (the sandbox half)
 *  2. src/ui.js is inlined into ui.html at the placeholder, producing
 *     ui.built.html, which is what the manifest ships as the UI.
 *
 * Figma loads a single HTML file for the UI, so the script has to end up inside
 * it. Keeping the source in src/ui.js means it can be linted and tested as a
 * normal module rather than a string.
 *
 * The compile uses tsconfig.build.json: passing --outDir on the command line
 * replaces the tsconfig's include, which would drop @figma/plugin-typings and
 * leave the `figma` global undefined.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLACEHOLDER = "/*__POLLINATIONS_UI_SCRIPT__*/";

// 1. Sandbox half.
try {
	execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit", shell: true });
	writeFileSync("code.js", readFileSync(join(".build", "code.js"), "utf8"));
} finally {
	rmSync(".build", { recursive: true, force: true });
}

// 2. Inline the UI script.
const html = readFileSync("ui.html", "utf8");
if (!html.includes(PLACEHOLDER)) {
	throw new Error(`ui.html is missing the ${PLACEHOLDER} placeholder`);
}
writeFileSync(
	"ui.built.html",
	html.replace(PLACEHOLDER, readFileSync(join("src", "ui.js"), "utf8")),
);

console.log("built code.js and ui.built.html");
