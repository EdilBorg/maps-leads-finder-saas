'use strict';
/**
 * Bulk INSERT into search_results (parameterized, batched).
 * Used by searchService.runAndPersist inside an existing transaction client.
 */
const RESULT_INSERT_BATCH = 100;

/**
 * @param {import('pg').PoolClient} client
 * @param {{ searchId: string, userId: string }} ctx
 * @param {Array<object>} results
 * @returns {Promise<number>} number of rows inserted
 */
async function bulkInsertSearchResults(client, ctx, results) {
  const leadsToPersist = Array.isArray(results) ? results : [];
  let insertedCount = 0;
  for (let i = 0; i < leadsToPersist.length; i += RESULT_INSERT_BATCH) {
    const batch = leadsToPersist.slice(i, i + RESULT_INSERT_BATCH);
    if (!batch.length) continue;
    const values = [];
    const params = [];
    let p = 1;
    for (const lead of batch) {
      values.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`
      );
      params.push(
        ctx.searchId,
        ctx.userId,
        lead.name,
        lead.address,
        lead.phone,
        lead.email,
        lead.website,
        lead.rating,
        lead.reviewsCount,
        lead.category,
        lead.lat,
        lead.lng,
        lead.sourceProvider,
        lead.externalId,
        JSON.stringify({
          ...(lead.raw || {}),
          photoUrl: lead.photoUrl || null,
          googleMapsUrl: lead.googleMapsUrl || null,
          sources: lead.sources || [],
        })
      );
    }
    await client.query(
      `INSERT INTO search_results (
         search_id,user_id,name,address,phone,email,website,
         rating,reviews_count,category,lat,lng,source_provider,external_id,raw_payload
       ) VALUES ${values.join(',')}`,
      params
    );
    insertedCount += batch.length;
  }
  return insertedCount;
}

module.exports = { bulkInsertSearchResults, RESULT_INSERT_BATCH };
