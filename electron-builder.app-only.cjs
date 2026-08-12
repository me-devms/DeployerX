'use strict';

const { build } = require('./package.json');

module.exports = {
  ...build,
  win: {
    ...build.win,
    extraResources: [],
  },
};
