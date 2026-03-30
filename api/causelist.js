const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, state_code, dist_code, court_code, date, captchaCode, cookieStr } = req.body || {};

  try {
    // ── Step 1: Get States ──────────────────────────────
    if (action === 'states') {
      const resp = await axios.get(`${BASE}/?p=causelist/index`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `${BASE}/` },
        timeout: 10000,
      });
      const $ = cheerio.load(resp.data);
      const states = [];
      $('#sess_state_code option').each((_, el) => {
        const val = $(el).val();
        const txt = $(el).text().trim();
        if (val && val !== '0') states.push({ code: val, name: txt });
      });
      console.log('States found:', states.length);
      return res.status(200).json({ success: true, states });
    }

    // ── Step 2: Get Districts ───────────────────────────
    if (action === 'districts') {
      const params = new URLSearchParams({ state_code, ajax_req: 'true' });
      const resp = await axios.post(`${BASE}/?p=causelist/getDistrictName`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE}/`,
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 10000,
      });
      const $ = cheerio.load(resp.data);
      const districts = [];
      $('option').each((_, el) => {
        const val = $(el).val();
        const txt = $(el).text().trim();
        if (val && val !== '0') districts.push({ code: val, name: txt });
      });
      console.log('Districts found:', districts.length);
      return res.status(200).json({ success: true, districts });
    }

    // ── Step 3: Get Courts ──────────────────────────────
    if (action === 'courts') {
      const params = new URLSearchParams({ state_code, dist_code, ajax_req: 'true' });
      const resp = await axios.post(`${BASE}/?p=causelist/getCourtName`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE}/`,
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 10000,
      });
      const $ = cheerio.load(resp.data);
      const courts = [];
      $('option').each((_, el) => {
        const val = $(el).val();
        const txt = $(el).text().trim();
        if (val && val !== '0') courts.push({ code: val, name: txt });
      });
      console.log('Courts found:', courts.length);
      return res.status(200).json({ success: true, courts });
    }

    // ── Step 4: Get Cause List ──────────────────────────
    if (action === 'list') {
      const params = new URLSearchParams({
        state_code,
        dist_code,
        court_code,
        date,
        fcaptcha_code: captchaCode,
        ajax_req: 'true',
      });
      const resp = await axios.post(`${BASE}/?p=causelist/getCauseList`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE}/`,
          'User-Agent': 'Mozilla/5.0',
          'Cookie': cookieStr || '',
        },
        timeout: 15000,
      });

      const html = typeof resp.data === 'string' ? resp.data : resp.data?.casetype_list || '';
      console.log('Cause list HTML length:', html.length);

      if (!html || html.toLowerCase().includes('invalid captcha')) {
        return res.status(200).json({ success: false, error: 'CAPTCHA galat hai' });
      }

      const $ = cheerio.load(html);
      const cases = [];

      // Parse cause list table
      $('table tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 3) {
          const srNo      = $(cells[0]).text().trim();
          const caseNo    = $(cells[1]).text().trim();
          const parties   = $(cells[2]).text().trim();
          const advocate  = cells.length >= 4 ? $(cells[3]).text().trim() : '';
          const stage     = cells.length >= 5 ? $(cells[4]).text().trim() : '';

          if (srNo.match(/^\d+$/) && caseNo) {
            cases.push({ srNo, caseNo, parties, advocate, stage });
          }
        }
      });

      console.log('Cause list cases:', cases.length);
      return res.status(200).json({ success: true, cases, totalCases: cases.length });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Cause list error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};