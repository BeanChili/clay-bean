var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var source = ["admin-settings-ui.js", "admin-settings-users.js", "admin-settings-invitations.js", "admin-settings-email.js"].map(function (file) { return fs.readFileSync(path.join(__dirname, "../lib/public/modules/", file), "utf8"); }).join("\n");

test("user removal uses the custom destructive confirmation dialog", function () {
  assert.doesNotMatch(source, /\bconfirm\s*\(/);
  assert.match(source, /function showConfirmDialog\(message, actionLabel, onConfirm\)/);
  assert.match(source, /role="dialog" aria-modal="true" aria-label="Confirm action"/);
  assert.match(source, /showConfirmDialog\("Remove " \+ name \+ "\? This cannot be undone\.", "Remove user", function \(\) \{/);
  assert.match(source, /admin-modal-confirm-danger/);
  assert.match(source, /removeUser\(userId, body\)/);
});

test("admin credential help sends a recovery email and never promises a temporary PIN", function () {
  assert.doesNotMatch(source, /showConfirmResetPin/);
  assert.doesNotMatch(source, /A new temporary PIN will be generated/);
  assert.match(source, /function showConfirmRecoveryEmail\(name, maskedEmail, onConfirm\)/);
  assert.match(source, /Email a recovery link to/);
  assert.match(source, /api\/admin\/users\/" \+ userId \+ "\/recovery-email/);
  // Outcomes and failures stay on screen instead of only flashing as a toast.
  assert.match(source, /showAdminNotice\("Recovery email sent"/);
  assert.match(source, /showAdminNotice\("Recovery email not sent"/);
});

test("administrators are removable from the list and refusals stay on screen", function () {
  // Only the permissions button is still gated on the target's role; the
  // Remove button is offered for other administrators too.
  assert.equal(source.match(/u\.role !== "admin"/g).length, 1);
  assert.match(source, /Administrators can be removed too/);
  assert.match(source, /title="Remove user"/);
  assert.match(source, /showAdminNotice\("User not removed"/);
  assert.doesNotMatch(source, /showToast\(data\.error \|\| "Failed to remove user"\)/);
});

test("editing an account email is a modal that refreshes the row afterwards", function () {
  assert.match(source, /function showEditEmailModal\(user, body\)/);
  assert.match(source, /apiPut\("\/api\/admin\/users\/" \+ user\.id \+ "\/email"/);
  assert.match(source, /showAdminNotice\("Email updated"/);
  assert.match(source, /loadUsersTab\(body\)/);
  // The dialog uses the shared admin modal plumbing, not a browser prompt.
  assert.match(source, /mountAdminSubview\(modal\);\n\s*prepareAdminModal\(modal\);/);
});

test("the remove-button query excludes every other row action", function () {
  // Row actions all share .admin-remove-btn for styling, so the destructive
  // handler must be bound by exclusion. A new action class added to the row
  // without updating this query would silently wire up Remove instead.
  var action = /class="admin-remove-btn ([a-z-]+)"/g;
  var classes = [];
  var found;
  while ((found = action.exec(source)) !== null) if (classes.indexOf(found[1]) === -1) classes.push(found[1]);
  assert.deepEqual(classes.sort(), ["admin-email-btn", "admin-perms-btn", "admin-recovery-btn"]);
  var query = /querySelectorAll\("\.admin-remove-btn((?::not\(\.[a-z-]+\))+)"\)/.exec(source);
  assert.ok(query, "the remove buttons are selected by exclusion");
  classes.forEach(function (name) {
    assert.ok(query[1].indexOf(":not(." + name + ")") !== -1, name + " must be excluded from the remove query");
  });
});

test("invite revocation keeps its explicit custom-dialog action", function () {
  assert.match(source, /showConfirmDialog\("Revoke this invite\? The link will no longer work\.", "Revoke", function \(\) \{/);
});

test("SMTP removal uses the same custom destructive confirmation dialog", function () {
  assert.match(source, /showConfirmDialog\("Remove SMTP configuration\? Users will need to use PIN login\.", "Remove SMTP", function \(\) \{/);
});
