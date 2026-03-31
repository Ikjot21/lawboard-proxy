const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
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

  const { action, state_code, dist_code, complex_code, est_code, court_no,
          causelist_date, captchaCode, cookieStr } = req.body || {};
  console.log('CauseList action:', action);

  try {

    // ── Step 1: Get States ──────────────────────────────
    if (action === 'states') {
      // Try cause_list/index first, fallback to casestatus/index
      let html = '';
      for (const path of ['cause_list/index', 'casestatus/index', 'causelist/index']) {
        try {
          const resp = await axios.get(`${BASE}/?p=${path}&app_token=`, {
            headers: { 'User-Agent': H['User-Agent'], 'Referer': `${BASE}/` },
            timeout: 12000,
          });
          if (resp.status === 200) { html = resp.data; console.log('States from:', path); break; }
        } catch(e) { console.log('Failed:', path, e.message); }
      }
      const $ = cheerio.load(html);
      const states = [];
      $('select').each((_, sel) => {
        const id = ($(sel).attr('id') || '').toLowerCase();
        const nm = ($(sel).attr('name') || '').toLowerCase();
        if (id.includes('state') || nm.includes('state')) {
          $(sel).find('option').each((_, el) => {
            const val = $(el).val()?.toString().trim();
            const txt = $(el).text().trim();
            if (val && val !== '0' && txt) states.push({ code: val, name: txt });
          });
        }
      });
      console.log('States found:', states.length, '| HTML len:', html.length);
      if (states.length === 0) {
        // Hardcode common states as fallback
        return res.status(200).json({ success: true, states: HARDCODED_STATES });
      }
      return res.status(200).json({ success: true, states });
    }

    // ── Step 2: Get Districts ───────────────────────────
    if (action === 'districts') {
      const params = new URLSearchParams({ state_code, ajax_req: 'true', app_token: '' });
      const resp = await axios.post(`${BASE}/?p=casestatus/fillDistrict`, params.toString(),
        { headers: H, timeout: 12000 });
      console.log('Districts raw type:', typeof resp.data);
      const districts = parseSelectOptions(resp.data);
      return res.status(200).json({ success: true, districts });
    }

    // ── Step 3: Get Court Complexes ─────────────────────
    if (action === 'complexes') {
      const params = new URLSearchParams({ state_code, dist_code, ajax_req: 'true', app_token: '' });
      const resp = await axios.post(`${BASE}/?p=casestatus/fillcomplex`, params.toString(),
        { headers: H, timeout: 12000 });
      const complexes = parseSelectOptions(resp.data);
      return res.status(200).json({ success: true, complexes });
    }

    // ── Step 4: Get Courts from Complex ─────────────────
    if (action === 'courts') {
      // complex_code format: "1140011@1,3,4@N"
      const params = new URLSearchParams({
        complex_code: `${complex_code}@${est_code}@N`,
        selected_state_code: state_code,
        selected_dist_code: dist_code,
        selected_est_code: null,
        ajax_req: 'true',
        app_token: '',
      });
      const resp = await axios.post(`${BASE}/?p=casestatus/set_data`, params.toString(),
        { headers: H, timeout: 12000 });
      // Then get cause list courts
      const params2 = new URLSearchParams({
        state_code,
        dist_code,
        court_complex_code: complex_code,
        est_code,
        search_act: 'undefined',
        ajax_req: 'true',
        app_token: '',
      });
      const resp2 = await axios.post(`${BASE}/?p=cause_list/fillCauseList`, params2.toString(),
        { headers: H, timeout: 12000 });
      console.log('Courts raw:', JSON.stringify(resp2.data).slice(0, 300));
      const courts = parseCourts(resp2.data);
      return res.status(200).json({ success: true, courts });
    }

    // ── Step 5: Submit & Get Cause List ─────────────────
    if (action === 'list') {
      const params = new URLSearchParams({
        CL_court_no:           court_no,        // e.g. "1^13"
        causelist_date:        causelist_date,   // e.g. "31-03-2026"
        cause_list_captcha_code: captchaCode,
        court_name_txt:        '',
        state_code,
        dist_code,
        court_complex_code:    complex_code,
        est_code:              est_code || 'null',
        cicri:                 'cri',
        selprevdays:           '0',
        ajax_req:              'true',
        app_token:             '',
      });
      const resp = await axios.post(`${BASE}/?p=cause_list/submitCauseList`, params.toString(), {
        headers: { ...H, 'Cookie': cookieStr || '' },
        timeout: 20000,
      });
      const html = typeof resp.data === 'string' ? resp.data
        : resp.data?.cause_list_html || resp.data?.html || JSON.stringify(resp.data);
      console.log('Submit result len:', html.length, '| preview:', html.slice(0, 150));

      if (!html || html.toLowerCase().includes('invalid captcha')) {
        return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
      }

      const cases = parseCauseListHTML(html);
      console.log('Parsed cases:', cases.length);
      return res.status(200).json({ success: true, cases, totalCases: cases.length });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('CauseList error:', err.message, '| status:', err.response?.status);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Hardcoded States (fallback) — codes from eCourts network inspection ──
const HARDCODED_STATES = [
  {code:'1',name:'Andaman and Nicobar Islands'},{code:'2',name:'Andhra Pradesh'},
  {code:'3',name:'Arunachal Pradesh'},{code:'4',name:'Assam'},
  {code:'5',name:'Bihar'},{code:'6',name:'Chandigarh'},
  {code:'7',name:'Chhattisgarh'},{code:'8',name:'Dadra and Nagar Haveli'},
  {code:'9',name:'Daman and Diu'},{code:'10',name:'Delhi'},
  {code:'11',name:'Goa'},{code:'12',name:'Gujarat'},
  {code:'13',name:'Haryana'},{code:'14',name:'Himachal Pradesh'},
  {code:'15',name:'Jammu and Kashmir'},{code:'16',name:'Jharkhand'},
  {code:'17',name:'Karnataka'},{code:'18',name:'Kerala'},
  {code:'19',name:'Ladakh'},{code:'20',name:'Lakshadweep'},
  {code:'21',name:'Madhya Pradesh'},{code:'22',name:'Maharashtra'},
  {code:'23',name:'Manipur'},{code:'24',name:'Meghalaya'},
  {code:'25',name:'Mizoram'},{code:'26',name:'Nagaland'},
  {code:'27',name:'Odisha'},{code:'28',name:'Puducherry'},
  {code:'29',name:'Punjab'},{code:'30',name:'Rajasthan'},
  {code:'31',name:'Sikkim'},{code:'32',name:'Tamil Nadu'},
  {code:'33',name:'Telangana'},{code:'34',name:'Tripura'},
  {code:'35',name:'Uttar Pradesh'},{code:'36',name:'Uttarakhand'},
  {code:'37',name:'West Bengal'},
];
function parseSelectOptions(data) {
  if (Array.isArray(data)) {
    return data.map(d => ({
      code: d.dist_code || d.complex_code || d.court_code || d.code || d.id,
      name: d.dist_name || d.complex_name || d.court_name || d.name,
    })).filter(d => d.code && d.name);
  }
  if (typeof data === 'object') {
    const vals = Object.values(data);
    if (vals.length && typeof vals[0] === 'object') {
      return vals.map(d => ({
        code: d.dist_code || d.complex_code || d.code || d.id,
        name: d.dist_name || d.complex_name || d.name,
      })).filter(d => d.code && d.name);
    }
  }
  const $ = cheerio.load(data);
  const items = [];
  $('option').each((_, el) => {
    const val = $(el).val()?.toString().trim();
    const txt = $(el).text().trim();
    if (val && val !== '0' && txt) items.push({ code: val, name: txt });
  });
  return items;
}

function parseCourts(data) {
  // data may have court list HTML or JSON
  if (typeof data === 'object' && data.court_list) {
    const $ = cheerio.load(data.court_list);
    const courts = [];
    $('option').each((_, el) => {
      const val = $(el).val()?.toString().trim();
      const txt = $(el).text().trim();
      if (val && val !== '0' && txt) courts.push({ code: val, name: txt });
    });
    return courts;
  }
  return parseSelectOptions(data);
}

function parseCauseListHTML(html) {
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