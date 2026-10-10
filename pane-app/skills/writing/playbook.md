## Writing Principles

These were earned from real documentation failures — confusion, misinterpretation, and wasted time.

- Comments explain WHY, not WHAT. The code already says what it does. Use comments for intent, context, and warnings only. Delete comments that restate the code — they're noise.
- Names must pass the read-aloud test. If you wouldn't say it in a sentence, don't use it as a name. `getUserById` passes; `getUsrById` fails. Specificity beats brevity: `fetchUserPermissions` > `getPerms`.
- Every README needs: what it is (one sentence), why it exists (the problem), quick start (3 commands), how it works (architecture), and how to contribute. Everything else goes in linked docs.
- Delete commented-out code instead of leaving it. Git remembers everything. Dead code rots — future readers don't know if it's deliberately disabled or accidentally left behind.
- TODO format: `// TODO(username): what needs doing — why not now`. A TODO without a name and reason is litter. Accountability and context prevent TODO drift.
- Concrete over abstract in all writing. "40% faster" not "significantly improved." "Handles 10k connections" not "scales to enterprise." Show code/output instead of claiming simplicity.
- Consistency within a domain: once you name a concept, stick with it everywhere. `tenant` in one file is never `account` in another. Synonyms create false distinctions.
- Jargon needs definition on first use. Never assume the reader knows your domain terms. Link or define them.
- No hedging. "Basically," "kind of," "sort of," "just," "simply" — these undermine confidence. If something is simple, the example proves it. Don't claim it.
- Writing that can't be read aloud naturally is writing that needs revision. Read every important sentence before shipping it.
