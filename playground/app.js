'use strict';

var rdfWriter = require('rdf-writer-ts');
var rdfParserTs = require('rdf-parser-ts');
var visualizations = require('./visualizations');

// Register common vocabularies up front so pretty RDF output can use compact
// names. Prefixes declared by the fetched document are added to the list shown
// below the output once parsing finishes.
var COMMON_PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  schema: 'https://schema.org/',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  hydra: 'http://www.w3.org/ns/hydra/core#',
  ldp: 'http://www.w3.org/ns/ldp#',
  void: 'http://rdfs.org/ns/void#',
  prov: 'http://www.w3.org/ns/prov#',
  sh: 'http://www.w3.org/ns/shacl#',
  as: 'https://www.w3.org/ns/activitystreams#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
  geosparql: 'http://www.opengis.net/ont/geosparql#',
  csvw: 'http://www.w3.org/ns/csvw#',
  dcat: 'http://www.w3.org/ns/dcat#',
  qb: 'http://purl.org/linked-data/cube#',
  sosa: 'http://www.w3.org/ns/sosa/',
  oa: 'http://www.w3.org/ns/oa#',
  vc: 'https://www.w3.org/2018/credentials#',
  tree: 'https://w3id.org/tree#'
};

var DEFAULT_FRAME = {
  '@context': { foaf: 'http://xmlns.com/foaf/0.1/' },
  '@type': 'foaf:PersonalProfileDocument'
};

var OUTPUT_FORMATS = {
  trig: {
    label: 'TriG',
    writerFormat: 'TriG',
    mode: 'text/turtle',
    hint: ''
  },
  nquads: {
    label: 'N-Quads',
    writerFormat: 'N-Quads',
    mode: 'text/turtle',
    hint: ''
  },
  jsonld: {
    label: 'JSON-LD',
    mode: { name: 'javascript', json: true },
    hint: ''
  }
};

// query.wikidata.org's CONSTRUCT endpoint, returning a small sample of
// software engineers as a real SPARQL CONSTRUCT result.
var WIKIDATA_SPARQL_CONSTRUCT_QUERY = [
  'CONSTRUCT { ?person wdt:P31 wd:Q5 . ?person rdfs:label ?label }',
  'WHERE {',
  '  ?person wdt:P106 wd:Q82594 ;',
  '          rdfs:label ?label .',
  '  FILTER(LANG(?label) = "en")',
  '}',
  'LIMIT 20'
].join('\n');

var EXAMPLES = {
  wikidata: {
    url: 'https://www.wikidata.org/wiki/Special:EntityData/Q57.ttl'
  },
  'wikidata-sparql': {
    url: 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(WIKIDATA_SPARQL_CONSTRUCT_QUERY)
  },
  profile: {
    url: 'https://pietercolpaert.be/'
  },
  jelly: {
    url: 'https://raw.githubusercontent.com/pietercolpaert/rdfjs-jelly/main/example/osm-dk-10k.jelly.gz'
  },
  'rdf-messages': {
    // ldfetch expects absolute http(s) URLs, so resolve this against the
    // page's own location rather than using a bare relative path.
    url: new URL('examples/sensor-readings.trig', document.baseURI).href
  },
  // Too large (multi-GB) to ever fully buffer, and the S3 endpoint's CORS
  // preflight rejects a Range header, so this one is handled by a separate,
  // manual streaming path (see startStreamingExample) rather than a normal
  // fetcher.get() call: one long-lived GET, paused every WINDOW_SIZE
  // messages by simply not reading further, resumed on "Load next" click.
  'rdf-messages-large': {
    url: 'https://ugent-lib-opendata-prd.s3.ugent.be/alma-rdf/rdf-messages.20260404.nt',
    streaming: true
  },
  // Avoids shaclcjs's list-compiling code path (property paths with "|",
  // for example), which throws in a strict-mode bundle: shaclc-parse@2.0.0
  // assigns to an undeclared `head` variable there, relying on sloppy-mode
  // global auto-creation that only silently works in a non-strict context.
  shaclc: {
    url: 'https://raw.githubusercontent.com/jeswr/shaclcjs/main/__tests__/valid/basic-shape-with-targets.shaclc'
  },
  visualizations: {
    url: new URL('examples/visualization-showcase.ttl', document.baseURI).href
  },
  geospatial: {
    url: new URL('examples/geospatial-messages.trig', document.baseURI).href
  }
};

document.addEventListener('DOMContentLoaded', function () {
  var urlForm = document.getElementById('url-form');
  var urlInput = document.getElementById('url');
  var fetchBtn = document.getElementById('fetch-btn');
  var advanced = document.getElementById('advanced');
  var outputFormat = document.getElementById('output-format');
  var frameOptions = document.getElementById('frame-options');
  var frameToggle = document.getElementById('frame-toggle');
  var frameField = document.getElementById('frame-field');
  var outputPanel = document.getElementById('output-panel');
  var outputTitle = document.getElementById('output-title');
  var outputHint = document.getElementById('output-hint');
  var statusEl = document.getElementById('status');
  var prefixesList = document.getElementById('prefixes-list');
  var prefixCount = document.getElementById('prefix-count');
  var outputPrefixes = Object.assign({}, COMMON_PREFIXES);
  var codeJsEl = document.getElementById('code-js');
  var codeCliEl = document.getElementById('code-cli');
  var messagesPanel = document.getElementById('messages-panel');
  var messageSlider = document.getElementById('message-slider');
  var messagePosition = document.getElementById('message-position');
  var loadMoreMessagesBtn = document.getElementById('load-more-messages');
  var visualizationRoot = document.getElementById('visualization-workbench');
  var applyingHash = false;
  var activePane = 'triples';
  var messageScope = document.getElementById('message-scope');
  var messageOutputPanel = document.getElementById('message-output-panel');
  var restoredMessagePosition = null;

  // Very large RDF Message logs shouldn't have to sit fully in memory just
  // to be browsed: messages are consumed from the live 'message' event (not
  // response.messages) into a window of at most WINDOW_SIZE, plus a small
  // lookahead buffer of whatever streams in past that. "Load next" swaps in
  // the next window and drops the old one and everything before it, so at
  // most ~2 windows' worth of messages are ever referenced at once -- for
  // Jelly-RDF, which streams messages progressively as it parses, that's a
  // real memory bound. rdf-parser-ts's Turtle/TriG "-messages" mode can only
  // report message boundaries (including empty ones) once the whole
  // document has been parsed, so for that format family this still bounds
  // what the playground itself renders/retains, but not what the parser
  // buffers internally while it runs.
  var WINDOW_SIZE = 1000;
  var currentMessages = [];
  var pendingMessages = [];
  var windowStartIndex = 0;
  var fetchComplete = false;
  loadMoreMessagesBtn.textContent = 'Load next ' + WINDOW_SIZE;

  // Manual streaming session state for the one example too large to ever
  // fully buffer (see startStreamingExample). streamingReader is non-null
  // exactly while there's a live, not-yet-exhausted response stream to
  // resume from.
  var streamingReader = null;
  var streamingParser = null;
  var streamingDecoder = null;
  var streamingDone = false;
  var streamingBuilding = [];
  var streamingCounter = null;

  var outputCm = CodeMirror(document.getElementById('output-editor'), {
    mode: 'text/turtle',
    theme: 'pietercolpaert',
    readOnly: true,
    lineNumbers: true,
    lineWrapping: true
  });

  var frameCm = CodeMirror(document.getElementById('frame-editor'), {
    mode: { name: 'javascript', json: true },
    theme: 'pietercolpaert',
    lineNumbers: true,
    lineWrapping: true,
    value: JSON.stringify(DEFAULT_FRAME, null, 2)
  });

  var messageCm = CodeMirror(document.getElementById('message-editor'), {
    mode: 'text/turtle',
    theme: 'pietercolpaert',
    readOnly: true,
    lineNumbers: true,
    lineWrapping: true
  });

  var visualizationWorkbench = visualizations.createWorkbench(visualizationRoot, {
    onStateChange: function () { updateHash(); },
    onAvailable: function (count) { document.getElementById('explore-tab').textContent = count ? 'Explore (' + count + ')' : 'Explore'; }
  });

  function showPane() {
    document.getElementById('triples-pane').hidden = activePane !== 'triples';
    visualizationWorkbench.setVisible(activePane === 'explore');
    document.querySelectorAll('[data-pane]').forEach(function (button) {
      button.setAttribute('aria-selected', String(button.dataset.pane === activePane));
      button.tabIndex = button.dataset.pane === activePane ? 0 : -1;
    });
    if (activePane === 'triples') { outputCm.refresh(); messageCm.refresh(); }
  }
  document.querySelector('.result-tabs').addEventListener('click', function (event) {
    var button = event.target.closest('[data-pane]');
    if (!button) return;
    activePane = button.dataset.pane; showPane(); updateHash();
  });
  document.querySelector('.result-tabs').addEventListener('keydown', function (event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    var target = event.key === 'Home' ? 'triples' : event.key === 'End' ? 'explore' : activePane === 'triples' ? 'explore' : 'triples';
    document.querySelector('[data-pane="' + target + '"]').click();
    document.querySelector('[data-pane="' + target + '"]').focus();
    event.preventDefault(); event.stopPropagation();
  });

  function updateFormatUi() {
    var format = OUTPUT_FORMATS[outputFormat.value] || OUTPUT_FORMATS.trig;
    var isJsonLd = outputFormat.value === 'jsonld';
    outputTitle.textContent = format.label.toLowerCase() + ' output';
    outputHint.textContent = format.hint;
    outputPanel.setAttribute('aria-label', format.label + ' output');
    outputCm.setOption('mode', format.mode);
    frameOptions.hidden = !isJsonLd;
    frameField.hidden = !isJsonLd || !frameToggle.checked;
    if (!frameField.hidden) frameCm.refresh();
  }

  function configurationHash() {
    var params = new URLSearchParams();
    var visualizationState = visualizationWorkbench.getState();
    params.set('url', urlInput.value.trim());
    params.set('format', outputFormat.value);
    if (activePane === 'explore') params.set('pane', 'explore');
    if (messageScope.value !== 'current') params.set('scope', messageScope.value);
    if (visualizationState.camera) params.set('camera', visualizationState.camera.map(function (v) { return Number(v.toFixed(5)); }).join(','));
    if (advanced.open) params.set('advanced', '1');
    if (frameToggle.checked) params.set('frameEnabled', '1');
    // Keep a user's edited frame shareable even while application of that
    // frame is disabled; omit only the untouched default to keep normal URLs
    // compact.
    if (frameToggle.checked || frameCm.getValue() !== JSON.stringify(DEFAULT_FRAME, null, 2)) {
      params.set('frame', frameCm.getValue());
    }
    if (visualizationState.view && visualizationState.view !== 'overview') params.set('view', visualizationState.view);
    if (visualizationState.filter) params.set('filter', visualizationState.filter);
    if (visualizationState.entity) params.set('entity', visualizationState.entity);
    if (visualizationState.graph) params.set('graph', visualizationState.graph);
    if (restoredMessagePosition !== null) {
      params.set('message', String(restoredMessagePosition));
    } else if (!messagesPanel.hidden && currentMessages.length) {
      params.set('message', String(windowStartIndex + parseInt(messageSlider.value, 10) + 1));
    }
    return '#' + params.toString();
  }

  function updateHash() {
    if (applyingHash) return;
    var hash = configurationHash();
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }

  function applyHash() {
    if (!window.location.hash || window.location.hash === '#') return false;

    var params = new URLSearchParams(window.location.hash.slice(1));
    applyingHash = true;
    activePane = params.get('pane') === 'explore' ? 'explore' : 'triples';
    messageScope.value = ['window', 'memory'].includes(params.get('scope')) ? params.get('scope') : 'current';
    var camera = (params.get('camera') || '').split(',').map(Number);
    if (camera.length !== 3 || !camera.every(Number.isFinite) || Math.abs(camera[0]) > 180 || Math.abs(camera[1]) > 90 || camera[2] < 0 || camera[2] > 22) camera = undefined;
    if (params.has('url')) urlInput.value = params.get('url');
    if (OUTPUT_FORMATS[params.get('format')]) outputFormat.value = params.get('format');
    frameToggle.checked = params.get('frameEnabled') === '1';
    if (params.has('frame')) frameCm.setValue(params.get('frame'));
    restoredMessagePosition = params.has('message') ? Math.max(1, parseInt(params.get('message'), 10) || 1) : null;
    advanced.open = params.get('advanced') === '1' || outputFormat.value !== 'trig' || frameToggle.checked;
    visualizationWorkbench.restoreState({
      view: params.get('view') || '',
      filter: params.get('filter') || '',
      entity: params.get('entity') || '',
      graph: params.get('graph') || '',
      camera: camera
    });
    updateFormatUi();
    showPane();
    applyingHash = false;
    return true;
  }

  outputFormat.addEventListener('change', function () {
    updateFormatUi();
    if (currentMessages.length) renderMessage(parseInt(messageSlider.value, 10));
    updateHash();
  });

  frameToggle.addEventListener('change', function () {
    updateFormatUi();
    if (currentMessages.length) renderMessage(parseInt(messageSlider.value, 10));
    updateHash();
  });

  advanced.addEventListener('toggle', updateHash);
  urlInput.addEventListener('input', function () {
    // A message number belongs to the previously loaded URL and must not be
    // carried into a different source while the user edits the address.
    restoredMessagePosition = null;
    messagesPanel.hidden = true;
    var viewState = visualizationWorkbench.getState();
    viewState.graph = '';
    viewState.entity = '';
    visualizationWorkbench.restoreState(viewState);
    updateHash();
  });
  frameCm.on('change', updateHash);

  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var copiedText = document.getElementById(btn.dataset.target).textContent;
      navigator.clipboard.writeText(copiedText).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = original; }, 1200);
      });
    });
  });

  // The writer emits its prefix header synchronously during construction. The
  // sink drops that header because the complete prefix map is displayed below.
  function editorSink(cm, isReady) {
    var chunks = [];
    return {
      write: function (chunk, encoding, callback) {
        if (isReady()) chunks.push(chunk);
        if (callback) callback();
      },
      end: function (callback) {
        cm.setValue(chunks.join(''));
        chunks = [];
        if (callback) callback(null, cm.getValue());
      }
    };
  }

  function renderPrefixes(prefixes) {
    // Include the bindings used by the serializer, even when the source
    // does not declare them (e.g. JSON-LD). Preserve conflicting source
    // declarations under aliases rather than mislabelling compact output.
    outputPrefixes = Object.assign(Object.create(null), COMMON_PREFIXES);
    Object.keys(prefixes).forEach(function (name) {
      var alias = name;
      var suffix = 2;
      while (Object.prototype.hasOwnProperty.call(outputPrefixes, alias) && outputPrefixes[alias] !== prefixes[name]) alias = name + suffix++;
      outputPrefixes[alias] = prefixes[name];
    });
    var names = Object.keys(outputPrefixes).sort();
    prefixesList.innerHTML = '';
    names.forEach(function (name) {
      var li = document.createElement('li');
      var code = document.createElement('code');
      code.textContent = name;
      li.appendChild(code);
      li.appendChild(document.createTextNode(': ' + outputPrefixes[name]));
      prefixesList.appendChild(li);
    });
    prefixCount.textContent = names.length ? '(' + names.length + ')' : '';
  }

  // Serialize the selected message scope in the chosen RDF syntax. JSON-LD
  // and optional framing are handled by renderMessageOutput below.
  function serializeMessage (quads) {
    var writer = new rdfWriter.Writer({ format: outputFormat.value === 'nquads' ? 'N-Quads' : 'TriG', prefixes: outputPrefixes });
    writer.addQuads(quads);
    var output = '';
    writer.end(function (error, result) { output = result; });
    // Drop the repeated @prefix header (blank-line separated from the
    // quads), matching the main output panel, which skips straight to
    // content -- the prefixes are already listed in their own panel.
    var separatorIndex = output.indexOf('\n\n');
    return separatorIndex === -1 ? output : output.slice(separatorIndex + 2);
  }

  function renderMessage (index) {
    if (!currentMessages.length) return;
    index = Math.max(0, Math.min(index, currentMessages.length - 1));
    messageSlider.value = String(index);
    var globalPosition = windowStartIndex + index + 1;
    var knownSoFar = windowStartIndex + currentMessages.length;
    // A trailing "+" signals there may be more beyond what's been seen so
    // far -- either buffered ahead already, or the fetch is still running.
    var maybeMore = pendingMessages.length > 0 || !fetchComplete || !!streamingReader;
    messagePosition.textContent = 'message ' + globalPosition + ' of ' + knownSoFar + (maybeMore ? '+' : '');
    var selectedMessage = currentMessages[index];
    var exploreMessages = messageScope.value === 'memory' ? currentMessages.concat(pendingMessages) : messageScope.value === 'window' ? currentMessages : [selectedMessage];
    var groups = exploreMessages.map(function (quads, position) { return { quads: quads, message: messageScope.value === 'current' ? globalPosition : windowStartIndex + position + 1 }; });
    var exploreQuads = exploreMessages.flat();
    var exploreLabel = messageScope.value === 'current' ? 'message ' + globalPosition : exploreMessages.length + ' retained messages (' + (windowStartIndex + 1) + '–' + (windowStartIndex + exploreMessages.length) + ')';
    renderMessageOutput(selectedMessage);
    document.getElementById('message-output-scope').textContent = 'message ' + globalPosition;
    outputPanel.hidden = true;
    messageOutputPanel.hidden = false;
    visualizationWorkbench.setScope(exploreQuads, outputPrefixes, exploreLabel, false, groups);
    if (restoredMessagePosition === null) updateHash();
  }

  var messageOutputRevision = 0;
  function renderMessageOutput(message) {
    var revision = ++messageOutputRevision;
    messageCm.setOption('mode', OUTPUT_FORMATS[outputFormat.value].mode);
    if (outputFormat.value !== 'jsonld') { messageCm.setValue(serializeMessage(message)); return; }
    var converter = new window.ldfetch();
    if (!frameToggle.checked) {
      messageCm.setValue(JSON.stringify(converter.messageToJsonLd(message)));
      return;
    }
    try {
      var frame = JSON.parse(frameCm.getValue());
      messageCm.setValue('Applying frame…');
      converter.frame(message, frame).then(function (value) {
        if (revision === messageOutputRevision) messageCm.setValue(JSON.stringify(value, null, 2));
      }).catch(function (error) { if (revision === messageOutputRevision) messageCm.setValue('Could not apply frame: ' + error.message); });
    } catch (error) { messageCm.setValue('Invalid JSON-LD frame: ' + error.message); }
  }

  // Restore a message selected in a shared URL once its retained window is
  // available. The very large streaming example deliberately does not fetch
  // ahead without a user action merely to satisfy a distant hash position.
  function restoreMessageSelection () {
    if (restoredMessagePosition === null || !currentMessages.length) return false;
    var relative = restoredMessagePosition - 1 - windowStartIndex;
    var known = currentMessages.concat(pendingMessages);
    if (relative < 0 || relative >= known.length) return false;
    if (relative >= currentMessages.length) {
      var windowOffset = Math.floor(relative / WINDOW_SIZE) * WINDOW_SIZE;
      windowStartIndex += windowOffset;
      currentMessages = known.slice(windowOffset, windowOffset + WINDOW_SIZE);
      pendingMessages = known.slice(windowOffset + currentMessages.length);
      relative -= windowOffset;
      messageSlider.max = String(Math.max(0, currentMessages.length - 1));
      updateLoadMoreVisibility();
    }
    restoredMessagePosition = null;
    renderMessage(relative);
    return true;
  }

  function updateLoadMoreVisibility () {
    // In streaming mode, the next window hasn't been fetched yet at all
    // (that only happens once "Load next" is clicked), so pendingMessages
    // being empty doesn't mean there's nothing left -- streamingReader
    // being live does.
    loadMoreMessagesBtn.hidden = pendingMessages.length === 0 && !streamingReader;
  }

  // Cancels and clears any in-progress manual streaming session (see
  // startStreamingExample), so switching to a different fetch doesn't leave
  // a paused connection quietly sitting open in the background.
  function resetStreamingSession () {
    if (streamingReader) {
      try { streamingReader.cancel(); } catch (cancelError) { /* already closed */ }
    }
    streamingReader = null;
    streamingParser = null;
    streamingDecoder = null;
    streamingDone = false;
    streamingBuilding = [];
    streamingCounter = null;
  }

  // Resets all message-window state for a new fetch.
  function resetMessages () {
    messageOutputRevision++;
    if (messageRenderTimer) { clearTimeout(messageRenderTimer); messageRenderTimer = null; }
    currentMessages = [];
    pendingMessages = [];
    windowStartIndex = 0;
    fetchComplete = false;
    messagesPanel.hidden = true;
    messageOutputPanel.hidden = true;
    loadMoreMessagesBtn.hidden = true;
    resetStreamingSession();
  }

  // Called for every message as it streams in via the 'message' event. The
  // first WINDOW_SIZE fill the visible window directly (so, for formats
  // that genuinely stream messages, the panel populates progressively);
  // anything past that buffers in pendingMessages until "Load next" is
  // clicked. Only the chosen scope is rendered, not the entire hidden log.
  function receiveMessage (quadsInMessage) {
    if (currentMessages.length < WINDOW_SIZE) {
      currentMessages.push(quadsInMessage);
      messagesPanel.hidden = false;
      messageSlider.max = String(currentMessages.length - 1);
      if (currentMessages.length === 1) {
        renderMessage(0);
        messageCm.refresh();
      } else {
        scheduleMessageRender();
      }
    } else {
      pendingMessages.push(quadsInMessage);
      if (messageScope.value === 'memory') scheduleMessageRender();
      updateLoadMoreVisibility();
    }
  }

  // Called once the fetch settles: nothing more will ever arrive, so drop
  // the "+" uncertainty from the position label and finalize the button.
  function finishMessages () {
    fetchComplete = true;
    updateLoadMoreVisibility();
    if (currentMessages.length && !restoreMessageSelection()) {
      restoredMessagePosition = null;
      renderMessage(parseInt(messageSlider.value, 10));
    }
  }

  // Feeds one parsed item (a plain quad or, in RDF Messages mode, a
  // {quad, messageCounter} pair) into the in-progress message being built up
  // across chunk boundaries, flushing it via receiveMessage() whenever the
  // counter changes. Unlike the ordinary fetch path (which groups messages
  // with rdf-parser-ts's toMessages() once the whole document is in hand,
  // so it can preserve entirely-empty messages), this infers boundaries
  // purely from messageCounter transitions as chunks arrive -- the only
  // option when the source may never be fully read. The trade-off: a
  // message with zero quads that lands exactly on a chunk boundary has
  // nothing to signal it, and would be missed. Acceptable for a multi-GB
  // real-world log of non-empty library records; worth knowing about for
  // other sources.
  function handleStreamingItem (item) {
    if (!(item && item.quad && typeof item.messageCounter === 'number')) return;
    if (streamingCounter === null) {
      streamingCounter = item.messageCounter;
    } else if (item.messageCounter !== streamingCounter) {
      receiveMessage(streamingBuilding);
      streamingBuilding = [];
      streamingCounter = item.messageCounter;
    }
    streamingBuilding.push(item.quad);
  }

  // Reads and parses chunks from the paused response stream -- true
  // backpressure, no Range header and no repeated requests, just one
  // long-lived GET whose body we stop reading from once there's enough,
  // and resume later -- until WINDOW_SIZE more messages have arrived (or
  // the stream ends), then stops (pauses) again.
  function pumpStreamingMessages () {
    var targetCount = windowStartIndex + currentMessages.length + pendingMessages.length + WINDOW_SIZE;

    function step () {
      if (windowStartIndex + currentMessages.length + pendingMessages.length >= targetCount) {
        return Promise.resolve();
      }
      if (!streamingReader) return Promise.resolve();
      return streamingReader.read().then(function (result) {
        if (result.done) {
          var tailText = streamingDecoder.decode();
          if (tailText) streamingParser.write(tailText).forEach(handleStreamingItem);
          streamingParser.end().forEach(handleStreamingItem);
          if (streamingBuilding.length) {
            receiveMessage(streamingBuilding);
            streamingBuilding = [];
          }
          streamingDone = true;
          streamingReader = null;
          return;
        }
        streamingParser.write(streamingDecoder.decode(result.value, { stream: true })).forEach(handleStreamingItem);
        return step();
      });
    }

    return step();
  }

  function continueStreaming () {
    setStatus('Fetching … (streaming, will pause again after ' + WINDOW_SIZE + ' more messages)');
    return pumpStreamingMessages().then(function () {
      fetchComplete = streamingDone;
      updateLoadMoreVisibility();
      if (currentMessages.length && !restoreMessageSelection()) renderMessage(parseInt(messageSlider.value, 10));
      var total = windowStartIndex + currentMessages.length + pendingMessages.length;
      if (streamingDone) {
        setStatus('Done: reached the end of the stream, ' + total + ' messages total.');
      } else {
        // A single network chunk can hold more than WINDOW_SIZE messages,
        // and a chunk can't be consumed partway through, so "buffered so
        // far" can overshoot the round WINDOW_SIZE step -- the window
        // shown on screen stays capped at WINDOW_SIZE regardless.
        setStatus('Paused: ' + total + ' messages fetched so far (' + WINDOW_SIZE + ' shown at a time) -- click "Load next ' + WINDOW_SIZE + '" to keep streaming.');
      }
      fetchBtn.disabled = false;
    }).catch(function (error) {
      setStatus('Error: ' + (error && error.message ? error.message : error), true);
      fetchBtn.disabled = false;
    });
  }

  // Entry point for the one example too large to fetch normally: raw
  // fetch() (a plain GET, so no CORS-preflight-triggering headers), parsed
  // incrementally with rdf-parser-ts's IncrementalParser as chunks arrive,
  // rather than lib/ldfetch.js's usual buffer-the-whole-response approach.
  function startStreamingExample (url) {
    resetMessages();
    visualizationWorkbench.reset(COMMON_PREFIXES, 'current message');
    outputPanel.hidden = true;
    renderPrefixes({});
    setStatus('Connecting …');
    fetchBtn.disabled = true;

    fetch(url).then(function (response) {
      if (!response.ok) throw new Error('Request failed: HTTP ' + response.status);
      streamingReader = response.body.getReader();
      streamingDecoder = new TextDecoder('utf-8');
      var documentPrefixes = Object.create(null);
      streamingParser = new rdfParserTs.IncrementalParser({ baseIRI: url, format: 'text/turtle' }, {
        prefix: function (prefix, iri) {
          var value = (iri && iri.value !== undefined) ? iri.value : iri;
          if (documentPrefixes[prefix] !== value) {
            documentPrefixes[prefix] = value;
            renderPrefixes(documentPrefixes);
          }
        }
      });
      codeJsEl.textContent = streamingJsSnippet(url);
      codeCliEl.textContent = cliSnippet(url, null);
      return continueStreaming();
    }).catch(function (error) {
      setStatus('Error: ' + (error && error.message ? error.message : error), true);
      fetchBtn.disabled = false;
    });
  }

  messageSlider.addEventListener('input', function () {
    restoredMessagePosition = null;
    renderMessage(parseInt(messageSlider.value, 10));
  });
  messageScope.addEventListener('change', function () { renderMessage(parseInt(messageSlider.value, 10)); updateHash(); });
  var messageRenderTimer = null;
  function scheduleMessageRender() {
    if (messageRenderTimer) return;
    messageRenderTimer = setTimeout(function () { messageRenderTimer = null; renderMessage(parseInt(messageSlider.value, 10)); }, 150);
  }

  loadMoreMessagesBtn.addEventListener('click', function () {
    windowStartIndex += currentMessages.length;
    currentMessages = pendingMessages.splice(0, WINDOW_SIZE);
    messageSlider.max = String(Math.max(0, currentMessages.length - 1));
    renderMessage(0);
    messageCm.refresh();
    updateLoadMoreVisibility();

    if (streamingReader) {
      fetchBtn.disabled = true;
      loadMoreMessagesBtn.disabled = true;
      continueStreaming().then(function () { loadMoreMessagesBtn.disabled = false; });
    }
  });

  // Left/right steps through messages from anywhere on the page, as long as
  // focus isn't in a text field (typing "->" in the URL bar shouldn't jump
  // messages). Focus on the slider itself already gets native arrow-key
  // support, which fires the same 'input' handler above.
  document.addEventListener('keydown', function (event) {
    if (messagesPanel.hidden) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    var target = event.target;
    var tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && (target.isContentEditable || target.closest('[data-globe], [role="tablist"]')))) return;
    event.preventDefault();
    renderMessage(parseInt(messageSlider.value, 10) + (event.key === 'ArrowRight' ? 1 : -1));
  });

  function jsSnippet(url, frame, hasMessages) {
    if (hasMessages) {
      return [
        "const ldfetch = require('ldfetch');",
        'const fetcher = new ldfetch();',
        '',
        "// This source uses RDF Message framing -- 'message' fires once per",
        '// message as it streams in, with the quads belonging to it',
        "fetcher.on('message', (quadsInMessage) => {",
        '  console.log(quadsInMessage);',
        '});',
        '',
        "fetcher.get('" + url + "').then(response => {",
        '  // response.messages is also available once the fetch completes',
        "  console.log(response.messages.length + ' messages in total');",
        '});'
      ].join('\n');
    }
    if (frame) {
      return [
        "const ldfetch = require('ldfetch');",
        'const fetcher = new ldfetch();',
        '',
        'const frame = ' + JSON.stringify(frame, null, 2) + ';',
        '',
        "fetcher.get('" + url + "')",
        '  .then(response => fetcher.frame(response.triples, frame))',
        '  .then(framed => console.log(JSON.stringify(framed, null, 2)));'
      ].join('\n');
    }
    return [
      "const ldfetch = require('ldfetch');",
      'const fetcher = new ldfetch();',
      '',
      "fetcher.get('" + url + "').then(response => {",
      '  // response.triples is an array of RDF/JS quads',
      '  console.log(response.triples);',
      '});'
    ].join('\n');
  }

  // Unlike every other example, this one isn't something `ldfetch.get()`
  // does for you -- the file is too large to ever fully buffer, so this
  // shows the actual technique: a plain fetch() (no Range header, so no
  // CORS preflight to worry about), parsed incrementally, with the reader
  // simply not asked to read further once you have enough -- backpressure,
  // not cancellation. On Node, replace response.body with a
  // fs.createReadStream()/http response and iterate its chunks the same way.
  function streamingJsSnippet(url) {
    return [
      "const { IncrementalParser, isMessageQuad } = require('rdf-parser-ts');",
      '',
      "const response = await fetch('" + url + "');",
      'const reader = response.body.getReader();',
      "const decoder = new TextDecoder('utf-8');",
      "const parser = new IncrementalParser({ baseIRI: '" + url + "', format: 'text/turtle' });",
      '',
      '// Stop calling reader.read() once you have enough -- the connection just',
      '// sits there, paused, until you call it again for more. Each read() can',
      "// contain several messages at once (a chunk can't be consumed partway",
      '// through), so track the highest messageCounter seen rather than',
      "// counting items -- that's how many *complete* messages you have.",
      'let highestMessageCounter = -1;',
      'while (highestMessageCounter < ' + (WINDOW_SIZE - 1) + ') {',
      '  const { done, value } = await reader.read();',
      '  if (done) break;',
      '  for (const item of parser.write(decoder.decode(value, { stream: true }))) {',
      '    if (isMessageQuad(item)) highestMessageCounter = Math.max(highestMessageCounter, item.messageCounter);',
      '  }',
      '}',
      '// reader is now paused; call reader.read() again whenever you want more.'
    ].join('\n');
  }

  // The playground's own format keys (trig/nquads/jsonld) match OUTPUT_FORMATS
  // and CodeMirror mode names; the CLI's --format takes 'json-ld' (hyphenated)
  // for the same thing.
  var CLI_FORMAT_NAMES = { jsonld: 'json-ld' };

  function cliSnippet(url, frame, formatName) {
    if (frame) {
      return [
        "echo '" + JSON.stringify(frame) + "' > frame.json",
        'npx ldfetch ' + url + ' --frame frame.json'
      ].join('\n');
    }
    var cliFormat = CLI_FORMAT_NAMES[formatName] || formatName;
    var formatFlag = cliFormat && cliFormat !== 'trig' ? ' --format ' + cliFormat : '';
    return 'npx ldfetch ' + url + formatFlag;
  }

  function setStatus(statusText, isError) {
    statusEl.textContent = statusText;
    statusEl.classList.toggle('error', !!isError);
  }

  // URLs that need the special streaming/backpressure path (see
  // startStreamingExample), regardless of how they were reached -- clicking
  // the example chip, restoring a shared #url=... link, or just pasting the
  // URL in and hitting Fetch all have to end up here, not just the chip.
  var STREAMING_URLS = Object.keys(EXAMPLES).reduce(function (urls, key) {
    if (EXAMPLES[key].streaming) urls[EXAMPLES[key].url] = true;
    return urls;
  }, {});

  function runFetch() {
    var url = urlInput.value.trim();
    if (!url) {
      setStatus('Please enter a URL.', true);
      return;
    }

    if (STREAMING_URLS[url]) {
      updateHash();
      startStreamingExample(url);
      return;
    }

    updateHash();
    var formatName = outputFormat.value;
    var format = OUTPUT_FORMATS[formatName];
    var useFrame = formatName === 'jsonld' && frameToggle.checked;
    var frame = null;
    if (useFrame) {
      try {
        frame = JSON.parse(frameCm.getValue());
      } catch (parseError) {
        setStatus('Invalid JSON-LD frame: ' + parseError.message, true);
        return;
      }
    }

    fetchBtn.disabled = true;
    outputCm.setValue('');
    outputPanel.hidden = false;
    renderPrefixes({});
    resetMessages();
    visualizationWorkbench.reset(COMMON_PREFIXES, 'loaded document');
    setStatus('Fetching …');

    var fetcher = new window.ldfetch();
    Object.keys(COMMON_PREFIXES).forEach(function (name) {
      fetcher.addPrefix(name, COMMON_PREFIXES[name]);
    });

    var writer = null;
    if (format.writerFormat) {
      var writerReady = false;
      writer = new rdfWriter.Writer(editorSink(outputCm, function () { return writerReady; }), {
        format: format.writerFormat,
        prefixes: COMMON_PREFIXES
      });
      writerReady = true;
    }

    var documentPrefixes = Object.create(null);
    fetcher.on('prefix', function (prefix, iri) {
      if (documentPrefixes[prefix] !== iri) {
        documentPrefixes[prefix] = iri;
        renderPrefixes(documentPrefixes);
      }
    });

    var quadCount = 0;
    // A message-framed source tags every 'quad' event with the RDF Message
    // it belongs to (messageCounter, undefined for ordinary quads) -- given
    // from the very first quad, not just once a 'message' event confirms
    // it, since messageCounter is what lets the writer produce a proper RDF
    // Message Log below (see issue #59's follow-up): rdf-writer-ts's
    // addQuad({ quad, messageCounter }) form writes the VERSION/MESSAGE
    // delimiters itself, filling in empty messages from gaps in the
    // counter. Once we know a source is message-framed, per-quad whole-
    // document visualization and serialization are skipped; only the
    // selected message scope is rendered. For a source with hundreds
    // of thousands of quads, feeding them all to the whole-document view
    // too would be wasted work, enough on its own to hang the tab.
    var messageModeDetected = false;
    fetcher.on('quad', function (quad, messageCounter) {
      quadCount++;
      if (messageCounter !== undefined) {
        if (!messageModeDetected) {
          messageModeDetected = true;
          visualizationWorkbench.reset(COMMON_PREFIXES, 'current message');
        }
        return;
      }
      visualizationWorkbench.addQuad(quad);
      if (writer) writer.addQuad(quad);
      setStatus('Fetching … ' + quadCount + ' triple' + (quadCount === 1 ? '' : 's') + ' so far');
    });
    fetcher.on('message', function (quadsInMessage) {
      receiveMessage(quadsInMessage);
      var total = windowStartIndex + currentMessages.length + pendingMessages.length;
      setStatus('Fetching … ' + quadCount + ' triple' + (quadCount === 1 ? '' : 's') + ' in ' + total + ' message' + (total === 1 ? '' : 's') + ' so far');
    });

    fetcher.get(url).then(function (response) {
      if (writer) writer.end();
      renderPrefixes(documentPrefixes);
      finishMessages();
      // Message output (including custom framing) is handled by the scope
      // renderer. Never build a second, hidden whole-log document.
      var hasMessages = currentMessages.length > 0;
      codeJsEl.textContent = jsSnippet(url, frame, hasMessages);
      codeCliEl.textContent = cliSnippet(url, frame, formatName);

      if (hasMessages) {
        outputHint.textContent = formatName === 'jsonld' ? '(NDJSON-LD: one JSON object per message)' : '(RDF Message Log: MESSAGE-delimited)';
      }

      if (hasMessages) {
        var messageTotal = windowStartIndex + currentMessages.length + pendingMessages.length;
        setStatus('Done: ' + response.triples.length + ' triples in ' + messageTotal + ' messages from ' + response.url);
        fetchBtn.disabled = false;
        return;
      }

      if (!hasMessages) {
        visualizationWorkbench.complete(response.triples, outputPrefixes, 'loaded document');
      }

      if (formatName !== 'jsonld') {
        setStatus('Done: ' + response.triples.length + ' triples from ' + response.url);
        fetchBtn.disabled = false;
        return;
      }

      setStatus(useFrame ? 'Framing …' : 'Rendering JSON-LD …');
      // A wildcard graph frame gives us a normal JSON-LD document when the
      // user has not supplied a more specific frame.
      var jsonLdFrame = frame || { '@graph': {} };
      return fetcher.frame(response.triples, jsonLdFrame).then(function (jsonLd) {
        outputCm.setValue(JSON.stringify(jsonLd, null, 2));
        var messageNote = hasMessages ? ' in ' + (windowStartIndex + currentMessages.length + pendingMessages.length) + ' messages' : '';
        setStatus('Done: ' + response.triples.length + ' triples' + messageNote + ' from ' + response.url);
        fetchBtn.disabled = false;
      });
    }).catch(function (error) {
      if (writer) writer.end();
      setStatus('Error: ' + (error && error.message ? error.message : error), true);
      fetchBtn.disabled = false;
    });
  }

  urlForm.addEventListener('submit', function (event) {
    event.preventDefault();
    runFetch();
  });

  document.getElementById('examples-list').addEventListener('click', function (event) {
    var btn = event.target.closest('.example-chip');
    if (!btn) return;
    var example = EXAMPLES[btn.dataset.example];
    if (!example) return;

    document.querySelectorAll('.example-chip').forEach(function (chip) {
      chip.classList.toggle('active', chip === btn);
    });

    urlInput.value = example.url;
    var viewState = visualizationWorkbench.getState();
    viewState.graph = '';
    viewState.entity = '';
    visualizationWorkbench.restoreState(viewState);
    restoredMessagePosition = null;
    // runFetch() itself checks STREAMING_URLS and routes accordingly, so
    // this works the same whether the URL got here via this click, a
    // restored #url=... link, or the user just pasting it in.
    runFetch();
  });

  window.addEventListener('hashchange', function () {
    if (applyHash()) runFetch();
  });

  applyHash();
  updateFormatUi();
  updateHash();
  runFetch();
});
