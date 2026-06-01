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

// --- Bookings table boot: keep date filters blank; build conditional Firestore query ---
(function initBookingsTable() {
    function clearBookingsDateInputs() {
        const fromEl = document.getElementById('bkDateFrom');
        const toEl = document.getElementById('bkDateTo');
        // Do not prefill with today — empty inputs mean "no date constraint".
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
    }

    window.buildBookingsQuery = function () {
        const fb = window._fb;
        if (!fb) return null;

        const currentUserId = localStorage.getItem('userId');
        const roleNorm = (localStorage.getItem('userRole') || '').toLowerCase();
        const isStaffSide = roleNorm === 'admin' || roleNorm === 'staff';

        const constraints = [];
        if (roleNorm === 'member') {
            if (!currentUserId) return null;
            constraints.push(fb.where('memberId', '==', currentUserId));
        } else if (roleNorm === 'trainer') {
            if (!currentUserId) return null;
            constraints.push(fb.where('trainerId', '==', currentUserId));
        } else if (isStaffSide) {
            const startVal = document.getElementById('bkDateFrom')?.value || '';
            const endVal = document.getElementById('bkDateTo')?.value || '';
            if (startVal) constraints.push(fb.where('date', '>=', startVal));
            if (endVal) constraints.push(fb.where('date', '<=', endVal));
        } else {
            return null;
        }

        return constraints.length
            ? fb.query(fb.bookingsCol, ...constraints)
            : fb.bookingsCol;
    };

    function bootstrapBookingsPipeline() {
        clearBookingsDateInputs();
        if (typeof window.rebindBookingsListener === 'function') {
            window.rebindBookingsListener();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', clearBookingsDateInputs);
    } else {
        clearBookingsDateInputs();
    }

    const pipelinePoll = setInterval(() => {
        if (typeof window.rebindBookingsListener !== 'function') return;
        clearInterval(pipelinePoll);
        bootstrapBookingsPipeline();
    }, 100);
})();

// --- Business rule guards (bridged to script.js status / cancellation modules) ---
const BOOKING_TERMINAL_STATUSES = new Set(['Completed', 'Cancelled', 'Declined', 'No Show']);
const BOOKING_ACTIVE_SLOT_STATUSES = ['Confirmed', 'active', 'In Session'];
const BOOKING_INACTIVE_PACKAGE_STATUSES = new Set(['Suspended', 'Archived', 'Frozen', 'Expired', 'On Leave']);
const BOOKING_LATE_CANCEL_MS = 2 * 60 * 60 * 1000;
const MEMBER_ELIGIBILITY_ABORT_MSG = 'Operation Aborted: Member has insufficient session credits or an inactive package.';
const TRAINER_CONFLICT_MSG = 'Scheduling Conflict: Trainer already booked for this time slot.';

window.BOOKING_TERMINAL_STATUSES = BOOKING_TERMINAL_STATUSES;
window.BOOKING_LATE_CANCEL_MS = BOOKING_LATE_CANCEL_MS;

window.isBookingTerminalStatus = function (status) {
    return BOOKING_TERMINAL_STATUSES.has(status);
};

window.getBookingSessionStartMs = function (booking) {
    if (!booking || !booking.date || !booking.time) return NaN;
    return new Date(`${booking.date}T${booking.time}`).getTime();
};

window.isLateCancellation = function (booking) {
    const startMs = window.getBookingSessionStartMs(booking);
    if (isNaN(startMs)) return false;
    const offset = window.serverTimeOffsetMs || 0;
    const diffMs = startMs - (Date.now() + offset);
    return diffMs >= 0 && diffMs < BOOKING_LATE_CANCEL_MS;
};

window.formatBookingDateAndTime = function (date, timeStr) {
    if (!date) return 'unknown date';
    const rawTime = timeStr || '00:00';
    const [y, m, d] = date.split('-').map(Number);
    const [eH, eM] = rawTime.split(':').map(Number);
    const dateObj = new Date(y, m - 1, d);
    if (isNaN(dateObj.getTime())) return `${date} ${rawTime}`;
    const datePart = dateObj.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
    const period = eH >= 12 ? 'PM' : 'AM';
    const dispHour = eH > 12 ? eH - 12 : (eH === 0 ? 12 : eH);
    const timePart = `${dispHour}:${String(eM || 0).padStart(2, '0')} ${period}`;
    return `${datePart} at ${timePart}`;
};

window.buildBookingDeclineAutoMessage = function (reason, date, startTime) {
    const dateAndTime = window.formatBookingDateAndTime(date, startTime);
    const trimmedReason = (reason || '').trim() || 'No reason provided';
    return `[auto-generated message] I have to decline your Trainer booking on ${dateAndTime} due to: ${trimmedReason}`;
};

window.assertMemberBookingEligible = function (memberData, bookingContext) {
    if (!memberData) {
        return { ok: false, message: MEMBER_ELIGIBILITY_ABORT_MSG };
    }
    const pkgStatus = memberData.status || 'Active';
    if (BOOKING_INACTIVE_PACKAGE_STATUSES.has(pkgStatus)) {
        return { ok: false, message: MEMBER_ELIGIBILITY_ABORT_MSG };
    }
    if (typeof window.isMemberPlanExpired === 'function' && window.isMemberPlanExpired(memberData)) {
        return { ok: false, message: MEMBER_ELIGIBILITY_ABORT_MSG };
    }
    const creditHeld = bookingContext && bookingContext.creditState === 'held';
    const sessionsRemaining = memberData.sessionsRemaining !== undefined
        ? Number(memberData.sessionsRemaining)
        : 0;
    if (!creditHeld && (isNaN(sessionsRemaining) || sessionsRemaining <= 0)) {
        return { ok: false, message: MEMBER_ELIGIBILITY_ABORT_MSG };
    }
    return { ok: true };
};

window._bookingHourKey = function (timeStr) {
    const hour = parseInt((timeStr || '').split(':')[0], 10);
    return isNaN(hour) ? '' : String(hour).padStart(2, '0');
};

window.queryTrainerScheduleConflict = async function (trainerId, date, time, excludeBookingId) {
    const fb = window._fb;
    if (!fb || !trainerId || !date || !time) return false;

    const targetHour = window._bookingHourKey(time);
    if (!targetHour) return false;

    const snap = await fb.getDocs(fb.query(fb.bookingsCol, fb.where('date', '==', date)));
    for (const docSnap of snap.docs) {
        if (excludeBookingId && docSnap.id === excludeBookingId) continue;
        const data = docSnap.data();
        if (data.trainerId !== trainerId) continue;
        if (!BOOKING_ACTIVE_SLOT_STATUSES.includes(data.status)) continue;
        if (window._bookingHourKey(data.time) === targetHour) return true;
    }
    return false;
};

// ── Defensive helpers: null-safe records, race detection, button recovery ──
window.BOOKING_STATE_CHANGED_MSG = 'Operation Aborted: This booking state has already changed.';

window.normalizeBookingRecord = function (raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: raw.id || '',
        memberId: raw.memberId || '',
        memberName: raw.memberName || 'Unknown Member',
        trainerId: raw.trainerId || '',
        trainerName: raw.trainerName || 'Unassigned',
        date: raw.date || '',
        time: raw.time || raw.startTime || '00:00',
        status: raw.status || 'Pending',
        creditState: raw.creditState || '',
        cancelRemarks: raw.cancelRemarks || '',
        timestamp: raw.timestamp || 0
    };
};

window.verifyBookingServerState = function (serverData, uiExpectedStatus) {
    const serverStatus = (serverData && serverData.status) || 'Pending';
    const expected = uiExpectedStatus || 'Pending';
    if (serverStatus !== expected) {
        throw new Error(window.BOOKING_STATE_CHANGED_MSG);
    }
};

window.bookingActionFailedToast = function (err) {
    const msg = (err && err.message) ? err.message : 'Unknown error';
    showToast('Action Failed: ' + msg, 'error');
};

window.runWithBookingButton = async function (btn, asyncFn) {
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }
    try {
        await asyncFn();
    } catch (err) {
        console.error('[bookings-ui] Action failed:', err);
        window.bookingActionFailedToast(err);
        throw err;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
};

window.changeBkPage = function (dir) {
    bkCurrentPage += dir;
    if (bkCurrentPage < 1) bkCurrentPage = 1;
    window.renderBookings();
};

// --- View Toggle ---
window.switchBookingView = function (view, btn) {
    bkCurrentView = view;
    document.querySelectorAll('.bk-toggle-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const listPanel = document.getElementById('bkListPanel');
    const calPanel = document.getElementById('bkCalendarPanel');
    if (listPanel) listPanel.style.display = view === 'list' ? '' : 'none';
    if (calPanel) calPanel.style.display = view === 'calendar' ? '' : 'none';
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
    // EH-4: guard against null when a rapid re-render replaces the DOM node during click
    const wrapper = e.currentTarget?.closest('.bk-status-wrapper');
    if (!wrapper) return;
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

    // Reset manual state (allowSameDay always starts false so the override must be re-confirmed each time)
    window.manualBookingState = {
        memberId: '',
        memberName: '',
        trainerId: '',
        trainerName: '',
        date: '',
        time: '',
        month: new Date().getMonth(),
        year: new Date().getFullYear(),
        allowSameDay: false
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
    const data = (window.bookingsData || [])
        .map(b => window.normalizeBookingRecord(b))
        .filter(Boolean);
    const today = new Date().toLocaleDateString('en-CA');
    const todayCount = data.filter(b => (b.date || '') === today && (b.status || 'Pending') !== 'Cancelled').length;
    const pendingCount = data.filter(b => (b.status || 'Pending') === 'Pending').length;

    // This week range
    const now = new Date();
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6);
    const sow = startOfWeek.toLocaleDateString('en-CA');
    const eow = endOfWeek.toLocaleDateString('en-CA');
    const inWeek = (b) => (b.date || '') >= sow && (b.date || '') <= eow;
    const weekCount = data.filter(inWeek).length;
    const noShowWeek = data.filter(b => inWeek(b) && (b.status || '') === 'No Show').length;

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
    const safeRows = (Array.isArray(data) ? data : [])
        .map(b => window.normalizeBookingRecord(b))
        .filter(Boolean);
    let filtered = [...safeRows];

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

    // Date range — only constrain when the operator has entered a value
    const startVal = document.getElementById('bkDateFrom')?.value || '';
    const endVal = document.getElementById('bkDateTo')?.value || '';
    if (startVal) filtered = filtered.filter(b => b.date >= startVal);
    if (endVal) filtered = filtered.filter(b => b.date <= endVal);

    // Status weight: active bookings float to the top, terminal states sink to the bottom.
    // Weight 1 = In Session, 2 = Confirmed, 3 = Pending, 4 = Completed, 5 = Cancelled / No Show
    const STATUS_WEIGHT = { 'In Session': 1, 'active': 1, 'Confirmed': 2, 'Pending': 3, 'Completed': 4, 'Cancelled': 5, 'No Show': 5, 'Declined': 5 };
    const weightOf = (b) => STATUS_WEIGHT[b.status || 'Pending'] ?? 3;

    filtered.sort((a, b) => {
        // Primary: status weight (ascending — lower weight = more urgent, stays on top)
        const wDiff = weightOf(a) - weightOf(b);
        if (wDiff !== 0) return wDiff;

        // Secondary: user-selected sort field + direction within the same weight tier
        let va, vb;
        if (bkSortField === 'memberName') {
            va = (a.memberName || '').toLowerCase();
            vb = (b.memberName || '').toLowerCase();
        } else if (bkSortField === 'time') {
            va = a.time || '00:00';
            vb = b.time || '00:00';
        } else {
            va = (a.date || '') + 'T' + (a.time || '00:00');
            vb = (b.date || '') + 'T' + (b.time || '00:00');
        }

        if (va < vb) return bkSortDir === 'asc' ? -1 : 1;
        if (va > vb) return bkSortDir === 'asc' ? 1 : -1;

        // Tertiary: chronological by date+startTime when both primary and secondary are equal
        const da = (a.date || '') + 'T' + (a.time || '00:00');
        const db = (b.date || '') + 'T' + (b.time || '00:00');
        return da < db ? -1 : da > db ? 1 : 0;
    });

    return filtered;
}

// --- Enhanced Row Renderer ---
function renderEnhancedBookingRow(raw) {
    const b = window.normalizeBookingRecord(raw);
    if (!b) return '';

    const rawDt = b.date && b.time ? `${b.date}T${b.time}` : null;
    const dateObj = rawDt ? new Date(rawDt) : null;
    const dateStr = (dateObj && !isNaN(dateObj)) ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (b.date || '—');
    const timeStr = (dateObj && !isNaN(dateObj)) ? dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : (b.time || '00:00');

    // SP-4: guard against missing status; SL-4: whitelist to prevent CSS injection
    const VALID_STATUS_KEYS = new Set(['pending','confirmed','active','completed','cancelled','declined','noshow']);
    const rawStatusKey = (b.status || 'Pending').toLowerCase().replace(/\s+/g, '');
    const statusKey = VALID_STATUS_KEYS.has(rawStatusKey) ? rawStatusKey : 'unknown';
    const statusClass = `status-${statusKey === 'noshow' ? 'noshow' : statusKey}`;

    const dotColors = { Pending: '#F59E0B', Confirmed: '#3B82F6', active: '#8B5CF6', Completed: '#10B981', Cancelled: '#EF4444', Declined: '#B91C1C', 'No Show': '#7F1D1D' };

    const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
    const rowStatus = b.status || 'Pending';
    const rowId = b.id || '';

    const allowedTransitions = (window.BOOKING_STATUS_TRANSITIONS && window.BOOKING_STATUS_TRANSITIONS[rowStatus]) || [];
    const isTerminal = typeof window.isBookingTerminalStatus === 'function'
        && window.isBookingTerminalStatus(rowStatus);
    const statusCell = `
        <div class="bk-status-wrapper">
            <span class="bk-status-badge ${statusClass}" ${(!isTerminal && allowedTransitions.length > 0) ? `onclick="toggleBkStatusDropdown(event, '${rowId}')"` : ''}>
                ${rowStatus} ${(!isTerminal && allowedTransitions.length > 0) ? '<i class="fa-solid fa-chevron-down bk-chevron"></i>' : ''}
            </span>
            ${(!isTerminal && allowedTransitions.length > 0) ? `
            <div class="bk-status-dropdown">
                ${allowedTransitions.map(s => `
                    <div class="bk-status-option" onclick="quickUpdateStatus(event, '${rowId}', '${s}')">
                        <span class="bk-dot" style="background: ${dotColors[s] || '#64748B'}"></span> ${s}
                    </div>
                `).join('')}
            </div>
            ` : ''}
        </div>
    `;

    // Hide trainer column if role is trainer
    const trainerColumnStyle = loggedInRole === 'trainer' ? 'display: none;' : '';

    // Trainer: show accept/decline for pending, edit for others; Admin/Staff: full actions
    // Terminal states are audit-locked — no mutation controls rendered.
    let actions = '';
    if (isTerminal) {
        actions = '<span style="color: var(--text-muted); font-size: 11px;">Locked</span>';
    } else if (loggedInRole === 'trainer') {
        if (rowStatus === 'Pending') {
            actions = `
                <button type="button" class="btn-icon btn-edit" style="color: #27ae60;" title="Accept" onclick="updateBookingStatus('${rowId}', 'Confirmed', this)"><i class="fas fa-check"></i></button>
                <button type="button" class="btn-icon btn-delete" style="color: #e74c3c;" title="Decline" onclick="updateBookingStatus('${rowId}', 'Declined', this)"><i class="fas fa-times"></i></button>
            `;
        } else {
            actions = `<button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${rowId}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>`;
        }
    } else {
        actions = `
            <button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${rowId}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete Booking" onclick="deleteBooking('${rowId}')"><i class="fas fa-trash"></i></button>
        `;
    }

    // Trainer: make member name clickable to view profile
    let memberNameCell = `<span style="font-weight: 500;">${b.memberName || 'Unknown Member'}</span>`;
    if (loggedInRole === 'trainer' && b.memberId) {
        memberNameCell = `<a href="javascript:void(0)" onclick="window.openMemberProfile('${b.memberId}')" class="mp-link">${b.memberName || 'Unknown Member'}</a>`;
    }

    return `
        <tr>
            <td style="min-width: 120px;">${memberNameCell}</td>
            <td class="trainer-col" style="${trainerColumnStyle}">${b.trainerName || 'Unassigned'}</td>
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
    // EC-4: skip records with missing/non-string time or NaN/out-of-range parsed hour
    const lookup = {};
    data.forEach(raw => {
        const b = window.normalizeBookingRecord(raw);
        if (!b || !b.date || !b.time) return;
        const h = parseInt(String(b.time).split(':')[0], 10);
        if (isNaN(h) || h < 0 || h > 23) return;
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
                const sk = (b.status || 'Pending').toLowerCase().replace(' ', '');
                const cls = sk === 'noshow' ? 'cal-noshow' : `cal-${sk}`;
                const [th, tm] = String(b.time || '0:0').split(':');
                const ap = parseInt(th, 10) >= 12 ? 'PM' : 'AM';
                const dhr = parseInt(th, 10) % 12 || 12;
                const calClick = (typeof window.isBookingTerminalStatus === 'function' && window.isBookingTerminalStatus(b.status || 'Pending'))
                    ? ''
                    : `onclick="openEditBookingModal('${b.id || ''}')"`;
                cellContent += `<div class="bk-cal-block ${cls}" ${calClick} title="${b.memberName || 'Unknown'} with ${b.trainerName || 'Unassigned'}">
                    ${b.memberName || 'Unknown'}<br><span class="bk-cal-block-sub">${b.trainerName || 'Unassigned'} · ${dhr}:${(tm || '00').padStart(2, '0')} ${ap}</span>
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
                // EH-2: catch original render failures so the enhanced render still runs
                try {
                    _originalRender();
                } catch (e) {
                    console.error("[bookings-ui] _originalRender failed:", e);
                }

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
                const totalPages = Math.max(1, Math.ceil(totalRecords / bkItemsPerPage));
                if (bkCurrentPage > totalPages) bkCurrentPage = totalPages;
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

        // Rebind Firestore pipeline when date filters change (staff/admin only)
        window.filterBookingsByDate = function () {
            bkCurrentPage = 1;
            const roleNorm = (localStorage.getItem('userRole') || '').toLowerCase();
            if ((roleNorm === 'admin' || roleNorm === 'staff') && typeof window.rebindBookingsListener === 'function') {
                window.rebindBookingsListener();
            }
            window.renderBookings();
        };
    }, 100);
})();

// Bridge shared guards into global booking status / cancellation modules (script.js).
(function bridgeBookingBusinessGuards() {
    const poll = setInterval(() => {
        if (typeof window.updateBookingStatus !== 'function') return;
        clearInterval(poll);

        const _origUpdateStatus = window.updateBookingStatus;
        window.updateBookingStatus = async function (id, newStatus, btn) {
            const booking = (window.bookingsData || []).find(x => x.id === id);
            if (booking && window.isBookingTerminalStatus(booking.status)) {
                return showToast(`This booking is ${booking.status} and is locked for audit integrity.`, 'error');
            }
            if (newStatus === 'Confirmed' && booking) {
                const member = (window.membersData || []).find(m => m.id === booking.memberId);
                const elig = window.assertMemberBookingEligible(member || null, booking);
                if (!elig.ok) return showToast(elig.message, 'error');
                try {
                    const conflict = await window.queryTrainerScheduleConflict(
                        booking.trainerId, booking.date, booking.time, id
                    );
                    if (conflict) return showToast(TRAINER_CONFLICT_MSG, 'error');
                } catch (err) {
                    console.error('[bookings-ui] Trainer conflict pre-check failed:', err);
                    return window.bookingActionFailedToast(err);
                }
            }
            try {
                return await _origUpdateStatus(id, newStatus, btn);
            } catch (err) {
                window.bookingActionFailedToast(err);
            }
        };

        if (typeof window.openEditBookingModal === 'function') {
            const _origOpenEdit = window.openEditBookingModal;
            window.openEditBookingModal = function (id) {
                const booking = (window.bookingsData || []).find(x => x.id === id);
                if (booking && window.isBookingTerminalStatus(booking.status)) {
                    return showToast(`This booking is ${booking.status} and is locked for audit integrity.`, 'error');
                }
                return _origOpenEdit(id);
            };
        }

        if (typeof window.deleteBooking === 'function') {
            const _origDelete = window.deleteBooking;
            window.deleteBooking = function (id, btn) {
                const booking = (window.bookingsData || []).find(x => x.id === id);
                if (booking && window.isBookingTerminalStatus(booking.status)) {
                    return showToast(`Cannot delete a ${booking.status} booking record.`, 'error');
                }
                return _origDelete(id, btn);
            };
        }
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
    year: new Date().getFullYear(),
    allowSameDay: false
};

window.updateManualBookingState = function() {
    const mSelect = document.getElementById('bookMember');
    const tSelect = document.getElementById('bookTrainer');
    if (!mSelect || !tSelect) return;
    
    window.manualBookingState.memberId = mSelect.value;
    window.manualBookingState.memberName = mSelect.value ? mSelect.options[mSelect.selectedIndex].text : '';
    window.manualBookingState.trainerId = tSelect.value;
    window.manualBookingState.trainerName = tSelect.value ? tSelect.options[tSelect.selectedIndex].text : '';
    
    // SL-6: strip only the leading UID prefix (e.g. "MEM-001 - Name"), not every " - "
    // so names that legitimately contain " - " are not silently truncated.
    const _stripUidPrefix = (text) => {
        const m = text.match(/^[A-Z]+-\d+\s+-\s+(.+)$/);
        return m ? m[1] : text;
    };
    window.manualBookingState.memberName = _stripUidPrefix(window.manualBookingState.memberName);
    window.manualBookingState.trainerName = _stripUidPrefix(window.manualBookingState.trainerName);

    const summaryMember = document.getElementById('manualSummaryMember');
    const summaryTrainer = document.getElementById('manualSummaryTrainer');
    const creditsDisplay = document.getElementById('manualMemberCreditsDisplay');

    if (window.manualBookingState.memberId) {
        const mData = (window.membersData || []).find(m => m.id === window.manualBookingState.memberId);
        const creds = mData ? (mData.sessionsRemaining !== undefined ? mData.sessionsRemaining : 0) : 0;
        if (summaryMember) summaryMember.innerText = window.manualBookingState.memberName;
        if (creditsDisplay) creditsDisplay.innerText = `Credits remaining: ${creds}`;
    } else {
        if (summaryMember) summaryMember.innerText = "Member Not Selected";
        if (creditsDisplay) creditsDisplay.innerText = "Credits: -";
    }

    if (window.manualBookingState.trainerId) {
        if (summaryTrainer) summaryTrainer.innerText = window.manualBookingState.trainerName;
    } else {
        if (summaryTrainer) summaryTrainer.innerText = "Trainer Not Selected";
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

    const offset = window.serverTimeOffsetMs || 0;
    const today = new Date(Date.now() + offset);
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
            // SL-2: disable at sub-hour precision — a slot that started this hour
            // but is already partially past (e.g. it's 14:45, slot is 14:00) must
            // be blocked so the server-side future-time check never rejects silently.
            const currentHour = today.getHours();
            const currentMin  = today.getMinutes();
            if (h < currentHour || (h === currentHour && currentMin > 0)) {
                disabled = true;
                reason = 'Past';
            }
        }

        const slotMins = h * 60;
        const hasTrainerConflict = trainerBookings.some(tb => {
            if (!tb.time) return false;
            const [tbH, tbM] = tb.time.split(':').map(Number);
            if (isNaN(tbH)) return false;
            const tbMins = tbH * 60 + (tbM || 0);
            return Math.abs(slotMins - tbMins) < 60;
        });

        if (hasTrainerConflict) {
            disabled = true;
            reason = 'Trainer Booked';
        }

        const hasMemberConflict = memberBookings.some(mb => {
            if (!mb.time) return false;
            const [mbH, mbM] = mb.time.split(':').map(Number);
            if (isNaN(mbH)) return false;
            const mbMins = mbH * 60 + (mbM || 0);
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
    if (!prevBtn || !nextBtn) return;
    // Re-wire listeners on every drawer open by cloning the buttons (removes old listeners).
    const newPrev = prevBtn.cloneNode(true);
    const newNext = nextBtn.cloneNode(true);
    prevBtn.replaceWith(newPrev);
    nextBtn.replaceWith(newNext);
    newPrev.addEventListener('click', () => {
        if (!window.manualBookingState) return;
        window.manualBookingState.month--;
        if (window.manualBookingState.month < 0) {
            window.manualBookingState.month = 11;
            window.manualBookingState.year--;
        }
        window.renderManualBookingCalendar();
    });

    newNext.addEventListener('click', () => {
        if (!window.manualBookingState) return;
        window.manualBookingState.month++;
        if (window.manualBookingState.month > 11) {
            window.manualBookingState.month = 0;
            window.manualBookingState.year++;
        }
        window.renderManualBookingCalendar();
    });
};

window.executeManualBooking = async function () {
    const confirmBtn = document.getElementById('manualConfirmBookingBtn');
    if (!confirmBtn || confirmBtn.disabled) return;
    const originalHtml = confirmBtn.innerHTML;

    if (!window.manualBookingState) {
        showToast('Action Failed: Booking state is invalid.', 'error');
        return;
    }
    const { memberId, memberName, trainerId, trainerName, date, time } = window.manualBookingState;
    if (!memberId || !trainerId || !date || !time) {
        showToast('Action Failed: Please select Member, Trainer, Date, and Time.', 'error');
        return;
    }

    if (!window.manualBookingState.allowSameDay && typeof window.findSameDayBookings === 'function') {
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
                    window.manualBookingState.allowSameDay = true;
                    window.executeManualBooking();
                }
            });
            return;
        }
    }

    // Captured before finally resets allowSameDay — true only after staff clicks "Proceed anyway".
    const sameDayBypass = !!(window.manualBookingState && window.manualBookingState.allowSameDay);

    try {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

        if (typeof window.syncServerTimeOffset === 'function') {
            await window.syncServerTimeOffset();
        }
        const offset = window.serverTimeOffsetMs || 0;
        const freshNowMs = Date.now() + offset;
        // V-01 FIX: Do NOT append 'Z' (UTC) — the gym operates in local time.
        // Using 'Z' shifts the parsed timestamp by the local UTC offset and
        // lets operators in UTC+8 book slots that have already passed on the server.
        const targetBookingTimeMsCheck = new Date(`${date}T${time}:00`).getTime();
        if (isNaN(targetBookingTimeMsCheck) || targetBookingTimeMsCheck < freshNowMs) {
            throw new Error('Choose a date and time in the future. Past sessions cannot be booked.');
        }

        const fb = window._fb;
        if (!fb) throw new Error('Booking service is not ready. Please refresh the page.');

        const trainerConflict = await window.queryTrainerScheduleConflict(trainerId, date, time);
        if (trainerConflict) throw new Error(TRAINER_CONFLICT_MSG);

        // V-02: trainerConflict pre-check above is advisory UX only (TOCTOU window).
        // Authoritative slot collision guard is trainerSlotRef.exists() inside the tx below.

        await fb.runTransaction(fb.db, async (tx) => {
            // ── PHASE 1: ALL READS ──
            const memberRef = fb.doc(fb.db, 'users', memberId);
            const trainerRef = fb.doc(fb.db, 'users', trainerId);
            const trainerSlotRef = fb.doc(fb.db, 'bookingSlots', window.slotIdForTrainer(trainerId, date, time));
            const memberSlotRef = fb.doc(fb.db, 'bookingSlots', window.slotIdForMember(memberId, date, time));

            const readPromises = [
                tx.get(memberRef),
                tx.get(trainerRef),
                tx.get(trainerSlotRef),
                tx.get(memberSlotRef),
            ];
            // Same-day query only when staff has NOT confirmed bypass — avoids extra reads on happy path.
            let sameDayQ = null;
            if (!sameDayBypass) {
                sameDayQ = fb.query(fb.bookingsCol, fb.where('memberId', '==', memberId), fb.where('date', '==', date));
                readPromises.push(tx.get(sameDayQ));
            }

            const readSnaps = await Promise.all(readPromises);
            const memberSnap = readSnaps[0];
            const trainerSnap = readSnaps[1];
            const trainerSlotSnap = readSnaps[2];
            const memberSlotSnap = readSnaps[3];
            const sameDaySnap = sameDayQ ? readSnaps[4] : null;

            // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──
            if (!memberSnap.exists()) throw new Error('Member record does not exist.');
            if (!trainerSnap.exists()) throw new Error('Trainer no longer exists. Please choose a different trainer.');

            const tData = trainerSnap.data() || {};
            if ((tData.role || '').toLowerCase() !== 'trainer') {
                throw new Error('Selected user is no longer a trainer. Please choose a different trainer.');
            }
            if ((tData.status || 'Active') !== 'Active') {
                throw new Error('Trainer is not currently active. Please choose a different trainer.');
            }

            const mData = memberSnap.data() || {};
            if ((mData.status || 'Active') === 'Suspended') {
                throw new Error('ACCESS_DENIED: Member account is suspended. Bookings are prohibited.');
            }
            if ((mData.status || 'Active') === 'Archived') {
                throw new Error('ACCESS_DENIED: Member account is archived. Bookings are prohibited.');
            }
            if (['Frozen', 'Expired'].includes(mData.status || '')) {
                throw new Error(MEMBER_ELIGIBILITY_ABORT_MSG);
            }
            if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                throw new Error(MEMBER_ELIGIBILITY_ABORT_MSG);
            }
            if (typeof mData.dateRegistered === 'number') {
                const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(mData.plan) : 30;
                const expiryAt = mData.dateRegistered + planDays * 24 * 60 * 60 * 1000;
                // V-01 FIX: local time, no 'Z' suffix
                const targetBookingTimeMs = new Date(`${date}T${time}:00`).getTime();
                if (!isNaN(targetBookingTimeMs) && targetBookingTimeMs > expiryAt) {
                    throw new Error("Target booking date exceeds the member's membership plan expiration date. Please renew their plan for that period.");
                }
            }

            const freshNowMsTx = Date.now() + (window.serverTimeOffsetMs || 0);
            // V-01 FIX: local time, no 'Z' suffix — consistent with slot-ID generation
            const targetBookingTimeMsTx = new Date(`${date}T${time}:00`).getTime();
            if (isNaN(targetBookingTimeMsTx) || targetBookingTimeMsTx < freshNowMsTx) {
                throw new Error('Choose a date and time in the future. Past sessions cannot be booked.');
            }

            const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
            if (sessionsRemaining <= 0) throw new Error(MEMBER_ELIGIBILITY_ABORT_MSG);

            if (trainerSlotSnap.exists()) throw new Error(TRAINER_CONFLICT_MSG);
            if (memberSlotSnap.exists()) throw new Error('Member already has a booking at this hour.');

            // V-03: enforce same-day inside tx unless staff explicitly confirmed "Proceed anyway".
            // Manual booking is staff-only — the bypass flag is set only by the confirm dialog.
            if (!sameDayBypass && sameDaySnap) {
                const sameDayStatuses = window.SAME_DAY_BOOKING_STATUSES || ['Pending', 'Confirmed', 'Completed'];
                const hasSameDayBooking = sameDaySnap.docs.some(d =>
                    sameDayStatuses.includes((d.data() || {}).status)
                );
                if (hasSameDayBooking) {
                    throw new Error('Member already has a session on this date.');
                }
            }

            const newBookingRef = fb.doc(fb.bookingsCol);
            const bookingPayload = {
                memberId,
                memberName: memberName || 'Unknown Member',
                trainerId,
                trainerName: trainerName || 'Unassigned',
                date,
                time,
                status: 'Confirmed',
                creditState: 'held',
                timestamp: Date.now()
            };

            // ── PHASE 3: ALL WRITES ──
            tx.update(memberRef, { sessionsRemaining: fb.increment(-1) });
            tx.set(trainerSlotRef, { bookingId: newBookingRef.id, trainerId, date, time });
            tx.set(memberSlotRef, { bookingId: newBookingRef.id, memberId, date, time });
            tx.set(newBookingRef, bookingPayload);
        });

        window.closeModal('bookingModal');
        showToast('PT Session booked successfully!', 'success');
        if (window.logActivity) window.logActivity('Booking Created', `Admin/Staff booked a training session on ${date} at ${time} with ${trainerName}.`);
    } catch (err) {
        console.error('Manual Booking failed:', err);
        window.bookingActionFailedToast(err);
    } finally {
        if (window.manualBookingState) window.manualBookingState.allowSameDay = false;
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
                const bookingRef = fb.doc(fb.db, 'bookings', bookingId);
                const snap = await tx.get(bookingRef);
                if (!snap.exists()) throw new Error('Booking gone');
                const bData = snap.data() || {};

                const allowed = (window.BOOKING_STATUS_TRANSITIONS && window.BOOKING_STATUS_TRANSITIONS[bData.status || 'Pending']) || [];
                if (!allowed.includes(newStatus)) {
                    throw new Error(`Transition ${bData.status || 'Pending'} → ${newStatus} blocked`);
                }

                const update = { status: newStatus, ...(extraFields || {}) };
                const needsLegacyMemberDebit = (newStatus === 'Completed' || newStatus === 'No Show')
                    && !bData.creditState
                    && bData.memberId;

                let memberRef = null;
                if (needsLegacyMemberDebit) {
                    memberRef = fb.doc(fb.db, 'users', bData.memberId);
                }

                const memberSnap = memberRef ? await tx.get(memberRef) : null;

                if (newStatus === 'Completed' || newStatus === 'No Show') {
                    if (bData.creditState === 'consumed') {
                        // already finalised — status-only update below
                    } else if (bData.creditState === 'held') {
                        update.creditState = 'consumed';
                    } else if (needsLegacyMemberDebit && memberSnap && memberSnap.exists()) {
                        update.creditState = 'consumed';
                    }
                }

                // ── PHASE 3: ALL WRITES ──
                if (needsLegacyMemberDebit && memberSnap && memberSnap.exists() && update.creditState === 'consumed') {
                    tx.update(memberRef, { sessionsRemaining: fb.increment(-1) });
                }
                if (newStatus === 'Completed' || newStatus === 'No Show') {
                    if (bData.trainerId && bData.date && bData.time) {
                        const { slotIdForTrainer, slotIdForMember } = window;
                        if (slotIdForTrainer) {
                            tx.delete(fb.doc(fb.db, 'bookingSlots', slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                        }
                        if (slotIdForMember && bData.memberId) {
                            tx.delete(fb.doc(fb.db, 'bookingSlots', slotIdForMember(bData.memberId, bData.date, bData.time)));
                        }
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

        bookings.forEach(raw => {
            const b = (typeof window.normalizeBookingRecord === 'function')
                ? window.normalizeBookingRecord(raw)
                : raw;
            if (!b || !b.id || !b.date || !b.time) return;

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
                // EH-3: catch rejects from the async pipeline so the rating write error
                // doesn't become an unhandled promise rejection
                _systemFlipStatus(b.id, 'Completed').then(async () => {
                    if (window.logActivity) window.logActivity("Session Completed", `Booking ${b.id} auto-completed after scheduled end time.`);
                    await _writePendingRating(b);
                }).catch(err => {
                    console.error("[SessionEngine] Complete+rate pipeline failed:", err);
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
        if (!fb.pendingRatingsCol) {
            console.warn("[SessionEngine] fb.pendingRatingsCol not available yet.");
            return;
        }

        try {
            const snap = await fb.getDocs(fb.query(fb.pendingRatingsCol, fb.where("memberId", "==", userId)));
            snap.forEach(docSnap => {
                const data = docSnap.data();
                if (data.resolved) return;
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
            // V-05: enforce caps inside resolve so programmatic/XSS-injected values cannot bypass the UI check
            const safeRating = (rating || '').slice(0, 200);
            const safeRemarks = (remarks || '').slice(0, 500);
            const submitBtnLocal = submitBtn;
            const skipBtnLocal = skipBtn;
            const origSubmitHtml = submitBtnLocal ? submitBtnLocal.innerHTML : '';
            try {
                if (submitBtnLocal) {
                    submitBtnLocal.disabled = true;
                    submitBtnLocal.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
                }
                if (skipBtnLocal) skipBtnLocal.disabled = true;

                await fb.runTransaction(fb.db, async (tx) => {
                    const ref = fb.doc(fb.db, 'pendingRatings', docId);
                    const snap = await tx.get(ref);
                    if (!snap.exists()) return;
                    if (snap.data().resolved) return;
                    tx.update(ref, {
                        resolved: true,
                        rating: safeRating,
                        remarks: safeRemarks,
                        resolvedAt: Date.now()
                    });
                });
                if (safeRating || safeRemarks) {
                    showToast('Thank you for your feedback!', 'success');
                    if (window.logActivity) window.logActivity('Session Rated', `Member rated session with ${ratingData.trainerName || 'trainer'}.`);
                }
            } catch (err) {
                console.warn('[SessionEngine] Failed to resolve rating:', err.message);
                window.bookingActionFailedToast(err);
            } finally {
                if (submitBtnLocal) {
                    submitBtnLocal.disabled = false;
                    submitBtnLocal.innerHTML = origSubmitHtml;
                }
                if (skipBtnLocal) skipBtnLocal.disabled = false;
                close();
            }
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
            // VULN-09: cap lengths to prevent Firestore document bloat and potential XSS via innerHTML
            if (rating.length > 200) {
                showToast("Rating must be 200 characters or fewer.", "error");
                return;
            }
            if (remarks.length > 500) {
                showToast("Remarks must be 500 characters or fewer.", "error");
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
