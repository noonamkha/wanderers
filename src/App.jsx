import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useDeferredValue, createContext, useContext } from 'react';
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
    Drawer,
} from 'antd';
import {
    LoadingOutlined,
    CloseOutlined,
    LeftOutlined,
    RightOutlined,
    CheckOutlined,
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
import { COUNTRIES, CONTINENTS, areaFeature, isInFeature, randomPointIn, countryAt, loadSearchIndex } from './gadm';
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
// While the theme switches, fade every color on the page (.theme-fade in index.css) instead of only the
// components that happen to have their own transition. Only for a moment, so hovers stay snappy afterwards
let themeFadeTimer;
function fadeThemeChange() {
    const root = document.documentElement;
    root.classList.add('theme-fade');
    clearTimeout(themeFadeTimer);
    themeFadeTimer = setTimeout(() => root.classList.remove('theme-fade'), 500);
}

const ThemeSwitch = () => {
    const { modeTheme, setModeTheme } = useContext(ModeThemeContext);
    return (
        <>
            <Button
                shape='circle'
                type="text"
                size="large"
                className="theme-button"
                icon={modeTheme == "light" ? <SunOutlined /> : <MoonFilled />}
                onClick={(e) => {
                    fadeThemeChange();
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

// The country's flag, or a spinner while a new location / its country is being looked up
const CountryFlag = ({ country, busy }) => busy
    ? <LoadingOutlined spin className="flag flag-loading" />
    : country?.flag ? <img src={country.flag} width={20} height={15} alt="" className="flag" /> : null;

// busy: a new location / its country is being looked up (the flag shows a spinner)
// compact: a single row with the country on the left and the date on the right (minimized phone sheet)
// country: from countryAt(), undefined while it's still being looked up
// countryExtra: shown at the right end of the country row
const LocationInfo = ({ data, country, busy, dates, current, onDateChange, compact, countryExtra }) => {
    if (!data) return null;

    const countryName = (
        // One line with "…" when too long (full name in a tooltip); flex lets it shrink next to the date / Map checkbox
        <Typography.Text strong ellipsis={{ tooltip: country?.name }} style={{ flex: 1, minWidth: 0 }}>
            <CountryFlag country={country} busy={busy} />
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
    // fov: horizontal field of view, 10-100°; the widest (100) instead of the default 90
    const params = new URLSearchParams({ key: apiKey, pano, fov: 100 });
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

const ANYWHERE = '🌍 Anywhere';

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

// A country's areas for the location menus (cascader / phone sheet): level 1, with level 2 and level 3 below,
// as cascader options { value, label, name, children }. Built from the search index (names only, already
// downloaded when a menu opens), so opening menus never downloads border files: those are only needed for
// "Random location" inside an area and for the country lookup. Built once per country
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
    const index = await loadSearchIndex();
    const byLabel = (a, b) => a.label.localeCompare(b.label);
    const option = (value, name, children) => ({ value, label: name, name, children: children?.length ? children.sort(byLabel) : undefined });
    return (index[country.code] ?? []).map(([gid1, name1, districts = []]) => {
        AREA_NAMES.set(gid1, `${name1}, ${country.name}`);
        AREA_SHORT_NAMES.set(gid1, name1);
        return option(gid1, name1, districts.map(([gid2, name2, wards = []]) => {
            AREA_NAMES.set(gid2, `${name2}, ${name1}, ${country.name}`);
            AREA_SHORT_NAMES.set(gid2, name2);
            return option(gid2, name2, wards.map(([gid3, name3]) => {
                AREA_NAMES.set(gid3, `${name3}, ${name2}, ${name1}`);
                AREA_SHORT_NAMES.set(gid3, name3);
                return option(gid3, name3);
            }));
        }));
    }).sort(byLabel);
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

const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// For search: lowercase without accents, so "chau doc" finds "Châu Đốc"
const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

// Every searchable location (continents, countries, levels 1-3: ~195,000), built once from the search index.
// Each entry: { value, label, level, flag, parent, folded }. Kept small (a link to the parent instead of a
// copied path) and sorted once by level, then name, so a search is a single pass with no sorting.
// Also fills the area name maps, so a picked result shows its name before its country's file has loaded
let searchEntries = null;
async function loadSearchEntries() {
    if (searchEntries) return searchEntries;
    const index = await loadSearchIndex();
    const entries = [];
    const add = (entry) => {
        entry.folded = fold(entry.name ?? entry.label);
        entries.push(entry);
        return entry;
    };
    for (const [continent, countries] of CONTINENTS) {
        const continentEntry = add({ value: `continent:${continent}`, label: `${CONTINENT_EMOJI[continent] ?? '🌐'} ${continent}`, name: continent, level: 0, parent: null });
        for (const c of countries) {
            const countryEntry = add({ value: c.code, label: c.name, level: 1, flag: c.flag, parent: continentEntry });
            for (const [gid1, name1, districts = []] of index[c.code] ?? []) {
                AREA_NAMES.set(gid1, `${name1}, ${c.name}`);
                AREA_SHORT_NAMES.set(gid1, name1);
                const e1 = add({ value: gid1, label: name1, level: 2, flag: c.flag, parent: countryEntry });
                for (const [gid2, name2, wards = []] of districts) {
                    AREA_NAMES.set(gid2, `${name2}, ${name1}, ${c.name}`);
                    AREA_SHORT_NAMES.set(gid2, name2);
                    const e2 = add({ value: gid2, label: name2, level: 3, flag: c.flag, parent: e1 });
                    for (const [gid3, name3] of wards) {
                        AREA_NAMES.set(gid3, `${name3}, ${name2}, ${name1}`);
                        AREA_SHORT_NAMES.set(gid3, name3);
                        add({ value: gid3, label: name3, level: 4, flag: c.flag, parent: e2 });
                    }
                }
            }
        }
    }
    entries.sort((a, b) => a.level - b.level || (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
    searchEntries = entries;
    return entries;
}

const SEARCH_LIMIT = 100;

// A search entry's full path ([continent, country, level 1, …]) and the names to show (from the country down;
// a continent shows its own emoji + name)
function entryPath(entry) {
    const path = [];
    for (let e = entry; e; e = e.parent) path.unshift(e.value);
    return path;
}
function entryNames(entry) {
    if (entry.level === 0) return [entry.label];
    const names = [];
    for (let e = entry; e && e.level >= 1; e = e.parent) names.unshift(e.label);
    return names;
}

// Locations whose own name matches: exact matches first, then names starting with the text, then the rest;
// within each, bigger areas before smaller ones, then by name (the entries are pre-sorted that way, so this is
// one pass). Returns { results (first SEARCH_LIMIT, as { path, names, flag }), total }
function searchLocations(entries, query) {
    const q = fold(query.trim());
    const buckets = [[], [], []];
    let total = 0;
    for (const e of entries) {
        if (!e.folded.includes(q)) continue;
        total++;
        const bucket = buckets[e.folded === q ? 0 : e.folded.startsWith(q) ? 1 : 2];
        if (bucket.length < SEARCH_LIMIT) bucket.push(e);
    }
    const results = buckets.flat().slice(0, SEARCH_LIMIT)
        .map((e) => ({ path: entryPath(e), names: entryNames(e), flag: e.flag }));
    return { results, total };
}

// Search over all locations (search index), shared by the desktop menu and the phone sheet.
// onPickResult(fullPath, viaEnter) is called with the chosen result (viaEnter: picked with the Enter key). Returns the search box, the results view
// (null while there's no query) and helpers
function useLocationSearch(onPickResult) {
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState(searchEntries); // all searchable locations, once loaded
    const [active, setActive] = useState(0); // highlighted result (arrow keys / Enter)
    const inputRef = useRef(null);
    const resultsRef = useRef(null);

    // The names index (~400 KB) is loaded the first time a menu opens
    const loadEntries = () => {
        if (!entries) loadSearchEntries().then(setEntries).catch(console.error);
    };
    const pickResult = (path, viaEnter = false) => {
        setQuery('');
        onPickResult(path, viaEnter);
    };

    // At least 2 letters: a single letter matches nearly all ~195,000 names (slow and not useful)
    const tooShort = query.trim() && fold(query.trim()).length < 2;
    // A search over all names takes ~60-190 ms: the box updates right away and the results follow (deferred),
    // and they're kept for the same text, so moving the highlight with ↑ / ↓ doesn't search again
    const deferredQuery = useDeferredValue(query);
    const search = useMemo(() => {
        const q = deferredQuery.trim();
        return q && entries && fold(q).length >= 2 ? searchLocations(entries, q) : null;
    }, [entries, deferredQuery]);

    // ↑ / ↓ move the highlight through the results (keeping it in view), Enter picks the highlighted one
    function handleKey(e) {
        const count = search?.results.length ?? 0;
        if (!count) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? Math.min(active + 1, count - 1) : Math.max(active - 1, 0);
            setActive(next);
            resultsRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            pickResult(search.results[Math.min(active, count - 1)].path, true);
        }
    }

    const searchBox = (
        <Input
            ref={inputRef}
            placeholder="Search"
            allowClear
            value={query}
            onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
            }}
            onKeyDown={handleKey}
        />
    );
    const searchView = !query.trim() ? null : !entries ? (
        <Typography.Text type="secondary">Loading locations…</Typography.Text>
    ) : tooShort ? (
        <Typography.Text type="secondary">Type at least 2 letters</Typography.Text>
    ) : !search ? (
        <Typography.Text type="secondary">Searching…</Typography.Text> // the deferred results haven't caught up yet
    ) : (
        <div className="area-search-results" ref={resultsRef}>
            {search.results.map((r, i) => (
                <div
                    key={r.path.join('/')}
                    className={`area-search-result${i === active ? ' active' : ''}`}
                    onClick={() => pickResult(r.path)}
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
    );

    return { searchBox, searchView, setQuery, loadEntries, focus: () => inputRef.current?.focus() };
}

// Desktop: one breadcrumb location. Click it to open a cascader (clicking an option picks it and opens the
// next level; it stays open so you can keep adjusting) with a search box that gets focus right away.
// options: the choices at this location's level; prefix: path above them
// openSignal: a number that changes when the S key is pressed; the menu with isSearchTarget (the last
// breadcrumb location) then opens with the search focused
const AreaMenu = ({ title, options, prefix, value, onPick, onLoad, openSignal, isSearchTarget }) => {
    const [open, setOpen] = useState(false);
    // A search result picked with Enter is a final choice: close the menu (clicks keep it open for adjusting)
    const { searchBox, searchView, setQuery, loadEntries, focus } = useLocationSearch((path, viaEnter) => {
        onPick(path);
        if (viaEnter) setOpen(false);
    });

    // S key: open (adjusting state during render when the signal changes), then focus the search box
    const [seenSignal, setSeenSignal] = useState(openSignal);
    if (openSignal !== seenSignal) {
        setSeenSignal(openSignal);
        if (isSearchTarget) setOpen(true);
    }
    useEffect(() => {
        if (!openSignal || !isSearchTarget) return;
        loadEntries();
        const timer = setTimeout(focus, 50);
        return () => clearTimeout(timer);
    }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleOpenChange = (next) => {
        setOpen(next);
        if (!next) return;
        setTimeout(focus, 50); // once the popover is shown, so typing works immediately
        loadEntries();
    };

    // Clicks inside the Street View / map iframes never reach this page, so "click outside" can't see them;
    // focus moving into an iframe blurs the window instead, so close then
    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        window.addEventListener('blur', close);
        return () => window.removeEventListener('blur', close);
    }, [open]);

    const pick = (path) => {
        setQuery('');
        onPick([...prefix, ...path]);
    };

    const content = (
        <Flex vertical gap={8} className="area-menu">
            {searchBox}
            {searchView ?? (
                <Cascader.Panel
                    options={options}
                    value={value}
                    expandTrigger="click" // clicking an option picks it and opens its children
                    changeOnSelect // any level can be picked
                    // Clicking the selected option again deselects it (goes up one level)
                    onChange={(path) => path?.length && pick(sameArray(path, value) ? path.slice(0, -1) : path)}
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

// Phone: full-width bottom sheet with the whole hierarchy, one list at a time (continents › countries ›
// provinces › districts). sheet = { open, stack, direction }: stack is the path of the list shown ([] =
// continents); it can open at any level and still go back up to the continents.
// Tap a row to pick it and go into its level, tap the picked row again to deselect it, "All of …" picks the
// level shown. ‹ or swipe right = back up, swipe left = back down into the selection, swipe down = close
// (a hard swipe down also minimizes the panel)
// onMinimize: a hard swipe down closes the sheet and also minimizes the panel (skips a level)
const LocationSheet = ({ sheet, setSheet, options, current, onPick, onLoad, onMinimize }) => {
    const touch = useRef(null); // where the current swipe started
    const close = () => setSheet((s) => ({ ...s, open: false }));
    const { searchBox, searchView, setQuery, loadEntries, focus } = useLocationSearch((path) => {
        onPick(path);
        close(); // a search pick is a final choice
    });

    // Every time it opens: clear the search (during render, when `open` flips) and load the names index
    const [wasOpen, setWasOpen] = useState(false);
    if (sheet.open !== wasOpen) {
        setWasOpen(sheet.open);
        if (sheet.open) setQuery('');
    }
    useEffect(() => {
        if (!sheet.open) return;
        loadEntries();
        // Opened with the S key: focus the search box once the sheet has slid up
        if (sheet.focusSearch) {
            const timer = setTimeout(focus, 300);
            return () => clearTimeout(timer);
        }
    }, [sheet.open]); // eslint-disable-line react-hooks/exhaustive-deps

    const { stack } = sheet;
    const nodes = []; // options along the stack
    let list = options;
    for (const v of stack) {
        const node = list?.find((o) => o.value === v);
        nodes.push(node);
        list = node?.children;
    }
    const here = nodes.at(-1);
    // A country in the stack whose areas aren't loaded yet (e.g. opened straight at its provinces)
    useEffect(() => {
        if (sheet.open && here && !here.children && here.isLeaf === false) onLoad(here.value);
    });

    const allRow = here ? { label: `All of ${here.name}`, path: stack } : { label: ANYWHERE, path: [] };
    const hasChildren = (o) => o.children?.length > 0 || o.isLeaf === false;
    const onSelectedPath = (o) => current[stack.length] === o.value && sameArray(current.slice(0, stack.length), stack);

    const goInto = (value) => setSheet((s) => ({ ...s, stack: [...s.stack, value], direction: 'forward' }));
    const goBack = () => setSheet((s) => (s.stack.length ? { ...s, stack: s.stack.slice(0, -1), direction: 'back' } : s));
    // Into the level of this list's option that's on the current selection (e.g. "Vietnam" list, Hồ Chí Minh
    // selected: its districts). Nothing to do if the selection doesn't go deeper than this list
    const goForward = () => {
        const next = sameArray(current.slice(0, stack.length), stack) ? current[stack.length] : undefined;
        const option = list?.find((o) => o.value === next);
        if (!option || !hasChildren(option)) return;
        goInto(option.value);
        if (!option.children) onLoad(option.value); // a country whose areas aren't loaded yet
    };

    const tapRow = (o) => {
        const path = [...stack, o.value];
        if (sameArray(path, current)) {
            onPick(path.slice(0, -1)); // tapped the picked row again: deselect
            return;
        }
        onPick(path);
        if (hasChildren(o)) {
            goInto(o.value);
            if (!o.children) onLoad(o.value); // a country whose areas aren't loaded yet
        }
    };

    // Swipes: right = back up a level, left = into the selected option's level, down = close.
    // Inside the list, down only counts when the list was
    // scrolled to the top (otherwise it's scrolling). Same 40 px threshold as the panel's swipe
    const swipe = {
        onTouchStart: (e) => {
            const listEl = e.target.closest('.area-drill-list');
            touch.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
                time: e.timeStamp,
                canClose: !listEl || listEl.scrollTop <= 0,
            };
        },
        onTouchEnd: (e) => {
            const start = touch.current;
            touch.current = null;
            if (!start) return;
            const dx = e.changedTouches[0].clientX - start.x;
            const dy = e.changedTouches[0].clientY - start.y;
            if (dx > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) goBack();
            else if (dx < -40 && Math.abs(dx) > Math.abs(dy) * 1.5) goForward();
            else if (dy > 40 && dy > Math.abs(dx) * 1.5 && start.canClose) {
                close();
                // Hard swipe (fast flick or long drag, like the panel's): also minimize the panel
                const speed = dy / Math.max(e.timeStamp - start.time, 1); // px per ms
                if (speed > 1.2 || dy > 200) onMinimize?.();
            }
        },
        onTouchCancel: () => { touch.current = null; },
    };

    const header = (
        <Flex align="center" gap={4} {...swipe}>
            {stack.length > 0 && <Button type="text" icon={<LeftOutlined />} onClick={goBack} />}
            {/* The option's label: continent emoji / country flag + name (provinces and districts: just the name) */}
            <span className="area-drill-title">{here ? here.label : 'Continents'}</span>
        </Flex>
    );

    return (
        <Drawer
            open={sheet.open}
            onClose={close}
            placement="bottom"
            size="75dvh"
            closable={{ placement: 'end' }} // ✕ on the right, away from the ‹ back button
            title={header}
            styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
            <div className="area-drill-body" {...swipe}>
                <div className="area-drill-search">{searchBox}</div>
                {searchView ? <div className="area-drill-list">{searchView}</div> : (
                    // Keyed by level, so each level change mounts a new list and its slide-in animation plays
                    <div key={stack.join('/')} className={`area-drill-list slide-${sheet.direction}`}>
                        <div className="area-drill-row" onClick={() => onPick(allRow.path)}>
                            <span className="area-drill-check">{sameArray(allRow.path, current) && <CheckOutlined />}</span>
                            <b>{allRow.label}</b>
                        </div>
                        {!list && <div className="area-drill-row"><Typography.Text type="secondary">Loading…</Typography.Text></div>}
                        {list?.map((o) => (
                            <div
                                key={o.value}
                                className={`area-drill-row${onSelectedPath(o) ? ' selected' : ''}`}
                                onClick={() => tapRow(o)}
                            >
                                <span className="area-drill-check">{sameArray([...stack, o.value], current) && <CheckOutlined />}</span>
                                <span className="area-drill-label">{o.label}</span>
                                {hasChildren(o) && <RightOutlined className="area-drill-chevron" />}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Drawer>
    );
}

// The only area picker: the selection as a path, e.g. Asia › Vietnam › An Giang › Châu Đốc ("Anywhere" when
// nothing is picked). Clicking a location opens a cascader of the choices at that level; clicking a choice
// opens the level below (Anywhere: continents › countries › provinces › districts; Vietnam: Asian countries › …).
// × clears the selection
// Phone: each location opens the shared LocationSheet at its level instead (sheet / setSheet from Wanderer,
// so a swipe up on the panel can open it too)
// searchSignal: changes when the S key is pressed; the deepest location's menu opens with search focused
const SelectionBreadcrumb = ({ selected, subArea, onPick, isPhone, sheet, setSheet, onMinimize, searchSignal }) => {
    const country = COUNTRIES[selected];
    const [loaded, setLoaded] = useState({}); // country code -> its areas (levels 1-3) as options

    // Load what's below a country being opened (its levels 1-3, all at once, from the search index)
    const load = (value) => {
        const c = COUNTRIES[value];
        if (!c || c.levels < 2 || loaded[value]) return;
        subAreaOptions(c)
            .then((o) => setLoaded((all) => ({ ...all, [value]: o })))
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
    const areaOptions = (code) => loaded[code];
    const countryOption = (c) => ({
        value: c.code,
        name: c.name,
        label: <>{flag(c)}{c.name}</>,
        isLeaf: c.levels === 1,
        children: areaOptions(c.code),
    });
    const continentOptions = CONTINENTS.map(([name, countries]) => ({
        value: `continent:${name}`,
        name,
        label: continentTitle(name),
        children: countries.map(countryOption),
    }));

    // Current selection as a full path: [continent, country, level 1, level 2, level 3]
    const continentKey = country ? `continent:${country.continent}` : selected;
    const fullPath = !selected ? [] : country ? [continentKey, country.code, ...subArea] : [selected];
    // A location: desktop cascader menu, or (phone) a link opening the sheet at that level
    // Level of the last breadcrumb location (prefix length of its menu), which the S key opens
    const lastLevel = !country ? 0 : !subArea[0] ? 1 : !subArea[1] ? 2 : !subArea[2] ? 3 : 4;
    const menu = (title, options, prefix) => isPhone
        ? <a onClick={() => setSheet({ open: true, stack: prefix, direction: 'none' })}>{title}</a>
        : (
            <AreaMenu
                title={title}
                options={options}
                prefix={prefix}
                value={fullPath.slice(prefix.length)}
                onPick={onPick}
                onLoad={load}
                openSignal={searchSignal}
                isSearchTarget={prefix.length === lastLevel}
            />
        );
    const continentsMenu = (title) => menu(title, continentOptions, []);

    const items = [];
    if (!selected) {
        items.push({ title: continentsMenu(ANYWHERE) });
    } else {
        const continentName = continentKey.slice('continent:'.length);
        items.push({ title: continentsMenu(continentTitle(continentName)) });
        if (country) {
            const siblings = continentOptions.find((o) => o.value === continentKey).children;
            items.push({ title: menu(<>{flag(country)}{country.name}</>, siblings, [continentKey]) });
            const provinces = areaOptions(country.code);
            if (subArea[0]) {
                const province = provinces?.find((o) => o.value === subArea[0]);
                const name = province?.label ?? AREA_SHORT_NAMES.get(subArea[0]) ?? '…'; // until the file has loaded
                items.push({ title: provinces ? menu(name, provinces, [continentKey, country.code]) : name });
                if (subArea[1]) {
                    const district = province?.children?.find((d) => d.value === subArea[1]);
                    const districtName = district?.label ?? AREA_SHORT_NAMES.get(subArea[1]) ?? '…';
                    items.push({ title: province ? menu(districtName, province.children, [continentKey, country.code, subArea[0]]) : districtName });
                    if (subArea[2]) {
                        const wardName = district?.children?.find((w) => w.value === subArea[2])?.label ?? AREA_SHORT_NAMES.get(subArea[2]) ?? '…';
                        items.push({ title: district?.children
                            ? menu(wardName, district.children, [continentKey, country.code, subArea[0], subArea[1]])
                            : wardName });
                    }
                }
            }
        }
    }

    return (
        <Flex align="center" gap={4} className="selection-breadcrumb">
            <Breadcrumb items={items} style={{ flex: 1, minWidth: 0 }} />
            {selected && <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => onPick([])} title="Clear (anywhere)" />}
            {isPhone && (
                <LocationSheet
                    sheet={sheet}
                    setSheet={setSheet}
                    options={continentOptions}
                    current={fullPath}
                    onPick={onPick}
                    onLoad={load}
                    onMinimize={onMinimize}
                />
            )}
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
        const validPath = Array.isArray(subArea) && subArea.length <= 3 && subArea.every((gid) => typeof gid === 'string' && gid.startsWith(`${selected}.`));
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
    // Panel collapsed to just the logo + country (toggled by clicking the logo), remembered in this browser
    const [panelCollapsed, setPanelCollapsed] = useState(() => loadSetting('panelCollapsed') === 'true');
    const panelRef = useRef(null);
    const panelBefore = useRef(null); // panel's size right before restoring (for the animation)
    // Collapse animation running: the full content stays (fading out, the logo in place) while the box shrinks
    // to the logo; only at the end does it switch to the collapsed content
    const [collapsing, setCollapsing] = useState(false);
    const collapseAnimation = useRef(null);
    const unpinContent = useRef(null); // undoes pinContentWidth() after the collapse
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
    // 1 = normal (everything, including the area breadcrumb); swiping above 1 opens the location picker sheet
    // (a 3rd level). A hard swipe moves two levels
    const [sheetLevel, setSheetLevel] = useState(1);
    const touchStartY = useRef(null);
    const touchStartTime = useRef(0);
    const minimized = isPhone && sheetLevel === 0;
    // Phone location picker sheet: { open, stack (path of the list shown), direction (slide) }
    const [locationSheet, setLocationSheet] = useState({ open: false, stack: [], direction: 'none' });
    const [searchSignal, setSearchSignal] = useState(0); // desktop: bumped by the S key to open the location search
    const showCountries = !minimized;
    let antdTheme = theme.useToken()
    function handleTouchStart(e) {
        // Not swipes inside the location sheet / menus (they're portals, their touches bubble here too)
        touchStartY.current = e.target.closest('.ant-drawer, .ant-popover') ? null : e.touches[0].clientY;
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
        // Going above the full panel opens the location picker (the 3rd level), at the current selection's
        // level (e.g. Bình Tân selected: Hồ Chí Minh's districts). A hard swipe from minimized gets there at once
        if (sheetLevel + step > 1) {
            setLocationSheet({ open: true, stack: selectionPath().slice(0, -1), direction: 'none' });
        }
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

    // Current selection as a full path: [continent, country, level 1, level 2, level 3] ([] = anywhere)
    function selectionPath() {
        if (!selected) return [];
        return COUNTRIES[selected] ? [`continent:${COUNTRIES[selected].continent}`, selected, ...subArea] : [selected];
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

    // Dragging the Street View (Google's iframe) and releasing the mouse over the panel: the button-up goes to
    // this page, never to the iframe, which then keeps rotating as if the button were still held. So while a
    // drag that started in an iframe is over the panel, let the mouse pass through to the iframe (.iframe-drag
    // in index.css) so it receives the release. A drag "started in an iframe" = the mouse moves here with a
    // button held but the button was never pressed on this page. Renewed every move, dropped 250 ms after
    useEffect(() => {
        let pressedHere = false;
        let timer;
        const root = document.documentElement;
        const onDown = () => { pressedHere = true; };
        const onUp = () => { pressedHere = false; };
        const onMove = (e) => {
            if (e.pointerType !== 'mouse' || !e.buttons || pressedHere) return;
            root.classList.add('iframe-drag');
            clearTimeout(timer);
            timer = setTimeout(() => root.classList.remove('iframe-drag'), 250);
        };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointermove', onMove, true);
        return () => {
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointermove', onMove, true);
            clearTimeout(timer);
            root.classList.remove('iframe-drag');
        };
    }, [])

    // Clicking / dragging the Street View or the map moves keyboard focus into Google's iframe, and key presses
    // (Space) then go there instead of this page. Take focus back right away; the mouse keeps working in the
    // iframe. Trade-off: the viewer's own keyboard controls (arrow keys, + / -) no longer get the keys
    useEffect(() => {
        document.body.tabIndex = -1; // so the page itself can hold focus
        const onBlur = () => setTimeout(() => {
            if (document.activeElement?.tagName === 'IFRAME') document.body.focus({ preventScroll: true });
        }, 0);
        window.addEventListener('blur', onBlur);
        return () => window.removeEventListener('blur', onBlur);
    }, [])

    // While the box animates, keep the content at its full width (the box only clips it), so nothing inside
    // reflows: otherwise the header gets narrower than the logo and the logo shrinks for a moment
    const pinContentWidth = (panel) => {
        const content = panel.querySelector('.panel-body');
        content.style.width = `${content.getBoundingClientRect().width}px`;
        content.style.flexShrink = '0';
        return () => {
            content.style.width = '';
            content.style.flexShrink = '';
        };
    };

    // Collapse: shrink the box from the full panel to the collapsed size (worked out from the logo button, the
    // panel's padding and a line for the country) while everything but the logo fades out (.panel-collapsing).
    // The logo stays put at the top left, so it looks like the panel folds into it. At the end, switch to the
    // collapsed content. On the phone the card also moves 10 px in from the screen's left / bottom edges
    useLayoutEffect(() => {
        if (!collapsing) return;
        const panel = panelRef.current;
        const before = panel.getBoundingClientRect();
        const logoButtonEl = panel.querySelector('.logo-button');
        const logoBox = logoButtonEl.getBoundingClientRect();
        const contentEl = panel.querySelector('.panel-body');
        const body = getComputedStyle(contentEl);
        const px = (value) => parseFloat(value) || 0;
        const borders = panel.offsetWidth - panel.clientWidth;
        // Everything above the logo in the content (the phone's drag handle, which the collapsed card has too)
        const aboveLogo = logoBox.top - contentEl.getBoundingClientRect().top;
        const width = logoBox.width + px(getComputedStyle(logoButtonEl).marginLeft)
            + px(body.paddingLeft) + px(body.paddingRight) + borders;
        const height = aboveLogo + logoBox.height + 2 + (px(body.lineHeight) || 22) + px(body.paddingBottom) + borders;
        const move = isPhone ? 'translate(10px, -10px)' : 'none';
        panel.style.overflow = 'hidden';
        unpinContent.current = pinContentWidth(panel);
        const animation = panel.animate([
            { width: `${before.width}px`, height: `${before.height}px`, transform: 'none' },
            { width: `${width}px`, height: `${height}px`, transform: move },
        ], { duration: 300, easing: 'ease', fill: 'forwards' });
        collapseAnimation.current = animation;
        animation.onfinish = () => {
            setPanelCollapsed(true);
            setCollapsing(false);
            saveSetting('panelCollapsed', 'true');
        };
    }, [collapsing]); // eslint-disable-line react-hooks/exhaustive-deps

    // After the collapse: the collapsed content now has (about) the size the box was shrunk to, drop the
    // animation. Restore: grow the box from the collapsed size to the full panel (before paint, so there's no
    // flash), anchored at the top left (desktop) or bottom left (phone sheet) with a translate for the move
    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        if (collapseAnimation.current) {
            collapseAnimation.current.cancel();
            collapseAnimation.current = null;
            panel.style.overflow = '';
            unpinContent.current?.();
            unpinContent.current = null;
        }
        const before = panelBefore.current;
        panelBefore.current = null;
        if (!before) return;
        const after = panel.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = isPhone ? before.bottom - after.bottom : before.top - after.top;
        panel.style.overflow = 'hidden'; // clip the content while the box grows
        const unpin = pinContentWidth(panel); // the full panel's content width
        const animation = panel.animate([
            { width: `${before.width}px`, height: `${before.height}px`, transform: `translate(${dx}px, ${dy}px)` },
            { width: `${after.width}px`, height: `${after.height}px`, transform: 'none' },
        ], { duration: 300, easing: 'ease' });
        animation.onfinish = animation.oncancel = () => {
            panel.style.overflow = '';
            unpin();
        };
        // Restoring mounts the whole panel, which keeps the browser busy for a moment and would eat most of the
        // animation: hold it at the start until two frames have been drawn, then play it in full
        animation.pause();
        requestAnimationFrame(() => requestAnimationFrame(() => animation.play()));
    }, [panelCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keyboard shortcuts, unless typing in a field (or a button / link has focus, where Space already clicks it):
    // Space = the Random / Go button; S = location search (desktop: the menu of the last breadcrumb location;
    // phone: the location sheet), with the search box focused
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.code !== 'Space' && e.code !== 'KeyS') return;
            if (e.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
            e.preventDefault(); // also keeps the "s" out of the search box that's about to get focus
            if (e.code === 'KeyS') {
                if (isPhone) setLocationSheet({ open: true, stack: selectionPath().slice(0, -1), direction: 'none', focusSearch: true });
                else setSearchSignal((n) => n + 1);
                return;
            }
            if (loading) return;
            if (goTo) handleGoTo();
            else handleRandom();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    // Spinner instead of the flag while searching for a location or looking up its country
    const countryBusy = loading || country === undefined;

    // Collapse: run the fold-into-the-logo animation first (the layout effects above). Restore: remember the
    // collapsed size, switch to the full panel and grow the box from that size
    function togglePanelCollapsed() {
        if (collapsing) return;
        if (!panelCollapsed) {
            setCollapsing(true);
            return;
        }
        panelBefore.current = panelRef.current?.getBoundingClientRect();
        setPanelCollapsed(false);
        saveSetting('panelCollapsed', 'false');
    }

    // The logo is black; invert it to white in dark mode. Clicking it collapses / restores the panel
    const logoButton = (
        <Button
            type="text"
            size="large"
            className="logo-button"
            aria-label={panelCollapsed ? 'Show the panel' : 'Collapse the panel'}
            title={panelCollapsed ? 'Show the panel' : 'Collapse the panel'}
            onClick={togglePanelCollapsed}
        >
            <img
                src={logo}
                alt="NuTetris"
                className="logo"
                style={{ filter: modeTheme === 'dark' ? 'invert(1)' : 'none', height: 18 }}
            />
        </Button>
    );

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
                ref={panelRef}
                className={`panel${panelCollapsed ? ' panel-collapsed' : ''}${collapsing ? ' panel-collapsing' : ''}`}
                classNames={{ body: 'panel-body' }}
                style={isPhone || panelCollapsed ? undefined : { width: panelWidth }}
                onTouchStart={isPhone && !panelCollapsed ? handleTouchStart : undefined}
                onTouchEnd={isPhone && !panelCollapsed ? handleTouchEnd : undefined}
                onTouchCancel={() => { touchStartY.current = null; }}
            >
                {panelCollapsed ? (
                    // Collapsed: just the logo and the country below it, cut with "…" at the logo's width
                    // (align start: the logo button keeps its own width, so the logo doesn't move)
                    <Flex vertical gap={2} align="start">
                        {/* Phone: the sheet's drag handle here too (tap = show the panel), so the logo sits where it
                            does in the full sheet and doesn't jump when collapsing / restoring */}
                        {isPhone && <div className="sheet-handle sheet-handle-collapsed" onClick={togglePanelCollapsed} />}
                        {logoButton}
                        <Typography.Text strong ellipsis={{ tooltip: country?.name }} className="collapsed-country">
                            <CountryFlag country={country} busy={countryBusy} />
                            {country === undefined ? '…' : country?.name || 'Unknown country'}
                        </Typography.Text>
                    </Flex>
                ) : (<>
                    {/* Desktop: draggable right edge to resize the panel */}
                    {!isPhone && <div className="panel-resize" onPointerDown={handleResizeStart} />}
                    {/* Phone: drag handle, also tappable */}
                    {isPhone && <div className="sheet-handle" onClick={() => setSheetLevel(sheetLevel === 1 ? 0 : 1)} />}
                    {/* Logo and theme switch, hidden (sliding) when the phone sheet is minimized */}
                    <div className={`sheet-section panel-header${minimized ? ' collapsed' : ''}`}>
                        <div className="sheet-section-inner">
                            <Flex align="center" justify="space-between" gap={8}>
                                {logoButton}
                                <ThemeSwitch />
                            </Flex>
                        </div>
                    </div>
                    {/* Both views stay rendered so switching between minimized and normal can slide (see .sheet-section) */}
                    <div className={`sheet-section${minimized ? '' : ' collapsed'}`}>
                        <div className="sheet-section-inner">
                            <LocationInfo data={currentData} country={country} busy={countryBusy} dates={dates} current={current} onDateChange={handleDateChange} compact />
                        </div>
                    </div>
                    <div className={`sheet-section${minimized ? ' collapsed' : ''}`}>
                        <div className="sheet-section-inner">
                            {isPhone ? (
                                <LocationInfo data={currentData} country={country} busy={countryBusy} dates={dates} current={current} onDateChange={handleDateChange} />
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
                                        busy={countryBusy}
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
                        <SelectionBreadcrumb
                            selected={selected}
                            subArea={subArea}
                            onPick={handlePickPath}
                            isPhone={isPhone}
                            sheet={locationSheet}
                            setSheet={setLocationSheet}
                            onMinimize={() => setSheetLevel(0)}
                            searchSignal={searchSignal}
                        />
                    </div>
                </>)}
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
