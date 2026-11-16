/**
 * CRM Phase 2 — activities module contract + validation (no DB required).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const activities = require('../src/services/savedLeadActivities');
const crm = require('../src/services/savedLeadsCrm');

describe('CRM Phase 2 activities — module contract', () => {
  it('exports manual types without status_change for user creation', () => {
    assert.ok(activities.MANUAL_ACTIVITY_TYPES.includes('phone_call'));
    assert.ok(activities.MANUAL_ACTIVITY_TYPES.includes('whatsapp'));
    assert.ok(activities.MANUAL_ACTIVITY_TYPES.includes('meeting'));
    assert.ok(activities.MANUAL_ACTIVITY_TYPES.includes('other'));
    assert.ok(!activities.MANUAL_ACTIVITY_TYPES.includes('status_change'));
    assert.ok(activities.ACTIVITY_TYPES.includes('status_change'));
  });

  it('validates activity types', () => {
    assert.equal(activities.isValidManualActivityType('phone_call'), true);
    assert.equal(activities.isValidManualActivityType('status_change'), false);
    assert.equal(activities.isValidActivityType('status_change'), true);
    assert.equal(activities.isValidActivityType('bogus'), false);
  });

  it('rejects empty description via createActivity validation path', async () => {
    await assert.rejects(
      () => activities.createActivity('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', {
        activityType: 'phone_call',
        description: '   ',
      }),
      (err) => err && err.code === 'VALIDATION'
    );
  });

  it('rejects invalid activity type', async () => {
    await assert.rejects(
      () => activities.createActivity('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', {
        activityType: 'status_change',
        description: 'should not work from public create',
      }),
      (err) => err && err.code === 'VALIDATION'
    );
  });

  it('updateSavedLead still exports and CRM statuses unchanged', () => {
    assert.equal(typeof crm.updateSavedLead, 'function');
    assert.equal(crm.CRM_STATUSES.length, 8);
    assert.ok(crm.CRM_STATUSES.includes('Por contactar'));
    assert.ok(crm.CRM_STATUSES.includes('Cliente'));
  });
});

describe('CRM Phase 2 activities — source contracts', () => {
  const root = path.join(__dirname, '..');

  it('migration 013 creates activities table and multi-tenant trigger', () => {
    const sql = fs.readFileSync(
      path.join(root, 'migrations/013_saved_lead_activities_appointments.sql'),
      'utf8'
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_lead_activities/);
    assert.match(sql, /status_change/);
    assert.match(sql, /trg_saved_lead_activities_same_user/);
    assert.match(sql, /EXECUTE PROCEDURE/);
  });

  it('routes expose activities endpoints with auth and csrf on write', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(js, /\/leads\/saved\/:id\/activities/);
    assert.match(js, /router\.post\('\/leads\/saved\/:id\/activities'/);
    assert.match(js, /requireCsrf/);
    assert.match(js, /activitiesService/);
  });

  it('updateSavedLead uses insertStatusChangeActivity in same transaction path', () => {
    const js = fs.readFileSync(path.join(root, 'src/services/savedLeadsCrm.js'), 'utf8');
    assert.match(js, /insertStatusChangeActivity/);
    assert.match(js, /BEGIN/);
    assert.match(js, /FOR UPDATE/);
    assert.match(js, /nextStatus !== prevStatus/);
  });

  it('frontend uses textContent for activity rendering (no innerHTML on user data)', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /loadLeadActivities/);
    assert.match(js, /leads-crm-activity/);
    assert.match(js, /ACTIVITY_TYPE_LABEL/);
    // activity description should use textContent
    assert.match(js, /desc\.textContent\s*=\s*a\.description/);
  });
});
