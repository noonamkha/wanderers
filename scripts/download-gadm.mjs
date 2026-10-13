// Downloads the original GADM 4.1 GeoJSON files (zipped, unchanged) for levels 0-3 of every country
// into public/gadm/, which the app loads on demand. Skips files that are already there.
// Run: npm run gadm
import fs from 'node:fs';

const GADM = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json';
const index = JSON.parse(fs.readFileSync(new URL('../src/gadm-index.json', import.meta.url)));
const outDir = new URL('../public/gadm/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

const files = index.flatMap((c) => Array.from({ length: c.levels }, (_, level) => `gadm41_${c.code}_${level}.json.zip`));
const missing = files.filter((f) => !fs.existsSync(new URL(f, outDir)));
console.log(`${files.length} files, ${missing.length} to download`);

// A few downloads at a time
const queue = [...missing];
async function worker() {
    for (let file; (file = queue.shift());) {
        const res = await fetch(`${GADM}/${file}`);
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        fs.writeFileSync(new URL(file, outDir), new Uint8Array(await res.arrayBuffer()));
        console.log(file);
    }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log('Done');
