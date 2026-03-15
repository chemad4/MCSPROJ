// 1. Import Firebase dependencies
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 2. YOUR Actual Fit Track Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyB5xluf59a0X6v-_TNzR6Ny0mtcjSVWyLA",
    authDomain: "fit-track-ca8d1.firebaseapp.com",
    projectId: "fit-track-ca8d1",
    storageBucket: "fit-track-ca8d1.firebasestorage.app",
    messagingSenderId: "157593985795",
    appId: "1:157593985795:web:07156961dda8e2254fbf36",
    measurementId: "G-NYGGEMMJMC"
};

// 3. Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ==========================================
// GLOBAL EXPORTS FOR HTML ONCLICK BUTTONS
// ==========================================

window.handleLogout = function() {
    localStorage.removeItem("loggedInUser");
    localStorage.removeItem("userRole");
    window.location.replace("index.html"); 
};

window.switchTab = function(tabId, element) {
    if(event) event.stopPropagation();
    document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active-section'));
    if(document.getElementById(tabId)) document.getElementById(tabId).classList.add('active-section');
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sub-item').forEach(el => el.classList.remove('active'));

    if(element) {
        element.classList.add('active');
        if(element.classList.contains('sub-item')) element.parentElement.previousElementSibling.classList.add('active');
    }
    const titles = {
        'dashboard': 'Admin Dashboard',
        'inventory': 'Inventory Management',
        'payments': 'Sales & Transactions',
        'attendance': 'Member Status Tracking',
        'members': 'Member Management', 
        'staff': 'General Staff Management',
        'trainers': 'Trainer Management', 
        'placeholder': 'Under Construction',
        'chat': 'Internal Messenger'
    };
    document.getElementById('pageTitle').innerText = titles[tabId] || 'Dashboard';
}

window.closeModal = function(modalId) { document.getElementById(modalId).style.display = 'none'; }
window.exportReport = function() { alert("Generating Sales CSV report... Download started."); }
window.exportInventoryReport = function() { alert("Generating Inventory Report... Download started."); }

window.filterTable = function(tableId, inputId) {
    const filter = document.getElementById(inputId).value.toUpperCase();
    const tr = document.getElementById(tableId).getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[0];
        if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    }
}

window.filterInventory = function() {
    const filter = document.getElementById('inventorySearch').value.toUpperCase();
    ['machinesTable', 'productsTable', 'attentionTable'].forEach(id => {
        const tr = document.getElementById(id).getElementsByTagName("tr");
        for (let i = 1; i < tr.length; i++) {
            let td = tr[i].getElementsByTagName("td")[0];
            if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        }
    });
}

window.viewTransaction = function(id, name, amount, status) {
    document.getElementById('transactionDetails').innerHTML = `<p><strong>Transaction ID:</strong> ${id}</p><p><strong>Customer:</strong> ${name}</p><p><strong>Amount:</strong> ${amount}</p><p><strong>Status:</strong> ${status}</p>`;
    document.getElementById('transactionModal').style.display = 'flex';
}

// ==========================================
// STATE ARRAYS & GLOBAL CHART VARIABLES
// ==========================================
let inventoryData = [];
let allUsersData = []; 
let membersData = []; 
let paymentsData = [];

let editingInventoryId = null;
let servicesChartInstance = null;
let earningsChartInstance = null;

let globalEarnings = 0;
let globalExpenses = 0;

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");
const usersCol = collection(db, "users");

// ==========================================
// 1. INVENTORY LOGIC (Live Listener)
// ==========================================
onSnapshot(inventoryCol, (snapshot) => {
    inventoryData = [];
    snapshot.forEach(doc => inventoryData.push({ id: doc.id, ...doc.data() }));
    renderInventory();
});

function renderInventory() {
    document.querySelector('#machinesTable tbody').innerHTML = "";
    document.querySelector('#productsTable tbody').innerHTML = "";
    document.querySelector('#attentionTable tbody').innerHTML = "";
    let alertsHtml = "";

    let counts = { machines: 0, ops: 0, maint: 0, prod: 0, low: 0 };

    inventoryData.forEach((item) => {
        let badge = 'operational';
        let isProblematic = false;

        if(item.status.includes('Maintenance')) { badge = 'maintenance'; isProblematic = true; counts.maint++; }
        else if(item.status.includes('Out of Order')) { badge = 'broken'; isProblematic = true; }
        else if(item.status.includes('Low')) { badge = 'stock-low'; isProblematic = true; counts.low++; }
        else if(item.status === 'In Stock') { badge = 'stock-high'; }
        else if(item.status === 'Operational') { counts.ops++; }

        if (item.cat === 'Supplements' || item.cat === 'Beverages') counts.prod++; 
        else counts.machines++;

        const mainRow = `<tr>
            <td>${item.name}</td><td>${item.cat}</td><td>${item.qty}</td>
            <td><span class="badge ${badge}">${item.status}</span></td>
            <td>
                <button class="btn-icon btn-edit" onclick="openEditInventoryModal('${item.id}')"><i class="fas fa-edit"></i></button>
                <button class="btn-icon btn-delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;

        if (item.cat === 'Supplements' || item.cat === 'Beverages') {
            document.querySelector('#productsTable tbody').insertAdjacentHTML('beforeend', mainRow);
        } else {
            document.querySelector('#machinesTable tbody').insertAdjacentHTML('beforeend', mainRow);
        }

        if(isProblematic) {
            document.querySelector('#attentionTable tbody').insertAdjacentHTML('beforeend', `<tr>
                <td><strong>${item.name}</strong></td><td>${item.cat}</td>
                <td><span class="badge ${badge}">${item.status}</span></td>
                <td><button class="btn-icon btn-resolve" onclick="openEditInventoryModal('${item.id}')"><i class="fas fa-tools"></i> Resolve</button></td>
            </tr>`);

            alertsHtml += `<div class="list-item">
                <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <div class="list-content"><h4>Status: ${item.status}</h4><p><strong>${item.name}</strong> requires attention.</p></div>
            </div>`;
        }
    });

    globalExpenses = (counts.maint * 1500) + (counts.low * 500);

    document.getElementById('statMachines').innerText = counts.machines;
    document.getElementById('statOperational').innerText = counts.ops;
    document.getElementById('statMaintenance').innerText = counts.maint;
    document.getElementById('statLowStock').innerText = counts.low;
    
    document.getElementById('navInventoryCount').innerText = inventoryData.length;
    document.getElementById('dashInventoryTotal').innerText = inventoryData.length;
    document.getElementById('gridEquip').innerText = counts.ops;
    document.getElementById('gridExpenses').innerText = `₱${globalExpenses.toLocaleString()}`;
    
    const dashAlerts = document.getElementById('dashInventoryAlerts');
    if(dashAlerts) dashAlerts.innerHTML = alertsHtml || '<p style="color: green; font-size: 14px;">All systems operational!</p>';

    if(earningsChartInstance) {
        earningsChartInstance.data.datasets[0].data[1] = globalExpenses;
        earningsChartInstance.update();
    }
}

window.openAddEquipmentModal = () => {
    editingInventoryId = null;
    document.getElementById('equipModalTitle').innerText = "Add Inventory Item";
    document.getElementById('equipmentForm').reset();
    document.getElementById('equipmentModal').style.display = 'flex';
}
window.openEditInventoryModal = (id) => {
    editingInventoryId = id;
    const item = inventoryData.find(i => i.id === id);
    document.getElementById('equipModalTitle').innerText = "Edit Inventory Item";
    document.getElementById('equipName').value = item.name;
    document.getElementById('equipCategory').value = item.cat; 
    document.getElementById('equipQty').value = item.qty;
    document.getElementById('equipStatus').value = item.status;
    document.getElementById('equipmentModal').style.display = 'flex';
}
window.deleteInventoryItem = async (id) => {
    if(confirm("Delete this inventory item from the database?")) await deleteDoc(doc(db, "inventory", id));
}
document.getElementById('equipmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newItem = { name: document.getElementById('equipName').value, cat: document.getElementById('equipCategory').value, qty: Number(document.getElementById('equipQty').value), status: document.getElementById('equipStatus').value };
    if (editingInventoryId) await updateDoc(doc(db, "inventory", editingInventoryId), newItem);
    else await addDoc(inventoryCol, newItem);
    window.closeModal('equipmentModal');
});

// ==========================================
// 2. MASTER DIRECTORY LOGIC (Members & Staff)
// ==========================================
onSnapshot(usersCol, (snapshot) => {
    allUsersData = [];
    membersData = [];
    
    snapshot.forEach(doc => {
        const data = doc.data();
        const roleStr = (data.role || "").toLowerCase(); // Case insensitive
        
        if(roleStr === 'member') {
            membersData.push({ id: doc.id, ...data });
        } else if(roleStr !== 'admin') {
            allUsersData.push({ id: doc.id, ...data });
        }
    });
    
    renderStaff();
    renderMembers(); 
});

function renderMembers() {
    const memTbody = document.querySelector('#membersTable tbody');
    if(!memTbody) return;
    memTbody.innerHTML = "";
    
    let activeMembers = 0;

    membersData.forEach(m => {
        const statusStr = (m.status || "Active").toLowerCase();
        let badgeClass = statusStr === 'active' ? 'active' : 'inactive';
        let displayStatus = m.status || 'Active'; 
        let plan = m.plan || 'Standard Member'; 
        
        memTbody.innerHTML += `<tr>
            <td>${m.name}</td><td>${m.email}</td><td><strong>${plan}</strong></td>
            <td><span class="badge ${badgeClass}">${displayStatus}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteUser('${m.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(statusStr === 'active') activeMembers++;
    });

    document.getElementById('dashActiveMembers').innerText = activeMembers;
    document.getElementById('gridMembers').innerText = membersData.length; 
}

function renderStaff() {
    const staffTbody = document.querySelector('#staffTable tbody');
    const trainerTbody = document.querySelector('#trainerTable tbody'); 
    if(!staffTbody || !trainerTbody) return;
    
    staffTbody.innerHTML = "";
    trainerTbody.innerHTML = "";
    
    let trainersFeed = "";
    let totalTrainers = 0;
    let activeTrainers = 0;
    let totalEmployees = 0; 

    allUsersData.forEach(u => {
        const statusStr = (u.status || "Active").toLowerCase();
        const roleStr = (u.role || "").toLowerCase();
        
        let badgeClass = statusStr === 'active' ? 'active' : 'inactive';
        let displayStatus = u.status || 'Active'; 
        
        const rowHtml = `<tr>
            <td>${u.name}</td><td>${u.role}</td><td>${u.email}</td>
            <td><span class="badge ${badgeClass}">${displayStatus}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(roleStr === 'trainer') {
            trainerTbody.innerHTML += rowHtml;
            totalTrainers++;
            
            if(statusStr === 'active') {
                activeTrainers++;
                trainersFeed += `<div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-user"></i></div>
                    <div class="list-content" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <div><div class="trainer-name">${u.name}</div><p style="font-size: 12px; color: var(--text-muted);">${u.email}</p></div>
                        <span class="status-badge status-progress">On Floor</span>
                    </div>
                </div>`;
            }
        } else {
            staffTbody.innerHTML += rowHtml;
            totalEmployees++; 
        }
    });

    document.getElementById('dashStaffTotal').innerText = totalEmployees;
    document.getElementById('gridTrainers').innerText = totalTrainers;
    document.getElementById('gridActiveTrainers').innerText = activeTrainers;
    
    const dashTrainers = document.getElementById('dashActiveTrainersFeed');
    if(dashTrainers) dashTrainers.innerHTML = trainersFeed || '<p style="color: var(--text-muted); font-size: 14px;">No active trainers right now.</p>';
}

// Open Member Modal
window.openMemberModal = () => {
    document.getElementById('memberForm').reset();
    document.getElementById('memberModal').style.display = 'flex';
}

window.openStaffModal = () => {
    document.getElementById('staffForm').reset();
    document.getElementById('staffModal').style.display = 'flex';
}

window.deleteUser = async (id) => {
    if(confirm("Remove this user account from the system? They will no longer be able to log in.")) {
        await deleteDoc(doc(db, "users", id));
    }
}

// Add Member Form Submit
document.getElementById('memberForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newMember = { 
        name: document.getElementById('memberName').value, 
        role: "Member", 
        email: document.getElementById('memberEmail').value, 
        status: document.getElementById('memberStatus').value,
        plan: document.getElementById('memberPlan').value,
        password: "password123" 
    };
    await addDoc(usersCol, newMember);
    window.closeModal('memberModal');
    alert("New member added! They can log in immediately using password: password123");
});

// Add Staff Form Submit
document.getElementById('staffForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newUser = { 
        name: document.getElementById('staffName').value, 
        role: document.getElementById('staffRole').value, 
        email: document.getElementById('staffEmail').value, 
        status: document.getElementById('staffStatus').value,
        password: "password123" 
    };
    await addDoc(usersCol, newUser);
    window.closeModal('staffModal');
    alert("New account added! They can log in immediately using password: password123");
});

// ==========================================
// 3. PAYMENTS & RECEIPT LOGIC
// ==========================================
onSnapshot(paymentsCol, (snapshot) => {
    paymentsData = [];
    snapshot.forEach(doc => paymentsData.push({ id: doc.id, ...doc.data() }));
    renderPayments();
});

function renderPayments() {
    const payTbody = document.querySelector('#paymentTable tbody');
    const attTbody = document.querySelector('#attendanceTable tbody'); // The live status tab
    if(payTbody) payTbody.innerHTML = "";
    if(attTbody) attTbody.innerHTML = "";
    
    globalEarnings = 0;
    let walkinCount = 0;
    let goldSales = 0, silverSales = 0, productSales = 0;

    paymentsData.forEach(t => {
        let badge = t.status === 'Pending' ? 'pending' : 'paid';
        
        // Populate the Receipts/Payments table
        if(payTbody) {
            payTbody.innerHTML += `<tr>
                <td>${t.name}</td><td>${t.type}</td><td>${t.date}</td>
                <td>₱${t.amount}</td><td><span class="badge ${badge}">${t.status}</span></td>
                <td><button class="btn-icon btn-delete" onclick="deletePayment('${t.id}')"><i class="fas fa-trash"></i></button></td>
            </tr>`;
        }

        // Populate the Member Status / Attendance table
        if(attTbody) {
            let attBadge = t.type.includes('Gold') ? 'gold' : t.type.includes('Silver') ? 'silver' : 'active';
            attTbody.innerHTML += `<tr>
                <td>${t.name}</td><td>${t.date}</td><td>${t.timeIn || '8:00 AM'}</td>
                <td><span class="badge ${attBadge}">${t.type}</span></td>
                <td><button class="btn-icon btn-delete" onclick="deletePayment('${t.id}')"><i class="fas fa-trash"></i></button></td>
            </tr>`;
        }

        if(t.status === 'Paid') {
            globalEarnings += Number(t.amount);
            if(t.type.includes('Gold')) { goldSales++; }
            else if(t.type.includes('Silver')) { silverSales++; }
            else if(t.type.includes('Walk-in')) { walkinCount++; }
            else { productSales++; }
        }
    });

    document.getElementById('dashTotalEarnings').innerText = `Total Earnings: ₱${globalEarnings.toLocaleString()}`;
    document.getElementById('presentMembers').innerText = walkinCount; 

    if(servicesChartInstance) {
        servicesChartInstance.data.datasets[0].data = [goldSales, silverSales, walkinCount, productSales];
        servicesChartInstance.update();
    }
    if(earningsChartInstance) {
        earningsChartInstance.data.datasets[0].data[0] = globalEarnings;
        earningsChartInstance.update();
    }
}

window.openAddPaymentModal = () => {
    document.getElementById('paymentForm').reset();
    document.getElementById('paymentModal').style.display = 'flex';
}
window.deletePayment = async (id) => {
    if(confirm("Delete this transaction record?")) await deleteDoc(doc(db, "payments", id));
}
document.getElementById('paymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    const newPay = {
        name: document.getElementById('payName').value,
        type: document.getElementById('payType').value,
        amount: Number(document.getElementById('payAmount').value),
        status: document.getElementById('payStatus').value,
        date: dateStr,
        timeIn: timeStr
    };
    await addDoc(paymentsCol, newPay);
    window.closeModal('paymentModal');
});

// ==========================================
// UI INITIALIZATION & CHART CREATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    initDashboardCharts();
    
    const submenuToggles = document.querySelectorAll('.has-submenu');
    submenuToggles.forEach(toggle => {
        toggle.addEventListener('click', function() {
            this.classList.toggle('open');
            this.nextElementSibling.classList.toggle('open');
        });
    });

    function updateClock() {
        const clockElement = document.getElementById('liveClock');
        if(clockElement) {
            const now = new Date();
            const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
            clockElement.innerHTML = `<i class="fa-regular fa-clock"></i> ${now.toLocaleDateString('en-US', options)}`;
        }
    }
    setInterval(updateClock, 1000);
    updateClock();
});

function initDashboardCharts() {
    const ctxServices = document.getElementById('servicesChart').getContext('2d');
    servicesChartInstance = new Chart(ctxServices, {
        type: 'bar',
        data: { 
            labels: ['Gold Plan', 'Silver Plan', 'Walk-ins', 'Products'], 
            datasets: [{ 
                label: 'Total Units Sold',
                data: [0, 0, 0, 0], 
                backgroundColor: '#C01718', hoverBackgroundColor: '#111111', borderRadius: 4 
            }] 
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } } } }
    });

    const ctxEarnings = document.getElementById('earningsChart').getContext('2d');
    earningsChartInstance = new Chart(ctxEarnings, {
        type: 'bar',
        data: {
            labels: ['Earnings', 'Expenses'],
            datasets: [{ data: [0, 0], backgroundColor: ['#C01718', '#111111'], borderRadius: 4 }]
        },
        options: { 
            indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, 
            scales: { 
                x: { ticks: { callback: function(value) { return '₱' + value; } } },
                y: { grid: { display: false } } 
            } 
        }
    });
}