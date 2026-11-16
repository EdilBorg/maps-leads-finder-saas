/**
 * Search API — authenticated, CSRF on mutations.
 * Async start + status + cancel + results.
 * CRM Stage 1+2: saved leads, status/notes, activities history, appointments.
 */
const express = require('express');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const searchService = require('../services/searchService');
const activitiesService = require('../services/savedLeadActivities');
const appointmentsService = require('../services/savedLeadAppointments');
const { ALLOWED_LIMITS, normalizeLimit } = require('../services/searchEngine');
const { isUuid } = require('../db/tenantLocks');

function rejectInvalidUuid(res, value, label) {
  if (!isUuid(value)) {
    res.status(400).json({ error: `${label} inválido.` });
    return true;
  }
  return false;
}

const router = express.Router();

router.post('/', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const query = String(req.body.query || req.body.category || '').trim();
    const location = String(req.body.location || '').trim();
    const limit = normalizeLimit(req.body.limit);
    const filters = {
      hasPhone: Boolean(req.body.hasPhone),
      hasEmail: Boolean(req.body.hasEmail),
      noWebsite: Boolean(req.body.noWebsite),
      minRating: req.body.minRating != null && req.body.minRating !== '' ? Number(req.body.minRating) : null,
      minReviews: req.body.minReviews ? 1 : null,
    };

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Indica uma categoria ou termo de pesquisa.' });
    }
    if (!location || location.length < 2) {
      return res.status(400).json({ error: 'Indica uma localização.' });
    }
    if (!ALLOWED_LIMITS.includes(limit)) {
      return res.status(400).json({ error: 'Limite inválido. Usa 100, 200, 300, 400 ou 500.' });
    }

    const result = await searchService.startSearch({
      userId: req.session.userId,
      query,
      location,
      filters,
      limit,
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'QUOTA') {
      return res.status(402).json({ error: err.message, code: 'QUOTA' });
    }
    return next(err);
  }
});

router.get('/', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const items = await searchService.listSearches(req.session.userId, { limit, offset });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.get('/dashboard', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const stats = await searchService.dashboardStats(req.session.userId);
    return res.json(stats);
  } catch (err) {
    return next(err);
  }
});

router.get('/leads/saved', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const data = await searchService.listSavedLeads(req.session.userId, {
      limit,
      offset,
      q: req.query.q,
      status: req.query.status,
      category: req.query.category,
      sort: req.query.sort,
    });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.get('/leads/saved/:id', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const lead = await searchService.getSavedLead(req.session.userId, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.json({ lead });
  } catch (err) {
    return next(err);
  }
});

router.patch('/leads/saved/:id', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'status')) patch.status = body.status;
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) patch.notes = body.notes;
    const lead = await searchService.updateSavedLead(req.session.userId, req.params.id, patch);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.json({ lead });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});


router.get('/leads/saved/:id/activities', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    const data = await activitiesService.listActivities(req.session.userId, req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    if (!data) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/leads/saved/:id/activities', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    const body = req.body || {};
    const activity = await activitiesService.createActivity(req.session.userId, req.params.id, {
      activityType: body.activityType,
      description: body.description,
      outcome: body.outcome,
      occurredAt: body.occurredAt,
    });
    if (!activity) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.status(201).json({ activity });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

router.get('/leads/saved/:id/appointments', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    const data = await appointmentsService.listAppointments(req.session.userId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/leads/saved/:id/appointments', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    const body = req.body || {};
    const appointment = await appointmentsService.createAppointment(req.session.userId, req.params.id, {
      title: body.title,
      description: body.description,
      scheduledAt: body.scheduledAt,
    });
    if (!appointment) return res.status(404).json({ error: 'Lead não encontrado.' });
    return res.status(201).json({ appointment });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

router.get('/leads/saved/:id/appointments/:appointmentId', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    if (rejectInvalidUuid(res, req.params.appointmentId, 'Identificador do agendamento')) return;
    const appointment = await appointmentsService.getAppointment(
      req.session.userId, req.params.id, req.params.appointmentId
    );
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    return res.json({ appointment });
  } catch (err) {
    return next(err);
  }
});

router.patch('/leads/saved/:id/appointments/:appointmentId', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    if (rejectInvalidUuid(res, req.params.appointmentId, 'Identificador do agendamento')) return;
    const body = req.body || {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'title')) patch.title = body.title;
    if (Object.prototype.hasOwnProperty.call(body, 'description')) patch.description = body.description;
    if (Object.prototype.hasOwnProperty.call(body, 'scheduledAt')) patch.scheduledAt = body.scheduledAt;
    const appointment = await appointmentsService.updateAppointment(
      req.session.userId, req.params.id, req.params.appointmentId, patch
    );
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    return res.json({ appointment });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

router.post('/leads/saved/:id/appointments/:appointmentId/complete', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    if (rejectInvalidUuid(res, req.params.appointmentId, 'Identificador do agendamento')) return;
    const appointment = await appointmentsService.completeAppointment(
      req.session.userId, req.params.id, req.params.appointmentId
    );
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    return res.json({ appointment });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

router.post('/leads/saved/:id/appointments/:appointmentId/cancel', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (rejectInvalidUuid(res, req.params.id, 'Identificador do lead')) return;
    if (rejectInvalidUuid(res, req.params.appointmentId, 'Identificador do agendamento')) return;
    const appointment = await appointmentsService.cancelAppointment(
      req.session.userId, req.params.id, req.params.appointmentId
    );
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    return res.json({ appointment });
  } catch (err) {
    if (err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
});

router.post('/leads/save', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.resultIds) ? req.body.resultIds : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'Seleciona pelo menos um resultado.' });
    }
    const result = await searchService.saveLeadsFromResults(req.session.userId, ids.slice(0, 500));
    return res.status(201).json({
      savedCount: result.savedCount,
      alreadySavedCount: result.alreadySavedCount,
      saved: result.saved,
      alreadySaved: result.alreadySaved,
    });
  } catch (err) {
    return next(err);
  }
});


// ——— Delete saved leads ———
router.delete('/leads/saved/:id', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }
    const result = await searchService.deleteSavedLeads(req.session.userId, [req.params.id]);
    if (!result.deletedCount) {
      return res.status(404).json({ error: 'Lead não encontrado.' });
    }
    return res.json({ deletedCount: result.deletedCount, deletedIds: result.deletedIds });
  } catch (err) {
    return next(err);
  }
});

router.post('/leads/saved/delete', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (req.body && req.body.all === true) {
      const result = await searchService.deleteAllSavedLeads(req.session.userId);
      return res.json({ deletedCount: result.deletedCount });
    }
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter((id) => isUuid(id)).slice(0, 500);
    if (!valid.length) {
      return res.status(400).json({ error: 'Selecciona pelo menos um lead válido.' });
    }
    const result = await searchService.deleteSavedLeads(req.session.userId, valid);
    return res.json({ deletedCount: result.deletedCount, deletedIds: result.deletedIds });
  } catch (err) {
    return next(err);
  }
});

// ——— Delete searches (history) ———
router.delete('/:id', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }
    const result = await searchService.deleteSearches(req.session.userId, [req.params.id]);
    if (result.skippedRunning && result.skippedRunning.length) {
      return res.status(409).json({
        error: 'Não é possível eliminar uma pesquisa em execução. Cancela-a primeiro.',
        skippedRunning: result.skippedRunning,
      });
    }
    if (!result.deletedCount) {
      return res.status(404).json({ error: 'Pesquisa não encontrada.' });
    }
    return res.json({ deletedCount: result.deletedCount, deletedIds: result.deletedIds });
  } catch (err) {
    return next(err);
  }
});

router.post('/delete', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (req.body && req.body.all === true) {
      const result = await searchService.deleteAllSearches(req.session.userId);
      return res.json({
        deletedCount: result.deletedCount,
        skippedRunning: result.skippedRunning || [],
      });
    }
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids.filter((id) => isUuid(id)).slice(0, 500);
    if (!valid.length) {
      return res.status(400).json({ error: 'Selecciona pelo menos uma pesquisa válida.' });
    }
    const result = await searchService.deleteSearches(req.session.userId, valid);
    if (result.skippedRunning && result.skippedRunning.length && !result.deletedCount) {
      return res.status(409).json({
        error: 'As pesquisas seleccionadas estão em execução. Cancela-as primeiro.',
        skippedRunning: result.skippedRunning,
      });
    }
    return res.json({
      deletedCount: result.deletedCount,
      deletedIds: result.deletedIds,
      skippedRunning: result.skippedRunning || [],
    });
  } catch (err) {
    return next(err);
  }
});

// ——— Delete activities ———
router.delete('/leads/saved/:id/activities/:activityId', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.activityId)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }
    const result = await activitiesService.deleteActivity(
      req.session.userId, req.params.id, req.params.activityId
    );
    if (!result.deleted) {
      return res.status(404).json({ error: 'Actividade não encontrada.' });
    }
    return res.json({ deleted: true, id: result.id });
  } catch (err) {
    return next(err);
  }
});

router.delete('/leads/saved/:id/activities', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }
    const result = await activitiesService.clearActivities(req.session.userId, req.params.id);
    return res.json({ deletedCount: result.deletedCount });
  } catch (err) {
    if (err && err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message || 'Lead não encontrado.' });
    }
    return next(err);
  }
});


router.get('/:id/status', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const data = await searchService.getSearchStatus(req.session.userId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/cancel', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const result = await searchService.cancelSearch(req.session.userId, req.params.id);
    if (!result.ok && result.reason === 'not_found') {
      return res.status(404).json({ error: 'Pesquisa não encontrada.' });
    }
    if (!result.ok && result.reason === 'not_running') {
      return res.status(409).json({ error: 'A pesquisa já não está em execução.', status: result.status });
    }
    return res.json({ searchId: req.params.id, status: 'cancelled' });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/results', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const data = await searchService.getSearchResults(req.session.userId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
