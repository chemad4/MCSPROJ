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
        'dashboard': 'Dashboard',
        'inventory': 'Inventory Management',
        'pos': 'Point of Sale (POS)',
        'payments': 'Financial Reports',
        'members': 'Member Directory', 
        'staff': 'General Staff Management',
        'trainers': 'Trainer Management'
    };
    document.getElementById('pageTitle').innerText = titles[tabId] || 'Dashboard';
}

window.closeModal = function(modalId) { document.getElementById(modalId).style.display = 'none'; }
window.exportReport = function() { window.print(); }
window.exportInventoryReport = function() { window.print(); }

window.filterTable = function(tableId, inputId) {
    const filter = document.getElementById(inputId).value.toUpperCase();
    const tr = document.getElementById(tableId).getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[0];
        if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    }
}

window.filterByPlan = function(val) {
    const tr = document.getElementById('membersTable').getElementsByTagName("tr");
    let filterText = "";
    if (val === "1") filterText = "SILVER";
    if (val === "2") filterText = "GOLD";
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[4]; // Index 4 is Plan
        if (td) {
            let cellText = (td.textContent || td.innerText).toUpperCase();
            if (val === "0" || cellText.includes(filterText)) tr[i].style.display = "";
            else tr[i].style.display = "none";
        }
    }
}

// ==========================================
// STATE ARRAYS & COLLECTIONS
// ==========================================
let inventoryData = [];
let allUsersData = []; 
let membersData = []; 
let paymentsData = [];
let posCart = []; // Cart for POS

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");
const usersCol = collection(db, "users");

let earningsChartInstance = null;
let servicesChartInstance = null;
let globalEarnings = 0;
let globalExpenses = 0;

// ==========================================
// 1. INVENTORY LOGIC (Live Listener)
// ==========================================
onSnapshot(inventoryCol, (snapshot) => {
    inventoryData = [];
    snapshot.forEach(doc => inventoryData.push({ id: doc.id, ...doc.data() }));
    renderInventory();
    renderPOSProducts();
});

function renderInventory() {
    const equipTbody = document.querySelector('#machinesTable tbody');
    const prodTbody = document.querySelector('#productsTable tbody');
    if(!equipTbody || !prodTbody) return;

    equipTbody.innerHTML = "";
    prodTbody.innerHTML = "";

    let ops = 0, maint = 0, low = 0, totalMachines = 0;

    inventoryData.forEach((item) => {
        let isConsumable = ['Supplements', 'Beverages', 'Merch'].includes(item.cat);
        let badge = 'operational';

        if(item.status === 'Maintenance') { badge = 'maintenance'; maint++; }
        else if(item.status === 'Out of Order') { badge = 'broken'; }
        else if(item.qty <= 5) { badge = 'stock-low'; low++; }
        else { ops++; }

        if(!isConsumable) totalMachines++;

        let rowHTML = `<tr>
            <td>${item.name}</td>
            <td>${item.cat}</td>
            <td>${item.size || 'N/A'}</td>
            ${isConsumable ? `<td>${item.expiry || 'N/A'}</td>` : ''}
            <td>${item.qty}</td>
            <td><span class="badge ${badge}">${item.status || 'Active'}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteInventoryItem('${item.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(isConsumable) prodTbody.innerHTML += rowHTML;
        else equipTbody.innerHTML += rowHTML;
    });

    if(document.getElementById('statMachines')) document.getElementById('statMachines').innerText = totalMachines;
    if(document.getElementById('statOperational')) document.getElementById('statOperational').innerText = ops;
    if(document.getElementById('statMaintenance')) document.getElementById('statMaintenance').innerText = maint;
    if(document.getElementById('statLowStock')) document.getElementById('statLowStock').innerText = low;
    if(document.getElementById('gridEquip')) document.getElementById('gridEquip').innerText = ops;
}

window.openEquipmentModal = () => { document.getElementById('equipmentForm').reset(); document.getElementById('equipmentModal').style.display = 'flex'; }
window.openProductModal = () => { document.getElementById('productForm').reset(); document.getElementById('productModal').style.display = 'flex'; }
window.deleteInventoryItem = async (id) => { if(confirm("Delete this inventory item?")) await deleteDoc(doc(db, "inventory", id)); }

// Auto-Math for adding stock
async function handleInventorySubmit(e, isProduct) {
    e.preventDefault();
    const nameStr = document.getElementById(isProduct ? 'prodName' : 'equipName').value.trim();
    const addQty = Number(document.getElementById(isProduct ? 'prodQty' : 'equipQty').value);
    
    // Check if it exists to add to stock
    const existingItem = inventoryData.find(i => i.name.toLowerCase() === nameStr.toLowerCase());

    if (existingItem) {
        await updateDoc(doc(db, "inventory", existingItem.id), { qty: existingItem.qty + addQty });
        alert(`Added ${addQty} to existing stock of ${existingItem.name}.`);
    } else {
        const newItem = { 
            name: nameStr, 
            cat: document.getElementById(isProduct ? 'prodCategory' : 'equipCategory').value, 
            size: document.getElementById(isProduct ? 'prodVol' : 'equipSize').value, 
            qty: addQty, 
            status: isProduct ? 'Operational' : document.getElementById('equipStatus').value,
            price: isProduct ? Number(document.getElementById('prodPrice').value) : 0,
            expiry: isProduct ? document.getElementById('prodExpiry').value : null
        };
        await addDoc(inventoryCol, newItem);
    }
    window.closeModal(isProduct ? 'productModal' : 'equipmentModal');
}

if(document.getElementById('equipmentForm')) document.getElementById('equipmentForm').addEventListener('submit', (e) => handleInventorySubmit(e, false));
if(document.getElementById('productForm')) document.getElementById('productForm').addEventListener('submit', (e) => handleInventorySubmit(e, true));

// ==========================================
// 2. POINT OF SALE (POS) LOGIC
// ==========================================
function renderPOSProducts() {
    const posBody = document.getElementById('posProductList');
    if(!posBody) return;
    posBody.innerHTML = "";
    
    inventoryData.forEach(item => {
        if(['Supplements', 'Beverages', 'Merch'].includes(item.cat) && item.qty > 0) {
            let price = item.price || 0;
            posBody.innerHTML += `<tr>
                <td>${item.name}</td><td>${item.qty}</td><td>₱${price.toFixed(2)}</td>
                <td><button class="action-btn" style="padding: 5px 10px;" onclick="addToCart('${item.id}', '${item.name}', ${price}, ${item.qty})">Add</button></td>
            </tr>`;
        }
    });
}

window.addToCart = function(id, name, price, maxQty) {
    let existing = posCart.find(i => i.id === id);
    if(existing) {
        if(existing.qty < maxQty) existing.qty++;
        else alert("Not enough stock available!");
    } else {
        posCart.push({id, name, price, qty: 1, maxQty});
    }
    renderCart();
}

window.removeFromCart = function(id) {
    posCart = posCart.filter(i => i.id !== id);
    renderCart();
}

function renderCart() {
    const cartBody = document.getElementById('posCartBody');
    if(!cartBody) return;

    if(posCart.length === 0) {
        cartBody.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top: 50px;">Cart is empty.</p>`;
        updatePOSTotals(0, 0, 0, 0);
        return;
    }

    cartBody.innerHTML = posCart.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 10px;">
            <div style="flex-grow:1;">
                <strong>${item.name}</strong><br>
                <small>₱${item.price} x ${item.qty}</small>
            </div>
            <div style="font-weight: bold; margin-right: 15px;">₱${(item.price * item.qty).toFixed(2)}</div>
            <button onclick="removeFromCart('${item.id}')" style="background: none; border: none; color: #ff4c4c; cursor: pointer;"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let vat = subtotal * 0.12;
    let isSenior = document.getElementById('seniorDiscount').checked;
    let discount = isSenior ? (subtotal * 0.20) : 0;
    let grandTotal = subtotal + vat - discount;

    updatePOSTotals(subtotal, vat, discount, grandTotal);
}

function updatePOSTotals(sub, vat, disc, grand) {
    const totalsDiv = document.querySelector('.pos-totals');
    if(!totalsDiv) return;
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
    if(posCart.length === 0) return alert("Cart is empty!");
    
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let itemsStr = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');

    // 1. Save Transaction Receipt
    await addDoc(paymentsCol, {
        name: "Walk-in POS Customer",
        type: "Product Purchase",
        items: itemsStr,
        amount: grandTotal,
        status: "Paid",
        date: dateStr
    });

    // 2. Deduct Inventory Quantities
    for(let item of posCart) {
        let currentStock = inventoryData.find(i => i.id === item.id).qty;
        await updateDoc(doc(db, "inventory", item.id), { qty: currentStock - item.qty });
    }

    alert("Payment Processed Successfully! Inventory deducted.");
    posCart = [];
    renderCart();
}

// ==========================================
// 3. MASTER DIRECTORY LOGIC (Members & Staff)
// ==========================================
onSnapshot(usersCol, (snapshot) => {
    allUsersData = [];
    membersData = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        const roleStr = (data.role || "").trim().toLowerCase(); 
        if(roleStr === 'member') membersData.push({ id: doc.id, ...data });
        else if(roleStr !== 'admin') allUsersData.push({ id: doc.id, ...data });
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
        const statusStr = (m.status || "Active").trim().toLowerCase();
        let badgeClass = statusStr === 'active' ? 'active' : 'inactive';
        let plan = m.plan || 'Standard Member'; 
        
        memTbody.innerHTML += `<tr>
            <td>${m.givenName || m.name}</td><td>${m.mi || ''}</td><td>${m.familyName || ''}</td>
            <td>${m.email}</td><td><strong>${plan}</strong></td>
            <td><span class="badge ${badgeClass}">${m.status || 'Active'}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteUser('${m.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(statusStr === 'active') activeMembers++;
    });

    if(document.getElementById('dashActiveMembers')) document.getElementById('dashActiveMembers').innerText = activeMembers;
    if(document.getElementById('gridMembers')) document.getElementById('gridMembers').innerText = membersData.length; 
}

function renderStaff() {
    const staffTbody = document.querySelector('#staffTable tbody');
    const trainerTbody = document.querySelector('#trainerTable tbody'); 
    if(staffTbody) staffTbody.innerHTML = "";
    if(trainerTbody) trainerTbody.innerHTML = "";
    
    let totalTrainers = 0, totalEmployees = 0; 

    allUsersData.forEach(u => {
        const roleStr = (u.role || "").trim().toLowerCase();
        const rowHtml = `<tr>
            <td>${u.name}</td><td>${u.role}</td><td>${u.email}</td>
            <td><span class="badge active">${u.status || 'Active'}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(roleStr === 'trainer') {
            if(trainerTbody) trainerTbody.innerHTML += rowHtml;
            totalTrainers++;
        } else {
            if(staffTbody) staffTbody.innerHTML += rowHtml;
            totalEmployees++; 
        }
    });

    if(document.getElementById('dashStaffTotal')) document.getElementById('dashStaffTotal').innerText = totalEmployees;
    if(document.getElementById('gridTrainers')) document.getElementById('gridTrainers').innerText = totalTrainers;
}

window.openStaffModal = (role) => {
    document.getElementById('staffForm').reset();
    document.getElementById('hiddenStaffRole').value = role;
    document.getElementById('staffModalTitle').innerText = `Add New ${role}`;
    document.getElementById('staffModal').style.display = 'flex';
}

window.openMemberModal = () => { document.getElementById('memberForm').reset(); document.getElementById('memberModal').style.display = 'flex'; }
window.deleteUser = async (id) => { if(confirm("Remove this account?")) await deleteDoc(doc(db, "users", id)); }

if(document.getElementById('memberForm')) {
    document.getElementById('memberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await addDoc(usersCol, { 
            name: `${document.getElementById('memGiven').value} ${document.getElementById('memFamily').value}`, 
            givenName: document.getElementById('memGiven').value,
            mi: document.getElementById('memMI').value,
            familyName: document.getElementById('memFamily').value,
            role: "Member", 
            email: document.getElementById('memberEmail').value, 
            status: document.getElementById('memberStatus').value,
            plan: document.getElementById('memberPlan').value,
            password: "password123" 
        });
        window.closeModal('memberModal');
        alert("Member registered successfully!");
    });
}

if(document.getElementById('staffForm')) {
    document.getElementById('staffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await addDoc(usersCol, { 
            name: document.getElementById('staffName').value, 
            role: document.getElementById('hiddenStaffRole').value,
            email: document.getElementById('staffEmail').value, 
            status: document.getElementById('staffStatus').value,
            password: "password123" 
        });
        window.closeModal('staffModal');
        alert("Account created successfully!");
    });
}

// ==========================================
// 4. FINANCIALS (Live Listener)
// ==========================================
onSnapshot(paymentsCol, (snapshot) => {
    paymentsData = [];
    snapshot.forEach(doc => paymentsData.push({ id: doc.id, ...doc.data() }));
    renderPayments();
});

function renderPayments() {
    const payTbody = document.querySelector('#paymentTable tbody');
    if(payTbody) payTbody.innerHTML = "";
    globalEarnings = 0;

    paymentsData.forEach(t => {
        let vat = (t.amount * 0.12).toFixed(2);
        if(payTbody) {
            payTbody.innerHTML += `<tr>
                <td>${t.name}</td><td>${t.items || t.type}</td><td>${t.date}</td>
                <td>₱${t.amount}</td><td>₱${vat}</td>
                <td style="font-weight:bold; color:var(--primary-red);">₱${t.amount}</td>
            </tr>`;
        }
        if(t.status === 'Paid') globalEarnings += Number(t.amount);
    });

    if(document.getElementById('dashTotalEarnings')) document.getElementById('dashTotalEarnings').innerText = `Total Earnings: ₱${globalEarnings.toLocaleString()}`;
}

// ==========================================
// 5. UI INITIALIZATION & CHART CREATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const topBarName = document.getElementById('topBarName');
    if(topBarName) {
        topBarName.innerText = "Welcome, " + (localStorage.getItem("loggedInUser") || "User");
    }

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
    const ctxServices = document.getElementById('servicesChart');
    if (!ctxServices) return;

    servicesChartInstance = new Chart(ctxServices.getContext('2d'), {
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

    const ctxEarnings = document.getElementById('earningsChart');
    if (!ctxEarnings) return;

    earningsChartInstance = new Chart(ctxEarnings.getContext('2d'), {
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