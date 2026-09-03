import { describe, test, expect, afterEach } from "bun:test";
import { emailFrom, isEmailConfigured } from "../email.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("email transport", () => {
  test("reports unconfigured when credentials are missing", () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    expect(isEmailConfigured()).toBe(false);
  });

  test("reports configured when both credentials are present", () => {
    process.env.SMTP_USER = "notifications@badgerbase.app";
    process.env.SMTP_PASS = "secret";
    expect(isEmailConfigured()).toBe(true);
  });

  test("falls back to the notifications address when SMTP_FROM is unset", () => {
    delete process.env.SMTP_FROM;
    expect(emailFrom()).toBe("notifications@badgerbase.app");
  });

  test("honours SMTP_FROM when set", () => {
    process.env.SMTP_FROM = "other@badgerbase.app";
    expect(emailFrom()).toBe("other@badgerbase.app");
  });
});
