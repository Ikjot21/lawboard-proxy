// api/case.js
// POST /api/case
// Body: { cnr, captchaCode, sessionId, cookieStr }
// Returns: { success, case: { partyName, court, nextDate, judge, history, ... } }

const axios   = require('axios');
const cheerio = require('cheerio');

const ECOURTS_BASE   = 'https://services.ecourts.gov.in/ecourtindia_v6';
const SUBMIT_URL     = `${ECOURTS_BASE}/?p=cnr_search/getCaseDetails`;
const AJAX_URL       = `${ECOURTS_BASE}/?p=cnr_search/searchByCNR`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': `${ECOURTS_BASE}/?p=cnr_search/searchByCNR`,
  'Origin': ECOURTS_BASE,
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { cnr, captchaCode, sessionId, cookieStr } = req.body || {};

  if (!cnr || !captchaCode) {
    return res.status(400).json({ success: false, error: 'cnr and captchaCode required' });
  }

  const cookie = cookieStr || `PHPSESSID=${sessionId}`;

  try {
    // Submit CNR + CAPTCHA to eCourts
    const params = new URLSearchParams({
      'cino':         cnr.trim().toUpperCase(),
      'captcha_code': captchaCode.trim(),
      'ajax_req':     'true',
      'court_code':   '0',
    });

    const resp = await axios.post(SUBMIT_URL, params.toString(), {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': cookie,
      },
      timeout: 12000,
      maxRedirects: 3,
    });

    const raw = resp.data;

    // eCourts returns HTML fragment or JSON
    let htmlContent = '';
    if (typeof raw === 'string') {
      htmlContent = raw;
    } else if (raw && raw.html) {
      htmlContent = raw.html;
    } else if (raw && raw.case_details_html) {
      htmlContent = raw.case_details_html;
    } else {
      htmlContent = JSON.stringify(raw);
    }

    // Parse HTML with cheerio
    const parsed = parseECourtsHTML(htmlContent, cnr);

    if (!parsed.nextDate && !parsed.partyName) {
      // Try alternate endpoint
      const resp2 = await axios.post(AJAX_URL, params.toString(), {
        headers: { ...BROWSER_HEADERS, 'Cookie': cookie },
        timeout: 10000,
      });
      const parsed2 = parseECourtsHTML(
        typeof resp2.data === 'string' ? resp2.data : JSON.stringify(resp2.data),
        cnr
      );
      if (parsed2.partyName || parsed2.nextDate) {
        return res.status(200).json({ success: true, case: parsed2, raw: null });
      }

      return res.status(200).json({
        success: false,
        error: 'CAPTCHA wrong, or case not found. Try again.',
        rawPreview: htmlContent.substring(0, 300),
      });
    }

    return res.status(200).json({ success: true, case: parsed });

  } catch (err) {
    console.error('Case fetch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Parse eCourts HTML response ───────────────────────────
function parseECourtsHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr.toUpperCase() };

  // ── Party / Case Title ──
  result.partyName =
    $('.case_title').text().trim() ||
    $('[class*="case_title"]').text().trim() ||
    $('h4').first().text().trim() ||
    extractAfterLabel($, 'Case Title') || '';

  // ── Next Hearing Date ──
  result.nextDate =
    $('.Next_date_CSS').text().trim() ||
    $('[class*="next_date"]').text().trim() ||
    extractAfterLabel($, 'Next Date') ||
    extractAfterLabel($, 'Next Hearing') || '';

  // ── Court Name ──
  result.courtName =
    $('.court_name').text().trim() ||
    $('[class*="court_name"]').text().trim() ||
    extractAfterLabel($, 'Court Name') || '';

  // ── Judge ──
  result.judgeName =
    $('.judge_name').text().trim() ||
    $('[class*="judge"]').first().text().trim() ||
    extractAfterLabel($, 'Judge') || '';

  // ── Case Stage ──
  result.caseStage =
    extractAfterLabel($, 'Stage') ||
    extractAfterLabel($, 'Business') || '';

  // ── Filing / Registration ──
  result.filingNumber   = extractAfterLabel($, 'Filing Number') || '';
  result.filingDate     = extractAfterLabel($, 'Filing Date') || '';
  result.registrationNo = extractAfterLabel($, 'Registration Number') || '';

  // ── Petitioner / Respondent ──
  result.petitioner = $('[class*="petitioner"]').first().text().trim() ||
                      extractAfterLabel($, 'Petitioner') || '';
  result.respondent = $('[class*="respondent"]').first().text().trim() ||
                      extractAfterLabel($, 'Respondent') || '';

  // ── Advocate ──
  result.petAdvocate  = extractAfterLabel($, 'Petitioner Advocate') || '';
  result.respAdvocate = extractAfterLabel($, 'Respondent Advocate') || '';

  // ── Hearing History ──
  const history = [];
  // Try table rows with dates
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const dateText = $(cells[0]).text().trim();
      const purpose  = $(cells[1]).text().trim();
      if (dateText.match(/\d{2}-\d{2}-\d{4}/) && purpose) {
        history.push(`${dateText} — ${purpose}`);
      }
    }
  });
  result.hearingHistory = history;

  // ── Error detection ──
  const bodyText = $('body').text().toLowerCase();
  if (bodyText.includes('invalid captcha') || bodyText.includes('wrong captcha')) {
    result.captchaError = true;
  }
  if (bodyText.includes('no record') || bodyText.includes('not found')) {
    result.notFound = true;
  }

  return result;
}

// Helper: find value after a label in table
function extractAfterLabel($, label) {
  let val = '';
  $('td, th, span, div, label').each((_, el) => {
    const text = $(el).text().trim();
    if (text.toLowerCase().includes(label.toLowerCase())) {
      const next = $(el).next();
      if (next.length) val = next.text().trim();
      if (!val) {
        const parent = $(el).parent();
        const siblings = parent.find('td, span, div').not(el);
        if (siblings.length) val = siblings.first().text().trim();
      }
    }
  });
  return val;
}