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

    // Inject Change Password Modal
    if (!document.getElementById('changePasswordModal')) {
        const cpModal = document.createElement('div');
        cpModal.id = 'changePasswordModal';
        cpModal.className = 'modal';
        cpModal.innerHTML = `
            <div class="modal-content" style="max-width: 400px;">
                <span class="close-modal" onclick="document.getElementById('changePasswordModal').style.display='none'"><i class="fas fa-times"></i></span>
                <h3>Change Password</h3>
                <form id="changePasswordForm" style="display: flex; flex-direction: column; gap: 15px; margin-top: 20px;">
                    <div class="form-group">
                        <label>New Password</label>
                        <input type="password" id="newPasswordInput" required>
                    </div>
                    <button type="submit" class="submit-btn" style="width: 100%;">Update Password</button>
                </form>
            </div>
        `;
        document.body.appendChild(cpModal);
    }

    // Initialize Dark Mode
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
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
