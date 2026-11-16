import fs from 'node:fs';
import { browser, fixtureDir } from './ui/harness.mjs';

try {
  await import('./ui/sections-a.mjs');
  await import('./ui/sections-b.mjs');
  await import('./ui/sections-c.mjs');
  await import('./ui/sections-d.mjs');
  await import('./ui/sections-e.mjs');
  console.log('UI smoke OK');
} finally {
  fs.rmSync(fixtureDir, { force: true, recursive: true });
  await browser.close();
}
