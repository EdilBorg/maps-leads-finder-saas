const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('search results bulk insert', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/searchService.js'), 'utf8');

  it('uses batched multi-row INSERT with RESULT_INSERT_BATCH', () => {
    assert.match(src, /RESULT_INSERT_BATCH\s*=\s*100/);
    assert.match(src, /INSERT INTO search_results/);
    assert.match(src, /values\.join\(','\)/);
    assert.doesNotMatch(src, /for \(const lead of engineResult\.results\) \{\s*\n\s*const row = await client\.query\(\s*`INSERT INTO search_results/);
  });

  it('still gates trial consume on insertedCount > 0', () => {
    assert.match(src, /insertedCount > 0/);
    assert.match(src, /needConsume/);
  });

  it('dashboardStats loads counts and recent searches in parallel', () => {
    const start = src.indexOf('async function dashboardStats');
    const body = src.slice(start, start + 800);
    assert.match(body, /Promise\.all/);
    assert.match(body, /listSearches\(userId,\s*\{\s*limit:\s*5\s*\}\)/);
  });
});

describe('CRM list parallelization', () => {
  const crm = fs.readFileSync(path.join(__dirname, '../src/services/savedLeadsCrm.js'), 'utf8');
  const act = fs.readFileSync(path.join(__dirname, '../src/services/savedLeadActivities.js'), 'utf8');
  const appt = fs.readFileSync(path.join(__dirname, '../src/services/savedLeadAppointments.js'), 'utf8');

  it('listSavedLeads runs independent queries with Promise.all', () => {
    const start = crm.indexOf('async function listSavedLeads');
    const body = crm.slice(start, start + 2500);
    assert.match(body, /Promise\.all/);
  });

  it('listActivities keeps ownership check then parallel list+count', () => {
    const start = act.indexOf('async function listActivities');
    const body = act.slice(start, start + 2000);
    assert.match(body, /saved_leads WHERE id/);
    assert.match(body, /Promise\.all/);
    assert.match(body, /return null/);
  });

  it('listAppointments uses single ownership+join query', () => {
    const start = appt.indexOf('async function listAppointments');
    const body = appt.slice(start, start + 1500);
    assert.match(body, /LEFT JOIN saved_lead_appointments/);
    assert.match(body, /FROM saved_leads/);
    assert.match(body, /return null/);
  });
});
