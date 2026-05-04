export function getBaseSpendingForAge(currentAge, defaultSpending, schedule) {
    if (!Array.isArray(schedule) || schedule.length === 0) return defaultSpending;
    const row = schedule.find(r => currentAge >= r.startAge && currentAge <= r.endAge);
    return row ? row.amount : defaultSpending;
}
