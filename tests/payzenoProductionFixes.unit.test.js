const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pz = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const mig020 = fs.readFileSync(path.join(root, 'migrations/020_webhook_status_backfill_fix.sql'), 'utf8');
const payzeno = require('../src/services/payzenoService');

describe('checkout multi-tenant idempotency', () => {
  it('namespaces keys by userId and does not use plan+method alone', () => {
    assert.match(pz, /payzeno:u:\$\{userId\}/);
    assert.ok(!/idempotencyKey \|\| `payzeno:\$\{userId\}:\$\{planId\}:\$\{method\}`/.test(pz));
    assert.match(pz, /AND user_id = \$2/);
    assert.match(pz, /OWNERSHIP/);
  });
  it('frontend does not send shared plan+method key', () => {
    assert.ok(!/payzeno:' \+ pro\.id \+ ':' \+ methodEl/.test(front));
    assert.match(front, /randomUUID|clientToken/);
  });
});

describe('subscription UX compact', () => {
  it('single primary CTA and no redundant plan catalog on page', () => {
    assert.match(html, /page-heading\">Subscrição/);
    assert.ok(!/Planos e utilização/.test(html));
    assert.match(front, /btn-open-subscribe-modal/);
    assert.ok(!/Reservados:/.test(front));
  });
  it('shows trial vs pro status distinctly', () => {
    assert.match(front, /Trial esgotado/);
    assert.match(front, /statusLabel/);
  });
});

describe('migration 020 backfill', () => {
  it('marks processed only when payment completed', () => {
    assert.match(mig020, /p\.status IN \('completed', 'approved'\)/);
    assert.match(mig020, /ELSE 'failed'/);
    assert.ok(!/processed_at IS NOT NULL/.test(mig020));
    assert.match(mig020, /LOWER\(COALESCE\(e\.event_type, ''\)\)/);
    assert.match(mig020, /'payment\.succeeded'/);
    assert.match(mig020, /WHERE e\.processing_status IN \('received', 'processed'\)/);
    assert.match(mig020, /ELSE 'failed'/);
  });
});

describe('HMAC fail-closed until official PayZeno contract is confirmed', () => {
  it('rejects a signature even when a secret and matching body HMAC are supplied', () => {
    const raw = '{"event":"payment.succeeded","status":"succeeded"}';
    const secret = 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');

    const result = payzeno.verifyWebhookSignature({
      rawBody: raw,
      signature,
      secret,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SIGNATURE_CONTRACT_UNCONFIRMED');
    assert.equal(result.documented, false);
  });

  it('does not accept speculative timestamp.body signatures', () => {
    const raw = '{"event":"payment.succeeded"}';
    const secret = 'test-secret';
    const timestamp = '1795290000';
    const signature = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${raw}`).digest('hex');

    assert.equal(payzeno.verifyWebhookSignature({
      rawBody: raw,
      signature,
      timestamp,
      secret,
    }).ok, false);
  });
});
