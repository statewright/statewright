import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2];

if (!['starter', 'gold'].includes(version)) {
  console.error('Usage: npm run reset | npm run gold');
  process.exit(1);
}

const sourceRoot = join(root, 'versions', version);

async function copyOverlay(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyOverlay(source, target);
    } else {
      await cp(source, target);
    }
  }
}

await copyOverlay(sourceRoot, root);
console.log(`Applied ${version} version.`);
