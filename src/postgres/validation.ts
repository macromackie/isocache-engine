import type { Outcome } from "../protocol.js";
import { SyncError } from "./transaction.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new SyncError("Invalid sync identifier.", 400);
  return value.toLowerCase();
}

export function object(value: unknown, description: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${description}.`);
  return value;
}

export function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

export function string(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${description}.`);
  return value;
}

export function integer(value: unknown, description: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`Invalid ${description}.`);
  return number;
}

export function versionMap(value: unknown): Record<string, string> {
  const versions = new Map<string, string>();
  for (const [key, raw] of Object.entries(object(value, "stored view versions"))) {
    const version: unknown = raw;
    versions.set(key, string(version, "stored row version"));
  }
  return Object.fromEntries(versions);
}

export function outcome(value: unknown): Outcome {
  const result = object(value, "application outcome");
  const status = field(result, "status");
  const recipients = field(result, "recipients");
  let readers: string[] | undefined;
  if (recipients !== undefined) {
    if (!Array.isArray(recipients)) throw new Error("Invalid application outcome recipients.");
    readers = recipients.map((raw: unknown) => string(raw, "application outcome recipient"));
  }
  if (status === "accepted") {
    if (field(result, "code") !== undefined || field(result, "message") !== undefined)
      throw new Error("Accepted application outcomes cannot contain an error.");
    return readers === undefined ? { status } : { status, recipients: readers };
  }
  if (status !== "rejected" && status !== "appliedWithNotice")
    throw new Error("Invalid application outcome status.");
  const code = string(field(result, "code"), "application outcome code");
  const message = string(field(result, "message"), "application outcome message");
  if (!code || !message) throw new Error("Application outcomes require a code and message.");
  return readers === undefined
    ? { status, code, message }
    : { status, code, message, recipients: readers };
}
