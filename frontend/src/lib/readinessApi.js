// src/lib/readinessApi.js
import axios from "axios";

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
// If REACT_APP_BACKEND_URL already ends in /api, change this to: const API = BACKEND_URL;
const API = `${BACKEND_URL}/api`;

/**
 * POST /api/readiness/assess
 * Resolves with the assessment JSON. Rejects with an Error whose message is the
 * server's `detail` where available. Cancellation rejects with name "AbortError".
 */
export async function assessReadiness(payload, { signal } = {}) {
  try {
    const res = await axios.post(`${API}/readiness/assess`, payload, {
      headers: { "Content-Type": "application/json" },
      signal,
      timeout: 120000, // LLM call; can take 10-30s
    });
    return res.data;
  } catch (err) {
    if (axios.isCancel(err)) {
      const abort = new Error("canceled");
      abort.name = "AbortError";
      throw abort;
    }
    const msg =
      err.response?.data?.detail ||
      err.response?.data?.error ||
      err.message ||
      "Assessment failed";
    const wrapped = new Error(msg);
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

/**
 * Maps the session store's generatedQA items to the API's `answers` shape.
 *
 * Status rule (must match ReadinessCheck.jsx's "ready" count):
 *   an answer is "ready" if it was ticked as reviewed OR already has status "ready".
 * The backend computes each dossier score as ready / total, so any difference
 * between this rule and the page's count would make the table and the top
 * figure disagree.
 *
 * VERIFY: the dossier property name. Log one item
 * (console.log(question.generatedQA[0])) and, if it is not one of the four
 * names tried below, change that line.
 */
export function buildAnswersPayload(qaList = []) {
  return qaList.map((qa) => ({
    question: qa.question || "",
    answer: qa.answer || "",
    dossier_code:
      qa.dossierCode || qa.dossier_code || qa.dossierCategory || qa.dossier_category || null,
    status: qa.reviewed || qa.status === "ready" ? "ready" : qa.status || "draft",
    importance: qa.importance || null,
  }));
}