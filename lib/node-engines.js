'use strict';

// Loads the pinned Unicode data first, then exposes the existing browser engines
// as explicit, immutable Node APIs. No protocol logic is duplicated here.
require('../unicode-inspector-data.js');
const protocol = require('../stegzero-protocol.js');
const unicode = require('../unicode-inspector.js');

module.exports = Object.freeze({ protocol, unicode });
