// api/captcha.js
// GET /api/captcha
// Returns: { captchaBase64, sessionId }

const axios = require('axios');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
const CAPTCHA_URL  = `${ECOURTS_BASE}/vendor/securimage/securimage_show.php`;

// Common browser headers to avoid bot detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': `${ECOURTS_BASE}/?p=cnr_search/searchByCNR`,
  'Connection': 'keep-alive',
};

module.exports = async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Step 1: Hit homepage first to get a valid session cookie
    const homeResp = await axios.get(
      `${ECOURTS_BASE}/?p=cnr_search/searchByCNR`,
      {
        headers: BROWSER_HEADERS,
        timeout: 10000,
        maxRedirects: 5,
      }
    );

    // Extract Set-Cookie header
    const rawCookies = homeResp.headers['set-cookie'] || [];
    const cookieStr = rawCookies
      .map(c => c.split(';')[0])
      .join('; ');

    // Extract PHPSESSID specifically
    const sessMatch = rawCookies
      .join('')
      .match(/PHPSESSID=([^;]+)/);
    const sessionId = sessMatch ? sessMatch[1] : Date.now().toString();

    // Step 2: Fetch CAPTCHA image with same session
    const captchaResp = await axios.get(CAPTCHA_URL, {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': cookieStr || `PHPSESSID=${sessionId}`,
      },
      responseType: 'arraybuffer',
      timeout: 8000,
    });

    // Convert image to base64
    const imageBuffer = Buffer.from(captchaResp.data);
    const contentType = captchaResp.headers['content-type'] || 'image/png';
    const captchaBase64 = `data:${contentType};base64,${imageBuffer.toString('base64')}`;

    return res.status(200).json({
      success: true,
      captchaBase64,
      sessionId,
      cookieStr,
    });

  } catch (err) {
    console.error('Captcha fetch error:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};