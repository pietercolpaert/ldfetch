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

// R2RML, the original RML namespace and RML-Core's newer one mostly share
// local names, so every property is looked up in all three
var RR = 'http://www.w3.org/ns/r2rml#';
var RML = 'http://semweb.mmlab.be/ns/rml#';
var RMLC = 'http://w3id.org/rml/';
var FNML = 'http://semweb.mmlab.be/ns/fnml#';
var FNO_EXECUTES = ['https://w3id.org/function/ontology#executes', 'http://w3id.org/function/ontology#executes'];
var MAX_TRIPLES_MAPS = 60;
var MAX_MEMBERS = 20;
// Beyond this a value (an SQL query, a long template) is cut short; the
// entity inspector still has all of it
var MAX_VALUE_LENGTH = 60;

function rml(localName) {
  return [RR + localName, RML + localName, RMLC + localName];
}

// Mermaid reads much of ASCII punctuation as syntax, and a class diagram
// member ending in $ or * as a classifier, so write all but a few safe
// characters as Mermaid entity codes. Unlike mermaidText, this keeps
// JSONPath, XPath and templates legible.
function mermaidCode(value, max) {
  var text = String(value).replace(/\s+/g, ' ').trim();
  if (max && text.length > max) text = text.slice(0, max - 1) + '…';
  return text.replace(/[^A-Za-z0-9 ._/,=@?!^\u0080-￿-]/g, function (character) {
    return '#' + character.charCodeAt(0) + ';';
  }) || ' ';
}

function first(index, subject, predicates) {
  return index.values(subject, predicates)[0] || null;
}

// The triples maps of an R2RML/RML document: anything typed as one, or
// with a logical source or subject map. FnML function values have a
// logical source and predicate-object maps too, but are not triples maps.
function rmlTriplesMaps(index) {
  var functionValues = {};
  index.quads.forEach(function (quad) {
    if (quad.predicate.value === FNML + 'functionValue') functionValues[nodeKey(quad.object)] = true;
  });
  var structural = rml('logicalSource').concat(rml('logicalTable'), rml('subjectMap'), rml('subject'));
  return Array.from(index.entities.values()).filter(function (entity) {
    if (entity.term.termType === 'Literal' || functionValues[nodeKey(entity.term)]) return false;
    return index.hasType(entity, rml('TriplesMap')) || index.values(entity, structural).length > 0;
  });
}

// A classDiagram of a mapping document: a class per triples map listing its
// subject, classes and predicate-object maps as members, with logical
// sources and FnML/RML-FNML function calls as classes of their own. Dashed
// arrows show what flows into a map (a source, a function result); solid
// arrows are joins through rr:parentTriplesMap. The returned links map
// diagram node ids to entityKey(term).
function rmlDiagram(index, entityKey) {
  var maps = rmlTriplesMaps(index);
  if (!maps.length) return null;
  var total = maps.length;
  var truncated = total > MAX_TRIPLES_MAPS;
  if (truncated) maps = maps.slice(0, MAX_TRIPLES_MAPS);

  var lines = ['classDiagram', '  direction LR'];
  var relations = [];
  var annotations = [];
  var links = {};
  var ids = new Map();
  var names = {};
  var counter = 0;

  function declare(key, term, label, annotation) {
    var nodeId = 'C' + (counter++);
    ids.set(key, nodeId);
    names[nodeId] = label;
    if (term && term.termType !== 'Literal') links[nodeId] = entityKey(term);
    lines.push('  class ' + nodeId + '["' + mermaidCode(label, MAX_VALUE_LENGTH) + '"]');
    if (annotation) annotations.push('  <<' + annotation + '>> ' + nodeId);
    return nodeId;
  }
  function member(nodeId, text) {
    lines.push('  ' + nodeId + ' : ' + text);
  }

  maps.forEach(function (entity, position) {
    var name = index.label(entity);
    if (entity.term.termType === 'BlankNode' && name === index.values(entity, RDF + 'type').map(function (type) { return index.compact(type.value); }).join(', ')) {
      name = 'Triples map ' + (position + 1);
    }
    declare(nodeKey(entity.term), entity.term, name);
  });

  function mapId(term) {
    var key = nodeKey(term);
    return ids.has(key) ? ids.get(key) : declare(key, term, index.label(term), 'external');
  }

  function sourceText(term) {
    if (term.termType !== 'BlankNode') return term.termType === 'Literal' ? term.value : index.compact(term.value);
    // A source description (csvw:Table, dcat:Distribution, rml:RelativePathSource, ...)
    var location = first(index, term, ['http://www.w3.org/ns/csvw#url', RMLC + 'path', 'http://www.w3.org/ns/dcat#downloadURL', 'http://www.w3.org/ns/dcat#accessURL', 'http://www.wiwiss.fu-berlin.de/suhl/bizer/D2RQ/0.1#jdbcDSN', 'http://www.w3.org/ns/sparql-service-description#endpoint']);
    return location ? sourceText(location) : index.label(term);
  }

  // A logical source is drawn once per file, table or query, whatever the
  // iterator: its iterator is listed with it when all maps reading it share
  // one, and labels the arrows to the maps otherwise (see sourceEdges)
  var sourceEdges = new Map();
  function readSource(term, mapNodeId) {
    var source = first(index, term, rml('source'));
    var table = first(index, term, rml('tableName'));
    var iterator = first(index, term, rml('iterator'));
    var formulation = first(index, term, rml('referenceFormulation'));
    var query = first(index, term, rml('sqlQuery').concat(rml('query')));
    var rows = [];
    if (source) rows.push('source ' + mermaidCode(sourceText(source), MAX_VALUE_LENGTH));
    if (table) rows.push('table ' + mermaidCode(table.value, MAX_VALUE_LENGTH));
    if (formulation) rows.push('formulation ' + mermaidCode(index.compact(formulation.value)));
    if (query) rows.push('query ' + mermaidCode(query.value, MAX_VALUE_LENGTH));
    var key = rows.length ? 'source|' + rows.join('|') : nodeKey(term);
    var nodeId = ids.get(key);
    if (!nodeId) {
      var label = source ? sourceText(source).split(/[\\/]/).filter(Boolean).pop() || sourceText(source) : (table ? table.value : (query ? 'query' : index.label(term)));
      nodeId = declare(key, term, label, 'source');
      rows.forEach(function (row) { member(nodeId, row); });
      sourceEdges.set(nodeId, []);
    }
    sourceEdges.get(nodeId).push({ to: mapNodeId, iterator: iterator ? iterator.value : '' });
  }

  // A function call, legacy FnML (predicate-object maps, one of which
  // gives fno:executes) or RML-FNML (rml:function and rml:input)
  function functionId(term, isExecution) {
    var key = nodeKey(term);
    if (ids.has(key)) return ids.get(key);
    var executed = null;
    var parameters = [];
    if (isExecution) {
      executed = first(index, term, RMLC + 'function');
      var functionMap = first(index, term, RMLC + 'functionMap');
      if (!executed && functionMap) executed = first(index, functionMap, RMLC + 'constant');
      index.values(term, RMLC + 'input').forEach(function (input) {
        var parameter = first(index, input, RMLC + 'parameter');
        var parameterMap = first(index, input, RMLC + 'parameterMap');
        if (!parameter && parameterMap) parameter = first(index, parameterMap, RMLC + 'constant');
        var value = first(index, input, [RMLC + 'inputValueMap', RMLC + 'inputValue']);
        parameters.push({ names: parameter ? [parameter] : [], value: value });
      });
    } else {
      index.values(term, rml('predicateObjectMap')).forEach(function (pom) {
        var names = predicatesOf(pom);
        var values = objectsOf(pom);
        if (names.some(function (name) { return FNO_EXECUTES.indexOf(name.value) !== -1; })) {
          executed = values[0] ? constantOf(values[0]) : null;
          return;
        }
        values.forEach(function (value) { parameters.push({ names: names, value: value }); });
      });
    }
    var nodeId = declare(key, term, executed ? index.compact(executed.value) : 'function', 'function');
    parameters.forEach(function (parameter) {
      var described = describe(parameter.value);
      member(nodeId, parameter.names.map(function (name) { return mermaidCode(index.compact(name.value)); }).join(', ') + ' ' + described.text);
      if (described.functionId) relations.push('  ' + described.functionId + ' ..> ' + nodeId);
    });
    return nodeId;
  }

  // Constant-valued shortcuts (rr:predicate ex:p) are the value itself
  function constantOf(termOrMap) {
    if (termOrMap.termType === 'Literal' || !index.entity(termOrMap)) return termOrMap;
    var constant = first(index, termOrMap, rml('constant'));
    if (!constant) return null;
    var termType = first(index, termOrMap, rml('termType'));
    return constant.termType === 'Literal' && termType && /IRI$/.test(termType.value) ? { termType: 'NamedNode', value: constant.value } : constant;
  }
  function predicatesOf(pom) {
    return index.values(pom, rml('predicate')).concat(index.values(pom, rml('predicateMap')).map(function (map) { return constantOf(map) || map; }));
  }
  function objectsOf(pom) {
    return index.values(pom, rml('object')).concat(index.values(pom, rml('objectMap')));
  }

  // How a term map generates its term, as { text, functionId? }
  function describe(termOrMap) {
    if (!termOrMap) return { text: '?' };
    var entity = termOrMap.termType === 'Literal' ? null : index.entity(termOrMap);
    if (!entity || termOrMap.termType === 'NamedNode' && !index.values(entity, rml('constant').concat(rml('template'), rml('reference'), [FNML + 'functionValue', RMLC + 'functionExecution'])).length) {
      return { text: termOrMap.termType === 'Literal' ? mermaidCode('"' + termOrMap.value + '"', MAX_VALUE_LENGTH) : mermaidCode(index.compact(termOrMap.value)) };
    }
    var termType = first(index, entity, rml('termType'));
    var kind = termType ? termType.value.replace(/^.*[#/]/, '') : '';
    var constant = first(index, entity, rml('constant'));
    var template = first(index, entity, rml('template'));
    var reference = first(index, entity, rml('reference'));
    var functionValue = first(index, entity, FNML + 'functionValue');
    var execution = first(index, entity, RMLC + 'functionExecution');
    var result = {};
    var text;
    if (constant) {
      text = constant.termType === 'Literal' && kind !== 'IRI' ? '"' + constant.value + '"' : index.compact(constant.value);
    } else if (template || reference) {
      text = template ? template.value : '{' + reference.value + '}';
      if (kind === 'IRI' && reference) text = '<' + text + '>';
      if (kind === 'Literal' && template) text = '"' + text + '"';
    } else if (functionValue || execution) {
      result.functionId = functionId(functionValue || execution, !functionValue);
      result.text = mermaidCode('ƒ ' + names[result.functionId] + (kind === 'IRI' ? ' as IRI' : ''), MAX_VALUE_LENGTH);
      return result;
    } else {
      text = '?';
    }
    if (kind === 'BlankNode') text = '_:' + text;
    var datatype = first(index, entity, rml('datatype'));
    var language = first(index, entity, rml('language'));
    var languageMap = first(index, entity, rml('languageMap'));
    if (datatype) text += '^^' + index.compact(datatype.value);
    if (language) text += '@' + language.value;
    else if (languageMap) text += '@' + (constantOf(languageMap) || {}).value;
    result.text = mermaidCode(text, MAX_VALUE_LENGTH);
    return result;
  }

  maps.forEach(function (entity) {
    var nodeId = ids.get(nodeKey(entity.term));
    var rows = [];
    var logicalSource = first(index, entity, rml('logicalSource').concat(rml('logicalTable')));
    if (logicalSource) readSource(logicalSource, nodeId);
    var subject = first(index, entity, rml('subject')) || first(index, entity, rml('subjectMap'));
    if (subject) {
      var described = describe(subject);
      rows.push('subject ' + described.text);
      if (described.functionId) relations.push('  ' + described.functionId + ' ..> ' + nodeId + ' : subject');
      index.values(subject, rml('class')).forEach(function (type) { rows.push('a ' + mermaidCode(index.compact(type.value))); });
      index.values(subject, rml('graph').concat(rml('graphMap'))).forEach(function (graph) { rows.push('graph ' + describe(graph).text); });
    }
    index.values(entity, rml('predicateObjectMap')).forEach(function (pom) {
      var predicates = predicatesOf(pom).map(function (predicate) {
        return predicate.termType === 'NamedNode' && !index.values(predicate, rml('template').concat(rml('reference'))).length ? mermaidCode(index.compact(predicate.value)) : describe(predicate).text;
      }).join(', ') || '?';
      objectsOf(pom).forEach(function (object) {
        var parent = object.termType !== 'Literal' && first(index, object, rml('parentTriplesMap'));
        if (parent) {
          var joins = index.values(object, rml('joinCondition')).map(function (condition) {
            var child = first(index, condition, rml('child'));
            var parentReference = first(index, condition, rml('parent'));
            return (child ? child.value : '?') + ' = ' + (parentReference ? parentReference.value : '?');
          });
          relations.push('  ' + nodeId + ' --> ' + mapId(parent) + ' : ' + predicates + (joins.length ? ' ' + mermaidCode('[' + joins.join(', ') + ']', MAX_VALUE_LENGTH) : ''));
          return;
        }
        var described = describe(object);
        rows.push(predicates + ' ' + described.text);
        if (described.functionId) relations.push('  ' + described.functionId + ' ..> ' + nodeId);
      });
    });
    if (rows.length > MAX_MEMBERS) rows = rows.slice(0, MAX_MEMBERS - 1).concat(['… ' + (rows.length - MAX_MEMBERS + 1) + ' more']);
    rows.forEach(function (row) { member(nodeId, row); });
  });

  sourceEdges.forEach(function (edges, sourceId) {
    var shared = edges.every(function (edge) { return edge.iterator === edges[0].iterator; });
    if (shared && edges[0].iterator) member(sourceId, 'iterator ' + mermaidCode(edges[0].iterator, MAX_VALUE_LENGTH));
    edges.forEach(function (edge) {
      relations.push('  ' + sourceId + ' ..> ' + edge.to + (!shared && edge.iterator ? ' : ' + mermaidCode(edge.iterator, MAX_VALUE_LENGTH) : ''));
    });
  });
  lines = lines.concat(relations, annotations);
  return { source: lines.join('\n') + '\n', links: links, truncated: truncated, shown: maps.length, total: total };
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
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', class: { hideEmptyMembersBox: true } });
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
  rmlTriplesMaps: rmlTriplesMaps,
  rmlDiagram: rmlDiagram,
  compactMermaid: compactMermaid,
  shapeTopologies: shapeTopologies,
  shapeTopologyFor: shapeTopologyFor,
  diagramHtml: diagramHtml,
  renderDiagrams: renderDiagrams
};
