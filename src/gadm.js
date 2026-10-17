// GADM 4.1 boundaries (original files, zipped, in public/gadm/ via `npm run gadm`), loaded on demand.
// Levels used: 0 = country, 1 = e.g. province/state, 2 = e.g. district/county.
// GADM licence: non-commercial use only, no redistribution without permission.
import { unzipSync, strFromU8 } from 'fflate';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import index from './gadm-index.json'; // built by scripts/build-gadm-index.mjs

const CONTINENT_ORDER = ['Asia', 'Europe', 'Africa', 'North America', 'South America', 'Oceania', 'Antarctica', 'Other'];

// "VN" -> "🇻🇳" (two regional indicator letters). Drawn with the bundled Noto Color Emoji font (index.css), so
// flags show on Windows too, which has no flag emoji of its own
export const flagEmoji = (iso2) =>
    String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));

// code -> { code, name, levels, continent, iso2, flag, box: [west, south, east, north] }
export const COUNTRIES = Object.fromEntries(
    index.map((c) => [c.code, { ...c, flag: c.iso2 ? flagEmoji(c.iso2) : null }])
);

// [[continent, [country, ...]], ...] in a fixed continent order, countries by name
export const CONTINENTS = CONTINENT_ORDER
    .map((continent) => [continent, Object.values(COUNTRIES)
        .filter((c) => c.continent === continent)
        .sort((a, b) => a.name.localeCompare(b.name))])
    .filter(([, countries]) => countries.length);

// GADM's JSON files drop the spaces from names ("AnGiang", "Quận1"); add them back for display only
export const prettyName = (name) => name.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2');

// Downloaded files, cached as promises so each is fetched and unzipped once
const files = new Map();

export function loadLevel(code, level) {
    const key = `${code}_${level}`;
    if (!files.has(key)) {
        const promise = fetch(`${import.meta.env.BASE_URL}gadm/gadm41_${key}.json.zip`)
            .then((res) => {
                if (!res.ok) throw new Error(`GADM ${key}: HTTP ${res.status}`);
                return res.arrayBuffer();
            })
            .then((buffer) => {
                const [file] = Object.values(unzipSync(new Uint8Array(buffer)));
                return JSON.parse(strFromU8(file));
            })
            .catch((e) => {
                files.delete(key); // allow a retry
                throw e;
            });
        files.set(key, promise);
    }
    return files.get(key);
}

// An area is { code, level, gid } (gid = GADM id, e.g. "VNM.1_1"; for a country it's the country code)
export async function areaFeature({ code, level, gid }) {
    const data = await loadLevel(code, level);
    const feature = level === 0 ? data.features[0] : data.features.find((f) => f.properties[`GID_${level}`] === gid);
    if (!feature) throw new Error(`GADM area ${gid} not found`);
    feature.bbox ??= bbox(feature);
    return feature;
}

export const isInFeature = (feature, { lat, lng }) => booleanPointInPolygon([lng, lat], feature);

// Random point inside the area's real border
export function randomPointIn(feature) {
    const [west, south, east, north] = feature.bbox;
    for (let i = 0; i < 300; i++) {
        const point = {
            lat: south + Math.random() * (north - south),
            lng: west + Math.random() * (east - west),
        };
        if (isInFeature(feature, point)) return point;
    }
    return null;
}

// Country containing a point: check countries whose bounding box contains it, smallest first
export async function countryAt({ lat, lng }) {
    const candidates = Object.values(COUNTRIES)
        .filter(({ box: [w, s, e, n] }) => lat >= s && lat <= n && lng >= w && lng <= e)
        .sort((a, b) => boxArea(a.box) - boxArea(b.box));
    for (const country of candidates) {
        const feature = await areaFeature({ code: country.code, level: 0, gid: country.code });
        if (isInFeature(feature, { lat, lng })) return country;
    }
    return null;
}

const boxArea = ([w, s, e, n]) => (e - w) * (n - s);

// Names of every level 1 / 2 area, for searching all locations (no borders):
// { [countryCode]: [[gid1, name1, [[gid2, name2], ...]], ...] }, built by scripts/build-search-index.mjs
let searchIndex = null;
export function loadSearchIndex() {
    searchIndex ??= fetch(`${import.meta.env.BASE_URL}gadm/search-index.json`)
        .then((res) => {
            if (!res.ok) throw new Error(`Search index: HTTP ${res.status}`);
            return res.json();
        })
        .catch((e) => {
            searchIndex = null; // allow a retry
            throw e;
        });
    return searchIndex;
}
