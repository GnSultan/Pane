const fs = require('fs');
const parser = require('@babel/parser');

const code = fs.readFileSync('src/main/http-backend.mjs', 'utf8');

try {
  const ast = parser.parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    plugins: ['topLevelAwait']
  });
  
  const apiBackend = ast.program.body.find(node => 
    node.type === 'ExportNamedDeclaration' && 
    node.declaration && 
    node.declaration.id && 
    node.declaration.id.name === 'ApiBackend'
  );
  
  if (apiBackend) {
    console.log(`ApiBackend class ends at line ${apiBackend.loc.end.line}`);
  } else {
    console.log('ApiBackend not found');
  }

  // Also print all errors babel encountered
  ast.errors.forEach(err => {
    console.log(`Error: ${err.message} at line ${err.loc.line}`);
  });
  
} catch (e) {
  console.log(`Fatal parser error: ${e.message}`);
}
