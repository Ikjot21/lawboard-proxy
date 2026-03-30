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
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          `${ECOURTS_BASE}/`,
          'Origin':            ECOURTS_BASE,
          'Cookie':            cookieStr || '',
        },
        timeout: 15000,
      }
    );

    const raw  = resp.data;
    const html = raw.casetype_list || (typeof raw === 'string' ? raw : '');

    if (!html || html.toLowerCase().includes('invalid captcha')) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }
    if (html.toLowerCase().includes('no record') || html.toLowerCase().includes('not found')) {
      return res.status(200).json({ success: false, error: 'Case nahi mila. CNR check karo.' });
    }

    const result = parseHTML(html, cnr);
    console.log('petitioner:', result.petitioner);
    console.log('respondent:', result.respondent);
    console.log('history:', result.hearingHistory.length);
    console.log('orders:', result.orders.length);

    return res.status(200).json({ success: true, case: result });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function parseHTML(html, cnr) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr.toUpperCase() };

  // ── Court name ──
  result.courtName = $('h2').first().text().trim() || '';

  // ── th→td pairs ──
  const findTh = (label) => {
    let val = '';
    $('th').each((_, el) => {
      if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
        val = $(el).next('td').text().trim();
        if (!val) val = $(el).closest('tr').find('td').first().text().trim();
        if (val) return false;
      }
    });
    return val;
  };

  result.caseType     = findTh('Case Type')            || '';
  result.filingNumber = findTh('Filing Number')        || '';
  result.filingDate   = findTh('Filing Date')          || '';
  result.regNumber    = findTh('Registration Number')  || '';
  result.regDate      = findTh('Registration Date')    || '';
  result.cnrNumber    = findTh('CNR Number')           || cnr.toUpperCase();
  result.firstDate    = findTh('First Hearing Date')   || '';
  result.nextDate     = findTh('Next Hearing Date') || findTh('Decision Date') || '';
  result.caseStage    = findTh('Case Stage') || findTh('Nature of Disposal') || '';
  result.courtNo      = findTh('Court Number') || findTh('Court Number and Judge') || '';
  result.judgeName    = result.courtNo;

  // ── Petitioner / Respondent from body text ──
  const bodyText = $.text();

  // Petitioner
  const petBlock = bodyText.match(/Petitioner and Advocate([\s\S]*?)(?=Respondent and Advocate)/i);
  if (petBlock) {
    const txt = petBlock[1];
    const nameM = txt.match(/1\)\s*([^\n]+)/);
    const advM  = txt.match(/Advocate[-–:]\s*([^\n\d]+)/i);
    if (nameM) result.petitioner  = nameM[1].replace(/\s*Advocate[-–:][\s\S]*/i, '').trim();
    if (advM)  result.petAdvocate = advM[1].trim();
  }

  // Respondent — multiple respondents support
  const respBlock = bodyText.match(/Respondent and Advocate([\s\S]*?)(?=\n\s*Acts\b|\n\s*Processes\b|\n\s*FIR Details|\n\s*Case History)/i);
  if (respBlock) {
    const txt = respBlock[1];
    const names = [];
    const regex = /\d+\)\s*([^\n]+)/g;
    let m;
    while ((m = regex.exec(txt)) !== null) {
      const name = m[1].replace(/\s*Advocate[-–\s]*[-:][^\n]*/i, '').trim();
      if (name && name.length > 0 && name.length < 80) names.push(name);
    }
    result.respondent = names.join(', ');
    const advM = txt.match(/Advocate[-–:]\s*([A-Z][^\n\d]+)/i);
    if (advM) result.respAdvocate = advM[1].trim();
  }

  // Party name
  result.partyName = (result.petitioner && result.respondent)
    ? `${result.petitioner} vs ${result.respondent}` : '';

  // ── Case History ──
  // Table: Judge | Business on Date | Hearing Date | Purpose
  const history = [];
  $('table').each((_, tbl) => {
    const tblTxt = $(tbl).text().toLowerCase();
    if (tblTxt.includes('hearing date') && tblTxt.includes('purpose')) {
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 4) {
          const hearingDate = $(cells[2]).text().trim();
          const purpose     = $(cells[3]).text().trim();
          if (hearingDate.match(/\d{2}-\d{2}-\d{4}/) && purpose) {
            history.push(`${hearingDate} — ${purpose}`);
          }
        } else if (cells.length >= 3) {
          const hearingDate = $(cells[1]).text().trim();
          const purpose     = $(cells[2]).text().trim();
          if (hearingDate.match(/\d{2}-\d{2}-\d{4}/) && purpose) {
            history.push(`${hearingDate} — ${purpose}`);
          }
        }
      });
    }
  });
  result.hearingHistory = [...new Set(history)];

  // ── Interim Orders ──
  const orders = [];
  $('table').each((_, tbl) => {
    const tblTxt = $(tbl).text().toLowerCase();
    if (tblTxt.includes('order number') || tblTxt.includes('copy of order')) {
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const num  = $(cells[0]).text().trim();
          const date = $(cells[1]).text().trim();
          if (num.match(/^\d+$/) && date.match(/\d{2}-\d{2}-\d{4}/)) {
            orders.push({ num, date });
          }
        }
      });
    }
  });
  result.orders = orders;

  // ── Acts ──
  const acts = [];
  $('table').each((_, tbl) => {
    const tblTxt = $(tbl).text().toLowerCase();
    if (tblTxt.includes('under act') || tblTxt.includes('section')) {
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const act     = $(cells[0]).text().trim();
          const section = $(cells[1]).text().trim();
          if (act && section && !act.toLowerCase().includes('under act')) {
            acts.push(`${act} — Sec. ${section}`);
          }
        }
      });
    }
  });
  result.acts = acts;

  return result;
}