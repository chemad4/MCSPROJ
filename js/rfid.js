import { collection, doc, getDocs, query, updateDoc, where, runTransaction, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
    
    // UEC-01 Guard: Ignore keystrokes entirely if focused on normal text inputs
    const isTextInput = activeEl && (
      activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA" ||
      activeEl.isContentEditable
    );
    if (isTextInput && !isRegistrationBox) {
      rfidBuffer = "";
      return;
    }

    if (currentTime - lastKeyTime > 50) rfidBuffer = "";

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
          // Set debounce timestamp only after the scan is dispatched, so that a
          // transaction failure (TAP_OUT_EARLY, ACCESS_DENIED) doesn't permanently
          // block a valid retry for 3 seconds.
          const tagSnapshot = rfidBuffer;
          // SP-5: catch unhandled Firestore/network rejections and surface them to the operator
          processRfidAttendance({ scannedTag: tagSnapshot, db, usersCol, attendanceCol })
            .catch(err => {
              console.error("[RFID] Unhandled scan error:", err);
              if (typeof showToast === "function") showToast("Card reader error. Please try again.", "error");
            })
            .finally(() => {
              lastScanAtByTag.set(tagSnapshot, Date.now());
            });
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
    // EC-5: use ISO-8601 (YYYY-MM-DD) for all date keys so locale differences
    // between devices (en-US vs en-PH etc.) never cause string mismatches.
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const guestCardsCol = collection(db, "guestCards");
    const guestQ = query(guestCardsCol, where("rfid", "==", scannedTag));
    const guestSnap = await getDocs(guestQ);

    if (guestSnap.empty) {
      playRfidBuzzer(120, 400);
      if (typeof showToast === "function") {
        showToast("Card not recognized. Access denied.", "error");
      }
      console.warn(`Unrecognized Card Scanned (ID: ${scannedTag}).`);
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
    const attData = attDoc.data() || {};
    const checkInAt = typeof attData.timestamp === "number" ? attData.timestamp : null;
    const msSinceIn = checkInAt !== null ? now.getTime() - checkInAt : null;
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    if (msSinceIn !== null && msSinceIn >= 0 && msSinceIn < THIRTY_MIN_MS) {
      const operatorRole = (localStorage.getItem("userRole") || "").toLowerCase();
      const canOverride = operatorRole === "admin" || operatorRole === "staff";
      if (!canOverride) {
        playRfidBuzzer(90, 600);
        if (typeof showToast === "function") {
          showToast("Guest tap-out denied: guest card can only be tapped out 30 minutes after check-in. Ask staff for an override.", "error");
        }
        return;
      }

      showConfirm({
        title: 'Override Guest Tap-Out?',
        message: `Guest check-in was less than 30 minutes ago.\n\nOverride and check out this guest anyway?`,
        tone: 'warning',
        confirmText: 'Continue to Override',
        onConfirm: () => {
          showPrompt({
            title: 'Override Reason Required',
            message: 'Please provide a reason for the early guest checkout.',
            placeholder: 'e.g. Guest left early',
            onConfirm: async (reason) => {
              // VULN-07: reject blank/whitespace-only override reasons — they defeat audit accountability
              if (!reason || !reason.trim() || reason.trim().length < 4) {
                showToast("Please provide a descriptive reason (at least 4 characters).", "error");
                return;
              }
              const sanitizedReason = reason.trim();
              try {
                await updateDoc(doc(db, "attendance", attDoc.id), {
                  timeOut: timeStr,
                  status: "Checked Out",
                  overrideTapOut: true,
                  overrideByRole: localStorage.getItem("userRole") || "",
                  overrideBy: localStorage.getItem("loggedInUser") || "",
                  overrideReason: sanitizedReason,
                  overrideTimestamp: now.getTime(),
                });

                await updateDoc(doc(db, "guestCards", guestDoc.id), {
                  status: "Available",
                  checkedOutAt: now.getTime(),
                  checkedOutByRole: localStorage.getItem("userRole") || "",
                  checkedOutBy: localStorage.getItem("loggedInUser") || "",
                  lastUsedDate: dateStr,
                  issuedForDate: "",
                  paymentId: "",
                });

                try {
                  const passesCol = collection(db, "walkinPasses");
                  const passQ = query(passesCol, where("rfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Active"));
                  const passSnap = await getDocs(passQ);
                  if (!passSnap.empty) {
                    await updateDoc(doc(db, "walkinPasses", passSnap.docs[0].id), { status: "Used", usedAt: now.getTime() });
                  }
                } catch (_) {}

                playRfidBuzzer(150, 300);
                showToast("Early guest tap-out override successful.", "success");
              } catch (e) {
                console.error(e);
                showToast("Failed to perform override check-out.", "error");
              }
            }
          });
        }
      });
      return;
    }

    // BUG-08: Use a batch so all three writes succeed or fail together.
    // Sequential updateDoc calls left the guest card stuck as "Issued" on network dropout.
    const batch = writeBatch(db);
    batch.update(doc(db, "attendance", attDoc.id), { timeOut: timeStr, status: "Checked Out" });
    batch.update(doc(db, "guestCards", guestDoc.id), {
      status: "Available",
      checkedOutAt: now.getTime(),
      checkedOutByRole: localStorage.getItem("userRole") || "",
      checkedOutBy: localStorage.getItem("loggedInUser") || "",
      lastUsedDate: dateStr,
      issuedForDate: "",
      paymentId: "",
    });

    // Mark the most recent active walk-in pass as used (best-effort, pre-queried outside batch).
    try {
      const passesCol = collection(db, "walkinPasses");
      const passQ = query(passesCol, where("rfid", "==", scannedTag), where("date", "==", dateStr), where("status", "==", "Active"));
      const passSnap = await getDocs(passQ);
      if (!passSnap.empty) {
        batch.update(doc(db, "walkinPasses", passSnap.docs[0].id), { status: "Used", usedAt: now.getTime() });
      }
    } catch (_) {
      // ignore — pass cleanup is best-effort
    }

    await batch.commit();
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
        throw new Error("ACCESS_DENIED: Account is archived.");
      }
      // Explicit trainer/staff gate: Suspended or On Leave profiles must never clock in,
      // even if a prior RFID glitch left shiftStatus as 'On Floor' in the DB.
      const _role = (user.role || "").toLowerCase();
      if (_role === "trainer" || _role === "staff" || _role === "admin") {
        if (user.status === "Suspended") {
          throw new Error("ACCESS_DENIED: Account Suspended — clock-in blocked.");
        }
        if (user.status === "On Leave") {
          throw new Error("ACCESS_DENIED: Account On Leave — clock-in blocked.");
        }
        if ((user.status || "Active") !== "Active") {
          throw new Error(`ACCESS_DENIED: Shift check-in denied. Your account status is "${user.status || 'Active'}".`);
        }
      } else if (user.status === "Suspended") {
        throw new Error("ACCESS_DENIED: Account is suspended.");
      }

      // Check membership expiration authoritatively.
      // Compare at start-of-day so the expiry day itself is treated as the last valid day,
      // and the member is locked out from 00:00 of the day AFTER expiry (no midnight loophole).
      let isExpired = false;
      if ((user.role || "").toLowerCase() === "member" && typeof user.dateRegistered === "number") {
        // H2: if the member's plan name no longer exists in the catalog, deny access instead of
        // silently falling back to the 30-day default (which would grant grace access on a deleted plan).
        const plans = window.__membershipPlansData || [];
        if (user.plan && plans.length > 0) {
          const matched = plans.find(p => (p.name || '').toLowerCase() === (user.plan || '').toLowerCase());
          if (!matched) {
            throw new Error("ACCESS_DENIED: Your membership plan is no longer valid. Please see the front desk.");
          }
        }
        const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(user.plan) : 30;
        const expiryAt = user.dateRegistered + planDays * 24 * 60 * 60 * 1000;
        const expiryStartOfDay = new Date(expiryAt);
        expiryStartOfDay.setHours(0, 0, 0, 0);
        const todayStartOfDay = new Date(Date.now() + offset);
        todayStartOfDay.setHours(0, 0, 0, 0);
        if (todayStartOfDay.getTime() > expiryStartOfDay.getTime()) {
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

        // BUG-04: Guard against stale legacyActiveId — if the attendance record was
        // already checked out by another device between the pre-query and this transaction,
        // treat the user as not checked in and fall through to tap-in.
        if (!attSnap.exists() || attSnap.data().status === "Checked Out") {
          throw new Error("ACCESS_DENIED: Session already ended on another device. Tap again to check in.");
        }
        
        let record = {};
        if (attSnap.exists()) {
          record = attSnap.data();
        }

        const THIRTY_MIN_MS = 30 * 60 * 1000;
        const checkInAt = typeof record.timestamp === "number" ? record.timestamp : null;
        const msSinceIn = checkInAt !== null ? freshNow.getTime() - checkInAt : null;

        if (msSinceIn !== null && msSinceIn >= 0 && msSinceIn < THIRTY_MIN_MS) {
          // Inside a transaction, we cannot prompt the user. We throw a custom error,
          // which will be caught in the outer catch block to trigger the UI prompt and retry.
          throw new Error(`TAP_OUT_EARLY:${activeAttId}:${msSinceIn}`);
        }

        transaction.update(attRef, {
          timeOut: freshTimeStr,
          status: "Checked Out",
        });

        const isStaff = (user.role || "").toLowerCase() === "staff";
        const userUpdates = {
          attendanceStatus: "Checked Out",
          activeAttendanceId: null
        };
        if (isTrainer) {
          userUpdates.shiftStatus = "Off Floor";
        } else if (isStaff) {
          userUpdates.shiftStatus = "Off Shift";
          userUpdates.shiftStart = null;
        }
        transaction.update(userRef, userUpdates);

        return { action: "Checked Out", userName, isTrainer };

      } else {
        // TAP-IN logic
        if (isExpired) {
          throw new Error("ACCESS_DENIED: Membership is expired.");
        }

        // Best-effort: surface (but don't block on) an expired locker lease for members.
        // Returned to outer scope via a sentinel field on the returned object.
        let lockerExpiredNote = null;
        if (user.hasLocker && user.lockerId) {
          try {
            const lockerRef = doc(db, "lockers", user.lockerId);
            const lockerSnap = await transaction.get(lockerRef);
            if (lockerSnap.exists()) {
              const ld = lockerSnap.data();
              if (typeof ld.expiryDate === "number" && ld.expiryDate < freshNow.getTime()) {
                lockerExpiredNote = "Locker lease expired — please renew at the desk.";
              }
            }
          } catch (_) { /* non-blocking */ }
        }
        // attach below in return

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

        const isStaff = (user.role || "").toLowerCase() === "staff";
        const userUpdates = {
          attendanceStatus: "Checked In",
          activeAttendanceId: newAttRef.id
        };
        if (isTrainer) {
          userUpdates.shiftStatus = "On Floor";
        } else if (isStaff) {
          userUpdates.shiftStatus = "On Shift";
          userUpdates.shiftStart = freshNow.getTime();
        }
        transaction.update(userRef, userUpdates);

        return { action: "Checked In", userName, isTrainer, lockerExpiredNote };
      }
    });

    if (checkinResult.action === "Checked Out") {
      playRfidBuzzer(150, 300);
      showToast(`${checkinResult.userName} successfully checked out.`, "info");
    } else {
      playRfidBuzzer(250, 200);
      showToast(`${checkinResult.userName} successfully checked in! Welcome!`, "success");
      if (checkinResult.lockerExpiredNote) {
        showToast(checkinResult.lockerExpiredNote, "warning");
      }
    }

  } catch (err) {
    const errMsg = err.message || "";
    if (errMsg.startsWith("ACCESS_DENIED:")) {
      playRfidBuzzer(90, 600);
      showToast(errMsg.replace("ACCESS_DENIED:", "").trim(), "error");
    } else if (errMsg.startsWith("TAP_OUT_EARLY:")) {
      // Format: TAP_OUT_EARLY:<attId>:<msSinceIn>
      // Use slice from index 14 to avoid misparse if attId contains ":"
      const payload = errMsg.slice("TAP_OUT_EARLY:".length);
      const sepIdx = payload.lastIndexOf(":");
      const activeAttId = sepIdx > 0 ? payload.slice(0, sepIdx) : payload;
      const msSinceIn = sepIdx > 0 ? parseInt(payload.slice(sepIdx + 1)) : 0;
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      const minsLeft = Math.ceil((THIRTY_MIN_MS - msSinceIn) / 60000);

      const operatorRole = (localStorage.getItem("userRole") || "").toLowerCase();
      const canOverride = operatorRole === "admin" || operatorRole === "staff";

      if (!canOverride) {
        playRfidBuzzer(90, 600);
        showToast("Tap-out denied: you can only tap out 30 minutes after tapping in. Please ask staff for an override.", "error");
        return;
      }

      showConfirm({
        title: 'Override Tap-Out?',
        message: `Tap-out is blocked for 30 minutes after tap-in.\n\nOverride and allow tap-out anyway? (${minsLeft} minute(s) remaining)`,
        tone: 'warning',
        confirmText: 'Continue to Override',
        onConfirm: () => {
          showPrompt({
            title: 'Override Reason Required',
            message: 'Please provide a reason for the early tap-out override.',
            placeholder: 'e.g. Early tap-out',
            onConfirm: async (reason) => {
              // VULN-07: reject blank/whitespace-only override reasons — they defeat audit accountability
              if (!reason || !reason.trim() || reason.trim().length < 4) {
                showToast("Please provide a descriptive reason (at least 4 characters).", "error");
                return;
              }
              const sanitizedReason = reason.trim();
              const freshOffset = window.serverTimeOffsetMs || 0;
              const freshNow = new Date(Date.now() + freshOffset);
              const freshTimeStr = freshNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

              try {
                await runTransaction(db, async (t) => {
                  const userRef = doc(db, "users", userId);
                  const userSnap = await t.get(userRef);
                  // SP-6: guard against user document being deleted between scan and override confirm
                  if (!userSnap.exists()) throw new Error("User record no longer exists.");
                  const user = userSnap.data();
                  const isTrainer = (user.role || "").toLowerCase() === "trainer";

                  t.update(doc(db, "attendance", activeAttId), {
                    timeOut: freshTimeStr,
                    status: "Checked Out",
                    overrideTapOut: true,
                    overrideByRole: localStorage.getItem("userRole") || "",
                    overrideBy: localStorage.getItem("loggedInUser") || "",
                    overrideReason: sanitizedReason,
                    overrideTimestamp: freshNow.getTime(),
                  });

                  const isStaff = (user.role || "").toLowerCase() === "staff";
                  const userUpdates = {
                    attendanceStatus: "Checked Out",
                    activeAttendanceId: null
                  };
                  if (isTrainer) {
                    userUpdates.shiftStatus = "Off Floor";
                  } else if (isStaff) {
                    userUpdates.shiftStatus = "Off Shift";
                    userUpdates.shiftStart = null;
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
          });
        }
      });
    } else {
      console.error("Checkin/Out transaction failed: ", err);
      showToast(err.message || "An error occurred during check-in.", "error");
    }
  }
}

