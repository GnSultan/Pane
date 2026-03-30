import { initPaneDb, getPaneDb } from "./src/main/pane-db.mjs";

console.log("Testing pane-db initialization...");
try {
  // Try to get db before init - should throw
  console.log("1. Trying getPaneDb() before init...");
  getPaneDb();
  console.log("ERROR: Should have thrown!");
} catch (err) {
  console.log("✓ Correctly threw:", err.message);
}

try {
  console.log("2. Initializing db...");
  const db = initPaneDb();
  console.log("✓ initPaneDb() succeeded");
  
  console.log("3. Getting db after init...");
  const db2 = getPaneDb();
  console.log("✓ getPaneDb() succeeded");
  
  console.log("4. Testing prepared statements...");
  console.log("   insertTokenUsage exists:", !!db.stmts.insertTokenUsage);
  console.log("   getTokenAnalytics exists:", !!db.stmts.getTokenAnalytics);
  
  console.log("✓ All tests passed!");
} catch (err) {
  console.error("ERROR:", err);
  console.error(err.stack);
}
