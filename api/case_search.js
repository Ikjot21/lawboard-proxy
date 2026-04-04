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
    searchType,       // 'advocate' | 'party'
    // Advocate fields
    advocate_name,
    case_status,
    caselist_date,
    adv_captcha_code,
    // Party fields
    petres_name,
    rgyearP,
    fcaptcha_code,
    // Common
    state_code,
    dist_code,
    court_complex_code,
    est_code,
    cookieStr,
  } = req.body || {};

  try {
    let endpoint, params;

    // ── Advocate Search ──────────────────────────────────────────────────────
    if (searchType === 'advocate') {
      if (!advocate_name || advocate_name.trim().length < 3) {
        return res.status(400).json({ success: false, error: 'Advocate name minimum 3 characters' });
      }
      endpoint = 'casestatus/submitAdvName';
      params = new URLSearchParams({
        radAdvt:           '1',
        advocate_name:     advocate_name.trim(),
        adv_bar_state:     '',
        adv_bar_code:      '',
        adv_bar_year:      '',
        case_status:       case_status || 'Pending',
        caselist_date:     caselist_date || '',
        adv_captcha_code:  adv_captcha_code?.trim() || '',
        state_code:        state_code || '',
        dist_code:         dist_code || '',
        court_complex_code: court_complex_code || '',
        est_code:          est_code || 'null',
        case_type:         '',
        ajax_req:          'true',
        app_token:         '',
      });
    }

    // ── Party Name Search ────────────────────────────────────────────────────
    else if (searchType === 'party') {
      if (!petres_name || petres_name.trim().length < 3) {
        return res.status(400).json({ success: false, error: 'Party name minimum 3 characters' });
      }
      endpoint = 'casestatus/submitPartyName';
      params = new URLSearchParams({
        petres_name:        petres_name.trim(),
        rgyearP:            rgyearP || '',
        case_status:        case_status || 'Pending',
        fcaptcha_code:      fcaptcha_code?.trim() || '',
        state_code:         state_code || '',
        dist_code:          dist_code || '',
        court_complex_code: court_complex_code || '',
        est_code:           est_code || 'null',
        ajax_req:           'true',
        app_token:          '',
      });
    }

    else {
      return res.status(400).json({ success: false, error: 'searchType must be advocate or party' });
    }

    const resp = await axios.post(
      `${BASE}/?p=${endpoint}`,
      params.toString(),
      {
        headers: { ...H, 'Cookie': cookieStr || '' },
        timeout: 15000,
      }
    );

    const raw = resp.data;
    console.log('Search raw keys:', typeof raw === 'object' ? Object.keys(raw) : 'string');

    // ── Check errors ─────────────────────────────────────────────────────────
    const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);

    if (rawStr.toLowerCase().includes('invalid captcha') ||
        rawStr.toLowerCase().includes('wrong captcha')) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }

    // ── Get HTML ──────────────────────────────────────────────────────────────
    // eCourts returns { casetype_list: "<html>", status: 1 } or similar
    let html = '';
    if (typeof raw === 'object') {
      html = raw.casetype_list || raw.case_list || raw.html ||
             raw.adv_list || raw.party_list || '';
      // If still empty, check all string values
      if (!html) {
        for (const v of Object.values(raw)) {
          if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
        }
      }
    } else {
      html = raw;
    }

    if (!html || html.trim().length < 10) {
      console.log('Raw response:', rawStr.substring(0, 300));
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });
    }

    if (html.toLowerCase().includes('no record') ||
        html.toLowerCase().includes('not found') ||
        html.toLowerCase().includes('no case')) {
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });
    }

    // ── Parse Results ─────────────────────────────────────────────────────────
    const results = parseResults(html);
    console.log(`${searchType} results:`, results.length);

    return res.status(200).json({ success: true, results, total: results.length });

  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Parse case list HTML ──────────────────────────────────────────────────────
function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  // eCourts case list is usually a table with View button + case details
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    // First cell — serial number or View button
    const first = $(cells[0]).text().trim();
    if (!first.match(/^\d+$/) && !$(cells[0]).find('a,button').length) return;

    // Extract CNR from onclick or link
    const onclick = $(row).find('a[onclick]').attr('onclick') || '';
    const cnrMatch = onclick.match(/'([A-Z]{2,4}\d{12,16})'/);
    const cnr = cnrMatch ? cnrMatch[1] : '';

    // Case number / party name
    const caseNo   = $(cells[1]).text().trim().replace(/\s+/g, ' ');
    const parties  = $(cells[2]).text().trim().replace(/\s+/g, ' ');
    const advocate = cells.length >= 4 ? $(cells[3]).text().trim().replace(/\s+/g, ' ') : '';
    const nextDate = cells.length >= 5 ? $(cells[4]).text().trim() : '';

    if (caseNo || parties) {
      results.push({
        srNo:    first,
        caseNo:  caseNo,
        cnr:     cnr,
        parties: parties,
        advocate: advocate,
        nextDate: nextDate,
      });
    }
  });

  // Fallback — try list items
  if (results.length === 0) {
    $('li, .case-item').each((_, el) => {
      const text = $(el).text().trim();
      const cnrMatch = text.match(/[A-Z]{2,4}\d{12,16}/);
      if (cnrMatch) {
        results.push({
          srNo: String(results.length + 1),
          caseNo: cnrMatch[0],
          cnr: cnrMatch[0],
          parties: text.replace(cnrMatch[0], '').trim(),
          advocate: '',
          nextDate: '',
        });
      }
    });
  }

  return results;
}