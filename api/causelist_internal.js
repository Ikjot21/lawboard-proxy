// api/causelist_internal.js
// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL ONLY — Diary background sync ke liye
// Koi UI nahi, koi user-facing feature nahi
// Sirf saved cases ki next hearing dates update karta hai
// ─────────────────────────────────────────────────────────────────────────────

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
const H = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer':          `${BASE}/`,
  'Origin':            BASE,
  'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Simple token check — prevent public access
  const token = req.headers['x-internal-token'] || req.body?.token || '';
  if (token !== process.env.INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { action } = req.body || {};

  // ── sync_dates: Batch update next hearing dates for saved cases ────────────
  // Input:  cases = [{ cnr, courtCode, caseNoNum, stateCode, distCode, complexCode }]
  // Output: { cnr: { nextDate, caseStage, disposal } }
  if (action === 'sync_dates') {
    const cases = req.body.cases || [];
    if (!cases.length) return res.status(200).json({ success: true, updates: {} });

    const updates = {}; // cnr → { nextDate, caseStage, disposal, caseStatus }

    await Promise.allSettled(cases.map(async (c) => {
      if (!c.cnr) return;
      try {
        const params = new URLSearchParams({
          court_code:         c.courtCode   || '1',
          state_code:         c.stateCode   || '',
          dist_code:          c.distCode    || '',
          court_complex_code: (c.complexCode || '').split('@')[0],
          case_no:            c.caseNoNum   || '',
          cino:               c.cnr,
          hideparty:          '',
          search_flag:        'CScaseNumber',
          search_by:          'CSAdvName',
          ajax_req:           'true',
          app_token:          '',
        });

        const r = await axios.post(
          `${BASE}/?p=home/viewHistory`,
          params.toString(),
          { headers: H, timeout: 8000 }
        );

        const raw  = r.data;
        const html = typeof raw === 'object' ? (raw.data_list || '') : raw;
        if (!html || html.length < 20) return;

        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        const isDisposed = /Case\s+disposed/i.test(text) ||
                           /Nature\s+of\s+Disposal/i.test(text);

        const update = {};

        // Next date — only if not disposed
        if (!isDisposed) {
          const m = text.match(/Next\s+(?:Hearing\s+)?Date\s*[:\-]?\s*(\d{2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}|\d{2}-\d{2}-\d{4})/i);
          if (m) update.nextDate = m[1].trim();
        }

        // Stage / Disposal / Status
        const mStage  = text.match(/Case\s+Stage\s+([A-Za-z0-9\s\-\.\(\)\/]+?)(?=\s{2,}|\s*Court|\s*$)/i);
        const mDisp   = text.match(/Nature\s+of\s+Disposal\s+([A-Za-z\s\-\(\)]+?)(?=\s{2,}|\s*Court|\s*$)/i);
        const mStatus = text.match(/Case\s+Status\s+([A-Za-z\s]+?)(?=\s{2,}|\s*Nature|\s*$)/i);

        if (mStage)  update.caseStage  = mStage[1].trim();
        if (mDisp)   update.disposal   = mDisp[1].trim();
        if (mStatus) update.caseStatus = mStatus[1].trim();

        if (Object.keys(update).length > 0) {
          updates[c.cnr] = update;
        }
      } catch (_) {}
    }));

    console.log(`[internal] sync_dates: ${cases.length} cases → ${Object.keys(updates).length} updated`);
    return res.status(200).json({ success: true, updates });
  }

  // ── ping: health check ────────────────────────────────────────────────────
  if (action === 'ping') {
    return res.status(200).json({ success: true, message: 'internal causelist ok' });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
};