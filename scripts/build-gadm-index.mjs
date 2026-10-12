// Builds src/gadm-index.json: one entry per GADM country with its name, how many levels we use (max 3: 0-2),
// the bounding box of its level-0 border, and continent / ISO2 code (for the flag) from Natural Earth.
// Run occasionally: node scripts/build-gadm-index.mjs
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import bbox from '@turf/bbox';

const GADM = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json';
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const MAX_LEVELS = 3;

// Country list from GADM's download page: <option value="VNM_Vietnam_4"> = code, name, number of levels
const page = await (await fetch('https://gadm.org/download_country.html')).text();
const countries = [...page.matchAll(/option value="([A-Z]{3})_(.+?)_(\d+)"/g)]
    .map(([, code, name, levels]) => ({ code, name, levels: Math.min(Number(levels), MAX_LEVELS) }));

// Continent and ISO2 by ISO3 code
const ne = await (await fetch(NATURAL_EARTH)).json();
const meta = {};
for (const f of ne.features) {
    const p = f.properties;
    for (const iso3 of [p.ISO_A3, p.ISO_A3_EH, p.ADM0_A3]) {
        if (/^[A-Z]{3}$/.test(iso3)) meta[iso3] ??= { continent: p.CONTINENT, iso2: /^[A-Z]{2}$/.test(p.ISO_A2_EH) ? p.ISO_A2_EH : null };
    }
}

// Territories Natural Earth doesn't list separately: [continent, ISO2 or null]
const MANUAL = {
    XAD: ['Europe', null], BES: ['North America', 'BQ'], BVT: ['Antarctica', 'BV'], IOT: ['Asia', 'IO'],
    CXR: ['Asia', 'CX'], XCL: ['North America', null], CCK: ['Asia', 'CC'], GUF: ['South America', 'GF'],
    ATF: ['Antarctica', 'TF'], GIB: ['Europe', 'GI'], GLP: ['North America', 'GP'], HMD: ['Antarctica', 'HM'],
    XKO: ['Europe', 'XK'], MDV: ['Asia', 'MV'], MTQ: ['North America', 'MQ'], MUS: ['Africa', 'MU'],
    MYT: ['Africa', 'YT'], ZNC: ['Asia', null], XPI: ['Asia', null], REU: ['Africa', 'RE'], SHN: ['Africa', 'SH'],
    SYC: ['Africa', 'SC'], SGS: ['Antarctica', 'GS'], XSP: ['Asia', null], SJM: ['Europe', 'SJ'],
    TKL: ['Oceania', 'TK'], UMI: ['Oceania', 'UM'],
};
for (const [iso3, [continent, iso2]] of Object.entries(MANUAL)) meta[iso3] = { continent, iso2 };

const index = [];
for (const c of countries) {
    const zip = new Uint8Array(await (await fetch(`${GADM}/gadm41_${c.code}_0.json.zip`)).arrayBuffer());
    const [file] = Object.values(unzipSync(zip));
    const box = bbox(JSON.parse(strFromU8(file))).map((v) => Math.round(v * 1e4) / 1e4);
    const m = meta[c.code];
    index.push({
        ...c,
        continent: m && m.continent !== 'Seven seas (open ocean)' ? m.continent : 'Other',
        iso2: m?.iso2 ?? null,
        box, // [west, south, east, north]
    });
    console.log(c.code, c.name, c.levels);
}

fs.writeFileSync(new URL('../src/gadm-index.json', import.meta.url), JSON.stringify(index));
console.log(`Wrote ${index.length} countries`);
