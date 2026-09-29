'use strict';

// Mermaid diagrams for the Explore views: an ontology overview (a class
// diagram of classes, subclass links and properties with a domain and range)
// and SHACL shape topologies as extract-cbd-shape interprets them. Views only
// emit placeholders holding the Mermaid source (see diagramHtml); once they
// are in the page, renderDiagrams() lazily loads Mermaid itself and draws
// them, caching the SVG so progressive re-renders do not redraw.

var RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
var RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
var OWL = 'http://www.w3.org/2002/07/owl#';
var XSD = 'http://www.w3.org/2001/XMLSchema#';
var SH = 'http://www.w3.org/ns/shacl#';

var CLASS_TYPES = [RDFS + 'Class', OWL + 'Class'];
var OBJECT_PROPERTY_TYPES = [OWL + 'ObjectProperty'];
var PROPERTY_TYPES = [RDF + 'Property', OWL + 'ObjectProperty', OWL + 'DatatypeProperty'];
// Beyond this many classes a class diagram is no longer an overview
var MAX_CLASSES = 60;

function esc(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

// Only used to tell terms apart within this file
function nodeKey(term) {
  return term.termType + '|' + term.value;
}

// Mermaid reads quotes, brackets and the like as syntax, even in labels
function mermaidText(value) {
  return String(value).replace(/["<>{}()[\]|;#`~]/g, ' ').replace(/\s+/g, ' ').trim() || ' ';
}

// Relation labels and class members end at a colon, unless it is written
// as Mermaid's entity code
function mermaidLabel(value) {
  return mermaidText(value).replace(/:/g, '#58;');
}

function isDatatype(iri) {
  return iri.indexOf(XSD) === 0 || iri === RDFS + 'Literal' || iri === RDF + 'langString' || iri === RDF + 'HTML' || iri === RDF + 'JSON' || iri === RDF + 'XMLLiteral';
}

function namedValues(index, entity, predicate) {
  return index.values(entity, predicate).filter(function (term) { return term.termType === 'NamedNode'; });
}

// A classDiagram of the loaded classes: subclass links, object properties
// as associations from their domain to their range, and datatype
// properties as attributes of their domain. Classes that are only
// mentioned (as a superclass, domain or range) are drawn as <<external>>.
// The returned links map diagram node ids to entityKey(term).
function ontologyDiagram(index, entityKey) {
  var classes = index.entitiesOfType(CLASS_TYPES).filter(function (entity) { return entity.term.termType === 'NamedNode'; });
  var properties = index.entitiesOfType(PROPERTY_TYPES).filter(function (entity) { return entity.term.termType === 'NamedNode'; });
  if (!classes.length) return null;
  var total = classes.length;
  var truncated = total > MAX_CLASSES;
  if (truncated) classes = classes.slice(0, MAX_CLASSES);

  var ids = new Map();
  var links = {};
  var lines = ['classDiagram', '  direction LR'];
  var external = [];
  function id(iri, isExternal) {
    if (!ids.has(iri)) {
      var nodeId = 'C' + ids.size;
      ids.set(iri, nodeId);
      links[nodeId] = entityKey({ termType: 'NamedNode', value: iri });
      lines.push('  class ' + nodeId + '["' + mermaidText(index.compact(iri)) + '"]');
      if (isExternal) external.push(nodeId);
    }
    return ids.get(iri);
  }
  var local = {};
  classes.forEach(function (entity) { local[entity.term.value] = true; id(entity.term.value); });
  function node(iri) { return local[iri] ? ids.get(iri) : (ids.has(iri) ? ids.get(iri) : id(iri, true)); }

  var relations = [];
  classes.forEach(function (entity) {
    namedValues(index, entity, RDFS + 'subClassOf').forEach(function (parent) {
      if (parent.value === OWL + 'Thing' || parent.value === RDFS + 'Resource') return;
      relations.push('  ' + node(parent.value) + ' <|-- ' + ids.get(entity.term.value));
    });
  });
  properties.forEach(function (property) {
    var domains = namedValues(index, property, RDFS + 'domain').filter(function (term) { return local[term.value]; });
    if (!domains.length) return;
    var ranges = namedValues(index, property, RDFS + 'range');
    var name = mermaidLabel(index.compact(property.term.value));
    var isObjectProperty = index.hasType(property, OBJECT_PROPERTY_TYPES);
    domains.forEach(function (domain) {
      var datatypeRanges = ranges.filter(function (range) { return isDatatype(range.value); });
      var classRanges = ranges.filter(function (range) { return !isDatatype(range.value); });
      if (datatypeRanges.length || (!classRanges.length && !isObjectProperty)) {
        var type = datatypeRanges.map(function (range) { return mermaidLabel(index.compact(range.value)); }).join(' or ');
        relations.push('  ' + ids.get(domain.value) + ' : +' + name + (type ? ' ' + type : ''));
      }
      classRanges.forEach(function (range) {
        relations.push('  ' + ids.get(domain.value) + ' --> ' + node(range.value) + ' : ' + name);
      });
    });
  });
  lines = lines.concat(relations);
  external.forEach(function (nodeId) { lines.push('  <<external>> ' + nodeId); });
  return { source: lines.join('\n') + '\n', links: links, truncated: truncated, shown: classes.length, total: total };
}

// extract-cbd-shape writes full IRIs, with U+200E marks keeping Mermaid from
// reading them as links; show them as prefixed names where possible
function compactMermaid(source, index) {
  return source.replace(/[a-z][a-z0-9+.-]*:‎?\/\/[^\s"|\]()[]+/gi, function (written) {
    var iri = written.replace(/‎/g, '');
    var compacted = index.compact(iri);
    return compacted === iri ? written : compacted;
  });
}

// The node shapes to draw a topology from: the ones ShapesGraph.fromStore
// picks up (subjects of sh:property, sh:NodeShapes and sh:node objects)
// that no other shape links to through sh:node -- those are already drawn
// inside the shape linking to them
function rootShapes(index, shapesGraph) {
  var linked = {};
  var candidates = new Map();
  index.quads.forEach(function (quad) {
    if (quad.predicate.value === SH + 'node') linked[nodeKey(quad.object)] = true;
    if (quad.predicate.value === SH + 'property' || (quad.predicate.value === RDF + 'type' && quad.object.value === SH + 'NodeShape')) {
      candidates.set(nodeKey(quad.subject), quad.subject);
    }
  });
  return Array.from(candidates.values()).filter(function (term) {
    return !linked[nodeKey(term)] && shapesGraph.shapes.get(term);
  });
}

// Resolves to [{ shape, source } | { shape, error }] for each root shape, as
// drawn by extract-cbd-shape's ShapesGraph#toMermaid
function shapeTopologies(index, ShapesGraph, createStore) {
  var store = createStore();
  index.quads.forEach(function (quad) { store.addQuad(quad); });
  return ShapesGraph.fromStore(store).then(function (shapesGraph) {
    return rootShapes(index, shapesGraph).map(function (term) {
      try {
        return { shape: term, source: compactMermaid(shapesGraph.toMermaid(term), index) };
      } catch (error) {
        return { shape: term, error: error.message || String(error) };
      }
    });
  });
}

// ShapesGraph is not part of extract-cbd-shape's public exports, but it is
// what turns shapes into the topology its extractor follows, and the only
// part that has a Mermaid rendering. Required lazily so that only the
// bundle, not every Node.js consumer of this file, loads the ES module.
function loadShapesGraph() {
  return Promise.resolve().then(function () {
    return {
      ShapesGraph: require('../node_modules/extract-cbd-shape/dist/lib/ShapesGraph.js').ShapesGraph,
      createStore: require('../node_modules/extract-cbd-shape/dist/lib/Utils.js').createGraphIndexedRdfStore
    };
  });
}

// The topology of the shapes in the index, computed at most once per state
// of the index; a view renders the last result while a newer one computes,
// and onReady re-renders once it is there
function shapeTopologyFor(index, onReady) {
  var cache = index._shapeTopology || (index._shapeTopology = { size: -1, result: null, pending: false });
  if (cache.size !== index.quads.length && !cache.pending) {
    cache.pending = true;
    var size = index.quads.length;
    loadShapesGraph().then(function (modules) {
      return shapeTopologies(index, modules.ShapesGraph, modules.createStore);
    }).then(function (result) {
      cache.result = result;
    }, function (error) {
      cache.result = { error: error.message || String(error) };
    }).then(function () {
      cache.size = size;
      cache.pending = false;
      if (onReady) onReady();
    });
  }
  return cache.result;
}

function diagramHtml(source, links, label) {
  return '<div class="mermaid-diagram" role="img" aria-label="' + esc(label) + '" data-mermaid="' + esc(source) + '"' +
    (links ? ' data-mermaid-links="' + esc(JSON.stringify(links)) + '"' : '') + '><p class="view-note">Drawing diagram…</p></div>';
}

var mermaidPromise = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidPromise) mermaidPromise = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.type = 'module';
    script.src = 'mermaid-loader.mjs';
    script.onload = function () {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      resolve(window.mermaid);
    };
    script.onerror = function () { mermaidPromise = null; reject(new Error('The diagram renderer could not load.')); };
    document.head.append(script);
  });
  return mermaidPromise;
}

var svgCache = new Map();
var renderQueue = Promise.resolve();
var renderCounter = 0;

function renderSvg(source) {
  if (svgCache.has(source)) return svgCache.get(source);
  // Mermaid renders one diagram at a time
  var promise = renderQueue = renderQueue.catch(function () {}).then(function () {
    return loadMermaid();
  }).then(function (mermaid) {
    return mermaid.render('ldfetch-diagram-' + (renderCounter++), source);
  }).then(function (result) { return result.svg; });
  promise.catch(function () { svgCache.delete(source); });
  svgCache.set(source, promise);
  if (svgCache.size > 50) svgCache.delete(svgCache.keys().next().value);
  return promise;
}

// Mermaid puts a class diagram's node ids inside the ids of their SVG
// groups (e.g. mermaid-1-classId-C3-0), which is how clicks map back to
// entities. Edges have ids too (C1---C1---1), so match exactly that form.
function bindLinks(container, links, select) {
  if (!links || !select) return;
  container.querySelectorAll('g[id]').forEach(function (element) {
    var match = /(?:^|-)classId-(C\d+)-\d+$/.exec(element.id);
    if (!match || !links[match[1]]) return;
    element.classList.add('diagram-link');
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    function activate() { select(links[match[1]]); }
    element.addEventListener('click', activate);
    element.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });
  });
}

// Draws every diagram placeholder in container; select(entityKey) is
// called when a linked diagram node is clicked
function renderDiagrams(container, select) {
  container.querySelectorAll('[data-mermaid]').forEach(function (element) {
    var source = element.getAttribute('data-mermaid');
    var links = element.hasAttribute('data-mermaid-links') ? JSON.parse(element.getAttribute('data-mermaid-links')) : null;
    renderSvg(source).then(function (svg) {
      if (!element.isConnected) return;
      element.innerHTML = svg;
      bindLinks(element, links, select);
    }, function (error) {
      if (element.isConnected) element.innerHTML = '<p class="view-note">The diagram could not be drawn: ' + esc(error.message || error) + '</p>';
    });
  });
}

module.exports = {
  ontologyDiagram: ontologyDiagram,
  compactMermaid: compactMermaid,
  shapeTopologies: shapeTopologies,
  shapeTopologyFor: shapeTopologyFor,
  diagramHtml: diagramHtml,
  renderDiagrams: renderDiagrams
};
