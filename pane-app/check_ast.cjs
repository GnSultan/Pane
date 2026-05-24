const fs = require('fs');
const acorn = require('acorn');

const code = fs.readFileSync('src/main/http-backend.mjs', 'utf8');

try {
  acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  console.log('No error');
} catch (e) {
  console.log(`Original error: ${e.message}`);
  
  // Cut the code short, just before the error line
  const lines = code.split('\n');
  const validCode = lines.slice(0, e.loc.line - 1).join('\n') + '\n';
  
  try {
    const ast = acorn.parse(validCode, { ecmaVersion: 'latest', sourceType: 'module' });
    const apiBackendNode = ast.body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration && n.declaration.id && n.declaration.id.name === 'ApiBackend');
    if (apiBackendNode) {
      console.log(`ApiBackend class closes at line ${apiBackendNode.loc.end.line}`);
    } else {
      console.log('Could not find ApiBackend class in AST');
    }
  } catch (e2) {
    console.log(`Secondary parse error (expected if class was abruptly cut): ${e2.message}`);
  }
}
