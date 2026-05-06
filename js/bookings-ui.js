// ============================================
// BOOKING MODULE – Enhanced UI Controller
// ============================================

// --- State ---
let bkCurrentView = 'list';
let bkSortField = 'date';
let bkSortDir = 'desc';
let bkCalWeekOffset = 0;

// --- View Toggle ---
window.switchBookingView = function (view, btn) {
    bkCurrentView = view;
    document.querySelectorAll('.bk-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('bkListPanel').style.display = view === 'list' ? '' : 'none';
    document.getElementById('bkCalendarPanel').style.display = view === 'calendar' ? '' : 'none';
    if (view === 'calendar') renderBookingCalendar();
};

// --- Search ---
window.handleBookingSearch = function () { renderBookings(); };

// --- Sorting ---
window.sortBookings = function (field) {
    if (bkSortField === field) {
        bkSortDir = bkSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        bkSortField = field;
        bkSortDir = 'asc';
    }
    // Update header icons
    document.querySelectorAll('.bk-sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        const icon = th.querySelector('.bk-sort-icon');
        if (icon) icon.className = 'fa-solid fa-sort bk-sort-icon';
    });
    const activeHeader = document.getElementById(
        field === 'memberName' ? 'bkSortMember' : field === 'date' ? 'bkSortDate' : 'bkSortTime'
    );
    if (activeHeader) {
        activeHeader.classList.add(bkSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        const icon = activeHeader.querySelector('.bk-sort-icon');
        if (icon) icon.className = `fa-solid fa-sort-${bkSortDir === 'asc' ? 'up' : 'down'} bk-sort-icon`;
    }
    renderBookings();
};

// --- Inline Status Dropdown ---
window.toggleBkStatusDropdown = function (e, bookingId) {
    e.stopPropagation();
    const wrapper = e.currentTarget.closest('.bk-status-wrapper');
    const wasOpen = wrapper.classList.contains('open');
    // Close all
    document.querySelectorAll('.bk-status-wrapper.open').forEach(w => w.classList.remove('open'));
    if (!wasOpen) wrapper.classList.add('open');
};

window.quickUpdateStatus = function (e, bookingId, newStatus) {
    e.stopPropagation();
    document.querySelectorAll('.bk-status-wrapper.open').forEach(w => w.classList.remove('open'));
    if (typeof window.updateBookingStatus === 'function') {
        window.updateBookingStatus(bookingId, newStatus);
    }
};

// Close status dropdowns on outside click
document.addEventListener('click', () => {
    document.querySelectorAll('.bk-status-wrapper.open').forEach(w => w.classList.remove('open'));
});

// --- Drawer ---
window.openBookingDrawer = function () {
    const memberSelect = document.getElementById('bookMember');
    const trainerSelect = document.getElementById('bookTrainer');
    if (memberSelect && typeof membersData !== 'undefined') {
        memberSelect.innerHTML = '<option value="" disabled selected>Select a Member...</option>' +
            membersData.map(m => `<option value="${m.id}">${m.name || (m.givenName + ' ' + m.familyName)}</option>`).join('');
    }
    if (trainerSelect && typeof allUsersData !== 'undefined') {
        const trainers = allUsersData.filter(u => (u.role || '').toLowerCase() === 'trainer');
        trainerSelect.innerHTML = '<option value="" disabled selected>Select a Trainer...</option>' +
            trainers.map(t => `<option value="${t.id}">${t.name || (t.givenName + ' ' + t.familyName)}</option>`).join('');
    }
    const form = document.getElementById('bookingForm');
    if (form) form.reset();
    if (typeof setBookingDateMin === 'function') setBookingDateMin(document.getElementById('bookDate'));
    document.getElementById('bkDrawerOverlay').classList.add('open');
    document.getElementById('bkDrawer').classList.add('open');
};

window.closeBookingDrawer = function () {
    document.getElementById('bkDrawerOverlay').classList.remove('open');
    document.getElementById('bkDrawer').classList.remove('open');
};

// Keep old openBookingModal as alias for backward compat
window.openBookingModal = window.openBookingDrawer;

// --- KPI Update ---
function updateBookingKPIs() {
    if (typeof bookingsData === 'undefined') return;
    const today = new Date().toLocaleDateString('en-CA');
    const todayCount = bookingsData.filter(b => b.date === today && b.status !== 'Cancelled').length;
    const pendingCount = bookingsData.filter(b => b.status === 'Pending').length;
    const confirmedCount = bookingsData.filter(b => b.status === 'Confirmed').length;

    // This week
    const now = new Date();
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6);
    const sow = startOfWeek.toLocaleDateString('en-CA');
    const eow = endOfWeek.toLocaleDateString('en-CA');
    const weekCount = bookingsData.filter(b => b.date >= sow && b.date <= eow).length;

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('bkTodayCount', todayCount);
    el('bkPendingCount', pendingCount);
    el('bkConfirmedCount', confirmedCount);
    el('bkTotalWeek', weekCount);
}

// --- Trainer Filter Population ---
function populateTrainerFilter() {
    const select = document.getElementById('bkFilterTrainer');
    if (!select || typeof allUsersData === 'undefined') return;
    const trainers = allUsersData.filter(u => (u.role || '').toLowerCase() === 'trainer');
    const current = select.value;
    select.innerHTML = '<option value="">All Trainers</option>' +
        trainers.map(t => `<option value="${t.id}">${t.name || (t.givenName + ' ' + t.familyName)}</option>`).join('');
    select.value = current;
}

// --- Filter + Sort Logic (injected into renderBookings) ---
function applyBookingFilters(data) {
    let filtered = [...data];

    // Search
    const searchVal = (document.getElementById('bookingSearch')?.value || '').toLowerCase();
    if (searchVal) {
        filtered = filtered.filter(b =>
            (b.memberName || '').toLowerCase().includes(searchVal) ||
            (b.trainerName || '').toLowerCase().includes(searchVal)
        );
    }

    // Trainer filter
    const trainerFilter = document.getElementById('bkFilterTrainer')?.value;
    if (trainerFilter) filtered = filtered.filter(b => b.trainerId === trainerFilter);

    // Status filter
    const statusFilter = document.getElementById('bkFilterStatus')?.value;
    if (statusFilter) filtered = filtered.filter(b => b.status === statusFilter);

    // Date range
    const dateFrom = document.getElementById('bkDateFrom')?.value;
    const dateTo = document.getElementById('bkDateTo')?.value;
    if (dateFrom) filtered = filtered.filter(b => b.date >= dateFrom);
    if (dateTo) filtered = filtered.filter(b => b.date <= dateTo);

    // Sort — cancelled/declined always sink to the bottom
    const isCancelled = (s) => s === 'Cancelled' || s === 'Declined';
    filtered.sort((a, b) => {
        const aCancelled = isCancelled(a.status);
        const bCancelled = isCancelled(b.status);
        if (aCancelled !== bCancelled) return aCancelled ? 1 : -1;

        let va, vb;
        if (bkSortField === 'memberName') { va = (a.memberName || '').toLowerCase(); vb = (b.memberName || '').toLowerCase(); }
        else if (bkSortField === 'time') { va = a.time || ''; vb = b.time || ''; }
        else { va = a.date + 'T' + (a.time || ''); vb = b.date + 'T' + (b.time || ''); }
        if (va < vb) return bkSortDir === 'asc' ? -1 : 1;
        if (va > vb) return bkSortDir === 'asc' ? 1 : -1;
        return 0;
    });

    return filtered;
}

// --- Enhanced Row Renderer ---
function renderEnhancedBookingRow(b) {
    const dateObj = new Date(`${b.date}T${b.time}`);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const statusKey = b.status.toLowerCase().replace(' ', '');
    const statusClass = `status-${statusKey === 'noshow' ? 'noshow' : statusKey}`;

    const statuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled', 'No Show'];
    const dotColors = { Pending: '#F59E0B', Confirmed: '#10B981', Completed: '#3B82F6', Cancelled: '#EF4444', 'No Show': '#991B1B' };

    const statusCell = `
        <div class="bk-status-wrapper">
            <span class="bk-status-badge ${statusClass}" onclick="toggleBkStatusDropdown(event, '${b.id}')">
                ${b.status} <i class="fa-solid fa-chevron-down bk-chevron"></i>
            </span>
            <div class="bk-status-dropdown">
                ${statuses.filter(s => s !== b.status).map(s => `
                    <div class="bk-status-option" onclick="quickUpdateStatus(event, '${b.id}', '${s}')">
                        <span class="bk-dot" style="background: ${dotColors[s]}"></span> ${s}
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    const actions = `
        <button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>
        <button type="button" class="btn-icon btn-delete" title="Delete Booking" onclick="deleteBooking('${b.id}')"><i class="fas fa-trash"></i></button>
    `;

    return `
        <tr>
            <td style="font-weight: 500;">${b.memberName}</td>
            <td>${b.trainerName}</td>
            <td>${dateStr}</td>
            <td><span class="bk-time-display"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
            <td>${statusCell}</td>
            <td>${actions}</td>
        </tr>
    `;
}

// --- Calendar View ---
window.navigateBookingCal = function (dir) {
    if (dir === 0) bkCalWeekOffset = 0;
    else bkCalWeekOffset += dir;
    renderBookingCalendar();
};

function renderBookingCalendar() {
    const grid = document.getElementById('bkCalGrid');
    const titleEl = document.getElementById('bkCalTitle');
    if (!grid || typeof bookingsData === 'undefined') return;

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + (bkCalWeekOffset * 7));
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(startOfWeek);
        d.setDate(startOfWeek.getDate() + i);
        days.push(d);
    }

    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    titleEl.textContent = `${fmt(days[0])} – ${fmt(days[6])}, ${days[6].getFullYear()}`;

    const hours = [];
    for (let h = 6; h <= 22; h++) hours.push(h);
    const cols = 8; // 1 time col + 7 days
    grid.style.gridTemplateColumns = `80px repeat(7, 1fr)`;

    let html = '<div class="bk-cal-corner"></div>';
    const todayStr = now.toLocaleDateString('en-CA');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    days.forEach(d => {
        const isToday = d.toLocaleDateString('en-CA') === todayStr;
        html += `<div class="bk-cal-day-header ${isToday ? 'is-today' : ''}">
            ${dayNames[d.getDay()]}<span class="bk-day-num">${d.getDate()}</span>
        </div>`;
    });

    // Build a lookup: date -> hour -> bookings[]
    const lookup = {};
    bookingsData.forEach(b => {
        if (!b.date || !b.time) return;
        const h = parseInt(b.time.split(':')[0], 10);
        const key = `${b.date}_${h}`;
        if (!lookup[key]) lookup[key] = [];
        lookup[key].push(b);
    });

    hours.forEach(h => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const dh = h % 12 || 12;
        html += `<div class="bk-cal-time-label">${dh}:00 ${ampm}</div>`;

        days.forEach(d => {
            const dateKey = d.toLocaleDateString('en-CA');
            const key = `${dateKey}_${h}`;
            const bookings = lookup[key] || [];
            let cellContent = '';
            bookings.forEach(b => {
                const sk = b.status.toLowerCase().replace(' ', '');
                const cls = sk === 'noshow' ? 'cal-noshow' : `cal-${sk}`;
                const [th, tm] = (b.time || '0:0').split(':');
                const ap = parseInt(th) >= 12 ? 'PM' : 'AM';
                const dhr = parseInt(th) % 12 || 12;
                cellContent += `<div class="bk-cal-block ${cls}" onclick="openEditBookingModal('${b.id}')" title="${b.memberName} with ${b.trainerName}">
                    ${b.memberName}<br><span class="bk-cal-block-sub">${b.trainerName} · ${dhr}:${(tm || '00').padStart(2, '0')} ${ap}</span>
                </div>`;
            });
            html += `<div class="bk-cal-cell">${cellContent}</div>`;
        });
    });

    grid.innerHTML = html;
}

// --- Monkey-patch renderBookings to use enhanced rendering ---
(function () {
    // Wait for the original renderBookings to be defined, then wrap it
    const origInterval = setInterval(() => {
        if (typeof renderBookings !== 'function') return;
        clearInterval(origInterval);

        const _origRender = renderBookings;

        window.renderBookings = function () {
            // Call original for member/trainer notification logic
            _origRender();
        };

        // We need to override the row rendering for admin view
        // Instead of fully replacing, we hook after the original runs
        const observer = new MutationObserver(() => {
            const tbody = document.getElementById('bookingsBody');
            const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
            if (!tbody || loggedInRole === 'member') return;

            // Re-render with enhanced rows if we're admin/staff
            let data = typeof bookingsData !== 'undefined' ? [...bookingsData] : [];
            data = applyBookingFilters(data);

            const countEl = document.getElementById('bkRecordCount');
            if (countEl) countEl.textContent = `${data.length} record${data.length !== 1 ? 's' : ''}`;

            tbody.innerHTML = data.map(renderEnhancedBookingRow).join('');

            // Update KPIs
            updateBookingKPIs();
            populateTrainerFilter();

            // Update calendar if visible
            if (bkCurrentView === 'calendar') renderBookingCalendar();
        });

        const tbody = document.getElementById('bookingsBody');
        if (tbody) {
            observer.observe(tbody, { childList: true });
        }
    }, 200);
})();

// --- Drawer Form Submit (replaces old bookingModal submit) ---
(function () {
    const interval = setInterval(() => {
        const form = document.getElementById('bookingForm');
        if (!form) return;
        clearInterval(interval);

        // Remove existing listeners by cloning
        const newForm = form.cloneNode(true);
        form.parentNode.replaceChild(newForm, form);

        newForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = newForm.querySelector('button[type="submit"]');
            const origText = submitBtn ? submitBtn.innerHTML : '';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

            const memberSelect = document.getElementById('bookMember');
            const trainerSelect = document.getElementById('bookTrainer');
            const dateEl = document.getElementById('bookDate');
            const timeEl = document.getElementById('bookTime');

            if (typeof setBookingDateMin === 'function') setBookingDateMin(dateEl);
            if (typeof updateBookingTimeMinForToday === 'function') updateBookingTimeMinForToday(dateEl, timeEl);

            if (!dateEl.checkValidity()) { dateEl.reportValidity(); if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; } return; }
            if (!timeEl.checkValidity()) { timeEl.reportValidity(); if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; } return; }

            const memberId = memberSelect.value, trainerId = trainerSelect.value;
            const bookDate = dateEl.value, bookTime = timeEl.value;
            const memberName = memberSelect.options[memberSelect.selectedIndex].text;
            const trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;

            if (typeof isBookingSessionInPast === 'function' && isBookingSessionInPast(bookDate, bookTime)) {
                showToast("Choose a date and time in the future.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
                return;
            }

            // Conflict check
            try {
                const fb = window._fb;
                const q = fb.query(fb.bookingsCol, fb.where("trainerId", "==", trainerId), fb.where("date", "==", bookDate), fb.where("status", "==", "Confirmed"));
                const snap = await fb.getDocs(q);
                let conflict = false;
                const [bH, bM] = bookTime.split(':').map(Number);
                const bookMins = bH * 60 + bM;
                snap.forEach(d => {
                    const ts = d.data().time;
                    if (ts) { const [eH, eM] = ts.split(':').map(Number); if (Math.abs(bookMins - (eH * 60 + eM)) < 60) conflict = true; }
                });
                if (conflict) {
                    showToast("Trainer already booked within 1 hour of this time.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
                    return;
                }
            } catch (err) { console.warn('Conflict check skipped', err); }

            const fb2 = window._fb || {};
            await fb2.addDoc(fb2.bookingsCol, { memberId, memberName, trainerId, trainerName, date: bookDate, time: bookTime, status: "Confirmed", timestamp: Date.now() });
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
            closeBookingDrawer();
            showToast("Personal Training Session booked!", "success");
            if (window.logActivity) window.logActivity("Booking Created", "Admin/Staff booked a training session.");
        });
    }, 300);
})();
