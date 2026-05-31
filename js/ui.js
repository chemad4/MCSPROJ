// js/ui.js
// Handles UI interactions like Toast notifications, Custom Confirms, and Dark Mode

document.addEventListener('DOMContentLoaded', () => {
    // Inject Toast Container
    if (!document.getElementById('toast-container')) {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        document.body.appendChild(toastContainer);
    }

    // Inject Custom Confirm Modal
    if (!document.getElementById('customConfirmModal')) {
        const confirmModal = document.createElement('div');
        confirmModal.id = 'customConfirmModal';
        confirmModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-icon">
                    <i id="customConfirmIcon" class="fas fa-question-circle"></i>
                </div>
                <h3 id="customConfirmTitle">Confirmation</h3>
                <p id="customConfirmMessage">Are you sure?</p>
                <div class="confirm-actions">
                    <button class="btn-cancel" id="customConfirmCancel">Cancel</button>
                    <button class="btn-confirm" id="customConfirmOk">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);
    }

    // Inject Custom Prompt Modal
    if (!document.getElementById('customPromptModal')) {
        const promptModal = document.createElement('div');
        promptModal.id = 'customPromptModal';
        promptModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-icon">
                    <i class="fas fa-comment-dots"></i>
                </div>
                <h3 id="customPromptTitle">Required Remarks</h3>
                <p id="customPromptMessage">Please provide details below:</p>
                <textarea id="customPromptInput" placeholder="Type your remarks here..."></textarea>
                <div class="confirm-actions">
                    <button class="btn-cancel" id="customPromptCancel">Cancel</button>
                    <button class="btn-confirm" id="customPromptOk">Submit</button>
                </div>
            </div>
        `;
        document.body.appendChild(promptModal);
    }

    // Inject Profile Settings Modal
    if (!document.getElementById('profileSettingsModal')) {
        const pModal = document.createElement('div');
        pModal.id = 'profileSettingsModal';
        pModal.className = 'modal';
        pModal.innerHTML = `
            <div class="modal-content profile-settings-modal">
                <div class="modal-header">
                    <h3><i class="fa-solid fa-user-gear"></i> Edit Profile</h3>
                    <span class="close-btn" onclick="document.getElementById('profileSettingsModal').style.display='none'" aria-label="Close">&times;</span>
                </div>

                <div class="profile-upload-wrapper">
                    <img src="images/default-profile.png" id="userProfilePreview" class="profile-upload-img">
                    <label for="userProfileFile" class="profile-upload-btn" aria-label="Change profile picture">
                        <i class="fas fa-pencil-alt"></i>
                    </label>
                </div>
                <input type="file" id="userProfileFile" accept="image/*" class="visually-hidden-input" onchange="previewImage(this, 'userProfilePreview')">

                <form id="profileSettingsForm" class="modal-form profile-settings-form">
                    <div class="form-group">
                        <label class="form-label" for="userProfileName">Full Name</label>
                        <input type="text" id="userProfileName" required maxlength="80" pattern="[A-Za-zñÑ\s\-'\.]+" title="Letters, spaces, hyphens and apostrophes only" placeholder="Your full name">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="userProfileEmail">Email</label>
                        <input type="email" id="userProfileEmail" readonly>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="userProfileEmergency">Emergency Contact Number</label>
                        <input type="tel" id="userProfileEmergency" placeholder="e.g. 09123456789" maxlength="15" pattern="^\+?[0-9\-\s]{7,15}$" title="7-15 digits; +, - and spaces allowed">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="userProfileCurrentPassword">Current Password <span class="form-label-hint">(required to change password)</span></label>
                        <input type="password" id="userProfileCurrentPassword" placeholder="••••••••" maxlength="64" autocomplete="current-password">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="userProfilePassword">New Password <span class="form-label-hint">(leave blank to keep current)</span></label>
                        <input type="password" id="userProfilePassword" placeholder="••••••••" maxlength="64" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="userProfilePasswordConfirm">Confirm New Password</label>
                        <input type="password" id="userProfilePasswordConfirm" placeholder="Repeat new password" maxlength="64" autocomplete="new-password">
                    </div>
                    <div class="btn-row">
                        <button type="button" class="btn-cancel" onclick="document.getElementById('profileSettingsModal').style.display='none'">Cancel</button>
                        <button type="submit" class="btn-submit">Save Changes</button>
                    </div>
                    <button type="button" class="btn-logout" onclick="handleLogout()">
                        <i class="fa-solid fa-power-off"></i> Log Out
                    </button>
                </form>
            </div>
        `;
        document.body.appendChild(pModal);
    }


    // Inject Session Rating Modal (member post-session feedback)
    if (!document.getElementById('sessionRatingModal')) {
        const ratingModal = document.createElement('div');
        ratingModal.id = 'sessionRatingModal';
        ratingModal.className = 'modal';
        ratingModal.style.display = 'none';
        ratingModal.setAttribute('role', 'dialog');
        ratingModal.setAttribute('aria-modal', 'true');
        ratingModal.setAttribute('aria-labelledby', 'srModalTitle');
        ratingModal.innerHTML = `
            <div class="modal-content" style="max-width:480px;">
                <div class="modal-header">
                    <h3 id="srModalTitle"><i class="fa-solid fa-star" style="color:var(--primary-red);margin-right:8px;"></i>Rate Your Session</h3>
                </div>
                <div class="modal-body" style="padding:20px 24px 8px;">
                    <p style="margin-bottom:4px;">How was your session with <strong id="srModalTrainerName">your trainer</strong>?</p>
                    <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:18px;">Session: <span id="srModalSessionDate"></span></p>
                    <div class="form-group" style="margin-bottom:14px;">
                        <label class="form-label" for="srModalRatingText">Rating <span style="color:var(--primary-red)">*</span></label>
                        <input type="text" id="srModalRatingText" class="form-control"
                            placeholder="e.g. Excellent, 5/5, Great experience..."
                            maxlength="120" autocomplete="off">
                    </div>
                    <div class="form-group" style="margin-bottom:6px;">
                        <label class="form-label" for="srModalRemarksText">Professional Remarks <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
                        <textarea id="srModalRemarksText" class="form-control" rows="3"
                            placeholder="Share details about the session, trainer's professionalism, areas to improve..."
                            maxlength="500" style="resize:vertical;"></textarea>
                    </div>
                </div>
                <div class="confirm-actions" style="padding:16px 24px 20px;gap:10px;">
                    <button class="btn-cancel" id="srModalSkipBtn" type="button">Skip</button>
                    <button class="btn-confirm" id="srModalSubmitBtn" type="button">Submit Feedback</button>
                </div>
            </div>
        `;
        document.body.appendChild(ratingModal);
    }

    // Initialize Dark Mode
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        const toggleIcon = document.getElementById('darkModeIcon');
        if (toggleIcon) toggleIcon.className = 'fas fa-sun';
    }
});

// Global showToast function
// M13: dedup identical messages within a short window so duplicate fast events
// (e.g. RFID double-tap, retry loops) don't stack the same toast repeatedly.
window.__toastDedupCache = window.__toastDedupCache || new Map();
window.showToast = function(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    try {
        const dedupKey = `${type}::${message}`;
        const lastShownAt = window.__toastDedupCache.get(dedupKey) || 0;
        const nowMs = Date.now();
        if (nowMs - lastShownAt < 1500) return; // suppress duplicate within 1.5s
        window.__toastDedupCache.set(dedupKey, nowMs);
        // Cap map size to prevent unbounded growth
        if (window.__toastDedupCache.size > 50) {
            const firstKey = window.__toastDedupCache.keys().next().value;
            window.__toastDedupCache.delete(firstKey);
        }
    } catch (_) { /* dedup is best-effort */ }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    if (type === 'error') iconClass = 'fa-exclamation-circle';

    // Build toast safely — icon via innerHTML, message via textContent (M-03 XSS Fix)
    const iconEl = document.createElement('i');
    iconEl.className = `fas ${iconClass} toast-icon`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(iconEl);
    toast.appendChild(msgSpan);
    toast.appendChild(closeBtn);

    container.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => {
        toast.classList.add('toast-show');
    }, 10);

    // Auto dismiss
    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
};

// Global showConfirm function.
// Two call signatures are supported (backwards compatible):
//   showConfirm("Message", onConfirm)
//   showConfirm({ title, message, tone, confirmText, cancelText, icon, onConfirm })
// `tone` ∈ 'default' | 'danger' | 'warning' | 'info' | 'success' — CSS class only, no behavior change.
window.showConfirm = function(arg1, arg2) {
    const opts = (typeof arg1 === 'string' || arg1 == null)
        ? { message: arg1, onConfirm: arg2 }
        : (arg1 || {});

    const {
        title = 'Confirmation',
        message = 'Are you sure?',
        tone = 'default',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        icon = null,
        onConfirm
    } = opts;

    const modal = document.getElementById('customConfirmModal');
    if (!modal) return;

    // Tone → icon + class
    const toneMap = {
        default: { icon: 'fa-question-circle', color: 'var(--primary-red)' },
        danger:  { icon: 'fa-exclamation-circle', color: 'var(--color-danger)' },
        warning: { icon: 'fa-exclamation-triangle', color: 'var(--color-warning)' },
        info:    { icon: 'fa-info-circle', color: 'var(--color-info)' },
        success: { icon: 'fa-check-circle', color: 'var(--color-success)' }
    };
    const t = toneMap[tone] || toneMap.default;

    const titleEl = document.getElementById('customConfirmTitle');
    const iconEl = document.getElementById('customConfirmIcon');
    const msgEl = document.getElementById('customConfirmMessage');

    if (titleEl) titleEl.innerText = title;
    if (iconEl) {
        iconEl.className = `fas ${icon || t.icon}`;
    }
    msgEl.innerText = message;
    msgEl.style.whiteSpace = 'pre-line';

    // Tone class on the modal shell for tinting border/header (canonical recipe)
    const shell = modal.querySelector('.modal-content');
    if (shell) {
        shell.classList.remove('tone-default', 'tone-danger', 'tone-warning', 'tone-info', 'tone-success');
        shell.classList.add(`tone-${tone}`);
    }

    const cancelBtn = document.getElementById('customConfirmCancel');
    const okBtn = document.getElementById('customConfirmOk');
    cancelBtn.innerText = cancelText;
    okBtn.innerText = confirmText;

    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    };

    const closeModal = () => {
        modal.style.display = 'none';
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        document.removeEventListener('keydown', onKey);
    };

    cancelBtn.onclick = closeModal;

    okBtn.onclick = async () => {
        const originalText = okBtn.innerHTML;
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        okBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        try {
            if (typeof onConfirm === 'function') {
                await onConfirm();
            }
        } catch (error) {
            console.error("Confirmation action failed:", error);
        } finally {
            okBtn.disabled = false;
            cancelBtn.disabled = false;
            okBtn.innerHTML = originalText;
            closeModal();
        }
    };

    document.addEventListener('keydown', onKey);
    modal.style.display = 'flex';
};

// Global showPrompt function
window.showPrompt = function({ title, message, placeholder, onConfirm }) {
    const modal = document.getElementById('customPromptModal');
    if (!modal) return;

    if (title) document.getElementById('customPromptTitle').innerText = title;
    if (message) document.getElementById('customPromptMessage').innerText = message;
    
    const input = document.getElementById('customPromptInput');
    input.value = "";
    if (placeholder) input.placeholder = placeholder;
    
    const cancelBtn = document.getElementById('customPromptCancel');
    const okBtn = document.getElementById('customPromptOk');

    const closeModal = () => {
        modal.style.display = 'none';
        okBtn.onclick = null;
        cancelBtn.onclick = null;
    };

    cancelBtn.onclick = closeModal;
    
    okBtn.onclick = async () => {
        const val = input.value.trim();
        if (!val) {
            input.classList.remove('is-invalid');
            void input.offsetWidth;
            input.classList.add('is-invalid');
            input.focus();
            setTimeout(() => input.classList.remove('is-invalid'), 1200);
            return;
        }
        const originalText = okBtn.innerHTML;
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        okBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        try {
            if (typeof onConfirm === 'function') {
                await onConfirm(val);
            }
        } catch (error) {
            console.error("Prompt action failed:", error);
        } finally {
            okBtn.disabled = false;
            cancelBtn.disabled = false;
            okBtn.innerHTML = originalText;
            closeModal();
        }
    };

    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 100);
};

// Global toggleDarkMode function
window.toggleDarkMode = function() {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    
    // Update icon if present
    const toggleIcon = document.getElementById('darkModeIcon');
    if (toggleIcon) {
        toggleIcon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    }
};
