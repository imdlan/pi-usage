// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, containsSecretValue } from "../src/utils/sanitize.js";

describe("sanitizeText", () => {
  it("redacts Authorization headers", () => {
    const secret = "abc123secrettokenXYZ";
    const out = sanitizeText(`Authorization: Bearer ${secret}`);
    assert.equal(containsSecretValue(out, secret), false);
    assert.match(out, /REDACTED/);
  });

  it("redacts bare Bearer tokens", () => {
    const out = sanitizeText("Bearer sk-live-abcdef123456token");
    assert.equal(containsSecretValue(out, "sk-live-abcdef123456token"), false);
    assert.match(out, /REDACTED/);
  });

  it("redacts common API key prefixes", () => {
    const secret = "sk-ant-abcdef1234567890";
    const out = sanitizeText(`key=${secret}`);
    assert.equal(containsSecretValue(out, secret), false);
  });

  it("redacts Cookie / Set-Cookie", () => {
    const out = sanitizeText("Cookie: session=supersecretcookievalue123");
    assert.equal(containsSecretValue(out, "supersecretcookievalue123"), false);
  });

  it("redacts PEM private keys", () => {
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabcdef...\n-----END RSA PRIVATE KEY-----";
    const out = sanitizeText(key);
    assert.equal(containsSecretValue(out, "MIIEpAIBAAKCAQEAabcdef..."), false);
    assert.match(out, /PEM/);
  });

  it("redacts .env-style secret assignments", () => {
    const secret = "abcdef1234567890fedcba";
    const out = sanitizeText(`API_KEY=${secret}`);
    assert.equal(containsSecretValue(out, secret), false);
  });

  it("redacts JWTs", () => {
    const jwt = "eyJabcdefgh.ijklmnopqrst.rstuvwxyz012";
    const out = sanitizeText(`token ${jwt}`);
    assert.equal(containsSecretValue(out, jwt), false);
  });

  it("leaves non-secret text intact", () => {
    const out = sanitizeText("5-hour quota 32%, monthly quota 18%");
    assert.equal(out, "5-hour quota 32%, monthly quota 18%");
  });
});

describe("containsSecretValue", () => {
  it("empty secret never matches", () => {
    assert.equal(containsSecretValue("anything", ""), false);
  });
  it("detects exact substring", () => {
    assert.equal(containsSecretValue("hello world", "world"), true);
    assert.equal(containsSecretValue("hello world", "mars"), false);
  });
});
