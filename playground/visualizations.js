'use strict';
var geospatial = require('./geospatial');

var RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
var RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
var XSD = 'http://www.w3.org/2001/XMLSchema#';
var FOAF = 'http://xmlns.com/foaf/0.1/';
var SCHEMA = ['https://schema.org/', 'http://schema.org/'];
var VCARD = 'http://www.w3.org/2006/vcard/ns#';
var SH = 'http://www.w3.org/ns/shacl#';
var SKOS = 'http://www.w3.org/2004/02/skos/core#';
var OWL = 'http://www.w3.org/2002/07/owl#';
var GEO = 'http://www.w3.org/2003/01/geo/wgs84_pos#';
var GEOSPARQL = 'http://www.opengis.net/ont/geosparql#';
var PROV = 'http://www.w3.org/ns/prov#';
var DCAT = 'http://www.w3.org/ns/dcat#';
var SOSA = 'http://www.w3.org/ns/sosa/';
var QB = 'http://purl.org/linked-data/cube#';
var OA = 'http://www.w3.org/ns/oa#';
var VC = 'https://www.w3.org/2018/credentials#';
var HYDRA = 'http://www.w3.org/ns/hydra/core#';
var TREE = 'https://w3id.org/tree#';
var LDES = 'https://w3id.org/ldes#';
var TSS = 'https://w3id.org/tss#';
var OM = 'http://www.ontology-of-units-of-measure.org/resource/om-2/';
var IIIF = 'http://iiif.io/api/presentation/3#';
// IIIF v3's own JSON-LD context aliases structural terms like "items" to
// ActivityStreams (deliberately, for interoperability -- see
// https://iiif.io/api/presentation/3/context.json) using ActivityStreams'
// original "http" namespace IRI, not the "https" one AS elsewhere in this
// file's COMMON_PREFIXES-style constants might suggest.
var AS = 'http://www.w3.org/ns/activitystreams#';
var RML = 'http://semweb.mmlab.be/ns/rml#';
var RR = 'http://www.w3.org/ns/r2rml#';
var SSSOM = 'https://w3id.org/sssom/';
var ORG = 'http://www.w3.org/ns/org#';

var LABELS = [
  SCHEMA[0] + 'name', SCHEMA[1] + 'name', FOAF + 'name', VCARD + 'fn',
  SKOS + 'prefLabel', RDFS + 'label', 'http://purl.org/dc/terms/title',
  'http://purl.org/dc/elements/1.1/title'
];

function termKey(term) {
  if (!term) return '';
  var suffix = '';
  if (term.termType === 'Literal') {
    suffix = '|' + (term.language || '') + '|' + (term.datatype ? term.datatype.value : '');
  }
  return term.termType + '|' + term.value + suffix;
}

function uniqueTerms(terms) {
  var seen = {};
  return terms.filter(function (term) {
    var key = termKey(term);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function DatasetIndex(prefixes) {
  this.prefixes = Object.assign({}, prefixes || {});
  this.entities = new Map();
  this.incoming = new Map();
  this.quads = [];
  this.predicates = new Map();
  this.graphs = new Map();
}

DatasetIndex.prototype.add = function (quad) {
  this.quads.push(quad);
  var sk = termKey(quad.subject);
  var entity = this.entities.get(sk);
  if (!entity) {
    entity = { term: quad.subject, properties: new Map(), quads: [] };
    this.entities.set(sk, entity);
  }
  var values = entity.properties.get(quad.predicate.value) || [];
  values.push(quad.object);
  entity.properties.set(quad.predicate.value, values);
  entity.quads.push(quad);

  var predicateQuads = this.predicates.get(quad.predicate.value) || [];
  predicateQuads.push(quad);
  this.predicates.set(quad.predicate.value, predicateQuads);

  if (quad.object.termType !== 'Literal') {
    var ok = termKey(quad.object);
    var incomingQuads = this.incoming.get(ok) || [];
    incomingQuads.push(quad);
    this.incoming.set(ok, incomingQuads);
  }
  if (quad.graph && quad.graph.termType !== 'DefaultGraph') {
    var gk = termKey(quad.graph);
    if (!this.graphs.has(gk)) this.graphs.set(gk, quad.graph);
  }
};

DatasetIndex.prototype.addAll = function (quads) {
  var self = this;
  (quads || []).forEach(function (quad) { self.add(quad); });
};

DatasetIndex.prototype.entity = function (termOrKey) {
  return this.entities.get(typeof termOrKey === 'string' ? termOrKey : termKey(termOrKey));
};

DatasetIndex.prototype.values = function (entityOrTerm, predicates) {
  var entity = entityOrTerm && entityOrTerm.properties ? entityOrTerm : this.entity(entityOrTerm);
  if (!entity) return [];
  var result = [];
  (Array.isArray(predicates) ? predicates : [predicates]).forEach(function (predicate) {
    result = result.concat(entity.properties.get(predicate) || []);
  });
  return uniqueTerms(result);
};

// Walks an RDF list (rdf:first/rdf:rest, terminated by rdf:nil) starting
// from its head term, returning its members in order. Used for any
// "@container": "@list" JSON-LD property (IIIF's "items" among them) and
// any vocabulary that models an ordered collection this way directly in
// RDF (e.g. SHACL's sh:xone/sh:in, OWL's owl:unionOf).
DatasetIndex.prototype.list = function (headTerm) {
  var items = [];
  var seen = {};
  var current = headTerm;
  while (current && current.value !== RDF + 'nil') {
    var key = termKey(current);
    if (seen[key]) break;
    seen[key] = true;
    var entity = this.entity(current);
    if (!entity) break;
    var first = this.values(entity, RDF + 'first')[0];
    if (first) items.push(first);
    current = this.values(entity, RDF + 'rest')[0];
  }
  return items;
};

// Like values(), but for a property whose value is the head of an RDF list
// rather than repeated directly on the subject -- the shape "@container":
// "@list" JSON-LD properties expand to.
DatasetIndex.prototype.listValues = function (entityOrTerm, predicate) {
  var head = this.values(entityOrTerm, predicate)[0];
  return head ? this.list(head) : [];
};

DatasetIndex.prototype.hasType = function (entity, types) {
  var wanted = Array.isArray(types) ? types : [types];
  return this.values(entity, RDF + 'type').some(function (term) { return wanted.indexOf(term.value) !== -1; });
};

DatasetIndex.prototype.entitiesOfType = function (types) {
  var self = this;
  return Array.from(this.entities.values()).filter(function (entity) { return self.hasType(entity, types); });
};

DatasetIndex.prototype.compact = function (iri) {
  var best = '';
  var bestPrefix = '';
  var prefixes = this.prefixes;
  Object.keys(prefixes).forEach(function (prefix) {
    var namespace = String(prefixes[prefix]);
    if (iri.indexOf(namespace) === 0 && namespace.length > best.length) {
      best = namespace;
      bestPrefix = prefix;
    }
  });
  if (best) return bestPrefix + ':' + iri.slice(best.length);
  var cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 && cut < iri.length - 1 ? iri.slice(cut + 1) : iri;
};

DatasetIndex.prototype.label = function (entityOrTerm) {
  var entity = entityOrTerm && entityOrTerm.properties ? entityOrTerm : this.entity(entityOrTerm);
  var self = this;
  if (entity) {
    for (var i = 0; i < LABELS.length; i++) {
      var values = this.values(entity, LABELS[i]);
      var english = values.find(function (term) { return term.language === 'en'; });
      if (english) return english.value;
      if (values.length) return values[0].value;
    }
  }
  var term = entity ? entity.term : entityOrTerm;
  if (!term) return '';
  if (term.termType === 'Literal') return term.value;
  // A blank node with no naming property at all falls back to its rdf:type
  // (e.g. "js:UnzipFile" for an RDF-Connect processor) rather than its
  // opaque, meaningless internal parser-assigned ID.
  if (term.termType === 'BlankNode' && entity) {
    var types = this.values(entity, RDF + 'type');
    if (types.length) return types.map(function (type) { return self.compact(type.value); }).join(', ');
  }
  return self.compact(term.value || '');
};

DatasetIndex.prototype.searchable = function (entity) {
  var values = [entity.term.value, this.label(entity)];
  entity.properties.forEach(function (terms, predicate) {
    values.push(predicate);
    terms.forEach(function (term) { values.push(term.value); });
  });
  return values.join(' ').toLowerCase();
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(value) {
  if (!value || !String(value).trim()) return '';
  try {
    var url = new URL(value, document.baseURI);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (error) { return ''; }
}

function blankNodeId(term) {
  return '_:' + String(term && term.value || 'blank');
}

// Blank nodes are just as much entities as named nodes (many vocabularies --
// SHACL shapes, RDF-Connect processors -- use them as their main structural
// nodes), so they're selectable here too; the entity inspector and its
// details table already render either kind fine. Only the "Follow named
// node" action is NamedNode-only, since a blank node has no URI to follow.
function selectAttr(term, name) {
  if (!term) return '';
  var title = term.termType === 'BlankNode' ? blankNodeId(term) : term.value;
  return ' ' + (name || 'data-select-entity') + '="' + esc(termKey(term)) + '" title="' + esc(title) + '"';
}

function blankNodeHtml(index, term, depth, seen) {
  depth = depth || 0;
  seen = seen || {};
  var id = blankNodeId(term);
  var entity = index.entity(term);
  var key = termKey(term);
  if (!entity || depth >= 2 || seen[key]) return '<span class="blank-node-id">' + esc(id) + '</span>';
  var nextSeen = Object.assign({}, seen); nextSeen[key] = true;
  var rows = [];
  entity.properties.forEach(function (terms, predicate) {
    if (rows.length >= 6) return;
    var shown = terms.slice(0, 3).map(function (value) {
      if (value.termType === 'Literal' && value.value.length > 180) {
        var shortened = Object.assign({}, value, { value: value.value.slice(0, 177) + '…' });
        return termHtml(index, shortened, depth + 1, nextSeen);
      }
      return termHtml(index, value, depth + 1, nextSeen);
    }).join('<br>');
    if (terms.length > 3) shown += '<br><small>+' + (terms.length - 3) + ' more values</small>';
    rows.push('<span class="blank-node-row"><b>' + esc(index.compact(predicate)) + '</b><span>' + shown + '</span></span>');
  });
  var label = index.label(entity);
  var summary = label && label !== term.value ? label : id;
  if (!rows.length) return '<span class="blank-node-id">' + esc(summary) + '</span>';
  var omitted = entity.properties.size > rows.length ? '<small>+' + (entity.properties.size - rows.length) + ' more properties</small>' : '';
  return '<span class="blank-node-description"><span class="blank-node-summary">' + esc(summary) + ' <small>blank node</small></span><button type="button" class="blank-node-toggle" data-blank-toggle aria-expanded="false">Show details</button><span class="blank-node-properties" hidden>' + rows.join('') + omitted + '</span></span>';
}

function termHtml(index, term, depth, seen) {
  if (!term) return '';
  if (term.termType === 'Literal') {
    var suffix = term.language ? ' <small>@' + esc(term.language) + '</small>' :
      (term.datatype && term.datatype.value !== XSD + 'string' ? ' <small>^^' + esc(index.compact(term.datatype.value)) + '</small>' : '');
    return '<span class="literal">' + esc(term.value) + '</span>' + suffix;
  }
  if (term.termType === 'BlankNode') return blankNodeHtml(index, term, depth, seen);
  var key = termKey(term);
  return '<button type="button" class="entity-link" data-entity="' + esc(key) + '" title="' + esc(term.value) + '">' + esc(index.label(term)) + '</button>';
}

function propertyValues(index, entity, predicates) {
  return index.values(entity, predicates).map(function (term) { return term.value; });
}

function firstValue(index, entity, predicates) {
  return propertyValues(index, entity, predicates)[0] || '';
}

function mediaUrl(index, term) {
  if (!term) return '';
  var media = index.entity(term);
  var content = media && firstValue(index, media, [SCHEMA[0] + 'contentUrl', SCHEMA[1] + 'contentUrl', SCHEMA[0] + 'url', SCHEMA[1] + 'url']);
  if (content) return safeUrl(content);
  // Falling back to the term's own value only makes sense for a NamedNode
  // (many resources -- IIIF annotation bodies especially -- use their own
  // IRI as their content location, with no separate contentUrl/url
  // property at all). A BlankNode's "value" is an opaque, parser-internal
  // label, never a URI -- falling back to it here previously produced a
  // bogus-but-syntactically-valid relative URL (resolved against the
  // page's own address) for any blank-node value with no such property,
  // e.g. a Web Annotation TextualBody comment.
  return term.termType === 'NamedNode' ? safeUrl(term.value) : '';
}

function safeContactUrl(value) {
  if (!value || !String(value).trim()) return '';
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return 'mailto:' + value;
  try {
    var url = new URL(value, document.baseURI);
    return ['http:', 'https:', 'mailto:', 'tel:'].indexOf(url.protocol) !== -1 ? url.href : '';
  } catch (error) { return ''; }
}

function entityTable(index, entities, filter, limit) {
  var needle = (filter || '').trim().toLowerCase();
  var filtered = entities.filter(function (entity) { return !needle || index.searchable(entity).indexOf(needle) !== -1; });
  var shown = filtered.slice(0, limit || 200);
  var rows = shown.map(function (entity) {
    var types = index.values(entity, RDF + 'type').map(function (type) { return index.compact(type.value); }).join(', ');
    return '<tr><th scope="row">' + termHtml(index, entity.term) + '</th><td>' + esc(types || '—') + '</td><td>' + entity.quads.length + '</td></tr>';
  }).join('');
  return '<p class="view-count">Showing ' + shown.length + ' of ' + filtered.length + ' matching entities</p>' +
    '<div class="table-scroll"><table class="entity-table"><thead><tr><th>Entity</th><th>Type</th><th>Statements</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (filtered.length > shown.length ? '<p class="view-note">Refine the filter to inspect the remaining entities.</p>' : '');
}

function detailsHtml(index, entity) {
  if (!entity) return '<p>Select an entity in any view to inspect its statements.</p>';
  var rows = [];
  entity.properties.forEach(function (terms, predicate) {
    rows.push('<tr><th>' + esc(index.compact(predicate)) + '</th><td>' + terms.map(function (term) { return termHtml(index, term); }).join('<br>') + '</td></tr>');
  });
  var entityUrl = entity.term.termType === 'NamedNode' ? safeUrl(entity.term.value) : '';
  return '<div class="entity-heading"><h3>' + esc(index.label(entity)) + '</h3>' +
    (entityUrl ?
      '<a href="' + esc(entityUrl) + '" target="_blank" rel="noopener">' + esc(entity.term.value) + '</a>' +
      // Same data-load-url mechanism the hypermedia controls view uses to
      // follow a TREE/Hydra link: replaces the currently loaded source with
      // this named node, in place, rather than opening a new tab.
      ' <button type="button" class="action-button secondary" data-load-url="' + esc(entityUrl) + '">Follow named node</button>'
      : '<span class="entity-identifier">' + esc(entity.term.value) + '</span>') + '</div>' +
    '<div class="table-scroll"><table class="details-table"><tbody>' + rows.join('') + '</tbody></table></div>';
}

function overviewModule() {
  return {
    id: 'entities', title: 'Entities', priority: 1000,
    detect: function () { return { useful: true }; },
    render: function (index, state) {
      var types = {};
      index.entities.forEach(function (entity) {
        index.values(entity, RDF + 'type').forEach(function (type) { types[type.value] = (types[type.value] || 0) + 1; });
      });
      var topTypes = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; }).slice(0, 8);
      return '<div class="stat-grid"><div><strong>' + index.quads.length + '</strong><span>statements</span></div><div><strong>' + index.entities.size + '</strong><span>entities</span></div><div><strong>' + index.predicates.size + '</strong><span>properties</span></div><div><strong>' + index.graphs.size + '</strong><span>named graphs</span></div></div>' +
        (topTypes.length ? '<div class="type-cloud">' + topTypes.map(function (type) { return '<span>' + esc(index.compact(type)) + ' <b>' + types[type] + '</b></span>'; }).join('') + '</div>' : '') +
        entityTable(index, Array.from(index.entities.values()), state.filter);
    }
  };
}

function profilesModule() {
  var types = [FOAF + 'Person', SCHEMA[0] + 'Person', SCHEMA[1] + 'Person', VCARD + 'Individual'];
  function people(index) {
    return Array.from(index.entities.values()).filter(function (entity) {
      if (index.hasType(entity, types)) return true;
      return index.values(entity, [VCARD + 'fn', VCARD + 'hasName']).length > 0 && !index.hasType(entity, [VCARD + 'Organization', VCARD + 'Group']);
    });
  }
  return {
    id: 'profiles', title: 'People', priority: 900,
    detect: function (index) { var found = people(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = people(index).filter(function (entity) { return !state.filter || index.searchable(entity).indexOf(state.filter.toLowerCase()) !== -1; });
      var cards = found.map(function (entity) {
        var imageTerm = index.values(entity, [FOAF + 'img', FOAF + 'depiction', SCHEMA[0] + 'image', SCHEMA[1] + 'image', VCARD + 'hasPhoto'])[0];
        var image = mediaUrl(index, imageTerm);
        var description = firstValue(index, entity, [SCHEMA[0] + 'description', SCHEMA[1] + 'description', 'http://purl.org/dc/terms/description']);
        var homepage = firstValue(index, entity, [FOAF + 'homepage', SCHEMA[0] + 'url', SCHEMA[1] + 'url']);
        var roles = propertyValues(index, entity, [SCHEMA[0] + 'jobTitle', SCHEMA[1] + 'jobTitle', VCARD + 'role']);
        var affiliations = index.values(entity, [SCHEMA[0] + 'affiliation', SCHEMA[1] + 'affiliation', ORG + 'memberOf']);
        var contacts = index.values(entity, [FOAF + 'mbox', SCHEMA[0] + 'email', SCHEMA[1] + 'email', VCARD + 'hasEmail', SCHEMA[0] + 'telephone', SCHEMA[1] + 'telephone', VCARD + 'hasTelephone']);
        return '<article class="profile-card"' + selectAttr(entity.term) + '>' +
          (image ? '<img src="' + esc(image) + '" alt="Portrait of ' + esc(index.label(entity)) + '" loading="lazy" referrerpolicy="no-referrer">' : '<div class="profile-placeholder" aria-hidden="true">' + esc(index.label(entity).charAt(0).toUpperCase() || '?') + '</div>') +
          '<div><h3>' + esc(index.label(entity)) + '</h3>' + (description ? '<p>' + esc(description) + '</p>' : '') +
          (roles.length ? '<p class="profile-meta"><b>Role</b> ' + esc(roles.join(', ')) + '</p>' : '') +
          (affiliations.length ? '<p class="profile-meta"><b>Affiliation</b> ' + affiliations.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (contacts.length ? '<div class="profile-links">' + contacts.map(function (term) { if (term.termType === 'BlankNode') return termHtml(index, term); var url = safeContactUrl(term.value); return url ? '<a href="' + esc(url) + '">' + esc(url.indexOf('tel:') === 0 ? 'Call' : 'Email') + '</a>' : '<span>' + esc(term.value) + '</span>'; }).join('') + '</div>' : '') +
          (homepage && safeUrl(homepage) ? '<a href="' + esc(safeUrl(homepage)) + '" target="_blank" rel="noopener">Website</a>' : '') + '</div></article>';
      }).join('');
      return '<p class="view-count">' + found.length + ' ' + (found.length === 1 ? 'person' : 'people') + ' described</p><div class="profile-grid">' + cards + '</div>';
    }
  };
}

function imagesModule() {
  var imagePredicates = [FOAF + 'img', FOAF + 'depiction', SCHEMA[0] + 'image', SCHEMA[1] + 'image', SCHEMA[0] + 'contentUrl', SCHEMA[1] + 'contentUrl', VCARD + 'hasPhoto'];
  function images(index) {
    var found = [];
    index.entities.forEach(function (entity) {
      index.values(entity, imagePredicates).forEach(function (term) {
        var url = mediaUrl(index, term);
        if (url) found.push({ owner: entity, term: term, url: url });
      });
      if (index.hasType(entity, [SCHEMA[0] + 'ImageObject', SCHEMA[1] + 'ImageObject'])) {
        var content = index.values(entity, [SCHEMA[0] + 'contentUrl', SCHEMA[1] + 'contentUrl']);
        content.forEach(function (term) { var url = mediaUrl(index, term); if (url) found.push({ owner: entity, term: term, url: url }); });
      }
    });
    var seen = {};
    return found.filter(function (item) { if (seen[item.url]) return false; seen[item.url] = true; return true; });
  }
  return {
    id: 'images', title: 'Images', priority: 850,
    detect: function (index) { var found = images(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = images(index);
      return '<div class="image-grid">' + found.map(function (item) {
        var url = item.url;
        return '<figure><a href="' + esc(url) + '" target="_blank" rel="noopener"><img src="' + esc(url) + '" alt="' + esc(index.label(item.owner)) + '" loading="lazy" referrerpolicy="no-referrer"></a><figcaption>' + termHtml(index, item.owner.term) + '</figcaption></figure>';
      }).join('') + '</div>';
    }
  };
}

function shaclModule() {
  var constraints = [SH + 'minCount', SH + 'maxCount', SH + 'datatype', SH + 'class', SH + 'nodeKind', SH + 'pattern', SH + 'minLength', SH + 'maxLength', SH + 'in', SH + 'node', SH + 'closed'];
  function shapes(index) {
    return Array.from(index.entities.values()).filter(function (entity) {
      return index.hasType(entity, [SH + 'NodeShape', SH + 'PropertyShape']) || index.values(entity, [SH + 'targetClass', SH + 'targetNode', SH + 'path', SH + 'property']).length;
    });
  }
  return {
    id: 'shapes', title: 'Shapes', priority: 880,
    detect: function (index) { var found = shapes(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = shapes(index);
      var nodeShapes = found.filter(function (shape) { return index.hasType(shape, SH + 'NodeShape') || index.values(shape, [SH + 'targetClass', SH + 'targetNode', SH + 'property']).length; });
      var diagrams = nodeShapes.map(function (shape) {
        var propertyShapes = index.values(shape, SH + 'property');
        return '<div class="shape-flow">' + (shape.term.termType === 'NamedNode' ? '<button type="button" class="shape-node main" data-entity="' + esc(termKey(shape.term)) + '">' + esc(index.label(shape)) + '</button>' : '<span class="shape-node main">' + esc(blankNodeId(shape.term)) + '</span>') +
          (propertyShapes.length ? '<div class="shape-branches">' + propertyShapes.map(function (propertyTerm) {
            var property = index.entity(propertyTerm);
            var path = property ? index.values(property, SH + 'path')[0] : null;
            return '<div><span>' + esc(path ? index.compact(path.value) : 'property') + '</span>' + (propertyTerm.termType === 'NamedNode' ? '<button type="button" class="shape-node" data-entity="' + esc(termKey(propertyTerm)) + '">' + esc(index.label(propertyTerm)) + '</button>' : '<span class="shape-node">' + esc(blankNodeId(propertyTerm)) + '</span>') + '</div>';
          }).join('') + '</div>' : '') + '</div>';
      }).join('');
      var cards = found.map(function (shape) {
        var target = index.values(shape, [SH + 'targetClass', SH + 'targetNode']).map(function (term) { return termHtml(index, term); }).join(', ');
        var path = index.values(shape, SH + 'path').map(function (term) { return termHtml(index, term); }).join(', ');
        var propertyShapes = index.values(shape, SH + 'property');
        var badges = [];
        constraints.forEach(function (predicate) {
          index.values(shape, predicate).forEach(function (value) { badges.push('<span><b>' + esc(index.compact(predicate)) + '</b> ' + termHtml(index, value) + '</span>'); });
        });
        return '<article class="shape-card"' + selectAttr(shape.term) + '><h3>' + esc(index.label(shape)) + '</h3>' +
          (target ? '<p><b>targets</b> ' + target + '</p>' : '') + (path ? '<p><b>path</b> ' + path + '</p>' : '') +
          (badges.length ? '<div class="constraint-badges">' + badges.join('') + '</div>' : '') +
          (propertyShapes.length ? '<p><b>properties</b> ' + propertyShapes.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') + '</article>';
      }).join('');
      return '<div class="view-actions"><button type="button" class="action-button" data-action="validate-shacl">Validate loaded data</button><a class="action-button secondary" href="https://playground.rdf-ext.org/shacl/" target="_blank" rel="noopener">Open online validator</a><a href="https://shacl-playground.zazuko.com/" target="_blank" rel="noopener">Alternative validator</a></div>' +
        '<p class="view-note">The local validation uses the entire loaded document as both data and shapes graph. Results describe the current loaded snapshot.</p>' +
        (state.validationHtml || '<div class="validation-result" data-validation-result></div>') + diagrams + '<div class="shape-grid">' + cards + '</div>';
    }
  };
}

function formPreviewModule() {
  function nodeShapes(index) {
    return Array.from(index.entities.values()).filter(function (entity) {
      return index.hasType(entity, SH + 'NodeShape') || index.values(entity, [SH + 'targetClass', SH + 'targetNode', SH + 'property']).length > 0;
    });
  }
  function fieldType(datatype, nodeKind) {
    if (nodeKind === SH + 'IRI') return 'url';
    if ([XSD + 'integer', XSD + 'decimal', XSD + 'double', XSD + 'float'].indexOf(datatype) !== -1) return 'number';
    if ([XSD + 'date', XSD + 'dateTime', XSD + 'dateTimeStamp'].indexOf(datatype) !== -1) return datatype === XSD + 'date' ? 'date' : 'datetime-local';
    return 'text';
  }
  return {
    id: 'forms', title: 'Form preview', priority: 875,
    detect: function (index) { var found = nodeShapes(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index) {
      return '<p class="view-note">Read-only preview inferred from loaded SHACL property shapes. It does not save changes.</p><div class="form-preview-list">' + nodeShapes(index).map(function (shape) {
        var properties = index.values(shape, SH + 'property');
        return '<section><div class="form-preview-heading"><h3>' + esc(index.label(shape)) + '</h3>' + termHtml(index, shape.term) + '</div>' +
          (properties.length ? properties.map(function (propertyTerm) {
            var property = index.entity(propertyTerm);
            if (!property) return '<p class="view-note">Unloaded property shape ' + termHtml(index, propertyTerm) + '</p>';
            var path = index.values(property, SH + 'path')[0];
            var label = firstValue(index, property, [SH + 'name', RDFS + 'label']) || (path ? index.compact(path.value) : index.label(property));
            var datatype = firstValue(index, property, SH + 'datatype');
            var nodeKind = firstValue(index, property, SH + 'nodeKind');
            var min = Number(firstValue(index, property, SH + 'minCount') || 0);
            var max = firstValue(index, property, SH + 'maxCount');
            var help = [min > 0 ? 'required' : 'optional', max ? 'at most ' + max : 'repeatable', datatype ? index.compact(datatype) : (nodeKind ? index.compact(nodeKind) : '')].filter(Boolean).join(' · ');
            return '<label class="shape-field"><span>' + esc(label) + (min > 0 ? ' <b aria-label="required">*</b>' : '') + '</span><input type="' + fieldType(datatype, nodeKind) + '" placeholder="' + esc(path ? index.compact(path.value) : 'Unsupported path') + '" readonly aria-describedby="' + esc(termKey(property.term)) + '-help"><small id="' + esc(termKey(property.term)) + '-help">' + esc(help) + '</small></label>';
          }).join('') : '<p>No property shapes are linked from this node shape.</p>') + '</section>';
      }).join('') + '</div>';
    }
  };
}

function credentialsModule() {
  var types = [VC + 'VerifiableCredential', VC + 'VerifiablePresentation'];
  function credentials(index) { return index.entitiesOfType(types); }
  return {
    id: 'credentials', title: 'Credentials', priority: 870,
    detect: function (index) { var found = credentials(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index) {
      return '<div class="credential-list">' + credentials(index).map(function (credential) {
        var issuer = index.values(credential, VC + 'issuer');
        var subjects = index.values(credential, VC + 'credentialSubject');
        var holders = index.values(credential, VC + 'holder');
        var proofs = index.values(credential, VC + 'proof');
        var credentialStatus = index.values(credential, VC + 'credentialStatus');
        var validFrom = firstValue(index, credential, VC + 'validFrom');
        var validUntil = firstValue(index, credential, VC + 'validUntil');
        return '<article class="credential-card"' + selectAttr(credential.term) + '><div class="credential-status">Not checked</div><h3>' + esc(index.label(credential)) + '</h3>' +
          (issuer.length ? '<p><b>Issuer</b> ' + issuer.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (holders.length ? '<p><b>Holder</b> ' + holders.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (subjects.length ? '<p><b>Subject</b> ' + subjects.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (validFrom || validUntil ? '<p><b>Validity</b> ' + esc(validFrom || '…') + ' – ' + esc(validUntil || '…') + '</p>' : '') +
          (proofs.length ? '<p><b>Declared proof</b> ' + proofs.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (credentialStatus.length ? '<p><b>Declared status</b> ' + credentialStatus.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          '<p class="view-note">Proof and status have not been cryptographically verified by this viewer.</p></article>';
      }).join('') + '</div>';
    }
  };
}

function geographyModule() {
  return {
    id: 'map', title: 'Geospatial', priority: 950,
    detect: function (index) { var data = geospatial.extract(index); return { useful: data.features.length + data.issues.length > 0, count: data.features.length }; },
    render: function (index, state) {
      var data = geospatial.extract(index);
      if (state.filter) data.features = data.features.filter(function (f) { return (f.properties.label + ' ' + f.properties.source).toLowerCase().includes(state.filter.toLowerCase()); });
      state.mapData = data;
      return '<div class="globe-view"><div class="view-actions"><button class="action-button" data-globe-home>Whole Earth</button><button class="action-button secondary" data-globe-fit>Fit geometries</button></div><div class="globe" data-globe aria-label="Interactive spherical Earth"></div><p data-map-status role="status">Loading globe…</p></div>' +
        '<div class="geometry-list"><h3>' + data.features.length + ' geometries in this scope</h3>' + data.features.map(function (f) {
          var label = f.properties.entityUrl ? '<button class="entity-link" data-entity="' + esc(f.properties.entity) + '" data-geometry-id="' + esc(f.id) + '">' + esc(f.properties.label) + '</button>' : '<span class="blank-node-id">' + esc(f.properties.label) + '</span>';
          return '<p>' + label + ' · ' + esc(f.geometry.type) + (f.properties.message !== null ? ' · message ' + f.properties.message : '') + '</p>';
        }).join('') + '</div>' + (data.issues.length ? '<details class="geometry-issues"><summary>' + data.issues.length + ' geometries could not be plotted</summary>' + data.issues.map(function (issue) {
          return '<p>' + (issue.entity.indexOf('NamedNode|') === 0 ? '<button class="entity-link" data-entity="' + esc(issue.entity) + '">Inspect source</button>' : '<span class="blank-node-id">' + esc(issue.label || issue.entity.replace(/^BlankNode\|/, '_:')) + '</span>') + ' ' + esc(issue.reason) + '</p>';
        }).join('') + '</details>' : '');
    }
  };
}

function temporalModule() {
  function dates(index) {
    var found = [];
    index.quads.forEach(function (quad) {
      if (quad.object.termType !== 'Literal') return;
      var datatype = quad.object.datatype && quad.object.datatype.value;
      if ([XSD + 'date', XSD + 'dateTime', XSD + 'dateTimeStamp', XSD + 'gYear'].indexOf(datatype) === -1) return;
      var time = Date.parse(quad.object.value);
      if (isFinite(time)) found.push({ quad: quad, time: time });
    });
    return found.sort(function (a, b) { return a.time - b.time; });
  }
  return {
    id: 'timeline', title: 'Timeline', priority: 760,
    detect: function (index) { var found = dates(index); return { useful: found.length > 1, count: found.length }; },
    render: function (index) {
      var found = dates(index);
      var min = found[0].time;
      var max = found[found.length - 1].time;
      var span = Math.max(1, max - min);
      var marks = found.map(function (item) {
        var left = 2 + ((item.time - min) / span) * 96;
        return item.quad.subject.termType === 'NamedNode' ? '<button type="button" class="timeline-mark" data-entity="' + esc(termKey(item.quad.subject)) + '" style="left:' + left.toFixed(2) + '%" title="' + esc(index.label(item.quad.subject) + ': ' + item.quad.object.value) + '"></button>' : '<span class="timeline-mark inert" style="left:' + left.toFixed(2) + '%" title="' + esc(blankNodeId(item.quad.subject) + ': ' + item.quad.object.value) + '"></span>';
      }).join('');
      return '<div class="timeline-axis">' + marks + '</div><div class="timeline-labels"><span>' + esc(new Date(min).toISOString()) + '</span><span>' + esc(new Date(max).toISOString()) + '</span></div>' + entityTable(index, uniqueTerms(found.map(function (item) { return item.quad.subject; })).map(function (term) { return index.entity(term); }).filter(Boolean), '', 100);
    }
  };
}

function extractTimeSeries(index) {
  var groups = {};
  function add(group, point) {
    if (!isFinite(point.time) || !isFinite(point.value)) return;
    (groups[group] || (groups[group] = [])).push(point);
  }

  (index.predicates.get(TSS + 'points') || []).forEach(function (quad) {
    if (quad.object.termType !== 'Literal') return;
    var points;
    try { points = JSON.parse(quad.object.value); } catch (error) { return; }
    if (!Array.isArray(points)) return;
    points.forEach(function (point, position) {
      if (!point || typeof point !== 'object') return;
      var label = point.observedProperty || index.label(quad.subject) || 'RDF TSS values';
      add('TSS|' + label, {
        entity: termKey(quad.subject), label: String(label), time: Date.parse(point.time),
        timeLabel: String(point.time || ''), value: Number(point.value),
        pointId: String(point.id == null ? position : point.id), source: 'RDF TSS JSON point'
      });
    });
  });

  index.entitiesOfType(SOSA + 'Observation').forEach(function (observation) {
    var timeTerm = index.values(observation, [SOSA + 'resultTime', SOSA + 'phenomenonTime'])[0];
    if (!timeTerm) return;
    var property = index.values(observation, SOSA + 'observedProperty')[0];
    var label = property ? index.label(property) : 'Observation';
    var candidates = index.values(observation, SOSA + 'hasSimpleResult').map(function (term) { return { term: term, result: null }; });
    index.values(observation, SOSA + 'hasResult').forEach(function (result) {
      index.values(result, [OM + 'hasNumericalValue', 'http://qudt.org/schema/qudt/numericValue', SCHEMA[0] + 'value', SCHEMA[1] + 'value', RDF + 'value']).forEach(function (term) { candidates.push({ term: term, result: result }); });
    });
    (index.incoming.get(termKey(observation.term)) || []).filter(function (quad) { return quad.predicate.value === SOSA + 'isResultOf'; }).forEach(function (quad) {
      index.values(quad.subject, [OM + 'hasNumericalValue', 'http://qudt.org/schema/qudt/numericValue', SCHEMA[0] + 'value', SCHEMA[1] + 'value', RDF + 'value']).forEach(function (term) { candidates.push({ term: term, result: quad.subject }); });
    });
    candidates.forEach(function (candidate, position) {
      add('SOSA|' + (property ? property.value : label), {
        entity: termKey(observation.term), label: label, time: Date.parse(timeTerm.value),
        timeLabel: timeTerm.value, value: Number(candidate.term.value),
        pointId: observation.term.value + ':' + position, source: 'SOSA observation'
      });
    });
  });

  return Object.keys(groups).map(function (key) {
    var points = groups[key].sort(function (a, b) { return a.time - b.time; });
    return { key: key, label: points[0].label, points: points };
  }).filter(function (series) { return series.points.length > 1; }).sort(function (a, b) { return b.points.length - a.points.length; });
}

function timeSeriesModule() {
  return {
    id: 'timeseries', title: 'Time series', priority: 925,
    detect: function (index) { var found = extractTimeSeries(index); return { useful: found.length > 0, count: found.reduce(function (sum, series) { return sum + series.points.length; }, 0) }; },
    render: function (index) {
      var found = extractTimeSeries(index).slice(0, 6);
      return '<div class="time-series-list">' + found.map(function (series) {
        var points = series.points.slice(0, 500);
        var minTime = points[0].time, maxTime = points[points.length - 1].time;
        var values = points.map(function (point) { return point.value; });
        var minValue = Math.min.apply(null, values), maxValue = Math.max.apply(null, values);
        var timeSpan = Math.max(1, maxTime - minTime), valueSpan = Math.max(1e-12, maxValue - minValue);
        var coordinates = points.map(function (point) {
          return (20 + (point.time - minTime) / timeSpan * 560).toFixed(2) + ',' + (170 - (point.value - minValue) / valueSpan * 140).toFixed(2);
        }).join(' ');
        var marks = points.map(function (point) {
          var x = 20 + (point.time - minTime) / timeSpan * 560;
          var y = 170 - (point.value - minValue) / valueSpan * 140;
          var selectable = point.entity.indexOf('NamedNode|') === 0;
          return '<circle' + (selectable ? ' tabindex="0" role="button" data-entity="' + esc(point.entity) + '"' : '') + ' class="time-series-point' + (selectable ? '' : ' inert') + '" data-point-id="' + esc(point.pointId) + '" data-time="' + esc(point.timeLabel) + '" data-value="' + esc(point.value) + '" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="4"><title>' + esc(series.label + ' · ' + point.timeLabel + ' · ' + point.value) + '</title></circle>';
        }).join('');
        return '<section><h3>' + esc(series.label) + '</h3><svg class="time-series-chart" viewBox="0 0 600 190" role="img" aria-label="' + esc(series.label + ', ' + points.length + ' loaded points') + '"><line x1="20" y1="170" x2="580" y2="170"></line><polyline points="' + coordinates + '"></polyline>' + marks + '</svg><div class="time-series-legend"><span>' + esc(points[0].timeLabel) + '</span><b>' + esc(minValue + ' – ' + maxValue) + '</b><span>' + esc(points[points.length - 1].timeLabel) + '</span></div></section>';
      }).join('') + '</div><p class="view-note">Values are plotted directly from loaded RDF TSS points or SOSA observations; no interpolation or unit conversion is applied.</p>';
    }
  };
}

function taxonomyModule() {
  function concepts(index) { return index.entitiesOfType(SKOS + 'Concept'); }
  return {
    id: 'taxonomy', title: 'Taxonomy', priority: 780,
    detect: function (index) { var found = concepts(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = concepts(index);
      var children = {};
      var hasParent = {};
      found.forEach(function (entity) {
        index.values(entity, SKOS + 'broader').forEach(function (parent) {
          var pk = termKey(parent);
          (children[pk] || (children[pk] = [])).push(entity);
          hasParent[termKey(entity.term)] = true;
        });
      });
      function branch(entity, seen, depth) {
        var key = termKey(entity.term);
        if (seen[key]) return '<li>' + termHtml(index, entity.term) + ' <span class="warning-badge">cycle</span></li>';
        if (depth > 8) return '<li>' + termHtml(index, entity.term) + ' …</li>';
        var nextSeen = Object.assign({}, seen); nextSeen[key] = true;
        var kids = (children[key] || []).filter(function (child) { return !state.filter || index.searchable(child).indexOf(state.filter.toLowerCase()) !== -1; });
        return '<li>' + termHtml(index, entity.term) + (kids.length ? '<ul>' + kids.map(function (child) { return branch(child, nextSeen, depth + 1); }).join('') + '</ul>' : '') + '</li>';
      }
      var roots = found.filter(function (entity) { return !hasParent[termKey(entity.term)]; });
      if (!roots.length) roots = found.slice(0, 20);
      return '<div class="taxonomy"><ul>' + roots.map(function (root) { return branch(root, {}, 0); }).join('') + '</ul></div>';
    }
  };
}

function ontologyModule() {
  var types = [RDFS + 'Class', OWL + 'Class', RDF + 'Property', OWL + 'ObjectProperty', OWL + 'DatatypeProperty', OWL + 'AnnotationProperty'];
  function terms(index) { return index.entitiesOfType(types); }
  return {
    id: 'ontology', title: 'Ontology', priority: 770,
    detect: function (index) { var found = terms(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = terms(index).filter(function (entity) { return !state.filter || index.searchable(entity).indexOf(state.filter.toLowerCase()) !== -1; });
      return '<div class="ontology-list">' + found.map(function (entity) {
        var parents = index.values(entity, [RDFS + 'subClassOf', RDFS + 'subPropertyOf', OWL + 'equivalentClass', OWL + 'equivalentProperty']);
        var domain = index.values(entity, RDFS + 'domain');
        var range = index.values(entity, RDFS + 'range');
        return '<article' + selectAttr(entity.term) + '><h3>' + esc(index.label(entity)) + '</h3>' +
          (parents.length ? '<p><b>Extends/equivalent</b> ' + parents.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (domain.length ? '<p><b>Domain</b> ' + domain.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
          (range.length ? '<p><b>Range</b> ' + range.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') + '</article>';
      }).join('') + '</div>';
    }
  };
}

function statisticsModule() {
  function series(index) {
    var groups = {};
    index.quads.forEach(function (quad) {
      if (quad.object.termType !== 'Literal') return;
      var datatype = quad.object.datatype && quad.object.datatype.value;
      if ([XSD + 'integer', XSD + 'decimal', XSD + 'double', XSD + 'float', XSD + 'nonNegativeInteger', XSD + 'positiveInteger'].indexOf(datatype) === -1) return;
      var value = Number(quad.object.value);
      if (!isFinite(value)) return;
      (groups[quad.predicate.value] || (groups[quad.predicate.value] = [])).push({ quad: quad, value: value });
    });
    return Object.keys(groups).map(function (predicate) { return { predicate: predicate, values: groups[predicate] }; }).sort(function (a, b) { return b.values.length - a.values.length; });
  }
  return {
    id: 'statistics', title: 'Charts', priority: 730,
    detect: function (index) { var found = series(index); return { useful: found.some(function (item) { return item.values.length > 1; }) || index.entitiesOfType([QB + 'DataSet', QB + 'Observation']).length > 0, count: found.reduce(function (sum, item) { return sum + item.values.length; }, 0) }; },
    render: function (index) {
      var found = series(index).filter(function (item) { return item.values.length > 1; }).slice(0, 6);
      if (!found.length) return '<p class="view-note">A Data Cube was detected, but no repeated numeric property is available in the loaded scope.</p>';
      return '<div class="chart-list">' + found.map(function (item) {
        var max = Math.max.apply(null, item.values.map(function (entry) { return Math.abs(entry.value); }).concat([1]));
        return '<section><h3>' + esc(index.compact(item.predicate)) + '</h3><div class="bar-chart">' + item.values.slice(0, 50).map(function (entry) {
          var width = Math.max(1, Math.abs(entry.value) / max * 100);
          return entry.quad.subject.termType === 'NamedNode' ? '<button type="button" data-entity="' + esc(termKey(entry.quad.subject)) + '" title="' + esc(index.label(entry.quad.subject) + ': ' + entry.value) + '"><span style="width:' + width.toFixed(2) + '%"></span><b>' + esc(index.label(entry.quad.subject)) + '</b><em>' + esc(entry.value) + '</em></button>' : '<div class="bar-row inert"><span style="width:' + width.toFixed(2) + '%"></span><b>' + esc(blankNodeId(entry.quad.subject)) + '</b><em>' + esc(entry.value) + '</em></div>';
        }).join('') + '</div></section>';
      }).join('') + '</div><p class="view-note">Bars show raw loaded values; no aggregation or unit conversion has been applied.</p>';
    }
  };
}

// A canvas's "main" image is the one from its painting-motivated
// annotation (https://iiif.io/api/presentation/3.0/#57-motivation, and the
// IIIF-specific "painting" term registered alongside the Web Annotation
// ones) -- other annotation pages on the same canvas (transcriptions,
// tags, commentary, ...) can carry non-image bodies (e.g. a Web Annotation
// TextualBody, always a blank node) that must not be picked up as if they
// were the canvas's picture.
var PAINTING_MOTIVATIONS = [IIIF + 'painting', OA + 'painting'];

function iiifModule() {
  var types = [IIIF + 'Manifest', IIIF + 'Canvas', IIIF + 'Range', IIIF + 'AnnotationPage', OA + 'Annotation'];
  function resources(index) { return index.entitiesOfType(types); }
  function imageForCanvas(index, canvas) {
    var pages = index.listValues(canvas, AS + 'items');
    var fallback = null;
    for (var i = 0; i < pages.length; i++) {
      var page = index.entity(pages[i]);
      var annotations = page ? index.listValues(page, AS + 'items') : [];
      for (var j = 0; j < annotations.length; j++) {
        var annotation = index.entity(annotations[j]);
        if (!annotation) continue;
        var isPainting = index.values(annotation, OA + 'motivatedBy').some(function (m) { return PAINTING_MOTIVATIONS.indexOf(m.value) !== -1; });
        var bodies = index.values(annotation, OA + 'hasBody');
        for (var k = 0; k < bodies.length; k++) {
          var url = mediaUrl(index, bodies[k]);
          if (!url) continue;
          if (isPainting) return { url: url, annotation: annotation };
          if (!fallback) fallback = { url: url, annotation: annotation };
        }
      }
    }
    return fallback;
  }

  // A Range (https://iiif.io/api/presentation/3.0/#54-range) groups canvases
  // into a meaningful table of contents -- for a hinged polyptych like this
  // one, typically one top-level Range per physical state (open/closed),
  // each further broken down into wings and individual panels. Rendered as
  // a tree, reusing taxonomyModule's own structure/styling, since it's the
  // same "possibly deep, possibly cyclic tree of typed nodes" shape.
  function ranges(index) { return index.entitiesOfType(IIIF + 'Range'); }
  function rangeChildren(index, range) { return index.listValues(range, AS + 'items'); }
  function rangeTreeHtml(index, range, seen, depth) {
    var key = termKey(range.term);
    if (seen[key]) return '<li>' + esc(index.label(range)) + ' <span class="warning-badge">cycle</span></li>';
    if (depth > 10) return '<li>' + esc(index.label(range)) + ' …</li>';
    var nextSeen = Object.assign({}, seen); nextSeen[key] = true;
    var childrenHtml = rangeChildren(index, range).map(function (childTerm) {
      var child = index.entity(childTerm);
      if (child && index.hasType(child, IIIF + 'Range')) return rangeTreeHtml(index, child, nextSeen, depth + 1);
      return '<li>' + termHtml(index, childTerm) + '</li>';
    }).join('');
    return '<li>' + termHtml(index, range.term) + (childrenHtml ? '<ul>' + childrenHtml + '</ul>' : '') + '</li>';
  }
  function structuresHtml(index) {
    var found = ranges(index);
    if (!found.length) return '';
    var childKeys = {};
    found.forEach(function (range) { rangeChildren(index, range).forEach(function (child) { childKeys[termKey(child)] = true; }); });
    var roots = found.filter(function (range) { return !childKeys[termKey(range.term)]; });
    if (!roots.length) roots = found;
    return '<div class="iiif-structures"><h3>Structure</h3><div class="taxonomy"><ul>' + roots.map(function (r) { return rangeTreeHtml(index, r, {}, 0); }).join('') + '</ul></div></div>';
  }

  return {
    id: 'iiif', title: 'IIIF Presentation', priority: 980,
    detect: function (index) { var found = resources(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index) {
      var manifests = index.entitiesOfType(IIIF + 'Manifest');
      // The manifest's own items list gives canvases in their true,
      // authored order; entitiesOfType() falls back to whatever order the
      // RDF happened to stream in when no manifest is in scope (e.g. a
      // single canvas fetched on its own).
      var orderedCanvases = manifests.length ? index.listValues(manifests[0], AS + 'items').map(function (term) { return index.entity(term); }).filter(function (entity) { return entity && index.hasType(entity, IIIF + 'Canvas'); }) : [];
      var canvases = orderedCanvases.length ? orderedCanvases : index.entitiesOfType(IIIF + 'Canvas');
      var annotations = index.entitiesOfType(OA + 'Annotation');
      return '<div class="presentation-heading">' + (manifests.length ? manifests.map(function (manifest) { return '<h3>' + esc(index.label(manifest)) + '</h3>'; }).join('') : '<h3>IIIF presentation</h3>') + '<span>' + canvases.length + ' canvas' + (canvases.length === 1 ? '' : 'es') + '</span></div>' +
        structuresHtml(index) +
        '<div class="canvas-strip">' + canvases.map(function (canvas, position) {
          var image = imageForCanvas(index, canvas);
          return '<figure' + selectAttr(canvas.term) + '><div class="canvas-image">' + (image ? '<img src="' + esc(image.url) + '" alt="' + esc(index.label(canvas)) + '" loading="lazy" referrerpolicy="no-referrer">' : '<div class="image-unavailable">No supported painting image found</div>') + '</div><figcaption><b>' + (position + 1) + '</b> ' + esc(index.label(canvas)) + (image && image.annotation ? '<span>1 loaded annotation</span>' : '') + '</figcaption></figure>';
        }).join('') + '</div>' + (annotations.length ? '<div class="annotation-list"><h3>Loaded annotations</h3>' + annotations.map(function (annotation) {
          var targets = index.values(annotation, OA + 'hasTarget');
          var bodies = index.values(annotation, OA + 'hasBody');
          var motivations = index.values(annotation, OA + 'motivatedBy');
          return '<article' + selectAttr(annotation.term) + '><h4>' + esc(index.label(annotation)) + '</h4>' +
            (targets.length ? '<p><b>Target</b> ' + targets.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
            (bodies.length ? '<p><b>Body</b> ' + bodies.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') +
            (motivations.length ? '<p><b>Motivation</b> ' + motivations.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '') + '</article>';
        }).join('') + '</div>' : '') + '<p class="view-note">' + (orderedCanvases.length ? 'Canvas order follows the manifest’s own items list.' : 'Canvas order follows whatever order the loaded RDF happened to stream in -- no manifest is in the current scope to read the authored order from.') + '</p>';
    }
  };
}

function mappingsModule() {
  var types = [RR + 'TriplesMap', RML + 'TriplesMap', SSSOM + 'Mapping'];
  return cardsModule('mappings', 'Mappings', types, [
    { label: 'Logical source', predicates: [RML + 'logicalSource', RR + 'logicalTable'] },
    { label: 'Subject map', predicates: [RR + 'subjectMap'] },
    { label: 'Source', predicates: [SSSOM + 'subject_id'] },
    { label: 'Target', predicates: [SSSOM + 'object_id'] },
    { label: 'Predicate', predicates: [SSSOM + 'predicate_id'] }
  ], 705);
}

function datasetProfileModule() {
  function ranked(map, labeler, limit) {
    return Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, limit).map(function (item) {
      return '<li><span>' + esc(labeler(item[0])) + '</span><b>' + item[1] + '</b></li>';
    }).join('');
  }
  return {
    id: 'overview', title: 'Overview', priority: 660,
    detect: function (index) { return { useful: index.quads.length > 0 }; },
    render: function (index) {
      var types = new Map();
      var datatypes = new Map();
      var languages = new Map();
      index.quads.forEach(function (quad) {
        if (quad.predicate.value === RDF + 'type') types.set(quad.object.value, (types.get(quad.object.value) || 0) + 1);
        if (quad.object.termType === 'Literal') {
          var datatype = quad.object.datatype && quad.object.datatype.value;
          if (datatype) datatypes.set(datatype, (datatypes.get(datatype) || 0) + 1);
          if (quad.object.language) languages.set(quad.object.language, (languages.get(quad.object.language) || 0) + 1);
        }
      });
      var predicates = new Map();
      index.predicates.forEach(function (quads, predicate) { predicates.set(predicate, quads.length); });
      return '<div class="dataset-profile-grid"><section><h3>Classes</h3><ol>' + ranked(types, function (value) { return index.compact(value); }, 12) + '</ol></section>' +
        '<section><h3>Properties</h3><ol>' + ranked(predicates, function (value) { return index.compact(value); }, 12) + '</ol></section>' +
        '<section><h3>Literal datatypes</h3><ol>' + ranked(datatypes, function (value) { return index.compact(value); }, 12) + '</ol></section>' +
        '<section><h3>Languages</h3>' + (languages.size ? '<ol>' + ranked(languages, function (value) { return value; }, 12) + '</ol>' : '<p class="view-note">No language-tagged literals in this scope.</p>') + '</section></div>';
    }
  };
}

function relationshipModule() {
  function links(index) { return index.quads.filter(function (quad) { return quad.object.termType !== 'Literal'; }); }
  return {
    id: 'relationships', title: 'Relationships', priority: 670,
    detect: function (index) { var found = links(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var selected = index.entity(state.entity);
      if (!selected) {
        selected = Array.from(index.entities.values()).sort(function (a, b) {
          return (b.quads.length + (index.incoming.get(termKey(b.term)) || []).length) - (a.quads.length + (index.incoming.get(termKey(a.term)) || []).length);
        })[0];
      }
      var outgoing = selected ? selected.quads.filter(function (quad) { return quad.object.termType !== 'Literal'; }) : [];
      var incoming = selected ? (index.incoming.get(termKey(selected.term)) || []) : [];
      function rows(quads, incomingDirection) {
        return quads.slice(0, 100).map(function (quad) {
          var other = incomingDirection ? quad.subject : quad.object;
          return '<li><span>' + esc(index.compact(quad.predicate.value)) + '</span>' + termHtml(index, other) + '</li>';
        }).join('') || '<li class="empty-relation">None in the loaded scope</li>';
      }
      return '<div class="relationship-focus"><p>Focused entity</p><h3>' + (selected ? termHtml(index, selected.term) : 'No linked entity') + '</h3></div><div class="relationship-columns"><section><h3>Incoming</h3><ul>' + rows(incoming, true) + '</ul></section><section><h3>Outgoing</h3><ul>' + rows(outgoing, false) + '</ul></section></div><p class="view-note">Select any linked entity to expand one neighborhood at a time.</p>';
    }
  };
}

function cardsModule(id, title, types, fields, priority) {
  return {
    id: id, title: title, priority: priority,
    detect: function (index) { var found = index.entitiesOfType(types); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = index.entitiesOfType(types).filter(function (entity) { return !state.filter || index.searchable(entity).indexOf(state.filter.toLowerCase()) !== -1; });
      return '<div class="domain-card-grid">' + found.map(function (entity) {
        var rows = fields.map(function (field) {
          var values = index.values(entity, field.predicates);
          return values.length ? '<p><b>' + esc(field.label) + '</b> ' + values.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : '';
        }).join('');
        return '<article' + selectAttr(entity.term) + '><h3>' + esc(index.label(entity)) + '</h3>' + rows + '</article>';
      }).join('') + '</div>';
    }
  };
}

// Hydra templates use RFC 6570. The advertised search forms encountered by
// the playground use simple, reserved, query, and query-continuation
// expressions; keeping expansion local also lets the user inspect the final
// URL before the normal fetch pipeline follows it.
function expandHydraTemplate(template, values) {
  values = values || {};
  return String(template || '').replace(/\{([+?&]?)([^}]+)\}/g, function (expression, operator, names) {
    var pairs = names.split(',').map(function (name) { return name.replace(/\*$/, ''); }).filter(function (name) {
      return Object.prototype.hasOwnProperty.call(values, name) && String(values[name]).length > 0;
    });
    if (operator === '?' || operator === '&') {
      if (!pairs.length) return '';
      return (operator === '?' ? '?' : '&') + pairs.map(function (name) { return encodeURIComponent(name) + '=' + encodeURIComponent(values[name]); }).join('&');
    }
    return pairs.map(function (name) { return operator === '+' ? encodeURI(String(values[name])) : encodeURIComponent(values[name]); }).join(',');
  });
}

function hypermediaModule() {
  var types = [LDES + 'EventStream', HYDRA + 'Collection', HYDRA + 'ApiDocumentation', TREE + 'Collection', TREE + 'Node', 'http://rdfs.org/ns/void#Dataset'];
  var controlPredicates = [TREE + 'view', TREE + 'relation', TREE + 'node', TREE + 'member', HYDRA + 'search', HYDRA + 'template', HYDRA + 'next'];
  function resources(index) {
    var found = index.entitiesOfType(types);
    index.quads.forEach(function (quad) {
      if (controlPredicates.indexOf(quad.predicate.value) === -1) return;
      var entity = index.entity(quad.subject);
      if (entity && found.indexOf(entity) === -1) found.push(entity);
    });
    return found;
  }
  function loadLink(index, term, label) {
    var url = term && term.termType === 'NamedNode' ? safeUrl(term.value) : '';
    return url ? '<span class="hypermedia-link"><button type="button" class="action-button secondary" data-load-url="' + esc(url) + '">' + esc(label || 'Load') + '</button><a href="' + esc(url) + '" target="_blank" rel="noopener" title="Open in a new tab">↗</a></span>' : termHtml(index, term);
  }
  return {
    id: 'hypermedia', title: 'Hypermedia controls', priority: 900,
    detect: function (index) { var found = resources(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index, state) {
      var found = resources(index).filter(function (entity) { return !state.filter || index.searchable(entity).indexOf(state.filter.toLowerCase()) !== -1; });
      return '<div class="hypermedia-list">' + found.map(function (entity) {
        var views = index.values(entity, [TREE + 'view', HYDRA + 'next']);
        var members = index.values(entity, [TREE + 'member', HYDRA + 'member']);
        var relations = index.values(entity, TREE + 'relation');
        var searches = index.values(entity, HYDRA + 'search');
        var metadata = [
          { label: 'Timestamp path', values: index.values(entity, LDES + 'timestampPath') },
          { label: 'Version path', values: index.values(entity, LDES + 'versionOfPath') },
          { label: 'Shape', values: index.values(entity, TREE + 'shape') }
        ].map(function (row) { return row.values.length ? '<p><b>' + row.label + '</b> ' + row.values.map(function (term) { return termHtml(index, term); }).join(', ') + '</p>' : ''; }).join('');
        var relationHtml = relations.map(function (relationTerm) {
          var relation = index.entity(relationTerm);
          if (!relation) return '<li>' + termHtml(index, relationTerm) + '</li>';
          var node = index.values(relation, TREE + 'node')[0];
          var path = index.values(relation, TREE + 'path')[0];
          var value = index.values(relation, TREE + 'value')[0];
          var relationType = index.values(relation, RDF + 'type')[0];
          return '<li><div><b>' + esc(relationType ? index.label(relationType) : 'TREE relation') + '</b>' + (path ? '<span>' + esc(index.label(path)) + '</span>' : '') + (value ? '<span>' + esc(value.value) + '</span>' : '') + '</div>' + (node ? loadLink(index, node, 'Load page') : termHtml(index, relationTerm)) + '</li>';
        }).join('');
        var searchHtml = searches.map(function (searchTerm) {
          var search = index.entity(searchTerm);
          var template = search && index.values(search, HYDRA + 'template')[0];
          var mappings = search ? index.values(search, HYDRA + 'mapping') : [];
          if (!template || template.termType !== 'Literal') return '<div class="hydra-template"><p class="view-note">This search control has no loaded literal Hydra template.</p>' + termHtml(index, searchTerm) + '</div>';
          var fields = mappings.map(function (mappingTerm) {
            var mapping = index.entity(mappingTerm);
            var variable = mapping && index.values(mapping, HYDRA + 'variable')[0];
            var property = mapping && index.values(mapping, HYDRA + 'property')[0];
            var required = mapping && index.values(mapping, HYDRA + 'required')[0];
            return variable ? { variable: variable.value, property: property, required: required && ['true', '1'].indexOf(required.value) !== -1 } : null;
          }).filter(Boolean);
          var seenVariables = {};
          fields.forEach(function (field) { seenVariables[field.variable] = true; });
          String(template.value).replace(/\{[+?&]?([^}]+)\}/g, function (_, names) {
            names.split(',').map(function (name) { return name.replace(/\*$/, ''); }).forEach(function (variable) {
              if (!seenVariables[variable]) { fields.push({ variable: variable, property: null, required: false }); seenVariables[variable] = true; }
            });
            return _;
          });
          return '<form class="hydra-template hydra-search-form" data-hydra-search data-template="' + esc(template.value) + '"><code>' + esc(template.value) + '</code><div class="hydra-search-fields">' + fields.map(function (field) {
            var label = field.property ? index.label(field.property) : field.variable;
            var hint = field.property ? index.compact(field.property.value) : field.variable;
            return '<label><span>' + esc(label) + (field.required ? ' <b aria-label="required">*</b>' : '') + '</span><input type="text" name="' + esc(field.variable) + '" autocomplete="off" placeholder="' + esc(hint) + '"' + (field.required ? ' required' : '') + '><small>Template variable: ' + esc(field.variable) + '</small></label>';
          }).join('') + '</div><div class="hydra-search-actions"><button type="submit" class="action-button">Search</button><span role="status" data-hydra-search-status></span></div></form>';
        }).join('');
        return '<article' + selectAttr(entity.term) + '><h3>' + esc(index.label(entity)) + '</h3>' + metadata +
          (views.length ? '<div class="hypermedia-actions"><b>Entry points</b>' + views.map(function (term) { return loadLink(index, term, 'Load'); }).join('') + '</div>' : '') +
          (members.length ? '<p><b>Loaded members</b> ' + members.length + '</p>' : '') +
          (relationHtml ? '<details open><summary>' + relations.length + ' TREE relation' + (relations.length === 1 ? '' : 's') + '</summary><ul class="relation-controls">' + relationHtml + '</ul></details>' : '') + searchHtml + '</article>';
      }).join('') + '</div><p class="view-note">Loading a control replaces the current source. The original RDF remains recoverable with browser Back.</p>';
    }
  };
}

// RDF-Connect (https://rdf-connect.github.io/specification/) describes data
// pipelines as processors wired together by channels. A channel is one
// entity with both a conn:reader and a conn:writer value (the newer
// rdf-connect# ontology and the older conn#/conn/js# "js-runner" ontology
// both follow this shape): whatever a processor writes to the writer side
// of a channel arrives on the reader side. Concrete channel *endpoint*
// types (js:JsReaderChannel, :HttpWriterChannel, rdfc:Reader, ...) are
// recognized by name -- ending in "ReaderChannel"/"WriterChannel", or being
// exactly rdfc:Reader/rdfc:Writer -- rather than by relying on the
// rdfs:subClassOf hierarchy from the processor packages' own ontology
// files, which are only ever referenced via owl:imports, never actually
// fetched and merged into the loaded graph.
var RDFC = 'https://w3id.org/rdf-connect#';
var CONN = 'https://w3id.org/conn#';

function channelDirection(index, term) {
  if (!term) return null;
  var entity = index.entity(term);
  if (!entity) return null;
  var types = index.values(entity, RDF + 'type').map(function (t) { return t.value; });
  if (types.indexOf(RDFC + 'Reader') !== -1 || types.some(function (t) { return /ReaderChannel$/i.test(t); })) return 'in';
  if (types.indexOf(RDFC + 'Writer') !== -1 || types.some(function (t) { return /WriterChannel$/i.test(t); })) return 'out';
  return null;
}

function pipelineChannelLinks(index) {
  var links = [];
  index.entities.forEach(function (entity) {
    var readers = index.values(entity, CONN + 'reader');
    var writers = index.values(entity, CONN + 'writer');
    if (!readers.length || !writers.length) return;
    readers.forEach(function (reader) {
      writers.forEach(function (writer) { links.push({ reader: reader, writer: writer }); });
    });
  });
  return links;
}

// A processor's channel references are often nested a level or two deep
// inside structural configuration blank nodes (e.g. js:rmlSource [
// js:input <x> ]), not just directly on the processor itself -- walk blank-
// node property values to find them, stopping at channel resources
// themselves and bounding revisits for safety against cycles.
function collectChannelRefs(index, entity, refs, seen, depth) {
  if (!entity || depth > 5 || seen[termKey(entity.term)]) return;
  seen[termKey(entity.term)] = true;
  entity.properties.forEach(function (terms, predicate) {
    terms.forEach(function (term) {
      var direction = channelDirection(index, term);
      if (direction) {
        refs.push({ predicate: predicate, term: term, direction: direction });
      } else if (term.termType === 'BlankNode') {
        var nested = index.entity(term);
        if (nested) collectChannelRefs(index, nested, refs, seen, depth + 1);
      }
    });
  });
}

// A processor is any entity (usually a blank node) that isn't itself a
// channel endpoint or a reader/writer link, but references at least one
// channel somewhere in its own (possibly nested) properties. A blank node
// that's itself the value of some other entity's property (e.g. the
// js:rmlSource [ js:input <x> ] blocks nested under a js:RMLMapperReader)
// is nested configuration owned by that other entity, not an independent
// pipeline stage -- collectChannelRefs already attributes its channels to
// the owning processor, so counting it again here would double them up.
function pipelineProcessors(index) {
  var linkKeys = {};
  index.entities.forEach(function (entity) {
    if (index.values(entity, CONN + 'reader').length && index.values(entity, CONN + 'writer').length) linkKeys[termKey(entity.term)] = true;
  });
  var found = [];
  index.entities.forEach(function (entity) {
    if (channelDirection(index, entity.term) || linkKeys[termKey(entity.term)]) return;
    if (entity.term.termType === 'BlankNode' && (index.incoming.get(termKey(entity.term)) || []).length) return;
    var refs = [];
    collectChannelRefs(index, entity, refs, {}, 0);
    if (refs.length) found.push({ entity: entity, refs: refs });
  });
  return found;
}

// Channel names are usually relative URLs resolved against the pipeline
// document's own location (<rml/reader>, <yarrrml/versioned/writer>, ...),
// so they all share one long, uninformative absolute-URL prefix -- index.
// compact() alone would cut each down to just its very last path segment
// ("reader"/"writer"), losing exactly the part that distinguishes one
// channel from another. Instead, find the longest prefix shared by every
// channel term actually seen in this graph and strip that (plus the
// trailing "/reader" or "/writer"), which works regardless of whether the
// source uses relative or absolute channel URLs.
function makeChannelLabeler(index, terms) {
  var values = uniqueTerms(terms).map(function (t) { return t.value; });
  var cutIndex = 0;
  if (values.length > 1) {
    var prefixLength = values[0].length;
    for (var i = 1; i < values.length && prefixLength > 0; i++) {
      var other = values[i];
      var max = Math.min(prefixLength, other.length);
      var j = 0;
      while (j < max && values[0][j] === other[j]) j++;
      prefixLength = j;
    }
    var cut = Math.max(values[0].lastIndexOf('/', prefixLength - 1), values[0].lastIndexOf('#', prefixLength - 1));
    cutIndex = cut === -1 ? 0 : cut + 1;
  }
  return function (term) {
    var label = term.value.slice(cutIndex).replace(/\/(reader|writer)$/i, '');
    return label || index.compact(term.value);
  };
}

// Builds the processor graph: one edge per (producer, channel, consumer)
// triple resolved through a conn:reader/conn:writer link, plus one edge per
// channel referenced directly by a processor but never resolved that way
// (e.g. a bare FileReaderChannel reading a static file) -- these represent
// the pipeline's own external boundaries, grouped by channel so several
// processors sharing one external channel share one edge target too. Every
// edge carries the raw channel term rather than a precomputed label, since
// the readable label depends on every channel term in the graph (see
// makeChannelLabeler) and so can only be computed once the whole graph is known.
function pipelineGraph(index) {
  var processors = pipelineProcessors(index);
  var edges = [];
  var resolvedChannelKeys = {};

  function byChannel(direction, channelTerm) {
    var channelKey = termKey(channelTerm);
    return processors.filter(function (p) {
      return p.refs.some(function (ref) { return ref.direction === direction && termKey(ref.term) === channelKey; });
    });
  }

  pipelineChannelLinks(index).forEach(function (link) {
    resolvedChannelKeys[termKey(link.reader)] = true;
    resolvedChannelKeys[termKey(link.writer)] = true;
    var consumers = byChannel('in', link.reader);
    var producers = byChannel('out', link.writer);
    if (!consumers.length && !producers.length) return;
    if (producers.length && consumers.length) {
      producers.forEach(function (producer) {
        consumers.forEach(function (consumer) { edges.push({ from: producer, to: consumer, channel: link.reader }); });
      });
    } else if (producers.length) {
      producers.forEach(function (producer) { edges.push({ from: producer, to: null, channel: link.reader }); });
    } else {
      consumers.forEach(function (consumer) { edges.push({ from: null, to: consumer, channel: link.writer }); });
    }
  });

  var externalByChannel = {};
  processors.forEach(function (p) {
    p.refs.forEach(function (ref) {
      var key = termKey(ref.term);
      if (resolvedChannelKeys[key]) return;
      (externalByChannel[key] || (externalByChannel[key] = { term: ref.term, direction: ref.direction, processors: [] })).processors.push(p);
    });
  });
  Object.keys(externalByChannel).forEach(function (key) {
    var external = externalByChannel[key];
    external.processors.forEach(function (p) {
      if (external.direction === 'in') edges.push({ from: null, to: p, channel: external.term });
      else edges.push({ from: p, to: null, channel: external.term });
    });
  });

  return { processors: processors, edges: edges };
}

function processorTypeLabel(index, entity) {
  var types = index.values(entity, RDF + 'type').map(function (t) { return index.compact(t.value); });
  return types.join(', ') || 'Processor';
}

// Renders the flow as an SVG: one box per processor plus one per distinct
// external channel, laid out left to right by topological depth (computed
// from the resolved producer→consumer edges only) and stacked top to
// bottom within each column -- the same "compute coordinates directly,
// no DOM measurement pass" approach timeSeriesModule uses.
function pipelineDiagramSvg(index, processors, edges, label) {
  var NODE_W = 172, NODE_H = 52, COL_GAP = 70, ROW_GAP = 18, MARGIN = 22;
  var resolvedEdges = edges.filter(function (e) { return e.from && e.to; });
  var depths = new Map();
  function resolveDepth(p, seen) {
    if (depths.has(p)) return depths.get(p);
    if (seen.has(p)) return 0;
    seen.add(p);
    var preds = resolvedEdges.filter(function (e) { return e.to === p; }).map(function (e) { return e.from; });
    var d = preds.length ? 1 + Math.max.apply(null, preds.map(function (pred) { return resolveDepth(pred, seen); })) : 0;
    depths.set(p, d);
    return d;
  }
  processors.forEach(function (p) { resolveDepth(p, new Set()); });

  var nodes = [];
  var nodeByProcessor = new Map();
  processors.forEach(function (p) {
    var typeLabel = processorTypeLabel(index, p.entity);
    var rawLabel = index.label(p.entity);
    // index.label() falls back to the entity's own rdf:type when it has no
    // real naming property (see DatasetIndex.prototype.label) -- the same
    // fallback processorTypeLabel() already computes directly, so only
    // treat it as a distinct, second line of text when it isn't just that.
    var node = {
      kind: 'processor', depth: depths.get(p) || 0, term: p.entity.term,
      typeLabel: typeLabel,
      label: rawLabel && rawLabel !== p.entity.term.value && rawLabel !== typeLabel ? rawLabel : ''
    };
    nodes.push(node);
    nodeByProcessor.set(p, node);
  });
  var externalNodes = new Map();
  edges.forEach(function (edge) {
    if (edge.from && edge.to) return;
    var channelKey = termKey(edge.channel);
    if (externalNodes.has(channelKey)) return;
    var anchor = edge.from ? nodeByProcessor.get(edge.from) : nodeByProcessor.get(edge.to);
    var node = { kind: 'external', depth: edge.from ? anchor.depth + 1 : Math.max(0, anchor.depth - 1), term: edge.channel, label: label(edge.channel) };
    externalNodes.set(channelKey, node);
    nodes.push(node);
  });

  var minDepth = Math.min.apply(null, nodes.map(function (n) { return n.depth; }).concat([0]));
  var columns = {};
  nodes.forEach(function (n) {
    n.column = n.depth - minDepth;
    (columns[n.column] || (columns[n.column] = [])).push(n);
  });
  Object.keys(columns).forEach(function (col) { columns[col].forEach(function (n, row) { n.row = row; }); });
  var columnCount = Math.max.apply(null, nodes.map(function (n) { return n.column; }).concat([0])) + 1;
  var maxRows = Math.max.apply(null, Object.keys(columns).map(function (col) { return columns[col].length; }).concat([1]));
  nodes.forEach(function (n) {
    n.x = MARGIN + n.column * (NODE_W + COL_GAP);
    n.y = MARGIN + n.row * (NODE_H + ROW_GAP);
  });
  var width = MARGIN * 2 + columnCount * NODE_W + Math.max(0, columnCount - 1) * COL_GAP;
  var height = MARGIN * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

  function anchorFor(edge, end) {
    if (end === 'from') return edge.from ? nodeByProcessor.get(edge.from) : externalNodes.get(termKey(edge.channel));
    return edge.to ? nodeByProcessor.get(edge.to) : externalNodes.get(termKey(edge.channel));
  }

  var edgeSvg = edges.map(function (edge) {
    var fromNode = anchorFor(edge, 'from'), toNode = anchorFor(edge, 'to');
    if (!fromNode || !toNode) return '';
    var start = { x: fromNode.x + NODE_W, y: fromNode.y + NODE_H / 2 };
    var end = { x: toNode.x, y: toNode.y + NODE_H / 2 };
    var midX = (start.x + end.x) / 2;
    var path = 'M' + start.x.toFixed(1) + ',' + start.y.toFixed(1) + ' C' + midX.toFixed(1) + ',' + start.y.toFixed(1) + ' ' + midX.toFixed(1) + ',' + end.y.toFixed(1) + ' ' + end.x.toFixed(1) + ',' + end.y.toFixed(1);
    return '<path class="pipeline-edge" d="' + path + '" marker-end="url(#pipeline-arrow)"></path>' +
      '<text class="pipeline-edge-label" x="' + midX.toFixed(1) + '" y="' + ((start.y + end.y) / 2 - 5).toFixed(1) + '">' + esc(label(edge.channel)) + '</text>';
  }).join('');

  var nodeSvg = nodes.map(function (node) {
    if (node.kind === 'processor') {
      return '<g class="pipeline-node processor" tabindex="0" role="button" data-entity="' + esc(termKey(node.term)) + '" transform="translate(' + node.x.toFixed(1) + ',' + node.y.toFixed(1) + ')"><title>' + esc(node.term.value) + '</title>' +
        '<rect width="' + NODE_W + '" height="' + NODE_H + '" rx="8"></rect>' +
        '<text class="pipeline-node-type" x="10" y="' + (node.label ? 21 : 30) + '">' + esc(node.typeLabel) + '</text>' +
        (node.label ? '<text class="pipeline-node-label" x="10" y="39">' + esc(node.label) + '</text>' : '') + '</g>';
    }
    return '<g class="pipeline-node external" transform="translate(' + node.x.toFixed(1) + ',' + node.y.toFixed(1) + ')"><title>' + esc(node.term.value) + '</title>' +
      '<rect width="' + NODE_W + '" height="' + NODE_H + '" rx="26"></rect>' +
      '<text class="pipeline-node-label" x="' + (NODE_W / 2) + '" y="' + (NODE_H / 2 + 4) + '" text-anchor="middle">' + esc(node.label || 'external') + '</text></g>';
  }).join('');

  return '<svg class="pipeline-diagram" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Pipeline flow diagram">' +
    '<defs><marker id="pipeline-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker></defs>' +
    edgeSvg + nodeSvg + '</svg>';
}

// A simple clickable reference to another processor, styled like any other
// inline entity link -- termHtml() isn't used here because for a blank-node
// processor (the common case) it would inline that processor's entire
// bounded nested description, not a short reference to it.
function processorRefHtml(index, processorEntry) {
  return '<button type="button" class="entity-link"' + selectAttr(processorEntry.entity.term, 'data-entity') + '>' + esc(processorTypeLabel(index, processorEntry.entity)) + '</button>';
}

function pipelineCards(index, processors, edges, label) {
  function endpointHtml(other, channel) {
    return '<li><span>' + esc(label(channel)) + '</span>' + (other ? processorRefHtml(index, other) : '<span class="pipeline-external">external</span>') + '</li>';
  }
  return '<div class="pipeline-list">' + processors.map(function (p) {
    var incoming = edges.filter(function (e) { return e.to === p; });
    var outgoing = edges.filter(function (e) { return e.from === p; });
    return '<article' + selectAttr(p.entity.term) + '><h3>' + esc(processorTypeLabel(index, p.entity)) + '</h3>' +
      (incoming.length ? '<div class="pipeline-io"><b>Reads from</b><ul>' + incoming.map(function (e) { return endpointHtml(e.from, e.channel); }).join('') + '</ul></div>' : '') +
      (outgoing.length ? '<div class="pipeline-io"><b>Writes to</b><ul>' + outgoing.map(function (e) { return endpointHtml(e.to, e.channel); }).join('') + '</ul></div>' : '') +
      '</article>';
  }).join('') + '</div>';
}

function pipelineModule() {
  return {
    id: 'pipeline', title: 'Pipeline', priority: 890,
    detect: function (index) { var found = pipelineProcessors(index); return { useful: found.length > 0, count: found.length }; },
    render: function (index) {
      var graph = pipelineGraph(index);
      var label = makeChannelLabeler(index, graph.edges.map(function (e) { return e.channel; }));
      return pipelineDiagramSvg(index, graph.processors, graph.edges, label) +
        pipelineCards(index, graph.processors, graph.edges, label) +
        '<p class="view-note">Channel names are shortened to what distinguishes them from one another, and only reflect what this snapshot resolved -- an unresolved input/output is shown as "external" rather than assumed to be a pipeline boundary by design.</p>';
    }
  };
}

function createRegistry() {
  return [
    overviewModule(), profilesModule(), imagesModule(), shaclModule(), formPreviewModule(), credentialsModule(),
    geographyModule(), timeSeriesModule(), taxonomyModule(), ontologyModule(), temporalModule(), statisticsModule(), mappingsModule(),
    cardsModule('datasets', 'Data catalog', [DCAT + 'Catalog', DCAT + 'Dataset', DCAT + 'Distribution'], [
      { label: 'Publisher', predicates: ['http://purl.org/dc/terms/publisher'] },
      { label: 'Description', predicates: ['http://purl.org/dc/terms/description'] },
      { label: 'Distribution', predicates: [DCAT + 'distribution'] },
      { label: 'Access', predicates: [DCAT + 'accessURL', DCAT + 'downloadURL'] }
    ], 720),
    cardsModule('sensors', 'Sensors', [SOSA + 'Sensor', SOSA + 'Observation', SOSA + 'Platform'], [
      { label: 'Observed property', predicates: [SOSA + 'observedProperty'] },
      { label: 'Feature', predicates: [SOSA + 'hasFeatureOfInterest'] },
      { label: 'Result', predicates: [SOSA + 'hasSimpleResult', SOSA + 'hasResult'] },
      { label: 'Time', predicates: [SOSA + 'resultTime', SOSA + 'phenomenonTime'] }
    ], 710),
    cardsModule('provenance', 'Provenance', [PROV + 'Entity', PROV + 'Activity', PROV + 'Agent'], [
      { label: 'Used', predicates: [PROV + 'used'] },
      { label: 'Generated', predicates: [PROV + 'wasGeneratedBy', PROV + 'generated'] },
      { label: 'Attributed to', predicates: [PROV + 'wasAttributedTo', PROV + 'wasAssociatedWith'] }
    ], 690),
    hypermediaModule(), pipelineModule(),
    cardsModule('organizations', 'Organizations', [ORG + 'Organization', ORG + 'OrganizationalUnit', ORG + 'Membership', ORG + 'Post'], [
      { label: 'Organization', predicates: [ORG + 'organization', ORG + 'unitOf'] },
      { label: 'Member', predicates: [ORG + 'member'] },
      { label: 'Role', predicates: [ORG + 'role'] },
      { label: 'Sub-organization', predicates: [ORG + 'hasSubOrganization'] }
    ], 675),
    iiifModule(), relationshipModule(), datasetProfileModule()
  ];
}

function detectAvailable(index, registry) {
  return (registry || createRegistry()).map(function (module) {
    var result;
    try { result = module.detect(index) || {}; } catch (error) { result = { useful: false, error: error }; }
    return { module: module, result: result };
  }).filter(function (item) { return item.result.useful; }).sort(function (a, b) { return (b.module.priority || 0) - (a.module.priority || 0); });
}

function rankViews(available) {
  var ids = available.map(function (item) { return item.module.id; });
  var secondary = ['overview', 'entities', 'relationships', 'profile', 'forms', 'statistics'];
  if (ids.includes('iiif')) secondary.push('images');
  if (ids.includes('credentials')) secondary.push('profiles');
  if (ids.includes('sensors')) secondary.push('timeline');
  if (ids.includes('timeseries')) secondary.push('timeline', 'statistics');
  var primary = available.filter(function (item) { return !secondary.includes(item.module.id); }).slice(0, 4);
  return { primary: primary, more: available.filter(function (item) { return item.module.id !== 'overview' && !primary.includes(item); }) };
}

function createWorkbench(root, options) {
  options = options || {};
  var registry = options.registry || createRegistry();
  var index = new DatasetIndex();
  var allIndex = index;
  var state = { view: '', filter: '', entity: '', graph: '', partial: false, scopeLabel: 'loaded document' };
  var renderTimer = null;
  var disposed = false;
  var visible = false;
  var unmount = null;
  var definitionAbort = null;

  function cleanup() { if (definitionAbort) { definitionAbort.abort(); definitionAbort = null; } if (unmount) { unmount(); unmount = null; } }

  function notify() { if (options.onStateChange) options.onStateChange(getState()); }

  function schedule() {
    if (renderTimer || disposed) return;
    renderTimer = setTimeout(function () { renderTimer = null; render(); }, 120);
  }

  function render() {
    if (disposed) return;
    var available = detectAvailable(index, registry);
    var ranked = rankViews(available);
    if (options.onAvailable) options.onAvailable(ranked.primary.length);
    root.hidden = !visible;
    if (root.hidden) return;
    if (!allIndex.quads.length) {
      cleanup();
      root.querySelector('[data-view-tabs]').innerHTML = '';
      root.querySelector('[data-more-views]').innerHTML = '';
      root.querySelector('[data-view-body]').innerHTML = '<p>No triples in this scope yet.</p>';
      root.querySelector('[data-scope-status]').textContent = state.scopeLabel;
      return;
    }
    var graphField = root.querySelector('[data-graph-field]');
    var graphSelect = root.querySelector('[data-graph-scope]');
    var graphTerms = Array.from(allIndex.graphs.entries());
    graphField.hidden = graphTerms.length === 0;
    graphSelect.innerHTML = '<option value="">All graphs</option>' + graphTerms.map(function (entry) {
      return '<option value="' + esc(entry[0]) + '">' + esc(allIndex.label(entry[1])) + '</option>';
    }).join('');
    graphSelect.value = state.graph;
    var ids = available.map(function (item) { return item.module.id; });
    if (!state.view || ids.indexOf(state.view) === -1) state.view = ranked.primary.length ? ranked.primary[0].module.id : 'overview';
    var active = available.find(function (item) { return item.module.id === state.view; }) || available[0];
    var primary = ranked.primary.slice();
    if (active.module.id !== 'overview' && !primary.includes(active)) primary.push(active);
    var overview = available.find(function (item) { return item.module.id === 'overview'; });
    if (overview) primary.push(overview);
    var tabs = primary.map(function (item) {
      var selected = item.module.id === state.view;
      var count = item.result.count ? '<span>' + item.result.count + '</span>' : '';
      return '<button type="button" role="tab" id="viewer-tab-' + esc(item.module.id) + '" aria-controls="viewer-active-panel" aria-selected="' + selected + '" tabindex="' + (selected ? '0' : '-1') + '" data-view="' + esc(item.module.id) + '">' + esc(item.module.title) + count + '</button>';
    }).join('');
    root.querySelector('[data-view-tabs]').innerHTML = tabs;
    var more = ranked.more.filter(function (item) { return item !== active; });
    root.querySelector('[data-more-views]').innerHTML = more.map(function (item) { return '<button type="button" data-view="' + esc(item.module.id) + '">' + esc(item.module.title) + '</button>'; }).join('');
    root.querySelector('.more-views').hidden = !more.length;
    var graphStatus = state.graph && allIndex.graphs.get(state.graph) ? ' · graph ' + allIndex.label(allIndex.graphs.get(state.graph)) : '';
    root.querySelector('[data-scope-status]').textContent = state.scopeLabel + graphStatus + (state.partial ? ' · loading, results are partial' : ' · complete');
    var body = root.querySelector('[data-view-body]');
    body.id = 'viewer-active-panel';
    body.setAttribute('aria-labelledby', 'viewer-tab-' + active.module.id);
    root.setAttribute('aria-busy', state.partial ? 'true' : 'false');
    var retainedGlobe = active.module.id === 'map' && unmount && unmount.update ? body.querySelector('.globe-view') : null;
    if (!retainedGlobe) cleanup();
    try {
      var html = active.module.render(index, state);
      if (retainedGlobe) {
        var updated = document.createElement('div'); updated.innerHTML = html;
        updated.querySelector('.globe-view').replaceWith(retainedGlobe);
        body.replaceChildren.apply(body, Array.from(updated.childNodes));
        unmount.update(state.mapData);
      } else body.innerHTML = html;
      if (active.module.id === 'map' && !retainedGlobe) {
        var removeMap = geospatial.mount(body.querySelector('[data-globe]'), state.mapData, function (entity) {
          selectEntity(entity);
        }, state.camera, function (camera) { state.camera = camera; notify(); });
        unmount = removeMap;
        unmount.update = removeMap.update;
      }
      if (active.module.id === 'map') {
        if (definitionAbort) definitionAbort.abort();
        var abort = new AbortController(); definitionAbort = abort;
        geospatial.resolveDefinitions(index, abort.signal).then(function (changed) { if (changed && !abort.signal.aborted) render(); });
      }
    }
    catch (error) { body.innerHTML = '<div class="view-error"><h3>This view could not be rendered</h3><p>' + esc(error.message || error) + '</p></div>'; }
    updateInspector();
  }

  function updateInspector() {
    var selectedEntity = index.entity(state.entity);
    root.querySelector('[data-entity-details]').innerHTML = detailsHtml(index, selectedEntity);
    root.querySelector('[data-entity-inspector]').open = !!selectedEntity;
  }

  // Used specifically in response to a user clicking a named node (an
  // inline entity link, a card, a map pin, ...): shows its details and
  // brings the inspector on screen, so a click always has a visible effect
  // even when the panel starts out scrolled out of view. Programmatic
  // selection (restoring a shared #entity=... link, the initial render)
  // goes through plain updateInspector() instead, which doesn't move the
  // page around on its own.
  function selectEntity(entityKey) {
    state.entity = entityKey;
    updateInspector();
    notify();
    var inspector = root.querySelector('[data-entity-inspector]');
    if (inspector) inspector.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function applyGraphScope() {
    if (!state.graph) { index = allIndex; return; }
    index = new DatasetIndex(allIndex.prefixes);
    index.addAll(allIndex.quads.filter(function (quad) { return termKey(quad.graph) === state.graph; }));
    if (allIndex.messageGroups) index.messageGroups = allIndex.messageGroups.map(function (group) { return { message: group.message, quads: group.quads.filter(function (q) { return termKey(q.graph) === state.graph; }) }; });
  }

  function reset(prefixes, scopeLabel) {
    allIndex = new DatasetIndex(prefixes);
    index = state.graph ? new DatasetIndex(prefixes) : allIndex;
    cleanup();
    state.validationHtml = '';
    state.partial = true;
    state.scopeLabel = scopeLabel || 'loaded document';
    root.hidden = true;
    render();
  }

  function addQuad(quad) {
    allIndex.add(quad);
    if (state.graph && termKey(quad.graph) === state.graph) index.add(quad);
    schedule();
  }

  function complete(quads, prefixes, scopeLabel) {
    if (quads) {
      allIndex = new DatasetIndex(prefixes);
      allIndex.addAll(quads);
      if (state.graph && !allIndex.graphs.has(state.graph)) state.graph = '';
      applyGraphScope();
    } else if (prefixes) {
      allIndex.prefixes = Object.assign({}, prefixes);
      index.prefixes = Object.assign({}, prefixes);
    }
    state.partial = false;
    if (scopeLabel) state.scopeLabel = scopeLabel;
    render();
  }

  root.addEventListener('click', function (event) {
    var blankToggle = event.target.closest('[data-blank-toggle]');
    if (blankToggle) {
      var properties = blankToggle.parentElement.querySelector('.blank-node-properties');
      var expanded = blankToggle.getAttribute('aria-expanded') !== 'true';
      blankToggle.setAttribute('aria-expanded', String(expanded));
      blankToggle.textContent = expanded ? 'Hide details' : 'Show details';
      properties.hidden = !expanded;
      return;
    }
    var action = event.target.closest('[data-action]');
    if (action && action.dataset.action === 'validate-shacl') {
      action.disabled = true;
      action.textContent = 'Validating…';
      validateShacl();
      return;
    }
    var loadTarget = event.target.closest('[data-load-url]');
    if (loadTarget) {
      if (options.onLoadUrl) options.onLoadUrl(loadTarget.dataset.loadUrl);
      return;
    }
    var tab = event.target.closest('[data-view]');
    if (tab) { state.view = tab.dataset.view; root.querySelector('.more-views').open = false; render(); var focused = root.querySelector('#viewer-tab-' + state.view); if (focused) focused.focus(); notify(); return; }
    var entityTarget = event.target.closest('[data-entity], [data-select-entity]');
    if (entityTarget) {
      var entityKey = entityTarget.dataset.entity || entityTarget.dataset.selectEntity;
      if (!entityKey) return;
      if (entityTarget.dataset.geometryId !== undefined && unmount && unmount.focus) unmount.focus(entityTarget.dataset.geometryId);
      selectEntity(entityKey);
    }
  });

  root.addEventListener('submit', function (event) {
    var form = event.target.closest('[data-hydra-search]');
    if (!form) return;
    event.preventDefault();
    var values = {};
    form.querySelectorAll('input[name]').forEach(function (input) { values[input.name] = input.value.trim(); });
    var expanded = expandHydraTemplate(form.dataset.template, values);
    var url = safeUrl(expanded);
    if (!url) {
      form.querySelector('[data-hydra-search-status]').textContent = 'The expanded template is not a valid HTTP(S) URL.';
      return;
    }
    if (options.onLoadUrl) options.onLoadUrl(url);
  });

  root.addEventListener('keydown', function (event) {
    var tab = event.target.closest('[data-view]');
    if (!tab || ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) === -1) return;
    var tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    var current = tabs.indexOf(tab);
    var next = event.key === 'Home' ? 0 : (event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length);
    tabs[next].click(); event.preventDefault(); event.stopPropagation();
  });

  root.addEventListener('error', function (event) {
    var image = event.target;
    if (!image || image.tagName !== 'IMG') return;
    var placeholder = document.createElement('div');
    placeholder.className = 'image-unavailable';
    placeholder.textContent = 'Image could not be loaded';
    image.replaceWith(placeholder);
  }, true);

  var filterInput = root.querySelector('[data-view-filter]');
  filterInput.addEventListener('input', function () { state.filter = filterInput.value; render(); notify(); });
  root.querySelector('[data-graph-scope]').addEventListener('change', function (event) {
    state.graph = event.target.value;
    state.entity = '';
    applyGraphScope();
    render();
    notify();
  });

  function getState() { return { view: state.view, filter: state.filter, entity: state.entity, graph: state.graph, camera: state.camera }; }

  function validateShacl() {
    state.validationHtml = '<div class="validation-result pending">Loading the SHACL engine…</div>';
    render();
    return Promise.all([
      import('shacl-engine/Validator.js'),
      import('@rdfjs/dataset'),
      import('@rdfjs/data-model')
    ]).then(function (modules) {
      var Validator = modules[0].default;
      var datasetFactory = modules[1].default;
      var dataModel = modules[2].default;
      var dataset = datasetFactory.dataset(index.quads);
      var validator = new Validator(dataset, { factory: dataModel });
      return validator.validate({ dataset: dataset });
    }).then(function (report) {
      if (report.conforms) {
        state.validationHtml = '<div class="validation-result conforms"><strong>Conforms</strong><span>No SHACL violations were found in the loaded snapshot.</span></div>';
      } else {
        var rows = report.results.map(function (result) {
          var focus = result.focusNode && result.focusNode.term;
          var source = result.shape && result.shape.ptr && result.shape.ptr.term;
          var messages = (result.message || []).map(function (message) { return message.value; }).join('; ');
          return '<tr><td>' + (focus ? termHtml(index, focus) : '—') + '</td><td>' + (source ? termHtml(index, source) : '—') + '</td><td>' + esc(messages || index.compact(result.constraintComponent.value)) + '</td></tr>';
        }).join('');
        state.validationHtml = '<div class="validation-result violations"><strong>' + report.results.length + ' validation finding' + (report.results.length === 1 ? '' : 's') + '</strong><div class="table-scroll"><table class="entity-table"><thead><tr><th>Focus node</th><th>Source shape</th><th>Finding</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      }
      render();
    }).catch(function (error) {
      state.validationHtml = '<div class="validation-result failed"><strong>Validation could not run</strong><span>' + esc(error.message || error) + '</span></div>';
      render();
    });
  }

  function restoreState(next) {
    if (!next) return;
    state.view = next.view === 'profile' ? 'overview' : next.view || '';
    state.camera = next.camera;
    state.filter = next.filter || '';
    state.entity = next.entity || '';
    state.graph = next.graph || '';
    applyGraphScope();
    filterInput.value = state.filter;
    render();
  }

  return {
    reset: reset, addQuad: addQuad, complete: complete, render: render,
    getState: getState, restoreState: restoreState,
    setVisible: function (next) { visible = next; if (!visible) cleanup(); render(); },
    setScope: function (quads, prefixes, label, partial, groups) { allIndex = new DatasetIndex(prefixes); allIndex.addAll(quads); allIndex.messageGroups = groups; applyGraphScope(); state.validationHtml = ''; state.scopeLabel = label; state.partial = !!partial; schedule(); },
    dispose: function () { disposed = true; cleanup(); if (renderTimer) clearTimeout(renderTimer); root.innerHTML = ''; }
  };
}

module.exports = {
  DatasetIndex: DatasetIndex,
  createRegistry: createRegistry,
  detectAvailable: detectAvailable,
  rankViews: rankViews,
  createWorkbench: createWorkbench,
  extractTimeSeries: extractTimeSeries,
  expandHydraTemplate: expandHydraTemplate,
  termKey: termKey
};
