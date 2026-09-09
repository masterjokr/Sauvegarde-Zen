'use strict';

const { build } = require('./package.json');

// Le dépôt de mise à jour reste présent dans les constructions locales afin
// que l'installateur contienne app-update.yml. L'option `--publish never` des
// scripts locaux empêche tout envoi accidentel vers GitHub.
module.exports = build;
