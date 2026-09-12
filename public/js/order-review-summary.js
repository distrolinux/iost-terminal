// Presentation only: never computes or grants execution permission.
export function summarizeOrderReview(review) {
  const blockers = [], unknowns = [];
  if (review.policy?.notionalCap === 'exceeds-configured-cap') blockers.push(`Draft notional $${review.amounts.notionalUsd} exceeds the configured $${review.policy.maxOrderUsd} USD cap. Edit the quantity or limit price; this screen will not raise your limit.`);
  else if (review.policy?.notionalCap !== 'within-configured-cap') unknowns.push('Configured notional cap is not verified.');
  const labels = { pairOnline: 'The market is not online.', minimumQuantity: 'Quantity is below the market minimum.', minimumNotional: 'Notional is below the market minimum.', quantityIncrement: 'Quantity does not match the market precision.', priceIncrement: 'Limit price does not match the market tick or precision.' };
  if (review.market?.status === 'draft-invalid') {
    for (const key of review.market.failures || []) blockers.push(labels[key] || 'A public market rule failed.');
    if (!review.market.failures?.length) blockers.push('The public market check marked this draft invalid.');
  } else if (review.market?.status !== 'public-checks-passed') unknowns.push('Public market rules have not been verified for this draft.');
  unknowns.push('Account fees, balance, eligibility and full execution risk checks remain unverified.');
  unknowns.push(review.order?.protectiveStop === null ? 'No protective stop drafted.' : 'The drafted protective stop is not armed.');
  return { title: blockers.length ? 'Draft needs changes — execution locked' : 'Execution locked — review is not authorization', blockers, unknowns, approval: 'Owner approval has not been requested. No order has been sent.' };
}
