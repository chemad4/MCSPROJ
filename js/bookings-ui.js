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
        // Position the fixed dropdown — flip above if it would clip the viewport
        const trigger = e.currentTarget;
        const rect = trigger.getBoundingClientRect();
        const dropdown = wrapper.querySelector('.bk-status-dropdown');
        if (dropdown) {
            const viewportH = window.innerHeight;
            const viewportW = window.innerWidth;
            const estHeight = dropdown.offsetHeight || 200;
            const estWidth = dropdown.offsetWidth || 160;
            // Vertical: flip above the trigger if it would overflow the bottom edge
            const top = (rect.bottom + estHeight + 4 > viewportH)
                ? Math.max(8, rect.top - estHeight - 4)
                : (rect.bottom + 4);
            // Horizontal: nudge left if it would overflow the right edge
            const left = (rect.left + estWidth > viewportW - 8)
                ? Math.max(8, viewportW - estWidth - 8)
                : rect.left;
            dropdown.style.top = top + 'px';
            dropdown.style.left = left + 'px';
        }
    }
};

// Close open dropdowns when the page scrolls (otherwise they detach visually from their trigger)
window.addEventListener('scroll', () => {
    document.querySelectorAll('.bk-status-wrapper.open').forEach(w => w.classList.remove('open'));
}, true);

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
        const activeMembers = members.filter(m => {
            const isArchived = (m.status || "").toLowerCase() === 'archived';
            const isSuspended = (m.status || "").toLowerCase() === 'suspended';
            const isExpired = window.isMemberPlanExpired && window.isMemberPlanExpired(m);
            return (m.status || 'Active') === 'Active' && !isArchived && !isSuspended && !isExpired;
        });
        memberSelect.innerHTML = '<option value="" disabled selected>Select Member...</option>' +
            activeMembers.map(m => `<option value="${m.id}">${m.uid ? m.uid + ' - ' : ''}${m.name || (m.givenName + ' ' + m.familyName)}</option>`).join('');
    }
    if (trainerSelect) {
        // Only Active trainers (or those without a status field) may be booked.
        // Trainers On Leave or Suspended must not appear in the dropdown.
        const BOOKABLE_STATUSES = ['Active'];
        const trainers = allUsers.filter(u =>
            (u.role || '').toLowerCase() === 'trainer' &&
            u.status !== 'Archived' &&
            u.status !== 'Suspended' &&
            u.status !== 'On Leave' &&
            (BOOKABLE_STATUSES.includes(u.status || 'Active') || !u.status)
        );
        trainerSelect.innerHTML = '<option value="" disabled selected>Select Trainer...</option>' +
            trainers.map(t => `<option value="${t.id}">${t.uid ? t.uid + ' - ' : ''}${t.name || (t.givenName + ' ' + t.familyName)}</option>`).join('');
    }

    // Reset manual state
    window.manualBookingState = {
        memberId: '',
        memberName: '',
        trainerId: '',
        trainerName: '',
        date: '',
        time: '',
        month: new Date().getMonth(),
        year: new Date().getFullYear()
    };

    const grid = document.getElementById('manualBookingDateTimeGrid');
    const sidebar = document.getElementById('manualBookingDetailsSidebar');
    if (grid) grid.style.display = 'none';
    if (sidebar) sidebar.style.display = 'none';

    window.setupManualCalNav();

    const confirmBtn = document.getElementById('manualConfirmBookingBtn');
    if (confirmBtn) {
        confirmBtn.onclick = window.executeManualBooking;
    }

    // Use shared showModal or direct style block
    const modal = document.getElementById('bookingModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('is-visible');
        modal.removeAttribute('aria-hidden');
    }
};

window.closeBookingDrawer = function () {
    const modal = document.getElementById('bookingModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('is-visible');
        modal.setAttribute('aria-hidden', 'true');
    }
};

// Keep old openBookingModal as alias for backward compat
window.openBookingModal = window.openBookingDrawer;

// --- KPI Update ---
function updateBookingKPIs() {
    const data = window.bookingsData || [];
    const today = new Date().toLocaleDateString('en-CA');
    const todayCount = data.filter(b => b.date === today && b.status !== 'Cancelled').length;
    const pendingCount = data.filter(b => b.status === 'Pending').length;

    // This week range
    const now = new Date();
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6);
    const sow = startOfWeek.toLocaleDateString('en-CA');
    const eow = endOfWeek.toLocaleDateString('en-CA');
    const inWeek = (b) => b.date >= sow && b.date <= eow;
    const weekCount = data.filter(inWeek).length;
    const noShowWeek = data.filter(b => inWeek(b) && b.status === 'No Show').length;

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    el('bkTodayCount', todayCount);
    el('bkPendingCount', pendingCount);
    el('bkNoShowWeek', noShowWeek);
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

    const statuses = ['Pending', 'Confirmed', 'active', 'Completed', 'Cancelled', 'Declined', 'No Show'];
    const dotColors = { Pending: '#F59E0B', Confirmed: '#3B82F6', active: '#8B5CF6', Completed: '#10B981', Cancelled: '#EF4444', Declined: '#B91C1C', 'No Show': '#7F1D1D' };

    const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();

    const allowedTransitions = (window.BOOKING_STATUS_TRANSITIONS && window.BOOKING_STATUS_TRANSITIONS[b.status]) || [];
    const statusCell = `
        <div class="bk-status-wrapper">
            <span class="bk-status-badge ${statusClass}" ${allowedTransitions.length > 0 ? `onclick="toggleBkStatusDropdown(event, '${b.id}')"` : ''}>
                ${b.status} ${allowedTransitions.length > 0 ? '<i class="fa-solid fa-chevron-down bk-chevron"></i>' : ''}
            </span>
            ${allowedTransitions.length > 0 ? `
            <div class="bk-status-dropdown">
                ${allowedTransitions.map(s => `
                    <div class="bk-status-option" onclick="quickUpdateStatus(event, '${b.id}', '${s}')">
                        <span class="bk-dot" style="background: ${dotColors[s]}"></span> ${s}
                    </div>
                `).join('')}
            </div>
            ` : ''}
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

// --- Drawer Form Submit replaced with Premium Calendar Booking Controller ---
window.manualBookingState = {
    memberId: '',
    memberName: '',
    trainerId: '',
    trainerName: '',
    date: '',
    time: '',
    month: new Date().getMonth(),
    year: new Date().getFullYear()
};

window.updateManualBookingState = function() {
    const mSelect = document.getElementById('bookMember');
    const tSelect = document.getElementById('bookTrainer');
    if (!mSelect || !tSelect) return;
    
    window.manualBookingState.memberId = mSelect.value;
    window.manualBookingState.memberName = mSelect.value ? mSelect.options[mSelect.selectedIndex].text : '';
    window.manualBookingState.trainerId = tSelect.value;
    window.manualBookingState.trainerName = tSelect.value ? tSelect.options[tSelect.selectedIndex].text : '';
    
    // Clean up name if it has UID prefix (e.g. "MEM-12345 - Given Family")
    if (window.manualBookingState.memberName.includes(' - ')) {
        window.manualBookingState.memberName = window.manualBookingState.memberName.split(' - ').slice(1).join(' - ');
    }
    if (window.manualBookingState.trainerName.includes(' - ')) {
        window.manualBookingState.trainerName = window.manualBookingState.trainerName.split(' - ').slice(1).join(' - ');
    }

    const summaryMember = document.getElementById('manualSummaryMember');
    const summaryTrainer = document.getElementById('manualSummaryTrainer');
    const creditsDisplay = document.getElementById('manualMemberCreditsDisplay');
    
    if (window.manualBookingState.memberId) {
        const mData = (window.membersData || []).find(m => m.id === window.manualBookingState.memberId);
        const creds = mData ? (mData.sessionsRemaining !== undefined ? mData.sessionsRemaining : 0) : 0;
        summaryMember.innerText = window.manualBookingState.memberName;
        creditsDisplay.innerText = `Credits remaining: ${creds}`;
    } else {
        summaryMember.innerText = "Member Not Selected";
        creditsDisplay.innerText = "Credits: -";
    }
    
    if (window.manualBookingState.trainerId) {
        summaryTrainer.innerText = window.manualBookingState.trainerName;
    } else {
        summaryTrainer.innerText = "Trainer Not Selected";
    }
    
    const grid = document.getElementById('manualBookingDateTimeGrid');
    const sidebar = document.getElementById('manualBookingDetailsSidebar');
    if (window.manualBookingState.memberId && window.manualBookingState.trainerId) {
        if (grid) grid.style.display = 'grid';
        if (sidebar) sidebar.style.display = 'flex';
        window.renderManualBookingCalendar();
        // If a date was already chosen, re-render time slots so conflict
        // availability reflects the newly selected trainer/member. The
        // previously selected time may no longer be valid, so clear it.
        if (window.manualBookingState.date) {
            window.manualBookingState.time = '';
            window.renderManualBookingTimeSlots(window.manualBookingState.date);
        }
        window.updateManualBookingSummary();
    } else {
        if (grid) grid.style.display = 'none';
        if (sidebar) sidebar.style.display = 'none';
    }
};

window.renderManualBookingCalendar = () => {
    const daysGrid = document.getElementById('manualCalDaysGrid');
    const monthTitle = document.getElementById('manualCalMonthTitle');
    if (!daysGrid || !monthTitle || !window.manualBookingState) return;

    const { month, year, date: selectedDate } = window.manualBookingState;
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    monthTitle.innerText = `${monthNames[month]} ${year}`;

    daysGrid.innerHTML = '';

    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < firstDayIndex; i++) {
        const blank = document.createElement('div');
        blank.className = 'cal-day-cell';
        blank.style.pointerEvents = 'none';
        daysGrid.appendChild(blank);
    }

    for (let day = 1; day <= totalDays; day++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day-cell';
        cell.innerText = day;

        const currentMonthString = String(month + 1).padStart(2, '0');
        const currentDayString = String(day).padStart(2, '0');
        const dateStr = `${year}-${currentMonthString}-${currentDayString}`;

        const cellDate = new Date(year, month, day);
        cellDate.setHours(0, 0, 0, 0);

        if (cellDate < today) {
            cell.disabled = true;
        }

        if (dateStr === selectedDate) {
            cell.classList.add('selected');
        }

        const hasBooking = (window.bookingsData || []).some(b => {
            return b.date === dateStr && 
                   b.memberId === window.manualBookingState.memberId && 
                   ["Confirmed", "Pending"].includes(b.status);
        });
        if (hasBooking) {
            cell.classList.add('has-dot');
        }

        cell.addEventListener('click', () => {
            window.manualBookingState.date = dateStr;
            window.manualBookingState.time = ''; 
            
            const selectedCell = daysGrid.querySelector('.cal-day-cell.selected');
            if (selectedCell) selectedCell.classList.remove('selected');
            cell.classList.add('selected');

            window.renderManualBookingTimeSlots(dateStr);
            window.updateManualBookingSummary();
        });

        daysGrid.appendChild(cell);
    }
};

window.renderManualBookingTimeSlots = (dateStr) => {
    const slotsGrid = document.getElementById('manualTimeSlotsGrid');
    const selectedDateHeader = document.getElementById('manualSelectedDateHeader');
    if (!slotsGrid || !selectedDateHeader || !window.manualBookingState) return;

    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const options = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
    selectedDateHeader.innerText = dateObj.toLocaleDateString('en-US', options);

    slotsGrid.innerHTML = '';

    const startHour = 8;
    const endHour = 20;

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const bookings = window.bookingsData || [];
    const trainerBookings = bookings.filter(b => b.date === dateStr && b.trainerId === window.manualBookingState.trainerId && ["Confirmed", "Pending"].includes(b.status));
    const memberBookings = bookings.filter(b => b.date === dateStr && b.memberId === window.manualBookingState.memberId && ["Confirmed", "Pending"].includes(b.status));

    for (let h = startHour; h <= endHour; h++) {
        const timeStr = `${String(h).padStart(2, '0')}:00`;
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const displayTime = `${displayHour}:00 ${period}`;

        const slotBtn = document.createElement('button');
        slotBtn.type = 'button';
        slotBtn.className = 'time-slot-btn';
        slotBtn.innerText = displayTime;

        let disabled = false;
        let reason = '';

        if (dateStr === todayStr) {
            const currentHour = today.getHours();
            if (h <= currentHour) {
                disabled = true;
                reason = 'Past';
            }
        }

        const slotMins = h * 60;
        const hasTrainerConflict = trainerBookings.some(tb => {
            const [tbH, tbM] = tb.time.split(':').map(Number);
            const tbMins = tbH * 60 + tbM;
            return Math.abs(slotMins - tbMins) < 60; 
        });

        if (hasTrainerConflict) {
            disabled = true;
            reason = 'Trainer Booked';
        }

        const hasMemberConflict = memberBookings.some(mb => {
            const [mbH, mbM] = mb.time.split(':').map(Number);
            const mbMins = mbH * 60 + mbM;
            return Math.abs(slotMins - mbMins) < 60; 
        });

        if (hasMemberConflict) {
            disabled = true;
            reason = 'Conflict';
        }

        if (disabled) {
            slotBtn.disabled = true;
            slotBtn.innerText = `${displayTime} (${reason})`;
        } else {
            if (timeStr === window.manualBookingState.time) {
                slotBtn.classList.add('selected');
            }

            slotBtn.addEventListener('click', () => {
                window.manualBookingState.time = timeStr;

                const selectedBtn = slotsGrid.querySelector('.time-slot-btn.selected');
                if (selectedBtn) selectedBtn.classList.remove('selected');
                slotBtn.classList.add('selected');

                window.updateManualBookingSummary();
            });
        }

        slotsGrid.appendChild(slotBtn);
    }
};

window.updateManualBookingSummary = () => {
    const summaryDateTime = document.getElementById('manualSummaryDateTime');
    const confirmBtn = document.getElementById('manualConfirmBookingBtn');
    if (!summaryDateTime || !confirmBtn || !window.manualBookingState) return;

    const { date, time } = window.manualBookingState;

    if (date && time) {
        const [y, m, d] = date.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const options = { month: 'short', day: 'numeric', year: 'numeric' };
        const readableDate = dateObj.toLocaleDateString('en-US', options);

        const [h, min] = time.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const readableTime = `${displayHour}:00 ${period}`;

        summaryDateTime.innerText = `${readableDate} at ${readableTime}`;
        confirmBtn.disabled = false;
        confirmBtn.removeAttribute('aria-disabled');
    } else {
        summaryDateTime.innerText = "Choose Date & Time";
        confirmBtn.disabled = true;
        confirmBtn.setAttribute('aria-disabled', 'true');
    }
};

window.setupManualCalNav = () => {
    const prevBtn = document.getElementById('manualCalPrevMonthBtn');
    const nextBtn = document.getElementById('manualCalNextMonthBtn');
    if (!prevBtn || !nextBtn || window.manualCalNavSetup) return;
    
    window.manualCalNavSetup = true;
    prevBtn.addEventListener('click', () => {
        window.manualBookingState.month--;
        if (window.manualBookingState.month < 0) {
            window.manualBookingState.month = 11;
            window.manualBookingState.year--;
        }
        window.renderManualBookingCalendar();
    });
    
    nextBtn.addEventListener('click', () => {
        window.manualBookingState.month++;
        if (window.manualBookingState.month > 11) {
            window.manualBookingState.month = 0;
            window.manualBookingState.year++;
        }
        window.renderManualBookingCalendar();
    });
};

window.executeManualBooking = async () => {
    const confirmBtn = document.getElementById('manualConfirmBookingBtn');
    if (confirmBtn.disabled) return;
    const originalHtml = confirmBtn.innerHTML;

    if (!window.manualBookingState) {
        showToast("Booking state is invalid.", "error");
        return;
    }
    const { memberId, memberName, trainerId, trainerName, date, time } = window.manualBookingState;
    if (!memberId || !trainerId || !date || !time) {
        showToast("Please make sure all booking fields (Member, Trainer, Date, and Time) are selected.", "error");
        return;
    }

    // Same-day pre-confirm: warn (but allow) when the target member already has
    // a booking on the chosen date. Skipped once after the user clicks Proceed.
    if (!window._manualBookingSkipSameDayConfirm && typeof window.findSameDayBookings === 'function') {
        const sameDay = window.findSameDayBookings(memberId, date);
        if (sameDay.length > 0) {
            const lines = sameDay.map(b => '• ' + window.formatBookingSummary(b)).join('\n');
            window.showConfirm({
                title: 'Member already has a session today',
                message: `${memberName || 'This member'} already has ${sameDay.length === 1 ? 'a booking' : 'bookings'} on this date:\n${lines}\n\nProceed with another booking at ${time} with ${trainerName}?`,
                tone: 'warning',
                confirmText: 'Proceed anyway',
                cancelText: 'Cancel',
                onConfirm: () => {
                    window._manualBookingSkipSameDayConfirm = true;
                    window.executeManualBooking();
                }
            });
            return;
        }
    }
    window._manualBookingSkipSameDayConfirm = false;

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

    try {
        if (typeof window.syncServerTimeOffset === 'function') {
            await window.syncServerTimeOffset();
        }
        const offset = window.serverTimeOffsetMs || 0;
        const freshNowMs = Date.now() + offset;
        const targetBookingTimeMsCheck = new Date(date + 'T' + time).getTime();
        if (targetBookingTimeMsCheck < freshNowMs) {
            showToast("Choose a date and time in the future. Past sessions cannot be booked.", "error");
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = originalHtml;
            return;
        }

        const fb = window._fb;
        await fb.runTransaction(fb.db, async (tx) => {
            const memberRef = fb.doc(fb.db, "users", memberId);
            const trainerRef = fb.doc(fb.db, "users", trainerId);
            const trainerSlotRef = fb.doc(fb.db, "bookingSlots", window.slotIdForTrainer(trainerId, date, time));
            const memberSlotRef  = fb.doc(fb.db, "bookingSlots", window.slotIdForMember(memberId, date, time));

            const [memberSnap, trainerSnap, trainerSlotSnap, memberSlotSnap] = await Promise.all([
                tx.get(memberRef),
                tx.get(trainerRef),
                tx.get(trainerSlotRef),
                tx.get(memberSlotRef)
            ]);

            if (!memberSnap.exists()) {
                throw new Error("Member record does not exist.");
            }
            // H1: trainer must still exist, still be a Trainer, and still be Active.
            if (!trainerSnap.exists()) {
                throw new Error("Trainer no longer exists. Please choose a different trainer.");
            }
            const tData = trainerSnap.data() || {};
            if ((tData.role || '').toLowerCase() !== 'trainer') {
                throw new Error("Selected user is no longer a trainer. Please choose a different trainer.");
            }
            // O2 (Sprint 9): match the member-booking path's check at script.js:9037.
            // Treat missing status as 'Active' so trainers seeded without an explicit status
            // field aren't incorrectly rejected during admin/staff manual booking.
            if ((tData.status || 'Active') !== 'Active') {
                throw new Error("Trainer is not currently active. Please choose a different trainer.");
            }
            const mData = memberSnap.data();

            if ((mData.status || 'Active') === 'Suspended') {
                throw new Error("ACCESS_DENIED: Member account is suspended. Bookings are prohibited.");
            }
            if ((mData.status || 'Active') === 'Archived') {
                throw new Error("ACCESS_DENIED: Member account is archived. Bookings are prohibited.");
            }

            // Expiration Check
            if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                throw new Error("Member's membership has expired. Please renew their plan before booking.");
            }
            if (typeof mData.dateRegistered === 'number') {
                const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(mData.plan) : 30;
                const expiryAt = mData.dateRegistered + planDays * 24 * 60 * 60 * 1000;
                const targetBookingTimeMs = new Date(date + 'T' + time).getTime();
                if (targetBookingTimeMs > expiryAt) {
                    throw new Error("Target booking date exceeds the member's membership plan expiration date. Please renew their plan for that period.");
                }
            }

            // Time-Tampering / Future Date check
            const freshNowMsTx = Date.now() + (window.serverTimeOffsetMs || 0);
            const targetBookingTimeMsTx = new Date(date + 'T' + time).getTime();
            if (targetBookingTimeMsTx < freshNowMsTx) {
                throw new Error("Choose a date and time in the future. Past sessions cannot be booked.");
            }

            // Slot collisions
            if (trainerSlotSnap.exists()) {
                throw new Error("Trainer already has a confirmed session at this hour.");
            }
            if (memberSlotSnap.exists()) {
                throw new Error("Member already has a booking at this hour.");
            }

            // Credit Check
            const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
            if (sessionsRemaining <= 0) {
                throw new Error("Member has 0 session credits remaining. Please buy more credits first.");
            }

            // Write atomically
            const newBookingRef = fb.doc(fb.bookingsCol);
            tx.update(memberRef, { sessionsRemaining: fb.increment(-1) });
            tx.set(trainerSlotRef, { bookingId: newBookingRef.id, trainerId, date, time });
            tx.set(memberSlotRef,  { bookingId: newBookingRef.id, memberId,  date, time });

            tx.set(newBookingRef, {
                memberId,
                memberName,
                trainerId,
                trainerName,
                date,
                time,
                status: "Confirmed",
                creditState: "held",
                timestamp: Date.now()
            });
        });

        window.closeModal('bookingModal');
        showToast("PT Session booked successfully!", "success");
        if (window.logActivity) window.logActivity("Booking Created", `Admin/Staff booked a training session on ${date} at ${time} with ${trainerName}.`);
    } catch (err) {
        console.error("Manual Booking failed:", err);
        showToast(err.message || "Failed to book session.", "error");
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = originalHtml;
    }
};

// ============================================
// SESSION LIFECYCLE WORKFLOW ENGINE
// ============================================
// Monitors real-world clock against booking start/end times.
// Sessions are treated as 1 hour long (matching the slot-lock window).
// All Firestore mutations go through _fb (set up by script.js).
//
// Lifecycle:
//   Confirmed → (trainer confirms at startTime) → active
//   Confirmed → (no confirmation within 15 min)  → No Show
//   active    → (clock passes startTime + 60 min) → Completed
//   Completed → pending member rating flag written to Firestore
// ============================================

(function () {
    // Track in-flight state so we don't double-fire transitions.
    const _lifecycleTriggered = new Set(); // bookingId → 'start_prompt' | 'noshow' | 'complete' | 'rated'

    // ---- helpers ----

    function _nowMs() {
        return Date.now() + (window.serverTimeOffsetMs || 0);
    }

    function _sessionStartMs(b) {
        return new Date(`${b.date}T${b.time}`).getTime();
    }

    // Sessions are 1 hour (same constraint the slot-lock enforces).
    function _sessionEndMs(b) {
        return _sessionStartMs(b) + 60 * 60 * 1000;
    }

    // Direct Firestore write for lifecycle transitions — bypasses the
    // interactive `updateBookingStatus` confirmation dialogs intentionally,
    // since these are automated system-driven state changes.
    async function _systemFlipStatus(bookingId, newStatus, extraFields) {
        const fb = window._fb;
        if (!fb) return;
        try {
            await fb.runTransaction(fb.db, async (tx) => {
                const bookingRef = fb.doc(fb.db, "bookings", bookingId);
                const snap = await tx.get(bookingRef);
                if (!snap.exists()) throw new Error("Booking gone");
                const bData = snap.data();

                const allowed = (window.BOOKING_STATUS_TRANSITIONS && window.BOOKING_STATUS_TRANSITIONS[bData.status]) || [];
                if (!allowed.includes(newStatus)) throw new Error(`Transition ${bData.status} → ${newStatus} blocked`);

                const update = { status: newStatus, ...(extraFields || {}) };

                if (newStatus === 'Completed' || newStatus === 'No Show') {
                    if (bData.creditState === 'consumed') {
                        // already finalised
                    } else if (bData.creditState === 'held') {
                        update.creditState = 'consumed';
                    } else if (!bData.creditState && bData.memberId) {
                        tx.update(fb.doc(fb.db, "users", bData.memberId), { sessionsRemaining: fb.increment(-1) });
                        update.creditState = 'consumed';
                    }
                    // Free slot locks
                    if (bData.trainerId && bData.date && bData.time) {
                        const { slotIdForTrainer, slotIdForMember } = window;
                        if (slotIdForTrainer) tx.delete(fb.doc(fb.db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                        if (slotIdForMember)  tx.delete(fb.doc(fb.db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                    }
                }

                tx.update(bookingRef, update);
            });
        } catch (err) {
            console.warn(`[SessionEngine] systemFlipStatus(${bookingId}, ${newStatus}) failed:`, err.message);
        }
    }

    // Write a pending-rating flag to Firestore so the member's next
    // dashboard render can pick it up regardless of which tab they're on.
    async function _writePendingRating(booking) {
        const fb = window._fb;
        if (!fb || !booking.memberId) return;
        try {
            const ratingRef = fb.doc(fb.db, "pendingRatings", booking.id);
            await fb.runTransaction(fb.db, async (tx) => {
                const snap = await tx.get(ratingRef);
                if (snap.exists()) return; // already queued
                tx.set(ratingRef, {
                    bookingId: booking.id,
                    memberId: booking.memberId,
                    memberName: booking.memberName || '',
                    trainerId: booking.trainerId,
                    trainerName: booking.trainerName || '',
                    sessionDate: booking.date,
                    sessionTime: booking.time,
                    createdAt: Date.now(),
                    resolved: false
                });
            });
        } catch (err) {
            console.warn("[SessionEngine] Failed to write pending rating:", err.message);
        }
    }

    // ---- trainer "Confirm and Start Session" modal ----

    function _showStartSessionModal(booking) {
        const key = `start_prompt:${booking.id}`;
        if (_lifecycleTriggered.has(key)) return;
        _lifecycleTriggered.add(key);

        const noShowDeadlineMs = _sessionStartMs(booking) + 15 * 60 * 1000;

        // Build a countdown string for the modal message
        const minsLeft = Math.max(0, Math.round((noShowDeadlineMs - _nowMs()) / 60000));

        window.showConfirm({
            title: 'Session Starting Now',
            message: `Your session with ${booking.memberName} is scheduled to start now.\n\nConfirm to start the session. If you do not confirm within 15 minutes, the session will be automatically marked as a No Show.\n\nTime remaining: ${minsLeft} min`,
            tone: 'info',
            confirmText: 'Confirm and Start Session',
            cancelText: 'Dismiss',
            onConfirm: async () => {
                await _systemFlipStatus(booking.id, 'active');
                if (window.logActivity) window.logActivity("Session Started", `Trainer confirmed session start for ${booking.memberName} on ${booking.date}.`);
                showToast(`Session with ${booking.memberName} is now active.`, "success");
            }
        });
    }

    // ---- main tick ----

    function _lifecycleTick() {
        const role = (localStorage.getItem("userRole") || "").toLowerCase();
        const userId = localStorage.getItem("userId");
        const now = _nowMs();
        const bookings = window.bookingsData || [];

        bookings.forEach(b => {
            if (!b.id || !b.date || !b.time) return;

            const startMs = _sessionStartMs(b);
            const endMs   = _sessionEndMs(b);

            if (isNaN(startMs)) return;

            // ── Rule 2: Trainer prompt at startTime for Confirmed bookings ──
            if (
                b.status === 'Confirmed' &&
                role === 'trainer' &&
                b.trainerId === userId &&
                now >= startMs &&
                now < startMs + 15 * 60 * 1000 &&
                !_lifecycleTriggered.has(`start_prompt:${b.id}`)
            ) {
                _showStartSessionModal(b);
            }

            // ── Rule 3: Auto No-Show if trainer never confirmed within 15 min ──
            if (
                b.status === 'Confirmed' &&
                now >= startMs + 15 * 60 * 1000 &&
                !_lifecycleTriggered.has(`noshow:${b.id}`)
            ) {
                _lifecycleTriggered.add(`noshow:${b.id}`);
                _systemFlipStatus(b.id, 'No Show').then(() => {
                    if (window.logActivity) window.logActivity("Auto No Show", `Booking ${b.id} auto-marked No Show (trainer did not confirm within 15 min).`);
                });
            }

            // ── Rule 4: Auto-Complete when clock crosses endTime ──
            if (
                b.status === 'active' &&
                now >= endMs &&
                !_lifecycleTriggered.has(`complete:${b.id}`)
            ) {
                _lifecycleTriggered.add(`complete:${b.id}`);
                _systemFlipStatus(b.id, 'Completed').then(async () => {
                    if (window.logActivity) window.logActivity("Session Completed", `Booking ${b.id} auto-completed after scheduled end time.`);
                    // Rule 5: queue a rating prompt for the member
                    await _writePendingRating(b);
                });
            }
        });
    }

    // Kick off once bookingsData is available, then run every 30 s.
    const _engineInit = setInterval(() => {
        if (typeof window.bookingsData === 'undefined') return;
        clearInterval(_engineInit);
        _lifecycleTick(); // immediate first pass
        setInterval(_lifecycleTick, 30_000);
    }, 500);

    // ---- Rule 5: Member rating prompt on dashboard render ----
    // Checks Firestore for unresolved pendingRatings for the logged-in member
    // and shows the rating modal once per session.

    const _shownRatingFor = new Set();

    async function _checkPendingRatingsForMember() {
        const fb = window._fb;
        if (!fb) return;
        const role = (localStorage.getItem("userRole") || "").toLowerCase();
        const userId = localStorage.getItem("userId");
        if (role !== 'member' || !userId) return;

        try {
            const q = fb.query(
                fb.pendingRatingsCol,
                fb.where("memberId", "==", userId),
                fb.where("resolved", "==", false)
            );
            const snap = await fb.getDocs(q);
            snap.forEach(docSnap => {
                const data = docSnap.data();
                if (_shownRatingFor.has(data.bookingId)) return;
                _shownRatingFor.add(data.bookingId);
                _showMemberRatingModal(data, docSnap.id);
            });
        } catch (err) {
            console.warn("[SessionEngine] Could not load pending ratings:", err.message);
        }
    }

    function _showMemberRatingModal(ratingData, docId) {
        const modal = document.getElementById('sessionRatingModal');
        if (!modal) return;

        const trainerEl  = document.getElementById('srModalTrainerName');
        const dateEl     = document.getElementById('srModalSessionDate');
        const submitBtn  = document.getElementById('srModalSubmitBtn');
        const skipBtn    = document.getElementById('srModalSkipBtn');
        const ratingInput = document.getElementById('srModalRatingText');
        const remarksInput = document.getElementById('srModalRemarksText');

        if (trainerEl)  trainerEl.textContent  = ratingData.trainerName || 'your trainer';
        if (dateEl)     dateEl.textContent      = `${ratingData.sessionDate || ''} at ${ratingData.sessionTime || ''}`;
        if (ratingInput)  ratingInput.value     = '';
        if (remarksInput) remarksInput.value    = '';

        const close = () => {
            modal.style.display = 'none';
            if (submitBtn)  submitBtn.onclick = null;
            if (skipBtn)    skipBtn.onclick   = null;
        };

        const resolve = async (rating, remarks) => {
            const fb = window._fb;
            if (!fb) return;
            try {
                await fb.runTransaction(fb.db, async (tx) => {
                    const ref = fb.doc(fb.db, "pendingRatings", docId);
                    tx.update(ref, {
                        resolved: true,
                        rating: rating || '',
                        remarks: remarks || '',
                        resolvedAt: Date.now()
                    });
                });
                if (rating || remarks) {
                    showToast("Thank you for your feedback!", "success");
                    if (window.logActivity) window.logActivity("Session Rated", `Member rated session with ${ratingData.trainerName}.`);
                }
            } catch (err) {
                console.warn("[SessionEngine] Failed to resolve rating:", err.message);
            }
            close();
        };

        if (skipBtn) skipBtn.onclick = () => resolve('', '');
        if (submitBtn) submitBtn.onclick = async () => {
            const rating  = ratingInput  ? ratingInput.value.trim()  : '';
            const remarks = remarksInput ? remarksInput.value.trim() : '';
            if (!rating) {
                if (ratingInput) {
                    ratingInput.classList.remove('is-invalid');
                    void ratingInput.offsetWidth;
                    ratingInput.classList.add('is-invalid');
                    setTimeout(() => ratingInput.classList.remove('is-invalid'), 1200);
                    ratingInput.focus();
                }
                return;
            }
            await resolve(rating, remarks);
        };

        modal.style.display = 'flex';
    }

    // Hook into renderBookings so member sees the prompt on their next render.
    const _ratingPollInit = setInterval(() => {
        if (typeof window.renderBookings !== 'function') return;
        clearInterval(_ratingPollInit);
        const _origRender = window.renderBookings;
        window.renderBookings = function (...args) {
            _origRender.apply(this, args);
            // Only poll for member role — fires async without blocking the render
            if ((localStorage.getItem("userRole") || "").toLowerCase() === 'member') {
                _checkPendingRatingsForMember();
            }
        };
    }, 150);

    window._sessionLifecycleEngine = {
        triggerTick: _lifecycleTick,
        checkRatings: _checkPendingRatingsForMember
    };
})();
