/**
 * lichti-opencode-model-fallback
 *
 * OpenCode plugin: automatic model fallback on rate limits (429) and
 * permanently-retired models (410), for any OpenAI-compatible provider.
 *
 * Born out of a real production failure with the `opencode-rate-limit`
 * npm package: its `session.status` "retry" handler only recognizes
 * messages containing "usage limit" / "rate limit" / "high concurrency" /
 * "reduce concurrency" — a provider whose 429 body reads "Too Many
 * Requests" (e.g. NVIDIA Build) never matches, so it silently never
 * switches models. See README.md for the full writeup.
 *
 * Handles two distinct failure classes:
 *  - 429 Too Many Requests (retryable): temporary — the model cools down
 *    for `cooldownMs` before being tried again.
 *  - 410 Gone (model permanently retired, not retryable): OpenCode never
 *    emits a "retry" event for this — it's a terminal error on the
 *    message — so the model is removed from rotation for the process's
 *    lifetime instead of cooling down.
 *
 * Detects both via the structured HTTP status code (ApiError.data.statusCode)
 * carried on retry parts / terminal message errors, with broad text
 * matching as a fallback — not a narrow phrase whitelist.
 *
 * Zero npm dependencies on purpose — this file is the entire plugin.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOG_PATH = path.join(homedir(), ".opencode", "model-fallback-plugin.log");
const DEBOUNCE_MS = 5000;

function defaults() {
  return { enabled: true, cooldownMs: 60000, fallbackModels: [] };
}

function loadConfig(directory) {
  const candidates = [
    path.join(homedir(), ".opencode", "model-fallback.json"),
    path.join(directory ?? process.cwd(), "model-fallback.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      return { ...defaults(), ...parsed, _source: file };
    } catch {
      // try next candidate
    }
  }
  return { ...defaults(), _source: null };
}

function log(message) {
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never break the plugin
  }
}

function modelKey(m) {
  return `${m.providerID}/${m.modelID}`;
}

/** Broad, provider-agnostic rate-limit detection (status code first, text as fallback). */
function isRateLimitSignal({ statusCode, text }) {
  if (statusCode === 429) return true;
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("429") ||
    t.includes("too many requests") ||
    t.includes("rate limit") ||
    t.includes("rate_limit") ||
    t.includes("quota exceeded") ||
    t.includes("resource exhausted")
  );
}

/** Model permanently retired by the provider (not retryable — never cools down). */
function isModelGoneSignal({ statusCode, text }) {
  if (statusCode === 410) return true;
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("410") ||
    t.includes("end of life") ||
    t.includes("no longer available") ||
    t.includes("has been retired") ||
    t.includes("model not found") ||
    t.includes("deprecated")
  );
}

export const ModelFallback = async ({ client, directory }) => {
  const config = loadConfig(directory);
  log(`plugin loaded; config=${config._source ?? "defaults (no file found)"}; models=${config.fallbackModels.length}`);

  if (!config.enabled || config.fallbackModels.length === 0) {
    log("disabled or no fallbackModels configured — plugin is a no-op");
    return {};
  }

  const cooldownUntil = new Map(); // modelKey -> timestamp
  const sessionModel = new Map(); // sessionID -> {providerID, modelID}
  const lastHandledFailure = new Map(); // sessionID -> {modelKey, at}

  function isOnCooldown(m) {
    const until = cooldownUntil.get(modelKey(m));
    return typeof until === "number" && Date.now() < until;
  }

  /** reason: "rate_limit" cools down for cooldownMs; "gone" is permanent (never retried again). */
  function markUnavailable(m, reason) {
    cooldownUntil.set(modelKey(m), reason === "gone" ? Infinity : Date.now() + config.cooldownMs);
  }

  function pickNextModel(current) {
    const list = config.fallbackModels;
    const currentIdx = current
      ? list.findIndex((m) => m.providerID === current.providerID && m.modelID === current.modelID)
      : -1;
    for (let i = 1; i <= list.length; i++) {
      const candidate = list[(currentIdx + i + list.length) % list.length];
      if (!isOnCooldown(candidate)) return candidate;
    }
    return null; // every model is on cooldown
  }

  async function resolveCurrentModel(sessionID, messageID) {
    if (messageID) {
      try {
        const result = await client.session.messages({ path: { id: sessionID } });
        const match = (result?.data ?? []).find((m) => m.info.id === messageID);
        if (match?.info?.providerID && match?.info?.modelID) {
          return { providerID: match.info.providerID, modelID: match.info.modelID };
        }
      } catch (err) {
        log(`session ${sessionID}: failed to resolve model for message ${messageID}: ${err?.message ?? err}`);
      }
    }
    return sessionModel.get(sessionID) ?? null;
  }

  async function handleFailover(sessionID, messageID, reason) {
    if (!sessionID) return;
    const current = await resolveCurrentModel(sessionID, messageID);
    const currentKey = current ? modelKey(current) : null;

    // Debounce only duplicate signals about the *same* failing model (e.g. both
    // session.error and message.updated firing for one underlying error) — a
    // fresh failure on the model we just switched to must NOT be swallowed,
    // otherwise a dead/rate-limited fallback model traps the session silently.
    const lastHandled = lastHandledFailure.get(sessionID);
    if (lastHandled && lastHandled.modelKey === currentKey && Date.now() - lastHandled.at < DEBOUNCE_MS) {
      log(`session ${sessionID}: debounced duplicate signal for ${currentKey} (< ${DEBOUNCE_MS}ms since last trigger)`);
      return;
    }
    lastHandledFailure.set(sessionID, { modelKey: currentKey, at: Date.now() });

    if (current) {
      markUnavailable(current, reason);
    }
    const next = pickNextModel(current);
    if (!next) {
      log(`session ${sessionID}: no fallback model available — all models unavailable`);
      return;
    }
    const verb = reason === "gone" ? "retired (410)" : "rate limited (429)";
    log(`session ${sessionID}: ${current ? modelKey(current) : "unknown model"} ${verb} -> switching to ${modelKey(next)}`);

    try {
      const messagesResult = await client.session.messages({ path: { id: sessionID } });
      const messages = messagesResult?.data ?? [];
      const lastUserMessage = [...messages].reverse().find((m) => m.info.role === "user");
      if (!lastUserMessage) {
        log(`session ${sessionID}: no user message found, cannot resend`);
        return;
      }
      const parts = (lastUserMessage.parts ?? [])
        .filter((p) => p.type === "text" || p.type === "file")
        .map((p) => (p.type === "text" ? { type: "text", text: p.text } : p));
      if (parts.length === 0) {
        log(`session ${sessionID}: last user message has no resendable parts`);
        return;
      }

      sessionModel.set(sessionID, next);
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts, model: { providerID: next.providerID, modelID: next.modelID } },
      });
      await client.session.abort({ path: { id: sessionID } }).catch(() => {});
      log(`session ${sessionID}: fallback request sent with ${modelKey(next)}`);
    } catch (err) {
      log(`session ${sessionID}: fallback attempt failed: ${err?.message ?? err}`);
    }
  }

  function classify(signal) {
    if (isModelGoneSignal(signal)) return "gone";
    if (isRateLimitSignal(signal)) return "rate_limit";
    return null;
  }

  function errorSignal(err) {
    return {
      statusCode: err?.data?.statusCode,
      text: [err?.data?.message, err?.message, err?.name].filter(Boolean).join(" "),
    };
  }

  return {
    event: async ({ event }) => {
      // Track current model per session from assistant message updates.
      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (info?.providerID && info?.modelID && info?.sessionID) {
          sessionModel.set(info.sessionID, { providerID: info.providerID, modelID: info.modelID });
        }
        // Terminal error on the message itself (e.g. 410 Gone never produces a
        // retry part — OpenCode just fails the message immediately).
        if (info?.error && info?.sessionID) {
          const reason = classify(errorSignal(info.error));
          if (reason) {
            log(`session ${info.sessionID}: message.updated terminal error detected (${reason}): ${JSON.stringify(errorSignal(info.error))}`);
            await handleFailover(info.sessionID, info.id, reason);
          }
        }
      }

      // Fallback terminal-error path in case message.updated doesn't carry it.
      if (event.type === "session.error") {
        const props = event.properties ?? {};
        const reason = classify(errorSignal(props.error));
        if (reason && props.sessionID) {
          log(`session ${props.sessionID}: session.error detected (${reason}): ${JSON.stringify(errorSignal(props.error))}`);
          await handleFailover(props.sessionID, undefined, reason);
        }
      }

      // Primary signal for retryable errors: a retry part with a structured API error.
      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type === "retry" && part.error) {
          const reason = classify(errorSignal(part.error));
          if (reason) {
            log(`session ${part.sessionID}: retry part detected (attempt ${part.attempt}, ${reason}, status ${part.error?.data?.statusCode})`);
            await handleFailover(part.sessionID, part.messageID, reason);
          }
        }
      }

      // Secondary signal: session-level retry status (text-only, no status code available here).
      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "retry" && typeof status.message === "string") {
          const reason = classify({ text: status.message });
          if (reason) {
            log(`session ${event.properties.sessionID}: session.status retry detected (${reason}): "${status.message}"`);
            await handleFailover(event.properties.sessionID, undefined, reason);
          }
        }
      }
    },
  };
};

export default ModelFallback;
