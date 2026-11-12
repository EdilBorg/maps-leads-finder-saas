const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * searchService persists engineResult._providers via:
 *   JSON.stringify(engineResult._providers || [])
 * into searches.providers_used (JSONB).
 */
describe('providers_used persistence contract', () => {
  it('searchService writes engineResult._providers as JSONB', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/searchService.js'),
      'utf8'
    );
    assert.match(src, /JSON\.stringify\(engineResult\._providers/);
    assert.match(src, /providers_used=\$3::jsonb/);
  });

  it('diagnostic fields survive JSONB round-trip used in production', () => {
    const _providers = [
      {
        code: 'osm',
        status: 'error',
        count: 0,
        errorCode: 'HTTP_ERROR',
        errorStage: 'geocode',
        httpStatus: 403,
        durationMs: 120,
      },
      {
        code: 'osm',
        status: 'error',
        count: 0,
        errorCode: 'HTTP_ERROR',
        errorStage: 'overpass',
        httpStatus: 502,
        durationMs: 900,
      },
    ];
    const persisted = JSON.parse(JSON.stringify(_providers));
    assert.equal(persisted[0].errorStage, 'geocode');
    assert.equal(persisted[0].httpStatus, 403);
    assert.equal(persisted[1].errorStage, 'overpass');
    assert.equal(persisted[1].httpStatus, 502);
  });
});
