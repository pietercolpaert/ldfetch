'use strict';

var rdfWriter = require('rdf-writer-ts');
var rdfParserTs = require('rdf-parser-ts');

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
  csvw: 'http://www.w3.org/ns/csvw#'
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
  // messages by simply not reading further, resumed on "Load next 100".
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
  var codeJsEl = document.getElementById('code-js');
  var codeCliEl = document.getElementById('code-cli');
  var messagesPanel = document.getElementById('messages-panel');
  var messageSlider = document.getElementById('message-slider');
  var messagePosition = document.getElementById('message-position');
  var loadMoreMessagesBtn = document.getElementById('load-more-messages');
  var applyingHash = false;

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
  var WINDOW_SIZE = 100;
  var currentMessages = [];
  var pendingMessages = [];
  var windowStartIndex = 0;
  var fetchComplete = false;

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
    params.set('url', urlInput.value.trim());
    params.set('format', outputFormat.value);
    if (advanced.open) params.set('advanced', '1');
    if (frameToggle.checked) {
      params.set('frameEnabled', '1');
      params.set('frame', frameCm.getValue());
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
    if (params.has('url')) urlInput.value = params.get('url');
    if (OUTPUT_FORMATS[params.get('format')]) outputFormat.value = params.get('format');
    frameToggle.checked = params.get('frameEnabled') === '1';
    if (params.has('frame')) frameCm.setValue(params.get('frame'));
    advanced.open = params.get('advanced') === '1' || outputFormat.value !== 'trig' || frameToggle.checked;
    updateFormatUi();
    applyingHash = false;
    return true;
  }

  outputFormat.addEventListener('change', function () {
    updateFormatUi();
    updateHash();
  });

  frameToggle.addEventListener('change', function () {
    updateFormatUi();
    updateHash();
  });

  advanced.addEventListener('toggle', updateHash);
  urlInput.addEventListener('input', updateHash);
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

  function appendToEditor(cm, chunk) {
    var doc = cm.getDoc();
    var lastLine = doc.lastLine();
    var lastCh = doc.getLine(lastLine).length;
    doc.replaceRange(chunk, CodeMirror.Pos(lastLine, lastCh));
    cm.scrollIntoView({ line: doc.lastLine(), ch: 0 });
  }

  // The writer emits its prefix header synchronously during construction. The
  // sink drops that header because the complete prefix map is displayed below.
  function editorSink(cm, isReady) {
    return {
      write: function (chunk, encoding, callback) {
        if (isReady()) appendToEditor(cm, chunk);
        if (callback) callback();
      },
      end: function (callback) {
        if (callback) callback(null, cm.getValue());
      }
    };
  }

  function renderPrefixes(prefixes) {
    var names = Object.keys(prefixes).sort();
    prefixesList.innerHTML = '';
    names.forEach(function (name) {
      var li = document.createElement('li');
      var code = document.createElement('code');
      code.textContent = name;
      li.appendChild(code);
      li.appendChild(document.createTextNode(': ' + prefixes[name]));
      prefixesList.appendChild(li);
    });
    prefixCount.textContent = names.length ? '(' + names.length + ')' : '';
  }

  // Renders one RDF Message's quads as TriG, independent of the main output
  // format -- messages are raw event/diff-style data, not documents, so
  // JSON-LD framing doesn't apply here.
  function serializeMessage (quads) {
    var writer = new rdfWriter.Writer({ format: 'TriG', prefixes: COMMON_PREFIXES });
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
    messageCm.setValue(serializeMessage(currentMessages[index]));
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
    currentMessages = [];
    pendingMessages = [];
    windowStartIndex = 0;
    fetchComplete = false;
    messagesPanel.hidden = true;
    loadMoreMessagesBtn.hidden = true;
    resetStreamingSession();
  }

  // Called for every message as it streams in via the 'message' event. The
  // first WINDOW_SIZE fill the visible window directly (so, for formats
  // that genuinely stream messages, the panel populates progressively);
  // anything past that buffers in pendingMessages until "Load next" is
  // clicked, so the browser never has to hold more than about two windows'
  // worth of messages for the picture on screen.
  function receiveMessage (quadsInMessage) {
    if (currentMessages.length < WINDOW_SIZE) {
      currentMessages.push(quadsInMessage);
      messagesPanel.hidden = false;
      messageSlider.max = String(currentMessages.length - 1);
      if (currentMessages.length === 1) {
        renderMessage(0);
        messageCm.refresh();
      } else {
        renderMessage(parseInt(messageSlider.value, 10));
      }
    } else {
      pendingMessages.push(quadsInMessage);
      updateLoadMoreVisibility();
    }
  }

  // Called once the fetch settles: nothing more will ever arrive, so drop
  // the "+" uncertainty from the position label and finalize the button.
  function finishMessages () {
    fetchComplete = true;
    updateLoadMoreVisibility();
    if (currentMessages.length) renderMessage(parseInt(messageSlider.value, 10));
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
      if (currentMessages.length) renderMessage(parseInt(messageSlider.value, 10));
      var total = windowStartIndex + currentMessages.length + pendingMessages.length;
      if (streamingDone) {
        setStatus('Done: reached the end of the stream, ' + total + ' messages total.');
      } else {
        // A single network chunk can hold more than WINDOW_SIZE messages,
        // and a chunk can't be consumed partway through, so "buffered so
        // far" can overshoot the round WINDOW_SIZE step -- the window
        // shown on screen stays capped at WINDOW_SIZE regardless.
        setStatus('Paused: ' + total + ' messages fetched so far (' + WINDOW_SIZE + ' shown at a time) -- click "Load next 100" to keep streaming.');
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
    outputPanel.hidden = true;
    renderPrefixes({});
    setStatus('Connecting …');
    fetchBtn.disabled = true;

    fetch(url).then(function (response) {
      if (!response.ok) throw new Error('Request failed: HTTP ' + response.status);
      streamingReader = response.body.getReader();
      streamingDecoder = new TextDecoder('utf-8');
      // The "prefixes used" panel shows only what the source itself
      // declares, not COMMON_PREFIXES (that set is only for compacting the
      // per-message TriG output in serializeMessage -- it's noise here).
      var documentPrefixes = {};
      streamingParser = new rdfParserTs.IncrementalParser({ baseIRI: url, format: 'text/turtle' }, {
        prefix: function (prefix, iri) {
          var value = (iri && iri.value !== undefined) ? iri.value : iri;
          if (!(prefix in documentPrefixes)) {
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
    renderMessage(parseInt(messageSlider.value, 10));
  });

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
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
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
      'while (highestMessageCounter < 99) {',
      '  const { done, value } = await reader.read();',
      '  if (done) break;',
      '  for (const item of parser.write(decoder.decode(value, { stream: true }))) {',
      '    if (isMessageQuad(item)) highestMessageCounter = Math.max(highestMessageCounter, item.messageCounter);',
      '  }',
      '}',
      '// reader is now paused; call reader.read() again whenever you want more.'
    ].join('\n');
  }

  function cliSnippet(url, frame) {
    if (frame) {
      return [
        "echo '" + JSON.stringify(frame) + "' > frame.json",
        'npx ldfetch ' + url + ' --frame frame.json'
      ].join('\n');
    }
    return 'npx ldfetch ' + url;
  }

  function setStatus(statusText, isError) {
    statusEl.textContent = statusText;
    statusEl.classList.toggle('error', !!isError);
  }

  function runFetch() {
    var url = urlInput.value.trim();
    if (!url) {
      setStatus('Please enter a URL.', true);
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

    // The "prefixes used" panel shows only what the source itself declares
    // (via the live 'prefix' event, which only ever fires for prefixes the
    // parser actually encountered) -- not response.prefixes, which also
    // carries every COMMON_PREFIXES entry registered above purely to keep
    // the output text compact.
    var documentPrefixes = {};
    fetcher.on('prefix', function (prefix, iri) {
      if (!(prefix in documentPrefixes)) {
        documentPrefixes[prefix] = iri;
        renderPrefixes(documentPrefixes);
      }
    });

    var quadCount = 0;
    // Jelly-RDF's 'message' event fires before the individual quads it
    // contains reach 'quad' (verified: message, then its quads). Once we
    // know a source is message-framed, the flat output panel gets hidden
    // anyway ("when messages, only have the messages output"), so feeding
    // it quad-by-quad is wasted work -- and for a source with hundreds of
    // thousands of quads, that waste alone is enough to hang the tab. Stop
    // as soon as we see the first message.
    var messageModeDetected = false;
    fetcher.on('quad', function (quad) {
      if (messageModeDetected) return;
      quadCount++;
      if (writer) writer.addQuad(quad);
      setStatus('Fetching … ' + quadCount + ' triple' + (quadCount === 1 ? '' : 's') + ' so far');
    });
    fetcher.on('message', function (quadsInMessage) {
      if (!messageModeDetected) {
        messageModeDetected = true;
        outputCm.setValue('');
      }
      quadCount += quadsInMessage.length;
      receiveMessage(quadsInMessage);
      var total = windowStartIndex + currentMessages.length + pendingMessages.length;
      setStatus('Fetching … ' + quadCount + ' triple' + (quadCount === 1 ? '' : 's') + ' in ' + total + ' message' + (total === 1 ? '' : 's') + ' so far');
    });

    fetcher.get(url).then(function (response) {
      if (writer) writer.end();
      renderPrefixes(documentPrefixes);
      finishMessages();
      // RDF Messages are a sequence of discrete messages, not one document --
      // when the source is message-framed, the slider below is the whole
      // story, so skip the flat merged/framed output entirely.
      var hasMessages = currentMessages.length > 0;
      outputPanel.hidden = hasMessages;
      codeJsEl.textContent = jsSnippet(url, frame, hasMessages);
      codeCliEl.textContent = cliSnippet(url, frame);

      if (hasMessages) {
        var messageTotal = windowStartIndex + currentMessages.length + pendingMessages.length;
        setStatus('Done: ' + response.triples.length + ' triples in ' + messageTotal + ' messages from ' + response.url);
        fetchBtn.disabled = false;
        return;
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
        setStatus('Done: ' + response.triples.length + ' triples from ' + response.url);
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
    updateHash();

    if (example.streaming) {
      startStreamingExample(example.url);
    } else {
      runFetch();
    }
  });

  window.addEventListener('hashchange', function () {
    if (applyHash()) runFetch();
  });

  applyHash();
  updateFormatUi();
  updateHash();
  runFetch();
});
