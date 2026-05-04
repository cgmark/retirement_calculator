import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(process.cwd());
const sourceHtml = resolve(root, "retirement.html");
const outputHtml = resolve(root, "dist/retirement.single.html");
const tempBundle = resolve(root, "dist/.bundle.js");

await mkdir(dirname(outputHtml), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: tempBundle,
  minify: false,
  sourcemap: false,
});

const html = await readFile(sourceHtml, "utf8");
const bundleJs = await readFile(tempBundle, "utf8");
const moduleTag = '<script type="module" src="./src/main.js"></script>';
if (!html.includes(moduleTag)) {
  throw new Error("Expected module script tag not found in retirement.html");
}
const singleHtml = html.replace(moduleTag, `<script>\n${bundleJs}\n</script>`);
await writeFile(outputHtml, singleHtml, "utf8");

console.log(`Wrote ${outputHtml}`);
