import assert from 'node:assert/strict';
import { parseFreezeLog, cutsFromFreezes } from '../src/deadframes.js';
const log = 'lavfi.freezedetect.freeze_start: 1.5\nlavfi.freezedetect.freeze_duration: 1\nlavfi.freezedetect.freeze_end: 2.5\nlavfi.freezedetect.freeze_start: 4\n';
assert.deepEqual(parseFreezeLog(log), [{ start: 1.5, end: 2.5 }]);
assert.deepEqual(cutsFromFreezes([{ start: 1, end: 2 }], 30, 5000, 300), [{ startMs: 1033, endMs: 2000 }]);
assert.deepEqual(cutsFromFreezes([{ start: 1, end: 1.2 }], 30, 5000, 300), []);
console.log('deadframes ok');
