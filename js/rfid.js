import { addDoc, collection, doc, getDocs, query, updateDoc, where, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export function initRfid({ db, usersCol, attendanceCol, onShiftLogout } = {}) {
  if (!db || !usersCol || !attendanceCol) return;

  let rfidBuffer = "";
  let lastKeyTime = Date.now();
  const lastScanAtByTag = new Map();
  const DEBOUNCE_MS = 3000;

  document.addEventListener("keydown", (e) => {
    const currentTime = Date.now();
    const activeEl = document.activeElement;
    const isRegistrationBox = activeEl && activeEl.classList.contains("rfid-register-input");
    if (!isRegistrationBox && (currentTime - lastKeyTime > 50)) rfidBuffer = "";

    if (e.key === "Enter" && rfidBuffer.length > 5) {
      const activeEl = document.activeElement;
      const isRegistrationBox = activeEl && activeEl.classList.contains("rfid-register-input");
      const isTextInput = activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.isContentEditable
      );

      // Focus Guard Check: Skip global scanner capture if actively typing in normal inputs (TC-1)
      if (isTextInput && !isRegistrationBox) {
        rfidBuffer = "";
        return;
      }

      e.preventDefault();

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

function playRfidBuzzer(frequency = 150, duration = 300) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = "sawtooth";
    oscillator.frequency.value = frequency;
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration / 1000);

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + duration / 1000);
  } catch (e) {
    // ignore
  }
}

async function processRfidAttendance({ scannedTag, db, usersCol, attendanceCol }) {
  const q = query(usersCol, where("rfid", "==", scannedTag));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    // Walk-in guest card handling (reusable cards issued by POS after payment).
    const offset = window.serverTimeOffsetMs || 0;
    const now = new Date(Date.now() + offset);
    const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const guestCardsCol = collection(db, "guestCards");
    const guestQ = query(guestCardsCol, where("rfid", "==", scannedTag));
    const guestSnap = await getDocs(guestQ);

    if (guestSnap.empty) {
      playRfidBuzzer(120, 400);
      if (typeof showToast === "function") {
        showToast(`Unrecognized card scanned (${scannedTag}). Access Denied.`, "error");
      } else {
        console.warn(`Unrecognized Card Scanned (ID: ${scannedTag}).`);
      }
      return;
    }

    const guestDoc = guestSnap.docs[0];
    const guest = guestDoc.data() || {};

    // Only allow guest card tap-out for cards issued today.
    if (guest.status !== "Issued" || guest.issuedForDate !== dateStr) {
      playRfidBuzzer(120, 400);
      if (typeof showToast === "function") {
        showToast("Guest card is not issued for today. Please ask staff to issue a day pass first.", "error");
      }
      return;
    }

    const attQuery = query(attendanceCol, where("guestRfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Checked In"));
    const attSnapshot = await getDocs(attQuery);

    if (attSnapshot.empty) {
      playRfidBuzzer(120, 400);
      if (typeof showToast === "function") {
        showToast("No active walk-in session found for this guest card.", "error");
      }
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
  const userId = userDoc.id;
  const offset = window.serverTimeOffsetMs || 0;
  const now = new Date(Date.now() + offset);
  const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // 1. Pre-query for legacy active check-in record for today (since queries aren't allowed inside a transaction)
  const attQuery = query(attendanceCol, where("rfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Checked In"));
  const attSnapshot = await getDocs(attQuery);
  const legacyActiveId = !attSnapshot.empty ? attSnapshot.docs[0].id : null;

  try {
    const checkinResult = await runTransaction(db, async (transaction) => {
      const userRef = doc(db, "users", userId);
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists()) {
        throw new Error("User record no longer exists.");
      }
      const user = userSnap.data();

      if (user.status === "Archived") {
        throw new Error("ACCESS_DENIED: Account is archived or suspended.");
      }

      // Check membership expiration authoritatively
      let isExpired = false;
      if ((user.role || "").toLowerCase() === "member" && typeof user.dateRegistered === "number") {
        const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(user.plan) : 30;
        const expiryAt = user.dateRegistered + planDays * 24 * 60 * 60 * 1000;
        if (Date.now() + offset > expiryAt) {
          isExpired = true;
        }
      }

      const freshNow = new Date(Date.now() + offset);
      const freshTimeStr = freshNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const userName = user.name || `${user.givenName || ''} ${user.familyName || ''}`.trim() || "Member";
      const isTrainer = (user.role || "").toLowerCase() === "trainer";

      // Authoritatively determine check-in status (prioritizing transaction-synchronized fields, falling back to legacy pre-query)
      const isAlreadyCheckedIn = (user.attendanceStatus === "Checked In" && user.activeAttendanceId) || legacyActiveId;
      const activeAttId = user.activeAttendanceId || legacyActiveId;

      if (isAlreadyCheckedIn) {
        // TAP-OUT logic
        const attRef = doc(db, "attendance", activeAttId);
        const attSnap = await transaction.get(attRef);
        
        let record = {};
        if (attSnap.exists()) {
          record = attSnap.data();
        }

        const THIRTY_MIN_MS = 30 * 60 * 1000;
        const checkInAt = typeof record.timestamp === "number" ? record.timestamp : null;
        const msSinceIn = checkInAt !== null ? freshNow.getTime() - checkInAt : null;

        const operatorRole = (localStorage.getItem("userRole") || "").toLowerCase();
        const canOverride = operatorRole === "admin" || operatorRole === "staff";

        if (msSinceIn !== null && msSinceIn >= 0 && msSinceIn < THIRTY_MIN_MS) {
          // Inside a transaction, we cannot prompt the user. We throw a custom error,
          // which will be caught in the outer catch block to trigger the UI prompt and retry.
          throw new Error(`TAP_OUT_EARLY:${activeAttId}:${msSinceIn}`);
        }

        transaction.update(attRef, {
          timeOut: freshTimeStr,
          status: "Checked Out",
        });

        const userUpdates = {
          attendanceStatus: "Checked Out",
          activeAttendanceId: null
        };
        if (isTrainer) {
          userUpdates.shiftStatus = "Off Floor";
        }
        transaction.update(userRef, userUpdates);

        return { action: "Checked Out", userName, isTrainer };

      } else {
        // TAP-IN logic
        if (isExpired) {
          throw new Error("ACCESS_DENIED: Membership is expired.");
        }

        const newAttRef = doc(collection(db, "attendance"));
        const newAttData = {
          name: userName,
          type: user.plan || user.role || "Member",
          date: dateStr,
          timeIn: freshTimeStr,
          timeOut: "",
          status: "Checked In",
          timestamp: freshNow.getTime(),
          userId: userId,
          rfid: scannedTag,
        };
        transaction.set(newAttRef, newAttData);

        const userUpdates = {
          attendanceStatus: "Checked In",
          activeAttendanceId: newAttRef.id
        };
        if (isTrainer) {
          userUpdates.shiftStatus = "On Floor";
        }
        transaction.update(userRef, userUpdates);

        return { action: "Checked In", userName, isTrainer };
      }
    });

    if (checkinResult.action === "Checked Out") {
      playRfidBuzzer(150, 300);
      showToast(`${checkinResult.userName} successfully checked out.`, "info");
    } else {
      playRfidBuzzer(250, 200);
      showToast(`${checkinResult.userName} successfully checked in! Welcome!`, "success");
    }

  } catch (err) {
    const errMsg = err.message || "";
    if (errMsg.startsWith("ACCESS_DENIED:")) {
      playRfidBuzzer(90, 600);
      showToast(errMsg.replace("ACCESS_DENIED:", "").trim(), "error");
    } else if (errMsg.startsWith("TAP_OUT_EARLY:")) {
      const parts = errMsg.split(":");
      const activeAttId = parts[1];
      const msSinceIn = parseInt(parts[2]);
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      const minsLeft = Math.ceil((THIRTY_MIN_MS - msSinceIn) / 60000);

      const operatorRole = (localStorage.getItem("userRole") || "").toLowerCase();
      const canOverride = operatorRole === "admin" || operatorRole === "staff";

      if (!canOverride) {
        playRfidBuzzer(90, 600);
        showToast("Tap-out denied: you can only tap out 30 minutes after tapping in. Please ask staff for an override.", "error");
        return;
      }

      showConfirm(
        `Tap-out is blocked for 30 minutes after tap-in.\n\nOverride and allow tap-out anyway? (${minsLeft} minute(s) remaining)`,
        async () => {
          const reason = (prompt("Override reason (required):", "Early tap-out") || "").trim();
          if (!reason) {
            showToast("Override cancelled: reason is required.", "error");
            return;
          }

          const freshOffset = window.serverTimeOffsetMs || 0;
          const freshNow = new Date(Date.now() + freshOffset);
          const freshTimeStr = freshNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

          try {
            await runTransaction(db, async (t) => {
              const userRef = doc(db, "users", userId);
              const userSnap = await t.get(userRef);
              const user = userSnap.data();
              const isTrainer = (user.role || "").toLowerCase() === "trainer";

              t.update(doc(db, "attendance", activeAttId), {
                timeOut: freshTimeStr,
                status: "Checked Out",
                overrideTapOut: true,
                overrideByRole: localStorage.getItem("userRole") || "",
                overrideBy: localStorage.getItem("loggedInUser") || "",
                overrideReason: reason,
                overrideTimestamp: freshNow.getTime(),
              });

              const userUpdates = {
                attendanceStatus: "Checked Out",
                activeAttendanceId: null
              };
              if (isTrainer) {
                userUpdates.shiftStatus = "Off Floor";
              }
              t.update(userRef, userUpdates);
            });
            playRfidBuzzer(150, 300);
            showToast("Early tap-out override successful.", "success");
          } catch (e) {
            console.error(e);
            showToast("Failed to perform override check-out.", "error");
          }
        }
      );
    } else {
      console.error("Checkin/Out transaction failed: ", err);
      showToast(err.message || "An error occurred during check-in.", "error");
    }
  }
}

