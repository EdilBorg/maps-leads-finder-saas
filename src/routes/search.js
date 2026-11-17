/**
 * Search API — authenticated, CSRF on mutations.
 * Async start + status + cancel + results.
 * CRM Stage 1+2: saved leads, status/notes, activities history, appointments.
 */
'use strict';

const express = require('express');
const router = express.Router();
const searchService = require('../services/searchService');
const activitiesService = require('../services/savedLeadActivities');
const appointmentsService = require('../services/savedLeadAppointments');
const { requireAuth, requireVerifiedEmail, requireCsrf } = require('../middleware/auth');
const { isUuid } = require('../utils/validators');

function rejectInvalidUuid(res, id, label) {
  if (!isUuid(id)) {
    res.status(400).json({ error: (label || 'Identificador') + ' inválido.' });
    return true;
  }
  return false;
}

// NOTE: This is a RESTORE of search.js - the full file must be complete.
// If this message appears in production, the restore was incomplete.
