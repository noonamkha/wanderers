import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import { yellow, grey, green } from '@ant-design/colors';
import {
    Button,
    Flex,
    Input,
    Select,
    Switch,
    Typography,
    message,
    Space,
    ConfigProvider,
    theme,
    Card,
    Checkbox,
    Breadcrumb,
    Cascader,
    Popover,
} from 'antd';
import {
    CloseOutlined,
    AimOutlined,
    CompassOutlined,
    EnvironmentOutlined,
    ClockCircleOutlined,
    UserOutlined,
    MoonFilled,
    SunFilled,
    MoonOutlined,
    SunOutlined,
    PushpinOutlined,
    PushpinFilled,
    EyeTwoTone,
    EyeInvisibleTwoTone
} from '@ant-design/icons';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import logo from './assets/nu-tetris.svg';
import { COUNTRIES, CONTINENTS, prettyName, loadLevel, areaFeature, isInFeature, randomPointIn, countryAt, loadSearchIndex } from './gadm';
import NuTetris from "./assets/nu-tetris.svg?raw"
// Set in .env.local (not committed): VITE_GOOGLE_MAPS_API_KEY=...
// It still ends up in the built JS, so restrict the key in Google Cloud Console
const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const ModeThemeContext = createContext(null);
// Start from the URL if it has coordinates, either ?lat=..&lng=..
// or a pair pasted from Google Maps, e.g. ?21.93208214656689, 105.28151727425242
function startFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    if (!isNaN(lat) && !isNaN(lng)) return parseCoords(`${lat},${lng}`);
    return parseCoords(decodeURIComponent(window.location.search));
}

// First "lat, lng" pair in some text, e.g. "21.93208214656689, 105.28151727425242", or null
function parseCoords(text) {
    const match = text.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const [lat, lng] = [parseFloat(match[1]), parseFloat(match[2])];
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// Nearest panorama within a radius, from any source (Google or user uploads), no preference.
// Throws if there's none. StreetViewService is not billed
async function findPano(location, radius) {
    const { StreetViewService, StreetViewPreference } = await importLibrary('streetView');
    const { data } = await new StreetViewService().getPanorama({
        location,
        radius,
        preference: StreetViewPreference.NEAREST,
    });
    return data;
}

// Closest panorama to an exact spot (typed / pasted coordinates, links): small search first, widen only
// if nothing is found, so a typical hit costs one request
async function findNearestPano(location) {
    for (const radius of [50, 1000]) {
        try {
            return await findPano(location, radius);
        } catch {
            // nothing this close, widen the search
        }
    }
    return findPano(location, 50000);
}

// Random point anywhere on earth
const randomPointOnEarth = () => ({
    lat: Math.asin(2 * Math.random() - 1) * 180 / Math.PI,
    lng: Math.random() * 360 - 180,
});

// Search radius for an area: about a quarter of its size, between 1 and 50 km, so small districts aren't overshot
function searchRadius({ bbox: [west, south, east, north] }) {
    const km = Math.hypot((east - west) * 111 * Math.cos(((south + north) / 2) * Math.PI / 180), (north - south) * 111);
    return Math.min(Math.max((km * 1000) / 4, 1000), 50000);
}

// Keep picking random points until one has Street View nearby (inside one of the chosen areas, if any)
async function findRandomPano(areas) {
    for (let i = 0; i < 50; i++) {
        const area = areas[Math.floor(Math.random() * areas.length)];
        const feature = area ? await areaFeature(area) : null;
        const point = feature ? randomPointIn(feature) : randomPointOnEarth();
        if (!point) continue;
        try {
            const data = await findPano(point, feature ? searchRadius(feature) : 50000); // one request per try
            if (!feature || isInFeature(feature, data.location.latLng.toJSON())) return data;
        } catch {
            // no imagery here, try again
        }
    }
    throw new Error('No panorama found');
}

const formatMonth = (month) =>
    month ? new Date(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Unknown date';

// Google's own imagery (user uploads carry the uploader's name instead)
const isGoogleImagery = (data) => /Google/.test(data.copyright ?? '');

// Month of a history entry: `data.time` is undocumented ([{ pano, <minified name>: Date }]), so find the Date by type
function entryMonth(entry) {
    const date = Object.values(entry).find((v) => v instanceof Date);
    return date && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Distance in metres between two LatLngs (haversine)
function distanceMeters(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat() - a.lat()) * rad;
    const dLng = (b.lng() - a.lng()) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat() * rad) * Math.cos(b.lat() * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// How close Google's imagery must be to the found panorama to count as the same spot
const SAME_SPOT_METERS = 15;

// Capture dates listed at this spot, newest first, one per month: { dates: [{ pano, month }], known }.
// `known` = panoramas Google just returned (pano id -> their data), so they surely exist; the other listed
// ones aren't checked yet (some no longer exist). A user photo's history can miss Google's own (often newer)
// imagery at the same spot, so in that case one extra request fetches it. It's only used if it's really at
// the same spot (within SAME_SPOT_METERS), otherwise the newest date could be on another street
async function panoDates(data) {
    const histories = [data];
    if (!isGoogleImagery(data)) {
        try {
            const { StreetViewService, StreetViewPreference, StreetViewSource } = await importLibrary('streetView');
            const { data: official } = await new StreetViewService().getPanorama({
                location: data.location.latLng,
                radius: 50,
                preference: StreetViewPreference.NEAREST,
                sources: [StreetViewSource.GOOGLE],
            });
            if (distanceMeters(data.location.latLng, official.location.latLng) <= SAME_SPOT_METERS) histories.push(official);
        } catch {
            // no Google imagery right here
        }
    }
    const known = new Map(histories.map((h) => [h.location.pano, h]));
    const byMonth = new Map();
    const add = (pano, month) => {
        if (!pano || !month) return;
        if (!byMonth.has(month) || known.has(pano)) byMonth.set(month, { pano, month }); // prefer known ones
    };
    for (const h of histories) {
        for (const t of h.time ?? []) add(t.pano, entryMonth(t));
        add(h.location.pano, h.imageDate);
    }
    return { dates: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)), known };
}

// The panorama's data if it still exists, else null (one request). Listed ones can be gone: the viewer
// would say "no Street View available"
async function checkPano(pano) {
    const { StreetViewService } = await importLibrary('streetView');
    return new StreetViewService().getPanorama({ pano }).then(({ data }) => data, () => null);
}

// Place name, country and capture date of the current panorama, with a picker when there are several dates
// Light / dark mode toggle
const ThemeSwitch = () => {
    const { modeTheme, setModeTheme } = useContext(ModeThemeContext);
    return (
        <>
            <Button
                shape='circle'
                type="text"
                // size="large"
                icon={modeTheme == "light" ? <SunOutlined /> : <MoonFilled />}
                onClick={(e) => {
                    if (modeTheme == "dark") {
                        localStorage.setItem("modeTheme", "light")
                        setModeTheme("light")
                    }
                    else {
                        localStorage.setItem("modeTheme", "dark")
                        setModeTheme("dark")
                    }
                }}
            />
        </>
    );
}

// compact: a single row with the country on the left and the date on the right (minimized phone sheet)
// country: from countryAt(), undefined while it's still being looked up
// countryExtra: shown at the right end of the country row
const LocationInfo = ({ data, country, dates, current, onDateChange, compact, countryExtra }) => {
    if (!data) return null;

    const countryName = (
        // One line with "…" when too long (full name in a tooltip); flex lets it shrink next to the date / Map checkbox
        <Typography.Text strong ellipsis={{ tooltip: country?.name }} style={{ flex: 1, minWidth: 0 }}>
            {country && <img src={country.flag} width={20} height={15} alt="" className="flag" />}
            {country === undefined ? '…' : country?.name || 'Unknown country'}
        </Typography.Text>
    );
    const date = dates.length > 1 ? (
        <Select
            size="small"
            value={current.pano}
            onChange={(pano) => onDateChange(dates.find((d) => d.pano === pano).month)}
            options={dates.map((d) => ({ value: d.pano, label: formatMonth(d.month) }))}
            style={{ width: 160 }}
        />
    ) : (
        <Typography.Text type="secondary">{formatMonth(current.month)}</Typography.Text>
    );

    if (compact) {
        return (
            <Flex align="center" justify="space-between" gap={8} className="location-info">
                {countryName}
                {date}
            </Flex>
        );
    }

    return (
        <Flex vertical gap={2} className="location-info">
            <Flex align="center" justify="space-between" gap={8}>
                {countryName}
                {countryExtra}
            </Flex>
            {/* One line, click "more" to expand. key resets the expanded state for each new location */}
            <Space>
                <EnvironmentOutlined />
                <Typography.Paragraph
                    key={data.location.pano}
                    ellipsis={{ rows: 1, expandable: 'collapsible' }}
                    style={{ margin: 0, flex: 1, minWidth: 0 }}
                >
                    {data.location.description ? data.location.description : "Unknown location"}
                </Typography.Paragraph>
            </Space>
            <Space>
                <Typography.Text type="secondary"><UserOutlined /></Typography.Text>
                <Typography.Paragraph
                    key={data.location.pano}
                    type="secondary"
                    ellipsis={{ rows: 1, expandable: 'collapsible' }}
                    style={{ margin: 0, flex: 1, minWidth: 0 }}
                >
                    {data.copyright ? data.copyright.replace("© ", "") : "Unknown user"}
                </Typography.Paragraph>
            </Space>
            <Space>
                <Typography.Text type="secondary"><ClockCircleOutlined /></Typography.Text>
                {date}
            </Space>
        </Flex>
    );
}

// Maps Embed API, Street View mode: free and unlimited, but can't be controlled from code
const EmbedStreetView = ({ apiKey, pano }) => {
    if (!pano) return null;
    const params = new URLSearchParams({ key: apiKey, pano });
    return (
        <iframe
            src={`https://www.google.com/maps/embed/v1/streetview?${params}`}
            className="viewer"
            allowFullScreen
            // Motion sensors for looking around by moving the phone (also stops the permissions policy warning)
            allow="accelerometer; gyroscope; magnetometer"
        />
    );
}

// Zoom of the mini map: ~1,100 km across at the desktop size, enough to see the surrounding region


// Small map showing the current location: Maps Embed API place mode, free and unlimited.
// Changing the position reloads the iframe
const MiniMap = ({ apiKey, position, className, style }) => {
    if (!position) return null;
    const params = new URLSearchParams({ key: apiKey, q: `${position.lat},${position.lng}`, zoom: 8 });
    return <iframe src={`https://www.google.com/maps/embed/v1/place?${params}`} className={className} style={style} />;
}

const CONTINENT_EMOJI = {
    Asia: '🌏',
    Europe: '🏰',
    Africa: '🪇',
    Oceania: '🦘',
    'North America': '🏔️',
    'South America': '💃',
    Antarctica: '🐧',
};

// Display names of level 1 / 2 areas by GADM id, filled in as countries' options are built:
// AREA_NAMES = full ("Châu Đốc, An Giang, Vietnam"), AREA_SHORT_NAMES = own name only ("Châu Đốc")
const AREA_NAMES = new Map();
const AREA_SHORT_NAMES = new Map();

// Level 1 (and level 2) areas of a country for the breadcrumb menus, built from one GADM file:
// the level 2 file also has each area's level 1 parent (GID_1, NAME_1)
// Built once per country (the tree's cascader and the breadcrumb share it)
const subAreaOptionsCache = new Map();
function subAreaOptions(country) {
    if (!subAreaOptionsCache.has(country.code)) {
        subAreaOptionsCache.set(country.code, buildSubAreaOptions(country).catch((e) => {
            subAreaOptionsCache.delete(country.code); // allow a retry
            throw e;
        }));
    }
    return subAreaOptionsCache.get(country.code);
}

async function buildSubAreaOptions(country) {
    const level = Math.min(country.levels - 1, 2);
    const data = await loadLevel(country.code, level);
    const level1 = new Map();
    for (const { properties: p } of data.features) {
        const name1 = prettyName(p.NAME_1);
        if (!level1.has(p.GID_1)) {
            level1.set(p.GID_1, { value: p.GID_1, label: name1, children: level === 2 ? [] : undefined });
            AREA_NAMES.set(p.GID_1, `${name1}, ${country.name}`);
            AREA_SHORT_NAMES.set(p.GID_1, name1);
        }
        if (level === 2) {
            const name2 = prettyName(p.NAME_2);
            level1.get(p.GID_1).children.push({ value: p.GID_2, label: name2 });
            AREA_NAMES.set(p.GID_2, `${name2}, ${name1}, ${country.name}`);
            AREA_SHORT_NAMES.set(p.GID_2, name2);
        }
    }
    const byLabel = (a, b) => a.label.localeCompare(b.label);
    const options = [...level1.values()].sort(byLabel);
    options.forEach((o) => o.children?.sort(byLabel));
    return options;
}

const countryArea = (country) => ({ code: country.code, level: 0, gid: country.code, name: country.name });

// Areas to search for the selection: all countries of a continent (one is picked at random each try),
// a country, or the level 1 / 2 area picked inside it
function selectedAreas(selected, subArea) {
    if (!selected) return [];
    if (selected.startsWith('continent:')) {
        const [, countries] = CONTINENTS.find(([continent]) => `continent:${continent}` === selected);
        return countries.map(countryArea);
    }
    const country = COUNTRIES[selected];
    if (!subArea.length) return [countryArea(country)];
    const gid = subArea.at(-1);
    return [{ code: country.code, level: subArea.length, gid, name: AREA_NAMES.get(gid) }];
}

// For search: lowercase without accents, so "chau doc" finds "Châu Đốc"
const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

// Every searchable location, built once from the search index: { path, names, level, flag, folded }
// path = [continent, country, level 1, level 2] (as long as needed); names = what to show for it.
// Also fills the area name maps, so a picked result shows its name before its country's file has loaded
let searchEntries = null;
async function loadSearchEntries() {
    if (searchEntries) return searchEntries;
    const index = await loadSearchIndex();
    const entries = [];
    for (const [continent, countries] of CONTINENTS) {
        const continentKey = `continent:${continent}`;
        entries.push({ path: [continentKey], names: [`${CONTINENT_EMOJI[continent] ?? '🌐'} ${continent}`], level: 0, name: continent });
        for (const c of countries) {
            entries.push({ path: [continentKey, c.code], names: [c.name], level: 1, flag: c.flag });
            for (const [gid1, name1, children] of index[c.code] ?? []) {
                AREA_NAMES.set(gid1, `${name1}, ${c.name}`);
                AREA_SHORT_NAMES.set(gid1, name1);
                entries.push({ path: [continentKey, c.code, gid1], names: [c.name, name1], level: 2, flag: c.flag });
                for (const [gid2, name2] of children) {
                    AREA_NAMES.set(gid2, `${name2}, ${name1}, ${c.name}`);
                    AREA_SHORT_NAMES.set(gid2, name2);
                    entries.push({ path: [continentKey, c.code, gid1, gid2], names: [c.name, name1, name2], level: 3, flag: c.flag });
                }
            }
        }
    }
    for (const e of entries) e.folded = fold(e.name ?? e.names.at(-1));
    searchEntries = entries;
    return entries;
}

const SEARCH_LIMIT = 100;

// Locations whose own name matches: exact matches first, then names starting with the text, then the rest;
// bigger areas before smaller ones. Returns { results (first SEARCH_LIMIT), total }
function searchLocations(entries, query) {
    const q = fold(query.trim());
    const rank = (e) => (e.folded === q ? 0 : e.folded.startsWith(q) ? 1 : 2);
    const matches = entries.filter((e) => e.folded.includes(q));
    matches.sort((a, b) => rank(a) - rank(b) || a.level - b.level || a.folded.localeCompare(b.folded));
    return { results: matches.slice(0, SEARCH_LIMIT), total: matches.length };
}

// One breadcrumb location: click it to open a cascader (clicking an option picks it and opens the next level;
// it stays open so you can keep adjusting) with a search box that gets focus right away.
// options: the choices at this location's level; prefix: path above them
const AreaMenu = ({ title, options, prefix, value, onPick, onLoad }) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState(searchEntries); // all searchable locations, once loaded
    const [active, setActive] = useState(0); // highlighted search result (arrow keys / Enter)
    const searchRef = useRef(null);
    const resultsRef = useRef(null);

    const handleOpenChange = (next) => {
        setOpen(next);
        if (!next) return;
        // Focus the search box once the popover is shown, so typing works immediately
        setTimeout(() => searchRef.current?.focus(), 50);
        // Search covers all locations: load the names index (once, ~400 KB)
        if (!entries) loadSearchEntries().then(setEntries).catch(console.error);
    };

    // Clicks inside the Street View / map iframes never reach this page, so "click outside" can't see them;
    // focus moving into an iframe blurs the window instead, so close then
    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        window.addEventListener('blur', close);
        return () => window.removeEventListener('blur', close);
    }, [open]);

    // path: relative to this menu's level (cascader) or, with full = true, a complete path (search results)
    const pick = (path, full = false) => {
        setQuery(''); // back to the cascader, showing the new selection
        onPick(full ? path : [...prefix, ...path]);
    };
    // At least 2 letters: a single letter matches nearly all ~50,000 names (slow and not useful)
    const tooShort = query.trim() && fold(query.trim()).length < 2;
    const search = query.trim() && entries && !tooShort ? searchLocations(entries, query) : null;

    // ↑ / ↓ move the highlight through the results (keeping it in view), Enter picks the highlighted one
    function handleSearchKey(e) {
        const count = search?.results.length ?? 0;
        if (!count) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? Math.min(active + 1, count - 1) : Math.max(active - 1, 0);
            setActive(next);
            resultsRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(search.results[Math.min(active, count - 1)].path, true);
        }
    }

    const content = (
        <Flex vertical gap={8} className="area-menu">
            <Input
                ref={searchRef}
                placeholder="Search"
                allowClear
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                }}
                onKeyDown={handleSearchKey}
            />
            {query.trim() && !entries ? (
                <Typography.Text type="secondary">Loading locations…</Typography.Text>
            ) : tooShort ? (
                <Typography.Text type="secondary">Type at least 2 letters</Typography.Text>
            ) : search ? (
                <div className="area-search-results" ref={resultsRef}>
                    {search.results.map((r, i) => (
                        <div
                            key={r.path.join('/')}
                            className={`area-search-result${i === active ? ' active' : ''}`}
                            onClick={() => pick(r.path, true)}
                            onMouseEnter={() => setActive(i)}
                        >
                            {r.flag && <img src={r.flag} width={20} height={15} alt="" className="flag" />}
                            {r.names.join(' › ')}
                        </div>
                    ))}
                    {!search.total && <Typography.Text type="secondary">No matches</Typography.Text>}
                    {search.total > SEARCH_LIMIT && (
                        <Typography.Text type="secondary" className="area-search-more">
                            {search.total - SEARCH_LIMIT} more, type more to narrow down
                        </Typography.Text>
                    )}
                </div>
            ) : (
                <Cascader.Panel
                    options={options}
                    value={value}
                    expandTrigger="click" // clicking an option picks it and opens its children
                    changeOnSelect // any level can be picked
                    onChange={(path) => path?.length && pick(path)}
                    loadData={(selectedOptions) => onLoad(selectedOptions.at(-1).value)}
                />
            )}
        </Flex>
    );

    return (
        <Popover content={content} trigger="click" open={open} onOpenChange={handleOpenChange} placement="bottomLeft" arrow={false}>
            <a>{title}</a>
        </Popover>
    );
}

// The only area picker: the selection as a path, e.g. Asia › Vietnam › An Giang › Châu Đốc ("Anywhere" when
// nothing is picked). Clicking a location opens a cascader of the choices at that level; clicking a choice
// opens the level below (Anywhere: continents › countries › provinces › districts; Vietnam: Asian countries › …).
// × clears the selection
const SelectionBreadcrumb = ({ selected, subArea, onPick }) => {
    const country = COUNTRIES[selected];
    const [loaded, setLoaded] = useState({}); // country code -> its level 1 / 2 options

    const load = (code) => {
        const c = COUNTRIES[code];
        if (!c || c.levels < 2 || loaded[code]) return;
        subAreaOptions(c)
            .then((o) => setLoaded((all) => ({ ...all, [code]: o })))
            .catch(console.error);
    };

    // The selected country's areas, so the breadcrumb can show their names
    useEffect(() => {
        if (!country || country.levels < 2) return;
        subAreaOptions(country)
            .then((o) => setLoaded((all) => ({ ...all, [country.code]: o })))
            .catch(console.error);
    }, [country]);

    const flag = (c) => c.flag && <img src={c.flag} width={20} height={15} alt="" className="flag" />;
    const continentTitle = (name) => `${CONTINENT_EMOJI[name] ?? '🌐'} ${name}`;
    const withNames = (list) => list?.map((o) => ({ ...o, name: o.label, children: withNames(o.children) }));
    const countryOption = (c) => ({
        value: c.code,
        name: c.name,
        label: <>{flag(c)}{c.name}</>,
        isLeaf: c.levels === 1,
        children: withNames(loaded[c.code]),
    });
    const continentOptions = CONTINENTS.map(([name, countries]) => ({
        value: `continent:${name}`,
        name,
        label: continentTitle(name),
        children: countries.map(countryOption),
    }));

    // Current selection as a full path: [continent, country, level 1, level 2]
    const continentKey = country ? `continent:${country.continent}` : selected;
    const fullPath = !selected ? [] : country ? [continentKey, country.code, ...subArea] : [selected];
    const menu = (title, options, prefix) => (
        <AreaMenu title={title} options={options} prefix={prefix} value={fullPath.slice(prefix.length)} onPick={onPick} onLoad={load} />
    );

    const items = [];
    if (!selected) {
        items.push({ title: menu('Anywhere', continentOptions, []) });
    } else {
        const continentName = continentKey.slice('continent:'.length);
        items.push({ title: menu(continentTitle(continentName), continentOptions, []) });
        if (country) {
            const siblings = continentOptions.find((o) => o.value === continentKey).children;
            items.push({ title: menu(<>{flag(country)}{country.name}</>, siblings, [continentKey]) });
            const provinces = withNames(loaded[country.code]);
            if (subArea[0]) {
                const province = provinces?.find((o) => o.value === subArea[0]);
                const name = province?.label ?? AREA_SHORT_NAMES.get(subArea[0]) ?? '…'; // until the file has loaded
                items.push({ title: provinces ? menu(name, provinces, [continentKey, country.code]) : name });
                if (subArea[1]) {
                    const districtName = province?.children?.find((d) => d.value === subArea[1])?.label ?? AREA_SHORT_NAMES.get(subArea[1]) ?? '…';
                    items.push({ title: province ? menu(districtName, province.children, [continentKey, country.code, subArea[0]]) : districtName });
                }
            }
        }
    }

    return (
        <Flex align="center" gap={4} className="selection-breadcrumb">
            <Breadcrumb items={items} style={{ flex: 1, minWidth: 0 }} />
            {selected && <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => onPick([])} title="Clear (anywhere)" />}
        </Flex>
    );
}

// The last area selection, remembered in this browser: { selected, subArea }. Anything that doesn't match
// the current data (e.g. an old country code) falls back to "Anywhere"
function loadSelection() {
    try {
        const { selected, subArea } = JSON.parse(loadSetting('selection'));
        const isContinent = CONTINENTS.some(([continent]) => `continent:${continent}` === selected);
        if (isContinent) return { selected, subArea: [] };
        if (!COUNTRIES[selected]) throw new Error('unknown selection');
        const validPath = Array.isArray(subArea) && subArea.length <= 2 && subArea.every((gid) => typeof gid === 'string' && gid.startsWith(`${selected}.`));
        return { selected, subArea: validPath ? subArea : [] };
    } catch {
        return { selected: null, subArea: [] };
    }
}

const PANEL_MIN_WIDTH = 250; // desktop panel width, px
const SMALLEST_MAP_SIZE = PANEL_MIN_WIDTH - 26; // mini map at the smallest panel (minus card padding and borders)

// Remembered per-browser preferences (storage can be unavailable, e.g. in private windows)
function loadSetting(name) {
    try {
        return localStorage.getItem(name);
    } catch {
        return True;
    }
}

function saveSetting(name, value) {
    try {
        localStorage.setItem(name, value);
    } catch {
        // not remembered, that's fine
    }
}

// True on phone-sized screens (matches the CSS breakpoint). Phones show a smaller, floating mini map
function useIsPhone() {
    const query = '(max-width: 600px)';
    const [isPhone, setIsPhone] = useState(() => window.matchMedia(query).matches);

    useEffect(() => {
        const media = window.matchMedia(query);
        const onChange = () => setIsPhone(media.matches);
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, [])

    return isPhone;
}

const Wanderer = () => {
    const { modeTheme } = useContext(ModeThemeContext);
    const [ready, setReady] = useState(false);
    const [position, setPosition] = useState(null);
    const [panoData, setPanoData] = useState(null);
    const [dates, setDates] = useState([]); // capture dates listed here, newest first
    const [verifiedPanos, setVerifiedPanos] = useState(() => new Map()); // pano id -> data, known to exist (no re-check)
    const [country, setCountry] = useState(); // country of the current panorama, undefined while looking it up
    const showCount = useRef(0);
    const [month, setMonth] = useState(null); // chosen capture date, null = latest
    const [savedSelection] = useState(loadSelection);
    const [selected, setSelected] = useState(savedSelection.selected); // tree key: a continent or a country
    const [subArea, setSubArea] = useState(savedSelection.subArea); // cascader path inside the selected country
    const [showMap, setShowMap] = useState(() => loadSetting('showMap') !== 'false'); // desktop mini map
    // Desktop mini map height in px when pinned (stays that height when the panel is resized), null = square, follows the panel
    // Default (nothing saved yet): pinned at the smallest size; a saved '' means the user unpinned it
    const [pinnedMapSize, setPinnedMapSize] = useState(() => {
        const saved = loadSetting('pinnedMapSize');
        return saved === null ? SMALLEST_MAP_SIZE : Number(saved) || null;
    });
    const mapBoxRef = useRef(null);
    const [panelWidth, setPanelWidth] = useState(() => Number(loadSetting('panelWidth')) || PANEL_MIN_WIDTH); // desktop
    const [loading, setLoading] = useState(false);
    const [coordsInput, setCoordsInput] = useState('');
    const isPhone = useIsPhone();
    // Phone bottom sheet levels, changed by swiping: 0 = minimized (country, date, random button),
    // 1 = normal (everything, including the area breadcrumb)
    const [sheetLevel, setSheetLevel] = useState(1);
    const touchStartY = useRef(null);
    const touchStartTime = useRef(0);
    const minimized = isPhone && sheetLevel === 0;
    const showCountries = !minimized;
    let antdTheme = theme.useToken()
    function handleTouchStart(e) {
        // Swipes inside the country selection are for scrolling, not for the sheet
        touchStartY.current = e.target.closest('.sheet-extra') ? null : e.touches[0].clientY;
        touchStartTime.current = e.timeStamp;
    }

    function handleTouchEnd(e) {
        if (touchStartY.current === null) return;
        const dy = e.changedTouches[0].clientY - touchStartY.current;
        touchStartY.current = null;
        if (Math.abs(dy) < 40) return; // too small to be a swipe

        // A hard swipe (fast flick or long drag) jumps two levels
        const speed = Math.abs(dy) / Math.max(e.timeStamp - touchStartTime.current, 1); // px per ms
        const hard = speed > 1.2 || Math.abs(dy) > 200;
        const step = (hard ? 2 : 1) * (dy < 0 ? 1 : -1); // up = higher level
        setSheetLevel((level) => Math.min(Math.max(level + step, 0), 1));
    }
    const [messageApi, messageContext] = message.useMessage();

    useEffect(() => {
        async function init() {
            setOptions({
                key: API_KEY,
            });
            // Called by Google when the key is rejected
            window.gm_authFailure = () => messageApi.error('Google Maps rejected the API key.');
            setReady(true);
        }
        if (API_KEY) init();
    }, [messageApi])

    // Show a found panorama, at its newest capture date that can be shown. The embed can't report its
    // position, so take it from the lookup
    async function show(data) {
        // Newest date first; only panoramas that weren't just returned get checked (usually none or one request)
        let { dates: list, known } = await panoDates(data).catch((e) => {
            console.error(e);
            return { dates: [{ pano: data.location.pano, month: data.imageDate }], known: new Map([[data.location.pano, data]]) };
        });
        const verified = new Map(known);
        for (const d of [...list]) {
            if (known.has(d.pano)) break;
            const found = await checkPano(d.pano);
            if (found) {
                verified.set(d.pano, found);
                break;
            }
            list = list.filter((x) => x !== d); // gone: drop it and try the next newest
        }
        setVerifiedPanos(verified);
        setDates(list);
        const { lat, lng } = data.location.latLng.toJSON();
        setPosition({ lat, lng });
        setCoordsInput(`${lat}, ${lng}`); // same format as copied from Google Maps
        setPanoData(data);
        setMonth(null); // newest available date
        // Look up the country from the GADM borders; ignore the answer if another location was shown meanwhile
        const count = ++showCount.current;
        setCountry(undefined);
        countryAt({ lat, lng })
            .catch((e) => {
                console.error(e);
                return null;
            })
            .then((c) => {
                if (count !== showCount.current) return;
                setCountry(c);
            });
    }

    const areas = selectedAreas(selected, subArea);

    // The panorama for the chosen date, or the newest available one
    const current = (month && dates.find((d) => d.month === month)) || dates[0];

    // Picking another date: check that its panorama still exists (once), otherwise drop it from the list
    async function handleDateChange(newMonth) {
        const d = dates.find((x) => x.month === newMonth);
        if (!d) return;
        if (!verifiedPanos.has(d.pano)) {
            const found = await checkPano(d.pano);
            if (!found) {
                setDates((list) => list.filter((x) => x !== d));
                messageApi.warning(`${formatMonth(newMonth)} is no longer available here`);
                return;
            }
            setVerifiedPanos((all) => new Map(all).set(d.pano, found));
        }
        setMonth(newMonth);
    }

    // Data of the panorama on screen (place name, author), which can differ from the one the search found
    const currentData = (current && verifiedPanos.get(current.pano)) || panoData;

    useEffect(() => {
        if (!ready) return;
        // Open the coordinates from the URL, or a random place if there are none
        const start = startFromUrl();
        const found = start
            ? findNearestPano(start).then(show)
            : findRandomPano([]).then((data) => show(data));
        found.catch(console.error);
    }, [ready])

    // Remember the area selection across reloads
    useEffect(() => {
        saveSetting('selection', JSON.stringify({ selected, subArea }));
    }, [selected, subArea])

    // After a reload with a remembered sub-area, load the country's area names so the label can show them
    const [, setNamesLoaded] = useState(false);
    useEffect(() => {
        const country = COUNTRIES[savedSelection.selected];
        if (country && savedSelection.subArea.length) {
            subAreaOptions(country).then(() => setNamesLoaded(true)).catch(console.error);
        }
    }, [savedSelection])

    // Keep the URL in sync with the current location
    useEffect(() => {
        if (!position) return;
        // Same format as coordinates copied from Google Maps, e.g. ?10.76540664907444,106.66174253789497
        window.history.replaceState(null, '', `?${position.lat},${position.lng}`);
    }, [position])

    // Desktop: drag the panel's right edge to resize it. Pointer capture keeps the drag going over the iframes
    function handleResizeStart(e) {
        e.preventDefault();
        const handle = e.currentTarget;
        const startX = e.clientX;
        const startWidth = panelWidth;
        let width = startWidth;
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
            const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth - 40);
            width = Math.min(Math.max(startWidth + ev.clientX - startX, PANEL_MIN_WIDTH), max);
            setPanelWidth(width);
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            saveSetting('panelWidth', String(Math.round(width)));
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
    }

    // Pin the mini map at its current height, or unpin it so it's square and follows the panel width again
    function togglePinMap() {
        const size = pinnedMapSize ? null : Math.round(mapBoxRef.current.getBoundingClientRect().height);
        setPinnedMapSize(size);
        saveSetting('pinnedMapSize', size ? String(size) : '');
    }

    function toggleMap(show) {
        setShowMap(show);
        saveSetting('showMap', String(show));
    }

    // Breadcrumb pick: [continent, country, level 1, level 2] (any length; [] = anywhere)
    function handlePickPath(path) {
        setSelected(path[1] ?? path[0] ?? null);
        setSubArea(path.slice(2));
    }

    // The field holds something other than the current location's coordinates (edited or pasted); empty = random
    const typed = coordsInput.trim();
    const goTo = typed !== '' && typed !== (position ? `${position.lat}, ${position.lng}` : '');

    async function handleGoTo() {
        const coords = parseCoords(coordsInput);
        if (!coords) {
            messageApi.warning('Enter coordinates like "21.93208214656689, 105.28151727425242"');
            return;
        }
        setLoading(true);
        try {
            await show(await findNearestPano(coords));
        } catch (e) {
            console.error(e);
            messageApi.error('No Street View found near these coordinates');
        }
        setLoading(false);
    }

    async function handleRandom() {
        setLoading(true);
        try {
            await show(await findRandomPano(areas));
        } catch (e) {
            console.error(e);
            messageApi.error('No Street View found, try again or pick other areas');
        }
        setLoading(false);
    }

    // Space bar = the Random / Go button, unless typing in a field (or a button / link has focus, where Space
    // already clicks it). Keys pressed while the Street View has focus go to Google's iframe, not this page
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
            e.preventDefault();
            if (loading) return;
            if (goTo) handleGoTo();
            else handleRandom();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    if (!API_KEY) return <p>Missing VITE_GOOGLE_MAPS_API_KEY. Add it to .env.local and restart the dev server.</p>;
    if (!ready) return null;
    return (
        <>
            {messageContext}
            <EmbedStreetView apiKey={API_KEY} pano={current?.pano} />
            {/* On phones the mini map floats in the top right, outside the bottom panel */}
            {isPhone && <MiniMap apiKey={API_KEY} position={position} className="minimap minimap-floating" />}
            {/* Card body is a flex column (see .panel-body) so only the country list scrolls */}
            <Card
                className="panel"
                classNames={{ body: 'panel-body' }}
                style={isPhone ? undefined : { width: panelWidth }}
                onTouchStart={isPhone ? handleTouchStart : undefined}
                onTouchEnd={isPhone ? handleTouchEnd : undefined}
                onTouchCancel={() => { touchStartY.current = null; }}
            >
                {/* Desktop: draggable right edge to resize the panel */}
                {!isPhone && <div className="panel-resize" onPointerDown={handleResizeStart} />}
                {/* Phone: drag handle, also tappable */}
                {isPhone && <div className="sheet-handle" onClick={() => setSheetLevel(sheetLevel === 1 ? 0 : 1)} />}
                {/* Logo and theme switch, hidden (sliding) when the phone sheet is minimized */}
                <div className={`sheet-section${minimized ? ' collapsed' : ''}`}>
                    <div className="sheet-section-inner">
                        <Flex align="center" justify="space-between" gap={8}>
                            {/* The logo is black; invert it to white in dark mode */}
                            <img
                                src={logo}
                                alt="NuTetris"
                                className="logo"
                                style={{ filter: modeTheme === 'dark' ? 'invert(1)' : 'none', height: 18 }}
                            />
                            <ThemeSwitch />
                        </Flex>
                    </div>
                </div>
                {/* Both views stay rendered so switching between minimized and normal can slide (see .sheet-section) */}
                <div className={`sheet-section${minimized ? '' : ' collapsed'}`}>
                    <div className="sheet-section-inner">
                        <LocationInfo data={currentData} country={country} dates={dates} current={current} onDateChange={handleDateChange} compact />
                    </div>
                </div>
                <div className={`sheet-section${minimized ? ' collapsed' : ''}`}>
                    <div className="sheet-section-inner">
                        {isPhone ? (
                            <LocationInfo data={currentData} country={country} dates={dates} current={current} onDateChange={handleDateChange} />
                        ) : (
                            // Desktop: mini map as the card's cover image, location info as its content
                            <Card
                                hoverable
                                style={{
                                    boxShadow: antdTheme.token.boxShadow
                                }}
                                styles={{
                                    body: {
                                        padding: 8
                                    }
                                }}
                                size="small"
                                className="location-card"
                                cover={
                                    // Stays mounted and slides open/closed (see .map-reveal), so toggling doesn't reload the map
                                    <div className={`map-reveal${showMap ? '' : ' collapsed'}`}>
                                        <div className="map-reveal-inner" ref={mapBoxRef}>
                                            <MiniMap
                                                apiKey={API_KEY}
                                                position={position}
                                                className="minimap"
                                                // Pinned: fixed height, width still follows the panel (no longer square)
                                                style={pinnedMapSize ? { height: pinnedMapSize, aspectRatio: 'auto' } : undefined}
                                            />
                                        </div>
                                    </div>
                                }
                            >
                                <LocationInfo
                                    data={currentData}
                                    country={country}
                                    dates={dates}
                                    current={current}
                                    onDateChange={handleDateChange}
                                    // Hide the mini map to leave more room for the country list
                                    countryExtra={
                                        <Flex align="center" gap={2}>
                                            <Button
                                                shape='circle'
                                                type="text"
                                                size="small"
                                                icon={pinnedMapSize ? <PushpinFilled /> : <PushpinOutlined />}
                                                onClick={togglePinMap}
                                                disabled={!showMap}
                                                title={pinnedMapSize ? 'Unpin map height' : 'Pin map height'}
                                            />
                                            <Button
                                                shape='circle'
                                                type="text"
                                                size="small"
                                                icon={showMap ? <EyeTwoTone twoToneColor={green.primary} /> : <EyeInvisibleTwoTone />}
                                                onClick={(e) => toggleMap(!showMap)}
                                                // disabled={!showMap}
                                                title={showMap ? 'Hide map' : 'Show map'}
                                            />
                                        </Flex>
                                    }
                                />
                            </Card>
                        )}
                    </div>
                </div>
                {/* Coordinates field + one button: "Go" when the field has other coordinates than the current
                    location, otherwise "Random". The field is hidden in the minimized phone sheet */}
                {/* Field takes the remaining width, the button keeps its own width, so resizing the panel only
                    stretches the field. Minimized phone sheet: no field, the button fills the row */}
                <Flex gap={8}>
                    {!minimized && (
                        <Input
                            value={coordsInput}
                            onChange={(e) => setCoordsInput(e.target.value)}
                            onFocus={(e) => e.target.select()} // so pasting replaces the old coordinates
                            onPressEnter={handleGoTo}
                            placeholder="lat, lng"
                            disabled={loading}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                    )}
                    <Button
                        color={goTo ? "green" : "primary"}
                        variant="solid"
                        icon={goTo ? <AimOutlined /> : <CompassOutlined />}
                        onClick={goTo ? handleGoTo : handleRandom}
                        loading={loading}
                        style={minimized ? { flex: 1 } : { flexShrink: 0, width: 88 }}
                    >
                        {goTo ? 'Go' : 'Rand'}
                    </Button>
                </Flex>
                {/* Area selection; on phones it slides away when the sheet is minimized (see .sheet-extra) */}
                <div className={`sheet-extra${showCountries ? ' open' : ''}`}>
                    <SelectionBreadcrumb selected={selected} subArea={subArea} onPick={handlePickPath} />
                </div>
            </Card>
        </>
    );
}


const App = () => {
    let [modeTheme, setModeTheme] = useState("light")
    useEffect(() => {
        let modeThemeStorage = localStorage.getItem("modeTheme")
        let backupMaps = JSON.parse(localStorage.getItem('backupMaps'))
        if (modeThemeStorage == "dark") {
            localStorage.setItem("modeTheme", "dark")
            setModeTheme("dark")
        }
        else {
            localStorage.setItem("modeTheme", "light")
            setModeTheme("light")
        }
    }, []);
    return (
        <ConfigProvider theme={{
            algorithm: modeTheme == "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
            // token: {
            //     colorPrimary: "#000000"
            // }
        }}>
            <ModeThemeContext.Provider value={{ modeTheme, setModeTheme }}>
                <Wanderer />
            </ModeThemeContext.Provider>
        </ConfigProvider>
    )
}
export default App;
