// Default supported protocols are http(s); file:// is opt-in via { localFiles: true },
// mirroring rdf-dereference's localFiles option. Any other scheme is always rejected.
module.exports = function isAllowedProtocol (url, opts) {
  var allowed = ['http:', 'https:'];
  if (opts && opts.localFiles) {
    allowed.push('file:');
  }
  try {
    return allowed.indexOf(new URL(url).protocol) !== -1;
  } catch (e) {
    return false;
  }
};
