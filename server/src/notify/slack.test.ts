import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The enablement check reads a DB setting, so the queries module is mocked — the
// same technique access/formAccess.test.ts and export/table.test.ts use to keep
// these tests off the network. `getSetting` is hoisted so the factory below can
// close over it.
const { getSetting } = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("../db/queries.js", () => ({ getSetting }));

import { env } from "../config/env.js";
import { notifySlack, slackNotificationsEnabled, SLACK_ENABLED_KEY } from "./slack.js";

// `fetch` is stubbed per test so a case that SHOULD send never actually reaches
// Slack. `env.slack.webhookUrl` is saved and restored because the notifier reads
// it directly, and the "webhook configured" branch has to be exercised both ways.
const originalWebhookUrl = env.slack.webhookUrl;
const fetchMock = vi.fn();

beforeEach(() => {
  getSetting.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  env.slack.webhookUrl = originalWebhookUrl;
  vi.unstubAllGlobals();
});

describe("slackNotificationsEnabled", () => {
  it("defaults to ON when the setting has never been written", async () => {
    getSetting.mockResolvedValue(null);
    expect(await slackNotificationsEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledWith(SLACK_ENABLED_KEY);
  });

  it("defaults to ON when the stored value is blank", async () => {
    getSetting.mockResolvedValue("   ");
    expect(await slackNotificationsEnabled()).toBe(true);
  });

  it("is OFF only for an explicit \"false\", case-insensitively", async () => {
    getSetting.mockResolvedValue("false");
    expect(await slackNotificationsEnabled()).toBe(false);

    getSetting.mockResolvedValue("FALSE");
    expect(await slackNotificationsEnabled()).toBe(false);

    getSetting.mockResolvedValue("true");
    expect(await slackNotificationsEnabled()).toBe(true);
  });

  it("fails safe (ON) when the settings read throws, so a DB hiccup never mutes alerts", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getSetting.mockRejectedValue(new Error("db down"));
    expect(await slackNotificationsEnabled()).toBe(true);
    err.mockRestore();
  });
});

describe("notifySlack honors the on/off switch", () => {
  it("sends when ON and a webhook is configured", async () => {
    env.slack.webhookUrl = "https://hooks.example.com/services/test";
    getSetting.mockResolvedValue("true");
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK", text: async () => "" });

    expect(await notifySlack({ text: "hello" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT send when OFF, even though a webhook is configured", async () => {
    env.slack.webhookUrl = "https://hooks.example.com/services/test";
    getSetting.mockResolvedValue("false");

    expect(await notifySlack({ text: "hello" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send — and does not even read the setting — when no webhook is configured", async () => {
    env.slack.webhookUrl = "";
    getSetting.mockResolvedValue("true");

    expect(await notifySlack({ text: "hello" })).toBe(false);
    expect(getSetting).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
