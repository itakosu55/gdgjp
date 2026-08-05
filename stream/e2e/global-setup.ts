import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEVICES, E2E_PREFIX, EVENTS, SETUPS, USER } from "./seed-data";

/**
 * Bypasses the IdP entirely, the same way wiki's e2e setup does: apply the
 * local migrations, seed deterministic rows straight into the miniflare D1
 * file, and forge a session cookie signed with the dev server's own
 * `RP_SESSION_SECRET`. Booting `accounts` just to log in would make the suite
 * slower and much easier to break.
 */

const D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const STORAGE_STATE_DIR = path.join(process.cwd(), "e2e/storage-state");

/** `${cookiePrefix}-session`, with the prefix from app/lib/auth.server.ts. */
const SESSION_COOKIE = "gdgjp-stream-session";

function applyLocalMigrations(): void {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "gdgjp-stream-db", "--local"],
    { cwd: process.cwd(), stdio: "inherit", shell: process.platform === "win32" },
  );
}

function findD1Sqlite(): string {
  const dir = path.join(process.cwd(), D1_DIR);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `D1 directory not found: ${dir}\nRun 'pnpm dev' once to initialise the local D1 database.`,
    );
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sqlite"));
  if (files.length === 0) {
    throw new Error(`No SQLite file found in ${dir}. Run 'pnpm dev' first.`);
  }
  // Wrangler only ever creates one; take the newest if a stale file lingers.
  return files
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function readDevVar(content: string, key: string): string {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"));
  if (!match) throw new Error(`${key} is not set in .dev.vars`);
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function readSessionConfig(): { secret: string; issuer: string } {
  const devVars = path.join(process.cwd(), ".dev.vars");
  if (!fs.existsSync(devVars)) {
    throw new Error(
      `${devVars} not found — required for signing e2e session cookies.\nCopy .dev.vars.example to .dev.vars and set RP_SESSION_SECRET.`,
    );
  }
  const content = fs.readFileSync(devVars, "utf-8");
  const secret = readDevVar(content, "RP_SESSION_SECRET");
  if (!secret) throw new Error("RP_SESSION_SECRET is empty in .dev.vars");
  return { secret, issuer: readDevVar(content, "IDP_URL").replace(/\/$/, "") };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Mirrors `signPayload` in gdg-lib/src/auth/cookie.ts (HMAC-SHA256, base64url). */
function signCookie(payload: unknown, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

function seedDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);

  // Clear both the fixtures and anything a previous run's specs created, so a
  // re-run starts from the same state.
  db.exec("DELETE FROM setup_revisions WHERE setup_id LIKE 'e2e_%'");
  db.exec("DELETE FROM setups WHERE id LIKE 'e2e_%' OR event_id LIKE 'e2e_%'");
  db.exec("DELETE FROM event_devices WHERE event_id LIKE 'e2e_%'");
  db.prepare("DELETE FROM events WHERE id LIKE 'e2e_%' OR title LIKE ?").run(`${E2E_PREFIX}%`);
  db.prepare("DELETE FROM devices WHERE id LIKE 'e2e_%' OR name LIKE ?").run(`${E2E_PREFIX}%`);
  // After devices: `devices.model_id` has no ON DELETE clause, so a model with
  // instances still pointing at it cannot go.
  db.prepare("DELETE FROM device_models WHERE id LIKE 'e2e_%' OR name LIKE ?").run(
    `${E2E_PREFIX}%`,
  );

  db.prepare(
    `INSERT INTO "user" (id, name, email, image, is_admin, oidc_issuer, oidc_subject, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  ).run(USER.id, USER.name, USER.email, "e2e-issuer", USER.id, now, now);

  const insertDevice = db.prepare(
    "INSERT INTO devices (id, model_id, name, created_by) VALUES (?, ?, ?, ?)",
  );
  for (const device of DEVICES) {
    insertDevice.run(device.id, device.modelId, device.name, USER.id);
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (id, title, venue, created_by) VALUES (?, ?, ?, ?)",
  );
  const insertEventDevice = db.prepare(
    "INSERT INTO event_devices (event_id, device_id) VALUES (?, ?)",
  );
  for (const event of EVENTS) {
    insertEvent.run(event.id, event.title, event.venue, USER.id);
    for (const device of DEVICES) {
      insertEventDevice.run(event.id, device.id);
    }
  }

  const insertSetup = db.prepare(
    "INSERT INTO setups (id, event_id, name, doc, created_by) VALUES (?, ?, ?, ?, ?)",
  );
  for (const setup of SETUPS) {
    insertSetup.run(setup.id, setup.eventId, setup.name, JSON.stringify(setup.doc), USER.id);
  }

  db.close();
}

function writeStorageState(secret: string, issuer: string): void {
  fs.mkdirSync(STORAGE_STATE_DIR, { recursive: true });
  const value = signCookie(
    {
      version: 3,
      sessionId: "e2e-stream-session",
      userId: USER.id,
      issuer,
      subject: USER.id,
      email: USER.email,
      name: USER.name,
      picture: null,
      isAdmin: true,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
    secret,
  );

  const state = {
    cookies: [
      {
        name: SESSION_COOKIE,
        value,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        httpOnly: true,
        // The RP factory drops `Secure` for localhost (isLocalAppUrl), so the
        // stored cookie must not set it either or it is never sent over HTTP.
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };

  fs.writeFileSync(path.join(STORAGE_STATE_DIR, "user.json"), JSON.stringify(state, null, 2));
}

export default async function globalSetup() {
  applyLocalMigrations();
  const dbPath = findD1Sqlite();
  const { secret, issuer } = readSessionConfig();
  console.log(`\n[E2E setup] Seeding D1 SQLite: ${dbPath}`);
  seedDb(dbPath);
  writeStorageState(secret, issuer);
  console.log(`[E2E setup] Storage state written to ${STORAGE_STATE_DIR}`);
}
