/**
 * Authorisation gate: trial vs paid quotas per provider.
 * SEE LOCAL COMMIT de9cb71 - full content must be restored.
 * Placeholder was accidental; this is an emergency stub.
 * DO NOT USE IN PRODUCTION.
 */
module.exports = {
  authorizeAndReserve: async () => { throw new Error('quotaService.js incomplete on remote - restore from local de9cb71'); },
  releaseAllReservations: async () => { throw new Error('quotaService.js incomplete on remote - restore from local de9cb71'); },
  markPendingRemote: async () => { throw new Error('quotaService.js incomplete on remote - restore from local de9cb71'); },
  commitProviderMetrics: async () => { throw new Error('quotaService.js incomplete on remote - restore from local de9cb71'); },
  resolvePendingRemoteAfterCommit: async () => ({ ok: false }),
  getClientQuotaView: async () => ({}),
  findActivePendingRemote: async () => null,
};
