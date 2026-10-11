// Reproducible, dependency-free runtime parser for installed native plugins.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const license = await readFile(`${root}node_modules/yaml/LICENSE`, "utf8");
await build({
  stdin: { contents: 'export { parseDocument } from "yaml";', resolveDir: root },
  outfile: `${root}lib/command-yaml.generated.mjs`, bundle: true, platform: "browser",
  format: "esm", minify: true, legalComments: "inline",
  banner: { js: `/* Generated from yaml@2.9.1 with esbuild@0.28.2.\n${license}*/` },
});
