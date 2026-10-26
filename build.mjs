// Build bookmarklet.txt from checker.js. Node built-ins only.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, 'checker.js'), 'utf8');

const code = src
  .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')               // header comment
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !/^\/\*.*\*\/$/.test(l))   // blank lines and one-line block comments
  .join('\n');

new Function(code); // syntax check; throws if broken

const url = 'javascript:' + encodeURIComponent(code + '\nvoid 0;');
writeFileSync(join(dir, 'bookmarklet.txt'), url + '\n', 'utf8');
console.log('bookmarklet.txt written, ' + url.length + ' characters');

// Keep index.html in sync: replace the two marked spots with the fresh URL.
const htmlPath = join(dir, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
html = html.replace(/<!--BM_A_START-->[\s\S]*?<!--BM_A_END-->/,
  () => '<!--BM_A_START--><a class="bm" href="' + url + '">Store Page Check</a><!--BM_A_END-->');
html = html.replace(/<!--BM_T_START-->[\s\S]*?<!--BM_T_END-->/,
  () => '<!--BM_T_START--><textarea id="bmtext" readonly aria-label="Bookmarklet code" onclick="this.select()">' + url + '</textarea><!--BM_T_END-->');
writeFileSync(htmlPath, html, 'utf8');
console.log('index.html updated');
