const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Cookie jar — same session for both requests ──
    const jar    = new CookieJar();
    const client = wrapper(axios.create({ jar }));

    // Step 1: Load CNR status page — sets SERVICES_SESSID cookie
    await client.get(`${BASE}/?p=casestatus/index&app_token=`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${BASE}/`,
      },
      timeout: 12000,
    });

    // Step 2: getCaptcha — same session
    const captchaResp = await client.post(
      `${BASE}/?p=casestatus/getCaptcha`,
      'ajax_req=true&app_token=',
      {
        headers: {
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          `${BASE}/`,
          'Origin':            BASE,
        },
        timeout: 12000,
      }
    );

    const html = typeof captchaResp.data === 'string'
      ? captchaResp.data : JSON.stringify(captchaResp.data);

    // Extract captcha token
    const tokenMatch = html.match(/securimage_show\.php\?([a-f0-9]+)/);
    const captchaToken = tokenMatch ? tokenMatch[1] : '';
    console.log('Captcha token:', captchaToken);

    // Step 3: Fetch captcha image — same session
    const imgUrl = captchaToken
      ? `${BASE}/vendor/securimage/securimage_show.php?${captchaToken}`
      : `${BASE}/vendor/securimage/securimage_show.php`;

    const imgResp = await client.get(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `${BASE}/?p=casestatus/index`,
      },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    // Get all cookies from jar
    const cookies = await jar.getCookies(BASE);
    const cookieStr = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    console.log('Session cookies:', cookieStr.substring(0, 80));

    const contentType   = imgResp.headers['content-type'] || 'image/png';
    const captchaBase64 = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;

    return res.status(200).json({
      success: true,
      captchaBase64,
      cookieStr,
      captchaToken,
    });

  } catch (err) {
    console.error('Captcha error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};