// First-run paper-trading guide. This module only switches dashboard views and
// highlights existing controls; it never calls an API or activates a control.
const STORAGE_KEY = 'iost.onboarding.paper.v1';
const $ = (selector) => document.querySelector(selector);

const steps = [
  {
    title: 'Welcome to the paper terminal',
    text: 'Start with $100,000 in virtual funds and learn the workflow using simulated positions. Paper results are educational and do not predict future returns.',
    target: null,
  },
  {
    title: '1. Scan the markets',
    text: 'Markets shows live-data candidates across the watchlist. Treat every signal as research input—not an instruction to trade.',
    target: '[data-view="scanner"]', view: 'scanner',
  },
  {
    title: '2. Inspect the evidence',
    text: 'Scores breaks a setup into momentum, volume, news and risk inputs. Check the components instead of relying on one headline number.',
    target: '[data-view="scores"]', view: 'scores',
  },
  {
    title: '3. Set a risk boundary',
    text: 'Use Risk to plan account size, maximum risk and exits before considering a simulated position.',
    target: '[data-view="risk"]', view: 'risk',
  },
  {
    title: '4. Paper execution stays deliberate',
    text: 'BUY and SELL require sign-in and lead into the paper workflow. This guide never clicks them or places an order. Live execution remains separately gated.',
    target: '.rail-card.exec', side: true,
  },
  {
    title: '5. Review the journal',
    text: 'Journal records simulated entries, exits and reasoning. Use it to review decisions, losses and discipline—not just winning trades.',
    target: '[data-view="journal"]', view: 'journal',
  },
];

const layer = $('#onboardingLayer');
const card = $('#onboardingCard');
const title = $('#onboardingTitle');
const text = $('#onboardingText');
const progress = $('#onboardingProgress');
const back = $('#onboardingBack');
const next = $('#onboardingNext');
const skip = $('#onboardingSkip');
const replay = $('#onboardingReplay');
let index = 0;
let previousFocus = null;
let highlighted = null;

function markSeen() {
  try { localStorage.setItem(STORAGE_KEY, 'done'); } catch { /* private mode */ }
}

function clearHighlight() {
  highlighted?.classList.remove('onboarding-target');
  highlighted = null;
}

function showStep() {
  const step = steps[index];
  clearHighlight();
  if (step.view) document.querySelector(`.nav-btn[data-view="${step.view}"]`)?.click();
  highlighted = step.target ? $(step.target) : null;
  highlighted?.classList.add('onboarding-target');
  highlighted?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  title.textContent = step.title;
  text.textContent = step.text;
  progress.textContent = `PAPER GUIDE · ${index + 1}/${steps.length}`;
  back.disabled = index === 0;
  next.textContent = index === steps.length - 1 ? 'Finish' : 'Next';
  card.classList.toggle('is-side', Boolean(step.side));
  next.focus();
}

function openGuide() {
  if (!layer) return;
  previousFocus = document.activeElement;
  index = 0;
  layer.classList.remove('hidden');
  document.body.classList.add('onboarding-open');
  showStep();
}

function closeGuide() {
  clearHighlight();
  layer?.classList.add('hidden');
  document.body.classList.remove('onboarding-open');
  markSeen();
  previousFocus?.focus?.();
}

back?.addEventListener('click', () => { if (index > 0) { index--; showStep(); } });
next?.addEventListener('click', () => {
  if (index === steps.length - 1) closeGuide();
  else { index++; showStep(); }
});
skip?.addEventListener('click', closeGuide);
replay?.addEventListener('click', openGuide);
document.addEventListener('keydown', (event) => {
  if (layer?.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeGuide();
  if (event.key === 'Tab') {
    const controls = [back, skip, next].filter((node) => node && !node.disabled);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

const params = new URLSearchParams(location.search);
let seen = false;
try { seen = localStorage.getItem(STORAGE_KEY) === 'done'; } catch { /* private mode */ }
const authFlow = params.has('auth') || location.hash.startsWith('#reset');
const forced = params.get('tour') === '1';
let autoOpened = false;
function maybeAutoOpen(loggedIn) {
  if (autoOpened || (!forced && (seen || authFlow || !loggedIn))) return;
  autoOpened = true;
  setTimeout(openGuide, 350);
}
window.addEventListener('authchange', (event) => maybeAutoOpen(Boolean(event.detail?.loggedIn)));
setTimeout(() => maybeAutoOpen(Boolean(window.Auth?.state?.loggedIn)), 1200);
