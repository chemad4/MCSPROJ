import { doc, getDocs, onSnapshot, query, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const DEFAULT_CLOSING_HOUR = 21; // 9:00 PM
const DEFAULT_CLOSING_MINUTE = 0;

export function initAttendance({ db, attendanceCol, servicesChartInstanceGetter, closingHour, closingMinute } = {}) {
  if (!db || !attendanceCol) return;

  let attendanceData = [];
  const ch = Number.isFinite(closingHour) ? closingHour : DEFAULT_CLOSING_HOUR;
  const cm = Number.isFinite(closingMinute) ? closingMinute : DEFAULT_CLOSING_MINUTE;

  // Reduce reads: listen only to today's attendance documents.
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const todaysQuery = query(attendanceCol, where("date", "==", today));

  onSnapshot(todaysQuery, (snapshot) => {
    attendanceData = [];
    snapshot.forEach((d) => attendanceData.push({ id: d.id, ...d.data() }));
    renderAttendance(attendanceData, servicesChartInstanceGetter);
  });

  // Auto force-out at closing (runs once per day per device).
  runAutoForceOutIfClosingPassed({ db, attendanceCol, closingHour: ch, closingMinute: cm }).catch(() => {});
}

function renderAttendance(attendanceData, servicesChartInstanceGetter) {
  const attTbody = document.querySelector("#attendanceTable tbody");
  const myAttTbody = document.querySelector("#myAttendanceBody");
  const loggedInName = localStorage.getItem("loggedInUser");
  const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
  const showCounts =
    loggedInRole === "admin" && !!document.querySelector('#attendanceTable thead th[data-att-counts="1"]');

  if (attTbody) attTbody.innerHTML = "";
  if (myAttTbody) myAttTbody.innerHTML = "";

  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  let gold = 0,
    silver = 0,
    walkin = 0,
    presentCount = 0;

  const sortedAtt = [...attendanceData].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const todayAtt = sortedAtt.filter((a) => a.date === today);

  // Daily IN/OUT counters per member to flag suspicious activity.
  const dailyCounts = new Map(); // name -> { inCount, outCount, deniedCount, overrideCount }
  todayAtt.forEach((a) => {
    const nameKey = a.name || "";
    if (!nameKey) return;
    let entry = dailyCounts.get(nameKey);
    if (!entry) {
      entry = { inCount: 0, outCount: 0, deniedCount: 0, overrideCount: 0 };
      dailyCounts.set(nameKey, entry);
    }
    entry.inCount += 1;
    const hasOut = !!a.timeOut || a.status === "Checked Out";
    if (hasOut) entry.outCount += 1;
    if (a.overrideTapOut) entry.overrideCount += 1;
    if (a.denied === true) entry.deniedCount += 1;
  });

  todayAtt.forEach((a) => {
    const statusBadge =
      a.status === "Checked In" ? '<span class="badge active">On Floor</span>' : '<span class="badge inactive">Checked Out</span>';
    const timeOutDisplay = a.timeOut ? `<span class="badge inactive"><i class="fa-regular fa-clock"></i> ${a.timeOut}</span>` : "-";
    const timeInDisplay = a.timeIn || a.time || "-";

    const counts = dailyCounts.get(a.name || "") || { inCount: 0, outCount: 0, deniedCount: 0, overrideCount: 0 };
    const isFlagged = counts.inCount >= 3;
    const flagDisplay = isFlagged
      ? `<span class="badge broken">FLAG</span>`
      : `<span class="badge active" style="background: var(--dark-black);">OK</span>`;

    if (attTbody) {
      attTbody.innerHTML += `
        <tr>
          <td>${a.name}</td><td><strong>${a.type}</strong></td><td>${a.date}</td>
          <td><span class="badge active"><i class="fa-regular fa-clock"></i> ${timeInDisplay}</span></td>
          <td>${timeOutDisplay}</td><td>${statusBadge}</td>
          ${showCounts ? `<td>${counts.inCount}</td><td>${counts.outCount}</td><td>${flagDisplay}</td>` : ``}
        </tr>
      `;
    }

    if ((a.type || "").includes("Gold")) gold++;
    else if ((a.type || "").includes("Silver")) silver++;
    else if ((a.type || "").includes("Walk-in")) walkin++;

    if (a.status === "Checked In") presentCount++;
  });

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
}

async function runAutoForceOutIfClosingPassed({ db, attendanceCol, closingHour, closingMinute }) {
  const now = new Date();
  const closing = new Date(now.getFullYear(), now.getMonth(), now.getDate(), closingHour, closingMinute, 0, 0);
  if (now.getTime() < closing.getTime()) return;

  const dayKey = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const storageKey = `forceOutDone:${dayKey}`;
  if (localStorage.getItem(storageKey) === "1") return;

  const q = query(attendanceCol, where("date", "==", dayKey), where("status", "==", "Checked In"));
  const snap = await getDocs(q);
  if (snap.empty) {
    localStorage.setItem(storageKey, "1");
    return;
  }

  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const operatorRole = localStorage.getItem("userRole") || "";
  const operatorName = localStorage.getItem("loggedInUser") || "";

  await Promise.all(
    snap.docs.map((d) =>
      updateDoc(doc(db, "attendance", d.id), {
        timeOut: timeStr,
        status: "Checked Out",
        forceOutAtClosing: true,
        forceOutTimestamp: now.getTime(),
        forceOutByRole: operatorRole,
        forceOutBy: operatorName,
      })
    )
  );

  localStorage.setItem(storageKey, "1");
}

