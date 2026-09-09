'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('la version 1.2.5 publie les mises à jour sur le bon dépôt GitHub', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.2.5');
  assert.deepEqual(pkg.build.publish, {
    provider: 'github',
    owner: 'masterjokr',
    repo: 'Sauvegarde-Zen',
    releaseType: 'release'
  });
  assert.match(fs.readFileSync(path.join(root, 'main', 'updater.js'), 'utf8'), /electron-updater/);
});

test('l’interface contient les nouveautés de suivi de la v1.2.5', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const javascript = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.match(html, /id="version-banner"/);
  assert.match(html, /id="update-checked-at"/);
  assert.match(javascript, /function refreshPathHealth/);
  assert.match(javascript, /className: `history-details/);
  assert.match(javascript, /Mise à jour réussie/);
});
