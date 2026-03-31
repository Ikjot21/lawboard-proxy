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

    // ── Step 1: Get States (with app_token) ──────────────────
    if (action === 'states') {
      // First get app_token from the page
      let appToken = '';
      try {
        const pageResp = await axios.get(`${BASE}/?p=cause_list/index&app_token=`, {
          headers: { 'User-Agent': H['User-Agent'], 'Referer': `${BASE}/` },
          timeout: 12000,
        });
        const $p = cheerio.load(pageResp.data);
        appToken = $p('input[name="app_token"]').val() ||
                   $p('#app_token').val() || '';
        console.log('app_token found:', appToken ? 'yes' : 'no', '| len:', pageResp.data.length);

        // Try to parse states from this page
        const states = [];
        $p('select').each((_, sel) => {
          const id = ($p(sel).attr('id') || '').toLowerCase();
          const nm = ($p(sel).attr('name') || '').toLowerCase();
          if (id.includes('state') || nm.includes('state')) {
            $p(sel).find('option').each((_, el) => {
              const val = $p(el).val()?.toString().trim();
              const txt = $p(el).text().trim();
              if (val && val !== '0' && txt) states.push({ code: val, name: txt });
            });
          }
        });
        if (states.length > 0) {
          console.log('States from page:', states.length);
          return res.status(200).json({ success: true, states, appToken });
        }
      } catch(e) { console.log('Page fetch failed:', e.message); }

      // Return hardcoded states as fallback
      console.log('Using hardcoded states');
      return res.status(200).json({ success: true, states: HARDCODED_STATES, appToken });
    }

    // ── Step 2: Get Districts ───────────────────────────
    if (action === 'districts') {
      let districts = [];
      // Try multiple endpoints
      for (const endpoint of ['cause_list/getDistrictName', 'casestatus/fillDistrict', 'casestatus/getDistrictName']) {
        try {
          const params = new URLSearchParams({ state_code, ajax_req: 'true', app_token: '' });
          const resp = await axios.post(`${BASE}/?p=${endpoint}`, params.toString(), {
            headers: H, timeout: 10000,
          });
          console.log(`${endpoint} response:`, typeof resp.data, JSON.stringify(resp.data).slice(0,200));
          const parsed = parseSelectOptions(resp.data);
          if (parsed.length > 0) { districts = parsed; break; }
        } catch(e) { console.log(`${endpoint} failed:`, e.message); }
      }
      return res.status(200).json({ success: true, districts });
    }

    // ── Step 3: Get Court Complexes ─────────────────────
    if (action === 'complexes') {
      const appToken = req.body.app_token || '';
      const params = new URLSearchParams({ state_code, dist_code, ajax_req: 'true', app_token: appToken });
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
      await axios.post(`${BASE}/?p=casestatus/set_data`, params.toString(),
        { headers: H, timeout: 12000 });
      // Get cause list courts
      const params2 = new URLSearchParams({
        state_code, dist_code,
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

    // ── Cause List CAPTCHA — use full captcha flow ──
    if (action === 'captcha') {
      try {
        // Step 1: Get session + token from getCaptcha
        const captchaPageResp = await axios.get(
          `${BASE}/?p=casestatus/getCaptcha`,
          { headers: { 'User-Agent': H['User-Agent'], 'Referer': `${BASE}/` }, timeout: 12000 }
        );
        const setCookie = captchaPageResp.headers['set-cookie'] || [];
        const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
        const rawData = captchaPageResp.data;
        // Extract token
        const tokenMatch = JSON.stringify(rawData).match(/([a-f0-9]{32})/);
        const captchaToken = tokenMatch ? tokenMatch[1] : '';
        console.log('CauseList captcha token:', captchaToken, 'cookie:', cookieStr.slice(0,30));
        // Step 2: Get CAPTCHA image
        const imgResp = await axios.get(
          `${BASE}/vendor/securimage/securimage_show.php?${captchaToken}`,
          { headers: { 'User-Agent': H['User-Agent'], 'Cookie': cookieStr }, responseType: 'arraybuffer', timeout: 10000 }
        );
        const contentType = imgResp.headers['content-type'] || 'image/png';
        const captchaBase64 = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;
        console.log('CauseList captcha imgLen:', captchaBase64.length);
        return res.status(200).json({ success: true, captchaBase64, cookieStr, captchaToken });
      } catch(e) {
        console.log('CauseList captcha error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
      }
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
        cicri:                 req.body.cicri || 'cri',
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
  // eCourts returns {dist_list: "<option>...</option>", status:1}
  let html = '';
  if (typeof data === 'string') {
    html = data;
  } else if (typeof data === 'object' && data !== null) {
    // Find any key ending in _list (dist_list, court_list, complex_list)
    const listKey = Object.keys(data).find(k => k.endsWith('_list'));
    if (listKey) {
      html = data[listKey];
    } else if (data.html) {
      html = data.html;
    }
  }
  if (!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  $('option').each((_, el) => {
    const val = $(el).val()?.toString().trim();
    const txt = $(el).text().trim();
    if (val && val !== '' && val !== '0' && txt && !txt.toLowerCase().startsWith('select')) {
      items.push({ code: val, name: txt });
    }
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