#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack → NemoClaw bridge.
 *
 * Listens for @mentions in Slack channels. When the bot is mentioned,
 * it fetches recent channel history for context, forwards everything
 * to the OpenClaw agent inside the sandbox, and posts the response
 * back as a threaded reply.
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot User OAuth Token (xoxb-...)
 *   SLACK_APP_TOKEN   — App-Level Token for Socket Mode (xapp-...)
 *   SANDBOX_NAME      — sandbox name (default: nemoclaw)
 *   SLACK_HISTORY_COUNT — number of prior messages to include as context (default: 20)
 */

const { App } = require("@slack/bolt");
const { execSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { getCredential } = require("../bin/lib/credentials");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || getCredential("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || getCredential("SLACK_APP_TOKEN");
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const HISTORY_COUNT = parseInt(process.env.SLACK_HISTORY_COUNT || "20", 10);

if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN required. Set env var or run: nemoclaw credentials set SLACK_BOT_TOKEN"); process.exit(1); }
if (!SLACK_APP_TOKEN) { console.error("SLACK_APP_TOKEN required. Set env var or run: nemoclaw credentials set SLACK_APP_TOKEN"); process.exit(1); }

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Cache bot user ID so we can strip mentions from messages
let botUserId = null;

// Track active requests to avoid double-processing
const activeRequests = new Set();

// ── Helpers ───────────────────────────────────────────────────────

function stripMention(text) {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

async function fetchChannelHistory(client, channel, beforeTs) {
  try {
    const result = await client.conversations.history({
      channel,
      latest: beforeTs,
      limit: HISTORY_COUNT,
      inclusive: false,
    });
    // Reverse so oldest first
    return (result.messages || []).reverse();
  } catch (err) {
    console.error(`[slack] Failed to fetch history for ${channel}: ${err.message}`);
    return [];
  }
}

async function resolveUserName(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    return result.user?.real_name || result.user?.name || userId;
  } catch {
    return userId;
  }
}

function buildContextPrompt(historyMessages, userNames) {
  if (!historyMessages.length) return "";

  const lines = historyMessages.map((msg) => {
    const name = userNames.get(msg.user) || msg.user || "unknown";
    const text = msg.text || "";
    return `${name}: ${text}`;
  });

  return (
    "Here is the recent conversation in this Slack channel for context:\n\n" +
    lines.join("\n") +
    "\n\n---\n\n"
  );
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${SANDBOX}"`, {
      encoding: "utf-8",
    });

    const confPath = `/tmp/nemoclaw-slack-ssh-${sessionId}.conf`;
    require("fs").writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'slack-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); } catch {}

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          !l.includes("[compaction") &&
          !l.includes("[diagnostic") &&
          !l.includes("[agent/embedded]") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Slack event handler ───────────────────────────────────────────

app.event("app_mention", async ({ event, client, say }) => {
  const requestKey = `${event.channel}-${event.ts}`;
  if (activeRequests.has(requestKey)) return;
  activeRequests.add(requestKey);

  try {
    const userMessage = stripMention(event.text);
    if (!userMessage) return;

    const userName = await resolveUserName(client, event.user);
    console.log(`[${event.channel}] ${userName}: ${userMessage}`);

    // Fetch prior conversation for context
    const history = await fetchChannelHistory(client, event.channel, event.ts);

    // Resolve user names in history
    const userIds = [...new Set(history.map((m) => m.user).filter(Boolean))];
    const userNames = new Map();
    await Promise.all(
      userIds.map(async (uid) => {
        userNames.set(uid, await resolveUserName(client, uid));
      }),
    );
    userNames.set(event.user, userName);

    // Build the full prompt with context
    const contextPrompt = buildContextPrompt(history, userNames);
    const fullPrompt = contextPrompt + `${userName}: ${userMessage}`;

    // Use thread_ts if this is already in a thread, otherwise start a new thread
    const threadTs = event.thread_ts || event.ts;

    // Post a thinking indicator
    const thinkingMsg = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: Thinking...",
    });

    // Thread replies share a session (conversation continuity).
    // New top-level messages get a fresh session (with channel history as context).
    const isThread = !!event.thread_ts;
    const sessionId = isThread
      ? `${event.channel}-${event.thread_ts}`.replace(/[^a-zA-Z0-9-]/g, "_")
      : `${event.channel}-${event.ts}`.replace(/[^a-zA-Z0-9-]/g, "_");
    const response = await runAgentInSandbox(fullPrompt, sessionId);

    console.log(`[${event.channel}] agent: ${response.slice(0, 100)}...`);

    // Update the thinking message with the actual response
    // Slack max message length is ~40000 chars but we chunk at 3900 for readability
    const chunks = [];
    for (let i = 0; i < response.length; i += 3900) {
      chunks.push(response.slice(i, i + 3900));
    }

    // Update first chunk over the thinking message
    await client.chat.update({
      channel: event.channel,
      ts: thinkingMsg.ts,
      text: chunks[0] || "(no response)",
    });

    // Post remaining chunks as thread replies
    for (let i = 1; i < chunks.length; i++) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: chunks[i],
      });
    }
  } catch (err) {
    console.error(`[slack] Error handling mention: ${err.message}`);
    try {
      await say({
        text: `Error: ${err.message}`,
        thread_ts: event.thread_ts || event.ts,
      });
    } catch {}
  } finally {
    activeRequests.delete(requestKey);
  }
});

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  await app.start();

  // Get bot user ID for mention stripping
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Slack Bridge                              │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      ${(authResult.user || "unknown").padEnd(40)}│`);
  console.log(`  │  Sandbox:  ${SANDBOX.padEnd(40)}│`);
  console.log(`  │  Context:  last ${String(HISTORY_COUNT).padEnd(34)}messages│`);
  console.log("  │                                                     │");
  console.log("  │  Mention the bot in a channel to interact.          │");
  console.log("  │  Prior conversation is sent as context.             │");
  console.log("  │  Run 'openshell term' to monitor egress approvals.  │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

main().catch((err) => {
  console.error("Failed to start Slack bridge:", err.message);
  process.exit(1);
});
