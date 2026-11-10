// Redeem page for an emailed account recovery link.
//
// The page is self-contained: the token stays in the address bar and is posted
// back to the same path, and `referrer: no-referrer` keeps it out of any
// outgoing Referer header. Nothing on this page is logged or echoed anywhere.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

var STYLE = '*{margin:0;padding:0;box-sizing:border-box}' +
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#2F2E2B;color:#E8E5DE;display:flex;align-items:center;justify-content:center;min-height:100vh}' +
  '.card{background:#3A3936;border:1px solid #4A4844;border-radius:12px;padding:32px;width:100%;max-width:400px}' +
  'h1{font-size:18px;font-weight:600;margin-bottom:4px}' +
  '.sub{font-size:13px;color:#A49F95;margin-bottom:24px;line-height:1.5}' +
  'label{display:block;font-size:13px;color:#C5C0B6;margin-bottom:6px}' +
  'input{width:100%;padding:10px 12px;background:#2F2E2B;border:1px solid #4A4844;border-radius:8px;color:#E8E5DE;font-size:14px;outline:none;margin-bottom:16px}' +
  'input:focus{border-color:#DA7756}' +
  'button{width:100%;padding:10px;background:#DA7756;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}' +
  'button:disabled{opacity:.5;cursor:not-allowed}' +
  '.error{color:#E06C5B;font-size:13px;margin-bottom:12px;min-height:1px}' +
  '.success{text-align:center;color:#7FB069;font-size:15px;line-height:1.5}' +
  'a{color:#DA7756}' +
  '.hidden{display:none}';

function head(title) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>' + escapeHtml(title) + ' · Clay</title><style>' + STYLE + '</style></head><body><div class="card">';
}

// Shown for a token that is unknown, already used or expired. The wording is
// deliberately the same for all three.
function renderInvalid(message) {
  return head("Account recovery") +
    '<h1>Account recovery</h1>' +
    '<p class="sub">' + escapeHtml(message || "This recovery link is invalid or has expired.") +
    ' Request a new one from the <a href="/">sign-in page</a>.</p>' +
    '</div></body></html>';
}

function render(options) {
  var passwordMode = !!(options && options.password);
  var fields = passwordMode
    ? '<label for="secret">New password</label>' +
      '<input id="secret" type="password" autocomplete="new-password" maxlength="256" autofocus>' +
      '<label for="confirmation">Confirm password</label>' +
      '<input id="confirmation" type="password" autocomplete="new-password" maxlength="256">'
    : '<label for="secret">New PIN</label>' +
      '<input id="secret" type="password" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="6 digits" autocomplete="new-password" autofocus>' +
      '<label for="confirmation">Confirm PIN</label>' +
      '<input id="confirmation" type="password" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="6 digits" autocomplete="new-password">';
  var guidance = passwordMode
    ? "Choose a new password of 15–128 characters. Spaces and passphrases are welcome."
    : "Choose a new 6-digit account PIN.";
  return head("Choose a new credential") +
    '<div id="step-set">' +
    '<h1>Choose a new credential</h1>' +
    '<p class="sub">' + escapeHtml(guidance) + ' This link works once, and every signed-in session on your account is signed out.</p>' +
    '<div id="error" class="error" role="alert"></div>' +
    fields +
    '<button id="submit">Save and sign out everywhere</button>' +
    '</div>' +
    '<div id="step-done" class="hidden">' +
    '<p class="success">Your credential has been updated and all sessions were signed out.<br><a href="/">Go to the sign-in page</a></p>' +
    '</div>' +
    '<script>\n' +
    'var passwordMode=' + (passwordMode ? 'true' : 'false') + ';\n' +
    'var errorEl=document.getElementById("error");\n' +
    'function submit(){\n' +
    '  var secret=document.getElementById("secret").value;\n' +
    '  var confirmation=document.getElementById("confirmation").value;\n' +
    '  if(secret!==confirmation){errorEl.textContent=passwordMode?"Passwords do not match.":"PINs do not match.";return}\n' +
    '  if(!passwordMode&&!/^\\d{6}$/.test(secret)){errorEl.textContent="PIN must be exactly 6 digits.";return}\n' +
    '  var button=document.getElementById("submit");button.disabled=true;errorEl.textContent="";\n' +
    '  var body=passwordMode?{password:secret,confirmPassword:confirmation}:{pin:secret,confirmPin:confirmation};\n' +
    '  fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})\n' +
    '    .then(function(response){return response.json().then(function(data){return {ok:response.ok,data:data}})})\n' +
    '    .then(function(result){\n' +
    '      if(result.ok&&result.data.ok){document.getElementById("step-set").classList.add("hidden");document.getElementById("step-done").classList.remove("hidden");setTimeout(function(){location.assign("/")},2500);return}\n' +
    '      errorEl.textContent=result.data.error||"Could not update your credential.";button.disabled=false;\n' +
    '    }).catch(function(){errorEl.textContent="Could not reach the server. Please retry.";button.disabled=false});\n' +
    '}\n' +
    'document.getElementById("submit").onclick=submit;\n' +
    'document.getElementById("confirmation").addEventListener("keydown",function(event){if(event.key==="Enter")submit()});\n' +
    '</script></div></body></html>';
}

module.exports = { render: render, renderInvalid: renderInvalid };
