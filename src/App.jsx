import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import { yellow, grey } from '@ant-design/colors';
import { Button, Checkbox, Collapse, Flex, Input, Select, Switch, Typography, message, Space, ConfigProvider, theme, Card } from 'antd';
import { AimOutlined, CompassOutlined, EnvironmentOutlined, ClockCircleOutlined, UserOutlined, MoonFilled, SunFilled } from '@ant-design/icons';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { COUNTRIES, CONTINENTS, isInCountry, randomPointIn } from './countries';

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

// Keep picking random points until one has Street View nearby (inside the chosen country, if any)
async function findRandomPano(countries) {
    for (let i = 0; i < 50; i++) {
        const country = countries[Math.floor(Math.random() * countries.length)];
        const point = country ? randomPointIn(country) : randomPointOnEarth();
        if (!point) continue;
        try {
            const data = await findPano(point);
            if (!country || isInCountry(country, data.location.latLng.toJSON())) return data;
        } catch {
            // no imagery here, try again
        }
    }
    throw new Error('No panorama found');
}

// Country containing a point, checked locally against the borders (free)
const countryAt = (point) => Object.values(COUNTRIES).find((c) => isInCountry(c, point));

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
const LocationInfo = ({ data, dates, current, onDateChange }) => {
    const { modeTheme, setModeTheme } = useContext(ModeThemeContext);
    if (!data) return null;
    const country = countryAt(data.location.latLng.toJSON());
    return (
        <Flex vertical gap={2} className="location-info">
            <Flex align='center' justify='space-between'>
                <Typography.Text strong>
                    {country && <img src={country.flag} width={20} height={15} alt="" className="flag" />}
                    {country?.name || 'Unknown country'}
                </Typography.Text>
                <Switch
                    styles={{
                        root: {
                            backgroundColor: modeTheme == "light" ? yellow.primary : grey.primary
                        }
                    }}
                    checked={modeTheme == "light"}
                    unCheckedChildren={<MoonFilled />}
                    checkedChildren={<SunFilled />}
                    onClick={(checked, event) => {
                        if (checked) {
                            localStorage.setItem("modeTheme", "light")
                            setModeTheme("light")
                        }
                        else {
                            localStorage.setItem("modeTheme", "dark")
                            setModeTheme("dark")
                        }
                    }} />
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
                {dates.length > 1 ? (
                    <Select
                        size="small"
                        value={current.pano}
                        onChange={(pano) => onDateChange(dates.find((d) => d.pano === pano).month)}
                        options={dates.map((d) => ({ value: d.pano, label: formatMonth(d.month) }))}
                        style={{ width: 160 }}
                    />
                ) : (
                    <Typography.Text type="secondary">{formatMonth(current.month)}</Typography.Text>
                )}
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

// Small map showing the current location: Maps Embed API place mode, free and unlimited.
// Changing the position reloads the iframe
const MiniMap = ({ apiKey, position, className }) => {
    if (!position) return null;
    const params = new URLSearchParams({ key: apiKey, q: `${position.lat},${position.lng}`, zoom: 4 });
    return <iframe src={`https://www.google.com/maps/embed/v1/place?${params}`} className={className} />;
}

const CONTINENT_EMOJI = {
    Asia: '🌏',
    Europe: '🏰',
    Africa: '🪇',
    Oceania: '🦘',
    'North America': '🏔️',
    'South America': '💃',
};

const CountryPicker = ({ selected, onChange, multiple }) => {
    // Single mode: clicking a country replaces the selection, clicking it again clears it
    const toggle = (name) => {
        if (selected.includes(name)) onChange(selected.filter((n) => n !== name));
        else onChange(multiple ? [...selected, name] : [name]);
    };

    // Select every country in the continent, or deselect them all if they're already selected
    const toggleAll = (countries) => {
        const names = countries.map((c) => c.name);
        const allSelected = names.every((n) => selected.includes(n));
        onChange(allSelected
            ? selected.filter((n) => !names.includes(n))
            : [...new Set([...selected, ...names])]);
    };

    const items = Object.entries(CONTINENTS).map(([continent, countries]) => {
        const count = countries.filter((c) => selected.includes(c.name)).length;
        return {
            key: continent,
            label: `${CONTINENT_EMOJI[continent] ?? '🌐'} ${continent}${count ? ` (${count})` : ''}`,
            children: (
                <Flex vertical gap={4}>
                    {multiple && (
                        <Checkbox
                            checked={count === countries.length}
                            indeterminate={count > 0 && count < countries.length}
                            onChange={() => toggleAll(countries)}
                        >
                            Select all
                        </Checkbox>
                    )}
                    {countries.map(({ name, flag }) => (
                        <Checkbox key={name} checked={selected.includes(name)} onChange={() => toggle(name)}>
                            <img src={flag} width={20} height={15} alt="" className="flag" />
                            {name}
                        </Checkbox>
                    ))}
                </Flex>
            ),
        };
    });

    return <Collapse size="small" ghost items={items} styles={{
        header: {
            padding: "2px 0px"
        }
    }} />;
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
    const [ready, setReady] = useState(false);
    const [position, setPosition] = useState(null);
    const [panoData, setPanoData] = useState(null);
    const [month, setMonth] = useState(null); // chosen capture date, null = latest
    const [selected, setSelected] = useState([]);
    const [multiple, setMultiple] = useState(false); // select one country at a time by default
    const [loading, setLoading] = useState(false);
    const [coordsInput, setCoordsInput] = useState('');
    const isPhone = useIsPhone();
    // Phone: the bottom sheet hides the country selection until swiped up
    const [sheetOpen, setSheetOpen] = useState(false);
    const touchStartY = useRef(null);
    const showCountries = !isPhone || sheetOpen;

    function handleTouchStart(e) {
        // Let the country list scroll normally; only count it as a swipe when the list is at the top
        const list = e.target.closest('.country-list');
        touchStartY.current = list && list.scrollTop > 0 ? null : e.touches[0].clientY;
    }

    function handleTouchEnd(e) {
        if (touchStartY.current === null) return;
        const dy = e.changedTouches[0].clientY - touchStartY.current;
        if (dy < -40) setSheetOpen(true); // swipe up
        if (dy > 40) setSheetOpen(false); // swipe down
        touchStartY.current = null;
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
    function show(data, wantedMonth = null) {
        const { lat, lng } = data.location.latLng.toJSON();
        setPosition({ lat, lng });
        setCoordsInput(`${lat}, ${lng}`); // same format as copied from Google Maps
        setPanoData(data);
        setMonth(wantedMonth);
    }

    // The panorama for the chosen date, or the latest one
    const dates = panoData ? panoDates(panoData) : [];
    const current = dates.find((d) => d.month === month) || dates[0];

    useEffect(() => {
        if (!ready) return;
        // Open the coordinates from the URL, or a random place if there are none
        const start = startFromUrl();
        (start ? findNearestPano(start) : findRandomPano([]))
            .then((data) => show(data, start ? dateFromUrl() : null))
            .catch(console.error);
    }, [ready])

    // Keep the URL in sync with the current location and date
    useEffect(() => {
        if (!position) return;
        // Same format as coordinates copied from Google Maps, e.g. ?10.76540664907444,106.66174253789497&date=2025-09
        const date = current?.month ? `&date=${current.month}` : '';
        window.history.replaceState(null, '', `?${position.lat},${position.lng}${date}`);
    }, [position, current?.month])

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
            show(await findRandomPano(selected.map((name) => COUNTRIES[name])));
        } catch (e) {
            console.error(e);
            messageApi.error('No Street View found, try again or pick other countries');
        }
        setLoading(false);
    }

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
                onTouchStart={isPhone ? handleTouchStart : undefined}
                onTouchEnd={isPhone ? handleTouchEnd : undefined}
            >
                {/* Phone: drag handle, also tappable */}
                {isPhone && <div className="sheet-handle" onClick={() => setSheetOpen(!sheetOpen)} />}
                {!isPhone && <MiniMap apiKey={API_KEY} position={position} className="minimap" />}
                <LocationInfo data={panoData} dates={dates} current={current} onDateChange={setMonth} />
                <Input.Search
                    value={coordsInput}
                    onChange={(e) => setCoordsInput(e.target.value)}
                    onFocus={(e) => e.target.select()} // so pasting replaces the old coordinates
                    onSearch={handleGoTo}
                    placeholder="lat, lng"
                    enterButton={<AimOutlined />}
                    disabled={loading}
                />
                <Button color={"cyan"} variant="solid" icon={<CompassOutlined />} onClick={handleRandom} loading={loading} block>
                    {loading ? 'Searching...' : 'Random location'}
                </Button>
                {/* Country selection; on phones it slides in and out (see .sheet-extra) */}
                <div className={`sheet-extra${showCountries ? ' open' : ''}`}>
                    <Flex justify="space-between" align="center">
                        <Typography.Text type="secondary">
                            {selected.length === 0 ? 'Anywhere on earth'
                                : selected.length === 1 ? selected[0]
                                    : `${selected.length} countries selected`}
                        </Typography.Text>
                        <Flex gap={6} align="center">
                            <Typography.Text type="secondary">Multiple</Typography.Text>
                            <Switch
                                size="small"
                                checked={multiple}
                                onChange={(checked) => {
                                    setMultiple(checked);
                                    // Back to single mode: keep only the most recently picked country
                                    if (!checked) setSelected(selected.slice(-1));
                                }}
                            />
                        </Flex>
                    </Flex>
                    <div className="country-list">
                        <CountryPicker selected={selected} onChange={setSelected} multiple={multiple} />
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
