// js/utils.js — Shared utilities for XFitTrack
// Extracted from script.js to promote modularity (Audit Fix 3.1 / 3.2 / 3.4)

/**
 * Escapes HTML special characters to prevent XSS when injecting user data
 * into innerHTML templates. Use this on every dynamic string.
 */
export function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

/**
 * Formats a number as Philippine Peso currency string.
 */
export function formatCurrency(amount) {
    return `₱${Number(amount || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}
