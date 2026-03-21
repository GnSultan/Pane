const fs = require('fs');
const path = require('path');

/**
 * Attempts to repair corrupted JSON by fixing common issues:
 * 1. Unterminated strings
 * 2. Missing commas between objects/array elements
 * 3. Extra characters after valid JSON
 * 4. Trailing commas
 * 5. Unescaped control characters
 */
function repairJSON(jsonString) {
  let repaired = jsonString;

  // Fix 1: Remove any characters after the last valid JSON structure
  // Look for the last valid closing brace or bracket
  const lastValidEnd = Math.max(
    repaired.lastIndexOf('}'),
    repaired.lastIndexOf(']')
  );

  if (lastValidEnd > 0 && lastValidEnd < repaired.length - 1) {
    // Check if there's valid JSON content after this position
    const afterEnd = repaired.substring(lastValidEnd + 1).trim();
    if (afterEnd.length > 0 && !afterEnd.startsWith('//') && !afterEnd.startsWith('/*')) {
      repaired = repaired.substring(0, lastValidEnd + 1);
    }
  }

  // Fix 2: Add missing commas between objects in arrays
  // Pattern: } followed by { without a comma
  repaired = repaired.replace(/}\s*{/g, '},{');

  // Fix 3: Add missing commas between key-value pairs
  // Pattern: "value" followed by "key" without a comma
  repaired = repaired.replace(/"\s*"\s*:/g, match => {
    // Check if there's already a comma before the closing quote
    if (!match.includes(',')) {
      return match.replace(/"\s*"/, '", "');
    }
    return match;
  });

  // Fix 4: Fix unterminated strings by finding unclosed quotes
  let quoteDepth = 0;
  let inString = false;
  let escapeNext = false;
  const result = [];

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    const prevChar = i > 0 ? repaired[i - 1] : '';

    if (escapeNext) {
      escapeNext = false;
      result.push(char);
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      result.push(char);
      continue;
    }

    if (char === '"' && prevChar !== '\\') {
      inString = !inString;
      quoteDepth += inString ? 1 : -1;
    }

    result.push(char);
  }

  // If we're still in a string at the end, close it
  if (inString && quoteDepth > 0) {
    result.push('"');
  }

  repaired = result.join('');

  // Fix 5: Remove trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Fix 6: Fix missing quotes around property names
  // Pattern: { key: instead of { "key":
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  // Fix 7: Escape unescaped control characters
  const controlChars = [
    ['\n', '\\n'],
    ['\r', '\\r'],
    ['\t', '\\t'],
    ['\b', '\\b'],
    ['\f', '\\f']
  ];

  let inString2 = false;
  let escapeNext2 = false;
  const result2 = [];

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    const prevChar = i > 0 ? repaired[i - 1] : '';

    if (escapeNext2) {
      escapeNext2 = false;
      result2.push(char);
      continue;
    }

    if (char === '\\') {
      escapeNext2 = true;
      result2.push(char);
      continue;
    }

    if (char === '"' && prevChar !== '\\') {
      inString2 = !inString2;
    }

    if (inString2) {
      let replaced = false;
      for (const [ctrl, escaped] of controlChars) {
        if (char === ctrl) {
          result2.push(escaped);
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        result2.push(char);
      }
    } else {
      result2.push(char);
    }
  }

  repaired = result2.join('');

  return repaired;
}

/**
 * Attempts to parse JSON with multiple repair strategies
 */
function parseWithRepair(jsonString, filePath) {
  console.log(`Attempting to repair JSON for: ${filePath}`);
  console.log(`Original length: ${jsonString.length} characters`);

  // Try direct parse first
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.log(`Initial parse failed: ${error.message}`);
  }

  // Try basic repair
  let repaired = repairJSON(jsonString);

  // Try parsing the repaired version
  try {
    return JSON.parse(repaired);
  } catch (error) {
    console.log(`First repair attempt failed: ${error.message}`);
  }

  // Try more aggressive repair: extract JSON-like structure
  // Look for the outermost { or [ and try to extract from there
  const firstBrace = repaired.indexOf('{');
  const firstBracket = repaired.indexOf('[');

  if (firstBrace >= 0 || firstBracket >= 0) {
    const startIndex = firstBrace >= 0 && firstBracket >= 0
      ? Math.min(firstBrace, firstBracket)
      : Math.max(firstBrace, firstBracket);

    if (startIndex >= 0) {
      // Try to find matching closing brace/bracket
      let openChar = repaired[startIndex];
      let closeChar = openChar === '{' ? '}' : ']';
      let depth = 0;
      let endIndex = -1;

      for (let i = startIndex; i < repaired.length; i++) {
        if (repaired[i] === openChar) depth++;
        else if (repaired[i] === closeChar) {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }

      if (endIndex > startIndex) {
        const extracted = repaired.substring(startIndex, endIndex + 1);
        console.log(`Extracted JSON segment of length: ${extracted.length}`);

        try {
          return JSON.parse(extracted);
        } catch (error) {
          console.log(`Extracted segment parse failed: ${error.message}`);
        }
      }
    }
  }

  // Last resort: try to salvage as array of messages if it looks like conversation data
  if (repaired.includes('"messages"') || repaired.includes('"content"')) {
    // Try to extract just the messages array
    const messagesMatch = repaired.match(/"messages"\s*:\s*(\[[\s\S]*?\](?=\s*[,\]}]))/);
    if (messagesMatch) {
      try {
        const messages = JSON.parse(messagesMatch[1]);
        return { messages };
      } catch (error) {
        console.log(`Failed to parse messages array: ${error.message}`);
      }
    }
  }

  throw new Error('Unable to repair JSON file');
}

/**
 * Main function to fix a JSON file
 */
function fixJSONFile(filePath) {
  try {
    const backupPath = filePath + '.backup-' + Date.now();

    // Read the file
    const content = fs.readFileSync(filePath, 'utf8');

    // Create backup
    fs.writeFileSync(backupPath, content, 'utf8');
    console.log(`Created backup at: ${backupPath}`);

    // Try to parse and repair
    const parsed = parseWithRepair(content, filePath);

    // Write repaired version
    const repairedContent = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(filePath, repairedContent, 'utf8');

    console.log(`Successfully repaired: ${filePath}`);
    console.log(`Repaired length: ${repairedContent.length} characters`);

    return true;
  } catch (error) {
    console.error(`Failed to repair ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Find and fix all conversation files in a directory
 */
function fixAllConversationsInDir(dirPath) {
  try {
    const files = fs.readdirSync(dirPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    console.log(`Found ${jsonFiles.length} JSON files in ${dirPath}`);

    let fixedCount = 0;
    for (const file of jsonFiles) {
      const filePath = path.join(dirPath, file);
      console.log(`\nProcessing: ${file}`);

      if (fixJSONFile(filePath)) {
        fixedCount++;
      }
    }

    console.log(`\nFixed ${fixedCount} out of ${jsonFiles.length} files`);
    return fixedCount;
  } catch (error) {
    console.error(`Error processing directory ${dirPath}:`, error.message);
    return 0;
  }
}

// Command line interface
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  node fix-json.js <file-or-directory>

Examples:
  node fix-json.js conversation.json          # Fix single file
  node fix-json.js ./conversations           # Fix all JSON files in directory
  node fix-json.js /path/to/project          # Fix all JSON files in project directory

This script will:
1. Create a backup of each file before modifying
2. Attempt to repair common JSON corruption issues
3. Save the repaired version
    `);
    process.exit(1);
  }

  const target = args[0];

  try {
    const stats = fs.statSync(target);

    if (stats.isDirectory()) {
      console.log(`Processing directory: ${target}`);
      fixAllConversationsInDir(target);
    } else if (stats.isFile()) {
      console.log(`Processing file: ${target}`);
      fixJSONFile(target);
    } else {
      console.error(`Invalid target: ${target}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing ${target}:`, error.message);
    process.exit(1);
  }
}

module.exports = {
  repairJSON,
  parseWithRepair,
  fixJSONFile,
  fixAllConversationsInDir
};
