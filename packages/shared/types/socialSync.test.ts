import { describe, expect, test } from "vitest";

import {
  buildCookieBlob,
  normalizeCookieInput,
  PLATFORM_REQUIRED_COOKIES,
} from "./socialSync";

describe("PLATFORM_REQUIRED_COOKIES", () => {
  test("declares the required cookies per platform", () => {
    expect(PLATFORM_REQUIRED_COOKIES.instagram).toEqual([
      "sessionid",
      "csrftoken",
      "ds_user_id",
    ]);
    expect(PLATFORM_REQUIRED_COOKIES.x).toEqual(["auth_token", "ct0"]);
    expect(PLATFORM_REQUIRED_COOKIES.youtube).toEqual(["SID", "HSID", "SSID"]);
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
