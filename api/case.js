const axios   = require('axios');
const cheerio = require('cheerio');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { cnr, captchaCode, cookieStr } = req.body || {};

  if (!cnr || !captchaCode) {
    return res.status(400).json({ success: false, error: 'cnr and captchaCode required' });
  }

  try {
    const params = new URLSearchParams({
      'cino':          cnr.trim().toUpperCase(),
      'fcaptcha_code': captchaCode.trim(),
      'ajax_req':      'true',
      'app_token':     '',
    });

    const resp = await axios.post(
      `${ECOURTS_BASE}/?p=cnr_status/searchByCNR/`,
      params.toString(),
      {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With':'XMLHttpRequest',
          'Referer':         `${ECOURTS_BASE}/`,
          'Origin':           ECOURTS_BASE,
          'Cookie':           cookieStr || '',
        },
        timeout: 15000,
      }
    );

    const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

    // Check for CAPTCHA error
    if (html.toLowerCase().includes('invalid captcha') ||
        html.toLowerCase().includes('wrong captcha') ||
        html.toLowerCase().includes('captcha') && html.length < 500) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }

    // Check for not found
    if (html.toLowerCase().includes('no record') || html.toLowerCase().includes('not found')) {
      return res.status(200).json({ success: false, error: 'Case nahi mila. CNR check karo.' });
    }

    const parsed = parseHTML(html, cnr);
    return res.status(200).json({ success: true, case: parsed });

  } catch (err) {
    console.error('Case fetch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function parseHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr.toUpperCase() };

  // Party name / case title
  result.partyName =
    $('h4').first().text().trim() ||
    $('.case_title').text().trim() ||
    findAfterLabel($, 'Case Title') || '';

  // Court name
  result.courtName =
    $('h3').first().text().trim() ||
    $('.court_name').text().trim() || '';

  // Next hearing date
  result.nextDate =
    findAfterLabel($, 'Next Date') ||
    findAfterLabel($, 'Next Hearing') ||
    $('td:contains("Next")').next().text().trim() || '';

  // First hearing date
  result.firstDate = findAfterLabel($, 'First Hearing') || '';

  // Case stage
  result.caseStage = findAfterLabel($, 'Case Stage') ||
                     findAfterLabel($, 'Stage') || '';

  // Filing info
  result.filingNumber = findAfterLabel($, 'Filing Number') || '';
  result.filingDate   = findAfterLabel($, 'Filing Date') || '';
  result.regNumber    = findAfterLabel($, 'Registration Number') || '';
  result.regDate      = findAfterLabel($, 'Registration Date') || '';
  result.caseType     = findAfterLabel($, 'Case Type') || '';

  // Petitioner / Respondent
  result.petitioner   = $('[class*="petitioner"]').first().text().trim() ||
                        findAfterLabel($, 'Petitioner') || '';
  result.respondent   = $('[class*="respondent"]').first().text().trim() ||
                        findAfterLabel($, 'Respondent') || '';

  // Hearing history
  const history = [];
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const date    = $(cells[0]).text().trim();
      const purpose = $(cells[1]).text().trim();
      if (date.match(/\d{2}-\d{2}-\d{4}|\d{2}(st|nd|rd|th)\s+\w+\s+\d{4}/i) && purpose) {
        history.push(`${date} — ${purpose}`);
      }
    }
  });
  result.hearingHistory = history;

  return result;
}

function findAfterLabel($, label) {
  let val = '';
  $('td').each((_, el) => {
    if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
      val = $(el).next('td').text().trim();
      if (val) return false;
    }
  });
  return val;
}