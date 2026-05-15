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
                    <i class="fas fa-question-circle" style="font-size: 48px; color: var(--primary-red); opacity: 0.9;"></i>
                </div>
                <h3 style="font-weight: 700; font-size: 20px; color: var(--text-primary); margin-bottom: 8px;">Confirmation</h3>
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
                        <input type="text" id="userProfileName" required style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Email</label>
                        <input type="email" id="userProfileEmail" readonly style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: #f1f5f9; color: #64748b;">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">Emergency Contact Number</label>
                        <input type="text" id="userProfileEmergency" placeholder="e.g. 09123456789" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; font-weight: 600;">New Password (Leave blank to keep current)</label>
                        <input type="password" id="userProfilePassword" placeholder="********" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg); color: var(--text-primary);">
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
window.showToast = function(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    if (type === 'error') iconClass = 'fa-exclamation-circle';

    toast.innerHTML = `
        <i class="fas ${iconClass} toast-icon"></i>
        <span>${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;

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

// Global showConfirm function
window.showConfirm = function(message, onConfirm) {
    const modal = document.getElementById('customConfirmModal');
    if (!modal) return;

    document.getElementById('customConfirmMessage').innerText = message;
    
    const cancelBtn = document.getElementById('customConfirmCancel');
    const okBtn = document.getElementById('customConfirmOk');

    const closeModal = () => {
        modal.style.display = 'none';
        okBtn.onclick = null;
        cancelBtn.onclick = null;
    };

    cancelBtn.onclick = closeModal;
    
    okBtn.onclick = () => {
        closeModal();
        if (typeof onConfirm === 'function') onConfirm();
    };

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
    
    okBtn.onclick = () => {
        const val = input.value.trim();
        if (!val) {
            input.style.borderColor = 'var(--primary-red)';
            setTimeout(() => input.style.borderColor = '', 2000);
            return;
        }
        closeModal();
        if (typeof onConfirm === 'function') onConfirm(val);
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
