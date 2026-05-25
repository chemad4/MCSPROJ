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
                <div class="modal-icon" style="margin-bottom: 20px;">
                    <i id="customConfirmIcon" class="fas fa-question-circle" style="font-size: 48px; color: var(--primary-red); opacity: 0.9;"></i>
                </div>
                <h3 id="customConfirmTitle" style="font-weight: 700; font-size: 20px; color: var(--text-primary); margin-bottom: 8px;">Confirmation</h3>
                <p id="customConfirmMessage">Are you sure?</p>
                <div class="confirm-actions">
                    <button class="btn-cancel" id="customConfirmCancel" style="background: rgba(0,0,0,0.05); color: var(--text-muted);">Cancel</button>
                    <button class="btn-confirm" id="customConfirmOk" style="background: var(--dark-black); color: white;">Confirm</button>
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
                <div class="modal-icon" style="margin-bottom: 20px;">
                    <i class="fas fa-comment-dots" style="font-size: 48px; color: var(--primary-red); opacity: 0.9;"></i>
                </div>
                <h3 id="customPromptTitle" style="font-weight: 700; font-size: 20px; color: var(--text-primary); margin-bottom: 8px;">Required Remarks</h3>
                <p id="customPromptMessage">Please provide details below:</p>
                <textarea id="customPromptInput" placeholder="Type your remarks here..."></textarea>
                <div class="confirm-actions">
                    <button class="btn-cancel" id="customPromptCancel" style="background: rgba(0,0,0,0.05); color: var(--text-muted);">Cancel</button>
                    <button class="btn-confirm" id="customPromptOk" style="background: var(--dark-black); color: white;">Submit</button>
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
            <div class="modal-content" style="max-width: 450px; position: relative;">
                <span class="close-btn" onclick="document.getElementById('profileSettingsModal').style.display='none'" style="position: absolute; right: 20px; top: 15px; cursor: pointer; font-size: 24px;">&times;</span>
                <h3 style="text-align: center; margin-bottom: 20px;">Edit Profile</h3>
                
                <div class="profile-upload-wrapper">
                    <img src="images/default-profile.png" id="userProfilePreview" class="profile-upload-img">
                    <label for="userProfileFile" class="profile-upload-btn">
                        <i class="fas fa-pencil-alt"></i>
                    </label>
                </div>
                <input type="file" id="userProfileFile" accept="image/*" style="display: none;" onchange="previewImage(this, 'userProfilePreview')">

                <form id="profileSettingsForm" style="display: flex; flex-direction: column; gap: 12px;">
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Full Name</label>
                        <input type="text" id="userProfileName" required maxlength="80" pattern="[A-Za-zñÑ\s\-'\.]+" title="Letters, spaces, hyphens and apostrophes only" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Email</label>
                        <input type="email" id="userProfileEmail" readonly style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: #f1f5f9; color: #64748b;">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Emergency Contact Number</label>
                        <input type="tel" id="userProfileEmergency" placeholder="e.g. 09123456789" maxlength="15" pattern="^\+?[0-9\-\s]{7,15}$" title="7-15 digits; +, - and spaces allowed" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Current Password (Required to change password)</label>
                        <input type="password" id="userProfileCurrentPassword" placeholder="********" maxlength="64" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">New Password (Leave blank to keep current)</label>
                        <input type="password" id="userProfilePassword" placeholder="********" maxlength="64" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Confirm New Password</label>
                        <input type="password" id="userProfilePasswordConfirm" placeholder="Repeat new password" maxlength="64" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="btn-row" style="margin-top: 15px;">
                        <button type="button" class="btn-cancel" onclick="document.getElementById('profileSettingsModal').style.display='none'">Cancel</button>
                        <button type="submit" class="btn-submit" style="background-color: var(--dark-black);">Save Changes</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(pModal);
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
        iconEl.style.fontSize = '48px';
        iconEl.style.opacity = '0.9';
        iconEl.style.color = t.color;
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

    // Tint primary button to match tone
    if (tone === 'danger') {
        okBtn.style.background = 'var(--color-danger)';
    } else if (tone === 'warning') {
        okBtn.style.background = 'var(--color-warning)';
    } else if (tone === 'success') {
        okBtn.style.background = 'var(--color-success)';
    } else if (tone === 'info') {
        okBtn.style.background = 'var(--color-info)';
    } else {
        okBtn.style.background = 'var(--dark-black)';
    }
    okBtn.style.color = '#fff';

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
            input.style.borderColor = 'var(--primary-red)';
            setTimeout(() => input.style.borderColor = '', 2000);
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
