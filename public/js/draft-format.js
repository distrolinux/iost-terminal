// Exact string formatting only: never round financial evidence through Number.
export function formatDraftUsd(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,23})(\.\d{1,8})?$/.test(value)) return 'Unknown — not verified';
  const [whole, fraction = ''] = value.split('.');
  const decimals = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals} USD`;
}
