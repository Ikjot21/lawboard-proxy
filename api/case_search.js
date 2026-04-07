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
      const ct1 = decodeURIComponent(case_type_1);
      params = new URLSearchParams({
        case_type_1: ct1,
        search_year,
        case_status: case_status || 'Both',
        ct_captcha_code: ct_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode, est_code: '0',
        ajax_req: 'true', app_token: '',
      });
    } else if (searchType === 'filingNo') {
      const { filing_no, filyear, file_captcha_code } = req.body;
      if (!filing_no) return res.status(400).json({ success: false, error: 'Filing number required' });
      if (!filyear) return res.status(400).json({ success: false, error: 'Year required' });
      endpoint = 'casestatus/submitFillingNo';
      params = new URLSearchParams({
        case_type: '',
        filing_no,
        filyear,
        file_captcha_code: file_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode, est_code: '0',
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
    } else if (searchType === 'caseNo') {
      const { case_type, search_case_no, rgyear, case_captcha_code } = req.body;
      if (!case_type)        return res.status(400).json({ success: false, error: 'Case type required' });
      if (!search_case_no)   return res.status(400).json({ success: false, error: 'Case number required' });
      if (!rgyear)           return res.status(400).json({ success: false, error: 'Year required' });
      endpoint = 'casestatus/submitCaseNo';

      // CRITICAL: case_type contains "BA^4" — the ^ must NOT be URL-encoded.
      // URLSearchParams encodes ^ to %5E which eCourts rejects.
      // Build raw string manually to preserve the ^ character.
      const rawCaseType = decodeURIComponent(case_type); // decode first in case Flutter encoded it
      const rawBody = [
        `case_type=${rawCaseType}`,
        `search_case_no=${encodeURIComponent(search_case_no.trim())}`,
        `case_no=${encodeURIComponent(search_case_no.trim())}`,
        `rgyear=${encodeURIComponent(rgyear.trim())}`,
        `case_captcha_code=${encodeURIComponent(case_captcha_code?.trim() || '')}`,
        `state_code=${encodeURIComponent(state_code || '')}`,
        `dist_code=${encodeURIComponent(dist_code || '')}`,
        `court_complex_code=${encodeURIComponent(complexCode)}`,
        `est_code=null`,
        `case_type=${rawCaseType}`,
        `ajax_req=true`,
        `app_token=`,
      ].join('&');

      console.log('[caseNo] rawCaseType:', rawCaseType);
      console.log('[caseNo] rawBody:', rawBody);

      // Send directly — bypass params/URLSearchParams
      try {
        const ecResp = await axios.post(
          `${BASE}/?p=${endpoint}`,
          rawBody,
          {
            headers: { ...H, 'Cookie': cookieStr || '' },
            timeout: 15000,
          }
        );
        const raw = ecResp.data;
        const rawStr = JSON.stringify(raw);
        console.log('[caseNo] raw keys:', typeof raw === 'object' ? Object.keys(raw) : 'string');
        console.log('[caseNo] raw preview:', rawStr.substring(0, 400));

        const rawStr2 = JSON.stringify(raw);

        // eCourts returns status:0 with errormsg for captcha/validation errors
        if (typeof raw === 'object' && raw.status === 0) {
          const errMsg = raw.errormsg
              ? raw.errormsg.replace(/<[^>]+>/g, '').trim()
              : 'Invalid CAPTCHA — please try again';
          console.log('[caseNo] status=0 error:', errMsg);
          return res.status(200).json({ success: false, error: errMsg });
        }
        if (rawStr2.toLowerCase().includes('invalid captcha') || rawStr2.toLowerCase().includes('wrong captcha'))
          return res.status(200).json({ success: false, error: 'Incorrect CAPTCHA — please try again' });

        let html = '';
        if (typeof raw === 'object') {
          html = raw.case_data || raw.adv_data || raw.casetype_list || raw.filing_data || raw.data || raw.html || '';
          if (!html) for (const v of Object.values(raw))
            if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
        } else { html = raw; }

        if (!html || html.trim().length < 20) {
          console.log('[caseNo] no html found, raw:', rawStr.substring(0, 300));
          return res.status(200).json({ success: false, error: 'No cases found', debug: typeof raw === 'object' ? Object.keys(raw) : 'string' });
        }

        const results = parseResults(html);
        return res.status(200).json({ success: true, results, total: results.length });
      } catch (err) {
        console.error('[caseNo] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else {
      return res.status(400).json({ success: false, error: 'action or searchType required' });
    }

    const requestTimeout =
        searchType === 'caseType'
            ? (case_status === 'Disposed' ? 110000 : 25000)
            : 15000;

    const resp = await axios.post(
      `${BASE}/?p=${endpoint}`,
      params.toString(),
      {
        headers: { ...H, 'Cookie': cookieStr || '' },
        timeout: requestTimeout,
      },
    );

    const raw = resp.data;
    const rawStr = JSON.stringify(raw);

    // Log raw keys for debugging
    if (typeof raw === 'object') {
      console.log('[parse] raw keys:', Object.keys(raw));
      console.log('[parse] raw preview:', rawStr.substring(0, 500));
    }

    if (rawStr.toLowerCase().includes('invalid captcha') || rawStr.toLowerCase().includes('wrong captcha') ||
        (typeof raw === 'object' && raw.status === 0))
      return res.status(200).json({ success: false, error: 'Incorrect CAPTCHA — please try again' });

    let html = '';
    if (typeof raw === 'object') {
      // eCourts uses different keys for different search types:
      // advocate → adv_data
      // party    → casetype_list (yes, confusing naming)
      // caseNo   → case_data  OR  casetype_list  OR  data
      // caseType → casetype_list
      // filingNo → filing_data
      // fir      → fir_data or casetype_list
      html = raw.case_data
          || raw.adv_data
          || raw.casetype_list
          || raw.filing_data
          || raw.fir_data
          || raw.data
          || raw.case_list
          || raw.html
          || '';
      // Last resort: find any string value containing a <table
      if (!html) {
        for (const v of Object.values(raw)) {
          if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
        }
      }
      // If still empty, check if it's an array directly
      if (!html && Array.isArray(raw)) {
        return res.status(200).json({ success: true, results: raw, total: raw.length });
      }
    } else {
      html = raw;
    }

    if (!html || html.trim().length < 20) {
      console.log('[parse] No HTML found. Raw:', rawStr.substring(0, 300));
      return res.status(200).json({
        success: false,
        error: 'No cases found',
        debug: typeof raw === 'object' ? Object.keys(raw) : 'string response',
      });
    }

    const results = parseResults(html);
    return res.status(200).json({ success: true, results, total: results.length });
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({
        success: false,
        error: 'Search took too long. Please try a narrower search or try again.',
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message,
    });
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
function parseDetailHTML(html, cino) {
  const $ = cheerio.load(html);

  const getText = (label) => {
    let val = '';

    $('tr').each((_, row) => {
      const cells = $(row).find('td, th');
      if (cells.length >= 2) {
        const key = $(cells[0]).text().replace(/\s+/g, ' ').trim();
        if (key.toLowerCase().includes(label.toLowerCase())) {
          val = $(cells[1]).text().replace(/\s+/g, ' ').trim();
        }
      }
    });

    return val;
  };

  const detail = {
    cnr: cino || '',

    // Case details
    caseType: getText('Case Type'),
    filingNumber: getText('Filing Number'),
    filingDate: getText('Filing Date'),
    regNumber: getText('Registration Number'),
    regDate: getText('Registration Date'),

    // Status
    caseStatusFull: getText('Case Status'),
    disposal: getText('Nature of Disposal'),
    firstHearingDate: getText('First Hearing Date'),
    decisionDate: getText('Decision Date'),
    courtJudge: getText('Court Number and Judge'),

    // Parties
    petitioner: '',
    petitionerAdv: '',
    respondent: '',
    respondentAdv: '',

    // Structured sections
    acts: [],
    firDetails: {},
    history: [],
    orders: [],

    // Helpful combined title
    partyName: '',
  };

  // ── Parties ─────────────────────────────
  const petBlock = $('td:contains("Petitioner and Advocate")').parent().next();
  if (petBlock.length) {
    const txt = petBlock.text().trim();
    const parts = txt.split('Advocate-');
    detail.petitioner = (parts[0] || '').trim();
    detail.petitionerAdv = (parts[1] || '').trim();
  }

  const resBlock = $('td:contains("Respondent and Advocate")').parent().next();
  if (resBlock.length) {
    const txt = resBlock.text().trim();
    const parts = txt.split('Advocate-');
    detail.respondent = (parts[0] || '').trim();
    detail.respondentAdv = (parts[1] || '').trim();
  }

  detail.partyName = [detail.petitioner, detail.respondent]
    .filter(Boolean)
    .join(' vs ');

  // ── Acts ─────────────────────────────
  $('table:contains("Under Act") tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 2) {
      const act = $(tds[0]).text().trim();
      const section = $(tds[1]).text().trim();
      if (act || section) {
        detail.acts.push({ act, section });
      }
    }
  });

  // ── FIR ─────────────────────────────
  $('table:contains("Police Station") tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length === 2) {
      const key = $(tds[0]).text().trim();
      const val = $(tds[1]).text().trim();
      if (key) detail.firDetails[key] = val;
    }
  });

  // ── Case History ─────────────────────
  $('table:contains("Business on Date") tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 4) {
      const judge = $(tds[0]).text().trim();
      const businessDate = $(tds[1]).text().trim();
      const hearingDate = $(tds[2]).text().trim();
      const purpose = $(tds[3]).text().trim();

      if (judge || businessDate || hearingDate || purpose) {
        detail.history.push({
          judge,
          businessDate,
          hearingDate,
          purpose,
        });
      }
    }
  });

  // ── Orders (simple text list) ───────────────────────────
  $('table:contains("Order Number") tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 3) {
      const orderNo = $(tds[0]).text().trim();
      const date = $(tds[1]).text().trim();
      const details = $(tds[2]).text().trim();

      if (orderNo || date || details) {
        detail.orders.push({
          orderNo,
          date,
          details,
        });
      }
    }
  });

  return detail;
}