// api/mobile_cnr.js
// DISABLED — do not use official mobile app encrypted endpoint.

module.exports = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'This endpoint is disabled. Use CAPTCHA-based official web flow only.',
  });
};