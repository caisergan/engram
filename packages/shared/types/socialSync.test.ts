import { describe, expect, test } from "vitest";

import {
  buildCookieBlob,
  isInstagramUrl,
  isXUrl,
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "./socialSync";

describe("isInstagramUrl", () => {
  test("matches instagram.com and its subdomains", () => {
    expect(isInstagramUrl("https://www.instagram.com/p/ABC123/")).toBe(true);
    expect(isInstagramUrl("https://instagram.com/reel/XYZ/")).toBe(true);
    expect(isInstagramUrl("http://m.instagram.com/p/ABC/")).toBe(true);
  });

  test("does not match look-alike or unrelated hosts", () => {
    expect(isInstagramUrl("https://notinstagram.com/p/ABC/")).toBe(false);
    expect(isInstagramUrl("https://instagram.com.evil.com/p/ABC/")).toBe(false);
    expect(isInstagramUrl("https://example.com/instagram.com")).toBe(false);
  });

  test("returns false for non-URL input", () => {
    expect(isInstagramUrl("not a url")).toBe(false);
    expect(isInstagramUrl("")).toBe(false);
  });
});

describe("isXUrl", () => {
  test("matches x.com and twitter.com and subdomains", () => {
    expect(isXUrl("https://x.com/user/status/123")).toBe(true);
    expect(isXUrl("https://www.twitter.com/user/status/123")).toBe(true);
    expect(isXUrl("https://mobile.x.com/i/bookmarks")).toBe(true);
  });

  test("does not match look-alikes or non-URLs", () => {
    expect(isXUrl("https://notx.com/")).toBe(false);
    expect(isXUrl("https://x.com.evil.com/")).toBe(false);
    expect(isXUrl("not a url")).toBe(false);
  });
});

describe("PLATFORM_REQUIRED_COOKIES", () => {
  test("declares the required cookies per platform", () => {
    expect(PLATFORM_REQUIRED_COOKIES.instagram).toEqual([
      "sessionid",
      "csrftoken",
      "ds_user_id",
    ]);
    expect(PLATFORM_REQUIRED_COOKIES.x).toEqual(["auth_token", "ct0"]);
    expect(PLATFORM_REQUIRED_COOKIES.youtube).toEqual([
      "SID",
      "HSID",
      "SSID",
      "SAPISID",
      "APISID",
    ]);
  });
});

describe("buildCookieBlob", () => {
  test("returns a JSON blob of only the required cookies", () => {
    const blob = buildCookieBlob("instagram", {
      sessionid: "a",
      csrftoken: "b",
      ds_user_id: "c",
      extra: "ignored",
    });
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob!)).toEqual({
      sessionid: "a",
      csrftoken: "b",
      ds_user_id: "c",
    });
  });

  test("returns null when a required cookie is missing", () => {
    expect(
      buildCookieBlob("instagram", { sessionid: "a", csrftoken: "b" }),
    ).toBeNull();
  });

  test("returns null when a required cookie is empty", () => {
    expect(buildCookieBlob("x", { auth_token: "", ct0: "x" })).toBeNull();
  });

  test("builds the X blob", () => {
    const blob = buildCookieBlob("x", { auth_token: "t", ct0: "c" });
    expect(JSON.parse(blob!)).toEqual({ auth_token: "t", ct0: "c" });
  });
});

describe("normalizeCookieInput", () => {
  test("parses Cookie-Editor array export into a name->value map", () => {
    const input = JSON.stringify([
      { name: "sessionid", value: "abc", domain: ".instagram.com" },
      { name: "csrftoken", value: "xyz", domain: ".instagram.com" },
      { name: "ds_user_id", value: "123", domain: ".instagram.com" },
    ]);
    expect(normalizeCookieInput(input)).toEqual({
      sessionid: "abc",
      csrftoken: "xyz",
      ds_user_id: "123",
    });
  });

  test("parses a flat object blob (buildCookieBlob output)", () => {
    const input = JSON.stringify({
      sessionid: "abc",
      csrftoken: "xyz",
      ds_user_id: "123",
    });
    expect(normalizeCookieInput(input)).toEqual({
      sessionid: "abc",
      csrftoken: "xyz",
      ds_user_id: "123",
    });
  });

  test("parses a raw cookie header string", () => {
    expect(
      normalizeCookieInput("sessionid=abc; csrftoken=xyz; ds_user_id=123"),
    ).toEqual({ sessionid: "abc", csrftoken: "xyz", ds_user_id: "123" });
  });

  test("keeps only well-formed string entries from an array export", () => {
    const input = JSON.stringify([
      { name: "sessionid", value: "abc" },
      { name: "broken" }, // missing value
      { value: "novalue" }, // missing name
      { name: "ct0", value: 123 }, // non-string value
    ]);
    expect(normalizeCookieInput(input)).toEqual({ sessionid: "abc" });
  });

  test("preserves URL-encoded values verbatim", () => {
    const input = JSON.stringify([
      { name: "sessionid", value: "1%3Aabc%3A10" },
    ]);
    expect(normalizeCookieInput(input)).toEqual({ sessionid: "1%3Aabc%3A10" });
  });

  test("returns null for blank input", () => {
    expect(normalizeCookieInput("   ")).toBeNull();
  });

  test("returns null for unparseable input", () => {
    expect(normalizeCookieInput("not a cookie")).toBeNull();
  });
});
