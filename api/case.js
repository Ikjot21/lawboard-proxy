const axios   = require('axios');
const cheerio = require('cheerio');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { cnr, captchaCode, cookieStr, action, normal_v, case_val, court_code, filename, appFlag } = req.body || {};

  // ── display_pdf: proxy PDF download using saved cookieStr ────────────────
  if (action === 'display_pdf') {
    if (!normal_v || !case_val) {
      return res.status(400).json({ success: false, error: 'normal_v and case_val required' });
    }
    try {
      console.log('[case.js display_pdf] normal_v:', normal_v, '| filename:', filename?.substring(0,30));
      const pdfParams = new URLSearchParams({
        normal_v:   normal_v   || '',
        case_val:   case_val   || '',
        court_code: court_code || '',
        filename:   filename   || '',
        appFlag:    appFlag    || '',
        ajax_req:   'true',
        app_token:  '',
      });
      const pdfResp = await axios.post(
        `${ECOURTS_BASE}/?p=home/display_pdf`,
        pdfParams.toString(),
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
      const pdfRaw = pdfResp.data;
      console.log('[case.js display_pdf] status:', pdfResp.status);
      console.log('[case.js display_pdf] raw:', JSON.stringify(pdfRaw).substring(0, 300));
      const orderPath = typeof pdfRaw === 'object' ? pdfRaw.order : null;
      if (!orderPath) {
        console.log('[case.js display_pdf] NO ORDER PATH — full raw:', JSON.stringify(pdfRaw));
        return res.status(200).json({ success: false, error: `PDF path not found: ${JSON.stringify(pdfRaw).substring(0,100)}` });
      }
      const fileUrl = `${ECOURTS_BASE}/${orderPath.replace(/^\//, '')}`;
      const fileResp = await axios.get(fileUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Cookie': cookieStr || '',
        },
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const pdfBase64 = Buffer.from(fileResp.data).toString('base64');
      return res.status(200).json({ success: true, pdfBase64, pdfUrl: fileUrl });
    } catch (err) {
      console.error('[case.js display_pdf] error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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

    return res.status(200).json({ success: true, case: result, cookieStr: cookieStr || '' });

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
    const advM  = txt.match(/Advocate[-–:]\s*([A-Z][A-Z\s]+)/i);
    if (nameM) result.petitioner  = nameM[1].replace(/\s*Advocate[-–:][\s\S]*/i, '').trim();
    if (advM)  result.petAdvocate = advM[1].trim();
  }

  // Respondent — handle multiple
  const respBlock = bodyText.match(/Respondent and Advocate([\s\S]{0,600})(?=\s*Acts\b|\s*Processes\b|\s*FIR Details|\s*Case History|\s*Under Act)/i);
  if (respBlock) {
    const txt = respBlock[1];
    const names = [];
    // Split by numbered entries: "1) NAME\n   Advocate-..."  "2) NAME..."
    const entries = txt.split(/(?=\d+\))/);
    entries.forEach(entry => {
      const nameM = entry.match(/^\d+\)\s*([^\n]+)/);
      if (!nameM) return;
      let name = nameM[1]
        .replace(/\s*Advocate[-–\s]*[-:].*/i, '')   // cut at Advocate
        .replace(/\s*Acts\b.*/i, '')                  // cut at Acts
        .replace(/\s*Under Act.*/i, '')               // cut at Under Act
        .replace(/\s*Processes\b.*/i, '')             // cut at Processes
        .replace(/[,\s]*\d{3}[A-Z]*\w*Protection.*/,'') // cut at section+Protection
        .replace(/[,\s]*\d{3}[A-Z]*[\d()]+.*/g, '') // cut at IPC section numbers
        .trim();
      if (name && name.length > 1 && name.length < 70 && /[A-Z]/.test(name)) {
        names.push(name);
      }
    });
    result.respondent = names.join(', ');
    const advM = txt.match(/Advocate[-–:]\s*([A-Z][A-Z\s]+)/i);
    if (advM) {
      result.respAdvocate = advM[1]
        .replace(/\s*Acts.*/i, '')
        .replace(/\s*Under.*/i, '')
        .trim();
    }
  }

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

  // ── Interim Orders — with displayPdf onclick params ──
  const parseOrderTable = (tbl) => {
    const rows = [];
    $(tbl).find('tr').each((_, row) => {
      const cells  = $(row).find('td');
      if (cells.length < 2) return;
      const num    = $(cells[0]).text().trim().replace(/&nbsp;/g, '').trim();
      const date   = $(cells[1]).text().trim().replace(/&nbsp;/g, '').trim();
      const details = cells.length >= 3 ? $(cells[2]).text().trim() : '';
      const onClick = $(row).find('a').attr('onclick') || '';
      const m = onClick.match(/displayPdf\('([^']+)','([^']+)','([^']+)','([^']+)','([^']*)'\)/);
      if (num.match(/^\d+$/) && date.match(/\d{2}-\d{2}-\d{4}/)) {
        rows.push({
          orderNo: num, num, date, details,
          ...(m ? { normal_v: m[1], case_val: m[2], court_code: m[3], filename: m[4], appFlag: m[5] } : {}),
        });
      }
    });
    return rows;
  };

  const orderTables = [];
  $('table').each((_, tbl) => {
    const txt = $(tbl).text().toLowerCase();
    if (txt.includes('order number') || txt.includes('copy of order') || txt.includes('copy of final order')) {
      orderTables.push(tbl);
    }
  });

  let interimOrders = [], finalOrders = [];
  if (orderTables.length === 1) {
    const txt = $(orderTables[0]).text().toLowerCase();
    if (txt.includes('final')) finalOrders   = parseOrderTable(orderTables[0]);
    else                       interimOrders = parseOrderTable(orderTables[0]);
  } else if (orderTables.length >= 2) {
    interimOrders = parseOrderTable(orderTables[0]);
    finalOrders   = parseOrderTable(orderTables[orderTables.length - 1]);
  }

  result.interimOrders = interimOrders;
  result.finalOrders   = finalOrders;
  result.orders        = [...interimOrders, ...finalOrders];
  console.log('[case.js] orders:', result.orders.length, '| has normal_v:', !!result.orders[0]?.normal_v);

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