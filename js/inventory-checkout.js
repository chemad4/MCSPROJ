// js/inventory-checkout.js — Batch-aware FEFO (First-Expiry-First-Out) checkout pipeline
// Firestore data model expected:
//   products/{productId}                   — product document
//   products/{productId}/batches/{batchId} — batch subcollection
//     Fields: expiryDate (string "YYYY-MM-DD"), currentQuantity (number), ...

import {
    getFirestore,
    collection,
    query,
    where,
    orderBy,
    getDocs,
    doc,
    runTransaction,
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
    if (!Number.isInteger(requested) || requested <= 0) {
        throw new Error("requested quantity must be a positive integer");
    }

    const today = todayString();
    const warningThreshold = dateOffsetString(EXPIRY_WARNING_DAYS);

    // ── Step 1: Query valid batches sorted by expiryDate ASC (FEFO order) ──────
    // Firestore compound query: expiryDate > today AND currentQuantity > 0.
    // The `where('currentQuantity', '>', 0)` filter requires a composite index on
    // (expiryDate ASC, currentQuantity) — create it in the Firebase console or
    // deploy via firestore.indexes.json if the query throws an index error.
    const batchesRef = collection(db, "products", productId, "batches");
    const batchQuery = query(
        batchesRef,
        where("expiryDate", ">", today),       // Step 2: exclude expired batches
        where("currentQuantity", ">", 0),       // Step 2: exclude empty batches
        orderBy("expiryDate", "asc")            // Step 1: oldest expiry first
    );

    const snapshot = await getDocs(batchQuery);

    if (snapshot.empty) {
        return {
            success: false,
            deductions: [],
            expiryWarning: false,
            warningBatch: null,
            message: "No valid stock batches available for this product.",
        };
    }

    // Build an ordered list of { ref, data } to feed into the transaction.
    const batches = snapshot.docs.map(d => ({
        ref: doc(db, "products", productId, "batches", d.id),
        id: d.id,
        expiryDate: d.data().expiryDate,
        currentQuantity: d.data().currentQuantity,
    }));

    // ── Step 4: Expiry-warning check (done outside the transaction; read-only) ──
    const earliestBatch = batches[0];
    const expiryWarning = earliestBatch.expiryDate <= warningThreshold;
    const warningBatch = expiryWarning
        ? { batchId: earliestBatch.id, expiryDate: earliestBatch.expiryDate, currentQuantity: earliestBatch.currentQuantity }
        : null;

    // Pre-flight: ensure there is enough total stock before entering the transaction
    const totalAvailable = batches.reduce((sum, b) => sum + b.currentQuantity, 0);
    if (totalAvailable < requested) {
        return {
            success: false,
            deductions: [],
            expiryWarning,
            warningBatch,
            message: `Insufficient stock. Requested ${requested}, available ${totalAvailable}.`,
        };
    }

    // ── Step 5: Wrap cascading deduction inside a Firestore transaction ─────────
    // runTransaction retries automatically on contention; all reads inside must
    // precede all writes (Firestore transaction ordering requirement).
    const deductions = [];

    await runTransaction(db, async (txn) => {
        deductions.length = 0; // reset on retry

        // Re-read every batch document inside the transaction to get consistent,
        // lock-held snapshots — prevents TOCTOU races on concurrent checkouts.
        const txnSnapshots = await Promise.all(
            batches.map(b => txn.get(b.ref))
        );

        let remaining = requested;

        for (let i = 0; i < txnSnapshots.length; i++) {
            if (remaining <= 0) break;

            const snap = txnSnapshots[i];
            if (!snap.exists()) continue;

            const liveQty = snap.data().currentQuantity;
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
    });

    return {
        success: true,
        deductions,
        expiryWarning,
        warningBatch,
        message: `Successfully deducted ${requested} unit(s) across ${deductions.length} batch(es).`,
    };
}
