import { describe, expect, it, vi } from "vitest";

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

  it("uses an IMMEDIATE transaction so a write-lock-contended signup waits instead of failing with SQLITE_BUSY", async () => {
    // createRaw reads (SELECT count) then writes (INSERT). A deferred transaction
    // upgrades a read lock to a write lock, and SQLite returns SQLITE_BUSY
    // immediately on that upgrade (the busy handler is skipped to avoid deadlock).
    // An IMMEDIATE transaction takes the write lock up front, where busy_timeout
    // applies, so concurrent signups wait instead of erroring.
    const db = getTestDB();
    const txSpy = vi.fn(db.transaction.bind(db));
    db.transaction = txSpy as typeof db.transaction;

    await User.createRaw(db, {
      name: "Tx",
      email: "tx@test.com",
      password: "h",
      salt: "s",
    });

    expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
      behavior: "immediate",
    });
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
