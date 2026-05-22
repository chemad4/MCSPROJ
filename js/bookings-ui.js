// ============================================
// BOOKING MODULE – Enhanced UI Controller
// ============================================

// --- State ---
let bkCurrentView = 'list';
let bkSortField = 'date';
let bkSortDir = 'desc';
let bkCalWeekOffset = 0;
let _bkRenderLock = false; // Prevent infinite re-render loops

let bkCurrentPage = 1;
const bkItemsPerPage = 20;

window.changeBkPage = function (dir) {
    bkCurrentPage += dir;
    if (bkCurrentPage < 1) bkCurrentPage = 1;
    window.renderBookings();
};

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
window.handleBookingSearch = function () {
    bkCurrentPage = 1;
    if (typeof window.renderBookings === 'function') window.renderBookings();
};

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
    if (typeof window.renderBookings === 'function') window.renderBookings();
};

// --- Inline Status Dropdown ---
window.toggleBkStatusDropdown = function (e, bookingId) {
    e.stopPropagation();
    const wrapper = e.currentTarget.closest('.bk-status-wrapper');
    const wasOpen = wrapper.classList.contains('open');
    document.querySelectorAll('.bk-status-wrapper.open').forEach(w => w.classList.remove('open'));
    if (!wasOpen) {
        wrapper.classList.add('open');
        // Position the fixed dropdown below the trigger button
        const trigger = e.currentTarget;
        const rect = trigger.getBoundingClientRect();
        const dropdown = wrapper.querySelector('.bk-status-dropdown');
        if (dropdown) {
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
        }
    }
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
    const members = window.membersData || [];
    const allUsers = window.allUsersData || [];

    if (memberSelect) {
        memberSelect.innerHTML = '<option value="" disabled selected>Select a Member...</option>' +
            members.map(m => `<option value="${m.id}">${m.uid ? m.uid + ' - ' : ''}${m.name || (m.givenName + ' ' + m.familyName)}</option>`).join('');
    }
    if (trainerSelect) {
        const trainers = allUsers.filter(u => (u.role || '').toLowerCase() === 'trainer');
        trainerSelect.innerHTML = '<option value="" disabled selected>Select a Trainer...</option>' +
            trainers.map(t => `<option value="${t.id}">${t.uid ? t.uid + ' - ' : ''}${t.name || (t.givenName + ' ' + t.familyName)}</option>`).join('');
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
    const data = window.bookingsData || [];
    if (!data.length) return;
    const today = new Date().toLocaleDateString('en-CA');
    const todayCount = data.filter(b => b.date === today && b.status !== 'Cancelled').length;
    const pendingCount = data.filter(b => b.status === 'Pending').length;
    const confirmedCount = data.filter(b => b.status === 'Confirmed').length;

    // This week
    const now = new Date();
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6);
    const sow = startOfWeek.toLocaleDateString('en-CA');
    const eow = endOfWeek.toLocaleDateString('en-CA');
    const weekCount = data.filter(b => b.date >= sow && b.date <= eow).length;

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('bkTodayCount', todayCount);
    el('bkPendingCount', pendingCount);
    el('bkConfirmedCount', confirmedCount);
    el('bkTotalWeek', weekCount);
}

// --- Trainer Filter Population ---
function populateTrainerFilter() {
    const select = document.getElementById('bkFilterTrainer');
    const allUsers = window.allUsersData || [];
    if (!select || !allUsers.length) return;
    const trainers = allUsers.filter(u => (u.role || '').toLowerCase() === 'trainer');
    const current = select.value;
    select.innerHTML = '<option value="">All Trainers</option>' +
        trainers.map(t => `<option value="${t.id}">${t.uid ? t.uid + ' - ' : ''}${t.name || (t.givenName + ' ' + t.familyName)}</option>`).join('');
    select.value = current;
}

// --- Filter + Sort Logic ---
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

    // Sort — newest first by default
    filtered.sort((a, b) => {
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

    const statuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled', 'Declined', 'No Show'];
    const dotColors = { Pending: '#F59E0B', Confirmed: '#3B82F6', Completed: '#10B981', Cancelled: '#EF4444', Declined: '#B91C1C', 'No Show': '#7F1D1D' };

    const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();

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

    // Hide trainer column if role is trainer
    const trainerColumnStyle = loggedInRole === 'trainer' ? 'display: none;' : '';

    // Trainer: show accept/decline for pending, edit for others; Admin/Staff: full actions
    let actions = '';
    if (loggedInRole === 'trainer') {
        if (b.status === 'Pending') {
            actions = `
                <button type="button" class="btn-icon btn-edit" style="color: #27ae60;" title="Accept" onclick="updateBookingStatus('${b.id}', 'Confirmed')"><i class="fas fa-check"></i></button>
                <button type="button" class="btn-icon btn-delete" style="color: #e74c3c;" title="Decline" onclick="updateBookingStatus('${b.id}', 'Declined')"><i class="fas fa-times"></i></button>
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

    // Trainer: make member name clickable to view profile
    let memberNameCell = `<span style="font-weight: 500;">${b.memberName}</span>`;
    if (loggedInRole === 'trainer' && b.memberId) {
        memberNameCell = `<a href="javascript:void(0)" onclick="window.openMemberProfile('${b.memberId}')" class="mp-link">${b.memberName}</a>`;
    }

    return `
        <tr>
            <td style="min-width: 120px;">${memberNameCell}</td>
            <td class="trainer-col" style="${trainerColumnStyle}">${b.trainerName}</td>
            <td style="min-width: 100px;">${dateStr}</td>
            <td style="min-width: 90px;"><span class="bk-time-display"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
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
    const data = window.bookingsData || [];
    if (!grid) return;

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
    if (titleEl) titleEl.textContent = `${fmt(days[0])} – ${fmt(days[6])}, ${days[6].getFullYear()}`;

    const hours = [];
    for (let h = 6; h <= 22; h++) hours.push(h);
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

    // Build a lookup: date -> hour -> bookings[] (show all statuses on calendar)
    const lookup = {};
    data.forEach(b => {
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

// --- Override renderBookings to use enhanced rendering for admin/staff ---
(function () {
    const poll = setInterval(() => {
        // Wait until script.js has assigned window.renderBookings
        if (typeof window.renderBookings !== 'function') return;
        clearInterval(poll);

        const _originalRender = window.renderBookings;

        window.renderBookings = function () {
            // Guard against re-entrant calls
            if (_bkRenderLock) return;
            _bkRenderLock = true;

            try {
                // Call the original to handle member/trainer notifications, etc.
                _originalRender();

                // Now for admin/staff, re-render the bookingsBody with enhanced UI + proper sort
                const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
                if (loggedInRole === 'member') {
                    // Member view is handled by the original, just update KPIs
                    updateBookingKPIs();
                    return;
                }

                const tbody = document.getElementById('bookingsBody');
                if (!tbody) return;

                const filtered = applyBookingFilters(window.bookingsData || []);
                const totalRecords = filtered.length;
                const totalPages = Math.ceil(totalRecords / bkItemsPerPage);
                if (bkCurrentPage > totalPages && totalPages > 0) bkCurrentPage = totalPages;
                if (bkCurrentPage < 1) bkCurrentPage = 1;

                const startIdx = (bkCurrentPage - 1) * bkItemsPerPage;
                const endIdx = Math.min(startIdx + bkItemsPerPage, totalRecords);

                const countEl = document.getElementById('bkRecordCountDisplay');
                if (countEl) {
                    countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
                }

                const totalHeaderEl = document.getElementById('bkRecordCount');
                if (totalHeaderEl) {
                    totalHeaderEl.textContent = `${totalRecords} record${totalRecords !== 1 ? 's' : ''}`;
                }

                if (window.renderPaginationControls) {
                    window.renderPaginationControls('bkPagination', bkCurrentPage, totalPages, totalRecords, 'changeBkPage');
                }

                const displayData = filtered.slice(startIdx, endIdx);
                tbody.innerHTML = displayData.map(renderEnhancedBookingRow).join('');

                // Update KPIs and filters
                updateBookingKPIs();
                populateTrainerFilter();

                // Update calendar if visible
                if (bkCurrentView === 'calendar') renderBookingCalendar();
            } finally {
                _bkRenderLock = false;
            }
        };

        // Trigger an initial render now that the override is in place
        window.renderBookings();
    }, 100);
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
                if (!bookTime || !bookTime.includes(':')) {
                    showToast("Invalid booking time selected.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
                    return;
                }
                const [bH, bM] = bookTime.split(':').map(Number);
                const bookMins = bH * 60 + bM;

                // 1. Trainer Conflict Check
                const q = fb.query(fb.bookingsCol, fb.where("trainerId", "==", trainerId), fb.where("date", "==", bookDate), fb.where("status", "==", "Confirmed"));
                const snap = await fb.getDocs(q);
                let conflict = false;
                snap.forEach(d => {
                    const ts = d.data().time;
                    if (ts && typeof ts === 'string' && ts.includes(':')) {
                        const parts = ts.split(':');
                        const eH = parseInt(parts[0], 10);
                        const eM = parseInt(parts[1], 10);
                        if (!isNaN(eH) && !isNaN(eM)) {
                            if (Math.abs(bookMins - (eH * 60 + eM)) < 60) conflict = true;
                        }
                    }
                });
                if (conflict) {
                    showToast("Trainer already booked within 1 hour of this time.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
                    return;
                }

                // 2. Member Conflict Check
                const memberQ = fb.query(fb.bookingsCol, fb.where("memberId", "==", memberId), fb.where("date", "==", bookDate), fb.where("status", "==", "Confirmed"));
                const memberSnap = await fb.getDocs(memberQ);
                let memberConflict = false;
                memberSnap.forEach(d => {
                    const ts = d.data().time;
                    if (ts && typeof ts === 'string' && ts.includes(':')) {
                        const parts = ts.split(':');
                        const eH = parseInt(parts[0], 10);
                        const eM = parseInt(parts[1], 10);
                        if (!isNaN(eH) && !isNaN(eM)) {
                            if (Math.abs(bookMins - (eH * 60 + eM)) < 60) memberConflict = true;
                        }
                    }
                });
                if (memberConflict) {
                    showToast("Member is already booked for a confirmed session within 1 hour of this time.", "error");
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
