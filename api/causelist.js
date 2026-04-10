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

// ── Retry helper — waits before retrying on 403/5xx ──────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postWithRetry(url, params, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios.post(url, params, { headers: H, timeout: 12000, ...options });
      return resp;
    } catch (e) {
      const status = e.response?.status;
      const isRetryable = status === 403 || status === 429 || status >= 500;
      console.log(`postWithRetry attempt ${i+1} failed: ${status || e.message}`);
      if (isRetryable && i < retries - 1) {
        const delay = (i + 1) * 1200; // 1.2s, 2.4s
        console.log(`Waiting ${delay}ms before retry...`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}

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
      const endpoints = [
        'cause_list/getDistrictName',
        'casestatus/fillDistrict',
        'casestatus/getDistrictName',
      ];
      for (const endpoint of endpoints) {
        try {
          const params = new URLSearchParams({ state_code, ajax_req: 'true', app_token: '' });
          // postWithRetry: retries 3x with 1.2s, 2.4s backoff on 403/5xx
          const resp = await postWithRetry(`${BASE}/?p=${endpoint}`, params.toString());
          console.log(`${endpoint} response:`, typeof resp.data, JSON.stringify(resp.data).slice(0,200));
          const parsed = parseSelectOptions(resp.data);
          if (parsed.length > 0) { districts = parsed; break; }
        } catch(e) { console.log(`${endpoint} failed:`, e.message); }
      }
      // All live endpoints failed → hardcoded fallback so UI never gets stuck
      if (districts.length === 0) {
        const hd = HARDCODED_DISTRICTS[String(state_code)];
        if (hd) { districts = hd; console.log('Using hardcoded districts for state', state_code); }
      }
      return res.status(200).json({ success: true, districts });
    }

    // ── Step 3: Get Court Complexes ─────────────────────
    if (action === 'complexes') {
      const appToken = req.body.app_token || '';
      const params = new URLSearchParams({ state_code, dist_code, ajax_req: 'true', app_token: appToken });
      const resp = await postWithRetry(`${BASE}/?p=casestatus/fillcomplex`, params.toString());
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
      await postWithRetry(`${BASE}/?p=casestatus/set_data`, params.toString());
      // Get cause list courts
      const params2 = new URLSearchParams({
        state_code, dist_code,
        court_complex_code: complex_code,
        est_code,
        search_act: 'undefined',
        ajax_req: 'true',
        app_token: '',
      });
      const resp2 = await postWithRetry(`${BASE}/?p=cause_list/fillCauseList`, params2.toString());
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

      // Log first few rows to understand structure
      const $dbg = cheerio.load(html);
      let rowCount = 0;
      $dbg('table tr').each((_, row) => {
        if (rowCount++ > 8) return false;
        const cells = $dbg(row).find('td');
        if (cells.length < 2) return;
        console.log(`[ROW] cells=${cells.length}`);
        cells.each((ci, cell) => {
          console.log(`  [${ci}]: "${$dbg(cell).text().replace(/\s+/g,' ').trim().slice(0,100)}"`);
        });
      });

      const cases = parseCauseListHTML(html);
      console.log('Parsed cases:', cases.length);
      return res.status(200).json({ success: true, cases, totalCases: cases.length });
    }

    // ── Step 6: Batch fetch nextDate for a batch of cases ──────────────────
    if (action === 'nextdates') {
      const batchCases = req.body.cases || [];
      if (!batchCases.length) return res.status(200).json({ success: true, dates: {}, details: {} });

      const dates   = {};  // cnr → nextDate string
      const details = {};  // cnr → { disposal, caseStage, caseStatus }

      await Promise.allSettled(batchCases.map(async (c) => {
        if (!c.cnr) return;
        try {
          const p = new URLSearchParams({
            court_code: c.courtCode || '1', state_code: state_code || '',
            dist_code: dist_code || '',
            court_complex_code: (complex_code || '').split('@')[0],
            case_no: c.caseNoNum || '', cino: c.cnr,
            hideparty: '', search_flag: 'CScaseNumber',
            search_by: 'CSAdvName', ajax_req: 'true', app_token: '',
          });
          const r = await axios.post(`${BASE}/?p=home/viewHistory`,
            p.toString(), { headers: H, timeout: 6000 });
          const raw = r.data;
          const html = typeof raw === 'object' ? (raw.data_list || '') : raw;
          if (!html || html.length < 20) return;

          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

          // Check if case is disposed first
          const isDisposed = /Case\s+disposed/i.test(text) ||
            /Nature\s+of\s+Disposal/i.test(text);

          // Next date — only if NOT disposed
          if (!isDisposed) {
            const mDate = text.match(/Next\s+(?:Hearing\s+)?Date\s*[:\-]?\s*(\d{2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}|\d{2}-\d{2}-\d{4})/i);
            if (mDate) dates[c.cnr] = mDate[1].trim();
          }

          // Disposal / Nature of Disposal
          const mDisp = text.match(/Nature\s+of\s+Disposal\s+([A-Za-z\s\-\(\)]+?)(?=\s{2,}|\s*Court|\s*Stage|\s*$)/i);
          const mStage = text.match(/Case\s+Stage\s+([A-Za-z\s\-\(\)]+?)(?=\s{2,}|\s*Court|\s*$)/i);
          const mStatus = text.match(/Case\s+Status\s+([A-Za-z\s]+?)(?=\s{2,}|\s*Nature|\s*$)/i);

          const disposal   = mDisp  ? mDisp[1].trim()  : '';
          const caseStage  = mStage ? mStage[1].trim() : '';
          const caseStatus = mStatus? mStatus[1].trim(): '';

          if (disposal || caseStage || caseStatus) {
            details[c.cnr] = { disposal, caseStage, caseStatus };
          }
        } catch (_) {}
      }));

      return res.status(200).json({ success: true, dates, details });
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

    if (cells.length === 1 && $(cells[0]).attr('colspan')) {
      const txt = $(cells[0]).text().trim();
      if (txt && !txt.includes('---') && txt.length < 80) currentStage = txt;
      return;
    }

    if (cells.length < 3) return;

    const srNo = $(cells[0]).text().trim();
    if (!/^\d+$/.test(srNo)) return;

    const link = $(cells[1]).find('a').first();
    const onClick = link.attr('onclick') || '';

    // Case cell may contain: "BA/1230/2026\nNext hearing date:- 08-04-2026"
    // Get full text of cell minus the View button
    const cellText = $(cells[1]).clone()
      .find('a, button, input').remove().end()
      .text()
      .replace(/&nbsp;/g, ' ')
      .trim();

    // Extract next date if present in cell text
    let nextDate = '';
    const nextDateMatch = cellText.match(/Next\s+hearing\s+date\s*[:\-]+\s*([\d\-\/]+)/i)
      || cellText.match(/(\d{2}-\d{2}-\d{4})/);
    if (nextDateMatch) nextDate = nextDateMatch[1].trim();

    // Case number = everything before "Next hearing" or date pattern
    let caseNoRaw = cellText
      .replace(/Next\s+hearing\s+date[\s:\-]*([\d\-\/]+)?/gi, '')
      .replace(/\d{2}-\d{2}-\d{4}/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!caseNoRaw) {
      caseNoRaw = $(cells[1]).text()
        .replace(/\bView\b/gi, '')
        .replace(/Next\s+hearing\s+date[\s:\-]*([\d\-\/]+)?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // extract cnr / caseNoNum / courtCode robustly
    let cnr = '';
    let caseNoNum = '';
    let courtCode = '1';

    const vhMatch = onClick.match(/viewHistory\s*\(\s*'?(\d+)'?\s*,\s*'([^']+)'\s*,\s*'?(\d+)'?\s*\)/i);
    if (vhMatch) {
      caseNoNum = vhMatch[1] || '';
      cnr = vhMatch[2] || '';
      courtCode = vhMatch[3] || '1';
    }

    if (!cnr) {
      const cnrMatch = onClick.match(/\b([A-Z]{4}[A-Z0-9]{12,20})\b/i);
      if (cnrMatch) cnr = cnrMatch[1];
    }

    const partiesHtml = $(cells[2]).html() || '';
    const partiesText = partiesHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s*\bversus\b\s*/gi, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const partiesClean = partiesText.join(' vs ').replace(/\s+vs\s+vs\s+/gi, ' vs ').replace(/\s{2,}/g, ' ').trim();

    // Advocate column (index 3)
    const advRaw = cells.length >= 4 ? $(cells[3]).html() || '' : '';
    const advLines = advRaw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    let petAdvocate = '', respAdvocate = '', advocate = '';
    if (advLines.length >= 2) {
      petAdvocate  = advLines[0].trim();
      respAdvocate = advLines[1].trim();
      advocate = petAdvocate;
    } else if (advLines.length === 1) {
      const parts = advLines[0].split(/\s{3,}/);
      if (parts.length >= 2) {
        petAdvocate  = parts[0].trim();
        respAdvocate = parts[1].trim();
      } else {
        petAdvocate = advLines[0].trim();
      }
      advocate = petAdvocate;
    }

    // Next date — try all possible locations:
    // 1. Already extracted from case cell text (civil - inside cell)
    // 2. 5th column (criminal - separate column)
    // 3. Scan all remaining columns
    if (!nextDate) {
      for (let ci = 3; ci < cells.length; ci++) {
        const txt = $(cells[ci]).text().replace(/&nbsp;/g, ' ').trim();
        const m = txt.match(/(\d{2}-\d{2}-\d{4})/);
        if (m) { nextDate = m[1]; break; }
      }
    }

    console.log(`[${srNo}] caseNo="${caseNoRaw}" cells=${cells.length} nextDate="${nextDate}`);

    cases.push({
      srNo,
      caseNo: caseNoRaw,
      caseNoNum,
      cnr,
      courtCode,
      parties: partiesClean,
      advocate,
      petAdvocate,
      respAdvocate,
      nextDate,
      stage: currentStage,
    });
  });

  return cases;
}
// ── Hardcoded Districts fallback — used when eCourts returns 403 ─────────
// state_code → district list  (codes from eCourts network inspection)
const HARDCODED_DISTRICTS = {
  // Punjab (29)
  '29': [
    {code:'1',name:'Amritsar'},{code:'2',name:'Barnala'},{code:'3',name:'Bathinda'},
    {code:'4',name:'Faridkot'},{code:'5',name:'Fatehgarh Sahib'},{code:'6',name:'Fazilka'},
    {code:'7',name:'Ferozepur'},{code:'8',name:'Gurdaspur'},{code:'9',name:'Hoshiarpur'},
    {code:'10',name:'Jalandhar'},{code:'11',name:'Kapurthala'},{code:'12',name:'Ludhiana'},
    {code:'13',name:'Mansa'},{code:'14',name:'Moga'},{code:'15',name:'Mohali (SAS Nagar)'},
    {code:'16',name:'Muktsar'},{code:'17',name:'Pathankot'},{code:'18',name:'Patiala'},
    {code:'19',name:'Rupnagar'},{code:'20',name:'Sangrur'},{code:'21',name:'Shahid Bhagat Singh Nagar'},
    {code:'22',name:'Tarn Taran'},
  ],
  // Haryana (13)
  '13': [
    {code:'3',name:'Ambala'},{code:'4',name:'Bhiwani'},{code:'88',name:'Charkhi Dadri'},
    {code:'5',name:'Faridabad'},{code:'6',name:'Fatehabad'},{code:'7',name:'Gurugram'},
    {code:'8',name:'Hisar'},{code:'9',name:'Jhajjar'},{code:'10',name:'Jind'},
    {code:'11',name:'Kaithal'},{code:'12',name:'Karnal'},{code:'13',name:'Kurukshetra'},
    {code:'14',name:'Mahendragarh'},{code:'15',name:'Nuh'},{code:'16',name:'Palwal'},
    {code:'17',name:'Panchkula'},{code:'18',name:'Panipat'},{code:'19',name:'Rewari'},
    {code:'20',name:'Rohtak'},{code:'21',name:'Sirsa'},{code:'22',name:'Sonipat'},
    {code:'23',name:'Yamunanagar'},
  ],
  // Delhi (10)
  '10': [
    {code:'1',name:'Central'},{code:'2',name:'East'},{code:'3',name:'New Delhi'},
    {code:'4',name:'North'},{code:'5',name:'North East'},{code:'6',name:'North West'},
    {code:'7',name:'Shahdara'},{code:'8',name:'South'},{code:'9',name:'South East'},
    {code:'10',name:'South West'},{code:'11',name:'West'},
  ],
  // Chandigarh (6)
  '6': [{code:'1',name:'Chandigarh'}],
  // Uttar Pradesh (35)
  '35': [
    {code:'1',name:'Agra'},{code:'2',name:'Aligarh'},{code:'3',name:'Allahabad'},
    {code:'4',name:'Ambedkar Nagar'},{code:'5',name:'Amethi'},{code:'6',name:'Amroha'},
    {code:'7',name:'Auraiya'},{code:'8',name:'Azamgarh'},{code:'9',name:'Baghpat'},
    {code:'10',name:'Bahraich'},{code:'11',name:'Ballia'},{code:'12',name:'Balrampur'},
    {code:'13',name:'Banda'},{code:'14',name:'Barabanki'},{code:'15',name:'Bareilly'},
    {code:'16',name:'Basti'},{code:'17',name:'Bhadohi'},{code:'18',name:'Bijnor'},
    {code:'19',name:'Budaun'},{code:'20',name:'Bulandshahr'},{code:'21',name:'Chandauli'},
    {code:'22',name:'Chitrakoot'},{code:'23',name:'Deoria'},{code:'24',name:'Etah'},
    {code:'25',name:'Etawah'},{code:'26',name:'Farrukhabad'},{code:'27',name:'Fatehpur'},
    {code:'28',name:'Firozabad'},{code:'29',name:'Gautam Buddha Nagar'},{code:'30',name:'Ghaziabad'},
    {code:'31',name:'Ghazipur'},{code:'32',name:'Gonda'},{code:'33',name:'Gorakhpur'},
    {code:'34',name:'Hamirpur'},{code:'35',name:'Hapur'},{code:'36',name:'Hardoi'},
    {code:'37',name:'Hathras'},{code:'38',name:'Jalaun'},{code:'39',name:'Jaunpur'},
    {code:'40',name:'Jhansi'},{code:'41',name:'Kannauj'},{code:'42',name:'Kanpur Dehat'},
    {code:'43',name:'Kanpur Nagar'},{code:'44',name:'Kasganj'},{code:'45',name:'Kaushambi'},
    {code:'46',name:'Kheri'},{code:'47',name:'Kushinagar'},{code:'48',name:'Lalitpur'},
    {code:'49',name:'Lucknow'},{code:'50',name:'Maharajganj'},{code:'51',name:'Mahoba'},
    {code:'52',name:'Mainpuri'},{code:'53',name:'Mathura'},{code:'54',name:'Mau'},
    {code:'55',name:'Meerut'},{code:'56',name:'Mirzapur'},{code:'57',name:'Moradabad'},
    {code:'58',name:'Muzaffarnagar'},{code:'59',name:'Pilibhit'},{code:'60',name:'Pratapgarh'},
    {code:'61',name:'Prayagraj'},{code:'62',name:'Raebareli'},{code:'63',name:'Rampur'},
    {code:'64',name:'Saharanpur'},{code:'65',name:'Sambhal'},{code:'66',name:'Sant Kabir Nagar'},
    {code:'67',name:'Shahjahanpur'},{code:'68',name:'Shamli'},{code:'69',name:'Shravasti'},
    {code:'70',name:'Siddharthnagar'},{code:'71',name:'Sitapur'},{code:'72',name:'Sonbhadra'},
    {code:'73',name:'Sultanpur'},{code:'74',name:'Unnao'},{code:'75',name:'Varanasi'},
  ],
  // Maharashtra (22)
  '22': [
    {code:'1',name:'Ahmednagar'},{code:'2',name:'Akola'},{code:'3',name:'Amravati'},
    {code:'4',name:'Aurangabad'},{code:'5',name:'Beed'},{code:'6',name:'Bhandara'},
    {code:'7',name:'Buldhana'},{code:'8',name:'Chandrapur'},{code:'9',name:'Dhule'},
    {code:'10',name:'Gadchiroli'},{code:'11',name:'Gondia'},{code:'12',name:'Hingoli'},
    {code:'13',name:'Jalgaon'},{code:'14',name:'Jalna'},{code:'15',name:'Kolhapur'},
    {code:'16',name:'Latur'},{code:'17',name:'Mumbai City'},{code:'18',name:'Mumbai Suburban'},
    {code:'19',name:'Nagpur'},{code:'20',name:'Nanded'},{code:'21',name:'Nandurbar'},
    {code:'22',name:'Nashik'},{code:'23',name:'Osmanabad'},{code:'24',name:'Palghar'},
    {code:'25',name:'Parbhani'},{code:'26',name:'Pune'},{code:'27',name:'Raigad'},
    {code:'28',name:'Ratnagiri'},{code:'29',name:'Sangli'},{code:'30',name:'Satara'},
    {code:'31',name:'Sindhudurg'},{code:'32',name:'Solapur'},{code:'33',name:'Thane'},
    {code:'34',name:'Wardha'},{code:'35',name:'Washim'},{code:'36',name:'Yavatmal'},
  ],
};