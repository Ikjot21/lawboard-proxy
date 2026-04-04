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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    searchType, advocate_name, case_status, adv_captcha_code,
    petres_name, rgyearP, fcaptcha_code,
    state_code, dist_code, court_complex_code, est_code, cookieStr,
  } = req.body || {};

  try {
    let endpoint, params;

    if (searchType === 'advocate') {
      if (!advocate_name || advocate_name.trim().length < 3)
        return res.status(400).json({ success: false, error: 'Advocate name minimum 3 characters' });
      endpoint = 'casestatus/submitAdvName';
      params = new URLSearchParams({
        radAdvt: '1', advocate_name: advocate_name.trim(),
        adv_bar_state: '', adv_bar_code: '', adv_bar_year: '',
        case_status: case_status || 'Pending',
        caselist_date: '',
        adv_captcha_code: adv_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: court_complex_code || '',
        est_code: est_code || 'null', case_type: '',
        ajax_req: 'true', app_token: '',
      });
    } else if (searchType === 'party') {
      if (!petres_name || petres_name.trim().length < 3)
        return res.status(400).json({ success: false, error: 'Party name minimum 3 characters' });
      endpoint = 'casestatus/submitPartyName';
      params = new URLSearchParams({
        petres_name: petres_name.trim(),
        rgyearP: rgyearP || '',
        case_status: case_status || 'Pending',
        fcaptcha_code: fcaptcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: court_complex_code || '',
        est_code: est_code || 'null',
        ajax_req: 'true', app_token: '',
      });
    } else {
      return res.status(400).json({ success: false, error: 'searchType must be advocate or party' });
    }

    const resp = await axios.post(
      `${BASE}/?p=${endpoint}`,
      params.toString(),
      { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 }
    );

    const raw = resp.data;
    console.log('Raw keys:', typeof raw === 'object' ? Object.keys(raw) : 'string');

    // ── Check CAPTCHA error ──
    const rawStr = JSON.stringify(raw);
    if (rawStr.toLowerCase().includes('invalid captcha') ||
        rawStr.toLowerCase().includes('wrong captcha') ||
        (typeof raw === 'object' && raw.status === 0)) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }

    // ── Get HTML ──
    // Advocate: adv_data key | Party: casetype_list key
    let html = '';
    if (typeof raw === 'object') {
      html = raw.adv_data || raw.casetype_list || raw.case_list || raw.html || '';
      if (!html) {
        for (const v of Object.values(raw)) {
          if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
        }
      }
    } else {
      html = raw;
    }

    console.log('HTML length:', html.length);

    if (!html || html.trim().length < 20) {
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });
    }
    if (html.toLowerCase().includes('no record') || html.toLowerCase().includes('no case found')) {
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });
    }

    const results = parseResults(html);
    console.log('Results count:', results.length);
    return res.status(200).json({ success: true, results, total: results.length });

  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  let currentCourt = '';

  $('table tr').each((_, row) => {
    const cells  = $(row).find('td');
    const header = $(row).find('th[colspan]');

    // Court name header
    if (header.length) {
      const txt = header.first().text().trim();
      if (txt && txt.length < 100) currentCourt = txt;
      return;
    }

    if (cells.length < 4) return;

    const srNo = $(cells[0]).text().trim();
    if (!srNo.match(/^\d+$/)) return;

    const caseNo = $(cells[1]).text().trim().replace(/\s+/g, ' ');

    // Parties with Vs separator
    const partiesHtml = $(cells[2]).html() || '';
    const parties = partiesHtml
      .replace(/<br\s*\/?>/gi, ' Vs ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\bVs\s+Vs\b/g, 'Vs')
      .trim();

    const advocate = $(cells[3]).text().trim().replace(/\s+/g, ' ');

    // CNR from viewHistory onclick 2nd arg: viewHistory(caseNum,'CNRHERE',...)
    const viewCell = cells.length >= 5 ? $(cells[4]) : $(row);
    const onClick  = viewCell.find('a').attr('onclick') || '';
    const cnrMatch = onClick.match(/'([A-Z]{4}\d{12,16})'/);
    const cnr      = cnrMatch ? cnrMatch[1] : '';

    results.push({ srNo, caseNo, cnr, parties, advocate, court: currentCourt, nextDate: '' });
  });

  return results;
}