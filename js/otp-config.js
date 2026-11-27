// OTP over WhatsApp. Points the registration screen at the server endpoint in /api/ (see api/index.php).
// On localhost the endpoint is ignored and the page falls back to Firebase / test mode, so a plain
// static server still works for design review. Set to null to switch WhatsApp OTP off everywhere.
window.KK_OTP_API = 'api/';

// THE OTP SWITCH. This one line turns code verification on or off for every kiosk:
//   true  = no code: registration goes straight to the game (anyone can register with any number)
//   false = a code is sent and must be entered
// OFF since 27 Nov by the client's decision: no code is needed to register. The WhatsApp + SMS code service is still
// in place on the server; to bring it back set false, then bump the ?v= on this file in register.html.
window.KK_OTP_SKIP = true;
