const CryptoJS = require('crypto-js');
const https = require('https');

const EK = '4D6251655468576D5A7134743677397A';
const DK = '3273357638782F413F4428472B4B6250';
const IVA = ["556A586E32723575","34743777217A2543","413F4428472B4B62","48404D635166546A","614E645267556B58","655368566D597133"];
const UA = 'Dalvik/2.1.0 (Linux; U; Android 13; SM-A226B Build/TP1A.220624.014)';

function enc(data) {
  const gi = Math.floor(Math.random() * IVA.length);
  const riv = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const key = CryptoJS.enc.Hex.parse(EK);
  const iv = CryptoJS.enc.Hex.parse(IVA[gi] + riv);
  return riv + gi + CryptoJS.AES.encrypt(JSON.stringify(data), key, { iv }).ciphertext.toString(CryptoJS.enc.Base64);
}

function dec(r) {
  if (!r || r.trim().length < 32) return null;
  try {
    return CryptoJS.AES.decrypt(
      r.trim().slice(32),
      CryptoJS.enc.Hex.parse(DK),
      { iv: CryptoJS.enc.Hex.parse(r.trim().slice(0, 32)) }
    ).toString(CryptoJS.enc.Utf8).replace(/[\u0000-\u0019]+/g, '');
  } catch (e) {
    return null;
  }
}

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'app.ecourts.gov.in', path, headers, method: 'GET', timeout: 15000 },
      (r) => {
        let body = '';
        const cookies = r.headers['set-cookie'] || [];
        r.on('data', d => body += d);
        r.on('end', () => resolve({ body, cookies, status: r.statusCode }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// CNR → state/dist codes mapping (first 4 chars = state+dist)
function parseCnr(cnr) {
  // e.g. HRSI02... → Haryana=14, Sirsa=2
  // We extract from listOfCases response anyway, but pass defaults
  // State/dist extracted from CNR not needed — server uses cino directly
  return { stateCode: '14', distCode: '2' };
}

async function cnrLookup(cnr) {
  const { stateCode, distCode } = parseCnr(cnr);

  // Step 1: appRelease token + cookies
  const tr = await get(
    `/ecourt_mobile_DC/appReleaseWebService.php?params=${encodeURIComponent(enc({ version: '7.0', uid: '324456:in.gov.ecourts.eCourtsServices' }))}`,
    { 'User-Agent': UA, 'Accept-Charset': 'UTF-8' }
  );
  const cm = {};
  tr.cookies.forEach(c => {
    const [p] = c.split(';');
    const [k, v] = p.split('=');
    if (k && v) cm[k.trim()] = v.trim();
  });
  const appToken = JSON.parse(dec(tr.body)).token;
  const cookie = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');

  await sleep(1000);

  // Step 2: listOfCases → case_number + case token
  const h1 = { 'User-Agent': UA, 'Accept-Charset': 'UTF-8', 'Authorization': 'Bearer ' + enc(appToken), 'Cookie': cookie };
  const r1 = await get(
    `/ecourt_mobile_DC/listOfCasesWebService.php?params=${encodeURIComponent(enc({ cino: cnr, language_flag: '0', bilingual_flag: '0', state_code: stateCode, dist_code: distCode }))}`,
    h1
  );
  const d1 = JSON.parse(dec(r1.body));
  const caseNo = d1.case_number;
  const caseToken = d1.token;

  if (!caseNo) throw new Error('case_number not found — CNR may be invalid');
//  if (!caseToken) throw new Error('case token missing — case may not be registered in My Cases');

  await sleep(1000);

  // Step 3: caseHistory
  const h2 = { 'User-Agent': UA, 'Accept-Charset': 'UTF-8', 'Authorization': 'Bearer ' + enc(caseToken || appToken), 'Cookie': cookie };
  const r2 = await get(
    `/ecourt_mobile_DC/caseHistoryWebService.php?params=${encodeURIComponent(enc({ case_number: caseNo, cino: cnr, state_code: stateCode, dist_code: distCode, court_code: '3', language_flag: '0', bilingual_flag: '0' }))}`,
    h2
  );



  const d2 = dec(r2.body);
  console.log('r2.status:', r2.status);
  console.log('r2.body raw:', r2.body?.substring(0, 100));
  console.log('d2 decoded:', d2?.substring(0, 200));


//  if (!json.history) throw new Error('No history in response');
//
  const h = json.history;
  return {
    cnr: h.cino,
    caseType: h.type_name,
    filingDate: h.date_of_filing,
    registrationDate: h.dt_regis,
    nextDate: h.date_next_list,
    lastDate: h.date_last_list,
    status: h.disp_nature === 0 ? 'Pending' : 'Disposed',
    court: h.court_name,
    judge: h.desgname,
    petitioner: h.pet_name,
    petitionerAdvocate: h.pet_adv,
    respondent: h.res_name,
    respondentAdvocate: h.res_adv,
    nextPurpose: h.purpose_name?.trim() || '',
    act: h.under_act1 || '',
    stateCode: h.state_code,
    districtCode: h.district_code,
    districtName: h.district_name,
    stateName: h.state_name,
    complexCode: h.complex_code,
    courtCode: h.court_code,
    // Raw HTML fields (Flutter side parse ਕਰੇਗਾ)
    hearingHistory: h.historyOfCaseHearing || '',
    orders: h.interimOrder || '',
    processes: h.processes || '',
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const cnr = (req.query.cnr || '').trim().toUpperCase();
  if (!cnr || cnr.length < 10) {
    return res.status(400).json({ error: 'cnr query param required (e.g. ?cnr=HRSI020002542021)' });
  }

  try {
    const data = await cnrLookup(cnr);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('CNR error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};