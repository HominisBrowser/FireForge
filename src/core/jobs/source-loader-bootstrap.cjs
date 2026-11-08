// SPDX-License-Identifier: EUPL-1.2
const { join } = require('node:path');
const { register } = require('tsx/esm/api');

register({ tsconfig: join(__dirname, '../../..', 'tsconfig.json') });
