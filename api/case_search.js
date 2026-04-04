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
    // Search fields
    searchType, advocate_name, case_status, adv_captcha_code,
    petres_name, rgyearP, fcaptcha_code,
    state_code, dist_code, court_complex_code, est_code, cookieStr,
    // viewHistory fields
    court_code, case_no, cino, search_by,
  } = req.body || {};

  // Strip @... from complex code
  const complexCode = (court_complex_code || '').split('@')[0];

  // ── viewHistory — NO CAPTCHA needed ────────────────────────────────────────
  if (action === 'viewHistory') {
    try {
      const params = new URLSearchParams({
        court_code:         court_code || '1',
        state_code:         state_code || '',
        dist_code:          dist_code || '',
        court_complex_code: complexCode,
        case_no:            case_no || '',
        cino:               cino || '',
        hideparty:          '',
        search_flag:        'CScaseNumber',
        search_by:          search_by || 'CSAdvName',
        ajax_req:           'true',
        app_token:          '',
      });

      const resp = await axios.post(
        `${BASE}/?p=home/viewHistory`,
        params.toString(),
        { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 }
      );

      const raw = resp.data;
      const html = typeof raw === 'object' ? (raw.data_list || '') : raw;

      if (!html || html.length < 20) {
        return res.status(200).json({ success: false, error: 'Case detail nahi mili' });
      }

      const detail = parseDetailHTML(html, cino);
      return res.status(200).json({ success: true, detail });

    } catch (err) {
      console.error('viewHistory error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Advocate / Party Search ─────────────────────────────────────────────────
  try {
    let endpoint, params;

    if (searchType === 'advocate') {
      if (!advocate_name || advocate_name.trim().length < 3)
        return res.status(400).json({ success: false, error: 'Advocate name minimum 3 characters' });
      endpoint = 'casestatus/submitAdvName';
      params = new URLSearchParams({
        radAdvt: '1', advocate_name: advocate_name.trim(),
        adv_bar_state: '', adv_bar_code: '', adv_bar_year: '',
        case_status: case_status || 'Both',
        caselist_date: '',
        adv_captcha_code: adv_captcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode,
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
        case_status: case_status || 'Both',
        fcaptcha_code: fcaptcha_code?.trim() || '',
        state_code: state_code || '', dist_code: dist_code || '',
        court_complex_code: complexCode,
        est_code: est_code || 'null',
        ajax_req: 'true', app_token: '',
      });
    } else {
      return res.status(400).json({ success: false, error: 'action or searchType required' });
    }

    const resp = await axios.post(
      `${BASE}/?p=${endpoint}`,
      params.toString(),
      { headers: { ...H, 'Cookie': cookieStr || '' }, timeout: 15000 }
    );

    const raw = resp.data;
    const rawStr = JSON.stringify(raw);

    if (rawStr.toLowerCase().includes('invalid captcha') ||
        rawStr.toLowerCase().includes('wrong captcha') ||
        (typeof raw === 'object' && raw.status === 0)) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }

    let html = '';
    if (typeof raw === 'object') {
      html = raw.adv_data || raw.casetype_list || raw.case_list || raw.html || '';
      if (!html) {
        for (const v of Object.values(raw)) {
          if (typeof v === 'string' && v.includes('<table')) { html = v; break; }
        }
      }
    } else { html = raw; }

    if (!html || html.trim().length < 20) {
      return res.status(200).json({ success: false, error: 'Koi case nahi mila' });
    }

    const results = parseResults(html);
    console.log('Results:', results.length);
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
    const parties = partiesHtml
      .replace(/<br\s*\/?>/gi, ' Vs ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\bVs\s+Vs\b/g, 'Vs')
      .trim();

    const advocate = $(cells[3]).text().trim().replace(/\s+/g, ' ');

    // Extract from viewHistory onclick: viewHistory(case_no,'CNR',court_code,...)
    const viewCell = cells.length >= 5 ? $(cells[4]) : $(row);
    const onClick  = viewCell.find('a').attr('onclick') || '';

    // viewHistory(202500007062021,'HRSI010023722021',1,'','CScaseNumber',14,2,1140011,'CSAdvName')
    const vhMatch = onClick.match(/viewHistory\((\d+),'([A-Z0-9]+)',(\d+)/);
    const caseNoNum  = vhMatch ? vhMatch[1] : '';
    const cnr        = vhMatch ? vhMatch[2] : '';
    const courtCode  = vhMatch ? vhMatch[3] : '1';

    results.push({ srNo, caseNo, cnr, caseNoNum, courtCode, parties, advocate, court: currentCourt, nextDate: '' });
  });

  return results;
}

// ── Parse viewHistory detail HTML ─────────────────────────────────────────────
function parseDetailHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr || '' };

  result.courtName = $('h2').first().text().trim();

  const findTh = (label) => {
    let val = '';
    $('th').each((_, el) => {
      if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
        val = $(el).next('td').text().trim();
        if (!val) val = $(el).closest('tr').find('td').first().text().trim();
        if (val) return false;
      }
    });
    return val.replace(/&nbsp;/g, '').trim();
  };

  result.caseType     = findTh('Case Type');
  result.filingNumber = findTh('Filing Number');
  result.filingDate   = findTh('Filing Date');
  result.regNumber    = findTh('Registration Number');
  result.regDate      = findTh('Registration Date');
  result.cnrNumber    = findTh('CNR Number') || cnr;
  result.firstDate    = findTh('First Hearing Date');
  result.nextDate     = findTh('Next Hearing Date') || findTh('Decision Date');
  result.caseStage    = findTh('Case Stage') || findTh('Nature of Disposal') || findTh('Case Status');
  result.courtNo      = findTh('Court Number and Judge');
  result.judgeName    = result.courtNo;

  // Petitioner
  const petBlock = $('ul.petitioner-advocate-list, ul.Petitioner_Advocate_table').first();
  const petText  = petBlock.text().trim();
  const petName  = petText.match(/1\)\s*([^\n]+)/)?.[1]?.replace(/\s*Advocate[-–:][\s\S]*/i,'').trim() || '';
  const petAdv   = petText.match(/Advocate[-–:]\s*([^\n]+)/i)?.[1]?.trim() || '';
  result.petitioner  = petName;
  result.petAdvocate = petAdv;

  // Respondent
  const respBlock = $('ul.respondent-advocate-list, ul.Respondent_Advocate_table').first();
  const respNames = [];
  respBlock.find('li').each((_, li) => {
    const t = $(li).text().trim().replace(/\s+/g, ' ');
    const m = t.match(/\d+\)\s*([^A-Z]*[A-Z][^\n]*)/);
    if (m) respNames.push(m[1].replace(/\s*Advocate[-–:].*/i, '').trim());
  });
  result.respondent   = respNames.join(', ');
  result.respAdvocate = respBlock.text().match(/Advocate[-–:]\s*([^\n]+)/i)?.[1]?.trim() || '';

  result.partyName = result.petitioner && result.respondent
    ? `${result.petitioner} vs ${result.respondent}` : '';

  // Hearing history
  const history = [];
  $('table').each((_, tbl) => {
    if ($(tbl).text().toLowerCase().includes('hearing date') &&
        $(tbl).text().toLowerCase().includes('purpose')) {
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 4) {
          const date    = $(cells[2]).text().trim();
          const purpose = $(cells[3]).text().trim();
          if (date.match(/\d{2}-\d{2}-\d{4}/) && purpose) {
            history.push(`${date} — ${purpose}`);
          }
        }
      });
    }
  });
  result.hearingHistory = [...new Set(history)];

  // Acts
  const acts = [];
  $('table#act_table, table.acts_table').find('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const act = $(cells[0]).text().trim();
      const sec = $(cells[1]).text().trim();
      if (act && sec) acts.push(`${act} — Sec. ${sec}`);
    }
  });
  result.acts = acts;

  return result;
}