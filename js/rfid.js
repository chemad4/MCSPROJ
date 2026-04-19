import { addDoc, collection, doc, getDocs, query, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function initRfid({ db, usersCol, attendanceCol, onShiftLogout } = {}) {
  if (!db || !usersCol || !attendanceCol) return;

  let rfidBuffer = "";
  let lastKeyTime = Date.now();
  const lastScanAtByTag = new Map();
  const DEBOUNCE_MS = 3000;

  document.addEventListener("keydown", (e) => {
    const currentTime = Date.now();
    if (currentTime - lastKeyTime > 50) rfidBuffer = "";

    if (e.key === "Enter" && rfidBuffer.length > 5) {
      e.preventDefault();
      const activeEl = document.activeElement;
      const isRegistrationBox = activeEl && activeEl.classList.contains("rfid-register-input");

      if (activeEl && activeEl.tagName === "INPUT" && !isRegistrationBox) {
        const currentVal = activeEl.value;
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
          if (typeof onShiftLogout === "function") onShiftLogout();
          else if (window.handleLogout) window.handleLogout();
        } else {
          const last = lastScanAtByTag.get(rfidBuffer);
          if (typeof last === "number" && Date.now() - last < DEBOUNCE_MS) {
            rfidBuffer = "";
            return;
          }
          lastScanAtByTag.set(rfidBuffer, Date.now());
          processRfidAttendance({ scannedTag: rfidBuffer, db, usersCol, attendanceCol });
        }
      }

      rfidBuffer = "";
    } else if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
      rfidBuffer += e.key;
    }

    lastKeyTime = currentTime;
  });
}

async function processRfidAttendance({ scannedTag, db, usersCol, attendanceCol }) {
  const q = query(usersCol, where("rfid", "==", scannedTag));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    // Walk-in guest card handling (reusable cards issued by POS after payment).
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const guestCardsCol = collection(db, "guestCards");
    const guestQ = query(guestCardsCol, where("rfid", "==", scannedTag));
    const guestSnap = await getDocs(guestQ);

    if (guestSnap.empty) {
      console.warn(`Unrecognized Card Scanned (ID: ${scannedTag}).`);
      return;
    }

    const guestDoc = guestSnap.docs[0];
    const guest = guestDoc.data() || {};

    // Only allow guest card tap-out for cards issued today.
    if (guest.status !== "Issued" || guest.issuedForDate !== dateStr) {
      alert("Guest card is not issued for today. Please ask staff to issue a day pass first.");
      return;
    }

    const attQuery = query(attendanceCol, where("guestRfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Checked In"));
    const attSnapshot = await getDocs(attQuery);

    if (attSnapshot.empty) {
      alert("No active walk-in session found for this guest card.");
      return;
    }

    const attDoc = attSnapshot.docs[0];
    await updateDoc(doc(db, "attendance", attDoc.id), { timeOut: timeStr, status: "Checked Out" });

    // Free the guest card for reuse.
    await updateDoc(doc(db, "guestCards", guestDoc.id), {
      status: "Available",
      checkedOutAt: now.getTime(),
      checkedOutByRole: localStorage.getItem("userRole") || "",
      checkedOutBy: localStorage.getItem("loggedInUser") || "",
      lastUsedDate: dateStr,
      issuedForDate: "",
      paymentId: "",
    });

    // Mark the most recent active walk-in pass as used (best-effort).
    try {
      const passesCol = collection(db, "walkinPasses");
      const passQ = query(passesCol, where("rfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Active"));
      const passSnap = await getDocs(passQ);
      if (!passSnap.empty) {
        await updateDoc(doc(db, "walkinPasses", passSnap.docs[0].id), { status: "Used", usedAt: now.getTime() });
      }
    } catch (_) {
      // ignore
    }

    return;
  }

  const userDoc = snapshot.docs[0];
  const user = userDoc.data();

  if (user.status === "Archived") {
    console.warn(`Access Denied. ${(user.name || user.givenName) || "Member"}'s account is archived.`);
    return;
  }

  // Auto-deny expired memberships on tap-in.
  // Uses existing schema: membership expires 30 days after dateRegistered (ms timestamp).
  if ((user.role || "").toLowerCase() === "member" && typeof user.dateRegistered === "number") {
    const expiryAt = user.dateRegistered + 30 * 24 * 60 * 60 * 1000;
    if (Date.now() > expiryAt) {
      // Still allow tap-out if they have an open "Checked In" record; this check applies only when creating a new "IN".
      // We can only know that after we query today's Checked In record below, so we just keep a flag here.
      user.__isExpired = true;
    }
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const userName = user.name || `${user.givenName} ${user.familyName}`;
  const isTrainer = (user.role || "").toLowerCase() === "trainer";

  const attQuery = query(attendanceCol, where("name", "==", userName), where("date", "==", dateStr), where("status", "==", "Checked In"));
  const attSnapshot = await getDocs(attQuery);

  if (!attSnapshot.empty) {
    const attDoc = attSnapshot.docs[0];
    const recordId = attDoc.id;
    const record = attDoc.data() || {};

    // Deny tap-out within 30 minutes of a successful tap-in (unless Staff/Admin overrides).
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    const checkInAt = typeof record.timestamp === "number" ? record.timestamp : null;
    const msSinceIn = checkInAt !== null ? now.getTime() - checkInAt : null;

    const operatorRole = (localStorage.getItem("userRole") || "").toLowerCase();
    const canOverride = operatorRole === "admin" || operatorRole === "staff";

    if (msSinceIn !== null && msSinceIn >= 0 && msSinceIn < THIRTY_MIN_MS) {
      if (!canOverride) {
        alert("Tap-out denied: you can only tap out 30 minutes after tapping in. Please ask staff for an override.");
        return;
      }

      const minsLeft = Math.ceil((THIRTY_MIN_MS - msSinceIn) / 60000);
      const proceed = confirm(
        `Tap-out is blocked for 30 minutes after tap-in.\n\nOverride and allow tap-out anyway? (${minsLeft} minute(s) remaining)`
      );
      if (!proceed) return;

      const reason = (prompt("Override reason (required):", "Early tap-out") || "").trim();
      if (!reason) {
        alert("Override cancelled: reason is required.");
        return;
      }

      await updateDoc(doc(db, "attendance", recordId), {
        timeOut: timeStr,
        status: "Checked Out",
        overrideTapOut: true,
        overrideByRole: localStorage.getItem("userRole") || "",
        overrideBy: localStorage.getItem("loggedInUser") || "",
        overrideReason: reason,
        overrideTimestamp: now.getTime(),
      });
    } else {
      await updateDoc(doc(db, "attendance", recordId), {
        timeOut: timeStr,
        status: "Checked Out",
      });
    }

    if (isTrainer) {
      await updateDoc(doc(db, "users", userDoc.id), { shiftStatus: "Off Floor" });
    }
  } else {
    if (user.__isExpired) {
      alert("Access denied: membership is expired.");
      return;
    }
    await addDoc(attendanceCol, {
      name: userName,
      type: user.plan || user.role || "Member",
      date: dateStr,
      timeIn: timeStr,
      timeOut: "",
      status: "Checked In",
      timestamp: now.getTime(),
      userId: userDoc.id,
      rfid: scannedTag,
    });

    if (isTrainer) {
      await updateDoc(doc(db, "users", userDoc.id), { shiftStatus: "On Floor" });
    }
  }
}

