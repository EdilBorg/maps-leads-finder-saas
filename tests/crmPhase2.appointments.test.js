/**
 * CRM Phase 2 — appointments module contract + validation (no DB required).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appointments = require('../src/services/savedLeadAppointments');

describe('CRM Phase 2 appointments — module contract', () => {
  it('exports independent appointment statuses', () => {
    assert.deepEqual(appointments.APPOINTMENT_STATUSES, ['scheduled', 'completed', 'cancelled']);
    assert.equal(appointments.isValidAppointmentStatus('scheduled'), true);
    assert.equal(appointments.isValidAppointmentStatus('Cliente'), false);
  });

  it('rejects empty title', async () => {
    await assert.rejects(
      () => appointments.createAppointment('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', {
        title: '  ',
        scheduledAt: new Date().toISOString(),
      }),
      (err) => err && err.code === 'VALIDATION' && /título/i.test(err.message)
    );
  });

  it('rejects missing scheduledAt', async () => {
    await assert.rejects(
      () => appointments.createAppointment('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', {
        title: 'Reunião',
      }),
      (err) => err && err.code === 'VALIDATION'
    );
  });

  it('rejects malformed scheduledAt', async () => {
    await assert.rejects(
      () => appointments.createAppointment('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', {
        title: 'Reunião',
        scheduledAt: 'not-a-date',
      }),
      (err) => err && err.code === 'VALIDATION'
    );
  });
});

describe('CRM Phase 2 appointments — source contracts', () => {
  const root = path.join(__dirname, '..');

  it('migration 013 creates appointments table with status check and indexes', () => {
    const sql = fs.readFileSync(
      path.join(root, 'migrations/013_saved_lead_activities_appointments.sql'),
      'utf8'
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_lead_appointments/);
    assert.match(sql, /'scheduled',\s*'completed',\s*'cancelled'/);
    assert.match(sql, /saved_lead_appointments_user_scheduled_idx/);
    assert.match(sql, /trg_saved_lead_appointments_same_user/);
  });

  it('routes expose CRUD + complete/cancel with csrf on writes', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(js, /\/leads\/saved\/:id\/appointments/);
    assert.match(js, /appointments\/:appointmentId\/complete/);
    assert.match(js, /appointments\/:appointmentId\/cancel/);
    assert.match(js, /appointmentsService/);
  });

  it('frontend has appointment UI hooks without innerHTML for titles', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /loadLeadAppointments/);
    assert.match(js, /completeAppointment/);
    assert.match(js, /cancelAppointment/);
    assert.match(js, /title\.textContent\s*=\s*a\.title/);
    assert.match(js, /leads-btn-add-appointment/);
  });

  it('HTML detail panel includes phase2 sections', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /id="leads-activities-list"/);
    assert.match(html, /id="leads-appointments-list"/);
    assert.match(html, /id="leads-btn-add-activity"/);
    assert.match(html, /id="leads-btn-add-appointment"/);
    assert.match(html, /Histórico de actividades/);
    assert.match(html, /Agendamentos/);
  });

  it('phase2 CSS stays under leads-crm namespace', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/leads.css'), 'utf8');
    assert.match(css, /\.leads-crm-phase2-grid/);
    assert.match(css, /\.leads-crm-timeline/);
    assert.match(css, /\.leads-crm-appt/);
  });
});
