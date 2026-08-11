// lib/risk.js — Risk Management Engine
// Inputs: account size, max risk %, entry, stop (optionally target, side, leverage)
// Outputs: position size, dollar risk, R:R, potential P/L, portfolio exposure

export function calculateRisk({
  accountSize = 10000, maxRiskPct = 1, entryPrice = 0, stopLoss = 0,
  targetPrice = null, side = 'long', leverage = 1,
} = {}) {
  const errs = [];
  if (!accountSize || accountSize <= 0) errs.push('Account size must be > 0');
  if (maxRiskPct == null || maxRiskPct <= 0 || maxRiskPct > 100) errs.push('Max risk must be 0-100%');
  if (!entryPrice || entryPrice <= 0) errs.push('Entry price required');
  if (!stopLoss || stopLoss <= 0) errs.push('Stop loss required');
  if (side === 'long' && stopLoss >= entryPrice) errs.push('Stop must be below entry for long');
  if (side === 'short' && stopLoss <= entryPrice) errs.push('Stop must be above entry for short');
  if (targetPrice != null && targetPrice > 0) {
    if (side === 'long' && targetPrice <= entryPrice) errs.push('Target must be above entry for long');
    if (side === 'short' && targetPrice >= entryPrice) errs.push('Target must be below entry for short');
  }
  if (errs.length) return { ok: false, errors: errs };

  const dollarRisk = accountSize * (maxRiskPct / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const positionSize = dollarRisk / riskPerUnit;
  const notional = positionSize * entryPrice;
  const exposurePct = (notional / accountSize) * 100;

  let rr = null, potentialProfit = null, potentialLoss = dollarRisk;
  if (targetPrice != null && targetPrice > 0) {
    const moveToTarget = Math.abs(targetPrice - entryPrice);
    rr = moveToTarget / riskPerUnit;
    potentialProfit = moveToTarget * positionSize;
  }

  // leverage-adjusted collateral estimate (margin mode)
  const marginRequired = leverage > 1 ? notional / leverage : null;
  const liquidationPrice = side === 'long' && leverage > 1
    ? entryPrice * (1 - 1 / leverage + (0.005)) // rough maintenance 0.5%
    : side === 'short' && leverage > 1
      ? entryPrice * (1 + 1 / leverage - (0.005))
      : null;

  return {
    ok: true,
    inputs: { accountSize, maxRiskPct, entryPrice, stopLoss, targetPrice, side, leverage },
    dollarRisk: Math.round(dollarRisk * 100) / 100,
    riskPerUnit: Math.round(riskPerUnit * 1e8) / 1e8,
    positionSize: Math.round(positionSize * 1e4) / 1e4,
    notional: Math.round(notional * 100) / 100,
    exposurePct: Math.round(exposurePct * 100) / 100,
    rr: rr != null ? Math.round(rr * 100) / 100 : null,
    potentialProfit: potentialProfit != null ? Math.round(potentialProfit * 100) / 100 : null,
    potentialLoss: Math.round(potentialLoss * 100) / 100,
    marginRequired: marginRequired != null ? Math.round(marginRequired * 100) / 100 : null,
    liquidationPrice: liquidationPrice != null ? Math.round(liquidationPrice * 1e8) / 1e8 : null,
  };
}

// Portfolio exposure across open positions
export function portfolioExposure(positions, accountSize) {
  const totalNotional = positions.reduce((a, p) => a + p.notional, 0);
  const longNotional = positions.filter(p => p.side === 'long').reduce((a, p) => a + p.notional, 0);
  const shortNotional = positions.filter(p => p.side === 'short').reduce((a, p) => a + p.notional, 0);
  return {
    totalNotional: Math.round(totalNotional * 100) / 100,
    longExposurePct: accountSize ? Math.round((longNotional / accountSize) * 1000) / 10 : 0,
    shortExposurePct: accountSize ? Math.round((shortNotional / accountSize) * 1000) / 10 : 0,
    netExposurePct: accountSize ? Math.round(((longNotional - shortNotional) / accountSize) * 1000) / 10 : 0,
    grossExposurePct: accountSize ? Math.round((totalNotional / accountSize) * 1000) / 10 : 0,
  };
}
