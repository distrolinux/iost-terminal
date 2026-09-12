import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = read('public/index.html');
const html = read('public/app.html');
const app = read('public/js/app.js');
assert.match(home, /href="\/app\?auth=login#launchpad"/);
assert.match(home, /href="\/app\?auth=login#live"/);
assert.match(home, /Real-money orders are not available yet/);
assert.match(html, /aria-label="Trading workspace"/);
assert.match(html, /href="#live" id="liveWorkspace"/);
assert.match(html, /href="#launchpad" id="paperWorkspace"/);
const nodes = new Map(['paperWorkspace', 'liveWorkspace', 'workspaceBoundary'].map(id => [id, { attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; } }]));
const env = {
  state: {}, document: { getElementById: id => nodes.get(id), body: { classList: { toggle() {} } } },
  agentEventSource: null, $$: () => [], $: () => ({ classList: { remove() {} } }),
  location: { hash: '' }, history: { replaceState() {} }, refreshView: view => view,
};
vm.createContext(env);
vm.runInContext(app.slice(app.indexOf('const VALID_VIEWS ='), app.indexOf("addEventListener('hashchange'")), env);
assert.equal(vm.runInContext("switchView('live')", env), 'live');
assert.equal(nodes.get('liveWorkspace').attrs['aria-current'], 'true');
assert.equal(nodes.get('paperWorkspace').attrs['aria-current'], undefined);
assert.match(nodes.get('workspaceBoundary').textContent, /never enables/);
assert.equal(vm.runInContext("switchView('launchpad')", env), 'launchpad');
assert.equal(nodes.get('paperWorkspace').attrs['aria-current'], 'true');
assert.equal(nodes.get('liveWorkspace').attrs['aria-current'], undefined);
assert.equal(vm.runInContext("switchView('invalid')", env), 'scanner');
console.log('Trading workspace entry checks passed');
