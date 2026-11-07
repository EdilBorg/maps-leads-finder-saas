/**
 * Search API — authenticated, CSRF on mutations, no provider names in responses.
 */

const express = require('express');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const searchService = require('../services/searchService');

const router = express.Router();

function parseModality(value) {
  return value === 'expanded' ? 'expanded' : 'standard';
}

router.post('/', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const query = String(req.body.query || req.body.category || '').trim();
    const location = String(req.body.location || '').trim();
    const modality = parseModality(req.body.modality);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 100, 1), 500);
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

    const result = await searchService.runAndPersist({
      userId: req.session.userId,
      modality,
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const items = await searchService.listSavedLeads(req.session.userId, { limit, offset });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.post('/leads/save', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.resultIds) ? req.body.resultIds : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'Seleciona pelo menos um resultado.' });
    }
    const saved = await searchService.saveLeadsFromResults(req.session.userId, ids.slice(0, 100));
    return res.status(201).json({
      saved: saved.map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        phone: s.phone,
        email: s.email,
        website: s.website,
        createdAt: s.created_at,
      })),
    });
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
