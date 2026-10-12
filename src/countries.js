import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import data from './countries.json'; // Natural Earth 1:50m country borders (public domain)

// "VN" -> flag image URL (emoji flags don't render on Windows)
const flag = (code) => `https://flagcdn.com/20x15/${code.toLowerCase()}.png`;

// name -> { name, code, flag, continent, feature, box: [west, south, east, north] }
export const COUNTRIES = Object.fromEntries(
    data.features.map((feature) => {
        const { name, code, continent } = feature.properties;
        return [name, { name, code, flag: flag(code), continent, feature, box: bbox(feature) }];
    })
);

// continent -> [country, ...]
export const CONTINENTS = Object.groupBy(Object.values(COUNTRIES), (c) => c.continent);

export const isInCountry = (country, { lat, lng }) => booleanPointInPolygon([lng, lat], country.feature);

// Random point inside the country's real border
export function randomPointIn(country) {
    const [west, south, east, north] = country.box;
    for (let i = 0; i < 100; i++) {
        const point = {
            lat: south + Math.random() * (north - south),
            lng: west + Math.random() * (east - west),
        };
        if (isInCountry(country, point)) return point;
    }
    return null;
}
