export function getBaseSpendingForAge(currentAge, defaultSpending, schedule) {
    if (!Array.isArray(schedule) || schedule.length === 0) return defaultSpending;
    const row = schedule.find(r => currentAge >= r.startAge && currentAge <= r.endAge);
    return row ? row.amount : defaultSpending;
}

export function sanitizeScheduleRows(rows, defaults = { startAge: 60, endAge: 100, amount: 60000 }) {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
        startAge: Number.isFinite(r?.startAge) ? r.startAge : defaults.startAge,
        endAge: Number.isFinite(r?.endAge) ? r.endAge : defaults.endAge,
        amount: Number.isFinite(r?.amount) ? r.amount : defaults.amount
    }));
}

export function normalizeScheduleRows(rawRows, currentAge, lifeExpectancy) {
    let wasClamped = false;
    const cleaned = (Array.isArray(rawRows) ? rawRows : [])
        .filter((r) => Number.isFinite(r.startAge) && Number.isFinite(r.endAge) && Number.isFinite(r.amount))
        .map((r) => {
            const next = { ...r };
            const clampedStart = Math.max(currentAge, Math.min(lifeExpectancy, next.startAge));
            const clampedEnd = Math.max(currentAge, Math.min(lifeExpectancy, next.endAge));
            if (clampedStart !== next.startAge || clampedEnd !== next.endAge) wasClamped = true;
            next.startAge = clampedStart;
            next.endAge = clampedEnd;
            return next;
        })
        .sort((a, b) => a.startAge - b.startAge);
    return { cleaned, wasClamped };
}

export function getScheduleValidationError(cleanedRows) {
    for (let i = 0; i < cleanedRows.length; i++) {
        if (cleanedRows[i].startAge > cleanedRows[i].endAge) return "invalid-range";
        if (i > 0 && cleanedRows[i].startAge <= cleanedRows[i - 1].endAge) return "overlap";
    }
    return null;
}

export function buildFlatSchedule(currentAge, lifeExpectancy, spend) {
    return [{ startAge: currentAge, endAge: lifeExpectancy, amount: Math.round(spend) }];
}

export function isFlatSchedule(rows, currentAge, lifeExpectancy, spend) {
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    const row = rows[0];
    if (!Number.isFinite(row.startAge) || !Number.isFinite(row.endAge) || !Number.isFinite(row.amount)) return false;
    return row.startAge === currentAge && row.endAge === lifeExpectancy && Math.round(row.amount) === Math.round(spend);
}
