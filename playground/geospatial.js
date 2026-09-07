'use strict';

const wkt = require('wellknown');
const proj4 = require('proj4');
const GEO = 'http://www.opengis.net/ont/geosparql#';
const WGS = 'http://www.w3.org/2003/01/geo/wgs84_pos#';
const SCHEMA = ['https://schema.org/', 'http://schema.org/'];
const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
const definitionFailures = new Map();

// Keep frequently encountered projected CRSs usable offline. Other EPSG
// definitions are still loaded on demand by resolveDefinitions().
proj4.defs('EPSG:31370', '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs +type=crs');

function epsgCode(crs) {
  const match = String(crs).match(/^https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/(\d+)\/?$/i);
  return match ? match[1] : null;
}

async function resolveDefinitions(index, signal) {
  const codes = new Set();
  index.quads.forEach(q => {
    if (q.object.termType !== 'Literal') return;
    const iri = q.object.value.match(/^\s*<([^>]+)>/);
    const code = iri && epsgCode(iri[1]);
    if (code && !proj4.defs('EPSG:' + code) && !definitionFailures.has(code)) codes.add(code);
  });
  let changed = false;
  // Bound lookups for one scope; source coordinates never leave the browser.
  for (const code of Array.from(codes).slice(0, 16)) {
    if (signal.aborted) break;
    try {
      const response = await fetch('https://spatialreference.org/ref/epsg/' + code + '/projjson.json', { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('CRS definition HTTP ' + response.status);
      const definition = await response.json();
      proj4.defs('EPSG:' + code, definition);
      changed = true;
    } catch (error) {
      if (!signal.aborted) { definitionFailures.set(code, error.message); changed = true; }
    }
  }
  return changed;
}

function key(term) { return term.termType + '|' + term.value; }

function transformGeometry(geometry, transform) {
  if (!geometry || !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(geometry.type)) throw new Error('Unsupported geometry type');
  if (geometry.type === 'GeometryCollection') {
    return { type: geometry.type, geometries: geometry.geometries.map(g => transformGeometry(g, transform)) };
  }
  function coordinates(value) {
    if (!Array.isArray(value) || !value.length) throw new Error('Empty geometry');
    if (typeof value[0] !== 'number') return value.map(coordinates);
    const point = transform(value);
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new Error('Coordinates outside longitude/latitude bounds');
    }
    return point;
  }
  return { type: geometry.type, coordinates: coordinates(geometry.coordinates) };
}

function parseWkt(value) {
  const match = value.trim().match(/^<([^>]+)>\s*(.*)$/s);
  const crs = match ? match[1] : CRS84;
  const geometry = wkt.parse(match ? match[2] : value);
  if (!geometry) throw new Error('Invalid or unsupported WKT');
  let transform = p => p.slice();
  const epsg = epsgCode(crs);
  if (epsg === '4326') transform = p => [p[1], p[0]].concat(p.slice(2));
  else if (crs !== CRS84 && !/\/CRS84$/.test(crs)) {
    if (!epsg || !proj4.defs('EPSG:' + epsg)) throw new Error('Unsupported CRS: ' + crs + (epsg && definitionFailures.has(epsg) ? ' (' + definitionFailures.get(epsg) + ')' : ''));
    transform = p => proj4('EPSG:' + epsg, 'EPSG:4326').forward(p, true);
  }
  return { geometry: transformGeometry(geometry, transform), crs };
}

// Extract independently per message. Repeated subjects are not permission to
// join a latitude in one occurrence with a longitude in another occurrence.
function extract(index) {
  const features = [];
  const issues = [];
  const groups = index.messageGroups || [{ quads: index.quads, message: null }];
  groups.forEach(group => {
    const subjects = new Map();
    const owners = new Map();
    group.quads.forEach(q => {
      if (!subjects.has(key(q.subject))) subjects.set(key(q.subject), []);
      subjects.get(key(q.subject)).push(q);
      if ([GEO + 'hasGeometry', GEO + 'hasDefaultGeometry', ...SCHEMA.map(ns => ns + 'geo')].includes(q.predicate.value)) owners.set(key(q.object), q.subject);
    });
    function add(q, geometry, crs) {
      const owner = owners.get(key(q.subject)) || q.subject;
      features.push({ type: 'Feature', id: features.length, geometry, properties: {
        entity: key(owner),
        geometryEntity: key(q.subject), label: index.label(owner),
        message: group.message, crs, source: q.object.value
      } });
    }
    group.quads.forEach(q => {
      const dt = q.object.datatype && q.object.datatype.value;
      const shape = SCHEMA.flatMap(ns => ['line', 'polygon', 'box', 'circle'].map(kind => ({ iri: ns + kind, kind }))).find(item => item.iri === q.predicate.value);
      if (shape) {
        try {
          if (shape.kind === 'circle') throw new Error('Circle geometry requires a radius conversion and is not yet supported');
          const numbers = q.object.value.trim().split(/[\s,]+/).map(Number);
          if (numbers.length < 4 || numbers.length % 2 || !numbers.every(Number.isFinite)) throw new Error('Invalid GeoShape coordinates');
          let points = [];
          for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i + 1], numbers[i]]);
          if (shape.kind === 'box') {
            if (points.length !== 2) throw new Error('A box requires two corners');
            const [a, b] = points; points = [a, [b[0], a[1]], b, [a[0], b[1]], a];
          }
          if (shape.kind !== 'line' && points.length && JSON.stringify(points[0]) !== JSON.stringify(points[points.length - 1])) points.push(points[0].slice());
          const geometry = shape.kind === 'line' ? { type: 'LineString', coordinates: points } : { type: 'Polygon', coordinates: [points] };
          add(q, transformGeometry(geometry, p => p), CRS84);
        } catch (error) { issues.push({ entity: key(q.subject), message: group.message, reason: error.message, source: q.object.value }); }
        return;
      }
      if (q.predicate.value !== GEO + 'asWKT' && dt !== GEO + 'wktLiteral' && q.predicate.value !== GEO + 'asGeoJSON' && dt !== GEO + 'geoJSONLiteral') return;
      try {
        if (q.predicate.value === GEO + 'asGeoJSON' || dt === GEO + 'geoJSONLiteral') {
          const value = JSON.parse(q.object.value);
          const geometries = value.type === 'FeatureCollection' ? value.features.map(f => f.geometry) : [value.type === 'Feature' ? value.geometry : value];
          geometries.forEach(g => add(q, transformGeometry(g, p => p.slice()), CRS84));
        } else {
          const parsed = parseWkt(q.object.value);
          add(q, parsed.geometry, parsed.crs);
        }
      } catch (error) { issues.push({ entity: key(q.subject), message: group.message, reason: error.message, source: q.object.value }); }
    });
    subjects.forEach(quads => {
      [[WGS + 'lat', WGS + 'long'], [WGS + 'lat', WGS + 'lon']].concat(SCHEMA.map(ns => [ns + 'latitude', ns + 'longitude'])).forEach(pair => {
        const latitudes = quads.filter(q => q.predicate.value === pair[0]);
        const longitudes = quads.filter(q => q.predicate.value === pair[1]);
        if (!latitudes.length || !longitudes.length) return;
        if (latitudes.length > 1 || longitudes.length > 1) {
          issues.push({ entity: key(quads[0].subject), reason: 'Ambiguous coordinate pairs', message: group.message }); return;
        }
        latitudes.forEach(lat => longitudes.forEach(lon => {
          try {
            if (!lat.object.value.trim() || !lon.object.value.trim()) throw new Error('Empty coordinate');
            const geometry = transformGeometry({ type: 'Point', coordinates: [Number(lon.object.value), Number(lat.object.value)] }, p => p);
            add(lat, geometry, CRS84);
          } catch (error) { issues.push({ entity: key(lat.subject), reason: error.message, message: group.message }); }
        }));
      });
    });
  });
  return { type: 'FeatureCollection', features, issues };
}

let rendererPromise;
function loadRenderer() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!rendererPromise) rendererPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'maplibre-gl.css'; document.head.append(css);
    const script = document.createElement('script'); script.type = 'module'; script.src = 'globe-loader.mjs';
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => { rendererPromise = null; reject(new Error('The globe renderer could not load.')); };
    document.head.append(script);
  });
  return rendererPromise;
}

function mount(container, collection, select, camera, onCamera) {
  let disposed = false;
  let map;
  const status = container.parentElement.querySelector('[data-map-status]');
  const data = { type: 'FeatureCollection', features: [] };
  function worldZoom() { return Math.max(0, Math.log2(Math.min(container.clientWidth, container.clientHeight) * 0.8 / 160)); }
  function flatten(feature, geometry) {
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(g => flatten(feature, g));
    else data.features.push({ ...feature, geometry });
  }
  collection.features.forEach(f => flatten(f, f.geometry));
  loadRenderer().then(lib => {
    if (disposed) return;
    map = new lib.Map({ container, center: camera ? camera.slice(0, 2) : [10, 20], zoom: camera ? camera[2] : worldZoom(),
      style: { version: 8, projection: { type: 'globe' }, sources: {
        earth: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' }
      }, layers: [{ id: 'ocean', type: 'background', paint: { 'background-color': '#b9d9ee' } }, { id: 'earth', type: 'raster', source: 'earth' }] }
    });
    container._globe = map;
    map.addControl(new lib.NavigationControl(), 'top-right');
    map.addControl(new lib.FullscreenControl(), 'top-right');
    map.on('error', () => { if (!disposed) status.textContent = 'Some map tiles could not load. Loaded geometry remains available below.'; });
    map.on('load', () => {
      if (disposed) return;
      map.addSource('features', { type: 'geojson', data });
      map.addLayer({ id: 'areas', type: 'fill', source: 'features', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#e99c37', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'lines', type: 'line', source: 'features', filter: ['!=', '$type', 'Point'], paint: { 'line-color': '#bc541c', 'line-width': 3 } });
      map.addLayer({ id: 'points', type: 'circle', source: 'features', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#d74935', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      map.on('click', event => {
        const hits = map.queryRenderedFeatures(event.point, { layers: ['points', 'lines', 'areas'] });
        if (hits.length) select(hits[0].properties.entity);
      });
      status.textContent = collection.features.length + ' geometries · drag to rotate, scroll to zoom';
    });
    map.on('moveend', () => { if (!disposed) { const c = map.getCenter(); onCamera([c.lng, c.lat, map.getZoom()]); } });
    const home = container.parentElement.querySelector('[data-globe-home]');
    const fit = container.parentElement.querySelector('[data-globe-fit]');
    home.onclick = () => map.jumpTo({ center: [10, 20], zoom: worldZoom(), bearing: 0, pitch: 0 });
    fit.onclick = () => {
      const bounds = new lib.LngLatBounds();
      function visit(coords) { if (typeof coords[0] === 'number') bounds.extend(coords.slice(0, 2)); else coords.forEach(visit); }
      data.features.forEach(f => visit(f.geometry.coordinates));
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 0 });
    };
  }).catch(error => { if (!disposed) status.textContent = 'Globe unavailable: ' + error.message + ' The geometry list is still usable.'; });
  const remove = () => { disposed = true; if (map) map.remove(); };
  remove.update = next => {
    collection = next;
    data.features = [];
    collection.features.forEach(f => flatten(f, f.geometry));
    if (map) {
      const source = map.getSource('features');
      if (source) source.setData(data);
      map.resize();
    }
    status.textContent = collection.features.length + ' geometries · drag to rotate, scroll to zoom';
  };
  return remove;
}

module.exports = { extract, parseWkt, mount, resolveDefinitions };
