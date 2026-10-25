import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateSegments, wordsToSegments } from "../src/server/ai/speech.js";
import { locateQuote } from "../src/server/pipeline.js";
import { ftsQuery } from "../src/server/search.js";
import { localParts } from "../src/server/periodic.js";

describe("quote location", () => {
  const segments = [
    { start: 0, end: 4.2, text: "Okay so first thing." },
    { start: 4.5, end: 9.8, text: "We should build an app for dog walkers in the neighborhood." },
    { start: 10.4, end: 15, text: "Also, what about a podcast with founders?" },
    { start: 15.2, end: 19, text: "Every week, one failure story." },
  ];

  it("finds the segment range a quote comes from", () => {
    assert.deepEqual(locateQuote("a podcast with founders? Every week, one failure story.", segments), { start: 10.4, end: 19 });
  });

  it("tolerates small transcription differences", () => {
    const r = locateQuote("we should build an app for the dog walkers", segments);
    assert.equal(r.start, 4.5);
  });

  it("works with Hebrew text", () => {
    const he = [
      { start: 0, end: 3, text: "שלום, יש לי רעיון חדש." },
      { start: 3, end: 8, text: "אפליקציה שמחברת בעלי כלבים עם מטיילים." },
    ];
    assert.equal(locateQuote("אפליקציה שמחברת בעלי כלבים", he).start, 3);
  });

  it("returns nulls when the quote is not in the transcript", () => {
    assert.deepEqual(locateQuote("completely unrelated words here", segments), { start: null, end: null });
  });
});

describe("transcript segmentation", () => {
  it("groups words into segments at pauses", () => {
    const segs = wordsToSegments([
      { text: "Hello", start: 0, end: 0.4 },
      { text: "there.", start: 0.5, end: 0.9 },
      { text: "New", start: 3, end: 3.3 },
      { text: "thought", start: 3.4, end: 3.8 },
    ]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].text, "Hello there.");
    assert.equal(segs[1].start, 3);
  });

  it("estimates times for untimed transcripts", () => {
    const segs = estimateSegments("One sentence here. Another one that is longer than the first!", 10);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].start, 0);
    assert.ok(Math.abs(segs[1].end - 10) < 0.2);
  });
});

describe("search query building", () => {
  it("makes a safe prefix query", () => {
    assert.equal(ftsQuery('AI "business" OR -drop'), '"ai"* OR "business"* OR "or"* OR "drop"*');
  });
  it("ignores empty input", () => {
    assert.equal(ftsQuery("  ?? "), null);
  });
});

describe("time zones", () => {
  it("computes the local date and hour", () => {
    const p = localParts("Asia/Jerusalem", new Date("2026-03-01T22:30:00Z"));
    assert.equal(p.date, "2026-03-02");
    assert.equal(p.hour, 0);
  });
});
