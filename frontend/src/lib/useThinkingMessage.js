/**
 * useThinkingMessage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Narrates a long wait instead of freezing on one word.
 *
 * A button that reads "Searching…" for fifteen seconds looks hung. The pattern
 * was written first in QAGenerator.jsx, where generation fans out to three
 * parallel LLM calls and routinely takes 30–60s; this is the same idea, made
 * reusable so Ruling Search and Insights do not each grow their own copy.
 *
 * The message list is a parameter rather than a constant, because the three
 * pages are doing genuinely different work and a shared list would have to be
 * vague enough to fit all of them — which defeats the point of narrating.
 *
 * NOTE: QAGenerator.jsx still carries its own local copy of this hook. It is
 * deliberately untouched here, so converging it is a separate, reviewable
 * change: delete its local THINKING_MESSAGES and useThinkingMessage, import
 * { useThinkingMessage, QA_THINKING } from here, and pass QA_THINKING at its
 * single call site.
 */
import { useEffect, useState } from "react";

/**
 * @param {boolean}  active     whether the work is in progress
 * @param {string[]} messages   what to cycle through, in order
 * @param {number}   intervalMs how long each one stays up
 * @returns {string} the message to show right now
 */
export function useThinkingMessage(active, messages, intervalMs = 2000) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Reset on every stop, so the next run opens on the first message rather
    // than resuming mid-list from the previous one.
    if (!active || !messages || messages.length === 0) {
      setIndex(0);
      return undefined;
    }
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, messages, intervalMs]);

  if (!messages || messages.length === 0) return "";
  // Guard the index: a shorter list arriving mid-run would otherwise read past
  // the end and return undefined.
  return messages[index % messages.length];
}

// Ruling Search: one embedding, one vector query, one answer — usually 5–15s.
// Fewer steps than Q&A and a shorter interval, so the sequence is actually
// seen rather than stopping two messages in.
export const SEARCH_THINKING = Object.freeze([
  "Searching the ruling corpus...",
  "Matching on meaning, not just keywords...",
  "Ranking the closest passages...",
  "Reading the supporting rulings...",
  "Writing the answer...",
]);
export const SEARCH_INTERVAL_MS = 1500;

// Insights: one large call reasoning over the whole corpus, typically 20–40s.
export const INSIGHTS_THINKING = Object.freeze([
  "Reading the corpus...",
  "Grouping rulings by outcome and therapy area...",
  "Looking for patterns across decisions...",
  "Comparing against the earlier period...",
  "Drafting the finding...",
  "Almost there...",
]);

// Kept here so QAGenerator can adopt the shared hook without its wording
// changing. Unused until that convergence happens.
export const QA_THINKING = Object.freeze([
  "Thinking...",
  "Analysing ruling patterns...",
  "Predicting ZIN questions...",
  "Reviewing dossier context...",
  "Formulating suggested responses...",
  "Almost there...",
]);
