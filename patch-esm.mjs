import fs from 'fs';

const path = 'node_modules/electron-vite/dist/chunks/lib-BmEkZIgk.mjs';
let code = fs.readFileSync(path, 'utf-8');

// The CJSyntaxRe regex matches __filename/__dirname/require ANYWHERE
// including inside template literals and strings. This causes the
// esm-shim plugin to insert CommonJS shims into invalid positions.
//
// Fix: make the regex only match at the TOP LEVEL of a module, not
// inside template literals or strings. We do this by requiring the
// pattern to NOT be preceded by a template literal opening or inside a string.
//
// The key insight: in bundled code, __filename/__dirname appear at top level
// (module scope) OR inside function bodies. Inside template literals, they're
// just string values and shouldn't trigger CJS shim insertion.
//
// Simple fix: only match __filename/__dirname when they appear at line start
// or after a statement boundary, NOT inside template expressions.

const oldPattern = 'CJSyntaxRe = /__filename|__dirname|require\\(|require\\.resolve\\(/;';
const newPattern = 'CJSyntaxRe = /(?:^|\\n)\\s*__filename\\b|(?:^|\\n)\\s*__dirname\\b|(?:^|\\n)\\s*require\\(|(?:^|\\n)\\s*require\\.resolve\\(/;';

if (code.includes(oldPattern)) {
    code = code.replace(oldPattern, newPattern);
    fs.writeFileSync(path, code);
    console.log('✓ Patched CJSyntaxRe to be line-level only');
} else {
    console.log('✗ Pattern not found');
    const idx = code.indexOf('CJSyntaxRe');
    if (idx >= 0) {
        console.log('Found at:', code.slice(idx, idx + 120));
    }
}

// Also patch the .cjs version
const path2 = 'node_modules/electron-vite/dist/chunks/lib-CMs-qhOt.cjs';
if (fs.existsSync(path2)) {
    let code2 = fs.readFileSync(path2, 'utf-8');
    if (code2.includes(oldPattern)) {
        code2 = code2.replace(oldPattern, newPattern);
        fs.writeFileSync(path2, code2);
        console.log('✓ Patched CJS version too');
    } else {
        console.log('✗ CJS pattern not found either');
    }
}
