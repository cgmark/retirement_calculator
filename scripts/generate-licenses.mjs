import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const outFile = resolve(root, "THIRD_PARTY_LICENSES.txt");

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectDeps(node, acc) {
  if (!node || !node.dependencies) return;
  for (const [name, info] of Object.entries(node.dependencies)) {
    if (!info || !info.version) continue;
    const key = `${name}@${info.version}`;
    if (!acc.has(key)) acc.set(key, { name, version: info.version });
    collectDeps(info, acc);
  }
}

const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

const tree = JSON.parse(raw);
const deps = new Map();
collectDeps(tree, deps);

const lines = [];
lines.push("Third-Party Licenses");
lines.push("Generated from production dependencies\n");

const rows = Array.from(deps.values()).sort((a, b) => a.name.localeCompare(b.name));
for (const dep of rows) {
  const pkgPath = resolve(root, "node_modules", dep.name, "package.json");
  let license = "UNKNOWN";
  let homepage = "";
  try {
    const pkg = parseJson(pkgPath);
    license = pkg.license || (Array.isArray(pkg.licenses) ? pkg.licenses.map(l => l.type).join(", ") : "UNKNOWN");
    homepage = pkg.homepage || (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) || "";
  } catch {
    // keep fallback values
  }

  lines.push(`${dep.name}@${dep.version}`);
  lines.push(`  License: ${license}`);
  if (homepage) lines.push(`  Source: ${homepage}`);
  lines.push("");
}

writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`Wrote ${outFile}`);
