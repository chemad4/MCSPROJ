// js/inventory-checkout.js — Batch-aware FEFO (First-Expiry-First-Out) checkout pipeline
// Firestore data model expected:
//   inventory/{productId}                   — product document
//   inventory/{productId}/batches/{batchId} — batch subcollection
//     Fields: expiryDate (string "YYYY-MM-DD"), currentQuantity (number), ...

import {
    collection,
    getDocs,
    doc,
    runTransaction,
    increment,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const EXPIRY_WARNING_DAYS = 7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns today's date as a "YYYY-MM-DD" string using the server-synced clock
 * when available (window.serverTimeOffsetMs set by script.js), otherwise local.
 */
function todayString() {
    const now = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
    return now.toISOString().slice(0, 10);
}

/**
 * Returns a "YYYY-MM-DD" string for (today + days).
 */
function dateOffsetString(days) {
    const now = new Date(Date.now() + (window.serverTimeOffsetMs || 0));
    now.setDate(now.getDate() + days);
    return now.toISOString().slice(0, 10);
}

// ─── Core checkout function ───────────────────────────────────────────────────

/**
 * Executes a FEFO batch deduction inside a Firestore transaction.
 *
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} productId  - The Firestore document ID of the product.
 * @param {number} requested  - Number of units the customer wants to purchase.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   deductions: Array<{batchId: string, expiryDate: string, deducted: number}>,
 *   expiryWarning: boolean,
 *   warningBatch: object|null,
 *   message: string
 * }>}
 */
export async function checkoutBatches(db, productId, requested) {
    // Strict integer normalization prevents string-collision issues in downstream math.
    const requestedQty = parseInt(requested, 10) || 0;
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
        throw new Error("requested quantity must be a positive integer");
    }

    const today = todayString();
    const warningThreshold = dateOffsetString(EXPIRY_WARNING_DAYS);

    // Read all batches and filter/sort client-side — no composite Firestore index needed.
    const batchesRef = collection(db, "inventory", productId, "batches");
    const snapshot = await fetchValidBatches(batchesRef, today);

    if (snapshot.empty) {
        return {
            success: false,
            deductions: [],
            expiryWarning: false,
            warningBatch: null,
            currentStock: 0,
            message: "No valid stock batches available for this product.",
        };
    }

    // Build an ordered list of { ref, data } to feed into the transaction.
    const batches = snapshot.docs.map(d => ({
        ref: doc(db, "inventory", productId, "batches", d.id),
        id: d.id,
        expiryDate: d.data().expiryDate,
        currentQuantity: parseInt(d.data().currentQuantity, 10) || 0,
    }));

    // ── Step 4: Expiry-warning check (done outside the transaction; read-only) ──
    const earliestBatch = batches[0];
    const expiryWarning = earliestBatch.expiryDate <= warningThreshold;
    const warningBatch = expiryWarning
        ? { batchId: earliestBatch.id, expiryDate: earliestBatch.expiryDate, currentQuantity: earliestBatch.currentQuantity }
        : null;

    // Pre-flight: ensure there is enough total stock before entering the transaction
    const totalAvailable = batches.reduce((sum, b) => sum + (parseInt(b.currentQuantity, 10) || 0), 0);
    if (totalAvailable < requestedQty) {
        return {
            success: false,
            deductions: [],
            expiryWarning,
            warningBatch,
            currentStock: totalAvailable,
            message: `Insufficient stock. Requested ${requestedQty}, available ${totalAvailable}.`,
        };
    }

    // ── Step 5: Wrap cascading deduction inside a Firestore transaction ─────────
    // runTransaction retries automatically on contention; all reads inside must
    // precede all writes (Firestore transaction ordering requirement).
    const deductions = [];

    await runTransaction(db, async (txn) => {
        deductions.length = 0; // reset on retry
        const invRef = doc(db, "inventory", productId);
        const invSnap = await txn.get(invRef);
        if (!invSnap.exists()) {
            throw new Error("Product no longer exists in inventory.");
        }
        const invData = invSnap.data() || {};
        const qtyRaw = invData.qty ?? 0;
        const totalRaw = invData.totalStock ?? qtyRaw;
        const stockRaw = invData.stock ?? qtyRaw;
        const currentRaw = invData.currentStock ?? qtyRaw;

        // Re-read every batch document inside the transaction to get consistent,
        // lock-held snapshots — prevents TOCTOU races on concurrent checkouts.
        const txnSnapshots = await Promise.all(
            batches.map(b => txn.get(b.ref))
        );

        let remaining = requestedQty;

        for (let i = 0; i < txnSnapshots.length; i++) {
            if (remaining <= 0) break;

            const snap = txnSnapshots[i];
            if (!snap.exists()) continue;

            const liveQty = parseInt(snap.data().currentQuantity, 10) || 0;
            const liveExpiry = snap.data().expiryDate;

            // Re-apply filters inside the transaction against live data (Step 2).
            // A batch could have been drained or expired between the outer query
            // and the transaction lock being acquired.
            if (liveExpiry <= today || liveQty <= 0) continue;

            // ── Step 3: Cascading deduction ────────────────────────────────────
            const deduct = Math.min(liveQty, remaining);
            const newQty = liveQty - deduct;

            txn.update(batches[i].ref, { currentQuantity: newQty });

            deductions.push({
                batchId: batches[i].id,
                expiryDate: liveExpiry,
                deducted: deduct,
                remainingAfter: newQty,
            });

            remaining -= deduct;
        }

        // Safety check: if live quantities shrank and we can no longer fulfil
        // the order, abort the transaction by throwing — Firestore rolls back.
        if (remaining > 0) {
            throw new Error(
                `Stock depleted mid-transaction. Could not deduct ${remaining} more unit(s).`
            );
        }

        // Normalize aggregate fields when legacy writes stored numbers as strings.
        const qty = parseInt(qtyRaw, 10) || 0;
        const total = parseInt(totalRaw, 10) || 0;
        const stock = parseInt(stockRaw, 10) || 0;
        const current = parseInt(currentRaw, 10) || 0;
        const numericSeed = {};
        if (!(typeof qtyRaw === "number" && Number.isFinite(qtyRaw))) numericSeed.qty = qty;
        if (!(typeof totalRaw === "number" && Number.isFinite(totalRaw))) numericSeed.totalStock = total;
        if (!(typeof stockRaw === "number" && Number.isFinite(stockRaw))) numericSeed.stock = stock;
        if (!(typeof currentRaw === "number" && Number.isFinite(currentRaw))) numericSeed.currentStock = current;
        if (Object.keys(numericSeed).length) txn.update(invRef, numericSeed);

        // Keep root aggregate stock synchronized with FEFO batch decrements.
        txn.update(invRef, {
            qty: increment(-requestedQty),
            totalStock: increment(-requestedQty),
            stock: increment(-requestedQty),
            currentStock: increment(-requestedQty),
        });
    });

    return {
        success: true,
        deductions,
        expiryWarning,
        warningBatch,
        message: `Successfully deducted ${requestedQty} unit(s) across ${deductions.length} batch(es).`,
    };
}

/** Load batches subcollection; filter expired/empty and sort FEFO in memory. */
async function fetchValidBatches(batchesRef, today) {
    const snap = await getDocs(batchesRef);
    const filtered = snap.docs
        .map(d => ({ ref: d.ref, id: d.id, data: d.data() }))
        .filter(({ data }) => {
            const exp = data.expiryDate || "";
            const qty = parseInt(data.currentQuantity, 10) || 0;
            return exp > today && qty > 0;
        })
        .sort((a, b) => String(a.data.expiryDate).localeCompare(String(b.data.expiryDate)));

    return {
        empty: filtered.length === 0,
        docs: filtered.map(({ ref, id, data }) => ({
            id,
            ref,
            data: () => data,
            exists: () => true,
        })),
    };
}

/**
 * Reverse batch deductions (POS rollback on payment failure, or void/refund restock).
 */
export async function restoreBatchDeductions(db, productId, deductions) {
    if (!Array.isArray(deductions) || deductions.length === 0) return;

    await runTransaction(db, async (txn) => {
        const invRef = doc(db, "inventory", productId);
        const invSnap = await txn.get(invRef);

        const batchSnaps = await Promise.all(
            deductions.map(d =>
                txn.get(doc(db, "inventory", productId, "batches", d.batchId))
            )
        );

        let totalRestored = 0;
        for (let i = 0; i < deductions.length; i++) {
            const { batchId, deducted } = deductions[i];
            const snap = batchSnaps[i];
            if (!snap.exists()) {
                console.warn(`[restoreBatchDeductions] Batch ${batchId} missing for product ${productId}`);
                continue;
            }
            const liveQty = parseInt(snap.data().currentQuantity, 10) || 0;
            const delta = parseInt(deducted, 10) || 0;
            txn.update(doc(db, "inventory", productId, "batches", batchId), {
                currentQuantity: liveQty + delta,
            });
            totalRestored += delta;
        }

        if (invSnap.exists() && totalRestored > 0) {
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
            if (!(typeof qtyRaw === "number" && Number.isFinite(qtyRaw))) numericSeed.qty = qty;
            if (!(typeof totalRaw === "number" && Number.isFinite(totalRaw))) numericSeed.totalStock = total;
            if (!(typeof stockRaw === "number" && Number.isFinite(stockRaw))) numericSeed.stock = stock;
            if (!(typeof currentRaw === "number" && Number.isFinite(currentRaw))) numericSeed.currentStock = current;
            if (Object.keys(numericSeed).length) txn.update(invRef, numericSeed);

            txn.update(invRef, {
                qty: increment(totalRestored),
                totalStock: increment(totalRestored),
                stock: increment(totalRestored),
                currentStock: increment(totalRestored),
            });
        }
    });
}
