const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWkt, extract } = require('../playground/geospatial');
const { DatasetIndex, rankViews } = require('../playground/visualizations');
const df = require('@rdfjs/data-model').default;

test('WKT preserves collections and polygon holes and respects CRS axes', () => {
  assert.deepEqual(parseWkt('POINT (4 50)').geometry.coordinates, [4, 50]);
  assert.deepEqual(parseWkt('<http://www.opengis.net/def/crs/EPSG/0/4326> POINT (50 4)').geometry.coordinates, [4, 50]);
  assert.equal(parseWkt('POLYGON ((0 0,10 0,10 10,0 0),(2 2,3 2,3 3,2 2))').geometry.coordinates.length, 2);
  assert.equal(parseWkt('GEOMETRYCOLLECTION (POINT (4 50), LINESTRING (0 0,1 1))').geometry.geometries.length, 2);
  assert.throws(() => parseWkt('<https://example.org/unknown> POINT (4 50)'), /Unsupported CRS/);
  assert.throws(() => parseWkt('POINT (4 150)'), /bounds/);
  const projected = parseWkt('<http://www.opengis.net/def/crs/EPSG/0/3857> POINT (0 0)').geometry.coordinates;
  assert.ok(Math.abs(projected[0]) < 0.00001 && Math.abs(projected[1]) < 0.00001);
  const lambert72 = parseWkt('<http://www.opengis.net/def/crs/EPSG/9.9.1/31370> POINT (148679.45 171066.81)').geometry.coordinates;
  assert.ok(Math.abs(lambert72[0] - 4.35) < 0.00001 && Math.abs(lambert72[1] - 50.85) < 0.00001);
  assert.deepEqual(parseWkt('<https://www.opengis.net/def/crs/EPSG/9.9.1/4326> POINT (50 4)').geometry.coordinates, [4, 50]);
});

test('message scopes keep repeated subject coordinates separate', () => {
  const index = new DatasetIndex();
  const subject = df.namedNode('https://example.org/location');
  const quad = (predicate, value) => df.quad(subject, df.namedNode('http://www.w3.org/2003/01/geo/wgs84_pos#' + predicate), df.literal(value));
  index.messageGroups = [
    { message: 1, quads: [quad('lat', '50'), quad('long', '4')] },
    { message: 2, quads: [quad('lat', '10'), quad('long', '20')] },
    { message: 3, quads: [quad('lat', '30')] }
  ];
  index.addAll(index.messageGroups.flatMap(g => g.quads));
  const result = extract(index);
  assert.deepEqual(result.features.map(f => f.geometry.coordinates), [[4, 50], [20, 10]]);
  assert.deepEqual(result.features.map(f => f.properties.message), [1, 2]);
});

test('blank-node geometries inherit only one unambiguous named owner', () => {
  const geo = 'http://www.opengis.net/ont/geosparql#';
  const rdfs = 'http://www.w3.org/2000/01/rdf-schema#';
  const feature = df.namedNode('https://example.org/feature');
  const other = df.namedNode('https://example.org/other');
  const geometry = df.blankNode('geometry');
  const ambiguous = df.blankNode('ambiguous');
  const index = new DatasetIndex({ geo, rdfs });
  index.addAll([
    df.quad(feature, df.namedNode(rdfs + 'label'), df.literal('Named feature')),
    df.quad(feature, df.namedNode(geo + 'hasGeometry'), geometry),
    df.quad(geometry, df.namedNode(geo + 'asWKT'), df.literal('POINT (4 50)', df.namedNode(geo + 'wktLiteral'))),
    df.quad(feature, df.namedNode('https://example.org/location'), ambiguous),
    df.quad(other, df.namedNode('https://example.org/location'), ambiguous),
    df.quad(ambiguous, df.namedNode(geo + 'asWKT'), df.literal('POINT (5 51)', df.namedNode(geo + 'wktLiteral')))
  ]);

  const result = extract(index);
  assert.equal(result.features[0].properties.entity, 'NamedNode|https://example.org/feature');
  assert.equal(result.features[0].properties.label, 'Named feature');
  assert.equal(result.features[1].properties.entity, 'BlankNode|ambiguous');
  assert.equal(result.features[1].properties.entityUrl, '');
  assert.equal(result.features[1].properties.label, '_:ambiguous');
});

test('ranking hides redundant and generic views from recommendations', () => {
  const available = ['iiif', 'images', 'overview', 'relationships', 'profile', 'forms', 'map'].map(id => ({ module: { id } }));
  const ranked = rankViews(available);
  assert.deepEqual(ranked.primary.map(item => item.module.id), ['iiif', 'map']);
  assert.ok(ranked.more.some(item => item.module.id === 'images'));
  assert.ok(!ranked.more.some(item => item.module.id === 'overview'));
});
