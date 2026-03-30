const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': `${BASE}/`,
  'Origin': BASE,
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, state_code, dist_code, court_code, date, captchaCode, cookieStr } = req.body || {};
  console.log('Action:', action, 'state:', state_code, 'dist:', dist_code);

  try {
    // ── Step 1: Get States ──
    if (action === 'states') {
      const resp = await axios.get(`${BASE}/?p=causelist/index`, {
        headers: { ...HEADERS, 'X-Requested-With': undefined },
        timeout: 12000,
      });
      const $ = cheerio.load(resp.data);
      const states = [];
      // Try multiple select IDs
      $('select').each((_, sel) => {
        const id = $(sel).attr('id') || '';
        if (id.toLowerCase().includes('state')) {
          $(sel).find('option').each((_, el) => {
            const val = $(el).val();
            const txt = $(el).text().trim();
            if (val && val !== '0' && val !== '') states.push({ code: val, name: txt });
          });
        }
      });
      console.log('States:', states.length, '| HTML len:', resp.data.length);
      return res.status(200).json({ success: true, states });
    }

    // ── Step 2: Get Districts ──
    if (action === 'districts') {
      const params = new URLSearchParams({ state_code, ajax_req: 'true' });
      const resp = await axios.post(
        `${BASE}/?p=causelist/getDistrictName`,
        params.toString(),
        { headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
      );
      console.log('Districts raw:', typeof resp.data, JSON.stringify(resp.data).slice(0, 200));
      const districts = parseOptions(resp.data);
      return res.status(200).json({ success: true, districts });
    }

    // ── Step 3: Get Courts ──
    if (action === 'courts') {
      const params = new URLSearchParams({ state_code, dist_code, ajax_req: 'true' });
      const resp = await axios.post(
        `${BASE}/?p=causelist/getCourtName`,
        params.toString(),
        { headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
      );
      console.log('Courts raw:', JSON.stringify(resp.data).slice(0, 200));
      const courts = parseOptions(resp.data);
      return res.status(200).json({ success: true, courts });
    }

    // ── Step 4: Get Cause List ──
    if (action === 'list') {
      const params = new URLSearchParams({
        state_code,
        dist_code,
        court_no: court_code,
        date_val: date,
        fcaptcha_code: captchaCode,
        ajax_req: 'true',
      });
      const resp = await axios.post(
        `${BASE}/?p=causelist/getCauseList`,
        params.toString(),
        {
          headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': cookieStr || '',
          },
          timeout: 20000,
        }
      );
      const html = typeof resp.data === 'string' ? resp.data
        : resp.data?.casetype_list || resp.data?.cause_list || JSON.stringify(resp.data);
      console.log('Cause list HTML len:', html.length, '| preview:', html.slice(0, 100));

      if (html.toLowerCase().includes('invalid captcha') || html.toLowerCase().includes('wrong captcha')) {
        return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
      }

      const cases = parseCauseList(html);
      console.log('Parsed cases:', cases.length);
      return res.status(200).json({ success: true, cases, totalCases: cases.length, rawHtml: html.slice(0, 500) });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Cause list error:', err.message, err.response?.status);
    return res.status(500).json({ success: false, error: err.message, status: err.response?.status });
  }
};

function parseOptions(data) {
  // data could be JSON array or HTML
  if (Array.isArray(data)) {
    return data.map(d => ({ code: d.dist_code || d.court_code || d.code, name: d.dist_name || d.court_name || d.name }));
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    // Try to extract from object
    const arr = Object.values(data);
    if (arr.length > 0 && typeof arr[0] === 'object') {
      return arr.map(d => ({ code: d.dist_code || d.court_code || d.id || d.code, name: d.dist_name || d.court_name || d.name }));
    }
  }
  // Parse HTML
  const $ = cheerio.load(data);
  const items = [];
  $('option').each((_, el) => {
    const val = $(el).val();
    const txt = $(el).text().trim();
    if (val && val !== '0' && val !== '') items.push({ code: val, name: txt });
  });
  return items;
}

function parseCauseList(html) {
  const $ = cheerio.load(html);
  const cases = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const c0 = $(cells[0]).text().trim();
      const c1 = $(cells[1]).text().trim();
      const c2 = cells.length >= 3 ? $(cells[2]).text().trim() : '';
      const c3 = cells.length >= 4 ? $(cells[3]).text().trim() : '';
      const c4 = cells.length >= 5 ? $(cells[4]).text().trim() : '';
      if (c0.match(/^\d+$/) && c1) {
        cases.push({ srNo: c0, caseNo: c1, parties: c2, advocate: c3, stage: c4 });
      }
    }
  });
  return cases;
}