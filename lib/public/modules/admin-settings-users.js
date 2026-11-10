import { store } from './store.js';
import { iconHtml, refreshIcons } from './icons.js';
import { showToast, copyToClipboard, escapeHtml } from './utils.js';
import { apiGet, apiPost, apiPut, apiDelete, showConfirmDialog, showConfirmRecoveryEmail, showAdminNotice, prepareAdminModal, mountAdminSubview } from './admin-settings-ui.js';
// --- Users ---
export function loadUsersTab(body) {
  apiGet("/api/admin/users").then(function (data) {
    store.set({ adminUsers: data.users || [] });
    // Recovery email delivery needs SMTP; the button explains itself when it is
    // missing rather than failing on click.
    return apiGet("/api/admin/smtp").then(function (smtp) {
      store.set({ adminSmtpConfigured: !!(smtp && smtp.smtp && smtp.smtp.host) });
    }).catch(function () {
      store.set({ adminSmtpConfigured: false });
    });
  }).then(function () {
    renderUsersTab(body);
  }).catch(function () {
    body.innerHTML = '<div class="admin-error">Failed to load users</div>';
  });
}

// Mirrors the server-side masking so the confirmation and the result name the
// same partially hidden address.
function maskEmail(email) {
  var value = String(email || "");
  var at = value.lastIndexOf("@");
  if (at <= 0) return "their address on file";
  var local = value.slice(0, at);
  var domain = value.slice(at);
  if (local.length <= 2) return local.slice(0, 1) + "•••" + domain;
  return local.slice(0, 1) + "•••" + local.slice(-1) + domain;
}

function renderUsersTab(body) {
  var html = '<div class="admin-section-header">' +
    '<div class="admin-header-btns">' +
    '<button class="admin-action-btn" id="admin-add-user">' + iconHtml("user-plus") + ' Add user</button>' +
    '</div></div>';
  html += '<div class="admin-user-list">';
  for (var i = 0; i < store.get('adminUsers').length; i++) {
    var u = store.get('adminUsers')[i];
    var isMe = store.get('adminMe') && store.get('adminMe').user && store.get('adminMe').user.id === u.id;
    var created = new Date(u.createdAt).toLocaleDateString();
    html += '<div class="admin-user-item">';
    html += '<div class="admin-user-info">';
    html += '<div class="admin-user-name">';
    html += '<strong>' + escapeHtml(u.displayName || u.username) + '</strong>';
    if (u.role === "admin") html += ' <span class="admin-badge">admin</span>';
    if (isMe) html += ' <span class="admin-you-badge">you</span>';
    html += '</div>';
    html += '<div class="admin-user-meta">' + escapeHtml(u.username) + ' · joined ' + created + '</div>';
    html += '</div>';
    if (!isMe) {
      html += '<div style="display:flex;align-items:center;gap:2px">';
      if (u.role !== "admin") {
        html += '<button class="admin-remove-btn admin-perms-btn" data-user-id="' + u.id + '" title="Permissions">' + iconHtml("shield") + '</button>';
      }
      // Administrators can only send a recovery link to the account's own
      // address; they never see or set another account's credential.
      var smtpReady = store.get('adminSmtpConfigured');
      var recoveryReason = !smtpReady
        ? "SMTP is not configured. Set up email delivery in Email settings to send recovery links."
        : !u.email
          ? "This account has no email address on file, so it cannot receive a recovery link."
          : "Send recovery email";
      html += '<button class="admin-remove-btn admin-recovery-btn" data-user-id="' + u.id + '"' +
        (smtpReady && u.email ? '' : ' disabled aria-disabled="true"') +
        ' title="' + escapeHtml(recoveryReason) + '" aria-label="' + escapeHtml(recoveryReason) + '">' + iconHtml("mail") + '</button>';
      if (u.role !== "admin") {
        html += '<button class="admin-remove-btn" data-user-id="' + u.id + '" title="Remove user">' + iconHtml("trash-2") + '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  body.innerHTML = html;
  refreshIcons(body);

  // Bind add user button
  var addUserBtn = body.querySelector("#admin-add-user");
  if (addUserBtn) {
    addUserBtn.addEventListener("click", function () {
      showAddUserModal(body);
    });
  }

  // Bind recovery email buttons
  var recoveryBtns = body.querySelectorAll(".admin-recovery-btn");
  for (var j = 0; j < recoveryBtns.length; j++) {
    recoveryBtns[j].addEventListener("click", function (e) {
      e.stopPropagation();
      if (this.disabled) return;
      var button = this;
      var userId = this.dataset.userId;
      var user = store.get('adminUsers').find(function (u) { return u.id === userId; });
      var name = user ? (user.displayName || user.username) : "this user";
      showConfirmRecoveryEmail(name, maskEmail(user && user.email), function () {
        button.disabled = true;
        apiPost("/api/admin/users/" + userId + "/recovery-email").then(function (data) {
          button.disabled = false;
          if (data.ok) {
            // The response carries a masked address only: never the token.
            showAdminNotice("Recovery email sent", "Recovery email sent to " + (data.email || maskEmail(user && user.email)) + ". The link expires in 30 minutes and " + name + " chooses their own new credential.");
          } else {
            showAdminNotice("Recovery email not sent", data.error || "Failed to send the recovery email.", "error");
          }
        }).catch(function (error) {
          button.disabled = false;
          showAdminNotice("Recovery email not sent", (error && error.message) || "Failed to send the recovery email.", "error");
        });
      });
    });
  }

  // Bind permissions buttons
  var permsBtns = body.querySelectorAll(".admin-perms-btn");
  for (var p = 0; p < permsBtns.length; p++) {
    permsBtns[p].addEventListener("click", function (e) {
      e.stopPropagation();
      var userId = this.dataset.userId;
      var user = store.get('adminUsers').find(function (u) { return u.id === userId; });
      if (user) showPermissionsModal(user, body);
    });
  }

  // Bind remove buttons
  var removeBtns = body.querySelectorAll(".admin-remove-btn:not(.admin-recovery-btn):not(.admin-perms-btn)");
  for (var k = 0; k < removeBtns.length; k++) {
    removeBtns[k].addEventListener("click", function () {
      var userId = this.dataset.userId;
      var user = store.get('adminUsers').find(function (u) { return u.id === userId; });
      var name = user ? (user.displayName || user.username) : "this user";
      showConfirmDialog("Remove " + name + "? This cannot be undone.", "Remove user", function () {
        removeUser(userId, body);
      });
    });
  }
}

var PERM_LABELS = [
  { key: "terminal", label: "Terminal", desc: "Access the web terminal" },
  { key: "fileBrowser", label: "File Browser", desc: "Browse and manage files" },
  { key: "createProject", label: "Create Projects", desc: "Create or clone new projects" },
  { key: "deleteProject", label: "Delete Projects", desc: "Remove projects" },
  { key: "skills", label: "Skills", desc: "View and install skills" },
  { key: "sessionDelete", label: "Delete Sessions", desc: "Delete chat sessions" },
  { key: "scheduledTasks", label: "Scheduled Tasks", desc: "Create and manage scheduled tasks" },
  { key: "projectSettings", label: "Project Settings", desc: "Access project settings" },
];

var DEFAULT_PERMISSIONS = {
  terminal: false,
  fileBrowser: false,
  createProject: true,
  deleteProject: false,
  skills: true,
  sessionDelete: false,
  scheduledTasks: false,
  projectSettings: false,
};

function showPermissionsModal(user, body) {
  var perms = {};
  var keys = PERM_LABELS.map(function (p) { return p.key; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    perms[k] = (user.permissions && user.permissions[k] !== undefined) ? user.permissions[k] : DEFAULT_PERMISSIONS[k];
  }

  var modal = document.createElement("div");
  modal.className = "admin-modal-overlay";
  var html = '<div class="admin-modal">' +
    '<div class="admin-modal-header">' +
    '<h3>Permissions: ' + escapeHtml(user.displayName || user.username) + '</h3>' +
    '<button class="admin-modal-close">&times;</button>' +
    '</div>' +
    '<div class="admin-modal-body">' +
    '<div class="admin-perms-list">';

  for (var j = 0; j < PERM_LABELS.length; j++) {
    var p = PERM_LABELS[j];
    var checked = perms[p.key] ? " checked" : "";
    html += '<label class="admin-perm-row">' +
      '<div class="admin-perm-info">' +
      '<span class="admin-perm-label">' + p.label + '</span>' +
      '<span class="admin-perm-desc">' + p.desc + '</span>' +
      '</div>' +
      '<input type="checkbox" class="admin-perm-toggle" data-perm="' + p.key + '"' + checked + '>' +
      '</label>';
  }

  html += '</div></div>' +
    '<div class="admin-modal-footer">' +
    '<button class="admin-modal-save" id="admin-perms-save">Save</button>' +
    '<button class="admin-modal-cancel">Cancel</button>' +
    '</div></div>';

  modal.innerHTML = html;
  mountAdminSubview(modal);
  prepareAdminModal(modal);
  refreshIcons(modal);

  modal.querySelector(".admin-modal-close").addEventListener("click", function () { modal.remove(); });
  modal.querySelector(".admin-modal-cancel").addEventListener("click", function () { modal.remove(); });
  modal.addEventListener("click", function (e) { if (e.target === modal) modal.remove(); });

  modal.querySelector("#admin-perms-save").addEventListener("click", function () {
    var toggles = modal.querySelectorAll(".admin-perm-toggle");
    var newPerms = {};
    for (var t = 0; t < toggles.length; t++) {
      newPerms[toggles[t].dataset.perm] = toggles[t].checked;
    }
    apiPut("/api/admin/users/" + user.id + "/permissions", { permissions: newPerms }).then(function (data) {
      if (data.ok) {
        showToast("Permissions updated");
        modal.remove();
        // Update cached user
        for (var c = 0; c < store.get('adminUsers').length; c++) {
          if (store.get('adminUsers')[c].id === user.id) {
            store.get('adminUsers')[c].permissions = data.permissions;
            break;
          }
        }
      } else {
        showToast(data.error || "Failed to update permissions");
      }
    }).catch(function () {
      showToast("Failed to update permissions");
    });
  });
}

function showAddUserModal(body) {
  var modal = document.createElement("div");
  modal.className = "admin-modal-overlay";
  var html = '<div class="admin-modal">' +
    '<div class="admin-modal-header">' +
    '<h3>Add user</h3>' +
    '<button class="admin-modal-close">' + iconHtml("x") + '</button>' +
    '</div>' +
    '<div class="admin-modal-body">' +
    '<p class="admin-modal-desc">Create a new user account. A temporary 6-digit PIN will be generated automatically. The user must change it on first login.</p>' +
    '<div class="admin-smtp-row"><label>Username</label>' +
    '<input type="text" class="admin-smtp-input" id="admin-new-username" placeholder="username" autocomplete="off" maxlength="100"></div>' +
    '<div class="admin-smtp-row"><label>Display name</label>' +
    '<input type="text" class="admin-smtp-input" id="admin-new-displayname" placeholder="Display name (optional)" autocomplete="off" maxlength="30"></div>' +
    '<div class="admin-smtp-row"><label>Email</label>' +
    '<input type="email" class="admin-smtp-input" id="admin-new-email" placeholder="user@example.com (optional)" autocomplete="off"></div>' +
    '<div class="admin-smtp-row"><label>Role</label>' +
    '<select class="admin-smtp-input" id="admin-new-role"><option value="user">User</option><option value="admin">Admin</option></select></div>' +
    '<div class="admin-smtp-error" id="admin-new-user-error"></div>' +
    '</div>' +
    '<div class="admin-modal-footer">' +
    '<button class="admin-modal-save" id="admin-new-user-create">Create user</button>' +
    '<button class="admin-modal-cancel">Cancel</button>' +
    '</div></div>';
  modal.innerHTML = html;
  mountAdminSubview(modal);
  prepareAdminModal(modal);
  refreshIcons(modal);

  var usernameInput = modal.querySelector("#admin-new-username");
  var displayNameInput = modal.querySelector("#admin-new-displayname");
  var emailInput = modal.querySelector("#admin-new-email");
  var roleSelect = modal.querySelector("#admin-new-role");
  var createBtn = modal.querySelector("#admin-new-user-create");
  var errorEl = modal.querySelector("#admin-new-user-error");

  modal.querySelector(".admin-modal-close").addEventListener("click", function () { modal.remove(); });
  modal.querySelector(".admin-modal-cancel").addEventListener("click", function () { modal.remove(); });
  modal.addEventListener("click", function (e) { if (e.target === modal) modal.remove(); });

  usernameInput.focus();
  usernameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") createBtn.click();
  });

  createBtn.addEventListener("click", function () {
    var username = usernameInput.value.trim();
    if (!username) {
      errorEl.textContent = "Username is required";
      errorEl.className = "admin-smtp-error admin-smtp-error-visible";
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = "Creating...";
    errorEl.textContent = "";
    errorEl.className = "admin-smtp-error";
    apiPost("/api/admin/users", {
      username: username,
      displayName: displayNameInput.value.trim() || username,
      email: emailInput.value.trim() || null,
      role: roleSelect.value,
    }).then(function (data) {
      if (data.ok) {
        modal.remove();
        showTempPinModal(data.user, data.tempPin);
        loadUsersTab(body);
      } else {
        errorEl.textContent = data.error || "Failed to create user";
        errorEl.className = "admin-smtp-error admin-smtp-error-visible";
        createBtn.disabled = false;
        createBtn.textContent = "Create user";
      }
    }).catch(function () {
      errorEl.textContent = "Failed to create user";
      errorEl.className = "admin-smtp-error admin-smtp-error-visible";
      createBtn.disabled = false;
      createBtn.textContent = "Create user";
    });
  });
}

function showTempPinModal(user, tempPin) {
  var modal = document.createElement("div");
  modal.className = "admin-modal-overlay";
  var html = '<div class="admin-modal">' +
    '<div class="admin-modal-header">' +
    '<h3>User Created</h3>' +
    '<button class="admin-modal-close">' + iconHtml("x") + '</button>' +
    '</div>' +
    '<div class="admin-modal-body">' +
    '<p class="admin-modal-desc">Account for <strong>' + escapeHtml(user.displayName || user.username) + '</strong> has been created. Share these credentials with the user:</p>' +
    '<div class="admin-temp-pin-box">' +
    '<div class="admin-temp-pin-row"><span class="admin-temp-pin-label">Username</span><code class="admin-temp-pin-value">' + escapeHtml(user.username) + '</code></div>' +
    '<div class="admin-temp-pin-row"><span class="admin-temp-pin-label">Temporary PIN</span><code class="admin-temp-pin-value admin-temp-pin-highlight">' + escapeHtml(tempPin) + '</code></div>' +
    '</div>' +
    '<p class="admin-modal-desc" style="margin-top:12px;color:var(--text-secondary);font-size:12px;">This PIN is one-time use. The user will be prompted to set a new PIN on first login.</p>' +
    '</div>' +
    '<div class="admin-modal-footer">' +
    '<button class="admin-modal-save" id="admin-copy-credentials">Copy Credentials</button>' +
    '<button class="admin-modal-cancel">Close</button>' +
    '</div></div>';
  modal.innerHTML = html;
  mountAdminSubview(modal);
  prepareAdminModal(modal);
  refreshIcons(modal);

  modal.querySelector(".admin-modal-close").addEventListener("click", function () { modal.remove(); });
  modal.querySelector(".admin-modal-cancel").addEventListener("click", function () { modal.remove(); });
  modal.addEventListener("click", function (e) { if (e.target === modal) modal.remove(); });

  modal.querySelector("#admin-copy-credentials").addEventListener("click", function () {
    var text = "Username: " + user.username + "\nTemporary PIN: " + tempPin;
    copyToClipboard(text).then(function () {
      showToast("Credentials copied to clipboard");
    }).catch(function () {
      showToast("Username: " + user.username + " / PIN: " + tempPin);
    });
  });
}

function removeUser(userId, body) {
  apiDelete("/api/admin/users/" + userId).then(function (data) {
    if (data.ok) {
      showToast("User removed");
      loadUsersTab(body);
    } else {
      showToast(data.error || "Failed to remove user");
    }
  }).catch(function () {
    showToast("Failed to remove user");
  });
}
