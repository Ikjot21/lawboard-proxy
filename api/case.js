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

  const cookie = cookieStr || (sessionId ? `SERVICES_SESSID=${sessionId}` : '');

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
          'Cookie':            cookie,
        },
        timeout: 15000,
      }
    );

    const raw = resp.data;
    // eCourts returns JSON with casetype_list field containing HTML
    const html = raw.casetype_list || raw.case_details_html ||
                 (typeof raw === 'string' ? raw : JSON.stringify(raw));

    console.log('Response type:', typeof raw);
    console.log('HTML length:', html.length);
    console.log('HTML preview:', html.substring(0, 200));

    if (html.toLowerCase().includes('invalid captcha') || html.toLowerCase().includes('wrong captcha')) {
      return res.status(200).json({ success: false, error: 'CAPTCHA galat hai — dobara try karo' });
    }
    if (html.toLowerCase().includes('no record') || html.toLowerCase().includes('not found')) {
      return res.status(200).json({ success: false, error: 'Case nahi mila. CNR check karo.' });
    }

    // Now fetch FULL case page — casetype_list only has partial data
    // We need to also fetch case history separately
    const fullData = parseHTML(html, cnr, raw);

    // If history empty, try fetching from raw.history_case_hearing
    if (fullData.hearingHistory.length === 0 && raw.history_case_hearing) {
      console.log('Using raw.history_case_hearing');
      const histHtml = raw.history_case_hearing;
      const $h = cheerio.load(histHtml);
      const history = [];
      $h('tr').each((_, row) => {
        const cells = $h(row).find('td');
        if (cells.length >= 3) {
          const date    = $h(cells[2]).text().trim();
          const purpose = $h(cells[3] || cells[2]).text().trim();
          if (date.match(/\d{2}-\d{2}-\d{4}/)) {
            history.push(`${date} — ${purpose}`);
          }
        }
      });
      fullData.hearingHistory = history;
    }

    // Petitioner from raw
    if (!fullData.petitioner && raw.petitioner_advocate_html) {
      const $p = cheerio.load(raw.petitioner_advocate_html);
      fullData.petitioner = $p('td').first().text().trim();
    }
    if (!fullData.respondent && raw.respondent_advocate_html) {
      const $r = cheerio.load(raw.respondent_advocate_html);
      fullData.respondent = $r('td').first().text().trim();
    }

    console.log('Final petitioner:', fullData.petitioner);
    console.log('Final respondent:', fullData.respondent);
    console.log('Final historyCount:', fullData.hearingHistory.length);
    console.log('Raw keys:', Object.keys(raw));

    return res.status(200).json({ success: true, case: fullData });

  } catch (err) {
    console.error('Case fetch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function parseHTML(html, cnr, raw) {
  const $ = cheerio.load(html);
  const result = { cnr: cnr.toUpperCase() };

  // Court name — h2
  result.courtName = $('h2').first().text().trim() || '';

  // Parse all th→td pairs
  result.caseType     = findAfterTh($, 'Case Type')            || '';
  result.filingNumber = findAfterTh($, 'Filing Number')        || '';
  result.filingDate   = findAfterTh($, 'Filing Date')          || '';
  result.regNumber    = findAfterTh($, 'Registration Number')  || '';
  result.regDate      = findAfterTh($, 'Registration Date')    || '';
  result.cnrNumber    = findAfterTh($, 'CNR Number')           || cnr.toUpperCase();
  result.firstDate    = findAfterTh($, 'First Hearing Date')   || '';
  result.nextDate     = findAfterTh($, 'Next Hearing Date') || findAfterTh($, 'Decision Date') || '';
  result.caseStage    = findAfterTh($, 'Case Stage') || findAfterTh($, 'Nature of Disposal') || '';
  result.courtNo      = findAfterTh($, 'Court Number') || findAfterTh($, 'Court Number and Judge') || '';
  result.judgeName    = result.courtNo; // eCourts combines these

  // Petitioner / Respondent — parse properly from body text
  const bodyText = $('body').text();

  const petSection = bodyText.match(/Petitioner and Advocate([\s\S]*?)(?=Respondent and Advocate|Acts\s|Processes\s|FIR Details|$)/i);
  if (petSection) {
    const txt = petSection[1];
    const nameMatch = txt.match(/1\)\s*([^\n]+)/);
    const advMatch  = txt.match(/Advocate[-–:]\s*([^\n]+)/i);
    if (nameMatch) result.petitioner  = nameMatch[1].replace(/\s*Advocate[-–:][\s\S]*/i,'').trim();
    if (advMatch)  result.petAdvocate = advMatch[1].trim();
  }

  const respSection = bodyText.match(/Respondent and Advocate([\s\S]*?)(?=Acts\s|Processes\s|FIR Details|Case History|Interim Orders|$)/i);
  if (respSection) {
    const txt = respSection[1];
    // Get all respondent names (1) Name, 2) Name etc)
    const allNames = [];
    const nameRegex = /\d+\)\s*([^\n]+)/g;
    let m;
    while ((m = nameRegex.exec(txt)) !== null) {
      const name = m[1].replace(/\s*Advocate[-–:][\s\S]*/i,'').trim();
      if (name) allNames.push(name);
    }
    result.respondent = allNames.join(', ') || '';
    // Advocate
    const advMatch = txt.match(/Advocate[-–:]\s*([^\n]+)/i);
    if (advMatch) result.respAdvocate = advMatch[1].trim();
  }

  // Party name
  if (result.petitioner && result.respondent) {
    result.partyName = `${result.petitioner} vs ${result.respondent}`;
  } else {
    result.partyName = '';
  }

  // Hearing history — Case History table
  // eCourts table: Judge | Business on Date | Hearing Date | Purpose
  const history = [];
  $('table').each((_, tbl) => {
    const tblText = $(tbl).text().toLowerCase();
    if (tblText.includes('hearing date') || tblText.includes('business on date') || tblText.includes('purpose')) {
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 3) {
          // Try col index 2 = Hearing Date, col 3 = Purpose
          const hearingDate = $(cells[2]).text().trim();
          const purpose     = $(cells[3] || cells[1]).text().trim();
          if (hearingDate.match(/\d{2}-\d{2}-\d{4}/) && purpose) {
            history.push(`${hearingDate} — ${purpose}`);
          }
        }
      });
    }
  });

  // Fallback: any row with date pattern
  if (history.length === 0) {
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const col0 = $(cells[0]).text().trim();
        const col1 = $(cells[1]).text().trim();
        const col2 = cells.length > 2 ? $(cells[2]).text().trim() : '';
        // Check if any cell has date
        const dateCell = [col0, col1, col2].find(c => c.match(/\d{2}-\d{2}-\d{4}/));
        const purposeCell = [col0, col1, col2].find(c => c && !c.match(/\d{2}-\d{2}-\d{4}/) && c.length < 60);
        if (dateCell && purposeCell && dateCell !== purposeCell) {
          history.push(`${dateCell} — ${purposeCell}`);
        }
      }
    });
  }

  result.hearingHistory = [...new Set(history)]; // deduplicate

  // ── Interim Orders ──
  const orders = [];
  let orderTableFound = false;
  $('table').each((_, tbl) => {
    const tblText = $(tbl).text().toLowerCase();
    if (tblText.includes('order number') || tblText.includes('order date') ||
        tblText.includes('interim order') || tblText.includes('copy of order')) {
      orderTableFound = true;
      $(tbl).find('tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const num  = $(cells[0]).text().trim();
          const date = $(cells[1]).text().trim();
          if (num.match(/^\d+$/) && date.match(/\d{2}-\d{2}-\d{4}/)) {
            orders.push(`Order ${num} — ${date}`);
          }
        }
      });
    }
  });
  console.log('Order table found:', orderTableFound, 'Orders count:', orders.length);
  // Also check body text for orders
  const orderMatches = bodyText.match(/(\d+)\s+(\d{2}-\d{2}-\d{4})\s+Copy of order/gi) || [];
  console.log('Order matches in text:', orderMatches.length);
  if (orders.length === 0 && orderMatches.length > 0) {
    orderMatches.forEach(m => {
      const parts = m.match(/(\d+)\s+(\d{2}-\d{2}-\d{4})/);
      if (parts) orders.push(`Order ${parts[1]} — ${parts[2]}`);
    });
  }
  result.orders = orders;

  return result;
}

function findAfterTh($, label) {
  let val = '';
  $('th').each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text.includes(label.toLowerCase())) {
      // Try next sibling td
      val = $(el).next('td').text().trim();
      // Try parent row's td
      if (!val) val = $(el).closest('tr').find('td').first().text().trim();
      if (val) return false;
    }
  });
  return val;
}