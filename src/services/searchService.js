'use strict';
const parts = [
  require('./searchService.chunk0'),
  require('./searchService.chunk1'),
  require('./searchService.chunk2'),
  require('./searchService.chunk3'),
  require('./searchService.chunk4'),
].join('');
const src = Buffer.from(parts, 'base64').toString('utf8');
const Module = require('module');
const path = require('path');
const m = new Module(__filename);
m.filename = path.join(__dirname, 'searchService.compiled.js');
m.paths = module.paths;
m._compile(src, m.filename);
module.exports = m.exports;
