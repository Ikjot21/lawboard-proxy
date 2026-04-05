const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
const REQUEST_TIMEOUT = 40000;

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': `${BASE}/`,
  'Origin': BASE,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    action,
    searchType,
    advocate_name,
    case_status,
    adv_captcha_code,
    petres_name,
    rgyearP,
    fcaptcha_code,
    state_code,
    dist_code,
    court_complex_code,
    est_code,
    cookieStr,
    court_code,
    case_no,
    cino,
    search_by,
    normal_v,
    case_val,
    filename,
    appFlag,
  } = req.body || {};

  const complexCode = (court_complex_code || '').split('@')[0];

  try {
    // ─────────────────────────────────────────────────────────────
    // display_pdf
    // ─────────────────────────────────────────────────────────────
    if (action === 'display_pdf') {
      const params = new URLSearchParams({
        normal_v: normal_v || '',
        case_val: case_val || '',
        court_code: court_code || '',
        filename: filename || '',
        appFlag: appFlag || '',
        ajax_req: 'true',
        app_token: '',
      });

      const resp = await axios.post(
        `${BASE}/?p=home/display_pdf`,
        params.toString(),
        {
          headers: { ...H, Cookie: cookieStr || '' },
          timeout: REQUEST_TIMEOUT,
        }
      );

      const raw = resp.data;
      const orderPath = typeof raw === 'object' ? raw.order : null;

      if (!orderPath) {
        return res.status(200).json({
          success: false,
          error: 'PDF path not found',
        });
      }

      const pdfUrl = `${BASE}/${orderPath.replace(/^\//, '')}`;
      const pdfResp = await axios.get(pdfUrl, {
        headers: { ...H, Cookie: cookieStr || '' },
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT,
      });

      const pdfBase64 = Buffer.from(pdfResp.data).toString('base64');
      return res.status(200).json({ success: true, pdfBase64, pdfUrl });
    }

    // ─────────────────────────────────────────────────────────────
    // viewHistory
    // ─────────────────────────────────────────────────────────────
    if (action === 'viewHistory') {
      const params = new URLSearchParams({
        court_code: court_code || '1',
        state_code: state_code || '',
        dist_code: dist_code || '',
        court_complex_code: complexCode,
        case_no: case_no || '',
        cino: cino || '',
        hideparty: '',
        search_flag: 'CScaseNumber',
        search_by: search_by || 'CSAdvName',
        ajax_req: 'true',
        app_token: '',
      });

      const resp = await axios.post(
        `${BASE}/?p=home/viewHistory`,
        params.toString(),
        {
          headers: { ...H, Cookie: cookieStr || '' },
          timeout: REQUEST_TIMEOUT,
        }
      );

      const raw = resp.data;
      const html = typeof raw === 'object' ? (raw.data_list || '') : raw;

      if (!html || html.length < 20) {
        return res.status(200).json({
          success: false,
          error: 'Case detail not found',
        });
      }

      const detail = parseDetailHTML(html, cino);
      return res.status(200).json({ success: true, detail });
    }

    // ─────────────────────────────────────────────────────────────
    // search handlers
    // ─────────────────────────────────────────────────────────────
    let endpoint = '';
    let params;

    if (searchType === 'advocate') {
      if (!advocate_name || advocate_name.trim().length < 3) {
        return res.status(400).json({
          success: false,
          error: 'Advocate name minimum 3 characters',
        });
      }

      endpoint = 'casestatus/submitAdvName';
      params = new URLSearchParams({
        radAdvt: '1',
        advocate_name: advocate_name.trim(),
        adv_bar_state: '',
        adv_bar_code: '',
        adv_bar_year: '',
        case_status: case_status || 'Both',
        caselist_date: '',
        adv_captcha_code: adv_captcha_code?.trim() || '',
        state_code: state_code || '',
        dist_code: dist_code || '',
        court_complex_code: complexCode,
        est_code: est_code || 'null',
        case_type: '',
        ajax_req: 'true',
        app_token: '',
      });
    } else if (searchType === 'party') {
      if (!petres_name || petres_name.trim().length < 3) {
        return res.status(400).json({
          success: false,
          error: 'Party name minimum 3 characters',
        });
      }

      endpoint = 'casestatus/submitPartyName';
      params = new URLSearchParams({
        petres_name: petres_name.trim(),
        rgyearP: rgyearP || '',
        case_status: case_status || 'Both',
        fcaptcha_code: fcaptcha_code?.trim() || '',
        state_code: state_code || '',
        dist_code: dist_code || '',
        court_complex_code: complexCode,
        est_code: est_code || 'null',
        ajax_req: 'true',
        app_token: '',
      });
    } else if (searchType === 'caseType') {
      const { case_type_1, search_year, ct_captcha_code } = req.body || {};

      if (!case_type_1) {
        return res.status(400).json({
          success: false,
          error: 'Case type required',
        });
      }

      if (!search_year) {
        return res.status(400).json({
          success: false,
          error: 'Year required',
        });
      }

      endpoint = 'casestatus/submit_case_type';
      params = new URLSearchParams({
        case_type_1: decodeURIComponent(case_type_1),
        search_year: search_year,
        case_status: case_status || 'Both',
        ct_captcha_code: ct_captcha_code?.trim() || '',
        state_code: state_code || '',
        dist_code: dist_code || '',
        court_complex_code: complexCode,
        est_code: est_code || '0',
        ajax_req: 'true',
        app_token: '',
      });
    } else if (searchType === 'fir') {
      const { fir_no, firyear, fir_captcha_code, police_st_code } = req.body || {};

      if (!fir_no) {
        return res.status(400).json({
          success: false,
          error: 'FIR number required',
        });
      }

      if (!firyear) {
        return res.status(400).json({
          success: false,
          error: 'FIR year required',
        });
      }

      if (!police_st_code) {
        return res.status(400).json({
          success: false,
          error: 'Police station required',
        });
      }

      const parts = police_st_code.split('-');
      const ps_code = parts[0] || '';
      const uniform_code = parts[1] || '0';

      endpoint = 'casestatus/submitFirNo';
      params = new URLSearchParams({
        fir_no,
        firyear,
        case_status: case_status || 'Both',
        fir_captcha_code: fir_captcha_code?.trim() || '',
        police_st_code: ps_code,
        uniform_code,
        state_code: state_code || '',
        dist_code: dist_code || '',
        court_complex_code: complexCode,
        est_code: est_code || 'null',
        ajax_req: 'true',
        app_token: '',
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'action or searchType required',
      });
    }

    console.log('--- SEARCH START ---');
    console.log('searchType =', searchType);
    console.log('state_code =', state_code);
    console.log('dist_code =', dist_code);
    console.log('court_complex_code =', complexCode);
    console.log('est_code =', est_code);

    const resp = await axios.post(
      `${BASE}/?p=${endpoint}`,
      params.toString(),
      {
        headers: { ...H, Cookie: cookieStr || '' },
        timeout: REQUEST_TIMEOUT,
      }
    );

    const raw = resp.data;
    console.log('raw type:', typeof raw);
    console.log(
      'raw preview:',
      typeof raw === 'string'
        ? raw.slice(0, 1000)
        : JSON.stringify(raw).slice(0, 1000)
    );

    const rawStr = JSON.stringify(raw);

    if (
      rawStr.toLowerCase().includes('invalid captcha') ||
      rawStr.toLowerCase().includes('wrong captcha') ||
      (typeof raw === 'object' && raw.status === 0)
    ) {
      return res.status(200).json({
        success: false,
        error: 'Incorrect CAPTCHA — please try again',
      });
    }

    let html = '';
    if (typeof raw === 'object') {
      html =
        raw.adv_data ||
        raw.case_data ||
        raw.casetype_list ||
        raw.case_list ||
        raw.html ||
        '';

      if (!html) {
        for (const v of Object.values(raw)) {
          if (typeof v === 'string' && v.includes('<table')) {
            html = v;
            break;
          }
        }
      }
    } else {
      html = raw;
    }

    console.log('html length:', html ? html.length : 0);
    console.log('html preview:', (html || '').slice(0, 1000));

    if (!html || html.trim().length < 20) {
      return res.status(200).json({
        success: false,
        error: 'No cases found',
      });
    }

    const results = parseResults(html);
    console.log('parsed results count:', results.length);
    console.log('parsed results preview:', results.slice(0, 3));

    return res.status(200).json({
      success: true,
      results,
      total: results.length,
    });
  } } catch (err) {
      console.error('case_search error:', err.message, '| code:', err.code, '| status:', err.response?.status);

      if (err.code === 'ECONNABORTED') {
        return res.status(504).json({
          success: false,
          error: 'eCourts took too long to respond. Please try again.',
        });
      }

      return res.status(500).json({
        success: false,
        error: err.message || 'Unknown server error',
      });
    }
  }
};

// ─────────────────────────────────────────────────────────────
// Parse search results
// ─────────────────────────────────────────────────────────────
function parseResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  let currentCourt = '';

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const header = $(row).find('th[colspan]');

    console.log(
      'ROW => td count:',
      cells.length,
      '| text:',
      $(row).text().replace(/\s+/g, ' ').trim().slice(0, 300)
    );

    if (header.length) {
      const txt = header.first().text().trim();
      if (txt && txt.length < 120) currentCourt = txt;
      return;
    }

    if (cells.length < 4) return;

    const srNo = $(cells[0]).text().trim();
    if (!/^\d+$/.test(srNo)) return;

    const caseNo = $(cells[1]).text().trim().replace(/\s+/g, ' ');

    const partiesHtml = $(cells[2]).html() || '';
    const parties = partiesHtml
      .replace(/<br\s*\/?>/gi, ' Vs ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\bVs\s+Vs\b/g, 'Vs')
      .trim();

    const advocate = $(cells[3]).text().trim().replace(/\s+/g, ' ');

    const viewCell = cells.length >= 5 ? $(cells[4]) : $(row);
    const onClick = viewCell.find('a').attr('onclick') || '';

    console.log('PARSE onClick =>', onClick);

    let cnr = '';
    let caseNoNum = '';
    let courtCode = '1';

    const vhMatch = onClick.match(/viewHistory\((\d+),'([A-Z0-9]+)',(\d+)/);
    if (vhMatch) {
      caseNoNum = vhMatch[1] || '';
      cnr = vhMatch[2] || '';
      courtCode = vhMatch[3] || '1';
    }

    if (!cnr) {
      const cnrMatch = onClick.match(/'([A-Z]{4}\d{12,16})'/);
      if (cnrMatch) cnr = cnrMatch[1];
    }

    results.push({
      srNo,
      caseNo,
      cnr,
      caseNoNum,
      courtCode,
      parties,
      advocate,
      court: currentCourt,
      nextDate: '',
    });
  });

  return results;
}

// ─────────────────────────────────────────────────────────────
// Parse detail HTML
// ─────────────────────────────────────────────────────────────
function parseDetailHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr || '' };

  result.courtName = $('h2').first().text().trim();

  $('table.case_details_table').each((_, table) => {
    const allCells = $(table).find('th, td').toArray();

    for (let i = 0; i < allCells.length; i++) {
      const el = allCells[i];
      const tag = (el.tagName || el.name || '').toLowerCase();
      if (tag !== 'th') continue;

      const label = $(el).text().replace(/\s+/g, ' ').trim();

      let j = i + 1;
      while (j < allCells.length) {
        const nextTag = (allCells[j].tagName || allCells[j].name || '').toLowerCase();
        if (nextTag === 'td') break;
        j++;
      }
      if (j >= allCells.length) continue;

      const val = $(allCells[j])
        .text()
        .replace(/\s+/g, ' ')
        .replace(/&nbsp;/g, '')
        .trim();

      const cleanLabel = label.toLowerCase();

      if (cleanLabel.includes('case type')) {
        result.caseType = val;
      }
      if (cleanLabel.includes('filing number') || cleanLabel.includes('filing no')) {
        result.filingNumber = val;
      }
      if (
        cleanLabel.includes('filing date') ||
        cleanLabel.includes('filing dt') ||
        cleanLabel.includes('date of filing')
      ) {
        result.filingDate = val;
      }
      if (
        cleanLabel.includes('registration number') ||
        cleanLabel.includes('registration no')
      ) {
        result.regNumber = val;
      }
      if (
        cleanLabel.includes('registration date') ||
        cleanLabel.includes('registration dt') ||
        cleanLabel.includes('date of registration')
      ) {
        result.regDate = val;
      }
    }
  });

  result.cnrNumber = $('span.text-danger').first().text().trim() || cnr;

  $('table.case_status_table tr').each((_, row) => {
    const label = $(row).find('th, td').first().text().trim();
    const val =
      $(row).find('td').last().find('strong').text().trim() ||
      $(row).find('td').last().text().trim();

    if (label.includes('First Hearing')) result.firstDate = val;
    if (label.includes('Decision Date')) result.decisionDate = val;
    if (label.includes('Case Status')) result.caseStatus = val;
    if (label.includes('Nature of Disposal')) result.disposal = val;
    if (label.includes('Court Number')) result.courtNo = val;
  });

  const pets = [];
  const petAdvs = [];
  $('ul.petitioner-advocate-list li, ul.Petitioner_Advocate_table li').each((_, li) => {
    const lines = ($(li).html() || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    lines.forEach((line) => {
      if (/^\d+\)/.test(line)) {
        pets.push(
          line
            .replace(/^\d+\)\s*/, '')
            .replace(/\s*Advocate[-:].*/i, '')
            .trim()
        );
      }
      if (/Advocate[-:]/i.test(line)) {
        petAdvs.push(line.replace(/.*Advocate[-:]\s*/i, '').trim());
      }
    });
  });
  result.petitioner = pets.join(', ');
  result.petAdvocate = petAdvs.join(', ');

  const resps = [];
  const respAdvs = [];
  $('ul.respondent-advocate-list li, ul.Respondent_Advocate_table li').each((_, li) => {
    const lines = ($(li).html() || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    lines.forEach((line) => {
      if (/^\d+\)/.test(line)) {
        resps.push(
          line
            .replace(/^\d+\)\s*/, '')
            .replace(/\s*Advocate[-:].*/i, '')
            .trim()
        );
      }
      if (/Advocate[-:]/i.test(line)) {
        respAdvs.push(line.replace(/.*Advocate[-:]\s*/i, '').trim());
      }
    });
  });
  result.respondent = resps.join(', ');
  result.respAdvocate = respAdvs.join(', ');
  result.partyName = [result.petitioner, result.respondent].filter(Boolean).join(' vs ');

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

  result.firDetails = {};
  $('table.FIR_details_table tr').each((_, row) => {
    const label = $(row).find('th').first().text().trim();
    const val = $(row).find('th, td').last().text().trim();
    if (label.includes('Police Station')) result.firDetails.policeStation = val;
    if (label.includes('FIR Number')) result.firDetails.firNumber = val;
    if (label.includes('Year')) result.firDetails.year = val;
  });

  const history = [];
  $('table.history_table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 4) {
      const judge = $(cells[0]).text().trim();
      const busDate = $(cells[1]).text().replace(/\s+/g, ' ').trim();
      const hearDate = $(cells[2]).text().trim();
      const purpose = $(cells[3]).text().trim();
      if (hearDate || purpose) history.push({ judge, busDate, hearDate, purpose });
    }
  });
  result.hearingHistory = history;

  const parseOrders = (tableSelector) => {
    const orders = [];
    $(tableSelector).find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const numText = $(cells[0]).text().trim().replace(/&nbsp;/g, '').trim();
      const dateText = $(cells[1]).text().trim().replace(/&nbsp;/g, '').trim();
      const onClick = $(row).find('a').attr('onclick') || '';

      const m = onClick.match(
        /displayPdf\('([^']+)','([^']+)','([^']+)','([^']+)','([^']*)'\)/
      );

      if (m && /\d/.test(numText)) {
        orders.push({
          num: numText,
          date: dateText,
          normal_v: m[1],
          case_val: m[2],
          court_code: m[3],
          filename: m[4],
          appFlag: m[5],
        });
      }
    });
    return orders;
  };

  result.interimOrders = parseOrders('table.order_table:first-of-type');
  result.finalOrders = parseOrders('table.order_table:last-of-type');

  const orderTables = $('table.order_table');
  if (orderTables.length >= 2) {
    result.interimOrders = parseOrders(orderTables.eq(0));
    result.finalOrders = parseOrders(orderTables.eq(1));
  }

  return result;
}