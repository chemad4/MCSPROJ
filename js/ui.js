// js/ui.js
// Handles UI interactions like Toast notifications, Custom Confirms, and Dark Mode

const MODAL_OVERLAY_TW =
    'modal fixed inset-0 z-[10000] items-end sm:items-center justify-center ' +
    'p-0 sm:p-6 bg-gray-900/50 backdrop-blur-sm overflow-auto';

const MODAL_SHELL_TW =
    'modal-content relative w-[95%] sm:w-full max-w-md mx-auto bg-white ' +
    'rounded-t-2xl sm:rounded-2xl shadow-2xl ring-1 ring-gray-900/5 border border-gray-100 ' +
    'p-6 sm:p-8 transition-all duration-300 ease-out max-h-[92vh] overflow-y-auto';

const MODAL_BTN_CANCEL_TW =
    'btn-cancel inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold ' +
    'text-gray-600 bg-white border border-gray-300 rounded-xl hover:bg-gray-50 ' +
    'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-all duration-200';

const MODAL_BTN_PRIMARY_TW =
    'btn-confirm inline-flex items-center justify-center px-5 py-2.5 text-sm font-semibold text-white ' +
    'bg-red-800 shadow-sm rounded-xl hover:brightness-110 focus:outline-none ' +
    'focus:ring-2 focus:ring-offset-2 focus:ring-red-700 transition-all duration-200';

const MODAL_FOOTER_TW =
    'confirm-actions flex flex-col-reverse sm:flex-row gap-3 justify-end sm:justify-stretch mt-6 pt-5 border-t border-gray-100';

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
        confirmModal.className = MODAL_OVERLAY_TW;
        confirmModal.setAttribute('role', 'dialog');
        confirmModal.setAttribute('aria-modal', 'true');
        confirmModal.setAttribute('aria-labelledby', 'customConfirmTitle');
        confirmModal.innerHTML = `
            <div class="${MODAL_SHELL_TW} text-center">
                <div class="modal-icon mb-4">
                    <i id="customConfirmIcon" class="fas fa-question-circle text-4xl text-red-800"></i>
                </div>
                <h3 id="customConfirmTitle" class="text-lg font-semibold text-gray-900 mb-2">Confirmation</h3>
                <p id="customConfirmMessage" class="text-sm text-gray-600 leading-relaxed mb-2">Are you sure?</p>
                <div class="${MODAL_FOOTER_TW}">
                    <button class="${MODAL_BTN_CANCEL_TW}" id="customConfirmCancel" type="button">Cancel</button>
                    <button class="${MODAL_BTN_PRIMARY_TW}" id="customConfirmOk" type="button">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);
    }

    // Inject Custom Prompt Modal
    if (!document.getElementById('customPromptModal')) {
        const promptModal = document.createElement('div');
        promptModal.id = 'customPromptModal';
        promptModal.className = MODAL_OVERLAY_TW;
        promptModal.setAttribute('role', 'dialog');
        promptModal.setAttribute('aria-modal', 'true');
        promptModal.setAttribute('aria-labelledby', 'customPromptTitle');
        promptModal.innerHTML = `
            <div class="${MODAL_SHELL_TW}">
                <div class="modal-icon mb-4 text-center">
                    <i class="fas fa-comment-dots text-4xl text-red-800"></i>
                </div>
                <h3 id="customPromptTitle" class="text-lg font-semibold text-gray-900 mb-2 text-center">Required Remarks</h3>
                <p id="customPromptMessage" class="text-sm text-gray-600 leading-relaxed mb-4 text-center">Please provide details below:</p>
                <textarea id="customPromptInput" class="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white text-gray-900 min-h-[100px] mb-4 resize-none focus:outline-none focus:ring-2 focus:ring-red-700/30 focus:border-red-800 transition-all duration-200" placeholder="Type your remarks here..."></textarea>
                <div class="${MODAL_FOOTER_TW}">
                    <button class="${MODAL_BTN_CANCEL_TW}" id="customPromptCancel" type="button">Cancel</button>
                    <button class="${MODAL_BTN_PRIMARY_TW}" id="customPromptOk" type="button">Submit</button>
                </div>
            </div>
        `;
        document.body.appendChild(promptModal);
    }

    // Inject Profile Settings Modal
    if (!document.getElementById('profileSettingsModal')) {
        const pModal = document.createElement('div');
        pModal.id = 'profileSettingsModal';
        pModal.className = MODAL_OVERLAY_TW;
        pModal.setAttribute('role', 'dialog');
        pModal.setAttribute('aria-modal', 'true');
        pModal.innerHTML = `
            <div class="modal-content profile-settings-modal ${MODAL_SHELL_TW.replace('max-w-md', 'max-w-lg')}">
                <div class="modal-header flex items-center justify-between gap-4 mb-6">
                    <h3 class="text-lg font-semibold text-gray-900 flex items-center gap-2 m-0"><i class="fa-solid fa-user-gear text-red-800"></i> Edit Profile</h3>
                    <button type="button" class="close-btn" onclick="document.getElementById('profileSettingsModal').style.display='none'" aria-label="Close">&times;</button>
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
                    <div class="btn-row flex flex-col-reverse sm:flex-row gap-3 justify-end mt-6 pt-5 border-t border-gray-100">
                        <button type="button" class="${MODAL_BTN_CANCEL_TW}" onclick="document.getElementById('profileSettingsModal').style.display='none'">Cancel</button>
                        <button type="submit" class="btn-submit ${MODAL_BTN_PRIMARY_TW.replace('btn-confirm', 'btn-submit')}">Save Changes</button>
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
        ratingModal.className = MODAL_OVERLAY_TW;
        ratingModal.style.display = 'none';
        ratingModal.setAttribute('role', 'dialog');
        ratingModal.setAttribute('aria-modal', 'true');
        ratingModal.setAttribute('aria-labelledby', 'srModalTitle');
        ratingModal.innerHTML = `
            <div class="${MODAL_SHELL_TW.replace('max-w-md', 'max-w-lg')}">
                <div class="modal-header flex items-center justify-between gap-4 mb-4 pb-4 border-b border-gray-100">
                    <h3 id="srModalTitle" class="text-lg font-semibold text-gray-900 flex items-center gap-2 m-0"><i class="fa-solid fa-star text-red-800"></i>Rate Your Session</h3>
                </div>
                <div class="modal-body">
                    <p class="text-sm text-gray-700 mb-1">How was your session with <strong id="srModalTrainerName">your trainer</strong>?</p>
                    <p class="text-xs text-gray-500 mb-5">Session: <span id="srModalSessionDate"></span></p>
                    <div class="form-group mb-4">
                        <label class="form-label" for="srModalRatingText">Rating <span class="text-red-800">*</span></label>
                        <input type="text" id="srModalRatingText" class="form-control"
                            placeholder="e.g. Excellent, 5/5, Great experience..."
                            maxlength="120" autocomplete="off">
                    </div>
                    <div class="form-group mb-2">
                        <label class="form-label" for="srModalRemarksText">Professional Remarks <span class="font-normal text-gray-500">(optional)</span></label>
                        <textarea id="srModalRemarksText" class="form-control" rows="3"
                            placeholder="Share details about the session, trainer's professionalism, areas to improve..."
                            maxlength="500" style="resize:vertical;"></textarea>
                    </div>
                </div>
                <div class="${MODAL_FOOTER_TW}">
                    <button class="${MODAL_BTN_CANCEL_TW}" id="srModalSkipBtn" type="button">Skip</button>
                    <button class="${MODAL_BTN_PRIMARY_TW}" id="srModalSubmitBtn" type="button">Submit Feedback</button>
                </div>
            </div>
        `;
        document.body.appendChild(ratingModal);
    }

    // Global backdrop-click + Escape for system modals (UI layer only)
    initModalAccessibility();

    // Initialize Dark Mode
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        const toggleIcon = document.getElementById('darkModeIcon');
        if (toggleIcon) toggleIcon.className = 'fas fa-sun';
    }
});

/** Backdrop dismiss + Escape — respects membershipExpiredModal lockout. */
function initModalAccessibility() {
    const NON_DISMISSABLE = new Set(['membershipExpiredModal']);

    document.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal, #customConfirmModal, #customPromptModal');
        if (!modal || e.target !== modal) return;
        if (NON_DISMISSABLE.has(modal.id)) return;
        if (modal.id === 'customConfirmModal') {
            document.getElementById('customConfirmCancel')?.click();
            return;
        }
        if (modal.id === 'customPromptModal') {
            document.getElementById('customPromptCancel')?.click();
            return;
        }
        if (modal.id && typeof window.closeModal === 'function') {
            window.closeModal(modal.id);
        } else {
            modal.style.display = 'none';
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const openModals = [];
        document.querySelectorAll('.modal, #customConfirmModal, #customPromptModal').forEach((m) => {
            if (!m.isConnected) return;
            const cs = window.getComputedStyle(m);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            openModals.push(m);
        });
        if (!openModals.length) return;
        const top = openModals[openModals.length - 1];
        if (NON_DISMISSABLE.has(top.id)) return;
        if (top.id === 'customConfirmModal') {
            e.preventDefault();
            document.getElementById('customConfirmCancel')?.click();
            return;
        }
        if (top.id === 'customPromptModal') {
            e.preventDefault();
            document.getElementById('customPromptCancel')?.click();
            return;
        }
        if (top.id && typeof window.closeModal === 'function') {
            e.preventDefault();
            window.closeModal(top.id);
        } else if (top.id) {
            e.preventDefault();
            top.style.display = 'none';
        }
    });
}

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

// Operator alert for batch items expiring within 7 days.
// Rendered as a persistent amber banner above the POS area (not a transient toast)
// so the operator sees it even if they look away for a moment.
window.showBatchExpiryWarning = function (productName, expiryDate, daysLeft) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const banner = document.createElement('div');
    banner.className = 'toast toast-warning batch-expiry-alert';
    banner.style.cssText = 'min-width:320px;background:var(--warning-bg,#fff3cd);border-left:4px solid #f59e0b;color:#92400e;';

    const icon = document.createElement('i');
    icon.className = 'fas fa-clock toast-icon';
    icon.style.color = '#f59e0b';

    const msg = document.createElement('span');
    msg.textContent = `Batch Expiry Alert: "${productName}" stock expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${expiryDate}). Consider marking for promotion.`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.onclick = () => banner.remove();

    banner.appendChild(icon);
    banner.appendChild(msg);
    banner.appendChild(closeBtn);
    container.appendChild(banner);

    // Keep visible for 12 seconds — long enough for the operator to read it
    setTimeout(() => banner.classList.add('toast-show'), 10);
    setTimeout(() => {
        banner.classList.remove('toast-show');
        setTimeout(() => banner.remove(), 300);
    }, 12000);
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
        onConfirm,
        onCancel
    } = opts;

    const modal = document.getElementById('customConfirmModal');
    if (!modal) return;

    // Tone → icon + class
    const toneMap = {
        default: { icon: 'fa-question-circle', color: 'text-red-800' },
        danger:  { icon: 'fa-exclamation-circle', color: 'text-red-600' },
        warning: { icon: 'fa-exclamation-triangle', color: 'text-amber-500' },
        info:    { icon: 'fa-info-circle', color: 'text-blue-500' },
        success: { icon: 'fa-check-circle', color: 'text-emerald-500' }
    };
    const t = toneMap[tone] || toneMap.default;

    const titleEl = document.getElementById('customConfirmTitle');
    const iconEl = document.getElementById('customConfirmIcon');
    const msgEl = document.getElementById('customConfirmMessage');

    if (titleEl) titleEl.innerText = title;
    if (iconEl) {
        iconEl.className = `fas ${icon || t.icon} text-4xl ${t.color}`;
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

    cancelBtn.onclick = () => { closeModal(); if (typeof onCancel === 'function') onCancel(); };

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
window.showPrompt = function({ title, message, placeholder, onConfirm, onCancel }) {
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

    cancelBtn.onclick = () => { closeModal(); if (typeof onCancel === 'function') onCancel(); };

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
