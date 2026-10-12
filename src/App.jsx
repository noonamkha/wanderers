import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import { yellow, grey } from '@ant-design/colors';
import { Button, Flex, Input, Select, Switch, Typography, message, Space, ConfigProvider, theme, Card, Tree, Cascader, Checkbox } from 'antd';
import { AimOutlined, CompassOutlined, EnvironmentOutlined, ClockCircleOutlined, UserOutlined, MoonFilled, SunFilled } from '@ant-design/icons';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import logo from './assets/nu-tetris.svg';
import { COUNTRIES, CONTINENTS, prettyName, loadLevel, areaFeature, isInFeature, randomPointIn, countryAt } from './gadm';
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

// Capture date from ?...&date=YYYY-MM, if present
const dateFromUrl = () => new URLSearchParams(window.location.search).get('date');

// Find a panorama near a location (StreetViewService is not billed)
async function findPano(location, radius = 50000) {
    const { StreetViewService, StreetViewPreference } = await importLibrary('streetView');
    const { data } = await new StreetViewService().getPanorama({
        location,
        radius,
        // NEAREST only works well within ~1km, beyond that let Google pick the best one
        preference: radius <= 1000 ? StreetViewPreference.NEAREST : StreetViewPreference.BEST,
    });
    console.log("data", data)
    return data;
}

// Closest panorama to an exact spot: search small first, widen only if nothing is found
async function findNearestPano(location) {
    for (const radius of [50, 1000]) {
        try {
            return await findPano(location, radius);
        } catch {
            // nothing this close, widen the search
        }
    }
    return findPano(location);
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

// Keep picking random points until one has Street View nearby (inside one of the chosen areas, if any).
// Returns { data, box }: the panorama and the bounding box of the area it was found in (null for anywhere)
async function findRandomPano(areas) {
    for (let i = 0; i < 50; i++) {
        const area = areas[Math.floor(Math.random() * areas.length)];
        const feature = area ? await areaFeature(area) : null;
        const point = feature ? randomPointIn(feature) : randomPointOnEarth();
        if (!point) continue;
        try {
            const data = await findPano(point, feature ? searchRadius(feature) : 50000);
            if (!feature || isInFeature(feature, data.location.latLng.toJSON())) return { data, box: feature?.bbox ?? null };
        } catch {
            // no imagery here, try again
        }
    }
    throw new Error('No panorama found');
}

const formatMonth = (month) =>
    month ? new Date(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Unknown date';

// All capture dates available at this spot, newest first: [{ pano, month: "YYYY-MM" }]
// `data.time` is undocumented: [{ pano, <minified name>: Date }], so find the Date field by type
function panoDates(data) {
    const dates = (data.time || [])
        .map((t) => ({ pano: t.pano, date: Object.values(t).find((v) => v instanceof Date) }))
        .filter((t) => t.pano && t.date)
        .map(({ pano, date }) => ({
            pano,
            month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        }))
        .sort((a, b) => b.month.localeCompare(a.month));
    return dates.length ? dates : [{ pano: data.location.pano, month: data.imageDate }];
}

// Place name, country and capture date of the current panorama, with a picker when there are several dates
// Light / dark mode toggle
const ThemeSwitch = () => {
    const { modeTheme, setModeTheme } = useContext(ModeThemeContext);
    return (
        <Switch
            styles={{
                root: {
                    backgroundColor: modeTheme == "light" ? yellow.primary : grey.primary
                }
            }}
            checked={modeTheme == "light"}
            unCheckedChildren={<MoonFilled />}
            checkedChildren={<SunFilled />}
            onClick={(checked) => {
                if (checked) {
                    localStorage.setItem("modeTheme", "light")
                    setModeTheme("light")
                }
                else {
                    localStorage.setItem("modeTheme", "dark")
                    setModeTheme("dark")
                }
            }} />
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
        />
    );
}

// Web Mercator y of a latitude (what map zoom levels are based on)
const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.min(Math.max(lat, -85), 85) * Math.PI) / 360));

// Center and zoom that fit a bounding box [west, south, east, north] into a map of the given pixel size,
// with a margin: the area fills at most ~80% of the map, so the surrounding areas show too
function frameView([west, south, east, north], { width, height }) {
    const [ySouth, yNorth] = [mercatorY(south), mercatorY(north)];
    const zoomX = Math.log2((width * 360) / (256 * Math.max(east - west, 1e-6)));
    const zoomY = Math.log2((height * 2 * Math.PI) / (256 * Math.max(yNorth - ySouth, 1e-9)));
    const zoom = Math.min(Math.max(Math.floor(Math.min(zoomX, zoomY) - 0.3), 0), 18);
    const lat = (Math.atan(Math.sinh((ySouth + yNorth) / 2)) * 180) / Math.PI;
    return { center: `${lat},${(west + east) / 2}`, zoom };
}

// Small map showing the current location: Maps Embed API place mode, free and unlimited.
// view: { position, frame } where frame is the bounding box of the area to fit (selected area or country).
// The iframe only reloads when the position, center or zoom actually change
const MiniMap = ({ apiKey, view, className }) => {
    const ref = useRef(null);
    const [size, setSize] = useState(null);

    useEffect(() => {
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            if (width && height) setSize({ width, height });
        });
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, [])

    let src;
    if (view && size) {
        const { position, frame } = view;
        const params = new URLSearchParams({ key: apiKey, q: `${position.lat},${position.lng}` });
        const { center, zoom } = frame ? frameView(frame, size) : { center: `${position.lat},${position.lng}`, zoom: 4 };
        params.set('center', center);
        params.set('zoom', zoom);
        src = `https://www.google.com/maps/embed/v1/place?${params}`;
    }
    return <iframe ref={ref} src={src} className={className} />;
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

// Continent > country tree with a single selection (a continent or a country).
// Keys are GADM country codes, continents are "continent:<name>"
const COUNTRY_TREE = CONTINENTS.map(([continent, countries]) => ({
    key: `continent:${continent}`,
    title: `${CONTINENT_EMOJI[continent] ?? '🌐'} ${continent}`,
    children: countries.map((country) => ({
        key: country.code,
        title: <>{country.flag && <img src={country.flag} width={20} height={15} alt="" className="flag" />}{country.name}</>,
        isLeaf: true,
    })),
}));

// selectedExtra: shown right below the selected node (the narrow-down cascader for a country)
const CountryPicker = ({ selected, onChange, selectedExtra }) => (
    <Tree
        blockNode
        treeData={COUNTRY_TREE}
        selectedKeys={selected ? [selected] : []}
        onSelect={(keys) => onChange(keys[0] ?? null)} // clicking the selected node again clears it
        titleRender={(node) => node.key === selected && selectedExtra ? (
            <>
                {node.title}
                {/* Clicks and keys inside belong to the cascader, not the tree (no deselect, no tree navigation) */}
                <div className="tree-node-extra" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {selectedExtra}
                </div>
            </>
        ) : node.title}
    />
);

// Display names of level 1 / 2 areas by GADM id, filled in as countries' options are built
const AREA_NAMES = new Map();

// Cascader options for a country's level 1 (and level 2) areas, built from one GADM file:
// the level 2 file also has each area's level 1 parent (GID_1, NAME_1)
async function subAreaOptions(country) {
    const level = Math.min(country.levels - 1, 2);
    const data = await loadLevel(country.code, level);
    const level1 = new Map();
    for (const { properties: p } of data.features) {
        const name1 = prettyName(p.NAME_1);
        if (!level1.has(p.GID_1)) {
            level1.set(p.GID_1, { value: p.GID_1, label: name1, children: level === 2 ? [] : undefined });
            AREA_NAMES.set(p.GID_1, `${name1}, ${country.name}`);
        }
        if (level === 2) {
            const name2 = prettyName(p.NAME_2);
            level1.get(p.GID_1).children.push({ value: p.GID_2, label: name2 });
            AREA_NAMES.set(p.GID_2, `${name2}, ${name1}, ${country.name}`);
        }
    }
    const byLabel = (a, b) => a.label.localeCompare(b.label);
    const options = [...level1.values()].sort(byLabel);
    options.forEach((o) => o.children?.sort(byLabel));
    return options;
}

// Optional narrowing of the selected country to a level 1 area, or a level 2 area inside it, with search.
// value: path of GADM ids, e.g. ["VNM.1_1"] or ["VNM.1_1", "VNM.1.1_1"]
const SubAreaPicker = ({ country, value, onChange }) => {
    const [options, setOptions] = useState({}); // country code -> cascader options
    const code = country?.levels > 1 ? country.code : null;

    useEffect(() => {
        if (!code || options[code]) return;
        subAreaOptions(COUNTRIES[code])
            .then((o) => setOptions((all) => ({ ...all, [code]: o })))
            .catch(console.error);
    }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!code) return null;

    return (
        <Cascader
            options={options[code] ?? []}
            loading={!options[code]}
            value={value}
            onChange={(v) => onChange(v ?? [])}
            changeOnSelect // a level 1 area can be picked without going down to level 2
            showSearch={{
                filter: (input, path) => path.some((o) => o.label.toLowerCase().includes(input.toLowerCase())),
            }}
            placeholder={`Narrow down within ${country.name} (optional)`}
            allowClear
            style={{ width: '100%', flexShrink: 0 }}
        />
    );
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

// Text for the current selection
function selectionLabel(selected, areas) {
    if (!selected) return 'Anywhere';
    if (selected.startsWith('continent:')) return selected.slice('continent:'.length);
    return areas[0]?.name ?? '';
}

const PANEL_MIN_WIDTH = 250; // desktop panel width, px

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
    const [mapView, setMapView] = useState(null); // mini map: { position, frame }
    const [country, setCountry] = useState(); // country of the current panorama, undefined while looking it up
    const showCount = useRef(0);
    const [month, setMonth] = useState(null); // chosen capture date, null = latest
    const [selected, setSelected] = useState(null); // tree key: a continent or a country
    const [subArea, setSubArea] = useState([]); // cascader path inside the selected country
    const [showMap, setShowMap] = useState(() => loadSetting('showMap') !== 'false'); // desktop mini map
    const [panelWidth, setPanelWidth] = useState(() => Number(loadSetting('panelWidth')) || PANEL_MIN_WIDTH); // desktop
    const [loading, setLoading] = useState(false);
    const [coordsInput, setCoordsInput] = useState('');
    const isPhone = useIsPhone();
    // Phone bottom sheet levels, changed by swiping: 0 = minimized (country, date, random button),
    // 1 = normal (no country selection), 2 = open (half the screen, with country selection)
    const [sheetLevel, setSheetLevel] = useState(1);
    const touchStartY = useRef(null);
    const touchStartTime = useRef(0);
    const sheetOpen = isPhone && sheetLevel === 2;
    const minimized = isPhone && sheetLevel === 0;
    const showCountries = !isPhone || sheetLevel === 2;
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
        setSheetLevel((level) => Math.min(Math.max(level + step, 0), 2));
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

    // Show a found panorama. The embed can't report its position, so take it from the lookup
    // areaBox: bounding box of the selected area the panorama was found in; the mini map frames it
    // (or the panorama's country if there's none)
    function show(data, wantedMonth = null, areaBox = null) {
        const { lat, lng } = data.location.latLng.toJSON();
        setPosition({ lat, lng });
        setCoordsInput(`${lat}, ${lng}`); // same format as copied from Google Maps
        setPanoData(data);
        setMonth(wantedMonth);
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
                setMapView({ position: { lat, lng }, frame: areaBox ?? c?.box ?? null });
            });
    }

    const areas = selectedAreas(selected, subArea);

    // The panorama for the chosen date, or the latest one
    const dates = panoData ? panoDates(panoData) : [];
    const current = dates.find((d) => d.month === month) || dates[0];

    useEffect(() => {
        if (!ready) return;
        // Open the coordinates from the URL, or a random place if there are none
        const start = startFromUrl();
        const found = start
            ? findNearestPano(start).then((data) => show(data, dateFromUrl()))
            : findRandomPano([]).then(({ data }) => show(data));
        found.catch(console.error);
    }, [ready])

    // Keep the URL in sync with the current location and date
    useEffect(() => {
        if (!position) return;
        // Same format as coordinates copied from Google Maps, e.g. ?10.76540664907444,106.66174253789497&date=2025-09
        const date = current?.month ? `&date=${current.month}` : '';
        window.history.replaceState(null, '', `?${position.lat},${position.lng}${date}`);
    }, [position, current?.month])

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

    function toggleMap(show) {
        setShowMap(show);
        saveSetting('showMap', String(show));
    }

    function handleSelect(key) {
        setSelected(key);
        setSubArea([]);
    }

    async function handleGoTo() {
        const coords = parseCoords(coordsInput);
        if (!coords) {
            messageApi.warning('Enter coordinates like "21.93208214656689, 105.28151727425242"');
            return;
        }
        setLoading(true);
        try {
            show(await findNearestPano(coords));
        } catch (e) {
            console.error(e);
            messageApi.error('No Street View found near these coordinates');
        }
        setLoading(false);
    }

    async function handleRandom() {
        setLoading(true);
        try {
            const { data, box } = await findRandomPano(areas);
            show(data, null, box);
        } catch (e) {
            console.error(e);
            messageApi.error('No Street View found, try again or pick other areas');
        }
        setLoading(false);
    }

    if (!API_KEY) return <p>Missing VITE_GOOGLE_MAPS_API_KEY. Add it to .env.local and restart the dev server.</p>;
    if (!ready) return null;
    console.log("antdTheme.token.boxShadow", antdTheme.token.boxShadow)
    return (
        <>
            {messageContext}
            <EmbedStreetView apiKey={API_KEY} pano={current?.pano} />
            {/* On phones the mini map floats in the top right, outside the bottom panel */}
            {isPhone && <MiniMap apiKey={API_KEY} view={mapView} className="minimap minimap-floating" />}
            {/* Card body is a flex column (see .panel-body) so only the country list scrolls */}
            <Card
                className={`panel${sheetOpen ? " open" : ""}`}
                classNames={{ body: 'panel-body' }}
                style={isPhone ? undefined : { width: panelWidth }}
                onTouchStart={isPhone ? handleTouchStart : undefined}
                onTouchEnd={isPhone ? handleTouchEnd : undefined}
                onTouchCancel={() => { touchStartY.current = null; }}
            >
                {/* Desktop: draggable right edge to resize the panel */}
                {!isPhone && <div className="panel-resize" onPointerDown={handleResizeStart} />}
                {/* Phone: drag handle, also tappable */}
                {isPhone && <div className="sheet-handle" onClick={() => setSheetLevel(sheetLevel === 2 ? 1 : sheetLevel + 1)} />}
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
                        <LocationInfo data={panoData} country={country} dates={dates} current={current} onDateChange={setMonth} compact />
                    </div>
                </div>
                <div className={`sheet-section${minimized ? ' collapsed' : ''}`}>
                    <div className="sheet-section-inner">
                        {isPhone ? (
                            <LocationInfo data={panoData} country={country} dates={dates} current={current} onDateChange={setMonth} />
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
                                        <div className="map-reveal-inner">
                                            <MiniMap apiKey={API_KEY} view={mapView} className="minimap" />
                                        </div>
                                    </div>
                                }
                            >
                                <LocationInfo
                                    data={panoData}
                                    country={country}
                                    dates={dates}
                                    current={current}
                                    onDateChange={setMonth}
                                    // Hide the mini map to leave more room for the country list
                                    countryExtra={<Checkbox checked={showMap} onChange={(e) => toggleMap(e.target.checked)}>Map</Checkbox>}
                                />
                            </Card>
                        )}
                        <Input.Search
                            value={coordsInput}
                            onChange={(e) => setCoordsInput(e.target.value)}
                            onFocus={(e) => e.target.select()} // so pasting replaces the old coordinates
                            onSearch={handleGoTo}
                            placeholder="lat, lng"
                            enterButton={<AimOutlined />}
                            disabled={loading}
                        />
                    </div>
                </div>
                <Button color={"cyan"} variant="solid" icon={<CompassOutlined />} onClick={handleRandom} loading={loading} block>
                    {loading ? 'Searching...' : 'Random location'}
                </Button>
                {/* Country selection; on phones it slides in and out (see .sheet-extra) */}
                <div className={`sheet-extra${showCountries ? ' open' : ''}`}>
                    <Typography.Text type="secondary">{selectionLabel(selected, areas)}</Typography.Text>
                    <div className="country-list">
                        <CountryPicker
                            selected={selected}
                            onChange={handleSelect}
                            selectedExtra={COUNTRIES[selected]?.levels > 1
                                ? <SubAreaPicker country={COUNTRIES[selected]} value={subArea} onChange={setSubArea} />
                                : null}
                        />
                    </div>
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
