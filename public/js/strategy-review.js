// Presentation of server-calculated evidence only; no execution or persistence.
import { formatDraftUsd } from './draft-format.js?v=1';
export function strategyReviewSections(review) {
  const order = review.order || {}, amounts = review.amounts || {}, policy = review.policy || {};
  const money = formatDraftUsd;
  return [
    { title: 'Mode & account', rows: [
      ['Mode', 'Real-money workspace · draft only · execution locked'],
      ['Venue', 'Kraken · USD spot buy'],
      ['Account binding', 'Not established for this draft'],
      ['Automation', 'No agent mandate, repeating strategy or order created'],
    ] },
    { title: 'Entry & exit plan', rows: [
      ['Entry', `Buy ${order.quantity ?? 'unknown quantity'} ${order.symbol ?? 'unknown asset'} at a limit of ${money(order.limitPrice)}`],
      ['Fill', 'Not guaranteed; this draft is not sent to Kraken'],
      ['Protective exit', order.protectiveStop == null ? 'No stop drafted' : `${money(order.protectiveStop)} — draft only, not armed`],
      ['Loss to drafted stop', amounts.lossToStopBeforeFeesUsd == null ? 'Unknown — no stop drafted' : `${money(amounts.lossToStopBeforeFeesUsd)} excluding fees and gaps; not a maximum loss guarantee`],
    ] },
    { title: 'Spending & costs', rows: [
      ['Draft notional', money(amounts.notionalUsd)],
      ['Configured notional cap', money(policy.maxOrderUsd)],
      ['Cap check', policy.notionalCap === 'within-configured-cap' ? 'Within notional cap only — not spending authorization' : policy.notionalCap === 'exceeds-configured-cap' ? 'Exceeds cap — edit this draft' : 'Unknown — not verified'],
      ['Assumed fee', `${money(amounts.assumedFeeUsd)}${amounts.assumedFeeUsd == null ? '' : ' — your assumption, not a venue quote'}`],
      ['Assumed total', money(amounts.assumedTotalUsd)],
      ['Balance & slippage', 'Balance not checked; slippage not estimated'],
    ] },
    { title: 'Approval & next step', rows: [
      ['Owner approval', 'Not requested; no binding or approval expiry'],
      ['Market evidence', review.market?.status === 'public-checks-passed' ? 'Public rules passed only — account eligibility and execution not authorized' : 'Public rules unverified or draft invalid — inspect checks below'],
      ['Validity', 'Changing inputs or review expiry invalidates this review'],
      ['Next step', 'Edit any failed checks, review unknowns, and obtain fresh evidence. This screen cannot approve or submit an order.'],
    ] },
  ];
}
