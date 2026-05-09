// api/mobile_cnr.js

// DISABLED — do not use official mobile app encrypted endpoint.

module.exports = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'Mobile endpoint disabled. Use official web CAPTCHA flow only.',
  });
};