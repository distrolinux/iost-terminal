import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

assert.match(html, /data-view="evaluation"[^>]+View Agent Evaluation Lab/);
assert.match(html, /id="view-evaluation"[^>]+Agent Evaluation Lab view/);
assert.match(html, /\/css\/style\.css\?v=2\.22/);
assert.match(html, /\/js\/app\.js\?v=2\.33\.0/);
assert.match(app, /VALID_VIEWS = \[[^\]]*'evaluation'/);
assert.match(app, /async function renderEvaluationLab\(\)/);
assert.match(app, /post\('\/api\/evaluation-lab'/);
assert.match(app, /next-bar-open/i);
assert.match(app, /STRATEGY GOVERNANCE · PAPER ONLY/);
assert.match(app, /promotion-scorecard/);
assert.match(app, /PROMOTE_TO_PAPER_REVIEW|targetStage/);
assert.match(app, /minimum out-of-sample/i);
assert.match(app, /async function loadEvaluationHistory\(\)/);
assert.match(app, /\/api\/evaluation-lab\/history\/compare\?ids=/);
assert.match(app, /format=json/);
assert.match(app, /format=csv/);
assert.match(app, /function drawEvaluationCharts\(data\)/);
assert.match(app, /\['portfolio',[^\]]*'evaluation'/);
assert.doesNotMatch(app.slice(app.indexOf('async function renderEvaluationLab()'), app.indexOf('// ---------------- Journal')), /enableLive|live\/enable|conversion|phase4|deploy/);
assert.match(css, /\.eval-pipeline/);
assert.match(css, /\.eval-baseline/);
assert.match(css, /\.eval-chart-grid/);
assert.match(css, /\.eval-history/);
assert.match(css, /\.promotion-scorecard/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.eval-form/);
assert.match(home, /Agent Evaluation Lab/);
assert.match(home, /walk-forward[^<]+future-data leakage/i);
assert.match(home, /href="\/app#evaluation"/);
assert.match(home, /PAPER EVIDENCE · FAIL-CLOSED/);

console.log('Agent Evaluation Lab UI checks passed');
