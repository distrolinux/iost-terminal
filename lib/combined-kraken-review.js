export function combineKrakenReview(review, market, system, now = Date.now()) {
  const expiresAt = Math.min(review.createdAt + 30000, market?.expiresAt || review.createdAt + 30000, system?.expiresAt || review.createdAt + 30000);
  const checks = {
    fresh: Number.isFinite(market?.expiresAt) && Number.isFinite(system?.expiresAt) && Number.isFinite(now) && now >= review.createdAt && now < expiresAt,
    marketRules: market?.status === 'public-checks-passed',
    venueOnline: system?.status === 'online',
    venueAdvisoriesClear: system?.status !== 'unavailable' && system?.emergencyCount === 0 && system?.maintenanceCount === 0,
    cashEstimate: review.accountFunding?.status === 'cash-indication-covers-estimate',
    notionalCap: review.policy?.notionalCap === 'within-configured-cap',
    stopDrafted: review.order?.protectiveStop !== null && review.order?.protectiveStop !== undefined,
  };
  return { ...review, market, venueSystem: system, expiresAt,
    combined: { status: Object.values(checks).every(Boolean) ? 'checked-evidence-clear-not-authorized' : 'blocked-or-incomplete', checks, blockers: Object.keys(checks).filter(k => !checks[k]), outstanding: ['account-eligibility', 'margin-and-final-fee-coverage', 'full-risk-review', 'owner-order-approval', 'live-launch-gates'], executionAuthorized: false },
    warnings: ['Combined evidence is not authorization. Account eligibility, margin obligations, final fees and full risk remain unverified.', 'No funds reserved and no order sent. A drafted stop is not armed. Editing inputs invalidates this snapshot.'] };
}
