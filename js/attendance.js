import { doc, getDocs, onSnapshot, query, runTransaction, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const DEFAULT_CLOSING_HOUR = 21; // 9:00 PM
const DEFAULT_CLOSING_MINUTE = 0;

export function initAttendance({ db, attendanceCol, servicesChartInstanceGetter, closingHour, closingMinute } = {}) {
  if (!db || !attendanceCol) return;

  let attendanceData = [];
  const ch = Number.isFinite(closingHour) ? closingHour : DEFAULT_CLOSING_HOUR;
  const cm = Number.isFinite(closingMinute) ? closingMinute : DEFAULT_CLOSING_MINUTE;

  let currentUnsubscribe = null;
  const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
  // Only admin/staff need live attendance updates; members and trainers see attendance as
  // read-only history and can use a one-shot fetch instead.
  const useLiveAttendance = (loggedInRole === "admin" || loggedInRole === "staff");

  window.filterAttendanceByDate = (dateVal) => {
    // Always tear down any previous subscription to prevent listener leaks when the
    // date picker is changed rapidly.
    if (currentUnsubscribe) {
        try { currentUnsubscribe(); } catch (_) {}
        currentUnsubscribe = null;
    }

    let targetDateStr;
    if (!dateVal) {
        targetDateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } else {
        // SP-1: validate before splitting to prevent "Invalid Date" Firestore queries
        const parts = dateVal.split('-');
        if (parts.length !== 3 || parts.some(p => !p || isNaN(Number(p)))) {
            console.error("[Attendance] filterAttendanceByDate: invalid dateVal", dateVal);
            return;
        }
        const [y, m, d] = parts.map(Number);
        const dateObj = new Date(y, m - 1, d);
        if (isNaN(dateObj.getTime())) {
            console.error("[Attendance] filterAttendanceByDate: unparseable date", dateVal);
            return;
        }
        targetDateStr = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    const q = query(attendanceCol, where("date", "==", targetDateStr));
    if (useLiveAttendance) {
        currentUnsubscribe = onSnapshot(q,
            (snapshot) => {
                attendanceData = [];
                snapshot.forEach((d) => attendanceData.push({ id: d.id, ...d.data() }));
                const render = () => renderAttendance(attendanceData, servicesChartInstanceGetter, targetDateStr);
                if (typeof window.softRender === 'function') window.softRender('attendance', render);
                else render();
            },
            // EH-1: surface Firestore feed errors instead of silently stalling
            (err) => {
                console.error("[Attendance] onSnapshot error:", err);
                if (typeof showToast === 'function') showToast("Attendance feed disconnected. Refresh the page.", "error");
            }
        );
    } else {
        getDocs(q).then(snapshot => {
            attendanceData = [];
            snapshot.forEach((d) => attendanceData.push({ id: d.id, ...d.data() }));
            renderAttendance(attendanceData, servicesChartInstanceGetter, targetDateStr);
        }).catch(e => {
            console.error("Attendance fetch failed:", e);
            if (typeof showToast === 'function') showToast("Could not load attendance records. Refresh the page.", "error");
        });
    }
  };

  window.filterAttendanceByDate(); // Load today initially

  // EC-1: re-subscribe at midnight so the live feed follows the calendar day boundary
  function _scheduleNextDayReload() {
    const now = new Date();
    const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    setTimeout(() => {
      window.filterAttendanceByDate();
      _scheduleNextDayReload();
    }, msUntilMidnight + 500);
  }
  _scheduleNextDayReload();

  // Auto force-out at closing (runs once per day per device).
  runAutoForceOutIfClosingPassed({ db, attendanceCol, closingHour: ch, closingMinute: cm }).catch(() => {});
}

function renderAttendance(attendanceData, servicesChartInstanceGetter, targetDate) {
  const attTbody = document.querySelector("#attendanceTable tbody");
  const myAttTbody = document.querySelector("#myAttendanceBody");
  const loggedInName = localStorage.getItem("loggedInUser");
  const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
  const showCounts =
    loggedInRole === "admin" && !!document.querySelector('#attendanceTable thead th[data-att-counts="1"]');

  if (attTbody) attTbody.innerHTML = "";
  if (myAttTbody) myAttTbody.innerHTML = "";

  const dateFilter = targetDate || new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  let gold = 0,
    silver = 0,
    walkin = 0,
    presentCount = 0;

  const sortedAtt = [...attendanceData].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const todayAtt = sortedAtt.filter((a) => a.date === dateFilter);

  // --- Group records by person name ---
  const grouped = new Map();
  todayAtt.forEach((a) => {
    const nameKey = a.name || "Unknown";
    if (!grouped.has(nameKey)) {
      grouped.set(nameKey, { records: [], type: a.type, latestStatus: a.status, latestRecord: a, inCount: 0, outCount: 0, date: a.date });
    }
    const g = grouped.get(nameKey);
    g.records.push(a);
    g.inCount += 1;
    if (a.timeOut || a.status === "Checked Out") g.outCount += 1;
    if ((a.timestamp || 0) > ((g.latestRecord || {}).timestamp || 0)) {
      g.latestStatus = a.status;
      g.latestRecord = a;
      g.type = a.type;
      g.date = a.date;
    }
  });

  // Build chart counts using the grouped data
  // M3: a "Checked In" record older than the gym's operating window is stale —
  // member forgot to tap out. Don't count them as currently present.
  const STALE_PRESENCE_MS = 16 * 60 * 60 * 1000; // ~ one full operating day
  const nowMs = Date.now();
  grouped.forEach((g) => {
    if ((g.type || "").includes("Gold")) gold++;
    else if ((g.type || "").includes("Silver")) silver++;
    else if ((g.type || "").includes("Walk-in")) walkin++;
    if (g.latestStatus === "Checked In") {
      const latestTs = (g.latestRecord || {}).timestamp || 0;
      if (latestTs && (nowMs - latestTs) < STALE_PRESENCE_MS) {
        presentCount++;
      }
    }
  });

  if (attTbody) {
    // Convert Map to array for pagination
    const groupedArray = Array.from(grouped);
    const totalRecords = groupedArray.length;
    
    // Reset page if out of bounds
    const totalPages = Math.ceil(totalRecords / (window.attItemsPerPage || 20));
    if (window.attCurrentPage > totalPages && totalPages > 0) window.attCurrentPage = totalPages;
    if (window.attCurrentPage < 1) window.attCurrentPage = 1;

    const startIdx = ((window.attCurrentPage || 1) - 1) * (window.attItemsPerPage || 20);
    const endIdx = Math.min(startIdx + (window.attItemsPerPage || 20), totalRecords);
    const pagedGrouped = groupedArray.slice(startIdx, endIdx);

    const countEl = document.getElementById('attendanceRecordCount');
    if (countEl) {
      countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
    }

    if (window.renderPaginationControls) {
      window.renderPaginationControls('attendancePagination', window.attCurrentPage || 1, totalPages, totalRecords, 'changeAttPage');
    }

    let rowIndex = 0;
    pagedGrouped.forEach(([name, g]) => {
      const latestRec = g.latestRecord || g.records[0];
      const hasMultiple = g.records.length > 1;
      const isFlagged = g.inCount >= 3;

      const latestStatusBadge =
        g.latestStatus === "Checked In"
          ? '<span class="badge active">On Floor</span>'
          : '<span class="badge inactive">Checked Out</span>';

      const latestTimeIn = latestRec ? (latestRec.timeIn || latestRec.time || "-") : "-";
      const latestTimeOut =
        latestRec && latestRec.timeOut
          ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${latestRec.timeOut}</span>`
          : "-";

      const flagDisplay = isFlagged
        ? `<span class="badge broken">FLAG</span>`
        : `<span class="badge active" style="background: var(--dark-black);">OK</span>`;

      const toggleId = `att-detail-${rowIndex}`;
      const chevronId = `att-chevron-${rowIndex}`;

      // Summary Row
      attTbody.innerHTML += `
        <tr class="att-summary-row" style="cursor: ${hasMultiple ? "pointer" : "default"};"
            onclick="${hasMultiple ? `toggleAttDetail('${toggleId}', '${chevronId}')` : ""}">
          <td>
            <span style="display:inline-flex; align-items:center; gap: 8px;">
              ${
                hasMultiple
                  ? `<i id="${chevronId}" class="fa-solid fa-chevron-right" style="font-size:11px; color: var(--text-muted); transition: transform 0.2s;"></i>`
                  : `<span style="display:inline-block; width:15px;"></span>`
              }
              ${latestRec.uid ? `<span style="font-size:11px; color:var(--text-muted); font-family:monospace; margin-right:5px;">${latestRec.uid}</span>` : ""} ${name}
              ${hasMultiple ? `<span style="font-size:11px; background: var(--primary-red); color: white; padding: 1px 6px; border-radius: 10px; font-weight:600;">${g.records.length}</span>` : ""}
            </span>
          </td>
          <td><strong>${g.type}</strong></td>
          <td>${g.date || dateFilter}</td>
          <td><span class="badge active"><i class="fa-regular fa-clock"></i> ${latestTimeIn}</span></td>
          <td>${latestTimeOut}</td>
          <td>${latestStatusBadge}</td>
          ${showCounts ? `<td>${g.inCount}</td><td>${g.outCount}</td><td>${flagDisplay}</td>` : ""}
        </tr>
      `;

      // Detail Rows (hidden by default, sorted newest-first)
      if (hasMultiple) {
        let detailRows = "";
        const sorted = [...g.records].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        sorted.forEach((rec, i) => {
          const recTimeIn = rec.timeIn || rec.time || "-";
          const recTimeOut = rec.timeOut
            ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${rec.timeOut}</span>`
            : "-";
          const recStatus =
            rec.status === "Checked In"
              ? '<span class="badge active">On Floor</span>'
              : '<span class="badge inactive">Checked Out</span>';
          detailRows += `
            <tr style="background: rgba(0,0,0,0.02);">
              <td colspan="2" style="padding-left: 45px; font-size: 13px; color: var(--text-muted);">
                <i class="fa-solid fa-right-to-bracket" style="font-size:11px; margin-right:5px;"></i> Session ${i + 1}
              </td>
              <td style="font-size:13px; color: var(--text-muted);">${rec.date}</td>
              <td><span class="badge active"><i class="fa-regular fa-clock"></i> ${recTimeIn}</span></td>
              <td>${recTimeOut}</td>
              <td>${recStatus}</td>
              ${showCounts ? `<td></td><td></td><td></td>` : ""}
            </tr>
          `;
        });

        attTbody.innerHTML += `
          <tr id="${toggleId}" class="att-detail-group" style="display: none;">
            <td colspan="100%" style="padding: 0; border-bottom: 2px solid var(--primary-red);">
              <table style="width:100%; border-collapse:collapse;">
                <tbody>${detailRows}</tbody>
              </table>
            </td>
          </tr>
        `;
      }

      rowIndex++;
    });

    if (totalRecords === 0) {
      const colCount = showCounts ? 9 : 6;
      attTbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; padding: 30px; color: var(--text-muted);">No attendance records for today.</td></tr>`;
    }
    
    // Expose for external re-renders
    window.renderAttendanceData = () => renderAttendance(attendanceData, servicesChartInstanceGetter, targetDate);
  }


  if (myAttTbody) {
    const myLogs = sortedAtt.filter((a) => a.name === loggedInName).slice(0, 10);
    if (myLogs.length === 0) {
      myAttTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #888;">No attendance logs found.</td></tr>`;
    } else {
      myLogs.forEach((a) => {
        const statusBadge =
          a.status === "Checked In" ? '<span class="badge active">On Floor</span>' : '<span class="badge inactive">Checked Out</span>';
        const timeOutDisplay = a.timeOut ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${a.timeOut}</span>` : "-";
        const timeInDisplay = a.timeIn || a.time || "-";
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

  const chart = typeof servicesChartInstanceGetter === "function" ? servicesChartInstanceGetter() : null;
  if (chart) {
    chart.data.datasets[0].data = [gold, silver, walkin];
    chart.update();
  }
  const presentEl = document.getElementById("presentMembers");
  if (presentEl) presentEl.innerText = presentCount;

  // --- DASHBOARD ANALYTICS HOOK ---
  if (document.getElementById('dashboard')) {
    // Daily Checkins
    const checkinEl = document.getElementById('dashDailyCheckins');
    if (checkinEl) checkinEl.innerText = todayAtt.length;

    // Peak Hour Calculation
    // EC-2: unified parser handles both 12-hour (h:mm AM/PM) and 24-hour (HH:mm) formats
    const hourCounts = Array(24).fill(0);
    todayAtt.forEach(a => {
        const timeStr = a.timeIn || a.time;
        if (!timeStr || typeof timeStr !== 'string') return;
        let hour24;
        const m24 = timeStr.match(/^(\d{1,2}):\d{2}$/);
        const m12 = timeStr.match(/^(\d{1,2}):\d{2}\s*(AM|PM)$/i);
        if (m24) {
            hour24 = parseInt(m24[1], 10);
        } else if (m12) {
            let h = parseInt(m12[1], 10);
            const isPM = m12[2].toUpperCase() === 'PM';
            if (isPM && h !== 12) h += 12;
            if (!isPM && h === 12) h = 0;
            hour24 = h;
        } else {
            return;
        }
        if (hour24 >= 0 && hour24 <= 23) hourCounts[hour24]++;
    });

    let peakHour = -1;
    let maxCheckins = 0;
    hourCounts.forEach((count, hr) => {
        if (count > maxCheckins) {
            maxCheckins = count;
            peakHour = hr;
        }
    });

    const peakEl = document.getElementById('dashPeakHour');
    if (peakEl) {
        if (peakHour === -1) peakEl.innerText = "--:--";
        else {
            const displayHour = peakHour % 12 || 12;
            const ampm = peakHour >= 12 ? 'PM' : 'AM';
            peakEl.innerText = `${displayHour}:00 ${ampm}`;
        }
    }

    // Sparkline for Check-ins
    if (window.renderSparkline) {
        const checkinTrend = hourCounts.filter((_, i) => i >= 6 && i <= 21); // 6 AM to 9 PM
        window.renderSparkline('checkinSparkline', checkinTrend, 'var(--primary-red)');
    }

    if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
    if (window.renderRecentCheckins) window.renderRecentCheckins(attendanceData);
  }
}

window.renderRecentCheckins = function(attendanceData) {
    const list = document.getElementById('recentCheckinsList');
    if (!list) return;

    const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const recent = attendanceData
        .filter(a => a.status === 'Checked In' && a.date === today)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 5);

    if (recent.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;">No check-ins yet today.</p>`;
        return;
    }

    list.innerHTML = recent.map(a => {
        // SP-2: guard against missing name field to prevent TypeError crash
        const safeName = (a.name || 'Unknown').trim() || 'Unknown';
        const initials = safeName.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
        const time = a.timeIn || a.time || '00:00';
        return `
            <div class="checkin-item">
                <div class="initial-avatar">${initials}</div>
                <div class="checkin-details">
                    <div class="checkin-name">${safeName}</div>
                    <div class="checkin-meta">
                        <span>Plan: ${a.type || 'Standard'}</span>
                        <span>Checked in at: ${time}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Toggle the detail rows for a grouped attendance entry
window.toggleAttDetail = function (toggleId, chevronId) {
  const detailRow = document.getElementById(toggleId);
  const chevron = document.getElementById(chevronId);
  if (!detailRow) return;
  const isOpen = detailRow.style.display !== "none";
  detailRow.style.display = isOpen ? "none" : "table-row";
  if (chevron) {
    chevron.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
  }
};

async function runAutoForceOutIfClosingPassed({ db, attendanceCol, closingHour, closingMinute }) {
  const now = new Date();
  const closing = new Date(now.getFullYear(), now.getMonth(), now.getDate(), closingHour, closingMinute, 0, 0);
  if (now.getTime() < closing.getTime()) return;

  const dayKey = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  // SL-3: scope key per user so shared terminals don't skip force-out for subsequent logins
  const storageKey = `forceOutDone:${dayKey}:${localStorage.getItem("userId") || "unknown"}`;
  if (localStorage.getItem(storageKey) === "1") return;

  const q = query(attendanceCol, where("date", "==", dayKey));
  const snap = await getDocs(q);
  const checkedInDocs = snap.docs.filter(d => d.data().status === "Checked In");
  if (checkedInDocs.length === 0) {
    localStorage.setItem(storageKey, "1");
    return;
  }

  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const operatorRole = localStorage.getItem("userRole") || "";
  const operatorName = localStorage.getItem("loggedInUser") || "";

  // BUG-03: Wrap each write in a transaction with a status re-check so concurrent
  // tabs (or incognito windows) cannot double-force-out the same record.
  await Promise.all(
    checkedInDocs.map((d) =>
      runTransaction(db, async (tx) => {
        const ref = doc(db, "attendance", d.id);
        const fresh = await tx.get(ref);
        if (!fresh.exists() || fresh.data().status === "Checked Out") return;
        tx.update(ref, {
          timeOut: timeStr,
          status: "Checked Out",
          forceOutAtClosing: true,
          forceOutTimestamp: now.getTime(),
          forceOutByRole: operatorRole,
          forceOutBy: operatorName,
        });
      })
    )
  );

  localStorage.setItem(storageKey, "1");
}

