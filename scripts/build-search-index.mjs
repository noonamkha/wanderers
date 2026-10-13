// Builds public/gadm/search-index.json from the downloaded GADM files: the names of every level 1 and
// level 2 area (no borders), so the app can search all locations without downloading every country.
// Format: { [countryCode]: [[gid1, name1, [[gid2, name2], ...]], ...] }
// Run: npm run gadm (after the download), or node scripts/build-search-index.mjs
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const index = JSON.parse(fs.readFileSync(new URL('../src/gadm-index.json', import.meta.url)));
const dir = new URL('../public/gadm/', import.meta.url);

// Same as prettyName() in src/gadm.js: GADM's JSON files drop the spaces from names
const prettyName = (name) => name.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2');

function readLevel(code, level) {
    const zip = fs.readFileSync(new URL(`gadm41_${code}_${level}.json.zip`, dir));
    const [file] = Object.values(unzipSync(new Uint8Array(zip)));
    return JSON.parse(strFromU8(file)).features.map((f) => f.properties);
}

const out = {};
let areas = 0;
for (const country of index) {
    if (country.levels < 2) continue;
    const level1 = new Map();
    for (const p of readLevel(country.code, 1)) level1.set(p.GID_1, [p.GID_1, prettyName(p.NAME_1), []]);
    if (country.levels > 2) {
        for (const p of readLevel(country.code, 2)) {
            level1.get(p.GID_1)?.[2].push([p.GID_2, prettyName(p.NAME_2)]);
        }
    }
    out[country.code] = [...level1.values()];
    areas += level1.size + [...level1.values()].reduce((n, [, , kids]) => n + kids.length, 0);
}

fs.writeFileSync(new URL('search-index.json', dir), JSON.stringify(out));
console.log(`Search index: ${areas} areas in ${Object.keys(out).length} countries`);
