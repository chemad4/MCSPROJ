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

// 4. Initialize EmailJS with your Public API Key
emailjs.init("ZqQKGRo5j5KpAhH98");

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

    if(element && !element.classList.contains('stat-card') && !element.classList.contains('grid-stat-box')) {
        element.classList.add('active');
        if(element.classList.contains('sub-item')) element.parentElement.previousElementSibling.classList.add('active');
    } else {
        const targetNav = document.querySelector(`.nav-menu li[onclick*="switchTab('${tabId}'"]`);
        if(targetNav) {
            targetNav.classList.add('active');
            if(targetNav.classList.contains('sub-item')) targetNav.parentElement.previousElementSibling.classList.add('active');
        }
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
        if(tableId === 'membersTable') {
            let tdPlan = tr[i].getElementsByTagName("td")[4]; 
            let text = (td ? td.textContent : "") + " " + (tdPlan ? tdPlan.textContent : "");
            if (text.toUpperCase().indexOf(filter) > -1) tr[i].style.display = "";
            else tr[i].style.display = "none";
        } else {
            if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
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
let posCart = []; 

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");
const usersCol = collection(db, "users");

let earningsChartInstance = null;
let servicesChartInstance = null;
let globalEarnings = 0;

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
    let alertsHtml = "";

    let ops = 0, maint = 0, low = 0, totalMachines = 0;

    inventoryData.forEach((item) => {
        let isConsumable = ['Supplements', 'Beverages', 'Merch'].includes(item.cat);
        let badge = 'operational';
        let isProblematic = false;

        if(item.status === 'Maintenance') { badge = 'maintenance'; maint++; isProblematic = true; }
        else if(item.status === 'Out of Order') { badge = 'broken'; isProblematic = true; }
        else if(item.qty <= 5) { badge = 'stock-low'; low++; isProblematic = true;}
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

        // Populate Dashboard Alerts
        if(isProblematic) {
            alertsHtml += `<div class="list-item">
                <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <div class="list-content"><h4>Status: ${item.status || 'Low Stock'}</h4><p><strong>${item.name}</strong> requires attention.</p></div>
            </div>`;
        }
    });

    if(document.getElementById('dashInventoryTotal')) document.getElementById('dashInventoryTotal').innerText = inventoryData.length;
    if(document.getElementById('gridEquip')) document.getElementById('gridEquip').innerText = ops;
    
    const dashAlerts = document.getElementById('dashInventoryAlerts');
    if(dashAlerts) dashAlerts.innerHTML = alertsHtml || '<p style="color: green; font-size: 14px;">All systems operational!</p>';
}

window.openEquipmentModal = () => { document.getElementById('equipmentForm').reset(); document.getElementById('equipmentModal').style.display = 'flex'; }
window.openProductModal = () => { document.getElementById('productForm').reset(); document.getElementById('productModal').style.display = 'flex'; }
window.deleteInventoryItem = async (id) => { if(confirm("Delete this inventory item?")) await deleteDoc(doc(db, "inventory", id)); }

async function handleInventorySubmit(e, isProduct) {
    e.preventDefault();
    const nameStr = document.getElementById(isProduct ? 'prodName' : 'equipName').value.trim();
    const addQty = Number(document.getElementById(isProduct ? 'prodQty' : 'equipQty').value);
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
    } else posCart.push({id, name, price, qty: 1, maxQty});
    renderCart();
}

window.removeFromCart = function(id) { posCart = posCart.filter(i => i.id !== id); renderCart(); }

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
            <div style="flex-grow:1;"><strong>${item.name}</strong><br><small>₱${item.price} x ${item.qty}</small></div>
            <div style="font-weight: bold; margin-right: 15px;">₱${(item.price * item.qty).toFixed(2)}</div>
            <button onclick="removeFromCart('${item.id}')" style="background: none; border: none; color: #ff4c4c; cursor: pointer;"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let vat = subtotal * 0.12;
    let isSenior = document.getElementById('seniorDiscount').checked;
    let discount = isSenior ? (subtotal * 0.20) : 0;
    updatePOSTotals(subtotal, vat, discount, subtotal + vat - discount);
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

    await addDoc(paymentsCol, { name: "Walk-in POS Customer", type: "Product Purchase", items: itemsStr, amount: grandTotal, status: "Paid", date: dateStr });

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
    
    let totalTrainers = 0, totalEmployees = 0, activeTrainers = 0; 
    let trainersFeed = "";

    allUsersData.forEach(u => {
        const roleStr = (u.role || "").trim().toLowerCase();
        const statusStr = (u.status || "Active").trim().toLowerCase();

        const rowHtml = `<tr>
            <td>${u.givenName || u.name}</td><td>${u.familyName || ''}</td><td>${u.email}</td>
            <td><span class="badge active">${u.status || 'Active'}</span></td>
            <td><button class="btn-icon btn-delete" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;

        if(roleStr === 'trainer') {
            if(trainerTbody) trainerTbody.innerHTML += rowHtml;
            totalTrainers++;
            
            if(statusStr === 'active') {
                activeTrainers++;
                trainersFeed += `<div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-user"></i></div>
                    <div class="list-content" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <div><div class="trainer-name">${u.givenName || u.name}</div><p style="font-size: 12px; color: var(--text-muted);">${u.email}</p></div>
                        <span class="status-badge status-progress">On Floor</span>
                    </div>
                </div>`;
            }
        } else {
            if(staffTbody) staffTbody.innerHTML += rowHtml;
            totalEmployees++; 
        }
    });

    if(document.getElementById('dashStaffTotal')) document.getElementById('dashStaffTotal').innerText = totalEmployees;
    if(document.getElementById('gridTrainers')) document.getElementById('gridTrainers').innerText = totalTrainers;
    
    const dashTrainers = document.getElementById('dashActiveTrainersFeed');
    if(dashTrainers) dashTrainers.innerHTML = trainersFeed || '<p style="color: var(--text-muted); font-size: 14px;">No active trainers right now.</p>';
}

window.deleteUser = async (id) => { if(confirm("Remove this account?")) await deleteDoc(doc(db, "users", id)); }

// ==========================================
// 4. BATCH REGISTRATION (MEMBERS & STAFF)
// ==========================================
let batchRowCount = 1;
window.addBatchRow = function() {
    if(batchRowCount >= 20) return alert("Maximum 20 members can be registered at once.");
    const tbody = document.getElementById('batchMemberBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bm-first" required></td>
        <td><input type="text" class="bm-mi" maxlength="2" style="width:50px;" required></td>
        <td><input type="text" class="bm-last" required></td>
        <td><input type="email" class="bm-email" required></td>
        <td>
            <select class="bm-plan">
                <option value="Gold Plan">Gold</option>
                <option value="Silver Plan">Silver</option>
            </select>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); batchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
    batchRowCount++;
}

window.openMemberModal = () => { 
    document.getElementById('batchMemberBody').innerHTML = `
        <tr>
            <td><input type="text" class="bm-first" required></td>
            <td><input type="text" class="bm-mi" maxlength="2" style="width:50px;" required></td>
            <td><input type="text" class="bm-last" required></td>
            <td><input type="email" class="bm-email" required></td>
            <td><select class="bm-plan"><option value="Gold Plan">Gold</option><option value="Silver Plan">Silver</option></select></td>
            <td></td>
        </tr>`;
    batchRowCount = 1;
    document.getElementById('memberModal').style.display = 'flex'; 
}

const generatePassword = () => Math.random().toString(36).slice(-8);

if(document.getElementById('batchMemberForm')) {
    document.getElementById('batchMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const rows = document.querySelectorAll('#batchMemberBody tr');
        let addedCount = 0;

        for (let row of rows) {
            const given = row.querySelector('.bm-first').value;
            const mi = row.querySelector('.bm-mi').value;
            const family = row.querySelector('.bm-last').value;
            const email = row.querySelector('.bm-email').value;
            const plan = row.querySelector('.bm-plan').value;
            const randomPassword = generatePassword();

            await addDoc(usersCol, { 
                name: `${given} ${family}`, givenName: given, mi: mi, familyName: family,
                role: "Member", email: email, status: "Active", plan: plan,
                password: randomPassword 
            });

            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", {
                    to_name: given,
                    to_email: email,
                    generated_password: randomPassword,
                    plan: plan
                });
                console.log(`[Email Sent] Successfully sent to: ${email}`);
            } catch(err) {
                console.error("EmailJS failed:", err);
            }
            addedCount++;
        }
        window.closeModal('memberModal');
        alert(`Successfully registered ${addedCount} member(s)! Verification emails and passwords have been sent.`);
    });
}

// BATCH REGISTRATION FOR STAFF/TRAINERS
let staffBatchRowCount = 1;
window.addStaffBatchRow = function() {
    if(staffBatchRowCount >= 20) return alert("Maximum 20 accounts can be registered at once.");
    const tbody = document.getElementById('batchStaffBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bs-first" required></td>
        <td><input type="text" class="bs-last" required></td>
        <td><input type="email" class="bs-email" required></td>
        <td>
            <select class="bs-status">
                <option value="Active">Active</option>
                <option value="On Leave">On Leave</option>
            </select>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); staffBatchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
    staffBatchRowCount++;
}

window.openStaffModal = (role) => { 
    document.getElementById('hiddenStaffRole').value = role;
    document.getElementById('staffModalTitle').innerText = `Batch Register ${role}s (Up to 20)`;
    document.getElementById('batchStaffBody').innerHTML = `
        <tr>
            <td><input type="text" class="bs-first" required></td>
            <td><input type="text" class="bs-last" required></td>
            <td><input type="email" class="bs-email" required></td>
            <td>
                <select class="bs-status">
                    <option value="Active">Active</option>
                    <option value="On Leave">On Leave</option>
                </select>
            </td>
            <td></td>
        </tr>`;
    staffBatchRowCount = 1;
    document.getElementById('staffModal').style.display = 'flex'; 
}

if(document.getElementById('batchStaffForm')) {
    document.getElementById('batchStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const rows = document.querySelectorAll('#batchStaffBody tr');
        const role = document.getElementById('hiddenStaffRole').value;
        let addedCount = 0;

        for (let row of rows) {
            const given = row.querySelector('.bs-first').value;
            const family = row.querySelector('.bs-last').value;
            const email = row.querySelector('.bs-email').value;
            const status = row.querySelector('.bs-status').value;
            const randomPassword = generatePassword();

            await addDoc(usersCol, { 
                name: `${given} ${family}`, givenName: given, familyName: family,
                role: role, email: email, status: status,
                password: randomPassword 
            });

            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", {
                    to_name: given,
                    to_email: email,
                    generated_password: randomPassword,
                    plan: `${role} Account`
                });
                console.log(`[Email Sent] Successfully sent to: ${email}`);
            } catch(err) {
                console.error("EmailJS failed:", err);
            }
            addedCount++;
        }
        window.closeModal('staffModal');
        alert(`Successfully registered ${addedCount} ${role}(s)! Verification emails and passwords have been sent.`);
    });
}

// ==========================================
// 5. FINANCIALS
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
    let walkinCount = 0, goldSales = 0, silverSales = 0, productSales = 0;

    paymentsData.forEach(t => {
        let vat = (t.amount * 0.12).toFixed(2);
        if(payTbody) {
            payTbody.innerHTML += `<tr>
                <td>${t.name}</td><td>${t.items || t.type}</td><td>${t.date}</td>
                <td>₱${t.amount}</td><td>₱${vat}</td>
                <td style="font-weight:bold; color:var(--primary-red);">₱${t.amount}</td>
            </tr>`;
        }
        if(t.status === 'Paid') {
            globalEarnings += Number(t.amount);
            if(t.type && t.type.includes('Gold')) goldSales++; 
            else if(t.type && t.type.includes('Silver')) silverSales++; 
            else if(t.type && t.type.includes('Walk-in')) walkinCount++; 
            else productSales++; 
        }
    });

    if(document.getElementById('presentMembers')) document.getElementById('presentMembers').innerText = walkinCount; 

    if(servicesChartInstance) {
        servicesChartInstance.data.datasets[0].data = [goldSales, silverSales, walkinCount, productSales];
        servicesChartInstance.update();
    }
}

// ==========================================
// UI INITIALIZATION
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
}