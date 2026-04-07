// ==========================================
// 1. IMPORT FIREBASE DEPENDENCIES
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
            
            // Kick out duplicate logins
            if (userData.currentSession && userData.currentSession !== currentSessionId) {
                alert("Session Override: Your account was just logged in from another device. Logging out here to protect your data.");
                localStorage.removeItem("loggedInUser");
                localStorage.removeItem("userRole");
                localStorage.removeItem("userRfid"); 
                localStorage.removeItem("userId"); 
                localStorage.removeItem("shiftStart"); 
                localStorage.removeItem("sessionId");
                localStorage.removeItem("trainerShiftStatus");
                window.location.replace("index.html");
            }
            
            // Update Member UI dynamically
            if (currentUserRole === "Member") {
                if (document.getElementById('myPlanName')) document.getElementById('myPlanName').innerText = userData.plan || "Standard Plan";
                if (document.getElementById('myPlanDays') && userData.dateRegistered) {
                    const now = new Date().getTime();
                    const expiryDate = userData.dateRegistered + (30 * 24 * 60 * 60 * 1000); 
                    const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                    document.getElementById('myPlanDays').innerHTML = `<i class="fa-regular fa-clock"></i> ${diffDays > 0 ? diffDays + ' Days Left' : 'Expired'}`;
                }
            }

            // Automatically start/stop Trainer Shift Timer based on "On Floor" status
            if (currentUserRole === "Trainer") {
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

window.handleLogout = async function() {
    const userId = localStorage.getItem("userId");
    const userRole = localStorage.getItem("userRole");
    
    if (userId) {
        try {
            let updateData = { currentSession: null };
            if (userRole === "Admin" || userRole === "Staff" || userRole === "Trainer") {
                updateData.shiftStatus = "Off Shift"; 
            }
            await updateDoc(doc(db, "users", userId), updateData);
        } catch (error) {
            console.error("Failed to update session/shift status:", error);
        }
    }

    localStorage.clear(); // Clears all local storage variables securely
    window.location.replace("index.html"); 
};

window.switchTab = function(tabId, element) {
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
        'chats': 'Internal Messages'
    };
    
    if (document.getElementById('pageTitle')) {
        document.getElementById('pageTitle').innerText = titles[tabId] || 'Dashboard';
    }
}

window.closeModal = function(modalId) { document.getElementById(modalId).style.display = 'none'; }
window.exportInventoryReport = function() { window.print(); }

window.filterTable = function(tableId, inputId) {
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
        } else {
            if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        }
    }
}

window.filterByPlan = function(val) {
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

window.filterGrid = function(gridId, inputId) {
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
let bookingsData = [];
let posCart = []; 

let currentChatUser = null;
let currentChatRoleFilter = 'all';

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");
const usersCol = collection(db, "users");
const attendanceCol = collection(db, "attendance");
const messagesCol = collection(db, "messages");
const bookingsCol = collection(db, "bookings");

let servicesChartInstance = null;

// ==========================================
// 6. INTERNAL MESSENGER LOGIC
// ==========================================
window.openChatTab = function(role, element, title) {
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

window.filterChatUsers = function() {
    const filter = document.getElementById('chatSearch').value.toLowerCase();
    const users = document.querySelectorAll('.chat-user-item');
    users.forEach(user => {
        const name = user.getAttribute('data-name');
        if (name.includes(filter)) user.style.display = "flex";
        else user.style.display = "none";
    });
}

window.openChat = function(userName) {
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
    ).sort((a,b) => a.timestamp - b.timestamp);
    
    if (relevantMsgs.length === 0) {
        hist.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-top: auto; margin-bottom: auto;"><p>Say hello to ${currentChatUser}!</p></div>`;
        return;
    }

    hist.innerHTML = relevantMsgs.map(m => {
        const isMe = m.sender === myName;
        const time = new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        return `
            <div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">
                <div>${m.text}</div>
                <div class="msg-time">${time}</div>
            </div>
        `;
    }).join('');
    hist.scrollTop = hist.scrollHeight; 
}

window.sendMessage = async function() {
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

function renderInventory() {
    const equipGrid = document.getElementById('machinesGrid');
    const prodGrid = document.getElementById('productsGrid');
    if (!equipGrid || !prodGrid) return;

    equipGrid.innerHTML = "";
    prodGrid.innerHTML = "";
    let alertsHtml = "";
    let ops = 0, maint = 0, low = 0, totalMachines = 0;

    inventoryData.forEach((item) => {
        let isConsumable = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        let currentStatus = item.status || (isConsumable ? 'In Stock' : 'Operational');
        let badge = 'operational';
        let isProblematic = false;

        if (item.qty === 0) { currentStatus = "Out of Stock"; badge = 'broken'; isProblematic = true; } 
        else if (item.qty <= 5) {
            if (currentStatus !== 'Maintenance' && currentStatus !== 'Out of Order') { currentStatus = "Low Stock"; badge = 'stock-low'; isProblematic = true; low++; }
        } 
        else if (currentStatus === 'Maintenance') { badge = 'maintenance'; maint++; isProblematic = true; } 
        else if (currentStatus === 'Out of Order') { badge = 'broken'; isProblematic = true; }
        
        if (currentStatus === 'Operational' || currentStatus === 'In Stock') ops++;
        if (!isConsumable) totalMachines++;

        const iconHtml = getCategoryIcon(item.cat);
        let actionButtons = !isConsumable ? `
                <button class="btn-icon btn-edit" title="Edit" onclick="openEditEquipModal('${item.id}')"><i class="fas fa-edit"></i></button>
                <button class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>
            ` : `<button class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>`;

        let cardHTML = `
            <div class="inventory-card inventory-item-filter" data-search="${item.name.toLowerCase()} ${item.cat.toLowerCase()} ${currentStatus.toLowerCase()}">
                <div class="inventory-icon-box">${iconHtml}</div>
                <div class="inventory-details">
                    <div class="inventory-title">${item.name}</div>
                    <div class="inventory-category">${item.cat}</div>
                    <div class="inventory-desc">
                        ${item.size ? `Size/Vol: <strong>${item.size}</strong><br>` : ''}
                        ${isConsumable && item.expiry ? `Expiry: <strong>${item.expiry}</strong><br>` : ''}
                        Qty: <strong>${item.qty} units</strong>
                    </div>
                    <div class="inventory-meta"><span class="badge ${badge}">${currentStatus}</span></div>
                </div>
                <div class="card-actions">${actionButtons}</div>
            </div>
        `;

        if (isConsumable) prodGrid.innerHTML += cardHTML;
        else equipGrid.innerHTML += cardHTML;

        if (isProblematic) {
            alertsHtml += `
                <div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div class="list-content"><h4>Status: ${currentStatus}</h4><p><strong>${item.name}</strong> requires attention.</p></div>
                </div>
            `;
        }
    });

    if (document.getElementById('dashInventoryTotal')) document.getElementById('dashInventoryTotal').innerText = inventoryData.length;
    if (document.getElementById('gridEquip')) document.getElementById('gridEquip').innerText = ops;
    if (document.getElementById('navInventoryCount')) document.getElementById('navInventoryCount').innerText = ` ${inventoryData.length} `;
    if (document.getElementById('dashInventoryAlerts')) document.getElementById('dashInventoryAlerts').innerHTML = alertsHtml || '<p style="color: green; font-size: 14px;">All systems operational!</p>';
}

window.openEquipmentModal = () => { document.getElementById('equipmentForm').reset(); document.getElementById('equipmentModal').style.display = 'flex'; }
window.openProductModal = () => { document.getElementById('productForm').reset(); document.getElementById('productModal').style.display = 'flex'; }
window.deleteInventoryItem = async (id) => { if (confirm("Delete this inventory item?")) await deleteDoc(doc(db, "inventory", id)); }

window.openEditEquipModal = function(id) {
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    document.getElementById('editEquipId').value = item.id;
    document.getElementById('editEquipName').value = item.name;
    document.getElementById('editEquipCategory').value = item.cat;
    document.getElementById('editEquipSize').value = item.size;
    document.getElementById('editEquipQty').value = item.qty;
    document.getElementById('editEquipStatus').value = item.status || 'Operational';
    document.getElementById('editEquipModal').style.display = 'flex';
}

if (document.getElementById('editEquipForm')) {
    document.getElementById('editEquipForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editEquipId').value;
        const updatedData = {
            name: document.getElementById('editEquipName').value.trim(),
            cat: document.getElementById('editEquipCategory').value,
            size: document.getElementById('editEquipSize').value,
            qty: Number(document.getElementById('editEquipQty').value),
            status: document.getElementById('editEquipStatus').value
        };
        await updateDoc(doc(db, "inventory", id), updatedData);
        window.closeModal('editEquipModal');
        alert("Equipment updated successfully!");
    });
}

async function handleInventorySubmit(e, isProduct) {
    e.preventDefault();
    const nameStr = document.getElementById(isProduct ? 'prodName' : 'equipName').value.trim();
    const addQty = Number(document.getElementById(isProduct ? 'prodQty' : 'equipQty').value);
    const existingItem = inventoryData.find(i => i.name.toLowerCase() === nameStr.toLowerCase());

    if (existingItem) {
        await updateDoc(doc(db, "inventory", existingItem.id), { qty: existingItem.qty + addQty });
        alert(`Automated Update: Added ${addQty} units to existing stock. New Total: ${existingItem.qty + addQty} units.`);
    } else {
        const newItem = { 
            name: nameStr, cat: document.getElementById(isProduct ? 'prodCategory' : 'equipCategory').value, size: document.getElementById(isProduct ? 'prodVol' : 'equipSize').value, 
            qty: addQty, status: isProduct ? 'In Stock' : 'Operational', price: isProduct ? Number(document.getElementById('prodPrice').value) : 0, expiry: isProduct ? document.getElementById('prodExpiry').value : null
        };
        await addDoc(inventoryCol, newItem);
        alert(`New ${isProduct ? 'product' : 'equipment'} registered successfully!`);
    }
    window.closeModal(isProduct ? 'productModal' : 'equipmentModal');
}

if (document.getElementById('equipmentForm')) document.getElementById('equipmentForm').addEventListener('submit', (e) => handleInventorySubmit(e, false));
if (document.getElementById('productForm')) document.getElementById('productForm').addEventListener('submit', (e) => handleInventorySubmit(e, true));

// ==========================================
// 8. POINT OF SALE (POS) LOGIC
// ==========================================
function renderPOSProducts() {
    const posBody = document.getElementById('posProductList');
    if (!posBody) return;
    
    posBody.innerHTML = `
        <tr style="background-color: #fff9e6;">
            <td><strong>Walk-in Gym Access (Day Pass)</strong></td><td>Unlimited</td><td>₱150.00</td>
            <td><button class="action-btn" style="padding: 5px 10px; background-color: var(--dark-black);" onclick="addToCart('WALKIN', 'Walk-in Gym Access', 150, 999)">Add</button></td>
        </tr>
    `;
    
    inventoryData.forEach(item => {
        let isConsumable = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        if (isConsumable && item.qty > 0) {
            let price = item.price || 0;
            posBody.innerHTML += `
                <tr>
                    <td>${item.name}</td><td>${item.qty}</td><td>₱${price.toFixed(2)}</td>
                    <td><button class="action-btn" style="padding: 5px 10px;" onclick="addToCart('${item.id}', '${item.name}', ${price}, ${item.qty})">Add</button></td>
                </tr>
            `;
        }
    });
}

window.addToCart = function(id, name, price, maxQty) {
    let existing = posCart.find(i => i.id === id);
    if (existing) { if (existing.qty < maxQty) existing.qty++; else alert("Not enough stock available!"); } 
    else { posCart.push({id, name, price, qty: 1, maxQty}); }
    renderCart();
}

window.removeFromCart = function(id) { posCart = posCart.filter(i => i.id !== id); renderCart(); }

function renderCart() {
    const cartBody = document.getElementById('posCartBody');
    if (!cartBody) return;
    if (posCart.length === 0) { cartBody.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top: 50px;">Cart is empty.</p>`; updatePOSTotals(0, 0, 0, 0); return; }

    cartBody.innerHTML = posCart.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 10px;">
            <div style="flex-grow:1;"><strong>${item.name}</strong><br><small>₱${item.price} x ${item.qty}</small></div>
            <div style="font-weight: bold; margin-right: 15px;">₱${(item.price * item.qty).toFixed(2)}</div>
            <button onclick="removeFromCart('${item.id}')" style="background: none; border: none; color: #ff4c4c; cursor: pointer;"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let vat = subtotal * 0.12;
    let isSenior = document.getElementById('seniorDiscount')?.checked || false;
    let discount = isSenior ? (subtotal * 0.20) : 0;
    updatePOSTotals(subtotal, vat, discount, subtotal + vat - discount);
}

function updatePOSTotals(sub, vat, disc, grand) {
    const totalsDiv = document.querySelector('.pos-totals');
    if (!totalsDiv) return;
    totalsDiv.innerHTML = `
        <div class="total-line"><span>Subtotal:</span> <span>₱${sub.toFixed(2)}</span></div>
        <div class="total-line"><span>VAT (12%):</span> <span>₱${vat.toFixed(2)}</span></div>
        <div class="total-line" style="display: flex; align-items: center; justify-content: space-between;">
            <span><input type="checkbox" id="seniorDiscount" style="accent-color: var(--primary-red);" ${disc > 0 ? 'checked' : ''} onchange="renderCart()"> Senior Citizen / PWD (20%)</span>
            <span style="color: #ff4c4c;">- ₱${disc.toFixed(2)}</span>
        </div>
        <div class="total-line grand"><span>TOTAL:</span> <span>₱${grand.toFixed(2)}</span></div>
        <button class="action-btn" onclick="processPayment(${grand})" style="width: 100%; justify-content: center; margin-top: 15px; font-size: 16px;"><i class="fa-solid fa-check"></i> PROCESS PAYMENT</button>
    `;
}

window.processPayment = async function(grandTotal) {
    if (posCart.length === 0) return alert("Cart is empty!");
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    let itemsStr = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');

    await addDoc(paymentsCol, { name: "Walk-in POS Customer", type: "POS Sale", items: itemsStr, amount: grandTotal, status: "Paid", date: dateStr, time: timeStr, timestamp: now.getTime() });

    for (let item of posCart) {
        if (item.id === 'WALKIN') {
            for (let w = 0; w < item.qty; w++) {
                await addDoc(attendanceCol, { name: "Walk-in Guest", type: "Walk-in", date: dateStr, timeIn: timeStr, timeOut: "", status: "Checked In", timestamp: now.getTime() });
            }
            continue; 
        }
        let currentStock = inventoryData.find(i => i.id === item.id).qty;
        await updateDoc(doc(db, "inventory", item.id), { qty: currentStock - item.qty });
    }
    alert("Payment Processed Successfully! Walk-ins logged to Attendance.");
    posCart = []; renderCart();
}

// ==========================================
// 9. FINANCIALS & WEEKLY PDF GENERATOR
// ==========================================
onSnapshot(paymentsCol, (snapshot) => {
    paymentsData = [];
    snapshot.forEach(doc => paymentsData.push({ id: doc.id, ...doc.data() }));
    renderPayments();
});

function renderPayments() {
    const payTbody = document.querySelector('#paymentTable tbody');
    if (!payTbody) return;
    payTbody.innerHTML = "";
    paymentsData.forEach(t => {
        let vat = (t.amount * 0.12).toFixed(2);
        payTbody.innerHTML += `
            <tr>
                <td>${t.name}</td><td>${t.items || t.type}</td><td>${t.date} <span style="color:#888; font-size:12px;">${t.time || ''}</span></td>
                <td>₱${t.amount}</td><td>₱${vat}</td><td style="font-weight:bold; color:var(--primary-red);">₱${t.amount}</td>
            </tr>
        `;
    });
}

window.generateWeeklyPDF = function() {
    if (typeof html2pdf === 'undefined') {
        return alert("PDF library is still loading, please wait a moment and try again.");
    }

    const docName = localStorage.getItem("loggedInUser") || "Staff Member";
    
    const today = new Date();
    const dayOfWeek = today.getDay(); 
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    
    const monday = new Date(today);
    monday.setDate(today.getDate() + distanceToMonday);
    monday.setHours(0,0,0,0);
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23,59,59,999);
    
    const formatShortDate = (d) => `${(d.getMonth()+1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear().toString().slice(-2)}`;
    
    document.getElementById('pdfWeekOf').innerText = `${formatShortDate(monday)} - ${formatShortDate(sunday)}`;
    document.getElementById('pdfAssociateName').innerText = docName;
    document.getElementById('pdfCompletionDate').innerText = formatShortDate(today);

    let productSales = {};
    
    paymentsData.forEach(payment => {
        if (!payment.date) return;
        const payDate = new Date(payment.date);
        
        if (payDate >= monday && payDate <= sunday) {
            let dayIndex = payDate.getDay() === 0 ? 6 : payDate.getDay() - 1;
            
            if (payment.items) {
                let itemsList = payment.items.split(', ');
                itemsList.forEach(itemStr => {
                    let match = itemStr.match(/^(\d+)x\s+(.+)$/);
                    if (match) {
                        let qty = parseInt(match[1]);
                        let name = match[2];
                        
                        if(!productSales[name]) productSales[name] = [0,0,0,0,0,0,0];
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
        margin:       0.5,
        filename:     `Weekly_Sales_${formatShortDate(monday).replace(/\//g, '-')}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2 },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save().then(() => {
        document.getElementById('pdf-report-container').style.display = 'none'; 
    });
}

// ==========================================
// 10. MASTER DIRECTORY & ATTENDANCE LOGIC
// ==========================================
onSnapshot(attendanceCol, (snapshot) => {
    attendanceData = [];
    snapshot.forEach(doc => attendanceData.push({ id: doc.id, ...doc.data() }));
    renderAttendance();
});

function renderAttendance() {
    const attTbody = document.querySelector('#attendanceTable tbody');
    const myAttTbody = document.querySelector('#myAttendanceBody'); 
    const loggedInName = localStorage.getItem("loggedInUser");

    if (attTbody) attTbody.innerHTML = "";
    if (myAttTbody) myAttTbody.innerHTML = "";

    let today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let gold = 0, silver = 0, walkin = 0, presentCount = 0; 

    let sortedAtt = [...attendanceData].sort((a,b) => b.timestamp - a.timestamp);
    let todayAtt = sortedAtt.filter(a => a.date === today);

    todayAtt.forEach(a => {
        let statusBadge = a.status === 'Checked In' ? '<span class="badge active">On Floor</span>' : '<span class="badge inactive">Checked Out</span>';
        let timeOutDisplay = a.timeOut ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${a.timeOut}</span>` : '-';
        let timeInDisplay = a.timeIn || a.time || '-'; 

        if (attTbody) {
            attTbody.innerHTML += `
                <tr>
                    <td>${a.name}</td><td><strong>${a.type}</strong></td><td>${a.date}</td>
                    <td><span class="badge active"><i class="fa-regular fa-clock"></i> ${timeInDisplay}</span></td>
                    <td>${timeOutDisplay}</td><td>${statusBadge}</td>
                </tr>
            `;
        }
        if (a.type.includes('Gold')) gold++; else if (a.type.includes('Silver')) silver++; else if (a.type.includes('Walk-in')) walkin++;
        if (a.status === 'Checked In') presentCount++;
    });

    if (myAttTbody) {
        let myLogs = sortedAtt.filter(a => a.name === loggedInName).slice(0, 10); 
        if (myLogs.length === 0) {
            myAttTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #888;">No attendance logs found.</td></tr>`;
        } else {
            myLogs.forEach(a => {
                let statusBadge = a.status === 'Checked In' ? '<span class="badge active">On Floor</span>' : '<span class="badge inactive">Checked Out</span>';
                let timeOutDisplay = a.timeOut ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${a.timeOut}</span>` : '-';
                let timeInDisplay = a.timeIn || a.time || '-'; 
                myAttTbody.innerHTML += `
                    <tr>
                        <td>${a.date}</td>
                        <td><span class="badge active"><i class="fa-regular fa-clock"></i> ${timeInDisplay}</span></td>
                        <td>${timeOutDisplay}</td><td>${statusBadge}</td>
                    </tr>
                `;
            });
        }
    }

    if (servicesChartInstance) { servicesChartInstance.data.datasets[0].data = [gold, silver, walkin]; servicesChartInstance.update(); }
    if (document.getElementById('presentMembers')) document.getElementById('presentMembers').innerText = presentCount; 
}

onSnapshot(usersCol, (snapshot) => {
    allUsersData = []; membersData = []; chatUsers = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        const roleStr = (data.role || "").trim().toLowerCase(); 
        chatUsers.push({ id: doc.id, ...data });
        if (roleStr === 'member') membersData.push({ id: doc.id, ...data });
        else if (roleStr !== 'admin') allUsersData.push({ id: doc.id, ...data });
    });
    renderStaff(); 
    renderMembers(); 
    renderMemberTrainers(); 
    if (document.getElementById('chatUserList')) renderChatUserList();
});

function renderMembers() {
    const memTbody = document.querySelector('#membersTable tbody');
    const arcTbody = document.querySelector('#archivedMembersTable tbody');
    if (memTbody) memTbody.innerHTML = "";
    if (arcTbody) arcTbody.innerHTML = "";
    
    let activeMembers = 0, totalNonArchived = 0;
    const now = new Date().getTime();

    membersData.forEach(m => {
        const statusStr = (m.status || "Active").trim().toLowerCase();
        let plan = m.plan || 'Standard Member'; 
        let daysLeftText = "N/A", timerBadgeClass = "active";
        
        if (m.dateRegistered) {
            const expiryDate = m.dateRegistered + (30 * 24 * 60 * 60 * 1000); 
            const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
            if (diffDays > 0) { daysLeftText = `${diffDays} Days`; if (diffDays <= 7) timerBadgeClass = "pending"; } 
            else { daysLeftText = "Expired"; timerBadgeClass = "broken"; }
        } else { daysLeftText = "30 Days"; }
        
        if (statusStr === 'archived') {
            if (arcTbody) {
                arcTbody.innerHTML += `
                    <tr>
                        <td>${m.givenName || m.name}</td><td>${m.mi || ''}</td><td>${m.familyName || ''}</td>
                        <td>${m.email}</td><td><strong>${plan}</strong></td><td><span class="badge maintenance">Archived</span></td>
                        <td>
                            <button class="btn-icon btn-delete" style="color: #27ae60;" title="Restore Account" onclick="archiveUser('${m.id}', 'Archived')"><i class="fas fa-box-open"></i></button>
                            <button class="btn-icon btn-delete" style="color: #e74c3c;" title="Permanently Delete" onclick="deleteUser('${m.id}')"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>
                `;
            }
        } else {
            totalNonArchived++;
            let badgeClass = statusStr === 'active' ? 'active' : 'inactive';
            if (memTbody) {
                memTbody.innerHTML += `
                    <tr>
                        <td>${m.givenName || m.name}</td><td>${m.mi || ''}</td><td>${m.familyName || ''}</td>
                        <td>${m.email}</td><td><strong>${plan}</strong></td>
                        <td><span class="badge ${timerBadgeClass}"><i class="fa-regular fa-clock"></i> ${daysLeftText}</span></td>
                        <td><span class="badge ${badgeClass}">${m.status || 'Active'}</span></td>
                        <td>
                            <button class="btn-icon btn-edit" style="color: var(--dark-black);" title="Edit Member" onclick="openEditMemberModal('${m.id}')"><i class="fa-solid fa-edit"></i></button>
                            <button class="btn-icon btn-delete" style="color: #e74c3c;" title="Archive Account" onclick="archiveUser('${m.id}', '${m.status || 'Active'}')"><i class="fas fa-box-archive"></i></button>
                        </td>
                    </tr>
                `;
            }
            if (statusStr === 'active') activeMembers++;
        }
    });

    if (document.getElementById('dashActiveMembers')) document.getElementById('dashActiveMembers').innerText = activeMembers;
    if (document.getElementById('gridMembers')) document.getElementById('gridMembers').innerText = totalNonArchived; 
}

window.openEditMemberModal = function(id) {
    const member = membersData.find(m => m.id === id);
    if (!member) return;
    document.getElementById('editMemberId').value = member.id;
    document.getElementById('editMemberGiven').value = member.givenName || '';
    document.getElementById('editMemberMI').value = member.mi || '';
    document.getElementById('editMemberFamily').value = member.familyName || '';
    
    if (document.getElementById('editMemberPlan')) {
        document.getElementById('editMemberPlan').value = member.plan || 'Gold Plan';
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
            name: `${given} ${family}`.trim() 
        };
        
        if (document.getElementById('editMemberPlan')) {
            updatedData.plan = document.getElementById('editMemberPlan').value;
        }
        
        await updateDoc(doc(db, "users", id), updatedData);
        window.closeModal('editMemberModal');
        alert("Member details updated successfully!");
    });
}

function renderStaff() {
    const staffTbody = document.querySelector('#staffTable tbody');
    const trainerTbody = document.querySelector('#trainerTable tbody'); 
    const arcStaffTbody = document.querySelector('#archivedStaffTable tbody');
    const arcTrainerTbody = document.querySelector('#archivedTrainerTable tbody');
    
    if (staffTbody) staffTbody.innerHTML = "";
    if (trainerTbody) trainerTbody.innerHTML = "";
    if (arcStaffTbody) arcStaffTbody.innerHTML = "";
    if (arcTrainerTbody) arcTrainerTbody.innerHTML = "";
    
    let totalTrainers = 0, totalEmployees = 0, activeTrainers = 0, trainersFeed = "";

    allUsersData.forEach(u => {
        const roleStr = (u.role || "").trim().toLowerCase();
        const statusStr = (u.status || "Active").trim().toLowerCase();
        let fullName = `${u.givenName || u.name} ${u.mi ? u.mi + '. ' : ''}${u.familyName || ''}`.trim();
        let specialty = u.specialty || '-'; 

        if (statusStr === 'archived') {
            let actionBtns = `
                <button class="btn-icon btn-delete" style="color: #27ae60;" title="Restore Account" onclick="archiveUser('${u.id}', 'Archived')"><i class="fas fa-box-open"></i></button>
                <button class="btn-icon btn-delete" style="color: #e74c3c;" title="Permanently Delete" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>
            `;
            
            if (roleStr === 'trainer') { 
                if (arcTrainerTbody) arcTrainerTbody.innerHTML += `<tr><td>${fullName}</td><td>${u.role}</td><td>${specialty}</td><td>${u.email}</td><td><span class="badge maintenance">Archived</span></td><td>${actionBtns}</td></tr>`;
            } 
            else { 
                if (arcStaffTbody) arcStaffTbody.innerHTML += `<tr><td>${fullName}</td><td>${u.role}</td><td>${u.email}</td><td><span class="badge maintenance">Archived</span></td><td>${actionBtns}</td></tr>`;
            }
        } else {
            let badgeClass = (statusStr === 'active' || statusStr === 'on leave') ? 'active' : 'inactive';
            
            let actionBtns = `
                <button class="btn-icon btn-edit" style="color: var(--dark-black);" title="Edit Details" onclick="openEditStaffModal('${u.id}')"><i class="fa-solid fa-edit"></i></button>
                <button class="btn-icon btn-delete" style="color: #f39c12;" title="Archive Account" onclick="archiveUser('${u.id}', '${u.status || 'Active'}')"><i class="fas fa-box-archive"></i></button>
            `;

            let shiftBadge = '';
            if (roleStr === 'staff' || roleStr === 'admin') {
                const isWorking = u.shiftStatus === 'On Shift';
                shiftBadge = `<span class="badge ${isWorking ? 'active' : 'inactive'}" style="${isWorking ? 'background: var(--dark-black); color: white;' : ''}">${isWorking ? 'On Shift' : 'Off Shift'}</span>`;
            } else if (roleStr === 'trainer') {
                const isOnFloor = u.shiftStatus === 'On Floor';
                shiftBadge = `<span class="badge ${isOnFloor ? 'active' : 'inactive'}" style="${isOnFloor ? 'background: #3498db; color: white;' : ''}">${isOnFloor ? 'On Floor' : 'Off Floor'}</span>`;
            }

            let statusHtml = `<div style="display: flex; gap: 5px;"><span class="badge ${badgeClass}">${u.status || 'Active'}</span>${shiftBadge}</div>`;

            if (roleStr === 'trainer') {
                if (trainerTbody) trainerTbody.innerHTML += `<tr><td>${fullName}</td><td>${u.role}</td><td>${specialty}</td><td>${u.email}</td><td>${statusHtml}</td><td>${actionBtns}</td></tr>`;
                totalTrainers++;
                
                if (statusStr === 'active' && u.shiftStatus === 'On Floor') {
                    activeTrainers++;
                    trainersFeed += `
                        <div class="list-item">
                            <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-user"></i></div>
                            <div class="list-content" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                                <div><div class="trainer-name">${fullName}</div><p style="font-size: 12px; color: var(--text-muted);">${specialty} | ${u.email}</p></div>
                                <span class="status-badge status-progress" style="background: #3498db; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px;">On Floor</span>
                            </div>
                        </div>
                    `;
                }
            } else {
                if (staffTbody) staffTbody.innerHTML += `<tr><td>${fullName}</td><td>${u.role}</td><td>${u.email}</td><td>${statusHtml}</td><td>${actionBtns}</td></tr>`;
                totalEmployees++; 
            }
        }
    });

    if (document.getElementById('dashStaffTotal')) document.getElementById('dashStaffTotal').innerText = totalEmployees;
    if (document.getElementById('gridTrainers')) document.getElementById('gridTrainers').innerText = totalTrainers;
    
    const dashTrainers = document.getElementById('dashActiveTrainersFeed');
    if (dashTrainers) { dashTrainers.innerHTML = trainersFeed || '<p style="color: var(--text-muted); font-size: 14px;">No active trainers right now.</p>'; }
}

function renderMemberTrainers() {
    const grid = document.getElementById('memberTrainerGrid');
    if (!grid) return; 

    grid.innerHTML = "";
    let activeTrainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer' && u.status !== 'Archived');

    if (activeTrainers.length === 0) {
        grid.innerHTML = "<p style='color: var(--text-muted);'>No trainers available at the moment.</p>";
        return;
    }

    activeTrainers.forEach(t => {
        let fullName = `${t.givenName || t.name} ${t.familyName || ''}`.trim();
        let specialty = t.specialty || "General Fitness";
        let isOnFloor = t.shiftStatus === 'On Floor';
        
        let badgeHtml = isOnFloor 
            ? `<span class="badge" style="background: #3498db; color: white; padding: 3px 8px; font-size: 11px;">On Floor</span>` 
            : `<span class="badge" style="background: #eee; color: #888; padding: 3px 8px; font-size: 11px;">Off Floor</span>`;

        grid.innerHTML += `
            <div class="trainer-card member-trainer-card" data-search="${fullName.toLowerCase()} ${specialty.toLowerCase()}">
                <div class="trainer-avatar">${fullName.charAt(0).toUpperCase()}</div>
                <div class="trainer-info">
                    <div class="trainer-name">${fullName}</div>
                    <div class="trainer-specialty">${specialty}</div>
                </div>
                <div>${badgeHtml}</div>
            </div>
        `;
    });
}

window.openEditStaffModal = function(id) {
    const user = allUsersData.find(u => u.id === id);
    if (!user) return;
    
    document.getElementById('editStaffId').value = user.id;
    document.getElementById('editStaffGiven').value = user.givenName || '';
    document.getElementById('editStaffMI').value = user.mi || '';
    document.getElementById('editStaffFamily').value = user.familyName || '';
    
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

        await updateDoc(doc(db, "users", id), updatedData);
        window.closeModal('editStaffModal');
        alert(`Details updated successfully!`);
    });
}

window.archiveUser = async (id, currentStatus) => { 
    const actionText = currentStatus === 'Archived' ? 'Restore' : 'Archive';
    const newStatus = currentStatus === 'Archived' ? 'Active' : 'Archived';
    if (confirm(`Are you sure you want to ${actionText.toLowerCase()} this account?`)) { 
        await updateDoc(doc(db, "users", id), { status: newStatus }); alert(`Account successfully ${newStatus.toLowerCase()}.`);
    } 
}

window.deleteUser = async (id) => { 
    if (localStorage.getItem("userRole") !== "Admin") { alert("Action Denied: You do not have permission to delete accounts."); return; }
    if (confirm("Remove this account completely? This action cannot be undone.")) await deleteDoc(doc(db, "users", id)); 
}

// ==========================================
// 11. BATCH REGISTRATION
// ==========================================
let batchRowCount = 1;

window.addBatchRow = function() {
    if (batchRowCount >= 20) return alert("Maximum 20 members can be registered at once.");
    const tbody = document.getElementById('batchMemberBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bm-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
        <td><input type="text" class="bm-mi" maxlength="2" style="width:50px;" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')"></td>
        <td><input type="text" class="bm-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
        <td><input type="email" class="bm-email" required></td>
        <td><select class="bm-plan"><option value="Gold Plan">Gold</option><option value="Silver Plan">Silver</option></select></td>
        <td><input type="text" class="bm-rfid rfid-register-input" placeholder="Tap Card..." required></td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); batchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); batchRowCount++;
}

window.openMemberModal = () => { 
    document.getElementById('batchMemberBody').innerHTML = `
        <tr>
            <td><input type="text" class="bm-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
            <td><input type="text" class="bm-mi" maxlength="2" style="width:50px;" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')"></td>
            <td><input type="text" class="bm-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
            <td><input type="email" class="bm-email" required></td>
            <td><select class="bm-plan"><option value="Gold Plan">Gold</option><option value="Silver Plan">Silver</option></select></td>
            <td><input type="text" class="bm-rfid rfid-register-input" placeholder="Tap Card..." required></td>
            <td></td>
        </tr>
    `;
    batchRowCount = 1; document.getElementById('memberModal').style.display = 'flex'; 
}

const generatePassword = () => Math.random().toString(36).slice(-8);

if (document.getElementById('batchMemberForm')) {
    document.getElementById('batchMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const rows = document.querySelectorAll('#batchMemberBody tr');
        let addedCount = 0, emailSuccessCount = 0, emailFailCount = 0, duplicateCount = 0;
        const currentTimestamp = new Date().getTime(); 

        for (let row of rows) {
            const given = row.querySelector('.bm-first').value.trim(), mi = row.querySelector('.bm-mi').value.trim(), family = row.querySelector('.bm-last').value.trim();
            const email = row.querySelector('.bm-email').value.trim(), plan = row.querySelector('.bm-plan').value, rfidTag = row.querySelector('.bm-rfid').value.trim();
            const randomPassword = generatePassword();

            const emailQuery = query(usersCol, where("email", "==", email));
            const emailSnap = await getDocs(emailQuery);
            let isDuplicate = !emailSnap.empty;

            if (!isDuplicate && rfidTag !== "") {
                const rfidQuery = query(usersCol, where("rfid", "==", rfidTag));
                const rfidSnap = await getDocs(rfidQuery);
                if (!rfidSnap.empty) isDuplicate = true;
            }

            if (isDuplicate) { duplicateCount++; continue; }

            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", { to_name: given, to_email: email, generated_password: randomPassword, plan: plan });
                await addDoc(usersCol, { name: `${given} ${family}`, givenName: given, mi: mi, familyName: family, role: "Member", email: email, status: "Active", plan: plan, rfid: rfidTag, password: randomPassword, dateRegistered: currentTimestamp });
                emailSuccessCount++; addedCount++;
            } catch(err) { console.error("EmailJS failed:", err); emailFailCount++; }
        }
        
        window.closeModal('memberModal');
        let alertMsg = `Batch Registration Summary:\n\n✅ ${emailSuccessCount} user(s) received emails and were saved to the database.\n`;
        if (duplicateCount > 0) alertMsg += `⚠️ ${duplicateCount} account(s) were SKIPPED because the Email or RFID already exists in the system.\n`;
        if (emailFailCount > 0) alertMsg += `❌ ${emailFailCount} email(s) failed to send. These users were NOT saved.`;
        alert(alertMsg);
    });
}

let staffBatchRowCount = 1;

window.addStaffBatchRow = function() {
    if (staffBatchRowCount >= 20) return alert("Maximum 20 accounts can be registered at once.");
    const tbody = document.getElementById('batchStaffBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bs-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
        <td><input type="text" class="bs-mi" maxlength="2" style="width:50px;" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')"></td>
        <td><input type="text" class="bs-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
        <td><input type="email" class="bs-email" required></td>
        <td><input type="text" class="bs-specialty" placeholder="Opt. (e.g. Yoga)"></td>
        <td><input type="text" class="bs-rfid rfid-register-input" placeholder="Tap Card..." required></td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); staffBatchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); staffBatchRowCount++;
}

window.openStaffModal = (role) => { 
    if (localStorage.getItem("userRole") !== "Admin") return alert("Action Denied: Only Admins can register Staff and Trainers.");
    
    document.getElementById('hiddenStaffRole').value = role;
    document.getElementById('staffModalTitle').innerText = `Batch Register ${role}s`;
    
    if (document.getElementById('batchSpecialtyHeader')) {
        document.getElementById('batchSpecialtyHeader').innerText = role === 'Trainer' ? 'Specialty (Required)' : 'Specialty (N/A)';
    }

    document.getElementById('batchStaffBody').innerHTML = `
        <tr>
            <td><input type="text" class="bs-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
            <td><input type="text" class="bs-mi" maxlength="2" style="width:50px;" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')"></td>
            <td><input type="text" class="bs-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required></td>
            <td><input type="email" class="bs-email" required></td>
            <td><input type="text" class="bs-specialty" placeholder="${role === 'Trainer' ? 'e.g. Yoga' : 'N/A'}" ${role === 'Staff' ? 'disabled' : ''}></td>
            <td><input type="text" class="bs-rfid rfid-register-input" placeholder="Tap Card..." required></td>
            <td></td>
        </tr>
    `;
    staffBatchRowCount = 1; document.getElementById('staffModal').style.display = 'flex'; 
}

if (document.getElementById('batchStaffForm')) {
    document.getElementById('batchStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (localStorage.getItem("userRole") !== "Admin") return;
        const rows = document.querySelectorAll('#batchStaffBody tr');
        const role = document.getElementById('hiddenStaffRole').value;
        let addedCount = 0, emailSuccessCount = 0, emailFailCount = 0, duplicateCount = 0;

        for (let row of rows) {
            const given = row.querySelector('.bs-first').value.trim(), mi = row.querySelector('.bs-mi').value.trim(), family = row.querySelector('.bs-last').value.trim();
            const email = row.querySelector('.bs-email').value.trim(), rfidTag = row.querySelector('.bs-rfid').value.trim();
            const specialty = row.querySelector('.bs-specialty').value.trim(); 
            const randomPassword = generatePassword();

            const emailQuery = query(usersCol, where("email", "==", email));
            const emailSnap = await getDocs(emailQuery);
            let isDuplicate = !emailSnap.empty;

            if (!isDuplicate && rfidTag !== "") {
                const rfidQuery = query(usersCol, where("rfid", "==", rfidTag));
                const rfidSnap = await getDocs(rfidQuery);
                if (!rfidSnap.empty) isDuplicate = true;
            }

            if (isDuplicate) { duplicateCount++; continue; }

            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", { to_name: given, to_email: email, generated_password: randomPassword, plan: `${role} Account` });
                
                let newUser = { 
                    name: `${given} ${family}`, givenName: given, mi: mi, familyName: family, 
                    role: role, email: email, status: "Active", rfid: rfidTag, password: randomPassword
                };
                
                if (role === 'Trainer') newUser.specialty = specialty || 'General Fitness';

                await addDoc(usersCol, newUser);
                emailSuccessCount++; addedCount++;
            } catch(err) { console.error("EmailJS failed:", err); emailFailCount++; }
        }
        
        window.closeModal('staffModal');
        let alertMsg = `Batch Registration Summary:\n\n✅ ${emailSuccessCount} ${role}(s) received emails and were saved to the database.\n`;
        if (duplicateCount > 0) alertMsg += `⚠️ ${duplicateCount} account(s) were SKIPPED because the Email or RFID already exists in the system.\n`;
        if (emailFailCount > 0) alertMsg += `❌ ${emailFailCount} email(s) failed to send. These users were NOT saved.`;
        alert(alertMsg);
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
    setInterval(updateClock, 1000); updateClock();

    const submenuToggles = document.querySelectorAll('.has-submenu');
    submenuToggles.forEach(toggle => {
        toggle.onclick = function() {
            this.classList.toggle('open');
            if (this.nextElementSibling && this.nextElementSibling.classList.contains('submenu')) this.nextElementSibling.classList.toggle('open');
        };
    });

    function updateShiftTimer() {
        const role = localStorage.getItem("userRole");
        const trainerStatus = localStorage.getItem("trainerShiftStatus");
        
        document.querySelectorAll('.card-black').forEach(card => {
            const valueDiv = card.querySelector('.value');
            if (valueDiv && (valueDiv.innerText.includes('Shift') || valueDiv.innerText.includes('Checking Status'))) {
                valueDiv.innerText = "Shift Status";
                
                let timerSpan = card.querySelector('.shift-timer');
                if (!timerSpan) {
                    card.innerHTML += `<span class="shift-timer" style="position: absolute; top: 10px; right: 15px; font-size: 14px; font-weight: bold; background: white; color: black; padding: 4px 10px; border-radius: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.2);">--:--:--</span>`;
                    timerSpan = card.querySelector('.shift-timer');
                }

                if (role === "Trainer" && trainerStatus !== "On Floor") {
                    timerSpan.innerText = "Off Floor";
                    timerSpan.style.background = "#eee";
                    timerSpan.style.color = "#888";
                } else {
                    const shiftStart = localStorage.getItem("shiftStart");
                    if (shiftStart) {
                        const diff = Date.now() - parseInt(shiftStart);
                        const hours = Math.floor(diff / (1000 * 60 * 60)), mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)), secs = Math.floor((diff % (1000 * 60)) / 1000);
                        timerSpan.innerText = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                        timerSpan.style.background = "white";
                        timerSpan.style.color = "black";
                    } else {
                        timerSpan.innerText = "Not Started";
                        timerSpan.style.background = "#eee";
                        timerSpan.style.color = "#888";
                    }
                }
            }
        });
    }
    setInterval(updateShiftTimer, 1000); updateShiftTimer();

    try { initDashboardCharts(); } catch (error) { console.warn("Chart tool delayed.", error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();

function initDashboardCharts() {
    const ctxServices = document.getElementById('servicesChart');
    if (!ctxServices || typeof Chart === 'undefined') return; 
    servicesChartInstance = new Chart(ctxServices.getContext('2d'), {
        type: 'bar',
        data: { labels: ['Gold Members', 'Silver Members', 'Walk-in Guests'], datasets: [{ label: 'Daily Check-ins', data: [0, 0, 0], backgroundColor: '#C01718', hoverBackgroundColor: '#111111', borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } } } }
    });
}

// ==========================================
// 13. BOOKING CALENDAR LOGIC
// ==========================================
onSnapshot(bookingsCol, (snapshot) => {
    bookingsData = [];
    snapshot.forEach(doc => bookingsData.push({ id: doc.id, ...doc.data() }));
    renderBookings();
});

function renderBookings() {
    const tbody = document.getElementById('bookingsBody'); 
    const myTbody = document.getElementById('myBookingsBody'); 
    const loggedInRole = localStorage.getItem("userRole");
    const loggedInUserId = localStorage.getItem("userId");

    let displayData = bookingsData.sort((a,b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

    // --- NEW: Stacking Notification Banners for Members ---
    if (loggedInRole === "Member") {
        displayData = displayData.filter(b => b.memberId === loggedInUserId);
        if (myTbody) myTbody.innerHTML = "";

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
                        <button onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (pending.length > 0) {
                html += `
                    <div class="notification-banner" style="background-color: #e2e3e5; color: #383d41; border-left-color: #6c757d;">
                        <div><i class="fas fa-hourglass-half" style="font-size: 20px; margin-right: 10px;"></i> <strong>Pending Approval:</strong> You have ${pending.length} request(s) waiting for a trainer to accept.</div>
                        <button onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (cancelled.length > 0) {
                let nextDeclined = cancelled[0];
                const dateObj = new Date(`${nextDeclined.date}T${nextDeclined.time}`);
                html += `
                    <div class="notification-banner" style="background-color: #f8d7da; color: #721c24; border-left-color: #f5c6cb;">
                        <div><i class="fas fa-exclamation-circle" style="font-size: 20px; margin-right: 10px;"></i> <strong>Update:</strong> Your request with ${nextDeclined.trainerName} on ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} was declined or cancelled. Please book another time.</div>
                        <button onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            notifArea.innerHTML = html;
        }
    } else if (loggedInRole === "Trainer") {
        displayData = displayData.filter(b => b.trainerId === loggedInUserId);
        if (tbody) tbody.innerHTML = "";

        const notifArea = document.getElementById('trainerNotificationArea');
        if (notifArea) {
            let pendingRequests = displayData.filter(b => b.status === "Pending");
            
            if (pendingRequests.length > 0) {
                notifArea.innerHTML = `
                    <div class="notification-banner" style="background-color: #fff3cd; color: #856404; border-left-color: #ffc107;">
                        <div><i class="fas fa-bell" style="font-size: 20px; margin-right: 10px;"></i> <strong>New Request!</strong> You have <strong>${pendingRequests.length}</strong> pending session request(s) to review in your Schedule tab.</div>
                        <button onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
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
    } else {
        if (tbody) tbody.innerHTML = "";
    }

    const dateFilter = document.getElementById('bookingDateFilter')?.value;
    if (dateFilter) displayData = displayData.filter(b => b.date === dateFilter);

    displayData.forEach(b => {
        let badgeClass = "active";
        if (b.status === "Pending") badgeClass = "pending"; 
        if (b.status === "Completed") badgeClass = "maintenance"; 
        if (b.status === "Cancelled" || b.status === "No Show") badgeClass = "broken"; 
        
        const dateObj = new Date(`${b.date}T${b.time}`);
        const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        if (loggedInRole === "Member" && myTbody) {
            myTbody.innerHTML += `
                <tr>
                    <td>${b.trainerName}</td>
                    <td>${dateStr}</td>
                    <td><span class="badge active" style="background: var(--dark-black);"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                    <td><span class="badge ${badgeClass}">${b.status}</span></td>
                </tr>
            `;
        } else if (tbody) {
            let actions = "";
            if (loggedInRole === "Trainer") {
                if (b.status === "Pending") {
                     actions = `
                        <button class="btn-icon btn-edit" style="color: #27ae60;" title="Accept" onclick="updateBookingStatus('${b.id}', 'Confirmed')"><i class="fas fa-check"></i></button>
                        <button class="btn-icon btn-delete" style="color: #e74c3c;" title="Decline" onclick="updateBookingStatus('${b.id}', 'Cancelled')"><i class="fas fa-times"></i></button>
                     `;
                } else {
                     actions = `<button class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>`;
                }
            } else {
                 actions = `
                    <button class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>
                    <button class="btn-icon btn-delete" title="Delete Booking" onclick="deleteBooking('${b.id}')"><i class="fas fa-trash"></i></button>
                `;
            }

            tbody.innerHTML += `
                <tr>
                    <td>${b.memberName}</td>
                    <td>${b.trainerName}</td>
                    <td>${dateStr}</td>
                    <td><span class="badge active" style="background: var(--dark-black);"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                    <td><span class="badge ${badgeClass}">${b.status}</span></td>
                    <td>${actions}</td>
                </tr>
            `;
        }
    });
}

window.filterBookingsByDate = () => { renderBookings(); }

window.updateBookingStatus = async (id, newStatus) => {
    if (confirm(`Are you sure you want to mark this session as ${newStatus}?`)) {
        await updateDoc(doc(db, "bookings", id), { status: newStatus });
    }
}

window.openMemberBookingModal = () => {
    const trainerSelect = document.getElementById('memberBookTrainer');
    const trainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer' && u.status !== 'Archived');
    
    trainerSelect.innerHTML = '<option value="" disabled selected>Select a Trainer...</option>' + 
        trainers.map(t => `<option value="${t.id}">${t.name || t.givenName + ' ' + t.familyName}</option>`).join('');

    document.getElementById('memberBookingForm').reset(); 
    document.getElementById('memberBookingModal').style.display = 'flex';
}

if (document.getElementById('memberBookingForm')) {
    document.getElementById('memberBookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const trainerSelect = document.getElementById('memberBookTrainer');
        const trainerId = trainerSelect.value;
        const bookDate = document.getElementById('memberBookDate').value;
        const bookTime = document.getElementById('memberBookTime').value;
        
        const trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;
        const memberId = localStorage.getItem("userId");
        const memberName = localStorage.getItem("loggedInUser"); 

        await addDoc(bookingsCol, { 
            memberId, memberName, 
            trainerId, trainerName, 
            date: bookDate, time: bookTime, 
            status: "Pending", 
            timestamp: new Date().getTime() 
        });
        
        window.closeModal('memberBookingModal'); 
        alert("Request sent! Waiting for trainer approval.");
    });
}

window.openBookingModal = () => {
    const memberSelect = document.getElementById('bookMember'), trainerSelect = document.getElementById('bookTrainer');
    memberSelect.innerHTML = '<option value="" disabled selected>Select a Member...</option>' + membersData.map(m => `<option value="${m.id}">${m.name || m.givenName + ' ' + m.familyName}</option>`).join('');
    const trainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer');
    trainerSelect.innerHTML = '<option value="" disabled selected>Select an Assigned Trainer...</option>' + trainers.map(t => `<option value="${t.id}">${t.name || t.givenName + ' ' + t.familyName}</option>`).join('');

    document.getElementById('bookingForm').reset(); document.getElementById('bookingModal').style.display = 'flex';
}

if (document.getElementById('bookingForm')) {
    document.getElementById('bookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const memberSelect = document.getElementById('bookMember'), trainerSelect = document.getElementById('bookTrainer');
        const memberId = memberSelect.value, trainerId = trainerSelect.value, bookDate = document.getElementById('bookDate').value, bookTime = document.getElementById('bookTime').value;
        const memberName = memberSelect.options[memberSelect.selectedIndex].text, trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;

        await addDoc(bookingsCol, { memberId, memberName, trainerId, trainerName, date: bookDate, time: bookTime, status: "Confirmed", timestamp: new Date().getTime() });
        window.closeModal('bookingModal'); alert("Personal Training Session booked successfully!");
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
    });
}

window.deleteBooking = async (id) => { if (confirm("Are you sure you want to delete this booking record?")) await deleteDoc(doc(db, "bookings", id)); }

// ==========================================
// 14. SMART USB RFID GHOST LISTENER
// ==========================================
let rfidBuffer = "";
let lastKeyTime = Date.now();

document.addEventListener('keydown', (e) => {
    const currentTime = Date.now();
    if (currentTime - lastKeyTime > 50) rfidBuffer = ""; 

    if (e.key === 'Enter' && rfidBuffer.length > 5) {
        e.preventDefault(); 
        const activeEl = document.activeElement;
        const isRegistrationBox = activeEl && activeEl.classList.contains('rfid-register-input');

        if (activeEl && activeEl.tagName === 'INPUT' && !isRegistrationBox) {
            let currentVal = activeEl.value;
            if (currentVal.endsWith(rfidBuffer)) activeEl.value = currentVal.slice(0, -rfidBuffer.length);
        }

        if (isRegistrationBox) {
            activeEl.value = rfidBuffer;
            activeEl.style.backgroundColor = "#c8e6c9"; 
            activeEl.style.borderColor = "#2e7d32";
            activeEl.blur(); 
        } else {
            const loggedInRfid = localStorage.getItem("userRfid");
            if (loggedInRfid && rfidBuffer === loggedInRfid) {
                console.log("Shift Ended. Logging out...");
                window.handleLogout();
            } else {
                processRfidAttendance(rfidBuffer);
            }
        }
        rfidBuffer = ""; 
    } 
    else if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) rfidBuffer += e.key;
    
    lastKeyTime = currentTime;
});

async function processRfidAttendance(scannedTag) {
    const q = query(usersCol, where("rfid", "==", scannedTag));
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) {
        console.warn(`Unrecognized Card Scanned (ID: ${scannedTag}).`);
        return;
    }
    
    const userDoc = snapshot.docs[0];
    const user = userDoc.data();
    
    if (user.status === 'Archived') {
        console.warn(`Access Denied. ${user.name || user.givenName}'s account is archived.`);
        return;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const userName = user.name || `${user.givenName} ${user.familyName}`;
    const isTrainer = (user.role || "").toLowerCase() === 'trainer';

    const attQuery = query(attendanceCol, where("name", "==", userName), where("date", "==", dateStr), where("status", "==", "Checked In"));
    const attSnapshot = await getDocs(attQuery);

    if (!attSnapshot.empty) {
        const recordId = attSnapshot.docs[0].id;
        await updateDoc(doc(db, "attendance", recordId), {
            timeOut: timeStr,
            status: "Checked Out"
        });

        if (isTrainer) {
            await updateDoc(doc(db, "users", userDoc.id), { shiftStatus: "Off Floor" });
            console.log(`Goodbye, Trainer ${userName}! You are now Off Floor.`);
        } else {
            console.log(`Goodbye, ${userName}! Checked out successfully.`);
        }
    } else {
        await addDoc(attendanceCol, {
            name: userName,
            type: user.plan || user.role || "Member",
            date: dateStr,
            timeIn: timeStr,
            timeOut: "",
            status: "Checked In",
            timestamp: now.getTime()
        });

        if (isTrainer) {
            await updateDoc(doc(db, "users", userDoc.id), { shiftStatus: "On Floor" });
            console.log(`Welcome, Trainer ${userName}! You are now On Floor.`);
        } else {
            console.log(`Welcome, ${userName}! Checked in successfully.`);
        }
    }
}