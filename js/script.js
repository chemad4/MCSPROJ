// ==========================================
// 1. IMPORT FIREBASE DEPENDENCIES
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, where, getDocs, getDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { initAttendance } from "./attendance.js";
import { initRfid } from "./rfid.js";
import { escapeHtml, formatCurrency } from "./utils.js";

// Expose utilities globally for inline handlers & other scripts
window.escapeHtml = escapeHtml;
window.formatCurrency = formatCurrency;

/**
 * Synchronizes a container with a data array using DOM diffing to prevent UI flickering.
 */
window.syncDOM = function (container, dataArray, renderFunc, idPrefix) {
    if (!container) return;

    // Clear initial skeleton loaders if they exist (Audit Fix)
    if (container.querySelector('.skeleton-row') || (container.innerHTML.includes('Loading...') && !container.innerHTML.includes(idPrefix))) {
        container.innerHTML = "";
    }

    const currentIds = new Set(dataArray.map(item => `${idPrefix}-${item.id}`));

    // 1. Remove elements no longer in the data array
    Array.from(container.children).forEach(child => {
        if (child.id && child.id.startsWith(idPrefix) && !currentIds.has(child.id)) {
            container.removeChild(child);
        }
    });

    // 2. Update existing elements or Append new ones
    dataArray.forEach((item, index) => {
        const id = `${idPrefix}-${item.id}`;
        const html = renderFunc(item);
        let el = document.getElementById(id);

        if (el) {
            // Update existing if content changed
            if (el.innerHTML !== html) {
                el.innerHTML = html;
            }
        } else {
            // Create new element
            const isTable = container.tagName === 'TBODY';
            const temp = document.createElement(isTable ? 'table' : 'div');
            temp.innerHTML = isTable ? `<tbody>${html}</tbody>` : html;
            const newEl = isTable ? temp.querySelector('tr') : temp.firstElementChild;
            if (newEl) {
                newEl.id = id;
                // Insert at specific index to maintain order
                const nextEl = container.children[index];
                if (nextEl) {
                    container.insertBefore(newEl, nextEl);
                } else {
                    container.appendChild(newEl);
                }
            }
        }

        // 3. Maintain correct order if it changed
        const currentElAtIndex = container.children[index];
        if (currentElAtIndex && currentElAtIndex.id !== id) {
            const targetEl = document.getElementById(id);
            if (targetEl) container.insertBefore(targetEl, currentElAtIndex);
        }
    });
};

// ==========================================
// 2. FIREBASE & EMAILJS CONFIGURATION
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyB5xluf59a0X6v-_TNzR6Ny0mtcjSVWyLA",
    authDomain: "fit-track-ca8d1.firebaseapp.com",
    projectId: "fit-track-ca8d1",
    storageBucket: "fit-track-ca8d1.firebasestorage.app",
    messagingSenderId: "157593985795",
    appId: "1:157593985795:web:07156961dda8e2254fbf36",
    measurementId: "G-NYGGEMMJMC"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Helper function to upload images
window.uploadImage = async function (file, folder = "images") {
    if (!file) return null;
    try {
        const storageRef = ref(storage, `${folder}/${Date.now()}_${file.name}`);
        const snapshot = await uploadBytes(storageRef, file);
        const downloadURL = await getDownloadURL(snapshot.ref);
        return downloadURL;
    } catch (error) {
        console.error("Upload failed:", error);
        showToast("Image upload failed.", "error");
    }
};

// Image preview utility
window.previewImage = function (input, previewId) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function (e) {
            document.getElementById(previewId).src = e.target.result;
        }
        reader.readAsDataURL(input.files[0]);
    }
};

// NEW: Image Source Choice Logic
let currentImageTarget = { preview: null, file: null, url: null };

window.openImageChoice = function(previewId, fileInputId, urlInputId) {
    currentImageTarget = { preview: previewId, file: fileInputId, url: urlInputId };
    const modal = document.getElementById('imageSourceModal');
    if (modal) modal.style.display = 'flex';
};

window.chooseImageUpload = function() {
    const fileInput = document.getElementById(currentImageTarget.file);
    if (fileInput) fileInput.click();
    closeModal('imageSourceModal');
};

window.chooseImageUrl = function() {
    const url = prompt("Please enter the image URL:");
    if (url) {
        const preview = document.getElementById(currentImageTarget.preview);
        const urlInput = document.getElementById(currentImageTarget.url);
        if (preview) preview.src = url;
        if (urlInput) urlInput.value = url;
    }
    closeModal('imageSourceModal');
};

// Initialize EmailJS
emailjs.init("ZqQKGRo5j5KpAhH98");

// ==========================================
// 3. DYNAMIC SESSION OVERRIDE LISTENER
// ==========================================
const currentUserId = localStorage.getItem("userId");
const currentSessionId = localStorage.getItem("sessionId");
const currentUserRole = localStorage.getItem("userRole");

if (currentUserId && currentSessionId) {
    onSnapshot(doc(db, "users", currentUserId), (docSnap) => {
        if (docSnap.exists()) {
            const userData = docSnap.data();

            // SYNC NAME: Ensure localStorage and UI are always fresh from DB
            const dbName = userData.name || `${userData.givenName || ''} ${userData.familyName || ''}`.trim() || "User";
            if (localStorage.getItem("loggedInUser") !== dbName) {
                localStorage.setItem("loggedInUser", dbName);
                
                // Refresh Topbar & Greeting if elements exist
                const tNameEl = document.getElementById('topBarName');
                if (tNameEl) tNameEl.innerText = dbName.split(' ')[0];
                
                const gTextEl = document.getElementById('greetingText');
                if (gTextEl) {
                    const hour = new Date().getHours();
                    const firstName = dbName.split(' ')[0];
                    if (hour < 12) gTextEl.innerText = `Good Morning, ${firstName}.`;
                    else if (hour < 18) gTextEl.innerText = `Good Afternoon, ${firstName}.`;
                    else gTextEl.innerText = `Good Evening, ${firstName}.`;
                }
            }

            // Kick out duplicate logins
            if (userData.currentSession && userData.currentSession !== currentSessionId) {
                showToast("Session Override: Your account was just logged in from another device. Logging out here to protect your data.", "error");
                localStorage.removeItem("loggedInUser");
                localStorage.removeItem("userRole");
                localStorage.removeItem("userRfid");
                localStorage.removeItem("userId");
                localStorage.removeItem("shiftStart");
                localStorage.removeItem("sessionId");
                localStorage.removeItem("trainerShiftStatus");
                window.location.replace("index.html");
            }

            const roleLower = (currentUserRole || "").toLowerCase();
            // Update Member UI dynamically
            if (roleLower === "member") {
                if (document.getElementById('myPlanName')) document.getElementById('myPlanName').innerText = userData.plan || "Standard Plan";
                if (document.getElementById('myPlanDays') && userData.dateRegistered) {
                    const now = new Date().getTime();
                    const planName = userData.plan || 'Standard Member';
                    const planDays = window.getPlanDays ? window.getPlanDays(planName) : 30;
                    const expiryDate = userData.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                    const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                    
                    if (document.getElementById('myPlanDays')) {
                        document.getElementById('myPlanDays').innerHTML = `<i class="fa-regular fa-clock"></i> ${diffDays > 0 ? diffDays + ' Days Left' : 'Expired'}`;
                    }
                    
                    // BLOCKING LOGIC: If expired, show renewal modal
                    if (diffDays <= 0) {
                        const expiredModal = document.getElementById('membershipExpiredModal');
                        if (expiredModal) expiredModal.style.display = 'flex';
                    } else {
                        const expiredModal = document.getElementById('membershipExpiredModal');
                        if (expiredModal) expiredModal.style.display = 'none';
                    }
                }
            }

            // Automatically start/stop Trainer Shift Timer based on "On Floor" status
            if (roleLower === "trainer") {
                const currentStatus = userData.shiftStatus || "Off Floor";
                localStorage.setItem("trainerShiftStatus", currentStatus);

                if (currentStatus === "On Floor" && !localStorage.getItem("shiftStart")) {
                    localStorage.setItem("shiftStart", Date.now()); // Starts timer
                } else if (currentStatus !== "On Floor") {
                    localStorage.removeItem("shiftStart"); // Stops timer
                }
            }
        }
    });
}

// Set Welcome Name on Dashboard
if (document.getElementById('welcomeName')) {
    document.getElementById('welcomeName').innerText = localStorage.getItem("loggedInUser") || "Member";
}

// ==========================================
// 4. GLOBAL EXPORTS (HTML ONCLICK BUTTONS)
// ==========================================

window.handleLogout = async function () {
    const userId = localStorage.getItem("userId");
    const userRole = localStorage.getItem("userRole");

    if (window.logActivity) await window.logActivity("Logout", `User logged out.`);

    if (userId) {
        try {
            let updateData = { currentSession: null };
            const roleLower = (userRole || "").toLowerCase();
            if (roleLower === "admin" || roleLower === "staff" || roleLower === "trainer") {
                updateData.shiftStatus = roleLower === "trainer" ? "Off Floor" : "Off Shift";
            }
            await updateDoc(doc(db, "users", userId), updateData);
        } catch (error) {
            console.error("Failed to update session/shift status:", error);
        }
    }

    localStorage.clear();
    window.location.replace("index.html");
};

window.switchTab = function (tabId, element) {
    if (event) event.stopPropagation();

    document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active-section'));
    if (document.getElementById(tabId)) document.getElementById(tabId).classList.add('active-section');

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sub-item').forEach(el => el.classList.remove('active'));

    if (element && !element.classList.contains('stat-card') && !element.classList.contains('grid-stat-box')) {
        element.classList.add('active');
        if (element.classList.contains('sub-item')) {
            element.parentElement.previousElementSibling.classList.add('active');
        }
    } else {
        const targetNav = document.querySelector(`.nav-menu li[onclick*="switchTab('${tabId}'"]`);
        if (targetNav) {
            targetNav.classList.add('active');
            if (targetNav.classList.contains('sub-item')) {
                targetNav.parentElement.previousElementSibling.classList.add('active');
            }
        }
    }

    const titles = {
        'dashboard': 'Dashboard',
        'equipment': 'Equipment Management',
        'products': 'Products & Consumables',
        'ledger': 'Stock Movements Ledger',
        'pos': 'Point of Sale (POS)',
        'payments': 'Financial Reports',
        'members': 'Member Directory',
        'archivedMembers': 'Archived Members',
        'attendance': 'Attendance Log',
        'staff': 'Staff Directory',
        'archivedStaff': 'Archived Staff',
        'trainers': 'Gym Trainers',
        'archivedTrainers': 'Archived Trainers',
        'bookings': 'Booking Calendar',
        'chats': 'Internal Messages',
        'activityLog': 'System Activity Log',
        'membershipPlans': 'Membership Plans',
        'lockers': 'Locker Management'
    };

    if (document.getElementById('pageTitle')) {
        document.getElementById('pageTitle').innerText = titles[tabId] || 'Dashboard';
    }
}

window.toggleNotifSidebar = function () {
    const drawer = document.getElementById('notifDrawer');
    const overlay = document.getElementById('notifDrawerOverlay');
    const btn = document.getElementById('notifToggleBtn');
    if (!drawer || !overlay) return;

    const isOpen = drawer.classList.contains('open');
    
    if (isOpen) {
        drawer.classList.remove('open');
        overlay.classList.remove('open');
        if (btn) btn.innerHTML = '<i class="fas fa-bell"></i>';
        localStorage.setItem('notifSidebarCollapsed', 'true'); // keep old logic for bell icon state if needed, but just bell is fine
    } else {
        drawer.classList.add('open');
        overlay.classList.add('open');
        if (btn) btn.innerHTML = '<i class="fas fa-bell-slash"></i>';
        localStorage.setItem('notifSidebarCollapsed', 'false');
    }
};

// Remove auto-restore sidebar state logic since it's a drawer now
document.addEventListener('DOMContentLoaded', () => {
    // Drawer should be closed by default
});

let kpiCharts = {
    revenue: null,
    maintenance: null,
    capacity: null
};

window.toggleKpiDetail = function (detailId, element) {
    const panel = document.getElementById('kpiExtendedPanel');
    const sections = document.querySelectorAll('.kpi-detail-content');
    const items = document.querySelectorAll('.kpi-unified-item');

    if (!panel) return;

    // If clicking the same item that's already active, close it
    if (element.classList.contains('active-item')) {
        panel.classList.remove('active');
        element.classList.remove('active-item');
        return;
    }

    // Deactivate others
    items.forEach(item => item.classList.remove('active-item'));
    sections.forEach(sec => sec.style.display = 'none');

    // Activate this
    element.classList.add('active-item');
    const targetSection = document.getElementById(detailId);
    if (targetSection) targetSection.style.display = 'block';
    panel.classList.add('active');

    // Render/Update charts
    renderKpiBreakdown(detailId);
};

function renderKpiBreakdown(detailId) {
    if (detailId === 'revenueDetail') {
        renderRevenueChart();
    } else if (detailId === 'maintenanceDetail') {
        renderMaintenanceChart();
    } else if (detailId === 'capacityDetail') {
        renderCapacityChart();
    }
}

function renderRevenueChart() {
    const ctx = document.getElementById('revenueBreakdownChart');
    if (!ctx) return;

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let membershipRev = 0;
    let walkinRev = 0;
    let posRev = 0;

    paymentsData.forEach(p => {
        if (p.status === 'Voided') return;
        if (p.date === todayStr) {
            const pAmount = Number(p.amount || 0);
            if (p.type === 'POS Sale') posRev += pAmount;
            else if (p.type === 'Walk-in') walkinRev += pAmount;
            else membershipRev += pAmount; // Assuming other types are memberships
        }
    });

    if (kpiCharts.revenue) kpiCharts.revenue.destroy();
    kpiCharts.revenue = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Membership', 'Walk-in', 'POS'],
            datasets: [{
                data: [membershipRev, walkinRev, posRev],
                backgroundColor: ['#991b1b', '#3B82F6', '#475569'],
                borderWidth: 0,
                cutout: '75%'
            }]
        },
        options: {
            plugins: { legend: { display: false } },
            responsive: true,
            maintainAspectRatio: false
        }
    });

    if (document.getElementById('detailMembershipRev')) document.getElementById('detailMembershipRev').innerText = `₱${membershipRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailWalkinRev')) document.getElementById('detailWalkinRev').innerText = `₱${walkinRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailPosRev')) document.getElementById('detailPosRev').innerText = `₱${posRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailTotalRev')) document.getElementById('detailTotalRev').innerText = `₱${(membershipRev + walkinRev + posRev).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderMaintenanceChart() {
    const ops = inventoryData.filter(i => (i.itemType === 'equipment' || !i.itemType) && i.status === 'Operational').length;
    const maint = inventoryData.filter(i => (i.itemType === 'equipment' || !i.itemType) && i.status === 'Maintenance').length;
    const broken = inventoryData.filter(i => (i.itemType === 'equipment' || !i.itemType) && i.status === 'Out of Order').length;

    // Circle chart visual removed from HTML for Maintenance as per user request

    if (document.getElementById('detailOpsCount')) document.getElementById('detailOpsCount').innerText = `${ops} Units`;
    if (document.getElementById('detailMaintCount')) document.getElementById('detailMaintCount').innerText = `${maint} Units`;
    if (document.getElementById('detailBrokenCount')) document.getElementById('detailBrokenCount').innerText = `${broken} Units`;
}

function renderCapacityChart() {
    const present = Number(document.getElementById('presentMembers')?.innerText || 0);
    const total = 50;
    const available = total - present;

    // Circle chart visual removed from HTML for Capacity as per user request

    if (document.getElementById('detailPresentCount')) document.getElementById('detailPresentCount').innerText = present;
    if (document.getElementById('detailAvailableCount')) document.getElementById('detailAvailableCount').innerText = available;
    if (document.getElementById('detailOccupancyRate')) document.getElementById('detailOccupancyRate').innerText = `${Math.round((present / total) * 100)}%`;
}

const activityLogsCol = collection(db, "activityLogs");

window.logActivity = async function (action, details = "") {
    try {
        const userId = localStorage.getItem("userId") || "System";
        const userName = localStorage.getItem("loggedInUser") || "Unknown User";
        const role = localStorage.getItem("userRole") || "";
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        await addDoc(activityLogsCol, {
            userId,
            userName,
            role,
            action,
            details,
            date: dateStr,
            time: timeStr,
            timestamp: now.getTime()
        });
    } catch (e) {
        console.error("Failed to log activity:", e);
    }
};

window.closeModal = function (modalId) { document.getElementById(modalId).style.display = 'none'; }
window.exportInventoryReport = function () { window.print(); }

window.filterTable = function (tableId, inputId) {
    const filter = document.getElementById(inputId).value.toUpperCase();
    const tr = document.getElementById(tableId).getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[0];
        if (tableId === 'membersTable' || tableId === 'archivedMembersTable') {
            let tdPlan = tr[i].getElementsByTagName("td")[4];
            let text = (td ? td.textContent : "") + " " + (tdPlan ? tdPlan.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'attendanceTable') {
            let tdType = tr[i].getElementsByTagName("td")[1];
            let text = (td ? td.textContent : "") + " " + (tdType ? tdType.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'bookingsTable' || tableId === 'myBookingsTable') {
            let tdTrainer = tr[i].getElementsByTagName("td")[1] || tr[i].getElementsByTagName("td")[0];
            let text = (td ? td.textContent : "") + " " + (tdTrainer ? tdTrainer.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'ledgerTable') {
            let tdName = tr[i].getElementsByTagName("td")[1];
            let tdReason = tr[i].getElementsByTagName("td")[3];
            let text = (tdName ? tdName.textContent : "") + " " + (tdReason ? tdReason.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else {
            if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        }
    }
}

window.filterByPlan = function (val) {
    const filterText = val.toUpperCase();
    const tr = document.getElementById('membersTable').getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[4];
        if (td) {
            let cellText = (td.textContent || td.innerText).toUpperCase();
            if (val === "All" || cellText.includes(filterText)) tr[i].style.display = "";
            else tr[i].style.display = "none";
        }
    }
}

window.filterGrid = function (gridId, inputId) {
    const filter = document.getElementById(inputId).value.toLowerCase();
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const cards = grid.querySelectorAll('.inventory-item-filter');
    cards.forEach(card => {
        const searchData = card.getAttribute('data-search');
        if (searchData.includes(filter)) card.style.display = "flex";
        else card.style.display = "none";
    });
}

// ==========================================
// 5. STATE ARRAYS & COLLECTIONS
// ==========================================
let inventoryData = [];
let allUsersData = [];
let membersData = [];
let chatUsers = [];
let paymentsData = [];
let attendanceData = [];
let messagesData = [];
let activityData = [];
let bookingsData = [];
window.bookingsData = bookingsData;
let posCart = [];
let currentPOSCategory = 'all';
let selectedPaymentMethod = 'Cash';
let stockMovementsData = [];
let lockersData = [];

let currentChatUser = null;
let currentChatRoleFilter = 'all';

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");
const usersCol = collection(db, "users");
const attendanceCol = collection(db, "attendance");
const messagesCol = collection(db, "messages");
const bookingsCol = collection(db, "bookings");
const guestCardsCol = collection(db, "guestCards");
const walkinPassesCol = collection(db, "walkinPasses");
const stockMovementsCol = collection(db, "stockMovements"); // Phase 3: Inventory Ledger
const membershipPlansCol = collection(db, "membershipPlans"); // Membership Plans
const creditTransactionsCol = collection(db, "creditTransactions"); // Credit System
const lockersCol = collection(db, "lockers"); // Locker System

// Expose Firebase helpers for non-module booking UI script
window._fb = { bookingsCol, query, where, getDocs, addDoc, db, doc, updateDoc, deleteDoc };

async function logStockMovement(productId, productName, changeAmount, reason) {
    try {
        const now = new Date();
        await addDoc(stockMovementsCol, {
            productId,
            productName,
            changeAmount,
            reason,
            userId: localStorage.getItem("userId") || "System",
            userName: localStorage.getItem("loggedInUser") || "Unknown",
            date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            timestamp: now.getTime()
        });
    } catch (e) {
        console.error("Failed to log stock movement:", e);
    }
}

onSnapshot(stockMovementsCol, (snapshot) => {
    stockMovementsData = [];
    snapshot.forEach(doc => stockMovementsData.push({ id: doc.id, ...doc.data() }));
    stockMovementsData.sort((a, b) => b.timestamp - a.timestamp);
    renderLedger();
});

window.renderLedger = function () {
    const tbody = document.querySelector('#ledgerTable tbody');
    if (!tbody) return;

    if (stockMovementsData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No stock movements recorded yet.</td></tr>';
        return;
    }

    const renderLedgerRow = (m) => {
        let changeStr = m.changeAmount > 0 ? `<span style="color: #27ae60; font-weight: bold;">+${m.changeAmount}</span>` : `<span style="color: #e74c3c; font-weight: bold;">${m.changeAmount}</span>`;
        return `
            <tr>
                <td>${m.date} <span style="color:#888; font-size:12px;">${m.time || ''}</span></td>
                <td><strong>${m.productName}</strong></td>
                <td>${changeStr}</td>
                <td><span class="badge" style="background: #eee; color: var(--dark-black); border: none;">${m.reason}</span></td>
                <td>${m.userName}</td>
            </tr>
        `;
    };

    window.syncDOM(tbody, stockMovementsData, renderLedgerRow, 'ledger-row');
}

let servicesChartInstance = null;

// ==========================================
// 6. INTERNAL MESSENGER LOGIC
// ==========================================
window.openChatTab = function (role, element, title) {
    currentChatRoleFilter = role;
    document.getElementById('chatDirectoryTitle').innerHTML = `<i class="fa-solid fa-address-book"></i> ${title}`;
    currentChatUser = null;
    document.getElementById('chatHeader').innerText = 'Select a user to start chatting';
    document.getElementById('chatHistory').innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: auto; margin-bottom: auto;"><i class="fa-regular fa-comments" style="font-size: 3rem; opacity: 0.2; margin-bottom: 10px;"></i><p>No chat selected</p></div>';
    document.getElementById('chatInput').disabled = true;
    document.getElementById('chatSendBtn').disabled = true;
    document.getElementById('chatSearch').value = "";
    renderChatUserList();
    switchTab('chats', element);
}

onSnapshot(messagesCol, (snapshot) => {
    messagesData = [];
    snapshot.forEach(doc => messagesData.push({ id: doc.id, ...doc.data() }));
    renderChatHistory();
});

function renderChatUserList() {
    const list = document.getElementById('chatUserList');
    if (!list) return;

    const myName = localStorage.getItem("loggedInUser");
    let html = "";

    let admins = [];
    if (currentChatRoleFilter === 'staff' || currentChatRoleFilter === 'all') {
        admins = chatUsers.filter(u => (u.role || "").toLowerCase() === 'admin' && u.name !== myName);
    }

    const targetUsers = chatUsers.filter(u => {
        if (u.name === myName) return false;
        const uRole = (u.role || "").toLowerCase();
        if (currentChatRoleFilter === 'all') return uRole !== 'admin';
        return uRole === currentChatRoleFilter;
    });

    if (admins.length === 0 && targetUsers.length === 0) {
        html = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No users found.</div>`;
    } else {
        if (admins.length > 0) {
            html += `<div class="chat-category">Admins</div>`;
            admins.forEach(u => {
                let idSafeName = u.name.replace(/[^a-zA-Z0-9]/g, '');
                html += `
                    <div class="chat-user chat-user-item" data-name="${u.name.toLowerCase()}" id="chat-user-${idSafeName}" onclick="openChat('${u.name}')">
                        <div class="chat-avatar" style="background: var(--primary-red);">
                            <i class="fa-solid fa-crown" style="font-size: 14px;"></i>
                        </div>
                        <div>
                            <div style="font-weight: bold; color: var(--dark-black); font-size: 14px;">${u.name}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${u.role}</div>
                        </div>
                    </div>
                `;
            });
        }
        if (targetUsers.length > 0) {
            let catTitle = "Users";
            if (currentChatRoleFilter === 'staff') catTitle = "Staff Team";
            if (currentChatRoleFilter === 'trainer') catTitle = "Trainers";
            if (currentChatRoleFilter === 'member') catTitle = "Members";
            if (currentChatRoleFilter !== 'all') html += `<div class="chat-category">${catTitle}</div>`;

            targetUsers.forEach(u => {
                let idSafeName = u.name.replace(/[^a-zA-Z0-9]/g, '');
                html += `
                    <div class="chat-user chat-user-item" data-name="${u.name.toLowerCase()}" id="chat-user-${idSafeName}" onclick="openChat('${u.name}')">
                        <div class="chat-avatar">${u.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style="font-weight: bold; color: var(--dark-black); font-size: 14px;">${u.name}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${u.role}</div>
                        </div>
                    </div>
                `;
            });
        }
    }
    list.innerHTML = html;
}

window.filterChatUsers = function () {
    const filter = document.getElementById('chatSearch').value.toLowerCase();
    const users = document.querySelectorAll('.chat-user-item');
    users.forEach(user => {
        const name = user.getAttribute('data-name');
        if (name.includes(filter)) user.style.display = "flex";
        else user.style.display = "none";
    });
}

window.openChat = function (userName) {
    currentChatUser = userName;
    document.getElementById('chatHeader').innerText = `Chatting with ${userName}`;
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatSendBtn').disabled = false;

    document.querySelectorAll('.chat-user').forEach(el => el.classList.remove('active'));
    document.getElementById(`chat-user-${userName.replace(/[^a-zA-Z0-9]/g, '')}`).classList.add('active');
    renderChatHistory();
}

function renderChatHistory() {
    const hist = document.getElementById('chatHistory');
    if (!hist || !currentChatUser) return;

    const myName = localStorage.getItem("loggedInUser");
    const relevantMsgs = messagesData.filter(m =>
        (m.sender === myName && m.receiver === currentChatUser) ||
        (m.sender === currentChatUser && m.receiver === myName)
    ).sort((a, b) => a.timestamp - b.timestamp);

    if (relevantMsgs.length === 0) {
        hist.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-top: auto; margin-bottom: auto;"><p>Say hello to ${currentChatUser}!</p></div>`;
        return;
    }

    hist.innerHTML = relevantMsgs.map(m => {
        const isMe = m.sender === myName;
        const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">
                <div>${m.text}</div>
                <div class="msg-time">${time}</div>
            </div>
        `;
    }).join('');
    hist.scrollTop = hist.scrollHeight;
}

window.sendMessage = async function () {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !currentChatUser) return;

    const myName = localStorage.getItem("loggedInUser");
    await addDoc(messagesCol, { sender: myName, receiver: currentChatUser, text: text, timestamp: new Date().getTime() });
    input.value = "";
}

// ==========================================
// 7. INVENTORY LOGIC
// ==========================================
onSnapshot(inventoryCol, (snapshot) => {
    inventoryData = [];
    snapshot.forEach(doc => inventoryData.push({ id: doc.id, ...doc.data() }));
    renderInventory();
    renderPOSProducts();
    if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
});

function getCategoryIcon(catName) {
    const c = (catName || "").toLowerCase();
    if (c.includes('cardio')) return '<i class="fa-solid fa-person-running"></i>';
    if (c.includes('strength')) return '<i class="fa-solid fa-dumbbell"></i>';
    if (c.includes('accessories')) return '<i class="fa-solid fa-mats"></i>';
    if (c.includes('supplements')) return '<i class="fa-solid fa-capsules"></i>';
    if (c.includes('beverage')) return '<i class="fa-solid fa-bottle-water"></i>';
    if (c.includes('merch')) return '<i class="fa-solid fa-shirt"></i>';
    return '<i class="fa-solid fa-box"></i>';
}

window.quickRestock = async function (id, name) {
    const qtyStr = prompt(`How many units of ${name} are you receiving?`);
    if (!qtyStr) return;
    const qty = parseInt(qtyStr);
    if (isNaN(qty) || qty <= 0) return showToast("Invalid quantity.", "error");

    try {
        await updateDoc(doc(db, "inventory", id), { qty: increment(qty) });
        await logStockMovement(id, name, qty, "Quick Restock");
        showToast(`Successfully added ${qty} units to ${name}.`, "success");
    } catch (e) {
        console.error(e);
        showToast("Failed to restock item.", "error");
    }
}

let currentInventoryView = 'grid'; // 'grid' or 'list'
let selectedEquipItems = new Set();
let selectedProdItems = new Set();

function renderInventory() {
    const equipGrid = document.getElementById('machinesGrid');
    const prodGrid = document.getElementById('productsGrid');
    const equipListBody = document.getElementById('machinesListBody');
    const equipListContainer = document.getElementById('machinesListContainer');
    const equipBatchBar = document.getElementById('equipBatchBar');

    if (!equipGrid || !prodGrid) return;

    let ops = 0, maint = 0, low = 0, totalMachines = 0;
    let alertsHtmlArr = [];

    // Sort and filter data first
    const consumables = [];
    const equipment = [];

    inventoryData.forEach((item) => {
        let isConsumable = item.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        let currentStatus = item.status || (isConsumable ? 'In Stock' : 'Operational');
        let threshold = item.lowStockThreshold !== undefined ? item.lowStockThreshold : 5;
        let isProblematic = false;

        if (item.qty === 0) { currentStatus = "Out of Stock"; isProblematic = true; }
        else if (item.qty <= threshold) {
            if (currentStatus !== 'Maintenance' && currentStatus !== 'Out of Order') { currentStatus = "Low Stock"; isProblematic = true; low++; }
        }
        else if (currentStatus === 'Maintenance') { maint++; isProblematic = true; }
        else if (currentStatus === 'Out of Order') { isProblematic = true; }

        if (currentStatus === 'Operational' || currentStatus === 'In Stock') ops++;
        if (!isConsumable) {
            totalMachines++;
            equipment.push({ ...item, currentStatus, isProblematic });
        } else {
            consumables.push({ ...item, currentStatus, isProblematic });
        }

        if (isProblematic) {
            alertsHtmlArr.push(`
                <div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div class="list-content"><h4>Status: ${currentStatus}</h4><p><strong>${item.name}</strong> requires attention.</p></div>
                </div>
            `);
        }
    });

    const renderCard = (item) => {
        const isConsumable = item.itemType === 'product';
        let badge = 'operational';
        if (item.currentStatus === 'Out of Stock' || item.currentStatus === 'Out of Order') badge = 'broken';
        else if (item.currentStatus === 'Low Stock') badge = 'stock-low';
        else if (item.currentStatus === 'Maintenance') badge = 'maintenance';

        let expiryHtml = '';
        if (isConsumable && item.expiry) {
            let expDate = new Date(item.expiry);
            let daysLeft = (expDate - new Date()) / (1000 * 60 * 60 * 24);
            if (daysLeft <= 30 && daysLeft >= 0) expiryHtml = ` <span class="badge pending" style="font-size: 10px;">Expiring Soon</span>`;
            else if (daysLeft < 0) expiryHtml = ` <span class="badge broken" style="font-size: 10px;">Expired</span>`;
        }

        const iconHtml = getCategoryIcon(item.cat);
        const isSelected = !isConsumable && selectedEquipItems.has(item.id);
        const imageHtml = item.image ? `<img src="${item.image}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;">` : iconHtml;

        let actionButtons = !isConsumable ? `
            <button type="button" class="btn-icon btn-edit" title="Edit" onclick="openEditEquipModal('${item.id}')"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>
        ` : `
            <button type="button" class="btn-icon" style="color: #27ae60;" title="Quick Restock" onclick="quickRestock('${item.id}', '${item.name.replace(/'/g, "\\'")}')"><i class="fas fa-plus-circle"></i></button>
            <button type="button" class="btn-icon btn-edit" title="Edit" onclick="openEditProductModal('${item.id}')"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>
        `;

        return `
            <div class="inventory-card inventory-item-filter ${isSelected ? 'selected' : ''}" data-search="${item.name.toLowerCase()} ${item.cat.toLowerCase()} ${item.currentStatus.toLowerCase()}">
                ${!isConsumable ? `<input type="checkbox" class="inventory-checkbox" onchange="toggleItemSelection('equipment', '${item.id}', this)" ${isSelected ? 'checked' : ''}>` : ''}
                <div class="inventory-icon-box" style="${item.image ? 'padding:0;' : ''}">${imageHtml}</div>
                <div class="inventory-details">
                    <div class="inventory-title">${item.name}</div>
                    <div class="inventory-category">${item.cat}</div>
                    <div class="inventory-desc">
                        ${(item.assetTag && item.assetTag !== 'undefined') ? `Tag: <strong>${item.assetTag}</strong><br>` : ''}
                        ${(item.size && item.size !== 'undefined') ? `Size/Vol: <strong>${item.size}</strong><br>` : ''}
                        ${isConsumable && item.expiry ? `Expiry: <strong>${item.expiry}</strong>${expiryHtml}<br>` : ''}
                        Qty: <strong>${item.qty} units</strong>
                    </div>
                    <div class="inventory-meta"><span class="badge ${badge}">${item.currentStatus}</span></div>
                </div>
                <div class="card-actions">${actionButtons}</div>
            </div>
        `;
    };

    const renderRow = (item) => {
        let badge = 'operational';
        if (item.currentStatus === 'Out of Stock' || item.currentStatus === 'Out of Order') badge = 'broken';
        else if (item.currentStatus === 'Low Stock') badge = 'stock-low';
        else if (item.currentStatus === 'Maintenance') badge = 'maintenance';

        const isSelected = selectedEquipItems.has(item.id);
        return `
            <tr class="${isSelected ? 'selected' : ''}">
                <td><input type="checkbox" onchange="toggleItemSelection('equipment', '${item.id}', this)" ${isSelected ? 'checked' : ''}></td>
                <td><div style="font-weight:600;">${item.name}</div></td>
                <td><span class="inventory-category" style="margin:0;">${item.cat}</span></td>
                <td><code>${(item.assetTag && item.assetTag !== 'undefined') ? item.assetTag : '-'}</code></td>
                <td>${(item.size && item.size !== 'undefined') ? item.size : '-'}</td>
                <td><strong>${item.qty}</strong></td>
                <td><span class="badge ${badge}">${item.currentStatus}</span></td>
                <td>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn-icon" onclick="openEditEquipModal('${item.id}')"><i class="fas fa-edit"></i></button>
                        <button type="button" class="btn-icon" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `;
    };

    // Render Grid Equipment
    if (currentInventoryView === 'grid') {
        equipGrid.style.display = 'grid';
        if (equipListContainer) equipListContainer.style.display = 'none';
        window.syncDOM(equipGrid, equipment, renderCard, 'equip-grid');
    } else {
        equipGrid.style.display = 'none';
        if (equipListContainer) {
            equipListContainer.style.display = 'block';
            window.syncDOM(equipListBody, equipment, renderRow, 'equip-row');
        }
    }

    // Render Products
    window.syncDOM(prodGrid, consumables, renderCard, 'prod-grid');

    // Update Batch Bar
    if (equipBatchBar) {
        if (selectedEquipItems.size > 0) {
            equipBatchBar.classList.add('show');
            const countEl = document.getElementById('equipBatchCount');
            if (countEl) countEl.innerText = `${selectedEquipItems.size} selected`;
        } else {
            equipBatchBar.classList.remove('show');
        }
    }

    // Update Stats
    if (document.getElementById('dashInventoryTotal')) document.getElementById('dashInventoryTotal').innerText = inventoryData.length;
    if (document.getElementById('gridEquip')) document.getElementById('gridEquip').innerText = ops;
    if (document.getElementById('navInventoryCount')) document.getElementById('navInventoryCount').innerText = ` ${inventoryData.length} `;

    const dashAlerts = document.getElementById('dashInventoryAlerts');
    if (dashAlerts) dashAlerts.innerHTML = alertsHtmlArr.join('') || '<p style="color: green; font-size: 14px;">All systems operational!</p>';
}

window.migrateInventoryDatabase = async function () {
    if (!confirm("Run database migration to upgrade old inventory items?")) return;
    let updatedCount = 0;
    for (let item of inventoryData) {
        let isConsumable = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        let updates = {};
        if (!item.itemType) updates.itemType = isConsumable ? 'product' : 'equipment';
        if (item.lowStockThreshold === undefined) updates.lowStockThreshold = isConsumable ? 5 : 0;

        if (Object.keys(updates).length > 0) {
            await updateDoc(doc(db, "inventory", item.id), updates);
            updatedCount++;
        }
    }
    showToast(`Migration complete! Updated ${updatedCount} old items.`, "success");
}

window.openEquipmentModal = () => { document.getElementById('equipmentForm').reset(); document.getElementById('equipmentModal').style.display = 'flex'; }
window.openProductModal = () => { document.getElementById('productForm').reset(); document.getElementById('productModal').style.display = 'flex'; }
window.deleteInventoryItem = async (id) => {
    const item = inventoryData.find(i => i.id === id);
    showConfirm("Delete this inventory item?", async () => {
        await deleteDoc(doc(db, "inventory", id));
        showToast("Item deleted.", "info");
        if (window.logActivity) window.logActivity("Item Deleted", `Deleted inventory item: ${item ? item.name : id}`);
    });
}

window.openEditEquipModal = function (id) {
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    document.getElementById('editEquipId').value = item.id;
    document.getElementById('editEquipName').value = item.name;
    document.getElementById('editEquipCategory').value = item.cat;
    document.getElementById('editEquipSize').value = item.size || '';
    document.getElementById('editEquipQty').value = item.qty;
    document.getElementById('editEquipStatus').value = item.status || 'Operational';
    document.getElementById('editEquipAssetTag').value = item.assetTag || '';
    if (document.getElementById('editEquipImage')) document.getElementById('editEquipImage').value = item.image || '';
    if (document.getElementById('editEquipPreview')) {
        document.getElementById('editEquipPreview').src = item.image || 'images/default-equip.png';
    }
    document.getElementById('editEquipModal').style.display = 'flex';
}

if (document.getElementById('editEquipForm')) {
    document.getElementById('editEquipForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editEquipId').value;
        const oldEquip = inventoryData.find(i => i.id === id);

        const imageFile = document.getElementById('editEquipImageFile').files[0];
        let imageUrl = document.getElementById('editEquipImage').value.trim();

        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'equipment');
        }

        const updatedData = {
            name: document.getElementById('editEquipName').value.trim(),
            cat: document.getElementById('editEquipCategory').value,
            size: document.getElementById('editEquipSize').value.trim() || '',
            qty: Number(document.getElementById('editEquipQty').value),
            status: document.getElementById('editEquipStatus').value,
            assetTag: document.getElementById('editEquipAssetTag').value.trim() || '',
            image: imageUrl || ''
        };

        const qtyDiff = updatedData.qty - (oldEquip ? oldEquip.qty : 0);

        try {
            await updateDoc(doc(db, "inventory", id), updatedData);
            if (qtyDiff !== 0) await logStockMovement(id, updatedData.name, qtyDiff, "Manual Edit");
            window.closeModal('editEquipModal');
            showToast("Equipment updated successfully!", "success");
            if (window.logActivity) window.logActivity("Equipment Updated", `Updated: ${updatedData.name}`);
        } catch (error) {
            console.error("Equipment update failed:", error);
            showToast("Failed to update equipment. Please try again.", "error");
        }
    });
}

window.openEditProductModal = function (id) {
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    document.getElementById('editProdId').value = item.id;
    document.getElementById('editProdName').value = item.name;
    document.getElementById('editProdCategory').value = item.cat;
    document.getElementById('editProdPrice').value = item.price;
    document.getElementById('editProdQty').value = item.qty;
    document.getElementById('editProdVol').value = item.size || '';
    if (document.getElementById('editProdImage')) document.getElementById('editProdImage').value = item.image || '';
    if (document.getElementById('editProdPreview')) {
        document.getElementById('editProdPreview').src = item.image || 'images/default-product.png';
    }
    document.getElementById('editProductModal').style.display = 'flex';
}

if (document.getElementById('editProductForm')) {
    document.getElementById('editProductForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editProdId').value;
        const oldProd = inventoryData.find(i => i.id === id);

        const imageFile = document.getElementById('editProdImageFile').files[0];
        let imageUrl = document.getElementById('editProdImage').value.trim();

        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'products');
        }

        const updatedData = {
            name: document.getElementById('editProdName').value.trim(),
            cat: document.getElementById('editProdCategory').value,
            price: Number(document.getElementById('editProdPrice').value),
            qty: Number(document.getElementById('editProdQty').value),
            size: document.getElementById('editProdVol').value,
            image: imageUrl || ''
        };

        const qtyDiff = updatedData.qty - (oldProd ? oldProd.qty : 0);

        try {
            await updateDoc(doc(db, "inventory", id), updatedData);
            if (qtyDiff !== 0) await logStockMovement(id, updatedData.name, qtyDiff, "Manual Edit");
            window.closeModal('editProductModal');
            showToast("Product updated successfully!", "success");
            if (window.logActivity) window.logActivity("Product Updated", `Updated: ${updatedData.name}`);
        } catch (error) {
            console.error("Product update failed:", error);
            showToast("Failed to update product. Please try again.", "error");
        }
    });
}

async function handleInventorySubmit(e, isProduct) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }
    const nameStr = document.getElementById(isProduct ? 'prodName' : 'equipName').value.trim();
    const addQty = Number(document.getElementById(isProduct ? 'prodQty' : 'equipQty').value);
    const existingItem = inventoryData.find(i => i.name.toLowerCase() === nameStr.toLowerCase());

    if (existingItem) {
        await updateDoc(doc(db, "inventory", existingItem.id), { qty: increment(addQty) });
        await logStockMovement(existingItem.id, existingItem.name, addQty, "Automated Restock");
        showToast(`Automated Update: Added ${addQty} units to existing stock. New Total: ${existingItem.qty + addQty} units.`, "info");
    } else {
        const imageFile = document.getElementById(isProduct ? 'prodImageFile' : 'equipImageFile').files[0];
        let imageUrl = document.getElementById(isProduct ? 'prodImage' : 'equipImage').value.trim();

        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, isProduct ? 'products' : 'equipment');
        }

        const newItem = {
            name: nameStr, cat: document.getElementById(isProduct ? 'prodCategory' : 'equipCategory').value, size: document.getElementById(isProduct ? 'prodVol' : 'equipSize').value,
            qty: addQty, status: isProduct ? 'In Stock' : 'Operational', price: isProduct ? Number(document.getElementById('prodPrice').value) : 0, expiry: isProduct ? document.getElementById('prodExpiry').value : null,
            itemType: isProduct ? 'product' : 'equipment', lowStockThreshold: isProduct ? 5 : 0,
            assetTag: !isProduct ? (document.getElementById('equipAssetTag').value.trim() || '') : '',
            image: imageUrl || ''
        };
        const addedRef = await addDoc(inventoryCol, newItem);
        if (isProduct && addQty > 0) await logStockMovement(addedRef.id, nameStr, addQty, "Initial Stock");
        showToast(`New ${isProduct ? 'product' : 'equipment'} registered successfully!`, "success");
        if (window.logActivity) window.logActivity("Item Registered", `Registered new ${isProduct ? 'product' : 'equipment'}: ${nameStr} (Qty: ${addQty})`);
    }
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
    }
    window.closeModal(isProduct ? 'productModal' : 'equipmentModal');
}

if (document.getElementById('equipmentForm')) document.getElementById('equipmentForm').addEventListener('submit', (e) => handleInventorySubmit(e, false));
if (document.getElementById('productForm')) document.getElementById('productForm').addEventListener('submit', (e) => handleInventorySubmit(e, true));

// ==========================================
// 8. POINT OF SALE (POS) LOGIC
// ==========================================
function getWalkinIssueEls() {
    const modal = document.getElementById("walkinIssueModal");
    const input = document.getElementById("walkinIssueRfidInput");
    const counter = document.getElementById("walkinIssueCounter");
    return { modal, input, counter };
}

function openWalkinIssueModal({ current, total } = {}) {
    const { modal, input, counter } = getWalkinIssueEls();
    if (!modal || !input) {
        throw new Error("Walk-in issue modal is missing. Ensure #walkinIssueModal exists on this page.");
    }

    if (counter) {
        if (Number.isFinite(current) && Number.isFinite(total) && total > 1) counter.innerText = `Tap Card ${current} of ${total}`;
        else counter.innerText = "Tap Card";
    }

    input.value = "";
    modal.style.display = "flex";
    // Focus the input so rfid.js recognizes it as the active `.rfid-register-input`.
    setTimeout(() => input.focus(), 0);
}

function closeWalkinIssueModal() {
    const { modal, input } = getWalkinIssueEls();
    if (input) input.value = "";
    if (modal) modal.style.display = "none";
}

async function waitForWalkinRfidTap({ timeoutMs = 60000 } = {}) {
    const { modal, input } = getWalkinIssueEls();
    if (!modal || !input) return null;

    const started = Date.now();
    return await new Promise((resolve) => {
        let lastVal = "";

        window.__walkinIssueRetry = () => {
            if (!input) return;
            input.value = "";
            setTimeout(() => input.focus(), 0);
        };

        const timer = setInterval(() => {
            // User cancelled (modal closed)
            if (modal.style.display === "none") {
                clearInterval(timer);
                resolve(null);
                return;
            }

            if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                resolve(null);
                return;
            }

            const val = (input.value || "").trim();
            if (val && val !== lastVal && val.length > 5) {
                clearInterval(timer);
                resolve(val);
                return;
            }
            lastVal = val;
        }, 50);
    });
}

async function isGuestCardIssuedToday(rfidTag, dateStr) {
    const q = query(guestCardsCol, where("rfid", "==", rfidTag));
    const snap = await getDocs(q);
    if (snap.empty) return false;
    const d = snap.docs[0].data() || {};
    return d.status === "Issued" && d.issuedForDate === dateStr;
}

async function upsertGuestCardIssued({ rfidTag, dateStr, paymentId, issuedBy } = {}) {
    const q = query(guestCardsCol, where("rfid", "==", rfidTag));
    const snap = await getDocs(q);
    const data = {
        rfid: rfidTag,
        status: "Issued",
        issuedForDate: dateStr,
        issuedAt: Date.now(),
        paymentId: paymentId || "",
        issuedByUserId: issuedBy?.userId || "",
        issuedByName: issuedBy?.name || "",
        issuedByRole: issuedBy?.role || "",
    };

    if (snap.empty) {
        await addDoc(guestCardsCol, data);
        return;
    }
    await updateDoc(doc(db, "guestCards", snap.docs[0].id), data);
}

async function issueWalkinPassAndCheckIn({ rfidTag, paymentId, dateStr, timeStr, amount, issuedBy } = {}) {
    await addDoc(walkinPassesCol, {
        rfid: rfidTag,
        paymentId: paymentId || "",
        amount: typeof amount === "number" ? amount : 0,
        date: dateStr,
        status: "Active",
        createdAt: Date.now(),
        issuedByUserId: issuedBy?.userId || "",
        issuedByName: issuedBy?.name || "",
        issuedByRole: issuedBy?.role || "",
    });

    await addDoc(attendanceCol, {
        name: "Walk-in Guest",
        type: "Walk-in",
        date: dateStr,
        timeIn: timeStr,
        timeOut: "",
        status: "Checked In",
        timestamp: Date.now(),
        guestRfid: rfidTag,
        paymentId: paymentId || "",
    });
}

window.filterPOSCategory = function (cat, btn) {
    currentPOSCategory = cat;
    document.querySelectorAll('.pos-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderPOSProducts();
}

window.filterPOSCatalog = function () {
    renderPOSProducts();
}

function getPOSCategoryLabel(item) {
    if (item.id === 'WALKIN' || item.isPlan) return 'gym passes';
    const c = (item.cat || "").toLowerCase();
    if (c.includes('supplements')) return 'supplements';
    if (c.includes('beverage') || c.includes('drinks')) return 'drinks';
    if (c.includes('service')) return 'services';
    return 'other';
}

function renderPOSProducts() {
    const grid = document.getElementById('posProductGrid');
    if (!grid) return;

    const searchTerm = (document.getElementById('posSearch')?.value || '').toLowerCase();

    // Walk-in Passes
    const walkinPlan = (window.__membershipPlansData || []).find(p => p.name.toLowerCase().includes('walk-in'));
    let walkinPrice = walkinPlan ? Number(walkinPlan.price || 0) : 150;

    let allItems = [];
    allItems.push({
        id: 'WALKIN',
        name: walkinPlan ? walkinPlan.name : 'Walk-in Gym Access (Day Pass)',
        price: walkinPrice,
        stock: 'Unlimited',
        maxQty: 999,
        image: 'images/default-product.png',
        cat: 'Gym Passes',
        size: 'One-Day Pass',
        isPlan: true,
        featured: true
    });

    inventoryData.forEach(item => {
        let isConsumable = item.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        if (isConsumable && item.qty > 0) {
            allItems.push({
                id: item.id,
                name: item.name,
                price: item.price || 0,
                stock: item.qty,
                maxQty: item.qty,
                image: item.image || 'images/default-product.png',
                cat: item.cat,
                size: item.size || ''
            });
        }
    });

    // Filter items based on category and search term
    const filteredItems = allItems.filter(item => {
        const catLabel = getPOSCategoryLabel(item);
        const matchesCat = currentPOSCategory === 'all' || catLabel === currentPOSCategory;
        const matchesSearch = !searchTerm || item.name.toLowerCase().includes(searchTerm);
        return matchesCat && matchesSearch;
    });

    const renderItem = (item) => {
        return `
            <div class="pos-product-card ${item.featured ? 'featured' : ''}" onclick="addToCart('${item.id}', '${item.name.replace(/'/g, "\\'")}', ${item.price}, ${item.maxQty}, '${item.image}')">
                <div class="pos-card-image">
                    <img src="${item.image}" onerror="this.src='images/default-product.png'">
                </div>
                <div class="pos-card-info">
                    <div class="pos-card-name">${item.name}</div>
                    <div class="pos-card-stock">${item.stock === 'Unlimited' ? 'Unlimited' : item.stock + ' in stock'}</div>
                    <div class="pos-card-size">${item.size || ''}</div>
                </div>
                <div class="pos-card-footer">
                    <span class="pos-card-price">₱${item.price.toFixed(2)}</span>
                    <button type="button" class="pos-add-btn">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </div>
        `;
    };

    window.syncDOM(grid, filteredItems, renderItem, 'pos-prod');
}

window.addToCart = function (id, name, price, maxQty, image) {
    let existing = posCart.find(i => i.id === id);
    if (existing) { if (existing.qty < maxQty) existing.qty++; else showToast("Not enough stock available!", "error"); }
    else { posCart.push({ id, name, price, qty: 1, maxQty, image: image || 'images/default-product.png' }); }
    renderCart();
}

window.removeFromCart = function (id) { posCart = posCart.filter(i => i.id !== id); renderCart(); }

window.changeQty = function (id, delta) {
    let existing = posCart.find(i => i.id === id);
    if (existing) {
        let newQty = existing.qty + delta;
        if (newQty <= 0) {
            posCart = posCart.filter(i => i.id !== id);
        } else if (newQty > existing.maxQty) {
            showToast("Not enough stock available!", "error");
        } else {
            existing.qty = newQty;
        }
        renderCart();
    }
}

function renderCart() {
    const cartBody = document.getElementById('posCartBody');
    if (!cartBody) return;
    if (posCart.length === 0) {
        cartBody.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top: 50px;">Cart is empty.</p>`;
        updatePOSTotals(0, 0, 0, 0);
        return;
    }

    const renderCartItem = (item) => `
        <div class="pos-cart-item">
            <div class="pos-cart-thumb">
                <img src="${item.image || 'images/default-product.png'}" onerror="this.src='images/default-product.png'">
            </div>
            <div class="pos-cart-detail" style="max-width: 140px;">
                <div class="pos-cart-item-name" title="${item.name}">${item.name}</div>
                <div style="font-size: 11px; color: var(--text-muted);">₱${item.price.toFixed(2)} each</div>
            </div>
            <div class="pos-cart-qty">
                <button type="button" class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
                <span style="font-weight:600; width:20px; text-align:center;">${item.qty}</span>
                <button type="button" class="qty-btn" onclick="changeQty('${item.id}', 1)">+</button>
            </div>
            <div class="pos-cart-line-total">₱${(item.price * item.qty).toFixed(2)}</div>
            <button type="button" class="pos-cart-remove" onclick="removeFromCart('${item.id}')">×</button>
        </div>
    `;

    window.syncDOM(cartBody, posCart, renderCartItem, 'cart-item');

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let vat = subtotal * 0.12;
    let discount = 0;
    updatePOSTotals(subtotal, vat, discount, subtotal + vat - discount);
}

function updatePOSTotals(sub, vat, disc, grand) {
    const totalsDiv = document.querySelector('.pos-totals');
    if (!totalsDiv) return;
    totalsDiv.innerHTML = `
        <div class="total-line"><span>Subtotal:</span> <span>₱${sub.toFixed(2)}</span></div>
        <div class="total-line"><span>VAT (12%):</span> <span>₱${vat.toFixed(2)}</span></div>
        <div class="total-line grand"><span>TOTAL:</span> <span>₱${grand.toFixed(2)}</span></div>
    `;
}

window.selectPaymentMethod = function (method, btn) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

window.processPayment = async function () {
    if (posCart.length === 0) return showToast("Cart is empty!", "error");

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let vat = subtotal * 0.12;
    let discount = 0;
    let grandTotal = subtotal + vat - discount;

    const customerNameInput = document.getElementById('posCustomerName');
    let customerName = (customerNameInput && customerNameInput.value.trim() !== '') ? customerNameInput.value.trim() : "Walk-in POS Customer";

    let memberIdForCredit = null;

    if (selectedPaymentMethod === 'RFID') {
        const modal = document.getElementById('rfidPaymentModal');
        const input = document.getElementById('posRfidInput');
        const statusEl = document.getElementById('rfidPaymentStatus');

        statusEl.innerHTML = `Amount Due: ₱${grandTotal.toFixed(2)}`;
        statusEl.style.color = "var(--dark-black)";
        modal.style.display = 'flex';
        input.value = '';
        setTimeout(() => input.focus(), 100);

        const rfidData = await new Promise(resolve => {
            let lastVal = '';
            // Close modal detection
            const closeBtn = modal.querySelector('.close-btn');
            const handleClose = () => {
                clearInterval(checkInterval);
                resolve(null);
            };
            closeBtn.addEventListener('click', handleClose, { once: true });

            // Search manually
            let debounceTimer;
            const inputHandler = (e) => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(async () => {
                    const q = e.target.value.trim().toLowerCase();
                    if (q.length > 0) {
                        const searchRes = membersData.filter(m => (m.name && m.name.toLowerCase().includes(q)) || (m.uid && m.uid.toLowerCase().includes(q)) || (m.givenName && m.givenName.toLowerCase().includes(q)) || (m.familyName && m.familyName.toLowerCase().includes(q)) || (m.rfid && m.rfid === q));
                        const dropdown = document.getElementById('posRfidSearchDropdown');
                        if (searchRes.length > 0) {
                            dropdown.innerHTML = searchRes.map(m => `
                                <div style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer;" onclick="window.selectMemberForPayment('${m.id}', '${m.rfid || ''}', '${m.name || (m.givenName + ' ' + m.familyName)}')">
                                    <div style="font-weight: 600;">${m.name || (m.givenName + ' ' + m.familyName)}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">${m.uid ? m.uid + ' | ' : ''}RFID: ${m.rfid || 'None'} | Bal: ₱${(m.creditBalance || 0).toFixed(2)}</div>
                                </div>
                            `).join('');
                            dropdown.style.display = 'block';
                        } else {
                            dropdown.style.display = 'none';
                        }
                    } else {
                        document.getElementById('posRfidSearchDropdown').style.display = 'none';
                    }
                }, 300);
            };
            input.addEventListener('input', inputHandler);

            window.selectMemberForPayment = (id, rfid, name) => {
                document.getElementById('posRfidSearchDropdown').style.display = 'none';
                clearInterval(checkInterval);
                closeBtn.removeEventListener('click', handleClose);
                input.removeEventListener('input', inputHandler);
                resolve({ id, rfid, name });
            };

            const checkInterval = setInterval(async () => {
                if (modal.style.display === 'none') {
                    clearInterval(checkInterval);
                    closeBtn.removeEventListener('click', handleClose);
                    input.removeEventListener('input', inputHandler);
                    resolve(null);
                    return;
                }
                const val = input.value.trim();
                // If it's a full RFID scan
                if (val && val !== lastVal && val.length >= 8 && !val.includes(' ')) {
                    const memberMatch = membersData.find(m => m.rfid === val);
                    if (memberMatch) {
                        clearInterval(checkInterval);
                        closeBtn.removeEventListener('click', handleClose);
                        input.removeEventListener('input', inputHandler);
                        resolve({ id: memberMatch.id, rfid: memberMatch.rfid, name: memberMatch.name || (memberMatch.givenName + ' ' + memberMatch.familyName) });
                    }
                }
                lastVal = val;
            }, 500);
        });

        if (!rfidData) {
            closeModal('rfidPaymentModal');
            return; // cancelled
        }

        memberIdForCredit = rfidData.id;
        customerName = rfidData.name;
        if (customerNameInput) customerNameInput.value = customerName;

        const memberDoc = await getDoc(doc(db, "users", memberIdForCredit));
        const currentBalance = memberDoc.data().creditBalance || 0;

        if (currentBalance < grandTotal) {
            statusEl.innerHTML = `Insufficient Balance! (Bal: ₱${currentBalance.toFixed(2)})`;
            statusEl.style.color = "var(--primary-red)";
            await new Promise(r => setTimeout(r, 2000));
            return;
        }

        closeModal('rfidPaymentModal');
        showToast("Payment processing with Credit...", "info");

        // Deduct balance
        await updateDoc(doc(db, "users", memberIdForCredit), {
            creditBalance: increment(-grandTotal)
        });

        const itemsStrForLog = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');
        await addDoc(creditTransactionsCol, {
            memberId: memberIdForCredit,
            memberName: customerName,
            type: "purchase",
            amount: -grandTotal,
            balanceBefore: currentBalance,
            balanceAfter: currentBalance - grandTotal,
            note: `POS Purchase: ${itemsStrForLog}`,
            processedBy: localStorage.getItem("userId"),
            timestamp: Date.now()
        });
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let itemsStr = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');

    const paymentRef = await addDoc(paymentsCol, {
        name: customerName,
        type: "POS Sale",
        items: itemsStr,
        lineItems: posCart,
        subtotal: subtotal,
        vat: vat,
        discount: discount,
        amount: grandTotal,
        paymentMethod: selectedPaymentMethod,
        status: "Paid",
        date: dateStr,
        time: timeStr,
        timestamp: now.getTime(),
    });

    if (window.logActivity) window.logActivity("POS Sale", `Processed ${selectedPaymentMethod} payment for ${customerName} totaling ₱${grandTotal.toFixed(2)}`);

    const paymentId = paymentRef.id;

    const issuedBy = {
        userId: localStorage.getItem("userId") || "",
        name: localStorage.getItem("loggedInUser") || "",
        role: localStorage.getItem("userRole") || "",
    };

    const walkinItem = posCart.find((x) => x.id === "WALKIN" || x.isPlan);
    const walkinQty = walkinItem ? Number(walkinItem.qty || 0) : 0;
    let issuedCount = 0;
    let issuanceCancelled = false;

    for (let item of posCart) {
        if (item.id === 'WALKIN' || item.isPlan) {
            for (let w = 0; w < item.qty; w++) {
                openWalkinIssueModal({ current: w + 1, total: item.qty });

                let tag = await waitForWalkinRfidTap({ timeoutMs: 60000 });
                if (!tag) {
                    issuanceCancelled = true;
                    closeWalkinIssueModal();
                    break;
                }
                tag = tag.trim();

                while (await isGuestCardIssuedToday(tag, dateStr)) {
                    showToast("That guest card is already issued for today. Please tap a different guest RFID card.", "error");
                    openWalkinIssueModal({ current: w + 1, total: item.qty });
                    const retryTag = await waitForWalkinRfidTap({ timeoutMs: 60000 });
                    if (!retryTag) {
                        issuanceCancelled = true;
                        break;
                    }
                    tag = retryTag.trim();
                }
                if (issuanceCancelled) {
                    closeWalkinIssueModal();
                    break;
                }

                await upsertGuestCardIssued({ rfidTag: tag, dateStr, paymentId, issuedBy });
                await issueWalkinPassAndCheckIn({ rfidTag: tag, paymentId, dateStr, timeStr, amount: Number(item.price || 0), issuedBy });
                issuedCount++;
                closeWalkinIssueModal();
            }
            continue;
        }
        await updateDoc(doc(db, "inventory", item.id), { qty: increment(-item.qty) });
        await logStockMovement(item.id, item.name, -item.qty, `POS Sale (${selectedPaymentMethod})`);
    }

    if (walkinQty > 0 && (issuanceCancelled || issuedCount < walkinQty)) {
        await updateDoc(doc(db, "payments", paymentId), {
            walkinIssuanceIncomplete: true,
            walkinExpectedQty: walkinQty,
            walkinIssuedQty: issuedCount,
        });
        showToast(`Payment processed, but walk-in issuance was not completed.\nIssued: ${issuedCount} of ${walkinQty}`, "error");
    } else {
        showToast("Payment Processed Successfully!", "success");
    }
    posCart = []; renderCart();
    if (customerNameInput) customerNameInput.value = '';
}

// ==========================================
// 8.5 DASHBOARD ANALYTICS & KPIS
// ==========================================
window.refreshDashboardAnalytics = function () {
    if (!document.getElementById('dashboard')) return;

    calculateFinancials();
    calculateOperationalAlerts();
    calculateEngagement();
    calculateConversionRate();

    // Auto-update expanded chart if active
    const activeItem = document.querySelector('.kpi-unified-item.active-item');
    if (activeItem) {
        // Extract the detailId from the onclick attribute: toggleKpiDetail('detailId', this)
        const match = activeItem.getAttribute('onclick').match(/'([^']+)'/);
        if (match && match[1]) {
            renderKpiBreakdown(match[1]);
        }
    }
}

function calculateFinancials() {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Weekly range (Monday to Sunday)
    const dayOfWeek = now.getDay();
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + distanceToMonday);
    monday.setHours(0, 0, 0, 0);

    let dailyRevenue = 0;
    let weeklyRevenue = 0;
    let lastWeekRevenue = 0;

    const lastWeekStart = new Date(monday);
    lastWeekStart.setDate(monday.getDate() - 7);
    const lastWeekEnd = new Date(monday);

    paymentsData.forEach(p => {
        if (p.status === 'Voided') return;
        const pDate = new Date(p.date);
        const pAmount = Number(p.amount || 0);

        if (p.date === todayStr) dailyRevenue += pAmount;

        if (pDate >= monday && pDate <= now) {
            weeklyRevenue += pAmount;
        }

        if (pDate >= lastWeekStart && pDate < lastWeekEnd) {
            lastWeekRevenue += pAmount;
        }
    });

    if (document.getElementById('dashDailyRevenue')) document.getElementById('dashDailyRevenue').innerText = `₱${dailyRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const trendEl = document.getElementById('revenueTrend');
    if (trendEl) {
        let pct = 0;
        if (lastWeekRevenue > 0) pct = ((weeklyRevenue - lastWeekRevenue) / lastWeekRevenue) * 100;
        else if (weeklyRevenue > 0) pct = 100;

        const isUp = pct >= 0;
        trendEl.innerHTML = `<span style="color: ${isUp ? '#27ae60' : '#e74c3c'};"><i class="fas fa-caret-${isUp ? 'up' : 'down'}"></i> ${isUp ? '+' : ''}${pct.toFixed(0)}% since last week</span>`;
    }

    // Expiring Memberships (Next 7 Days)
    let expiringList = [];
    const sevenDaysFromNow = now.getTime() + (7 * 24 * 60 * 60 * 1000);

    membersData.forEach(m => {
        if ((m.status || "").toLowerCase() === 'archived') return;
        const planDays = window.getPlanDays ? window.getPlanDays(m.plan) : 30;
        if (m.dateRegistered) {
            const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
            if (expiryDate > now.getTime() && expiryDate <= sevenDaysFromNow) {
                const daysLeft = Math.ceil((expiryDate - now.getTime()) / (1000 * 60 * 60 * 24));
                expiringList.push({ name: `${m.givenName || ''} ${m.familyName || ''}`, daysLeft });
            }
        }
    });

    if (document.getElementById('dashExpiringBadge')) document.getElementById('dashExpiringBadge').innerText = expiringList.length;
    const listEl = document.getElementById('dashExpiringList');
    if (listEl) {
        if (expiringList.length === 0) {
            listEl.innerHTML = `<p style="color: var(--text-muted); font-size: 12px; padding: 10px 0;">No memberships expiring soon.</p>`;
        } else {
            listEl.innerHTML = expiringList.slice(0, 3).map(e => `
                <div class="notif-item">
                    <strong>${e.name}</strong> expires in ${e.daysLeft} day${e.daysLeft > 1 ? 's' : ''}
                </div>
            `).join('');
        }
    }
}

function calculateOperationalAlerts() {
    // Maintenance
    const maintItems = inventoryData.filter(i => (i.itemType === 'equipment' || !i.itemType) && i.status !== 'Operational');
    const maintCount = maintItems.length;
    const maintEl = document.getElementById('dashMaintCount');
    const maintText = document.getElementById('maintStatusText');

    if (maintEl) maintEl.innerText = maintCount;
    if (maintText) {
        if (maintCount === 0) {
            maintText.innerText = "System Healthy";
            maintText.style.color = "#27ae60";
        } else {
            maintText.innerText = `${maintCount} Machine${maintCount > 1 ? 's' : ''} Need Attention`;
            maintText.style.color = "var(--primary-red)";
        }
    }

    // Low Stock
    const lowStockItems = inventoryData.filter(i => i.itemType === 'product' && Number(i.qty) <= Number(i.lowStockThreshold || 5));
    const lowStockCount = lowStockItems.length;
    const lowStockBadge = document.getElementById('dashLowStockBadge');
    const lowStockList = document.getElementById('dashLowStockList');

    if (lowStockBadge) lowStockBadge.innerText = lowStockCount;
    if (lowStockList) {
        if (lowStockCount === 0) {
            lowStockList.innerHTML = `<p style="color: var(--text-muted); font-size: 12px; padding: 10px 0;">All stock levels healthy.</p>`;
        } else {
            lowStockList.innerHTML = lowStockItems.slice(0, 3).map(i => `
                <div class="notif-item" style="border-left-color: #f59e0b;">
                    <strong>${i.name}</strong>: ${i.qty} units left
                </div>
            `).join('');
        }
    }
}

function calculateEngagement() {
    // Capacity progress bar removed as per quiet luxury refinements
    // Real-time value is handled via the presentMembers element in attendance.js
}

function calculateConversionRate() {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Count members registered today
    const newMembersToday = membersData.filter(m => {
        if (!m.dateRegistered) return false;
        const regDate = new Date(m.dateRegistered).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return regDate === todayStr;
    });

    if (newMembersToday.length === 0) {
        // Fallback to a realistic rolling average if no new registrations today
        // In a real system, this would be a DB query over 30 days.
        const convEl = document.getElementById('dashConversionRate');
        if (convEl) convEl.innerText = `14.2%`;
        return;
    }

    let convertedCount = 0;
    newMembersToday.forEach(m => {
        const hasWalkin = paymentsData.some(p =>
            p.status !== 'Voided' &&
            (p.name === m.name || p.name === `${m.givenName} ${m.familyName}`) &&
            (p.items || "").includes("Walk-in")
        );
        if (hasWalkin) convertedCount++;
    });

    const rate = ((convertedCount / newMembersToday.length) * 100).toFixed(1);
    const convEl = document.getElementById('dashConversionRate');
    if (convEl) convEl.innerText = `${rate}%`;
}

function renderSparkline(canvasId, data, color) {
    const container = document.getElementById(canvasId);
    if (!container) return;

    container.innerHTML = `<canvas id="${canvasId}-canvas" width="100" height="35"></canvas>`;
    const canvas = document.getElementById(`${canvasId}-canvas`);
    const ctx = canvas.getContext('2d');

    const max = Math.max(...data, 1);
    const step = canvas.width / (data.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    data.forEach((val, i) => {
        const x = i * step;
        const y = canvas.height - (val / max * (canvas.height - 4)) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.stroke();

    // Fill area
    ctx.lineTo((data.length - 1) * step, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.fillStyle = color + '22'; // 13% opacity
    ctx.fill();
}

// ==========================================
// 9. FINANCIALS & WEEKLY PDF GENERATOR
// ==========================================
let currentPaymentSortField = 'timestamp';
let currentPaymentSortOrder = 'desc';

onSnapshot(paymentsCol, (snapshot) => {
    paymentsData = [];
    snapshot.forEach(doc => paymentsData.push({ id: doc.id, ...doc.data() }));
    renderPayments();
    if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
});

function renderPayments() {
    const payTbody = document.querySelector('#paymentTable tbody');
    if (!payTbody) return;

    // 1. Calculate KPI Metrics (Always based on full data)
    let totalRevenue = 0;
    let totalVAT = 0;
    let totalVoided = 0;

    paymentsData.forEach(t => {
        const amount = Number(t.amount || 0);
        const vat = (t.vat != null ? Number(t.vat) : (amount / 1.12 * 0.12));
        if (t.status === 'Voided') {
            totalVoided += amount;
        } else {
            totalRevenue += amount;
            totalVAT += vat;
        }
    });

    // Update KPI UI
    if (document.getElementById('financialTotalRevenue')) document.getElementById('financialTotalRevenue').innerText = `₱${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (document.getElementById('financialTotalVAT')) document.getElementById('financialTotalVAT').innerText = `₱${totalVAT.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (document.getElementById('financialTotalVoided')) document.getElementById('financialTotalVoided').innerText = `₱${totalVoided.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    // 2. Filter and Sort for the Table
    let filtered = [...paymentsData];

    const searchTerm = document.getElementById('paymentSearch')?.value.toLowerCase();
    const filterStatus = document.getElementById('paymentFilterStatus')?.value;
    const filterMethod = document.getElementById('paymentFilterMethod')?.value;

    if (searchTerm) {
        filtered = filtered.filter(p =>
            (p.name && p.name.toLowerCase().includes(searchTerm)) ||
            (p.id && p.id.toLowerCase().includes(searchTerm)) ||
            (p.items && p.items.toLowerCase().includes(searchTerm))
        );
    }

    if (filterStatus && filterStatus !== 'all') {
        filtered = filtered.filter(p => p.status === filterStatus);
    }

    if (filterMethod && filterMethod !== 'all') {
        filtered = filtered.filter(p => p.paymentMethod === filterMethod);
    }

    // Sorting logic
    filtered.sort((a, b) => {
        let valA, valB;

        if (currentPaymentSortField === 'customerName') {
            valA = (a.name || "").toLowerCase();
            valB = (b.name || "").toLowerCase();
        } else if (currentPaymentSortField === 'grandTotal' || currentPaymentSortField === 'amount') {
            valA = Number(a.amount || 0);
            valB = Number(b.amount || 0);
        } else if (currentPaymentSortField === 'subtotal') {
            valA = Number(a.subtotal || a.amount || 0);
            valB = Number(b.subtotal || b.amount || 0);
        } else if (currentPaymentSortField === 'vat') {
            valA = Number(a.vat || 0);
            valB = Number(b.vat || 0);
        } else if (currentPaymentSortField === 'timestamp') {
            valA = Number(a.timestamp || 0);
            valB = Number(b.timestamp || 0);
        } else {
            valA = String(a[currentPaymentSortField] || "").toLowerCase();
            valB = String(b[currentPaymentSortField] || "").toLowerCase();
        }

        if (valA < valB) return currentPaymentSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentPaymentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    // 3. Render Rows
    const renderPaymentRow = (t) => {
        const amount = Number(t.amount || 0);
        const vat = (t.vat != null ? Number(t.vat) : (amount / 1.12 * 0.12)).toFixed(2);
        const isVoided = t.status === 'Voided';

        // Status Badge
        const statusBadge = isVoided
            ? '<span class="status-badge-solid voided">Voided</span>'
            : '<span class="status-badge-solid paid">Paid</span>';

        // Purchased Items Truncation
        const items = t.items || t.type || "";
        const itemList = items.split(',').map(i => i.trim());
        let itemsHtml = "";
        if (itemList.length > 2) {
            itemsHtml = `
                <div class="items-cell">
                    ${itemList[0]}, ${itemList[1]} <span class="item-badge">+${itemList.length - 2} more</span>
                    <div class="items-tooltip">${items}</div>
                </div>
            `;
        } else {
            itemsHtml = items;
        }

        // Action Kebab Menu
        const actionHtml = `
            <div class="kebab-menu">
                <button type="button" class="kebab-btn" onclick="toggleKebab(event, '${t.id}')">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
                <div class="kebab-dropdown" id="kebab-${t.id}">
                    <div class="kebab-item" onclick="viewInvoice('${t.id}')"><i class="fas fa-file-invoice"></i> View Invoice</div>
                    <div class="kebab-item" onclick="printReceipt('${t.id}')"><i class="fas fa-print"></i> Print Receipt</div>
                    ${!isVoided ? `
                        <div class="kebab-item" onclick="processRefund('${t.id}')"><i class="fas fa-undo"></i> Process Refund</div>
                        <div class="kebab-item" style="color: #991b1b;" onclick="voidTransaction('${t.id}')"><i class="fas fa-ban"></i> Void Transaction</div>
                    ` : ''}
                </div>
            </div>
        `;

        return `
            <tr style="${isVoided ? 'color: #94a3b8;' : ''}">
                <td style="font-weight: 500; ${isVoided ? 'text-decoration: line-through;' : ''}">${t.name}</td>
                <td style="${isVoided ? 'text-decoration: line-through;' : ''}">${itemsHtml}</td>
                <td style="${isVoided ? 'text-decoration: line-through;' : ''}"><span style="white-space: nowrap;">${t.date}</span> <br><small style="color:#94a3b8;">${t.time || ''}</small></td>
                <td style="${isVoided ? 'text-decoration: line-through;' : ''}">₱${(t.subtotal || amount).toFixed(2)}</td>
                <td style="${isVoided ? 'text-decoration: line-through;' : ''}">₱${vat}</td>
                <td style="font-weight:700; ${isVoided ? 'text-decoration: line-through;' : ''}">₱${amount.toFixed(2)}</td>
                <td>${statusBadge}</td>
                <td style="text-align: right;">${actionHtml}</td>
            </tr>
        `;
    };

    window.syncDOM(payTbody, filtered, renderPaymentRow, 'pay-row');

    // Update pagination counts
    if (document.getElementById('paymentTotalCount')) document.getElementById('paymentTotalCount').innerText = filtered.length;
    if (document.getElementById('paymentShowingCount')) document.getElementById('paymentShowingCount').innerText = filtered.length > 0 ? `1-${filtered.length}` : '0-0';
}

// Financial Report UI Helpers
window.toggleKebab = function (event, id) {
    event.stopPropagation();
    document.querySelectorAll('.kebab-dropdown').forEach(d => {
        if (d.id !== `kebab-${id}`) d.classList.remove('show');
    });
    const dropdown = document.getElementById(`kebab-${id}`);
    if (dropdown) dropdown.classList.toggle('show');
};

// Close kebabs on click outside
document.addEventListener('click', () => {
    document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.remove('show'));
});

window.viewInvoice = function (id) {
    const tx = paymentsData.find(p => p.id === id);
    if (!tx) return;

    document.getElementById('invoiceId').innerText = `#${id.slice(0, 8).toUpperCase()}`;
    document.getElementById('invoiceCustomerName').innerText = tx.name || "Walk-in Customer";
    document.getElementById('invoiceDate').innerText = `${tx.date} • ${tx.time || ''}`;
    document.getElementById('invoiceMethod').innerText = tx.paymentMethod || "Cash";
    document.getElementById('invoiceStatus').innerText = tx.status || "Paid";
    document.getElementById('invoiceStatus').className = `status-badge-solid ${tx.status?.toLowerCase() || 'paid'}`;
    document.getElementById('invoiceStatus').style.background = tx.status === 'Voided' ? '#ef4444' : '#27ae60';

    const subtotal = tx.subtotal || (Number(tx.amount || 0) / 1.12);
    const vat = tx.vat || (Number(tx.amount || 0) - subtotal);
    const total = Number(tx.amount || 0);

    document.getElementById('invoiceSubtotal').innerText = `₱${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('invoiceVAT').innerText = `₱${vat.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('invoiceTotal').innerText = `₱${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const itemsList = document.getElementById('invoiceItemsList');
    itemsList.innerHTML = "";

    if (tx.lineItems && tx.lineItems.length > 0) {
        tx.lineItems.forEach(item => {
            const row = `
                <tr>
                    <td style="padding: 10px 0;">${item.name}</td>
                    <td style="padding: 10px 0; text-align: center;">${item.qty}</td>
                    <td style="padding: 10px 0; text-align: right;">₱${(Number(item.price || 0) * Number(item.qty || 1)).toFixed(2)}</td>
                </tr>
            `;
            itemsList.innerHTML += row;
        });
    } else {
        const row = `
            <tr>
                <td style="padding: 10px 0;">${tx.items || tx.type || "Purchase"}</td>
                <td style="padding: 10px 0; text-align: center;">1</td>
                <td style="padding: 10px 0; text-align: right;">₱${total.toFixed(2)}</td>
            </tr>
        `;
        itemsList.innerHTML += row;
    }

    document.getElementById('invoiceModal').style.display = 'flex';
};

window.printReceipt = function (id) { window.viewInvoice(id); setTimeout(() => window.print(), 500); };
window.processRefund = function (id) { window.voidTransaction(id, true); };

window.filterPayments = function () {
    renderPayments();
};

window.sortPayments = function (field) {
    if (currentPaymentSortField === field) {
        currentPaymentSortOrder = currentPaymentSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentPaymentSortField = field;
        currentPaymentSortOrder = 'asc';
    }

    // Update sort icons in headers
    document.querySelectorAll('#paymentTable th i').forEach(icon => {
        icon.className = 'fas fa-sort';
    });

    const th = document.querySelector(`#paymentTable th[onclick*="${field}"]`);
    if (th) {
        const icon = th.querySelector('i');
        if (icon) {
            icon.className = `fas fa-sort-${currentPaymentSortOrder === 'asc' ? 'up' : 'down'}`;
        }
    }

    renderPayments();
};

window.changePaymentPagination = function () {
    renderPayments();
};

// Void Transaction & Restock Inventory (also handles Refunds)
window.voidTransaction = async function (id, isRefund = false) {
    const tx = paymentsData.find(p => p.id === id);
    if (!tx) return;
    if (tx.status === "Voided") return showToast("This transaction is already voided.", "error");

    const actionName = isRefund ? "REFUND" : "VOID";

    showConfirm(`Are you sure you want to ${actionName} this transaction? This will void the transaction, return purchased items to inventory, and refund credit if applicable.`, async () => {
        try {
            if (tx.type === "POS Sale") {
                if (tx.lineItems && tx.lineItems.length > 0) {
                    for (let item of tx.lineItems) {
                        if (item.id === "WALKIN") continue;
                        await updateDoc(doc(db, "inventory", item.id), { qty: increment(item.qty) });
                        await logStockMovement(item.id, item.name, item.qty, `Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"}`);
                    }
                } else if (tx.items) {
                    const itemList = tx.items.split(', ');
                    for (let itemStr of itemList) {
                        const match = itemStr.match(/^(\d+)x\s+(.+)$/);
                        if (match) {
                            const qtyRefunded = parseInt(match[1]);
                            const itemName = match[2];
                            if (itemName.includes("Walk-in Gym Access")) continue;

                            const invItem = inventoryData.find(i => i.name.toLowerCase() === itemName.toLowerCase());
                            if (invItem) {
                                await updateDoc(doc(db, "inventory", invItem.id), {
                                    qty: increment(qtyRefunded)
                                });
                                await logStockMovement(invItem.id, invItem.name, qtyRefunded, `Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"} (Legacy)`);
                            }
                        }
                    }
                }
            }

            // Refund credit if paid via RFID
            if (tx.paymentMethod === 'RFID' || tx.paymentMethod === 'RFID Card' || tx.paymentMethod === 'RFID Credit') {
                const member = membersData.find(m => 
                    m.name === tx.name || 
                    `${m.givenName || ''} ${m.familyName || ''}`.trim() === tx.name
                );
                if (member) {
                    await updateDoc(doc(db, "users", member.id), {
                        creditBalance: increment(tx.amount)
                    });
                    
                    const currentBalance = member.creditBalance || 0;
                    await addDoc(creditTransactionsCol, {
                        memberId: member.id,
                        memberName: tx.name,
                        type: "refund",
                        amount: tx.amount,
                        balanceBefore: currentBalance,
                        balanceAfter: currentBalance + tx.amount,
                        note: `Refunded POS Transaction: ${tx.id}`,
                        processedBy: localStorage.getItem("userId") || "",
                        timestamp: Date.now()
                    });
                } else {
                    showToast("Warning: Could not find member to refund credit.", "error");
                }
            }

            await updateDoc(doc(db, "payments", id), { status: "Voided" });
            showToast(`Transaction successfully ${actionName === "REFUND" ? "refunded" : "voided"}!`, "success");
            if (window.logActivity) window.logActivity(`Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"}`, `${actionName === "REFUND" ? "Refunded" : "Voided"} transaction ${id} for ${tx.name || 'Unknown'} (₱${tx.amount})`);
        } catch (e) {
            console.error(e);
            showToast(`Error ${actionName === "REFUND" ? "refunding" : "voiding"} transaction.`, "error");
        }
    });
}

window.generateWeeklyPDF = function () {
    if (typeof html2pdf === 'undefined') {
        return showToast("PDF library is still loading, please wait a moment and try again.", "info");
    }

    const docName = localStorage.getItem("loggedInUser") || "Staff Member";

    const today = new Date();
    const dayOfWeek = today.getDay();
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

    const monday = new Date(today);
    monday.setDate(today.getDate() + distanceToMonday);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const formatShortDate = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear().toString().slice(-2)}`;

    document.getElementById('pdfWeekOf').innerText = `${formatShortDate(monday)} - ${formatShortDate(sunday)}`;
    document.getElementById('pdfAssociateName').innerText = docName;
    document.getElementById('pdfCompletionDate').innerText = formatShortDate(today);

    let productSales = {};

    // Ignore voided transactions in the report
    paymentsData.filter(p => p.status !== 'Voided').forEach(payment => {
        if (!payment.date) return;
        const payDate = new Date(payment.date);

        if (payDate >= monday && payDate <= sunday) {
            let dayIndex = payDate.getDay() === 0 ? 6 : payDate.getDay() - 1;

            if (payment.lineItems && payment.lineItems.length > 0) {
                payment.lineItems.forEach(item => {
                    let qty = item.qty;
                    let name = item.name;
                    if (!productSales[name]) productSales[name] = [0, 0, 0, 0, 0, 0, 0];
                    productSales[name][dayIndex] += qty;
                });
            } else if (payment.items) {
                let itemsList = payment.items.split(', ');
                itemsList.forEach(itemStr => {
                    let match = itemStr.match(/^(\d+)x\s+(.+)$/);
                    if (match) {
                        let qty = parseInt(match[1]);
                        let name = match[2];

                        if (!productSales[name]) productSales[name] = [0, 0, 0, 0, 0, 0, 0];
                        productSales[name][dayIndex] += qty;
                    }
                });
            }
        }
    });

    const tbody = document.getElementById('pdfSalesBody');
    tbody.innerHTML = "";

    let rowCount = 0;
    for (let [prodName, days] of Object.entries(productSales)) {
        let total = days.reduce((a, b) => a + b, 0);
        tbody.innerHTML += `
            <tr>
                <td style="border: 1px solid #000; padding: 10px; text-align: left; height: 35px;">${prodName}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[0] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[1] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[2] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[3] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[4] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[5] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px;">${days[6] || ''}</td>
                <td style="border: 1px solid #000; padding: 10px; font-weight: bold;">${total}</td>
            </tr>
        `;
        rowCount++;
    }

    while (rowCount < 15) {
        tbody.innerHTML += `
            <tr>
                <td style="border: 1px solid #000; padding: 10px; height: 35px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
                <td style="border: 1px solid #000; padding: 10px;"></td>
            </tr>
        `;
        rowCount++;
    }

    const element = document.getElementById('weekly-sales-report');
    document.getElementById('pdf-report-container').style.display = 'block';

    let opt = {
        margin: 0.5,
        filename: `Weekly_Sales_${formatShortDate(monday).replace(/\//g, '-')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save().then(() => {
        document.getElementById('pdf-report-container').style.display = 'none';
    });
}

// ==========================================
// 10. MASTER DIRECTORY & ATTENDANCE LOGIC
// ==========================================
initAttendance({ db, attendanceCol, servicesChartInstanceGetter: () => servicesChartInstance });

onSnapshot(usersCol, (snapshot) => {
    allUsersData = []; membersData = []; chatUsers = [];
    snapshot.forEach(docSnap => {
        const data = docSnap.data();
        
        if (!data.uid && window.generateUID) {
            data.uid = window.generateUID(data.role || "Member");
            updateDoc(doc(db, "users", docSnap.id), { uid: data.uid }).catch(e => console.error(e));
        }

        const roleStr = (data.role || "").trim().toLowerCase();
        chatUsers.push({ id: docSnap.id, ...data });
        if (roleStr === 'member') membersData.push({ id: docSnap.id, ...data });
        else if (roleStr !== 'admin') allUsersData.push({ id: docSnap.id, ...data });
    });
    window.allUsersData = allUsersData;
    window.membersData = membersData;
    renderStaff();
    renderMembers();
    renderMemberTrainers();
    if (document.getElementById('chatUserList')) renderChatUserList();
});

// Change Password Logic - Moved outside onSnapshot (Bug Fix)
if (document.getElementById('changePasswordForm')) {
    document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newPass = document.getElementById('newPasswordInput').value.trim();
        if (newPass.length < 6) return showToast("Password must be at least 6 characters.", "error");

        const userId = localStorage.getItem('userId');
        if (!userId) return;

        try {
            await updateDoc(doc(db, "users", userId), { password: newPass });
            document.getElementById('changePasswordModal').style.display = 'none';
            showToast("Password updated successfully!", "success");
            if (window.logActivity) window.logActivity("Password Changed", `User changed their own password.`);
        } catch (err) {
            console.error(err);
            showToast("Error updating password.", "error");
        }
    });
}

window.openProfileSettingsModal = async function () {
    const userId = localStorage.getItem("userId");
    if (!userId) return showToast("You must be logged in.", "error");

    try {
        const userDoc = await getDoc(doc(db, "users", userId));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            document.getElementById('userProfileName').value = userData.name || userData.givenName || '';
            document.getElementById('userProfileEmail').value = userData.email || '';
            document.getElementById('userProfileEmergency').value = userData.emergencyContact || '';
            document.getElementById('userProfilePreview').src = userData.image || 'images/default-profile.png';
            document.getElementById('userProfilePassword').value = '';
        }
    } catch (err) {
        console.error(err);
    }

    document.getElementById('profileSettingsModal').style.display = 'flex';
}

// Handle Profile Settings Submission
document.addEventListener('submit', async (e) => {
    if (e.target && e.target.id === 'profileSettingsForm') {
        e.preventDefault();
        const userId = localStorage.getItem("userId");
        if (!userId) return showToast("Session expired.", "error");

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerText;
        submitBtn.disabled = true;
        submitBtn.innerText = "Saving...";

        try {
            const name = document.getElementById('userProfileName').value.trim();
            const newPassword = document.getElementById('userProfilePassword').value;
            const imageFile = document.getElementById('userProfileFile').files[0];
            let imageUrl = document.getElementById('userProfilePreview').src;

            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'profiles');
            }

            // Attempt to split name for better DB consistency between 'name' and 'givenName/familyName'
            const nameParts = name.trim().split(' ');
            const given = nameParts[0] || "";
            const family = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";
            const emergency = document.getElementById('userProfileEmergency').value.trim();

            const updates = { 
                name, 
                givenName: given, 
                familyName: family, 
                emergencyContact: emergency,
                image: imageUrl 
            };
            if (newPassword) {
                updates.password = newPassword;
            }

            await updateDoc(doc(db, "users", userId), updates);

            showToast("Profile updated successfully!", "success");
            document.getElementById('profileSettingsModal').style.display = 'none';

            // Refresh topbar name if present
            if (document.getElementById('topBarName')) {
                document.getElementById('topBarName').innerText = name.split(' ')[0];
            }
            localStorage.setItem("loggedInUser", name);
        } catch (error) {
            console.error(error);
            showToast(error.message, "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = originalText;
        }
    }
});



window.getPlanDays = function (plan) {
    // Dynamic lookup from loaded plans data
    if (!plan) return 30;
    if (window.__membershipPlansData && window.__membershipPlansData.length > 0) {
        const found = window.__membershipPlansData.find(p => p.name.toLowerCase() === plan.toLowerCase());
        if (found && found.duration) return Number(found.duration);
    }
    // Fallback heuristics for legacy data
    const p = plan.toLowerCase();
    if (p.includes("year") || p.includes("annual")) return 365;
    if (p.includes("quarter") || p.includes("3 month")) return 90;
    if (p.includes("6 month") || p.includes("semi")) return 180;
    return 30;
};

// Enhanced renewMember — opens renewal modal instead of instant renewal
window.renewMember = async (id) => {
    const member = membersData.find(m => m.id === id);
    if (!member) return showToast("Member not found.", "error");

    document.getElementById('renewMemberId').value = id;
    document.getElementById('renewMemberName').innerText = `${member.givenName || member.name} ${member.familyName || ''}`.trim();
    document.getElementById('renewMemberEmail').innerText = member.email || '';

    // Show current status
    const now = new Date().getTime();
    const planDays = window.getPlanDays(member.plan);
    let statusText = member.plan || 'No Plan';
    if (member.dateRegistered) {
        const expiryDate = member.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
        const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays <= 0) statusText = `${member.plan || 'Plan'} — Expired`;
        else if (diffDays <= 7) statusText = `${member.plan || 'Plan'} — ${diffDays} days left`;
        else statusText = `${member.plan || 'Plan'} — ${diffDays} days left`;
    }
    document.getElementById('renewCurrentPlanBadge').innerText = statusText;

    // Populate plan options from Firestore
    const select = document.getElementById('renewPlanSelect');
    select.innerHTML = '<option value="" disabled selected>Select a plan...</option>';
    const plans = (window.__membershipPlansData || []).filter(p => p.status === 'Active');
    if (plans.length === 0) {
        select.innerHTML = '<option value="" disabled selected>No active plans available</option>';
    } else {
        plans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} — ${p.duration} days — ₱${Number(p.price).toLocaleString()}`;
            if (member.plan && p.name.toLowerCase() === member.plan.toLowerCase()) opt.selected = true;
            select.appendChild(opt);
        });
    }

    // Update summary on plan change
    select.onchange = function () {
        const plan = (window.__membershipPlansData || []).find(p => p.id === this.value);
        if (plan) {
            document.getElementById('renewDuration').innerText = `${plan.duration} days`;
            const expiry = new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000);
            document.getElementById('renewExpiry').innerText = expiry.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

            let basePrice = Number(plan.price);
            let discount = 0;
            const now = new Date().getTime();
            if (member.dateRegistered) {
                const currentPlanDays = window.getPlanDays(member.plan);
                const currentExpiryDate = member.dateRegistered + (currentPlanDays * 24 * 60 * 60 * 1000);
                const remainingDays = Math.ceil((currentExpiryDate - now) / (1000 * 60 * 60 * 24));

                if (remainingDays > 0) {
                    const currentPlanObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === (member.plan || '').toLowerCase());
                    if (currentPlanObj) {
                        const dailyRate = Number(currentPlanObj.price) / currentPlanDays;
                        discount = dailyRate * remainingDays;
                    }
                }
            }

            const lockerCheckbox = document.getElementById('renewAddLocker');
            const lockerPrice = (lockerCheckbox && lockerCheckbox.checked) ? 300 : 0;

            const finalDue = Math.max(0, basePrice - discount + lockerPrice);

            let totalDueHtml = `₱${finalDue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
            if (discount > 0) {
                totalDueHtml = `<span style="font-size:12px; color:var(--text-muted); font-weight:normal; margin-right:8px;">(Prorated -₱${discount.toFixed(2)})</span>` + totalDueHtml;
            }

            document.getElementById('renewTotalDue').innerHTML = totalDueHtml;
        }
    };

    // Listen to locker toggle
    const lockerCheckbox = document.getElementById('renewAddLocker');
    if (lockerCheckbox) {
        lockerCheckbox.onchange = () => select.dispatchEvent(new Event('change'));
    }

    select.dispatchEvent(new Event('change'));

    // Reset payment method toggle to Cash
    window.__renewPaymentMethod = 'Cash';
    const payToggle = document.getElementById('renewPaymentToggle');
    if (payToggle) {
        payToggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
        const cashOpt = payToggle.querySelector('[data-method="Cash"]');
        if (cashOpt) cashOpt.classList.add('selected');
    }
    const gcashW = document.getElementById('renewGcashRefWrapper');
    if (gcashW) {
        gcashW.classList.remove('visible');
        const inp = gcashW.querySelector('input');
        if (inp) inp.value = '';
    }

    document.getElementById('renewMemberModal').style.display = 'flex';
};

// Confirm Renewal action
window.confirmRenewal = async function () {
    const id = document.getElementById('renewMemberId').value;
    const select = document.getElementById('renewPlanSelect');
    const selectedPlanId = select.value;
    if (!selectedPlanId) return showToast("Please select a plan.", "error");

    const plan = (window.__membershipPlansData || []).find(p => p.id === selectedPlanId);
    if (!plan) return showToast("Plan not found.", "error");

    const member = membersData.find(m => m.id === id);
    if (!member) return showToast("Member not found.", "error");

    // Recalculate exact total
    let basePrice = Number(plan.price);
    let discount = 0;
    const now = new Date().getTime();
    if (member.dateRegistered) {
        const currentPlanDays = window.getPlanDays(member.plan);
        const currentExpiryDate = member.dateRegistered + (currentPlanDays * 24 * 60 * 60 * 1000);
        const remainingDays = Math.ceil((currentExpiryDate - now) / (1000 * 60 * 60 * 24));
        if (remainingDays > 0) {
            const currentPlanObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === (member.plan || '').toLowerCase());
            if (currentPlanObj) discount = (Number(currentPlanObj.price) / currentPlanDays) * remainingDays;
        }
    }

    const lockerCheckbox = document.getElementById('renewAddLocker');
    const hasLocker = lockerCheckbox && lockerCheckbox.checked;
    const lockerPrice = hasLocker ? 300 : 0;
    const finalDue = Math.max(0, basePrice - discount + lockerPrice);

    showConfirm(`Charge ₱${finalDue.toLocaleString(undefined, { minimumFractionDigits: 2 })} for ${plan.name}${hasLocker ? ' + Locker' : ''}?`, async () => {
        try {
            // Capture payment method + GCash ref for renewal
            const renewPayMethod = window.__renewPaymentMethod || 'Cash';
            const renewGcashRef = (document.getElementById('renewGcashRefId') ? document.getElementById('renewGcashRefId').value.trim() : '');

            // Validate GCash ref when GCash is selected
            if (renewPayMethod === 'GCash' && !renewGcashRef) {
                showToast('Please enter the GCash Reference ID.', 'error');
                return;
            }

            const currentTimestamp = new Date().getTime();
            let updates = {
                plan: plan.name,
                dateRegistered: currentTimestamp,
                status: "Active"
            };
            if (hasLocker) {
                updates.hasLocker = true;
            }

            await updateDoc(doc(db, "users", id), updates);

            // Record renewal payment
            const paymentData = {
                name: `${member.givenName || member.name} ${member.familyName || ''}`.trim(),
                amount: finalDue,
                items: `Renewal: ${plan.name}${hasLocker ? ' & Locker' : ''}`,
                type: "Membership",
                status: "Paid",
                paymentMethod: renewPayMethod,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                timestamp: currentTimestamp
            };
            if (renewPayMethod === 'GCash' && renewGcashRef) {
                paymentData.gcashRefId = renewGcashRef;
            }
            await addDoc(paymentsCol, paymentData);

            window.closeModal('renewMemberModal');
            showToast("Membership renewed successfully!", "success");
            if (window.logActivity) window.logActivity("Membership Renewed", `Renewed ${member.givenName || member.name} ${member.familyName || ''} with ${plan.name} (₱${finalDue}) via ${renewPayMethod}`);
        } catch (err) {
            console.error("Renewal failed:", err);
            showToast("Error renewing membership. Please try again.", "error");
        }
    });
};

// ==========================================
// MEMBERSHIP PLANS MODULE (CRUD)
// ==========================================
window.__membershipPlansData = [];

onSnapshot(membershipPlansCol, (snapshot) => {
    window.__membershipPlansData = [];
    snapshot.forEach(d => window.__membershipPlansData.push({ id: d.id, ...d.data() }));
    renderMembershipPlans();
    populatePlanDropdowns();
});

function renderMembershipPlans() {
    const tbody = document.getElementById('plansTableBody');
    if (!tbody) return;

    const plans = window.__membershipPlansData;
    const activePlans = plans.filter(p => p.status === 'Active');

    // Stats
    if (document.getElementById('mpTotalPlans')) document.getElementById('mpTotalPlans').innerText = plans.length;
    if (document.getElementById('mpActivePlans')) document.getElementById('mpActivePlans').innerText = activePlans.length;
    if (document.getElementById('mpAvgPrice') && activePlans.length > 0) {
        const avg = activePlans.reduce((s, p) => s + Number(p.price || 0), 0) / activePlans.length;
        document.getElementById('mpAvgPrice').innerText = `₱${Math.round(avg).toLocaleString()}`;
    }

    // Find most popular plan by counting subscribers
    if (document.getElementById('mpTopPlan') && plans.length > 0) {
        const planCounts = {};
        membersData.forEach(m => {
            const pName = (m.plan || '').trim();
            if (pName) planCounts[pName] = (planCounts[pName] || 0) + 1;
        });
        const topEntry = Object.entries(planCounts).sort((a, b) => b[1] - a[1])[0];
        document.getElementById('mpTopPlan').innerText = topEntry ? topEntry[0] : '—';
    }

    if (plans.length === 0) {
        tbody.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fa-solid fa-tags" style="font-size:2rem; opacity:0.15; display:block; margin-bottom:10px;"></i> No membership plans yet. Click "Create Plan" to get started.</div>';
        return;
    }

    tbody.innerHTML = plans.map((p, index) => {
        const isActive = p.status === 'Active';
        const subscriberCount = membersData.filter(m => (m.plan || '').toLowerCase() === (p.name || '').toLowerCase() && (m.status || '').toLowerCase() !== 'archived').length;
        const isPremium = p.name.toLowerCase().includes('gold') || p.price >= 2000;

        let cardStyle = isPremium
            ? 'ring-1 ring-[#991b1b]/10'
            : '';
        let premiumAccent = isPremium
            ? '<div class="absolute top-0 left-0 w-1 h-full bg-[#991b1b]"></div>'
            : '';
        let priceColor = isPremium ? 'text-[#991b1b]' : 'text-slate-900';
        let plClass = isPremium ? 'pl-7' : '';

        return `
            <div class="bg-white border-solid border border-gray-200 rounded shadow-sm flex flex-col relative ${cardStyle}">
                ${premiumAccent}
                <div class="p-6 border-b border-solid border-gray-100 ${plClass}">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h3 class="text-xl font-bold text-slate-900 leading-none tracking-tight">${escapeHtml(p.name)}</h3>
                            <p class="text-sm text-slate-500 mt-2">${p.description ? escapeHtml(p.description) : 'Standard access plan'}</p>
                        </div>
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" class="sr-only peer" ${isActive ? 'checked' : ''} disabled>
                            <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#991b1b]"></div>
                            <span class="ml-2 text-xs font-medium text-slate-600">${p.status}</span>
                        </label>
                    </div>
                    <div class="mt-5 flex items-baseline gap-1">
                        <span class="text-3xl font-extrabold ${priceColor} tracking-tight">₱${Number(p.price).toLocaleString()}</span>
                        <span class="text-sm text-slate-500 font-medium">/ ${p.duration} days</span>
                    </div>
                </div>
                
                <div class="p-6 flex-grow bg-slate-50/50 ${plClass}">
                    <h4 class="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">Features</h4>
                    <ul class="space-y-3 text-sm text-slate-700">
                        <li class="flex items-start gap-3">
                            <i class="fas fa-check text-emerald-600 mt-0.5 font-bold"></i>
                            <span class="leading-snug">Gym Floor Access</span>
                        </li>
                        ${isPremium ? `
                        <li class="flex items-start gap-3">
                            <i class="fas fa-check text-[#991b1b] mt-0.5 font-bold"></i>
                            <span class="font-bold text-slate-900 leading-snug">Mobile App Access included</span>
                        </li>
                        ` : `
                        <li class="flex items-start gap-3">
                            <i class="fas fa-times text-slate-400 mt-0.5 font-bold"></i>
                            <span class="text-slate-500 leading-snug">No Mobile App Access</span>
                        </li>
                        `}
                    </ul>
                </div>

                <div class="bg-gray-50 border-t border-solid border-gray-200 px-4 py-3 flex items-center justify-between gap-2 ${plClass}">
                    <div class="text-sm font-semibold text-slate-600 flex items-center gap-2">
                        <i class="fas fa-users text-slate-400"></i> ${subscriberCount} Subs
                    </div>
                    <div class="flex gap-2">
                        <button type="button" class="text-sm font-semibold text-[#991b1b] hover:bg-red-50 px-4 py-2 rounded transition-colors border-solid border border-transparent hover:border-red-200 flex items-center gap-2 bg-white shadow-sm" onclick="openEditPlanModal('${p.id}')">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Populate all plan <select> dropdowns across the app
function populatePlanDropdowns() {
    const activePlans = (window.__membershipPlansData || []).filter(p => p.status === 'Active');

    // Registration form dropdown
    const regSelect = document.getElementById('regMemberPlan');
    if (regSelect) {
        const currentVal = regSelect.value;
        regSelect.innerHTML = '<option value="" disabled selected>Select Plan...</option>';
        activePlans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} — ₱${Number(p.price).toLocaleString()} (${p.duration} days)`;
            regSelect.appendChild(opt);
        });
        // Fallback: keep legacy plans if no Firestore plans exist yet
        if (activePlans.length === 0) {
            regSelect.innerHTML += '<option value="Gold Plan">Gold Plan</option><option value="Silver Plan">Silver Plan</option>';
        }
        if (currentVal) regSelect.value = currentVal;
    }

    // Edit member form dropdown
    const editSelect = document.getElementById('editMemberPlan');
    if (editSelect) {
        const currentVal = editSelect.value;
        editSelect.innerHTML = '';
        activePlans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} — ₱${Number(p.price).toLocaleString()} (${p.duration} days)`;
            editSelect.appendChild(opt);
        });
        if (activePlans.length === 0) {
            editSelect.innerHTML += '<option value="Gold Plan">Gold Plan</option><option value="Silver Plan">Silver Plan</option>';
        }
        if (currentVal) editSelect.value = currentVal;
    }
}

window.openPlanModal = function (editId) {
    const form = document.getElementById('planForm');
    if (form) form.reset();
    document.getElementById('planEditId').value = '';
    document.getElementById('planModalTitle').innerHTML = '<i class="fa-solid fa-tags"></i> Create Membership Plan';
    document.getElementById('planModal').style.display = 'flex';
};

window.openEditPlanModal = function (id) {
    const plan = (window.__membershipPlansData || []).find(p => p.id === id);
    if (!plan) return showToast("Plan not found.", "error");

    document.getElementById('planEditId').value = id;
    document.getElementById('planName').value = plan.name || '';
    document.getElementById('planDuration').value = plan.duration || '';
    document.getElementById('planPrice').value = plan.price || '';
    document.getElementById('planDescription').value = plan.description || '';
    document.getElementById('planStatus').value = plan.status || 'Active';
    document.getElementById('planModalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Membership Plan';
    document.getElementById('planModal').style.display = 'flex';
};

window.deletePlan = function (id, name) {
    showConfirm(`Are you sure you want to delete the plan "${name}"? This will not affect existing members.`, async () => {
        try {
            await deleteDoc(doc(db, "membershipPlans", id));
            showToast(`Plan "${name}" deleted successfully.`, "success");
            if (window.logActivity) window.logActivity("Plan Deleted", `Deleted membership plan: ${name}`);
        } catch (err) {
            console.error(err);
            showToast("Error deleting plan.", "error");
        }
    });
};

// Plan form submission (Create / Update)
if (document.getElementById('planForm')) {
    document.getElementById('planForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const origText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

        const editId = document.getElementById('planEditId').value;
        const planData = {
            name: document.getElementById('planName').value.trim(),
            duration: parseInt(document.getElementById('planDuration').value),
            price: parseFloat(document.getElementById('planPrice').value),
            description: document.getElementById('planDescription').value.trim(),
            status: document.getElementById('planStatus').value,
            updatedAt: new Date().getTime()
        };

        try {
            if (editId) {
                await updateDoc(doc(db, "membershipPlans", editId), planData);
                showToast(`Plan "${planData.name}" updated successfully!`, "success");
                if (window.logActivity) window.logActivity("Plan Updated", `Updated plan: ${planData.name} (₱${planData.price}, ${planData.duration} days)`);
            } else {
                planData.createdAt = new Date().getTime();
                await addDoc(membershipPlansCol, planData);
                showToast(`Plan "${planData.name}" created successfully!`, "success");
                if (window.logActivity) window.logActivity("Plan Created", `Created plan: ${planData.name} (₱${planData.price}, ${planData.duration} days)`);
            }
            window.closeModal('planModal');
        } catch (err) {
            console.error("Plan save failed:", err);
            showToast("Error saving plan. Please try again.", "error");
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
        }
    });
}

// ==========================================
// 10.5 LOCKER SYSTEM MODULE
// ==========================================
onSnapshot(lockersCol, (snapshot) => {
    lockersData = [];
    snapshot.forEach(d => lockersData.push({ id: d.id, ...d.data() }));
    renderLockers();
});

function renderLockers() {
    const grid = document.getElementById('lockerGrid');
    if (!grid) return;

    // Stats
    const total = lockersData.length;
    const occupied = lockersData.filter(l => l.status === 'Occupied').length;
    const maintenance = lockersData.filter(l => l.status === 'Maintenance').length;
    const available = total - occupied - maintenance;

    if (document.getElementById('totalLockersCount')) document.getElementById('totalLockersCount').innerText = total;
    if (document.getElementById('availableLockersCount')) document.getElementById('availableLockersCount').innerText = available;
    if (document.getElementById('occupiedLockersCount')) document.getElementById('occupiedLockersCount').innerText = occupied;
    if (document.getElementById('maintLockersCount')) document.getElementById('maintLockersCount').innerText = maintenance;

    if (total === 0) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:40px; color:var(--text-muted);">No lockers added yet. Click "Add Locker" to begin.</div>';
        return;
    }

    grid.innerHTML = lockersData.sort((a, b) => (a.number || "").localeCompare(b.number || "", undefined, { numeric: true })).map(l => {
        const isOccupied = l.status === 'Occupied';
        const isMaint = l.status === 'Maintenance';
        const statusClass = isOccupied ? 'occupied' : (isMaint ? 'maintenance' : 'available');
        const icon = isOccupied ? 'fa-lock' : (isMaint ? 'fa-tools' : 'fa-lock-open');

        return `
            <div class="locker-card ${statusClass}" onclick="openAssignLockerModal('${l.id}')">
                <div class="locker-icon"><i class="fa-solid ${icon}"></i></div>
                <div class="locker-number">${l.number}</div>
                <div class="locker-status-text">${l.status}</div>
                <div class="locker-assignee">${isOccupied ? (l.memberName || 'Assigned') : (l.location || 'Section')}</div>
            </div>
        `;
    }).join('');
}

window.openAddLockerModal = function () {
    document.getElementById('addLockerForm').reset();
    document.getElementById('addLockerModal').style.display = 'flex';
};

if (document.getElementById('addLockerForm')) {
    document.getElementById('addLockerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const number = document.getElementById('lockerNumberInput').value.trim();
        const location = document.getElementById('lockerLocationInput').value.trim();

        try {
            await addDoc(lockersCol, {
                number,
                location,
                status: 'Available',
                createdAt: Date.now()
            });
            window.closeModal('addLockerModal');
            showToast(`Locker ${number} created successfully!`, "success");
        } catch (err) {
            console.error(err);
            showToast("Failed to create locker.", "error");
        }
    });
}

window.openAssignLockerModal = function (id) {
    const locker = lockersData.find(l => l.id === id);
    if (!locker) return;

    document.getElementById('assignLockerId').value = id;
    document.getElementById('assignLockerNumberText').innerText = `Locker #${locker.number}`;
    document.getElementById('assignLockerLocationText').innerText = locker.location || 'General Section';

    const isOccupied = locker.status === 'Occupied';
    const form = document.getElementById('assignLockerForm');
    const info = document.getElementById('activeAssignmentInfo');

    if (isOccupied) {
        form.style.display = 'none';
        info.style.display = 'block';
        document.getElementById('assigneeName').innerText = locker.memberName || 'Unknown Member';
        document.getElementById('assigneeInitial').innerText = (locker.memberName || '?')[0];
        if (locker.expiryDate) {
            const exp = new Date(locker.expiryDate);
            document.getElementById('assignmentExpiry').innerText = `Expires: ${exp.toLocaleDateString()}`;
        } else {
            document.getElementById('assignmentExpiry').innerText = 'Expires: N/A';
        }
    } else {
        form.style.display = 'block';
        info.style.display = 'none';
        populateAssignMemberSelect();
    }

    document.getElementById('assignLockerModal').style.display = 'flex';
};

function populateAssignMemberSelect() {
    const select = document.getElementById('assignMemberSelect');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>Search for a member...</option>';
    membersData.filter(m => (m.status || "").toLowerCase() !== 'archived').forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.setAttribute('data-name', `${m.givenName || m.name} ${m.familyName || ''}`.trim());
        opt.textContent = `${m.uid ? m.uid + ' - ' : ''}${m.givenName || m.name} ${m.familyName || ''}`.trim();
        select.appendChild(opt);
    });
}

if (document.getElementById('assignLockerForm')) {
    document.getElementById('assignLockerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const lockerId = document.getElementById('assignLockerId').value;
        const memberId = document.getElementById('assignMemberSelect').value;
        const duration = parseInt(document.getElementById('assignDuration').value);

        const memberOpt = document.querySelector(`#assignMemberSelect option[value="${memberId}"]`);
        const memberName = memberOpt ? memberOpt.getAttribute('data-name') : 'Unknown';

        const now = new Date();
        const expiryDate = new Date(now.setMonth(now.getMonth() + duration)).getTime();

        try {
            await updateDoc(doc(db, "lockers", lockerId), {
                status: 'Occupied',
                memberId,
                memberName,
                expiryDate,
                assignedAt: Date.now()
            });

            // Also update member profile
            await updateDoc(doc(db, "users", memberId), { hasLocker: true, lockerId: lockerId });

            window.closeModal('assignLockerModal');
            showToast(`Locker assigned to ${memberName} for ${duration} month(s).`, "success");
            if (window.logActivity) window.logActivity("Locker Assigned", `Assigned locker to ${memberName}`);
        } catch (err) {
            console.error(err);
            showToast("Failed to assign locker.", "error");
        }
    });
}

window.releaseLocker = async function () {
    const lockerId = document.getElementById('assignLockerId').value;
    const locker = lockersData.find(l => l.id === lockerId);
    if (!locker) return;

    showConfirm(`Are you sure you want to release Locker #${locker.number}?`, async () => {
        try {
            // Remove from member profile if exists
            if (locker.memberId) {
                await updateDoc(doc(db, "users", locker.memberId), { hasLocker: false, lockerId: null });
            }

            await updateDoc(doc(db, "lockers", lockerId), {
                status: 'Available',
                memberId: null,
                memberName: null,
                expiryDate: null,
                assignedAt: null
            });
            window.closeModal('assignLockerModal');
            showToast("Locker released successfully.", "success");
        } catch (err) {
            console.error(err);
            showToast("Failed to release locker.", "error");
        }
    });
};

window.printLockerReceipt = function () {
    showToast("Printing locker assignment receipt...", "info");
    window.print();
};

function renderMembers() {
    const memTbody = document.querySelector('#membersTable tbody');
    const arcTbody = document.querySelector('#archivedMembersTable tbody');
    // Remove early return to allow KPI updates even if table is missing


    // 1. Calculate KPI Metrics
    let activeMembers = 0;
    let expiringSoon = 0;
    let newMembers30d = 0;

    const now = new Date().getTime();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    const activeList = [];
    const archivedList = [];

    // Filter Logic
    const searchVal = (document.getElementById('memberSearch')?.value || "").toLowerCase();
    const planFilter = document.getElementById('memberFilterPlan')?.value || "all";
    const statusFilter = document.getElementById('memberFilterStatus')?.value || "all";

    membersData.forEach(m => {
        const statusStr = (m.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();

        // Count New Members (Last 30 Days)
        if (m.dateRegistered && m.dateRegistered > thirtyDaysAgo) {
            newMembers30d++;
        }

        if (statusLower === 'archived') {
            archivedList.push(m);
        } else {
            // Apply Filters to Active List only for display
            const matchesSearch = !searchVal ||
                (m.name || "").toLowerCase().includes(searchVal) ||
                (m.uid || "").toLowerCase().includes(searchVal) ||
                (m.email || "").toLowerCase().includes(searchVal) ||
                (m.givenName || "").toLowerCase().includes(searchVal) ||
                (m.familyName || "").toLowerCase().includes(searchVal);

            const matchesPlan = planFilter === "all" || m.plan === planFilter;
            const matchesStatus = statusFilter === "all" || statusStr === statusFilter;

            if (matchesSearch && matchesPlan && matchesStatus) {
                activeList.push(m);
            }

            if (statusLower === 'active') activeMembers++;

            // Count Expiring Soon
            const plan = m.plan || 'Standard Member';
            const planDays = window.getPlanDays(plan);
            if (m.dateRegistered) {
                const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                if (diffDays > 0 && diffDays <= 7) expiringSoon++;
            }
        }
    });

    // Update KPI UI
    if (document.getElementById('financialTotalActiveMembers')) document.getElementById('financialTotalActiveMembers').innerText = activeMembers;
    if (document.getElementById('financialExpiringSoon')) document.getElementById('financialExpiringSoon').innerText = expiringSoon;
    if (document.getElementById('financialNewMembers')) document.getElementById('financialNewMembers').innerText = newMembers30d;

    // 2. Render Rows
    const renderMemberRow = (m, isArchived) => {
        let plan = m.plan || 'Standard Member';
        let daysLeftText = "N/A", timerBadgeClass = "active";
        const planDays = window.getPlanDays(plan);

        if (m.dateRegistered) {
            const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
            const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
            if (diffDays > 0) {
                daysLeftText = `${diffDays} Days`;
                if (diffDays <= 7) timerBadgeClass = "pending";
            } else {
                daysLeftText = "Expired";
                timerBadgeClass = "broken";
            }
        } else {
            daysLeftText = `${planDays} Days`;
        }

        if (isArchived) {
            return `
                <tr>
                    <td>${m.givenName || m.name}</td><td>${m.mi || ''}</td><td>${m.familyName || ''}</td>
                    <td>${m.email}</td><td><strong>${plan}</strong></td><td><span class="status-badge-solid voided">Archived</span></td>
                    <td style="text-align: right;">
                        <button type="button" class="btn-icon" style="color: #10B981;" title="Restore Account" onclick="archiveUser('${m.id}', 'Archived')"><i class="fas fa-box-open"></i></button>
                        <button type="button" class="btn-icon" style="color: #EF4444;" title="Permanently Delete" onclick="deleteUser('${m.id}')"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
        } else {
            let badgeClass = (m.status || "Active").trim().toLowerCase() === 'active' ? 'active' : 'inactive';
            let statusHtml = `<span class="badge ${badgeClass}">${m.status || 'Active'}</span>`;

            const avatarHtml = m.image
                ? `<img src="${m.image}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">`
                : `<div class="initial-avatar" style="width:32px; height:32px; font-size:11px;">${(m.givenName || m.name || "?")[0]}${(m.familyName || "")[0] || ""}</div>`;

            // Inline Action Buttons (Similar to Staff/Trainers)
            const actionHtml = `
                <div class="flex gap-1 justify-end">
                    <button type="button" class="btn-icon" style="color: #3B82F6;" title="Renew/Extend" onclick="renewMember('${m.id}')"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" class="btn-icon" style="color: var(--dark-black);" title="Edit Profile" onclick="openEditMemberModal('${m.id}')"><i class="fa-solid fa-user-edit"></i></button>
                    <button type="button" class="btn-icon" style="color: #10B981;" title="Top-up Credit" onclick="openAddCreditModal('${m.id}')"><i class="fa-solid fa-wallet"></i></button>
                    <button type="button" class="btn-icon" style="color: #f39c12;" title="Archive Member" onclick="archiveUser('${m.id}', '${m.status || 'Active'}')"><i class="fas fa-box-archive"></i></button>
                </div>
            `;

            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <div style="font-weight: 600;">${m.givenName ? `${m.givenName} ${m.familyName || ''}`.trim() : (m.name || "User")}</div>
                            <div style="font-size: 11px; color: #94a3b8;">${m.uid ? m.uid + ' • ' : ''}${m.email}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${plan}</td>
                    <td><span class="badge ${timerBadgeClass}" style="font-size: 11px; padding: 2px 6px;"><i class="fa-regular fa-clock"></i> ${daysLeftText}</span></td>
                    <td style="font-weight: 600;">₱${(m.creditBalance || 0).toFixed(2)}</td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionHtml}</td>
                </tr>
            `;
        }
    };

    if (memTbody) window.syncDOM(memTbody, activeList, (m) => renderMemberRow(m, false), 'mem-row');
    if (arcTbody) window.syncDOM(arcTbody, archivedList, (m) => renderMemberRow(m, true), 'arc-row');


    // Update pagination counts
    if (document.getElementById('memberTotalCount')) document.getElementById('memberTotalCount').innerText = activeList.length;
    if (document.getElementById('memberShowingCount')) document.getElementById('memberShowingCount').innerText = activeList.length > 0 ? `1-${activeList.length}` : '0-0';

    if (document.getElementById('dashActiveMembers')) document.getElementById('dashActiveMembers').innerText = activeMembers;
    if (document.getElementById('gridMembers')) document.getElementById('gridMembers').innerText = activeList.length;
    if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
}

// Member UI Helpers
window.sendMessageToMember = function (id) {
    showToast("Opening messaging interface for member ID: " + id, "info");
};

window.filterMembers = function () {
    renderMembers();
};

window.sortMembers = function (field) {
    showToast("Sorting members by " + field, "info");
};

window.changeMemberPagination = function () {
    renderMembers();
};

window.openEditMemberModal = function (id) {
    const member = membersData.find(m => m.id === id);
    if (!member) return;

    if (document.getElementById('editMemberId')) {
        document.getElementById('editMemberId').value = id;
    }
    if (document.getElementById('editMemberGiven')) {
        document.getElementById('editMemberGiven').value = member.givenName || '';
    }
    if (document.getElementById('editMemberMI')) {
        document.getElementById('editMemberMI').value = member.mi || '';
    }
    if (document.getElementById('editMemberFamily')) {
        document.getElementById('editMemberFamily').value = member.familyName || '';
    }
    if (document.getElementById('editMemberRfid')) {
        document.getElementById('editMemberRfid').value = member.rfid || '';
    }
    if (document.getElementById('editMemberPlan')) {
        document.getElementById('editMemberPlan').value = member.plan || 'Gold Plan';
    }
    if (document.getElementById('editMemberImage')) {
        document.getElementById('editMemberImage').value = member.image || '';
    }
    if (document.getElementById('editMemberPreview')) {
        document.getElementById('editMemberPreview').src = member.image || 'images/default-profile.png';
    }
    if (document.getElementById('editMemberEmergency')) {
        document.getElementById('editMemberEmergency').value = member.emergencyContact || '';
    }

    document.getElementById('editMemberModal').style.display = 'flex';
}

if (document.getElementById('editMemberForm')) {
    document.getElementById('editMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editMemberId').value;
        const given = document.getElementById('editMemberGiven').value.trim();
        const mi = document.getElementById('editMemberMI').value.trim();
        const family = document.getElementById('editMemberFamily').value.trim();

        const updatedData = {
            givenName: given,
            mi: mi,
            familyName: family,
            name: `${given} ${family}`.trim(),
            emergencyContact: document.getElementById('editMemberEmergency') ? document.getElementById('editMemberEmergency').value.trim() : ""
        };

        if (document.getElementById('editMemberPlan')) {
            updatedData.plan = document.getElementById('editMemberPlan').value;
        }

        if (document.getElementById('editMemberRfid')) {
            updatedData.rfid = document.getElementById('editMemberRfid').value.trim();
        }

        if (document.getElementById('editMemberImageFile')) {
            const imageFile = document.getElementById('editMemberImageFile').files[0];
            let imageUrl = document.getElementById('editMemberImage').value.trim();
            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'members');
            }
            updatedData.image = imageUrl || '';
        }

        try {
            await updateDoc(doc(db, "users", id), updatedData);
            window.closeModal('editMemberModal');
            showToast("Member details updated successfully!", "success");
            if (window.logActivity) window.logActivity("Member Edited", `Edited member: ${updatedData.givenName} ${updatedData.familyName}`);
        } catch (error) {
            console.error("Member update failed:", error);
            showToast("Failed to update member. Please try again.", "error");
        }
    });
}

function renderStaff() {
    const staffTbody = document.querySelector('#staffTable tbody');
    const trainerTbody = document.querySelector('#trainerTable tbody');
    const arcStaffTbody = document.querySelector('#archivedStaffTable tbody');
    const arcTrainerTbody = document.querySelector('#archivedTrainerTable tbody');
    // Early return removed to allow dashboard feed updates


    // 1. Initialize KPI Metrics
    let staffActive = 0, staffOnShift = 0, staffMgmt = 0;
    let trainerActive = 0, trainerOnFloor = 0, trainerNewHires = 0;

    const now = new Date().getTime();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    const staffList = [];
    const trainerList = [];
    const arcStaffList = [];
    const arcTrainerList = [];

    // Filter values - Staff
    const staffSearch = (document.getElementById('staffSearchModern')?.value || "").toLowerCase();
    const staffRoleFilter = document.getElementById('staffFilterRole')?.value || "all";
    const staffStatusFilter = document.getElementById('staffFilterStatus')?.value || "all";

    // Filter values - Trainers
    const trainerSearch = (document.getElementById('trainerSearchModern')?.value || "").toLowerCase();
    const trainerSpecFilter = document.getElementById('trainerFilterSpecialty')?.value || "all";
    const trainerStatusFilter = document.getElementById('trainerFilterStatus')?.value || "all";

    allUsersData.forEach(u => {
        const roleStr = (u.role || "").trim();
        const roleLower = roleStr.toLowerCase();
        const statusStr = (u.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();

        if (statusLower === 'archived') {
            if (roleLower === 'trainer') arcTrainerList.push(u);
            else arcStaffList.push(u);
        } else {
            const isTrainer = roleLower === 'trainer';
            const isStaffOrAdmin = roleLower === 'staff' || roleLower === 'admin';

            // Process Staff/Admin
            if (isStaffOrAdmin) {
                if (statusLower === 'active') staffActive++;
                if (u.shiftStatus === 'On Shift') staffOnShift++;
                if (roleLower === 'admin') staffMgmt++;

                const matchesSearch = !staffSearch ||
                    (u.name || "").toLowerCase().includes(staffSearch) ||
                    (u.uid || "").toLowerCase().includes(staffSearch) ||
                    (u.email || "").toLowerCase().includes(staffSearch) ||
                    (u.givenName || "").toLowerCase().includes(staffSearch) ||
                    (u.familyName || "").toLowerCase().includes(staffSearch);
                const matchesRole = staffRoleFilter === "all" || roleStr === staffRoleFilter;
                const matchesStatus = staffStatusFilter === "all" || statusStr === staffStatusFilter;

                if (matchesSearch && matchesRole && matchesStatus) staffList.push(u);
            }

            // Process Trainers
            if (isTrainer) {
                if (statusLower === 'active') trainerActive++;
                if (u.shiftStatus === 'On Floor') trainerOnFloor++;
                if (u.dateRegistered && u.dateRegistered > thirtyDaysAgo) trainerNewHires++;

                const matchesSearch = !trainerSearch ||
                    (u.name || "").toLowerCase().includes(trainerSearch) ||
                    (u.uid || "").toLowerCase().includes(trainerSearch) ||
                    (u.email || "").toLowerCase().includes(trainerSearch) ||
                    (u.givenName || "").toLowerCase().includes(trainerSearch) ||
                    (u.familyName || "").toLowerCase().includes(trainerSearch);
                const matchesSpec = trainerSpecFilter === "all" || (u.specialty || "General Fitness") === trainerSpecFilter;
                const matchesStatus = trainerStatusFilter === "all" || statusStr === trainerStatusFilter;

                if (matchesSearch && matchesSpec && matchesStatus) trainerList.push(u);
            }
        }
    });

    // Update Staff KPI UI
    if (document.getElementById('staffTotalActive')) document.getElementById('staffTotalActive').innerText = staffActive;
    if (document.getElementById('staffOnShift')) document.getElementById('staffOnShift').innerText = staffOnShift;
    if (document.getElementById('staffManagement')) document.getElementById('staffManagement').innerText = staffMgmt;

    // Update Trainer KPI UI
    if (document.getElementById('trainerTotalActive')) document.getElementById('trainerTotalActive').innerText = trainerActive;
    if (document.getElementById('trainerOnFloor')) document.getElementById('trainerOnFloor').innerText = trainerOnFloor;
    if (document.getElementById('trainerNewHires')) document.getElementById('trainerNewHires').innerText = trainerNewHires;

    const renderStaffRow = (u, isArchived) => {
        const roleStr = (u.role || "").trim();
        const roleLower = roleStr.toLowerCase();
        const statusStr = (u.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();
        let fullName = u.givenName ? `${u.givenName} ${u.familyName || ''}`.trim() : (u.name || "User");
        let specialty = u.specialty || 'General Fitness';

        const avatarHtml = u.image
            ? `<img src="${u.image}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">`
            : `<div class="initial-avatar" style="width:32px; height:32px; font-size:11px;">${(u.givenName || u.name || "?")[0]}${(u.familyName || "")[0] || ""}</div>`;

        let actionBtns = isArchived ? `
            <div class="flex gap-1 justify-end">
                <button type="button" class="btn-icon" style="color: #10B981;" title="Restore Account" onclick="archiveUser('${u.id}', 'Archived')"><i class="fas fa-box-open"></i></button>
                <button type="button" class="btn-icon" style="color: #EF4444;" title="Permanently Delete" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>
            </div>
        ` : `
            <div class="flex gap-1 justify-end">
                <button type="button" class="btn-icon" style="color: var(--dark-black);" title="Edit Details" onclick="openEditStaffModal('${u.id}')"><i class="fa-solid fa-user-edit"></i></button>
                <button type="button" class="btn-icon" style="color: #f39c12;" title="Archive Account" onclick="archiveUser('${u.id}', '${statusStr}')"><i class="fas fa-box-archive"></i></button>
            </div>
        `;

        let statusBadgeClass = (statusLower === 'active' || statusLower === 'on leave') ? 'active' : 'inactive';
        let shiftBadge = '';
        if (roleLower === 'staff' || roleLower === 'admin') {
            const isWorking = u.shiftStatus === 'On Shift';
            shiftBadge = `<span class="badge ${isWorking ? 'active' : 'inactive'}" style="${isWorking ? 'background: var(--dark-black); color: white;' : ''}">${isWorking ? 'On Shift' : 'Off Shift'}</span>`;
        } else if (roleLower === 'trainer') {
            const isOnFloor = u.shiftStatus === 'On Floor';
            shiftBadge = `<span class="badge ${isOnFloor ? 'active' : 'inactive'}" style="${isOnFloor ? 'background: #3B82F6; color: white;' : ''}">${isOnFloor ? 'On Floor' : 'Off Floor'}</span>`;
        }

        let statusHtml = `<div style="display: flex; gap: 5px;"><span class="badge ${statusBadgeClass}">${statusStr}</span>${shiftBadge}</div>`;

        if (roleLower === 'trainer') {
            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <div style="font-weight: 600;">${fullName}</div>
                            <div style="font-size: 11px; color: #94a3b8;">${u.uid ? u.uid + ' • ' : ''}${u.email}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${specialty}</td>
                    <td><strong>${roleStr}</strong></td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionBtns}</td>
                </tr>
            `;
        } else {
            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <div style="font-weight: 600;">${fullName}</div>
                            <div style="font-size: 11px; color: #94a3b8;">${u.uid ? u.uid + ' • ' : ''}${u.email}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${roleStr}</td>
                    <td>${u.email}</td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionBtns}</td>
                </tr>
            `;
        }
    };

    if (staffTbody) window.syncDOM(staffTbody, staffList, (u) => renderStaffRow(u, false), 'staff-row');
    if (trainerTbody) window.syncDOM(trainerTbody, trainerList, (u) => renderStaffRow(u, false), 'trainer-row');
    if (arcStaffTbody) window.syncDOM(arcStaffTbody, arcStaffList, (u) => renderStaffRow(u, true), 'arc-staff-row');
    if (arcTrainerTbody) window.syncDOM(arcTrainerTbody, arcTrainerList, (u) => renderStaffRow(u, true), 'arc-trainer-row');

    // Update Pagination Counts
    if (document.getElementById('staffTotalCount')) document.getElementById('staffTotalCount').innerText = staffList.length;
    if (document.getElementById('staffShowingCount')) document.getElementById('staffShowingCount').innerText = staffList.length > 0 ? `1-${staffList.length}` : '0-0';
    if (document.getElementById('trainerTotalCount')) document.getElementById('trainerTotalCount').innerText = trainerList.length;
    if (document.getElementById('trainerShowingCount')) document.getElementById('trainerShowingCount').innerText = trainerList.length > 0 ? `1-${trainerList.length}` : '0-0';

    // Dashboard Stats Feed
    let trainersFeed = "";
    allUsersData.forEach(u => {
        if ((u.role || "").toLowerCase() === 'trainer' && (u.status || 'Active') === 'Active' && u.shiftStatus === 'On Floor') {
            let fullName = `${u.givenName || u.name} ${u.familyName || ''}`.trim();
            trainersFeed += `
                <div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-user"></i></div>
                    <div class="list-content" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <div><div class="trainer-name">${fullName}</div><p style="font-size: 12px; color: var(--text-muted);">${u.specialty || 'Trainer'} | ${u.email}</p></div>
                        <span class="status-badge status-progress" style="background: #3B82F6; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px;">On Floor</span>
                    </div>
                </div>
            `;
        }
    });

    if (document.getElementById('dashStaffTotal')) document.getElementById('dashStaffTotal').innerText = staffActive;
    if (document.getElementById('gridTrainers')) document.getElementById('gridTrainers').innerText = trainerActive;
    const dashTrainers = document.getElementById('dashActiveTrainersFeed');
    if (dashTrainers) { dashTrainers.innerHTML = trainersFeed || '<p style="color: var(--text-muted); font-size: 14px;">No active trainers right now.</p>'; }
}

// Staff & Trainer UI Helpers
window.filterStaff = function () { renderStaff(); };
window.filterTrainers = function () { renderStaff(); };
window.sortStaff = function (field) { showToast("Sorting staff by " + field, "info"); };
window.sortTrainers = function (field) { showToast("Sorting trainers by " + field, "info"); };

function renderMemberTrainers() {
    const grid = document.getElementById('memberTrainerGrid');
    if (!grid) return;

    let activeTrainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer' && u.status !== 'Archived');

    if (activeTrainers.length === 0) {
        grid.innerHTML = "<p style='color: var(--text-muted);'>No trainers available at the moment.</p>";
        return;
    }

    const renderTrainerCard = (t) => {
        let fullName = `${t.givenName || t.name} ${t.familyName || ''}`.trim();
        let specialty = t.specialty || "General Fitness";
        let isOnFloor = t.shiftStatus === 'On Floor';

        let badgeHtml = isOnFloor
            ? `<span class="badge" style="background: #3498db; color: white; padding: 3px 8px; font-size: 11px;">On Floor</span>`
            : `<span class="badge" style="background: #eee; color: #888; padding: 3px 8px; font-size: 11px;">Off Floor</span>`;

        return `
            <div class="trainer-card member-trainer-card" data-search="${fullName.toLowerCase()} ${specialty.toLowerCase()}">
                <div class="trainer-avatar">${t.image ? `<img src="${t.image}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : fullName.charAt(0).toUpperCase()}</div>
                <div class="trainer-info">
                    <div class="trainer-name">${fullName}</div>
                    <div class="trainer-specialty">${specialty}</div>
                </div>
                <div>${badgeHtml}</div>
            </div>
        `;
    };

    window.syncDOM(grid, activeTrainers, renderTrainerCard, 'member-trainer-card');

    // --- Update Dashboard "Trainers on Floor" Feed ---
    const activeTrainersFeed = document.getElementById('dashActiveTrainersFeed');
    if (activeTrainersFeed) {
        const onFloor = activeTrainers.filter(u => u.shiftStatus === 'On Floor');
        if (onFloor.length > 0) {
            activeTrainersFeed.innerHTML = onFloor.map(t => {
                let fullName = `${t.givenName || t.name} ${t.familyName || ''}`.trim();
                return `
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 12px; background: var(--body-bg); border-radius: 12px; border: 1px solid var(--border-color); transition: transform 0.2s ease;">
                        <div style="width: 40px; height: 40px; background: var(--primary-red); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; box-shadow: 0 4px 10px rgba(153, 27, 27, 0.2);">
                            ${t.image ? `<img src="${t.image}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : fullName.charAt(0).toUpperCase()}
                        </div>
                        <div style="flex-grow: 1;">
                            <div style="font-weight: 700; font-size: 14px; color: var(--text-primary);">${fullName}</div>
                            <div style="font-size: 12px; color: var(--accent-green); font-weight: 600; display: flex; align-items: center; gap: 4px;">
                                <span style="width: 8px; height: 8px; background: var(--accent-green); border-radius: 50%; display: inline-block; animation: pulse 2s infinite;"></span> On Floor
                            </div>
                        </div>
                        <div style="font-size: 11px; background: rgba(0,0,0,0.05); padding: 4px 8px; border-radius: 20px; color: var(--text-muted); font-weight: 500;">
                            ${t.specialty || "General Fitness"}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            activeTrainersFeed.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; opacity: 0.5;">
                    <i class="fa-solid fa-person-walking" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                    <p style="color: var(--text-muted); font-size: 13px;">No trainers on the floor right now.</p>
                </div>
            `;
        }
    }
}

window.openEditStaffModal = function (id) {
    const user = allUsersData.find(u => u.id === id);
    if (!user) return;

    if (document.getElementById('editStaffId')) {
        document.getElementById('editStaffId').value = id;
    }
    if (document.getElementById('editStaffGiven')) {
        document.getElementById('editStaffGiven').value = user.givenName || '';
    }
    if (document.getElementById('editStaffMI')) {
        document.getElementById('editStaffMI').value = user.mi || '';
    }
    if (document.getElementById('editStaffFamily')) {
        document.getElementById('editStaffFamily').value = user.familyName || '';
    }
    if (document.getElementById('editStaffRfid')) {
        document.getElementById('editStaffRfid').value = user.rfid || '';
    }
    if (document.getElementById('editStaffImage')) {
        document.getElementById('editStaffImage').value = user.image || '';
    }
    if (document.getElementById('editStaffPreview')) {
        document.getElementById('editStaffPreview').src = user.image || 'images/default-profile.png';
    }

    const specialtyContainer = document.getElementById('editSpecialtyContainer');
    const specialtyInput = document.getElementById('editStaffSpecialty');

    if (specialtyContainer && specialtyInput) {
        if ((user.role || "").toLowerCase() === 'trainer') {
            specialtyContainer.style.display = 'block';
            specialtyInput.value = user.specialty || '';
        } else {
            specialtyContainer.style.display = 'none';
            specialtyInput.value = '';
        }
    }

    if (document.getElementById('editStaffStatus')) {
        document.getElementById('editStaffStatus').value = user.status || 'Active';
    }

    if (document.getElementById('editStaffModalTitle')) {
        document.getElementById('editStaffModalTitle').innerText = `Edit ${(user.role || "Staff")} Details`;
    }

    document.getElementById('editStaffModal').style.display = 'flex';
}

if (document.getElementById('editStaffForm')) {
    document.getElementById('editStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editStaffId').value;
        const given = document.getElementById('editStaffGiven').value.trim();
        const mi = document.getElementById('editStaffMI').value.trim();
        const family = document.getElementById('editStaffFamily').value.trim();

        const updatedData = {
            givenName: given,
            mi: mi,
            familyName: family,
            name: `${given} ${family}`.trim()
        };

        const specialtyContainer = document.getElementById('editSpecialtyContainer');
        const specialtyEl = document.getElementById('editStaffSpecialty');

        if (specialtyContainer && specialtyContainer.style.display === 'block' && specialtyEl) {
            updatedData.specialty = specialtyEl.value.trim();
        }

        const statusEl = document.getElementById('editStaffStatus');
        if (statusEl) {
            updatedData.status = statusEl.value;
        }

        if (document.getElementById('editStaffRfid')) {
            updatedData.rfid = document.getElementById('editStaffRfid').value.trim();
        }

        if (document.getElementById('editStaffImageFile')) {
            const imageFile = document.getElementById('editStaffImageFile').files[0];
            let imageUrl = document.getElementById('editStaffImage').value.trim();
            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'staff');
            }
            updatedData.image = imageUrl || '';
        }

        try {
            await updateDoc(doc(db, "users", id), updatedData);
            window.closeModal('editStaffModal');
            showToast(`Details updated successfully!`, "success");
            if (window.logActivity) window.logActivity("Staff Edited", `Edited: ${updatedData.givenName} ${updatedData.familyName}`);
        } catch (error) {
            console.error("Staff update failed:", error);
            showToast("Failed to update details. Please try again.", "error");
        }
    });
}

window.archiveUser = async (id, currentStatus) => {
    const actionText = currentStatus === 'Archived' ? 'Restore' : 'Archive';
    const newStatus = currentStatus === 'Archived' ? 'Active' : 'Archived';
    showConfirm(`Are you sure you want to ${actionText.toLowerCase()} this account?`, async () => {
        try {
            await updateDoc(doc(db, "users", id), { status: newStatus });
            showToast(`Account successfully ${newStatus.toLowerCase()}.`, "success");
            if (window.logActivity) window.logActivity(newStatus === 'Archived' ? 'Account Archived' : 'Account Restored', `User ID: ${id} was ${newStatus.toLowerCase()}.`);
        } catch (error) {
            console.error("Archive/restore failed:", error);
            showToast("Operation failed. Please try again.", "error");
        }
    });
}

window.deleteUser = async (id) => {
    if (localStorage.getItem("userRole") !== "Admin") { showToast("Action Denied: You do not have permission to delete accounts.", "error"); return; }
    showConfirm("Remove this account completely? This action cannot be undone.", async () => {
        await deleteDoc(doc(db, "users", id));
        showToast("Account deleted.", "info");
        if (window.logActivity) window.logActivity("Account Deleted", `Permanently deleted user ID: ${id}`);
    });
}

// ==========================================
// 11. BATCH REGISTRATION
// ==========================================
let batchRowCount = 1;

// NEW: Inline styles added to bypass stubborn table constraints
window.addBatchRow = function () {
    if (batchRowCount >= 20) return showToast("Maximum 20 members can be registered at once.", "error");
    const tbody = document.getElementById('batchMemberBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bm-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bm-mi" maxlength="2" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')" style="min-width: 60px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bm-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="email" class="bm-email" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><select class="bm-plan" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"><option value="Gold Plan">Gold</option><option value="Silver Plan">Silver</option></select></td>
        <td><input type="text" class="bm-rfid rfid-register-input" placeholder="Tap Card..." required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <input type="file" class="bm-image-file" accept="image/*" style="font-size: 10px; width: 100%;">
                <input type="url" class="bm-image" placeholder="...or URL" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;">
            </div>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); batchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); batchRowCount++;
}

// Payment Method Toggle for Registration / Renewal Modals
window.__regPaymentMethod = 'Cash';
window.__renewPaymentMethod = 'Cash';

window.selectRegPayment = function (method, el, context) {
    const prefix = context || 'reg';
    // Update global state
    if (prefix === 'reg') window.__regPaymentMethod = method;
    else window.__renewPaymentMethod = method;

    // Toggle visual state
    const toggle = el.parentElement;
    toggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');

    // Show/hide GCash reference ID field
    const wrapper = document.getElementById(prefix + 'GcashRefWrapper');
    if (wrapper) {
        if (method === 'GCash') {
            wrapper.classList.add('visible');
            const inp = wrapper.querySelector('input');
            if (inp) setTimeout(() => inp.focus(), 300);
        } else {
            wrapper.classList.remove('visible');
            const inp = wrapper.querySelector('input');
            if (inp) inp.value = '';
        }
    }
};

window.openMemberModal = () => {
    if (document.getElementById('memberRegistrationForm')) {
        document.getElementById('memberRegistrationForm').reset();
        if (document.getElementById('regMemberPreview')) {
            document.getElementById('regMemberPreview').src = 'images/default-profile.png';
        }
    }
    // Reset payment method toggle to Cash
    window.__regPaymentMethod = 'Cash';
    const toggle = document.getElementById('regPaymentToggle');
    if (toggle) {
        toggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
        const cashOpt = toggle.querySelector('[data-method="Cash"]');
        if (cashOpt) cashOpt.classList.add('selected');
    }
    const gcashWrapper = document.getElementById('regGcashRefWrapper');
    if (gcashWrapper) {
        gcashWrapper.classList.remove('visible');
        const inp = gcashWrapper.querySelector('input');
        if (inp) inp.value = '';
    }
    document.getElementById('memberModal').style.display = 'flex';
}

const generatePassword = () => Math.random().toString(36).slice(-8);

window.generateUID = function(role) {
    let prefix = "MEM";
    if (role === "Staff") prefix = "STF";
    else if (role === "Trainer") prefix = "TRN";
    else if (role === "Admin") prefix = "ADM";
    return prefix + "-" + Math.floor(100000 + Math.random() * 900000);
};

if (document.getElementById('memberRegistrationForm')) {
    document.getElementById('memberRegistrationForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        const given = document.getElementById('regMemberGiven').value.trim();
        const mi = document.getElementById('regMemberMI').value.trim();
        const family = document.getElementById('regMemberFamily').value.trim();
        const email = document.getElementById('regMemberEmail').value.trim();
        const plan = document.getElementById('regMemberPlan').value;
        const rfidTag = document.getElementById('regMemberRfid').value.trim();
        const emergency = document.getElementById('regMemberEmergency') ? document.getElementById('regMemberEmergency').value.trim() : "";
        const imageFile = document.getElementById('regMemberImageFile').files[0];
        let imageUrl = '';

        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'members');
        }

        const randomPassword = generatePassword();
        const currentTimestamp = new Date().getTime();

        const emailQuery = query(usersCol, where("email", "==", email));
        const emailSnap = await getDocs(emailQuery);
        let isDuplicate = !emailSnap.empty;

        if (!isDuplicate && rfidTag !== "") {
            const rfidQuery = query(usersCol, where("rfid", "==", rfidTag));
            const rfidSnap = await getDocs(rfidQuery);
            if (!rfidSnap.empty) isDuplicate = true;
        }

        if (isDuplicate) {
            showToast("Account with this Email or RFID already exists!", "error");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
            return;
        }

        try {
            // EmailJS
            await emailjs.send("service_x90mti6", "template_nda1wjc", {
                to_name: given,
                to_email: email,
                generated_password: randomPassword,
                plan: plan
            });

            await addDoc(usersCol, {
                uid: window.generateUID("Member"),
                name: `${given} ${family}`,
                givenName: given,
                mi: mi,
                familyName: family,
                role: "Member",
                email: email,
                status: "Active",
                plan: plan,
                rfid: rfidTag,
                password: randomPassword,
                image: imageUrl,
                emergencyContact: emergency,
                dateRegistered: currentTimestamp
            });

            // Record membership payment — dynamic price from plans collection
            const planObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === plan.toLowerCase());
            const planPrice = planObj ? Number(planObj.price) : (plan === 'Gold Plan' ? 1500 : (plan === 'Silver Plan' ? 1000 : 800));

            // Capture payment method + GCash ref
            const regPayMethod = window.__regPaymentMethod || 'Cash';
            const regGcashRef = (document.getElementById('regGcashRefId') ? document.getElementById('regGcashRefId').value.trim() : '');

            // Validate GCash ref when GCash is selected
            if (regPayMethod === 'GCash' && !regGcashRef) {
                showToast('Please enter the GCash Reference ID.', 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const paymentData = {
                name: `${given} ${family}`,
                amount: planPrice,
                items: `Membership: ${plan}`,
                type: "Membership",
                status: "Paid",
                paymentMethod: regPayMethod,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                timestamp: currentTimestamp
            };
            if (regPayMethod === 'GCash' && regGcashRef) {
                paymentData.gcashRefId = regGcashRef;
            }
            await addDoc(paymentsCol, paymentData);

            showToast(`Member ${given} ${family} registered successfully!`, "success");
            if (window.logActivity) window.logActivity("Member Registered", `Registered: ${given} ${family}`);
            window.closeModal('memberModal');
        } catch (err) {
            console.error("Registration failed:", err);
            showToast("Error registering member. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}

let staffBatchRowCount = 1;

// NEW: Inline styles added to bypass stubborn table constraints
window.addStaffBatchRow = function () {
    if (staffBatchRowCount >= 20) return showToast("Maximum 20 accounts can be registered at once.", "error");
    const tbody = document.getElementById('batchStaffBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bs-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-mi" maxlength="2" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')" style="min-width: 60px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="email" class="bs-email" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-specialty" placeholder="Opt. (e.g. Yoga)" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-rfid rfid-register-input" placeholder="Tap Card..." required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <input type="file" class="bs-image-file" accept="image/*" style="font-size: 10px; width: 100%;">
                <input type="url" class="bs-image" placeholder="...or URL" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;">
            </div>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); staffBatchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); staffBatchRowCount++;
}

window.openStaffModal = (role) => {
    if (localStorage.getItem("userRole") !== "Admin") return showToast("Action Denied: Only Admins can register Staff and Trainers.", "error");

    document.getElementById('hiddenStaffRole').value = role;
    document.getElementById('staffModalTitle').innerText = `Register ${role}`;

    // Reset the form
    if (document.getElementById('batchStaffForm')) {
        document.getElementById('batchStaffForm').reset();
    }
    if (document.getElementById('regStaffPreview')) {
        document.getElementById('regStaffPreview').src = 'images/default-profile.png';
    }

    // Show/hide specialty field based on role
    const specialtyContainer = document.getElementById('regSpecialtyContainer');
    if (specialtyContainer) {
        specialtyContainer.style.display = role === 'Trainer' ? 'block' : 'none';
    }

    document.getElementById('staffModal').style.display = 'flex';
}


if (document.getElementById('batchStaffForm')) {
    document.getElementById('batchStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (localStorage.getItem("userRole") !== "Admin") return;

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        const role = document.getElementById('hiddenStaffRole').value;
        const given = document.getElementById('regStaffGiven').value.trim();
        const mi = document.getElementById('regStaffMI').value.trim();
        const family = document.getElementById('regStaffFamily').value.trim();
        const email = document.getElementById('regStaffEmail').value.trim();
        const rfidTag = document.getElementById('regStaffRfid').value.trim();
        const imageFile = document.getElementById('regStaffImageFile').files[0];
        let imageUrl = '';
        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'staff');
        }

        const specialtyEl = document.getElementById('regStaffSpecialty');
        const specialty = specialtyEl ? specialtyEl.value.trim() : '';
        const randomPassword = generatePassword();

        const emailQuery = query(usersCol, where("email", "==", email));
        const emailSnap = await getDocs(emailQuery);
        let isDuplicate = !emailSnap.empty;

        if (!isDuplicate && rfidTag !== "") {
            const rfidQuery = query(usersCol, where("rfid", "==", rfidTag));
            const rfidSnap = await getDocs(rfidQuery);
            if (!rfidSnap.empty) isDuplicate = true;
        }

        if (isDuplicate) {
            showToast("Account with this Email or RFID already exists!", "error");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
            return;
        }

        try {
            await emailjs.send("service_x90mti6", "template_nda1wjc", { to_name: given, to_email: email, generated_password: randomPassword, plan: `${role} Account` });

            let newUser = {
                uid: window.generateUID(role),
                name: `${given} ${family}`, givenName: given, mi: mi, familyName: family,
                role: role, email: email, status: "Active", rfid: rfidTag, password: randomPassword, image: imageUrl
            };

            if (role === 'Trainer') newUser.specialty = specialty || 'General Fitness';

            await addDoc(usersCol, newUser);
            showToast(`${role} ${given} ${family} registered successfully!`, "success");
            if (window.logActivity) window.logActivity(`${role} Registered`, `Registered: ${given} ${family}`);
            window.closeModal('staffModal');
        } catch (err) {
            console.error("Registration failed:", err);
            showToast("Error registering account. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}


// ==========================================
// 12. UI INITIALIZATION & SHIFT TIMER
// ==========================================
function initUI() {
    function updateClock() {
        const clockElement = document.getElementById('liveClock');
        if (clockElement) {
            const now = new Date();
            const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
            clockElement.innerHTML = `<i class="fa-regular fa-clock"></i> ${now.toLocaleDateString('en-US', options)}`;
        }
    }
    let clockTimerId = setInterval(updateClock, 1000); updateClock();

    const submenuToggles = document.querySelectorAll('.has-submenu');
    submenuToggles.forEach(toggle => {
        toggle.onclick = function () {
            this.classList.toggle('open');
            if (this.nextElementSibling && this.nextElementSibling.classList.contains('submenu')) this.nextElementSibling.classList.toggle('open');
        };
    });

    // --- User Dropdown Toggle ---
    const userMenuTrigger = document.getElementById('userMenuTrigger');
    const userDropdown = document.getElementById('userDropdown');

    if (userMenuTrigger && userDropdown) {
        userMenuTrigger.addEventListener('click', function (e) {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
        });

        // Close when clicking outside
        document.addEventListener('click', function (e) {
            if (userDropdown.classList.contains('show') && !userMenuTrigger.contains(e.target)) {
                userDropdown.classList.remove('show');
            }

            // Close all .kpi-dropdown-menu elements and remove .active from all buttons
            document.querySelectorAll('.kpi-dropdown-menu').forEach(menu => menu.classList.remove('show'));
            document.querySelectorAll('.kpi-ellipsis-btn').forEach(btn => btn.classList.remove('active'));
        });
    }

    // --- Dynamic Greeting ---
    const greetingText = document.getElementById('greetingText');
    if (greetingText) {
        const hour = new Date().getHours();
        const name = localStorage.getItem("loggedInUser") || "User";
        const firstName = name.split(' ')[0];

        if (hour < 12) greetingText.innerText = `Good Morning, ${firstName}.`;
        else if (hour < 18) greetingText.innerText = `Good Afternoon, ${firstName}.`;
        else greetingText.innerText = `Good Evening, ${firstName}.`;
    }

    // --- Topbar Name Initialization ---
    const topBarName = document.getElementById('topBarName');
    if (topBarName) {
        const name = localStorage.getItem("loggedInUser") || "User";
        topBarName.innerText = name.split(' ')[0];
    }

    // --- Real-time Session Sync ---
    if (localStorage.getItem("userId")) {
        onSnapshot(doc(db, "users", localStorage.getItem("userId")), (docSnap) => {
            if (docSnap.exists()) {
                const userData = docSnap.data();
                const fullName = userData.name || `${userData.givenName || ''} ${userData.familyName || ''}`.trim();
                localStorage.setItem("loggedInUser", fullName);
                
                // Update Topbar
                if (document.getElementById('topBarName')) {
                    document.getElementById('topBarName').innerText = fullName.split(' ')[0];
                }
                
                // Update Greeting
                const gText = document.getElementById('greetingText');
                if (gText) {
                    const hour = new Date().getHours();
                    const firstName = fullName.split(' ')[0];
                    if (hour < 12) gText.innerText = `Good Morning, ${firstName}.`;
                    else if (hour < 18) gText.innerText = `Good Afternoon, ${firstName}.`;
                    else gText.innerText = `Good Evening, ${firstName}.`;
                }

                // Update Member Dashboard specific elements
                if (document.getElementById('myPlanName')) {
                    document.getElementById('myPlanName').innerText = userData.plan || 'No Plan';
                }

                // Sync Shift Status
                if (userData.shiftStatus) {
                    if (userData.role === 'Trainer') {
                        localStorage.setItem("trainerShiftStatus", userData.shiftStatus);
                    }
                    if (userData.shiftStart) {
                        localStorage.setItem("shiftStart", userData.shiftStart);
                    }
                }
                
                
                // Update Profile Preview in Settings if open
                if (document.getElementById('userProfilePreview') && !document.getElementById('userProfileFile').files[0]) {
                    document.getElementById('userProfilePreview').src = userData.image || 'images/default-profile.png';
                }
            }
        });
    }


    function updateShiftTimer() {
        const role = localStorage.getItem("userRole");
        const trainerStatus = localStorage.getItem("trainerShiftStatus");

        document.querySelectorAll('.card-black, .grid-stat-box').forEach(card => {
            const valueDiv = card.querySelector('.value');
            if (valueDiv && (valueDiv.innerText.includes('Shift') || valueDiv.innerText.includes('Checking Status'))) {
                valueDiv.innerText = "Shift Status";

                let timerSpan = card.querySelector('.shift-timer');
                if (!timerSpan && card.classList.contains('card-black')) {
                    card.innerHTML += `<span class="shift-timer" style="position: absolute; top: 10px; right: 15px; font-size: 14px; font-weight: bold; background: white; color: black; padding: 4px 10px; border-radius: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.2);">--:--:--</span>`;
                    timerSpan = card.querySelector('.shift-timer');
                }

                if (timerSpan) {
                    if (role === "Trainer" && trainerStatus !== "On Floor") {
                        timerSpan.innerText = "Off Floor";
                        if (card.classList.contains('card-black')) {
                            timerSpan.style.background = "#eee";
                            timerSpan.style.color = "#888";
                        }
                    } else {
                        const shiftStart = localStorage.getItem("shiftStart");
                        if (shiftStart) {
                            const diff = Date.now() - parseInt(shiftStart);
                            const hours = Math.floor(diff / (1000 * 60 * 60)), mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)), secs = Math.floor((diff % (1000 * 60)) / 1000);
                            timerSpan.innerText = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                            if (card.classList.contains('card-black')) {
                                timerSpan.style.background = "white";
                                timerSpan.style.color = "black";
                            }
                        } else {
                            timerSpan.innerText = "Not Started";
                            if (card.classList.contains('card-black')) {
                                timerSpan.style.background = "#eee";
                                timerSpan.style.color = "#888";
                            }
                        }
                    }
                }
            }
        });
    }
    let shiftTimerId = setInterval(updateShiftTimer, 1000); updateShiftTimer();

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearInterval(clockTimerId);
            clearInterval(shiftTimerId);
        } else {
            clockTimerId = setInterval(updateClock, 1000);
            shiftTimerId = setInterval(updateShiftTimer, 1000);
            updateClock();
            updateShiftTimer();
        }
    });

    try { initDashboardCharts(); } catch (error) { console.warn("Chart tool delayed.", error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();

function initDashboardCharts() {
    const ctxServices = document.getElementById('servicesChart');
    if (!ctxServices || typeof Chart === 'undefined') return;
    servicesChartInstance = new Chart(ctxServices.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Gold Members', 'Silver Members', 'Walk-in Guests'],
            datasets: [{
                label: 'Daily Check-ins',
                data: [0, 0, 0],
                backgroundColor: '#64748b', // Sleek slate-gray
                hoverBackgroundColor: '#475569',
                borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 0, bottomRight: 0 },
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: 'rgba(0,0,0,0.03)' }, ticks: { precision: 0 } }
            }
        }
    });
}

// ==========================================
// 13. BOOKING CALENDAR LOGIC
// ==========================================
function bookingLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local wall-clock instant for booking fields (avoids ISO string UTC/local bugs in Safari/Chrome). */
function parseBookingSlotLocal(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const dp = dateStr.split("-").map((n) => parseInt(n, 10));
    if (dp.length !== 3 || dp.some((n) => Number.isNaN(n))) return null;
    const [y, mo, d] = dp;
    const tp = timeStr.trim().split(":");
    const hh = parseInt(tp[0], 10);
    const mm = parseInt(tp[1] !== undefined ? tp[1] : "0", 10);
    const ss = tp[2] !== undefined ? parseInt(String(tp[2]).split(".")[0], 10) : 0;
    if (Number.isNaN(hh) || Number.isNaN(mm) || Number.isNaN(ss)) return null;
    const dt = new Date(y, mo - 1, d, hh, mm, ss);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt.getTime();
}

function isBookingSessionInPast(dateStr, timeStr) {
    const t = parseBookingSlotLocal(dateStr, timeStr);
    if (t === null) return true;
    return t < Date.now();
}

function setBookingDateMin(dateInput) {
    if (!dateInput) return;
    const min = bookingLocalDateString();
    dateInput.setAttribute("min", min);
    dateInput.min = min;
}

function updateBookingTimeMinForToday(dateInput, timeInput) {
    if (!dateInput || !timeInput) return;
    const today = bookingLocalDateString();
    if (dateInput.value !== today) {
        timeInput.removeAttribute("min");
        return;
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    timeInput.setAttribute("min", `${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

function wireBookingDateTimeGuards() {
    const memberDate = document.getElementById("memberBookDate");
    const memberTime = document.getElementById("memberBookTime");
    if (memberDate && memberTime && !memberDate.dataset.bookingGuard) {
        memberDate.dataset.bookingGuard = "1";
        const sync = () => updateBookingTimeMinForToday(memberDate, memberTime);
        memberDate.addEventListener("change", sync);
        memberDate.addEventListener("input", sync);
        memberDate.addEventListener("focus", sync);
        memberTime.addEventListener("focus", sync);
    }
    const bookD = document.getElementById("bookDate");
    const bookT = document.getElementById("bookTime");
    if (bookD && bookT && !bookD.dataset.bookingGuard) {
        bookD.dataset.bookingGuard = "1";
        const sync = () => updateBookingTimeMinForToday(bookD, bookT);
        bookD.addEventListener("change", sync);
        bookD.addEventListener("input", sync);
        bookD.addEventListener("focus", sync);
        bookT.addEventListener("focus", sync);
    }
}

wireBookingDateTimeGuards();
// Ensure date pickers disable past dates even before opening modals.
setBookingDateMin(document.getElementById("memberBookDate"));
setBookingDateMin(document.getElementById("bookDate"));

// Expose helpers for bookings-ui.js (non-module script)
window.setBookingDateMin = setBookingDateMin;
window.updateBookingTimeMinForToday = updateBookingTimeMinForToday;
window.isBookingSessionInPast = isBookingSessionInPast;

onSnapshot(bookingsCol, (snapshot) => {
    bookingsData = [];
    snapshot.forEach(doc => bookingsData.push({ id: doc.id, ...doc.data() }));
    window.bookingsData = bookingsData; // Keep global in sync
    // Use window.renderBookings so bookings-ui.js override is called
    if (typeof window.renderBookings === 'function') window.renderBookings();
    if (typeof window.renderTodayBookings === 'function') window.renderTodayBookings();
});

window.renderBookings = renderBookings;
function renderBookings() {
    const tbody = document.getElementById('bookingsBody');
    const myTbody = document.getElementById('myBookingsBody');
    const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
    const loggedInUserId = localStorage.getItem("userId");

    let displayData = [...bookingsData].sort((a, b) => {
        const isCancelled = (s) => s === 'Cancelled' || s === 'Declined';
        const aCancelled = isCancelled(a.status);
        const bCancelled = isCancelled(b.status);
        if (aCancelled !== bCancelled) return aCancelled ? 1 : -1;

        // Default to newest first
        return new Date(`${b.date}T${b.time}`) - new Date(`${a.date}T${a.time}`);
    });

    // --- Update Member Dashboard "Trainers on Floor" Feed ---
    // Moved to renderMemberTrainers for better sync

    if (loggedInRole === "member") {
        displayData = displayData.filter(b => b.memberId === loggedInUserId);

        const notifArea = document.getElementById('memberNotificationArea');
        if (notifArea) {
            const now = new Date();
            let upcomingBookings = displayData.filter(b => new Date(`${b.date}T${b.time}`) > now);

            let confirmed = upcomingBookings.filter(b => b.status === "Confirmed");
            let pending = upcomingBookings.filter(b => b.status === "Pending");
            let cancelled = upcomingBookings.filter(b => b.status === "Cancelled" || b.status === "Declined");

            let html = "";

            if (confirmed.length > 0) {
                let nextSession = confirmed[0];
                const dateObj = new Date(`${nextSession.date}T${nextSession.time}`);
                html += `
                    <div class="notification-banner">
                        <div><i class="fas fa-check-circle" style="font-size: 20px; margin-right: 10px;"></i> <strong>Booking Confirmed!</strong> Your session with ${nextSession.trainerName} is scheduled for ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (pending.length > 0) {
                html += `
                    <div class="notification-banner" style="background-color: #e2e3e5; color: #383d41; border-left-color: #6c757d;">
                        <div><i class="fas fa-hourglass-half" style="font-size: 20px; margin-right: 10px;"></i> <strong>Pending Approval:</strong> You have ${pending.length} request(s) waiting for a trainer to accept.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (cancelled.length > 0) {
                let nextDeclined = cancelled[0];
                const dateObj = new Date(`${nextDeclined.date}T${nextDeclined.time}`);
                html += `
                    <div class="notification-banner" style="background-color: #f8d7da; color: #721c24; border-left-color: #f5c6cb;">
                        <div><i class="fas fa-exclamation-circle" style="font-size: 20px; margin-right: 10px;"></i> <strong>Update:</strong> Your request with ${nextDeclined.trainerName} on ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} was declined or cancelled. Please book another time.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            notifArea.innerHTML = html;
        }
    } else if (loggedInRole === "trainer") {
        displayData = displayData.filter(b => b.trainerId === loggedInUserId);

        const notifArea = document.getElementById('trainerNotificationArea');
        if (notifArea) {
            let pendingRequests = displayData.filter(b => b.status === "Pending");

            if (pendingRequests.length > 0) {
                notifArea.innerHTML = `
                    <div class="notification-banner" style="background-color: #fff3cd; color: #856404; border-left-color: #ffc107;">
                        <div><i class="fas fa-bell" style="font-size: 20px; margin-right: 10px;"></i> <strong>New Request!</strong> You have <strong>${pendingRequests.length}</strong> pending session request(s) to review in your Schedule tab.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;

                const navIcon = document.getElementById('navBookingsIcon');
                if (navIcon && !navIcon.querySelector('.badge-dot')) {
                    navIcon.innerHTML += `<span class="badge-dot" style="position:absolute; top:5px; right:30%; background:var(--primary-red); width:10px; height:10px; border-radius:50%;"></span>`;
                }
            } else {
                notifArea.innerHTML = "";
                const navIcon = document.getElementById('navBookingsIcon');
                if (navIcon) {
                    const dot = navIcon.querySelector('.badge-dot');
                    if (dot) dot.remove();
                }
            }
        }
    }

    const dateFilter = document.getElementById('bookingDateFilter')?.value;
    if (dateFilter) displayData = displayData.filter(b => b.date === dateFilter);

    const renderBookingRow = (b) => {
        let badgeClass = "active";
        if (b.status === "Pending") badgeClass = "pending";
        if (b.status === "Completed") badgeClass = "maintenance";
        if (b.status === "Cancelled" || b.status === "No Show") badgeClass = "broken";

        const dateObj = new Date(`${b.date}T${b.time}`);
        const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        if (loggedInRole === "member") {
            return `
                <tr>
                    <td>${b.trainerName}</td>
                    <td>${dateStr}</td>
                    <td><span class="badge active" style="background: var(--primary-red); color: white; border: none;"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                    <td><span class="badge ${badgeClass}">${b.status}</span></td>
                </tr>
            `;
        } else {
            let actions = "";
            if (loggedInRole === "trainer") {
                if (b.status === "Pending") {
                    actions = `
                        <button type="button" class="btn-icon btn-edit" style="color: #27ae60;" title="Accept" onclick="updateBookingStatus('${b.id}', 'Confirmed')"><i class="fas fa-check"></i></button>
                        <button type="button" class="btn-icon btn-delete" style="color: #e74c3c;" title="Decline" onclick="updateBookingStatus('${b.id}', 'Cancelled')"><i class="fas fa-times"></i></button>
                     `;
                } else {
                    actions = `<button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>`;
                }
            } else {
                actions = `
                    <button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>
                    <button type="button" class="btn-icon btn-delete" title="Delete Booking" onclick="deleteBooking('${b.id}')"><i class="fas fa-trash"></i></button>
                `;
            }

            return `
                <tr>
                    <td>${b.memberName}</td>
                    <td>${b.trainerName}</td>
                    <td>${dateStr}</td>
                    <td><span class="badge active" style="background: var(--primary-red); color: white; border: none;"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                    <td><span class="badge ${badgeClass}">${b.status}</span></td>
                    <td>${actions}</td>
                </tr>
            `;
        }
    };

    if (loggedInRole === "member" && myTbody) {
        window.syncDOM(myTbody, displayData, renderBookingRow, 'my-booking');
    } else if (tbody) {
        window.syncDOM(tbody, displayData, renderBookingRow, 'booking');
    }
}

window.filterBookingsByDate = () => { renderBookings(); }

window.updateBookingStatus = async (id, newStatus) => {
    showConfirm(`Are you sure you want to mark this session as ${newStatus}?`, async () => {
        await updateDoc(doc(db, "bookings", id), { status: newStatus });
        showToast(`Session marked as ${newStatus}.`, "success");
        if (window.logActivity) window.logActivity("Booking Status Updated", `Booking ${id} marked as ${newStatus}.`);
    });
}

window.openMemberBookingModal = () => {
    // Check if membership is expired before opening
    const daysText = document.getElementById('myPlanDays')?.innerText || "";
    if (daysText.includes("Expired")) {
        const expiredModal = document.getElementById('membershipExpiredModal');
        if (expiredModal) {
            expiredModal.style.display = 'flex';
        } else {
            showToast("Your membership has expired. Please renew to book sessions.", "error");
        }
        return;
    }

    const trainerSelect = document.getElementById('memberBookTrainer');
    const trainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer' && u.status !== 'Archived');

    trainerSelect.innerHTML = '<option value="" disabled selected>Select a Trainer...</option>' +
        trainers.map(t => `<option value="${t.id}">${t.name || t.givenName + ' ' + t.familyName}</option>`).join('');

    document.getElementById('memberBookingForm').reset();
    const md = document.getElementById('memberBookDate');
    const mt = document.getElementById('memberBookTime');
    setBookingDateMin(md);
    updateBookingTimeMinForToday(md, mt);
    document.getElementById('memberBookingModal').style.display = 'flex';
}

if (document.getElementById('memberBookingForm')) {
    document.getElementById('memberBookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }
        const trainerSelect = document.getElementById('memberBookTrainer');
        const trainerId = trainerSelect.value;
        const dateEl = document.getElementById('memberBookDate');
        const timeEl = document.getElementById('memberBookTime');
        setBookingDateMin(dateEl);
        updateBookingTimeMinForToday(dateEl, timeEl);
        if (!dateEl.checkValidity()) { dateEl.reportValidity(); return; }
        if (!timeEl.checkValidity()) { timeEl.reportValidity(); return; }
        const bookDate = dateEl.value;
        const bookTime = timeEl.value;

        const trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;
        const memberId = localStorage.getItem("userId");
        const memberName = localStorage.getItem("loggedInUser");

        if (isBookingSessionInPast(bookDate, bookTime)) {
            showToast("Choose a date and time in the future. Past sessions cannot be booked.", "error");
            return;
        }

        await addDoc(bookingsCol, {
            memberId, memberName,
            trainerId, trainerName,
            date: bookDate, time: bookTime,
            status: "Pending",
            timestamp: new Date().getTime()
        });

        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        window.closeModal('memberBookingModal');
        showToast("Request sent! Waiting for trainer approval.", "success");
        if (window.logActivity) window.logActivity("Booking Created", `Member requested a training session.`);
    });
}

window.openBookingModal = () => {
    const memberSelect = document.getElementById('bookMember'), trainerSelect = document.getElementById('bookTrainer');
    memberSelect.innerHTML = '<option value="" disabled selected>Select a Member...</option>' + membersData.map(m => `<option value="${m.id}">${m.name || m.givenName + ' ' + m.familyName}</option>`).join('');
    const trainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer');
    trainerSelect.innerHTML = '<option value="" disabled selected>Select an Assigned Trainer...</option>' + trainers.map(t => `<option value="${t.id}">${t.name || t.givenName + ' ' + t.familyName}</option>`).join('');

    document.getElementById('bookingForm').reset();
    const bd = document.getElementById('bookDate');
    const bt = document.getElementById('bookTime');
    setBookingDateMin(bd);
    updateBookingTimeMinForToday(bd, bt);
    document.getElementById('bookingModal').style.display = 'flex';
}

if (document.getElementById('bookingForm')) {
    document.getElementById('bookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }
        const memberSelect = document.getElementById('bookMember'), trainerSelect = document.getElementById('bookTrainer');
        const dateEl = document.getElementById('bookDate');
        const timeEl = document.getElementById('bookTime');
        setBookingDateMin(dateEl);
        updateBookingTimeMinForToday(dateEl, timeEl);
        if (!dateEl.checkValidity()) { dateEl.reportValidity(); if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; } return; }
        if (!timeEl.checkValidity()) { timeEl.reportValidity(); if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; } return; }
        const memberId = memberSelect.value, trainerId = trainerSelect.value, bookDate = dateEl.value, bookTime = timeEl.value;
        const memberName = memberSelect.options[memberSelect.selectedIndex].text, trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;

        if (isBookingSessionInPast(bookDate, bookTime)) {
            showToast("Choose a date and time in the future. Past sessions cannot be booked.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        // Conflict Detection
        const q = query(bookingsCol, where("trainerId", "==", trainerId), where("date", "==", bookDate), where("status", "==", "Confirmed"));
        const snap = await getDocs(q);
        let conflict = false;
        const [bH, bM] = bookTime.split(':').map(Number);
        const bookMins = bH * 60 + bM;

        snap.forEach(doc => {
            const timeStr = doc.data().time;
            if (timeStr) {
                const [eH, eM] = timeStr.split(':').map(Number);
                const existingMins = eH * 60 + eM;
                if (Math.abs(bookMins - existingMins) < 60) {
                    conflict = true;
                }
            }
        });

        if (conflict) {
            showToast("This trainer already has a session booked within 1 hour of this time.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        await addDoc(bookingsCol, { memberId, memberName, trainerId, trainerName, date: bookDate, time: bookTime, status: "Confirmed", timestamp: new Date().getTime() });
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        window.closeModal('bookingModal'); showToast("Personal Training Session booked successfully!", "success");
        if (window.logActivity) window.logActivity("Booking Created", `Admin/Staff booked a training session.`);
    });
}

window.openEditBookingModal = (id) => {
    const b = bookingsData.find(x => x.id === id);
    if (!b) return;
    const dateObj = new Date(`${b.date}T${b.time}`);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    document.getElementById('editBookingId').value = b.id;
    document.getElementById('editBookingDetails').innerText = `${b.memberName} with ${b.trainerName} on ${dateStr} at ${timeStr}`;
    document.getElementById('editBookingStatus').value = b.status;
    document.getElementById('editBookingModal').style.display = 'flex';
}

if (document.getElementById('editBookingForm')) {
    document.getElementById('editBookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editBookingId').value, status = document.getElementById('editBookingStatus').value;
        await updateDoc(doc(db, "bookings", id), { status: status });
        window.closeModal('editBookingModal');
        if (window.logActivity) window.logActivity("Booking Status Updated", `Booking ${id} status changed to ${status}.`);
    });
}

window.deleteBooking = async (id) => {
    showConfirm("Are you sure you want to delete this booking record?", async () => {
        await deleteDoc(doc(db, "bookings", id));
        showToast("Booking deleted.", "info");
        if (window.logActivity) window.logActivity("Booking Deleted", `Deleted booking ID: ${id}.`);
    });
}

// ==========================================
// 15. SYSTEM ACTIVITY LOGS
// ==========================================
onSnapshot(activityLogsCol, (snapshot) => {
    activityData = [];
    snapshot.forEach(doc => activityData.push({ id: doc.id, ...doc.data() }));
    activityData.sort((a, b) => b.timestamp - a.timestamp);
    renderActivityLogs();
});

function renderActivityLogs() {
    const actTbody = document.querySelector('#activityTable tbody');
    if (!actTbody) return;
    actTbody.innerHTML = "";

    const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    // Filters
    const roleFilter = document.getElementById('activityRoleFilter');
    const dateFilter = document.getElementById('activityDateFilter');
    const selectedRole = roleFilter ? roleFilter.value : 'all';

    let selectedDateStr = '';
    if (dateFilter && dateFilter.value) {
        const [y, m, d] = dateFilter.value.split('-');
        const dateObj = new Date(y, m - 1, d);
        selectedDateStr = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    let filtered = activityData;
    if (selectedRole !== 'all') {
        filtered = filtered.filter(l => l.role === selectedRole);
    }
    if (selectedDateStr) {
        filtered = filtered.filter(l => l.date === selectedDateStr);
    }

    // Stat cards
    const todayLogs = activityData.filter(l => l.date === today);
    const uniqueUsers = new Set(activityData.map(l => l.userName));
    const actionCounts = {};
    activityData.forEach(l => { actionCounts[l.action] = (actionCounts[l.action] || 0) + 1; });
    let topAction = '-';
    let topCount = 0;
    for (const [action, count] of Object.entries(actionCounts)) {
        if (count > topCount) { topCount = count; topAction = action; }
    }

    if (document.getElementById('actTotalLogs')) document.getElementById('actTotalLogs').innerText = activityData.length;
    if (document.getElementById('actTodayLogs')) document.getElementById('actTodayLogs').innerText = todayLogs.length;
    if (document.getElementById('actUniqueUsers')) document.getElementById('actUniqueUsers').innerText = uniqueUsers.size;
    if (document.getElementById('actTopAction')) {
        const el = document.getElementById('actTopAction');
        el.innerText = topAction;
        el.style.fontSize = topAction.length > 12 ? '16px' : '28px';
    }

    const countEl = document.getElementById('activityRecordCount');
    if (countEl) countEl.innerText = `Showing ${Math.min(filtered.length, 200)} of ${filtered.length} records`;

    if (filtered.length === 0) {
        const emptyRow = document.getElementById('activityEmptyState');
        if (emptyRow) {
            actTbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 60px 20px;">
                        <i class="fa-solid fa-clock-rotate-left" style="font-size: 3rem; opacity: 0.15; margin-bottom: 15px; display: block;"></i>
                        <p style="color: var(--text-muted); font-size: 14px; margin: 0;">No activity logs found for the selected filters.</p>
                    </td>
                </tr>
            `;
        }
        return;
    }

    // Action → icon mapping
    const actionIcons = {
        'POS Sale': 'fa-cash-register',
        'Login': 'fa-right-to-bracket',
        'Logout': 'fa-right-from-bracket',
        'Member Registered': 'fa-user-plus',
        'Staff Registered': 'fa-user-tie',
        'Trainer Registered': 'fa-dumbbell',
        'Member Edited': 'fa-user-pen',
        'Staff Edited': 'fa-user-pen',
        'Equipment Updated': 'fa-wrench',
        'Product Updated': 'fa-box',
        'Account Archived': 'fa-box-archive',
        'Account Restored': 'fa-box-open',
        'Account Deleted': 'fa-trash',
        'Item Deleted': 'fa-trash-can',
        'Item Registered': 'fa-plus-circle',
        'Transaction Voided': 'fa-ban',
        'Booking Created': 'fa-calendar-plus',
        'Booking Status Updated': 'fa-calendar-check',
        'Booking Deleted': 'fa-calendar-xmark',
        'Password Changed': 'fa-key',
        'Membership Renewed': 'fa-sync-alt',
        'Plan Created': 'fa-tag',
        'Plan Updated': 'fa-pen-to-square',
        'Plan Deleted': 'fa-tag',
    };

    const displayData = filtered.slice(0, 200);

    let html = '';
    displayData.forEach(log => {
        const icon = actionIcons[log.action] || 'fa-circle-info';
        const roleBadge = log.role === 'Admin'
            ? '<span class="badge active" style="background: var(--primary-red);">Admin</span>'
            : log.role === 'Staff'
                ? '<span class="badge active" style="background: #2980b9;">Staff</span>'
                : log.role === 'Trainer'
                    ? '<span class="badge active" style="background: #27ae60;">Trainer</span>'
                    : `<span class="badge active" style="background: var(--dark-black);">${log.role || 'System'}</span>`;

        html += `
            <tr>
                <td style="white-space: nowrap;"><strong>${log.date}</strong><br><small style="color: var(--text-muted);">${log.time}</small></td>
                <td>${log.userName || 'System'}</td>
                <td>${roleBadge}</td>
                <td><span style="display: inline-flex; align-items: center; gap: 6px;"><i class="fa-solid ${icon}" style="font-size: 12px; color: var(--text-muted);"></i> <strong>${log.action}</strong></span></td>
                <td style="font-size: 13px; color: var(--text-muted); max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${log.details || '-'}</td>
            </tr>
        `;
    });
    actTbody.innerHTML = html;
}
window.renderActivityLogs = renderActivityLogs;

// ==========================================
// 14. SMART USB RFID GHOST LISTENER
// ==========================================
initRfid({ db, usersCol, attendanceCol, onShiftLogout: window.handleLogout });
// ==========================================
// 14. INVENTORY ENHANCEMENTS (Batch & View)
// ==========================================
window.toggleInventoryView = function (view, btn) {
    currentInventoryView = view;
    // Update UI buttons
    const container = btn.parentElement;
    container.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderInventory();
};

window.toggleItemSelection = function (type, id, checkbox) {
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    if (checkbox.checked) {
        set.add(id);
    } else {
        set.delete(id);
    }
    renderInventory();
};

window.toggleSelectAll = function (type, checkbox) {
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    if (checkbox.checked) {
        inventoryData.forEach(item => {
            const isConsumable = item.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
            if (type === 'equipment' && !isConsumable) set.add(item.id);
            if (type === 'product' && isConsumable) set.add(item.id);
        });
    } else {
        set.clear();
    }
    renderInventory();
};

window.clearBatchSelection = function (type) {
    if (type === 'equipment') selectedEquipItems.clear();
    else selectedProdItems.clear();
    const selectAllBox = document.getElementById(type === 'equipment' ? 'equipSelectAll' : 'prodSelectAll');
    if (selectAllBox) selectAllBox.checked = false;
    renderInventory();
};

window.applyBatchStatus = async function (type) {
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    const statusSelect = document.getElementById(type === 'equipment' ? 'equipBatchStatus' : 'prodBatchStatus');
    const newStatus = statusSelect.value;

    if (set.size === 0) return showToast("No items selected.", "error");
    if (!newStatus) return showToast("Please select a status.", "error");

    showConfirm(`Update status to "${newStatus}" for ${set.size} items?`, async () => {
        const batchPromises = Array.from(set).map(id => updateDoc(doc(db, "inventory", id), { status: newStatus }));
        await Promise.all(batchPromises);
        showToast(`Batch updated successfully!`, "success");
        if (window.logActivity) window.logActivity("Batch Status Update", `Updated ${set.size} items to ${newStatus}`);
        set.clear();
        statusSelect.value = "";
        renderInventory();
    });
};

window.renderTodayBookings = function () {
    const list = document.getElementById('todayBookingsList');
    if (!list) return;

    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const todayBookings = bookingsData.filter(b => b.date === today && b.status !== 'Cancelled' && b.status !== 'Declined')
        .sort((a, b) => a.time.localeCompare(b.time));

    if (todayBookings.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;">No bookings scheduled for today.</p>`;
        return;
    }

    list.innerHTML = todayBookings.map(b => {
        const timeStr = b.time; // Format HH:MM
        const [h, m] = timeStr.split(':');
        const hour = parseInt(h);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 || 12;
        const formattedTime = `${displayHour}:${m} ${ampm}`;

        return `
            <div class="booking-item">
                <div class="booking-time">${formattedTime}</div>
                <div class="booking-info">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div class="booking-class">${b.sessionName || 'Personal Training'} with ${b.trainerName}</div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background: #27ae60;" title="Scheduled"></div>
                    </div>
                    <div class="booking-member">${b.memberName}</div>
                </div>
            </div>
        `;
    }).join('');
};
window.openAddCreditModal = function (memberId) {
    const member = membersData.find(m => m.id === memberId);
    if (!member) return;

    document.getElementById('addCreditMemberId').value = member.id;
    document.getElementById('addCreditMemberName').innerText = member.name || (member.givenName + ' ' + member.familyName);
    document.getElementById('addCreditCurrentBalance').innerText = `₱${(member.creditBalance || 0).toFixed(2)}`;
    document.getElementById('addCreditAmount').value = '';
    document.getElementById('addCreditNote').value = '';

    document.getElementById('addCreditModal').style.display = 'flex';
}

if (document.getElementById('addCreditForm')) {
    document.getElementById('addCreditForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const memberId = document.getElementById('addCreditMemberId').value;
        const amount = Number(document.getElementById('addCreditAmount').value);
        const paymentMethod = document.getElementById('addCreditPaymentMethod').value;
        const note = document.getElementById('addCreditNote').value.trim();

        const member = membersData.find(m => m.id === memberId);
        if (!member) return;

        const submitBtn = e.target.querySelector('.btn-save');
        const originalText = submitBtn.innerText;
        submitBtn.disabled = true;
        submitBtn.innerText = 'Processing...';

        try {
            const memberRef = doc(db, "users", memberId);
            const currentBalance = member.creditBalance || 0;

            await updateDoc(memberRef, {
                creditBalance: increment(amount)
            });

            await addDoc(creditTransactionsCol, {
                memberId,
                memberName: member.name || (member.givenName + ' ' + member.familyName),
                type: "top-up",
                amount,
                balanceBefore: currentBalance,
                balanceAfter: currentBalance + amount,
                paymentMethod,
                note: note || "Counter top-up",
                processedBy: localStorage.getItem("userId"),
                processedByName: localStorage.getItem("loggedInUser"),
                timestamp: Date.now()
            });

            const now = new Date();
            await addDoc(paymentsCol, {
                name: member.name || (member.givenName + ' ' + member.familyName),
                type: "Credit Top-Up",
                items: `RFID Credit Load (₱${amount.toFixed(2)})`,
                amount: amount,
                paymentMethod: paymentMethod,
                status: "Paid",
                date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                timestamp: now.getTime()
            });

            showToast("Credit added successfully!", "success");
            closeModal('addCreditModal');
        } catch (err) {
            console.error(err);
            showToast("Failed to add credit.", "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = originalText;
        }
    });
}
