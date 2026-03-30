const axios   = require('axios');
const cheerio = require('cheerio');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { cnr, captchaCode, cookieStr, sessionId } = req.body || {};

  if (!cnr || !captchaCode) {
    return res.status(400).json({ success: false, error: 'cnr and captchaCode required' });
  }

  // Use cookieStr from captcha response directly
  const cookie = cookieStr || (sessionId ? `SERVICES_SESSID=${sessionId}` : '');
  console.log('Using cookie:', cookie);
  console.log('CNR:', cnr, 'CAPTCHA:', captchaCode);

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
          'Cookie':           cookie,
        },
        timeout: 15000,
      }
    );

    const raw = resp.data;
    const html = raw.casetype_list || raw.case_details_html ||
                 (typeof raw === 'string' ? raw : JSON.stringify(raw));

    console.log('Status:', resp.status);
    console.log('Response length:', html.length);
    console.log('Response preview:', html.substring(0, 300));

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

  // Court name — h2 tag
  result.courtName = $('h2').first().text().trim() || '';

  // Case type
  result.caseType = findAfterTh($, 'Case Type') || '';

  // Filing info
  result.filingNumber = findAfterTh($, 'Filing Number') || '';
  result.filingDate   = findAfterTh($, 'Filing Date')   || '';
  result.regNumber    = findAfterTh($, 'Registration Number') || '';
  result.regDate      = findAfterTh($, 'Registration Date')   || '';
  result.cnrNumber    = findAfterTh($, 'CNR Number') || cnr.toUpperCase();

  // Case status
  result.firstDate  = findAfterTh($, 'First Hearing Date') || '';
  result.nextDate   = findAfterTh($, 'Next Hearing Date')  || '';
  result.caseStage  = findAfterTh($, 'Case Stage') || findAfterTh($, 'Stage') || '';
  result.courtNo    = findAfterTh($, 'Court Number') || findAfterTh($, 'Court No') || '';
  result.judgeName  = findAfterTh($, 'Judge') || findAfterTh($, 'Coram') || '';

  // Petitioner / Respondent — look in tables
  $('table').each((_, tbl) => {
    const tblHtml = $(tbl).html() || '';
    if (tblHtml.toLowerCase().includes('petitioner')) {
      $(tbl).find('tr').each((_, row) => {
        const th = $(row).find('th').text().trim().toLowerCase();
        const td = $(row).find('td').first().text().trim();
        if (th.includes('petitioner') && td) result.petitioner = td;
        if (th.includes('respondent') && td) result.respondent = td;
        if (th.includes('advocate') && th.includes('petitioner') && td) result.petAdvocate = td;
        if (th.includes('advocate') && th.includes('respondent') && td) result.respAdvocate = td;
      });
    }
  });

  // Party name = petitioner vs respondent
  if (result.petitioner && result.respondent) {
    result.partyName = `${result.petitioner} vs ${result.respondent}`;
  } else {
    result.partyName = $('h3').first().text().trim() || '';
  }

  // Hearing history
  const history = [];
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const date    = $(cells[0]).text().trim();
      const purpose = $(cells[1]).text().trim();
      if (date.match(/\d{2}-\d{2}-\d{4}/) && purpose && purpose.length < 100) {
        history.push(`${date} — ${purpose}`);
      }
    }
  });
  result.hearingHistory = history;

  console.log('Parsed courtName:', result.courtName);
  console.log('Parsed nextDate:', result.nextDate);
  console.log('Parsed petitioner:', result.petitioner);
  console.log('Parsed respondent:', result.respondent);
  console.log('Parsed historyCount:', result.hearingHistory?.length);
  console.log('Parsed history[0]:', result.hearingHistory?.[0]);
  console.log('Full result:', JSON.stringify(result));
  return result;
}

function findAfterTh($, label) {
  let val = '';
  $('th').each((_, el) => {
    if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
      // Try next td sibling
      val = $(el).next('td').text().trim();
      if (!val) {
        // Try parent row's td
        val = $(el).closest('tr').find('td').first().text().trim();
      }
      if (val) return false;
    }
  });
  return val;
}