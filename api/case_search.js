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
    // display_pdf params
    normal_v, case_val, filename, appFlag,
  } = req.body || {};

  const complexCode = (court_complex_code || '').split('@')[0];

  // ── display_pdf — fetch PDF bytes via proxy (session required) ─────────────
  if (action === 'display_pdf') {
    try {
      // Step 1: Get PDF path
      const params = new URLSearchParams({
        normal_v:   normal_v   || '',
        case_val:   case_val   || '',
        court_code: court_code || '',
        filename:   filename   || '',
        appFlag:    appFlag    || '',
        ajax_req:   'true',
        app_token:  '',
      });
      const resp = await axios.post(`${BASE}/?p=home/display_pdf`, params.toString(),
        { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 });
      const raw = resp.data;
      const orderPath = typeof raw === 'object' ? raw.order : null;
      if (!orderPath)
        return res.status(200).json({ success: false, error: 'PDF path not found' });

      // Step 2: Fetch PDF bytes with same session cookie
      const pdfUrl = `${BASE}/${orderPath.replace(/^\//, '')}`;
      const pdfResp = await axios.get(pdfUrl, {
        headers: { ...H, 'Cookie': cookieStr || '' },
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const pdfBase64 = Buffer.from(pdfResp.data).toString('base64');
      return res.status(200).json({ success: true, pdfBase64, pdfUrl });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── viewHistory — NO CAPTCHA ───────────────────────────────────────────────
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
        return res.status(200).json({ success: false, error: 'Case detail not found' });
      const detail = parseDetailHTML(html, cino);
      return res.status(200).json({ success: true, detail });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Advocate / Party Search ────────────────────────────────────────────────
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
    } else if (searchType === 'caseType') {
      const { case_type_1, search_year, ct_captcha_code } = req.body;
      if (!case_type_1) return res.status(400).json({ success: false, error: 'Case type required' });
      if (!search_year) return res.status(400).json({ success: false, error: 'Year required' });
      endpoint = 'casestatus/submit_case_type';
      // case_type_1 comes as "25^4" — URLSearchParams will encode ^ to %5E which is correct
      const ct1 = decodeURIComponent(case_type_1); // handle if already encoded
      params = new URLSearchParams({
        case_type_1: ct1,
        search_year,
        case_status: case_status || 'Both',
        ct_captcha_code: ct_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode, est_code: est_code || '',
        ajax_req: 'true', app_token: '',
      });
    } else if (searchType === 'fir') {
      // FIR Number search
      const { fir_no, firyear, fir_captcha_code, police_st_code } = req.body;
      if (!fir_no) return res.status(400).json({ success: false, error: 'FIR number required' });
      if (!firyear) return res.status(400).json({ success: false, error: 'FIR year required' });
      if (!police_st_code) return res.status(400).json({ success: false, error: 'Police station required' });
      // police_st_code format: "5008-13238065" → police_st_code=5008, uniform_code=13238065
      const parts = police_st_code.split('-');
      const ps_code = parts[0] || '';
      const uniform_code = parts[1] || '0';
      endpoint = 'casestatus/submitFirNo';
      params = new URLSearchParams({
        police_st_code: police_st_code,
        fir_no, firyear,
        case_status: case_status || 'Both',
        fir_captcha_code: fir_captcha_code?.trim() || '',
        police_st_code: ps_code,
        uniform_code,
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
      return res.status(200).json({ success: false, error: 'Incorrect CAPTCHA — please try again' });

    let html = '';
    if (typeof raw === 'object') {
      html = raw.adv_data || raw.case_data || raw.casetype_list || raw.case_list || raw.html || '';
      if (!html) for (const v of Object.values(raw))
        if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
    } else { html = raw; }

    if (!html || html.trim().length < 20)
      return res.status(200).json({ success: false, error: 'No cases found' });

    const results = parseResults(html);
    return res.status(200).json({ success: true, results, total: results.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Parse search results ───────────────────────────────────────────────────────
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
    const caseNo    = $(cells[1]).text().trim().replace(/\s+/g, ' ');
    const partiesHtml = $(cells[2]).html() || '';
    const parties   = partiesHtml.replace(/<br\s*\/?>/gi, ' Vs ').replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ').replace(/\bVs\s+Vs\b/g, 'Vs').trim();
    const advocate  = $(cells[3]).text().trim().replace(/\s+/g, ' ');
    const viewCell  = cells.length >= 5 ? $(cells[4]) : $(row);
    const onClick   = viewCell.find('a').attr('onclick') || '';
    const vhMatch   = onClick.match(/viewHistory\((\d+),'([A-Z0-9]+)',(\d+)/);
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

// ── Parse viewHistory detail HTML ──────────────────────────────────────────────
function parseDetailHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr || '' };

  result.courtName = $('h2').first().text().trim();

  // Case Details table — parse all th/td in sequence as key-value pairs
  $('table.case_details_table').each((_, table) => {
    const allCells = $(table).find('th, td').toArray();
    for (let i = 0; i < allCells.length; i++) {
      const el  = allCells[i];
      const tag = (el.tagName || el.name || '').toLowerCase();
      if (tag !== 'th') continue;
      const label = $(el).text().trim();
      // Find next td (skip other th)
      let j = i + 1;
      while (j < allCells.length) {
        const nextTag = (allCells[j].tagName || allCells[j].name || '').toLowerCase();
        if (nextTag === 'td') break;
        j++;
      }
      if (j >= allCells.length) continue;
      const val = $(allCells[j]).text().replace(/\s+/g, ' ').replace(/&nbsp;/g, '').trim();
      if (label.includes('Case Type'))           result.caseType     = val;
      if (label.includes('Filing Number'))        result.filingNumber = val;
      if (label.includes('Filing Date'))          result.filingDate   = val;
      if (label.includes('Registration Number'))  result.regNumber    = val;
      if (label.includes('Registration Date'))    result.regDate      = val;
    }
  });
  result.cnrNumber = $('span.text-danger').first().text().trim() || cnr;

  // Case Status table
  $('table.case_status_table tr').each((_, row) => {
    const label = $(row).find('th, td').first().text().trim();
    const val   = $(row).find('td').last().find('strong').text().trim() ||
                  $(row).find('td').last().text().trim();
    if (label.includes('First Hearing'))      result.firstDate    = val;
    if (label.includes('Decision Date'))      result.decisionDate = val;
    if (label.includes('Case Status'))        result.caseStatus   = val;
    if (label.includes('Nature of Disposal')) result.disposal     = val;
    if (label.includes('Court Number'))       result.courtNo      = val;
  });

  // Petitioners
  const pets = [], petAdvs = [];
  $('ul.petitioner-advocate-list li, ul.Petitioner_Advocate_table li').each((_, li) => {
    const lines = $(li).html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach(line => {
      if (/^\d+\)/.test(line)) pets.push(line.replace(/^\d+\)\s*/, '').replace(/\s*Advocate[-:].*/i, '').trim());
      if (/Advocate[-:]/i.test(line)) petAdvs.push(line.replace(/.*Advocate[-:]\s*/i, '').trim());
    });
  });
  result.petitioner  = pets.join(', ');
  result.petAdvocate = petAdvs.join(', ');

  // Respondents
  const resps = [], respAdvs = [];
  $('ul.respondent-advocate-list li, ul.Respondent_Advocate_table li').each((_, li) => {
    const lines = $(li).html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach(line => {
      if (/^\d+\)/.test(line)) resps.push(line.replace(/^\d+\)\s*/, '').replace(/\s*Advocate[-:].*/i, '').trim());
      if (/Advocate[-:]/i.test(line)) respAdvs.push(line.replace(/.*Advocate[-:]\s*/i, '').trim());
    });
  });
  result.respondent   = resps.join(', ');
  result.respAdvocate = respAdvs.join(', ');
  result.partyName    = [result.petitioner, result.respondent].filter(Boolean).join(' vs ');

  // Acts
  const acts = [];
  $('table.acts_table tr, table#act_table tr').each((_, row) => {
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
      const busDate  = $(cells[1]).text().replace(/\s+/g, ' ').trim();
      const hearDate = $(cells[2]).text().trim();
      const purpose  = $(cells[3]).text().trim();
      if (hearDate || purpose) history.push({ judge, busDate, hearDate, purpose });
    }
  });
  result.hearingHistory = history;

  // Orders — extract displayPdf params from onclick
  const parseOrders = (tableSelector) => {
    const orders = [];
    $(tableSelector).find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const numText  = $(cells[0]).text().trim().replace(/&nbsp;/g,'').trim();
      const dateText = $(cells[1]).text().trim().replace(/&nbsp;/g,'').trim();
      const onClick  = $(row).find('a').attr('onclick') || '';
      // displayPdf('normal_v','case_val','court_code','filename','appFlag')
      const m = onClick.match(/displayPdf\('([^']+)','([^']+)','([^']+)','([^']+)','([^']*)'\)/);
      if (m && numText.match(/\d/)) {
        orders.push({
          num:       numText,
          date:      dateText,
          normal_v:  m[1],
          case_val:  m[2],
          court_code: m[3],
          filename:  m[4],
          appFlag:   m[5],
        });
      }
    });
    return orders;
  };

  result.interimOrders = parseOrders('table.order_table:first-of-type');
  result.finalOrders   = parseOrders('table.order_table:last-of-type');

  // If both same, differentiate by h3 heading
  const orderTables = $('table.order_table');
  if (orderTables.length >= 2) {
    result.interimOrders = parseOrders(orderTables.eq(0));
    result.finalOrders   = parseOrders(orderTables.eq(1));
  }

  return result;
}