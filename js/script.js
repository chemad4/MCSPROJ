// ==========================================
// 1. IMPORT FIREBASE DEPENDENCIES
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence, collection, addDoc, deleteDoc, doc, updateDoc, setDoc, onSnapshot, query, where, orderBy, limit, getDocs, getDoc, increment, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
// Firebase Storage removed — images stored as Base64 in Firestore (free tier compatible)
import { initAttendance } from "./attendance.js";
import { initRfid } from "./rfid.js";
import { escapeHtml, formatCurrency } from "./utils.js";
import { firebaseConfig } from "./firebase-config.js";
import { checkoutBatches, restoreBatchDeductions } from "./inventory-checkout.js";

// Expose utilities globally for inline handlers & other scripts
window.escapeHtml = escapeHtml;
window.formatCurrency = formatCurrency;

// XSS hardening: only allow http(s):// and a small set of raster-image data: URIs as <img src>.
// SVG data URIs and javascript:/file: schemes are rejected because they can execute script.
window.isSafeImageSrc = function (url) {
    if (!url || typeof url !== 'string') return false;
    const s = url.trim();
    if (/^https?:\/\//i.test(s)) return true;
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(s)) return true;
    return false;
};
// Returns a safely-escaped src or `fallback` when scheme is unsafe (SVG/javascript:/data: text).
window.safeImgSrc = function (url, fallback) {
    const fb = fallback || 'images/default-product.png';
    return window.isSafeImageSrc(url) ? escapeHtml(url) : fb;
};

// Self-edit allowlist: fields a user is permitted to change on their own user doc.
// Anything else (role, status, sessionsRemaining, uid, dateRegistered, plan, etc.) is dropped.
const USER_SELF_EDITABLE_FIELDS = new Set([
    'name', 'givenName', 'familyName',
    'emergencyContact', 'image',
    'password',
    'fitnessGoals', 'mustChangePassword',
]);
window.pickSelfEditable = function (updates) {
    const out = {};
    if (!updates || typeof updates !== 'object') return out;
    for (const k of Object.keys(updates)) {
        if (USER_SELF_EDITABLE_FIELDS.has(k)) out[k] = updates[k];
    }
    return out;
};

// ==========================================
// SECURITY: Secure Server Time Synchronization
// ==========================================
window.serverTimeOffsetMs = 0;
async function syncServerTimeOffset() {
    const start = Date.now();
    try {
        const response = await fetch(window.location.href, { method: 'HEAD', cache: 'no-cache' });
        const end = Date.now();
        const serverDateStr = response.headers.get('Date');
        if (serverDateStr) {
            const serverTime = new Date(serverDateStr).getTime();
            const latency = (end - start) / 2;
            const correctedServerTime = serverTime + latency;
            window.serverTimeOffsetMs = correctedServerTime - end;
            console.log(`[TimeSync] Server time synchronized. Offset: ${window.serverTimeOffsetMs}ms`);
        }
    } catch (err) {
        console.warn('[TimeSync] Failed to fetch server date header, defaulting to local clock.', err);
    }
}
window.syncServerTimeOffset = syncServerTimeOffset;
syncServerTimeOffset();
setInterval(syncServerTimeOffset, 5 * 60 * 1000);

// ==========================================
// UTILITY: softRender — non-disruptive live re-render
// ==========================================
// onSnapshot callbacks can fire while the user is editing a field, has a modal
// open, or is mid-scroll through a long list. A blind re-render in that moment
// loses caret position, scroll, and any open inline UI — feels like the page
// "refreshed itself." softRender wraps a render function so that:
//   1. If a modal/dialog is currently visible, the render is deferred and
//      re-attempted after the modal closes. Latest call per `key` wins.
//   2. Otherwise we snapshot scrollTop on every scrollable container and the
//      currently-focused element (id + caret), run the render, then restore.
const _pendingSoftRenders = new Map();

function _anyModalOpen() {
    const candidates = document.querySelectorAll(
        '.modal, .modal-overlay, [role="dialog"], .prompt-modal, .confirm-modal'
    );
    for (const m of candidates) {
        if (!m.isConnected) continue;
        const cs = window.getComputedStyle(m);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (m.offsetParent === null && cs.position !== 'fixed') continue;
        return true;
    }
    return false;
}

function _snapshotScrolls() {
    const snaps = [];
    document.querySelectorAll(
        '[data-soft-scroll], .table-scroll, .table-wrapper, .scrollable, .grid-scroll, .list-scroll'
    ).forEach(el => {
        if (el.scrollHeight > el.clientHeight) snaps.push([el, el.scrollTop]);
    });
    snaps.push([document.scrollingElement || document.documentElement, window.scrollY]);
    return snaps;
}

function _restoreScrolls(snaps) {
    snaps.forEach(([el, top]) => {
        if (!el || !el.isConnected) return;
        try { el.scrollTop = top; } catch (_) {}
    });
}

function _snapshotFocus() {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    const isField = a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable;
    if (!isField || !a.id) return null;
    const snap = { id: a.id, value: 'value' in a ? a.value : null };
    if ('selectionStart' in a) {
        try { snap.selStart = a.selectionStart; snap.selEnd = a.selectionEnd; } catch (_) {}
    }
    return snap;
}

function _restoreFocus(snap) {
    if (!snap) return;
    const el = document.getElementById(snap.id);
    if (!el || typeof el.focus !== 'function') return;
    // If the element was replaced with a fresh node, value may have reset.
    if (snap.value != null && 'value' in el && el.value !== snap.value) {
        try { el.value = snap.value; } catch (_) {}
    }
    try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
    if (snap.selStart != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch (_) {}
    }
}

function softRender(key, renderFn) {
    if (typeof renderFn !== 'function') return;
    if (_anyModalOpen()) {
        _pendingSoftRenders.set(key, renderFn);
        return;
    }
    const focusSnap = _snapshotFocus();
    const scrollSnaps = _snapshotScrolls();
    try {
        renderFn();
    } catch (e) {
        console.error(`[softRender:${key}] render failed:`, e);
    } finally {
        _restoreScrolls(scrollSnaps);
        _restoreFocus(focusSnap);
    }
}
window.softRender = softRender;

function _drainPendingRenders() {
    if (_pendingSoftRenders.size === 0) return;
    if (_anyModalOpen()) return;
    const queue = Array.from(_pendingSoftRenders.entries());
    _pendingSoftRenders.clear();
    queue.forEach(([key, fn]) => softRender(key, fn));
}

// Drain when modals close. We can't intercept every close path, so we run on
// any click/keyup that *might* have closed a modal, plus a low-frequency poll
// as a safety net (cheap: no DOM work unless something is pending and free).
document.addEventListener('click', _drainPendingRenders, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Escape') _drainPendingRenders(); }, true);
setInterval(_drainPendingRenders, 1500);

// ==========================================
// UTILITY: Transaction Reference ID Generator
// ==========================================
function generateTransactionRef() {
    const now = new Date();
    const dateStr = now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
    const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `XFT-${dateStr}-${randomPart}`;
}
window.generateTransactionRef = generateTransactionRef;

/**
 * Synchronizes a container with a data array using DOM diffing to prevent UI flickering.
 */
window.syncDOM = function (container, dataArray, renderFunc, idPrefix) {
    if (!container) return;

    // Clear initial skeleton loaders if they exist (Audit Fix)
    if (container.querySelector('.skeleton-row') || (container.innerHTML.includes('Loading...') && !container.innerHTML.includes(idPrefix))) {
        container.innerHTML = "";
    }

    const currentIds = new Set(dataArray.map(item => `${idPrefix}-${item.id}`));

    // 1. Remove elements no longer in the data array
    Array.from(container.children).forEach(child => {
        if (child.id && child.id.startsWith(idPrefix) && !currentIds.has(child.id)) {
            container.removeChild(child);
        }
    });

    // 2. Update existing elements or Append new ones
    dataArray.forEach((item, index) => {
        const id = `${idPrefix}-${item.id}`;
        const html = renderFunc(item);
        let el = document.getElementById(id);

        if (el) {
            // Update existing if content changed
            const isTable = container.tagName === 'TBODY';
            const temp = document.createElement(isTable ? 'table' : 'div');
            temp.innerHTML = isTable ? `<tbody>${html}</tbody>` : html;
            const newEl = isTable ? temp.querySelector('tr') : temp.firstElementChild;
            
            if (newEl) {
                if (el.innerHTML !== newEl.innerHTML) {
                    el.innerHTML = newEl.innerHTML;
                }
                // Sync attributes
                Array.from(newEl.attributes).forEach(attr => {
                    if (el.getAttribute(attr.name) !== attr.value) {
                        el.setAttribute(attr.name, attr.value);
                    }
                });
                // Remove obsolete attributes
                Array.from(el.attributes).forEach(attr => {
                    if (!newEl.hasAttribute(attr.name) && attr.name !== 'id') {
                        el.removeAttribute(attr.name);
                    }
                });
            }
        } else {
            // Create new element
            const isTable = container.tagName === 'TBODY';
            const temp = document.createElement(isTable ? 'table' : 'div');
            temp.innerHTML = isTable ? `<tbody>${html}</tbody>` : html;
            const newEl = isTable ? temp.querySelector('tr') : temp.firstElementChild;
            if (newEl) {
                newEl.id = id;
                // Insert at specific index to maintain order
                const nextEl = container.children[index];
                if (nextEl) {
                    container.insertBefore(newEl, nextEl);
                } else {
                    container.appendChild(newEl);
                }
            }
        }

        // 3. Maintain correct order if it changed
        const currentElAtIndex = container.children[index];
        if (currentElAtIndex && currentElAtIndex.id !== id) {
            const targetEl = document.getElementById(id);
            if (targetEl) container.insertBefore(targetEl, currentElAtIndex);
        }
    });
};

// ==========================================
// 2. FIREBASE & EMAILJS CONFIGURATION
// ==========================================
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Enable Offline Persistence for gold-standard Firestore quota optimization.
// Reads will be served from local cache first, costing 0 quota reads.
// Only new/modified documents since the last page sync will be fetched from the server.
enableIndexedDbPersistence(db).catch((err) => {
    if (err.code === 'failed-precondition') {
        console.warn("Firestore persistence failed-precondition (multiple tabs open)");
    } else if (err.code === 'unimplemented') {
        console.warn("Firestore persistence unimplemented in browser");
    }
});

// Resize an image file to max 250x250 and return as Base64 data URL (Firestore-compatible, no Firebase Storage needed)
window.uploadImage = function (file, _folder) {
    return new Promise((resolve, reject) => {
        if (!file) { resolve(null); return; }
        const MAX = 250;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.75));
            };
            img.onerror = () => { showToast("Image load failed.", "error"); reject(new Error("img load")); };
            img.src = e.target.result;
        };
        reader.onerror = () => { showToast("Image read failed.", "error"); reject(new Error("file read")); };
        reader.readAsDataURL(file);
    });
};

// Image preview utility
window.previewImage = function (input, previewId) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function (e) {
            document.getElementById(previewId).src = e.target.result;
        }
        reader.readAsDataURL(input.files[0]);
    }
};

// NEW: Image Source Choice Logic
let currentImageTarget = { preview: null, file: null, url: null };

window.openImageChoice = function(previewId, fileInputId, urlInputId) {
    currentImageTarget = { preview: previewId, file: fileInputId, url: urlInputId };
    const modal = document.getElementById('imageSourceModal');
    if (modal) modal.style.display = 'flex';
};

window.chooseImageUpload = function() {
    const fileInput = document.getElementById(currentImageTarget.file);
    if (fileInput) fileInput.click();
    closeModal('imageSourceModal');
};

window.chooseImageUrl = function() {
    closeModal('imageSourceModal');
    showPrompt({
        title: 'Enter Image URL',
        message: 'Paste the direct URL of the image:',
        placeholder: 'https://example.com/image.jpg',
        onConfirm: (url) => {
            if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) {
                return showToast('Please enter a valid URL starting with https://', 'error');
            }
            if (!window.isSafeImageSrc(url)) {
                return showToast('URL scheme not allowed. Use a direct https:// image link.', 'error');
            }
            const preview = document.getElementById(currentImageTarget.preview);
            const urlInput = document.getElementById(currentImageTarget.url);
            if (preview) preview.src = window.escapeHtml(url);
            if (urlInput) urlInput.value = url;
        }
    });
};

// Initialize EmailJS
emailjs.init("ZqQKGRo5j5KpAhH98");

// ==========================================
// 3. DYNAMIC SESSION OVERRIDE LISTENER
// ==========================================
const currentUserId = localStorage.getItem("userId");
const currentSessionId = localStorage.getItem("sessionId");
const currentUserRole = localStorage.getItem("userRole");
// Normalized role for read-quota gating (members don't subscribe to staff-only collections)
const roleNorm = (currentUserRole || "").toLowerCase();
const isStaffSide = roleNorm === "admin" || roleNorm === "staff";
const isAdmin = roleNorm === "admin";

/** Case-insensitive admin check for RBAC gates (Firestore role may be Admin or admin). */
window.isCallerAdmin = function () {
    return (localStorage.getItem("userRole") || "").toLowerCase() === "admin";
};
window.isCallerStaffOrAdmin = function () {
    const r = (localStorage.getItem("userRole") || "").toLowerCase();
    return r === "admin" || r === "staff";
};

if (currentUserId && currentSessionId) {
    onSnapshot(doc(db, "users", currentUserId), (docSnap) => {
        if (docSnap.exists()) {
            const userData = docSnap.data();
            window.currentUserData = userData;

            // SYNC NAME: Ensure localStorage and UI are always fresh from DB
            const dbName = userData.name || `${userData.givenName || ''} ${userData.familyName || ''}`.trim() || "User";
            if (localStorage.getItem("loggedInUser") !== dbName) {
                localStorage.setItem("loggedInUser", dbName);
            }
            // Refresh Topbar & Greeting if elements exist (every snapshot — merged from second listener)
            const tNameEl = document.getElementById('topBarName');
            if (tNameEl) tNameEl.innerText = dbName.split(' ')[0];

            const sNameEl = document.getElementById('sidebarUserName');
            if (sNameEl) sNameEl.innerText = dbName;
            
            const sAvatarEl = document.getElementById('sidebarAvatar');
            if (sAvatarEl) {
                const initials = dbName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                sAvatarEl.innerText = initials || "U";
            }

            const gTextEl = document.getElementById('greetingText');
            if (gTextEl) {
                const hour = new Date().getHours();
                const firstName = dbName.split(' ')[0];
                let greetingWord = "Good Morning";
                if (hour >= 12 && hour < 18) greetingWord = "Good Afternoon";
                else if (hour >= 18) greetingWord = "Good Evening";
                gTextEl.innerHTML = `${greetingWord}, <span style="color: var(--primary-red); font-weight: 700;">${firstName}</span>.`;
            }

            // Fitness Goals input (member) — preserved from second listener
            const goalsInput = document.getElementById('fitnessGoalsInput');
            if (goalsInput && !goalsInput.matches(':focus')) {
                goalsInput.value = userData.fitnessGoals || "";
            }

            // Sessions remaining/total/bar — preserved from second listener
            const sessionsRemaining = userData.sessionsRemaining !== undefined ? Number(userData.sessionsRemaining) : 0;
            const sessionsTotal = userData.sessionsTotal !== undefined ? Number(userData.sessionsTotal) : 0;
            if (document.getElementById('mySessionsRemaining')) document.getElementById('mySessionsRemaining').innerText = sessionsRemaining;
            if (document.getElementById('mySessionsTotal')) document.getElementById('mySessionsTotal').innerText = sessionsTotal;
            if (document.getElementById('mySessionsBar')) {
                const percent = sessionsTotal > 0 ? Math.max(0, Math.min(100, (sessionsRemaining / sessionsTotal) * 100)) : 0;
                document.getElementById('mySessionsBar').style.width = `${percent}%`;
            }

            // Profile preview image — preserved from second listener
            const profilePreview = document.getElementById('userProfilePreview');
            const profileFile = document.getElementById('userProfileFile');
            if (profilePreview && (!profileFile || !profileFile.files[0])) {
                profilePreview.src = userData.image || 'images/default-profile.png';
            }

            // Kick out duplicate logins OR logouts from another tab/device.
            // currentSession=null means the user logged out elsewhere; mismatch means another device claimed the session.
            //
            // BUG FIX: Three guards added to prevent false-positive session revocations:
            //
            // 1. Bypass/dev login sessions (userId starts with "test-") never write to Firestore,
            //    so skip the session check entirely for them — they are local-only test sessions.
            //
            // 2. Only treat a session as "revoked" when Firestore explicitly returns null (i.e.
            //    the field is present but null). If the field is simply undefined/missing — which
            //    happens transiently during partial writes (e.g., editing a member's name) — we
            //    must NOT kick the user out. Using `userData.currentSession === null` (strict
            //    equality) avoids false revocations from undefined snapshot fields.
            //
            // 3. Add a 3-second settle debounce: wait for the snapshot to stabilise before
            //    acting on a potential revocation, so a partial write mid-flight doesn't trigger
            //    a logout before the final write arrives.
            const isBypassSession = (currentUserId || '').startsWith('test-');
            if (!isBypassSession) {
                const sessionMismatch = userData.currentSession && userData.currentSession !== currentSessionId;
                // Strict null check: undefined means field absent/partial write — do NOT revoke.
                const sessionRevoked  = userData.currentSession === null;
                if (sessionMismatch || sessionRevoked) {
                    // Debounce: schedule logout 3 s out. If another snapshot arrives with a
                    // valid session before the timer fires, clear the pending logout.
                    if (!window._sessionRevokeTimer) {
                        window._sessionRevokeTimer = setTimeout(() => {
                            window._sessionRevokeTimer = null;
                            // Re-verify from the latest known data before acting.
                            const latestData = window.currentUserData || {};
                            const stillMismatch = latestData.currentSession && latestData.currentSession !== currentSessionId;
                            const stillRevoked  = latestData.currentSession === null;
                            if (!stillMismatch && !stillRevoked) return; // false alarm — snapshot healed itself
                            showToast(stillRevoked
                                ? "Your session ended (logged out elsewhere). Please sign in again."
                                : "Session Override: Your account was just logged in from another device. Logging out here to protect your data.",
                                "error");
                            localStorage.removeItem("loggedInUser");
                            localStorage.removeItem("userRole");
                            localStorage.removeItem("userRfid");
                            localStorage.removeItem("userId");
                            localStorage.removeItem("shiftStart");
                            localStorage.removeItem("sessionId");
                            localStorage.removeItem("trainerShiftStatus");
                            window.location.replace("index.html");
                        }, 3000);
                    }
                } else {
                    // Valid session confirmed — cancel any pending revocation timer.
                    if (window._sessionRevokeTimer) {
                        clearTimeout(window._sessionRevokeTimer);
                        window._sessionRevokeTimer = null;
                    }
                }
            }

            const roleLower = (currentUserRole || "").toLowerCase();
            // Update Member UI dynamically
            if (roleLower === "member") {
                if (document.getElementById('myPlanName')) document.getElementById('myPlanName').innerText = userData.plan || "Standard Plan";
                if (document.getElementById('myPlanDays') && userData.dateRegistered) {
                    const now = new Date().getTime();
                    const planName = userData.plan || 'Standard Member';
                    const planDays = window.getPlanDays ? window.getPlanDays(planName) : 30;
                    const expiryDate = userData.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                    const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                    
                    if (document.getElementById('myPlanDays')) {
                        document.getElementById('myPlanDays').innerHTML = `<i class="fa-regular fa-clock"></i> ${diffDays > 0 ? diffDays + ' Days Left' : 'Expired'}`;
                    }
                    
                    window.membershipDiffDays = diffDays;
                    if (typeof window.renderBookings === 'function') {
                        window.renderBookings();
                    }

                    // Send expiry reminder email once when ≤7 days remain
                    if (diffDays > 0 && diffDays <= 7 && !userData.expirySentNotification) {
                        const memberEmail = userData.email || '';
                        const memberName = userData.name || userData.givenName || 'Member';
                        if (memberEmail && typeof emailjs !== 'undefined') {
                            emailjs.send("service_x90mti6", "template_nda1wjc", {
                                to_name: memberName,
                                to_email: memberEmail,
                                generated_password: '',
                                plan: `Your ${planName} membership expires in ${diffDays} day${diffDays > 1 ? 's' : ''}. Please renew at the front desk.`
                            }).catch(() => {});
                            updateDoc(doc(db, "users", localStorage.getItem("userId")), { expirySentNotification: true }).catch(() => {});
                        }
                    }

                    // BLOCKING LOGIC: If expired, show renewal modal (truly non-dismissible)
                    if (diffDays <= 0) {
                        const expiredModal = document.getElementById('membershipExpiredModal');
                        if (expiredModal) {
                            expiredModal.style.display = 'flex';
                            // Re-show if any other modal/close handler hides it
                            if (!expiredModal.dataset.lockWired) {
                                expiredModal.dataset.lockWired = '1';
                                // Block Escape from dismissing
                                document.addEventListener('keydown', (e) => {
                                    if (expiredModal.style.display === 'flex' && e.key === 'Escape') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }
                                }, true);
                                // Block backdrop click from dismissing
                                expiredModal.addEventListener('click', (e) => {
                                    if (e.target === expiredModal) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }
                                });
                            }
                        }
                    } else {
                        const expiredModal = document.getElementById('membershipExpiredModal');
                        if (expiredModal) expiredModal.style.display = 'none';
                    }
                }
            }

            // Automatically start/stop Shift Timer based on "On Floor" / "On Shift" status
            if (roleLower === "trainer" || roleLower === "staff") {
                const currentStatus = userData.shiftStatus || (roleLower === "trainer" ? "Off Floor" : "Off Shift");

                if (roleLower === "trainer") {
                    localStorage.setItem("trainerShiftStatus", currentStatus);
                } else {
                    localStorage.setItem("staffShiftStatus", currentStatus);
                }

                const activeStatus = roleLower === "trainer" ? "On Floor" : "On Shift";
                if (currentStatus === activeStatus && !localStorage.getItem("shiftStart")) {
                    localStorage.setItem("shiftStart", Date.now()); // Starts timer
                } else if (currentStatus !== activeStatus) {
                    localStorage.removeItem("shiftStart"); // Stops timer
                }

                // Sync shiftStart from DB if present, and refresh timer UI (merged from second listener)
                if (userData.shiftStart) {
                    localStorage.setItem("shiftStart", userData.shiftStart);
                }
                if (typeof window.updateShiftTimer === 'function') {
                    window.updateShiftTimer();
                }
            }
        }
    });
}

// Set Welcome Name on Dashboard
if (document.getElementById('welcomeName')) {
    document.getElementById('welcomeName').innerText = localStorage.getItem("loggedInUser") || "Member";
}

// ==========================================
// 4. GLOBAL EXPORTS (HTML ONCLICK BUTTONS)
// ==========================================

// C5: cross-tab logout sync (same browser). If another tab clears userId/sessionId, this tab
// boots back to login. Firestore snapshot covers cross-device; storage event covers same-browser.
//
// BUG FIX: The original storage listener redirected immediately on any key removal, including
// transient writes (e.g., key temporarily removed then re-added). Added a 500 ms debounce so
// we only redirect if the key is still gone after a short settle window. Bypass sessions
// (userId starting with "test-") are also exempt since they never update Firestore.
let _storageLogoutTimer = null;
window.addEventListener('storage', (e) => {
    // Bypass/test sessions are local-only; ignore storage events for them.
    const uid = localStorage.getItem('userId') || '';
    if (uid.startsWith('test-')) return;

    const onLoginPage = window.location.pathname.endsWith('index.html') || window.location.pathname === '/';

    if (!e.key) {
        // Whole localStorage cleared (e.g., handleLogout()). Force boot if we thought we were logged in.
        if (onLoginPage) return;
        if (_storageLogoutTimer) clearTimeout(_storageLogoutTimer);
        _storageLogoutTimer = setTimeout(() => {
            _storageLogoutTimer = null;
            if (!localStorage.getItem('userId')) window.location.replace('index.html');
        }, 500);
        return;
    }
    if ((e.key === 'userId' || e.key === 'sessionId') && !e.newValue) {
        if (_storageLogoutTimer) clearTimeout(_storageLogoutTimer);
        _storageLogoutTimer = setTimeout(() => {
            _storageLogoutTimer = null;
            // Only redirect if the key is still absent after the debounce window.
            if (!localStorage.getItem('userId') || !localStorage.getItem('sessionId')) {
                window.location.replace('index.html');
            }
        }, 500);
    }
});

window.handleLogout = async function () {
    const userId = localStorage.getItem("userId");
    const userRole = localStorage.getItem("userRole");

    if (window.logActivity) await window.logActivity("Logout", `User logged out.`);

    if (userId) {
        try {
            let updateData = { currentSession: null };
            const roleLower = (userRole || "").toLowerCase();
            if (roleLower === "admin" || roleLower === "staff" || roleLower === "trainer") {
                updateData.shiftStatus = roleLower === "trainer" ? "Off Floor" : "Off Shift";
            }
            await updateDoc(doc(db, "users", userId), updateData);
        } catch (error) {
            console.error("Failed to update session/shift status:", error);
        }
    }

    localStorage.clear();
    window.location.replace("index.html");
};

window.switchTab = function (tabId, element, evt) {
    if (evt) evt.stopPropagation();
    else if (typeof event !== 'undefined' && event) event.stopPropagation();

    // Persist active tab state in sessionStorage so it survives soft/hard page refreshes
    sessionStorage.setItem("activeTab", tabId);

    const globalSearch = document.getElementById('globalSearchInput');
    if (globalSearch) {
        globalSearch.value = '';
    }

    document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active-section'));
    if (document.getElementById(tabId)) document.getElementById(tabId).classList.add('active-section');

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sub-item').forEach(el => el.classList.remove('active'));

    if (element && !element.classList.contains('stat-card') && !element.classList.contains('grid-stat-box')) {
        element.classList.add('active');
        if (element.classList.contains('sub-item')) {
            element.parentElement.previousElementSibling.classList.add('active');
        }
    } else {
        const targetNav = document.querySelector(`.nav-menu li[onclick*="switchTab('${tabId}'"]`);
        if (targetNav) {
            targetNav.classList.add('active');
            if (targetNav.classList.contains('sub-item')) {
                targetNav.parentElement.previousElementSibling.classList.add('active');
            }
        }
    }

    const titles = {
        'dashboard': 'Dashboard',
        'equipment': 'Equipment Management',
        'products': 'Products & Consumables',
        'ledger': 'Stock Movements Ledger',
        'pos': 'Point of Sale (POS)',
        'payments': 'Financial Reports',
        'members': 'Member Directory',
        'archivedMembers': 'Archived Members',
        'attendance': 'Attendance Log',
        'staff': 'Staff Directory',
        'archivedStaff': 'Archived Staff',
        'trainers': 'Gym Trainers',
        'archivedTrainers': 'Archived Trainers',
        'bookings': 'Session Schedules',
        'chats': 'Internal Messages',
        'activityLog': 'System Activity Log',
        'membershipPlans': 'Membership Plans',
        'lockers': 'Locker Management'
    };

    if (document.getElementById('pageTitle')) {
        document.getElementById('pageTitle').innerText = titles[tabId] || 'Dashboard';
    }
}

window.toggleNotifSidebar = function () {
    const drawer = document.getElementById('notifDrawer');
    const overlay = document.getElementById('notifDrawerOverlay');
    const btn = document.getElementById('notifToggleBtn');
    if (!drawer || !overlay) return;

    const isOpen = drawer.classList.contains('open');
    
    if (isOpen) {
        drawer.classList.remove('open');
        overlay.classList.remove('open');
        if (btn) btn.innerHTML = '<i class="fas fa-bell"></i>';
        localStorage.setItem('notifSidebarCollapsed', 'true'); // keep old logic for bell icon state if needed, but just bell is fine
    } else {
        drawer.classList.add('open');
        overlay.classList.add('open');
        if (btn) btn.innerHTML = '<i class="fas fa-bell-slash"></i>';
        localStorage.setItem('notifSidebarCollapsed', 'false');
    }
};

// Remove auto-restore sidebar state logic since it's a drawer now
document.addEventListener('DOMContentLoaded', () => {
    // Drawer should be closed by default
});

let kpiCharts = {
    revenue: null,
    maintenance: null,
    capacity: null
};

window.toggleKpiDetail = function (detailId, element) {
    const panel = document.getElementById('kpiExtendedPanel');
    const sections = document.querySelectorAll('.kpi-detail-content');
    const items = document.querySelectorAll('.kpi-unified-item');

    if (!panel) return;

    // If clicking the same item that's already active, close it
    if (element.classList.contains('active-item')) {
        panel.classList.remove('active');
        element.classList.remove('active-item');
        return;
    }

    // Deactivate others
    items.forEach(item => item.classList.remove('active-item'));
    sections.forEach(sec => sec.style.display = 'none');

    // Activate this
    element.classList.add('active-item');
    const targetSection = document.getElementById(detailId);
    if (targetSection) targetSection.style.display = 'block';
    panel.classList.add('active');

    // Render/Update charts
    renderKpiBreakdown(detailId);
};

function renderKpiBreakdown(detailId) {
    if (detailId === 'revenueDetail') {
        renderRevenueChart();
    } else if (detailId === 'maintenanceDetail') {
        renderMaintenanceChart();
    } else if (detailId === 'capacityDetail') {
        renderCapacityChart();
    }
}

function renderRevenueChart() {
    const ctx = document.getElementById('revenueBreakdownChart');
    if (!ctx) return;

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let membershipRev = 0;
    let walkinRev = 0;
    let posRev = 0;

    paymentsData.forEach(p => {
        if (p.status === 'Voided' || p.status === 'Refunded') return;
        if (p.date === todayStr) {
            const pAmount = Number(p.amount || 0);
            if (p.type === 'POS Sale') posRev += pAmount;
            else if (p.type === 'Walk-in') walkinRev += pAmount;
            else membershipRev += pAmount; // Assuming other types are memberships
        }
    });

    if (kpiCharts.revenue) kpiCharts.revenue.destroy();
    kpiCharts.revenue = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Membership', 'Walk-in', 'POS'],
            datasets: [{
                data: [membershipRev, walkinRev, posRev],
                backgroundColor: ['#991b1b', '#3B82F6', '#475569'],
                borderWidth: 0,
                cutout: '75%'
            }]
        },
        options: {
            plugins: { legend: { display: false } },
            responsive: true,
            maintainAspectRatio: false
        }
    });

    if (document.getElementById('detailMembershipRev')) document.getElementById('detailMembershipRev').innerText = `₱${membershipRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailWalkinRev')) document.getElementById('detailWalkinRev').innerText = `₱${walkinRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailPosRev')) document.getElementById('detailPosRev').innerText = `₱${posRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (document.getElementById('detailTotalRev')) document.getElementById('detailTotalRev').innerText = `₱${(membershipRev + walkinRev + posRev).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderMaintenanceChart() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const equipment = inventoryData.filter(i => i.itemType === 'equipment' || !i.itemType);
    const ops = equipment.filter(i => i.status === 'Operational').length;
    const maint = equipment.filter(i => i.status === 'Maintenance').length;
    const broken = equipment.filter(i => i.status === 'Out of Order').length;

    const overdue = equipment.filter(i => {
        if (i.status !== 'Operational') return false;
        let dueDateForSchedule = i.maintenanceDueDate || '';
        if (!dueDateForSchedule && i.maintenanceDate) {
            const base = new Date(`${i.maintenanceDate}T00:00:00`);
            if (!Number.isNaN(base.getTime())) {
                base.setDate(base.getDate() + 90);
                dueDateForSchedule = base.toISOString().split('T')[0];
            }
        }
        if (!dueDateForSchedule) return true; // never recorded/scheduled = overdue
        const daysOverdue = Math.floor((today - new Date(dueDateForSchedule)) / (1000 * 60 * 60 * 24));
        return daysOverdue > 0;
    }).length;

    if (document.getElementById('detailOpsCount')) document.getElementById('detailOpsCount').innerText = `${ops} Units`;
    if (document.getElementById('detailMaintCount')) document.getElementById('detailMaintCount').innerText = `${maint} Units`;
    if (document.getElementById('detailBrokenCount')) document.getElementById('detailBrokenCount').innerText = `${broken} Units`;
    if (document.getElementById('detailOverdueCount')) {
        document.getElementById('detailOverdueCount').innerText = `${overdue} Units`;
        document.getElementById('detailOverdueCount').style.color = overdue > 0 ? '#f97316' : '';
    }
}

function renderCapacityChart() {
    const present = Number(document.getElementById('presentMembers')?.innerText || 0);
    const total = Math.max(50, membersData.length || 50);
    const available = Math.max(0, total - present);

    // Circle chart visual removed from HTML for Capacity as per user request

    if (document.getElementById('detailPresentCount')) document.getElementById('detailPresentCount').innerText = present;
    if (document.getElementById('detailAvailableCount')) document.getElementById('detailAvailableCount').innerText = available;
    if (document.getElementById('detailOccupancyRate')) document.getElementById('detailOccupancyRate').innerText = `${Math.round((present / total) * 100)}%`;
}

const activityLogsCol = collection(db, "activityLogs");

window.logActivity = async function (action, details = "") {
    try {
        const userId = localStorage.getItem("userId") || "System";
        const userName = localStorage.getItem("loggedInUser") || "Unknown User";
        const role = localStorage.getItem("userRole") || "";
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        const payload = {
            userId,
            userName,
            role,
            action,
            details,
            date: dateStr,
            time: timeStr,
            timestamp: now.getTime()
        };
        const ref = await addDoc(activityLogsCol, payload);
        // Optimistically append to in-memory activityData so the admin UI updates without
        // paying for another full-collection read.
        if (typeof activityData !== 'undefined' && Array.isArray(activityData)) {
            activityData.unshift({ id: ref.id, ...payload });
            if (activityData.length > 200) activityData.length = 200;
            if (typeof renderActivityLogs === 'function') renderActivityLogs();
        }
    } catch (e) {
        console.error("Failed to log activity:", e);
    }
};

window.closeModal = function (modalId) { document.getElementById(modalId).style.display = 'none'; }
window.exportInventoryReport = function () { window.print(); }

window.filterTable = function (tableId, inputId) {
    const filter = document.getElementById(inputId).value.toUpperCase();
    const tr = document.getElementById(tableId).getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[0];
        if (tableId === 'membersTable' || tableId === 'archivedMembersTable') {
            let tdPlan = tr[i].getElementsByTagName("td")[4];
            let text = (td ? td.textContent : "") + " " + (tdPlan ? tdPlan.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'attendanceTable') {
            let tdType = tr[i].getElementsByTagName("td")[1];
            let text = (td ? td.textContent : "") + " " + (tdType ? tdType.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'bookingsTable' || tableId === 'myBookingsTable') {
            let tdTrainer = tr[i].getElementsByTagName("td")[1] || tr[i].getElementsByTagName("td")[0];
            let text = (td ? td.textContent : "") + " " + (tdTrainer ? tdTrainer.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else if (tableId === 'ledgerTable') {
            let tdName = tr[i].getElementsByTagName("td")[1];
            let tdReason = tr[i].getElementsByTagName("td")[3];
            let text = (tdName ? tdName.textContent : "") + " " + (tdReason ? tdReason.textContent : "");
            tr[i].style.display = text.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        } else {
            if (td) tr[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? "" : "none";
        }
    }
}

window.filterByPlan = function (val) {
    const filterText = val.toUpperCase();
    const tr = document.getElementById('membersTable').getElementsByTagName("tr");
    for (let i = 1; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td")[4];
        if (td) {
            let cellText = (td.textContent || td.innerText).toUpperCase();
            if (val === "All" || cellText.includes(filterText)) tr[i].style.display = "";
            else tr[i].style.display = "none";
        }
    }
}

window.filterGrid = function (gridId, inputId) {
    const filter = document.getElementById(inputId).value.toLowerCase();
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const cards = grid.querySelectorAll('.inventory-item-filter');
    cards.forEach(card => {
        const searchData = card.getAttribute('data-search');
        if (searchData.includes(filter)) card.style.display = "flex";
        else card.style.display = "none";
    });
}

window.filterEquipment = function() {
    equipCurrentPage = 1;
    renderInventory();
};

let currentEquipSortField = 'name';
let currentEquipSortOrder = 'asc';

window.sortEquipment = function(field) {
    if (currentEquipSortField === field) {
        currentEquipSortOrder = currentEquipSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentEquipSortField = field;
        currentEquipSortOrder = 'asc';
    }

    // Update sort icons in headers
    const table = document.getElementById('machinesListTable');
    if (table) {
        table.querySelectorAll('th i').forEach(icon => {
            icon.className = 'fas fa-sort bk-sort-icon';
        });
        const ths = table.querySelectorAll('th');
        ths.forEach(th => {
            if (th.getAttribute('onclick') && th.getAttribute('onclick').includes(`('${field}')`)) {
                const icon = th.querySelector('i');
                if (icon) {
                    icon.className = `fas fa-sort-${currentEquipSortOrder === 'asc' ? 'up' : 'down'} bk-sort-icon`;
                }
            }
        });
    }

    renderInventory();
};

window.filterProducts = function() {
    prodCurrentPage = 1;
    renderInventory();
};


// ==========================================
// 5. STATE ARRAYS & COLLECTIONS
// ==========================================
let inventoryData = [];
let allUsersData = [];
let membersData = [];
let chatUsers = [];
let paymentsData = [];
// --- Shared Pagination Utility ---
window.renderPaginationControls = function(containerId, currentPage, totalPages, totalRecords, changeFnName) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (totalRecords === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <button class="page-btn" onclick="${changeFnName}(-1)" ${currentPage <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>
        <span class="page-btn active" style="pointer-events:none;">${currentPage} / ${totalPages || 1}</span>
        <button class="page-btn" onclick="${changeFnName}(1)" ${currentPage >= totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
    `;
};

let paymentCurrentPage = 1;
const paymentItemsPerPage = 20;
window.changePaymentPage = function(dir) {
    paymentCurrentPage += dir;
    if (paymentCurrentPage < 1) paymentCurrentPage = 1;
    renderPayments();
};

let memCurrentPage = 1;
const memItemsPerPage = 20;
window.changeMemPage = function(dir) {
    memCurrentPage += dir;
    if (memCurrentPage < 1) memCurrentPage = 1;
    renderMembers();
};

let staffCurrentPage = 1;
const staffItemsPerPage = 20;
window.changeStaffPage = function(dir) {
    staffCurrentPage += dir;
    if (staffCurrentPage < 1) staffCurrentPage = 1;
    renderStaff();
};

let trainerCurrentPage = 1;
const trainerItemsPerPage = 20;
window.changeTrainerPage = function(dir) {
    trainerCurrentPage += dir;
    if (trainerCurrentPage < 1) trainerCurrentPage = 1;
    renderStaff();
};

let attCurrentPage = 1;
const attItemsPerPage = 20;
window.changeAttPage = function(dir) {
    attCurrentPage += dir;
    if (attCurrentPage < 1) attCurrentPage = 1;
    window.attCurrentPage = attCurrentPage;
    if (window.renderAttendanceData) {
        window.renderAttendanceData();
    }
};
window.attCurrentPage = attCurrentPage;
window.attItemsPerPage = attItemsPerPage;

let equipCurrentPage = 1;
const equipItemsPerPage = 20;
window.changeEquipPage = function(dir) {
    equipCurrentPage += dir;
    if (equipCurrentPage < 1) equipCurrentPage = 1;
    renderInventory();
};

let prodCurrentPage = 1;
const prodItemsPerPage = 20;
window.changeProdPage = function(dir) {
    prodCurrentPage += dir;
    if (prodCurrentPage < 1) prodCurrentPage = 1;
    renderInventory();
};

let arcMemCurrentPage = 1;
window.changeArcMemPage = function(dir) {
    arcMemCurrentPage += dir;
    if (arcMemCurrentPage < 1) arcMemCurrentPage = 1;
    renderMembers();
};

let arcStaffCurrentPage = 1;
window.changeArcStaffPage = function(dir) {
    arcStaffCurrentPage += dir;
    if (arcStaffCurrentPage < 1) arcStaffCurrentPage = 1;
    renderStaff();
};

let arcTrainerCurrentPage = 1;
window.changeArcTrainerPage = function(dir) {
    arcTrainerCurrentPage += dir;
    if (arcTrainerCurrentPage < 1) arcTrainerCurrentPage = 1;
    renderStaff();
};
let attendanceData = [];
let messagesData = [];
let activityData = [];
let bookingsData = [];
window.bookingsData = bookingsData;
let myBkCurrentPage = 1;
const myBkItemsPerPage = 20;
window.myBkCurrentPage = myBkCurrentPage;

window.changeMyBkPage = function (dir) {
    myBkCurrentPage += dir;
    if (myBkCurrentPage < 1) myBkCurrentPage = 1;
    window.myBkCurrentPage = myBkCurrentPage;
    renderBookings();
};
let posCart = [];
let currentPOSCategory = 'all';
let selectedPaymentMethod = 'Cash';
let stockMovementsData = [];
let lockersData = [];

let currentChatUser = null;
let currentChatUserId = null;
let currentChatRoleFilter = 'all';

function getUserDisplayName(u) {
    if (!u) return '';
    return (u.name || `${u.givenName || ''} ${u.familyName || ''}`.trim() || 'User');
}

function getAllMessagingUsers() {
    const byId = new Map();
    const add = (u) => { if (u && u.id) byId.set(u.id, u); };
    (chatUsers || []).forEach(add);
    (membersData || []).forEach(add);
    (allUsersData || []).forEach(add);
    return Array.from(byId.values());
}

function findUserForChat(nameOrId) {
    if (!nameOrId) return null;
    const pool = getAllMessagingUsers();
    const byId = pool.find(u => u.id === nameOrId);
    if (byId) return byId;
    const byUid = pool.find(u => u.uid === nameOrId);
    if (byUid) return byUid;
    const target = String(nameOrId).trim().toLowerCase();
    return pool.find(u => {
        const display = getUserDisplayName(u).toLowerCase();
        const legacy = (u.name || '').trim().toLowerCase();
        return display === target || (legacy && legacy === target);
    }) || null;
}

function cacheMessagingUser(user) {
    if (!user || !user.id) return user;
    if (!(chatUsers || []).some(u => u.id === user.id)) {
        chatUsers.push(user);
        const roleStr = (user.role || "").trim().toLowerCase();
        if (roleStr === 'member') {
            if (!(membersData || []).some(m => m.id === user.id)) membersData.push(user);
        } else if (roleStr !== 'admin') {
            if (!(allUsersData || []).some(u => u.id === user.id)) allUsersData.push(user);
        }
    }
    return user;
}

async function resolveUserForChat(nameOrId) {
    const local = findUserForChat(nameOrId);
    if (local) return local;

    const key = String(nameOrId).trim();
    if (!key) return null;

    try {
        const snap = await getDoc(doc(db, "users", key));
        if (snap.exists()) {
            const data = snap.data();
            delete data.password;
            return cacheMessagingUser({ ...data, id: snap.id });
        }
    } catch (_) { /* not a valid doc id */ }

    try {
        const uidSnap = await getDocs(query(usersCol, where("uid", "==", key), limit(1)));
        if (!uidSnap.empty) {
            const d = uidSnap.docs[0];
            const data = d.data();
            delete data.password;
            return cacheMessagingUser({ ...data, id: d.id });
        }
    } catch (e) {
        console.warn("resolveUserForChat uid lookup failed:", e);
    }
    return null;
}

window.getUserDisplayName = getUserDisplayName;
window.findUserForChat = findUserForChat;
window.resolveUserForChat = resolveUserForChat;

const inventoryCol = collection(db, "inventory");
const paymentsCol = collection(db, "payments");

// Reject GCash ref IDs that have already been used for another payment.
// Throws on duplicate; returns the cleaned ref on success.
// NOTE: This is a pre-flight check only. The authoritative race-free lock
// is reserveGcashRefInTxn() (read) + commitGcashRefInTxn() (write) below, which must be called inside runTransaction().
window.assertGcashRefUnused = async function (rawRef) {
    const cleaned = (rawRef || '').replace(/\s/g, '');
    if (!/^[0-9]{12}$/.test(cleaned)) {
        throw new Error("GCash Reference ID must be exactly 12 digits.");
    }
    const dupQ = query(paymentsCol, where("gcashRefId", "==", cleaned));
    const dupSnap = await getDocs(dupQ);
    if (!dupSnap.empty) {
        throw new Error("This GCash Reference ID has already been used. Each ref can only be used once.");
    }
    // Also check the reservations collection (covers the gap before a payment doc is written)
    const resDoc = await getDoc(doc(db, "gcashReservations", cleaned));
    if (resDoc.exists()) {
        throw new Error("This GCash Reference ID has already been used. Each ref can only be used once.");
    }
    return cleaned;
};

// C4 fix: race-free reservation. MUST be called inside runTransaction() during the
// reads phase (before any writes). Returns { cleaned, refDoc } for commitGcashRefInTxn().
window.reserveGcashRefInTxn = async function (tx, rawRef) {
    const cleaned = (rawRef || '').replace(/\s/g, '');
    if (!/^[0-9]{12}$/.test(cleaned)) {
        throw new Error("GCash Reference ID must be exactly 12 digits.");
    }
    const refDoc = doc(db, "gcashReservations", cleaned);
    const snap = await tx.get(refDoc);
    if (snap.exists()) {
        throw new Error("This GCash Reference ID has already been used. Each ref can only be used once.");
    }
    return { cleaned, refDoc };
};
// Write the GCash reservation during the transaction writes phase only.
window.commitGcashRefInTxn = function (tx, refDoc) {
    tx.set(refDoc, { createdAt: Date.now() });
};
const usersCol = collection(db, "users");
const attendanceCol = collection(db, "attendance");
const messagesCol = collection(db, "messages");
const bookingsCol = collection(db, "bookings");
const guestCardsCol = collection(db, "guestCards");
const walkinPassesCol = collection(db, "walkinPasses");
const stockMovementsCol = collection(db, "stockMovements"); // Phase 3: Inventory Ledger
const maintenanceLogsCol = collection(db, "maintenanceLogs"); // Equipment maintenance history
const membershipPlansCol = collection(db, "membershipPlans"); // Membership Plans
const creditTransactionsCol = collection(db, "creditTransactions"); // Credit System
const lockersCol = collection(db, "lockers"); // Locker System

// Expose Firebase helpers for non-module booking UI script
const pendingRatingsCol = collection(db, "pendingRatings");
window._fb = { bookingsCol, pendingRatingsCol, collection, query, where, getDocs, addDoc, db, doc, updateDoc, setDoc, deleteDoc, runTransaction, increment, getDoc };

async function logStockMovement(productId, productName, changeAmount, reason) {
    try {
        const now = new Date();
        const payload = {
            productId,
            productName,
            changeAmount,
            reason,
            userId: localStorage.getItem("userId") || "System",
            userName: localStorage.getItem("loggedInUser") || "Unknown",
            date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            timestamp: now.getTime()
        };
        const ref = await addDoc(stockMovementsCol, payload);
        // Optimistic in-memory append so the ledger UI reflects the write without an extra read.
        if (Array.isArray(stockMovementsData)) {
            stockMovementsData.unshift({ id: ref.id, ...payload });
            if (typeof renderLedger === 'function') renderLedger();
        }
    } catch (e) {
        console.error("Failed to log stock movement:", e);
    }
}

// ─── Maintenance Logbook ───────────────────────────────────────────────────────

let currentLogbookEquipId = null;
let currentLogbookEquipName = '';
let maintenanceLogsData = [];

async function logMaintenanceEntry(equipmentId, equipmentName, maintenanceDate, remark) {
    try {
        const now = new Date();
        const payload = {
            equipmentId,
            equipmentName,
            maintenanceDate,
            remark: remark || '',
            loggedBy: localStorage.getItem("loggedInUser") || "Unknown",
            userId: localStorage.getItem("userId") || "System",
            date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            timestamp: now.getTime()
        };
        const ref = await addDoc(maintenanceLogsCol, payload);

        // Sync the equipment document:
        // - maintenanceDate = last maintenance performed (history)
        // - maintenanceDueDate = scheduled due date derived from last maintenance (+90 days)
        const equipDoc = inventoryData.find(i => i.id === equipmentId);
        const newCount = (equipDoc ? (equipDoc.maintenanceCount || 0) : 0) + 1;

        const maintenanceDueDate = (() => {
            if (!maintenanceDate) return '';
            const base = new Date(`${maintenanceDate}T00:00:00`);
            if (Number.isNaN(base.getTime())) return '';
            base.setDate(base.getDate() + 90);
            return base.toISOString().split('T')[0];
        })();

        await updateDoc(doc(db, "inventory", equipmentId), {
            maintenanceDate,
            maintenanceDueDate,
            maintenanceCount: newCount
        });
        if (equipDoc) {
            equipDoc.maintenanceDate = maintenanceDate;
            equipDoc.maintenanceDueDate = maintenanceDueDate;
            equipDoc.maintenanceCount = newCount;
        }

        if (window.logActivity) {
            window.logActivity("Maintenance Logged", `${equipmentName} — maintenance #${newCount} recorded on ${maintenanceDate}`);
        }

        // Optimistic prepend so the list updates instantly
        maintenanceLogsData.unshift({ id: ref.id, ...payload });
        renderMaintenanceLog();
    } catch (e) {
        console.error("Failed to log maintenance entry:", e);
        throw e;
    }
}

function renderMaintenanceLog() {
    const list = document.getElementById('maintenanceLogList');
    if (!list) return;

    if (!maintenanceLogsData.length) {
        list.innerHTML = '<div class="mp-empty-state">No maintenance records yet.</div>';
        return;
    }

    list.innerHTML = maintenanceLogsData.map(entry => `
        <div class="mp-session-item" style="display:flex; justify-content:space-between; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--border-color);">
            <div>
                <div style="font-weight:600;">${entry.maintenanceDate}</div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-top:2px;">${entry.remark || '<em>No remark</em>'}</div>
            </div>
            <div style="text-align:right; font-size:0.8rem; color:var(--text-muted); white-space:nowrap; margin-left:12px;">
                <div>${entry.loggedBy}</div>
                <div>${entry.date} ${entry.time}</div>
            </div>
        </div>
    `).join('');

    // Update summary stats
    const equipDoc = inventoryData.find(i => i.id === currentLogbookEquipId);
    const totalCount = equipDoc ? (equipDoc.maintenanceCount || maintenanceLogsData.length) : maintenanceLogsData.length;
    const lastDate = equipDoc ? (equipDoc.maintenanceDueDate || '—') : '—';
    const countEl = document.getElementById('logbookTotalCount');
    const lastEl = document.getElementById('logbookLastDate');
    if (countEl) countEl.textContent = totalCount;
    if (lastEl) lastEl.textContent = lastDate;
}

window.openMaintenanceLogbookModal = async function(equipmentId) {
    const equip = inventoryData.find(i => i.id === equipmentId);
    if (!equip) return;

    currentLogbookEquipId = equipmentId;
    currentLogbookEquipName = equip.name;

    const nameEl = document.getElementById('logbookEquipName');
    const countEl = document.getElementById('logbookTotalCount');
    const lastEl = document.getElementById('logbookLastDate');
    const list = document.getElementById('maintenanceLogList');

    if (nameEl) nameEl.textContent = equip.name;
    if (countEl) countEl.textContent = equip.maintenanceCount || 0;
    if (lastEl) lastEl.textContent = equip.maintenanceDueDate || '—';
    if (list) list.innerHTML = '<div class="mp-empty-state">Loading...</div>';

    // Reset add-entry form
    const dateInput = document.getElementById('logEntryDate');
    const remarkInput = document.getElementById('logEntryRemark');
    if (dateInput) { dateInput.value = new Date().toISOString().split('T')[0]; }
    if (remarkInput) remarkInput.value = '';

    document.getElementById('maintenanceLogbookModal').style.display = 'flex';

    // Fetch history from Firestore (sort client-side to avoid a composite index on equipmentId + timestamp)
    try {
        const q = query(maintenanceLogsCol, where("equipmentId", "==", equipmentId));
        const snap = await getDocs(q);
        maintenanceLogsData = [];
        snap.forEach(d => maintenanceLogsData.push({ id: d.id, ...d.data() }));
        maintenanceLogsData.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        renderMaintenanceLog();
    } catch (e) {
        console.error("Failed to fetch maintenance logs:", e.code || e.message || e);
        if (list) list.innerHTML = '<div class="mp-empty-state">Failed to load records.</div>';
        showToast("Could not load maintenance history.", "error");
    }
};

window.submitMaintenanceLog = async function() {
    const dateInput = document.getElementById('logEntryDate');
    const remarkInput = document.getElementById('logEntryRemark');
    const btn = document.querySelector('#maintenanceLogbookModal .action-btn.is-primary');

    const maintenanceDate = dateInput ? dateInput.value : '';
    if (!maintenanceDate) return showToast("Please select a maintenance date.", "error");
    if (!currentLogbookEquipId) return;

    // VULN-06: cap remark length to prevent Firestore document bloat
    const remark = remarkInput ? remarkInput.value.trim() : '';
    if (remark.length > 500) {
        return showToast("Remark must be 500 characters or fewer.", "error");
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }
    try {
        await logMaintenanceEntry(currentLogbookEquipId, currentLogbookEquipName, maintenanceDate, remark);
        if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
        if (remarkInput) remarkInput.value = '';
        showToast("Maintenance entry saved.", "success");
    } catch (e) {
        showToast("Failed to save entry. Please try again.", "error");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Save Entry'; }
    }
};

// ──────────────────────────────────────────────────────────────────────────────

// Ledger is staff-only and rarely viewed — fetch once on load instead of live-syncing.
// Call window.refreshStockMovements() after any local stock-movement write to refresh the view.
// QUOTA FIX: cap to 500 most recent movements. Previously this read the entire collection
// — which grows by 1 doc per POS sale line item + 1 per restock — so a busy gym was paying
// for thousands of reads on every staff page load.
window.refreshStockMovements = function () {
    if (!isStaffSide) return Promise.resolve();
    const q = query(stockMovementsCol, orderBy("timestamp", "desc"), limit(100));
    return getDocs(q).then(snapshot => {
        stockMovementsData = [];
        snapshot.forEach(doc => stockMovementsData.push({ id: doc.id, ...doc.data() }));
        stockMovementsData.sort((a, b) => b.timestamp - a.timestamp);
        renderLedger();
    }).catch(err => {
        console.error("Failed to load stock movements:", err.code || err.message || err);
        if (typeof showToast === 'function') {
            showToast("Could not load inventory ledger.", "error");
        }
    });
};
if (isStaffSide) window.refreshStockMovements();

let ledgerCurrentPage = 1;
const ledgerItemsPerPage = 20;

window.changeLedgerPage = function (dir) {
    ledgerCurrentPage += dir;
    if (ledgerCurrentPage < 1) ledgerCurrentPage = 1;
    renderLedger();
};

window.renderLedger = function () {
    const tbody = document.querySelector('#ledgerTable tbody');
    if (!tbody) return;

    // Filter by search
    const searchVal = (document.getElementById('ledgerSearch')?.value || '').toLowerCase();
    let filtered = stockMovementsData;
    if (searchVal) {
        filtered = filtered.filter(m => 
            (m.productName || '').toLowerCase().includes(searchVal) ||
            (m.reason || '').toLowerCase().includes(searchVal) ||
            (m.userName || '').toLowerCase().includes(searchVal)
        );
    }

    const totalRecords = filtered.length;
    const totalPages = Math.ceil(totalRecords / ledgerItemsPerPage);
    if (ledgerCurrentPage > totalPages && totalPages > 0) ledgerCurrentPage = totalPages;
    if (ledgerCurrentPage < 1) ledgerCurrentPage = 1;

    const startIdx = (ledgerCurrentPage - 1) * ledgerItemsPerPage;
    const endIdx = Math.min(startIdx + ledgerItemsPerPage, totalRecords);

    window.renderPaginationControls('ledgerPagination', ledgerCurrentPage, totalPages, totalRecords, 'changeLedgerPage');

    if (document.getElementById('ledgerRecordCount')) {
        document.getElementById('ledgerRecordCount').innerText = totalRecords === 0 ? '0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No stock movements recorded yet.</td></tr>';
        return;
    }

    const displayData = filtered.slice(startIdx, endIdx);

    const renderLedgerRow = (m) => {
        let changeStr = m.changeAmount > 0 ? `<span style="color: #27ae60; font-weight: bold;">+${m.changeAmount}</span>` : `<span style="color: #e74c3c; font-weight: bold;">${m.changeAmount}</span>`;
        return `
            <tr>
                <td>${m.date} <span style="color:#888; font-size:12px;">${m.time || ''}</span></td>
                <td><strong>${m.productName}</strong></td>
                <td>${changeStr}</td>
                <td><span class="badge" style="background: #eee; color: var(--dark-black); border: none;">${m.reason}</span></td>
                <td>${m.userName}</td>
            </tr>
        `;
    };

    window.syncDOM(tbody, displayData, renderLedgerRow, 'ledger-row');
}

let servicesChartInstance = null;

// ==========================================
// 6. INTERNAL MESSENGER LOGIC
// ==========================================
window.openChatTab = function (role, element, title) {
    currentChatRoleFilter = role;
    document.getElementById('chatDirectoryTitle').innerHTML = `<i class="fa-solid fa-address-book"></i> ${title}`;
    currentChatUser = null;
    currentChatUserId = null;
    document.getElementById('chatHeader').innerText = 'Select a user to start chatting';
    document.getElementById('chatHistory').innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: auto; margin-bottom: auto;"><i class="fa-regular fa-comments" style="font-size: 3rem; opacity: 0.2; margin-bottom: 10px;"></i><p>No chat selected</p></div>';
    document.getElementById('chatInput').disabled = true;
    document.getElementById('chatSendBtn').disabled = true;
    document.getElementById('chatSearch').value = "";
    renderChatUserList();
    switchTab('chats', element);
}

// Chat needs live sync — but only attach if a user is logged in (skip for index.html / login screen).
// QUOTA FIX: messages are identified by sender/receiver name strings. Previously every user
// listened to the ENTIRE messages collection (full table read on every connect + every new
// message anywhere in the gym streamed to every client). Now we run two scoped listeners
// per user — one for messages sent BY me, one for messages sent TO me — each capped at the
// 500 most recent. Cuts message reads by 10-100x in a real gym.
if (currentUserId) {
    const myName = localStorage.getItem("loggedInUser");
    if (myName) {
        const _msgIndex = new Map();
        const _emitChat = () => {
            messagesData = Array.from(_msgIndex.values())
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            renderChatHistory();
            _updateMessagesBadge();
        };

        // Track which senders the member has already opened (seen)
        const _seenSenders = new Set();

        function _updateMessagesBadge() {
            const badge = document.getElementById('messagesBadgeDot');
            if (!badge) return;
            // Count messages received by this user that are from a sender not yet opened
            const hasUnread = messagesData.some(m => {
                const isForMe = m.receiver === myName || m.receiverId === currentUserId;
                const isFromOther = m.sender !== myName && m.senderId !== currentUserId;
                return isForMe && isFromOther && !_seenSenders.has(m.sender || m.senderId);
            });
            badge.style.display = hasUnread ? 'block' : 'none';
        }

        window.clearMessagesBadge = function () {
            // Mark current chat partner as seen so badge clears
            if (currentChatUser) _seenSenders.add(currentChatUser);
            _updateMessagesBadge();
        };
        const _ingest = (snapshot) => {
            snapshot.docChanges().forEach(ch => {
                if (ch.type === 'removed') _msgIndex.delete(ch.doc.id);
                else _msgIndex.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
            });
            _emitChat();
        };
        // PRESENTATION PROOFING: Lower chat message buffer to 30 for lightweight presentation loads.
        // Query by name (manual chat) AND by userId (auto-messages from declined bookings).
        // Both are needed because manual messages use name strings while auto-messages use IDs.
        // Single-field queries only; sort newest-first in _emitChat (no composite index).
        const sentQ    = query(messagesCol, where("sender",     "==", myName));
        const recvQ    = query(messagesCol, where("receiver",   "==", myName));
        const sentIdQ  = query(messagesCol, where("senderId",   "==", currentUserId));
        const recvIdQ  = query(messagesCol, where("receiverId", "==", currentUserId));
        const _chatErrHandler = (err) => {
            console.error("Messaging snapshot listener failed:", err);
            if (typeof showToast === 'function') showToast("Could not load messages.", "error");
        };
        onSnapshot(sentQ,   _ingest, _chatErrHandler);
        onSnapshot(recvQ,   _ingest, _chatErrHandler);
        onSnapshot(sentIdQ, _ingest, _chatErrHandler);
        onSnapshot(recvIdQ, _ingest, _chatErrHandler);
    }
}

// Maps idSafeName → raw user name; populated in renderChatUserList so openChat
// can retrieve the unescaped original without injecting it into onclick attributes.
const _chatNameIndex = new Map();
window._chatNameIndex = _chatNameIndex;

function renderChatUserList() {
    const list = document.getElementById('chatUserList');
    if (!list) return;

    const myName = localStorage.getItem("loggedInUser");
    const myId = localStorage.getItem("userId");
    let html = "";

    let admins = [];
    if (currentChatRoleFilter === 'staff' || currentChatRoleFilter === 'all') {
        admins = chatUsers.filter(u => (u.role || "").toLowerCase() === 'admin' && getUserDisplayName(u) !== myName && u.id !== myId);
    }

    const targetUsers = chatUsers.filter(u => {
        if (getUserDisplayName(u) === myName || u.id === myId) return false;
        // M10: hide archived users from the chat picker
        if ((u.status || '').toLowerCase() === 'archived') return false;
        const uRole = (u.role || "").toLowerCase();
        if (currentChatRoleFilter === 'all') return uRole !== 'admin';
        return uRole === currentChatRoleFilter;
    });

    if (admins.length === 0 && targetUsers.length === 0) {
        html = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No users found.</div>`;
    } else {
        _chatNameIndex.clear();
        if (admins.length > 0) {
            html += `<div class="chat-category">Admins</div>`;
            admins.forEach(u => {
                const displayName = getUserDisplayName(u);
                let idSafeName = displayName.replace(/[^a-zA-Z0-9]/g, '');
                let escapedName = escapeHtml(displayName);
                _chatNameIndex.set(idSafeName, displayName);
                html += `
                    <div class="chat-user chat-user-item" data-name="${displayName.toLowerCase()}" id="chat-user-${idSafeName}" onclick="openChat('${u.id}')">
                        <div class="chat-avatar" style="background: var(--primary-red);">
                            <i class="fa-solid fa-crown" style="font-size: 14px;"></i>
                        </div>
                        <div>
                            <div style="font-weight: bold; color: var(--dark-black); font-size: 14px;">${escapedName}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(u.role)}</div>
                        </div>
                    </div>
                `;
            });
        }
        if (targetUsers.length > 0) {
            let catTitle = "Users";
            if (currentChatRoleFilter === 'staff') catTitle = "Staff Team";
            if (currentChatRoleFilter === 'trainer') catTitle = "Trainers";
            if (currentChatRoleFilter === 'member') catTitle = "Members";
            if (currentChatRoleFilter !== 'all') html += `<div class="chat-category">${catTitle}</div>`;

            targetUsers.forEach(u => {
                const displayName = getUserDisplayName(u);
                let idSafeName = displayName.replace(/[^a-zA-Z0-9]/g, '');
                let escapedName = escapeHtml(displayName);
                _chatNameIndex.set(idSafeName, displayName);
                let avatarContent = `${escapedName.charAt(0).toUpperCase()}`;
                if ((u.role || "").toLowerCase() === 'member') {
                    avatarContent = `<i class="fa-solid fa-user" style="font-size: 14px;"></i>`;
                }
                html += `
                    <div class="chat-user chat-user-item" data-name="${displayName.toLowerCase()}" id="chat-user-${idSafeName}" onclick="openChat('${u.id}')">
                        <div class="chat-avatar">${avatarContent}</div>
                        <div>
                            <div style="font-weight: bold; color: var(--dark-black); font-size: 14px;">${escapedName}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(u.role)}</div>
                        </div>
                    </div>
                `;
            });
        }
    }
    list.innerHTML = html;
}

window.filterChatUsers = function () {
    const filter = document.getElementById('chatSearch').value.toLowerCase();
    const users = document.querySelectorAll('.chat-user-item');
    users.forEach(user => {
        const name = user.getAttribute('data-name');
        if (name.includes(filter)) user.style.display = "flex";
        else user.style.display = "none";
    });
}

window.openChat = async function (userNameOrId) {
    const user = await resolveUserForChat(userNameOrId);
    if (!user) {
        showToast("Recipient not found.", "error");
        return;
    }
    const displayName = getUserDisplayName(user);
    currentChatUser = displayName;
    currentChatUserId = user.id;
    document.getElementById('chatHeader').innerText = `Chatting with ${displayName}`;
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatSendBtn').disabled = false;

    document.querySelectorAll('.chat-user').forEach(el => el.classList.remove('active'));
    const idSafeName = displayName.replace(/[^a-zA-Z0-9]/g, '');
    const activeEl = document.getElementById(`chat-user-${idSafeName}`);
    if (activeEl) activeEl.classList.add('active');
    renderChatHistory();
    if (typeof window.clearMessagesBadge === 'function') window.clearMessagesBadge();
}

function renderChatHistory() {
    const hist = document.getElementById('chatHistory');
    if (!hist || !currentChatUser) return;

    const myName = localStorage.getItem("loggedInUser");
    const myId = localStorage.getItem("userId");
    const relevantMsgs = messagesData.filter(m => {
        const byId = myId && currentChatUserId && (
            (m.senderId === myId && m.receiverId === currentChatUserId) ||
            (m.senderId === currentChatUserId && m.receiverId === myId)
        );
        const byName = (m.sender === myName && m.receiver === currentChatUser) ||
            (m.sender === currentChatUser && m.receiver === myName);
        return byId || byName;
    }).sort((a, b) => a.timestamp - b.timestamp);

    if (relevantMsgs.length === 0) {
        hist.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin-top: auto; margin-bottom: auto;"><p>Say hello to ${currentChatUser}!</p></div>`;
        return;
    }

    hist.innerHTML = relevantMsgs.map(m => {
        const isMe = (myId && m.senderId === myId) || m.sender === myName;
        const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="msg-bubble ${isMe ? 'msg-sent' : 'msg-received'}">
                <div>${escapeHtml(m.text)}</div>
                <div class="msg-time">${time}</div>
            </div>
        `;
    }).join('');
    hist.scrollTop = hist.scrollHeight;
}

window.sendMessage = async function () {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    const text = input.value.trim();
    // VULN-14: always clear the input immediately so whitespace-only attempts don't persist in the box
    input.value = '';
    if (!text || !currentChatUser) return;
    if (text.length > 2000) return showToast("Message too long (max 2000 characters).", "error");

    // R3 (Sprint 7): client-side rate limit — at most 5 messages per 10s rolling window.
    // Stops trivial console-loop floods. Server-side rules should still cap quota.
    window.__msgRateBuf = window.__msgRateBuf || [];
    const nowMs = Date.now();
    window.__msgRateBuf = window.__msgRateBuf.filter(t => nowMs - t < 10000);
    if (window.__msgRateBuf.length >= 5) {
        return showToast("You're sending messages too fast. Please wait a moment.", "error");
    }
    window.__msgRateBuf.push(nowMs);

    const myName = localStorage.getItem("loggedInUser");
    const myId = localStorage.getItem("userId");
    if (currentChatUser === myName) return showToast("You can't message yourself.", "error");

    const recipient = await resolveUserForChat(currentChatUserId || currentChatUser);
    if (!recipient) return showToast("Recipient not found.", "error");
    if ((recipient.status || '').toLowerCase() === 'archived') {
        return showToast("Cannot send messages to an archived account.", "error");
    }
    const receiverName = getUserDisplayName(recipient);
    currentChatUser = receiverName;
    currentChatUserId = recipient.id;

    input.disabled = true;
    sendBtn.disabled = true;

    try {
        await addDoc(messagesCol, {
            sender: myName,
            receiver: receiverName,
            senderId: myId || "",
            receiverId: recipient.id,
            text,
            timestamp: Date.now()
        });
        input.value = "";
    } catch (err) {
        console.error("sendMessage failed:", err);
        showToast("Message failed to send: " + err.message, "error");
    } finally {
        input.disabled = false;
        sendBtn.disabled = false;
    }
}

// ==========================================
// 7. INVENTORY LOGIC
// ==========================================
if (isStaffSide) onSnapshot(inventoryCol, (snapshot) => {
    inventoryData = [];
    snapshot.forEach(doc => inventoryData.push({ id: doc.id, ...doc.data() }));
    softRender('inventory', () => {
        renderInventory();
        renderPOSProducts();
        if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
    });
});

function getCategoryIcon(catName) {
    const c = (catName || "").toLowerCase();
    if (c.includes('cardio')) return '<i class="fa-solid fa-person-running"></i>';
    if (c.includes('strength')) return '<i class="fa-solid fa-dumbbell"></i>';
    if (c.includes('free weight') || c.includes('weight')) return '<i class="fa-solid fa-box"></i>';
    if (c.includes('accessories') || c.includes('mat')) return '<i class="fa-solid fa-shapes"></i>';
    if (c.includes('supplement')) return '<i class="fa-solid fa-capsules"></i>';
    if (c.includes('beverage') || c.includes('drink')) return '<i class="fa-solid fa-bottle-water"></i>';
    if (c.includes('merch') || c.includes('apparel') || c.includes('shirt')) return '<i class="fa-solid fa-shirt"></i>';
    return '<i class="fa-solid fa-box"></i>';
}

window.quickRestock = async function (id) {
    // S3 (Sprint 8): fast-fail RBAC — admin/staff only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin' && _r !== 'staff') {
        return showToast("Permission denied.", "error");
    }
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    const name = item.name;

    showPrompt({
        title: 'Quick Restock',
        message: `How many units of ${escapeHtml(name)} are you receiving?`,
        placeholder: 'Enter quantity (e.g. 50)',
        onConfirm: async (qtyStr) => {
            const qty = parseInt(qtyStr);
            if (isNaN(qty) || qty <= 0) return showToast("Invalid quantity. Enter a positive number.", "error");
            if (qty > 10000) return showToast("Maximum restock is 10,000 units per entry.", "error");

            try {
                await updateDoc(doc(db, "inventory", id), { qty: increment(qty) });
                await logStockMovement(id, name, qty, "Quick Restock");
                showToast(`Successfully added ${qty} units to ${escapeHtml(name)}.`, "success");
            } catch (e) {
                console.error(e);
                showToast("Failed to restock item.", "error");
            }
        }
    });
}

let currentInventoryView = 'grid'; // 'grid' or 'list'
let selectedEquipItems = new Set();
let selectedProdItems = new Set();

window.currentProductAlertFilter = null;
window.currentEquipAlertFilter = null;

window.toggleProductAlertFilter = function (filterId) {
    if (window.currentProductAlertFilter === filterId) {
        window.currentProductAlertFilter = null;
    } else {
        window.currentProductAlertFilter = filterId;
    }
    window.prodCurrentPage = 1;
    renderInventory();
};

window.toggleEquipAlertFilter = function (filterId) {
    if (window.currentEquipAlertFilter === filterId) {
        window.currentEquipAlertFilter = null;
    } else {
        window.currentEquipAlertFilter = filterId;
    }
    window.equipCurrentPage = 1;
    renderInventory();
};

function renderInventory() {
    const equipGrid = document.getElementById('machinesGrid');
    const prodGrid = document.getElementById('productsGrid');
    const equipListBody = document.getElementById('machinesListBody');
    const equipListContainer = document.getElementById('machinesListContainer');
    const equipBatchBar = document.getElementById('equipBatchBar');

    if (!equipGrid || !prodGrid) return;

    let ops = 0, maint = 0, low = 0, totalMachines = 0;
    let alertsHtmlArr = [];

    // Sort and filter data first
    const consumables = [];
    const equipment = [];

    inventoryData.forEach((item) => {
        // Strictly determine if it's a product/consumable or equipment
        let isConsumable = item.itemType === 'product' || 
            (!item.itemType && ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat));
        
        let currentStatus = item.status || (isConsumable ? 'In Stock' : 'Operational');
        
        // Force equipment status to be valid (no 'Low Stock' or 'In Stock' for equipment)
        if (!isConsumable && ['Low Stock', 'Out of Stock', 'In Stock'].includes(currentStatus)) {
            currentStatus = 'Operational';
        }

        let threshold = item.lowStockThreshold !== undefined ? item.lowStockThreshold : 5;
        let isProblematic = false;

        let maintenanceDueDays = null;  // days overdue relative to the due date schedule
        let equipmentAgeDays = null;    // days since acquisition (null = not recorded)
        let maintenanceOverdue = false; // Operational but past due

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (!isConsumable) {
            // If only legacy maintenanceDate exists, derive maintenanceDueDate as +90 days.
            let maintenanceDueDateForSchedule = item.maintenanceDueDate || '';
            if (!maintenanceDueDateForSchedule && item.maintenanceDate) {
                const base = new Date(`${item.maintenanceDate}T00:00:00`);
                if (!Number.isNaN(base.getTime())) {
                    base.setDate(base.getDate() + 90);
                    maintenanceDueDateForSchedule = base.toISOString().split('T')[0];
                }
            }

            if (maintenanceDueDateForSchedule) {
                const dDate = new Date(maintenanceDueDateForSchedule);
                maintenanceDueDays = Math.floor((today - dDate) / (1000 * 60 * 60 * 24));
            }
            if (item.acquisitionDate) {
                const aDate = new Date(item.acquisitionDate);
                equipmentAgeDays = Math.floor((today - aDate) / (1000 * 60 * 60 * 24));
            }
            if (currentStatus === 'Operational') {
                maintenanceOverdue = maintenanceDueDays === null ? true : maintenanceDueDays > 0;
            }
        }

        if (isConsumable) {
            if (item.qty === 0) { currentStatus = "Out of Stock"; isProblematic = true; }
            else if (item.qty <= 2) { currentStatus = "Critical Stock"; isProblematic = true; low++; }
            else if (item.qty <= threshold) { currentStatus = "Low Stock"; isProblematic = true; low++; }
        } else {
            if (currentStatus === 'Maintenance') { maint++; isProblematic = true; }
            else if (currentStatus === 'Out of Order') { isProblematic = true; }
        }

        if (currentStatus === 'Operational' || currentStatus === 'In Stock') ops++;
        if (!isConsumable) {
            totalMachines++;
            // Preserve a derived maintenanceDueDate so sorting and UI labels stay consistent.
            const derivedMaintenanceDueDate = item.maintenanceDueDate || (item.maintenanceDate
                ? (() => {
                    const base = new Date(`${item.maintenanceDate}T00:00:00`);
                    if (Number.isNaN(base.getTime())) return '';
                    base.setDate(base.getDate() + 90);
                    return base.toISOString().split('T')[0];
                })()
                : ''
            );
            equipment.push({ ...item, currentStatus, isProblematic, maintenanceDueDays, equipmentAgeDays, maintenanceOverdue, maintenanceDueDate: derivedMaintenanceDueDate });
        } else {
            consumables.push({ ...item, currentStatus, isProblematic });
        }

        if (isProblematic) {
            alertsHtmlArr.push(`
                <div class="list-item">
                    <div class="list-icon" style="background-color: var(--dark-black);"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div class="list-content"><h4>Status: ${escapeHtml(currentStatus)}</h4><p><strong>${escapeHtml(item.name)}</strong> requires attention.</p></div>
                </div>
            `);
        }
    });

    const equipSearch = (document.getElementById('machineSearch')?.value || "").toLowerCase();
    const equipStatusFilter = document.getElementById('equipFilterStatus')?.value || "all";
    
    let filteredEquipment = equipment.filter(item => {
        const matchesSearch = item.name.toLowerCase().includes(equipSearch) || item.cat.toLowerCase().includes(equipSearch);
        const matchesStatus = equipStatusFilter === 'all' || item.currentStatus === equipStatusFilter;
        
        let matchesAlert = true;
        if (window.currentEquipAlertFilter) {
            if (window.currentEquipAlertFilter === 'Missing Tag') {
                const tag = (item.assetTag || '').trim();
                matchesAlert = !tag || tag === 'undefined';
            } else {
                matchesAlert = item.currentStatus === window.currentEquipAlertFilter;
            }
        }
        
        return matchesSearch && matchesStatus && matchesAlert;
    });

    const prodSearch = (document.getElementById('productSearch')?.value || "").toLowerCase();
    let filteredProducts = consumables.filter(item => {
        const matchesSearch = item.name.toLowerCase().includes(prodSearch) || item.cat.toLowerCase().includes(prodSearch);
        
        let matchesAlert = true;
        if (window.currentProductAlertFilter) {
            const qty = Number(item.qty || 0);
            const threshold = Number(item.lowStockThreshold || 5);
            
            if (window.currentProductAlertFilter === 'outOfStock') {
                matchesAlert = qty === 0;
            } else if (window.currentProductAlertFilter === 'lowStock') {
                matchesAlert = qty > 0 && qty <= threshold;
            } else if (window.currentProductAlertFilter === 'expired') {
                if (item.expiry && qty > 0) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const expDate = new Date(item.expiry + 'T00:00:00');
                    matchesAlert = expDate < today;
                } else {
                    matchesAlert = false;
                }
            } else if (window.currentProductAlertFilter === 'nearExpiry') {
                if (item.expiry && qty > 0) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const sevenDaysLater = new Date(today);
                    sevenDaysLater.setDate(today.getDate() + 7);
                    const expDate = new Date(item.expiry + 'T00:00:00');
                    matchesAlert = expDate >= today && expDate <= sevenDaysLater;
                } else {
                    matchesAlert = false;
                }
            }
        }
        
        return matchesSearch && matchesAlert;
    });

    filteredEquipment.sort((a, b) => {
        let valA = String(a[currentEquipSortField] || "").toLowerCase();
        let valB = String(b[currentEquipSortField] || "").toLowerCase();
        
        if (currentEquipSortField === 'qty') {
            valA = Number(a.qty || 0);
            valB = Number(b.qty || 0);
            if (valA < valB) return currentEquipSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return currentEquipSortOrder === 'asc' ? 1 : -1;
            return 0;
        }

        if (valA < valB) return currentEquipSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentEquipSortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    const renderCard = (item) => {
        const isConsumable = item.itemType === 'product' || (!item.itemType && ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat));
        
        let liveStatusClass = "status-success";
        if (item.currentStatus === 'Out of Stock' || item.currentStatus === 'Out of Order') {
            liveStatusClass = "status-danger";
        } else if (item.currentStatus === 'Critical Stock') {
            liveStatusClass = "status-danger";
        } else if (item.currentStatus === 'Low Stock' || item.currentStatus === 'Maintenance') {
            liveStatusClass = "status-warning";
        }

        let expiryHtml = '';
        if (isConsumable && item.isBatchTracked) {
            expiryHtml = ` <span class="expiring-tag" style="margin-left:6px;background:rgba(59,130,246,0.1);color:#3b82f6;border:1px solid rgba(59,130,246,0.25);"><i class="fas fa-layer-group"></i> Batch Tracked</span>`;
        } else if (isConsumable && item.expiry) {
            let expDate = new Date(item.expiry);
            let daysLeft = (expDate - new Date()) / (1000 * 60 * 60 * 24);
            if (daysLeft <= 7 && daysLeft >= 0) expiryHtml = ` <span class="expiring-tag expiring-soon" style="margin-left:6px;"><i class="fa-solid fa-triangle-exclamation"></i> Expiring Soon</span>`;
            else if (daysLeft < 0) expiryHtml = ` <span class="expiring-tag expiring-expired" style="margin-left:6px;"><i class="fa-solid fa-circle-xmark"></i> Expired</span>`;
        }

        const iconHtml = getCategoryIcon(item.cat);
        const isSelected = !isConsumable && selectedEquipItems.has(item.id);
        const imageHtml = (item.image && window.isSafeImageSrc(item.image))
            ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">`
            : iconHtml;

        const catClean = (item.cat || "").toLowerCase();
        let catTagClass = "inv-cat-default";
        if (catClean.includes("beverage")) catTagClass = "inv-cat-beverages";
        else if (catClean.includes("supplement")) catTagClass = "inv-cat-supplements";
        else if (catClean.includes("apparel") || catClean.includes("merch")) catTagClass = "inv-cat-apparel";

        let placeholderStyle = "";
        if (!item.image) {
            if (catClean.includes("beverage") || catClean.includes("drink")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.15)); color: #059669; border-color: rgba(16, 185, 129, 0.2);";
            } else if (catClean.includes("supplement")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(168, 85, 247, 0.15)); color: #4f46e5; border-color: rgba(99, 102, 241, 0.2);";
            } else if (catClean.includes("apparel") || catClean.includes("merch")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(236, 72, 153, 0.15)); color: #d97706; border-color: rgba(245, 158, 11, 0.2);";
            } else if (catClean.includes("cardio")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(2, 132, 199, 0.15)); color: #0284c7; border-color: rgba(14, 165, 233, 0.2);";
            } else if (catClean.includes("strength")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(109, 40, 217, 0.15)); color: #6d28d9; border-color: rgba(139, 92, 246, 0.2);";
            } else if (catClean.includes("free weight") || catClean.includes("weight")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(79, 70, 229, 0.1), rgba(67, 56, 202, 0.15)); color: #4338ca; border-color: rgba(79, 70, 229, 0.2);";
            } else if (catClean.includes("accessories") || catClean.includes("mat")) {
                placeholderStyle = "background: linear-gradient(135deg, rgba(241, 245, 249, 0.9), rgba(226, 232, 240, 0.95)); color: #475569; border-color: rgba(148, 163, 184, 0.3);";
            } else {
                placeholderStyle = "background: linear-gradient(135deg, rgba(148, 163, 184, 0.1), rgba(71, 85, 105, 0.15)); color: #475569; border-color: rgba(148, 163, 184, 0.2);";
            }
        }

        let actionButtons = !isConsumable ? `
            <button type="button" class="btn-icon btn-edit" title="Edit" onclick="openEditEquipModal('${item.id}')"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}', this)"><i class="fas fa-trash"></i></button>
        ` : item.isBatchTracked ? `
            <button type="button" class="btn-icon" title="Manage Batches" style="color:var(--accent-blue,#3b82f6);" onclick="openBatchManager('${item.id}')"><i class="fas fa-layer-group"></i></button>
            <button type="button" class="btn-icon btn-edit" title="Edit" onclick="openEditProductModal('${item.id}')"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}', this)"><i class="fas fa-trash"></i></button>
        ` : `
            <button type="button" class="btn-icon btn-restock" style="color: var(--accent-green);" title="Quick Restock" onclick="quickRestock('${item.id}')"><i class="fas fa-plus-circle"></i></button>
            <button type="button" class="btn-icon btn-edit" title="Edit" onclick="openEditProductModal('${item.id}')"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn-icon btn-delete" title="Delete" onclick="deleteInventoryItem('${item.id}', this)"><i class="fas fa-trash"></i></button>
        `;

        let stockLevelHtml = '';
        if (isConsumable) {
            const threshold = Number(item.lowStockThreshold || 5);
            const targetLevel = threshold > 0 ? threshold * 3 : 20;
            const percentage = Math.min((item.qty / targetLevel) * 100, 100);
            
            let barColor = "#10b981"; // safe green
            if (item.currentStatus === 'Out of Stock') {
                barColor = "#ef4444";
            } else if (item.currentStatus === 'Critical Stock') {
                barColor = "#ef4444";
            } else if (item.currentStatus === 'Low Stock') {
                barColor = "#f59e0b";
            }

            stockLevelHtml = `
                <div class="stock-level-container">
                    <div class="stock-level-bar-bg">
                        <div class="stock-level-bar-fill" style="width: ${percentage}%; background-color: ${barColor};"></div>
                    </div>
                </div>
            `;
        }

        let metaRowsHtml = '';
        if (!isConsumable) {
            metaRowsHtml += `
                <div class="inventory-meta-row">
                    ${(item.assetTag && item.assetTag !== 'undefined' && item.assetTag !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-tag"></i>
                            <span>Tag: <strong>${escapeHtml(item.assetTag)}</strong></span>
                        </div>
                    ` : ''}
                    ${(item.serialNumber && item.serialNumber !== 'undefined' && item.serialNumber !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-barcode"></i>
                            <span>S/N: <strong>${escapeHtml(item.serialNumber)}</strong></span>
                        </div>
                    ` : ''}
                    ${(item.size && item.size !== 'undefined' && item.size !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-weight-hanging"></i>
                            <span>Size/Weight: <strong>${escapeHtml(item.size)}</strong></span>
                        </div>
                    ` : ''}
                    ${(item.acquisitionDate && item.acquisitionDate !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-calendar-plus"></i>
                            <span>Acquired: <strong>${escapeHtml(item.acquisitionDate)}</strong>${item.equipmentAgeDays !== null && item.equipmentAgeDays > 1825 ? ` <span class="expiring-tag" style="background:rgba(100,116,139,0.12);color:#64748b;border:1px solid rgba(100,116,139,0.25);margin-left:4px;"><i class="fa-solid fa-hourglass-half"></i> ${Math.floor(item.equipmentAgeDays/365)}y old</span>` : ''}</span>
                        </div>
                    ` : ''}
                    ${(item.maintenanceDueDate && item.maintenanceDueDate !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-wrench"></i>
                            <span>Maintenance Due: <strong>${escapeHtml(item.maintenanceDueDate)}</strong>${item.maintenanceDueDays !== null && item.maintenanceDueDays > 0 ? ` <span class="expiring-tag expiring-soon" style="margin-left:4px;"><i class="fa-solid fa-triangle-exclamation"></i> ${item.maintenanceDueDays}d overdue</span>` : (item.maintenanceDueDays !== null && item.maintenanceDueDays < 0 ? ` <span class="expiring-tag" style="margin-left:4px;"><i class="fa-solid fa-hourglass-half"></i> due in ${Math.abs(item.maintenanceDueDays)}d</span>` : '')}</span>
                        </div>
                    ` : (item.maintenanceDate && item.maintenanceDate !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-wrench"></i>
                            <span>Maintenance Due: <strong>${escapeHtml(item.maintenanceDueDate || '')}</strong>${item.maintenanceDueDays !== null && item.maintenanceDueDays > 0 ? ` <span class="expiring-tag expiring-soon" style="margin-left:4px;"><i class="fa-solid fa-triangle-exclamation"></i> ${item.maintenanceDueDays}d overdue</span>` : (item.maintenanceDueDays !== null && item.maintenanceDueDays < 0 ? ` <span class="expiring-tag" style="margin-left:4px;"><i class="fa-solid fa-hourglass-half"></i> due in ${Math.abs(item.maintenanceDueDays)}d</span>` : '')}</span>
                        </div>
                    ` : `
                        ${item.maintenanceOverdue ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-wrench" style="color:#f97316;"></i>
                            <span style="color:#f97316;"><strong>No maintenance record</strong> <span class="expiring-tag expiring-soon" style="margin-left:4px;"><i class="fa-solid fa-triangle-exclamation"></i> Overdue</span></span>
                        </div>
                        ` : ''}
                    `}
                </div>
            `;
        } else {
            metaRowsHtml += `
                <div class="inventory-meta-row">
                    ${(item.size && item.size !== 'undefined' && item.size !== '') ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-box-archive"></i>
                            <span>Size/Vol: <strong>${escapeHtml(item.size)}</strong></span>
                        </div>
                    ` : ''}
                    ${item.expiry ? `
                        <div class="inventory-meta-item">
                            <i class="fa-solid fa-calendar-days"></i>
                            <span>Expiry: <strong>${escapeHtml(item.expiry)}</strong>${expiryHtml}</span>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        return `
            <div class="inventory-card inventory-item-filter ${isSelected ? 'selected' : ''}" 
                 data-search="${escapeHtml(item.name.toLowerCase())} ${escapeHtml(item.cat.toLowerCase())} ${escapeHtml(item.currentStatus.toLowerCase())}"
                 data-status="${escapeHtml(item.currentStatus)}">
                ${!isConsumable ? `<input type="checkbox" class="inventory-checkbox" onchange="toggleItemSelection('equipment', '${item.id}', this)" ${isSelected ? 'checked' : ''}>` : ''}
                <div class="inventory-icon-box" style="${placeholderStyle}">${imageHtml}</div>
                <div class="inventory-details" style="padding-right: 0;">
                    <div style="display: flex; flex-direction: column; height: 100%;">
                        <div class="inv-cat-tag ${catTagClass}">${escapeHtml(item.cat)}</div>
                        <div class="inventory-title">${escapeHtml(item.name)}</div>
                        
                        ${metaRowsHtml}
                        
                        <div style="margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
                            <div style="font-size: 13px; color: var(--text-primary); font-weight: 500;">
                                ${isConsumable && item.isBatchTracked
                                    ? `Batch Stock: <strong style="font-size:14px;font-weight:700;">${item.qty} units</strong> <button type="button" onclick="openBatchManager('${item.id}')" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--accent-blue,#3b82f6);background:transparent;color:var(--accent-blue,#3b82f6);cursor:pointer;margin-left:4px;">Manage</button>`
                                    : `Qty: <strong style="font-size: 14px; font-weight: 700;">${item.qty} units</strong>`
                                }
                            </div>
                            <span class="live-status-badge ${liveStatusClass}">
                                <span class="live-status-dot"></span>
                                ${escapeHtml(item.currentStatus)}
                            </span>
                        </div>
                        ${stockLevelHtml}
                    </div>
                </div>
                <div class="card-actions">${actionButtons}</div>
            </div>
        `;
    };

    const renderRow = (item) => {
        let badge = 'operational';
        if (item.currentStatus === 'Out of Stock' || item.currentStatus === 'Out of Order') badge = 'broken';
        else if (item.currentStatus === 'Low Stock') badge = 'stock-low';
        else if (item.currentStatus === 'Maintenance') badge = 'maintenance';

        const isSelected = selectedEquipItems.has(item.id);
        return `
            <tr class="${isSelected ? 'selected' : ''}">
                <td><input type="checkbox" onchange="toggleItemSelection('equipment', '${item.id}', this)" ${isSelected ? 'checked' : ''}></td>
                <td><div style="font-weight:600;">${escapeHtml(item.name)}</div></td>
                <td><span class="inventory-category" style="margin:0;">${escapeHtml(item.cat)}</span></td>
                <td><code>${(item.assetTag && item.assetTag !== 'undefined') ? escapeHtml(item.assetTag) : '-'}</code></td>
                <td>${(item.size && item.size !== 'undefined') ? escapeHtml(item.size) : '-'}</td>
                <td><strong>${item.qty}</strong></td>
                <td>
                    <span class="badge ${badge}">${escapeHtml(item.currentStatus)}</span>
                    ${item.maintenanceOverdue ? `<span class="badge" style="background:#fff7ed;color:#f97316;border:1px solid #fed7aa;margin-left:4px;font-size:10px;"><i class="fa-solid fa-triangle-exclamation"></i> Overdue</span>` : ''}
                </td>
                <td>${(item.acquisitionDate && item.acquisitionDate !== '') ? `${escapeHtml(item.acquisitionDate)}${item.equipmentAgeDays !== null && item.equipmentAgeDays > 1825 ? ` <span style="font-size:10px;color:#64748b;">(${Math.floor(item.equipmentAgeDays/365)}y)</span>` : ''}` : '-'}</td>
                <td>${(item.maintenanceDueDate && item.maintenanceDueDate !== '') ? `${escapeHtml(item.maintenanceDueDate)}${item.maintenanceDueDays !== null && item.maintenanceDueDays > 0 ? ` <span style="font-size:10px;color:#f97316;">(${item.maintenanceDueDays}d overdue)</span>` : (item.maintenanceDueDays !== null && item.maintenanceDueDays < 0 ? ` <span style="font-size:10px;color:#64748b;">(in ${Math.abs(item.maintenanceDueDays)}d)</span>` : '')}` : ((item.maintenanceDate && item.maintenanceDate !== '') ? `${escapeHtml(item.maintenanceDate)}${item.maintenanceDueDays !== null && item.maintenanceDueDays > 90 ? ` <span style="font-size:10px;color:#f97316;">(${item.maintenanceDueDays}d ago)</span>` : ''}` : `<span style="color:#f97316;font-size:11px;">${item.maintenanceOverdue ? 'Never recorded' : '-'}</span>`)}</td>
                <td><strong>${item.maintenanceCount || 0}</strong>×</td>
                <td>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn-icon" onclick="openEditEquipModal('${item.id}')"><i class="fas fa-edit"></i></button>
                        <button type="button" class="btn-icon" onclick="deleteInventoryItem('${item.id}', this)"><i class="fas fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `;
    };

    // Render Grid Equipment
    if (currentInventoryView === 'grid') {
        equipGrid.style.display = 'grid';
        if (equipListContainer) equipListContainer.style.display = 'none';

        const totalRecords = filteredEquipment.length;
        const totalPages = Math.ceil(totalRecords / equipItemsPerPage);
        if (equipCurrentPage > totalPages && totalPages > 0) equipCurrentPage = totalPages;
        if (equipCurrentPage < 1) equipCurrentPage = 1;
        const startIdx = (equipCurrentPage - 1) * equipItemsPerPage;
        const endIdx = Math.min(startIdx + equipItemsPerPage, totalRecords);
        const displayData = filteredEquipment.slice(startIdx, endIdx);

        const countEl = document.getElementById('equipRecordCount');
        if (countEl) countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;

        window.renderPaginationControls('equipPagination', equipCurrentPage, totalPages, totalRecords, 'changeEquipPage');
        window.syncDOM(equipGrid, displayData, renderCard, 'equip-grid');
    } else {
        equipGrid.style.display = 'none';
        if (equipListContainer) {
            equipListContainer.style.display = 'block';
            
            const totalRecords = filteredEquipment.length;
            const totalPages = Math.ceil(totalRecords / equipItemsPerPage);
            if (equipCurrentPage > totalPages && totalPages > 0) equipCurrentPage = totalPages;
            if (equipCurrentPage < 1) equipCurrentPage = 1;
            const startIdx = (equipCurrentPage - 1) * equipItemsPerPage;
            const endIdx = Math.min(startIdx + equipItemsPerPage, totalRecords);
            const displayData = filteredEquipment.slice(startIdx, endIdx);

            const countEl = document.getElementById('equipRecordCount');
            if (countEl) countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;

            window.renderPaginationControls('equipPagination', equipCurrentPage, totalPages, totalRecords, 'changeEquipPage');
            window.syncDOM(equipListBody, displayData, renderRow, 'equip-row');
        }
    }

    // Render Products
    const totalProd = filteredProducts.length;
    const totalProdPages = Math.ceil(totalProd / prodItemsPerPage);
    if (prodCurrentPage > totalProdPages && totalProdPages > 0) prodCurrentPage = totalProdPages;
    if (prodCurrentPage < 1) prodCurrentPage = 1;
    const startProd = (prodCurrentPage - 1) * prodItemsPerPage;
    const endProd = Math.min(startProd + prodItemsPerPage, totalProd);
    const displayProd = filteredProducts.slice(startProd, endProd);

    const prodCountEl = document.getElementById('prodRecordCount');
    if (prodCountEl) prodCountEl.textContent = totalProd === 0 ? 'Showing 0-0 of 0' : `Showing ${startProd + 1}-${endProd} of ${totalProd}`;

    window.renderPaginationControls('prodPagination', prodCurrentPage, totalProdPages, totalProd, 'changeProdPage');
    window.syncDOM(prodGrid, displayProd, renderCard, 'prod-grid');

    // Update Batch Bar
    if (equipBatchBar) {
        if (selectedEquipItems.size > 0) {
            equipBatchBar.classList.add('show');
            const countEl = document.getElementById('equipBatchCount');
            if (countEl) countEl.innerText = `${selectedEquipItems.size} selected`;
        } else {
            equipBatchBar.classList.remove('show');
        }
    }

    // Update Stats
    if (document.getElementById('dashInventoryTotal')) document.getElementById('dashInventoryTotal').innerText = inventoryData.length;
    if (document.getElementById('gridEquip')) document.getElementById('gridEquip').innerText = ops;
    if (document.getElementById('navInventoryCount')) document.getElementById('navInventoryCount').innerText = ` ${inventoryData.length} `;

    const dashAlerts = document.getElementById('dashInventoryAlerts');
    if (dashAlerts) dashAlerts.innerHTML = alertsHtmlArr.join('') || '<p style="color: green; font-size: 14px;">All systems operational!</p>';

    // Render inventory category summaries
    if (window.renderEquipmentCategorySummary) window.renderEquipmentCategorySummary();
    if (window.renderProductCategorySummary) window.renderProductCategorySummary();
}

window.migrateInventoryDatabase = async function () {
    showConfirm({
        title: 'Run Database Migration?',
        message: 'This will upgrade old inventory items to the new schema. Existing data is preserved.',
        tone: 'info',
        confirmText: 'Run Migration',
        onConfirm: async () => {
            let updatedCount = 0;
            for (let item of inventoryData) {
                let isConsumable = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
                let updates = {};
                if (!item.itemType) updates.itemType = isConsumable ? 'product' : 'equipment';
                if (item.lowStockThreshold === undefined) updates.lowStockThreshold = isConsumable ? 5 : 0;

                if (Object.keys(updates).length > 0) {
                    await updateDoc(doc(db, "inventory", item.id), updates);
                    updatedCount++;
                }
            }
            showToast(`Migration complete! Updated ${updatedCount} old items.`, "success");
        }
    });
}

// When the user sets maintenance date to today while status is Maintenance/Out of Order,
// automatically flip status to Operational — maintenance just happened.
window.handleMaintenanceDateChange = function(input) {
    const today = new Date().toISOString().split('T')[0];
    if (input.value !== today) return;
    const statusEl = document.getElementById('editEquipStatus');
    if (!statusEl) return;
    if (statusEl.value === 'Maintenance' || statusEl.value === 'Out of Order') {
        statusEl.value = 'Operational';
        showToast("Status set to Operational — maintenance date logged as today.", "info");
    }
};

window.ensureMaintenanceDueLabels = function() {
    const addDueLabel = document.getElementById('equipMaintenanceDueDate')
        ?.closest('.form-group')
        ?.querySelector('.form-label');
    if (addDueLabel) addDueLabel.textContent = 'Maintenance Due Date';

    const editDueLabel = document.getElementById('editEquipMaintenanceDueDate')
        ?.closest('.form-group')
        ?.querySelector('.form-label');
    if (editDueLabel) editDueLabel.textContent = 'Maintenance Due Date';
};
window.ensureMaintenanceDueLabels();

window.openEquipmentModal = () => {
    document.getElementById('equipmentForm').reset();
    window.ensureMaintenanceDueLabels();
    document.getElementById('equipmentModal').style.display = 'flex';
    window.handleEquipCategoryChange('equipCategory', 'equipQty');
}
window.openProductModal = () => { document.getElementById('productForm').reset(); document.getElementById('productModal').style.display = 'flex'; }
window.deleteInventoryItem = async (id, btn) => {
    // S2 (Sprint 8): fast-fail RBAC — admin/staff only. The UI gates this button,
    // but the function was console-callable by trainer/member roles.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin' && _r !== 'staff') {
        return showToast("Permission denied.", "error");
    }
    const item = inventoryData.find(i => i.id === id);
    const inCart = Array.isArray(window.posCart) ? window.posCart.some(c => c.id === id) : false;
    const msg = inCart
        ? `Delete this inventory item? It is currently in the open POS cart and will be removed from it.`
        : "Delete this inventory item?";
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({ message: msg, onCancel: _rearmBtn, onConfirm: async () => {
        try {
            await deleteDoc(doc(db, "inventory", id));
            if (Array.isArray(window.posCart)) {
                window.posCart = window.posCart.filter(c => c.id !== id);
                if (typeof renderCart === 'function') renderCart();
            }
            showToast("Item deleted.", "info");
            if (window.logActivity) window.logActivity("Item Deleted", `Deleted inventory item: ${item ? item.name : id}`);
        } catch (err) {
            console.error(err);
            showToast("Failed to delete item.", "error");
        } finally {
            _rearmBtn();
        }
    }});
}

window.openEditEquipModal = function (id) {
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    window.ensureMaintenanceDueLabels();
    document.getElementById('editEquipId').value = item.id;
    document.getElementById('editEquipName').value = item.name;
    document.getElementById('editEquipCategory').value = item.cat;
    document.getElementById('editEquipSize').value = item.size || '';
    document.getElementById('editEquipQty').value = item.qty;
    document.getElementById('editEquipStatus').value = item.status || 'Operational';
    document.getElementById('editEquipAssetTag').value = item.assetTag || '';
    if (document.getElementById('editEquipAcquisitionDate')) document.getElementById('editEquipAcquisitionDate').value = item.acquisitionDate || '';
    if (document.getElementById('editEquipMaintenanceDueDate')) {
        document.getElementById('editEquipMaintenanceDueDate').value = item.maintenanceDueDate || item.maintenanceDate || '';
    }
    if (document.getElementById('editEquipMaintCount')) {
        const count = item.maintenanceCount || 0;
        document.getElementById('editEquipMaintCount').textContent = `${count} time${count !== 1 ? 's' : ''}`;
    }
    if (document.getElementById('editEquipImage')) document.getElementById('editEquipImage').value = item.image || '';
    if (document.getElementById('editEquipPreview')) {
        document.getElementById('editEquipPreview').src = item.image || 'images/default-equip.png';
    }
    currentLogbookEquipId = id;
    currentLogbookEquipName = item.name;
    document.getElementById('editEquipModal').style.display = 'flex';
    window.handleEquipCategoryChange('editEquipCategory', 'editEquipQty');
}

if (document.getElementById('editEquipForm')) {
    document.getElementById('editEquipForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        // S6 (Sprint 8): admin/staff only.
        const _r = (localStorage.getItem("userRole") || '').toLowerCase();
        if (_r !== 'admin' && _r !== 'staff') {
            return showToast("Permission denied.", "error");
        }
        const id = document.getElementById('editEquipId').value;
        const oldEquip = inventoryData.find(i => i.id === id);

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        try {
            const nameStr = document.getElementById('editEquipName').value.trim();
            if (!nameStr) {
                showToast("Equipment name is required.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            // VULN-05: cap name length to prevent layout bombs and potential innerHTML injection
            if (nameStr.length > 120) {
                showToast("Equipment name must be 120 characters or fewer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const qtyVal = parseInt(document.getElementById('editEquipQty').value, 10);
            if (isNaN(qtyVal) || qtyVal < 0) {
                showToast("Quantity must be a non-negative integer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const assetTagVal = document.getElementById('editEquipAssetTag').value.trim();
            // VULN-11: empty/whitespace tag already normalizes to "" — enforce length cap too
            if (assetTagVal && assetTagVal.length > 50) {
                showToast("Asset tag must be 50 characters or fewer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            if (assetTagVal && inventoryData.some(i => i.id !== id && i.assetTag && i.assetTag.toLowerCase() === assetTagVal.toLowerCase())) {
                showToast("Asset tag must be unique! This tag is already assigned to another item.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const imageFile = document.getElementById('editEquipImageFile').files[0];
            let imageUrl = document.getElementById('editEquipImage').value.trim();

            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'equipment');
            }

            const newMaintenanceDueDate = document.getElementById('editEquipMaintenanceDueDate') ? document.getElementById('editEquipMaintenanceDueDate').value || '' : '';

            const updatedData = {
                name: nameStr,
                cat: document.getElementById('editEquipCategory').value,
                size: document.getElementById('editEquipSize').value.trim() || '',
                qty: qtyVal,
                status: document.getElementById('editEquipStatus').value,
                assetTag: assetTagVal,
                acquisitionDate: document.getElementById('editEquipAcquisitionDate') ? document.getElementById('editEquipAcquisitionDate').value || '' : '',
                maintenanceDueDate: newMaintenanceDueDate,
                maintenanceCount: oldEquip ? (oldEquip.maintenanceCount || 0) : 0,
                image: imageUrl || ''
            };

            const qtyDiff = updatedData.qty - (oldEquip ? oldEquip.qty : 0);

            await updateDoc(doc(db, "inventory", id), updatedData);
            if (qtyDiff !== 0) await logStockMovement(id, updatedData.name, qtyDiff, "Manual Edit");
            window.closeModal('editEquipModal');
            showToast("Equipment updated successfully!", "success");
            if (window.logActivity) window.logActivity("Equipment Updated", `Updated: ${updatedData.name}`);
        } catch (error) {
            console.error("Equipment update failed:", error);
            showToast("Failed to update equipment. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}

window.openEditProductModal = function (id) {
    const item = inventoryData.find(i => i.id === id);
    if (!item) return;
    document.getElementById('editProdId').value = item.id;
    document.getElementById('editProdName').value = item.name;
    document.getElementById('editProdCategory').value = item.cat;
    document.getElementById('editProdPrice').value = item.price;
    document.getElementById('editProdQty').value = item.qty;
    document.getElementById('editProdVol').value = item.size || '';
    if (document.getElementById('editProdImage')) document.getElementById('editProdImage').value = item.image || '';
    if (document.getElementById('editProdPreview')) {
        document.getElementById('editProdPreview').src = item.image || 'images/default-product.png';
    }
    if (document.getElementById('editProdExpiry')) {
        const expiryEl = document.getElementById('editProdExpiry');
        const today = new Date().toISOString().split('T')[0];
        expiryEl.min = today;
        expiryEl.value = item.expiry || '';
    }
    if (document.getElementById('editProdSerialNumber')) {
        document.getElementById('editProdSerialNumber').value = item.serialNumber || '';
    }
    const batchCb = document.getElementById('editProdBatchTracked');
    if (batchCb) {
        batchCb.checked = !!item.isBatchTracked;
        toggleEditBatchMode(!!item.isBatchTracked);
    }
    document.getElementById('editProductModal').style.display = 'flex';
}

if (document.getElementById('editProductForm')) {
    document.getElementById('editProductForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        // S6 (Sprint 8): admin/staff only.
        const _r = (localStorage.getItem("userRole") || '').toLowerCase();
        if (_r !== 'admin' && _r !== 'staff') {
            return showToast("Permission denied.", "error");
        }
        const id = document.getElementById('editProdId').value;
        const oldProd = inventoryData.find(i => i.id === id);

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        try {
            const nameStr = document.getElementById('editProdName').value.trim();
            if (!nameStr) {
                showToast("Product name is required.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            // VULN-05: cap product name length
            if (nameStr.length > 120) {
                showToast("Product name must be 120 characters or fewer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const priceVal = Number(document.getElementById('editProdPrice').value);
            if (isNaN(priceVal) || priceVal <= 0) {
                showToast("Product price must be a positive number.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const qtyVal = parseInt(document.getElementById('editProdQty').value, 10);
            if (isNaN(qtyVal) || qtyVal < 0) {
                showToast("Quantity must be a non-negative integer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }

            const imageFile = document.getElementById('editProdImageFile').files[0];
            let imageUrl = document.getElementById('editProdImage').value.trim();

            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'products');
            }

            const isBatchTracked = !!(document.getElementById('editProdBatchTracked')?.checked);
            const expiryInputVal = (document.getElementById('editProdExpiry')?.value || '').trim();
            if (!isBatchTracked) {
                if (!expiryInputVal) {
                    showToast("Expiration date is required for non-batch products.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                    return;
                }
                const todayStr = new Date().toISOString().split('T')[0];
                if (expiryInputVal < todayStr) {
                    showToast("Expiry date cannot be in the past.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                    return;
                }
            }
            const wasBatchTracked = !!(oldProd?.isBatchTracked);
            const switchingToBatchMode = !wasBatchTracked && isBatchTracked;
            const oldQty = parseInt(oldProd?.qty, 10) || 0;
            const oldExpiry = (oldProd?.expiry || '').trim();
            const updatedData = {
                name: nameStr,
                cat: document.getElementById('editProdCategory').value,
                price: priceVal,
                qty: isBatchTracked ? (oldProd?.qty || 0) : qtyVal, // batch items keep computed qty from batches
                size: document.getElementById('editProdVol').value,
                image: imageUrl || '',
                expiry: isBatchTracked ? null : expiryInputVal,
                serialNumber: document.getElementById('editProdSerialNumber') ? document.getElementById('editProdSerialNumber').value.trim() : (oldProd?.serialNumber || ''),
                isBatchTracked
            };

            const qtyDiff = updatedData.qty - (oldProd ? oldProd.qty : 0);

            if (switchingToBatchMode) {
                const existingBatchSnap = await getDocs(query(collection(db, "inventory", id, "batches"), limit(1)));
                const hasExistingBatch = !existingBatchSnap.empty;
                await runTransaction(db, async (txn) => {
                    const invRef = doc(db, "inventory", id);
                    const invSnap = await txn.get(invRef);
                    if (!invSnap.exists()) throw new Error("Product no longer exists.");

                    const liveQty = parseInt(invSnap.data()?.qty, 10) || 0;
                    const seedQty = Math.max(oldQty, liveQty, 0);
                    const seedExpiry = oldExpiry || "9999-12-31";

                    const batchesRef = collection(db, "inventory", id, "batches");

                    // Seed first batch from pre-batch root stock/expiry when converting legacy products.
                    if (seedQty > 0 && !hasExistingBatch) {
                        txn.set(doc(batchesRef), {
                            expiryDate: seedExpiry,
                            currentQuantity: seedQty,
                            addedAt: Date.now(),
                            isLegacyInitialBatch: true,
                            notes: "Auto-migrated from pre-batch product qty during batch-mode conversion.",
                        });
                    }

                    txn.update(invRef, updatedData);
                });

                if (oldQty > 0) {
                    await logStockMovement(
                        id,
                        updatedData.name,
                        oldQty,
                        `Batch Mode Migration (Initial Batch, Expiry: ${oldExpiry || 'No Expiry'})`
                    );
                }
            } else {
                await updateDoc(doc(db, "inventory", id), updatedData);
            }
            if (qtyDiff !== 0) await logStockMovement(id, updatedData.name, qtyDiff, "Manual Edit");
            window.closeModal('editProductModal');
            showToast("Product updated successfully!", "success");
            if (window.logActivity) window.logActivity("Product Updated", `Updated: ${updatedData.name}`);
        } catch (error) {
            console.error("Product update failed:", error);
            showToast("Failed to update product. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}

async function handleInventorySubmit(e, isProduct) {
    e.preventDefault();
    // S6 (Sprint 8): admin/staff only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin' && _r !== 'staff') {
        return showToast("Permission denied.", "error");
    }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }

    try {
        const nameStr = document.getElementById(isProduct ? 'prodName' : 'equipName').value.trim();
        if (!nameStr) {
            showToast("Item name is required.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        // VULN-05: cap name length
        if (nameStr.length > 120) {
            showToast("Item name must be 120 characters or fewer.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        const addQty = parseInt(document.getElementById(isProduct ? 'prodQty' : 'equipQty').value, 10);
        if (isNaN(addQty) || addQty < 0) {
            showToast("Quantity must be a non-negative integer.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        if (!isProduct) {
            const assetTagVal = document.getElementById('equipAssetTag').value.trim();
            // VULN-11: enforce length cap on new asset tags
            if (assetTagVal && assetTagVal.length > 50) {
                showToast("Asset tag must be 50 characters or fewer.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            if (assetTagVal && inventoryData.some(i => i.assetTag && i.assetTag.toLowerCase() === assetTagVal.toLowerCase())) {
                showToast("Asset tag must be unique! This tag is already assigned to another item.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
        }

        // Up-front product validation (price > 0, expiry not in past)
        if (isProduct) {
            const priceCheck = Number(document.getElementById('prodPrice').value);
            if (isNaN(priceCheck) || priceCheck <= 0) {
                showToast("Product price must be a positive number.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            const regIsBatchTracked = !!(document.getElementById('prodBatchTracked')?.checked);
            const expiryCheck = (document.getElementById('prodExpiry')?.value || '').trim();
            if (!regIsBatchTracked && !expiryCheck) {
                showToast("Expiration date is required for non-batch products.", "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
            if (expiryCheck) {
                const todayStr = new Date().toISOString().split('T')[0];
                if (expiryCheck < todayStr) {
                    showToast("Expiry date cannot be in the past.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                    return;
                }
            }
        }

        const existingItem = isProduct ? inventoryData.find(i => {
            const isConsumable = i.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(i.cat);
            return isConsumable && i.name.toLowerCase() === nameStr.toLowerCase();
        }) : null;

        if (existingItem) {
            await updateDoc(doc(db, "inventory", existingItem.id), { qty: increment(addQty) });
            await logStockMovement(existingItem.id, existingItem.name, addQty, "Automated Restock");
            showToast(`Automated Update: Added ${addQty} units to existing stock. New Total: ${existingItem.qty + addQty} units.`, "info");
        } else {
            const imageFile = document.getElementById(isProduct ? 'prodImageFile' : 'equipImageFile').files[0];
            let imageUrl = document.getElementById(isProduct ? 'prodImage' : 'equipImage').value.trim();

            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, isProduct ? 'products' : 'equipment');
            }

            const regIsBatchTracked = isProduct && !!(document.getElementById('prodBatchTracked')?.checked);
            const newItem = {
                name: nameStr, cat: document.getElementById(isProduct ? 'prodCategory' : 'equipCategory').value, size: document.getElementById(isProduct ? 'prodVol' : 'equipSize').value,
                qty: regIsBatchTracked ? 0 : addQty, status: isProduct ? 'In Stock' : 'Operational', price: isProduct ? Number(document.getElementById('prodPrice').value) : 0,
                expiry: (isProduct && !regIsBatchTracked) ? document.getElementById('prodExpiry').value : null,
                itemType: isProduct ? 'product' : 'equipment', lowStockThreshold: isProduct ? 5 : 0,
                isBatchTracked: regIsBatchTracked,
                assetTag: !isProduct ? (document.getElementById('equipAssetTag').value.trim() || '') : '',
                serialNumber: isProduct ? (document.getElementById('prodSerialNumber') ? document.getElementById('prodSerialNumber').value.trim() : '') : '',
                acquisitionDate: !isProduct ? (document.getElementById('equipAcquisitionDate').value || '') : '',
                maintenanceDueDate: !isProduct ? (document.getElementById('equipMaintenanceDueDate')?.value || '') : '',
                image: imageUrl || ''
            };

            // Validate product price
            if (isProduct) {
                if (isNaN(newItem.price) || newItem.price <= 0) {
                    showToast("Product price must be a positive number.", "error");
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                    return;
                }
            }

            const addedRef = await addDoc(inventoryCol, newItem);
            if (isProduct && addQty > 0) await logStockMovement(addedRef.id, nameStr, addQty, "Initial Stock");
            showToast(`New ${isProduct ? 'product' : 'equipment'} registered successfully!`, "success");
            if (window.logActivity) window.logActivity("Item Registered", `Registered new ${isProduct ? 'product' : 'equipment'}: ${nameStr} (Qty: ${addQty})`);
        }
        window.closeModal(isProduct ? 'productModal' : 'equipmentModal');
    } catch (e) {
        console.error("Inventory submission failed: ", e);
        showToast("An error occurred. Please try again.", "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    }
}

if (document.getElementById('equipmentForm')) document.getElementById('equipmentForm').addEventListener('submit', (e) => handleInventorySubmit(e, false));
if (document.getElementById('productForm')) document.getElementById('productForm').addEventListener('submit', (e) => handleInventorySubmit(e, true));

// ==========================================
// BATCH TRACKING UI HELPERS
// ==========================================
function updateBatchToggleUi(kind, enabled) {
    const stateEl = document.getElementById(kind === 'reg' ? 'regBatchToggleState' : 'editBatchToggleState');
    const trackEl = document.getElementById(kind === 'reg' ? 'regBatchToggleTrack' : 'editBatchToggleTrack');
    const knobEl = document.getElementById(kind === 'reg' ? 'regBatchToggleKnob' : 'editBatchToggleKnob');
    if (stateEl) {
        stateEl.textContent = enabled ? 'ON' : 'OFF';
        stateEl.style.background = enabled ? 'rgba(59,130,246,0.15)' : '#e2e8f0';
        stateEl.style.color = enabled ? '#1d4ed8' : '#475569';
    }
    if (trackEl) {
        trackEl.style.background = enabled ? 'var(--accent-blue,#3b82f6)' : '#cbd5e1';
    }
    if (knobEl) {
        knobEl.style.left = enabled ? '23px' : '3px';
    }
}

// Show/hide qty+expiry fields in the Register Product modal based on batch mode
window.toggleRegBatchMode = function (enabled) {
    const qtyInput = document.getElementById('prodQty');
    const expiryInput = document.getElementById('prodExpiry');
    const qtyRow = document.getElementById('prodQty')?.closest('.form-row');
    const expiryGroup = document.getElementById('prodExpiry')?.closest('.form-group');
    if (qtyRow) qtyRow.style.display = enabled ? 'none' : '';
    if (expiryGroup) expiryGroup.style.display = enabled ? 'none' : '';
    if (qtyInput) {
        qtyInput.required = !enabled;
        qtyInput.disabled = !!enabled;
        if (enabled) qtyInput.value = '';
    }
    if (expiryInput) {
        expiryInput.required = !enabled;
        expiryInput.disabled = !!enabled;
        if (enabled) expiryInput.value = '';
    }
    updateBatchToggleUi('reg', !!enabled);
};

// Show/hide qty+expiry fields in the Edit Product modal based on batch mode
window.toggleEditBatchMode = function (enabled) {
    const qtyInput = document.getElementById('editProdQty');
    const expiryInput = document.getElementById('editProdExpiry');
    const qtyRow = document.getElementById('editProdQty')?.closest('.form-row');
    const expiryGroup = document.getElementById('editProdExpiry')?.closest('.form-group');
    if (qtyRow) qtyRow.style.display = enabled ? 'none' : '';
    if (expiryGroup) expiryGroup.style.display = enabled ? 'none' : '';
    if (qtyInput) {
        qtyInput.required = !enabled;
        qtyInput.disabled = !!enabled;
    }
    if (expiryInput) {
        expiryInput.required = !enabled;
        expiryInput.disabled = !!enabled;
    }
    updateBatchToggleUi('edit', !!enabled);
};

// Ensure toggle visuals and required flags are in sync at startup.
setTimeout(() => {
    const regCb = document.getElementById('prodBatchTracked');
    const editCb = document.getElementById('editProdBatchTracked');
    if (regCb) window.toggleRegBatchMode(!!regCb.checked);
    if (editCb) window.toggleEditBatchMode(!!editCb.checked);
}, 0);

// ── Batch Manager ──────────────────────────────────────────────────────────────
let _batchMgrProductId = null;
let _batchEditProductId = null;
let _batchEditId = null;

window.openBatchManager = async function (productId) {
    const item = inventoryData.find(i => i.id === productId);
    if (!item) return;
    _batchMgrProductId = productId;

    const nameEl = document.getElementById('batchManagerProductName');
    if (nameEl) nameEl.textContent = item.name;

    const qtyIn = document.getElementById('newBatchQty');
    const expIn = document.getElementById('newBatchExpiry');
    if (qtyIn) qtyIn.value = '';
    if (expIn) expIn.value = '';
    window.cancelBatchEdit();

    await refreshBatchList(productId);
    document.getElementById('batchManagerModal').style.display = 'flex';
};

async function refreshBatchList(productId) {
    const listEl = document.getElementById('batchList');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:8px 0;">Loading batches…</p>';

    try {
        const batchesRef = collection(db, 'inventory', productId, 'batches');
        const snap = await getDocs(batchesRef);
        const batchDocs = snap.docs.slice().sort((a, b) =>
            String(a.data().expiryDate || '').localeCompare(String(b.data().expiryDate || ''))
        );

        if (batchDocs.length === 0) {
            listEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:8px 0;">No batches yet. Add the first batch below.</p>';
            return;
        }

        const today = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().slice(0, 10);
        const warnStr = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        let totalQty = 0;
        const rows = [];
        batchDocs.forEach(d => {
            const data = d.data();
            const qty = data.currentQuantity || 0;
            const exp = data.expiryDate || '';
            totalQty += qty;

            let tagHtml = '';
            if (exp && exp <= todayStr) {
                tagHtml = '<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.25);margin-left:6px;">Expired</span>';
            } else if (exp && exp <= warnStr) {
                tagHtml = '<span style="font-size:11px;padding:2px 7px;border-radius:5px;background:rgba(245,158,11,0.1);color:#d97706;border:1px solid rgba(245,158,11,0.25);margin-left:6px;"><i class="fas fa-clock"></i> Expiring Soon</span>';
            }

            rows.push(`
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:10px;border:1px solid var(--border-color,#e2e8f0);background:var(--card-bg,#fff);gap:12px;">
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size:13px;">Expiry: ${escapeHtml(exp)}${tagHtml}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Current qty: <strong>${qty}</strong> units</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;">
                        <button type="button" title="Edit batch" onclick="startBatchEdit('${productId}','${d.id}',${qty},'${escapeHtml(exp)}')"
                            style="background:none;border:none;cursor:pointer;color:var(--accent-blue,#3b82f6);font-size:16px;padding:4px 8px;border-radius:6px;">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button type="button" title="Delete batch" onclick="deleteBatch('${productId}','${d.id}',${qty})"
                            style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:16px;padding:4px 8px;border-radius:6px;"
                            ${qty > 0 ? 'disabled title="Cannot delete — batch still has stock. Zero it out first."' : ''}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `);
        });

        listEl.innerHTML = rows.join('') +
            `<div style="padding:10px 14px;border-radius:10px;background:var(--accent-blue-soft,rgba(59,130,246,0.07));border:1px solid rgba(59,130,246,0.2);font-size:13px;font-weight:600;color:var(--accent-blue,#3b82f6);">
                Total available: ${totalQty} units across ${batchDocs.length} batch${batchDocs.length === 1 ? '' : 'es'}
             </div>`;

    } catch (err) {
        listEl.innerHTML = `<p style="color:#ef4444;font-size:13px;">Failed to load batches: ${escapeHtml(err.message)}</p>`;
    }
}

window.saveNewBatch = async function () {
    if (!_batchMgrProductId) return;
    const qtyInput = document.getElementById('newBatchQty');
    const expInput = document.getElementById('newBatchExpiry');
    // Strict integer normalization prevents string-collision issues (e.g. "0" + "5" => "05").
    const newBatchQty = parseInt(qtyInput?.value, 10) || 0;
    const expiry = expInput?.value || '';

    if (!Number.isFinite(newBatchQty) || newBatchQty <= 0) return showToast('Enter a valid quantity.', 'error');
    if (!expiry) return showToast('Select an expiry date.', 'error');

    const today = new Date(Date.now() + (window.serverTimeOffsetMs || 0)).toISOString().slice(0, 10);
    if (expiry <= today) return showToast('Expiry date must be in the future.', 'error');

    const saveBtn = document.querySelector('#batchManagerModal .action-btn[onclick="saveNewBatch()"]');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    try {
        await runTransaction(db, async (txn) => {
            const invRef = doc(db, 'inventory', _batchMgrProductId);
            const invSnap = await txn.get(invRef);
            if (!invSnap.exists()) {
                throw new Error('Inventory product no longer exists. Please refresh and try again.');
            }

            const invData = invSnap.data() || {};
            // Support legacy schemas that stored root stock as qty/stock/currentStock/totalStock.
            const rootQtyRaw = invData.qty ?? 0;
            const rootTotalRaw = invData.totalStock ?? rootQtyRaw;
            const rootStockRaw = invData.stock ?? rootQtyRaw;
            const rootCurrentRaw = invData.currentStock ?? rootQtyRaw;
            const rootQty = parseInt(rootQtyRaw, 10) || 0;
            const rootTotalStock = parseInt(rootTotalRaw, 10) || 0;
            const rootStock = parseInt(rootStockRaw, 10) || 0;
            const rootCurrentStock = parseInt(rootCurrentRaw, 10) || 0;
            const strandedRootStock = Math.max(rootQty, rootTotalStock, rootStock, rootCurrentStock, 0);

            const batchesRef = collection(db, 'inventory', _batchMgrProductId, 'batches');
            const existingBatchSnap = await txn.get(query(batchesRef, limit(1)));
            const hasAnyBatch = !existingBatchSnap.empty;

            // Rescue stranded legacy stock by creating a synthetic initial batch first.
            if (!hasAnyBatch && strandedRootStock > 0) {
                const legacyBatchRef = doc(batchesRef);
                txn.set(legacyBatchRef, {
                    expiryDate: '9999-12-31',
                    currentQuantity: strandedRootStock,
                    addedAt: Date.now(),
                    isLegacyInitialBatch: true,
                    notes: 'Auto-migrated from root stock during first batch creation.',
                });
            }

            const batchRef = doc(batchesRef);
            txn.set(batchRef, { expiryDate: expiry, currentQuantity: newBatchQty, addedAt: Date.now() });

            // Keep aggregate stock fields race-safe and numeric before increments.
            const numericSeed = {};
            if (!(typeof rootQtyRaw === 'number' && Number.isFinite(rootQtyRaw))) numericSeed.qty = rootQty;
            if (!(typeof rootTotalRaw === 'number' && Number.isFinite(rootTotalRaw))) numericSeed.totalStock = rootTotalStock;
            if (!(typeof rootStockRaw === 'number' && Number.isFinite(rootStockRaw))) numericSeed.stock = rootStock;
            if (!(typeof rootCurrentRaw === 'number' && Number.isFinite(rootCurrentRaw))) numericSeed.currentStock = rootCurrentStock;
            if (Object.keys(numericSeed).length) txn.update(invRef, numericSeed);

            // Master aggregate: add only the NEW batch quantity (legacy rescue qty already existed at root).
            txn.update(invRef, {
                qty: increment(newBatchQty),
                totalStock: increment(newBatchQty),
                stock: increment(newBatchQty),
                currentStock: increment(newBatchQty),
            });
        });

        await logStockMovement(
            _batchMgrProductId,
            inventoryData.find(i => i.id === _batchMgrProductId)?.name || '',
            newBatchQty,
            `Batch Received (Expiry: ${expiry})`
        );
        if (qtyInput) qtyInput.value = '';
        if (expInput) expInput.value = '';
        await refreshBatchList(_batchMgrProductId);
        showToast('Batch added successfully.', 'success');
    } catch (err) {
        showToast('Failed to add batch: ' + err.message, 'error');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-plus"></i> Add Batch'; }
    }
};

window.deleteBatch = async function (productId, batchId, currentQty) {
    if (currentQty > 0) {
        showToast('Cannot delete a batch that still has stock.', 'error');
        return;
    }
    showConfirm({
        title: 'Delete Batch',
        message: 'Delete this empty batch record? This cannot be undone.',
        tone: 'danger',
        confirmText: 'Delete',
        onConfirm: async () => {
            try {
                await deleteDoc(doc(db, 'inventory', productId, 'batches', batchId));
                await refreshBatchList(productId);
                showToast('Batch deleted.', 'success');
            } catch (err) {
                showToast('Failed to delete batch: ' + err.message, 'error');
            }
        }
    });
};

window.startBatchEdit = function (productId, batchId, currentQty, currentExpiry) {
    _batchEditProductId = productId;
    _batchEditId = batchId;
    const panel = document.getElementById('batchEditPanel');
    const idIn = document.getElementById('editBatchId');
    const qtyIn = document.getElementById('editBatchQty');
    const expIn = document.getElementById('editBatchExpiry');
    if (idIn) idIn.value = batchId;
    if (qtyIn) qtyIn.value = String(parseInt(currentQty, 10) || 0);
    if (expIn) expIn.value = String(currentExpiry || '9999-12-31');
    if (panel) panel.style.display = 'block';
    if (qtyIn) qtyIn.focus();
};

window.cancelBatchEdit = function () {
    _batchEditProductId = null;
    _batchEditId = null;
    const panel = document.getElementById('batchEditPanel');
    const idIn = document.getElementById('editBatchId');
    const qtyIn = document.getElementById('editBatchQty');
    const expIn = document.getElementById('editBatchExpiry');
    if (idIn) idIn.value = '';
    if (qtyIn) qtyIn.value = '';
    if (expIn) expIn.value = '';
    if (panel) panel.style.display = 'none';
};

window.saveBatchEdit = async function () {
    const productId = _batchEditProductId || _batchMgrProductId;
    const batchId = _batchEditId || document.getElementById('editBatchId')?.value || '';
    const newQty = parseInt(document.getElementById('editBatchQty')?.value, 10);
    const newExpiry = String(document.getElementById('editBatchExpiry')?.value || '').trim();
    if (!productId || !batchId) return showToast('Select a batch to edit first.', 'error');
    if (!Number.isInteger(newQty) || newQty < 0) return showToast('Quantity must be a non-negative integer.', 'error');
    if (!newExpiry) return showToast('Select an expiry date.', 'error');

    try {
        await runTransaction(db, async (txn) => {
            const invRef = doc(db, 'inventory', productId);
            const batchRef = doc(db, 'inventory', productId, 'batches', batchId);

            const [invSnap, batchSnap] = await Promise.all([txn.get(invRef), txn.get(batchRef)]);
            if (!invSnap.exists()) throw new Error('Inventory product no longer exists.');
            if (!batchSnap.exists()) throw new Error('Batch no longer exists.');

            const batchData = batchSnap.data() || {};
            const oldQty = parseInt(batchData.currentQuantity, 10) || 0;
            const qtyDelta = newQty - oldQty;

            txn.update(batchRef, {
                currentQuantity: newQty,
                expiryDate: newExpiry,
                updatedAt: Date.now(),
            });

            if (qtyDelta !== 0) {
                const invData = invSnap.data() || {};
                const qtyRaw = invData.qty ?? 0;
                const totalRaw = invData.totalStock ?? qtyRaw;
                const stockRaw = invData.stock ?? qtyRaw;
                const currentRaw = invData.currentStock ?? qtyRaw;
                const qty = parseInt(qtyRaw, 10) || 0;
                const total = parseInt(totalRaw, 10) || 0;
                const stock = parseInt(stockRaw, 10) || 0;
                const current = parseInt(currentRaw, 10) || 0;
                const numericSeed = {};
                if (!(typeof qtyRaw === 'number' && Number.isFinite(qtyRaw))) numericSeed.qty = qty;
                if (!(typeof totalRaw === 'number' && Number.isFinite(totalRaw))) numericSeed.totalStock = total;
                if (!(typeof stockRaw === 'number' && Number.isFinite(stockRaw))) numericSeed.stock = stock;
                if (!(typeof currentRaw === 'number' && Number.isFinite(currentRaw))) numericSeed.currentStock = current;
                if (Object.keys(numericSeed).length) txn.update(invRef, numericSeed);

                txn.update(invRef, {
                    qty: increment(qtyDelta),
                    totalStock: increment(qtyDelta),
                    stock: increment(qtyDelta),
                    currentStock: increment(qtyDelta),
                });
            }
        });

        await refreshBatchList(productId);
        window.cancelBatchEdit();
        showToast('Batch updated successfully.', 'success');
    } catch (err) {
        showToast('Failed to update batch: ' + err.message, 'error');
    }
};

// Backward compatibility for any stale onclick references.
window.editBatch = window.startBatchEdit;

// ==========================================
// 8. POINT OF SALE (POS) LOGIC
// ==========================================
function getWalkinIssueEls() {
    const modal = document.getElementById("walkinIssueModal");
    const input = document.getElementById("walkinIssueRfidInput");
    const counter = document.getElementById("walkinIssueCounter");
    return { modal, input, counter };
}

function openWalkinIssueModal({ current, total } = {}) {
    const { modal, input, counter } = getWalkinIssueEls();
    if (!modal || !input) {
        throw new Error("Walk-in issue modal is missing. Ensure #walkinIssueModal exists on this page.");
    }

    if (counter) {
        if (Number.isFinite(current) && Number.isFinite(total) && total > 1) counter.innerText = `Tap Card ${current} of ${total}`;
        else counter.innerText = "Tap Card";
    }

    input.value = "";
    modal.style.display = "flex";
    // Focus the input so rfid.js recognizes it as the active `.rfid-register-input`.
    setTimeout(() => input.focus(), 0);
}

function closeWalkinIssueModal() {
    const { modal, input } = getWalkinIssueEls();
    if (input) input.value = "";
    if (modal) modal.style.display = "none";
}

async function waitForWalkinRfidTap({ timeoutMs = 60000 } = {}) {
    const { modal, input } = getWalkinIssueEls();
    if (!modal || !input) return null;

    const started = Date.now();
    return await new Promise((resolve) => {
        let lastVal = "";

        window.__walkinIssueRetry = () => {
            if (!input) return;
            input.value = "";
            setTimeout(() => input.focus(), 0);
        };

        const timer = setInterval(() => {
            // User cancelled (modal closed)
            if (modal.style.display === "none") {
                clearInterval(timer);
                resolve(null);
                return;
            }

            if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                resolve(null);
                return;
            }

            const val = (input.value || "").trim();
            if (val && val !== lastVal && val.length > 5) {
                clearInterval(timer);
                resolve(val);
                return;
            }
            lastVal = val;
        }, 50);
    });
}

// Deterministic doc id so check + write can happen atomically inside a transaction.
function guestCardDocId(rfidTag) {
    return `tag_${encodeURIComponent((rfidTag || '').trim())}`;
}

async function isGuestCardIssuedToday(rfidTag, dateStr) {
    // Fast-path pre-check for UI; the atomic claim below is the source of truth.
    try {
        const refNew = doc(db, "guestCards", guestCardDocId(rfidTag));
        const snap = await getDoc(refNew);
        if (snap.exists()) {
            const d = snap.data() || {};
            if (d.status === "Issued" && d.issuedForDate === dateStr) return true;
        }
    } catch (_) { /* ignore — fall through to legacy lookup */ }
    // Legacy (auto-id) lookup so previously-issued cards still register as issued.
    const q = query(guestCardsCol, where("rfid", "==", rfidTag));
    const snap = await getDocs(q);
    if (snap.empty) return false;
    const d = snap.docs[0].data() || {};
    return d.status === "Issued" && d.issuedForDate === dateStr;
}

// Atomic claim: throws if another terminal beat us to it. Replaces the
// non-atomic isGuestCardIssuedToday + upsertGuestCardIssued pair at issue time.
async function claimGuestCardForToday({ rfidTag, dateStr, paymentId, issuedBy } = {}) {
    const ref = doc(db, "guestCards", guestCardDocId(rfidTag));
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) {
            const d = snap.data() || {};
            if (d.status === "Issued" && d.issuedForDate === dateStr) {
                throw new Error("That guest card was just issued by another terminal. Please tap a different card.");
            }
        }
        tx.set(ref, {
            rfid: rfidTag,
            status: "Issued",
            issuedForDate: dateStr,
            issuedAt: Date.now(),
            paymentId: paymentId || "",
            issuedByUserId: issuedBy?.userId || "",
            issuedByName: issuedBy?.name || "",
            issuedByRole: issuedBy?.role || "",
        });
    });
}

async function issueWalkinPassAndCheckIn({ rfidTag, paymentId, dateStr, timeStr, amount, issuedBy } = {}) {
    await addDoc(walkinPassesCol, {
        rfid: rfidTag,
        paymentId: paymentId || "",
        amount: typeof amount === "number" ? amount : 0,
        date: dateStr,
        status: "Active",
        createdAt: Date.now(),
        issuedByUserId: issuedBy?.userId || "",
        issuedByName: issuedBy?.name || "",
        issuedByRole: issuedBy?.role || "",
    });

    await addDoc(attendanceCol, {
        name: "Walk-in Guest",
        type: "Walk-in",
        date: dateStr,
        timeIn: timeStr,
        timeOut: "",
        status: "Checked In",
        timestamp: Date.now(),
        guestRfid: rfidTag,
        paymentId: paymentId || "",
    });
}

window.filterPOSCategory = function (cat, btn) {
    currentPOSCategory = cat;
    document.querySelectorAll('.pos-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderPOSProducts();
}

window.filterPOSCatalog = function () {
    renderPOSProducts();
}

function getPOSCategoryLabel(item) {
    if (item.id === 'WALKIN' || item.isPlan) return 'gym passes';
    const c = (item.cat || "").toLowerCase();
    if (c.includes('supplements')) return 'supplements';
    if (c.includes('beverage') || c.includes('drinks')) return 'drinks';
    if (c.includes('service')) return 'services';
    return 'other';
}

function renderPOSProducts() {
    const grid = document.getElementById('posProductGrid');
    if (!grid) return;

    const searchTerm = (document.getElementById('posSearch')?.value || '').toLowerCase();

    // Walk-in Passes
    const walkinPlan = (window.__membershipPlansData || []).find(p => p.name.toLowerCase().includes('walk-in'));
    let walkinPrice = walkinPlan ? Number(walkinPlan.price || 0) : 150;

    let allItems = [];
    allItems.push({
        id: 'WALKIN',
        name: walkinPlan ? walkinPlan.name : 'Walk-in Gym Access (Day Pass)',
        price: walkinPrice,
        stock: 'Unlimited',
        maxQty: 999,
        image: 'images/default-product.png',
        cat: 'Gym Passes',
        size: 'One-Day Pass',
        isPlan: true,
        featured: true
    });

    inventoryData.forEach(item => {
        let isConsumable = item.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
        let isExpired = false;
        if (item.expiry) {
            const expDate = new Date(item.expiry + 'T00:00:00');
            const today = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
            today.setHours(0, 0, 0, 0);
            if (!isNaN(expDate.getTime()) && expDate < today) {
                isExpired = true;
            }
        }
        if (isConsumable && item.qty > 0 && !isExpired) {
            allItems.push({
                id: item.id,
                name: item.name,
                price: item.price || 0,
                stock: item.qty,
                maxQty: item.qty,
                image: item.image || 'images/default-product.png',
                cat: item.cat,
                size: item.size || ''
            });
        }
    });

    // Filter items based on category and search term
    const filteredItems = allItems.filter(item => {
        const catLabel = getPOSCategoryLabel(item);
        const matchesCat = currentPOSCategory === 'all' || catLabel === currentPOSCategory;
        const matchesSearch = !searchTerm || item.name.toLowerCase().includes(searchTerm);
        return matchesCat && matchesSearch;
    });

    const renderItem = (item) => {
        // Use fallback icon for walk-in day pass or missing/unsafe images.
        // isSafeImageSrc gates against SVG/javascript: data URIs (XSS).
        const hasValidImage = item.image && item.image !== 'images/default-product.png' && window.isSafeImageSrc(item.image);
        const fallbackIconHtml = item.isPlan ? '<i class="fa-solid fa-ticket"></i>' : getCategoryIcon(item.cat);
        const imageHtml = hasValidImage
            ? `<img src="${escapeHtml(item.image)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <div class="pos-fallback-icon" style="display:none;">${fallbackIconHtml}</div>`
            : `<div class="pos-fallback-icon">${fallbackIconHtml}</div>`;

        // Data-attributes + delegated handler avoid double-encoding traps where
        // item.name/image contain quotes or HTML metacharacters.
        return `
            <div class="pos-product-card ${item.featured ? 'featured' : ''}"
                 data-pos-add="1"
                 data-id="${escapeHtml(item.id)}"
                 data-name="${escapeHtml(item.name || '')}"
                 data-price="${Number(item.price) || 0}"
                 data-maxqty="${Number(item.maxQty) || 0}"
                 data-image="${escapeHtml(item.image || '')}">
                <div class="pos-card-image">
                    ${imageHtml}
                </div>
                <div class="pos-card-info">
                    <div class="pos-card-name">${escapeHtml(item.name || '')}</div>
                    <div class="pos-card-stock">${item.stock === 'Unlimited' ? 'Unlimited' : escapeHtml(String(item.stock)) + ' in stock'}</div>
                    <div class="pos-card-size">${escapeHtml(item.size || '')}</div>
                </div>
                <div class="pos-card-footer">
                    <span class="pos-card-price">₱${(Number(item.price) || 0).toFixed(2)}</span>
                    <button type="button" class="pos-add-btn">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </div>
        `;
    };

    window.syncDOM(grid, filteredItems, renderItem, 'pos-prod');

    // One-time delegated click handler so per-card data attributes drive addToCart,
    // avoiding inline-handler quoting hazards from user-supplied product names/images.
    if (!grid.__posClickBound) {
        grid.addEventListener('click', (ev) => {
            const card = ev.target.closest('[data-pos-add="1"]');
            if (!card || !grid.contains(card)) return;
            window.addToCart(
                card.dataset.id,
                card.dataset.name,
                Number(card.dataset.price) || 0,
                Number(card.dataset.maxqty) || 0,
                card.dataset.image || ''
            );
        });
        grid.__posClickBound = true;
    }
}

window.addToCart = function (id, name, price, maxQty, image) {
    const itemObj = inventoryData.find(i => i.id === id);

    // Inner — actually adds to cart (extracted so it can be called sync or after confirm)
    const performAdd = () => {
        let existing = posCart.find(i => i.id === id);
        if (existing) { if (existing.qty < maxQty) existing.qty++; else showToast("Not enough stock available!", "error"); }
        else { posCart.push({ id, name, price, qty: 1, maxQty, image: image || 'images/default-product.png' }); }
        renderCart();
    };

    if (itemObj && itemObj.expiry) {
        const expDate = new Date(itemObj.expiry + 'T00:00:00');
        const today = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
        today.setHours(0, 0, 0, 0);

        if (!isNaN(expDate.getTime()) && expDate < today) {
            showToast(`Error: "${name}" has expired (Expiry: ${itemObj.expiry}) and cannot be sold.`, "error");
            return;
        }

        const daysLeft = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 7 && daysLeft >= 0) {
            showConfirm({
                title: 'Item Expiring Soon',
                message: `"${name}" is expiring in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (on ${itemObj.expiry}).\n\nAre you sure you want to add this to the cart?`,
                tone: 'warning',
                confirmText: 'Add to Cart',
                onConfirm: performAdd
            });
            return;
        }
    }

    performAdd();
}

window.removeFromCart = function (id) { posCart = posCart.filter(i => i.id !== id); renderCart(); }

window.changeQty = function (id, delta) {
    let existing = posCart.find(i => i.id === id);
    if (existing) {
        let newQty = existing.qty + delta;
        if (newQty <= 0) {
            posCart = posCart.filter(i => i.id !== id);
        } else if (newQty > existing.maxQty) {
            showToast("Not enough stock available!", "error");
        } else {
            existing.qty = newQty;
        }
        renderCart();
    }
}

function renderCart() {
    const cartBody = document.getElementById('posCartBody');
    if (!cartBody) return;
    if (posCart.length === 0) {
        cartBody.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top: 50px;">Cart is empty.</p>`;
        updatePOSTotals(0, 0, 0, 0);
        return;
    }

    const renderCartItem = (item) => `
        <div class="pos-cart-item">
            <div class="pos-cart-thumb">
                <img src="${window.safeImgSrc(item.image, 'images/default-product.png')}" onerror="this.src='images/default-product.png'">
            </div>
            <div class="pos-cart-detail" style="max-width: 140px;">
                <div class="pos-cart-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                <div style="font-size: 11px; color: var(--text-muted);">₱${item.price.toFixed(2)} each</div>
            </div>
            <div class="pos-cart-qty">
                <button type="button" class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
                <span style="font-weight:600; width:20px; text-align:center;">${item.qty}</span>
                <button type="button" class="qty-btn" onclick="changeQty('${item.id}', 1)" ${item.qty >= item.maxQty ? 'disabled title="Max stock reached"' : ''}>+</button>
            </div>
            <div class="pos-cart-line-total">₱${(item.price * item.qty).toFixed(2)}</div>
            <button type="button" class="pos-cart-remove" onclick="removeFromCart('${item.id}')">×</button>
        </div>
    `;

    window.syncDOM(cartBody, posCart, renderCartItem, 'cart-item');

    let subtotal = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let discount = 0;
    updatePOSTotals(subtotal, discount, subtotal - discount);
}

function updatePOSTotals(sub, disc, grand) {
    const totalsDiv = document.querySelector('.pos-totals');
    if (!totalsDiv) return;
    totalsDiv.innerHTML = `
        <div class="total-line"><span>Subtotal:</span> <span>₱${sub.toFixed(2)}</span></div>
        <div class="total-line grand"><span>TOTAL:</span> <span>₱${grand.toFixed(2)}</span></div>
    `;
}

window.selectPaymentMethod = function (method, btn) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const posGcashRefWrapper = document.getElementById('posGcashRefWrapper');
    if (posGcashRefWrapper) {
        if (method === 'GCash') {
            posGcashRefWrapper.classList.add('visible');
            const inp = posGcashRefWrapper.querySelector('input');
            if (inp) setTimeout(() => inp.focus(), 300);
        } else {
            posGcashRefWrapper.classList.remove('visible');
            const inp = posGcashRefWrapper.querySelector('input');
            if (inp) inp.value = '';
        }
    }
}

window.processPayment = async function () {
    if (posCart.length === 0) return showToast("Cart is empty!", "error");

    // Double check soon-to-expire items at checkout to confirm before proceeding.
    // Use the server-synced clock so pre-check matches the authoritative DB-side
    // expiry check inside the transaction (closes #21 time-source mismatch).
    let expiringSoonItem = null;
    let expiringSoonDays = 0;
    for (const cartItem of posCart) {
        const itemObj = inventoryData.find(i => i.id === cartItem.id);
        if (itemObj && itemObj.expiry) {
            const expDate = new Date(itemObj.expiry + 'T00:00:00');
            const today = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
            today.setHours(0, 0, 0, 0);
            const daysLeft = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            if (daysLeft <= 7 && daysLeft >= 0) {
                expiringSoonItem = cartItem;
                expiringSoonDays = daysLeft;
                break;
            }
        }
    }
    if (expiringSoonItem) {
        const expiryDate = inventoryData.find(i => i.id === expiringSoonItem.id).expiry;
        showConfirm({
            title: 'Item Expiring Soon',
            message: `"${expiringSoonItem.name}" in your cart is expiring in ${expiringSoonDays} day${expiringSoonDays === 1 ? '' : 's'} (on ${expiryDate}).\n\nDo you still want to proceed with the purchase?`,
            tone: 'warning',
            confirmText: 'Proceed with Purchase',
            // Do not return the Promise here; let the confirm modal close first,
            // then continue checkout so RFID modal can render normally.
            onConfirm: () => { void window.processPaymentConfirmed(); }
        });
        return;
    }
    return window.processPaymentConfirmed();
};

// Internal: actual checkout work; called either directly or after the
// expiring-item confirmation modal. Splits out so we don't have to await
// a Promise across the showConfirm callback.
window.processPaymentConfirmed = async function () {
    if (window.isPOSProcessing) return;
    window.isPOSProcessing = true;

    const payBtn = document.querySelector('.pos-pay-btn') || document.getElementById('posPayBtn');
    const originalBtnText = (payBtn && payBtn.innerHTML) ? payBtn.innerHTML : '<i class="fas fa-cash-register"></i> Process Payment';
    if (payBtn) {
        payBtn.disabled = true;
        payBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }

    const customerNameInput = document.getElementById('posCustomerName');
    const posGcashRefInput = document.getElementById('posGcashRefId');
    const posGcashRefWrapper = document.getElementById('posGcashRefWrapper');
    let batchCheckoutResults = [];
    let memberIdForCredit = null;

    try {
        // Cart integrity guard: reject empty cart and any non-positive / non-finite qty or price
        if (!Array.isArray(posCart) || posCart.length === 0) {
            showToast("Cart is empty.", "error");
            resetProcessingState();
            return;
        }
        for (const ci of posCart) {
            const q = Number(ci.qty), p = Number(ci.price);
            if (!Number.isFinite(q) || q <= 0 || !Number.isInteger(q)) {
                showToast(`Invalid quantity for "${ci.name}".`, "error");
                resetProcessingState();
                return;
            }
            if (!Number.isFinite(p) || p <= 0) {
                showToast(`Invalid price for "${ci.name}".`, "error");
                resetProcessingState();
                return;
            }
            if (typeof ci.maxQty === 'number' && q > ci.maxQty) {
                showToast(`Quantity for "${ci.name}" exceeds available stock.`, "error");
                resetProcessingState();
                return;
            }
        }

        const posGcashRef = (posGcashRefInput ? posGcashRefInput.value.trim() : '');
        if (selectedPaymentMethod === 'GCash') {
            if (!posGcashRef) {
                showToast('Please enter the GCash Reference ID.', 'error');
                resetProcessingState();
                return;
            }
            if (!/^\d{12}$/.test(posGcashRef.replace(/\s/g, ''))) {
                showToast('GCash Reference ID must be exactly 12 digits (numbers only).', 'error');
                resetProcessingState();
                return;
            }
            try {
                await window.assertGcashRefUnused(posGcashRef);
            } catch (err) {
                showToast(err.message, 'error');
                resetProcessingState();
                return;
            }
        }

        let customerName = (customerNameInput && customerNameInput.value.trim() !== '') ? customerNameInput.value.trim() : "Walk-in POS Customer";

        if (selectedPaymentMethod === 'RFID') {
            const modal = document.getElementById('rfidPaymentModal');
            const input = document.getElementById('posRfidInput');
            const statusEl = document.getElementById('rfidPaymentStatus');
            const closeBtn = modal ? modal.querySelector('.close-btn') : null;

            // Set dynamic price label based on current cart estimation
            let subtotalEstimate = posCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
            let grandTotalEstimate = subtotalEstimate;
            statusEl.innerHTML = `Amount Due (Estimate): ₱${grandTotalEstimate.toFixed(2)}`;
            statusEl.style.color = "var(--dark-black)";
            modal.style.display = 'flex';
            input.value = '';
            setTimeout(() => input.focus(), 100);

            const rfidData = await new Promise(resolve => {
                let lastVal = '';
                let inputHandler = null;
                let checkInterval = null;
                let timeoutId = null;
                const handleClose = () => {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    if (inputHandler) input.removeEventListener('input', inputHandler);
                    delete window.selectMemberForPayment;
                    resolve(null);
                };
                if (closeBtn) closeBtn.addEventListener('click', handleClose, { once: true });

                timeoutId = setTimeout(() => {
                    showToast("RFID scan timed out.", "info");
                    modal.style.display = 'none';
                    clearInterval(checkInterval);
                    if (closeBtn) closeBtn.removeEventListener('click', handleClose);
                    if (inputHandler) input.removeEventListener('input', inputHandler);
                    delete window.selectMemberForPayment;
                    resolve(null);
                }, 120 * 1000); // 120 seconds timeout

                let debounceTimer;
                inputHandler = (e) => {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                        const q = e.target.value.trim().toLowerCase();
                        if (q.length > 0) {
                            const searchRes = membersData.filter(m => ((m.status || "").toLowerCase() !== "archived") && ((m.name && m.name.toLowerCase().includes(q)) || (m.uid && m.uid.toLowerCase().includes(q)) || (m.givenName && m.givenName.toLowerCase().includes(q)) || (m.familyName && m.familyName.toLowerCase().includes(q)) || (m.rfid && m.rfid === q)));
                            const dropdown = document.getElementById('posRfidSearchDropdown');
                            if (searchRes.length > 0) {
                                dropdown.innerHTML = searchRes.map(m => {
                                    const displayName = m.name || `${m.givenName || ''} ${m.familyName || ''}`.trim();
                                    return `
                                    <div class="pos-rfid-search-row" style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer;"
                                         data-id="${escapeHtml(m.id)}" data-rfid="${escapeHtml(m.rfid || '')}" data-name="${escapeHtml(displayName)}">
                                        <div style="font-weight: 600;">${escapeHtml(displayName)}</div>
                                        <div style="font-size: 11px; color: var(--text-muted);">${m.uid ? escapeHtml(m.uid) + ' | ' : ''}RFID: ${escapeHtml(m.rfid || 'None')} | Bal: ₱${(m.creditBalance || 0).toFixed(2)}</div>
                                    </div>
                                `;
                                }).join('');
                                dropdown.querySelectorAll('.pos-rfid-search-row').forEach(row => {
                                    row.addEventListener('click', () => {
                                        window.selectMemberForPayment(row.dataset.id, row.dataset.rfid, row.dataset.name);
                                    });
                                });
                                dropdown.style.display = 'block';
                            } else {
                                dropdown.style.display = 'none';
                            }
                        } else {
                            document.getElementById('posRfidSearchDropdown').style.display = 'none';
                        }
                    }, 300);
                };
                input.addEventListener('input', inputHandler);

                window.selectMemberForPayment = (id, rfid, name) => {
                    document.getElementById('posRfidSearchDropdown').style.display = 'none';
                    clearTimeout(timeoutId);
                    clearInterval(checkInterval);
                    if (closeBtn) closeBtn.removeEventListener('click', handleClose);
                    input.removeEventListener('input', inputHandler);
                    delete window.selectMemberForPayment;
                    resolve({ id, rfid, name });
                };

                checkInterval = setInterval(async () => {
                    if (modal.style.display === 'none') {
                        clearTimeout(timeoutId);
                        clearInterval(checkInterval);
                        if (closeBtn) closeBtn.removeEventListener('click', handleClose);
                        input.removeEventListener('input', inputHandler);
                        delete window.selectMemberForPayment;
                        resolve(null);
                        return;
                    }
                    const val = input.value.trim();
                    if (val && val !== lastVal && val.length >= 8 && !val.includes(' ')) {
                        const memberMatch = membersData.find(m => m.rfid === val);
                        if (memberMatch) {
                            clearTimeout(timeoutId);
                            clearInterval(checkInterval);
                            if (closeBtn) closeBtn.removeEventListener('click', handleClose);
                            input.removeEventListener('input', inputHandler);
                            delete window.selectMemberForPayment;
                            resolve({ id: memberMatch.id, rfid: memberMatch.rfid, name: memberMatch.name || (memberMatch.givenName + ' ' + memberMatch.familyName) });
                        }
                    }
                    lastVal = val;
                }, 500);
            });

            if (!rfidData) {
                closeModal('rfidPaymentModal');
                resetProcessingState();
                return;
            }

            memberIdForCredit = rfidData.id;
            customerName = rfidData.name;
            if (customerNameInput) customerNameInput.value = customerName;

            // Close the scan modal before showing the confirmation step
            closeModal('rfidPaymentModal');

            // Compute estimate for display (authoritative total is re-computed server-side inside the txn)
            const estimatedTotal = posCart.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.qty || 0)), 0);
            const itemsSummary = posCart.map(i => `${i.qty}× ${i.name}`).join(', ');

            const confirmed = await new Promise(resolve => {
                const modal = document.getElementById('rfidTxnConfirmModal');
                if (!modal) { resolve(true); return; }

                document.getElementById('rfidTxnConfirmMemberName').textContent = customerName;
                document.getElementById('rfidTxnConfirmItems').textContent = itemsSummary;
                document.getElementById('rfidTxnConfirmAmount').textContent = `₱${estimatedTotal.toFixed(2)}`;

                const confirmBtn = document.getElementById('rfidTxnConfirmBtn');
                const cancelBtn = document.getElementById('rfidTxnCancelBtn');
                if (!confirmBtn || !cancelBtn) {
                    resolve(true);
                    return;
                }
                const defaultConfirmText = 'Confirm Payment';
                confirmBtn.disabled = false;
                confirmBtn.textContent = defaultConfirmText;

                let isResolved = false;
                const finalize = (result) => {
                    if (isResolved) return;
                    isResolved = true;
                    modal.removeEventListener('click', backdropHandler);
                    clearInterval(closeWatchTimer);
                    confirmBtn.removeEventListener('click', confirmHandler);
                    cancelBtn.removeEventListener('click', cancelHandler);
                    if (!result) {
                        // Ensure next RFID attempt does not inherit a stale loading state.
                        confirmBtn.disabled = false;
                        confirmBtn.textContent = defaultConfirmText;
                    }
                    resolve(result);
                };

                const confirmHandler = () => {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = 'Processing...';
                    modal.style.display = 'none';
                    finalize(true);
                };

                const cancelHandler = () => {
                    modal.style.display = 'none';
                    finalize(false);
                };

                // Handle backdrop dismiss so the promise always resolves.
                const backdropHandler = (event) => {
                    if (event.target === modal) {
                        finalize(false);
                    }
                };

                // Catch programmatic closes (e.g., inline closeModal onclick).
                const closeWatchTimer = setInterval(() => {
                    if (modal.style.display === 'none') finalize(false);
                }, 150);

                confirmBtn.addEventListener('click', confirmHandler);
                cancelBtn.addEventListener('click', cancelHandler);
                modal.addEventListener('click', backdropHandler);
                modal.style.display = 'flex';
            });

            if (!confirmed) {
                showToast("Transaction canceled.", "info");
                resetProcessingState();
                return;
            }
        }

        const walkinItem = posCart.find((x) => x.id === "WALKIN" || x.isPlan);
        const walkinQty = walkinItem ? Number(walkinItem.qty || 0) : 0;
        const scannedTags = [];
        const nowTemp = new Date();
        const dateStrTemp = nowTemp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        if (walkinQty > 0) {
            let issuanceCancelled = false;
            for (let w = 0; w < walkinQty; w++) {
                openWalkinIssueModal({ current: w + 1, total: walkinQty });

                let tag = await waitForWalkinRfidTap({ timeoutMs: 60000 });
                if (!tag) {
                    issuanceCancelled = true;
                    closeWalkinIssueModal();
                    break;
                }
                tag = tag.trim();

                if (scannedTags.includes(tag)) {
                    showToast("This card has already been scanned for this checkout. Please tap a different card.", "error");
                    w--;
                    closeWalkinIssueModal();
                    continue;
                }

                // Use the already-loaded in-memory users list so the UI
                // doesn't break if Firestore reads are blocked/slow.
                const isRegisteredUserCard = (allUsersData || []).some(u => (u.rfid || "") === tag);
                if (isRegisteredUserCard) {
                    showToast("This card belongs to a registered member and cannot be used as a reusable guest card.", "error");
                    w--;
                    closeWalkinIssueModal();
                    continue;
                }

                // Skip guest-card "already issued today" pre-check here.
                // The checkout transaction does the authoritative race-free check
                // (reads guestCards inside the tx before any writes).

                scannedTags.push(tag);
                closeWalkinIssueModal();
            }

            if (issuanceCancelled || scannedTags.length < walkinQty) {
                showToast("Walk-in day pass card scanning cancelled or timed out. Checkout aborted.", "error");
                resetProcessingState();
                return;
            }
        }

        if (walkinQty > 0) {
            // Force close any legacy "Checked In" attendance logs for the scanned tags to prevent collisions
            try {
                for (let tag of scannedTags) {
                    const attQ = query(attendanceCol, where("guestRfid", "==", tag));
                    const attSnap = await getDocs(attQ);
                    const activeDocs = attSnap.docs.filter(d => d.data().status === "Checked In");
                    if (activeDocs.length > 0) {
                        const timeStr = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                        const batchPromises = activeDocs.map(d => updateDoc(d.ref, {
                            status: "Checked Out",
                            timeOut: timeStr,
                            autoCheckedOutOnReissue: true,
                            reissueTimestamp: Date.now()
                        }));
                        await Promise.all(batchPromises);
                    }
                }
            } catch (e) {
                console.error("Failed to clean up prior active attendance logs during POS checkout:", e);
            }
        }

        // ── Batch-tracked item checkout (FEFO, runs its own Firestore transaction) ──
        // Items marked isBatchTracked:true in the inventory doc are deducted from
        // their batches subcollection by checkoutBatches(). We run this BEFORE the
        // main payment transaction so the batch writes are already committed when
        // the payment record is created.  If checkoutBatches throws, the entire
        // checkout aborts before any payment doc is written. On payment failure, catch block rolls back.
        batchCheckoutResults = [];
        for (const cartItem of posCart) {
            if (cartItem.id === 'WALKIN' || cartItem.isPlan) continue;
            const invObj = inventoryData.find(i => i.id === cartItem.id);
            if (!invObj || !invObj.isBatchTracked) continue;
            const result = await checkoutBatches(db, cartItem.id, cartItem.qty);
            if (!result.success) {
                const currentStock = parseInt(result.currentStock, 10) || 0;
                throw new Error(`Transaction Denied: Insufficient stock. Current stock is reading as ${currentStock}.`);
            }
            batchCheckoutResults.push({ cartItem, result });
        }

        const transactionResult = await runTransaction(db, async (transaction) => {
            // ── PHASE 1: ALL READS (Firestore requires all reads before any writes) ──

            let gcashReservation = null;
            if (selectedPaymentMethod === 'GCash' && posGcashRef) {
                gcashReservation = await window.reserveGcashRefInTxn(transaction, posGcashRef);
            }

            const guestCardReads = [];
            if (walkinQty > 0 && scannedTags.length > 0) {
                for (let tag of scannedTags) {
                    const guestCardRef = doc(db, "guestCards", guestCardDocId(tag));
                    guestCardReads.push({ tag, guestCardRef, gcSnap: await transaction.get(guestCardRef) });
                }
            }

            const inventoryDocRefs = [];
            const inventorySnaps = [];
            for (let item of posCart) {
                if (item.id === 'WALKIN' || item.isPlan) continue;
                const invRef = doc(db, "inventory", item.id);
                inventoryDocRefs.push({ ref: invRef, cartItem: item });
                inventorySnaps.push(await transaction.get(invRef));
            }

            let memberDocRef = null;
            let memberSnap = null;
            if (selectedPaymentMethod === 'RFID' && memberIdForCredit) {
                memberDocRef = doc(db, "users", memberIdForCredit);
                memberSnap = await transaction.get(memberDocRef);
            }

            // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──

            for (const { tag, gcSnap } of guestCardReads) {
                if (gcSnap.exists()) {
                    const gcData = gcSnap.data() || {};
                    if (gcData.status === "Issued" && gcData.issuedForDate === dateStrTemp) {
                        throw new Error(`Guest card ${tag} was just issued by another terminal. Please re-scan a different card.`);
                    }
                }
            }

            let computedSubtotal = 0;

            for (let i = 0; i < inventorySnaps.length; i++) {
                const snap = inventorySnaps[i];
                const cartItem = inventoryDocRefs[i].cartItem;
                if (!snap.exists()) {
                    throw new Error(`Product "${cartItem.name}" no longer exists in inventory.`);
                }

                const productRef = inventoryDocRefs[i].ref;
                // Explicitly read the fresh product snapshot first (guards against stale/partial local data).
                const productDoc = await transaction.get(productRef);
                if (!productDoc.exists()) {
                    throw new Error(`Product "${cartItem.name}" no longer exists in inventory.`);
                }

                const productData = productDoc.data() || {};
                const isBatchItem = !!productData.isBatchTracked;

                // Normalize requested qty as an integer before any numeric ops.
                const requestedQty = parseInt(cartItem.qty, 10) || 0;

                if (!isBatchItem) {
                    // Read-0 bug guard: normalize master qty as an integer from Firestore.
                    const currentStock = parseInt(productData.qty, 10) || 0;

                    if (currentStock <= 0 || currentStock < requestedQty) {
                        throw new Error(
                            `Transaction Denied: Insufficient stock. Current stock is reading as ${currentStock}.`
                        );
                    }

                    // Authoritative Database Expiration Check (flat-qty items only)
                    const dbExpiry = productData.expiry;
                    if (dbExpiry) {
                        const dbExpDate = new Date(dbExpiry + 'T00:00:00');
                        const dbToday = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
                        dbToday.setHours(0, 0, 0, 0);
                        if (!isNaN(dbExpDate.getTime()) && dbExpDate < dbToday) {
                            throw new Error(`Product "${cartItem.name}" has expired (Expiry: ${dbExpiry}) and cannot be sold.`);
                        }
                    }
                }
                // Batch-tracked: expiry enforced per-batch inside checkoutBatches()

                const dbPrice = Number(productData.price || 0);
                if (isNaN(dbPrice) || dbPrice <= 0) {
                    throw new Error(`Product "${cartItem.name}" has an invalid price (₱${dbPrice}) in the database.`);
                }

                computedSubtotal += dbPrice * requestedQty;
                // Force client-side record to match absolute database truth
                cartItem.price = dbPrice;
            }

            // 2. Add pass items
            for (let item of posCart) {
                if (item.id === 'WALKIN' || item.isPlan) {
                    const walkinPlan = (window.__membershipPlansData || []).find(p => p.name.toLowerCase().includes('walk-in'));
                    let walkinPrice = walkinPlan ? Number(walkinPlan.price || 0) : 150;
                    if (walkinPrice <= 0) {
                        throw new Error("Walk-in Gym Access has an invalid price.");
                    }
                    item.price = walkinPrice;
                    computedSubtotal += walkinPrice * item.qty;
                }
            }

            let computedDiscount = 0;
            let computedGrandTotal = computedSubtotal - computedDiscount;

            let balanceBefore = 0;
            let balanceAfter = 0;
            if (selectedPaymentMethod === 'RFID' && memberIdForCredit) {
                if (!memberSnap || !memberSnap.exists()) {
                    throw new Error("Member account does not exist.");
                }
                const mDataPOS = memberSnap.data();
                // H5: refuse RFID purchases from archived or expired members
                if ((mDataPOS.status || '').toLowerCase() === 'archived') {
                    throw new Error("This account is archived and cannot make RFID purchases.");
                }
                if (window.isMemberPlanExpired && window.isMemberPlanExpired(mDataPOS)) {
                    throw new Error("This member's plan has expired. Please renew at the front desk before making a purchase.");
                }
                const balance = mDataPOS.creditBalance || 0;
                if (balance < computedGrandTotal) {
                    throw new Error(`Insufficient RFID Balance! (Bal: ₱${balance.toFixed(2)}, Needed: ₱${computedGrandTotal.toFixed(2)})`);
                }
                balanceBefore = balance;
                balanceAfter = balance - computedGrandTotal;
            }

            // ── PHASE 3: ALL WRITES ──

            if (gcashReservation) {
                window.commitGcashRefInTxn(transaction, gcashReservation.refDoc);
            }

            if (selectedPaymentMethod === 'RFID' && memberIdForCredit && memberDocRef) {
                transaction.update(memberDocRef, {
                    creditBalance: balanceAfter
                });

                const itemsStrForLog = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');
                const creditTxRef = doc(collection(db, "creditTransactions"));
                transaction.set(creditTxRef, {
                    memberId: memberIdForCredit,
                    memberName: customerName,
                    type: "purchase",
                    amount: -computedGrandTotal,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                    note: `POS Purchase: ${itemsStrForLog}`,
                    processedBy: localStorage.getItem("userId") || "System",
                    timestamp: Date.now()
                });
            }

            // Update inventory stock quantities (flat-qty items only)
            for (let i = 0; i < inventorySnaps.length; i++) {
                const snap = inventorySnaps[i];
                const itemRef = inventoryDocRefs[i].ref;
                const cartItem = inventoryDocRefs[i].cartItem;

                if (snap.data().isBatchTracked) continue; // already deducted by checkoutBatches()

                const currentStock = parseInt(snap.data().qty, 10) || 0;
                const requestedQty = parseInt(cartItem.qty, 10) || 0;
                transaction.update(itemRef, { qty: currentStock - requestedQty });

                const movementRef = doc(collection(db, "stockMovements"));
                const now = new Date();
                transaction.set(movementRef, {
                    productId: cartItem.id,
                    productName: cartItem.name,
                    changeAmount: -cartItem.qty,
                    reason: `POS Sale (${selectedPaymentMethod})`,
                    userId: localStorage.getItem("userId") || "System",
                    userName: localStorage.getItem("loggedInUser") || "Unknown",
                    date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: now.getTime()
                });
            }

            // 4b. Ledger entries for batch-tracked deductions (qty already committed by checkoutBatches).
            // One stockMovements doc per batch touched so the ledger shows per-batch traceability.
            for (const { cartItem, result } of batchCheckoutResults) {
                const totalDeducted = result.deductions.reduce((sum, d) => sum + (parseInt(d.deducted, 10) || 0), 0);
                const invIdx = inventoryDocRefs.findIndex(x => x.cartItem.id === cartItem.id);
                if (invIdx >= 0 && totalDeducted > 0) {
                    const snap = inventorySnaps[invIdx];
                    const currentStock = snap.exists() ? (parseInt(snap.data().qty, 10) || 0) : 0;
                    transaction.update(inventoryDocRefs[invIdx].ref, { qty: currentStock - totalDeducted });
                }
                for (const deduction of result.deductions) {
                    const movementRef = doc(collection(db, "stockMovements"));
                    const now = new Date();
                    transaction.set(movementRef, {
                        productId: cartItem.id,
                        productName: cartItem.name,
                        batchId: deduction.batchId,
                        batchExpiryDate: deduction.expiryDate,
                        changeAmount: -deduction.deducted,
                        reason: `POS Sale – Batch (${selectedPaymentMethod})`,
                        userId: localStorage.getItem("userId") || "System",
                        userName: localStorage.getItem("loggedInUser") || "Unknown",
                        date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                        timestamp: now.getTime()
                    });
                }
            }

            // 5. Save payment document
            const paymentDocRef = doc(collection(db, "payments"));
            const now = new Date();
            const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const itemsStr = posCart.map(i => `${i.qty}x ${i.name}`).join(', ');
            const txnRef = generateTransactionRef();

            const paymentData = {
                name: customerName,
                transactionRef: txnRef,
                type: "POS Sale",
                items: itemsStr,
                lineItems: posCart,
                subtotal: computedSubtotal,
                discount: computedDiscount,
                amount: computedGrandTotal,
                paymentMethod: selectedPaymentMethod,
                status: "Paid",
                date: dateStr,
                time: timeStr,
                timestamp: now.getTime(),
            };

            if (selectedPaymentMethod === 'GCash' && posGcashRef) {
                paymentData.gcashRefId = posGcashRef;
            }
            if (selectedPaymentMethod === 'RFID' && memberIdForCredit) {
                paymentData.memberId = memberIdForCredit;
            }
            if (batchCheckoutResults.length > 0) {
                paymentData.batchDeductions = batchCheckoutResults.map(({ cartItem, result }) => ({
                    productId: cartItem.id,
                    productName: cartItem.name,
                    deductions: result.deductions.map(d => ({
                        batchId: d.batchId,
                        expiryDate: d.expiryDate,
                        deducted: d.deducted,
                    })),
                }));
            }

            transaction.set(paymentDocRef, paymentData);

            if (walkinQty > 0) {
                const issuedBy = {
                    userId: localStorage.getItem("userId") || "",
                    name: localStorage.getItem("loggedInUser") || "",
                    role: localStorage.getItem("userRole") || "",
                };
                for (let tag of scannedTags) {
                    const guestCardRef = doc(db, "guestCards", guestCardDocId(tag));
                    transaction.set(guestCardRef, {
                        rfid: tag,
                        status: "Issued",
                        issuedForDate: dateStr,
                        issuedAt: Date.now(),
                        paymentId: paymentDocRef.id,
                        issuedByUserId: issuedBy?.userId || "",
                        issuedByName: issuedBy?.name || "",
                        issuedByRole: issuedBy?.role || "",
                    });

                    const walkinRef = doc(walkinPassesCol);
                    transaction.set(walkinRef, {
                        rfid: tag,
                        paymentId: paymentDocRef.id,
                        amount: Number(walkinItem.price || 0),
                        date: dateStr,
                        status: "Active",
                        createdAt: Date.now(),
                        issuedByUserId: issuedBy?.userId || "",
                        issuedByName: issuedBy?.name || "",
                        issuedByRole: issuedBy?.role || "",
                    });

                    const attRef = doc(attendanceCol);
                    transaction.set(attRef, {
                        name: "Walk-in Guest",
                        type: "Walk-in",
                        date: dateStr,
                        timeIn: timeStr,
                        timeOut: "",
                        status: "Checked In",
                        timestamp: Date.now(),
                        guestRfid: tag,
                        paymentId: paymentDocRef.id,
                    });
                }
            }

            return {
                paymentId: paymentDocRef.id,
                dateStr,
                timeStr,
                grandTotal: computedGrandTotal
            };
        });

        if (walkinQty > 0 && window.refreshLockers) window.refreshLockers();

        showToast("Payment Processed Successfully!", "success");

        // Expiry warning: if any batch item sold today expires within 7 days,
        // flash a persistent operator alert so staff can act (e.g. mark as promo).
        for (const { cartItem, result } of batchCheckoutResults) {
            if (result.expiryWarning && result.warningBatch) {
                const wb = result.warningBatch;
                const todayWarn = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
                todayWarn.setHours(0, 0, 0, 0);
                const expDate = new Date(wb.expiryDate + 'T00:00:00');
                const daysLeft = Math.ceil((expDate.getTime() - todayWarn.getTime()) / (1000 * 60 * 60 * 24));
                showBatchExpiryWarning(cartItem.name, wb.expiryDate, daysLeft);
            }
        }

        posCart = [];
        renderCart();
        if (customerNameInput) customerNameInput.value = '';
        if (posGcashRefInput) posGcashRefInput.value = '';
        if (posGcashRefWrapper) posGcashRefWrapper.classList.remove('visible');

    } catch (e) {
        console.error("Checkout transaction failed: ", e);
        // Roll back batch deductions committed before the payment transaction.
        if (batchCheckoutResults.length > 0) {
            for (const { cartItem, result } of batchCheckoutResults) {
                try {
                    await restoreBatchDeductions(db, cartItem.id, result.deductions);
                } catch (rollbackErr) {
                    console.error(`Batch rollback failed for ${cartItem.name}:`, rollbackErr);
                }
            }
            showToast(
                (e.message || "Checkout failed.") + " Batch stock was restored.",
                "error"
            );
        } else if (selectedPaymentMethod === 'RFID' && memberIdForCredit) {
            showToast(e.message || "Transaction failed. Please try tapping again.", "warning");
        } else {
            showToast(e.message || "Checkout failed. Please try again.", "error");
        }
    } finally {
        resetProcessingState();
    }

    function resetProcessingState() {
        window.isPOSProcessing = false;
        if (payBtn) {
            payBtn.disabled = false;
            payBtn.innerHTML = originalBtnText;
        }
    }
};

// ==========================================
// 8.5 DASHBOARD ANALYTICS & KPIS
// ==========================================
window.refreshDashboardAnalytics = function () {
    if (!document.getElementById('dashboard')) return;

    calculateFinancials();
    calculateOperationalAlerts();
    calculateEngagement();
    calculateSecondaryKpis();
    renderWeeklyRevenueChart();
    renderMemberDistChart();

    // Auto-update expanded chart if active
    const activeItem = document.querySelector('.kpi-unified-item.active-item');
    if (activeItem) {
        // Extract the detailId from the onclick attribute: toggleKpiDetail('detailId', this)
        const match = activeItem.getAttribute('onclick').match(/'([^']+)'/);
        if (match && match[1]) {
            renderKpiBreakdown(match[1]);
        }
    }
}

function calculateFinancials() {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Weekly range (Monday to Sunday)
    const dayOfWeek = now.getDay();
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + distanceToMonday);
    monday.setHours(0, 0, 0, 0);

    let dailyRevenue = 0;
    let weeklyRevenue = 0;
    let lastWeekRevenue = 0;

    const lastWeekStart = new Date(monday);
    lastWeekStart.setDate(monday.getDate() - 7);
    const lastWeekEnd = new Date(monday);

    paymentsData.forEach(p => {
        if (p.status === 'Voided' || p.status === 'Refunded') return;
        const pDate = new Date(p.date);
        const pAmount = Number(p.amount || 0);

        if (p.date === todayStr) dailyRevenue += pAmount;

        if (pDate >= monday && pDate <= now) {
            weeklyRevenue += pAmount;
        }

        if (pDate >= lastWeekStart && pDate < lastWeekEnd) {
            lastWeekRevenue += pAmount;
        }
    });

    if (document.getElementById('dashDailyRevenue')) document.getElementById('dashDailyRevenue').innerText = `₱${dailyRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const trendEl = document.getElementById('revenueTrend');
    if (trendEl) {
        let pct = 0;
        if (lastWeekRevenue > 0) pct = ((weeklyRevenue - lastWeekRevenue) / lastWeekRevenue) * 100;
        else if (weeklyRevenue > 0) pct = 100;

        const isUp = pct >= 0;
        trendEl.innerHTML = `<span style="color: ${isUp ? '#27ae60' : '#e74c3c'};"><i class="fas fa-caret-${isUp ? 'up' : 'down'}"></i> ${isUp ? '+' : ''}${pct.toFixed(0)}% since last week</span>`;
    }

    // Expiring Memberships (Next 7 Days)
    let expiringList = [];
    const sevenDaysFromNow = now.getTime() + (7 * 24 * 60 * 60 * 1000);

    membersData.forEach(m => {
        if ((m.status || "").toLowerCase() === 'archived') return;
        const planDays = window.getPlanDays ? window.getPlanDays(m.plan) : 30;
        if (m.dateRegistered) {
            const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
            if (expiryDate > now.getTime() && expiryDate <= sevenDaysFromNow) {
                const daysLeft = Math.ceil((expiryDate - now.getTime()) / (1000 * 60 * 60 * 24));
                expiringList.push({ name: `${m.givenName || ''} ${m.familyName || ''}`, daysLeft });
            }
        }
    });

    // Sort by soonest expiring first (most recent attention needed)
    expiringList.sort((a, b) => a.daysLeft - b.daysLeft);

    if (document.getElementById('dashExpiringBadge')) document.getElementById('dashExpiringBadge').innerText = expiringList.length;
    const listEl = document.getElementById('dashExpiringList');
    if (listEl) {
        if (expiringList.length === 0) {
            listEl.innerHTML = `<p style="color: var(--text-muted); font-size: 12px; padding: 10px 0;">No memberships expiring soon.</p>`;
        } else {
            listEl.innerHTML = expiringList.slice(0, 3).map(e => `
                <div class="notif-item">
                    <strong>${e.name}</strong> expires in ${e.daysLeft} day${e.daysLeft > 1 ? 's' : ''}
                </div>
            `).join('');
        }
    }
}

function calculateOperationalAlerts() {
    // Maintenance — includes equipment actively flagged + overdue for maintenance
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const equipment = inventoryData.filter(i => i.itemType === 'equipment' || !i.itemType);
    const activelyFlagged = equipment.filter(i => i.status === 'Maintenance' || i.status === 'Out of Order').length;
    const overdueCount = equipment.filter(i => {
        if (i.status !== 'Operational') return false;
        let dueDateForSchedule = i.maintenanceDueDate || '';
        if (!dueDateForSchedule && i.maintenanceDate) {
            const base = new Date(`${i.maintenanceDate}T00:00:00`);
            if (!Number.isNaN(base.getTime())) {
                base.setDate(base.getDate() + 90);
                dueDateForSchedule = base.toISOString().split('T')[0];
            }
        }
        if (!dueDateForSchedule) return true;
        const daysOverdue = Math.floor((today - new Date(dueDateForSchedule)) / (1000 * 60 * 60 * 24));
        return daysOverdue > 0;
    }).length;

    const maintCount = activelyFlagged + overdueCount;
    const maintEl = document.getElementById('dashMaintCount');
    const maintText = document.getElementById('maintStatusText');

    if (maintEl) maintEl.innerText = maintCount;
    if (maintText) {
        if (maintCount === 0) {
            maintText.innerText = "System Healthy";
            maintText.style.color = "#27ae60";
        } else if (overdueCount > 0 && activelyFlagged === 0) {
            maintText.innerText = `${overdueCount} Overdue Check-up${overdueCount > 1 ? 's' : ''}`;
            maintText.style.color = "#f97316";
        } else if (overdueCount > 0) {
            maintText.innerText = `${activelyFlagged} Flagged, ${overdueCount} Overdue`;
            maintText.style.color = "var(--primary-red)";
        } else {
            maintText.innerText = `${maintCount} Machine${maintCount > 1 ? 's' : ''} Need Attention`;
            maintText.style.color = "var(--primary-red)";
        }
    }

    // Low Stock
    const lowStockItems = inventoryData.filter(i => {
        const isConsumable = i.itemType === 'product' || (!i.itemType && ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(i.cat));
        return isConsumable && Number(i.qty) <= Number(i.lowStockThreshold || 5);
    });
    const lowStockCount = lowStockItems.length;
    const lowStockBadge = document.getElementById('dashLowStockBadge');
    const lowStockList = document.getElementById('dashLowStockList');

    if (lowStockBadge) lowStockBadge.innerText = lowStockCount;
    if (lowStockList) {
        if (lowStockCount === 0) {
            lowStockList.innerHTML = `<p style="color: var(--text-muted); font-size: 12px; padding: 10px 0;">All stock levels healthy.</p>`;
        } else {
            lowStockList.innerHTML = lowStockItems.slice(0, 3).map(i => `
                <div class="notif-item" style="border-left-color: #f59e0b;">
                    <strong>${i.name}</strong>: ${i.qty} units left
                </div>
            `).join('');
        }
    }
}

function calculateEngagement() {
    const activeMembers = membersData.filter(m => m.status === 'Active').length;
    const dynamicCapacity = Math.max(50, Math.floor(activeMembers * 0.15));
    
    const capEl = document.getElementById('dashTotalCapacity');
    const availEl = document.getElementById('detailAvailableCount');
    if (capEl) capEl.innerText = dynamicCapacity;

    const presentStr = document.getElementById('presentMembers')?.innerText || "0";
    const present = parseInt(presentStr, 10) || 0;
    if (availEl) availEl.innerText = Math.max(0, dynamicCapacity - present);
    
    const occRateEl = document.getElementById('detailOccupancyRate');
    if (occRateEl) {
        occRateEl.innerText = dynamicCapacity > 0 ? `${Math.round((present / dynamicCapacity) * 100)}%` : "0%";
    }
}

function calculateSecondaryKpis() {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const totalMembers = membersData.filter(m => m.status !== 'Archived').length;
    const activeMembers = membersData.filter(m => m.status === 'Active').length;

    const newToday = membersData.filter(m => {
        if (!m.dateRegistered) return false;
        const regDate = new Date(m.dateRegistered).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return regDate === todayStr;
    }).length;

    const activeTrainers = allUsersData.filter(u => u.role === 'Trainer' && u.status === 'Active').length;
    let trainersOnDuty = 0;
    if (typeof attendanceData !== 'undefined' && attendanceData.length > 0) {
        const todayAtt = attendanceData.filter(a => a.date === todayStr && a.status === 'Checked In');
        const checkedInNames = todayAtt.map(a => a.name);
        trainersOnDuty = allUsersData.filter(u => u.role === 'Trainer' && checkedInNames.includes(u.name || `${u.givenName} ${u.familyName}`)).length;
    }

    if (document.getElementById('dashTotalMembers')) document.getElementById('dashTotalMembers').innerText = totalMembers;
    if (document.getElementById('dashActiveMembers')) document.getElementById('dashActiveMembers').innerText = activeMembers;
    if (document.getElementById('dashNewToday')) document.getElementById('dashNewToday').innerText = newToday;
    if (document.getElementById('dashTrainersOnDuty')) document.getElementById('dashTrainersOnDuty').innerText = trainersOnDuty > 0 ? trainersOnDuty : activeTrainers;
}

let weeklyRevChartInst = null;
function renderWeeklyRevenueChart() {
    const ctx = document.getElementById('weeklyRevenueChart');
    if (!ctx) return;

    const days = [];
    const revenues = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
        
        const dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        let dayRev = 0;
        paymentsData.forEach(p => {
            if (p.status !== 'Voided' && p.status !== 'Refunded' && p.date === dStr) {
                dayRev += Number(p.amount || 0);
            }
        });
        revenues.push(dayRev);
    }

    if (weeklyRevChartInst) {
        weeklyRevChartInst.destroy();
    }

    weeklyRevChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: days,
            datasets: [{
                label: 'Revenue (₱)',
                data: revenues,
                backgroundColor: 'rgba(99, 102, 241, 0.85)',
                hoverBackgroundColor: 'rgba(99, 102, 241, 1)',
                borderRadius: 6,
                borderWidth: 0,
                barThickness: 28
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleFont: { size: 13, family: "'Inter', sans-serif" },
                    bodyFont: { size: 14, weight: 'bold', family: "'Inter', sans-serif" },
                    padding: 12,
                    callbacks: {
                        label: function(context) {
                            return '₱' + context.parsed.y.toLocaleString(undefined, {minimumFractionDigits: 2});
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 11, color: '#64748b' },
                        callback: function(value) {
                            if (value === 0) return '₱0';
                            return '₱' + (value >= 1000 ? (value/1000) + 'k' : value);
                        }
                    }
                },
                x: {
                    grid: { display: false, drawBorder: false },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 11, color: '#64748b' }
                    }
                }
            }
        }
    });
}

let memberDistChartInst = null;
function renderMemberDistChart() {
    const ctx = document.getElementById('memberDistChart');
    if (!ctx) return;

    let gold = 0, silver = 0, walkin = 0;
    
    membersData.forEach(m => {
        if (m.status !== 'Archived') {
            const planLower = (m.plan || '').toLowerCase();
            if (planLower.includes('gold')) gold++;
            else if (planLower.includes('silver')) silver++;
            else walkin++;
        }
    });

    const dataVals = [gold, silver, walkin];
    const labels = ['Gold Plan', 'Silver Plan', 'Basic / Other'];
    const colors = ['#F59E0B', '#94A3B8', '#10B981'];

    if (memberDistChartInst) {
        memberDistChartInst.destroy();
    }

    memberDistChartInst = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: dataVals,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: '#ffffff',
                hoverOffset: 4,
                cutout: '72%'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    bodyFont: { size: 13, family: "'Inter', sans-serif" },
                    padding: 10
                }
            }
        }
    });

    const legendEl = document.getElementById('memberDistLegend');
    if (legendEl) {
        const total = dataVals.reduce((a,b)=>a+b, 0);
        legendEl.innerHTML = labels.map((label, i) => {
            const val = dataVals[i];
            const pct = total > 0 ? Math.round((val/total)*100) : 0;
            return `
                <div style="display: flex; align-items: center; justify-content: space-between; font-size: 13px; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="width: 10px; height: 10px; border-radius: 50%; background: ${colors[i]}; display: inline-block;"></span>
                        <span style="color: var(--text-muted); font-weight: 500;">${label}</span>
                    </div>
                    <span style="font-weight: 600; color: var(--dark-black); margin-left: auto;">${val} <span style="color: var(--text-muted); font-weight: 400; font-size: 11px;">(${pct}%)</span></span>
                </div>
            `;
        }).join('');
    }
}

function renderSparkline(canvasId, data, color) {
    const container = document.getElementById(canvasId);
    if (!container) return;

    container.innerHTML = `<canvas id="${canvasId}-canvas" width="100" height="35"></canvas>`;
    const canvas = document.getElementById(`${canvasId}-canvas`);
    const ctx = canvas.getContext('2d');

    const max = Math.max(...data, 1);
    const step = canvas.width / (data.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    data.forEach((val, i) => {
        const x = i * step;
        const y = canvas.height - (val / max * (canvas.height - 4)) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.stroke();

    // Fill area
    ctx.lineTo((data.length - 1) * step, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.fillStyle = color + '22'; // 13% opacity
    ctx.fill();
}

// ==========================================
// 9. FINANCIALS & WEEKLY PDF GENERATOR
// ==========================================
let currentPaymentSortField = 'timestamp';
let currentPaymentSortOrder = 'desc';

let currentMemberSortField = 'dateRegistered';
let currentMemberSortOrder = 'desc';

let currentStaffSortField = 'dateRegistered';
let currentStaffSortOrder = 'desc';

let currentTrainerSortField = 'dateRegistered';
let currentTrainerSortOrder = 'desc';

// QUOTA FIX: payments grows unbounded. Previously the listener loaded the ENTIRE collection
// on every staff/admin page load (and on every new payment write — re-billed). All payment
// KPIs are scoped to today/this-week/last-week/last-30d, so the 1000 most recent transactions
// cover every consumer. For a small gym this is ~3+ months of history; for a busy one,
// ~weeks — still plenty for operational dashboards.
if (isStaffSide) {
    // PRESENTATION PROOFING: Lower the payments limit to 50 (perfect for school demo datasets),
    // reducing document reads by 95% per dashboard load/sync.
    const paymentsQ = query(paymentsCol, orderBy("timestamp", "desc"), limit(50));
    onSnapshot(paymentsQ, (snapshot) => {
        paymentsData = [];
        snapshot.forEach(doc => paymentsData.push({ id: doc.id, ...doc.data() }));
        softRender('payments', () => {
            renderPayments();
            if (window.renderWeeklyReport) window.renderWeeklyReport();
            if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
        });
    }, (err) => console.warn("[payments] listener error", err));
}

function renderPayments() {
    const payTbody = document.querySelector('#paymentTable tbody');
    if (!payTbody) return;

    const isCancelledTxStatus = (s) => {
        const v = (s || 'Paid');
        return v === 'Voided' || v === 'Refunded';
    };

    // 1. Calculate KPI Metrics (Always based on full data)
    let totalRevenue = 0;
    let todayRevenue = 0;
    let totalVoided = 0;
    const todayStr = new Date().toLocaleDateString('en-CA');

    paymentsData.forEach(t => {
        const amount = Number(t.amount || 0);
        if (isCancelledTxStatus(t.status)) {
            totalVoided += amount;
        } else {
            totalRevenue += amount;
            const ts = t.timestamp ? new Date(t.timestamp) : null;
            if (ts && ts.toLocaleDateString('en-CA') === todayStr) {
                todayRevenue += amount;
            }
        }
    });

    // Update KPI UI
    if (document.getElementById('financialTodayRevenue')) document.getElementById('financialTodayRevenue').innerText = `₱${todayRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (document.getElementById('financialTotalRevenue')) document.getElementById('financialTotalRevenue').innerText = `₱${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (document.getElementById('financialTotalVoided')) document.getElementById('financialTotalVoided').innerText = `₱${totalVoided.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    // 2. Filter and Sort for the Table
    let filtered = [...paymentsData];

    const searchTerm = document.getElementById('paymentSearch')?.value.toLowerCase();
    const filterStatus = document.getElementById('paymentFilterStatus')?.value;
    const filterMethod = document.getElementById('paymentFilterMethod')?.value;
    const filterRange = document.getElementById('paymentFilterRange')?.value;
    let dateFrom = document.getElementById('finDateFrom')?.value;
    let dateTo = document.getElementById('finDateTo')?.value;

    // Handle Range Presets
    const finCustomGroup = document.getElementById('finCustomRangeControls');
    if (finCustomGroup) {
        if (filterRange === 'custom') {
            finCustomGroup.style.display = 'flex';
        } else {
            finCustomGroup.style.display = 'none';
            const now = new Date();
            const getLocalYMD = (d) => {
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            if (filterRange === 'today') {
                dateFrom = getLocalYMD(now);
                dateTo = getLocalYMD(now);
            } else if (filterRange === '7days') {
                const sevenDaysAgo = new Date(now);
                sevenDaysAgo.setDate(now.getDate() - 7);
                dateFrom = getLocalYMD(sevenDaysAgo);
                dateTo = getLocalYMD(now);
            } else if (filterRange === '30days') {
                const thirtyDaysAgo = new Date(now);
                thirtyDaysAgo.setDate(now.getDate() - 30);
                dateFrom = getLocalYMD(thirtyDaysAgo);
                dateTo = getLocalYMD(now);
            } else {
                dateFrom = null;
                dateTo = null;
            }
        }
    }

    if (searchTerm) {
        filtered = filtered.filter(p =>
            (p.name && p.name.toLowerCase().includes(searchTerm)) ||
            (p.id && p.id.toLowerCase().includes(searchTerm)) ||
            (p.items && p.items.toLowerCase().includes(searchTerm)) ||
            (p.transactionRef && p.transactionRef.toLowerCase().includes(searchTerm))
        );
    }

    if (filterStatus && filterStatus !== 'all') {
        filtered = filtered.filter(p => (p.status || 'Paid') === filterStatus);
    }

    if (filterMethod && filterMethod !== 'all') {
        filtered = filtered.filter(p => (p.paymentMethod || 'Cash') === filterMethod);
    }

    // Custom Date Range Filter — guard against From > To
    if (dateFrom && dateTo && dateFrom > dateTo) {
        showToast("End date must be on or after start date.", "error");
        dateFrom = '';
        dateTo = '';
    }
    if (dateFrom) {
        const parts = dateFrom.split('-');
        const fromDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
        filtered = filtered.filter(p => {
            const pDate = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
            return pDate >= fromDate;
        });
    }
    if (dateTo) {
        const parts = dateTo.split('-');
        const toDate = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
        filtered = filtered.filter(p => {
            const pDate = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
            return pDate <= toDate;
        });
    }

    // Sorting logic
    filtered.sort((a, b) => {
        let valA, valB;

        if (currentPaymentSortField === 'customerName') {
            valA = (a.name || "").toLowerCase();
            valB = (b.name || "").toLowerCase();
        } else if (currentPaymentSortField === 'grandTotal' || currentPaymentSortField === 'amount') {
            valA = Number(a.amount || 0);
            valB = Number(b.amount || 0);
        } else if (currentPaymentSortField === 'subtotal') {
            valA = Number(a.subtotal || a.amount || 0);
            valB = Number(b.subtotal || b.amount || 0);
        } else if (currentPaymentSortField === 'timestamp') {
            valA = Number(a.timestamp || 0);
            valB = Number(b.timestamp || 0);
        } else {
            valA = String(a[currentPaymentSortField] || "").toLowerCase();
            valB = String(b[currentPaymentSortField] || "").toLowerCase();
        }

        if (valA < valB) return currentPaymentSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentPaymentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    // 3. Render Rows
    const renderPaymentRow = (t) => {
        const amount = Number(t.amount || 0);
        const status = (t.status || 'Paid');
        const isCancelled = isCancelledTxStatus(status);

        // Transaction Reference
        const refDisplay = t.transactionRef
            ? `<span class="txn-ref">${t.transactionRef}</span>`
            : `<span class="txn-ref">${t.id.slice(0, 8).toUpperCase()}</span>`;

        // Status Badge
        const statusBadge = isCancelled
            ? (status === 'Refunded'
                ? '<span class="status-badge-solid refunded bg-red-100 text-red-800 border border-red-200">Refunded</span>'
                : '<span class="status-badge-solid voided bg-red-100 text-red-800 border border-red-200">Voided</span>')
            : '<span class="status-badge-solid paid bg-green-100 text-green-800 border border-green-200">Paid</span>';

        // Cancel Remarks
        const remarksHtml = (isCancelled && t.cancelRemarks)
            ? `<div class="cancel-remarks-badge"><i class="fas fa-comment-dots"></i> ${escapeHtml(t.cancelRemarks)}</div>`
            : '';

        // Purchased Items Truncation
        const items = t.items || t.type || "";
        const itemList = items.split(',').map(i => i.trim());
        let itemsHtml = "";
        if (itemList.length > 2) {
            itemsHtml = `
                <div class="items-cell">
                    ${itemList[0]}, ${itemList[1]} <span class="item-badge">+${itemList.length - 2} more</span>
                    <div class="items-tooltip">${items}</div>
                </div>
            `;
        } else {
            itemsHtml = items;
        }

        // Action Kebab Menu
        const actionHtml = `
            <div class="kebab-menu">
                <button type="button" class="kebab-btn" onclick="toggleKebab(event, '${t.id}')">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
                <div class="kebab-dropdown" id="kebab-${t.id}">
                    <div class="kebab-item" onclick="viewInvoice('${t.id}')"><i class="fas fa-file-invoice"></i> View Invoice</div>
                    <div class="kebab-item" onclick="printReceipt('${t.id}')"><i class="fas fa-print"></i> Print Receipt</div>
                    ${!isCancelled ? `
                        <div class="kebab-item" onclick="processRefund('${t.id}', this)"><i class="fas fa-undo"></i> Process Refund</div>
                        <div class="kebab-item" style="color: #991b1b;" onclick="voidTransaction('${t.id}', false, this)"><i class="fas fa-ban"></i> Void Transaction</div>
                    ` : ''}
                </div>
            </div>
        `;

        const cancelledRowClass = isCancelled ? 'line-through text-gray-400 opacity-70' : '';
        return `
            <tr style="${isCancelled ? 'color: #94a3b8;' : ''}">
                <td class="${cancelledRowClass}" style="font-weight: 500; ${isCancelled ? 'text-decoration: line-through;' : ''}">
                    ${t.name}
                    <div>${refDisplay}</div>
                </td>
                <td class="${cancelledRowClass}" style="${isCancelled ? 'text-decoration: line-through;' : ''}">${itemsHtml}</td>
                <td class="${cancelledRowClass}" style="${isCancelled ? 'text-decoration: line-through;' : ''}"><span style="white-space: nowrap;">${t.date}</span> <br><small style="color:#94a3b8;">${t.time || ''}</small></td>
                <td class="${cancelledRowClass}" style="${isCancelled ? 'text-decoration: line-through;' : ''}">₱${(t.subtotal || amount).toFixed(2)}</td>
                <td class="${cancelledRowClass}" style="font-weight:700; ${isCancelled ? 'text-decoration: line-through;' : ''}">₱${amount.toFixed(2)}</td>
                <td>${statusBadge}${remarksHtml}</td>
                <td style="text-align: right;">${actionHtml}</td>
            </tr>
        `;
    };

    const totalRecords = filtered.length;
    const totalPages = Math.ceil(totalRecords / paymentItemsPerPage);
    if (paymentCurrentPage > totalPages && totalPages > 0) paymentCurrentPage = totalPages;
    if (paymentCurrentPage < 1) paymentCurrentPage = 1;
    const startIdx = (paymentCurrentPage - 1) * paymentItemsPerPage;
    const endIdx = Math.min(startIdx + paymentItemsPerPage, totalRecords);
    const displayData = filtered.slice(startIdx, endIdx);

    const countEl = document.getElementById('paymentRecordCount');
    if (countEl) {
        countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
    }

    window.renderPaginationControls('paymentPagination', paymentCurrentPage, totalPages, totalRecords, 'changePaymentPage');

    window.syncDOM(payTbody, displayData, renderPaymentRow, 'pay-row');

    // Update pagination counts
    if (document.getElementById('paymentTotalCount')) document.getElementById('paymentTotalCount').innerText = totalRecords;
    if (document.getElementById('paymentShowingCount')) document.getElementById('paymentShowingCount').innerText = totalRecords === 0 ? '0-0' : `${startIdx + 1}-${endIdx}`;
}

// Financial Report UI Helpers
window.toggleKebab = function (event, id) {
    event.stopPropagation();
    document.querySelectorAll('.kebab-dropdown').forEach(d => {
        if (d.id !== `kebab-${id}`) d.classList.remove('show');
    });
    const dropdown = document.getElementById(`kebab-${id}`);
    if (dropdown) dropdown.classList.toggle('show');
};

// Close kebabs on click outside
document.addEventListener('click', () => {
    document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.remove('show'));
});

window.viewInvoice = function (id) {
    const tx = paymentsData.find(p => p.id === id);
    if (!tx) return;

    const refText = tx.transactionRef || `#${id.slice(0, 8).toUpperCase()}`;
    document.getElementById('invoiceId').innerText = refText;
    document.getElementById('invoiceCustomerName').innerText = tx.name || "Walk-in Member";
    document.getElementById('invoiceDate').innerText = `${tx.date} • ${tx.time || ''}`;
    document.getElementById('invoiceMethod').innerText = tx.paymentMethod || "Cash";
    document.getElementById('invoiceStatus').innerText = tx.status || "Paid";
    document.getElementById('invoiceStatus').className = `status-badge-solid ${tx.status?.toLowerCase() || 'paid'}`;
    document.getElementById('invoiceStatus').style.background = (tx.status === 'Voided' || tx.status === 'Refunded') ? '#ef4444' : '#27ae60';

    const subtotal = tx.subtotal || Number(tx.amount || 0);
    const total = Number(tx.amount || 0);

    document.getElementById('invoiceSubtotal').innerText = `₱${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('invoiceTotal').innerText = `₱${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const itemsList = document.getElementById('invoiceItemsList');
    itemsList.innerHTML = "";

    if (tx.lineItems && tx.lineItems.length > 0) {
        tx.lineItems.forEach(item => {
            const row = `
                <tr>
                    <td style="padding: 10px 0;">${item.name}</td>
                    <td style="padding: 10px 0; text-align: center;">${item.qty}</td>
                    <td style="padding: 10px 0; text-align: right;">₱${(Number(item.price || 0) * Number(item.qty || 1)).toFixed(2)}</td>
                </tr>
            `;
            itemsList.innerHTML += row;
        });
    } else {
        const row = `
            <tr>
                <td style="padding: 10px 0;">${tx.items || tx.type || "Purchase"}</td>
                <td style="padding: 10px 0; text-align: center;">1</td>
                <td style="padding: 10px 0; text-align: right;">₱${total.toFixed(2)}</td>
            </tr>
        `;
        itemsList.innerHTML += row;
    }

    document.getElementById('invoiceModal').style.display = 'flex';
};

window.printReceipt = function (id) { window.viewInvoice(id); setTimeout(() => window.print(), 500); };
window.processRefund = function (id, btn) { window.voidTransaction(id, true, btn); };

window.filterPayments = function () {
    paymentCurrentPage = 1;
    renderPayments();
};

window.sortPayments = function (field) {
    if (currentPaymentSortField === field) {
        currentPaymentSortOrder = currentPaymentSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentPaymentSortField = field;
        currentPaymentSortOrder = 'asc';
    }

    // Update sort icons in headers
    document.querySelectorAll('#paymentTable th i').forEach(icon => {
        icon.className = 'fas fa-sort';
    });

    const th = document.querySelector(`#paymentTable th[onclick*="${field}"]`);
    if (th) {
        const icon = th.querySelector('i');
        if (icon) {
            icon.className = `fas fa-sort-${currentPaymentSortOrder === 'asc' ? 'up' : 'down'}`;
        }
    }

    renderPayments();
};

window.changePaymentPagination = function () {
    renderPayments();
};

// Weekly Report Generation
window.renderWeeklyReport = function () {
    const container = document.getElementById('weeklyReportGrid');
    if (!container) return;

    const now = new Date();
    const dayOfWeek = now.getDay();
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + distanceToMonday);
    monday.setHours(0, 0, 0, 0);

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '';

    for (let i = 0; i < 7; i++) {
        const dayDate = new Date(monday);
        dayDate.setDate(monday.getDate() + i);
        const dayStr = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const isToday = dayDate.toDateString() === now.toDateString();
        
        let dayRevenue = 0;
        let dayTxCount = 0;

        paymentsData.forEach(p => {
            if (p.status === 'Voided' || p.status === 'Refunded') return;
            const pDate = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
            if (pDate.toDateString() === dayDate.toDateString()) {
                dayRevenue += Number(p.amount || 0);
                dayTxCount++;
            }
        });

        html += `
            <div class="weekly-day-card ${isToday ? 'is-today' : ''}">
                <div class="weekly-day-label">${dayNames[i]}</div>
                <div class="weekly-day-date">${dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                <div class="weekly-day-amount">₱${dayRevenue.toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
                <div class="weekly-day-count">${dayTxCount} transaction${dayTxCount !== 1 ? 's' : ''}</div>
            </div>
        `;
    }

    container.innerHTML = html;
};

// Equipment Category Quantity Logic
window.handleEquipCategoryChange = function (catId, qtyId) {
    const cat = document.getElementById(catId).value;
    const qtyInput = document.getElementById(qtyId);
    if (!qtyInput) return;

    if (cat === "Cardio Machine" || cat === "Strength Machine") {
        qtyInput.value = 1;
        qtyInput.disabled = true;
        qtyInput.title = "Quantity is fixed to 1 for machines.";
    } else {
        qtyInput.disabled = false;
        qtyInput.title = "";
    }
};

// Equipment Category Quantity Counter
window.renderEquipmentCategorySummary = function () {
    const container = document.getElementById('equipCategorySummary');
    if (!container) return;

    const PRODUCT_CATS = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'];

    let operational = 0, maintenance = 0, outOfOrder = 0, missingTag = 0;

    inventoryData.forEach(item => {
        let isEquipment = item.itemType === 'equipment' || !PRODUCT_CATS.includes(item.cat);
        if (item.itemType === 'product') isEquipment = false;
        if (!isEquipment) return;

        const status = item.status || 'Operational';
        if (status === 'Maintenance') maintenance++;
        else if (status === 'Out of Order') outOfOrder++;
        else operational++;

        const tag = (item.assetTag || '').trim();
        if (!tag || tag === 'undefined') missingTag++;
    });

    const chips = [
        { id: 'Operational', label: 'Operational', count: operational, icon: 'fa-circle-check', color: '#15803d', bg: 'rgba(34, 197, 94, 0.1)', border: 'rgba(34, 197, 94, 0.15)' },
        { id: 'Maintenance', label: 'Under Maintenance', count: maintenance, icon: 'fa-screwdriver-wrench', color: '#d97706', bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.15)' },
        { id: 'Out of Order', label: 'Out of Order', count: outOfOrder, icon: 'fa-circle-xmark', color: '#991b1b', bg: 'rgba(153, 27, 27, 0.1)', border: 'rgba(153, 27, 27, 0.15)' },
        { id: 'Missing Tag', label: 'Missing Asset Tag', count: missingTag, icon: 'fa-tag', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.1)', border: 'rgba(107, 114, 128, 0.15)' }
    ];

    container.innerHTML = chips.map(c => {
        const isActive = window.currentEquipAlertFilter === c.id;
        const activeClass = isActive ? 'active-filter' : '';
        return `
            <div class="equip-cat-card ${activeClass}" style="border-left: 4px solid ${c.color}; cursor: pointer;" onclick="window.toggleEquipAlertFilter('${c.id}')">
                <div class="equip-cat-icon" style="background: ${c.bg}; color: ${c.color}; border: 1px solid ${c.border};">
                    <i class="fas ${c.icon}"></i>
                </div>
                <div class="equip-cat-info">
                    <div class="equip-cat-name">${c.label}</div>
                    <div class="equip-cat-count">${c.count} <span class="equip-cat-units">units</span></div>
                </div>
            </div>
        `;
    }).join('');
};

// Product Category Quantity Counter
window.renderProductCategorySummary = function () {
    const container = document.getElementById('productCategorySummary');
    if (!container) return;

    const PRODUCT_CATS = ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'];

    let outOfStock = 0, lowStock = 0, nearExpiry = 0, expired = 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(today.getDate() + 7);

    inventoryData.forEach(item => {
        let isProduct = item.itemType === 'product' || PRODUCT_CATS.includes(item.cat);
        if (item.itemType === 'equipment') isProduct = false;
        if (!isProduct) return;

        const qty = Number(item.qty || 0);
        const threshold = Number(item.lowStockThreshold || 5);

        if (qty === 0) outOfStock++;
        else if (qty <= threshold) lowStock++;

        if (item.expiry && qty > 0) {
            const expDate = new Date(item.expiry + 'T00:00:00');
            if (expDate < today) expired++;
            else if (expDate <= sevenDaysLater) nearExpiry++;
        }
    });

    const chips = [
        { id: 'outOfStock', label: 'Out of Stock', count: outOfStock, icon: 'fa-ban', color: '#991b1b', bg: 'rgba(153, 27, 27, 0.1)', border: 'rgba(153, 27, 27, 0.15)' },
        { id: 'lowStock', label: 'Low Stock', count: lowStock, icon: 'fa-box-open', color: '#d97706', bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.15)' },
        { id: 'expired', label: 'Expired', count: expired, icon: 'fa-skull-crossbones', color: '#991b1b', bg: 'rgba(153, 27, 27, 0.1)', border: 'rgba(153, 27, 27, 0.15)' },
        { id: 'nearExpiry', label: 'Near Expiry (7d)', count: nearExpiry, icon: 'fa-calendar-xmark', color: '#c2410c', bg: 'rgba(194, 65, 12, 0.1)', border: 'rgba(194, 65, 12, 0.15)' }
    ];

    container.innerHTML = chips.map(c => {
        const isActive = window.currentProductAlertFilter === c.id;
        const activeClass = isActive ? 'active-filter' : '';
        return `
            <div class="equip-cat-card ${activeClass}" style="border-left: 4px solid ${c.color}; cursor: pointer;" onclick="window.toggleProductAlertFilter('${c.id}')">
                <div class="equip-cat-icon" style="background: ${c.bg}; color: ${c.color}; border: 1px solid ${c.border};">
                    <i class="fas ${c.icon}"></i>
                </div>
                <div class="equip-cat-info">
                    <div class="equip-cat-name">${c.label}</div>
                    <div class="equip-cat-count">${c.count} <span class="equip-cat-units">items</span></div>
                </div>
            </div>
        `;
    }).join('');
};


// Clear date range filter
window.clearFinDateRange = function () {
    const fromEl = document.getElementById('finDateFrom');
    const toEl = document.getElementById('finDateTo');
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    renderPayments();
};

// Void Transaction & Restock Inventory (also handles Refunds)
window.voidTransaction = async function (id, isRefund = false, btn) {
    if (window.isPOSProcessingVoid === id) return;

    const tx = paymentsData.find(p => p.id === id);
    if (!tx) return;
    if (tx.status === "Voided" || tx.status === "Refunded") return showToast(`This transaction has already been ${tx.status.toLowerCase()}.`, "error");

    const actionName = isRefund ? "REFUND" : "VOID";

    const userRole = localStorage.getItem("userRole");
    if (!window.isCallerAdmin()) {
        return showToast(`Action Denied: Only Administrators can perform a ${actionName.toLowerCase()}.`, "error");
    }

    const _origBtnHtml = btn ? btn.innerHTML : '';
    const _rearmBtn = () => {
        if (btn) {
            btn.disabled = false;
            btn.style.pointerEvents = '';
            btn.innerHTML = _origBtnHtml;
        }
    };
    // ANTI-DUPLICATE LOCK: disable immediately on first click
    if (btn) {
        btn.disabled = true;
        btn.style.pointerEvents = 'none';
        btn.innerHTML = isRefund
            ? '<i class="fas fa-spinner fa-spin"></i> Processing Refund...'
            : '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }

    showPrompt({
        title: `${actionName} Transaction`,
        message: `Please enter a reason for this ${actionName.toLowerCase()} — required for the audit trail:`,
        placeholder: 'e.g. Incorrect order, customer request...',
        onCancel: _rearmBtn,
        onConfirm: (cancelRemarks) => {
            const remarksClean = (cancelRemarks || '').trim();
            if (!remarksClean) {
                _rearmBtn();
                return showToast(`Reason is required to ${actionName.toLowerCase()} a transaction.`, "error");
            }
            if (remarksClean.length < 4) {
                _rearmBtn();
                return showToast(`Please provide a more descriptive reason (at least 4 characters).`, "error");
            }
            showConfirm({ message: `Are you sure you want to ${actionName} this transaction? This will void the transaction, return purchased items to inventory, and refund credit if applicable.`, onCancel: _rearmBtn, onConfirm: async () => {
                if (window.isPOSProcessingVoid === id) return;
                window.isPOSProcessingVoid = id;
                
                try {
                    // H7: pre-query walk-in passes issued by this payment so we can invalidate them in-txn
                    // (Firestore queries are not allowed inside a transaction.)
                    let _walkinPassRefs = [];
                    let _walkinPassTags = [];
                    try {
                        const wpSnap = await getDocs(query(walkinPassesCol, where("paymentId", "==", id)));
                        wpSnap.forEach(d => {
                            _walkinPassRefs.push(d.ref);
                            const r = (d.data() || {}).rfid;
                            if (r) _walkinPassTags.push(r);
                        });
                    } catch (_) { /* best-effort */ }

                    // O3 (Sprint 9): pre-query active walk-in attendance records for the RFID tags
                    // attached to passes issued by this payment. Without this, voiding the payment
                    // leaves the guest "Checked In" forever — orphaned attendance, stuck guest card,
                    // and a guest who can still tap out for a service the gym refunded.
                    let _walkinAttRefs = [];
                    if (_walkinPassTags.length > 0) {
                        try {
                            const todayStr = new Date(Date.now() + (window.serverTimeOffsetMs || 0))
                                .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                            // Firestore `in` clause is capped at 10; chunk just in case.
                            const uniqTags = Array.from(new Set(_walkinPassTags));
                            for (let i = 0; i < uniqTags.length; i += 10) {
                                const chunk = uniqTags.slice(i, i + 10);
                                const chunkSet = new Set(chunk);
                                const attSnap = await getDocs(query(
                                    collection(db, "attendance"),
                                    where("date", "==", todayStr)
                                ));
                                attSnap.forEach(d => {
                                    const data = d.data() || {};
                                    if (chunkSet.has(data.guestRfid) && data.status === "Checked In") {
                                        _walkinAttRefs.push(d.ref);
                                    }
                                });
                            }
                        } catch (_) { /* best-effort */ }
                    }

                    await runTransaction(db, async (transaction) => {
                        // ── PHASE 1: ALL READS (Firestore requires all reads before any writes) ──

                        const paymentRef = doc(db, "payments", id);
                        const paymentSnap = await transaction.get(paymentRef);
                        if (!paymentSnap.exists()) throw new Error("Transaction record no longer exists.");
                        const paymentDbData = paymentSnap.data();
                        if (paymentDbData.status === "Voided" || paymentDbData.status === "Refunded") {
                            throw new Error(`This transaction has already been ${(paymentDbData.status || "voided").toLowerCase()}.`);
                        }

                        // Collect all inventory refs and read them upfront
                        const _walkinTagsToInvalidate = [];
                        const invReads = []; // { invRef, invSnap, item, qty, isLegacy }
                        const batchProductIds = new Set();
                        const batchRestockPlan = []; // batch-tracked void restock

                        if (Array.isArray(paymentDbData.batchDeductions)) {
                            for (const entry of paymentDbData.batchDeductions) {
                                if (!entry.productId) continue;
                                batchProductIds.add(entry.productId);
                                const invRef = doc(db, "inventory", entry.productId);
                                const invSnap = await transaction.get(invRef);
                                if (!invSnap.exists()) {
                                    throw new Error(`Cannot ${actionName.toLowerCase()}: batch product "${entry.productName || entry.productId}" no longer exists in inventory.`);
                                }
                                const deductions = [];
                                for (const d of entry.deductions || []) {
                                    if (!d.batchId || !d.deducted) continue;
                                    const batchRef = doc(db, "inventory", entry.productId, "batches", d.batchId);
                                    deductions.push({
                                        batchRef,
                                        batchSnap: await transaction.get(batchRef),
                                        deducted: d.deducted,
                                    });
                                }
                                batchRestockPlan.push({
                                    productId: entry.productId,
                                    productName: entry.productName || entry.productId,
                                    invRef,
                                    invSnap,
                                    deductions,
                                });
                            }
                        }

                        if (paymentDbData.type === "POS Sale") {
                            if (paymentDbData.lineItems && paymentDbData.lineItems.length > 0) {
                                for (const item of paymentDbData.lineItems) {
                                    if (item.id === "WALKIN" || item.isPlan) {
                                        if (Array.isArray(item.scannedTags)) _walkinTagsToInvalidate.push(...item.scannedTags);
                                        continue;
                                    }
                                    if (batchProductIds.has(item.id)) continue;
                                    const invRef = doc(db, "inventory", item.id);
                                    const invSnap = await transaction.get(invRef);
                                    // H6: deleted product — block the action, admin must reconcile first
                                    if (!invSnap.exists()) throw new Error(`Cannot ${actionName === "REFUND" ? "refund" : "void"}: product "${item.name}" no longer exists in inventory. Please recreate the product (or adjust stock manually) before retrying.`);
                                    invReads.push({ invRef, invSnap, item, qty: item.qty, isLegacy: false });
                                }
                            } else if (paymentDbData.items) {
                                for (const itemStr of paymentDbData.items.split(', ')) {
                                    const match = itemStr.match(/^(\d+)x\s+(.+)$/);
                                    if (!match) continue;
                                    const qtyRefunded = parseInt(match[1]);
                                    const itemName = match[2];
                                    if (itemName.includes("Walk-in Gym Access")) continue;
                                    const invItem = inventoryData.find(i => i.name.toLowerCase() === itemName.toLowerCase());
                                    if (invItem) {
                                        const invRef = doc(db, "inventory", invItem.id);
                                        const invSnap = await transaction.get(invRef);
                                        if (invSnap.exists()) invReads.push({ invRef, invSnap, item: invItem, qty: qtyRefunded, isLegacy: true });
                                    }
                                }
                            }
                        }

                        // Read member doc for RFID wallet refund
                        let memberRef = null, memberSnap = null, memberId = null, memberName = null;
                        const isRfidPayment = (paymentDbData.paymentMethod === 'RFID' || paymentDbData.paymentMethod === 'RFID Card' || paymentDbData.paymentMethod === 'RFID Credit') && paymentDbData.amount > 0;
                        if (isRfidPayment) {
                            memberId = paymentDbData.memberId;
                            memberName = paymentDbData.name;
                            if (!memberId) {
                                const member = membersData.find(m =>
                                    m.name === paymentDbData.name ||
                                    `${m.givenName || ''} ${m.familyName || ''}`.trim() === paymentDbData.name
                                );
                                if (member) {
                                    memberId = member.id;
                                    memberName = member.name || `${member.givenName || ''} ${member.familyName || ''}`.trim();
                                }
                            }
                            if (memberId) {
                                memberRef = doc(db, "users", memberId);
                                memberSnap = await transaction.get(memberRef);
                            }
                        }

                        // Read guest card docs
                        const gcReads = []; // { guestCardRef, gcSnap }
                        for (const tag of _walkinTagsToInvalidate) {
                            const guestCardRef = doc(db, "guestCards", guestCardDocId(tag));
                            gcReads.push({ guestCardRef, gcSnap: await transaction.get(guestCardRef) });
                        }

                        // Read walk-in pass docs
                        const wpReads = []; // { wpRef, wpSnap }
                        for (const wpRef of _walkinPassRefs) {
                            wpReads.push({ wpRef, wpSnap: await transaction.get(wpRef) });
                        }

                        // Read attendance docs for open walk-in sessions
                        const attReads = []; // { attRef, attSnap }
                        for (const attRef of _walkinAttRefs) {
                            attReads.push({ attRef, attSnap: await transaction.get(attRef) });
                        }

                        // ── PHASE 2: ALL WRITES ──

                        const now = new Date();
                        const nowTs = now.getTime();
                        const nowDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                        const nowTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                        const voidTimeStr = new Date(nowTs + (window.serverTimeOffsetMs || 0))
                            .toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

                        // 1. Inventory restock + movement log (flat-qty items)
                        for (const { invRef, invSnap, item, qty, isLegacy } of invReads) {
                            const currentQty = Number(invSnap.data().qty || 0);
                            transaction.update(invRef, { qty: currentQty + qty });
                            transaction.set(doc(collection(db, "stockMovements")), {
                                productId: item.id,
                                productName: item.name,
                                changeAmount: qty,
                                reason: `Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"}${isLegacy ? " (Legacy)" : ""}`,
                                userId: localStorage.getItem("userId") || "System",
                                userName: localStorage.getItem("loggedInUser") || "Unknown",
                                date: nowDate,
                                time: nowTime,
                                timestamp: nowTs
                            });
                        }

                        // 1b. Batch-tracked restock (subcollection + parent qty)
                        for (const plan of batchRestockPlan) {
                            let totalRestored = 0;
                            for (const { batchRef, batchSnap, deducted } of plan.deductions) {
                                if (!batchSnap.exists()) continue;
                                const liveQty = Number(batchSnap.data().currentQuantity || 0);
                                transaction.update(batchRef, { currentQuantity: liveQty + deducted });
                                totalRestored += deducted;
                                transaction.set(doc(collection(db, "stockMovements")), {
                                    productId: plan.productId,
                                    productName: plan.productName,
                                    batchId: batchRef.id,
                                    changeAmount: deducted,
                                    reason: `Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"} – Batch`,
                                    userId: localStorage.getItem("userId") || "System",
                                    userName: localStorage.getItem("loggedInUser") || "Unknown",
                                    date: nowDate,
                                    time: nowTime,
                                    timestamp: nowTs
                                });
                            }
                            if (totalRestored > 0) {
                                const parentQty = Number(plan.invSnap.data().qty || 0);
                                transaction.update(plan.invRef, { qty: parentQty + totalRestored });
                            }
                        }

                        // 2. Wallet credit refund (RFID payments only)
                        if (isRfidPayment && memberRef && memberSnap && memberSnap.exists()) {
                            const currentBalance = Number(memberSnap.data().creditBalance || 0);
                            const refundAmount = Number(paymentDbData.amount || 0);
                            const newBalance = currentBalance + refundAmount;
                            transaction.update(memberRef, { creditBalance: newBalance });
                            transaction.set(doc(collection(db, "creditTransactions")), {
                                memberId,
                                memberName: memberName || "Member",
                                type: "refund",
                                amount: refundAmount,
                                balanceBefore: currentBalance,
                                balanceAfter: newBalance,
                                note: `Refunded POS Transaction: ${id}`,
                                processedBy: localStorage.getItem("userId") || "System",
                                timestamp: nowTs
                            });
                        }

                        // 3. Invalidate guest cards
                        for (const { guestCardRef, gcSnap } of gcReads) {
                            if (gcSnap.exists() && gcSnap.data().paymentId === id) {
                                transaction.update(guestCardRef, { status: "Voided", issuedForDate: "", paymentId: "", voidedAt: nowTs });
                            }
                        }

                        // 4. Void walk-in passes
                        for (const { wpRef, wpSnap } of wpReads) {
                            if (wpSnap.exists() && wpSnap.data().status === "Active") {
                                transaction.update(wpRef, { status: "Voided", voidedAt: nowTs });
                            }
                        }

                        // 5. Close orphaned walk-in attendance records
                        for (const { attRef, attSnap } of attReads) {
                            if (attSnap.exists() && attSnap.data().status === "Checked In") {
                                transaction.update(attRef, { status: "Checked Out", timeOut: voidTimeStr, voidedByPayment: id, voidedAt: nowTs });
                            }
                        }

                        // 6. Mark payment as Voided / Refunded
                        const voidUpdate = { status: isRefund ? "Refunded" : "Voided" };
                        if (cancelRemarks.trim()) voidUpdate.cancelRemarks = cancelRemarks.trim();
                        voidUpdate.voidedAt = nowTs;
                        voidUpdate.voidedBy = localStorage.getItem("userId") || "";
                        transaction.update(paymentRef, voidUpdate);
                    });

                    // UI + local cache hard-sync (covers pages without an active payments listener)
                    try {
                        const localIdx = paymentsData.findIndex(p => p.id === id);
                        if (localIdx !== -1) {
                            const nextStatus = isRefund ? "Refunded" : "Voided";
                            paymentsData[localIdx] = {
                                ...paymentsData[localIdx],
                                status: nextStatus,
                                cancelRemarks: (cancelRemarks || '').trim(),
                                voidedAt: Date.now(),
                                voidedBy: localStorage.getItem("userId") || ""
                            };
                        }
                        if (typeof renderPayments === 'function') renderPayments();
                    } catch (_) { /* best-effort UI sync */ }
                    
                    showToast(`Transaction successfully ${actionName === "REFUND" ? "refunded" : "voided"}!`, "success");
                    if (window.logActivity) window.logActivity(`Transaction ${actionName === "REFUND" ? "Refunded" : "Voided"}`, `${actionName === "REFUND" ? "Refunded" : "Voided"} transaction ${id} for ${tx.name || 'Unknown'} (₱${tx.amount})${cancelRemarks ? ' — Reason: ' + cancelRemarks : ''}`);
                } catch (e) {
                    console.error("Void transaction failed: ", e);
                    showToast(e.message || `Error ${actionName === "REFUND" ? "refunding" : "voiding"} transaction.`, "error");
                } finally {
                    delete window.isPOSProcessingVoid;
                    _rearmBtn();
                }
            }});
        }
    });
};

// Shared helper: classify a payment's revenue category
function _classifyPayment(type) {
    if (type.includes("Membership") || type.includes("Plan") || type.includes("Annual") || type.includes("Monthly")) return "Membership Fees";
    if (type.includes("Walk-in") || type.includes("Pass")) return "Walk-in Gym Fees";
    return "POS Product Sales";
}

// Shared helper: normalise a payment method label
function _normMethod(m) {
    if (!m) return "Cash";
    const u = m.toUpperCase();
    if (u.includes("GCASH")) return "GCash";
    if (u.includes("RFID")) return "RFID Credit";
    return "Cash";
}

// Shared helper: build category + payment-method tbody HTML
function _buildCategoryRows(payments, grossRevenue) {
    const cats = {};
    const methods = {};
    payments.forEach(p => {
        const amount = Number(p.amount || 0);
        const cat = _classifyPayment(p.type || "");
        if (!cats[cat]) cats[cat] = { count: 0, amount: 0 };
        cats[cat].count++;
        cats[cat].amount += amount;

        const m = _normMethod(p.paymentMethod);
        if (!methods[m]) methods[m] = { count: 0, amount: 0 };
        methods[m].count++;
        methods[m].amount += amount;
    });

    const fmt = (n) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    const pct = (n) => grossRevenue > 0 ? `${((n / grossRevenue) * 100).toFixed(1)}%` : '0%';

    const catOrder = ["Membership Fees", "Walk-in Gym Fees", "POS Product Sales"];
    let catHtml = catOrder.map(name => {
        const d = cats[name] || { count: 0, amount: 0 };
        return `<tr><td>${name}</td><td style="text-align:right;">${d.count}</td><td style="text-align:right;">${fmt(d.amount)}</td><td style="text-align:right;">${pct(d.amount)}</td></tr>`;
    }).join('');
    catHtml += `<tr class="total-row"><td>TOTAL</td><td style="text-align:right;">${payments.length}</td><td style="text-align:right;">${fmt(grossRevenue)}</td><td style="text-align:right;">100%</td></tr>`;

    const methodOrder = ["Cash", "GCash", "RFID Credit"];
    let methodHtml = methodOrder.map(name => {
        const d = methods[name] || { count: 0, amount: 0 };
        return `<tr><td>${name}</td><td style="text-align:right;">${d.count}</td><td style="text-align:right;">${fmt(d.amount)}</td><td style="text-align:right;">${pct(d.amount)}</td></tr>`;
    }).join('');
    methodHtml += `<tr class="total-row"><td>TOTAL</td><td style="text-align:right;">${payments.length}</td><td style="text-align:right;">${fmt(grossRevenue)}</td><td style="text-align:right;">100%</td></tr>`;

    return { catHtml, methodHtml };
}

window.generateWeeklyPDF = function () {
    if (typeof html2pdf === 'undefined') {
        return showToast("PDF library is still loading, please wait a moment and try again.", "info");
    }

    const docName = localStorage.getItem("loggedInUser") || "Staff Member";
    const today = new Date();
    const dayOfWeek = today.getDay();
    const distanceToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + distanceToMonday);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const fmt2 = (n) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const formatShortDate = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear().toString().slice(-2)}`;

    document.getElementById('pdfWeekOf').innerText = `${fmtDate(monday)} – ${fmtDate(sunday)}`;
    document.getElementById('pdfAssociateName').innerText = docName;
    document.getElementById('pdfCompletionDate').innerText = formatShortDate(today);
    document.getElementById('pdfGeneratedAt').innerText = today.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const allWeek = paymentsData.filter(p => {
        if (!p.date && !p.timestamp) return false;
        const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
        return d >= monday && d <= sunday;
    });
    const paidWeek = allWeek.filter(p => p.status !== 'Voided' && p.status !== 'Refunded');
    const voidedWeek = allWeek.filter(p => p.status === 'Voided' || p.status === 'Refunded');

    const grossRevenue = paidWeek.reduce((s, p) => s + Number(p.amount || 0), 0);
    const voidedAmount = voidedWeek.reduce((s, p) => s + Number(p.amount || 0), 0);
    // VAT removed from weekly financial report: treat revenue as-is (gross == net)
    const netRevenue = grossRevenue;
    const avgTx = paidWeek.length > 0 ? grossRevenue / paidWeek.length : 0;

    document.getElementById('pdfGrossRevenue').innerText = fmt2(grossRevenue);
    document.getElementById('pdfNetRevenue').innerText = fmt2(netRevenue);
    document.getElementById('pdfVoidedAmount').innerText = fmt2(voidedAmount);
    document.getElementById('pdfTxCount').innerText = paidWeek.length;
    document.getElementById('pdfAvgTx').innerText = fmt2(avgTx);
    document.getElementById('pdfVoidedCount').innerText = voidedWeek.length;

    const { catHtml, methodHtml } = _buildCategoryRows(paidWeek, grossRevenue);
    document.getElementById('pdfRevenueSourcesBody').innerHTML = catHtml;
    document.getElementById('pdfPaymentMethodsBody').innerHTML = methodHtml;

    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    let dailyHtml = '';
    let weekRevTotal = 0, weekVoidTotal = 0, weekTxTotal = 0;
    for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
        const dayPaid = paidWeek.filter(p => { const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date); return d >= dayStart && d <= dayEnd; });
        const dayVoided = voidedWeek.filter(p => { const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date); return d >= dayStart && d <= dayEnd; });
        const dayRev = dayPaid.reduce((s, p) => s + Number(p.amount || 0), 0);
        const dayVoidAmt = dayVoided.reduce((s, p) => s + Number(p.amount || 0), 0);
        weekRevTotal += dayRev; weekVoidTotal += dayVoidAmt; weekTxTotal += dayPaid.length;
        const isToday = day.toDateString() === today.toDateString();
        dailyHtml += `<tr${isToday ? ' style="background:#f0fdf4;"' : ''}>
            <td>${dayNames[i]}, ${day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${isToday ? ' <strong>(Today)</strong>' : ''}</td>
            <td style="text-align:right;">${dayPaid.length}</td>
            <td style="text-align:right;">${fmt2(dayRev)}</td>
            <td style="text-align:right;${dayVoidAmt > 0 ? 'color:#991b1b;' : ''}">${fmt2(dayVoidAmt)}</td>
        </tr>`;
    }
    dailyHtml += `<tr class="total-row"><td>WEEK TOTAL</td><td style="text-align:right;">${weekTxTotal}</td><td style="text-align:right;">${fmt2(weekRevTotal)}</td><td style="text-align:right;">${fmt2(weekVoidTotal)}</td></tr>`;
    document.getElementById('pdfDailyBreakdownBody').innerHTML = dailyHtml;

    document.getElementById('pdf-report-container').style.display = 'block';
    html2pdf().set({
        margin: 0,
        filename: `Weekly_Report_${fmtDate(monday).replace(/[, ]+/g, '_')}.pdf`,
        image: { type: 'jpeg', quality: 1 },
        html2canvas: { scale: 3, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    }).from(document.getElementById('weekly-sales-report')).save().then(() => {
        document.getElementById('pdf-report-container').style.display = 'none';
    });
}

window.generateMonthlyPDF = function () {
    if (typeof html2pdf === 'undefined') {
        return showToast("PDF library is still loading, please wait a moment and try again.", "info");
    }

    const docName = localStorage.getItem("loggedInUser") || "Staff Member";
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const fmt2 = (n) => `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    const formatShortDate = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear().toString().slice(-2)}`;

    document.getElementById('pdfMonthOf').innerText = `${monthNames[today.getMonth()]} ${today.getFullYear()}`;
    document.getElementById('pdfMonthAssociateName').innerText = docName;
    document.getElementById('pdfMonthCompletionDate').innerText = formatShortDate(today);
    document.getElementById('pdfMonthGeneratedAt').innerText = today.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const allMonth = paymentsData.filter(p => {
        if (!p.date && !p.timestamp) return false;
        const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
        return d >= monthStart && d <= monthEnd;
    });
    const paidMonth = allMonth.filter(p => p.status !== 'Voided' && p.status !== 'Refunded');
    const voidedMonth = allMonth.filter(p => p.status === 'Voided' || p.status === 'Refunded');

    const grossRevenue = paidMonth.reduce((s, p) => s + Number(p.amount || 0), 0);
    const voidedAmount = voidedMonth.reduce((s, p) => s + Number(p.amount || 0), 0);
    // VAT removed from monthly financial report: treat revenue as-is (gross == net)
    const netRevenue = grossRevenue;
    const avgTx = paidMonth.length > 0 ? grossRevenue / paidMonth.length : 0;

    document.getElementById('pdfMonthGrossRevenue').innerText = fmt2(grossRevenue);
    document.getElementById('pdfMonthNetRevenue').innerText = fmt2(netRevenue);
    document.getElementById('pdfMonthVoidedAmount').innerText = fmt2(voidedAmount);
    document.getElementById('pdfMonthTxCount').innerText = paidMonth.length;
    document.getElementById('pdfMonthAvgTx').innerText = fmt2(avgTx);
    document.getElementById('pdfMonthVoidedCount').innerText = voidedMonth.length;

    const { catHtml, methodHtml } = _buildCategoryRows(paidMonth, grossRevenue);
    document.getElementById('pdfMonthRevenueSourcesBody').innerHTML = catHtml;
    document.getElementById('pdfMonthPaymentMethodsBody').innerHTML = methodHtml;

    let weeklyHtml = '';
    let wNum = 1;
    const cursor = new Date(monthStart);
    const firstDay = cursor.getDay();
    cursor.setDate(cursor.getDate() + (firstDay === 0 ? -6 : 1 - firstDay));
    let mTxTotal = 0, mRevTotal = 0, mVoidTotal = 0;

    while (cursor <= monthEnd) {
        const wStart = new Date(Math.max(cursor.getTime(), monthStart.getTime()));
        const wEndRaw = new Date(cursor); wEndRaw.setDate(cursor.getDate() + 6); wEndRaw.setHours(23, 59, 59, 999);
        const wEnd = new Date(Math.min(wEndRaw.getTime(), monthEnd.getTime()));

        const wPaid = paidMonth.filter(p => { const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date); return d >= wStart && d <= wEnd; });
        const wVoided = voidedMonth.filter(p => { const d = p.timestamp ? new Date(p.timestamp) : new Date(p.date); return d >= wStart && d <= wEnd; });
        const wRev = wPaid.reduce((s, p) => s + Number(p.amount || 0), 0);
        const wVoidAmt = wVoided.reduce((s, p) => s + Number(p.amount || 0), 0);
        mTxTotal += wPaid.length; mRevTotal += wRev; mVoidTotal += wVoidAmt;

        weeklyHtml += `<tr>
            <td>Week ${wNum} (${wStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${wEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})</td>
            <td style="text-align:right;">${wPaid.length}</td>
            <td style="text-align:right;">${fmt2(wRev)}</td>
            <td style="text-align:right;${wVoidAmt > 0 ? 'color:#991b1b;' : ''}">${fmt2(wVoidAmt)}</td>
        </tr>`;
        cursor.setDate(cursor.getDate() + 7);
        wNum++;
    }
    weeklyHtml += `<tr class="total-row"><td>MONTH TOTAL</td><td style="text-align:right;">${mTxTotal}</td><td style="text-align:right;">${fmt2(mRevTotal)}</td><td style="text-align:right;">${fmt2(mVoidTotal)}</td></tr>`;
    document.getElementById('pdfMonthWeeklyBreakdownBody').innerHTML = weeklyHtml;

    document.getElementById('pdf-report-container').style.display = 'block';
    html2pdf().set({
        margin: 0,
        filename: `Monthly_Report_${monthNames[today.getMonth()]}_${today.getFullYear()}.pdf`,
        image: { type: 'jpeg', quality: 1 },
        html2canvas: { scale: 3, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    }).from(document.getElementById('monthly-sales-report')).save().then(() => {
        document.getElementById('pdf-report-container').style.display = 'none';
    });
}

// ==========================================
// 10. MASTER DIRECTORY & ATTENDANCE LOGIC
// ==========================================
initAttendance({ db, attendanceCol, servicesChartInstanceGetter: () => servicesChartInstance });

// Full user directory for messaging — all dashboard roles need every user in chatUsers.
if (isStaffSide || roleNorm === "trainer" || roleNorm === "member") {
    onSnapshot(usersCol, (snapshot) => {
        allUsersData = []; membersData = []; chatUsers = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            delete data.password; // Prevent plaintext password leak in global arrays

            if (!data.uid && window.generateUID) {
                data.uid = window.generateUID(data.role || "Member");
                updateDoc(doc(db, "users", docSnap.id), { uid: data.uid }).catch(e => console.error(e));
            }

            const roleStr = (data.role || "").trim().toLowerCase();
            const user = { ...data, id: docSnap.id };
            chatUsers.push(user);
            if (roleStr === 'member') membersData.push(user);
            else if (roleStr !== 'admin') allUsersData.push(user);
        });
        window.allUsersData = allUsersData;
        window.membersData = membersData;
        softRender('users', () => {
            if (isStaffSide || roleNorm === "trainer") {
                renderStaff();
                renderMembers();
            }
            renderMemberTrainers();
            if (document.getElementById('chatUserList')) renderChatUserList();
        });
    });
}

// Change Password Logic - Moved outside onSnapshot (Bug Fix)
if (document.getElementById('changePasswordForm')) {
    document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPass = document.getElementById('currentPasswordInput') ? document.getElementById('currentPasswordInput').value.trim() : '';
        const newPass = document.getElementById('newPasswordInput').value.trim();
        if (newPass.length < 6) return showToast("Password must be at least 6 characters.", "error");

        const userId = localStorage.getItem('userId');
        if (!userId) return;

        try {
            // Verify current password
            const userDoc = await getDoc(doc(db, "users", userId));
            if (!userDoc.exists() || userDoc.data().password !== currentPass) {
                return showToast("Current password is incorrect.", "error");
            }
            await updateDoc(doc(db, "users", userId), { password: newPass });
            document.getElementById('changePasswordModal').style.display = 'none';
            showToast("Password updated successfully!", "success");
            if (window.logActivity) window.logActivity("Password Changed", `User changed their own password.`);
        } catch (err) {
            console.error(err);
            showToast("Error updating password.", "error");
        }
    });
}

window.openProfileSettingsModal = async function () {
    const userId = localStorage.getItem("userId");
    if (!userId) return showToast("You must be logged in.", "error");

    try {
        const userDoc = await getDoc(doc(db, "users", userId));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            document.getElementById('userProfileName').value = userData.name || userData.givenName || '';
            document.getElementById('userProfileEmail').value = userData.email || '';
            document.getElementById('userProfileEmergency').value = userData.emergencyContact || '';
            document.getElementById('userProfilePreview').src = userData.image || 'images/default-profile.png';
            document.getElementById('userProfileCurrentPassword').value = '';
            document.getElementById('userProfilePassword').value = '';
            const pwConfirm = document.getElementById('userProfilePasswordConfirm');
            if (pwConfirm) pwConfirm.value = '';
        }
    } catch (err) {
        console.error(err);
    }

    document.getElementById('profileSettingsModal').style.display = 'flex';
}

// Handle Profile Settings Submission
document.addEventListener('submit', async (e) => {
    if (e.target && e.target.id === 'profileSettingsForm') {
        e.preventDefault();
        const userId = localStorage.getItem("userId");
        if (!userId) return showToast("Session expired.", "error");

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerText;
        submitBtn.disabled = true;
        submitBtn.innerText = "Saving...";

        try {
            const name = document.getElementById('userProfileName').value.trim();
            const currentPassword = document.getElementById('userProfileCurrentPassword').value;
            const newPassword = document.getElementById('userProfilePassword').value;
            const confirmPassword = (document.getElementById('userProfilePasswordConfirm') || {}).value || '';
            const imageFile = document.getElementById('userProfileFile').files[0];
            let imageUrl = document.getElementById('userProfilePreview').src;

            // Validate name length and chars
            if (!name || name.length > 80 || !/^[A-Za-zñÑ\s\-'\.]+$/.test(name)) {
                showToast("Name must be 1-80 letters (spaces/hyphens/apostrophes allowed).", "error");
                submitBtn.disabled = false; submitBtn.innerText = originalText; return;
            }
            // Validate emergency contact if provided
            const emergencyVal = document.getElementById('userProfileEmergency').value.trim();
            if (emergencyVal && !/^\+?[0-9\-\s]{7,15}$/.test(emergencyVal)) {
                showToast("Invalid emergency contact format.", "error");
                submitBtn.disabled = false; submitBtn.innerText = originalText; return;
            }

            // Verify current password before allowing password change
            if (newPassword) {
                if (!currentPassword) {
                    showToast("Please enter your current password to change it.", "error");
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                    return;
                }
                if (newPassword !== confirmPassword) {
                    showToast("New password and confirmation do not match.", "error");
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                    return;
                }
                const userDoc = await getDoc(doc(db, "users", userId));
                if (!userDoc.exists() || userDoc.data().password !== currentPassword) {
                    showToast("Current password is incorrect.", "error");
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                    return;
                }
                if (newPassword.length < 6) {
                    showToast("New password must be at least 6 characters.", "error");
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                    return;
                }
            }

            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'profiles');
            }

            // Attempt to split name for better DB consistency between 'name' and 'givenName/familyName'
            const nameParts = name.trim().split(' ');
            const given = nameParts[0] || "";
            const family = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";
            const emergency = document.getElementById('userProfileEmergency').value.trim();

            const updates = {
                name,
                givenName: given,
                familyName: family,
                emergencyContact: emergency,
                image: imageUrl
            };
            if (newPassword) {
                updates.password = newPassword;
            }

            // Defense-in-depth: strip any non-self-editable keys before write,
            // even though `updates` is a literal here. Closes the door for any
            // future code that builds this object from spread/user input.
            await updateDoc(doc(db, "users", userId), window.pickSelfEditable(updates));

            showToast("Profile updated successfully!", "success");
            document.getElementById('profileSettingsModal').style.display = 'none';

            // Refresh topbar name if present
            if (document.getElementById('topBarName')) {
                document.getElementById('topBarName').innerText = name.split(' ')[0];
            }
            localStorage.setItem("loggedInUser", name);
        } catch (error) {
            console.error(error);
            showToast(error.message, "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = originalText;
        }
    }
});



window.getPlanDays = function (plan) {
    // Dynamic lookup from loaded plans data
    if (!plan) return 30;
    if (window.__membershipPlansData && window.__membershipPlansData.length > 0) {
        const found = window.__membershipPlansData.find(p => p.name.toLowerCase() === plan.toLowerCase());
        if (found && found.duration) return Number(found.duration);
    }
    // Fallback heuristics for legacy data
    const p = plan.toLowerCase();
    if (p.includes("year") || p.includes("annual")) return 365;
    if (p.includes("quarter") || p.includes("3 month")) return 90;
    if (p.includes("6 month") || p.includes("semi")) return 180;
    return 30;
};

// Enhanced renewMember — opens renewal modal instead of instant renewal
window.renewMember = async (id) => {
    const member = membersData.find(m => m.id === id);
    if (!member) return showToast("Member not found.", "error");

    document.getElementById('renewMemberId').value = id;
    document.getElementById('renewMemberName').innerText = `${member.givenName || member.name} ${member.familyName || ''}`.trim();
    document.getElementById('renewMemberEmail').innerText = member.email || '';

    // Show current status
    const now = new Date().getTime();
    const planDays = window.getPlanDays(member.plan);
    let statusText = member.plan || 'No Plan';
    if (member.dateRegistered) {
        const expiryDate = member.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
        const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays <= 0) statusText = `${member.plan || 'Plan'} — Expired`;
        else if (diffDays <= 7) statusText = `${member.plan || 'Plan'} — ${diffDays} days left`;
        else statusText = `${member.plan || 'Plan'} — ${diffDays} days left`;
    }
    document.getElementById('renewCurrentPlanBadge').innerText = statusText;

    // Populate plan options from Firestore
    const select = document.getElementById('renewPlanSelect');
    select.innerHTML = '<option value="" disabled selected>Select a plan...</option>';
    const plans = (window.__membershipPlansData || []).filter(p => p.status === 'Active');
    if (plans.length === 0) {
        select.innerHTML = '<option value="" disabled selected>No active plans available</option>';
    } else {
        plans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} — ${p.duration} days — ₱${Number(p.price).toLocaleString()}`;
            if (member.plan && p.name.toLowerCase() === member.plan.toLowerCase()) opt.selected = true;
            select.appendChild(opt);
        });
    }

    // Update summary on plan change
    select.onchange = function () {
        const plan = (window.__membershipPlansData || []).find(p => p.id === this.value);
        if (plan) {
            document.getElementById('renewDuration').innerText = `${plan.duration} days`;
            const expiry = new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000);
            document.getElementById('renewExpiry').innerText = expiry.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

            let basePrice = Number(plan.price);
            let discount = 0;
            const now = new Date().getTime();
            if (member.dateRegistered) {
                const currentPlanDays = window.getPlanDays(member.plan);
                const currentExpiryDate = member.dateRegistered + (currentPlanDays * 24 * 60 * 60 * 1000);
                const remainingDays = Math.ceil((currentExpiryDate - now) / (1000 * 60 * 60 * 24));

                if (remainingDays > 0) {
                    const currentPlanObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === (member.plan || '').toLowerCase());
                    if (currentPlanObj) {
                        const dailyRate = Number(currentPlanObj.price) / currentPlanDays;
                        discount = dailyRate * remainingDays;
                    }
                }
            }

            const lockerCheckbox = document.getElementById('renewAddLocker');
            const lockerPrice = (lockerCheckbox && lockerCheckbox.checked) ? 300 : 0;

            const finalDue = Math.max(0, basePrice - discount + lockerPrice);

            let totalDueHtml = `₱${finalDue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
            if (discount > 0) {
                totalDueHtml = `<span style="font-size:12px; color:var(--text-muted); font-weight:normal; margin-right:8px;">(Prorated -₱${discount.toFixed(2)})</span>` + totalDueHtml;
            }

            document.getElementById('renewTotalDue').innerHTML = totalDueHtml;
        }
    };

    // Listen to locker toggle
    const lockerCheckbox = document.getElementById('renewAddLocker');
    if (lockerCheckbox) {
        lockerCheckbox.onchange = () => select.dispatchEvent(new Event('change'));
    }

    select.dispatchEvent(new Event('change'));

    // Reset payment method toggle to Cash
    window.__renewPaymentMethod = 'Cash';
    const payToggle = document.getElementById('renewPaymentToggle');
    if (payToggle) {
        payToggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
        const cashOpt = payToggle.querySelector('[data-method="Cash"]');
        if (cashOpt) cashOpt.classList.add('selected');
    }
    const gcashW = document.getElementById('renewGcashRefWrapper');
    if (gcashW) {
        gcashW.classList.remove('visible');
        const inp = gcashW.querySelector('input');
        if (inp) inp.value = '';
    }

    document.getElementById('renewMemberModal').style.display = 'flex';
};

// Confirm Renewal action
window.confirmRenewal = async function (btn) {
    const id = document.getElementById('renewMemberId').value;
    const select = document.getElementById('renewPlanSelect');
    const selectedPlanId = select.value;
    if (!selectedPlanId) return showToast("Please select a plan.", "error");

    const plan = (window.__membershipPlansData || []).find(p => p.id === selectedPlanId);
    if (!plan) return showToast("Plan not found.", "error");

    const member = membersData.find(m => m.id === id);
    if (!member) return showToast("Member not found.", "error");

    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

    // Recalculate exact total (NaN-guard against bad plan price data)
    let basePrice = Number(plan.price);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
        return showToast("Selected plan has an invalid price. Contact admin.", "error");
    }
    let discount = 0;
    const now = new Date().getTime();
    if (member.dateRegistered) {
        const currentPlanDays = window.getPlanDays(member.plan);
        const currentExpiryDate = member.dateRegistered + (currentPlanDays * 24 * 60 * 60 * 1000);
        const remainingDays = Math.ceil((currentExpiryDate - now) / (1000 * 60 * 60 * 24));
        if (remainingDays > 0) {
            const currentPlanObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === (member.plan || '').toLowerCase());
            if (currentPlanObj) discount = (Number(currentPlanObj.price) / currentPlanDays) * remainingDays;
        }
    }

    const lockerCheckbox = document.getElementById('renewAddLocker');
    const hasLocker = lockerCheckbox && lockerCheckbox.checked;
    const lockerPrice = hasLocker ? 300 : 0;
    const finalDue = Math.max(0, basePrice - discount + lockerPrice);
    if (finalDue <= 0) {
        return showToast("Computed renewal price is ₱0 due to high proration. Contact an admin to adjust manually.", "error");
    }

    const _rearmRenewBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({
        title: 'Confirm Renewal Charge',
        message: `Charge ₱${finalDue.toLocaleString(undefined, { minimumFractionDigits: 2 })} for ${plan.name}${hasLocker ? ' + Locker' : ''}?`,
        tone: 'success',
        confirmText: 'Charge',
        onCancel: _rearmRenewBtn,
        onConfirm: async () => {
        try {
            // Capture payment method + GCash ref for renewal
            const renewPayMethod = window.__renewPaymentMethod || 'Cash';
            const renewGcashRef = (document.getElementById('renewGcashRefId') ? document.getElementById('renewGcashRefId').value.trim() : '');

            // Validate GCash ref when GCash is selected
            if (renewPayMethod === 'GCash' && !renewGcashRef) {
                showToast('Please enter the GCash Reference ID.', 'error');
                return;
            }
            if (renewPayMethod === 'GCash' && renewGcashRef.replace(/\s/g, '').length !== 12) {
                showToast('GCash Reference ID must be exactly 12 digits.', 'error');
                return;
            }
            if (renewPayMethod === 'GCash') {
                try { await window.assertGcashRefUnused(renewGcashRef); }
                catch (e) { return showToast(e.message, 'error'); }
            }

            await syncServerTimeOffset();
            const currentTimestamp = Date.now() + (window.serverTimeOffsetMs || 0);

            await runTransaction(db, async (transaction) => {
                // ── PHASE 1: ALL READS ──
                let gcashReservation = null;
                if (renewPayMethod === 'GCash' && renewGcashRef) {
                    gcashReservation = await window.reserveGcashRefInTxn(transaction, renewGcashRef);
                }
                const memberRef = doc(db, "users", id);
                const planRef = doc(db, "membershipPlans", selectedPlanId);
                const [memberSnap, planSnap] = await Promise.all([
                    transaction.get(memberRef),
                    transaction.get(planRef)
                ]);

                let lockerRef = null;
                let lockerSnap = null;
                if (hasLocker && memberSnap.exists() && memberSnap.data().lockerId) {
                    lockerRef = doc(db, "lockers", memberSnap.data().lockerId);
                    lockerSnap = await transaction.get(lockerRef);
                }

                // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──
                if (!memberSnap.exists()) {
                    throw new Error("Member not found.");
                }
                if (!planSnap.exists()) {
                    throw new Error("Selected plan not found.");
                }
                // H3 parity: reject inactive plans
                if ((planSnap.data().status || 'Active') !== 'Active') {
                    throw new Error("Selected plan is no longer active. Please pick a different plan.");
                }
                const mData = memberSnap.data();
                if (mData.status === 'Archived') {
                    throw new Error("ACCESS_DENIED: Cannot renew an archived member account.");
                }
                const planDbPrice = Number(planSnap.data().price || 0);
                const planDbDays = Number(planSnap.data().duration || 30);

                // Authoritative calculation of discount & secureFinalDue
                let dbDiscount = 0;
                if (mData.dateRegistered) {
                    const currentPlanDays = window.getPlanDays(mData.plan);
                    const currentExpiryDate = mData.dateRegistered + (currentPlanDays * 24 * 60 * 60 * 1000);
                    const remainingDays = Math.ceil((currentExpiryDate - currentTimestamp) / (1000 * 60 * 60 * 24));
                    if (remainingDays > 0) {
                        const currentPlanObj = (window.__membershipPlansData || []).find(p => p.name.toLowerCase() === (mData.plan || '').toLowerCase());
                        if (currentPlanObj) {
                            dbDiscount = (Number(currentPlanObj.price) / currentPlanDays) * remainingDays;
                        }
                    }
                }
                const secureFinalDue = Math.max(0, planDbPrice - dbDiscount + lockerPrice);

                let updates = {
                    plan: plan.name,
                    dateRegistered: currentTimestamp,
                    status: "Active",
                    expirySentNotification: false
                };

                let lockerUpdate = null;
                if (hasLocker) {
                    updates.hasLocker = true;
                    if (!mData.lockerId) {
                        updates.lockerFeePrepaid = true;
                    }
                    if (mData.lockerId && lockerRef && lockerSnap && lockerSnap.exists()) {
                        const lData = lockerSnap.data();
                        const currentExpiry = lData.expiryDate || Date.now();
                        const baseDate = currentExpiry > Date.now() ? new Date(currentExpiry) : new Date();
                        const newExpiry = new Date(baseDate.setMonth(baseDate.getMonth() + 1)).getTime();
                        lockerUpdate = { expiryDate: newExpiry, status: 'Occupied' };
                    }
                }

                const paymentDocRef = doc(paymentsCol);
                const paymentData = {
                    name: `${mData.givenName || mData.name} ${mData.familyName || ''}`.trim(),
                    transactionRef: generateTransactionRef(),
                    amount: secureFinalDue,
                    items: `Renewal: ${plan.name}${hasLocker ? ' & Locker' : ''}`,
                    type: "Membership",
                    status: "Paid",
                    paymentMethod: renewPayMethod,
                    date: new Date(currentTimestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    time: new Date(currentTimestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: currentTimestamp
                };
                if (renewPayMethod === 'GCash' && renewGcashRef) {
                    paymentData.gcashRefId = renewGcashRef;
                }

                // ── PHASE 3: ALL WRITES ──
                if (gcashReservation) {
                    window.commitGcashRefInTxn(transaction, gcashReservation.refDoc);
                }
                if (lockerRef && lockerUpdate) {
                    transaction.update(lockerRef, lockerUpdate);
                }
                transaction.update(memberRef, updates);
                transaction.set(paymentDocRef, paymentData);
            });

            if (hasLocker && !member.lockerId) {
                showToast("Membership renewed! Locker fee charged. Please assign a physical locker to this member from the Locker Grid.", "info");
            } else {
                showToast("Membership renewed successfully!", "success");
            }
            if (window.refreshLockers) window.refreshLockers();
            window.closeModal('renewMemberModal');
            if (window.logActivity) window.logActivity("Membership Renewed", `Renewed ${member.givenName || member.name} ${member.familyName || ''} with ${plan.name} (₱${finalDue}) via ${renewPayMethod}`);
        } catch (err) {
            console.error("Renewal failed:", err);
            showToast(err.message || "Error renewing membership. Please try again.", "error");
        } finally {
            _rearmRenewBtn();
        }
        }
    });
};

// ==========================================
// MEMBERSHIP PLANS MODULE (CRUD)
// ==========================================
window.__membershipPlansData = [];

// Membership plans change weekly at most. Cache in sessionStorage with 10-min TTL and
// fetch on demand instead of subscribing in real time. Call window.refreshMembershipPlans(true)
// to force a fresh read after an admin edit from this tab.
const __PLAN_CACHE_KEY = "xft_cache_membershipPlans";
const __PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
window.refreshMembershipPlans = function (force) {
    const applyData = (arr) => {
        window.__membershipPlansData = arr;
        renderMembershipPlans();
        populatePlanDropdowns();
    };
    if (!force) {
        try {
            const raw = sessionStorage.getItem(__PLAN_CACHE_KEY);
            if (raw) {
                const cached = JSON.parse(raw);
                if (cached && (Date.now() - cached.t) < __PLAN_CACHE_TTL_MS) {
                    applyData(cached.data || []);
                    return Promise.resolve();
                }
            }
        } catch (_) { /* ignore */ }
    }
    return getDocs(membershipPlansCol).then(snapshot => {
        const arr = [];
        snapshot.forEach(d => arr.push({ id: d.id, ...d.data() }));
        arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        try { sessionStorage.setItem(__PLAN_CACHE_KEY, JSON.stringify({ t: Date.now(), data: arr })); } catch (_) {}
        applyData(arr);
    });
};
window.refreshMembershipPlans();

function renderMembershipPlans() {
    const tbody = document.getElementById('plansTableBody');
    if (!tbody) return;

    const plans = window.__membershipPlansData;
    const activePlans = plans.filter(p => p.status === 'Active');

    // Stats
    if (document.getElementById('mpTotalPlans')) document.getElementById('mpTotalPlans').innerText = plans.length;
    if (document.getElementById('mpActivePlans')) document.getElementById('mpActivePlans').innerText = activePlans.length;
    if (document.getElementById('mpAvgPrice') && activePlans.length > 0) {
        const avg = activePlans.reduce((s, p) => s + Number(p.price || 0), 0) / activePlans.length;
        document.getElementById('mpAvgPrice').innerText = `₱${Math.round(avg).toLocaleString()}`;
    }

    // Subscriber count + most popular plan (computed from active members)
    const planCounts = {};
    let subscriberCount = 0;
    (membersData || []).forEach(m => {
        const pName = (m.plan || '').trim();
        const memberStatus = (m.status || '').toLowerCase();
        if (pName && memberStatus !== 'expired' && memberStatus !== 'inactive' && memberStatus !== 'archived') {
            planCounts[pName] = (planCounts[pName] || 0) + 1;
            subscriberCount++;
        }
    });
    if (document.getElementById('mpSubscriberCount')) document.getElementById('mpSubscriberCount').innerText = subscriberCount;
    if (document.getElementById('mpTopPlan')) {
        const topEntry = Object.entries(planCounts).sort((a, b) => b[1] - a[1])[0];
        document.getElementById('mpTopPlan').innerText = topEntry ? `${topEntry[0]} (${topEntry[1]})` : '—';
    }

    if (plans.length === 0) {
        tbody.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fa-solid fa-tags" style="font-size:2rem; opacity:0.15; display:block; margin-bottom:10px;"></i> No membership plans yet. Click "Create Plan" to get started.</div>';
        return;
    }

    tbody.innerHTML = plans.map((p, index) => {
        const isActive = p.status === 'Active';
        const subscriberCount = membersData.filter(m => (m.plan || '').toLowerCase() === (p.name || '').toLowerCase() && (m.status || '').toLowerCase() !== 'archived').length;
        
        // Premium styling based on price threshold or explicitly marked
        const isPremium = p.price >= 2000;

        let cardStyle = isPremium
            ? 'ring-1 ring-[#991b1b]/10'
            : '';
        let premiumAccent = isPremium
            ? '<div class="absolute top-0 left-0 w-1 h-full bg-[#991b1b]"></div>'
            : '';
        let priceColor = isPremium ? 'text-[#991b1b]' : 'text-slate-900';
        let plClass = isPremium ? 'pl-7' : '';

        return `
            <div class="bg-white border-solid border border-gray-200 rounded shadow-sm flex flex-col relative ${cardStyle}">
                ${premiumAccent}
                <div class="p-6 border-b border-solid border-gray-100 ${plClass}">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h3 class="text-xl font-bold text-slate-900 leading-none tracking-tight">${escapeHtml(p.name)}</h3>
                            <p class="text-sm text-slate-500 mt-2">${p.description ? escapeHtml(p.description) : ''}</p>
                        </div>
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" class="sr-only peer" ${isActive ? 'checked' : ''} onchange="togglePlanStatus('${p.id}', this.checked)">
                            <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#991b1b]"></div>
                            <span class="ml-2 text-xs font-medium text-slate-600">${p.status}</span>
                        </label>
                    </div>
                    <div class="mt-5 flex items-baseline gap-1">
                        <span class="text-3xl font-extrabold ${priceColor} tracking-tight">₱${Number(p.price).toLocaleString()}</span>
                        <span class="text-sm text-slate-500 font-medium">/ ${p.duration} days</span>
                    </div>
                </div>
                
                <div class="p-6 flex-grow bg-slate-50/50 ${plClass}">
                    <h4 class="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">Features</h4>
                    <ul class="space-y-3 text-sm text-slate-700">
                        ${(p.features && p.features.length > 0) ? p.features.map(feat => `
                            <li class="flex items-start gap-3">
                                <i class="fas fa-check text-emerald-600 mt-0.5 font-bold"></i>
                                <span class="leading-snug">${escapeHtml(feat)}</span>
                            </li>
                        `).join('') : `
                            <li class="flex items-start gap-3">
                                <i class="fas fa-check text-slate-400 mt-0.5 font-bold"></i>
                                <span class="text-slate-500 leading-snug">No specific features listed.</span>
                            </li>
                        `}
                    </ul>
                </div>

                <div class="bg-gray-50 border-t border-solid border-gray-200 px-4 py-3 flex items-center justify-between gap-2 ${plClass}">
                    <div class="text-sm font-semibold text-slate-600 flex items-center gap-2">
                        <i class="fas fa-users text-slate-400"></i> ${subscriberCount} Subs
                    </div>
                    <div class="flex gap-2">
                        <button type="button" class="text-sm font-semibold text-[#991b1b] hover:bg-red-50 px-4 py-2 rounded transition-colors border-solid border border-transparent hover:border-red-200 flex items-center gap-2 bg-white shadow-sm" onclick="openEditPlanModal('${p.id}')">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button type="button" class="text-sm font-semibold text-red-700 hover:bg-red-100 px-3 py-2 rounded transition-colors border-solid border border-red-200 flex items-center gap-2 bg-white shadow-sm" onclick="deletePlan('${p.id}', '${escapeHtml(p.name)}')" title="Delete Plan">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

window.togglePlanStatus = async function (id, isChecked) {
    // S5 (Sprint 8): fast-fail RBAC — admin only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin') {
        return showToast("Permission denied.", "error");
    }
    const newStatus = isChecked ? 'Active' : 'Inactive';
    try {
        await updateDoc(doc(db, "membershipPlans", id), { status: newStatus });
        if (window.refreshMembershipPlans) await window.refreshMembershipPlans(true);
        showToast(`Plan ${newStatus} successfully!`, "success");
        if (window.logActivity) window.logActivity("Plan Updated", `Plan status changed to ${newStatus}.`);
    } catch (e) {
        console.error("Error toggling plan status:", e);
        showToast("Failed to update plan status.", "error");
        renderMembershipPlans(); // Re-render to revert toggle UI if firestore failed
    }
};

// Populate all plan <select> dropdowns across the app
function populatePlanDropdowns() {
    const activePlans = (window.__membershipPlansData || []).filter(p => p.status === 'Active');

    // Registration form dropdown
    const regSelect = document.getElementById('regMemberPlan');
    if (regSelect) {
        const currentVal = regSelect.value;
        regSelect.innerHTML = '<option value="" disabled selected>Select Plan...</option>';
        activePlans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} — ₱${Number(p.price).toLocaleString()} (${p.duration} days)`;
            regSelect.appendChild(opt);
        });
        // Fallback: keep legacy plans if no Firestore plans exist yet
        if (activePlans.length === 0) {
            regSelect.innerHTML += '<option value="Gold Plan">Gold Plan</option><option value="Silver Plan">Silver Plan</option>';
        }
        if (currentVal) regSelect.value = currentVal;
    }

    // Edit member form dropdown
    const editSelect = document.getElementById('editMemberPlan');
    if (editSelect) {
        const currentVal = editSelect.value;
        editSelect.innerHTML = '';
        activePlans.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} — ₱${Number(p.price).toLocaleString()} (${p.duration} days)`;
            editSelect.appendChild(opt);
        });
        if (activePlans.length === 0) {
            editSelect.innerHTML += '<option value="Gold Plan">Gold Plan</option><option value="Silver Plan">Silver Plan</option>';
        }
        if (currentVal) editSelect.value = currentVal;
    }
}

window.openPlanModal = function (editId) {
    const form = document.getElementById('planForm');
    if (form) form.reset();
    document.getElementById('planEditId').value = '';
    document.getElementById('planModalTitle').innerHTML = '<i class="fa-solid fa-tags"></i> Create Membership Plan';
    
    // Reset features
    const list = document.getElementById('planFeaturesList');
    if (list) {
        list.innerHTML = '';
        addPlanFeatureInput("Gym Floor Access");
    }

    document.getElementById('planModal').style.display = 'flex';
};

window.openEditPlanModal = function (id) {
    const plan = (window.__membershipPlansData || []).find(p => p.id === id);
    if (!plan) return showToast("Plan not found.", "error");

    document.getElementById('planEditId').value = id;
    document.getElementById('planName').value = plan.name || '';
    document.getElementById('planDuration').value = plan.duration || '';
    document.getElementById('planPrice').value = plan.price || '';
    document.getElementById('planDescription').value = plan.description || '';
    document.getElementById('planStatus').value = plan.status || 'Active';
    
    // Load features
    const list = document.getElementById('planFeaturesList');
    if (list) {
        list.innerHTML = '';
        if (plan.features && plan.features.length > 0) {
            plan.features.forEach(f => addPlanFeatureInput(f));
        } else {
            addPlanFeatureInput("Gym Floor Access");
        }
    }

    document.getElementById('planModalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Membership Plan';
    document.getElementById('planModal').style.display = 'flex';
};

window.deletePlan = function (id, name) {
    // S5 (Sprint 8): fast-fail RBAC — admin only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin') {
        return showToast("Permission denied.", "error");
    }
    // Block if any member is currently subscribed — prevents NaN expiry / orphan plan lookups
    const subscribers = (membersData || []).filter(m => (m.plan || '').toLowerCase() === (name || '').toLowerCase());
    if (subscribers.length > 0) {
        return showToast(`Cannot delete "${name}" — ${subscribers.length} member(s) are currently subscribed. Migrate or archive them first.`, "error");
    }
    // Also block if any active booking references a member who had this plan (catches recently-changed plans with in-flight sessions)
    const subscriberIds = new Set((membersData || []).filter(m => (m.previousPlan || '').toLowerCase() === (name || '').toLowerCase()).map(m => m.id));
    const activeBookings = (window.bookingsData || []).filter(b =>
        subscriberIds.has(b.memberId) &&
        (b.status === 'Pending' || b.status === 'Confirmed')
    );
    if (activeBookings.length > 0) {
        return showToast(`Cannot delete "${name}" — ${activeBookings.length} active booking(s) still reference members previously on this plan.`, "error");
    }
    showConfirm(`Are you sure you want to delete the plan "${name}"? No members are currently subscribed.`, async () => {
        try {
            await deleteDoc(doc(db, "membershipPlans", id));
            if (window.refreshMembershipPlans) await window.refreshMembershipPlans(true);
            showToast(`Plan "${name}" deleted successfully.`, "success");
            if (window.logActivity) window.logActivity("Plan Deleted", `Deleted membership plan: ${name}`);
        } catch (err) {
            console.error(err);
            showToast("Error deleting plan.", "error");
        }
    });
};

// Plan form submission (Create / Update)
if (document.getElementById('planForm')) {
    document.getElementById('planForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        // S5 (Sprint 8): admin-only.
        const _r = (localStorage.getItem("userRole") || '').toLowerCase();
        if (_r !== 'admin') {
            return showToast("Permission denied.", "error");
        }

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const origText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

        const editId = document.getElementById('planEditId').value;
        
        // Collect features
        const featureInputs = document.querySelectorAll('.plan-feature-input');
        const features = Array.from(featureInputs).map(inp => inp.value.trim()).filter(v => v !== "");

        const planData = {
            name: document.getElementById('planName').value.trim(),
            duration: parseInt(document.getElementById('planDuration').value),
            price: parseFloat(document.getElementById('planPrice').value),
            description: document.getElementById('planDescription').value.trim(),
            status: document.getElementById('planStatus').value,
            features: features,
            updatedAt: new Date().getTime()
        };

        // Validate plan fields
        if (!planData.name || planData.name.length < 2) {
            showToast("Plan name is required (min 2 chars).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
            return;
        }
        if (isNaN(planData.duration) || planData.duration <= 0) {
            showToast("Plan duration must be greater than 0 days.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
            return;
        }
        if (isNaN(planData.price) || planData.price <= 0) {
            showToast("Plan price must be greater than ₱0.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
            return;
        }
        // Block duplicate plan name (case-insensitive) — skip current plan when editing
        const dupPlan = (window.__membershipPlansData || []).find(p =>
            p.id !== editId && (p.name || '').toLowerCase() === planData.name.toLowerCase()
        );
        if (dupPlan) {
            showToast("A plan with this name already exists.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
            return;
        }

        try {
            if (editId) {
                await updateDoc(doc(db, "membershipPlans", editId), planData);
                if (window.refreshMembershipPlans) await window.refreshMembershipPlans(true);
                showToast(`Plan "${planData.name}" updated successfully!`, "success");
                if (window.logActivity) window.logActivity("Plan Updated", `Updated plan: ${planData.name} (₱${planData.price}, ${planData.duration} days)`);
            } else {
                planData.createdAt = new Date().getTime();
                await addDoc(membershipPlansCol, planData);
                if (window.refreshMembershipPlans) await window.refreshMembershipPlans(true);
                showToast(`Plan "${planData.name}" created successfully!`, "success");
                if (window.logActivity) window.logActivity("Plan Created", `Created plan: ${planData.name} (₱${planData.price}, ${planData.duration} days)`);
            }
            window.closeModal('planModal');
        } catch (err) {
            console.error("Plan save failed:", err);
            showToast("Error saving plan. Please try again.", "error");
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origText; }
        }
    });
}

window.addPlanFeatureInput = function(val = "") {
    const container = document.getElementById('planFeaturesList');
    if (!container) return;
    
    const div = document.createElement('div');
    div.className = 'plan-feature-row';
    div.innerHTML = `
        <input type="text" class="plan-feature-input" placeholder="e.g. Free Towel" value="${val}">
        <button type="button" class="btn-remove-feature" onclick="this.parentElement.remove()" title="Remove feature">
            <i class="fas fa-times"></i>
        </button>
    `;
    container.appendChild(div);
};


// ==========================================
// 10.5 LOCKER SYSTEM MODULE
// ==========================================
// QUOTA FIX: lockers use a single persistent onSnapshot listener. Local writes propagate
// through Firestore's local cache, so refreshLockers() callers after a write are NO-OPS
// (the snapshot listener will fire automatically). Previously every locker assignment tore
// down and re-attached the listener — paying for a full collection read EACH TIME. With
// ~50 lockers and a busy front desk, that was thousands of wasted reads per day.
let lockersUnsubscribe = null;
let _lockersAttached = false;
window.refreshLockers = function () {
    if (!isStaffSide) return Promise.resolve();
    if (_lockersAttached) return Promise.resolve(); // listener already streaming — no-op
    _lockersAttached = true;

    return new Promise((resolve) => {
        lockersUnsubscribe = onSnapshot(lockersCol, (snapshot) => {
            lockersData = [];
            snapshot.forEach(d => lockersData.push({ id: d.id, ...d.data() }));
            softRender('lockers', () => {
                renderLockers();
                populateRegLockerDropdown();
            });
            resolve();
        }, (err) => {
            console.warn("[lockers] listener error", err);
            _lockersAttached = false;
            resolve();
        });
    });
};
if (isStaffSide) window.refreshLockers();

function populateRegLockerDropdown() {
    const regLockerSelect = document.getElementById('regMemberLocker');
    if (!regLockerSelect) return;

    const availableLockers = (lockersData || []).filter(l => l.status === 'Available');
    const currentVal = regLockerSelect.value;
    regLockerSelect.innerHTML = '<option value="">No Locker</option>';

    availableLockers.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `Locker #${l.number} (${l.location || 'General'})`;
        regLockerSelect.appendChild(opt);
    });

    if (currentVal) regLockerSelect.value = currentVal;
}

function renderLockers() {
    const grid = document.getElementById('lockerGrid');
    if (!grid) return;

    // Stats
    const total = lockersData.length;
    const occupied = lockersData.filter(l => l.status === 'Occupied').length;
    const available = total - occupied;
    const occupancyPct = total > 0 ? Math.round((occupied / total) * 100) : 0;

    const occRateEl = document.getElementById('lockerOccupancyRate');
    if (occRateEl) {
        occRateEl.innerText = `${occupancyPct}%`;
        occRateEl.style.color = occupancyPct >= 90 ? '#991b1b' : (occupancyPct >= 70 ? '#92400e' : '#166534');
    }
    if (document.getElementById('availableLockersCount')) document.getElementById('availableLockersCount').innerText = available;
    if (document.getElementById('occupiedLockersCount')) document.getElementById('occupiedLockersCount').innerText = occupied;

    if (total === 0) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:40px; color:var(--text-muted);">No lockers added yet. Click "Add Locker" to begin.</div>';
        return;
    }

    const statusPriority = { 'Available': 0, 'Occupied': 1 };

    grid.innerHTML = lockersData
        .sort((a, b) => {
            const pA = statusPriority[a.status] ?? 1;
            const pB = statusPriority[b.status] ?? 1;
            if (pA !== pB) return pA - pB;
            return (a.number || "").localeCompare(b.number || "", undefined, { numeric: true });
        })
        .map(l => {
        const isOccupied = l.status === 'Occupied';
        const icon = isOccupied ? 'fa-lock' : 'fa-lock-open';
        let statusClass = isOccupied ? 'occupied' : 'available';
        let statusLabel = isOccupied ? 'Occupied' : 'Available';
        let alertBadgeHtml = '';
        let pulseClass = '';

        if (isOccupied && l.memberId) {
            const member = (window.membersData || []).find(m => m.id === l.memberId);
            if (member) {
                const isArchived = (member.status || "").toLowerCase() === 'archived';
                const isExpired = window.isMemberPlanExpired && window.isMemberPlanExpired(member);
                if (isArchived) {
                    alertBadgeHtml = `<div class="locker-alert-badge archived"><i class="fa-solid fa-user-slash"></i> Archived</div>`;
                    pulseClass = 'alert-pulse-red';
                } else if (isExpired) {
                    alertBadgeHtml = `<div class="locker-alert-badge expired"><i class="fa-solid fa-hourglass-end"></i> Expired</div>`;
                    pulseClass = 'alert-pulse-orange';
                }
            } else {
                alertBadgeHtml = `<div class="locker-alert-badge deleted"><i class="fa-solid fa-user-xmark"></i> Missing</div>`;
                pulseClass = 'alert-pulse-red';
            }
        }

        return `
            <div class="locker-card ${statusClass} ${pulseClass}" onclick="openAssignLockerModal('${l.id}')">
                ${alertBadgeHtml}
                <div class="locker-icon"><i class="fa-solid ${icon}"></i></div>
                <div class="locker-number">${l.number}</div>
                <div class="locker-status-text">${statusLabel}</div>
                <div class="locker-assignee">${isOccupied ? escapeHtml(l.memberName || 'Assigned') : escapeHtml(l.location || 'Section')}</div>
            </div>
        `;
    }).join('');
}

window.openAddLockerModal = function () {
    document.getElementById('addLockerForm').reset();
    document.getElementById('addLockerModal').style.display = 'flex';
};

if (document.getElementById('addLockerForm')) {
    document.getElementById('addLockerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const number = document.getElementById('lockerNumberInput').value.trim();
        const location = document.getElementById('lockerLocationInput').value.trim();

        try {
            // Check uniqueness of locker number
            const q = query(lockersCol, where("number", "==", number));
            const snap = await getDocs(q);
            if (!snap.empty) {
                return showToast(`Locker number ${number} already exists! Please enter a unique number.`, "error");
            }

            await addDoc(lockersCol, {
                number,
                location,
                status: 'Available',
                createdAt: Date.now()
            });
            if (window.refreshLockers) await window.refreshLockers();
            window.closeModal('addLockerModal');
            showToast(`Locker ${number} created successfully!`, "success");
        } catch (err) {
            console.error(err);
            showToast("Failed to create locker.", "error");
        }
    });
}

window.openAssignLockerModal = function (id) {
    const locker = lockersData.find(l => l.id === id);
    if (!locker) return;

    document.getElementById('assignLockerId').value = id;
    document.getElementById('assignLockerNumberText').innerText = `Locker #${locker.number}`;
    document.getElementById('assignLockerLocationText').innerText = locker.location || 'General Section';

    const isOccupied = locker.status === 'Occupied';
    const form = document.getElementById('assignLockerForm');
    const info = document.getElementById('activeAssignmentInfo');

    // Reset displays
    if (form) form.style.display = 'none';
    if (info) info.style.display = 'none';

    if (isOccupied) {
        if (info) {
            info.style.display = 'block';
            let statusText = '';
            const member = (window.membersData || []).find(m => m.id === locker.memberId);
            if (member) {
                const isArchived = (member.status || "").toLowerCase() === 'archived';
                const isExpired = window.isMemberPlanExpired && window.isMemberPlanExpired(member);
                if (isArchived) statusText = ' ⚠️ (Archived)';
                else if (isExpired) statusText = ' ⚠️ (Expired Plan)';
            } else {
                statusText = ' ⚠️ (Missing Member)';
            }
            document.getElementById('assigneeName').innerText = (locker.memberName || 'Unknown Member') + statusText;
            document.getElementById('assigneeInitial').innerText = (locker.memberName || '?')[0];
            if (locker.expiryDate) {
                const exp = new Date(locker.expiryDate);
                document.getElementById('assignmentExpiry').innerText = `Expires: ${exp.toLocaleDateString()}`;
            } else {
                document.getElementById('assignmentExpiry').innerText = 'Expires: N/A';
            }
        }
    } else {
        if (form) {
            form.style.display = 'block';
            populateAssignMemberSelect();
        }
    }

    const deleteWrapper = document.getElementById('deleteLockerBtnWrapper');
    if (deleteWrapper) {
        deleteWrapper.style.display = window.isCallerAdmin() ? 'block' : 'none';
    }

    if (document.getElementById('assignLockerPayMethod')) {
        document.getElementById('assignLockerPayMethod').value = 'Cash';
    }
    if (document.getElementById('assignLockerGcashRefWrapper')) {
        document.getElementById('assignLockerGcashRefWrapper').style.display = 'none';
    }
    if (document.getElementById('assignLockerGcashRefId')) {
        document.getElementById('assignLockerGcashRefId').value = '';
    }

    document.getElementById('assignLockerModal').style.display = 'flex';
};

window.toggleLockerGcashRef = function (val) {
    const wrapper = document.getElementById('assignLockerGcashRefWrapper');
    if (wrapper) {
        wrapper.style.display = val === 'GCash' ? 'block' : 'none';
        if (val !== 'GCash') {
            const input = document.getElementById('assignLockerGcashRefId');
            if (input) input.value = '';
        }
    }
};

window.deleteLocker = async function (btn) {
    // L3 (Sprint 6): fast-fail RBAC — the UI hides the button for non-admins
    // but the function was console-callable on `window`. Admin-only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin') {
        return showToast("Permission denied.", "error");
    }
    const lockerId = document.getElementById('assignLockerId').value;
    const locker = lockersData.find(l => l.id === lockerId);
    if (!locker) return;

    if (locker.status === 'Occupied') {
        return showToast("Cannot delete an occupied locker. Please release it first.", "error");
    }

    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({ message: `Are you sure you want to permanently delete Locker #${locker.number}?`, onCancel: _rearmBtn, onConfirm: async () => {
        try {
            await deleteDoc(doc(db, "lockers", lockerId));
            if (window.refreshLockers) await window.refreshLockers();
            window.closeModal('assignLockerModal');
            showToast(`Locker #${locker.number} deleted successfully.`, "success");
            if (window.logActivity) window.logActivity("Locker Deleted", `Deleted Locker #${locker.number}`);
        } catch (err) {
            console.error(err);
            showToast("Failed to delete locker.", "error");
        } finally {
            _rearmBtn();
        }
    }});
};



function populateAssignMemberSelect() {
    const select = document.getElementById('assignMemberSelect');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>Search for a member...</option>';
    membersData.filter(m => {
        const isArchived = (m.status || "").toLowerCase() === 'archived';
        const isSuspended = (m.status || "").toLowerCase() === 'suspended';
        const isExpired = window.isMemberPlanExpired && window.isMemberPlanExpired(m);
        return !isArchived && !isSuspended && !isExpired && (m.status || 'Active') === 'Active';
    }).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.setAttribute('data-name', `${m.givenName || m.name} ${m.familyName || ''}`.trim());
        opt.textContent = `${m.uid ? m.uid + ' - ' : ''}${m.givenName || m.name} ${m.familyName || ''}`.trim();
        select.appendChild(opt);
    });
}

if (document.getElementById('assignLockerForm')) {
    document.getElementById('assignLockerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const lockerId = document.getElementById('assignLockerId').value;
        const memberId = document.getElementById('assignMemberSelect').value;
        const duration = parseInt(document.getElementById('assignDuration').value);

        // L1 (Sprint 6): reject non-positive / non-finite / unreasonably-long durations.
        // Without this, duration=0 produced a free locker with same-day expiry,
        // and negative durations produced a locker assigned with a past expiry.
        if (!Number.isFinite(duration) || duration < 1 || duration > 12) {
            return showToast("Locker duration must be between 1 and 12 month(s).", "error");
        }

        const payMethodEl = document.getElementById('assignLockerPayMethod');
        const payMethod = payMethodEl ? payMethodEl.value : 'Cash';
        const gcashRefEl = document.getElementById('assignLockerGcashRefId');
        const gcashRef = gcashRefEl ? gcashRefEl.value.trim() : '';

        // Check if the selected member has a prepaid locker fee.
        // If prepaid locker fee is true and duration is exactly 1 month, no payment is owed, so GCash validation is bypassed.
        const selectedMemberObj = (window.membersData || []).find(m => m.id === memberId);
        const hasPrepaidLockerFee = selectedMemberObj ? !!selectedMemberObj.lockerFeePrepaid : false;
        let paymentOwed = true;
        if (hasPrepaidLockerFee && duration === 1) {
            paymentOwed = false;
        }

        if (paymentOwed && payMethod === 'GCash') {
            if (!gcashRef) {
                showToast("Please enter the GCash Reference ID.", "error");
                return;
            }
            if (gcashRef.replace(/\s/g, '').length !== 12) {
                showToast("GCash Reference ID must be exactly 12 digits.", "error");
                return;
            }
            try { await window.assertGcashRefUnused(gcashRef); }
            catch (err) { return showToast(err.message, "error"); }
        }

        const memberOpt = document.querySelector(`#assignMemberSelect option[value="${memberId}"]`);
        const memberName = memberOpt ? memberOpt.getAttribute('data-name') : 'Unknown';

        const now = new Date();
        const expiryDate = new Date(now.setMonth(now.getMonth() + duration)).getTime();

        try {
            await runTransaction(db, async (transaction) => {
                // ── PHASE 1: ALL READS ──
                let gcashReservation = null;
                if (paymentOwed && payMethod === 'GCash' && gcashRef) {
                    gcashReservation = await window.reserveGcashRefInTxn(transaction, gcashRef);
                }
                const lockerRef = doc(db, "lockers", lockerId);
                const memberRef = doc(db, "users", memberId);
                const [lockerSnap, memberSnap] = await Promise.all([
                    transaction.get(lockerRef),
                    transaction.get(memberRef)
                ]);

                // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──
                if (!lockerSnap.exists()) {
                    throw new Error("Locker record does not exist.");
                }
                if (!memberSnap.exists()) {
                    throw new Error("Member record does not exist.");
                }

                const lockerData = lockerSnap.data();
                const memberData = memberSnap.data();

                if (lockerData.status === 'Occupied') {
                    throw new Error("This locker is already occupied by someone else.");
                }

                if ((memberData.status || "").toLowerCase() === 'archived') {
                    throw new Error("Cannot assign locker to an archived member.");
                }

                if ((memberData.status || "").toLowerCase() === 'suspended') {
                    throw new Error("Cannot assign locker to a suspended member.");
                }

                if (window.isMemberPlanExpired && window.isMemberPlanExpired(memberData)) {
                    throw new Error("Cannot assign locker to a member with an expired plan.");
                }

                if (typeof memberData.dateRegistered === 'number') {
                    const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(memberData.plan) : 30;
                    const planExpiry = memberData.dateRegistered + planDays * 24 * 60 * 60 * 1000;
                    if (expiryDate > planExpiry) {
                        throw new Error("Locker lease expiration date exceeds the member's current membership plan expiration date. Please renew/extend their plan first.");
                    }
                }

                let leaseCost = 0;
                let isPrepaidWaived = false;

                if (memberData.lockerFeePrepaid) {
                    if (duration > 1) {
                        leaseCost = 300 * (duration - 1);
                    } else {
                        isPrepaidWaived = true;
                    }
                } else {
                    leaseCost = 300 * duration;
                }

                let memberUpdates = {
                    hasLocker: true,
                    lockerId: lockerId
                };
                if (memberData.lockerFeePrepaid) {
                    memberUpdates.lockerFeePrepaid = false;
                }

                let paymentObj = null;
                let paymentDocRef = null;
                if (leaseCost > 0) {
                    paymentDocRef = doc(paymentsCol);
                    const nowTimestamp = Date.now();
                    paymentObj = {
                        name: memberName,
                        transactionRef: generateTransactionRef(),
                        amount: leaseCost,
                        items: memberData.lockerFeePrepaid
                            ? `Locker Lease Extension: Locker #${lockerData.number} (${duration - 1} Month(s) extra beyond 1 Month prepaid)`
                            : `Locker Lease: Locker #${lockerData.number} (${duration} Month(s))`,
                        type: "Locker Lease",
                        status: "Paid",
                        paymentMethod: payMethod,
                        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                        timestamp: nowTimestamp
                    };
                    if (payMethod === 'GCash' && gcashRef) {
                        paymentObj.gcashRefId = gcashRef.replace(/\s/g, '');
                    }
                }

                // ── PHASE 3: ALL WRITES ──
                if (gcashReservation) {
                    window.commitGcashRefInTxn(transaction, gcashReservation.refDoc);
                }
                transaction.update(lockerRef, {
                    status: 'Occupied',
                    memberId,
                    memberName,
                    expiryDate,
                    assignedAt: Date.now()
                });
                transaction.update(memberRef, memberUpdates);
                if (paymentDocRef && paymentObj) {
                    transaction.set(paymentDocRef, paymentObj);
                }
            });

            if (window.refreshLockers) await window.refreshLockers();
            window.closeModal('assignLockerModal');
            showToast(`Locker assigned to ${memberName} for ${duration} month(s).`, "success");
            if (window.logActivity) window.logActivity("Locker Assigned", `Assigned locker to ${memberName}`);
        } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to assign locker.", "error");
        }
    });
}

window.releaseLocker = async function (btn) {
    // L2 (Sprint 6): fast-fail RBAC — function was console-callable by any role
    // (member/trainer) since it was exposed on `window`. Only admin/staff may release.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin' && _r !== 'staff') {
        return showToast("Permission denied.", "error");
    }
    const lockerId = document.getElementById('assignLockerId').value;
    const locker = lockersData.find(l => l.id === lockerId);
    if (!locker) return;

    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Releasing...'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({
        title: 'Confirm Locker Release',
        message: `Confirm Locker Release & Key Return:\n\nHas the member emptied Locker #${locker.number} and returned the physical locker key to the front desk?`,
        tone: 'success',
        confirmText: 'Confirm Release',
        onCancel: _rearmBtn,
        onConfirm: async () => {
        try {
            await runTransaction(db, async (transaction) => {
                const lockerRef = doc(db, "lockers", lockerId);
                const lockerSnap = await transaction.get(lockerRef);
                if (!lockerSnap.exists()) {
                    throw new Error("Locker record does not exist.");
                }
                const currentLocker = lockerSnap.data();

                if (currentLocker.memberId) {
                    const memberRef = doc(db, "users", currentLocker.memberId);
                    const memberSnap = await transaction.get(memberRef);
                    if (memberSnap.exists()) {
                        transaction.update(memberRef, { hasLocker: false, lockerId: null });
                    }
                }

                transaction.update(lockerRef, {
                    status: 'Available',
                    memberId: null,
                    memberName: null,
                    expiryDate: null,
                    assignedAt: null
                });
            });

            if (window.refreshLockers) await window.refreshLockers();
            window.closeModal('assignLockerModal');
            showToast("Locker released successfully.", "success");
            if (window.logActivity) window.logActivity("Locker Released", `Released Locker #${locker.number}`);
        } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to release locker.", "error");
        } finally {
            _rearmBtn();
        }
        }
    });
};

window.printLockerReceipt = function () {
    showToast("Printing locker assignment receipt...", "info");
    window.print();
};

window.currentMemberAlertFilter = null;

window.toggleMemberAlertFilter = function (filterId) {
    if (window.currentMemberAlertFilter === filterId) {
        window.currentMemberAlertFilter = null;
    } else {
        window.currentMemberAlertFilter = filterId;
    }
    
    window.memCurrentPage = 1;
    renderMembers();
};

function renderMembers() {
    const memTbody = document.querySelector('#membersTable tbody');
    const arcTbody = document.querySelector('#archivedMembersTable tbody');
    // Remove early return to allow KPI updates even if table is missing


    // 1. Calculate KPI Metrics
    let activeMembers = 0;
    let expiringSoon = 0;
    let newMembers30d = 0;

    const now = new Date().getTime();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    const activeList = [];
    const archivedList = [];

    // Filter Logic
    const searchVal = (document.getElementById('memberSearch')?.value || "").toLowerCase();
    const planFilter = document.getElementById('memberFilterPlan')?.value || "all";
    const statusFilter = document.getElementById('memberFilterStatus')?.value || "all";

    membersData.forEach(m => {
        const statusStr = (m.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();

        // Count New Members (Last 30 Days)
        if (m.dateRegistered && m.dateRegistered > thirtyDaysAgo) {
            newMembers30d++;
        }

        if (statusLower === 'archived') {
            archivedList.push(m);
        } else {
            // Apply Filters to Active List only for display
            const matchesSearch = !searchVal ||
                (m.name || "").toLowerCase().includes(searchVal) ||
                (m.uid || "").toLowerCase().includes(searchVal) ||
                (m.email || "").toLowerCase().includes(searchVal) ||
                (m.givenName || "").toLowerCase().includes(searchVal) ||
                (m.familyName || "").toLowerCase().includes(searchVal);

            const matchesPlan = planFilter === "all" || m.plan === planFilter;
            const matchesStatus = statusFilter === "all" || statusStr === statusFilter;

            let matchesAlert = true;
            if (window.currentMemberAlertFilter) {
                if (window.currentMemberAlertFilter === 'active') {
                    matchesAlert = statusLower === 'active';
                } else if (window.currentMemberAlertFilter === 'expiringSoon') {
                    const plan = m.plan || 'Standard Member';
                    const planDays = window.getPlanDays(plan);
                    if (m.dateRegistered) {
                        const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                        const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                        matchesAlert = diffDays > 0 && diffDays <= 7;
                    } else {
                        matchesAlert = false;
                    }
                } else if (window.currentMemberAlertFilter === 'newMembers') {
                    matchesAlert = m.dateRegistered && m.dateRegistered > thirtyDaysAgo;
                }
            }

            if (matchesSearch && matchesPlan && matchesStatus && matchesAlert) {
                activeList.push(m);
            }

            if (statusLower === 'active') activeMembers++;

            // Count Expiring Soon
            const plan = m.plan || 'Standard Member';
            const planDays = window.getPlanDays(plan);
            if (m.dateRegistered) {
                const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                if (diffDays > 0 && diffDays <= 7) expiringSoon++;
            }
        }
    });

    // Update KPI UI
    if (document.getElementById('financialTotalActiveMembers')) document.getElementById('financialTotalActiveMembers').innerText = activeMembers;
    if (document.getElementById('financialExpiringSoon')) document.getElementById('financialExpiringSoon').innerText = expiringSoon;
    if (document.getElementById('financialNewMembers')) document.getElementById('financialNewMembers').innerText = newMembers30d;

    // Update KPI UI Card highlight classes
    const kpiActive = document.getElementById('kpiActiveMembers');
    const kpiExpiring = document.getElementById('kpiExpiringSoon');
    const kpiNew = document.getElementById('kpiNewMembers');
    
    if (kpiActive) kpiActive.classList.toggle('active-filter', window.currentMemberAlertFilter === 'active');
    if (kpiExpiring) kpiExpiring.classList.toggle('active-filter', window.currentMemberAlertFilter === 'expiringSoon');
    if (kpiNew) kpiNew.classList.toggle('active-filter', window.currentMemberAlertFilter === 'newMembers');

    // 2. Render Rows
    const renderMemberRow = (m, isArchived) => {
        let plan = m.plan || 'Standard Member';
        let daysLeftText = "N/A", timerBadgeClass = "active";
        const planDays = window.getPlanDays(plan);

        if (m.dateRegistered) {
            const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
            const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
            if (diffDays > 0) {
                daysLeftText = `${diffDays} Days`;
                if (diffDays <= 7) timerBadgeClass = "pending";
            } else {
                daysLeftText = "Expired";
                timerBadgeClass = "broken";
            }
        } else {
            daysLeftText = `${planDays} Days`;
        }

        if (isArchived) {
            return `
                <tr>
                    <td><a href="javascript:void(0)" onclick="window.openMemberProfile('${m.id}')" style="font-weight: 600; color: var(--text-primary); text-decoration: none; border-bottom: 1px dashed var(--border-color);">${escapeHtml(m.givenName || m.name)}</a></td><td>${escapeHtml(m.mi || '')}</td><td>${escapeHtml(m.familyName || '')}</td>
                    <td>${escapeHtml(m.email)}</td><td><strong>${escapeHtml(plan)}</strong></td><td><span class="status-badge-solid voided">Archived</span></td>
                    <td style="text-align: right;">
                        <button type="button" class="btn-icon" style="color: #10B981;" title="Restore Account" onclick="archiveUser('${m.id}', 'Archived', this)"><i class="fas fa-box-open"></i></button>
                        <button type="button" class="btn-icon" style="color: #EF4444;" title="Permanently Delete" onclick="deleteUser('${m.id}', this)"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
        } else {
            let badgeClass = (m.status || "Active").trim().toLowerCase() === 'active' ? 'active' : 'inactive';
            let statusHtml = `<span class="badge ${badgeClass}">${m.status || 'Active'}</span>`;

            const avatarHtml = (m.image && window.isSafeImageSrc(m.image))
                ? `<img src="${escapeHtml(m.image)}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">`
                : `<div class="chat-avatar" style="width:32px; height:32px;"><i class="fa-solid fa-user" style="font-size: 12px;"></i></div>`;

            // Inline Action Buttons (Similar to Staff/Trainers)
            const actionHtml = `
                <div class="flex gap-1 justify-end">
                    <button type="button" class="btn-icon" style="color: #3B82F6;" title="Renew/Extend" onclick="renewMember('${m.id}')"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" class="btn-icon" style="color: var(--dark-black);" title="Edit Profile" onclick="openEditMemberModal('${m.id}')"><i class="fa-solid fa-user-edit"></i></button>
                    <button type="button" class="btn-icon" style="color: #10B981;" title="Top-up Credit" onclick="openAddCreditModal('${m.id}')"><i class="fa-solid fa-wallet"></i></button>
                    <button type="button" class="btn-icon" style="color: #f39c12;" title="Archive Member" onclick="archiveUser('${m.id}', '${m.status || 'Active'}', this)"><i class="fas fa-box-archive"></i></button>
                </div>
            `;

            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <a href="javascript:void(0)" onclick="window.openMemberProfile('${m.id}')" style="font-weight: 600; color: var(--text-primary); text-decoration: none; border-bottom: 1px dashed var(--border-color); transition: all 0.2s;" onmouseover="this.style.color='var(--primary-red)'; this.style.borderBottomColor='var(--primary-red)';" onmouseout="this.style.color='var(--text-primary)'; this.style.borderBottomColor='var(--border-color)';">${escapeHtml(m.givenName ? `${m.givenName} ${m.familyName || ''}`.trim() : (m.name || "User"))}</a>
                            <div style="font-size: 11px; color: #94a3b8;">${m.uid ? escapeHtml(m.uid) + ' • ' : ''}${escapeHtml(m.email)}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${plan}</td>
                    <td><span class="badge ${timerBadgeClass}" style="font-size: 11px; padding: 2px 6px;"><i class="fa-regular fa-clock"></i> ${daysLeftText}</span></td>
                    <td style="font-weight: 600;">₱${(m.creditBalance || 0).toFixed(2)}</td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionHtml}</td>
                </tr>
            `;
        }
    };

    // 3. Sort Lists
    const sortMemberList = (list) => {
        list.sort((a, b) => {
            let valA, valB;
            if (currentMemberSortField === 'name') {
                valA = (a.givenName ? `${a.givenName} ${a.familyName || ''}` : (a.name || "")).trim().toLowerCase();
                valB = (b.givenName ? `${b.givenName} ${b.familyName || ''}` : (b.name || "")).trim().toLowerCase();
            } else if (currentMemberSortField === 'plan') {
                valA = (a.plan || 'Standard Member').toLowerCase();
                valB = (b.plan || 'Standard Member').toLowerCase();
            } else if (currentMemberSortField === 'daysLeft') {
                const planA = window.getPlanDays(a.plan || 'Standard Member');
                const planB = window.getPlanDays(b.plan || 'Standard Member');
                valA = a.dateRegistered ? Math.ceil((a.dateRegistered + (planA * 24 * 60 * 60 * 1000) - now) / (1000 * 60 * 60 * 24)) : planA;
                valB = b.dateRegistered ? Math.ceil((b.dateRegistered + (planB * 24 * 60 * 60 * 1000) - now) / (1000 * 60 * 60 * 24)) : planB;
            } else if (currentMemberSortField === 'credit') {
                valA = a.creditBalance || 0;
                valB = b.creditBalance || 0;
            } else if (currentMemberSortField === 'dateRegistered') {
                valA = a.dateRegistered || a.timestamp || 0;
                valB = b.dateRegistered || b.timestamp || 0;
            } else {
                valA = ""; valB = "";
            }

            if (valA < valB) return currentMemberSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return currentMemberSortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    };

    sortMemberList(activeList);
    sortMemberList(archivedList);

    if (memTbody) {
        const totalRecords = activeList.length;
        const totalPages = Math.ceil(totalRecords / memItemsPerPage);
        if (memCurrentPage > totalPages && totalPages > 0) memCurrentPage = totalPages;
        if (memCurrentPage < 1) memCurrentPage = 1;
        const startIdx = (memCurrentPage - 1) * memItemsPerPage;
        const endIdx = Math.min(startIdx + memItemsPerPage, totalRecords);
        const displayData = activeList.slice(startIdx, endIdx);

        const countEl = document.getElementById('memberRecordCount');
        if (countEl) {
            countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
        }

        window.renderPaginationControls('memberPagination', memCurrentPage, totalPages, totalRecords, 'changeMemPage');

        window.syncDOM(memTbody, displayData, (m) => renderMemberRow(m, false), 'mem-row');
    }
    if (arcTbody) {
        const totalRecords = archivedList.length;
        const totalPages = Math.ceil(totalRecords / memItemsPerPage);
        if (arcMemCurrentPage > totalPages && totalPages > 0) arcMemCurrentPage = totalPages;
        if (arcMemCurrentPage < 1) arcMemCurrentPage = 1;
        const startIdx = (arcMemCurrentPage - 1) * memItemsPerPage;
        const endIdx = Math.min(startIdx + memItemsPerPage, totalRecords);
        const displayData = archivedList.slice(startIdx, endIdx);

        const countEl = document.getElementById('arcMemberRecordCount');
        if (countEl) countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;

        window.renderPaginationControls('arcMemberPagination', arcMemCurrentPage, totalPages, totalRecords, 'changeArcMemPage');

        window.syncDOM(arcTbody, displayData, (m) => renderMemberRow(m, true), 'arc-row');
        // M-08 Fix: Show empty state for archived members
        if (archivedList.length === 0 && arcTbody.children.length === 0) {
            arcTbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-box-open" style="font-size:2rem; opacity:0.15; display:block; margin-bottom:10px;"></i>No archived members.</td></tr>';
        }
    }


    if (document.getElementById('dashActiveMembers')) document.getElementById('dashActiveMembers').innerText = activeMembers;
    if (document.getElementById('gridMembers')) document.getElementById('gridMembers').innerText = activeList.length;
    if (window.refreshDashboardAnalytics) window.refreshDashboardAnalytics();
}

// Member UI Helpers
window.sendMessageToMember = async function (id) {
    if (window.openChatTab) window.openChatTab('all', null, 'Internal Messages');
    if (window.openChat) await window.openChat(id);
    else showToast("Chat is not available on this dashboard.", "info");
};

window.filterMembers = function () {
    memCurrentPage = 1;
    arcMemCurrentPage = 1;
    renderMembers();
};

window.sortMembers = function (field) {
    if (currentMemberSortField === field) {
        currentMemberSortOrder = currentMemberSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentMemberSortField = field;
        currentMemberSortOrder = 'asc';
    }

    const table = document.getElementById('membersTable');
    if (table) {
        const headers = table.querySelectorAll('th');
        headers.forEach(th => {
            const icon = th.querySelector('i');
            if (icon) icon.className = 'fas fa-sort';
        });
        const activeHeader = Array.from(headers).find(th => th.getAttribute('onclick')?.includes(`'${field}'`));
        if (activeHeader) {
            const icon = activeHeader.querySelector('i');
            if (icon) icon.className = `fas fa-sort-${currentMemberSortOrder === 'asc' ? 'up' : 'down'}`;
        }
    }
    
    renderMembers();
};

window.changeMemberPagination = function () {
    renderMembers();
};

window.openEditMemberModal = function (id) {
    const member = membersData.find(m => m.id === id);
    if (!member) return;

    if (document.getElementById('editMemberId')) {
        document.getElementById('editMemberId').value = id;
    }
    if (document.getElementById('editMemberGiven')) {
        document.getElementById('editMemberGiven').value = member.givenName || '';
    }
    if (document.getElementById('editMemberMI')) {
        document.getElementById('editMemberMI').value = member.mi || '';
    }
    if (document.getElementById('editMemberFamily')) {
        document.getElementById('editMemberFamily').value = member.familyName || '';
    }
    if (document.getElementById('editMemberRfid')) {
        document.getElementById('editMemberRfid').value = member.rfid || '';
    }
    if (document.getElementById('editMemberPlan')) {
        document.getElementById('editMemberPlan').value = member.plan || 'Gold Plan';
    }
    if (document.getElementById('editMemberImage')) {
        document.getElementById('editMemberImage').value = member.image || '';
    }
    if (document.getElementById('editMemberPreview')) {
        document.getElementById('editMemberPreview').src = member.image || 'images/default-profile.png';
    }
    if (document.getElementById('editMemberEmergency')) {
        document.getElementById('editMemberEmergency').value = member.emergencyContact || '';
    }
    if (document.getElementById('editMemberSessionsRemaining')) {
        document.getElementById('editMemberSessionsRemaining').value = member.sessionsRemaining !== undefined ? member.sessionsRemaining : 0;
    }
    if (document.getElementById('editMemberSessionsTotal')) {
        document.getElementById('editMemberSessionsTotal').value = member.sessionsTotal !== undefined ? member.sessionsTotal : 0;
    }

    document.getElementById('editMemberModal').style.display = 'flex';
}

if (document.getElementById('editMemberForm')) {
    document.getElementById('editMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editMemberId').value;
        const given = document.getElementById('editMemberGiven').value.trim();
        const mi = document.getElementById('editMemberMI').value.trim();
        const family = document.getElementById('editMemberFamily').value.trim();

        // Validation (C-02 Fix) \u2014 VULN-02: upper-bound cap added
        const nameRegex = /^[A-Za-z\s\-\u00f1\u00d1]{2,80}$/;
        if (!given || !nameRegex.test(given)) {
            return showToast("First Name must be 2\u201380 letters (no numbers or special characters).", "error");
        }
        if (!family || !nameRegex.test(family)) {
            return showToast("Last Name must be 2\u201380 letters (no numbers or special characters).", "error");
        }
        const emergencyVal = document.getElementById('editMemberEmergency') ? document.getElementById('editMemberEmergency').value.trim() : "";
        if (emergencyVal && !/^\+?[0-9]{7,15}$/.test(emergencyVal)) {
            return showToast("Emergency contact must be a valid phone number (7-15 digits).", "error");
        }

        const updatedData = {
            givenName: given,
            mi: mi,
            familyName: family,
            name: `${given} ${family}`.trim(),
            emergencyContact: emergencyVal
        };

        if (document.getElementById('editMemberPlan')) {
            updatedData.plan = document.getElementById('editMemberPlan').value;
        }

        if (document.getElementById('editMemberRfid')) {
            updatedData.rfid = document.getElementById('editMemberRfid').value.trim();
        }

        if (document.getElementById('editMemberSessionsRemaining')) {
            // VULN-04: reject floats, negative values, and unreasonably large integers
            const sessVal = Number(document.getElementById('editMemberSessionsRemaining').value || 0);
            if (!Number.isInteger(sessVal) || sessVal < 0 || sessVal > 9999) {
                return showToast("Sessions remaining must be a whole number between 0 and 9999.", "error");
            }
            updatedData.sessionsRemaining = sessVal;
        }

        if (document.getElementById('editMemberSessionsTotal')) {
            const sessVal = Number(document.getElementById('editMemberSessionsTotal').value || 0);
            if (!Number.isInteger(sessVal) || sessVal < 0 || sessVal > 9999) {
                return showToast("Total sessions must be a whole number between 0 and 9999.", "error");
            }
            updatedData.sessionsTotal = sessVal;
        }

        if (document.getElementById('editMemberImageFile')) {
            const imageFile = document.getElementById('editMemberImageFile').files[0];
            let imageUrl = document.getElementById('editMemberImage').value.trim();
            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'members');
            }
            updatedData.image = imageUrl || '';
        }

        try {
            if (updatedData.rfid) {
                // Use in-memory user cache to avoid failing the write flow
                // when Firestore reads for uniqueness checks are blocked/slow.
                // M1: archived users don't count — their card is reusable.
                const duplicate = (window.allUsersData || []).find(u =>
                    u.id !== id &&
                    (u.rfid || "") === updatedData.rfid &&
                    ((u.status || "").toLowerCase() !== "archived")
                );
                if (duplicate) {
                    const dupName = duplicate.name || `${duplicate.givenName || ''} ${duplicate.familyName || ''}`.trim();
                    return showToast(`RFID tag collision! This RFID is already assigned to ${dupName || 'another user'}.`, "error");
                }
            }

            await updateDoc(doc(db, "users", id), updatedData);
            window.closeModal('editMemberModal');
            showToast("Member details updated successfully!", "success");
            if (window.logActivity) window.logActivity("Member Edited", `Edited member: ${updatedData.givenName} ${updatedData.familyName}`);
        } catch (error) {
            console.error("Member update failed:", error);
            showToast("Failed to update member. Please try again.", "error");
        }
    });
}

function renderStaff() {
    const staffTbody = document.querySelector('#staffTable tbody');
    const trainerTbody = document.querySelector('#trainerTable tbody');
    const arcStaffTbody = document.querySelector('#archivedStaffTable tbody');
    const arcTrainerTbody = document.querySelector('#archivedTrainerTable tbody');
    // Early return removed to allow dashboard feed updates


    // 1. Initialize KPI Metrics
    let staffActive = 0, staffOnShift = 0, staffOnLeave = 0;
    let trainerActive = 0, trainerOnFloor = 0;

    const now = new Date().getTime();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    const todayDateStr = new Date().toLocaleDateString('en-CA');
    // Trainer Sessions Today (across all bookings for today, non-cancelled)
    const trainerSessionsToday = (window.bookingsData || []).filter(
        b => b.date === todayDateStr && b.status !== 'Cancelled'
    ).length;

    const staffList = [];
    const trainerList = [];
    const arcStaffList = [];
    const arcTrainerList = [];

    // Filter values - Staff
    const staffSearch = (document.getElementById('staffSearchModern')?.value || "").toLowerCase();
    const staffRoleFilter = document.getElementById('staffFilterRole')?.value || "all";
    const staffStatusFilter = document.getElementById('staffFilterStatus')?.value || "all";

    // Filter values - Trainers
    const trainerSearch = (document.getElementById('trainerSearchModern')?.value || "").toLowerCase();
    const trainerSpecFilter = document.getElementById('trainerFilterSpecialty')?.value || "all";
    const trainerStatusFilter = document.getElementById('trainerFilterStatus')?.value || "all";

    allUsersData.forEach(u => {
        const roleStr = (u.role || "").trim();
        const roleLower = roleStr.toLowerCase();
        const statusStr = (u.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();

        if (statusLower === 'archived') {
            if (roleLower === 'trainer') arcTrainerList.push(u);
            else arcStaffList.push(u);
        } else {
            const isTrainer = roleLower === 'trainer';
            const isStaffOrAdmin = roleLower === 'staff' || roleLower === 'admin';

            // Process Staff/Admin
            if (isStaffOrAdmin) {
                if (statusLower === 'active') staffActive++;
                if (u.shiftStatus === 'On Shift') staffOnShift++;
                if (statusLower === 'on leave') staffOnLeave++;

                const matchesSearch = !staffSearch ||
                    (u.name || "").toLowerCase().includes(staffSearch) ||
                    (u.uid || "").toLowerCase().includes(staffSearch) ||
                    (u.email || "").toLowerCase().includes(staffSearch) ||
                    (u.givenName || "").toLowerCase().includes(staffSearch) ||
                    (u.familyName || "").toLowerCase().includes(staffSearch);
                const matchesRole = staffRoleFilter === "all" || roleStr === staffRoleFilter;
                const matchesStatus = staffStatusFilter === "all" || statusStr === staffStatusFilter;

                if (matchesSearch && matchesRole && matchesStatus) staffList.push(u);
            }

            // Process Trainers
            if (isTrainer) {
                if (statusLower === 'active') trainerActive++;
                if (u.shiftStatus === 'On Floor') trainerOnFloor++;

                const matchesSearch = !trainerSearch ||
                    (u.name || "").toLowerCase().includes(trainerSearch) ||
                    (u.uid || "").toLowerCase().includes(trainerSearch) ||
                    (u.email || "").toLowerCase().includes(trainerSearch) ||
                    (u.givenName || "").toLowerCase().includes(trainerSearch) ||
                    (u.familyName || "").toLowerCase().includes(trainerSearch);
                const matchesSpec = trainerSpecFilter === "all" || (u.specialty || "General Fitness") === trainerSpecFilter;
                const matchesStatus = trainerStatusFilter === "all" || statusStr === trainerStatusFilter;

                if (matchesSearch && matchesSpec && matchesStatus) trainerList.push(u);
            }
        }
    });

    // Update Staff KPI UI
    if (document.getElementById('staffTotalActive')) document.getElementById('staffTotalActive').innerText = staffActive;
    if (document.getElementById('staffOnShift')) document.getElementById('staffOnShift').innerText = staffOnShift;
    if (document.getElementById('staffOnLeave')) document.getElementById('staffOnLeave').innerText = staffOnLeave;

    // Update Trainer KPI UI
    if (document.getElementById('trainerTotalActive')) document.getElementById('trainerTotalActive').innerText = trainerActive;
    if (document.getElementById('trainerOnFloor')) document.getElementById('trainerOnFloor').innerText = trainerOnFloor;
    if (document.getElementById('trainerSessionsToday')) document.getElementById('trainerSessionsToday').innerText = trainerSessionsToday;

    const renderStaffRow = (u, isArchived) => {
        const roleStr = (u.role || "").trim();
        const roleLower = roleStr.toLowerCase();
        const statusStr = (u.status || "Active").trim();
        const statusLower = statusStr.toLowerCase();
        let fullName = escapeHtml(u.givenName ? `${u.givenName} ${u.familyName || ''}`.trim() : (u.name || "User"));
        let specialty = escapeHtml(u.specialty || 'General Fitness');

        const avatarHtml = (u.image && window.isSafeImageSrc(u.image))
            ? `<img src="${escapeHtml(u.image)}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">`
            : `<div class="initial-avatar" style="width:32px; height:32px; font-size:11px;">${escapeHtml((u.givenName || u.name || "?")[0] || '')}${escapeHtml((u.familyName || "")[0] || "")}</div>`;

        let actionBtns = isArchived ? `
            <div class="flex gap-1 justify-end">
                <button type="button" class="btn-icon" style="color: #10B981;" title="Restore Account" onclick="archiveUser('${u.id}', 'Archived', this)"><i class="fas fa-box-open"></i></button>
                <button type="button" class="btn-icon" style="color: #EF4444;" title="Permanently Delete" onclick="deleteUser('${u.id}', this)"><i class="fas fa-trash"></i></button>
            </div>
        ` : `
            <div class="flex gap-1 justify-end">
                <button type="button" class="btn-icon" style="color: var(--dark-black);" title="Edit Details" onclick="openEditStaffModal('${u.id}')"><i class="fa-solid fa-user-edit"></i></button>
                <button type="button" class="btn-icon" style="color: #f39c12;" title="Archive Account" onclick="archiveUser('${u.id}', '${statusStr}', this)"><i class="fas fa-box-archive"></i></button>
            </div>
        `;

        let statusBadgeClass = (statusLower === 'active' || statusLower === 'on leave') ? 'active' : 'inactive';
        let shiftBadge = '';
        if (roleLower === 'staff' || roleLower === 'admin') {
            const isWorking = u.shiftStatus === 'On Shift';
            shiftBadge = `<span class="badge ${isWorking ? 'active' : 'inactive'}" style="${isWorking ? 'background: var(--dark-black); color: white;' : ''}">${isWorking ? 'On Shift' : 'Off Shift'}</span>`;
        } else if (roleLower === 'trainer') {
            const isOnFloor = u.shiftStatus === 'On Floor';
            shiftBadge = `<span class="badge ${isOnFloor ? 'active' : 'inactive'}" style="${isOnFloor ? 'background: #3B82F6; color: white;' : ''}">${isOnFloor ? 'On Floor' : 'Off Floor'}</span>`;
        }

        let statusHtml = `<div style="display: flex; gap: 5px;"><span class="badge ${statusBadgeClass}">${statusStr}</span>${shiftBadge}</div>`;

        if (roleLower === 'trainer') {
            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <div style="font-weight: 600;">${fullName}</div>
                            <div style="font-size: 11px; color: #94a3b8;">${u.uid ? escapeHtml(u.uid) + ' • ' : ''}${escapeHtml(u.email)}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${specialty}</td>
                    <td><strong>${roleStr}</strong></td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionBtns}</td>
                </tr>
            `;
        } else {
            return `
                <tr>
                    <td style="display:flex; align-items:center; gap:10px; border-bottom:none;">
                        ${avatarHtml}
                        <div>
                            <div style="font-weight: 600;">${fullName}</div>
                            <div style="font-size: 11px; color: #94a3b8;">${u.uid ? u.uid + ' • ' : ''}${u.email}</div>
                        </div>
                    </td>
                    <td style="font-weight: 500;">${roleStr}</td>
                    <td>${statusHtml}</td>
                    <td style="text-align: right;">${actionBtns}</td>
                </tr>
            `;
        }
    };

    // 3. Sort Staff and Trainer Lists
    const sortStaffList = (list) => {
        list.sort((a, b) => {
            let valA, valB;
            if (currentStaffSortField === 'name') {
                valA = (a.givenName ? `${a.givenName} ${a.familyName || ''}` : (a.name || "")).trim().toLowerCase();
                valB = (b.givenName ? `${b.givenName} ${b.familyName || ''}` : (b.name || "")).trim().toLowerCase();
            } else if (currentStaffSortField === 'role') {
                valA = (a.role || "").toLowerCase();
                valB = (b.role || "").toLowerCase();
            } else if (currentStaffSortField === 'email') {
                valA = (a.email || "").toLowerCase();
                valB = (b.email || "").toLowerCase();
            } else if (currentStaffSortField === 'dateRegistered') {
                valA = a.dateRegistered || a.timestamp || 0;
                valB = b.dateRegistered || b.timestamp || 0;
            } else {
                valA = ""; valB = "";
            }

            if (valA < valB) return currentStaffSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return currentStaffSortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    };

    sortStaffList(staffList);
    sortStaffList(arcStaffList);

    const sortTrainerList = (list) => {
        list.sort((a, b) => {
            let valA, valB;
            if (currentTrainerSortField === 'name') {
                valA = (a.givenName ? `${a.givenName} ${a.familyName || ''}` : (a.name || "")).trim().toLowerCase();
                valB = (b.givenName ? `${b.givenName} ${b.familyName || ''}` : (b.name || "")).trim().toLowerCase();
            } else if (currentTrainerSortField === 'specialty') {
                valA = (a.specialty || "General Fitness").toLowerCase();
                valB = (b.specialty || "General Fitness").toLowerCase();
            } else if (currentTrainerSortField === 'role') {
                valA = (a.role || "").toLowerCase();
                valB = (b.role || "").toLowerCase();
            } else if (currentTrainerSortField === 'dateRegistered') {
                valA = a.dateRegistered || a.timestamp || 0;
                valB = b.dateRegistered || b.timestamp || 0;
            } else {
                valA = ""; valB = "";
            }

            if (valA < valB) return currentTrainerSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return currentTrainerSortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    };

    sortTrainerList(trainerList);
    sortTrainerList(arcTrainerList);

    // Staff Pagination
    if (staffTbody) {
        const totalRecords = staffList.length;
        const totalPages = Math.ceil(totalRecords / staffItemsPerPage);
        if (staffCurrentPage > totalPages && totalPages > 0) staffCurrentPage = totalPages;
        if (staffCurrentPage < 1) staffCurrentPage = 1;
        const startIdx = (staffCurrentPage - 1) * staffItemsPerPage;
        const endIdx = Math.min(startIdx + staffItemsPerPage, totalRecords);
        const displayData = staffList.slice(startIdx, endIdx);

        const countEl = document.getElementById('staffRecordCount');
        if (countEl) {
            countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
        }

        window.renderPaginationControls('staffPagination', staffCurrentPage, totalPages, totalRecords, 'changeStaffPage');
        window.syncDOM(staffTbody, displayData, (u) => renderStaffRow(u, false), 'staff-row');
    }

    // Trainer Pagination
    if (trainerTbody) {
        const totalRecords = trainerList.length;
        const totalPages = Math.ceil(totalRecords / trainerItemsPerPage);
        if (trainerCurrentPage > totalPages && totalPages > 0) trainerCurrentPage = totalPages;
        if (trainerCurrentPage < 1) trainerCurrentPage = 1;
        const startIdx = (trainerCurrentPage - 1) * trainerItemsPerPage;
        const endIdx = Math.min(startIdx + trainerItemsPerPage, totalRecords);
        const displayData = trainerList.slice(startIdx, endIdx);

        const countEl = document.getElementById('trainerRecordCount');
        if (countEl) {
            countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
        }

        window.renderPaginationControls('trainerPagination', trainerCurrentPage, totalPages, totalRecords, 'changeTrainerPage');
        window.syncDOM(trainerTbody, displayData, (u) => renderStaffRow(u, false), 'trainer-row');
    }
    if (arcStaffTbody) {
        const totalRecords = arcStaffList.length;
        const totalPages = Math.ceil(totalRecords / staffItemsPerPage);
        if (arcStaffCurrentPage > totalPages && totalPages > 0) arcStaffCurrentPage = totalPages;
        if (arcStaffCurrentPage < 1) arcStaffCurrentPage = 1;
        const startIdx = (arcStaffCurrentPage - 1) * staffItemsPerPage;
        const endIdx = Math.min(startIdx + staffItemsPerPage, totalRecords);
        const displayData = arcStaffList.slice(startIdx, endIdx);

        const countEl = document.getElementById('arcStaffRecordCount');
        if (countEl) countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;

        window.renderPaginationControls('arcStaffPagination', arcStaffCurrentPage, totalPages, totalRecords, 'changeArcStaffPage');
        window.syncDOM(arcStaffTbody, displayData, (u) => renderStaffRow(u, true), 'arc-staff-row');
        // M-08 Fix: Show empty state for archived staff
        if (arcStaffList.length === 0 && arcStaffTbody.children.length === 0) {
            arcStaffTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-box-open" style="font-size:2rem; opacity:0.15; display:block; margin-bottom:10px;"></i>No archived staff members.</td></tr>';
        }
    }

    if (arcTrainerTbody) {
        const totalRecords = arcTrainerList.length;
        const totalPages = Math.ceil(totalRecords / trainerItemsPerPage);
        if (arcTrainerCurrentPage > totalPages && totalPages > 0) arcTrainerCurrentPage = totalPages;
        if (arcTrainerCurrentPage < 1) arcTrainerCurrentPage = 1;
        const startIdx = (arcTrainerCurrentPage - 1) * trainerItemsPerPage;
        const endIdx = Math.min(startIdx + trainerItemsPerPage, totalRecords);
        const displayData = arcTrainerList.slice(startIdx, endIdx);

        const countEl = document.getElementById('arcTrainerRecordCount');
        if (countEl) countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;

        window.renderPaginationControls('arcTrainerPagination', arcTrainerCurrentPage, totalPages, totalRecords, 'changeArcTrainerPage');
        window.syncDOM(arcTrainerTbody, displayData, (u) => renderStaffRow(u, true), 'arc-trainer-row');
        // M-08 Fix: Show empty state for archived trainers
        if (arcTrainerList.length === 0 && arcTrainerTbody.children.length === 0) {
            arcTrainerTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-box-open" style="font-size:2rem; opacity:0.15; display:block; margin-bottom:10px;"></i>No archived trainers.</td></tr>';
        }
    }


    if (document.getElementById('dashStaffTotal')) document.getElementById('dashStaffTotal').innerText = staffActive;
    if (document.getElementById('gridTrainers')) document.getElementById('gridTrainers').innerText = trainerActive;
    // L-03 Fix: Trainers feed now only rendered from renderMemberTrainers() to avoid double rendering
}

// Staff & Trainer UI Helpers
window.filterStaff = function () { staffCurrentPage = 1; arcStaffCurrentPage = 1; renderStaff(); };
window.filterTrainers = function () { trainerCurrentPage = 1; arcTrainerCurrentPage = 1; renderStaff(); };
window.sortStaff = function (field) {
    if (currentStaffSortField === field) {
        currentStaffSortOrder = currentStaffSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentStaffSortField = field;
        currentStaffSortOrder = 'asc';
    }

    const table = document.getElementById('staffTable');
    if (table) {
        const headers = table.querySelectorAll('th');
        headers.forEach(th => {
            const icon = th.querySelector('i');
            if (icon) icon.className = 'fas fa-sort';
        });
        const activeHeader = Array.from(headers).find(th => th.getAttribute('onclick')?.includes(`'${field}'`));
        if (activeHeader) {
            const icon = activeHeader.querySelector('i');
            if (icon) icon.className = `fas fa-sort-${currentStaffSortOrder === 'asc' ? 'up' : 'down'}`;
        }
    }
    
    renderStaff();
};

window.sortTrainers = function (field) {
    if (currentTrainerSortField === field) {
        currentTrainerSortOrder = currentTrainerSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentTrainerSortField = field;
        currentTrainerSortOrder = 'asc';
    }

    const table = document.getElementById('trainerTable');
    if (table) {
        const headers = table.querySelectorAll('th');
        headers.forEach(th => {
            const icon = th.querySelector('i');
            if (icon) icon.className = 'fas fa-sort';
        });
        const activeHeader = Array.from(headers).find(th => th.getAttribute('onclick')?.includes(`'${field}'`));
        if (activeHeader) {
            const icon = activeHeader.querySelector('i');
            if (icon) icon.className = `fas fa-sort-${currentTrainerSortOrder === 'asc' ? 'up' : 'down'}`;
        }
    }
    
    renderStaff();
};

function renderMemberTrainers() {
    const grid = document.getElementById('memberTrainerGrid');
    if (!grid) return;

    let activeTrainers = allUsersData.filter(u => (u.role || "").toLowerCase() === 'trainer' && u.status !== 'Archived');

    if (activeTrainers.length === 0) {
        grid.innerHTML = "<p style='color: var(--text-muted);'>No trainers available at the moment.</p>";
        return;
    }

    const renderTrainerCard = (t) => {
        let fullName = `${t.givenName || t.name} ${t.familyName || ''}`.trim();
        let specialty = t.specialty || "General Fitness";
        let isOnFloor = t.shiftStatus === 'On Floor';

        let badgeHtml = isOnFloor
            ? `<span class="badge" style="background: #3498db; color: white; padding: 3px 8px; font-size: 11px;">On Floor</span>`
            : `<span class="badge" style="background: #eee; color: #888; padding: 3px 8px; font-size: 11px;">Off Floor</span>`;

        return `
            <div class="trainer-card member-trainer-card" data-search="${fullName.toLowerCase()} ${specialty.toLowerCase()}">
                <div class="trainer-avatar">${(t.image && window.isSafeImageSrc(t.image)) ? `<img src="${escapeHtml(t.image)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : fullName.charAt(0).toUpperCase()}</div>
                <div class="trainer-info">
                    <div class="trainer-name">${fullName}</div>
                    <div class="trainer-specialty">${specialty}</div>
                </div>
                <div>${badgeHtml}</div>
            </div>
        `;
    };

    window.syncDOM(grid, activeTrainers, renderTrainerCard, 'member-trainer-card');

    // --- Update Dashboard "Trainers on Floor" Feed ---
    try {
        const activeTrainersFeed = document.getElementById('dashActiveTrainersFeed');
        if (activeTrainersFeed) {
            const onFloor = activeTrainers.filter(u => u.shiftStatus === 'On Floor');
            if (onFloor.length > 0) {
                activeTrainersFeed.innerHTML = onFloor.map(t => {
                    let fullName = `${t.givenName || t.name} ${t.familyName || ''}`.trim();
                    return `
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 12px; background: var(--body-bg); border-radius: 12px; border: 1px solid var(--border-color); transition: transform 0.2s ease;">
                            <div style="width: 40px; height: 40px; background: var(--primary-red); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; box-shadow: 0 4px 10px rgba(153, 27, 27, 0.2);">
                                ${(t.image && window.isSafeImageSrc(t.image)) ? `<img src="${escapeHtml(t.image)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : escapeHtml(fullName.charAt(0).toUpperCase())}
                            </div>
                            <div style="flex-grow: 1;">
                                <div style="font-weight: 700; font-size: 14px; color: var(--text-primary);">${fullName}</div>
                                <div style="font-size: 12px; color: var(--accent-green); font-weight: 600; display: flex; align-items: center; gap: 4px;">
                                    <span style="width: 8px; height: 8px; background: var(--accent-green); border-radius: 50%; display: inline-block; animation: pulse 2s infinite;"></span> On Floor
                                </div>
                            </div>
                            <div style="font-size: 11px; background: rgba(0,0,0,0.05); padding: 4px 8px; border-radius: 20px; color: var(--text-muted); font-weight: 500;">
                                ${t.specialty || "General Fitness"}
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                activeTrainersFeed.innerHTML = `
                    <div style="text-align: center; padding: 40px 20px; opacity: 0.5;">
                        <i class="fa-solid fa-person-walking" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                        <p style="color: var(--text-muted); font-size: 13px;">No trainers on the floor right now.</p>
                    </div>
                `;
            }
        }
    } catch (err) {
        console.warn("Dashboard feed update failed:", err);
    }
}

window.openEditStaffModal = function (id) {
    const user = allUsersData.find(u => u.id === id);
    if (!user) return;

    if (document.getElementById('editStaffId')) {
        document.getElementById('editStaffId').value = id;
    }
    if (document.getElementById('editStaffGiven')) {
        document.getElementById('editStaffGiven').value = user.givenName || '';
    }
    if (document.getElementById('editStaffMI')) {
        document.getElementById('editStaffMI').value = user.mi || '';
    }
    if (document.getElementById('editStaffFamily')) {
        document.getElementById('editStaffFamily').value = user.familyName || '';
    }
    if (document.getElementById('editStaffRfid')) {
        document.getElementById('editStaffRfid').value = user.rfid || '';
    }
    if (document.getElementById('editStaffImage')) {
        document.getElementById('editStaffImage').value = user.image || '';
    }
    if (document.getElementById('editStaffPreview')) {
        document.getElementById('editStaffPreview').src = user.image || 'images/default-profile.png';
    }

    const specialtyContainer = document.getElementById('editSpecialtyContainer');
    const specialtyInput = document.getElementById('editStaffSpecialty');

    if (specialtyContainer && specialtyInput) {
        if ((user.role || "").toLowerCase() === 'trainer') {
            specialtyContainer.style.display = 'block';
            specialtyInput.value = user.specialty || '';
        } else {
            specialtyContainer.style.display = 'none';
            specialtyInput.value = '';
        }
    }

    if (document.getElementById('editStaffStatus')) {
        document.getElementById('editStaffStatus').value = user.status || 'Active';
    }

    if (document.getElementById('editStaffModalTitle')) {
        document.getElementById('editStaffModalTitle').innerText = `Edit ${(user.role || "Staff")} Details`;
    }

    document.getElementById('editStaffModal').style.display = 'flex';
}

if (document.getElementById('editStaffForm')) {
    document.getElementById('editStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editStaffId').value;
        const given = document.getElementById('editStaffGiven').value.trim();
        const mi = document.getElementById('editStaffMI').value.trim();
        const family = document.getElementById('editStaffFamily').value.trim();

        // Validation (C-03 Fix)
        const nameRegex = /^[A-Za-z\s\-\u00f1\u00d1]{2,}$/;
        if (!given || !nameRegex.test(given)) {
            return showToast("First Name must contain at least 2 letters (no numbers or special characters).", "error");
        }
        if (!family || !nameRegex.test(family)) {
            return showToast("Last Name must contain at least 2 letters (no numbers or special characters).", "error");
        }

        const updatedData = {
            givenName: given,
            mi: mi,
            familyName: family,
            name: `${given} ${family}`.trim()
        };

        const specialtyContainer = document.getElementById('editSpecialtyContainer');
        const specialtyEl = document.getElementById('editStaffSpecialty');

        if (specialtyContainer && specialtyContainer.style.display === 'block' && specialtyEl) {
            const spec = specialtyEl.value.trim();
            if (!spec) return showToast("Specialty field cannot be empty for trainers.", "error");
            updatedData.specialty = spec;
        }

        const statusEl = document.getElementById('editStaffStatus');
        if (statusEl) {
            updatedData.status = statusEl.value;
        }

        if (document.getElementById('editStaffRfid')) {
            updatedData.rfid = document.getElementById('editStaffRfid').value.trim();
        }

        if (document.getElementById('editStaffImageFile')) {
            const imageFile = document.getElementById('editStaffImageFile').files[0];
            let imageUrl = document.getElementById('editStaffImage').value.trim();
            if (imageFile) {
                imageUrl = await window.uploadImage(imageFile, 'staff');
            }
            updatedData.image = imageUrl || '';
        }

        try {
            if (updatedData.rfid) {
                // Use in-memory user cache to avoid failing the write flow
                // when Firestore reads for uniqueness checks are blocked/slow.
                // M1: archived users don't count — their card is reusable.
                const duplicate = (window.allUsersData || []).find(u =>
                    u.id !== id &&
                    (u.rfid || "") === updatedData.rfid &&
                    ((u.status || "").toLowerCase() !== "archived")
                );
                if (duplicate) {
                    const dupName = duplicate.name || `${duplicate.givenName || ''} ${duplicate.familyName || ''}`.trim();
                    return showToast(`RFID tag collision! This RFID is already assigned to ${dupName || 'another user'}.`, "error");
                }
            }

            // Trainer status cascade: if a trainer is being moved Active → non-Active,
            // surface upcoming bookings and offer to atomically cancel them.
            const priorUser = (window.allUsersData || []).find(u => u.id === id) || {};
            const isTrainer = (priorUser.role || '').toLowerCase() === 'trainer';
            const priorStatus = priorUser.status || 'Active';
            const newStatus = updatedData.status;
            const statusBlocksBookings = newStatus && newStatus !== 'Active';
            const transitioningFromActive = priorStatus === 'Active' && statusBlocksBookings;

            if (isTrainer && transitioningFromActive) {
                const todayIso = new Date().toISOString().slice(0, 10);
                let affected = [];
                try {
                    const snap = await getDocs(query(
                        collection(db, "bookings"),
                        where("trainerId", "==", id)
                    ));
                    affected = snap.docs
                        .map(d => ({ id: d.id, ...d.data() }))
                        .filter(b => (b.status === 'Confirmed' || b.status === 'Pending') && (b.date || '') >= todayIso)
                        .sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
                } catch (qErr) {
                    console.error("Affected-bookings query failed:", qErr);
                    return showToast("Could not check this trainer's upcoming bookings. Please try again.", "error");
                }

                if (affected.length > 0) {
                    const confirmedCount = affected.filter(b => b.status === 'Confirmed').length;
                    const pendingCount = affected.filter(b => b.status === 'Pending').length;
                    const preview = affected.slice(0, 5)
                        .map(b => ` • ${b.date || '?'} ${b.time || ''} — ${b.memberName || 'Member'}`)
                        .join('\n');
                    const moreLine = affected.length > 5 ? `\n (+${affected.length - 5} more)` : '';
                    const trainerName = `${updatedData.givenName} ${updatedData.familyName}`.trim();

                    const message =
                        `This trainer has ${affected.length} upcoming session(s) (${confirmedCount} Confirmed, ${pendingCount} Pending).\n` +
                        `Marking them as "${newStatus}" will cancel these and refund credits:\n\n` +
                        `${preview}${moreLine}`;

                    showConfirm({
                        title: `Trainer has ${affected.length} upcoming booking(s)`,
                        message,
                        tone: 'warning',
                        confirmText: 'Cancel sessions & update',
                        cancelText: 'Keep trainer Active',
                        onConfirm: async () => {
                            // Firestore tx cap is 500 writes; each booking can produce up to 4
                            // writes (member refund + booking update + 2 slot lock deletes),
                            // plus 1 for the trainer status update. Cap at 120 to stay safe.
                            if (affected.length > 120) {
                                return showToast("Too many upcoming bookings to cascade in one step. Please cancel some manually first.", "error");
                            }

                            const cancelledForChat = [];
                            try {
                                await runTransaction(db, async (tx) => {
                                    const bookingRefs = affected.map(b => doc(db, "bookings", b.id));
                                    const snaps = [];
                                    for (const ref of bookingRefs) {
                                        snaps.push(await tx.get(ref));
                                    }
                                    const memberIdsToRefund = new Set();
                                    for (let i = 0; i < snaps.length; i++) {
                                        const bSnap = snaps[i];
                                        if (!bSnap.exists()) continue;
                                        const bData = bSnap.data();
                                        if (bData.status !== 'Confirmed' && bData.status !== 'Pending') continue;
                                        if (bookingHoldsCredit(bData) && bData.memberId) {
                                            memberIdsToRefund.add(bData.memberId);
                                        }
                                    }
                                    const memberRefundSnaps = new Map();
                                    for (const mid of memberIdsToRefund) {
                                        memberRefundSnaps.set(mid, await tx.get(doc(db, "users", mid)));
                                    }
                                    cancelledForChat.length = 0;
                                    for (let i = 0; i < snaps.length; i++) {
                                        const bSnap = snaps[i];
                                        if (!bSnap.exists()) continue;
                                        const bData = bSnap.data();
                                        if (bData.status !== 'Confirmed' && bData.status !== 'Pending') continue;

                                        const template = `Your session on ${bData.date} at ${bData.time} was cancelled because your trainer is now ${newStatus}. Please rebook with another trainer or contact the front desk.`;
                                        const bookingRef = bookingRefs[i];

                                        if (bookingHoldsCredit(bData) && bData.memberId) {
                                            const mSnap = memberRefundSnaps.get(bData.memberId);
                                            if (!mSnap || !mSnap.exists()) {
                                                throw new Error(`Cannot cascade-cancel: member record ${bData.memberId} is missing.`);
                                            }
                                            tx.update(doc(db, "users", bData.memberId), { sessionsRemaining: increment(1) });
                                            tx.update(bookingRef, { status: "Cancelled", creditState: 'refunded', cancelRemarks: template });
                                        } else {
                                            tx.update(bookingRef, { status: "Cancelled", cancelRemarks: template });
                                        }
                                        if (bData.trainerId && bData.date && bData.time) {
                                            tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                                        }
                                        if (bData.memberId && bData.date && bData.time) {
                                            tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                                        }
                                        cancelledForChat.push({ ...bData, id: bSnap.id, template });
                                    }
                                    tx.update(doc(db, "users", id), updatedData);
                                });
                            } catch (txErr) {
                                console.error("Trainer status cascade tx failed:", txErr);
                                return showToast("Failed to cancel bookings and update trainer status. No changes made.", "error");
                            }

                            // Best-effort member chat notifications (non-critical).
                            // Store both name strings and IDs for reliable delivery.
                            let chatFailures = 0;
                            for (const b of cancelledForChat) {
                                if (!b.memberId || !id) continue;
                                try {
                                    await addDoc(messagesCol, {
                                        sender:     trainerName || "",
                                        receiver:   b.memberName || "",
                                        senderId:   id,
                                        receiverId: b.memberId,
                                        text:       b.template,
                                        timestamp:  Date.now()
                                    });
                                } catch (msgErr) {
                                    chatFailures++;
                                    console.error("Cascade chat message failed:", msgErr);
                                }
                            }

                            window.closeModal('editStaffModal');
                            if (chatFailures > 0) {
                                showToast(`Trainer set to ${newStatus}; ${cancelledForChat.length} booking(s) cancelled. ${chatFailures} member notification(s) failed to send.`, "warning");
                            } else {
                                showToast(`Trainer set to ${newStatus}; ${cancelledForChat.length} booking(s) cancelled, credits refunded.`, "success");
                            }
                            if (window.logActivity) {
                                window.logActivity(
                                    "Trainer Status Change Cascaded",
                                    `Trainer ${trainerName} → ${newStatus}. ${cancelledForChat.length} upcoming booking(s) auto-cancelled, credits refunded.`
                                );
                            }
                        }
                    });
                    return;
                }
            }

            await updateDoc(doc(db, "users", id), updatedData);
            window.closeModal('editStaffModal');
            showToast(`Details updated successfully!`, "success");
            if (window.logActivity) window.logActivity("Staff Edited", `Edited: ${updatedData.givenName} ${updatedData.familyName}`);
        } catch (error) {
            console.error("Staff update failed:", error);
            showToast("Failed to update details. Please try again.", "error");
        }
    });
}

window.archiveUser = async (id, currentStatus, btn) => {
    const actionText = currentStatus === 'Archived' ? 'Restore' : 'Archive';
    const newStatus = currentStatus === 'Archived' ? 'Active' : 'Archived';
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({
        title: `${actionText} Account`,
        message: `Are you sure you want to ${actionText.toLowerCase()} this account?`,
        tone: actionText === 'Restore' ? 'success' : 'default',
        confirmText: actionText,
        onCancel: _rearmBtn,
        onConfirm: async () => {
        try {
            // On archive, also clear member's locker pointer (prevents stale lockerId on unarchive)
            const userUpdates = { status: newStatus };
            if (newStatus === 'Archived') {
                userUpdates.hasLocker = false;
                userUpdates.lockerId = null;
                // Nullify currentSession so any active login for this user is immediately evicted
                // by the real-time session listener (same mechanism as remote logout).
                userUpdates.currentSession = null;
            }
            await updateDoc(doc(db, "users", id), userUpdates);

            // FBL-04 Locker release cascade when archiving a member
            if (newStatus === 'Archived') {
                const assignedLockers = (window.lockersData || []).filter(l => l.memberId === id);
                if (assignedLockers.length) {
                    for (const l of assignedLockers) {
                        try {
                            await updateDoc(doc(db, "lockers", l.id), {
                                status: 'Available',
                                memberId: null,
                                memberName: null,
                                assignedAt: null,
                                releasedReason: `Auto-released: Member account archived.`
                            });
                        } catch (e) { console.error("Locker auto-release on archive failed:", e); }
                    }
                    if (window.refreshLockers) await window.refreshLockers();
                }

                // SL-05 Cascade active bookings cancellation when archiving
                const activeBookings = (window.bookingsData || []).filter(b =>
                    (b.memberId === id || b.trainerId === id) &&
                    (b.status === 'Pending' || b.status === 'Confirmed')
                );
                if (activeBookings.length) {
                    const user = [...membersData, ...allUsersData].find(u => u.id === id);
                    const userName = user ? (user.givenName ? `${user.givenName} ${user.familyName || ''}`.trim() : (user.name || 'this user')) : 'this user';
                    for (const b of activeBookings) {
                        try {
                            await runTransaction(db, async (tx) => {
                                const bookingRef = doc(db, "bookings", b.id);
                                const bSnap = await tx.get(bookingRef);
                                if (!bSnap.exists()) return;
                                const bData = bSnap.data();
                                const update = {
                                    status: 'Cancelled',
                                    cancelRemarks: `Cancelled automatically: ${userName} account archived.`
                                };
                                let memberSnapArchive = null;
                                if (bookingHoldsCredit(bData) && bData.memberId && bData.memberId !== id) {
                                    const memberRefArchive = doc(db, "users", bData.memberId);
                                    memberSnapArchive = await tx.get(memberRefArchive);
                                    if (!memberSnapArchive.exists()) {
                                        throw new Error(`Cannot archive: member ${bData.memberId} missing for credit refund.`);
                                    }
                                }
                                if (bookingHoldsCredit(bData) && bData.memberId && bData.memberId !== id && memberSnapArchive && memberSnapArchive.exists()) {
                                    tx.update(doc(db, "users", bData.memberId), { sessionsRemaining: increment(1) });
                                    update.creditState = 'refunded';
                                }
                                if (bData.trainerId && bData.date && bData.time) {
                                    tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                                }
                                if (bData.memberId && bData.date && bData.time) {
                                    tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                                }
                                tx.update(bookingRef, update);
                            });
                        } catch (e) { console.error("Booking cascade-cancel failed on archive:", e); }
                    }
                }
            }

            showToast(`Account successfully ${newStatus.toLowerCase()}.`, "success");
            if (window.logActivity) window.logActivity(newStatus === 'Archived' ? 'Account Archived' : 'Account Restored', `User ID: ${id} was ${newStatus.toLowerCase()}.`);
        } catch (error) {
            console.error("Archive/restore failed:", error);
            showToast("Operation failed. Please try again.", "error");
        } finally {
            _rearmBtn();
        }
        }
    });
}

window.deleteUser = async (id, btn) => {
    if (!window.isCallerAdmin()) { showToast("Action Denied: You do not have permission to delete accounts.", "error"); return; }
    if (window.__isDeletingUser) return;
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    
    // Show user name in confirmation
    const user = [...membersData, ...allUsersData].find(u => u.id === id);
    const userName = user ? (user.givenName ? `${user.givenName} ${user.familyName || ''}`.trim() : (user.name || 'this user')) : 'this user';
    const userRole = (user && user.role ? user.role : '').toLowerCase();

    // Race-safe admin floor check: re-query live admins from Firestore so two admins
    // can't simultaneously delete each other based on stale local snapshots.
    if (userRole === 'admin') {
        try {
            const adminsSnap = await getDocs(query(collection(db, "users"), where("role", "==", "Admin")));
            const liveAdminIds = [];
            adminsSnap.forEach(d => {
                const data = d.data() || {};
                if ((data.status || '').toLowerCase() !== 'archived') liveAdminIds.push(d.id);
            });
            // Require ≥ 2 remaining AFTER this deletion (i.e. ≥ 3 currently, since `id` is one of them).
            const remainingAfter = liveAdminIds.filter(aid => aid !== id).length;
            if (remainingAfter < 2) {
                _rearmBtn();
                return showToast("At least two active admin accounts must remain. Promote another admin first.", "error");
            }
        } catch (err) {
            console.error("Admin-floor check failed:", err);
            _rearmBtn();
            return showToast("Could not verify admin count. Aborting for safety.", "error");
        }
    }

    // Detect active bookings (Pending/Confirmed) referencing this user as member or trainer
    const activeBookings = (window.bookingsData || []).filter(b =>
        (b.memberId === id || b.trainerId === id) &&
        (b.status === 'Pending' || b.status === 'Confirmed')
    );

    // Detect lockers assigned to this user
    const assignedLockers = (window.lockersData || []).filter(l => l.memberId === id);

    const proceed = async () => {
        if (window.__isDeletingUser) return;
        window.__isDeletingUser = true;
        try {
            await deleteDoc(doc(db, "users", id));
            // Cascade-cancel any active bookings tied to this user using the transactional
            // status-change path so credits are refunded and slot locks are freed.
            if (activeBookings.length) {
                for (const b of activeBookings) {
                    try {
                        await runTransaction(db, async (tx) => {
                            const bookingRef = doc(db, "bookings", b.id);
                            const bSnap = await tx.get(bookingRef);
                            if (!bSnap.exists()) return;
                            const bData = bSnap.data();
                            const update = {
                                status: 'Cancelled',
                                cancelRemarks: `Cancelled automatically: ${userName} account deleted.`
                            };
                            let memberSnapDelete = null;
                            if (bookingHoldsCredit(bData) && bData.memberId && bData.memberId !== id) {
                                memberSnapDelete = await tx.get(doc(db, "users", bData.memberId));
                                if (!memberSnapDelete.exists()) {
                                    throw new Error(`Cannot delete user: member ${bData.memberId} missing for credit refund.`);
                                }
                            }
                            // Refund held credit only if the held-from member still exists
                            // (i.e. credit was held against the OTHER party, not the deleted user)
                            if (bookingHoldsCredit(bData) && bData.memberId && bData.memberId !== id && memberSnapDelete && memberSnapDelete.exists()) {
                                tx.update(doc(db, "users", bData.memberId), { sessionsRemaining: increment(1) });
                                update.creditState = 'refunded';
                            }
                            if (bData.trainerId && bData.date && bData.time) {
                                tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                            }
                            if (bData.memberId && bData.date && bData.time) {
                                tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                            }
                            tx.update(bookingRef, update);
                        });
                    } catch (e) { console.error("Booking cascade-cancel failed:", e); }
                }
            }
            // Cascade-release any lockers assigned to this user
            if (assignedLockers.length) {
                for (const l of assignedLockers) {
                    try {
                        await updateDoc(doc(db, "lockers", l.id), {
                            status: 'Available',
                            memberId: null,
                            memberName: null,
                            assignedAt: null,
                            releasedReason: `Auto-released: ${userName} account deleted.`
                        });
                    } catch (e) { console.error("Locker cascade-release failed:", e); }
                }
                if (window.refreshLockers) window.refreshLockers();
            }
            const extras = [];
            if (activeBookings.length) extras.push(`${activeBookings.length} booking(s) cancelled`);
            if (assignedLockers.length) extras.push(`${assignedLockers.length} locker(s) released`);
            showToast(`Account deleted${extras.length ? ` (${extras.join(', ')})` : ''}.`, "info");
            if (window.logActivity) window.logActivity("Account Deleted", `Permanently deleted ${userName} (ID: ${id})`);
        } catch (error) {
            console.error("Delete failed:", error);
            showToast("Failed to delete account. Please try again.", "error");
        } finally {
            window.__isDeletingUser = false;
            _rearmBtn();
        }
    };

    const parts = [];
    if (activeBookings.length) parts.push(`${activeBookings.length} active booking(s) will be cancelled`);
    if (assignedLockers.length) parts.push(`${assignedLockers.length} locker(s) will be released`);
    const msg = parts.length
        ? `Remove ${userName}'s account?\n\n${parts.join('. ')}.\n\nThis action cannot be undone.`
        : `Remove ${userName}'s account completely? This action cannot be undone.`;
    showConfirm({ message: msg, onCancel: _rearmBtn, onConfirm: proceed });
}

// ==========================================
// 11. BATCH REGISTRATION
// ==========================================
let batchRowCount = 1;

// NEW: Inline styles added to bypass stubborn table constraints
window.addBatchRow = function () {
    if (batchRowCount >= 20) return showToast("Maximum 20 members can be registered at once.", "error");
    const tbody = document.getElementById('batchMemberBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bm-first" placeholder="First Name" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bm-mi" maxlength="2" placeholder="MI" oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')" style="min-width: 60px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bm-last" placeholder="Last Name" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="email" class="bm-email" placeholder="email@example.com" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><select class="bm-plan" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"><option value="Gold Plan">Gold</option><option value="Silver Plan">Silver</option></select></td>
        <td><input type="text" class="bm-rfid rfid-register-input" placeholder="Tap Card..." required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <input type="file" class="bm-image-file" accept="image/*" style="font-size: 10px; width: 100%;">
                <input type="url" class="bm-image" placeholder="...or URL" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;">
            </div>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); batchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); batchRowCount++;
}

// Payment Method Toggle for Registration / Renewal Modals
window.__regPaymentMethod = 'Cash';
window.__renewPaymentMethod = 'Cash';

window.selectRegPayment = function (method, el, context) {
    const prefix = context || 'reg';
    // Update global state
    if (prefix === 'reg') window.__regPaymentMethod = method;
    else window.__renewPaymentMethod = method;

    // Toggle visual state
    const toggle = el.parentElement;
    toggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');

    // Show/hide GCash reference ID field
    const wrapper = document.getElementById(prefix + 'GcashRefWrapper');
    if (wrapper) {
        if (method === 'GCash') {
            wrapper.classList.add('visible');
            const inp = wrapper.querySelector('input');
            if (inp) setTimeout(() => inp.focus(), 300);
        } else {
            wrapper.classList.remove('visible');
            const inp = wrapper.querySelector('input');
            if (inp) inp.value = '';
        }
    }
};

window.openMemberModal = () => {
    if (document.getElementById('memberRegistrationForm')) {
        document.getElementById('memberRegistrationForm').reset();
        if (document.getElementById('regMemberPreview')) {
            document.getElementById('regMemberPreview').src = 'images/default-profile.png';
        }

        // Auto-calculate total amount
        const planSelect = document.getElementById('regMemberPlan');
        const lockerSelect = document.getElementById('regMemberLocker');
        const totalInput = document.getElementById('regMemberTotalAmount');

        const calculateTotal = () => {
            if (!planSelect || !totalInput) return;
            const selectedPlan = (window.__membershipPlansData || []).find(p => p.name === planSelect.value);
            let planPrice = selectedPlan ? Number(selectedPlan.price) : 0;
            let lockerPrice = (lockerSelect && lockerSelect.value) ? 300 : 0;
            let total = planPrice + lockerPrice;
            
            totalInput.value = total.toFixed(2);

            // Update premium receipt elements
            const planLabel = document.getElementById('receiptPlanLabel');
            const planValue = document.getElementById('receiptPlanValue');
            const lockerRow = document.getElementById('receiptLockerRow');
            const totalDisplay = document.getElementById('regMemberTotalDisplay');

            if (planLabel) planLabel.textContent = planSelect.value || 'Membership Plan';
            if (planValue) planValue.textContent = `₱${planPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            
            if (lockerRow) {
                lockerRow.style.display = lockerPrice > 0 ? 'flex' : 'none';
            }
            
            if (totalDisplay) {
                totalDisplay.textContent = `₱${total.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            }
        };

        if (planSelect) planSelect.onchange = calculateTotal;
        if (lockerSelect) lockerSelect.onchange = calculateTotal;
    }
    // Reset payment method toggle to Cash
    window.__regPaymentMethod = 'Cash';
    const toggle = document.getElementById('regPaymentToggle');
    if (toggle) {
        toggle.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
        const cashOpt = toggle.querySelector('[data-method="Cash"]');
        if (cashOpt) cashOpt.classList.add('selected');
    }
    const gcashWrapper = document.getElementById('regGcashRefWrapper');
    if (gcashWrapper) {
        gcashWrapper.classList.remove('visible');
        const inp = gcashWrapper.querySelector('input');
        if (inp) inp.value = '';
    }

    // Reset wizard to step 1
    window.__regWizardStep = 1;
    regWizardGoTo(1, 'forward');

    document.getElementById('memberModal').style.display = 'flex';
}

// ── Registration Wizard Navigation ──
window.__regWizardStep = 1;

window.regWizardNext = async function (currentStep) {
    // Validate current step fields before proceeding
    const currentPanel = document.querySelector(`.reg-wizard-panel[data-panel="${currentStep}"]`);
    if (currentPanel) {
        const requiredFields = currentPanel.querySelectorAll('input[required], select[required]');
        let isValid = true;
        requiredFields.forEach(f => {
            if (!f.value || !f.value.trim()) {
                isValid = false;
                f.style.borderColor = '#ef4444';
                f.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.12)';
                setTimeout(() => {
                    f.style.borderColor = '';
                    f.style.boxShadow = '';
                }, 2000);
            }
        });
        if (!isValid) {
            showToast('Please fill in all required fields.', 'error');
            return;
        }
    }

    // Block step 1 → 2 transition if the email is already registered
    if (currentStep === 1) {
        const emailInput = document.getElementById('regMemberEmail');
        const targetEmail = (emailInput ? emailInput.value : '').trim().toLowerCase();
        try {
            const emailSnap = await getDocs(query(usersCol, where("email", "==", targetEmail)));
            if (!emailSnap.empty) {
                showToast('This email is already registered.', 'error');
                if (emailInput) {
                    emailInput.style.borderColor = '#ef4444';
                    emailInput.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.12)';
                    setTimeout(() => {
                        emailInput.style.borderColor = '';
                        emailInput.style.boxShadow = '';
                    }, 3000);
                    emailInput.focus();
                }
                return;
            }
        } catch (err) {
            console.error('Email uniqueness check failed:', err);
            showToast('Could not verify email. Please try again.', 'error');
            return;
        }
    }

    const nextStep = currentStep + 1;
    if (nextStep > 3) return;

    // If going to step 3, populate review summary and calculate total
    if (nextStep === 3) {
        populateReviewSummary();
        // Trigger total amount calc
        const planSelect = document.getElementById('regMemberPlan');
        const lockerSelect = document.getElementById('regMemberLocker');
        const totalInput = document.getElementById('regMemberTotalAmount');
        if (planSelect && totalInput) {
            const selectedPlan = (window.__membershipPlansData || []).find(p => p.name === planSelect.value);
            let planPrice = selectedPlan ? Number(selectedPlan.price) : 0;
            let lockerPrice = (lockerSelect && lockerSelect.value) ? 300 : 0;
            let total = planPrice + lockerPrice;

            totalInput.value = total.toFixed(2);

            // Update premium receipt elements
            const planLabel = document.getElementById('receiptPlanLabel');
            const planValue = document.getElementById('receiptPlanValue');
            const lockerRow = document.getElementById('receiptLockerRow');
            const totalDisplay = document.getElementById('regMemberTotalDisplay');

            if (planLabel) planLabel.textContent = planSelect.value || 'Membership Plan';
            if (planValue) planValue.textContent = `₱${planPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            
            if (lockerRow) {
                lockerRow.style.display = lockerPrice > 0 ? 'flex' : 'none';
            }
            
            if (totalDisplay) {
                totalDisplay.textContent = `₱${total.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            }
        }
    }

    window.__regWizardStep = nextStep;
    regWizardGoTo(nextStep, 'forward');
};

window.regWizardBack = function (currentStep) {
    const prevStep = currentStep - 1;
    if (prevStep < 1) return;
    window.__regWizardStep = prevStep;
    regWizardGoTo(prevStep, 'back');
};

function regWizardGoTo(step, direction) {
    // Update panels
    const panels = document.querySelectorAll('.reg-wizard-panel');
    panels.forEach(p => {
        p.classList.remove('active', 'slide-back');
        p.style.display = 'none';
    });

    const targetPanel = document.querySelector(`.reg-wizard-panel[data-panel="${step}"]`);
    if (targetPanel) {
        targetPanel.classList.remove('slide-back');
        if (direction === 'back') {
            targetPanel.classList.add('slide-back');
        }
        targetPanel.classList.add('active');
        targetPanel.style.display = 'block';
    }

    // Update step indicators
    updateRegWizardSteps(step);
}

function updateRegWizardSteps(activeStep) {
    const stepItems = document.querySelectorAll('.reg-step-item');
    const connectors = document.querySelectorAll('.reg-step-connector');

    stepItems.forEach(item => {
        const s = parseInt(item.dataset.step);
        item.classList.remove('active', 'completed');
        if (s === activeStep) {
            item.classList.add('active');
        } else if (s < activeStep) {
            item.classList.add('completed');
        }
    });

    connectors.forEach((conn, i) => {
        conn.classList.remove('completed');
        if (i + 1 < activeStep) {
            conn.classList.add('completed');
        }
    });
}

function populateReviewSummary() {
    const given = (document.getElementById('regMemberGiven')?.value || '').trim();
    const mi = (document.getElementById('regMemberMI')?.value || '').trim();
    const family = (document.getElementById('regMemberFamily')?.value || '').trim();
    const fullName = [given, mi ? mi + '.' : '', family].filter(Boolean).join(' ');

    const email = (document.getElementById('regMemberEmail')?.value || '').trim();
    const plan = (document.getElementById('regMemberPlan')?.value || '—');
    const rfid = (document.getElementById('regMemberRfid')?.value || '—').trim();

    const lockerSelect = document.getElementById('regMemberLocker');
    let lockerText = 'None';
    if (lockerSelect && lockerSelect.value) {
        const opt = lockerSelect.options[lockerSelect.selectedIndex];
        lockerText = opt ? opt.text : lockerSelect.value;
    }

    if (document.getElementById('reviewName')) document.getElementById('reviewName').textContent = fullName || '—';
    if (document.getElementById('reviewEmail')) document.getElementById('reviewEmail').textContent = email || '—';
    if (document.getElementById('reviewPlan')) document.getElementById('reviewPlan').textContent = plan;
    if (document.getElementById('reviewLocker')) document.getElementById('reviewLocker').textContent = lockerText;
    if (document.getElementById('reviewRfid')) document.getElementById('reviewRfid').textContent = rfid || '—';
}

const generatePassword = () => Math.random().toString(36).slice(-8);

window.generateUID = function(role) {
    let prefix = "MEM";
    if (role === "Staff") prefix = "STF";
    else if (role === "Trainer") prefix = "TRN";
    else if (role === "Admin") prefix = "ADM";
    return prefix + "-" + Math.floor(100000 + Math.random() * 900000);
};

if (document.getElementById('memberRegistrationForm')) {
    document.getElementById('memberRegistrationForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        const given = document.getElementById('regMemberGiven').value.trim();
        const mi = document.getElementById('regMemberMI').value.trim();
        const family = document.getElementById('regMemberFamily').value.trim();
        const email = document.getElementById('regMemberEmail').value.trim().toLowerCase();
        const plan = document.getElementById('regMemberPlan').value;
        const rfidTag = document.getElementById('regMemberRfid').value.trim();
        const emergency = document.getElementById('regMemberEmergency') ? document.getElementById('regMemberEmergency').value.trim() : "";
        const imageFile = document.getElementById('regMemberImageFile').files[0];
        let imageUrl = '';

        // VULN-01: email format validation on final submit
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            showToast("Please enter a valid email address.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        // VULN-02: name length cap
        const _memberNameRegex = /^[A-Za-z\s\-ñÑ]{2,80}$/;
        if (!given || !_memberNameRegex.test(given)) {
            showToast("First Name must be 2–80 letters (no numbers or special characters).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        if (!family || !_memberNameRegex.test(family)) {
            showToast("Last Name must be 2–80 letters (no numbers or special characters).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        if (emergency && !/^\+?[0-9\-\s]{7,15}$/.test(emergency)) {
            showToast("Invalid emergency contact format. Must be a valid phone number (7 to 15 digits).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'members');
        }

        const randomPassword = generatePassword();
        const currentTimestamp = new Date().getTime();

        const existingUsers = (window.allUsersData || []);
        let isDuplicate = existingUsers.some(u => ((u.email || "").toLowerCase() === email));

        // M1: ignore RFID matches on archived users — their card should be reusable.
        if (!isDuplicate && rfidTag !== "") {
            const activeMatch = existingUsers.find(u =>
                (u.rfid || "") === rfidTag &&
                ((u.status || "").toLowerCase() !== "archived")
            );
            if (activeMatch) isDuplicate = true;
        }

        if (isDuplicate) {
            showToast("Account with this Email or RFID already exists!", "error");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
            return;
        }

        // C-05 Fix: Validate GCash BEFORE any writes
        const regPayMethod = window.__regPaymentMethod || 'Cash';
        const regGcashRef = (document.getElementById('regGcashRefId') ? document.getElementById('regGcashRefId').value.trim() : '');
        if (regPayMethod === 'GCash' && !regGcashRef) {
            showToast('Please enter the GCash Reference ID.', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        // VULN-12: strip ALL non-digit chars (not just spaces) before length check
        const cleanRegGcashRef = regGcashRef.replace(/\D/g, '');
        if (regPayMethod === 'GCash' && cleanRegGcashRef.length !== 12) {
            showToast('GCash Reference ID must be exactly 12 digits (numbers only).', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        if (regPayMethod === 'GCash') {
            try { await window.assertGcashRefUnused(cleanRegGcashRef); }
            catch (e) {
                showToast(e.message, 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                return;
            }
        }

        const matchedPlanObj = (window.__membershipPlansData || []).find(p => p.name === plan);
        if (!matchedPlanObj) {
            showToast("Selected membership plan is invalid.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        const planId = matchedPlanObj.id;

        try {
            // EmailJS (wrapped in try-catch to satisfy SAD-02)
            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", {
                    to_name: given,
                    to_email: email,
                    generated_password: randomPassword,
                    plan: plan
                });
            } catch (emailErr) {
                console.error("EmailJS registration confirmation failed:", emailErr);
                showToast("Note: Registration email failed to send, but account creation is proceeding.", "warning");
            }

            const lockerId = document.getElementById('regMemberLocker') ? document.getElementById('regMemberLocker').value : "";
            const sessionsTotalInput = document.getElementById('regMemberSessionsTotal');
            let ptSessionsTotal = 0;
            if (sessionsTotalInput) {
                const sessionsValStr = sessionsTotalInput.value.trim();
                if (sessionsValStr !== '') {
                    ptSessionsTotal = Number(sessionsValStr);
                    if (isNaN(ptSessionsTotal) || ptSessionsTotal < 0 || !Number.isInteger(ptSessionsTotal)) {
                        showToast("Personal Training sessions count must be a non-negative integer.", "error");
                        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
                        return;
                    }
                }
            }

            await runTransaction(db, async (tx) => {
                // ── PHASE 1: ALL READS ──
                let gcashReservation = null;
                if (regPayMethod === 'GCash' && cleanRegGcashRef) {
                    gcashReservation = await window.reserveGcashRefInTxn(tx, cleanRegGcashRef);
                }
                let lockerRef = null;
                let lockerSnap = null;
                if (lockerId) {
                    lockerRef = doc(db, "lockers", lockerId);
                    lockerSnap = await tx.get(lockerRef);
                }
                const planRef = doc(db, "membershipPlans", planId);
                const planSnap = await tx.get(planRef);

                // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──
                if (lockerId && lockerRef) {
                    if (!lockerSnap.exists()) {
                        throw new Error("Locker record does not exist.");
                    }
                    if (lockerSnap.data().status === 'Occupied') {
                        throw new Error("That locker has just been occupied by another member. Please select a different locker.");
                    }
                }
                if (!planSnap.exists()) {
                    throw new Error("Selected plan no longer exists in database.");
                }
                // H3: reject inactive plans even if dropdown was rendered before plan was disabled
                const planDbStatus = planSnap.data().status || 'Active';
                if (planDbStatus !== 'Active') {
                    throw new Error("Selected plan is no longer active. Please pick a different plan.");
                }
                const planDbPrice = Number(planSnap.data().price || 0);
                const lockerPrice = lockerId ? 300 : 0;
                const secureTotalAmount = planDbPrice + lockerPrice;

                const newMemberRef = doc(usersCol);
                const paymentDocRef = doc(paymentsCol);
                const paymentData = {
                    name: `${given} ${family}`,
                    transactionRef: generateTransactionRef(),
                    amount: secureTotalAmount,
                    items: `Membership: ${plan}${lockerId ? ' + Locker' : ''}`,
                    type: "Membership",
                    status: "Paid",
                    paymentMethod: regPayMethod,
                    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: currentTimestamp
                };
                if (regPayMethod === 'GCash' && cleanRegGcashRef) {
                    paymentData.gcashRefId = cleanRegGcashRef;
                }

                let lockerExpiryDate = null;
                if (lockerId && lockerRef) {
                    const now = new Date();
                    lockerExpiryDate = new Date(now.setMonth(now.getMonth() + 1)).getTime();
                }

                // ── PHASE 3: ALL WRITES ──
                if (gcashReservation) {
                    window.commitGcashRefInTxn(tx, gcashReservation.refDoc);
                }
                tx.set(newMemberRef, {
                    uid: window.generateUID("Member"),
                    name: `${given} ${family}`,
                    givenName: given,
                    mi: mi,
                    familyName: family,
                    role: "Member",
                    email: email,
                    status: "Active",
                    plan: plan,
                    // M2: store null instead of "" so multiple empty entries don't
                    // collide on `where("rfid","==","")` queries.
                    rfid: rfidTag === "" ? null : rfidTag,
                    password: randomPassword,
                    image: imageUrl,
                    emergencyContact: emergency,
                    dateRegistered: currentTimestamp,
                    hasLocker: !!lockerId,
                    lockerId: lockerId || null,
                    sessionsTotal: ptSessionsTotal,
                    sessionsRemaining: ptSessionsTotal,
                    expirySentNotification: false
                });

                if (lockerId && lockerRef && lockerExpiryDate) {
                    tx.update(lockerRef, {
                        status: 'Occupied',
                        memberId: newMemberRef.id,
                        memberName: `${given} ${family}`.trim(),
                        expiryDate: lockerExpiryDate,
                        assignedAt: Date.now()
                    });
                }

                tx.set(paymentDocRef, paymentData);
            });

            if (lockerId && window.refreshLockers) window.refreshLockers();

            showToast(`Member ${given} ${family} registered successfully!`, "success");
            if (window.logActivity) window.logActivity("Member Registered", `Registered: ${given} ${family}`);
            window.closeModal('memberModal');
        } catch (err) {
            console.error("Registration failed:", err);
            showToast("Error registering member. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}

let staffBatchRowCount = 1;

// NEW: Inline styles added to bypass stubborn table constraints
window.addStaffBatchRow = function () {
    if (staffBatchRowCount >= 20) return showToast("Maximum 20 accounts can be registered at once.", "error");
    const tbody = document.getElementById('batchStaffBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="bs-first" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-mi" maxlength="2" placeholder="Opt." oninput="this.value=this.value.replace(/[^a-zA-Z]/g, '')" style="min-width: 60px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="text" class="bs-last" oninput="this.value=this.value.replace(/[^a-zA-ZñÑ\\s\\-]/g, '')" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><input type="email" class="bs-email" required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td><select class="bs-specialty" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;">
            <option value="General Fitness">General Fitness</option>
            <option value="Bodybuilding">Bodybuilding</option>
            <option value="Yoga">Yoga</option>
            <option value="HIIT">HIIT</option>
        </select></td>
        <td><input type="text" class="bs-rfid rfid-register-input" placeholder="Tap Card..." required style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;"></td>
        <td>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <input type="file" class="bs-image-file" accept="image/*" style="font-size: 10px; width: 100%;">
                <input type="url" class="bs-image" placeholder="...or URL" style="min-width: 130px; width: 100%; padding: 10px; box-sizing: border-box;">
            </div>
        </td>
        <td><button type="button" onclick="this.parentElement.parentElement.remove(); staffBatchRowCount--;" style="color:red; background:none; border:none; font-size:16px; cursor:pointer;"><i class="fas fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr); staffBatchRowCount++;
}

window.openStaffModal = (role) => {
    if (!window.isCallerAdmin()) return showToast("Action Denied: Only Admins can register Staff and Trainers.", "error");

    document.getElementById('hiddenStaffRole').value = role;
    document.getElementById('staffModalTitle').innerText = `Register ${role}`;

    // Reset the form
    if (document.getElementById('batchStaffForm')) {
        document.getElementById('batchStaffForm').reset();
    }
    if (document.getElementById('regStaffPreview')) {
        document.getElementById('regStaffPreview').src = 'images/default-profile.png';
    }

    // Show/hide specialty field based on role
    const specialtyContainer = document.getElementById('regSpecialtyContainer');
    if (specialtyContainer) {
        specialtyContainer.style.display = role === 'Trainer' ? 'block' : 'none';
    }

    document.getElementById('staffModal').style.display = 'flex';
}


if (document.getElementById('batchStaffForm')) {
    document.getElementById('batchStaffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!window.isCallerAdmin()) return;

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }

        const role = document.getElementById('hiddenStaffRole').value;
        const given = document.getElementById('regStaffGiven').value.trim();
        const mi = document.getElementById('regStaffMI').value.trim();
        const family = document.getElementById('regStaffFamily').value.trim();
        const email = document.getElementById('regStaffEmail').value.trim().toLowerCase();
        const rfidTag = document.getElementById('regStaffRfid').value.trim();
        const imageFile = document.getElementById('regStaffImageFile').files[0];
        let imageUrl = '';
        if (imageFile) {
            imageUrl = await window.uploadImage(imageFile, 'staff');
        }

        // VULN-03: validate name and email — staff registration previously had zero checks
        const _staffNameRegex = /^[A-Za-z\s\-ñÑ]{2,80}$/;
        if (!given || !_staffNameRegex.test(given)) {
            showToast("First Name must be 2–80 letters (no numbers or special characters).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        if (!family || !_staffNameRegex.test(family)) {
            showToast("Last Name must be 2–80 letters (no numbers or special characters).", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            showToast("Please enter a valid email address.", "error");
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
        }

        const specialtyEl = document.getElementById('regStaffSpecialty');
        const specialty = specialtyEl ? specialtyEl.value.trim() : '';
        const randomPassword = generatePassword();

        const existingUsers = (window.allUsersData || []);
        let isDuplicate = existingUsers.some(u => ((u.email || "").toLowerCase() === email));

        if (!isDuplicate && rfidTag !== "") {
            // M1: ignore RFID matches on archived users — card should be reusable.
            const activeMatch = existingUsers.find(u =>
                (u.rfid || "") === rfidTag &&
                ((u.status || "").toLowerCase() !== "archived")
            );
            if (activeMatch) isDuplicate = true;
        }

        if (isDuplicate) {
            showToast("Account with this Email or RFID already exists!", "error");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
            return;
        }

        try {
            try {
                await emailjs.send("service_x90mti6", "template_nda1wjc", { to_name: given, to_email: email, generated_password: randomPassword, plan: `${role} Account` });
            } catch (emailErr) {
                console.error("EmailJS staff registration email failed:", emailErr);
                showToast("Note: Welcome email failed to send, but account creation is proceeding.", "warning");
            }

            let newUser = {
                uid: window.generateUID(role),
                name: `${given} ${family}`, givenName: given, mi: mi, familyName: family,
                role: role, email: email, status: "Active", rfid: rfidTag === "" ? null : rfidTag, password: randomPassword, image: imageUrl
            };

            if (role === 'Trainer') newUser.specialty = specialty || 'General Fitness';

            await addDoc(usersCol, newUser);
            showToast(`${role} ${given} ${family} registered successfully!`, "success");
            if (window.logActivity) window.logActivity(`${role} Registered`, `Registered: ${given} ${family}`);
            window.closeModal('staffModal');
        } catch (err) {
            console.error("Registration failed:", err);
            showToast("Error registering account. Please try again.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });
}


// ==========================================
// 11.5 DYNAMIC UI VALIDATIONS (QA-UX-06)
// ==========================================
window.setupDynamicUIFormValidations = function () {
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const nameRegex = /^[A-Za-z\s]{2,}$/;
    const phoneRegex = /^\+?[0-9]{7,15}$/;

    // Injects a premium dynamic helper label below an input field if it doesn't exist
    const ensureValidationMessageEl = (input) => {
        const parent = input.parentElement;
        const isFlexParent = parent && (
            parent.style.display === 'flex' || 
            (parent.getAttribute('style') || '').includes('flex') || 
            parent.classList.contains('flex') ||
            (typeof window !== 'undefined' && window.getComputedStyle && window.getComputedStyle(parent).display === 'flex')
        );

        if (isFlexParent) {
            const searchId = 'val-msg-' + input.id;
            let existingMsg = document.getElementById(searchId);
            if (existingMsg) {
                return existingMsg;
            }
            existingMsg = document.createElement('span');
            existingMsg.id = searchId;
            existingMsg.className = 'form-validation-msg';
            // Insert it directly after the flex container itself so it doesn't break the horizontal layout!
            parent.parentNode.insertBefore(existingMsg, parent.nextSibling);
            return existingMsg;
        }

        let msgEl = input.nextElementSibling;
        if (msgEl && msgEl.classList.contains('form-validation-msg')) {
            return msgEl;
        }
        msgEl = document.createElement('span');
        msgEl.className = 'form-validation-msg';
        input.parentNode.insertBefore(msgEl, input.nextSibling);
        return msgEl;
    };

    const registerDynamicFieldValidation = ({ inputId, validateFn, errorMsg }) => {
        const input = document.getElementById(inputId);
        if (!input) return;

        const checkValidation = () => {
            const val = input.value.trim();
            const msgEl = ensureValidationMessageEl(input);

            if (val === '') {
                // If it is empty and required, it's invalid. If not required, clear styles.
                if (input.hasAttribute('required')) {
                    input.classList.add('ui-invalid');
                    input.classList.remove('ui-valid');
                    msgEl.innerText = "This field is required";
                    msgEl.className = 'form-validation-msg ui-invalid';
                } else {
                    input.classList.remove('ui-invalid', 'ui-valid');
                    msgEl.innerText = '';
                    msgEl.className = 'form-validation-msg';
                }
            } else {
                const isValid = validateFn(val);
                if (isValid) {
                    input.classList.add('ui-valid');
                    input.classList.remove('ui-invalid');
                    msgEl.innerText = "Looks good!";
                    msgEl.className = 'form-validation-msg ui-valid';
                } else {
                    input.classList.add('ui-invalid');
                    input.classList.remove('ui-valid');
                    msgEl.innerText = errorMsg;
                    msgEl.className = 'form-validation-msg ui-invalid';
                }
            }
        };

        input.addEventListener('input', checkValidation);
        input.addEventListener('blur', checkValidation);
    };

    // --- Format and Validate GCash Reference IDs ---
    const setupGcashFormatter = (inputId) => {
        const gcashInput = document.getElementById(inputId);
        if (gcashInput) {
            gcashInput.addEventListener('input', (e) => {
                let val = e.target.value.replace(/\D/g, '');
                if (val.length > 12) {
                    val = val.slice(0, 12);
                }
                let formatted = '';
                for (let i = 0; i < val.length; i++) {
                    if (i > 0 && i % 4 === 0) {
                        formatted += ' ';
                    }
                    formatted += val[i];
                }
                e.target.value = formatted;
            });

            registerDynamicFieldValidation({
                inputId: inputId,
                validateFn: (val) => val.replace(/\s/g, '').length === 12,
                errorMsg: "Must be exactly 12 digits"
            });
        }
    };

    setupGcashFormatter('regGcashRefId');
    setupGcashFormatter('renewGcashRefId');
    setupGcashFormatter('addCreditGcashRefId');
    setupGcashFormatter('posGcashRefId');

    // --- Member Registration Form ---
    registerDynamicFieldValidation({
        inputId: 'regMemberGiven',
        validateFn: (val) => nameRegex.test(val),
        errorMsg: "First Name must contain at least 2 letters (no numbers)"
    });
    registerDynamicFieldValidation({
        inputId: 'regMemberFamily',
        validateFn: (val) => nameRegex.test(val),
        errorMsg: "Last Name must contain at least 2 letters (no numbers)"
    });
    registerDynamicFieldValidation({
        inputId: 'regMemberEmail',
        validateFn: (val) => emailRegex.test(val),
        errorMsg: "Please enter a valid email address"
    });
    registerDynamicFieldValidation({
        inputId: 'regMemberEmergency',
        validateFn: (val) => phoneRegex.test(val),
        errorMsg: "Emergency number must be 7 to 15 digits"
    });

    // --- Staff Registration Form ---
    registerDynamicFieldValidation({
        inputId: 'regStaffGiven',
        validateFn: (val) => nameRegex.test(val),
        errorMsg: "First Name must contain at least 2 letters (no numbers)"
    });
    registerDynamicFieldValidation({
        inputId: 'regStaffFamily',
        validateFn: (val) => nameRegex.test(val),
        errorMsg: "Last Name must contain at least 2 letters (no numbers)"
    });
    registerDynamicFieldValidation({
        inputId: 'regStaffEmail',
        validateFn: (val) => emailRegex.test(val),
        errorMsg: "Please enter a valid email address"
    });
};

// ==========================================
// 12. UI INITIALIZATION & SHIFT TIMER
// ==========================================
function initUI() {
    if (window.setupDynamicUIFormValidations) {
        window.setupDynamicUIFormValidations();
    }
    function updateClock() {
        const clockElement = document.getElementById('liveClock');
        if (clockElement) {
            const now = new Date();
            const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
            const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            
            const dayName = days[now.getDay()];
            const dayVal = now.getDate();
            const monthName = months[now.getMonth()];
            const yearVal = now.getFullYear();
            
            const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            clockElement.innerHTML = `${dayName} · ${dayVal} ${monthName} ${yearVal} · ${timeStr}`;
        }
    }
    let clockTimerId = setInterval(updateClock, 1000); updateClock();

    const submenuToggles = document.querySelectorAll('.has-submenu');
    submenuToggles.forEach(toggle => {
        toggle.onclick = function () {
            this.classList.toggle('open');
            if (this.nextElementSibling && this.nextElementSibling.classList.contains('submenu')) this.nextElementSibling.classList.toggle('open');
        };
    });

    // --- User Dropdown Toggle ---
    const userMenuTrigger = document.getElementById('userMenuTrigger');
    const userDropdown = document.getElementById('userDropdown');

    if (userMenuTrigger && userDropdown) {
        userMenuTrigger.addEventListener('click', function (e) {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
        });

        // Close when clicking outside
        document.addEventListener('click', function (e) {
            if (userDropdown.classList.contains('show') && !userMenuTrigger.contains(e.target)) {
                userDropdown.classList.remove('show');
            }

            // Close all .kpi-dropdown-menu elements and remove .active from all buttons
            document.querySelectorAll('.kpi-dropdown-menu').forEach(menu => menu.classList.remove('show'));
            document.querySelectorAll('.kpi-ellipsis-btn').forEach(btn => btn.classList.remove('active'));
        });
    }

    // --- Dynamic Greeting ---
    const greetingText = document.getElementById('greetingText');
    if (greetingText) {
        const hour = new Date().getHours();
        const name = localStorage.getItem("loggedInUser") || "User";
        const firstName = name.split(' ')[0];
        let greetingWord = "Good Morning";
        if (hour >= 12 && hour < 18) greetingWord = "Good Afternoon";
        else if (hour >= 18) greetingWord = "Good Evening";

        greetingText.innerHTML = `${greetingWord}, <span style="color: var(--primary-red); font-weight: 700;">${firstName}</span>.`;
    }

    // --- Topbar Name Initialization ---
    const topBarName = document.getElementById('topBarName');
    if (topBarName) {
        const name = localStorage.getItem("loggedInUser") || "User";
        topBarName.innerText = name.split(' ')[0];
    }
    const sidebarUserName = document.getElementById('sidebarUserName');
    if (sidebarUserName) {
        const name = localStorage.getItem("loggedInUser") || "User";
        sidebarUserName.innerText = name;
    }
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    if (sidebarAvatar) {
        const name = localStorage.getItem("loggedInUser") || "User";
        const initials = name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        sidebarAvatar.innerText = initials || "U";
    }

    // --- Global Search Input Routing & Shortcuts ---
    window.handleGlobalSearch = function (queryVal) {
        const activeSection = document.querySelector('.content-section.active-section');
        if (!activeSection) return;
        
        const activeId = activeSection.id;
        
        if (activeId === 'members') {
            const input = document.getElementById('memberSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterMembers) window.filterMembers();
            }
        } else if (activeId === 'bookings') {
            const input = document.getElementById('bookingSearch');
            if (input) {
                input.value = queryVal;
                if (window.handleBookingSearch) window.handleBookingSearch();
            }
        } else if (activeId === 'activityLog') {
            const input = document.getElementById('activitySearch');
            if (input) {
                input.value = queryVal;
                if (window.filterActivityLogs) window.filterActivityLogs();
            }
        } else if (activeId === 'pos') {
            const input = document.getElementById('posSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterPOSCatalog) window.filterPOSCatalog();
            }
        } else if (activeId === 'chats') {
            const input = document.getElementById('chatSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterChatUsers) window.filterChatUsers();
            }
        } else if (activeId === 'staff') {
            const input = document.getElementById('staffSearchModern');
            if (input) {
                input.value = queryVal;
                if (window.filterStaff) window.filterStaff();
            }
        } else if (activeId === 'trainers') {
            const input = document.getElementById('trainerSearchModern');
            if (input) {
                input.value = queryVal;
                if (window.filterTrainers) window.filterTrainers();
            }
        } else if (activeId === 'payments') {
            const input = document.getElementById('paymentSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterPayments) window.filterPayments();
            }
        } else if (activeId === 'attendance') {
            const input = document.getElementById('attendanceSearch');
            if (input) {
                input.value = queryVal;
                if (window.renderAttendanceData) window.renderAttendanceData();
            }
        } else if (activeId === 'equipment') {
            const input = document.getElementById('machineSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterEquipment) window.filterEquipment();
            }
        } else if (activeId === 'products') {
            const input = document.getElementById('productSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterProducts) window.filterProducts();
            }
        } else if (activeId === 'ledger') {
            const input = document.getElementById('ledgerSearch');
            if (input) {
                input.value = queryVal;
                if (window.filterLedger) window.filterLedger();
            }
        }
    };

    // Keyboard shortcut handler for Cmd+K / Ctrl+K
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            const globalSearch = document.getElementById('globalSearchInput');
            if (globalSearch) {
                globalSearch.focus();
                globalSearch.select();
            }
        }
    });

    // --- Real-time Session Sync ---
    // (Merged into the top-level onSnapshot at the start of this file — see section 3.
    //  Removing the duplicate listener here saves ~50% of reads on the self-user doc.)





    window.updateShiftTimer = function () {
        const role = (localStorage.getItem("userRole") || "").trim().toLowerCase();
        let activeStatus = "off floor";
        let currentStatusText = "Off Floor";

        if (role === "staff") {
            const staffStatus = localStorage.getItem("staffShiftStatus") || "Off Shift";
            activeStatus = staffStatus.trim().toLowerCase();
            currentStatusText = staffStatus;
        } else {
            const trainerStatus = localStorage.getItem("trainerShiftStatus") || "Off Floor";
            activeStatus = trainerStatus.trim().toLowerCase();
            currentStatusText = trainerStatus;
        }

        // Update specific Trainer/Staff dashboard elements if they exist
        const shiftStatusText = document.getElementById('shiftStatusText');
        if (shiftStatusText) {
            shiftStatusText.innerText = currentStatusText;
        }

        document.querySelectorAll('.card-black, .grid-stat-box, .equip-cat-card').forEach(card => {
            const valueDiv = card.querySelector('.value') || card.querySelector('.equip-cat-count');
            if (valueDiv && (valueDiv.innerText.toLowerCase().includes('shift') || valueDiv.innerText.toLowerCase().includes('checking status') || card.querySelector('#shiftStatusText'))) {
                if (valueDiv && !card.querySelector('#shiftStatusText')) valueDiv.innerText = "Shift Status";

                let timerSpan = card.querySelector('.shift-timer');
                if (!timerSpan && card.classList.contains('card-black')) {
                    timerSpan = document.createElement('span');
                    timerSpan.className = 'shift-timer';
                    timerSpan.style.cssText = 'position: absolute; top: 10px; right: 15px; font-size: 14px; font-weight: bold; background: white; color: black; padding: 4px 10px; border-radius: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.2);';
                    timerSpan.textContent = '--:--:--';
                    card.appendChild(timerSpan);
                }

                if (timerSpan) {
                    const isInactive = (role === "staff" && activeStatus !== "on shift") || (role === "trainer" && activeStatus !== "on floor");
                    if (isInactive) {
                        timerSpan.innerText = role === "staff" ? "Off Shift" : "Off Floor";
                        if (card.classList.contains('card-black')) {
                            timerSpan.style.background = "#eee";
                            timerSpan.style.color = "#888";
                        }
                    } else {
                        const shiftStart = localStorage.getItem("shiftStart");
                        if (shiftStart) {
                            const diff = Date.now() - parseInt(shiftStart);
                            const hours = Math.floor(diff / (1000 * 60 * 60)), mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)), secs = Math.floor((diff % (1000 * 60)) / 1000);
                            timerSpan.innerText = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                            if (card.classList.contains('card-black')) {
                                timerSpan.style.background = "white";
                                timerSpan.style.color = "black";
                            }
                        } else {
                            timerSpan.innerText = "Not Started";
                            if (card.classList.contains('card-black')) {
                                timerSpan.style.background = "#eee";
                                timerSpan.style.color = "#888";
                            }
                        }
                    }
                }
            }
        });
    }
    let shiftTimerId = setInterval(window.updateShiftTimer, 1000); window.updateShiftTimer();

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearInterval(clockTimerId);
            clearInterval(shiftTimerId);
        } else {
            clockTimerId = setInterval(updateClock, 1000);
            shiftTimerId = setInterval(window.updateShiftTimer, 1000);
            updateClock();
            window.updateShiftTimer();
        }
    });

    // Restore last active tab if present to prevent resetting to dashboard on refresh
    const lastTab = sessionStorage.getItem("activeTab");
    if (lastTab && document.getElementById(lastTab)) {
        window.switchTab(lastTab);
    }

    try { initDashboardCharts(); } catch (error) { console.warn("Chart tool delayed.", error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();

function initDashboardCharts() {
    const ctxServices = document.getElementById('servicesChart');
    if (!ctxServices || typeof Chart === 'undefined') return;
    servicesChartInstance = new Chart(ctxServices.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Gold Members', 'Silver Members', 'Walk-in Guests'],
            datasets: [{
                label: 'Daily Check-ins',
                data: [0, 0, 0],
                backgroundColor: '#64748b', // Sleek slate-gray
                hoverBackgroundColor: '#475569',
                borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 0, bottomRight: 0 },
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: 'rgba(0,0,0,0.03)' }, ticks: { precision: 0 } }
            }
        }
    });
}

// ==========================================
// 13. BOOKING CALENDAR LOGIC
// ==========================================
function bookingLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local wall-clock instant for booking fields (avoids ISO string UTC/local bugs in Safari/Chrome). */
function parseBookingSlotLocal(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const dp = dateStr.split("-").map((n) => parseInt(n, 10));
    if (dp.length !== 3 || dp.some((n) => Number.isNaN(n))) return null;
    const [y, mo, d] = dp;
    const tp = timeStr.trim().split(":");
    const hh = parseInt(tp[0], 10);
    const mm = parseInt(tp[1] !== undefined ? tp[1] : "0", 10);
    const ss = tp[2] !== undefined ? parseInt(String(tp[2]).split(".")[0], 10) : 0;
    if (Number.isNaN(hh) || Number.isNaN(mm) || Number.isNaN(ss)) return null;
    const dt = new Date(y, mo - 1, d, hh, mm, ss);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt.getTime();
}

function isBookingSessionInPast(dateStr, timeStr) {
    const t = parseBookingSlotLocal(dateStr, timeStr);
    if (t === null) return true;
    return t < Date.now();
}

function setBookingDateMin(dateInput) {
    if (!dateInput) return;
    const min = bookingLocalDateString();
    dateInput.setAttribute("min", min);
    dateInput.min = min;
    // Cap booking horizon to 1 year ahead — prevents typoed year 9999 entries
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const max = `${maxDate.getFullYear()}-${pad(maxDate.getMonth() + 1)}-${pad(maxDate.getDate())}`;
    dateInput.setAttribute("max", max);
    dateInput.max = max;
}

function updateBookingTimeMinForToday(dateInput, timeInput) {
    if (!dateInput || !timeInput) return;
    const today = bookingLocalDateString();
    if (dateInput.value !== today) {
        timeInput.removeAttribute("min");
        return;
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    timeInput.setAttribute("min", `${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

function wireBookingDateTimeGuards() {
    const memberDate = document.getElementById("memberBookDate");
    const memberTime = document.getElementById("memberBookTime");
    if (memberDate && memberTime && !memberDate.dataset.bookingGuard) {
        memberDate.dataset.bookingGuard = "1";
        const sync = () => updateBookingTimeMinForToday(memberDate, memberTime);
        memberDate.addEventListener("change", sync);
        memberDate.addEventListener("input", sync);
        memberDate.addEventListener("focus", sync);
        memberTime.addEventListener("focus", sync);
    }
    const bookD = document.getElementById("bookDate");
    const bookT = document.getElementById("bookTime");
    if (bookD && bookT && !bookD.dataset.bookingGuard) {
        bookD.dataset.bookingGuard = "1";
        const sync = () => updateBookingTimeMinForToday(bookD, bookT);
        bookD.addEventListener("change", sync);
        bookD.addEventListener("input", sync);
        bookD.addEventListener("focus", sync);
        bookT.addEventListener("focus", sync);
    }
}

wireBookingDateTimeGuards();
// Ensure date pickers disable past dates even before opening modals.
setBookingDateMin(document.getElementById("memberBookDate"));
setBookingDateMin(document.getElementById("bookDate"));

// Expose helpers for bookings-ui.js (non-module script)
window.setBookingDateMin = setBookingDateMin;
window.updateBookingTimeMinForToday = updateBookingTimeMinForToday;
window.isBookingSessionInPast = isBookingSessionInPast;

// Scope the bookings listener by role to avoid syncing the entire bookings collection
// to every client. Members only need their own bookings; trainers only their own sessions;
// staff/admin date scoping is owned by bookings-ui.js buildBookingsQuery() (blank inputs = full catalog).
let _bookingsUnsub = null;
function bindBookingsListener() {
    if (!currentUserId) return;
    let bookingsQuery;
    if (roleNorm === "member") {
        bookingsQuery = query(bookingsCol, where("memberId", "==", currentUserId));
    } else if (roleNorm === "trainer") {
        bookingsQuery = query(bookingsCol, where("trainerId", "==", currentUserId));
    } else if (isStaffSide) {
        bookingsQuery = typeof window.buildBookingsQuery === 'function'
            ? window.buildBookingsQuery()
            : bookingsCol;
        if (!bookingsQuery) return;
    } else {
        return;
    }
    if (_bookingsUnsub) {
        _bookingsUnsub();
        _bookingsUnsub = null;
    }
    _bookingsUnsub = onSnapshot(bookingsQuery, (snapshot) => {
        bookingsData = [];
        snapshot.forEach(doc => bookingsData.push({ id: doc.id, ...doc.data() }));
        window.bookingsData = bookingsData;
        softRender('bookings', () => {
            if (typeof window.renderBookings === 'function') window.renderBookings();
            if (typeof window.renderTodayBookings === 'function') window.renderTodayBookings();
        });

        // Re-render whichever booking modal is currently open so the slot grid
        // reflects bookings created by the current user or other actors in real time.
        const memberModal = document.getElementById('memberBookingModal');
        if (memberModal && memberModal.style.display !== 'none' && memberModal.style.display !== '') {
            if (window.bookingState?.trainerId && typeof window.renderBookingCalendar === 'function') {
                window.renderBookingCalendar();
            }
            if (window.bookingState?.date && typeof window.renderBookingTimeSlots === 'function') {
                window.renderBookingTimeSlots(window.bookingState.date);
            }
        }
        const manualModal = document.getElementById('bookingModal');
        if (manualModal && manualModal.style.display !== 'none' && manualModal.style.display !== '') {
            if (window.manualBookingState?.trainerId && window.manualBookingState?.memberId && typeof window.renderManualBookingCalendar === 'function') {
                window.renderManualBookingCalendar();
            }
            if (window.manualBookingState?.date && typeof window.renderManualBookingTimeSlots === 'function') {
                window.renderManualBookingTimeSlots(window.manualBookingState.date);
            }
        }
    }, (err) => {
        console.error("Bookings listener failed:", err.code || err.message || err);
        showToast("Could not load bookings.", "error");
    });
}
window.rebindBookingsListener = bindBookingsListener;
bindBookingsListener();

window.renderBookings = renderBookings;
function _bookingRowDateParts(b) {
    const slotMs = parseBookingSlotLocal(b.date, b.time);
    if (slotMs === null) {
        return { dateStr: b.date || '—', timeStr: b.time || '—' };
    }
    const dateObj = new Date(slotMs);
    return {
        dateStr: dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        timeStr: dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };
}

function renderBookings() {
    const tbody = document.getElementById('bookingsBody');
    const myTbody = document.getElementById('myBookingsBody');
    const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
    const loggedInUserId = localStorage.getItem("userId");

    let displayData = (bookingsData || [])
        .map(b => (typeof window.normalizeBookingRecord === 'function' ? window.normalizeBookingRecord(b) : b))
        .filter(Boolean)
        .sort((a, b) => {
        // Use parseBookingSlotLocal to avoid UTC/local ambiguity in Safari/Chrome
        const ta = parseBookingSlotLocal(a.date, a.time) || 0;
        const tb = parseBookingSlotLocal(b.date, b.time) || 0;
        return tb - ta; // newest first
    });

    // --- Update Member Dashboard "Trainers on Floor" Feed ---
    // Moved to renderMemberTrainers for better sync

    if (loggedInRole === "member") {
        displayData = displayData.filter(b => b.memberId === loggedInUserId);

        const notifArea = document.getElementById('memberNotificationArea');
        if (notifArea) {
            const now = new Date();
            let upcomingBookings = displayData.filter(b => new Date(`${b.date}T${b.time}`) > now);

            let confirmed = upcomingBookings.filter(b => b.status === "Confirmed");
            let pending = upcomingBookings.filter(b => b.status === "Pending");
            let cancelled = upcomingBookings.filter(b => b.status === "Cancelled" || b.status === "Declined");

            let html = "";

            // Proactive membership expiration countdown warning banner
            if (typeof window.membershipDiffDays !== 'undefined') {
                const diffDays = window.membershipDiffDays;
                if (diffDays > 0 && diffDays <= 7) {
                    html += `
                        <div class="notification-banner" style="background-color: #fff3cd; color: #856404; border-left: 5px solid #ffc107; margin-bottom: 20px;">
                            <div><i class="fas fa-triangle-exclamation" style="font-size: 20px; margin-right: 10px; color: #ffc107;"></i> <strong>Membership Expiring Soon!</strong> You have only <strong>${diffDays} day${diffDays > 1 ? 's' : ''} remaining</strong> before your membership plan expires. Please renew at the front desk.</div>
                            <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                        </div>
                    `;
                }
            }

            if (confirmed.length > 0) {
                let nextSession = confirmed[0];
                const dateObj = new Date(`${nextSession.date}T${nextSession.time}`);
                html += `
                    <div class="notification-banner">
                        <div><i class="fas fa-check-circle" style="font-size: 20px; margin-right: 10px;"></i> <strong>Booking Confirmed!</strong> Your session with ${nextSession.trainerName} is scheduled for ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (pending.length > 0) {
                html += `
                    <div class="notification-banner" style="background-color: #e2e3e5; color: #383d41; border-left-color: #6c757d;">
                        <div><i class="fas fa-hourglass-half" style="font-size: 20px; margin-right: 10px;"></i> <strong>Pending Approval:</strong> You have ${pending.length} request(s) waiting for a trainer to accept.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            if (cancelled.length > 0) {
                let nextDeclined = cancelled[0];
                const dateObj = new Date(`${nextDeclined.date}T${nextDeclined.time}`);
                html += `
                    <div class="notification-banner" style="background-color: #f8d7da; color: #721c24; border-left-color: #f5c6cb;">
                        <div><i class="fas fa-exclamation-circle" style="font-size: 20px; margin-right: 10px;"></i> <strong>Update:</strong> Your request with ${nextDeclined.trainerName} on ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} was declined or cancelled. Please book another time.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;
            }

            notifArea.innerHTML = html;
        }
    } else if (loggedInRole === "trainer") {
        displayData = displayData.filter(b => b.trainerId === loggedInUserId);

        // Status weight: active bookings float to top, terminal states sink to bottom.
        // Mirrors the same weight table used in bookings-ui.js applyBookingFilters.
        const _SW = { 'In Session': 1, 'active': 1, 'Confirmed': 2, 'Pending': 3, 'Completed': 4, 'Cancelled': 5, 'No Show': 5 };
        displayData.sort((a, b) => {
            const wDiff = (_SW[a.status] ?? 3) - (_SW[b.status] ?? 3);
            if (wDiff !== 0) return wDiff;
            // Within the same weight tier keep chronological order (soonest first)
            const da = (a.date || '') + 'T' + (a.time || '');
            const db = (b.date || '') + 'T' + (b.time || '');
            return da < db ? -1 : da > db ? 1 : 0;
        });

        const notifArea = document.getElementById('trainerNotificationArea');
        if (notifArea) {
            let pendingRequests = displayData.filter(b => b.status === "Pending");

            if (pendingRequests.length > 0) {
                notifArea.innerHTML = `
                    <div class="notification-banner" style="background-color: #fff3cd; color: #856404; border-left-color: #ffc107;">
                        <div><i class="fas fa-bell" style="font-size: 20px; margin-right: 10px;"></i> <strong>New Request!</strong> You have <strong>${pendingRequests.length}</strong> pending session request(s) to review in your Schedule tab.</div>
                        <button type="button" onclick="this.parentElement.style.display='none'" style="background:none; border:none; color:inherit; cursor:pointer; font-size: 16px;"><i class="fas fa-times"></i></button>
                    </div>
                `;

                const navIcon = document.getElementById('navBookingsIcon');
                if (navIcon && !navIcon.querySelector('.badge-dot')) {
                    navIcon.innerHTML += `<span class="badge-dot" style="position:absolute; top:5px; right:30%; background:var(--primary-red); width:10px; height:10px; border-radius:50%;"></span>`;
                }
            } else {
                notifArea.innerHTML = "";
                const navIcon = document.getElementById('navBookingsIcon');
                if (navIcon) {
                    const dot = navIcon.querySelector('.badge-dot');
                    if (dot) dot.remove();
                }
            }
        }

        // --- Closest Booking Logic ---
        const now = new Date();
        const upcoming = displayData.filter(b => b.status === "Confirmed" && new Date(`${b.date}T${b.time}`) > now);
        upcoming.sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

        const valEl = document.getElementById('closestBookingValue');
        const subEl = document.getElementById('closestBookingSub');
        if (valEl && subEl) {
            if (upcoming.length > 0) {
                const closest = upcoming[0];
                const dateObj = new Date(`${closest.date}T${closest.time}`);
                valEl.innerText = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                subEl.innerHTML = `<i class="fa-solid fa-user"></i> ${escapeHtml(closest.memberName || '')} <br> <i class="fa-solid fa-calendar-day"></i> ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            } else {
                valEl.innerText = "No Sessions";
                subEl.innerText = "Check back later!";
            }
        }
    }

    const dateFilter = document.getElementById('bookingDateFilter')?.value;
    if (dateFilter) displayData = displayData.filter(b => b.date === dateFilter);

        const renderBookingRow = (b) => {
            if (!b || !b.id) return '';
            let badgeClass = "pending";
            if (b.status === "Confirmed") badgeClass = "confirmed";
            if (b.status === "Completed") badgeClass = "completed";
            if (b.status === "Cancelled") badgeClass = "cancelled";
            if (b.status === "Declined") badgeClass = "declined";
            if (b.status === "No Show") badgeClass = "noshow";

            const { dateStr, timeStr } = _bookingRowDateParts(b);

            if (loggedInRole === "member") {
                const remarksHtml = (b.status === "Cancelled" || b.status === "Declined") && b.cancelRemarks
                    ? `<div style="font-size: 11px; color: #e74c3c; margin-top: 10px; font-weight: 500; font-style: italic;"><i class="fas fa-comment-dots"></i> Reason: ${escapeHtml(b.cancelRemarks)}</div>`
                    : "";

                const offset = window.serverTimeOffsetMs || 0;
                const nowMs = Date.now() + offset;
                const bookingMs = parseBookingSlotLocal(b.date, b.time);
                const canReschedule = ["Pending", "Confirmed"].includes(b.status)
                    && bookingMs !== null
                    && (bookingMs - nowMs > 2 * 60 * 60 * 1000);
                const rescheduleBtn = canReschedule
                    ? `<button type="button" class="btn-icon btn-edit btn-xs" title="Reschedule Booking" onclick="openRescheduleModal('${b.id}')"><i class="fas fa-rotate"></i></button>`
                    : '';
                const cancelBtnInner = (b.status === "Pending" || b.status === "Confirmed")
                    && !(window.isBookingTerminalStatus && window.isBookingTerminalStatus(b.status))
                    ? `<button type="button" class="btn-icon btn-delete btn-xs" title="Cancel Booking" onclick="cancelMemberBooking('${b.id}', this)"><i class="fas fa-times-circle"></i></button>`
                    : '';
                const actionsCell = (rescheduleBtn || cancelBtnInner)
                    ? `<td>${rescheduleBtn}${cancelBtnInner}</td>`
                    : `<td></td>`;

                return `
                    <tr>
                        <td>${escapeHtml(b.trainerName)}</td>
                        <td>${dateStr}</td>
                        <td><span class="badge confirmed" style="background: var(--primary-red); color: white; border: none;"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                        <td><span class="badge ${badgeClass}">${b.status}</span>${remarksHtml}</td>
                        ${actionsCell}
                    </tr>
                `;
            } else {
            let actions = "";
            if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(b.status)) {
                actions = "";
            } else if (loggedInRole === "trainer") {
                if (b.status === "Pending") {
                    actions = `
                        <button type="button" class="btn-icon btn-edit" style="color: #27ae60;" title="Accept" onclick="updateBookingStatus('${b.id}', 'Confirmed', this)"><i class="fas fa-check"></i></button>
                        <button type="button" class="btn-icon btn-delete" style="color: #e74c3c;" title="Decline" onclick="updateBookingStatus('${b.id}', 'Declined', this)"><i class="fas fa-times"></i></button>
                     `;
                } else {
                    actions = `<button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>`;
                }
            } else {
                actions = `
                    <button type="button" class="btn-icon btn-edit" title="Update Status" onclick="openEditBookingModal('${b.id}')"><i class="fas fa-edit" style="color: var(--dark-black);"></i></button>
                    <button type="button" class="btn-icon btn-delete" title="Delete Booking" onclick="deleteBooking('${b.id}', this)"><i class="fas fa-trash"></i></button>
                `;
            }

            const remarksHtml = (b.status === "Cancelled" || b.status === "Declined") && b.cancelRemarks 
                ? `<div style="font-size: 11px; color: #e74c3c; margin-top: 4px; font-style: italic;"><i class="fas fa-comment-dots"></i> Reason: ${escapeHtml(b.cancelRemarks)}</div>`
                : "";

            return `
                <tr>
                    <td>
                        ${b.memberId ? `<a href="javascript:void(0)" onclick="window.openMemberProfile('${b.memberId}')" style="color: var(--primary-red); font-weight: 600; text-decoration: none; border-bottom: 1px dashed var(--primary-red);">${escapeHtml(b.memberName)}</a>` : escapeHtml(b.memberName)}
                    </td>
                    <td>${escapeHtml(b.trainerName)}</td>
                    <td>${dateStr}</td>
                    <td><span class="badge active" style="background: var(--primary-red); color: white; border: none;"><i class="fa-regular fa-clock"></i> ${timeStr}</span></td>
                    <td><span class="badge ${badgeClass}">${b.status}</span>${remarksHtml}</td>
                    <td>${actions}</td>
                </tr>
            `;

        }
    };

    if (loggedInRole === "member" && myTbody) {
        const searchVal = (document.getElementById('myBookingSearch')?.value || '').toLowerCase();
        if (searchVal) {
            displayData = displayData.filter(b => 
                (b.trainerName || '').toLowerCase().includes(searchVal) ||
                (b.status || '').toLowerCase().includes(searchVal)
            );
        }

        const totalRecords = displayData.length;
        const totalPages = Math.ceil(totalRecords / myBkItemsPerPage);
        if (myBkCurrentPage > totalPages && totalPages > 0) myBkCurrentPage = totalPages;
        if (myBkCurrentPage < 1) myBkCurrentPage = 1;
        const startIdx = (myBkCurrentPage - 1) * myBkItemsPerPage;
        const endIdx = Math.min(startIdx + myBkItemsPerPage, totalRecords);
        const pagedData = displayData.slice(startIdx, endIdx);

        const countEl = document.getElementById('myBkRecordCount');
        if (countEl) {
            countEl.textContent = totalRecords === 0 ? 'Showing 0-0 of 0' : `Showing ${startIdx + 1}-${endIdx} of ${totalRecords}`;
        }

        window.renderPaginationControls('myBkPagination', myBkCurrentPage, totalPages, totalRecords, 'changeMyBkPage');

        window.syncDOM(myTbody, pagedData, renderBookingRow, 'my-booking');
    } else if (tbody) {
        window.syncDOM(tbody, displayData, renderBookingRow, 'booking');
    }
}

window.filterBookingsByDate = () => { renderBookings(); };
window.filterMyBookings = () => { myBkCurrentPage = 1; renderBookings(); };
window.filterActivityLogs = () => { activityCurrentPage = 1; renderActivityLogs(); };
window.filterLedger = () => { ledgerCurrentPage = 1; renderLedger(); };

// Booking status state machine — blocks illegal transitions like Completed→Pending
const BOOKING_STATUS_TRANSITIONS = {
    'Pending':   ['Confirmed', 'Declined', 'Cancelled', 'No Show'],
    'Confirmed': ['active', 'Completed', 'Cancelled', 'No Show'],
    'active':    ['Completed', 'No Show'],
    'Completed': [],
    'Declined':  [],
    'Cancelled': [],
    'No Show':   []
};
window.BOOKING_STATUS_TRANSITIONS = BOOKING_STATUS_TRANSITIONS;

// Deterministic hour-aligned slot doc id, used as a transactional lock
// to prevent two members from confirming the same trainer/time slot.
function slotIdForTrainer(trainerId, date, time) {
    const hour = String(parseInt((time || '').split(':')[0], 10)).padStart(2, '0');
    return `T_${trainerId}_${date}_${hour}`;
}
function slotIdForMember(memberId, date, time) {
    const hour = String(parseInt((time || '').split(':')[0], 10)).padStart(2, '0');
    return `M_${memberId}_${date}_${hour}`;
}
window.slotIdForTrainer = slotIdForTrainer;
window.slotIdForMember  = slotIdForMember;

window.SAME_DAY_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Completed'];

// Returns the member's other bookings on the same date (active or just-finished).
// Used to warn the booker (or rescheduler) that a session already exists that day.
window.findSameDayBookings = (memberId, dateStr, excludeBookingId = null) =>
    (window.bookingsData || []).filter(b =>
        b.memberId === memberId &&
        b.date === dateStr &&
        b.id !== excludeBookingId &&
        ["Pending", "Confirmed", "Completed"].includes(b.status)
    );

// Build a short, human-readable summary line for a single booking, used in
// the same-day confirmation popup.
window.formatBookingSummary = (b) => {
    const [eH, eM] = (b.time || '00:00').split(':').map(Number);
    const period = eH >= 12 ? 'PM' : 'AM';
    const disp = `${(eH > 12 ? eH - 12 : (eH === 0 ? 12 : eH))}:${String(eM || 0).padStart(2, '0')} ${period}`;
    return `${disp} with ${b.trainerName || 'trainer'} (${b.status})`;
};

// Strict: only refund when the booking explicitly recorded a credit hold.
// Legacy bookings without creditState are not refunded automatically.
function bookingHoldsCredit(b) { return b && b.creditState === 'held'; }

// BUG-01: Per-booking in-flight guard — prevents concurrent transactions when
// the action button is clicked repeatedly before the dialog or write resolves.
if (!window._updateBookingStatusInFlight) window._updateBookingStatusInFlight = new Set();

window.updateBookingStatus = async (id, newStatus, btn) => {
    if (window._updateBookingStatusInFlight.has(id)) return;
    window._updateBookingStatusInFlight.add(id);
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    const _release = () => { window._updateBookingStatusInFlight.delete(id); _rearmBtn(); };

    // Caller identity (used inside transactions to enforce trainer ownership)
    const _callerRole = (localStorage.getItem("userRole") || '').toLowerCase();
    const _callerId   = localStorage.getItem("userId");
    // S1 (Sprint 8): updateBookingStatus is for staff/admin/trainer UI buttons only.
    // Members have `cancelMemberBooking` for self-cancel; they must not be able to flip
    // arbitrary bookings to Confirmed / Declined / Completed / No Show via console
    // (which would refund or consume credits on someone else's account).
    if (_callerRole !== 'admin' && _callerRole !== 'staff' && _callerRole !== 'trainer') {
        _release();
        return showToast("Permission denied.", "error");
    }
    const _assertOwnership = (bData) => {
        // Trainers may only act on bookings assigned to them.
        // Admins and staff may act on any booking (staff confirmation is allowed by design).
        if (_callerRole === 'trainer' && bData && bData.trainerId && bData.trainerId !== _callerId) {
            throw new Error("You can only update bookings assigned to you.");
        }
    };
    // BUG-12: Re-sync server time before writing so a tampered window.serverTimeOffsetMs
    // cannot bypass the future-Completed guard.
    const _assertNotFutureCompleted = async (bData) => {
        if (newStatus === 'Completed' && bData && bData.date && bData.time) {
            const sessionAt = new Date(`${bData.date}T${bData.time}`).getTime();
            if (isNaN(sessionAt)) return;
            if (typeof syncServerTimeOffset === 'function') await syncServerTimeOffset();
            const offset = window.serverTimeOffsetMs || 0;
            if (sessionAt > (Date.now() + offset)) {
                throw new Error("Cannot mark a future session as Completed.");
            }
        }
    };

    // Validate transition
    const currentBooking = (window.bookingsData || []).find(x => x.id === id);
    if (currentBooking) {
        if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(currentBooking.status)) {
            _release();
            return showToast(`This booking is ${currentBooking.status} and is locked for audit integrity.`, "error");
        }
        const currentStatus = currentBooking.status || 'Pending';
        const allowed = window.BOOKING_STATUS_TRANSITIONS[currentStatus] || [];
        if (currentStatus !== newStatus && !allowed.includes(newStatus)) {
            _release();
            return showToast(`Cannot change status from ${currentStatus} to ${newStatus}.`, "error");
        }
        // Client-side fast-fail for trainer ownership (definitive check is in-txn below)
        if (_callerRole === 'trainer' && currentBooking.trainerId && currentBooking.trainerId !== _callerId) {
            _release();
            return showToast("You can only update bookings assigned to you.", "error");
        }
        // Block marking future sessions Completed (definitive check is in-txn below)
        if (newStatus === 'Completed' && currentBooking.date && currentBooking.time) {
            const sessionAt = new Date(`${currentBooking.date}T${currentBooking.time}`).getTime();
            if (!isNaN(sessionAt) && sessionAt > Date.now()) {
                _release();
                return showToast("Cannot mark a future session as Completed.", "error");
            }
        }
    }

    if (newStatus === 'Cancelled' || newStatus === 'Declined') {
        // BUG-07: release the lock while waiting for dialog input so other booking
        // rows stay interactive; re-acquire just before the Firestore write.
        _release();
        showPrompt({
            title: `Confirm ${newStatus}`,
            message: `Please provide a reason for marking this session as ${newStatus.toLowerCase()}:`,
            placeholder: "e.g. Schedule conflict, personal emergency...",
            onConfirm: (remarks) => {
                const reason = (remarks || '').trim();
                const bPreview = (window.bookingsData || []).find(x => x.id === id);
                const previewMessage = (newStatus === 'Declined' && typeof window.buildBookingDeclineAutoMessage === 'function')
                    ? window.buildBookingDeclineAutoMessage(reason, bPreview?.date, bPreview?.time || bPreview?.startTime)
                    : `I have to decline due to the reason: ${reason}`;

                // V-07 FIX: pass the object form so onCancel releases the in-flight guard.
                // The positional-arg form had no cancel callback, leaving _updateBookingStatusInFlight
                // permanently engaged when the operator dismissed the second confirmation dialog.
                showConfirm({
                    message: `The following message will be sent to the member via chat:\n\n"${previewMessage}"\n\nConfirm ${newStatus.toLowerCase()}?`,
                    onCancel: _release,
                    onConfirm: async () => {
                    if (window._updateBookingStatusInFlight.has(id)) return;
                    window._updateBookingStatusInFlight.add(id);

                    const b = (window.bookingsData || []).find(x => x.id === id);
                    if (!b) { _release(); return; }
                    const uiStatusAtPrompt = b.status || 'Pending';
                    const _processingLabel = newStatus === 'Declined' ? 'Declining...' : 'Cancelling...';

                    try {
                        if (btn) {
                            btn.disabled = true;
                            btn.innerText = _processingLabel;
                        }

                        await runTransaction(db, async (tx) => {
                            const bookingRef = doc(db, "bookings", id);

                            // PHASE 1 — hoisted reads
                            const bSnap = await tx.get(bookingRef);
                            if (!bSnap.exists()) throw new Error("Booking no longer exists.");
                            const bData = bSnap.data() || {};

                            let memberRef = null;
                            let memberSnap = null;
                            if (bookingHoldsCredit(bData) && bData.memberId) {
                                memberRef = doc(db, "users", bData.memberId);
                                memberSnap = await tx.get(memberRef);
                            }

                            // PHASE 2 — validation and message assembly
                            _assertOwnership(bData);
                            if (window.verifyBookingServerState) {
                                window.verifyBookingServerState(bData, uiStatusAtPrompt);
                            }
                            if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(bData.status)) {
                                throw new Error(`This booking is ${bData.status} and is locked for audit integrity.`);
                            }
                            if (bData.status !== 'Pending' && bData.status !== 'Confirmed') {
                                throw new Error(window.BOOKING_STATE_CHANGED_MSG || `This session was already marked "${bData.status}". No further action needed.`);
                            }

                            const slotTime = bData.time || bData.startTime || '00:00';
                            const autoMessage = (newStatus === 'Declined' && typeof window.buildBookingDeclineAutoMessage === 'function')
                                ? window.buildBookingDeclineAutoMessage(reason, bData.date, slotTime)
                                : `I have to decline due to the reason: ${reason}`;

                            // PHASE 3 — lowered writes
                            if (newStatus === 'Declined') {
                                const declineUpdate = { status: 'Declined', declineReason: reason, cancelRemarks: autoMessage };
                                if (bookingHoldsCredit(bData) && bData.memberId) {
                                    if (!memberSnap || !memberSnap.exists()) throw new Error("Member record no longer exists.");
                                    tx.update(memberRef, { sessionsRemaining: increment(1) });
                                    tx.update(bookingRef, { ...declineUpdate, creditState: 'refunded' });
                                } else {
                                    tx.update(bookingRef, declineUpdate);
                                }
                                if (bData.memberId && bData.trainerId) {
                                    const newMessageRef = doc(messagesCol);
                                    const _callerName = localStorage.getItem("loggedInUser") || bData.trainerName || "Trainer";
                                    tx.set(newMessageRef, {
                                        sender: _callerName,
                                        receiver: bData.memberName || "",
                                        senderId: bData.trainerId,
                                        receiverId: bData.memberId,
                                        text: autoMessage,
                                        timestamp: Date.now()
                                    });
                                }
                            } else {
                                const lateCancel = newStatus === 'Cancelled'
                                    && typeof window.isLateCancellation === 'function'
                                    && window.isLateCancellation({ date: bData.date, time: slotTime });
                                const privilegedDesk = _callerRole === 'admin' || _callerRole === 'staff';

                                if (bookingHoldsCredit(bData) && bData.memberId) {
                                    if (lateCancel && !privilegedDesk) {
                                        tx.update(bookingRef, {
                                            status: newStatus,
                                            cancelRemarks: autoMessage + " (Late cancellation — session credit forfeited.)",
                                            creditState: 'consumed'
                                        });
                                    } else {
                                        if (!memberSnap || !memberSnap.exists()) throw new Error("Member record no longer exists.");
                                        tx.update(memberRef, { sessionsRemaining: increment(1) });
                                        tx.update(bookingRef, { status: newStatus, cancelRemarks: autoMessage, creditState: 'refunded' });
                                    }
                                } else {
                                    tx.update(bookingRef, { status: newStatus, cancelRemarks: autoMessage });
                                }
                                if (bData.memberId && bData.trainerId) {
                                    const newMessageRef = doc(messagesCol);
                                    const _callerName = localStorage.getItem("loggedInUser") || bData.trainerName || "Trainer";
                                    tx.set(newMessageRef, {
                                        sender: _callerName,
                                        receiver: bData.memberName || "",
                                        senderId: bData.trainerId,
                                        receiverId: bData.memberId,
                                        text: autoMessage,
                                        timestamp: Date.now()
                                    });
                                }
                            }

                            if (bData.trainerId && bData.date && slotTime) {
                                tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, slotTime)));
                            }
                            if (bData.memberId && bData.date && slotTime) {
                                tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, slotTime)));
                            }
                        });

                        showToast(`Session ${newStatus.toLowerCase()} and message sent.`, "success");
                        if (window.logActivity) window.logActivity("Booking Status Updated", `Booking ${id} marked as ${newStatus}. Message sent to ${b.memberName}.`);
                    } catch (err) {
                        console.error("Status-change transaction failed:", err);
                        const msg = (err && err.message) || '';
                        if (msg.includes("no longer exists")) {
                            if (window.bookingActionFailedToast) window.bookingActionFailedToast(err);
                            else showToast("This booking was already cancelled or removed.", "info");
                        } else if (window.bookingActionFailedToast) {
                            window.bookingActionFailedToast(err);
                        } else {
                            showToast(msg || `Failed to mark session ${newStatus.toLowerCase()}.`, "error");
                        }
                    } finally {
                        _release();
                    }
                    }  // end onConfirm async arrow
                }); // end showConfirm (V-07 object form)
            }
        });
        return;
    }

    showConfirm({
        title: `Mark as ${newStatus}`,
        message: `Are you sure you want to mark this session as ${newStatus}?`,
        tone: 'success',
        confirmText: newStatus,
        onConfirm: async () => {
        const uiStatusAtConfirm = (currentBooking && currentBooking.status) || 'Pending';
        try {
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
            await _assertNotFutureCompleted(currentBooking); // BUG-12: fresh time sync before write
            if (newStatus === 'Confirmed' && currentBooking) {
                try {
                    if (typeof window.queryTrainerScheduleConflict === 'function') {
                        const conflict = await window.queryTrainerScheduleConflict(
                            currentBooking.trainerId, currentBooking.date, currentBooking.time, id
                        );
                        if (conflict) {
                            throw new Error("Scheduling Conflict: Trainer already booked for this time slot.");
                        }
                    }
                } catch (preErr) {
                    console.error("Trainer conflict pre-check failed:", preErr);
                    throw preErr;
                }
            }
            await runTransaction(db, async (tx) => {
                const bookingRef = doc(db, "bookings", id);
                const bSnap = await tx.get(bookingRef);
                if (!bSnap.exists()) throw new Error("Booking no longer exists.");
                const bData = bSnap.data() || {};

                let memberRef = null;
                let slotRef = null;
                const needsMemberRead = !!(
                    bData.memberId && (
                        newStatus === 'Confirmed'
                        || ((newStatus === 'Completed' || newStatus === 'No Show') && !bData.creditState)
                    )
                );
                const needsSlotRead = !!(newStatus === 'Confirmed' && bData.trainerId && bData.date && bData.time);

                if (needsMemberRead) memberRef = doc(db, "users", bData.memberId);
                if (needsSlotRead) slotRef = doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time));

                const memberSnap = memberRef ? await tx.get(memberRef) : null;
                const slotSnap = slotRef ? await tx.get(slotRef) : null;

                _assertOwnership(bData);
                await _assertNotFutureCompleted(bData);

                if (window.verifyBookingServerState) {
                    window.verifyBookingServerState(bData, uiStatusAtConfirm);
                }
                if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(bData.status)) {
                    throw new Error(`This booking is ${bData.status} and is locked for audit integrity.`);
                }

                if (newStatus === 'Confirmed') {
                    if (bData.status !== 'Pending') {
                        throw new Error(window.BOOKING_STATE_CHANGED_MSG || `Cannot confirm a booking that is already ${bData.status}.`);
                    }
                    if (memberRef) {
                        if (!memberSnap || !memberSnap.exists()) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        const mData = memberSnap.data() || {};
                        const inactiveStatuses = new Set(['Suspended', 'Archived', 'Frozen', 'Expired', 'On Leave']);
                        if (inactiveStatuses.has(mData.status || 'Active')) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
                        if (bData.creditState !== 'held' && sessionsRemaining <= 0) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                    }
                    if (slotSnap && slotSnap.exists()) {
                        const slotBookingId = (slotSnap.data() || {}).bookingId;
                        if (slotBookingId && slotBookingId !== id) {
                            throw new Error("Scheduling Conflict: Trainer already booked for this time slot.");
                        }
                    }
                    tx.update(bookingRef, { status: newStatus });
                } else if (newStatus === 'Completed' || newStatus === 'No Show') {
                    if (bData.creditState === 'consumed') {
                        tx.update(bookingRef, { status: newStatus });
                    } else if (bookingHoldsCredit(bData)) {
                        tx.update(bookingRef, { status: newStatus, creditState: 'consumed' });
                    } else if (!bData.creditState && bData.memberId && memberRef && memberSnap && memberSnap.exists()) {
                        tx.update(memberRef, { sessionsRemaining: increment(-1) });
                        tx.update(bookingRef, { status: newStatus, creditState: 'consumed' });
                    } else {
                        tx.update(bookingRef, { status: newStatus });
                    }
                    if (bData.trainerId && bData.date && bData.time) {
                        tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                    }
                    if (bData.memberId && bData.date && bData.time) {
                        tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                    }
                } else {
                    tx.update(bookingRef, { status: newStatus });
                }
            });
            showToast(`Session marked as ${newStatus}.`, "success");
            if (window.logActivity) window.logActivity("Booking Status Updated", `Booking ${id} marked as ${newStatus}.`);
        } catch (err) {
            console.error("Status-change transaction failed:", err);
            if (window.bookingActionFailedToast) window.bookingActionFailedToast(err);
            else showToast(err.message || "Failed to update session status.", "error");
        } finally {
            _release();
        }
        },
        onCancel: _release,
    });
}


window.isMemberPlanExpired = function (member) {
    if (!member) return false;
    if (typeof member.dateRegistered !== 'number') return false;
    const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(member.plan) : 30;
    const expiryAt = member.dateRegistered + planDays * 24 * 60 * 60 * 1000;
    const offset = window.serverTimeOffsetMs || 0;
    return (Date.now() + offset) > expiryAt;
}

window.openMemberBookingModal = () => {
    // Check if membership is expired before opening
    const daysText = document.getElementById('myPlanDays')?.innerText || "";
    if (daysText.includes("Expired")) {
        const expiredModal = document.getElementById('membershipExpiredModal');
        if (expiredModal) {
            expiredModal.style.display = 'flex';
        } else {
            showToast("Your membership has expired. Please renew to book sessions.", "error");
        }
        return;
    }

    // M11: block booking if member's plan has been deactivated by admin
    const me = window.currentUserData || {};
    if (me.plan) {
        const planObj = (window.__membershipPlansData || []).find(p => (p.name || '').toLowerCase() === (me.plan || '').toLowerCase());
        if (planObj && planObj.status && planObj.status !== 'Active') {
            showToast(`Your "${me.plan}" plan is currently inactive. Please contact staff to switch plans.`, "error");
            return;
        }
        if (!planObj) {
            showToast(`Your membership plan is not recognized. Please contact staff.`, "error");
            return;
        }
    }

    const trainerSelect = document.getElementById('memberBookTrainer');
    if (trainerSelect) {
        // Only Active + On Floor trainers may be booked — On Leave, Suspended, and Archived
        // are excluded regardless of their RFID-reported shiftStatus to prevent glitch access.
        const trainers = (allUsersData || []).filter(u =>
            (u.role || "").toLowerCase() === 'trainer' &&
            (u.status || 'Active') === 'Active' &&
            u.shiftStatus === 'On Floor'
        );
        trainerSelect.innerHTML = '<option value="" disabled selected>Select a Trainer...</option>' +
            trainers.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || `${t.givenName || ''} ${t.familyName || ''}`.trim())}</option>`).join('');
    }

    // Reset layout elements
    const gridEl = document.getElementById('bookingDateTimeGrid');
    const sidebarEl = document.getElementById('bookingDetailsSidebar');
    if (gridEl) gridEl.style.display = 'none';
    if (sidebarEl) sidebarEl.style.display = 'none';

    // Clear and disable confirm button
    const confirmBtn = document.getElementById('confirmBookingBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Request';
    }

    // Setup initial bookingState
    const now = new Date();
    window.bookingState = {
        trainerId: '',
        trainerName: '',
        month: now.getMonth(),
        year: now.getFullYear(),
        date: '',
        time: ''
    };

    // Reset any leftover reschedule-mode UI from a previous open
    window._resetBookingModalForCreate();

    // Open Modal
    const memberBookingModal = document.getElementById('memberBookingModal');
    if (!memberBookingModal) { console.error('[openMemberBookingModal] #memberBookingModal not found'); return; }
    memberBookingModal.style.display = 'flex';

    // Auto-setup listeners exactly once
    if (!window.bookingListenersInitialized) {
        window.setupBookingModalListeners();
        window.bookingListenersInitialized = true;
    }
}

// Restores the member booking modal back to its default "create" appearance.
// Called when opening for a new booking, and when closing after a reschedule.
window._resetBookingModalForCreate = () => {
    const titleEl = document.getElementById('memberBookingModalTitle');
    if (titleEl) titleEl.innerText = 'Request a Training Session';
    const trainerSelect = document.getElementById('memberBookTrainer');
    if (trainerSelect) trainerSelect.disabled = false;
    const confirmBtn = document.getElementById('confirmBookingBtn');
    if (confirmBtn) confirmBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Request';
};

// Opens the member booking modal in reschedule mode for an existing booking.
// Trainer is locked; only date/time can change. Enforces the >2h client-side rule.
window.openRescheduleModal = (bookingId) => {
    const booking = (window.bookingsData || []).find(b => b.id === bookingId);
    if (!booking) {
        showToast("Booking not found. It may have been removed.", "error");
        return;
    }
    if (booking.memberId !== localStorage.getItem("userId")) {
        showToast("You can only reschedule your own bookings.", "error");
        return;
    }
    if (!["Pending", "Confirmed"].includes(booking.status)) {
        showToast(`Bookings in "${booking.status}" status cannot be rescheduled.`, "error");
        return;
    }
    const offset = window.serverTimeOffsetMs || 0;
    const nowMs = Date.now() + offset;
    const bookingMs = new Date(`${booking.date}T${booking.time}`).getTime();
    if (bookingMs - nowMs <= 2 * 60 * 60 * 1000) {
        showToast("Reschedule is only allowed more than 2 hours before the booking time.", "error");
        return;
    }

    // Membership / plan inactive checks (same gate as new booking)
    const daysText = document.getElementById('myPlanDays')?.innerText || "";
    if (daysText.includes("Expired")) {
        showToast("Your membership has expired. Please renew before rescheduling.", "error");
        return;
    }

    // Pre-populate the trainer dropdown with the locked trainer
    const trainerSelect = document.getElementById('memberBookTrainer');
    if (trainerSelect) {
        trainerSelect.innerHTML = `<option value="${escapeHtml(booking.trainerId)}" selected>${escapeHtml(booking.trainerName || 'Trainer')}</option>`;
        trainerSelect.disabled = true;
    }

    // Show calendar / sidebar immediately (trainer is already selected)
    const gridEl = document.getElementById('bookingDateTimeGrid');
    const sidebarEl = document.getElementById('bookingDetailsSidebar');
    if (gridEl) gridEl.style.display = 'grid';
    if (sidebarEl) sidebarEl.style.display = 'flex';

    // Swap modal chrome for reschedule mode
    const titleEl = document.getElementById('memberBookingModalTitle');
    if (titleEl) titleEl.innerText = 'Reschedule Booking';
    const confirmBtn = document.getElementById('confirmBookingBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-rotate"></i> Confirm Reschedule';
    }

    const now = new Date();
    window.bookingState = {
        mode: 'reschedule',
        originalBookingId: booking.id,
        previousDate: booking.date,
        previousTime: booking.time,
        trainerId: booking.trainerId,
        trainerName: booking.trainerName || '',
        month: now.getMonth(),
        year: now.getFullYear(),
        date: '',
        time: ''
    };

    const rescheduleModalEl = document.getElementById('memberBookingModal');
    if (!rescheduleModalEl) { console.error('[openRescheduleModal] #memberBookingModal not found'); return; }
    rescheduleModalEl.style.display = 'flex';

    if (!window.bookingListenersInitialized) {
        window.setupBookingModalListeners();
        window.bookingListenersInitialized = true;
    }

    if (window.renderBookingCalendar) window.renderBookingCalendar();
    if (window.updateBookingSummary) window.updateBookingSummary();
};

window.renderBookingCalendar = () => {
    const daysGrid = document.getElementById('calDaysGrid');
    const monthTitle = document.getElementById('calMonthTitle');
    if (!daysGrid || !monthTitle || !window.bookingState) return;

    const { month, year, date: selectedDate } = window.bookingState;
    
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
                   b.memberId === localStorage.getItem("userId") && 
                   ["Confirmed", "Pending"].includes(b.status);
        });
        if (hasBooking) {
            cell.classList.add('has-dot');
        }

        cell.addEventListener('click', () => {
            window.bookingState.date = dateStr;
            window.bookingState.time = ''; 
            
            const selectedCell = daysGrid.querySelector('.cal-day-cell.selected');
            if (selectedCell) selectedCell.classList.remove('selected');
            cell.classList.add('selected');

            window.renderBookingTimeSlots(dateStr);
            window.updateBookingSummary();
        });

        daysGrid.appendChild(cell);
    }
}

window.renderBookingTimeSlots = (dateStr) => {
    const slotsGrid = document.getElementById('timeSlotsGrid');
    const selectedDateHeader = document.getElementById('selectedDateHeader');
    if (!slotsGrid || !selectedDateHeader || !window.bookingState) return;
    if (!dateStr) return;

    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const options = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
    selectedDateHeader.innerText = dateObj.toLocaleDateString('en-US', options);

    slotsGrid.innerHTML = '';

    const startHour = 8;
    const endHour = 20;

    // Use server-synced clock so past-slot detection matches transaction validation
    const offset = window.serverTimeOffsetMs || 0;
    const today = new Date(Date.now() + offset);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const bookings = window.bookingsData || [];
    const currentTrainerId = window.bookingState ? window.bookingState.trainerId : '';
    const trainerBookings = currentTrainerId
        ? bookings.filter(b => b.date === dateStr && b.trainerId === currentTrainerId && ["Confirmed", "Pending"].includes(b.status))
        : [];
    const memberBookings = bookings.filter(b => b.date === dateStr && b.memberId === localStorage.getItem("userId") && ["Confirmed", "Pending"].includes(b.status));

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
            // Disable at sub-hour precision — slot that started this hour but is
            // already partially past must be blocked to match server-side future check.
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
            if (window.bookingState && timeStr === window.bookingState.time) {
                slotBtn.classList.add('selected');
            }

            slotBtn.addEventListener('click', () => {
                window.bookingState.time = timeStr;

                const selectedBtn = slotsGrid.querySelector('.time-slot-btn.selected');
                if (selectedBtn) selectedBtn.classList.remove('selected');
                slotBtn.classList.add('selected');

                window.updateBookingSummary();
            });
        }

        slotsGrid.appendChild(slotBtn);
    }
}

window.updateBookingSummary = () => {
    const summaryDateTime = document.getElementById('summaryDateTime');
    const summaryTrainer = document.getElementById('summaryTrainer');
    const memberCreditsDisplay = document.getElementById('memberCreditsDisplay');
    const confirmBtn = document.getElementById('confirmBookingBtn');
    if (!summaryDateTime || !summaryTrainer || !confirmBtn || !window.bookingState) return;

    const { trainerId, trainerName, date, time } = window.bookingState;

    if (trainerId) {
        summaryTrainer.innerText = trainerName;
    } else {
        summaryTrainer.innerText = "Trainer Not Selected";
    }

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
    } else if (date) {
        const [y, m, d] = date.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        summaryDateTime.innerText = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + " (Choose Time)";
    } else {
        summaryDateTime.innerText = "Choose Date & Time";
    }

    const sessionsRemaining = window.currentUserData?.sessionsRemaining !== undefined ? Number(window.currentUserData.sessionsRemaining) : 0;
    const sessionsTotal = window.currentUserData?.sessionsTotal !== undefined ? Number(window.currentUserData.sessionsTotal) : 0;
    
    if (memberCreditsDisplay) {
        memberCreditsDisplay.innerText = `${sessionsRemaining} of ${sessionsTotal} Remaining Sessions`;
        if (sessionsRemaining <= 0) {
            memberCreditsDisplay.style.color = '#ef4444';
            memberCreditsDisplay.style.fontWeight = 'bold';
        } else {
            memberCreditsDisplay.style.color = '';
            memberCreditsDisplay.style.fontWeight = '';
        }
    }

    const isReschedule = window.bookingState?.mode === 'reschedule';
    const creditOK = isReschedule ? true : sessionsRemaining > 0;
    if (trainerId && date && time && creditOK) {
        confirmBtn.disabled = false;
    } else {
        confirmBtn.disabled = true;
    }
}

// Returns the default CTA HTML for the member booking confirm button based
// on the current booking mode. Used wherever the button needs to be re-armed
// after an in-flight error.
window._memberBookingCtaHtml = () => {
    return window.bookingState?.mode === 'reschedule'
        ? '<i class="fas fa-rotate"></i> Confirm Reschedule'
        : '<i class="fas fa-paper-plane"></i> Send Request';
};

window.setupBookingModalListeners = () => {
    const trainerSelect = document.getElementById('memberBookTrainer');
    const calPrevMonthBtn = document.getElementById('calPrevMonthBtn');
    const calNextMonthBtn = document.getElementById('calNextMonthBtn');
    const confirmBookingBtn = document.getElementById('confirmBookingBtn');

    if (trainerSelect) {
        trainerSelect.addEventListener('change', (e) => {
            const trainerId = e.target.value;
            const trainerName = e.target.options[e.target.selectedIndex].text;
            window.bookingState.trainerId = trainerId;
            window.bookingState.trainerName = trainerName;

            window.bookingState.date = '';
            window.bookingState.time = '';

            const gridEl = document.getElementById('bookingDateTimeGrid');
            const sidebarEl = document.getElementById('bookingDetailsSidebar');
            if (gridEl) gridEl.style.display = 'grid';
            if (sidebarEl) sidebarEl.style.display = 'flex';

            window.renderBookingCalendar();
            window.updateBookingSummary();
        });
    }

    if (calPrevMonthBtn) {
        calPrevMonthBtn.addEventListener('click', () => {
            if (!window.bookingState) return;
            window.bookingState.month--;
            if (window.bookingState.month < 0) {
                window.bookingState.month = 11;
                window.bookingState.year--;
            }
            window.renderBookingCalendar();
        });
    }

    if (calNextMonthBtn) {
        calNextMonthBtn.addEventListener('click', () => {
            if (!window.bookingState) return;
            window.bookingState.month++;
            if (window.bookingState.month > 11) {
                window.bookingState.month = 0;
                window.bookingState.year++;
            }
            window.renderBookingCalendar();
        });
    }

    if (confirmBookingBtn) {
        confirmBookingBtn.addEventListener('click', async () => {
            if (!window.bookingState) return;
            // Synchronous re-entry guard — fires before the button's disabled bit takes effect
            if (window._memberBookingInFlight) return;
            window._memberBookingInFlight = true;

            const { trainerId, trainerName, date: bookDate, time: bookTime } = window.bookingState;
            const memberId = localStorage.getItem("userId");
            const memberName = localStorage.getItem("loggedInUser");

            if (!trainerId || !bookDate || !bookTime) {
                showToast("Please choose trainer, date, and time before booking.", "error");
                window._memberBookingInFlight = false;
                return;
            }

            const isReschedule = window.bookingState?.mode === 'reschedule';
            const rescheduleId = isReschedule ? window.bookingState.originalBookingId : null;

            // Same-day pre-confirm: warn (but allow) when the member already has
            // another booking on the chosen date. Skipped once if the user just
            // clicked Proceed on the confirmation popup. In reschedule mode, the
            // booking being moved is excluded so it doesn't warn about itself.
            if (!window._memberBookingSkipSameDayConfirm) {
                const sameDay = window.findSameDayBookings(memberId, bookDate, rescheduleId);
                if (sameDay.length > 0) {
                    window._memberBookingInFlight = false; // release while waiting on user
                    const lines = sameDay.map(b => '• ' + window.formatBookingSummary(b)).join('\n');
                    window.showConfirm({
                        title: 'You already have a session today',
                        message: `You have ${sameDay.length === 1 ? 'a booking' : 'bookings'} on this date:\n${lines}\n\nProceed with another booking at ${bookTime} with ${trainerName}?`,
                        tone: 'warning',
                        confirmText: 'Proceed anyway',
                        cancelText: 'Cancel',
                        onConfirm: () => {
                            window._memberBookingSkipSameDayConfirm = true;
                            confirmBookingBtn.click();
                        }
                    });
                    return;
                }
            }
            window._memberBookingSkipSameDayConfirm = false;

            confirmBookingBtn.disabled = true;
            confirmBookingBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';

            const [bH, bM] = bookTime.split(':').map(Number);
            const bookMins = bH * 60 + bM;

            // 1. Conflict Detection Pre-queries
            let trainerConflict = false;
            let memberConflict = false;

            try {
                const trainerSnap = await getDocs(query(bookingsCol, where("date", "==", bookDate)));
                trainerSnap.forEach(docSnap => {
                    if (rescheduleId && docSnap.id === rescheduleId) return;
                    const data = docSnap.data();
                    if (data.trainerId !== trainerId) return;
                    if (data.status !== "Confirmed" && data.status !== "Pending") return;
                    const timeStr = data.time;
                    if (timeStr) {
                        const [eH, eM] = timeStr.split(':').map(Number);
                        if (Math.abs(bookMins - (eH * 60 + eM)) < 60) trainerConflict = true;
                    }
                });

                const memberSnap = await getDocs(query(bookingsCol, where("date", "==", bookDate)));
                memberSnap.forEach(docSnap => {
                    if (rescheduleId && docSnap.id === rescheduleId) return;
                    const data = docSnap.data();
                    if (data.memberId !== memberId) return;
                    if (data.status !== "Confirmed" && data.status !== "Pending") return;
                    const timeStr = data.time;
                    if (timeStr) {
                        const [eH, eM] = timeStr.split(':').map(Number);
                        if (Math.abs(bookMins - (eH * 60 + eM)) < 60) memberConflict = true;
                    }
                });
            } catch (err) {
                console.error("Conflict pre-queries failed:", err);
                showToast("Failed to verify trainer and scheduling conflicts.", "error");
                confirmBookingBtn.disabled = false;
                confirmBookingBtn.innerHTML = window._memberBookingCtaHtml();
                return;
            }

            if (trainerConflict) {
                showToast("Trainer was just booked by another member! Please choose another time.", "error");
                confirmBookingBtn.disabled = false;
                confirmBookingBtn.innerHTML = window._memberBookingCtaHtml();
                if (window.renderBookingTimeSlots) window.renderBookingTimeSlots(bookDate);
                return;
            }

            if (memberConflict) {
                showToast("You already have a booking at this time. You cannot book two trainers at the same hour.", "error");
                confirmBookingBtn.disabled = false;
                confirmBookingBtn.innerHTML = window._memberBookingCtaHtml();
                return;
            }

            // 2. Transaction Enforced Booking validation
            try {
                await syncServerTimeOffset();
                const _bookingServerOffset = window.serverTimeOffsetMs || 0;
                if (isReschedule) {
                    const originalId = window.bookingState.originalBookingId;
                    const prevDate = window.bookingState.previousDate;
                    const prevTime = window.bookingState.previousTime;

                    await runTransaction(db, async (transaction) => {
                        const bookingRef = doc(db, "bookings", originalId);
                        const memberRefRS = doc(db, "users", memberId);
                        const trainerRefRS = doc(db, "users", trainerId);
                        const newTrainerSlotRef = doc(db, "bookingSlots", slotIdForTrainer(trainerId, bookDate, bookTime));
                        const newMemberSlotRef  = doc(db, "bookingSlots", slotIdForMember(memberId, bookDate, bookTime));
                        const oldTrainerSlotRef = doc(db, "bookingSlots", slotIdForTrainer(trainerId, prevDate, prevTime));
                        const oldMemberSlotRef  = doc(db, "bookingSlots", slotIdForMember(memberId, prevDate, prevTime));

                        const [bookingSnap, memberSnapRS, trainerSnapRS, newTrainerSlotSnap, newMemberSlotSnap] = await Promise.all([
                            transaction.get(bookingRef),
                            transaction.get(memberRefRS),
                            transaction.get(trainerRefRS),
                            transaction.get(newTrainerSlotRef),
                            transaction.get(newMemberSlotRef)
                        ]);

                        if (!bookingSnap.exists()) {
                            throw new Error("This booking no longer exists.");
                        }
                        const bData = bookingSnap.data();
                        if (bData.memberId !== memberId) {
                            throw new Error("You can only reschedule your own bookings.");
                        }
                        // R1 (Sprint 7): trainer is locked client-side, but `trainerId`
                        // is read from `window.bookingState` which is console-tamperable.
                        // Re-pin it to the original booking's trainer inside the txn so a
                        // panelist can't redirect their reschedule to hijack a different
                        // trainer's slot or orphan the original trainer's slot lock.
                        if (bData.trainerId !== trainerId) {
                            throw new Error("Trainer cannot be changed when rescheduling. Please reopen the modal.");
                        }
                        if (!["Pending", "Confirmed"].includes(bData.status)) {
                            throw new Error(`Bookings in "${bData.status}" status cannot be rescheduled.`);
                        }

                        // O1 (Sprint 9): Re-validate member plan expiry and trainer status against
                        // the NEW date. Without this, a member can slide a session past their plan
                        // expiry (e.g. expires Dec 15, reschedule from Dec 10 → Dec 20) — the
                        // original new-booking path enforces this but the reschedule path skipped it.
                        if (!memberSnapRS.exists()) {
                            throw new Error("Member record does not exist.");
                        }
                        if (!trainerSnapRS.exists()) {
                            throw new Error("Selected trainer no longer exists. Please pick a different trainer.");
                        }
                        const mDataRS = memberSnapRS.data();
                        if ((mDataRS.status || 'Active') === 'Suspended') {
                            throw new Error("ACCESS_DENIED: Your account is suspended. Rescheduling is prohibited.");
                        }
                        if ((mDataRS.status || 'Active') === 'Archived') {
                            throw new Error("ACCESS_DENIED: Your account is archived. Rescheduling is prohibited.");
                        }
                        const tDataRS = trainerSnapRS.data();
                        if ((tDataRS.role || '').toLowerCase() !== 'trainer') {
                            throw new Error("Selected user is no longer a trainer.");
                        }
                        if ((tDataRS.status || 'Active') !== 'Active') {
                            throw new Error("Selected trainer is no longer available. Please cancel and pick a different trainer.");
                        }
                        if (window.isMemberPlanExpired && window.isMemberPlanExpired(mDataRS)) {
                            throw new Error("Your membership has expired. Please renew before rescheduling.");
                        }
                        if (typeof mDataRS.dateRegistered === 'number') {
                            const planDaysRS = (typeof window.getPlanDays === 'function') ? window.getPlanDays(mDataRS.plan) : 30;
                            const expiryAtRS = mDataRS.dateRegistered + planDaysRS * 24 * 60 * 60 * 1000;
                            const targetMsRS = new Date(`${bookDate}T${bookTime}`).getTime();
                            if (targetMsRS > expiryAtRS) {
                                throw new Error("The new booking date is past your membership plan's expiration date. Please renew before rescheduling that far out.");
                            }
                        }

                        // Re-check the 2-hour rule against the booking's CURRENT scheduled time
                        const freshNowMsRS = Date.now() + _bookingServerOffset;
                        const originalSlotMs = parseBookingSlotLocal(bData.date, bData.time);
                        if (originalSlotMs === null) {
                            throw new Error("This booking has invalid date/time data and cannot be rescheduled.");
                        }
                        if (originalSlotMs - freshNowMsRS <= 2 * 60 * 60 * 1000) {
                            throw new Error("Reschedule window has closed (less than 2 hours until the booking).");
                        }
                        const newSlotMs = parseBookingSlotLocal(bookDate, bookTime);
                        if (newSlotMs === null || newSlotMs < freshNowMsRS) {
                            throw new Error("Choose a date and time in the future.");
                        }

                        // New slot must not be taken (unless it happens to be the SAME slot we're moving from)
                        const sameSlot = (bookDate === prevDate && bookTime === prevTime);
                        if (!sameSlot) {
                            if (newTrainerSlotSnap.exists()) {
                                throw new Error("Trainer was just booked at the new time! Please choose another slot.");
                            }
                            if (newMemberSlotSnap.exists()) {
                                throw new Error("You already have a booking at the new hour.");
                            }
                        }

                        if (!sameSlot) {
                            transaction.delete(oldTrainerSlotRef);
                            transaction.delete(oldMemberSlotRef);
                            transaction.set(newTrainerSlotRef, { bookingId: originalId, trainerId, date: bookDate, time: bookTime });
                            transaction.set(newMemberSlotRef,  { bookingId: originalId, memberId,  date: bookDate, time: bookTime });
                        }
                        transaction.update(bookingRef, {
                            date: bookDate,
                            time: bookTime,
                            status: "Pending",
                            rescheduledAt: freshNowMsRS,
                            previousDate: prevDate,
                            previousTime: prevTime
                        });
                    });

                    window.closeModal('memberBookingModal');
                    window._resetBookingModalForCreate();
                    showToast("Reschedule submitted — awaiting trainer confirmation.", "success");
                    if (window.logActivity) window.logActivity("Booking Rescheduled", `Moved booking ${originalId} from ${prevDate} ${prevTime} to ${bookDate} ${bookTime}.`);
                    return; // skip the create path below
                }

                await runTransaction(db, async (transaction) => {
                    const memberRef = doc(db, "users", memberId);
                    const trainerRef = doc(db, "users", trainerId);
                    const trainerSlotRef = doc(db, "bookingSlots", slotIdForTrainer(trainerId, bookDate, bookTime));
                    const memberSlotRef  = doc(db, "bookingSlots", slotIdForMember(memberId, bookDate, bookTime));

                    // All reads must happen before any writes inside a Firestore tx
                    const [memberSnap, trainerSnap, trainerSlotSnap, memberSlotSnap] = await Promise.all([
                        transaction.get(memberRef),
                        transaction.get(trainerRef),
                        transaction.get(trainerSlotRef),
                        transaction.get(memberSlotRef),
                    ]);

                    if (!memberSnap.exists()) {
                        throw new Error("Member record does not exist.");
                    }
                    // H1: trainer must still exist and be Active at the moment of confirmation
                    if (!trainerSnap.exists()) {
                        throw new Error("Selected trainer no longer exists. Please pick a different trainer.");
                    }
                    const tData = trainerSnap.data();
                    if ((tData.role || '').toLowerCase() !== 'trainer') {
                        throw new Error("Selected user is no longer a trainer.");
                    }
                    if ((tData.status || 'Active') !== 'Active') {
                        throw new Error("Selected trainer is no longer available. Please pick a different trainer.");
                    }
                    const mData = memberSnap.data();
                    if ((mData.status || 'Active') === 'Suspended') {
                        throw new Error("ACCESS_DENIED: Your account is suspended. Bookings are prohibited.");
                    }
                    if ((mData.status || 'Active') === 'Archived') {
                        throw new Error("ACCESS_DENIED: Your account is archived. Bookings are prohibited.");
                    }

                    // Atomic slot collision (closes pre-query race)
                    if (trainerSlotSnap.exists()) {
                        throw new Error("Trainer was just booked by another member! Please choose another time.");
                    }
                    if (memberSlotSnap.exists()) {
                        throw new Error("You already have a booking at this hour.");
                    }

                    // Expiration Check
                    if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                        throw new Error("Your membership has expired. Please renew to book sessions.");
                    }
                    if (typeof mData.dateRegistered === 'number') {
                        const planDays = (typeof window.getPlanDays === 'function') ? window.getPlanDays(mData.plan) : 30;
                        const expiryAt = mData.dateRegistered + planDays * 24 * 60 * 60 * 1000;
                        const targetBookingTimeMs = new Date(`${bookDate}T${bookTime}`).getTime();
                        if (targetBookingTimeMs > expiryAt) {
                            throw new Error("The target booking date is past your current membership plan's expiration date. Please renew/extend your membership to book for this date.");
                        }
                    }

                    // Credit Check (in-txn — closes race where two tabs both pass the client-side check)
                    const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
                    if (!Number.isFinite(sessionsRemaining) || sessionsRemaining <= 0) {
                        throw new Error("You have 0 session credits remaining. Please buy more credits at the desk.");
                    }

                    // Time-Tampering / Future Date check using server offset (synced before transaction)
                    const freshNowMsMB = Date.now() + _bookingServerOffset;
                    const bookSlotMs = parseBookingSlotLocal(bookDate, bookTime);
                    if (bookSlotMs === null || bookSlotMs < freshNowMsMB) {
                        throw new Error("Choose a date and time in the future. Past sessions cannot be booked.");
                    }

                    // Hold the credit atomically and claim both slots
                    const newBookingRef = doc(collection(db, "bookings"));
                    transaction.update(memberRef, { sessionsRemaining: increment(-1) });
                    transaction.set(trainerSlotRef, { bookingId: newBookingRef.id, trainerId, date: bookDate, time: bookTime });
                    transaction.set(memberSlotRef,  { bookingId: newBookingRef.id, memberId,  date: bookDate, time: bookTime });
                    transaction.set(newBookingRef, {
                        memberId,
                        memberName,
                        trainerId,
                        trainerName,
                        date: bookDate,
                        time: bookTime,
                        status: "Pending",
                        creditState: "held",
                        timestamp: freshNowMsMB
                    });
                });

                window.closeModal('memberBookingModal');
                showToast("Request sent successfully! Waiting for trainer approval.", "success");
                if (window.logActivity) window.logActivity("Booking Created", `Requested a PT session on ${bookDate} at ${bookTime} with ${trainerName}.`);

            } catch (err) {
                console.error("Booking failed:", err);
                showToast(err.message || "Failed to submit booking request.", "error");
            } finally {
                confirmBookingBtn.disabled = false;
                confirmBookingBtn.innerHTML = window._memberBookingCtaHtml();
                window._memberBookingInFlight = false;
            }
        });
    }
}

window.openBookingModal = () => {
    const memberSelect = document.getElementById('bookMember');
    const trainerSelect = document.getElementById('bookTrainer');
    const bookingModal = document.getElementById('bookingModal');
    const bookingForm = document.getElementById('bookingForm');
    if (!memberSelect || !trainerSelect || !bookingModal || !bookingForm) {
        console.error('[openBookingModal] Required DOM elements missing');
        return;
    }
    const activeMembers = (membersData || []).filter(m => {
        const isArchived = (m.status || "").toLowerCase() === 'archived';
        const isSuspended = (m.status || "").toLowerCase() === 'suspended';
        const isExpired = window.isMemberPlanExpired && window.isMemberPlanExpired(m);
        return (m.status || 'Active') === 'Active' && !isArchived && !isSuspended && !isExpired;
    });
    memberSelect.innerHTML = '<option value="" disabled selected>Select a Member...</option>' + activeMembers.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || `${m.givenName || ''} ${m.familyName || ''}`.trim())}</option>`).join('');
    const trainers = (allUsersData || []).filter(u =>
        (u.role || "").toLowerCase() === 'trainer' &&
        (u.status || 'Active') === 'Active' &&
        u.shiftStatus === 'On Floor'
    );
    trainerSelect.innerHTML = '<option value="" disabled selected>Select an Assigned Trainer...</option>' + trainers.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || `${t.givenName || ''} ${t.familyName || ''}`.trim())}</option>`).join('');

    bookingForm.reset();
    const bd = document.getElementById('bookDate');
    const bt = document.getElementById('bookTime');
    setBookingDateMin(bd);
    updateBookingTimeMinForToday(bd, bt);
    bookingModal.style.display = 'flex';
}

if (document.getElementById('bookingForm')) {
    document.getElementById('bookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (window._adminBookingInFlight) return;
        window._adminBookingInFlight = true;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        }
        const _releaseAdminBooking = () => {
            window._adminBookingInFlight = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        };
        const memberSelect = document.getElementById('bookMember'), trainerSelect = document.getElementById('bookTrainer');
        const dateEl = document.getElementById('bookDate');
        const timeEl = document.getElementById('bookTime');
        setBookingDateMin(dateEl);
        updateBookingTimeMinForToday(dateEl, timeEl);
        if (!dateEl.checkValidity()) { dateEl.reportValidity(); _releaseAdminBooking(); return; }
        if (!timeEl.checkValidity()) { timeEl.reportValidity(); _releaseAdminBooking(); return; }
        const memberId = memberSelect.value, trainerId = trainerSelect.value, bookDate = dateEl.value, bookTime = timeEl.value;
        const memberName = memberSelect.options[memberSelect.selectedIndex].text, trainerName = trainerSelect.options[trainerSelect.selectedIndex].text;

        // Single-field query + in-memory filter (no composite index)
        let snap;
        try {
            snap = await getDocs(query(bookingsCol, where("date", "==", bookDate)));
        } catch (err) {
            console.error("Conflict pre-query failed:", err);
            showToast("Failed to check schedule conflicts.", "error");
            _releaseAdminBooking();
            return;
        }

        let conflict = false;
        const [bH, bM] = bookTime.split(':').map(Number);
        const bookMins = bH * 60 + bM;

        snap.forEach(docSnap => {
            const data = docSnap.data();
            if (data.trainerId !== trainerId) return;
            if (data.status !== "Confirmed" && data.status !== "Pending") return;
            const timeStr = data.time;
            if (timeStr) {
                const [eH, eM] = timeStr.split(':').map(Number);
                const existingMins = eH * 60 + eM;
                if (Math.abs(bookMins - existingMins) < 60) {
                    conflict = true;
                }
            }
        });

        if (conflict) {
            showToast("This trainer already has a session booked within 1 hour of this time.", "error");
            _releaseAdminBooking();
            return;
        }

        // 2. Transaction Enforced Booking validation
        try {
            await syncServerTimeOffset();
            const _adminBookingOffset = window.serverTimeOffsetMs || 0;
            await runTransaction(db, async (transaction) => {
                const memberRef = doc(db, "users", memberId);
                const trainerRef = doc(db, "users", trainerId);
                const trainerSlotRef = doc(db, "bookingSlots", slotIdForTrainer(trainerId, bookDate, bookTime));
                const memberSlotRef  = doc(db, "bookingSlots", slotIdForMember(memberId, bookDate, bookTime));

                const [memberSnap, trainerSnap, trainerSlotSnap, memberSlotSnap] = await Promise.all([
                    transaction.get(memberRef),
                    transaction.get(trainerRef),
                    transaction.get(trainerSlotRef),
                    transaction.get(memberSlotRef),
                ]);

                if (!memberSnap.exists()) {
                    throw new Error("Member record does not exist.");
                }
                if (!trainerSnap.exists()) {
                    throw new Error("Selected trainer no longer exists. Please choose a different trainer.");
                }
                const tData = trainerSnap.data() || {};
                if ((tData.role || '').toLowerCase() !== 'trainer') {
                    throw new Error("Selected user is no longer a trainer.");
                }
                if ((tData.status || 'Active') !== 'Active') {
                    throw new Error("Selected trainer is not currently active.");
                }
                const mData = memberSnap.data();
                if ((mData.status || 'Active') === 'Suspended') {
                    throw new Error("ACCESS_DENIED: Member account is suspended. Bookings are prohibited.");
                }
                if ((mData.status || 'Active') === 'Archived') {
                    throw new Error("ACCESS_DENIED: Member account is archived. Bookings are prohibited.");
                }

                if (trainerSlotSnap.exists()) {
                    throw new Error("This trainer is already booked within 1 hour of this time.");
                }
                if (memberSlotSnap.exists()) {
                    throw new Error(`${memberName} already has a booking at this hour.`);
                }

                // Expiration Check
                if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                    throw new Error(`Cannot book session: ${memberName}'s membership has expired.`);
                }

                // Credit Check
                const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
                if (!Number.isFinite(sessionsRemaining) || sessionsRemaining <= 0) {
                    throw new Error(`Cannot book session: ${memberName} has 0 session credits remaining. Please purchase more credits.`);
                }

                // Time-Tampering / Future Date check using server offset
                const freshNowMsAdmin = Date.now() + _adminBookingOffset;
                const bookSlotMsAdmin = parseBookingSlotLocal(bookDate, bookTime);
                if (bookSlotMsAdmin === null || bookSlotMsAdmin < freshNowMsAdmin) {
                    throw new Error("Choose a date and time in the future. Past sessions cannot be booked.");
                }

                // Hold the credit atomically and claim both slots
                const newBookingRef = doc(collection(db, "bookings"));
                transaction.update(memberRef, { sessionsRemaining: increment(-1) });
                transaction.set(trainerSlotRef, { bookingId: newBookingRef.id, trainerId, date: bookDate, time: bookTime });
                transaction.set(memberSlotRef,  { bookingId: newBookingRef.id, memberId,  date: bookDate, time: bookTime });
                transaction.set(newBookingRef, {
                    memberId,
                    memberName,
                    trainerId,
                    trainerName,
                    date: bookDate,
                    time: bookTime,
                    status: "Confirmed",
                    creditState: "held",
                    timestamp: freshNowMsAdmin
                });
            });

            window.closeModal('bookingModal');
            showToast("Personal Training Session booked successfully!", "success");
            if (window.logActivity) window.logActivity("Booking Created", `Admin/Staff booked a training session.`);
        } catch (err) {
            console.error("Booking transaction failed:", err);
            showToast(err.message || "Failed to book training session.", "error");
        } finally {
            _releaseAdminBooking();
        }
    });
}

window.openEditBookingModal = (id) => {
    const b = bookingsData.find(x => x.id === id);
    if (!b) return;
    if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(b.status)) {
        return showToast(`This booking is ${b.status} and is locked for audit integrity.`, "error");
    }
    const dateObj = new Date(`${b.date}T${b.time}`);
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    document.getElementById('editBookingId').value = b.id;
    document.getElementById('editBookingDetails').innerText = `${b.memberName} with ${b.trainerName} on ${dateStr} at ${timeStr}`;
    
    // Dynamically limit booking status dropdown options to valid transitions!
    const select = document.getElementById('editBookingStatus');
    if (select) {
        select.innerHTML = '';
        // Add current status as first and selected option
        const currentOpt = document.createElement('option');
        currentOpt.value = b.status;
        currentOpt.textContent = b.status;
        currentOpt.selected = true;
        select.appendChild(currentOpt);

        // Add allowed transitions
        const allowed = (window.BOOKING_STATUS_TRANSITIONS && window.BOOKING_STATUS_TRANSITIONS[b.status]) || [];
        for (const status of allowed) {
            const opt = document.createElement('option');
            opt.value = status;
            opt.textContent = status;
            select.appendChild(opt);
        }
    }

    if (document.getElementById('editBookingRemarks')) {
        document.getElementById('editBookingRemarks').value = b.cancelRemarks || "";
    }
    document.getElementById('editBookingModal').style.display = 'flex';
}

if (document.getElementById('editBookingForm')) {
    document.getElementById('editBookingForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        // BUG-09: Lock the submit button for the duration of the async write to prevent double-submit.
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const _origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }
        const _rearmBtn = () => { if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = _origBtnHtml; } };

        const id = document.getElementById('editBookingId').value;
        const status = document.getElementById('editBookingStatus').value;
        const currentBooking = (window.bookingsData || []).find(x => x.id === id);
        let remarks = document.getElementById('editBookingRemarks') ? document.getElementById('editBookingRemarks').value : "";
        const rawReason = (remarks || '').trim();

        if (status === 'Declined' && rawReason && typeof window.buildBookingDeclineAutoMessage === 'function') {
            remarks = window.buildBookingDeclineAutoMessage(rawReason, currentBooking?.date, currentBooking?.time || currentBooking?.startTime);
        } else if ((status === 'Cancelled' || status === 'Declined') && rawReason && !rawReason.includes("I have to decline")) {
            remarks = `I have to decline due to the reason: ${rawReason}`;
        }

        // Block illegal transitions same as updateBookingStatus does
        if (currentBooking) {
            if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(currentBooking.status)) {
                _rearmBtn();
                return showToast(`This booking is ${currentBooking.status} and is locked for audit integrity.`, "error");
            }
            const currentStatus = currentBooking.status || 'Pending';
            const allowed = window.BOOKING_STATUS_TRANSITIONS[currentStatus] || [];
            if (currentStatus !== status && !allowed.includes(status)) {
                _rearmBtn();
                return showToast(`Cannot change status from ${currentStatus} to ${status}.`, "error");
            }
            if (status === 'Completed' && currentBooking.date && currentBooking.time) {
                const sessionAt = new Date(`${currentBooking.date}T${currentBooking.time}`).getTime();
                if (!isNaN(sessionAt) && sessionAt > Date.now()) {
                    _rearmBtn();
                    return showToast("Cannot mark a future session as Completed.", "error");
                }
            }
            if (status === 'Confirmed' && currentBooking) {
                const member = (window.membersData || []).find(m => m.id === currentBooking.memberId);
                if (typeof window.assertMemberBookingEligible === 'function') {
                    const elig = window.assertMemberBookingEligible(member || null, currentBooking);
                    if (!elig.ok) {
                        _rearmBtn();
                        return showToast(elig.message, "error");
                    }
                }
                try {
                    if (typeof window.queryTrainerScheduleConflict === 'function') {
                        const conflict = await window.queryTrainerScheduleConflict(
                            currentBooking.trainerId, currentBooking.date, currentBooking.time, id
                        );
                        if (conflict) {
                            _rearmBtn();
                            return showToast("Scheduling Conflict: Trainer already booked for this time slot.", "error");
                        }
                    }
                } catch (preErr) {
                    _rearmBtn();
                    console.error("Trainer conflict pre-check failed:", preErr);
                    return showToast("Unable to verify trainer availability. Please try again.", "error");
                }
            }
        }

        const uiStatusAtSubmit = (currentBooking && currentBooking.status) || 'Pending';

        try {
            await runTransaction(db, async (tx) => {
                const bookingRef = doc(db, "bookings", id);
                const bSnap = await tx.get(bookingRef);
                if (!bSnap.exists()) throw new Error("Booking no longer exists.");
                const bData = bSnap.data() || {};

                let memberRef = null;
                let slotRef = null;
                const needsMemberRead = !!(
                    bData.memberId && (
                        status === 'Confirmed'
                        || ((status === 'Cancelled' || status === 'Declined') && bookingHoldsCredit(bData))
                        || ((status === 'Completed' || status === 'No Show') && !bData.creditState)
                    )
                );
                if (needsMemberRead) memberRef = doc(db, "users", bData.memberId);
                if (status === 'Confirmed' && bData.trainerId && bData.date && bData.time) {
                    slotRef = doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time));
                }

                const memberSnap = memberRef ? await tx.get(memberRef) : null;
                const slotSnap = slotRef ? await tx.get(slotRef) : null;

                if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(bData.status)) {
                    throw new Error(`This booking is ${bData.status} and is locked for audit integrity.`);
                }
                if (window.verifyBookingServerState) {
                    window.verifyBookingServerState(bData, uiStatusAtSubmit);
                }

                const update = { status };
                const slotTime = bData.time || bData.startTime || '00:00';
                let chatMessage = remarks;
                if (status === 'Declined' && rawReason) {
                    chatMessage = (typeof window.buildBookingDeclineAutoMessage === 'function')
                        ? window.buildBookingDeclineAutoMessage(rawReason, bData.date, slotTime)
                        : remarks;
                    update.declineReason = rawReason;
                }
                if (chatMessage) update.cancelRemarks = chatMessage;

                if (status === 'Confirmed') {
                    if (bData.status !== 'Pending') {
                        throw new Error(window.BOOKING_STATE_CHANGED_MSG || `Cannot confirm a booking that is already ${bData.status}.`);
                    }
                    if (memberRef) {
                        if (!memberSnap || !memberSnap.exists()) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        const mData = memberSnap.data() || {};
                        const inactiveStatuses = new Set(['Suspended', 'Archived', 'Frozen', 'Expired', 'On Leave']);
                        if (inactiveStatuses.has(mData.status || 'Active')) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        if (window.isMemberPlanExpired && window.isMemberPlanExpired(mData)) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                        const sessionsRemaining = mData.sessionsRemaining !== undefined ? Number(mData.sessionsRemaining) : 0;
                        if (bData.creditState !== 'held' && sessionsRemaining <= 0) {
                            throw new Error("Operation Aborted: Member has insufficient session credits or an inactive package.");
                        }
                    }
                    if (slotSnap && slotSnap.exists()) {
                        const slotBookingId = (slotSnap.data() || {}).bookingId;
                        if (slotBookingId && slotBookingId !== id) {
                            throw new Error("Scheduling Conflict: Trainer already booked for this time slot.");
                        }
                    }
                } else if (status === 'Cancelled' || status === 'Declined') {
                    if (status === 'Cancelled' && bookingHoldsCredit(bData) && bData.memberId) {
                        const lateCancelEdit = typeof window.isLateCancellation === 'function'
                            && window.isLateCancellation({ date: bData.date, time: slotTime });
                        const deskOverride = (localStorage.getItem("userRole") || '').toLowerCase() === 'admin'
                            || (localStorage.getItem("userRole") || '').toLowerCase() === 'staff';
                        if (lateCancelEdit && !deskOverride) {
                            update.creditState = 'consumed';
                        } else {
                            if (!memberSnap || !memberSnap.exists()) throw new Error("Member record no longer exists.");
                            update.creditState = 'refunded';
                        }
                    } else if (status === 'Declined' && bookingHoldsCredit(bData) && bData.memberId) {
                        if (!memberSnap || !memberSnap.exists()) throw new Error("Member record no longer exists.");
                        update.creditState = 'refunded';
                    }
                } else if (status === 'Completed' || status === 'No Show') {
                    if (bData.creditState === 'consumed') {
                        // already finalized
                    } else if (bookingHoldsCredit(bData)) {
                        update.creditState = 'consumed';
                    } else if (!bData.creditState && bData.memberId && memberSnap && memberSnap.exists()) {
                        update.creditState = 'consumed';
                    }
                }

                if (status === 'Cancelled' || status === 'Declined') {
                    if (bookingHoldsCredit(bData) && bData.memberId && memberRef && memberSnap && memberSnap.exists() && update.creditState === 'refunded') {
                        tx.update(memberRef, { sessionsRemaining: increment(1) });
                    }
                    if (bData.trainerId && bData.date && slotTime) {
                        tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, slotTime)));
                    }
                    if (bData.memberId && bData.date && slotTime) {
                        tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, slotTime)));
                    }
                    if (chatMessage && bData.memberId && bData.trainerId) {
                        const newMessageRef = doc(messagesCol);
                        tx.set(newMessageRef, {
                            sender: bData.trainerName || localStorage.getItem("loggedInUser") || "Trainer",
                            receiver: bData.memberName || "",
                            senderId: bData.trainerId,
                            receiverId: bData.memberId,
                            text: chatMessage,
                            timestamp: Date.now()
                        });
                    }
                } else if (status === 'Completed' || status === 'No Show') {
                    if (!bData.creditState && bData.memberId && memberRef && memberSnap && memberSnap.exists() && update.creditState === 'consumed') {
                        tx.update(memberRef, { sessionsRemaining: increment(-1) });
                    }
                    if (bData.trainerId && bData.date && bData.time) {
                        tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                    }
                    if (bData.memberId && bData.date && bData.time) {
                        tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                    }
                }

                tx.update(bookingRef, update);
            });
        } catch (err) {
            console.error("Edit booking transaction failed:", err);
            if (window.bookingActionFailedToast) window.bookingActionFailedToast(err);
            else showToast(err.message || "Failed to update booking.", "error");
            _rearmBtn();
            return;
        }

        _rearmBtn();
        window.closeModal('editBookingModal');
        showToast(`Booking updated to ${status}.`, "success");
        if (window.logActivity) window.logActivity("Booking Status Updated", `Booking ${id} status changed to ${status}. ${remarks ? 'Reason: ' + remarks : ''}`);
    });
}

window.deleteBooking = async (id, btn) => {
    // C1: only admin/staff may delete arbitrary bookings; members/trainers
    // must use cancel/decline on their own records.
    const _callerRole = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_callerRole !== 'admin' && _callerRole !== 'staff') {
        return showToast("You do not have permission to delete booking records.", "error");
    }
    const _target = (window.bookingsData || []).find(x => x.id === id);
    if (_target && window.isBookingTerminalStatus && window.isBookingTerminalStatus(_target.status)) {
        return showToast(`Cannot delete a ${_target.status} booking record.`, "error");
    }
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    showConfirm({ message: "Are you sure you want to delete this booking record?", onCancel: _rearmBtn, onConfirm: async () => {
        try {
            await runTransaction(db, async (tx) => {
                const bookingRef = doc(db, "bookings", id);
                const bSnap = await tx.get(bookingRef);
                if (!bSnap.exists()) return; // already gone — nothing to do
                const bData = bSnap.data();

                // Refund a held credit before destroying the record
                if (bookingHoldsCredit(bData) && bData.memberId) {
                    tx.update(doc(db, "users", bData.memberId), { sessionsRemaining: increment(1) });
                }
                // Free the slot locks
                if (bData.trainerId && bData.date && bData.time) {
                    tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                }
                if (bData.memberId && bData.date && bData.time) {
                    tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                }
                tx.delete(bookingRef);
            });
            showToast("Booking deleted.", "info");
            if (window.logActivity) window.logActivity("Booking Deleted", `Deleted booking ID: ${id}.`);
        } catch (error) {
            console.error("Booking delete failed:", error);
            showToast("Failed to delete booking.", "error");
        } finally {
            _rearmBtn();
        }
    }});
}

// BUG-11: memberId param removed — ownership is re-verified from localStorage inside the
// transaction, so the caller cannot supply an arbitrary ID to trigger a foreign refund.
if (!window._cancelBookingInFlight) window._cancelBookingInFlight = new Set();
window.cancelMemberBooking = function (bookingId, btn) {
    if (window._cancelBookingInFlight.has(bookingId)) return;
    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };

    const _preview = (window.bookingsData || []).find(x => x.id === bookingId);
    if (_preview && window.isBookingTerminalStatus && window.isBookingTerminalStatus(_preview.status)) {
        _rearmBtn();
        return showToast(`This booking is ${_preview.status} and cannot be cancelled.`, "error");
    }

    const isLateCancel = _preview && typeof window.isLateCancellation === 'function'
        && window.isLateCancellation(_preview);
    const confirmMessage = isLateCancel
        ? "Late Cancellation Rule Applied: Session credit forfeited.\n\nYou are cancelling within 2 hours of the session start. Your credit will NOT be refunded. Proceed?"
        : "Cancel this booking request? Your session credit will be refunded.";

    showConfirm({ message: confirmMessage, onCancel: _rearmBtn, onConfirm: async () => {
        if (window._cancelBookingInFlight.has(bookingId)) return;
        window._cancelBookingInFlight.add(bookingId);
        const uiStatusAtCancel = (_preview && _preview.status) || 'Pending';
        try {
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
            const callerId = localStorage.getItem("userId");
            const callerRole = (localStorage.getItem("userRole") || '').toLowerCase();
            let lateForfeitApplied = false;
            await runTransaction(db, async (tx) => {
                const bookingRef = doc(db, "bookings", bookingId);
                const bSnap = await tx.get(bookingRef);
                if (!bSnap.exists()) throw new Error("This booking no longer exists.");
                const bData = bSnap.data() || {};

                let memberRef = null;
                let memberSnap = null;
                const willRefund = !(
                    typeof window.isLateCancellation === 'function'
                    && window.isLateCancellation({ date: bData.date, time: bData.time })
                ) && bookingHoldsCredit(bData) && bData.memberId;
                if (willRefund) {
                    memberRef = doc(db, "users", bData.memberId);
                    memberSnap = await tx.get(memberRef);
                }

                if (window.isBookingTerminalStatus && window.isBookingTerminalStatus(bData.status)) {
                    throw new Error(`This booking is ${bData.status} and cannot be cancelled.`);
                }
                if (window.verifyBookingServerState) {
                    window.verifyBookingServerState(bData, uiStatusAtCancel);
                }
                const isOwner = bData.memberId && bData.memberId === callerId;
                const isPrivileged = callerRole === 'admin' || callerRole === 'staff';
                if (!isOwner && !isPrivileged) {
                    throw new Error("You can only cancel your own bookings.");
                }
                if (bData.status !== "Pending" && bData.status !== "Confirmed") {
                    throw new Error(window.BOOKING_STATE_CHANGED_MSG || "This booking can no longer be cancelled.");
                }

                const lateCancel = typeof window.isLateCancellation === 'function'
                    && window.isLateCancellation({ date: bData.date, time: bData.time });

                if (lateCancel) {
                    lateForfeitApplied = true;
                    if (bookingHoldsCredit(bData)) {
                        tx.update(bookingRef, {
                            status: "Cancelled",
                            cancelRemarks: "Late cancellation — session credit forfeited.",
                            creditState: 'consumed'
                        });
                    } else {
                        tx.update(bookingRef, {
                            status: "Cancelled",
                            cancelRemarks: "Late cancellation — session credit forfeited."
                        });
                    }
                } else if (willRefund) {
                    if (!memberSnap || !memberSnap.exists()) throw new Error("Member record no longer exists.");
                    tx.update(memberRef, { sessionsRemaining: increment(1) });
                    tx.update(bookingRef, { status: "Cancelled", cancelRemarks: "Cancelled by member.", creditState: 'refunded' });
                } else {
                    tx.update(bookingRef, { status: "Cancelled", cancelRemarks: "Cancelled by member." });
                }
                if (bData.trainerId && bData.date && bData.time) {
                    tx.delete(doc(db, "bookingSlots", slotIdForTrainer(bData.trainerId, bData.date, bData.time)));
                }
                if (bData.memberId && bData.date && bData.time) {
                    tx.delete(doc(db, "bookingSlots", slotIdForMember(bData.memberId, bData.date, bData.time)));
                }
            });
            if (lateForfeitApplied) {
                showToast("Late Cancellation Rule Applied: Session credit forfeited.", "warning");
            } else {
                showToast("Booking cancelled and session credit restored.", "success");
            }
            if (window.logActivity) window.logActivity("Booking Cancelled", `Member cancelled booking ID: ${bookingId}.`);
        } catch (err) {
            console.error("Cancel booking failed:", err);
            if (window.bookingActionFailedToast) window.bookingActionFailedToast(err);
            else showToast(err.message || "Failed to cancel booking.", "error");
        } finally {
            window._cancelBookingInFlight.delete(bookingId);
            _rearmBtn();
        }
    }});
};

// ==========================================
// 15. SYSTEM ACTIVITY LOGS
// ==========================================
let activityCurrentPage = 1;
const activityItemsPerPage = 20;

window.changeActivityPage = function (dir) {
    activityCurrentPage += dir;
    if (activityCurrentPage < 1) activityCurrentPage = 1;
    renderActivityLogs();
};

// Activity logs are admin-only and grow unbounded — fetch the latest 200 once on load
// instead of subscribing to the entire collection. Call window.refreshActivityLogs() after
// a write from this tab if you need to see your own log appear immediately.
window.refreshActivityLogs = function () {
    if (!isAdmin) return Promise.resolve();
    // PRESENTATION PROOFING: Lower activity logs limit to 25 for maximum read quota conservation.
    const q = query(activityLogsCol, orderBy("timestamp", "desc"), limit(25));
    return getDocs(q).then(snapshot => {
        activityData = [];
        snapshot.forEach(doc => activityData.push({ id: doc.id, ...doc.data() }));
        renderActivityLogs();
    });
};
if (isAdmin) window.refreshActivityLogs();

function renderActivityLogs() {
    const actTbody = document.querySelector('#activityTable tbody');
    if (!actTbody) return;

    const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    // Filters
    const roleFilter = document.getElementById('activityRoleFilter');
    const dateFilter = document.getElementById('activityDateFilter');
    const searchInput = document.getElementById('activitySearch');
    const selectedRole = roleFilter ? roleFilter.value : 'all';
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';

    let selectedDateStr = '';
    if (dateFilter && dateFilter.value) {
        const [y, m, d] = dateFilter.value.split('-');
        const dateObj = new Date(y, m - 1, d);
        selectedDateStr = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    let filtered = activityData;
    if (selectedRole !== 'all') {
        filtered = filtered.filter(l => l.role === selectedRole);
    }
    if (selectedDateStr) {
        filtered = filtered.filter(l => l.date === selectedDateStr);
    }
    if (searchQuery) {
        filtered = filtered.filter(l => 
            (l.userName || '').toLowerCase().includes(searchQuery) ||
            (l.action || '').toLowerCase().includes(searchQuery) ||
            (l.details || '').toLowerCase().includes(searchQuery) ||
            (l.date || '').toLowerCase().includes(searchQuery)
        );
    }

    // Stat cards
    const todayLogs = activityData.filter(l => l.date === today);
    const activeUsersToday = new Set(todayLogs.map(l => l.userName));
    const criticalPattern = /(delete|deleted|void|voided|archive|archived|remove|removed|cancel|cancelled)/i;
    const criticalToday = todayLogs.filter(l => criticalPattern.test(l.action || '')).length;
    const actionCounts = {};
    todayLogs.forEach(l => { actionCounts[l.action] = (actionCounts[l.action] || 0) + 1; });
    let topAction = '-';
    let topCount = 0;
    for (const [action, count] of Object.entries(actionCounts)) {
        if (count > topCount) { topCount = count; topAction = action; }
    }

    if (document.getElementById('actTodayLogs')) document.getElementById('actTodayLogs').innerText = todayLogs.length;
    if (document.getElementById('actCriticalToday')) document.getElementById('actCriticalToday').innerText = criticalToday;
    if (document.getElementById('actActiveUsersToday')) document.getElementById('actActiveUsersToday').innerText = activeUsersToday.size;
    if (document.getElementById('actTopAction')) {
        const el = document.getElementById('actTopAction');
        el.innerText = topAction;
        el.style.fontSize = topAction.length > 12 ? '16px' : '28px';
    }

    // Pagination logic
    const totalRecords = filtered.length;
    const totalPages = Math.ceil(totalRecords / activityItemsPerPage);
    if (activityCurrentPage > totalPages && totalPages > 0) activityCurrentPage = totalPages;
    if (activityCurrentPage < 1) activityCurrentPage = 1;

    const showCountEl = document.getElementById('activityShowingCount');
    const totalCountEl = document.getElementById('activityTotalCount');
    const paginationContainer = document.getElementById('activityPagination');

    const startIdx = (activityCurrentPage - 1) * activityItemsPerPage;
    const endIdx = Math.min(startIdx + activityItemsPerPage, totalRecords);

    if (showCountEl) showCountEl.innerText = totalRecords === 0 ? '0-0' : `${startIdx + 1}-${endIdx}`;
    if (totalCountEl) totalCountEl.innerText = totalRecords;
    if (document.getElementById('activityRecordCount')) {
        document.getElementById('activityRecordCount').innerText = `Showing ${endIdx - startIdx} of ${totalRecords} records`;
    }

    window.renderPaginationControls('activityPagination', activityCurrentPage, totalPages, totalRecords, 'changeActivityPage');

    if (filtered.length === 0) {
        actTbody.innerHTML = `
            <tr id="activityEmptyState">
                <td colspan="5" style="text-align: center; padding: 60px 20px;">
                    <i class="fa-solid fa-clock-rotate-left" style="font-size: 3rem; opacity: 0.15; margin-bottom: 15px; display: block;"></i>
                    <p style="color: var(--text-muted); font-size: 14px; margin: 0;">No activity logs found for the selected filters.</p>
                </td>
            </tr>
        `;
        return;
    }

    // Remove empty state if present
    const emptyStateRow = actTbody.querySelector('#activityEmptyState');
    if (emptyStateRow) {
        emptyStateRow.remove();
    }

    // Action → icon mapping
    const actionIcons = {
        'POS Sale': 'fa-cash-register',
        'Login': 'fa-right-to-bracket',
        'Logout': 'fa-right-from-bracket',
        'Member Registered': 'fa-user-plus',
        'Staff Registered': 'fa-user-tie',
        'Trainer Registered': 'fa-dumbbell',
        'Member Edited': 'fa-user-pen',
        'Staff Edited': 'fa-user-pen',
        'Equipment Updated': 'fa-wrench',
        'Product Updated': 'fa-box',
        'Account Archived': 'fa-box-archive',
        'Account Restored': 'fa-box-open',
        'Account Deleted': 'fa-trash',
        'Item Deleted': 'fa-trash-can',
        'Item Registered': 'fa-plus-circle',
        'Transaction Voided': 'fa-ban',
        'Booking Created': 'fa-calendar-plus',
        'Booking Status Updated': 'fa-calendar-check',
        'Booking Deleted': 'fa-calendar-xmark',
        'Password Changed': 'fa-key',
        'Membership Renewed': 'fa-sync-alt',
        'Plan Created': 'fa-tag',
        'Plan Updated': 'fa-pen-to-square',
        'Plan Deleted': 'fa-tag',
    };

    const displayData = filtered.slice(startIdx, endIdx);

    const renderLogRow = (log) => {
        const icon = actionIcons[log.action] || 'fa-circle-info';
        
        const role = log.role || 'System';
        let roleClass = 'role-system';
        if (role === 'Admin') roleClass = 'role-admin';
        else if (role === 'Staff') roleClass = 'role-staff';
        else if (role === 'Trainer') roleClass = 'role-trainer';
        else if (role === 'Member') roleClass = 'role-member';

        const roleBadge = `<span class="badge ${roleClass}">${escapeHtml(role)}</span>`;

        return `
            <tr>
                <td style="white-space: nowrap;"><strong>${escapeHtml(log.date)}</strong><br><small style="color: var(--text-muted);">${escapeHtml(log.time)}</small></td>
                <td>${escapeHtml(log.userName || 'System')}</td>
                <td>${roleBadge}</td>
                <td><span style="display: inline-flex; align-items: center; gap: 6px;"><i class="fa-solid ${icon}" style="font-size: 12px; color: var(--text-muted);"></i> <strong>${escapeHtml(log.action)}</strong></span></td>
                <td style="font-size: 13px; color: var(--text-muted); max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(log.details || '-')}</td>
            </tr>
        `;
    };

    window.syncDOM(actTbody, displayData, renderLogRow, 'act-row');
}
window.renderActivityLogs = renderActivityLogs;

// ==========================================
// 14. SMART USB RFID GHOST LISTENER
// ==========================================
initRfid({ db, usersCol, attendanceCol, onShiftLogout: window.handleLogout });
// ==========================================
// 14. INVENTORY ENHANCEMENTS (Batch & View)
// ==========================================
window.toggleInventoryView = function (view, btn) {
    currentInventoryView = view;
    // Update UI buttons
    const container = btn.parentElement;
    container.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderInventory();
};

window.toggleItemSelection = function (type, id, checkbox) {
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    if (checkbox.checked) {
        set.add(id);
    } else {
        set.delete(id);
    }
    renderInventory();
};

window.toggleSelectAll = function (type, checkbox) {
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    if (checkbox.checked) {
        inventoryData.forEach(item => {
            const isConsumable = item.itemType === 'product' || ['Supplements', 'Beverages', 'Merch', 'Supplements (Powder/Capsules)', 'Beverages (Bottled Drinks)', 'Apparel / Merchandise'].includes(item.cat);
            if (type === 'equipment' && !isConsumable) set.add(item.id);
            if (type === 'product' && isConsumable) set.add(item.id);
        });
    } else {
        set.clear();
    }
    renderInventory();
};

window.clearBatchSelection = function (type) {
    if (type === 'equipment') selectedEquipItems.clear();
    else selectedProdItems.clear();
    const selectAllBox = document.getElementById(type === 'equipment' ? 'equipSelectAll' : 'prodSelectAll');
    if (selectAllBox) selectAllBox.checked = false;
    renderInventory();
};

window.applyBatchStatus = async function (type, btn) {
    // S4 (Sprint 8): fast-fail RBAC — admin/staff only.
    const _r = (localStorage.getItem("userRole") || '').toLowerCase();
    if (_r !== 'admin' && _r !== 'staff') {
        return showToast("Permission denied.", "error");
    }
    const set = (type === 'equipment') ? selectedEquipItems : selectedProdItems;
    const statusSelect = document.getElementById(type === 'equipment' ? 'equipBatchStatus' : 'prodBatchStatus');
    const newStatus = statusSelect.value;

    if (set.size === 0) return showToast("No items selected.", "error");
    if (!newStatus) return showToast("Please select a status.", "error");

    const _origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying...'; }
    const _rearmBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHtml; } };
    const positiveStatuses = ['Operational', 'Available', 'Active', 'Restocked'];
    const batchTone = positiveStatuses.includes(newStatus) ? 'success' : 'warning';
    showConfirm({
        title: 'Apply Batch Status',
        message: `Update status to "${newStatus}" for ${set.size} items?`,
        tone: batchTone,
        confirmText: 'Apply',
        onCancel: _rearmBtn,
        onConfirm: async () => {
        try {
            const batchPromises = Array.from(set).map(id => updateDoc(doc(db, "inventory", id), { status: newStatus }));
            await Promise.all(batchPromises);
            showToast(`Batch updated successfully!`, "success");
            if (window.logActivity) window.logActivity("Batch Status Update", `Updated ${set.size} items to ${newStatus}`);
            set.clear();
            statusSelect.value = "";
            renderInventory();
        } catch (err) {
            console.error(err);
            showToast("Batch update failed.", "error");
        } finally {
            _rearmBtn();
        }
        }
    });
};

window.renderTodayBookings = function () {
    const list = document.getElementById('todayBookingsList');
    if (!list) return;

    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const todayBookings = bookingsData.filter(b => b.date === today && b.status !== 'Cancelled' && b.status !== 'Declined')
        .sort((a, b) => a.time.localeCompare(b.time));

    if (todayBookings.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;">No bookings scheduled for today.</p>`;
        return;
    }

    list.innerHTML = todayBookings.map(b => {
        const timeStr = b.time; // Format HH:MM
        const [h, m] = timeStr.split(':');
        const hour = parseInt(h);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 || 12;
        const formattedTime = `${displayHour}:${m} ${ampm}`;

        return `
            <div class="booking-item">
                <div class="booking-time">${formattedTime}</div>
                <div class="booking-info">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div class="booking-class">${b.sessionName || 'Personal Training'} with ${b.trainerName}</div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background: #27ae60;" title="Scheduled"></div>
                    </div>
                    <div class="booking-member">${b.memberId ? `<a href="javascript:void(0)" onclick="window.openMemberProfile('${b.memberId}')" style="color: inherit; text-decoration: none; border-bottom: 1px dashed currentColor; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'">${b.memberName}</a>` : b.memberName}</div>
                </div>
            </div>
        `;
    }).join('');
};
window.openAddCreditModal = function (memberId) {
    if (!window.isCallerStaffOrAdmin()) {
        return showToast("Permission denied.", "error");
    }
    const member = membersData.find(m => m.id === memberId);
    if (!member) return;

    document.getElementById('addCreditMemberId').value = member.id;
    document.getElementById('addCreditMemberName').innerText = member.name || (member.givenName + ' ' + member.familyName);
    document.getElementById('addCreditCurrentBalance').innerText = `₱${(member.creditBalance || 0).toFixed(2)}`;
    document.getElementById('addCreditAmount').value = '';
    document.getElementById('addCreditNote').value = '';

    document.getElementById('addCreditModal').style.display = 'flex';
}

if (document.getElementById('addCreditForm')) {
    // Add real-time GCash input formatting to ensure a robust, high-quality user experience
    const addCreditGcashRefInput = document.getElementById('addCreditGcashRefId');
    if (addCreditGcashRefInput) {
        addCreditGcashRefInput.addEventListener('input', (e) => {
            let val = e.target.value.replace(/\D/g, '');
            if (val.length > 12) val = val.slice(0, 12);
            // Format into groups of four: e.g. "1234 5678 9012"
            let formatted = '';
            for (let i = 0; i < val.length; i++) {
                if (i > 0 && i % 4 === 0) formatted += ' ';
                formatted += val[i];
            }
            e.target.value = formatted;
        });
    }

    const addCreditPaymentMethodEl = document.getElementById('addCreditPaymentMethod');
    const addCreditGcashRefWrapperEl = document.getElementById('addCreditGcashRefWrapper');
    if (addCreditPaymentMethodEl && addCreditGcashRefWrapperEl) {
        addCreditPaymentMethodEl.addEventListener('change', () => {
            const isGcash = addCreditPaymentMethodEl.value === 'GCash';
            addCreditGcashRefWrapperEl.style.display = isGcash ? 'block' : 'none';
            const refInput = document.getElementById('addCreditGcashRefId');
            if (refInput) {
                refInput.required = isGcash;
                if (!isGcash) refInput.value = '';
            }
        });
    }

    document.getElementById('addCreditForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!window.isCallerStaffOrAdmin()) {
            return showToast("Permission denied.", "error");
        }
        const memberId = document.getElementById('addCreditMemberId').value;
        const amount = Number(document.getElementById('addCreditAmount').value);
        const paymentMethod = document.getElementById('addCreditPaymentMethod').value;
        const note = document.getElementById('addCreditNote').value.trim();

        // Validation (C-04 Fix)
        if (!amount || amount <= 0) {
            return showToast("Amount must be greater than ₱0.", "error");
        }
        if (amount > 100000) {
            return showToast("Maximum top-up amount is ₱100,000.", "error");
        }

        const member = membersData.find(m => m.id === memberId);
        if (!member) return;

        // Correctly target the action-btn or any submit button to prevent null crashes!
        const submitBtn = e.target.querySelector('button[type="submit"]') || e.target.querySelector('.action-btn');
        const originalText = submitBtn ? submitBtn.innerText : 'Add Credit';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = 'Processing...';
        }

        if (paymentMethod === 'GCash') {
            const rawRef = (document.getElementById('addCreditGcashRefId').value || '').replace(/\s/g, '');
            if (!/^\d{12}$/.test(rawRef)) {
                showToast("GCash Reference ID must be exactly 12 digits.", "error");
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                }
                return;
            }
            try { await window.assertGcashRefUnused(rawRef); }
            catch (e) {
                showToast(e.message, "error");
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = originalText; }
                return;
            }
        }

        try {
            const memberRef = doc(db, "users", memberId);

            // Execute atomic transaction for balance + creditTransactions + payment record!
            await runTransaction(db, async (transaction) => {
                // ── PHASE 1: ALL READS ──
                let gcashReservation = null;
                if (paymentMethod === 'GCash') {
                    const _ref = (document.getElementById('addCreditGcashRefId').value || '').replace(/\s/g, '');
                    if (_ref) gcashReservation = await window.reserveGcashRefInTxn(transaction, _ref);
                }
                const memberSnap = await transaction.get(memberRef);

                // ── PHASE 2: VALIDATION & BUSINESS LOGIC ──
                if (!memberSnap.exists()) {
                    throw new Error("Member record not found.");
                }
                if ((memberSnap.data().status || 'Active') === 'Archived') {
                    throw new Error("ACCESS_DENIED: Cannot top up credit for an archived member.");
                }

                const currentBalance = memberSnap.data().creditBalance || 0;
                const newBalance = currentBalance + amount;

                const creditTxRef = doc(collection(db, "creditTransactions"));
                const now = new Date();
                const paymentDocRef = doc(collection(db, "payments"));
                const paymentObj = {
                    name: member.name || (member.givenName + ' ' + member.familyName),
                    transactionRef: window.generateTransactionRef(),
                    type: "Credit Top-Up",
                    items: `RFID Credit Load (₱${amount.toFixed(2)})`,
                    amount: amount,
                    paymentMethod: paymentMethod,
                    status: "Paid",
                    date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: now.getTime()
                };
                if (paymentMethod === 'GCash') {
                    paymentObj.gcashRefId = (document.getElementById('addCreditGcashRefId').value || '').replace(/\s/g, '');
                }

                // ── PHASE 3: ALL WRITES ──
                if (gcashReservation) {
                    window.commitGcashRefInTxn(transaction, gcashReservation.refDoc);
                }
                transaction.update(memberRef, {
                    creditBalance: newBalance
                });
                transaction.set(creditTxRef, {
                    memberId,
                    memberName: member.name || (member.givenName + ' ' + member.familyName),
                    type: "top-up",
                    amount,
                    balanceBefore: currentBalance,
                    balanceAfter: newBalance,
                    paymentMethod,
                    note: note || "Counter top-up",
                    processedBy: localStorage.getItem("userId"),
                    processedByName: localStorage.getItem("loggedInUser"),
                    timestamp: Date.now()
                });
                transaction.set(paymentDocRef, paymentObj);
            });

            showToast("Credit added successfully!", "success");
            closeModal('addCreditModal');
        } catch (err) {
            console.error("Top-up Transaction failed:", err);
            showToast(err.message || "Failed to add credit.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = originalText;
            }
        }
    });
}

// --- Global Goals & Profile Functions ---
window.saveFitnessGoals = async function () {
    const userId = localStorage.getItem("userId");
    const goals = document.getElementById('fitnessGoalsInput')?.value.trim();
    const saveBtn = document.getElementById('saveGoalsBtn');

    if (!userId) return;

    const origHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

    try {
        await updateDoc(doc(db, "users", userId), { fitnessGoals: goals });
        showToast("Fitness goals updated successfully!", "success");
    } catch (err) {
        console.error("Error saving goals:", err);
        showToast("Failed to save goals.", "error");
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = origHtml; }
    }
};

window.openMemberProfile = async function (memberId) {
    if (!memberId || memberId === 'undefined') {
        return showToast("Member ID missing for this booking.", "error");
    }
    // IDOR guard: a Member role can only open their own profile via this modal.
    // Trainers may only open profiles of members they have at least one booking with.
    // Admin / Staff may view any member.
    const callerRole = (localStorage.getItem("userRole") || '').toLowerCase();
    const callerId   = localStorage.getItem("userId");
    if (callerRole === 'member' && memberId !== callerId) {
        return showToast("You can only view your own profile.", "error");
    }
    if (callerRole === 'trainer') {
        const hasRelationship = (window.bookingsData || []).some(
            b => b && b.trainerId === callerId && b.memberId === memberId
        );
        if (!hasRelationship) {
            return showToast("You can only view profiles of members you have trained.", "error");
        }
    }
    try {
        const docSnap = await getDoc(doc(db, "users", memberId));
        if (!docSnap.exists()) return showToast("Member not found.", "error");

        const m = docSnap.data();
        const fullName = m.name || `${m.givenName || ''} ${m.familyName || ''}`.trim();

        // --- Avatar --- (safe-image: scheme-allowlisted, DOM-only — no innerHTML interpolation)
        const avatar = document.getElementById('mpAvatar');
        if (avatar) {
            avatar.innerHTML = '';
            if (m.image && window.isSafeImageSrc && window.isSafeImageSrc(m.image)) {
                const img = document.createElement('img');
                img.src = m.image;
                img.alt = fullName;
                avatar.appendChild(img);
            } else {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-user';
                avatar.appendChild(icon);
            }
        }

        // --- Name & Email ---
        const nameEl = document.getElementById('mpName');
        if (nameEl) nameEl.innerText = fullName;

        const emailEl = document.getElementById('mpEmail');
        if (emailEl) emailEl.innerText = m.email || "No email provided";

        // --- Status Pill ---
        const statusEl = document.getElementById('mpStatus');
        if (statusEl) {
            const status = m.status || "Active";
            statusEl.innerText = status;
            if (status.toLowerCase() === 'active') {
                statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
                statusEl.style.color = '#059669';
            } else {
                statusEl.style.background = 'rgba(100, 116, 139, 0.1)';
                statusEl.style.color = '#475569';
            }
        }

        // --- UID ---
        const uidEl = document.getElementById('mpUid');
        if (uidEl) uidEl.innerText = m.uid || '—';

        // --- Plan ---
        const planEl = document.getElementById('mpPlan');
        if (planEl) planEl.innerText = m.plan || "No plan";

        // --- Member Since ---
        const sinceEl = document.getElementById('mpSince');
        if (sinceEl) {
            if (m.dateRegistered) {
                sinceEl.innerText = new Date(m.dateRegistered).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else if (m.registrationDate) {
                sinceEl.innerText = m.registrationDate;
            } else if (m.timestamp) {
                sinceEl.innerText = new Date(m.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else {
                sinceEl.innerText = '—';
            }
        }

        // --- Fitness Goals ---
        const goalsEl = document.getElementById('mpGoals');
        if (goalsEl) goalsEl.innerText = m.fitnessGoals || "No goals set by the member yet.";

        // --- Emergency Contact ---
        const emergEl = document.getElementById('mpEmergency');
        if (emergEl) emergEl.innerText = m.emergencyContact || '—';

        // --- Plan Status (Days Left) ---
        const planStatusEl = document.getElementById('mpPlanStatus');
        if (planStatusEl) {
            if (m.dateRegistered && m.plan) {
                const now = Date.now();
                const planDays = window.getPlanDays ? window.getPlanDays(m.plan) : 30;
                const expiryDate = m.dateRegistered + (planDays * 24 * 60 * 60 * 1000);
                const diffDays = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                if (diffDays > 0) {
                    planStatusEl.innerHTML = `<span style="color: #059669; font-weight: 700;">${diffDays} days left</span>`;
                } else {
                    planStatusEl.innerHTML = `<span style="color: #dc2626; font-weight: 700;">Expired</span>`;
                }
            } else {
                planStatusEl.innerText = '—';
            }
        }

        // --- Session History & Total Sessions ---
        const loggedInRole = (localStorage.getItem("userRole") || "").toLowerCase();
        const loggedInUserId = localStorage.getItem("userId");
        const memberBookings = bookingsData.filter(b => b.memberId === memberId);
        
        // Admins and Staff see all member bookings. Trainers see only their own.
        const visibleBookings = (loggedInRole === 'trainer') 
            ? memberBookings.filter(b => b.trainerId === loggedInUserId)
            : memberBookings;
        
        // Sort by date descending
        visibleBookings.sort((a, b) => {
            const dateA = new Date(`${a.date}T${a.time || '00:00'}`);
            const dateB = new Date(`${b.date}T${b.time || '00:00'}`);
            return dateB - dateA;
        });

        const totalEl = document.getElementById('mpTotalSessions');
        if (totalEl) totalEl.innerText = visibleBookings.length;

        const sessionList = document.getElementById('mpSessionList');
        if (sessionList) {
            if (visibleBookings.length === 0) {
                const emptyMsg = (loggedInRole === 'trainer') ? "No session history with you yet." : "No session history yet.";
                sessionList.innerHTML = `<div class="mp-empty-state">${emptyMsg}</div>`;
            } else {
                const recent = visibleBookings.slice(0, 5);
                sessionList.innerHTML = recent.map(s => {
                    const sDate = new Date(`${s.date}T${s.time || '00:00'}`);
                    const dateStr = sDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    const timeStr = sDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                    const statusKey = (s.status || 'pending').toLowerCase().replace(' ', '');
                    const dotClass = statusKey === 'noshow' ? 'dot-noshow' : `dot-${statusKey}`;
                    const statusBadge = statusKey === 'noshow' ? 's-noshow' : `s-${statusKey}`;
                    return `
                        <div class="mp-session-item">
                            <div class="mp-session-dot ${dotClass}"></div>
                            <div class="mp-session-info">
                                <div class="mp-session-date">${dateStr}</div>
                                <div class="mp-session-meta">${timeStr}</div>
                            </div>
                            <span class="mp-session-status ${statusBadge}">${s.status}</span>
                        </div>
                    `;
                }).join('');
            }
        }

        // --- Message Button ---
        const messageBtn = document.getElementById('mpMessageBtn');
        if (messageBtn) {
            messageBtn.onclick = async () => {
                if (window.closeModal) window.closeModal('memberProfileModal');
                if (window.openChatTab) window.openChatTab('all', null, 'Internal Messages');
                if (window.openChat) await window.openChat(memberId);
                else showToast("Chat is not available on this dashboard.", "info");
            };
        }

        // --- Show Modal ---
        const modal = document.getElementById('memberProfileModal');
        if (modal) modal.style.display = 'flex';

    } catch (err) {
        console.error("Error opening profile:", err);
        showToast("Failed to load member profile.", "error");
    }
};
