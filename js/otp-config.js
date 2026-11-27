// OTP over WhatsApp. Points the registration screen at the server endpoint in /api/ (see api/index.php).
// On localhost the endpoint is ignored and the page falls back to Firebase / test mode, so a plain
// static server still works for design review. Set to null to switch WhatsApp OTP off everywhere.
window.KK_OTP_API = 'api/';

// TESTING ONLY: true skips the verification step completely, so anyone can register with any number
// and no code is sent. Set back to false before the kiosk goes in front of the public.
window.KK_OTP_SKIP = false;
