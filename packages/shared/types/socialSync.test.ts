import { describe, expect, test } from "vitest";

import { buildCookieBlob, PLATFORM_REQUIRED_COOKIES } from "./socialSync";

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
