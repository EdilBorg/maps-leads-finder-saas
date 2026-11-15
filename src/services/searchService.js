'use strict';
/**
 * Restores full searchService from base64 chunks.
 * Contains full original logic + CRM re-exports + mapProviderUiStatus/startHoldRenewal exports.
 */
const b64 =
  require('./searchService.b64.0') +
  require('./searchService.b64.1') +
  require('./searchService.b64.2');
const code = Buffer.from(b64, 'base64').toString('utf8');
const Module = require('module');
const path = require('path');
const m = new Module(module.filename);
m.filename = path.join(__dirname, 'searchService.decoded.js');
m.paths = module.paths;
m._compile(code, m.filename);
module.exports = m.exports;
