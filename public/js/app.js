(function () {
  var parts = window.__MLF_APP_PARTS;
  if (!parts || parts.length < 3) {
    console.error('Maps Leads Finder: incomplete app parts', parts && parts.length);
    return;
  }
  var code = parts[0] + parts[1] + parts[2];
  // Run the bundled SPA
  (0, eval)(code);
})();
