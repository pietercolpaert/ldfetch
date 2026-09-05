'use strict';

var rdfWriter = require('rdf-writer-ts');

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
  var applyingHash = false;
  var currentMessages = [];

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
    messagePosition.textContent = 'message ' + (index + 1) + ' of ' + currentMessages.length;
    messageCm.setValue(serializeMessage(currentMessages[index]));
  }

  // Only formats/documents with real RDF Message framing (e.g. Turtle/TriG
  // "-messages" versions, or Jelly-RDF, which is inherently message-framed)
  // ever populate response.messages; everything else hides this panel.
  function showMessages (messages) {
    currentMessages = messages || [];
    if (!currentMessages.length) {
      messagesPanel.hidden = true;
      return;
    }
    messagesPanel.hidden = false;
    messageSlider.max = String(currentMessages.length - 1);
    renderMessage(0);
    messageCm.refresh();
  }

  messageSlider.addEventListener('input', function () {
    renderMessage(parseInt(messageSlider.value, 10));
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

  function jsSnippet(url, frame) {
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
    renderPrefixes({});
    showMessages([]);
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

    var quadCount = 0;
    fetcher.on('quad', function (quad) {
      quadCount++;
      if (writer) writer.addQuad(quad);
      setStatus('Fetching … ' + quadCount + ' triple' + (quadCount === 1 ? '' : 's') + ' so far');
    });

    fetcher.get(url).then(function (response) {
      if (writer) writer.end();
      renderPrefixes(response.prefixes);
      showMessages(response.messages);
      codeJsEl.textContent = jsSnippet(url, frame);
      codeCliEl.textContent = cliSnippet(url, frame);

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

  window.addEventListener('hashchange', function () {
    if (applyHash()) runFetch();
  });

  applyHash();
  updateFormatUi();
  updateHash();
  runFetch();
});
