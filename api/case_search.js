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
    action,
    searchType, advocate_name, case_status, adv_captcha_code,
    petres_name, rgyearP, fcaptcha_code,
    state_code, dist_code, court_complex_code, est_code, cookieStr,
    court_code, case_no, cino, search_by,
  } = req.body || {};

  const complexCode = (court_complex_code || '').split('@')[0];

  // ── viewHistory — NO CAPTCHA ──────────────────────────────────────────────
  if (action === 'viewHistory') {
    try {
      const params = new URLSearchParams({
        court_code:         court_code || '1',
        state_code:         state_code || '',
        dist_code:          dist_code  || '',
        court_complex_code: complexCode,
        case_no:            case_no    || '',
        cino:               cino       || '',
        hideparty:          '',
        search_flag:        'CScaseNumber',
        search_by:          search_by  || 'CSAdvName',
        ajax_req:           'true',
        app_token:          '',
      });
      const resp = await axios.post(`${BASE}/?p=home/viewHistory`, params.toString(),
        { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 });
      const raw  = resp.data;
      const html = typeof raw === 'object' ? (raw.data_list || '') : raw;
      if (!html || html.length < 20)
        return res.status(200).json({ success: false, error: 'Case detail nahi mili' });
      const detail = parseDetailHTML(html, cino);
      return res.status(200).json({ success: true, detail });
    } catch (err) {
      console.error('viewHistory error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Advocate / Party Search ───────────────────────────────────────────────
  try {
    let endpoint, params;
    if (searchType === 'advocate') {
      if (!advocate_name || advocate_name.trim().length < 3)
        return res.status(400).json({ success: false, error: 'Advocate name minimum 3 characters' });
      endpoint = 'casestatus/submitAdvName';
      params = new URLSearchParams({
        radAdvt: '1', advocate_name: advocate_name.trim(),
        adv_bar_state: '', adv_bar_code: '', adv_bar_year: '',
        case_status: case_status || 'Both', caselist_date: '',
        adv_captcha_code: adv_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode, est_code: est_code || 'null',
        case_type: '', ajax_req: 'true', app_token: '',
      });
    } else if (searchType === 'party') {
      if (!petres_name || petres_name.trim().length < 3)
        return res.status(400).json({ success: false, error: 'Party name minimum 3 characters' });
      endpoint = 'casestatus/submitPartyName';
      params = new URLSearchParams({
        petres_name: petres_name.trim(), rgyearP: rgyearP || '',
        case_status: case_status || 'Both',
        fcaptcha_code: fcaptcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode, est_code: est_code || 'null',
        ajax_req: 'true', app_token: '',
      });
    } else {
      return res.status(400).json({ success: false, error: 'action or searchType required' });
    }

    const resp = await axios.post(`${BASE}/?p=${endpoint}`, params.toString(),
      { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 });
    const raw = resp.data;
    const rawStr = JSON.stringify(raw);
    if (rawStr.toLowerCase().includes('invalid captcha') || rawStr.toLowerCase().includes('wrong captcha') ||
        (typeof raw === 'object' && raw.status === 0))
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });

    let html = '';
    if (typeof raw === 'object') {
      html = raw.adv_data || raw.casetype_list || raw.case_list || raw.html || '';
      if (!html) for (const v of Object.values(raw))
        if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
    } else { html = raw; }

    if (!html || html.trim().length < 20)
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });

    const results = parseResults(html);
    return res.status(200).json({ success: true, results, total: results.length });
  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Parse search results ──────────────────────────────────────────────────────
function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  let currentCourt = '';
  $('table tr').each((_, row) => {
    const cells  = $(row).find('td');
    const header = $(row).find('th[colspan]');
    if (header.length) {
      const txt = header.first().text().trim();
      if (txt && txt.length < 100) currentCourt = txt;
      return;
    }
    if (cells.length < 4) return;
    const srNo = $(cells[0]).text().trim();
    if (!srNo.match(/^\d+$/)) return;
    const caseNo = $(cells[1]).text().trim().replace(/\s+/g, ' ');
    const partiesHtml = $(cells[2]).html() || '';
    const parties = partiesHtml.replace(/<br\s*\/?>/gi, ' Vs ').replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ').replace(/\bVs\s+Vs\b/g, 'Vs').trim();
    const advocate = $(cells[3]).text().trim().replace(/\s+/g, ' ');
    const viewCell = cells.length >= 5 ? $(cells[4]) : $(row);
    const onClick  = viewCell.find('a').attr('onclick') || '';
    const vhMatch  = onClick.match(/viewHistory\((\d+),'([A-Z0-9]+)',(\d+)/);
    results.push({
      srNo, caseNo,
      cnr:       vhMatch ? vhMatch[2] : '',
      caseNoNum: vhMatch ? vhMatch[1] : '',
      courtCode: vhMatch ? vhMatch[3] : '1',
      parties, advocate, court: currentCourt, nextDate: '',
    });
  });
  return results;
}

// ── Parse viewHistory detail HTML ─────────────────────────────────────────────
function parseDetailHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr || '' };

  result.courtName = $('h2').first().text().trim();

  // Case Details table
  $('table.case_details_table tr').each((_, row) => {
    const ths = $(row).find('th').map((_, el) => $(el).text().trim()).get();
    const tds = $(row).find('td').map((_, el) => $(el).text().replace(/\s+/g,' ').trim()).get();
    ths.forEach((label, i) => {
      const val = (tds[i] || '').replace(/&nbsp;/g,'').trim();
      if (label.includes('Case Type'))             result.caseType     = val;
      if (label.includes('Filing Number'))          result.filingNumber = val;
      if (label.includes('Filing Date'))            result.filingDate   = val;
      if (label.includes('Registration Number'))    result.regNumber    = val;
      if (label.includes('Registration Date'))      result.regDate      = val;
    });
  });
  result.cnrNumber = $('span.text-danger').first().text().trim() || cnr;

  // Case Status table
  $('table.case_status_table tr').each((_, row) => {
    const label = $(row).find('th, td').first().text().trim();
    const val   = $(row).find('td').last().find('strong').text().trim() ||
                  $(row).find('td').last().text().trim();
    if (label.includes('First Hearing'))      result.firstDate  = val;
    if (label.includes('Decision Date'))      result.decisionDate = val;
    if (label.includes('Case Status'))        result.caseStatus = val;
    if (label.includes('Nature of Disposal')) result.disposal   = val;
    if (label.includes('Court Number'))       result.courtNo    = val;
  });

  // Petitioners
  const pets = [], petAdvs = [];
  $('ul.petitioner-advocate-list li, ul.Petitioner_Advocate_table li').each((_, li) => {
    const lines = $(li).html().replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'')
      .replace(/&nbsp;/g,' ').split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach(line => {
      if (/^\d+\)/.test(line)) pets.push(line.replace(/^\d+\)\s*/,'').replace(/\s*Advocate[-:].*/i,'').trim());
      if (/Advocate[-:]/i.test(line)) petAdvs.push(line.replace(/.*Advocate[-:]\s*/i,'').trim());
    });
  });
  result.petitioner  = pets.join(', ');
  result.petAdvocate = petAdvs.join(', ');

  // Respondents
  const resps = [], respAdvs = [];
  $('ul.respondent-advocate-list li, ul.Respondent_Advocate_table li').each((_, li) => {
    const lines = $(li).html().replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'')
      .replace(/&nbsp;/g,' ').split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach(line => {
      if (/^\d+\)/.test(line)) resps.push(line.replace(/^\d+\)\s*/,'').replace(/\s*Advocate[-:].*/i,'').trim());
      if (/Advocate[-:]/i.test(line)) respAdvs.push(line.replace(/.*Advocate[-:]\s*/i,'').trim());
    });
  });
  result.respondent   = resps.join(', ');
  result.respAdvocate = respAdvs.join(', ');
  result.partyName    = [result.petitioner, result.respondent].filter(Boolean).join(' vs ');

  // Acts
  const acts = [];
  $('table.acts_table td, table#act_table td').parent('tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 2) {
      const act = $(tds[0]).text().trim();
      const sec = $(tds[1]).text().trim();
      if (act && sec) acts.push({ act, sec });
    }
  });
  result.acts = acts;

  // FIR Details
  result.firDetails = {};
  $('table.FIR_details_table tr').each((_, row) => {
    const label = $(row).find('th').first().text().trim();
    const val   = $(row).find('th, td').last().text().trim();
    if (label.includes('Police Station')) result.firDetails.policeStation = val;
    if (label.includes('FIR Number'))     result.firDetails.firNumber     = val;
    if (label.includes('Year'))           result.firDetails.year          = val;
  });

  // Case History
  const history = [];
  $('table.history_table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 4) {
      const judge    = $(cells[0]).text().trim();
      const busDate  = $(cells[1]).text().replace(/\s+/g,' ').trim();
      const hearDate = $(cells[2]).text().trim();
      const purpose  = $(cells[3]).text().trim();
      if (hearDate || purpose) history.push({ judge, busDate, hearDate, purpose });
    }
  });
  result.hearingHistory = history;

  return result;
}