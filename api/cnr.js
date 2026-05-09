//const CryptoJS = require('crypto-js');
//const https    = require('https');
//const axios    = require('axios');
//const cheerio  = require('cheerio');
//
//const EK  = '4D6251655468576D5A7134743677397A';
//const DK  = '3273357638782F413F4428472B4B6250';
//const IVA = ["556A586E32723575","34743777217A2543","413F4428472B4B62","48404D635166546A","614E645267556B58","655368566D597133"];
//const UA  = 'Dalvik/2.1.0 (Linux; U; Android 13; SM-A226B Build/TP1A.220624.014)';
//
//const WEB_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
//const WEB_H = {
//  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
//  'X-Requested-With': 'XMLHttpRequest',
//  'Referer':          `${WEB_BASE}/`,
//  'Origin':            WEB_BASE,
//  'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
//};
//
//// ── Mobile API helpers ────────────────────────────────────────────────────────
//
//function enc(data) {
//  const gi  = Math.floor(Math.random() * IVA.length);
//  const riv = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
//  const key = CryptoJS.enc.Hex.parse(EK);
//  const iv  = CryptoJS.enc.Hex.parse(IVA[gi] + riv);
//  return riv + gi + CryptoJS.AES.encrypt(JSON.stringify(data), key, { iv }).ciphertext.toString(CryptoJS.enc.Base64);
//}
//
//function dec(r) {
//  if (!r || r.trim().length < 32) return null;
//  try {
//    return CryptoJS.AES.decrypt(
//      r.trim().slice(32),
//      CryptoJS.enc.Hex.parse(DK),
//      { iv: CryptoJS.enc.Hex.parse(r.trim().slice(0, 32)) }
//    ).toString(CryptoJS.enc.Utf8).replace(/[\u0000-\u0019]+/g, '');
//  } catch (e) { return null; }
//}
//
//function mobileGet(path, headers) {
//  return new Promise((resolve, reject) => {
//    const req = https.request(
//      { hostname: 'app.ecourts.gov.in', path, headers, method: 'GET', timeout: 15000 },
//      (r) => {
//        let body = '';
//        const cookies = r.headers['set-cookie'] || [];
//        r.on('data', d => body += d);
//        r.on('end', () => resolve({ body, cookies, status: r.statusCode }));
//      }
//    );
//    req.on('error', reject);
//    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
//    req.end();
//  });
//}
//
//const sleep = ms => new Promise(r => setTimeout(r, ms));
//
//// ── Web viewHistory — returns structured orders with displayPdf params ────────
//
//async function fetchWebDetail(cnr, caseNo, complexCode, courtCode, stateCode, distCode, webCookieStr) {
//  try {
//    const params = new URLSearchParams({
//      court_code:         courtCode   || '1',
//      state_code:         stateCode   || '',
//      dist_code:          distCode    || '',
//      court_complex_code: complexCode || '',
//      case_no:            caseNo      || '',
//      cino:               cnr,
//      hideparty:          '',
//      search_flag:        'CScaseNumber',
//      search_by:          'CSAdvName',
//      ajax_req:           'true',
//      app_token:          '',
//    });
//
//    const resp = await axios.post(
//      `${WEB_BASE}/?p=home/viewHistory`,
//      params.toString(),
//      { headers: { ...WEB_H, 'Cookie': webCookieStr || '' }, timeout: 15000 }
//    );
//
//    const raw  = resp.data;
//    const html = typeof raw === 'object' ? (raw.data_list || '') : raw;
//    if (!html || html.length < 20) return null;
//
//    return parseWebOrders(html);
//  } catch (err) {
//    console.log('[fetchWebDetail] failed:', err.message);
//    return null;
//  }
//}
//
//// Parse ONLY orders and hearing history from viewHistory HTML
//function parseWebOrders(html) {
//  const $ = cheerio.load(html);
//
//  // ── Orders (with displayPdf onclick params) ───────────────────────────────
//  const parseOrderTable = (root) => {
//    const orders = [];
//    root.find('tr').each((_, row) => {
//      const cells   = $(row).find('td');
//      if (cells.length < 2) return;
//      const numText  = $(cells[0]).text().trim().replace(/&nbsp;/g, '').trim();
//      const dateText = $(cells[1]).text().trim().replace(/&nbsp;/g, '').trim();
//      const details  = cells.length >= 3 ? $(cells[2]).text().trim() : '';
//      const onClick  = $(row).find('a').attr('onclick') || '';
//      // displayPdf('normal_v','case_val','court_code','filename','appFlag')
//      const m = onClick.match(/displayPdf\('([^']+)','([^']+)','([^']+)','([^']+)','([^']*)'\)/);
//      if (/^\d+$/.test(numText) && /\d{2}-\d{2}-\d{4}/.test(dateText)) {
//        orders.push({
//          orderNo: numText,
//          date:    dateText,
//          details,
//          ...(m ? {
//            normal_v:   m[1],
//            case_val:   m[2],
//            court_code: m[3],
//            filename:   m[4],
//            appFlag:    m[5],
//          } : {}),
//        });
//      }
//    });
//    return orders;
//  };
//
//  const orderTables = [];
//  $('table').each((_, tbl) => {
//    const txt = $(tbl).text().toLowerCase();
//    if (txt.includes('order number') || txt.includes('copy of order') || txt.includes('copy of final order')) {
//      orderTables.push($(tbl));
//    }
//  });
//
//  let interimOrders = [], finalOrders = [];
//  if (orderTables.length === 1) {
//    const txt = orderTables[0].text().toLowerCase();
//    if (txt.includes('final')) finalOrders   = parseOrderTable(orderTables[0]);
//    else                       interimOrders = parseOrderTable(orderTables[0]);
//  } else if (orderTables.length >= 2) {
//    interimOrders = parseOrderTable(orderTables[0]);
//    finalOrders   = parseOrderTable(orderTables[orderTables.length - 1]);
//  }
//
//  // ── Hearing history ───────────────────────────────────────────────────────
//  const history = [];
//  $('table').each((_, tbl) => {
//    const txt = $(tbl).text().toLowerCase();
//    if (!txt.includes('hearing date') || !txt.includes('purpose')) return;
//    $(tbl).find('tr').each((_, row) => {
//      const cells = $(row).find('td');
//      if (cells.length < 3) return;
//      let judge = '', businessDate = '', hearingDate = '', purpose = '';
//      if (cells.length >= 4) {
//        judge        = $(cells[0]).text().replace(/\s+/g, ' ').trim();
//        businessDate = $(cells[1]).text().replace(/\s+/g, ' ').trim();
//        hearingDate  = $(cells[2]).text().replace(/\s+/g, ' ').trim();
//        purpose      = $(cells[3]).text().replace(/\s+/g, ' ').trim();
//      } else {
//        businessDate = $(cells[0]).text().replace(/\s+/g, ' ').trim();
//        hearingDate  = $(cells[1]).text().replace(/\s+/g, ' ').trim();
//        purpose      = $(cells[2]).text().replace(/\s+/g, ' ').trim();
//      }
//      if (/\d{2}-\d{2}-\d{4}/.test(hearingDate) || /\d{2}-\d{2}-\d{4}/.test(businessDate)) {
//        history.push({ judge, businessDate, hearingDate, purpose });
//      }
//    });
//  });
//
//  return {
//    interimOrders,
//    finalOrders,
//    orders: [...interimOrders, ...finalOrders],
//    hearingHistoryRows: history,
//  };
//}
//
//// ── Mobile API lookup ─────────────────────────────────────────────────────────
//
//async function cnrLookup(cnr) {
//  // Step 1: appRelease token + cookies
//  const tr = await mobileGet(
//    `/ecourt_mobile_DC/appReleaseWebService.php?params=${encodeURIComponent(enc({ version: '7.0', uid: '324456:in.gov.ecourts.eCourtsServices' }))}`,
//    { 'User-Agent': UA, 'Accept-Charset': 'UTF-8' }
//  );
//  const cm = {};
//  tr.cookies.forEach(c => {
//    const [p] = c.split(';');
//    const [k, v] = p.split('=');
//    if (k && v) cm[k.trim()] = v.trim();
//  });
//  const appToken = JSON.parse(dec(tr.body)).token;
//  const cookie   = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');
//
//  await sleep(1000);
//
//  // Step 2: listOfCases → case_number + codes
//  const h1 = { 'User-Agent': UA, 'Accept-Charset': 'UTF-8', 'Authorization': 'Bearer ' + enc(appToken), 'Cookie': cookie };
//  const r1 = await mobileGet(
//    `/ecourt_mobile_DC/listOfCasesWebService.php?params=${encodeURIComponent(enc({ cino: cnr, language_flag: '0', bilingual_flag: '0', state_code: '14', dist_code: '2' }))}`,
//    h1
//  );
//  const d1 = JSON.parse(dec(r1.body));
//  const caseNo    = d1.case_number;
//  const caseToken = d1.token;
//
//  if (!caseNo) throw new Error('case_number not found — CNR may be invalid');
//
//  await sleep(1000);
//
//  // Step 3: caseHistory (mobile)
//  const h2 = { 'User-Agent': UA, 'Accept-Charset': 'UTF-8', 'Authorization': 'Bearer ' + enc(caseToken || appToken), 'Cookie': cookie };
//  const r2 = await mobileGet(
//    `/ecourt_mobile_DC/caseHistoryWebService.php?params=${encodeURIComponent(enc({ case_number: caseNo, cino: cnr, state_code: '14', dist_code: '2', court_code: '3', language_flag: '0', bilingual_flag: '0' }))}`,
//    h2
//  );
//
//  const d2Raw = dec(r2.body);
//  console.log('r2.status:', r2.status);
//  console.log('d2 decoded:', d2Raw?.substring(0, 200));
//
//  let h = null;
//  try {
//    const json = JSON.parse(d2Raw);
//    h = json.history || json;
//  } catch (e) {
//    console.log('caseHistory parse error:', e.message);
//  }
//
//  // ── Step 4: Web viewHistory — get structured orders with displayPdf params ─
//  // Use codes from mobile response if available, else fall back to defaults
//  const stateCode   = h?.state_code   || '14';
//  const distCode    = h?.district_code || '2';
//  const complexCode = h?.complex_code  || '';
//  const courtCode   = h?.court_code    || '1';
//
//  const webDetail = await fetchWebDetail(cnr, caseNo, complexCode, courtCode, stateCode, distCode, '');
//
//  console.log('[webDetail] orders:', webDetail?.orders?.length ?? 'failed');
//  console.log('[webDetail] history rows:', webDetail?.hearingHistoryRows?.length ?? 0);
//
//  return {
//    cnr:                 h?.cino         || cnr,
//    caseType:            h?.type_name    || '',
//    filingDate:          h?.date_of_filing || '',
//    registrationDate:    h?.dt_regis     || '',
//    nextDate:            h?.date_next_list || '',
//    lastDate:            h?.date_last_list || '',
//    status:              h?.disp_nature === 0 ? 'Pending' : (h?.disp_nature ? 'Disposed' : 'Pending'),
//    court:               h?.court_name   || '',
//    judge:               h?.desgname     || '',
//    petitioner:          h?.pet_name     || '',
//    petitionerAdvocate:  h?.pet_adv      || '',
//    respondent:          h?.res_name     || '',
//    respondentAdvocate:  h?.res_adv      || '',
//    nextPurpose:         h?.purpose_name?.trim() || '',
//    act:                 h?.under_act1   || '',
//    stateCode,
//    districtCode:        distCode,
//    districtName:        h?.district_name || '',
//    stateName:           h?.state_name   || '',
//    complexCode,
//    courtCode,
//    caseNo,
//
//    // ── Orders: web-parsed structured list (has displayPdf params for download) ──
//    orders:         webDetail?.orders         || [],
//    interimOrders:  webDetail?.interimOrders  || [],
//    finalOrders:    webDetail?.finalOrders    || [],
//
//    // ── Hearing history: prefer web-parsed rows, fallback to mobile raw HTML ──
//    hearingHistoryRows: webDetail?.hearingHistoryRows || [],
//    hearingHistoryRaw:  h?.historyOfCaseHearing || '',
//
//    processes: h?.processes || '',
//  };
//}
//
//// ── Handler ───────────────────────────────────────────────────────────────────
//
//module.exports = async (req, res) => {
//  res.setHeader('Access-Control-Allow-Origin', '*');
//  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
//  if (req.method === 'OPTIONS') return res.status(200).end();
//  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
//
//  const cnr = (req.query.cnr || '').trim().toUpperCase();
//  if (!cnr || cnr.length < 10) {
//    return res.status(400).json({ error: 'cnr query param required (e.g. ?cnr=HRSI020002542021)' });
//  }
//
//  try {
//    const data = await cnrLookup(cnr);
//    return res.status(200).json({ success: true, data });
//  } catch (err) {
//    console.error('CNR error:', err.message);
//    return res.status(500).json({ success: false, error: err.message });
//  }
//};
// api/mobile_cnr.js
// DISABLED — do not use official mobile app encrypted endpoint.

module.exports = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'This endpoint is disabled. Use CAPTCHA-based official web flow only.',
  });
};