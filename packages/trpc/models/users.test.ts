import { describe, expect, it } from "vitest";

import { getTestDB } from "../testUtils";
import { User } from "./users";

// Regression tests for the better-sqlite3 synchronous-transaction bug.
// User.createRaw previously passed an `async` callback to db.transaction(),
// which better-sqlite3 rejects with "Transaction function cannot return a
// promise", breaking signup entirely. These tests exercise the transaction.
describe("User.createRaw", () => {
  it("creates a user inside a synchronous transaction (signup path)", async () => {
    const db = getTestDB();

    const user = await User.createRaw(db, {
      name: "Repro User",
      email: "repro@test.com",
      password: "hashed",
      salt: "salt",
    });

    expect(user.email).toBe("repro@test.com");
    expect(user.name).toBe("Repro User");
    // The very first user is promoted to admin.
    expect(user.role).toBe("admin");
  });

  it("assigns the 'user' role once at least one user already exists", async () => {
    const db = getTestDB();

    await User.createRaw(db, {
      name: "First",
      email: "first@test.com",
      password: "h",
      salt: "s",
    });
    const second = await User.createRaw(db, {
      name: "Second",
      email: "second@test.com",
      password: "h",
      salt: "s",
    });

    expect(second.role).toBe("user");
  });

  it("maps a duplicate-email unique violation to a friendly error", async () => {
    const db = getTestDB();

    await User.createRaw(db, {
      name: "Dup",
      email: "dup@test.com",
      password: "h",
      salt: "s",
    });

    await expect(
      User.createRaw(db, {
        name: "Dup 2",
        email: "dup@test.com",
        password: "h",
        salt: "s",
      }),
    ).rejects.toThrow("Email is already taken");
  });
});
