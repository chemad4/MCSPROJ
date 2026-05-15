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
                <i class="fas fa-exclamation-circle" style="font-size: 40px; color: var(--primary-red); margin-bottom: 10px;"></i>
                <h3>Confirmation</h3>
                <p id="customConfirmMessage">Are you sure?</p>
                <div class="confirm-actions">
                    <button class="btn-cancel" id="customConfirmCancel">Cancel</button>
                    <button class="btn-confirm" id="customConfirmOk">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);
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
