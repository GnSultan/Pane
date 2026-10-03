// Prototype: exact SentencePiece BPE via scores parsed from bpe.model.
// SP merges the adjacent pair whose merged piece has the HIGHEST score.
import fs from "node:fs";

function parsePieces(buf) {
  const pieces = []; // {piece, score}
  let i = 0;
  const n = buf.length;
  while (i < n) {
    // top-level field: expect 0x0A (field 1, len-delimited) repeated
    if (buf[i] !== 0x0a) break;
    i++;
    // varint length
    let len = 0, shift = 0;
    for (;;) {
      const b = buf[i++];
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const end = i + len;
    let piece = null, score = 0;
    while (i < end) {
      const tag = buf[i++];
      if (tag === 0x0a) { // piece bytes
        let plen = 0, pshift = 0;
        for (;;) {
          const b = buf[i++];
          plen |= (b & 0x7f) << pshift;
          pshift += 7;
          if (!(b & 0x80)) break;
        }
        piece = buf.subarray(i, i + plen).toString("utf8");
        i += plen;
      } else if (tag === 0x15) { // score fixed32
        score = buf.readFloatLE(i);
        i += 4;
      } else if (tag === 0x18) { // type varint — skip
        i++; // single byte type
      } else {
        break; // unknown field in piece — bail (shouldn't happen for this model)
      }
    }
    if (piece !== null) pieces.push({ piece, score });
    i = end;
  }
  return pieces;
}

const buf = fs.readFileSync("models/kws-zipformer-en/bpe.model");
const pieces = parsePieces(buf);
console.log(`parsed ${pieces.length} pieces`);
const score = new Map(pieces.map((p) => [p.piece, p.score]));
const vocab = new Set(pieces.map((p) => p.piece));

function encodeWord(word) {
  const up = word.toUpperCase();
  const symbols = ["▁", ...up];
  if (symbols.slice(1).some((c) => !vocab.has(c))) return null;
  for (;;) {
    let bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < symbols.length - 1; i++) {
      const merged = symbols[i] + symbols[i + 1];
      const s = score.get(merged);
      if (s !== undefined && s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    symbols[bestIdx] += symbols[bestIdx + 1];
    symbols.splice(bestIdx + 1, 1);
  }
  return symbols;
}

for (const w of ["MAYA", "PANE", "ATHENA", "LUMEN", "JARVIS", "COMPUTER", "ALEXA", "NOVA", "ORION", "ECHO", "HEY"]) {
  console.log(w, "→", (encodeWord(w) ?? ["<unencodable>"]).join(" "));
}
