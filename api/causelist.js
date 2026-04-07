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

    // ── Case Types ──────────────────────────────────────
    if (action === 'caseTypes') {
      const { court_complex_code } = req.body;
      const complexCode = (court_complex_code || '').split('@')[0];
      const params = new URLSearchParams({
        state_code, dist_code,
        court_complex_code: complexCode,
        est_code: '',
        ajax_req: 'true', app_token: '',
      });
      const resp = await axios.post(`${BASE}/?p=casestatus/fillCaseType`, params.toString(),
        { headers: H, timeout: 12000 });
      const types = parseSelectOptions(resp.data);
      return res.status(200).json({ success: true, types });
    }

    // ── Police Stations ─────────────────────────────────
    if (action === 'policeStations') {
      const { court_complex_code } = req.body;
      const complexCode = (court_complex_code || '').split('@')[0];
      const params = new URLSearchParams({
        state_code, dist_code,
        court_complex_code: complexCode,
        est_code: '',
        ajax_req: 'true', app_token: '',
      });
      const resp = await axios.post(`${BASE}/?p=casestatus/fillPoliceStation`, params.toString(),
        { headers: H, timeout: 12000 });
      const stations = parseSelectOptions(resp.data);
      return res.status(200).json({ success: true, stations });
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

    // ── Cause List CAPTCHA ──────────────────────────────
    if (action === 'captcha') {
      try {
        const { wrapper } = require('axios-cookiejar-support');
        const { CookieJar } = require('tough-cookie');
        const jar = new CookieJar();
        const client = wrapper(axios.create({ jar }));

        // Step 1: Load cause_list page — sets session cookies in jar
        const pageResp = await client.get(`${BASE}/?p=cause_list/index&app_token=`, {
          headers: { 'User-Agent': H['User-Agent'], 'Referer': `${BASE}/` },
          timeout: 12000,
        });
        console.log('CauseList page status:', pageResp.status, '| len:', pageResp.data.length);

        // Extract captcha token from page HTML
        const tokenMatch = pageResp.data.match(/securimage_show\.php\?([a-f0-9]+)/);
        const captchaToken = tokenMatch ? tokenMatch[1] : '';
        console.log('CauseList captcha token:', captchaToken || 'NOT FOUND');

        // Step 2: Get CAPTCHA image with SAME jar (same session)
        const imgUrl = captchaToken
          ? `${BASE}/vendor/securimage/securimage_show.php?${captchaToken}`
          : `${BASE}/vendor/securimage/securimage_show.php`;
        const imgResp = await client.get(imgUrl, {
          headers: { 'User-Agent': H['User-Agent'], 'Referer': `${BASE}/?p=cause_list/index` },
          responseType: 'arraybuffer', timeout: 10000,
        });

        // Get all cookies from jar
        const cookies = await jar.getCookies(BASE);
        const cookieStr = cookies.map(c => `${c.key}=${c.value}`).join('; ');
        console.log('CauseList jar cookies:', cookieStr.slice(0, 80));

        const contentType = imgResp.headers['content-type'] || 'image/png';
        const captchaBase64 = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;
        console.log('CauseList captcha imgLen:', captchaBase64.length);
        return res.status(200).json({ success: true, captchaBase64, cookieStr, captchaToken });
      } catch(e) {
        console.log('CauseList captcha error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    // ── Step 5: Submit & Get Cause List (okhttp bypasses CAPTCHA) ──
    if (action === 'list') {
      const params = new URLSearchParams({
        CL_court_no:             court_no,
        causelist_date:          causelist_date,
        cause_list_captcha_code: '',          // empty — okhttp bypasses CAPTCHA
        court_name_txt:          '',
        state_code,
        dist_code,
        court_complex_code:      complex_code,
        est_code:                est_code || 'null',
        cicri:                   req.body.cicri || 'cri',
        selprevdays:             '0',
        ajax_req:                'true',
        app_token:               '',
      });
      const resp = await axios.post(`${BASE}/?p=cause_list/submitCauseList`, params.toString(), {
        headers: { ...H, 'Cookie': cookieStr || '',
          'Referer': `${BASE}/?p=cause_list/index` },
        timeout: 20000,
      });
      const rawResp = resp.data;
      console.log('Submit raw keys:', typeof rawResp === 'object' ? Object.keys(rawResp) : 'string');

      // Check for invalid captcha
      if (typeof rawResp === 'object' && rawResp.errormsg && rawResp.errormsg.toLowerCase().includes('invalid captcha')) {
        // Extract new captcha token from response
        const newToken = (rawResp.div_captcha || '').match(/securimage_show\.php\?([a-f0-9]+)/)?.[1] || '';
        return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo', newCaptchaToken: newToken });
      }

      // Get HTML from case_data or cause_list_html
      const html = (typeof rawResp === 'object')
        ? (rawResp.case_data || rawResp.cause_list_html || rawResp.html || JSON.stringify(rawResp))
        : rawResp;

      console.log('Submit html len:', html.length, '| preview:', html.slice(0, 150));
    console.log('===== RAW CAUSE HTML SAMPLE =====');
    console.log(html.slice(0, 3000));
    console.log('=================================');
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
  let currentStage = '';

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');

    // Stage row
    if (cells.length === 1 && $(cells[0]).attr('colspan')) {
      const txt = $(cells[0]).text().trim();
      if (txt && !txt.includes('---') && txt.length < 80) {
        currentStage = txt;
      }
      return;
    }

    if (cells.length < 3) return;

    const srNo = $(cells[0]).text().trim();
    if (!/^\d+$/.test(srNo)) return;

    const caseNoRaw = $(cells[1]).text().replace(/\s+/g, ' ').replace(/^View\s*/i, '').trim();

    const link = $(cells[1]).find('a').first();
    const onClick = link.attr('onclick') || '';
    const href = link.attr('href') || '';

    console.log('------ CAUSE ROW DEBUG ------');
    console.log('srNo:', srNo);
    console.log('caseNoRaw:', caseNoRaw);
    console.log('onclick:', onClick);
    console.log('href:', href);
    console.log('-----------------------------');

    let cnr = '';
    let caseNoNum = '';
    let courtCode = '1';

    // 1) Try standard viewHistory(caseNo, 'CNR', courtCode)
    let m = onClick.match(/viewHistory\s*\(\s*'?(\d+)'?\s*,\s*'([A-Z0-9]+)'\s*,\s*'?(\d+)'?/i);
    if (m) {
      caseNoNum = m[1] || '';
      cnr = m[2] || '';
      courtCode = m[3] || '1';
    }

    // 2) Try if CNR is present elsewhere in onclick
    if (!cnr) {
      const cnrMatch = onClick.match(/\b([A-Z]{4}[A-Z0-9]{12,20})\b/i);
      if (cnrMatch) cnr = cnrMatch[1];
    }

    // 3) Try fallback numeric extraction from onclick
    if (!caseNoNum || courtCode === '1') {
      const nums = onClick.match(/\d+/g) || [];
      console.log('onclick numeric tokens:', nums);

      if (!caseNoNum && nums.length >= 1) {
        caseNoNum = nums[0];
      }
      if (courtCode === '1' && nums.length >= 2) {
        courtCode = nums[nums.length - 1];
      }
    }

    // 4) Try href fallback too
    if ((!cnr || !caseNoNum) && href) {
      const hrefNums = href.match(/\d+/g) || [];
      console.log('href numeric tokens:', hrefNums);

      const hrefCnr = href.match(/\b([A-Z]{4}[A-Z0-9]{12,20})\b/i);
      if (!cnr && hrefCnr) cnr = hrefCnr[1];
      if (!caseNoNum && hrefNums.length >= 1) caseNoNum = hrefNums[0];
      if (courtCode === '1' && hrefNums.length >= 2) courtCode = hrefNums[hrefNums.length - 1];
    }

    const parties = $(cells[2]).text().replace(/\s+/g, ' ').trim();
    const advocate = cells.length >= 4
      ? $(cells[3]).text().replace(/\s+/g, ' ').trim()
      : '';

    console.log('parsed =>', {
      srNo, caseNoRaw, caseNoNum, cnr, courtCode, parties, advocate, stage: currentStage
    });

    cases.push({
      srNo,
      caseNo: caseNoRaw,
      caseNoNum,
      cnr,
      courtCode,
      parties,
      advocate,
      stage: currentStage,
    });
  });

  return cases;
}