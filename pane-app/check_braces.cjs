const fs = require('fs');
const code = fs.readFileSync('src/main/http-backend.mjs', 'utf8');
const lines = code.split('\n');

// Let's analyze braces line by line from 1460 to 2685
// We will strip out strings, comments, and template literals before counting.
let cleanLines = lines.map(line => {
  let l = line.replace(/\/\/.*/, ''); // strip line comments
  l = l.replace(/'[^']*'/g, "''"); // single quotes
  l = l.replace(/"[^"]*"/g, '""'); // double quotes
  // naive regex replacement
  l = l.replace(/\/(?![*\/])(?:\\.|[^\\\/\n])+\/[gimsuy]*/g, '//');
  return l;
});

// strip block comments
let joined = cleanLines.join('\n');
joined = joined.replace(/\/\*[\s\S]*?\*\//g, '');

// strip template literals
joined = joined.replace(/`(?:\\`|[^`])*`/g, '``');

let finalLines = joined.split('\n');

let depth = 0;
let baseDepth = -1;

for (let i = 1460; i < 2685; i++) {
  const l = finalLines[i] || '';
  for (let char of l) {
    if (char === '{') {
      if (baseDepth === -1) baseDepth = depth;
      depth++;
    }
    if (char === '}') depth--;
  }
  if (baseDepth !== -1 && depth < baseDepth) {
    console.log(`Extra closing brace found at line ${i + 1}`);
    break;
  }
}
console.log(`At line 2685, depth difference from start of spawn: ${depth - baseDepth}`);
